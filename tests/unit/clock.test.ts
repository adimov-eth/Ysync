import { describe, expect, it } from "vitest"
import {
  addSample, emptyClockFilter, estimate, ntpSample,
  type ClockFilterState, type PingTimes,
} from "../../src/lib/clock.js"
import { mulberry32, uniform } from "../helpers/prng.js"

/** Simulate one ping/pong exchange with a true offset and asymmetric path jitter. */
const exchange = (
  trueOffsetMs: number,
  atMs: number,
  upMs: number,
  downMs: number,
): PingTimes => {
  const t0 = atMs
  const t1 = t0 + upMs + trueOffsetMs
  const t2 = t1 + 0.1 // responder processing
  const t3 = t2 - trueOffsetMs + downMs
  return { t0, t1, t2, t3 }
}

const run = (
  state: ClockFilterState,
  trueOffsetMs: number,
  count: number,
  jitter: (i: number) => { up: number; down: number },
  startMs = 0,
  intervalMs = 1000,
): ClockFilterState => {
  let s = state
  for (let i = 0; i < count; i++) {
    const at = startMs + i * intervalMs
    const { up, down } = jitter(i)
    const sample = ntpSample(exchange(trueOffsetMs, at, up, down), at)
    s = addSample(s, sample).state
  }
  return s
}

describe("ntpSample", () => {
  it("recovers exact offset and rtt on a symmetric path", () => {
    const s = ntpSample(exchange(42.5, 0, 3, 3), 0)
    expect(s.offsetMs).toBeCloseTo(42.5, 6)
    expect(s.rttMs).toBeCloseTo(6.0, 6) // rtt excludes responder processing time
  })
})

describe("clock filter", () => {
  it("recovers offset within 1 ms under asymmetric jitter (RTT gating)", () => {
    const rng = mulberry32(7)
    // Base path 1 ms each way; occasional large asymmetric spikes.
    const s = run(emptyClockFilter, -17.3, 32, () => {
      const spike = rng() < 0.3
      return {
        up: 1 + (spike ? uniform(rng, 0, 20) : uniform(rng, 0, 0.3)),
        down: 1 + (spike ? uniform(rng, 0, 20) : uniform(rng, 0, 0.3)),
      }
    })
    const e = estimate(s)
    expect(e.locked).toBe(true)
    expect(Math.abs(e.offsetMs - -17.3)).toBeLessThan(1)
    expect(e.uncMs).toBeLessThan(1)
  })

  it("is not locked before enough gated samples", () => {
    const s = run(emptyClockFilter, 5, 3, () => ({ up: 1, down: 1 }))
    expect(estimate(s).locked).toBe(false)
  })

  it("triggers gap stale after a >3 s hole and resets the window", () => {
    let s = run(emptyClockFilter, 5, 10, () => ({ up: 1, down: 1 }))
    const late = ntpSample(exchange(5, 20_000, 1, 1), 20_000)
    const r = addSample(s, late)
    expect(r.stale).toBe("gap")
    expect(r.state.samples.length).toBe(1)
  })

  it("triggers jump stale after 5 consecutive large offset jumps", () => {
    let s = run(emptyClockFilter, 0, 16, () => ({ up: 1, down: 1 }))
    // Clock stepped by 50 ms (e.g. across sleep without a scheduling gap).
    let stale: string | null = null
    for (let i = 0; i < 6; i++) {
      const at = 16_000 + i * 1000
      const r = addSample(s, ntpSample(exchange(50, at, 1, 1), at))
      s = r.state
      if (r.stale !== null) {
        stale = r.stale
        break
      }
    }
    expect(stale).toBe("jump")
  })

  it("triggers rtt stale on sustained rtt blowup", () => {
    let s = run(emptyClockFilter, 0, 16, () => ({ up: 1, down: 1 }))
    let stale: string | null = null
    for (let i = 0; i < 8; i++) {
      const at = 16_000 + i * 1000
      const r = addSample(s, ntpSample(exchange(0, at, 30, 30), at))
      s = r.state
      if (r.stale !== null) {
        stale = r.stale
        break
      }
    }
    expect(stale).toBe("rtt")
  })

  it("keeps window bounded at WINDOW samples", () => {
    const s = run(emptyClockFilter, 5, 100, () => ({ up: 1, down: 1 }))
    expect(s.samples.length).toBeLessThanOrEqual(32)
  })
})
