import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { apiFetch } from '../lib/api'
import {
  buildTimeline,
  chunkStartTime,
  locateChunk,
  splitSentences,
  totalDuration,
} from '../lib/transcript'
import { POSITION_SAVE_MS, SKIP_SECONDS } from '../lib/playerConstants'
import { PlayerContext } from './player-context'

// A 44-byte silent WAV (zero samples). Played inside the mic-tap gesture to
// unlock the answer element on iOS, where an element must play once from a user
// gesture before it may play programmatically.
const SILENT_WAV =
  'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEARKwAAIhYAQACABAAZGF0YQAAAAA='

// iOS (iPhone + iPadOS, which reports as MacIntel with touch). On iOS, routing a
// media element through an AudioContext hands its output to Web Audio, which the
// OS suspends the moment the app is backgrounded or the screen locks — silencing
// playback. A plain <audio> element keeps playing in the background. So on iOS we
// never build the analyser graph: reliable background audio matters more than the
// visualiser, which falls back to a gentle idle wave anyway.
const IS_IOS =
  typeof navigator !== 'undefined' &&
  (/iP(hone|ad|od)/.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1))

/**
 * Audio playback for lectures — spec §5.5.
 *
 * Lives above the router so the minimised bar survives navigation; unmounting
 * on route change would stop the audio, which is the opposite of what a
 * mini-player is for.
 *
 * Three things drive the shape of this:
 *
 * 1. **A lecture is many MP3s, not one.** OpenAI caps TTS input at ~4096
 *    characters, so §4.4 stores an ordered set of chunks. Playback stitches
 *    them: one `<audio>` element re-pointed at the next chunk on `ended`, with
 *    a running offset so the rest of the app sees one continuous timeline.
 * 2. **Real durations only arrive as chunks load.** The stored `duration_secs`
 *    is estimated from word count, so durations are corrected from metadata as
 *    each chunk loads and the timeline is rebuilt.
 * 3. **The analyser needs CORS.** `createMediaElementSource` on a tainted
 *    element yields silence, so the element is `crossOrigin="anonymous"` —
 *    Supabase signed URLs return `Access-Control-Allow-Origin: *`.
 */

export function PlayerProvider({ children }) {
  const audioCtxRef = useRef(null)
  const analyserRef = useRef(null)
  const sourceRef = useRef(null)
  const savedAtRef = useRef(0)
  // Whether playback is currently *intended*. Guards the async chunk-load path:
  // if a pause lands between requesting a chunk and its metadata arriving, the
  // deferred autoplay must not fire and resurrect audio after the user paused.
  const playIntentRef = useRef(false)
  // Where the element should be inside the current chunk.
  //
  // A browser silently ignores `currentTime` written while `readyState` is 0,
  // and a fresh `src` resets it to 0 — so every seek made between opening a
  // lecture and its first chunk reporting metadata was dropped on the floor.
  // React's `position` moved, the element did not, and then the deferred seek
  // registered at load time put the element back at the *saved* position. That
  // is the whole of "rewinding does nothing": the bar moved, the audio didn't,
  // and the first `timeupdate` after play snapped the bar back.
  //
  // So the wanted offset lives here rather than in the closure that registered
  // the handler, and whichever handler runs applies the newest one.
  const pendingOffsetRef = useRef(0)
  // Which load a deferred handler belongs to. `loadedmetadata` fires on the
  // element, not on a chunk, so a handler left over from a superseded load
  // would otherwise fire against the chunk that replaced it.
  const loadTokenRef = useRef(0)

  const [lecture, setLecture] = useState(null)
  const [chunks, setChunks] = useState([])
  const [durations, setDurations] = useState([])
  const [chunkIndex, setChunkIndex] = useState(0)
  const [position, setPosition] = useState(0)
  const [playing, setPlaying] = useState(false)
  const [speed, setSpeed] = useState(1)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)
  // Kept apart from `error`: a lecture that loaded but wouldn't start is still a
  // lecture worth showing the transcript of, so this surfaces as a strip rather
  // than replacing the screen.
  const [playbackError, setPlaybackError] = useState(null)
  const [minimised, setMinimised] = useState(false)

  // One <audio> element for the whole session, held in a ref.
  //
  // A ref, not state: the element is mutated constantly (src, currentTime,
  // playbackRate), and the React Compiler treats state values as immutable and
  // rejects that. It is created in a mount effect rather than during render —
  // creating it inline would either write a ref during render (forbidden) or,
  // as a state initialiser, make it immutable. This effect is declared before
  // every other effect so `audioRef.current` is set before any listener
  // attaches. Callbacks only ever run after mount, so they read it safely.
  const audioRef = useRef(null)
  useEffect(() => {
    if (typeof Audio === 'undefined') return undefined
    const el = new Audio()
    el.preload = 'auto'
    el.crossOrigin = 'anonymous' // lets the analyser read cross-origin samples
    audioRef.current = el
    return () => {
      el.pause()
      audioRef.current = null
    }
  }, [])

  // A *second* element, dedicated to speaking Q&A answers. It's separate from
  // the lecture element so answer playback never disturbs the lecture's chunk
  // index, position tracking or analyser graph — the lecture simply stays
  // paused underneath. Owned here (not created ad hoc in VoiceInput) for one
  // reason that matters on mobile: iOS only lets an <audio> element play
  // programmatically once it has played inside a user gesture. `primeAnswerAudio`
  // unlocks it on the mic tap; `speak` can then autoplay the answer that arrives
  // a couple of seconds later, outside any gesture.
  const answerAudioRef = useRef(null)
  const answerEndedRef = useRef(null)
  const answerPrimedRef = useRef(false)
  useEffect(() => {
    if (typeof Audio === 'undefined') return undefined
    const el = new Audio()
    el.preload = 'auto'
    answerAudioRef.current = el
    return () => {
      el.pause()
      answerAudioRef.current = null
    }
  }, [])

  const timeline = useMemo(
    () => buildTimeline(splitSentences(lecture?.transcript || ''), chunks, durations),
    [lecture?.transcript, chunks, durations],
  )

  const duration = useMemo(
    () => totalDuration(chunks, durations),
    [chunks, durations],
  )

  /** Lazily build the Web Audio graph. Must follow a user gesture, or the
   *  context starts suspended and the bars never move.
   *
   *  Skipped entirely on iOS: connecting the element to Web Audio there breaks
   *  background/lock-screen playback (see IS_IOS above). The visualiser degrades
   *  to its idle wave, which is invisible while backgrounded anyway. */
  const ensureAnalyser = useCallback(() => {
    if (IS_IOS) return null
    const audio = audioRef.current
    if (analyserRef.current || !audio) return analyserRef.current
    const Ctx = window.AudioContext || window.webkitAudioContext
    if (!Ctx) return null

    try {
      const ctx = new Ctx()
      const source = ctx.createMediaElementSource(audio)
      const analyser = ctx.createAnalyser()
      // 2048 rather than 128. At 128 the analyser gives 64 bins across the
      // whole 0-24kHz range — 375Hz each — and a human voice lives almost
      // entirely under 4kHz, so a speech lecture had all of its energy inside
      // the first ten bins and nothing to say about the rest. Measured against
      // a speech-shaped signal, only 6 of the visualiser's 32 bars ever moved.
      // 2048 gives ~23Hz resolution, which is enough to separate formants.
      analyser.fftSize = 2048
      // 0.8 is a long tail for speech — syllables land at about 4Hz and were
      // being smeared into each other. 0.7 still steadies the bars without
      // hiding the rhythm of the words.
      analyser.smoothingTimeConstant = 0.7
      // The defaults (-100/-30) are set for music with a wide dynamic range.
      // Narrated speech at a consistent level sits in a much narrower band, and
      // widening the floor while lowering the ceiling uses the bars' full
      // height instead of the middle third.
      analyser.minDecibels = -85
      analyser.maxDecibels = -20
      source.connect(analyser)
      // Still route to the speakers — a MediaElementSource that isn't
      // connected to the destination plays silently.
      analyser.connect(ctx.destination)
      audioCtxRef.current = ctx
      sourceRef.current = source
      analyserRef.current = analyser
      return analyser
    } catch {
      // Safari throws if a source already exists for this element.
      return null
    }
  }, [])

  const lectureId = lecture?.id ?? null

  const persistPosition = useCallback(
    async (secs, force = false) => {
      if (!lectureId) return
      const now = Date.now()
      if (!force && now - savedAtRef.current < POSITION_SAVE_MS) return
      savedAtRef.current = now
      try {
        await apiFetch(`/lectures/${lectureId}/position`, {
          method: 'PATCH',
          body: { position_secs: Math.round(secs) },
        })
      } catch {
        // A dropped save is recoverable — the next tick retries.
      }
    },
    [lectureId],
  )

  /** Start the element, saying why it didn't rather than swallowing the reason.
   *
   *  A rejected play() used to be discarded, which is how a player with no
   *  source at all still looked like a working player: the button flicked back
   *  to "play" and nothing else ever said a word. */
  const startPlayback = useCallback((audio) => {
    audioCtxRef.current?.resume?.()
    const attempt = audio.play()
    if (!attempt?.then) return
    attempt.then(
      () => setPlaybackError(null),
      (err) => {
        setPlaying(false)
        // Routine: the src changed (a seek across a chunk boundary) before this
        // play() settled. The new load starts its own playback.
        if (err?.name === 'AbortError') return
        setPlaybackError(
          err?.name === 'NotAllowedError'
            ? 'Your browser blocked playback. Tap play to start the audio.'
            : 'That audio could not be played. Try again in a moment.',
        )
      },
    )
  }, [])

  /** Point the element at a chunk and optionally seek within it.
   *
   *  `list` exists because the chunks usually arrive in the same tick that this
   *  is called from: `open` sets them with setChunks and calls straight through,
   *  so the `chunks` this closure captured is still the *previous* render's —
   *  empty, on a first open. Reading it there found no chunk, returned early and
   *  left the element with no src at all, which is why a freshly opened lecture
   *  played nothing while the transcript still scrubbed happily. Callers that
   *  have the list to hand pass it; everyone else gets state, which by then is
   *  correct. */
  const loadChunk = useCallback(
    (index, offset = 0, autoplay = false, list = null) => {
      const audio = audioRef.current
      const chunk = (list || chunks)[index]
      if (!audio || !chunk?.url) return

      if (autoplay) playIntentRef.current = true
      setChunkIndex(index)
      setPlaybackError(null)
      pendingOffsetRef.current = offset
      const token = (loadTokenRef.current += 1)
      audio.src = chunk.url
      audio.playbackRate = speed

      const start = () => {
        // A newer load has claimed the element; this handler is about a chunk
        // that is no longer pointed at.
        if (loadTokenRef.current !== token) return
        // The newest wanted offset, not the one captured when this was
        // registered — the learner may have scrubbed while it was loading.
        const wanted = pendingOffsetRef.current
        if (wanted > 0) audio.currentTime = Math.min(wanted, audio.duration || wanted)
        // Only start if playback is still intended — a pause may have landed
        // while this chunk was loading.
        if (autoplay && playIntentRef.current) startPlayback(audio)
      }
      // A fresh src resets readyState to 0, so this almost always waits for the
      // element to report what it loaded before seeking into it.
      if (audio.readyState >= 1) start()
      else audio.addEventListener('loadedmetadata', start, { once: true })
    },
    [chunks, speed, startPlayback],
  )

  /** Load a lecture by id and restore its saved position. */
  const open = useCallback(
    async (lectureId, { autoplay = false } = {}) => {
      setLoading(true)
      setError(null)
      setPlaybackError(null)
      try {
        const detail = await apiFetch(`/lectures/${lectureId}/detail`)
        const list = (detail?.audio_chunks || []).filter((c) => c.url)

        setLecture(detail)
        setChunks(list)
        setDurations([])
        setMinimised(false)

        if (!list.length) {
          setError(
            detail?.status === 'ready'
              ? 'This lecture has no audio.'
              : 'This lecture is still generating.',
          )
          return
        }

        const startAt = detail?.last_position_secs || 0
        setPosition(startAt)
        const { index, offset } = locateChunk(startAt, list)
        loadChunk(index, offset, autoplay, list)
      } catch (err) {
        setError(err?.message || 'Could not load this lecture.')
      } finally {
        setLoading(false)
      }
    },
    [loadChunk],
  )

  /** Load from an already-fetched lecture object — avoids a second round trip
   *  when the page has the data. */
  const openWith = useCallback(
    (lectureRow, { autoplay = false } = {}) => {
      const list = (lectureRow?.audio_chunks || []).filter((c) => c.url)
      setLecture(lectureRow)
      setChunks(list)
      setDurations([])
      setError(list.length ? null : 'This lecture has no audio yet.')
      setPlaybackError(null)
      setMinimised(false)

      const startAt = lectureRow?.last_position_secs || 0
      setPosition(startAt)
      if (list.length) {
        const { index, offset } = locateChunk(startAt, list)
        loadChunk(index, offset, autoplay, list)
      }
    },
    [loadChunk],
  )

  const play = useCallback(() => {
    const audio = audioRef.current
    if (!audio) return
    playIntentRef.current = true

    // Nothing pointed at yet: load the chunk covering the current position and
    // start there. play() on a sourceless element rejects, and the only sign of
    // it used to be the button springing back — so if anything ever leaves the
    // element unloaded again, this recovers inside the tap that noticed.
    if (!audio.src && !audio.currentSrc) {
      if (!chunks.length) return
      const { index, offset } = locateChunk(position, chunks, durations)
      loadChunk(index, offset, true, chunks)
      return
    }

    // Reanchor the timeline to the audio element's true position before playing.
    // After a voice-Q&A pause the element holds the exact resume point, so this
    // snaps the transcript highlight/scroll back to it rather than leaving
    // `position` stale (or at zero). Guarded to currentTime > 0 so it never
    // clobbers a fresh load that hasn't yet seeked to its saved position.
    if (audio.currentTime > 0) {
      setPosition(chunkStartTime(chunkIndex, chunks, durations) + audio.currentTime)
    }
    ensureAnalyser()
    startPlayback(audio)
  }, [ensureAnalyser, startPlayback, loadChunk, chunkIndex, chunks, durations, position])

  const pause = useCallback(() => {
    // Drop the intent first, so any chunk still loading won't autoplay into a
    // "resumed" state behind the user's back.
    playIntentRef.current = false
    audioRef.current?.pause()
    // Suspend the Web Audio graph as well. A MediaElementAudioSourceNode keeps
    // pulling from the element through the context even after the element is
    // paused, which on some browsers leaves the last decoded buffer looping or
    // buzzing — the "last word on repeat" bug. Suspending guarantees silence.
    // No-op on iOS, where the graph is never built.
    audioCtxRef.current?.suspend?.()
  }, [])

  /** Unlock the answer element for later programmatic playback. Call this from
   *  within a user gesture (the mic tap). Idempotent. */
  const primeAnswerAudio = useCallback(() => {
    const el = answerAudioRef.current
    if (!el || answerPrimedRef.current) return
    answerPrimedRef.current = true
    try {
      el.src = SILENT_WAV
      const p = el.play()
      if (p?.then) p.then(() => el.pause()).catch(() => {})
    } catch {
      // If the browser rejects the priming clip, speak() still tries directly.
    }
  }, [])

  /** Speak a Q&A answer through the dedicated element, pausing the lecture
   *  first. `onEnded` fires when narration finishes (or can't start) — that's
   *  the signal to reopen the mic. The lecture is never resumed here. */
  const speak = useCallback(
    (url, onEnded) => {
      const el = answerAudioRef.current
      if (!el || !url) {
        onEnded?.()
        return
      }
      audioRef.current?.pause() // lecture stays paused while the tutor speaks
      if (answerEndedRef.current) {
        el.removeEventListener('ended', answerEndedRef.current)
      }
      const handler = () => {
        el.removeEventListener('ended', handler)
        answerEndedRef.current = null
        onEnded?.()
      }
      answerEndedRef.current = handler
      el.addEventListener('ended', handler)
      el.src = url
      el.currentTime = 0
      el.playbackRate = 1
      const p = el.play()
      // Autoplay blocked despite priming — hand back so the mic still reopens
      // rather than leaving the flow stuck mid-answer.
      if (p?.catch) p.catch(() => handler())
    },
    [],
  )

  /** Stop any answer narration and drop its ended handler. */
  const stopSpeaking = useCallback(() => {
    const el = answerAudioRef.current
    if (!el) return
    el.pause()
    if (answerEndedRef.current) {
      el.removeEventListener('ended', answerEndedRef.current)
      answerEndedRef.current = null
    }
  }, [])

  const toggle = useCallback(() => {
    if (playing) pause()
    else play()
  }, [playing, play, pause])

  const seek = useCallback(
    (secs) => {
      const audio = audioRef.current
      const target = Math.max(0, Math.min(secs, duration || secs))
      const { index, offset } = locateChunk(target, chunks, durations)
      setPosition(target)
      if (index === chunkIndex && audio) {
        // Record it either way. If the chunk is still loading the write below
        // is ignored by the browser, and this is what the pending
        // `loadedmetadata` handler applies instead of the position the lecture
        // opened at.
        pendingOffsetRef.current = offset
        audio.currentTime = offset
      } else {
        loadChunk(index, offset, playing)
      }
      persistPosition(target, true)
    },
    [chunks, durations, duration, chunkIndex, playing, loadChunk, persistPosition],
  )

  const skip = useCallback((delta) => seek(position + delta), [position, seek])

  const changeSpeed = useCallback((rate) => {
    setSpeed(rate)
    if (audioRef.current) audioRef.current.playbackRate = rate
  }, [])

  const close = useCallback(() => {
    pause()
    persistPosition(position, true)
    setLecture(null)
    setChunks([])
    setPosition(0)
  }, [pause, persistPosition, position])

  // --- element events -----------------------------------------------------
  // Declared after the element-creation effect above, so audioRef.current is
  // already set the first time this runs.
  useEffect(() => {
    const audio = audioRef.current
    if (!audio) return

    const onPlay = () => setPlaying(true)
    const onPause = () => setPlaying(false)

    const onTime = () => {
      const global = chunkStartTime(chunkIndex, chunks, durations) + audio.currentTime
      setPosition(global)
      persistPosition(global)
    }

    const onMeta = () => {
      // Replace the estimated duration with the real one.
      if (!Number.isFinite(audio.duration)) return
      setDurations((current) => {
        if (Math.abs((current[chunkIndex] || 0) - audio.duration) < 0.05) return current
        const next = [...current]
        next[chunkIndex] = audio.duration
        return next
      })
    }

    const onEnded = () => {
      if (chunkIndex < chunks.length - 1) {
        loadChunk(chunkIndex + 1, 0, true)
      } else {
        setPlaying(false)
        persistPosition(duration, true)
      }
    }

    // A media error mid-lecture is a playback problem, not a reason to decide
    // the lecture can't be opened — `error` is what the screen redirects on, so
    // a dropped connection must not read as "this lecture doesn't exist".
    const onError = () => {
      setPlaying(false)
      setPlaybackError('That audio failed to load. Check your connection, then tap play.')
    }

    audio.addEventListener('play', onPlay)
    audio.addEventListener('pause', onPause)
    audio.addEventListener('timeupdate', onTime)
    audio.addEventListener('loadedmetadata', onMeta)
    audio.addEventListener('ended', onEnded)
    audio.addEventListener('error', onError)
    return () => {
      audio.removeEventListener('play', onPlay)
      audio.removeEventListener('pause', onPause)
      audio.removeEventListener('timeupdate', onTime)
      audio.removeEventListener('loadedmetadata', onMeta)
      audio.removeEventListener('ended', onEnded)
      audio.removeEventListener('error', onError)
    }
  }, [chunkIndex, chunks, durations, duration, loadChunk, persistPosition])

  // --- Media Session (lock screen / notification-tray controls) -----------
  // The latest control callbacks, so the action handlers below can be
  // registered ONCE yet always call current closures. Re-registering handlers
  // (and re-creating metadata) on every timeupdate — which the old single
  // effect did, since `skip`/`seek` change with `position` — makes some
  // platforms drop or flicker the lock-screen controls.
  const mediaCtl = useRef({ play, pause, skip, seek })
  useEffect(() => {
    mediaCtl.current = { play, pause, skip, seek }
  }, [play, pause, skip, seek])

  // Register the transport handlers a single time.
  useEffect(() => {
    if (!('mediaSession' in navigator)) return undefined
    const handlers = [
      ['play', () => mediaCtl.current.play()],
      ['pause', () => mediaCtl.current.pause()],
      ['seekbackward', () => mediaCtl.current.skip(-SKIP_SECONDS)],
      ['seekforward', () => mediaCtl.current.skip(SKIP_SECONDS)],
      ['seekto', (d) => d.seekTime != null && mediaCtl.current.seek(d.seekTime)],
    ]
    for (const [action, handler] of handlers) {
      try {
        navigator.mediaSession.setActionHandler(action, handler)
      } catch {
        // Not every browser supports every action.
      }
    }
    return () => {
      for (const [action] of handlers) {
        try {
          navigator.mediaSession.setActionHandler(action, null)
        } catch { /* ignore */ }
      }
    }
  }, [])

  // Metadata — set once per lecture (title, tutor as artist, module as album).
  // Destructured deps so it doesn't re-run on every transcript/position change.
  const metaTitle = lecture?.title
  const metaTutor = lecture?.tutor_voice
  const metaAlbum = lecture?.module_title
  const hasLecture = Boolean(lecture?.id)
  useEffect(() => {
    if (!('mediaSession' in navigator) || !hasLecture) return
    navigator.mediaSession.metadata = new window.MediaMetadata({
      title: metaTitle || 'Lecture',
      artist: metaTutor === 'sophia' ? 'Sophia' : 'Marcus',
      album: metaAlbum || 'ConverseAI Tutor',
      artwork: [
        { src: '/artwork-512.png', sizes: '512x512', type: 'image/png' },
        { src: '/artwork-192.png', sizes: '192x192', type: 'image/png' },
      ],
    })
  }, [hasLecture, metaTitle, metaTutor, metaAlbum])

  // Returning from the background: while the tab was hidden, `timeupdate` stops
  // firing, so `position` (and the play/pause state) can lag what the element is
  // actually doing. Re-sync both to the element's truth, and resume the analyser
  // context if the OS suspended it. Never pauses — background audio keeps going.
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState !== 'visible') return
      const audio = audioRef.current
      if (!audio) return
      setPosition(chunkStartTime(chunkIndex, chunks, durations) + audio.currentTime)
      setPlaying(!audio.paused)
      // Only wake the Web Audio graph if audio is actually playing. Resuming the
      // context while paused would re-feed the last buffer and bring back the
      // looping-tail bug on return from the background.
      if (!audio.paused) audioCtxRef.current?.resume?.()
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => document.removeEventListener('visibilitychange', onVisible)
  }, [chunkIndex, chunks, durations])

  useEffect(() => {
    if (!('mediaSession' in navigator)) return
    navigator.mediaSession.playbackState = playing ? 'playing' : 'paused'
  }, [playing])

  // Keep the OS scrubber in step with our stitched timeline.
  useEffect(() => {
    if (!('mediaSession' in navigator) || !duration) return
    try {
      navigator.mediaSession.setPositionState({
        duration,
        playbackRate: speed,
        position: Math.min(position, duration),
      })
    } catch { /* Safari rejects some states */ }
  }, [position, duration, speed])

  // Save on unload — closing the tab mid-lecture shouldn't lose the place.
  useEffect(() => {
    const save = () => {
      if (lecture?.id && position > 0) persistPosition(position, true)
    }
    window.addEventListener('pagehide', save)
    return () => window.removeEventListener('pagehide', save)
  }, [lecture?.id, position, persistPosition])

  const value = useMemo(
    () => ({
      lecture, chunks, timeline, duration, position, playing, speed,
      loading, error, playbackError, minimised, chunkIndex,
      open, openWith, play, pause, toggle, seek, skip, changeSpeed, close,
      setMinimised,
      speak, stopSpeaking, primeAnswerAudio,
      getAnalyser: () => analyserRef.current,
      ensureAnalyser,
      SKIP_SECONDS,
    }),
    [lecture, chunks, timeline, duration, position, playing, speed, loading,
     error, playbackError, minimised, chunkIndex, open, openWith, play, pause, toggle, seek,
     skip, changeSpeed, close, speak, stopSpeaking, primeAnswerAudio,
     ensureAnalyser],
  )

  return <PlayerContext.Provider value={value}>{children}</PlayerContext.Provider>
}
