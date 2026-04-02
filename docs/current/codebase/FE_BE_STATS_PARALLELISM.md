# FE/BE Stats Parallelism

Why both frontend and backend run the same statistical topo pass, how they're coordinated, and the transition plan.

## Context

DagNet currently runs the same "analytic topo pass" (Stage 2 of the fetch pipeline) in **both** TypeScript (FE) and Python (BE). This is intentional and temporary — a zero-downtime migration strategy from FE-only to BE-only computation.

## What the topo pass computes

Per edge, given raw cohort evidence:
- **t95**: 95th percentile lag (days) — when 95% of conversions have occurred
- **mu, sigma**: log-normal distribution parameters for lag CDF fitting
- **path_t95, path_mu, path_sigma**: cumulative path-level equivalents (Fenton-Wilkinson composition)
- **completeness**: fraction of conversions completed by the query date
- **blended_mean**: forecast-weighted conversion rate = `w_evidence * evidence.mean + (1 - w_evidence) * forecast.mean`
- **p_infinity (forecast)**: mature window baseline conversion rate

## The two implementations

### FE topo pass (blocking, synchronous)

- **Service**: `statisticalEnhancementService.ts` → `enhanceGraphLatencies()`
- **Triggered by**: `fetchDataService.ts` Stage 2, after per-item fetches complete
- **Writes to**: `analytic` model_vars entry on each edge
- **Blocks UI**: yes — runs synchronously in the fetch pipeline
- **Source of truth**: currently authoritative (UI displays these results)

### BE topo pass (non-blocking, fire-and-forget)

- **Service**: `beTopoPassService.ts` → `runBeTopoPass()`
- **Endpoint**: `POST /api/lag/topo-pass` → `lib/runner/stats_engine.py` (Python port of the FE logic)
- **Triggered by**: `fetchDataService.ts` Stage 2, fired as a background async IIFE after FE topo pass completes
- **Writes to**: `analytic_be` model_vars entry on each edge
- **Blocks UI**: no — runs in background, failure logged but ignored
- **Source of truth**: not yet authoritative (validation only)

**Note**: the BE topo pass (`/api/lag/topo-pass` via `stats_engine.py`) is distinct from the generic `/api/stats-enhance` endpoint (`stats_enhancement.py`), which handles raw-aggregation enhancement (trends, MCMC-style summaries, robust stats).

## Orchestration in the fetch pipeline

```
fetchDataService.ts Stage 2:

1. FE topo pass (synchronous, blocking)
   enhanceGraphLatencies(graph, paramLookup, queryDate, ...)
   → writes analytic model_vars
   → applies results to graph immediately

2. BE topo pass (async, fire-and-forget)
   (async () => {
     beEntries = await runBeTopoPass(graph, paramLookup, queryDate, ...)
     → writes analytic_be model_vars
     → if FORECASTING_PARALLEL_RUN: compareModelVarsSources()
   })()
```

## What FE sends to BE

`beTopoPassService` packages **deterministic input parity** so BE can mirror FE's derivations exactly:

| Field | Purpose |
|-------|---------|
| `graph` | Full graph structure |
| `cohort_data` | Per-edge cohort arrays (filtered by DSL) |
| `edge_contexts.onset_from_window_slices` | Weighted median onset (from window slices) |
| `edge_contexts.window_cohorts` | Cohorts aggregated from window() slices |
| `edge_contexts.scoped_cohorts` | Windowed cohorts |
| `edge_contexts.n_baseline_from_window` | Sum of n from window() slices |
| `forecasting_settings` | Lambda, half-life, blend config |

## Parity comparison

**Service**: `forecastingParityService.ts` → `compareModelVarsSources()`

After BE writes `analytic_be` entries, compares against `analytic` entries on each edge:

| Metric | Warning threshold | Error threshold |
|--------|-------------------|-----------------|
| mu, sigma | 0.1% relative | 1% relative |
| t95 | ±0.5 days | ±0.5 days |
| p.mean | 0.1% relative | 1% relative |

Results logged to session log:
- `ANALYTIC_PARITY_OK` — all match
- `ANALYTIC_PARITY_MISMATCH` — detailed list of divergences
- `ANALYTIC_PARITY_DRIFT` — within warning but approaching error

## model_vars entries

Each edge can have multiple model_vars entries from different sources. The `modelVarsResolution` preference hierarchy determines which is promoted:

| Source | Written by | When |
|--------|-----------|------|
| `analytic` | FE topo pass | Every fetch (blocking) |
| `analytic_be` | BE topo pass | Every fetch (background) |
| `bayesian` | Bayes MCMC service | On Bayes fit completion |
| `manual` | User override | Manual entry |

Currently `analytic` wins by default. The transition plan makes `analytic_be` the winner.

## Transition plan

| Phase | State | FE computes | BE computes | UI shows |
|-------|-------|-------------|-------------|----------|
| **1 (current)** | Parallel run | `analytic` (blocking) | `analytic_be` (fire-and-forget) | FE results |
| **2** | Validated parity | `analytic` (blocking) | `analytic_be` (fire-and-forget) | BE results (switched) |
| **3** | FE deprecated | Removed | `analytic` (promoted, blocking) | BE results |

**Why this order**:
- FE is faster (synchronous, no network) — safe default
- BE is more flexible (Python, easier to experiment with) — target state
- Running both allows zero-downtime validation before switching
- Mismatches surface as session log entries (visible in UI)

**Feature flag**: `FORECASTING_PARALLEL_RUN = true` in `forecastingParityService.ts`

## Key files

| File | Role |
|------|------|
| `src/services/fetchDataService.ts` (Stage 2) | Orchestrates both passes |
| `src/services/statisticalEnhancementService.ts` | FE topo pass (`enhanceGraphLatencies`) |
| `src/services/beTopoPassService.ts` | BE topo pass client (`runBeTopoPass`) |
| `src/services/forecastingParityService.ts` | Parity comparison (`compareModelVarsSources`) |
| `src/services/modelVarsResolution.ts` | Preference hierarchy for model_vars |
| `lib/runner/stats_engine.py` | BE topo pass implementation (Python port of FE) |
| `lib/api_handlers.py` | `/api/lag/topo-pass` endpoint handler |
