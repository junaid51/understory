import { execSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { cpus, totalmem } from 'node:os'
import {
  MaterializedProjection,
  SpanProjection,
  approximate,
  type Projection,
  type TreeStore,
} from '@understory/core'
import { SHAPES, generate, type ShapeName } from './corpus.js'
import { collectGarbage, controlWorkload, measure, retainedHeap } from './harness.js'
import { SCENARIOS, analyse } from './scenarios.js'

const SIZES = (process.env['UNDERSTORY_SIZES'] ?? '1000,10000,100000,1000000')
  .split(',')
  .map((s) => Number.parseInt(s, 10))
const SHAPE_FILTER = process.env['UNDERSTORY_SHAPES']?.split(',') as ShapeName[] | undefined
const SHAPE_LIST = SHAPE_FILTER ?? SHAPES
const UNLOADED_FRACTION = Number(process.env['UNDERSTORY_UNLOADED'] ?? '0.05')
const IMPL = process.env['UNDERSTORY_IMPL'] ?? 'materialized'
const FACTORIES: Record<string, (store: TreeStore) => Projection> = {
  materialized: (store) => new MaterializedProjection(store),
  span: (store) => new SpanProjection(store),
}
const factory = FACTORIES[IMPL]
if (factory === undefined) throw new Error(`unknown implementation ${IMPL}`)
const make: (store: TreeStore) => Projection = factory

interface Measurement {
  readonly shape: ShapeName
  readonly nodes: number
  readonly scenario: string
  readonly batch: number
  readonly samples: number
  readonly meanMs: number
  readonly p50Ms: number
  readonly p95Ms: number
  readonly p99Ms: number
  readonly maxMs: number
  readonly perOpMeanUs: number
  readonly perOpP99Us: number
}

interface HeapMeasurement {
  readonly shape: ShapeName
  readonly nodes: number
  readonly storeBytes: number
  readonly projectionBytes: number
  readonly ratio: number
  readonly rows: number
}

const gitSha = (): string => {
  try {
    return execSync('git rev-parse --short HEAD', { encoding: 'utf8' }).trim()
  } catch {
    return 'unknown'
  }
}

let snapshotPath = ''

/** Written after every (shape, size) so a long run cannot lose everything. */
function writeSnapshot(
  measurements: readonly Measurement[],
  heaps: readonly HeapMeasurement[],
  control: number,
  started: string,
): void {
  const isCi = process.env['CI'] === 'true'
  const result = {
    implementation: IMPL,
    commit: gitSha(),
    started,
    finished: new Date().toISOString(),
    environment: {
      node: process.version,
      platform: `${process.platform}-${process.arch}`,
      // Withheld locally: a CPU model from a personal machine is an
      // unnecessary disclosure, and local runs are supplementary anyway.
      cpu: isCi ? (cpus()[0]?.model ?? 'unknown') : 'local (model withheld)',
      cpuCount: cpus().length,
      totalMemoryBytes: totalmem(),
      ci: isCi,
      runner: process.env['RUNNER_NAME'] ?? null,
    },
    controlWorkloadMs: control,
    unloadedFraction: UNLOADED_FRACTION,
    measurements,
    heaps,
  }
  mkdirSync('bench/results', { recursive: true })
  if (snapshotPath === '') {
    snapshotPath = `bench/results/${IMPL}-${isCi ? 'ci' : 'local'}-${started.slice(0, 10)}.json`
  }
  writeFileSync(snapshotPath, `${JSON.stringify(result, null, 2)}\n`)
}

function main(): void {
  const started = new Date().toISOString()
  const control = controlWorkload()
  process.stderr.write(`control workload ${control.toFixed(2)}ms\n`)
  const measurements: Measurement[] = []
  const heaps: HeapMeasurement[] = []

  for (const shape of SHAPE_LIST) {
    for (const nodes of SIZES) {
      process.stderr.write(`\n${shape} @ ${nodes}\n`)
      collectGarbage()
      const before = retainedHeap()
      const store = generate(shape, { nodes, seed: 42, unloadedFraction: UNLOADED_FRACTION })
      const storeBytes = retainedHeap() - before
      const ctx = analyse(store, make)

      const heapBefore = retainedHeap()
      const projection = make(store)
      for (const id of ctx.ids) projection.expand(id)
      const rows = approximate(projection.count())
      const projectionBytes = retainedHeap() - heapBefore
      heaps.push({
        shape,
        nodes,
        storeBytes,
        projectionBytes,
        ratio: storeBytes > 0 ? projectionBytes / storeBytes : Number.NaN,
        rows,
      })

      for (const scenario of SCENARIOS) {
        const op = scenario.prepare(ctx)
        const samples =
          nodes >= 1_000_000 ? (scenario.samplesAtMillion ?? scenario.samples) : scenario.samples
        const clock = Date.now()
        const stats = measure(op, samples)
        const batch = scenario.batch ?? 1
        measurements.push({
          shape,
          nodes,
          scenario: scenario.name,
          batch,
          samples: stats.samples,
          meanMs: stats.mean,
          p50Ms: stats.p50,
          p95Ms: stats.p95,
          p99Ms: stats.p99,
          maxMs: stats.max,
          perOpMeanUs: (stats.mean * 1000) / batch,
          perOpP99Us: (stats.p99 * 1000) / batch,
        })
        process.stderr.write(
          `  ${scenario.name.padEnd(24)} n=${String(samples).padStart(4)}  p99=${stats.p99.toFixed(3)}ms  (${((Date.now() - clock) / 1000).toFixed(1)}s)\n`,
        )
      }

      writeSnapshot(measurements, heaps, control, started)
      collectGarbage()
    }
  }

  writeSnapshot(measurements, heaps, control, started)
  process.stderr.write(`\nwrote ${snapshotPath}\n`)
  process.stdout.write(
    JSON.stringify({ file: snapshotPath, control, count: measurements.length }, null, 2),
  )
}

main()
