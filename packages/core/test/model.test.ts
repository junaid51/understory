import { describe, expect, test } from 'vitest'
import {
  addCounts,
  approximate,
  atLeast,
  compareOrderKeys,
  estimated,
  exact,
  exactValue,
  isExact,
  isExpandable,
  isLoaded,
  nodeId,
  orderKey,
  rowKey,
  type NodeRecord,
} from '../src/index.js'

describe('CountEstimate', () => {
  test('exactValue is undefined for anything that is not exact', () => {
    expect(exactValue(exact(5))).toBe(5)
    expect(exactValue(atLeast(5))).toBeUndefined()
    expect(exactValue(estimated(5))).toBeUndefined()
  })

  test('approximate reads the number regardless of confidence', () => {
    expect(approximate(estimated(7))).toBe(7)
  })

  // The precision lattice is the part worth testing: a sum is only as
  // trustworthy as its least trustworthy term.
  test.each([
    ['exact + exact', exact(1), exact(2), 'exact', 3],
    ['exact + atLeast', exact(1), atLeast(2), 'atLeast', 3],
    ['atLeast + exact', atLeast(1), exact(2), 'atLeast', 3],
    ['exact + estimated', exact(1), estimated(2), 'estimated', 3],
    ['atLeast + estimated', atLeast(1), estimated(2), 'estimated', 3],
    ['estimated + estimated', estimated(1), estimated(2), 'estimated', 3],
  ] as const)('%s degrades to %s', (_label, a, b, kind, value) => {
    const sum = addCounts(a, b)
    expect(sum.kind).toBe(kind)
    expect(sum.value).toBe(value)
  })

  test('addCounts is commutative in kind and value', () => {
    const pairs = [exact(3), atLeast(4), estimated(5)]
    for (const a of pairs) {
      for (const b of pairs) {
        expect(addCounts(a, b)).toEqual(addCounts(b, a))
      }
    }
  })

  test('isExact narrows', () => {
    const c = exact(2)
    expect(isExact(c)).toBe(true)
    expect(isExact(estimated(2))).toBe(false)
  })
})

describe('node predicates', () => {
  const make = (over: Partial<NodeRecord>): NodeRecord => ({
    id: nodeId('a'),
    parentId: null,
    orderKey: orderKey('a'),
    childIds: [],
    childCount: exact(0),
    ...over,
  })

  test('a loaded childless node is not expandable', () => {
    const n = make({ childIds: [], childCount: exact(0) })
    expect(isExpandable(n)).toBe(false)
    expect(isLoaded(n)).toBe(true)
  })

  test('an unloaded node with an estimated count is expandable', () => {
    const n = make({ childIds: undefined, childCount: estimated(12) })
    expect(isExpandable(n)).toBe(true)
    expect(isLoaded(n)).toBe(false)
  })

  // The distinction this engine exists for: "no children" and "children unknown"
  // are different states and must never collapse into one.
  test('empty children and unloaded children are distinguishable', () => {
    expect(isLoaded(make({ childIds: [] }))).toBe(true)
    expect(isLoaded(make({ childIds: undefined, childCount: estimated(3) }))).toBe(false)
  })
})

describe('row keys', () => {
  test('node keys follow the node, placeholder keys follow the slot', () => {
    expect(rowKey({ kind: 'node', index: 4, id: nodeId('x'), parentId: null, depth: 0 })).toBe(
      'n:x',
    )
    expect(
      rowKey({ kind: 'placeholder', index: 9, parentId: nodeId('x'), depth: 1, slot: 2 }),
    ).toBe('p:x:2')
  })

  test('a node key does not collide with a placeholder key', () => {
    const a = rowKey({ kind: 'node', index: 0, id: nodeId('x:1'), parentId: null, depth: 0 })
    const b = rowKey({ kind: 'placeholder', index: 1, parentId: nodeId('x'), depth: 1, slot: 1 })
    expect(a).not.toBe(b)
  })
})

test('order keys compare lexicographically', () => {
  expect(compareOrderKeys(orderKey('a'), orderKey('b'))).toBe(-1)
  expect(compareOrderKeys(orderKey('b'), orderKey('a'))).toBe(1)
  expect(compareOrderKeys(orderKey('a'), orderKey('a'))).toBe(0)
})
