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

M0's fifteen structural invariants continue to apply unchanged. M1 adds eleven,
and the property suite generates sequences mixing expand, collapse, viewport
movement, page arrival, out-of-order arrival, invalidation, count correction and
eviction.

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
| N11 | If demand keeps asking for a reachable page and the source keeps answering it, the request settles.      |

N8 and N10 are the two most valuable properties here, because both describe
failures that are invisible in ordinary use and appear only under latency.

N1 to N10 are safety properties: each says that nothing bad is in the state. None
of them can see a system that never progresses, which fault injection in commit 6
demonstrated concretely, so **N11 is the one liveness property**. It is checked as
a bounded-round settle against the deterministic in-memory source, with no timers
and no general liveness machinery.

Bookkeeping note, commit 8: acceptance criterion A7 in `bench/thresholds.m1.json`
was pre-registered against "I1-I15 and N1-N11" while this section defined only
N1 to N10. N11 was named by the criteria and never defined. Commit 8 supplies the
missing definition rather than narrowing A7 to N1-N10, which is the direction that
strengthens the gate rather than weakening it.

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

---

## Addendum, M1 commit 3: workload W7

Reachability validation before committing thresholds found that **A1, the bounded
materialized rows gate, was vacuous against W1 to W6**. Under D2 the materialized
row count is bounded by pages fetched, which is bounded by how far a reader
scrolls, so no workload in §6 accumulates enough coverage to approach the budget.
A1 would have passed without ever being tested.

|               | Workload                                                                                                                      |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| W7 accumulate | Expand parents without collapsing, scrolling each into coverage, until materialized rows approach `B`, then continue past it. |

W7 is the only workload that reaches the ceiling and therefore the only one that
exercises eviction firing at the boundary. Diagnostic D8 reports maximum
materialized rows as a fraction of `B`, so that a passing A1 can be told apart
from an untested one.

The budget itself, its derivation and the full acceptance criteria are in
[docs/m1-budget.md](m1-budget.md) and `bench/thresholds.m1.json`.

---

## Addendum, M1 commit 8: eviction semantics and two definitional findings

### What eviction does

`BudgetEvictor.sweep(viewport)` runs after every interaction, not only when over
budget, because the marks it records are what make the later choice meaningful.
Four steps: compute the protected set, mark it as recently used, take the least
recently used parent outside it, `invalidate` it. Repeat until rows are within
`B`. Demand refills whatever returns to view.

**Protection.** A row inside the window is destroyed by discarding any of its
ancestors, so every ancestor of every in-window row is protected, including the
roots. A row's own id is _not_ protected by its own position: discarding its
children removes only rows below it, all of which are outside the window by
construction. That is what lets a parent sitting on screen still shed the subtree
hanging off it.

**LRU.** One `++clock` per parent per sweep, assigned in row order, so two marks
are never equal and eviction order is deterministic rather than incidental. A
mark is dropped when the parent's loaded count reaches zero, so a parent that is
evicted and later reloaded cannot inherit an old position in the queue.

**The roots are evictable.** When the window contains no rows at all, nothing is
protected and `null` is a legitimate victim. This was found by N5 firing on three
shapes: the roots really were being discarded and the harness was recording only
node ids, so a correct eviction looked like an unexplained regression. The
invariant inputs now admit `null`.

### Finding 1: eviction granularity bounds the reachable budget

Eviction discards a whole parent's prefix. A budget below one page of a single
protected parent is therefore unreachable: pairing a page size of 100 with a
budget of 60 makes N2 fire everywhere, because one protected parent's page
already exceeds the budget with nothing left to discard.

This is the granularity of the mechanism, not a defect in it, but it is a real
constraint on configuration: a usable budget must exceed the page size times the
number of parents the protected window can span. Recorded here rather than worked
around, because a finer-grained evictor (discarding partial prefixes) would break
the prefix model that the whole coverage design rests on.

### Finding 2: N2 and the REVERSE condition contradict each other

N2 as pre-registered is unconditional: _materialized rows never exceed the budget
after any operation completes_. The pre-registered REVERSE condition names a state
in which they must: _some workload drives rows past `B` with eviction enabled and
every row inside the protected window_.

Both cannot hold. A state where the protected window alone exceeds `B` satisfies
the REVERSE condition and violates N2 simultaneously.

Neither `bench/thresholds.m1.json` nor the criteria above were modified. The
invariant checker relaxes the budget only while a sweep reports itself `stuck`,
which is exactly the state REVERSE describes, and `EvictionReport.stuck` makes it
visible rather than silently tolerated. The correct resolution is to restate N2 as
conditional on a non-stuck sweep, but amending pre-registered criteria mid-flight
is the failure mode this methodology exists to prevent, so it is reported and left
for the commit 10 verdict.

### W7 reachability, measured

`shallow-wide` at 20,000 nodes, 40 rounds, page size 100, `B` = 4,000:

| Peak rows before sweep | Peak rows after sweep | Evictions | Sweeps |
| ---------------------- | --------------------- | --------- | ------ |
| 12,718                 | 3,999                 | 3,007     | 40     |

W7 reaches 3.2x the budget, so A1 is exercised rather than vacuous, and eviction
restores the bound on every sweep.

---

## Addendum, M1 commit 9: measurement method and three definitional defects

Recorded here because they change how §6 to §9 must be read. The measured results
and the verdict are commit 10's subject, not this section's.

### How latency is modelled

A virtual clock, not `setTimeout`. Three latency profiles across the full matrix
would spend hours inside the timer measuring the timer, and would not reproduce.
What latency actually does to a loader is disperse arrivals, so arrival time is
`now + latency ± 40% of latency`, seeded, and the clock advances to the newest
delivery in each batch.

The jitter is not a refinement. Without it every request in a round arrives at
`now + latency` in issue order, all three profiles produce byte-identical state,
and the whole dimension reports one measurement three times. `deliveryOrderDiverged`
records whether reordering actually occurred, and a validity check asserts that it
happens above 0ms and does not happen at 0ms.

### Defect 1: §8's minimum is unreachable by any correct D2 engine

§8 counts a page as necessary when one of its child slots was inside the window at
some point. Two classes of request that no correct engine can avoid fall outside
that definition.

**Prefix closure.** Coverage is a loaded prefix, so page _k_ of a parent cannot be
fetched without pages 0 to _k-1_. Where a trace jumps into the middle of a parent,
§8 counts one page and the engine must fetch several.

**Expansion.** Expanding a node makes its children rows, which shifts every row
below them. The engine cannot know how far to shift without loading the first page,
so an expansion forces a fetch whether or not anyone looks at the result.

A3 and A4 are computed against §8 exactly as committed. Two diagnostics are
reported beside them: `minimumPagesPrefixClosed`, and `minimumPagesAchievable`,
which is the smallest count a correct D2 loader could reach given the same script.
Substituting either for the committed definition would be amending a
pre-registration after seeing that it is inconvenient.

### Defect 2: A5 cannot be scoped by coverage generation

A5 forbids duplicate requests. Eviction makes a page legitimately worth asking for
twice, so the count has to be scoped to "since the last eviction", and the coverage
generation looked like the natural key. It is not: `invalidate` bumps a parent's
generation, but evicting an _ancestor_ deletes the parent's record outright and its
replacement starts again at zero. That made 6,493 ordinary refetches on
`sparse-unbalanced` indistinguishable from duplicate requests.

Requests are therefore tagged with a monotonic eviction epoch. With eviction
disabled no epoch ever advances, so A5 is the strict form there: zero repeats of any
kind. Refetches across an eviction are reported separately and counted against
amplification, which is where §8 puts them.

### Defect 3: N3 was checking a property that is not N3

N3 says no row inside the protected window is ever evicted. Two implementations
were wrong before the third was right.

Collecting the **ids of visible rows** and forbidding their eviction flags a parent
sitting on screen whose children are all below the window, which the design
explicitly permits and depends on. Collecting the **ancestors** of visible rows is
what `BudgetEvictor` computes for itself, so the invariant could only ever disagree
with the evictor about bookkeeping rather than about outcomes.

N3 is now checked as **row survival**: snapshot the visible row keys before a sweep,
and every one of them must still be a row afterwards. It names neither indices nor
ancestry, so it stays meaningful while the index space shifts underneath a running
sweep, which is the case that separates the three formulations.

That case was not hypothetical. Under the corrected invariant, three workloads on
two shapes reproduced a real defect in `BudgetEvictor`: protection was recomputed
from scratch on each iteration of the sweep loop, so discarding one parent shifted
the rows the reader was looking at out of the index window, and their ancestor then
became an ordinary candidate. A sweep could destroy exactly what it had just
protected. Fixed by holding the union of everything protected during a sweep, which
can leave a sweep `stuck` where a more aggressive one would have succeeded. That is
the intended trade: an over-budget state is visible through `stuck`, a destroyed
viewport is not.

### What A7 does not cover

The committed rule names I1-I15 and N1-N11. The verdict tool checks N1-N11 across
generated sequences; I1-I15 are gated by the core conformance suite under
`npm run test:deep`, which the tool cannot read. A7 passing there is half of what
A7 says, and the tool prints that in its own output rather than leaving it implied.

Sequences run twice: once at `B`, and once at a budget they can actually reach. At
`B` these sequences peak near 600 rows and eviction never fires, so N2, N3 and N10
would pass without being asked anything. Violations from both passes count.
