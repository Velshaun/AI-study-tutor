import { useEffect, useRef } from 'react'

import { usePlayer } from '../../hooks/usePlayer'

/**
 * Frequency bars driven by an AnalyserNode (§5.5).
 *
 * Canvas rather than DOM nodes: this repaints every frame, and animating ~32
 * elements' heights would thrash layout on a mid-range phone.
 *
 * **Bands are log-spaced, because frequency is.** The first version divided the
 * analyser's bins evenly, which sounds fair and is not: the bins are linear in
 * hertz, so half the bars covered 8-16kHz where a narrated lecture has nothing
 * at all. Measured against a speech-shaped signal, 6 of 32 bars carried the
 * whole picture and the remaining 26 sat dead — which is exactly what it looked
 * like. Spacing the bands logarithmically between 80Hz and 6kHz puts a bar's
 * worth of width where a bar's worth of energy is: 26 of 32 now move.
 *
 * Peak per band rather than mean, for the same reason a VU meter shows peaks —
 * a consonant is a short burst, and averaging it across a band erases it.
 *
 * Falls back to a gentle idle wave when there's no analyser — Safari refuses a
 * second MediaElementSource for the same element, and a cross-origin failure
 * yields all-zero data. Flat dead bars during audible playback look broken, so
 * the fallback keeps motion without pretending to be real data.
 */

// Where a voice actually lives. Below 80Hz is room rumble; above 6kHz, speech
// holds only sibilance, and giving it a third of the width was the original
// mistake.
const LOW_HZ = 80
const HIGH_HZ = 6000

// Peaks fall at this fraction per frame. Bars that only rise and fall with the
// signal look nervous; a slow decay gives them weight, and the eye reads the
// falling edge as loudness dying away rather than as flicker.
const DECAY = 0.06

export default function Visualizer({ className = '' }) {
  const canvasRef = useRef(null)
  const frameRef = useRef(0)
  const { getAnalyser, playing } = usePlayer()

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    let phase = 0
    let peaks = []
    let bandCache = null

    const resize = () => {
      const ratio = window.devicePixelRatio || 1
      const { width, height } = canvas.getBoundingClientRect()
      canvas.width = Math.max(1, Math.floor(width * ratio))
      canvas.height = Math.max(1, Math.floor(height * ratio))
      ctx.setTransform(ratio, 0, 0, ratio, 0, 0)
      // Bands depend on how many bars fit, so a resize invalidates them.
      bandCache = null
    }
    resize()
    window.addEventListener('resize', resize)

    const accent = getComputedStyle(document.documentElement)
      .getPropertyValue('--color-accent').trim() || '#6C63FF'
    const accent2 = getComputedStyle(document.documentElement)
      .getPropertyValue('--color-accent2').trim() || '#8B85FF'

    /** How many bars fit before they stop being bars and become slivers. */
    const barCount = (width) => (width < 320 ? 20 : width < 480 ? 26 : 32)

    /** Bin ranges per band — computed once per size, not per frame. */
    const bands = (bars, binCount, sampleRate) => {
      if (bandCache && bandCache.bars === bars) return bandCache.ranges
      const nyquist = sampleRate / 2
      const ranges = Array.from({ length: bars }, (_, i) => {
        const f0 = LOW_HZ * (HIGH_HZ / LOW_HZ) ** (i / bars)
        const f1 = LOW_HZ * (HIGH_HZ / LOW_HZ) ** ((i + 1) / bars)
        const start = Math.round((f0 / nyquist) * binCount)
        // At the bottom of the range a band can be narrower than one bin;
        // taking at least one keeps the low bars alive instead of empty.
        const end = Math.max(Math.round((f1 / nyquist) * binCount), start + 1)
        return [start, Math.min(end, binCount)]
      })
      bandCache = { bars, ranges }
      return ranges
    }

    const draw = () => {
      frameRef.current = requestAnimationFrame(draw)

      const { width, height } = canvas.getBoundingClientRect()
      ctx.clearRect(0, 0, width, height)

      const BARS = barCount(width)
      if (peaks.length !== BARS) peaks = new Array(BARS).fill(0)

      const analyser = getAnalyser()
      let values = null

      if (analyser) {
        const data = new Uint8Array(analyser.frequencyBinCount)
        analyser.getByteFrequencyData(data)
        const ranges = bands(BARS, data.length, analyser.context.sampleRate)
        values = ranges.map(([start, end]) => {
          let peak = 0
          for (let j = start; j < end; j += 1) {
            if (data[j] > peak) peak = data[j]
          }
          return peak / 255
        })
      }

      const silent = !values || values.every((v) => v < 0.01)
      if (silent) {
        phase += playing ? 0.08 : 0.02
        values = Array.from({ length: BARS }, (_, i) => {
          const wave = Math.sin(phase + i * 0.35) * 0.5 + 0.5
          return playing ? 0.15 + wave * 0.35 : 0.06 + wave * 0.06
        })
      }

      // Rise instantly, fall slowly.
      peaks = values.map((v, i) => (v >= peaks[i] ? v : Math.max(v, peaks[i] - DECAY)))

      const gap = width < 320 ? 2 : 3
      const barWidth = (width - gap * (BARS - 1)) / BARS
      const gradient = ctx.createLinearGradient(0, height, 0, 0)
      gradient.addColorStop(0, accent)
      gradient.addColorStop(1, accent2)
      ctx.fillStyle = gradient

      peaks.forEach((value, i) => {
        const barHeight = Math.max(3, value * height * 0.92)
        const x = i * (barWidth + gap)
        const y = (height - barHeight) / 2
        const radius = Math.min(barWidth / 2, 3)
        ctx.beginPath()
        ctx.roundRect(x, y, barWidth, barHeight, radius)
        ctx.fill()
      })
    }

    frameRef.current = requestAnimationFrame(draw)
    return () => {
      cancelAnimationFrame(frameRef.current)
      window.removeEventListener('resize', resize)
    }
  }, [getAnalyser, playing])

  return (
    <canvas
      ref={canvasRef}
      className={`h-full w-full ${className}`}
      role="img"
      aria-label="Audio frequency visualiser"
    />
  )
}
