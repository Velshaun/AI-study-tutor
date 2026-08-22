import { useContext } from 'react'

import { GenerationContext } from '../context/generation-context'

/**
 * Background media generation.
 *
 * `start({ moduleId, domainId, kind, label, run })` runs the work above the
 * router, so it keeps going when the learner navigates away.
 * `isGenerating(moduleId, kind, domainId)` and
 * `failureOf(moduleId, kind, domainId)` let the place a result will land show
 * that it is coming, and say so if it never arrives. See GenerationProvider.
 */
export function useGeneration() {
  const context = useContext(GenerationContext)
  if (!context) {
    throw new Error('useGeneration must be used inside <GenerationProvider>')
  }
  return context
}
