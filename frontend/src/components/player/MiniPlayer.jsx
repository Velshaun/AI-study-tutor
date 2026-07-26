import { AnimatePresence, motion } from 'framer-motion'
import { ChevronUp, Pause, Play, X } from 'lucide-react'
import { useLocation, useNavigate } from 'react-router-dom'

import { usePlayer } from '../../hooks/usePlayer'
import { path } from '../../routes'

/**
 * Minimised player — fixed bar (§5.5).
 *
 * Rendered by the app shell so it persists across navigation, and hidden on the
 * full-screen player route where it would duplicate the real controls.
 *
 * Dismissable two ways, both of which stop audio and save the position so the
 * lecture resumes later from the same spot: the X button, or a downward swipe.
 * An incomplete swipe springs back into place.
 */

// Past this downward drag (px) — or a faster downward flick — the swipe counts
// as a dismiss; below it, the bar snaps back.
const DISMISS_OFFSET = 70
const DISMISS_VELOCITY = 400

export default function MiniPlayer() {
  const { lecture, playing, toggle, position, duration, close } = usePlayer()
  const navigate = useNavigate()
  const { pathname } = useLocation()

  const show = Boolean(lecture) && !pathname.startsWith('/lecture/')

  const progress = duration > 0 ? Math.min(100, (position / duration) * 100) : 0
  const tutor = lecture?.tutor_voice === 'sophia' ? 'Sophia' : 'Marcus'
  const expand = () => lecture && navigate(path('lecture', { id: lecture.id }))

  return (
    <AnimatePresence>
      {show && (
        <motion.div
          key="mini-player"
          initial={{ y: '120%' }}
          animate={{ y: 0 }}
          exit={{ y: '120%' }}
          transition={{ type: 'spring', stiffness: 420, damping: 40 }}
          drag="y"
          dragConstraints={{ top: 0, bottom: 0 }}
          // Follows the finger downward; can't be dragged up past its resting
          // spot. A released drag that clears the threshold dismisses; anything
          // less springs back to the constraint (y: 0).
          dragElastic={{ top: 0, bottom: 0.9 }}
          onDragEnd={(_, info) => {
            if (
              info.offset.y > DISMISS_OFFSET ||
              info.velocity.y > DISMISS_VELOCITY
            ) {
              // Clearing the lecture flips `show` false → the exit animation
              // slides the bar the rest of the way down.
              close()
            }
          }}
          className="fixed inset-x-0 z-40 border-t border-border bg-surface/80 backdrop-blur-lg
                     bottom-[calc(4.5rem+env(safe-area-inset-bottom))] md:bottom-0"
          role="region"
          aria-label="Lecture player"
        >
          {/* Grab handle — signals the bar can be swiped down. */}
          <div className="flex justify-center pt-1.5">
            <div className="h-1 w-9 rounded-full bg-border" aria-hidden="true" />
          </div>

          <div className="mt-1.5 h-0.5 w-full bg-surface2">
            <div
              className="h-full bg-accent transition-[width] duration-500"
              style={{ width: `${progress}%` }}
            />
          </div>

          <div className="mx-auto flex h-14 max-w-3xl items-center gap-2 px-3">
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
              onClick={expand}
              className="min-w-0 flex-1 text-left"
              aria-label="Expand player"
            >
              <p className="truncate text-sm font-medium text-pri">
                {lecture?.title || 'Lecture'}
              </p>
              <p className="truncate text-xs text-sec">{tutor}</p>
            </button>

            <button
              onClick={expand}
              aria-label="Expand player"
              className="btn-ghost size-11 shrink-0 rounded-full p-0"
            >
              <ChevronUp size={20} aria-hidden="true" />
            </button>

            {/* Stop & close — 44px target. Saves position for later resume. */}
            <button
              onClick={close}
              aria-label="Stop and close lecture"
              className="btn-ghost size-11 shrink-0 rounded-full p-0"
            >
              <X size={20} aria-hidden="true" />
            </button>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
