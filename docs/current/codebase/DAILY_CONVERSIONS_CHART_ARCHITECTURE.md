# Daily Conversions Chart Architecture

How the daily conversions chart renders evidence, forecasts, and uncertainty from the forecast engine (G.1b).

**Last updated**: 16-Apr-26

---

## Data Pipeline

### Backend (G.1b engine integration)

The daily conversions handler in `api_handlers.py` (lines ~3198-3450) wires through the generalised forecast engine rather than the legacy `annotate_rows` path:

1. Parses `asat()` from DSL via `_resolve_date`
2. Builds one `CohortEvidence` per `rate_by_cohort` row with `anchor_day`, `eval_date`, `eval_age = maturity_tau`, `frontier_age = real_age`
3. Calls `compute_forecast_trajectory` once per edge
4. Reads `cohort_evals` for `projected_y` (mean of `y_draws`), completeness from CDF
5. Computes per-cohort `forecast_bands` from `y_draws / x` percentiles (80/90/95/99)
6. For latency edges: computes tau values from inverse CDF at 25/50/75 percentile, runs sweep per tau for latency band data
7. Falls back to legacy `annotate_rows` if engine fails

Key field: `eval_age` must be set to `maturity_tau` (t95), not the cohort's actual age — otherwise the engine reads at current maturity rather than eventual maturity. `frontier_age` must be `real_age` (not 0) for IS conditioning to fire, since `E_i = N_i * CDF(frontier)`.

### Derivation

`daily_conversions_derivation.py` produces `cohort_y_at_age` — per-cohort Y values at specific maturity ages. Uses carry-forward aggregation: per-slice Y is carried forward at each age to ensure monotonicity across ages when different slice subsets appear at different ages.

### Frontend passthrough

`graphComputeClient.ts` (line ~828) passes `forecast_bands` and `latency_bands` from BE rows.

---

## Chart Structure (ECharts)

Built by `buildDailyConversionsEChartsOption` in `snapshotBuilders.ts`.

### Left axis: 3-layer stacked bars

Per scenario, three bar series stacked per date bin:

1. **E (evidence)** — solid fill at scenario colour
2. **F (forecast)** — striated fill using `decal: { symbol: 'rect', dashArrayX: [1, 0], dashArrayY: [3, 3], rotation: -Math.PI / 4 }`
3. **N (remainder)** — scenario colour at 12% opacity, representing the gap to total population

### Right axis: dual rate lines

Two line series per scenario showing conversion rate over time:

- **Evidence % (epoch A)** — solid line, markers, for dates where completeness >= 0.95
- **Evidence % (epoch B)** — dashed line, no markers, for dates where completeness < 0.95 but data is evidential
- **Forecast %** — dotted line, for dates beyond the evidence frontier

Epoch boundary is at completeness >= 0.95. All lines use `darkenHex(scenarioColour, 0.3)` for visual prominence. Line width is 2 for all segments.

A bridge point (duplicate of the last evidence point as the first forecast point) prevents discontinuity at the evidence/forecast boundary.

### Forecast dispersion bands

Polygon-fill areas around the forecast rate line showing MC draw percentiles (80/90/95/99). Rendered with hatched striation (diagonal lines, gap=8, lineWidth=1, 20% opacity) clipped to the polygon shape.

### Latency bands (optional, latency edges only)

Per-cohort conversion rates evaluated at fixed maturity ages corresponding to 25th/50th/75th percentile of the latency CDF. Each band is a line with a percentile-specific dash pattern:

- 25th percentile: `[2, 8]` (sparse dots)
- 50th percentile: `[2, 5]` (medium dots)
- 75th percentile: `[2, 3]` (dense dots)

Evidence segments at full scenario colour opacity; forecast segments at 30% opacity. Controlled by the `show_latency_bands` display setting. The legend shows the implied number of days for each percentile.

---

## Display Settings

Registered in `analysisDisplaySettingsRegistry.ts` under `daily_conversions`:

| Setting | Values | Compute-affecting | Purpose |
|---------|--------|-------------------|---------|
| `show_bars` | on/off | No | Toggle stacked bar visibility |
| `show_rates` | on/off | No | Toggle rate line visibility |
| `smooth_lines` | off/light | No | EWMA smoothing on rate lines and bands |
| `moving_avg` | off/3d/7d/weekly/monthly | No | SMA/EWMA smoothing method |
| `aggregate` | off/weekly/monthly | No | Date re-binning |
| `bayes_band_level` | off/80/90/95/99 | Yes | Forecast dispersion band level |
| `show_latency_bands` | on/off | No | Toggle latency band lines |

### Smoothing

EWMA smoothing is applied to the combined evidence+forecast data before splitting into segments, avoiding discontinuity at the evidence/forecast boundary. The bridge point ensures continuity. Smoothing also applies to dispersion bands, anchored to the actual smoothed forecast rate line.

### Aggregation

Weekly/monthly re-binning groups date bins and recomputes bar heights and rate values. Currently FE-only (the `computeAffecting` flag is false).

---

## Visual Semantics (shared with cohort maturity)

Both daily conversions and cohort maturity follow the same conventions:

- **Epoch A** (mature evidence): solid line, markers
- **Epoch B** (immature evidence): dashed line, no markers
- **Forecast**: dotted line
- **Line width**: 2 for all segments
- **Colour darkening**: main lines use `darkenHex(colour, 0.3)` — 30% darker than the scenario colour
- **Striated forecast fills**: same decal pattern across both chart types

These conventions are implemented independently in `snapshotBuilders.ts` (daily conversions) and `cohortComparisonBuilders.ts` (cohort maturity). The `darkenHex` utility lives in `echartsCommon.ts`.

---

## Legend

Single-scenario: auto-discovered by ECharts (no explicit `data` array).

Multi-scenario: uses `buildScenarioLegend` utility from `echartsCommon.ts`. Concepts (Evidence %, Forecast %, etc.) appear once; scenario colour swatches appear per scenario. Only references series with actual data points to avoid the (0, 0) rendering bug (anti-pattern 45).

---

## Key Files

| File | Purpose |
|------|---------|
| `src/services/analysisECharts/snapshotBuilders.ts` | `buildDailyConversionsEChartsOption` — chart builder |
| `src/services/analysisECharts/echartsCommon.ts` | `buildScenarioLegend`, `smoothRates`, `darkenHex` — shared utilities |
| `src/services/analysisECharts/cohortComparisonBuilders.ts` | Cohort maturity chart (shares visual conventions) |
| `src/lib/analysisDisplaySettingsRegistry.ts` | Display setting definitions |
| `lib/api_handlers.py` | BE handler with G.1b engine integration (~lines 3198-3450) |
| `lib/runner/daily_conversions_derivation.py` | `cohort_y_at_age`, carry-forward aggregation |
| `src/services/__tests__/analysisEChartsService.dispatch.test.ts` | Chart builder tests |
| `lib/tests/test_daily_conversions.py` | BE engine annotation tests |
