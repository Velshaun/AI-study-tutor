-- ============================================================================
-- AI Study Tutor — imported practice questions (spec Prompt 10c)
--
-- The table already exists (initial schema) with generic column names; this
-- aligns it to the spec's contract and adds set-level grouping. An imported
-- PDF produces many questions that belong to one "set" — grouped by
-- import_batch_id so the UI can show, favourite and delete them as a unit.
--
-- Idempotent: safe to re-run.
-- ============================================================================

alter table public.imported_practice_questions
  add column if not exists source_name     text,
  add column if not exists question_text    text,
  -- options is [{"label": "A", "text": "..."}, ...]; the column already exists.
  add column if not exists correct_option   text,   -- 'A' | 'B' | 'C' | 'D'
  add column if not exists why_summary      text,
  add column if not exists is_favourite     boolean not null default false,
  add column if not exists import_batch_id  uuid;

-- The original table had a NOT NULL `prompt`; the spec's contract uses
-- `question_text` instead, so relax the legacy column (kept for back-compat).
alter table public.imported_practice_questions
  alter column prompt drop not null;

create index if not exists imported_pq_module_idx
  on public.imported_practice_questions (module_id);
create index if not exists imported_pq_batch_idx
  on public.imported_practice_questions (import_batch_id);
