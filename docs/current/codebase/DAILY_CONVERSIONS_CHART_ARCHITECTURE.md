# Daily Conversions Chart Architecture

How the daily conversions chart renders evidence, forecasts, and uncertainty from the forecast engine (G.1b).

**Last updated**: 16-Apr-26

---

## Data Pipeline

### Backend (G.1b engine integration)

The daily conversions handler `_handle_daily_conversions` in `api_handlers.py` (line ~1258) runs entirely on the shared CF projection bundle (73q Phase 4) — there is no longer a bespoke per-edge forecast sweep or `annotate_rows` fallback:

1. Parses `asat()` from the temporal DSL via `parse_asat_from_dsl` (`runner/forecast_runtime.py`)
2. Admits the shared forecast evidence via `admit_forecast_evidence` (`runner/forecast_admission.py`) and derives the context scope via `extract_forecast_context_scope`
3. Builds the single shared `CFProjectionBundle` via `prepare_cf_projection_bundle` (`runner/cf_analysis.py`)
4. Reduces the bundle with the registry-selected date reducer — `reducer_for('daily_conversions')`, which dispatches to `reduce_daily_conversions_rows` in `runner/cohort_forecast_v3.py`
5. The reducer emits `forecast_bands`, `latency_bands`, `evidence_latency_bands`, and `model_latency_bands` per row, read straight off the bundle's `date_axis_projection` at saturation (`bundle.max_tau`)

There is no manual `CohortEvidence` construction, no `compute_forecast_trajectory` call (the legacy trajectory engine has been deleted), and no `annotate_rows` fallback path.

### Derivation (v2 snapshot-analyze path only)

Note: `daily_conversions_derivation.py` is NOT on the v3 daily-conversions chart path described above. It is still used by the v2 snapshot-analyze path (`_handle_snapshot_analyze_subjects` in `api_handlers.py`), where `derive_daily_conversions` is wired to the `branch_comparison` analysis type. There it produces `cohort_y_at_age` — per-cohort Y values at specific maturity ages, using carry-forward aggregation so per-slice Y is carried forward at each age to ensure monotonicity across ages when different slice subsets appear at different ages.

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

Evidence segments at full scenario colour opacity; forecast segments at 30% opacity. Controlled by the `show_latency_bands` display setting. Legend shows the implied number of days for each percentile.

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

EWMA smoothing applied to combined evidence+forecast data before splitting into segments, avoiding discontinuity at the evidence/forecast boundary. The bridge point ensures continuity. Smoothing also applies to dispersion bands, anchored to the actual smoothed forecast rate line.

### Aggregation

Weekly/monthly re-binning groups date bins and recomputes bar heights and rate values. Currently FE-only (`computeAffecting` flag is false).

---

## Visual Semantics (shared with cohort maturity)

Both daily conversions and cohort maturity follow the same conventions:

- **Epoch A** (mature evidence): solid line, markers
- **Epoch B** (immature evidence): dashed line, no markers
- **Forecast**: dotted line
- **Line width**: 2 for all segments
- **Colour darkening**: main lines use `darkenHex(colour, 0.3)` — 30% darker than the scenario colour
- **Striated forecast fills**: same decal pattern across both chart types

Implemented independently in `snapshotBuilders.ts` (daily conversions) and `cohortComparisonBuilders.ts` (cohort maturity). The `darkenHex` utility lives in `echartsCommon.ts`.

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
| `lib/tests/test_daily_conversions.py` | `derive_daily_conversions` derivation tests (v2 snapshot path; DR-003/DR-004) |
