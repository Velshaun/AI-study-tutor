import { X } from 'lucide-react'

/**
 * A dismissable inline error / validation banner.
 *
 * App-wide rule: no error message should ever trap the user. Every banner shown
 * through this component carries an X in its top-right corner that clears it and
 * hands control back — pass `onDismiss` (local `setError(null)`, a react-query
 * `mutation.reset()`, etc.). Renders nothing when there is no message.
 *
 * For errors inside a Modal, the modal's own X is the primary exit; this banner
 * adds a second, in-place dismissal so a stale message can be cleared without
 * closing the whole dialog.
 */
export default function ErrorBanner({ message, onDismiss, className = '' }) {
  if (!message) return null
  return (
    <div
      role="alert"
      className={[
        'relative rounded-xl border border-warning/40 bg-warning/10 px-4 py-3',
        'text-sm text-warning',
        onDismiss ? 'pe-10' : '',
        className,
      ].join(' ')}
    >
      {message}
      {onDismiss && (
        <button
          type="button"
          onClick={onDismiss}
          aria-label="Dismiss"
          className="absolute right-1.5 top-1.5 flex size-7 items-center justify-center
                     rounded-full text-warning/80 transition-colors
                     hover:bg-warning/15 hover:text-warning"
        >
          <X size={15} aria-hidden="true" />
        </button>
      )}
    </div>
  )
}
