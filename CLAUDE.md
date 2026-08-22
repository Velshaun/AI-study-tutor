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
| `ingest` | The parse boundary: pasted material in, canonical records out |
| `imports` | Where a parse result is stored — source, deck, or exam |
| `youtube` | Link parsing, playlist listing, search — the Data API half |
| `domain_assign` | Files one source under exactly one domain, with confidence |
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

**Questions test a domain; they do not teach it.** The first live run of the
coverage map, 20 Aug 2026, read 503,684 characters of the A+ module across 11
chunks and reported all five domains `well_covered` at `thorough` depth. Its
only source is Professor Messer's Core 1 *Practice Exams* — 765 answer-option
lines, 256 answer keys, no teaching material at all. The map was not wrong about
breadth: every 50k chunk of a shuffled question bank really does touch every
domain. It was wrong about what that breadth meant, because the schema defined
`thorough` as "taught well enough to answer exam questions from", and a question
bank is exam questions.

Each chunk now says whether the passage *teaches* or *assesses*, and depth is
taken from the teaching material alone — assessment establishes that a domain
appears, never that anyone could learn it there. A domain with no teaching
behind it caps at `partial`, and the tutor says which kind of partial it is,
because "add a study guide" and "add more of one" are different instructions.

One stray `teaching` label among ten `assessment` ones is discounted, for the
same reason a bare mention is never coverage however often it recurs: a lone
contrary label is not evidence, and without that rule one slip out of eleven put
every A+ domain back to `well_covered`. A genuine small textbook — one teaching
chunk and no assessment — is not penalised.

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

**A question pool is the second exception to weight-based allocation.** Exam
length has one source of truth and every paper is allocated by domain weight —
except for the two cases where the questions already exist and were not chosen
by the blueprint. Imported past papers were the first. Sets generated from a
container or a past session are the second: the length is whatever the learner
dialled, and a fixed pool of their own mistakes cannot be allocated by weight
without either inventing questions or dropping the ones they asked for. Both
paths therefore bypass `exam_profile` and `performance.adaptive_weights`
deliberately, and say so at the call site.

**Nothing enters the missed container silently — and Q&A is the exception.**
The missed container collects things a learner would rather not have produced,
so a confirmation at the end of a session is the only way in. Lecture Q&A
collects things they went out of their way to ask, so asking again would be
asking twice; it mirrors on write, best-effort, with `lecture_qa` staying the
record of record.

**Frequency bars have to be spaced the way frequency is.** The visualiser
divided the analyser's bins evenly, which sounds fair and is not: bins are
linear in hertz, so with `fftSize` at 128 each covered 375Hz and half the bars
were mapped to 8-16kHz, where a narrated lecture has nothing at all. Measured
against a speech-shaped signal, 6 of 32 bars carried the whole picture — which
is exactly what it looked like. Log-spaced bands between 80Hz and 6kHz with
`fftSize` at 2048 put a bar's width where a bar's energy is: 21 of 26 now move.
Peak per band rather than mean, because a consonant is a short burst and
averaging erases it.

**Two doors into the same conversation, and the notice says which is which.**
With headphones the tutor can be interrupted by speaking, because the mic hears
only the learner. Through a speaker the mic hears the tutor too, so barge-in is
unreliable — and the hand-raise pauses the lecture and takes a typed question
instead. Both answer aloud *and* in writing. The difference is a fact about
acoustics nobody should have to deduce, so it is said once before the first
lecture and remembered; a notice that reappears is one people learn to dismiss
without reading.

**An answer is spoken as two clips, and only the first one is waited for.**
Time-to-first-audio scales with how much text goes to the synthesiser, not with
how the bytes come back — measured, a four-sentence answer took 2433ms and its
first sentence alone took 1076ms. Streaming the response was the obvious fix and
the wrong one: OpenAI holds for ~2.9s before emitting anything and then delivers
in ~1s, so piping buys the tail, and the tail was never the problem.

So the opener is synthesised and returned, the remainder is synthesised behind
it, and the player fetches the second clip while the first is still speaking —
putting that cost inside speech that is already happening rather than inside
silence. It works because a spoken sentence lasts several seconds against a
couple of seconds of synthesis; a very short opener would not cover it, which is
why sentences are absorbed up to a threshold before splitting.

One caveat worth carrying: OpenAI's TTS latency is noisy. The same 71-character
opener measured 1209ms, 1896ms and 3047ms across three consecutive runs, so any
single figure here is directional. What holds across every run is the shape —
less text up front is faster.

**One thing speaks at a time.** Starting the tutor ducks the lecture; finishing
gives it back. The standard audio-focus convention, and it removes barge-in
rather than solving it — there is never a moment when both are audible, so
nothing has to be coordinated between them.

The rule that makes it feel right: **focus only resumes what focus paused.** A
lecture the learner stopped themselves stays stopped, and pressing play while
the tutor holds focus drops the claim, so releasing it later never yanks
playback back to a state they have since changed. Held in a ref rather than
state, because taking and releasing must not schedule a render — and released on
unmount, so navigating away mid-answer cannot leave a lecture paused forever.

Voice replies reuse the lecture Q&A synthesiser rather than adding a second one,
and are off until asked for: a chat is a quiet thing until told otherwise.

**The tutor may act, and every action goes through an endpoint.** Not the
tables, and not a parallel implementation. The handlers already refuse to delete
a domain whose questions are in a sat exam, already check ownership, already cap
exam length and freeze weights — reaching past them would mean re-implementing
each of those guards correctly, forever, and a guard added later would not
apply. `tutor_actions` therefore knows *which* things may be done and nothing
about whether any particular one is allowed.

The verb list is an allowlist rather than a filter: anything unnamed cannot be
done whatever the sentence said, so a model describing an action it cannot name
produces a refusal instead of an approximation. Planning and executing are
separate calls — the plan comes back naming each step, the chat confirms, and
only then does anything fire. Because the second call takes the plan rather than
the sentence, the model is not involved in the confirmation and cannot talk its
way past it. The pre-assessment is never a delete candidate, and an exam that
has been sat says so in the confirmation before it is removed.

Routing is a local filter in front of the planner, not a second parser. Sending
every message to the planner would add a model call before every ordinary
question; the filter casts wide and decides nothing — a false positive costs one
small call that falls through to a normal answer, which nobody sees.

**Container entries are snapshots, not references.** A foreign key was the first
design and does not survive this schema: `quizzes.questions` is jsonb, so quiz
questions have no row to point at. Copying is also the honest shape — a record
of what someone got wrong should outlive the practice exam it came from.

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

**Domain weights are looked up, never derived — and then frozen.** A weight is
a property of the exam, not of the material someone uploaded. The blueprint
model used to produce them and the rebuild used to rewrite them, so adding one
source could re-derive the whole split: two runs minutes apart over the same six
sources gave LPI's published figures once and a flat 20/20/20/20/20 the next.
Both summed to 100, both looked reasonable, and `exam_profile` allocates every
practice paper by them.

`exam_weights` resolves them in one order and stops at the first answer: the
catalogue's transcription of the vendor's objectives, then a study guide that
states them outright, then the vendor's own page via grounded search, then
*provisional* — which is not a failure but a recorded state, and the only one a
later lookup may replace. Nothing overwrites a published set. The rebuild path
no longer writes `weight_pct` at all.

Provisional modules get an even split rather than the model's guess. A derived
split looks authoritative, sums to 100, and encodes only the shape of whatever
was uploaded; an even split is visibly a placeholder, which is what not knowing
actually looks like.

Two things this turned up that are worth keeping. LPI publishes integer weights
out of **40**, not percentages — the derived set had computed them out of 39 and
given topic 5 a 6, landing on 15.38% where the published figure is 17.5%. Close,
plausible, wrong. And matching a blueprint title to a published one has to take
the *longest* match, as `exam_catalog` already does for certification names:
"Hardware" is a substring of "Hardware and Network Troubleshooting", so
first-match wrote A+ domain 5 the weight of domain 3.

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

**An imported paper is an exam, and only an exam.** Importing a PDF always
wrote real `practice_exams` and `practice_questions` rows — and then wrote every
question a second time into `imported_practice_questions`, which three readers
used: the imported-sets card, the past-paper mix in generation, and the exam
length fallback. Two shapes for one idea. The duplicate is gone; what it held
that the exam row didn't — source file name, favourite flag, batch id — moved
onto `practice_exams`, because those are properties of a paper. The old table is
kept empty and unread until a later migration drops it, so a missed reader is
recoverable rather than fatal.

**A domain holds as many of each thing as were asked for.** The Classroom drew
one lecture, one deck, one quiz and one pool of practice questions per domain,
and three places enforced that independently: generation reused or overwrote by
`(domain, voice, length)`, the studio grouping kept one of each, and
`groupByDomain` discarded the rest after picking a winner. A ten-minute lecture
is an introduction and the second one is the next part of the subject, not a
correction of the first — practice exams already accumulated and nothing made
the other four different. Every type is a list now, and every count is
`list.length`, so a row claiming three that opens to two is not reachable.

Decks are keyed on `(domain, deck_title)`, so a domain can hold several;
practice questions stay one pool because they have no title to tell two apart.
Two batches can land on the same generated deck title, which would read as one
deck of forty rather than two of twenty, so the title is made unique at insert —
a suffix rather than a refusal, since the name the model chose is still the best
description of the cards. Generation reuses only something *still being
written*, which stops a double tap costing two lectures without ever handing
back a finished one in place of the new one that was asked for.

**Removing study material is not deleting it.** `qa_sessions.lecture_id` and
`lecture_qa.lecture_id` both cascade, so deleting a lecture took every question
the learner asked during it, and the Q&A container mirrors those rows, so its
entries went too. `review_later` and `study_attempts` are polymorphic with no
foreign key at all, so a delete left them pointing at nothing — worse than
either outcome. `deleted_at` on `lectures`, `quizzes`, `flashcards` and
`practice_questions`, filtered out of every *listing* read, is the whole
mechanism; `services/removal.py` is the one place that knows it.

Only the listings, deliberately. A removed quiz's score still counts towards the
domain's strength, because the learner really did sit it, and a strength that
moved when somebody tidied their Classroom would be measuring housekeeping.
Review flags stay pointing at their questions — that is what marking rather than
deleting is *for*. Fetching one by id still works, because a Q&A entry names the
lecture it came from.

The narrated audio is deleted anyway: it is the expensive part, it regenerates,
and nothing is keyed to it — what the Q&A history records is the exchange, not
the recording of it. `audio_chunks` is emptied with it so nothing later reads a
storage path that no longer resolves. Every path keeps the old delete behind
`removal.supported()`, so a deployment without the column does what it did
before rather than offering a button that silently does nothing.

**A source is filed under exactly one domain.** The primary. A lecture that
touches four topics is *about* one of them, and spreading it across all four
would report coverage in three domains it only mentions — the same mistake
`coverage`'s aggregator exists to avoid one level up. The confidence is recorded
on the row and never surfaced: where the fit is poor the model still picks the
best one, and a later pass revisits the weak ones. Asking a learner to file
their own material costs the whole point of the feature; a wrong assignment
costs a video under the wrong heading.

**Pasting a YouTube link is the primary door, not search.** A transcript needs
only a video id, so pasting works with no API key and no quota. Search costs a
hundred quota units against a free tier that allows about a hundred a day across
every learner — so it is the convenience, and the app degrades to paste-only
rather than breaking. The one asymmetry: a pasted *video* works keyless, a
pasted *playlist* does not, because listing it goes through the Data API.

**A playlist grows its own job.** Its first item is the listing, which appends a
child item per video to the job it is already part of. A playlist's length isn't
knowable until it has been listed, and the queue would rather grow than hold
three hundred videos in memory to enqueue at once.

**One import is one rebuild.** A batch of twenty pasted sources must
re-derive the blueprint once, not twenty times — it costs a Gemini call and
rewrites every domain. So the worker gained a *finaliser*: a hook that runs once
after the last item of a job. It fires only when something landed, and only when
what landed was source text, since a flashcard deck is its own locked domain and
a pasted paper is an exam, and the domain map is derived from neither.

**A parser converts; it never invents.** Every incoming format — a Quizlet
export, a caption file, a block of exam questions — becomes the same two records
at the `ingest` boundary, so nothing downstream learns where material came from.
The rule that keeps it honest is `Question.usable`: a prompt with no options, or
no answer, or an answer pointing outside its own options is not a question. A
list of terms and definitions labelled "Practice Exam" cannot be made into one,
because the options were never there — so it is kept as reference text with a
note saying exactly that. A half-built paper the learner can sit and cannot pass
is worse than no paper.

The learner's label decides where material is filed; detection only pre-selects
the pill and never overrides them.

**Nothing is queued before the learner has seen what it is.** Pasting a link
used to start the import on the spot, so the first time anyone discovered they
had the wrong playlist — or that ninety-seven videos were about to be filed
under one guessed domain — was after it had been read. A transcript is cheap to
fetch and expensive to unpick from a module. `POST /import/youtube/preview`
identifies the link, lists a playlist, and suggests a domain from title overlap
alone, all without writing anything; the learner confirms or corrects, and only
then is a job created. The confirmed domain rides on the job and overrules the
per-video assignment, because one playlist is one subject and re-deciding it
per video lets a course scatter across four domains.

**Deleting sources rebuilds the plan on a deadline, not on a delete.** Removing
four videos should cost one rebuild, and the three intermediate blueprints would
each briefly *be* the module's study plan. `modules.rebuild_after` is a deadline
every deletion pushes out; the worker's housekeeping rebuilds whatever is due.
The debounce is a consequence of the shape rather than a mechanism — nothing to
cancel, nothing lost to a redeploy. That rebuild passes `settle_weights=False`:
deleting a video cannot change what a vendor publishes, and leaning on the
freeze would still let a provisional module have its even split recomputed over
a different number of domains, which is a weight change caused by a deletion.

**A playlist is one row in the Sources tab too.** One import landed ninety-seven
`user_files` rows and buried every PDF the learner had uploaded. `group_title`
alongside the existing `import_batch_id` is the whole fix: the batch is the key,
the title is what the pill is called, and its absence means draw this one on its
own. Collapsed by default here and expanded by default on the import screen —
opposite defaults for opposite reasons, since one screen is for watching
progress and the other is for everything else in the list.

**A playlist is one thing on screen, however many rows the queue holds.** The
queue models it as one listing item plus a sibling per video, which is right for
claiming and wrong for reading: twenty-two equal rows, the first of them "Found
21 videos". `lib/imports.js` regroups them under the playlist, six rows visible,
scrolled to whichever video is being read. Expanded from the start, because the
reason to watch an import is to see where it has got to.

Time remaining is derived from the job's own throughput rather than a per-video
constant, measured from `claimed_at` rather than `created_at` — time spent
queued behind another import wasn't spent on videos, and counting it would make
every estimate grow with the length of the queue. Under two finished items it
says nothing: one item is a sample, not a rate, and a figure that appears
instantly and then triples is worse than no figure.

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

**Where a job runs is decided at claim time, not by who has a handler.**
YouTube refuses transcripts to datacentre IPs, so they are fetched by a worker
on a residential machine while everything else stays on Railway — the same
`worker.py`, with `WORKER_KINDS` naming what it may take. Not a second program:
resume, checkpoints, heartbeat reclaim and `Retry Failed` all already work, and
an import queued while that machine is off simply waits.

The filter had to go into `claim_job` rather than the handler registry, because
a worker that claims a job it cannot handle does not put it back — it fails the
job outright, deliberately, since an unknown kind is normally a deploy problem.
So "not my kind" has to mean "never claimed". `claim_job`'s two-argument form is
dropped rather than left beside the three-argument one: Postgres keeps both as
overloads and PostgREST then cannot resolve which a request meant.

A worker whose database lacks the filter falls back to claiming everything —
what it did before — after one warning, so it can deploy ahead of the migration.

**Claiming has to be SQL.** The backend reaches Postgres through PostgREST,
which cannot express `FOR UPDATE SKIP LOCKED`, so `claim_job` and
`claim_job_item` are database functions. Only one worker runs today; they are
written for N because the alternative is finding out under load that a second
worker means rewriting the claim path.

**"Retrying won't help" is a claim about the source, not the attempt.** A
production playlist failed all twenty-one videos in under ten seconds, and two
separate mistakes had to line up for that to be filed the way it was.

`PermanentFailure` lived in `worker.py`, which Railway starts as a script — so
it is `__main__` there, and a handler reaching it through `from worker import
PermanentFailure` imported the same file a second time and got a second class.
The loop's `except PermanentFailure` matched nothing any handler raised, and
every permanent failure was filed as transient. It lives in `services/jobs.py`
now, which both sides import by the same name, so there is one class by
construction. Anything a handler and the loop must agree on belongs in a module
neither of them *is*.

Repairing that alone would have made things worse, which is the more useful
half. `extract_youtube` wrapped captions-disabled, video-gone and IP-blocked in
one `ExtractionError`, and the handler called all of it permanent — so a
corrected class identity would have written off a whole playlist over where the
request happened to come from, with `Retry Failed` refusing to touch it.
`TransientExtractionError` carries the distinction the library already draws out
to the queue boundary, and nothing between them has to care.

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

**A pending seek belongs to the player, not to the load that queued it.**
`loadChunk` defers its seek to `loadedmetadata`, because a fresh `src` puts the
element back to `readyState` 0 and a browser silently ignores `currentTime`
written there. The offset therefore cannot live in that handler's closure: the
learner can scrub while the chunk is still loading, and the handler would then
undo it. It lives in a ref that any handler reads, so the newest wanted position
wins and a seek the element refused lands as soon as it can. Loads carry a token
for the same reason in reverse — `loadedmetadata` fires on the *element*, so a
handler left over from a superseded load would otherwise seek the chunk that
replaced it.

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
- An exception class defined in `worker.py` and imported by its handlers, which
  is two classes when Railway runs the file as a script. Nothing failed loudly;
  the failures were simply all filed under the wrong kind, and the only visible
  symptom was a `failure_kind` column that read `transient` for twenty-one
  videos that had been raised as permanent.
- `loadChunk` reading `chunks` from state in the same tick `setChunks` was
  called, so a freshly opened lecture never got a `src`.
- A seek written to an element still at `readyState` 0 being dropped by the
  browser, and then a `loadedmetadata` handler holding the offset the lecture
  *opened* at putting the element back there — so rewinding a freshly opened
  lecture moved the bar, moved nothing else, and snapped back. Neither half is
  visible in the code alone: one is platform behaviour and the other only bites
  when the two race. Every visible symptom
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
`20260824000000` job queue · `20260825000000` question provenance ·
`20260826000000` retire imported questions ·
`20260827000000` source domain assignment ·
`20260828000000` worker kinds · `20260829000000` frozen exam weights ·
`20260830000000` playlist sources and debounced rebuild ·
`20260831000000` question bank · `20260901000000` qa answer rest ·
`20260902000000` soft delete media

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

The token lives in `backend/.env` as `SUPABASE_ACCESS_TOKEN` (untracked;
documented in `.env.example`). It is rotated periodically, so a failure there
means asking for a new one rather than debugging the request.

Live tables (25): `profiles, modules, domains, lectures, qa_sessions, lecture_qa,
flashcards, quizzes, practice_exams, practice_questions, imported_practice_questions,
exam_concept_cache, review_later, study_attempts, tutor_messages, user_files,
module_access, study_time, dead_link_reports, groups, group_members,
group_shared_domains, group_domain_views, coverage_maps, exam_attempts`

### Known gaps and loose ends

- **`GET /attempts/open` has no consumer.** It's the ready-made feed for a
  "continue where you left off" covering quizzes and exams, not just lectures.
- **A pack over ~3M characters is still truncated** (60 chunks × 50k). It says
  so: `truncated` rides in the map, the verdict is told to mention it, and the
  assessment card prints which tail was left out.
- **YouTube transcripts are fetched locally, not from Railway.** Solved by the
  `WORKER_KINDS` split above; `local-worker/` holds the Windows Task Scheduler
  setup. Proven end to end on 20 Aug 2026 — a queued video was claimed by
  `Macs-Computer`, read, stored and finalised. The original finding: YouTube blocks
  datacentre IPs wholesale, and a hosted worker is exactly that. Measured on
  20 Aug 2026: 0 of 21 videos from the same playlist succeeded from the worker,
  4 of 4 succeeded from a laptop in the same minute, and the library named the
  reason. Nothing in the import chain is at fault — expansion, waves, per-item
  status, the finaliser threshold and `Retry Failed` were all exercised and all
  behaved. It needs a residential or rotating proxy (`youtube-transcript-api`
  takes one directly), or transcripts fetched somewhere that isn't a datacentre.
  Until then the paste door is the working one, and the failures correctly say
  "couldn't reach it" rather than blaming the videos.
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
