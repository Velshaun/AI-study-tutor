import { useContext } from 'react'

import { ConfirmContext } from '../context/confirm-context'

/**
 * Returns `confirm(options) => Promise<boolean>`. Resolves true when the learner
 * confirms, false on cancel/backdrop/Escape.
 */
export function useConfirm() {
  const context = useContext(ConfirmContext)
  if (!context) {
    throw new Error('useConfirm must be used inside <ConfirmProvider>')
  }
  return context
}
