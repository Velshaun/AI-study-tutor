/**
 * Reading an import job the way a learner sees it.
 *
 * A playlist arrives from the queue as a flat list: one parent item that did
 * the listing, then one child per video, all siblings in the same array. Drawn
 * literally that is twenty-two rows of equal weight, of which the first is
 * "Found 21 videos" — a wall that says nothing about how the import is going.
 *
 * The shape a learner has in mind is one playlist that contains videos, so the
 * grouping happens here, and the estimate with it. Pure functions: the run that
 * motivated all of this took forty-eight seconds in production and is not
 * something anyone wants to re-stage to check a label.
 */

/** Items the queue creates for bookkeeping rather than for material. */
const LISTING_KINDS = ['playlist']

export function isListing(item) {
  return LISTING_KINDS.includes(item?.kind) ||
    (item?.payload?.target_kind ?? item?.target_kind) === 'playlist'
}

const TERMINAL = ['succeeded', 'failed', 'skipped']

export function isFinished(item) {
  return TERMINAL.includes(item?.status)
}

/**
 * Split a job's items into playlists-with-children and everything else.
 *
 * A parent whose children haven't been appended yet is still a playlist — it
 * is mid-listing, and showing it as a lone row that later mutates into a group
 * would make the first ten seconds of every playlist import look like a
 * different kind of import.
 */
export function groupItems(items = []) {
  const children = new Map()
  for (const item of items) {
    if (!item?.parent_item_id) continue
    const siblings = children.get(item.parent_item_id) || []
    siblings.push(item)
    children.set(item.parent_item_id, siblings)
  }

  const groups = []
  const loose = []
  for (const item of items) {
    if (item?.parent_item_id) continue
    if (isListing(item)) {
      groups.push(toGroup(item, children.get(item.id) || []))
    } else {
      loose.push(item)
    }
  }
  return { groups, loose }
}

function toGroup(parent, videos) {
  const done = videos.filter((v) => v.status === 'succeeded').length
  const failed = videos.filter((v) => v.status === 'failed').length
  return {
    id: parent.id,
    parent,
    videos,
    title: parent.title || parent.payload?.title || 'Playlist',
    done,
    failed,
    total: videos.length,
    // Before the listing lands there is nothing to count, and "0 of 0" reads as
    // an empty playlist rather than one still being read.
    listing: parent.status === 'running' || parent.status === 'pending',
    // The row to keep in view. Falls back to the first unfinished one so a
    // paused or queued group still scrolls somewhere useful.
    activeIndex: activeIndexOf(videos),
  }
}

function activeIndexOf(videos) {
  const running = videos.findIndex((v) => v.status === 'running')
  if (running !== -1) return running
  const pending = videos.findIndex((v) => !isFinished(v))
  if (pending !== -1) return pending
  return Math.max(0, videos.length - 1)
}

/** "17 of 21 read · 2 didn't work" — the one line that stands for the group. */
export function summarise({ done, failed, total, listing }) {
  if (listing && !total) return 'Reading the playlist…'
  const parts = [`${done} of ${total} read`]
  if (failed) parts.push(`${failed} didn’t work`)
  return parts.join(' · ')
}

/**
 * Seconds left, derived from how fast this job has actually gone.
 *
 * Measured from `claimed_at` rather than `created_at`: a job that waited behind
 * another import didn't spend that time on videos, and counting it would make
 * every estimate grow the longer the queue was.
 *
 * Returns null rather than a guess when there isn't enough to go on. A number
 * that appears instantly and then triples is worse than no number — one item
 * is not a rate, it's a sample.
 */
const MIN_SAMPLE = 2

export function estimateRemaining({ claimedAt, finished, total, now = Date.now() }) {
  if (!claimedAt || !total) return null
  if (finished < MIN_SAMPLE || finished >= total) return null

  const elapsed = (now - new Date(claimedAt).getTime()) / 1000
  if (!(elapsed > 0)) return null

  const perItem = elapsed / finished
  return Math.round(perItem * (total - finished))
}

/**
 * Deliberately coarse. The estimate is an extrapolation from a handful of
 * videos, and rendering it as "3m 47s left" claims a precision it does not
 * have — then contradicts itself every tick.
 */
export function formatRemaining(seconds) {
  if (seconds == null) return ''
  if (seconds < 45) return 'less than a minute left'
  const minutes = Math.round(seconds / 60)
  if (minutes <= 1) return 'about a minute left'
  if (minutes < 60) return `about ${minutes} minutes left`
  const hours = Math.round(minutes / 6) / 10
  return `about ${hours} hours left`
}

/**
 * The same regrouping, one layer further on: stored sources rather than queue
 * items.
 *
 * A playlist import lands one `user_files` row per video, so the Sources tab
 * drew ninety-seven rows and buried every PDF the learner had uploaded. The
 * queue solved this for the import screen; the sources list needs the same
 * answer, because it is the same fact — a playlist is one thing the learner
 * added, however many rows it takes to store it.
 *
 * `group_key` is the import batch and `group_title` is what to call it. Sources
 * without a title are drawn on their own, so nothing else changes shape.
 */
export function groupSources(sources = []) {
  const groups = new Map()
  const loose = []

  for (const source of sources) {
    if (!source?.group_key || !source?.group_title) {
      loose.push(source)
      continue
    }
    const existing = groups.get(source.group_key)
    if (existing) {
      existing.sources.push(source)
    } else {
      groups.set(source.group_key, {
        key: source.group_key,
        title: source.group_title,
        sources: [source],
      })
    }
  }

  // Order is preserved from the incoming list, and a group sits where its first
  // member did — so importing a playlist doesn't reshuffle everything above it.
  const out = []
  const placed = new Set()
  for (const source of sources) {
    if (source?.group_key && source?.group_title) {
      if (placed.has(source.group_key)) continue
      placed.add(source.group_key)
      out.push({ kind: 'group', ...groups.get(source.group_key) })
    } else {
      out.push({ kind: 'source', source })
    }
  }
  return { rows: out, groups: [...groups.values()], loose }
}

/** "97 videos · 4 still reading" — the line that stands for the whole group. */
export function summariseSources(group) {
  const total = group.sources.length
  const pending = group.sources.filter(
    (s) => s.status !== 'parsed' && s.status !== 'failed',
  ).length
  const failed = group.sources.filter((s) => s.status === 'failed').length

  const parts = [`${total} video${total === 1 ? '' : 's'}`]
  if (pending) parts.push(`${pending} still reading`)
  if (failed) parts.push(`${failed} didn\u2019t work`)
  return parts.join(' \u00b7 ')
}
