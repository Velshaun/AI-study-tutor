-- Removing a piece of study material hides it; it never destroys what it made.
--
-- A learner who has finished with a lecture wants it off the screen, which is
-- not the same thing as wanting the twenty questions they asked during it
-- forgotten. `qa_sessions.lecture_id` and `lecture_qa.lecture_id` are both
-- `on delete cascade`, so a real delete takes every one of those exchanges with
-- it — and the Q&A container mirrors `lecture_qa`, so its entries go too.
-- `review_later` and `study_attempts` are polymorphic with no foreign key, so
-- they would survive as rows pointing at nothing at all, which is worse.
--
-- Same principle as `sat_exam_domains()` refusing to drop a domain whose
-- questions are in a sat paper: what has been studied is a record, and a record
-- is not something a tidy-up gets to rewrite.
--
-- Idempotent and safe to re-run.

alter table public.lectures
  add column if not exists deleted_at timestamptz;

alter table public.quizzes
  add column if not exists deleted_at timestamptz;

alter table public.flashcards
  add column if not exists deleted_at timestamptz;

alter table public.practice_questions
  add column if not exists deleted_at timestamptz;

-- Partial indexes: every read filters on `deleted_at is null`, and the live
-- rows are the overwhelming majority, so indexing only those keeps the index
-- roughly the size of the answer rather than the size of the table.
create index if not exists lectures_live_idx
  on public.lectures (domain_id) where deleted_at is null;

create index if not exists quizzes_live_idx
  on public.quizzes (domain_id) where deleted_at is null;

create index if not exists flashcards_live_idx
  on public.flashcards (domain_id) where deleted_at is null;

create index if not exists practice_questions_live_idx
  on public.practice_questions (domain_id) where deleted_at is null;
