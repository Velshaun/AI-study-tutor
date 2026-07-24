import { QueryClient } from '@tanstack/react-query'

import { ApiError } from './api'

/**
 * Shared query client.
 *
 * Auth failures are never retried — without a session, retrying just burns
 * three requests before showing the same sign-in prompt.
 */
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: (failureCount, error) =>
        !(error instanceof ApiError && error.isAuth) && failureCount < 2,
      staleTime: 30_000,
      refetchOnWindowFocus: false,
    },
  },
})
