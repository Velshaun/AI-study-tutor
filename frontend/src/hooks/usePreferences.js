import { useContext } from 'react'

import { PreferencesContext } from '../context/preferences-context'

export function usePreferences() {
  const context = useContext(PreferencesContext)
  if (!context) {
    throw new Error('usePreferences must be used inside <PreferencesProvider>')
  }
  return context
}
