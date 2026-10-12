# Campus Signal frontend

React, TypeScript, and Vite dashboard for the Smart Campus Analytics API.

## Local development

```powershell
cd frontend
npm install
Copy-Item .env.example .env.local
# Set VITE_API_URL in .env.local to the Render API origin, without a trailing slash.
npm run dev
```

The client requests the backend's `/filters`, `/overview`, `/trends`, `/students`, `/students/{student_id}`, `/students/{student_id}/intervention`, and `/datasets` endpoints. `dataset_id` returned by CSV upload is sent with subsequent overview and profile requests. The API must allow the frontend origin through CORS.

This prototype has no authentication or authorization. Do not upload identifiable student records or use it for institutional data until access control and secure persistence have been implemented and reviewed.

## Vercel

Import the repository and set **Root Directory** to `frontend`. Vercel detects Vite; the build command is `npm run build` and the output directory is `dist`. Add `VITE_API_URL` under the Vercel project's environment variables before deploying or rebuilding. No rewrite is configured because the Render origin is supplied per deployment through this variable.

On Render, deploy `backend/` as a Python web service and set `FRONTEND_ORIGIN` to this Vercel project's production origin. Keep any `GROQ_API_KEY` only in Render's environment settings; never expose it through a `VITE_*` variable.