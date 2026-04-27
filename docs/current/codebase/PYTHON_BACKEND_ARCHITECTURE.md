# Python Backend Architecture

How the Python compute server works: API endpoints, MSMDC query generation, Bayesian inference, and frontend-backend communication.

## Server Framework

- **Framework**: FastAPI (async)
- **Dev server**: `graph-editor/dev-server.py` (localhost:9000)
- **Production**: Vercel serverless Python functions at `/api/*`
- **Bayes service**: Modal-deployed app (`bayes/app.py`) for distributed MCMC computation

All endpoints route through handler functions in `lib/api_handlers.py`, reusable across dev server and Vercel.

## Deployment Targets and Shared-Library Boundary

DagNet ships Python code to **three runtime targets**:

- **Vercel API** — entry point `graph-editor/api/python-api.py`
- **Local dev API** — entry point `graph-editor/dev-server.py`
- **Modal Bayes worker** — entry points `bayes/app.py` and `bayes/worker.py`

Boundary rule:

- If Python logic is consumed by both the API layer and the Bayes worker, it belongs in **`graph-editor/lib/`**
- If logic is Bayes-only (compiler, model construction, inference, worker orchestration), it belongs in **`bayes/`**
- Entry points may do runtime-specific import wiring (`PYTHONPATH`, `sys.path`) but the shared modules themselves should stay runtime-agnostic

This is why modules such as `snapshot_service.py`, `query_dsl.py`, `graph_types.py`, `snapshot_regime_selection.py`, and `file_evidence_supplement.py` live in `graph-editor/lib/`: they are shared between short-lived API deployments and the long-running Bayes worker.

The Modal image copies `graph-editor/lib/` into the worker image and adds it to `PYTHONPATH`; Vercel and the dev server prepend the same directory before importing handlers. That packaging detail is an entry-point concern, not a reason to duplicate shared code under `bayes/` or `api/`.

One intentional exception in the opposite direction: `graph-editor/lib/bayes_local.py` is a local-dev adapter that shells into the Bayes worker codepath. Treat it as an entry-point bridge, not as precedent for putting shared business logic in the wrong tree.

## Frontend-Backend Communication

**Client**: `src/lib/graphComputeClient.ts` (singleton)

- Auto-configures baseUrl from `PYTHON_API_BASE`:
  - Dev: `http://{hostname}:9000` (or `VITE_PYTHON_API_URL` override)
  - Prod: empty string (same origin, Vercel serverless)
- Mock mode: `VITE_USE_MOCK_COMPUTE=true`
- 5-minute TTL cache (max 50 entries) for analysis results

Key client methods: `health()`, `parseQuery()`, `generateAllParameters()`, `enhanceStats()`, `analyzeSelection()`, `analyzeMultipleScenarios()`, `getAvailableAnalyses()`, `analyzeSnapshots()`

## API Endpoints

### Query and graph operations

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/api` | GET | Health check |
| `/api/parse-query` | POST | Parse DSL query string to structured constraints |
| `/api/query-graph` | POST | Apply topology filter (from/to/visited) to graph |
| `/api/generate-query` | POST | Generate single query for one edge (MSMDC algorithm) |
| `/api/generate-all-queries` | POST | Generate queries for all edges |
| `/api/python-api` | POST | Generate all parameter queries |

### Analysis and statistics

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/api/stats-enhance` | POST | Generic raw-aggregation enhancement (`mcmc`, `bayesian-complex`, `trend-aware`, `robust`) via `lib/stats_enhancement.py` |
| `/api/runner/analyze` | POST | Run analysis on snapshot data |
| `/api/runner/available-analyses` | POST | List available analysis types for a graph |

### Lag fit (time-to-conversion modelling)

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/api/lag/recompute-models` | POST | Recompute latency/lag fit models from snapshot DB evidence via `lib/runner/lag_model_fitter.py` |

### Bayes service (Modal)

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/api/bayes/submit` | POST | Submit graph for MCMC fitting, returns job_id |
| `/api/bayes/status` | GET | Poll job status with progress and result |
| `/api/bayes/cancel` | POST | Terminate running job |
| `/api/bayes/version` | GET | Deployed app version |

### Snapshot database (PostgreSQL/Neon)

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/api/snapshots/health` | GET | Test DB connection |
| `/api/snapshots/query` | POST | Query individual snapshot rows |
| `/api/snapshots/query-full` | POST | Full query with named parameters |
| `/api/snapshots/query-virtual` | POST | Query using materialised views |
| `/api/snapshots/append` | POST | Shadow-write time-series data after fetch |
| `/api/snapshots/inventory` | POST | List snapshots for parameters |
| `/api/snapshots/batch-retrieval-days` | POST | Distinct retrieved_day per param_id |
| `/api/snapshots/batch-anchor-coverage` | POST | Missing anchor-day ranges (Retrieve All preflight) |
| `/api/snapshots/retrievals` | POST | Distinct retrieval timestamps for a parameter |
| `/api/snapshots/delete` | POST | Delete all snapshots for a parameter |

### Signature registry

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/api/sigs/list` | POST | List all signatures for a parameter |
| `/api/sigs/get` | POST | Retrieve signature entry by param_id + core_hash |

### Cache management

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/api/cache/clear` | POST | Clear the snapshot service result cache; returns pre-clear stats |
| `/api/cache/stats` | GET | Return current cache statistics (non-destructive) |

## Connection Pooling and Result Cache

Added 7-Apr-26. Module-level infrastructure in `lib/snapshot_service.py` that survives across warm Vercel invocations.

### Vercel function lifecycle

- Warm instances persist ~5–15 min of inactivity; module-level globals survive across requests within the same instance.
- **No sticky routing**: sequential requests from the same browser can hit any available warm instance. Each instance has its own isolated pool and cache.
- **Fluid Compute** (default on Pro): single instance handles multiple concurrent requests, maximising cache hit rate and connection reuse.
- Cold start = fresh pool + empty cache. Instance death = everything gone.

### Connection pool

`psycopg2.pool.SimpleConnectionPool(minconn=1, maxconn=2)` at module level. Avoids TCP+TLS handshake to Neon on every request.

- `_PooledConnection` context manager borrows from pool, returns on exit.
- Stale connection detection: executes `SELECT 1` on borrow; if it fails, discards and gets a fresh connection.
- Thread-safe via `_pool_lock`.
- Legacy `get_db_connection()` kept for backward compatibility; all production paths use `_pooled_conn()`.

### TTL result cache

Module-level dict: `_cache[key] → (expiry_timestamp, result)`.

- **Default TTL**: 15 minutes (matches Vercel warm lifetime).
- **Max entries**: 256, with LRU eviction (oldest expiry dropped).
- **Cache key**: SHA256 prefix of `json.dumps({fn_name, args, kwargs}, sort_keys=True, default=str)`.
- **Thread-safe** via `_cache_lock`.

**Cached functions** (all read paths): `query_snapshots`, `query_snapshots_for_sweep`, `query_virtual_snapshot`, `get_batch_inventory`, `get_batch_inventory_rich`, `get_batch_inventory_v2`, `batch_anchor_coverage`, `query_snapshot_retrievals`, `query_batch_retrieval_days`, `query_batch_retrievals`, `list_signatures`, `get_signature`.

**Not cached**: `health_check` (must test real connection), `append_snapshots` and `delete_snapshots` (write paths).

### Cache invalidation

- **Write-path**: `append_snapshots` and `delete_snapshots` call `cache_clear()` after successful commit. Full cache nuke — any write can change what any read returns.
- **Explicit**: `cache_clear()` function exposed via `/api/cache/clear` endpoint. For dev/testing after manual DB edits.
- **TTL expiry**: entries older than 15 min are misses.
- **Cold start**: empty cache on new instance.

**FE does not need to trigger cache busting in normal workflows.** Write-path invalidation covers all standard flows (fetch-and-store, delete). The explicit endpoint is for dev/ops only.

### Observability

- `health_check()` response includes cache stats (`hits`, `misses`, `evictions`, `entries`).
- `/api/cache/stats` returns the same stats non-destructively.
- `/api/cache/clear` returns stats before clearing, plus `entries_cleared` count.

## MSMDC Computation (lib/msmdc.py)

**Minimal Set of Maximally Discriminating Constraints** -- auto-generates optimal query strings for data retrieval by finding the minimal constraint set that uniquely identifies a target path.

### Algorithm (witness-guided)

1. **Anchor**: from(edge.from) --> to(edge.to)
2. **Discriminate**: using constrained reachability, iteratively identify "violating" journeys (paths that don't use the direct edge)
3. **Add constraints**: visited() / exclude() nodes until no violating journey exists
4. **Complexity**: multiple DAG reachability checks, avoids 2^k explosion

### Core functions

- `generate_query_for_edge(graph, edge, condition, ...)` --> MSMDCResult with query_string, constraints, coverage_stats
- `generate_all_parameter_queries(graph, ...)` --> list of ParameterQuery
- `compute_anchor_node_id(graph, edge)` --> furthest upstream START node (for cohort queries)

## Bayesian Computation

### Architecture

- **Frontend** calls `/api/bayes/submit` with graph + parameter files
- **Worker** spawns in Modal container (4 CPU, 600s timeout)
- **Progress** reported via modal.Dict, polled by `/api/bayes/status`
- **Result** delivered via webhook callback with posteriors + quality metrics

### Local dev (`lib/bayes_local.py`)

Mirrors Modal API with threading-based job spawning. Same `submit/status/cancel` interface.

### Async roundtrip (FE → Modal → webhook → git)

Full cycle from user trigger to persisted posteriors:

1. **FE trigger**: `useBayesTrigger.ts` calls `/api/bayes/submit` with graph topology, parameter files, and an encrypted callback token
2. **Modal dispatch**: `bayes/app.py` `/submit` endpoint spawns a worker via `modal.Function.spawn()`, returns `job_id`
3. **FE polling**: `useBayesTrigger.ts` polls `/api/bayes/status` every 5s until completion
4. **Worker execution**: `bayes/worker.py:fit_graph()` runs the compiler pipeline (see below), fires webhook on completion
5. **Webhook → atomic git commit**: `api/bayes-webhook.ts` receives posteriors, writes a patch file (`_bayes/patch-{job_id}.json`), commits atomically via GitHub Git Data API (`atomicCommitFiles`). Retry-with-rebase on 422 conflict.
6. **FE pull + patch apply**: `useBayesTrigger.ts` detects completion, pulls the commit, applies the patch locally via `bayesPatchService.ts:applyPatchAndCascade()`

If the browser closes mid-run, the webhook still commits. On next boot, `bayesPatchService.ts:scanForPendingPatches()` detects unapplied patches in `_bayes/` and applies them.

### Compiler pipeline (`bayes/compiler/`)

The compiler translates graph topology into a Bayesian model and runs MCMC inference. Five modules form a strict pipeline:

| Stage | Module | Input | Output |
|-------|--------|-------|--------|
| 1. Topology | `topology.py` | Graph JSON | `TopologyAnalysis` — edges, branch groups, paths, reachability |
| 2. Evidence | `evidence.py` | TopologyAnalysis + param files + snapshot DB | `BoundEvidence` — per-edge observations with recency weights |
| 3. Model | `model.py` | BoundEvidence + settings | PyMC model (Beta/Binomial, Dirichlet, latent onset, latency CDF) |
| 4. Inference | `inference.py` | PyMC model | MCMC samples via nutpie (4 chains, 1000 draws). Always uses `gradient_backend='pytensor'` — see doc 39 |
| 5a. LOO | `loo.py` | Samples + evidence | Per-edge LOO-ELPD vs analytic null (doc 32) |
| 5b. PPC | `calibration.py` | Samples + evidence | Per-edge coverage@90%, PIT uniformity (doc 38). Opt-in via `--diag` |
| 6. Summary | `inference.py` | Samples + LOO + PPC | `PosteriorSummary` per edge — HDI, ESS, rhat, LOO, PPC, evidence grade |

The pipeline runs twice per fit (**two-phase model**):
- **Phase 1 (window)**: fits window() observations only. Extracts posterior point estimates (p_alpha/beta, mu/sigma/onset with SDs).
- **Phase 2 (cohort)**: uses Phase 1 posteriors as priors (ESS-decayed Beta/Dirichlet via `_ess_decay_scale()`), fits cohort() observations with frozen Phase 1 latency. `worker.py:557-877` orchestrates.

Key implemented features:
- **Latent onset**: per-edge learned onset (feature flag `latent_onset=True`, default on). Onset estimated via MCMC, not fixed from histogram.
- **Recency weighting**: `_apply_recency_weights()` in evidence.py applies `exp(-ln2 * age / half_life_days)` to each trajectory.
- **Zero-count filter**: likelihood-lossless removal of bins where neither y nor x changed (`zero_count_filter` flag, default True).
- **Snapshot evidence**: `bind_snapshot_evidence()` queries snapshot DB directly, falls back to param files per edge. Merges trajectories with supplemental daily observations.
- **Join-node mixture CDF**: `completeness.py:moment_matched_collapse()` builds mixture CDF at join nodes with moment matching. Differentiable PyTensor variant (`pt_moment_matched_collapse`) for MCMC gradients.
- **Unified MCMC kappa**: single dispersion parameter per edge with LogNormal prior. Prior centre: (1) warm-start from previous posterior, (2) BetaBinomial MLE from endpoint data (empirical Bayes, doc 38), (3) default log(30). The MLE prior adapts to the data rather than imposing a fixed centre.
- **PPC calibration** (`calibration.py`): posterior predictive coverage check — are the model's 90% intervals honest? Two categories: endpoint/daily (tests κ) and trajectory intervals (tests κ_lat). Opt-in via `--diag` flag. On synth graphs, computes true PIT from ground truth for machinery validation. See doc 38.
- **Quality-gated warm-start**: previous posteriors used as priors only if rhat < 1.10 and ESS >= 100.
- **Phase C contexted models**: per-slice hierarchy with native vector RVs (`eps_slice_vec`, `log_kappa_slice_vec`, `eps_mu_slice_vec` — shape `[n_slices]`) replacing per-slice scalar nodes. sigma and onset are edge-level (shared across slices). Phase 1 window trajectories batched into one `pm.Potential` per edge via `_emit_batched_window_trajectories()`. Slice-axis metadata in `build_model` return dict maps `ctx_key → slice_idx` for posterior extraction. See doc 38c.
- **Low-rank mass matrix**: `inference.py` always uses `PyNutsSettings.LowRank`. Captures parameter correlations (tau-eps funnels in contexted models, onset-mu ridges in all latency models) that diagonal mass matrices cannot, yielding ~50% larger step sizes and ~70% fewer leapfrog steps per draw.

### Quality gates

- Rhat < 1.01 (convergence)
- ESS > min_ess (effective sample size)
- Divergences < threshold
- Evidence grade >= 1

### FE posterior overlay components

| Component | File | Role |
|-----------|------|------|
| `BayesPosteriorCard` | `src/components/analytics/BayesPosteriorCard.tsx` | Renders probability + latency posteriors with quality tier, HDI, ESS, freshness |
| `PosteriorIndicator` | `src/components/shared/PosteriorIndicator.tsx` | Reusable badge + hover popover with convergence warnings |
| `bayesQualityTier` | `src/utils/bayesQualityTier.ts` | Computes quality tier: failed/warning/good-0..3/no-data with colour palette |
| `useBayesTrigger` | `src/hooks/useBayesTrigger.ts` | Full roundtrip orchestration: submit, poll, webhook, patch apply |

Quality tier overlay mode colour-codes edges in `ConversionEdge.tsx` and `EdgeBeads.tsx`. `AnalysisInfoCard` Forecast tab shows full posterior diagnostics per edge.

### Automation (nightly Bayes fit)

`bayesReconnectService.ts` (426 lines) and `bayesPatchService.ts` (721 lines) implement the 3-phase automation pipeline:

- **Phase 0**: apply any pending patches from previous runs
- **Phase 1**: fetch new data + commission Bayes fit
- **Phase 2**: drain — poll until completion, apply results

Integrated into `dailyAutomationJob.ts`. `runBayes` graph-level flag controls opt-in. Scheduler persistence via `reconcileBayesFitJob` with probe grace periods and stale cutoff thresholds.

## Shared Data Types

### Query DSL (`lib/query_dsl.py`)

`ParsedQuery`: from_node, to_node, exclude[], visited[], visited_any[][], context[], window, cases[], minus[], plus[]

### Evidence (`lib/graph_types.py`)

n, k, mean, stdev, scope_from/to, source, full_query, debug_trace

### Bayesian posteriors (`lib/graph_types.py`)

SlicePosteriorEntry: alpha, beta_param, p_hdi_lower/upper, mu/sigma mean/sd, onset mean/sd, ess, rhat, divergences, evidence_grade, provenance

### Snapshot database schema

- `signature_registry`: param_id, core_hash, canonical_signature, inputs_json, sig_algo
- `snapshot_data`: param_id, core_hash, slice_key, anchor_day, retrieved_at, A, X, Y, median_lag_days, mean_lag_days, onset_delta_days

## Key Files

| File | Role |
|------|------|
| `lib/api_handlers.py` | All endpoint handler functions |
| `lib/file_evidence_supplement.py` | Shared uncovered-day evidence supplement used by API + Bayes |
| `lib/graph_types.py` | Pydantic models (Evidence, Latency, Posteriors) |
| `lib/msmdc.py` | MSMDC query generation algorithm |
| `lib/query_dsl.py` | DSL parsing and compilation |
| `lib/bayes_local.py` | Local Bayes service (dev) |
| `lib/snapshot_service.py` | Snapshot DB queries (PostgreSQL/Neon) |
| `lib/stats_enhancement.py` | Generic `/api/stats-enhance` helpers for raw-aggregation enhancement (trends, MCMC-style summaries, robust stats) |
| `lib/runner/lag_model_fitter.py` | Snapshot-evidence lag model fitting behind `/api/lag/recompute-models` |
| `lib/graph_select.py` | Graph topology filtering |
| `src/lib/graphComputeClient.ts` | Frontend client (caching, mock mode) |
| `src/lib/pythonApiBase.ts` | Base URL resolution |
| `graph-editor/dev-server.py` | Dev server startup |
| `bayes/app.py` | Modal image + worker deployment wiring |
| `bayes/worker.py` | Bayes worker entry point |

## Related Docs

- **`DATA_SOURCES_REFERENCE.md`** — All external data sources (Amplitude, Google Sheets, Statsig, PostgreSQL), credential types, fetch modes, and schema file catalogue
- **`ANALYSIS_TYPES_CATALOGUE.md`** — What each analysis type computes, including snapshot-based types routed through this backend
