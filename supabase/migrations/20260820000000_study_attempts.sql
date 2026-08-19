-- ============================================================================
-- AI Study Tutor — saved progress through a quiz, exam or deck
--
-- Lectures have always resumed: `lectures.last_position_secs` is a bookmark,
-- and the dashboard offers "Continue where you left off". Nothing else did.
-- A learner forty questions into a ninety-question practice exam who took a
-- call, or tapped through to look something up, came back to question one with
-- every answer gone.
--
-- One row per learner per item, following the `review_later` precedent of a
-- polymorphic item_type/item_id rather than a table per media type:
--
--   quiz       -> quizzes.id
--   exam       -> practice_exams.id
--   practice   -> domains.id   (a domain's practice set)
--   flashcards -> domains.id   (a domain's deck)
--
-- `answers` holds what has been committed so far and `state` the rest of the
-- run — the flashcards seen, or a timed exam's deadline, so a resumed exam
-- comes back with the clock where it was rather than reset.
--
-- No foreign key: the item lives in one of four tables. Deleting the item
-- leaves a row here, which `completed_at is null` sweeps up harmlessly — a
-- resume for something that no longer exists simply finds nothing to open.
--
-- Idempotent: safe to re-run.
-- ============================================================================

create table if not exists public.study_attempts (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references public.profiles (id) on delete cascade,
  item_type    text not null check (
                 item_type in ('quiz', 'exam', 'practice', 'flashcards')),
  item_id      uuid not null,
  -- Which question or card the learner is on.
  position     integer not null default 0,
  -- Answers committed so far, in order; nulls for anything skipped.
  answers      jsonb not null default '[]'::jsonb,
  -- Anything else the run needs to come back intact (deadline, known count).
  state        jsonb not null default '{}'::jsonb,
  -- Set when the run is finished, so a completed attempt stops being offered.
  completed_at timestamptz,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (user_id, item_type, item_id)
);

create index if not exists study_attempts_user_idx
  on public.study_attempts (user_id, item_type);
-- The "pick up where you left off" lookup: unfinished, most recent first.
create index if not exists study_attempts_open_idx
  on public.study_attempts (user_id, updated_at desc)
  where completed_at is null;

drop trigger if exists study_attempts_set_updated_at on public.study_attempts;
create trigger study_attempts_set_updated_at
  before update on public.study_attempts
  for each row execute function public.set_updated_at();

alter table public.study_attempts enable row level security;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'study_attempts'
      and policyname = 'study_attempts: owner all'
  ) then
    create policy "study_attempts: owner all" on public.study_attempts
      for all using (user_id = auth.uid()) with check (user_id = auth.uid());
  end if;
end
$$;
