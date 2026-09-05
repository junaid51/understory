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
 * Opens the roots and the first level, which every trace needs before it starts.
 *
 * `level1` is capped at one page, because that is all the opening actually loads.
 * The first version returned every child in truth, and traces then tried to expand
 * nodes coverage had never seen: on shallow-wide, whose root owns more children
 * than a page holds, that threw "cannot expand unknown node". A trace may only act
 * on what it has loaded, which is the same discipline the engine will owe its
 * consumer.
 */
const opening = (truth: MapTreeStore, order: SettleOrder): { steps: Step[]; level1: NodeId[] } => {
  const steps: Step[] = [{ op: 'request', parentId: null, offset: 0, limit: PAGE }, settle(order)]
  const level1: NodeId[] = []
  for (const root of truth.roots.slice(0, PAGE)) {
    steps.push({ op: 'expand', id: root })
    steps.push({ op: 'request', parentId: root, offset: 0, limit: PAGE })
    level1.push(...childrenOf(truth, root).slice(0, PAGE))
  }
  steps.push(settle(order))
  return { steps, level1 }
}

/** W1 browse: scroll down, opening a node per screen, several pages in flight. */
export function browse({ truth, order }: TraceContext): Step[] {
  const { steps, level1 } = opening(truth, order)
  const targets = branchyIn(truth, level1).slice(0, 12)
  for (let screen = 0; screen < 20 && targets.length > 0; screen++) {
    const start = screen * 40
    steps.push({ op: 'viewport', start, end: start + 40 })
    // Three parents opened before anything settles, so arrival order matters.
    const batch = targets.splice(0, 3)
    for (const id of batch) {
      steps.push({ op: 'expand', id })
      steps.push({ op: 'request', parentId: id, offset: 0, limit: PAGE })
    }
    if (batch.length === 0) break
    steps.push(settle(order))
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

/** W3 wide: open the widest parent and request several of its pages at once. */
export function wideSibling({ truth, order }: TraceContext): Step[] {
  let widest: NodeId | null = null
  let widestCount = 0
  for (const [id, record] of truth.entries()) {
    const count = record.childIds?.length ?? 0
    if (count > widestCount) {
      widestCount = count
      widest = id
    }
  }
  const { steps } = opening(truth, order)
  if (widest === null) return steps

  const chain: NodeId[] = []
  let cursor: NodeId | null = widest
  let reachable = true
  while (cursor !== null) {
    const parentId: NodeId | null = truth.get(cursor)?.parentId ?? null
    const siblings = childrenOf(truth, parentId)
    if (siblings.indexOf(cursor) >= PAGE) reachable = false
    chain.push(cursor)
    cursor = parentId
  }
  // If the widest parent sits beyond the first page of one of its ancestors, it
  // cannot be opened without paging into that ancestor first, which is a different
  // trace. Fall back to the opening rather than expanding something unloaded.
  if (!reachable) return steps
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
  const { steps, level1 } = opening(truth, order)
  const targets = branchyIn(truth, level1).slice(0, 6)
  for (const id of targets) {
    steps.push({ op: 'expand', id })
    steps.push({ op: 'request', parentId: id, offset: 0, limit: PAGE })
  }
  steps.push(settle(order))

  let seed = 7
  for (let drag = 0; drag < 30; drag++) {
    seed = (Math.imul(seed, 1664525) + 1013904223) | 0
    const start = Math.abs(seed) % 400
    steps.push({ op: 'viewport', start, end: start + 40 })
    const target = targets[drag % Math.max(1, targets.length)]
    if (target !== undefined && drag % 3 === 0) {
      steps.push({ op: 'request', parentId: target, offset: PAGE, limit: PAGE })
      steps.push({ op: 'request', parentId: target, offset: PAGE * 2, limit: PAGE })
      steps.push(settle(order))
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
  const { steps, level1 } = opening(truth, order)
  const targets = branchyIn(truth, level1).slice(0, 6)
  if (targets.length === 0) return steps

  for (let round = 0; round < 12; round++) {
    for (const [index, id] of targets.entries()) {
      steps.push({ op: 'viewport', start: index * 20, end: index * 20 + 40 })
      steps.push({ op: 'expand', id })
      steps.push({ op: 'request', parentId: id, offset: 0, limit: PAGE })
      // A second parent in the same batch, but never the same one twice: with a
      // single target the modulo picked `id` again and issued an identical request
      // concurrently, which N6 caught on the first realistic run. Deduplicating
      // callers is commit 7's job; a trace asking the same question twice is a
      // trace defect, and hiding it in the harness would blind N6 to the real one.
      const other = targets[(index + 1) % targets.length]
      if (other !== undefined && other !== id) {
        steps.push({ op: 'expand', id: other })
        steps.push({ op: 'request', parentId: other, offset: 0, limit: PAGE })
      }
      steps.push(settle(order))

      if ((round + index) % 3 === 0) {
        // The viewport moves away first, so eviction cannot violate N3.
        steps.push({ op: 'viewport', start: 10_000, end: 10_040 })
        steps.push({ op: 'evict', parentId: id })
        steps.push({ op: 'request', parentId: id, offset: 0, limit: PAGE })
        steps.push(settle(order))
      }
    }
  }
  return steps
}

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
