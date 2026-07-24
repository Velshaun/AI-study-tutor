import { createContext } from 'react'

/** Separated from the provider so this module exports only a context —
 *  React Fast Refresh needs component and non-component exports apart. */
export const AuthContext = createContext(null)
