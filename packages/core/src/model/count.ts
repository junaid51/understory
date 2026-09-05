/**
 * How many rows or children there are, and how much that number can be trusted
 * (ADR-0003).
 *
 * This is a type rather than a `number` because the engine routinely knows a
 * count only approximately: an expanded node whose children have not been loaded
 * occupies rows in the index space without anyone knowing how many. Pretending
 * such a count is exact is the root of most virtualization failure at scale, so
 * the distinction is carried in the type where it cannot be ignored by accident.
 */
export type CountEstimate =
  | { readonly kind: 'exact'; readonly value: number }
  | { readonly kind: 'atLeast'; readonly value: number }
  | { readonly kind: 'estimated'; readonly value: number }

export type ExactCount = Extract<CountEstimate, { kind: 'exact' }>

export const exact = (value: number): ExactCount => ({ kind: 'exact', value })
export const atLeast = (value: number): CountEstimate => ({ kind: 'atLeast', value })
export const estimated = (value: number): CountEstimate => ({ kind: 'estimated', value })

/**
 * The only way to read the number out. Named `approximate` rather than `value`
 * so that every call site reads as a deliberate acceptance that the number may
 * be wrong.
 */
export const approximate = (count: CountEstimate): number => count.value

/** The number, but only when it is actually known. */
export const exactValue = (count: CountEstimate): number | undefined =>
  count.kind === 'exact' ? count.value : undefined

/**
 * Precision ordering: exact is more precise than atLeast, which is more precise
 * than estimated. Combining counts takes the least precise of the two, because a
 * sum is only as trustworthy as its worst term.
 */
const PRECISION = { exact: 2, atLeast: 1, estimated: 0 } as const

export const addCounts = (a: CountEstimate, b: CountEstimate): CountEstimate => {
  const kind = PRECISION[a.kind] <= PRECISION[b.kind] ? a.kind : b.kind
  return { kind, value: a.value + b.value } as CountEstimate
}

export const isExact = (count: CountEstimate): count is ExactCount => count.kind === 'exact'
