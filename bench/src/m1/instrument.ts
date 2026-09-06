import {
  InMemorySource,
  requestKey,
  type CoverageStore,
  type HierarchySource,
  type LoadChildrenRequest,
  type LoadChildrenResult,
  type MapTreeStore,
  type NodeId,
} from '@understory/core'

/** Responses delivered in arrival order, or perturbed within a window of three. */
export type ArrivalOrder = 'inOrder' | 'shuffled3'

export interface RequestRecord {
  readonly seq: number
  readonly key: string
  readonly parentId: NodeId | null
  readonly offset: number
  readonly limit: number
  /**
   * The coverage generation for this parent when the request was issued.
   *
   * Read inside the network rather than passed in, because `ViewportLoader` reads
   * it and calls the source in the same synchronous block, so the two values are
   * the same by construction.
   */
  readonly generation: number
  /**
   * How many eviction sweeps had discarded something when this request was issued.
   *
   * A5 needs to tell "the same page asked for twice" apart from "the page came
   * back after being thrown away", and the coverage generation cannot do it.
   * `invalidate` bumps a parent's generation, but evicting an *ancestor* deletes
   * the parent's record outright, and the record that replaces it starts again at
   * generation zero. On `sparse-unbalanced` that made 6,493 ordinary refetches look
   * like duplicate requests, which would have failed A5 for something that is not a
   * defect. A counter that only ever increases cannot be reused that way.
   */
  readonly epoch: number
  readonly issuedAtMs: number
  readonly arrivesAtMs: number
}

interface Queued {
  readonly record: RequestRecord
  readonly deliver: () => void
}

export interface SimulatedNetworkOptions {
  readonly latencyMs: number
  readonly reportTotal: boolean
  readonly seed: number
  /**
   * Arrival dispersion as a fraction of latency. Zero latency means zero jitter,
   * so the 0ms profile is exactly issue order.
   */
  readonly jitterFraction?: number
}

/**
 * A `HierarchySource` that answers correctly and arrives on a simulated clock.
 *
 * **Why not real timers.** Three latency profiles across the full matrix would
 * spend hours inside `setTimeout` measuring the timer rather than the engine, and
 * the result would not be reproducible. The quantity that actually matters is not
 * how long a response takes but *the order responses arrive in and how many are
 * outstanding at once*, and that is exactly what a virtual clock reproduces
 * deterministically.
 *
 * **Why jitter is not optional.** A first version advanced a uniform clock, and
 * every request in a round then arrived at `now + latency` in issue order. The
 * three latency profiles produced byte-identical state: the whole dimension was
 * vacuous and would have reported three passing columns that measured one thing.
 * Arrival is therefore `now + latency ± jitterFraction * latency`, seeded, so a
 * slower network really does reorder arrivals and a 0ms network really does not.
 * `deliveryOrderDiverged` records whether that actually happened in a given run,
 * so the claim is checked rather than assumed.
 */
export class SimulatedNetwork implements HierarchySource {
  private readonly inner: InMemorySource
  private readonly queue: Queued[] = []
  private readonly latencyMs: number
  private readonly jitterFraction: number
  private rng: number

  private clockMs = 0
  private seq = 0
  private epochCounter = 0
  private divergedFromIssueOrder = false

  /** Every request issued, in issue order. The evidence for A3, A4 and A5. */
  readonly ledger: RequestRecord[] = []

  constructor(
    truth: MapTreeStore,
    private readonly coverage: CoverageStore,
    options: SimulatedNetworkOptions,
  ) {
    this.inner = new InMemorySource(truth, {
      mode: 'immediate',
      reportTotal: options.reportTotal,
    })
    this.latencyMs = options.latencyMs
    this.jitterFraction = options.jitterFraction ?? 0.4
    this.rng = options.seed | 0
  }

  private nextRandom(): number {
    this.rng = (Math.imul(this.rng, 1664525) + 1013904223) | 0
    return (this.rng >>> 8) / 0x0100_0000
  }

  get virtualNowMs(): number {
    return this.clockMs
  }

  /** True when latency reordered at least one delivery away from issue order. */
  get deliveryOrderDiverged(): boolean {
    return this.divergedFromIssueOrder
  }

  get outstanding(): number {
    return this.queue.length
  }

  /** Called by the runner after any sweep that discarded coverage. */
  evictionHappened(): void {
    this.epochCounter += 1
  }

  loadChildren(request: LoadChildrenRequest): Promise<LoadChildrenResult> {
    const jitter =
      this.latencyMs === 0 ? 0 : this.latencyMs * this.jitterFraction * (this.nextRandom() * 2 - 1)
    const record: RequestRecord = {
      seq: this.seq++,
      key: requestKey(request),
      parentId: request.parentId,
      offset: request.offset,
      limit: request.limit,
      generation: this.coverage.generationOf(request.parentId),
      epoch: this.epochCounter,
      issuedAtMs: this.clockMs,
      arrivesAtMs: this.clockMs + this.latencyMs + jitter,
    }
    this.ledger.push(record)

    return new Promise<LoadChildrenResult>((resolve, reject) => {
      this.queue.push({
        record,
        deliver: () => {
          this.inner.loadChildren(request).then(resolve, reject)
        },
      })
    })
  }

  /**
   * Delivers everything outstanding, in arrival order, advancing the clock.
   *
   * Delivery is invoked in one synchronous pass, and every inner response takes the
   * same number of microtask hops, so resolution order is exactly invocation order.
   * That is what makes publication order, and therefore which pages are refused as
   * gaps, a property of the chosen ordering rather than of scheduler luck.
   */
  deliver(order: ArrivalOrder): number {
    if (this.queue.length === 0) return 0
    const batch = this.queue.splice(0, this.queue.length)
    batch.sort((a, b) =>
      a.record.arrivesAtMs === b.record.arrivesAtMs
        ? a.record.seq - b.record.seq
        : a.record.arrivesAtMs - b.record.arrivesAtMs,
    )
    if (order === 'shuffled3') {
      // A window of three, as §6 specifies: swap each element with one of the two
      // that follow it. Local reordering, not a full permutation.
      for (let i = 0; i + 1 < batch.length; i++) {
        const span = Math.min(3, batch.length - i)
        const j = i + Math.floor(this.nextRandom() * span)
        const a = batch[i]
        const b = batch[j]
        if (a !== undefined && b !== undefined && i !== j) {
          batch[i] = b
          batch[j] = a
        }
      }
    }
    let highestDelivered = -1
    for (const item of batch) {
      // Anything arriving behind a request issued later than it is a reordering.
      // Compared against the running maximum rather than against a position, which
      // a first version did and which silently assumed one batch per round.
      if (item.record.seq < highestDelivered) this.divergedFromIssueOrder = true
      highestDelivered = Math.max(highestDelivered, item.record.seq)
      this.clockMs = Math.max(this.clockMs, item.record.arrivesAtMs)
      item.deliver()
    }
    return batch.length
  }
}

export interface LedgerAnalysis {
  readonly requested: number
  /** Same parent, same generation, same range asked twice. A single-flight defect. */
  readonly duplicates: number
  /** Same parent, same generation, ranges that overlap without being identical. */
  readonly overlaps: number
  /**
   * Repeat requests across an eviction boundary. Not an A5 failure: the generation
   * changed, so it is a different question. Counted against amplification instead,
   * which is where §8 says the price of eviction belongs.
   */
  readonly refetchesAfterEviction: number
  readonly parentsRequested: number
}

/**
 * What the request ledger says about A5.
 *
 * A5 is scoped per eviction epoch on purpose. A page re-requested after its
 * coverage was thrown away is not the same question asked twice; treating it as one
 * would fail A5 by construction the moment eviction is switched on, and would fold
 * the cost of eviction into a correctness gate instead of into amplification, where
 * §8 explicitly puts it. With eviction disabled no epoch ever advances, so A5 there
 * is the strict form: zero repeated requests of any kind. The epoch-blind count is
 * reported separately as `refetchesAfterEviction`, so the scoping hides nothing.
 */
export function analyseLedger(ledger: readonly RequestRecord[]): LedgerAnalysis {
  const seenInGeneration = new Set<string>()
  const seenEver = new Set<string>()
  const rangesByParentGeneration = new Map<string, { offset: number; end: number }[]>()
  const parents = new Set<string>()

  let duplicates = 0
  let overlaps = 0
  let refetchesAfterEviction = 0

  for (const record of ledger) {
    const parentKey = record.parentId === null ? 'r:' : `n:${record.parentId}`
    parents.add(parentKey)
    const scoped = `${parentKey}@${record.epoch}:${record.offset}:${record.limit}`

    if (seenInGeneration.has(scoped)) duplicates += 1
    else if (seenEver.has(record.key)) refetchesAfterEviction += 1
    seenInGeneration.add(scoped)
    seenEver.add(record.key)

    const groupKey = `${parentKey}@${record.epoch}`
    const ranges = rangesByParentGeneration.get(groupKey) ?? []
    const end = record.offset + record.limit
    for (const range of ranges) {
      const identical = range.offset === record.offset && range.end === end
      if (!identical && record.offset < range.end && range.offset < end) overlaps += 1
    }
    ranges.push({ offset: record.offset, end })
    rangesByParentGeneration.set(groupKey, ranges)
  }

  return {
    requested: ledger.length,
    duplicates,
    overlaps,
    refetchesAfterEviction,
    parentsRequested: parents.size,
  }
}
