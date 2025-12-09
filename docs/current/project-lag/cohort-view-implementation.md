## Cohort View – Implementation Plan (Cohort for All Lagged Paths)

This plan implements the simplified rule for cohort mode:

- In **cohort() mode**, **every edge whose maximum upstream path lag from the anchor is non‑zero** is treated as a cohort edge and fetched via `cohort()`.
- Only edges whose **max cumulative path lag from the anchor is zero** remain “simple” edges without LAG treatment.

The goal is to remove bespoke “path‑wise F/E hacks” and instead rely on the normal LAG pipeline everywhere it matters, while keeping window() behaviour unchanged.

---

### 1. Core Behaviour

**1.1 Definition of path lag**

- For a chosen anchor node (e.g. `landing-page`), define for each edge \(E\):
  - `max_path_t95(anchor → E)` = maximum, over all active directed paths from the anchor to \(E\), of the **sum of `t95` values on the latency‑labelled edges along that path**.
  - Edges without a `latency` block contribute 0 to sums.

**1.2 Cohort vs non‑cohort edges in cohort mode**

- In **cohort() mode**:
  - If `max_path_t95(anchor → E) > 0` for edge \(E\):
    - Treat \(E\) as a **cohort edge**:
      - Fetch data via `cohort()` from the anchor to that edge.
      - Run the standard LAG pipeline for this edge (fit distribution, compute t95, completeness, p_infinity, p_mean, p_evidence).
      - Store results under `p.latency` on the edge’s probability parameter as usual.
  - If `max_path_t95(anchor → E) = 0` for edge \(E\):
    - Treat \(E\) as a **simple edge**:
      - No LAG‑specific retrieval is required for cohort mode.
      - It can continue to use window‑style or simple cohort retrieval and expose `p.mean` without F/E split.

**1.3 Viewer semantics**

- **Window() mode**:
  - Unchanged: only edges with a local `latency` block and meaningful lag render F/E; others remain simple `p.mean`.
- **Cohort() mode**:
  - Edges with `p.latency` (produced by the LAG pipeline) continue to use existing F/E rendering rules.
  - Downstream of lagged edges, once LAG has been run on those downstream edges, they also have `p.latency` and therefore F/E view “for free”.
  - Edges with `max_path_t95 = 0` remain simple `p.mean` in cohort mode; their path is effectively instantaneous.

---

### 2. Affected Areas (High‑Level)

Changes must respect the existing “services as logic, UI as access points” rule.

- **Types & Schemas**
  - `graph-editor/src/types/index.ts` (graph, edge parameters, latency types)
  - YAML schemas under `graph-editor/public/param-schemas/` (persisted latency blocks)
  - Python models in `lib/graph_types.py` if latency metadata is mirrored there

- **LAG / Statistical Services**
  - `graph-editor/src/services/statisticalEnhancementService.ts`
    - Computation of edge‑level `t95` and any helper that may participate in path lag calculations.

- **Planner & Fetch**
  - `graph-editor/src/services/windowFetchPlannerService.ts`
    - Path lag computation, item classification, and query planning for cohort mode.
  - `graph-editor/src/services/fetchDataService.ts`
    - Orchestration of fetch batches and coordination with planner decisions.

- **Data Operations & Aggregation**
  - `graph-editor/src/services/dataOperationsService.ts`
    - Execution of cohort queries, refetch policy, persistence of latency metadata.
  - `graph-editor/src/services/windowAggregationService.ts`
    - Aggregation of cohort time‑series and recomputation of latency stats.

- **Viewer / Rendering**
  - `graph-editor/src/components/canvas/buildScenarioRenderEdges.ts`
  - `graph-editor/src/components/edges/ConversionEdge.tsx`
  - `graph-editor/src/components/nodes/ConversionNode.tsx`
    - Edge rendering and F/E display logic.

- **Tests & Documentation**
  - Service tests in `graph-editor/src/services/__tests__/`
  - Viewer and canvas tests in `graph-editor/src/components/**/*.__tests__`
  - Integration tests for horizon and merge flows (e.g. `cohortHorizonIntegration.test.ts`)
  - Design docs: `cohort-view.md`, `retrieval-date-logic-implementation-plan.md`, `window-fetch-planner-service.md`

---

### 3. Phase 1 – Compute and Cache Path Lag for All Edges

**Goal:** For any active analysis (graph + cohort DSL), have a reliable `max_path_t95(anchor → E)` value for each edge E, computed once and cached, without changing viewer logic yet.

**3.1 Path lag computation (planner layer)**

- In `windowFetchPlannerService.ts`:
  - Implement or refine a helper that:
    - Takes the current graph, anchor node, and a set of “latency edges” (edges with `p.latency` and `t95 > 0`).
    - Runs a topological‑order DP to compute `max_path_t95(anchor → node)` and then `max_path_t95(anchor → edge)`:
      - For each path from anchor to edge, sum `t95` over latency edges along the path.
      - For each edge, take the **maximum** such sum over all paths.
    - Caches results for the duration of the planner’s lifetime (per analysis / DSL).
  - Ensure recomputation is triggered when:
    - The graph’s topology changes, or
    - Latency `t95` values are updated by LAG recomputation after new data fetches.

**3.2 Types and metadata**

- In `graph-editor/src/types/index.ts` and any related service types:
  - Ensure there is a clear place to represent path lag (in memory), even if not persisted:
    - For example, a planner‑internal map keyed by edge id.
  - Keep persisted latency metadata unchanged at this phase; path lag is a planner concern here.

**3.3 Tests for Phase 1**

- Add or extend planner tests to verify:
  - Correct max‑sum behaviour when multiple paths exist (branching and merging).
  - Edges unreachable from the anchor or on purely non‑latency paths produce `max_path_t95 = 0`.
  - Caching and invalidation behave as expected when the graph or latency configuration changes.

---

### 4. Phase 2 – Cohort Planning for All Lagged Paths

**Goal:** In cohort mode, the planner treats every edge with `max_path_t95 > 0` as a cohort edge and plans appropriate `cohort()` queries, while leaving zero‑lag paths in simple mode.

**4.1 Planner classification in cohort mode**

- In `windowFetchPlannerService.ts`:
  - For analyses where the DSL includes a top‑level `cohort()` clause:
    - Use `max_path_t95(anchor → E)` to classify edges:
      - If `max_path_t95 > 0`: mark the edge’s probability param (and any relevant conditional/case params) as **cohort candidates**.
      - If `max_path_t95 = 0`: treat as **simple candidates** that do not require LAG‑style cohort fetching.
  - Ensure that classification feeds into existing item types (e.g. `needs_fetch`, `covered_stable`, `stale_candidate`), but with the source shape (`cohort()` vs window) driven by path lag.

**4.2 Query planning and horizons**

- For cohort candidates:
  - Plan **anchor‑based cohort queries** for the edge, using the existing query DSL conventions (from anchor → … → edge) and the requested cohort window.
  - Use existing retrieval‑date logic to bound horizons, with path lag as an input to horizon computation.
- For simple candidates (max path lag = 0):
  - Use existing window or simple retrieval logic; no special LAG behaviour is required.

**4.3 Tests for Phase 2**

- Extend planner tests to cover:
  - Mixed graphs where some edges lie behind latency legs and others do not.
  - Verification that in cohort mode:
    - All edges behind lag paths are scheduled for cohort queries.
    - Zero‑lag paths are not accidentally promoted to cohort edges.
  - Verification that in window mode, planning stays unchanged.

---

### 5. Phase 3 – Cohort Fetch Execution and LAG Application

**Goal:** Ensure that for all edges planned as cohort edges, the fetch layer runs cohort queries and the LAG pipeline, so that `p.latency` is populated consistently and F/E rendering works without special‑case logic.

**5.1 Fetch execution**

- In `fetchDataService.ts` and `dataOperationsService.ts`:
  - For items marked by the planner as cohort edges:
    - Execute anchor‑based cohort queries instead of window‑only queries.
    - Use existing merge logic to write cohort time‑series into parameter files.
  - For items marked as simple edges:
    - Continue to use existing window/simple retrieval and merge behaviour.

**5.2 LAG recomputation on cohort edges**

- In `windowAggregationService.ts` (and associated services):
  - After merging cohort time‑series for a cohort edge, run the standard LAG recomputation pipeline:
    - Aggregate cohort stats.
    - Fit lag distribution.
    - Compute `t95`, completeness, `p_infinity`, `p_mean`, `p_evidence`.
    - Update `p.latency` on the probability parameter.
  - This applies equally to:
    - Explicit latency edges (with local `maturity_days`), and
    - Downstream edges now treated as cohort edges due to non‑zero path lag from the anchor.

**5.3 Tests for Phase 3**

- Extend or add integration tests to verify that in cohort mode:
  - Edges behind lag paths receive cohort‑based data and have `p.latency` populated.
  - LAG statistics are recomputed for those edges and written into parameter files or in‑memory representations as appropriate.
  - Window mode remains unaffected by these changes.

---

### 6. Phase 4 – Viewer Semantics (Reusing Existing F/E Logic)

**Goal:** Make cohort view coherent by relying on existing F/E rendering, now that more edges have proper `p.latency` from cohort‑based LAG, without introducing new per‑edge hacks.

**6.1 Edge rendering**

- In `buildScenarioRenderEdges.ts` and `ConversionEdge.tsx`:
  - Keep the existing rule for enabling F/E:
    - If an edge has `p.latency` plus evidence/forecast fields, F/E rendering is available (subject to scenario visibility mode).
  - Rely on the fact that, after the preceding phases, more edges (those behind lag paths) will naturally have `p.latency` in cohort mode.
  - Do **not** introduce synthetic “path‑only completeness” gates; instead, let the presence of LAG metadata drive F/E availability.

**6.2 Node and canvas behaviour**

- In `ConversionNode.tsx` and `GraphCanvas.tsx`:
  - Ensure any tooltips, side panels, or legends that mention completeness or t95:
    - Display the same latency metadata now present on downstream edges in cohort mode.
    - Continue to treat window mode as edge‑local, cohort mode as path‑wise (because the underlying cohorts are anchor‑based).

**6.3 Tests for Phase 4**

- Add or update viewer tests to confirm that in cohort mode:
  - Edges downstream of lagged edges show F/E bands once their LAG stats exist.
  - Edges on purely instantaneous paths (max path lag = 0) remain simple `p.mean` edges.
  - Window view snapshots or expectations remain unchanged.

---

### 7. Migration, Backwards Compatibility, and Rollout

**7.1 Existing graphs and params**

- For existing parameter files:
  - The new behaviour is primarily a **planner and fetch change**; persisted schema need not change immediately.
  - On first cohort‑mode runs after this change, more edges will accumulate `p.latency` fields as LAG runs on their cohorts; this is expected and desired.

**7.2 Guard rails**

- Optionally introduce an internal configuration flag to:
  - Enable “cohort for all lagged paths” behaviour for selected workspaces or environments first.
  - Allow comparison against previous behaviour during validation.

**7.3 Documentation**

- Update and keep aligned:
  - `cohort-view.md` as the high‑level behaviour spec.
  - `retrieval-date-logic-implementation-plan.md` to reference that cohort mode now uses cohort retrieval for all edges behind lag paths.
  - Any planner‑specific docs describing how path lag is computed and used.

---

This plan is deliberately simpler than earlier versions: it removes bespoke downstream hacks and instead makes the **data itself** (cohort‑based LAG on all edges behind lag paths) carry the correct semantics, allowing the existing F/E rendering and latency UI to be reused unchanged in cohort mode.

