-- ============================================================================
-- AI Study Tutor — spoken Q&A answers (spec §4.5a)
--
-- The student pauses an audio lecture and asks a question out loud; the reply
-- has to come back in the same tutor's voice, not as text. Each answer is
-- narrated with OpenAI TTS and cached in the existing `lecture-audio` bucket
-- under `<user_id>/qa/<entry_id>.mp3`, so the storage RLS policies (which key
-- off the first path segment) already cover it.
--
-- The text stays authoritative for review; the audio is a cached rendering of
-- it, and a null path simply means narration is unavailable.
--
-- Idempotent: safe to re-run.
-- ============================================================================

alter table public.lecture_qa
  add column if not exists answer_audio_path text,
  add column if not exists answer_audio_secs integer,
  -- Which tutor voice narrated this answer, so a voice change can invalidate it.
  add column if not exists answer_voice      text;
