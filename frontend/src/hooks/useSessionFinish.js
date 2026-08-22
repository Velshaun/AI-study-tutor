import { useQueryClient } from '@tanstack/react-query'
import { useCallback } from 'react'

import { api } from '../lib/api'
import { bankPrompt, bankable, summarise } from '../lib/session'
import { useConfirm } from './useConfirm'
import { useToast } from './useToast'

/**
 * The end of a sitting, in one call.
 *
 * Two things have to happen and they are deliberately not the same thing.
 *
 * The **session record** is written unconditionally: it is what happened, and it
 * is what lets a past sitting stay a source weeks later. Quizzes and flashcards
 * never had one, so there was no way to look back at them at all.
 *
 * The **container** is only written if the learner says yes. Nothing enters
 * silently — a pool that fills itself is one nobody trusts and nobody prunes.
 * Declining costs nothing, because the session record already holds the same
 * questions and the historical pill can bank them later.
 *
 * Neither failure stops the other, and neither stops the learner seeing their
 * results: the run is over, and losing the bookkeeping is not worth an error
 * screen over a score they just earned.
 */
export function useSessionFinish(moduleId) {
  const confirm = useConfirm()
  const toast = useToast()
  const queryClient = useQueryClient()

  return useCallback(
    async ({ kind, itemId, title, results }) => {
      // A run that finished with no module is a wiring fault, not a state the
      // app should ever reach — and it used to return here without a word,
      // which is how a forty-question practice run ended with no record, no
      // prompt and nothing to show for it. Say so, loudly enough to be found.
      if (!moduleId) {
        console.error(
          `[session] ${kind} run finished with no module id — the session ` +
          'record and the missed-questions prompt have both been skipped.',
        )
        toast.error('Couldn’t file this session. Your results are still below.')
        return
      }
      if (!results?.length) return

      try {
        await api.recordSession({
          module_id: moduleId,
          kind,
          item_id: itemId ?? null,
          title: title || '',
          results,
        })
        queryClient.invalidateQueries({ queryKey: ['sessions', moduleId] })
      } catch (e) {
        // Bookkeeping, so it does not take the screen — but not silence
        // either: without the record the sitting cannot be revisited later,
        // and the learner is the only one who can decide to sit it again.
        console.error('[session] could not record the sitting', e)
        toast.error('Couldn’t save this session to your history.')
      }

      const { bankable: count } = summarise(results)
      if (!count) return

      const ok = await confirm({
        title: 'Save these for later?',
        message: bankPrompt(results),
        confirmLabel: 'Add them',
        cancelLabel: 'Not this time',
      })
      if (!ok) return

      try {
        const added = await api.addToContainer(moduleId, 'missed', {
          items: bankable(results, 'both'),
        })
        queryClient.invalidateQueries({ queryKey: ['container', moduleId, 'missed'] })
        const total = (added?.added || 0) + (added?.updated || 0)
        toast.success(
          `${total} question${total === 1 ? '' : 's'} saved to your missed questions.`,
        )
      } catch (e) {
        toast.error(e?.message || 'Could not save those questions.')
      }
    },
    [moduleId, confirm, toast, queryClient],
  )
}
