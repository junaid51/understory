import { approximate, estimated, exact, type CountEstimate } from '../model/count.js'
import type { NodeId } from '../model/ids.js'
import type { TreeStore } from '../model/node.js'
import type { Row } from '../model/row.js'
import type { Projection } from './types.js'

/**
 * The materialized projection: the honest competitor.
 *
 * This is what a competent engineer would ship if the span index space (ADR-0002)
 * had never been proposed, and it is what the span implementation has to beat.
 * It is not a strawman and it is not the oracle. Deliberately tuned, within one
 * constraint: it is not incremental. A structural change rebuilds the whole row
 * table. That single property is the thing ADR-0002 claims is too expensive.
 *
 * Four choices, all specified before any measurement:
 *
 *  1. Rows live in parallel typed arrays, not objects. A rebuild writes integers
 *     and allocates nothing per row.
 *  2. Row objects are materialised lazily, only for the indices actually asked
 *     for, which in practice is one viewport.
 *  3. The arrays are reused across rebuilds and grow by doubling.
 *  4. Traversal is iterative with an explicit stack, so depth costs nothing and
 *     a pathological tree cannot exhaust the call stack.
 *
 * A record cache keyed by interned index was tried and reverted. The hypothesis
 * was that the rebuild loop was dominated by `store.get()` hash lookups. It was
 * not: expand-collapse at 100k moved from 11.95ms to 12.97ms at p99, inside
 * noise, while subtree-size-change went from 12.3ms to 19.1ms because
 * `invalidate()` has to discard the cache and repopulate it. The rebuild cost is
 * structural, being O(visible rows) per change by design, not a constant factor
 * waiting to be tuned away. The optimisation failed the project's own rule that
 * nothing lands without a benchmark number it improves, so it was removed. That
 * rule is worth as much when it deletes work as when it prevents it.
 *
 * Node ids are interned to integers on first sight rather than by enumerating
 * the store, because a store is not required to be enumerable and later ones
 * will not be.
 */
export class MaterializedProjection implements Projection {
  private readonly expanded = new Set<NodeId>()

  // Interning. ids[i] is the NodeId for internal index i.
  private readonly ids: NodeId[] = []
  private readonly indexById = new Map<NodeId, number>()

  // The row table, as a struct of arrays.
  private rowNode: Int32Array // internal node index, or -1 for a placeholder
  private rowParent: Int32Array // internal index of the parent node, or -1
  private rowDepth: Int32Array
  private rowSlot: Int32Array // placeholder slot, or -1 for a node row

  private length = 0
  private hasPlaceholder = false
  private dirty = true

  // Reused across rebuilds so a traversal allocates nothing.
  private stackNode: Int32Array
  private stackDepth: Int32Array

  constructor(
    private readonly store: TreeStore,
    initiallyExpanded: Iterable<NodeId> = [],
    initialCapacity = 1024,
  ) {
    for (const id of initiallyExpanded) this.expanded.add(id)
    this.rowNode = new Int32Array(initialCapacity)
    this.rowParent = new Int32Array(initialCapacity)
    this.rowDepth = new Int32Array(initialCapacity)
    this.rowSlot = new Int32Array(initialCapacity)
    this.stackNode = new Int32Array(initialCapacity)
    this.stackDepth = new Int32Array(initialCapacity)
  }

  private intern(id: NodeId): number {
    const existing = this.indexById.get(id)
    if (existing !== undefined) return existing
    const index = this.ids.length
    this.ids.push(id)
    this.indexById.set(id, index)
    return index
  }

  private idOf(index: number): NodeId {
    const id = this.ids[index]
    if (id === undefined) throw new Error(`no interned id at ${index}`)
    return id
  }

  private growRows(needed: number): void {
    if (needed <= this.rowNode.length) return
    let capacity = this.rowNode.length
    while (capacity < needed) capacity *= 2
    const copy = (source: Int32Array): Int32Array => {
      const next = new Int32Array(capacity)
      next.set(source)
      return next
    }
    this.rowNode = copy(this.rowNode)
    this.rowParent = copy(this.rowParent)
    this.rowDepth = copy(this.rowDepth)
    this.rowSlot = copy(this.rowSlot)
  }

  private growStack(needed: number): void {
    if (needed <= this.stackNode.length) return
    let capacity = this.stackNode.length
    while (capacity < needed) capacity *= 2
    const nextNode = new Int32Array(capacity)
    nextNode.set(this.stackNode)
    const nextDepth = new Int32Array(capacity)
    nextDepth.set(this.stackDepth)
    this.stackNode = nextNode
    this.stackDepth = nextDepth
  }

  private rebuild(): void {
    let length = 0
    let hasPlaceholder = false
    let top = 0

    const pushChildren = (childIds: readonly NodeId[], depth: number): void => {
      this.growStack(top + childIds.length)
      // Reversed, so a stack yields source order.
      for (let i = childIds.length - 1; i >= 0; i--) {
        const child = childIds[i]
        if (child === undefined) continue
        this.stackNode[top] = this.intern(child)
        this.stackDepth[top] = depth
        top += 1
      }
    }

    pushChildren(this.store.roots, 0)

    while (top > 0) {
      top -= 1
      const nodeIndex = this.stackNode[top] ?? 0
      const depth = this.stackDepth[top] ?? 0
      const id = this.idOf(nodeIndex)
      const node = this.store.get(id)
      if (node === undefined) throw new Error(`store is missing node ${id}`)

      this.growRows(length + 1)
      this.rowNode[length] = nodeIndex
      this.rowParent[length] = node.parentId === null ? -1 : this.intern(node.parentId)
      this.rowDepth[length] = depth
      this.rowSlot[length] = -1
      length += 1

      if (!this.expanded.has(id)) continue

      if (node.childIds === undefined) {
        const slots = approximate(node.childCount)
        if (slots > 0) hasPlaceholder = true
        this.growRows(length + slots)
        for (let slot = 0; slot < slots; slot++) {
          this.rowNode[length] = -1
          this.rowParent[length] = nodeIndex
          this.rowDepth[length] = depth + 1
          this.rowSlot[length] = slot
          length += 1
        }
      } else {
        pushChildren(node.childIds, depth + 1)
      }
    }

    this.length = length
    this.hasPlaceholder = hasPlaceholder
    this.dirty = false
  }

  private ensureFresh(): void {
    if (this.dirty) this.rebuild()
  }

  private rowAt(index: number): Row {
    const depth = this.rowDepth[index] ?? 0
    const nodeIndex = this.rowNode[index] ?? -1
    if (nodeIndex < 0) {
      const parentIndex = this.rowParent[index] ?? 0
      return {
        kind: 'placeholder',
        index,
        parentId: this.idOf(parentIndex),
        depth,
        slot: this.rowSlot[index] ?? 0,
      }
    }
    const parentIndex = this.rowParent[index] ?? -1
    return {
      kind: 'node',
      index,
      id: this.idOf(nodeIndex),
      parentId: parentIndex < 0 ? null : this.idOf(parentIndex),
      depth,
    }
  }

  count(): CountEstimate {
    this.ensureFresh()
    return this.hasPlaceholder ? estimated(this.length) : exact(this.length)
  }

  resolve(index: number): Row | undefined {
    if (index < 0) return undefined
    this.ensureFresh()
    if (index >= this.length) return undefined
    return this.rowAt(index)
  }

  slice(start: number, end: number): readonly Row[] {
    this.ensureFresh()
    const from = Math.max(0, Math.trunc(start))
    const to = Math.min(this.length, Math.max(from, Math.trunc(end)))
    const out: Row[] = new Array(Math.max(0, to - from))
    for (let i = from; i < to; i++) out[i - from] = this.rowAt(i)
    return out
  }

  isExpanded(id: NodeId): boolean {
    return this.expanded.has(id)
  }

  expand(id: NodeId): void {
    if (this.store.get(id) === undefined) throw new Error(`cannot expand unknown node ${id}`)
    if (this.expanded.has(id)) return
    this.expanded.add(id)
    this.dirty = true
  }

  collapse(id: NodeId): void {
    if (this.store.get(id) === undefined) throw new Error(`cannot collapse unknown node ${id}`)
    if (!this.expanded.delete(id)) return
    this.dirty = true
  }

  expandedIds(): ReadonlySet<NodeId> {
    return new Set(this.expanded)
  }

  /** Marks the row table stale. For sources that mutate the store underneath. */
  invalidate(): void {
    this.dirty = true
  }
}

export const materializedFactory = (
  store: TreeStore,
  initiallyExpanded: Iterable<NodeId> = [],
): Projection => new MaterializedProjection(store, initiallyExpanded)
