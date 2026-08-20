import { useContext } from 'react'

import { JobsContext } from '../context/jobs-context'

/**
 * Background import jobs, watched over Realtime rather than held in a promise.
 *
 * `jobs` is what is queued or running, `forModule(id)` narrows it, and
 * `isImporting(id)` is the buffering signal — derived from live rows rather
 * than a status flag on the module, which would go stale if a worker died.
 */
export function useJobs() {
  const context = useContext(JobsContext)
  if (!context) {
    throw new Error('useJobs must be used inside <JobsProvider>')
  }
  return context
}
