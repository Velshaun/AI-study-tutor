/**
 * What a lecture's status means to a learner.
 *
 * Generating a lecture writes the row first and fills it in afterwards —
 * `pending`, then `generating_text`, then `generating_audio`, then `ready` —
 * so a lecture *id* existing is not the same as a lecture existing. Treating
 * the two as equivalent is what let a tile open a player with nothing in it,
 * and let a toast say "ready" over a row that was still being written.
 *
 * Pure functions and one poller, so the rules live in one place instead of
 * being re-derived at every call site that happens to hold a status string.
 */

import { api } from './api'

export const READY = 'ready'
export const FAILED = 'failed'
const IN_PROGRESS = ['pending', 'generating_text', 'generating_audio']

export function isReady(status) {
  return status === READY
}

export function isGenerating(status) {
  return IN_PROGRESS.includes(status)
}

/** What the tile says while it waits. Each stage is real work worth naming. */
export function generatingLabel(status) {
  if (status === 'generating_text') return 'Writing the lecture…'
  if (status === 'generating_audio') return 'Recording the audio…'
  return 'Starting…'
}

// Polling, not streaming: /stream exists and carries the transcript live, but a
// tile only needs to know when the thing it points at becomes real, and a
// dropped SSE connection is a worse failure than a missed 2.5-second tick.
const POLL_MS = 2500
// Long enough for a full-length lecture's narration, short enough that a job
// which has genuinely died stops being waited on.
const GIVE_UP_MS = 6 * 60 * 1000

/**
 * Wait until a lecture is playable.
 *
 * Resolves with the final status. A lecture that fails, or that outlasts the
 * ceiling, resolves rather than rejecting — the caller wants to say something
 * useful either way, and a timeout is not an error the learner caused.
 */
export async function waitForLecture(lectureId, { signal } = {}) {
  const deadline = Date.now() + GIVE_UP_MS

  for (;;) {
    if (signal?.aborted) return { status: 'aborted' }
    let row
    try {
      row = await api.lectureStatus(lectureId, signal)
    } catch (err) {
      if (err?.name === 'AbortError') return { status: 'aborted' }
      // A single dropped poll is not a failed lecture; keep waiting.
      row = null
    }

    if (row && (isReady(row.status) || row.status === FAILED)) return row
    if (Date.now() >= deadline) {
      return row || { id: lectureId, status: 'timeout' }
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_MS))
  }
}
