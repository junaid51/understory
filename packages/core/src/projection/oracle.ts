import { approximate, estimated, exact, type CountEstimate } from '../model/count.js'
import type { NodeId } from '../model/ids.js'
import type { TreeStore } from '../model/node.js'
import type { Row } from '../model/row.js'
import type { Projection } from './types.js'

/**
 * ┌───────────────────────────────────────────────────────────────────────┐
 * │  DO NOT OPTIMISE THIS FILE.                                           │
 * │                                                                       │
 * │  This is the correctness reference, not an implementation. Its only   │
 * │  job is to be obviously right when read, so it rebuilds the entire    │
 * │  row list from scratch on every single call, caches nothing, and      │
 * │  recurses because recursion is the obvious way to walk a tree.        │
 * │                                                                       │
 * │  It must never appear in a benchmark. Racing a tuned implementation   │
 * │  against a deliberately slow one proves nothing, and the moment this  │
 * │  file is optimised it stops being an independent check and starts     │
 * │  sharing the assumptions of the code it is supposed to be checking.   │
 * │                                                                       │
 * │  The honest performance competitor is `materialized`, arriving at     │
 * │  commit 5.                                                            │
 * └───────────────────────────────────────────────────────────────────────┘
 */
export class OracleProjection implements Projection {
  private readonly expanded: Set<NodeId>

  constructor(
    private readonly store: TreeStore,
    initiallyExpanded: Iterable<NodeId> = [],
  ) {
    this.expanded = new Set(initiallyExpanded)
  }

  private build(): Row[] {
    const rows: Row[] = []

    const walk = (ids: readonly NodeId[], depth: number): void => {
      // ADR-0004: source order is authoritative. This deliberately does not sort.
      for (const id of ids) {
        const node = this.store.get(id)
        if (node === undefined) throw new Error(`store is missing node ${id}`)

        rows.push({ kind: 'node', index: rows.length, id, parentId: node.parentId, depth })

        if (!this.expanded.has(id)) continue

        if (node.childIds === undefined) {
          // Expanded but unloaded: the children occupy rows even though nobody
          // knows what they are. How many is an estimate, and may be wrong.
          const slots = approximate(node.childCount)
          for (let slot = 0; slot < slots; slot++) {
            rows.push({
              kind: 'placeholder',
              index: rows.length,
              parentId: id,
              depth: depth + 1,
              slot,
            })
          }
        } else {
          walk(node.childIds, depth + 1)
        }
      }
    }

    walk(this.store.roots, 0)
    return rows
  }

  count(): CountEstimate {
    const rows = this.build()
    const hasPlaceholder = rows.some((row) => row.kind === 'placeholder')
    return hasPlaceholder ? estimated(rows.length) : exact(rows.length)
  }

  resolve(index: number): Row | undefined {
    if (index < 0) return undefined
    return this.build()[index]
  }

  slice(start: number, end: number): readonly Row[] {
    const from = Math.max(0, Math.trunc(start))
    const to = Math.max(from, Math.trunc(end))
    return this.build().slice(from, to)
  }

  isExpanded(id: NodeId): boolean {
    return this.expanded.has(id)
  }

  expand(id: NodeId): void {
    if (this.store.get(id) === undefined) throw new Error(`cannot expand unknown node ${id}`)
    this.expanded.add(id)
  }

  collapse(id: NodeId): void {
    if (this.store.get(id) === undefined) throw new Error(`cannot collapse unknown node ${id}`)
    this.expanded.delete(id)
  }

  expandedIds(): ReadonlySet<NodeId> {
    return new Set(this.expanded)
  }
}

export const oracleFactory = (
  store: TreeStore,
  initiallyExpanded: Iterable<NodeId> = [],
): Projection => new OracleProjection(store, initiallyExpanded)
