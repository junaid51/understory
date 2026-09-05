import { describe, test } from 'vitest'
import { oracleFactory } from '../../src/index.js'
import {
  RUNS,
  assertExpandCollapseRoundTrip,
  assertMonotonicity,
  assertProjectionConformance,
} from './suite.js'

/**
 * The oracle runs the suite with differential comparison switched off, because
 * comparing it to itself would pass unconditionally. What is being tested here is
 * that the oracle satisfies the structural invariants, which are derived from the
 * definition of the index space rather than from any implementation.
 *
 * The suite's own credibility comes from the fault-injection tests, not from this.
 */
describe(`oracle conformance (${RUNS} sequences per property)`, () => {
  test('structural invariants hold across random command sequences', () => {
    assertProjectionConformance(oracleFactory, { differential: false })
  })

  test('expand then collapse restores the exact row sequence', () => {
    assertExpandCollapseRoundTrip(oracleFactory)
  })

  test('expanding never removes rows and collapsing never adds them', () => {
    assertMonotonicity(oracleFactory)
  })
})
