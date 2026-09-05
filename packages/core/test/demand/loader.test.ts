import { describe, expect, test } from 'vitest'
import {
  CoverageStore,
  InMemorySource,
  MapTreeStore,
  MaterializedProjection,
  ViewportLoader,
  approximate,
  computeDemand,
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

/** Root with three children; `a` has five of its own; `c` is a leaf. */
const tree = new MapTreeStore(
  [nodeId('a'), nodeId('b'), nodeId('c')],
  new Map([
    node('a', null, ['a1', 'a2', 'a3', 'a4', 'a5']),
    node('b', null, ['b1']),
    node('c', null, []),
    ...['a1', 'a2', 'a3', 'a4', 'a5'].map((id) => node(id, 'a', [])),
    node('b1', 'b', []),
  ]),
)

interface Rig {
  readonly coverage: CoverageStore
  readonly projection: MaterializedProjection
  readonly source: InMemorySource
  readonly loader: ViewportLoader
}

const rig = (
  options: { pageSize?: number; reportTotal?: boolean; maxPageSize?: number } = {},
): Rig => {
  const coverage = new CoverageStore()
  const projection = new MaterializedProjection(coverage)
  const source = new InMemorySource(tree, {
    reportTotal: options.reportTotal ?? true,
    ...(options.maxPageSize === undefined ? {} : { maxPageSize: options.maxPageSize }),
  })
  const loader = new ViewportLoader(source, coverage, projection, {
    pageSize: options.pageSize ?? 100,
  })
  loader.setViewport({ startIndex: 0, endIndex: 40, overscan: 20 })
  return { coverage, projection, source, loader }
}

const rows = (r: Rig): string[] =>
  r.projection
    .slice(0, approximate(r.projection.count()))
    .map((row) => String(row.kind === 'node' ? row.id : 'ph'))

describe('the first demand', () => {
  test('an empty state wants the roots and nothing else', () => {
    const r = rig()
    expect(r.loader.demand()).toEqual([{ parentId: null, offset: 0, limit: 100 }])
  })

  test('loading satisfies it', async () => {
    const r = rig()
    const report = await r.loader.load()
    expect(report.requested).toBe(1)
    expect(rows(r)).toEqual(['a', 'b', 'c'])
    expect(r.loader.demand()).toEqual([])
  })
})

describe('expanding an unloaded branch', () => {
  test('an expanded branch with no loaded children wants its first page', async () => {
    const r = rig()
    await r.loader.load()
    r.loader.expand(nodeId('a'))
    expect(r.loader.demand()).toEqual([{ parentId: nodeId('a'), offset: 0, limit: 100 }])
    await r.loader.load()
    expect(rows(r)).toEqual(['a', 'a1', 'a2', 'a3', 'a4', 'a5', 'b', 'c'])
  })

  test('an expanded leaf demands nothing, because it has nothing to want', async () => {
    const r = rig()
    await r.loader.load()
    r.loader.expand(nodeId('c'))
    expect(r.loader.demand()).toEqual([])
  })

  test('a branch expanded while its ancestor is collapsed demands nothing', async () => {
    const r = rig()
    await r.loader.load()
    r.loader.expand(nodeId('a'))
    await r.loader.load()
    r.loader.collapse(nodeId('a'))
    // a1..a5 have no rows now, so nothing about them is worth loading.
    expect(r.loader.demand()).toEqual([])
  })
})

describe('expanding something that is not loaded yet', () => {
  test('is recorded rather than thrown, and applies when the node arrives', async () => {
    // The M1 case: restoring saved expansion state before the data exists. The
    // projection would throw, because under D2 an unloaded node is genuinely
    // absent; the loader records the intent instead.
    const r = rig()
    expect(r.coverage.get(nodeId('a'))).toBeUndefined()
    expect(r.loader.expand(nodeId('a'))).toBe(false)
    expect(r.loader.pendingExpansions()).toEqual([nodeId('a')])

    const first = await r.loader.load()
    expect(first.expansionsApplied).toBe(1)
    expect(r.loader.pendingExpansions()).toEqual([])
    expect(r.projection.isExpanded(nodeId('a'))).toBe(true)

    // And the now-expanded branch immediately wants its children.
    await r.loader.load()
    expect(rows(r)).toEqual(['a', 'a1', 'a2', 'a3', 'a4', 'a5', 'b', 'c'])
  })

  test('the projection alone still refuses, which is why the loader holds the intent', () => {
    const r = rig()
    expect(() => r.projection.expand(nodeId('a'))).toThrow(/unknown node/)
  })

  test('collapsing a pending expansion cancels it', async () => {
    const r = rig()
    r.loader.expand(nodeId('a'))
    r.loader.collapse(nodeId('a'))
    expect(r.loader.pendingExpansions()).toEqual([])
    await r.loader.load()
    expect(r.projection.isExpanded(nodeId('a'))).toBe(false)
  })

  test('an id that never arrives stays pending and costs nothing', async () => {
    const r = rig()
    r.loader.expand(nodeId('never'))
    await r.loader.load()
    expect(r.loader.pendingExpansions()).toEqual([nodeId('never')])
    expect(r.loader.demand()).toEqual([])
  })
})

describe('the viewport reaching the end of a loaded prefix', () => {
  test('a window short of the append point demands nothing more', async () => {
    const r = rig({ pageSize: 2 })
    await r.loader.load() // roots: a, b (page size 2)
    r.loader.setViewport({ startIndex: 0, endIndex: 1, overscan: 0 })
    expect(r.loader.demand()).toEqual([])
  })

  test('a window reaching the append point demands the next page', async () => {
    const r = rig({ pageSize: 2 })
    await r.loader.load()
    expect(rows(r)).toEqual(['a', 'b'])
    r.loader.setViewport({ startIndex: 0, endIndex: 2, overscan: 0 })
    expect(r.loader.demand()).toEqual([{ parentId: null, offset: 2, limit: 2 }])
    await r.loader.load()
    expect(rows(r)).toEqual(['a', 'b', 'c'])
  })

  test('overscan alone can pull the next page in', async () => {
    const r = rig({ pageSize: 2 })
    await r.loader.load()
    r.loader.setViewport({ startIndex: 0, endIndex: 1, overscan: 5 })
    expect(r.loader.demand()).toEqual([{ parentId: null, offset: 2, limit: 2 }])
  })

  test('a nested parent pages independently of its siblings', async () => {
    const r = rig({ pageSize: 2 })
    await r.loader.load()
    r.loader.expand(nodeId('a'))
    await r.loader.load() // a1, a2
    r.loader.setViewport({ startIndex: 0, endIndex: 40, overscan: 20 })
    expect(r.loader.demand()).toContainEqual({ parentId: nodeId('a'), offset: 2, limit: 2 })
  })

  test('repeated identical viewport pushes do not change demand', async () => {
    const r = rig({ pageSize: 2 })
    await r.loader.load()
    const viewport: Viewport = { startIndex: 0, endIndex: 2, overscan: 0 }
    r.loader.setViewport(viewport)
    const first = r.loader.demand()
    r.loader.setViewport(viewport)
    r.loader.setViewport(viewport)
    expect(r.loader.demand()).toEqual(first)
  })
})

describe('overlapping demand', () => {
  test('an expansion and a viewport edge in the same round are both requested once', async () => {
    const r = rig({ pageSize: 2 })
    await r.loader.load()
    r.loader.expand(nodeId('a'))
    r.loader.setViewport({ startIndex: 0, endIndex: 2, overscan: 0 })
    const wanted = r.loader.demand()
    expect(wanted).toContainEqual({ parentId: nodeId('a'), offset: 0, limit: 2 })
    expect(wanted).toContainEqual({ parentId: null, offset: 2, limit: 2 })
    const report = await r.loader.load()
    expect(report.requested).toBe(2)
    expect(report.deduplicated).toBe(0)
  })
})

describe('short pages and exhaustion', () => {
  test('a short page is not exhaustion, and the next page is still wanted', async () => {
    // maxPageSize forces the source to return fewer nodes than asked for.
    const r = rig({ pageSize: 10, maxPageSize: 1 })
    await r.loader.load()
    expect(rows(r)).toEqual(['a'])
    expect(r.coverage.isExhausted(null)).toBe(false)
    expect(r.loader.demand()).toEqual([{ parentId: null, offset: 1, limit: 10 }])
  })

  test('once exhausted, nothing beyond the prefix is ever requested again', async () => {
    const r = rig({ pageSize: 10 })
    await r.loader.load()
    expect(r.coverage.isExhausted(null)).toBe(true)
    r.loader.setViewport({ startIndex: 0, endIndex: 1000, overscan: 1000 })
    expect(r.loader.demand()).toEqual([])
    const report = await r.loader.load()
    expect(report.requested).toBe(0)
  })

  test('a source without totals still stops at exhaustion', async () => {
    const r = rig({ pageSize: 2, reportTotal: false })
    await r.loader.load()
    r.loader.setViewport({ startIndex: 0, endIndex: 100, overscan: 10 })
    await r.loader.load()
    expect(r.coverage.isExhausted(null)).toBe(true)
    expect(r.loader.demand()).toEqual([])
  })
})

describe('deduplication', () => {
  test('two concurrent rounds issue each page once', async () => {
    const r = rig()
    const first = r.loader.load()
    const second = r.loader.load()
    const [a, b] = await Promise.all([first, second])
    expect(a.requested + b.requested).toBe(1)
    expect(a.deduplicated + b.deduplicated).toBe(1)
    expect(r.source.requests).toHaveLength(1)
  })

  test('the in-flight set is empty once a round settles', async () => {
    const r = rig()
    const pending = r.loader.load()
    expect(r.loader.inFlight()).toHaveLength(1)
    await pending
    expect(r.loader.inFlight()).toEqual([])
  })

  test('the same page requested in a later round is issued again, since it is no longer in flight', async () => {
    const r = rig({ pageSize: 2 })
    await r.loader.load()
    r.coverage.invalidate(null)
    r.projection.invalidate(null)
    await r.loader.load()
    expect(r.source.requests).toHaveLength(2)
  })
})

describe('cancellation', () => {
  test('abort cancels everything outstanding and clears the in-flight set', async () => {
    const manual = new InMemorySource(tree, { mode: 'manual' })
    const coverage = new CoverageStore()
    const projection = new MaterializedProjection(coverage)
    const loader = new ViewportLoader(manual, coverage, projection, { pageSize: 10 })
    loader.setViewport({ startIndex: 0, endIndex: 10, overscan: 0 })

    const pending = loader.load()
    expect(loader.inFlight()).toHaveLength(1)
    loader.abort()
    await expect(pending).resolves.toMatchObject({ requested: 1 })
    expect(loader.inFlight()).toEqual([])
    expect(coverage.roots).toEqual([])
  })

  test('an aborted round leaves the state untouched and is retryable', async () => {
    const manual = new InMemorySource(tree, { mode: 'manual' })
    const coverage = new CoverageStore()
    const projection = new MaterializedProjection(coverage)
    const loader = new ViewportLoader(manual, coverage, projection, { pageSize: 10 })
    loader.setViewport({ startIndex: 0, endIndex: 10, overscan: 0 })

    const aborted = loader.load()
    loader.abort()
    await aborted
    expect(coverage.roots).toEqual([])

    const retry = loader.load()
    manual.releaseAll()
    await retry
    expect([...coverage.roots]).toEqual([nodeId('a'), nodeId('b'), nodeId('c')])
  })
})

describe('stale publication', () => {
  test('a page in flight across an invalidation cannot land', async () => {
    const manual = new InMemorySource(tree, { mode: 'manual' })
    const coverage = new CoverageStore()
    const projection = new MaterializedProjection(coverage)
    const loader = new ViewportLoader(manual, coverage, projection, { pageSize: 10 })
    loader.setViewport({ startIndex: 0, endIndex: 10, overscan: 0 })

    const inFlight = loader.load()
    coverage.invalidate(null)
    projection.invalidate(null)
    manual.releaseAll()
    const report = await inFlight

    expect(report.outcomes.map((o) => o.kind)).toEqual(['stale'])
    expect(coverage.roots).toEqual([])
    // And demand still wants the page, because nothing was applied.
    expect(loader.demand()).toEqual([{ parentId: null, offset: 0, limit: 10 }])
  })
})

describe('viewport changes after the index space changes', () => {
  test('a viewport pushed against a stale index space simply describes fewer rows', async () => {
    const r = rig({ pageSize: 10 })
    await r.loader.load()
    r.loader.expand(nodeId('a'))
    await r.loader.load()
    expect(approximate(r.projection.count())).toBe(8)

    r.loader.setViewport({ startIndex: 0, endIndex: 8, overscan: 0 })
    r.loader.collapse(nodeId('a'))
    // The index space shrank under a viewport that still names the old range. The
    // engine does not adjust it; the consumer pushes a new one. Nothing breaks.
    expect(approximate(r.projection.count())).toBe(3)
    expect(r.loader.demand()).toEqual([])
  })
})

describe('demand is bounded by visible parents, not by viewport height', () => {
  test('an enormous viewport still asks for one page per parent', async () => {
    const r = rig({ pageSize: 2 })
    // A viewport of zero height first, so only trigger 1 fires and nothing pages
    // to exhaustion before the real assertion. The first version of this test left
    // the default viewport in place, which had already exhausted the roots.
    r.loader.setViewport({ startIndex: 0, endIndex: 0, overscan: 0 })
    await r.loader.load()
    r.loader.expand(nodeId('a'))
    await r.loader.load()
    expect(r.coverage.isExhausted(null)).toBe(false)
    expect(r.coverage.isExhausted(nodeId('a'))).toBe(false)

    r.loader.setViewport({ startIndex: 0, endIndex: 1_000_000, overscan: 1_000_000 })
    const wanted = r.loader.demand()
    // A million rows of viewport, two pageable parents, two requests. Demand is
    // bounded by visible expanded parents, never by viewport height.
    expect(wanted).toHaveLength(2)
    expect(new Set(wanted.map((d) => d.parentId ?? '<roots>')).size).toBe(2)
  })

  test('demand does not enforce the row budget, which is eviction s job', async () => {
    const r = rig({ pageSize: 2 })
    await r.loader.load()
    r.loader.setViewport({ startIndex: 0, endIndex: 1_000_000, overscan: 0 })
    // Nothing here clamps or refuses. An over-budget state stays visible to the
    // layer responsible for fixing it.
    for (let round = 0; round < 5; round++) await r.loader.load()
    expect(r.coverage.isExhausted(null)).toBe(true)
  })
})

describe('computeDemand is pure', () => {
  test('it needs no source, no clock and no promise', () => {
    const coverage = new CoverageStore()
    const projection = new MaterializedProjection(coverage)
    expect(
      computeDemand(coverage, projection, { startIndex: 0, endIndex: 10, overscan: 0 }, 25),
    ).toEqual([{ parentId: null, offset: 0, limit: 25 }])
  })
})
