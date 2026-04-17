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

## Server freshness verification (MANDATORY before blaming staleness)

Both dev servers expose a `/__dagnet/server-info` endpoint that returns the process boot timestamp and PID. A wrapper script compares file mtimes to server boot times to give a definitive FRESH/STALE verdict.

### The script

```
scripts/dev-server-check.sh [file ...]
```

**With file args** — checks whether each file's mtime is older than the relevant server's boot time:

```
$ scripts/dev-server-check.sh graph-editor/lib/runner.py
FRESH: graph-editor/lib/runner.py — python server reloaded 1.2s after save

All checked files are live. If the bug persists, it is in your code.
```

```
$ scripts/dev-server-check.sh graph-editor/lib/runner.py
STALE: graph-editor/lib/runner.py — python server boot is 3.1s BEFORE file save
       Server has not reloaded. Check for syntax errors in the python terminal pane.
```

**Without args** — reports both servers' status:

```
$ scripts/dev-server-check.sh
=== Dev Server Status ===

Vite:   PID=12345  boot=1713400000.0  age=42s  (port 5173)
Python: PID=12346  boot=1713400002.0  age=40s  (port 9000)
```

Exit codes: `0` = fresh, `1` = stale after retries, `2` = server unreachable.

The script auto-detects which server to check based on file extension (`.py` → Python, `.ts/.tsx/.js/.jsx/.css` → Vite). For Python, it retries for up to 5 seconds since uvicorn reload takes 1-2s.

### The endpoints

| Server | URL | Returns |
|--------|-----|---------|
| Vite | `http://localhost:5173/__dagnet/server-info` | `{"boot_epoch": N, "pid": N, "server": "vite"}` |
| Python | `http://localhost:9000/__dagnet/server-info` | `{"boot_epoch": N, "pid": N, "server": "python"}` |

- **Vite**: `boot_epoch` is set when the Vite dev server plugin loads. HMR updates do not change it (they don't need to — HMR is near-instant and in-browser). A changed `boot_epoch` means Vite was restarted.
- **Python**: `boot_epoch` is set at module level (`_BOOT_EPOCH = time.time()`). Since uvicorn `reload=True` kills and restarts the process, every reload produces a new `boot_epoch`.

### Agent rules (HARD BLOCK)

1. **NEVER say "the server may not have restarted"** without first running `scripts/dev-server-check.sh <file>`.
2. If the script says **FRESH** → the problem is your code. Investigate logic, not infrastructure.
3. If the script says **STALE** → check the server terminal pane for syntax/import errors that blocked the reload. Fix the error and re-run the check.
4. If the script says **UNREACHABLE** → the server isn't running. Start it with `./dev-start.sh`.

### What staleness actually looks like

HMR failures are rare and have obvious symptoms:
- **HMR failure**: console shows `[vite] hmr update failed`, or a yellow toast appears saying "page reload needed"
- **Python reload failure**: traceback in the Python terminal pane, or uvicorn exits

**The vast majority of bugs agents attribute to staleness are actually**: sync state races, stale IDB data from a previous session, FileRegistry/GraphStore desync, or incorrect assumptions about the data propagation pipeline.

### Manual diagnostic (fallback)

If the script is unavailable, this manual sequence still works:

1. **Browser console**: any `[vite] hmr` errors? → if no, frontend code is current
2. **Vite pane**: any red compilation errors? → if no, TypeScript compiled successfully
3. **Python pane**: any reload errors or tracebacks? → if no, Python is current
4. **Hard refresh** (`Ctrl+Shift+R`): does the bug persist? → if yes, it's not staleness

## Dev startup sequence

`./dev-start.sh`:

1. Check/install Node (pin to `.nvmrc`, currently 22)
2. `npm install` (or `npm ci` if `--clean`)
3. Create Python venv at `graph-editor/venv`, install `requirements-local.txt` + `bayes/requirements.txt`
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
