/**
 * Mapping playback position to a sentence in the transcript (§5.5).
 *
 * There are no word-level timings to work from. The lecture text is one blob
 * and the audio is a set of MP3 chunks, so highlighting has to be derived.
 *
 * The derivation is per-chunk rather than across the whole lecture, which
 * matters: each chunk's character count is known exactly, and its *real*
 * duration becomes known once the browser loads it. Interpolating only within
 * a chunk keeps drift bounded to that chunk instead of letting an early
 * mis-estimate skew the rest of the lecture.
 *
 * Pure functions, so the arithmetic is testable without an audio element.
 */

/** Split prose into sentences, keeping each one's character offsets. */
export function splitSentences(text) {
  if (!text) return []

  const sentences = []
  // Split after . ! ? followed by whitespace. Abbreviations will occasionally
  // split early; that costs a highlight landing one clause off, which is a far
  // better failure than a regex complex enough to be wrong in novel ways.
  const pattern = /[^.!?]+[.!?]+(?:\s+|$)|[^.!?]+$/g
  let match

  while ((match = pattern.exec(text)) !== null) {
    const raw = match[0]
    const trimmed = raw.trim()
    if (!trimmed) continue
    sentences.push({
      text: trimmed,
      start: match.index,
      end: match.index + raw.length,
    })
  }
  return sentences
}

/**
 * Build `[{text, startTime, endTime}]` for the whole lecture.
 *
 * `chunks` carry `chars`; `durations` are the real per-chunk lengths once
 * known, falling back to each chunk's estimate. A sentence spanning a chunk
 * boundary is attributed to the chunk holding its first character.
 */
export function buildTimeline(sentences, chunks, durations = []) {
  if (!sentences.length || !chunks?.length) return []

  // Character range and elapsed-time offset for each chunk.
  const bounds = []
  let charCursor = 0
  let timeCursor = 0

  chunks.forEach((chunk, index) => {
    const chars = chunk.chars || 0
    const duration = durations[index] > 0 ? durations[index] : chunk.duration_secs || 0
    bounds.push({
      charStart: charCursor,
      charEnd: charCursor + chars,
      timeStart: timeCursor,
      duration,
      chars,
    })
    charCursor += chars
    timeCursor += duration
  })

  const totalChars = charCursor || 1

  return sentences.map((sentence) => {
    // Chunk boundaries come from the concatenated chunk text, while offsets
    // come from the transcript; whitespace between chunks makes them drift by
    // a few characters, so scale into chunk-space before locating.
    const scaled = (sentence.start / (sentences.at(-1)?.end || totalChars)) * totalChars
    const chunk =
      bounds.find((b) => scaled >= b.charStart && scaled < b.charEnd) || bounds.at(-1)

    const within = chunk.chars > 0 ? (scaled - chunk.charStart) / chunk.chars : 0
    const startTime = chunk.timeStart + Math.max(0, Math.min(1, within)) * chunk.duration

    return { text: sentence.text, startTime, endTime: 0 }
  }).map((entry, index, all) => ({
    ...entry,
    // A sentence runs until the next one begins; the last runs to the end.
    endTime:
      index < all.length - 1
        ? all[index + 1].startTime
        : bounds.at(-1).timeStart + bounds.at(-1).duration,
  }))
}

/** Index of the sentence playing at `position`, or -1 before the first. */
export function activeSentenceIndex(timeline, position) {
  if (!timeline?.length) return -1
  if (position < timeline[0].startTime) return 0

  // Linear scan from the end: playback moves forward, and lectures are a few
  // hundred sentences at most, so a binary search buys nothing measurable.
  for (let i = timeline.length - 1; i >= 0; i -= 1) {
    if (position >= timeline[i].startTime) return i
  }
  return 0
}

/** Which chunk holds a global position, and the offset inside it. */
export function locateChunk(position, chunks, durations = []) {
  if (!chunks?.length) return { index: 0, offset: 0 }

  let elapsed = 0
  for (let i = 0; i < chunks.length; i += 1) {
    const duration = durations[i] > 0 ? durations[i] : chunks[i].duration_secs || 0
    if (position < elapsed + duration || i === chunks.length - 1) {
      return { index: i, offset: Math.max(0, position - elapsed) }
    }
    elapsed += duration
  }
  return { index: chunks.length - 1, offset: 0 }
}

/** Elapsed time before a chunk starts. */
export function chunkStartTime(index, chunks, durations = []) {
  let elapsed = 0
  for (let i = 0; i < index && i < chunks.length; i += 1) {
    elapsed += durations[i] > 0 ? durations[i] : chunks[i].duration_secs || 0
  }
  return elapsed
}

/** Total lecture length from real durations where known. */
export function totalDuration(chunks, durations = []) {
  if (!chunks?.length) return 0
  return chunks.reduce(
    (sum, chunk, i) =>
      sum + (durations[i] > 0 ? durations[i] : chunk.duration_secs || 0),
    0,
  )
}
