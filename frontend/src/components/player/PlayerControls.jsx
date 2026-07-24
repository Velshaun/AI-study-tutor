import { AudioLines, Loader2, Pause, Play, RotateCcw, RotateCw, Text } from 'lucide-react'

import { usePlayer } from '../../hooks/usePlayer'
import { SPEEDS } from '../../lib/playerConstants'
import { formatClock } from '../../lib/format'

/**
 * Transport controls (§5.5): back 10s, play/pause, forward 10s, a speed pill
 * row and a view toggle — plus a scrubber, since a lecture without one is
 * unusable.
 *
 * Speed is a row of pills rather than a cycle button: the choices are few and a
 * learner slowing a dense lecture wants to see the options, not tap through
 * them blind.
 */
export default function PlayerControls({ view, onToggleView }) {
  const {
    playing, position, duration, speed, loading,
    toggle, skip, seek, changeSpeed, SKIP_SECONDS,
  } = usePlayer()

  return (
    <div className="space-y-5">
      {/* Scrubber */}
      <div className="space-y-1.5">
        <input
          type="range"
          min={0}
          max={Math.max(1, Math.floor(duration))}
          value={Math.floor(Math.min(position, duration || position))}
          onChange={(e) => seek(Number(e.target.value))}
          aria-label="Seek"
          className="h-1.5 w-full cursor-pointer appearance-none rounded-full
                     bg-surface2 accent-accent"
        />
        <div className="flex justify-between text-xs tabular-nums text-sec">
          <span>{formatClock(position)}</span>
          <span>{formatClock(duration)}</span>
        </div>
      </div>

      {/* Transport */}
      <div className="flex items-center justify-center gap-3">
        <button
          onClick={() => skip(-SKIP_SECONDS)}
          className="btn-ghost size-12 rounded-full p-0"
          aria-label={`Back ${SKIP_SECONDS} seconds`}
        >
          <RotateCcw size={22} aria-hidden="true" />
        </button>

        <button
          onClick={toggle}
          disabled={loading}
          aria-label={playing ? 'Pause' : 'Play'}
          className="flex size-16 items-center justify-center rounded-full bg-accent
                     text-white shadow-lg shadow-accent/25 transition-colors
                     hover:bg-accent2 disabled:opacity-60"
        >
          {loading ? (
            <Loader2 size={28} className="animate-spin" aria-hidden="true" />
          ) : playing ? (
            <Pause size={28} aria-hidden="true" />
          ) : (
            <Play size={28} className="ml-1" aria-hidden="true" />
          )}
        </button>

        <button
          onClick={() => skip(SKIP_SECONDS)}
          className="btn-ghost size-12 rounded-full p-0"
          aria-label={`Forward ${SKIP_SECONDS} seconds`}
        >
          <RotateCw size={22} aria-hidden="true" />
        </button>
      </div>

      {/* Speed pills + view toggle */}
      <div className="flex items-center gap-2">
        <div
          className="flex flex-1 items-center gap-1 rounded-full bg-surface2 p-1"
          role="group"
          aria-label="Playback speed"
        >
          {SPEEDS.map((s) => {
            const active = s === speed
            return (
              <button
                key={s}
                onClick={() => changeSpeed(s)}
                aria-pressed={active}
                aria-label={`Speed ${s} times`}
                className={[
                  'min-h-9 flex-1 rounded-full px-2 py-1.5 text-xs font-semibold tabular-nums',
                  'transition-colors',
                  active ? 'bg-accent text-white' : 'text-sec hover:text-pri',
                ].join(' ')}
              >
                {s}&times;
              </button>
            )
          })}
        </div>

        <button
          onClick={onToggleView}
          className="btn-ghost size-11 shrink-0 rounded-full p-0"
          aria-label={view === 'visualizer' ? 'Show transcript' : 'Show visualiser'}
        >
          {view === 'visualizer' ? (
            <Text size={20} aria-hidden="true" />
          ) : (
            <AudioLines size={20} aria-hidden="true" />
          )}
        </button>
      </div>
    </div>
  )
}
