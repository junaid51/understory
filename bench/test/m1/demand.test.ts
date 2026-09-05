import {
  CoverageStore,
  InMemorySource,
  MaterializedProjection,
  ViewportLoader,
  approximate,
  type HierarchySource,
  type LoadChildrenRequest,
  type LoadChildrenResult,
} from '@understory/core'
import { describe, expect, test } from 'vitest'
import { SHAPES, generate } from '../../src/corpus.js'
import { Harness, type SettleOrder } from './harness.js'
import { checkM1Invariants } from './invariants.js'
import { TRACE_NAMES, TRACES, demandDriven } from './traces.js'

const NODES = 4_000
const ORDERS: SettleOrder[] = ['inOrder', 'reverse', 'shuffled']

/**
 * The six traces again, with demand choosing the pages instead of the trace naming
 * them. Same shapes, same orderings, same invariants; the only difference is who
 * decides what to fetch.
 */
describe.each(TRACE_NAMES)('demand-driven trace %s', (trace) => {
  describe.each(SHAPES)('shape %s', (shape) => {
    test.each(ORDERS)('order %s', async (order) => {
      const truth = generate(shape, { nodes: NODES, seed: 42 })
      const harness = new Harness(truth, { useLoader: true, seed: 9, pageSize: 100 })
      const steps = demandDriven(TRACES[trace]({ truth, order }))
      expect(await harness.run(steps)).toEqual([])
    })
  })
})

describe('demand-driven runs converge across arrival orders', () => {
  test.each(SHAPES)('%s', async (shape) => {
    for (const trace of TRACE_NAMES) {
      const truth = generate(shape, { nodes: NODES, seed: 42 })
      const reference = new Harness(truth, { useLoader: true, seed: 9 })
      expect(await reference.run(demandDriven(TRACES[trace]({ truth, order: 'inOrder' })))).toEqual(
        [],
      )
      const expected = reference.fingerprint()

      for (const order of ['reverse', 'shuffled'] as const) {
        const subject = new Harness(truth, { useLoader: true, seed: 9 })
        expect(await subject.run(demandDriven(TRACES[trace]({ truth, order })))).toEqual([])
        expect(subject.fingerprint(), `${trace}/${shape}/${order}`).toBe(expected)
      }
    }
  })
})

/**
 * A source that answers a different question than the one it was asked.
 *
 * Injected here rather than by writing a faulty copy of the loader, which would
 * duplicate production logic and test the copy. The invariants do not know how
 * demand works; they compare state against `truth`, so a page that is internally
 * consistent but wrong is exactly what they exist to catch.
 */
class ShiftedSource implements HierarchySource {
  constructor(
    private readonly inner: HierarchySource,
    private readonly shift: number,
  ) {}

  loadChildren(request: LoadChildrenRequest): Promise<LoadChildrenResult> {
    // The roots are answered honestly, so the trees under test can be reached at
    // all. A first version shifted them too, and with a single-rooted corpus that
    // produced an empty prefix, which is a perfectly valid prefix: the fault did
    // not manifest and N4 correctly stayed silent.
    if (request.parentId === null) return this.inner.loadChildren(request)
    return this.inner.loadChildren({ ...request, offset: request.offset + this.shift })
  }
}

describe('fault injection: a demand defect the invariants can and cannot see', () => {
  test('a page fetched from the wrong offset is caught by N4 against truth', async () => {
    // Demand asks for offset 0; the source answers with children starting at 1.
    // The result is contiguous, uniquely identified and internally consistent, so
    // coverage accepts it. Only `truth` knows the prefix is wrong.
    const truth = generate('balanced', { nodes: 2_000, seed: 42 })
    const coverage = new CoverageStore()
    const projection = new MaterializedProjection(coverage)
    // No totals: with one, coverage rejects the shifted page as a conflict because
    // a short exhausted page contradicts a stated count. That is the store doing
    // its job, and it hides the identity error underneath. Without a total there is
    // nothing arithmetic to catch it, and only `truth` can.
    const loader = new ViewportLoader(
      new ShiftedSource(new InMemorySource(truth, { reportTotal: false }), 1),
      coverage,
      projection,
      { pageSize: 10 },
    )
    loader.setViewport({ startIndex: 0, endIndex: 10, overscan: 0 })
    await loader.load()
    const root = truth.roots[0]
    if (root === undefined) throw new Error('no root')
    loader.expand(root)
    await loader.load()
    expect(coverage.loadedCount(root)).toBeGreaterThan(0)

    const violations = checkM1Invariants({
      coverage,
      projection,
      truth,
      viewport: { start: 0, end: 10, overscan: 0 },
      budget: Number.POSITIVE_INFINITY,
      inFlight: loader.inFlight(),
      evictedThisStep: [],
      previousLoaded: new Map(),
    })
    expect(
      violations.some((v) => v.startsWith('N4')),
      violations.join('; '),
    ).toBe(true)
  })

  test('a demand that never makes progress violates no invariant, which is a real gap', async () => {
    // The mirror image, and the more interesting result. A source shifted the other
    // way makes every page non-contiguous, so coverage refuses each one as a gap
    // and nothing is ever wrong: the prefix stays a valid prefix, counts stay
    // honest, no row is unbacked. The engine simply never progresses.
    //
    // N1 to N10 are safety properties. None of them is a liveness property, so a
    // demand layer that spins forever satisfies all ten. Worth recording as a
    // candidate invariant rather than pretending the suite covers it.
    const truth = generate('balanced', { nodes: 2_000, seed: 42 })
    const coverage = new CoverageStore()
    const projection = new MaterializedProjection(coverage)
    const loader = new ViewportLoader(
      new ShiftedSource(new InMemorySource(truth), 5),
      coverage,
      projection,
      { pageSize: 10 },
    )
    loader.setViewport({ startIndex: 0, endIndex: 10, overscan: 0 })
    await loader.load()
    const stuckRoot = truth.roots[0]
    if (stuckRoot === undefined) throw new Error('no root')
    loader.expand(stuckRoot)
    for (let round = 0; round < 3; round++) await loader.load()

    // The root landed; its children never can, because every page they are offered
    // starts five past where the prefix ends.
    expect(coverage.loadedCount(stuckRoot)).toBe(0)
    expect(approximate(projection.count())).toBe(1)
    const violations = checkM1Invariants({
      coverage,
      projection,
      truth,
      viewport: { start: 0, end: 10, overscan: 0 },
      budget: Number.POSITIVE_INFINITY,
      inFlight: loader.inFlight(),
      evictedThisStep: [],
      previousLoaded: new Map(),
    })
    expect(violations).toEqual([])
    // Demand still wants the page it can never get.
    expect(loader.demand()).toHaveLength(1)
  })

  test('N6 cannot be violated through the loader, because keys are a Map', async () => {
    // Recorded rather than faked. The loader tracks in-flight requests in a Map
    // keyed by request identity, so two identical in-flight requests are not
    // representable and N6 is enforced by the data structure rather than checked at
    // runtime. It fired for real in commit 6 against a harness that issued requests
    // directly, which is the path where it can still bite.
    const truth = generate('balanced', { nodes: 500, seed: 42 })
    const coverage = new CoverageStore()
    const projection = new MaterializedProjection(coverage)
    const loader = new ViewportLoader(new InMemorySource(truth), coverage, projection, {
      pageSize: 10,
    })
    loader.setViewport({ startIndex: 0, endIndex: 10, overscan: 0 })

    const a = loader.load()
    const b = loader.load()
    const [first, second] = await Promise.all([a, b])
    expect(first.requested + second.requested).toBe(1)
    expect(first.deduplicated + second.deduplicated).toBe(1)
    expect(new Set(loader.inFlight()).size).toBe(loader.inFlight().length)
  })
})

/**
 * The same traces once more, with eviction enabled at a budget the traces actually
 * cross. N2 and N3 are inert without it: nothing is ever over budget, so the
 * bounded-row gate and the protected-window gate both pass without being asked
 * anything.
 *
 * Page size and budget are chosen together on purpose. Eviction discards a whole
 * parent's prefix, so a budget smaller than one page of a protected parent cannot
 * be reached at all: the first attempt paired a page size of 100 with a budget of
 * 60, and N2 fired everywhere because a single protected parent's page already
 * exceeded the budget. That is not a defect, it is the granularity of the
 * mechanism, and it means a usable budget must exceed the page size times the
 * number of parents the protected window can span.
 */
describe.each(TRACE_NAMES)('trace %s under eviction pressure', (trace) => {
  test.each(SHAPES)('shape %s', async (shape) => {
    const truth = generate(shape, { nodes: NODES, seed: 42 })
    const harness = new Harness(truth, {
      useLoader: true,
      useEvictor: true,
      budget: 120,
      seed: 9,
      pageSize: 10,
    })
    expect(await harness.run(demandDriven(TRACES[trace]({ truth, order: 'shuffled' })))).toEqual([])
    // Either the bound holds, or eviction reported that it cannot be reached
    // because everything left is protected. See the note in Harness.state().
    expect(harness.rowCount <= 120 || harness.stuck).toBe(true)
  })
})
