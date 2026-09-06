import { readFileSync } from 'node:fs'
import {
  BudgetEvictor,
  CoverageStore,
  InMemorySource,
  MaterializedProjection,
  ViewportLoader,
  approximate,
  type HierarchySource,
  type LoadChildrenRequest,
  type LoadChildrenResult,
  type NodeId,
  type Viewport,
} from '@understory/core'
import { afterEach, describe, expect, test } from 'vitest'
import { generate } from '../../src/corpus.js'
import { checkM1Invariants } from '../../src/m1/invariants.js'

/**
 * The budget under test is the pre-registered one, read from the committed
 * thresholds rather than repeated here. A number typed twice is a number that can
 * disagree with itself.
 */
const thresholds = JSON.parse(readFileSync('bench/thresholds.m1.json', 'utf8')) as {
  budget: { materializedRows: number }
}
const B = thresholds.budget.materializedRows

interface Rig {
  readonly coverage: CoverageStore
  readonly projection: MaterializedProjection
  readonly loader: ViewportLoader
  readonly evictor: BudgetEvictor
}

const rig = (truth: ReturnType<typeof generate>, budget: number, source?: HierarchySource): Rig => {
  const coverage = new CoverageStore()
  const projection = new MaterializedProjection(coverage)
  const loader = new ViewportLoader(source ?? new InMemorySource(truth), coverage, projection, {
    pageSize: 100,
  })
  return {
    coverage,
    projection,
    loader,
    evictor: new BudgetEvictor(coverage, projection, { budget }),
  }
}

const view = (startIndex: number, endIndex: number, overscan = 20): Viewport => ({
  startIndex,
  endIndex,
  overscan,
})

const rowIds = (r: Rig): string[] =>
  r.projection
    .slice(0, approximate(r.projection.count()))
    .map((row) => String(row.kind === 'node' ? row.id : 'ph'))

describe('B is the pre-registered budget', () => {
  test('read from the committed thresholds, not retyped', () => {
    expect(B).toBe(4000)
  })
})

/**
 * N11, liveness: the smallest useful progress property for this system.
 *
 * If demand keeps asking for a reachable contiguous page, the source keeps
 * answering it successfully, and the viewport keeps requiring it, the request must
 * not be permanently stranded as a gap, a stale response or a conflict.
 *
 * Deliberately not a general liveness framework: it is a bounded-round check over
 * the existing deterministic in-memory source, with no timers.
 */
async function assertProgress(loader: ViewportLoader, rounds = 32): Promise<void> {
  for (let round = 0; round < rounds; round++) {
    if (loader.demand().length === 0) return
    await loader.load()
  }
  throw new Error(
    `demand did not settle within ${rounds} rounds; still wants ${JSON.stringify(loader.demand())}`,
  )
}

/** Shifts every non-root request, so answers never line up with the prefix. */
class ShiftedSource implements HierarchySource {
  constructor(
    private readonly inner: HierarchySource,
    private readonly shift: number,
  ) {}
  loadChildren(request: LoadChildrenRequest): Promise<LoadChildrenResult> {
    if (request.parentId === null) return this.inner.loadChildren(request)
    return this.inner.loadChildren({ ...request, offset: request.offset + this.shift })
  }
}

describe('N11 liveness', () => {
  test('a healthy source and a steady viewport always settle', async () => {
    const truth = generate('balanced', { nodes: 2_000, seed: 42 })
    const r = rig(truth, B)
    r.loader.setViewport(view(0, 40))
    await r.loader.load()
    const root = truth.roots[0]
    if (root === undefined) throw new Error('no root')
    r.loader.expand(root)
    await expect(assertProgress(r.loader)).resolves.toBeUndefined()
    expect(r.loader.demand()).toEqual([])
  })

  test('it settles across an eviction, so eviction cannot strand a request', async () => {
    const truth = generate('balanced', { nodes: 2_000, seed: 42 })
    const r = rig(truth, B)
    r.loader.setViewport(view(0, 40))
    await assertProgress(r.loader)
    const root = truth.roots[0]
    if (root === undefined) throw new Error('no root')
    r.loader.expand(root)
    await assertProgress(r.loader)

    r.coverage.invalidate(root)
    r.projection.invalidate(root)
    await expect(assertProgress(r.loader)).resolves.toBeUndefined()
    expect(r.coverage.loadedCount(root)).toBeGreaterThan(0)
  })

  test('it fails when a request is permanently stranded, which is the gap it closes', async () => {
    // The commit 7 finding: every ten safety invariants pass while the engine never
    // progresses. This is the property that sees it.
    const truth = generate('balanced', { nodes: 2_000, seed: 42 })
    // With totals, a shifted short page contradicts the stated count and is refused
    // as a conflict every time, which is what strands it. Without totals it would be
    // accepted and the engine would progress, wrongly but progressing.
    const r = rig(truth, B, new ShiftedSource(new InMemorySource(truth), 5))
    r.loader.setViewport(view(0, 40))
    await r.loader.load()
    const root = truth.roots[0]
    if (root === undefined) throw new Error('no root')
    r.loader.expand(root)
    await expect(assertProgress(r.loader, 8)).rejects.toThrow(/did not settle/)

    // And every safety invariant still passes, which is exactly why N11 is needed.
    expect(
      checkM1Invariants({
        coverage: r.coverage,
        projection: r.projection,
        truth,
        viewport: { start: 0, end: 40, overscan: 20 },
        budget: Number.POSITIVE_INFINITY,
        inFlight: r.loader.inFlight(),
        evictedThisStep: [],
        previousLoaded: new Map(),
      }),
    ).toEqual([])
  })
})

/**
 * W7 accumulate: the only workload that reaches the budget.
 *
 * Added at commit 3 because reachability validation found A1 vacuous: under D2,
 * rows are bounded by pages fetched, so none of W1 to W6 approaches B and the
 * bounded-row gate would have passed untested.
 */
async function accumulate(
  r: Rig,
  truth: ReturnType<typeof generate>,
  rounds: number,
): Promise<{ peakBefore: number; peakAfter: number; evictions: number; sweeps: number }> {
  let peakBefore = 0
  let peakAfter = 0
  let evictions = 0
  let sweeps = 0

  r.loader.setViewport(view(0, 40))
  await r.loader.load()

  const opened = new Set<string>()
  for (let round = 0; round < rounds; round++) {
    // Open every branchy row currently visible that is not already open.
    const rows = r.projection.slice(0, approximate(r.projection.count()))
    let openedThisRound = 0
    for (const row of rows) {
      if (row.kind !== 'node') continue
      if (opened.has(String(row.id))) continue
      if (approximate(r.coverage.get(row.id)?.childCount ?? { kind: 'exact', value: 0 }) === 0)
        continue
      opened.add(String(row.id))
      r.loader.expand(row.id)
      openedThisRound += 1
      if (openedThisRound >= 8) break
    }
    await r.loader.load()

    peakBefore = Math.max(peakBefore, approximate(r.projection.count()))
    const report = r.evictor.sweep(r.loader.getViewport())
    sweeps += 1
    evictions += report.evicted.length
    peakBefore = Math.max(peakBefore, report.rowsBefore)
    peakAfter = Math.max(peakAfter, report.rowsAfter)

    // Walk the viewport down so coverage ages and candidates appear.
    const total = approximate(r.projection.count())
    const start = (round * 200) % Math.max(1, total)
    r.loader.setViewport(view(start, start + 40))
  }
  return { peakBefore, peakAfter, evictions, sweeps }
}

describe('W7 accumulate reaches the budget and eviction holds it', () => {
  test('shallow-wide at 20,000 nodes crosses B and is pulled back', async () => {
    const truth = generate('shallow-wide', { nodes: 20_000, seed: 42 })
    const r = rig(truth, B)
    const stats = await accumulate(r, truth, 40)

    console.log('\nW7 accumulate:', JSON.stringify({ B, ...stats }, null, 2))

    expect(
      stats.peakBefore,
      'W7 never reached the budget, so A1 would be untested',
    ).toBeGreaterThan(B)
    expect(stats.evictions, 'W7 crossed the budget without eviction firing').toBeGreaterThan(0)
    expect(stats.peakAfter, 'eviction failed to restore the bound').toBeLessThanOrEqual(B)
  })

  test('every sweep leaves the protected window intact', async () => {
    const truth = generate('shallow-wide', { nodes: 20_000, seed: 42 })
    const r = rig(truth, B)
    r.loader.setViewport(view(0, 40))
    await r.loader.load()

    for (let round = 0; round < 20; round++) {
      const rows = r.projection.slice(0, approximate(r.projection.count()))
      for (const row of rows.slice(0, 8)) {
        if (row.kind === 'node') r.loader.expand(row.id)
      }
      await r.loader.load()
      const viewport = r.loader.getViewport()
      const shielded = new Set(r.evictor.protectedNow(viewport))
      const report = r.evictor.sweep(viewport)
      for (const evicted of report.evicted) {
        expect(shielded.has(evicted), `evicted ${String(evicted)} while protected`).toBe(false)
      }
    }
  })
})

/**
 * Fault injection.
 *
 * Faults are injected by patching the prototype rather than by writing a faulty
 * copy of the evictor, and each is caught by a property that does not know the
 * eviction algorithm.
 */
type Patchable = Record<string, unknown>
const proto = BudgetEvictor.prototype as unknown as Patchable
const originals = new Map<string, unknown>()
const patch = (name: string, replacement: unknown): void => {
  if (!originals.has(name)) originals.set(name, proto[name])
  proto[name] = replacement
}
afterEach(() => {
  for (const [name, value] of originals) proto[name] = value
  originals.clear()
})

/**
 * A state that is genuinely over budget with candidates outside the window.
 *
 * The first version opened one level of a balanced corpus, reached ten rows against
 * a budget of twelve, and every fault below passed because nothing was ever
 * evicted. A fault fixture that cannot trigger the mechanism tests nothing.
 */
const seeded = async (): Promise<{ r: Rig; truth: ReturnType<typeof generate> }> => {
  const truth = generate('shallow-wide', { nodes: 2_000, seed: 42 })
  const r = rig(truth, 12)
  r.loader.setViewport(view(0, 2, 0))
  await r.loader.load()

  const root = truth.roots[0]
  if (root === undefined) throw new Error('no root')
  r.loader.expand(root)
  await r.loader.load()

  // Open several children too, so there are parents the window does not protect.
  const children = r.coverage.get(root)?.childIds ?? []
  for (const child of children.slice(0, 5)) r.loader.expand(child)
  await r.loader.load()

  expect(approximate(r.projection.count())).toBeGreaterThan(12)
  return { r, truth }
}

describe('fault injection: eviction defects', () => {
  test('evicting a protected parent is caught by N3', async () => {
    const { r, truth } = await seeded()
    const viewport = view(0, 2, 0)
    patch('candidates', function all(this: Patchable, v: Viewport): readonly (NodeId | null)[] {
      // Protection ignored entirely.
      const loaded: (NodeId | null)[] = []
      const coverage = this['coverage'] as CoverageStore
      if (coverage.loadedCount(null) > 0) loaded.push(null)
      for (const [id] of coverage.entries()) if (coverage.loadedCount(id) > 0) loaded.push(id)
      void v
      return loaded
    })
    const shielded = new Set(r.evictor.protectedNow(viewport))
    const report = r.evictor.sweep(viewport)
    const evictedProtected = report.evicted.filter((id) => shielded.has(id))
    expect(evictedProtected.length).toBeGreaterThan(0)

    const violations = checkM1Invariants({
      coverage: r.coverage,
      projection: r.projection,
      truth,
      viewport: { start: 0, end: 2, overscan: 0 },
      budget: Number.POSITIVE_INFINITY,
      inFlight: [],
      evictedThisStep: evictedProtected.filter((id): id is NodeId => id !== null),
      previousLoaded: new Map(),
    })
    // N3 only fires for a parent whose rows are still present; when the roots are
    // discarded there are none left, so the check that bites is the row-level one.
    expect(
      violations.some((v) => v.startsWith('N3')) || approximate(r.projection.count()) === 0,
    ).toBe(true)
  })

  test('losing expansion during eviction is caught by the reload property', async () => {
    const { r } = await seeded()
    const before = rowIds(r)
    const original = proto['sweep'] as (v: Viewport) => { evicted: (NodeId | null)[] }
    patch('sweep', function collapsing(this: Patchable, v: Viewport) {
      const report = original.call(this, v)
      const projection = this['projection'] as MaterializedProjection
      for (const id of report.evicted) if (id !== null) projection.collapse(id)
      return report
    })
    r.evictor.sweep(view(0, 2, 0))
    r.loader.setViewport(view(0, 200, 0))
    for (let round = 0; round < 8; round++) await r.loader.load()
    // N10's property: returning must reproduce the sequence. It does not.
    expect(rowIds(r)).not.toEqual(before)
  })

  test('keeping children after eviction is caught by the bounded-row property', async () => {
    const { r } = await seeded()
    const original = proto['sweep'] as (v: Viewport) => {
      evicted: (NodeId | null)[]
      rowsAfter: number
    }
    patch('sweep', function projectionOnly(this: Patchable, v: Viewport) {
      // Discards the projection's view but leaves coverage holding the children.
      const coverage = this['coverage'] as CoverageStore
      const real = coverage.invalidate.bind(coverage)
      ;(coverage as unknown as Patchable)['invalidate'] = (): void => {}
      try {
        return original.call(this, v)
      } finally {
        ;(coverage as unknown as Patchable)['invalidate'] = real
      }
    })
    const report = r.evictor.sweep(view(0, 2, 0))
    expect(report.rowsAfter).toBeGreaterThan(12)
    expect(report.stuck).toBe(true)
  })

  test('a wrong LRU choice is caught without knowing the algorithm', async () => {
    // The property is about the ORDER, not about which victim was chosen: candidate
    // marks must be non-decreasing. Stated over the choice instead it could not
    // fire, because in a freshly built state every candidate carries mark zero and
    // reversing a list of equal marks changes nothing observable.
    const truth = generate('shallow-wide', { nodes: 2_000, seed: 42 })
    const r = rig(truth, Number.POSITIVE_INFINITY)
    r.loader.setViewport(view(0, 200, 0))
    await r.loader.load()
    const root = truth.roots[0]
    if (root === undefined) throw new Error('no root')
    r.loader.expand(root)
    await r.loader.load()
    const children = r.coverage.get(root)?.childIds ?? []
    for (const child of children.slice(0, 4)) r.loader.expand(child)
    await r.loader.load()

    // Distinct marks: each sweep protects a different subtree.
    for (const start of [1, 120, 240, 360]) r.evictor.sweep(view(start, start + 2, 0))

    const nonDecreasing = (order: readonly (NodeId | null)[]): boolean => {
      const marks = order.map((id) => r.evictor.lastTouchedAt(id))
      return marks.every((mark, index) => index === 0 || mark >= (marks[index - 1] ?? 0))
    }

    const viewport = view(1, 3, 0)
    const distinct = new Set(
      r.evictor.candidates(viewport).map((id) => r.evictor.lastTouchedAt(id)),
    )
    expect(distinct.size, 'the fixture produced no distinct marks to order').toBeGreaterThan(1)
    expect(nonDecreasing(r.evictor.candidates(viewport))).toBe(true)

    const original = proto['candidates'] as (v: Viewport) => readonly (NodeId | null)[]
    patch('candidates', function reversed(this: Patchable, v: Viewport) {
      return [...original.call(this, v)].reverse()
    })
    expect(nonDecreasing(r.evictor.candidates(viewport))).toBe(false)
  })

  test('doing nothing at all is caught by the bounded-row property', async () => {
    const { r } = await seeded()
    patch('sweep', function inert() {
      return {
        evicted: [],
        rowsBefore: 0,
        rowsAfter: 0,
        budget: 12,
        protectedParents: 0,
        stuck: false,
      }
    })
    r.evictor.sweep(view(0, 2, 0))
    expect(approximate(r.projection.count())).toBeGreaterThan(12)
  })
})
