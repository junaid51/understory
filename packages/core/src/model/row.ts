import type { NodeId } from './ids.js'

/**
 * One row of the index space.
 *
 * A `placeholder` row is a slot belonging to an expanded node whose children
 * have not been loaded. It has a position but no node yet. Placeholders exist so
 * that loading children does not change how many rows precede or follow them,
 * which is what keeps a reader's scroll position stable.
 */
export type Row =
  | {
      readonly kind: 'node'
      readonly index: number
      readonly id: NodeId
      readonly parentId: NodeId | null
      readonly depth: number
    }
  | {
      readonly kind: 'placeholder'
      readonly index: number
      readonly parentId: NodeId
      readonly depth: number
      /** Position within the unloaded parent's children. Gives the row a stable key. */
      readonly slot: number
    }

/**
 * A key that survives rows moving to different indices. Renderers need this;
 * so does the conformance suite, which uses key collisions to detect identity bugs.
 */
export const rowKey = (row: Row): string =>
  row.kind === 'node' ? `n:${row.id}` : `p:${row.parentId}:${row.slot}`
