import { Suspense } from 'react'
import { Outlet, ScrollRestoration } from 'react-router-dom'

import { GenerationProvider } from '../context/GenerationProvider'

/** Shown while a lazily-loaded route chunk arrives. Mirrors the placeholder
 *  shape so the layout doesn't jump when the real screen mounts. */
function RouteFallback() {
  return (
    <div className="space-y-5 px-5 py-8" role="status" aria-label="Loading">
      <div className="skeleton h-7 w-40" />
      <div className="card space-y-3">
        <div className="skeleton h-4 w-2/3" />
        <div className="skeleton h-4 w-1/2" />
        <div className="skeleton h-4 w-3/4" />
      </div>
    </div>
  )
}

/**
 * Root of the route tree.
 *
 * Suspense sits above everything so a lazily-loaded screen shows the fallback
 * rather than blanking. ScrollRestoration resets scroll on navigation and
 * restores it on back — it requires a data router, which is why the app uses
 * `createBrowserRouter` rather than `<BrowserRouter>`.
 */
export default function RootLayout() {
  return (
    <>
      <ScrollRestoration />
      <GenerationProvider>
        <Suspense fallback={<RouteFallback />}>
          <Outlet />
        </Suspense>
      </GenerationProvider>
    </>
  )
}
