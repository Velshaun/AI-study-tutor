import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Plus } from 'lucide-react'
import { useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'

import FlashcardDeck from '../components/study/FlashcardDeck'
import { useAttempt } from '../hooks/useAttempt'
import GenerateForm from '../components/study/GenerateForm'
import PageTitle from '../components/PageTitle'
import { useConfirm } from '../hooks/useConfirm'
import { useToast } from '../hooks/useToast'
import { api, ApiError } from '../lib/api'
import { useSessionFinish } from '../hooks/useSessionFinish'

/**
 * Flashcards for a domain — spec Prompt 6.5.
 *
 * Shows the generate form when there are no cards, otherwise the swipeable
 * deck. Favourite/delete refetch via query invalidation.
 */
export default function Flashcards() {
  const { domainId } = useParams()
  // Cards are fetched by domain, so the module comes off the cards
  // themselves — a container belongs to the module, not the domain.
  // A deck is keyed by its domain — the cards have no set of their own.
  const attempt = useAttempt('flashcards', domainId)
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const confirm = useConfirm()
  const toast = useToast()
  const [showForm, setShowForm] = useState(false)

  const { data, isPending, error } = useQuery({
    queryKey: ['flashcards', domainId],
    queryFn: ({ signal }) => api.flashcards(domainId, signal),
  })

  const generate = useMutation({
    mutationFn: ({ difficulty, count }) =>
      api.generateFlashcards({ domain_id: domainId, difficulty, count }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['flashcards', domainId] })
      setShowForm(false)
      toast.success('Flashcards saved')
    },
    onError: (e) => toast.error(e?.message || 'Could not make flashcards'),
  })

  const favourite = useMutation({
    mutationFn: (card) => api.favouriteFlashcard(card.id),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: ['flashcards', domainId] }),
  })

  const remove = useMutation({
    mutationFn: (card) => api.deleteFlashcard(card.id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['flashcards', domainId] })
      toast.success('Card deleted')
    },
    onError: (e) => toast.error(e?.message || 'Could not delete card'),
  })

  async function confirmDelete(card) {
    const ok = await confirm({
      title: 'Delete card?',
      message: 'This flashcard will be removed from the deck.',
      confirmLabel: 'Delete',
      danger: true,
    })
    if (ok) remove.mutate(card)
  }

  const cards = Array.isArray(data) ? data : []
  const finishSession = useSessionFinish(cards[0]?.module_id)
  const isAuth = error instanceof ApiError && error.isAuth

  return (
    <div className="space-y-6">
      <PageTitle
        onBack={() => navigate(-1)}
        subtitle={
          cards.length > 0
            ? `${cards.length} card${cards.length === 1 ? '' : 's'} in this deck`
            : 'Spaced review for this domain.'
        }
        actions={
          cards.length > 0 &&
          !showForm && (
            <button onClick={() => setShowForm(true)} className="btn-secondary">
              <Plus size={16} aria-hidden="true" />
              More
            </button>
          )
        }
      >
        Flashcards
      </PageTitle>

      {isPending ? (
        <div className="skeleton h-72 rounded-2xl" role="status" aria-label="Loading" />
      ) : isAuth ? (
        <p className="card text-center text-sm text-sec">
          Sign in to study your flashcards.
        </p>
      ) : cards.length === 0 || showForm ? (
        <GenerateForm
          kind="flashcards"
          onGenerate={generate.mutate}
          generating={generate.isPending}
          error={generate.error?.message}
          onDismissError={generate.reset}
        />
      ) : (
        <FlashcardDeck
          cards={cards}
          attempt={attempt}
          onFavourite={favourite.mutate}
          onDelete={confirmDelete}
          onFinished={({ results }) =>
            finishSession({
              kind: 'flashcards', itemId: domainId,
              title: `${cards.length} cards`, results,
            })
          }
        />
      )}
    </div>
  )
}
