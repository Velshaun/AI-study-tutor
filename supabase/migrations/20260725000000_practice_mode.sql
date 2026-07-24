-- ============================================================================
-- Practice Exam Mode — spec 6.4
--
-- A domain-scoped practice experience with per-question immediate feedback, a
-- Why Card, and a Review Later queue. This reconciles the spec's proposed DDL
-- with the tables that already exist rather than dropping working ones:
--
--   * practice_questions gains a domain-bank identity — questions can live
--     independently of a generated exam (exam_id nullable), keyed to a domain,
--     each with a Why Card summary. Per-option feedback (a 1-2 line explanation
--     and a normalised term_key) rides in the existing `options` jsonb:
--     [{label, text, term_key, explanation}].
--   * review_later (already polymorphic) serves this via item_type
--     'practice_question' — a superset of the spec's practice-only table.
--   * exam_concept_cache (already per-domain) caches per-term explanations with
--     concept = the normalised term_key.
--
-- Idempotent: safe to re-run.
-- ============================================================================

alter table public.practice_questions
  alter column exam_id drop not null;

alter table public.practice_questions
  add column if not exists domain_id   uuid references public.domains (id) on delete cascade,
  add column if not exists why_summary text;

create index if not exists practice_questions_domain_id_idx
  on public.practice_questions (domain_id);
