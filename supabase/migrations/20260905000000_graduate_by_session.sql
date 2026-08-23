-- A question graduates on two correct sittings, not two correct answers.
--
-- `question_bank.correct_streak` was incremented once per correct *answer*,
-- with nothing recording which sitting the answer happened in. So a question
-- appearing twice in one generated set, or answered twice inside one run,
-- graduated in a single session — which is not recall, it is short-term memory
-- with a stopwatch on it. The whole point of "twice" is that a lucky guess does
-- not repeat a week later.
--
-- `last_session_id` makes one-pass-per-sitting true in the data rather than in
-- whichever caller remembers to be careful.
--
-- Idempotent and safe to re-run.

alter table public.question_bank
  add column if not exists last_session_id uuid
    references public.study_sessions (id) on delete set null;

-- On delete set null, not cascade: deleting a sitting must not take the streak
-- it contributed to. The record of the sitting and the fact that it happened
-- are different things, and only one of them is being removed.

create index if not exists question_bank_last_session_idx
  on public.question_bank (last_session_id);
