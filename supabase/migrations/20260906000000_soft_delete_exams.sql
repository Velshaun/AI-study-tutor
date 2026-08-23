-- Deleting a practice exam took every sitting of it with it.
--
-- `exam_attempts.exam_id` is `on delete cascade`, so removing a paper removed
-- the scores earned on it — out of the history list, out of the baseline
-- comparison, and out of the inputs that decide what gets generated next. The
-- soft-removal pass covered lectures, quizzes, flashcards and practice
-- questions and missed this table, which is the one where a delete costs the
-- most: a sitting is the single most expensive thing a learner produces here.
--
-- Same rule as everywhere else: removal is a screen action, and what has been
-- studied is a record.
--
-- Idempotent and safe to re-run.

alter table public.practice_exams
  add column if not exists deleted_at timestamptz;

create index if not exists practice_exams_live_idx
  on public.practice_exams (module_id) where deleted_at is null;
