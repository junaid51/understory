import { execSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { cpus, totalmem } from 'node:os'
import { SHAPES, generate, type ShapeName } from '../corpus.js'
import { collectGarbage, controlWorkload } from '../harness.js'
import { runSequences, type SequenceReport } from './sequences.js'
import { measureHeap, runM1, type HeapResult, type M1Config, type M1RunResult } from './runner.js'
import type { ArrivalOrder } from './instrument.js'
import { WORKLOAD_NAMES, type WorkloadName } from './traces.js'

/**
 * The M1 measurement run.
 *
 * Measures the M1 system exactly as designed: D2 loaded-prefix coverage,
 * viewport-driven demand, page loading through `HierarchySource`, bounded
 * materialisation through `BudgetEvictor`. No `expandAll`, no span index, no
 * placeholder materialisation. `mega-sibling` is included rather than excluded;
 * it is the shape most likely to break something.
 *
 * This file measures and records. It computes no verdict and argues no result:
 * `verdict.ts` reads what this writes and applies the thresholds committed in
 * `bench/thresholds.m1.json` before any of this existed.
 */

interface Thresholds {
  budget: { materializedRows: number; structuralChangeMs: number }
  acceptanceGates: { id: string; name: string; rule: string }[]
}

const thresholds = JSON.parse(readFileSync('bench/thresholds.m1.json', 'utf8')) as Thresholds
const B = thresholds.budget.materializedRows

const NODES = Number(process.env['UNDERSTORY_M1_NODES'] ?? '1000000')
const REPEATS = Number(process.env['UNDERSTORY_M1_REPEATS'] ?? '3')
const SEQUENCES = Number(process.env['UNDERSTORY_M1_SEQUENCES'] ?? '10000')
const SHAPE_LIST = (process.env['UNDERSTORY_SHAPES']?.split(',') as ShapeName[]) ?? SHAPES
const WORKLOAD_LIST =
  (process.env['UNDERSTORY_M1_WORKLOADS']?.split(',') as WorkloadName[]) ?? WORKLOAD_NAMES

const LATENCIES = [0, 50, 250]
const ORDERS: ArrivalOrder[] = ['inOrder', 'shuffled3']
const TOTALS = [true, false]
const EVICTION = [false, true]

/**
 * The profile that gets the repeats.
 *
 * A2 asks for a *worst-repeat* p99, which needs the same configuration measured
 * more than once. Repeating all twelve network profiles as well would multiply a
 * run that already takes minutes by three for a statistic that does not depend on
 * the network: the simulated clock adds no synchronous work. Every profile is
 * therefore measured once, and one profile is measured `REPEATS` times, which is
 * where the worst-repeat statistic comes from. Reported so the reader can see which
 * number carries the repeats.
 */
const REPEATED_PROFILE = { latencyMs: 50, order: 'shuffled3' as ArrivalOrder, reportTotal: true }

const emptySequences: SequenceReport = {
  sequences: 0,
  steps: 0,
  violations: [],
  failures: [],
  opCounts: {},
  sequencesWithLoadedWork: 0,
  sequencesWithEviction: 0,
  evictions: 0,
  maxRowsSeen: 0,
}

const gitSha = (): string => {
  try {
    return execSync('git rev-parse --short HEAD', { encoding: 'utf8' }).trim()
  } catch {
    return 'unknown'
  }
}

interface ResultFile {
  milestone: 'M1'
  commit: string
  started: string
  finished: string
  environment: Record<string, unknown>
  controlWorkloadMs: number
  parameters: Record<string, unknown>
  runs: M1RunResult[]
  heaps: (HeapResult & { shape: ShapeName; workload: WorkloadName; eviction: boolean })[]
  sequences: { atBudget: SequenceReport; underPressure: SequenceReport }
}

let outPath = ''

function write(file: ResultFile): void {
  mkdirSync('bench/results', { recursive: true })
  if (outPath === '') {
    const where = process.env['CI'] === 'true' ? 'ci' : 'local'
    outPath = `bench/results/m1-${where}-${file.started.slice(0, 10)}.json`
  }
  writeFileSync(outPath, `${JSON.stringify(file, null, 2)}\n`)
}

async function main(): Promise<void> {
  const started = new Date().toISOString()
  const control = controlWorkload()
  process.stderr.write(`control workload ${control.toFixed(2)}ms\n`)
  process.stderr.write(`B = ${B} rows (from bench/thresholds.m1.json)\n`)

  const runs: M1RunResult[] = []
  const heaps: ResultFile['heaps'] = []

  const file = (): ResultFile => ({
    milestone: 'M1',
    commit: gitSha(),
    started,
    finished: new Date().toISOString(),
    environment: {
      node: process.version,
      platform: `${process.platform}-${process.arch}`,
      // Withheld locally: a CPU model from a personal machine is an unnecessary
      // disclosure, and local runs are supplementary anyway.
      cpu: process.env['CI'] === 'true' ? (cpus()[0]?.model ?? 'unknown') : 'local (withheld)',
      cpuCount: cpus().length,
      totalMemoryBytes: totalmem(),
      ci: process.env['CI'] === 'true',
    },
    controlWorkloadMs: control,
    parameters: {
      nodes: NODES,
      budget: B,
      pageSize: 100,
      viewportRows: 40,
      overscan: 20,
      repeats: REPEATS,
      repeatedProfile: REPEATED_PROFILE,
      latencies: LATENCIES,
      orders: ORDERS,
      reportTotals: TOTALS,
      eviction: EVICTION,
      latencyModel: 'virtual clock with seeded jitter of +/-40% of latency; no wall-clock timers',
      sequences: SEQUENCES,
    },
    runs,
    heaps,
    sequences: { atBudget: emptySequences, underPressure: emptySequences },
  })

  for (const shape of SHAPE_LIST) {
    const genStart = Date.now()
    const truth = generate(shape, { nodes: NODES, seed: 42 })
    process.stderr.write(
      `\n${shape} @ ${NODES} nodes (generated in ${((Date.now() - genStart) / 1000).toFixed(1)}s)\n`,
    )

    for (const workload of WORKLOAD_LIST) {
      const cellStart = Date.now()
      for (const eviction of EVICTION) {
        for (const latencyMs of LATENCIES) {
          for (const order of ORDERS) {
            for (const reportTotal of TOTALS) {
              const repeated =
                latencyMs === REPEATED_PROFILE.latencyMs &&
                order === REPEATED_PROFILE.order &&
                reportTotal === REPEATED_PROFILE.reportTotal
              const times = repeated ? REPEATS : 1
              for (let repeat = 0; repeat < times; repeat++) {
                const config: M1Config = {
                  workload,
                  shape,
                  nodes: NODES,
                  latencyMs,
                  order,
                  reportTotal,
                  eviction,
                  budget: B,
                  pageSize: 100,
                  overscan: 20,
                  viewportRows: 40,
                  seed: 1000 + repeat,
                }
                runs.push(await runM1(truth, config))
              }
            }
          }
        }
        heaps.push({
          shape,
          workload,
          eviction,
          ...(await measureHeap(truth, {
            workload,
            shape,
            nodes: NODES,
            latencyMs: 0,
            order: 'inOrder',
            reportTotal: true,
            eviction,
            budget: B,
            pageSize: 100,
            overscan: 20,
            viewportRows: 40,
            seed: 1000,
          })),
        })
      }
      process.stderr.write(
        `  ${workload.padEnd(13)} ${((Date.now() - cellStart) / 1000).toFixed(1)}s\n`,
      )
      write(file())
    }
    collectGarbage()
  }

  // A7, twice. The first pass runs at the calibrated budget, which is the
  // configuration the product ships. The second runs at a budget a generated
  // sequence can actually reach, because at `B` these sequences peak near 600 rows
  // and eviction never fires: N2, N3 and N10 would all pass without being asked
  // anything. Violations from both passes count, so this only ever strengthens A7.
  process.stderr.write(`\nA7: ${SEQUENCES} sequences at B, then ${SEQUENCES} under pressure\n`)
  const atBudget = await runSequences({
    sequences: SEQUENCES,
    stepsPerSequence: 20,
    nodes: 20_000,
    seed: 90_000,
    budget: B,
    pageSize: 100,
  })
  const underPressure = await runSequences({
    sequences: SEQUENCES,
    stepsPerSequence: 20,
    nodes: 20_000,
    seed: 500_000,
    budget: 200,
    pageSize: 100,
  })

  const final = file()
  final.sequences = { atBudget, underPressure }
  write(final)

  process.stderr.write(`\nwrote ${outPath}\n`)
  process.stdout.write(
    `${JSON.stringify({ file: outPath, runs: runs.length, heaps: heaps.length }, null, 2)}\n`,
  )
}

await main()
