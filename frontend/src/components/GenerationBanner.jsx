import { Loader2, X } from 'lucide-react'
import { useState } from 'react'

import { useGeneration } from '../hooks/useGeneration'

/**
 * Everything being generated right now, wherever the learner happens to be.
 *
 * The per-row state answers "is *this* building"; it says nothing on the
 * screens that don't hold the row. This is the from-anywhere answer — one
 * strip above the nav naming each job, with a cancel that genuinely aborts
 * the request rather than hiding a spinner over work that will still land.
 *
 * Dismissing hides the current set of jobs; a new job brings the strip back,
 * because a dismissal was about the thing being watched, not about banners.
 */
export default function GenerationBanner() {
  const generation = useGeneration()
  const [dismissedKeys, setDismissedKeys] = useState('')

  const entries = Object.entries(generation.jobs)
  if (!entries.length) return null

  const signature = entries.map(([k]) => k).sort().join('|')
  if (dismissedKeys === signature) return null

  return (
    <div
      role="status"
      className="fixed inset-x-0 bottom-16 z-40 mx-auto w-[min(26rem,calc(100vw-1.5rem))]
                 space-y-1.5"
    >
      {entries.map(([key, job]) => (
        <div
          key={key}
          className="flex items-center gap-2.5 rounded-2xl border border-border
                     bg-surface px-3 py-2.5 shadow-lg"
        >
          <Loader2 size={15} className="shrink-0 animate-spin text-accent2" aria-hidden="true" />
          <span className="min-w-0 flex-1 truncate text-xs text-pri">
            Building {job.label}…
          </span>
          <button
            type="button"
            onClick={() => generation.cancel(key)}
            className="shrink-0 rounded-full px-2 py-1 text-[11px] font-medium
                       text-sec transition-colors hover:text-danger"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => setDismissedKeys(signature)}
            aria-label="Hide this"
            className="flex size-7 shrink-0 items-center justify-center rounded-lg
                       text-sec transition-colors hover:bg-surface2"
          >
            <X size={13} aria-hidden="true" />
          </button>
        </div>
      ))}
    </div>
  )
}
