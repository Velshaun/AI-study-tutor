# ConverseAI — working notes

An AI study tutor: upload course material, get lectures, flashcards, quizzes and
practice exams generated from it, and study against the real exam's shape.

**Stack.** React + Vite + Tailwind v4 (Vercel) · FastAPI (Railway) · Supabase
(Postgres + Auth + Storage) · Gemini `gemini-2.5-flash` for generation and
vision · OpenAI for TTS and Whisper.

**Local.** `venv/Scripts/python.exe` at the repo root; run backend commands from
`backend/`. The frontend dev server is on **port 3000**, not Vite's default —
`npm --prefix frontend run dev`.

---

## The shape of it

```
backend/app/
  routers/    HTTP surface, one per domain area
  services/   the thinking; routers stay thin
frontend/src/
  pages/      routes
  components/ module/ (module screens), study/ (runners), shared
  lib/        pure logic — no React, so it's testable
  context/    providers; GenerationProvider lives in RootLayout, inside the router
supabase/migrations/   timestamped, idempotent, safe to re-run
```

### Services worth knowing

| Service | Owns |
|---|---|
| `exam_profile` | How long a practice set or exam should be, in one place |
| `exam_catalog` | Published specs for ~35 certifications (question count, time limit) |
| `ai_service` | Flashcard / quiz / practice generation, batching, imported-exam parsing |
| `terms` | The tappable-term schema fragment and its validation |
| `tutor` | Module context, material assessment, question answering |
| `coverage` | Chunked full reading of sources; the stored per-domain map |
| `link_check` / `dead_links` | Validating discovered URLs; learner reports feeding back |
| `extraction` | PDF, text, audio, **image (Gemini vision)**, **video (frames + narration)** |
| `pipeline` | Ingestion, and the guard that stops it destroying study content |
| `performance` | Rolling per-domain strength, adaptive weighting, attempt records |
| `jobs` | The durable queue: claim, checkpoint, resume, retry-failed |
| `schema_features` | Probes for optional columns so the API can deploy ahead of a migration |

---

## Decisions that carry weight

Each of these was a fork in the road. The reasoning matters more than the code.

**Exam length has one source of truth.** `exam_profile.exam_question_count()`
resolves: explicit request → `modules.exam_question_count` → `exam_catalog`'s
published spec → largest imported past paper → default 20. Generators used to
carry their own constants (practice mode: 8, exams: 20), which is why revising
for a 40-question paper produced an 8-question set.

**The tutor reads everything, once, and keeps what it learnt.** An assessment
used to sample 60,000 characters — 6,000 per source, then a hard stop. The live
A+ module holds 498,697 characters in a single file, so 88% of it was invisible,
and a domain taught in chapter nine read as "missing". `coverage` now splits
every source into 50,000-character chunks with 500 of overlap, judges each
against the blueprint on its own, and aggregates the findings into one stored
map. The verdict is then a single cheap call over evidence rather than a
sampled read, so it costs the same for 2MB as for 20KB.

**Coverage is decided by the aggregator, not the model.** A model shown one
chunk cannot judge breadth across a pack it never saw, so the rule lives in
code: thorough anywhere wins; overview in two or more chunks wins; overview in
one is partial; a bare mention is never coverage however often it recurs. The
same instinct as `covered_pct` — evidence adds up in Python.

**The catalogue matches conservatively.** An exam code in the title is proof;
a distinctive product name is good evidence (longest match wins); everything
else stays generic. A wrong match would silently mistime someone's revision.

**Explanations are written at generation time, not answer time.** Every option
carries its own why-right/why-wrong line, stored with the question. This turned
feedback from a 2–4s model call into a single read (**0.14s** measured). The
pre-submission payload maps only label/text/term_key, so nothing leaks early.

**Timed exams store a deadline, not remaining seconds.** Storing the remainder
would make walking away a way to buy more time.

**Imported exam PDFs become real exams.** Written to `practice_exams` /
`practice_questions` — the same tables generated exams use — so they behave
identically by construction rather than by matching two code paths. A PDF
holding several papers is split into several exams.

**Ingestion never cascade-deletes studied content.** Domains cascade; re-running
the pipeline used to take every lecture, deck, quiz and practice question with
it. A domain holding generated content is now updated in place, or preserved and
logged if the new blueprint drops it. `?force=true` is the explicit rebuild, and
the UI confirms against `GET /sources/{id}/reprocess-impact` first.
`order_index` is uniquely indexed per module, so survivors vacate their slots
before the incoming blueprint claims them.

**New data rides in existing `jsonb` where that's the honest shape.** Per-option
explanations live in `practice_questions.options` (already object-shaped for
practice mode; both shapes are read). Quiz questions carry their terms inside
`quizzes.questions`. Migrations were added only where there was genuinely
nowhere to put something.

**The Classroom is organised by domain, not by media type.** It was one pool
grouped by table — every lecture together, every deck together — which mirrored
the schema rather than the revision. Nobody sits down to "do some flashcards".
Every item already carried its `domain_id`; nothing grouped by it. Practice
exams stay outside the domain list because they are the one thing that spans
the whole blueprint.

**Two scores per domain, and only one of them is shown.** The display score
rises fast, falls slowly (0.6 up, 0.2 down) and never sits below 90% of the
best demonstrated, so one bad evening after a good fortnight reads as one bad
evening. The internal score reacts fully and decides where the next questions
come from. Collapsing them into one figure means either discouraging the
learner or misleading the generator; there is no single number that does both.
Red needs a low score on *both*, across two or more sittings.

**Exam questions carry `domain_id`.** Generation always allocated by domain
weight and then dropped the attribution at insert, so a 90-question paper could
only ever yield one percentage. Everything downstream — the breakdown, the
baseline, adaptive weighting — was impossible until the column was written.

**Pass marks are an approximation, and say so.** Vendors publish scaled
thresholds (675/900, 500/800) that are not linear in questions correct, so
`exam_catalog.pass_pct` is a study target rather than a re-implementation of
anyone's grading. The threshold is stored *with* each attempt so changing it
later never re-grades an old sitting.

**A pre-assessment is a flag, not a second code path.** Same generator, same
weights, same runner — `kind='pre_assessment'` and `adaptive=false`, because a
baseline weighted towards weaknesses the app hasn't observed yet would be
measuring nothing twice.

**Going back means something different in each runner, and the difference is
where the answer lives.** A quiz or exam holds its answers on the client until
one final submission, so revisiting is genuinely revisable — subject to the
rule below. Practice mode posts each answer as it is given: there is no later
submission to beat, so going back there is reading, not a second attempt. Its
options come back locked, with the answer given still marked, and no Submit or
Got It to press. Same navigator, different contract.

**Answered and shown-the-answer are different states.** Collapsing them into
one `locked` flag is what made back-navigation impossible to add coherently: an
answer can only be revised while nobody has told you what the right one is. So
a quiz, which carries its key and reveals on selection, fixes that answer —
quiz scores feed domain strength, and a score you can correct after seeing the
answer is one you dictated. An exam, whose key never leaves the server, says
nothing until the paper is handed in and stays editable throughout, which is
also how the real sitting behaves. `ExamRun` deliberately passes no `onAnswer`
for that reason.

**A quiz ships its answers; an exam withholds them.** They used to be the same
payload. Instant local feedback is right for a study quiz — a learner who reads
the response is only robbing themselves of practice. It is wrong for an exam
whose first sitting becomes the baseline every later attempt is measured
against, and which decides how much of each domain gets generated from then on:
a number that can be raised by reading the network response is not a
measurement. `POST /practice-exam/{id}/answer` reveals one question at a time,
once answered — one read, no model call, the same trade practice mode already
makes. The runner holds the styling back until the answer lands, or a locked
question flashes every option as wrong for the length of the round trip.

**Import progress is watched, not owned.** `GenerationProvider` holds its
jobs in a promise the browser keeps open, which is precisely why it can't carry
an import: close the tab and the promise dies with it. `JobsProvider` subscribes
to the `jobs` table over Realtime instead, so the row outlives the browser and
reopening the tab picks the job back up. It catches up with a fetch on mount as
well as subscribing — a subscription only reports changes made *after* it opens,
so an import that finished while the tab was shut would otherwise never be
mentioned. Jobs already announced are remembered in a ref, because StrictMode
replays state updaters and a replayed dedupe is no dedupe.

This is the one place the frontend talks to Supabase directly rather than
through `apiFetch`. Realtime needs the supabase-js client regardless, and RLS
(`user_id = auth.uid()`) is what makes it safe — the worker writes with the
service role and bypasses RLS, so the policy is written for the reader.

**The worker survives its own startup failing.** `signal.signal` only works
on the main thread, and an unguarded call raised before the loop had polled
once — killing the process with no log, because the first log came after. Signal
registration is best-effort now: losing the graceful stop costs a job being
reclaimed instead of finishing cleanly, losing the worker costs everything.

**Work that outlives a deploy needs a table, not a BackgroundTask.** A
FastAPI background task runs in the web process and dies with it — fine for a
generation the learner is watching, useless for importing a playlist across
several redeploys. `jobs` + `job_items` make the work a row. A job whose worker
stops heartbeating is *reclaimed*, and only its unfinished items re-run, so an
interrupted import continues rather than starting again.

**Claiming has to be SQL.** The backend reaches Postgres through PostgREST,
which cannot express `FOR UPDATE SKIP LOCKED`, so `claim_job` and
`claim_job_item` are database functions. Only one worker runs today; they are
written for N because the alternative is finding out under load that a second
worker means rewriting the claim path.

**A job's tallies are derived, never incremented.** Counters nudged per item
drift the moment anything is retried, and this is the number the learner
watches. Partial success is the designed outcome: a job with failures still
succeeded, and only one where nothing worked is a failure.

**Polymorphic tables follow the `review_later` precedent** — `item_type` +
`item_id`, no FK — where the referent lives in one of several tables. That's
`study_attempts` and `review_later`.

**Nothing that has to happen may wait on an animation.** `AnimatePresence
mode="wait"` holds the next child back until the previous one has finished
animating out, and framer-motion drives that from `requestAnimationFrame`. In
any environment where frames don't come — a backgrounded tab, a throttled
loop — the exit never completes and the run never advances: the header counts
up while the question stays put. Every stepper now uses a keyed container with
a CSS entrance (`.step-in` in `index.css`) and no exit at all, so the next item
is in the DOM the moment state changes.

The same reasoning rules out an animated `initial={{ opacity: 0 }}` on anything
that must be readable. A JS animation that never advances leaves the element
invisible; a CSS animation that never runs leaves it at its natural state,
which is correct. That is why `.step-in` has no fill-mode.

**Modals mount conditionally, never through `AnimatePresence`.** An exiting
child wasn't always unmounted, leaving an invisible `fixed inset-0` backdrop
that swallowed every later tap and made the app look frozen. A dismissal that
always works beats a fade on the way out. This applies to `Modal.jsx` and
`TermSheet.jsx`.

**A lecture id is not a lecture.** Generation writes the row first —
`pending`, `generating_text`, `generating_audio` — so `domain.lecture_id`
existing said nothing about whether there was audio behind it. Tiles opened an
empty player and the completion toast fired over a row still being written.
Status is now the gate everywhere (`lib/lectures.js`), the tile shows which
stage it's at instead of accepting the tap, and anything offering to *open* a
lecture waits on `GET /lectures/{id}/status` first.

**The player's `error` means "can't be opened", never "audio hiccup".** They
were one field, and the screen redirects on the first — so a dropped connection
mid-lecture would have read as "this lecture doesn't exist" and bounced the
learner out of it. A media error now sets `playbackError`, which shows as a
strip above the controls and leaves the transcript where it is.

**Generation outlives the screen that started it.** `GenerationProvider` sits in
`RootLayout` (inside the router, above every route), so navigating away doesn't
stop a job. Tiles show "Generating…" whenever the learner returns; completion
raises a toast that offers to open the result.

**Pronunciation uses the Web Speech API, not server TTS.** Instant, free,
offline in the PWA, and no round trip for a single word.

**Content readiness and learner readiness are different axes and must never
be one number.** Content readiness asks whether the app holds enough material
to teach each domain — a property of the sources, from `coverage`. Learner
readiness asks how the learner is performing — a property of the learner, from
`performance`. The old `/stats/readiness` blended them, and its middle term was
`answered / total` where `total` counted every *generated* practice question:
adding sources raised the denominator and dropped the learner's score without
them doing anything. Retired. The two live in separate cards, in separate
sections, with opposite calls to action — go and find material, or go and
study. Verified by their inputs: coverage reads `coverage_maps` + `user_files`,
performance reads `exam_attempts` + `quizzes`, and the only table they share is
`domains`, which is the blueprint both are measured against.

**A sat exam outranks a forced rebuild.** `practice_questions.domain_id`
cascades, so deleting a domain takes its questions out of any paper they appear
in. `exam_attempts` lives on `practice_exams` and survives, which is the worst
possible combination: the score stands and the questions behind it are gone.
`sat_exam_domains()` refuses the delete even under `force=true`. Nulling the
attribution instead was rejected — it keeps the paper whole while silently
detaching per-domain history, so an attempt's breakdown stops adding up to its
own total. An exam that exists but has never been sat is still deletable.

**Untouched is not weak.** Readiness shows a dash for a domain nothing has been
attempted in. Weights: quiz score 60%, practice answered 25%, lecture progress
15% — a score is evidence, effort is effort — and self-flagged questions pull it
down.

**Dead-link reports are per-learner.** One account can't poison another's
results. Three distinct reports on a host drop the host.

**The relevance filter is deliberately loose** — it drops only results sharing
*nothing* with the query. An empty result list serves a learner worse than a
loosely related one, and the dead/walled checks do the real work.

**Uploads classify by extension first, MIME second** (both, everywhere) because
phones disagree: an iOS photo arrives as `application/octet-stream` with an
extension, or `image/jpeg` with none. Video is matched **before** audio so
screen recordings get read, not just transcribed.

---

## How work gets verified here

Three layers, in this order:

1. **Offline suites** in the scratchpad, with a fake Supabase client. Fast,
   deterministic, good for allocation maths and reconciliation logic.
2. **Live tests** against the real Supabase and Gemini, using a throwaway module
   that is deleted in a `finally` block. This is where the real bugs surfaced.
3. **Browser harnesses** — a temporary page on an unguarded route, driven with
   the browser tools, then removed along with its route. Signing into the real
   app needs the owner's credentials, so this is how UI behaviour gets proven.

Bugs the first layer could not have caught, and the later ones did:

- A `setState` updater used for dedupe — React replays it in StrictMode, so
  every background job was dropped before it started.
- Swipe distance read back from state, which a quick flick outruns.
- `AnimatePresence` leaving an invisible tap-swallowing overlay.
- A unique index on `(module_id, order_index)` the mocked client didn't model.
- A multi-image OCR prompt saying "this image", so only the first frame was read.
- `AnimatePresence mode="wait"` pinning every runner to its first question when
  no animation frames arrive. The harness that exposed it was dismissed as an
  artifact at first — reasonably, since the pane genuinely wasn't compositing.
  It was both: the environment is why it showed up there, and the coupling to
  animation completion is why it showed up at all. Removing the coupling makes
  the same harness step cleanly, which is the proof it was load-bearing.
- `loadChunk` reading `chunks` from state in the same tick `setChunks` was
  called, so a freshly opened lecture never got a `src`. Every visible symptom
  pointed elsewhere — the transcript scrubbed, the button flipped to "pause" —
  because all of that runs off state the audio element was never part of.

---

## Current state

All twelve features from the August audit are shipped. Latest work, newest first:

| Commit | What |
|---|---|
| `3c42c0d` | Tutor with material assessment; per-domain readiness |
| `5ba0a71` | Progress saving across quizzes, exams, practice sets, decks |
| `0e3eb23` | Import exam PDFs as real exams; swipe-to-delete on media |
| `4de150a` | Optimistic module delete; descriptive media names |
| `73ca551` | One Classroom generate flow, preferences modal, background jobs |
| `4705bba`, `5d4afb1` | Image OCR and screen-recording ingestion; the full picker |
| `2d53c99` | Ingestion cascade guard; Modal overlay fix |
| `a5c14bf` | Tap-to-define terms with pronunciation |
| `428738d`, `60a7f66` | Exam sizing, instant feedback, source validation, timers |

### Migrations — all applied

`20260817000000` exam length · `20260817010000` dead links ·
`20260818000000` interactive terms · `20260819000000` deck titles ·
`20260820000000` study attempts · `20260821000000` tutor messages ·
`20260822000000` coverage maps · `20260823000000` domain performance ·
`20260824000000` job queue

Applied through the Supabase **Management API** with a personal access token
(`POST /v1/projects/{ref}/database/query`). The service-role key cannot run DDL,
and `supabase db push` needs the database password, which isn't in the repo.
`20260822000000` source coverage map · `20260823000000` domain performance
were applied on 19 Aug 2026 — `coverage.available()` and
`performance.available()` both return true against production now.

Two things worth knowing for next time. `urllib` gets a **403 / Cloudflare
1010** from `api.supabase.com` on its default user-agent; `curl` works. And the
SQL has to be JSON-encoded to a file and posted with `--data-binary @file` —
these migrations contain `$$` blocks and quotes that no amount of shell quoting
survives.

**The token used for this has been rotated — a new one is needed to apply
anything further.**

Live tables (25): `profiles, modules, domains, lectures, qa_sessions, lecture_qa,
flashcards, quizzes, practice_exams, practice_questions, imported_practice_questions,
exam_concept_cache, review_later, study_attempts, tutor_messages, user_files,
module_access, study_time, dead_link_reports, groups, group_members,
group_shared_domains, group_domain_views, coverage_maps, exam_attempts`

### Known gaps and loose ends

- **`GET /attempts/open` has no consumer.** It's the ready-made feed for a
  "continue where you left off" covering quizzes and exams, not just lectures.
- **The coverage map has never run against live Gemini.** Its pure logic has an
  offline suite (56 checks), and the fallback path is verified against the real
  Supabase, but no chunk has actually been sent — the migration isn't applied,
  so `available()` is false everywhere. Layer 2 is owed once a token exists.
- **A pack over ~3M characters is still truncated** (60 chunks × 50k). It says
  so: `truncated` rides in the map, the verdict is told to mention it, and the
  assessment card prints which tail was left out.
- **HEIC is accepted but untested on a real iPhone.** iOS usually converts to
  JPEG on pick, so it rarely arrives; if it does, Gemini may reject it.
- **"Add a screen recording" is a picker, not a recorder** — the web can't start
  a screen recording on a phone. Labelled honestly rather than promising it.
- **`/practice/:moduleId`** (the standalone exam setup page) is now redundant:
  the Classroom's own Practice exams section generates and lists them. Delete it.
- **A resumed practice run can't review what it answered before.** The saved
  attempt holds a position and nothing else, so the navigator shuts the earlier
  questions rather than reopening them as though they were unanswered. Storing
  the answers alongside the position would fix it.
- **`POST /practice-exam/{id}/answer` has no consumer** now that exams defer
  feedback. `QuizRunner` still supports the per-question reveal it feeds, so
  the endpoint is the ready-made hook for a "check as you go" exam mode.
- **A flashcard run saved before per-card marks resumes with 0 known.** The old
  save stored a count, which says how many without saying which; the count
  restarts rather than being wrong in a way nothing can correct.
- **Four `AnimatePresence` users remain** — MiniPlayer, VoiceInput,
  QASessionCard, ToastProvider. None of them step; they mount and unmount
  transient panels. They were audited during the stepper sweep, not changed.
- **Deleting a module bumps its `updated_at`**, which affects dashboard ordering
  — inherent to the write, not a bug.

### Deployment

Vercel builds the frontend, Railway the backend, both from `main`.

**Two images, one repo.** `Dockerfile.worker` (Playwright base) runs
`worker.py`; `Dockerfile.web` is the slim API image. Only the worker opens a
browser, so only it carries one. The web file is named `.web` deliberately:
Railway auto-detects a file called `Dockerfile` and would switch the live API's
build on the next push without anyone deciding to. Renaming it is that decision,
and belongs after the image has been built once — neither has been, because the
Docker daemon wouldn't start here.

The worker is a second Railway service pointed at `railway.worker.json`. It
serves no port and needs no health check; SIGTERM stops it taking new work, and
anything interrupted harder than that is reclaimed by heartbeat. Railway had a
transient build failure in mid-August that resolved on its own; there is no
`.python-version` or `runtime.txt`, so Railway picks its own Python and could
move under you again — pinning it is a one-line fix if it recurs.

---

## Conventions

- **Comments explain why, not what.** Match the density of the surrounding file.
- **British spelling** in generated content and prompts.
- **Errors name what does work** — "Try a PDF, a photo of your notes (JPG, PNG,
  HEIC)…" rather than "unsupported file type".
- **Never `git push` unasked.** Commit messages describe the problem before the
  fix, in prose.
- The repo lints clean; `react-hooks` rules are strict here (no `setState` in an
  effect body, no ref access during render, no component creation during render).
  Derive state rather than synchronising it.
