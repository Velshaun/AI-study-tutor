-- ============================================================================
-- The rest of a spoken answer, after the opening clip.
--
-- Time-to-first-audio scales with how much text goes to the synthesiser:
-- measured, a four-sentence answer took 2433ms and its first sentence alone
-- took 1076ms. So an answer is now spoken as two clips — the opener, which the
-- learner waits for, and everything after it, which is synthesised while the
-- opener is playing and fetched by the player before it ends.
--
-- A separate column rather than a list: there are exactly two clips, and a
-- jsonb array of one-or-two would invite a third that nothing needs. If a
-- future answer wants finer chunking, that is the moment to change the shape.
--
-- Nullable and always will be. Short answers are one clip, and an answer whose
-- remainder failed to synthesise is still an answer that was heard and read.
--
-- Idempotent: safe to re-run.
-- ============================================================================

alter table public.lecture_qa
  add column if not exists answer_rest_path text;

comment on column public.lecture_qa.answer_rest_path is
  'Narration of everything after the opening clip. Null when the answer was '
  'short enough to speak in one, or when the remainder could not be made.';
