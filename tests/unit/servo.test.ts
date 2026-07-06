import { describe, expect, it } from "vitest"
import { decide, effectiveDeadbandSec, slewRate, type ServoInput } from "../../src/lib/servo.js"

const base: ServoInput = {
  finePreconditionsOk: true,
  settling: false,
  epochChanged: false,
  eSec: 0,
  jitterP95Ms: 1,
  maxTrim: 0.02,
}

describe("servo decide — state × error band × preconditions table", () => {
  const cases: Array<[string, Partial<ServoInput>, string, number | null]> = [
    ["preconditions failed → HOLD even with huge error", { finePreconditionsOk: false, eSec: 5 }, "HOLD", 1],
    ["preconditions failed + epoch change → still HOLD (never seek blind)", { finePreconditionsOk: false, epochChanged: true }, "HOLD", 1],
    ["settling → SETTLE regardless of error", { settling: true, eSec: 0.3 }, "SETTLE", 1],
    ["epoch changed → SEEK", { epochChanged: true }, "SEEK", 1],
    ["|e| > HARD_SYNC → SEEK", { eSec: 0.41 }, "SEEK", 1],
    ["|e| = -0.41 → SEEK", { eSec: -0.41 }, "SEEK", 1],
    ["inside deadband → LOCKED", { eSec: 0.009 }, "LOCKED", 1],
    ["exactly at deadband → LOCKED", { eSec: 0.010 }, "LOCKED", 1],
    ["behind → TRIM speeds up", { eSec: 0.02 }, "TRIM", 1 + 0.02 / 2],
    ["ahead → TRIM slows down", { eSec: -0.02 }, "TRIM", 1 - 0.02 / 2],
    ["large error clamps at maxTrim", { eSec: 0.3 }, "TRIM", 1.02],
    ["large negative clamps at -maxTrim", { eSec: -0.3 }, "TRIM", 0.98],
    ["probe-lowered maxTrim respected", { eSec: 0.3, maxTrim: 0.005 }, "TRIM", 1.005],
  ]

  for (const [name, patch, mode, rate] of cases) {
    it(name, () => {
      const d = decide({ ...base, ...patch })
      expect(d.mode).toBe(mode)
      if (rate !== null) expect(d.rateTarget).toBeCloseTo(rate, 6)
    })
  }

  it("high jitter widens deadband: 10 ms error is LOCKED at 8 ms jitter p95", () => {
    // effective deadband = max(0.010, 1.5 × 0.008) = 0.012
    const d = decide({ ...base, jitterP95Ms: 8, eSec: 0.011 })
    expect(d.mode).toBe("LOCKED")
  })

  it("deadband never shrinks below the base under tiny jitter", () => {
    expect(effectiveDeadbandSec(0)).toBeCloseTo(0.010, 9)
    expect(effectiveDeadbandSec(10)).toBeCloseTo(0.015, 9)
  })
})

describe("slew limiting", () => {
  it("never moves faster than SLEW_PER_S", () => {
    // 0.25 s tick: max step 0.005
    expect(slewRate(1, 1.02, 0.25)).toBeCloseTo(1.005, 9)
    expect(slewRate(1.02, 1, 0.25)).toBeCloseTo(1.015, 9)
  })

  it("snaps to target when within one step", () => {
    expect(slewRate(1.004, 1.005, 0.25)).toBe(1.005)
  })

  it("full swing 0.98 → 1.02 takes ~2 s", () => {
    let r = 0.98
    let ticks = 0
    while (r !== 1.02 && ticks < 100) {
      r = slewRate(r, 1.02, 0.25)
      ticks++
    }
    // 0.04 / (0.02/s) = 2 s = 8 ticks; fp accumulation may add one snap tick.
    expect(ticks).toBeGreaterThanOrEqual(8)
    expect(ticks).toBeLessThanOrEqual(9)
    expect(r).toBe(1.02)
  })

  it("ignores negative dt", () => {
    expect(slewRate(1, 1.02, -1)).toBe(1)
  })
})
