# Project Bayes: Async Roundtrip Infrastructure

**Status**: Draft
**Date**: 16-Mar-26
**Purpose**: Define the infrastructure for asynchronous remote compute — a working
roundtrip from FE submission through compute vendor execution to git-committed
results — with the correct schema in place but no dependency on Bayesian
inference logic.

**Related**: `programme.md` (programme),
`3-compute-and-deployment-architecture.md` (Compute arch),
`../codebase/APP_ARCHITECTURE.md` (app architecture)

---

## Context

Project Bayes has two independent workstreams (see `programme.md`):

- **Semantic foundation**: fix cohort semantics, move model ownership to
  Python, delete FE fitting code. No dependency on remote compute.
- **Async infrastructure** (this doc): submission, webhook, git commit
  plumbing. No dependency on cohort semantics or model ownership.

The two workstreams share no code, no systems, and no sequencing constraints.
When both are done, Bayesian inference plugs real logic into the infrastructure
built here.

This document is self-contained and can be started, implemented, and verified
without reference to the Semantic foundation workstream.

---

## Why this matters

The async roundtrip is the only genuinely new architectural pattern in the app.
Everything today is synchronous request/response (FE → Vercel → response → FE
writes to IDB/git). Remote compute introduces: submit a job, wait, receive
results asynchronously via webhook, commit to git, pull into FE.

Getting a trivial payload through this full circuit proves the infrastructure
works — vendor integration, webhook auth, atomic git commits, FE job tracking,
conflict handling. Once proven, the inference logic has a known-good deployment
target with no infrastructure debugging mixed in.

The schema additions belong here (not deferred to inference work) because:

- The webhook handler needs to know the target YAML field shape to format
  commits.
- The FE needs to be able to read back what was written (even if it doesn't
  yet consume it for display).
- Validation and verification require real schema fields, not ad-hoc JSON
  blobs.

---

## What the roundtrip proves

End state: the user can trigger a fit from the FE. A remote worker runs, reads
from the snapshot DB, and fires a webhook. The webhook handler formats the
result into YAML updates and commits them to the repo. The FE pulls and sees
updated posterior fields on edges. The values are placeholder (e.g. uniform
priors, dummy quality metrics), but the full data path works.

```
FE                     Vercel                    Modal                  GitHub
│                       │                          │                     │
│  (one-time config)    │                          │                     │
├─ GET /api/bayes/     >│                          │                     │
│    config             │                          │                     │
│<── {webhook_url,     ─┤                          │                     │
│     webhook_secret,   │                          │                     │
│     neon_db_url}      │                          │                     │
│                       │                          │                     │
│  encrypt(git_creds,   │                          │                     │
│    webhook_secret)    │                          │                     │
│  → callback_token     │                          │                     │
│                       │                          │                     │
├─ POST /submit ──────────────────────────────────>│ (web endpoint)      │
│  {graph_data,         │                          ├─ spawn worker       │
│   callback_token,     │                          │                     │
│   neon_db_url,        │                          │                     │
│   webhook_url}        │                          │                     │
│<── {job_id} ─────────────────────────────────────┤                     │
│                       │                          │                     │
│                       │                          ├─ connect to Neon DB │
│  (poll loop)          │                          ├─ read evidence      │
├─ GET /status ────────────────────────────────────>│ (web endpoint)     │
│<── {status: running} ────────────────────────────┤  compute            │
│                       │                          │                     │
│                       │<── POST webhook_url ─────┤ (worker)            │
│                       │  callback_token header   ├─ exit               │
│                       │  {posteriors, quality}    │                     │
│                       ├─ decrypt callback_token   │                     │
│                       │  → git creds              │                     │
│                       ├─ format YAML, cascade     │                     │
│                       ├─ atomic commit ──────────────────────────────>│
│                       │  (retry-with-rebase)      │                     │
│                       │                          │                     │
├─ GET /status ────────────────────────────────────>│ (web endpoint)     │
│<── {status: complete} ───────────────────────────┤                     │
│                       │                          │                     │
├─ git pull ───────────────────────────────────────────────────────────>│
│<── updated files ────────────────────────────────────────────────────┤
│                       │                          │                     │
├─ IDB → FileRegistry → GraphStore → UI           │                     │
```

---

## Schema additions

### Design principles

- **Posterior fields sit alongside existing point estimates, not replacing
  them.** `p.mean` and `p.stdev` continue to carry the current best estimate
  (whether moment-based or Bayesian). The `posterior` sub-object carries the
  distributional detail and quality metadata.
- **Provenance is explicit.** A `provenance` field on the posterior
  distinguishes `bayesian`, `pooled-fallback`, `point-estimate`, and `skipped`.
  Consumption code can branch on this.
- **Distribution type is explicit.** The schema records which distribution
  family was fitted (e.g. `beta`, `lognormal`). It is not assumed that all
  edges will always use the same family.
- **fit_history provides trajectory without git archaeology.** The Bayesian
  fitting engine may want to inspect how posteriors have drifted over recent
  weeks as an input to its own calculations. Rather than requiring git log
  parsing, each posterior carries a rolling `fit_history` array of recent
  snapshots. Retention policy (interval and cap) is controlled by forecasting
  settings so it can be tuned per repo.
- **Schema changes are additive.** All new fields are optional. Existing
  graphs without posteriors continue to work unchanged.

### Graph-level run metadata (`_bayes`)

Added to the graph document root. Records metadata about the most recent
Bayesian fitting run for this graph. One block per graph, overwritten each run.

| Field | Type | Description |
|---|---|---|
| `fitted_at` | string | UK date (d-MMM-yy) when the run completed |
| `duration_ms` | number | Wall-clock elapsed time of the fitting run |
| `fingerprint` | string | Deterministic hash of (graph structure + policy + evidence window) |
| `model_version` | number | Schema version for forward-compat (starts at 1) |
| `settings_signature` | string | Hash of the `ForecastingSettings` used for this run |
| `quality.max_rhat` | number | Worst r-hat across all fitted parameters |
| `quality.min_ess` | number | Worst effective sample size across all fitted parameters |
| `quality.converged_pct` | number | Fraction of parameters that met convergence criteria |
| `quality.edges_fitted` | number | How many edges received Bayesian posteriors |
| `quality.edges_skipped` | number | How many edges fell back or were skipped |

Example:

```yaml
_bayes:
  fitted_at: "16-Mar-26"
  duration_ms: 4200
  fingerprint: "abc123..."
  model_version: 1
  settings_signature: "def456..."
  quality:
    max_rhat: 1.02
    min_ess: 450
    converged_pct: 0.95
    edges_fitted: 12
    edges_skipped: 2
```

### Probability posterior (`p.posterior`)

Added to `ProbabilityParam`:

| Field | Type | Description |
|---|---|---|
| `distribution` | string | Distribution family fitted (e.g. `beta`, `dirichlet-component`) |
| `alpha` | number | Beta posterior shape parameter α |
| `beta` | number | Beta posterior shape parameter β |
| `hdi_lower` | number | Lower bound of HDI (at configured level) |
| `hdi_upper` | number | Upper bound of HDI |
| `hdi_level` | number | HDI level used (e.g. 0.9 for 90%) |
| `ess` | number | Effective sample size |
| `rhat` | number | Gelman-Rubin convergence diagnostic |
| `evidence_grade` | number | Evidence degradation level (0=cold start, 1=weak, 2=mature, 3=full Bayesian) |
| `fitted_at` | string | UK date (d-MMM-yy) when posterior was computed |
| `fingerprint` | string | Deterministic hash of (graph structure + policy + evidence window) |
| `provenance` | string | `bayesian` / `pooled-fallback` / `point-estimate` / `skipped` |
| `fit_history` | array | Rolling array of recent posterior snapshots (see fit_history below) |

When a Bayesian posterior is written, `p.mean` and `p.stdev` are updated to
the posterior mean and standard deviation of the Beta(α, β) distribution:
- `p.mean = α / (α + β)`
- `p.stdev = sqrt(αβ / ((α+β)²(α+β+1)))`

This means **zero changes to existing consumption code**. Everything that reads
`p.mean` and `p.stdev` today — confidence intervals, graph rendering, path
calculations — continues to work, now with better estimates.

### Latency posterior (`p.latency.posterior`)

Added to `LatencyConfig`:

| Field | Type | Description |
|---|---|---|
| `distribution` | string | Distribution family fitted (e.g. `lognormal`) |
| `onset_delta_days` | number | Posterior onset (may differ from pre-Bayes value) |
| `mu_mean` | number | Posterior mean of μ parameter |
| `mu_sd` | number | Posterior SD of μ parameter |
| `sigma_mean` | number | Posterior mean of σ parameter |
| `sigma_sd` | number | Posterior SD of σ parameter |
| `hdi_t95_lower` | number | Lower HDI bound for t95 (days) |
| `hdi_t95_upper` | number | Upper HDI bound for t95 (days) |
| `hdi_level` | number | HDI level used |
| `ess` | number | Effective sample size |
| `rhat` | number | Convergence diagnostic |
| `fitted_at` | string | UK date (d-MMM-yy) |
| `fingerprint` | string | Same fingerprint as probability posterior |
| `provenance` | string | Same enum as probability posterior |
| `fit_history` | array | Rolling array of recent posterior snapshots (see fit_history below) |

When a latency posterior is written, `p.latency.mu` and `p.latency.sigma` are
updated to the posterior means, `p.latency.onset_delta_days` to the posterior
onset (respecting `onset_delta_days_overridden`), and `p.latency.t95`
recomputed from the posterior means (respecting `t95_overridden`). Zero
consumption-path changes — existing completeness calculations and t95
derivations use `mu`/`sigma`/`onset_delta_days` directly.

### fit_history: rolling posterior snapshots

Each posterior (probability and latency) carries a `fit_history` array —
a capped, periodically-sampled record of recent fits. This enables the
fitting engine to inspect posterior drift over time without git archaeology.

**Retention policy** is controlled by two forecasting settings (see below):

- `bayes_fit_history_interval_days` (default: 7) — minimum days between
  retained snapshots. The worker runs nightly but only appends to
  `fit_history` if at least this many days have passed since the last entry.
- `bayes_fit_history_max_entries` (default: 12) — maximum entries retained.
  Oldest entries are evicted when the cap is reached. At default settings
  this gives ~3 months of weekly snapshots.

**Probability fit_history entry shape** (deliberately slimmer than the
top-level posterior — key params + convergence only):

| Field | Type | Description |
|---|---|---|
| `fitted_at` | string | UK date |
| `alpha` | number | Beta α at that point |
| `beta` | number | Beta β at that point |
| `hdi_lower` | number | HDI lower bound |
| `hdi_upper` | number | HDI upper bound |
| `rhat` | number | Convergence diagnostic |

**Latency fit_history entry shape**:

| Field | Type | Description |
|---|---|---|
| `fitted_at` | string | UK date |
| `mu_mean` | number | Posterior mean of μ |
| `sigma_mean` | number | Posterior mean of σ |
| `onset_delta_days` | number | Onset at that point |
| `rhat` | number | Convergence diagnostic |

Example (probability):

```yaml
posterior:
  distribution: "beta"
  alpha: 45.2
  beta: 120.8
  hdi_lower: 0.21
  hdi_upper: 0.35
  hdi_level: 0.9
  ess: 1200
  rhat: 1.01
  evidence_grade: 3
  provenance: "bayesian"
  fitted_at: "16-Mar-26"
  fingerprint: "abc123..."
  fit_history:
    - fitted_at: "9-Mar-26"
      alpha: 43.1
      beta: 118.2
      hdi_lower: 0.20
      hdi_upper: 0.36
      rhat: 1.01
    - fitted_at: "2-Mar-26"
      alpha: 40.5
      beta: 115.9
      hdi_lower: 0.19
      hdi_upper: 0.36
      rhat: 1.03
```

### Forecasting settings additions

Two new constants in `graph-editor/src/constants/latency.ts`, added to the
`ForecastingSettings` interface and `buildForecastingSettings()`:

| Constant | Default | Interface field | Description |
|---|---|---|---|
| `BAYES_FIT_HISTORY_INTERVAL_DAYS` | 7 | `bayes_fit_history_interval_days` | Minimum days between retained fit_history entries |
| `BAYES_FIT_HISTORY_MAX_ENTRIES` | 12 | `bayes_fit_history_max_entries` | Maximum fit_history entries per posterior |

Python backend defines matching defaults in its constants module, validated
by the existing cross-language parity test.

### Cascade from parameter file to graph

The posterior sub-object cascades to the graph via the existing isomorphic
cascade module (`applyMappings()` with `fileToGraph` / `UPDATE` / `parameter`
direction). The established `_overridden` pattern is respected:

| Parameter file source | Graph target | Override guard |
|---|---|---|
| `p.posterior` (entire sub-object) | `edge.p.posterior` | Always cascaded |
| Derived `α/(α+β)` | `edge.p.mean` | Only if `!mean_overridden` |
| Derived from α, β | `edge.p.stdev` | Only if `!stdev_overridden` |
| `p.latency.posterior` (entire sub-object) | `edge.p.latency.posterior` | Always cascaded |
| `posterior.mu_mean` | `edge.p.latency.mu` | Always (internal, no override flag) |
| `posterior.sigma_mean` | `edge.p.latency.sigma` | Always (internal, no override flag) |
| `posterior.onset_delta_days` | `edge.p.latency.onset_delta_days` | Only if `!onset_delta_days_overridden` |
| Derived t95 from posterior | `edge.p.latency.t95` | Only if `!t95_overridden` |

### Where schema changes are needed

All additions are optional fields on existing interfaces/models:

| Layer | File | Change |
|---|---|---|
| **TypeScript types** | `src/types/index.ts` | Add `posterior?: ProbabilityPosterior` to `ProbabilityParam`; add `posterior?: LatencyPosterior` to `LatencyConfig`; add `_bayes?: BayesRunMetadata` to graph document type |
| **Python Pydantic** | `lib/graph_types.py` | Add `ProbabilityPosterior`, `LatencyPosterior`, `BayesRunMetadata` models; add optional `posterior` fields to existing models |
| **YAML schema** | `public/param-schemas/parameter-schema.yaml` | Add `posterior` object under `p` and under `latency` with the fields above |
| **Graph YAML schema** | (if separate from parameter schema) | Same additions + `_bayes` at root |
| **Forecasting settings** | `src/constants/latency.ts` | Add `BAYES_FIT_HISTORY_INTERVAL_DAYS`, `BAYES_FIT_HISTORY_MAX_ENTRIES`; extend `ForecastingSettings` interface and `buildForecastingSettings()` |
| **Python settings** | `lib/forecasting_settings.py` (or equivalent) | Matching defaults; parity test updated |

### What the roundtrip skeleton writes

The skeleton worker doesn't run inference. It writes placeholder posteriors
that exercise the full schema:

- **Graph-level**: `_bayes` block with `duration_ms`, `fingerprint`,
  `model_version=1`, `settings_signature`, placeholder quality metrics
  (`max_rhat=0, min_ess=0, converged_pct=0, edges_fitted=N, edges_skipped=0`).
- **Probability**: `distribution='beta', alpha=1, beta=1` (uniform prior),
  `provenance='point-estimate'`, `evidence_grade=0`, `ess=0, rhat=NaN`,
  `fitted_at` = today, `fingerprint` = hash of graph snapshot,
  `fit_history=[]` (empty — no prior snapshots).
- **Latency**: `distribution='lognormal'`, mirror current `mu`/`sigma` values
  as `mu_mean`/`sigma_mean` with `mu_sd=0, sigma_sd=0`,
  `onset_delta_days` = current value, same quality placeholders,
  `fit_history=[]`.
- **p.mean / p.stdev / p.latency.mu / p.latency.sigma**: left unchanged
  (placeholder posterior doesn't update point estimates).

This is enough to verify: webhook formats correctly, YAML round-trips, FE
reads the fields back, git diff shows expected changes, fit_history array
serialises and deserialises correctly.

---

## Infrastructure components

### 1. Vercel config route (`/api/bayes/config`)

**Lightweight TS route.** Returns three values from Vercel env vars. No
computation, no data processing — just a config lookup.

**Input**: none (GET request, authenticated via existing FE→Vercel
mechanism).

**Output**: `{ webhook_url, webhook_secret, db_connection }`.

The FE calls this once (on first Bayes trigger or app init) and caches
the values in session memory. These values are needed for two purposes:
- `webhook_secret` is used by the FE to encrypt the user's git
  credentials into an opaque callback token (see §4 below).
- `db_connection` and `webhook_url` are passed through to Modal
  in the submission payload.

### 2. Modal app (`bayes/app.py`)

Deployed to Modal via `modal deploy`. No Docker — Modal handles the
Python environment from a decorator-specified `Image`.

**Three components in the Modal app:**

**2a. Submit web endpoint** (`/submit`). A Modal-hosted FastAPI endpoint
that receives the FE's submission payload and spawns the worker.

**Input** (from FE, direct HTTPS call):
```
{ graph_id, repo, branch, graph_file_path,
  graph_snapshot, parameters_index, parameter_files, settings,
  callback_token, db_connection, webhook_url }
```

The endpoint calls `fit_graph.spawn(payload)` and returns
`{ job_id: call.object_id }` to the FE immediately.

The graph snapshot is the full graph YAML at the moment of submission —
frozen at submission time. See "Graph discovery" below for rationale.

**2b. Worker function** (`fit_graph`). The compute entry point. Receives
everything it needs in its spawn payload — no Modal Secrets, no
hardcoded config.

For this workstream, the logic is trivial:

1. Connect to Neon PostgreSQL (connection string from `db_connection`
   in the payload).
2. Read evidence inventory for the submitted graph (proves DB access works).
3. Build placeholder posterior payload (proves schema formatting works).
4. POST to `webhook_url` from the payload, with the `callback_token` in
   the `x-bayes-callback` header and the posterior results in the body.

The worker has no hardcoded knowledge of Vercel URLs, secrets, or git
credentials. It carries the `callback_token` as an opaque blob — it
cannot read or tamper with it. The same Modal deployment serves staging,
production, and local dev — the caller controls where results go and
whose credentials are used.

Once the infrastructure is proven, the inference work (see Logical blocks,
blocks 2–5) replaces step 3 with the actual compiler + model + sampler
pipeline.

**2c. Status web endpoint** (`/status`). A Modal-hosted endpoint that
polls `FunctionCall.from_id(call_id).get(timeout=0)` and returns
`{ status: "running" | "complete" | "failed" }`. Called directly by the
FE. The `call_id` is an unguessable Modal-generated UUID — it serves as
a capability token (no additional auth needed).

### 3. Webhook handler (`/api/bayes-webhook.ts`)

Receives posterior results and commits them to the repo.

**Key design decisions:**

**Atomic multi-file commit.** A single fit updates multiple parameter files
(one per edge). The GitHub Contents API (`createOrUpdateFileContents`) commits
one file at a time — 14 edges = 14 commits. Instead, use the Git Data API:
1. `git.getRef` — get current branch HEAD SHA.
2. `git.getCommit` — get the tree SHA.
3. For each file: `git.createBlob` with updated YAML content.
4. `git.createTree` — new tree with all updated blobs.
5. `git.createCommit` — single commit referencing the new tree.
6. `git.updateRef` — advance the branch.

This produces one clean commit per fit, regardless of how many files changed.

**Idempotency.** The handler deduplicates on `(job_id, fingerprint)`. If the
same webhook fires twice (vendor retry), the second call is a no-op. Check:
does a commit with this fingerprint already exist? (Search recent commit
messages, or maintain a short-lived in-memory/KV dedup window.)

**Webhook authentication.** Encrypted callback token in `x-bayes-callback`
header, decrypted with `process.env.BAYES_WEBHOOK_SECRET`. Git credentials
extracted from the decrypted token. See "Modal integration design" below.

**Execution timeout.** The webhook handler makes ~6 sequential GitHub API
calls (getRef, getCommit, createBlob × N, createTree, createCommit,
updateRef), each ~200–500ms. Expected total: 3–8s typical, 10–20s with
retry-with-rebase. Vercel Fluid Compute (enabled on the DagNet deployment)
gives 300s on Hobby — comfortably sufficient. The webhook route should
declare `maxDuration` explicitly in `vercel.json` for self-documentation:

```json
"functions": {
  "api/bayes-webhook.ts": { "maxDuration": 60 }
}
```

(Fluid Compute duration limits: Hobby default/max 300s; Pro default 300s,
max 800s. Without Fluid Compute the Hobby default drops to 10s — but Fluid
Compute is enabled and should remain so.)

**Commit message format:**
```
[bayes] Fitted {n} edges for {graph_id} — {provenance_summary}

fingerprint: {fingerprint}
job_id: {job_id}
edges: {edge_count}
quality: r-hat {max_rhat}, min ESS {min_ess}
```

### 4. FE job tracking and operational model

#### Status model

The compute vendor (Modal) is the status store — not the snapshot DB (which is
archival only), not IDB, not any DagNet-owned database. The FE polls the vendor
for job lifecycle status. The vendor retains function call results for 7 days
after exit, so the worker does not need to stay alive post-webhook for the FE
to observe completion.

**Job states (FE perspective):**

| State | Meaning | How detected |
|---|---|---|
| `submitted` | Modal `/submit` endpoint returned `job_id` | Immediate, from submission response |
| `running` | Vendor says function is still executing | Vendor poll returns timeout / in-progress |
| `vendor-complete` | Vendor says function exited successfully | Vendor poll returns result |
| `committed` | FE pulled and found `[bayes]` commit matching `job_id` | Commit message scan after pull |
| `failed` | Vendor says function failed, or FE timeout exceeded | Vendor poll returns error, or wall-clock timeout |

The `vendor-complete` → `committed` transition happens when the FE pulls and
finds the webhook's git commit. Between these two states, the webhook may still
be in flight or may have already committed — the FE does not distinguish. It
simply pulls and checks.

#### Job record

Each pending fit is tracked in session state during the automation run:

```
{ job_id, graph_id, submitted_at, status, last_polled_at }
```

Initially ephemeral (in-memory). Step 7 adds IDB persistence so jobs
survive browser close and can be reconciled on boot.

#### Vendor polling

The FE polls the Modal status web endpoint directly:
`GET https://dagnet-bayes--status.modal.run/?call_id={job_id}`.
No Vercel proxy — the `call_id` is an unguessable UUID that serves as
a capability token.

- **Poll interval**: ~15–30s during automation, configurable.
- **Per-job polling**: Modal does not support batch status queries. The FE
  polls each pending job individually — acceptable for the expected concurrency
  (<20 concurrent fits).
- **Timeout**: if a job remains `running` beyond a configurable wall-clock
  limit (e.g. 10 minutes), the FE marks it `failed` with reason `timeout`.
  The worker may still be executing — this is a FE-side safety net, not a
  vendor cancellation.

#### Concurrent dispatch pattern

The FE dispatches fits concurrently as part of the automation cycle, integrated
with the existing cron mechanism (`useURLDailyRetrieveAllQueue`):

```
pending_fits = []
for each graph with dailyFetch:
  pull (remote-wins merge)
  retrieve all slices (existing fetch+commit cycle)
  commit fetched data
  submit bayes fit → job_id
  pending_fits.push({ job_id, graph_id, status: 'submitted' })

// all fetches complete — now poll for fit results
poll pending_fits every ~15s:
  for each pending job:
    query vendor status via Modal /status endpoint
    update job.status
  until all jobs are committed/failed/timed-out

// all fits resolved
pull once (picks up all bayes webhook commits)
scan commit messages for [bayes] markers → match to job_ids
log results via sessionLogService
```

Fits run concurrently in the cloud. The FE's sequential graph loop
(pull→fetch→commit→submit) means submissions are staggered by seconds, but
workers execute in parallel. The post-loop polling phase waits for all workers
to complete.

#### Worker lifecycle

The worker's lifecycle is simple because Modal retains results post-exit:

1. Worker starts (cold start + execution).
2. Worker reads evidence from snapshot DB, computes posteriors.
3. Worker fires webhook to `/api/bayes-webhook` with results.
4. Worker exits.

The worker does **not** need to wait for the FE to poll, because Modal retains
the function call result for 7 days. The FE can poll
`FunctionCall.from_id(job_id)` at any point after exit and observe the result.

#### Failure taxonomy

| Failure | Detection | FE behaviour |
|---|---|---|
| Worker crashes | Vendor poll returns error/exception | Mark `failed`, log error, continue other jobs |
| Worker timeout (vendor-side) | Vendor returns timeout status | Mark `failed`, log |
| Webhook auth failure | Worker logs error; vendor shows success (worker exited OK) but no commit appears | FE times out waiting for commit; logs as `failed (no commit)` |
| Webhook git commit failure | Webhook returns error to worker; worker can retry or report | Vendor poll may show error if worker propagates it |
| Webhook concurrency conflict | See "Webhook concurrency" below — handled by retry-with-rebase | Transparent to FE |
| FE wall-clock timeout | Poll loop exceeds configured limit | Mark `failed (timeout)`, log, continue |
| Network failure during poll | Vendor endpoint returns error | Retry on next poll cycle; mark `failed` after N consecutive failures |
| FE session closes mid-fit | No detection (browser gone) | **Write still succeeds** — webhook is server-side Vercel, independent of browser. Results land in git. User sees them on next pull. With IDB persistence (Step 7), boot reconciliation resumes polling and surfaces outcome. |

#### Session logging

All job lifecycle events are logged via `sessionLogService`:

- `BAYES_FIT_SUBMITTED` — job dispatched, includes `job_id` and `graph_id`
- `BAYES_FIT_RUNNING` — first poll confirms worker is executing
- `BAYES_FIT_COMPLETE` — commit detected after pull
- `BAYES_FIT_FAILED` — failure with reason
- `BAYES_FIT_SUMMARY` — end-of-cycle summary: N fits, N succeeded, N failed

#### Progress visibility and worker diagnostics

Modal provides only coarse lifecycle status (running/complete/failed) — no
native mechanism for the worker to report intermediate progress ("iteration
50/200"). Granular progress would require an external channel (e.g. worker
writes to a shared KV store, FE polls it). This is not needed for the initial
workstream. Coarse status is sufficient: the FE shows "fit running" until
complete.

If granular progress is needed later, the simplest approach is a lightweight
progress endpoint backed by Modal's `Dict` (shared in-memory dictionary) or
an external Redis instance. The worker writes `{ iteration, total, phase }`;
the FE polls via a progress endpoint.

**Logging channels (three tiers):**

Modal's `FunctionCall` API has **no programmatic access to stdout/stderr**.
The available methods are `get()` (return value only), `get_call_graph()`,
`cancel()`, `from_id()`, `gather()`. The `io_streams` module is for
Sandboxes only — not for spawned function calls. So we cannot pull worker
console logs via API.

Three channels for getting diagnostics out of Modal workers:

**Tier 1: Worker return value (primary, zero-infrastructure).** The worker
returns a rich diagnostic object. `FunctionCall.get()` returns whatever the
function returned — we control the shape. The status endpoint returns this
to the FE on the final poll. The FE logs it via `sessionLogService`.

```
{
  "status": "complete",
  "duration_ms": 12345,
  "edges_fitted": 14,
  "edges_skipped": 2,
  "skip_reasons": { "edge-x": "insufficient evidence (< 7 days)" },
  "quality": { "max_rhat": 1.02, "min_ess": 400 },
  "warnings": ["edge-y: r-hat 1.08, may not have converged"],
  "log": [
    "connected to Neon (45ms)",
    "read evidence for 14 edges (210ms)",
    "fitting edge-a (1.2s)",
    "fitting edge-b (0.8s)",
    ...
  ],
  "webhook_response": { "status": 200, "sha": "abc123" },
  "error": null
}
```

On failure, the return value carries the error context:

```
{
  "status": "failed",
  "duration_ms": 3200,
  "error": "Neon connection refused after 3 retries",
  "phase": "evidence_read",
  "log": ["connected to Neon (45ms)", "query failed: connection reset", ...]
}
```

The FE reads this on the final status poll and feeds it into
`sessionLogService` as child entries under the `BAYES_FIT_COMPLETE` or
`BAYES_FIT_FAILED` operation. For automation runs, `automationLogService`
persists these to IDB (survives window close, available via
`dagnetAutomationLogEntries(runId)` in the console).

**Tier 2: Modal dashboard (development and debugging).** The Modal web UI
shows stdout/stderr for all function invocations, searchable by function
name and time range. For development and debugging, this is where you look.
Not programmatically accessible, but sufficient for the human debugging use
case. Deployed function logs do not stream back to the local client — they
are only visible in the dashboard.

**Tier 3: Structured log table in Neon (future, if needed).** If searchable
historical logs or real-time streaming during execution are needed, the
worker writes log rows to a `bayes_run_logs` table in Neon during execution.
A dedicated endpoint queries it. Only build this if Tier 1 + Tier 2 prove
insufficient.

**Status endpoint enrichment.** The status endpoint should return the full
worker result when available, not just the lifecycle state:

```
// Running — no result yet
{ "status": "running" }

// Complete — includes full diagnostic return value
{ "status": "complete", "result": { ...worker return value... } }

// Failed — includes error context from worker
{ "status": "failed", "error": "...", "result": { ...partial if available... } }
```

The FE's final poll picks this up and logs the diagnostic detail. The
`BAYES_FIT_COMPLETE` session log entry includes edges fitted, quality
metrics, warnings, and the commit SHA (from `webhook_response`). The
`BAYES_FIT_FAILED` entry includes the error, the phase where it failed,
and whatever log lines were captured before failure.

**Commit SHA correlation.** The worker waits for the webhook HTTP response
(synchronous POST, not fire-and-forget) and includes the commit SHA in its
return value. This gives the FE a direct correlation: "job X → commit
abc123" — visible in the session log without needing to scan commit
messages.

---

## Open questions

### Resolved

- **What schema fields does the webhook write?** `posterior` sub-objects on
  `ProbabilityParam` and `LatencyConfig` (see Schema additions above).
- **Single vs multi-file commit?** Atomic multi-file via Git Data API.
- **How does the FE detect completion?** Commit message pattern on next pull.
- **Parameter file vs graph file.** Both, but differently. The webhook
  writes posteriors to parameter files and `_bayes` metadata to the graph
  file. It does NOT cascade derived scalars to graph edges — that happens
  on the FE's post-pull derivation pass. See "Resolved (16-Mar-26, Step 3)".
- **Webhook route GitHub auth.** Fully proven. Credentials, API calls, and
  atomic multi-file commits via Git Data API all work server-side. See
  "Resolved (16-Mar-26, Step 3)" for spike results.
- **Submission route runtime.** No Vercel submission route — FE calls
  Modal directly. See "Submission and status routes" below.

### Resolved (16-Mar-26, continued)

- **Webhook payload contract.** See "Webhook payload contract" below.
- **Edge scoping.** See "Edge scoping rule" below.
- **YAML formatting responsibility.** Webhook handler owns YAML. See
  "YAML formatting" below.
- **Worker reads graph from git.** FE sends graph in submission payload for
  on-demand fits. See "Graph discovery" below.
- **Operational model.** Vendor (Modal) is the status store, not the snapshot
  DB. FE polls vendor for coarse lifecycle status. Worker exits after webhook
  — no TTL hold needed (vendor retains results 7 days). Concurrent dispatch
  integrated with existing FE cron mechanism. See "FE job tracking and
  operational model" above.
- **Webhook concurrency.** Concurrent webhook commits cause `updateRef` race.
  Solved by retry-with-rebase (~15 lines). See "Webhook concurrency" above.
- **Compute vendor selection.** Modal. No Docker, Python-decorator
  deployment, async spawn with 7-day status retention. Full integration
  design including auth chain, route signatures, and secrets inventory in
  "Modal integration design" above.
- **Shared parameter file conflict.** Last-writer-wins. Acceptable because
  fitted values are near-identical and `fit_history` preserves the trail.
  See "Shared parameter file conflict" in Modal integration design.
- **Worker diagnostics and logging.** Modal has no API for programmatic
  stdout/stderr access from `FunctionCall`. Three-tier approach: (1) rich
  worker return value via `fc.get()` — primary channel, zero infra; (2)
  Modal dashboard for dev debugging; (3) Neon log table if needed later.
  Status endpoint returns full worker result including execution log,
  quality metrics, and commit SHA. See "Progress visibility and worker
  diagnostics" above.
- **Vercel webhook timeout.** Fluid Compute is enabled on the DagNet
  deployment. Hobby plan gives 300s default (not the legacy 10s). Webhook
  handler expected to complete in 3–20s. `maxDuration: 60` configured in
  `vercel.json` for self-documentation. See webhook handler §3 above.
- **FE session closes mid-fit.** Write still succeeds (webhook is
  server-side, independent of browser). User sees results on next pull.
  IDB job persistence (Step 7) adds boot reconciliation for full
  observability. See failure taxonomy above.
- **FE job persistence.** Ephemeral in-memory records for Steps 4–6.
  Step 7 adds IDB persistence and boot reconciliation (poll Modal for
  pending jobs on app restart). See "Step 7: IDB job persistence" below.

### Resolved (16-Mar-26, Step 3 implementation)

- **Git Data API spike.** Proven. `api/_lib/git-commit.ts` implements
  `atomicCommitFiles()` using raw fetch (no Octokit — matches existing api
  route patterns). Roundtrip test (`gitDataApi.roundtrip.test.ts`) creates a
  2-file atomic commit on `feature/bayes-test-graph` in ~2.6s. Well within
  Vercel timeout. Uses `Buffer.from()` for base64 (no btoa/atob issues).
- **Isomorphic cascade module extraction.** Already done (src-slimdown).
  `mappingEngine.ts`, `mappingConfigurations.ts`, `nestedValueAccess.ts` are
  all platform-agnostic. However, the webhook **does not use the cascade** —
  see design decision below.
- **Webhook does NOT cascade to graph edges.** The webhook writes posteriors
  to parameter files and `_bayes` metadata to the graph file. It does NOT
  cascade derived scalars (`p.mean`, `p.stdev`, `p.latency.*`) into graph
  edges. Rationale: scalar derivation (completeness, forecast, t95) is
  triggered by many things beyond Bayes completion (query changes, context
  changes, date changes, time passing). The derivation pipeline must live
  where all those triggers can reach it — the FE (possibly via BE calls).
  The webhook commits the posteriors; the FE pulls, derives, and commits
  derived scalars via the normal cascade on pull. See "Derivation pipeline
  trade-off" in `1-cohort-completeness-model-contract.md` for full analysis.

### Still open
- **Modal spike (cold start + DB + scientific stack).** Modal is the
  chosen vendor. The spike must verify: sub-second cold start with the
  scientific Python image (numpy/scipy/pymc), Neon DB connectivity from
  the worker (connection string passed in the spawn payload — no Modal
  Secrets), and webhook delivery to Vercel. See "Modal integration
  design" above for the full architecture and zero-Modal-Secrets design.
- **Automation integration.** The existing `useURLDailyRetrieveAllQueue`
  hook needs extending: after each graph's fetch+commit, submit a fit; after
  all fetches, poll pending fits; after all fits resolve, pull once and log.
  The hook's existing progress tracking, abort, and session logging patterns
  provide the scaffolding.
- **Conflict with dirty files.** If the user has local edits to a parameter
  file and the webhook commits to the same file, the next pull conflicts.
  Accepted as a known limitation — the existing pull/merge flow handles
  file-level conflicts. Revisit if problematic.
- **Nightly graph discovery.** For nightly scheduled fits (no FE trigger),
  the worker needs to discover which graphs to fit and read them from git.
  Deferred — nightly scheduling is out of scope for this workstream.

---

## Investigation findings (16-Mar-26)

### Which files the webhook updates

**Both parameter files and graph files, in a single atomic commit.**

Codebase investigation confirmed the existing data flow:

- Parameter files (`parameters/*.yaml`) are the source of truth for `p.mean`,
  `p.stdev`, `latency.mu`, `latency.sigma`, `latency.model_trained_at`, and
  other fitted/observed values.
- UpdateManager (`src/services/UpdateManager.ts`) has explicit file→graph
  mappings that flow these fields to graph edges during "Get from File".
- Graph files are master for `query`, `n_query`, `anchor_node_id` — the
  webhook must never modify these.
- The `_overridden` pattern protects manually-set values: if
  `p.mean_overridden` is true on a graph edge, auto-sync from the parameter
  file skips that field.

**What the webhook writes to each parameter file:**

- `posterior` sub-object (new): alpha, beta, HDI, ess, rhat, fitted_at,
  fingerprint, provenance
- `latency.posterior` sub-object (new): mu_mean, mu_sd, sigma_mean, sigma_sd,
  HDI for t95, same quality fields
- `values[latest].mean` and `values[latest].stdev`: updated to posterior mean/sd
- `latency.mu`, `latency.sigma`: updated to posterior means
- `latency.model_trained_at`: updated to fit date
- **Preserved unchanged**: `query`, `n_query`, `anchor_node_id`, all
  `_overridden` flags, `values[]` history

**Graph file cascade:**

The webhook must update both parameter files AND graph files in the same
atomic commit. Without the graph update, the roundtrip is incomplete — the
graph YAML in git would be stale, and the FE would not see updated values
after pulling.

Today the cascade (parameter file → graph edge) is handled by
`UpdateManager.handleFileToGraph()` in the browser. The core cascade logic
— 138 declarative field mappings, override flag checks, and value transforms
— is a pure data transformation with **zero platform dependencies** (no IDB,
FileRegistry, GraphStore, browser APIs). The orchestration around it (IDB
reads, GraphStore mutations, event dispatch, UI callbacks) is browser-only.

**Approach: extract a shared isomorphic cascade module.**

1. Extract the pure cascade logic from UpdateManager into a shared module
   (e.g. `lib/parameter-cascade.ts`): mapping definitions, `applyMappings()`
   engine, override checking, `getNestedValue`/`setNestedValue` helpers, and
   value transforms (date normalisation, rounding).
2. Browser-side UpdateManager imports the shared module and wraps it with
   IDB/FileRegistry/GraphStore orchestration — no behavioural change to the
   FE.
3. Server-side webhook handler imports the same module. For each fitted edge:
   reads the graph YAML from git, applies the cascade via the shared module
   (respecting `_overridden` flags), includes the updated graph file in the
   atomic commit alongside the parameter files.

This ensures:

- **Single implementation** of cascade logic — no divergence between browser
  and server.
- **`_overridden` semantics are respected** — same code path, same rules.
- **Git is self-consistent** after the commit — parameter files and graph
  edges reflect the same posteriors.
- **The extraction is a refactor, not a rewrite** — the pure logic is already
  cleanly separated from orchestration inside UpdateManager. Investigation
  confirmed ~65–70% of UpdateManager's core logic is pure and isomorphic.

**Implications for the atomic commit:** the webhook handler reads the graph
file in addition to parameter files, applies cascaded changes, and includes
the updated graph file in the same `createTree` call. One commit, all files
consistent.

**What the webhook does NOT touch (regardless of option):**

- `query`, `n_query`, `anchor_node_id` — graph-mastered
- `_overridden` flags — user-controlled
- `values[]` history entries (only the latest/top entry is updated)

### Current prototype status (16-Mar-26)

The dev harness roundtrip is working end-to-end: FE → Modal submit → worker →
webhook → git commit → FE auto-pull. Both Local and Modal modes complete
successfully with correct progress indicators and overlapping submissions.

**However, the current webhook is a bespoke hack.** It reads the graph file
from GitHub, does a dumb `graphDoc._bayes = { ... }` mutation, re-serialises,
and commits — bypassing all established update pathways. This caused two bugs
during development:

1. **Format corruption.** The webhook originally used `yaml.dump()` on `.json`
   graph files, writing YAML into JSON and corrupting committed files. Required
   manual restoration from git history. Fixed by adding JSON/YAML detection, but
   the root cause is that the webhook reimplements serialisation logic that the
   app already handles correctly.

2. **Fragile round-tripping.** `JSON.parse` → mutate → `JSON.stringify` drops
   formatting, reorders keys, and risks subtle data loss on types that don't
   round-trip cleanly through JSON. The established UpdateManager pathways
   handle these concerns; the bespoke webhook does not.

**The prototype is useful for proving the infrastructure plumbing** (tunnel,
encryption, Modal spawn/poll, webhook auth, auto-pull). But the mutation logic
must be replaced with the shared isomorphic cascade module (Step 2) before any
real posterior data flows through the system. The webhook must not contain its
own update logic — it must call the same code that the browser uses.

**What stays:** tunnel management, callback token encryption/decryption, Modal
submission and polling, auto-pull after completion, progress indicators,
overlapping submission support.

**What gets replaced:** the entire "read file → mutate → serialise → commit"
block in both `server/bayesWebhook.ts` and `api/bayes-webhook.ts`. This is
replaced by: read files → apply posteriors to parameter files → call
`applyMappings()` from the shared cascade module for graph file cascade →
atomic multi-file commit via Git Data API.

### Server-side GitHub auth

**Answer: credentials and simple API calls are proven. Atomic multi-file
commits are NOT — they need a spike.**

**What is proven server-side:**

- **Credentials loading.** `api/graph.ts` (lines 58–83) loads credentials from
  `SHARE_JSON` / `VITE_CREDENTIALS_JSON` env vars, validates against
  `SHARE_SECRET` / `VITE_CREDENTIALS_SECRET`, extracts
  `GitRepositoryCredential` with owner, repo, and token. This pattern works.
- **Simple GitHub REST API calls.** `api/auth-callback.ts` makes `fetch()`
  calls to `api.github.com` (OAuth token exchange, user info). `api/graph.ts`
  reads single files via the Contents API. Both use token auth headers.

**What is NOT proven server-side:**

- **Atomic multi-file commits via Git Data API.** The full workflow
  (getRef → getCommit → getTree → createBlob × N → createTree → createCommit
  → updateRef) exists **only** in `gitService.ts`, which is browser-only
  (`btoa()`, `window`, `CustomEvent`, Octokit instantiation assumes browser).
  No server-side route has ever performed this sequence.
- **Octokit server-side instantiation.** `@octokit/rest` is in
  `package.json`, but it is only imported in `gitService.ts` (browser).
  Octokit itself should work in Node.js (it's designed for both environments),
  but this has not been tested in a Vercel serverless function in this codebase.

**What the spike must verify:**

1. Instantiate Octokit in a Vercel TS serverless function with a git token.
   (For the spike, use `SHARE_JSON` credentials. In production, the webhook
   handler will use the user's git token from the decrypted callback token —
   same mechanism, different credential source.)
2. Execute the full Git Data API sequence: read current ref → create blobs for
   2–3 test files → create tree → create commit → update ref.
3. Confirm the commit appears correctly in the repo.
4. Measure execution time (Vercel serverless has a 10s default / 60s max
   timeout for hobby, 300s for pro).

**Alternative**: skip Octokit entirely and use raw `fetch()` calls to the Git
Data API (same as `auth-callback.ts` pattern). This avoids any Octokit
browser-assumption risk but requires manual JSON handling for each API call.

**The webhook handler authenticates via the encrypted callback token:**

1. **Inbound (compute vendor → webhook):** extract `x-bayes-callback`
   header. Decrypt with `process.env.BAYES_WEBHOOK_SECRET` (AES-GCM).
   Decryption failure → 401. Expired token → 401.
2. **Outbound (webhook → GitHub):** use git credentials (owner, repo,
   token, branch) from the **decrypted callback token**. No `SHARE_JSON`
   dependency — the user's own git credentials flow through encrypted.

See "Modal integration design" above for the full credential flow, secrets
inventory, and security properties.

### Submission and status routes

**There is no Vercel submission route.** The FE calls Modal's `/submit` web
endpoint directly — the large payload (graph data, parameter files) never
passes through Vercel.

**There is no Vercel status proxy.** The FE polls Modal's `/status` web
endpoint directly using the `call_id` as a capability token.

**The only Vercel route in the Bayes flow is `/api/bayes/config`** (a
lightweight TS GET route returning three env-var strings) and
`/api/bayes-webhook` (the callback handler). See "Infrastructure
components, §1" and "Modal integration design" above.

### FE sync gap (resolved)

The webhook commits both parameter files and the graph file in a single
atomic commit. After pulling, the FE sees updated graph edges directly — no
manual "Get from File" needed. The FE sync gap that exists for other data
flows (e.g. "Get Data" updates) does not apply to the Bayesian fit pathway
because the server-side cascade handles it.

### Webhook payload contract

The worker POSTs a single JSON object to `/api/bayes-webhook`. The handler
uses this to update parameter files and commit to git.

```json
{
  "job_id": "fit-abc123",
  "graph_id": "conversion-flow-v0",
  "repo": "data-repo",
  "branch": "main",
  "graph_file_path": "graphs/conversion-flow-v0.yaml",
  "fingerprint": "sha256:abc123...",
  "fitted_at": "16-Mar-26",
  "quality": {
    "max_rhat": 1.02,
    "min_ess": 450,
    "converged": true
  },
  "edges": [
    {
      "param_id": "household-delegation-rate",
      "file_path": "parameters/household-delegation-rate.yaml",
      "probability": {
        "alpha": 1.0,
        "beta": 1.0,
        "mean": 0.5,
        "stdev": 0.289,
        "hdi_lower": 0.025,
        "hdi_upper": 0.975,
        "hdi_level": 0.94,
        "ess": 0,
        "rhat": null,
        "provenance": "point-estimate"
      },
      "latency": {
        "mu_mean": 2.3,
        "mu_sd": 0.0,
        "sigma_mean": 0.6,
        "sigma_sd": 0.0,
        "hdi_t95_lower": 12.0,
        "hdi_t95_upper": 18.0,
        "hdi_level": 0.94,
        "ess": 0,
        "rhat": null,
        "provenance": "point-estimate"
      }
    }
  ],
  "skipped": [
    {
      "param_id": "some-edge-no-evidence",
      "reason": "no_evidence"
    }
  ]
}
```

Design notes:

- **`graph_file_path`**: the repo-relative path to the graph file. The
  webhook handler needs this to read, cascade to, and commit the graph file.
- **`edges` array keyed by `param_id`**: the worker discovers parameters from
  the graph edges' `p.id` fields. Each entry maps 1:1 to a parameter file.
- **`file_path` included**: the worker resolves this from `parameters-index.yaml`
  so the webhook handler knows which file to update without re-parsing the index.
- **`probability` and `latency` are separate**: an edge may have probability
  evidence but no latency evidence (or vice versa). Omit the sub-object if not
  fitted.
- **`skipped` array**: edges that were scoped in but couldn't be fitted (no
  evidence, degenerate data, etc.). Logged in the commit message for operator
  visibility.
- **`quality` top-level**: aggregate quality metrics for the commit message and
  FE session log. Per-edge quality is in the edge sub-objects.

### Edge scoping rule

An edge is in scope for fitting when **all** of the following hold:

1. The edge has `p.id` defined (linked to a parameter file).
2. The parameter has at least one snapshot evidence row in the DB for that
   workspace-prefixed `param_id`.
3. The edge is active (not disabled/hidden in the graph).

Edges without `p.id` are not parameter-linked and are excluded entirely —
they may be placeholder edges or manually-configured edges that don't
participate in data-driven fitting.

Edges that are in scope but have insufficient evidence (below minimum
threshold) appear in the `skipped` array with reason `insufficient_evidence`.
The threshold is defined by modelling policy (see Logical blocks, §3.7).

For the skeleton roundtrip, the scoping is simpler: any edge with `p.id` gets
a placeholder posterior. The worker doesn't query the snapshot DB for evidence
counts — it just produces `provenance: 'point-estimate'` for all scoped edges.

### YAML formatting

**The webhook handler owns YAML formatting. The worker produces JSON only.**

Flow:

1. Worker computes posteriors and POSTs JSON to the webhook (see payload
   contract above).
2. Webhook handler, for each edge in the payload:
   a. Reads the current parameter file content from git (via Git Data API:
      `git.getBlob` on the current tree).
   b. Parses the YAML.
   c. Merges in the posterior fields: sets `posterior` sub-object, updates
      `values[0].mean`, `values[0].stdev`, `latency.mu`, `latency.sigma`,
      `latency.model_trained_at`.
   d. Serialises back to YAML.
   e. Creates a blob for the updated content.
3. Webhook handler cascades to graph file:
   a. Reads the graph YAML from git.
   b. For each fitted edge, applies the shared cascade module: updates
      `p.mean`, `p.stdev`, `p.latency.*`, `p.posterior` on the graph edge,
      respecting `_overridden` flags.
   c. Serialises the updated graph YAML.
   d. Creates a blob for the graph file.
4. All blobs (parameter files + graph file) are committed atomically in a
   single tree/commit/ref update.

Why this approach:

- **Worker stays language-agnostic.** Python worker produces JSON; it doesn't
  need to know about YAML formatting, field ordering, or comment preservation.
- **Single point of YAML handling.** The TS handler uses the same YAML library
  (`yaml` package, already in `package.json`) as the rest of the app.
- **Read-before-write is required anyway.** The handler must read current files
  to build the base tree for the atomic commit. Merging posterior fields into
  the parsed YAML is a small incremental step.
- **Future-proof.** When real inference replaces the skeleton, only the JSON
  payload content changes. The YAML merge logic in the handler stays the same.

### Graph discovery

**For on-demand fits (FE trigger), the graph is sent in the submission payload.**

The Modal `/submit` endpoint receives:

- `graph_id`: identifies the graph
- `repo`, `branch`: target repository
- `graph_snapshot`: the full graph YAML content (or parsed JSON) at the
  moment of submission
- `parameters_index`: the full `parameters-index.yaml` content (so the worker
  can resolve `param_id` → `file_path` without a GitHub API call)

This means:

- **No GitHub API dependency from the worker** (for on-demand fits).
- **No race conditions.** The graph is frozen at submission time. If the user
  edits the graph between submission and completion, the posteriors are written
  against the submitted version. The next fit picks up changes.
- **Payload size is acceptable.** A large graph is ~200KB of YAML. The
  parameters index is ~10KB. Well within webhook/API payload limits.

**For nightly scheduled fits** (future, out of scope for this workstream), the
worker will need to read graphs directly from git. This requires GitHub API
access from the worker environment — a separate concern to be addressed when
nightly scheduling is implemented.

### Webhook concurrency (retry-with-rebase)

**Problem**: When the FE dispatches fits concurrently (one per graph), multiple
workers may complete near-simultaneously. Each fires its webhook to the Vercel
handler. The handler's atomic commit sequence reads the current branch HEAD,
builds a tree, and calls `updateRef` to advance the branch. If two webhooks
overlap, the second one fails:

1. **Webhook A** reads HEAD at SHA `aaa`. Builds blobs, tree, commit `bbb`.
   Calls `updateRef(aaa → bbb)`. Succeeds.
2. **Webhook B** also read HEAD at `aaa` (before A committed). Builds its own
   blobs, tree, commit `ccc` (parent = `aaa`). Calls `updateRef(aaa → ccc)`.
   **Fails with HTTP 422 (not fast-forward)** because HEAD is now `bbb`.

This is a classic optimistic-concurrency conflict. Both writers read the same
base; the second one's `updateRef` is rejected because the ref moved.

**Solution**: The webhook handler wraps the commit sequence in a short retry
loop (2–3 attempts):

```
for attempt in 1..max_retries:
  head_sha = getRef(branch)
  tree_sha = getCommit(head_sha).tree
  read files from tree_sha
  update file contents (merge posteriors, cascade)
  create blobs, tree, commit (parent = head_sha)
  try updateRef(head_sha → new_sha)
  if success: return
  if 422 (not fast-forward): continue  // retry from top
  else: raise  // unexpected error
```

On retry, the handler re-reads HEAD (which now includes the other webhook's
commit), re-reads files from the new tree, and builds on top. The result is
clean linear history: A's commit, then B's commit. No merge commits, no
conflicts, no data loss.

**Why this is safe**: Each webhook modifies its own parameter files and graph
edges. Two fits for different graphs touch different parameter files, so the
retry never encounters a content conflict — only a ref pointer conflict.
Re-reading files from the updated tree automatically incorporates the other
webhook's changes to other files.

**Same-graph fits** (shouldn't occur in normal operation): if two webhooks
write to the same parameter files, the retry re-reads the file with the first
webhook's changes applied. Since both are writing to distinct edges (different
`p.id` values), the second write merges cleanly alongside the first. If they
somehow write to the same edge with the same fingerprint, idempotency catches
it. Different fingerprints for the same edge would mean the evidence changed
between submissions — the later result wins, which is the correct behaviour.

**Implementation cost**: ~15 lines of retry logic wrapping the existing
`updateRef` call. The rest of the commit sequence (blob creation, tree
building, YAML merging) is re-executed on retry but is cheap (<1s per attempt).

### Modal integration design

**Vendor**: Modal (modal.com). No Docker — Python-decorator deployment via
`modal deploy`. Meets all requirements: async spawn with job_id, queryable
status with 7-day retention, web endpoints for direct FE access.

**Design principles**:

- **FE calls Modal directly** for submission and status polling. No Vercel
  proxy in the hot path. The large payload (graph data, parameter files)
  never passes through Vercel.
- **All secrets managed in Vercel env.** Zero Modal Secrets. The FE fetches
  config from one lightweight Vercel endpoint, then operates independently.
- **Git write credentials are encrypted.** The FE encrypts the user's git
  token into an opaque callback token using the webhook secret. Modal never
  sees git credentials in cleartext. Only the Vercel webhook handler can
  decrypt them.
- **The worker is a pure function.** It receives data + DB URL + an opaque
  callback token. It has no hardcoded config, no secrets, no knowledge of
  Vercel or GitHub. The same deployment serves any environment.

#### Architecture overview

```
FE (browser)
  │
  │  (one-time config fetch)
  ├─ GET /api/bayes/config ──> Vercel (TS route, returns 3 strings from env)
  │<── { webhook_url,
  │      webhook_secret,
  │      db_connection }
  │
  │  (FE encrypts git creds locally)
  │  callback_token = encrypt(webhook_secret, {
  │    owner, repo, token, branch,
  │    graph_id, graph_file_path,
  │    job_id_placeholder, issued_at, expires_at
  │  })
  │
  │  (submission — large payload goes direct to Modal)
  ├─ POST Modal /submit ──────────────────────────> Modal (web endpoint)
  │  { graph_data, parameter_files, settings,         ├─ spawn worker
  │    callback_token, db_connection,              │
  │    webhook_url }                                   │
  │<── { job_id } ────────────────────────────────────┤
  │                                                    │
  │                                                    │ (worker runs)
  │  (poll loop — direct to Modal)                     ├─ connect to Neon DB
  ├─ GET Modal /status?call_id={job_id} ──────────────>├─ read evidence
  │<── { status: running } ───────────────────────────┤├─ compute
  │                                                    │
  │                              Vercel                │
  │                              (webhook handler)     │
  │                              │<── POST webhook_url─┤ (worker)
  │                              │  x-bayes-callback   ├─ exit
  │                              │  {posteriors}        │
  │                              ├─ decrypt callback    │
  │                              │  → git creds         │           GitHub
  │                              ├─ atomic commit ─────────────────>│
  │                              │  (retry-with-rebase) │           │
  │                                                                 │
  ├─ GET Modal /status ───────────────────────────────>│            │
  │<── { status: complete } ──────────────────────────┤            │
  │                                                                 │
  ├─ git pull ─────────────────────────────────────────────────────>│
  │<── updated files ──────────────────────────────────────────────┤
  │
  ├─ IDB → FileRegistry → GraphStore → UI
```

#### Credential and data flow (end-to-end)

**Step 1: FE fetches config from Vercel (once per session).**

```
GET /api/bayes/config
→ Vercel reads from env:
    BAYES_WEBHOOK_SECRET, DB_CONNECTION, BAYES_WEBHOOK_URL
→ returns { webhook_secret, db_connection, webhook_url }
```

FE caches these in session memory.

**Step 2: FE builds the encrypted callback token.**

The FE has the user's git credentials (from IDB, same as every other write
operation). It encrypts them using the `webhook_secret` as the key:

```
callback_token = AES-GCM-encrypt(webhook_secret, {
  owner,               // git repo owner
  repo,                // git repo name
  token,               // user's git write token
  branch,              // target branch
  graph_id,            // which graph was fitted
  graph_file_path,     // repo-relative path to graph file
  issued_at,           // timestamp
  expires_at           // issued_at + 30 minutes
})
```

This token is opaque — Modal cannot read it. Only the Vercel webhook
handler (which has `BAYES_WEBHOOK_SECRET`) can decrypt it.

Using the Web Crypto API (AES-GCM, available in all modern browsers).

**Step 3: FE submits directly to Modal.**

```
POST https://dagnet-bayes--submit.modal.run/
{
  // Graph data (FE has locally — never passes through Vercel)
  graph_id, repo, branch, graph_file_path,
  graph_snapshot, parameters_index,
  parameter_files: {
    "param-id": { fit_guidance, fit_history, values_latest }, ...
  },
  settings: { halflife_days, hdi_level, ... },

  // Config (from Vercel config endpoint)
  db_connection, webhook_url,

  // Encrypted git credentials (FE built this)
  callback_token
}
→ Modal /submit endpoint calls fit_graph.spawn(payload)
→ returns { job_id: call.object_id }
```

**Step 4: Worker executes on Modal.**

The worker receives the spawn payload. It can read the graph data,
DB connection string, and webhook URL. It **cannot** read the
`callback_token` (encrypted, it doesn't have the key).

1. Connect to Neon using `db_connection` from payload.
2. Query evidence for each parameter.
3. Compute posteriors (or placeholders for skeleton).
4. POST to `webhook_url`:
   ```
   Header: x-bayes-callback: {callback_token}
   Body: { job_id, graph_id, fingerprint, fitted_at,
           quality, edges, skipped }
   ```
5. Exit. (Modal retains the function call result for 7 days.)

**Step 5: Webhook handler commits to git.**

```
POST /api/bayes-webhook (Vercel TS)
1. Extract x-bayes-callback header.
2. Decrypt with BAYES_WEBHOOK_SECRET (AES-GCM).
   → If decryption fails → 401 (tampered or invalid token).
3. Check expires_at → if expired → 401 (stale token).
4. Check job_id in decrypted token matches job_id in body → if
   mismatch → 400.
5. Extract git credentials: owner, repo, token, branch,
   graph_file_path.
6. Idempotency: search recent commits for fingerprint → if found
   → 200 (already committed).
7. Read parameter files + graph file from GitHub using decrypted
   git token.
8. Merge posteriors into parameter files, cascade to graph edges.
9. Atomic commit with retry-with-rebase (see "Webhook concurrency").
10. Return { status: 'committed', sha }.
```

The webhook handler needs only **one env var**: `BAYES_WEBHOOK_SECRET`.
Everything else — git credentials, repo, branch, graph path — comes
from the decrypted callback token. No `SHARE_JSON` dependency.

**Step 6: FE polls status and pulls.**

FE polls Modal's status endpoint directly:
`GET https://dagnet-bayes--status.modal.run/?call_id={job_id}`.
The `call_id` is an unguessable Modal-generated UUID — it serves as
a capability token. No additional auth on this endpoint.

When status shows `complete`, FE pulls git, finds the `[bayes]` commit,
matches `job_id` in the commit message.

#### Security properties

- **Git write credentials**: in cleartext only in the browser (where they
  already live) and in the Vercel webhook handler (which already handles
  credentials via `SHARE_JSON` pattern). Encrypted everywhere else —
  inside the callback token, opaque to Modal.
- **`BAYES_WEBHOOK_SECRET`**: in Vercel env (server-side) and in browser
  session memory (fetched via config endpoint). The browser already holds
  credentials of equivalent sensitivity (git tokens). This secret is used
  for AES-GCM encryption/decryption only.
- **`DB_CONNECTION`**: in Vercel env and in browser session memory
  (fetched via config endpoint). Passed to Modal in the submission
  payload (HTTPS). In cleartext in the Modal worker's memory during
  execution — necessary for DB access. Same trust model as any compute
  vendor.
- **Callback token**: tamper-proof (AES-GCM authenticated encryption).
  Time-limited (30-minute expiry). Correlated to specific `job_id`.
  Replay → caught by idempotency check (fingerprint-based dedup).
- **Status endpoint**: capability-based. The `call_id` is unguessable.
  Returns only lifecycle state (running/complete/failed) — no sensitive
  data.

#### Secrets inventory

All secrets managed in Vercel env. Zero Modal Secrets.

| Secret | Where | Used by | Purpose |
|---|---|---|---|
| `BAYES_WEBHOOK_SECRET` | Vercel env | Config route (returns to FE); FE (encrypts callback token); webhook handler (decrypts callback token) | Symmetric key for callback token encryption |
| `DB_CONNECTION` | Vercel env | Config route (returns to FE); worker (DB access via payload) | Neon PostgreSQL connection string |
| `BAYES_WEBHOOK_URL` | Vercel env | Config route (returns to FE); worker (callback target) | Full URL of `/api/bayes-webhook` |

**One new secret**: `BAYES_WEBHOOK_SECRET`. `DB_CONNECTION` already
exists (used by snapshot routes). `BAYES_WEBHOOK_URL` is config, not a
secret (it's just the public URL of the webhook endpoint).

No `SHARE_JSON` dependency in the Bayes flow — git credentials come from
the user via the encrypted callback token. No Modal tokens on Vercel —
the FE calls Modal web endpoints directly via HTTPS.

#### Modal deployment structure

```python
# bayes/app.py — deployed to Modal via `modal deploy bayes/app.py`

import modal
import fastapi

app = modal.App("dagnet-bayes")

# Image: Python 3.12 + scientific stack
image = modal.Image.debian_slim(python_version="3.12").pip_install(
    "numpy", "scipy", "pymc", "arviz", "requests", "pyyaml", "psycopg2-binary"
)

# Submit web endpoint — called directly by FE
@app.function(image=modal.Image.debian_slim())
@modal.web_endpoint(method="POST")
def submit(request: fastapi.Request):
    """Receive submission from FE, spawn worker, return job_id."""
    payload = await request.json()
    fn = modal.Function.from_name("dagnet-bayes", "fit_graph")
    call = fn.spawn(payload)
    return {"job_id": call.object_id}

# Worker function — no secrets, no config, pure function
@app.function(image=image, timeout=600)
def fit_graph(payload: dict) -> dict:
    """Fit posteriors for a single graph. Fires webhook on completion.
    Returns rich diagnostic object (see 'Worker diagnostics and logging')."""
    import requests as http
    import time
    log = []
    t0 = time.time()
    # 1. Connect to Neon using payload["db_connection"]
    # 2. Read evidence, compute posteriors (appending to log[])
    # 3. POST results to webhook (synchronous — wait for response)
    resp = http.post(
        payload["webhook_url"],
        headers={"x-bayes-callback": payload["callback_token"]},
        json={"job_id": "...", "edges": [...], ...}
    )
    return {
        "status": "complete",
        "duration_ms": int((time.time() - t0) * 1000),
        "edges_fitted": 14,
        "edges_skipped": 0,
        "quality": { "max_rhat": 1.0, "min_ess": 0 },
        "warnings": [],
        "log": log,
        "webhook_response": { "status": resp.status_code,
                              "sha": resp.json().get("sha") },
    }

# Status web endpoint — called directly by FE
@app.function(image=modal.Image.debian_slim())
@modal.web_endpoint(method="GET")
def status(call_id: str):
    """Poll job status. No auth — call_id is capability token.
    Returns full worker result when available (diagnostics, quality, log)."""
    from modal.functions import FunctionCall
    fc = FunctionCall.from_id(call_id)
    try:
        result = fc.get(timeout=0)
        return {"status": "complete", "result": result}
    except TimeoutError:
        return {"status": "running"}
    except Exception as e:
        return {"status": "failed", "error": str(e)}
```

Note: the exact Modal decorator API may differ slightly — this is the
design intent, to be verified during the spike (Step 4).

#### Shared parameter file conflict (last-writer-wins)

Two graphs can reference the same parameter file (same `p.id` on edges in
different graphs). When both graphs are fitted concurrently and both webhooks
update the same parameter file, the retry-with-rebase mechanism handles it:

- The second webhook re-reads the file from the new HEAD (which includes
  the first webhook's changes).
- It overwrites the posterior fields with its own fitted values.
- **Last writer wins.** The final state reflects whichever webhook committed
  second.

This is acceptable because:

- The fitted values should be very similar (same evidence data, same model,
  close in time).
- `fit_history` records both fits (each webhook appends an entry), so the
  trajectory is preserved even if the current posterior is from the "wrong"
  graph's fit.
- The next nightly fit re-fits from fresh evidence and normalises everything.
- If this proves problematic in practice, `fit_history` provides the
  diagnostic trail to detect and reason about it.

#### Modal capability summary

| Capability | How it works | Verified? |
|---|---|---|
| Async spawn | `Function.spawn()` → `FunctionCall` with `.object_id` string | Docs confirmed |
| Cross-process status poll | `FunctionCall.from_id(call_id).get(timeout=0)` — no app ref needed | Docs confirmed |
| Status retention | 7 days post-exit | Docs confirmed |
| Web endpoints | `@modal.web_endpoint` decorator → stable HTTPS URL | Docs confirmed |
| No Docker | `modal.Image.debian_slim().pip_install(...)` | Docs confirmed |
| Cold start | Sub-second (advertised) | Needs spike verification |
| Neon DB connectivity | Standard `psycopg2` from Modal worker | Needs spike verification |
| Scientific Python stack | numpy, scipy, pymc via pip_install | Needs spike verification |
| Worker log access | **No API for stdout/stderr.** `FunctionCall` has no `.logs()` method; `io_streams` is Sandbox-only. Use worker return value for diagnostics, Modal dashboard for dev debugging. | Docs confirmed (gap) |

---

## Acceptance criteria

This workstream is complete when:

1. **Submission works.** FE can fetch config from Vercel, encrypt git creds,
   submit directly to Modal `/submit`, and receive a `job_id`.
2. **Worker executes.** The compute vendor runs the worker, connects to the
   snapshot DB, reads evidence inventory, and fires the webhook.
3. **Webhook commits.** The Vercel handler receives the payload, updates
   parameter files with `posterior` fields, cascades to graph edges via the
   shared isomorphic cascade module (respecting `_overridden` flags), and
   commits all files atomically to git.
4. **FE reads back.** After pulling, the FE sees updated `posterior` fields
   on graph edges and updated `p.mean`/`p.stdev` values. The fields parse
   correctly and appear in the type system. No manual "Get from File" needed.
5. **Cascade consistency.** The shared cascade module produces identical
   results when called from the webhook handler and from the browser-side
   UpdateManager. Verified by tests that run the same inputs through both
   paths.
6. **Schema is correct.** TypeScript types, Python models, and YAML schemas
   all include the `posterior` sub-objects. Existing graphs without posteriors
   continue to load without errors.
7. **Idempotency holds.** Firing the same webhook twice does not create
   duplicate commits.
8. **Session log records the event.** The FE logs lifecycle events
   (`BAYES_FIT_SUBMITTED`, `BAYES_FIT_COMPLETE`, `BAYES_FIT_FAILED`,
   `BAYES_FIT_SUMMARY`) throughout the automation cycle.
9. **Vendor polling works with diagnostics.** The FE can poll Modal's
   `/status` endpoint directly with a `call_id`. On completion, the
   response includes the full worker return value (duration, edges
   fitted/skipped, quality metrics, warnings, execution log, commit SHA).
   This is logged via `sessionLogService`.
10. **Concurrent webhooks don't collide.** When two webhook handlers fire
    near-simultaneously for different graphs, the retry-with-rebase logic
    produces two clean sequential commits, not a 422 failure.
11. **Automation integration works.** The cron mechanism
    (`useURLDailyRetrieveAllQueue`) can dispatch fits after each graph's
    fetch+commit, poll for completion, and pull the results — end-to-end
    within a single automation cycle.
12. **Worker diagnostics are surfaced.** The worker return value includes
    an execution log, quality metrics, and warnings. These appear in the
    FE session log. For automation runs, `automationLogService` persists
    them to IDB (survives window close).

What is explicitly **not** required:
- Real Bayesian inference (placeholder values are fine)
- FE display of posterior data (reading + type-checking is enough)
- Granular real-time progress during execution (coarse status is sufficient)
- Fan charts or confidence band changes
- Nightly scheduling (on-demand trigger only)
- Batch vendor status queries (per-job polling is acceptable)
- IDB job persistence (Step 7 — hardening phase, not required for initial
  acceptance)

---

## Implementation sequence

### Step 1: Schema additions
Add `posterior` sub-objects to TypeScript types, Python Pydantic models, and
YAML schemas. Write a focused integration test that round-trips a graph with
posterior fields through YAML serialisation/deserialisation.

### Step 2: Isomorphic cascade module (via slimdown UM-PR1–PR3)

Extract the pure cascade logic from UpdateManager into importable modules
usable by both the browser and Vercel serverless functions. This step is
executed as **UM-PR1 through UM-PR3** of the existing UpdateManager
slimdown plan (`docs/current/refactor/src-slimdown.md`, Target 2). The
slimdown plan is the authoritative reference for extraction mechanics,
cluster inventory, stop/gates, and test runlists. This section records
only the async-infra-specific context that the slimdown plan does not
cover.

#### Why align with the slimdown plan

The slimdown plan's Target 2 was designed independently of this workstream
but produces exactly the modules needed here. Aligning avoids:

- Maintaining two competing extraction plans for the same 5,136-line file.
- Risk of the two extractions conflicting or producing incompatible module
  boundaries.
- Duplication of test work (the slimdown plan already defines stop/gates
  and test runlists for each PR).

#### What UM-PR1–PR3 produce

Per the slimdown plan (verified current as of 16-Mar-26, UpdateManager
still 5,136 lines, all function locations unchanged):

- **UM-PR1 (types + pure helpers)**: `updateManager/types.ts` (FieldMapping,
  UpdateOptions, UpdateResult, FieldChange, Conflict, UpdateError, Warning),
  `updateManager/nestedValueAccess.ts` (getNestedValue, setNestedValue),
  `updateManager/roundingUtils.ts`, `updateManager/auditLog.ts`.
- **UM-PR2 (mapping configuration)**: `updateManager/mappingConfigurations.ts`
  — the 18 `addMapping()` calls (~1,200 lines of declarative config),
  exported as named constants so consumers can select subsets by direction,
  operation, and sub-destination.
- **UM-PR3 (mapping engine)**: `updateManager/mappingEngine.ts` —
  `applyMappings()` (currently lines 1346–1470) extracted as a standalone
  pure function.

After UM-PR3, UpdateManager imports these modules and its public API is
unchanged. All existing callers (dataOperationsService, UI) are unaffected.

#### How the webhook handler uses the extracted modules

The webhook handler imports directly from `updateManager/` — it never
instantiates UpdateManager.

```
webhook receives JSON payload
  → for each edge: parse parameter YAML, merge posterior fields
  → read graph YAML from git
  → for each fitted edge:
      - find the graph edge by p.id match
      - build source object (updated parameter data)
      - import FILE_TO_GRAPH_PARAMETER_UPDATE mappings from mappingConfigurations
      - call applyMappings(source, graphEdge, mappings, options)
        from mappingEngine
      - apply returned changes to the graph edge
  → serialise updated graph YAML
  → commit all files atomically
```

Only the `fileToGraph` direction with `UPDATE` operation and `parameter`
sub-destination is needed — a subset of the full mapping configuration.

#### Isomorphic verification gate (after UM-PR3)

After UM-PR3 completes, and before proceeding to Step 3, verify that the
extracted modules are genuinely platform-agnostic:

1. **No browser imports**: confirm `mappingEngine.ts`,
   `mappingConfigurations.ts`, `nestedValueAccess.ts`, and `types.ts`
   import nothing from `sessionLogService`, IDB, FileRegistry, GraphStore,
   `window`, `document`, `btoa`/`atob`, `CustomEvent`, or any other
   browser-only API.
2. **No `this` captures**: confirm that mapping transform/condition
   functions in `mappingConfigurations.ts` are stateless predicates (no
   closure over UpdateManager instance state). Investigation (16-Mar-26)
   found this to be the case, but must be re-verified after extraction.
3. **Parity test**: run the same source/target pair through the extracted
   `applyMappings()` directly AND through UpdateManager's
   `handleFileToGraph()`, assert identical `UpdateResult`. This is the
   key test that proves extraction didn't change behaviour.
4. **Node.js import test**: a trivial script that `require()`s (or
   `import()`s) the extracted modules in a plain Node.js context (no
   bundler, no jsdom) and calls `applyMappings()` with a minimal fixture.
   If it runs without error, the modules are server-safe.

If any of these checks fail, resolve before proceeding — the webhook
handler's correctness depends on these modules being pure.

#### Investigation findings (carried forward)

These findings from the 16-Mar-26 codebase investigation inform UM-PR1–PR3
execution. They are recorded here rather than in the slimdown plan because
they are specific to the isomorphic use case:

- **`applyMappings()` is pure**: lines 1346–1470 perform no I/O, no side
  effects, no browser API calls. It returns `UpdateResult` and the caller
  decides what to do with it.
- **`sessionLogService` is not called from `applyMappings()`**: logging
  happens in the direction handlers, not the engine. The extracted module
  must not import it; if logging is ever needed, accept an optional
  callback.
- **Transform/condition functions are stateless**: they check properties of
  the `source` and `target` objects passed in (e.g. `isProbType` checks
  `source.type === 'probability'`). No closure captures `this`.
- **Helper imports are all platform-agnostic**: `normalizeToUK`,
  `roundToDecimalPlaces`, `generateUniqueId`, `getSiblingEdges`,
  `normalizeConstraintString`, and the latency constants are pure
  JS/Date/Math with zero browser dependencies.
- **No direct tests of `applyMappings()` exist today**: the ~2,335 lines
  of UpdateManager tests cover higher-level operations (renameNodeId,
  rebalance) but not the core mapping engine. This gap must be filled
  during extraction — see the slimdown plan's test runlist and the parity
  test above.

### Step 3: Git Data API spike + webhook handler

Prove that atomic multi-file commits work from a Vercel serverless function,
then build the webhook handler that uses both the Git Data API and the
shared cascade module.

#### Part A: Git Data API spike

**Goal:** a minimal Vercel serverless function that creates a multi-file
atomic commit on a test branch using the Git Data API.

**Why this needs a spike:** the full Git Data API workflow (getRef →
getCommit → getTree → createBlob × N → createTree → createCommit →
updateRef) exists only in `gitService.ts`, which is browser-only. No
server-side route has ever performed this sequence. The spike must verify
that it works in the Vercel Node.js runtime.

**What the spike creates:**

A temporary route `api/bayes-spike.ts` (deleted after the spike) that:

1. Loads credentials from `SHARE_JSON` env var using the existing pattern
   from `api/graph.ts` (lines 58–83). (Spike uses SHARE_JSON for
   convenience; production webhook uses decrypted callback token.)
2. Instantiates Octokit server-side. Two approaches to evaluate:
   - **Octokit:** `new Octokit({ auth: token })` — likely works in Node.js
     (Octokit is designed for both environments) but unproven in this
     codebase's Vercel setup.
   - **Raw fetch:** call `api.github.com` endpoints directly with
     `Authorization: token ${token}` headers, as `api/auth-callback.ts`
     already does. More verbose but zero library risk.
3. Executes the Git Data API sequence on a test branch:
   a. `GET /repos/{owner}/{repo}/git/ref/heads/{branch}` — current HEAD SHA
   b. `GET /repos/{owner}/{repo}/git/commits/{sha}` — base tree SHA
   c. `POST /repos/{owner}/{repo}/git/blobs` × 2 — create test file blobs
   d. `POST /repos/{owner}/{repo}/git/trees` — new tree referencing blobs
   e. `POST /repos/{owner}/{repo}/git/commits` — commit with message
   f. `PATCH /repos/{owner}/{repo}/git/refs/heads/{branch}` — advance ref
4. Returns the commit SHA and URL for manual verification.

**Success criteria:**

- Commit appears correctly in the GitHub repo.
- Execution time is within Vercel timeout (measure; expect <5s for 2 files).
- No `btoa`/`atob` errors (these are browser-only; the spike must use
  `Buffer.from(content).toString('base64')` instead).

**Decision after spike:** Octokit vs raw fetch. If Octokit works cleanly,
use it (matches `gitService.ts` patterns, less code). If it has issues
(bundle size, initialisation quirks), use raw fetch (proven in existing
routes).

**Platform-agnostic Git Data API extraction:**

Regardless of Octokit vs fetch, extract the core commit logic into a
shared utility (e.g. `lib/git-commit.ts`):

```
async function atomicCommitFiles(
  octokit_or_fetcher,   // GitHub API client (Octokit instance or fetch wrapper)
  owner, repo, branch,  // target
  files: Array<{ path: string; content: string }>,
  message: string
): Promise<{ sha: string; url: string }>
```

This function encapsulates the 6-step Git Data API sequence. Both the
webhook handler (server-side) and potentially `gitService.ts` (browser-side,
future refactor) can use it. The browser-specific concerns (`btoa`, event
dispatch, progress callbacks) stay in `gitService.ts`'s wrapper.

#### Part B: Webhook handler (`/api/bayes-webhook.ts`)

**After the spike proves the Git Data API works server-side**, build the
full webhook handler.

**Request flow:**

1. **Decrypt callback token.** Extract `x-bayes-callback` header.
   Decrypt with `process.env.BAYES_WEBHOOK_SECRET` (AES-GCM). If
   decryption fails → 401 (tampered or invalid). If `expires_at` is
   past → 401 (stale token). Extract git credentials (owner, repo,
   token, branch, graph_file_path) from the decrypted payload.

2. **Parse payload.** Validate the JSON body against the webhook payload
   contract (see "Webhook payload contract" above). Reject with 400 if
   malformed. Verify `job_id` in body matches `job_id` in decrypted
   token.

3. **Idempotency check.** Search recent commits on the target branch for
   a commit message containing the `fingerprint`. If found, return 200
   with `{ status: 'already_committed', sha }`. This prevents duplicate
   commits from vendor retries.

4. **Authenticate to GitHub.** Use the git token from the decrypted
   callback token. No `SHARE_JSON` dependency — the user's own
   credentials are used, same as every other FE-initiated write.

5. **Read current files from git.** For each edge in the payload:
   a. Read the parameter file at `file_path` from the current branch HEAD
      (via Contents API or `git.getBlob`).
   b. Parse the YAML.
   Also read the graph file (the handler needs `graph_id` → graph file
   path; this mapping must be in the payload or derivable from the
   parameters index).

6. **Update parameter files.** For each edge:
   a. Merge `posterior` sub-object into the parameter YAML.
   b. Update `values[0].mean`, `values[0].stdev` to posterior mean/stdev.
   c. Update `latency.mu`, `latency.sigma` to posterior means.
   d. Update `latency.model_trained_at` to `fitted_at`.
   e. Preserve all other fields unchanged.

7. **Cascade to graph file.** Using the shared cascade module:
   a. For each fitted edge, find the matching graph edge (by `p.id`).
   b. Build a source object from the updated parameter data.
   c. Call `applyMappings(source, graphEdge, FILE_TO_GRAPH_MAPPINGS,
      { ignoreOverrideFlags: false })`.
   d. Apply the returned changes to the graph edge.
   e. Also set `p.posterior` on the graph edge (this is a new field, not
      part of the existing cascade mappings — add it to the mapping
      definitions in Step 2, or handle it as a direct field set in the
      webhook handler).

8. **Atomic commit with retry-with-rebase.** Using the extracted Git Data
   API utility, wrapped in a retry loop (max 3 attempts):
   a. Create blobs for all updated parameter files + the graph file.
   b. Create tree, commit, update ref — single commit.
   c. Use the commit message format defined in "Infrastructure components,
      §3" above.
   d. If `updateRef` returns HTTP 422 (not fast-forward), another webhook
      committed concurrently. Retry from step 5 (re-read files from the
      new HEAD, re-apply changes, re-commit). See "Webhook concurrency"
      above for full rationale.

9. **Return.** `{ status: 'committed', sha, files_updated, edges_fitted }`.

**Error handling:**

- GitHub API errors → 502 with error detail.
- YAML parse failure → 500 with the file path that failed.
- Callback token decryption failure → 401 (tampered or expired token).
- Concurrent commit retry exhausted (3 attempts) → 409 with detail.
- All errors include `job_id` in the response for correlation.

**Graph file path**: The webhook handler gets `graph_file_path` from the
decrypted callback token (the FE includes it when building the token). The
worker's POST body carries `graph_id` for correlation but does not need to
include the file path — it's already in the encrypted token.

**Testing the webhook handler:**

- **Local cURL test:** craft a JSON payload matching the contract, POST to
  `localhost:3000/api/bayes-webhook` with the correct secret header. Verify
  the commit appears in the repo with correct parameter + graph file changes.
- **Idempotency test:** POST the same payload twice. Second call returns
  `already_committed`.
- **Override test:** set `p.mean_overridden: true` on a graph edge before
  the test. Verify the webhook respects the flag and does not overwrite
  `p.mean` on that edge.
- **Malformed payload test:** POST invalid JSON, missing fields, wrong
  secret. Verify correct error codes.

### Step 4: Modal setup + dev harness + end-to-end spike

Deploy to Modal, build the FE dev harness, and prove the full roundtrip.

**4a. Modal app + trivial worker.**
- Create `bayes/app.py` with the three-component structure (see "Modal
  deployment structure" in the integration design above): submit web
  endpoint, fit_graph worker, status web endpoint.
- Image: `debian_slim(python_version="3.12").pip_install("numpy", "scipy",
  "pymc", "arviz", "requests", "pyyaml", "psycopg2-binary")`.
- No Modal Secrets needed. The worker receives `db_connection` in its
  spawn payload (passed through from the FE, which got it from the Vercel
  config endpoint).
- Deploy: `modal deploy bayes/app.py`.
- Verify: cold start time, Neon DB connectivity from worker (connection
  string via payload), scientific stack imports.

**4b. Modal status web endpoint.**
- `@modal.web_endpoint` on a function that calls
  `FunctionCall.from_id(call_id).get(timeout=0)`.
- No additional auth needed — `call_id` is an unguessable UUID that
  serves as a capability token. Called directly by the FE.
- Returns enriched response: `{ status, result? }` where `result` is the
  full worker return value (diagnostics, quality, log, webhook response).
  See "Progress visibility and worker diagnostics" above.
- Deployed as part of the same `bayes/app.py`.

**4c. Vercel routes and config.**
- New `api/bayes-config.ts` (TS GET route). Returns three values from
  env: `{ webhook_url, webhook_secret, db_connection }`.
- New `api/bayes-webhook.ts` (TS POST route). Minimal initial version:
  decrypt callback token, validate, commit a placeholder file to git via
  Git Data API (proves the full auth chain). Full parameter file merging
  and cascade logic added in Step 5.
- Add rewrites in `vercel.json`:
  `/api/bayes/config` → `api/bayes-config`,
  `/api/bayes-webhook` → `api/bayes-webhook`.
- Add `maxDuration` for the webhook handler in `vercel.json`:
  `"functions": { "api/bayes-webhook.ts": { "maxDuration": 60 } }`.
  (Fluid Compute is enabled on the DagNet deployment — Hobby plan gives
  300s default. The explicit `maxDuration: 60` is self-documenting and
  prevents accidental timeout if Fluid Compute were ever disabled.)
- Configure Vercel env vars: `BAYES_WEBHOOK_SECRET`, `BAYES_WEBHOOK_URL`,
  `DB_CONNECTION` (already exists for snapshot routes).
- No Vercel submission route — the FE calls Modal directly.

**4d. Dev harness (FE test button).**

A dev-only UI for triggering and monitoring Bayes roundtrips during
development. Lives in the menu bar's `dagnet-right-controls` container,
next to the existing `DevConsoleMirrorControls` — same `import.meta.env.DEV`
guard pattern.

Components:
- `DevBayesTrigger.tsx` — rendered in `MenuBar.tsx` inside
  `dagnet-right-controls`, guarded by `import.meta.env.DEV`.
- A button labelled "Bayes" (or similar). On click:
  1. Fetch config from `/api/bayes/config` (cache in session memory).
  2. Encrypt the current user's git creds into a callback token.
  3. Build a submission payload from the currently open graph (graph
     snapshot, parameters index, parameter files — all available locally).
  4. POST to Modal `/submit`. Log `BAYES_FIT_SUBMITTED` via
     `sessionLogService`.
  5. Start polling Modal `/status` every ~10s. Update button state
     (submitted → running → complete/failed). Register an operation via
     `operationRegistryService` so the OperationsToast shows progress.
  6. On `vendor-complete`: auto-pull, log result diagnostics from the
     enriched status response.
- Status indicator: the button shows current state (idle / submitted /
  running / complete / failed) via colour or icon. Clicking while a job
  is running shows the job_id and elapsed time.
- Requires: a graph must be open and the user must have git credentials
  in IDB. Button disabled otherwise.

This harness is the primary testing tool for Steps 4–5. It exercises the
full roundtrip: FE → config fetch → encrypt → Modal submit → worker →
webhook → git commit → FE poll → pull. It becomes the basis for the
production on-demand fit trigger later (Step 6).

**4e. End-to-end spike.**
- Use the dev harness button to trigger a roundtrip against the currently
  open graph.
- FE fetches config from `/api/bayes/config` → encrypts git creds →
  POSTs directly to Modal `/submit` → Modal spawns worker → worker
  connects to Neon, builds placeholder payload → POSTs to
  `/api/bayes-webhook` with encrypted callback token → webhook decrypts,
  commits to git → FE polls Modal `/status` and sees `complete` → FE
  pulls and sees commit.
- Verify in the session log: full lifecycle events with worker
  diagnostics (duration, edges, quality, log, commit SHA).
- Verify in the Modal dashboard: worker stdout/stderr visible.
- This is the full roundtrip. If this works, the infrastructure is proven.

### Step 5: Webhook hardening + full parameter writes
After the spike proves the roundtrip with placeholder commits:
- Upgrade the webhook handler to do real parameter file merging (read
  YAML, merge posteriors, update point estimates).
- Add cascade to graph file via the shared isomorphic cascade module
  (from Step 2).
- Add retry-with-rebase for concurrent webhooks.
- Harden the FE submission path: input validation on Modal's `/submit`,
  error handling for Modal failures, Vercel config endpoint validation.

### Step 6: Automation integration
Extend `useURLDailyRetrieveAllQueue` (or a parallel hook) to:

1. On first Bayes trigger, fetch config from `/api/bayes/config` (cache
   in session memory).
2. After each graph's fetch+commit, encrypt the user's git creds into a
   callback token (using `webhook_secret` from config), then submit
   directly to Modal `/submit`. Collect `{ job_id, graph_id }`.
3. After all fetches complete, enter a poll loop: query Modal `/status`
   for each pending job every ~15s (direct calls, no Vercel proxy).
4. When all jobs are complete/failed/timed-out, pull once to pick up all
   webhook commits.
5. Scan commit messages for `[bayes]` markers, match to job_ids, transition
   to `committed` state.
6. Log lifecycle events via `sessionLogService` (submitted, running, complete,
   failed, summary).

The dev harness (Step 4d) already exercises the core submission + polling +
logging flow. Step 6 wires the same logic into the automation cycle with
concurrent dispatch and batch polling.

The existing hook's progress tracking, abort handling, cross-tab locking, and
wall-clock-aware timing provide the scaffolding. The Bayes polling phase
slots in after the existing fetch loop and before auto-close.

### Step 7: IDB job persistence and boot reconciliation

**After the core roundtrip is proven and FE integration works with ephemeral
job records (Steps 4–6)**, harden job tracking by persisting to IDB.

**Why this is a separate step:** Steps 4–6 use in-memory job records. This
is sufficient for the primary use case (nightly automation, window stays
open). IDB persistence handles the edge cases: browser closes mid-fit, page
refresh, app reopened before fits complete.

**7a. IDB table `bayesFitJobs`.**

Add a new table to `appDatabase.ts`:

```
{
  jobId,               // Modal call_id (primary key)
  graphId,             // which graph was fitted
  graphFileId,         // workspace-prefixed file ID
  repo, branch,        // target
  submittedAtMs,       // epoch ms
  status,              // submitted | running | vendor-complete | committed | failed
  lastPolledAtMs,      // epoch ms
  result?,             // worker return value (diagnostics, quality, log)
  commitSha?,          // from webhook_response in result
  error?,              // error string if failed
}
```

**7b. Persistence lifecycle.**

- On submission: write record with `status: submitted`.
- On each status poll: update `status` and `lastPolledAtMs`.
- On `vendor-complete`: store `result` from the enriched status response.
- On `committed` (commit SHA matched after pull): update `status`, store
  `commitSha`.
- On failure: store `error`, update `status`.
- Prune records older than 7 days (matches Modal's result retention).

**7c. Boot reconciliation.**

On app boot (or page refresh), query IDB for records with `status` in
`[submitted, running]`. For each:

1. Poll Modal `/status` using the stored `jobId` (call_id). Modal retains
   results for 7 days, so this works even if the browser was closed for
   hours.
2. If `complete`: trigger a pull to pick up the webhook commit. Transition
   to `committed` if commit found, or `failed (no commit)` if not.
3. If `running`: resume polling loop.
4. If Modal returns an expired/unknown result (>7 days old): mark
   `failed (expired)`.

This means a user who closes the browser and reopens it the next morning
sees: "Bayes fit for graph X completed at 02:15, commit abc123" — not
silence.

**7d. operationRegistryService integration.**

On boot, if reconciliation finds pending or recently completed jobs, surface
them via `operationRegistryService` so the OperationsToast shows status
without the user needing to check the session log.

---

## Future data channels (design reasoning)

**Status**: Reasoned through, not part of initial phasing. Documented here to
ensure the data architecture is resilient to these needs when they arise.

Neither channel below requires infrastructure changes — the submission payload
is a JSON object with optional fields, so adding new data is
backward-compatible. The webhook already writes to parameter files and commits
them. These designs exploit existing mechanisms rather than introducing new ones.

### Per-parameter fit guidance (`fit_guidance`)

**Problem**: Users will need to guide the Bayes engine — exclude anomalous
periods (production incidents, holiday traffic), signal expected regime changes,
or override the default halflife per parameter. Today `settings.yaml` has a
global halflife, but that's insufficient for per-parameter or per-period control.

**Design**: Guidance lives in the parameter file itself, in a `fit_guidance`
section. No new file types are introduced.

```yaml
# In a parameter file, e.g. parameters/conversion-rate.yaml
fit_guidance:
  halflife_days: 30                    # override global default for this param
  exclusion_windows:
    - label: "Christmas 2025"
      from: 20-Dec-25
      to: 3-Jan-26
      reason: "Seasonal anomaly — non-representative traffic patterns"
    - label: "Checkout outage"
      from: 7-Mar-26
      to: 9-Mar-26
      reason: "Production incident — conversion dropped to near zero"
  regime_changes:
    - at: 1-Feb-26
      description: "New checkout flow launched — expect distribution shift"
  notes: "High-variance parameter; consider wider priors"
```

**Key properties**:

- **Per-parameter**: Each parameter file carries its own guidance. The Bayes
  engine reads it alongside the evidence data it already consumes from the same
  file.

- **Graph-wide guidance via cascade**: Graph-level guidance (e.g. "exclude
  Christmas across all parameters") is expressed on the graph file and cascaded
  to parameter files via the existing graph→parameter cascade machinery. This
  avoids duplicating exclusion windows across dozens of parameter files manually.

- **No infra changes**: Guidance is already part of the parameter file, which is
  already in the submission payload (parameter files are committed to git and
  referenced from the parameters index). The Bayes engine receives it
  automatically.

- **Exclusion windows**: Defined as date ranges with labels and reasons. The
  engine treats data points within these windows as missing/excluded when
  fitting. The `from`/`to` dates use the standard `d-MMM-yy` format.

- **Regime changes**: Signal that the underlying distribution is expected to
  shift at a given date. The engine may use this to reset or widen priors, or
  to weight post-change data more heavily. Exact engine behaviour is a modelling
  decision, not an infrastructure one.

- **UI**: Users manage guidance through the existing parameter properties panel.
  For graph-wide guidance, the graph properties panel provides bulk controls
  that cascade down. Iteration over parameters where guidance is set/unset is
  handled via the existing navigator UI.

- **Validation**: The webhook handler (or the Bayes engine itself) validates
  guidance structure. Malformed guidance produces a clear error in the job
  result rather than a silent misfit.

### Historic model parameter trajectories (`fit_history`)

**Problem**: The Bayes engine (and users reviewing fit quality) may need to see
how fitted model parameters have varied over time — e.g. whether a distribution
is stable, drifting, or volatile. This trajectory data helps the engine
calibrate prior widths and detect regime changes automatically.

**Why git archaeology is impractical**: Parameter files are not trivially small.
Files with daily evidence arrays (n_daily, k_daily, dates, lag arrays, anchor
arrays — ~120 data points × 8 arrays per value entry) reach 4,000–7,100 lines
/ up to ~250 KB. Fetching historical versions via the GitHub API requires
downloading the full blob for each file at each commit. For 90 days of history
across 30 parameters, that's potentially ~22 MB+ of YAML to download and parse
per parameter — even with GraphQL batching (which batches call count, not blob
size). This is not viable as a routine pre-fit operation.

**Design**: The webhook appends a compact summary entry to a `fit_history`
array in each parameter file as part of the same write-and-commit operation it
already performs after each fit.

```yaml
# Appended to each parameter file by the webhook after fitting
fit_history:
  - fitted_at: 16-Mar-26
    fingerprint: "sha256:abc123..."     # hash of input evidence used
    mean: 0.42
    stdev: 0.08
    mu: 2.1
    sigma: 0.4
  - fitted_at: 15-Mar-26
    fingerprint: "sha256:def456..."
    mean: 0.41
    stdev: 0.09
    mu: 2.0
    sigma: 0.42
  # ... trimmed to last N entries (e.g. 90 days)
```

**Key properties**:

- **Zero extra API calls**: The FE already loads current parameter files before
  submission. `fit_history` is right there in the file — no additional fetches,
  no git API calls, no separate storage system.

- **Webhook writes it for free**: The webhook already reads the parameter file,
  updates fitted values, and commits. Appending a ~5-line summary entry to
  `fit_history` is trivial additional work in the same write operation.

- **Compact**: ~5 lines per entry × 90 days = ~450 lines. On a 7,000-line
  parameter file, that's roughly a 6% size increase — negligible.

- **Self-trimming**: The webhook trims entries older than N days (configurable,
  default 90) on each write. History doesn't grow unboundedly.

- **Fingerprint for cache/skip logic**: The `fingerprint` field (hash of the
  evidence data that was input to the fit) lets the engine detect when input
  data hasn't changed and skip unnecessary refitting.

- **Submission payload carries it automatically**: Because `fit_history` lives
  in the parameter file, and parameter files are already part of the submission
  payload, the Bayes engine receives the full trajectory without any payload
  schema changes.

**Fallback — git archaeology utility**: For backfill (populating `fit_history`
for the first time from existing git history) or diagnostic purposes, a
`getFieldHistory` utility can retrieve a specific YAML field from the N most
recent commits of a parameter file via the GitHub Contents API. This is a
one-off or occasional operation, not a routine pre-fit step:

- Fetches blob SHAs from commit history (lightweight — metadata only)
- Downloads and parses only the target field from each blob
- Expensive (full blob download per commit) but acceptable as an infrequent
  backfill tool

This utility is not part of the initial implementation. `fit_history` is
populated going forward by the webhook; backfill is a convenience for
bootstrapping history from the pre-`fit_history` era.

### Extensibility summary

| Future need | Where it lives | Infra changes required |
|---|---|---|
| Per-parameter fit guidance | `fit_guidance` in parameter file | None — already in payload |
| Graph-wide guidance | Graph file, cascaded to params | None — existing cascade machinery |
| Historic model trajectories | `fit_history` in parameter file | None — webhook appends on write |
| Backfill from git history | One-off `getFieldHistory` utility | None — FE-side helper, not infra |

The async infrastructure built in this document is resilient to all four needs.
No schema changes, no new API routes, no new storage systems. The parameter
file is the single location for both guidance input and trajectory output.

---

## Relationship to other docs

**Compute arch** (`3-compute-and-deployment-architecture.md`) covers the
deployment topology, vendor evaluation, shared code strategy, and DB access
patterns. This doc extracts the implementation-ready milestone from that
architectural context. Compute arch is the reference for *why* decisions were
made; this doc defines *what to build* and *how to verify it works*.

**Logical blocks**, **Model contract**, and **Reference impl** belong to the
Semantic foundation workstream. They have no dependency on this infrastructure
work and vice versa. Once both workstreams are complete, the inference logic
plugs into the worker entry point built here. The infrastructure does not
change when real inference replaces the placeholder.
