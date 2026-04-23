# Adding a New Analysis Type

**Last updated**: 22-Apr-26  
**Status**: Current-state playbook, aligned with `analysis-types-refactor-proposal.md`

This playbook describes how the system works **today** while the
analysis-types refactor remains unshipped. It is intentionally a
current-state document, not a target-state design.

As of 22-Apr-26:

- `graph-editor/src/components/panels/analysisTypes.ts` already acts as a
  partial FE registry for identity, icons, snapshot planning metadata,
  some view/kind declarations, and minimised renderers
- `graph-editor/src/lib/analysisDisplaySettingsRegistry.ts` is already the
  chart-kind settings registry
- several other analysis-type facts still live in scattered helper tables
  and branches

The companion target architecture now lives in
`docs/current/analysis-types-refactor-proposal.md`. Read that note if you
are changing the registration seams themselves. Use this playbook when
you need to ship a new type or extend an existing one on the current
scaffolding.

Before you start:

- read `CHART_PIPELINE_ARCHITECTURE.md`
- read `ANALYSIS_RETURN_SCHEMA.md`
- read `analysis-types-refactor-proposal.md`
- if the analysis is forecast-backed, also read docs 59 and 60 before
  inventing any new temporal or snapshot-preparation path

Pick the closest existing type and mirror it. For time-series
snapshot-envelope analyses, `daily_conversions`, `conversion_rate`, and
`cohort_maturity` are still the best starting references.

---

## Pre-flight decisions

Before touching files, decide four things.

### 1. What category is this type?

There are currently three categories that matter operationally.

**Local-compute**

- derived purely from the in-memory graph
- no snapshot DB request
- examples: `graph_overview`, `edge_info`

**Snapshot-envelope**

- routes through the BE snapshot-subject handler
- FE prepares snapshot subjects and the BE returns a per-scenario /
  per-subject envelope that `graphComputeClient.ts` normalises
- examples: `daily_conversions`, `cohort_maturity`, `conversion_rate`,
  `lag_fit`, `surprise_gauge`

**Standard runner with snapshot-adjacent FE preparation**

- FE still needs snapshot-adjacent preparation metadata, but the BE must
  stay on the normal runner path rather than the snapshot-envelope path
- current live example: `conversion_funnel`

Do not assume "`snapshotContract` on the FE" means "snapshot-envelope
dispatch on the BE". That is false today and the distinction is
load-bearing.

### 2. Are you reusing an existing chart kind or introducing a new one?

This is separate from analysis type.

- Reusing an existing chart kind usually means no builder or chart-kind
  type-system work.
- Introducing a new chart kind means you will also touch
  `AnalysisChartContainer.tsx`,
  `analysisEChartsService.ts`, the builder files, and
  `analysisDisplaySettingsRegistry.ts`.

### 3. What is the subject shape?

One node / two nodes / from+to / siblings / funnel path / whole graph.
This drives:

- the `when` predicate in `analysis_types.yaml`
- FE visibility in menus
- BE subject resolution for snapshot-envelope types

### 4. Is the analysis forecast-backed?

If yes, do **not** invent a new semantic fork. Shared preparation,
temporal intent, regime handling, and projection contracts are now
defined by docs 59 and 60. New forecast-backed types should project from
the existing shared seams where possible.

---

## 1. Register the analysis in `analysis_types.yaml`

**File**: `graph-editor/lib/runner/analysis_types.yaml`

Add or update the declarative BE entry with:

- `id`
- `name`
- `description`
- `when`
- `runner`

This still governs which analyses appear for a given DSL shape and which
runner family the request uses.

Order still matters: more specific `when` clauses must come before more
general ones.

If the type is snapshot-envelope today, you will **also** need the BE
snapshot dispatch work described below. That metadata is not yet fully
owned by `analysis_types.yaml`, though the proposal aims to move it there.

---

## 2. Register the FE metadata in `analysisTypes.ts`

**File**: `graph-editor/src/components/panels/analysisTypes.ts`

This is already the main FE registry surface. Add an entry with the
metadata the current FE actually consumes:

- `id`
- `name`
- `shortDescription`
- `selectionHint`
- `icon`
- `snapshotContract` if FE snapshot planning needs it
- `views` if the type has explicit view_type → kind declarations
- any minimised renderer / label hooks if the type needs custom minimised
  behaviour
- `devOnly` or `internal` if applicable

Important: `snapshotContract` is **FE planning metadata**, not a generic
"this is definitely a BE snapshot type" flag. It controls FE preparation
such as snapshot-subject planning and regime population. It does **not**
by itself mean the BE should route to the snapshot-subject handler.

That distinction is why `conversion_funnel` works.

---

## 3. Expose the type to current FE chart-kind helpers

### `analysisTypeResolutionService.ts`

**File**: `graph-editor/src/services/analysisTypeResolutionService.ts`

Current live state still keeps one chart-kind mapping here via
`CHART_KINDS_BY_ANALYSIS_TYPE`.

If the new type needs chart rendering under the current scaffolding:

- add its kind list to `CHART_KINDS_BY_ANALYSIS_TYPE`
- include `table` if tabular fallback should be available
- update `injectLocalAnalysisTypes()` if the type is FE-injected under a
  specific DSL or graph predicate rather than coming from the BE list

This is one of the explicit drift seams targeted by the refactor. Until
Phase 1 lands, keep it in sync with `analysisTypes.ts`.

### `AnalysisChartContainer.tsx`

**File**: `graph-editor/src/components/charts/AnalysisChartContainer.tsx`

Only touch this file if you are introducing a **new chart kind** or a
new special-case chart-kind policy.

Current live seams here are:

- `ChartKind` union
- `normaliseChartKind()`
- `labelForChartKind()`
- `inferredChartKind`
- `showSubjectSelector`

If the new analysis reuses an existing chart kind and subject-selector
behaviour, do not edit this file just because you are adding a new
analysis type.

### `chartDisplayPlanningService.ts`

**File**: `graph-editor/src/services/chartDisplayPlanningService.ts`

Touch this only when the chart-kind behaviour needs planning updates:

- add to `TIME_SERIES_KINDS` if the kind is time-axis based
- update the multi-scenario time-series set if multiple scenarios should
  overlay rather than collapsing to the last visible scenario
- update augmentation logic if the type gets extra kinds from FE-side
  helpers

Again: this is chart-kind work, not generic analysis-type work.

---

## 4. Add the current BE snapshot-envelope wiring if needed

This section applies only to **snapshot-envelope** types.

### Subject scope and read mode

**File**: `graph-editor/lib/analysis_subject_resolution.py`

Today the BE still reads snapshot-envelope scope and read-mode metadata
from:

- `ANALYSIS_TYPE_SCOPE_RULES`
- `ANALYSIS_TYPE_READ_MODES`

Add the new type to both tables.

This is a current-state requirement. The proposal targets these tables
for consolidation into `analysis_types.yaml`, but that has not landed yet.

### Snapshot derivation dispatch

**File**: `graph-editor/lib/api_handlers.py`

Today the BE snapshot handler still dispatches per-type derivations
through explicit branches. Wire the new derivation in there.

If the type is not snapshot-envelope, do **not** add it here just because
it has `snapshotContract` on the FE.

---

## 5. Build the derivation

### Local-compute types

**File**: `graph-editor/src/services/localAnalysisComputeService.ts`

For local types:

- add the ID to `LOCAL_COMPUTE_TYPES`
- add a case to `computeLocalResult`
- return a valid `AnalysisResult`

The result must include `semantics.chart.recommended` when chart
rendering is expected; otherwise the container cannot resolve a chart
kind.

### Snapshot-envelope types

**BE derivation file**: `graph-editor/lib/runner/my_analysis_derivation.py`

Implement the derivation as a pure transform from the input rows and
resolved subject/edge context into the result dict.

Use existing helpers where appropriate rather than rebuilding model or
band logic locally.

### Forecast-backed types

If the analysis is forecast-backed, prefer projection from existing
forecast preparation / runtime seams over opening a new direct snapshot
path. The live shared forecast-consumer work is no longer optional
background context; it is the binding semantic substrate.

---

## 6. Build or reuse the chart builder

**Files**:

- `graph-editor/src/services/analysisECharts/...`
- `graph-editor/src/services/analysisEChartsService.ts`

Only do builder work when:

- the analysis introduces a new chart kind, or
- it reuses an existing kind but still needs a dedicated builder branch

Builder dispatch remains chart-kind keyed in current live state and in
the target proposal. Do not try to move builder ownership into the FE
analysis-type registry.

House conventions remain unchanged:

- use `echartsThemeColours()` for theme-aware colours
- use `echartsTooltipStyle()` for tooltip styling
- use the shared legend helpers for multi-scenario legends
- apply common settings at the end
- keep time-series axes and crosshair behaviour aligned with the existing
  house style

If the new type reuses an existing chart kind and existing builder path,
skip this step.

---

## 7. Add or extend display settings

**File**: `graph-editor/src/lib/analysisDisplaySettingsRegistry.ts`

Display settings remain a **chart-kind** concern.

Add or extend `CHART_DISPLAY_SETTINGS` when:

- the analysis introduces a new chart kind, or
- an existing kind needs new controls

Each setting still declares:

- `key`
- `label`
- `type`
- `options`
- `defaultValue`
- surface visibility (`propsPanel`, `inline`, `contextMenu`)
- `computeAffecting`

If you are reusing an existing chart kind with no new controls, do not
add a duplicate settings entry just because you added a new analysis.

---

## 8. Normalise the snapshot-envelope response

**File**: `graph-editor/src/lib/graphComputeClient.ts`

Current live state still has per-type snapshot normalisers. For a new
snapshot-envelope type:

- add a `normaliseSnapshotMyAnalysisResponse(...)` branch
- chain it into the existing normaliser waterfall
- produce flat `data` rows with `scenario_id` / `subject_id` where
  appropriate

Important corrections to older guidance:

- `AnalysisRequest.analysis_type` is currently a plain string, not a
  discriminated union you must extend
- the FE now has a live need for preserved per-scenario structure in some
  analyses; flat rows alone are not always enough

If the result has focused-scenario, compare-mode, or minimised-view
behaviour that cannot be reconstructed safely from rows, keep a canonical
preserved scenario block. The live surprise-gauge shape uses:

- `scenario_results`
- `focused_scenario_id`

That is the current best pattern until the proposal's normaliser factory
lands.

---

## 9. Update snapshot-needed and boot routing if needed

This applies to snapshot-capable types and any type whose snapshot need
depends on the chosen chart kind.

**Files**:

- `graph-editor/src/hooks/useCanvasAnalysisCompute.ts`
- `graph-editor/src/services/analysisBootCoordinatorService.ts`
- `graph-editor/src/lib/snapshotBootTrace.ts`

The current live system has more than one snapshot-routing seam:

- `useCanvasAnalysisCompute.ts` decides whether a given
  analysis-type × kind combination actually needs snapshot-backed compute
- `analysisBootCoordinatorService.ts` mirrors that decision for boot
  requirement collection
- `snapshotBootTrace.ts` decides which analyses are tracked as
  snapshot-boot charts in the developer trace path

Do not update only one of these when the new type changes snapshot
behaviour.

Special current case: `branch_comparison` and `outcome_comparison` need
snapshot-backed compute only for `time_series`, not for their bar/pie
variants.

---

## 10. Tests

Follow `TESTING_STANDARDS.md`: favour real boundaries, parity when
replacing a path, and blind assertions over mocks.

### Derivation test

Add or extend a focused Python derivation test such as
`graph-editor/lib/tests/test_my_analysis.py`.

This should assert real invariants on the derivation output, not just
"returns something".

### FE normaliser / registry test

Update the existing FE seam tests where possible rather than creating
isolated new files by default. The most relevant current suites are:

- `graph-editor/src/services/__tests__/analysisRequestContract.test.ts`
- `graph-editor/src/services/__tests__/contentItemSpec.test.ts`
- `graph-editor/src/services/__tests__/HoverAnalysisPreview.test.ts`
- `graph-editor/src/lib/__tests__/graphComputeClient.test.ts`
- `graph-editor/src/lib/__tests__/analysisDisplaySettingsRegistry.test.ts`

Examples of what to add:

- a registry completeness assertion for the new type
- a snapshot-needed routing test if the type is kind-sensitive
- a normaliser shape test if the type is snapshot-envelope
- a display-vs-compute test if it introduces display-only projections

### Blind end-to-end CLI test

Add a synth-backed blind harness in `graph-ops/scripts/` when the type is
material enough to need outside-in proof. Mirror the closest existing
script such as:

- `conversion-rate-blind-test.sh`
- `asat-blind-test.sh`

Use a synth graph, not a production graph.

---

## Common traps

### `snapshotContract` is not BE snapshot dispatch

FE snapshot planning, BE snapshot-envelope dispatch, and FE snapshot
normalisation are three different signals today. Do not collapse them.
`conversion_funnel` is the proof case.

### Snapshot need can depend on chart kind

Some types are only snapshot-backed for particular kinds. Do not assume
"type has `snapshotContract`" means "every kind for this type must wait
for snapshot-backed compute".

### New analysis type and new chart kind are different jobs

If you are reusing an existing chart kind, you may not need builder,
type-system, or display-settings changes. Avoid cargo-cult file touches.

### Per-subject failures can abort the whole scenario

If a snapshot-envelope derivation raises inside the per-subject loop, it
can abort the entire scenario. For expected gates or unavailable cases,
emit a per-subject failure entry and continue.

### BE latency gate false positives

If your analysis rejects latency edges, check
`latency.latency_parameter`, not `sigma > 0`. Promoted fields can make
non-latency edges look latency-shaped if you use the wrong predicate.

### Flat rows may be insufficient

If the UI needs focused-scenario, compare-mode, or minimised behaviour,
keep canonical preserved scenario structure in addition to flat `data`
rows. The surprise-gauge path is the current reference.

### ECharts legend colours come from top-level `color`

If you omit top-level `color` on a series, ECharts may assign a default
palette colour and the legend will drift from the intended swatch.

### Crosshair labels need axis-level `axisPointer.label`

Time-series crosshair labels are not controlled solely by the tooltip
crosshair setting. Mirror the existing axis-level label configuration
when matching cohort-maturity-style charts.

---

## Summary: current file-touch patterns

The current touch count depends on what you are actually adding.

### Snapshot-envelope analysis reusing an existing chart kind

Usually touches:

- `graph-editor/lib/runner/analysis_types.yaml`
- `graph-editor/lib/runner/my_analysis_derivation.py`
- `graph-editor/lib/api_handlers.py`
- `graph-editor/lib/analysis_subject_resolution.py`
- `graph-editor/src/components/panels/analysisTypes.ts`
- `graph-editor/src/services/analysisTypeResolutionService.ts`
- `graph-editor/src/lib/graphComputeClient.ts`
- snapshot-needed / boot files if the type changes routing behaviour
- relevant tests

### New analysis plus a new chart kind

Adds, on top of the above:

- `graph-editor/src/components/charts/AnalysisChartContainer.tsx`
- `graph-editor/src/services/chartDisplayPlanningService.ts`
- `graph-editor/src/services/analysisECharts...`
- `graph-editor/src/services/analysisEChartsService.ts`
- `graph-editor/src/lib/analysisDisplaySettingsRegistry.ts`

### Local-compute analysis

Usually skips:

- BE snapshot-envelope dispatch work
- FE snapshot normaliser work
- snapshot-needed / boot routing

But it may still need:

- `analysis_types.yaml` if it is BE-exposed in selection
- `analysisTypes.ts`
- `analysisTypeResolutionService.ts`
- local compute service changes
- tests

---

## Relationship to the refactor proposal

This playbook is intentionally narrower than
`analysis-types-refactor-proposal.md`.

Current live debt, now explicitly acknowledged:

- FE identity and snapshot planning are already partly centralised in
  `analysisTypes.ts`
- chart kinds, snapshot-needed routing, and snapshot boot are still split
  across multiple FE seams
- BE snapshot-envelope metadata is still split between
  `analysis_types.yaml`, `analysis_subject_resolution.py`, and
  `api_handlers.py`
- FE snapshot normalisation is still per-type boilerplate in
  `graphComputeClient.ts`

The proposal's current target is:

- finish the FE registry using `analysisTypes.ts` as the seed
- consolidate BE snapshot-envelope metadata into `analysis_types.yaml`
- replace per-type FE snapshot normalisers with a factory
- optionally, later, extract a shared chart-kind helper if the builder
  patterns stabilise

The proposal no longer owns forecast-consumer semantics. Docs 59 and 60
do. This playbook therefore assumes those semantics are binding and
focuses only on the current implementation seams you must touch until the
refactor lands.
