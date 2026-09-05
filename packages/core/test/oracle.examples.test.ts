import { describe, expect, test } from 'vitest'
import {
  MapTreeStore,
  OracleProjection,
  estimated,
  exact,
  nodeId,
  orderKey,
  rowKey,
  type NodeId,
  type NodeRecord,
} from '../src/index.js'

/**
 * Worked examples with the expected output computed by hand.
 *
 * The property suite proves the oracle is internally consistent. These prove it
 * is right, which is a different claim, and the only place in the project where
 * a human decides what the answer should be.
 */
const n = (
  id: string,
  parentId: string | null,
  children: string[] | undefined,
  count?: number,
): [NodeId, NodeRecord] => [
  nodeId(id),
  {
    id: nodeId(id),
    parentId: parentId === null ? null : nodeId(parentId),
    orderKey: orderKey(id),
    childIds: children?.map(nodeId),
    childCount: children === undefined ? estimated(count ?? 0) : exact(children.length),
  },
]

const keys = (projection: OracleProjection): string[] =>
  projection.slice(0, projection.count().value).map(rowKey)

describe('a three-level tree, fully loaded', () => {
  //  a
  //  ├─ b
  //  │  └─ d
  //  └─ c
  const store = new MapTreeStore(
    [nodeId('a')],
    new Map([n('a', null, ['b', 'c']), n('b', 'a', ['d']), n('c', 'a', []), n('d', 'b', [])]),
  )

  test('collapsed root shows one row', () => {
    const p = new OracleProjection(store)
    expect(keys(p)).toEqual(['n:a'])
    expect(p.count()).toEqual(exact(1))
  })

  test('expanding the root shows its two children in source order', () => {
    const p = new OracleProjection(store, [nodeId('a')])
    expect(keys(p)).toEqual(['n:a', 'n:b', 'n:c'])
  })

  test('expanding a middle node inserts its child between siblings', () => {
    const p = new OracleProjection(store, [nodeId('a'), nodeId('b')])
    expect(keys(p)).toEqual(['n:a', 'n:b', 'n:d', 'n:c'])
    expect(p.slice(0, 4).map((r) => r.depth)).toEqual([0, 1, 2, 1])
  })

  test('expanding a node whose parent is collapsed changes nothing', () => {
    const p = new OracleProjection(store, [nodeId('b')])
    expect(keys(p)).toEqual(['n:a'])
  })

  test('expanding a childless node changes nothing', () => {
    const p = new OracleProjection(store, [nodeId('a'), nodeId('c')])
    expect(keys(p)).toEqual(['n:a', 'n:b', 'n:c'])
  })
})

describe('an unloaded node', () => {
  //  a
  //  ├─ b  (expanded, children unknown, estimated at 3)
  //  └─ c
  const store = new MapTreeStore(
    [nodeId('a')],
    new Map([n('a', null, ['b', 'c']), n('b', 'a', undefined, 3), n('c', 'a', [])]),
  )

  test('collapsed, it occupies one row and the count is exact', () => {
    const p = new OracleProjection(store, [nodeId('a')])
    expect(keys(p)).toEqual(['n:a', 'n:b', 'n:c'])
    expect(p.count()).toEqual(exact(3))
  })

  test('expanded, it occupies its estimate and the count stops being exact', () => {
    const p = new OracleProjection(store, [nodeId('a'), nodeId('b')])
    expect(keys(p)).toEqual(['n:a', 'n:b', 'p:b:0', 'p:b:1', 'p:b:2', 'n:c'])
    expect(p.count()).toEqual(estimated(6))
  })

  test('placeholders sit at the depth their real children would occupy', () => {
    const p = new OracleProjection(store, [nodeId('a'), nodeId('b')])
    expect(p.slice(0, 6).map((r) => r.depth)).toEqual([0, 1, 2, 2, 2, 1])
  })

  test('a following sibling keeps its position regardless of the estimate', () => {
    const p = new OracleProjection(store, [nodeId('a'), nodeId('b')])
    const c = p.slice(0, 6).find((r) => r.kind === 'node' && r.id === nodeId('c'))
    expect(c?.index).toBe(5)
  })
})

describe('accessors', () => {
  const store = new MapTreeStore([nodeId('a')], new Map([n('a', null, ['b']), n('b', 'a', [])]))
  const p = new OracleProjection(store, [nodeId('a')])

  test('resolve and slice agree', () => {
    expect(p.resolve(1)).toEqual(p.slice(1, 2)[0])
  })
  test('out of range is undefined', () => {
    expect(p.resolve(-1)).toBeUndefined()
    expect(p.resolve(2)).toBeUndefined()
  })
  test('slice clamps rather than treating negatives as offsets from the end', () => {
    expect(p.slice(-5, 1).map(rowKey)).toEqual(['n:a'])
    expect(p.slice(2, 1)).toEqual([])
  })
  test('unknown nodes cannot be expanded', () => {
    expect(() => p.expand(nodeId('zzz'))).toThrow(/unknown node/)
  })
})
