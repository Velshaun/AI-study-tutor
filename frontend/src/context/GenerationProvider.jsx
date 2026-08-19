import { useCallback, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'

import { GenerationContext } from './generation-context'
import { useToast } from '../hooks/useToast'

/**
 * Media generation that outlives the screen that started it.
 *
 * Generating a module's lectures or decks takes minutes, and a learner
 * shouldn't have to sit and watch it. Jobs are held here — mounted in
 * RootLayout, above every route — so navigating away, switching tabs or
 * opening another module leaves the work running. When it lands, a toast says
 * so and offers to take the learner straight to it.
 *
 * Jobs are keyed `moduleId:kind`, so the Classroom tab can show "Generating…"
 * on the right tile whenever the learner comes back to it.
 */
export function GenerationProvider({ children }) {
  const toast = useToast()
  const navigate = useNavigate()
  const [jobs, setJobs] = useState({})
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

  /**
   * Run a generation job in the background.
   *
   * `run` does the work and resolves to the destination path (or nothing, if
   * there's nowhere specific to send the learner). `label` names the media type
   * in the toast.
   */
  const start = useCallback(
    async ({ moduleId, kind, label, run }) => {
      const key = `${moduleId}:${kind}`
      // Two taps on the same tile shouldn't start the same job twice.
      if (running.current.has(key)) return

      const attempt = async () => {
        running.current.add(key)
        setJob(key, { label })
        try {
          const destination = await run()
          toast.success(`${label} generated successfully — tap to view`, {
            action: destination
              ? { label: 'View', onClick: () => navigate(destination) }
              : undefined,
          })
        } catch (e) {
          toast.error(e?.message || `Could not generate ${label.toLowerCase()}`, {
            action: { label: 'Retry', onClick: attempt },
          })
        } finally {
          running.current.delete(key)
          setJob(key, null)
        }
      }
      await attempt()
    },
    [navigate, setJob, toast],
  )

  const value = useMemo(
    () => ({
      start,
      /** Is this module's media of `kind` being generated right now? */
      isGenerating: (moduleId, kind) => Boolean(jobs[`${moduleId}:${kind}`]),
      /** Every job in flight, for a global indicator if one is ever wanted. */
      jobs,
    }),
    [jobs, start],
  )

  return (
    <GenerationContext.Provider value={value}>{children}</GenerationContext.Provider>
  )
}
