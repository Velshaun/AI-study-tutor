import { useQuery } from '@tanstack/react-query'
import { BookOpen, ClipboardList, Layers, Play, Star } from 'lucide-react'
import { Link } from 'react-router-dom'

import { api, ApiError } from '../lib/api'
import { formatClock } from '../lib/format'
import { path } from '../routes'

/**
 * Favourites — spec Prompt 7.3.
 *
 * Three sections — lectures, flashcards, quizzes — each showing only the
 * caller's starred items, from one aggregated endpoint. Empty sections are
 * hidden; a fully-empty page gets its own state.
 */
export default function Favourites() {
  const { data, isPending, error } = useQuery({
    queryKey: ['favourites'],
    queryFn: ({ signal }) => api.favourites(signal),
  })

  if (isPending) {
    return (
      <Shell>
        <div className="space-y-3" role="status" aria-label="Loading">
          <div className="skeleton h-6 w-32" />
          <div className="skeleton h-20 rounded-2xl" />
          <div className="skeleton h-20 rounded-2xl" />
        </div>
      </Shell>
    )
  }

  if (error) {
    const isAuth = error instanceof ApiError && error.isAuth
    return (
      <Shell>
        <p className="card text-center text-sm text-sec">
          {isAuth ? 'Sign in to see your favourites.' : error.message}
        </p>
      </Shell>
    )
  }

  const lectures = data?.lectures ?? []
  const flashcards = data?.flashcards ?? []
  const quizzes = data?.quizzes ?? []
  const total = lectures.length + flashcards.length + quizzes.length

  if (total === 0) {
    return (
      <Shell>
        <div className="card flex flex-col items-center gap-4 py-12 text-center">
          <Star size={28} className="text-sec" aria-hidden="true" />
          <div className="space-y-1.5">
            <h2 className="text-lg font-semibold text-pri">Nothing starred yet</h2>
            <p className="mx-auto max-w-xs text-sm text-sec">
              Tap the star on a lecture, flashcard or quiz to keep it here for
              quick access.
            </p>
          </div>
        </div>
      </Shell>
    )
  }

  return (
    <Shell>
      <Section title="Lectures" Icon={BookOpen} count={lectures.length}>
        {lectures.map((lec) => (
          <Link
            key={lec.id}
            to={path('lecture', { id: lec.id })}
            className="card-interactive flex items-center gap-3"
          >
            <span className="flex size-10 shrink-0 items-center justify-center rounded-full bg-accent/15 text-accent2">
              <Play size={16} className="ml-0.5" aria-hidden="true" />
            </span>
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium text-pri">{lec.title}</p>
              <p className="text-xs text-sec">
                {lec.tutor_voice === 'sophia' ? 'Sophia' : 'Marcus'}
                {lec.duration_secs ? ` · ${formatClock(lec.duration_secs)}` : ''}
              </p>
            </div>
          </Link>
        ))}
      </Section>

      <Section title="Flashcards" Icon={Layers} count={flashcards.length}>
        {flashcards.map((card) => (
          <div key={card.id} className="card space-y-1.5">
            <p className="text-sm font-medium text-pri">{card.front}</p>
            <p className="text-sm text-sec">{card.back}</p>
            {card.domain_id && (
              <Link
                to={path('flashcards', { domainId: card.domain_id })}
                className="text-xs text-accent2 hover:underline"
              >
                Open deck →
              </Link>
            )}
          </div>
        ))}
      </Section>

      <Section title="Quizzes" Icon={ClipboardList} count={quizzes.length}>
        {quizzes.map((quiz) => (
          <Link
            key={quiz.id}
            to={quiz.domain_id ? path('quizzes', { domainId: quiz.domain_id }) : '#'}
            className="card-interactive flex items-center gap-3"
          >
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium text-pri">{quiz.title}</p>
              <p className="text-xs text-sec">
                {quiz.question_count} questions
                {quiz.score != null && ` · last ${Math.round(quiz.score)}%`}
              </p>
            </div>
          </Link>
        ))}
      </Section>
    </Shell>
  )
}

function Shell({ children }) {
  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold text-pri">Favourites</h1>
        <p className="mt-0.5 text-sm text-sec">
          Everything you&rsquo;ve starred, in one place.
        </p>
      </header>
      {children}
    </div>
  )
}

function Section({ title, Icon, count, children }) {
  if (count === 0) return null
  return (
    <section className="space-y-3">
      <div className="flex items-center gap-2">
        <Icon size={16} className="text-sec" aria-hidden="true" />
        <h2 className="text-xs font-semibold uppercase tracking-widest text-sec">
          {title}
        </h2>
        <span className="text-xs text-sec">({count})</span>
      </div>
      <div className="space-y-3">{children}</div>
    </section>
  )
}
