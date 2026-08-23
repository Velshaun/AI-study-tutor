import { useQuery } from '@tanstack/react-query'
import { useCallback, useEffect, useRef, useState } from 'react'

import { useToast } from './useToast'
import { api } from '../lib/api'

/**
 * Remember where a learner got to in a quiz, exam, practice set or deck.
 *
 * Everything except lectures used to keep its progress in React state alone, so
 * tapping away from a ninety-question exam threw away every answer. This loads
 * whatever was saved before the run starts, then writes back as it goes.
 *
 * Saves are coalesced and fire-and-forget: progress is a convenience, and a
 * failed write must never interrupt someone mid-question. The last write wins,
 * which is right for a run that only happens in one place at a time.
 *
 * Returns `{ loading, restored, save, clear }`, where `restored` is the saved
 * progress or null. The query never refetches while a run is in flight, so a
 * live run can't be yanked backwards by a stale response.
 */

// Long enough to collapse a flurry of answers, short enough that closing the
// tab a second later still keeps the last one.
const SAVE_DEBOUNCE_MS = 600

export function useAttempt(itemType, itemId) {
  const toast = useToast()
  // Said once per run, not once per save.
  //
  // These writes were `.catch(() => {})` — progress is a convenience, and a
  // failed one must not interrupt a question. But total silence is how a
  // learner works through forty questions with nothing being kept and no way
  // to know. Once is enough to change what they do; every tick would be noise
  // they learn to ignore, which is the same as silence again.
  const warned = useRef(false)
  const saveFailed = useCallback((e) => {
    console.error('[attempt] progress save failed', e)
    if (warned.current) return
    warned.current = true
    toast.error('Your progress isn’t being saved — check your connection.')
  }, [toast])
  // Set when the learner restarts, so the run stops offering what it just threw
  // away — the cached response is deliberately not refetched.
  const [discarded, setDiscarded] = useState(false)
  const timer = useRef(null)
  const pending = useRef(null)

  const { data, isPending } = useQuery({
    queryKey: ['attempt', itemType, itemId],
    queryFn: ({ signal }) => api.attempt(itemType, itemId, signal),
    enabled: Boolean(itemId),
    // A run is the one thing that must not change underneath the learner.
    staleTime: Infinity,
    refetchOnWindowFocus: false,
    retry: false,
  })

  const hasProgress =
    !discarded && !!data && ((data.position || 0) > 0 || (data.answers?.length || 0) > 0)

  const flush = useCallback(() => {
    if (!itemId || !pending.current) return
    const body = pending.current
    pending.current = null
    api.saveAttempt(itemType, itemId, body).catch(saveFailed)
  }, [itemType, itemId, saveFailed])

  /** Record progress. `completed` marks the run finished. */
  const save = useCallback(
    (progress) => {
      if (!itemId) return
      pending.current = {
        position: progress.position ?? 0,
        answers: progress.answers ?? [],
        state: progress.state ?? {},
        completed: Boolean(progress.completed),
      }
      if (timer.current) window.clearTimeout(timer.current)
      // A finished run is worth writing at once: it stops the item being
      // offered as resumable, and there's nothing after it to coalesce with.
      if (pending.current.completed) {
        flush()
        return
      }
      timer.current = window.setTimeout(flush, SAVE_DEBOUNCE_MS)
    },
    [flush, itemId],
  )

  /** Forget the saved progress — used when a run is restarted. */
  const clear = useCallback(() => {
    pending.current = null
    if (timer.current) window.clearTimeout(timer.current)
    setDiscarded(true)
    if (itemId) api.clearAttempt(itemType, itemId).catch(() => {})
  }, [itemType, itemId])

  // Leaving the page shouldn't cost the last answer.
  useEffect(() => {
    const onHide = () => {
      if (document.visibilityState === 'hidden') flush()
    }
    document.addEventListener('visibilitychange', onHide)
    window.addEventListener('pagehide', flush)
    return () => {
      document.removeEventListener('visibilitychange', onHide)
      window.removeEventListener('pagehide', flush)
      flush()
    }
  }, [flush])

  return {
    loading: Boolean(itemId) && isPending,
    restored: hasProgress ? data : null,
    save,
    clear,
  }
}
