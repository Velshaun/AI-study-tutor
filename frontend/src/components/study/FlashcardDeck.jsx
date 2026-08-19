import { motion } from 'framer-motion'
import { Check, ChevronLeft, RotateCcw, Star, Trash2, X } from 'lucide-react'
import { useMemo, useState } from 'react'

import { planExpansions } from '../../lib/terms'
import TermSheet from './TermSheet'
import TermText from './TermText'

/**
 * Swipeable flashcard deck — spec Prompt 6.5.
 *
 * Tap to flip (front ↔ back), swipe right to mark known, swipe left to skip.
 * Both the drag gesture and the buttons below drive the same actions, so it's
 * usable on desktop too. A progress counter tracks position; a summary screen
 * closes the run with a "study again" reset.
 *
 * The flip is a 3D rotateY; the whole card is the drag target. `direction`
 * carries the swipe, so the next card arrives from the side the last one left.
 *
 * Key terms on either face are tappable for a definition, with acronyms
 * expanded inline the first time they appear. Tapping a term must not flip the
 * card, so those taps stop propagating.
 */

const SWIPE_THRESHOLD = 100

export default function FlashcardDeck({
  cards, onFavourite, onDelete, onRestart, attempt,
}) {
  // Saved progress, read once: a deck reopened mid-way carries on rather than
  // starting over.
  const saved = attempt?.restored
  const [index, setIndex] = useState(() =>
    Math.min(saved?.position ?? 0, cards.length),
  )
  const [flipped, setFlipped] = useState(false)
  const [direction, setDirection] = useState(0)
  // Which cards are marked known, by id rather than as a running total. Going
  // back and re-deciding has to be able to *unmark* one, and a counter can only
  // ever go up — a learner who marked a card known, stepped back and skipped it
  // would otherwise leave it counted.
  //
  // A run saved before this change stored a plain number, which says how many
  // without saying which. Those resume with an empty set: the count restarts
  // rather than being wrong in a way nothing can correct.
  const [known, setKnown] = useState(
    () => new Set(Array.isArray(saved?.state?.known) ? saved.state.known : []),
  )
  const [openTerm, setOpenTerm] = useState(null)

  const current = cards[index]
  const done = index >= cards.length

  const progress = useMemo(
    () => (cards.length ? Math.round((index / cards.length) * 100) : 0),
    [index, cards.length],
  )

  // Front then back, so an acronym is expanded on the side the learner reads
  // first and not repeated on the other.
  const terms = current?.terms || []
  const [frontExpand, backExpand] = planExpansions(
    [current?.front || '', current?.back || ''], terms,
  )

  function advance(dir, countKnown) {
    setDirection(dir)
    const marked = new Set(known)
    if (countKnown) marked.add(current.id)
    else marked.delete(current.id)
    setKnown(marked)

    const position = index + 1
    attempt?.save?.({
      position,
      state: { known: [...marked] },
      // Reaching the end finishes the run, so it stops being resumable.
      completed: position >= cards.length,
    })
    // Straight to the next card. This used to wait 180ms for an exit animation
    // to play; nothing plays out any more, and a step that waits on an
    // animation having finished is a step that doesn't happen when the
    // animation doesn't run.
    setFlipped(false)
    setIndex((i) => i + 1)
  }

  function onDragEnd(_event, info) {
    if (info.offset.x > SWIPE_THRESHOLD) advance(1, true) // right = known
    else if (info.offset.x < -SWIPE_THRESHOLD) advance(-1, false) // left = skip
  }

  /** Back one card. The mark it carries stays until it is re-decided. */
  function back() {
    if (index === 0) return
    setDirection(-1)
    setFlipped(false)
    setIndex((i) => i - 1)
    attempt?.save?.({ position: index - 1, state: { known: [...known] } })
  }

  function restart() {
    setIndex(0)
    setFlipped(false)
    setKnown(new Set())
    // Studying again starts a fresh run rather than resuming the finished one.
    attempt?.clear?.()
    onRestart?.()
  }

  if (done) {
    return (
      <div className="card flex flex-col items-center gap-5 py-12 text-center">
        <div className="flex size-14 items-center justify-center rounded-full bg-accent">
          <Check size={28} className="text-white" aria-hidden="true" />
        </div>
        <div className="space-y-1">
          <h2 className="text-lg font-semibold text-pri">Deck complete</h2>
          <p className="text-sm text-sec">
            You marked <span className="text-pri">{known.size}</span> of{' '}
            {cards.length} as known.
          </p>
        </div>
        <button onClick={restart} className="btn-primary">
          <RotateCcw size={16} aria-hidden="true" />
          Study again
        </button>
      </div>
    )
  }

  return (
    <div className="space-y-5">
      {/* Progress */}
      <div className="space-y-1.5">
        <div className="flex justify-between text-xs text-sec">
          <span>
            Card {index + 1} of {cards.length}
          </span>
          <span>{known.size} known</span>
        </div>
        <div className="h-1.5 overflow-hidden rounded-full bg-surface2">
          <div
            className="h-full rounded-full bg-accent transition-[width] duration-300"
            style={{ width: `${progress}%` }}
          />
        </div>
      </div>

      {/* Card */}
      <div className="relative h-72" style={{ perspective: '1200px' }}>
        {/* Two elements rather than one: the keyed wrapper handles arriving,
            the inner one handles being dragged.

            The card used to leave through `AnimatePresence`, and an exiting
            child that never unmounts is not a cosmetic problem here — this is
            `absolute inset-0` and draggable, so a stuck one sits over the next
            card and swallows every swipe and tap, the same way an un-unmounted
            modal backdrop did. The entrance is CSS and comes from the direction
            of travel, so the deck still reads as advancing; if the animation
            never runs, the card is simply there. */}
        <div
          key={current.id}
          className="step-in absolute inset-0"
          style={{ '--step-from': direction < 0 ? '-1.5rem' : '1.5rem' }}
        >
          <motion.div
            drag="x"
            dragConstraints={{ left: 0, right: 0 }}
            dragElastic={0.6}
            onDragEnd={onDragEnd}
            // Snap back to centre when a drag doesn't carry far enough to count.
            animate={{ x: 0 }}
            onClick={() => !openTerm && setFlipped((f) => !f)}
            className="h-full w-full cursor-pointer"
          >
            <motion.div
              className="relative h-full w-full"
              style={{ transformStyle: 'preserve-3d' }}
              animate={{ rotateY: flipped ? 180 : 0 }}
              transition={{ duration: 0.4 }}
            >
              {/* Front */}
              <Face>
                <span className="mb-3 text-xs font-medium uppercase tracking-wider text-sec">
                  Question
                </span>
                <p className="text-lg font-medium text-pri">
                  <TermText
                    text={current.front}
                    terms={terms}
                    expand={frontExpand}
                    onSelect={setOpenTerm}
                  />
                </p>
                <span className="mt-6 text-xs text-sec">Tap to flip</span>
              </Face>
              {/* Back */}
              <Face back>
                <span className="mb-3 text-xs font-medium uppercase tracking-wider text-accent2">
                  Answer
                </span>
                <p className="text-base leading-relaxed text-pri">
                  <TermText
                    text={current.back}
                    terms={terms}
                    expand={backExpand}
                    onSelect={setOpenTerm}
                  />
                </p>
              </Face>
            </motion.div>
          </motion.div>
        </div>
      </div>

      {/* Per-card actions */}
      <div className="flex items-center justify-center gap-2">
        <button
          onClick={() => onFavourite?.(current)}
          aria-label={current.is_favourite ? 'Unfavourite' : 'Favourite'}
          className="btn-ghost size-10 rounded-full p-0"
        >
          <Star
            size={18}
            className={current.is_favourite ? 'fill-warning text-warning' : ''}
            aria-hidden="true"
          />
        </button>
        <button
          onClick={() => onDelete?.(current)}
          aria-label="Delete card"
          className="btn-ghost size-10 rounded-full p-0 hover:text-warning"
        >
          <Trash2 size={18} aria-hidden="true" />
        </button>
      </div>

      {/* Swipe controls (also work by dragging the card), plus a way back:
          a deck is read, and a learner who has just skipped past something they
          didn't take in needs to be able to return to it. */}
      <div className="flex items-center justify-center gap-4">
        <button
          onClick={back}
          disabled={index === 0}
          className="flex size-11 items-center justify-center rounded-full border border-border
                     text-sec transition-colors hover:text-pri disabled:opacity-40"
          aria-label="Previous card"
        >
          <ChevronLeft size={20} aria-hidden="true" />
        </button>
        <button
          onClick={() => advance(-1, false)}
          className="flex size-14 items-center justify-center rounded-full border border-border
                     text-sec transition-colors hover:border-warning hover:text-warning"
          aria-label="Skip — swipe left"
        >
          <X size={24} aria-hidden="true" />
        </button>
        <button
          onClick={() => advance(1, true)}
          className="flex size-14 items-center justify-center rounded-full bg-success text-white
                     transition-transform hover:scale-105"
          aria-label="Known — swipe right"
        >
          <Check size={24} aria-hidden="true" />
        </button>
      </div>
      <p className="text-center text-xs text-sec">
        Swipe right if you knew it, left to skip
      </p>

      <TermSheet term={openTerm} onClose={() => setOpenTerm(null)} />
    </div>
  )
}

/** One face of the card. `back` pre-rotates it so the flip reveals it. */
function Face({ back = false, children }) {
  return (
    <div
      className="absolute inset-0 flex flex-col items-center justify-center rounded-2xl
                 border border-border bg-surface p-6 text-center"
      style={{
        backfaceVisibility: 'hidden',
        transform: back ? 'rotateY(180deg)' : undefined,
      }}
    >
      {children}
    </div>
  )
}
