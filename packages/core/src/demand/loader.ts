import type { CoverageStore } from '../coverage/store.js'
import type { PublishOutcome } from '../coverage/types.js'
import type { NodeId } from '../model/ids.js'
import type { Projection } from '../projection/types.js'
import { requestKey, type HierarchySource } from '../source/types.js'
import { computeDemand } from './compute.js'
import type { Demand, LoadReport, Viewport } from './types.js'

export interface ViewportLoaderOptions {
  readonly pageSize?: number
}

const keyOf = (demand: Demand): string => requestKey(demand)

/**
 * Turns a viewport into pages.
 *
 * Deliberately thin: the interesting part is `computeDemand`, which is pure. This
 * owns three things a pure function cannot, and nothing else.
 *
 * **In-flight keys.** An identical request already outstanding is never issued
 * again. Deduplication lives here rather than in `CoverageStore`, because invariant
 * N6 exists to catch a demand layer that issues the same page twice, and a store
 * that quietly swallowed the second one would hide exactly the defect N6 is for.
 *
 * **Abort controllers.** One per in-flight key, so a consumer can cancel
 * everything on teardown. Requests are not cancelled merely because demand moved
 * on: the answer is still correct when it arrives, and cancelling it would only
 * force it to be asked again.
 *
 * **Pending expansion.** `Projection.expand` throws for a node the store does not
 * hold, and under D2 an unloaded node is genuinely absent, so the projection cannot
 * tell a restored session from a typo and should not have to. Restoring expansion
 * for a node whose parent's page has not arrived is ordinary, so the intent is
 * recorded here and applied when a page containing that node lands. One Set,
 * applied on arrival, in the layer where "arrives later" already lives. It is not a
 * deferred-command framework and must not become one.
 */
export class ViewportLoader {
  private viewport: Viewport = { startIndex: 0, endIndex: 0, overscan: 0 }
  private readonly controllers = new Map<string, AbortController>()
  private readonly pendingExpansion = new Set<NodeId>()
  private readonly pageSize: number

  constructor(
    private readonly source: HierarchySource,
    private readonly coverage: CoverageStore,
    private readonly projection: Projection,
    options: ViewportLoaderOptions = {},
  ) {
    this.pageSize = options.pageSize ?? 100
  }

  setViewport(viewport: Viewport): void {
    this.viewport = viewport
  }

  getViewport(): Viewport {
    return this.viewport
  }

  /**
   * Expands a node now, or records the intent if it is not loaded yet.
   *
   * Returns whether it took effect immediately, so a consumer can tell the two
   * apart without inspecting internals.
   */
  expand(id: NodeId): boolean {
    if (this.coverage.get(id) === undefined) {
      this.pendingExpansion.add(id)
      return false
    }
    this.projection.expand(id)
    return true
  }

  collapse(id: NodeId): void {
    this.pendingExpansion.delete(id)
    if (this.coverage.get(id) !== undefined) this.projection.collapse(id)
  }

  /** Ids whose expansion is recorded but not yet applied. */
  pendingExpansions(): readonly NodeId[] {
    return [...this.pendingExpansion]
  }

  /** Request keys currently outstanding. Feeds invariant N6. */
  inFlight(): readonly string[] {
    return [...this.controllers.keys()]
  }

  /** What this state wants. Exposed so eviction can see an over-budget state coming. */
  demand(): readonly Demand[] {
    return computeDemand(this.coverage, this.projection, this.viewport, this.pageSize)
  }

  /** Cancels every outstanding request. For teardown. */
  abort(): void {
    for (const controller of this.controllers.values()) controller.abort()
    this.controllers.clear()
  }

  private applyPendingExpansions(): number {
    let applied = 0
    for (const id of [...this.pendingExpansion]) {
      if (this.coverage.get(id) === undefined) continue
      this.projection.expand(id)
      this.pendingExpansion.delete(id)
      applied += 1
    }
    return applied
  }

  /**
   * Issues everything currently demanded and not already in flight, then waits.
   *
   * One round. A round can create new demand, because a page that arrives may
   * reveal a branch or move the append point, so the caller loops until `demand()`
   * is empty. Looping here would hide how many rounds a viewport actually costs,
   * which is a number commit 9 needs to measure.
   */
  async load(): Promise<LoadReport> {
    const wanted = this.demand()
    const outcomes: PublishOutcome[] = []
    let deduplicated = 0
    const issued: Promise<void>[] = []

    for (const item of wanted) {
      const key = keyOf(item)
      if (this.controllers.has(key)) {
        deduplicated += 1
        continue
      }
      const controller = new AbortController()
      this.controllers.set(key, controller)
      const generation = this.coverage.generationOf(item.parentId)

      issued.push(
        this.source
          .loadChildren({
            parentId: item.parentId,
            offset: item.offset,
            limit: item.limit,
            signal: controller.signal,
          })
          .then((result) => {
            const outcome = this.coverage.publish({
              parentId: item.parentId,
              offset: item.offset,
              generation,
              nodes: result.nodes,
              exhausted: result.exhausted,
              ...(result.total === undefined ? {} : { total: result.total }),
            })
            outcomes.push(outcome)
            if (outcome.kind === 'applied') this.projection.invalidate(item.parentId)
          })
          .catch((error: unknown) => {
            // An abort is an ordinary outcome of teardown, not a failure of the
            // page. Anything else is left to surface: swallowing a source error
            // here would turn a broken source into a permanently empty branch.
            const name = (error as { name?: string } | undefined)?.name
            if (name !== 'AbortError') throw error
          })
          .finally(() => {
            this.controllers.delete(key)
          }),
      )
    }

    await Promise.all(issued)
    const expansionsApplied = this.applyPendingExpansions()
    return { requested: issued.length, deduplicated, outcomes, expansionsApplied }
  }
}
