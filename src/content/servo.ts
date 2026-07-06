// Follower engine: consumes beacons/events + clock maps, drives the media
// element via the pure servo law (lib/servo). Owns the activation machine
// (§10.6), rate probe (§9.5), watchdog wiring (§10.4), coarse mode (§10.5),
// and ad defense (§11). Host machines run this too — it just stays dormant
// because no beacons ever arrive on the host's media port.

import {
  BEACON_MAX_AGE_S, CLOCK_UNC_MAX_MS, COARSE_PERIOD_MS, EXTRAP_CAP_S,
  JITTER_BUDGET_MS, MICRO_SEEK_S, PROBE_DURATION_MS, PROBE_RATES,
  PROBE_TOLERANCE, SEEK_LEAD_INIT_S, SETTLE_MS,
} from "../lib/constants.js"
import type { Beacon, Ev } from "../lib/proto.js"
import { decide, slewRate } from "../lib/servo.js"
import {
  applyDowngrade, initWatchdog, onExternalRateChange, onSlopeCheck, type WatchdogState,
} from "../lib/watchdog.js"
import type { PeerSyncState } from "../lib/types.js"
import type { MediaAdapter } from "./adapter.js"
import type { MediaSampler } from "./sampler.js"
import { hideToast, showToast } from "./toast.js"

type ClockHop = { offsetMs: number; uncMs: number; locked: boolean }

type Activation = "unknown" | "granted" | "needs_gesture" | "muted_bridge"

export type FollowerStatus = Readonly<{ state: PeerSyncState; eMs: number; jitterMs: number }>

export class FollowerEngine {
  private beacon: Beacon | null = null
  private beaconArrivalPerf = 0
  private currentEpoch = -1
  private epochChanged = false
  private p2p: ClockHop | null = null
  private local: ClockHop | null = null
  private conn: "connected" | "coasting" | "rejoinable" = "connected"
  private latencyOffsetMs = 0
  private controlled = false

  private activation: Activation = "unknown"
  private probeDone = false
  private probing = false
  private maxTrim = 0
  private watchdog: WatchdogState = initWatchdog(0)
  private expectedRate = 1
  private appliedRate = 1
  private settlingUntil = 0
  private awaitingSeeked = false
  private seekIssuedAt = 0
  private seekLeadS = SEEK_LEAD_INIT_S
  private lastTickPerf = 0
  private lastCoarseAt = 0
  private lastSlopeCheckAt = 0
  private ownStall = false

  private adMuted = false
  private savedVolume: { volume: number; muted: boolean } | null = null
  private lastNavTarget: string | null = null
  private lastNavAt = 0

  private lastState: PeerSyncState = "pairing"
  private lastE = 0

  constructor(
    private readonly adapter: MediaAdapter,
    private readonly sampler: MediaSampler,
    private readonly onStateChange: (s: FollowerStatus) => void,
  ) {}

  // ---- inputs (called by the orchestrator) ----

  setControlled(on: boolean): void {
    this.controlled = on
    if (!on) this.restoreRate()
  }

  setBeacon(b: Beacon): void {
    if (b.epoch > this.currentEpoch && this.currentEpoch !== -1) this.epochChanged = true
    this.currentEpoch = Math.max(this.currentEpoch, b.epoch)
    this.beacon = b
    this.beaconArrivalPerf = performance.now()
  }

  setEv(ev: Ev): void {
    if (ev.epoch > this.currentEpoch) {
      this.currentEpoch = ev.epoch
      this.epochChanged = true
    }
    // Events are the low-latency edge (§8.3): act immediately, don't wait a tick.
    const el = this.adapter.element()
    if (el === null) return
    switch (ev.kind) {
      case "pause":
      case "ad-start":
        el.pause()
        break
      case "play":
      case "seek":
      case "program":
      case "ad-end":
        this.tick() // re-evaluate now; SEEK path handles the discontinuity
        break
      default:
        break
    }
  }

  setClockMap(offsetMs: number, uncMs: number, locked: boolean): void {
    this.p2p = { offsetMs, uncMs, locked }
  }

  setLocalHop(offsetMs: number, uncMs: number, locked: boolean): void {
    this.local = { offsetMs, uncMs, locked }
  }

  setConn(state: "connected" | "coasting" | "rejoinable"): void {
    this.conn = state
  }

  setLatencyOffsetMs(ms: number): void {
    this.latencyOffsetMs = ms
  }

  setOwnStall(stalled: boolean): void {
    this.ownStall = stalled
  }

  onSeeked(): void {
    if (this.awaitingSeeked) {
      this.awaitingSeeked = false
      // seekLead = EMA of set-currentTime → seeked latencies (§10.3).
      const latencyS = (performance.now() - this.seekIssuedAt) / 1000
      this.seekLeadS = 0.7 * this.seekLeadS + 0.3 * latencyS
      this.settlingUntil = performance.now() + SETTLE_MS
    }
    this.sampler.reset()
  }

  onExternalRateChange(): void {
    const r = onExternalRateChange(this.watchdog, performance.now())
    this.watchdog = r.state
    this.maxTrim = Math.min(this.maxTrim, this.watchdog.maxTrim)
    if (r.action === "reassert") {
      const el = this.adapter.element()
      if (el !== null) this.writeRate(el, this.appliedRate)
    }
  }

  /** True when el.playbackRate changed but not by us. */
  isExternalRateChange(el: HTMLMediaElement): boolean {
    return Math.abs(el.playbackRate - this.expectedRate) > 1e-4
  }

  /** The toast click (a real user gesture) lands here. */
  private onActivationGesture(el: HTMLMediaElement): void {
    if (this.activation === "muted_bridge") {
      el.muted = false
      this.activation = "granted"
    } else {
      el.muted = false
      void el.play().then(
        () => {
          this.activation = "granted"
        },
        () => {
          this.activation = "needs_gesture"
        },
      )
    }
  }

  // ---- probe (§9.5) ----

  async runProbe(): Promise<void> {
    if (this.probeDone || this.probing) return
    const el = this.adapter.element()
    if (el === null || el.paused || !this.sampler.ready()) return
    this.probing = true
    try {
      if ("preservesPitch" in el) (el as HTMLMediaElement & { preservesPitch: boolean }).preservesPitch = true
      let accepted = 0
      for (const rate of PROBE_RATES) {
        this.writeRate(el, rate)
        await new Promise((r) => setTimeout(r, PROBE_DURATION_MS))
        const slope = this.sampler.slope()
        if (slope !== null && Math.abs(slope - rate) <= PROBE_TOLERANCE) {
          accepted = rate - 1
          break
        }
      }
      this.writeRate(el, 1)
      this.maxTrim = accepted
      this.watchdog = initWatchdog(accepted)
      this.probeDone = true
    } finally {
      this.probing = false
    }
  }

  /** Watchdog asked for a re-probe: run once more, then its verdict is final. */
  private reprobe(): void {
    this.probeDone = false
    void this.runProbe()
  }

  // ---- the tick (timeupdate + 250 ms backstop; law is tick-rate independent) ----

  tick(): void {
    const now = performance.now()
    const dtSec = this.lastTickPerf === 0 ? 0.25 : Math.min(2, (now - this.lastTickPerf) / 1000)
    this.lastTickPerf = now

    if (!this.controlled) return
    const el = this.adapter.element()
    const beacon = this.beacon
    if (el === null || beacon === null) {
      this.report("pairing", 0)
      return
    }

    // -- program mismatch (§8.5) --
    const myId = this.adapter.mediaId()
    if (myId !== beacon.program.mediaId || this.adapter.service !== beacon.program.service) {
      if (this.adapter.service !== beacon.program.service) {
        this.report("program_mismatch", 0)
        return
      }
      if (this.adapter.canNavigate) {
        this.report("loading_program", 0)
        // The tick fires every 250 ms and navigation takes longer than that
        // to unload the page — re-issuing location.assign each tick trips
        // Chrome's navigation throttle. Navigate once per target, with a
        // retry window in case the first attempt was swallowed.
        if (this.lastNavTarget !== beacon.program.mediaId || now - this.lastNavAt > 15_000) {
          this.lastNavTarget = beacon.program.mediaId
          this.lastNavAt = now
          this.adapter.navigate(beacon.program.mediaId)
        }
      } else {
        showToast("Host is playing a different track — click to follow.", () => {
          // Spotify: we can't navigate; the user clicks the toast, we surface
          // the target so they can find it, and the gesture unlocks autoplay.
          window.open(`https://open.spotify.com/track/${encodeURIComponent(beacon.program.mediaId)}`, "_self")
        })
        this.report("program_mismatch", 0)
      }
      return
    }

    // -- own ad (§11): mute + HOLD, recover on end --
    const adNow = this.adapter.canDetectAd && this.adapter.adActive()
    if (adNow && !this.adMuted) {
      this.adMuted = true
      this.savedVolume = { volume: el.volume, muted: el.muted }
      el.muted = true
    } else if (!adNow && this.adMuted) {
      this.adMuted = false
      this.epochChanged = true // force hard-sync back to the room
      if (this.savedVolume !== null) {
        el.muted = this.savedVolume.muted
        el.volume = this.savedVolume.volume
      }
    }
    if (this.adMuted) {
      this.holdRate(el, dtSec)
      this.report("ad_muted", 0)
      return
    }

    // -- transport --
    if (this.conn === "rejoinable") {
      this.holdRate(el, dtSec)
      this.report("rejoinable", 0)
      return
    }

    // -- host ad: nothing valid to chase (§11) --
    if (beacon.adActive) {
      el.pause()
      this.report("buffering", 0)
      return
    }

    // -- host paused: apply, one correction, idle (§10.3) --
    const clockOk = this.clocksOk()
    if (!beacon.playing) {
      if (!el.paused) el.pause()
      if (clockOk !== null) {
        const target = beacon.mediaTime + this.latencyOffsetMs / 1000
        if (Math.abs(el.currentTime - target) > 0.05) el.currentTime = target
      }
      this.report("locked", 0)
      return
    }

    // -- activation machine (§10.6) --
    if (el.paused) {
      this.tryActivate(el)
      this.holdRate(el, dtSec)
      this.report(this.activation === "muted_bridge" ? "muted_bridge" : "needs_activation", 0)
      return
    }
    if (this.activation === "muted_bridge") {
      // Clock syncs silently; the chip + toast say "click to unmute".
      showToast("Synced — click to unmute.", () => this.onActivationGesture(el))
    } else if (this.activation !== "granted") {
      this.activation = "granted" // playing unmuted ⇒ activation exists
    }

    // -- probe once we're playing and the sampler has formed --
    if (!this.probeDone && !this.probing && this.sampler.ready()) {
      void this.runProbe()
    }
    if (this.probing) {
      this.report("converging", 0)
      return
    }

    // -- beacon freshness & extrapolation (§10.2) --
    const beaconAgeS = (now - this.beaconArrivalPerf) / 1000
    if (beaconAgeS > BEACON_MAX_AGE_S) {
      this.holdRate(el, dtSec)
      this.report("coasting", 0)
      return
    }

    if (clockOk === null) {
      this.holdRate(el, dtSec)
      this.report(this.p2p === null || !this.p2p.locked ? "clock_warmup" : "clock_degraded", 0)
      return
    }

    const hostNow = now + clockOk.offsetMs
    const extrapS = Math.min(EXTRAP_CAP_S, Math.max(0, (hostNow - beacon.hostClock) / 1000))
    const hostMedia = beacon.mediaTime + (beacon.buffering ? 0 : extrapS * beacon.rate)
    if (beacon.buffering || this.ownStall) {
      this.holdRate(el, dtSec)
      this.report("buffering", 0)
      return
    }

    const target = hostMedia + this.latencyOffsetMs / 1000
    const actualFit = this.sampler.mediaTimeAt(now)
    const actual = actualFit ?? el.currentTime
    const e = target - actual
    this.lastE = e

    // -- coarse mode (§10.5): the guaranteed floor --
    const jitter = this.sampler.jitterP95Ms()
    if (this.probeDone && this.maxTrim === 0) {
      if (this.epochChanged || Math.abs(e) > 0.4) {
        this.hardSeek(el, target)
      } else if (now - this.lastCoarseAt > COARSE_PERIOD_MS && Math.abs(e) > MICRO_SEEK_S) {
        this.lastCoarseAt = now
        el.currentTime = el.currentTime + e
        this.sampler.reset()
      }
      this.report("coarse", e)
      return
    }

    // -- fine path: pure law --
    const settling = now < this.settlingUntil || this.awaitingSeeked
    // Activation is implied here: the element is playing (§10.1).
    const pre =
      this.maxTrim > 0 &&
      jitter <= JITTER_BUDGET_MS &&
      clockOk.uncMs + beacon.uncMs <= CLOCK_UNC_MAX_MS

    // Epoch discontinuities may hard-sync even when fine trim is unavailable —
    // but never on a truly bad clock (an order above the fine gate ⇒ HOLD).
    const seekableClock = clockOk.uncMs + beacon.uncMs <= 10 * CLOCK_UNC_MAX_MS
    const d = decide({
      finePreconditionsOk: pre || settling || (this.epochChanged && seekableClock),
      settling,
      epochChanged: this.epochChanged,
      eSec: e,
      jitterP95Ms: jitter,
      maxTrim: this.maxTrim,
    })

    if (d.mode === "SEEK") {
      this.hardSeek(el, target)
      this.report("converging", e)
      return
    }

    this.appliedRate = slewRate(this.appliedRate, d.rateTarget, dtSec)
    this.writeRate(el, this.appliedRate)

    // -- watchdog slope check while trimming (§10.4) --
    if (d.mode === "TRIM" && now - this.lastSlopeCheckAt > 3000) {
      this.lastSlopeCheckAt = now
      const slope = this.sampler.slope()
      if (slope !== null) {
        const r = onSlopeCheck(this.watchdog, this.appliedRate, slope)
        this.watchdog = r.state
        if (r.action === "reprobe") this.reprobe()
        if (r.action === "downgrade") this.maxTrim = this.watchdog.maxTrim
      }
    }

    if (!pre) {
      // Jitter over budget widens the deadband and withholds `locked` (§9);
      // clock uncertainty over the gate is the degraded chip (R4).
      this.report(jitter > JITTER_BUDGET_MS ? "converging" : "clock_degraded", e)
      return
    }
    this.report(d.mode === "LOCKED" ? "locked" : "converging", e)
  }

  // ---- helpers ----

  private tryActivate(el: HTMLMediaElement): void {
    if (this.activation === "needs_gesture" || this.activation === "muted_bridge") return
    void el.play().then(
      () => {
        if (this.activation === "unknown") this.activation = "granted"
      },
      (error: unknown) => {
        const name = (error as { name?: string })?.name
        if (name !== "NotAllowedError") return
        // Muted bridge: Chrome generally permits muted playback (§10.6).
        el.muted = true
        void el.play().then(
          () => {
            this.activation = "muted_bridge"
            showToast("Synced — click to unmute.", () => this.onActivationGesture(el))
          },
          () => {
            this.activation = "needs_gesture"
            showToast("Click to join the room's playback.", () => this.onActivationGesture(el))
          },
        )
      },
    )
  }

  private clocksOk(): ClockHop | null {
    if (this.p2p === null || this.local === null) return null
    if (!this.p2p.locked || !this.local.locked) return null
    return {
      offsetMs: this.p2p.offsetMs + this.local.offsetMs,
      uncMs: this.p2p.uncMs + this.local.uncMs,
      locked: true,
    }
  }

  private hardSeek(el: HTMLMediaElement, target: number): void {
    this.epochChanged = false
    this.awaitingSeeked = true
    this.seekIssuedAt = performance.now()
    el.currentTime = Math.max(0, target + this.seekLeadS)
    this.sampler.reset()
  }

  private holdRate(el: HTMLMediaElement, dtSec: number): void {
    this.appliedRate = slewRate(this.appliedRate, 1, dtSec)
    this.writeRate(el, this.appliedRate)
  }

  private restoreRate(): void {
    const el = this.adapter.element()
    if (el !== null) this.writeRate(el, 1)
    this.appliedRate = 1
  }

  private writeRate(el: HTMLMediaElement, rate: number): void {
    this.expectedRate = rate
    if (Math.abs(el.playbackRate - rate) > 1e-6) el.playbackRate = rate
  }

  private report(state: PeerSyncState, eSec: number): void {
    const jitter = this.sampler.jitterP95Ms()
    const status: FollowerStatus = {
      state,
      eMs: Math.round(eSec * 1000 * 10) / 10,
      jitterMs: Number.isFinite(jitter) ? Math.round(jitter * 10) / 10 : -1,
    }
    if (state !== this.lastState) {
      this.lastState = state
      if (state !== "muted_bridge" && state !== "needs_activation" && state !== "program_mismatch") hideToast()
    }
    this.onStateChange(status)
  }

  lastStatus(): FollowerStatus {
    const jitter = this.sampler.jitterP95Ms()
    return {
      state: this.lastState,
      eMs: Math.round(this.lastE * 1000 * 10) / 10,
      jitterMs: Number.isFinite(jitter) ? Math.round(jitter * 10) / 10 : -1,
    }
  }
}
