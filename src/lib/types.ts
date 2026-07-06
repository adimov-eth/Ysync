// Pure foundational types. No chrome.* imports allowed anywhere in lib/.

/**
 * Branded numeric units. Clock-domain and unit mix-ups are THE bug class in
 * this codebase (spec §16.1) — a HostClockMs must not flow into a slot that
 * expects ContentClockMs without an explicit, measured conversion.
 */
export type Brand<B extends string> = number & { readonly __unit: B }

export type Ms = Brand<"Ms">
export type Sec = Brand<"Sec">
/** performance.now() in the host machine's offscreen document — the canonical room timeline. */
export type HostClockMs = Brand<"HostClockMs">
/** performance.now() in a content script (each page has its own origin). */
export type ContentClockMs = Brand<"ContentClockMs">
/** performance.now() in the local offscreen document. */
export type OffscreenClockMs = Brand<"OffscreenClockMs">
/** Media element position, seconds. */
export type MediaSec = Brand<"MediaSec">

export const ms = (n: number): Ms => n as Ms
export const sec = (n: number): Sec => n as Sec
export const hostClockMs = (n: number): HostClockMs => n as HostClockMs
export const contentClockMs = (n: number): ContentClockMs => n as ContentClockMs
export const offscreenClockMs = (n: number): OffscreenClockMs => n as OffscreenClockMs
export const mediaSec = (n: number): MediaSec => n as MediaSec

// ---- Option / Result ----

export type Option<T> = Readonly<{ some: true; value: T }> | Readonly<{ some: false }>

export const some = <T>(value: T): Option<T> => ({ some: true, value })
export const none: Option<never> = { some: false }

export type Result<T, E> = Readonly<{ ok: true; value: T }> | Readonly<{ ok: false; error: E }>

export const ok = <T>(value: T): Result<T, never> => ({ ok: true, value })
export const err = <E>(error: E): Result<never, E> => ({ ok: false, error })

export type ParseError = Readonly<{ reason: string }>

export const parseError = (reason: string): ParseError => ({ reason })

export const assertNever = (x: never): never => {
  throw new Error(`unreachable: ${JSON.stringify(x)}`)
}

// ---- Domain enums shared across every context ----

export type Service = "youtube" | "spotify" | "fixture"

export type Program = Readonly<{ service: Service; mediaId: string }>

export const sameProgram = (a: Program, b: Program): boolean =>
  a.service === b.service && a.mediaId === b.mediaId

/** Unified peer-level state machine (spec §10.6). UI chips and logic share it. */
export type PeerSyncState =
  | "pairing"
  | "clock_warmup"
  | "needs_activation"
  | "muted_bridge"
  | "loading_program"
  | "program_mismatch"
  | "converging"
  | "locked"
  | "clock_degraded"
  | "buffering"
  | "ad_muted"
  | "coarse"
  | "unsupported"
  | "coasting"
  | "rejoinable"

export const PEER_SYNC_STATES: readonly PeerSyncState[] = [
  "pairing", "clock_warmup", "needs_activation", "muted_bridge",
  "loading_program", "program_mismatch", "converging", "locked",
  "clock_degraded", "buffering", "ad_muted", "coarse", "unsupported",
  "coasting", "rejoinable",
]
