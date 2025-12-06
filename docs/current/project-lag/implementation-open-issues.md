# Project LAG: Open Issues & Ambiguities

**Status:** Active
**Linked to:** `docs/current/project-lag/implementation.md`

This registry tracks open questions, ambiguities, and potential risks identified during the implementation planning phase.

---

## 1. Schema & Types

### 1.1 `anchor_node_id` computation
- **Issue:** The design states `anchor_node_id` is computed by MSMDC at graph-edit time. We need to ensure this logic is hooked into `UpdateManager` or `GraphMutationService` correctly so it persists to the edge.
- **Resolution:** Identify the exact hook point in `UpdateManager` where topology changes trigger re-computation of derived edge properties.
- **Status:** Open. Need to propose specific design change (hook in `GraphMutationService`).

### 1.2 `labour_cost` migration
- **Issue:** Renaming `cost_time` to `labour_cost`.
- **Status:** **RESOLVED**. No migration required as per user confirmation (no legacy use to support). Global search/replace is sufficient.

## 2. Query Architecture

### 2.1 `window()` vs `cohort()` handling
- **Issue:** `dslConstruction.ts` builds queries from selection.
- **Status:** **RESOLVED**. `WindowSelector` only maintains the DSL string. The interpretation (cohort vs window execution) is determined by the `latency.track` configuration on the specific edge in `buildDslFromEdge.ts` / `dataOperationsService`. No props need to be passed from WindowSelector.

### 2.2 Amplitude Adapter `pre_request` complexity
- **Issue:** The `pre_request` script in `connections.yaml` is becoming very complex.
- **Status:** **RESOLVED**. Plan updated to refactor this logic into a dedicated helper file `src/lib/das/adapters/amplitudeHelpers.ts` which will be exposed to the sandbox.

## 3. Data & Aggregation

### 3.1 In-memory caching of `cohort_data` (Histogram volume)
- **Issue:** Concern about data volume of histograms per cohort.
- **Status:** **RESOLVED**. Review of `amplitude_to_param.py` confirms histograms are binned to whole days (0-10) plus a tail bucket. This results in ~12 integers per cohort, which is negligible volume.

### 3.2 Formula A / `p.forecast` location
- **Issue:** Where does Formula A run? Where is `p.forecast` stored?
- **Resolution:**
  - `p.forecast` (Mature Baseline Probability): Computed at **Retrieval Time** (from mature cohorts) and stored in the parameter file (e.g., in `values[].latency` or `values[].forecast`).
  - `Formula A`: Runs at **Query Time** to forecast immature cohorts based on their current age.
  - **Location:** Logic belongs in `statisticalEnhancementService` (TS), not `windowAggregationService`. This keeps aggregation pure (counting) and enhancements separate (forecasting).
- **Status:** Closed. Implementation plan updated.

## 4. Rendering

### 4.1 ReactFlow Performance
- **Issue:** Rendering two layers per edge.
- **Status:** **RESOLVED**. User confirmed this is not a concern.

---

## 5. Testing

### 5.1 Mocking Amplitude Data
- **Issue:** Testing latency inference requires realistic `dayFunnels` and `dayMedianTransTimes` data.
- **Action:** Create a robust mock generator that simulates cohort maturation curves to verify the `mature/immature` split logic.
- **Status:** Open (Task in Implementation Plan).
