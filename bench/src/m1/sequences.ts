import type { MapTreeStore, NodeId } from '@understory/core'
import { generate, SHAPES, type ShapeName } from '../corpus.js'
import { mulberry32 } from '../prng.js'
import { Harness, type SettleOrder, type Step } from './harness.js'

/**
 * Generated interaction sequences for acceptance criterion A7.
 *
 * The six workloads are *scripted*, for the reason M0 learned the hard way: random
 * single-node commands almost never build the situation a defect needs. A7 is the
 * other half of that lesson. Scripted traces only ever exercise sequences someone
 * thought of, so the criterion asks for ten thousand generated ones as well, and
 * the two answer different questions.
 *
 * Sequences act only on nodes the state has actually loaded, which is not a
 * convenience: under D2 an unloaded node does not exist, so a generator that named
 * arbitrary ids from `truth` would spend most of its steps recording pending
 * expansions that never apply, and would look busy while testing very little.
 */

export interface SequenceOptions {
  readonly sequences: number
  readonly stepsPerSequence: number
  readonly nodes: number
  readonly seed: number
  readonly budget: number
  readonly pageSize: number
}

export interface SequenceReport {
  readonly sequences: number
  readonly steps: number
  readonly violations: readonly string[]
  /** Shape and seed of every sequence that failed, so a failure is reproducible. */
  readonly failures: readonly { shape: ShapeName; seed: number; violation: string }[]
  readonly opCounts: Readonly<Record<string, number>>
  /** Reachability: sequences that got past the opening page and did real work. */
  readonly sequencesWithLoadedWork: number
  /** Reachability: sequences in which the budget was reached and eviction ran. */
  readonly sequencesWithEviction: number
  readonly evictions: number
  readonly maxRowsSeen: number
}

const ORDERS: SettleOrder[] = ['inOrder', 'reverse', 'shuffled']

/**
 * One sequence, generated against the state it is driving.
 *
 * Interleaved rather than generated up front, because the only nodes worth
 * expanding are the ones the previous steps loaded. A pre-generated script cannot
 * know them.
 */
async function runOne(
  truth: MapTreeStore,
  seed: number,
  options: SequenceOptions,
  opCounts: Record<string, number>,
): Promise<{ violations: string[]; rows: number; didWork: boolean; evictions: number }> {
  const random = mulberry32(seed)
  const order = ORDERS[Math.floor(random() * ORDERS.length)] ?? 'inOrder'
  const harness = new Harness(truth, {
    useLoader: true,
    useEvictor: true,
    budget: options.budget,
    pageSize: options.pageSize,
    seed,
    reportTotal: random() < 0.5,
  })

  const violations: string[] = []
  let rows = 0
  let didWork = false

  // The opening page, so there is something to act on at all.
  violations.push(...(await harness.run([{ op: 'settle', order }])))

  for (let i = 0; i < options.stepsPerSequence && violations.length === 0; i++) {
    const loaded: NodeId[] = []
    for (const row of harness.projection.slice(0, harness.rowCount)) {
      if (row.kind === 'node') loaded.push(row.id)
    }
    rows = Math.max(rows, harness.rowCount)
    if (loaded.length > 1) didWork = true

    const roll = random()
    const pick = loaded[Math.floor(random() * loaded.length)]
    let step: Step
    if (roll < 0.34 && pick !== undefined) step = { op: 'expand', id: pick }
    else if (roll < 0.5 && pick !== undefined) step = { op: 'collapse', id: pick }
    else if (roll < 0.62) step = { op: 'scrollToEnd' }
    else if (roll < 0.78) {
      const start = Math.floor(random() * Math.max(1, harness.rowCount + 40))
      step = { op: 'viewport', start, end: start + 40 }
    } else step = { op: 'settle', order }

    opCounts[step.op] = (opCounts[step.op] ?? 0) + 1
    violations.push(...(await harness.run([step])))
  }

  // Always settle at the end, so a sequence cannot pass by leaving demand unasked.
  violations.push(...(await harness.run([{ op: 'settle', order }])))
  rows = Math.max(rows, harness.rowCount)
  return { violations, rows, didWork, evictions: harness.evictionCount }
}

/**
 * Runs the A7 suite.
 *
 * Sequences are spread across all five shapes, `mega-sibling` included. Excluding
 * the pathological shape from a correctness criterion would be excluding the one
 * most likely to break it.
 */
export async function runSequences(options: SequenceOptions): Promise<SequenceReport> {
  const corpora = new Map<ShapeName, MapTreeStore>()
  for (const shape of SHAPES) {
    corpora.set(shape, generate(shape, { nodes: options.nodes, seed: options.seed }))
  }

  const violations: string[] = []
  const failures: { shape: ShapeName; seed: number; violation: string }[] = []
  const opCounts: Record<string, number> = {}
  let steps = 0
  let withWork = 0
  let withEviction = 0
  let evictions = 0
  let maxRows = 0

  for (let i = 0; i < options.sequences; i++) {
    const shape = SHAPES[i % SHAPES.length] ?? 'balanced'
    const truth = corpora.get(shape)
    if (truth === undefined) continue
    const seed = options.seed + i
    const result = await runOne(truth, seed, options, opCounts)
    steps += options.stepsPerSequence
    maxRows = Math.max(maxRows, result.rows)
    if (result.didWork) withWork += 1
    if (result.evictions > 0) withEviction += 1
    evictions += result.evictions
    for (const violation of result.violations) {
      violations.push(`${shape}/seed ${seed}: ${violation}`)
      failures.push({ shape, seed, violation })
    }
  }

  return {
    sequences: options.sequences,
    steps,
    violations,
    failures,
    opCounts,
    sequencesWithLoadedWork: withWork,
    sequencesWithEviction: withEviction,
    evictions,
    maxRowsSeen: maxRows,
  }
}
