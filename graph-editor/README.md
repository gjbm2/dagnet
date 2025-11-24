# DagNet Graph Editor

This directory contains the **deployable app** that is built and deployed to Vercel.

- **Deploy root**: `graph-editor/`
- **Frontend**: React + TypeScript + React Flow
- **Backend (Python)**: FastAPI + NetworkX, packaged under `lib/` and exposed via `/api/*` routes

## Local development

For full setup (Node, Python API, env vars, tmux scripts, and docs), see the root [`README.md`](../README.md).

Basic frontend-only dev:

```bash
cd graph-editor
npm install
npm run dev
```

## Google Sheets / Apps Script (optional)

Some flows can still load graphs from Google Sheets via an Apps Script Web App.

1. Set `VITE_APPS_SCRIPT_URL` in `.env.local`:

   ```bash
   VITE_APPS_SCRIPT_URL=https://script.google.com/macros/s/DEPLOYMENT_ID/exec
   ```

2. Open:

   `http://localhost:5173/?sheet=<SHEET_ID>&tab=Graphs&row=2`

   to load from your Sheet.

## Documentation

User-facing docs (including the changelog) live under:

- `graph-editor/public/docs/`

See the root [`README.md`](../README.md#documentation) for an index of public and technical documentation.
