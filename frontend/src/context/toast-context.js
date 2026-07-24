import { createContext } from 'react'

/**
 * Toast context — a `push({ message, type })` function plus the live list.
 * Split from the provider so the provider file exports only a component (keeps
 * React Fast Refresh happy).
 */
export const ToastContext = createContext(null)
