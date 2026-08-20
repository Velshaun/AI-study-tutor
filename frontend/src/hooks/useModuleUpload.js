import { useMutation, useQueryClient } from '@tanstack/react-query'

import { api } from '../lib/api'
import { UPLOAD_ACCEPT, rejectionMessage, sortPicked } from '../lib/uploads'
import { useConfirm } from './useConfirm'
import { useToast } from './useToast'

// Re-exported so the many pickers that already import it from here keep
// working; the list itself lives in lib/uploads with the routing rules.
export { UPLOAD_ACCEPT }

/**
 * Ask the server whether this material belongs where it's headed, and put the
 * question to the learner if it does not.
 *
 * One comparison, used from both hooks below: creating a module asks "does this
 * already have a home?", adding to one asks "does this fit here?". Filenames are
 * usually enough to answer it — an exam code in "220-1102 objectives.pdf" is
 * proof of identity — so the check runs before a byte is uploaded.
 *
 * Returns true to proceed. It only interrupts on real evidence: the server
 * answers `should_ask: false` for anything it cannot place, which is most
 * uploads. A prompt that fires on a hunch teaches people to dismiss prompts.
 *
 * A failed check never blocks an upload. This is a guard against two specific
 * mistakes, not a gatekeeper — if it can't run, the upload behaves as it always
 * did.
 */
async function passesSubjectCheck(files, moduleId, confirm) {
  let verdict
  try {
    verdict = await api.subjectCheck(files.map((f) => f.name), moduleId)
  } catch {
    return true
  }
  if (!verdict?.should_ask || !verdict.question) return true

  return confirm({
    title: 'Does this belong here?',
    message: verdict.question,
    // The wording is a question with two real answers, so neither button is
    // the "safe" one — labelling either as destructive would push a choice
    // the app has no basis for.
    confirmLabel: moduleId ? 'Add it anyway' : 'Start a new module',
    cancelLabel: 'Cancel',
  })
}

/**
 * The one upload flow, shared by every entry point (dashboard zone, sidebar
 * "Add source", …). Dropping or picking a file creates a module, attaches the
 * source and starts the pipeline — which auto-names the module and, once it's
 * processed, surfaces it in the list. The learner never types a name and is
 * never trapped: the mutation returns immediately and the list refreshes.
 */
export function useModuleUpload() {
  const queryClient = useQueryClient()
  const toast = useToast()

  const confirm = useConfirm()

  return useMutation({
    mutationFn: async (files) => {
      const { accepted, rejected } = sortPicked(files)
      if (rejected.length) throw new Error(rejectionMessage(rejected))
      if (!accepted.length) return null
      const list = accepted
      // Asked before the module row exists, so declining leaves nothing behind.
      if (!(await passesSubjectCheck(list, null, confirm))) return null
      const module = await api.createModule()
      await api.uploadSources(module.id, list)
      await api.processModule(module.id)
      return module
    },
    onSuccess: (module) => {
      queryClient.invalidateQueries({ queryKey: ['modules'] })
      queryClient.invalidateQueries({ queryKey: ['dashboard'] })
      if (module) toast.success('Upload received — building your module…')
    },
    onError: (e) => toast.error(e?.message || 'Upload failed. Please try again.'),
  })
}

/**
 * Add a source to an *existing* module: attach the files and re-run the
 * pipeline so the new material is folded into the module (no duplicate). Shared
 * by the Sources-tab dropzone and the "Add a source" sheet.
 */
export function useAddSourceToModule(moduleId) {
  const queryClient = useQueryClient()
  const toast = useToast()

  const confirm = useConfirm()

  return useMutation({
    mutationFn: async (files) => {
      const { accepted, rejected } = sortPicked(files)
      if (rejected.length) throw new Error(rejectionMessage(rejected))
      if (!accepted.length) return
      // Before uploading, not after: reprocessing folds the material into this
      // module's blueprint, and undoing that costs more than asking.
      if (!(await passesSubjectCheck(accepted, moduleId, confirm))) return
      await api.uploadSources(moduleId, accepted)
      await api.processModule(moduleId)
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['sources', moduleId] })
      queryClient.invalidateQueries({ queryKey: ['module', moduleId] })
      toast.success('Source added — reprocessing your module…')
    },
    onError: (e) => toast.error(e?.message || 'Upload failed. Please try again.'),
  })
}
