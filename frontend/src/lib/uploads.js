/**
 * What the app accepts from a device, and how a picked file is routed.
 *
 * One list, used by every picker. It used to be PDF, text and audio extensions
 * only — which on a phone resolves to the media picker, so photos of notes
 * couldn't be chosen at all and the picker looked like it only wanted video.
 *
 * MIME types sit alongside extensions deliberately: iOS reports a photo as
 * `image/jpeg` sometimes with no filename extension at all, and Android is
 * inconsistent the other way, so an accept list of either alone turns files
 * grey in the picker.
 */

/** Extension -> what the backend will do with it. */
const KINDS = {
  pdf: { exts: ['pdf'], mimes: ['application/pdf'], label: 'PDF' },
  image: {
    exts: ['jpg', 'jpeg', 'png', 'webp', 'heic', 'heif', 'gif', 'bmp'],
    // Concrete types as well as the wildcard: some Android pickers ignore
    // `image/*` but honour a named type, and some iOS versions do the reverse.
    // Listing both is what makes photos selectable everywhere.
    mimes: [
      'image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif',
      'image/gif', 'image/bmp', 'image/*',
    ],
    label: 'photo',
  },
  video: {
    exts: ['mp4', 'mov', 'webm', 'm4v', 'avi', 'mkv'],
    // `video/mov` isn't a registered type — QuickTime reports
    // `video/quicktime` — so both spellings are listed.
    mimes: [
      'video/mp4', 'video/quicktime', 'video/mov', 'video/webm', 'video/x-m4v',
      'video/*',
    ],
    label: 'video',
  },
  audio: {
    exts: ['mp3', 'wav', 'm4a', 'ogg', 'flac', 'mpga'],
    mimes: ['audio/*'],
    label: 'audio',
  },
  document: {
    // Word, PowerPoint and Excel — the modern zip formats extract cleanly;
    // the legacy binaries are accepted here and sorted out server-side, where
    // a mislabelled modern file passes and a genuine Word-97 binary refuses
    // with the one-step fix. Refusing .doc at the picker would just read as
    // "broken" to whoever was handed one by their lecturer.
    exts: ['docx', 'doc', 'pptx', 'ppt', 'xlsx', 'xlsm', 'xls'],
    mimes: [
      'application/msword',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'application/vnd.ms-powerpoint',
      'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      'application/vnd.ms-excel',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    ],
    label: 'document',
  },
  csv: {
    exts: ['csv', 'tsv'],
    mimes: ['text/csv', 'text/tab-separated-values'],
    label: 'CSV',
  },
  text: {
    exts: ['txt', 'md', 'markdown', 'rst'],
    mimes: ['text/plain', 'text/markdown'],
    label: 'text file',
  },
}

const dotted = (kind) => KINDS[kind].exts.map((e) => `.${e}`)

/** Everything, for the general "Browse files" picker. */
export const UPLOAD_ACCEPT = [
  ...Object.keys(KINDS).flatMap(dotted),
  ...Object.values(KINDS).flatMap((k) => k.mimes),
].join(',')

const mimesFor = (kind) => KINDS[kind].mimes

/** Photos and videos together — the phone's library picker. */
export const LIBRARY_ACCEPT = [
  ...dotted('image'), ...dotted('video'), ...mimesFor('image'), ...mimesFor('video'),
].join(',')

/** Documents only, for a file browser that shouldn't show the camera roll. */
export const DOCUMENT_ACCEPT = [
  ...dotted('pdf'), ...dotted('document'), ...dotted('csv'), ...dotted('text'),
  ...dotted('audio'),
  'application/pdf', ...KINDS.document.mimes, 'text/csv', 'text/plain', 'audio/*',
].join(',')

export const IMAGE_ACCEPT = [...dotted('image'), ...mimesFor('image')].join(',')
export const VIDEO_ACCEPT = [...dotted('video'), ...mimesFor('video')].join(',')

/** Human list for the hint under a dropzone. */
export const SUPPORTED_SUMMARY =
  'PDF, Word, PowerPoint, Excel, photos, screen recordings, audio, CSV or text'

/**
 * What kind of file this is: 'pdf' | 'image' | 'video' | 'audio' | 'csv' |
 * 'text' | null when we can't take it.
 *
 * Extension first, MIME as the fallback — the same order the backend uses, so
 * the two agree about what will happen to a file.
 */
export function classifyFile(file) {
  const name = (file?.name || '').toLowerCase()
  const ext = name.includes('.') ? name.split('.').pop() : ''
  const mime = (file?.type || '').toLowerCase()

  for (const [kind, spec] of Object.entries(KINDS)) {
    if (ext && spec.exts.includes(ext)) return kind
  }
  if (mime.startsWith('image/')) return 'image'
  if (mime.startsWith('video/')) return 'video'
  if (mime.startsWith('audio/')) return 'audio'
  if (mime === 'application/pdf') return 'pdf'
  if (KINDS.document.mimes.includes(mime)) return 'document'
  if (mime === 'text/csv' || mime === 'text/tab-separated-values') return 'csv'
  if (mime.startsWith('text/')) return 'text'
  return null
}

/**
 * Split a picked list into what can be uploaded, what should go to the CSV
 * flashcard importer, and what we have to turn away.
 */
export function sortPicked(files) {
  const accepted = []
  const csv = []
  const rejected = []
  for (const file of Array.from(files || [])) {
    const kind = classifyFile(file)
    if (!kind) rejected.push(file)
    else if (kind === 'csv') csv.push(file)
    else accepted.push(file)
  }
  return { accepted, csv, rejected }
}

/** A friendly, specific message for files we can't read. */
export function rejectionMessage(rejected) {
  if (!rejected?.length) return ''
  const names = rejected.map((f) => f.name).filter(Boolean)
  const subject =
    names.length === 1 ? `“${names[0]}”` : `${names.length} of those files`
  return (
    `We can't read ${subject} yet. Try a PDF, a Word or PowerPoint file, ` +
    `a spreadsheet, a photo of your notes ` +
    `(JPG, PNG, HEIC), a screen recording (MP4, MOV), audio (MP3, M4A, WAV), ` +
    `a CSV, or a text file.`
  )
}

/**
 * Is this source transcribed rather than parsed? Audio and screen recordings
 * both are, so the status line says "Transcribing…" for either.
 */
export function isTranscribed(source) {
  const kind = classifyFile({ name: source?.filename || '' })
  return (
    ['audio', 'video'].includes(source?.source_type) ||
    ['audio', 'video'].includes(kind)
  )
}
