import { CoverageStore, approximate, nodeId, type NodeId, type Projection } from '@understory/core'
import { describe, expect, test } from 'vitest'
import { SHAPES, generate } from '../../src/corpus.js'
import { Harness } from './harness.js'
import { checkM1Invariants, type M1State } from './invariants.js'
import { TRACES } from './traces.js'

/**
 * Does the M1 invariant suite have teeth?
 *
 * The interaction suite passed on its first run, which is not evidence of
 * anything. Each fault below is a defect the corresponding invariant exists to
 * catch, and every one must be caught by name. A checker that cannot be made to
 * fire is decoration.
 *
 * These break state directly rather than through a second CoverageStore. Building
 * a faulty parallel implementation would duplicate production logic and test the
 * copy instead of the original.
 */

const truth = generate('balanced', { nodes: 2_000, seed: 42 })

const seed = async (): Promise<Harness> => {
  const harness = new Harness(truth, { seed: 9 })
  harness.request(null, 0, 100)
  await harness.settle('inOrder')
  const branchy = truth.roots.filter((id) => (truth.get(id)?.childIds?.length ?? 0) > 0).slice(0, 3)
  for (const id of branchy) {
    harness.projection.expand(id)
    harness.request(id, 0, 100)
    await harness.settle('inOrder')
  }
  return harness
}

const withState = (harness: Harness, over: Partial<M1State>): M1State => ({
  ...harness.state(),
  ...over,
})

const caught = (violations: readonly string[], label: string): boolean =>
  violations.some((v) => v.startsWith(label))

describe('fault injection: each invariant must be capable of firing', () => {
  test('N1 detects a row whose node coverage does not hold', async () => {
    // A projection built over one store and checked against another coverage: every
    // row then names a node the coverage layer has never seen.
    const harness = await seed()
    const foreign = new CoverageStore()
    const violations = checkM1Invariants(withState(harness, { coverage: foreign }))
    expect(caught(violations, 'N1'), violations.join('; ')).toBe(true)
  })

  test('N2 detects rows exceeding the budget', async () => {
    const harness = await seed()
    expect(harness.check()).toEqual([])
    const violations = checkM1Invariants(withState(harness, { budget: 1 }))
    expect(caught(violations, 'N2'), violations.join('; ')).toBe(true)
  })

  test('N3 detects an eviction inside the protected window', async () => {
    const harness = await seed()
    const firstRow = harness.projection.slice(0, 1)[0]
    if (firstRow === undefined || firstRow.kind !== 'node') throw new Error('no rows to evict')
    const violations = checkM1Invariants(
      withState(harness, {
        viewport: { start: 0, end: 40, overscan: 20 },
        evictedThisStep: [firstRow.id],
      }),
    )
    expect(caught(violations, 'N3'), violations.join('; ')).toBe(true)
  })

  test('N4 detects a fabricated page the coverage store had no way to reject', async () => {
    // The independence proof.
    //
    // The page below is well formed, contiguous, and internally consistent, so
    // publish() accepts it: nothing in the coverage layer knows what the source
    // would actually have returned. Only `truth` does, which is why N4 is decided
    // against truth rather than against anything the implementation believes.
    //
    // A first attempt aimed this at the roots and was rejected as a conflict,
    // because the roots were already exhausted with a stated total, so coverage
    // caught it on arithmetic before identity ever mattered. The fabricated page
    // has to land on a parent that is neither exhausted nor counted.
    const harness = new Harness(truth, { seed: 9, reportTotal: false })
    harness.request(null, 0, 100)
    await harness.settle('inOrder')
    const root = truth.roots[0]
    if (root === undefined) throw new Error('no root')
    harness.projection.expand(root)
    harness.request(root, 0, 1)
    await harness.settle('inOrder')
    expect(harness.check()).toEqual([])
    expect(harness.coverage.isExhausted(root)).toBe(false)

    const outcome = harness.coverage.publish({
      parentId: root,
      offset: harness.coverage.loadedCount(root),
      generation: harness.coverage.generationOf(root),
      nodes: [{ id: nodeId('fabricated-node'), hasChildren: false }],
      exhausted: false,
    })
    expect(outcome.kind).toBe('applied')

    harness.projection.invalidate(root)
    const violations = harness.check()
    expect(caught(violations, 'N4'), violations.join('; ')).toBe(true)
  })

  test('N5 detects coverage shrinking without an eviction', async () => {
    const harness = await seed()
    expect(harness.check()).toEqual([])
    const victim = truth.roots.find((id) => harness.coverage.loadedCount(id) > 0)
    if (victim === undefined) throw new Error('nothing loaded to shrink')

    // Discard coverage without telling the checker it was an eviction, which is
    // exactly what a silent regression would look like.
    harness.coverage.invalidate(victim)
    harness.projection.invalidate(victim)
    const violations = checkM1Invariants(withState(harness, { evictedThisStep: [] }))
    expect(caught(violations, 'N5'), violations.join('; ')).toBe(true)
  })

  test('N6 detects the same request in flight twice', async () => {
    const harness = await seed()
    const violations = checkM1Invariants(
      withState(harness, { inFlight: ['n:a:0:100', 'n:a:0:100'] }),
    )
    expect(caught(violations, 'N6'), violations.join('; ')).toBe(true)
  })

  test('N9 detects a count claiming exactness a fabricated exhaustion produced', async () => {
    const harness = await seed()
    const victim = truth.roots.find(
      (id) =>
        harness.coverage.loadedCount(id) > 0 &&
        harness.coverage.loadedCount(id) < (truth.get(id)?.childIds?.length ?? 0),
    )
    if (victim === undefined) return

    // A source that lies about exhaustion. Coverage believes the parent is
    // complete, so the count reports exact; truth says otherwise.
    harness.coverage.publish({
      parentId: victim,
      offset: harness.coverage.loadedCount(victim),
      generation: harness.coverage.generationOf(victim),
      nodes: [],
      exhausted: true,
    })
    harness.projection.invalidate(victim)
    const violations = harness.check()
    expect(caught(violations, 'N9'), violations.join('; ')).toBe(true)
  })

  test('N9 detects a count that disagrees with the rows it describes', async () => {
    const harness = await seed()
    const real = harness.projection
    expect(approximate(real.count())).toBeGreaterThan(1)

    // A projection whose count and rows disagree. Built explicitly rather than by
    // spreading the instance: object spread copies own properties, and a class's
    // methods live on the prototype, so the spread version silently had no methods
    // at all and the fault never fired.
    const shortened: Projection = {
      count: () => real.count(),
      resolve: (index: number) => real.resolve(index),
      slice: (from: number, to: number) => real.slice(from, Math.min(to, 1)),
      isExpanded: (id: NodeId) => real.isExpanded(id),
      expand: (id: NodeId) => real.expand(id),
      collapse: (id: NodeId) => real.collapse(id),
      expandedIds: () => real.expandedIds(),
      invalidate: (parentId: NodeId | null) => real.invalidate(parentId),
    }
    const violations = checkM1Invariants(withState(harness, { projection: shortened }))
    expect(caught(violations, 'N9'), violations.join('; ')).toBe(true)
  })
})

describe('what the traces actually reach', () => {
  // The M0 lesson: a property suite's weakest point is its generators, not its
  // properties. Two seeded faults escaped 150 random trees there because the
  // generators never produced the shape they needed. These assertions make the
  // traces state what they cover, so a trace that silently stops exercising
  // something fails here rather than passing quietly.
  test('the traces reach depth, width, eviction and out-of-order retries', async () => {
    const reached = {
      maxRows: 0,
      maxDepth: 0,
      evictions: 0,
      gapsRefused: 0,
      duplicatesRefused: 0,
      pagesApplied: 0,
    }

    for (const [name, build] of Object.entries(TRACES)) {
      for (const shape of SHAPES) {
        // Across every shape, not just one. The first version probed `balanced`
        // alone and reported 85 rows, which says more about a fan-out of eight
        // than about what the traces reach.
        const order = 'shuffled' as const
        const corpus = generate(shape, { nodes: 4_000, seed: 42 })
        const harness = new Harness(corpus, { seed: 9 })
        const steps = build({ truth: corpus, order })
        expect(await harness.run(steps), `${name}/${shape}`).toEqual([])

        reached.maxRows = Math.max(reached.maxRows, harness.rowCount)
        for (const row of harness.projection.slice(0, harness.rowCount)) {
          reached.maxDepth = Math.max(reached.maxDepth, row.depth)
        }
        reached.evictions += steps.filter((s) => s.op === 'evict').length
        for (const outcome of harness.outcomes) {
          if (outcome.kind === 'gap') reached.gapsRefused += 1
          if (outcome.kind === 'duplicate') reached.duplicatesRefused += 1
          if (outcome.kind === 'applied') reached.pagesApplied += 1
        }
      }
    }

    // eslint-disable-next-line no-console
    console.log('\ntrace coverage:', JSON.stringify(reached, null, 2))

    expect(reached.pagesApplied, 'no pages were ever applied').toBeGreaterThan(50)
    expect(
      reached.maxRows,
      'traces never materialised a meaningful number of rows',
    ).toBeGreaterThan(100)
    expect(reached.maxDepth, 'traces never reached a nested row').toBeGreaterThan(0)
    expect(reached.evictions, 'no trace ever evicted').toBeGreaterThan(0)
    expect(
      reached.gapsRefused,
      'out-of-order arrival never produced a refused gap',
    ).toBeGreaterThan(0)
  })
})
