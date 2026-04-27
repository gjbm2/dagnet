# GraphComputeClient (the FE↔Python boundary)

**File**: `graph-editor/src/lib/graphComputeClient.ts` (2,478 LOC)

The single TypeScript class that mediates every analysis, fetch, and stats call from the browser to the Python backend. Most other docs name-drop it; this doc explains its surface, its caching, its response normalisers, and the policies that govern when it bypasses cache.

**See also**: [PYTHON_BACKEND_ARCHITECTURE.md](PYTHON_BACKEND_ARCHITECTURE.md) (the BE side), [BE_RUNNER_CLUSTER.md](BE_RUNNER_CLUSTER.md) (where requests land), [CHART_PIPELINE_ARCHITECTURE.md](CHART_PIPELINE_ARCHITECTURE.md) (downstream consumer), [FE_BE_STATS_PARALLELISM.md](FE_BE_STATS_PARALLELISM.md) (CF race orchestration).

---

## 1. Identity and configuration

Singleton: `export const graphComputeClient = new GraphComputeClient()`. Imported wherever the FE needs the BE.

**Base URL resolution** (via `pythonApiBase.ts`):
- Dev: `http://${hostname}:9000` (or `VITE_PYTHON_API_URL` override)
- Production: `''` (same origin, Vercel serverless)

**Mock mode**: `VITE_USE_MOCK_COMPUTE=true` returns stubbed responses. Used for FE-only development.

## 2. The public method surface

| Method | Endpoint | Purpose |
|---|---|---|
| `health()` | `GET /` | Liveness check |
| `parseQuery(queryString)` | `POST /api/parse-query` | DSL → structured constraints |
| `generateAllParameters(graph, ...)` | `POST /api/generate-all-parameters` | MSMDC: queries for every edge |
| `enhanceStats(req)` | `POST /api/stats-enhance` | Generic raw-aggregation enhancement |
| `analyzeSelection(req)` | `POST /api/runner/analyze` | Single-scenario analysis |
| `analyzeMultipleScenarios(req)` | `POST /api/runner/analyze` | Multi-scenario analysis |
| `getAvailableAnalyses(graph, ...)` | `POST /api/runner/available-analyses` | Predicate-driven analysis-type list |
| `analyzeSnapshots(req)` | `POST /api/runner/analyze` | Snapshot-envelope dispatch (lag_histogram, daily_conversions, cohort_maturity, conversion_rate, surprise_gauge, lag_fit) |

The `/api/runner/analyze` endpoint is hit from three different methods because the request shape differs (single-scenario vs multi-scenario vs snapshot-envelope) and the response normalisation differs accordingly.

Conditioned-forecast (`POST /api/forecast/conditioned`) is *not* called from `graphComputeClient` — it lives on `conditionedForecastService.ts`. Lag-model recompute (`POST /api/lag/recompute-models`) is not on this client either; it has its own service.

## 3. The response-normalisation waterfall

This is the part that's invisible from the public docs but central to FE behaviour. The BE returns rows shaped per analysis type; the FE needs canonical `data` rows + a `result` block. Per-type normalisers handle the conversion:

```
analyzeSnapshots(request)
  ─ raw = await fetch(...)
  ─ normalised =
        normaliseSnapshotCohortMaturityResponse(raw, request)
     ?? normaliseSnapshotDailyConversionsResponse(raw, request)
     ?? normaliseSnapshotConversionRateResponse(raw, request)
     ?? normaliseSnapshotBranchComparisonResponse(raw, request)
     ?? normaliseSnapshotLagFitResponse(raw, request)
     ?? normaliseSnapshotSurpriseGaugeResponse(raw, request);
  ─ return { result: normalised }
```

Each normaliser is type-specific:

| Normaliser | Lines | Notes |
|---|---|---|
| `normaliseSnapshotCohortMaturityResponse` | ~440 | Per-tau rows, fan bands, model-curve overlay, latency bands, epoch boundaries |
| `normaliseSnapshotDailyConversionsResponse` | ~215 | E/F/N stacked-bar rows, dual rate lines, forecast dispersion bands |
| `normaliseSnapshotConversionRateResponse` | ~145 | Per-bin rate + epistemic block |
| `normaliseSnapshotBranchComparisonResponse` | ~280 | Branch traffic split with per-scenario series |
| `normaliseSnapshotSurpriseGaugeResponse` | ~165 | `scenario_results` + `focused_scenario_id` for the gauge UI |
| `normaliseSnapshotLagFitResponse` | ~115 | Observed vs model overlay rows |

These are the per-type FE seams that `adding-analysis-types.md` Step 8 instructs you to extend. The factory pattern in the analysis-types refactor proposal would consolidate them.

## 4. Caching

### Two distinct caches

The client maintains **two unrelated caches**:

1. **Result cache** (5-minute TTL, max 50 entries) — for analysis results. Keyed on a stable hash of the request including:
   - Graph node/edge **IDs and probability values** (so What-If changes invalidate)
   - Scenarios, DSL, analysis type, display settings
   - Snapshot subjects (signature-hashed via `snapshotSubjectsSignature()`)
2. **Snapshot subjects signature cache** — for cheap dedup of snapshot subject sets. Used in cache-key construction.

**Pruning**: when the cache exceeds `MAX_CACHE_SIZE`, oldest entries are dropped (`pruneCache<T>()`).

### Cache bypass

Three independent bypass paths:

| Trigger | Mechanism |
|---|---|
| `globalThis.__dagnetComputeNoCache = true` | Set by CLI `--no-cache` flag and by tests; checked on every request |
| `?nocache=1` / `?no-cache=1` / `?compute_nocache=1` URL param | URL-driven dev bypass |
| `clearCache()` timestamp | Records a wall-clock; entries older than the timestamp are treated as misses |

When bypass is active, the client appends `?no-cache=1` to the analyze URL **and** sets `no_cache: true` in the request body — keeping URL and body in lockstep so the BE sees a consistent signal regardless of which middleware reads the request first.

The BE side honours `no_cache` via `cache_bypass_ctx()` in `api_handlers.py`, which clears the snapshot service TTL cache for the duration of the request. See [PYTHON_BACKEND_ARCHITECTURE.md](PYTHON_BACKEND_ARCHITECTURE.md) §"Connection Pooling and Result Cache".

## 5. Hash and signature handling

`snapshotSubjectsSignature(subjects)` is a stable serialisation used for cache-key construction. It is not the same as `core_hash` — it's an FE-internal signature of "this set of snapshot subjects". Do not confuse with `coreHashService.computeShortCoreHash()` (the BE-facing canonical hash).

`humaniseSubjectId(rawId)` exists to convert composite snapshot subject IDs (`"<edge>__epoch:0"`) into human-readable form for tooltips and error messages. Epoch suffix collapse for stitching is handled by `collapseEpochSubjectId()` in this file.

## 6. Error handling

- **HTTP errors** propagate as thrown `Error` with the response status and body
- **Mock mode** returns deterministic stubs — never hits the network
- **Auth errors** are not caught here; they bubble to callers (`useFetchData`, `useCanvasAnalysisCompute`, etc.) which surface them via session log

## 7. Key types

The interfaces in this file are the canonical FE↔BE wire types. The most-modified are:

- `AnalysisRequest` — the dispatch envelope. `analysis_type`, `scenarios[]`, `analytics_dsl`, `query_dsl` (deprecated), `display_settings`, `snapshot_subjects?`, `candidate_regimes_by_edge?`, `forecasting_settings`
- `ScenarioData` — per-scenario graph state with `effective_query_dsl`, parameter overrides, visibility mode
- `SnapshotSubjectPayload` — per-subject `{param_id, core_hash, anchor_from, anchor_to, slice_keys, equivalent_hashes?}`
- `AnalysisResult` — the result envelope: `data` rows + `semantics` (dimensions/metrics/chart) + `metadata`
- `SnapshotAnalysisResponse` — the snapshot-envelope shape with `scenario_results` per scenario

## 8. Maintenance signposts

When working on this client:

- **New analysis type with snapshot envelope** → add a `normaliseSnapshotMyTypeResponse` and chain it into both the `analyzeSnapshots` waterfall and the `analyzeMultipleScenarios` waterfall (both have the same chain at lines ~1929 and ~2114). Missing one is a silent bug.
- **Field added to AnalysisRequest** → `analysis_type` is a plain string, **not** a discriminated union, so TypeScript will not catch missing handling. Verify the new field flows through `buildCacheKey` (or it'll be silently cached across distinct values).
- **Cache invalidation issue** → first check whether the field involved is part of `buildCacheKey`. The cache key includes graph node/edge IDs and probability values; it does NOT include scenario param overlays beyond DSL. Param-only overlays still feed the engine but may share a cache key — by design, since the BE treats them separately. Anti-pattern 41 affects this seam.
- **Adding a new endpoint** → add a method here, not in component code or hooks. The mock-mode + cache-bypass + no-cache wiring is non-trivial.

## 9. Anti-pattern cross-reference

| Anti-pattern | Implication for this file |
|---|---|
| AP 17: parity test bypassing FE normalisation | Tests must call `analyzeSnapshots`/`analyzeMultipleScenarios`, not raw `fetch` |
| AP 18: routing on field presence | `analyzeMultipleScenarios` routes on `analysis_type`, not on `analytics_dsl` presence |
| AP 19: conflating analytics_dsl and query_dsl | Top-level `analytics_dsl` (subject) vs per-scenario `effective_query_dsl` (temporal) — preserved separately here |
| AP 39: reimplementing FE pipeline in test code | Tests of BE handlers must call `runPreparedAnalysis` (which uses this client), not bypass it |

## 10. Where this client is *not* used

- **`runPreparedAnalysis`** in `analysisComputePreparationService.ts` is the wrapper most chart code calls; it builds the request, then delegates to this client
- **`conditionedForecastService.ts`** has its own fetch — does not use this client
- **`lagHorizonsService.ts`** has its own fetch
- **CLI** uses this client (via the daemon path or per-call subprocess) — same code, different entry point
