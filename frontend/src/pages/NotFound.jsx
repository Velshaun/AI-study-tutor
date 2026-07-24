import { Link, useLocation } from 'react-router-dom'

import { ROUTES } from '../routes'

export default function NotFound() {
  const { pathname } = useLocation()

  return (
    <div className="flex min-h-dvh items-center justify-center bg-bg px-5">
      <div className="w-full max-w-md space-y-5 text-center">
        <p className="text-5xl font-semibold text-accent">404</p>
        <div className="space-y-1.5">
          <h1 className="text-xl font-semibold text-pri">Page not found</h1>
          <p className="text-sm text-sec">
            Nothing is routed at{' '}
            <code className="rounded bg-surface2 px-1.5 py-0.5 text-xs text-accent2">
              {pathname}
            </code>
          </p>
        </div>
        <Link to={ROUTES.dashboard} className="btn-primary">
          Back to dashboard
        </Link>
      </div>
    </div>
  )
}
