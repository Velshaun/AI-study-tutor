import { QueryClientProvider } from '@tanstack/react-query'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { createBrowserRouter, RouterProvider } from 'react-router-dom'

import ErrorBoundary from './components/ErrorBoundary'
import { AuthProvider } from './context/AuthProvider'
import { ConfirmProvider } from './context/ConfirmProvider'
import { JobsProvider } from './context/JobsProvider'
import { PlayerProvider } from './context/PlayerProvider'
import { PreferencesProvider } from './context/PreferencesProvider'
import { ToastProvider } from './context/ToastProvider'
import { queryClient } from './lib/queryClient'
import { routeConfig } from './router.jsx'
import './index.css'

// After a deploy, hashed route chunks are renamed; a client still running the
// previous build 404s when it lazy-loads a route ("Failed to fetch dynamically
// imported module"). Reload once to pick up the fresh build — guarded against a
// reload loop if a chunk is genuinely broken.
window.addEventListener('vite:preloadError', () => {
  const last = Number(sessionStorage.getItem('chunk-reload-at') || 0)
  if (Date.now() - last < 10_000) return
  sessionStorage.setItem('chunk-reload-at', String(Date.now()))
  window.location.reload()
})

const router = createBrowserRouter(routeConfig)

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <ErrorBoundary>
      <QueryClientProvider client={queryClient}>
        <AuthProvider>
          <PreferencesProvider>
            {/* Toasts + confirmations wrap the router so every screen and the
                minimised player can reach them. */}
            <ToastProvider>
              <ConfirmProvider>
                {/* Above the router: audio must survive navigation so the
                    minimised bar keeps playing. */}
                {/* Watches background imports over Realtime. Above the
                    router so closing a screen — or the tab — never loses track
                    of a job; the row outlives the browser either way. */}
                <JobsProvider>
                  <PlayerProvider>
                    <RouterProvider router={router} />
                  </PlayerProvider>
                </JobsProvider>
              </ConfirmProvider>
            </ToastProvider>
          </PreferencesProvider>
        </AuthProvider>
      </QueryClientProvider>
    </ErrorBoundary>
  </StrictMode>,
)
