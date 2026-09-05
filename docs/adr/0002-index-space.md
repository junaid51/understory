# ADR-0002: The index space is a tree of cached spans

Status: **Rejected by the pre-registered rules, 5 September 2026.**
See "Outcome" below, including a definitional defect in the rules themselves that
is recorded rather than used to overturn them.

## Outcome

`npm run bench:verdict` returned **REVERSE** on the corrected corpora, on two
clauses, both on `mega-sibling`, the shape where one node owns a million direct
children:

```
SHORT initial-projection    mega-sibling    0.91x  need 3x
SHORT subtree-size-change   mega-sibling    1.94x  need 3x
```

Everything else is a rout in the other direction. Against the same thresholds:

|                                                 | Materialized                                                                                        | Span                                                          |
| ----------------------------------------------- | --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| Thresholds failed at 1M                         | **16**                                                                                              | **2**                                                         |
| Which                                           | expand/collapse and subtree-size-change on all five shapes, plus initial-projection at mega-sibling | initial-projection and subtree-size-change, mega-sibling only |
| Structural change, four non-pathological shapes | 243-417 ms p99                                                                                      | 0.006-0.046 ms p99                                            |
| Best case improvement                           |                                                                                                     | 44,513x                                                       |
| Retained heap at 1M                             | 60.8 MB                                                                                             | 61.2 MB                                                       |

Span turns 16 failures into 2 and confines both to the pathological shape.

## Why REVERSE follows from the rules anyway

Criterion A, pre-registered, requires span to improve **each** breached metric by
3x at p99. Two of sixteen fall short. The rule admits no exemption for a shape,
and it should not: a rule that can be waived per shape after the data is in is not
a rule.

NARROW was defined as "breaches confined to pathological shapes". As written it
keys on where the **baseline** breached, and the baseline breached everywhere, so
NARROW is unreachable by construction. The case actually observed, where the
proposal's _remaining_ failures are confined to the pathological shape, is what
NARROW was meant to describe and is not what it says.

That is a defect in the pre-registration, found after seeing the data. It is
recorded here and deliberately **not** used to reinterpret the outcome, because
adjusting an acceptance criterion after seeing results is the exact failure this
apparatus exists to prevent. The verdict stands as the rules produce it.

## The limit that is real

`mega-sibling` failures are not measurement artefacts. Interning a million
children costs O(fanout) on first expansion, and re-materialising them after a
change costs O(fanout) again. No layout change removes that; experiment 0001
predicted both would survive packing, and both did. **The span index space has a
genuine limit where a single node owns hundreds of thousands of children**, and at
that extreme the materialized projection is no worse.

The remaining read regressions are inside every absolute threshold but past the 2x
reportable bar: `scroll-sequential` at sparse-unbalanced is 103x slower (0.254ms
against a 1ms limit), `resolve-random` at sparse-unbalanced 7.3x (1.97us against
50us). O(depth x fanout) descent against O(1) array indexing, as designed.

## What the corrected corpora changed

The commit 10 measurements were partly invalid. `shallow-wide` at 1M had 437,659
synthetic roots. On corrected corpora:

|                                     | Old corpus | Corrected                              |
| ----------------------------------- | ---------- | -------------------------------------- |
| `resolve-random` @ shallow-wide     | 129.8 us   | **0.43 us**                            |
| `scroll-random-jump` @ shallow-wide | 43.7 ms    | **0.024 ms**                           |
| `initial-projection` @ shallow-wide | 225.8 ms   | **1.57 ms**, 4.4x faster than baseline |

The 433x read regression that dominated the commit 10 report was almost entirely
a broken corpus.

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
