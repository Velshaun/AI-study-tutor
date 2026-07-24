import { AlertCircle, ChevronDown, Loader2 } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'

import PlayerControls from '../components/player/PlayerControls'
import TranscriptView from '../components/player/TranscriptView'
import VoiceInput from '../components/player/VoiceInput'
import Visualizer from '../components/player/Visualizer'
import { usePlayer } from '../hooks/usePlayer'

/**
 * Full-screen lecture player — spec §5.5.
 *
 * Playback state lives in PlayerProvider, above the router, so leaving this
 * screen minimises into the bottom bar instead of stopping the audio. This
 * component is the expanded view onto that state.
 */
export default function LecturePlayer() {
  const { id } = useParams()
  const navigate = useNavigate()
  const { lecture, loading, error, open, position } = usePlayer()
  const [view, setView] = useState('visualizer')

  // Only load when this is a different lecture — re-opening the one already
  // playing would restart it from its saved position.
  useEffect(() => {
    if (id && lecture?.id !== id) open(id)
  }, [id, lecture?.id, open])

  const tutor = lecture?.tutor_voice === 'sophia' ? 'Sophia' : 'Marcus'

  return (
    <div className="flex min-h-dvh flex-col bg-bg">
      {/* Header */}
      <header className="flex items-start gap-3 px-5 pt-[max(1rem,env(safe-area-inset-top))]">
        <button
          onClick={() => navigate(-1)}
          aria-label="Minimise player"
          className="btn-ghost -ml-2 size-11 shrink-0 rounded-full p-0"
        >
          <ChevronDown size={22} aria-hidden="true" />
        </button>
        <div className="min-w-0 flex-1 pt-1.5">
          <p className="truncate text-lg font-semibold text-pri">
            {lecture?.title || (loading ? 'Loading…' : 'Lecture')}
          </p>
          <p className="truncate text-xs text-sec">
            {tutor}
            {lecture?.length_preference ? ` · ${lecture.length_preference}` : ''}
          </p>
        </div>
      </header>

      {/* Stage */}
      <main className="flex min-h-0 flex-1 flex-col px-5 py-6">
        {error ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-3 text-center">
            <AlertCircle size={28} className="text-warning" aria-hidden="true" />
            <p className="max-w-xs text-sm text-sec">{error}</p>
          </div>
        ) : loading ? (
          <div className="flex flex-1 items-center justify-center">
            <Loader2 size={28} className="animate-spin text-accent" aria-hidden="true" />
          </div>
        ) : view === 'visualizer' ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-8">
            <div className="h-40 w-full max-w-md">
              <Visualizer />
            </div>
            {/* The current sentence, so the visualiser view still shows
                something readable without switching modes. */}
            <CurrentSentence position={position} />
          </div>
        ) : (
          <TranscriptView className="min-h-0 flex-1" />
        )}
      </main>

      {/* Voice Q&A — mic FAB plus its answer panel (§5.6a) */}
      <VoiceInput />

      {/* Controls */}
      <div className="border-t border-border bg-surface px-5 py-5 pb-[max(1.25rem,env(safe-area-inset-bottom))]">
        <div className="mx-auto max-w-md">
          <PlayerControls
            view={view}
            onToggleView={() =>
              setView((v) => (v === 'visualizer' ? 'transcript' : 'visualizer'))
            }
          />
        </div>
      </div>
    </div>
  )
}

function CurrentSentence() {
  const { timeline, position } = usePlayer()
  if (!timeline.length) return null

  let index = 0
  for (let i = timeline.length - 1; i >= 0; i -= 1) {
    if (position >= timeline[i].startTime) {
      index = i
      break
    }
  }

  return (
    <p className="max-w-md text-center text-lg leading-relaxed text-pri">
      {timeline[index]?.text}
    </p>
  )
}
