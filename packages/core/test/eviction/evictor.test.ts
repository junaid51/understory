import { describe, expect, test } from 'vitest'
import {
  BudgetEvictor,
  CoverageStore,
  InMemorySource,
  MapTreeStore,
  MaterializedProjection,
  ViewportLoader,
  approximate,
  atLeast,
  exact,
  nodeId,
  orderKey,
  type NodeId,
  type NodeRecord,
  type Viewport,
} from '../../src/index.js'

const node = (id: string, parentId: string | null, children: string[]): [NodeId, NodeRecord] => [
  nodeId(id),
  {
    id: nodeId(id),
    parentId: parentId === null ? null : nodeId(parentId),
    orderKey: orderKey(id),
    childIds: children.map(nodeId),
    childCount: exact(children.length),
  },
]

/** Four roots, each with four children, and one grandchild under a1. */
const tree = new MapTreeStore(
  [nodeId('a'), nodeId('b'), nodeId('c'), nodeId('d')],
  new Map([
    node('a', null, ['a1', 'a2', 'a3', 'a4']),
    node('b', null, ['b1', 'b2', 'b3', 'b4']),
    node('c', null, ['c1', 'c2', 'c3', 'c4']),
    node('d', null, ['d1', 'd2', 'd3', 'd4']),
    node('a1', 'a', ['a1x']),
    node('a1x', 'a1', []),
    ...['a2', 'a3', 'a4'].map((id) => node(id, 'a', [])),
    ...['b1', 'b2', 'b3', 'b4'].map((id) => node(id, 'b', [])),
    ...['c1', 'c2', 'c3', 'c4'].map((id) => node(id, 'c', [])),
    ...['d1', 'd2', 'd3', 'd4'].map((id) => node(id, 'd', [])),
  ]),
)

interface Rig {
  readonly coverage: CoverageStore
  readonly projection: MaterializedProjection
  readonly loader: ViewportLoader
  readonly evictor: BudgetEvictor
  readonly source: InMemorySource
}

const rig = (
  budget: number,
  options: { reportTotal?: boolean; maxPageSize?: number } = {},
): Rig => {
  const coverage = new CoverageStore()
  const projection = new MaterializedProjection(coverage)
  const source = new InMemorySource(tree, {
    reportTotal: options.reportTotal ?? true,
    ...(options.maxPageSize === undefined ? {} : { maxPageSize: options.maxPageSize }),
  })
  const loader = new ViewportLoader(source, coverage, projection, { pageSize: 100 })
  return {
    coverage,
    projection,
    loader,
    evictor: new BudgetEvictor(coverage, projection, { budget }),
    source,
  }
}

const view = (startIndex: number, endIndex: number, overscan = 0): Viewport => ({
  startIndex,
  endIndex,
  overscan,
})

const rows = (r: Rig): string[] =>
  r.projection
    .slice(0, approximate(r.projection.count()))
    .map((row) => String(row.kind === 'node' ? row.id : 'ph'))

/** Opens every root so there is something to evict. */
const openAll = async (r: Rig): Promise<void> => {
  r.loader.setViewport(view(0, 100, 0))
  await r.loader.load()
  for (const id of ['a', 'b', 'c', 'd']) r.loader.expand(nodeId(id))
  await r.loader.load()
}

/**
 * Marks have to be laid down while the state is still under budget, or the
 * marking sweeps evict as they go and the layout the assertion depends on is
 * gone before it runs. That confounded the first version of these two tests.
 */
const markThenCross = async (): Promise<Rig> => {
  const r = rig(13)
  r.loader.setViewport(view(0, 100))
  await r.loader.load() // 4 roots
  r.loader.expand(nodeId('a'))
  await r.loader.load() // 8 rows
  r.evictor.sweep(view(1, 2)) // marks a, under budget
  r.loader.expand(nodeId('b'))
  await r.loader.load() // 12 rows
  r.evictor.sweep(view(6, 7)) // marks b, still under budget
  r.loader.expand(nodeId('c'))
  await r.loader.load() // 16 rows, now over
  return r
}

describe('protection', () => {
  test('every ancestor of an in-window row is protected', async () => {
    const r = rig(1000)
    await openAll(r)
    r.loader.expand(nodeId('a1'))
    await r.loader.load()
    // rows: a a1 a1x a2 a3 a4 b ...
    const shielded = r.evictor.protectedNow(view(1, 3))
    expect(shielded).toContain(null)
    expect(shielded).toContain(nodeId('a'))
    expect(shielded).toContain(nodeId('a1'))
    expect(shielded).not.toContain(nodeId('b'))
  })

  test('a parent on screen is not protected by its own row', async () => {
    // Discarding a's children removes rows below a, all of which are outside the
    // window. a itself belongs to the roots' prefix and is untouched.
    const r = rig(1000)
    await openAll(r)
    const shielded = r.evictor.protectedNow(view(0, 1))
    expect(shielded).toContain(null)
    expect(shielded).not.toContain(nodeId('a'))
  })

  test('nothing visible means nothing is protected, roots included', async () => {
    const r = rig(1000)
    await openAll(r)
    expect(r.evictor.protectedNow(view(10_000, 10_040))).toEqual([])
  })
})

describe('eviction under budget', () => {
  test('under budget, nothing is discarded', async () => {
    const r = rig(1000)
    await openAll(r)
    const before = rows(r)
    const report = r.evictor.sweep(view(0, 40))
    expect(report.evicted).toEqual([])
    expect(rows(r)).toEqual(before)
  })

  test('the eviction order is oldest mark first, asserted directly', async () => {
    const r = rig(1000)
    await openAll(r)
    // Touch b, then c, then d. `a` is never in a window and stays unmarked.
    r.evictor.sweep(view(6, 7))
    r.evictor.sweep(view(11, 12))
    r.evictor.sweep(view(16, 17))

    expect(r.evictor.lastTouchedAt(nodeId('a'))).toBe(0)
    const order = r.evictor.candidates(view(16, 17))
    // `a` first because it was never touched, then b, c; d is protected.
    expect(order[0]).toBe(nodeId('a'))
    expect(order).not.toContain(nodeId('d'))
    expect(order.indexOf(nodeId('b'))).toBeLessThan(order.indexOf(nodeId('c')))
  })

  test('the oldest candidate is the one actually discarded', async () => {
    const r = await markThenCross()
    const order = r.evictor.candidates(view(11, 12))
    expect(order).toEqual([nodeId('a'), nodeId('b')])
    const report = r.evictor.sweep(view(11, 12))
    expect(report.evicted).toEqual([nodeId('a')])
    expect(report.rowsAfter).toBeLessThanOrEqual(13)
  })

  test('discarding a parent removes exactly its subtree and preserves it as openable', async () => {
    // Budget 4 is below what the protected window itself needs: view(0,2) protects
    // the roots and `a`, whose rows alone are 4 roots plus a's 4 children. Eviction
    // clears everything it may and then reports `stuck`, which is correct, so the
    // assertion is about the state of what was discarded, not about reaching 4.
    const r = rig(4)
    await openAll(r)
    r.loader.setViewport(view(0, 2))
    const report = r.evictor.sweep(view(0, 2))
    expect(report.evicted).toEqual([nodeId('b'), nodeId('c'), nodeId('d')])
    expect(report.stuck).toBe(true)

    for (const id of report.evicted) {
      if (id === null) continue
      // D2 after eviction: an empty prefix, no exhaustion claim, still openable.
      expect(r.coverage.loadedCount(id)).toBe(0)
      expect(r.coverage.isExhausted(id)).toBe(false)
      expect(r.coverage.get(id)?.childIds).toEqual([])
      // hasChildren survives, or the branch could never be reopened.
      expect(r.coverage.get(id)?.childCount).toEqual(atLeast(1))
    }
  })

  test('expansion state survives eviction', async () => {
    const r = rig(4)
    await openAll(r)
    r.evictor.sweep(view(0, 2))
    for (const id of ['a', 'b', 'c', 'd']) {
      expect(r.projection.isExpanded(nodeId(id))).toBe(true)
    }
  })

  test('no placeholder row ever appears', async () => {
    const r = rig(4)
    await openAll(r)
    r.evictor.sweep(view(0, 2))
    expect(
      r.projection.slice(0, approximate(r.projection.count())).every((row) => row.kind === 'node'),
    ).toBe(true)
  })

  test('a protected parent is never discarded, even when that leaves rows over budget', async () => {
    const r = rig(1)
    await openAll(r)
    const total = approximate(r.projection.count())
    const report = r.evictor.sweep(view(0, total)) // everything protected
    expect(report.evicted).toEqual([])
    expect(report.stuck).toBe(true)
    expect(report.rowsAfter).toBe(total)
  })

  test('being stuck is reported rather than tolerated silently', async () => {
    const r = rig(1)
    await openAll(r)
    expect(r.evictor.sweep(view(0, 1000)).stuck).toBe(true)
    // Move the window away and the same budget is now satisfiable.
    expect(r.evictor.sweep(view(10_000, 10_040)).stuck).toBe(false)
  })
})

describe('deterministic LRU', () => {
  test('marks are unique, so ties cannot arise', async () => {
    const r = rig(1000)
    await openAll(r)
    r.evictor.sweep(view(0, 100))
    const marks = ['a', 'b', 'c', 'd'].map((id) => r.evictor.lastTouchedAt(nodeId(id)))
    expect(new Set(marks).size).toBe(marks.length)
  })

  test('within one sweep, the earlier row carries the older mark', async () => {
    const r = rig(1000)
    await openAll(r)
    r.evictor.sweep(view(0, 100))
    expect(r.evictor.lastTouchedAt(nodeId('a'))).toBeLessThan(r.evictor.lastTouchedAt(nodeId('b')))
    expect(r.evictor.lastTouchedAt(nodeId('b'))).toBeLessThan(r.evictor.lastTouchedAt(nodeId('c')))
  })

  test('the same sequence of viewports always evicts the same parents', async () => {
    const run = async (): Promise<readonly (NodeId | null)[]> => {
      const r = await markThenCross()
      return r.evictor.sweep(view(11, 12)).evicted
    }
    const first = await run()
    expect(first.length).toBeGreaterThan(0)
    expect(await run()).toEqual(first)
  })

  test('a parent evicted and reloaded does not inherit its old position', async () => {
    const r = rig(1000)
    await openAll(r)
    r.evictor.sweep(view(0, 100))
    expect(r.evictor.lastTouchedAt(nodeId('a'))).toBeGreaterThan(0)
    r.coverage.invalidate(nodeId('a'))
    r.projection.invalidate(nodeId('a'))
    // Pruning keys on loaded count, not on record absence: `invalidate` keeps the
    // parent and discards its children, so a record check never fired.
    r.evictor.sweep(view(10_000, 10_040))
    expect(r.evictor.lastTouchedAt(nodeId('a'))).toBe(0)
  })
})

describe('eviction and reload reproduce the same rows', () => {
  test('N10: return the viewport, reload, identical sequence', async () => {
    const r = rig(1000)
    await openAll(r)
    const before = rows(r)

    // A window over the roots only, so the roots survive and their children go.
    r.loader.setViewport(view(0, 1))
    const report = new BudgetEvictor(r.coverage, r.projection, { budget: 4 }).sweep(view(0, 1))
    expect(report.evicted).toEqual([nodeId('a'), nodeId('b'), nodeId('c'), nodeId('d')])
    expect(rows(r)).toEqual(['a', 'b', 'c', 'd'])
    expect(rows(r)).not.toEqual(before)

    r.loader.setViewport(view(0, 100))
    for (let round = 0; round < 6; round++) await r.loader.load()
    expect(rows(r)).toEqual(before)
  })

  test('a branch reopens automatically because expansion outlived its data', async () => {
    const r = rig(1000)
    await openAll(r)
    r.loader.expand(nodeId('a1'))
    await r.loader.load()
    const before = rows(r)
    expect(before).toContain('a1x')

    new BudgetEvictor(r.coverage, r.projection, { budget: 4 }).sweep(view(0, 1))
    expect(rows(r)).not.toContain('a1x')
    expect(r.projection.isExpanded(nodeId('a1'))).toBe(true)

    r.loader.setViewport(view(0, 100))
    for (let round = 0; round < 6; round++) await r.loader.load()
    expect(rows(r)).toEqual(before)
  })
})

describe('edge cases', () => {
  test('only one parent exists and it is protected', async () => {
    const r = rig(1)
    r.loader.setViewport(view(0, 40))
    await r.loader.load()
    expect(r.evictor.sweep(view(0, 40)).stuck).toBe(true)
  })

  test('an exhausted parent still evicts, and its exhaustion claim is dropped', async () => {
    const r = rig(1000)
    await openAll(r)
    expect(r.coverage.isExhausted(nodeId('a'))).toBe(true)
    new BudgetEvictor(r.coverage, r.projection, { budget: 4 }).sweep(view(0, 1))
    expect(r.coverage.isExhausted(nodeId('a'))).toBe(false)
    expect(r.coverage.totalOf(nodeId('a'))).toBeUndefined()
  })

  test('a source without totals behaves identically', async () => {
    const r = rig(4, { reportTotal: false })
    await openAll(r)
    const report = r.evictor.sweep(view(0, 1))
    expect(report.evicted).toEqual([nodeId('a'), nodeId('b'), nodeId('c'), nodeId('d')])
    expect(report.rowsAfter).toBe(4)
  })

  test('short pages leave a valid prefix after eviction and reload', async () => {
    const r = rig(1000, { maxPageSize: 2 })
    r.loader.setViewport(view(0, 100))
    for (let round = 0; round < 6; round++) await r.loader.load()
    const before = rows(r)
    new BudgetEvictor(r.coverage, r.projection, { budget: 2 }).sweep(view(0, 1))
    r.loader.setViewport(view(0, 100))
    for (let round = 0; round < 12; round++) await r.loader.load()
    expect(rows(r)).toEqual(before)
  })

  test('evicting an ancestor removes its descendants coverage too', async () => {
    const r = rig(1000)
    await openAll(r)
    r.loader.expand(nodeId('a1'))
    await r.loader.load()
    expect(r.coverage.get(nodeId('a1x'))).toBeDefined()
    new BudgetEvictor(r.coverage, r.projection, { budget: 4 }).sweep(view(0, 1))
    expect(r.coverage.get(nodeId('a1'))).toBeUndefined()
    expect(r.coverage.get(nodeId('a1x'))).toBeUndefined()
  })

  test('demand and eviction in the same step settle at the budget', async () => {
    // A one-row window, so only the roots are protected and every branch is a
    // candidate. Demand keeps opening; eviction keeps closing; the loop is stable.
    const r = rig(9)
    r.loader.setViewport(view(0, 1))
    await r.loader.load()
    for (const id of ['a', 'b', 'c', 'd']) r.loader.expand(nodeId(id))
    for (let round = 0; round < 8; round++) {
      await r.loader.load()
      r.evictor.sweep(view(0, 1))
    }
    expect(approximate(r.projection.count())).toBeLessThanOrEqual(9)
  })

  test('a viewport that would push rows past the budget is held at it', async () => {
    const r = rig(9)
    r.loader.setViewport(view(0, 1))
    await r.loader.load()
    for (const id of ['a', 'b', 'c', 'd']) r.loader.expand(nodeId(id))
    let peak = 0
    for (let round = 0; round < 8; round++) {
      await r.loader.load()
      const report = r.evictor.sweep(view(0, 1))
      peak = Math.max(peak, report.rowsAfter)
    }
    expect(peak).toBeLessThanOrEqual(9)
  })
})

describe('in-flight work crossing an eviction', () => {
  test('a page in flight when its parent is evicted cannot land', async () => {
    const manual = new InMemorySource(tree, { mode: 'manual' })
    const coverage = new CoverageStore()
    const projection = new MaterializedProjection(coverage)
    const loader = new ViewportLoader(manual, coverage, projection, { pageSize: 100 })
    loader.setViewport(view(0, 100))

    const first = loader.load()
    manual.releaseAll()
    await first
    loader.expand(nodeId('a'))

    const second = loader.load()
    // Evict while a's page is in flight. The generation moves underneath it.
    coverage.invalidate(nodeId('a'))
    projection.invalidate(nodeId('a'))
    manual.releaseAll()
    const report = await second

    expect(report.outcomes.map((o) => o.kind)).toEqual(['stale'])
    expect(coverage.loadedCount(nodeId('a'))).toBe(0)
    // And demand still wants it, so nothing is stranded.
    expect(loader.demand()).toContainEqual({ parentId: nodeId('a'), offset: 0, limit: 100 })
  })
})

describe('the granularity constraint', () => {
  test('a budget below one page of a protected parent cannot be reached', async () => {
    // Eviction discards a whole parent's prefix; it cannot trim one. So a budget
    // smaller than the rows a single protected parent holds is unreachable, and the
    // evictor says so rather than thrashing. Found by running the interaction traces
    // with a page size of 100 against a budget of 60.
    const r = rig(3)
    await openAll(r)
    // view(0,2) protects the roots and `a`, whose four children alone exceed 3.
    const report = r.evictor.sweep(view(0, 2))
    expect(report.stuck).toBe(true)
    expect(report.rowsAfter).toBeGreaterThan(3)
    // A budget above that granularity is reachable on the same state.
    expect(new BudgetEvictor(r.coverage, r.projection, { budget: 8 }).sweep(view(0, 2)).stuck).toBe(
      false,
    )
  })
})

describe('a sweep never discards what was on screen when it started', () => {
  /**
   * The defect commit 9's benchmark found, reduced to one state.
   *
   * Protection used to be recomputed from scratch on every iteration of the sweep
   * loop. Discarding a parent removes rows and everything below moves up, so a row
   * that was inside the index window at the start of the sweep can fall out of it
   * mid-sweep, at which point its ancestor becomes an ordinary eviction candidate.
   * The sweep then discards exactly what the reader was looking at, one eviction
   * after deciding it was protected.
   *
   * Three interaction traces on two corpus shapes reproduced it as soon as N3 was
   * restated as row survival rather than as a statement about ancestors.
   */
  test('rows visible before the sweep are still rows after it', async () => {
    const r = rig(6)
    await openAll(r)
    // A window low in the index space, so earlier evictions shift its contents.
    const viewport = view(10, 14)
    const before = new Set(
      r.projection
        .slice(0, approximate(r.projection.count()))
        .filter((row) => row.index >= 10 && row.index < 14)
        .map((row) => (row.kind === 'node' ? `n:${row.id}` : `p:${row.parentId}:${row.slot}`)),
    )
    expect(before.size).toBeGreaterThan(0)

    r.evictor.sweep(viewport)

    const after = new Set(
      r.projection
        .slice(0, approximate(r.projection.count()))
        .map((row) => (row.kind === 'node' ? `n:${row.id}` : `p:${row.parentId}:${row.slot}`)),
    )
    for (const key of before) expect([...after], `${key} was evicted`).toContain(key)
  })

  test('holding protection across a sweep can leave it stuck, and it says so', async () => {
    // The cost of the fix, asserted rather than left implicit. Refusing to discard
    // what a sweep has already protected means a sweep can fail to reach the budget
    // where a more aggressive one would have succeeded. That is the intended trade:
    // an over-budget state is visible through `stuck`, a destroyed viewport is not.
    const r = rig(2)
    await openAll(r)
    const report = r.evictor.sweep(view(0, 20))
    expect(report.stuck).toBe(true)
    expect(report.rowsAfter).toBeGreaterThan(2)
  })
})
