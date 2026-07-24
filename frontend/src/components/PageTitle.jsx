import { ArrowLeft } from 'lucide-react'

/**
 * The one page heading used everywhere.
 *
 * A large, heavy, silver title (`text-title`) reads as a product surface rather
 * than a default label. Optional back link, subtitle and right-aligned actions
 * cover every page's header shape, so no screen hand-rolls its own <h1>.
 */
export default function PageTitle({
  children,
  subtitle,
  actions,
  onBack,
  backLabel = 'Back',
}) {
  return (
    <header className="space-y-3">
      {onBack && (
        <button onClick={onBack} className="btn-ghost -ml-2">
          <ArrowLeft size={16} aria-hidden="true" />
          {backLabel}
        </button>
      )}
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-[1.75rem] font-extrabold leading-tight tracking-tight text-title sm:text-3xl">
            {children}
          </h1>
          {subtitle && <p className="mt-1.5 text-sm text-sec">{subtitle}</p>}
        </div>
        {actions && (
          <div className="flex shrink-0 items-center gap-2">{actions}</div>
        )}
      </div>
    </header>
  )
}
