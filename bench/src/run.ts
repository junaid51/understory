import { execSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { cpus, totalmem } from 'node:os'
import { MaterializedProjection, approximate } from '@understory/core'
import { SHAPES, generate, type ShapeName } from './corpus.js'
import { collectGarbage, controlWorkload, measure, retainedHeap } from './harness.js'
import { SCENARIOS, analyse } from './scenarios.js'

const SIZES = (process.env['UNDERSTORY_SIZES'] ?? '1000,10000,100000,1000000')
  .split(',')
  .map((s) => Number.parseInt(s, 10))

const SHAPE_FILTER = process.env['UNDERSTORY_SHAPES']?.split(',') as ShapeName[] | undefined
const SHAPE_LIST = SHAPE_FILTER ?? SHAPES
const UNLOADED_FRACTION = Number(process.env['UNDERSTORY_UNLOADED'] ?? '0.05')

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
  /** Per-operation figures for batched scenarios, so thresholds can be read directly. */
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

function main(): void {
  const started = new Date().toISOString()
  const control = controlWorkload()
  const measurements: Measurement[] = []
  const heaps: HeapMeasurement[] = []

  for (const shape of SHAPE_LIST) {
    for (const nodes of SIZES) {
      process.stderr.write(`${shape} @ ${nodes}\n`)
      collectGarbage()
      const before = retainedHeap()
      const store = generate(shape, { nodes, seed: 42, unloadedFraction: UNLOADED_FRACTION })
      const storeBytes = retainedHeap() - before

      const ctx = analyse(store)

      // Heap held by a fully expanded projection, separate from the store itself.
      const heapBefore = retainedHeap()
      const projection = new MaterializedProjection(store)
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
        const stats = measure(op, scenario.samples)
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
      }
      collectGarbage()
    }
  }

  const cpu = cpus()[0]?.model ?? 'unknown'
  const result = {
    implementation: 'materialized',
    commit: gitSha(),
    started,
    finished: new Date().toISOString(),
    environment: {
      node: process.version,
      platform: `${process.platform}-${process.arch}`,
      cpu: process.env['CI'] === 'true' ? cpu : 'local (model withheld)',
      cpuCount: cpus().length,
      totalMemoryBytes: totalmem(),
      ci: process.env['CI'] === 'true',
      runner: process.env['RUNNER_NAME'] ?? null,
    },
    controlWorkloadMs: control,
    unloadedFraction: UNLOADED_FRACTION,
    measurements,
    heaps,
  }

  mkdirSync('bench/results', { recursive: true })
  const name = `bench/results/materialized-${process.env['CI'] === 'true' ? 'ci' : 'local'}-${started.slice(0, 10)}.json`
  writeFileSync(name, `${JSON.stringify(result, null, 2)}\n`)
  process.stderr.write(`\nwrote ${name}\n`)
  process.stdout.write(JSON.stringify({ file: name, control, count: measurements.length }, null, 2))
}

main()
