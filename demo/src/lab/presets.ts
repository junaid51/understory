import type { LabConfig } from './engine.js'

/**
 * Autoplay behaviours, so a scenario reproduces without a reader knowing which
 * twelve things to click.
 *
 * Each is a rule applied once per tick, never a recorded macro: the laboratory has
 * to keep working when the configuration changes underneath it.
 */
export type Autoplay = 'none' | 'expandVisible' | 'drill' | 'scrollDown' | 'accumulate'

export interface Preset {
  readonly id: string
  readonly name: string
  /** What to watch for, in one line, for someone reading over a shoulder. */
  readonly watchFor: string
  readonly detail: string
  readonly config: LabConfig
  readonly autoplay: Autoplay
}

const BASE: LabConfig = {
  shape: 'balanced',
  nodes: 50_000,
  pageSize: 100,
  latencyMs: 60,
  reportTotal: true,
  eviction: true,
  budget: 4_000,
  viewportRows: 40,
  overscan: 20,
  jitter: 0,
}

/**
 * The calibrated budget, from `bench/thresholds.m1.json`.
 *
 * Two presets deliberately run below it. Reaching 4,000 rows takes a few thousand
 * rows of scrolling, which is the right cost for an overnight benchmark and the
 * wrong one for a demonstration someone is watching. Where a preset lowers the
 * budget it says so, and the number in the threshold file is not touched.
 */
export const CALIBRATED_BUDGET = 4_000

export const PRESETS: readonly Preset[] = [
  {
    id: 'healthy',
    name: 'Healthy browse',
    watchFor: 'Amplification stays near 1x. Eviction never has to run.',
    detail:
      'A reader opening branches and scrolling at reading pace, which is the workload M1 was designed for. Materialized rows stay two orders of magnitude below the budget, so the bound is never tested and the engine does exactly what it should. This is the control, not evidence: everything after it is a departure from here, and the measurement failed on the departures.',
    config: { ...BASE, shape: 'balanced', nodes: 50_000, budget: CALIBRATED_BUDGET },
    autoplay: 'expandVisible',
  },
  {
    id: 'deep-narrow',
    name: 'Deep narrow',
    watchFor: 'A million logical nodes, a few hundred materialized rows.',
    detail:
      'Drilling down a binary tree of a million nodes. The gap between the logical size and the materialized row count is the entire point of the design, and it is largest here. Note that the count stays atLeast rather than exact: under D2 the engine will not claim a total it has not been told.',
    config: {
      ...BASE,
      shape: 'deep-narrow',
      nodes: 1_000_000,
      latencyMs: 40,
      budget: CALIBRATED_BUDGET,
    },
    autoplay: 'drill',
  },
  {
    id: 'mega-sibling',
    name: 'Mega sibling, stuck eviction',
    watchFor: 'Rows pass the budget and eviction reports STUCK, having discarded nothing.',
    detail:
      'The topology the M1 verdict turns on. The root owns every other node, so there is exactly one parent holding rows, and any row on screen makes that parent an ancestor. The protected window therefore shields the only candidate eviction has. Rows go over budget and stay there, not because the policy is badly tuned but because there is nothing it is permitted to take. This is pre-registered REVERSE condition 2, reproduced live. Budget lowered from 4,000 so it arrives in seconds rather than after 4,000 rows of scrolling.',
    config: {
      ...BASE,
      shape: 'mega-sibling',
      nodes: 1_000_000,
      latencyMs: 20,
      budget: 1_000,
      eviction: true,
    },
    autoplay: 'scrollDown',
  },
  {
    id: 'refetch',
    name: 'Refetch amplification',
    watchFor: 'request, load, evict, request again. Watch the refetch counter climb.',
    detail:
      'The strongest finding of M1, and it needs no unusual input to provoke. Expanded parents sit outside the viewport. Demand must fetch their first page, because under D2 expanding a node changes the index space and the engine cannot know by how much without loading it. They hold no visible row, so eviction discards them. They are still expanded, so demand asks again on the very next round. Neither layer is wrong by its own definition: demand fetches what the state requires, eviction discards what nothing is looking at. The defect is that "not currently visible" and "not needed again" are different questions and the design only has the first one. Budget lowered to make the loop visible immediately.',
    config: {
      ...BASE,
      shape: 'shallow-wide',
      nodes: 50_000,
      latencyMs: 30,
      budget: 400,
      eviction: true,
    },
    autoplay: 'expandVisible',
  },
  {
    id: 'w7',
    name: 'W7 budget pressure',
    watchFor: 'Rows climb to 4,000 and eviction holds them there, on this shape only.',
    detail:
      'The benchmark workload that exists because the other six never approached the budget: keep expanding, keep scrolling to the end, never collapse. This one runs at the calibrated B of 4,000. Eviction has candidates on this shape and does hold the bound here, which is exactly why it is worth opening next to the mega-sibling preset, where it cannot. A1 failed in the measurement: holding on one shape is not the bound being guaranteed. Note that amplification is high here too, for the same reason as the refetch preset.',
    config: {
      ...BASE,
      shape: 'shallow-wide',
      nodes: 200_000,
      latencyMs: 15,
      budget: CALIBRATED_BUDGET,
      eviction: true,
    },
    autoplay: 'accumulate',
  },
]

export const DEFAULT_PRESET = PRESETS[0] as Preset
