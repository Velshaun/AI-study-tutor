-- ============================================================================
-- AI Study Tutor — exam target length
--
-- Practice sets were sized by a hardcoded constant (8), so a learner revising
-- for a 40- or 50-question paper always got an 8-question set. A module now
-- records how long the exam it is preparing for actually is, and every practice
-- generator sizes itself from that:
--
--   * exam_question_count — the real paper's length (LPI Linux Essentials: 40).
--     Null means "not stated", in which case the backend falls back to the
--     largest imported practice-exam batch for the module, then to a default.
--   * exam_duration_minutes — optional, for a realistic timed run.
--
-- Idempotent: safe to re-run.
-- ============================================================================

alter table public.modules
  add column if not exists exam_question_count integer,
  add column if not exists exam_duration_minutes integer;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'modules_exam_question_count_range'
  ) then
    alter table public.modules
      add constraint modules_exam_question_count_range
      check (exam_question_count is null
             or (exam_question_count between 1 and 200));
  end if;

  if not exists (
    select 1 from pg_constraint where conname = 'modules_exam_duration_range'
  ) then
    alter table public.modules
      add constraint modules_exam_duration_range
      check (exam_duration_minutes is null
             or (exam_duration_minutes between 1 and 600));
  end if;
end
$$;
