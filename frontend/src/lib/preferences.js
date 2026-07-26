import { getAccessToken } from './supabase'

/**
 * User preferences — the five keys the backend stores on `profiles.preferences`.
 *
 * Written to localStorage first and pushed to the backend second. The wizard
 * has to work before sign-in exists, and a preference the user just picked
 * should survive a refresh even if the network call fails — so local storage
 * is the source of truth for rendering, and the backend is where it syncs once
 * a session is available.
 */

const STORAGE_KEY = 'ast:preferences'
const ONBOARDED_KEY = 'ast:onboarded'

/** Matches the column default in migration 20260723010000. */
export const DEFAULT_PREFERENCES = {
  theme: 'dark',
  tutor_voice: 'marcus',
  lecture_length: 'medium',
  quiz_difficulty: 'easy',
  flashcard_difficulty: 'easy',
}

export const OPTIONS = {
  tutor_voice: ['marcus', 'sophia'],
  lecture_length: ['short', 'medium', 'long'],
  quiz_difficulty: ['easy', 'medium', 'hard'],
  flashcard_difficulty: ['easy', 'medium', 'hard'],
  theme: ['dark', 'light'],
}

/** Drop unknown keys and invalid values so a stale localStorage blob or an
 *  out-of-date server row can't put the UI into an unrenderable state. */
export function sanitise(raw) {
  const out = { ...DEFAULT_PREFERENCES }
  if (!raw || typeof raw !== 'object') return out

  for (const [key, allowed] of Object.entries(OPTIONS)) {
    if (allowed.includes(raw[key])) {
      out[key] = raw[key]
    }
  }
  return out
}

export function readLocal() {
  try {
    return sanitise(JSON.parse(localStorage.getItem(STORAGE_KEY)))
  } catch {
    return { ...DEFAULT_PREFERENCES }
  }
}

export function writeLocal(preferences) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(sanitise(preferences)))
  } catch {
    // Private browsing or a full quota — the in-memory state still holds.
  }
}

export function hasOnboarded() {
  try {
    return localStorage.getItem(ONBOARDED_KEY) === 'true'
  } catch {
    return false
  }
}

export function markOnboarded() {
  try {
    localStorage.setItem(ONBOARDED_KEY, 'true')
  } catch {
    /* ignore */
  }
}

/**
 * Apply the theme to <html>.
 *
 * Both classes are managed explicitly rather than toggling one: `dark` drives
 * Tailwind's `dark:` variant, `light` drives the token overrides in index.css.
 */
export function applyTheme(theme) {
  const root = document.documentElement
  const light = theme === 'light'
  root.classList.toggle('dark', !light)
  root.classList.toggle('light', light)

  // Keep the browser/OS chrome in step with the surface behind it. theme-color
  // tints the Android/desktop chrome and the PWA status-bar area; it must match
  // the page background (--color-bg) for each theme.
  const themeColor = document.querySelector('meta[name="theme-color"]')
  if (themeColor) themeColor.setAttribute('content', light ? '#F5F5F5' : '#0F0F0F')

  // iOS installed-PWA status bar: `default` paints dark text (readable on the
  // light background); `black-translucent` gives white text over the dark app.
  const statusBar = document.querySelector(
    'meta[name="apple-mobile-web-app-status-bar-style"]',
  )
  if (statusBar) {
    statusBar.setAttribute('content', light ? 'default' : 'black-translucent')
  }
}

/**
 * Push preferences to the backend.
 *
 * Resolves to false when there's no session or the request fails — callers
 * treat the sync as best-effort, never as a gate on finishing the wizard.
 */
export async function syncToBackend(preferences) {
  const token = await getAccessToken()
  if (!token) return false

  const base = import.meta.env.VITE_API_URL
  if (!base) return false

  try {
    const response = await fetch(`${base.replace(/\/$/, '')}/auth/preferences`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ preferences: sanitise(preferences) }),
    })
    return response.ok
  } catch {
    return false
  }
}

/** Read preferences back from the backend, for a returning signed-in user. */
export async function fetchFromBackend() {
  const token = await getAccessToken()
  const base = import.meta.env.VITE_API_URL
  if (!token || !base) return null

  try {
    const response = await fetch(`${base.replace(/\/$/, '')}/auth/me`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    if (!response.ok) return null
    const profile = await response.json()
    return profile?.preferences ? sanitise(profile.preferences) : null
  } catch {
    return null
  }
}
