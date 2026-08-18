import { motion } from 'framer-motion'
import { X } from 'lucide-react'
import { useEffect } from 'react'

/**
 * A centred modal dialog. Closes on backdrop click or Escape; the panel stops
 * propagation so clicks inside don't dismiss it.
 *
 * Mounted conditionally rather than through AnimatePresence. An exiting child
 * there fades to opacity 0 but is not always unmounted, and this backdrop is
 * `fixed inset-0` — an invisible one still covers the viewport and swallows
 * every later tap, so the app looks frozen after a modal is dismissed. A
 * dismissal that always works is worth more than a fade on the way out.
 */
export default function Modal({ open, title, onClose, children }) {
  useEffect(() => {
    if (!open) return undefined
    const onKey = (e) => e.key === 'Escape' && onClose?.()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  if (!open) return null

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      onClick={onClose}
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/60 p-4
                 backdrop-blur-sm sm:items-center"
    >
      <motion.div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        initial={{ y: 24, opacity: 0 }}
        animate={{ y: 0, opacity: 1 }}
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-sm rounded-2xl border border-border bg-surface p-5"
      >
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-base font-semibold text-pri">{title}</h2>
          <button
            onClick={onClose}
            aria-label="Close"
            className="btn-ghost size-10 rounded-full p-0"
          >
            <X size={18} aria-hidden="true" />
          </button>
        </div>
        {children}
      </motion.div>
    </motion.div>
  )
}
