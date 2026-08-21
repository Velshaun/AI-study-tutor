-- ============================================================================
-- The question bank: what you got wrong, and what you asked about.
--
-- Two containers, one table, distinguished by `container`. They behave
-- identically except that Q&A cannot generate a lecture, since it came from
-- one — a rule about what may be *made* from an entry, not about how entries
-- are stored, so it lives in the service and not here.
--
-- **Entries are snapshots, not references.** The obvious design is a foreign
-- key to the question, and it does not survive contact with this schema:
-- quiz questions live inside `quizzes.questions` as jsonb and have no row to
-- point at, so half the sources have no stable id to begin with. Copying is
-- also the honest shape for what this is — a durable record of what a learner
-- got wrong should outlive the practice exam it came from, and a foreign key
-- would delete their revision history along with a paper they tidied away.
--
-- `source_kind`/`source_id` are kept as a soft reference so an entry can point
-- back at where it came from, and are allowed to dangle.
--
-- **Auto-graduation** needs the same question re-served, which snapshots make
-- easy: a set generated from the bank writes real questions carrying
-- `bank_entry_id`, and answering one updates the streak here. Two correct in a
-- row retires the entry. `graduated_at` rather than a delete, so a retired
-- entry can be shown as retired instead of vanishing.
--
-- Absorbs `review_later`, which was already a per-user polymorphic flag
-- container with exactly these item types. Its rows are migrated in as
-- `flagged`, and it is left empty and unread until a later migration drops it —
-- the same retirement `imported_practice_questions` got.
--
-- Idempotent: safe to re-run.
-- ============================================================================

create table if not exists public.question_bank (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references public.profiles (id) on delete cascade,
  -- Scoped to a module: "my missed questions" is a question about one subject.
  module_id     uuid not null references public.modules (id) on delete cascade,

  -- 'missed' — wrong answers and flags from exams, quizzes and flashcards.
  -- 'qa'     — questions asked of the tutor during a lecture.
  container     text not null check (container in ('missed', 'qa')),

  -- Where it came from. Soft: allowed to dangle when the origin is deleted,
  -- which is the point of snapshotting.
  source_kind   text not null check (
                  source_kind in ('practice_question', 'quiz', 'flashcard',
                                  'lecture_qa')),
  source_id     uuid,
  domain_id     uuid references public.domains (id) on delete set null,

  -- Why it is here. An entry can be both: got it wrong *and* flagged it.
  missed        boolean not null default false,
  flagged       boolean not null default false,

  -- Everything needed to re-serve or transform it without the original:
  -- prompt/options/correct_index/explanation for questions, front/back for
  -- cards, question/answer for Q&A.
  snapshot      jsonb not null default '{}'::jsonb,

  -- Consecutive correct answers since the last mistake. Reset to 0 on a wrong
  -- answer, so "twice in a row" means what it says.
  correct_streak integer not null default 0,
  -- Set when the streak reaches the graduation threshold. Null means active.
  graduated_at  timestamptz,

  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

-- One entry per source item per container. The confirmation prompt can then be
-- answered twice without duplicating anything, and re-missing a question
-- already in the bank updates it rather than adding a second copy.
create unique index if not exists question_bank_source_idx
  on public.question_bank (user_id, module_id, container, source_kind, source_id)
  where source_id is not null;

-- The list view: one module's active entries, newest first. Ordering is part
-- of the index because the scoping dial offers "oldest" and "most recent".
create index if not exists question_bank_active_idx
  on public.question_bank (module_id, container, created_at)
  where graduated_at is null;

alter table public.question_bank enable row level security;

drop policy if exists question_bank_owner on public.question_bank;
create policy question_bank_owner on public.question_bank
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());


-- ============================================================================
-- Sessions: what happened in one sitting.
--
-- Exams already had this in `exam_attempts`; quizzes and flashcards had
-- nothing, so there was no way to show a past quiz's questions or generate
-- from them. This is the shared record, and it is what makes every past
-- session "a living source" — the results are stored, so the historical pill
-- can reopen them long after the run.
--
-- Deliberately *not* `study_attempts`, which is a resume point for an
-- unfinished run and is unique per item. This is the finished record, and
-- there can be many per item.
-- ============================================================================

create table if not exists public.study_sessions (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references public.profiles (id) on delete cascade,
  module_id    uuid not null references public.modules (id) on delete cascade,
  kind         text not null check (
                 kind in ('exam', 'quiz', 'flashcards', 'practice')),
  -- The exam / quiz / deck this was a sitting of. Soft, for the same reason as
  -- the bank: a session's history should outlive the thing it was a sitting of.
  item_id      uuid,
  title        text not null default '',

  total        integer not null default 0,
  correct      integer not null default 0,
  score_pct    numeric(5,2),

  -- One entry per question: the snapshot, what was chosen, whether it was
  -- right, and whether it was flagged. Everything the results screen and the
  -- generate-from-this-session flow need, without re-reading the origin.
  results      jsonb not null default '[]'::jsonb,

  created_at   timestamptz not null default now()
);

create index if not exists study_sessions_module_idx
  on public.study_sessions (module_id, created_at desc);

alter table public.study_sessions enable row level security;

drop policy if exists study_sessions_owner on public.study_sessions;
create policy study_sessions_owner on public.study_sessions
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());


-- ============================================================================
-- Questions generated from the bank point back at their entry, so answering
-- one updates its streak. Null for every ordinary question, which is most of
-- them.
-- ============================================================================

alter table public.practice_questions
  add column if not exists bank_entry_id uuid
    references public.question_bank (id) on delete set null;

create index if not exists practice_questions_bank_idx
  on public.practice_questions (bank_entry_id)
  where bank_entry_id is not null;

-- Quiz questions live in jsonb and have no row, so their bank id rides inside
-- the question object as `bank_entry_id`. Noted here because that asymmetry is
-- invisible from the schema and surprising otherwise.


-- ============================================================================
-- A module gets exactly one pre-assessment, forever.
--
-- It is the baseline every later sitting is compared against, so a second one
-- would silently move the line the learner is measuring themselves against.
-- Enforced here rather than in the router because "exactly once" is a property
-- of the data, and the router is not the only thing that writes exams.
-- ============================================================================

create unique index if not exists practice_exams_one_pre_assessment_idx
  on public.practice_exams (module_id)
  where kind = 'pre_assessment';


-- ============================================================================
-- Absorb review_later.
--
-- Its rows were flags, so they arrive as `flagged` with no snapshot — there is
-- nothing to snapshot retrospectively that the source doesn't still hold, and
-- an entry whose source still exists reads fine without one. The module comes
-- from whichever table the item lives in.
-- ============================================================================

insert into public.question_bank
  (user_id, module_id, container, source_kind, source_id, domain_id,
   flagged, snapshot, created_at)
select r.user_id,
       m.module_id,
       case when r.item_type = 'lecture_qa' then 'qa' else 'missed' end,
       r.item_type,
       r.item_id,
       m.domain_id,
       true,
       '{}'::jsonb,
       r.created_at
  from public.review_later r
  join lateral (
    select case r.item_type
             when 'practice_question' then
               (select e.module_id from public.practice_questions q
                  join public.practice_exams e on e.id = q.exam_id
                 where q.id = r.item_id)
             when 'quiz' then
               (select q.module_id from public.quizzes q where q.id = r.item_id)
             when 'flashcard' then
               (select f.module_id from public.flashcards f where f.id = r.item_id)
             else null
           end as module_id,
           case r.item_type
             when 'quiz' then
               (select q.domain_id from public.quizzes q where q.id = r.item_id)
             when 'flashcard' then
               (select f.domain_id from public.flashcards f where f.id = r.item_id)
             else null
           end as domain_id
  ) m on true
 where m.module_id is not null
on conflict do nothing;

comment on table public.review_later is
  'Retired — absorbed into question_bank as flagged entries. Kept empty and '
  'unread until a later migration drops it, so a missed reader is recoverable '
  'rather than fatal.';
