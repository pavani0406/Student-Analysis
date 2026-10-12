# Smart Campus Analytics

Campus Signal is a student-success analytics prototype: a React dashboard on Vercel, a FastAPI service on Render, and an optional Groq-powered intervention plan. The root `student_success_app.py` remains available as a standalone Streamlit prototype; the web dashboard uses the `frontend/` and `backend/` applications.

## Local development

Start the API in one terminal:
```powershell
cd backend
python -m venv .venv
.venv\Scripts\Activate.ps1
pip install -r requirements.txt
uvicorn main:app --reload
```

Start the dashboard in another terminal:
```powershell
cd frontend
npm install
Copy-Item .env.example .env.local
# Set VITE_API_URL=http://localhost:8000 in .env.local
npm run dev
```

The API serves synthetic demo data by default. CSV uploads are validated, scored, and kept in process memory under an isolated dataset ID; they are lost when the Render process restarts and are not shared between instances.

## Deploy

1. Push the repository to GitHub.
2. Create a Render Web Service with root directory `backend`, build command `pip install -r requirements.txt`, and start command `uvicorn main:app --host 0.0.0.0 --port $PORT` (the included `Procfile` provides this command). Set `FRONTEND_ORIGIN` to the exact Vercel production origin. Optionally set `GROQ_API_KEY` and `GROQ_MODEL` in Render's environment settings.
3. Create a Vercel project for the same repository with root directory `frontend`. Use `npm run build` and output directory `dist`. Set `VITE_API_URL` to the Render service origin, without a trailing slash.
4. Deploy the frontend, then update Render's `FRONTEND_ORIGIN` with the production Vercel URL and redeploy/restart the API.

Check `https://<render-service>.onrender.com/health` before connecting Vercel. The frontend calls the API directly; no Vercel rewrite is needed. See [frontend/README.md](frontend/README.md) and [backend/README.md](backend/README.md) for details.

## Student data and security

Authentication and authorization are not implemented. Treat this as a demo: use synthetic, anonymized, or otherwise non-identifiable test data only. Do not upload real student records or expose this API to institutional data until authentication, authorization, secure persistence, retention rules, and institutional privacy review are in place. Uploaded datasets are currently held in process memory.

The Groq key is optional, is read only by the backend, and must be configured as a Render secret. Never put it in `VITE_*` variables, source files, or committed `.env` files. A credential-shaped value was previously present in this repository's source/config; if it was a real credential, revoke it and issue a new key before deployment. The `.env.example` value is only a placeholder.

## Student Success Score

Each indicator is normalized to `[0, 1]` using its documented range (backlogs are inverted), weighted inside its pillar, then combined using the pillar weights below. Pillar weights are normalized to sum to 100.

| Pillar (weight) | Indicators (share inside pillar) |
|---|---|
| Academic (30) | CGPA 45%, internal marks 35%, backlogs 20% |
| Attendance (15) | Overall attendance 100% |
| LMS (12) | Assignment completion 60%, logins/week 40% |
| Engagement (8) | Hackathons 30%, certifications 30%, events 25%, clubs 15% |
| Placement (22) | Coding 40%, aptitude 30%, mock interview 30% |
| Skills (8) | Technical 60%, soft 40% |
| Feedback (5) | Student satisfaction 50%, faculty feedback 50% |

Academic risk is flagged for attendance `<70%`, CGPA `<5.5`, backlogs `>=3`, assignment completion `<45%`, or Academic Index `<45`. Placement risk is flagged for Placement Index `<35`, coding `<30`, aptitude `<35`, or mock interview `<35`. High risk means both flags or score `<40`; one flag is Medium, otherwise Low. Four student segments use cohort medians of academic and placement indices. These rules are transparent screening signals, not validated predictions or a substitute for faculty judgment.

## Checks

```powershell
python -m pip install -r backend/requirements-dev.txt
python -m pytest backend/tests -q
```

The frontend production build is `npm run build` from `frontend/`.

## Student Profile
The dashboard includes a Student Profile tab showing Student ID, student name/profile label, department, year, risk level, segment, success score, risk reasons, and a downloadable individual profile CSV. Sample names are placeholders (e.g. Student 0001); upload your own CSV to use your institution's student data.

## Student Success Score (0-100)
Each indicator is min-max normalised to 0-1 (backlogs inverted), averaged inside its pillar,
then pillars are combined with weights (adjustable live in the sidebar).

| Pillar (weight) | Indicators (share inside pillar) |
|---|---|
| Academic (30) | CGPA 45%, internal marks 35%, backlogs 20% |
| Attendance (15) | Overall attendance 100% |
| LMS (12) | Assignment completion 60%, logins/week 40% |
| Engagement (8) | Hackathons 30%, certifications 30%, events 25%, clubs 15% |
| Placement (22) | Coding 40%, aptitude 30%, mock interview 30% |
| Skills (8) | Technical 60%, soft 40% |
| Feedback (5) | Student satisfaction 50%, faculty feedback 50% |

`Score = sum(normalised indicator x indicator share x pillar weight) x 100`

Two sub-indices support the risk logic and segmentation:
- **Academic Index** = Academic + Attendance + LMS pillars
- **Placement Index** = Placement + Skills + Engagement pillars

## Risk flags (rule-based, fully transparent)
- **Academic risk** if any: attendance < 70%, CGPA < 5.5, backlogs >= 3, assignment completion < 45%, Academic Index < 45
- **Placement risk** if any: Placement Index < 35, coding < 30, aptitude < 35, mock interview < 35
- **Risk level**: High = both flags or score < 40; Medium = one flag; Low = none
- Each flag lists the exact triggering reasons per student.

## Explainability
For every student, each indicator's contribution is compared with the cohort average;
the Student 360 view shows the 5 biggest drags and 5 biggest boosts (points vs cohort),
a pillar radar vs cohort, and interventions for the two weakest pillars.

## Segments (cut-offs at cohort medians)
Star Performers · Academic Strong, Placement Gap · Practical Achievers (placement-ready, academically weak) · Needs Holistic Support

## AI Advisor (LLM) - (in-file)
- **Personalised intervention plan:** the student's score, risk reasons and top drags/strengths vs cohort are sent to an LLM (Groq, `llama-3.3-70b-versatile` by default). It returns a summary, root causes, a 30-day action plan and a supportive message for the student.
- **Ask the data:** chat over an aggregated cohort summary (departments, years, segments, drivers, lowest scorers). Answers are limited to that summary.
- **Guardrails:** the prompt forbids inventing facts; only student ID and numeric indicators are sent (no names/contacts); falls back to a rule-based plan if there is no key or the call fails.
- **Setup:** set `GROQ_API_KEY` (env var, `.streamlit/secrets.toml`, or the sidebar box). On Streamlit Cloud add it under App settings -> Secrets: `GROQ_API_KEY = "gsk_..."`.

## API key safety
- Never hard-code the key or commit it. `.gitignore` already excludes `.env` and `.streamlit/secrets.toml`; only `.env.example` (placeholder) goes to GitHub.
- On Streamlit Cloud, put the key in App settings -> Secrets.
- If a key is ever pushed to GitHub, revoke it in the Groq console and create a new one.

## Suggested demo flow (3 min)
1. Overview: KPIs, score distribution, risk by department, attendance trend by risk level
2. Watchlist: filter High risk, download CSV
3. Student 360: pick a high-risk student, show "why" chart + interventions
4. Segments: academic vs placement scatter, segment actions
5. Insights + what-if weight sliders
6. AI Advisor: generate a plan for the high-risk student, then ask which department needs attention first
