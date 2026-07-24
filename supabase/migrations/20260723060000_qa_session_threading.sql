-- ============================================================================
-- AI Study Tutor — Q&A session threading (spec §4.5b)
--
-- A session is one conversational thread on one topic. §4.5b defines three ways
-- it ends — the student signals they're ready to continue, they tap "End
-- session", or 30 seconds pass with no new question — and the reason matters
-- for review, so it is recorded rather than inferred.
--
-- The 30-second rule is evaluated lazily on the next question rather than by a
-- background sweep: nothing observes an expired session until someone speaks
-- again, so a timer would be pure overhead. That needs a last-activity
-- timestamp to compare against.
--
-- Idempotent: safe to re-run.
-- ============================================================================

alter table public.qa_sessions
  -- 'manual' | 'closing' | 'timeout' | null while still open
  add column if not exists end_reason      text
    check (end_reason in ('manual', 'closing', 'timeout')),
  add column if not exists last_activity_at timestamptz not null default now();

-- Backfill so pre-existing open sessions don't look stale on first read.
update public.qa_sessions
set last_activity_at = coalesce(started_at, created_at, now())
where last_activity_at is null;

create index if not exists qa_sessions_open_idx
  on public.qa_sessions (lecture_id, ended_at, last_activity_at desc);

-- ============================================================================
-- lecture_qa — three-way classification (§4.5b)
-- ============================================================================
-- is_knowledge_question stays as the counting flag; exchange_kind records which
-- of the three roles the utterance played, so review can show the full thread
-- while the badge counts only real questions.
alter table public.lecture_qa
  add column if not exists exchange_kind text
    check (exchange_kind in ('knowledge', 'confirmation', 'closing')),
  -- 'keyword' when the fast path decided, 'gemini' when it needed the model.
  add column if not exists classified_by text;

-- Existing rows predate the three-way split.
update public.lecture_qa
set exchange_kind = case when is_knowledge_question then 'knowledge'
                         else 'confirmation' end
where exchange_kind is null;
