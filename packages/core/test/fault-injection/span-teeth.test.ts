import { afterEach, describe, expect, test } from 'vitest'
import { SpanProjection, spanFactory } from '../../src/index.js'
import { assertProjectionConformance } from '../conformance/suite.js'

/**
 * Does the conformance suite have teeth against the span implementation
 * specifically?
 *
 * The eleven faults in `teeth.test.ts` are defects a naive row-list projection
 * could have. The span index space has its own failure modes, all of them about
 * cached sums drifting from the structure they summarise, and none of them
 * reachable by breaking a row list.
 *
 * Faults are injected by patching the prototype rather than by adding a fault
 * flag to the implementation, so nothing test-only reaches the shipped class.
 */
type Patchable = Record<string, unknown>
const proto = SpanProjection.prototype as unknown as Patchable
const originals = new Map<string, unknown>()

const patch = (name: string, replacement: unknown): void => {
  if (!originals.has(name)) originals.set(name, proto[name])
  proto[name] = replacement
}

afterEach(() => {
  for (const [name, value] of originals) proto[name] = value
  originals.clear()
})

const expectCaught = (label: string): void => {
  expect(
    () => assertProjectionConformance(spanFactory, { differential: true }),
    `span fault "${label}" was not caught by the conformance suite`,
  ).toThrow()
}

describe('span-specific fault injection', () => {
  test('ancestor propagation removed entirely', () => {
    patch('propagate', function noop(): void {})
    expectCaught('no-propagation')
  })

  test('propagation stops after one level, so deep changes never reach the root', () => {
    const original = originals.get('propagate') ?? proto['propagate']
    patch(
      'propagate',
      function oneLevel(this: Patchable, from: number, spanDelta: number, phDelta: number): void {
        const parent = this['parent'] as Int32Array
        const childSum = this['childSum'] as Int32Array
        const phSum = this['phSum'] as Int32Array
        const p = parent[from] ?? -1
        if (p < 0) return
        childSum[p] = (childSum[p] ?? 0) + spanDelta
        phSum[p] = (phSum[p] ?? 0) + phDelta
      },
    )
    void original
    expectCaught('propagate-one-level')
  })

  test('the non-unit child count is never maintained', () => {
    const original = proto['propagate'] as (...args: unknown[]) => void
    patch('propagate', function frozen(this: Patchable, ...args: unknown[]): void {
      original.apply(this, args)
      ;(this['nonUnit'] as Int32Array).fill(0)
    })
    expectCaught('nonunit-always-zero')
  })

  test('placeholder accounting is dropped, so counts claim to be exact', () => {
    const original = proto['propagate'] as (...args: unknown[]) => void
    patch('propagate', function noPh(this: Patchable, ...args: unknown[]): void {
      original.apply(this, args)
      ;(this['phSum'] as Int32Array).fill(0)
    })
    expectCaught('placeholder-sum-dropped')
  })

  test('descent forgets that a parent occupies a row of its own', () => {
    const original = proto['resolve'] as (index: number) => unknown
    patch('resolve', function offByOne(this: Patchable, index: number): unknown {
      return original.call(this, index + 1)
    })
    expectCaught('descent-off-by-one')
  })

  test('the suite passes again once the patches are removed', () => {
    assertProjectionConformance(spanFactory, { differential: true })
  })
})
