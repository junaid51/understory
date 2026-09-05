import { execSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { cpus, totalmem } from 'node:os'
import {
  MaterializedProjection,
  approximate,
  exact,
  type NodeId,
  type NodeRecord,
} from '@understory/core'
import type { MapTreeStore } from '@understory/core'
import { SHAPES, allIds, generate, inspectTopology, type ShapeName } from './corpus.js'
import { controlWorkload, measure, retainedHeap } from './harness.js'
import { MutableTreeStore } from './mutable-store.js'

/**
 * M1 commit 2: projection calibration.
 *
 * Answers one question and commits no threshold:
 *
 *   At what materialized row count does the existing materialized projection stop
 *   satisfying a frame-relevant structural-change budget, across realistic shapes?
 *
 * The independent variable is MATERIALIZED ROWS, not corpus size. That distinction
 * is the whole point: M0's mistake was letting corpus size and visible rows be the
 * same number because every scenario ran expandAll.
 *
 * Two methods are run for every shape and every sweep point, because they differ
 * in exactly one way and the difference is worth knowing.
 *
 *   partial  A fixed one-million-node store with only enough nodes expanded to
 *            reach the target row count. This is the state M1 actually produces:
 *            a large store, a small visible set.
 *
 *   sized    A store containing exactly the target number of nodes, fully
 *            expanded. Same visible rows, far smaller store.
 *
 * If the two disagree at equal row counts, projection cost depends on something
 * other than visible rows, most plausibly memory locality, and that is a finding
 * rather than noise. Running only `sized` would have reintroduced expandAll as a
 * representative workload; running only `partial` cannot reach intermediate points
 * on mega-sibling, whose root owns every other node.
 */

const SWEEP = [
  1_000, 2_000, 5_000, 8_000, 10_000, 12_500, 15_000, 20_000, 25_000, 30_000, 35_000, 40_000,
  50_000, 60_000, 75_000, 100_000, 150_000, 200_000,
]

const SWEEP_POINTS = process.env['UNDERSTORY_SWEEP']
  ? process.env['UNDERSTORY_SWEEP'].split(',').map((v) => Number.parseInt(v, 10))
  : SWEEP
const SHAPE_LIST =
  (process.env['UNDERSTORY_SHAPES']?.split(',') as ShapeName[] | undefined) ?? SHAPES
const STORE_NODES = Number(process.env['UNDERSTORY_STORE'] ?? '1000000')
const REPEATS = 3
const SAMPLES = 60
const SEED = 42

type Method = 'partial' | 'sized'

interface RepStats {
  readonly p50Ms: number
  readonly p95Ms: number
  readonly p99Ms: number
  readonly maxMs: number
  readonly meanMs: number
}

interface Point {
  readonly shape: ShapeName
  readonly method: Method
  readonly targetRows: number
  readonly actualRows: number
  readonly storeNodes: number
  readonly expandedNodes: number
  readonly reachable: boolean
  readonly topology: {
    roots: number
    reachable: number
    maxDepth: number
    declaredMaxDepth: number
  }
  readonly toggle: readonly RepStats[]
  readonly invalidate: readonly RepStats[]
  readonly medianTogglep99Ms: number
  readonly medianInvalidatep99Ms: number
  readonly nsPerRow: number
  readonly heapBytes: number
}

const median = (values: readonly number[]): number => {
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  if (sorted.length === 0) return Number.NaN
  if (sorted.length % 2 === 1) return sorted[middle] ?? Number.NaN
  return ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2
}

/**
 * Chooses a set of nodes to expand so the projection materialises about
 * `target` rows, computed analytically rather than by expanding and re-counting.
 *
 * Creation order places every parent before its children, so expanding branchy
 * nodes in that order keeps every node encountered already visible, and each
 * expansion adds exactly its child count. Re-counting through the projection
 * after every expansion would be O(rows) per step and quadratic overall.
 */
function expandToTarget(
  store: MapTreeStore,
  order: readonly NodeId[],
  target: number,
): { expanded: NodeId[]; rows: number } {
  let rows = store.roots.length
  const expanded: NodeId[] = []
  for (const id of order) {
    if (rows >= target) break
    const children = store.get(id)?.childIds
    if (children === undefined || children.length === 0) continue
    expanded.push(id)
    rows += children.length
  }
  return { expanded, rows }
}

/** The expanded node with the fewest children: toggling it keeps the row count
 *  near-constant, so each sample measures rebuild cost at a fixed size rather
 *  than the cost of a large structural delta. */
function smallestExpanded(store: MapTreeStore, expanded: readonly NodeId[]): NodeId | undefined {
  let best: NodeId | undefined
  let bestCount = Number.POSITIVE_INFINITY
  for (const id of expanded) {
    const count = store.get(id)?.childIds?.length ?? 0
    if (count > 0 && count < bestCount) {
      bestCount = count
      best = id
    }
  }
  return best
}

/** Stores are cached per (shape, size): the partial method reuses one large store
 *  across every sweep point, and regenerating a million nodes eighteen times per
 *  shape would cost more than the measurements do. */
const storeCache = new Map<string, MapTreeStore>()
const storeFor = (shape: ShapeName, nodes: number): MapTreeStore => {
  const key = `${shape}:${nodes}`
  const cached = storeCache.get(key)
  if (cached !== undefined) return cached
  const built = generate(shape, { nodes, seed: SEED, unloadedFraction: 0 })
  storeCache.set(key, built)
  return built
}

function runPoint(shape: ShapeName, method: Method, target: number): Point | undefined {
  const storeNodes = method === 'partial' ? STORE_NODES : target
  const store = storeFor(shape, storeNodes)

  // Topology assertions, so calibration cannot silently repeat the corpus defects
  // that invalidated two earlier benchmark runs.
  const topology = inspectTopology(store, shape)
  if (topology.roots !== 1)
    throw new Error(`${shape}@${storeNodes}: ${topology.roots} roots, expected 1`)
  if (topology.reachable !== storeNodes) {
    throw new Error(`${shape}@${storeNodes}: ${topology.reachable} reachable of ${storeNodes}`)
  }
  if (topology.maxDepth > topology.declaredMaxDepth) {
    throw new Error(
      `${shape}@${storeNodes}: depth ${topology.maxDepth} exceeds ${topology.declaredMaxDepth}`,
    )
  }

  const order = allIds(store)
  const { expanded, rows } =
    method === 'sized'
      ? {
          expanded: order.filter((id) => (store.get(id)?.childIds?.length ?? 0) > 0),
          rows: storeNodes,
        }
      : expandToTarget(store, order, target)

  // Row counts are not always reachable exactly: mega-sibling's root owns every
  // other node, so its only reachable points are 1 and the whole corpus.
  const tolerance = Math.max(target * 0.25, 500)
  const reachable = Math.abs(rows - target) <= tolerance
  if (!reachable) return undefined

  const before = retainedHeap()
  const probe = new MaterializedProjection(store, expanded)
  const actualRows = approximate(probe.count())
  const heapBytes = retainedHeap() - before
  if (actualRows !== rows) {
    throw new Error(
      `${shape}/${method}@${target}: predicted ${rows} rows, projection reports ${actualRows}`,
    )
  }

  const target2 = smallestExpanded(store, expanded)
  const toggle: RepStats[] = []
  const invalidate: RepStats[] = []

  for (let rep = 0; rep < REPEATS; rep++) {
    const projection = new MaterializedProjection(store, expanded)
    projection.count()
    const stats = measure((i) => {
      if (target2 !== undefined) {
        if (i % 2 === 0) projection.collapse(target2)
        else projection.expand(target2)
      }
      approximate(projection.count())
      projection.slice(0, 100)
    }, SAMPLES)
    toggle.push({
      p50Ms: stats.p50,
      p95Ms: stats.p95,
      p99Ms: stats.p99,
      maxMs: stats.max,
      meanMs: stats.mean,
    })

    const mutable = MutableTreeStore.from(store)
    const inv = new MaterializedProjection(mutable, expanded)
    inv.count()
    const parentId = target2
    const original = parentId === undefined ? undefined : mutable.get(parentId)
    const invStats = measure((i) => {
      if (parentId !== undefined && original?.childIds !== undefined) {
        const first = original.childIds[0]
        const children =
          i % 2 === 0 && first !== undefined
            ? [...original.childIds, first]
            : [...original.childIds]
        const record: NodeRecord = {
          ...original,
          childIds: children,
          childCount: exact(children.length),
        }
        mutable.set(record)
        inv.invalidate(parentId)
      }
      approximate(inv.count())
      inv.slice(0, 100)
    }, SAMPLES)
    invalidate.push({
      p50Ms: invStats.p50,
      p95Ms: invStats.p95,
      p99Ms: invStats.p99,
      maxMs: invStats.max,
      meanMs: invStats.mean,
    })
  }

  const medianToggle = median(toggle.map((t) => t.p99Ms))
  return {
    shape,
    method,
    targetRows: target,
    actualRows,
    storeNodes,
    expandedNodes: expanded.length,
    reachable,
    topology: {
      roots: topology.roots,
      reachable: topology.reachable,
      maxDepth: topology.maxDepth,
      declaredMaxDepth: topology.declaredMaxDepth,
    },
    toggle,
    invalidate,
    medianTogglep99Ms: medianToggle,
    medianInvalidatep99Ms: median(invalidate.map((t) => t.p99Ms)),
    nsPerRow: actualRows > 0 ? (medianToggle * 1_000_000) / actualRows : Number.NaN,
    heapBytes,
  }
}

function main(): void {
  const started = new Date().toISOString()
  const control = controlWorkload()
  process.stderr.write(`control workload ${control.toFixed(2)}ms\n`)
  const points: Point[] = []
  const skipped: { shape: ShapeName; method: Method; target: number }[] = []

  for (const shape of SHAPE_LIST) {
    for (const method of ['partial', 'sized'] as const) {
      for (const target of SWEEP_POINTS) {
        const point = runPoint(shape, method, target)
        if (point === undefined) {
          skipped.push({ shape, method, target })
          process.stderr.write(`  ${shape}/${method} @ ${target}: unreachable\n`)
          continue
        }
        points.push(point)
        process.stderr.write(
          `  ${shape.padEnd(18)} ${method.padEnd(8)} target=${String(target).padStart(7)} rows=${String(point.actualRows).padStart(7)} togglep99=${point.medianTogglep99Ms.toFixed(3)}ms\n`,
        )
      }
    }
    // Release this shape's stores before the next one; five one-million-node
    // stores held at once would dominate the heap measurement.
    storeCache.clear()
  }

  const isCi = process.env['CI'] === 'true'
  const result = {
    kind: 'calibration',
    question:
      'At what materialized row count does the materialized projection stop satisfying a frame-relevant structural-change budget, by shape?',
    note: 'No threshold is chosen or committed by this run. Budget B is derived in M1 commit 3.',
    commit: (() => {
      try {
        return execSync('git rev-parse --short HEAD', { encoding: 'utf8' }).trim()
      } catch {
        return 'unknown'
      }
    })(),
    started,
    finished: new Date().toISOString(),
    environment: {
      node: process.version,
      platform: `${process.platform}-${process.arch}`,
      cpu: isCi ? (cpus()[0]?.model ?? 'unknown') : 'local (model withheld)',
      cpuCount: cpus().length,
      totalMemoryBytes: totalmem(),
      ci: isCi,
    },
    controlWorkloadMs: control,
    method: {
      sweep: SWEEP,
      storeNodes: STORE_NODES,
      repeats: REPEATS,
      samplesPerRepeat: SAMPLES,
      seed: SEED,
    },
    points,
    skipped,
  }
  mkdirSync('bench/results', { recursive: true })
  const file = `bench/results/calibration-${isCi ? 'ci' : 'local'}-${started.slice(0, 10)}.json`
  writeFileSync(file, `${JSON.stringify(result, null, 2)}\n`)
  process.stderr.write(
    `\nwrote ${file}  (${points.length} points, ${skipped.length} unreachable)\n`,
  )
}

main()
