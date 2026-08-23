import { ArrowRight, X } from 'lucide-react'
import { useEffect, useState } from 'react'

/**
 * The card that does the talking, placed beside whatever is lit.
 *
 * Above the target if there is room below the halfway line, below it otherwise
 * — one rule, because a card that flips between four positions is a card whose
 * position the reader has to find each time.
 */
export default function TourCard({
  target, title, body, step, total, onNext, onSkip, cta = 'Got it',
}) {
  const place = usePlacement(target)

  return (
    <div
      role="dialog"
      aria-label={title}
      className="fixed z-[95] w-[min(22rem,calc(100vw-2rem))] tour-card-in"
      style={place}
    >
      <div
        className="relative overflow-hidden rounded-2xl border border-white/10 p-4
                   text-white shadow-2xl backdrop-blur-xl"
        style={{
          background:
            'linear-gradient(150deg, rgba(38,38,64,.96), rgba(20,20,34,.96))',
        }}
      >
        {/* A soft wash across the top edge, so the card belongs to the same
            light source as the ring rather than being a grey box near it. */}
        <span
          aria-hidden="true"
          className="pointer-events-none absolute inset-x-0 -top-16 h-32 opacity-70"
          style={{
            background:
              'radial-gradient(60% 100% at 50% 100%, rgba(108,99,255,.55), transparent)',
          }}
        />
        <div className="relative">
          <div className="flex items-start gap-2">
            <p className="min-w-0 flex-1 text-sm font-semibold">{title}</p>
            <button
              onClick={onSkip}
              aria-label="Dismiss"
              className="-me-1 -mt-1 flex size-7 shrink-0 items-center justify-center
                         rounded-lg text-white/50 transition-colors hover:bg-white/10
                         hover:text-white"
            >
              <X size={14} aria-hidden="true" />
            </button>
          </div>
          <p className="mt-1.5 text-xs leading-relaxed text-white/70">{body}</p>

          <div className="mt-4 flex items-center gap-3">
            {total > 1 && (
              <span className="flex items-center gap-1.5" aria-hidden="true">
                {Array.from({ length: total }, (_, i) => (
                  <span
                    key={i}
                    className="h-1 rounded-full transition-all duration-300"
                    style={{
                      width: i === step ? 18 : 6,
                      background: i === step ? 'rgb(108,99,255)' : 'rgba(255,255,255,.25)',
                    }}
                  />
                ))}
              </span>
            )}
            <span className="flex-1" />
            <button
              onClick={onNext}
              className="inline-flex min-h-9 items-center gap-1.5 rounded-full
                         bg-white px-4 text-xs font-semibold text-[#14141f]
                         transition-transform active:scale-95"
            >
              {step === total - 1 ? cta : 'Next'}
              <ArrowRight size={13} aria-hidden="true" />
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

const GAP = 14

function usePlacement(target) {
  const [style, setStyle] = useState({ bottom: 24, left: 16 })

  useEffect(() => {
    const measure = () => {
      const el = typeof target === 'string' ? document.querySelector(target) : target
      if (!el) return
      const r = el.getBoundingClientRect()
      const below = r.bottom < window.innerHeight / 2
      const width = Math.min(352, window.innerWidth - 32)
      const left = Math.max(
        16, Math.min(r.left + r.width / 2 - width / 2, window.innerWidth - width - 16),
      )
      setStyle(
        below
          ? { top: r.bottom + GAP, left }
          : { bottom: window.innerHeight - r.top + GAP, left },
      )
    }
    measure()
    window.addEventListener('scroll', measure, true)
    window.addEventListener('resize', measure)
    return () => {
      window.removeEventListener('scroll', measure, true)
      window.removeEventListener('resize', measure)
    }
  }, [target])

  return style
}
