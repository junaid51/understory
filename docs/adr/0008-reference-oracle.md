# ADR-0008: Correctness is established by a reference oracle

Status: Accepted (M0)

## Context

The failure modes here are sequence-dependent: a particular interleaving of
scroll, expand, page arrival and insert produces a duplicated or missing row.
Hand-written examples do not find those.

## Options

- **A.** Unit tests plus end-to-end browser tests.
- **B.** Snapshot tests over recorded sessions.
- **C.** Model-based property testing. The dense flat array from ADR-0002 is the
  oracle, fast-check generates random operation sequences, and the implementation
  must agree with the oracle after every step. Every shrunk counterexample becomes
  a permanent regression fixture.

## Decision

C, in two halves that are kept separate on purpose.

**Structural invariants** are derived from the definition of the index space and
check a projection without consulting the oracle. There are fifteen. They exist
because a purely differential suite proves only that two implementations agree,
which is worthless if the oracle is wrong.

**Differential comparison** runs the implementation against a freshly built oracle
in lockstep. The oracle itself runs with this half switched off, since comparing
it to itself would pass unconditionally; its correctness rests on the structural
invariants plus worked examples with hand-computed answers.

## Why not the others

A cannot cover the state space, and browser tests are too slow to run thousands of
sequences. B tests that behaviour has not changed rather than that it is correct,
and locks in whatever the first implementation did, including its bugs.

## Evidence

Eleven seeded faults in `test/fault-injection/`, each a defect a real
implementation could plausibly have. Every one must be caught, and the invariant
that caught it is recorded. See [docs/testing.md](../testing.md) for the results,
including the two faults that initially escaped and what that revealed.

## Reversal

Nothing plausible. If ADR-0002 reverses and the oracle's data structure becomes
the implementation, the oracle role moves to an independently written naive
implementation rather than disappearing.
