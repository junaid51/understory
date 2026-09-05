import { describe, expect, test } from 'vitest'
import { SHAPES, generate } from '../../src/corpus.js'
import { Harness, type SettleOrder } from './harness.js'
import { TRACES, TRACE_NAMES, type TraceName } from './traces.js'

/**
 * The M1 interaction suite.
 *
 * It lives in `bench/test` rather than `packages/core/test` for one reason: it
 * needs the five seeded corpus shapes, which are bench infrastructure, and bench
 * already depends on core. Moving the generators into core to satisfy a directory
 * convention would ship benchmark scaffolding in the library.
 */

const NODES = 4_000
const ORDERS: SettleOrder[] = ['inOrder', 'reverse', 'shuffled']

const run = async (
  trace: TraceName,
  shape: (typeof SHAPES)[number],
  order: SettleOrder,
  reportTotal: boolean,
): Promise<string[]> => {
  const truth = generate(shape, { nodes: NODES, seed: 42 })
  const harness = new Harness(truth, { reportTotal, seed: 9 })
  const steps = TRACES[trace]({ truth, order })
  return harness.run(steps)
}

describe.each(TRACE_NAMES)('trace %s', (trace) => {
  describe.each(SHAPES)('shape %s', (shape) => {
    test.each(ORDERS)('order %s, source with totals', async (order) => {
      expect(await run(trace, shape, order, true)).toEqual([])
    })

    test.each(ORDERS)('order %s, source without totals', async (order) => {
      expect(await run(trace, shape, order, false)).toEqual([])
    })
  })
})

describe('N8: out-of-order arrival converges on the in-order state', () => {
  test.each(SHAPES)('%s, every trace, every ordering', async (shape) => {
    for (const trace of TRACE_NAMES) {
      const truth = generate(shape, { nodes: NODES, seed: 42 })
      const reference = new Harness(truth, { seed: 9 })
      expect(await reference.run(TRACES[trace]({ truth, order: 'inOrder' }))).toEqual([])
      const expected = reference.fingerprint()

      for (const order of ['reverse', 'shuffled'] as const) {
        const subject = new Harness(truth, { seed: 9 })
        expect(await subject.run(TRACES[trace]({ truth, order }))).toEqual([])
        expect(subject.fingerprint(), `${trace}/${shape}/${order} diverged`).toBe(expected)
      }
    }
  })
})

describe('N10: evicting a parent and returning reproduces the identical row sequence', () => {
  test.each(SHAPES)('%s', async (shape) => {
    const truth = generate(shape, { nodes: NODES, seed: 42 })
    const harness = new Harness(truth, { seed: 9 })

    harness.request(null, 0, 100)
    await harness.settle('inOrder')
    const branchy = truth.roots
      .filter((id) => (truth.get(id)?.childIds?.length ?? 0) > 0)
      .slice(0, 3)
    for (const id of branchy) {
      harness.projection.expand(id)
      harness.request(id, 0, 100)
      await harness.settle('inOrder')
    }
    const before = harness.fingerprint()
    expect(harness.check()).toEqual([])

    // Discard one parent's coverage entirely, then load it back.
    const victim = branchy[0]
    if (victim === undefined) return
    await harness.apply({ op: 'viewport', start: 100_000, end: 100_040 })
    await harness.apply({ op: 'evict', parentId: victim })
    expect(harness.check()).toEqual([])
    expect(harness.fingerprint()).not.toBe(before)

    harness.request(victim, 0, 100)
    await harness.settle('inOrder')
    expect(harness.check()).toEqual([])
    expect(harness.fingerprint()).toBe(before)
  })

  test('an eviction that skips a page does NOT reproduce the sequence, proving the check bites', async () => {
    const truth = generate('balanced', { nodes: 4_000, seed: 42 })
    const harness = new Harness(truth, { seed: 9 })
    harness.request(null, 0, 100)
    await harness.settle('inOrder')
    const victim = truth.roots.find((id) => (truth.get(id)?.childIds?.length ?? 0) > 1)
    if (victim === undefined) return
    harness.projection.expand(victim)
    harness.request(victim, 0, 100)
    await harness.settle('inOrder')
    const before = harness.fingerprint()

    await harness.apply({ op: 'viewport', start: 100_000, end: 100_040 })
    await harness.apply({ op: 'evict', parentId: victim })
    // Reload only part of what was there.
    harness.request(victim, 0, 1)
    await harness.settle('inOrder')
    expect(harness.fingerprint()).not.toBe(before)
  })
})

describe('latency modes', () => {
  // Timer-driven latency exists for commit 9's benchmarks. No invariant test
  // depends on it, because determinism comes from manual release, not from timing.
  test.each([0, 5, 25])('a real timer at %ims still applies pages correctly', async (latencyMs) => {
    const { InMemorySource, CoverageStore } = await import('@understory/core')
    const truth = generate('balanced', { nodes: 500, seed: 42 })
    const source = new InMemorySource(truth, { mode: 'latency', latencyMs })
    const coverage = new CoverageStore()
    const result = await source.loadChildren({
      parentId: null,
      offset: 0,
      limit: 50,
      signal: new AbortController().signal,
    })
    const outcome = coverage.publish({
      parentId: null,
      offset: 0,
      generation: 0,
      nodes: result.nodes,
      exhausted: result.exhausted,
      ...(result.total === undefined ? {} : { total: result.total }),
    })
    expect(outcome.kind).toBe('applied')
    expect(coverage.roots.length).toBe(Math.min(50, truth.roots.length))
  })
})

describe('rejected publications remain observable and never mutate state', () => {
  test('gap, stale and conflict each leave the fingerprint untouched', async () => {
    const { CoverageStore } = await import('@understory/core')
    const truth = generate('balanced', { nodes: 500, seed: 42 })
    const harness = new Harness(truth, { seed: 9 })
    harness.request(null, 0, 10)
    await harness.settle('inOrder')
    const before = harness.fingerprint()

    const first = truth.roots[0]
    if (first === undefined) return

    const gapped = harness.coverage.publish({
      parentId: null,
      offset: 999,
      generation: harness.coverage.generationOf(null),
      nodes: [{ id: first, hasChildren: false }],
      exhausted: false,
    })
    expect(gapped.kind).toBe('gap')
    expect(harness.fingerprint()).toBe(before)

    const stale = harness.coverage.publish({
      parentId: null,
      offset: 0,
      generation: harness.coverage.generationOf(null) - 1,
      nodes: [],
      exhausted: true,
    })
    expect(stale.kind).toBe('stale')
    expect(harness.fingerprint()).toBe(before)

    const conflicting = harness.coverage.publish({
      parentId: null,
      offset: 0,
      generation: harness.coverage.generationOf(null),
      nodes: [
        { id: first, hasChildren: false },
        { id: first, hasChildren: false },
      ],
      exhausted: false,
    })
    expect(conflicting.kind).toBe('conflict')
    expect(harness.fingerprint()).toBe(before)

    expect(new CoverageStore().roots).toEqual([])
  })
})
