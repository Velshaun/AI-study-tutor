import { motion } from 'framer-motion'
import { Volume2 } from 'lucide-react'
import { useEffect, useState } from 'react'

import { spokenLabel } from '../../lib/terms'

/**
 * The definition sheet for a tapped term.
 *
 * A bottom sheet on phones (thumb-reachable, which is where this app is used)
 * that centres itself on wider screens. Everything it shows was generated with
 * the question, so it opens with no spinner and no request.
 *
 * Pronunciation is read aloud with the Web Speech API rather than server TTS:
 * it is instant, free, works offline in the PWA, and needs no round trip for
 * what is a single word. Devices without it simply don't show the speaker.
 */

/** Speech synthesis, where the browser has it. */
function speak(text) {
  const synth = window.speechSynthesis
  if (!synth || !text) return
  synth.cancel() // a second tap restarts rather than queues
  const utterance = new SpeechSynthesisUtterance(text)
  utterance.rate = 0.9 // a shade slow: these are unfamiliar words
  utterance.lang = 'en-GB'
  synth.speak(utterance)
}

export default function TermSheet({ term, onClose }) {
  const [canSpeak] = useState(
    () => typeof window !== 'undefined' && 'speechSynthesis' in window,
  )

  useEffect(() => {
    if (!term) return undefined
    const onKey = (e) => e.key === 'Escape' && onClose?.()
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.speechSynthesis?.cancel()
    }
  }, [term, onClose])

  // Mounted conditionally rather than through AnimatePresence: an exiting child
  // that never unmounts leaves an invisible full-screen backdrop swallowing
  // every later tap, and a dismissal that always works is worth more than a
  // fade on the way out.
  if (!term) return null

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      onClick={onClose}
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/60
                 p-0 backdrop-blur-sm sm:items-center sm:p-4"
    >
      <motion.div
        role="dialog"
        aria-modal="true"
        aria-label={`${term.term} definition`}
        initial={{ y: 32, opacity: 0 }}
        animate={{ y: 0, opacity: 1 }}
        transition={{ type: 'spring', stiffness: 380, damping: 32 }}
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-sm space-y-3 rounded-t-2xl border border-border
                   bg-surface p-5 pb-7 sm:rounded-2xl sm:pb-5"
      >
        {/* Grab handle — signals "tap away to dismiss" on a phone. */}
        <div
          className="mx-auto h-1 w-10 rounded-full bg-border sm:hidden"
          aria-hidden="true"
        />

        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 className="text-lg font-semibold text-pri">{term.term}</h2>
            {term.expansion && (
              <p className="text-sm text-accent2">{term.expansion}</p>
            )}
            {term.pronunciation && (
              <p className="mt-0.5 text-sm italic text-sec">
                Pronounced: {term.pronunciation}
              </p>
            )}
          </div>
          {canSpeak && (
            <button
              onClick={() => speak(spokenLabel(term))}
              aria-label={`Hear ${term.term} pronounced`}
              className="flex size-10 shrink-0 items-center justify-center rounded-xl
                         bg-accent/10 text-accent2 transition-colors hover:bg-accent/20"
            >
              <Volume2 size={18} aria-hidden="true" />
            </button>
          )}
        </div>

        <p className="text-sm leading-relaxed text-pri">{term.definition}</p>

        {term.domain && (
          <p className="pt-1 text-xs uppercase tracking-wider text-sec">
            {term.domain}
          </p>
        )}
      </motion.div>
    </motion.div>
  )
}
