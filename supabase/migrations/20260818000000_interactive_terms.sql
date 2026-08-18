-- ============================================================================
-- AI Study Tutor — interactive terms on study text
--
-- Every flashcard, quiz question, exam question and practice question is now
-- generated with the handful of terms inside it that a learner might not know:
--
--   [{"term": "GNU",
--     "type": "acronym",             -- 'acronym' | 'vocabulary'
--     "expansion": "GNU's Not Unix", -- acronyms only
--     "pronunciation": "guh-NOO",
--     "definition": "A free software project that ...",
--     "domain": "Open Source Concepts"}]
--
-- The client underlines them, expands acronyms inline and opens a definition
-- sheet on tap — with no round trip, which is why the data is generated and
-- stored with the question rather than looked up on demand.
--
-- `quizzes` needs nothing: it already stores its whole question list as jsonb,
-- so the terms ride along inside it. Only the two tables with column-per-field
-- storage need somewhere to put them.
--
-- The API tolerates this migration not having run: app/services/schema_features
-- probes for the column once and drops it from writes when it's absent, so
-- generation keeps working and the feature simply stays dormant until this is
-- applied.
--
-- Idempotent: safe to re-run.
-- ============================================================================

alter table public.flashcards
  add column if not exists terms jsonb not null default '[]'::jsonb;

alter table public.practice_questions
  add column if not exists terms jsonb not null default '[]'::jsonb;
