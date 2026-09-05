# Understory

A headless engine for hierarchies too large to load. Renderer-agnostic, source-agnostic.

## Status: M0, and M0 exists to answer one question

> Is a span-based index space measurably better than a straightforward materialized
> projection, for the workloads this engine is intended to support?

If the answer is no, the architecture gets simpler and the proposed design is withdrawn.
The thresholds that decide this are committed to `bench/thresholds.json` **before** the
proposed implementation is written, and the verdict is computed by `npm run bench:verdict`
rather than argued in prose.

Nothing is published to npm yet. There is no renderer, no React binding, no demo
application and no source adapter, by design. See `docs/adr/` for why.

## Three implementations, three roles

| Role                  | Implementation | Optimised?                                      |
| --------------------- | -------------- | ----------------------------------------------- |
| Correctness reference | `oracle`       | Never. Obviously correct by inspection.         |
| The honest competitor | `materialized` | Yes, the way a shipped implementation would be. |
| The proposal          | `span`         | Yes. Must beat `materialized`, not `oracle`.    |

The oracle exists only to be the right-hand side of a comparison. Benchmarking against
it would rig the experiment, so it never appears in a benchmark.

## Commands

```
npm install
npm run typecheck
npm run lint
npm test            # fast tier: unit + conformance at low sequence counts
npm run test:deep   # deep tier: conformance at high sequence counts, fresh seed
```
