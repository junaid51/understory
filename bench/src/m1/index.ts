/**
 * The M1 measurement apparatus, minus anything that touches Node.
 *
 * `run.ts`, `runner.ts` and `verdict.ts` are deliberately absent: they import
 * `node:fs`, `node:child_process` and `node:perf_hooks`, and a browser bundler
 * that follows them produces an unresolvable import rather than a useful error.
 * What is here is the part the demo needs and the part that is pure computation
 * over engine state: the invariants, the Reach model behind amplification, the
 * request ledger, the workload traces and the trace harness.
 */
export * from './harness.js'
export * from './instrument.js'
export * from './invariants.js'
export * from './reach.js'
export * from './traces.js'
