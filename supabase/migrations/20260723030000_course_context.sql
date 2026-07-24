-- ============================================================================
-- AI Study Tutor — user-supplied Course Context (spec §4.3b)
--
-- The upload screen gains a Course Context section: the learner pastes text or
-- uploads a syllabus PDF, it is stored in modules.course_context, and it is fed
-- into the domain-extraction prompt.
--
-- Until now course_context was an OUTPUT — the pipeline wrote Gemini's own
-- one-line description of the course into it. Those two uses collide: a
-- pipeline re-run would silently overwrite the learner's syllabus.
--
-- course_context_source records provenance so the pipeline only ever writes
-- into an AI-owned field, and never over a user-supplied one.
--
-- Idempotent: safe to re-run.
-- ============================================================================

alter table public.modules
  -- 'user' = pasted/uploaded by the learner (authoritative, never overwritten)
  -- 'ai'   = derived by Gemini during extraction
  -- null   = not set
  add column if not exists course_context_source text
    check (course_context_source in ('user', 'ai')),
  -- Filename of the uploaded syllabus, for display on the upload screen.
  add column if not exists course_context_filename text;

-- Existing rows only ever had AI-written context.
update public.modules
set course_context_source = 'ai'
where course_context is not null
  and course_context <> ''
  and course_context_source is null;
