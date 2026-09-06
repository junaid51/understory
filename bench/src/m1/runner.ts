import { performance } from 'node:perf_hooks'
import {
  BudgetEvictor,
  CoverageStore,
  InMemorySource,
  MaterializedProjection,
  ViewportLoader,
  approximate,
  type MapTreeStore,
  type NodeId,
  type PublishOutcome,
} from '@understory/core'
import type { ShapeName } from '../corpus.js'
import { fingerprintDigest } from '../hash.js'
import { retainedHeap, summarise, type Stats } from '../harness.js'
import { analyseLedger, SimulatedNetwork, type ArrivalOrder } from './instrument.js'
import { checkM1Invariants, fingerprint, visibleRowKeys, type Violation } from './invariants.js'
import { ReachTracker } from './reach.js'
import { policyDriven, WORKLOADS, type WorkloadName } from './traces.js'

export interface M1Config {
  readonly workload: WorkloadName
  readonly shape: ShapeName
  readonly nodes: number
  readonly latencyMs: number
  readonly order: ArrivalOrder
  readonly reportTotal: boolean
  readonly eviction: boolean
  readonly budget: number
  readonly pageSize: number
  readonly overscan: number
  readonly viewportRows: number
  readonly seed: number
}

export interface OutcomeCounts {
  readonly applied: number
  readonly duplicate: number
  readonly stale: number
  readonly gap: number
  readonly conflict: number
}

export interface M1RunResult {
  readonly config: M1Config
  readonly steps: number
  readonly loadRounds: number

  readonly maxMaterializedRows: number
  readonly maxVisibleRows: number
  readonly finalRows: number
  /**
   * Peak rows once each step has fully completed, sweep included.
   *
   * Reported next to `maxMaterializedRows`, which is the peak at any instant, so
   * the difference between "rows never exceeded B" and "rows were pulled back below
   * B before the step ended" is visible. A1 is judged on the instantaneous peak,
   * which is the stricter of the two readings.
   */
  readonly maxRowsAfterStep: number
  readonly rowsOverBudget: number
  readonly sweeps: number
  readonly stuckSweeps: number
  readonly evictions: number

  /**
   * Synchronous structural change: expand, collapse, viewport move, and the
   * `count()` plus visible `slice()` a renderer performs after each of them.
   */
  readonly structural: Stats
  /** Synchronous eviction sweeps, measured apart from the rest. */
  readonly sweepTime: Stats
  /** Both together: everything synchronous a reader waits for. A2 is this one. */
  readonly synchronous: Stats

  readonly virtualElapsedMs: number
  readonly timeToFirstRowMs: number
  readonly timeToViewportFilledMs: number
  readonly deliveryOrderDiverged: boolean

  readonly requested: number
  readonly deduplicated: number
  readonly minimumPages: number
  readonly minimumPagesPrefixClosed: number
  /** Diagnostic: prefix closure *and* the first page every expanded parent needs. */
  readonly minimumPagesAchievable: number
  readonly parentsEverVisible: number
  readonly duplicates: number
  readonly overlaps: number
  readonly refetchesAfterEviction: number

  readonly outcomes: OutcomeCounts
  readonly countCorrections: number
  readonly countRegressions: number
  readonly countExactWhenIncomplete: number

  readonly violations: readonly Violation[]
  /** A digest, not the fingerprint itself. See `fingerprintDigest`. */
  readonly fingerprint: string
}

const EMPTY_OUTCOMES: OutcomeCounts = {
  applied: 0,
  duplicate: 0,
  stale: 0,
  gap: 0,
  conflict: 0,
}

/** Bounded so a defect cannot turn one step into an unbounded loop. */
const MAX_ROUNDS_PER_STEP = 24

/**
 * Runs one benchmark configuration end to end and reports what happened.
 *
 * Measures the M1 system as designed and nothing else: D2 loaded-prefix coverage,
 * viewport-driven demand, page loading through `HierarchySource`, and bounded
 * materialisation through `BudgetEvictor`. There is no `expandAll`, no span index
 * and no placeholder materialisation anywhere in this path.
 *
 * Everything the benchmark itself does, walking rows to compute Reach, checking
 * invariants, counting outcomes, happens outside the timed regions. The only
 * things inside them are engine calls a real consumer would make.
 */
export async function runM1(truth: MapTreeStore, config: M1Config): Promise<M1RunResult> {
  const coverage = new CoverageStore()
  const projection = new MaterializedProjection(coverage)
  const network = new SimulatedNetwork(truth, coverage, {
    latencyMs: config.latencyMs,
    reportTotal: config.reportTotal,
    seed: config.seed,
  })
  const loader = new ViewportLoader(network, coverage, projection, { pageSize: config.pageSize })
  const evictor = config.eviction
    ? new BudgetEvictor(coverage, projection, { budget: config.budget })
    : undefined
  const reach = new ReachTracker(config.pageSize)

  let start = 0
  let end = config.viewportRows
  const pushViewport = (): void => {
    loader.setViewport({ startIndex: start, endIndex: end, overscan: config.overscan })
  }
  pushViewport()

  const durations: number[] = []
  const sweepDurations: number[] = []
  const outcomes = { ...EMPTY_OUTCOMES }
  const evictedThisStep: (NodeId | null)[] = []
  let previousLoaded = new Map<NodeId | null, number>()

  let maxRows = 0
  let maxRowsAfterStep = 0
  let rowsOverBudget = 0
  let sweeps = 0
  let stuckSweeps = 0
  let evictions = 0
  let loadRounds = 0
  let deduplicated = 0
  let countCorrections = 0
  let countRegressions = 0
  let countExactWhenIncomplete = 0
  let previousCount = 0
  let previousCountForGrowth = 0
  let timeToFirstRowMs = Number.POSITIVE_INFINITY
  let timeToViewportFilledMs = Number.POSITIVE_INFINITY
  const violations: Violation[] = []

  /**
   * The synchronous cost a reader actually pays after something changes.
   *
   * `count()` is where the materialized projection rebuilds, and `slice` of the
   * visible window is what the renderer asks for next. Timing the pair is the
   * honest measurement of a frame; timing only `slice` would hide the rebuild, and
   * slicing the whole row set would measure the benchmark rather than the product.
   */
  const structuralChange = (): number => {
    const t0 = performance.now()
    const total = approximate(projection.count())
    projection.slice(Math.max(0, start - config.overscan), end + config.overscan)
    const elapsed = performance.now() - t0
    durations.push(elapsed)
    maxRows = Math.max(maxRows, total)
    return total
  }

  let visibleBeforeEviction: ReadonlySet<string> | undefined
  const sweep = (): void => {
    if (evictor === undefined) return
    // Captured before the sweep, because eviction destroys the rows that would
    // prove a breach of N3. Derived from the row layout, not from the evictor.
    visibleBeforeEviction = visibleRowKeys(projection.slice(0, approximate(projection.count())), {
      start,
      end,
      overscan: config.overscan,
    })
    const t0 = performance.now()
    const report = evictor.sweep({
      startIndex: start,
      endIndex: end,
      overscan: config.overscan,
    })
    sweepDurations.push(performance.now() - t0)
    sweeps += 1
    if (report.stuck) stuckSweeps += 1
    if (report.evicted.length > 0) network.evictionHappened()
    evictions += report.evicted.length
    for (const id of report.evicted) evictedThisStep.push(id)
    if (report.rowsAfter > config.budget) {
      rowsOverBudget = Math.max(rowsOverBudget, report.rowsAfter)
    }
  }

  const record = (outcome: PublishOutcome): void => {
    outcomes[outcome.kind] += 1
  }

  /** One load round: issue, deliver on the simulated clock, publish, re-render. */
  const drive = async (): Promise<void> => {
    for (let round = 0; round < MAX_ROUNDS_PER_STEP; round++) {
      if (loader.demand().length === 0) return
      const pending = loader.load()
      network.deliver(config.order)
      const report = await pending
      loadRounds += 1
      deduplicated += report.deduplicated
      for (const outcome of report.outcomes) record(outcome)
      structuralChange()
      if (timeToFirstRowMs === Number.POSITIVE_INFINITY && approximate(projection.count()) > 0) {
        timeToFirstRowMs = network.virtualNowMs
      }
      if (
        timeToViewportFilledMs === Number.POSITIVE_INFINITY &&
        approximate(projection.count()) >= end
      ) {
        timeToViewportFilledMs = network.virtualNowMs
      }
    }
  }

  const steps = policyDriven(WORKLOADS[config.workload]({ truth, order: 'inOrder' }))

  for (const step of steps) {
    switch (step.op) {
      case 'expand': {
        const t0 = performance.now()
        loader.expand(step.id)
        durations.push(performance.now() - t0)
        structuralChange()
        break
      }
      case 'collapse': {
        const t0 = performance.now()
        loader.collapse(step.id)
        durations.push(performance.now() - t0)
        structuralChange()
        break
      }
      case 'viewport':
        start = step.start
        end = step.end
        pushViewport()
        structuralChange()
        break
      case 'scrollToEnd': {
        const height = end - start
        const total = approximate(projection.count())
        end = Math.max(height, total)
        start = end - height
        pushViewport()
        structuralChange()
        break
      }
      case 'settle':
      case 'load':
        await drive()
        break
      case 'request':
      case 'evict':
        // Neither survives `demandDriven`, and W7 emits neither. Reaching this
        // means the workload bypassed demand, which is the one thing the M1
        // benchmark must not measure.
        throw new Error(`workload ${config.workload} emitted a ${step.op} step`)
    }

    sweep()

    const total = approximate(projection.count())
    maxRows = Math.max(maxRows, total)
    maxRowsAfterStep = Math.max(maxRowsAfterStep, total)
    if (!config.eviction && total > config.budget) {
      rowsOverBudget = Math.max(rowsOverBudget, total)
    }

    reach.observeProjection(projection, Math.max(0, start - config.overscan), end + config.overscan)

    // A8: the scrollbar may grow as the reader explores, and may shrink through
    // collapse or eviction. It may not shrink for any other reason.
    const shrank = total < previousCount
    const explained = step.op === 'collapse' || evictedThisStep.length > 0
    if (shrank && !explained) countRegressions += 1
    previousCount = total

    // D7 is "how often the D2 scrollbar grows", so it is counted as exactly that:
    // a step after which the reader's total row count is larger than before. It is
    // the felt cost of the design, and it is deliberately not the same thing as a
    // total being learned from a source, which may not move the count at all.
    if (total > previousCountForGrowth) countCorrections += 1
    previousCountForGrowth = total

    {
      const found = checkM1Invariants({
        coverage,
        projection,
        truth,
        viewport: { start, end, overscan: config.overscan },
        // N2 is checked against the real budget only when the sweep reported it
        // could reach it. See the note in `Harness.state()`: the pre-registered
        // definition asserts both that this state cannot happen and that it can,
        // and commit 9 records the behaviour rather than resolving it.
        budget: config.eviction && stuckSweeps === 0 ? config.budget : Number.POSITIVE_INFINITY,
        inFlight: loader.inFlight(),
        evictedThisStep,
        previousLoaded,
        ...(visibleBeforeEviction === undefined ? {} : { visibleBeforeEviction }),
      })
      for (const violation of found) {
        // A8's second half is N9's rule word for word: exact only when every
        // visible expanded parent is genuinely complete. Counting it here through
        // the invariant, rather than re-deriving it, is deliberate. The first
        // version re-implemented it against `coverage.isComplete` over the parents
        // of visible rows and reported 36,088 breaches where N9, which checks the
        // same property against `truth`, reported none. A second implementation of
        // a property is a second thing to get wrong, which is exactly what N3 had
        // just demonstrated.
        if (violation.startsWith('N9 honest-count: reported exact')) countExactWhenIncomplete += 1
        if (violations.length < 4) violations.push(`${step.op}: ${violation}`)
      }
    }

    previousLoaded = new Map([
      [null, coverage.loadedCount(null)],
      ...[...coverage.entries()].map(
        ([id]) => [id, coverage.loadedCount(id)] as [NodeId | null, number],
      ),
    ])
    evictedThisStep.length = 0
  }

  loader.abort()
  const ledger = analyseLedger(network.ledger)

  return {
    config,
    steps: steps.length,
    loadRounds,
    maxMaterializedRows: maxRows,
    maxRowsAfterStep,
    maxVisibleRows: reach.maxVisibleRowsObserved,
    finalRows: approximate(projection.count()),
    rowsOverBudget,
    sweeps,
    stuckSweeps,
    evictions,
    structural: summarise(durations),
    sweepTime: summarise(sweepDurations),
    synchronous: summarise([...durations, ...sweepDurations]),
    virtualElapsedMs: network.virtualNowMs,
    timeToFirstRowMs: Number.isFinite(timeToFirstRowMs) ? timeToFirstRowMs : -1,
    timeToViewportFilledMs: Number.isFinite(timeToViewportFilledMs) ? timeToViewportFilledMs : -1,
    deliveryOrderDiverged: network.deliveryOrderDiverged,
    requested: ledger.requested,
    deduplicated,
    minimumPages: reach.minimumPages,
    minimumPagesPrefixClosed: reach.minimumPagesPrefixClosed,
    minimumPagesAchievable: reach.minimumPagesAchievable(projection.expandedIds()),
    parentsEverVisible: reach.parentsEverVisible,
    duplicates: ledger.duplicates,
    overlaps: ledger.overlaps,
    refetchesAfterEviction: ledger.refetchesAfterEviction,
    outcomes,
    countCorrections,
    countRegressions,
    countExactWhenIncomplete,
    violations,
    fingerprint: fingerprintDigest(fingerprint(coverage, projection)),
  }
}

interface EngineState {
  readonly coverage: CoverageStore
  readonly projection: MaterializedProjection
}

/** Runs the trace and returns only the two objects whose footprint A6 is about. */
async function buildState(truth: MapTreeStore, config: M1Config): Promise<EngineState> {
  const coverage = new CoverageStore()
  const projection = new MaterializedProjection(coverage)
  const source = new InMemorySource(truth, { mode: 'immediate', reportTotal: config.reportTotal })
  const loader = new ViewportLoader(source, coverage, projection, { pageSize: config.pageSize })
  const evictor = config.eviction
    ? new BudgetEvictor(coverage, projection, { budget: config.budget })
    : undefined

  let start = 0
  let end = config.viewportRows
  const pushViewport = (): void => {
    loader.setViewport({ startIndex: start, endIndex: end, overscan: config.overscan })
  }
  pushViewport()

  for (const step of policyDriven(WORKLOADS[config.workload]({ truth, order: 'inOrder' }))) {
    switch (step.op) {
      case 'expand':
        loader.expand(step.id)
        break
      case 'collapse':
        loader.collapse(step.id)
        break
      case 'viewport':
        start = step.start
        end = step.end
        pushViewport()
        break
      case 'scrollToEnd': {
        const height = end - start
        end = Math.max(height, approximate(projection.count()))
        start = end - height
        pushViewport()
        break
      }
      case 'settle':
      case 'load':
        for (let round = 0; round < MAX_ROUNDS_PER_STEP; round++) {
          if (loader.demand().length === 0) break
          await loader.load()
        }
        break
      default:
        break
    }
    evictor?.sweep({ startIndex: start, endIndex: end, overscan: config.overscan })
  }
  loader.abort()
  return { coverage, projection }
}

export interface HeapResult {
  readonly engineBytes: number
  readonly recordBytes: number
  readonly ratio: number
  readonly loadedNodes: number
}

const hasChildrenIn = (state: EngineState, id: NodeId): boolean => {
  const record = state.coverage.get(id)
  return record === undefined ? false : approximate(record.childCount) > 0
}

/** One parent's loaded prefix, as a source would have delivered it. */
interface ParentSnapshot {
  readonly parentId: NodeId | null
  readonly nodes: { id: NodeId; hasChildren: boolean }[]
  readonly exhausted: boolean
  readonly total: number | undefined
}

/**
 * The final state as plain data, parents before children.
 *
 * Breadth-first from the roots through loaded children, which guarantees that
 * replaying it into a fresh store never offers a page for a parent the store has
 * not met yet.
 */
function snapshot(state: EngineState): { parents: ParentSnapshot[]; expanded: NodeId[] } {
  const parents: ParentSnapshot[] = []
  const queue: (NodeId | null)[] = [null]
  const seen = new Set<string>()

  while (queue.length > 0) {
    const parentId = queue.shift() ?? null
    const key = parentId === null ? 'r:' : `n:${parentId}`
    if (seen.has(key)) continue
    seen.add(key)

    const childIds =
      parentId === null ? state.coverage.roots : (state.coverage.get(parentId)?.childIds ?? [])
    if (childIds.length === 0 && parentId !== null) continue

    parents.push({
      parentId,
      nodes: childIds.map((id) => ({
        id,
        hasChildren: hasChildrenIn(state, id),
      })),
      exhausted: state.coverage.isExhausted(parentId),
      total: state.coverage.totalOf(parentId),
    })
    for (const id of childIds) queue.push(id)
  }
  return { parents, expanded: [...state.projection.expandedIds()] }
}

/**
 * Retained heap for A6.
 *
 * Two earlier methods both failed, and how they failed decided this one. Taking
 * heap readings before and after the trace measures *allocation*, and swept in the
 * loader's promise chains and everything the run had not yet collected: it reported
 * 153x for twelve loaded nodes. Releasing the engine and reading what the heap gave
 * back measures the right quantity but not reliably at this magnitude: fifty-nine of
 * seventy measurements came back with a non-positive denominator, which is noise
 * rather than data.
 *
 * So both sides are built fresh from the same snapshot, in isolation, each measured
 * as an allocation delta across a forced collection. That is the method M0 used for
 * its heap ratios, and it is the one that produced numbers worth quoting. The
 * engine side is a `CoverageStore` replaying the final coverage plus a
 * `MaterializedProjection` over it with the rows materialised; the record side is a
 * plain array of the same node data with no index over it. Neither side contains any
 * of the benchmark's own instrumentation, because this pass runs without it.
 */
export async function measureHeap(truth: MapTreeStore, config: M1Config): Promise<HeapResult> {
  const data = snapshot(await buildState(truth, config))
  const loadedNodes = data.parents.reduce((sum, p) => sum + p.nodes.length, 0)

  // The denominator is a `NodeRecord`, loaded child list included, because that is
  // what "the loaded node records" are. A first version stripped it to
  // `{ id, parentId, hasChildren }`, which is a summary of the data rather than the
  // data, and every ratio measured against it was inflated by whatever fraction of
  // a node record the child lists happen to be.
  const childrenByParent = new Map<string, NodeId[]>()
  for (const parent of data.parents) {
    const key = parent.parentId === null ? 'r:' : `n:${parent.parentId}`
    childrenByParent.set(
      key,
      parent.nodes.map((n) => n.id),
    )
  }

  const beforeRecords = retainedHeap()
  const records = data.parents.flatMap((p) =>
    p.nodes.map((node) => ({
      id: node.id,
      parentId: p.parentId,
      orderKey: String(node.id),
      childIds: childrenByParent.get(`n:${node.id}`)?.slice(),
      childCount: node.hasChildren ? { kind: 'atLeast', value: 1 } : { kind: 'exact', value: 0 },
    })),
  )
  const recordBytes = retainedHeap() - beforeRecords

  const beforeEngine = retainedHeap()
  const coverage = new CoverageStore()
  for (const parent of data.parents) {
    coverage.publish({
      parentId: parent.parentId,
      offset: 0,
      generation: 0,
      nodes: parent.nodes,
      exhausted: parent.exhausted,
      ...(parent.total === undefined ? {} : { total: parent.total }),
    })
  }
  const projection = new MaterializedProjection(coverage)
  for (const id of data.expanded) {
    if (coverage.get(id) !== undefined) projection.expand(id)
  }
  projection.slice(0, approximate(projection.count()))
  const engineBytes = retainedHeap() - beforeEngine

  // Both structures must survive their own measurement, or V8 is free to collect
  // them before the second reading and report a ratio built from nothing.
  if (records.length < 0 || coverage.size < 0) throw new Error('unreachable')

  return {
    engineBytes,
    recordBytes,
    ratio: recordBytes > 0 ? engineBytes / recordBytes : Number.NaN,
    loadedNodes,
  }
}
