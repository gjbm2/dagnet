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

## Key Files

| File | Role |
|------|------|
| `src/services/lagFitAnalysisService.ts` | Log-normal fitting, curve generation |
| `src/services/lagHorizonsService.ts` | t95/path_t95 computation |
| `src/services/lagMixtureAggregationService.ts` | Cross-context mixture aggregation |
| `src/services/lagDistributionUtils.ts` | Distribution utility functions |
