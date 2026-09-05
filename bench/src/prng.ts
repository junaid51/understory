/**
 * mulberry32. Small, fast, dependency-free, and deterministic across machines
 * and Node versions, which is the only property that matters here: a corpus
 * generated from seed 7 must be byte-identical on a contributor's laptop and on
 * a CI runner, or reproducing a benchmark means nothing.
 */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Uniform integer in [min, max]. */
export const randInt = (rng: () => number, min: number, max: number): number =>
  min + Math.floor(rng() * (max - min + 1))
