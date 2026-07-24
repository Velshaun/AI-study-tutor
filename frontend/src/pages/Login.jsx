import { GraduationCap, Loader2 } from 'lucide-react'
import { useState } from 'react'
import { Navigate } from 'react-router-dom'

import { useAuth } from '../hooks/useAuth'
import { hasOnboarded } from '../lib/preferences'
import { ROUTES } from '../routes'

/**
 * Sign-in — spec Prompt 2, item 4.
 *
 * Google and GitHub OAuth only. Also the OAuth landing page: after the provider
 * round-trip the browser returns here, the session resolves, and this routes
 * onward — to onboarding on a first login, otherwise the dashboard.
 *
 * Provider logos are inline SVG rather than an icon-library dependency, so they
 * render correctly regardless of which brand icons the installed lucide version
 * ships.
 */
export default function Login() {
  const { isAuthenticated, loading, configured, signInWithProvider } = useAuth()
  const [busy, setBusy] = useState(null) // 'google' | 'github' | null
  const [error, setError] = useState(null)

  // Signed in — leave the login screen. First-timers go through onboarding.
  if (isAuthenticated) {
    return <Navigate to={hasOnboarded() ? ROUTES.dashboard : ROUTES.onboarding} replace />
  }

  async function signIn(provider) {
    setBusy(provider)
    setError(null)
    try {
      // Redirects away to the provider; the browser leaves this page.
      await signInWithProvider(provider)
    } catch (err) {
      setError(err?.message || 'Could not start sign-in. Please try again.')
      setBusy(null)
    }
  }

  return (
    <div className="flex min-h-dvh items-center justify-center bg-bg px-5">
      <div className="w-full max-w-sm space-y-8">
        {/* Brand */}
        <div className="space-y-4 text-center">
          <div className="mx-auto flex size-16 items-center justify-center rounded-2xl bg-accent">
            <GraduationCap size={32} className="text-white" aria-hidden="true" />
          </div>
          <div className="space-y-1.5">
            <h1 className="text-2xl font-semibold text-pri">ConverseAI Tutor</h1>
            <p className="text-sm text-sec">
              Sign in to pick up your modules and progress.
            </p>
          </div>
        </div>

        {/* Sign-in */}
        {!configured ? (
          <div className="card text-center text-sm text-warning">
            Authentication isn&rsquo;t configured. Set{' '}
            <code className="text-accent2">VITE_SUPABASE_URL</code> and{' '}
            <code className="text-accent2">VITE_SUPABASE_ANON_KEY</code>.
          </div>
        ) : loading ? (
          <div className="flex justify-center py-6">
            <Loader2 size={22} className="animate-spin text-accent" aria-hidden="true" />
          </div>
        ) : (
          <div className="space-y-3">
            <button
              onClick={() => signIn('google')}
              disabled={Boolean(busy)}
              className="btn-secondary w-full"
            >
              {busy === 'google' ? (
                <Loader2 size={18} className="animate-spin" aria-hidden="true" />
              ) : (
                <GoogleMark />
              )}
              Continue with Google
            </button>

            <button
              onClick={() => signIn('github')}
              disabled={Boolean(busy)}
              className="btn-secondary w-full"
            >
              {busy === 'github' ? (
                <Loader2 size={18} className="animate-spin" aria-hidden="true" />
              ) : (
                <GithubMark />
              )}
              Continue with GitHub
            </button>

            {error && (
              <p className="pt-1 text-center text-sm text-warning">{error}</p>
            )}
          </div>
        )}

        <p className="text-center text-xs text-sec">
          By continuing you agree to store your study data in your account.
        </p>
      </div>
    </div>
  )
}

/* --- provider marks (inline SVG) ---------------------------------------- */

function GoogleMark() {
  return (
    <svg width="18" height="18" viewBox="0 0 48 48" aria-hidden="true">
      <path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3c-1.6 4.7-6.1 8-11.3 8-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.9 1.2 8 3.1l5.7-5.7C34 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.3-.4-3.5z" />
      <path fill="#FF3D00" d="M6.3 14.7l6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.9 1.2 8 3.1l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z" />
      <path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.4 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-8l-6.5 5C9.6 39.6 16.2 44 24 44z" />
      <path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C39.9 36.5 44 31 44 24c0-1.3-.1-2.3-.4-3.5z" />
    </svg>
  )
}

function GithubMark() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M12 .5C5.7.5.5 5.7.5 12c0 5.1 3.3 9.4 7.9 10.9.6.1.8-.3.8-.6v-2c-3.2.7-3.9-1.5-3.9-1.5-.5-1.3-1.3-1.7-1.3-1.7-1.1-.7.1-.7.1-.7 1.2.1 1.8 1.2 1.8 1.2 1 1.8 2.7 1.3 3.4 1 .1-.8.4-1.3.7-1.6-2.6-.3-5.3-1.3-5.3-5.7 0-1.3.5-2.3 1.2-3.1-.1-.3-.5-1.5.1-3.1 0 0 1-.3 3.3 1.2a11.5 11.5 0 0 1 6 0C17.3 4.8 18.3 5.1 18.3 5.1c.6 1.6.2 2.8.1 3.1.8.8 1.2 1.8 1.2 3.1 0 4.4-2.7 5.4-5.3 5.7.4.4.8 1.1.8 2.2v3.3c0 .3.2.7.8.6 4.6-1.5 7.9-5.8 7.9-10.9C23.5 5.7 18.3.5 12 .5z" />
    </svg>
  )
}
