import { performance } from 'node:perf_hooks'

export interface Stats {
  readonly samples: number
  readonly mean: number
  readonly p50: number
  readonly p95: number
  readonly p99: number
  readonly max: number
  readonly min: number
  /** Operations per second, derived from the mean. */
  readonly opsPerSecond: number
}

const percentile = (sorted: readonly number[], p: number): number => {
  if (sorted.length === 0) return Number.NaN
  const index = Math.min(sorted.length - 1, Math.max(0, Math.round(p * (sorted.length - 1))))
  return sorted[index] ?? Number.NaN
}

export function summarise(durations: readonly number[]): Stats {
  const sorted = [...durations].sort((a, b) => a - b)
  const total = durations.reduce((sum, d) => sum + d, 0)
  const mean = total / Math.max(1, durations.length)
  return {
    samples: durations.length,
    mean,
    p50: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
    p99: percentile(sorted, 0.99),
    max: sorted[sorted.length - 1] ?? Number.NaN,
    min: sorted[0] ?? Number.NaN,
    opsPerSecond: mean > 0 ? 1000 / mean : Number.POSITIVE_INFINITY,
  }
}

export const collectGarbage = (): void => {
  const gc = (globalThis as { gc?: () => void }).gc
  if (gc !== undefined) gc()
}

/**
 * Times `op` once per sample. Timing each call separately rather than a whole
 * loop is what makes p95, p99 and max meaningful: a single stalled frame is a
 * visible stutter, so the worst case is reported and never discarded.
 */
export function measure(op: (i: number) => void, samples: number, warmup = 5): Stats {
  for (let i = 0; i < warmup; i++) op(i)
  collectGarbage()
  const durations: number[] = new Array(samples)
  for (let i = 0; i < samples; i++) {
    const start = performance.now()
    op(i)
    durations[i] = performance.now() - start
  }
  return summarise(durations)
}

/** Retained heap in bytes after a forced collection. */
export function retainedHeap(): number {
  collectGarbage()
  collectGarbage()
  return process.memoryUsage().heapUsed
}

/**
 * A fixed synthetic workload measured in every run.
 *
 * Absolute timings are meaningless across machines and CI runners vary wildly.
 * Every result is therefore also reported as a ratio against this control, so a
 * reader on different hardware can compare ratios even when milliseconds differ.
 */
export function controlWorkload(): number {
  const op = (): void => {
    let acc = 0
    for (let i = 0; i < 3_000_000; i++) acc = (acc + Math.imul(i, 2654435761)) | 0
    if (acc === 12345) throw new Error('unreachable, defeats dead-code elimination')
  }
  return measure(op, 7, 2).p50
}
