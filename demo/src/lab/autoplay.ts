import type { Lab, LabSnapshot } from './engine.js'
import type { Autoplay } from './presets.js'

/**
 * One autoplay decision, applied before a demand round.
 *
 * A pure rule over the current snapshot rather than a recorded macro, so it keeps
 * working when the configuration changes underneath it. It lives here rather than
 * inside the React hook so that the preset tests drive the laboratory through
 * exactly the code the UI does; a test that reimplemented "expand what is visible"
 * would pass while the button did something else.
 */
export function applyAutoplay(lab: Lab, snapshot: LabSnapshot, mode: Autoplay): void {
  if (mode === 'none') return

  // Branchy nodes inside the viewport, and only those.
  //
  // Two corrections, both from watching the driver rather than reasoning about it.
  // Leaves were being opened, which is a no-op that produces no demand: W7 opened
  // 115 nodes and issued ten requests. And "visible" was reading the whole row
  // list rather than the window, which is not what browsing is: the healthy preset
  // opened everything it could reach and reported 5.8x amplification, measuring the
  // driver's impatience rather than the engine.
  const collapsed = snapshot.rows.filter(
    (row) =>
      row.kind === 'node' &&
      row.index >= snapshot.viewport.start &&
      row.index < snapshot.viewport.end &&
      !snapshot.expandedIds.has(row.id) &&
      lab.hasChildren(row.id),
  )

  if (mode === 'expandVisible' || mode === 'accumulate') {
    let opened = 0
    for (const row of collapsed) {
      if (row.kind !== 'node') continue
      lab.expand(row.id)
      opened += 1
      if (opened >= 3) break
    }
    if (mode === 'accumulate') {
      // Drag to the end, which is the fastest way to accumulate coverage under D2
      // and what workload W7 does in the benchmark.
      lab.setStart(Math.max(0, snapshot.materialisedRows - snapshot.config.viewportRows))
    }
    return
  }

  if (mode === 'drill') {
    const deepest = [...collapsed].sort((a, b) => b.depth - a.depth)[0]
    if (deepest !== undefined && deepest.kind === 'node') {
      lab.expand(deepest.id)
      lab.setStart(Math.max(0, deepest.index - 4))
    }
    return
  }

  if (mode === 'scrollDown') {
    // Open something first when there is nothing to scroll through. On
    // `mega-sibling` the root owns every other node, so the hierarchy is one row
    // until that row is opened, and without this the driver scrolled an empty
    // index space for the whole run while the scenario never started. The search
    // deliberately ignores the viewport here, because the viewport may already
    // have been scrolled past the only row that exists.
    if (snapshot.materialisedRows <= snapshot.config.viewportRows) {
      const openable = snapshot.rows.find(
        (row) =>
          row.kind === 'node' && !snapshot.expandedIds.has(row.id) && lab.hasChildren(row.id),
      )
      if (openable !== undefined && openable.kind === 'node') {
        lab.setStart(0)
        lab.expand(openable.id)
        return
      }
    }
    lab.setStart(snapshot.viewport.start + Math.round(snapshot.config.viewportRows / 2))
  }
}
