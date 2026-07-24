import { createContext } from 'react'

/**
 * Confirm context — exposes an imperative `confirm(options) => Promise<boolean>`
 * so any handler can `await confirm(...)` before a destructive action. Split
 * from the provider to keep Fast Refresh working.
 */
export const ConfirmContext = createContext(null)
