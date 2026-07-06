// NTP-style clock filter (spec §7.3). Pure — values in, values out.
// Used identically for both hops: P2P (follower-offscreen ↔ host-offscreen)
// and local (content ↔ its own offscreen).

import {
  RTT_GATE_MS, STALE_GAP_MS, STALE_JUMP_COUNT, STALE_JUMP_MS,
  STALE_RTT_FACTOR, WINDOW,
} from "./constants.js"

export type PingTimes = Readonly<{ t0: number; t1: number; t2: number; t3: number }>

export type ClockSample = Readonly<{
  offsetMs: number // responderClock − requesterClock
  rttMs: number
  atMs: number // requester clock, when the sample landed
}>

export type ClockEstimate = Readonly<{
  offsetMs: number
  uncMs: number // MAD of gated samples
  keptCount: number
  locked: boolean
}>

export type ClockFilterState = Readonly<{
  samples: readonly ClockSample[]
  lastSampleAtMs: number | null
  consecutiveJumps: number
  consecutiveHighRtt: number
}>

export const emptyClockFilter: ClockFilterState = {
  samples: [],
  lastSampleAtMs: null,
  consecutiveJumps: 0,
  consecutiveHighRtt: 0,
}

export const ntpSample = (t: PingTimes, atMs: number): ClockSample => ({
  offsetMs: ((t.t1 - t.t0) + (t.t2 - t.t3)) / 2,
  rttMs: (t.t3 - t.t0) - (t.t2 - t.t1),
  atMs,
})

const median = (xs: readonly number[]): number => {
  const s = [...xs].sort((a, b) => a - b)
  const mid = Math.floor(s.length / 2)
  const a = s[mid]
  const b = s[s.length % 2 === 0 ? mid - 1 : mid]
  return a === undefined || b === undefined ? NaN : (a + b) / 2
}

const mad = (xs: readonly number[], med: number): number =>
  median(xs.map((x) => Math.abs(x - med)))

const MIN_KEPT = 5

/**
 * Samples whose rtt is within RTT_GATE_MS of the window minimum (relative
 * gate — works on internet paths). On jittery paths the gate can keep almost
 * nothing; fall back to the MIN_KEPT lowest-rtt samples so the estimate stays
 * defined — their spread shows up honestly in uncMs.
 */
const gated = (samples: readonly ClockSample[]): readonly ClockSample[] => {
  if (samples.length === 0) return samples
  const minRtt = Math.min(...samples.map((s) => s.rttMs))
  const inGate = samples.filter((s) => s.rttMs <= minRtt + RTT_GATE_MS)
  if (inGate.length >= MIN_KEPT) return inGate
  return [...samples].sort((a, b) => a.rttMs - b.rttMs).slice(0, MIN_KEPT)
}

export const estimate = (state: ClockFilterState): ClockEstimate => {
  const kept = gated(state.samples)
  if (kept.length === 0) return { offsetMs: 0, uncMs: Infinity, keptCount: 0, locked: false }
  const offsets = kept.map((s) => s.offsetMs)
  const offsetMs = median(offsets)
  const uncMs = mad(offsets, offsetMs)
  // Locked once the warmup burst has landed; quality gating is the caller's
  // job via uncMs (CLOCK_UNC_MAX_MS) — lock just means "estimate is formed".
  return { offsetMs, uncMs, keptCount: kept.length, locked: state.samples.length >= 8 }
}

export type StaleReason = "gap" | "rtt" | "jump"

export type AddResult = Readonly<{ state: ClockFilterState; stale: StaleReason | null }>

/**
 * Fold in one sample; report a stale trigger if this sample reveals one.
 * A stale trigger means the caller should reset the filter (`resetFilter`)
 * and run a warmup burst before trusting the estimate again.
 */
export const addSample = (state: ClockFilterState, sample: ClockSample): AddResult => {
  // Gap: scheduled pings should arrive ~1/s; a >3 s hole means sleep/throttle.
  if (state.lastSampleAtMs !== null && sample.atMs - state.lastSampleAtMs > STALE_GAP_MS) {
    return { state: resetWith(sample), stale: "gap" }
  }

  const before = estimate(state)
  const baselineRtt =
    state.samples.length > 0 ? Math.min(...state.samples.map((s) => s.rttMs)) : null

  const highRtt =
    baselineRtt !== null && baselineRtt > 0 && sample.rttMs > STALE_RTT_FACTOR * baselineRtt
  const consecutiveHighRtt = highRtt ? state.consecutiveHighRtt + 1 : 0
  if (consecutiveHighRtt >= STALE_JUMP_COUNT) {
    return { state: resetWith(sample), stale: "rtt" }
  }

  const jumped =
    before.keptCount >= 5 && Math.abs(sample.offsetMs - before.offsetMs) > STALE_JUMP_MS
  const consecutiveJumps = jumped ? state.consecutiveJumps + 1 : 0
  if (consecutiveJumps >= STALE_JUMP_COUNT) {
    return { state: resetWith(sample), stale: "jump" }
  }

  const samples = [...state.samples, sample].slice(-WINDOW)
  return {
    state: { samples, lastSampleAtMs: sample.atMs, consecutiveJumps, consecutiveHighRtt },
    stale: null,
  }
}

const resetWith = (sample: ClockSample): ClockFilterState => ({
  samples: [sample],
  lastSampleAtMs: sample.atMs,
  consecutiveJumps: 0,
  consecutiveHighRtt: 0,
})
