// Robust line fit for the edge-detected media-clock sampler (spec §9).
// Theil–Sen slope + median intercept over change edges; jitter estimated
// from residuals. Pure — feeds both the servo and the rate watchdog.

export type EdgePoint = Readonly<{ perfMs: number; mediaSec: number }>

export type EdgeFit = Readonly<{
  /** Fitted media-seconds per wall-second — the element's measured effective rate. */
  slope: number
  refPerfMs: number
  refMediaSec: number
  /** p95 of |residuals| in wall-clock ms. */
  jitterP95Ms: number
  n: number
}>

const median = (xs: readonly number[]): number => {
  const s = [...xs].sort((a, b) => a - b)
  const mid = Math.floor(s.length / 2)
  const a = s[mid]
  const b = s[s.length % 2 === 0 ? mid - 1 : mid]
  return a === undefined || b === undefined ? NaN : (a + b) / 2
}

const p95 = (xs: readonly number[]): number => {
  if (xs.length === 0) return NaN
  const s = [...xs].sort((a, b) => a - b)
  return s[Math.min(s.length - 1, Math.ceil(0.95 * s.length) - 1)] ?? NaN
}

export const fitEdges = (edges: readonly EdgePoint[]): EdgeFit | null => {
  if (edges.length < 4) return null

  const slopes: number[] = []
  for (let i = 0; i < edges.length; i++) {
    for (let j = i + 1; j < edges.length; j++) {
      const a = edges[i]
      const b = edges[j]
      if (a === undefined || b === undefined) continue
      const dt = b.perfMs - a.perfMs
      if (Math.abs(dt) < 1) continue // same-tick pair: slope undefined
      slopes.push(((b.mediaSec - a.mediaSec) * 1000) / dt)
    }
  }
  if (slopes.length === 0) return null
  const slope = median(slopes)
  if (!Number.isFinite(slope)) return null

  const ref = edges[edges.length - 1]
  if (ref === undefined) return null
  const intercepts = edges.map(
    (e) => e.mediaSec - (slope * (e.perfMs - ref.perfMs)) / 1000,
  )
  const refMediaSec = median(intercepts)

  // Residuals converted to wall-clock ms (divide by slope; slope ≈ rate ≈ 1).
  const denom = Math.abs(slope) > 0.01 ? Math.abs(slope) : 1
  const residualsMs = edges.map((e) => {
    const predicted = refMediaSec + (slope * (e.perfMs - ref.perfMs)) / 1000
    return (Math.abs(e.mediaSec - predicted) * 1000) / denom
  })

  return {
    slope,
    refPerfMs: ref.perfMs,
    refMediaSec,
    jitterP95Ms: p95(residualsMs),
    n: edges.length,
  }
}

export const mediaTimeAt = (fit: EdgeFit, perfMs: number): number =>
  fit.refMediaSec + (fit.slope * (perfMs - fit.refPerfMs)) / 1000
