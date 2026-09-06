import type { NodeId, Row } from '@understory/core'
import type { LabEvent, LabSnapshot } from '../lab/engine.js'

const int = (n: number): string => n.toLocaleString('en-US')
const ratio = (n: number): string => (n === 0 ? '-' : `${n.toFixed(n < 10 ? 2 : 0)}x`)

export function Metric({
  label,
  value,
  tone,
  hint,
}: {
  label: string
  value: string
  tone?: 'ok' | 'warn' | 'bad' | 'muted'
  hint?: string
}): JSX.Element {
  return (
    <div className="metric" title={hint ?? label}>
      <span className="metric-label">{label}</span>
      <span className={`metric-value ${tone ?? ''}`}>{value}</span>
    </div>
  )
}

/**
 * The three numbers the M1 design is about, kept together and in this order.
 *
 * Logical size is what the source could serve. Materialized rows are what the
 * engine is holding. Visible rows are what the reader can see. The design's whole
 * claim is that the second stays near the third rather than near the first, and
 * putting them side by side is the fastest way to see whether it is holding.
 */
export function ScaleBar({ snapshot }: { snapshot: LabSnapshot }): JSX.Element {
  const { logicalNodes, materialisedRows, visibleRows, config } = snapshot
  const overBudget = config.eviction && materialisedRows > config.budget
  return (
    <div className="scale">
      <div className="scale-cell">
        <div className="scale-value">{int(logicalNodes)}</div>
        <div className="scale-label">logical nodes</div>
        <div className="scale-note">{snapshot.corpusMode}</div>
      </div>
      <div className="scale-arrow">&rsaquo;</div>
      <div className="scale-cell">
        <div className={`scale-value ${overBudget ? 'bad' : 'ok'}`}>{int(materialisedRows)}</div>
        <div className="scale-label">materialized rows</div>
        <div className="scale-note">
          budget {config.eviction ? int(config.budget) : 'off'}
          {overBudget ? ' (over)' : ''}
        </div>
      </div>
      <div className="scale-arrow">&rsaquo;</div>
      <div className="scale-cell">
        <div className="scale-value">{int(visibleRows)}</div>
        <div className="scale-label">visible rows</div>
        <div className="scale-note">
          {config.viewportRows} + {config.overscan} overscan
        </div>
      </div>
    </div>
  )
}

/**
 * Why the engine is in the state it is in, in one sentence.
 *
 * Derived from `BudgetEvictor.candidates` and `protectedNow`, not from a guess. A
 * reader watching rows sit above the budget needs to know whether eviction is
 * choosing not to act or is forbidden from acting, and those are different systems.
 */
function evictionReason(snapshot: LabSnapshot): string {
  const { config, materialisedRows, evictionCandidates, protectedParents } = snapshot
  if (!config.eviction)
    return 'Eviction is disabled. Rows are bounded only by what demand has fetched.'
  if (materialisedRows <= config.budget) {
    return `Within budget, so eviction has nothing to do. ${protectedParents} parent(s) protected by the viewport.`
  }
  if (evictionCandidates === 0) {
    return `Over budget with nothing evictable: all ${protectedParents} loaded parent(s) hold a row inside the protected window. Discarding one would destroy what the reader is looking at, so the sweep reports STUCK. This is the pre-registered REVERSE condition.`
  }
  return `Over budget with ${evictionCandidates} candidate(s) available; the sweep is working through them.`
}

export function MetricsPanel({ snapshot }: { snapshot: LabSnapshot }): JSX.Element {
  const c = snapshot.counters
  const amp = snapshot.amplification
  return (
    <div className="panel">
      <h2>Requests</h2>
      <div className="metrics">
        <Metric label="requested" value={int(c.requested)} />
        <Metric label="applied" value={int(c.applied)} />
        <Metric
          label="refused as gap"
          value={int(c.gapPages)}
          tone={c.gapPages > 0 ? 'warn' : 'muted'}
          hint="A page arriving before the one in front of it. Under D2 the store refuses it rather than creating a hole."
        />
        <Metric
          label="stale"
          value={int(c.stalePages)}
          tone={c.stalePages > 0 ? 'warn' : 'muted'}
        />
        <Metric
          label="conflict"
          value={int(c.conflictPages)}
          tone={c.conflictPages > 0 ? 'bad' : 'muted'}
        />
        <Metric
          label="duplicate requests"
          value={int(c.duplicateRequests)}
          tone={c.duplicateRequests > 0 ? 'bad' : 'muted'}
          hint="Same page, same eviction epoch, asked twice. Acceptance criterion A5 requires zero."
        />
        <Metric
          label="overlapping"
          value={int(c.overlappingRequests)}
          tone={c.overlappingRequests > 0 ? 'bad' : 'muted'}
        />
        <Metric
          label="refetch after eviction"
          value={int(c.refetchesAfterEviction)}
          tone={c.refetchesAfterEviction > 0 ? 'warn' : 'muted'}
          hint="A page requested again after its coverage was discarded. Not a defect on its own; the cost of eviction, which §8 counts against amplification."
        />
        <Metric label="in flight" value={int(snapshot.inFlight)} />
        <Metric label="demand pending" value={int(snapshot.pendingDemand)} />
      </div>

      <h2>Amplification</h2>
      <div className="metrics">
        <Metric
          label="pages / §8 minimum"
          value={ratio(amp)}
          tone={amp > 3 ? 'bad' : amp > 1.5 ? 'warn' : 'ok'}
          hint="Pages actually requested against the number an omniscient loader would need. A4 sets a policy ceiling of 3x."
        />
        <Metric label="§8 minimum" value={int(snapshot.minimumPages)} />
        <Metric
          label="achievable minimum"
          value={int(snapshot.minimumPagesAchievable)}
          hint="What a correct prefix-closed loader could achieve. §8's number is unreachable in principle; both are reported, and A3 and A4 are judged against §8 as committed."
        />
      </div>

      <h2>Eviction</h2>
      <p className="why">{evictionReason(snapshot)}</p>
      <div className="metrics">
        <Metric label="sweeps" value={int(c.sweeps)} />
        <Metric label="parents evicted" value={int(c.evictions)} />
        <Metric
          label="stuck sweeps"
          value={int(c.stuckSweeps)}
          tone={c.stuckSweeps > 0 ? 'bad' : 'muted'}
          hint="A sweep that could not reach the budget because everything left was inside the protected window."
        />
        <Metric label="eviction epoch" value={int(snapshot.epoch)} />
        <Metric
          label="candidates now"
          value={int(snapshot.evictionCandidates)}
          tone={snapshot.evictionCandidates === 0 ? 'warn' : 'muted'}
          hint="Parents eviction is currently allowed to discard."
        />
        <Metric
          label="protected now"
          value={int(snapshot.protectedParents)}
          hint="Parents the viewport forbids discarding, because they hold a row inside the window."
        />
      </div>
    </div>
  )
}

export function StatePanel({ snapshot }: { snapshot: LabSnapshot }): JSX.Element {
  const { count, config } = snapshot
  return (
    <div className="panel">
      <h2>Engine state</h2>
      <div className="metrics">
        <Metric
          label="count()"
          value={`${count.kind} ${int(snapshot.materialisedRows)}`}
          tone={snapshot.countIsExact ? 'ok' : 'muted'}
          hint="D2 will not claim a total it has not been told. The scrollbar grows as you explore; that is a stated product limitation, not a defect."
        />
        <Metric
          label="viewport"
          value={`${int(snapshot.viewport.start)} - ${int(snapshot.viewport.end)}`}
        />
        <Metric label="overscan" value={int(config.overscan)} />
        <Metric label="expanded nodes" value={int(snapshot.expandedCount)} />
        <Metric label="loaded parents" value={int(snapshot.loadedParents)} />
        <Metric label="page size" value={int(config.pageSize)} />
        <Metric label="latency" value={`${config.latencyMs}ms`} />
        <Metric label="source totals" value={config.reportTotal ? 'reported' : 'unknown'} />
      </div>

      <h2>Loaded prefixes</h2>
      <div className="prefixes">
        {snapshot.prefixes.slice(0, 24).map((prefix) => (
          <div className="prefix" key={prefix.id}>
            <span className="prefix-id">{prefix.id}</span>
            <span className="prefix-bar">
              <span
                className="prefix-fill"
                style={{
                  width:
                    prefix.total === undefined || prefix.total === 0
                      ? '100%'
                      : `${Math.min(100, (prefix.loaded / prefix.total) * 100)}%`,
                }}
              />
            </span>
            <span className="prefix-count">
              {int(prefix.loaded)}
              {prefix.total === undefined ? '' : `/${int(prefix.total)}`}
              {prefix.exhausted ? ' end' : ''}
            </span>
          </div>
        ))}
        {snapshot.prefixes.length > 24 ? (
          <div className="prefix-more">+{int(snapshot.prefixes.length - 24)} more</div>
        ) : null}
      </div>
    </div>
  )
}

/**
 * The refetch loop as a sequence rather than as counters.
 *
 * Reading `requested` climbing next to `evictions` climbing requires the reader to
 * infer the relationship. Showing the same parent being asked for, arriving, being
 * discarded and being asked for again does not.
 */
export function EventStream({ events }: { events: readonly LabEvent[] }): JSX.Element {
  const label = (event: LabEvent): { text: string; tone: string } => {
    switch (event.kind) {
      case 'request':
        return { text: `request  ${parentLabel(event.parentId)} @${event.offset}`, tone: 'req' }
      case 'arrive':
        return {
          text: `arrive   ${parentLabel(event.parentId)} @${event.offset}  ${event.nodes} nodes  ${Math.round(event.latencyMs)}ms`,
          tone: 'ok',
        }
      case 'expand':
        return { text: `expand   ${event.id}`, tone: 'muted' }
      case 'collapse':
        return { text: `collapse ${event.id}`, tone: 'muted' }
      case 'evict':
        return {
          text: `EVICT    ${event.parents.length} parent(s)  ${event.rowsBefore} to ${event.rowsAfter} rows`,
          tone: 'bad',
        }
      case 'stuck':
        return {
          text: `STUCK    ${event.rows} rows, budget ${event.budget}, nothing evictable`,
          tone: 'bad',
        }
      case 'publish':
        return {
          text: `publish  ${event.outcome}`,
          tone: event.outcome === 'applied' ? 'ok' : 'warn',
        }
    }
  }

  return (
    <div className="stream">
      {events.length === 0 ? <div className="stream-empty">no activity yet</div> : null}
      {events.map((event, index) => {
        const { text, tone } = label(event)
        return (
          <div className={`stream-row ${tone}`} key={`${event.at}-${index}`}>
            {text}
          </div>
        )
      })}
    </div>
  )
}

const parentLabel = (parentId: NodeId | null): string =>
  parentId === null ? '<roots>' : String(parentId)

export function HierarchyViewport({
  snapshot,
  onToggle,
  onScroll,
  isExpanded,
}: {
  snapshot: LabSnapshot
  onToggle: (id: NodeId) => void
  onScroll: (index: number) => void
  isExpanded: (id: NodeId) => boolean
}): JSX.Element {
  const { viewport, rows, materialisedRows } = snapshot
  const window: Row[] = rows.slice(viewport.start, viewport.end)

  return (
    <div className="viewport">
      <div className="viewport-rows">
        {window.length === 0 ? (
          <div className="viewport-empty">
            nothing materialized at row {int(viewport.start)}. Under D2 a row exists only where a
            page has been loaded, so scrolling past the loaded prefix shows nothing rather than
            inventing placeholders.
          </div>
        ) : null}
        {window.map((row) =>
          row.kind === 'node' ? (
            <button className="row" key={`n:${row.id}`} onClick={() => onToggle(row.id)}>
              <span className="row-index">{int(row.index)}</span>
              {/* The indent belongs to the tree, not to the row: putting it on the
                  button pushed the index column right along with the depth, so the
                  one column that should be a fixed ruler drifted. */}
              <span className="row-tree" style={{ paddingLeft: row.depth * 14 }}>
                <span className="row-twisty">{isExpanded(row.id) ? '▾' : '▸'}</span>
                <span className="row-id">{row.id}</span>
              </span>
            </button>
          ) : (
            <div className="row placeholder" key={`p:${row.parentId}:${row.slot}`}>
              <span className="row-index">{int(row.index)}</span>
              <span className="row-id">placeholder</span>
            </div>
          ),
        )}
      </div>
      <input
        className="viewport-scroll"
        type="range"
        min={0}
        max={Math.max(0, materialisedRows - snapshot.config.viewportRows)}
        value={Math.min(
          viewport.start,
          Math.max(0, materialisedRows - snapshot.config.viewportRows),
        )}
        onChange={(event) => onScroll(Number(event.target.value))}
        aria-label="scroll position"
      />
      <div className="viewport-foot">
        row {int(viewport.start)} of {int(materialisedRows)} materialized. The track grows as you
        explore, which is D2&rsquo;s stated limitation rather than a bug.
      </div>
    </div>
  )
}
