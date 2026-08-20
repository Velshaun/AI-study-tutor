-- ============================================================================
-- AI Study Tutor — where a question came from
--
-- There have been two question tables since the imported-PDF work:
-- `practice_questions`, which everything downstream reads — exams, practice
-- mode, the per-domain breakdown, the performance model — and
-- `imported_practice_questions`, which only the imported-exams card reads. Two
-- shapes for one idea, and every new source of questions would have had to pick
-- one or write a third.
--
-- So `practice_questions` becomes the canonical shape and gains the two things
-- the other table had that it didn't:
--
--   `origin`           — generated, imported_pdf, scraped, pasted. Provenance
--                        for debugging, and the reason a misbehaving parser can
--                        be undone without touching anything else.
--   `import_batch_id`  — which import produced it, so one bad batch is one
--                        delete rather than a hunt.
--
-- `origin` is a plain text column with a default rather than a check
-- constraint: new sources arrive faster than migrations do, and a question that
-- can't be written because its origin is unrecognised is a worse failure than
-- one labelled with a string nothing matches yet.
--
-- Idempotent: safe to re-run.
-- ============================================================================

alter table public.practice_questions
  -- 'generated' | 'imported_pdf' | 'scraped' | 'pasted'
  add column if not exists origin          text not null default 'generated',
  add column if not exists import_batch_id uuid;

create index if not exists practice_questions_batch_idx
  on public.practice_questions (import_batch_id);
create index if not exists practice_questions_origin_idx
  on public.practice_questions (origin);

-- Flashcards come out of the same pasted material and need the same provenance,
-- for the same reason: an import that produced nonsense has to be removable as
-- a unit.
alter table public.flashcards
  add column if not exists origin          text not null default 'generated',
  add column if not exists import_batch_id uuid;

create index if not exists flashcards_batch_idx
  on public.flashcards (import_batch_id);
