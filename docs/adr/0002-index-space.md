# ADR-0002: The index space is a tree of cached spans

Status: **Proposed. Baseline measured; awaiting the span implementation.**

## Gate result, 5 September 2026

The materialized baseline was measured against the pre-registered thresholds at
one million nodes on all five shapes. It **breaches on every shape**, so REVERSE
is not available and the span index space gets built.

The margin is not marginal. Expand, collapse and subtree-size-change land between
**51x and 100x over** the 4ms frame threshold, at 206ms to 398ms p99. The cost
scales linearly with visible rows, roughly 2000x from 1k to 1M, which is what a
full rebuild per structural change predicts.

The baseline wins decisively where it was expected to: random index resolution at
0.27 microseconds against a 50 microsecond limit, and a 100-row window in 2 to 5
microseconds against a 1 millisecond limit. Retained heap is 0.19 to 0.26 times
the store, well inside the 1.5 ceiling. Those wins are the bar the span
implementation must not fall more than 2x below.

Verdict tool output is reproduced verbatim in `docs/benchmarks.md`. The candidate
outcome is CONFIRM, contingent on the span implementation delivering at least 3x
at p99 on each breached metric. If it does not, this ADR still reverses.

## Context

A virtualizer asks two questions: how many rows are there, and what is at index
`i`. The engine has to answer both over a tree that is partly expanded and partly
loaded, inside a scroll frame.

## Options

- **A.** Dense flat array, rebuilt on every structural change.
- **B.** Dense flat array with incremental splices.
- **C.** Per-node cached `span`; `resolve` descends comparing running offsets;
  mutations update one ancestor chain.
- **D.** C, plus materialising only the visible window into a scratch buffer.

## Decision

C is proposed. A is implemented regardless, in two other roles: as the reference
oracle for correctness (ADR-0008) and as the fully-loaded baseline in benchmarks.

## Why not the others

The argument against A and B is representational before it is about speed. An
expanded node whose children have not loaded occupies an unknown number of rows.
An array can hold that only by materialising placeholder rows and reconciling
them away when the real children arrive, and that reconciliation is the mechanism
that produces duplicated and skipped rows during scrolling. C holds the same fact
as one integer.

D is a micro-optimisation on C with no measurement behind it.

## Evidence

`npm run bench:verdict` compares the span implementation against the _materialized
baseline_, never against the oracle. Racing a tuned implementation against a
deliberately slow one proves nothing.

Thresholds live in `bench/thresholds.json` and are committed before the span
implementation exists, so the git history shows the bar was not moved to fit the
result.

## Reversal

**REVERSE** if the materialized baseline satisfies every threshold on every shape.
The span tree is then never written and this ADR is withdrawn with the numbers.

**CONFIRM** only if the span implementation improves each breached metric by at
least 3x at p99. A 20% win does not pay for a second data structure, its
invariants and its bugs.

**NARROW** if the baseline breaches only on the pathological shapes. Then the span
tree ships, the materialized projection stays as a documented selectable mode, and
the README states which shapes justify which.

If the span implementation loses `resolve-random` or `scroll-sequential` by more
than 2x, that is reported next to the wins. A design that is faster at
restructuring and slower at reading is a trade-off, not an improvement.
