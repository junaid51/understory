# The M1 materialization budget

Derived from `bench/results/calibration-local-2026-09-05.json`. Committed to
`bench/thresholds.m1.json`. **This is the last commit in which any M1 performance
threshold may be introduced or changed.**

## B = 4,000 materialized rows

## 1. What statistic is the budget protecting?

The frame. A structural change that a reader triggers must complete inside a
frame, or the reader sees a dropped one, so the statistic is the **worst-repeat
p99 of synchronous structural change**, held to 4ms of a 16.7ms frame with the
rest left to the renderer.

Not p50. A median that fits the budget while one frame in a hundred does not is a
list that stutters, and the stutter is the whole failure mode.

## 2. How is noise handled without quietly turning p99 into p50?

Calibration found p99 repeat-to-repeat spread of 0.859ms median and 5.286ms worst
near the crossing, against a 4ms budget. That is a real problem and there are two
honest ways to handle it and one dishonest one.

The dishonest one is to switch to p50 because it is stable, which changes what is
being protected while appearing to change only how it is measured.

Noise is handled instead by **aggregating conservatively at three levels, so that
every effect of noise moves the budget down**:

1. **Worst repeat, not median.** Each sweep point contributes the highest p99 of
   its three independent repeats. An unlucky run lowers the budget; a lucky one
   cannot raise it.
2. **Minimum across readings of an ambiguous rule.** See §4.
3. **A 0.5 safety factor**, pre-registered in `docs/m1-definition.md` §9 before the
   calibration ran, absorbing the residual: interpolation between sweep points,
   machine variation, and CI being slower than a laptop.

p50 is still reported, as diagnostic D1, precisely because it is the low-noise
statistic and therefore the better regression detector. It gates nothing.

## 3. How is the binding shape selected?

The minimum across shapes with at least three reachable sweep points under the
**partial** method, which is the state M1 actually produces. A shape with no
reachable points is **excluded by name, never recorded as zero**.

`mega-sibling` is excluded. Its root owns every other node, so expansion is
all-or-nothing and no intermediate row count exists; all eighteen partial sweep
points were unreachable. The first version of the calibration report treated that
absence as a ceiling of zero rows and named it the most constrained combination.
Left unfixed, it would have set B to nothing.

## 4. How is B calculated?

The pre-registered wording was "the largest step at which p99 stays under 4ms on
every shape, times a safety factor of 0.5". Applied to real data it turned out to
be ambiguous in one word, because measurement noise makes the sequence
non-monotonic: `sparse-unbalanced` breaches at 13,068 rows and then comes back
inside at 16,277.

Three readings, all defensible, none obviously intended:

|     | Reading                                                             |      C | Binding shape     |
| --- | ------------------------------------------------------------------- | -----: | ----------------- |
| A   | Largest row count whose worst-repeat p99 is within budget           | 10,000 | deep-narrow       |
| B   | Largest row count such that **every** point up to it stayed inside  |  8,803 | sparse-unbalanced |
| C   | Least-squares fit through the origin over all points, solved at 4ms | 10,917 | deep-narrow       |

They disagree by 1.24x, and the binding shape is not even stable between them.

**The rule is to take the minimum.** It is deterministic, writable in advance,
removes the author's discretion over which reading applies, and cannot be
self-serving because it is the smallest candidate.

```
C = min(10,000, 8,803, 10,917) = 8,803
B = floor(8,803 × 0.5 / 1,000) × 1,000 = 4,000
```

Reading C also confirms the linearity the design predicts: 203 ns/row on
`shallow-wide` up to 366 ns/row on `deep-narrow`, which is depth costing stack
work per row.

The historical ~25,000 estimate from M0 played no part. For the record it was
optimistic by a factor of six against this statistic, and about right against p50.

## 5. Why is that rule right for a viewport engine rather than a generic benchmark?

Because the budget is a **ceiling the engine should never approach**, not a
performance target to be met.

The expected operating point is a 40-row viewport with 40 rows of overscan: about
80 materialized rows, **fifty times below B**. A generic benchmark would set the
threshold near the measured limit to extract maximum throughput. Here, getting
within a factor of two of B means coverage has already failed, so the safety
factor costs nothing that the design should ever have been using.

B is therefore a **coverage-failure detector**. Its job is to fail loudly when the
engine materialises far more than it should, not to certify how fast the
projection is.

## 6. What if the data had not supported a single B?

Three validity conditions, all checked and all met:

| Condition                                                         | Observed     |      |
| ----------------------------------------------------------------- | ------------ | ---- |
| At least three shapes with three or more reachable partial points | four of five | pass |
| Binding crossing at least 5,000 rows                              | 8,803        | pass |
| Measurable shapes disagree by no more than 4x                     | 2.5x         | pass |

Had any failed, the single budget would have been abandoned in favour of a
per-shape budget with A1 evaluated per shape.

## Reachability validation, and the workload it forced

Every gate was checked against the workloads that must exercise it. Three findings.

**A2 is near-vacuous by design, and that is correct.** Workloads operate around 80
rows, fifty times below B, so structural change will pass with enormous margin.
Its value is as a **falsifier**: if A2 fails while A1 passes, bounded rows are not
sufficient and the central hypothesis is dead. It is a tripwire, not a
discriminator, and the thresholds file says so.

**A1 was vacuous, and a workload was added to fix it.** Under D2, materialized
rows are bounded by pages fetched, which is bounded by how far the reader scrolls.
None of W1 to W6 accumulates enough coverage to approach 4,000 rows, so A1 would
have passed without ever being tested. **W7 `accumulate`** is added: expand parents
without collapsing, scrolling each into coverage, until materialized rows approach
B, then continue. It is the only workload that reaches the ceiling, and therefore
the only one that tests eviction firing at the boundary. Diagnostic D8 reports max
rows as a fraction of B so that a passing A1 can be distinguished from an untested
one.

**A3's threshold was derived rather than guessed.** The M1 definition proposed a
1.2x ratio with no derivation. The demand rule fetches the next page when the
window comes within overscan of the end of a parent's loaded run, and cannot fire
again for that parent until the run is consumed, so **at most one speculative page
per parent lies outside Reach for an entire trace**. The gate is therefore additive
and exact:

```
pages requested ≤ theoretical minimum + parents ever visible
```

A ratio would have been a guess that happened to look rigorous.

## What could not be made rigorous

**A4, eviction-enabled amplification, is a policy number.** No calculation produces
3.0x. It states that a reader who leaves a region and returns should not pay more
than three fetches per reached page on average. It is labelled `POLICY` in the
thresholds file rather than dressed up as derived, and its per-workload breakdown
is reported as D3 so a passing aggregate cannot hide one bad workload.

**`mega-sibling` remains uncalibrated.** Under M1 its children arrive a page at a
time, so the shape may behave completely differently from M0. It cannot be
calibrated until commit 5 exists. B is derived without it, and if M1 measurement
shows it binding tighter than 4,000 rows, that is a finding and not a licence to
move B.
