import { QueryClientProvider } from '@tanstack/react-query'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { createBrowserRouter, RouterProvider } from 'react-router-dom'

import ErrorBoundary from './components/ErrorBoundary'
import { AuthProvider } from './context/AuthProvider'
import { ConfirmProvider } from './context/ConfirmProvider'
import { PlayerProvider } from './context/PlayerProvider'
import { PreferencesProvider } from './context/PreferencesProvider'
import { ToastProvider } from './context/ToastProvider'
import { queryClient } from './lib/queryClient'
import { routeConfig } from './router.jsx'
import './index.css'

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
                <PlayerProvider>
                  <RouterProvider router={router} />
                </PlayerProvider>
              </ConfirmProvider>
            </ToastProvider>
          </PreferencesProvider>
        </AuthProvider>
      </QueryClientProvider>
    </ErrorBoundary>
  </StrictMode>,
)
