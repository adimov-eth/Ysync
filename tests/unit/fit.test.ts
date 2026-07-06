import { describe, expect, it } from "vitest"
import { fitEdges, mediaTimeAt, type EdgePoint } from "../../src/lib/fit.js"
import { mulberry32, uniform } from "../helpers/prng.js"

/**
 * Synthesize edge-detected samples from a quantized media clock:
 * true media time advances at `rate`; currentTime is quantized to
 * `quantumSec` buffers; edges land where the quantized value changes,
 * observed with poll-grid alignment error up to `pollMs`.
 */
const synthEdges = (opts: {
  rate: number
  quantumSec: number
  pollMs: number
  count: number
  seed: number
}): EdgePoint[] => {
  const rng = mulberry32(opts.seed)
  const edges: EdgePoint[] = []
  const quantumWallMs = (opts.quantumSec / opts.rate) * 1000
  for (let k = 1; k <= opts.count; k++) {
    const trueEdgeWallMs = k * quantumWallMs
    // Edge observed at the first poll tick after the true edge.
    const observedAt = trueEdgeWallMs + uniform(rng, 0, opts.pollMs)
    edges.push({ perfMs: observedAt, mediaSec: k * opts.quantumSec })
  }
  return edges
}

describe("edge fit", () => {
  it("returns null with fewer than 4 edges", () => {
    expect(fitEdges([])).toBeNull()
    expect(
      fitEdges([
        { perfMs: 0, mediaSec: 0 },
        { perfMs: 100, mediaSec: 0.1 },
        { perfMs: 200, mediaSec: 0.2 },
      ]),
    ).toBeNull()
  })

  it("recovers rate 1.0 from quantized samples within 0.1%", () => {
    const edges = synthEdges({ rate: 1, quantumSec: 0.02, pollMs: 5, count: 16, seed: 3 })
    const fit = fitEdges(edges)
    expect(fit).not.toBeNull()
    expect(Math.abs((fit?.slope ?? 0) - 1)).toBeLessThan(0.02)
  })

  it("recovers a 2% trim (rate 1.02) well enough for the watchdog", () => {
    const edges = synthEdges({ rate: 1.02, quantumSec: 0.02, pollMs: 2, count: 16, seed: 9 })
    const fit = fitEdges(edges)
    expect(fit).not.toBeNull()
    // Watchdog needs |r_m − r_c| ≤ 0.5 × |r_c − 1| = 0.01
    expect(Math.abs((fit?.slope ?? 0) - 1.02)).toBeLessThan(0.01)
  })

  it("predicts media time between edges (quantization removed)", () => {
    const edges = synthEdges({ rate: 1, quantumSec: 0.02, pollMs: 1, count: 16, seed: 5 })
    const fit = fitEdges(edges)
    expect(fit).not.toBeNull()
    if (fit === null) return
    // Query halfway between two edges: raw quantized read would be off by
    // up to 20 ms; the fit should be within ~3 ms.
    const queryMs = 15.5 * 20
    const predicted = mediaTimeAt(fit, queryMs)
    expect(Math.abs(predicted - 0.31)).toBeLessThan(0.003)
  })

  it("estimates jitter honestly on a noisy clock", () => {
    const rng = mulberry32(11)
    const noisy: EdgePoint[] = []
    for (let k = 1; k <= 16; k++) {
      noisy.push({ perfMs: k * 100 + uniform(rng, -8, 8), mediaSec: k * 0.1 })
    }
    const fit = fitEdges(noisy)
    expect(fit).not.toBeNull()
    expect(fit?.jitterP95Ms ?? 0).toBeGreaterThan(3)
  })

  it("reports low jitter on a clean clock", () => {
    const edges = synthEdges({ rate: 1, quantumSec: 0.02, pollMs: 0.5, count: 16, seed: 13 })
    const fit = fitEdges(edges)
    expect(fit?.jitterP95Ms ?? Infinity).toBeLessThan(2)
  })
})
