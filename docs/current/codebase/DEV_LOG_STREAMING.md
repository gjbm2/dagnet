# Dev log streaming (local development)

Three log streams are captured to JSONL files under `debug/` during local
development so that agents (Claude, Cursor) can read them without inspecting
terminal output.

| Stream | File | Content |
|---|---|---|
| Browser console | `debug/tmp.browser-console.jsonl` | Intercepted `console.*` calls from the browser |
| Session log | `debug/tmp.session-log.jsonl` | Structured operation log (git, data-fetch, etc.) |
| Python server | `debug/tmp.python-server.jsonl` | All Python dev-server stdout/stderr (print, uvicorn access logs, tracebacks) |

Additional diagnostic outputs:
- **Graph snapshots** (per mark): `debug/graph-snapshots/*.json`
- **Diagnostic state dump**: `debug/tmp.diag-state.json`
- **Analysis compute dumps**: `debug/analysis-dumps/*.json`

## Enabling

### Browser console + session log

Opt-in via any of:
- UI toggle in the top-right menu bar (dev builds only)
- `localStorage.setItem('dagnet:console-mirror', '1')` in DevTools
- URL parameter: `?consolemirror` or `?consolemirror=boot`

### Python server log

**Automatic** — no opt-in required. When the dev server runs via
`python dev-server.py`, stdout and stderr are tee'd to the JSONL file.
Terminal output is preserved (it is a tee, not a redirect).

## Marks (segmenting logs for analysis)

Marks create named boundaries across **all three streams** simultaneously.
Place them via:
- UI: mark input + button in the top-right dev controls
- DevTools console: `window.dagnetMark('my-label')`
- With metadata: `window.dagnetMark('my-label', { tab: 'graph-name' })`

When a mark is placed, the Vite middleware propagates it to the Python log
file so that `extract-mark-logs.sh` can window all three streams identically.

## Reading logs: `extract-mark-logs.sh`

```bash
# Extract the LAST mark matching the label (all three streams)
scripts/extract-mark-logs.sh "bug-20"

# Every matching mark, not just the last
scripts/extract-mark-logs.sh "bug-20" --all

# Single-stream extraction
scripts/extract-mark-logs.sh "bug-20" --console-only
scripts/extract-mark-logs.sh "bug-20" --session-only
scripts/extract-mark-logs.sh "bug-20" --python-only

# Trim all streams to last N lines (default 20000), snapping to mark boundary
scripts/extract-mark-logs.sh --trim
scripts/extract-mark-logs.sh --trim 10000
```

## JSONL formats

### Console stream entry
```json
{"kind":"log","ts_ms":1234567890,"level":"log","args":[...],"page":{"href":"..."}}
```

### Session log entry
```json
{"kind":"session","ts_ms":1234567890,"entryId":"log-...","level":"info","category":"git","operation":"GIT_PULL","message":"..."}
```

### Python server entry
```json
{"kind":"py","ts_ms":1234567890,"level":"stdout","message":"[tag] some output"}
```

### Mark entry (in all streams)
Console: `{"kind":"mark","ts_ms":...,"label":"..."}`
Session: `{"kind":"session","ts_ms":...,"operation":"DEV_MARK","message":"..."}`
Python:  `{"kind":"mark","ts_ms":...,"label":"..."}`

## Environment variable overrides

| Variable | Default | Purpose |
|---|---|---|
| `DAGNET_CONSOLE_LOG_PATH` | `debug/tmp.browser-console.jsonl` | Console stream output |
| `DAGNET_SESSION_LOG_PATH` | `debug/tmp.session-log.jsonl` | Session stream output |
| `DAGNET_PYTHON_LOG_PATH` | `debug/tmp.python-server.jsonl` | Python stream output |
| `DAGNET_GRAPH_SNAPSHOT_DIR` | `debug/graph-snapshots/` | Graph snapshot directory |

## Architecture

1. **Python LogTee** (`dev-server.py`): wraps `sys.stdout`/`sys.stderr` to
   tee every line to the JSONL file. Installed before `uvicorn.run()`.
2. **Browser consoleMirrorService** (`src/services/consoleMirrorService.ts`):
   hooks `console.*` methods, batches entries, POSTs to Vite middleware.
3. **Session log mirror** (`src/services/sessionLogMirrorService.ts`):
   subscribes to `sessionLogService`, POSTs new entries to Vite middleware.
4. **Vite middleware** (`vite.config.ts`, `dagnet-console-log-sink` plugin):
   receives POSTed entries, appends to the correct JSONL file. When a mark
   arrives, also writes it to the Python log file for cross-stream windowing.
5. **extract-mark-logs.sh**: queries all three streams by mark label,
   extracts the window from mark to next mark (or EOF).
