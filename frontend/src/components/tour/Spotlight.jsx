import { useEffect, useState } from 'react'

/**
 * A hole in a dimmed screen, over a real element.
 *
 * The dim is a single enormous `box-shadow` spread from the hole rather than an
 * overlay with a cut-out: there is no second element to keep aligned, the
 * target underneath stays genuinely visible and un-tinted, and the whole thing
 * animates by moving one rectangle. A mask or a four-panel overlay both work
 * and both drift a pixel during the transition, which is exactly the frame
 * somebody is looking at.
 *
 * The hole does not swallow taps. Onboarding that blocks the thing it is
 * pointing at teaches people to dismiss onboarding — `pointer-events: none` on
 * the shade, so the target is still usable while it is being explained.
 */
const PAD = 8

export default function Spotlight({ target, radius = 16, onBackdrop }) {
  const rect = useRect(target)
  if (!rect) return null

  return (
    <>
      {/* The dim. Its own layer so the ring can sit above it without
          inheriting the shadow. */}
      <div
        onClick={onBackdrop}
        aria-hidden="true"
        className="pointer-events-auto fixed inset-0 z-[90]"
        style={{ background: 'transparent' }}
      />
      <div
        aria-hidden="true"
        className="pointer-events-none fixed z-[91]"
        style={{
          top: rect.top - PAD,
          left: rect.left - PAD,
          width: rect.width + PAD * 2,
          height: rect.height + PAD * 2,
          borderRadius: radius,
          boxShadow: '0 0 0 9999px rgba(8, 10, 20, 0.72)',
          transition:
            'top .42s cubic-bezier(.32,.72,0,1), left .42s cubic-bezier(.32,.72,0,1),'
            + ' width .42s cubic-bezier(.32,.72,0,1), height .42s cubic-bezier(.32,.72,0,1)',
        }}
      />
      {/* The ring: a soft gradient edge so the hole reads as lit rather than
          cut. Slightly larger than the hole and blurred, which is what stops it
          looking like a 2005 tooltip border. */}
      <div
        aria-hidden="true"
        className="pointer-events-none fixed z-[92]"
        style={{
          top: rect.top - PAD,
          left: rect.left - PAD,
          width: rect.width + PAD * 2,
          height: rect.height + PAD * 2,
          borderRadius: radius,
          background:
            'linear-gradient(135deg, rgba(108,99,255,.55), rgba(56,232,225,.35) 60%, transparent)',
          WebkitMask:
            'linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0)',
          WebkitMaskComposite: 'xor',
          maskComposite: 'exclude',
          padding: 2,
          filter: 'drop-shadow(0 0 14px rgba(108,99,255,.55))',
          transition:
            'top .42s cubic-bezier(.32,.72,0,1), left .42s cubic-bezier(.32,.72,0,1),'
            + ' width .42s cubic-bezier(.32,.72,0,1), height .42s cubic-bezier(.32,.72,0,1)',
        }}
      />
    </>
  )
}

/**
 * Track a target's position on screen.
 *
 * Re-measured on scroll and resize because a spotlight that stays where the
 * element used to be is worse than none: it points confidently at the wrong
 * thing. `getBoundingClientRect` is viewport-relative, which is what `fixed`
 * wants, so there is no scroll offset to add and nothing to get wrong.
 */
function useRect(target) {
  const [state, setState] = useState({ target: null, rect: null })
  const rect = state.target === target ? state.rect : null

  useEffect(() => {
    const el = typeof target === 'string' ? document.querySelector(target) : target
    // No target: nothing to measure and nothing to clear. `rect` is keyed to
    // the target through the dependency, so a stale one cannot survive a
    // change — writing null here would only be a synchronous setState in an
    // effect, which the repo forbids for good reason.
    if (!el) return undefined
    const measure = () => {
      const r = el.getBoundingClientRect()
      setState({
        target,
        rect: { top: r.top, left: r.left, width: r.width, height: r.height },
      })
    }
    measure()
    // Bring it into view first — a spotlight below the fold is a dimmed screen
    // with nothing in it.
    el.scrollIntoView({ block: 'center', behavior: 'smooth' })
    const onMove = () => measure()
    window.addEventListener('scroll', onMove, true)
    window.addEventListener('resize', onMove)
    const observer = new ResizeObserver(measure)
    observer.observe(el)
    return () => {
      window.removeEventListener('scroll', onMove, true)
      window.removeEventListener('resize', onMove)
      observer.disconnect()
    }
  }, [target])

  return rect
}
