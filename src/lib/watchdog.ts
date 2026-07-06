// Rate watchdog (spec §10.4) — guards R1/R2: page code fighting playbackRate.
// Pure state machine; the content-script shell wires it to ratechange events
// and the sampler's fitted slope, and applies the actions.

import {
  WATCHDOG_EXTERNAL_MAX, WATCHDOG_EXTERNAL_WINDOW_MS, WATCHDOG_MIN_TRIM,
} from "./constants.js"

export type WatchdogState = Readonly<{
  /** Current trim capability; 0 ⇒ coarse mode. */
  maxTrim: number
  externalEventsAtMs: readonly number[]
  mismatchStreak: number
  /** One re-probe is allowed after a confirmed slope mismatch. */
  reprobeSpent: boolean
}>

export type WatchdogAction = "none" | "reassert" | "reprobe" | "downgrade"

export const initWatchdog = (maxTrim: number): WatchdogState => ({
  maxTrim,
  externalEventsAtMs: [],
  mismatchStreak: 0,
  reprobeSpent: false,
})

/** Halve maxTrim; at or below the floor, drop to coarse (rateTrim = 0). */
export const applyDowngrade = (s: WatchdogState): WatchdogState => ({
  ...s,
  maxTrim: s.maxTrim <= WATCHDOG_MIN_TRIM ? 0 : s.maxTrim / 2,
  mismatchStreak: 0,
})

/**
 * A ratechange we did not cause. Re-assert our rate once; persistent external
 * writes (≥ WATCHDOG_EXTERNAL_MAX within the window) mean the page is fighting
 * us — downgrade.
 */
export const onExternalRateChange = (
  s: WatchdogState,
  atMs: number,
): Readonly<{ state: WatchdogState; action: WatchdogAction }> => {
  const recent = [...s.externalEventsAtMs, atMs].filter(
    (t) => atMs - t <= WATCHDOG_EXTERNAL_WINDOW_MS,
  )
  if (recent.length >= WATCHDOG_EXTERNAL_MAX) {
    return { state: applyDowngrade({ ...s, externalEventsAtMs: [] }), action: "downgrade" }
  }
  return { state: { ...s, externalEventsAtMs: recent }, action: "reassert" }
}

/**
 * Periodic slope check while TRIM holds a commanded rate: if the element's
 * measured slope doesn't track the command for 3 consecutive checks, it isn't
 * obeying — re-probe once, then downgrade.
 */
export const onSlopeCheck = (
  s: WatchdogState,
  commandedRate: number,
  fittedSlope: number,
): Readonly<{ state: WatchdogState; action: WatchdogAction }> => {
  const commandedTrim = Math.abs(commandedRate - 1)
  if (commandedTrim < 1e-6) return { state: { ...s, mismatchStreak: 0 }, action: "none" }
  const mismatch = Math.abs(fittedSlope - commandedRate) > 0.5 * commandedTrim
  if (!mismatch) return { state: { ...s, mismatchStreak: 0 }, action: "none" }
  const streak = s.mismatchStreak + 1
  if (streak < 3) return { state: { ...s, mismatchStreak: streak }, action: "none" }
  if (!s.reprobeSpent) {
    return { state: { ...s, mismatchStreak: 0, reprobeSpent: true }, action: "reprobe" }
  }
  return { state: applyDowngrade(s), action: "downgrade" }
}
