import { useContext } from 'react'

import { ToastContext } from '../context/toast-context'

/**
 * Show toasts: `toast.success('Saved')`, `toast.error(msg)`, `toast.info(msg)`,
 * or `toast({ message, type, duration })`.
 */
export function useToast() {
  const context = useContext(ToastContext)
  if (!context) {
    throw new Error('useToast must be used inside <ToastProvider>')
  }
  return context
}
