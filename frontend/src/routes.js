/**
 * Route paths — spec §5.2.
 *
 * Single source of truth. Screens and the nav build links from `path()` rather
 * than hand-writing template strings, so a route can be renamed here without
 * hunting for stale literals that would only fail at runtime.
 */

export const ROUTES = {
  dashboard: '/',
  login: '/login',
  onboarding: '/onboarding',
  module: '/module/:id',
  // Paste-and-stage import, module-scoped: it adds material to one module.
  importSources: '/module/:id/import',
  lecture: '/lecture/:id',
  flashcards: '/flashcards/:domainId',
  quizzes: '/quizzes/:domainId',
  // Practice exams are module-level (weighted across a module's domains).
  practice: '/practice/:moduleId',
  // Practice Exam Mode (§6.4) is domain-scoped: per-question feedback + Why Card.
  practiceMode: '/practice-mode/:domainId',
  // A stored exam — generated or imported — opened by id.
  examRun: '/exam/:examId',
  reviewLater: '/review-later/:domainId',
  // Beyond §5.2's list: the §5.6b per-domain Q&A review screen. Reached from
  // the module/lecture screens once those are built.
  qaReview: '/qa/:domainId',
  groups: '/groups',
  settings: '/settings',
  favourites: '/favourites',
}

/**
 * Build a concrete URL from a route key.
 *
 *   path('module', { id: moduleId })      -> '/module/abc-123'
 *   path('flashcards', { domainId: dId }) -> '/flashcards/def-456'
 */
export function path(key, params = {}) {
  const template = ROUTES[key]
  if (!template) {
    throw new Error(`Unknown route: ${key}`)
  }

  return template.replace(/:(\w+)/g, (_, name) => {
    const value = params[name]
    if (value === undefined || value === null || value === '') {
      throw new Error(`Route "${key}" needs a "${name}" param`)
    }
    return encodeURIComponent(value)
  })
}
