# ADR-0002: The index space is a tree of cached spans

Status: **Proposed. This is the hypothesis M0 exists to test.**

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
