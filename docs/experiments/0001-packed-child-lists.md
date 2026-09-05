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

---

## Result, measured 5 September 2026

| Metric                                  | Predicted       | Measured                          | Verdict on the prediction |
| --------------------------------------- | --------------- | --------------------------------- | ------------------------- |
| `resolve-random` @ shallow-wide         | under 10 us     | **117.0 us** (from 129.8)         | **WRONG**                 |
| `scroll-random-jump` @ shallow-wide     | under 4 ms      | **37.7 ms** (from 43.7)           | **WRONG**                 |
| `scroll-sequential` @ sparse-unbalanced | 0.05 to 0.15 ms | 0.286 ms (from 0.268)             | **WRONG**                 |
| Retained heap @ 1M                      | 90 to 130 MB    | **21 to 61 MB** (from 210 to 275) | **beaten**                |
| `initial-projection` @ mega-sibling     | unchanged       | 519.7 ms (from 639.3)             | correct                   |
| `subtree-size-change` @ mega-sibling    | unchanged       | 108.6 ms (from 80.9)              | correct                   |

Half the hypothesis was right and half was wrong, and the half that was wrong is
the half the experiment existed to test.

**Memory: confirmed and then some.** Removing a million small typed arrays cut
retained heap by 3.6x to 9.8x, to at or below the materialized baseline on every
shape. The object-header half of the diagnosis was correct.

**Read latency: refuted.** Packing bought 1.0x to 1.2x, nowhere near the 13x the
pre-registered falsification clause required. The pointer chase was real but was
never the dominant cost.

## What the remaining regression actually is

Instrumented at both sizes:

```
shallow-wide  n=  200,000   scan steps/resolve =     59   1.4 us   24 ns/step
shallow-wide  n=1,000,000   scan steps/resolve = 80,919 483.1 us    6 ns/step
sparse-unbal  n=1,000,000   scan steps/resolve =  1,451   7.8 us    5 ns/step
balanced      n=1,000,000   scan steps/resolve =     25   1.1 us   44 ns/step
```

Per step, packing worked exactly as intended: 24ns to 6ns. The cost is not the
step, it is that there are **eighty thousand of them**.

The cause is a corpus defect, not the span design. `buildStructure` caps
`shallow-wide` at depth 3, which cannot hold a million nodes at fan-out 40 to 120,
so the frontier empties with budget remaining and the leftovers are appended as
extra roots:

```
shallow-wide  n=  200,000   roots =       1
shallow-wide  n=1,000,000   roots = 437,659   43.8% of all nodes
balanced / sparse-unbalanced / deep-narrow @ 1M   roots = 1
```

The synthetic root therefore has 437,659 children, one of which is huge and the
rest single rows, so `nonUnit` is 1 and every resolve linearly scans a sibling
list nearly half a million long. This is the same class of defect as the
`deep-narrow` amputation found at commit 8: the corpus is not the shape it claims
to be at that size.

It is **not fixed here**, deliberately. Fixing it means regenerating and re-running,
which is a measurement-validity decision rather than an optimisation, and the
standing instruction is to stop and let that call be made rather than iterate.

## Standing falsification clause

The clause said: if `resolve-random` at shallow-wide does not fall below 50us, the
diagnosis is wrong and REVERSE should be accepted rather than a third experiment
run. It did not fall. The clause fires.

What the clause did not anticipate is a third possibility: that the measurement
itself is invalid. Both readings are recorded and neither is being used to
overrule the other.
