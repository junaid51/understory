# ADR-0001: The core is DOM-free and the viewport is a pushed input

Status: Accepted (M0)

## Context

The engine has to know what is visible. It could observe the scroll container, or
it could be told.

## Options

- **A.** Own a scroll container and read `scrollTop` and element measurements.
- **B.** Observe elements with `IntersectionObserver`.
- **C.** Expose `setViewport({ startIndex, endIndex, overscan })` and let the
  consumer's virtualizer supply it.

## Decision

C. The core references no DOM type, no `window`, no `document`, and no framework.

## Why not the others

A makes the engine a renderer, which is a stated non-goal, and puts it in
competition with TanStack Virtual and React Aria, both of which measure better
than we would. B is A with more indirection and still needs elements to exist.

The decisive argument is not architectural taste. Both A and B make the engine
untestable outside a browser, which forfeits the property tests in ADR-0008 and
the Node-hosted benchmarks that every other decision depends on for evidence. A
DOM-free core is what makes the rest of the project's evidence possible.

## Evidence

The whole M0 test suite runs under Node with no DOM shim, and the eventual React
binding contains no engine logic. Both are checkable rather than aspirational.

## Reversal

If dynamic row measurement turns out to need a feedback loop the consumer cannot
mediate, so that the engine must know pixel heights to answer index queries.
Even then measurement gets pushed in as data; the engine does not reach for the DOM.
