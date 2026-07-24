import { AnimatePresence, motion } from 'framer-motion'
import { AlertCircle, CheckCircle2, Info, X } from 'lucide-react'
import { useCallback, useMemo, useRef, useState } from 'react'

import { ToastContext } from './toast-context'

/**
 * Lightweight toast host — spec Prompt 10 (item 4).
 *
 * Toasts stack at the bottom, above the tab bar and any minimised player, and
 * auto-dismiss. Success/error/info share one surface; errors stay a beat longer
 * since they carry something the learner has to read. Purely client-side — no
 * portal library, the fixed container sits at the app root.
 */

const ICONS = {
  success: CheckCircle2,
  error: AlertCircle,
  info: Info,
}

const TONE = {
  success: 'text-success',
  error: 'text-warning',
  info: 'text-accent2',
}

const DEFAULT_MS = 3500
const ERROR_MS = 5500
const ACTION_MS = 8000

export function ToastProvider({ children }) {
  const [toasts, setToasts] = useState([])
  const seq = useRef(0)

  const dismiss = useCallback((id) => {
    setToasts((list) => list.filter((t) => t.id !== id))
  }, [])

  const push = useCallback(
    ({ message, type = 'info', duration, action }) => {
      if (!message) return
      seq.current += 1
      const id = seq.current
      setToasts((list) => [...list, { id, message, type, action }])
      // A toast with a tap action (e.g. "Open") lingers longer so it isn't
      // gone before the learner reaches for it.
      const ms = duration ?? (action ? ACTION_MS : type === 'error' ? ERROR_MS : DEFAULT_MS)
      window.setTimeout(() => dismiss(id), ms)
      return id
    },
    [dismiss],
  )

  // Convenience helpers so callers read `toast.success('Saved')`. A plain
  // object literal (not a function with attached props) keeps the React
  // Compiler's immutability rule happy.
  const value = useMemo(
    () => ({
      push,
      dismiss,
      success: (message, opts) => push({ ...opts, message, type: 'success' }),
      error: (message, opts) => push({ ...opts, message, type: 'error' }),
      info: (message, opts) => push({ ...opts, message, type: 'info' }),
    }),
    [push, dismiss],
  )

  return (
    <ToastContext.Provider value={value}>
      {children}

      <div
        className="pointer-events-none fixed inset-x-0 z-60 flex flex-col items-center gap-2
                   px-4 bottom-[calc(5.5rem+env(safe-area-inset-bottom))]
                   md:bottom-[calc(1.5rem+env(safe-area-inset-bottom))]"
        aria-live="polite"
        role="status"
      >
        <AnimatePresence initial={false}>
          {toasts.map((t) => {
            const Icon = ICONS[t.type] || Info
            return (
              <motion.div
                key={t.id}
                layout
                initial={{ opacity: 0, y: 16, scale: 0.96 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={{ opacity: 0, y: 8, scale: 0.96 }}
                transition={{ duration: 0.2 }}
                className="pointer-events-auto flex w-full max-w-sm items-center gap-3 rounded-xl
                           border border-border bg-surface2/95 px-4 py-3 shadow-lg backdrop-blur"
              >
                <Icon
                  size={18}
                  className={`shrink-0 ${TONE[t.type] || TONE.info}`}
                  aria-hidden="true"
                />
                <p className="min-w-0 flex-1 text-sm text-pri">{t.message}</p>
                {t.action && (
                  <button
                    onClick={() => {
                      t.action.onClick?.()
                      dismiss(t.id)
                    }}
                    className="shrink-0 rounded-lg px-2 py-1 text-sm font-semibold text-accent2
                               transition-colors hover:bg-accent/10 hover:text-accent"
                  >
                    {t.action.label}
                  </button>
                )}
                <button
                  onClick={() => dismiss(t.id)}
                  aria-label="Dismiss"
                  className="btn-ghost -mr-2 flex size-8 shrink-0 items-center justify-center rounded-full p-0"
                >
                  <X size={15} aria-hidden="true" />
                </button>
              </motion.div>
            )
          })}
        </AnimatePresence>
      </div>
    </ToastContext.Provider>
  )
}
