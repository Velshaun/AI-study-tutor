import { useMutation, useQueryClient } from '@tanstack/react-query'

import { api } from '../lib/api'
import { UPLOAD_ACCEPT, rejectionMessage, sortPicked } from '../lib/uploads'
import { useToast } from './useToast'

// Re-exported so the many pickers that already import it from here keep
// working; the list itself lives in lib/uploads with the routing rules.
export { UPLOAD_ACCEPT }

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

  return useMutation({
    mutationFn: async (files) => {
      const { accepted, rejected } = sortPicked(files)
      if (rejected.length) throw new Error(rejectionMessage(rejected))
      if (!accepted.length) return null
      const list = accepted
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

  return useMutation({
    mutationFn: async (files) => {
      const { accepted, rejected } = sortPicked(files)
      if (rejected.length) throw new Error(rejectionMessage(rejected))
      if (!accepted.length) return
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
