import { atLeast, exact, type CountEstimate } from '../model/count.js'
import { orderKey, type NodeId } from '../model/ids.js'
import type { NodeRecord, TreeStore } from '../model/node.js'
import type { PagePublication, PublishOutcome } from './types.js'

/**
 * Coverage under the D2 model: every parent holds a contiguous loaded prefix of
 * its children, and nothing else.
 *
 * There is no interval set, no lease refcounting, no global registry and no
 * run-length placeholder structure, because none of them has anything to
 * represent. An unloaded region is not addressable, so no operation can create a
 * hole, so there are never disjoint ranges to track. That absence is the design,
 * not an omission.
 *
 * The store is also a `TreeStore`, so the M0 materialized projection consumes it
 * unchanged. A parent with nothing loaded reports `childIds: []` rather than
 * `undefined`, which is what keeps placeholder rows out of the projection: M0
 * emits placeholders only for `childIds === undefined`, and under D2 that state
 * never reaches it.
 */

interface ParentCoverage {
  /** The loaded prefix, in source order. Never sorted (ADR-0004). */
  loaded: NodeId[]
  exhausted: boolean
  total: number | undefined
  /** Bumped by `invalidate`. See `publish`. */
  generation: number
}

const emptyCoverage = (): ParentCoverage => ({
  loaded: [],
  exhausted: false,
  total: undefined,
  generation: 0,
})

export class CoverageStore implements TreeStore {
  private readonly coverage = new Map<NodeId | null, ParentCoverage>()
  private readonly records = new Map<NodeId, NodeRecord>()
  /** Whether the source said a node can have children, learned when it arrived. */
  private readonly branchy = new Map<NodeId, boolean>()

  // ------------------------------------------------------------------ reading

  get roots(): readonly NodeId[] {
    return this.coverage.get(null)?.loaded ?? []
  }

  get(id: NodeId): NodeRecord | undefined {
    return this.records.get(id)
  }

  get size(): number {
    return this.records.size
  }

  /** How many children of this parent are loaded. */
  loadedCount(parentId: NodeId | null): number {
    return this.coverage.get(parentId)?.loaded.length ?? 0
  }

  isExhausted(parentId: NodeId | null): boolean {
    return this.coverage.get(parentId)?.exhausted ?? false
  }

  totalOf(parentId: NodeId | null): number | undefined {
    return this.coverage.get(parentId)?.total
  }

  /**
   * Whether this parent's children are fully known: either the source said so, or
   * a total was supplied and the prefix has reached it.
   */
  isComplete(parentId: NodeId | null): boolean {
    const entry = this.coverage.get(parentId)
    if (entry === undefined) return false
    if (entry.exhausted) return true
    return entry.total !== undefined && entry.loaded.length >= entry.total
  }

  /** The value a caller must hand back when publishing a page it requested now. */
  generationOf(parentId: NodeId | null): number {
    return this.coverage.get(parentId)?.generation ?? 0
  }

  // ------------------------------------------------------------------ writing

  private entry(parentId: NodeId | null): ParentCoverage {
    const existing = this.coverage.get(parentId)
    if (existing !== undefined) return existing
    const created = emptyCoverage()
    this.coverage.set(parentId, created)
    return created
  }

  private childCountOf(parentId: NodeId | null): CountEstimate {
    const entry = this.coverage.get(parentId)
    const loaded = entry?.loaded.length ?? 0
    if (entry?.exhausted === true) return exact(loaded)
    if (entry?.total !== undefined) return exact(entry.total)
    // Nothing loaded yet, but the source said this node has children, so one is a
    // true lower bound and the only thing that makes the node openable.
    const known = parentId !== null && this.branchy.get(parentId) === true ? 1 : 0
    return atLeast(Math.max(loaded, known))
  }

  /** Rebuilds the immutable record for one node from current coverage. */
  private refresh(id: NodeId): void {
    const previous = this.records.get(id)
    if (previous === undefined) return
    const entry = this.coverage.get(id)
    this.records.set(id, {
      ...previous,
      childIds: entry?.loaded ?? [],
      childCount: this.childCountOf(id),
    })
  }

  /**
   * Offers a page.
   *
   * Three rules, in order, and each rejects rather than repairs:
   *
   * **Generation.** A page carries the generation its request was made under. This
   * catches the one case contiguity cannot: `invalidate` resets a prefix to empty,
   * an already-in-flight page for offset zero arrives, and offset zero is
   * contiguous with an empty prefix, so the stale data would be accepted as
   * current. One integer per parent, earned by one failure.
   *
   * **Contiguity.** A page must start exactly at the end of the prefix. Starting
   * beyond it would create a hole, and under D2 a hole is not representable, so it
   * is refused rather than tracked. Starting before it is a repeat.
   *
   * **Consistency.** A repeat must match what is already held, a total must never
   * shrink or contradict exhaustion, and no node may appear twice.
   */
  publish(page: PagePublication): PublishOutcome {
    const entry = this.entry(page.parentId)

    if (page.generation !== entry.generation) {
      return { kind: 'stale', expected: entry.generation, received: page.generation }
    }

    if (!Number.isInteger(page.offset) || page.offset < 0) {
      return { kind: 'conflict', reason: `offset ${page.offset} is not a valid index` }
    }

    if (page.offset > entry.loaded.length) {
      return { kind: 'gap', prefixLength: entry.loaded.length, offset: page.offset }
    }

    if (page.total !== undefined) {
      if (!Number.isInteger(page.total) || page.total < 0) {
        return { kind: 'conflict', reason: `total ${page.total} is not a valid count` }
      }
      if (entry.total !== undefined && page.total !== entry.total) {
        return {
          kind: 'conflict',
          reason: `total changed from ${entry.total} to ${page.total}`,
        }
      }
    }

    // A repeat of a range already held. Idempotent when it agrees, a conflict when
    // it does not, because a source that answers the same question two ways has
    // broken the identity the loading layer depends on.
    if (page.offset < entry.loaded.length) {
      const held = entry.loaded.slice(page.offset, page.offset + page.nodes.length)
      if (held.length !== page.nodes.length) {
        return {
          kind: 'conflict',
          reason: `repeat at ${page.offset} extends past the prefix without being contiguous`,
        }
      }
      for (const [index, node] of page.nodes.entries()) {
        if (held[index] !== node.id) {
          return {
            kind: 'conflict',
            reason: `repeat at ${page.offset} disagrees at index ${index}`,
          }
        }
      }
      return { kind: 'duplicate' }
    }

    // A contiguous append. Every incoming id must be new to the whole store: a node
    // that already exists elsewhere would break the projection's uniqueness
    // invariant, and the store is the only place that can see it coming.
    const seen = new Set<NodeId>()
    for (const node of page.nodes) {
      if (seen.has(node.id)) {
        return { kind: 'conflict', reason: `page contains ${node.id} more than once` }
      }
      seen.add(node.id)
      if (this.records.has(node.id)) {
        return { kind: 'conflict', reason: `${node.id} is already loaded elsewhere` }
      }
    }

    const nextLength = entry.loaded.length + page.nodes.length
    const authoritativeTotal = page.total ?? entry.total
    if (authoritativeTotal !== undefined && nextLength > authoritativeTotal) {
      return {
        kind: 'conflict',
        reason: `prefix would reach ${nextLength}, past a stated total of ${authoritativeTotal}`,
      }
    }
    if (page.exhausted && authoritativeTotal !== undefined && nextLength !== authoritativeTotal) {
      return {
        kind: 'conflict',
        reason: `exhausted at ${nextLength} contradicts a stated total of ${authoritativeTotal}`,
      }
    }

    for (const [index, node] of page.nodes.entries()) {
      const position = entry.loaded.length + index
      this.branchy.set(node.id, node.hasChildren)
      this.records.set(node.id, {
        id: node.id,
        parentId: page.parentId,
        // Derived from position in the prefix, which is source order. ADR-0004
        // requires order keys to agree with array order, and under D2 the index is
        // the only ordering information a source has given us.
        orderKey: orderKey(String(position).padStart(12, '0')),
        childIds: [],
        childCount: this.childCountOf(node.id),
      })
      entry.loaded.push(node.id)
    }

    if (page.total !== undefined) entry.total = page.total
    if (page.exhausted) entry.exhausted = true
    if (entry.total !== undefined && entry.loaded.length >= entry.total) entry.exhausted = true

    if (page.parentId !== null) this.refresh(page.parentId)
    return { kind: 'applied', added: page.nodes.length }
  }

  /**
   * Discards this parent's children and everything beneath them, and bumps its
   * generation so a page already in flight cannot land as if it were current.
   *
   * Expansion state is not touched, because it does not live here. M0 established
   * that expanding a node unreachable through loaded children is a recorded no-op,
   * so a subtree that was open before an invalidation reopens when its data
   * returns, which is what a reader expects from a refresh.
   */
  invalidate(parentId: NodeId | null): void {
    const entry = this.entry(parentId)
    this.dropSubtrees(entry.loaded)
    entry.loaded = []
    entry.exhausted = false
    entry.total = undefined
    entry.generation += 1
    if (parentId !== null) this.refresh(parentId)
  }

  private dropSubtrees(ids: readonly NodeId[]): void {
    const stack = [...ids]
    while (stack.length > 0) {
      const id = stack.pop()
      if (id === undefined) continue
      const entry = this.coverage.get(id)
      if (entry !== undefined) {
        for (const child of entry.loaded) stack.push(child)
        this.coverage.delete(id)
      }
      this.records.delete(id)
      this.branchy.delete(id)
    }
  }

  /** Ids in insertion order. For tests and diagnostics. */
  entries(): IterableIterator<[NodeId, NodeRecord]> {
    return this.records.entries()
  }
}
