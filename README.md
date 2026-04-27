# DagNet — Directed Acyclic Graph Network Editor

**Version 1.6.19b** | [Changelog](graph-editor/public/docs/CHANGELOG.md) | [About](graph-editor/public/docs/about.md)

A web-based visual editor for creating and analysing directed acyclic graphs (DAGs) with conditional probabilities, file-backed parameters, cohort-based analytics, latency-aware forecasting, and snapshot-based time-series storage.

> **New to DagNet?** See [About DagNet](graph-editor/public/docs/about.md) for an overview and the [User Guide](graph-editor/public/docs/user-guide.md) to get started. Full documentation lives in [`graph-editor/public/docs/`](graph-editor/public/docs/).

---

## Quick Start

### 1. Clone and run setup

```bash
git clone https://github.com/gjbm2/dagnet.git
cd dagnet
./setup.sh
```

The interactive setup script walks you through everything:

- **GitHub token** — step-by-step guidance to create one with the right scopes
- **Data repo** — clones the graph/parameter repository locally and configures the app to access it via the GitHub API (verifies you have collaborator access before cloning)
- **Monorepo** (optional) — clones the production web app locally for reference
- **Snapshot database** (optional) — configures a PostgreSQL connection for local snapshot writes
- **Dependencies** — installs Node 22 (via nvm), npm packages, Python venv, and Playwright browsers

The script is idempotent — safe to re-run at any time. On re-run it detects existing configuration, shows what's found, and asks before changing anything. Re-run it to rotate a token, add the database you skipped earlier, etc.

### 2. Start development servers

```bash
./dev-start.sh
```

This starts the frontend and Python API in split tmux panes.

```bash
./dev-start.sh --clean   # Full clean reinstall + start
./dev-stop.sh            # Stop servers
./dev-restart.sh         # Restart servers
```

**Access:**

- Frontend: http://localhost:5173
- Python API: http://localhost:9000
- API docs: http://localhost:9000/docs

### What setup.sh configures

| File | Contents |
|------|----------|
| `graph-editor/.env.local` | GitHub token, data repo owner/name, DB connection string, port defaults |
| `.private-repos.conf` | Local directory names for the two private repos (gitignored) |

**Environment variables (in `.env.local`):**

| Variable | Purpose | Default |
|----------|---------|---------|
| `VITE_GITHUB_TOKEN` | GitHub personal access token | *(prompted by setup)* |
| `VITE_GIT_REPO_OWNER` | Data repo owner (parsed from clone URL) | *(prompted by setup)* |
| `VITE_GIT_REPO_NAME` | Data repo name (parsed from clone URL) | *(prompted by setup)* |
| `DB_CONNECTION` | PostgreSQL connection string for snapshot storage | *(optional)* |
| `VITE_SNAPSHOTS_ENABLED` | Enable snapshot writes | `false` |
| `VITE_GITHUB_OAUTH_CLIENT_ID` | GitHub App client ID for per-user auth | *(see [auth guide](graph-editor/public/docs/deployment-github-auth.md))* |
| `GITHUB_OAUTH_CLIENT_SECRET` | GitHub App client secret (server-side only) | *(see [auth guide](graph-editor/public/docs/deployment-github-auth.md))* |
| `VITE_PORT` | Frontend dev server port | `5173` |
| `PYTHON_API_PORT` | Python backend port | `9000` |
| `VITE_PYTHON_API_URL` | Python backend URL (frontend reads this) | `http://localhost:9000` |
| `VITE_USE_MOCK_COMPUTE` | Set `true` for frontend-only dev (no Python backend) | `false` |

> **Port note:** `PYTHON_API_PORT` controls the backend process; `VITE_PYTHON_API_URL` tells the frontend where to find it. If you change the port, update both.

### Private context repos

The setup script clones two private repos into the workspace root. These are **never** committed to this public repo; they are git-excluded via `.git/info/exclude` and protected by a pre-commit leak guard.

| Config variable | Role | Contains |
|-----------------|------|----------|
| `DATA_REPO_DIR` | "the data repo" | Conversion graphs, event definitions, node/parameter YAML files, and `graph-ops/` (playbooks, validation scripts). This is the same repo DagNet accesses via the GitHub API — cloning it locally enables agentic workflows (direct file editing, commits, playbook execution). |
| `MONOREPO_DIR` | "the monorepo" | The production web application. Used for tracing API endpoints, understanding product behaviour, and verifying data flows. |

**Confidentiality:** The literal directory names are confidential and must never appear in tracked files, commit messages, or documentation. Always refer to them as "the data repo" / "the monorepo" or by their config-variable names.

### Manual setup (without setup.sh)

If you prefer to configure manually:

1. Copy `graph-editor/.env.example` to `graph-editor/.env.local` and fill in values
2. Create `.private-repos.conf` at the repo root with `DATA_REPO_DIR=<name>` and `MONOREPO_DIR=<name>`
3. Clone the private repos and run `bash scripts/setup-workspace.sh`
4. Run `./dev-bootstrap.sh` to install all dependencies (or just `./dev-start.sh` which also installs deps)

---

## Requirements

- **Node.js 22** (pinned in `graph-editor/.nvmrc`; `dev-start.sh` sources nvm automatically)
- **Python 3.9+**
- **tmux** (auto-installed by `dev-start.sh` if missing)
- **GitHub personal access token**

### Manual setup (without tmux)

```bash
# Frontend
cd graph-editor
npm install
npm run dev

# Python API (separate terminal)
cd graph-editor
python3 -m venv venv
source venv/bin/activate
pip install -r requirements.txt
python dev-server.py
```

---

## Features

### Visual Graph Editor

- **Interactive canvas** — drag-and-drop nodes, connect edges, visualise probability flow
- **Multiple views** — graph canvas, raw JSON/YAML, schema-driven forms (Monaco editor for DSL)
- **Copy & paste / drag & drop** from registry files for rapid graph construction
- **Latency beads** — visual indicators showing median lag and cohort completeness on edges

### Latency-Aware Graphs (LAG)

- **Temporal modelling** — edges as time-consuming processes, not just static probabilities
- **Cohort analysis** — `cohort(1-Dec-25:7-Dec-25)` DSL for entry-date windowing
- **Evidence vs forecast** — distinguish observed conversions ($p_{\text{evidence}}$) from projected completions ($p_{\infty}$)
- **Daily time-series** — full `n_daily`, `k_daily` arrays per parameter file
- **On-the-fly aggregation** — select any date range; evidence recalculates instantly

### Probability & Analytics

- **Conditional probabilities** — `visited()`, `exclude()` modifiers per edge
- **What-If analysis** — change any parameter, see downstream impact instantly
- **Scenarios** — save, compare, and overlay parameter configurations with live composition
- **MSMDC engine** — minimal-set-of-maximally-discriminating-constraints for multi-path probability queries (Python / NetworkX)
- **Case variants** — A/B testing with weighted variant splits
- **Bridge view** — attribute reach changes to local probability changes across the graph

### Snapshot Database

- **Automatic persistence** — every data retrieval is stored with retrieval timestamp, cohort anchor, slice context, and conversion counts
- **Time-series analysis** — cohort maturity charting, `asat(...)` historical queries, lag histograms, daily conversions
- **Snapshot Manager** — browse, inspect, diff, download, or delete snapshot data; create equivalence links between old and new signatures
- **Historical file viewing** — open any file as it was at a past git commit

### Data Connections

- **DAS adapters** — Amplitude, Google Sheets, PostgreSQL, and custom HTTP sources with capability detection
- **Contexts** — segment by channel, device, browser, etc. with MECE partition handling
- **Incremental fetch** — only retrieve missing days when expanding windows
- **Query DSL** — `from().to().visited().context().cohort()` chaining
- **Amplitude funnel export** — select nodes, click "Amplitude" in the Analytics panel, and DagNet constructs a correctly specified funnel chart in Amplitude (including event filters, context segments, latency-derived conversion windows, and cohort exclusions). Works with staging and production. Requires the Amplitude Bridge browser extension (`extensions/amplitude-bridge/`, Chrome-family only).

### Sharing & Dashboarding

- **Live share links** — small URLs; content pulled from repo/branch/graph identity on open
- **Static share links** — self-contained snapshots embedded in the URL
- **Multi-tab bundles** — share a dashboard containing multiple tabs from a single `share=` payload
- **Scenario integrity** — scenario names, colours, and visibility modes are carried into shares

### Automation

- **Headless automation mode** — pull latest → retrieve all slices → commit, triggered by `?retrieveall=<graph>` URL parameter
- **Local scheduling** — designed for Windows Task Scheduler or cron; no server-side scheduler needed
- **Daily fetch** — `dailyFetch: true` on a graph enables automatic snapshot accumulation

### CLI (Headless Node.js)

- **Param pack extraction** — produce a param pack for any graph + query DSL from the command line, using the same computation the browser uses
- **Cache-first** — reads from parameter files on disk (populated by prior browser fetches), no browser required
- **Full LAG pipeline** — aggregation, evidence/forecast scalars, completeness, blended probabilities, t95/path_t95
- **Scalar extraction** — `--get "e.edge-id.p.mean"` returns a single bare value for scripting
- **Multiple formats** — YAML (default), JSON, CSV output to stdout

```bash
bash graph-ops/scripts/param-pack.sh my-graph "window(-30d:)" --format json
bash graph-ops/scripts/param-pack.sh my-graph "cohort(1-Jan-26:1-Apr-26)" --get "e.my-edge.p.latency.completeness"
```

See [`graph-ops/playbooks/cli-param-pack.md`](graph-ops/playbooks/cli-param-pack.md) for full usage.

---

## Bayes (Remote Compute)

DagNet supports remote Bayesian inference via Modal. The Bayes pipeline submits jobs from the FE, computes posteriors on Modal (or locally), and commits results back to git via a webhook.

### Local development

Two compute modes, toggled via the **L/M** button in the dev menu bar:

| Mode | Compute | Webhook | Tunnel needed? |
|------|---------|---------|----------------|
| **Local** (default) | Python dev server :9000 | Vite middleware :5173 | No |
| **Modal** | Modal (remote) | Vite middleware :5173 via cloudflared tunnel | Auto-managed |

Both modes run the webhook handler locally with full terminal logs. The toggle automatically starts/stops the cloudflared tunnel when switching to Modal mode.

**Additional requirements for Bayes dev:**

| Tool | Install | Purpose |
|------|---------|---------|
| `cloudflared` | `sudo dpkg -i cloudflared-linux-amd64.deb` or `brew install cloudflare/cloudflare/cloudflared` | Tunnel for Modal → local webhook (no account needed) |
| `modal` | `pip install modal && modal token set` | Deploying to Modal (not needed for local-only dev) |

**Bayes env vars (in `.env.local` and Vercel):**

| Variable | Purpose |
|----------|---------|
| `BAYES_MODAL_BASE_URL` | Modal endpoint base (e.g. `https://gjbm2--dagnet-bayes-`). Routes are derived: `{base}submit.modal.run`, `{base}status.modal.run`, `{base}cancel.modal.run` |
| `BAYES_WEBHOOK_SECRET` | AES-GCM key for callback token encryption |
| `BAYES_WEBHOOK_URL` | Production webhook URL (Vercel) |

### Deploying Modal

```bash
./deploy-modal.sh    # Deploys bayes/app.py to Modal
```

This is separate from the Vercel release — only needed when `bayes/` code changes. See [`docs/current/project-bayes/5-local-dev-setup.md`](docs/current/project-bayes/5-local-dev-setup.md) for the full architecture diagram and troubleshooting.

---

## Project Structure

```
dagnet/
├── graph-editor/               # Deployable app (Vercel deployment root)
│   ├── src/                    # React / TypeScript source
│   │   ├── components/         # UI components (~160 .tsx files)
│   │   ├── contexts/           # React contexts
│   │   ├── hooks/              # Custom hooks
│   │   ├── services/           # Service layer (48+ modules) — single source of truth for business logic
│   │   ├── cli/                # CLI tools (Node/tsx, headless — param-pack, etc.)
│   │   │   └── commands/       # Command modules (paramPack.ts, etc.)
│   │   ├── lib/                # Client-side libraries (DSL, DAS adapters, graph helpers, share payload)
│   │   │   └── das/            # Data adapter system (Amplitude, Sheets, PostgreSQL, HTTP)
│   │   ├── types/              # TypeScript type definitions
│   │   └── db/                 # IndexedDB (Dexie) schema
│   ├── lib/                    # Python libraries (graph computation, MSMDC, queries)
│   │   ├── algorithms/         # MSMDC algorithms (inclusion-exclusion, graph analysis)
│   │   ├── runner/             # Path runner, cohort maturity, forecasting, lag model fitter
│   │   ├── msmdc.py            # MSMDC query generation
│   │   ├── query_dsl.py        # Query DSL parser
│   │   ├── graph_types.py      # Graph data models (Pydantic)
│   │   ├── graph_select.py     # Graph topology filtering
│   │   ├── snapshot_service.py # Snapshot DB service (Postgres)
│   │   └── stats_enhancement.py
│   ├── api/                    # Vercel serverless functions (TS + Python)
│   ├── server/                 # Dev proxy (GitHub API proxy for local dev)
│   ├── e2e/                    # Playwright end-to-end tests (~20 specs)
│   ├── tests/                  # Python tests
│   ├── public/                 # Static assets
│   │   └── docs/               # User-facing documentation (served in-app)
│   ├── scripts/                # Developer utilities (export-graph-bundle, scheduling, etc.)
│   │   └── scheduling/         # Windows Task Scheduler / cron setup scripts
│   ├── dev-server.py           # Local Python dev server (FastAPI + Uvicorn)
│   ├── requirements.txt        # Python dependencies
│   ├── playwright.config.ts    # E2E test configuration
│   ├── vite.config.ts          # Vite configuration
│   └── .nvmrc                  # Node version pin (22)
├── docs/                       # Technical documentation (developer / architecture)
│   ├── current/                # Active specs and project contexts
│   │   └── project-contexts/   # Current project status and work plans
│   └── archive/                # Historical documentation and completed work
├── param-registry/             # Dev testing: sample graph/parameter files
├── apps-script/                # Google Apps Script integrations
├── bayes/                      # Modal compute worker (Bayesian inference)
│   └── app.py                  # Modal app: /submit, /status endpoints + fit_graph worker
├── graph-ops/                  # Graph operations tooling
│   ├── playbooks/              # Workflow guides (graph creation, validation, CLI usage)
│   └── scripts/                # Bash wrappers (validate-graph, param-pack, status, etc.)
├── scripts/                    # Workspace-level scripts (setup-workspace, extract-mark-logs)
├── deploy-modal.sh             # Deploy bayes/app.py to Modal
├── dev-start.sh                # Quick-start (frontend + backend in tmux)
├── dev-stop.sh                 # Stop all dev servers
└── dev-restart.sh              # Restart dev servers
```

---

## Tech Stack

**Frontend:**

- React 18 + TypeScript
- Vite 5
- ReactFlow (graph visualisation)
- Monaco Editor (query DSL editing)
- Zustand (state management)
- Dexie / IndexedDB (offline-first persistence)
- ECharts (charting — cohort maturity, lag histograms, daily conversions)
- MUI + Radix UI (component primitives)

**Backend:**

- Python 3.9+ (graph computation)
- NetworkX (graph algorithms)
- Pydantic (data models with schema parity to TypeScript)
- FastAPI + Uvicorn (local dev server)
- psycopg2 (PostgreSQL driver for snapshot DB)
- Vercel Serverless Functions (production)

**Testing:**

- Vitest + fake-indexeddb (frontend integration tests)
- Playwright (E2E browser tests)
- pytest (Python tests)

**Deployment:**

- Vercel (CDN + serverless Python + serverless TS)
- Modal (remote Bayesian inference compute)

---

## Architecture

```
Local Development:
┌─────────────────┐         ┌──────────────────┐
│  Vite Frontend  │────────▶│  dev-server.py   │
│  :5173          │  HTTP   │  :9000           │
│  (TypeScript)   │◀────────│  (Python/FastAPI) │
└─────────────────┘         └──────────────────┘
                                     │
                                     ▼
                              ┌─────────────┐
                              │  lib/*.py    │
                              │  (NetworkX,  │
                              │  algorithms, │
                              │  runner,     │
                              │  snapshots)  │
                              └─────────────┘
                                     │
                                     ▼
                              ┌─────────────┐
                              │  PostgreSQL  │
                              │  (Neon)      │
                              │  snapshots   │
                              └─────────────┘

Production (Vercel):
┌─────────────────┐         ┌──────────────────┐
│  Static Assets  │────────▶│  Serverless Fns   │
│  CDN            │  HTTP   │  /api/*.py        │
│  (React build)  │◀────────│  (Python)         │
└─────────────────┘         └──────────────────┘
```

---

## Database Setup (Snapshot Storage)

DagNet stores historical conversion data in PostgreSQL for time-series analysis. This is optional — the app works fully without it.

### Setting up Neon (recommended)

1. Create a free account at [neon.tech](https://neon.tech)
2. Create a new project and database
3. Copy the connection string and add to `.env.local`:

```bash
DB_CONNECTION=postgresql://user:password@host/database?sslmode=require
VITE_SNAPSHOTS_ENABLED=true
```

### Schema

The database uses two tables, created lazily on first use:

**`snapshots`** — time-series conversion data (core table):

```sql
CREATE TABLE IF NOT EXISTS snapshots (
    param_id TEXT NOT NULL,
    core_hash TEXT NOT NULL,
    slice_key TEXT NOT NULL DEFAULT '',
    anchor_day DATE NOT NULL,
    retrieved_at TIMESTAMPTZ NOT NULL,
    A INTEGER,
    X INTEGER NOT NULL,
    Y INTEGER NOT NULL,
    median_lag_days REAL,
    mean_lag_days REAL,
    anchor_median_lag_days REAL,
    anchor_mean_lag_days REAL,
    onset_delta_days REAL,
    PRIMARY KEY (param_id, core_hash, slice_key, anchor_day, retrieved_at)
);
```

**`signature_registry`** — catalogue of known `(param_id, core_hash)` pairs with canonical signature text and inputs. Written during snapshot appends; read for inventory and Snapshot Manager browsing.

Signature equivalence mappings (linking old and new core hashes for data continuity) are stored in a repo-versioned `hash-mappings.json` file, not in the database.

Both tables are created automatically by the backend when first needed — no migration step required.

### Verifying the connection

```bash
curl http://localhost:9000/api/snapshots/health
# {"status": "ok", "database": "connected"}
```

---

## Documentation

### User documentation

**Location:** [`graph-editor/public/docs/`](graph-editor/public/docs/) — accessible in-app and on GitHub.

- [About DagNet](graph-editor/public/docs/about.md) — project overview and independent assessment
- [User Guide](graph-editor/public/docs/user-guide.md) — getting started and core concepts
- [Query Expressions](graph-editor/public/docs/query-expressions.md) — query DSL reference
- [Query Algorithms White Paper](graph-editor/public/docs/query-algorithms-white-paper.md) — MSMDC algorithm
- [Data Connections & Adapters](graph-editor/public/docs/data-connections.md) — connect to external data sources
- [GitHub Authentication Setup](graph-editor/public/docs/deployment-github-auth.md) — per-user OAuth for deployers
- [Contexts](graph-editor/public/docs/contexts.md) — data segmentation by channel, device, browser, etc.
- [What-If Analysis](graph-editor/public/docs/what-ifs-with-conditionals.md) — scenario modelling
- [Scenarios](graph-editor/public/docs/scenarios.md) — parameter overlays and A/B testing
- [LAG Statistics Reference](graph-editor/public/docs/lag-statistics-reference.md) — latency-aware graph statistics
- [Forecasting Settings](graph-editor/public/docs/forecasting-settings.md) — forecasting configuration
- [Automation & Scheduling](graph-editor/public/docs/automation-and-scheduling.md) — headless refreshes and scheduling
- [Keyboard Shortcuts](graph-editor/public/docs/keyboard-shortcuts.md) — productivity tips
- [API Reference](graph-editor/public/docs/api-reference.md) — programmatic access
- [Glossary](graph-editor/public/docs/glossary.md) — terminology
- [CHANGELOG](graph-editor/public/docs/CHANGELOG.md) — release history

### Technical documentation

**Location:** [`docs/`](docs/) — developer and architecture docs.

- [`docs/current/codebase/`](docs/current/codebase/) — **the core conceptual index for the app.** A curated, indexed library of how the app works (~90 docs covering subsystems, data flows, invariants, and known anti-patterns). Start here for any non-trivial codebase work.
  - [`APP_ARCHITECTURE.md`](docs/current/codebase/APP_ARCHITECTURE.md) — app-level overview (data flow, state ownership, orchestration model)
  - [`SYNC_SYSTEM_OVERVIEW.md`](docs/current/codebase/SYNC_SYSTEM_OVERVIEW.md) — 4-layer data model, sync flows, known races
  - [`SERVICE_DIRECTORY.md`](docs/current/codebase/SERVICE_DIRECTORY.md) — lookup table for the service layer (single source of truth for business logic)
  - [`TASK_TYPE_READING_GUIDE.md`](docs/current/codebase/TASK_TYPE_READING_GUIDE.md) — which docs to read for a given task type
  - [`KNOWN_ANTI_PATTERNS.md`](docs/current/codebase/KNOWN_ANTI_PATTERNS.md) — recurring failure signatures
  - [`GLOSSARY.md`](docs/current/codebase/GLOSSARY.md) and [`RESERVED_QUERY_TERMS_GLOSSARY.md`](docs/current/codebase/RESERVED_QUERY_TERMS_GLOSSARY.md) — terminology
- `docs/current/` — active technical specs and architecture decisions
- `docs/current/project-contexts/` — current project status and work plans
- `docs/archive/` — historical documentation (useful for understanding past design decisions)

---

## Testing

```bash
# Frontend (Vitest) — specific files only
cd graph-editor
npm test -- --run src/services/__tests__/yourFile.test.ts

# Python
cd graph-editor
source venv/bin/activate
pytest tests/ -v

# E2E (Playwright) — specific spec
cd graph-editor
npx playwright test e2e/yourSpec.spec.ts

# Python coverage
pytest tests/ --cov=lib --cov-report=html
```

### Hot reload

- **Frontend**: Vite HMR (instant updates)
- **Python**: Uvicorn auto-reload (restarts on file change)

---

## Troubleshooting

### Port already in use

```bash
# Find what's using the port
lsof -i :5173
lsof -i :9000

# Kill if needed
kill -9 <PID>

# Or use the stop script
./dev-stop.sh
```

To change ports, edit `graph-editor/.env.local`:

```bash
VITE_PORT=5174
PYTHON_API_PORT=9001
VITE_PYTHON_API_URL=http://localhost:9001
```

### Python server not starting

```bash
python3 --version          # Ensure 3.9+
cd graph-editor
source venv/bin/activate
pip install -r requirements.txt
python dev-server.py
```

### Frontend tests skipping

Some tests require the Python backend. Start it first with `python dev-server.py`, then re-run tests.

### Mock mode (frontend-only development)

```bash
# In graph-editor/.env.local
VITE_USE_MOCK_COMPUTE=true
```

---

## Contributing

1. Check `docs/current/project-contexts/` for current priorities
2. Write tests for new features (prefer integration tests over unit tests)
3. Ensure both frontend and Python tests pass
4. Update `graph-editor/public/docs/` if user-facing behaviour changes

## Licence

MIT
