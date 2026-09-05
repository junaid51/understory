# How correctness is established

Three layers, and the third is the one that decides whether the other two mean
anything.

## 1. Worked examples

`packages/core/test/oracle.examples.test.ts`. Small trees with the expected output
computed by hand. This is the only place in the project where a human decides what
the answer should be, and it is the only thing standing between the oracle and
being confidently, consistently wrong.

## 2. Structural invariants

`test/conformance/invariants.ts`. Fifteen properties derived from the definition of
the index space, checked without consulting the oracle. They exist because a purely
differential suite proves only that two implementations agree, which is worthless
if the reference is wrong.

|     | Invariant                                                             |
| --- | --------------------------------------------------------------------- |
| I1  | The reported count matches how many rows can be enumerated            |
| I2  | Each row's `index` field equals its position                          |
| I3  | No two rows share a row key                                           |
| I4  | No node appears twice                                                 |
| I5  | A row at depth 0 has no parent                                        |
| I6  | A row's parent is the node owning the depth immediately above it      |
| I7  | A collapsed node contributes exactly one row                          |
| I8  | `resolve(i)` and `slice(i, i+1)` agree                                |
| I9  | Out-of-range indices return undefined rather than a wrapped row       |
| I10 | `slice` clamps; negatives are not offsets from the end                |
| I11 | The count is `estimated` exactly when a placeholder row exists        |
| I12 | Placeholders under one parent are a contiguous run of slots from zero |
| I13 | Depth never increases by more than one between consecutive rows       |
| I14 | An independently computed length agrees with the reported count       |
| I15 | Observed sibling order matches the source's own array (ADR-0004)      |

I14 is computed iteratively with an explicit stack and shares no code with any
projection, so it can catch a defect that every implementation has in common.

I15 was added because of the fault injection below.

## 3. Fault injection: does the suite have teeth?

`test/fault-injection/`. A test suite that has never failed is not evidence of
anything. A second, deliberately defective copy of the naive projection carries
eleven switchable defects, each one a mistake a real implementation could
plausibly make. Every fault must be caught, and the invariant that caught it is
recorded, so a fault caught only by differential comparison shows up as a gap in
the structural half.

The harness is a copy rather than the oracle with fault flags, because
fault-handling code inside the oracle would compromise the one property the oracle
has to keep: being obviously correct when read. The duplication is guarded by a
control fault called `none`, which must agree with the oracle exactly.

Results at 150 random trees per fault, fast tier:

```
fault                          caught  by
------------------------------------------------------------------------------
off-by-one-slice               150/150  I1 I11 I15
collapsed-emits-children       114/150  I14 I7
depth-not-incremented           65/150  I5
duplicate-single-child          22/150  I12 I14 I15 I3
omit-placeholders               59/150  I14
reverse-siblings-at-depth-2     18/150  I15
double-expand                   65/150  I12 I14 I15 I3
stale-resolve                   65/150  I8
unstable-placeholder-slot       22/150  I12
index-field-off-by-one         150/150  I2
count-ignores-placeholders      59/150  I11
```

Every fault is caught by at least one structural invariant, none by differential
comparison alone. That matters: it means the structural half is strong enough to
validate the oracle itself, which is the only reason the oracle can be trusted as
a reference for the implementations that follow.

### What this exercise actually found

Two faults initially escaped all 150 trees: `reverse-siblings-at-depth-2` and
`unstable-placeholder-slot`. The suite was reporting success while being unable to
see either.

Neither was a hole in the invariants. Instrumenting the generators showed the
random command sequences almost never revealed a tree deeper than two levels: zero
runs out of 150 produced two sibling nodes at depth 2, and zero produced two
simultaneously visible unloaded parents, which are the shapes those two faults
need. Random single-node expand and collapse commands over a sixty-node tree
simply do not open a deep path by chance.

Two changes followed. `expandAll` and `collapseAll` commands were added to the
generator, after which maximum observed depth went from 2 to 8 and the two shapes
appeared in 18 and 22 runs out of 150. And invariant I15 was added, because
reordered siblings produce a perfectly well-formed tree that no other structural
invariant can see; without I15 that defect would have been detectable only by
comparison with the oracle, and therefore undetectable when checking the oracle.

The lesson is worth keeping: a property suite's weakest point is usually its
generators, not its properties, and nothing reveals that except deliberately
breaking the thing under test.

### Known limitation

Detection rates vary widely. The weakest faults are caught in about 15% of runs,
which is comfortable at the fast tier's 200 sequences and generous at the deep
tier's 10,000, but it means a fault needing an even rarer shape could still hide.
The nightly tier runs with a fresh seed for that reason, and any sequence it finds
is committed as a permanent fixture.

## Running

```
npm test            # fast tier: 200 sequences per property, fixed seed
npm run test:deep   # deep tier: 10,000 sequences, fresh seed
```
