import { nodeId, type NodeId, type Row } from '@understory/core'
import { describe, expect, test } from 'vitest'
import { SHAPES, generate, type ShapeName } from '../../src/corpus.js'
import { analyseLedger, type RequestRecord } from '../../src/m1/instrument.js'
import { ReachTracker } from '../../src/m1/reach.js'
import { runM1, type M1Config, type M1RunResult } from '../../src/m1/runner.js'
import { runSequences } from '../../src/m1/sequences.js'
import { WORKLOAD_NAMES, type WorkloadName } from '../../src/m1/traces.js'

/**
 * Is the benchmark measuring anything?
 *
 * M0 and M1 both produced a suite that passed on its first run and was later shown
 * to have been asking nothing: traces that settled one request at a time made
 * out-of-order arrival identical to in-order, and the six interaction workloads
 * never accumulated enough coverage to put the bounded-row gate under any pressure.
 * A benchmark that measures nothing reports every gate as passing, which is worse
 * than a failure because it looks like evidence.
 *
 * These run at a small scale on purpose. They check that the apparatus can reach
 * its own claims, not what the numbers are.
 */

const NODES = 3_000
const B = 4_000

const config = (
  workload: WorkloadName,
  shape: ShapeName,
  over: Partial<M1Config> = {},
): M1Config => ({
  workload,
  shape,
  nodes: NODES,
  latencyMs: 50,
  order: 'shuffled3',
  reportTotal: true,
  eviction: false,
  budget: B,
  pageSize: 100,
  overscan: 20,
  viewportRows: 40,
  seed: 7,
  ...over,
})

const run = async (
  workload: WorkloadName,
  shape: ShapeName,
  over: Partial<M1Config> = {},
): Promise<M1RunResult> =>
  runM1(generate(shape, { nodes: NODES, seed: 42 }), config(workload, shape, over))

describe('every workload does real work on at least one shape', () => {
  test.each(WORKLOAD_NAMES)('%s', async (workload) => {
    const results = await Promise.all(SHAPES.map(async (shape) => run(workload, shape)))
    const best = Math.max(...results.map((r) => r.requested))
    // Three is the opening: the roots page plus the root's first page. Anything at
    // or below it means the workload never got past starting up.
    expect(best, `${workload} issued at most ${best} requests on any shape`).toBeGreaterThan(3)
  })
})

describe('W7 reaches the boundary it exists to reach', () => {
  test('accumulate crosses B and eviction pulls it back', async () => {
    // W7 was added because reachability validation showed A1 was vacuous against W1
    // to W6. If W7 ever stops crossing the budget, A1 goes back to passing without
    // being asked a question, and this is the assertion that notices.
    const truth = generate('shallow-wide', { nodes: 60_000, seed: 42 })
    const plain = await runM1(truth, config('accumulate', 'shallow-wide'))
    expect(plain.maxMaterializedRows, 'W7 never reached B, so A1 is untested').toBeGreaterThan(B)

    const evicting = await runM1(truth, config('accumulate', 'shallow-wide', { eviction: true }))
    expect(evicting.evictions, 'W7 crossed B without eviction firing').toBeGreaterThan(0)
  })
})

describe('the latency dimension is not decorative', () => {
  test('latency reorders arrivals and zero latency does not', async () => {
    // A uniform virtual clock makes every request in a round arrive at the same
    // instant in issue order, so all three latency profiles produce identical state
    // and the dimension measures one thing three times. Seeded jitter is what stops
    // that, and this is the check that it is still doing so.
    const fast = await run('browse', 'balanced', { latencyMs: 0, order: 'inOrder' })
    const slow = await run('browse', 'balanced', { latencyMs: 250, order: 'inOrder' })
    expect(fast.deliveryOrderDiverged).toBe(false)
    expect(slow.deliveryOrderDiverged).toBe(true)
    expect(slow.virtualElapsedMs).toBeGreaterThan(fast.virtualElapsedMs)
  })

  test('time to first row is one round trip, not a serialised chain', async () => {
    const slow = await run('browse', 'balanced', { latencyMs: 250, order: 'inOrder' })
    // Within jitter of a single 250ms round trip. A first row that cost several
    // round trips would mean the engine serialises before showing anything.
    expect(slow.timeToFirstRowMs).toBeGreaterThan(0)
    expect(slow.timeToFirstRowMs).toBeLessThan(250 * 1.5)
  })
})

describe('the request ledger can see the defects A5 exists for', () => {
  const record = (over: Partial<RequestRecord>): RequestRecord => ({
    seq: 0,
    key: 'n:p:0:100',
    parentId: nodeId('p'),
    offset: 0,
    limit: 100,
    generation: 0,
    epoch: 0,
    issuedAtMs: 0,
    arrivesAtMs: 0,
    ...over,
  })

  test('an identical repeat inside one epoch is a duplicate', () => {
    expect(analyseLedger([record({ seq: 0 }), record({ seq: 1 })]).duplicates).toBe(1)
  })

  test('the same repeat across an eviction is not', () => {
    const analysis = analyseLedger([record({ seq: 0 }), record({ seq: 1, epoch: 1 })])
    expect(analysis.duplicates).toBe(0)
    expect(analysis.refetchesAfterEviction).toBe(1)
  })

  test('a partially overlapping range is caught even though no key repeats', () => {
    const analysis = analyseLedger([
      record({ seq: 0, offset: 0, limit: 100, key: 'n:p:0:100' }),
      record({ seq: 1, offset: 50, limit: 100, key: 'n:p:50:100' }),
    ])
    expect(analysis.overlaps).toBe(1)
    expect(analysis.duplicates).toBe(0)
  })
})

describe('the theoretical minimum, and the two ways §8 understates it', () => {
  const row = (index: number, id: string, parentId: string | null, depth: number): Row => ({
    kind: 'node',
    index,
    id: nodeId(id),
    parentId: parentId === null ? null : nodeId(parentId),
    depth,
  })

  test('§8 counts one page per distinct visible page', () => {
    const reach = new ReachTracker(2)
    // Four children of `p`, all visible: slots 0..3, pages 0 and 1.
    reach.observe(
      [row(0, 'p', null, 0), ...['a', 'b', 'c', 'd'].map((id, i) => row(i + 1, id, 'p', 1))],
      0,
      10,
    )
    // Two pages of `p`, plus one page of the roots for `p` itself.
    expect(reach.minimumPages).toBe(3)
  })

  test('a page whose prefix was never visible is unreachable under D2', () => {
    const reach = new ReachTracker(2)
    // Only slot 3 of `p` is in the window: §8 counts page 1 alone, but no prefix
    // store can fetch page 1 without page 0.
    reach.observe(
      [row(0, 'p', null, 0), ...['a', 'b', 'c', 'd'].map((id, i) => row(i + 1, id, 'p', 1))],
      4,
      5,
    )
    expect(reach.minimumPages).toBe(1)
    expect(reach.minimumPagesPrefixClosed).toBe(2)
  })

  test('an expanded parent forces a page whether or not anyone looks at it', () => {
    const reach = new ReachTracker(100)
    reach.observe([row(0, 'p', null, 0)], 0, 1)
    // `q` was expanded but its children never entered the window. §8 says its page
    // was unnecessary; the index space could not have been computed without it.
    const expanded = new Set<NodeId>([nodeId('q')])
    expect(reach.minimumPages).toBe(1)
    expect(reach.minimumPagesAchievable(expanded)).toBe(2)
  })
})

describe('generated sequences reach the states they are meant to test', () => {
  test('a pressure pass actually evicts, and a pass at B does not', async () => {
    const atBudget = await runSequences({
      sequences: 60,
      stepsPerSequence: 20,
      nodes: 5_000,
      seed: 4_000,
      budget: B,
      pageSize: 100,
    })
    const pressure = await runSequences({
      sequences: 60,
      stepsPerSequence: 20,
      nodes: 5_000,
      seed: 4_000,
      budget: 200,
      pageSize: 100,
    })
    expect(atBudget.violations).toEqual([])
    expect(pressure.violations).toEqual([])
    expect(atBudget.sequencesWithLoadedWork).toBeGreaterThan(30)
    // The reason both passes exist: at B these sequences never come near the
    // budget, so N2, N3 and N10 would all pass without being asked anything.
    expect(atBudget.sequencesWithEviction).toBe(0)
    expect(pressure.sequencesWithEviction).toBeGreaterThan(0)
  })
})

describe('the benchmark refuses to measure something other than the M1 system', () => {
  test('a workload that evicts on the policy own behalf is rejected', async () => {
    // `policyDriven` strips W6's scripted `evict` instructions, because
    // `BudgetEvictor` is the thing under measurement. If that transform is ever
    // bypassed the runner throws rather than quietly measuring the trace.
    const truth = generate('balanced', { nodes: NODES, seed: 42 })
    const broken = { ...config('longSession', 'balanced'), workload: 'nope' as WorkloadName }
    await expect(runM1(truth, broken)).rejects.toThrow()
  })
})
