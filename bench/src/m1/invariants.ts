import {
  approximate,
  rowCountEstimate,
  type CoverageStore,
  type NodeId,
  type Projection,
  rowKey,
  type Row,
} from '@understory/core'
import type { MapTreeStore } from '@understory/core'

/**
 * The M1 safety invariants N1 to N10, from docs/m1-definition.md §5. N11 is the
 * one liveness property and is checked by a bounded-round settle instead; a
 * state-inspection function cannot see a system that never progresses.
 *
 * **Independence.** These do not compare the implementation against itself. The
 * right-hand side is `truth`, the corpus the source is serving from, which says
 * what the answer must be regardless of how coverage chooses to represent it. N4
 * and N9 in particular are decided entirely by `truth`, so a coverage store that
 * accepted a fabricated page would be caught even though it has no way of knowing
 * the page was fabricated. Fault F4 exercises exactly that.
 *
 * **Machinery that does not exist yet.** N2, N3, N6 and N10 describe viewport,
 * demand and eviction, which arrive in commits 7 and 8. They are checked here
 * against inputs the trace supplies: a declared viewport, a budget, the set of
 * in-flight request keys, and the parents evicted by the current step. That is
 * data, not a second implementation, and it is what lets the detector exist before
 * the thing it detects.
 */

export interface Viewport {
  readonly start: number
  readonly end: number
  readonly overscan: number
}

export interface M1State {
  readonly coverage: CoverageStore
  readonly projection: Projection
  readonly truth: MapTreeStore
  readonly viewport: Viewport
  readonly budget: number
  /** Request keys currently outstanding, for N6. */
  readonly inFlight: readonly string[]
  /**
   * Parents whose coverage this step deliberately discarded, for N3 and N5.
   *
   * Includes `null`, the roots, which are evictable when nothing at all is visible.
   * Recording only node ids made a legitimate root eviction look to N5 like an
   * unexplained regression.
   */
  readonly evictedThisStep: readonly (NodeId | null)[]
  /** Loaded counts per parent as of the previous check, for N5. */
  readonly previousLoaded: ReadonlyMap<NodeId | null, number>
  /**
   * Keys of the rows inside the window immediately *before* this step's eviction.
   *
   * Required because eviction destroys the evidence: once a parent's coverage is
   * gone its descendants are no longer rows, so nothing in the resulting state can
   * say whether any of them were on screen. Omit it and N3 has nothing to check.
   */
  readonly visibleBeforeEviction?: ReadonlySet<string>
}

export type Violation = string
/**
 * The keys of the rows currently inside the protected window.
 *
 * N3 says "no row inside `[start - overscan, end + overscan)` is ever evicted", and
 * this is that sentence made checkable: snapshot the visible rows before a sweep,
 * and afterwards every one of them must still be a row.
 *
 * Two earlier formulations were both wrong, and how they were wrong is worth
 * keeping. The first collected the *ids of visible rows* and forbade evicting them,
 * which flags a parent sitting on screen whose children are all below the window,
 * something the design explicitly permits and relies on. The second collected the
 * *ancestors* of visible rows, which is precisely what `BudgetEvictor` computes for
 * itself, so it could only ever disagree with the evictor about bookkeeping rather
 * than about outcomes. Row survival names neither indices nor ancestry, so it stays
 * meaningful while the index space shifts underneath a running sweep, which is the
 * case that separates the three.
 *
 * Deliberately independent of `BudgetEvictor.protectedNow`. An invariant that asks
 * an implementation what it protected cannot catch it protecting the wrong thing.
 */
export function visibleRowKeys(rows: readonly Row[], viewport: Viewport): ReadonlySet<string> {
  const from = viewport.start - viewport.overscan
  const to = viewport.end + viewport.overscan
  const keys = new Set<string>()
  for (const row of rows) {
    if (row.index >= from && row.index < to) keys.add(rowKey(row))
  }
  return keys
}

const childrenIn = (truth: MapTreeStore, parentId: NodeId | null): readonly NodeId[] =>
  parentId === null ? truth.roots : (truth.get(parentId)?.childIds ?? [])

/** Every parent coverage currently knows about, roots included. */
export function coveredParents(state: M1State): (NodeId | null)[] {
  const parents: (NodeId | null)[] = [null]
  for (const [id] of state.coverage.entries()) {
    if (state.coverage.loadedCount(id) > 0 || state.coverage.isExhausted(id)) parents.push(id)
  }
  return parents
}

/**
 * A canonical description of everything that should be reproducible.
 *
 * Used by N8 and N10, which are both statements that two histories reach the same
 * place. Covering rows and per-parent coverage rather than internal fields keeps
 * the comparison about observable state.
 */
export function fingerprint(coverage: CoverageStore, projection: Projection): string {
  const rows = projection
    .slice(0, approximate(projection.count()))
    .map((row) => (row.kind === 'node' ? `${row.depth}:${row.id}` : `${row.depth}:ph`))
    .join('|')
  const parents: string[] = []
  const record = (id: NodeId | null): void => {
    parents.push(
      `${id ?? '<roots>'}=${coverage.loadedCount(id)}/${coverage.isExhausted(id) ? 'x' : 'o'}/${coverage.totalOf(id) ?? '-'}`,
    )
  }
  record(null)
  for (const [id] of coverage.entries()) record(id)
  return `${rows}||${parents.sort().join(',')}`
}

export function checkM1Invariants(state: M1State): Violation[] {
  const violations: Violation[] = []
  const { coverage, projection, truth } = state
  const rows = projection.slice(0, approximate(projection.count()))

  // N1  every row is a loaded node; D2 has no placeholders at all
  for (const row of rows) {
    if (row.kind !== 'node') {
      violations.push(`N1 no-placeholders: found a ${row.kind} row at index ${row.index}`)
      break
    }
    if (coverage.get(row.id) === undefined) {
      violations.push(
        `N1 rows-are-loaded: row ${row.index} is ${row.id}, which coverage does not hold`,
      )
      break
    }
  }

  // N2  materialized rows stay within budget
  if (rows.length > state.budget) {
    violations.push(`N2 bounded-rows: ${rows.length} rows exceeds the budget of ${state.budget}`)
  }

  // N3  nothing inside the protected window is evicted
  if (state.evictedThisStep.length > 0) {
    if (state.visibleBeforeEviction !== undefined) {
      const surviving = new Set<string>()
      for (const row of rows) surviving.add(rowKey(row))
      for (const key of state.visibleBeforeEviction) {
        if (!surviving.has(key)) {
          violations.push(`N3 viewport-protected: row ${key} was inside the window and was evicted`)
          break
        }
      }
    }
  }

  // N4  a parent's loaded children are a prefix of the SOURCE's order, decided by
  //     truth rather than by anything coverage believes
  for (const parentId of coveredParents(state)) {
    const expected = childrenIn(truth, parentId)
    const loaded = parentId === null ? coverage.roots : (coverage.get(parentId)?.childIds ?? [])
    if (loaded.length > expected.length) {
      violations.push(
        `N4 prefix-of-source: ${parentId ?? '<roots>'} holds ${loaded.length} children, source has ${expected.length}`,
      )
      break
    }
    let mismatch = -1
    for (let i = 0; i < loaded.length; i++) {
      if (loaded[i] !== expected[i]) {
        mismatch = i
        break
      }
    }
    if (mismatch >= 0) {
      violations.push(
        `N4 prefix-of-source: ${parentId ?? '<roots>'} differs from source order at index ${mismatch}`,
      )
      break
    }
  }

  // N5  coverage shrinks only where this step evicted
  const evicted = new Set<NodeId | null>(state.evictedThisStep)
  for (const [parentId, before] of state.previousLoaded) {
    const now = coverage.loadedCount(parentId)
    if (now >= before) continue
    if (evicted.has(parentId)) continue
    // A descendant of an evicted parent legitimately disappears with it.
    if (parentId !== null && coverage.get(parentId) === undefined) continue
    violations.push(
      `N5 no-silent-regression: ${parentId ?? '<roots>'} fell from ${before} to ${now} without eviction`,
    )
    break
  }

  // N6  one in-flight request per (parent, offset, limit)
  const seen = new Set<string>()
  for (const key of state.inFlight) {
    if (seen.has(key)) {
      violations.push(`N6 single-flight: ${key} is in flight more than once`)
      break
    }
    seen.add(key)
  }

  // N9  the count is exact only when every visible expanded parent is genuinely
  //     complete according to truth
  const estimate = rowCountEstimate(coverage, projection)
  const expandedIds = projection.expandedIds()
  let everythingComplete = coverage.loadedCount(null) === truth.roots.length
  for (const row of rows) {
    if (row.kind !== 'node' || !expandedIds.has(row.id)) continue
    if (coverage.loadedCount(row.id) !== childrenIn(truth, row.id).length) {
      everythingComplete = false
      break
    }
  }
  if (estimate.kind === 'exact' && !everythingComplete) {
    violations.push('N9 honest-count: reported exact while a visible parent is still incomplete')
  }
  if (approximate(estimate) !== rows.length) {
    violations.push(
      `N9 honest-count: estimate ${approximate(estimate)} disagrees with ${rows.length} rows`,
    )
  }

  return violations
}
