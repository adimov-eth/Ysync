// PeerHub: all RTCPeerConnections (star, host-centered), clock master/slave
// for the P2P hop, beacon fan-out, connection lifecycle (§6.4), UI state.
// Runs in the offscreen document. The ONLY extension API available here is
// chrome.runtime (§5.4) — config arrives as message-passed values, nothing
// persists.

import {
  BEACON_MAX_AGE_S, GRACE_S, INBOUND_MSG_PER_S_MAX, MAX_PEERS, PAIRING_TIMEOUT_MS,
  PING_HZ, PROTO_VERSION, RESTART_AFTER_S, RESTART_TIMEOUT_S, STUN_URL,
  WARMUP_HZ, WARMUP_PINGS,
} from "../lib/constants.js"
import {
  addSample, emptyClockFilter, estimate, ntpSample, type ClockFilterState,
} from "../lib/clock.js"
import {
  allowedFrom, parseWire, sanitizeName,
  type Beacon, type Ev, type EvKind, type Snap, type Wire,
} from "../lib/proto.js"
import type { PeerSyncState, Program, Result } from "../lib/types.js"
import { err, ok } from "../lib/types.js"
import { decodePairBlob, encodePairBlob, randomId } from "./blob.js"

export type ConnState = "new" | "connected" | "coasting" | "rejoinable"

export type PeerInfo = Readonly<{
  peerId: string
  name: string
  connState: ConnState
  rttMs: number | null
  uncMs: number | null
  status: Readonly<{ state: PeerSyncState; eMs: number; jitterMs: number }> | null
}>

export type RoomState = Readonly<{
  phase: "idle" | "hosting" | "joined"
  roomId: string | null
  selfName: string
  hostName: string | null
  program: Program | null
  peers: readonly PeerInfo[]
  pendingOfferBlob: string | null
  clock: Readonly<{ offsetMs: number; uncMs: number; locked: boolean }> | null // guest
  conn: ConnState | null // guest
  lastError: string | null
}>

type Peer = {
  peerId: string
  name: string
  pc: RTCPeerConnection
  control: RTCDataChannel | null
  clock: RTCDataChannel | null
  state: RTCDataChannel | null
  connState: ConnState
  filter: ClockFilterState // guest side: offset host−self
  lastSeq: number
  epoch: number
  status: { state: PeerSyncState; eMs: number; jitterMs: number } | null
  rttMs: number | null
  // ingress rate limiting
  msgCount: number
  msgWindowStart: number
  // timers
  graceTimer: ReturnType<typeof setTimeout> | null
  restartTimer: ReturnType<typeof setTimeout> | null
  pingTimer: ReturnType<typeof setTimeout> | null
  pingCount: number
  pendingPings: Map<number, number> // id → t0
  helloSeen: boolean
}

export type HubEvents = Readonly<{
  onRoomState: (s: RoomState) => void
  /** Guest: relay host traffic to the content script. */
  onBeacon: (b: Beacon) => void
  onEv: (ev: Ev) => void
  onClockMap: (offsetMs: number, uncMs: number, locked: boolean) => void
  onConnState: (s: "connected" | "coasting" | "rejoinable") => void
  /** Notify the SW (election input + lifecycle). */
  onProgramChanged: (p: Program | null) => void
  onRoomActive: (active: boolean) => void
}>

const rtcConfig = (lanOnly: boolean): RTCConfiguration =>
  lanOnly ? { iceServers: [] } : { iceServers: [{ urls: STUN_URL }] }

const waitGatheringComplete = (pc: RTCPeerConnection): Promise<void> =>
  new Promise((resolve) => {
    if (pc.iceGatheringState === "complete") {
      resolve()
      return
    }
    const check = (): void => {
      if (pc.iceGatheringState === "complete") {
        pc.removeEventListener("icegatheringstatechange", check)
        resolve()
      }
    }
    pc.addEventListener("icegatheringstatechange", check)
    // Belt and braces: some networks never signal complete; cap the wait.
    setTimeout(() => {
      pc.removeEventListener("icegatheringstatechange", check)
      resolve()
    }, PAIRING_TIMEOUT_MS)
  })

export class PeerHub {
  private role: "host" | "guest" | null = null
  private roomId: string | null = null
  private myPeerId = randomId()
  private myName = ""
  private hostName: string | null = null
  private lanOnly = false
  private epoch = 0
  private seq = 0
  private program: Program | null = null
  private latestSnap: Snap | null = null
  private latestUncMs = 0
  private peers = new Map<string, Peer>()
  private pendingPeer: Peer | null = null // host: offer issued, answer not yet pasted
  private pendingOfferBlob: string | null = null
  private lastError: string | null = null
  private hostAdActive = false
  private lastHostBuffering = false

  constructor(private readonly events: HubEvents) {}

  // ---------- Room lifecycle ----------

  createRoom(name: string, lanOnly: boolean): void {
    this.reset()
    this.role = "host"
    this.roomId = randomId()
    this.myPeerId = randomId() // room-scoped, regenerated per room (§14)
    this.myName = sanitizeName(name)
    this.lanOnly = lanOnly
    this.events.onRoomActive(true)
    this.pushRoomState()
  }

  async addPeer(): Promise<Result<string, string>> {
    if (this.role !== "host" || this.roomId === null) return err("not hosting")
    if (this.peers.size >= MAX_PEERS) return err("room is full")
    if (this.pendingPeer !== null) this.destroyPeer(this.pendingPeer)

    const pc = new RTCPeerConnection(rtcConfig(this.lanOnly))
    const peer = this.newPeer(pc, "?") // name learned from hello
    // DTLS roles fixed: host offers (§6.1). Channels created by host (§7.1).
    peer.control = pc.createDataChannel("control")
    peer.clock = pc.createDataChannel("clock", { ordered: false, maxRetransmits: 0 })
    peer.state = pc.createDataChannel("state", { ordered: false, maxRetransmits: 0 })
    this.wireChannels(peer)
    this.wirePc(peer)

    await pc.setLocalDescription(await pc.createOffer())
    await waitGatheringComplete(pc)
    const sdp = pc.localDescription?.sdp
    if (sdp === undefined) {
      this.destroyPeer(peer)
      return err("no local description")
    }
    const blob = await encodePairBlob({
      v: 1, kind: "offer", roomId: this.roomId, peerId: this.myPeerId,
      name: this.myName, ts: Date.now(), sdp,
    })
    this.pendingPeer = peer
    this.pendingOfferBlob = blob
    this.pushRoomState()
    return ok(blob)
  }

  async acceptAnswer(encoded: string): Promise<Result<null, string>> {
    if (this.role !== "host") return err("not hosting")
    const peer = this.pendingPeer
    if (peer === null) return err("no pending invite — click Add peer first")
    const blob = await decodePairBlob(encoded, { nowMs: Date.now() })
    if (!blob.ok) return err(blob.error.reason)
    if (blob.value.kind !== "answer") return err("that's an offer blob, expected an answer")
    if (blob.value.roomId !== this.roomId) return err("answer is for a different room")
    peer.peerId = blob.value.peerId
    peer.name = blob.value.name
    try {
      await peer.pc.setRemoteDescription({ type: "answer", sdp: blob.value.sdp })
    } catch {
      return err("invalid answer blob")
    }
    this.peers.set(peer.peerId, peer)
    this.pendingPeer = null
    this.pendingOfferBlob = null // single-use bearer token consumed
    this.pushRoomState()
    return ok(null)
  }

  async join(encoded: string, name: string, lanOnly: boolean): Promise<Result<string, string>> {
    const blob = await decodePairBlob(encoded, { nowMs: Date.now() })
    if (!blob.ok) return err(blob.error.reason)
    if (blob.value.kind !== "offer") return err("that's an answer blob, expected an invite")

    this.reset()
    this.role = "guest"
    this.roomId = blob.value.roomId
    this.myPeerId = randomId()
    this.myName = sanitizeName(name)
    this.hostName = blob.value.name
    this.lanOnly = lanOnly

    const pc = new RTCPeerConnection(rtcConfig(lanOnly))
    const peer = this.newPeer(pc, blob.value.name)
    peer.peerId = blob.value.peerId
    pc.ondatachannel = (e) => {
      if (e.channel.label === "control") peer.control = e.channel
      else if (e.channel.label === "clock") peer.clock = e.channel
      else if (e.channel.label === "state") peer.state = e.channel
      else return
      this.wireChannel(peer, e.channel)
    }
    this.wirePc(peer)

    try {
      await pc.setRemoteDescription({ type: "offer", sdp: blob.value.sdp })
    } catch {
      this.reset()
      return err("invalid invite blob")
    }
    await pc.setLocalDescription(await pc.createAnswer())
    await waitGatheringComplete(pc)
    const sdp = pc.localDescription?.sdp
    if (sdp === undefined) {
      this.reset()
      return err("no local description")
    }
    this.peers.set(peer.peerId, peer)
    this.events.onRoomActive(true)
    this.pushRoomState()
    return ok(
      await encodePairBlob({
        v: 1, kind: "answer", roomId: this.roomId, peerId: this.myPeerId,
        name: this.myName, ts: Date.now(), sdp,
      }),
    )
  }

  leave(): void {
    this.broadcast({ t: "bye" })
    this.reset()
    this.events.onRoomActive(false)
    this.pushRoomState()
  }

  // ---------- Host: media inputs from the controlled tab ----------

  /** Host content pushed a sample (snap already rebased into our clock). */
  hostSample(snap: Snap, uncMs: number): void {
    if (this.role !== "host") return
    const prevProgram = this.program
    this.latestSnap = snap
    this.latestUncMs = uncMs
    if (prevProgram === null || prevProgram.service !== snap.program.service || prevProgram.mediaId !== snap.program.mediaId) {
      this.program = snap.program
      this.events.onProgramChanged(this.program)
      if (prevProgram !== null) this.bumpEpoch("program")
    }
    // Buffering-stall recovery = discontinuity (§8.3).
    if (this.lastHostBuffering && !snap.buffering) this.bumpEpoch("seek")
    this.lastHostBuffering = snap.buffering
    this.fanOutBeacon()
  }

  hostMediaEv(kind: "seeked" | "play" | "pause" | "waiting" | "playing" | "nav" | "ad", ad?: boolean): void {
    if (this.role !== "host") return
    switch (kind) {
      case "seeked":
        this.bumpEpoch("seek")
        break
      case "play":
        this.emitEv("play")
        break
      case "pause":
        this.emitEv("pause")
        break
      case "ad":
        this.hostAdActive = ad === true
        this.bumpEpoch(ad === true ? "ad-start" : "ad-end")
        break
      case "waiting":
      case "playing":
      case "nav":
        break // beacons carry buffering; nav resolves via the next sample's program
      default:
        break
    }
  }

  /** Guest content reported its sync state; forward upstream to the host. */
  guestStatus(state: PeerSyncState, eMs: number, jitterMs: number): void {
    if (this.role !== "guest") return
    const host = this.hostPeer()
    if (host?.control?.readyState === "open") {
      host.control.send(JSON.stringify({ t: "status", state, eMs, jitterMs }))
    }
  }

  roomStateSnapshot(): RoomState {
    const host = this.hostPeer()
    const raw = this.role === "guest" && host !== null ? estimate(host.filter) : null
    // Port messages are JSON-serialized: Infinity (empty filter's uncMs)
    // becomes null on the wire and crashes consumers. Never emit non-finite.
    const clock =
      raw !== null && Number.isFinite(raw.offsetMs) && Number.isFinite(raw.uncMs) ? raw : null
    return {
      phase: this.role === null ? "idle" : this.role === "host" ? "hosting" : "joined",
      roomId: this.roomId,
      selfName: this.myName,
      hostName: this.hostName,
      program: this.program,
      peers: [...this.peers.values()].map((p) => ({
        peerId: p.peerId,
        name: p.name,
        connState: p.connState,
        rttMs: p.rttMs !== null && Number.isFinite(p.rttMs) ? p.rttMs : null,
        uncMs: this.role === "guest" ? (clock?.uncMs ?? null) : null,
        status: p.status === null ? null : { ...p.status },
      })),
      pendingOfferBlob: this.pendingOfferBlob,
      clock: clock === null ? null : { offsetMs: clock.offsetMs, uncMs: clock.uncMs, locked: clock.locked },
      conn: this.role === "guest" ? (host?.connState === "new" ? "coasting" : (host?.connState ?? null)) : null,
      lastError: this.lastError,
    }
  }

  // ---------- internals ----------

  private newPeer(pc: RTCPeerConnection, name: string): Peer {
    return {
      peerId: randomId(), name, pc,
      control: null, clock: null, state: null,
      connState: "new",
      filter: emptyClockFilter,
      lastSeq: -1, epoch: -1,
      status: null, rttMs: null,
      msgCount: 0, msgWindowStart: performance.now(),
      graceTimer: null, restartTimer: null, pingTimer: null,
      pingCount: 0, pendingPings: new Map(),
      helloSeen: false,
    }
  }

  private hostPeer(): Peer | null {
    if (this.role !== "guest") return null
    return this.peers.values().next().value ?? null
  }

  private wireChannels(peer: Peer): void {
    for (const ch of [peer.control, peer.clock, peer.state]) {
      if (ch !== null) this.wireChannel(peer, ch)
    }
  }

  private wireChannel(peer: Peer, ch: RTCDataChannel): void {
    ch.onmessage = (e) => this.onWireMessage(peer, ch, e.data as unknown)
    ch.onopen = () => {
      if (ch.label === "control" && this.role === "guest") {
        ch.send(JSON.stringify({ t: "hello", protoVersion: PROTO_VERSION, peerId: this.myPeerId, name: this.myName }))
      }
      if (ch.label === "clock" && this.role === "guest") {
        this.startPinging(peer, true)
      }
      this.pushRoomState()
    }
    ch.onclose = () => {
      if (ch.label === "control" && peer.connState !== "rejoinable") {
        // Control gone ⇒ in-band signaling gone ⇒ transport unrecoverable (§6.4).
        this.toRejoinable(peer)
      }
    }
  }

  private wirePc(peer: Peer): void {
    peer.pc.onconnectionstatechange = () => {
      const cs = peer.pc.connectionState
      if (cs === "connected") {
        this.clearTimers(peer)
        peer.connState = "connected"
        if (this.role === "guest") this.events.onConnState("connected")
        this.pushRoomState()
      } else if (cs === "disconnected") {
        this.toCoasting(peer)
      } else if (cs === "failed" || cs === "closed") {
        this.toRejoinable(peer)
      }
    }
  }

  private toCoasting(peer: Peer): void {
    if (peer.connState === "rejoinable") return
    peer.connState = "coasting"
    if (this.role === "guest") this.events.onConnState("coasting")
    this.pushRoomState()

    // Host-only in-band ICE restart after 5 s, while control still flows (§6.4).
    if (this.role === "host" && peer.graceTimer === null) {
      peer.graceTimer = setTimeout(() => {
        peer.graceTimer = null
        void this.tryIceRestart(peer)
      }, RESTART_AFTER_S * 1000)
    }
    // Either side: grace expiry without recovery ⇒ rejoinable.
    if (peer.restartTimer === null) {
      peer.restartTimer = setTimeout(() => {
        peer.restartTimer = null
        if (peer.connState !== "connected") this.toRejoinable(peer)
      }, (GRACE_S + RESTART_TIMEOUT_S) * 1000)
    }
  }

  private async tryIceRestart(peer: Peer): Promise<void> {
    if (peer.connState === "connected" || peer.connState === "rejoinable") return
    if (peer.control?.readyState !== "open") return // never restart into a dead control path
    try {
      peer.pc.restartIce()
      await peer.pc.setLocalDescription(await peer.pc.createOffer())
      await waitGatheringComplete(peer.pc)
      const sdp = peer.pc.localDescription?.sdp
      if (sdp === undefined || peer.control.readyState !== "open") return
      const blob = await encodePairBlob({
        v: 1, kind: "offer", roomId: this.roomId ?? "", peerId: this.myPeerId,
        name: this.myName, ts: Date.now(), sdp,
      })
      peer.control.send(JSON.stringify({ t: "restart-offer", blob }))
    } catch {
      // Restart failing is fine; the rejoinable timer is already armed.
    }
  }

  private toRejoinable(peer: Peer): void {
    if (peer.connState === "rejoinable") return
    this.clearTimers(peer)
    peer.connState = "rejoinable"
    // Room metadata (names, program) persists so re-pairing is one round (§6.4).
    if (this.role === "guest") this.events.onConnState("rejoinable")
    this.pushRoomState()
  }

  private clearTimers(peer: Peer): void {
    for (const t of [peer.graceTimer, peer.restartTimer, peer.pingTimer]) {
      if (t !== null) clearTimeout(t)
    }
    peer.graceTimer = null
    peer.restartTimer = null
    peer.pingTimer = null
  }

  private destroyPeer(peer: Peer): void {
    this.clearTimers(peer)
    try {
      peer.pc.close()
    } catch {
      // already closed
    }
    this.peers.delete(peer.peerId)
  }

  private reset(): void {
    for (const p of [...this.peers.values()]) this.destroyPeer(p)
    if (this.pendingPeer !== null) this.destroyPeer(this.pendingPeer)
    this.peers.clear()
    this.pendingPeer = null
    this.pendingOfferBlob = null
    this.role = null
    this.roomId = null
    this.hostName = null
    this.program = null
    this.latestSnap = null
    this.epoch = 0
    this.seq = 0
    this.lastError = null
    this.hostAdActive = false
    this.lastHostBuffering = false
    this.events.onProgramChanged(null)
  }

  // ---------- clock (guest = requester, host = responder) ----------

  private startPinging(peer: Peer, warmup: boolean): void {
    if (peer.pingTimer !== null) clearTimeout(peer.pingTimer)
    if (warmup) peer.pingCount = 0
    const tick = (): void => {
      peer.pingTimer = null
      if (peer.clock?.readyState === "open") {
        const id = crypto.getRandomValues(new Uint32Array(1))[0] ?? 0
        const t0 = performance.now()
        peer.pendingPings.set(id, t0)
        if (peer.pendingPings.size > 16) {
          const first = peer.pendingPings.keys().next().value
          if (first !== undefined) peer.pendingPings.delete(first)
        }
        try {
          peer.clock.send(JSON.stringify({ t: "ping", id, t0 }))
        } catch {
          // unreliable channel; drop
        }
        peer.pingCount++
      }
      const interval = peer.pingCount < WARMUP_PINGS ? 1000 / WARMUP_HZ : 1000 / PING_HZ
      peer.pingTimer = setTimeout(tick, interval)
    }
    tick()
  }

  // ---------- wire ingress ----------

  private onWireMessage(peer: Peer, ch: RTCDataChannel, data: unknown): void {
    // Rate limit (§14): sustained >50 msg/s ⇒ drop peer.
    const now = performance.now()
    if (now - peer.msgWindowStart > 1000) {
      peer.msgWindowStart = now
      peer.msgCount = 0
    }
    if (++peer.msgCount > INBOUND_MSG_PER_S_MAX) {
      this.destroyPeer(peer)
      this.lastError = `peer ${peer.name} dropped: flooding`
      this.pushRoomState()
      return
    }

    const parsed = parseWire(data)
    if (!parsed.ok) return // dropped + (implicitly) counted via msgCount
    const msg = parsed.value
    const from = this.role === "host" ? "follower" : "host"
    if (!allowedFrom(msg, from)) return

    switch (msg.t) {
      case "hello": {
        if (this.role !== "host" || peer.helloSeen) return
        if (msg.protoVersion !== PROTO_VERSION) {
          peer.control?.send(JSON.stringify({ t: "bye" }))
          this.destroyPeer(peer)
          this.lastError = "peer protocol version mismatch"
          this.pushRoomState()
          return
        }
        peer.helloSeen = true
        peer.name = msg.name
        if (msg.peerId !== peer.peerId && msg.peerId.length > 0) {
          this.peers.delete(peer.peerId)
          peer.peerId = msg.peerId
          this.peers.set(peer.peerId, peer)
        }
        const snap = this.latestSnap
        if (peer.control?.readyState === "open" && this.roomId !== null && snap !== null) {
          peer.control.send(JSON.stringify({ t: "welcome", roomId: this.roomId, hostName: this.myName, epoch: this.epoch, snap }))
        } else if (peer.control?.readyState === "open" && this.roomId !== null) {
          // No program playing yet: welcome with a null-ish snap once one exists.
          // Guests derive everything from beacons; welcome is a fast-path only.
        }
        this.pushRoomState()
        return
      }
      case "ping": {
        // Respond on the same (clock) channel with receipt + send stamps.
        if (ch.readyState === "open") {
          const t1 = performance.now()
          ch.send(JSON.stringify({ t: "pong", id: msg.id, t0: msg.t0, t1, t2: performance.now() }))
        }
        return
      }
      case "pong": {
        const t0 = peer.pendingPings.get(msg.id)
        if (t0 === undefined || t0 !== msg.t0) return
        peer.pendingPings.delete(msg.id)
        const t3 = performance.now()
        const sample = ntpSample({ t0, t1: msg.t1, t2: msg.t2, t3 }, t3)
        peer.rttMs = sample.rttMs
        const r = addSample(peer.filter, sample)
        peer.filter = r.state
        if (r.stale !== null) this.startPinging(peer, true) // re-burst after wake/step
        if (this.role === "guest") {
          const e = estimate(peer.filter)
          this.events.onClockMap(e.offsetMs, e.uncMs, e.locked)
        }
        return
      }
      case "beacon": {
        if (this.role !== "guest") return
        if (msg.seq <= peer.lastSeq) return // latest-wins (§8.2)
        if (msg.epoch < peer.epoch) return // stale-epoch beacon after an ev (§8.2, v1.2)
        peer.lastSeq = msg.seq
        peer.epoch = msg.epoch
        if (this.program === null || this.program.service !== msg.program.service || this.program.mediaId !== msg.program.mediaId) {
          this.program = msg.program
          this.events.onProgramChanged(this.program)
        }
        this.events.onBeacon(msg)
        return
      }
      case "ev": {
        if (this.role !== "guest") return
        peer.epoch = Math.max(peer.epoch, msg.epoch)
        if (this.program === null || this.program.service !== msg.snap.program.service || this.program.mediaId !== msg.snap.program.mediaId) {
          this.program = msg.snap.program
          this.events.onProgramChanged(this.program)
        }
        this.events.onEv(msg)
        return
      }
      case "status": {
        if (this.role !== "host") return
        peer.status = { state: msg.state, eMs: msg.eMs, jitterMs: msg.jitterMs }
        this.pushRoomState()
        return
      }
      case "restart-offer": {
        if (this.role !== "guest") return
        void this.answerRestart(peer, msg.blob)
        return
      }
      case "restart-answer": {
        if (this.role !== "host") return
        void (async () => {
          const blob = await decodePairBlob(msg.blob, { nowMs: Date.now() })
          if (!blob.ok) return
          try {
            await peer.pc.setRemoteDescription({ type: "answer", sdp: blob.value.sdp })
          } catch {
            // restart failed; rejoinable timer handles it
          }
        })()
        return
      }
      case "welcome": {
        if (this.role !== "guest") return
        this.hostName = msg.hostName
        peer.epoch = msg.epoch
        this.program = msg.snap.program
        this.events.onProgramChanged(this.program)
        this.events.onEv({ t: "ev", epoch: msg.epoch, kind: "program", snap: msg.snap })
        this.pushRoomState()
        return
      }
      case "bye": {
        this.toRejoinable(peer)
        return
      }
      default:
        return
    }
  }

  private async answerRestart(peer: Peer, encodedOffer: string): Promise<void> {
    const blob = await decodePairBlob(encodedOffer, { nowMs: Date.now() })
    if (!blob.ok) return
    try {
      await peer.pc.setRemoteDescription({ type: "offer", sdp: blob.value.sdp })
      await peer.pc.setLocalDescription(await peer.pc.createAnswer())
      await waitGatheringComplete(peer.pc)
      const sdp = peer.pc.localDescription?.sdp
      if (sdp !== undefined && peer.control?.readyState === "open") {
        const answer = await encodePairBlob({
          v: 1, kind: "answer", roomId: this.roomId ?? "", peerId: this.myPeerId,
          name: this.myName, ts: Date.now(), sdp,
        })
        peer.control.send(JSON.stringify({ t: "restart-answer", blob: answer }))
      }
    } catch {
      // dead transport; rejoinable timer handles it
    }
  }

  // ---------- host fan-out ----------

  private bumpEpoch(kind: EvKind): void {
    this.epoch++
    this.emitEv(kind)
  }

  private emitEv(kind: EvKind): void {
    const snap = this.latestSnap
    if (snap === null) return
    const ev: Ev = { t: "ev", epoch: this.epoch, kind, snap: { ...snap, adActive: this.hostAdActive } }
    this.broadcast(ev)
  }

  private fanOutBeacon(): void {
    const snap = this.latestSnap
    if (snap === null) return
    const beacon: Beacon = {
      t: "beacon",
      seq: this.seq++, // global monotonic across epoch bumps — never resets (§8.2)
      epoch: this.epoch,
      program: snap.program,
      mediaTime: snap.mediaTime,
      hostClock: snap.hostClock,
      rate: snap.rate,
      playing: snap.playing,
      buffering: snap.buffering,
      adActive: this.hostAdActive,
      uncMs: this.latestUncMs,
    }
    const json = JSON.stringify(beacon)
    for (const p of this.peers.values()) {
      if (p.state?.readyState === "open") {
        try {
          p.state.send(json)
        } catch {
          // unreliable channel; stale beacons are worthless anyway
        }
      }
    }
  }

  private broadcast(msg: Wire): void {
    const json = JSON.stringify(msg)
    for (const p of this.peers.values()) {
      if (p.control?.readyState === "open") {
        try {
          p.control.send(json)
        } catch {
          // toRejoinable via onclose
        }
      }
    }
  }

  private pushRoomState(): void {
    this.events.onRoomState(this.roomStateSnapshot())
  }

  /** Beacon considered stale for UI purposes (guest-side coasting hint). */
  static beaconFresh(beacon: Beacon | null, nowHostClockMs: number): boolean {
    return beacon !== null && nowHostClockMs - beacon.hostClock <= BEACON_MAX_AGE_S * 1000
  }
}
