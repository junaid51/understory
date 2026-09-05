import type { CoverageStore } from '../coverage/store.js'
import type { Viewport } from '../demand/types.js'
import { approximate } from '../model/count.js'
import type { NodeId } from '../model/ids.js'
import type { Projection } from '../projection/types.js'

export interface EvictionReport {
  /** `null` is the roots, which are a parent like any other and can be discarded
   *  when nothing at all is visible. Recording only node ids hid that entirely. */
  readonly evicted: readonly (NodeId | null)[]
  readonly rowsBefore: number
  readonly rowsAfter: number
  readonly budget: number
  /** Parents the protected window forbids discarding. */
  readonly protectedParents: number
  /**
   * True when rows are still over budget and nothing may be discarded, because
   * every loaded parent is inside the protected window. Not an error: it is the
   * state the M1 definition names as a REVERSE condition, and it has to be visible
   * rather than silently tolerated.
   */
  readonly stuck: boolean
}

export interface BudgetEvictorOptions {
  /**
   * Maximum materialized rows.
   *
   * Deliberately required, with no default. The calibrated value is 4,000 and it
   * lives in `bench/thresholds.m1.json`, derived from a measurement on one class of
   * machine. Baking that number into the library would ship a laptop's cache
   * behaviour as an API constant.
   */
  readonly budget: number
}

interface ProtectedSet {
  readonly ids: ReadonlySet<NodeId | null>
  /** First-appearance order, used to make LRU marking deterministic. */
  readonly ordered: readonly (NodeId | null)[]
}

/**
 * Which parents the protected window forbids discarding.
 *
 * A row inside the window is destroyed by evicting any of its ancestors, so every
 * ancestor of every in-window row is protected. The row's own id is not protected
 * by its own position: discarding its children removes rows below it, all of which
 * are outside the window by construction. That distinction is what lets a parent
 * sitting on screen still shed the subtree hanging off it.
 */
function protectedParents(projection: Projection, viewport: Viewport): ProtectedSet {
  const total = approximate(projection.count())
  const rows = projection.slice(0, total)
  const from = viewport.startIndex - viewport.overscan
  const to = viewport.endIndex + viewport.overscan

  const ids = new Set<NodeId | null>()
  const ordered: (NodeId | null)[] = []
  const add = (id: NodeId | null): void => {
    if (ids.has(id)) return
    ids.add(id)
    ordered.push(id)
  }

  const ancestors: NodeId[] = []
  for (const row of rows) {
    ancestors.length = row.depth
    if (row.index >= from && row.index < to) {
      // The roots own the top level, so any visible row protects them.
      add(null)
      for (let depth = 0; depth < row.depth; depth++) {
        const ancestor = ancestors[depth]
        if (ancestor !== undefined) add(ancestor)
      }
    }
    if (row.kind === 'node') ancestors[row.depth] = row.id
  }
  return { ids, ordered }
}

/**
 * Holds materialized rows within a budget by discarding coverage that nobody is
 * looking at.
 *
 * The whole mechanism is four steps: find what the protected window forbids, mark
 * those as recently used, take the least recently used of everything else, and
 * `invalidate` it. Demand refills whatever comes back into view. There is no cache
 * framework, no priority queue, no scheduler and no timestamp abstraction, because
 * none of them has a job here.
 *
 * Separate from demand on purpose. Demand decides what should be loaded; eviction
 * decides what may be discarded to restore the bounded-row invariant. A demand
 * layer that quietly refused to load would make an over-budget state invisible to
 * the layer responsible for fixing it.
 */
export class BudgetEvictor {
  private readonly budget: number
  /** Monotonic, incremented per assignment, so two marks are never equal. */
  private clock = 0
  private readonly lastTouched = new Map<NodeId | null, number>()

  constructor(
    private readonly coverage: CoverageStore,
    private readonly projection: Projection,
    options: BudgetEvictorOptions,
  ) {
    this.budget = options.budget
  }

  /** The mark a parent currently carries. Zero means never protected. Diagnostic. */
  lastTouchedAt(parentId: NodeId | null): number {
    return this.lastTouched.get(parentId) ?? 0
  }

  private loadedParents(): (NodeId | null)[] {
    const parents: (NodeId | null)[] = []
    if (this.coverage.loadedCount(null) > 0) parents.push(null)
    for (const [id] of this.coverage.entries()) {
      if (this.coverage.loadedCount(id) > 0) parents.push(id)
    }
    return parents
  }

  /**
   * Marks what the window touches, then discards least-recently-touched coverage
   * until rows are within budget.
   *
   * Call after every interaction, not only when over budget: the marks are what
   * make the choice meaningful, and a parent that was on screen ten viewports ago
   * has to be distinguishable from one that never was.
   */
  sweep(viewport: Viewport): EvictionReport {
    const rowsBefore = approximate(this.projection.count())

    // Marks for parents that hold nothing are meaningless, and keeping one would
    // let a parent that was evicted and later reloaded inherit an old position in
    // the queue. Keyed on loaded count, not on whether the record still exists:
    // `invalidate` discards a parent's children and keeps the parent, so a check
    // for record absence never fired.
    for (const id of [...this.lastTouched.keys()]) {
      if (this.coverage.loadedCount(id) === 0) this.lastTouched.delete(id)
    }

    const shielded = protectedParents(this.projection, viewport)
    // Row order, and one increment per parent, so no two marks are ever equal and
    // ties cannot arise. Among parents touched by the same sweep, the one appearing
    // earlier in the row sequence carries the older mark and is preferred for
    // eviction, which is deterministic and tested rather than incidental.
    for (const id of shielded.ordered) this.lastTouched.set(id, ++this.clock)

    const evicted: (NodeId | null)[] = []
    let rows = rowsBefore
    let stuck = false

    while (rows > this.budget) {
      // Recomputed each iteration and routed through `candidates`, so the policy has
      // exactly one definition. Protection changes as rows disappear, and a second
      // inline copy of the ordering would be a second thing to get wrong.
      const victim = this.candidates(viewport)[0]
      if (victim === undefined) {
        stuck = true
        break
      }

      this.coverage.invalidate(victim)
      this.projection.invalidate(victim)
      this.lastTouched.delete(victim)
      evicted.push(victim)

      const after = approximate(this.projection.count())
      if (after >= rows) {
        // Discarding a candidate did not reduce the row count. Nothing here can,
        // so continuing would spin on the same victim forever. Found by a fault
        // that stubbed out coverage invalidation, and worth keeping: a loop whose
        // termination depends on another object doing its job should check.
        stuck = true
        rows = after
        break
      }
      rows = after
    }

    return {
      evicted,
      rowsBefore,
      rowsAfter: rows,
      budget: this.budget,
      protectedParents: shielded.ids.size,
      stuck,
    }
  }

  /** The parents this viewport currently forbids discarding. For tests and N3. */
  protectedNow(viewport: Viewport): readonly (NodeId | null)[] {
    return protectedParents(this.projection, viewport).ordered
  }

  /**
   * The order eviction would take, oldest mark first.
   *
   * Exposed so the LRU policy can be asserted directly rather than inferred from
   * which rows happened to vanish, and so commit 9 can report what a workload was
   * about to discard.
   */
  candidates(viewport: Viewport): readonly (NodeId | null)[] {
    const shielded = protectedParents(this.projection, viewport).ids
    return this.loadedParents()
      .filter((id) => !shielded.has(id))
      .sort((a, b) => (this.lastTouched.get(a) ?? 0) - (this.lastTouched.get(b) ?? 0))
  }
}
