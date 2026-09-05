import type { MapTreeStore, NodeId, NodeRecord, TreeStore } from '@understory/core'

/**
 * A store whose records can be replaced, so benchmarks can simulate data
 * arriving or changing underneath a projection. Lives in bench rather than core
 * because core has no mutation story until M2 and inventing one early would be
 * exactly the abstraction the project rule forbids.
 */
export class MutableTreeStore implements TreeStore {
  private readonly nodes: Map<NodeId, NodeRecord>

  constructor(
    public roots: readonly NodeId[],
    nodes: Iterable<[NodeId, NodeRecord]>,
  ) {
    this.nodes = new Map(nodes)
  }

  static from(store: MapTreeStore): MutableTreeStore {
    return new MutableTreeStore(store.roots, store.entries())
  }

  get(id: NodeId): NodeRecord | undefined {
    return this.nodes.get(id)
  }

  get size(): number {
    return this.nodes.size
  }

  set(record: NodeRecord): void {
    this.nodes.set(record.id, record)
  }

  entries(): IterableIterator<[NodeId, NodeRecord]> {
    return this.nodes.entries()
  }
}
