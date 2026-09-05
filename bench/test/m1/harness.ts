import {
  CoverageStore,
  InMemorySource,
  MaterializedProjection,
  approximate,
  requestKey,
  type NodeId,
  type PublishOutcome,
} from '@understory/core'
import type { MapTreeStore } from '@understory/core'
import {
  checkM1Invariants,
  fingerprint,
  type M1State,
  type Viewport,
  type Violation,
} from './invariants.js'

/**
 * Drives an M1 state through a scripted trace.
 *
 * The harness supplies what commits 7 and 8 will own, and only as data: a
 * declared viewport, a budget, and an explicit instruction to discard a parent's
 * coverage. It contains no demand policy and no eviction policy. `evict` is a
 * trace instruction that calls the existing `invalidate` primitive; deciding
 * *which* parent and *when* is what commit 8 adds, and simulating that here would
 * be writing the thing this suite exists to test.
 */

export type SettleOrder = 'inOrder' | 'reverse' | 'shuffled'

export type Step =
  | { readonly op: 'expand'; readonly id: NodeId }
  | { readonly op: 'collapse'; readonly id: NodeId }
  | { readonly op: 'viewport'; readonly start: number; readonly end: number }
  | {
      readonly op: 'request'
      readonly parentId: NodeId | null
      readonly offset: number
      readonly limit: number
    }
  | { readonly op: 'settle'; readonly order: SettleOrder }
  | { readonly op: 'evict'; readonly parentId: NodeId }

interface Outstanding {
  readonly key: string
  readonly parentId: NodeId | null
  readonly offset: number
  readonly limit: number
  promise: Promise<void>
  /** What the coverage store did with it. Undefined until it settles. */
  outcome?: PublishOutcome
}

export interface HarnessOptions {
  readonly overscan?: number
  readonly budget?: number
  readonly reportTotal?: boolean
  readonly maxPageSize?: number
  readonly seed?: number
}

export class Harness {
  readonly coverage = new CoverageStore()
  readonly projection: MaterializedProjection
  readonly source: InMemorySource
  readonly outcomes: PublishOutcome[] = []

  private viewportState: Viewport
  private readonly budget: number
  private outstanding: Outstanding[] = []
  private evictedThisStep: NodeId[] = []
  private previousLoaded = new Map<NodeId | null, number>()
  private rng: number

  constructor(
    readonly truth: MapTreeStore,
    private readonly options: HarnessOptions = {},
  ) {
    this.projection = new MaterializedProjection(this.coverage)
    this.source = new InMemorySource(truth, {
      mode: 'manual',
      reportTotal: options.reportTotal ?? true,
      ...(options.maxPageSize === undefined ? {} : { maxPageSize: options.maxPageSize }),
    })
    this.viewportState = { start: 0, end: 40, overscan: options.overscan ?? 20 }
    this.budget = options.budget ?? Number.POSITIVE_INFINITY
    this.rng = options.seed ?? 1
  }

  private nextRandom(): number {
    this.rng = (Math.imul(this.rng, 1664525) + 1013904223) | 0
    return Math.abs(this.rng)
  }

  get rowCount(): number {
    return approximate(this.projection.count())
  }

  fingerprint(): string {
    return fingerprint(this.coverage, this.projection)
  }

  state(): M1State {
    return {
      coverage: this.coverage,
      projection: this.projection,
      truth: this.truth,
      viewport: this.viewportState,
      budget: this.budget,
      inFlight: this.outstanding.map((o) => o.key),
      evictedThisStep: this.evictedThisStep,
      previousLoaded: this.previousLoaded,
    }
  }

  check(): Violation[] {
    const violations = checkM1Invariants(this.state())
    this.previousLoaded = new Map([
      [null, this.coverage.loadedCount(null)],
      ...[...this.coverage.entries()].map(
        ([id]) => [id, this.coverage.loadedCount(id)] as [NodeId | null, number],
      ),
    ])
    this.evictedThisStep = []
    return violations
  }

  /** Issues a request without releasing it. Publication happens in `settle`. */
  request(parentId: NodeId | null, offset: number, limit: number): void {
    const generation = this.coverage.generationOf(parentId)
    const key = requestKey({ parentId, offset, limit })
    const entry: Outstanding = { key, parentId, offset, limit, promise: Promise.resolve() }
    entry.promise = this.source
      .loadChildren({ parentId, offset, limit, signal: new AbortController().signal })
      .then((result) => {
        const outcome = this.coverage.publish({
          parentId,
          offset,
          generation,
          nodes: result.nodes,
          exhausted: result.exhausted,
          ...(result.total === undefined ? {} : { total: result.total }),
        })
        entry.outcome = outcome
        this.outcomes.push(outcome)
        if (outcome.kind === 'applied') this.projection.invalidate(parentId)
      })
      .catch(() => {
        // Aborts are not exercised by these traces; a rejection here would be a
        // harness defect and shows up as a missing page rather than silence.
      })
    this.outstanding.push(entry)
  }

  /**
   * Releases every outstanding request in the given order and applies the results.
   *
   * Out-of-order arrival leaves gaps refused, so this retries until nothing more
   * applies. That retry is the model of what commit 7's demand loop will do, and
   * the point of N8 is that the retry converges regardless of arrival order.
   */
  async settle(order: SettleOrder): Promise<void> {
    for (let round = 0; round < 12; round++) {
      const pending = [...this.source.pending()]
      if (pending.length === 0) break
      if (order === 'reverse') pending.reverse()
      if (order === 'shuffled') {
        for (let i = pending.length - 1; i > 0; i--) {
          const j = this.nextRandom() % (i + 1)
          const a = pending[i]
          const b = pending[j]
          if (a !== undefined && b !== undefined) {
            pending[i] = b
            pending[j] = a
          }
        }
      }
      this.source.releaseIn(pending)
      const attempted = this.outstanding
      this.outstanding = []
      await Promise.all(attempted.map((o) => o.promise))

      // Anything refused as a gap is re-asked, which is what commit 7's demand
      // loop will do. N8 is the claim that this converges whatever the order.
      //
      // The retry keys on the recorded outcome, not on arithmetic. A first version
      // re-asked when `offset > loadedCount`, which drops a page whose offset
      // happens to equal the prefix length by the time the round ends: on reverse
      // arrival the contiguous page applies last, so an earlier gap is left sitting
      // exactly at the new boundary and looks satisfied. N8 caught it as a
      // divergence between orderings on two shapes.
      let retried = 0
      for (const item of attempted) {
        if (item.outcome?.kind !== 'gap') continue
        this.request(item.parentId, item.offset, item.limit)
        retried += 1
      }
      if (retried === 0) break
    }
    this.outstanding = []
  }

  async apply(step: Step): Promise<void> {
    switch (step.op) {
      case 'expand':
        this.projection.expand(step.id)
        break
      case 'collapse':
        this.projection.collapse(step.id)
        break
      case 'viewport':
        this.viewportState = { ...this.viewportState, start: step.start, end: step.end }
        break
      case 'request':
        this.request(step.parentId, step.offset, step.limit)
        break
      case 'settle':
        await this.settle(step.order)
        break
      case 'evict':
        this.coverage.invalidate(step.parentId)
        this.projection.invalidate(step.parentId)
        this.evictedThisStep.push(step.parentId)
        break
    }
  }

  /** Runs a trace, checking every invariant after every step. */
  async run(steps: readonly Step[]): Promise<Violation[]> {
    const found: Violation[] = []
    this.check()
    for (const [index, step] of steps.entries()) {
      await this.apply(step)
      for (const violation of this.check()) found.push(`step ${index} (${step.op}): ${violation}`)
      if (found.length > 0) break
    }
    return found
  }
}
