import { approximate, type NodeId, type Projection, type Row } from '@understory/core'

/**
 * The theoretical minimum request count, exactly as docs/m1-definition.md §8
 * defines it, plus one diagnostic that §8 did not anticipate.
 *
 * §8: for page size P, `Reach(p)` is the set of child slots of parent `p` that were
 * inside `[start - overscan, end + overscan)` at any point during the trace, and
 *
 * ```
 * min = Σ over parents p of |{ floor(s / P) : s ∈ Reach(p) }|
 * ```
 *
 * **A defect in that definition under D2, found while implementing it.** Coverage
 * is a loaded *prefix*, so page k of a parent cannot be fetched until pages 0 to
 * k-1 have been. An omniscient loader is omniscient about *what* to fetch, not
 * about the contiguity rule the store enforces, so the smallest achievable request
 * count for a parent whose page 3 was ever visible is four pages, not one. Where a
 * trace jumps into the middle of a parent, §8's minimum is unreachable by any
 * loader, and amplification measured against it overstates the engine's waste.
 *
 * This is reported, not substituted. `minimumPages` is §8 as committed and is what
 * A3 and A4 are computed against. `minimumPagesPrefixClosed` is the smallest count
 * a D2 loader could actually achieve, carried alongside as a diagnostic so commit
 * 10 can decide what to do about the discrepancy. Silently switching to the second
 * number would be amending a pre-registered definition after seeing that it is
 * inconvenient.
 */
export class ReachTracker {
  /** Page indices of this parent that held a visible slot at some point. */
  private readonly pages = new Map<string, Set<number>>()
  /** Highest child slot of this parent ever visible, for the prefix-closed count. */
  private readonly deepestSlot = new Map<string, number>()

  private peakRows = 0
  private peakVisibleRows = 0

  constructor(private readonly pageSize: number) {}

  private static parentKey(parentId: NodeId | null): string {
    return parentId === null ? 'r:' : `n:${parentId}`
  }

  /**
   * Records what this state makes visible.
   *
   * Slots are counted by walking rows in traversal order and incrementing a
   * per-parent counter, rather than by looking each row up in its parent's child
   * list. Under D2 a parent's loaded children are a prefix in source order, so the
   * k-th node row with parent `p` is `p`'s k-th slot. The lookup version is
   * `indexOf` inside a loop, which is the O(n²) mistake M0 made once already.
   */
  observe(rows: readonly Row[], from: number, to: number): void {
    this.peakRows = Math.max(this.peakRows, rows.length)
    const slotCounter = new Map<string, number>()
    let visible = 0

    for (const row of rows) {
      if (row.kind !== 'node') continue
      const key = ReachTracker.parentKey(row.parentId)
      const slot = slotCounter.get(key) ?? 0
      slotCounter.set(key, slot + 1)
      if (row.index < from || row.index >= to) continue
      visible += 1

      let seen = this.pages.get(key)
      if (seen === undefined) {
        seen = new Set<number>()
        this.pages.set(key, seen)
      }
      seen.add(Math.floor(slot / this.pageSize))
      this.deepestSlot.set(key, Math.max(this.deepestSlot.get(key) ?? 0, slot))
    }

    this.peakVisibleRows = Math.max(this.peakVisibleRows, visible)
  }

  /** Convenience for the common case of asking a projection for its whole row set. */
  observeProjection(projection: Projection, from: number, to: number): readonly Row[] {
    const rows = projection.slice(0, approximate(projection.count()))
    this.observe(rows, from, to)
    return rows
  }

  /** §8 as committed. A3 and A4 are computed against this. */
  get minimumPages(): number {
    let total = 0
    for (const seen of this.pages.values()) total += seen.size
    return total
  }

  /** Diagnostic: the smallest count a prefix-constrained loader could achieve. */
  get minimumPagesPrefixClosed(): number {
    let total = 0
    for (const slot of this.deepestSlot.values()) total += Math.floor(slot / this.pageSize) + 1
    return total
  }

  /**
   * Diagnostic: the smallest count a *correct* D2 loader could achieve, given the
   * same script of expansions and viewport moves.
   *
   * §8 counts a page as necessary only if one of its slots was visible. That misses
   * a second class of request that no correct engine can avoid. Expanding a node
   * changes the index space: its children become rows, and every row below them
   * shifts. The engine cannot know how far to shift without loading the first page,
   * so an expansion forces a fetch whether or not the children are ever looked at.
   *
   * Measured, not assumed: on `balanced`, W1 fetched 62 pages against a §8 minimum
   * of 11 with zero duplicate requests, and the difference is entirely parents that
   * the trace expanded off screen. Reported alongside §8's number rather than in
   * place of it, because A3 and A4 are pre-registered against §8.
   */
  minimumPagesAchievable(expanded: ReadonlySet<NodeId>): number {
    const keys = new Set<string>([...this.deepestSlot.keys(), 'r:'])
    for (const id of expanded) keys.add(ReachTracker.parentKey(id))
    let total = 0
    for (const key of keys) {
      const slot = this.deepestSlot.get(key)
      total += slot === undefined ? 1 : Math.floor(slot / this.pageSize) + 1
    }
    return total
  }

  get parentsEverVisible(): number {
    return this.pages.size
  }

  get maxRowsObserved(): number {
    return this.peakRows
  }

  get maxVisibleRowsObserved(): number {
    return this.peakVisibleRows
  }
}
