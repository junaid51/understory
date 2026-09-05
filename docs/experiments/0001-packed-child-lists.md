# Experiment 0001: packed child lists

**Recorded 5 September 2026, before the change was written.** Predictions below
are commitments, not descriptions. Anything they get wrong is a finding.

## Observation

The span index space beats the materialized baseline by 3,686x to 27,946x on
structural change, and loses reads badly: `resolve-random` at `shallow-wide` is
480x slower (129.8us against 0.270us) and `scroll-random-jump` at `shallow-wide`
is 12,956x slower. It also retains 210-275MB against the baseline's 61MB.

## Diagnosis

Instrumented at 200,000 nodes, one descent costs 60 `spanOf` calls on
`shallow-wide` and 22 on `balanced`. That is the O(depth x fanout) the design
predicts and it is cheap: those are array reads and should total well under a
microsecond. At a million nodes the same descent measures 130us, roughly fifty
times what the work implies.

The suspected cause is not the algorithm but the memory layout. `childList` is
`(Int32Array | undefined)[]`: one small typed array per materialised node, held
in a JavaScript array a million entries long. A random descent therefore chases a
pointer into a cold million-entry array and then into a separate small heap object,
once per level. A million small objects also carry a million object headers, which
would explain the heap.

## Change

One flat `Int32Array` holding every child list contiguously, bump-allocated, with
`childStart` and `childLen` per node. No other change. Regions are not reclaimed
when `invalidate` re-materialises a node with a different fan-out; the old region
is left as fragmentation, which is acceptable for M0 and is recorded as a known
limitation rather than solved speculatively.

## Predictions

| Metric                                  | Now           | Predicted        | Rationale                                      |
| --------------------------------------- | ------------- | ---------------- | ---------------------------------------------- |
| `resolve-random` @ shallow-wide         | 129.8 us      | **under 10 us**  | removes one pointer chase per level            |
| `scroll-random-jump` @ shallow-wide     | 43.7 ms       | **under 4 ms**   | same cause, 100 resolves per sample            |
| `scroll-sequential` @ sparse-unbalanced | 0.268 ms      | 0.05 to 0.15 ms  | partly sequential already, so less to win      |
| Retained heap @ 1M                      | 210 to 275 MB | **90 to 130 MB** | removes ~1M object headers                     |
| `initial-projection` @ mega-sibling     | 639 ms        | **unchanged**    | dominated by interning 1M children, not layout |
| `subtree-size-change` @ mega-sibling    | 80.9 ms       | **unchanged**    | same, re-materialising 1M children             |

The last two predictions matter most. If packing improves them, the diagnosis was
wrong. They are O(fanout) work that no layout change can remove, so **the
mega-sibling breaches are expected to survive this experiment**, and if they do,
the span design has a genuine limit at extreme fan-out that has to be reported
rather than optimised away.

## Falsification

If `resolve-random` at shallow-wide does not fall below 50us, the pre-registered
threshold, the diagnosis is wrong and the read regression has a cause not yet
identified. In that case the instruction stands: accept REVERSE rather than run a
third experiment.
