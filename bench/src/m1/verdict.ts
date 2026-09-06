import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import type { HeapResult, M1RunResult } from './runner.js'
import type { SequenceReport } from './sequences.js'

/**
 * Computes the M1 verdict from committed thresholds and committed results.
 *
 * Nobody writes PASS or FAIL by hand. Every gate below reads its number out of
 * `bench/thresholds.m1.json`, which was committed before any M1 engine code
 * existed, and applies it to a measured field. Where the pre-registered wording is
 * ambiguous the tool takes the *stricter* reading and prints the other one beside
 * it, because the alternative is choosing an interpretation after seeing which one
 * passes.
 *
 * Three things this tool deliberately will not do. It will not exclude
 * `mega-sibling` for being pathological. It will not move `B`. And it will not
 * resolve the N2 contradiction recorded in commit 8; it prints the evidence and
 * leaves the decision to commit 10.
 */

interface Thresholds {
  preRegisteredOn: string
  budget: { materializedRows: number; structuralChangeMs: number; statistic: string }
  acceptanceGates: { id: string; name: string; rule: string; provenance: string }[]
  diagnostics: { id: string; name: string; why: string }[]
  outcomes: Record<string, string>
}

interface ResultFile {
  commit: string
  started: string
  environment: Record<string, unknown>
  controlWorkloadMs: number
  parameters: Record<string, unknown>
  runs: M1RunResult[]
  heaps: (HeapResult & { shape: string; workload: string; eviction: boolean })[]
  sequences: { atBudget: SequenceReport; underPressure: SequenceReport }
}

const RESULTS_DIR = 'bench/results'

function latest(): ResultFile | undefined {
  let files: string[]
  try {
    files = readdirSync(RESULTS_DIR).filter((f) => f.startsWith('m1-') && f.endsWith('.json'))
  } catch {
    return undefined
  }
  const chosen = files.sort().at(-1)
  if (chosen === undefined) return undefined
  return JSON.parse(readFileSync(join(RESULTS_DIR, chosen), 'utf8')) as ResultFile
}

const thresholds = JSON.parse(readFileSync('bench/thresholds.m1.json', 'utf8')) as Thresholds
const results = latest()
if (results === undefined) {
  process.stderr.write('no M1 results in bench/results. Run `npm run bench:m1` first.\n')
  process.exit(2)
}

const B = thresholds.budget.materializedRows
const FRAME_MS = thresholds.budget.structuralChangeMs
const AMPLIFICATION_POLICY = 3.0
const HEAP_RATIO = 1.5
const REQUIRED_SEQUENCES = 10_000

const out: string[] = []
const say = (line = ''): void => void out.push(line)

/** Repeats and network profiles produce identical lines; a reader needs each cell once. */
const uniq = (lines: string[], limit = 8): string[] => [...new Set(lines)].slice(0, limit)

/**
 * A statistic that may not exist.
 *
 * `summarise([])` has no percentiles, and a run with eviction disabled performs no
 * sweeps, so `sweepTime` is NaN there and arrives from JSON as `null`. Formatting
 * it without asking threw on the first real result file.
 */
const ms = (value: number | null | undefined): string =>
  value === null || value === undefined || Number.isNaN(value) ? 'n/a' : value.toFixed(3)
const num = (value: number | null | undefined): number =>
  value === null || value === undefined || Number.isNaN(value) ? 0 : value

const pct = (n: number, d: number): string => (d === 0 ? 'n/a' : `${((n / d) * 100).toFixed(0)}%`)
const cell = (r: M1RunResult): string =>
  `${r.config.workload}/${r.config.shape}/${r.config.eviction ? 'evict' : 'plain'}`
const profile = (r: M1RunResult): string =>
  `${r.config.latencyMs}ms/${r.config.order}/${r.config.reportTotal ? 'total' : 'no-total'}`

const runs = results.runs
const evictionOn = runs.filter((r) => r.config.eviction)
const evictionOff = runs.filter((r) => !r.config.eviction)

interface Gate {
  id: string
  name: string
  rule: string
  provenance: string
  pass: boolean
  evidence: string[]
}
const gates: Gate[] = []
const ruleOf = (id: string): { rule: string; provenance: string; name: string } => {
  const found = thresholds.acceptanceGates.find((g) => g.id === id)
  return {
    rule: found?.rule ?? '(missing from thresholds)',
    provenance: found?.provenance ?? 'unknown',
    name: found?.name ?? id,
  }
}
const gate = (id: string, pass: boolean, evidence: string[]): void => {
  gates.push({ id, ...ruleOf(id), pass, evidence })
}

// ---------------------------------------------------------------------------
// Measurement validity. Not acceptance gates: a benchmark that measured nothing
// produces passing gates, and a passing gate that was never asked a question is
// worse than a failing one because it looks like evidence.
// ---------------------------------------------------------------------------

const validity: { id: string; check: string; pass: boolean; detail: string }[] = []
const validate = (id: string, check: string, pass: boolean, detail: string): void => {
  validity.push({ id, check, pass, detail })
}

/**
 * Scoped per workload, not per run.
 *
 * A workload that does nothing on one shape is usually the shape talking. On
 * `mega-sibling` the root owns every other node, so nothing below the first level
 * is branchy and `drill` has no chain to descend and `jump` has no second parent to
 * open. That is a topology fact about the corpus, reported by V8, and it is not a
 * reason to distrust the numbers from the other four shapes. What would be a reason
 * is a workload that never does anything anywhere, because then whatever it
 * contributes to a gate is empty.
 */
const bestPerWorkload = new Map<string, number>()
for (const run of runs) {
  const held = bestPerWorkload.get(run.config.workload) ?? 0
  bestPerWorkload.set(run.config.workload, Math.max(held, run.requested))
}
const inertWorkloads = [...bestPerWorkload].filter(([, best]) => best < 3).map(([name]) => name)
const degenerate = runs.filter((r) => r.requested < 3)
validate(
  'V1',
  'every workload did real work on at least one shape',
  inertWorkloads.length === 0,
  inertWorkloads.length === 0
    ? `${bestPerWorkload.size} workloads; ${degenerate.length} of ${runs.length} individual runs ` +
        `were degenerate on their shape, listed under V8`
    : `inert everywhere: ${inertWorkloads.join(', ')}`,
)

const shuffled = runs.filter((r) => r.config.order === 'shuffled3')
const gapsUnderShuffle = shuffled.reduce((sum, r) => sum + r.outcomes.gap, 0)
validate(
  'V2',
  'shuffled arrival produced refused gaps',
  gapsUnderShuffle > 0,
  gapsUnderShuffle > 0
    ? `${gapsUnderShuffle} pages refused as gaps`
    : 'zero gaps under shuffled arrival. Demand asks only for the page after a ' +
        'parent loaded prefix, so two pages of one parent are never in flight together ' +
        'and a non-contiguous arrival is not reachable through the demand path. The gap ' +
        'branch is exercised by the scripted correctness traces, not by this benchmark.',
)

const totalEvictions = evictionOn.reduce((sum, r) => sum + r.evictions, 0)
validate(
  'V3',
  'eviction actually fired',
  totalEvictions > 0,
  `${totalEvictions} parents discarded across ${evictionOn.length} eviction-enabled runs`,
)

const nearBudget = runs.filter((r) => r.maxMaterializedRows >= B * 0.5)
validate(
  'V4',
  'some workload approached the budget (D8)',
  nearBudget.length > 0,
  nearBudget.length > 0
    ? `${nearBudget.length} runs reached at least half of B; peak ${Math.max(
        ...runs.map((r) => r.maxMaterializedRows),
      )} rows`
    : `no run exceeded ${B * 0.5} rows, so A1 passes without being asked a question`,
)

// Judged on in-order delivery only. The `shuffled3` dimension reorders arrivals by
// construction at every latency including zero, so including it would report the
// shuffle as evidence that latency does something.
const inOrderRuns = runs.filter((r) => r.config.order === 'inOrder')
const divergedAtLatency = inOrderRuns.some((r) => r.config.latencyMs > 0 && r.deliveryOrderDiverged)
const divergedAtZero = inOrderRuns.some((r) => r.config.latencyMs === 0 && r.deliveryOrderDiverged)
validate(
  'V5',
  'latency alone reordered arrivals',
  divergedAtLatency && !divergedAtZero,
  `with in-order delivery, reordering at latency>0: ${divergedAtLatency}; at 0ms: ${divergedAtZero}`,
)

const byCell = new Map<string, M1RunResult[]>()
for (const run of runs) {
  const key = cell(run)
  byCell.set(key, [...(byCell.get(key) ?? []), run])
}

/**
 * Convergence across arrival orders, scoped to where it is actually a claim.
 *
 * Eviction is excluded because it reads the row layout at sweep time, and a
 * different arrival order genuinely produces a different layout to sweep. `total`
 * reporting is held fixed because a source that supplies counts records different
 * coverage from one that does not, which is the point of that dimension. What
 * remains is the claim N8 makes: same requests, different arrival order, same end
 * state.
 *
 * `accumulate` is excluded and named rather than silently dropped: `scrollToEnd`
 * computes its target from the rows that exist at that moment, so the trace itself
 * is path-dependent and two orders legitimately visit different index spaces.
 */
const convergenceGroups = new Map<string, M1RunResult[]>()
for (const run of runs) {
  if (run.config.eviction || run.config.workload === 'accumulate') continue
  const key = `${run.config.workload}/${run.config.shape}/${run.config.reportTotal}`
  convergenceGroups.set(key, [...(convergenceGroups.get(key) ?? []), run])
}
const divergentCells: string[] = []
for (const [key, group] of convergenceGroups) {
  const prints = new Set(group.map((r) => r.fingerprint))
  if (prints.size > 1) divergentCells.push(`${key} (${prints.size} distinct final states)`)
}
validate(
  'V6',
  'final state converges across latency and arrival order',
  divergentCells.length === 0,
  divergentCells.length === 0
    ? `${convergenceGroups.size} groups, one final state each (eviction and W7 excluded, see source)`
    : divergentCells.slice(0, 6).join('; '),
)

const pressure = results.sequences.underPressure
validate(
  'V7',
  'generated sequences reached eviction',
  pressure.sequencesWithEviction > 0,
  `${pressure.sequencesWithEviction} of ${pressure.sequences} pressure sequences evicted ` +
    `(${pressure.evictions} parents); at B, ${results.sequences.atBudget.sequencesWithEviction} did`,
)

/**
 * Which cells the corpus, rather than the engine, cut short.
 *
 * Informational by design. It never voids a verdict, because the honest answer to
 * "W3 expands a parent with 500,000 children" on a corpus whose widest parent has
 * ten is that the workload cannot be run there, and hiding that would be worse than
 * reporting it.
 */
const topologyBlocked = [...byCell.entries()]
  .filter(([, group]) => (group[0]?.steps ?? 0) < 12)
  .map(([key, group]) => `${key} (${group[0]?.steps ?? 0} steps)`)
validate(
  'V8',
  'no cell was reduced to its opening by topology',
  topologyBlocked.length === 0,
  topologyBlocked.length === 0
    ? 'every cell ran a full trace'
    : `${topologyBlocked.length} cells, reported not penalised: ${[...new Set(topologyBlocked)]
        .slice(0, 8)
        .join(', ')}`,
)

// ---------------------------------------------------------------------------
// A1  bounded materialized rows
// ---------------------------------------------------------------------------

const overBudget = runs.filter((r) => r.maxMaterializedRows > B)
const overAfterStep = runs.filter((r) => r.maxRowsAfterStep > B)
const peakOf = (group: M1RunResult[], field: 'maxMaterializedRows' | 'maxRowsAfterStep'): number =>
  group.length === 0 ? 0 : Math.max(...group.map((r) => r[field]))
gate('A1', overBudget.length === 0, [
  `eviction on:  peak ${peakOf(evictionOn, 'maxMaterializedRows')} at any instant, ` +
    `${peakOf(evictionOn, 'maxRowsAfterStep')} once each step completed (limit ${B})`,
  `eviction off: peak ${peakOf(evictionOff, 'maxMaterializedRows')} at any instant, ` +
    `${peakOf(evictionOff, 'maxRowsAfterStep')} once each step completed`,
  ...(overBudget.length === 0
    ? []
    : [
        `${overBudget.length} of ${runs.length} runs exceeded B at some instant`,
        `${overAfterStep.length} still exceeded it after the step completed`,
        ...uniq(overBudget.map((r) => `  ${cell(r)}: ${r.maxMaterializedRows} rows`)),
        'AMBIGUITY: the rule says "max materialized rows", N2 says "after any operation',
        'completes". Judged here on the instantaneous peak, the stricter of the two.',
      ]),
])

// ---------------------------------------------------------------------------
// A2  synchronous structural-change latency, worst repeat
// ---------------------------------------------------------------------------

const worstSync = new Map<string, M1RunResult>()
for (const run of runs) {
  const key = cell(run)
  const held = worstSync.get(key)
  if (held === undefined || num(run.synchronous.p99) > num(held.synchronous.p99)) {
    worstSync.set(key, run)
  }
}
const breachedA2 = [...worstSync.values()].filter((r) => num(r.synchronous.p99) > FRAME_MS)
const worstStructuralOnly = Math.max(...runs.map((r) => num(r.structural.p99)))
const worstSweepOnly = Math.max(...runs.map((r) => num(r.sweepTime.p99)))
gate('A2', breachedA2.length === 0, [
  `worst-repeat p99, all synchronous work: ${Math.max(
    ...runs.map((r) => num(r.synchronous.p99)),
  ).toFixed(3)}ms (limit ${FRAME_MS}ms)`,
  `  of which projection work alone (expand, collapse, count, slice): ${worstStructuralOnly.toFixed(3)}ms`,
  `  of which eviction sweeps alone: ${worstSweepOnly.toFixed(3)}ms`,
  ...(breachedA2.length === 0
    ? []
    : [
        `${breachedA2.length} cells breach the frame budget:`,
        ...uniq(
          breachedA2
            .sort((a, b) => num(b.synchronous.p99) - num(a.synchronous.p99))
            .map(
              (r) =>
                `  ${cell(r).padEnd(34)} ${profile(r).padEnd(22)} sync p99 ${ms(r.synchronous.p99)}ms` +
                ` = projection ${ms(r.structural.p99)} + sweep ${ms(r.sweepTime.p99)}`,
            ),
        ),
      ]),
])

// ---------------------------------------------------------------------------
// A3  request amplification with eviction disabled, additive bound
// ---------------------------------------------------------------------------

const a3Breaches = evictionOff.filter((r) => r.requested > r.minimumPages + r.parentsEverVisible)
gate('A3', a3Breaches.length === 0, [
  `${evictionOff.length} eviction-disabled runs; ${a3Breaches.length} exceed minimum + parentsEverVisible`,
  ...uniq(
    a3Breaches
      .sort((a, b) => b.requested - b.minimumPages - (a.requested - a.minimumPages))
      .map(
        (r) =>
          `  ${cell(r).padEnd(34)} ${r.requested} requested vs bound ${
            r.minimumPages + r.parentsEverVisible
          } (min ${r.minimumPages} + ${r.parentsEverVisible} parents)` +
          `  [prefix-closed ${r.minimumPagesPrefixClosed}, achievable ${r.minimumPagesAchievable}]`,
      ),
  ),
])

// ---------------------------------------------------------------------------
// A4  request amplification with eviction enabled, POLICY 3.0x
// ---------------------------------------------------------------------------

const withMin = evictionOn.filter((r) => r.minimumPages > 0)
const a4Breaches = withMin.filter((r) => r.requested > AMPLIFICATION_POLICY * r.minimumPages)
const worstAmp = withMin.reduce((worst, r) => Math.max(worst, r.requested / r.minimumPages), 0)
gate('A4', a4Breaches.length === 0, [
  `POLICY threshold, not derived: ${AMPLIFICATION_POLICY}x. No calculation produces it.`,
  `worst eviction-on amplification against the §8 minimum: ${worstAmp.toFixed(2)}x`,
  `${a4Breaches.length} of ${withMin.length} runs exceed it`,
  ...uniq(
    a4Breaches
      .sort((a, b) => b.requested / b.minimumPages - a.requested / a.minimumPages)
      .map(
        (r) =>
          `  ${cell(r).padEnd(34)} ${(r.requested / r.minimumPages).toFixed(1)}x` +
          ` (${r.requested} requested, min ${r.minimumPages}, ${r.refetchesAfterEviction} refetched after eviction)`,
      ),
  ),
])

// ---------------------------------------------------------------------------
// A5  no wasted requests
// ---------------------------------------------------------------------------

const wasted = runs.filter((r) => r.duplicates > 0 || r.overlaps > 0)
gate('A5', wasted.length === 0, [
  `duplicates ${runs.reduce((s, r) => s + r.duplicates, 0)}, overlaps ${runs.reduce(
    (s, r) => s + r.overlaps,
    0,
  )} across ${runs.length} runs`,
  'scoped per eviction epoch: a page refetched after its coverage was discarded is not',
  'the same question asked twice, and §8 puts that cost in amplification instead.',
  `refetches after eviction, reported separately: ${runs.reduce(
    (s, r) => s + r.refetchesAfterEviction,
    0,
  )}`,
  ...uniq(wasted.map((r) => `  ${cell(r)}: ${r.duplicates} dup, ${r.overlaps} overlap`)),
])

// ---------------------------------------------------------------------------
// A6  retained heap
// ---------------------------------------------------------------------------

/**
 * Heap readings below this are noise, not measurements.
 *
 * A `heapUsed` delta across a forced collection resolves tens of kilobytes at best,
 * and several cells here load a handful of nodes: one reported 960 bytes for 265
 * node records, which is under four bytes each and cannot be true. Cells below the
 * floor are excluded and counted rather than averaged in, because a ratio built on
 * a denominator that is mostly measurement error is not evidence in either
 * direction.
 */
const HEAP_SIGNAL_FLOOR_BYTES = 65_536
const measurableHeaps = results.heaps.filter(
  (h) => Number.isFinite(h.ratio) && h.recordBytes >= HEAP_SIGNAL_FLOOR_BYTES,
)
const heapBreaches = measurableHeaps.filter((h) => h.ratio > HEAP_RATIO)
gate('A6', measurableHeaps.length > 0 && heapBreaches.length === 0, [
  `${measurableHeaps.length} of ${results.heaps.length} heap measurements cleared the ` +
    `${HEAP_SIGNAL_FLOOR_BYTES}-byte signal floor; the rest are too small to resolve`,
  `worst ratio ${
    measurableHeaps.length === 0
      ? 'n/a'
      : Math.max(...measurableHeaps.map((h) => h.ratio)).toFixed(2)
  }x (limit ${HEAP_RATIO}x)`,
  ...heapBreaches
    .sort((a, b) => b.ratio - a.ratio)
    .slice(0, 8)
    .map(
      (h) =>
        `  ${h.workload}/${h.shape}/${h.eviction ? 'evict' : 'plain'}: ${h.ratio.toFixed(2)}x` +
        ` (${h.engineBytes} engine bytes vs ${h.recordBytes} record bytes, ${h.loadedNodes} nodes)`,
    ),
])

// ---------------------------------------------------------------------------
// A7  correctness under arbitrary interaction
// ---------------------------------------------------------------------------

const sequences = results.sequences.atBudget.sequences + results.sequences.underPressure.sequences
const sequenceViolations = [
  ...results.sequences.atBudget.violations,
  ...results.sequences.underPressure.violations,
]
const traceViolations = runs.filter((r) => r.violations.length > 0)
gate('A7', sequenceViolations.length === 0 && sequences >= REQUIRED_SEQUENCES, [
  `${sequences} generated sequences (${REQUIRED_SEQUENCES} required), ${sequenceViolations.length} violations`,
  'COVERAGE GAP: this tool checks N1 to N11 only. The rule names I1 to I15 as well,',
  'and those are gated by the core conformance suite under `npm run test:deep`, which',
  'this file cannot read. A7 passing here is half of what A7 says.',
  ...sequenceViolations.slice(0, 8).map((v) => `  ${v}`),
  ...(traceViolations.length === 0
    ? []
    : [
        `SEPARATELY: ${traceViolations.length} of ${runs.length} workload runs violated an`,
        'invariant. A7 as written covers generated sequences, not workloads, so these are',
        'reported here rather than folded into the gate. They are still violations.',
        ...uniq(traceViolations.map((r) => `  ${cell(r)}: ${r.violations[0] ?? ''}`)),
      ]),
])

// ---------------------------------------------------------------------------
// A8  the D2 limitation is bounded
// ---------------------------------------------------------------------------

const regressions = runs.filter((r) => r.countRegressions > 0)
const falseExact = runs.filter((r) => r.countExactWhenIncomplete > 0)
gate('A8', regressions.length === 0 && falseExact.length === 0, [
  `count regressions outside collapse and eviction: ${runs.reduce(
    (s, r) => s + r.countRegressions,
    0,
  )}`,
  `count reported exact while a visible parent was incomplete: ${runs.reduce(
    (s, r) => s + r.countExactWhenIncomplete,
    0,
  )}`,
  ...regressions.slice(0, 5).map((r) => `  regression in ${cell(r)}: ${r.countRegressions}`),
  ...falseExact
    .slice(0, 5)
    .map((r) => `  false exact in ${cell(r)}: ${r.countExactWhenIncomplete}`),
])

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

const line = '='.repeat(96)
say()
say('M1 verdict')
say(`thresholds pre-registered ${thresholds.preRegisteredOn}, B = ${B} rows, frame ${FRAME_MS}ms`)
say(`results commit ${results.commit}   started ${results.started}`)
say(`control workload ${results.controlWorkloadMs.toFixed(2)}ms`)
say(
  `${runs.length} runs over ${byCell.size} cells, ${results.heaps.length} heap measurements, ${sequences} sequences`,
)
say(line)

say()
say('-- MEASUREMENT VALIDITY (not acceptance gates; a vacuous benchmark passes everything)')
for (const v of validity) {
  say(`   ${v.pass ? 'OK  ' : 'WARN'} ${v.id} ${v.check.padEnd(52)} ${v.detail}`)
}

say()
say('-- ACCEPTANCE GATES')
for (const g of gates) {
  say()
  say(`   ${g.pass ? 'PASS' : 'FAIL'}  ${g.id}  ${g.name}`)
  say(`         rule: ${g.rule}`)
  say(`         provenance: ${g.provenance}`)
  for (const e of g.evidence) say(`         ${e}`)
}

say()
say('-- DIAGNOSTICS')
say(`   D1  structural p50 ${ms(Math.max(...runs.map((r) => num(r.structural.p50))))}ms,`)
say(
  `       p95 ${ms(Math.max(...runs.map((r) => num(r.structural.p95))))}ms (reported, never a gate)`,
)
say(`   D2  pages requested, total ${runs.reduce((s, r) => s + r.requested, 0)}`)
say('   D3  amplification by workload and shape:')
const byWorkload = new Map<string, M1RunResult[]>()
for (const run of runs) {
  const key = `${run.config.workload}/${run.config.shape}`
  byWorkload.set(key, [...(byWorkload.get(key) ?? []), run])
}
for (const [key, group] of [...byWorkload].sort()) {
  const on = group.filter((r) => r.config.eviction && r.minimumPages > 0)
  const off = group.filter((r) => !r.config.eviction && r.minimumPages > 0)
  const amp = (g: M1RunResult[]): string =>
    g.length === 0
      ? '   n/a'
      : `${Math.max(...g.map((r) => r.requested / r.minimumPages)).toFixed(2)}x`
  say(
    `       ${key.padEnd(30)} evict-off ${amp(off).padStart(8)}   evict-on ${amp(on).padStart(8)}` +
      `   peak rows ${Math.max(...group.map((r) => r.maxMaterializedRows))
        .toString()
        .padStart(7)}`,
  )
}
say(
  `   D4  retained heap, worst engine bytes ${
    results.heaps.length === 0 ? 'n/a' : Math.max(...results.heaps.map((h) => h.engineBytes))
  }`,
)
say('   D5  partial versus sized locality: not measured in M1; it was a calibration statistic')
say(
  `   D6  time to first row: ${[...new Set(runs.map((r) => r.config.latencyMs))]
    .sort((a, b) => a - b)
    .map((l) => {
      const g = runs.filter((r) => r.config.latencyMs === l && r.timeToFirstRowMs >= 0)
      return `${l}ms -> ${g.length === 0 ? 'n/a' : Math.max(...g.map((r) => r.timeToFirstRowMs)).toFixed(0)}ms`
    })
    .join(', ')} (simulated clock)`,
)
say(`   D7  count-correction events, total ${runs.reduce((s, r) => s + r.countCorrections, 0)}`)
say(
  `   D8  peak rows as a fraction of B: ${pct(
    Math.max(...runs.map((r) => r.maxMaterializedRows)),
    B,
  )} worst, ${nearBudget.length} of ${runs.length} runs above half`,
)

/**
 * REVERSE condition 2, computed rather than argued.
 *
 * Pre-registered as "bounded materialisation cannot be achieved at all, meaning
 * some workload drives rows past B with eviction enabled and every row inside the
 * protected window". The measurable form is a run that ends a step above B with
 * eviction enabled, having discarded nothing, because everything left was
 * protected. `stuck` is the evictor reporting exactly that.
 */
const cannotBound = evictionOn.filter(
  (r) => r.maxRowsAfterStep > B && r.stuckSweeps > 0 && r.evictions === 0,
)
say()
say('-- REVERSE CONDITION 2 (pre-registered): can bounded materialisation be achieved?')
if (cannotBound.length === 0) {
  say('   No run was left above B with eviction enabled and nothing it was allowed to')
  say('   discard. Where the budget was exceeded, eviction had candidates.')
} else {
  say(`   ${cannotBound.length} runs exceeded B with eviction enabled and evicted nothing,`)
  say('   because every loaded parent was inside the protected window:')
  for (const s2 of uniq(
    cannotBound.map(
      (r) =>
        `     ${cell(r)}: ${r.maxRowsAfterStep} rows after the step, ` +
        `${r.stuckSweeps} of ${r.sweeps} sweeps stuck, 0 evicted`,
    ),
  )) {
    say(s2)
  }
  say('   The pre-registered wording says "every row inside the protected window"; what is')
  say('   measured is that every eviction *candidate* was protected. Whether those are the')
  say('   same claim is a wording question, and it is commit 10 that answers it.')
}

say()
say('-- RECORDED CONTRADICTIONS (commit 8 and commit 9; not resolved here)')
say('   N2 versus REVERSE: N2 forbids exceeding the budget unconditionally, while the')
say('   pre-registered REVERSE condition names a state in which rows must exceed it. Both')
say(
  `   cannot hold. Sweeps that reported themselves stuck: ${runs.reduce((s, r) => s + r.stuckSweeps, 0)}.`,
)
say('   §8 minimum versus D2: §8 counts a page as necessary only when a slot of it was')
say('   visible, but a prefix store cannot fetch page k without pages 0..k-1, and expanding')
say('   a node forces its first page whether or not it is looked at. A3 and A4 above are')
say('   computed against §8 as committed; the achievable minimum is printed beside them.')

say()
say(line)
const failed = gates.filter((g) => !g.pass)
const validityFailed = validity.filter((v) => !v.pass)

let verdict: string
// Only the checks that would make a gate vacuous can void the verdict. V3 and V4
// are those: without eviction firing and without a workload reaching the budget,
// A1 and A4 pass by not being asked. V1 joins them only when a workload is inert on
// every shape. The rest are reported and do not decide anything.
const voiding = validityFailed.filter((v) => v.id === 'V1' || v.id === 'V3' || v.id === 'V4')
if (voiding.length > 0) {
  verdict = 'INVALID'
  say('The benchmark did not exercise what the gates claim to judge. A verdict computed')
  say('on it would not be a verdict. Failing validity checks:')
  for (const v of voiding) say(`   ${v.id} ${v.check}: ${v.detail}`)
} else if (failed.length === 0) {
  verdict = 'CONFIRM'
  say('Every acceptance gate passed in every workload, shape and latency profile.')
} else {
  const a1 = gates.find((g) => g.id === 'A1')?.pass === true
  const a2 = gates.find((g) => g.id === 'A2')?.pass === true
  const onlyA4 = failed.length === 1 && failed[0]?.id === 'A4'
  if (cannotBound.length > 0) {
    verdict = 'REVERSE'
    say('REVERSE condition 2, pre-registered: some workload drives rows past B with eviction')
    say('enabled and nothing left that may be discarded. Bounded materialisation is not')
    say('achievable on every shape, which is the second of the two pre-registered ways the')
    say('central hypothesis fails.')
  } else if (!a2 && a1) {
    verdict = 'REVERSE'
    say('REVERSE condition 1, pre-registered: synchronous p99 exceeds the frame budget while')
    say('materialized rows are within B. Bounded rows are not sufficient, which is exactly')
    say('what §1 claimed and what this falsifies.')
  } else if (onlyA4 && worstAmp <= 6.0) {
    verdict = 'NARROW'
    say('Every gate except A4 passes, and eviction-on amplification is between 3.0x and 6.0x.')
    say('M1 ships with eviction disabled by default and the measured cost documented.')
  } else {
    verdict = 'FAIL'
    say(`${failed.length} acceptance gate(s) failed: ${failed.map((g) => g.id).join(', ')}.`)
    say('This combination is not one the pre-registration named, so no outcome label is')
    say('claimed here. Commit 10 decides what it means.')
  }
  say()
  for (const g of failed) say(`   FAILED ${g.id}  ${g.name}: ${g.evidence[0] ?? ''}`)
}

say()
say(`VERDICT: ${verdict}`)
say()
process.stdout.write(out.join('\n'))
