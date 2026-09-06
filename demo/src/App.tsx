import { useCallback, useMemo, useState } from 'react'
import type { NodeId } from '@understory/core'
import { SHAPES, type ShapeName } from '@understory/bench/corpus'
import { MATERIALISED_LIMIT, type LabConfig } from './lab/engine.js'
import { DEFAULT_PRESET, PRESETS, type Autoplay, type Preset } from './lab/presets.js'
import { useLab } from './lab/useLab.js'
import { EventStream, HierarchyViewport, MetricsPanel, ScaleBar, StatePanel } from './ui/panels.jsx'

const SIZES = [5_000, 50_000, 200_000, 1_000_000]
const AUTOPLAY: Autoplay[] = ['none', 'expandVisible', 'drill', 'scrollDown', 'accumulate']

export default function App(): JSX.Element {
  const [preset, setPreset] = useState<Preset>(DEFAULT_PRESET)
  const [config, setConfig] = useState<LabConfig>(DEFAULT_PRESET.config)
  const [autoplay, setAutoplay] = useState<Autoplay>(DEFAULT_PRESET.autoplay)
  const [speedMs, setSpeedMs] = useState(120)
  const [generation, setGeneration] = useState(0)

  const lab = useLab(config, autoplay, speedMs, generation)
  const snapshot = lab.snapshot

  const applyPreset = useCallback((next: Preset) => {
    setPreset(next)
    setConfig(next.config)
    setAutoplay(next.autoplay)
    setGeneration((g) => g + 1)
  }, [])

  const set = useCallback(<K extends keyof LabConfig>(key: K, value: LabConfig[K]) => {
    setConfig((current) => ({ ...current, [key]: value }))
  }, [])

  // Read from `projection.expandedIds()`, not inferred from whether a node has
  // child rows. A node can be expanded with nothing loaded under it, which is the
  // state the refetch loop lives in, and inferring would hide exactly that.
  const isExpanded = useCallback(
    (id: NodeId): boolean => snapshot?.expandedIds.has(id) ?? false,
    [snapshot],
  )

  const status = useMemo(() => {
    if (snapshot === undefined) return { text: 'starting', tone: 'muted' }
    if (snapshot.invariantStatus === 'violated') {
      return { text: 'INVARIANT VIOLATED', tone: 'bad' }
    }
    if (snapshot.lastSweepStuck) return { text: 'EVICTION STUCK', tone: 'bad' }
    if (snapshot.config.eviction && snapshot.materialisedRows > snapshot.config.budget) {
      return { text: 'OVER BUDGET', tone: 'warn' }
    }
    return { text: 'nominal', tone: 'ok' }
  }, [snapshot])

  return (
    <div className="app">
      <header className="header">
        <div>
          <h1>Understory M1 laboratory</h1>
          <p className="sub">
            The M1 engine as measured: loaded-prefix coverage, viewport-driven demand, budgeted
            eviction. Milestone verdict was <strong>REVERSE</strong>; this is where you can see why.
          </p>
        </div>
        <div className={`status ${status.tone}`}>
          <span className="status-dot" />
          {status.text}
        </div>
      </header>

      <section className="verdict">
        <span className="verdict-tag">M1 VERDICT: REVERSE</span>
        <span>
          Bounded materialisation was <strong>not</strong> achieved on every topology.{' '}
          <strong>A1, max materialized rows ≤ 4,000, FAILED</strong> in the measurement, along with
          A2, A3, A4 and A6. A5, A7 and A8 passed. Nothing here guarantees the budget holds; this
          laboratory exists to show where it does not.
        </span>
        <code className="verdict-ref">docs/m1-conclusion.md</code>
      </section>

      <section className="presets">
        {PRESETS.map((item) => (
          <button
            key={item.id}
            className={`preset ${item.id === preset.id ? 'active' : ''}`}
            onClick={() => applyPreset(item)}
          >
            <span className="preset-name">{item.name}</span>
            <span className="preset-watch">{item.watchFor}</span>
          </button>
        ))}
      </section>

      <p className="preset-detail">{preset.detail}</p>

      {snapshot === undefined ? (
        <div className="loading">building corpus</div>
      ) : (
        <>
          <ScaleBar snapshot={snapshot} />

          <div className="grid">
            <div className="col-config">
              <div className="panel">
                <h2>Configuration</h2>
                <label>
                  shape
                  <select
                    value={config.shape}
                    onChange={(e) => set('shape', e.target.value as ShapeName)}
                  >
                    {SHAPES.map((shape) => (
                      <option key={shape} value={shape}>
                        {shape}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  logical nodes
                  <select
                    value={config.nodes}
                    onChange={(e) => set('nodes', Number(e.target.value))}
                  >
                    {SIZES.map((size) => (
                      <option key={size} value={size}>
                        {size.toLocaleString('en-US')}
                        {size > MATERIALISED_LIMIT ? ' (procedural)' : ''}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  page size
                  <input
                    type="number"
                    min={1}
                    max={1000}
                    value={config.pageSize}
                    onChange={(e) => set('pageSize', Math.max(1, Number(e.target.value)))}
                  />
                </label>
                <label>
                  latency {config.latencyMs}ms
                  <input
                    type="range"
                    min={0}
                    max={400}
                    step={10}
                    value={config.latencyMs}
                    onChange={(e) => set('latencyMs', Number(e.target.value))}
                  />
                </label>
                <label>
                  arrival jitter {Math.round(config.jitter * 100)}%
                  <input
                    type="range"
                    min={0}
                    max={100}
                    step={5}
                    value={Math.round(config.jitter * 100)}
                    onChange={(e) => set('jitter', Number(e.target.value) / 100)}
                  />
                  <span className="note">
                    spreads response times, so arrivals reorder. A source property, not the
                    engine&rsquo;s.
                  </span>
                </label>
                <label>
                  viewport rows
                  <input
                    type="number"
                    min={5}
                    max={200}
                    value={config.viewportRows}
                    onChange={(e) => set('viewportRows', Math.max(5, Number(e.target.value)))}
                  />
                </label>
                <label>
                  overscan
                  <input
                    type="number"
                    min={0}
                    max={200}
                    value={config.overscan}
                    onChange={(e) => set('overscan', Math.max(0, Number(e.target.value)))}
                  />
                </label>
                <label className="check">
                  <input
                    type="checkbox"
                    checked={config.reportTotal}
                    onChange={(e) => set('reportTotal', e.target.checked)}
                  />
                  source reports totals
                </label>
                <label className="check">
                  <input
                    type="checkbox"
                    checked={config.eviction}
                    onChange={(e) => set('eviction', e.target.checked)}
                  />
                  eviction enabled
                </label>
                <label>
                  budget {config.budget.toLocaleString('en-US')}
                  <input
                    type="range"
                    min={100}
                    max={8000}
                    step={100}
                    value={config.budget}
                    onChange={(e) => set('budget', Number(e.target.value))}
                  />
                  <span className="note">calibrated B is 4,000</span>
                </label>

                <h2>Driver</h2>
                <label>
                  autoplay
                  <select
                    value={autoplay}
                    onChange={(e) => setAutoplay(e.target.value as Autoplay)}
                  >
                    {AUTOPLAY.map((mode) => (
                      <option key={mode} value={mode}>
                        {mode}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  tick {speedMs}ms
                  <input
                    type="range"
                    min={0}
                    max={600}
                    step={20}
                    value={speedMs}
                    onChange={(e) => setSpeedMs(Number(e.target.value))}
                  />
                </label>
                <div className="buttons">
                  <button onClick={() => lab.setRunning(!lab.running)}>
                    {lab.running ? 'pause' : 'run'}
                  </button>
                  <button onClick={lab.step}>step</button>
                  <button onClick={() => setGeneration((g) => g + 1)}>rebuild</button>
                </div>
                <div className="buttons">
                  <button
                    onClick={lab.expandVisible}
                    title="Expand every branchy row in the window"
                  >
                    expand visible
                  </button>
                  <button
                    onClick={lab.collapseAll}
                    title="Collapse everything. Coverage is kept: this is not eviction."
                  >
                    collapse all
                  </button>
                </div>
              </div>
            </div>

            <div className="col-viewport">
              <HierarchyViewport
                snapshot={snapshot}
                onToggle={lab.toggle}
                onScroll={lab.scrollTo}
                isExpanded={isExpanded}
              />
              <div className="panel invariants">
                <h2>Invariants</h2>
                {snapshot.invariantStatus === 'unavailable' ? (
                  <p className="note">
                    Not checkable at this scale. The invariants are decided against a materialised
                    oracle, and a procedural corpus has none to compare with. Drop to 200,000 nodes
                    or fewer and they are checked on every frame.
                  </p>
                ) : snapshot.invariantStatus === 'ok' ? (
                  <p className="ok">N1 to N11 hold on the current state.</p>
                ) : (
                  <ul className="violations">
                    {snapshot.violations.map((violation) => (
                      <li key={violation}>{violation}</li>
                    ))}
                  </ul>
                )}
                <p className="note">
                  {snapshot.expandedCount} expanded, {snapshot.loadedParents} parents holding a
                  loaded prefix.
                </p>
              </div>
            </div>

            <div className="col-metrics">
              <MetricsPanel snapshot={snapshot} />
              <StatePanel snapshot={snapshot} />
            </div>
          </div>

          <section className="panel stream-panel">
            <h2>Request timeline</h2>
            <p className="note">
              Newest first. On the refetch preset, watch one parent cycle through request, arrive,
              EVICT, request.
            </p>
            <EventStream events={lab.events} />
          </section>
        </>
      )}
    </div>
  )
}
