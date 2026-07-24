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
  modules: (signal) => apiFetch('/modules', { signal }),
  module: (id, signal) => apiFetch(`/modules/${id}`, { signal }),
  createModule: (body = {}) => apiFetch('/modules', { method: 'POST', body }),
  renameModule: (id, title) =>
    apiFetch(`/modules/${id}`, { method: 'PATCH', body: { title } }),
  deleteModule: (id) => apiFetch(`/modules/${id}`, { method: 'DELETE' }),

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
  processModule: (moduleId) =>
    apiFetch(`/sources/${moduleId}/process`, { method: 'POST' }),

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
  submitExam: (examId, answers) =>
    apiFetch(`/practice-exam/${examId}/submit`, { method: 'POST', body: { answers } }),

  // Practice Exam Mode (spec 6.4) — domain-scoped, per-question feedback
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
