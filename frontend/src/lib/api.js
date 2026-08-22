import { getAccessToken } from './supabase'

/**
 * Backend client.
 *
 * Attaches the Supabase access token to every request. Errors are normalised
 * into `ApiError` so screens can distinguish "not signed in" from "server
 * broke" — the dashboard shows a sign-in prompt for the former and an error
 * state for the latter, and conflating them would strand a signed-out user on
 * a spinner.
 */

const BASE = (import.meta.env.VITE_API_URL || '').replace(/\/$/, '')

export class ApiError extends Error {
  constructor(message, { status, body } = {}) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.body = body
  }

  /** No session, or the token was rejected. */
  get isAuth() {
    return this.status === 401 || this.status === 403
  }
}

export async function apiFetch(path, { method = 'GET', body, signal } = {}) {
  if (!BASE) {
    throw new ApiError('VITE_API_URL is not configured.', { status: 0 })
  }

  const token = await getAccessToken()
  if (!token) {
    throw new ApiError('Not signed in.', { status: 401 })
  }

  let response
  try {
    response = await fetch(`${BASE}${path}`, {
      method,
      signal,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    })
  } catch (cause) {
    if (cause?.name === 'AbortError') throw cause
    throw new ApiError('Could not reach the server.', { status: 0 })
  }

  if (response.status === 204) return null

  const payload = await response.json().catch(() => null)

  if (!response.ok) {
    throw new ApiError(
      payload?.detail || `Request failed (${response.status})`,
      { status: response.status, body: payload },
    )
  }
  return payload
}

/** Multipart upload. No Content-Type header, so the browser sets the correct
 *  multipart boundary itself. */
export async function apiUpload(path, formData, method = 'POST') {
  if (!BASE) throw new ApiError('VITE_API_URL is not configured.', { status: 0 })
  const token = await getAccessToken()
  if (!token) throw new ApiError('Not signed in.', { status: 401 })

  let response
  try {
    response = await fetch(`${BASE}${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}` },
      body: formData,
    })
  } catch {
    throw new ApiError('Could not reach the server.', { status: 0 })
  }
  if (response.status === 204) return null
  const payload = await response.json().catch(() => null)
  if (!response.ok) {
    throw new ApiError(payload?.detail || `Upload failed (${response.status})`, {
      status: response.status,
      body: payload,
    })
  }
  return payload
}

/**
 * POST and consume a newline-delimited JSON (NDJSON) stream, invoking `onEvent`
 * for each object as it arrives — used for low-latency streamed responses
 * (e.g. the voice-Q&A answer). Resolves when the stream ends.
 */
export async function apiStreamNDJSON(path, body, onEvent, signal) {
  if (!BASE) throw new ApiError('VITE_API_URL is not configured.', { status: 0 })
  const token = await getAccessToken()
  if (!token) throw new ApiError('Not signed in.', { status: 401 })

  const response = await fetch(`${BASE}${path}`, {
    method: 'POST',
    signal,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!response.ok || !response.body) {
    const payload = await response.json().catch(() => null)
    throw new ApiError(payload?.detail || `Request failed (${response.status})`, {
      status: response.status,
      body: payload,
    })
  }

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  const flush = (line) => {
    const trimmed = line.trim()
    if (trimmed) onEvent(JSON.parse(trimmed))
  }

  for (;;) {
    const { value, done } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    let nl
    while ((nl = buffer.indexOf('\n')) >= 0) {
      flush(buffer.slice(0, nl))
      buffer = buffer.slice(nl + 1)
    }
  }
  flush(buffer)
}

/** Fetch a file endpoint with auth and trigger a browser download. */
export async function apiDownload(path, filename) {
  const token = await getAccessToken()
  if (!token) throw new ApiError('Not signed in.', { status: 401 })
  const response = await fetch(`${BASE}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  })
  if (!response.ok) {
    throw new ApiError(`Download failed (${response.status})`, {
      status: response.status,
    })
  }
  const blob = await response.blob()
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  URL.revokeObjectURL(url)
}

export const api = {
  dashboard: (signal) => apiFetch('/stats/dashboard', { signal }),
  moduleStats: (moduleId, signal) =>
    apiFetch(`/stats/module/${moduleId}`, { signal }),
  modules: (signal) => apiFetch('/modules', { signal }),
  module: (id, signal) => apiFetch(`/modules/${id}`, { signal }),
  touchModule: (id) => apiFetch(`/modules/${id}/touch`, { method: 'POST' }),
  studioMedia: (id, signal) => apiFetch(`/modules/${id}/studio`, { signal }),
  discover: (id, query) =>
    apiFetch(`/modules/${id}/discover`, { method: 'POST', body: { query } }),
  // The module tutor: a conversation that persists, can judge whether the
  // uploaded material covers the exam, and can search for study resources.
  tutorHistory: (moduleId, signal) =>
    apiFetch(`/modules/${moduleId}/tutor`, { signal }),
  askTutor: (
    moduleId,
    question,
    { forceAssessment = false, resumeMessageId = null } = {},
  ) =>
    apiFetch(`/modules/${moduleId}/tutor`, {
      method: 'POST',
      body: {
        question,
        force_assessment: forceAssessment,
        resume_message_id: resumeMessageId,
      },
    }),
  clearTutor: (moduleId) =>
    apiFetch(`/modules/${moduleId}/tutor`, { method: 'DELETE' }),
  // What every source actually covers, domain by domain, from reading all of
  // them rather than a sample. Built in the background; poll while computing.
  coverage: (moduleId, signal) =>
    apiFetch(`/modules/${moduleId}/coverage`, { signal }),
  refreshCoverage: (moduleId) =>
    apiFetch(`/modules/${moduleId}/coverage/refresh`, { method: 'POST' }),
  // Per-domain strength from everything the learner has been graded on. The
  // shown score is deliberately smoother than the last result — see the
  // backend's performance service.
  performance: (moduleId, signal) =>
    apiFetch(`/stats/performance/${moduleId}`, { signal }),
  // Past sittings, newest first, each with its per-domain breakdown.
  examAttempts: (moduleId, signal) =>
    apiFetch(`/practice-exam/attempts/${moduleId}`, { signal }),
  examAttempt: (attemptId, signal) =>
    apiFetch(`/practice-exam/attempt/${attemptId}`, { signal }),

  // Tell the backend a discovered link is dead/walled/off-topic. It stops
  // coming back, and a host reported repeatedly is dropped wholesale.
  reportDeadLink: (id, url, reason = 'dead') =>
    apiFetch(`/modules/${id}/discover/report`, {
      method: 'POST',
      body: { url, reason },
    }),
  unreportDeadLink: (id, url) =>
    apiFetch(`/modules/${id}/discover/report?url=${encodeURIComponent(url)}`, {
      method: 'DELETE',
    }),
  createModule: (body = {}) => apiFetch('/modules', { method: 'POST', body }),
  // Does this material belong where it's about to go? `moduleId` omitted
  // asks whether it already has a home; supplied, whether it fits that one.
  // What a pasted YouTube link actually is, and where it would be filed —
  // answered before anything is queued, so the learner confirms first.
  previewYouTube: (moduleId, url) =>
    apiFetch('/import/youtube/preview', {
      method: 'POST',
      body: { module_id: moduleId, url },
    }),
  cancelImport: (jobId) =>
    apiFetch(`/import/jobs/${jobId}/cancel`, { method: 'POST' }),
  // Deletes every source of one playlist in a single request. A client-side
  // loop over ninety-seven ids would be ninety-seven rebuild deadlines and a
  // half-deleted playlist if it stopped partway.
  deleteSourceGroup: (moduleId, groupKey) =>
    apiFetch(`/sources/group/${moduleId}/${groupKey}`, { method: 'DELETE' }),
  // --- the two containers, and the sessions that feed them ------------------
  // Nothing else in the app reads a container: these are the only calls that
  // touch it, which is what "opt-in and isolated" means in practice.
  // Where you started against where you are. Null for most modules: the
  // pre-assessment is optional, and not having one isn't a problem.
  // Two calls on purpose: planning never mutates, and acting takes the
  // plan rather than the sentence — so the model is not involved in the
  // confirmation and cannot talk its way through it.
  speakTutorReply: (moduleId, text, voice) =>
    apiFetch(`/modules/${moduleId}/tutor/speak`, {
      method: 'POST', body: { text, voice },
    }),
  planTutorAction: (moduleId, message) =>
    apiFetch(`/modules/${moduleId}/tutor/plan`, {
      method: 'POST', body: { message },
    }),
  runTutorAction: (moduleId, actions) =>
    apiFetch(`/modules/${moduleId}/tutor/act`, {
      method: 'POST', body: { actions },
    }),
  baselineComparison: (moduleId, signal) =>
    apiFetch(`/stats/baseline/${moduleId}`, { signal }),
  container: (moduleId, name, signal) =>
    apiFetch(`/bank/${moduleId}/${name}`, { signal }),
  addToContainer: (moduleId, name, body) =>
    apiFetch(`/bank/${moduleId}/${name}/add`, { method: 'POST', body }),
  deleteContainerEntry: (entryId) =>
    apiFetch(`/bank/entry/${entryId}`, { method: 'DELETE' }),
  generateFromContainer: (moduleId, name, body) =>
    apiFetch(`/bank/${moduleId}/${name}/generate`, { method: 'POST', body }),
  recordSession: (body) => apiFetch('/bank/sessions', { method: 'POST', body }),
  // The same dials as a container, over one past sitting's questions.
  generateFromSession: (moduleId, sessionId, body) =>
    apiFetch(`/bank/sessions/${sessionId}/generate`, { method: 'POST', body }),
  sessions: (moduleId, signal) => apiFetch(`/bank/sessions/${moduleId}`, { signal }),
  subjectCheck: (texts, moduleId) =>
    apiFetch('/modules/subject-check', {
      method: 'POST',
      body: { texts, module_id: moduleId ?? null },
    }),
  renameModule: (id, title) =>
    apiFetch(`/modules/${id}`, { method: 'PATCH', body: { title } }),
  // The real exam's shape — practice sets size themselves from it.
  // body: { exam_question_count?, exam_duration_minutes? }
  setExamProfile: (id, body) =>
    apiFetch(`/modules/${id}`, { method: 'PATCH', body }),
  deleteModule: (id) => apiFetch(`/modules/${id}`, { method: 'DELETE' }),

  // Importing pasted material. The work runs in the worker, so these return
  // a job to watch rather than the finished result — JobsProvider picks it up
  // over Realtime and the browser is free to close.
  detectImport: (text) =>
    apiFetch('/import/detect', { method: 'POST', body: { text } }),
  // A pasted YouTube link, or a search. The link door needs no API key, which
  // is why it's tried first and why the app survives the search quota running
  // out.
  importYouTube: (moduleId, body) =>
    apiFetch('/import/youtube', { method: 'POST', body: { module_id: moduleId, ...body } }),
  importPaste: (moduleId, items) =>
    apiFetch('/import/paste', { method: 'POST', body: { module_id: moduleId, items } }),
  importJobs: (moduleId, signal) =>
    apiFetch(`/import/jobs/${moduleId}`, { signal }),
  retryImport: (jobId) =>
    apiFetch(`/import/jobs/${jobId}/retry`, { method: 'POST' }),

  // Sources & processing pipeline
  sources: (moduleId, signal) => apiFetch(`/sources/${moduleId}`, { signal }),
  moduleStatus: (moduleId, signal) =>
    apiFetch(`/sources/${moduleId}/status`, { signal }),
  uploadSources: (moduleId, files) => {
    const fd = new FormData()
    fd.append('module_id', moduleId)
    for (const f of files) fd.append('files', f)
    return apiUpload('/sources/upload', fd)
  },
  addLink: (moduleId, url) =>
    apiFetch('/sources/link', { method: 'POST', body: { module_id: moduleId, url } }),
  deleteSource: (fileId) => apiFetch(`/sources/file/${fileId}`, { method: 'DELETE' }),
  // Non-destructive by default: domains holding lectures, flashcards, quizzes
  // or practice questions are updated in place rather than replaced. `force`
  // rebuilds the blueprint outright and deletes that content — only pass it
  // after the learner has confirmed against `reprocessImpact`.
  processModule: (moduleId, { force = false } = {}) =>
    apiFetch(`/sources/${moduleId}/process${force ? '?force=true' : ''}`, {
      method: 'POST',
    }),
  reprocessImpact: (moduleId, signal) =>
    apiFetch(`/sources/${moduleId}/reprocess-impact`, { signal }),

  // Course context (PUT accepts either pasted text or an uploaded file)
  courseContext: (moduleId, signal) =>
    apiFetch(`/modules/${moduleId}/course-context`, { signal }),
  setCourseContextText: (moduleId, text) => {
    const fd = new FormData()
    fd.append('text', text)
    return apiUpload(`/modules/${moduleId}/course-context`, fd, 'PUT')
  },
  setCourseContextFile: (moduleId, file) => {
    const fd = new FormData()
    fd.append('file', file)
    return apiUpload(`/modules/${moduleId}/course-context`, fd, 'PUT')
  },
  clearCourseContext: (moduleId) =>
    apiFetch(`/modules/${moduleId}/course-context`, { method: 'DELETE' }),

  // Lectures (domain-scoped get-or-generate for the study links)
  lectureForDomain: (domainId, signal) =>
    apiFetch(`/lectures/${domainId}`, { signal }),
  generateLecture: (body) =>
    apiFetch('/lectures/generate', { method: 'POST', body }),
  // Is it playable yet? Generation returns a row long before there is audio in
  // it, so anything offering to open a lecture polls this first.
  lectureStatus: (lectureId, signal) =>
    apiFetch(`/lectures/${lectureId}/status`, { signal }),

  // Export (authenticated file downloads)
  exportModuleJson: (moduleId, filename) =>
    apiDownload(`/export/module/${moduleId}`, filename),
  exportModulePdf: (moduleId, filename) =>
    apiDownload(`/export/module/${moduleId}/pdf`, filename),
  shareDomain: (groupId, body) =>
    apiFetch(`/groups/${groupId}/share`, { method: 'POST', body }),

  // Practice exams (imported + weighted generation)
  importExam: (moduleId, file) => {
    const fd = new FormData()
    fd.append('module_id', moduleId)
    fd.append('file', file)
    return apiUpload('/practice-exam/import', fd)
  },
  importedSets: (moduleId, signal) =>
    apiFetch(`/practice-exam/imported/${moduleId}`, { signal }),
  favouriteImported: (batchId) =>
    apiFetch(`/practice-exam/imported/${batchId}/favourite`, { method: 'PATCH' }),
  deleteImported: (batchId) =>
    apiFetch(`/practice-exam/imported/${batchId}`, { method: 'DELETE' }),
  generateExam: (body) =>
    apiFetch('/practice-exam/generate', { method: 'POST', body }),
  // Reveal one exam question's answer, once it has been answered. The paper
  // itself ships without its key so a sitting can't be inflated by reading the
  // response — see the runner.
  answerExamQuestion: (examId, index, chosenIndex) =>
    apiFetch(`/practice-exam/${examId}/answer`, {
      method: 'POST',
      body: { index, chosen_index: chosenIndex },
    }),
  // The baseline sitting, taken before any studying. The same generator and the
  // same runner — `adaptive: false` because a baseline has to measure the
  // blueprint as published, not as the learner's weaknesses would reweight it.
  generatePreAssessment: (moduleId) =>
    apiFetch('/practice-exam/generate', {
      method: 'POST',
      body: { module_id: moduleId, kind: 'pre_assessment', adaptive: false },
    }),
  // Saved progress through a quiz, exam, practice set or deck. `itemType` is
  // 'quiz' | 'exam' | 'practice' | 'flashcards'; `itemId` is the quiz/exam id
  // or, for a set or deck, the domain's.
  attempt: (itemType, itemId, signal) =>
    apiFetch(`/attempts/${itemType}/${itemId}`, { signal }),
  saveAttempt: (itemType, itemId, body) =>
    apiFetch(`/attempts/${itemType}/${itemId}`, { method: 'PUT', body }),
  clearAttempt: (itemType, itemId) =>
    apiFetch(`/attempts/${itemType}/${itemId}`, { method: 'DELETE' }),
  openAttempts: (signal) => apiFetch('/attempts/open', { signal }),

  // One stored exam with its questions — generated or imported, same shape.
  exam: (examId, signal) => apiFetch(`/practice-exam/${examId}`, { signal }),
  deleteExam: (examId) => apiFetch(`/practice-exam/${examId}`, { method: 'DELETE' }),
  // `deck` names one of the domain's decks; omitting it removes every card the
  // domain holds, which is what this meant when a domain could only hold one.
  deleteFlashcardDeck: (domainId, deck) =>
    apiFetch(
      `/flashcards/deck/${domainId}` +
        (deck ? `?deck=${encodeURIComponent(deck)}` : ''),
      { method: 'DELETE' },
    ),
  deletePracticeSet: (domainId) =>
    apiFetch(`/practice/${domainId}/questions`, { method: 'DELETE' }),
  deleteLecture: (lectureId) =>
    apiFetch(`/lectures/${lectureId}`, { method: 'DELETE' }),
  submitExam: (examId, answers) =>
    apiFetch(`/practice-exam/${examId}/submit`, { method: 'POST', body: { answers } }),

  // Practice Exam Mode (spec 6.4) — domain-scoped, per-question feedback.
  // Returns { questions, target_count, generating }: the first questions come
  // back immediately and the rest are written behind them, so poll while
  // `generating` is true.
  practiceQuestions: (domainId, { count, regenerate } = {}, signal) => {
    const qs = new URLSearchParams()
    if (count) qs.set('count', count)
    if (regenerate) qs.set('regenerate', 'true')
    const suffix = qs.toString() ? `?${qs}` : ''
    return apiFetch(`/practice/${domainId}/questions${suffix}`, { signal })
  },
  reviewLaterQuestions: (domainId, signal) =>
    apiFetch(`/practice/${domainId}/review-later`, { signal }),
  // Server-side reveal: explanations + Why Card only arrive once an answer is
  // submitted (they're never in the questions payload).
  submitAnswer: (questionId, chosenOption) =>
    apiFetch(`/practice/questions/${questionId}/submit-answer`, {
      method: 'POST',
      body: { chosen_option: chosenOption },
    }),
  flagQuestion: (questionId) =>
    apiFetch(`/practice/questions/${questionId}/flag`, { method: 'POST' }),
  gotItQuestion: (questionId) =>
    apiFetch(`/practice/questions/${questionId}/got-it`, { method: 'POST' }),
  qaSessions: (domainId, signal) =>
    apiFetch(`/qa-sessions?domain_id=${encodeURIComponent(domainId)}`, { signal }),
  qaExchanges: (sessionId, signal) =>
    apiFetch(`/qa-sessions/${sessionId}/exchanges?include_all=true`, { signal }),

  // Flashcards
  flashcards: (domainId, signal) =>
    apiFetch(`/flashcards/${domainId}`, { signal }),
  generateFlashcards: (body) =>
    apiFetch('/flashcards/generate', { method: 'POST', body }),
  // Import a deck from parsed CSV rows. body: { name, cards: [{front, back}] }
  importFlashcards: (moduleId, body) =>
    apiFetch('/flashcards/import', {
      method: 'POST',
      body: { module_id: moduleId, ...body },
    }),
  favouriteFlashcard: (id) =>
    apiFetch(`/flashcards/${id}/favourite`, { method: 'PATCH' }),
  deleteFlashcard: (id) => apiFetch(`/flashcards/${id}`, { method: 'DELETE' }),

  // Quizzes
  quizzes: (domainId, signal) => apiFetch(`/quizzes/${domainId}`, { signal }),
  generateQuiz: (body) =>
    apiFetch('/quizzes/generate', { method: 'POST', body }),
  submitQuiz: (id, answers) =>
    apiFetch(`/quizzes/${id}/submit`, { method: 'POST', body: { answers } }),
  favouriteQuiz: (id) => apiFetch(`/quizzes/${id}/favourite`, { method: 'PATCH' }),
  deleteQuiz: (id) => apiFetch(`/quizzes/${id}`, { method: 'DELETE' }),

  // Favourites (all starred items, grouped by type)
  favourites: (signal) => apiFetch('/favourites', { signal }),

  // Groups
  groups: (signal) => apiFetch('/groups', { signal }),
  group: (id, signal) => apiFetch(`/groups/${id}`, { signal }),
  createGroup: (body) => apiFetch('/groups', { method: 'POST', body }),
  joinGroup: (invite_code) =>
    apiFetch('/groups/join', { method: 'POST', body: { invite_code } }),
  updateShare: (groupId, domainId, body) =>
    apiFetch(`/groups/${groupId}/share/${domainId}`, { method: 'PATCH', body }),
  setViewQa: (groupId, domainId, view_qa) =>
    apiFetch(`/groups/${groupId}/domains/${domainId}/view`, {
      method: 'PATCH',
      body: { view_qa },
    }),
  sharedContent: (groupId, signal) =>
    apiFetch(`/groups/${groupId}/shared-content`, { signal }),
  leaveGroup: (groupId, userId) =>
    apiFetch(`/groups/${groupId}/members/${userId}`, { method: 'DELETE' }),
  deleteGroup: (groupId) => apiFetch(`/groups/${groupId}`, { method: 'DELETE' }),
}
