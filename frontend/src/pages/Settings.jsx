import { LogOut } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'

import OptionCards from '../components/OptionCards'
import PageTitle from '../components/PageTitle'
import SectionHeader from '../components/SectionHeader'
import VoiceCard from '../components/VoiceCard'
import { useAuth } from '../hooks/useAuth'
import { usePreferences } from '../hooks/usePreferences'
import { supabase } from '../lib/supabase'

/**
 * Settings — spec Prompt 9.1.
 *
 * Every preference change is written through usePreferences().update, which
 * saves to localStorage immediately and syncs to profiles.preferences in the
 * background — so selections are effectively real-time. The display name is a
 * profile field (not a preference), edited free-text, so its write is debounced
 * and goes straight to the profiles row via the RLS-scoped Supabase client.
 */

const VOICES = [
  {
    id: 'marcus',
    name: 'Marcus',
    tagline: 'Measured and thorough',
    description: 'Steady pace, plenty of examples, flags the tricky parts first.',
  },
  {
    id: 'sophia',
    name: 'Sophia',
    tagline: 'Brisk and precise',
    description: 'Straight to the answer, tied to how it gets examined.',
  },
]

const LENGTHS = [
  { id: 'short', label: 'Short', hint: '~5 min' },
  { id: 'medium', label: 'Medium', hint: '~15 min' },
  { id: 'long', label: 'Long', hint: '~30 min' },
]

const DIFFICULTIES = [
  { id: 'easy', label: 'Easy' },
  { id: 'medium', label: 'Medium' },
  { id: 'hard', label: 'Hard' },
]

export default function Settings() {
  const { preferences, update } = usePreferences()
  const { user, signOut } = useAuth()
  const [playingVoice, setPlayingVoice] = useState(null)

  return (
    <div className="space-y-8">
      <PageTitle subtitle="Changes save automatically.">Settings</PageTitle>

      <Section title="Appearance">
        <OptionCards
          name="theme"
          label="Theme"
          columns={2}
          value={preferences.theme}
          onChange={(id) => update({ theme: id })}
          options={[
            { id: 'dark', label: 'Dark', hint: 'Default' },
            { id: 'light', label: 'Light' },
          ]}
        />
      </Section>

      <Section title="Tutor voice">
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
      </Section>

      <Section title="Default lecture length">
        <OptionCards
          name="lecture_length"
          label="Default lecture length"
          value={preferences.lecture_length}
          onChange={(id) => update({ lecture_length: id })}
          options={LENGTHS}
        />
      </Section>

      <Section title="Default quiz difficulty">
        <OptionCards
          name="quiz_difficulty"
          label="Default quiz difficulty"
          value={preferences.quiz_difficulty}
          onChange={(id) => update({ quiz_difficulty: id })}
          options={DIFFICULTIES}
        />
      </Section>

      <Section title="Default flashcard difficulty">
        <OptionCards
          name="flashcard_difficulty"
          label="Default flashcard difficulty"
          value={preferences.flashcard_difficulty}
          onChange={(id) => update({ flashcard_difficulty: id })}
          options={DIFFICULTIES}
        />
      </Section>

      <Section title="Account">
        <Account user={user} onSignOut={signOut} />
      </Section>
    </div>
  )
}

function Section({ title, children }) {
  return (
    <section className="space-y-3">
      <SectionHeader>{title}</SectionHeader>
      {children}
    </section>
  )
}

function Account({ user, onSignOut }) {
  const email = user?.email
  const avatar = user?.user_metadata?.avatar_url || user?.user_metadata?.picture

  // Display name: seed from the profile, edit free-text, debounce the write.
  const [name, setName] = useState('')
  const [saved, setSaved] = useState(false)
  const debounce = useRef(null)
  const seeded = useRef(false)

  useEffect(() => {
    if (seeded.current || !user) return
    seeded.current = true
    const m = user.user_metadata || {}
    setName(m.full_name || m.name || '')
  }, [user])

  useEffect(() => () => debounce.current && clearTimeout(debounce.current), [])

  function onNameChange(value) {
    setName(value)
    setSaved(false)
    if (debounce.current) clearTimeout(debounce.current)
    debounce.current = setTimeout(async () => {
      if (!supabase || !user) return
      await supabase.from('profiles').update({ name: value.trim() }).eq('id', user.id)
      setSaved(true)
    }, 700)
  }

  return (
    <div className="card space-y-4">
      <div className="flex items-center gap-3">
        {avatar ? (
          <img
            src={avatar}
            alt=""
            className="size-12 rounded-full object-cover"
            referrerPolicy="no-referrer"
          />
        ) : (
          <span className="flex size-12 items-center justify-center rounded-full bg-surface2 text-lg font-medium text-sec">
            {(name || email || '?').slice(0, 1).toUpperCase()}
          </span>
        )}
        <div className="min-w-0">
          <p className="truncate text-sm font-medium text-pri">{name || 'Your name'}</p>
          <p className="truncate text-xs text-sec">{email}</p>
        </div>
      </div>

      <div className="space-y-1.5">
        <label htmlFor="displayName" className="text-xs font-medium text-sec">
          Display name
        </label>
        <input
          id="displayName"
          value={name}
          onChange={(e) => onNameChange(e.target.value)}
          placeholder="Your name"
          className="input"
        />
        {saved && <p className="text-xs text-success">Saved</p>}
      </div>

      <button onClick={onSignOut} className="btn-secondary w-full text-warning">
        <LogOut size={16} aria-hidden="true" />
        Sign out
      </button>
    </div>
  )
}
