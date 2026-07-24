-- ============================================================================
-- AI Study Tutor — initial schema
-- Postgres / Supabase. Run via `supabase db push` or paste into the SQL editor.
--
-- Conventions:
--   * All ids are uuid, defaulted with gen_random_uuid() (pgcrypto).
--   * User-owned rows carry user_id -> profiles(id) for straightforward RLS.
--   * RLS is enabled on every table; owners get full access, group members get
--     read access to explicitly shared domains (via SECURITY DEFINER helpers to
--     avoid policy recursion).
-- ============================================================================

create extension if not exists "pgcrypto";

-- ----------------------------------------------------------------------------
-- Shared helpers
-- ----------------------------------------------------------------------------

-- Keep an updated_at column fresh on UPDATE.
create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- ============================================================================
-- profiles  (1:1 with auth.users)
-- ============================================================================
create table if not exists public.profiles (
  id          uuid primary key references auth.users (id) on delete cascade,
  email       text,
  full_name   text,
  avatar_url  text,
  preferences jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create trigger profiles_set_updated_at
  before update on public.profiles
  for each row execute function public.set_updated_at();

-- Auto-create a profile row whenever a new auth user signs up (incl. OAuth).
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, email, full_name, avatar_url)
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

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ============================================================================
-- modules  ->  domains  ->  lectures
-- ============================================================================
create table if not exists public.modules (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references public.profiles (id) on delete cascade,
  title       text not null,
  description text not null default '',
  color       text not null default '#6C63FF',
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index if not exists modules_user_id_idx on public.modules (user_id);

create trigger modules_set_updated_at
  before update on public.modules
  for each row execute function public.set_updated_at();

create table if not exists public.domains (
  id          uuid primary key default gen_random_uuid(),
  module_id   uuid not null references public.modules (id) on delete cascade,
  user_id     uuid not null references public.profiles (id) on delete cascade,
  name        text not null,
  description text not null default '',
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index if not exists domains_module_id_idx on public.domains (module_id);
create index if not exists domains_user_id_idx on public.domains (user_id);

create trigger domains_set_updated_at
  before update on public.domains
  for each row execute function public.set_updated_at();

create table if not exists public.lectures (
  id          uuid primary key default gen_random_uuid(),
  domain_id   uuid references public.domains (id) on delete cascade,
  module_id   uuid references public.modules (id) on delete cascade,
  user_id     uuid not null references public.profiles (id) on delete cascade,
  title       text not null,
  segments    jsonb not null default '[]'::jsonb,
  created_at  timestamptz not null default now()
);
create index if not exists lectures_domain_id_idx on public.lectures (domain_id);
create index if not exists lectures_user_id_idx on public.lectures (user_id);

-- ============================================================================
-- qa_sessions (NEW)  ->  lecture_qa (UPDATED)
-- ============================================================================
create table if not exists public.qa_sessions (
  id          uuid primary key default gen_random_uuid(),
  lecture_id  uuid not null references public.lectures (id) on delete cascade,
  user_id     uuid not null references public.profiles (id) on delete cascade,
  title       text not null default 'Q&A session',
  started_at  timestamptz not null default now(),
  ended_at    timestamptz,
  created_at  timestamptz not null default now()
);
create index if not exists qa_sessions_lecture_id_idx on public.qa_sessions (lecture_id);
create index if not exists qa_sessions_user_id_idx on public.qa_sessions (user_id);

create table if not exists public.lecture_qa (
  id                   uuid primary key default gen_random_uuid(),
  lecture_id           uuid not null references public.lectures (id) on delete cascade,
  session_id           uuid references public.qa_sessions (id) on delete cascade,
  user_id              uuid not null references public.profiles (id) on delete cascade,
  question             text not null,
  answer               text not null default '',
  question_summary     text,
  full_transcription   text,
  is_knowledge_question boolean not null default false,
  created_at           timestamptz not null default now()
);
create index if not exists lecture_qa_lecture_id_idx on public.lecture_qa (lecture_id);
create index if not exists lecture_qa_session_id_idx on public.lecture_qa (session_id);
create index if not exists lecture_qa_user_id_idx on public.lecture_qa (user_id);

-- ============================================================================
-- flashcards / quizzes
-- ============================================================================
create table if not exists public.flashcards (
  id           uuid primary key default gen_random_uuid(),
  domain_id    uuid references public.domains (id) on delete cascade,
  module_id    uuid references public.modules (id) on delete cascade,
  user_id      uuid not null references public.profiles (id) on delete cascade,
  front        text not null,
  back         text not null,
  ease         real not null default 2.5,
  interval_days integer not null default 0,
  repetitions  integer not null default 0,
  due_at       timestamptz not null default now(),
  created_at   timestamptz not null default now()
);
create index if not exists flashcards_domain_id_idx on public.flashcards (domain_id);
create index if not exists flashcards_user_id_idx on public.flashcards (user_id);

create table if not exists public.quizzes (
  id          uuid primary key default gen_random_uuid(),
  domain_id   uuid references public.domains (id) on delete cascade,
  module_id   uuid references public.modules (id) on delete cascade,
  user_id     uuid not null references public.profiles (id) on delete cascade,
  title       text not null default 'Untitled Quiz',
  questions   jsonb not null default '[]'::jsonb,
  created_at  timestamptz not null default now()
);
create index if not exists quizzes_domain_id_idx on public.quizzes (domain_id);
create index if not exists quizzes_user_id_idx on public.quizzes (user_id);

-- ============================================================================
-- groups / membership / sharing
-- ============================================================================
create table if not exists public.groups (
  id          uuid primary key default gen_random_uuid(),
  owner_id    uuid not null references public.profiles (id) on delete cascade,
  name        text not null,
  description text not null default '',
  invite_code text not null unique,
  created_at  timestamptz not null default now()
);
create index if not exists groups_owner_id_idx on public.groups (owner_id);

create table if not exists public.group_members (
  id        uuid primary key default gen_random_uuid(),
  group_id  uuid not null references public.groups (id) on delete cascade,
  user_id   uuid not null references public.profiles (id) on delete cascade,
  role      text not null default 'member' check (role in ('owner', 'member')),
  joined_at timestamptz not null default now(),
  unique (group_id, user_id)
);
create index if not exists group_members_group_id_idx on public.group_members (group_id);
create index if not exists group_members_user_id_idx on public.group_members (user_id);

create table if not exists public.group_shared_domains (
  id         uuid primary key default gen_random_uuid(),
  group_id   uuid not null references public.groups (id) on delete cascade,
  domain_id  uuid not null references public.domains (id) on delete cascade,
  shared_by  uuid not null references public.profiles (id) on delete cascade,
  created_at timestamptz not null default now(),
  unique (group_id, domain_id)
);
create index if not exists group_shared_domains_group_id_idx on public.group_shared_domains (group_id);
create index if not exists group_shared_domains_domain_id_idx on public.group_shared_domains (domain_id);

-- ----------------------------------------------------------------------------
-- Group access helpers (SECURITY DEFINER bypasses RLS internally, which avoids
-- infinite recursion between the group_members policy and itself).
-- ----------------------------------------------------------------------------
create or replace function public.is_group_member(_group_id uuid)
returns boolean
language sql
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.group_members gm
    where gm.group_id = _group_id and gm.user_id = auth.uid()
  );
$$;

create or replace function public.is_group_owner(_group_id uuid)
returns boolean
language sql
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.groups g
    where g.id = _group_id and g.owner_id = auth.uid()
  );
$$;

-- True if the given domain is shared into any group the caller belongs to.
create or replace function public.can_access_shared_domain(_domain_id uuid)
returns boolean
language sql
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.group_shared_domains gsd
    join public.group_members gm on gm.group_id = gsd.group_id
    where gsd.domain_id = _domain_id and gm.user_id = auth.uid()
  );
$$;

-- ============================================================================
-- practice exams / questions / concept cache
-- ============================================================================
create table if not exists public.practice_exams (
  id               uuid primary key default gen_random_uuid(),
  module_id        uuid references public.modules (id) on delete cascade,
  domain_id        uuid references public.domains (id) on delete cascade,
  user_id          uuid not null references public.profiles (id) on delete cascade,
  title            text not null default 'Practice Exam',
  duration_minutes integer not null default 30,
  total_points     integer not null default 0,
  created_at       timestamptz not null default now()
);
create index if not exists practice_exams_user_id_idx on public.practice_exams (user_id);

create table if not exists public.practice_questions (
  id              uuid primary key default gen_random_uuid(),
  exam_id         uuid not null references public.practice_exams (id) on delete cascade,
  kind            text not null default 'mcq' check (kind in ('mcq', 'short_answer')),
  prompt          text not null,
  options         jsonb not null default '[]'::jsonb,
  correct_index   integer,
  expected_answer text,
  points          integer not null default 1,
  position        integer not null default 0,
  created_at      timestamptz not null default now()
);
create index if not exists practice_questions_exam_id_idx on public.practice_questions (exam_id);

create table if not exists public.exam_concept_cache (
  id         uuid primary key default gen_random_uuid(),
  domain_id  uuid not null references public.domains (id) on delete cascade,
  user_id    uuid not null references public.profiles (id) on delete cascade,
  concept    text not null,
  payload    jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique (domain_id, concept)
);
create index if not exists exam_concept_cache_domain_id_idx on public.exam_concept_cache (domain_id);

-- ============================================================================
-- review_later / imported questions / user files
-- ============================================================================
create table if not exists public.review_later (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references public.profiles (id) on delete cascade,
  item_type  text not null check (item_type in ('flashcard', 'quiz', 'practice_question', 'lecture_qa')),
  item_id    uuid not null,
  note       text not null default '',
  created_at timestamptz not null default now(),
  unique (user_id, item_type, item_id)
);
create index if not exists review_later_user_id_idx on public.review_later (user_id);

create table if not exists public.imported_practice_questions (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references public.profiles (id) on delete cascade,
  module_id   uuid references public.modules (id) on delete cascade,
  domain_id   uuid references public.domains (id) on delete cascade,
  source      text not null default 'upload',
  prompt      text not null,
  options     jsonb not null default '[]'::jsonb,
  answer      text,
  metadata    jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now()
);
create index if not exists imported_practice_questions_user_id_idx on public.imported_practice_questions (user_id);

create table if not exists public.user_files (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references public.profiles (id) on delete cascade,
  module_id    uuid references public.modules (id) on delete cascade,
  domain_id    uuid references public.domains (id) on delete cascade,
  filename     text not null,
  storage_path text not null,
  mime_type    text,
  size_bytes   bigint not null default 0,
  created_at   timestamptz not null default now()
);
create index if not exists user_files_user_id_idx on public.user_files (user_id);

-- ============================================================================
-- Row Level Security
-- ============================================================================
alter table public.profiles                    enable row level security;
alter table public.modules                     enable row level security;
alter table public.domains                     enable row level security;
alter table public.lectures                    enable row level security;
alter table public.qa_sessions                 enable row level security;
alter table public.lecture_qa                  enable row level security;
alter table public.flashcards                  enable row level security;
alter table public.quizzes                     enable row level security;
alter table public.groups                      enable row level security;
alter table public.group_members               enable row level security;
alter table public.group_shared_domains        enable row level security;
alter table public.practice_exams              enable row level security;
alter table public.practice_questions          enable row level security;
alter table public.exam_concept_cache          enable row level security;
alter table public.review_later                enable row level security;
alter table public.imported_practice_questions enable row level security;
alter table public.user_files                  enable row level security;

-- --- profiles ---------------------------------------------------------------
create policy "profiles: read own"   on public.profiles for select using (id = auth.uid());
create policy "profiles: update own" on public.profiles for update using (id = auth.uid()) with check (id = auth.uid());
create policy "profiles: insert own" on public.profiles for insert with check (id = auth.uid());

-- --- modules ----------------------------------------------------------------
create policy "modules: owner all" on public.modules
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());

-- --- domains (owner + shared read) ------------------------------------------
create policy "domains: read" on public.domains
  for select using (user_id = auth.uid() or public.can_access_shared_domain(id));
create policy "domains: write" on public.domains
  for insert with check (user_id = auth.uid());
create policy "domains: update own" on public.domains
  for update using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy "domains: delete own" on public.domains
  for delete using (user_id = auth.uid());

-- --- lectures (owner + shared read) -----------------------------------------
create policy "lectures: read" on public.lectures
  for select using (user_id = auth.uid() or public.can_access_shared_domain(domain_id));
create policy "lectures: write own" on public.lectures
  for insert with check (user_id = auth.uid());
create policy "lectures: update own" on public.lectures
  for update using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy "lectures: delete own" on public.lectures
  for delete using (user_id = auth.uid());

-- --- qa_sessions ------------------------------------------------------------
create policy "qa_sessions: owner all" on public.qa_sessions
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());

-- --- lecture_qa -------------------------------------------------------------
create policy "lecture_qa: owner all" on public.lecture_qa
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());

-- --- flashcards (owner + shared read) ---------------------------------------
create policy "flashcards: read" on public.flashcards
  for select using (user_id = auth.uid() or public.can_access_shared_domain(domain_id));
create policy "flashcards: write own" on public.flashcards
  for insert with check (user_id = auth.uid());
create policy "flashcards: update own" on public.flashcards
  for update using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy "flashcards: delete own" on public.flashcards
  for delete using (user_id = auth.uid());

-- --- quizzes (owner + shared read) ------------------------------------------
create policy "quizzes: read" on public.quizzes
  for select using (user_id = auth.uid() or public.can_access_shared_domain(domain_id));
create policy "quizzes: write own" on public.quizzes
  for insert with check (user_id = auth.uid());
create policy "quizzes: update own" on public.quizzes
  for update using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy "quizzes: delete own" on public.quizzes
  for delete using (user_id = auth.uid());

-- --- groups -----------------------------------------------------------------
create policy "groups: read (owner or member)" on public.groups
  for select using (owner_id = auth.uid() or public.is_group_member(id));
create policy "groups: insert own" on public.groups
  for insert with check (owner_id = auth.uid());
create policy "groups: update owner" on public.groups
  for update using (owner_id = auth.uid()) with check (owner_id = auth.uid());
create policy "groups: delete owner" on public.groups
  for delete using (owner_id = auth.uid());

-- --- group_members ----------------------------------------------------------
create policy "group_members: read (owner or member)" on public.group_members
  for select using (public.is_group_owner(group_id) or public.is_group_member(group_id));
create policy "group_members: join self" on public.group_members
  for insert with check (user_id = auth.uid());
create policy "group_members: leave self or owner removes" on public.group_members
  for delete using (user_id = auth.uid() or public.is_group_owner(group_id));

-- --- group_shared_domains ---------------------------------------------------
create policy "group_shared_domains: read (owner or member)" on public.group_shared_domains
  for select using (public.is_group_owner(group_id) or public.is_group_member(group_id));
create policy "group_shared_domains: share own domain" on public.group_shared_domains
  for insert with check (
    shared_by = auth.uid()
    and (public.is_group_owner(group_id) or public.is_group_member(group_id))
    and exists (select 1 from public.domains d where d.id = domain_id and d.user_id = auth.uid())
  );
create policy "group_shared_domains: unshare (owner or sharer)" on public.group_shared_domains
  for delete using (shared_by = auth.uid() or public.is_group_owner(group_id));

-- --- practice_exams ---------------------------------------------------------
create policy "practice_exams: owner all" on public.practice_exams
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());

-- --- practice_questions (via parent exam) -----------------------------------
create policy "practice_questions: read via exam" on public.practice_questions
  for select using (
    exists (select 1 from public.practice_exams e where e.id = exam_id and e.user_id = auth.uid())
  );
create policy "practice_questions: write via exam" on public.practice_questions
  for insert with check (
    exists (select 1 from public.practice_exams e where e.id = exam_id and e.user_id = auth.uid())
  );
create policy "practice_questions: update via exam" on public.practice_questions
  for update using (
    exists (select 1 from public.practice_exams e where e.id = exam_id and e.user_id = auth.uid())
  );
create policy "practice_questions: delete via exam" on public.practice_questions
  for delete using (
    exists (select 1 from public.practice_exams e where e.id = exam_id and e.user_id = auth.uid())
  );

-- --- exam_concept_cache -----------------------------------------------------
create policy "exam_concept_cache: owner all" on public.exam_concept_cache
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());

-- --- review_later -----------------------------------------------------------
create policy "review_later: owner all" on public.review_later
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());

-- --- imported_practice_questions --------------------------------------------
create policy "imported_practice_questions: owner all" on public.imported_practice_questions
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());

-- --- user_files -------------------------------------------------------------
create policy "user_files: owner all" on public.user_files
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());
