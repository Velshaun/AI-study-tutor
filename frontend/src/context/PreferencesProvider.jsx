import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { PreferencesContext } from './preferences-context'

import {
  applyTheme,
  DEFAULT_PREFERENCES,
  fetchFromBackend,
  readLocal,
  sanitise,
  syncToBackend,
  writeLocal,
} from '../lib/preferences'



/**
 * Holds preferences for the app.
 *
 * Local state is authoritative for rendering so the UI never waits on the
 * network to reflect a choice the user just made. A backend sync is attempted
 * in the background whenever a session exists, and on mount a signed-in user's
 * stored row wins over local state — otherwise switching device would silently
 * keep the wrong voice.
 */
export function PreferencesProvider({ children }) {
  const [preferences, setPreferences] = useState(readLocal)
  const [syncing, setSyncing] = useState(false)
  const hydrated = useRef(false)

  // Theme has to hit the DOM before paint, hence layout-free effect on change.
  useEffect(() => {
    applyTheme(preferences.theme)
  }, [preferences.theme])

  // One-time reconciliation with the server for a returning signed-in user.
  useEffect(() => {
    if (hydrated.current) return
    hydrated.current = true

    let cancelled = false
    fetchFromBackend().then((remote) => {
      if (cancelled || !remote) return
      setPreferences(remote)
      writeLocal(remote)
    })
    return () => {
      cancelled = true
    }
  }, [])

  /** Merge a partial update. Saves locally at once, syncs best-effort. */
  const update = useCallback((patch) => {
    setPreferences((current) => {
      const next = sanitise({ ...current, ...patch })
      writeLocal(next)
      setSyncing(true)
      syncToBackend(next).finally(() => setSyncing(false))
      return next
    })
  }, [])

  /** Persist everything now and report whether the backend accepted it.
   *  Used at the end of the wizard, where the outcome is worth surfacing. */
  const save = useCallback(async (patch = {}) => {
    const next = sanitise({ ...readLocal(), ...preferences, ...patch })
    writeLocal(next)
    setPreferences(next)
    setSyncing(true)
    try {
      return await syncToBackend(next)
    } finally {
      setSyncing(false)
    }
  }, [preferences])

  const reset = useCallback(() => {
    writeLocal(DEFAULT_PREFERENCES)
    setPreferences({ ...DEFAULT_PREFERENCES })
  }, [])

  const value = useMemo(
    () => ({ preferences, update, save, reset, syncing }),
    [preferences, update, save, reset, syncing],
  )

  return (
    <PreferencesContext.Provider value={value}>
      {children}
    </PreferencesContext.Provider>
  )
}
