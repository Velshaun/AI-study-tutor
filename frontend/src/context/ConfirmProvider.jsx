import { useCallback, useRef, useState } from 'react'

import Modal from '../components/Modal'
import { ConfirmContext } from './confirm-context'

/**
 * Imperative confirmation dialog — spec Prompt 10 (item 2: confirm before
 * delete). A handler does:
 *
 *   if (await confirm({ title, message, confirmLabel, danger: true })) { ... }
 *
 * A styled modal replaces the browser's `window.confirm`, which can't match the
 * dark theme and looks out of place in an installed PWA.
 */
export function ConfirmProvider({ children }) {
  const [state, setState] = useState(null) // { title, message, confirmLabel, cancelLabel, danger }
  const resolver = useRef(null)

  const confirm = useCallback((options = {}) => {
    setState({
      title: 'Are you sure?',
      message: '',
      confirmLabel: 'Confirm',
      cancelLabel: 'Cancel',
      danger: false,
      ...options,
    })
    return new Promise((resolve) => {
      resolver.current = resolve
    })
  }, [])

  const settle = useCallback((result) => {
    resolver.current?.(result)
    resolver.current = null
    setState(null)
  }, [])

  return (
    <ConfirmContext.Provider value={confirm}>
      {children}

      <Modal
        open={state != null}
        title={state?.title || ''}
        onClose={() => settle(false)}
      >
        {state && (
          <div className="space-y-5">
            {state.message && (
              <p className="text-sm leading-relaxed text-sec">{state.message}</p>
            )}
            <div className="flex gap-3">
              <button
                onClick={() => settle(false)}
                className="btn-secondary min-h-11 flex-1"
              >
                {state.cancelLabel}
              </button>
              <button
                onClick={() => settle(true)}
                className={[
                  'min-h-11 flex-1',
                  state.danger
                    ? 'btn inline-flex items-center justify-center bg-warning text-white hover:bg-warning/90'
                    : 'btn-primary',
                ].join(' ')}
              >
                {state.confirmLabel}
              </button>
            </div>
          </div>
        )}
      </Modal>
    </ConfirmContext.Provider>
  )
}
