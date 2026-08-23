/**
 * What gets taught, and when.
 *
 * Two layers, because they answer different questions.
 *
 * The **first-run tour** is what a brand new account can actually see and act
 * on — which is almost nothing except its own preferences. Teaching sources,
 * flags, review sets or missed questions there costs the learner attention on
 * things that do not exist yet and that they will have forgotten by the time
 * they do. It stays a preferences flow with a welcome around it.
 *
 * **Contextual moments** fire the first time a feature is genuinely in front of
 * somebody. The research is lopsided on this: just-in-time guidance sees about
 * 2.9x the feature adoption of an upfront tour, and a hint the learner opens
 * themselves completes far more often than one thrown at them. So most of these
 * are a quiet pulse on the thing itself, and open on tap.
 *
 * Every moment fires once, ever, per account-on-this-device, and none of them
 * block what the learner was doing.
 */

const KEY = 'tour:seen'

/** Every contextual moment. `auto` opens itself; the rest wait to be tapped. */
export const MOMENTS = {
  first_source: {
    title: 'Your material becomes the syllabus',
    body: 'Everything you upload is read once and split into the domains your '
      + 'real exam is weighted by. Add more whenever — the plan updates.',
    auto: true,
  },
  domains_ready: {
    title: 'These are your domains',
    body: 'Each one carries its share of the real paper. Open any of them — '
      + 'nothing is locked, and the one marked "start here" is where the most '
      + 'marks are still on the table.',
    auto: true,
  },
  first_lecture: {
    title: 'Lectures are spoken, and you can interrupt',
    body: 'Tap play and your tutor teaches the domain out loud. Ask a question '
      + 'mid-sentence and it will stop and answer.',
  },
  flag_button: {
    title: 'Flag anything you want to come back to',
    body: 'It goes to your missed questions at the end of the session — whether '
      + 'you got it right or not.',
  },
  first_result: {
    title: 'What you got wrong is worth keeping',
    body: 'At the end of a session you are asked whether to save the ones you '
      + 'missed. Nothing goes in without you saying so.',
    auto: true,
  },
  missed_container: {
    title: 'Your missed questions',
    body: 'Build a quiz, a deck or a paper straight out of these. A question '
      + 'leaves the pool once you get it right in two separate sittings.',
  },
  review_set: {
    title: 'One set from every domain at once',
    body: 'Made from what you have missed across the whole blueprint, which is '
      + 'the shape the real exam comes in.',
    auto: true,
  },
  domain_sort: {
    title: 'Two ways to read this list',
    body: 'Exam order is the one your objectives use. "What to study" ranks by '
      + 'marks still on the table — weakest domain weighted by what it is worth.',
  },
  kpi_tap: {
    title: 'The numbers open',
    body: 'Tap any of these to see exactly what it counted, grouped by domain.',
  },
  baseline_offer: {
    title: 'Start with a baseline',
    body: 'One sitting, before you study, so everything afterwards is measured '
      + 'against where you actually started. You only ever take it once.',
  },
}

export function seen() {
  try {
    return new Set(JSON.parse(window.localStorage.getItem(KEY) || '[]'))
  } catch {
    // Storage refused. Every moment shows again, which is survivable — the
    // alternative is crashing on a browser setting.
    return new Set()
  }
}

export function hasSeen(id) {
  return seen().has(id)
}

export function markSeen(id) {
  try {
    const all = seen()
    all.add(id)
    window.localStorage.setItem(KEY, JSON.stringify([...all]))
  } catch { /* not worth an error over a hint */ }
}

/** For the demo, and for a "show me again" control if one is ever wanted. */
export function reset() {
  try {
    window.localStorage.removeItem(KEY)
  } catch { /* ignore */ }
}
