import fc from 'fast-check'
import { describe, expect, test } from 'vitest'
import { OracleProjection, approximate, rowKey, type Projection } from '../../src/index.js'
import { applyCommand, buildStore, commandsArb, treeSpecArb } from '../conformance/arbitraries.js'
import { checkInvariants } from '../conformance/invariants.js'
import { FAULTS, FAULT_DESCRIPTIONS, faultyFactory, type Fault } from './faulty.js'

/**
 * Does the conformance suite actually have teeth?
 *
 * A test suite that has never failed is not evidence of anything. Each fault
 * below is a defect a real implementation could plausibly have. Every one must
 * be caught, and the invariant that catches it is recorded, so a fault caught
 * only by the differential comparison is visible as a gap in the structural
 * half of the suite.
 */
const RUNS = 150
const SEED = 20260905

const snapshot = (projection: Projection): string =>
  projection
    .slice(0, approximate(projection.count()))
    .map((row) => `${row.index}:${row.depth}:${rowKey(row)}`)
    .join('|')

interface Detection {
  readonly structural: Set<string>
  readonly differentialOnly: boolean
  readonly runsCaught: number
  readonly runsTotal: number
}

function probe(fault: Fault): Detection {
  const structural = new Set<string>()
  let runsCaught = 0
  let runsTotal = 0
  let differentialCaught = 0

  fc.assert(
    fc.property(treeSpecArb, commandsArb(12), (spec, commands) => {
      runsTotal += 1
      const store = buildStore(spec)
      const subject = faultyFactory(fault)(store, [])
      const reference = new OracleProjection(store, [])
      let caught = false
      let caughtStructurally = false

      const check = (): void => {
        const violations = checkInvariants(subject, store)
        if (violations.length > 0) {
          caught = true
          caughtStructurally = true
          for (const v of violations) structural.add(v.split(' ')[0] ?? '?')
        }
        if (snapshot(subject) !== snapshot(reference)) caught = true
      }

      check()
      for (const command of commands) {
        if (!applyCommand(store, command, [subject, reference])) continue
        check()
      }

      if (caught) runsCaught += 1
      if (caught && !caughtStructurally) differentialCaught += 1
      return true
    }),
    { numRuns: RUNS, seed: SEED },
  )

  return {
    structural,
    differentialOnly: structural.size === 0 && differentialCaught > 0,
    runsCaught,
    runsTotal,
  }
}

const results = new Map<Fault, Detection>()

describe('fault injection', () => {
  test('the undamaged control agrees with the oracle exactly', () => {
    // If this fails, the fault harness has drifted from the oracle and every
    // result below is meaningless.
    fc.assert(
      fc.property(treeSpecArb, commandsArb(12), (spec, commands) => {
        const store = buildStore(spec)
        const control = faultyFactory('none')(store, [])
        const oracle = new OracleProjection(store, [])
        expect(snapshot(control)).toBe(snapshot(oracle))
        for (const command of commands) {
          if (!applyCommand(store, command, [control, oracle])) continue
          expect(snapshot(control)).toBe(snapshot(oracle))
        }
      }),
      { numRuns: RUNS, seed: SEED },
    )
  })

  test.each(FAULTS)('%s is caught', (fault) => {
    const detection = probe(fault)
    results.set(fault, detection)
    expect(
      detection.runsCaught,
      `fault "${fault}" (${FAULT_DESCRIPTIONS[fault]}) escaped every one of ${detection.runsTotal} random trees. Either the generators do not reach the shape it needs, or the suite has a hole.`,
    ).toBeGreaterThan(0)
  })

  test('coverage report', () => {
    const lines: string[] = ['', 'fault                          caught  by', '-'.repeat(78)]
    for (const fault of FAULTS) {
      const d = results.get(fault)
      if (d === undefined) continue
      const by = d.structural.size > 0 ? [...d.structural].sort().join(' ') : 'DIFFERENTIAL ONLY'
      lines.push(`${fault.padEnd(30)} ${String(d.runsCaught).padStart(3)}/${d.runsTotal}  ${by}`)
    }
    // eslint-disable-next-line no-console
    console.log(lines.join('\n'))
    expect(results.size).toBe(FAULTS.length)
  })
})
