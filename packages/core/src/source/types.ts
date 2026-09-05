import type { NodeId } from '../model/ids.js'

/**
 * One node as a source reports it.
 *
 * Two fields, and both are load-bearing.
 *
 * `hasChildren` is not a convenience. Without it the engine cannot know a node is
 * expandable until it has already expanded it, and under M1's loaded-prefix model
 * a node with no loaded children and no known total is indistinguishable from a
 * leaf, so nothing could ever open it. That is a deadlock, not a missing nicety,
 * which is what earns the field its place.
 *
 * There is deliberately no payload and no type parameter. The engine never reads a
 * node's contents, so carrying them would mean threading a generic through every
 * signature to move data the engine cannot use. A consumer owns its source, so it
 * can capture whatever it needs on the way past and look it up by id.
 */
export interface SourceNode {
  readonly id: NodeId
  readonly hasChildren: boolean
}

export interface LoadChildrenRequest {
  /** `null` addresses the roots. Roots are a parent like any other. */
  readonly parentId: NodeId | null
  /** Zero-based index into this parent's children, in source order. */
  readonly offset: number
  /** Maximum nodes to return. A source may return fewer, even mid-sequence. */
  readonly limit: number
  readonly signal: AbortSignal
}

export interface LoadChildrenResult {
  /** In source order. The engine never sorts these (ADR-0004). */
  readonly nodes: readonly SourceNode[]
  /** True when `offset + nodes.length` is the end of this parent's children. */
  readonly exhausted: boolean
  /** The exact child count, when the source knows it cheaply. */
  readonly total?: number
}

/**
 * The entire contract. One method.
 *
 * No `countChildren`: a total is a property of a page response, not a separate
 * round trip. No `subscribe`: live updates enter through the engine's existing
 * `invalidate(id)` primitive. No capability flags: a source that cannot supply a
 * total omits it, which is the same information without a second way to say it.
 */
export interface HierarchySource {
  loadChildren(request: LoadChildrenRequest): Promise<LoadChildrenResult>
}

/**
 * The identity of a request: same key, same answer.
 *
 * This is what makes out-of-order testing deterministic. If a response is a pure
 * function of its request identity, reordering arrivals varies only timing, never
 * content, and a test can shuffle completions without a timer or a race.
 *
 * The signal is excluded on purpose: cancelling a request does not make it a
 * different question.
 *
 * Roots carry a distinct `r:` prefix rather than a sentinel id. A first attempt
 * used the string `<roots>` in the id position, which a contract test immediately
 * broke by asking for the children of a node whose id was literally `<roots>`.
 * Node ids are opaque strings supplied by a source, so no value is safe to reserve
 * in a namespace they share; the discriminator has to live outside it. Offset and
 * limit are always the final two segments, so a node id containing colons is
 * unambiguous.
 */
export const requestKey = (request: {
  parentId: NodeId | null
  offset: number
  limit: number
}): string =>
  request.parentId === null
    ? `r:${request.offset}:${request.limit}`
    : `n:${request.parentId}:${request.offset}:${request.limit}`

/** A malformed range. Distinct from an abort, which is not an error in the data. */
export class InvalidRangeError extends RangeError {
  override readonly name = 'InvalidRangeError'
}

/**
 * The range validation every source performs identically, so this cannot drift
 * between implementations.
 */
export function assertValidRange(request: { offset: number; limit: number }): void {
  const { offset, limit } = request
  if (!Number.isInteger(offset) || offset < 0) {
    throw new InvalidRangeError(`offset must be a non-negative integer, received ${offset}`)
  }
  if (!Number.isInteger(limit) || limit < 1) {
    throw new InvalidRangeError(`limit must be a positive integer, received ${limit}`)
  }
}
