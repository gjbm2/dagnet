# Graph Editor

React + React Flow + Ajv editor for conversion-funnel DAGs.

## Quick start

```bash
npm i
npm run dev
```

Set `VITE_APPS_SCRIPT_URL` in a `.env` file to your Apps Script Web App URL (after you deploy it):

```
VITE_APPS_SCRIPT_URL=https://script.google.com/macros/s/DEPLOYMENT_ID/exec
```

Open `http://localhost:5173/?sheet=<SHEET_ID>&tab=Graphs&row=2` to load from your Sheet.
