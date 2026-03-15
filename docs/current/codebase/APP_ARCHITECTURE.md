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

## Orchestration model

All orchestration is **browser-side and Promise-driven**. The FE triggers
operations, awaits results, and writes them into the persistence layers.
Progress is reported via callbacks (`onProgress?: (p) => void`), not
polling.

This means the app has no server-side state management, no job queues, and
no long-lived server processes. Every server-side call is a stateless
request/response within Vercel's execution limits.

The first exception to this pattern will be MCMC inference (see
`project-bayes/3-compute-and-deployment-architecture.md`), which delegates
long-running computation to an external compute vendor with results
returning via webhook → git commit.
