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
