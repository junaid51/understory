import type { CountEstimate } from './count.js'
import { approximate } from './count.js'
import type { NodeId, OrderKey } from './ids.js'

export interface NodeRecord {
  readonly id: NodeId
  readonly parentId: NodeId | null
  readonly orderKey: OrderKey
  /**
   * The node's children, in source order.
   *
   * `undefined` means "not loaded", which is different from `[]` meaning
   * "loaded, and there are none". That difference is the whole reason this
   * engine exists: an expanded node with unloaded children still occupies rows.
   */
  readonly childIds: readonly NodeId[] | undefined
  /** Exact when `childIds` is loaded; estimated otherwise. */
  readonly childCount: CountEstimate
}

export interface TreeStore {
  readonly roots: readonly NodeId[]
  get(id: NodeId): NodeRecord | undefined
  readonly size: number
}

/** Whether expanding this node would reveal anything. */
export const isExpandable = (node: NodeRecord): boolean => approximate(node.childCount) > 0

/** Whether this node's children are known. */
export const isLoaded = (node: NodeRecord): boolean => node.childIds !== undefined

export class MapTreeStore implements TreeStore {
  constructor(
    readonly roots: readonly NodeId[],
    private readonly nodes: ReadonlyMap<NodeId, NodeRecord>,
  ) {}

  get(id: NodeId): NodeRecord | undefined {
    return this.nodes.get(id)
  }

  get size(): number {
    return this.nodes.size
  }

  /** Iteration order is insertion order, which the generators make deterministic. */
  entries(): IterableIterator<[NodeId, NodeRecord]> {
    return this.nodes.entries()
  }
}
