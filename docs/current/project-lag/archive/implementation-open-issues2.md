# Project LAG: Open Issues & Ambiguities

**Status:** Active
**Linked to:** `docs/current/project-lag/implementation.md`

This registry tracks open questions, ambiguities, and potential risks identified during the implementation planning phase.

---

## 1. Schema & Types

### 1.1 `anchor_node_id` — Part of MSMDC Query Construction
- **Issue:** When `edge.latency.enabled` is true, cohort queries need an anchor node.
- **Resolution:** Two cases:
  1. **Explicit anchor in DSL:** `cohort(anchor-node, start:end)` syntax is already parsed by `lib/queryDSL.ts` → `ParsedConstraints.cohort.anchor`.
  2. **Default anchor (no explicit):** Computed as furthest upstream START node reachable from `edge.from`. This is a straightforward BFS during query construction in `buildDslFromEdge.ts` or the calling service.
- **Implementation location:** MSMDC's existing query construction pass, specifically wherever the final query DSL is assembled for a latency-tracked edge. NOT a separate hook.
- **Status:** ✅ **RESOLVED** — unambiguous; implemented as part of Phase C (query construction for latency-tracked edges).

### 1.2 `labour_cost` migration
- **Issue:** Renaming `cost_time` to `labour_cost`.
- **Status:** **RESOLVED**. No migration required as per user confirmation (no legacy use to support). Global search/replace is sufficient.

### 1.3 Unused fields in param file schema
- **Issue:** Several fields proposed in `design.md §3.2` are fetched from Amplitude but NOT consumed by current formulas (§5.3-5.6). These exist for deferred features (convolution, Bayesian fitting, short-horizon histograms).
- **Fields in question:**
  - `anchor_n_daily[]`, `anchor_median_lag_days[]`, `anchor_mean_lag_days[]` — for convolution fallback (Appendix C.2)
  - `latency.histogram` — for short-horizon discrete CDF (Appendix C.3) and Bayesian fitting (Appendix C.4)
  - `anchor_latency.*` block — for convolution fallback (Appendix C.2)
- **Decision:** **Keep in schema, mark "stored but not consumed"**.
  - Rationale: Amplitude data is expensive to re-fetch; storing now avoids needing historical backfill when features are implemented.
  - Implementation: Schema includes these fields; retrieval code populates them; inference code ignores them until deferred features are built.
- **Status:** **RESOLVED**.

### 1.4 `legacy maturity field` role: boolean vs numeric
- **Issue:** With the CDF-based formulas (§5.3-5.6), `legacy maturity field` is no longer used computationally in the core formulas. It's effectively just a boolean (>0 = enabled).
- **Resolution:**
  - §4.7.2 updated to use **T_95** (from `median_lag_days` + `mean_lag_days`) for cache calculation
  - Falls back to `legacy maturity field` when empirical data unavailable or low quality (`k < 30` or `mean/median` ratio outside [1.0, 3.0])
  - `legacy maturity field` now serves as: feature flag (>0 = enabled) + fallback threshold
- **Status:** **RESOLVED**. Design §4.7.2 and implementation §3.6 updated.

### 1.5 Topological sorting of batch fetches
- **Issue:** Current `fetchDataService.getItemsNeedingFetch()` returns items in graph array order (creation order), not topological order.
- **Resolution:**
  - Implementation plan updated (§3.7) to add topological sorting
  - Ensures upstream `median_lag_days` available for downstream cache calculation
- **Status:** **RESOLVED**. Implementation §3.7 added.

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
- **Status:** **RESOLVED**. Implementation plan updated.

### 3.3 Latency data storage architecture
- **Issue:** Should we store slice-level latency aggregates (median, mean, T_95) in param files, or compute at query time?
- **Resolution:**
  - **Param files** (query-independent): Per-cohort arrays only (`median_lag_days[]`, `mean_lag_days[]`, `k_daily[]`). Raw Amplitude data, shared across queries.
  - **Graph file** (query-specific): Computed latency stats (`mu`, `sigma`, `t95`, `path_t95`) persisted alongside pinned query DSL. Invalidated/recomputed when query changes.
  - **Rationale:** Graph already stores query context; storing computed results for that context is logically consistent. No "transient in-memory only" complexity.
- **Status:** **RESOLVED**. Design §3.1, §5.8 and implementation §3.6-3.7 updated.

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
