import { createContext } from 'react'

/** Separated from the provider so the module exports only a context — the
 *  react-refresh rule requires component and non-component exports to live in
 *  different files. */
export const PreferencesContext = createContext(null)
