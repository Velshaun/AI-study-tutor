import { useCallback, useEffect, useRef } from 'react'

import { usePlayer } from './usePlayer'

/**
 * One thing speaks at a time.
 *
 * The standard convention, borrowed from every phone OS that has ever had two
 * apps wanting the speaker: starting the tutor takes focus and ducks the
 * lecture, finishing gives it back. It removes the whole barge-in problem
 * rather than solving it — there is never a moment when both are audible, so
 * nothing has to be coordinated between them.
 *
 * The rule that makes it feel right rather than merely correct: **a pause the
 * learner made themselves is theirs.** Focus only resumes what focus paused. If
 * they had already stopped the lecture before opening the tutor, it stays
 * stopped afterwards — the app does not restart something they deliberately
 * turned off.
 *
 * And if they press play *while* the tutor holds focus, they have overruled it:
 * the claim is dropped, so releasing focus later does not yank playback back to
 * a state they have since changed.
 */
export function useAudioFocus() {
  const player = usePlayer()
  const { playing, play, pause } = player

  // Whether the lecture is paused because of us. A ref rather than state:
  // taking and releasing focus must not schedule a render, and the value is
  // read inside callbacks that would otherwise close over a stale copy.
  const heldRef = useRef(false)
  const playingRef = useRef(playing)

  useEffect(() => {
    // The learner started it again while we held focus, so it is theirs now.
    if (heldRef.current && playing) heldRef.current = false
    playingRef.current = playing
  }, [playing])

  /** Take the speaker. Ducks the lecture only if it was actually running. */
  const take = useCallback(() => {
    if (heldRef.current) return
    if (!playingRef.current) {
      // Nothing to duck. Recording that we did *not* pause it is the whole
      // point — otherwise release would start a lecture nobody asked for.
      heldRef.current = false
      return
    }
    heldRef.current = true
    pause?.()
  }, [pause])

  /** Give it back, resuming only what we paused. */
  const release = useCallback(() => {
    if (!heldRef.current) return
    heldRef.current = false
    play?.()
  }, [play])

  // A component unmounting mid-answer — navigating away with the tutor
  // speaking — must not leave the lecture paused forever.
  useEffect(() => () => {
    if (heldRef.current) {
      heldRef.current = false
      play?.()
    }
  }, [play])

  return { take, release, holding: () => heldRef.current, player }
}
