import { AnimatePresence, motion } from 'framer-motion'
import { Ear, Mic, Play, Send, X } from 'lucide-react'
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
 * Layout: the conversation lives in a dedicated panel that sits **in the flow**
 * between the lecture stage and the playback controls (rendered by
 * LecturePlayer between them), so it shrinks the stage rather than floating over
 * it. It has a fixed height and scrolls internally — the rest of the screen
 * never moves — and collapses to nothing when the conversation ends. The mic
 * FAB is anchored just above the controls bar at all times.
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
const PANEL_H = 240 // fixed panel height (px) — tall enough to converse, not take over

export default function VoiceInput() {
  const { lecture, position, playing, pause, play, speak, stopSpeaking,
          primeAnswerAudio } = usePlayer()
  const lectureId = lecture?.id ?? null
  const tutor = lecture?.tutor_voice === 'sophia' ? 'Sophia' : 'Marcus'

  const [state, setState] = useState(S.IDLE)
  const [turns, setTurns] = useState([]) // conversation history: {id, role, text}
  const [error, setError] = useState(null)
  const [typed, setTyped] = useState('')
  const [showFailsafe, setShowFailsafe] = useState(false)

  const sessionRef = useRef(null)
  const askedAtRef = useRef(0)
  const failsafeTimer = useRef(null)
  const turnIdRef = useRef(0)
  const scrollRef = useRef(null)

  // --- helpers. Plain functions: only ever called from event handlers and
  //     callbacks, so they never need to be stable dependencies. -----------
  const clearFailsafe = () => {
    if (failsafeTimer.current) {
      clearTimeout(failsafeTimer.current)
      failsafeTimer.current = null
    }
  }

  const pushTurn = (role, text) => {
    turnIdRef.current += 1
    const id = turnIdRef.current
    setTurns((prev) => [...prev, { id, role, text }])
  }

  const endConversation = () => {
    stopSpeaking()
    clearFailsafe()
    setShowFailsafe(false)
    speech.cancel()
    setState(S.IDLE)
    setTurns([])
    setTyped('')
    setError(null)
  }

  const resumeLecture = () => {
    endConversation()
    // Playback position was never advanced by asking, so this returns to the
    // exact spot the lecture paused.
    play()
  }

  const dismiss = endConversation

  /** Reopen the mic once an answer has finished, and arm the 10s failsafe. */
  const startAwaiting = () => {
    stopSpeaking()
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

  /** Ask a genuine question. The backend generates the answer and narrates it
   *  as a single audio file in the tutor's voice, ending with a spoken check-in
   *  ("Does that make sense?"). We play that audio automatically through the
   *  player's answer element — no tap — and reopen the mic only once it has
   *  finished, so the tutor is never transcribed back into the next question. */
  const askQuestion = async (text) => {
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
      pushTurn('tutor', result.exchange?.answer || '')
      setState(S.ANSWERING)

      const url = result.exchange?.answer_audio_url
      if (url) {
        // speak() pauses the lecture underneath and calls startAwaiting only
        // when narration ends — the lecture never resumes before the answer.
        speak(url, startAwaiting)
      } else {
        // Narration failed (audio_error) — the student reads the answer; reopen
        // the mic at once so the flow isn't stuck.
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
      // Empty capture: stay in the conversation if one is underway, else close.
      if (turns.length) startAwaiting()
      else setState(S.IDLE)
      return
    }

    // The tutor's last message gives the classifier the context to read the
    // reply against — it was answering a check-in like "Does that make sense?".
    const tutorMessage = turns.filter((t) => t.role === 'tutor').at(-1)?.text || ''

    // Show what they said the instant they finish speaking.
    pushTurn('student', clean)
    setState(S.THINKING)
    setError(null)

    // AI intent detection — a confirmation, or an unclear reply, resumes the
    // lecture; only a genuine question pays for an answer.
    let resume = false
    try {
      const verdict = await apiFetch(`/lectures/${lectureId}/qa/classify`, {
        method: 'POST',
        body: { text: clean, tutor_message: tutorMessage || undefined },
      })
      resume = Boolean(verdict?.is_resume_signal)
    } catch {
      // Classifier unreachable — leave `resume` false so an unclassifiable
      // utterance is treated as a question rather than silently swallowed.
    }

    if (resume) {
      // Record it so the session thread stays correct; don't block the resume
      // on that write.
      apiFetch(`/lectures/${lectureId}/qa`, {
        method: 'POST',
        body: {
          voice_transcription: clean,
          timestamp_secs: Math.round(askedAtRef.current),
          session_id: sessionRef.current || undefined,
          speak: false,
          tutor_message: tutorMessage || undefined,
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
    // We're inside the tap gesture — unlock the answer element now so the reply
    // (arriving seconds later, outside any gesture) can autoplay on mobile.
    primeAnswerAudio()
    setTurns([])
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

  // Keep the newest message in view as the conversation grows or the live
  // transcript updates. A DOM mutation, not state — safe inside an effect.
  useEffect(() => {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [turns, state, speech.transcript])

  useEffect(
    () => () => {
      // Unmount: drop the failsafe timer. The speech hook and the player's
      // answer element clean themselves up.
      if (failsafeTimer.current) clearTimeout(failsafeTimer.current)
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
      {/* Dedicated voice conversation panel — in the layout flow, so it shrinks
          the lecture stage above rather than floating over it. Fixed height,
          scrolls internally, distinct surface. Collapses to nothing on end. */}
      <AnimatePresence initial={false}>
        {open && (
          <motion.section
            key="voice-panel"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: PANEL_H, opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.24, ease: 'easeInOut' }}
            className="shrink-0 overflow-hidden border-t border-border bg-surface"
            aria-label="Voice conversation"
          >
            <div
              ref={scrollRef}
              className="overflow-y-auto px-4 py-4"
              style={{ height: PANEL_H }}
            >
              <div className="mx-auto flex max-w-md flex-col gap-3 pb-4">
                {turns.map((t) =>
                  t.role === 'student' ? (
                    <StudentBubble key={t.id} text={t.text} />
                  ) : (
                    <TutorBubble key={t.id} tutor={tutor} text={t.text} />
                  ),
                )}

                {/* Thinking — animated dots in the tutor bubble position */}
                {activeState === S.THINKING && <ThinkingBubble tutor={tutor} />}

                {/* Live capture — the student's speech as they talk */}
                {(activeState === S.LISTENING || activeState === S.AWAITING) &&
                  speech.transcript && (
                    <StudentBubble text={speech.transcript} live />
                  )}

                {/* Hints when the mic is open but nothing has been said yet */}
                {activeState === S.LISTENING && !speech.transcript && (
                  <p className="py-1 text-center text-xs text-sec">
                    Listening… pause when you&rsquo;re done and I&rsquo;ll answer.
                  </p>
                )}
                {activeState === S.AWAITING && !speech.transcript && (
                  <div className="flex items-center justify-center gap-2 py-1
                                  text-xs text-sec">
                    <Ear size={14} className="text-accent" aria-hidden="true" />
                    Say &ldquo;ready&rdquo; to continue, or ask a follow-up.
                  </div>
                )}

                {/* Failsafe — only after 10 silent seconds; never auto-hides.
                    Right padding keeps it clear of the mic FAB. */}
                {activeState === S.AWAITING && showFailsafe && (
                  <div className="pe-16">
                    <button onClick={resumeLecture} className="btn-primary w-full">
                      <Play size={15} aria-hidden="true" />
                      Ready to continue?
                    </button>
                  </div>
                )}

                {/* Error + typing fallback. An X (top-right) and "Back to the
                    lecture" both dismiss the panel and resume playback, so the
                    student is never trapped here. Right padding on the content
                    keeps it clear of both the X and the mic FAB. */}
                {activeState === S.ERROR && (
                  <div className="relative space-y-2 rounded-2xl border border-warning/40
                                  bg-surface2 px-4 py-3 pe-16">
                    <button
                      onClick={resumeLecture}
                      aria-label="Dismiss and return to the lecture"
                      className="btn-ghost absolute right-1.5 top-1.5 size-8 rounded-full p-0"
                    >
                      <X size={16} aria-hidden="true" />
                    </button>
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
            </div>
          </motion.section>
        )}
      </AnimatePresence>

      {/* Mic FAB — a zero-height anchor pinned to the top of the controls bar,
          so the button always floats just above it whether the panel is open or
          closed, and never overlaps the progress bar or transport. */}
      <div className="relative z-40 h-0">
        <button
          onClick={isListening ? speech.stop : open ? dismiss : startQuestion}
          aria-label={isListening ? 'Stop and send' : open ? 'Close' : 'Ask a question'}
          className={[
            'absolute bottom-3 right-5 flex size-14 items-center justify-center',
            'rounded-full text-white shadow-lg transition-colors',
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
      </div>
    </>
  )
}

/** Outgoing message — the student's speech, right-aligned in a muted accent
 *  bubble. Accent is dark in both themes, so white text reads on either. */
function StudentBubble({ text, live }) {
  return (
    <div
      className={[
        'ml-auto max-w-[85%] wrap-break-word rounded-2xl rounded-br-md px-4 py-2.5',
        'text-sm leading-relaxed text-white',
        live ? 'bg-accent/60' : 'bg-accent',
      ].join(' ')}
    >
      {text}
      {live && <span className="ml-0.5 animate-pulse">…</span>}
    </div>
  )
}

/** Incoming message — the tutor's answer, left-aligned in a darker bubble with
 *  their name above it. `text-pri` stays legible in both themes. */
function TutorBubble({ tutor, text }) {
  return (
    <div className="mr-auto max-w-[85%]">
      <p className="mb-1 ml-1 text-xs font-medium text-accent2">{tutor}</p>
      <div className="wrap-break-word rounded-2xl rounded-bl-md bg-surface2 px-4 py-3
                      text-sm leading-relaxed text-pri">
        {text}
      </div>
    </div>
  )
}

/** The "thinking" indicator, sitting where the tutor's answer will appear. */
function ThinkingBubble({ tutor }) {
  return (
    <div className="mr-auto max-w-[85%]">
      <p className="mb-1 ml-1 text-xs font-medium text-accent2">{tutor}</p>
      <div className="inline-flex items-center gap-1.5 rounded-2xl rounded-bl-md
                      bg-surface2 px-4 py-3.5">
        {[0, 150, 300].map((delay) => (
          <span
            key={delay}
            className="size-2 animate-bounce rounded-full bg-sec"
            style={{ animationDelay: `${delay}ms` }}
          />
        ))}
      </div>
    </div>
  )
}
