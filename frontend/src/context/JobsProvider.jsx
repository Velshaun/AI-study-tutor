import { useEffect, useMemo, useRef, useState } from 'react'

import { JobsContext } from './jobs-context'
import { useAuth } from '../hooks/useAuth'
import { useToast } from '../hooks/useToast'
import { supabase } from '../lib/supabase'

/**
 * Background jobs, watched over a Realtime subscription.
 *
 * `GenerationProvider` next door keeps its jobs in a promise the browser is
 * holding open — which is exactly why it can't be used for imports. Close the
 * tab and the promise dies with it; a redeploy mid-generation and nobody ever
 * learns what happened.
 *
 * Here the job is a row, so the browser is a spectator rather than the owner.
 * It subscribes on mount, catches up with a fetch (a subscription only tells
 * you about changes *after* it opens, and the import may have finished while
 * the tab was shut), and announces anything that reached a terminal state while
 * nobody was looking. Closing and reopening the tab loses nothing.
 *
 * The subscription carries the learner's own JWT, so RLS on `jobs` is what
 * stops one account watching another's imports. The worker writes with the
 * service role and bypasses RLS — that asymmetry is deliberate, and it's why
 * the policy is written for the reader.
 */

const ACTIVE = ['queued', 'running']
const TERMINAL = ['succeeded', 'failed', 'cancelled']

/** What to call a job in a toast. Falls back to something honest. */
function label(job) {
  return (
    {
      import_youtube: 'YouTube import',
      import_paste: 'Import',
      import_url: 'Page import',
    }[job?.kind] || 'Import'
  )
}

function summarise(job) {
  const done = job.completed_items || 0
  const failed = job.failed_items || 0
  const total = job.total_items || 0
  if (job.status === 'failed') return job.error || 'It didn’t work.'
  if (failed && done) return `${done} of ${total} added — ${failed} didn’t work.`
  if (failed && !done) return `None of the ${total} could be added.`
  return `${done} of ${total} added.`
}

export function JobsProvider({ children }) {
  const { user } = useAuth()
  const toast = useToast()
  const [jobs, setJobs] = useState({})

  // Jobs already announced, so a re-subscribe (a token refresh, a reconnect)
  // doesn't toast the same finished import twice. A ref rather than state:
  // StrictMode replays state updaters, and a replayed dedupe is no dedupe.
  const announced = useRef(new Set())
  // The toast callback changes identity freely; the effect below must not
  // resubscribe every time it does.
  const notify = useRef(toast)
  useEffect(() => {
    notify.current = toast
  }, [toast])

  const userId = user?.id ?? null

  useEffect(() => {
    if (!supabase || !userId) return undefined

    let cancelled = false

    const remember = (job) => {
      if (cancelled) return
      setJobs((current) => {
        // Terminal jobs are dropped from the live map once announced — this is
        // "what's running", not a history. The Import screen reads history from
        // the API instead.
        if (TERMINAL.includes(job.status)) {
          const rest = { ...current }
          delete rest[job.id]
          return rest
        }
        return { ...current, [job.id]: job }
      })

      if (TERMINAL.includes(job.status) && !announced.current.has(job.id)) {
        announced.current.add(job.id)
        const done = job.completed_items || 0
        if (job.status === 'succeeded' && done > 0) {
          notify.current.success(`${label(job)} finished — ${summarise(job)}`)
        } else {
          notify.current.error(`${label(job)}: ${summarise(job)}`)
        }
      }
    }

    // Catch up first. A subscription only reports changes made after it opens,
    // so without this an import that finished while the tab was closed would
    // never be mentioned.
    supabase
      .from('jobs')
      .select('*')
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .limit(20)
      .then(({ data, error }) => {
        if (cancelled || error || !data) return
        for (const job of data) {
          if (ACTIVE.includes(job.status)) {
            remember(job)
          } else {
            // Finished before we were watching: seed the dedupe so it isn't
            // announced now, hours late.
            announced.current.add(job.id)
          }
        }
      })

    const channel = supabase
      .channel(`jobs:${userId}`)
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'jobs',
          filter: `user_id=eq.${userId}`,
        },
        (payload) => {
          const job = payload.new
          if (job?.id) remember(job)
        },
      )
      .subscribe()

    return () => {
      cancelled = true
      supabase.removeChannel(channel)
    }
  }, [userId])

  const value = useMemo(() => {
    // Derived rather than cleared in the effect: signing out means "show
    // nothing", and writing that as a reset is a state-in-effect the linter
    // rightly objects to — and one more place for the two to disagree.
    const list = userId ? Object.values(jobs) : []
    return {
      /** Every job currently queued or running, newest first. */
      jobs: list.sort((a, b) => (a.created_at < b.created_at ? 1 : -1)),
      /** Jobs in flight for one module — what "buffering" is derived from. */
      forModule: (moduleId) => list.filter((j) => j.module_id === moduleId),
      isImporting: (moduleId) => list.some((j) => j.module_id === moduleId),
    }
  }, [jobs, userId])

  return <JobsContext.Provider value={value}>{children}</JobsContext.Provider>
}
