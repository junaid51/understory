# M1: problem definition and pre-registered acceptance criteria

Status: proposed. No code written. Thresholds are not yet committed; see §9 for
why they cannot be until a calibration run exists.

## 1. Central hypothesis

> With bounded, viewport-driven materialisation, the simple materialized
> projection stays inside the frame budget, so no cleverer projection or index is
> necessary.

M0 rejected the span index space. M1 tests whether the thing it was invented to
fix is a problem at all once the engine stops materialising rows nobody can see.

The M0 measurement that motivates it: the materialized projection holds the 4ms
frame budget to roughly **25,000 visible rows** (0.797ms p99 at 10k rows, 16.158ms
at 100k, worst shape). A viewport is about 40 rows and a generous overscan takes
it to 80. That is two to three orders of magnitude of headroom, and if coverage
keeps the visible set inside it, projection speed stops being an engineering
problem.

**25,000 is not a constant, it is a hypothesis.** §9 says how it gets measured.

## 2. The design decision that shapes everything else

Two coherent architectures were considered.

**D1, run entries.** The row table holds entries that are either a node or a run
of K placeholder rows, with prefix sums and a binary search in `resolve`. Gives a
proportional scrollbar across regions that have never been loaded. Costs a second
index structure.

**D2, loaded rows only.** There are no placeholder rows. A row exists if and only
if its node is loaded. `count()` is `atLeast(loadedRows)` until a source supplies a
total or a parent is exhausted. Reaching the end of a parent's loaded children is
what triggers loading more.

**M1 takes D2.** It is the simplest thing that survived M0 and it does not answer
questions 4, 5 and most of 6 so much as delete them:

- There is no enormous placeholder range to avoid materialising, because there are
  no placeholder rows.
- Materialisation is bounded by construction: rows exist only for data actually
  fetched, and fetching is paged.
- Coverage collapses from an interval set to **a prefix length per parent**,
  because an unloaded region is not addressable, so nothing can jump into the
  middle of a sibling set and create a hole.

The cost is honest and must be stated as a product limitation, not hidden: **the
scrollbar grows as the reader explores.** There is no proportional scrollbar over
data that has never been fetched.

D1 remains the documented escape hatch. It becomes a pre-registered experiment
only if D2 fails a criterion in §9, and never merely because it would be nicer.

## 3. The ten questions

**1. What does `setViewport({ startIndex, endIndex, overscan })` mean?**
A half-open row range `[startIndex, endIndex)` in the _current_ index space, plus
`overscan` rows to keep resident on each side. It is a statement about now, not a
subscription. Indices are positions in the row array the engine last emitted.

If the index space changes, the consumer pushes a new viewport. **The engine does
not preserve scroll position across changes.** Anchoring is M2 and is explicitly
out of scope; pretending otherwise here would smuggle M2 into M1.

**2. How does the engine decide what must be loaded?**
Two triggers, no prediction, no prefetch heuristics.

- Expanding a node with no loaded children demands its first page.
- For each expanded parent whose loaded children intersect
  `[startIndex - overscan, endIndex + overscan)`, if that window reaches within
  `overscan` rows of the end of the parent's loaded run and the parent is not
  exhausted, demand the next page.

That is ordinary infinite scroll, applied per parent, driven by viewport
proximity. It is deliberately dumb.

**3. Loaded versus unloaded children.**
Per expanded parent: an ordered array of loaded child ids forming a prefix of the
source's order, plus `exhausted: boolean`, plus a `CountEstimate`. Unloaded
children have no representation at all. Absence is the representation.

**4. An expanded node whose child count is unknown.**
`atLeast(loadedSoFar)`, growing as pages arrive, becoming `exact` when the parent
is exhausted or the source supplies a total.

This replaces ADR-0003's estimator, which was recorded there as "a placeholder
until measured". It is strictly simpler and it never states a number that is
wrong. The cost is a growing scrollbar, which §8 measures.

**5. Avoiding enormous placeholder ranges.**
Not applicable under D2. Recorded as answered by design rather than solved.

**6. The coverage model.**
`loaded: NodeId[]` and `exhausted: boolean` per expanded parent. Coverage is the
prefix length. There is no interval set, no lease refcounting, and no global
coverage registry, because nothing in D2 can create a gap.

**7. When and why pages are evicted.**
When total materialized rows exceed the budget. The unit of eviction is one
parent's loaded children, truncated back to zero, preserving its expanded flag so
re-entry reloads it. Candidates are parents with no rows inside
`[startIndex - overscan, endIndex + overscan)`, least recently intersected first.

Eviction is the only mechanism that can make coverage regress.

**8. Invariants.** See §5.

**9. The `HierarchySource` contract.**

```ts
interface HierarchySource {
  loadChildren(request: {
    parentId: NodeId | null // null means the roots
    offset: number
    limit: number
    signal: AbortSignal
  }): Promise<{
    nodes: readonly NodeInput[]
    exhausted: boolean
    total?: number // when the source knows it cheaply
  }>
}
```

One method. No `subscribe`, no `countChildren`, no capability flags. Live updates
enter through the existing `invalidate(id)` primitive and nothing more.

**10. Engine guarantees versus renderer responsibilities.**

The engine guarantees a flat, stably-keyed row array; a `CountEstimate`; that
materialized rows stay within budget; determinism given the same input sequence;
no DOM or framework reference; and a change notification.

The renderer owns row measurement, scroll position, pushing the viewport, scroll
anchoring, rendering, accessibility and keyboard interaction. The engine will not
grow any of these.

## 4. Explicitly out of scope for M1

Live-update machinery beyond `invalidate(id)`. Optimistic mutation or reparenting.
React bindings. Any component. Predictive prefetching. Scheduling or
prioritisation. CRDTs. Any new projection or index structure. Adapter abstractions
for sources that do not yet exist. Scroll anchoring.

The materialized projection is the projection. The viewport is a pushed input. The
core stays DOM-free and deterministic.

## 5. Invariants that must hold after arbitrary sequences

M0's fifteen structural invariants continue to apply unchanged. M1 adds ten, and
the property suite generates sequences mixing expand, collapse, viewport movement,
page arrival, out-of-order arrival, invalidation, count correction and eviction.

|     | Invariant                                                                                                |
| --- | -------------------------------------------------------------------------------------------------------- |
| N1  | Every row corresponds to a loaded node. No row is a placeholder.                                         |
| N2  | Materialized rows never exceed the budget after any operation completes.                                 |
| N3  | No row inside `[start - overscan, end + overscan)` is ever evicted.                                      |
| N4  | Each parent's loaded children are a prefix of the source's order (ADR-0004).                             |
| N5  | Coverage regresses only through eviction, never through page arrival.                                    |
| N6  | At most one in-flight request exists per `(parentId, offset)`.                                           |
| N7  | A response from a superseded generation never mutates state.                                             |
| N8  | Out-of-order arrival produces the same final state as in-order arrival.                                  |
| N9  | `count()` is `exact` only when every visible parent is exhausted or source-counted; otherwise `atLeast`. |
| N10 | Evicting a parent and returning to it reproduces the identical row sequence.                             |

N8 and N10 are the two most valuable properties here, because both describe
failures that are invisible in ordinary use and appear only under latency.

## 6. Benchmark workloads

The M0 mistake was benchmarking `expandAll`, measuring a fully expanded
million-row state that the product exists to prevent. **No M1 workload expands
more than it must.** Every workload is a scripted interaction trace over a corpus
of one million nodes, of which only a bounded portion is ever covered.

Viewport 40 rows, overscan 20 each side, page size 100, unless stated.

|            | Workload                                                                                    |
| ---------- | ------------------------------------------------------------------------------------------- |
| W1 browse  | Expand the root, scroll down twenty screens at reading pace, expanding one node per screen. |
| W2 drill   | Navigate to depth 20 by expanding one child per level, viewport following.                  |
| W3 wide    | Expand a parent with 500,000 children and scroll fifty screens through it.                  |
| W4 jump    | Thirty scrollbar drags to random positions in the current index space.                      |
| W5 churn   | Expand and collapse the same subtree one hundred times.                                     |
| W6 session | Two thousand mixed operations under a deliberately tight eviction budget.                   |

Crossed with: all five corpus shapes; page latency of 0ms, 50ms and 250ms;
responses delivered in order and shuffled within a window of three; sources that
supply `total` and sources that do not.

## 7. Metrics

- Maximum materialized rows, and maximum visible rows, per workload.
- Interaction latency p50, p95, p99 and max, separated into work the engine does
  synchronously and work gated on the network. Only the former is held to the
  frame budget.
- Pages requested.
- Duplicate or overlapping requested ranges, which should be zero.
- Request amplification against the theoretical minimum, defined in §8.
- Retained heap, and its ratio to the loaded node data.
- Correctness violations across generated sequences, which must be zero.

## 8. Theoretical minimum, defined

For a workload trace and a page size P, let `Reach(p)` be the set of child slots
of parent `p` that were inside `[start - overscan, end + overscan)` at any point
during the trace. The theoretical minimum page count is

```
min = Σ over parents p of  |{ floor(s / P) : s ∈ Reach(p) }|
```

that is, the number of distinct pages an omniscient loader would fetch, counting
each page once no matter how often it is revisited.

**Amplification = pages actually requested / min.**

Eviction-induced refetches count against amplification deliberately. That is the
price of eviction and it should be visible rather than excused, which is why §9
holds eviction-off and eviction-on to different numbers.

## 9. Pre-registered acceptance criteria

**These cannot be committed yet, and that is the point.** The budget in N2 is
currently a guess extrapolated from two M0 data points. Committing thresholds that
depend on a guessed constant would repeat the M0 mistake in a new place.

**Calibration first, budget second, thresholds third.** A calibration run sweeps
materialized row counts from 1,000 to 100,000 in steps across all five shapes and
measures projection rebuild p99. The budget `B` is defined mechanically as the
largest step at which p99 stays under 4ms on every shape, times a safety factor of
0.5. That number, whatever it is, is committed to `bench/thresholds.m1.json`
before any M1 engine code exists. If it lands nowhere near 25,000, the hypothesis
in §1 changes shape and that is a finding.

With `B` established, the outcomes are:

**CONFIRM**, all of:

1. Across every workload, shape and latency: maximum materialized rows ≤ `B`.
2. Synchronous interaction latency p99 ≤ 4ms in every combination.
3. Request amplification ≤ 1.2x with eviction disabled.
4. Request amplification ≤ 3.0x with eviction at budget `B`.
5. Zero duplicate or overlapping requested ranges.
6. Retained heap ≤ 1.5x the loaded node data.
7. Zero invariant violations across 10,000 generated interaction sequences.

**REVERSE**, either of:

- Synchronous p99 exceeds 4ms while materialized rows are within `B`. This
  directly falsifies §1: bounded rows would not be sufficient.
- Bounded materialisation cannot be achieved at all, meaning some workload drives
  rows past `B` with eviction enabled and every row inside the protected window.

**NARROW**, reachable and keyed to the proposal's own failure modes rather than to
any baseline:

- Every criterion holds except on W3, the wide-sibling workload, or except above
  some measured fan-out threshold `F`. M1 then ships with `F` documented as a
  limit, and design D1 from §2 becomes a pre-registered follow-up experiment.
- Or every criterion holds except amplification under eviction, which lands
  between 3.0x and 6.0x. M1 then ships with eviction disabled by default and the
  measured cost of enabling it documented.

Each of the three outcomes is reachable from a state the proposal can actually be
in. That is the correction to M0, where NARROW was keyed to where the baseline
breached and was unreachable by construction.

## 10. Proposed commit sequence

Each commit leaves the repository working and independently verifiable. Nothing
after commit 3 may change a threshold.

| #   | Commit                                                            | Contains                                                                                                       |
| --- | ----------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| 1   | `docs: M1 problem definition`                                     | This document. Stop for review.                                                                                |
| 2   | `feat(bench): projection calibration sweep`                       | Rebuild p99 against materialized row count, 1k to 100k, five shapes. No engine change.                         |
| 3   | `docs(bench): calibrated budget and pre-registered M1 thresholds` | `B` derived mechanically from commit 2, `thresholds.m1.json` committed. **Last commit that may set a number.** |
| 4   | `feat(core): HierarchySource and an in-memory source`             | The §3.9 contract plus a source over the existing corpora. Latency and ordering injectable.                    |
| 5   | `feat(core): coverage as a loaded prefix`                         | Per-parent prefix, exhaustion, page application, out-of-order buffering. N4, N5, N8, N9.                       |
| 6   | `test(core): M1 invariants and interaction property suite`        | N1 to N10, generators over the full interaction alphabet, fault injection against the new invariants.          |
| 7   | `feat(core): viewport to demand`                                  | The §3.2 rules, single-flight, generations. N6, N7.                                                            |
| 8   | `feat(core): eviction under budget`                               | §3.7. N2, N3, N10.                                                                                             |
| 9   | `feat(bench): M1 workloads, amplification, verdict`               | §6, §7, §8, and a verdict tool judging §9.                                                                     |
| 10  | `docs: M1 measurement and verdict`                                | Committed results, generated report, ADR updates.                                                              |

Commits 4 through 8 each land behind the property suite from commit 6, which is
why the suite arrives before the two features whose failure modes it exists to
catch.
