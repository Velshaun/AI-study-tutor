import { useCallback } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'

/**
 * Going back, without pushing a new entry to go back *to*.
 *
 * Screens used to leave by navigating to where they came from, which is a push:
 * the module opens the import screen, the import screen's back button pushes the
 * module, and the browser's own back button then returns to the import screen.
 * Press it again and you are back on the module. Two entries, ping-ponging, and
 * no way out of the pair without holding the back button.
 *
 * So this pops when there is something to pop, and navigates only when there
 * isn't. `location.key` is the router's own marker: it is the literal string
 * `'default'` on the first entry of a session, which is exactly the case where
 * popping would leave the app — a deep link, a refresh, a shared URL.
 *
 * `fallback` is where to go in that case. It is required rather than defaulted
 * to the dashboard, because "back" from a lecture and "back" from a quiz mean
 * different places and guessing wrong is how people end up somewhere they never
 * were.
 */
export function useGoBack(fallback) {
  const navigate = useNavigate()
  const location = useLocation()

  return useCallback(() => {
    if (location.key && location.key !== 'default') {
      navigate(-1)
      return
    }
    navigate(fallback, { replace: true })
  }, [navigate, location.key, fallback])
}
