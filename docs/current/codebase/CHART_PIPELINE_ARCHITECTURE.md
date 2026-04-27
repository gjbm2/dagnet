# Chart Pipeline Architecture

How charts are defined, computed, hydrated, and refreshed across chart files, canvas analyses, and share links.

## Chart Recipe (Unified Data Model)

A chart recipe defines **what to compute and how to render**. Same structure used across chart files, canvas analyses, and share payloads.

### ChartRecipeCore

- `analysis`: `{ analysis_type, analytics_dsl, what_if_dsl? }`
- `scenarios?`: `ChartRecipeScenario[]`

### Key distinction

- **`analytics_dsl`**: the chart's identity -- which nodes, edges, or path the analysis examines (e.g. `from(X).to(Y)`). Fixed by design.
- **`effective_dsl`**: each scenario's complete DSL including parameters and window state. Fully portable.

## Chart File Data Model

When a chart lives in its own file (`ChartFileDataV1`):

| Field | Purpose |
|-------|---------|
| `version` | Schema version (1.0.0) |
| `chart_kind` | Display variant (analysis_funnel, analysis_bridge, etc.) |
| `title` | Display title |
| `recipe` | What to compute (analysis + scenarios + display settings) |
| `definition` | Canonical user edits (view mode, display settings, title) |
| `deps` | `ChartDepsStampV1` -- dependency snapshot for staleness detection |
| `deps_signature` | Hash of deps (quick staleness check) |
| `payload` | Cached result (volatile, re-computed on refresh) |

## Chart Lifecycle

### Phase 1: Creation (recipe assembly)

1. Collect source metadata: parent file ID, tab ID, analysis type
2. Build recipe scenarios: derive `effective_dsl` from each scenario's current state
3. Derive recipe analysis: `analysis_type` + `analytics_dsl`
4. Determine pinned recompute eligibility: can this chart refresh without its parent tab?
5. Seal as chart file with timestamp, signature, and initial result

### Phase 2: Hydration (dependency stamp)

`ChartDepsStampV1` captures all inputs affecting the computed result:

| Input | Purpose |
|-------|---------|
| `mode` | `'linked'` (follows parent tab) or `'pinned'` (standalone) |
| `analysis` | Type and analytics DSL (the "what") |
| `scenarios` | Ordered list with DSLs and visibility modes |
| `inputs_signature` | Hash of graph file revisions affecting scenarios |
| `reference_day_uk` | Current reference day (for dynamic DSL expressions) |
| `compute_display` | Compute-affecting display settings (e.g. bayes_band_level) |

### Phase 3: Computation

1. For each scenario: build scenario-specific graph (apply params, DSL overrides, visibility mode)
2. Send to compute backend: `graphComputeClient.analyzeMultipleScenarios()`
3. Receive `AnalysisResult`: structured result with dimensions, metrics, chart specs, raw data
4. Cache in `payload` for re-rendering

### Phase 4: Display planning

`chartDisplayPlanningService` converts computed results into rendering instructions:

| Decision | Logic |
|----------|-------|
| **X-axis mode** | `'time'` for daily_conversions/cohort_maturity, `'stage'` for bridge, `'scenario'` for comparisons |
| **Scenario selection** | Multi-scenario charts render all visible; time-series defaults to last scenario |
| **Metric basis** | Inferred from visibility mode: forecast-only, evidence-only, or blended |
| **F+E rendering** | Split stack if all scenarios are f+e and result has both metrics |
| **Fallback reasons** | User-visible explanations if chart type was downgraded |

### Phase 5: Refresh (staleness detection)

**Linked refresh** (chart connected to parent tab):
- Parent tab recomputes linked charts via `recomputeOpenChartsForGraph()`
- Inherits current scenario state from tab

**Pinned refresh** (standalone):
- Re-derives `currentDepsStamp` from stored recipe
- Compares signatures: `storedDepsSignature` vs `chartDepsSignatureV1(currentStamp)`
- If stale: recompute and store new payload + signature

**Changes that trigger recompute**: analysis type/DSL changes, scenario additions/deletions/DSL changes, graph input changes, reference day rollover, display setting changes.

## Chart Modes: Linked vs Pinned

### Linked (`mode: 'linked'`)

- Connected to a parent tab ID
- Follows tab state: visible scenarios, visibility modes, what-if DSL
- Recompute triggered by parent tab changes
- Demotes to pinned if parent tab closes

### Pinned (`mode: 'pinned'`)

- Standalone (no parent tab)
- Computes from frozen recipe: `recipe.scenarios` are authoritative
- Refresh only if `pinned_recompute_eligible === true`
- Best-effort: if recipe refers to deleted nodes, compute errors

## Staleness Detection

Signature-based comparison using FNV-1a 32-bit hash:

```
chartDepsSignatureV1(stamp) = "v1:" + fnv1a32(stableStringify(canonicalisedStamp))
```

If stored signature differs from current, chart is stale and needs recompute.

## Analysis Types

Analysis types determine what the compute backend calculates, the result schema, and recommended chart kind:

| Analysis type | Chart kind | Purpose |
|---------------|-----------|---------|
| `funnel` | `analysis_funnel` | Step-by-step conversion |
| `bridge_view` | `analysis_bridge` | Two-point comparison |
| `daily_conversions` | `analysis_daily_conversions` | Time-series by day |
| `cohort_maturity` | `analysis_cohort_maturity` | Cohort progression over time |

`analysis_type` is permanently fixed once set on a chart.

## Canvas Analyses vs Chart Files

Both use the same recipe structure. Difference is lifecycle:

- **Chart files**: persistent derive-once artefacts (opened as tabs)
- **Canvas analyses**: embedded in the graph, auto-recompute when graph changes (if `live: true`)

## Key Files

| File | Role |
|------|------|
| `src/types/chartRecipe.ts` | ChartRecipeCore, ChartFileDataV1, ChartDepsStampV1 |
| `src/services/chartOperationsService.ts` | Chart file CRUD |
| `src/services/chartRecomputeService.ts` | Recompute orchestration |
| `src/services/chartRefreshService.ts` | Staleness detection, refresh triggers |
| `src/services/chartHydrationService.ts` | Dependency stamp creation |
| `src/services/chartDisplayPlanningService.ts` | Display planning (axes, metrics, scenarios) |
| `src/lib/graphComputeClient.ts` | Frontend-backend analysis communication |
| `src/lib/chartDeps.ts` | Signature computation, staleness check |
