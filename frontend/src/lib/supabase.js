import { createClient } from '@supabase/supabase-js'

/**
 * Browser Supabase client.
 *
 * Uses the anon key, so every request is subject to RLS — this client is safe
 * to ship. The service-role key stays on the backend and must never reach here.
 *
 * Returns null when the environment isn't configured, so screens can degrade
 * to local-only behaviour rather than crashing at import time.
 */

const url = import.meta.env.VITE_SUPABASE_URL
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY

export const supabase =
  url && anonKey
    ? createClient(url, anonKey, {
        auth: {
          persistSession: true,
          autoRefreshToken: true,
          detectSessionInUrl: true,
        },
      })
    : null

/** The current access token, or null when signed out. */
export async function getAccessToken() {
  if (!supabase) return null
  const { data } = await supabase.auth.getSession()
  return data?.session?.access_token ?? null
}
