import type { NodeId } from '../model/ids.js'
import type { SourceNode } from '../source/types.js'

/**
 * A page of children offered to the coverage store.
 *
 * `generation` is the value the caller read from `generationOf(parentId)` when it
 * decided to request this page. It exists for exactly one failure that contiguity
 * cannot catch, described on `CoverageStore.publish`.
 */
export interface PagePublication {
  readonly parentId: NodeId | null
  readonly offset: number
  readonly generation: number
  readonly nodes: readonly SourceNode[]
  readonly exhausted: boolean
  readonly total?: number
}

/**
 * What the store did with a page.
 *
 * Returned rather than thrown, because every outcome except `conflict` is an
 * ordinary thing that happens under latency, and because deciding what to do about
 * a rejected page is the loading layer's policy, not the store's. A store that
 * threw would force that policy into a catch block.
 */
export type PublishOutcome =
  /** The prefix grew, or exhaustion or a total was recorded. */
  | { readonly kind: 'applied'; readonly added: number }
  /** A repeat of a range already held, byte-for-byte identical. No change. */
  | { readonly kind: 'duplicate' }
  /** The parent's coverage was reset after this page was requested. Discarded. */
  | { readonly kind: 'stale'; readonly expected: number; readonly received: number }
  /** The page starts beyond the prefix. Applying it would create a hole. Discarded. */
  | { readonly kind: 'gap'; readonly prefixLength: number; readonly offset: number }
  /** The source contradicted itself or its earlier answers. */
  | { readonly kind: 'conflict'; readonly reason: string }
