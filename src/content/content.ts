// Content-script orchestrator: adapter selection, SW registration +
// controlled-tab election handling, "media" port with handshake + backoff,
// local-hop clock, host sampling, follower engine wiring.

import {
  BEACON_HZ, PING_HZ, PORT_BACKOFF_MAX_MS, PORT_BACKOFF_MIN_MS, PROTO_VERSION,
  SERVO_TICK_MS, WARMUP_HZ, WARMUP_PINGS,
} from "../lib/constants.js"
import {
  addSample, emptyClockFilter, estimate, ntpSample, type ClockFilterState,
} from "../lib/clock.js"
import { parsePortMsg, type PortMsg, type Snap } from "../lib/proto.js"
import type { MediaAdapter } from "./adapter.js"
import { MediaSampler } from "./sampler.js"
import { FollowerEngine, type FollowerStatus } from "./servo.js"
import { fixtureAdapter } from "./fixture.js"
import { spotifyAdapter } from "./spotify.js"
import { youtubeAdapter } from "./youtube.js"

const pickAdapter = (): MediaAdapter | null => {
  if (location.host.endsWith("youtube.com")) return youtubeAdapter()
  if (location.host === "open.spotify.com") return spotifyAdapter()
  // Fixture pages exist only under the e2e manifest's localhost matches.
  if (document.querySelector("#chorus-media") !== null) return fixtureAdapter()
  return null
}

const adapter = pickAdapter()
if (adapter !== null) main(adapter)

function main(adapter: MediaAdapter): void {
  const instanceId = crypto.getRandomValues(new Uint32Array(2)).join("-")
  const sampler = new MediaSampler()

  let controlled = false
  let port: chrome.runtime.Port | null = null
  let portBackoffMs = PORT_BACKOFF_MIN_MS
  let localFilter: ClockFilterState = emptyClockFilter
  let pingCount = 0
  const pendingPings = new Map<number, number>()
  let lastStatusJson = ""
  let attachedEl: HTMLMediaElement | null = null

  const engine = new FollowerEngine(adapter, sampler, (status: FollowerStatus) => {
    // Report upstream at 1 Hz + on change (§8.4); the 1 Hz side runs on the tick.
    const json = JSON.stringify(status)
    if (json !== lastStatusJson) {
      lastStatusJson = json
      send({ t: "state-report", ...status })
    }
  })

  // ---- storage-backed offset slider (§5.4 storage map) ----
  void chrome.storage.local.get("offsetMs").then((got) => {
    const v = got["offsetMs"]
    if (typeof v === "number" && Number.isFinite(v)) engine.setLatencyOffsetMs(v)
  })
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return
    const v = changes["offsetMs"]?.newValue
    if (typeof v === "number" && Number.isFinite(v)) engine.setLatencyOffsetMs(v)
  })

  // ---- SW registration + controlled election (§5.3) ----
  const register = (): void => {
    const el = adapter.element()
    void chrome.runtime
      .sendMessage({
        target: "sw",
        msg: {
          t: "register",
          service: adapter.service,
          mediaId: adapter.mediaId(),
          audible: el !== null && !el.paused && !el.muted,
        },
      })
      .catch(() => {
        // SW spinning up; the next register (play/pause/nav) retries.
      })
  }

  chrome.runtime.onMessage.addListener((raw: unknown) => {
    const envelope = raw as { target?: string; msg?: unknown }
    if (envelope?.target !== "content") return
    const msg = envelope.msg as { t?: string; on?: boolean }
    if (msg?.t === "controlled" && typeof msg.on === "boolean") {
      controlled = msg.on
      engine.setControlled(msg.on)
      if (msg.on) {
        connectPort()
      }
    }
  })

  // ---- media port (§5.2): handshake + bounded backoff ----
  const send = (msg: PortMsg | Record<string, unknown>): void => {
    try {
      port?.postMessage(msg)
    } catch {
      // disconnected; reconnect loop handles it
    }
  }

  const connectPort = (): void => {
    if (port !== null) return
    let p: chrome.runtime.Port
    try {
      p = chrome.runtime.connect({ name: "media" })
    } catch {
      scheduleReconnect()
      return
    }
    port = p
    p.onMessage.addListener(onPortMessage)
    p.onDisconnect.addListener(() => {
      if (port === p) port = null
      // Offscreen may be gone: tell the SW so it can recreate it if a room
      // is active (§5.4), then retry with backoff.
      void chrome.runtime.sendMessage({ target: "sw", msg: { t: "need-offscreen" } }).catch(() => undefined)
      scheduleReconnect()
    })
    p.postMessage({
      t: "mediaHello",
      proto: PROTO_VERSION,
      instanceId,
      service: adapter.service,
      mediaId: adapter.mediaId(),
      adapterVersion: adapter.adapterVersion,
    })
    portBackoffMs = PORT_BACKOFF_MIN_MS
    pingCount = 0 // warmup burst on every fresh port: the offscreen doc may be new
  }

  const scheduleReconnect = (): void => {
    if (!controlled) return
    const delay = portBackoffMs
    portBackoffMs = Math.min(PORT_BACKOFF_MAX_MS, portBackoffMs * 2)
    setTimeout(() => {
      if (controlled && port === null) connectPort()
    }, delay)
  }

  const onPortMessage = (raw: unknown): void => {
    const parsed = parsePortMsg(raw)
    if (!parsed.ok) return
    const msg = parsed.value
    switch (msg.t) {
      case "pong": {
        const t0 = pendingPings.get(msg.id)
        if (t0 === undefined || t0 !== msg.t0) return
        pendingPings.delete(msg.id)
        const t3 = performance.now()
        const r = addSample(localFilter, ntpSample({ t0, t1: msg.t1, t2: msg.t2, t3 }, t3))
        localFilter = r.state
        if (r.stale !== null) pingCount = 0 // re-burst after sleep/step
        const e = estimate(localFilter)
        engine.setLocalHop(e.offsetMs, e.uncMs, e.locked)
        return
      }
      case "clock-map":
        engine.setClockMap(msg.hostOffsetMs, msg.uncMs, msg.locked)
        return
      case "beacon-relay":
        engine.setBeacon(msg.beacon)
        return
      case "ev-relay":
        engine.setEv(msg.ev)
        return
      case "conn":
        engine.setConn(msg.state)
        return
      default:
        return
    }
  }

  // ---- local-hop clock pings (same filter as the P2P hop, §7.3) ----
  const pingTick = (): void => {
    if (port !== null) {
      const id = crypto.getRandomValues(new Uint32Array(1))[0] ?? 0
      const t0 = performance.now()
      pendingPings.set(id, t0)
      if (pendingPings.size > 16) {
        const first = pendingPings.keys().next().value
        if (first !== undefined) pendingPings.delete(first)
      }
      send({ t: "ping", id, t0 })
      pingCount++
    }
    setTimeout(pingTick, pingCount < WARMUP_PINGS ? 1000 / WARMUP_HZ : 1000 / PING_HZ)
  }
  pingTick()

  // ---- element attachment + media events ----
  const ensureElement = (): HTMLMediaElement | null => {
    const el = adapter.element()
    if (el !== null && el !== attachedEl) {
      attachedEl = el
      sampler.attach(el)
      wireMediaEvents(el)
    }
    return el
  }

  const wireMediaEvents = (el: HTMLMediaElement): void => {
    el.addEventListener("play", () => {
      send({ t: "media-ev", kind: "play" })
      register() // audibility changed — election input
    })
    el.addEventListener("pause", () => {
      send({ t: "media-ev", kind: "pause" })
      register()
    })
    el.addEventListener("seeked", () => {
      engine.onSeeked()
      send({ t: "media-ev", kind: "seeked" })
    })
    el.addEventListener("waiting", () => {
      engine.setOwnStall(true)
      send({ t: "media-ev", kind: "waiting" })
    })
    el.addEventListener("playing", () => {
      engine.setOwnStall(false)
      send({ t: "media-ev", kind: "playing" })
    })
    el.addEventListener("ratechange", () => {
      if (engine.isExternalRateChange(el)) {
        engine.onExternalRateChange()
        send({ t: "media-ev", kind: "external-ratechange" })
      }
    })
    el.addEventListener("timeupdate", () => {
      if (controlled) engine.tick() // scheduling tick, never a sample source (§9)
    })
  }

  adapter.onNavigation(() => {
    attachedEl = null // players re-mount; re-resolve on demand (§12.2)
    sampler.reset()
    send({ t: "media-ev", kind: "nav" })
    register()
  })

  adapter.onAdChange((ad) => {
    send({ t: "media-ev", kind: "ad", ad })
  })

  // ---- host sampling: push snaps at BEACON_HZ (§8.2) ----
  // Runs whenever we're the controlled tab. On a guest machine the offscreen
  // hub ignores them (role guard) — a few tiny local messages, no peer traffic.
  setInterval(() => {
    if (!controlled || port === null) return
    const el = ensureElement()
    if (el === null) return
    const mediaId = adapter.mediaId()
    if (mediaId === null) return
    const clock = estimate(localFilter)
    if (!clock.locked) return
    const now = performance.now()
    const snap: Snap = {
      program: { service: adapter.service, mediaId },
      mediaTime: sampler.mediaTimeAt(now) ?? el.currentTime,
      // Rebase into the offscreen clock domain here — the content script owns
      // the local-hop filter (§7.4); on the host machine that IS hostClock.
      hostClock: now + clock.offsetMs,
      rate: el.playbackRate,
      playing: !el.paused,
      buffering: el.readyState < 3, // < HAVE_FUTURE_DATA
      adActive: adapter.canDetectAd && adapter.adActive(),
    }
    send({ t: "sample", snap, uncMs: clock.uncMs })
  }, 1000 / BEACON_HZ)

  // ---- servo backstop tick + periodic status ----
  setInterval(() => {
    if (!controlled) return
    ensureElement()
    engine.tick()
  }, SERVO_TICK_MS)

  setInterval(() => {
    if (controlled && port !== null) {
      send({ t: "state-report", ...engine.lastStatus() }) // 1 Hz heartbeat (§8.4)
    }
  }, 1000)

  register()
}
