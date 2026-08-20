-- ============================================================================
-- Domain weights are looked up, never derived — and once set, frozen.
--
-- A weight is a property of the *exam*, not of whatever material happens to
-- have been uploaded. Deriving it from the material meant every import could
-- silently re-derive it: two `process_module` runs minutes apart over the same
-- six sources produced LPI's published split once and a flat 20/20/20/20/20 the
-- next. Both summed to 100, both looked plausible, and only one was right —
-- while `exam_profile` allocates questions by those numbers.
--
-- So provenance has to be recorded, not just the value. Without knowing where a
-- set came from there is no way to express the rule that matters: a model's
-- guess must never overwrite a vendor's published figures.
--
--   published   the vendor's own objectives, or the catalogue's copy of them
--   study_guide an uploaded guide that states the weightings explicitly
--   provisional nothing published could be found; a later guide may supersede
--
-- Provisional is the only state a later lookup is allowed to replace.
--
-- Idempotent: safe to re-run.
-- ============================================================================

alter table public.modules
  add column if not exists weights_source text
    check (weights_source in ('published', 'study_guide', 'provisional')),
  -- When they were fixed, so "frozen" is auditable rather than implied by the
  -- absence of a later write.
  add column if not exists weights_set_at timestamptz,
  -- Where they came from: a vendor URL, or the filename of the guide that
  -- stated them. A provisional set records what was searched and not found.
  add column if not exists weights_citation text;

comment on column public.modules.weights_source is
  'published | study_guide | provisional. Only a provisional set may be '
  'replaced by a later lookup; nothing may overwrite published.';

-- Existing modules pre-date the distinction, and every one of them was written
-- by the old derive-on-rebuild path. Calling them provisional is the honest
-- reading: it is what they are, and it leaves them open to being superseded by
-- a real lookup rather than frozen at a value nobody verified.
update public.modules
   set weights_source = 'provisional',
       weights_set_at = coalesce(weights_set_at, now())
 where weights_source is null;
