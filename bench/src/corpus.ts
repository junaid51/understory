import {
  MapTreeStore,
  estimated,
  exact,
  nodeId,
  orderKey,
  type NodeId,
  type NodeRecord,
} from '@understory/core'
import { mulberry32, randInt } from './prng.js'

export type ShapeName =
  'shallow-wide' | 'deep-narrow' | 'balanced' | 'sparse-unbalanced' | 'mega-sibling'

export const SHAPES: readonly ShapeName[] = [
  'shallow-wide',
  'deep-narrow',
  'balanced',
  'sparse-unbalanced',
  'mega-sibling',
]

export interface CorpusOptions {
  /** Exact number of nodes to produce. */
  readonly nodes: number
  readonly seed: number
  /**
   * Fraction of eligible nodes whose children are marked unloaded, so their span
   * is an estimate rather than a fact. This is how M0 exercises the
   * estimated-count path without a source adapter existing yet.
   */
  readonly unloadedFraction?: number
  /**
   * A node is only eligible to be marked unloaded if its subtree is no larger
   * than this.
   *
   * Without the cap, unloading amputates the corpus on deep shapes: an unloaded
   * node hides everything beneath it, and in a chain of depth 64 a 5% rate means
   * only 0.95^64, under 4%, of chains survive intact. The first full benchmark
   * run measured deep-narrow at one million nodes as a THIRTY-TWO row tree and
   * reported it as passing every threshold. It had not passed; it had not been
   * tested. The cap keeps the visible index space close to the requested node
   * count while still producing estimated spans.
   *
   * Measured at 200,000 nodes with a 5% fraction: a cap of 8 keeps every shape
   * at 93.8% of its nodes reachable or better, against 83.7% at a cap of 32.
   *
   * Known limitation of the cap: on shallow-wide and mega-sibling every node
   * with children owns a huge subtree, so nothing is eligible and the estimated
   * span path is not exercised on those two shapes at all. That is inherent to
   * the shapes rather than to the cap, and it is stated rather than hidden.
   */
  readonly maxHiddenSubtree?: number
}

interface ShapeSpec {
  /** bfs grows breadth-first (wide trees); dfs drives depth before breadth. */
  readonly order: 'bfs' | 'dfs'
  readonly maxDepth: number
  readonly fanOut: (rng: () => number, depth: number) => number
}

// maxDepth is capped well under the JS stack limit on purpose: the oracle walks
// recursively because that is the obvious implementation, and a corpus that blows
// its stack would break the experiment rather than test it.
const SPECS: Record<ShapeName, ShapeSpec> = {
  'shallow-wide': { order: 'bfs', maxDepth: 3, fanOut: (rng) => randInt(rng, 40, 120) },
  'deep-narrow': { order: 'dfs', maxDepth: 64, fanOut: (rng) => randInt(rng, 1, 2) },
  balanced: { order: 'bfs', maxDepth: 16, fanOut: (rng) => randInt(rng, 6, 10) },
  // Power law: most nodes have almost no children, a few have a great many.
  // This is the shape a real filesystem or asset library actually has.
  'sparse-unbalanced': {
    order: 'bfs',
    maxDepth: 12,
    fanOut: (rng) => {
      const r = rng()
      if (r < 0.75) return randInt(rng, 0, 2)
      if (r < 0.97) return randInt(rng, 3, 30)
      return randInt(rng, 500, 5000)
    },
  },
  // The pathological case the span index space is supposed to exist for.
  'mega-sibling': { order: 'bfs', maxDepth: 1, fanOut: () => Number.MAX_SAFE_INTEGER },
}

interface Built {
  readonly roots: NodeId[]
  readonly records: Map<NodeId, { parentId: NodeId | null; depth: number; children: NodeId[] }>
  readonly order: NodeId[]
}

function buildStructure(shape: ShapeName, opts: CorpusOptions): Built {
  const spec = SPECS[shape]
  const rng = mulberry32(opts.seed)
  const records: Built['records'] = new Map()
  const order: NodeId[] = []
  const roots: NodeId[] = []

  let next = 0
  const create = (parentId: NodeId | null, depth: number): NodeId => {
    const id = nodeId(`n${next++}`)
    records.set(id, { parentId, depth, children: [] })
    order.push(id)
    return id
  }

  let remaining = opts.nodes
  if (remaining <= 0) return { roots, records, order }

  const first = create(null, 0)
  roots.push(first)
  remaining -= 1

  const frontier: NodeId[] = [first]
  // Forward cursor into `order`, used to widen already-created nodes when the
  // frontier runs dry. A cursor rather than a filter because re-scanning the
  // whole node list on every exhaustion is O(n^2), and sparse-unbalanced empties
  // its frontier constantly: three quarters of its nodes are given no children.
  let reserve = 0
  // Once the frontier has been exhausted once, refilled parents are guaranteed at
  // least one child. Without that, sparse-unbalanced spins forever: three
  // quarters of its nodes draw a fan-out of zero to two, so a refill can hand out
  // four thousand parents and place nothing, drain, and refill again with the
  // budget untouched. Widening only engages when the shape cannot otherwise hold
  // the requested node count, and it is preferable to the alternative, which was
  // silently emitting a different topology.
  let widening = false
  while (remaining > 0) {
    if (frontier.length === 0) {
      // The frontier is exhausted but budget remains, because this shape's depth
      // cap cannot hold the requested node count at its natural fan-out.
      //
      // The previous version appended the leftovers as extra ROOTS. That silently
      // turned shallow-wide at one million nodes into 437,659 roots, 43.8% of the
      // corpus, and every benchmark on that shape was then measuring a corpus
      // nothing in the project intended. It was found only because a projection
      // scanned an 80,000-long sibling list.
      //
      // Widening existing nodes instead keeps the topology the shape claims: one
      // root, the same depth bound, more children per node.
      widening = true
      let added = 0
      let scanned = 0
      while (added < 4096 && scanned < order.length) {
        if (reserve >= order.length) reserve = 0
        const candidate = order[reserve]
        reserve += 1
        scanned += 1
        if (candidate === undefined) continue
        if ((records.get(candidate)?.depth ?? Number.POSITIVE_INFINITY) < spec.maxDepth) {
          frontier.push(candidate)
          added += 1
        }
      }
      if (added === 0) {
        throw new Error(
          `${shape}: cannot place ${remaining} more nodes within maxDepth ${spec.maxDepth}`,
        )
      }
    }
    const parent = spec.order === 'bfs' ? frontier.shift() : frontier.pop()
    if (parent === undefined) continue
    const record = records.get(parent)
    if (record === undefined) continue
    if (record.depth >= spec.maxDepth) continue

    const drawn = spec.fanOut(rng, record.depth)
    const wanted = widening ? Math.max(1, drawn) : drawn
    const k = Math.min(wanted, remaining)
    for (let i = 0; i < k; i++) {
      const child = create(parent, record.depth + 1)
      record.children.push(child)
      frontier.push(child)
    }
    remaining -= k
  }

  return { roots, records, order }
}

export function generate(shape: ShapeName, opts: CorpusOptions): MapTreeStore {
  const { roots, records, order } = buildStructure(shape, opts)
  const unloadedFraction = opts.unloadedFraction ?? 0
  const maxHiddenSubtree = opts.maxHiddenSubtree ?? 8

  // Subtree sizes, accumulated in reverse creation order. A child is always
  // created after its parent, so one reverse pass is enough.
  const subtreeSize = new Map<NodeId, number>()
  for (let i = order.length - 1; i >= 0; i--) {
    const id = order[i]
    if (id === undefined) continue
    const record = records.get(id)
    if (record === undefined) continue
    let size = 1
    for (const child of record.children) size += subtreeSize.get(child) ?? 1
    subtreeSize.set(id, size)
  }
  // A separate stream from the structure rng, so changing the unloaded fraction
  // does not change the tree's shape.
  const rng = mulberry32(opts.seed ^ 0x5f5f5f5f)

  // Sibling slots, assigned in one pass. The previous version called
  // siblings.indexOf(id) for every node, which is O(n^2) on mega-sibling where a
  // single parent owns every other node, and dominated corpus build time: 6.6s
  // to generate 100,000 nodes, against 25ms for the structure itself.
  const slotOf = new Map<NodeId, number>()
  for (let k = 0; k < roots.length; k++) {
    const rootId = roots[k]
    if (rootId !== undefined) slotOf.set(rootId, k)
  }
  for (const [, parentRecord] of records) {
    for (let k = 0; k < parentRecord.children.length; k++) {
      const child = parentRecord.children[k]
      if (child !== undefined) slotOf.set(child, k)
    }
  }

  const nodes = new Map<NodeId, NodeRecord>()
  for (const id of order) {
    const record = records.get(id)
    if (record === undefined) continue
    const slot = slotOf.get(id) ?? 0
    const eligible = record.children.length > 0 && (subtreeSize.get(id) ?? 1) <= maxHiddenSubtree
    const unloaded = eligible && rng() < unloadedFraction
    nodes.set(id, {
      id,
      parentId: record.parentId,
      orderKey: orderKey(String(slot).padStart(10, '0')),
      childIds: unloaded ? undefined : record.children,
      childCount: unloaded ? estimated(record.children.length) : exact(record.children.length),
    })
  }
  return new MapTreeStore(roots, nodes)
}

export interface TopologyReport {
  readonly roots: number
  readonly nodes: number
  readonly reachable: number
  readonly maxDepth: number
  readonly maxFanOut: number
  readonly declaredMaxDepth: number
}

/**
 * Checks that a generated corpus is the shape it claims to be.
 *
 * This exists because two corpus defects reached committed benchmark results
 * before anyone noticed: deep-narrow at 1M was reduced to a 32-row tree by the
 * unloaded fraction, and shallow-wide at 1M silently became 437,659 roots. Both
 * produced plausible-looking numbers for a corpus nobody intended.
 */
export function inspectTopology(store: MapTreeStore, shape: ShapeName): TopologyReport {
  let reachable = 0
  let maxDepth = 0
  let maxFanOut = 0
  const stack: { id: NodeId; depth: number }[] = store.roots.map((id) => ({ id, depth: 0 }))
  while (stack.length > 0) {
    const entry = stack.pop()
    if (entry === undefined) break
    reachable += 1
    if (entry.depth > maxDepth) maxDepth = entry.depth
    const children = store.get(entry.id)?.childIds ?? []
    if (children.length > maxFanOut) maxFanOut = children.length
    for (const child of children) stack.push({ id: child, depth: entry.depth + 1 })
  }
  return {
    roots: store.roots.length,
    nodes: store.size,
    reachable,
    maxDepth,
    maxFanOut,
    declaredMaxDepth: SPECS[shape].maxDepth,
  }
}

/** Every node id in the corpus, in creation order. Deterministic. */
export function allIds(store: MapTreeStore): NodeId[] {
  return [...store.entries()].map(([id]) => id)
}
