import { useCallback, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'

import { GenerationContext } from './generation-context'
import { useToast } from '../hooks/useToast'

/**
 * Media generation that outlives the screen that started it — and says so.
 *
 * Generating a lecture or a deck takes minutes, and a learner shouldn't have to
 * sit and watch it. Jobs are held here — mounted in RootLayout, above every
 * route — so navigating away, switching tabs or opening another module leaves
 * the work running.
 *
 * Running it in the background was never the missing half. It already did that.
 * What it didn't do was *show* it anywhere except the tile that was tapped, so
 * walking back into the Classroom mid-generation showed a screen identical to
 * the one before the tap: nothing building, nothing pending, no reason to think
 * anything had happened. A job you cannot see is indistinguishable from a job
 * that never started.
 *
 * So state is keyed by where the result will land — module, domain and media
 * type — and the row that will hold it reads its own status wherever the
 * learner happens to be.
 *
 * Failures are kept rather than flashed. A toast is gone in four seconds and a
 * learner who was in another tab never saw it; the row keeps saying "couldn't
 * build this" until they retry or dismiss it, because silently reverting to
 * "none yet" is how a failure becomes a mystery.
 *
 * This deliberately does not use the durable job queue. A `jobs` row exists so
 * an import can survive the tab closing; generation dies with the tab, so there
 * would be nothing on the other end of a subscription to hear from. Same feel
 * as import progress, honest mechanism.
 */

/** Where a result will land. `domainId` is absent for module-wide jobs. */
function keyOf(moduleId, kind, domainId) {
  return `${moduleId}:${domainId || '*'}:${kind}`
}

export function GenerationProvider({ children }) {
  const toast = useToast()
  const navigate = useNavigate()
  const [jobs, setJobs] = useState({})
  const [failures, setFailures] = useState({})
  // The dedupe check lives in a ref, not in a setState updater: React replays
  // updaters (twice in StrictMode), so reading state that way made a second
  // pass believe the job already existed and drop it on the floor.
  const running = useRef(new Set())

  const setJob = useCallback((key, value) => {
    setJobs((current) => {
      if (value === null) {
        const rest = { ...current }
        delete rest[key]
        return rest
      }
      return { ...current, [key]: value }
    })
  }, [])

  const clearFailure = useCallback((key) => {
    setFailures((current) => {
      if (!(key in current)) return current
      const rest = { ...current }
      delete rest[key]
      return rest
    })
  }, [])

  /**
   * Run a generation job in the background.
   *
   * `run` does the work and resolves to the destination path (or nothing, if
   * there's nowhere specific to send the learner). `label` names the media type
   * in the toast and on the row.
   */
  const start = useCallback(
    async ({ moduleId, domainId, kind, label, run }) => {
      const key = keyOf(moduleId, kind, domainId)
      // Two taps on the same tile shouldn't start the same job twice.
      if (running.current.has(key)) return

      const attempt = async () => {
        running.current.add(key)
        clearFailure(key)
        setJob(key, { label, startedAt: Date.now() })
        try {
          const destination = await run()
          toast.success(`${label} generated successfully — tap to view`, {
            action: destination
              ? { label: 'View', onClick: () => navigate(destination) }
              : undefined,
          })
        } catch (e) {
          const message = e?.message || `Could not generate ${label.toLowerCase()}`
          // Kept on the row as well as raised as a toast. The toast is for
          // whoever is looking; the row is for whoever comes back later.
          setFailures((current) => ({
            ...current, [key]: { label, message, retry: attempt },
          }))
          toast.error(message, { action: { label: 'Retry', onClick: attempt } })
        } finally {
          running.current.delete(key)
          setJob(key, null)
        }
      }
      await attempt()
    },
    [clearFailure, navigate, setJob, toast],
  )

  const value = useMemo(
    () => ({
      start,
      /** Is this being generated right now? `domainId` optional. */
      isGenerating: (moduleId, kind, domainId) =>
        Boolean(jobs[keyOf(moduleId, kind, domainId)]),
      /** The last failure here, until retried or dismissed. */
      failureOf: (moduleId, kind, domainId) =>
        failures[keyOf(moduleId, kind, domainId)] || null,
      dismissFailure: (moduleId, kind, domainId) =>
        clearFailure(keyOf(moduleId, kind, domainId)),
      /** Every job in flight, for a global indicator if one is ever wanted. */
      jobs,
    }),
    [clearFailure, failures, jobs, start],
  )

  return (
    <GenerationContext.Provider value={value}>{children}</GenerationContext.Provider>
  )
}
