# Dev Environment and HMR

How the dev environment works, what reloads automatically, what requires a restart, and how to diagnose code staleness.

## Architecture

DagNet runs a dual-server system orchestrated by tmux (`dev-start.sh`):

1. **Vite** (frontend) on port 5173 — serves React app with HMR
2. **Uvicorn** (Python API) on port 9000 — serves FastAPI with auto-reload

Both run in a tmux session `dagnet` with split panes.

## What reloads automatically

### Frontend (Vite HMR)

Vite watches `src/**/*` and `public/docs/**/*`. Changes to `.ts`, `.tsx`, `.css`, `.js`, `.jsx` files trigger **hot module replacement** — the browser updates without a full page reload, and React Fast Refresh preserves component state where possible.

**HMR handles**:
- Any file in `graph-editor/src/` — components, hooks, services, contexts, types, utils, lib
- Documentation markdown in `public/docs/`

**HMR does NOT handle** (requires Vite restart or browser reload):
- `vite.config.ts` — config changes need server restart
- `tsconfig.json` — TypeScript config changes need server restart
- `.env.local` / `.env` — env vars are baked into the bundle at startup
- `package.json` changes — new dependencies need `npm install` + restart
- Vite plugins or server middleware

### Python (Uvicorn auto-reload)

Uvicorn runs with `reload=True`, watching all `*.py` files. Any change to `lib/*.py` or `dev-server.py` kills and restarts the entire Python process.

**Auto-reload handles**:
- Any `.py` file in `graph-editor/lib/` — API handlers, MSMDC, query DSL, stats, snapshot service
- `dev-server.py` itself

**Auto-reload does NOT handle**:
- `.env.local` changes — env vars read once at startup; change + restart needed
- `requirements-local.txt` — need `pip install -r requirements-local.txt` + restart
- Venv changes

**Note**: Python reload is process-level — 1-2 second window of API unavailability during restart. In-memory state is lost.

## When you actually need to restart

| Change | Frontend | Python |
|--------|----------|--------|
| Edit `.ts/.tsx` in `src/` | HMR (automatic) | n/a |
| Edit `.py` in `lib/` | n/a | Auto-reload (automatic) |
| Edit `vite.config.ts` | **Restart Vite** | n/a |
| Edit `.env.local` | **Restart Vite** (FE vars) | **Restart Python** (BE vars) |
| `npm install` new dep | **Restart Vite** | n/a |
| `pip install` new dep | n/a | **Restart Python** |
| Edit `tsconfig.json` | **Restart Vite** | n/a |

## HMR is almost never the cause of bugs

**Critical guidance for agents**: when debugging unexpected behaviour, **do not blame HMR** unless you have concrete evidence of stale code. HMR failures are rare and have obvious symptoms:

- **HMR failure looks like**: console shows `[vite] hmr update failed`, or a yellow toast appears saying "page reload needed"
- **HMR failure does NOT look like**: incorrect state, wrong data, sync issues, race conditions, stale IDB data

If you suspect stale code:
1. Check the browser console for HMR errors — if none, HMR is fine
2. Check the Vite terminal pane for compilation errors — if none, the code is current
3. If truly suspicious, a hard refresh (`Ctrl+Shift+R`) is definitive — if the bug persists after hard refresh, it's not HMR

**The vast majority of bugs agents attribute to HMR are actually**: sync state races, stale IDB data from a previous session, FileRegistry/GraphStore desync, or incorrect assumptions about the data propagation pipeline.

## Quick staleness diagnostic

Before blaming code staleness, run this diagnostic sequence:

1. **Browser console**: any `[vite] hmr` errors? → if no, code is current
2. **Vite pane**: any red compilation errors? → if no, TypeScript compiled successfully
3. **Python pane**: any reload errors or tracebacks? → if no, Python is current
4. **Hard refresh** (`Ctrl+Shift+R`): does the bug persist? → if yes, it's not staleness
5. **IDB check**: is the file in IDB stale? Open DevTools → Application → IndexedDB → DagNetGraphEditor → files → check the record

If all five pass, the issue is **logic**, not staleness.

## Dev startup sequence

`./dev-start.sh`:

1. Check/install Node (pin to `.nvmrc`, currently 22)
2. `npm install` (or `npm ci` if `--clean`)
3. Create Python venv at `graph-editor/venv`, install `requirements-local.txt`
4. Extract ports from `.env.local` (VITE_PORT=5173, PYTHON_API_PORT=9000)
5. Kill existing `dagnet` tmux session
6. Create new tmux session with two panes:
   - Left: `npm run dev` (Vite on 5173)
   - Right: `python dev-server.py` (Uvicorn on 9000, auto-reload)
7. Attach to session

## Environment variables

**Frontend** (`VITE_*` prefixed): read from `.env.local` at Vite startup, baked into JS bundle via `define` block. Changes need Vite restart.

**Python** (non-prefixed): read at uvicorn startup. Changes to `.env.local` need Python restart.

Key vars: `VITE_PORT`, `VITE_DEV_MODE`, `VITE_PYTHON_API_URL`, `PYTHON_API_PORT`, `DB_CONNECTION`, `BAYES_WEBHOOK_SECRET`.

## Debug log streaming

Dev-only feature (configured in `vite.config.ts` server middleware):

| Stream | File | Endpoint |
|--------|------|----------|
| Browser console | `debug/tmp.browser-console.jsonl` | `POST /__dagnet/console-log` |
| Session log | `debug/tmp.session-log.jsonl` | `POST /__dagnet/console-log` |
| Python server | `debug/tmp.python-server.jsonl` | Piped via `jsonl-tee.py` |
| Graph snapshots | `debug/graph-snapshots/*.json` | `POST /__dagnet/graph-snapshot` |

Extraction: `scripts/extract-mark-logs.sh "label"` — see DEV_LOG_STREAMING.md.

## Tmux shortcuts

| Shortcut | Action |
|----------|--------|
| `Ctrl+B R` | Restart both servers |
| `Ctrl+B K` | Kill both servers |
| `Ctrl+B ←/→` | Switch panes |
| `Ctrl+B d` | Detach (session keeps running) |
| `tmux attach -t dagnet:dev` | Reattach |

## E2E vs dev servers

- **Dev**: `npm run dev` → port 5173
- **E2E**: `npm run dev:e2e` → port 4173 (strict port, 127.0.0.1 only)

Python CORS config auto-detects both ports.
