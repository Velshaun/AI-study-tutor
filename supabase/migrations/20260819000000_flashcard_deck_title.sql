-- ============================================================================
-- AI Study Tutor — generated flashcard deck names
--
-- A deck has no row of its own: cards are grouped by the domain they belong to.
-- That left the Classroom tab naming decks after the domain and a count
-- ("The Power of the Command Line — 50 cards") when the model that wrote the
-- cards could say what they actually cover ("Core CLI Commands").
--
-- The title is stored on every card of the deck rather than in a new table:
-- cards are always read and deleted as a domain-scoped set, so there is nothing
-- a deck row would own that the cards don't already share.
--
-- Idempotent: safe to re-run.
-- ============================================================================

alter table public.flashcards
  add column if not exists deck_title text;
