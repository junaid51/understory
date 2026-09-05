import { describe, test } from 'vitest'
import { materializedFactory } from '../../src/index.js'
import {
  RUNS,
  assertExpandCollapseRoundTrip,
  assertMonotonicity,
  assertProjectionConformance,
} from './suite.js'

/**
 * The materialized projection runs the full suite, differential half included:
 * structural invariants plus lockstep agreement with a freshly built oracle
 * after every command.
 */
describe(`materialized conformance (${RUNS} sequences per property)`, () => {
  test('agrees with the oracle and satisfies every structural invariant', () => {
    assertProjectionConformance(materializedFactory, { differential: true })
  })

  test('expand then collapse restores the exact row sequence', () => {
    assertExpandCollapseRoundTrip(materializedFactory)
  })

  test('expanding never removes rows and collapsing never adds them', () => {
    assertMonotonicity(materializedFactory)
  })
})
