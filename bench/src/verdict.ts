import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Computes the ADR-0002 verdict from committed thresholds and committed results.
 *
 * The point of this file is that nobody writes the verdict by hand. If the
 * output ever needs arguing with, that argument belongs in the write-up as its
 * own finding rather than replacing the number.
 */

interface Measurement {
  shape: string
  nodes: number
  scenario: string
  p99Ms: number
  perOpP99Us: number
  [key: string]: unknown
}

interface HeapMeasurement {
  shape: string
  nodes: number
  ratio: number
}

interface ResultFile {
  implementation: string
  commit: string
  environment: Record<string, unknown>
  controlWorkloadMs: number
  measurements: Measurement[]
  heaps: HeapMeasurement[]
}

interface Threshold {
  scenario: string
  stat: 'p99Ms' | 'perOpP99Us'
  max: number
  unit: string
  rationale: string
  caveat?: string
}

const RESULTS_DIR = 'bench/results'

function latest(implementation: string): ResultFile | undefined {
  let files: string[]
  try {
    files = readdirSync(RESULTS_DIR).filter(
      (f) => f.startsWith(`${implementation}-`) && f.endsWith('.json'),
    )
  } catch {
    return undefined
  }
  const chosen = files.sort().at(-1)
  if (chosen === undefined) return undefined
  return JSON.parse(readFileSync(join(RESULTS_DIR, chosen), 'utf8')) as ResultFile
}

const thresholds = JSON.parse(readFileSync('bench/thresholds.json', 'utf8')) as {
  scale: { nodes: number }
  baselineMustSatisfy: Threshold[]
  heap: { maxProjectionToStoreRatio: number }
  spanMustImproveBreachedMetricsBy: { factor: number }
  spanRegressionMustBeReported: { scenarios: string[]; factor: number }
  shapeClassification: { pathological: string[]; common: string[] }
}

const baseline = latest('materialized')
if (baseline === undefined) {
  process.stderr.write('no materialized results in bench/results. Run `npm run bench` first.\n')
  process.exit(2)
}
const span = latest('span')

const at = (file: ResultFile, shape: string, scenario: string): Measurement | undefined =>
  file.measurements.find(
    (m) => m.shape === shape && m.scenario === scenario && m.nodes === thresholds.scale.nodes,
  )

const shapes = [...new Set(baseline.measurements.map((m) => m.shape))].sort()

interface Breach {
  shape: string
  scenario: string
  stat: string
  observed: number
  max: number
  unit: string
  factorOver: number
}

const breaches: Breach[] = []
const rows: string[] = []

for (const threshold of thresholds.baselineMustSatisfy) {
  for (const shape of shapes) {
    const measurement = at(baseline, shape, threshold.scenario)
    if (measurement === undefined) continue
    const observed = Number(measurement[threshold.stat])
    const pass = observed <= threshold.max
    if (!pass) {
      breaches.push({
        shape,
        scenario: threshold.scenario,
        stat: threshold.stat,
        observed,
        max: threshold.max,
        unit: threshold.unit,
        factorOver: observed / threshold.max,
      })
    }
    rows.push(
      `${pass ? 'PASS' : 'FAIL'}  ${threshold.scenario.padEnd(24)} ${shape.padEnd(18)} ${observed.toFixed(3).padStart(12)} ${threshold.unit.padEnd(3)} limit ${String(threshold.max).padStart(6)}${pass ? '' : `   ${(observed / threshold.max).toFixed(1)}x over`}`,
    )
  }
}

for (const heap of baseline.heaps.filter((h) => h.nodes === thresholds.scale.nodes)) {
  const pass = heap.ratio <= thresholds.heap.maxProjectionToStoreRatio
  if (!pass) {
    breaches.push({
      shape: heap.shape,
      scenario: 'retained-heap',
      stat: 'ratio',
      observed: heap.ratio,
      max: thresholds.heap.maxProjectionToStoreRatio,
      unit: 'x',
      factorOver: heap.ratio / thresholds.heap.maxProjectionToStoreRatio,
    })
  }
  rows.push(
    `${pass ? 'PASS' : 'FAIL'}  ${'retained-heap'.padEnd(24)} ${heap.shape.padEnd(18)} ${heap.ratio.toFixed(3).padStart(12)} x   limit ${String(thresholds.heap.maxProjectionToStoreRatio).padStart(6)}`,
  )
}

const out: string[] = []
out.push('')
out.push(`ADR-0002 verdict    thresholds pre-registered ${'2026-09-05'}`)
out.push(
  `baseline commit ${baseline.commit}   control workload ${baseline.controlWorkloadMs.toFixed(2)}ms`,
)
out.push(`span results: ${span === undefined ? 'none yet' : `commit ${span.commit}`}`)
out.push('-'.repeat(100))
out.push(...rows)
out.push('-'.repeat(100))

const breachedShapes = [...new Set(breaches.map((b) => b.shape))]
const commonBreached = breachedShapes.filter((s) =>
  thresholds.shapeClassification.common.includes(s),
)

let verdict: string
if (breaches.length === 0) {
  verdict = 'REVERSE'
  out.push('The materialized baseline satisfies every pre-registered threshold on every shape.')
  out.push('The span index space is not built. ADR-0002 is withdrawn.')
} else if (span === undefined) {
  verdict = 'PENDING-SPAN'
  out.push(
    `${breaches.length} breach(es) on ${breachedShapes.length} shape(s): ${breachedShapes.join(', ')}`,
  )
  for (const b of breaches) {
    out.push(
      `  ${b.scenario} @ ${b.shape}: ${b.observed.toFixed(3)}${b.unit} vs ${b.max}${b.unit} (${b.factorOver.toFixed(1)}x over)`,
    )
  }
  out.push('')
  out.push(
    commonBreached.length > 0
      ? `Breaches include common shapes (${commonBreached.join(', ')}), so the candidate outcome is CONFIRM if the span tree delivers 3x at p99 on each breached metric.`
      : 'Breaches are confined to pathological shapes, so the candidate outcome is NARROW.',
  )
} else {
  const shortfalls: string[] = []
  for (const b of breaches) {
    const spanMeasurement = at(span, b.shape, b.scenario)
    if (spanMeasurement === undefined) continue
    const observed = Number(spanMeasurement[b.stat as keyof Measurement])
    const improvement = b.observed / observed
    const enough = improvement >= thresholds.spanMustImproveBreachedMetricsBy.factor
    out.push(
      `${enough ? 'MEETS' : 'SHORT'} ${b.scenario} @ ${b.shape}: ${improvement.toFixed(2)}x improvement (need ${thresholds.spanMustImproveBreachedMetricsBy.factor}x)`,
    )
    if (!enough) shortfalls.push(`${b.scenario}@${b.shape}`)
  }
  for (const scenario of thresholds.spanRegressionMustBeReported.scenarios) {
    for (const shape of shapes) {
      const b = at(baseline, shape, scenario)
      const s = at(span, shape, scenario)
      if (b === undefined || s === undefined) continue
      const ratio = s.p99Ms / b.p99Ms
      if (ratio > thresholds.spanRegressionMustBeReported.factor) {
        out.push(
          `REPORTABLE REGRESSION ${scenario} @ ${shape}: span is ${ratio.toFixed(2)}x slower`,
        )
      }
    }
  }
  verdict = shortfalls.length > 0 ? 'REVERSE' : commonBreached.length > 0 ? 'CONFIRM' : 'NARROW'
}

out.push('')
out.push(`VERDICT: ${verdict}`)
out.push('')
process.stdout.write(out.join('\n'))
