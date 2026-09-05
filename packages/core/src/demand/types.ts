import type { NodeId } from '../model/ids.js'
import type { PublishOutcome } from '../coverage/types.js'

/**
 * A half-open row range in the *current* index space, plus rows to keep resident
 * on each side.
 *
 * It is a statement about now, not a subscription. When the index space changes,
 * the consumer pushes a new viewport. The engine does not preserve scroll position
 * across changes; anchoring is M2, and doing it here would smuggle M2 into M1.
 */
export interface Viewport {
  readonly startIndex: number
  readonly endIndex: number
  readonly overscan: number
}

/** One page this state wants and does not have. */
export interface Demand {
  readonly parentId: NodeId | null
  readonly offset: number
  readonly limit: number
}

/** What one round of loading did. A value, not a handle. */
export interface LoadReport {
  readonly requested: number
  /** Requests skipped because an identical one was already in flight. */
  readonly deduplicated: number
  readonly outcomes: readonly PublishOutcome[]
  /** Expansions recorded earlier that this round was finally able to apply. */
  readonly expansionsApplied: number
}
