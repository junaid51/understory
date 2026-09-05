import fc from 'fast-check'
import {
  MapTreeStore,
  estimated,
  exact,
  nodeId,
  orderKey,
  type NodeId,
  type NodeRecord,
} from '../../src/index.js'

export interface TreeSpec {
  /** Children per node, applied breadth-first. Shrinks well because it is a plain array. */
  readonly fanouts: readonly number[]
  /** Which nodes have their children marked unloaded. */
  readonly unloaded: readonly boolean[]
  /**
   * How wrong the estimate on an unloaded node is. Deliberately non-zero so that
   * nothing can quietly assume an estimate equals the truth.
   */
  readonly estimateSkew: number
}

const MAX_NODES = 60

export function buildStore(spec: TreeSpec): MapTreeStore {
  const parents: (NodeId | null)[] = [null]
  const children: NodeId[][] = [[]]
  const ids: NodeId[] = [nodeId('n0')]

  let cursor = 0
  while (cursor < ids.length && ids.length < MAX_NODES) {
    const id = ids[cursor]
    if (id === undefined) break
    const fanout = spec.fanouts[cursor % Math.max(1, spec.fanouts.length)] ?? 0
    for (let i = 0; i < fanout && ids.length < MAX_NODES; i++) {
      const child = nodeId(`n${ids.length}`)
      ids.push(child)
      parents.push(id)
      children.push([])
      children[cursor]?.push(child)
    }
    cursor += 1
  }

  const nodes = new Map<NodeId, NodeRecord>()
  for (let i = 0; i < ids.length; i++) {
    const id = ids[i]
    const parentId = parents[i] ?? null
    const kids = children[i] ?? []
    if (id === undefined) continue
    const siblings = parentId === null ? [id] : (children[ids.indexOf(parentId)] ?? [])
    const slot = Math.max(0, siblings.indexOf(id))
    const isUnloaded =
      kids.length > 0 && (spec.unloaded[i % Math.max(1, spec.unloaded.length)] ?? false)
    const skewed = Math.max(0, kids.length + spec.estimateSkew)
    nodes.set(id, {
      id,
      parentId,
      orderKey: orderKey(String(slot).padStart(6, '0')),
      childIds: isUnloaded ? undefined : kids,
      childCount: isUnloaded ? estimated(skewed) : exact(kids.length),
    })
  }

  return new MapTreeStore([nodeId('n0')], nodes)
}

export const treeSpecArb: fc.Arbitrary<TreeSpec> = fc.record({
  fanouts: fc.array(fc.integer({ min: 0, max: 4 }), { minLength: 1, maxLength: 24 }),
  unloaded: fc.array(fc.boolean(), { minLength: 1, maxLength: 24 }),
  estimateSkew: fc.integer({ min: -2, max: 3 }),
})

export type Command =
  | { readonly op: 'expand'; readonly target: number }
  | { readonly op: 'collapse'; readonly target: number }
  /**
   * Expand or collapse everything at once.
   *
   * Added after fault injection showed that random single-node commands almost
   * never reveal a tree deeper than two levels, so two seeded faults escaped
   * every one of 150 random trees. Without this, the suite tests shallow trees
   * and quietly claims to test trees.
   */
  | { readonly op: 'expandAll' }
  | { readonly op: 'collapseAll' }

export const commandsArb = (maxLength: number): fc.Arbitrary<Command[]> =>
  fc.array(
    fc.oneof(
      { arbitrary: fc.record({ op: fc.constant<'expandAll'>('expandAll') }), weight: 3 },
      { arbitrary: fc.record({ op: fc.constant<'collapseAll'>('collapseAll') }), weight: 1 },
      {
        arbitrary: fc.record({
          op: fc.constant<'expand'>('expand'),
          target: fc.nat({ max: MAX_NODES - 1 }),
        }),
        weight: 4,
      },
      {
        arbitrary: fc.record({
          op: fc.constant<'collapse'>('collapse'),
          target: fc.nat({ max: MAX_NODES - 1 }),
        }),
        weight: 3,
      },
    ),
    { maxLength },
  )

export const allNodeIds = (store: MapTreeStore): NodeId[] => [...store.entries()].map(([id]) => id)

/** Commands reference node slots; unknown slots are dropped rather than throwing. */
export function applicable(store: MapTreeStore, command: Command): NodeId | undefined {
  if (command.op === 'expandAll' || command.op === 'collapseAll') return undefined
  const id = nodeId(`n${command.target}`)
  return store.get(id) === undefined ? undefined : id
}

/**
 * Apply a command to one or more projections that are being kept in lockstep.
 * Shared so the conformance suite and the fault probe cannot drift apart.
 */
export function applyCommand(
  store: MapTreeStore,
  command: Command,
  targets: readonly { expand(id: NodeId): void; collapse(id: NodeId): void }[],
): boolean {
  if (command.op === 'expandAll' || command.op === 'collapseAll') {
    const ids = allNodeIds(store)
    for (const projection of targets) {
      for (const id of ids) {
        if (command.op === 'expandAll') projection.expand(id)
        else projection.collapse(id)
      }
    }
    return true
  }
  const id = applicable(store, command)
  if (id === undefined) return false
  for (const projection of targets) {
    if (command.op === 'expand') projection.expand(id)
    else projection.collapse(id)
  }
  return true
}
