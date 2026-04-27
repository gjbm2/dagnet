# analysisECharts Builders

The chart-rendering layer: 6 files in `graph-editor/src/services/analysisECharts/` totalling **5,187 LOC**, dispatched from a single one-function entry point in `analysisEChartsService.ts`. Until this doc, individual chart families had design docs (DAILY_CONVERSIONS_CHART_ARCHITECTURE, cohort-maturity-forecast-design, surprise-gauge-design) but no umbrella over the cluster.

**See also**: [CHART_PIPELINE_ARCHITECTURE.md](CHART_PIPELINE_ARCHITECTURE.md) (upstream — recipes, hydration, compute), [ANALYSIS_RETURN_SCHEMA.md](ANALYSIS_RETURN_SCHEMA.md) (input contract), [adding-analysis-types.md](adding-analysis-types.md) (when to add a new chart kind), [GRAPH_COMPUTE_CLIENT.md](GRAPH_COMPUTE_CLIENT.md) (where the data comes from).

---

## 1. Cluster shape

```
graph-editor/src/services/
├── analysisEChartsService.ts                  #   633 — buildChartOption() dispatcher
└── analysisECharts/
    ├── echartsCommon.ts                       #   462 — shared utilities
    ├── cohortComparisonBuilders.ts            # 1,915 — cohort_maturity, lag_fit, comparison bar/pie/time-series
    ├── funnelBuilders.ts                      # 1,379 — conversion_funnel (pyramid), conversion_funnel_bar
    ├── snapshotBuilders.ts                    # 1,322 — lag_histogram, daily_conversions, conversion_rate
    ├── bridgeBuilders.ts                      #   697 — bridge, funnel_bridge
    └── surpriseGaugeBuilder.ts                #   551 — expectation gauge (semicircle dial + horizontal bands)
```

Five builder files, one shared-utility file, one dispatcher. Total: 7 files.

## 2. Dispatch model

`analysisEChartsService.buildChartOption(result, kind, settings)` is the single entry point. Branches on `chart_kind` (the visual kind) — **not** on `analysis_type`. Builders are chart-kind-keyed; multiple analysis types may map to the same builder.

Examples:
- `kind = 'cohort_maturity'` → `buildCohortMaturityEChartsOption`
- `kind = 'funnel'` → `buildFunnelEChartsOption`
- `kind = 'bar_grouped' | 'pie' | 'time_series'` → `buildComparison*` family
- `kind = 'bridge' | 'bridge_horizontal'` → `buildBridgeEChartsOption`
- `kind = 'funnel_bar'` → `buildFunnelBarEChartsOption`
- `kind = 'surprise_gauge'` → `buildSurpriseGaugeEChartsOption`
- `kind = 'lag_histogram'` → `buildHistogramEChartsOption`
- `kind = 'daily_conversions'` → `buildDailyConversionsEChartsOption`
- `kind = 'conversion_rate'` → `buildConversionRateEChartsOption`
- `kind = 'lag_fit'` → `buildLagFitEChartsOption`
- `kind = 'table'` → handled by `AnalysisChartContainer`, not this dispatcher

## 3. The shared-utilities layer (`echartsCommon.ts`)

Every builder reaches into this file. Working in any chart, you'll need:

| Utility | Use |
|---|---|
| `echartsThemeColours()` | Theme-aware palette (light/dark) — call instead of hardcoding hex |
| `echartsTooltipStyle()` | Standard tooltip styling — backgroundColor, borderRadius, etc. |
| `applyCommonSettings(opt, settings)` | Applies font_size, axis_label, legend, animation, reference_line settings |
| `getDimLabel(dimensionValues, dimId, valueId)` | Looks up the human label for a dimension value (e.g. scenario_id → scenario name) |
| `getDimOrder(dimensionValues, dimId, valueId)` | Reads canonical sort order for a dimension value |
| `wrapAxisLabel(raw, maxCharsPerLine, maxLines)` | Word-wraps long axis labels |
| `buildScenarioLegend({...})` | Standard multi-scenario legend (concept entries + colour swatches). Avoids the (0,0) legend bug — anti-pattern 45 |
| `smoothRates(rates, method)` | EWMA / SMA smoothing for rate lines |
| `darkenHex(hex, factor)` | Renders main lines at 30% darker than the scenario colour |
| `getScenarioTitleWithBasis(result, scenarioId)` | Tooltip / title generation with the active visibility-mode basis (E-only / F-only / blended) |
| `isConversionFunnelResult(result)` | Heuristic for routing in the dispatcher |

**Visual conventions** shared across all builders (defined in `echartsCommon.ts`):

- Main lines use `darkenHex(scenarioColour, 0.3)` for visual prominence
- Line width is 2 for all segments by default
- Epoch A (mature evidence): solid line, markers
- Epoch B (immature evidence): dashed line, no markers
- Forecast: dotted line
- Striated forecast fills: `decal: { symbol: 'rect', dashArrayX: [1, 0], dashArrayY: [3, 3], rotation: -π/4 }`

## 4. Per-builder responsibilities

### `cohortComparisonBuilders.ts` — 1,915 LOC

Three families:
- **`buildCohortMaturityEChartsOption`** — cohort maturity chart with epochs A/B/C, midpoint + fan, latency-band overlay, model curve. See [cohort-maturity-forecast-design.md](cohort-maturity-forecast-design.md).
- **`buildLagFitEChartsOption`** — observed cohort completeness vs fitted log-normal CDF.
- **`buildComparisonBarEChartsOption`** / **`buildComparisonPieEChartsOption`** / **`buildComparisonTimeSeriesEChartsOption`** — multi-dimensional comparisons (outcome_comparison, branch_comparison, branches_from_start, multi_outcome_comparison, multi_branch_comparison).

Largest file. Most complex internal helper: `generatePatternChildren()` for clipped polygon-fill patterns (diagonal, reverse_diagonal, stipple) used by fan bands and forecast crowns.

### `funnelBuilders.ts` — 1,379 LOC

- **`buildFunnelEChartsOption`** — pyramid funnel (decreasing widths)
- **`buildFunnelBarEChartsOption`** — bar variant with hi/lo bands derived from completeness-weighted variance mixture
- **`extractFunnelSeriesPoints`** — exposed helper for downstream consumers

`conversion_funnel`'s renderer. Note the load-bearing asymmetry: `conversion_funnel` is FE-snapshotContract'd but BE-NOT-snapshot-routed (see [ANALYSIS_TYPES_CATALOGUE.md](ANALYSIS_TYPES_CATALOGUE.md) §"Compute-stage asymmetry"), so the input shape is `result.data` rows, not a snapshot envelope.

### `snapshotBuilders.ts` — 1,322 LOC

Three time-series chart kinds:
- **`buildHistogramEChartsOption`** — lag histogram (bars by lag-day, with percentages)
- **`buildDailyConversionsEChartsOption`** — 3-layer stacked bars (E/F/N) + dual rate lines + forecast dispersion bands + optional latency bands. See [DAILY_CONVERSIONS_CHART_ARCHITECTURE.md](DAILY_CONVERSIONS_CHART_ARCHITECTURE.md).
- **`buildConversionRateEChartsOption`** — sized scatter (circle area ∝ cohort n) + dashed model line + non-striated HDI band + size legend

### `bridgeBuilders.ts` — 697 LOC

- **`buildBridgeEChartsOption`** — horizontal arrow with delta label (custom minimised renderer for `bridge_view`)
- **`buildFunnelBridgeEChartsOption`** — bridge-style decomposition variant for funnel comparisons

### `surpriseGaugeBuilder.ts` — 551 LOC

- **`buildSurpriseGaugeEChartsOption`** — semicircle dial (single var, single scenario) or horizontal band stack (multi-var or multi-scenario)
- Exports `ZONES`, `DIRECTIONAL_COLOURS`, `zoneColour(sigma, scheme)`

See [surprise-gauge-design.md](surprise-gauge-design.md).

## 5. Display settings

All chart-kind display settings live in [`analysisDisplaySettingsRegistry.ts`](../../graph-editor/src/lib/analysisDisplaySettingsRegistry.ts) (1,530 LOC). Builders read settings via the `settings` arg to `buildChartOption`. Common settings: `font_size`, `axis_label`, `legend`, `tooltip`, `animation`, `reference_line`. Per-kind settings are extensive — see the registry.

Compute-affecting settings (e.g. `bayes_band_level` for daily_conversions) flow back into the request via the `chartDeps` signature, invalidating the chart cache. Display-only settings (e.g. `smooth_lines`, `moving_avg`) re-render without recompute.

## 6. Chart-kind ↔ analysis-type matrix (current)

| Chart kind | Builder | Used by analysis types |
|---|---|---|
| `bar`, `bar_grouped`, `bar_stacked` | `buildComparisonBar*` | graph_overview, from_node_outcomes, to_node_reach, outcome_comparison, branch_comparison, branches_from_start, multi_*, general_selection |
| `pie` | `buildComparisonPie*` | graph_overview, outcome_comparison, branch_comparison, multi_* |
| `funnel` | `buildFunnelEChartsOption` | path_between, conversion_funnel, constrained_path |
| `funnel_bar` | `buildFunnelBarEChartsOption` | conversion_funnel |
| `bridge`, `bridge_horizontal` | `buildBridgeEChartsOption` | bridge_view, path_between, conversion_funnel, constrained_path |
| `cohort_maturity` | `buildCohortMaturityEChartsOption` | cohort_maturity |
| `lag_fit` | `buildLagFitEChartsOption` | lag_fit |
| `lag_histogram` | `buildHistogramEChartsOption` | lag_histogram |
| `daily_conversions` | `buildDailyConversionsEChartsOption` | daily_conversions |
| `conversion_rate` | `buildConversionRateEChartsOption` | conversion_rate |
| `time_series` | `buildComparisonTimeSeriesEChartsOption` | branches_from_start (+ multi-scenario variants of comparison types) |
| `surprise_gauge` | `buildSurpriseGaugeEChartsOption` | surprise_gauge |
| `info` (cards) | not a builder — `AnalysisChartContainer` renders directly | node_info, edge_info |
| `table` | not a builder — handled by `AnalysisChartContainer` | every type with `table` in its kind list |

## 7. Maintenance signposts

- **New chart kind** → add to `CHART_KINDS_BY_ANALYSIS_TYPE` in `analysisTypeResolutionService.ts`, the `ChartKind` union in `AnalysisChartContainer.tsx`, the dispatcher branch in `analysisEChartsService.ts`, the builder file (new file or new exported function), and the display-settings registry. See [adding-analysis-types.md](adding-analysis-types.md) §6–7.
- **Reusing an existing chart kind for a new analysis type** → no changes here; just register the analysis type and ensure its `data` rows match the kind's contract.
- **Theme drift** → use `echartsThemeColours()` and `darkenHex` consistently; never hardcode `#fff` or `#000`.
- **Multi-scenario legend** → use `buildScenarioLegend(...)` from `echartsCommon`. Don't construct legend.data with empty-data series (anti-pattern 45 — collapses to (0,0)).
- **Series colours** → set `color` at series top level for legend correctness, not just `itemStyle.color` or `areaStyle.color` (anti-pattern 49).
- **Pattern fills** → reuse `generatePatternChildren()` from cohortComparisonBuilders rather than duplicating the diagonal/stipple logic.

## 8. Pitfalls

### Anti-pattern 45: ECharts legend `data` referencing empty-data series

**Signature**: legend items render at coordinate (0, 0) — a cluster of icons piled in the top-left corner. Or the legend collapses to a single point when a second scenario is added.

**Root cause**: ECharts' legend `data` array contains entries that reference series whose `data` array is empty (`[]`). ECharts renders the legend item but cannot resolve its position, falling back to (0, 0). Happens when building a multi-scenario legend with synthetic entries for concept labels (e.g. "Evidence %", "Forecast %") backed by series with no data points in certain scenarios.

**Fix**: only include entries in `legend.data` that reference series with actual data points. For multi-scenario legends, omit `data` entirely (let ECharts auto-discover from real series) or filter the data array to series names that have non-empty data. Do not create synthetic zero-data series just to drive legend rendering.

**Reference implementation**: `buildScenarioLegend(...)` in `echartsCommon.ts`.

### Anti-pattern 49: ECharts legend icon using default palette when series `color` is omitted

**Signature**: legend icons show colours that don't match the data (e.g. a blue scenario's HDI band swatch renders as green, the next series as yellow). Scatter points and lines in the plot body are correctly coloured, but the legend is wrong. Theme overrides and `itemStyle.color` don't fix it.

**Root cause**: ECharts derives legend-icon colour from the series' top-level `color` field, not from `itemStyle.color` or `areaStyle.color`. When top-level `color` is absent, ECharts assigns from its default palette by series index (`#5470c6` blue, `#91cc75` green, `#fac858` yellow, `#ee6666` red, …). A line series with `areaStyle.color: 'rgba(59,130,246,0.18)'` renders the band in blue but picks up `#91cc75` (green) in the legend.

**Fix**: set `color: <scenarioColour>` at the series top level on every series the legend displays. Invisible helper series (stack anchors, etc.) can be filtered from the legend via name prefix (`__`-prefix convention) but should still carry `color` for consistency.

**Broader principle**: ECharts has three colour fields (`color`, `itemStyle.color`, `areaStyle.color`/`lineStyle.color`) with different consumers. `color` feeds legend icons and emphasis defaults; `itemStyle.color` feeds data-point fill; `areaStyle.color` feeds band fill only. Setting one does not set the others. Setting all three explicitly is the safe default.

## 9. What is not here

- The **upstream pipeline** (recipe, hydration, compute) — see [CHART_PIPELINE_ARCHITECTURE.md](CHART_PIPELINE_ARCHITECTURE.md)
- The **input contract** (the `AnalysisResult` shape, `semantics`, `dimension_values`) — see [ANALYSIS_RETURN_SCHEMA.md](ANALYSIS_RETURN_SCHEMA.md)
- **Display planning** (which kind to use, how to handle scenario count, fallback reasons) — `chartDisplayPlanningService.ts`, see [CHART_PIPELINE_ARCHITECTURE.md](CHART_PIPELINE_ARCHITECTURE.md) §4
- **Container UI** (toolbar, view-mode switching, scenario legend, minimised renderers) — `AnalysisChartContainer.tsx`, see [UI_COMPONENT_MAP.md](UI_COMPONENT_MAP.md)
