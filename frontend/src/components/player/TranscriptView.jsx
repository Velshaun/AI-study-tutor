import { useEffect, useRef } from 'react'

import { usePlayer } from '../../hooks/usePlayer'
import { activeSentenceIndex } from '../../lib/transcript'

/**
 * Scrollable transcript with the current sentence highlighted (§5.5).
 *
 * Auto-scroll yields to the reader: scrolling by hand suspends it for a few
 * seconds, so skimming ahead doesn't get yanked back every time playback
 * advances a sentence.
 */
export default function TranscriptView({ className = '' }) {
  const { timeline, position, seek } = usePlayer()
  const containerRef = useRef(null)
  const activeRef = useRef(null)
  const suspendedUntil = useRef(0)

  const active = activeSentenceIndex(timeline, position)

  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    const onScroll = () => {
      suspendedUntil.current = Date.now() + 4000
    }
    // Only user-initiated wheel/touch counts; programmatic scrolling doesn't
    // fire these.
    container.addEventListener('wheel', onScroll, { passive: true })
    container.addEventListener('touchmove', onScroll, { passive: true })
    return () => {
      container.removeEventListener('wheel', onScroll)
      container.removeEventListener('touchmove', onScroll)
    }
  }, [])

  useEffect(() => {
    if (Date.now() < suspendedUntil.current) return
    activeRef.current?.scrollIntoView({ block: 'center', behavior: 'smooth' })
  }, [active])

  if (!timeline.length) {
    return (
      <div className={`flex items-center justify-center ${className}`}>
        <p className="text-sm text-sec">No transcript for this lecture.</p>
      </div>
    )
  }

  return (
    <div
      ref={containerRef}
      className={`overflow-y-auto ${className}`}
      aria-label="Lecture transcript"
    >
      <div className="space-y-1 py-2">
        {timeline.map((entry, index) => {
          const isActive = index === active
          return (
            <p
              key={index}
              ref={isActive ? activeRef : null}
              onClick={() => seek(entry.startTime)}
              aria-current={isActive ? 'true' : undefined}
              className={[
                'cursor-pointer rounded-lg px-3 py-1.5 text-[15px] leading-relaxed',
                'transition-colors duration-200',
                isActive
                  ? 'bg-surface2 font-medium text-accent2'
                  : index < active
                    ? 'text-sec hover:text-pri'
                    : 'text-pri/70 hover:text-pri',
              ].join(' ')}
            >
              {entry.text}
            </p>
          )
        })}
      </div>
    </div>
  )
}
