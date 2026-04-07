# Python Backend Architecture

How the Python compute server works: API endpoints, MSMDC query generation, Bayesian inference, and frontend-backend communication.

## Server Framework

- **Framework**: FastAPI (async)
- **Dev server**: `graph-editor/dev-server.py` (localhost:9000)
- **Production**: Vercel serverless Python functions at `/api/*`
- **Bayes service**: Modal-deployed app (`bayes/app.py`) for distributed MCMC computation

All endpoints route through handler functions in `lib/api_handlers.py`, reusable across dev server and Vercel.

## Frontend-Backend Communication

**Client**: `src/lib/graphComputeClient.ts` (singleton)

- Auto-configures baseUrl from `PYTHON_API_BASE`:
  - Dev: `http://{hostname}:9000` (or `VITE_PYTHON_API_URL` override)
  - Prod: empty string (same origin, Vercel serverless)
- Supports mock mode: `VITE_USE_MOCK_COMPUTE=true`
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
| `/api/stats-enhance` | POST | Generic raw-aggregation enhancement (`mcmc`, `bayesian-complex`, `trend-aware`, `robust`) via `lib/stats_enhancement.py`; distinct from the analytic topo pass |
| `/api/runner/analyze` | POST | Run analysis on snapshot data |
| `/api/runner/available-analyses` | POST | List available analysis types for a graph |

### Lag fit (time-to-conversion modelling)

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/api/lag/recompute-models` | POST | Recompute latency/lag fit models from snapshot DB evidence via `lib/runner/lag_model_fitter.py` |
| `/api/lag/topo-pass` | POST | Live BE analytic topo pass: Python port of the FE Stage-2 / `enhanceGraphLatencies` flow via `lib/runner/stats_engine.py` |

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

### Vercel function lifecycle (context for design)

- Warm instances persist ~5–15 min of inactivity; module-level globals survive across requests within the same instance.
- **No sticky routing**: sequential requests from the same browser can hit any available warm instance. Each instance has its own isolated pool and cache.
- **Fluid Compute** (enabled by default on Pro): a single instance handles multiple concurrent requests, which maximises cache hit rate and connection reuse.
- Cold start = fresh pool + empty cache. Instance death = everything gone.

### Connection pool

`psycopg2.pool.SimpleConnectionPool(minconn=1, maxconn=2)` at module level. Avoids TCP+TLS handshake to Neon on every request.

- `_PooledConnection` context manager borrows from pool, returns on exit.
- Stale connection detection: executes `SELECT 1` on borrow; if it fails, discards and gets a fresh connection.
- Thread-safe via `_pool_lock`.
- Legacy `get_db_connection()` kept for backward compatibility but all production paths now use `_pooled_conn()`.

### TTL result cache

Module-level dict: `_cache[key] → (expiry_timestamp, result)`.

- **Default TTL**: 15 minutes (matches Vercel warm lifetime).
- **Max entries**: 256, with LRU eviction (oldest expiry dropped).
- **Cache key**: SHA256 prefix of `json.dumps({fn_name, args, kwargs}, sort_keys=True, default=str)`.
- **Thread-safe** via `_cache_lock`.

**Cached functions** (all read paths): `query_snapshots`, `query_snapshots_for_sweep`, `query_virtual_snapshot`, `get_batch_inventory`, `get_batch_inventory_rich`, `get_batch_inventory_v2`, `batch_anchor_coverage`, `query_snapshot_retrievals`, `query_batch_retrieval_days`, `query_batch_retrievals`, `list_signatures`, `get_signature`.

**Not cached**: `health_check` (must test real connection), `append_snapshots` and `delete_snapshots` (write paths).

### Cache invalidation

- **Write-path**: `append_snapshots` and `delete_snapshots` call `cache_clear()` after successful commit. This is a full cache nuke — simple and correct, since any write can change what any read returns.
- **Explicit**: `cache_clear()` function exposed via `/api/cache/clear` endpoint. Useful for dev/testing after manual DB edits.
- **TTL expiry**: entries older than 15 min are treated as misses.
- **Cold start**: empty cache on new instance.

**FE does not need to trigger cache busting in normal workflows.** Write-path invalidation covers all standard flows (fetch-and-store, delete). The explicit endpoint is for dev/ops only.

### Observability

- `health_check()` includes cache stats in its response (`hits`, `misses`, `evictions`, `entries`).
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

### Worker pipeline

1. Topology analysis: extract path from graph, compute reachability
2. Evidence binding: aggregate k/n from parameter files by slice
3. PyMC model construction: Bayesian probabilistic model
4. MCMC inference: sample posterior distribution
5. Quality check: Rhat, ESS, divergence metrics; assign evidence grade
6. Webhook report: POST posteriors and quality metrics

### Quality gates

- Rhat < 1.01 (convergence)
- ESS > min_ess (effective sample size)
- Divergences < threshold
- Evidence grade >= 1

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
| `lib/graph_types.py` | Pydantic models (Evidence, Latency, Posteriors) |
| `lib/msmdc.py` | MSMDC query generation algorithm |
| `lib/query_dsl.py` | DSL parsing and compilation |
| `lib/bayes_local.py` | Local Bayes service (dev) |
| `lib/snapshot_service.py` | Snapshot DB queries (PostgreSQL/Neon) |
| `lib/stats_enhancement.py` | Generic `/api/stats-enhance` helpers for raw-aggregation enhancement (trends, MCMC-style summaries, robust stats) |
| `lib/runner/stats_engine.py` | Live BE analytic topo pass behind `/api/lag/topo-pass` |
| `lib/runner/lag_model_fitter.py` | Snapshot-evidence lag model fitting behind `/api/lag/recompute-models` |
| `lib/graph_select.py` | Graph topology filtering |
| `src/lib/graphComputeClient.ts` | Frontend client (caching, mock mode) |
| `src/lib/pythonApiBase.ts` | Base URL resolution |
| `graph-editor/dev-server.py` | Dev server startup |

## Related Docs

- **`DATA_SOURCES_REFERENCE.md`** — All external data sources (Amplitude,
  Google Sheets, Statsig, PostgreSQL), credential types, fetch modes, and
  schema file catalogue
- **`ANALYSIS_TYPES_CATALOGUE.md`** — What each analysis type computes,
  including snapshot-based types routed through this backend
