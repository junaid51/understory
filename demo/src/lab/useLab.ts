import { useCallback, useEffect, useRef, useState } from 'react'
import type { NodeId } from '@understory/core'
import { applyAutoplay } from './autoplay.js'
import { Lab, type LabConfig, type LabEvent, type LabSnapshot } from './engine.js'
import type { Autoplay } from './presets.js'

/**
 * Drives the engine the way a renderer would, and nothing more.
 *
 * One loop: apply whatever the reader or the autoplay rule asked for, run a round
 * of demand, sweep the evictor, take a snapshot. That is the same order the
 * benchmark runner uses, which matters, because a demo that swept before loading
 * would show a different system from the one that was measured.
 *
 * The loop is a cancellable async chain rather than `setInterval`, because a round
 * of demand takes as long as the configured latency and overlapping rounds would
 * make the in-flight count meaningless.
 */

export interface LabController {
  readonly snapshot: LabSnapshot | undefined
  readonly events: readonly LabEvent[]
  readonly running: boolean
  setRunning: (running: boolean) => void
  scrollTo: (index: number) => void
  toggle: (id: NodeId) => void
  reset: () => void
  step: () => void
  expandVisible: () => void
  collapseAll: () => void
}

const EVENT_LIMIT = 300

export function useLab(
  config: LabConfig,
  autoplay: Autoplay,
  speedMs: number,
  generation: number,
): LabController {
  const labRef = useRef<Lab | undefined>(undefined)
  const eventsRef = useRef<LabEvent[]>([])
  const [snapshot, setSnapshot] = useState<LabSnapshot | undefined>(undefined)
  const [events, setEvents] = useState<readonly LabEvent[]>([])
  const [running, setRunning] = useState(true)

  useEffect(() => {
    const lab = new Lab(config, (event) => {
      const list = eventsRef.current
      list.push(event)
      if (list.length > EVENT_LIMIT) list.splice(0, list.length - EVENT_LIMIT)
    })
    labRef.current = lab
    eventsRef.current = []
    setSnapshot(lab.snapshot())
    setEvents([])
    return () => {
      lab.dispose()
      labRef.current = undefined
    }
    // `config` is state and only changes identity when a setting changes, so this
    // rebuilds the engine exactly when the experiment changes. `generation` forces
    // a rebuild when the reader asks for one without changing any setting.
  }, [config, generation])

  const publish = useCallback(() => {
    const lab = labRef.current
    if (lab === undefined) return
    setSnapshot(lab.snapshot())
    setEvents([...eventsRef.current].slice(-EVENT_LIMIT).reverse())
  }, [])

  useEffect(() => {
    if (!running) return
    let cancelled = false

    const tick = async (): Promise<void> => {
      while (!cancelled) {
        const lab = labRef.current
        if (lab === undefined) return
        const before = lab.snapshot()
        applyAutoplay(lab, before, autoplay)
        await lab.step()
        lab.sweep()
        if (cancelled) return
        publish()
        await new Promise((resolve) => setTimeout(resolve, speedMs))
      }
    }
    void tick()
    return () => {
      cancelled = true
    }
  }, [running, autoplay, speedMs, publish, config, generation])

  const scrollTo = useCallback(
    (index: number) => {
      labRef.current?.setStart(index)
      publish()
    },
    [publish],
  )

  const toggle = useCallback(
    (id: NodeId) => {
      const lab = labRef.current
      if (lab === undefined) return
      if (lab.isExpanded(id)) lab.collapse(id)
      else lab.expand(id)
      publish()
    },
    [publish],
  )

  const step = useCallback(() => {
    const lab = labRef.current
    if (lab === undefined) return
    void lab.step().then(() => {
      lab.sweep()
      publish()
    })
  }, [publish])

  const expandVisible = useCallback(() => {
    const lab = labRef.current
    if (lab === undefined) return
    applyAutoplay(lab, lab.snapshot(), 'expandVisible')
    publish()
  }, [publish])

  const collapseAll = useCallback(() => {
    labRef.current?.collapseAll()
    publish()
  }, [publish])

  const reset = useCallback(() => {
    eventsRef.current = []
    setEvents([])
  }, [])

  return {
    snapshot,
    events,
    running,
    setRunning,
    scrollTo,
    toggle,
    reset,
    step,
    expandVisible,
    collapseAll,
  }
}
