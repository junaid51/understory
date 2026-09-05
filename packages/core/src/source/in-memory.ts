import type { NodeId } from '../model/ids.js'
import type { MapTreeStore } from '../model/node.js'
import type {
  HierarchySource,
  LoadChildrenRequest,
  LoadChildrenResult,
  SourceNode,
} from './types.js'
import { assertValidRange, requestKey } from './types.js'

/**
 * How a response is released.
 *
 * `immediate` resolves on a microtask. `manual` queues every request until a test
 * releases it by key, in any order, which is how out-of-order arrival is tested
 * without a timer or a race. `latency` uses a real timer and exists only so
 * benchmarks can model a network; no test should depend on it.
 */
export type ReleaseMode = 'immediate' | 'manual' | 'latency'

export interface InMemorySourceOptions {
  readonly mode?: ReleaseMode
  readonly latencyMs?: number
  /** When false the source never reports `total`, modelling a cursor-paginated API. */
  readonly reportTotal?: boolean
  /**
   * Return fewer nodes than asked for, even mid-sequence. Real APIs do this and a
   * consumer that assumes `nodes.length === limit` is wrong; this makes that
   * assumption fail in tests rather than in someone's application.
   */
  readonly maxPageSize?: number
}

interface Pending {
  readonly key: string
  readonly request: LoadChildrenRequest
  readonly resolve: (result: LoadChildrenResult) => void
  readonly reject: (error: unknown) => void
}

const abortError = (): Error => {
  const error = new Error('The operation was aborted')
  error.name = 'AbortError'
  return error
}

/**
 * A source over an in-memory tree.
 *
 * It ships with the package rather than living in tests because it is the
 * reference implementation of the contract: the thing that says what the words in
 * `types.ts` actually mean, and the only way to exercise them deterministically.
 *
 * It knows nothing about viewports, coverage, demand or eviction. It answers
 * questions about children and does not care why they were asked.
 */
export class InMemorySource implements HierarchySource {
  private readonly mode: ReleaseMode
  private readonly latencyMs: number
  private readonly reportTotal: boolean
  private readonly maxPageSize: number
  private readonly queue = new Map<string, Pending[]>()
  private readonly log: LoadChildrenRequest[] = []

  constructor(
    private readonly store: MapTreeStore,
    options: InMemorySourceOptions = {},
  ) {
    this.mode = options.mode ?? 'immediate'
    this.latencyMs = options.latencyMs ?? 0
    this.reportTotal = options.reportTotal ?? true
    this.maxPageSize = options.maxPageSize ?? Number.POSITIVE_INFINITY
  }

  /** Every request received, in order. Benchmarks count pages with this; tests
   *  assert idempotency and abort behaviour with it. */
  get requests(): readonly LoadChildrenRequest[] {
    return this.log
  }

  /** Keys of requests awaiting release, in arrival order. `manual` mode only. */
  pending(): readonly string[] {
    return [...this.queue.keys()]
  }

  /**
   * Releases every request queued under one key. Returns false if none is.
   *
   * A key may have more than one waiter, because the same question can be asked
   * twice before either answer arrives. They all get the same answer, which is the
   * point of request identity. Deduplicating callers is the loading layer's job,
   * not the source's, and doing it here would hide a defect that layer must not
   * have.
   */
  release(key: string): boolean {
    const waiting = this.queue.get(key)
    if (waiting === undefined || waiting.length === 0) return false
    this.queue.delete(key)
    for (const entry of waiting) this.settle(entry)
    return true
  }

  /** Releases everything queued, in arrival order. */
  releaseAll(): number {
    return this.releaseIn([...this.queue.keys()])
  }

  /** Releases everything queued, newest first. The simplest out-of-order case. */
  releaseInReverse(): number {
    return this.releaseIn([...this.queue.keys()].reverse())
  }

  /** Releases in a caller-chosen order. Keys not queued are skipped. */
  releaseIn(keys: readonly string[]): number {
    let released = 0
    for (const key of keys) if (this.release(key)) released += 1
    return released
  }

  private settle(entry: Pending): void {
    if (entry.request.signal.aborted) {
      entry.reject(abortError())
      return
    }
    entry.resolve(this.compute(entry.request))
  }

  private childrenOf(parentId: NodeId | null): readonly NodeId[] {
    if (parentId === null) return this.store.roots
    return this.store.get(parentId)?.childIds ?? []
  }

  private compute(request: LoadChildrenRequest): LoadChildrenResult {
    const children = this.childrenOf(request.parentId)
    const limit = Math.min(request.limit, this.maxPageSize)
    const from = Math.min(request.offset, children.length)
    const to = Math.min(from + limit, children.length)

    const nodes: SourceNode[] = []
    for (let i = from; i < to; i++) {
      const id = children[i]
      if (id === undefined) continue
      nodes.push({ id, hasChildren: (this.store.get(id)?.childIds?.length ?? 0) > 0 })
    }

    const exhausted = request.offset + nodes.length >= children.length
    return this.reportTotal ? { nodes, exhausted, total: children.length } : { nodes, exhausted }
  }

  loadChildren(request: LoadChildrenRequest): Promise<LoadChildrenResult> {
    // Range validation is synchronous and eager: a malformed range is a caller
    // defect, not a data condition, so it should not travel as a rejected promise
    // through the same path a real failure would.
    assertValidRange(request)
    this.log.push(request)

    if (request.signal.aborted) return Promise.reject(abortError())

    if (this.mode === 'immediate') {
      return Promise.resolve(this.compute(request))
    }

    const key = requestKey(request)
    return new Promise<LoadChildrenResult>((resolve, reject) => {
      const entry: Pending = { key, request, resolve, reject }
      const onAbort = (): void => {
        const waiting = this.queue.get(key)
        if (waiting !== undefined) {
          const remaining = waiting.filter((candidate) => candidate !== entry)
          if (remaining.length === 0) this.queue.delete(key)
          else this.queue.set(key, remaining)
        }
        reject(abortError())
      }
      request.signal.addEventListener('abort', onAbort, { once: true })

      if (this.mode === 'manual') {
        const waiting = this.queue.get(key)
        if (waiting === undefined) this.queue.set(key, [entry])
        else waiting.push(entry)
        return
      }

      setTimeout(() => {
        if (request.signal.aborted) return
        resolve(this.compute(request))
      }, this.latencyMs)
    })
  }
}
