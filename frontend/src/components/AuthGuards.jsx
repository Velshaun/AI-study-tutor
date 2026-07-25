import { Loader2 } from 'lucide-react'
import { Navigate, Outlet } from 'react-router-dom'

import { useAuth } from '../hooks/useAuth'
import { hasOnboarded } from '../lib/preferences'
import { ROUTES } from '../routes'

/**
 * Route guards.
 *
 * The app is fully gated: a signed-out visitor can reach *only* the sign-in
 * screen. `RequireAuth` wraps every real screen and bounces the unauthenticated
 * to /login; `PublicOnly` wraps /login and bounces the already-authenticated on
 * to their dashboard (or onboarding on a first run). While the session is still
 * resolving we hold on a full-screen loader rather than flashing the wrong
 * screen.
 */

function FullScreenLoader() {
  return (
    <div className="flex min-h-dvh items-center justify-center bg-bg">
      <Loader2 size={26} className="animate-spin text-accent" aria-hidden="true" />
    </div>
  )
}

/** Gate for authenticated screens. */
export function RequireAuth() {
  const { isAuthenticated, loading } = useAuth()
  if (loading) return <FullScreenLoader />
  if (!isAuthenticated) return <Navigate to={ROUTES.login} replace />
  return <Outlet />
}

/** Gate for the sign-in screen — an authenticated user shouldn't see it, unless
 *  they've just arrived via a password-reset link and need to set a password. */
export function PublicOnly() {
  const { isAuthenticated, loading, recovery } = useAuth()
  if (loading) return <FullScreenLoader />
  if (isAuthenticated && !recovery) {
    return <Navigate to={hasOnboarded() ? ROUTES.dashboard : ROUTES.onboarding} replace />
  }
  return <Outlet />
}
