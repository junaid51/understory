# ADR-0003: Counts are a type, not a number

Status: Accepted (M0)

## Context

A scrollbar needs a total row count. That total depends on data that has not been
fetched.

## Options

- **A.** Require the source to provide exact counts.
- **B.** Count-free scrolling: no proportional scrollbar, load-more affordances only.
- **C.** `CountEstimate = exact | atLeast | estimated`, exact whenever the source
  can supply it cheaply, corrections propagated as data arrives.

## Decision

C. The engine never treats an estimate as exact, and the distinction lives in the
type where it cannot be ignored by accident. Combining two counts takes the least
precise of the two, because a sum is only as trustworthy as its worst term.

## Why not the others

A excludes most real sources, including every cursor-paginated REST API, which is
the common case and the first adapter. B is honest, and some products should do
exactly that, but it abandons proportional scrolling, which is the interaction
this engine exists to preserve. C's cost is scrollbar correction, which is
measurable and tunable rather than structural.

## Evidence

Correction events and largest single scrollbar displacement over a scripted
10,000-row scroll, per corpus shape. Target: under one correction per thousand
rows, and no single displacement over 2% of the track.

In M0 the estimated path is exercised without a source adapter: the corpus
generator marks a configurable fraction of nodes as expanded-but-unloaded with a
deliberately skewed estimate, so nothing can assume an estimate equals the truth.

## Reversal

If corrections prove visually intolerable at realistic fan-outs, the fallback is B
behind a flag, not A. Requiring exact counts would change which sources can be
used at all.
