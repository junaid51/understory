import {
  BudgetEvictor,
  CoverageStore,
  InMemorySource,
  MaterializedProjection,
  ViewportLoader,
  approximate,
  exactValue,
  type CountEstimate,
  type HierarchySource,
  type MapTreeStore,
  type NodeId,
  type PublishOutcome,
  type Row,
} from '@understory/core'
import { generate, type ShapeName } from '@understory/bench/corpus'
import { ReachTracker, analyseLedger, checkM1Invariants } from '@understory/bench/m1'
import { ProceduralSource } from './procedural-source.js'
import { RecordingSource, type LabRequestEvent } from './recording-source.js'

/**
 * The M1 engine, wired exactly as the benchmark wires it.
 *
 * `CoverageStore` for the loaded prefix, `MaterializedProjection` for the index
 * space, `ViewportLoader` for demand, `BudgetEvictor` for the bound. There is no
 * demo-side reimplementation of any of them, and no demo-side copy of their state:
 * every number the panels display is read back out of these four objects, or
 * computed from the request ledger by the benchmark's own `analyseLedger`.
 *
 * The one thing the laboratory adds is the loop that a renderer would own anyway:
 * push a viewport, ask demand what it wants, sweep, repeat.
 */

/**
 * Spreads a source's response times without changing its answers.
 *
 * Deliberately a wrapper rather than an option on the sources: jitter is a property
 * of a network, and giving `InMemorySource` a notion of it would put benchmark
 * scaffolding into a reference implementation that the contract tests depend on.
 */
function jittered(inner: HierarchySource, config: LabConfig): HierarchySource {
  if (config.jitter <= 0 || config.latencyMs <= 0) return inner
  return {
    loadChildren: (request) =>
      inner.loadChildren(request).then(
        (result) =>
          new Promise((resolve) => {
            const spread = config.latencyMs * config.jitter * Math.random()
            setTimeout(() => resolve(result), spread)
          }),
      ),
  }
}

/** Above this the corpus is procedural, because `generate` becomes superlinear. */
export const MATERIALISED_LIMIT = 200_000

export interface LabConfig {
  readonly shape: ShapeName
  readonly nodes: number
  readonly pageSize: number
  readonly latencyMs: number
  readonly reportTotal: boolean
  readonly eviction: boolean
  readonly budget: number
  readonly viewportRows: number
  readonly overscan: number
  /**
   * Response time spread, as a fraction of latency.
   *
   * A source property, not an engine one. With a fixed latency every request in a
   * round arrives in issue order, so out-of-order arrival never happens and the
   * store's gap path is never reached. The benchmark modelled the same thing with
   * seeded jitter on a virtual clock, and the finding there is worth reproducing
   * here: even with arrivals reordered, demand only ever asks for the page after a
   * parent's loaded prefix, so two pages of one parent are never in flight together
   * and the gap counter stays at zero. That zero is a result, not a gap in the demo.
   */
  readonly jitter: number
}

export interface LabCounters {
  readonly requested: number
  readonly applied: number
  readonly duplicatePages: number
  readonly stalePages: number
  readonly gapPages: number
  readonly conflictPages: number
  readonly duplicateRequests: number
  readonly overlappingRequests: number
  readonly refetchesAfterEviction: number
  readonly evictions: number
  readonly sweeps: number
  readonly stuckSweeps: number
}

export interface LabSnapshot {
  readonly config: LabConfig
  /** Nodes the source could serve. Not materialised, and for large scales never was. */
  readonly logicalNodes: number
  readonly materialisedRows: number
  readonly visibleRows: number
  readonly count: CountEstimate
  readonly countIsExact: boolean
  readonly viewport: { start: number; end: number; overscan: number }
  readonly rows: readonly Row[]
  readonly expandedCount: number
  readonly expandedIds: ReadonlySet<NodeId>
  readonly loadedParents: number
  readonly prefixes: readonly { id: string; loaded: number; total?: number; exhausted: boolean }[]
  readonly inFlight: number
  readonly pendingDemand: number
  readonly epoch: number
  readonly lastSweepStuck: boolean
  /** Parents eviction may currently take. Zero while protected is non-zero is why a sweep sticks. */
  readonly evictionCandidates: number
  /** Parents the protected window currently forbids discarding. */
  readonly protectedParents: number
  readonly counters: LabCounters
  readonly minimumPages: number
  readonly minimumPagesAchievable: number
  readonly amplification: number
  readonly invariantStatus: 'ok' | 'violated' | 'unavailable'
  readonly violations: readonly string[]
  readonly corpusMode: 'materialised' | 'procedural'
}

export type LabEvent =
  | LabRequestEvent
  | { kind: 'expand'; at: number; id: NodeId }
  | { kind: 'collapse'; at: number; id: NodeId }
  | {
      kind: 'evict'
      at: number
      parents: readonly (NodeId | null)[]
      rowsBefore: number
      rowsAfter: number
    }
  | { kind: 'stuck'; at: number; rows: number; budget: number }
  | { kind: 'publish'; at: number; outcome: PublishOutcome['kind']; parentId: NodeId | null }

const EMPTY_COUNTERS: LabCounters = {
  requested: 0,
  applied: 0,
  duplicatePages: 0,
  stalePages: 0,
  gapPages: 0,
  conflictPages: 0,
  duplicateRequests: 0,
  overlappingRequests: 0,
  refetchesAfterEviction: 0,
  evictions: 0,
  sweeps: 0,
  stuckSweeps: 0,
}

export class Lab {
  readonly coverage = new CoverageStore()
  readonly projection: MaterializedProjection
  readonly loader: ViewportLoader
  readonly source: RecordingSource

  private readonly evictor: BudgetEvictor | undefined
  private readonly reach: ReachTracker
  private readonly truth: MapTreeStore | undefined
  private readonly logical: number

  private start = 0
  private counters = { ...EMPTY_COUNTERS }
  private lastSweepStuck = false
  private events: LabEvent[] = []

  constructor(
    readonly config: LabConfig,
    private readonly onEvent: (event: LabEvent) => void,
  ) {
    this.projection = new MaterializedProjection(this.coverage)
    this.reach = new ReachTracker(config.pageSize)

    const record = (event: LabEvent): void => {
      this.events.push(event)
      this.onEvent(event)
    }

    if (config.nodes <= MATERIALISED_LIMIT) {
      // The real seeded generator, so the shapes are the ones the benchmark
      // measured rather than an approximation of them.
      const truth = generate(config.shape, { nodes: config.nodes, seed: 42 })
      this.truth = truth
      this.logical = truth.size
      this.source = new RecordingSource(
        jittered(
          new InMemorySource(truth, {
            mode: config.latencyMs > 0 ? 'latency' : 'immediate',
            latencyMs: config.latencyMs,
            reportTotal: config.reportTotal,
          }),
          config,
        ),
        this.coverage,
        record,
      )
    } else {
      const procedural = new ProceduralSource({
        shape: config.shape,
        targetNodes: config.nodes,
        reportTotal: config.reportTotal,
        latencyMs: config.latencyMs,
      })
      this.truth = undefined
      this.logical = procedural.nominalSize
      this.source = new RecordingSource(jittered(procedural, config), this.coverage, record)
    }

    this.loader = new ViewportLoader(this.source, this.coverage, this.projection, {
      pageSize: config.pageSize,
    })
    this.evictor = config.eviction
      ? new BudgetEvictor(this.coverage, this.projection, { budget: config.budget })
      : undefined
    this.pushViewport()
  }

  get corpusMode(): 'materialised' | 'procedural' {
    return this.truth === undefined ? 'procedural' : 'materialised'
  }

  private pushViewport(): void {
    this.loader.setViewport({
      startIndex: this.start,
      endIndex: this.start + this.config.viewportRows,
      overscan: this.config.overscan,
    })
  }

  setStart(start: number): void {
    this.start = Math.max(0, Math.round(start))
    this.pushViewport()
  }

  expand(id: NodeId): void {
    this.loader.expand(id)
    this.emit({ kind: 'expand', at: performance.now(), id })
  }

  /** Collapses everything currently expanded. Coverage is untouched: this is not eviction. */
  collapseAll(): void {
    for (const id of [...this.projection.expandedIds()]) this.collapse(id)
  }

  collapse(id: NodeId): void {
    this.loader.collapse(id)
    this.emit({ kind: 'collapse', at: performance.now(), id })
  }

  isExpanded(id: NodeId): boolean {
    return this.projection.isExpanded(id)
  }

  /**
   * Whether opening this node would reveal anything, as coverage understands it.
   *
   * `SourceNode.hasChildren` is why the field exists: under D2 a node with no
   * loaded children and no known total is indistinguishable from a leaf, so
   * without it nothing could ever be opened. The autoplay driver needs the same
   * answer, and asking coverage is asking the engine rather than guessing.
   */
  hasChildren(id: NodeId): boolean {
    const record = this.coverage.get(id)
    return record !== undefined && approximate(record.childCount) > 0
  }

  private emit(event: LabEvent): void {
    this.events.push(event)
    this.onEvent(event)
  }

  /** One round of demand. Returns whether anything was asked for. */
  async step(): Promise<boolean> {
    const wanted = this.loader.demand()
    if (wanted.length === 0) return false
    const report = await this.loader.load()
    this.counters = {
      ...this.counters,
      requested: this.counters.requested + report.requested,
    }
    for (const outcome of report.outcomes) {
      this.counters = {
        ...this.counters,
        applied: this.counters.applied + (outcome.kind === 'applied' ? 1 : 0),
        duplicatePages: this.counters.duplicatePages + (outcome.kind === 'duplicate' ? 1 : 0),
        stalePages: this.counters.stalePages + (outcome.kind === 'stale' ? 1 : 0),
        gapPages: this.counters.gapPages + (outcome.kind === 'gap' ? 1 : 0),
        conflictPages: this.counters.conflictPages + (outcome.kind === 'conflict' ? 1 : 0),
      }
      this.emit({
        kind: 'publish',
        at: performance.now(),
        outcome: outcome.kind,
        parentId: null,
      })
    }
    return true
  }

  /**
   * Sweeps the evictor, exactly as the benchmark runner does: after every
   * interaction, not only when over budget, because the marks it lays down are
   * what make the later choice meaningful.
   */
  sweep(): void {
    if (this.evictor === undefined) return
    const report = this.evictor.sweep({
      startIndex: this.start,
      endIndex: this.start + this.config.viewportRows,
      overscan: this.config.overscan,
    })
    this.counters = {
      ...this.counters,
      sweeps: this.counters.sweeps + 1,
      evictions: this.counters.evictions + report.evicted.length,
      stuckSweeps: this.counters.stuckSweeps + (report.stuck ? 1 : 0),
    }
    this.lastSweepStuck = report.stuck
    if (report.evicted.length > 0) {
      this.source.evictionHappened()
      this.emit({
        kind: 'evict',
        at: performance.now(),
        parents: report.evicted,
        rowsBefore: report.rowsBefore,
        rowsAfter: report.rowsAfter,
      })
    }
    if (report.stuck) {
      this.emit({
        kind: 'stuck',
        at: performance.now(),
        rows: report.rowsAfter,
        budget: report.budget,
      })
    }
  }

  /** Everything the panels display, read back out of the engine. */
  snapshot(): LabSnapshot {
    const viewport = {
      startIndex: this.start,
      endIndex: this.start + this.config.viewportRows,
      overscan: this.config.overscan,
    }
    const count = this.projection.count()
    const total = approximate(count)
    const rows = this.projection.slice(0, total)
    const end = this.start + this.config.viewportRows
    const from = Math.max(0, this.start - this.config.overscan)
    const to = end + this.config.overscan

    this.reach.observe(rows, from, to)

    const prefixes: { id: string; loaded: number; total?: number; exhausted: boolean }[] = []
    const rootTotal = this.coverage.totalOf(null)
    prefixes.push({
      id: '<roots>',
      loaded: this.coverage.loadedCount(null),
      ...(rootTotal === undefined ? {} : { total: rootTotal }),
      exhausted: this.coverage.isExhausted(null),
    })
    let loadedParents = this.coverage.loadedCount(null) > 0 ? 1 : 0
    for (const [id] of this.coverage.entries()) {
      const loaded = this.coverage.loadedCount(id)
      if (loaded === 0) continue
      loadedParents += 1
      const parentTotal = this.coverage.totalOf(id)
      if (prefixes.length < 200) {
        prefixes.push({
          id,
          loaded,
          ...(parentTotal === undefined ? {} : { total: parentTotal }),
          exhausted: this.coverage.isExhausted(id),
        })
      }
    }

    const ledger = analyseLedger(this.source.ledger)
    const minimumPages = this.reach.minimumPages
    const visible = rows.filter((row) => row.index >= this.start && row.index < end).length

    let invariantStatus: LabSnapshot['invariantStatus'] = 'unavailable'
    let violations: string[] = []
    if (this.truth !== undefined) {
      violations = [
        ...checkM1Invariants({
          coverage: this.coverage,
          projection: this.projection,
          truth: this.truth,
          viewport: { start: this.start, end, overscan: this.config.overscan },
          // N2 is judged against the real budget only when eviction is running and
          // the last sweep was able to reach it. A stuck sweep is the state the
          // pre-registered REVERSE condition names, and the laboratory shows it as
          // STUCK rather than as an invariant failure.
          budget:
            this.config.eviction && !this.lastSweepStuck
              ? this.config.budget
              : Number.POSITIVE_INFINITY,
          inFlight: this.loader.inFlight(),
          evictedThisStep: [],
          previousLoaded: new Map(),
        }),
      ]
      invariantStatus = violations.length === 0 ? 'ok' : 'violated'
    }

    return {
      config: this.config,
      logicalNodes: this.logical,
      materialisedRows: total,
      visibleRows: visible,
      count,
      countIsExact: exactValue(count) !== undefined,
      viewport: { start: this.start, end, overscan: this.config.overscan },
      rows,
      expandedCount: this.projection.expandedIds().size,
      expandedIds: this.projection.expandedIds(),
      loadedParents,
      prefixes,
      inFlight: this.source.inFlight,
      pendingDemand: this.loader.demand().length,
      epoch: this.source.currentEpoch,
      lastSweepStuck: this.lastSweepStuck,
      // Read from the evictor itself. `candidates` and `protectedNow` were made
      // public in commit 8 so the policy could be asserted directly rather than
      // inferred from which rows happened to vanish, which is exactly what a
      // reader asking "why can it not evict anything" needs.
      evictionCandidates: this.evictor?.candidates(viewport).length ?? 0,
      protectedParents: this.evictor?.protectedNow(viewport).length ?? 0,
      counters: {
        ...this.counters,
        duplicateRequests: ledger.duplicates,
        overlappingRequests: ledger.overlaps,
        refetchesAfterEviction: ledger.refetchesAfterEviction,
      },
      minimumPages,
      minimumPagesAchievable: this.reach.minimumPagesAchievable(this.projection.expandedIds()),
      amplification: minimumPages === 0 ? 0 : this.source.ledger.length / minimumPages,
      invariantStatus,
      violations,
      corpusMode: this.corpusMode,
    }
  }

  recentEvents(limit: number): readonly LabEvent[] {
    return this.events.slice(-limit).reverse()
  }

  dispose(): void {
    this.loader.abort()
    this.events = []
  }
}
