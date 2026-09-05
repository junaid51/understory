import { describe, test } from 'vitest'
import { spanFactory } from '../../src/index.js'
import {
  RUNS,
  assertExpandCollapseRoundTrip,
  assertMonotonicity,
  assertProjectionConformance,
} from './suite.js'

describe(`span conformance (${RUNS} sequences per property)`, () => {
  test('agrees with the oracle and satisfies every structural invariant', () => {
    assertProjectionConformance(spanFactory, { differential: true })
  })

  test('expand then collapse restores the exact row sequence', () => {
    assertExpandCollapseRoundTrip(spanFactory)
  })

  test('expanding never removes rows and collapsing never adds them', () => {
    assertMonotonicity(spanFactory)
  })
})
