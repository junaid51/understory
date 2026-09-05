import { expect, test } from 'vitest'
import { PLACEHOLDER } from '../src/index.js'

// This test exists for one reason: to prove CI actually runs tests before any
// real test depends on that being true.
test('the harness runs', () => {
  expect(PLACEHOLDER).toBe('m0')
})
