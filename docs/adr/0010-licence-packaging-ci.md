# ADR-0010: MIT, two packages, CI as the benchmark environment

Status: Accepted (M0), with one deviation

## Decision

MIT, matching the ecosystem this composes with. Two packages, `@understory/core`
and `@understory/react`, with source adapters living inside core until a third
exists. CI is the canonical benchmark environment, with runner image, CPU model
and date recorded in every committed results file; local runs are published as
supplementary and labelled as such.

## Why not the alternatives

Apache-2.0's patent grant is real, but MIT removes a question a reader might
otherwise ask, and this is a portfolio artifact rather than a corporate
contribution.

A separate `@understory/adapter-*` package on day one would be an interface with
one implementation, which is a function wearing a package's clothes.

A development machine as the source of truth produces numbers nobody can
reproduce, and publishing a CPU model from a personal machine is an unnecessary
disclosure.

## Deviation, recorded rather than quietly swapped

The plan specified pnpm workspaces. This repository uses **npm workspaces**.
`corepack enable pnpm` requires sudo on the machine this was set up on, npm ships
with Node so a contributor needs no extra install, and pnpm's disk and strictness
advantages are marginal at two packages. If the package count grows past four, or
if phantom-dependency bugs appear, this is worth revisiting.

## Evidence

A stranger reproduces the headline ratio from a clean checkout with one command.
Absolute timings may differ; the normalised ratio must land within 10%.

## Reversal

If CI runner variance is wide enough to hide real regressions, the gate moves to
ratios against an in-run control workload rather than to a different machine.
