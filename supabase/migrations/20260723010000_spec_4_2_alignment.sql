-- ============================================================================
-- AI Study Tutor — align schema with spec §4.2 (Q&A sessions + lesson fields)
--
-- The initial migration (20260723000000) already created every table in §4.2
-- plus RLS, groups, practice exams and file storage. This migration reconciles
-- the column-level differences rather than recreating the tables, so it is safe
-- to run against a database that already has the initial schema applied — and
-- equally safe on a fresh one, since it runs immediately after it.
--
-- Every statement is guarded (if exists / if not exists / catalog lookups) so
-- the file is idempotent and can be re-run without error.
-- ============================================================================

-- ============================================================================
-- profiles
--   * full_name -> name (§4.2 calls it `name`)
--   * preferences gains the documented default payload
-- ============================================================================
do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'profiles' and column_name = 'full_name'
  ) and not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'profiles' and column_name = 'name'
  ) then
    alter table public.profiles rename column full_name to name;
  end if;
end
$$;

alter table public.profiles
  alter column preferences set default '{
    "theme": "dark",
    "tutor_voice": "marcus",
    "lecture_length": "medium",
    "quiz_difficulty": "easy",
    "flashcard_difficulty": "easy"
  }'::jsonb;

-- Existing rows created before this migration still hold '{}'; give them the
-- documented defaults without clobbering anyone's real preferences.
update public.profiles
set preferences = '{
  "theme": "dark",
  "tutor_voice": "marcus",
  "lecture_length": "medium",
  "quiz_difficulty": "easy",
  "flashcard_difficulty": "easy"
}'::jsonb
where preferences is null or preferences = '{}'::jsonb;

-- The signup trigger referenced the old column name.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, email, name, avatar_url)
  values (
    new.id,
    new.email,
    coalesce(new.raw_user_meta_data ->> 'full_name', new.raw_user_meta_data ->> 'name'),
    new.raw_user_meta_data ->> 'avatar_url'
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

-- ============================================================================
-- modules — source ingestion + progression tracking
-- ============================================================================
alter table public.modules
  add column if not exists source_summary  text,
  add column if not exists course_context  text,
  add column if not exists progression_map jsonb,
  add column if not exists status          text not null default 'processing';

-- ============================================================================
-- domains — ordered, weighted, unlockable
--   * name -> title
-- ============================================================================
do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'domains' and column_name = 'name'
  ) and not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'domains' and column_name = 'title'
  ) then
    alter table public.domains rename column name to title;
  end if;
end
$$;

alter table public.domains
  add column if not exists order_index  integer,
  add column if not exists weight_pct   numeric,
  add column if not exists status       text not null default 'locked',
  add column if not exists completed_at timestamptz;

create index if not exists domains_module_order_idx
  on public.domains (module_id, order_index);

-- ============================================================================
-- lectures — generated audio, transcript and playback position
-- ============================================================================
alter table public.lectures
  add column if not exists audio_url          text,
  add column if not exists transcript         text,
  add column if not exists duration_secs      integer,
  add column if not exists tutor_voice        text,
  add column if not exists length_preference  text,
  add column if not exists last_position_secs integer not null default 0,
  add column if not exists completed_at       timestamptz,
  add column if not exists is_favourite       boolean not null default false;

-- §4.2 lectures carry no title, so the initial NOT NULL would reject a
-- spec-shaped insert.
alter table public.lectures alter column title drop not null;

-- ============================================================================
-- qa_sessions — groups the Q&A turns recorded during one lecture playthrough
--   * title -> session_title
-- ============================================================================
do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'qa_sessions' and column_name = 'title'
  ) and not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'qa_sessions' and column_name = 'session_title'
  ) then
    alter table public.qa_sessions rename column title to session_title;
  end if;
end
$$;

alter table public.qa_sessions
  add column if not exists domain_id      uuid references public.domains (id) on delete cascade,
  add column if not exists question_count integer not null default 0;

-- session_title is auto-generated from the first question, so it starts empty.
alter table public.qa_sessions alter column session_title drop not null;
alter table public.qa_sessions alter column session_title drop default;

create index if not exists qa_sessions_domain_id_idx on public.qa_sessions (domain_id);

-- ============================================================================
-- lecture_qa — one row per spoken turn
-- ============================================================================
alter table public.lecture_qa
  add column if not exists timestamp_secs integer;

-- §4.2 defaults knowledge questions to true (confirmations/closings opt out).
alter table public.lecture_qa alter column is_knowledge_question set default true;

-- The spec stores the cleaned `question_summary` + raw `full_transcription`
-- instead of a single `question`, so the original NOT NULL must go.
alter table public.lecture_qa alter column question drop not null;

-- ============================================================================
-- flashcards / quizzes — difficulty + favourites
-- ============================================================================
alter table public.flashcards
  add column if not exists difficulty   text,
  add column if not exists is_favourite boolean not null default false;

alter table public.quizzes
  add column if not exists difficulty     text,
  add column if not exists question_count integer,
  add column if not exists score          numeric,
  add column if not exists is_favourite   boolean not null default false;

-- ============================================================================
-- Ownership backfill
--
-- §4.2 omits user_id on the child tables, but every RLS policy from the initial
-- migration keys off it and the columns are NOT NULL. These triggers default
-- user_id to the caller (auth.uid()) so a spec-shaped insert succeeds under the
-- anon/authenticated key. An explicitly supplied user_id always wins, so this
-- is purely additive — service-role inserts from the backend must still pass
-- user_id themselves, since auth.uid() is null there.
-- ============================================================================
create or replace function public.set_user_id_default()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.user_id is null then
    new.user_id = auth.uid();
  end if;
  return new;
end;
$$;

drop trigger if exists modules_set_user_id     on public.modules;
drop trigger if exists domains_set_user_id     on public.domains;
drop trigger if exists lectures_set_user_id    on public.lectures;
drop trigger if exists qa_sessions_set_user_id on public.qa_sessions;
drop trigger if exists lecture_qa_set_user_id  on public.lecture_qa;
drop trigger if exists flashcards_set_user_id  on public.flashcards;
drop trigger if exists quizzes_set_user_id     on public.quizzes;

create trigger modules_set_user_id
  before insert on public.modules
  for each row execute function public.set_user_id_default();

create trigger domains_set_user_id
  before insert on public.domains
  for each row execute function public.set_user_id_default();

create trigger lectures_set_user_id
  before insert on public.lectures
  for each row execute function public.set_user_id_default();

create trigger qa_sessions_set_user_id
  before insert on public.qa_sessions
  for each row execute function public.set_user_id_default();

create trigger lecture_qa_set_user_id
  before insert on public.lecture_qa
  for each row execute function public.set_user_id_default();

create trigger flashcards_set_user_id
  before insert on public.flashcards
  for each row execute function public.set_user_id_default();

create trigger quizzes_set_user_id
  before insert on public.quizzes
  for each row execute function public.set_user_id_default();
