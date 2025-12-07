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
- Add a `LatencyConfig` interface with fields:
  - `maturity_days?: number` and `maturity_days_overridden?: boolean` (>0 enables tracking).
  - `anchor_node_id?: string` and `anchor_node_id_overridden?: boolean` (default anchor, inferred when not explicit in DSL).
  - Recency config (`recency_half_life_days`) is deferred to a fast-follow (Appendix C.1).
- **anchor_node_id computation:** When DSL lacks explicit `cohort(anchor, dates)`, compute the default anchor as the furthest upstream START node from `edge.from` during query construction in `buildDslFromEdge.ts` (or its caller), NOT via a separate service hook.
- Attach `latency?: LatencyConfig` to `GraphEdge`.
- Add an `EdgeLatencyDisplay` interface for rendering latency (probabilities, completeness) as per design §7.2.

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
- Add extraction for new LAG fields on `ProbabilityParam`:
  - `forecast_mean`, `forecast_stdev`
  - `evidence_mean`, `evidence_stdev`
  - `latency` block (`maturity_days`, `anchor_node_id`, `t95`, `completeness`, `median_lag_days` as needed for display)
- **Critical for scenarios:** `extractEdgeParams()` and `extractDiffParams()` must include these fields so live scenario regeneration captures the full latency view per scenario DSL (see design §9.K.2)

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
  - Add `median_lag_days`, `mean_lag_days` arrays — **CONSUMED** by lag fitting (§5.4).
  - Add `anchor_n_daily`, `anchor_median_lag_days`, `anchor_mean_lag_days` arrays — **STORED BUT NOT CONSUMED** (for future convolution, Appendix C.2).
  - Add `latency` summary block (median_days, completeness, histogram) — histogram is **STORED BUT NOT CONSUMED** (for future short-horizon discrete CDF, Appendix C.3).
  - Add `anchor_latency` summary block — **STORED BUT NOT CONSUMED** (for future convolution, Appendix C.2).
  - Update `sliceDSL` description to emphasize canonical format.
- **Rationale for storing unused fields:** Amplitude data is expensive to re-fetch; storing now avoids historical backfill when deferred features are implemented.
- **Date format standardisation** (`design.md §3.4`):
  - Change `window_from`/`window_to` from ISO `date-time` to `d-MMM-yy` pattern.
  - Add `cohort_from`/`cohort_to` with same pattern.
  - Exception: `data_source.retrieved_at` and `metadata.*` remain ISO `date-time`.

### 1.4 Update Manager Mappings
**Design reference:** `design.md §9.H` (UpdateManager), `§9.K` (Config/Data field mappings)

**File:** `graph-editor/src/services/UpdateManager.ts`

**Latency CONFIG fields (probability ↔ param file, bidirectional):**
| Graph/Prob field | File field | Override flag |
|------------------|------------|---------------|
| `edge.p.latency.maturity_days` | `latency.maturity_days` | `maturity_days_overridden` |
| `edge.p.latency.anchor_node_id` | `latency.anchor_node_id` | `anchor_node_id_overridden` |

**Note:** `recency_half_life_days` deferred to fast-follow (design Appendix C.1).

**Latency DATA fields (file → probability only):**
| File field | Graph/Prob field | Notes |
|------------|------------------|-------|
| `values[latest].latency.median_days` | `edge.p.latency.median_lag_days` | Display only |
| `values[latest].latency.completeness` | `edge.p.latency.completeness` | Display only |
| `values[latest].latency.t95` | `edge.p.latency.t95` | Persisted scalar for caching / A→X maturity |
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

**File:** `graph-editor/public/schemas/query-dsl-1.1.0.json`
- Confirm DSL JSON schema supports:
  - `cohort(start:end)` (no anchor)
  - `cohort(anchor_node_id,start:end)` (explicit anchor)
- Keep `QueryFunctionName.enum` and the raw-pattern examples in sync with `queryDSL.ts` and tests.

### 2.2 DSL Construction
**Design reference:** `design.md §9.A` (DSL Construction table), `§4.6` (Dual-Slice Retrieval)

**File:** `graph-editor/src/lib/dslConstruction.ts`
- Add `cohort()` clause construction.
- Distinguish `cohort()` from `window()` based on probability latency configuration (`p.latency`).
- Handle anchor node inclusion in DSL when `anchor_node_id` differs from edge.from.

**File:** `graph-editor/src/lib/dslExplosion.ts`
- Update explosion logic to handle `cohort()` clauses.
- Generate atomic slices for `cohort()` × context combinations.
- Handle `or(cohort(...), window(...))` producing separate cohort and window slices.

**File:** `graph-editor/src/components/QueryExpressionEditor.tsx`
- Extend Monaco completion so that after `cohort(` the user can:
  - Type dates directly, as today (e.g. `cohort(-30d:)`), **or**
  - Select an anchor node id, then a date range (e.g. `cohort(household-created,-30d:)`).
- Reuse the same node-id suggestion set as for `from(`/`to(` autocomplete.

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
- Update `getFromSource` / `getFromSourceDirect` to follow the **existing incremental-fetch + cache pattern** for latency edges:
  - **Do not** add ad‑hoc "missing data" checks in aggregation code. Instead, reuse `calculateIncrementalFetch()` and `getItemsNeedingFetch()`:
    - At fetch‑planning time, call `getItemsNeedingFetch(window, graph, currentDSL)` (from `fetchDataService`) to obtain a `FetchItem[]` for parameters/cases (including latency parameters) that have `needsFetch === true` for the current window + sliceDSL.
    - Under the hood, this already calls `windowAggregationService.calculateIncrementalFetch(paramData, window, signature, bustCache, slice)` to compute **date‑level gaps** and only request missing days from Amplitude.
  - For latency edges, treat window()/cohort() slices exactly like any other parameter:
    - `getFromSourceDirect` issues Amplitude calls for only the missing days, writes new data (or explicit `no_data` markers) into the parameter file, and then calls `getParameterFromFile` to refresh the graph view.
    - The distinction between "not yet fetched" vs "no data from source" remains:
      - "Not yet fetched": covered by incremental fetch and cache.
      - "No data from source" (Amplitide returns empty for requested slice): surface a toast/error and, where appropriate, store a `no_data` marker so future coverage checks do not re‑fetch.
  - Handle cohort-mode responses:
    - Extract latency stats (medians, histograms) from Amplitude response (day funnels + median/mean lag arrays).
    - Call `windowAggregationService` / `statisticalEnhancementService` to compute mature/immature split and Formula A outputs.
    - Store extended data to parameter file via `paramRegistryService` following the existing "file as cache" pattern.

### 3.2 Window Aggregation Service
**Design reference:** `design.md §5.5` (Completeness), `§5.6` (Asymptotic Probability), `§9.D` (windowAggregationService)

**File:** `graph-editor/src/services/windowAggregationService.ts`
- Update `aggregateWindow` to handle cohort data structures.
- Implement CDF-based `completeness` calculation: `Σ(n_i × F(a_i)) / Σn_i`.
- Implement `p_infinity` estimation from mature cohorts.

### 3.3 Lag Distribution Fitting & Forecasting
**Design reference:** `design.md §5.3` (Formula A), `§5.4` (Lag Distribution Fitting), `§4.8` (Query-time computation)

**File:** `graph-editor/src/services/statisticalEnhancementService.ts`
- Implement log-normal CDF fitting and Formula A exactly as specified in the design:
  - Use `median_lag_days` and `mean_lag_days` to fit the lag CDF (design §5.4).
  - Apply Formula A to derive `p.mean` and completeness from cohorts (design §5.3–§5.6).
- Ensure numeric guards and edge cases (e.g., degenerate denominators, missing data) are covered in tests rather than re-specifying formulas here.

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

### 3.6 Query-Context Latency Computation
**Design reference:** `design.md §3.1` (LatencyConfig computed fields), `§5.8` (Storage Architecture)

**File:** `graph-editor/src/services/statisticalEnhancementService.ts`

**Tasks:**
- Implement `computeEdgeLatencyStats(edge, paramData, queryWindow)`:
  - Filter and aggregate `median_lag_days[]`, `mean_lag_days[]`, `k_daily[]` for query window
  - Compute: `mu`, `sigma`, `t95`, `empirical_quality_ok`
  - Quality gate: `k >= LATENCY_MIN_FIT_CONVERTERS` AND `mean/median` in [`LATENCY_MIN_MEAN_MEDIAN_RATIO`, `LATENCY_MAX_MEAN_MEDIAN_RATIO`]
  - Fallback: if quality fails, use `maturity_days` for `t95`
- Attach computed values to `p.latency` on the `ProbabilityParam`:
  - Persist `t95` for this edge/probability (used for A→X maturity and caching).
  - Keep `mu`, `sigma`, `empirical_quality_ok` transient (service-level only).

**File:** `graph-editor/src/constants/latency.ts` (NEW)
- Define shared latency constants used by services and tests:
  - `export const LATENCY_MIN_FIT_CONVERTERS = 30;`
  - `export const LATENCY_MIN_MEAN_MEDIAN_RATIO = 1.0;`
  - `export const LATENCY_MAX_MEAN_MEDIAN_RATIO = 3.0;`
- Import these from `statisticalEnhancementService.ts` (and any other consumers) instead of hard-coding numeric thresholds.
 - Additionally define baseline window clamps for the implicit window() history used when no explicit window slice exists:
   - `export const LATENCY_BASELINE_MIN_WINDOW_DAYS = 30;`  // lower clamp for implicit baseline window
   - `export const LATENCY_BASELINE_MAX_WINDOW_DAYS = 60;`  // upper clamp for implicit baseline window
 - These are referenced in both `statisticalEnhancementService.ts` and `dataOperationsService.ts` when constructing the default baseline window described in `design.md §5.2.1`.

**Direct-from-source path (no param files available):**
- When `dataOperationsService` determines that required slices are missing or stale:
  - Construct **both** a cohort DSL and a window DSL for the current interactive query.
  - Call Amplitude directly via the adapter to obtain:
    - window(): edge-local dayFunnels + lag stats over a historical horizon.
    - cohort(): A-anchored dayFunnels for the query window.
  - Pass these raw results into `statisticalEnhancementService`:
    - Derive `mu`, `sigma`, `t95`, `p_infinity` from window() data.
    - Derive `p_mean`, `completeness` from cohort() exposures using Formula A.
  - Optionally:
    - Persist the raw slices into param files for future reuse.
 - For latency edges where the interactive DSL is **cohort-only** (no explicit `window()`), the "window DSL for the current interactive query" should be constructed as an **implicit baseline window**:
   - Compute `W_base` by clamping `maturity_days` between `LATENCY_BASELINE_MIN_WINDOW_DAYS` and `LATENCY_BASELINE_MAX_WINDOW_DAYS` (see `design.md §5.2.1`).
   - Build an internal `window(T_query - W_base : T_query)` clause with the same context filters as the current DSL.
   - Use this implicit baseline window exactly as if the user had specified it explicitly in the DSL; do not surface it in the UI, but do log it via `sessionLogService` for provenance.

### 3.7 Total Maturity Calculation (Path DP)
**Design reference:** `design.md §4.7.2`

**File:** `graph-editor/src/services/statisticalEnhancementService.ts`

**Tasks:**
- Implement `getActiveEdges(graph, whatIfDSL)`:
  - Use `computeEffectiveEdgeProbability(graph, edgeId, { whatIfDSL })` from `lib/whatIf.ts`
  - Edge is active iff effective probability > 1e-9 (epsilon threshold)
- Implement `computePathT95(graph, anchor_id, activeEdges)`:
  - `activeEdges` from above — edges ACTIVE under current scenario (cases + `conditional_ps`)
  - Run **after** all active latency edges have `t95` computed (i.e., after batch fetch completes)
  - Topological DP over the **scenario‑effective graph**: for each active edge, `path_t95 = max(upstream path_t95) + t95`
  - Store result on `p.latency.path_t95` for active edges (transient, for this query)
- **O(E_active)** — runs once per query, not per render
- Used for cache/refresh policy decisions that depend on A→X total maturity
- **Transient (not persisted)** — scenario-specific, depends on active edges

**When `path_t95` is computed:**
- After batch fetch (all active edges have fresh `t95`)
- Per-query: `activeEdges` depends on the query's `whatIfDSL`; the DP runs as part of query evaluation
- NOT stored globally — it's query/scenario-specific

### 3.8 Topological Sorting of Batch Fetches
**Design reference:** `design.md §4.7.2` (fetch ordering requirement), `§5.7`, `§5.9.1` (Flow A)

**File:** `graph-editor/src/services/fetchDataService.ts`

**Tasks:**
- Update `getItemsNeedingFetch()` to return items in **topological order** (edges near START nodes first)
- Implementation: compute topological order of edges before returning `FetchItem[]`
- **Rationale:** 
  - Upstream `t95` baselines established from window() slices before downstream edges need them
  - Enables `computePathT95()` to run correctly after batch
- Standard DAG topological sort; edges are already in a DAG

### 3.9 Get-from-Source Flow Mapping
**Design reference:** `design.md §5.9` (Flows A and B)

This section ties the conceptual flows to concrete services and files.

**Flow A – Versioned get-from-source (pinned DSL → param files → forecast):**
- `graph-editor/src/services/UpdateManager.ts` / `GraphMutationService`:
  - Maintain the **pinned DSL** for each graph (used to drive overnight / batch fetch).
  - Do not encode the current interactive query DSL.
- `graph-editor/src/services/dataOperationsService.ts`:
  - Expand the pinned DSL into canonical `sliceDSL` values for each edge/context.
  - Decide which slices to fetch (cohort, window, or both) for latency edges.
- `lib/das/amplitude_to_param.py`:
  - Execute Amplitude window()/cohort() calls for the planned sliceDSLs.
  - Write versioned param JSON with per-day/per-cohort arrays and metadata.
- `graph-editor/src/services/paramRegistryService.ts`:
  - Load param slices by canonical `sliceDSL` for use at query time.
- `graph-editor/src/services/statisticalEnhancementService.ts`:
  - From window() slices: fit lag distribution, compute `t95`, `p_infinity` as per design.
  - From cohort() slices: compute `p_mean`, completeness via Formula A.
  - Populate `p.latency.t95` and edge probabilities on the graph for the pinned DSL.

**Flow B – Direct get-from-source (interactive DSL → Amplitude → graph only):**
- `graph-editor/src/services/dataOperationsService.ts`:
  - Build the **current interactive query DSL** (cohort + window variants) for the active graph.
  - Detect missing or stale param slices and choose the direct-from-source path.
- Amplitude adapter (TS or Python, depending on integration boundary):
  - Issue window() and/or cohort() calls for the interactive DSL only.
- `graph-editor/src/services/statisticalEnhancementService.ts`:
  - Perform the same statistical steps as in Flow A, but from fresh Amplitude responses.
  - Populate `p.latency.t95`, `p.mean`, completeness, and related scalars on the graph.
  - Optionally trigger writing raw slices into param files (via param registry / Python adapter) when the caller explicitly chooses to version results.

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
| Track Latency | Checkbox | `maturity_days_overridden` | When unchecked: `maturity_days = 0`. When checked: shows Maturity field |
| Maturity | Number input | `maturity_days_overridden` | Days threshold for cohort maturity |

**Note:** Recency slider deferred to fast-follow (design Appendix C.1).

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
**Design reference:** `design.md §5.10`

**Files:**
- `graph-editor/src/services/integrityCheckService.ts`
- `graph-editor/src/services/graphIssuesService.ts`

**Tasks:**
- For each node with multiple outgoing edges where both have `maturity_days > 0`, compute `Σ p.mean` and `Σ p.evidence`.
- Issue classification:
  - `Σ p.evidence > 1.0`: Error (data inconsistency).
  - `Σ p.mean > 1.0` AND `Σ p.evidence ≤ 1.0`: Info-level (forecasting artefact, expected for immature data).
- Use threshold formula from `design.md §5.10` to determine when to surface info message.
- Wire warnings into existing `graphIssuesService` patterns.

### 4.9 View Menu: Global Recency Slider (DEFERRED — Fast-Follow)
**Design reference:** `design.md Appendix C.1.2` (Recency Bias UI)

> **Status:** Deferred to fast-follow. Implement after core latency features are complete.

**File:** `graph-editor/src/components/ViewMenu.tsx` (or equivalent)

**Tasks:**
- Add `recency_half_life_days` to `LatencyConfig` (see Appendix C.1)
- Add inline discrete slider for global `recency_half_life_days` default.
- Notches: 7, 14, 30, 60, 90, 180, Off (left = most bias, right = least bias).
- Default: 30d.
- Store in workspace settings.
- Takes effect on next fetch (not retroactive).
- Add per-edge override slider to `ParameterSection.tsx`.

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
- `graph-editor/src/services/__tests__/forecastService.test.ts` — log-normal CDF, Formula A (§5.3-5.4)
 - `graph-editor/src/services/__tests__/latencyBaseline.e2e.test.ts` (NEW) — implicit baseline window behaviour for cohort-only DSL, both with and without param files; verifies that `W_base` is honoured, only missing dates are fetched, and `p.forecast` / `t95` are populated or correctly marked unavailable when Amplitude returns no data.

**Python:**
- `graph-editor/tests/test_msmdc.py` — anchor_node_id computation, A=X case, multi-start graphs
- `graph-editor/tests/test_lag_math_parity.py` (or extend existing tests) — cross-language parity for log-normal CDF fitting and Formula A, using shared synthetic cohorts and golden fixtures to ensure TS and Python implementations agree within tolerance.

**Key test scenarios (from design §11.2):**
- Fully mature cohort (F(a_i) ≈ 1 for all cohorts)
- Fully immature cohort (F(a_i) ≈ 0 for all cohorts)  
- Mixed maturity cohort (various ages spanning the CDF)
- Edge from start node (A=X case)
- Multi-step funnel (A→X→Y)
- Sibling probability sum > 1 (forecasting artefact warning)
- Log-normal fitting edge cases (mean ≈ median, missing mean)

### Extended Test Coverage

#### Property-Based Tests (use `fast-check`)

**File:** `graph-editor/src/services/__tests__/forecastService.property.test.ts` (NEW)

| Property | Assertion |
|----------|-----------|
| CDF bounds | For any `t ≥ 0`: `0 ≤ F(t) ≤ 1` |
| CDF monotonicity | `F(t1) ≤ F(t2)` for `t1 ≤ t2` |
| Completeness bounds | For any cohort array: `0 ≤ completeness ≤ 1` |
| Completeness monotonicity | Adding older cohorts never decreases completeness |
| Forecast bounds | `0 ≤ p.mean ≤ 1` for any valid inputs |
| Forecast ≥ evidence | `p.mean ≥ p.evidence` (forecasting can only add, not subtract) |
| Denominator safety | `1 - p_∞ × F(a_i) > ε` for all cohorts (no division blow-up) |
| Zero n handling | `n = 0` → graceful fallback, no division by zero |
| NaN propagation | No NaN/Infinity in outputs for finite inputs |
| σ derivation | `σ = sqrt(2 × ln(mean/median))` is real and positive when mean > median |

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

#### Session Logging & Observability Tests

**Files:** `graph-editor/src/services/__tests__/dataOperationsService.test.ts`, `graph-editor/src/services/__tests__/fetchDataService.test.ts`, `graph-editor/src/services/__tests__/sessionLogService.integration.test.ts` (NEW)

| Test | Scenario | Expected |
|------|----------|----------|
| Latency fetch logging | Get-from-source on latency edge (with and without files) | `sessionLogService` records a `DATA_GET_FROM_SOURCE` / `BATCH_FETCH` operation with child entries for slice planning, cache hits, API calls, and UpdateManager application. |
| Implicit baseline logging | Cohort-only DSL triggers implicit baseline window | Log contains a child entry describing `W_base`, baseline window dates, edge id, and effective DSL used for the baseline window fetch. |
| Path maturity logging | After batch fetch with active latency edges | A single operation logs the computation of `p.latency.t95` and `path_t95` (once per query/scenario), enabling cache decisions to be traced from logs. |

### Integration Flows (End-to-End)

To manage the implied complexity of Project LAG, we need **integration tests that traverse the full data path** — from DSL → fetch planning → external calls → param files / cache → UpdateManager → graph → renderer — for both versioned (Flow A) and direct (Flow B) flows.

#### Core Integration Suites

| Flow | Files | Coverage |
|------|-------|----------|
| Flow A: Versioned get-from-source (pinned DSL → param files → graph) | `graph-editor/src/services/__tests__/versionedFetch.integration.test.ts`, `graph-editor/src/services/__tests__/versionedFetchFlow.e2e.test.ts` | Start from a pinned DSL that includes `cohort()` / `window()` for latency edges; call `batchGetFromSource` and verify: correct slice planning, Amplitude adapter calls, param file writes (including latency fields), `windowAggregationService` aggregation, `statisticalEnhancementService` updates to `p.latency.t95`, `p.mean`, completeness on graph edges. |
| Flow B: Direct get-from-source (interactive DSL → Amplitude → graph only) | `graph-editor/src/services/__tests__/dataOperationsService.integration.test.ts` | Starting from a graph-only state (no param files), issue `getFromSource` with cohort-only and window-only DSL; assert that `getFromSourceDirect` issues the right Amplitude calls (including implicit baseline window for cohort-only), passes results to `statisticalEnhancementService`, and updates graph edges without requiring files. |
| Dual-slice latency flow (window + cohort for one edge) | `graph-editor/src/services/__tests__/dataOperationsService.integration.test.ts`, `graph-editor/src/services/__tests__/latencyBaseline.e2e.test.ts` | For a single latency edge with both window() and cohort() slices, verify: both slices are fetched and stored; window() drives `p.forecast` and `t95`; cohort() drives evidence and Formula A; the combined `p.mean` and completeness are written to graph and rendered correctly. |
| Multi-edge path maturity & caching | `graph-editor/src/services/__tests__/versionedFetch.integration.test.ts`, `graph-editor/src/services/__tests__/forecastService.test.ts` (integration-style subset) | Build a small graph A→X→Y with latency on both edges; run a batch fetch and then verify: per-edge `p.latency.t95` values, `computePathT95` results, and that subsequent `getItemsNeedingFetch` calls honour A→X maturity (no re-fetch of mature windows, only immature/gap days). |
| Non-latency regression | `graph-editor/src/services/__tests__/nonLatencyRegression.test.ts` | Run the existing versioned fetch flows on graphs with `maturity_days = 0` to assert that non-latency edges’ behaviour (window aggregation, contexts, put-to-file) is unchanged by LAG. |

#### UI-Driven End-to-End Scenarios

These tests should drive the system via **UI components** to ensure wiring between hooks, services, and rendering is sound.

| Scenario | Files | Coverage |
|----------|-------|----------|
| WindowSelector fetch & aggregate | `graph-editor/src/components/__tests__/WindowSelector.autoAggregation.test.tsx`, `fetchButtonE2E.integration.test.tsx` | User adjusts window/context; `WindowSelector` computes coverage, sets `needsFetch`, triggers `fetchItems`, and automatically aggregates from file-only where possible. Latency edges must follow the same pattern, including implicit baseline windows where needed. |
| Latency edge render & tooltip | `graph-editor/src/components/edges/__tests__/ConversionEdge.latency.integration.test.tsx` (NEW) | Starting from a graph with populated latency stats, render `GraphCanvas` and verify: two-layer edge rendering per scenario visibility state, latency bead values, and tooltips showing correct evidence/forecast/blended values with slice provenance. |
| Scenario-specific latency views | `graph-editor/src/components/panels/__tests__/ScenariosPanel.integration.test.tsx` | For multiple scenarios with different `meta.queryDSL` and param packs, ensure `CompositionService` / `ScenariosContext` and renderer combine to show correct per-scenario latency (p.evidence, p.forecast, p.mean) without re-running the inference engine at render time. |

#### Edge Case Numeric Tests

**File:** `graph-editor/src/services/__tests__/forecastService.test.ts` — expand

| Test | Input | Expected |
|------|-------|----------|
| Zero-day cohort | `age = 0`, `n > 0` | `F(0) ≈ 0`, forecast uses full tail |
| Median = 0 | `median_lag_days = 0` | Error or fallback (ln(0) undefined) |
| Mean = median | `mean_lag_days = median_lag_days` | `σ = 0` → degenerate CDF (step at median) |
| Mean < median | Invalid ratio | Error or fallback (sqrt of negative) |
| Single cohort | Array of length 1 | Valid completeness, not edge-case crash |
| Large n values | `n = 10^9` | No overflow in sums |
| p_∞ near 1, old cohort | `p_∞ = 0.99`, `F(a_i) = 0.99` | Denominator `1 - 0.9801` is small but handled |
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
| **Formula A (Bayesian)** | §5.3 | Per-cohort tail forecasting formula |
| **Log-normal CDF fitting** | §5.4 | Lag distribution from median/mean |
| **Completeness formula** | §5.5 | CDF-based maturity measure |
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

### Deferred (Advanced)
- **Stationarity:** Time-varying latency, weekday vs weekend patterns, non-stationarity alerts.
- **Multi-modal distributions:** Fast/slow populations — requires Bayesian mixture models.
- **Hierarchical pooling:** Shared hyperpriors across context slices (Appendix C.3).

### Explicitly Out of Scope (Deferred)

| Feature | Status | Implication |
|---------|--------|-------------|
| **Convolution fallback** | Deferred (design Appendix C.2) | If user requests `window()` on a latency edge but only `cohort_data` exists, **return error** — do NOT attempt model-based convolution. |
| **Time-indexed runner** | Deferred (design §6, Appendix C.4) | Runner uses `p.mean` as scalar; latency is display-only, not used in forward-pass. |
| **Bayesian hierarchical model** | Deferred (design Appendix C.3) | Use point estimates; full posterior with credible intervals is future work. |
| **Competing risks model** | Deferred (design Appendix C.5) | Sibling edges forecast independently; warn if `Σ p.mean > 1`. |
| **Recency-weighted p_∞** | Fast-follow (design §5.6, Appendix C.1) | Initial implementation uses simple unweighted average of mature cohorts. |
| **p.forecast from cohort data** | Deferred | Requires convolution fallback; cohort-only edges show p.forecast as unavailable. |

**window() behaviour on latency edges:**
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
- **Advanced forecasting:** `design.md Appendix C` (recency weighting, convolution fallback, hierarchical model)
