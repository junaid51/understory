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
}

export type ProjectionFactory = (
  store: TreeStore,
  initiallyExpanded?: Iterable<NodeId>,
) => Projection
