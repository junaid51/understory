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
out.push('ADR-0002 verdict    thresholds pre-registered 2026-09-05')
out.push(`baseline commit ${baseline.commit}   control ${baseline.controlWorkloadMs.toFixed(2)}ms`)
out.push(
  span === undefined
    ? 'span results: none yet'
    : `span commit ${span.commit}   control ${span.controlWorkloadMs.toFixed(2)}ms`,
)
out.push('='.repeat(104))

/**
 * Evaluates every threshold against one implementation.
 *
 * The first version of this tool only ever did this for the baseline, which is a
 * blind spot pointing in exactly the direction that flatters the proposal: it
 * reported a verdict without ever asking whether the proposed implementation met
 * the bar it was proposed against. Applying the thresholds by hand afterwards
 * found three breaches it had missed.
 */
function evaluate(file: ResultFile, label: string): Breach[] {
  const found: Breach[] = []
  out.push('')
  out.push(`-- ${label} against the pre-registered thresholds`)
  for (const threshold of thresholds.baselineMustSatisfy) {
    for (const shape of shapes) {
      const measurement = at(file, shape, threshold.scenario)
      if (measurement === undefined) continue
      const observed = Number(measurement[threshold.stat])
      const pass = observed <= threshold.max
      if (!pass) {
        found.push({
          shape,
          scenario: threshold.scenario,
          stat: threshold.stat,
          observed,
          max: threshold.max,
          unit: threshold.unit,
          factorOver: observed / threshold.max,
        })
      }
      out.push(
        `   ${pass ? 'PASS' : 'FAIL'}  ${threshold.scenario.padEnd(24)} ${shape.padEnd(18)} ${observed.toFixed(3).padStart(11)} ${threshold.unit.padEnd(2)} limit ${String(threshold.max).padStart(6)}${pass ? '' : `   ${(observed / threshold.max).toFixed(1)}x over`}`,
      )
    }
  }
  for (const heap of file.heaps.filter((h) => h.nodes === thresholds.scale.nodes)) {
    const pass = heap.ratio <= thresholds.heap.maxProjectionToStoreRatio
    if (!pass) {
      found.push({
        shape: heap.shape,
        scenario: 'retained-heap',
        stat: 'ratio',
        observed: heap.ratio,
        max: thresholds.heap.maxProjectionToStoreRatio,
        unit: 'x',
        factorOver: heap.ratio / thresholds.heap.maxProjectionToStoreRatio,
      })
    }
    out.push(
      `   ${pass ? 'PASS' : 'FAIL'}  ${'retained-heap'.padEnd(24)} ${heap.shape.padEnd(18)} ${heap.ratio.toFixed(3).padStart(11)} x  limit ${String(thresholds.heap.maxProjectionToStoreRatio).padStart(6)}`,
    )
  }
  return found
}

const baselineBreaches = evaluate(baseline, 'MATERIALIZED (the baseline)')
const spanBreaches = span === undefined ? [] : evaluate(span, 'SPAN (the proposal)')

const breachedShapes = [...new Set(baselineBreaches.map((b) => b.shape))]
const commonBreached = breachedShapes.filter((s) =>
  thresholds.shapeClassification.common.includes(s),
)

out.push('')
out.push('='.repeat(104))

let verdict: string
if (baselineBreaches.length === 0) {
  verdict = 'REVERSE'
  out.push('The baseline satisfies every threshold on every shape. The span index space is')
  out.push('unnecessary and ADR-0002 is withdrawn.')
} else if (span === undefined) {
  verdict = 'PENDING-SPAN'
  out.push(
    `Baseline breaches ${baselineBreaches.length} threshold(s) on ${breachedShapes.length} shape(s).`,
  )
  for (const b of baselineBreaches) {
    out.push(
      `   ${b.scenario} @ ${b.shape}: ${b.observed.toFixed(3)}${b.unit} vs ${b.max}${b.unit}`,
    )
  }
} else {
  // Criterion A, pre-registered literally: 3x at p99 on each breached metric.
  out.push('-- criterion A (pre-registered): span improves each breached metric by 3x at p99')
  const shortfalls: string[] = []
  for (const b of baselineBreaches) {
    const measurement = at(span, b.shape, b.scenario)
    if (measurement === undefined) continue
    const observed = Number(measurement[b.stat as keyof Measurement])
    const improvement = observed > 0 ? b.observed / observed : Number.POSITIVE_INFINITY
    const enough = improvement >= thresholds.spanMustImproveBreachedMetricsBy.factor
    if (!enough) shortfalls.push(`${b.scenario}@${b.shape}`)
    out.push(
      `   ${enough ? 'MEETS' : 'SHORT'} ${b.scenario.padEnd(24)} ${b.shape.padEnd(18)} ${improvement.toFixed(2).padStart(12)}x  need ${thresholds.spanMustImproveBreachedMetricsBy.factor}x`,
    )
  }

  // Criterion B: the proposal must itself satisfy the thresholds. Omitted from
  // the original pre-registration, which was an oversight rather than a decision,
  // so it is reported separately and never silently folded into criterion A.
  out.push('')
  out.push(
    '-- criterion B (NOT pre-registered, reported separately): span meets the thresholds itself',
  )
  if (spanBreaches.length === 0) {
    out.push('   span satisfies every threshold on every shape')
  } else {
    for (const b of spanBreaches) {
      out.push(
        `   FAIL  ${b.scenario.padEnd(24)} ${b.shape.padEnd(18)} ${b.observed.toFixed(3).padStart(11)}${b.unit} vs ${b.max}${b.unit}  (${b.factorOver.toFixed(1)}x over)`,
      )
    }
  }

  out.push('')
  out.push('-- reportable regressions: span slower than baseline past the 2x bar')
  let regressions = 0
  for (const scenario of thresholds.spanRegressionMustBeReported.scenarios) {
    for (const shape of shapes) {
      const b = at(baseline, shape, scenario)
      const sp = at(span, shape, scenario)
      if (b === undefined || sp === undefined || b.p99Ms === 0) continue
      const ratio = sp.p99Ms / b.p99Ms
      if (ratio > thresholds.spanRegressionMustBeReported.factor) {
        regressions += 1
        out.push(`   ${scenario.padEnd(24)} ${shape.padEnd(18)} span ${ratio.toFixed(1)}x slower`)
      }
    }
  }
  if (regressions === 0) out.push('   none')

  out.push('')
  if (shortfalls.length > 0) {
    verdict = 'REVERSE'
    out.push(`Criterion A not met: ${shortfalls.join(', ')}.`)
  } else if (spanBreaches.length > 0) {
    verdict = 'REVERSE'
    out.push('Criterion A met, but the proposal does not satisfy the thresholds it was')
    out.push('proposed against (criterion B). Shipping it would mean shipping a known breach.')
  } else {
    verdict = commonBreached.length > 0 ? 'CONFIRM' : 'NARROW'
    out.push('Criteria A and B both met.')
  }
}

out.push('')
out.push(`VERDICT: ${verdict}`)
out.push('')
process.stdout.write(out.join('\n'))
