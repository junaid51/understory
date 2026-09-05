import { approximate, estimated, exact, type CountEstimate } from '../model/count.js'
import type { NodeId } from '../model/ids.js'
import type { TreeStore } from '../model/node.js'
import type { Row } from '../model/row.js'
import type { Projection } from './types.js'

/**
 * The span index space (ADR-0002).
 *
 * Every node caches how many rows it occupies. A collapsed node occupies one. An
 * expanded node occupies one plus the spans of its children. An expanded node
 * whose children are unloaded occupies one plus its estimated child count, and
 * that estimate is a single integer rather than a run of materialised
 * placeholder rows.
 *
 * The consequence, and the entire point, is that expanding or collapsing a node
 * updates one ancestor chain rather than rebuilding the row table. The
 * materialized baseline pays O(visible rows) for the same operation and was
 * measured at 206ms to 398ms p99 at a million nodes, 51x to 100x over the
 * pre-registered 4ms frame budget.
 *
 * DEVIATION FROM THE PHASE 3 DESIGN, recorded rather than slipped in:
 *
 *   Phase 3 described resolve as "descends comparing running offsets" and called
 *   it O(depth). That is wrong. Finding which child owns an offset requires
 *   walking that node's children accumulating their spans, so the honest cost is
 *   O(depth x fanout). On the mega-sibling corpus, one node owns a million
 *   children and a per-level scan of a million entries would lose to a plain
 *   array outright.
 *
 *   One structure not in the Phase 3 text was added: `nonUnit`, a per-node count
 *   of children whose span exceeds one. When it is zero every child occupies
 *   exactly one row, so the child owning an offset IS that offset, and the step
 *   is O(1). This is the common case: a wide node whose children are leaves, or
 *   whose children are collapsed.
 *
 *   The remaining case, a wide node with many expanded children, is still a
 *   linear scan. A Fenwick tree per such node would make it O(log fanout) at the
 *   cost of an allocator and a second index structure. It is deliberately NOT
 *   built, because no measurement yet says it is needed, and the project rule is
 *   that nothing lands without a benchmark number it improves.
 */

const EXPANDED = 1
const MATERIALIZED = 2
const UNLOADED = 4

/** Index 0 is a synthetic parent owning the store's roots. It emits no row. */
const VROOT = 0

export class SpanProjection implements Projection {
  private ids: (NodeId | null)[] = [null]
  private readonly indexById = new Map<NodeId, number>()
  private readonly expandedSet = new Set<NodeId>()

  private parent: Int32Array
  private slot: Int32Array
  /** Sum of the spans of this node's children. Maintained whether or not the node is expanded. */
  private childSum: Int32Array
  /** Placeholder rows inside this node's subtree, when the node is expanded. */
  private phSum: Int32Array
  /** How many children have a span greater than one. Zero enables an O(1) descent step. */
  private nonUnit: Int32Array
  /** Estimated child count, for expanded-but-unloaded nodes. */
  private estCount: Int32Array
  private flags: Uint8Array
  /**
   * Every node's child list, packed end to end in one array.
   *
   * The first version held one `Int32Array` per node inside a JavaScript array a
   * million entries long. A random descent then chased a pointer into a cold
   * million-entry array and again into a separate small heap object, once per
   * level, and the million object headers dominated the heap. See
   * docs/experiments/0001-packed-child-lists.md for the measurement.
   *
   * Regions are bump-allocated and never reclaimed: re-materialising a node with
   * a different fan-out leaves its old region as fragmentation. Acceptable at M0,
   * recorded rather than solved speculatively.
   */
  private childData: Int32Array
  private childStart: Int32Array
  private childLen: Int32Array
  private childTop = 0

  constructor(
    private readonly store: TreeStore,
    initiallyExpanded: Iterable<NodeId> = [],
    capacity = 1024,
  ) {
    this.parent = new Int32Array(capacity)
    this.slot = new Int32Array(capacity)
    this.childSum = new Int32Array(capacity)
    this.phSum = new Int32Array(capacity)
    this.nonUnit = new Int32Array(capacity)
    this.estCount = new Int32Array(capacity)
    this.flags = new Uint8Array(capacity)
    this.childStart = new Int32Array(capacity).fill(-1)
    this.childLen = new Int32Array(capacity)
    this.childData = new Int32Array(capacity)
    this.parent[VROOT] = -1
    this.flags[VROOT] = EXPANDED
    for (const id of initiallyExpanded) this.expand(id)
  }

  // ---------------------------------------------------------------- internals

  private grow(needed: number): void {
    if (needed <= this.parent.length) return
    let capacity = this.parent.length
    while (capacity < needed) capacity *= 2
    const grow32 = (source: Int32Array): Int32Array => {
      const next = new Int32Array(capacity)
      next.set(source)
      return next
    }
    this.parent = grow32(this.parent)
    this.slot = grow32(this.slot)
    this.childSum = grow32(this.childSum)
    this.phSum = grow32(this.phSum)
    this.nonUnit = grow32(this.nonUnit)
    this.estCount = grow32(this.estCount)
    const startNext = new Int32Array(capacity).fill(-1)
    startNext.set(this.childStart)
    this.childStart = startNext
    this.childLen = grow32(this.childLen)
    const flags = new Uint8Array(capacity)
    flags.set(this.flags)
    this.flags = flags
  }

  /** Bump-allocates a contiguous region of `length` child slots. */
  private allocateChildren(length: number): number {
    const needed = this.childTop + length
    if (needed > this.childData.length) {
      let capacity = this.childData.length
      while (capacity < needed) capacity *= 2
      const next = new Int32Array(capacity)
      next.set(this.childData)
      this.childData = next
    }
    const start = this.childTop
    this.childTop += length
    return start
  }

  private idOf(index: number): NodeId {
    const id = this.ids[index]
    if (id == null) throw new Error(`no id interned at ${index}`)
    return id
  }

  /** Rows this node occupies. A synthetic root occupies only its children. */
  private spanOf(index: number): number {
    if (index === VROOT) return this.childSum[VROOT] ?? 0
    if ((this.flags[index] ?? 0) & EXPANDED) return 1 + (this.childSum[index] ?? 0)
    return 1
  }

  /** Placeholder rows this node contributes, itself included. */
  private phOf(index: number): number {
    if (index === VROOT) return this.phSum[VROOT] ?? 0
    const flags = this.flags[index] ?? 0
    if (!(flags & EXPANDED)) return 0
    if (flags & UNLOADED) return this.estCount[index] ?? 0
    return this.phSum[index] ?? 0
  }

  /**
   * Interns a node's children, assigning each a parent link and a sibling slot,
   * and computes this node's three cached sums from their current state.
   *
   * An earlier version assumed every child was brand new here and therefore
   * collapsed, which made the sums trivial. That assumption broke the moment
   * `invalidate` needed to re-materialise a node whose children were already
   * interned and possibly expanded, so the sums are computed from actual child
   * state instead. It costs O(fanout), paid once per materialisation.
   */
  private ensureChildren(index: number): void {
    if ((this.flags[index] ?? 0) & MATERIALIZED) return
    this.flags[index] = (this.flags[index] ?? 0) | MATERIALIZED

    let list: readonly NodeId[]
    if (index === VROOT) {
      list = this.store.roots
    } else {
      const node = this.store.get(this.idOf(index))
      if (node === undefined) throw new Error(`store is missing node ${this.idOf(index)}`)
      if (node.childIds === undefined) {
        this.flags[index] = (this.flags[index] ?? 0) | UNLOADED
        const count = approximate(node.childCount)
        this.estCount[index] = count
        this.childSum[index] = count
        this.phSum[index] = count
        this.nonUnit[index] = 0
        return
      }
      list = node.childIds
    }

    const start = this.allocateChildren(list.length)
    this.childStart[index] = start
    this.childLen[index] = list.length
    let sum = 0
    let placeholders = 0
    let wide = 0
    for (let k = 0; k < list.length; k++) {
      const childId = list[k]
      if (childId === undefined) continue
      let childIndex = this.indexById.get(childId)
      if (childIndex === undefined) {
        childIndex = this.ids.length
        this.grow(childIndex + 1)
        this.ids.push(childId)
        this.indexById.set(childId, childIndex)
        this.childSum[childIndex] = 0
        this.phSum[childIndex] = 0
        this.nonUnit[childIndex] = 0
        this.estCount[childIndex] = 0
        this.flags[childIndex] = 0
      }
      this.parent[childIndex] = index
      this.slot[childIndex] = k
      this.childData[start + k] = childIndex
      const span = this.spanOf(childIndex)
      sum += span
      placeholders += this.phOf(childIndex)
      if (span > 1) wide += 1
    }
    this.childSum[index] = sum
    this.phSum[index] = placeholders
    this.nonUnit[index] = wide
  }

  /** Interns a node by materialising the chain of ancestors above it, top down. */
  private locate(id: NodeId): number | undefined {
    const known = this.indexById.get(id)
    if (known !== undefined) return known
    if (this.store.get(id) === undefined) return undefined

    const chain: NodeId[] = []
    let cursor: NodeId | null = id
    while (cursor !== null && this.indexById.get(cursor) === undefined) {
      chain.push(cursor)
      cursor = this.store.get(cursor)?.parentId ?? null
    }
    this.ensureChildren(VROOT)
    for (let k = chain.length - 1; k >= 0; k--) {
      const step = chain[k]
      if (step === undefined) continue
      const parentId = this.store.get(step)?.parentId ?? null
      const parentIndex = parentId === null ? VROOT : this.indexById.get(parentId)
      if (parentIndex === undefined) return undefined
      this.ensureChildren(parentIndex)
    }
    return this.indexById.get(id)
  }

  /**
   * Carries a span change up one ancestor chain.
   *
   * Stops at the first collapsed ancestor, because a collapsed node's span is
   * one no matter what happens beneath it, so nothing above it changes either.
   * That early exit is why a collapsed subtree costs nothing to keep current.
   */
  private propagate(from: number, spanDelta: number, phDelta: number): void {
    let child = from
    let dSpan = spanDelta
    let dPh = phDelta

    while (dSpan !== 0 || dPh !== 0) {
      const parentIndex = this.parent[child] ?? -1
      if (parentIndex < 0) return

      const newChildSpan = this.spanOf(child)
      const oldChildSpan = newChildSpan - dSpan
      if (oldChildSpan === 1 && newChildSpan > 1) {
        this.nonUnit[parentIndex] = (this.nonUnit[parentIndex] ?? 0) + 1
      } else if (oldChildSpan > 1 && newChildSpan === 1) {
        this.nonUnit[parentIndex] = (this.nonUnit[parentIndex] ?? 0) - 1
      }

      const parentOldSpan = this.spanOf(parentIndex)
      const parentOldPh = this.phOf(parentIndex)
      this.childSum[parentIndex] = (this.childSum[parentIndex] ?? 0) + dSpan
      this.phSum[parentIndex] = (this.phSum[parentIndex] ?? 0) + dPh
      dSpan = this.spanOf(parentIndex) - parentOldSpan
      dPh = this.phOf(parentIndex) - parentOldPh
      child = parentIndex
    }
  }

  // ------------------------------------------------------------------- public

  count(): CountEstimate {
    this.ensureChildren(VROOT)
    const total = this.childSum[VROOT] ?? 0
    return (this.phSum[VROOT] ?? 0) > 0 ? estimated(total) : exact(total)
  }

  resolve(index: number): Row | undefined {
    if (index < 0 || !Number.isFinite(index)) return undefined
    this.ensureChildren(VROOT)
    const total = this.childSum[VROOT] ?? 0
    if (index >= total) return undefined

    let node = VROOT
    let offset = Math.trunc(index)
    let depth = 0

    for (;;) {
      const flags = this.flags[node] ?? 0
      if (node !== VROOT && flags & UNLOADED) {
        return { kind: 'placeholder', index, parentId: this.idOf(node), depth, slot: offset }
      }

      const start = this.childStart[node] ?? -1
      const length = this.childLen[node] ?? 0
      if (start < 0 || length === 0) return undefined

      let childIndex: number
      if ((this.nonUnit[node] ?? 0) === 0) {
        // Every child occupies exactly one row, so the child owning this offset
        // is that offset. This is the O(1) step described in the header.
        if (offset >= length) return undefined
        childIndex = this.childData[start + offset] ?? -1
        if (childIndex < 0) return undefined
        return {
          kind: 'node',
          index,
          id: this.idOf(childIndex),
          parentId: node === VROOT ? null : this.idOf(node),
          depth,
        }
      }

      let cursor = 0
      let chosen = -1
      for (let k = 0; k < length; k++) {
        const candidate = this.childData[start + k] ?? -1
        const span = this.spanOf(candidate)
        if (offset < cursor + span) {
          chosen = candidate
          offset -= cursor
          break
        }
        cursor += span
      }
      if (chosen < 0) return undefined
      childIndex = chosen

      if (offset === 0) {
        return {
          kind: 'node',
          index,
          id: this.idOf(childIndex),
          parentId: node === VROOT ? null : this.idOf(node),
          depth,
        }
      }
      offset -= 1
      node = childIndex
      depth += 1
    }
  }

  slice(start: number, end: number): readonly Row[] {
    const total = approximate(this.count())
    const from = Math.max(0, Math.trunc(start))
    const to = Math.min(total, Math.max(from, Math.trunc(end)))
    const out: Row[] = []
    for (let i = from; i < to; i++) {
      const row = this.resolve(i)
      if (row !== undefined) out.push(row)
    }
    return out
  }

  isExpanded(id: NodeId): boolean {
    return this.expandedSet.has(id)
  }

  expand(id: NodeId): void {
    if (this.store.get(id) === undefined) throw new Error(`cannot expand unknown node ${id}`)
    const index = this.locate(id)
    if (index === undefined) {
      // The node exists but is not reachable through loaded children, because an
      // ancestor is expanded-but-unloaded and therefore stands in for its whole
      // subtree with placeholder rows. Expanding it is recorded and has no effect
      // on the index space, which is what the oracle does too.
      //
      // Found by the property suite on its second generated tree. The first
      // implementation threw here, which would have made a perfectly ordinary
      // situation, restoring saved expansion state before its data has loaded,
      // an exception. When M2 makes stores mutable, the recorded expansion has
      // to take effect at the moment the ancestor's children arrive.
      this.expandedSet.add(id)
      return
    }
    if ((this.flags[index] ?? 0) & EXPANDED) return
    this.ensureChildren(index)

    const oldSpan = this.spanOf(index)
    const oldPh = this.phOf(index)
    this.flags[index] = (this.flags[index] ?? 0) | EXPANDED
    this.expandedSet.add(id)
    this.propagate(index, this.spanOf(index) - oldSpan, this.phOf(index) - oldPh)
  }

  collapse(id: NodeId): void {
    if (this.store.get(id) === undefined) throw new Error(`cannot collapse unknown node ${id}`)
    const index = this.locate(id)
    if (index === undefined) {
      this.expandedSet.delete(id)
      return
    }
    if (!((this.flags[index] ?? 0) & EXPANDED)) return

    const oldSpan = this.spanOf(index)
    const oldPh = this.phOf(index)
    this.flags[index] = (this.flags[index] ?? 0) & ~EXPANDED
    this.expandedSet.delete(id)
    this.propagate(index, this.spanOf(index) - oldSpan, this.phOf(index) - oldPh)
  }

  expandedIds(): ReadonlySet<NodeId> {
    return new Set(this.expandedSet)
  }

  /**
   * Re-reads one node's children and carries the difference up one ancestor
   * chain. This is the operation the whole design exists for: a subtree changing
   * size costs O(depth), not O(visible rows).
   */
  invalidate(id: NodeId): void {
    const index = this.indexById.get(id)
    if (index === undefined) return

    const oldSpan = this.spanOf(index)
    const oldPh = this.phOf(index)
    this.flags[index] = (this.flags[index] ?? 0) & ~(MATERIALIZED | UNLOADED)
    this.childStart[index] = -1
    this.childLen[index] = 0
    this.childSum[index] = 0
    this.phSum[index] = 0
    this.nonUnit[index] = 0
    this.estCount[index] = 0
    this.ensureChildren(index)
    this.propagate(index, this.spanOf(index) - oldSpan, this.phOf(index) - oldPh)
  }
}

export const spanFactory = (
  store: TreeStore,
  initiallyExpanded: Iterable<NodeId> = [],
): Projection => new SpanProjection(store, initiallyExpanded)
