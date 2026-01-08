## Cursor console mirroring (dev)

Goal: let Cursor/agent read browser console output **and** the in-app Session Log stream **without copy/paste** by mirroring both into files in the repo.

### Enable

1. Start the Vite dev server as usual.
2. In the browser DevTools console, run:

- **Enable mirroring**:
  - `window.dagnetConsoleMirror.enable()`
- **Disable mirroring**:
  - `window.dagnetConsoleMirror.disable()`

Mirroring persists via localStorage key `dagnet:console-mirror`.

### UI toggle + mark (recommended)

In dev builds there is a toggle + mark input/button in the top-right menu bar (left of the Dagnet brand).
Marks sent there are written to **both** streams.

### Mark actions (for slicing logs)

In DevTools console, before/after each manual action:

- `window.dagnetMark('Add node')`
- `window.dagnetMark('Delete node')`
- `window.dagnetMark('MSMDC regen finished')`

Optional metadata:

- `window.dagnetMark('Click save', { tab: 'graph-gm-rebuild-jan-25' })`

### Output file

By default, logs append (JSON Lines) to:

- **Console stream**: `debug/tmp.browser-console.jsonl`
- **Session log stream**: `debug/tmp.session-log.jsonl`
- **Graph snapshots (per MARK)**: `debug/graph-snapshots/*.json`

Override the output path:

- Console: set env var `DAGNET_CONSOLE_LOG_PATH=/absolute/path/to/file.jsonl` before starting Vite.
- Session log: set env var `DAGNET_SESSION_LOG_PATH=/absolute/path/to/file.jsonl` before starting Vite.
- Graph snapshots: set env var `DAGNET_GRAPH_SNAPSHOT_DIR=/absolute/path/to/dir` before starting Vite.

### Endpoint

The Vite dev server exposes:

- `POST /__dagnet/console-log`

This is **dev-only** (not included in production builds).


