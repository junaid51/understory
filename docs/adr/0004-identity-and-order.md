# ADR-0004: Identity comes from the source; sibling order is the source's

Status: Accepted (M0)

## Context

Rows need stable keys across loads, evictions and mutations, and something must
decide the order of siblings that arrive across several pages.

## Options

- **A.** Positional keys, or keys derived from the path from the root.
- **B.** The engine sorts siblings by a consumer-supplied comparator.
- **C.** Source-provided opaque stable id, required. Order within a sibling set is
  the source's, carried as an opaque comparable `orderKey`.

## Decision

C, and with it an explicit refusal: **the engine will not sort a sibling set it
has not fully loaded.** Sorting is pushed down to the source or it does not happen.

## Why not the others

A breaks on the two operations this project is about: an insert renumbers
positions and a move invalidates paths.

B is worse than it looks. Sorting a partially loaded sibling set produces an order
that is locally consistent and globally wrong, so page two's rows interleave
incorrectly with page one's and rows silently duplicate or vanish at the
boundaries. This is the same total-order problem TanStack DB's RFC
[#1657](https://github.com/TanStack/db/issues/1657) identifies as implicit in its
own code. Refusing it outright is the cheapest correct answer available.

## Evidence

Property test over random interleavings of page arrival, insertion and deletion,
asserting the row sequence contains no duplicates and no omissions. In M0 this is
invariant I15 in the conformance suite, which checks observed sibling order
against the source's own array without consulting the oracle.

## Reversal

A source that genuinely cannot supply order keys and whose sibling sets are always
small enough to load whole. That earns a documented "fully loaded siblings" mode,
not a change to the default.
