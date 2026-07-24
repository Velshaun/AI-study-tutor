# AI Study Tutor

A mobile-first PWA for interactive AI lectures and study tools — think Notebook LM,
but the material is turned into playable lessons, flashcards, quizzes, and timed
practice exams you can study solo or in groups.

- **Backend:** FastAPI (Python) + Supabase + Gemini/OpenAI
- **Frontend:** React + Vite + Tailwind CSS (installable PWA)

## Layout

```
ai-study-tutor/
  backend/     FastAPI app — see backend/README.md
  frontend/    React + Vite PWA
```

## Quick start

**Backend**

```bash
cd backend
python -m venv .venv && .venv\Scripts\activate   # Windows
pip install -r requirements.txt
copy .env.example .env
uvicorn app.main:app --reload
```

**Frontend**

```bash
cd frontend
npm install
copy .env.example .env
npm run dev
```

The frontend calls the backend directly at the `VITE_API_URL` set in
`frontend/.env` (default `http://localhost:8000`); CORS on the backend allows the
dev server origin, so both run side by side with no extra config. Routers are
mounted at the top level — `/auth`, `/modules`, `/lectures`, … — with no `/api`
prefix. Open http://localhost:5173; the API docs are at http://localhost:8000/docs.

## Features

| Area           | Backend router            | Frontend page        |
| -------------- | ------------------------- | -------------------- |
| Auth           | `routers/auth.py`         | (Supabase client)    |
| Modules        | `routers/modules.py`      | `pages/Modules.jsx`  |
| Lectures       | `routers/lectures.py`     | `pages/Lectures.jsx` |
| Flashcards     | `routers/flashcards.py`   | `pages/Flashcards.jsx` |
| Quizzes        | `routers/quizzes.py`      | `pages/Quizzes.jsx`  |
| Practice Exam  | `routers/practice_exam.py`| `pages/PracticeExam.jsx` |
| Groups         | `routers/groups.py`       | `pages/Groups.jsx`   |
| Export         | `routers/export.py`       | (used across pages)  |

## Notes

- Generators ship with deterministic, dependency-free heuristics so every
  endpoint works immediately. Swap in Gemini/OpenAI once keys are set.
- Data is held in-memory per router for now; migrate `_STORE` dicts to Supabase
  tables when the schema lands.
- PWA icons (`pwa-192x192.png`, `pwa-512x512.png`, `apple-touch-icon.png`) should
  be dropped into `frontend/public/`. A vector `favicon.svg` is already included.
```
