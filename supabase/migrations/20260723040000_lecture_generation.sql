-- ============================================================================
-- AI Study Tutor — lecture generation & streaming (spec §4.4)
--
-- §4.2 gave lectures their playback columns (audio_url, transcript,
-- duration_secs, tutor_voice, length_preference, last_position_secs,
-- completed_at, is_favourite). Generation adds:
--
--   * pipeline state, so the frontend can show progress and recover from a
--     dropped SSE connection
--   * per-chunk audio, because OpenAI TTS caps input at ~4096 characters, so a
--     lecture is many cached MP3 objects rather than one
--
-- Idempotent: safe to re-run.
-- ============================================================================

alter table public.lectures
  -- 'pending' | 'generating_text' | 'generating_audio' | 'ready' | 'failed'
  add column if not exists status        text not null default 'pending',
  add column if not exists error_message text,
  -- [{index, storage_path, chars, duration_secs}] in playback order
  add column if not exists audio_chunks  jsonb not null default '[]'::jsonb,
  add column if not exists word_count    integer not null default 0,
  add column if not exists generated_at  timestamptz;

create index if not exists lectures_status_idx on public.lectures (status);

-- A domain has at most one lecture per (voice, length) combination; re-running
-- generation with the same settings should replace, not duplicate.
create index if not exists lectures_domain_voice_length_idx
  on public.lectures (domain_id, tutor_voice, length_preference);

-- ============================================================================
-- Storage bucket for generated lecture audio (private; signed URLs)
-- ============================================================================
insert into storage.buckets (id, name, public, file_size_limit)
values ('lecture-audio', 'lecture-audio', false, 26214400)
on conflict (id) do nothing;

drop policy if exists "lecture-audio: read own"   on storage.objects;
drop policy if exists "lecture-audio: insert own" on storage.objects;
drop policy if exists "lecture-audio: delete own" on storage.objects;

create policy "lecture-audio: read own" on storage.objects
  for select using (
    bucket_id = 'lecture-audio'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

create policy "lecture-audio: insert own" on storage.objects
  for insert with check (
    bucket_id = 'lecture-audio'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

create policy "lecture-audio: delete own" on storage.objects
  for delete using (
    bucket_id = 'lecture-audio'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

-- ============================================================================
-- domains — completion drives the unlock chain (§4.4 /complete)
-- ============================================================================
-- Statuses: 'locked' | 'unlocked' | 'in_progress' | 'completed'
alter table public.domains
  add column if not exists started_at timestamptz;
