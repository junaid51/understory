import type { CoverageStore } from '../coverage/store.js'
import { approximate } from '../model/count.js'
import type { NodeId } from '../model/ids.js'
import type { Projection } from '../projection/types.js'
import type { Demand, Viewport } from './types.js'

/**
 * What this state wants and does not have.
 *
 * A pure function of coverage, the projection and a viewport. Keeping it pure is
 * what makes demand testable without a source, a clock or a promise, and it is why
 * the loader around it stays thin.
 *
 * Two triggers, exactly as the M1 definition states them, and no prediction:
 *
 *   1. An expanded, visible branch with no loaded children wants its first page.
 *   2. An expanded, visible parent whose loaded run ends inside the protected
 *      window wants its next page.
 *
 * There is no prefetch heuristic, no priority, and no lookahead beyond one page
 * per parent. That last property is what stops a large viewport from demanding an
 * unbounded amount at once: demand is bounded by the number of *visible expanded
 * parents*, not by the height of the viewport. Repeated calls page forward.
 *
 * Demand deliberately does not enforce the row budget. The M1 definition assigns
 * that to eviction, and a demand layer that quietly refused to load would make an
 * over-budget state invisible to the thing responsible for fixing it.
 */
export function computeDemand(
  coverage: CoverageStore,
  projection: Projection,
  viewport: Viewport,
  pageSize: number,
): Demand[] {
  const demand: Demand[] = []
  const total = approximate(projection.count())
  const rows = projection.slice(0, total)
  const expanded = projection.expandedIds()
  const windowEnd = viewport.endIndex + viewport.overscan

  const wantsFirstPage = (parentId: NodeId | null): boolean =>
    coverage.loadedCount(parentId) === 0 && !coverage.isExhausted(parentId)

  // The roots are a parent like any other, and the one that has no row of its own.
  if (wantsFirstPage(null)) {
    demand.push({ parentId: null, offset: 0, limit: pageSize })
  }

  /**
   * Where each visible parent's next children would appear.
   *
   * Not the row index of its last child, but the row after that child's entire
   * visible subtree, because that is where the next page lands. Computed in one
   * pass with a stack of open ancestors: a row at depth d closes everything deeper.
   */
  const appendIndex = new Map<NodeId, number>()
  const openAt: (NodeId | undefined)[] = []
  for (const row of rows) {
    if (row.kind !== 'node') continue
    for (let depth = row.depth; depth < openAt.length; depth++) {
      const closed = openAt[depth]
      if (closed !== undefined) appendIndex.set(closed, row.index)
    }
    openAt.length = row.depth
    openAt[row.depth] = row.id

    // Trigger 1, checked per row so a branch with no children rows is still seen.
    if (
      expanded.has(row.id) &&
      wantsFirstPage(row.id) &&
      approximate(coverage.get(row.id)?.childCount ?? { kind: 'exact', value: 0 }) > 0
    ) {
      demand.push({ parentId: row.id, offset: 0, limit: pageSize })
    }
  }
  for (const stillOpen of openAt) {
    if (stillOpen !== undefined) appendIndex.set(stillOpen, total)
  }

  // Trigger 2: the protected window reaches where the next page would land.
  for (const [parentId, appendAt] of appendIndex) {
    if (!expanded.has(parentId)) continue
    if (coverage.isExhausted(parentId)) continue
    const loaded = coverage.loadedCount(parentId)
    if (loaded === 0) continue // already covered by trigger 1
    if (appendAt > windowEnd) continue
    demand.push({ parentId, offset: loaded, limit: pageSize })
  }

  // The roots' next page, on the same rule.
  if (!coverage.isExhausted(null) && coverage.loadedCount(null) > 0 && total <= windowEnd) {
    demand.push({ parentId: null, offset: coverage.loadedCount(null), limit: pageSize })
  }

  return demand
}
