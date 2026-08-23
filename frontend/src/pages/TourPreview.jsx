import { BookOpen, ClipboardList, Flag, Layers, Mic, RotateCcw, Target } from 'lucide-react'
import { useState } from 'react'

import FeatureHint from '../components/tour/FeatureHint'
import Spotlight from '../components/tour/Spotlight'
import TourCard from '../components/tour/TourCard'
import { reset } from '../lib/tour'

/**
 * A clickable proof of concept for the two onboarding layers.
 *
 * Not the real screens: a stand-in classroom with the same shapes, so both
 * layers can be walked end to end without an account that has actually reached
 * each feature. The pieces are the real ones — Spotlight, TourCard, HintPulse,
 * FeatureHint — so what is being judged here is what would ship.
 */

/** Layer one, as it would run for an account with nothing in it yet. */
const FIRST_RUN = [
  {
    target: '#poc-welcome',
    title: 'Welcome — let us set you up',
    body: 'Four quick choices, then you add your first bit of material. '
      + 'All of it is changeable later in Settings.',
  },
  {
    target: '#poc-voice',
    title: 'Choose your tutor',
    body: 'Marcus or Sophia reads your lectures aloud and answers your '
      + 'questions. Tap either to hear them.',
  },
  {
    target: '#poc-length',
    title: 'How long should a lecture be?',
    body: 'Short for a top-up between things; long for a first pass at a domain '
      + 'you have never studied.',
  },
  {
    target: '#poc-theme',
    title: 'Light or dark',
    body: 'Applies straight away, and follows you across devices.',
  },
  {
    target: '#poc-add',
    title: 'Add your first material',
    body: 'A PDF, a photo of your notes, a YouTube playlist, a past paper. '
      + 'Everything else in the app is built out of whatever lands here.',
    cta: 'Start',
  },
]

const PILL = 'min-h-9 rounded-full px-3 text-xs font-medium'
const HEADING =
  'border-l-[3px] border-accent pl-3 text-base font-semibold text-accent2'

export default function TourPreview() {
  const [tour, setTour] = useState(null)

  return (
    <div className="min-h-dvh space-y-6 bg-bg p-5">
      <div className="flex flex-wrap items-center gap-2 rounded-2xl bg-surface2 p-3">
        <p className="me-auto text-xs font-medium text-sec">Proof of concept</p>
        <button onClick={() => setTour(0)} className="btn-primary min-h-9 px-3 text-xs">
          Play the first-run tour
        </button>
        <button
          onClick={() => { reset(); window.location.reload() }}
          className="btn-secondary min-h-9 px-3 text-xs"
        >
          <RotateCcw size={14} aria-hidden="true" />
          Reset every hint
        </button>
      </div>

      <p className="text-xs leading-relaxed text-sec">
        Layer two is already running below. The purple dots mark features nobody
        has met yet — tap one. Two of them open by themselves, the way they
        would the moment that feature first appears.
      </p>

      <section id="poc-welcome" className="card space-y-1">
        <h1 className="text-lg font-semibold text-pri">LPI Linux Essentials</h1>
        <p className="text-xs text-sec">5 domains · 40-question paper · 60 min</p>
      </section>

      {/* The preference half of layer one — the part that is a setup flow
          rather than a tour, and the reason the tour exists at all. */}
      <div className="grid gap-3 sm:grid-cols-3">
        <div id="poc-voice" className="card space-y-2">
          <p className="text-xs font-medium text-sec">Tutor voice</p>
          <div className="flex gap-1 rounded-full bg-surface2 p-1">
            <button className={`${PILL} flex-1 bg-accent text-white`}>Marcus</button>
            <button className={`${PILL} flex-1 text-sec`}>Sophia</button>
          </div>
        </div>
        <div id="poc-length" className="card space-y-2">
          <p className="text-xs font-medium text-sec">Lecture length</p>
          <div className="flex gap-1 rounded-full bg-surface2 p-1">
            <button className={`${PILL} flex-1 text-sec`}>Short</button>
            <button className={`${PILL} flex-1 bg-accent text-white`}>Medium</button>
            <button className={`${PILL} flex-1 text-sec`}>Long</button>
          </div>
        </div>
        <div id="poc-theme" className="card space-y-2">
          <p className="text-xs font-medium text-sec">Theme</p>
          <div className="flex gap-1 rounded-full bg-surface2 p-1">
            <button className={`${PILL} flex-1 text-sec`}>Light</button>
            <button className={`${PILL} flex-1 bg-accent text-white`}>Dark</button>
          </div>
        </div>
      </div>

      <div className="relative grid grid-cols-2 gap-3 lg:grid-cols-4">
        <FeatureHint id="kpi_tap" target="#poc-kpi-first" />
        {[['Domains done', '1/5'], ['Quiz average', '72%'],
          ['Lectures', '3'], ['Time listened', '48m']].map(([label, value], i) => (
            <div
              key={label}
              id={i === 0 ? 'poc-kpi-first' : undefined}
              className="card p-4"
            >
              <p className="text-xs font-medium text-sec">{label}</p>
              <p className="mt-2 text-2xl font-semibold tabular-nums text-pri">{value}</p>
            </div>
          ))}
      </div>

      <section className="relative space-y-3">
        <FeatureHint id="review_set" target="#poc-review" radius={18} />
        <h2 className={HEADING}>LPI Linux Essentials Review Set</h2>
        <div id="poc-review" className="card flex items-center gap-3">
          <span className="flex size-9 items-center justify-center rounded-xl bg-accent/10 text-accent2">
            <Layers size={17} aria-hidden="true" />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm text-pri">From your missed questions</span>
            <span className="block truncate text-xs text-sec">21 questions</span>
          </span>
        </div>
      </section>

      <section className="space-y-3">
        <h2 className={HEADING}>Domains</h2>
        <div className="relative w-fit">
          <FeatureHint id="domain_sort" target="#poc-sort" radius={999} />
          <div id="poc-sort" className="flex items-center gap-1 rounded-full bg-surface2 p-1">
            <button className={`${PILL} bg-accent text-white`}>Exam order</button>
            <button className={`${PILL} text-sec`}>What to study</button>
          </div>
        </div>

        <div className="card space-y-3">
          <div className="flex items-center gap-2">
            <p className="min-w-0 flex-1 text-sm font-medium text-pri">
              Topic 3: The Power of the Command Line
            </p>
            <span className="rounded-full bg-accent/15 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-accent2">
              Start here
            </span>
          </div>
          <div className="space-y-2">
            {[[Mic, 'Lectures', '2'], [Layers, 'Flashcards', '20 cards'],
              [ClipboardList, 'Quiz', '1'], [Target, 'Practice questions', '40']]
              .map(([Icon, label, meta], i) => (
                <div
                  key={label}
                  className="relative flex items-center gap-3 rounded-xl bg-surface2 px-3 py-2.5"
                >
                  {i === 0 && (
                    <FeatureHint id="first_lecture" target="#poc-lecture-row" radius={12} />
                  )}
                  <span className="flex size-8 items-center justify-center rounded-lg bg-accent/10 text-accent2">
                    <Icon size={15} aria-hidden="true" />
                  </span>
                  <span
                    id={i === 0 ? 'poc-lecture-row' : undefined}
                    className="min-w-0 flex-1"
                  >
                    <span className="block text-sm text-pri">{label}</span>
                    <span className="block text-xs text-sec">{meta}</span>
                  </span>
                </div>
              ))}
          </div>
        </div>
      </section>

      <section className="relative space-y-3">
        <FeatureHint id="missed_container" target="#poc-missed" radius={18} />
        <h2 className={HEADING}>Your own questions</h2>
        <div id="poc-missed" className="card flex items-center gap-3">
          <span className="flex size-9 items-center justify-center rounded-xl bg-warning/10 text-warning">
            <BookOpen size={17} aria-hidden="true" />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block text-sm text-pri">Missed questions</span>
            <span className="block text-xs text-sec">21 waiting · 2 nearly graduated</span>
          </span>
        </div>
      </section>

      {/* Runner chrome, purely so the flag moment has something real to sit on. */}
      <section className="card space-y-2">
        <div className="flex items-center gap-2">
          <p className="flex-1 text-xs text-sec">Question 4 of 10</p>
          <div className="relative">
            <FeatureHint id="flag_button" target="#poc-flag" radius={10} />
            <span
              id="poc-flag"
              className="flex size-8 items-center justify-center rounded-lg bg-surface2 text-sec"
            >
              <Flag size={15} aria-hidden="true" />
            </span>
          </div>
        </div>
        <p className="text-sm text-pri">
          Which command lists the contents of a directory?
        </p>
      </section>

      <div
        id="poc-add"
        className="card flex items-center gap-3 border border-dashed border-border"
      >
        <span className="text-sm font-medium text-accent2">+ Add material</span>
      </div>

      <div className="h-24" />

      {tour !== null && (
        <>
          <Spotlight
            target={FIRST_RUN[tour].target}
            radius={18}
            onBackdrop={() => setTour(null)}
          />
          <TourCard
            target={FIRST_RUN[tour].target}
            title={FIRST_RUN[tour].title}
            body={FIRST_RUN[tour].body}
            step={tour}
            total={FIRST_RUN.length}
            cta={FIRST_RUN[tour].cta}
            onSkip={() => setTour(null)}
            onNext={() => setTour((t) => (t + 1 < FIRST_RUN.length ? t + 1 : null))}
          />
        </>
      )}
    </div>
  )
}
