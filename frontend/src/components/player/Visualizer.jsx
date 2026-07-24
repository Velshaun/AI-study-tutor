import { useEffect, useRef } from 'react'

import { usePlayer } from '../../hooks/usePlayer'

/**
 * Frequency bars driven by an AnalyserNode (§5.5).
 *
 * Canvas rather than DOM nodes: this repaints every frame, and animating ~32
 * elements' heights would thrash layout on a mid-range phone.
 *
 * Falls back to a gentle idle wave when there's no analyser — Safari refuses a
 * second MediaElementSource for the same element, and a cross-origin failure
 * yields all-zero data. Flat dead bars during audible playback look broken, so
 * the fallback keeps motion without pretending to be real data.
 */
export default function Visualizer({ className = '' }) {
  const canvasRef = useRef(null)
  const frameRef = useRef(0)
  const { getAnalyser, playing } = usePlayer()

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const BARS = 32
    let phase = 0

    const resize = () => {
      const ratio = window.devicePixelRatio || 1
      const { width, height } = canvas.getBoundingClientRect()
      canvas.width = Math.max(1, Math.floor(width * ratio))
      canvas.height = Math.max(1, Math.floor(height * ratio))
      ctx.setTransform(ratio, 0, 0, ratio, 0, 0)
    }
    resize()
    window.addEventListener('resize', resize)

    const accent = getComputedStyle(document.documentElement)
      .getPropertyValue('--color-accent').trim() || '#6C63FF'
    const accent2 = getComputedStyle(document.documentElement)
      .getPropertyValue('--color-accent2').trim() || '#8B85FF'

    const draw = () => {
      frameRef.current = requestAnimationFrame(draw)

      const { width, height } = canvas.getBoundingClientRect()
      ctx.clearRect(0, 0, width, height)

      const analyser = getAnalyser()
      let values

      if (analyser) {
        const data = new Uint8Array(analyser.frequencyBinCount)
        analyser.getByteFrequencyData(data)
        // Low bins carry most speech energy; sample the lower half so the bars
        // respond to voice rather than sitting flat in the treble.
        const usable = Math.floor(data.length * 0.7)
        values = Array.from({ length: BARS }, (_, i) => {
          const start = Math.floor((i / BARS) * usable)
          const end = Math.floor(((i + 1) / BARS) * usable)
          let sum = 0
          for (let j = start; j < end; j += 1) sum += data[j]
          return (sum / Math.max(1, end - start)) / 255
        })
      } else {
        values = null
      }

      const silent = !values || values.every((v) => v < 0.01)
      if (silent) {
        phase += playing ? 0.08 : 0.02
        values = Array.from({ length: BARS }, (_, i) => {
          const wave = Math.sin(phase + i * 0.35) * 0.5 + 0.5
          return playing ? 0.15 + wave * 0.35 : 0.06 + wave * 0.06
        })
      }

      const gap = 3
      const barWidth = (width - gap * (BARS - 1)) / BARS
      const gradient = ctx.createLinearGradient(0, height, 0, 0)
      gradient.addColorStop(0, accent)
      gradient.addColorStop(1, accent2)
      ctx.fillStyle = gradient

      values.forEach((value, i) => {
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
