# DagNet: App Architecture Overview

**Date**: 15-Mar-26
**Purpose**: Concise description of the existing app architecture — how data
flows, where state lives, and what each layer does. Reference doc for
feature design work.

---

## What DagNet is

A browser-based graph editor for conversion funnel modelling. Users build
DAGs (nodes + edges), connect them to live data sources (Amplitude, Google
Sheets), and the app calculates path probabilities, latency distributions,
forecasts, and cohort completeness.

The app is **git-native**: graphs, parameters, node definitions, index
files, and context definitions are YAML files stored in a GitHub repository.
Git is the persistence layer, the collaboration mechanism, and the audit
trail.

---

## Where state lives

### Git / YAML files (source of truth for model state)

Everything the user creates or the system computes about a graph lives in
YAML files committed to a GitHub repo:

- **Graph files** (`graphs/*.yaml`) — nodes, edges, layout, edge
  probabilities (`p.mean`, `p.stdev`), latency params, queries, scenarios
- **Parameter files** (`parameters/*.yaml`) — time-windowed observation
  data (`values[]` with n, k, dates, cohort bounds, per-cohort latency)
- **Node/context definitions** — reusable event definitions, context
  registries
- **Index files** — `nodes-index.yaml`, `parameters-index.yaml` at repo
  root

Git history provides version control, audit trail, and implicit time-series
of any value that changes over time (model params, posterior summaries,
etc.). There is no need to store historical versions of computed values
within a file — git already does this.

### Neon PostgreSQL (time-series evidence store)

The DB exists for one specific purpose: **time-series snapshot data that
requires SQL aggregation**. Parameter files implement "latest wins"
semantics and don't preserve longitudinal history. Analyses that need
multi-day accumulation (conversion lag histograms, calendar-day attribution,
ΔY derivation) require the snapshot DB.

Two tables:
- **`snapshots`** — append-only time-series of conversion observations,
  keyed by `(param_id, core_hash, slice_key, anchor_day, retrieved_at)`
- **`signature_registry`** — canonical signature lookup for hash stability

The DB is not a general-purpose data store. It holds empirical evidence
only — not operational metadata, not run logs, not user state, not computed
results. Computed outputs (analysis results, model fits, posterior
summaries) flow to git/YAML.

See `project-db/completed/00-snapshot-db-design.md` for the full design,
including the FE/BE/DB responsibility split.

### IndexedDB (browser session state)

IDB is the FE's local persistence layer:
- File content cache and dirty-state tracking
- Git SHAs and sync metadata
- Workspace identity (repo, branch)
- Tab state, editor preferences

IDB is the source of truth for dirty files and workspace state during a
session. It syncs bidirectionally with git (via pull/push) and with
in-memory caches (FileRegistry, GraphStore).

### In-memory (session-local, not persisted)

- **FileRegistry** — in-memory cache of open files (Map<fileId, FileEntry>).
  Performance layer, not source of truth. Must sync with IDB.
- **GraphStore** — per-file Zustand stores holding parsed graph state for
  rendering. Fed from FileRegistry.
- **ReactFlow state** — transformed presentation state for the canvas.

---

## Data flow

### Fetch path (external data → files)

```
User triggers fetch
  → FE constructs query from DSL + context + window
  → FE calls Vercel Python API (or direct adapter)
  → API queries Amplitude / Sheets / etc.
  → API returns observations (n, k, dates, latency arrays)
  → FE calls mergeTimeSeriesIntoParameter()
  → FE writes updated parameter YAML to IDB → FileRegistry → GraphStore
  → FE shadow-writes snapshots to DB (fire-and-forget, append-only)
```

The FE is the orchestrator. The Python API is stateless — it executes
queries and returns results. The FE decides what to fetch, where to store
it, and when to sync.

### Analysis path (DB evidence → charts)

```
FE constructs analysis spec (param_id, core_hash, slice_keys, cohort range)
  → FE calls Vercel Python API /api/runner/analyze
  → Python queries snapshot DB, aggregates by slice, derives metrics
  → Returns analysis result (histograms, daily series, model curves)
  → FE renders chart via ECharts builders
```

The FE passes explicit coordinates; Python executes and returns. Python
never parses parameter files or resolves signatures — that's the FE's job.

### Sync path (git ↔ local)

```
Pull: GitHub → gitService → IDB → FileRegistry → GraphStore → UI
Push: IDB dirty files → gitService → GitHub
```

The pull path handles external changes identically regardless of source —
whether a human edited a file, a CI job updated it, or a webhook committed
new data.

---

## Vercel layer

The backend is deployed as Vercel serverless functions:

- **Python** (`api/python-api.py`) — single entry point routing ~20+
  endpoints via query params. Handles snapshot CRUD, analysis runner, stats
  enhancement, lag model fitting. All stateless request/response.
- **TypeScript** (`api/auth-callback.ts`, `api/auth-status.ts`,
  `api/das-proxy.ts`, `api/graph.ts`, `api/init-credentials.ts`) — OAuth
  flows, proxy routes, graph metadata. Mixed runtime auto-detected by
  Vercel.

No server-side job queues, no persistent connections, no background
workers. The FE is the orchestrator for all operations.

---

## CLI layer (headless Node.js)

A second entry point into the same orchestration modules — runs in
Node via `tsx`, no browser required. Lives in `graph-editor/src/cli/`
with wrapper scripts in `graph-ops/scripts/`.

The CLI calls the **same functions** the browser calls — no parallel
reimplementations. `react-hot-toast` imports work in Node (no-op
without DOM). `fake-indexeddb/auto` provides the Dexie shim.
`import.meta.env?.` optional chaining guards the Vite-specific
environment variables.

- **`diskLoader.ts`** — reads graph JSON + YAML files from the data
  repo on disk, seeds `fileRegistry` and `contextRegistry` in memory
  (replacing the IDB/git loading path)
- **`aggregate.ts`** — thin wrapper that calls
  `fetchDataService.fetchItems({ mode: 'from-file' })` — the same
  function the browser's `useDSLReaggregation` hook calls
- **`commands/analyse.ts`** — calls `prepareAnalysisComputeInputs` →
  `runPreparedAnalysis` — the same functions the browser's
  `useCanvasAnalysisCompute` hook calls
- **`bootstrap.ts`** — shared arg parsing, graph loading, registry
  seeding; new commands extend this rather than duplicating setup

E2E parity is verified by a Playwright test
(`e2e/cliParityGraphOverview.spec.ts`) that loads the same graph in
the browser, runs the from-file pipeline, and compares the BE result
field-by-field against the CLI's output.

See `docs/current/project-cli/programme.md` for the full design and
`docs/current/codebase/GRAPH_OPS_TOOLING.md` for the CLI reference.

---

## Orchestration model

All orchestration is **browser-side and Promise-driven** (or
**Node-side** in the CLI). The FE/CLI triggers operations, awaits
results, and writes them into the persistence layers.
Progress is reported via callbacks (`onProgress?: (p) => void`), not
polling.

This means the app has no server-side state management, no job queues, and
no long-lived server processes. Every server-side call is a stateless
request/response within Vercel's execution limits.

The first exception to this pattern is MCMC inference (see
`PYTHON_BACKEND_ARCHITECTURE.md` §Bayesian Computation), which delegates
long-running computation to Modal with results returning via webhook →
atomic git commit.

## Related Docs

**Domain model** (what DagNet models, not how it's built):
- `public/docs/user-guide.md` — Product concepts: nodes, edges, parameters,
  conversion funnels, what-if scenarios
- `public/docs/glossary.md` — Term definitions (node, edge, case, event, path,
  scenario, latency)
- `public/docs/query-expressions.md` — DSL from the user's perspective

**Canonical data schemas** (see `DATA_SOURCES_REFERENCE.md` for full catalogue):
- `public/schemas/conversion-graph-1.1.0.json` — Graph structure (source of
  truth for `lib/graph_types.py` Pydantic models)
- `public/param-schemas/parameter-schema.yaml` — Parameter data model
- `public/schemas/query-dsl-1.1.0.json` — DSL grammar
