# Architecture decision records

Each record answers six questions. A decision that cannot answer all six is not
ready to be made.

1. Context and problem
2. Options considered
3. Decision
4. Why the alternatives were rejected
5. Evidence that would validate or invalidate it
6. What would cause a reversal

Records for M1 and later decisions arrive with the milestone that forces them.
Writing them earlier would be guessing in a format that looks like certainty.

| ADR                                  | Decision                                                      | Milestone | Status                            |
| ------------------------------------ | ------------------------------------------------------------- | --------- | --------------------------------- |
| [0001](0001-dom-free-core.md)        | The core is DOM-free and the viewport is a pushed input       | M0        | Accepted                          |
| [0002](0002-index-space.md)          | The index space is a tree of cached spans                     | M0        | **Proposed, pending measurement** |
| [0003](0003-counts-are-a-type.md)    | Counts are a type, not a number                               | M0        | Accepted                          |
| [0004](0004-identity-and-order.md)   | Identity comes from the source; sibling order is the source's | M0        | Accepted                          |
| [0008](0008-reference-oracle.md)     | Correctness is established by a reference oracle              | M0        | Accepted                          |
| [0010](0010-licence-packaging-ci.md) | MIT, two packages, CI as the benchmark environment            | M0        | Accepted, one deviation           |

ADR-0002 is deliberately not accepted. It is the hypothesis M0 exists to test, and
the thresholds that decide it are committed before the implementation is written.
