-- No domain is locked behind another, and the flag stops meaning two things.
--
-- `domains.status` carried a progression gate — `pipeline` wrote 'unlocked' for
-- order_index 1 and 'locked' for everything after it — and no code path ever
-- moved a domain out of 'locked'. So it was never "finish domain one to open
-- domain two"; domains two onward were locked at creation and stayed that way.
-- A learner whose pre-assessment says domains two, three and four are their
-- weakest was shut out of exactly the material they needed.
--
-- The same value also meant something entirely different and load-bearing: an
-- imported flashcard deck is stored as its own domain with status='locked' so
-- that bulk generation, exam weighting and domain assignment all skip it. Six
-- backend filters read `status != 'locked'` to mean "is a real blueprint
-- domain". Flipping everything to unlocked without separating the two would
-- have given imported decks exam weights and swept them into generate-for-all.
--
-- So the second meaning gets its own column, and the first is deleted.
-- `order_index` is untouched: it is what `exam_profile` allocates papers by,
-- and recommendation order is a property of the screen, not of the data.
--
-- Idempotent and safe to re-run.

alter table public.domains
  add column if not exists is_deck boolean not null default false;

-- A deck is what a zero-weight locked domain always was. Done before the
-- unlock below, which would otherwise erase the evidence.
update public.domains
   set is_deck = true
 where status = 'locked'
   and coalesce(weight_pct, 0) = 0
   and is_deck = false;

-- Every remaining lock was progression, and progression is gone. 'in_progress'
-- and 'completed' are left alone — they are study state, not permission, and
-- completion counting reads them.
update public.domains
   set status = 'unlocked'
 where status = 'locked';

create index if not exists domains_module_deck_idx
  on public.domains (module_id) where is_deck = false;
