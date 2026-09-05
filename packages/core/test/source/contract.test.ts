import { describe, expect, test } from 'vitest'
import {
  InMemorySource,
  InvalidRangeError,
  MapTreeStore,
  exact,
  nodeId,
  orderKey,
  requestKey,
  type LoadChildrenRequest,
  type NodeId,
  type NodeRecord,
} from '../../src/index.js'

/**
 * Contract tests for `HierarchySource`.
 *
 * Written as plain tests rather than a reusable conformance suite. There is one
 * implementation; a suite parameterised over one factory is a function with
 * ceremony, and the projection suite earned its shape only because three
 * implementations had to satisfy it. If a second source ever exists, extracting
 * this is a ten-minute job with a reason behind it.
 */

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

//  a          b (leaf)
//  ├─ a1 ── a1x
//  ├─ a2
//  └─ a3
const store = new MapTreeStore(
  [nodeId('a'), nodeId('b')],
  new Map([
    node('a', null, ['a1', 'a2', 'a3']),
    node('b', null, []),
    node('a1', 'a', ['a1x']),
    node('a2', 'a', []),
    node('a3', 'a', []),
    node('a1x', 'a1', []),
  ]),
)

const ask = (
  over: Partial<Omit<LoadChildrenRequest, 'signal'>> & { signal?: AbortSignal },
): LoadChildrenRequest => ({
  parentId: null,
  offset: 0,
  limit: 10,
  signal: new AbortController().signal,
  ...over,
})

describe('addressing', () => {
  test('a null parent addresses the roots', async () => {
    const source = new InMemorySource(store)
    const result = await source.loadChildren(ask({ parentId: null }))
    expect(result.nodes.map((n) => n.id)).toEqual([nodeId('a'), nodeId('b')])
  })

  test('a node id addresses that node children, in source order', async () => {
    const source = new InMemorySource(store)
    const result = await source.loadChildren(ask({ parentId: nodeId('a') }))
    expect(result.nodes.map((n) => n.id)).toEqual([nodeId('a1'), nodeId('a2'), nodeId('a3')])
  })

  test('hasChildren distinguishes an unopened parent from a leaf', async () => {
    const source = new InMemorySource(store)
    const result = await source.loadChildren(ask({ parentId: nodeId('a') }))
    expect(result.nodes.map((n) => n.hasChildren)).toEqual([true, false, false])
  })

  test('an unknown parent reads as having no children rather than throwing', async () => {
    // Not an error: a parent can be evicted or removed between a demand being
    // formed and the request being served, and that is a data condition.
    const source = new InMemorySource(store)
    const result = await source.loadChildren(ask({ parentId: nodeId('nope') }))
    expect(result).toEqual({ nodes: [], exhausted: true, total: 0 })
  })
})

describe('offset and limit', () => {
  test('limit caps the page', async () => {
    const source = new InMemorySource(store)
    const result = await source.loadChildren(ask({ parentId: nodeId('a'), limit: 2 }))
    expect(result.nodes.map((n) => n.id)).toEqual([nodeId('a1'), nodeId('a2')])
    expect(result.exhausted).toBe(false)
  })

  test('offset skips, and the last page reports exhausted', async () => {
    const source = new InMemorySource(store)
    const result = await source.loadChildren(ask({ parentId: nodeId('a'), offset: 2, limit: 2 }))
    expect(result.nodes.map((n) => n.id)).toEqual([nodeId('a3')])
    expect(result.exhausted).toBe(true)
  })

  test('a source may return fewer nodes than the limit mid-sequence', async () => {
    // A consumer that assumes nodes.length === limit is wrong, and this makes that
    // assumption fail here rather than in an application.
    const source = new InMemorySource(store, { maxPageSize: 1 })
    const result = await source.loadChildren(ask({ parentId: nodeId('a'), limit: 10 }))
    expect(result.nodes).toHaveLength(1)
    expect(result.exhausted).toBe(false)
  })

  test('an offset at or past the end is an empty exhausted page, not an error', async () => {
    const source = new InMemorySource(store)
    for (const offset of [3, 4, 1000]) {
      const result = await source.loadChildren(ask({ parentId: nodeId('a'), offset }))
      expect(result.nodes).toEqual([])
      expect(result.exhausted).toBe(true)
    }
  })

  test('a leaf yields an empty exhausted page', async () => {
    const source = new InMemorySource(store)
    const result = await source.loadChildren(ask({ parentId: nodeId('b') }))
    expect(result).toEqual({ nodes: [], exhausted: true, total: 0 })
  })
})

describe('invalid ranges reject synchronously', () => {
  // Eagerly, not as a rejected promise: a malformed range is a caller defect and
  // should not travel the same path a network failure would.
  test.each([
    ['negative offset', { offset: -1 }],
    ['fractional offset', { offset: 1.5 }],
    ['zero limit', { limit: 0 }],
    ['negative limit', { limit: -5 }],
    ['fractional limit', { limit: 2.5 }],
    ['NaN offset', { offset: Number.NaN }],
  ] as const)('%s', (_label, over) => {
    const source = new InMemorySource(store)
    expect(() => source.loadChildren(ask(over))).toThrow(InvalidRangeError)
  })
})

describe('totals', () => {
  test('a counting source reports an exact total on every page', async () => {
    const source = new InMemorySource(store, { reportTotal: true })
    const first = await source.loadChildren(ask({ parentId: nodeId('a'), limit: 1 }))
    expect(first.total).toBe(3)
    expect(first.exhausted).toBe(false)
  })

  test('a non-counting source omits total entirely rather than sending zero', async () => {
    const source = new InMemorySource(store, { reportTotal: false })
    const result = await source.loadChildren(ask({ parentId: nodeId('a'), limit: 1 }))
    expect('total' in result).toBe(false)
    expect(result.exhausted).toBe(false)
  })

  test('a non-counting source still reports exhaustion, which is the other way to learn a total', async () => {
    const source = new InMemorySource(store, { reportTotal: false })
    const result = await source.loadChildren(ask({ parentId: nodeId('a'), offset: 2, limit: 5 }))
    expect(result.exhausted).toBe(true)
    expect(result.nodes).toHaveLength(1)
  })
})

describe('request identity', () => {
  test('the key ignores the signal, because cancelling does not change the question', () => {
    const a = { parentId: nodeId('a'), offset: 0, limit: 10 }
    const b = { parentId: nodeId('a'), offset: 0, limit: 10 }
    expect(requestKey(a)).toBe(requestKey(b))
  })

  test.each(['<roots>', 'r', 'null', '', 'a:b'])(
    'roots cannot collide with a node whose id is %o',
    (hostile) => {
      // Node ids are opaque strings from a source, so nothing is safe to reserve
      // in their namespace. The first encoding used '<roots>' as a sentinel id and
      // this test broke it on the first run.
      expect(requestKey({ parentId: null, offset: 0, limit: 1 })).not.toBe(
        requestKey({ parentId: nodeId(hostile), offset: 0, limit: 1 }),
      )
    },
  )

  test('a node id containing colons stays unambiguous', () => {
    expect(requestKey({ parentId: nodeId('a:1'), offset: 2, limit: 3 })).not.toBe(
      requestKey({ parentId: nodeId('a'), offset: 1, limit: 3 }),
    )
  })

  test.each([
    ['parent', { parentId: nodeId('b') }],
    ['offset', { offset: 1 }],
    ['limit', { limit: 5 }],
  ] as const)('a different %s is a different key', (_label, over) => {
    const base = { parentId: nodeId('a'), offset: 0, limit: 10 }
    expect(requestKey({ ...base, ...over })).not.toBe(requestKey(base))
  })

  test('the same request repeated yields an identical answer', async () => {
    // This is what lets commit 6 shuffle arrivals without a timer: content is a
    // function of identity, so only timing varies.
    const source = new InMemorySource(store)
    const first = await source.loadChildren(ask({ parentId: nodeId('a'), limit: 2 }))
    const second = await source.loadChildren(ask({ parentId: nodeId('a'), limit: 2 }))
    expect(second).toEqual(first)
    expect(source.requests).toHaveLength(2)
  })
})

describe('deterministic out-of-order completion', () => {
  test('manual mode queues until released, and releases in any order', async () => {
    const source = new InMemorySource(store, { mode: 'manual' })
    const rootsPromise = source.loadChildren(ask({ parentId: null, limit: 10 }))
    const childrenPromise = source.loadChildren(ask({ parentId: nodeId('a'), limit: 10 }))

    expect(source.pending()).toEqual([
      requestKey({ parentId: null, offset: 0, limit: 10 }),
      requestKey({ parentId: nodeId('a'), offset: 0, limit: 10 }),
    ])

    const settled: string[] = []
    void rootsPromise.then(() => settled.push('roots'))
    void childrenPromise.then(() => settled.push('children'))

    // Release the second request first. No timers, no races.
    expect(source.releaseInReverse()).toBe(2)
    await Promise.all([rootsPromise, childrenPromise])
    expect(settled).toEqual(['children', 'roots'])
    expect(source.pending()).toEqual([])
  })

  test('releasing an unknown key is a no-op', () => {
    const source = new InMemorySource(store, { mode: 'manual' })
    expect(source.release('nope:0:1')).toBe(false)
  })

  test('two callers asking the identical question both receive the same answer', async () => {
    const source = new InMemorySource(store, { mode: 'manual' })
    const first = source.loadChildren(ask({ parentId: nodeId('a'), limit: 10 }))
    const second = source.loadChildren(ask({ parentId: nodeId('a'), limit: 10 }))
    expect(source.pending()).toHaveLength(1)
    source.releaseAll()
    expect(await first).toEqual(await second)
  })
})

describe('cancellation', () => {
  test('a request aborted before it is made rejects with AbortError', async () => {
    const source = new InMemorySource(store)
    const controller = new AbortController()
    controller.abort()
    await expect(source.loadChildren(ask({ signal: controller.signal }))).rejects.toMatchObject({
      name: 'AbortError',
    })
  })

  test('a queued request aborted before release rejects and leaves the queue', async () => {
    const source = new InMemorySource(store, { mode: 'manual' })
    const controller = new AbortController()
    const promise = source.loadChildren(ask({ parentId: nodeId('a'), signal: controller.signal }))
    expect(source.pending()).toHaveLength(1)
    controller.abort()
    await expect(promise).rejects.toMatchObject({ name: 'AbortError' })
    expect(source.pending()).toEqual([])
  })

  test('aborting one waiter does not disturb another on the same key', async () => {
    const source = new InMemorySource(store, { mode: 'manual' })
    const doomed = new AbortController()
    const cancelled = source.loadChildren(ask({ parentId: nodeId('a'), signal: doomed.signal }))
    const survivor = source.loadChildren(ask({ parentId: nodeId('a') }))

    doomed.abort()
    await expect(cancelled).rejects.toMatchObject({ name: 'AbortError' })

    expect(source.pending()).toHaveLength(1)
    source.releaseAll()
    expect((await survivor).nodes).toHaveLength(3)
  })

  test('an aborted request still appears in the log, because it was still asked', async () => {
    const source = new InMemorySource(store)
    const controller = new AbortController()
    controller.abort()
    await expect(source.loadChildren(ask({ signal: controller.signal }))).rejects.toThrow()
    expect(source.requests).toHaveLength(1)
  })
})
