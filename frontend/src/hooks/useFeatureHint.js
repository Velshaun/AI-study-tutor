import { useCallback, useEffect, useState } from 'react'

import { MOMENTS, hasSeen, markSeen } from '../lib/tour'

/**
 * Teach one feature, the first time it is really in front of somebody.
 *
 * `ready` is the caller saying the thing exists on screen — a lecture tile that
 * has rendered, a container with something in it. Passing `false` keeps the
 * moment waiting rather than spending it on an empty state.
 *
 * Auto-opening moments open once. The rest arm a pulse the learner taps, which
 * is the version that gets read: a hint somebody chose to open completes far
 * more often than one that interrupted them.
 */
export function useFeatureHint(id, ready = true) {
  const moment = MOMENTS[id]
  const [open, setOpen] = useState(false)
  const [armed, setArmed] = useState(() => Boolean(moment) && !hasSeen(id))

  useEffect(() => {
    if (!ready || !armed || !moment?.auto) return undefined
    // A beat after the screen settles, so it arrives as a considered thing
    // rather than racing the content it is pointing at.
    const t = setTimeout(() => setOpen(true), 600)
    return () => clearTimeout(t)
  }, [ready, armed, moment])

  const dismiss = useCallback(() => {
    setOpen(false)
    setArmed(false)
    markSeen(id)
  }, [id])

  return {
    moment,
    /** Show the spotlight now. */
    open: open && ready,
    /** Nothing seen yet: draw the pulse that opens it. */
    armed: armed && ready && !open,
    show: () => setOpen(true),
    dismiss,
  }
}
