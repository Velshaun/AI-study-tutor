import { ArrowLeft } from 'lucide-react'

/**
 * The one page heading used everywhere.
 *
 * A bold, centred gradient title (white → accent) over a short accent rule and
 * a calm muted subtitle — a product surface, not a default label. The back link
 * and any actions sit in a row above the centred title so they don't fight its
 * alignment. No screen hand-rolls its own <h1>.
 */
export default function PageTitle({
  children,
  subtitle,
  actions,
  onBack,
  backLabel = 'Back',
}) {
  return (
    <header className="space-y-4">
      {(onBack || actions) && (
        <div
          className={`flex items-center gap-3 ${
            onBack ? 'justify-between' : 'justify-end'
          }`}
        >
          {onBack && (
            <button onClick={onBack} className="btn-ghost -ml-2">
              <ArrowLeft size={16} aria-hidden="true" />
              {backLabel}
            </button>
          )}
          {actions && <div className="flex items-center gap-2">{actions}</div>}
        </div>
      )}

      <div className="flex flex-col items-center text-center">
        <h1 className="title-gradient text-balance text-[2rem] font-extrabold leading-tight tracking-tight sm:text-[2.5rem]">
          {children}
        </h1>
        <span
          className="mt-3 h-1 w-12 rounded-full bg-accent"
          aria-hidden="true"
        />
        {subtitle && (
          <p className="mt-3 text-[13px] font-normal text-[#888888]">{subtitle}</p>
        )}
      </div>
    </header>
  )
}
