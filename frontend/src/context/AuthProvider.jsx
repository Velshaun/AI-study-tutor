import { useCallback, useEffect, useMemo, useState } from 'react'

import { supabase } from '../lib/supabase'
import { AuthContext } from './auth-context'

/**
 * Supabase auth state for the app.
 *
 * Auth happens client-side: OAuth redirects the browser to Google/GitHub and
 * back, and `detectSessionInUrl` (set on the client) exchanges the returned
 * code for a session. This provider surfaces that session, keeps it fresh via
 * `onAuthStateChange`, and exposes sign-in / sign-out.
 *
 * `configured` is false when the Supabase env vars are absent, so screens can
 * show a clear "auth isn't set up" message instead of buttons that silently do
 * nothing.
 */
export function AuthProvider({ children }) {
  const [session, setSession] = useState(null)
  // Only "loading" while there's actually a client to ask; without one there's
  // nothing to wait for, and setting state in the effect below would be a
  // synchronous-setState-in-effect violation.
  const [loading, setLoading] = useState(() => Boolean(supabase))
  // True after arriving via a password-reset email, until a new password is set.
  const [recovery, setRecovery] = useState(false)

  useEffect(() => {
    if (!supabase) return undefined

    let active = true

    // Restore any persisted session on load...
    supabase.auth.getSession().then(({ data }) => {
      if (!active) return
      setSession(data.session ?? null)
      setLoading(false)
    })

    // ...then track sign-in, sign-out and token refresh live.
    const { data: sub } = supabase.auth.onAuthStateChange((event, next) => {
      if (event === 'PASSWORD_RECOVERY') setRecovery(true)
      setSession(next)
      setLoading(false)
    })

    return () => {
      active = false
      sub.subscription.unsubscribe()
    }
  }, [])

  const signInWithProvider = useCallback(async (provider) => {
    if (!supabase) throw new Error('Authentication is not configured.')
    const { error } = await supabase.auth.signInWithOAuth({
      provider,
      // Land back on /login, which then routes onward based on onboarding.
      options: { redirectTo: `${window.location.origin}/login` },
    })
    if (error) throw error
  }, [])

  const signInWithEmail = useCallback(async (email, password) => {
    if (!supabase) throw new Error('Authentication is not configured.')
    const { error } = await supabase.auth.signInWithPassword({ email, password })
    if (error) throw error
  }, [])

  const signUpWithEmail = useCallback(async (email, password) => {
    if (!supabase) throw new Error('Authentication is not configured.')
    const { data, error } = await supabase.auth.signUp({
      email,
      password,
      options: { emailRedirectTo: `${window.location.origin}/login` },
    })
    if (error) throw error
    // No session means the project requires email confirmation first.
    return { needsConfirmation: !data.session }
  }, [])

  const resetPassword = useCallback(async (email) => {
    if (!supabase) throw new Error('Authentication is not configured.')
    const { error } = await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: `${window.location.origin}/login`,
    })
    if (error) throw error
  }, [])

  const updatePassword = useCallback(async (password) => {
    if (!supabase) throw new Error('Authentication is not configured.')
    const { error } = await supabase.auth.updateUser({ password })
    if (error) throw error
    setRecovery(false)
  }, [])

  const signOut = useCallback(async () => {
    await supabase?.auth.signOut()
    setSession(null)
  }, [])

  const value = useMemo(
    () => ({
      session,
      user: session?.user ?? null,
      isAuthenticated: Boolean(session),
      loading,
      recovery,
      configured: Boolean(supabase),
      signInWithProvider,
      signInWithEmail,
      signUpWithEmail,
      resetPassword,
      updatePassword,
      signOut,
    }),
    [
      session,
      loading,
      recovery,
      signInWithProvider,
      signInWithEmail,
      signUpWithEmail,
      resetPassword,
      updatePassword,
      signOut,
    ],
  )

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}
