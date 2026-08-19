import {
  ArrowLeft,
  ArrowRight,
  BookOpen,
  Check,
  GraduationCap,
  Settings as SettingsIcon,
  Sparkles,
} from 'lucide-react'
import { useState } from 'react'
import { useNavigate } from 'react-router-dom'

import OptionCards from '../components/OptionCards'
import VoiceCard from '../components/VoiceCard'
import { usePreferences } from '../hooks/usePreferences'
import { markOnboarded } from '../lib/preferences'
import { ROUTES } from '../routes'

/**
 * First-login preference wizard — spec §5.3.
 *
 * Seven steps. Each choice is written to localStorage the moment it's made and
 * synced to the backend best-effort, so backing out part-way still keeps what
 * was picked, and a failed network call never traps anyone in the wizard.
 */

const VOICES = [
  {
    id: 'marcus',
    name: 'Marcus',
    tagline: 'Measured and thorough',
    description:
      'Takes each topic at a steady pace with plenty of examples, and flags '
      + 'the genuinely tricky parts before getting into them.',
  },
  {
    id: 'sophia',
    name: 'Sophia',
    tagline: 'Brisk and precise',
    description:
      'Leads with the direct answer, then the detail that makes it stick — '
      + 'always tied back to how it gets examined.',
  },
]

const LENGTHS = [
  { id: 'short', label: 'Short', hint: '~5 min', description: 'Core points only.' },
  { id: 'medium', label: 'Medium', hint: '~15 min', description: 'Balanced depth.' },
  { id: 'long', label: 'Long', hint: '~30 min', description: 'Full detail and examples.' },
]

const DIFFICULTIES = [
  { id: 'easy', label: 'Easy', description: 'Recall and definitions.' },
  { id: 'medium', label: 'Medium', description: 'Applied understanding.' },
  { id: 'hard', label: 'Hard', description: 'Exam-level scenarios.' },
]

const THEMES = [
  { id: 'dark', label: 'Dark', hint: 'Default', description: 'Easier on the eyes at night.' },
  { id: 'light', label: 'Light', description: 'Better in bright daylight.' },
]

const TOTAL_STEPS = 7

export default function Onboarding() {
  const navigate = useNavigate()
  const { preferences, update, save } = usePreferences()

  const [step, setStep] = useState(1)
  const [playingVoice, setPlayingVoice] = useState(null)
  const [saveFailed, setSaveFailed] = useState(false)

  const next = () => setStep((s) => Math.min(TOTAL_STEPS, s + 1))
  const back = () => setStep((s) => Math.max(1, s - 1))

  async function finish() {
    // Choices are already stored locally; this is the explicit push.
    const ok = await save()
    setSaveFailed(!ok)
    markOnboarded()
    next()
  }

  return (
    <div className="flex min-h-dvh flex-col bg-bg">
      {/* Progress */}
      <div className="px-5 pt-[max(1.25rem,env(safe-area-inset-top))]">
        <div className="mx-auto flex max-w-md items-center gap-2">
          {Array.from({ length: TOTAL_STEPS }, (_, i) => (
            <div
              key={i}
              className={[
                'h-1 flex-1 rounded-full transition-colors duration-300',
                i < step ? 'bg-accent' : 'bg-surface2',
              ].join(' ')}
            />
          ))}
        </div>
        <p className="mx-auto mt-2 max-w-md text-right text-xs text-sec">
          Step {step} of {TOTAL_STEPS}
        </p>
      </div>

      {/* Step body */}
      <div className="flex flex-1 items-center px-5 py-6">
        <div className="mx-auto w-full max-w-md">
          {/* Keyed, so a step change remounts this and replays the entrance.
              It used to step through `AnimatePresence mode="wait"`, which holds
              the next step back until the previous one has finished animating
              out — a wizard that can't be advanced is a worse outcome than one
              that doesn't slide, and the slide is CSS now anyway. */}
          <div key={step} className="step-in">
              {step === 1 && <StepWelcome />}
              {step === 2 && <StepDashboard />}

              {step === 3 && (
                <Step
                  title="Choose your tutor"
                  subtitle="Tap play to hear each voice. You can change this any time."
                >
                  <div className="space-y-3">
                    {VOICES.map((voice) => (
                      <VoiceCard
                        key={voice.id}
                        {...voice}
                        selected={preferences.tutor_voice === voice.id}
                        playing={playingVoice === voice.id}
                        onSelect={(id) => update({ tutor_voice: id })}
                        onPlay={setPlayingVoice}
                      />
                    ))}
                  </div>
                </Step>
              )}

              {step === 4 && (
                <Step
                  title="How long should lectures be?"
                  subtitle="Sets the default — you can pick a different length per lecture."
                >
                  <OptionCards
                    name="lecture_length"
                    label="Default lecture length"
                    options={LENGTHS}
                    value={preferences.lecture_length}
                    onChange={(id) => update({ lecture_length: id })}
                  />
                </Step>
              )}

              {step === 5 && (
                <Step
                  title="Set your difficulty"
                  subtitle="Applies to both quizzes and flashcards. Raise it as you improve."
                >
                  <OptionCards
                    name="difficulty"
                    label="Default difficulty"
                    options={DIFFICULTIES}
                    value={preferences.quiz_difficulty}
                    onChange={(id) =>
                      // One control, two stored keys — the spec presents this as
                      // a single choice, but they're separate columns so
                      // Settings can split them later.
                      update({ quiz_difficulty: id, flashcard_difficulty: id })
                    }
                  />
                </Step>
              )}

              {step === 6 && (
                <Step title="Pick a theme" subtitle="Changes apply straight away.">
                  <OptionCards
                    name="theme"
                    label="Theme"
                    options={THEMES}
                    value={preferences.theme}
                    onChange={(id) => update({ theme: id })}
                    columns={2}
                  />
                </Step>
              )}

              {step === 7 && (
                <StepDone
                  saveFailed={saveFailed}
                  onSettings={() => navigate(ROUTES.settings)}
                  onFinish={() => navigate(ROUTES.dashboard, { replace: true })}
                />
              )}
          </div>
        </div>
      </div>

      {/* Controls */}
      {step < TOTAL_STEPS && (
        <div className="border-t border-border bg-surface px-5 py-4 pb-[max(1rem,env(safe-area-inset-bottom))]">
          <div className="mx-auto flex max-w-md items-center gap-3">
            {step > 1 ? (
              <button onClick={back} className="btn-ghost">
                <ArrowLeft size={16} aria-hidden="true" />
                Back
              </button>
            ) : (
              <button
                onClick={() => {
                  markOnboarded()
                  navigate(ROUTES.dashboard, { replace: true })
                }}
                className="btn-ghost"
              >
                Skip
              </button>
            )}

            <div className="flex-1" />

            <button
              onClick={step === TOTAL_STEPS - 1 ? finish : next}
              className="btn-primary"
            >
              {step === 1
                ? 'Get started'
                : step === TOTAL_STEPS - 1
                  ? 'Finish'
                  : 'Continue'}
              <ArrowRight size={16} aria-hidden="true" />
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

/* --- steps --------------------------------------------------------------- */

function Step({ title, subtitle, children }) {
  return (
    <div className="space-y-6">
      <header className="space-y-1.5">
        <h1 className="text-2xl font-semibold text-pri">{title}</h1>
        {subtitle && <p className="text-sm text-sec">{subtitle}</p>}
      </header>
      {children}
    </div>
  )
}

function StepWelcome() {
  return (
    <div className="space-y-6 text-center">
      <div className="mx-auto flex size-20 items-center justify-center rounded-3xl bg-accent">
        <GraduationCap size={40} className="text-white" aria-hidden="true" />
      </div>

      <div className="space-y-2">
        <h1 className="text-3xl font-semibold text-pri">ConverseAI Tutor</h1>
        <p className="text-sm text-sec">
          Turn your course material into interactive lectures, flashcards and
          timed practice exams — built around the official exam blueprint.
        </p>
      </div>

      <div className="flex flex-wrap justify-center gap-2 pt-2">
        <span className="chip">
          <Sparkles size={12} aria-hidden="true" />
          AI lectures
        </span>
        <span className="chip">Voice Q&amp;A</span>
        <span className="chip">Practice exams</span>
      </div>
    </div>
  )
}

function StepDashboard() {
  return (
    <Step
      title="This is your Dashboard"
      subtitle="Every subject you upload becomes a module, split into weighted domains."
    >
      {/* Example module card — illustrative, not real data. */}
      <div className="card space-y-4" aria-label="Example module">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-base font-semibold text-pri">
              AWS Solutions Architect
            </p>
            <p className="mt-0.5 text-xs text-sec">SAA-C03 · 4 domains</p>
          </div>
          <span className="chip-accent">In progress</span>
        </div>

        <div className="space-y-2.5">
          {[
            ['Design Secure Architectures', 30, 'completed'],
            ['Design Resilient Architectures', 26, 'in progress'],
            ['High-Performing Architectures', 24, 'locked'],
          ].map(([name, weight, state]) => (
            <div key={name} className="flex items-center gap-3">
              <span
                className={[
                  'size-2 shrink-0 rounded-full',
                  state === 'completed'
                    ? 'bg-success'
                    : state === 'in progress'
                      ? 'bg-accent'
                      : 'bg-border',
                ].join(' ')}
                aria-hidden="true"
              />
              <span className="min-w-0 flex-1 truncate text-sm text-pri">
                {name}
              </span>
              <span className="shrink-0 text-xs tabular-nums text-sec">
                {weight}%
              </span>
            </div>
          ))}
        </div>

        <div className="flex items-center gap-2 border-t border-border pt-3 text-xs text-sec">
          <BookOpen size={14} aria-hidden="true" />
          Weightings come from the official exam guide.
        </div>
      </div>
    </Step>
  )
}

function StepDone({ saveFailed, onSettings, onFinish }) {
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="onboarding-done-title"
      className="card space-y-5 border-accent/40 text-center"
      style={{ backgroundColor: 'var(--accent-soft)' }}
    >
      <div className="mx-auto flex size-14 items-center justify-center rounded-full bg-accent">
        <Check size={28} className="text-white" aria-hidden="true" />
      </div>

      <div className="space-y-2">
        <h1 id="onboarding-done-title" className="text-xl font-semibold text-pri">
          Your preferences are saved!
        </h1>
        <p className="text-sm text-sec">
          {saveFailed
            ? 'Saved on this device. They’ll sync to your account next time you’re signed in.'
            : 'You can change any of these later in Settings.'}
        </p>
      </div>

      <div className="flex flex-col gap-2">
        <button onClick={onFinish} className="btn-primary">
          Start studying
        </button>
        <button onClick={onSettings} className="btn-secondary">
          <SettingsIcon size={16} aria-hidden="true" />
          Open Settings
        </button>
      </div>
    </div>
  )
}
