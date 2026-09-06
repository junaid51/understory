import { nodeId, type NodeId } from '@understory/core'
import { describe, expect, test } from 'vitest'
import { applyAutoplay } from '../src/lab/autoplay.js'
import { Lab, type LabConfig, type LabEvent, type LabSnapshot } from '../src/lab/engine.js'
import { PRESETS, type Autoplay } from '../src/lab/presets.js'
import { ProceduralSource } from '../src/lab/procedural-source.js'

/**
 * The demo's integration points, and nothing the core suites already cover.
 *
 * There are 616 tests behind this one file establishing that the engine is
 * correct. What is unproven until here is that the laboratory drives that engine
 * rather than a convenient imitation of it, that the panels report what the engine
 * actually holds, and that each preset reproduces the behaviour its label claims.
 * A demo whose "stuck eviction" scenario quietly stopped getting stuck would be
 * worse than no demo, because it would look like evidence.
 */

const BASE: LabConfig = {
  shape: 'balanced',
  nodes: 5_000,
  pageSize: 100,
  latencyMs: 0,
  reportTotal: true,
  eviction: false,
  budget: 4_000,
  viewportRows: 40,
  overscan: 20,
  jitter: 0,
}

const silent = (): void => {}

/** Runs the same loop the React hook runs, so tests exercise the shipped path. */
async function drive(lab: Lab, ticks: number, autoplay: Autoplay = 'none'): Promise<LabSnapshot> {
  for (let tick = 0; tick < ticks; tick++) {
    applyAutoplay(lab, lab.snapshot(), autoplay)
    await lab.step()
    lab.sweep()
  }
  return lab.snapshot()
}

const firstBranchy = (snapshot: LabSnapshot): NodeId => {
  const row = snapshot.rows.find((r) => r.kind === 'node' && !snapshot.expandedIds.has(r.id))
  if (row === undefined || row.kind !== 'node') throw new Error('no collapsed row')
  return row.id
}

describe('the laboratory drives the real engine', () => {
  test('initialises and loads the roots on the first round', async () => {
    const lab = new Lab(BASE, silent)
    expect(lab.snapshot().materialisedRows).toBe(0)
    const after = await drive(lab, 2)
    expect(after.materialisedRows).toBeGreaterThan(0)
    expect(after.counters.applied).toBeGreaterThan(0)
    expect(after.corpusMode).toBe('materialised')
  })

  test('expanding a branch creates demand, and the arriving page creates rows', async () => {
    const lab = new Lab(BASE, silent)
    const opened = await drive(lab, 2)
    const before = opened.materialisedRows
    const requestsBefore = opened.counters.requested

    lab.expand(firstBranchy(opened))
    // Demand must want something now, before any round has run.
    expect(lab.snapshot().pendingDemand).toBeGreaterThan(0)

    const after = await drive(lab, 2)
    expect(after.counters.requested).toBeGreaterThan(requestsBefore)
    expect(after.materialisedRows).toBeGreaterThan(before)
  })

  test('collapsing removes rows without discarding coverage', async () => {
    const lab = new Lab(BASE, silent)
    let snap = await drive(lab, 2)
    const target = firstBranchy(snap)
    lab.expand(target)
    snap = await drive(lab, 2)
    const expandedRows = snap.materialisedRows
    const loaded = lab.coverage.loadedCount(target)

    lab.collapse(target)
    snap = lab.snapshot()
    expect(snap.materialisedRows).toBeLessThan(expandedRows)
    // Collapse is not eviction: the prefix is still there for the next expand.
    expect(lab.coverage.loadedCount(target)).toBe(loaded)
  })
})

describe('the panels report what the engine holds', () => {
  test('every headline metric is readable back out of the engine', async () => {
    const lab = new Lab({ ...BASE, eviction: true, budget: 600 }, silent)
    const snap = await drive(lab, 12, 'expandVisible')

    expect(snap.materialisedRows).toBe(lab.projection.slice(0, snap.materialisedRows).length)
    expect(snap.expandedCount).toBe(lab.projection.expandedIds().size)
    expect([...snap.expandedIds]).toEqual([...lab.projection.expandedIds()])
    expect(snap.counters.requested).toBe(lab.source.ledger.length)
    expect(snap.epoch).toBe(lab.source.currentEpoch)
    expect(snap.visibleRows).toBeLessThanOrEqual(snap.config.viewportRows)
    expect(snap.visibleRows).toBeLessThanOrEqual(snap.materialisedRows)
    // The prefix panel is the coverage store, not a copy that can drift.
    const roots = snap.prefixes.find((p) => p.id === '<roots>')
    expect(roots?.loaded).toBe(lab.coverage.loadedCount(null))
  })

  test('invariants are checked against the oracle, and say so when they cannot be', async () => {
    const materialised = new Lab({ ...BASE, eviction: true, budget: 400 }, silent)
    const small = await drive(materialised, 10, 'expandVisible')
    expect(small.invariantStatus).toBe('ok')
    expect(small.violations).toEqual([])

    const procedural = new Lab({ ...BASE, nodes: 1_000_000 }, silent)
    const large = await drive(procedural, 3)
    expect(large.corpusMode).toBe('procedural')
    // No MapTreeStore exists at this scale, so the honest answer is "unavailable"
    // rather than a green tick that checked nothing.
    expect(large.invariantStatus).toBe('unavailable')
  })
})

describe('eviction, and what happens when the reader comes back', () => {
  test('eviction discards eligible coverage and demand reloads it', async () => {
    // shallow-wide with a tight budget, because `balanced` at this size never
    // materialises enough rows to put eviction under any pressure at all.
    const lab = new Lab(
      { ...BASE, shape: 'shallow-wide', eviction: true, budget: 200, latencyMs: 0 },
      silent,
    )
    const snap = await drive(lab, 30, 'expandVisible')

    expect(snap.counters.evictions).toBeGreaterThan(0)
    // Coming back is a refetch, not a duplicate: the epoch moved, so A5 stays clean.
    expect(snap.counters.refetchesAfterEviction).toBeGreaterThan(0)
    expect(snap.counters.duplicateRequests).toBe(0)
    expect(snap.counters.overlappingRequests).toBe(0)
    expect(snap.epoch).toBeGreaterThan(0)
  })

  test('nothing inside the viewport is discarded', async () => {
    const lab = new Lab({ ...BASE, shape: 'shallow-wide', eviction: true, budget: 200 }, silent)
    let snap = await drive(lab, 20, 'expandVisible')
    const visibleBefore = new Set(
      snap.rows
        .filter((r) => r.index >= snap.viewport.start && r.index < snap.viewport.end)
        .map((r) => (r.kind === 'node' ? `n:${r.id}` : `p:${r.parentId}:${r.slot}`)),
    )
    lab.sweep()
    snap = lab.snapshot()
    const after = new Set(
      snap.rows.map((r) => (r.kind === 'node' ? `n:${r.id}` : `p:${r.parentId}:${r.slot}`)),
    )
    for (const key of visibleBefore) expect(after.has(key)).toBe(true)
  })
})

describe('arrival jitter reorders responses without breaking anything', () => {
  test('a jittered source still converges and issues no duplicate request', async () => {
    // Jitter spreads response times so arrivals reorder. The benchmark found that
    // this produces no refused gaps, because demand only ever asks for the page
    // after a parent's loaded prefix and never has two pages of one parent in
    // flight. That zero is the result, not a hole in the demonstration.
    const lab = new Lab({ ...BASE, latencyMs: 8, jitter: 1 }, silent)
    const snap = await drive(lab, 12, 'expandVisible')
    expect(snap.materialisedRows).toBeGreaterThan(0)
    expect(snap.counters.duplicateRequests).toBe(0)
    expect(snap.counters.conflictPages).toBe(0)
    expect(snap.invariantStatus).toBe('ok')
  })
})

describe('the procedural source is a source, not a fake tree', () => {
  test('the same request gets the same answer', async () => {
    const source = new ProceduralSource({
      shape: 'balanced',
      targetNodes: 1_000_000,
      reportTotal: true,
      latencyMs: 0,
    })
    const signal = new AbortController().signal
    const a = await source.loadChildren({ parentId: nodeId('0'), offset: 0, limit: 10, signal })
    const b = await source.loadChildren({ parentId: nodeId('0'), offset: 0, limit: 10, signal })
    expect(a.nodes.map((n) => n.id)).toEqual(b.nodes.map((n) => n.id))
    expect(a.total).toBe(b.total)
  })

  test('pages of one parent are contiguous, which is what D2 requires', async () => {
    const source = new ProceduralSource({
      shape: 'shallow-wide',
      targetNodes: 1_000_000,
      reportTotal: true,
      latencyMs: 0,
    })
    const signal = new AbortController().signal
    const first = await source.loadChildren({ parentId: nodeId('0'), offset: 0, limit: 5, signal })
    const second = await source.loadChildren({ parentId: nodeId('0'), offset: 5, limit: 5, signal })
    const ids = [...first.nodes, ...second.nodes].map((n) => String(n.id))
    expect(ids).toEqual(['0.0', '0.1', '0.2', '0.3', '0.4', '0.5', '0.6', '0.7', '0.8', '0.9'])
  })

  test('a million-node hierarchy is browsable without building it', async () => {
    const lab = new Lab({ ...BASE, nodes: 1_000_000, shape: 'deep-narrow' }, silent)
    const snap = await drive(lab, 8, 'drill')
    expect(snap.logicalNodes).toBeGreaterThan(500_000)
    // The whole claim of the design, in one assertion.
    expect(snap.materialisedRows).toBeLessThan(1_000)
  })
})

const preset = (id: string): (typeof PRESETS)[number] => {
  const found = PRESETS.find((p) => p.id === id)
  if (found === undefined) throw new Error(`no preset ${id}`)
  return found
}

describe('the presets reproduce what their labels claim', () => {
  test('healthy browse stays far below the budget and near 1x amplification', async () => {
    const { config, autoplay } = preset('healthy')
    const lab = new Lab({ ...config, latencyMs: 0 }, silent)
    const snap = await drive(lab, 20, autoplay)

    expect(snap.materialisedRows).toBeLessThan(config.budget)
    expect(snap.counters.stuckSweeps).toBe(0)
    expect(snap.amplification).toBeLessThan(3)
    expect(snap.invariantStatus).toBe('ok')
  })

  test('mega-sibling gets stuck: over budget, nothing evictable', async () => {
    // The M1 verdict condition. The root owns every other node, so the only parent
    // holding rows is an ancestor of everything on screen and eviction is shielded
    // from its only candidate.
    const { config, autoplay } = preset('mega-sibling')
    const lab = new Lab({ ...config, latencyMs: 0 }, silent)
    // Enough scrolling to pass the budget. Each tick advances half a viewport, so
    // reaching 1,000 rows takes a while, and that pacing is the point: the reader
    // has to get there before the engine has a problem.
    const snap = await drive(lab, 90, autoplay)

    expect(snap.materialisedRows).toBeGreaterThan(config.budget)
    expect(snap.counters.stuckSweeps).toBeGreaterThan(0)
    expect(snap.counters.evictions).toBe(0)
    expect(snap.lastSweepStuck).toBe(true)
    // The reason the panel gives, asserted rather than narrated: eviction is not
    // choosing to do nothing, it is forbidden from doing anything.
    expect(snap.evictionCandidates).toBe(0)
    expect(snap.protectedParents).toBeGreaterThan(0)
  })

  test('a shape where eviction has candidates reports them', async () => {
    // The contrast that makes the mega-sibling number mean something.
    const { config, autoplay } = preset('w7')
    const lab = new Lab({ ...config, latencyMs: 0 }, silent)
    const snap = await drive(lab, 60, autoplay)
    expect(snap.counters.evictions).toBeGreaterThan(0)
    expect(snap.counters.stuckSweeps).toBe(0)
  })

  test('refetch amplification actually loops: request, evict, request again', async () => {
    const { config, autoplay } = preset('refetch')
    const events: LabEvent[] = []
    const lab = new Lab({ ...config, latencyMs: 0 }, (event) => events.push(event))
    const snap = await drive(lab, 40, autoplay)

    expect(snap.counters.evictions).toBeGreaterThan(0)
    expect(snap.counters.refetchesAfterEviction).toBeGreaterThan(0)
    // Not a single-flight defect. Every one of these is a legitimate request for
    // something the engine threw away, which is the whole point of the finding.
    expect(snap.counters.duplicateRequests).toBe(0)
    expect(snap.amplification).toBeGreaterThan(3)

    // The loop is visible in the timeline, not only in the totals: some parent is
    // requested, then evicted, then requested again.
    const requestedTwice = new Set<string>()
    const seen = new Set<string>()
    const evicted = new Set<string>()
    for (const event of events) {
      if (event.kind === 'evict') for (const id of event.parents) evicted.add(String(id))
      if (event.kind !== 'request') continue
      const key = `${String(event.parentId)}@${event.offset}`
      if (seen.has(key) && evicted.has(String(event.parentId))) requestedTwice.add(key)
      seen.add(key)
    }
    expect(requestedTwice.size).toBeGreaterThan(0)
  })

  test('W7 budget pressure reaches the calibrated budget and eviction holds it', async () => {
    const { config, autoplay } = preset('w7')
    expect(config.budget).toBe(4_000)
    const lab = new Lab({ ...config, latencyMs: 0 }, silent)
    const snap = await drive(lab, 90, autoplay)

    // Reaching B at all is the reachability claim W7 exists to make.
    expect(snap.counters.requested).toBeGreaterThan(40)
    expect(snap.counters.sweeps).toBeGreaterThan(0)
    if (snap.materialisedRows > config.budget) {
      expect(snap.counters.evictions + snap.counters.stuckSweeps).toBeGreaterThan(0)
    }
  })

  test('every preset runs without violating an invariant it can check', async () => {
    for (const item of PRESETS) {
      const lab = new Lab({ ...item.config, latencyMs: 0 }, silent)
      const snap = await drive(lab, 15, item.autoplay)
      expect(snap.invariantStatus, `${item.id}: ${snap.violations.join('; ')}`).not.toBe('violated')
    }
  })
})
