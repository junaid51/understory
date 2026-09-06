import type { MapTreeStore, NodeId } from '@understory/core'
import type { SettleOrder, Step } from './harness.js'

/**
 * The six scripted interaction traces from docs/m1-definition.md §6.
 *
 * Scripted rather than random, for the reason M0 learned the hard way: random
 * single-node commands almost never produced a tree deeper than two levels, so two
 * seeded faults escaped 150 random trees while the suite looked green. If a
 * failure needs a particular sequence, the sequence is written down.
 *
 * Two properties every trace must have, both discovered by the coverage assertions
 * in `faults.test.ts` failing on the first version:
 *
 * **Requests are batched before settling.** The first version issued one request
 * and settled it immediately, so only one response was ever in flight and
 * `reverse` and `shuffled` were byte-identical to `inOrder`. N8 was passing
 * vacuously: there was no order to get wrong. Every trace now has several requests
 * outstanding at once.
 *
 * **Work happens below the root.** Every corpus has exactly one root, so a trace
 * written against `truth.roots` opened one node and reached 33 rows. Traces
 * descend through the root's children instead.
 *
 * Nothing here expands more than it must; the M0 mistake was measuring a fully
 * expanded million-row state the product exists to prevent.
 */

const PAGE = 100

export interface TraceContext {
  readonly truth: MapTreeStore
  readonly order: SettleOrder
}

const settle = (order: SettleOrder): Step => ({ op: 'settle', order })

const childrenOf = (truth: MapTreeStore, id: NodeId | null): readonly NodeId[] =>
  id === null ? truth.roots : (truth.get(id)?.childIds ?? [])

const branchyIn = (truth: MapTreeStore, among: readonly NodeId[]): NodeId[] =>
  among.filter((id) => (truth.get(id)?.childIds?.length ?? 0) > 0)

/**
 * Rows that expanding this node adds once its first page has landed.
 *
 * Under D2 a parent contributes its loaded prefix and nothing else, so one page is
 * the ceiling until the reader scrolls further into it. Traces use this to aim at
 * the index space that will actually exist, rather than at one they assume.
 */
const rowsFromExpanding = (truth: MapTreeStore, id: NodeId): number =>
  Math.min(PAGE, truth.get(id)?.childIds?.length ?? 0)

/**
 * The branchy children of a node that has just been loaded.
 *
 * Every trace that keeps going needs this. Without it a trace can only ever open
 * what the opening page revealed, which on these corpora is the root's handful of
 * children: `browse` asked for twenty screens and delivered four, and the rest of
 * its viewport moves landed past the end of the rows and demanded nothing.
 */
const branchyChildrenOf = (truth: MapTreeStore, id: NodeId): NodeId[] =>
  branchyIn(truth, childrenOf(truth, id).slice(0, PAGE))

/**
 * Opens the roots and the first level, which every trace needs before it starts.
 *
 * `level1` is capped at one page, because that is all the opening actually loads.
 * The first version returned every child in truth, and traces then tried to expand
 * nodes coverage had never seen: on shallow-wide, whose root owns more children
 * than a page holds, that threw "cannot expand unknown node". A trace may only act
 * on what it has loaded, which is the same discipline the engine will owe its
 * consumer.
 */
const opening = (
  truth: MapTreeStore,
  order: SettleOrder,
): { steps: Step[]; level1: NodeId[]; rows: number } => {
  const steps: Step[] = [{ op: 'request', parentId: null, offset: 0, limit: PAGE }, settle(order)]
  const level1: NodeId[] = []
  let rows = Math.min(PAGE, truth.roots.length)
  for (const root of truth.roots.slice(0, PAGE)) {
    steps.push({ op: 'expand', id: root })
    steps.push({ op: 'request', parentId: root, offset: 0, limit: PAGE })
    level1.push(...childrenOf(truth, root).slice(0, PAGE))
    rows += Math.min(PAGE, childrenOf(truth, root).length)
  }
  steps.push(settle(order))
  // Rows the opening itself creates. Without this the traces that aim at "the
  // current index space" started from one row on every corpus, and on
  // `mega-sibling`, whose root owns every other node and where there is nothing
  // below the first level to expand, every drag landed on row zero.
  return { steps, level1, rows }
}

/** W1 browse: scroll down, opening a node per screen, several pages in flight. */
export function browse({ truth, order }: TraceContext): Step[] {
  const { steps, level1 } = opening(truth, order)
  const frontier = branchyIn(truth, level1)
  for (let screen = 0; screen < 20; screen++) {
    const start = screen * 40
    steps.push({ op: 'viewport', start, end: start + 40 })
    // Three parents opened before anything settles, so arrival order matters.
    const batch = frontier.splice(0, 3)
    for (const id of batch) {
      steps.push({ op: 'expand', id })
      steps.push({ op: 'request', parentId: id, offset: 0, limit: PAGE })
    }
    // Twenty screens happen whether or not there is anything left to open. The
    // first version stopped scrolling the moment the frontier emptied, which on
    // `mega-sibling` meant W1 was the opening page and nothing else: the root owns
    // every node, so no child is branchy and the trace ended after three steps.
    steps.push(settle(order))
    // What the reader just opened is what the reader can open next. The first
    // version drew from a fixed twelve level-1 nodes and ran dry after four
    // screens, so sixteen of the twenty viewport moves landed past the end of the
    // rows and asked for nothing at all.
    for (const id of batch) frontier.push(...branchyChildrenOf(truth, id))
  }
  return steps
}

/** W2 drill: descend a chain, keeping the next two levels in flight together. */
export function drill({ truth, order }: TraceContext): Step[] {
  const { steps } = opening(truth, order)
  let parent: NodeId | null = truth.roots[0] ?? null
  for (let depth = 0; depth < 20; depth++) {
    const candidates = branchyIn(truth, childrenOf(truth, parent).slice(0, PAGE))
    const next = candidates[0]
    if (next === undefined) break
    steps.push({ op: 'expand', id: next })
    steps.push({ op: 'request', parentId: next, offset: 0, limit: PAGE })
    // Its sibling goes in the same batch, so two responses race.
    const sibling = candidates[1]
    if (sibling !== undefined) {
      steps.push({ op: 'expand', id: sibling })
      steps.push({ op: 'request', parentId: sibling, offset: 0, limit: PAGE })
    }
    steps.push(settle(order))
    steps.push({ op: 'viewport', start: depth * 2, end: depth * 2 + 40 })
    parent = next
  }
  return steps
}

/**
 * W3 wide: open the widest parent a reader can actually get to, and page through it.
 *
 * "Widest" has to mean widest *reachable*. Under D2 a node can only be opened once
 * its parent's page containing it has landed, so a node sitting past the first page
 * of one of its ancestors cannot be addressed without first paging into that
 * ancestor, which is a different workload. The first version took the globally
 * widest node and returned early when it was unreachable, which on four of the five
 * shapes reduced W3 to the opening: three requests, twenty rows, nothing measured.
 *
 * The search is breadth-first through reachable nodes and capped, because an
 * uncapped walk of a million-node corpus to choose one target costs more than the
 * workload it is choosing for.
 */
export function wideSibling({ truth, order }: TraceContext): Step[] {
  const EXPLORE_LIMIT = 20_000
  let widest: NodeId | null = null
  let widestCount = 0

  // A head cursor, not `shift()`. Shifting a 200,000-element array once per node is
  // the O(n^2) that made choosing a target cost two seconds on shallow-wide, more
  // than every workload on that shape put together.
  const queue: NodeId[] = [...truth.roots.slice(0, PAGE)]
  let head = 0
  let examined = 0
  while (head < queue.length && examined < EXPLORE_LIMIT) {
    const id = queue[head]
    head += 1
    if (id === undefined) break
    examined += 1
    const children = childrenOf(truth, id)
    if (children.length > widestCount) {
      widestCount = children.length
      widest = id
    }
    for (const child of children.slice(0, PAGE)) queue.push(child)
  }

  const { steps } = opening(truth, order)
  if (widest === null || widestCount === 0) return steps

  const chain: NodeId[] = []
  let cursor: NodeId | null = widest
  while (cursor !== null) {
    chain.push(cursor)
    cursor = truth.get(cursor)?.parentId ?? null
  }
  // One settle per level, deliberately. Under D2 a node cannot be addressed until
  // its parent's page has landed, so batching a whole ancestor chain would try to
  // expand a grandchild before its parent existed. The concurrency this trace
  // needs comes from the page batch below, not from the descent.
  for (const id of chain.reverse()) {
    steps.push({ op: 'expand', id })
    steps.push({ op: 'request', parentId: id, offset: 0, limit: PAGE })
    steps.push(settle(order))
  }

  // Four pages of the same parent in flight together. Under D2 only the
  // contiguous one can apply, so the rest are refused as gaps and re-asked, which
  // is the situation N8 exists for.
  const pages = Math.min(50, Math.ceil(widestCount / PAGE))
  for (let page = 1; page < pages; page += 4) {
    steps.push({ op: 'viewport', start: page * 40, end: page * 40 + 40 })
    for (let k = 0; k < 4 && page + k < pages; k++) {
      steps.push({ op: 'request', parentId: widest, offset: (page + k) * PAGE, limit: PAGE })
    }
    steps.push(settle(order))
  }
  return steps
}

/** W4 jump: scrollbar drags, with several regions requested before settling. */
export function jump({ truth, order }: TraceContext): Step[] {
  const { steps, level1, rows } = opening(truth, order)
  const frontier = branchyIn(truth, level1)
  const opened: NodeId[] = []
  // Rows the trace can expect to exist, tracked as it is built. §6 says the drags
  // go to "random positions in the current index space"; the first version drew
  // from a fixed [0, 400) whatever the corpus, so on a fifty-row state twenty-nine
  // of the thirty drags landed past the end and the workload measured one drag.
  let indexSpace = rows

  const openSome = (count: number): void => {
    const batch = frontier.splice(0, count)
    for (const id of batch) {
      steps.push({ op: 'expand', id })
      steps.push({ op: 'request', parentId: id, offset: 0, limit: PAGE })
      indexSpace += rowsFromExpanding(truth, id)
      opened.push(id)
    }
    if (batch.length > 0) steps.push(settle(order))
    for (const id of batch) frontier.push(...branchyChildrenOf(truth, id))
  }

  openSome(6)

  let seed = 7
  for (let drag = 0; drag < 30; drag++) {
    seed = (Math.imul(seed, 1664525) + 1013904223) | 0
    const start = Math.abs(seed) % Math.max(1, indexSpace)
    steps.push({ op: 'viewport', start, end: start + 40 })
    if (drag % 3 === 0) {
      // Deeper pages of something already open, so a drag can land in a region
      // whose prefix is not loaded yet, which is the situation W4 exists for.
      const target = opened[drag % Math.max(1, opened.length)]
      if (target !== undefined) {
        steps.push({ op: 'request', parentId: target, offset: PAGE, limit: PAGE })
        steps.push({ op: 'request', parentId: target, offset: PAGE * 2, limit: PAGE })
        steps.push(settle(order))
      }
      openSome(2)
    }
  }
  return steps
}

/** W5 churn: open and close the same subtree repeatedly. */
export function churn({ truth, order }: TraceContext): Step[] {
  const { steps, level1 } = opening(truth, order)
  const targets = branchyIn(truth, level1).slice(0, 2)
  for (const id of targets) {
    steps.push({ op: 'expand', id })
    steps.push({ op: 'request', parentId: id, offset: 0, limit: PAGE })
  }
  steps.push(settle(order))
  for (let cycle = 0; cycle < 50; cycle++) {
    for (const id of targets) steps.push({ op: 'collapse', id })
    for (const id of targets) steps.push({ op: 'expand', id })
  }
  return steps
}

/**
 * W6 session: mixed operations with eviction pressure.
 *
 * Eviction here is a trace instruction, not a policy. Commit 8 decides which
 * parent and when; this only ensures discarding coverage and returning to it is
 * exercised before that policy exists.
 */
export function longSession({ truth, order }: TraceContext): Step[] {
  const { steps, level1, rows } = opening(truth, order)
  const frontier = branchyIn(truth, level1)

  const open: NodeId[] = []
  // §6 says two thousand mixed operations. The first version ran twelve rounds
  // over a fixed six targets and stopped at roughly four hundred, which is a
  // different workload wearing the same name.
  const TARGET_OPERATIONS = 2_000
  let indexSpace = rows

  for (let round = 0; steps.length < TARGET_OPERATIONS && round < 400; round++) {
    const id = frontier.shift()
    if (id === undefined) {
      // Nothing left to open. Keep scrolling what exists rather than emitting
      // no-ops: a session that has run out of tree is still a session.
      const start = (round * 37) % Math.max(1, indexSpace)
      steps.push({ op: 'viewport', start, end: start + 40 })
      continue
    }

    const start = (round * 23) % Math.max(1, indexSpace)
    steps.push({ op: 'viewport', start, end: start + 40 })
    steps.push({ op: 'expand', id })
    steps.push({ op: 'request', parentId: id, offset: 0, limit: PAGE })
    indexSpace += rowsFromExpanding(truth, id)
    open.push(id)

    // A second parent in the same batch, but never the same one twice: with a
    // single target the modulo picked `id` again and issued an identical request
    // concurrently, which N6 caught on the first realistic run. Deduplicating
    // callers is commit 7's job; a trace asking the same question twice is a
    // trace defect, and hiding it in the harness would blind N6 to the real one.
    const other = frontier[0]
    if (other !== undefined && other !== id) {
      steps.push({ op: 'expand', id: other })
      steps.push({ op: 'request', parentId: other, offset: 0, limit: PAGE })
    }
    steps.push(settle(order))
    frontier.push(...branchyChildrenOf(truth, id))

    if (round % 3 === 0) {
      // The viewport moves away first, so eviction cannot violate N3.
      steps.push({ op: 'viewport', start: 10_000, end: 10_040 })
      steps.push({ op: 'evict', parentId: id })
      steps.push({ op: 'request', parentId: id, offset: 0, limit: PAGE })
      steps.push(settle(order))
    }
    if (round % 5 === 0) {
      const stale = open[Math.floor(round / 5) % open.length]
      if (stale !== undefined && stale !== id) steps.push({ op: 'collapse', id: stale })
    }
  }
  return steps
}

/**
 * W7 accumulate: keep opening and keep scrolling, never collapse.
 *
 * Added by the commit-3 addendum for one reason: reachability validation showed
 * that A1, the bounded-row gate, was **vacuous against W1 to W6**. Under D2 the
 * materialized row count is bounded by pages fetched, which is bounded by how far
 * a reader scrolls, so none of the six interaction traces accumulates enough
 * coverage to approach `B`. A1 would have passed without ever being asked a
 * question.
 *
 * Two mechanisms, because no single one works on all five shapes. Expanding the
 * branchy frontier accumulates on trees that branch; dragging to the end
 * accumulates on `mega-sibling`, whose root owns every other node so there is
 * nothing to expand but a great deal to page through. `deep-narrow` needs both:
 * its rows exist only as the chain deepens, and a fixed scroll schedule outruns
 * them immediately.
 *
 * Nodes are pushed onto the frontier from `truth`, which may name a node demand
 * has not loaded yet. That is deliberate and safe: `ViewportLoader.expand` records
 * the intent and applies it when the page lands, which is the commit-7 behaviour
 * this trace should be exercising anyway.
 */
export function accumulate({ truth, order }: TraceContext): Step[] {
  const { steps, level1 } = opening(truth, order)
  const frontier: NodeId[] = branchyIn(truth, level1)

  for (let round = 0; round < 80; round++) {
    const batch = frontier.splice(0, 4)
    for (const id of batch) steps.push({ op: 'expand', id })
    steps.push({ op: 'scrollToEnd' })
    steps.push(settle(order))
    for (const id of batch) {
      frontier.push(...branchyIn(truth, childrenOf(truth, id).slice(0, PAGE)))
    }
  }
  return steps
}

/** The six §6 interaction traces. W7 is separate; see `WORKLOADS`. */
export const TRACES = {
  browse,
  drill,
  wideSibling,
  jump,
  churn,
  longSession,
} as const

export type TraceName = keyof typeof TRACES
export const TRACE_NAMES = Object.keys(TRACES) as TraceName[]

/**
 * What the benchmark measures: the six traces plus W7.
 *
 * Kept separate from `TRACES` because W7 only makes sense demand-driven. It names
 * nodes from `truth` rather than issuing explicit `request` steps, so the scripted
 * path in the interaction suite, which expands directly against the projection,
 * would throw on the first unloaded node. The six traces run in both modes; W7 runs
 * in one, and pretending otherwise would mean weakening it.
 */
export const WORKLOADS = {
  ...TRACES,
  accumulate,
} as const

export type WorkloadName = keyof typeof WORKLOADS
export const WORKLOAD_NAMES = Object.keys(WORKLOADS) as WorkloadName[]

/**
 * Rewrites a trace so demand chooses the pages *and eviction chooses the victims*.
 *
 * This is what the benchmark runs. `demandDriven` still leaves W6's scripted
 * `evict` instructions in place, which is right for the correctness suite: they
 * exercise discarding coverage and returning to it whether or not a policy exists.
 * The benchmark must not use them, because `BudgetEvictor` is the thing under
 * measurement and a trace that evicts on its behalf would be measuring the trace.
 */
export function policyDriven(steps: readonly Step[]): Step[] {
  return demandDriven(steps).filter((step) => step.op !== 'evict')
}

/**
 * Rewrites a trace so demand chooses the pages.
 *
 * Explicit `request` steps are dropped and every `settle` becomes a `load`, so the
 * same six interaction shapes exercise commit 7 without a second suite. What
 * survives is the part that matters: which nodes a reader opens, where the viewport
 * goes, and when coverage is discarded.
 */
export function demandDriven(steps: readonly Step[]): Step[] {
  const out: Step[] = []
  for (const step of steps) {
    if (step.op === 'request') continue
    if (step.op === 'settle') {
      out.push({ op: 'settle', order: step.order })
      continue
    }
    out.push(step)
  }
  return out
}
