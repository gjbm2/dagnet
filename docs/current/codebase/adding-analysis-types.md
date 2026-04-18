# Adding a New Analysis Type

**Last updated**: 18-Apr-26 (after conversion_rate onboarding, doc 49 Part B)

Playbook for adding a new analysis type with chart rendering. Follow in
order; each step is independently testable. There are ~15 files to
touch for a full snapshot-based analysis; known design debt is tracked
at the end of this doc.

Before you start: read [CHART_PIPELINE_ARCHITECTURE.md](./CHART_PIPELINE_ARCHITECTURE.md)
and [ANALYSIS_RETURN_SCHEMA.md](./ANALYSIS_RETURN_SCHEMA.md). Pick the
closest existing type (e.g. `daily_conversions` for a time-series rate
chart, `cohort_maturity` for an age-axis chart) and mirror it.

---

## Pre-flight decisions

Before touching files, decide:

1. **Is it local-compute or snapshot-based?**
   - Local: derives purely from the in-memory graph (no DB, no BE
     snapshot fetch). Examples: `graph_overview`, `edge_info`.
   - Snapshot-based: needs historical k/n data from the snapshot DB.
     Examples: `daily_conversions`, `cohort_maturity`, `conversion_rate`.
2. **What's the subject shape?** 1 node / 2 nodes / from+to / siblings?
   This drives the `when` clause in `analysis_types.yaml` and subject
   resolution rules.
3. **What's the temporal axis?** Time (dates), age (tau days), or
   categorical? Dictates which builder pattern to mirror.
4. **What's the band / uncertainty semantic?** Epistemic HDI?
   Predictive? Forecast quantiles? Determines which resolver to call.

If any of these is unclear, pause and sketch the chart on paper first.

---

## 1. Register the analysis type (BE)

**File**: `graph-editor/lib/runner/analysis_types.yaml`

Add a block declaring `id`, `name`, `description`, `when` (node_count,
has_from, has_to, sibling flags), and `runner` (`path_runner` /
`end_comparison_runner` / `branch_comparison_runner` / etc.). This
gates which analyses appear in the dropdown for a given selection.

Order matters — more specific `when` clauses must come before more
general ones.

---

## 2. Register the analysis type (FE)

**File**: `graph-editor/src/components/panels/analysisTypes.ts`

Add an entry to `ANALYSIS_TYPES` with `id`, `name`, `shortDescription`,
`selectionHint`, and `icon` (a lucide-react component). Include
`snapshotContract` **only** for snapshot-based types. Omitting it
skips the snapshot boot pipeline entirely.

The `snapshotContract` shape determines what the FE computes before
the BE call: subjects resolved from DSL, candidate regimes per edge,
and the enriched graph snapshot.

---

## 3. Map to chart kinds

**File**: `graph-editor/src/services/analysisTypeResolutionService.ts`

Add an entry to `CHART_KINDS_BY_ANALYSIS_TYPE`. First entry is the
default; include `'table'` so users get a table view for free.

If the analysis type should appear under specific DSL conditions,
add to `injectLocalAnalysisTypes()` with the matching `when` guard.

---

## 4. Add to the ChartKind type system

**File**: `graph-editor/src/components/charts/AnalysisChartContainer.tsx`

Four places in this one file:
- `ChartKind` union type
- `normaliseChartKind` (inbound from settings / explicit kind override)
- `inferredChartKind` (from result's `analysis_type`)
- `labelForChartKind` (display name in chart kind menu)

If the chart needs a subject selector (multi-subject analyses), also
add to `showSubjectSelector`.

---

## 5. Build the derivation (data layer)

### Local-compute types

**File**: `graph-editor/src/services/localAnalysisComputeService.ts`

Add to `LOCAL_COMPUTE_TYPES` set, add a case to `computeLocalResult`,
implement the builder. The returned `AnalysisResult` MUST include
`semantics.chart.recommended` — without it, the chart container
cannot resolve the chart kind and nothing renders.

### Snapshot-based types

**BE derivation**: `graph-editor/lib/runner/my_analysis_derivation.py`.
Pure function from rows → result dict. Use existing helpers where you
can: `resolve_model_params` (alpha/beta/mu/sigma from promoted source),
`resolve_rate_bands` (per-date HDI from fit_history + current).

**BE dispatch**: `graph-editor/lib/api_handlers.py` inside the
snapshot-analysis handler's per-subject loop (look for the chain of
`elif analysis_type == 'X':` near line 3765). Wire the derivation in,
passing `rows`, `edge`, `subj`, and display settings as needed.

**BE subject resolution**: `graph-editor/lib/analysis_subject_resolution.py`.
Add scope rule (e.g. `funnel_path`, `endpoint_pair`) and read mode
(e.g. `raw_snapshots`, `cohort_maturity`) mappings for the new type.

---

## 6. Build the ECharts option

**File**: `graph-editor/src/services/analysisECharts/snapshotBuilders.ts`
(or a dedicated file if the builder is large).

Export `buildMyAnalysisEChartsOption(result, settings, extra)`.
Return an ECharts option or `null` if data is insufficient.

**Must match house conventions**:
- `echartsThemeColours()` for colour resolution (light/dark aware)
- `echartsTooltipStyle()` spread into tooltip (consistent background /
  border / font)
- `axisPointer: { type: 'cross', lineStyle: { color: c.textMuted, ... } }`
  for crosshair
- `applyCommonSettings(opt, settings)` at the end for display-settings
  handling
- `buildScenarioLegend(...)` helper for multi-scenario legends
- `top: 14, left: 12` for top-left legend placement
- xAxis `type: 'time'` with `d-MMM` formatter and `rotate: 30` for
  time-series

**Wire into dispatcher**: `graph-editor/src/services/analysisEChartsService.ts`.
Import the builder, add a case to `buildChartOption`, and re-export
the function for tests.

---

## 7. Normalise the BE response

**File**: `graph-editor/src/lib/graphComputeClient.ts`

Snapshot-based analyses come back from the BE in a per-scenario /
per-subject block shape. The normaliser flattens these into flat data
rows and adds `scenario_id` / `subject_id` per row.

Three things:
- Implement `normaliseSnapshotMyAnalysisResponse(raw, request)`
- Add `analysis_type: '...'` to the union type (`AnalysisRequest.analysis_type`
  and any downstream result types)
- Chain it into the two normaliser waterfalls (around lines 1729 and 1915)

Copy from `normaliseSnapshotDailyConversionsResponse` and change the
row shape. The 80% of boilerplate is common; only the per-row keys differ.

---

## 8. Chart display planning

**File**: `graph-editor/src/services/chartDisplayPlanningService.ts`

If the chart is time-series, add to `TIME_SERIES_KINDS`. If it supports
multi-scenario comparison, add to `multiScenarioTimeSeriesKinds`. These
lists gate scenario layering and visibility-mode handling.

---

## 9. Snapshot boot trace (snapshot-based only)

**File**: `graph-editor/src/lib/snapshotBootTrace.ts`

Add to `isSnapshotBootChart` so the boot coordinator tracks this
analysis type through lifecycle stages. Without this, the chart can
silently hang waiting for a prep step that never fires.

---

## 10. Display settings

**File**: `graph-editor/src/lib/analysisDisplaySettingsRegistry.ts`

Add an entry to `CHART_DISPLAY_SETTINGS`. Compose from the common
groups (`COMMON_FONT_SIZE_SETTINGS`, `COMMON_LEGEND_SETTINGS`,
`COMMON_AXIS_SETTINGS`, `COMMON_TOOLTIP_SETTINGS`,
`COMMON_ANIMATION_SETTINGS`, etc.). Add analysis-specific settings
above the common tail (e.g. `bin_size`, `show_bands`, `aggregate`).

Each setting declares: `key`, `label`, `type`, `options`,
`defaultValue`, `propsPanel` (appears in side panel?), `inline`
(appears in chart toolbar?), `contextMenu` (appears in right-click
menu?), and `computeAffecting` (triggers recompute on change?).

---

## 11. Tests

### Unit tests (pure-function derivation)

`graph-editor/lib/tests/test_my_analysis.py`. Feed synthetic row
dicts into the derivation, assert shape and invariants (rate = y/x,
required keys present, monotonicity, etc.). Fast, deterministic, no DB.

### Blind end-to-end test (CLI analyse)

`graph-ops/scripts/my-analysis-blind-test.sh`. Mirror
[asat-blind-test.sh](../../../graph-ops/scripts/asat-blind-test.sh) or
[conversion-rate-blind-test.sh](../../../graph-ops/scripts/conversion-rate-blind-test.sh).

- Target a synth graph (`synth-mirror-4step`, `synth-simple-abc`, etc.)
  with known shape. Do NOT test against a prod graph — those drift.
- Use `bash graph-ops/scripts/analyse.sh` with `--type my_analysis`
  and `--get result.path.to.value` for scalar assertions.
- Read [cli-analyse.md](../../../graph-ops/playbooks/cli-analyse.md)
  for CLI options and quirks.
- One assertion per invariant — shape, consistency, gate, size.

---

## Common traps (learned the hard way)

### BE latency gate false-positives

If your analysis has a gate that rejects latency edges, **check the
`latency.latency_parameter` boolean flag, not `sigma > 0`**. Promoted
stats (from Bayes posterior) populate `latency.sigma` on non-latency
edges too — so `sigma > 0` incorrectly classifies non-latency edges as
latency. See [api_handlers.py] gate for conversion_rate for the correct
pattern.

### Per-subject failures vs. whole-scenario failures

If your derivation raises an exception in the per-subject loop, it
aborts the **entire scenario's response** (and any sibling subjects
that would have succeeded). For gated failures, append a failure entry
to `per_subject_results` and `continue` instead of raising.

### cohort() slice missing at top-of-graph

Bayes worker emits `slices["cohort()"]` only when an edge has its own
path latency fit. For non-latency edges with no latency ancestor (top
of graph), no cohort slice is emitted — the compiler already decided
cohort == window for such edges. Use `resolve_model_params(edge,
scope='edge', temporal_mode=mode)` which falls back correctly, instead
of reading `posterior.slices[key]` strictly.

### ECharts default palette shows up in legend

Legend icons derive from `series.color` (top-level), NOT from
`itemStyle.color` or `areaStyle.color`. If a series omits top-level
`color`, ECharts assigns from its default palette (green for series[1],
etc.). Set `color: scenarioColour` at series top-level for every series
to prevent surprise greens / yellows.

### Crosshair labels look different

Cohort-maturity-style crosshair labels (small grey box with axis value)
require per-axis `axisPointer.label` config — not just
`tooltip.axisPointer.type: 'cross'`. Mirror [cohortComparisonBuilders.ts]'s
x/y-axis `axisPointer: { snap: true, label: {...} }` blocks.

### Fast Refresh warnings while adding files

Vite's React Fast Refresh requires a file to export either components
or non-components, not both. If you see "Could not Fast Refresh"
warnings, you haven't broken anything — the module just does a full
reload rather than in-place update. Pre-existing issue in
`ScenariosContext.tsx` and a few others. Not caused by analysis-type
additions.

---

## Summary: file touch list

### Snapshot-based analysis type (full surface):

BE:
- `graph-editor/lib/runner/analysis_types.yaml` — register
- `graph-editor/lib/runner/my_analysis_derivation.py` — derivation (new file)
- `graph-editor/lib/api_handlers.py` — dispatch in snapshot handler
- `graph-editor/lib/analysis_subject_resolution.py` — subject scope + read mode

FE — registration:
- `graph-editor/src/components/panels/analysisTypes.ts` — icon + snapshotContract
- `graph-editor/src/services/analysisTypeResolutionService.ts` — chart kind map + inject

FE — chart kind type system:
- `graph-editor/src/components/charts/AnalysisChartContainer.tsx` — union, normaliser, inferrer, labeler, subject selector
- `graph-editor/src/services/chartDisplayPlanningService.ts` — TIME_SERIES_KINDS, multiScenarioTimeSeriesKinds

FE — data:
- `graph-editor/src/lib/graphComputeClient.ts` — response normaliser + analysis_type union
- `graph-editor/src/lib/snapshotBootTrace.ts` — isSnapshotBootChart

FE — rendering:
- `graph-editor/src/services/analysisECharts/snapshotBuilders.ts` (or new file) — builder
- `graph-editor/src/services/analysisEChartsService.ts` — dispatcher case + re-export

FE — settings:
- `graph-editor/src/lib/analysisDisplaySettingsRegistry.ts` — display settings entry

Tests:
- `graph-editor/lib/tests/test_my_analysis.py` — unit tests on derivation
- `graph-ops/scripts/my-analysis-blind-test.sh` — CLI blind test

That's 13-15 files depending on whether you need a dedicated builder
file and whether the subject-resolution rule already exists.

### Local-compute analysis type:

Skip BE files 1-4, skip FE snapshot files (graphComputeClient
normaliser, snapshotBootTrace). Net: ~7 files.

---

## Design debt

This playbook describes the **current state**, not the desired state.
~80% of the touch list is boilerplate scattered across files that each
hold a hardcoded list, switch, or union. A follow-up proposal covers:

- **Unified `AnalysisTypeRegistry` (FE)** — one entry per type, from
  which `analysisTypes.ts`, `analysisTypeResolutionService.ts`,
  `AnalysisChartContainer.tsx`, `chartDisplayPlanningService.ts`,
  `snapshotBootTrace.ts`, and `analysisDisplaySettingsRegistry.ts` all
  derive. Collapses ~8 files to 1.
- **Snapshot response normaliser factory** — current normalisers are
  ~80 lines each and 90% identical. Replace with a factory taking
  `(rowShape, semantics)` and returning the normaliser.
- **BE dispatch table** — replace the chain of `elif analysis_type == 'X':`
  in `api_handlers.py` with a dict `{analysis_type: derivation_fn}` and a
  standard signature.
- **Time-series ECharts builder factory** — share time axis + crosshair
  + legend + theming + size-scaling across time-series builders; each
  builder only plugs in its series-generation logic.

These are described in [refactor proposal, TBD filename]. The refactor
is bounded — no semantic changes, just collapsing boilerplate. ETA
estimate: 2-3 days for the registry + normaliser factory, which
addresses ~70% of the pain.
