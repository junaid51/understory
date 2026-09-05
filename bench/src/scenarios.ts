import {
  MaterializedProjection,
  approximate,
  exact,
  type NodeId,
  type NodeRecord,
  type Projection,
} from '@understory/core'
import type { MapTreeStore } from '@understory/core'
import { MutableTreeStore } from './mutable-store.js'

const WINDOW = 100

export interface ScenarioContext {
  readonly store: MapTreeStore
  readonly ids: readonly NodeId[]
  /** Nodes with children, by descending child count. */
  readonly branchy: readonly NodeId[]
  readonly depthByNode: ReadonlyMap<NodeId, number>
  readonly deepestPath: readonly NodeId[]
}

export interface Scenario {
  readonly name: string
  readonly samples: number
  /**
   * Sample count at one million nodes, where a single sample can cost a full
   * rebuild. Only reduced for scenarios that carry no pre-registered threshold,
   * or where the threshold is generous enough that a small-sample p99 (which is
   * effectively the max, and therefore stricter) is still a fair test.
   */
  readonly samplesAtMillion?: number
  /** Some operations are far below clock resolution and are timed in batches. */
  readonly batch?: number
  readonly note?: string
  prepare(ctx: ScenarioContext): (i: number) => void
}

export function analyse(store: MapTreeStore): ScenarioContext {
  const ids = [...store.entries()].map(([id]) => id)
  const depthByNode = new Map<NodeId, number>()
  const stack: { id: NodeId; depth: number }[] = store.roots.map((id) => ({ id, depth: 0 }))
  let deepest: NodeId[] = []
  const parentOf = new Map<NodeId, NodeId>()
  let deepestNode: NodeId | undefined
  let deepestDepth = -1
  while (stack.length > 0) {
    const entry = stack.pop()
    if (entry === undefined) break
    depthByNode.set(entry.id, entry.depth)
    if (entry.depth > deepestDepth) {
      deepestDepth = entry.depth
      deepestNode = entry.id
    }
    const node = store.get(entry.id)
    for (const child of node?.childIds ?? []) {
      parentOf.set(child, entry.id)
      stack.push({ id: child, depth: entry.depth + 1 })
    }
  }
  if (deepestNode !== undefined) {
    let cursor: NodeId | undefined = deepestNode
    while (cursor !== undefined) {
      deepest.push(cursor)
      cursor = parentOf.get(cursor)
    }
    deepest = deepest.reverse()
  }
  const branchy = ids
    .filter((id) => (store.get(id)?.childIds?.length ?? 0) > 0)
    .sort((a, b) => (store.get(b)?.childIds?.length ?? 0) - (store.get(a)?.childIds?.length ?? 0))
  return { store, ids, branchy, depthByNode, deepestPath: deepest }
}

const expandAll = (projection: Projection, ids: readonly NodeId[]): void => {
  for (const id of ids) projection.expand(id)
}

/** Reads the count and one window. Every mutation scenario ends with this,
 *  because the materialized projection rebuilds lazily and timing a mutation
 *  without a read would be timing a flag assignment. */
const read = (projection: Projection): void => {
  const total = approximate(projection.count())
  projection.slice(0, Math.min(WINDOW, total))
}

export const SCENARIOS: readonly Scenario[] = [
  {
    // Added after a probe showed the pre-registered `initial-projection`
    // scenario expands only depths 0 and 1, which on most shapes is a few dozen
    // rows and therefore a weak test of what its 250ms threshold intended. The
    // threshold is pre-registered and is NOT being changed; this scenario is
    // supplementary, carries no threshold, and exists so the report can state
    // the cold full-build cost honestly alongside it.
    name: 'full-projection-build',
    samples: 12,
    samplesAtMillion: 5,
    note: 'cold build with every node expanded. Supplementary: no pre-registered threshold',
    prepare: (ctx) => () => {
      const projection = new MaterializedProjection(ctx.store)
      expandAll(projection, ctx.ids)
      read(projection)
    },
  },
  {
    name: 'initial-projection',
    samples: 12,
    samplesAtMillion: 8, // p99 of 8 samples is effectively the max, which is stricter than the threshold asks for
    note: 'fresh projection, expand roots and their children, then read',
    prepare: (ctx) => {
      const opening = ctx.ids.filter((id) => (ctx.depthByNode.get(id) ?? 99) <= 1)
      return () => {
        const projection = new MaterializedProjection(ctx.store)
        for (const id of opening) projection.expand(id)
        read(projection)
      }
    },
  },
  {
    name: 'expand-collapse-shallow',
    samples: 120,
    note: 'toggle a node at depth 1, then read',
    prepare: (ctx) => {
      const projection = new MaterializedProjection(ctx.store)
      expandAll(projection, ctx.ids)
      read(projection)
      const target =
        ctx.branchy.find((id) => (ctx.depthByNode.get(id) ?? 0) === 1) ??
        ctx.branchy[0] ??
        ctx.ids[0]
      return (i) => {
        if (target === undefined) return
        if (i % 2 === 0) projection.collapse(target)
        else projection.expand(target)
        read(projection)
      }
    },
  },
  {
    name: 'expand-collapse-deep',
    samples: 120,
    note: 'toggle the deepest branchy node, then read',
    prepare: (ctx) => {
      const projection = new MaterializedProjection(ctx.store)
      expandAll(projection, ctx.ids)
      read(projection)
      const deep = [...ctx.branchy].sort(
        (a, b) => (ctx.depthByNode.get(b) ?? 0) - (ctx.depthByNode.get(a) ?? 0),
      )
      const target = deep[0]
      return (i) => {
        if (target === undefined) return
        if (i % 2 === 0) projection.collapse(target)
        else projection.expand(target)
        read(projection)
      }
    },
  },
  {
    name: 'deep-expansion-chain',
    samples: 30,
    samplesAtMillion: 3, // one sample is a whole root-to-leaf path, each step a full rebuild; no pre-registered threshold
    note: 'expand every node on a root-to-leaf path, reading after each',
    prepare: (ctx) => {
      const path = ctx.deepestPath
      return () => {
        const projection = new MaterializedProjection(ctx.store)
        for (const id of path) {
          projection.expand(id)
          read(projection)
        }
      }
    },
  },
  {
    name: 'large-sibling-set',
    samples: 40,
    samplesAtMillion: 10, // no pre-registered threshold
    note: 'expand the widest parent, then read',
    prepare: (ctx) => {
      const target = ctx.branchy[0]
      const ancestors: NodeId[] = []
      let cursor = target === undefined ? undefined : ctx.store.get(target)?.parentId
      while (cursor != null) {
        ancestors.push(cursor)
        cursor = ctx.store.get(cursor)?.parentId ?? null
      }
      return () => {
        const projection = new MaterializedProjection(ctx.store)
        for (const id of ancestors) projection.expand(id)
        read(projection)
        if (target !== undefined) projection.expand(target)
        read(projection)
      }
    },
  },
  {
    name: 'resolve-random',
    samples: 60,
    batch: 1000,
    note: 'uniform random index lookups, timed in batches of 1000',
    prepare: (ctx) => {
      const projection = new MaterializedProjection(ctx.store)
      expandAll(projection, ctx.ids)
      const total = approximate(projection.count())
      let seed = 1
      return () => {
        for (let k = 0; k < 1000; k++) {
          seed = (Math.imul(seed, 1664525) + 1013904223) | 0
          projection.resolve(Math.abs(seed) % Math.max(1, total))
        }
      }
    },
  },
  {
    name: 'scroll-sequential',
    samples: 400,
    samplesAtMillion: 200, // cheap per sample; 200 still resolves p99
    note: 'one 100-row window, advancing through the space',
    prepare: (ctx) => {
      const projection = new MaterializedProjection(ctx.store)
      expandAll(projection, ctx.ids)
      const total = approximate(projection.count())
      const step = Math.max(1, Math.floor(total / 400))
      return (i) => {
        const start = (i * step) % Math.max(1, total)
        projection.slice(start, start + WINDOW)
      }
    },
  },
  {
    name: 'scroll-repeated',
    samples: 400,
    samplesAtMillion: 200, // cheap per sample
    note: 'back and forth over the same region',
    prepare: (ctx) => {
      const projection = new MaterializedProjection(ctx.store)
      expandAll(projection, ctx.ids)
      const total = approximate(projection.count())
      const anchor = Math.floor(total / 2)
      return (i) => {
        const start = anchor + (i % 8) * WINDOW
        projection.slice(start, start + WINDOW)
      }
    },
  },
  {
    name: 'scroll-random-jump',
    samples: 400,
    samplesAtMillion: 200, // cheap per sample
    note: 'window positions chosen at random, as from a scrollbar drag',
    prepare: (ctx) => {
      const projection = new MaterializedProjection(ctx.store)
      expandAll(projection, ctx.ids)
      const total = approximate(projection.count())
      let seed = 7
      return () => {
        seed = (Math.imul(seed, 1664525) + 1013904223) | 0
        const start = Math.abs(seed) % Math.max(1, total)
        projection.slice(start, start + WINDOW)
      }
    },
  },
  {
    name: 'subtree-size-change',
    samples: 80,
    note: 'add and remove a child under an expanded ancestor, then read',
    prepare: (ctx) => {
      const mutable = MutableTreeStore.from(ctx.store)
      const projection = new MaterializedProjection(mutable)
      expandAll(projection, ctx.ids)
      read(projection)
      const parentId = ctx.branchy[Math.floor(ctx.branchy.length / 2)] ?? ctx.branchy[0]
      const original = parentId === undefined ? undefined : mutable.get(parentId)
      const extra = original?.childIds?.[0]
      return (i) => {
        if (parentId === undefined || original?.childIds === undefined || extra === undefined)
          return
        const children = i % 2 === 0 ? [...original.childIds, extra] : [...original.childIds]
        const record: NodeRecord = {
          ...original,
          childIds: children,
          childCount: exact(children.length),
        }
        mutable.set(record)
        projection.invalidate()
        read(projection)
      }
    },
  },
  {
    name: 'estimate-correction',
    samples: 80,
    samplesAtMillion: 40, // no pre-registered threshold
    note: 'an unloaded node receives its real children, replacing an estimate',
    prepare: (ctx) => {
      const mutable = MutableTreeStore.from(ctx.store)
      const projection = new MaterializedProjection(mutable)
      expandAll(projection, ctx.ids)
      read(projection)
      const parentId = ctx.branchy[0]
      const loaded = parentId === undefined ? undefined : mutable.get(parentId)
      return (i) => {
        if (parentId === undefined || loaded?.childIds === undefined) return
        const record: NodeRecord =
          i % 2 === 0
            ? {
                ...loaded,
                childIds: undefined,
                childCount: { kind: 'estimated', value: loaded.childIds.length + 3 },
              }
            : loaded
        mutable.set(record)
        projection.invalidate()
        read(projection)
      }
    },
  },
]
