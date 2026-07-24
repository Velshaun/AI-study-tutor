import { ChevronUp, Pause, Play } from 'lucide-react'
import { useLocation, useNavigate } from 'react-router-dom'

import { usePlayer } from '../../hooks/usePlayer'
import { path } from '../../routes'

/**
 * Minimised player — fixed 60px bar (§5.5).
 *
 * Rendered by the app shell so it persists across navigation, and hidden on
 * the full-screen player route where it would duplicate the real controls.
 */
export default function MiniPlayer() {
  const { lecture, playing, toggle, position, duration } = usePlayer()
  const navigate = useNavigate()
  const { pathname } = useLocation()

  if (!lecture) return null
  if (pathname.startsWith('/lecture/')) return null

  const progress = duration > 0 ? Math.min(100, (position / duration) * 100) : 0
  const tutor = lecture.tutor_voice === 'sophia' ? 'Sophia' : 'Marcus'

  return (
    <div
      className="fixed inset-x-0 z-40 border-t border-border bg-surface/80 backdrop-blur-lg
                 bottom-[calc(4.5rem+env(safe-area-inset-bottom))] md:bottom-0"
    >
      <div className="h-0.5 w-full bg-surface2">
        <div
          className="h-full bg-accent transition-[width] duration-500"
          style={{ width: `${progress}%` }}
        />
      </div>

      <div className="mx-auto flex h-[60px] max-w-3xl items-center gap-3 px-4">
        <button
          onClick={toggle}
          aria-label={playing ? 'Pause' : 'Play'}
          className="flex size-11 shrink-0 items-center justify-center rounded-full
                     bg-accent text-white transition-colors hover:bg-accent2"
        >
          {playing ? (
            <Pause size={18} aria-hidden="true" />
          ) : (
            <Play size={18} className="ml-0.5" aria-hidden="true" />
          )}
        </button>

        <button
          onClick={() => navigate(path('lecture', { id: lecture.id }))}
          className="min-w-0 flex-1 text-left"
          aria-label="Expand player"
        >
          <p className="truncate text-sm font-medium text-pri">
            {lecture.title || 'Lecture'}
          </p>
          <p className="truncate text-xs text-sec">{tutor}</p>
        </button>

        <button
          onClick={() => navigate(path('lecture', { id: lecture.id }))}
          aria-label="Expand player"
          className="btn-ghost size-11 shrink-0 rounded-full p-0"
        >
          <ChevronUp size={20} aria-hidden="true" />
        </button>
      </div>
    </div>
  )
}
