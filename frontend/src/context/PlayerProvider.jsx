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

  const [lecture, setLecture] = useState(null)
  const [chunks, setChunks] = useState([])
  const [durations, setDurations] = useState([])
  const [chunkIndex, setChunkIndex] = useState(0)
  const [position, setPosition] = useState(0)
  const [playing, setPlaying] = useState(false)
  const [speed, setSpeed] = useState(1)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)
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

  const timeline = useMemo(
    () => buildTimeline(splitSentences(lecture?.transcript || ''), chunks, durations),
    [lecture?.transcript, chunks, durations],
  )

  const duration = useMemo(
    () => totalDuration(chunks, durations),
    [chunks, durations],
  )

  /** Lazily build the Web Audio graph. Must follow a user gesture, or the
   *  context starts suspended and the bars never move. */
  const ensureAnalyser = useCallback(() => {
    const audio = audioRef.current
    if (analyserRef.current || !audio) return analyserRef.current
    const Ctx = window.AudioContext || window.webkitAudioContext
    if (!Ctx) return null

    try {
      const ctx = new Ctx()
      const source = ctx.createMediaElementSource(audio)
      const analyser = ctx.createAnalyser()
      analyser.fftSize = 128
      analyser.smoothingTimeConstant = 0.8
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

  /** Point the element at a chunk and optionally seek within it. */
  const loadChunk = useCallback(
    (index, offset = 0, autoplay = false) => {
      const audio = audioRef.current
      const chunk = chunks[index]
      if (!audio || !chunk?.url) return

      setChunkIndex(index)
      audio.src = chunk.url
      audio.playbackRate = speed
      audio.currentTime = 0

      const start = () => {
        if (offset > 0) audio.currentTime = Math.min(offset, audio.duration || offset)
        if (autoplay) audio.play().catch(() => setPlaying(false))
      }
      if (audio.readyState >= 1) start()
      else audio.addEventListener('loadedmetadata', start, { once: true })
    },
    [chunks, speed],
  )

  /** Load a lecture by id and restore its saved position. */
  const open = useCallback(
    async (lectureId, { autoplay = false } = {}) => {
      setLoading(true)
      setError(null)
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
        loadChunk(index, offset, autoplay)
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
      setMinimised(false)

      const startAt = lectureRow?.last_position_secs || 0
      setPosition(startAt)
      if (list.length) {
        const { index, offset } = locateChunk(startAt, list)
        loadChunk(index, offset, autoplay)
      }
    },
    [loadChunk],
  )

  const play = useCallback(() => {
    const audio = audioRef.current
    if (!audio) return
    ensureAnalyser()
    audioCtxRef.current?.resume?.()
    audio.play().catch(() => setPlaying(false))
  }, [ensureAnalyser])

  const pause = useCallback(() => {
    audioRef.current?.pause()
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

    const onError = () => setError('Audio failed to load.')

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

  // --- Media Session (lock screen / headset controls) ---------------------
  useEffect(() => {
    if (!('mediaSession' in navigator) || !lecture) return

    navigator.mediaSession.metadata = new window.MediaMetadata({
      title: lecture.title || 'Lecture',
      artist: lecture.tutor_voice === 'sophia' ? 'Sophia' : 'Marcus',
      album: 'AI Study Tutor',
      artwork: [
        { src: '/artwork-512.png', sizes: '512x512', type: 'image/png' },
        { src: '/artwork-192.png', sizes: '192x192', type: 'image/png' },
      ],
    })

    const handlers = [
      ['play', () => play()],
      ['pause', () => pause()],
      ['seekbackward', () => skip(-SKIP_SECONDS)],
      ['seekforward', () => skip(SKIP_SECONDS)],
      ['seekto', (details) => details.seekTime != null && seek(details.seekTime)],
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
  }, [lecture, play, pause, skip, seek])

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
      loading, error, minimised, chunkIndex,
      open, openWith, play, pause, toggle, seek, skip, changeSpeed, close,
      setMinimised,
      getAnalyser: () => analyserRef.current,
      ensureAnalyser,
      SKIP_SECONDS,
    }),
    [lecture, chunks, timeline, duration, position, playing, speed, loading,
     error, minimised, chunkIndex, open, openWith, play, pause, toggle, seek,
     skip, changeSpeed, close, ensureAnalyser],
  )

  return <PlayerContext.Provider value={value}>{children}</PlayerContext.Provider>
}
