# Project LAG: Implementation Plan

**Status:** Active
**Based on:** `docs/current/project-lag/design.md`

This document outlines the phased implementation plan for Project LAG (Latency-Aware Graph Analytics).

---

## Phase P0: Rename `cost_time` → `labour_cost` (Pre-requisite)

**Goal:** Clean up naming before introducing latency complexity. This is a standalone refactor with its own PR, test, and merge cycle.

**Rationale:** Bundling a rename into a complex feature branch creates noisy diffs and makes bisecting harder. Do this first.

### P0.1 TypeScript Changes

**File:** `graph-editor/src/types/index.ts`
- Rename `cost_time` → `labour_cost` in `GraphEdge`.
- Rename `cost_time` → `labour_cost` in `CostParam` (if separate).

**File:** `graph-editor/src/types/scenarios.ts`
- Update any `cost_time` references in scenario types.

### P0.2 Python Changes

**File:** `graph-editor/lib/graph_types.py`
- Rename `cost_time` → `labour_cost` in `Edge` Pydantic model.
- Update any validators or computed fields referencing the old name.

### P0.3 Schema Changes

**File:** `graph-editor/public/param-schemas/parameter-schema.yaml`
- Rename `cost_time` → `labour_cost`.

### P0.4 Service & UI Updates

Global search/replace across:
- `graph-editor/src/services/` — UpdateManager, paramRegistryService, etc.
- `graph-editor/src/components/` — ParameterSection, PropertyPanel, etc.
- `graph-editor/src/contexts/` — any context accessing cost fields.

### P0.5 Test Updates

- Update all existing tests that reference `cost_time`.
- Run full test suite to catch any missed references.

### P0.6 Verification & Merge

**Acceptance criteria:**
- [ ] `grep -r "cost_time" graph-editor/src/` returns zero hits (excluding comments explaining the rename).
- [ ] `grep -r "cost_time" graph-editor/lib/` returns zero hits.
- [ ] All existing tests pass.
- [ ] Manual smoke test: load a graph with cost data, verify it displays correctly.

**PAUSE:** Merge this PR. Verify CI green. Then proceed to Phase C1.

---

## Phase C1: Schema Changes & Core Types

**Goal:** Establish the data structures required for latency modelling across the full stack (Graph, Files, Python).

**Design references:** `design.md §3` (Data Model Changes), `§9.I` (Type Files), `§9.J` (Scenarios)

### 1.1 TypeScript Type Definitions
**Design reference:** `design.md §3.1` (Edge Schema), `§7.2` (EdgeLatencyDisplay), `§9.K` (EdgeParamDiff)

**File:** `graph-editor/src/types/index.ts`
- Add `LatencyConfig` interface:
  ```typescript
  interface LatencyConfig {
    maturity_days?: number;           // >0 enables tracking
    maturity_days_overridden?: boolean;
    recency_half_life_days?: number;  // Phase 1 fast-follow
    recency_half_life_days_overridden?: boolean;
    anchor_node_id?: string;          // computed by MSMDC
    // ... other fields per design.md §3.1
  }
  ```
- Add `latency` field to `GraphEdge`.
- Add `EdgeLatencyDisplay` interface for rendering (p.evidence, p.forecast, p.mean, completeness).

**File:** `graph-editor/src/types/scenarios.ts`
- **Param pack cleanup** (design §9.K.1):
  - Remove `distribution`, `min`, `max`, `alpha`, `beta` from `ProbabilityParam`
  - Remove `distribution`, `min`, `max` from `CostParam`
- Add LAG fields to `ProbabilityParam`:
  - `forecast_mean`, `forecast_stdev` — mature baseline
  - `evidence_mean`, `evidence_stdev` — observed rate
- NOTE: `completeness`, `n`, `k`, `median_lag_days` are display-only, NOT in param packs

**File:** `graph-editor/src/services/GraphParamExtractor.ts`
- Stop extracting `distribution`, `min`, `max`, `alpha`, `beta` from edges
- Add extraction for new LAG fields (`forecast_mean`, `forecast_stdev`, `evidence_mean`, `evidence_stdev`)

### 1.2 Python Pydantic Models
**Design reference:** `design.md §3.1` (LatencyConfig interface), `§9.I` (Pydantic models)

**File:** `graph-editor/lib/graph_types.py`
- Add `LatencyConfig` model.
- Add `latency` field to `Edge`.

### 1.3 Parameter File Schema
**Design reference:** `design.md §3.2` (Parameter File Additions), `§3.3` (sliceDSL), `§3.4` (Date Format), `§9.F` (Parameter Storage)

**File:** `graph-editor/public/param-schemas/parameter-schema.yaml`
- Add `latency` configuration section (top-level).
- Update `values` item schema:
  - Add `cohort_from`, `cohort_to` (date format: `d-MMM-yy`).
  - Add `median_lag_days`, `mean_lag_days` arrays.
  - Add `anchor_n_daily`, `anchor_median_lag_days` arrays.
  - Add `latency` summary block (median_days, completeness, histogram).
  - Add `anchor_latency` summary block.
  - Update `sliceDSL` description to emphasize canonical format.
- **Date format standardisation** (`design.md §3.4`):
  - Change `window_from`/`window_to` from ISO `date-time` to `d-MMM-yy` pattern.
  - Add `cohort_from`/`cohort_to` with same pattern.
  - Exception: `data_source.retrieved_at` and `metadata.*` remain ISO `date-time`.

### 1.4 Update Manager Mappings
**Design reference:** `design.md §9.H` (UpdateManager), `§9.K` (Config/Data field mappings)

**File:** `graph-editor/src/services/UpdateManager.ts`

**Latency CONFIG fields (graph ↔ param file, bidirectional):**
| Graph field | File field | Override flag |
|-------------|------------|---------------|
| `edge.latency.maturity_days` | `latency.maturity_days` | `maturity_days_overridden` |
| `edge.latency.recency_half_life_days` | `latency.recency_half_life_days` | `recency_half_life_days_overridden` |
| `edge.latency.anchor_node_id` | `latency.anchor_node_id` | (computed, no override) |

**Latency DATA fields (file → graph only):**
| File field | Graph field | Notes |
|------------|-------------|-------|
| `values[latest].latency.median_days` | `edge.latency.median_lag_days` | Display only |
| `values[latest].latency.completeness` | `edge.latency.completeness` | Display only |
| `values[latest].mean` (mature cohorts) | `edge.p.forecast.mean` | Retrieval-time computation |
| `values[latest].stdev` (mature cohorts) | `edge.p.forecast.stdev` | Retrieval-time computation |

**Other mappings:**
- Verify `labour_cost` mappings work correctly (renamed in Phase P0).

### 1.5 MSMDC Extension (Python)
**Design reference:** `design.md §3.1` (anchor_node_id), `§9.K` (MSMDC anchor computation)

**File:** `graph-editor/lib/msmdc.py`
- Extend MSMDC to compute `anchor_node_id` alongside `query` generation.
- Logic: BFS from edge.from to find furthest topologically upstream START node.
- Always compute for all edges (output is cheap, avoids conditional triggering).
- Handle edge cases: edge.from IS a start node (A=X case) → `anchor_node_id = edge.from`.

---

## Phase C2: DSL & Query Architecture

**Goal:** Enable `cohort()` queries and dual-slice retrieval (window + cohort).

**Design references:** `design.md §4` (Query Architecture Changes), `§9.A` (DSL Construction), `§9.E` (Amplitude Adapter)

### 2.1 DSL Parsing
**Design reference:** `design.md §4.1` (cohort() syntax), `§4.2` (Cohort Anchor Node)

**File:** `graph-editor/src/lib/queryDSL.ts`
- Add parsing support for `cohort(start:end)` and `cohort(anchor, start:end)`.
- Ensure strict date handling (absolute dates preferred).

**File:** `graph-editor/src/lib/das/compositeQueryParser.ts`
- Update compound query parsing to handle `cohort()` clauses.
- Support `or(cohort(...), window(...))` combinations.

### 2.2 DSL Construction
**Design reference:** `design.md §9.A` (DSL Construction table), `§4.6` (Dual-Slice Retrieval)

**File:** `graph-editor/src/lib/dslConstruction.ts`
- Add `cohort()` clause construction.
- Distinguish `cohort()` from `window()` based on edge latency configuration.
- Handle anchor node inclusion in DSL when `anchor_node_id` differs from edge.from.

**File:** `graph-editor/src/lib/dslExplosion.ts`
- Update explosion logic to handle `cohort()` clauses.
- Generate atomic slices for `cohort()` × context combinations.
- Handle `or(cohort(...), window(...))` producing separate cohort and window slices.

### 2.3 Query Payload Construction
**Design reference:** `design.md §9.A` (buildDslFromEdge), `§4.6` (Dual-Slice requirements, Query resolution table)

**File:** `graph-editor/src/lib/das/buildDslFromEdge.ts`
- Update `QueryPayload` interface to support `cohort` mode.
- Update `buildDslFromEdge` to:
  - Detect `latency.maturity_days > 0` on edge (latency tracking enabled).
  - **Upstream maturity check:** For `cohort()` queries, also use cohort mode if `upstream_maturity > 0` even when edge's own `maturity_days = 0`. This ensures cohort population semantics propagate through instant edges downstream of latency edges.
  - Construct `cohort` payload if applicable.
  - Handle dual-slice requirements (if pinned DSL requests both).
  - Resolve `anchor_node_id` for cohort queries (default to edge.from or explicitly set).

**Key rule:** `cohort()` only falls back to `window()` when BOTH the edge's own `maturity_days = 0` AND `compute_a_x_maturity(anchor, edge.from) = 0`.

### 2.4 Amplitude Adapter Refactoring
**Design reference:** `design.md §4.4` (Amplitude data fields), `§9.E` (Amplitude Adapter), `Appendix B` (Response Reference)

**File:** `graph-editor/src/lib/das/adapters/amplitudeHelpers.ts` (NEW)
- Create helper to encapsulate complex funnel construction logic.
- Move logic for visited, excludes, cases, and context from YAML to this file.
- Implement `buildCohortFunnel` logic (3-step: Anchor -> From -> To).

**File:** `graph-editor/public/defaults/connections.yaml`
- Update `amplitude-prod` adapter to use the new `amplitudeHelpers`.
- Pass `cs` (conversion window) parameter.
- Update `response` extraction to include `dayMedianTransTimes` and histograms.

---

## Phase C3: Data Storage, Aggregation & Inference

**Goal:** Fetch, store, and process latency data (evidence vs forecast).

**Design references:** `design.md §5` (Inference Engine), `§4.8` (Query-Time vs Retrieval-Time), `§9.C-F` (Data Services)

### 3.1 Data Operations Service
**Design reference:** `design.md §9.C` (dataOperationsService), `§4.8` (Retrieval-time computation), `§9.3` (Data Flow)

**File:** `graph-editor/src/services/dataOperationsService.ts`
- Update `getFromSource` / `getFromSourceDirect`:
  - Handle cohort-mode responses.
  - Extract latency stats (medians, histograms) from Amplitude response.
  - Call aggregation service to compute mature/immature split.
  - Store extended data to parameter file via `paramRegistryService`.

### 3.2 Window Aggregation Service
**Design reference:** `design.md §5.0` (Mature/Immature Split), `§5.0.1` (Completeness calculation), `§9.D` (windowAggregationService)

**File:** `graph-editor/src/services/windowAggregationService.ts`
- Implement `computeMatureImmatureSplit`.
- Update `aggregateWindow` to handle cohort data structures.
- Implement `completeness` calculation.

### 3.3 Statistical Enhancement Service (Forecasting)
**Design reference:** `design.md §5.0.2` (Phase 0 Forecasting Formula), `§4.8` (Query-time computation)

**File:** `graph-editor/src/services/statisticalEnhancementService.ts`
- Implement `Formula A` (forecasting logic) as a new enhancer type (e.g., `'latency-forecast'`).
- Logic:
  - Take raw aggregation (evidence).
  - Read `p.forecast` (forecast baseline) from parameter file.
  - Apply forecast formula based on cohort ages.
  - Return blended `p.mean`.

### 3.4 Parameter Registry Service
**Design reference:** `design.md §9.F` (paramRegistryService), `§3.3` (Canonical sliceDSL)

**File:** `graph-editor/src/services/paramRegistryService.ts`
- Ensure extended parameter schema is supported during load/save.
- Verify `sliceDSL` generation uses canonical format (absolute dates + anchor).

### 3.5 Slice Dimension Extraction & Merging
**Design reference:** `design.md §3.3, §4.7.1, §4.7.3`

**Files:**
- `graph-editor/src/services/dataOperationsService.ts` (or relevant utility)
- `graph-editor/src/lib/das/` (slice handling utilities)

**Tasks:**
- Update `extractSliceDimensions()` to generate canonical `sliceDSL` (anchor node_id + absolute dates) rather than preserving the original query.
- Update `mergeTimeSeriesIntoParameter()` to handle cohort data merging and update `sliceDSL` bounds on merge.
- Implement `shouldRefetch()` logic for latency edges (per design §4.7.3):
  - Non-latency: incremental gaps only (current behaviour).
  - Window with maturity > 0: re-fetch immature portion, keep mature cached.
  - Cohort: replace entire slice if immature cohorts exist or data is stale.

### 3.6 Total Maturity Calculation
**Design reference:** `design.md §4.7.2`

**File:** `graph-editor/src/services/windowAggregationService.ts` (or new utility)

**Tasks:**
- Implement `computeTotalMaturity(graph, anchor_id, edge)` algorithm.
- Logic: longest-path DP from anchor to edge.from, summing `maturity_days` along path.
- Total maturity = A→X maturity + X→Y maturity.
- Used for cache/refresh policy decisions.

---

## Phase C4: UI & Rendering

**Goal:** Visualize latency and forecast confidence in the graph.

**Design references:** `design.md §7` (UI Rendering), `§9.G` (Edge Rendering), `§9.J` (Properties Panel)

### 4.1 Edge Rendering
**Design reference:** `design.md §7.1` (Two-Layer Rendering), `§7.2` (Edge Data Model), `§9.G` (ConversionEdge)

**File:** `graph-editor/src/components/edges/ConversionEdge.tsx`
- Implement two-layer rendering:
  - Inner solid line (evidence).
  - Outer striped line (forecast/mean).
  - Visual width logic based on `p.evidence` vs `p.mean`.
- Stripe pattern: 45° angle, offset by half stripe width between layers.
- Extend existing CI band logic to render on striped portion (per `design.md §7.3`).

**File:** `graph-editor/src/lib/nodeEdgeConstants.ts`
- Add stripe pattern constants for forecast layer.

### 4.2 Edge Beads
**Design reference:** `design.md §7.4` (Edge Bead: Latency Display)

**File:** `graph-editor/src/components/edges/EdgeBeads.tsx`
- Add Latency Bead (e.g., "6d (80%)").
- Show only when `latency.maturity_days > 0` and data exists.

**File:** `graph-editor/src/components/edges/edgeBeadHelpers.tsx`
- Add helper functions for latency bead formatting and positioning.
- Format latency display string (median days + completeness percentage).

### 4.3 Properties Panel: Latency Fields
**Design reference:** `design.md §7.7` (Properties Panel: Latency Settings)

**File:** `graph-editor/src/components/ParameterSection.tsx`

Add latency fields after Distribution dropdown (applies to both `p` and `conditional_p` via shared component):

| Field | Type | Override flag | Behaviour |
|-------|------|---------------|-----------|
| Track Latency | Checkbox | `maturity_days_overridden` | When unchecked: `maturity_days = 0`. When checked: shows Maturity + Recency fields |
| Maturity | Number input | `maturity_days_overridden` | Days threshold for cohort maturity |
| Recency | Discrete slider | `recency_half_life_days_overridden` | Notches: 7, 14, 30, 60, 90, 180, Off |

**Default inference (frontend-only):**
When user checks "Track Latency" on an edge with data:
1. If `median_lag_days` exists, suggest `ceil(median_lag_days × 2)` capped at 90
2. Otherwise default to 30 days

**Read-only displays** (in edge tooltip or bead, not ParameterSection):
- Anchor Node ID
- Median Lag Days
- Completeness %

### 4.4 Scenarios & Visibility
**Design reference:** `design.md §7.3` (Per-Scenario Visibility), `§9.K` (ScenariosContext, EdgeParamDiff)

**File:** `graph-editor/src/contexts/ScenariosContext.tsx`
- Implement per-scenario visibility state (4-state cycle: F+E → F → E → hidden).
- Update Scenario Chip UI to reflect current mode.

**File:** `graph-editor/src/components/modals/ScenarioEditorModal.tsx`
- Add `forecast` and `completeness` fields as editable per-scenario.
- Mirror existing pattern for `mean`, `stdev` scenario overrides.

### 4.5 Tooltips
**Design reference:** `design.md §7.6` (Tooltips: Data Provenance)

**File:** `graph-editor/src/components/Tooltip.tsx`
- Update tooltip to show:
  - Evidence p (with n/k and source slice).
  - Forecast p.forecast (with source slice).
  - Blended p.
  - Latency stats.
- Show data provenance: which `sliceDSL` contributed to each value.

### 4.6 Window Selector: Cohort/Window Mode Toggle
**Design reference:** `design.md §7.5`

**File:** `graph-editor/src/components/WindowSelector.tsx`

- Add explicit toggle for cohort/window mode per design requirements.
- Default to cohort mode.
- Preserve date range when switching modes.
- Update DSL string accordingly on toggle.

### 4.7 Scenario Chip & Legend UI
**Design reference:** `design.md §7.3`

**Files:**
- `graph-editor/src/components/panels/ScenariosPanel.tsx`
- `graph-editor/src/components/ScenarioLegend.tsx`

**Tasks:**
- Implement 4-state visibility cycle on scenario chips: F+E → F → E → hidden.
- Icons: `<Eye>` (F+E), `<View>` (F only), `<EyeClosed>` (E only), `<EyeOff>` (hidden) from Lucide.
- Chip visual: gradient (F+E), striped (F), solid (E), semi-transparent (hidden).
- Click eye icon to cycle states.
- Toast feedback on state change.
- If `p.forecast` unavailable: disable F and F+E states, cycle only E → hidden → E.
- Update legend to show visibility state icons/indicators.

### 4.8 Sibling Probability Constraint Warnings
**Design reference:** `design.md §5.0.4`

**Files:**
- `graph-editor/src/services/integrityCheckService.ts`
- `graph-editor/src/services/graphIssuesService.ts`

**Tasks:**
- For each node with multiple outgoing edges where both have `maturity_days > 0`, compute `Σ p.mean` and `Σ p.evidence`.
- Issue classification:
  - `Σ p.evidence > 1.0`: Error (data inconsistency).
  - `Σ p.mean > 1.0` AND `Σ p.evidence ≤ 1.0`: Info-level (forecasting artefact, expected for immature data).
- Use threshold formula from `design.md §5.0.4` to determine when to surface info message.
- Wire warnings into existing `graphIssuesService` patterns.

### 4.9 View Menu: Global Recency Slider (Phase 1 Fast-Follow)
**Design reference:** `design.md §C.1.2` (Recency Bias UI)

**File:** `graph-editor/src/components/ViewMenu.tsx` (or equivalent)

**Tasks:**
- Add inline discrete slider for global `recency_half_life_days` default.
- Notches: 7, 14, 30, 60, 90, 180, Off (left = most bias, right = least bias).
- Default: 30d.
- Store in workspace settings.
- Takes effect on next fetch (not retroactive).

**Note:** Per-edge override is in `ParameterSection.tsx` (§4.3). View menu provides global default.

---

## Phase A: Analytics (Post-Core)

**Goal:** Advanced analysis views.

**Design references:** `design.md §8` (Analytics Extensions)

### A.1 Analytics Data Model
**Design reference:** `design.md §8.1` (Data Requirements for Analytics)

**File:** `graph-editor/src/types/analysis.ts` (or similar)
- Add latency analysis fields to schema.

### A.2 Analytics Panel
**Design reference:** `design.md §8.2` (Potential Analytics Panel Features), `§8.3` (Implementation Notes)

**File:** `graph-editor/src/components/AnalyticsPanel/...`
- Implement Cohort Maturity Table.
- Implement Latency Distribution Chart.

---

## Testing

**Design reference:** `design.md §11`

### Test Files to Update/Create

**DSL & Query:**
- `graph-editor/src/lib/__tests__/queryDSL.test.ts` — add `cohort()` parsing tests
- `graph-editor/src/lib/__tests__/dslConstruction.test.ts` — add `cohort()` construction tests
- `graph-editor/src/lib/__tests__/dslExplosion.test.ts` — latency edge explosion scenarios

**Data Services:**
- `graph-editor/src/services/__tests__/dataOperationsService.test.ts` — cohort mode ingestion
- `graph-editor/src/services/__tests__/windowAggregationService.test.ts` — cohort-aware aggregation
- `graph-editor/src/services/__tests__/statisticalEnhancementService.test.ts` — Formula A forecasting (new)

**Python:**
- `graph-editor/tests/test_msmdc.py` — anchor_node_id computation, A=X case, multi-start graphs

**Key test scenarios (from design §11.2):**
- Fully mature cohort (all ages ≥ maturity_days)
- Fully immature cohort (all ages < maturity_days)
- Mixed maturity cohort
- Edge from start node (A=X case)
- Multi-step funnel (A→X→Y)
- Sibling probability sum > 1 (forecasting artefact warning)

### Extended Test Coverage

#### Property-Based Tests (use `fast-check`)

**File:** `graph-editor/src/services/__tests__/windowAggregationService.property.test.ts` (NEW)

| Property | Assertion |
|----------|-----------|
| Completeness bounds | For any cohort array: `0 ≤ completeness ≤ 1` |
| Completeness monotonicity | Adding older cohorts never decreases completeness |
| Mature-only completeness | If all cohorts have `age ≥ median_days`, completeness = 1.0 |
| Empty cohort handling | Empty array → completeness = 0 (or defined fallback), no crash |
| Weight sum positivity | Recency weights: `Σw_i > 0` for any non-empty cohort array |

**File:** `graph-editor/src/services/__tests__/statisticalEnhancementService.property.test.ts` (NEW)

| Property | Assertion |
|----------|-----------|
| Forecast bounds | `0 ≤ p.mean ≤ 1` for any valid inputs |
| Forecast ≥ evidence | `p.mean ≥ p.evidence` (forecasting can only add, not subtract) |
| Mature cohort identity | If `age ≥ maturity_days`, forecast_k = observed_k exactly |
| Zero n handling | `n = 0` → graceful fallback, no division by zero |
| NaN propagation | No NaN/Infinity in outputs for finite inputs |

#### Non-Latency Regression Suite

**File:** `graph-editor/src/services/__tests__/nonLatencyRegression.test.ts` (NEW)

**Purpose:** Freeze existing `window()` behaviour for edges with `maturity_days = 0` or undefined.

| Test | Description |
|------|-------------|
| Standard window aggregation | Verify existing n/k aggregation unchanged |
| Context expansion | `contextAny(channel)` still works as before |
| Date parsing | Relative and absolute dates behave identically to pre-LAG |
| Put-to-file | Non-latency edge put-to-file unchanged |

#### Python anchor_node_id Pathological Graph Tests

**File:** `graph-editor/tests/test_msmdc.py` — expanded suite

| Test Case | Graph Structure | Expected Behaviour |
|-----------|-----------------|-------------------|
| Simple chain | `START → A → B → C` | anchor_node_id for B→C = START |
| Diamond | `START → A, START → B, A → C, B → C` | anchor_node_id for any edge = START |
| Multiple STARTs | `START1 → A → C, START2 → B → C` | anchor_node_id = furthest upstream START (deterministic tiebreak) |
| Edge from START | `START → A` (A=X case) | anchor_node_id = START (edge.from) |
| Orphan edge | Edge with no path to any START | Error or explicit "no anchor" marker |
| Self-loop | `A → A` | Error or skip |
| Long chain (10+ nodes) | `START → N1 → ... → N10` | Correct traversal, no stack overflow |

#### Visual Regression Tests (Storybook + Chromatic)

**File:** `graph-editor/src/components/edges/ConversionEdge.stories.tsx` (NEW or expand)

| Story | Description |
|-------|-------------|
| Evidence only | Solid line, no stripe |
| Forecast only | Striped line only |
| Evidence + Forecast | Two-layer rendering with correct widths |
| Zero evidence | Stripe only, inner layer invisible |
| 100% completeness | Full solid, minimal/no stripe |
| Latency bead visible | "6d (80%)" bead positioned correctly |
| Latency bead hidden | `maturity_days = 0` → no bead |

**File:** `graph-editor/src/components/panels/ScenariosPanel.stories.tsx`

| Story | Description |
|-------|-------------|
| Visibility cycle F+E | Gradient chip appearance |
| Visibility cycle F | Striped chip appearance |
| Visibility cycle E | Solid chip appearance |
| Visibility cycle hidden | Semi-transparent chip |
| Forecast unavailable | F and F+E states disabled |

#### Partial Fetch Failure Tests

**File:** `graph-editor/src/services/__tests__/dataOperationsService.test.ts` — expand

| Test | Scenario | Expected |
|------|----------|----------|
| Cohort fetch fails, window succeeds | Network error on cohort request | Window data stored, cohort missing, warning shown |
| Window fetch fails, cohort succeeds | Network error on window request | Cohort data stored, window missing, UI shows cohort-only |
| Both fail | Network errors | Error state, no partial data written |
| Timeout mid-fetch | Slow response | Graceful timeout handling |

#### Edge Case Numeric Tests

**File:** `graph-editor/src/services/__tests__/windowAggregationService.test.ts` — expand

| Test | Input | Expected |
|------|-------|----------|
| Zero-day cohort | `age = 0`, `n > 0` | `progress = 0`, no division by zero |
| Median = 0 | `median_lag_days = 0` | Completeness = 1.0 (or error), not `Infinity` |
| Single cohort | Array of length 1 | Valid completeness, not edge-case crash |
| Large n values | `n = 10^9` | No overflow in sums |
| Floating point edge | `k/n = 0.333...` | Consistent rounding |

---

## Migration & Cleanup

**Design reference:** `design.md §9.4` (Migration Considerations)

- **Note:** `cost_time` → `labour_cost` rename completed in Phase P0.
- Update existing tests to match new function signatures introduced in C1–C4.
- Add new tests for cohort logic (see `design.md` Section 11).

---

## Design Assets Reference

The following detailed design assets in `design.md` should be consulted during implementation:

| Asset | Location | Purpose |
|-------|----------|---------|
| `LatencyConfig` interface | §3.1 | Full TypeScript interface definition |
| `EdgeLatencyDisplay` interface | §7.2 | Rendering data model |
| `EdgeParamDiff` additions | §9.K | Scenario override fields |
| Parameter file example | §3.2 | Complete YAML structure with all fields |
| Canonical sliceDSL format | §4.7.1 | Slice labelling rules |
| Dual-slice YAML example | §4.6 | Cohort + window slice storage |
| Phase 0 Formula A | §5.0.2 | Forecasting step-function |
| Edge layer diagram | §7.1 | Two-layer stripe rendering |
| Visibility state table | §7.3 | 4-state cycle icons and visuals |
| Properties panel layout | §7.7 | UI placement sketch |
| Impact Analysis tables | §9.2 A-K | Per-file change requirements |
| Test case tables | §11.1 A-H | Specific test inputs/outputs |
| Integration scenarios | §11.2 | End-to-end test flows |

## Open Questions (from design.md §12)

### Phase 0 — Monitor During Implementation
- **Amplitude rate limits:** Will per-cohort queries hit limits for 90-day windows? Test and add batching if needed.
- **Retention endpoint:** May be more efficient than funnel API. Evaluate if rate limits become an issue.

### Deferred to Phase 1+ (Bayesian)
- **Stationarity:** Time-varying latency, weekday vs weekend patterns, non-stationarity alerts.
- **Multi-modal distributions:** Fast/slow populations — requires Bayesian mixture models.

### Explicitly Out of Scope for Phase 0

| Feature | Status | Implication |
|---------|--------|-------------|
| **Convolution fallback** | Deferred to Phase 1+ (design §C.3) | If user requests `window()` on a latency edge but only `cohort_data` exists, **return error** — do NOT attempt model-based convolution. |
| **Time-indexed runner** | Deferred to Phase 1+ (design §6) | Runner uses `p.mean` as scalar; latency is display-only, not used in forward-pass. |
| **Bayesian distribution fitting** | Deferred to Phase 1+ (design §5.1–5.3) | Phase 0 uses step-function maturity, not continuous lag CDF. |
| **Recency-weighted p.forecast** | Phase 1 fast-follow (design §C.1) | Phase 0 uses simple unweighted average of mature cohorts from window() slice. |
| **p.forecast from cohort data** | Deferred to Phase 1+ | Phase 0 requires window() slice for p.forecast; cohort-only edges show p.forecast as unavailable. |

**Phase 0 window() behaviour on latency edges:**
- If `window_data` slice exists in param file → use it directly.
- If only `cohort_data` exists → **error: "Window data not available. Fetch with window() or switch to cohort mode."**
- No silent fallback to convolution.

### Resolved by Phase 0 Design
| Question | Resolution |
|----------|------------|
| Caching strategy | Derived stats cached in parameter files (§3.2) |
| Heavy tails | Controlled by `maturity_days` setting — user sets threshold |
| Conditional edges (§12.4) | Same treatment as `p` — latency at edge level |
| Cost params (§12.5) | No latency treatment — manual entry only |
| Zero-lag edges | `maturity_days = 0` disables latency tracking |

## Appendix References

For implementation details:
- **Amplitude response fields:** `design.md Appendix B`
- **Histogram limitations:** `design.md Appendix A.1`
- **Phase 1+ formulas:** `design.md Appendix C` (not required for Phase 0)
