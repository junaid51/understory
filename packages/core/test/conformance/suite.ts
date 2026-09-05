import fc from 'fast-check'
import { expect } from 'vitest'
import { approximate, rowKey, type Projection, type ProjectionFactory } from '../../src/index.js'
import { applicable, applyCommand, buildStore, commandsArb, treeSpecArb } from './arbitraries.js'
import { checkInvariants } from './invariants.js'
import { OracleProjection } from '../../src/index.js'

/** Fast tier keeps pull requests quick; the deep tier searches the space properly. */
const RUNS = process.env['UNDERSTORY_DEEP'] === '1' ? 10_000 : 200
const SEED = process.env['UNDERSTORY_DEEP'] === '1' ? Date.now() : 20260905

const snapshot = (projection: Projection): string =>
  projection
    .slice(0, approximate(projection.count()))
    .map((row) => `${row.index}:${row.depth}:${rowKey(row)}`)
    .join('|')

export interface ConformanceOptions {
  /**
   * Whether to also compare against a freshly built oracle. The oracle itself
   * runs with this off, since comparing it to itself proves nothing; its
   * correctness rests on the structural invariants and the worked examples.
   */
  readonly differential: boolean
}

export function assertProjectionConformance(
  factory: ProjectionFactory,
  options: ConformanceOptions,
): void {
  fc.assert(
    fc.property(treeSpecArb, commandsArb(20), (spec, commands) => {
      const store = buildStore(spec)
      const subject = factory(store, [])
      const reference = options.differential ? new OracleProjection(store, []) : undefined

      const check = (label: string): void => {
        const violations = checkInvariants(subject, store)
        expect(violations, `${label}: invariant violations`).toEqual([])
        if (reference !== undefined) {
          expect(snapshot(subject), `${label}: differs from oracle`).toBe(snapshot(reference))
          expect(subject.count(), `${label}: count differs from oracle`).toEqual(reference.count())
        }
      }

      check('initial')

      for (const [i, command] of commands.entries()) {
        const applied = applyCommand(
          store,
          command,
          reference === undefined ? [subject] : [subject, reference],
        )
        if (!applied) continue
        check(`after ${i} ${command.op}`)
      }
    }),
    { numRuns: RUNS, seed: SEED },
  )
}

/**
 * Expanding then collapsing the same node must restore the exact row sequence.
 * A separate property because it spans two states rather than describing one.
 */
export function assertExpandCollapseRoundTrip(factory: ProjectionFactory): void {
  fc.assert(
    fc.property(treeSpecArb, fc.nat({ max: 59 }), (spec, target) => {
      const store = buildStore(spec)
      const projection = factory(store, [])
      const id = applicable(store, { op: 'expand', target })
      if (id === undefined) return
      const before = snapshot(projection)
      projection.expand(id)
      projection.collapse(id)
      expect(snapshot(projection)).toBe(before)
    }),
    { numRuns: RUNS, seed: SEED },
  )
}

/** Expanding never removes rows, and collapsing never adds any. */
export function assertMonotonicity(factory: ProjectionFactory): void {
  fc.assert(
    fc.property(treeSpecArb, fc.nat({ max: 59 }), (spec, target) => {
      const store = buildStore(spec)
      const projection = factory(store, [])
      const id = applicable(store, { op: 'expand', target })
      if (id === undefined) return
      const before = approximate(projection.count())
      projection.expand(id)
      const afterExpand = approximate(projection.count())
      expect(afterExpand).toBeGreaterThanOrEqual(before)
      projection.collapse(id)
      expect(approximate(projection.count())).toBeLessThanOrEqual(afterExpand)
    }),
    { numRuns: RUNS, seed: SEED },
  )
}

export { RUNS }
