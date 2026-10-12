# Smart Campus Analytics API

Standalone FastAPI backend for the root Streamlit application's student-success model. The API uses a deterministic 600-student synthetic dataset unless a request specifies an uploaded `dataset_id`.

## Run and deploy

From `backend/`:

```powershell
python -m venv .venv
.venv\Scripts\Activate.ps1
pip install -r requirements.txt
uvicorn main:app --reload
```

For Render, configure the service root directory as `backend`, use `pip install -r requirements.txt` as the build command, and use the included `Procfile` start command. Set `FRONTEND_ORIGIN` to the exact frontend origin (or a comma-separated allowlist). It defaults to `*` for local development; credentials are not enabled for CORS.

`GROQ_API_KEY` is optional and is read only by the backend for `POST /students/{student_id}/intervention`. `GROQ_MODEL` optionally selects a Groq model. Without a key, or if the provider call fails, the endpoint returns a deterministic rule-based plan. Never put the key in frontend code or return it from an API.

Uploads are held in process memory under random UUIDs. They do not replace or mutate the synthetic dataset. Uploaded IDs are isolated within the serving process and are lost on restart; for multiple Render instances/workers, use a shared persistent store before relying on uploads across instances.

## Scoring contract

All indicators are normalized to `[0, 1]` using their source-app bounds and clipped to that interval. Backlogs are inverted. Indicator shares within pillars and default pillar weights match `student_success_app.py`; pillar weights are renormalized to sum to 100. The success score is the weighted sum of pillar scores. The Academic Index is the weighted mean of Academic, Attendance, and LMS pillars; the Placement Index is the weighted mean of Placement, Skills, and Engagement pillars.

Academic risk reasons trigger for attendance `< 70`, CGPA `< 5.5`, backlogs `>= 3`, assignment completion `< 45`, or Academic Index `< 45`. Placement risk reasons trigger for Placement Index `< 35`, coding `< 30`, aptitude `< 35`, or mock interview `< 35`. High risk means both risk flags or Success Score `< 40`; one flag is Medium, otherwise Low. Four segments use the dataset's academic and placement index medians, as in the source app. Cohort driver gaps are each student's weighted score-point contribution minus the dataset mean contribution.

CSV uploads require `student_id`, `department`, `year`, and all 17 indicator columns listed here. `student_name` is optional. IDs must be unique; year must be an integer from 1 through 4; each indicator must be finite and within the source model's range. The upload limit is 10 MiB and 10,000 rows. Additional columns are preserved in the raw data but not exposed in profile scoring.

## JSON contract

All successful responses are JSON. Query filters are repeatable parameters: `department`, `year`, `risk` (`High`, `Medium`, `Low`), and `segment` (one of the four exact segment names). `dataset_id` defaults to `synthetic`. Error responses use `{"error":{"code":"...","message":"...","issues":[]}}`; `issues` is included when relevant.

- `GET /health` -> `{"status":"ok","service":"smart-campus-analytics-api"}`.
- `GET /filters?dataset_id=...` -> `dataset_id`, sorted `departments`, integer `years`, and available `risks` and `segments`.
- `GET /overview?...filters` -> `dataset_id`, echoed `filters`, filtered student count, average score, high/academic/placement risk rates (0-1), risk/segment/department counts, and average pillar scores.
- `GET /trends?...filters` -> `dataset_id`, `available`, and `items` with `month`, `risk_level`, `average_attendance`, and `average_lms_logins`. Uploaded datasets return `available:false`, an explanatory `message`, and an empty `items` list because the required CSV has no monthly history.
- `GET /students?...filters&q=&page=1&page_size=50` -> `dataset_id`, paginated `items`, `total`, `page`, and `page_size`. Each item has identity, department/year, score and indices, risk flags, and segment. Search matches ID, name, and department; results sort by lowest score first.
- `GET /students/{student_id}?dataset_id=...` -> `dataset_id`, `student`, `score` (including scale/formula/cohort delta), `risks` (flags and reasons), cohort median `cohort_cuts`, `pillars`, `indicators`, `top_drags`, `top_strengths`, and `suggested_interventions`. Every indicator includes source value, normalized value, effective weight, score contribution, cohort contribution, and cohort gap in points. Pillar entries include score, cohort average/gap, and an intervention.
- `POST /students/{student_id}/intervention?dataset_id=...` -> `student_id`, `source` (`rules` or `groq`), and plain-text `plan`.
- `POST /datasets` with multipart field `file` -> `dataset_id` (UUID), row count, departments, years, and `trends_available:false`. The ID must be supplied to use that uploaded cohort in subsequent endpoints.

## Tests

From the repository root:

```powershell
pip install -r backend/requirements-dev.txt
python -m pytest backend/tests
```