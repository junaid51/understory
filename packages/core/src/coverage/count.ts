import { approximate, atLeast, exact, type CountEstimate } from '../model/count.js'
import type { Projection } from '../projection/types.js'
import type { CoverageStore } from './store.js'

/**
 * How many rows there are, and how much that number can be trusted (invariant N9).
 *
 * The M0 projection reports `estimated` exactly when a placeholder row exists, and
 * under D2 no placeholder row ever exists, so it always reports `exact`. That is
 * true of the rows it holds and false of the hierarchy they describe: rows are
 * complete only if every parent contributing them has been exhausted or counted.
 *
 * This lives beside the projection rather than inside it. Changing the projection
 * to consult coverage would couple M0's index space to M1's loading model and
 * break the three-implementation conformance suite, for a value only the engine
 * facade needs. A pure function over both is the smaller answer.
 */
export function rowCountEstimate(coverage: CoverageStore, projection: Projection): CountEstimate {
  const rows = approximate(projection.count())
  if (!coverage.isComplete(null)) return atLeast(rows)

  const expanded = projection.expandedIds()
  for (const row of projection.slice(0, rows)) {
    if (row.kind !== 'node') continue
    if (!expanded.has(row.id)) continue
    if (!coverage.isComplete(row.id)) return atLeast(rows)
  }
  return exact(rows)
}
