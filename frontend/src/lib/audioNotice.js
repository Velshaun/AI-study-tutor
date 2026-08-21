/**
 * Whether the two-doors notice has been shown.
 *
 * Its own module so the component file exports a component and nothing else —
 * mixing the two breaks fast refresh, and the rule catching that is worth more
 * than the convenience of keeping them together.
 */

const SEEN_KEY = 'converseai:audio-notice-seen'

export function hasSeenAudioNotice() {
  try {
    return localStorage.getItem(SEEN_KEY) === '1'
  } catch {
    // Private mode, or storage disabled. Treating that as "already seen" is the
    // right way round: a notice that reappears before every lecture is worse
    // than one that is missed.
    return true
  }
}

export function markAudioNoticeSeen() {
  try {
    localStorage.setItem(SEEN_KEY, '1')
  } catch {
    // It will be shown again, which is survivable.
  }
}
