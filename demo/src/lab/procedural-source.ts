import {
  assertValidRange,
  nodeId,
  type HierarchySource,
  type LoadChildrenRequest,
  type LoadChildrenResult,
  type NodeId,
  type SourceNode,
} from '@understory/core'
import type { ShapeName } from '@understory/bench/corpus'

/**
 * A `HierarchySource` over a hierarchy that is never built.
 *
 * The seeded corpus generators in `bench/src/corpus.ts` are the right thing to
 * measure against and the wrong thing to put in a browser: they materialise every
 * node, and past roughly 200,000 they become superlinear. Generating `balanced` at
 * one million nodes took 2,046 seconds during the M1 benchmark run, which is a
 * fine cost for an overnight measurement and not one a demo can pay.
 *
 * So the large scales are served by computing children from the requested id
 * instead of looking them up. A node's id is its path, `0.3.17` being the
 * eighteenth child of the fourth child of the root, so a child list is a function
 * of the parent's id and depth and needs no storage at all. Same request, same
 * answer, which is the only property `HierarchySource` asks for.
 *
 * This is not a shortcut around the architecture, it is the architecture's own
 * claim taken literally: the engine never holds the tree, so a source is free to
 * have no tree to hold. The cost is that there is no `MapTreeStore` to check the
 * invariants against, which is why the laboratory reports invariant status as
 * unavailable at these scales rather than pretending to have verified something.
 */

export interface ProceduralShape {
  readonly maxDepth: number
  /** Children of a node at this depth. `hash` is stable per node id, in [0, 1). */
  readonly fanOut: (depth: number, hash: number) => number
  /** Nominal node count, so the UI can state a size without counting. */
  readonly nominalSize: (target: number) => number
}

const fnv = (input: string): number => {
  let h = 0x811c9dc5
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return (h >>> 8) / 0x0100_0000
}

/**
 * Depth-uniform fan-out sized so the tree holds roughly `target` nodes.
 *
 * Solving `(f^(d+1) - 1) / (f - 1) = target` exactly would be false precision. The
 * fan-out is fixed per shape and the depth is chosen to reach the target, which
 * keeps the shape recognisably itself at every scale.
 */
const uniform = (fanOut: number, target: number): ProceduralShape => {
  const maxDepth = Math.max(
    1,
    Math.ceil(Math.log(target * (fanOut - 1) + 1) / Math.log(fanOut)) - 1,
  )
  return {
    maxDepth,
    fanOut: (depth) => (depth < maxDepth ? fanOut : 0),
    nominalSize: () => (fanOut ** (maxDepth + 1) - 1) / (fanOut - 1),
  }
}

export function proceduralShape(shape: ShapeName, target: number): ProceduralShape {
  switch (shape) {
    case 'deep-narrow':
      return uniform(2, target)
    case 'balanced':
      return uniform(10, target)
    case 'shallow-wide': {
      // Two levels, both wide, in the proportion the generator produces.
      const level1 = Math.max(2, Math.round(Math.sqrt(target / 120) * 12))
      const level2 = Math.max(2, Math.round(target / level1))
      return {
        maxDepth: 2,
        fanOut: (depth) => (depth === 0 ? level1 : depth === 1 ? level2 : 0),
        nominalSize: () => 1 + level1 + level1 * level2,
      }
    }
    case 'mega-sibling':
      // The root owns every other node and none of them owns anything. This is the
      // shape the M1 verdict turns on, so it is reproduced exactly rather than
      // approximated: one parent, and no second parent for eviction to choose.
      return {
        maxDepth: 1,
        fanOut: (depth) => (depth === 0 ? target - 1 : 0),
        nominalSize: () => target,
      }
    case 'sparse-unbalanced':
      // Three quarters of nodes are leaves and the rest are wide, which is what
      // makes this shape's coverage so uneven.
      return {
        maxDepth: 6,
        fanOut: (depth, hash) => {
          if (depth >= 6) return 0
          if (depth === 0) return 40
          return hash < 0.75 ? 0 : 1 + Math.floor(hash * 60)
        },
        nominalSize: (t) => t,
      }
  }
}

/** Depth of a path id such as `0.3.17`. The root is depth 0. */
const depthOf = (id: NodeId): number => {
  let depth = 0
  for (let i = 0; i < id.length; i++) if (id.charCodeAt(i) === 46) depth += 1
  return depth
}

export interface ProceduralSourceOptions {
  readonly shape: ShapeName
  readonly targetNodes: number
  readonly reportTotal: boolean
  readonly latencyMs: number
}

export class ProceduralSource implements HierarchySource {
  private readonly spec: ProceduralShape
  readonly nominalSize: number

  constructor(private readonly options: ProceduralSourceOptions) {
    this.spec = proceduralShape(options.shape, options.targetNodes)
    this.nominalSize = Math.round(this.spec.nominalSize(options.targetNodes))
  }

  private childCount(parentId: NodeId | null): number {
    if (parentId === null) return 1
    return Math.max(0, Math.floor(this.spec.fanOut(depthOf(parentId), fnv(parentId))))
  }

  loadChildren(request: LoadChildrenRequest): Promise<LoadChildrenResult> {
    assertValidRange(request)
    const { parentId, offset, limit } = request
    const count = this.childCount(parentId)
    const end = Math.min(count, offset + limit)

    const nodes: SourceNode[] = []
    for (let index = offset; index < end; index++) {
      const id = nodeId(parentId === null ? '0' : `${parentId}.${index}`)
      nodes.push({ id, hasChildren: this.childCount(id) > 0 })
    }
    const result: LoadChildrenResult = this.options.reportTotal
      ? { nodes, exhausted: end >= count, total: count }
      : { nodes, exhausted: end >= count }

    if (this.options.latencyMs <= 0) return Promise.resolve(result)
    return new Promise((resolve) => {
      // A real timer, unlike the benchmark's virtual clock. The laboratory is for
      // watching the engine behave under latency, and a simulated clock would
      // deliver every page in the same frame and show nothing.
      setTimeout(() => resolve(result), this.options.latencyMs)
    })
  }
}
