import { AnimatePresence, motion } from 'framer-motion'
import { Ear, Loader2, Mic, Play, Send, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'

import { usePlayer } from '../../hooks/usePlayer'
import { useSpeechRecognition } from '../../hooks/useSpeechRecognition'
import { apiFetch } from '../../lib/api'

/**
 * Mid-lecture voice Q&A, voice-first resume — spec §5.6a + resume amendment.
 *
 * Flow: tap the mic → the lecture pauses → speech is transcribed live → two
 * seconds of silence submits it → the tutor answers in their own voice, ending
 * with a spoken check-in ("Does that make sense?") → the mic reopens
 * automatically → the student either speaks a confirmation, which resumes the
 * lecture with no tap, or asks another question, which is a new exchange.
 *
 * Resume is voice-first. The only tap path is a failsafe "Ready to continue?"
 * button that appears after ten silent seconds — for a blocked mic or a locked
 * screen — and never auto-dismisses.
 *
 * Two hard constraints:
 *
 * - The lecture pauses the instant the mic opens, and the mic only reopens
 *   once the answer audio has *finished* — otherwise it transcribes the
 *   tutor's own voice back into the next question.
 * - A spoken "yeah" resumes without paying for a throwaway acknowledgement:
 *   the utterance is classified first (keyword-cheap), and only a real question
 *   goes through the full answer+TTS pipeline.
 */

const S = {
  IDLE: 'idle',
  LISTENING: 'listening', // capturing the question
  THINKING: 'thinking',
  ANSWERING: 'answering', // answer audio playing, mic closed
  AWAITING: 'awaiting', // answer done, mic open for confirm-or-question
  ERROR: 'error',
}

const FAILSAFE_MS = 10_000

export default function VoiceInput() {
  const { lecture, position, playing, pause, play } = usePlayer()
  const lectureId = lecture?.id ?? null
  const tutor = lecture?.tutor_voice === 'sophia' ? 'Sophia' : 'Marcus'

  const [state, setState] = useState(S.IDLE)
  const [answer, setAnswer] = useState(null)
  const [question, setQuestion] = useState('')
  const [error, setError] = useState(null)
  const [typed, setTyped] = useState('')
  const [showFailsafe, setShowFailsafe] = useState(false)

  const answerAudioRef = useRef(null)
  const sessionRef = useRef(null)
  const askedAtRef = useRef(0)
  const failsafeTimer = useRef(null)

  // --- helpers. Plain functions: only ever called from event handlers and
  //     callbacks, so they never need to be stable dependencies. -----------
  const clearFailsafe = () => {
    if (failsafeTimer.current) {
      clearTimeout(failsafeTimer.current)
      failsafeTimer.current = null
    }
  }

  const stopAnswerAudio = () => {
    if (answerAudioRef.current) {
      answerAudioRef.current.pause()
      answerAudioRef.current = null
    }
  }

  const resumeLecture = () => {
    stopAnswerAudio()
    clearFailsafe()
    setShowFailsafe(false)
    speech.cancel()
    setState(S.IDLE)
    setAnswer(null)
    setQuestion('')
    setTyped('')
    setError(null)
    // Playback position was never advanced by asking, so this returns to the
    // exact spot the lecture paused.
    play()
  }

  const dismiss = () => {
    stopAnswerAudio()
    clearFailsafe()
    setShowFailsafe(false)
    speech.cancel()
    setState(S.IDLE)
    setAnswer(null)
    setQuestion('')
    setTyped('')
    setError(null)
  }

  /** Reopen the mic once an answer has finished, and arm the 10s failsafe. */
  const startAwaiting = () => {
    stopAnswerAudio()
    setState(S.AWAITING)
    setShowFailsafe(false)
    clearFailsafe()

    if (!speech.supported) {
      // No engine (e.g. Firefox) — the button is the only resume path.
      setShowFailsafe(true)
      return
    }
    speech.start()
    failsafeTimer.current = setTimeout(() => setShowFailsafe(true), FAILSAFE_MS)
  }

  /** Ask a genuine question: full answer + narration, then reopen the mic. */
  const askQuestion = async (text) => {
    setQuestion(text)
    setState(S.THINKING)
    setError(null)
    try {
      const result = await apiFetch(`/lectures/${lectureId}/qa`, {
        method: 'POST',
        body: {
          voice_transcription: text,
          timestamp_secs: Math.round(askedAtRef.current),
          session_id: sessionRef.current || undefined,
          speak: true,
        },
      })
      sessionRef.current = result.session_id
      setAnswer(result)
      setState(S.ANSWERING)

      const url = result.exchange?.answer_audio_url
      if (url) {
        const audio = new Audio(url)
        answerAudioRef.current = audio
        // Reopen the mic only when the tutor has finished speaking.
        audio.addEventListener('ended', startAwaiting, { once: true })
        audio.play().catch(startAwaiting) // autoplay blocked → still reopen
      } else {
        // Narration unavailable — the student reads the answer; reopen at once.
        startAwaiting()
      }
    } catch (err) {
      setError(err?.message || 'Could not reach the tutor.')
      setState(S.ERROR)
    }
  }

  /** Every captured utterance flows through here — the first question and the
   *  post-answer mic alike. */
  const handleUtterance = async (text) => {
    clearFailsafe()
    setShowFailsafe(false)
    const clean = (text || '').trim()
    if (!clean || !lectureId) {
      setState(S.IDLE)
      return
    }

    setState(S.THINKING)
    setError(null)

    // Classify first — a confirmation resumes instantly; only a question pays
    // for an answer.
    let kind = 'knowledge'
    try {
      const verdict = await apiFetch(`/lectures/${lectureId}/qa/classify`, {
        method: 'POST',
        body: { text: clean },
      })
      kind = verdict?.kind || 'knowledge'
    } catch {
      // Classifier unreachable — fall through to the default and treat it as a
      // question rather than swallow it.
    }

    if (kind === 'confirmation' || kind === 'closing') {
      // Record it so the session thread stays correct (a closing ends the
      // session); don't block the resume on that write.
      apiFetch(`/lectures/${lectureId}/qa`, {
        method: 'POST',
        body: {
          voice_transcription: clean,
          timestamp_secs: Math.round(askedAtRef.current),
          session_id: sessionRef.current || undefined,
          speak: false,
        },
      }).catch(() => {})
      resumeLecture()
      return
    }

    await askQuestion(clean)
  }

  const speech = useSpeechRecognition({
    onSubmit: handleUtterance,
    // Speech began — the student is engaging, so cancel the pending failsafe.
    onSpeechStart: clearFailsafe,
    keepAlive: true,
  })

  const startQuestion = () => {
    // Pause first: an open mic would transcribe the lecture itself.
    askedAtRef.current = position
    if (playing) pause()
    setAnswer(null)
    setQuestion('')
    setError(null)
    setShowFailsafe(false)
    if (!speech.supported) {
      setError('Speech recognition is not available — type your question.')
      setState(S.ERROR)
      return
    }
    setState(S.LISTENING)
    speech.start()
  }

  useEffect(
    () => () => {
      // Unmount: drop timers and audio. The speech hook cleans itself.
      if (failsafeTimer.current) clearTimeout(failsafeTimer.current)
      answerAudioRef.current?.pause()
    },
    [],
  )

  if (!lecture) return null

  // Recognition failures (blocked mic) surface as the error state without a
  // mirroring effect.
  const activeError = error || speech.error
  const activeState =
    activeError && state !== S.THINKING && state !== S.ANSWERING ? S.ERROR : state
  const open = activeState !== S.IDLE
  const isListening = activeState === S.LISTENING || activeState === S.AWAITING

  return (
    <>
      {/* Panel */}
      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 16 }}
            transition={{ duration: 0.18 }}
            className="fixed inset-x-0 bottom-[calc(9rem+env(safe-area-inset-bottom))]
                       z-40 px-4"
          >
            <div className="mx-auto max-w-md space-y-3">
              {/* Question bubble */}
              {question && (
                <div className="ml-auto max-w-[85%] rounded-2xl rounded-br-sm bg-surface2
                                px-4 py-2.5 text-sm text-pri">
                  {question}
                </div>
              )}

              {/* Answer bubble (stays visible while awaiting) */}
              {(activeState === S.ANSWERING || activeState === S.AWAITING) && answer && (
                <div className="max-w-[92%] rounded-2xl rounded-bl-sm border border-accent/30
                                bg-surface px-4 py-3">
                  <p className="mb-1 text-xs font-medium text-accent2">{tutor}</p>
                  <p className="text-sm leading-relaxed text-pri">
                    {answer.exchange?.answer}
                  </p>
                </div>
              )}

              {/* Live capture (initial question) */}
              {activeState === S.LISTENING && (
                <div className="rounded-2xl border border-accent/40 bg-surface px-4 py-3">
                  <p className="text-sm text-pri">
                    {speech.transcript || <span className="text-sec">Listening…</span>}
                  </p>
                  <p className="mt-1.5 text-xs text-sec">
                    Pause when you&rsquo;re done and I&rsquo;ll answer.
                  </p>
                </div>
              )}

              {/* Thinking */}
              {activeState === S.THINKING && (
                <div className="flex items-center gap-2.5 rounded-2xl rounded-bl-sm
                                bg-surface px-4 py-3">
                  <Loader2 size={16} className="animate-spin text-accent" aria-hidden="true" />
                  <p className="text-sm text-sec">{tutor} is thinking…</p>
                </div>
              )}

              {/* Awaiting — mic is open for a spoken reply */}
              {activeState === S.AWAITING && (
                <div className="rounded-2xl bg-surface2 px-4 py-3">
                  {speech.transcript ? (
                    <p className="text-sm text-pri">{speech.transcript}</p>
                  ) : (
                    <div className="flex items-center gap-2 text-sm text-sec">
                      <Ear size={15} className="text-accent" aria-hidden="true" />
                      Say &ldquo;ready&rdquo; to continue, or ask a follow-up.
                    </div>
                  )}

                  {/* Failsafe — only after 10 silent seconds; never auto-hides */}
                  {showFailsafe && (
                    <button onClick={resumeLecture} className="btn-primary mt-3 w-full">
                      <Play size={15} aria-hidden="true" />
                      Ready to continue?
                    </button>
                  )}
                </div>
              )}

              {/* Error + typing fallback */}
              {activeState === S.ERROR && (
                <div className="space-y-2 rounded-2xl border border-warning/40
                                bg-surface px-4 py-3">
                  <p className="text-sm text-warning">{activeError}</p>
                  <form
                    onSubmit={(e) => {
                      e.preventDefault()
                      if (typed.trim()) {
                        const t = typed.trim()
                        setTyped('')
                        handleUtterance(t)
                      }
                    }}
                    className="flex gap-2"
                  >
                    <input
                      value={typed}
                      onChange={(e) => setTyped(e.target.value)}
                      placeholder="Type your question instead…"
                      className="input flex-1"
                    />
                    <button type="submit" className="btn-primary px-3">
                      <Send size={15} aria-hidden="true" />
                    </button>
                  </form>
                  <button onClick={resumeLecture} className="btn-ghost text-xs">
                    Back to the lecture
                  </button>
                </div>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Mic FAB — above the minimised player bar */}
      <button
        onClick={isListening ? speech.stop : open ? dismiss : startQuestion}
        aria-label={isListening ? 'Stop and send' : open ? 'Close' : 'Ask a question'}
        className={[
          'fixed right-5 z-40 flex size-14 items-center justify-center rounded-full',
          'text-white shadow-lg transition-colors',
          'bottom-[calc(6.5rem+env(safe-area-inset-bottom))]',
          isListening
            ? 'bg-accent shadow-accent/40'
            : open
              ? 'bg-surface2 text-sec'
              : 'bg-accent shadow-accent/25 hover:bg-accent2',
        ].join(' ')}
      >
        {isListening && (
          <motion.span
            className="absolute inset-0 rounded-full bg-accent"
            animate={{ scale: [1, 1.35], opacity: [0.5, 0] }}
            transition={{ duration: 1.4, repeat: Infinity, ease: 'easeOut' }}
            aria-hidden="true"
          />
        )}
        <span className="relative">
          {open && !isListening ? (
            <X size={22} aria-hidden="true" />
          ) : (
            <Mic size={22} aria-hidden="true" />
          )}
        </span>
      </button>
    </>
  )
}
