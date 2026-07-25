import { ArrowLeft, Pencil } from 'lucide-react'
import { useState } from 'react'

/**
 * The one page heading used everywhere.
 *
 * A bold, centred gradient title (white → accent) over a short accent rule and
 * a calm muted subtitle. The back link and any actions sit in a row above the
 * centred title so they don't fight its alignment.
 *
 * Pass `onRename` to make the title editable inline: tap/click switches it to an
 * input, blur or Enter saves. A pencil hints that it's editable.
 */
const TITLE_CLASS =
  'title-gradient text-balance text-[2rem] font-extrabold leading-tight tracking-tight sm:text-[2.5rem]'

export default function PageTitle({
  children,
  subtitle,
  actions,
  onBack,
  backLabel = 'Back',
  onRename,
}) {
  const editable = typeof onRename === 'function'
  const [editing, setEditing] = useState(false)
  const [name, setName] = useState('')

  function startEdit() {
    setName(typeof children === 'string' ? children : '')
    setEditing(true)
  }
  function commit() {
    const next = name.trim()
    setEditing(false)
    if (next && next !== children) onRename(next)
  }

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
        {editable && editing ? (
          <input
            autoFocus
            value={name}
            maxLength={200}
            onChange={(e) => setName(e.target.value)}
            onBlur={commit}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                commit()
              } else if (e.key === 'Escape') {
                setEditing(false)
              }
            }}
            aria-label="Edit title"
            className="w-full max-w-md rounded-xl border border-accent bg-surface2 px-3 py-1.5
                       text-center text-[2rem] font-extrabold leading-tight tracking-tight
                       text-pri focus:outline-none sm:text-[2.5rem]"
          />
        ) : editable ? (
          <button
            onClick={startEdit}
            title="Rename"
            className="group inline-flex items-center gap-2"
          >
            <h1 className={TITLE_CLASS}>{children}</h1>
            <Pencil
              size={17}
              className="shrink-0 text-sec opacity-50 transition-opacity group-hover:opacity-100"
              aria-hidden="true"
            />
          </button>
        ) : (
          <h1 className={TITLE_CLASS}>{children}</h1>
        )}

        <span className="mt-3 h-1 w-12 rounded-full bg-accent" aria-hidden="true" />
        {subtitle && (
          <p className="mt-3 text-[13px] font-normal text-[#888888]">{subtitle}</p>
        )}
      </div>
    </header>
  )
}
