# M0 conclusion

## The hypothesis

ADR-0002 proposed that a tree of per-node cached spans would beat a straightforward
materialized projection for the workloads this engine exists to serve. A collapsed
node occupies one row, an expanded node one plus its children's spans, and an
expanded-but-unloaded node one plus an estimated count held as a single integer.
Expanding would then update one ancestor chain instead of rebuilding a row table.

## The oracle, and why it exists

A recursive projection that rebuilds every row on every call and caches nothing,
including `count()`. It carries a header saying not to optimise it, and it never
appears in a benchmark.

It exists because a differential test suite proves only that two implementations
agree, which is worthless if the reference is wrong. So correctness rests on three
layers: fifteen structural invariants derived from the definition of the index
space and checked without consulting the oracle; worked examples with
hand-computed answers, the only place a human decides what is right; and
differential comparison in lockstep, disabled when the subject is the oracle
itself.

Sixteen seeded faults prove the suite has teeth. All are caught, and every one by
at least one structural invariant rather than by comparison alone, which is what
makes the structural half strong enough to validate the oracle.

## The materialized baseline

The honest competitor, not a strawman: four parallel `Int32Array`s, lazily
materialised row objects, reused storage, iterative traversal. It gives up exactly
one thing, incrementality. A structural change rebuilds the whole table.

## Pre-registered acceptance criteria

Committed to `bench/thresholds.json` at commit `2ce92d6`, two commits before the
span implementation could exist. At one million nodes: expand, collapse and
subtree-size-change under 4ms p99; resolve under 50us; a 100-row window under 1ms;
initial projection under 250ms; retained heap under 1.5x the store. To be
accepted, span had to improve every breached metric by at least 3x at p99. The
verdict was computed by a tool, never written by hand.

## Major results, corrected corpora, one million nodes

|                                                 | Materialized      | Span                      |
| ----------------------------------------------- | ----------------- | ------------------------- |
| Thresholds failed                               | **16**            | **2**                     |
| Where                                           | all five shapes   | `mega-sibling` only       |
| Structural change, four non-pathological shapes | 243 to 417 ms p99 | **0.006 to 0.046 ms p99** |
| Best improvement                                |                   | **44,513x**               |
| Random resolve                                  | 0.26 to 0.27 us   | 0.25 to 1.97 us           |
| Retained heap                                   | 60.8 MB           | 61.2 MB                   |

## Generator defects found and corrected

Two, both producing entirely plausible numbers for corpora nobody intended.

**The unloaded fraction amputated deep corpora.** An unloaded node hides its whole
subtree, so on depth-64 chains a 5% rate left under 4% intact. `deep-narrow` at a
million nodes was measured as a **32-row tree** and reported as passing every
threshold. Fixed by capping eligibility to subtrees of eight nodes or fewer.

**Frontier exhaustion invented roots.** `shallow-wide` caps at depth 3, which
cannot hold a million nodes at fan-out 40 to 120, so leftovers were appended as
synthetic roots: **437,659 of them, 43.8% of the corpus**. Fixed by widening
existing nodes instead. This single defect accounted for almost all of a 433x read
regression reported at commit 10: `resolve-random` at `shallow-wide` fell from
129.8us to 0.43us once corrected.

Also fixed: `siblings.indexOf(id)` made generation O(n^2), 6,729ms to 77ms at
100,000 nodes.

Topology assertions now make this class of failure loud: exactly one root, every
node reachable, depth within the shape's contract.

## What the span architecture was exceptionally good at

Structural change, by three to four orders of magnitude. Expanding or collapsing a
node cost 0.006 to 0.046ms against 243 to 417ms, because the work is one ancestor
chain rather than a full rebuild, and propagation stops at the first collapsed
ancestor. Subtree size changes behaved identically, which matters because that is
the live-update path. Unknown child counts cost one integer rather than a run of
materialised placeholder rows. After packing, memory was equal to the baseline.

## Remaining weaknesses

**Extreme fan-out.** Interning a million children is O(fanout) on first expansion
and again on re-materialisation. No layout change removes it; experiment 0001
predicted both would survive packing, and both did.

**Reads.** O(depth x fanout) descent against O(1) array indexing. Inside every
absolute threshold but past the 2x reportable bar on several shapes, worst
`scroll-sequential` at `sparse-unbalanced` at 103x, 0.254ms against a 1ms limit.

## The decision

**REVERSE.** ADR-0002 is Rejected. Criterion A requires 3x on every breached
metric; two of sixteen fell short, both at `mega-sibling`. The rule admits no
per-shape exemption and was not amended after the fact.

A definitional defect in the pre-registration is recorded in ADR-0002 and was
deliberately not used to overturn the outcome: NARROW was defined as "breaches
confined to pathological shapes" but keys on where the _baseline_ breached, making
it unreachable when the baseline breaches everywhere. The case observed, the
_proposal's_ remaining failures confined to the pathological shape, is what NARROW
was meant to describe and is not what it says.

## What we learned

**A benchmark can measure a state the design forbids.** Every structural-change
scenario ran `expandAll`, so all of them measured a fully expanded million-row
tree. A viewport shows about fifty rows, and this engine's entire purpose is to
never materialise what nobody can see. The span tree was solving a problem the
benchmark premise created. This is the finding that reshapes M1, and it was
sitting in plain sight in the scenario code for four commits.

**Generators are the weakest part of a suite, not the properties.** Two corpus
defects and one property-generator gap, all found only by deliberately breaking
something and asking why the break was not caught.

**Pre-registration works, and fails definitionally rather than numerically.** No
threshold was ever disputed. The rule that broke was the one nobody thought hard
enough about, and it broke by being unreachable.

**A reverted optimisation is worth more than a successful one.** The record cache
was applied on suspicion, measured, found to make two scenarios worse, and
removed. It taught more than a win would have.

## Carried into M1

Kept: the oracle, fifteen invariants, the conformance suite and sixteen fault
injections; corpus generators with topology assertions; the benchmark harness,
pre-registration and computed verdict; the materialized projection, now the
shipping projection; `CountEstimate`; ADR-0004's refusal to sort a partially
loaded sibling set; the DOM-free core with the viewport as a pushed input.

Deleted: the span index space and everything supporting it. No Fenwick trees, no
alternative indexes, no further attempt to rescue it.
