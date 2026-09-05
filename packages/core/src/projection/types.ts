import type { CountEstimate } from '../model/count.js'
import type { NodeId } from '../model/ids.js'
import type { TreeStore } from '../model/node.js'
import type { Row } from '../model/row.js'

/**
 * The contract every projection implementation satisfies.
 *
 * A virtualizer asks exactly two questions, "how many rows" and "what is at
 * index i", so those are the two that matter. Everything else here exists to
 * change the answers.
 */
export interface Projection {
  count(): CountEstimate
  resolve(index: number): Row | undefined
  /** Half-open [start, end). Out-of-range bounds clamp rather than throw. */
  slice(start: number, end: number): readonly Row[]
  isExpanded(id: NodeId): boolean
  expand(id: NodeId): void
  collapse(id: NodeId): void
  expandedIds(): ReadonlySet<NodeId>
  /**
   * The children of this node changed in the store.
   *
   * Added at commit 9 because `subtree-size-change` is one of the breached
   * metrics the span implementation has to improve on, and it cannot be measured
   * against an implementation that caches structure with no way to refresh it.
   * Each implementation does what its design implies: the materialized
   * projection marks the whole table stale, the span index space re-reads one
   * node and carries the difference up one ancestor chain, and the oracle ignores
   * it because it rebuilds on every call anyway.
   */
  invalidate(id: NodeId): void
}

export type ProjectionFactory = (
  store: TreeStore,
  initiallyExpanded?: Iterable<NodeId>,
) => Projection
