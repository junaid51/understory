import { estimated, exact, nodeId, orderKey, type ExactCount, type NodeId } from '../src/index.js'

// A count that might be wrong cannot be used where an exact one is required.
// @ts-expect-error estimated is not exact
export const notExact: ExactCount = estimated(5)

// @ts-expect-error atLeast is not exact
export const notExactEither: ExactCount = { kind: 'atLeast', value: 5 }

// A raw string is not an identifier.
// @ts-expect-error string is not NodeId
export const notAnId: NodeId = 'n1'

// An OrderKey is not a NodeId, even though both are strings underneath. This is
// the confusion the brands exist to prevent.
// @ts-expect-error OrderKey is not NodeId
export const notAnIdEither: NodeId = orderKey('a')

// These are the legal forms, present so the file also proves the brands are usable.
export const fine: NodeId = nodeId('n1')
export const alsoFine: ExactCount = exact(5)
