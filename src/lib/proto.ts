// Wire & port schemas (spec §19, Appendix B) with hand-rolled ingress guards.
// Parse, don't validate: every DataChannel message, Port message, and blob
// passes through here and comes out as a typed value or an Err. Numbers are
// finite-checked, strings length-capped, unknown `t` rejected.
//
// v1.2 delta over the spec: Beacon and sample carry `uncMs` — the host's
// content↔offscreen local-hop uncertainty — so followers can include it in
// their fine-sync gate (host-side rebase error was invisible in v1.1).

import { BLOB_MAX_SDP, NAME_MAX_CHARS, PROTO_VERSION, WIRE_MSG_MAX_CHARS } from "./constants.js"
import type { ParseError, PeerSyncState, Program, Result, Service } from "./types.js"
import { err, ok, parseError, PEER_SYNC_STATES } from "./types.js"

// ---- Shared shapes ----

export type Snap = Readonly<{
  program: Program
  mediaTime: number // seconds
  hostClock: number // ms, host-offscreen performance.now() domain
  rate: number
  playing: boolean
  buffering: boolean
  adActive: boolean
}>

export type Beacon = Readonly<{
  t: "beacon"
  seq: number
  epoch: number
  program: Program
  mediaTime: number
  hostClock: number
  rate: number
  playing: boolean
  buffering: boolean
  adActive: boolean
  /** Host-side local-hop clock uncertainty, ms (summed into the follower's gate). */
  uncMs: number
}>

export type EvKind = "play" | "pause" | "seek" | "program" | "ad-start" | "ad-end"

export type Ev = Readonly<{ t: "ev"; epoch: number; kind: EvKind; snap: Snap }>

// ---- DataChannel messages ----

export type Wire =
  | Readonly<{ t: "hello"; protoVersion: number; peerId: string; name: string }>
  | Readonly<{ t: "welcome"; roomId: string; hostName: string; epoch: number; snap: Snap }>
  | Readonly<{ t: "ping"; id: number; t0: number }>
  | Readonly<{ t: "pong"; id: number; t0: number; t1: number; t2: number }>
  | Beacon
  | Ev
  | Readonly<{ t: "status"; state: PeerSyncState; eMs: number; jitterMs: number }>
  | Readonly<{ t: "restart-offer"; blob: string }>
  | Readonly<{ t: "restart-answer"; blob: string }>
  | Readonly<{ t: "bye" }>

// ---- Content ↔ Offscreen "media" port ----

export type MediaHello = Readonly<{
  t: "mediaHello"
  proto: number
  instanceId: string
  service: Service
  mediaId: string | null
  adapterVersion: string
}>

export type PortMsg =
  | MediaHello // MUST be first on the port
  | Readonly<{ t: "controlled"; on: boolean }>
  | Readonly<{ t: "ping"; id: number; t0: number }>
  | Readonly<{ t: "pong"; id: number; t0: number; t1: number; t2: number }>
  | Readonly<{ t: "clock-map"; hostOffsetMs: number; uncMs: number; locked: boolean }>
  // Host content → offscreen. `snap.hostClock` is already rebased into the
  // host-offscreen domain by the content script (it owns the local-hop
  // filter); `uncMs` is that hop's MAD.
  | Readonly<{ t: "sample"; snap: Snap; uncMs: number }>
  | Readonly<{ t: "beacon-relay"; beacon: Beacon }>
  | Readonly<{ t: "ev-relay"; ev: Ev }>
  | Readonly<{
      t: "media-ev"
      kind: "seeked" | "play" | "pause" | "waiting" | "playing" | "nav" | "ad" | "external-ratechange"
      ad?: boolean
    }>
  | Readonly<{ t: "state-report"; state: PeerSyncState; eMs: number; jitterMs: number }>
  | Readonly<{ t: "gesture-needed" }>
  // Offscreen → content (guest): transport health, folded into PeerSyncState.
  | Readonly<{ t: "conn"; state: "connected" | "coasting" | "rejoinable" }>

// ---- Popup → Offscreen "ui" port ----

export type UiMsg =
  | Readonly<{ t: "createRoom"; name: string; lanOnly: boolean }>
  | Readonly<{ t: "addPeer" }>
  | Readonly<{ t: "join"; blob: string; name: string; lanOnly: boolean }>
  | Readonly<{ t: "acceptAnswer"; blob: string }>
  | Readonly<{ t: "leave" }>
  | Readonly<{ t: "endRoom" }>

// ---- One-shot runtime lifecycle messages (envelope-routed) ----

export type Envelope = Readonly<{ target: "sw" | "offscreen" | "popup" | "content"; msg: unknown }>

export type SwMsg =
  | Readonly<{ t: "register"; service: Service; mediaId: string | null; audible: boolean }>
  | Readonly<{ t: "unregister" }>
  | Readonly<{ t: "need-offscreen" }>
  | Readonly<{ t: "program-changed"; program: Program | null }>
  | Readonly<{ t: "room-active"; active: boolean }>

export type ContentMsg = Readonly<{ t: "controlled"; on: boolean }>

// ---- Pairing blob ----

export type PairBlob = Readonly<{
  v: 1
  kind: "offer" | "answer"
  roomId: string
  peerId: string
  name: string
  ts: number // Date.now(), TTL only — never used in sync math
  sdp: string
}>

// ---- Guard helpers ----

const isRecord = (x: unknown): x is Record<string, unknown> =>
  typeof x === "object" && x !== null && !Array.isArray(x)

const finiteNum = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x)

const boundedStr = (x: unknown, cap: number): x is string =>
  typeof x === "string" && x.length <= cap

const isBool = (x: unknown): x is boolean => typeof x === "boolean"

const SERVICES: readonly Service[] = ["youtube", "spotify", "fixture"]

const isService = (x: unknown): x is Service => SERVICES.includes(x as Service)

const isPeerSyncState = (x: unknown): x is PeerSyncState =>
  PEER_SYNC_STATES.includes(x as PeerSyncState)

/** Strip control characters and cap length (spec §14). */
export const sanitizeName = (raw: string): string =>
  raw.replace(/[\u0000-\u001f\u007f-\u009f]/g, "").slice(0, NAME_MAX_CHARS)

const parseProgram = (x: unknown): Program | null => {
  if (!isRecord(x)) return null
  if (!isService(x.service)) return null
  if (!boundedStr(x.mediaId, 256) || x.mediaId.length === 0) return null
  return { service: x.service, mediaId: x.mediaId }
}

const parseSnap = (x: unknown): Snap | null => {
  if (!isRecord(x)) return null
  const program = parseProgram(x.program)
  if (program === null) return null
  if (!finiteNum(x.mediaTime) || !finiteNum(x.hostClock) || !finiteNum(x.rate)) return null
  if (!isBool(x.playing) || !isBool(x.buffering) || !isBool(x.adActive)) return null
  return {
    program,
    mediaTime: x.mediaTime,
    hostClock: x.hostClock,
    rate: x.rate,
    playing: x.playing,
    buffering: x.buffering,
    adActive: x.adActive,
  }
}

const parseBeaconFields = (x: Record<string, unknown>): Beacon | null => {
  const program = parseProgram(x.program)
  if (program === null) return null
  if (!finiteNum(x.seq) || !finiteNum(x.epoch)) return null
  if (!finiteNum(x.mediaTime) || !finiteNum(x.hostClock) || !finiteNum(x.rate)) return null
  if (!isBool(x.playing) || !isBool(x.buffering) || !isBool(x.adActive)) return null
  if (!finiteNum(x.uncMs)) return null
  return {
    t: "beacon",
    seq: x.seq,
    epoch: x.epoch,
    program,
    mediaTime: x.mediaTime,
    hostClock: x.hostClock,
    rate: x.rate,
    playing: x.playing,
    buffering: x.buffering,
    adActive: x.adActive,
    uncMs: x.uncMs,
  }
}

const EV_KINDS: readonly EvKind[] = ["play", "pause", "seek", "program", "ad-start", "ad-end"]

const parseEvFields = (x: Record<string, unknown>): Ev | null => {
  if (!finiteNum(x.epoch)) return null
  if (!EV_KINDS.includes(x.kind as EvKind)) return null
  const snap = parseSnap(x.snap)
  if (snap === null) return null
  return { t: "ev", epoch: x.epoch, kind: x.kind as EvKind, snap }
}

// ---- Wire parser ----

export const parseWire = (raw: unknown): Result<Wire, ParseError> => {
  if (typeof raw !== "string") return err(parseError("wire: not a string"))
  if (raw.length > WIRE_MSG_MAX_CHARS) return err(parseError("wire: too long"))
  let json: unknown
  try {
    json = JSON.parse(raw)
  } catch {
    return err(parseError("wire: invalid json"))
  }
  return parseWireObject(json)
}

export const parseWireObject = (x: unknown): Result<Wire, ParseError> => {
  if (!isRecord(x)) return err(parseError("wire: not an object"))
  switch (x.t) {
    case "hello": {
      if (!finiteNum(x.protoVersion)) return err(parseError("hello: bad protoVersion"))
      if (!boundedStr(x.peerId, 32) || x.peerId.length === 0) return err(parseError("hello: bad peerId"))
      if (!boundedStr(x.name, 256)) return err(parseError("hello: bad name"))
      return ok({ t: "hello", protoVersion: x.protoVersion, peerId: x.peerId, name: sanitizeName(x.name) })
    }
    case "welcome": {
      if (!boundedStr(x.roomId, 32)) return err(parseError("welcome: bad roomId"))
      if (!boundedStr(x.hostName, 256)) return err(parseError("welcome: bad hostName"))
      if (!finiteNum(x.epoch)) return err(parseError("welcome: bad epoch"))
      const snap = parseSnap(x.snap)
      if (snap === null) return err(parseError("welcome: bad snap"))
      return ok({ t: "welcome", roomId: x.roomId, hostName: sanitizeName(x.hostName), epoch: x.epoch, snap })
    }
    case "ping": {
      if (!finiteNum(x.id) || !finiteNum(x.t0)) return err(parseError("ping: bad fields"))
      return ok({ t: "ping", id: x.id, t0: x.t0 })
    }
    case "pong": {
      if (!finiteNum(x.id) || !finiteNum(x.t0) || !finiteNum(x.t1) || !finiteNum(x.t2)) {
        return err(parseError("pong: bad fields"))
      }
      return ok({ t: "pong", id: x.id, t0: x.t0, t1: x.t1, t2: x.t2 })
    }
    case "beacon": {
      const b = parseBeaconFields(x)
      return b === null ? err(parseError("beacon: bad fields")) : ok(b)
    }
    case "ev": {
      const e = parseEvFields(x)
      return e === null ? err(parseError("ev: bad fields")) : ok(e)
    }
    case "status": {
      if (!isPeerSyncState(x.state)) return err(parseError("status: bad state"))
      if (!finiteNum(x.eMs) || !finiteNum(x.jitterMs)) return err(parseError("status: bad fields"))
      return ok({ t: "status", state: x.state, eMs: x.eMs, jitterMs: x.jitterMs })
    }
    case "restart-offer": {
      if (!boundedStr(x.blob, 8192)) return err(parseError("restart-offer: bad blob"))
      return ok({ t: "restart-offer", blob: x.blob })
    }
    case "restart-answer": {
      if (!boundedStr(x.blob, 8192)) return err(parseError("restart-answer: bad blob"))
      return ok({ t: "restart-answer", blob: x.blob })
    }
    case "bye":
      return ok({ t: "bye" })
    default:
      return err(parseError(`wire: unknown t ${String(JSON.stringify(x.t)).slice(0, 32)}`))
  }
}

/**
 * Peer-trust filter (spec §14): followers accept beacon/ev/welcome/restart-offer
 * only from the host connection; the host accepts only hello/pong/status/
 * restart-answer/bye. ping/pong flow both ways on the clock channel.
 */
export const allowedFrom = (msg: Wire, from: "host" | "follower"): boolean => {
  switch (msg.t) {
    case "hello":
    case "status":
    case "restart-answer":
      return from === "follower"
    case "welcome":
    case "beacon":
    case "ev":
    case "restart-offer":
      return from === "host"
    case "ping":
    case "pong":
    case "bye":
      return true
    default:
      return false
  }
}

// ---- Port parser ----

export const parsePortMsg = (x: unknown): Result<PortMsg, ParseError> => {
  if (!isRecord(x)) return err(parseError("port: not an object"))
  switch (x.t) {
    case "mediaHello": {
      if (x.proto !== PROTO_VERSION) return err(parseError("mediaHello: proto mismatch"))
      if (!boundedStr(x.instanceId, 64) || x.instanceId.length === 0) {
        return err(parseError("mediaHello: bad instanceId"))
      }
      if (!isService(x.service)) return err(parseError("mediaHello: bad service"))
      if (x.mediaId !== null && !boundedStr(x.mediaId, 256)) {
        return err(parseError("mediaHello: bad mediaId"))
      }
      if (!boundedStr(x.adapterVersion, 32)) return err(parseError("mediaHello: bad adapterVersion"))
      return ok({
        t: "mediaHello",
        proto: PROTO_VERSION,
        instanceId: x.instanceId,
        service: x.service,
        mediaId: (x.mediaId ?? null) as string | null,
        adapterVersion: x.adapterVersion,
      })
    }
    case "controlled": {
      if (!isBool(x.on)) return err(parseError("controlled: bad on"))
      return ok({ t: "controlled", on: x.on })
    }
    case "ping": {
      if (!finiteNum(x.id) || !finiteNum(x.t0)) return err(parseError("port ping: bad fields"))
      return ok({ t: "ping", id: x.id, t0: x.t0 })
    }
    case "pong": {
      if (!finiteNum(x.id) || !finiteNum(x.t0) || !finiteNum(x.t1) || !finiteNum(x.t2)) {
        return err(parseError("port pong: bad fields"))
      }
      return ok({ t: "pong", id: x.id, t0: x.t0, t1: x.t1, t2: x.t2 })
    }
    case "clock-map": {
      if (!finiteNum(x.hostOffsetMs) || !finiteNum(x.uncMs) || !isBool(x.locked)) {
        return err(parseError("clock-map: bad fields"))
      }
      return ok({ t: "clock-map", hostOffsetMs: x.hostOffsetMs, uncMs: x.uncMs, locked: x.locked })
    }
    case "sample": {
      const snap = parseSnap(x.snap)
      if (snap === null) return err(parseError("sample: bad snap"))
      if (!finiteNum(x.uncMs)) return err(parseError("sample: bad uncMs"))
      return ok({ t: "sample", snap, uncMs: x.uncMs })
    }
    case "beacon-relay": {
      if (!isRecord(x.beacon) || x.beacon.t !== "beacon") return err(parseError("beacon-relay: bad beacon"))
      const b = parseBeaconFields(x.beacon)
      return b === null ? err(parseError("beacon-relay: bad beacon")) : ok({ t: "beacon-relay", beacon: b })
    }
    case "ev-relay": {
      if (!isRecord(x.ev) || x.ev.t !== "ev") return err(parseError("ev-relay: bad ev"))
      const e = parseEvFields(x.ev)
      return e === null ? err(parseError("ev-relay: bad ev")) : ok({ t: "ev-relay", ev: e })
    }
    case "media-ev": {
      const kinds = ["seeked", "play", "pause", "waiting", "playing", "nav", "ad", "external-ratechange"] as const
      if (!kinds.includes(x.kind as (typeof kinds)[number])) return err(parseError("media-ev: bad kind"))
      const out: { t: "media-ev"; kind: (typeof kinds)[number]; ad?: boolean } = {
        t: "media-ev",
        kind: x.kind as (typeof kinds)[number],
      }
      if (isBool(x.ad)) out.ad = x.ad
      return ok(out)
    }
    case "state-report": {
      if (!isPeerSyncState(x.state)) return err(parseError("state-report: bad state"))
      if (!finiteNum(x.eMs) || !finiteNum(x.jitterMs)) return err(parseError("state-report: bad fields"))
      return ok({ t: "state-report", state: x.state, eMs: x.eMs, jitterMs: x.jitterMs })
    }
    case "gesture-needed":
      return ok({ t: "gesture-needed" })
    case "conn": {
      if (x.state !== "connected" && x.state !== "coasting" && x.state !== "rejoinable") {
        return err(parseError("conn: bad state"))
      }
      return ok({ t: "conn", state: x.state })
    }
    default:
      return err(parseError(`port: unknown t ${String(JSON.stringify(x.t)).slice(0, 32)}`))
  }
}

// ---- UI port parser (popup → offscreen) ----

export const parseUiMsg = (x: unknown): Result<UiMsg, ParseError> => {
  if (!isRecord(x)) return err(parseError("ui: not an object"))
  switch (x.t) {
    case "createRoom": {
      if (!boundedStr(x.name, 256) || !isBool(x.lanOnly)) return err(parseError("createRoom: bad fields"))
      return ok({ t: "createRoom", name: sanitizeName(x.name), lanOnly: x.lanOnly })
    }
    case "addPeer":
      return ok({ t: "addPeer" })
    case "join": {
      if (!boundedStr(x.blob, 8192) || !boundedStr(x.name, 256) || !isBool(x.lanOnly)) {
        return err(parseError("join: bad fields"))
      }
      return ok({ t: "join", blob: x.blob, name: sanitizeName(x.name), lanOnly: x.lanOnly })
    }
    case "acceptAnswer": {
      if (!boundedStr(x.blob, 8192)) return err(parseError("acceptAnswer: bad blob"))
      return ok({ t: "acceptAnswer", blob: x.blob })
    }
    case "leave":
      return ok({ t: "leave" })
    case "endRoom":
      return ok({ t: "endRoom" })
    default:
      return err(parseError(`ui: unknown t ${String(JSON.stringify(x.t)).slice(0, 32)}`))
  }
}

// ---- SW lifecycle parser ----

export const parseSwMsg = (x: unknown): Result<SwMsg, ParseError> => {
  if (!isRecord(x)) return err(parseError("sw: not an object"))
  switch (x.t) {
    case "register": {
      if (!isService(x.service)) return err(parseError("register: bad service"))
      if (x.mediaId !== null && x.mediaId !== undefined && !boundedStr(x.mediaId, 256)) {
        return err(parseError("register: bad mediaId"))
      }
      if (!isBool(x.audible)) return err(parseError("register: bad audible"))
      return ok({ t: "register", service: x.service, mediaId: (x.mediaId ?? null) as string | null, audible: x.audible })
    }
    case "unregister":
      return ok({ t: "unregister" })
    case "need-offscreen":
      return ok({ t: "need-offscreen" })
    case "program-changed": {
      if (x.program === null) return ok({ t: "program-changed", program: null })
      const program = parseProgram(x.program)
      if (program === null) return err(parseError("program-changed: bad program"))
      return ok({ t: "program-changed", program })
    }
    case "room-active": {
      if (!isBool(x.active)) return err(parseError("room-active: bad active"))
      return ok({ t: "room-active", active: x.active })
    }
    default:
      return err(parseError(`sw: unknown t ${String(JSON.stringify(x.t)).slice(0, 32)}`))
  }
}

// ---- PairBlob schema guard (codec caps live in blob.ts) ----

export const parsePairBlob = (x: unknown): Result<PairBlob, ParseError> => {
  if (!isRecord(x)) return err(parseError("blob: not an object"))
  if (x.v !== 1) return err(parseError("blob: unsupported version"))
  if (x.kind !== "offer" && x.kind !== "answer") return err(parseError("blob: bad kind"))
  if (!boundedStr(x.roomId, 32) || x.roomId.length === 0) return err(parseError("blob: bad roomId"))
  if (!boundedStr(x.peerId, 32) || x.peerId.length === 0) return err(parseError("blob: bad peerId"))
  if (!boundedStr(x.name, 256)) return err(parseError("blob: bad name"))
  if (!finiteNum(x.ts)) return err(parseError("blob: bad ts"))
  if (!boundedStr(x.sdp, BLOB_MAX_SDP) || x.sdp.length === 0) return err(parseError("blob: bad sdp"))
  return ok({
    v: 1,
    kind: x.kind,
    roomId: x.roomId,
    peerId: x.peerId,
    name: sanitizeName(x.name),
    ts: x.ts,
    sdp: x.sdp,
  })
}
