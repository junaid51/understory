import { requestKey, type NodeId } from '@understory/core'
import type {
  CoverageStore,
  HierarchySource,
  LoadChildrenRequest,
  LoadChildrenResult,
} from '@understory/core'
import type { RequestRecord } from '@understory/bench/m1'

/**
 * Records every request a source is asked for, so the laboratory can show the
 * ledger the M1 benchmark computes its amplification from.
 *
 * A decorator rather than a second source. `analyseLedger` in the benchmark reads
 * exactly this record type, so the demo's amplification, duplicate and refetch
 * counters are the benchmark's own, computed by the benchmark's own code over the
 * same structure. Reimplementing them here would produce a number that agrees with
 * the benchmark until the day it quietly stopped.
 *
 * `epoch` is the one field the source cannot know: it is a monotonic count of
 * eviction sweeps that discarded something, and the M1 runner bumps it for the
 * same reason this does. The coverage generation cannot stand in for it, because
 * evicting an ancestor deletes a parent's record outright and its replacement
 * starts again at generation zero, which makes an ordinary refetch look like a
 * duplicate request.
 */
export class RecordingSource implements HierarchySource {
  readonly ledger: RequestRecord[] = []

  private seq = 0
  private epoch = 0
  private pending = 0

  constructor(
    private readonly inner: HierarchySource,
    private readonly coverage: CoverageStore,
    private readonly onEvent: (event: LabRequestEvent) => void,
  ) {}

  /** Called after any sweep that discarded coverage. */
  evictionHappened(): void {
    this.epoch += 1
  }

  get currentEpoch(): number {
    return this.epoch
  }

  get inFlight(): number {
    return this.pending
  }

  loadChildren(request: LoadChildrenRequest): Promise<LoadChildrenResult> {
    const record: RequestRecord = {
      seq: this.seq++,
      key: requestKey(request),
      parentId: request.parentId,
      offset: request.offset,
      limit: request.limit,
      generation: this.coverage.generationOf(request.parentId),
      epoch: this.epoch,
      issuedAtMs: performance.now(),
      arrivesAtMs: 0,
    }
    this.ledger.push(record)
    this.pending += 1
    this.onEvent({
      kind: 'request',
      at: record.issuedAtMs,
      parentId: request.parentId,
      offset: request.offset,
      seq: record.seq,
      epoch: record.epoch,
    })

    return this.inner.loadChildren(request).then(
      (result) => {
        this.pending -= 1
        const arrived = performance.now()
        this.ledger[record.seq] = { ...record, arrivesAtMs: arrived }
        this.onEvent({
          kind: 'arrive',
          at: arrived,
          parentId: request.parentId,
          offset: request.offset,
          seq: record.seq,
          nodes: result.nodes.length,
          latencyMs: arrived - record.issuedAtMs,
        })
        return result
      },
      (error: unknown) => {
        this.pending -= 1
        throw error
      },
    )
  }
}

export type LabRequestEvent =
  | {
      kind: 'request'
      at: number
      parentId: NodeId | null
      offset: number
      seq: number
      epoch: number
    }
  | {
      kind: 'arrive'
      at: number
      parentId: NodeId | null
      offset: number
      seq: number
      nodes: number
      latencyMs: number
    }
