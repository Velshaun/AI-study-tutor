import { useCallback, useEffect, useRef, useState } from 'react'

/**
 * Browser speech recognition — spec §5.6a, extended for the voice-first resume
 * flow (§5.6 amendment).
 *
 * Wraps the Web Speech API, which costs nothing and runs on-device, so
 * dictation never hits Whisper. Firefox has no implementation, so `supported`
 * lets callers fall back to typing rather than showing a dead mic button.
 *
 * Two behaviours matter here and neither is the API's default:
 *
 * 1. **No cut-off before speech.** The silence countdown only starts once the
 *    student has actually said something. Tapping the mic and pausing to gather
 *    a thought must not submit an empty string and close the mic.
 *
 * 2. **The mic stays open (`keepAlive`).** Chrome ends a recognition session on
 *    its own after a handful of silent seconds; the resume flow needs the mic
 *    to keep listening for a spoken "yeah" long after that. So a premature end
 *    with nothing captured restarts recognition instead of stopping. A restart
 *    cap prevents a broken mic from looping forever.
 *
 * The silence threshold itself is ours, not the engine's `onend`, because that
 * fires wildly differently across browsers. Every result — interim or final —
 * restarts a countdown, and its expiry submits. Identical everywhere.
 */

// How long a pause has to run before the utterance is treated as finished.
//
// This was 2000ms, and it was the single largest contributor to the delay
// between a learner stopping talking and the tutor starting: two seconds of
// dead air before anything else had even begun. 700ms is comfortably past the
// pauses inside a sentence — people hesitate mid-thought for 200-400ms — while
// being short enough that the reply feels like a reply.
//
// Dictation into a text box wants longer: there is no conversational turn to
// take, and cutting someone off mid-compose is worse than waiting. Callers
// that are transcribing rather than conversing pass DICTATION_SILENCE_MS.
const SILENCE_MS = 700
export const DICTATION_SILENCE_MS = 1600
// ~30 silent restarts at Chrome's ~8s cadence is roughly four minutes — long
// past the point a real student has acted, but bounded so a wedged mic can't
// spin indefinitely.
const MAX_SILENT_RESTARTS = 30

function getRecognition() {
  if (typeof window === 'undefined') return null
  const Impl = window.SpeechRecognition || window.webkitSpeechRecognition
  return Impl ? new Impl() : null
}

export function isSpeechSupported() {
  if (typeof window === 'undefined') return false
  return Boolean(window.SpeechRecognition || window.webkitSpeechRecognition)
}

export function useSpeechRecognition({
  onSubmit,
  onSpeechStart,
  silenceMs = SILENCE_MS,
  keepAlive = false,
} = {}) {
  const recognitionRef = useRef(null)
  const silenceTimer = useRef(null)
  const finalRef = useRef('')
  const listeningRef = useRef(false)
  const spokeRef = useRef(false)
  const restartsRef = useRef(0)

  // Callbacks are held in refs so the recognition handlers, registered once,
  // always call the latest closures rather than stale ones.
  const submitRef = useRef(onSubmit)
  const speechStartRef = useRef(onSpeechStart)
  const keepAliveRef = useRef(keepAlive)

  const [listening, setListening] = useState(false)
  const [transcript, setTranscript] = useState('')
  const [error, setError] = useState(null)

  useEffect(() => {
    submitRef.current = onSubmit
  }, [onSubmit])
  useEffect(() => {
    speechStartRef.current = onSpeechStart
  }, [onSpeechStart])
  useEffect(() => {
    keepAliveRef.current = keepAlive
  }, [keepAlive])

  const clearSilenceTimer = useCallback(() => {
    if (silenceTimer.current) {
      clearTimeout(silenceTimer.current)
      silenceTimer.current = null
    }
  }, [])

  const hardStop = useCallback(() => {
    clearSilenceTimer()
    listeningRef.current = false
    setListening(false)
    try {
      recognitionRef.current?.stop()
    } catch {
      /* already stopped */
    }
  }, [clearSilenceTimer])

  /** Stop and hand the captured text to the caller. */
  const finish = useCallback(() => {
    const text = (finalRef.current || '').trim()
    hardStop()
    finalRef.current = ''
    if (text) submitRef.current?.(text)
    else setTranscript('')
  }, [hardStop])

  const armSilenceTimer = useCallback(() => {
    clearSilenceTimer()
    silenceTimer.current = setTimeout(finish, silenceMs)
  }, [clearSilenceTimer, finish, silenceMs])

  const start = useCallback(() => {
    if (listeningRef.current) return
    const recognition = getRecognition()
    if (!recognition) {
      setError('Speech recognition is not available in this browser.')
      return
    }

    recognition.continuous = true
    recognition.interimResults = true
    recognition.lang = navigator.language || 'en-GB'

    recognition.onresult = (event) => {
      if (!spokeRef.current) {
        spokeRef.current = true
        restartsRef.current = 0
        speechStartRef.current?.()
      }
      let interim = ''
      for (let i = event.resultIndex; i < event.results.length; i += 1) {
        const result = event.results[i]
        if (result.isFinal) finalRef.current += result[0].transcript
        else interim += result[0].transcript
      }
      setTranscript((finalRef.current + interim).trim())
      // Any speech — even mid-word — restarts the countdown. Only armed here,
      // so a silent mic never submits an empty string.
      armSilenceTimer()
    }

    recognition.onerror = (event) => {
      if (event.error === 'no-speech' || event.error === 'aborted') return
      setError(
        event.error === 'not-allowed' || event.error === 'service-not-allowed'
          ? 'Microphone access was blocked. Allow it in your browser settings.'
          : `Speech recognition failed (${event.error}).`,
      )
      hardStop()
    }

    recognition.onend = () => {
      if (!listeningRef.current) return

      // Speech was captured before the engine gave up — submit it.
      if (finalRef.current.trim()) {
        finish()
        return
      }

      // Nothing yet. Keep the mic open if asked, else close.
      if (keepAliveRef.current && restartsRef.current < MAX_SILENT_RESTARTS) {
        restartsRef.current += 1
        try {
          recognition.start()
        } catch {
          // A restart can race the engine's own teardown; drop to closed.
          hardStop()
          setTranscript('')
        }
      } else {
        finish()
      }
    }

    recognitionRef.current = recognition
    finalRef.current = ''
    spokeRef.current = false
    restartsRef.current = 0
    setTranscript('')
    setError(null)
    listeningRef.current = true
    setListening(true)

    try {
      recognition.start()
      // No silence timer here — it arms on first speech.
    } catch {
      listeningRef.current = false
      setListening(false)
      setError('Could not start the microphone.')
    }
  }, [armSilenceTimer, finish, hardStop])

  /** Abandon without submitting. Clears any error too, so a caller dismissing
   *  the mic (e.g. "Back to the lecture") isn't left stuck in an error state —
   *  the error lives here, not in the caller, so only this can clear it. */
  const cancel = useCallback(() => {
    finalRef.current = ''
    spokeRef.current = false
    setTranscript('')
    setError(null)
    clearSilenceTimer()
    listeningRef.current = false
    setListening(false)
    try {
      recognitionRef.current?.abort()
    } catch {
      /* ignore */
    }
  }, [clearSilenceTimer])

  /** Clear the last error without otherwise touching recognition state. */
  const clearError = useCallback(() => setError(null), [])

  useEffect(() => () => {
    clearSilenceTimer()
    listeningRef.current = false
    try {
      recognitionRef.current?.abort()
    } catch {
      /* ignore */
    }
  }, [clearSilenceTimer])

  return {
    supported: isSpeechSupported(),
    listening,
    transcript,
    error,
    start,
    stop: finish, // submit what's captured now
    cancel,
    clearError,
  }
}
