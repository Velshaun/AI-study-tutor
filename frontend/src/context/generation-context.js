import { createContext } from 'react'

/**
 * Background media generation. Split from the provider so the provider file
 * exports only a component (keeps React Fast Refresh happy).
 */
export const GenerationContext = createContext(null)
