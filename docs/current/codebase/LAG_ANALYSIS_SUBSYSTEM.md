# Lag Analysis Subsystem

How DagNet models time-to-conversion delays, computes lag horizons, and aggregates lag distributions across contexts.

**See also**: `FE_BE_STATS_PARALLELISM.md` (why FE and BE both run this computation, and the migration plan), `PROBABILITY_BLENDING.md` (how lag-derived completeness feeds into blended probabilities), `DATE_MODEL_COHORT_MATURITY.md` (canonical date concepts used by lag analysis)

## What Lag Analysis Computes

### Lag fit

**Location**: `lagFitAnalysisService.ts`

Fits a log-normal distribution to observed conversion delays:
- Returns curve points (PMF/CDF discretised) and cohort scatter data
- Uses already-loaded parameter data from FileRegistry
- No backend API call required

### Lag horizons

**Location**: `lagHorizonsService.ts`

Computes t95 (95th percentile of lag) and path_t95 for each edge:
- Loaded from files via `fetchDataService` with a "retrieve global" DSL (`cohort(-3650d:0d)`)
- Captures as much historical data as possible
- Recomputed from file-backed data, not from graph's existing horizons
- Clears existing t95/path_t95 unless marked as overridden

### Lag mixture aggregation

**Location**: `lagMixtureAggregationService.ts`

Aggregates lag distributions across context pools mathematically as mixture components:
- Computes mixture quantiles via binary search on the weighted mixture CDF
- Does **not** average medians (which is mathematically unsound)
- Each context slice contributes its weight proportionally

## Fit-quality contract: graceful + auditable, never silent

`fitLagDistribution` (`lagDistributionUtils.ts`) degrades gracefully on every input it can't fit cleanly, but every degraded fit must leave a session-log breadcrumb. The function never throws on real-prod inputs.

| Input condition | Return | `empirical_quality_ok` | Breadcrumb |
|---|---|---|---|
| Clean fit (1 ≤ ratio ≤ max, totalK ≥ min, mean and median valid) | computed `(μ, σ)` | `true` | none — this is a real fit |
| Mean = median exactly, or 1 ≤ ratio with computed σ ≈ 0 | `σ = 0` (honest Dirac) | `true` | none — Dirac is a legitimate fit |
| Mean ≤ median (ratio < 1) | `σ = 0` (honest Dirac at median) | `true` | none — Dirac is a legitimate fit |
| Mean missing or non-positive | `σ = LATENCY_DEFAULT_SIGMA`, `μ = ln(median)` | `false` | yes |
| Mean/median ratio > `LATENCY_MAX_MEAN_MEDIAN_RATIO` (data outside lognormal regime) | `σ = LATENCY_DEFAULT_SIGMA`, `μ = ln(median)` | `false` | yes |
| `totalK < LATENCY_MIN_FIT_CONVERTERS` | `σ = LATENCY_DEFAULT_SIGMA`, `μ = ln(median)` | `false` | yes |
| Median ≤ 0 or non-finite (upstream-noise-or-error) | `σ = LATENCY_DEFAULT_SIGMA`, `μ = 0` | `false` | yes |

`empirical_quality_ok = false` always carries a `quality_failure_reason` string. The topo-loop caller (`statisticalEnhancementService.ts:enhanceGraphLatencies`) emits a `FE_TOPO_FIT_DEFAULTED` warning to the session log on every false outcome, with the edge id, the reason, and the sigma used. `FE_TOPO_FIT_FAILED` is reserved for genuine programming errors that bubble out of `computeEdgeLatencyStats`.

This matters because `model_vars[analytic].latency` is durable on the source ledger (see `FE_BE_STATS_PARALLELISM.md` for layer semantics). A defaulted σ persists on the edge until re-fitted; without the breadcrumb the user has no way to tell a fitted σ from a defaulted one. Before this contract, soft defaults were silent at info threshold (recorded only via `edgeDiag.setLat(..., 'defaulted', reason)` which is gated behind `feTopoDebugEnabled`). The `FE_TOPO_FIT_DEFAULTED` emission closes that audit gap. Onset-aware fitting (where `toModelSpace` subtracts onset from median before fitting) is the most common trigger: when aggregated onset ≈ aggregated median the model-space ratio explodes past the regime guard, and the soft-default path catches it.

## Key Files

| File | Role |
|------|------|
| `src/services/lagFitAnalysisService.ts` | Log-normal fitting, curve generation |
| `src/services/lagHorizonsService.ts` | t95/path_t95 computation |
| `src/services/lagMixtureAggregationService.ts` | Cross-context mixture aggregation |
| `src/services/lagDistributionUtils.ts` | Distribution utility functions |
