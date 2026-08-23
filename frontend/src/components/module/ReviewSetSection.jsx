import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Layers } from 'lucide-react'
import { useNavigate } from 'react-router-dom'

import MediaItemRow from './MediaItemRow'
import SectionHeading from './SectionHeading'
import { useConfirm } from '../../hooks/useConfirm'
import { useToast } from '../../hooks/useToast'
import { api } from '../../lib/api'
import { reviewSetName } from '../../lib/mediaLabels'
import { path } from '../../routes'

/**
 * What the containers have been turned into, when it spans the whole module.
 *
 * A quiz generated from the missed pool draws its questions from every domain
 * at once, so it has no domain to be filed under — and the Classroom is domain
 * accordions all the way down. The row was written, the toast said so, and
 * `bucket(null)` dropped it on the floor. Created successfully and visible
 * nowhere, which is the worst of both.
 *
 * It sits beside the containers rather than among the domains because that is
 * where it was made, and because "material from across the whole blueprint" is
 * the same shape of thing as a practice exam: not a topic, a cross-section.
 *
 * Named after the module so it reads as the learner's own — a heading that says
 * "Module quizzes" describes the schema, and nobody studies a schema.
 */
export default function ReviewSetSection({ moduleId, moduleTitle, quizzes = [] }) {
  const navigate = useNavigate()
  const toast = useToast()
  const confirm = useConfirm()
  const queryClient = useQueryClient()

  const remove = useMutation({
    mutationFn: (quiz) => api.deleteQuiz(quiz.id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['studio', moduleId] })
      toast.success('Removed')
    },
    onError: (e) => toast.error(e?.message || 'Couldn’t remove that'),
  })

  async function confirmRemove(quiz) {
    const ok = await confirm({
      title: `Remove “${quiz.title}”?`,
      message:
        'It comes off this screen. The questions it was built from stay in '
        + 'your containers.',
      confirmLabel: 'Remove',
    })
    if (ok) remove.mutate(quiz)
  }

  if (!quizzes.length) return null

  return (
    <section className="space-y-3">
      <SectionHeading Icon={Layers}>{reviewSetName(moduleTitle)}</SectionHeading>
      <p className="px-1 text-xs text-sec">
        Built from questions you missed or flagged, across every domain.
      </p>
      <ul className="card divide-y divide-border p-0">
        {quizzes.map((quiz) => (
          <MediaItemRow
            key={quiz.id}
            kind="quiz"
            item={quiz}
            onOpen={() => navigate(path('quizById', { quizId: quiz.id }))}
            onRemove={confirmRemove}
          />
        ))}
      </ul>
    </section>
  )
}
