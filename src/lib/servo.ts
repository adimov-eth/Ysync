// Servo control law (spec §10.3). Pure core — the effectful shell in
// content/ owns the media element, timers, and event wiring.
//
// P-only, no integral: the only steady-state disturbance is relative clock
// skew (tens of ppm); e_ss ≈ 20 ppm × TAU_S = 40 µs, three orders under the
// deadband. Proportional-on-state is also what makes 1 Hz hidden-tab ticks
// safe — the law is tick-rate independent.

import { DEADBAND_S, HARD_SYNC_S, SLEW_PER_S, TAU_S } from "./constants.js"
import { assertNever } from "./types.js"

export type ServoMode = "HOLD" | "SETTLE" | "SEEK" | "LOCKED" | "TRIM"

export type ServoInput = Readonly<{
  finePreconditionsOk: boolean
  settling: boolean
  epochChanged: boolean
  /** target − actual, seconds; e > 0 ⇒ behind ⇒ speed up. */
  eSec: number
  /** Sampler jitter p95, ms — widens the effective deadband (spec §9). */
  jitterP95Ms: number
  /** min(MAX_TRIM, probe result), possibly lowered by the watchdog. */
  maxTrim: number
}>

export type ServoDecision =
  | Readonly<{ mode: "HOLD"; rateTarget: 1 }>
  | Readonly<{ mode: "SETTLE"; rateTarget: 1 }>
  | Readonly<{ mode: "SEEK"; rateTarget: 1 }>
  | Readonly<{ mode: "LOCKED"; rateTarget: 1 }>
  | Readonly<{ mode: "TRIM"; rateTarget: number }>

export const effectiveDeadbandSec = (jitterP95Ms: number): number =>
  Math.max(DEADBAND_S, (1.5 * jitterP95Ms) / 1000)

export const decide = (input: ServoInput): ServoDecision => {
  if (!input.finePreconditionsOk) return { mode: "HOLD", rateTarget: 1 }
  if (input.settling) return { mode: "SETTLE", rateTarget: 1 }
  if (input.epochChanged || Math.abs(input.eSec) > HARD_SYNC_S) {
    return { mode: "SEEK", rateTarget: 1 }
  }
  if (Math.abs(input.eSec) <= effectiveDeadbandSec(input.jitterP95Ms)) {
    return { mode: "LOCKED", rateTarget: 1 }
  }
  const trim = Math.max(-input.maxTrim, Math.min(input.maxTrim, input.eSec / TAU_S))
  return { mode: "TRIM", rateTarget: 1 + trim }
}

/** Applied rate moves toward the target at ≤ SLEW_PER_S — no audible steps. */
export const slewRate = (currentRate: number, targetRate: number, dtSec: number): number => {
  const maxStep = SLEW_PER_S * Math.max(0, dtSec)
  const delta = targetRate - currentRate
  if (Math.abs(delta) <= maxStep) return targetRate
  return currentRate + Math.sign(delta) * maxStep
}

export const isSteadyMode = (mode: ServoMode): boolean => {
  switch (mode) {
    case "LOCKED":
      return true
    case "HOLD":
    case "SETTLE":
    case "SEEK":
    case "TRIM":
      return false
    default:
      return assertNever(mode)
  }
}
