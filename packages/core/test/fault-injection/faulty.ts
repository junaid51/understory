import {
  approximate,
  estimated,
  exact,
  type CountEstimate,
  type NodeId,
  type Projection,
  type Row,
  type TreeStore,
} from '../../src/index.js'

/**
 * A second, deliberately defective copy of the naive projection.
 *
 * This is duplicated from the oracle on purpose. Injecting faults into the
 * oracle itself would put fault-handling code inside the file whose entire value
 * is being obviously correct when read. The duplication risks drift, so the
 * first fault in the list is `none`, and a test asserts that the undamaged copy
 * agrees with the oracle exactly. If the two ever diverge, that test fails and
 * the fault harness is known to be lying before its results are trusted.
 */
export type Fault =
  | 'none'
  | 'off-by-one-slice'
  | 'collapsed-emits-children'
  | 'depth-not-incremented'
  | 'duplicate-single-child'
  | 'omit-placeholders'
  | 'reverse-siblings-at-depth-2'
  | 'double-expand'
  | 'stale-resolve'
  | 'unstable-placeholder-slot'
  | 'index-field-off-by-one'
  | 'count-ignores-placeholders'

export const FAULTS: readonly Fault[] = [
  'off-by-one-slice',
  'collapsed-emits-children',
  'depth-not-incremented',
  'duplicate-single-child',
  'omit-placeholders',
  'reverse-siblings-at-depth-2',
  'double-expand',
  'stale-resolve',
  'unstable-placeholder-slot',
  'index-field-off-by-one',
  'count-ignores-placeholders',
]

export const FAULT_DESCRIPTIONS: Record<Fault, string> = {
  none: 'undamaged control; must agree with the oracle',
  'off-by-one-slice': 'slice drops its last row',
  'collapsed-emits-children': 'a collapsed node still emits its children',
  'depth-not-incremented': 'children are reported at their parent depth',
  'duplicate-single-child': 'a node with exactly one child emits it twice',
  'omit-placeholders': 'expanded-but-unloaded nodes emit nothing',
  'reverse-siblings-at-depth-2': 'sibling order is reversed at one depth',
  'double-expand': 'an expanded subtree is emitted twice',
  'stale-resolve': 'resolve serves a snapshot taken at construction',
  'unstable-placeholder-slot': 'placeholder slots come from a global counter',
  'index-field-off-by-one': 'row.index is one greater than the position',
  'count-ignores-placeholders': 'count claims exact while placeholders exist',
}

export class FaultyProjection implements Projection {
  private readonly expanded: Set<NodeId>
  private readonly snapshotAtConstruction: Row[]
  private placeholderCounter = 0

  constructor(
    private readonly store: TreeStore,
    private readonly fault: Fault,
    initiallyExpanded: Iterable<NodeId> = [],
  ) {
    this.expanded = new Set(initiallyExpanded)
    this.snapshotAtConstruction = this.build()
  }

  private build(): Row[] {
    const rows: Row[] = []
    this.placeholderCounter = 0

    const walk = (ids: readonly NodeId[], depth: number): void => {
      const ordered =
        this.fault === 'reverse-siblings-at-depth-2' && depth === 2 ? [...ids].reverse() : ids

      for (const id of ordered) {
        const node = this.store.get(id)
        if (node === undefined) throw new Error(`store is missing node ${id}`)

        const emit = (): void => {
          rows.push({
            kind: 'node',
            index: this.fault === 'index-field-off-by-one' ? rows.length + 1 : rows.length,
            id,
            parentId: node.parentId,
            depth,
          })
        }
        emit()

        const childDepth = this.fault === 'depth-not-incremented' ? depth : depth + 1
        const expanded = this.expanded.has(id) || this.fault === 'collapsed-emits-children'
        if (!expanded) continue

        const times = this.fault === 'double-expand' ? 2 : 1
        for (let pass = 0; pass < times; pass++) {
          if (node.childIds === undefined) {
            if (this.fault === 'omit-placeholders') continue
            const slots = approximate(node.childCount)
            for (let slot = 0; slot < slots; slot++) {
              rows.push({
                kind: 'placeholder',
                index: this.fault === 'index-field-off-by-one' ? rows.length + 1 : rows.length,
                parentId: id,
                depth: childDepth,
                slot: this.fault === 'unstable-placeholder-slot' ? this.placeholderCounter++ : slot,
              })
            }
          } else {
            const children =
              this.fault === 'duplicate-single-child' && node.childIds.length === 1
                ? [...node.childIds, ...node.childIds]
                : node.childIds
            walk(children, childDepth)
          }
        }
      }
    }

    walk(this.store.roots, 0)
    return rows
  }

  count(): CountEstimate {
    const rows = this.build()
    if (this.fault === 'count-ignores-placeholders') return exact(rows.length)
    return rows.some((row) => row.kind === 'placeholder')
      ? estimated(rows.length)
      : exact(rows.length)
  }

  resolve(index: number): Row | undefined {
    if (index < 0) return undefined
    const rows = this.fault === 'stale-resolve' ? this.snapshotAtConstruction : this.build()
    return rows[index]
  }

  slice(start: number, end: number): readonly Row[] {
    const from = Math.max(0, Math.trunc(start))
    const to = Math.max(from, Math.trunc(end))
    const rows = this.build()
    return this.fault === 'off-by-one-slice'
      ? rows.slice(from, Math.max(from, to - 1))
      : rows.slice(from, to)
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

export const faultyFactory =
  (fault: Fault) =>
  (store: TreeStore, initiallyExpanded: Iterable<NodeId> = []): Projection =>
    new FaultyProjection(store, fault, initiallyExpanded)
