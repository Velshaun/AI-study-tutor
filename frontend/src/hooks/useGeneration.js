import { useContext } from 'react'

import { GenerationContext } from '../context/generation-context'

/**
 * Background media generation: `start({ moduleId, kind, label, run })` and
 * `isGenerating(moduleId, kind)`. Jobs keep running when the learner navigates
 * away — see GenerationProvider.
 */
export function useGeneration() {
  const context = useContext(GenerationContext)
  if (!context) {
    throw new Error('useGeneration must be used inside <GenerationProvider>')
  }
  return context
}
