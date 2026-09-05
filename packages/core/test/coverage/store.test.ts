import { describe, expect, test } from 'vitest'
import {
  CoverageStore,
  MaterializedProjection,
  OracleProjection,
  approximate,
  atLeast,
  exact,
  nodeId,
  rowCountEstimate,
  rowKey,
  type NodeId,
  type PagePublication,
  type SourceNode,
} from '../../src/index.js'

const src = (id: string, hasChildren = false): SourceNode => ({ id: nodeId(id), hasChildren })

const page = (over: Partial<PagePublication> = {}): PagePublication => ({
  parentId: null,
  offset: 0,
  generation: 0,
  nodes: [],
  exhausted: false,
  ...over,
})

const ids = (store: CoverageStore, parentId: NodeId | null): string[] =>
  parentId === null
    ? [...store.roots]
    : [...(store.get(parentId)?.childIds ?? [])].map((id) => String(id))

describe('the loaded prefix', () => {
  test('a first page becomes the prefix, in source order', () => {
    const store = new CoverageStore()
    expect(store.publish(page({ nodes: [src('a'), src('b')] }))).toEqual({
      kind: 'applied',
      added: 2,
    })
    expect(store.roots).toEqual([nodeId('a'), nodeId('b')])
  })

  test('contiguous pages produce exactly one prefix, never two ranges', () => {
    const store = new CoverageStore()
    store.publish(page({ nodes: [src('a'), src('b')] }))
    store.publish(page({ offset: 2, nodes: [src('c')] }))
    store.publish(page({ offset: 3, nodes: [src('d')], exhausted: true }))
    expect(ids(store, null)).toEqual(['a', 'b', 'c', 'd'])
    expect(store.loadedCount(null)).toBe(4)
    expect(store.isExhausted(null)).toBe(true)
  })

  test('order is preserved exactly and never sorted', () => {
    const store = new CoverageStore()
    store.publish(page({ nodes: [src('z'), src('m'), src('a')] }))
    expect(ids(store, null)).toEqual(['z', 'm', 'a'])
  })

  test('children hang off their parent, addressed by id', () => {
    const store = new CoverageStore()
    store.publish(page({ nodes: [src('a', true)], exhausted: true }))
    store.publish(page({ parentId: nodeId('a'), nodes: [src('a1')], exhausted: true }))
    expect(ids(store, nodeId('a'))).toEqual(['a1'])
    expect(store.get(nodeId('a1'))?.parentId).toBe(nodeId('a'))
  })

  test('an unopened parent reports an empty child list, never undefined', () => {
    // This is what keeps placeholder rows out of the M0 projection: it emits them
    // only for childIds === undefined, and under D2 that state never reaches it.
    const store = new CoverageStore()
    store.publish(page({ nodes: [src('a', true)], exhausted: true }))
    expect(store.get(nodeId('a'))?.childIds).toEqual([])
  })
})

describe('gaps are refused, never tracked', () => {
  test('a page beyond the prefix is rejected and changes nothing', () => {
    const store = new CoverageStore()
    store.publish(page({ nodes: [src('a')] }))
    const outcome = store.publish(page({ offset: 5, nodes: [src('f')] }))
    expect(outcome).toEqual({ kind: 'gap', prefixLength: 1, offset: 5 })
    expect(ids(store, null)).toEqual(['a'])
  })

  test('a refused gap creates no addressable rows in the gap', () => {
    const store = new CoverageStore()
    store.publish(page({ nodes: [src('a')] }))
    store.publish(page({ offset: 5, nodes: [src('f')] }))
    const projection = new MaterializedProjection(store)
    expect(approximate(projection.count())).toBe(1)
    expect(store.get(nodeId('f'))).toBeUndefined()
  })

  test('the gapped page applies once its predecessor lands', () => {
    const store = new CoverageStore()
    store.publish(page({ nodes: [src('a')] }))
    expect(store.publish(page({ offset: 2, nodes: [src('c')] })).kind).toBe('gap')
    store.publish(page({ offset: 1, nodes: [src('b')] }))
    expect(store.publish(page({ offset: 2, nodes: [src('c')] })).kind).toBe('applied')
    expect(ids(store, null)).toEqual(['a', 'b', 'c'])
  })
})

describe('repeats and conflicts', () => {
  test('an identical repeat is idempotent', () => {
    const store = new CoverageStore()
    store.publish(page({ nodes: [src('a'), src('b')] }))
    expect(store.publish(page({ nodes: [src('a'), src('b')] }))).toEqual({ kind: 'duplicate' })
    expect(ids(store, null)).toEqual(['a', 'b'])
  })

  test('a repeat that disagrees is a conflict, not a silent overwrite', () => {
    const store = new CoverageStore()
    store.publish(page({ nodes: [src('a'), src('b')] }))
    const outcome = store.publish(page({ nodes: [src('a'), src('x')] }))
    expect(outcome.kind).toBe('conflict')
    expect(ids(store, null)).toEqual(['a', 'b'])
  })

  test('a page containing the same id twice is refused', () => {
    const store = new CoverageStore()
    expect(store.publish(page({ nodes: [src('a'), src('a')] })).kind).toBe('conflict')
    expect(store.roots).toEqual([])
  })

  test('a node already loaded elsewhere is refused', () => {
    // Uniqueness is the projection's invariant I4, and this store is the only
    // place that can see the violation coming.
    const store = new CoverageStore()
    store.publish(page({ nodes: [src('a', true)], exhausted: true }))
    const outcome = store.publish(page({ parentId: nodeId('a'), nodes: [src('a')] }))
    expect(outcome.kind).toBe('conflict')
  })
})

describe('totals and exhaustion', () => {
  test('a known total is authoritative before the prefix reaches it', () => {
    const store = new CoverageStore()
    store.publish(page({ nodes: [src('a')], total: 3 }))
    expect(store.totalOf(null)).toBe(3)
    expect(store.isComplete(null)).toBe(false)
  })

  test('reaching a known total implies exhaustion without the source saying so', () => {
    const store = new CoverageStore()
    store.publish(page({ nodes: [src('a'), src('b')], total: 2 }))
    expect(store.isExhausted(null)).toBe(true)
    expect(store.isComplete(null)).toBe(true)
  })

  test('an unknown total leaves completeness false until exhaustion', () => {
    const store = new CoverageStore()
    store.publish(page({ nodes: [src('a')] }))
    expect(store.totalOf(null)).toBeUndefined()
    expect(store.isComplete(null)).toBe(false)
    store.publish(page({ offset: 1, nodes: [src('b')], exhausted: true }))
    expect(store.isComplete(null)).toBe(true)
  })

  test('a total may not change once stated', () => {
    const store = new CoverageStore()
    store.publish(page({ nodes: [src('a')], total: 5 }))
    expect(store.publish(page({ offset: 1, nodes: [src('b')], total: 4 })).kind).toBe('conflict')
  })

  test('a prefix may not grow past a stated total', () => {
    const store = new CoverageStore()
    store.publish(page({ nodes: [src('a')], total: 2 }))
    expect(store.publish(page({ offset: 1, nodes: [src('b'), src('c')] })).kind).toBe('conflict')
  })

  test('exhaustion that contradicts a stated total is a conflict', () => {
    const store = new CoverageStore()
    store.publish(page({ nodes: [src('a')], total: 5 }))
    expect(store.publish(page({ offset: 1, nodes: [src('b')], exhausted: true })).kind).toBe(
      'conflict',
    )
  })

  test('an empty non-exhausted page is applied and changes nothing', () => {
    const store = new CoverageStore()
    store.publish(page({ nodes: [src('a')] }))
    expect(store.publish(page({ offset: 1, nodes: [] }))).toEqual({ kind: 'applied', added: 0 })
    expect(store.isExhausted(null)).toBe(false)
  })

  test('an empty exhausted page ends the prefix', () => {
    const store = new CoverageStore()
    store.publish(page({ nodes: [src('a')] }))
    store.publish(page({ offset: 1, nodes: [], exhausted: true }))
    expect(store.isComplete(null)).toBe(true)
    expect(ids(store, null)).toEqual(['a'])
  })

  test('a short page that is not exhausted leaves the prefix open', () => {
    const store = new CoverageStore()
    store.publish(page({ nodes: [src('a')] }))
    expect(store.isComplete(null)).toBe(false)
  })
})

describe('child counts never claim unknown knowledge', () => {
  test('a branchy node with nothing loaded is openable, at least one child', () => {
    const store = new CoverageStore()
    store.publish(page({ nodes: [src('a', true), src('b', false)], exhausted: true }))
    expect(store.get(nodeId('a'))?.childCount).toEqual(atLeast(1))
    expect(store.get(nodeId('b'))?.childCount).toEqual(atLeast(0))
  })

  test('a loaded unexhausted parent reports at least what is loaded', () => {
    const store = new CoverageStore()
    store.publish(page({ nodes: [src('a', true)], exhausted: true }))
    store.publish(page({ parentId: nodeId('a'), nodes: [src('a1'), src('a2')] }))
    expect(store.get(nodeId('a'))?.childCount).toEqual(atLeast(2))
  })

  test('exhaustion makes the child count exact', () => {
    const store = new CoverageStore()
    store.publish(page({ nodes: [src('a', true)], exhausted: true }))
    store.publish(page({ parentId: nodeId('a'), nodes: [src('a1')], exhausted: true }))
    expect(store.get(nodeId('a'))?.childCount).toEqual(exact(1))
  })

  test('a stated total makes the child count exact before the prefix arrives', () => {
    const store = new CoverageStore()
    store.publish(page({ nodes: [src('a', true)], exhausted: true }))
    store.publish(page({ parentId: nodeId('a'), nodes: [src('a1')], total: 9 }))
    expect(store.get(nodeId('a'))?.childCount).toEqual(exact(9))
  })
})

describe('staleness after invalidation', () => {
  test('invalidation bumps the generation', () => {
    const store = new CoverageStore()
    store.publish(page({ nodes: [src('a')] }))
    expect(store.generationOf(null)).toBe(0)
    store.invalidate(null)
    expect(store.generationOf(null)).toBe(1)
  })

  test('a page in flight across an invalidation cannot land as if current', () => {
    // The one failure contiguity cannot catch: after a reset the prefix is empty,
    // so a stale page for offset zero IS contiguous, and without a generation it
    // would be accepted as fresh data.
    const store = new CoverageStore()
    store.publish(page({ nodes: [src('a')] }))
    const generation = store.generationOf(null)
    store.invalidate(null)
    const outcome = store.publish(page({ generation, nodes: [src('a')] }))
    expect(outcome).toEqual({ kind: 'stale', expected: 1, received: 0 })
    expect(store.roots).toEqual([])
  })

  test('a page requested after the invalidation applies normally', () => {
    const store = new CoverageStore()
    store.publish(page({ nodes: [src('a')] }))
    store.invalidate(null)
    const outcome = store.publish(page({ generation: store.generationOf(null), nodes: [src('a')] }))
    expect(outcome.kind).toBe('applied')
    expect(ids(store, null)).toEqual(['a'])
  })

  test('invalidating a parent drops its whole subtree, not just its children', () => {
    const store = new CoverageStore()
    store.publish(page({ nodes: [src('a', true)], exhausted: true }))
    store.publish(page({ parentId: nodeId('a'), nodes: [src('a1', true)], exhausted: true }))
    store.publish(page({ parentId: nodeId('a1'), nodes: [src('a1x')], exhausted: true }))
    expect(store.get(nodeId('a1x'))).toBeDefined()

    store.invalidate(nodeId('a'))
    expect(store.get(nodeId('a1'))).toBeUndefined()
    expect(store.get(nodeId('a1x'))).toBeUndefined()
    expect(store.get(nodeId('a'))?.childIds).toEqual([])
    expect(store.get(nodeId('a'))?.childCount).toEqual(atLeast(1))
  })

  test('expansion survives invalidation and reapplies when the data returns', () => {
    // M0 established that expanding an unreachable node is a recorded no-op. That
    // is what makes a refresh preserve what the reader had open.
    const store = new CoverageStore()
    store.publish(page({ nodes: [src('a', true)], exhausted: true }))
    store.publish(page({ parentId: nodeId('a'), nodes: [src('a1')], exhausted: true }))
    const projection = new MaterializedProjection(store, [nodeId('a')])
    expect(approximate(projection.count())).toBe(2)

    store.invalidate(nodeId('a'))
    projection.invalidate(nodeId('a'))
    expect(approximate(projection.count())).toBe(1)

    store.publish(
      page({
        parentId: nodeId('a'),
        generation: store.generationOf(nodeId('a')),
        nodes: [src('a1')],
        exhausted: true,
      }),
    )
    projection.invalidate(nodeId('a'))
    expect(approximate(projection.count())).toBe(2)
    expect(projection.isExpanded(nodeId('a'))).toBe(true)
  })
})

describe('out-of-order arrival converges', () => {
  test('pages applied in reverse reach the same state as in order, once retried', () => {
    const inOrder = new CoverageStore()
    const reversed = new CoverageStore()
    const pages = [
      page({ offset: 0, nodes: [src('a'), src('b')] }),
      page({ offset: 2, nodes: [src('c'), src('d')] }),
      page({ offset: 4, nodes: [src('e')], exhausted: true }),
    ]

    for (const p of pages) expect(inOrder.publish(p).kind).toBe('applied')

    // Arriving backwards, each out-of-order page is refused as a gap and changes
    // nothing. Retrying until quiet converges on the identical prefix, which is
    // what makes the loading layer's retry policy safe to write later.
    let progress = true
    while (progress) {
      progress = false
      for (const p of [...pages].reverse()) {
        if (reversed.publish(p).kind === 'applied') progress = true
      }
    }

    expect([...reversed.roots]).toEqual([...inOrder.roots])
    expect(reversed.isExhausted(null)).toBe(inOrder.isExhausted(null))
    expect(reversed.totalOf(null)).toBe(inOrder.totalOf(null))
  })
})

describe('the projection agrees with the M0 oracle', () => {
  test('over a coverage store built from pages', () => {
    const store = new CoverageStore()
    store.publish(page({ nodes: [src('a', true), src('b', true)], exhausted: true }))
    store.publish(page({ parentId: nodeId('a'), nodes: [src('a1', true), src('a2')] }))
    store.publish(page({ parentId: nodeId('a1'), nodes: [src('a1x')], exhausted: true }))
    store.publish(page({ parentId: nodeId('b'), nodes: [], exhausted: true }))

    const expanded = [nodeId('a'), nodeId('a1'), nodeId('b')]
    const materialized = new MaterializedProjection(store, expanded)
    const oracle = new OracleProjection(store, expanded)

    const render = (p: { slice: (a: number, b: number) => readonly { index: number }[] }): string =>
      p
        .slice(0, 100)
        .map((r) => rowKey(r as never))
        .join('|')

    expect(render(materialized)).toBe(render(oracle))
    expect(materialized.count()).toEqual(oracle.count())
  })
})

describe('row count semantics', () => {
  test('unknown total reports at least the loaded rows', () => {
    const store = new CoverageStore()
    store.publish(page({ nodes: [src('a'), src('b')] }))
    const projection = new MaterializedProjection(store)
    expect(rowCountEstimate(store, projection)).toEqual(atLeast(2))
  })

  test('exhausted roots with no expansion is exact', () => {
    const store = new CoverageStore()
    store.publish(page({ nodes: [src('a'), src('b')], exhausted: true }))
    const projection = new MaterializedProjection(store)
    expect(rowCountEstimate(store, projection)).toEqual(exact(2))
  })

  test('one unexhausted expanded parent makes the whole count inexact', () => {
    const store = new CoverageStore()
    store.publish(page({ nodes: [src('a', true)], exhausted: true }))
    store.publish(page({ parentId: nodeId('a'), nodes: [src('a1')] }))
    const projection = new MaterializedProjection(store, [nodeId('a')])
    expect(rowCountEstimate(store, projection)).toEqual(atLeast(2))
  })

  test('an unexhausted parent that is collapsed does not taint the count', () => {
    const store = new CoverageStore()
    store.publish(page({ nodes: [src('a', true)], exhausted: true }))
    store.publish(page({ parentId: nodeId('a'), nodes: [src('a1')] }))
    const projection = new MaterializedProjection(store)
    expect(rowCountEstimate(store, projection)).toEqual(exact(1))
  })

  test('the projection alone would have claimed exact, which is why this exists', () => {
    const store = new CoverageStore()
    store.publish(page({ nodes: [src('a')] }))
    const projection = new MaterializedProjection(store)
    expect(projection.count()).toEqual(exact(1))
    expect(rowCountEstimate(store, projection)).toEqual(atLeast(1))
  })
})
