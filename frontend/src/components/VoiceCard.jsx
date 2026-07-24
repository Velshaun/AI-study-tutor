import { Check, Loader2, Pause, Play } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'

/**
 * Tutor voice card with an audio preview (§5.3 step 3).
 *
 * Previews are static files in public/voices — every user hears the same two
 * clips, so generating them per request would repeat an identical TTS call
 * forever, and as static assets they cache and work offline.
 *
 * Playing one preview stops the other: `onPlay` lifts the currently-playing
 * voice to the parent, and an effect pauses this card when that isn't us.
 */
export default function VoiceCard({
  id,
  name,
  tagline,
  description,
  selected,
  playing,
  onSelect,
  onPlay,
}) {
  const audioRef = useRef(null)
  const [loading, setLoading] = useState(false)
  const [failed, setFailed] = useState(false)

  // Stop when another card takes over.
  useEffect(() => {
    const audio = audioRef.current
    if (!audio) return
    if (!playing && !audio.paused) {
      audio.pause()
      audio.currentTime = 0
    }
  }, [playing])

  async function togglePreview(event) {
    // Don't let the play button also select the card.
    event.stopPropagation()
    const audio = audioRef.current
    if (!audio) return

    if (playing) {
      audio.pause()
      audio.currentTime = 0
      onPlay(null)
      return
    }

    onPlay(id)
    setLoading(true)
    try {
      await audio.play()
      setFailed(false)
    } catch {
      // Autoplay policy, missing file, or a codec the browser refuses.
      setFailed(true)
      onPlay(null)
    } finally {
      setLoading(false)
    }
  }

  return (
    <button
      type="button"
      onClick={() => onSelect(id)}
      aria-pressed={selected}
      className={[
        'card-interactive w-full text-left',
        selected ? 'border-accent bg-surface2' : '',
      ].join(' ')}
    >
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <p className="text-base font-semibold text-pri">{name}</p>
            {selected && (
              <span className="chip-accent">
                <Check size={12} aria-hidden="true" />
                Selected
              </span>
            )}
          </div>
          <p className="mt-0.5 text-xs font-medium text-accent2">{tagline}</p>
          <p className="mt-2 text-sm text-sec">{description}</p>
          {failed && (
            <p className="mt-2 text-xs text-warning">
              Preview couldn&rsquo;t play — tap again, or choose by description.
            </p>
          )}
        </div>

        <span
          role="button"
          tabIndex={0}
          onClick={togglePreview}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') togglePreview(e)
          }}
          aria-label={`${playing ? 'Stop' : 'Play'} ${name} preview`}
          className="flex size-11 shrink-0 items-center justify-center rounded-full
                     bg-accent text-white transition-colors hover:bg-accent2"
        >
          {loading ? (
            <Loader2 size={18} className="animate-spin" aria-hidden="true" />
          ) : playing ? (
            <Pause size={18} aria-hidden="true" />
          ) : (
            <Play size={18} className="ml-0.5" aria-hidden="true" />
          )}
        </span>
      </div>

      <audio
        ref={audioRef}
        src={`/voices/${id}.mp3`}
        preload="none"
        onEnded={() => onPlay(null)}
        onError={() => setFailed(true)}
      />
    </button>
  )
}
