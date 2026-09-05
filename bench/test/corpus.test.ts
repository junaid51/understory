import { approximate, type NodeId } from '@understory/core'
import { describe, expect, test } from 'vitest'
import {
  SHAPES,
  allIds,
  generate,
  inspectTopology,
  structureHash,
  type ShapeName,
} from '../src/index.js'
import hashes from './__fixtures__/corpus-hashes.json' with { type: 'json' }

const SIZES = [1_000, 10_000] as const

function depthOf(store: ReturnType<typeof generate>, id: NodeId): number {
  let depth = 0
  let current = store.get(id)
  while (current?.parentId != null) {
    depth += 1
    current = store.get(current.parentId)
  }
  return depth
}

describe.each(SHAPES)('%s', (shape) => {
  test.each(SIZES)('produces exactly %i nodes', (nodes) => {
    expect(generate(shape, { nodes, seed: 7 }).size).toBe(nodes)
  })

  test('the same seed produces an identical structure', () => {
    const a = generate(shape, { nodes: 5_000, seed: 42 })
    const b = generate(shape, { nodes: 5_000, seed: 42 })
    expect(structureHash(a)).toBe(structureHash(b))
  })

  test('a different seed produces a different structure', () => {
    const a = structureHash(generate(shape, { nodes: 5_000, seed: 42 }))
    const b = structureHash(generate(shape, { nodes: 5_000, seed: 43 }))
    // mega-sibling has one shape regardless of seed: a root and everything else
    // under it. Its invariance is correct, not a generator bug.
    if (shape === 'mega-sibling') expect(a).toBe(b)
    else expect(a).not.toBe(b)
  })

  test('every node except a root has a parent that exists and lists it', () => {
    const store = generate(shape, { nodes: 2_000, seed: 3 })
    for (const id of allIds(store)) {
      const node = store.get(id)
      expect(node).toBeDefined()
      if (node?.parentId == null) {
        expect(store.roots).toContain(id)
        continue
      }
      const parent = store.get(node.parentId)
      expect(parent).toBeDefined()
      expect(parent?.childIds).toContain(id)
    }
  })

  test('childCount agrees with childIds when loaded', () => {
    const store = generate(shape, { nodes: 2_000, seed: 3 })
    for (const id of allIds(store)) {
      const node = store.get(id)
      if (node?.childIds === undefined) continue
      expect(node.childCount.kind).toBe('exact')
      expect(approximate(node.childCount)).toBe(node.childIds.length)
    }
  })

  test('sibling order keys are strictly increasing in array order', () => {
    const store = generate(shape, { nodes: 2_000, seed: 3 })
    for (const id of allIds(store)) {
      const node = store.get(id)
      if (!node?.childIds) continue
      const keys = node.childIds.map((c) => store.get(c)?.orderKey ?? '')
      for (let i = 1; i < keys.length; i++) {
        const previous = keys[i - 1]
        const current = keys[i]
        if (previous === undefined || current === undefined) throw new Error('missing order key')
        // ADR-0004: the source's array order is authoritative, and order keys
        // must agree with it or a later insert would land in the wrong place.
        expect(current > previous).toBe(true)
      }
    }
  })

  test('structure hash matches the committed fixture', () => {
    const store = generate(shape, { nodes: 5_000, seed: 42 })
    expect(structureHash(store)).toBe((hashes as Record<string, string>)[shape])
  })
})

/**
 * The corpus must be the shape it claims to be.
 *
 * Two defects reached committed benchmark results before anyone noticed. The
 * unloaded fraction reduced deep-narrow at a million nodes to a 32-row tree. And
 * shallow-wide at a million nodes silently became 437,659 roots, 43.8% of the
 * corpus, because its depth cap could not hold that many nodes at its fan-out and
 * the leftovers were appended as synthetic roots. Both produced entirely
 * plausible numbers for a corpus nobody intended.
 *
 * These assertions make that class of failure loud.
 */
describe.each(SHAPES)('topology integrity: %s', (shape) => {
  test.each([1_000, 20_000, 100_000])('at %i nodes', (nodes) => {
    const report = inspectTopology(generate(shape, { nodes, seed: 42 }), shape)

    // Exactly one root. Frontier exhaustion must never invent more.
    expect(report.roots).toBe(1)

    // No orphans: every generated node is reachable from that root.
    expect(report.reachable).toBe(nodes)
    expect(report.nodes).toBe(nodes)

    // The shape's own depth contract.
    expect(report.maxDepth).toBeLessThanOrEqual(report.declaredMaxDepth)
  })
})

describe('shape characteristics', () => {
  const maxDepth = (shape: ShapeName): number => {
    const store = generate(shape, { nodes: 20_000, seed: 11 })
    return Math.max(...allIds(store).map((id) => depthOf(store, id)))
  }

  // These assertions are what stop all five shapes quietly converging on the
  // same tree, which would make the benchmark suite one shape wearing five hats.
  test('shallow-wide stays shallow', () => expect(maxDepth('shallow-wide')).toBeLessThanOrEqual(3))
  test('mega-sibling is one level', () => expect(maxDepth('mega-sibling')).toBe(1))
  test('deep-narrow goes deep', () => expect(maxDepth('deep-narrow')).toBeGreaterThanOrEqual(30))
  test('balanced sits between the two', () => {
    const depth = maxDepth('balanced')
    expect(depth).toBeGreaterThan(3)
    expect(depth).toBeLessThanOrEqual(16)
  })
  test('sparse-unbalanced has a heavily skewed fan-out', () => {
    const store = generate('sparse-unbalanced', { nodes: 20_000, seed: 11 })
    const counts = allIds(store)
      .map((id) => store.get(id)?.childIds?.length ?? 0)
      .sort((a, b) => a - b)
    const median = counts[Math.floor(counts.length / 2)] ?? 0
    const max = counts.at(-1) ?? 0
    expect(median).toBeLessThanOrEqual(2)
    expect(max).toBeGreaterThan(100)
  })
})

describe('unloaded fraction', () => {
  test('zero leaves everything loaded', () => {
    const store = generate('balanced', { nodes: 2_000, seed: 5, unloadedFraction: 0 })
    expect(allIds(store).every((id) => store.get(id)?.childIds !== undefined)).toBe(true)
  })

  test('a positive fraction produces unloaded nodes with estimated counts', () => {
    const store = generate('balanced', { nodes: 2_000, seed: 5, unloadedFraction: 0.3 })
    const unloaded = allIds(store).filter((id) => store.get(id)?.childIds === undefined)
    expect(unloaded.length).toBeGreaterThan(0)
    for (const id of unloaded) expect(store.get(id)?.childCount.kind).toBe('estimated')
  })

  // Regression test for the defect that made the first full benchmark run
  // meaningless on deep shapes: unloading an ancestor hides its whole subtree,
  // so on a deep-narrow tree a 5% rate removed all but 32 of 1,000,000 rows.
  test.each(SHAPES)('unloading never amputates the corpus: %s', (shape) => {
    const loaded = generate(shape, { nodes: 20_000, seed: 9, unloadedFraction: 0 })
    const unloaded = generate(shape, { nodes: 20_000, seed: 9, unloadedFraction: 0.05 })
    const reachable = (store: ReturnType<typeof generate>): number => {
      let seen = 0
      const stack = [...store.roots]
      while (stack.length > 0) {
        const id = stack.pop()
        if (id === undefined) break
        seen += 1
        for (const child of store.get(id)?.childIds ?? []) stack.push(child)
      }
      return seen
    }
    const before = reachable(loaded)
    const after = reachable(unloaded)
    expect(after / before).toBeGreaterThan(0.9)
  })

  test('changing the unloaded fraction does not change the tree shape', () => {
    const a = generate('balanced', { nodes: 2_000, seed: 5, unloadedFraction: 0 })
    const b = generate('balanced', { nodes: 2_000, seed: 5, unloadedFraction: 0.5 })
    const shapeOf = (s: typeof a) =>
      allIds(s)
        .map((id) => `${id}:${s.get(id)?.parentId ?? '-'}`)
        .join('|')
    expect(shapeOf(a)).toBe(shapeOf(b))
  })
})
