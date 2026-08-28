-- Questions stop being multiple-choice by construction.
--
-- `practice_questions` held options and a single correct_index, which is the
-- shape of exactly one question type. Multi-select needs a set of correct
-- indices; short-answer and fill-in-the-blank need the answers a response is
-- checked against and have no options at all. One jsonb column carries what
-- each type needs beyond the shared shape — quizzes and bank snapshots store
-- their questions in jsonb already, so this table was the only one that
-- needed a place to put it.
--
-- Idempotent and safe to re-run.

alter table public.practice_questions
  add column if not exists answer_meta jsonb;

-- The kind check predates three of the four kinds. 'short_answer' was in the
-- original list and never used; it stays legal so any old row survives, and
-- the grader treats unknown kinds as mcq rather than crashing on them.
alter table public.practice_questions
  drop constraint if exists practice_questions_kind_check;
alter table public.practice_questions
  add constraint practice_questions_kind_check
  check (kind in ('mcq', 'multi', 'short', 'blank', 'short_answer'));
