// Deterministic PRNG for tests/sim (mulberry32). No Math.random in tests.

export type Rng = () => number

export const mulberry32 = (seed: number): Rng => {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Uniform in [min, max). */
export const uniform = (rng: Rng, min: number, max: number): number =>
  min + rng() * (max - min)

export const p95 = (xs: readonly number[]): number => {
  const s = [...xs].sort((a, b) => a - b)
  return s[Math.min(s.length - 1, Math.ceil(0.95 * s.length) - 1)] ?? NaN
}
