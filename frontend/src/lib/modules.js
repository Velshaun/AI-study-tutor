/**
 * Removing a module from the caches the dashboard reads.
 *
 * Deleting a module clears its storage objects server-side, which takes several
 * seconds. Waiting for that leaves the card sitting there as though the tap did
 * nothing, so the UI drops it immediately and the caller restores the snapshot
 * if the request actually fails.
 *
 * Kept here rather than in one screen so every place a module can be deleted
 * behaves the same way.
 */

/**
 * The resume card to show once `deletedId` is gone.
 *
 * "Continue where you left off" points at one lecture; if that lecture belonged
 * to the deleted module, the next most recently played module takes its place
 * rather than the section vanishing.
 */
function nextResume(modules, deletedId) {
  const candidates = (modules || [])
    .filter((m) => m.id !== deletedId && m.resume_lecture_id)
    .sort((a, b) => {
      const at = a.resume_last_played_at || a.last_accessed_at || ''
      const bt = b.resume_last_played_at || b.last_accessed_at || ''
      return String(bt).localeCompare(String(at))
    })

  const next = candidates[0]
  if (!next) return null
  return {
    lecture_id: next.resume_lecture_id,
    module_id: next.id,
    module_title: next.title,
    // The server knows the position and duration; until the refetch lands the
    // card shows the module it will resume rather than a false progress bar.
    domain_id: null,
    domain_title: null,
    position_secs: 0,
    duration_secs: null,
    progress_pct: 0,
    last_played_at: next.resume_last_played_at || null,
  }
}

/** Drop a module from the module list and the dashboard, in place. */
export function removeModuleFromCaches(queryClient, moduleId) {
  const remaining = ((queryClient.getQueryData(['modules']) || []).filter(
    (m) => m.id !== moduleId,
  ))
  queryClient.setQueryData(['modules'], (list) =>
    Array.isArray(list) ? list.filter((m) => m.id !== moduleId) : list,
  )

  queryClient.setQueryData(['dashboard'], (data) => {
    if (!data) return data
    const resumeGone = data.resume?.module_id === moduleId
    return {
      ...data,
      resume: resumeGone ? nextResume(remaining, moduleId) : data.resume,
      has_modules: remaining.length > 0,
      stats: {
        ...data.stats,
        total_modules: Math.max(0, (data.stats?.total_modules || 1) - 1),
      },
    }
  })
}
