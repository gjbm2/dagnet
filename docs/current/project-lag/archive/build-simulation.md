# Project LAG: Build Simulation

This document simulates the implementation process for Project LAG (Latency-Aware Graph Analytics), analyzing each required file change in the context of the existing codebase. It identifies specific code modifications and surfacing design questions.

## Phase C1: Schema Changes & Core Types

### 1.1 TypeScript Type Definitions

**File:** `graph-editor/src/types/index.ts`

**Context:** Defines the core TypeScript interfaces for the application, including `GraphEdge`, `ProbabilityParam`, and `CostParam`.

**Changes Required:**
1.  **Rename `cost_time` to `labour_cost`:**
    *   In `GraphEdge` interface: `cost_time?: CostParam` -> `labour_cost?: CostParam`.
    *   In `ParameterDefinition` schema types (if present).
    *   Update any comments referencing `cost_time`.
2.  **Add `LatencyConfig` interface:**
    ```typescript
    export interface LatencyConfig {
      legacy maturity field?: number;
      legacy maturity override?: boolean;
      censor_days?: number;
      censor_days_overridden?: boolean;
      anchor_node_id?: string;
      anchor_node_id_overridden?: boolean;
      recency_half_life_days?: number;
      distribution?: {
        family: 'lognormal' | 'weibull' | 'gamma' | 'discrete';
        params: {
          mu?: number;
          sigma?: number;
          alpha?: number;
          beta?: number;
          hazards?: number[];
        };
        credible_interval?: [number, number];
      };
      median_days?: number;
      median_days_overridden?: boolean;
    }
    ```
3.  **Add `latency` to `GraphEdge`:**
    *   `latency?: LatencyConfig;`
4.  **Add `EdgeLatencyDisplay` interface** (for UI rendering):
    ```typescript
    export interface EdgeLatencyDisplay {
      p: {
        evidence: number;
        forecast: number;
        mean: number;
      };
      completeness: number;
      median_lag_days?: number;
      evidence_source?: string;
      forecast_source?: string;
    }
    ```

**Design Questions:**
*   Should `EdgeLatencyDisplay` be part of `GraphEdge` or a separate UI-only type? *Decision: UI-only type, likely extended in `ConversionEdgeData` in `ConversionEdge.tsx`.*

**File:** `graph-editor/src/types/scenarios.ts`

**Context:** Defines `EdgeParamDiff` used for scenario overrides.

**Changes Required:**
1.  **Add forecast and evidence fields to `EdgeParamDiff`:**
    *   `forecast_mean?: number;`
    *   `forecast_mean_overridden?: boolean;`
    *   `evidence_mean?: number;`
    *   `completeness?: number;`
    *   `completeness_overridden?: boolean;`

### 1.2 Python Pydantic Models

**File:** `graph-editor/lib/graph_types.py`

**Context:** Pydantic models mirroring TS types for Python backend validation.

**Changes Required:**
1.  **Update `Edge` model:**
    *   Rename `cost_time` field to `labour_cost`.
    *   Add `latency: Optional[LatencyConfig] = None`.
2.  **Add `LatencyConfig` model:**
    *   Implement Pydantic model matching the TS interface.

### 1.3 Parameter File Schema

**File:** `graph-editor/public/param-schemas/parameter-schema.yaml`

**Context:** JSON Schema definition for parameter files.

**Changes Required:**
1.  **Rename `cost_time` -> `labour_cost`** in enum values.
2.  **Add top-level `latency` section.**
3.  **Update `values` item schema:**
    *   Add `cohort_from`, `cohort_to` (pattern `^\d{1,2}-[A-Z][a-z]{2}-\d{2}$`).
    *   Add arrays: `median_lag_days`, `mean_lag_days`, `anchor_n_daily`, `anchor_median_lag_days`.
    *   Add `latency` and `anchor_latency` summary blocks.
4.  **Date Format:** Update `window_from` and `window_to` format validation to accept UK date format.

### 1.4 Update Manager Mappings

**File:** `graph-editor/src/services/UpdateManager.ts`

**Context:** Handles syncing between Graph object and Parameter files.

**Changes Required:**
1.  **Add Mappings:**
    *   Map `edge.latency.*` fields to parameter file's top-level `latency` section.
    *   Map `labour_cost` fields.
    *   Map `anchor_node_id`.

### 1.5 MSMDC Extension

**File:** `graph-editor/lib/msmdc.py`

**Context:** Python query generation logic.

**Changes Required:**
1.  **Implement `anchor_node_id` computation:**
    *   Add function to traverse upstream from `edge.from` to find the furthest START node.
    *   Handle A=X case (edge starts at a start node).
    *   Integrate into `generate_query_for_edge` or exposed as separate utility.

## Phase C2: DSL & Query Architecture

### 2.1 DSL Parsing

**File:** `graph-editor/src/lib/queryDSL.ts`

**Context:** Single source of truth for DSL parsing.

**Changes Required:**
1.  **Add `cohort` to `QUERY_FUNCTIONS`.**
2.  **Update `ParsedConstraints` interface:**
    *   Add `cohort: { anchor?: string; start?: string; end?: string } | null;`.
3.  **Update `parseConstraints` function:**
    *   Implement regex matching for `cohort(start:end)` and `cohort(anchor,start:end)`.
    *   Handle date parsing for cohort bounds.
4.  **Update `normalizeConstraintString`:**
    *   Add serialization for `cohort` clause.

**File:** `graph-editor/src/lib/das/compositeQueryParser.ts`

**Context:** Handles `minus`/`plus` operators.

**Changes Required:**
1.  **Review:** Ensure `cohort` function passes through correctly (it should, as it relies on `queryDSL.ts`). No major changes expected if `queryDSL.ts` is updated correctly.

### 2.2 DSL Construction

**File:** `graph-editor/src/lib/dslConstruction.ts`

**Context:** Constructs DSL strings from graph selections.

**Changes Required:**
1.  **Update construction logic:** While this file primarily builds topological queries (from/to/visited), ensure it doesn't strip or mangle `cohort` if present in manual overrides or future UI builders.

**File:** `graph-editor/src/lib/dslExplosion.ts`

**Context:** Explodes compound queries into atomic slices.

**Changes Required:**
1.  **Verify `cohort` handling:** Ensure `cohort` clauses are preserved during explosion. Since `parseConstraints` is used, updating `queryDSL.ts` should be sufficient, but verify `explodeDSL` doesn't make assumptions about clause types.

### 2.3 Query Payload Construction

**File:** `graph-editor/src/lib/das/buildDslFromEdge.ts`

**Context:** Builds the JSON payload sent to DAS adapters.

**Changes Required:**
1.  **Update `QueryPayload` interface:**
    *   Add `cohort?: { anchor?: string; start: string; end: string; maturity?: number }`.
2.  **Update `buildDslFromEdge`:**
    *   Detect `latency.legacy maturity field > 0` on the edge.
    *   If true, and DSL contains `cohort()`, construct `cohort` payload.
    *   Resolve `anchor_node_id`: use edge's configured anchor or fallback to `edge.from`.
    *   Support dual-slice requests (if DSL implies both).

### 2.4 Amplitude Adapter

**File:** `graph-editor/src/lib/das/adapters/amplitudeHelpers.ts` (NEW)

**Context:** New helper file to centralize Amplitude logic.

**Changes Required:**
1.  **Create file:** Move complex logic from `connections.yaml` script to here.
2.  **Implement `buildCohortFunnel`:** Logic to build 3-step funnel `[Anchor -> From -> To]` for cohort mode.

**File:** `graph-editor/public/defaults/connections.yaml`

**Context:** Adapter configuration.

**Changes Required:**
1.  **Update `amplitude-prod` adapter:**
    *   Add `cs` (conversion seconds) parameter default (45 days).
    *   Update `pre_request` script to use `amplitudeHelpers` and handle `cohort` vs `window` mode logic.
    *   Update `response.extract` to include `dayMedianTransTimes`, `stepTransTimeDistribution`.

## Phase C3: Data Storage, Aggregation & Inference

### 3.1 Data Operations Service

**File:** `graph-editor/src/services/dataOperationsService.ts`

**Context:** Orchestrates data fetching and storage.

**Changes Required:**
1.  **Update `getFromSourceDirect`:**
    *   Extract `dayMedianTransTimes` from Amplitude response.
    *   Call `windowAggregationService.computeMatureImmatureSplit`.
    *   Pass latency stats to `paramRegistryService` for storage.

### 3.2 Window Aggregation Service

**File:** `graph-editor/src/services/windowAggregationService.ts`

**Context:** Aggregates time-series data.

**Changes Required:**
1.  **Implement `computeMatureImmatureSplit`:** Logic to separate cohorts based on age vs `legacy maturity field`.
2.  **Update `aggregateWindow`:** Handle cohort-based data structures (parallel arrays for latency).
3.  **Implement `completeness` calculation:** Weighted average of cohort progress.
4.  **Implement `computeTotalMaturity`:** Longest-path algorithm for cache policy.

### 3.3 Statistical Enhancement Service

**File:** `graph-editor/src/services/statisticalEnhancementService.ts` (NEW/Update)

**Context:** Advanced statistical processing.

**Changes Required:**
1.  **Implement Formula A:** Logic for `p.mean = evidence + forecast * (1 - F(t))`.
2.  **Integrate:** Ensure this service is called during aggregation if latency tracking is enabled.

### 3.4 Parameter Registry Service

**File:** `graph-editor/src/services/paramRegistryService.ts`

**Context:** Manages parameter files.

**Changes Required:**
1.  **Update `mergeTimeSeriesIntoParameter`:**
    *   Handle new latency fields (`median_lag_days`, etc.).
    *   Ensure `sliceDSL` uses canonical format (absolute dates + anchor).

## Phase C4: UI & Rendering

### 4.1 Edge Rendering

**File:** `graph-editor/src/components/edges/ConversionEdge.tsx`

**Context:** Renders the edge SVG.

**Changes Required:**
1.  **Two-layer Rendering:**
    *   Implement inner solid line (evidence) and outer striped line (forecast).
    *   Use `p.evidence` and `p.mean` to determine widths.
    *   Add stripe pattern definitions (45 degrees).
2.  **Confidence Intervals:**
    *   Ensure CIs render on the outer (forecast) layer if present.

**File:** `graph-editor/src/lib/nodeEdgeConstants.ts`

**Context:** Visual constants.

**Changes Required:**
1.  **Add Constants:** Stripe width, gap, angle, colours for forecast layer.

### 4.2 Edge Beads

**File:** `graph-editor/src/components/edges/EdgeBeads.tsx`

**Context:** Renders beads on edges.

**Changes Required:**
1.  **Add Latency Bead:**
    *   Check `latency.legacy maturity field > 0`.
    *   Render bead with median lag and completeness (e.g., "6d (80%)").

**File:** `graph-editor/src/components/edges/edgeBeadHelpers.tsx`

**Context:** Helper for bead definitions.

**Changes Required:**
1.  **Update `buildBeadDefinitions`:**
    *   Include logic to generate the latency bead definition.

### 4.3 Properties Panel

**File:** `graph-editor/src/components/PropertiesPanel.tsx`

**Context:** Properties editor sidebar.

**Changes Required:**
1.  **Update Edge/Probability Card:**
    *   Add "Latency" section.
    *   Add input for `Maturity Days`.
    *   Display read-only `Anchor Node`.
    *   Show stats: `Median Lag`, `Completeness`.

### 4.4 Scenarios & Visibility

**File:** `graph-editor/src/contexts/ScenariosContext.tsx`

**Context:** Manages scenario state.

**Changes Required:**
1.  **Update Visibility Logic:**
    *   Support 4-state visibility (F+E, F, E, Hidden).
    *   Store this state per scenario/tab.

**File:** `graph-editor/src/components/modals/ScenarioEditorModal.tsx`

**Context:** Scenario JSON/YAML editor.

**Changes Required:**
1.  **Support New Fields:** Ensure `forecast_mean`, `evidence_mean`, `completeness` are editable/viewable.

### 4.5 Tooltips

**File:** `graph-editor/src/components/Tooltip.tsx`

**Context:** Generic tooltip component.

**Changes Required:**
1.  **Enhanced Content:** Update to support structured data display (Evidence, Forecast, Blended sections) with source provenance.

### 4.6 Window Selector

**File:** `graph-editor/src/components/WindowSelector.tsx`

**Context:** Date range picker.

**Changes Required:**
1.  **Add Mode Selector:** Dropdown/Toggle for "Cohort" vs "Window" mode.
2.  **Visual Indicators:** Icons for cohort vs window mode.

### 4.7 Scenario Chip & Legend UI

**File:** `graph-editor/src/components/panels/ScenariosPanel.tsx`

**Context:** Scenarios sidebar panel.

**Changes Required:**
1.  **Update Eye Icon:** Cycle through 4 states (F+E, F, E, Hidden).
2.  **Visual Feedback:** Show icons indicating current state.

**File:** `graph-editor/src/components/ScenarioLegend.tsx`

**Context:** On-canvas legend.

**Changes Required:**
1.  **Update Chip Visuals:** Reflect the 4-state visibility (e.g., gradient for F+E, striped for F).

### 4.8 Sibling Probability Constraints

**File:** `graph-editor/src/services/integrityCheckService.ts`

**Context:** Integrity checks.

**Changes Required:**
1.  **Add Check:** `Σ p.mean` vs `Σ p.evidence`.
2.  **Warning Logic:** Flag info/warning if `Σ p.mean > 1` but `Σ p.evidence <= 1`.

## Detailed Design Questions Surfaced

1.  **Anchor Node Resolution:**
    *   *Question:* When `anchor_node_id` is computed, how do we handle graphs with cycles?
    *   *Resolution:* MSMDC should use BFS/BFS on the DAG structure. Cycles should be broken or handled gracefully (e.g., stop at already visited nodes). Since `anchor_node_id` is "furthest upstream START node", cycles might make "upstream" ambiguous. We should define it as "furthest reachable start node in the reversed graph".

2.  **Legacy Edge IDs:**
    *   *Question:* `ConversionEdge.tsx` handles lookup by UUID and ID. Does the new latency logic need to support legacy IDs?
    *   *Resolution:* Yes, consistency is key. Ensure all lookups (e.g., for `anchor_node_id` computation) support both UUID and ID where possible, or enforce UUID migration.

3.  **Amplitude Adapter Complexity:**
    *   *Question:* The `pre_request` script in `connections.yaml` is becoming very complex. Is `amplitudeHelpers.ts` enough?
    *   *Resolution:* Moving logic to `amplitudeHelpers.ts` is the right move. We need to ensure the sandbox environment for `pre_request` (if it runs in a sandbox) has access to this helper, or if it needs to be injected. *Assumption: It runs in the main context or has imports enabled.*

4.  **Performance of Coverage Check:**
    *   *Question:* `calculateIncrementalFetch` iterates dates. Is this performant for very long windows (e.g., 5 years)?
    *   *Resolution:* Should be fine for reasonable ranges. Optimization: use date ranges math instead of iterating every day if it becomes a bottleneck.

5.  **Store Structure:**
    *   *Question:* `scenarios.ts` adds `forecast_mean` etc. Should these be nested under `p` or flat?
    *   *Resolution:* Flat fields `forecast_mean`, `evidence_mean` in `EdgeParamDiff` align with the existing flat structure of overrides (`mean`, `stdev`). This avoids deep merging complexity.

6.  **Latency Config "Track" Boolean:**
    *   *Question:* The design mentions `legacy maturity field > 0` enables tracking, implies no separate boolean. Implementation plan mentions "no separate track boolean".
    *   *Confirmation:* Stick to `legacy maturity field > 0` as the source of truth for enabling the feature to keep state minimal.

7.  **Visual Clutter:**
    *   *Question:* With beads, tooltips, and now striped edges, is the UI getting too busy?
    *   *Resolution:* Ensure the "4-state visibility" allows users to simplify the view (e.g., hide forecast layers) easily. The `nobeads` mode is a good existing fallback.

8.  **New File:** `graph-editor/src/services/statisticalEnhancementService.ts`
    *   *Action:* This file does not exist and needs to be created. It should encompass the forecasting formulas.

This simulation confirms the plan is robust but highlights the need for careful handling of the Amplitude adapter logic refactoring and the performance of date-based coverage checks.
