# AI Study Tutor — Backend

FastAPI service for interactive AI lectures, flashcards, quizzes, practice exams,
study groups, and exports.

## Setup

```bash
cd backend
python -m venv .venv
# Windows: .venv\Scripts\activate    macOS/Linux: source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env   # then fill in your keys
```

## Run

```bash
uvicorn app.main:app --reload
```

- API root: http://localhost:8000/
- Interactive docs: http://localhost:8000/docs
- Health: http://localhost:8000/health

## Structure

```
app/
  main.py        FastAPI app, CORS, router wiring
  config.py      env-var settings (python-dotenv)
  routers/
    auth.py           Supabase-backed auth (signup/login/me)
    modules.py        study modules (containers)
    lectures.py       lecture generation + PDF/YouTube extraction
    flashcards.py     cards + SM-2-lite spaced repetition
    quizzes.py        MCQs + server-side grading
    practice_exam.py  timed mixed-format exams
    groups.py         study groups + invites + sharing
    export.py         CSV / JSON / Markdown export
```

> The generators (lectures/flashcards/quizzes) ship with deterministic,
> dependency-free heuristics so every endpoint works out of the box. Wire in
> Gemini/OpenAI by replacing the `_segment_text` / `generate_*` helpers once
> your API keys are set in `.env`.
