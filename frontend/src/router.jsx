/* This file exports route *data*, not components, so React Fast Refresh has
   nothing to preserve here — but the `lazy()` bindings read as components to
   the linter. Disabled deliberately for this file only. */
/* eslint-disable react-refresh/only-export-components */

import { lazy } from 'react'
import { useRouteError } from 'react-router-dom'

import { PublicOnly, RequireAuth } from './components/AuthGuards'
import AppLayout from './layouts/AppLayout'
import RootLayout from './layouts/RootLayout'
import { ROUTES } from './routes'

/**
 * Route configuration — spec §5.2.
 *
 * Declared as a data-router object array rather than JSX `<Routes>`: it's the
 * react-router v7 idiom, `ScrollRestoration` only functions under a data
 * router, and an array can be matched with `matchRoutes` in tests without
 * mounting the app.
 *
 * Screens are lazy-loaded so the initial download is the shell plus the
 * dashboard. That matters more here than in a typical SPA — the lecture player
 * will pull in audio and streaming code that nobody browsing their modules
 * should pay for up front.
 *
 * Two screens sit outside `AppLayout` deliberately: the lecture player is
 * full-screen by spec, and the onboarding wizard shouldn't offer navigation
 * away from itself before setup is complete.
 */

const Dashboard = lazy(() => import('./pages/Dashboard'))
const Login = lazy(() => import('./pages/Login'))
const Onboarding = lazy(() => import('./pages/Onboarding'))
const ModuleDetail = lazy(() => import('./pages/ModuleDetail'))
const LecturePlayer = lazy(() => import('./pages/LecturePlayer'))
const Flashcards = lazy(() => import('./pages/Flashcards'))
const Quizzes = lazy(() => import('./pages/Quizzes'))
const PracticeExam = lazy(() => import('./pages/PracticeExam'))
const ExamRun = lazy(() => import('./pages/ExamRun'))
const PracticeMode = lazy(() => import('./pages/PracticeMode'))
const ReviewLater = lazy(() => import('./pages/ReviewLater'))
const QAReview = lazy(() => import('./pages/QAReview'))
const Groups = lazy(() => import('./pages/Groups'))
const Settings = lazy(() => import('./pages/Settings'))
const Favourites = lazy(() => import('./pages/Favourites'))
const DesignSystem = lazy(() => import('./pages/DesignSystem'))
const NotFound = lazy(() => import('./pages/NotFound'))

/**
 * Route-level error fallback. The commonest cause here is a stale build after a
 * deploy — a lazy route chunk that no longer exists 404s. `main.jsx` auto-reloads
 * on `vite:preloadError`; this catches anything that slips past and offers a
 * reload rather than a raw stack trace.
 */
function RouteError() {
  const error = useRouteError()
  const isChunk = /dynamically imported module|module script failed|Failed to fetch/i.test(
    error?.message || '',
  )
  return (
    <div className="flex min-h-dvh flex-col items-center justify-center gap-4 bg-bg px-6 text-center">
      <p className="text-lg font-semibold text-pri">
        {isChunk ? 'A new version is available' : 'Something went wrong'}
      </p>
      <p className="max-w-sm text-sm text-sec">
        {isChunk
          ? 'The app was updated while you were away. Reload to get the latest version.'
          : 'An unexpected error occurred. Reloading usually fixes it.'}
      </p>
      <button onClick={() => window.location.reload()} className="btn-primary">
        Reload
      </button>
    </div>
  )
}

export const routeConfig = [
  {
    element: <RootLayout />,
    errorElement: <RouteError />,
    children: [
      // The only screen a signed-out visitor can reach. An already-authenticated
      // user is redirected away from it.
      {
        element: <PublicOnly />,
        children: [{ path: ROUTES.login, element: <Login /> }],
      },

      // Everything else requires a session. RequireAuth redirects the
      // unauthenticated to /login before any of these screens — or the app
      // shell, or the catch-all — can render.
      {
        element: <RequireAuth />,
        children: [
          // Immersive screens — no app shell.
          { path: ROUTES.onboarding, element: <Onboarding /> },
          { path: ROUTES.lecture, element: <LecturePlayer /> },

          // Everything else renders inside the shell.
          {
            element: <AppLayout />,
            children: [
              { path: ROUTES.dashboard, element: <Dashboard /> },
              { path: ROUTES.module, element: <ModuleDetail /> },
              { path: ROUTES.flashcards, element: <Flashcards /> },
              { path: ROUTES.quizzes, element: <Quizzes /> },
              { path: ROUTES.practice, element: <PracticeExam /> },
              { path: ROUTES.practiceMode, element: <PracticeMode /> },
              { path: ROUTES.examRun, element: <ExamRun /> },
              { path: ROUTES.reviewLater, element: <ReviewLater /> },
              { path: ROUTES.qaReview, element: <QAReview /> },
              { path: ROUTES.groups, element: <Groups /> },
              { path: ROUTES.settings, element: <Settings /> },
              { path: ROUTES.favourites, element: <Favourites /> },

              // Not in the spec's list: the §5.1 design system reference. Kept
              // reachable for development, absent from navigation.
              { path: '/design', element: <DesignSystem /> },
            ],
          },

          // Unknown paths: an authenticated user gets Not Found; a signed-out
          // one is redirected to /login by RequireAuth above.
          { path: '*', element: <NotFound /> },
        ],
      },
    ],
  },
]
