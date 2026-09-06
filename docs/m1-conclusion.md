# M1 conclusion

**Verdict: REVERSE.** Computed by `bench/src/m1/verdict.ts` from thresholds
committed at `2a68f95`, before any M1 engine code existed. Results in
`bench/results/m1-local-2026-09-05.json`.

## The hypothesis

> With bounded, viewport-driven materialisation, the simple materialized
> projection stays inside the frame budget, so no cleverer projection or index is
> necessary.

M0 rejected the span index space. M1 asked whether the problem the span index was
invented to solve exists at all once the engine stops materialising rows nobody can
see. If a viewport is forty rows and a generous overscan takes the working set to
eighty, and the materialized projection holds the frame budget to thousands of
rows, then projection speed stops being an engineering problem and the whole
question becomes one of keeping the materialized set small.

Three mechanisms were built to enforce that bound, each in its own commit:

- **Coverage** (commit 5), a loaded prefix per parent. Under design D2 a row exists
  if and only if its node is loaded, so coverage collapses from an interval set to
  a single length per parent and nothing can create a hole.
- **Demand** (commit 7), which turns a pushed viewport into page requests. Two
  triggers, no prediction: expanding a node with no loaded children asks for its
  first page, and a window reaching within overscan of the end of a parent's loaded
  run asks for the next one.
- **Eviction** (commit 8), which discards least-recently-visible coverage until
  materialized rows are back inside the budget `B`, never touching a parent that
  holds a row inside the protected window.

The hypothesis is that these three together keep rows under `B` under realistic
interaction. That is the claim the measurement falsified.

## What was measured

Every workload is a scripted interaction trace driven through the real engine:
viewport-driven demand choosing the pages, `HierarchySource` serving them,
`BudgetEvictor` deciding what to discard. **No workload calls `expandAll`.** That
was M0's mistake, measuring a fully expanded million-row state that the product
exists to prevent, and it is the reason M1's workloads measure the state the design
actually claims to support.

| Dimension     | Values                                                                     |
| ------------- | -------------------------------------------------------------------------- |
| Workloads     | W1 browse, W2 drill, W3 wide, W4 jump, W5 churn, W6 session, W7 accumulate |
| Shapes        | shallow-wide, deep-narrow, balanced, sparse-unbalanced, **mega-sibling**   |
| Page latency  | 0ms, 50ms, 250ms, simulated on a virtual clock with seeded jitter          |
| Arrival order | in order, and shuffled within a window of three                            |
| Source counts | supplies `total`, and does not                                             |
| Eviction      | disabled, and enabled at `B`                                               |
| Repeats       | three on one profile, for the worst-repeat statistic A2 requires           |

| Quantity                     |                 |
| ---------------------------- | --------------- |
| Corpus size                  | 1,000,000 nodes |
| Runs                         | 980             |
| Trace steps                  | 256,480         |
| Load rounds                  | 56,798          |
| Pages requested              | 927,095         |
| Parents evicted              | 566,749         |
| Eviction sweeps              | 128,240         |
| Sweeps that reported `stuck` | 4,298           |
| Generated sequences (A7)     | 20,000          |
| Sequence steps               | 400,000         |
| Heap measurements            | 70              |

**Zero invariant violations.** Not one of the 980 runs and not one of the 400,000
generated sequence steps broke N1 to N11. Of 927,095 published pages, every one was
`applied`: zero duplicates, zero stale, zero gaps, zero conflicts. Whatever M1
failed at, it did not fail at correctness.

`mega-sibling` is included throughout. It is the shape most likely to break
something, and excluding it because it is pathological would have hidden the result
this milestone turns on.

## The budget, and why it is 4,000 and not 25,000

M0 left an estimate of roughly 25,000 rows for the frame budget. Calibration
(commit 2) measured it properly and it did not survive.

The statistic being protected is the **worst-repeat p99 of synchronous structural
change**, held to 4ms of a 16.7ms frame. Not p50: a median that fits while one
frame in a hundred does not is a list that stutters, and the stutter is the failure
mode. Calibration found repeat-to-repeat p99 spread of 0.859ms median and 5.286ms
worst near the crossing, against a 4ms budget, which is a real problem. It was
handled by aggregating conservatively at three levels so that every effect of noise
moves the budget **down**: worst repeat rather than median; the minimum across
readings of an ambiguous rule; and the 0.5 safety factor pre-registered before the
calibration ran.

The pre-registered wording, "the largest step at which p99 stays under 4ms on every
shape", turned out to be ambiguous in one word, because noise makes the sequence
non-monotonic: `sparse-unbalanced` breaches at 13,068 rows and comes back inside at
16,277. Three defensible readings gave 10,000, 8,803 and 10,917, disagreeing by
1.24x, with the binding shape not even stable between them. The rule taken was the
minimum, because it is deterministic, writable in advance, removes the author's
discretion, and cannot be self-serving.

```
C = min(10,000, 8,803, 10,917) = 8,803
B = floor(8,803 × 0.5 / 1,000) × 1,000 = 4,000
```

M0's 25,000 was optimistic by a factor of six against this statistic, and about
right against p50. That is the difference between measuring the frame a reader sees
and measuring the average.

**`B` is a coverage-failure detector, not an operating point.** The expected working
set is about eighty rows, fifty times below `B`. Getting within a factor of two of
`B` already means coverage has failed. The budget's job is to fail loudly when the
engine materialises far more than it should, not to certify how fast the projection
is. This matters for reading every result below: `B` was never a target the engine
was supposed to approach.

## Gate results

| Gate | Rule                                         | Result   | Evidence                                                                                               |
| ---- | -------------------------------------------- | -------- | ------------------------------------------------------------------------------------------------------ |
| A1   | max materialized rows ≤ 4,000                | **FAIL** | 34,233 peak with eviction on, 8,101 still over after the step completed. 140 of 980 runs exceeded `B`. |
| A2   | worst-repeat p99 synchronous ≤ 4.0ms         | **FAIL** | 438.767ms, of which projection 3.611ms and eviction sweep 705.710ms                                    |
| A3   | requested ≤ minimum + parents ever visible   | **FAIL** | 112 of 490 eviction-disabled runs over the bound                                                       |
| A4   | requested ≤ 3.0 × minimum (POLICY)           | **FAIL** | 437.67x worst                                                                                          |
| A5   | zero duplicate or overlapping ranges         | **PASS** | 0 duplicates, 0 overlaps across 980 runs                                                               |
| A6   | engine heap ≤ 1.5 × loaded node records      | **FAIL** | 3.31x worst, over 24 of 70 measurements that cleared the noise floor                                   |
| A7   | zero violations, 10,000 generated sequences  | **PASS** | 20,000 sequences, 0 violations                                                                         |
| A8   | count monotone, and exact only when complete | **PASS** | 0 regressions, 0 false-exact reports                                                                   |

Diagnostics: D1 structural p50 0.583ms and p95 8.756ms. D6 time to first row 0ms,
55ms and 275ms under the three latency profiles, which is one round trip in each
case rather than a serialised chain. D7 35,322 count-correction events, the felt
cost of D2's growing scrollbar. D8 peak rows reached 1,198% of `B`, so A1 was
exercised rather than passing untested.

### A1 by shape, eviction enabled

| Shape             | Peak rows | After the step | Sweeps stuck       | Parents evicted |
| ----------------- | --------- | -------------- | ------------------ | --------------- |
| deep-narrow       | 339       | 339            | 0 of 27,888        | 0               |
| balanced          | 2,574     | 2,574          | 0 of 30,786        | 0               |
| sparse-unbalanced | 10,365    | 5,742          | 126 of 29,428      | 66,907          |
| shallow-wide      | 34,233    | 6,458          | 3,010 of 30,618    | 499,842         |
| **mega-sibling**  | **8,101** | **8,101**      | **1,162 of 9,520** | **0**           |

Two shapes never approach `B` and eviction never has to run. Two exceed it and
eviction pulls them most of the way back. One exceeds it and **eviction cannot run
at all**.

## The verdict

**REVERSE**, on pre-registered condition 2:

> Bounded materialisation cannot be achieved at all, meaning some workload drives
> rows past `B` with eviction enabled and every row inside the protected window.

Not on condition 1, and this distinction is the whole result. Condition 1 is "p99
exceeds 4ms while rows are within `B`", which would have falsified the hypothesis by
showing that bounded rows are not sufficient. That is not what happened.

On `mega-sibling` the root owns every other node. There is exactly one parent that
holds any rows, and any row on screen makes that parent an ancestor, so the
protected window shields the only candidate eviction has. **1,162 of 9,520 sweeps
report themselves `stuck`, nothing is discarded, and rows settle at 8,101 against a
budget of 4,000.** No eviction policy that respects N3 can do better on this
topology, because there is nothing it is permitted to take.

The commit 8 granularity finding predicted the shape of this: eviction discards a
whole parent's prefix and cannot trim one, so a budget below what a single protected
parent holds is unreachable. `mega-sibling` is that constraint at its limit, with
one parent holding everything.

### What the verdict does not say

It does not say the materialized projection is too slow. Across the **840 runs whose
peak stayed within `B`, the worst projection p99 was 0.332ms**, twelve times inside
the frame budget. The projection first breaches 4ms at 28,233 rows with eviction
disabled, seven times over budget, which is exactly where calibration predicted it
would. Every A2 breach in the table above is dominated by the eviction sweep, not by
`count()` and `slice()`: at the worst cell, projection 3.611ms against sweep
705.710ms.

The result is narrower and more specific than "the simple projection is not enough":

> **D2's bounded-prefix coverage combined with an independent eviction policy cannot
> guarantee the required bound for the tested topologies while preserving viewport
> safety.**

The hypothesis was that bounded materialisation would hold. The mechanism that was
supposed to bound it is what failed.

## The strongest finding: demand and eviction share no notion of retention

Worst amplification with eviction enabled is **437.67x** against the §8 minimum:
13,130 pages requested where an omniscient loader needed 30, of which **12,698 were
refetches of pages that had just been evicted**. `longSession` on the same shape
reached 192x, 37,821 requested against a minimum of 197. Across the whole matrix,
**854,575 of 927,095 pages requested were refetches after eviction**, and A5 confirms
none of them was a single-flight defect: zero duplicates, zero overlaps, every page a
legitimate request for something the engine had thrown away.

The loop is short and entirely deterministic:

1. A node is expanded while off screen. Demand must fetch its first page: under D2
   the children become rows and every row below them shifts, so the engine cannot
   know the index space without loading it.
2. The sweep runs. That parent holds no row inside the protected window, so it is a
   valid candidate and its coverage is discarded.
3. Demand recomputes. The node is still expanded, still has no loaded children, so
   the page is demanded again.
4. Repeat, once per interaction, for the rest of the session.

Neither layer is wrong by its own definition. Demand fetches what the state requires.
Eviction discards what nothing is looking at. The defect is that **"nothing is
looking at it" and "nothing needs it" are different predicates, and the design has
only the first one.** Expansion is a retention signal that coverage does not record
and eviction cannot read.

This is a design failure, not a tuning failure. No LRU ordering, no budget value and
no sweep frequency fixes it, because the two policies are optimising against each
other with no shared state to disagree about. Any repair has to give the engine a
notion of what is worth keeping that survives leaving the viewport, and that is an
architectural change, not a parameter.

It also explains A2 and A6. The eviction sweep cost that breaches the frame budget is
the cost of discarding hundreds of parents that are about to be refetched, and the
heap ratio of 3.31x is measured on states inflated by the same churn.

## Contradictions and methodology defects

Four were recorded during commits 8 and 9. **None was resolved in the direction of
acceptance**, and none was resolved at all; they are listed here as the standing
record.

**1. §8's theoretical minimum is unreachable by any correct D2 engine.** §8 counts a
page as necessary only if one of its child slots was inside the window at some point.
Two classes of unavoidable request fall outside that. A prefix store cannot fetch page
_k_ without pages 0 to _k-1_, so a trace that jumps into the middle of a parent forces
several pages where §8 counts one. And expanding a node forces its first page whether
or not anyone looks at the children, because the index space cannot be computed
without it. A3 and A4 are nonetheless computed against §8 exactly as committed, with
`minimumPagesPrefixClosed` and `minimumPagesAchievable` printed beside them as
diagnostics. Substituting either would have been amending a pre-registration after
discovering it was inconvenient. A3 fails against §8; it would still fail against the
achievable minimum on several cells, and that is visible in the output rather than
asserted here.

**2. N2 contradicts the REVERSE condition.** N2 is unconditional: materialized rows
never exceed the budget after any operation completes. The REVERSE condition names a
state in which they must. Both cannot hold, and the state that satisfies REVERSE
violates N2 by construction. The invariant checker relaxes the budget only while a
sweep reports itself `stuck`, which is exactly the state REVERSE describes, and
`EvictionReport.stuck` makes it visible rather than silently tolerated. Neither the
thresholds file nor §5 was edited. The correct repair is to restate N2 as conditional
on a non-stuck sweep, and that repair belongs to whoever writes the next
pre-registration, not to the milestone being judged by this one.

**3. A1's evaluation point is ambiguous.** The rule says "max materialized rows"; N2
says "after any operation completes". Rows can exceed `B` inside a step, because one
settle can load many pages before the sweep runs. The verdict judges A1 on the
instantaneous peak, the stricter of the two, and prints both. On the shapes where
eviction works this changes the number by a factor of five, and on `mega-sibling` it
changes nothing, because 8,101 rows are over budget under either reading.

**4. A7 cannot inspect I1 to I15.** The committed rule names "I1-I15 and N1-N11". The
verdict tool checks N1 to N11 across generated sequences; the M0 structural invariants
are gated by the core conformance suite under `npm run test:deep`, which the tool
cannot read. A7 passing there is half of what A7 says, and the tool prints that
limitation in its own output rather than leaving it implied.

Two further defects were found in the invariants and the code they judge, and both are
recorded in the commit 9 addendum to `docs/m1-definition.md`. N3 was checking a
property that is not N3, and restating it as row survival immediately caught a real
defect in `BudgetEvictor`: a sweep could destroy the rows a reader was looking at,
because protection was recomputed as the index space shifted underneath it. That is
fixed. It is worth separating from the verdict: it was a bug, it was found by
measurement, and fixing it did not change the outcome.

## What survived

The rejected hypothesis is not the milestone's output. These are:

- **The M0 oracle and the fifteen structural invariants.** Still the correctness
  foundation, still never optimised, still never benchmarked.
- **The materialized projection.** Measured at 0.332ms worst p99 inside the budget it
  was built for. It is not the thing that failed and it needs no replacement.
- **The `HierarchySource` contract.** One method. It served 927,095 pages across
  three latency profiles and two arrival orders without a single conflict, stale
  application or gap.
- **The coverage prefix model.** A genuinely good primitive: it makes a hole
  unrepresentable rather than merely unlikely, and 927,095 published pages produced
  zero conflicts. It did not establish the M1 architecture, but it is not what broke.
- **Demand as a separable concept**, and **eviction as a separable policy.** The fact
  that they can be measured independently, and that their interaction is what failed,
  is only visible because they were kept apart.
- **`CountEstimate` and D2's growing-count semantics.** A8 passes: the count never
  regressed outside collapse and eviction across 980 runs, and never claimed `exact`
  while a visible parent was incomplete. The scrollbar grows, which is a stated
  product limitation, and it grows honestly, which was the requirement.
- **The DOM-free core** with the viewport as a pushed input.
- **The methodology.** Pre-registration, a computed verdict, fault injection, and
  reachability validation. Every gate in this document was decided by a tool reading
  a file committed before the code existed.

The measurement apparatus is itself a durable asset. It found six defects in its own
workloads before it was allowed to report a number, and two in shipped code.

## What is rejected

- **D2 as the complete M1 architecture.** The prefix model survives as a primitive;
  the claim that it plus demand plus eviction is a sufficient architecture does not.
- **The assumption that simple bounded materialisation plus an independent eviction
  policy is sufficient.** Falsified directly, and the mechanism is understood.
- **No run-entry rescue.** Design D1 from §2 was the documented escape hatch and it is
  not being taken here. Nothing in this result says placeholder run entries fix the
  retention problem, and reaching for a second index structure now would repeat M0's
  mistake of building the clever thing before the simple thing's failure is
  understood.
- **No Fenwick tree, no alternative index, no return of the span index space.**
- **No post-hoc amendment to `B` or to any acceptance criterion.** `B` stays at 4,000.
  The thresholds file is unchanged since `2a68f95`, and the git history is the
  evidence.

## Where this leaves the project

M1 has produced a **falsified architecture hypothesis with a precisely located cause**.
That is the deliverable. Bounded materialisation was the plan; the mechanism intended
to enforce it cannot, on one topology because nothing is ever evictable, and on the
others because eviction and demand fight each other 854,575 times.

The next architectural decision follows from this evidence and has not been made. It
is not made here, and no implementation work is proposed as part of this commit. What
the evidence establishes is the shape of the question the next decision must answer:
what does the engine retain, why, and which layer owns that judgement. Answering it
belongs in its own pre-registered experiment, decided the same way this one was.

M2, React bindings, anchoring, live updates and the demo remain unstarted.

## How to explain this in an interview

I did not start by building a clever tree index. I wrote down the performance
hypothesis, built a correctness oracle and structural invariants so that I could
trust any result at all, calibrated the real operating budget instead of inheriting
an estimate, implemented the simplest viewport architecture that could work, and then
deliberately tried to break it.

The experiment falsified it. The materialized projection was fine at 0.332ms against
a 4ms budget. What failed was the mechanism meant to keep the row count small:
eviction discards what is off screen, demand immediately re-fetches it because the
node is still expanded, and across the matrix 854,575 of 927,095 page requests were
that loop. On one topology eviction could not run at all, which is the pre-registered
condition the verdict fired on.

The useful engineering result is not the failed optimisation. It is that I found out
exactly which assumption was wrong, with a number attached to it, without shipping
complexity based on intuition. The thresholds were committed before the code existed
and the verdict was computed by a tool, so when the answer came back negative there
was no room to argue with it. Four places where my own pre-registration turned out to
be ambiguous or contradictory are written down and unresolved, because amending them
after seeing the results is precisely the failure the method exists to prevent.
