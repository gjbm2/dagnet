## Cohort View – Implementation Plan (Cohort for All Lagged Paths)

This plan implements the simplified rule for cohort mode as a **planner / retrieval optimisation**, while keeping the **probability semantics (E / F / blended `p.mean`) uniform across all edges**:

- In **cohort() mode**, **every edge whose maximum upstream path lag from the anchor is non‑zero** is treated as a cohort edge and fetched via `cohort()`.
- Only edges whose **max cumulative path lag from the anchor is zero** remain "simple" from a **retrieval and latency‑completeness** perspective (no anchor‑based A→…→X→Y cohort query is required).

The goal is to remove bespoke "path‑wise F/E hacks" and instead rely on the normal LAG pipeline everywhere it matters, while keeping window() behaviour unchanged.

---

### 0. Implementation Constraints (Risk Reduction)

**No new persisted params.** This plan uses only existing fields:

- `p.mean`, `p.evidence.*`, `p.forecast.*`
- `p.latency.{t95, path_t95, completeness, legacy maturity field, median_lag_days}`

The LAG topo pass (`enhanceGraphLatencies`) **already computes `path_t95`** per edge and writes it to `p.latency.path_t95`. The planner simply reads this value to classify edges; no new schema or storage is required.

**No new code paths.** This plan reuses existing services end‑to‑end:

- **`statisticalEnhancementService.enhanceGraphLatencies`** – already computes `path_t95`, completeness, blended `p.mean`, and populates `p.latency.*`.
- **`dataOperationsService.addEvidenceAndForecastScalars`** – already computes `p.evidence.*` and attaches `p.forecast.*` via dual‑slice lookup.
- **`fetchDataService.fetchItems`** – already orchestrates batch fetches with cohort vs window logic and calls `enhanceGraphLatencies`.
- **`windowFetchPlannerService`** – already classifies items; we add a branch that reads existing `path_t95` to decide cohort vs simple.

The viewer (`ConversionEdge`, `buildScenarioRenderEdges`) already keys rendering on field presence (`p.latency`, `p.evidence`, `p.forecast`) and scenario mode; no viewer changes are required.

**Summary:** This plan is pure **planner wiring** – connecting existing data (`path_t95`) to existing classification logic, so more edges flow through the existing LAG pipeline in cohort mode.

---

### 0.1 Field Semantics (Invariant)

The **meaning of the fields** remains invariant regardless of whether an edge is behind a lagged path:

- `p.evidence.mean` – always the raw observed rate Σk/Σn for the current query.
- `p.forecast.mean` – always the baseline from mature window data (when available).
- `p.mean` – always the "forecast lane": a blend of F+E for LAG‑tracked edges, and equal to evidence for edges not treated by the LAG completeness machinery.

The **viewer modes** (E, F, F+E) do not special‑case latency vs non‑latency edges; they simply choose which of these fields to display:

- **E mode** → `p.evidence.mean`.
- **F mode** → `p.mean`.
- **F+E mode** → both lanes; they coincide visually when `p.mean = p.evidence.mean`.

---

### 1. Core Behaviour

**1.1 Definition of path lag**

- For a chosen anchor node (e.g. `landing-page`), define for each edge \(E\):
  - `max_path_t95(anchor → E)` = maximum, over all active directed paths from the anchor to \(E\), of the **sum of `t95` values on the latency‑labelled edges along that path**.
  - Edges without a `latency` block contribute 0 to sums.

**1.2 Cohort vs non‑cohort edges in cohort mode**

- In **cohort() mode**:
  - If `max_path_t95(anchor → E) > 0` for edge \(E\):
    - Treat \(E\) as a **cohort edge** from a **latency / completeness** perspective:
      - Fetch data via `cohort()` from the anchor to that edge (A‑anchored cohorts).
      - Run the standard LAG pipeline for this edge (fit distribution, compute t95, completeness, p_infinity, blended `p.mean`, and evidence).
      - Store results under `p.latency` on the edge’s probability parameter as usual.
  - If `max_path_t95(anchor → E) = 0` for edge \(E\):
    - Treat \(E\) as a **simple edge for latency purposes**:
      - No LAG‑specific cohort retrieval is required in cohort mode (no need for 3‑step A→…→X→Y funnels).
      - It continues to use window‑style or simple cohort retrieval for evidence.
      - If a suitable window baseline exists, it still obtains `p.forecast.mean` via the dual‑slice mechanism (design.md §4.6).
      - Its `p.mean` remains equal to `p.evidence.mean` (no completeness‑based blending), so F, E, and F+E modes **all read the same underlying probability** even though both evidence and forecast fields are still available.

**1.3 Viewer semantics**

The cohort‑view changes are deliberately **orthogonal** to how the viewer chooses to display Forecast vs Evidence. The viewer continues to operate only in terms of the three probability “lanes” and scenario mode:

- **Evidence lane**: `p.evidence.mean` (if present).
- **Forecast lane**: `p.mean` (the “F lane” – blended for LAG edges, equal to evidence for simple edges).
- **Baseline context**: `p.forecast.mean` (where a window baseline exists).

Modes:

- **E mode**:
  - Shows the Evidence lane only: `p.evidence.mean` for all edges where evidence exists.
- **F mode**:
  - Shows the Forecast lane only: `p.mean` for all edges.
  - For LAG‑treated edges, this is the blended forecast; for instantaneous edges, this naturally collapses to evidence because `p.mean = p.evidence.mean`.
- **F+E mode**:
  - Shows both Evidence (`p.evidence.mean`) and Forecast (`p.mean`) lanes side by side.
  - On edges where `p.mean = p.evidence.mean` (no LAG blending), the two lanes coincide visually without any special handling.

The effect of this plan on the viewer is therefore:

- **Window() mode**:
  - Unchanged in layout and interaction; edges simply have better‑populated `p.evidence.*` and `p.forecast.*` fields, and LAG‑enabled edges have `p.latency.*` for completeness/t95 visualisation.
- **Cohort() mode**:
  - More edges behind lag paths acquire `p.latency` via the LAG pipeline, so completeness and path‑wise maturity can be rendered consistently.
  - Edges with `max_path_t95 = 0` still have coherent E/F/F+E behaviour (evidence, forecast baseline where available, and `p.mean = p.evidence`), they simply do not participate in path‑lag completeness logic or require anchor‑based cohort retrieval.

---

### 2. Affected Areas (High‑Level)

Changes must respect the existing "services as logic, UI as access points" rule.

**Services reused unchanged (no modifications required):**

- `graph-editor/src/services/statisticalEnhancementService.ts`
  - `enhanceGraphLatencies` already computes `path_t95`, completeness, and blended `p.mean`.
- `graph-editor/src/services/dataOperationsService.ts`
  - `addEvidenceAndForecastScalars` already computes evidence and attaches forecast via dual‑slice.
- `graph-editor/src/services/windowAggregationService.ts`
  - Cohort aggregation and latency stats already implemented.
- **Viewer / Rendering** (`buildScenarioRenderEdges.ts`, `ConversionEdge.tsx`, `ConversionNode.tsx`)
  - Already keys rendering on field presence (`p.latency`, `p.evidence`, `p.forecast`) and scenario mode.
  - No changes required.

**Services requiring wiring changes:**

- `graph-editor/src/services/windowFetchPlannerService.ts`
  - **Read** existing `p.latency.path_t95` from edges.
  - **Classify** edges as cohort candidates (`path_t95 > 0`) vs simple (`path_t95 = 0`) in cohort mode.
- `graph-editor/src/services/fetchDataService.ts`
  - Pass planner classification to determine cohort vs window fetch shape.
  - Ensure `enhanceGraphLatencies` runs on cohort‑candidate edges (already happens in batch flow).

**No schema changes:**

- Types (`graph-editor/src/types/index.ts`) – no new fields.
- YAML schemas (`graph-editor/public/param-schemas/`) – unchanged.
- Python models (`lib/graph_types.py`) – unchanged.

**Tests & Documentation:**

- Add planner tests for `path_t95` classification logic.
- Add integration tests for cohort‑mode edge promotion.
- Update design docs: `cohort-view.md`, `retrieval-date-logic-implementation-plan.md`.

---

### 3. Phase 1 – Read Existing `path_t95` in Planner

**Goal:** For any active analysis (graph + cohort DSL), the planner reads `p.latency.path_t95` (already computed by `enhanceGraphLatencies`) to classify edges as "cohort candidates" vs "simple".

**3.1 Reading path lag (planner layer)**

- In `windowFetchPlannerService.ts`:
  - After a batch fetch completes (or when planning against an already‑enhanced graph):
    - Read `edge.p.latency.path_t95` for each edge.
    - Build an in‑memory map `{ edgeId → path_t95 }` for classification.
  - **No new computation is required** – `enhanceGraphLatencies` already runs the topological DP and writes `path_t95` to each edge's `p.latency`.
  - Handle the cold‑start case (first fetch, no `path_t95` yet):
    - Either run a lightweight pre‑pass using `legacy maturity field` as a proxy, or
    - Accept that the first fetch treats all edges as simple, and subsequent fetches (after LAG has run) use real `path_t95`.

**3.2 Types and metadata**

- **No new persisted fields.**
- The planner may keep a transient map `Map<edgeId, number>` keyed by edge id for the duration of the analysis; this is purely in‑memory and derived from existing `p.latency.path_t95`.

**3.3 Tests for Phase 1**

- Add or extend planner tests to verify:
  - Planner correctly reads `path_t95` from edges where `p.latency.path_t95` exists.
  - Edges without `p.latency` (or with `path_t95 = 0`) are classified as simple.
  - Cold‑start behaviour is documented and tested (first fetch before LAG has run).

---

### 4. Phase 2 – Cohort Planning Using Existing `path_t95`

**Goal:** In cohort mode, the planner classifies edges based on existing `p.latency.path_t95` and routes them to appropriate fetch/LAG logic.

**4.1 Planner classification in cohort mode**

- In `windowFetchPlannerService.ts`:
  - For analyses where the DSL includes a top‑level `cohort()` clause:
    - Read `edge.p.latency.path_t95` (already computed by `enhanceGraphLatencies`).
    - Classify:
      - `path_t95 > 0` → **cohort candidate** (use anchor‑based cohort retrieval, run full LAG).
      - `path_t95 = 0` or undefined → **simple candidate** (use window/simple retrieval, no LAG completeness).
  - Feed classification into existing item types (`needs_fetch`, `covered_stable`, `stale_candidate`), with the source shape (`cohort()` vs `window()`) driven by `path_t95`.

**4.2 Query planning and horizons**

- For **cohort candidates**:
  - Plan anchor‑based cohort queries using existing DSL conventions.
  - Use existing retrieval‑date logic (already uses `path_t95` for horizon computation).
- For **simple candidates**:
  - Use existing window or simple retrieval logic; no LAG completeness behaviour.
  - They still get `p.forecast.mean` via dual‑slice if a window baseline exists.

**4.3 Tests for Phase 2**

- Extend planner tests to cover:
  - Mixed graphs where some edges have `path_t95 > 0` and others have `path_t95 = 0`.
  - Verification that in cohort mode:
    - Edges with `path_t95 > 0` are scheduled for cohort queries.
    - Edges with `path_t95 = 0` use simple retrieval.
  - Verification that in window mode, planning stays unchanged (classification not applied).

---

### 5. Phase 3 – Cohort Fetch Execution (Existing Services)

**Goal:** Ensure that edges classified as cohort candidates flow through the existing cohort fetch and LAG pipeline.

**5.1 Fetch execution (existing code paths)**

- In `fetchDataService.ts`:
  - For items marked as **cohort candidates** by the planner:
    - Use existing anchor‑based cohort fetch logic (already implemented for `legacy maturity field` edges).
    - Use existing merge logic in `dataOperationsService` to write cohort time‑series into parameter files.
  - For items marked as **simple candidates**:
    - Use existing window/simple retrieval and merge behaviour.
  - **No new fetch code paths** – we route cohort candidates to the existing cohort machinery.

**5.2 LAG recomputation (existing service)**

- `enhanceGraphLatencies` already runs after batch fetches and:
  - Aggregates cohort stats.
  - Fits lag distribution.
  - Computes `t95`, `path_t95`, completeness, blended `p.mean`, and populates `p.latency.*`.
- **No changes required** – cohort candidates flow through this existing pipeline.
- The only change is that **more edges** are now routed to cohort retrieval (based on `path_t95` classification), so more edges naturally get `p.latency` populated.

**5.3 Tests for Phase 3**

- Add integration tests to verify:
  - Edges with `path_t95 > 0` receive cohort‑based data and have `p.latency` populated after fetch.
  - The existing `enhanceGraphLatencies` correctly processes these edges.
  - Window mode remains unaffected.

---

### 6. Phase 4 – Viewer (No Changes Required)

**Goal:** Verify that existing F/E rendering works correctly now that more edges have `p.latency` populated.

**6.1 Edge rendering (existing logic)**

- `buildScenarioRenderEdges.ts` and `ConversionEdge.tsx` already:
  - Read `p.evidence.mean`, `p.forecast.mean`, `p.mean`, `p.latency.*`.
  - Decide what to render based on field presence and scenario mode (E / F / F+E).
- **No code changes required.**
- After the preceding phases, more edges (those behind lag paths) naturally have `p.latency`, so F/E rendering and completeness display "just work".

**6.2 Node and canvas behaviour (existing logic)**

- Tooltips, side panels, and legends that reference completeness or `t95` already read `p.latency.*`.
- **No code changes required** – they display whatever is present.

**6.3 Tests for Phase 4**

- Add or update viewer tests to confirm:
  - Edges with `p.latency` show completeness / F/E bands.
  - Edges with `path_t95 = 0` (simple) show `p.mean = p.evidence.mean` without F/E split.
  - Window mode snapshots remain unchanged.

---

### 7. Migration, Backwards Compatibility, and Rollout

**7.1 Existing graphs and params**

- **No schema migration required.** All changes are to planner routing, not persisted data.
- On first cohort‑mode runs after this change, more edges will have `p.latency` populated as LAG runs on their cohorts; this is expected and desired.
- Existing parameter files continue to work unchanged.

**7.2 Risk profile**

- **Low risk:** We are wiring existing, tested services together via planner classification.
- **No new code paths:** Cohort candidates flow through existing cohort fetch + `enhanceGraphLatencies`.
- **No viewer changes:** Rendering already keys on field presence.
- **Incremental rollout:** The planner classification can be gated behind a feature flag if desired, but the lack of new code paths makes this lower priority.

**7.3 Documentation**

- Update:
  - `cohort-view.md` – high‑level behaviour spec.
  - `retrieval-date-logic-implementation-plan.md` – reference `path_t95` classification.

---

### Summary

This plan is deliberately minimal:

- **Reads** existing `p.latency.path_t95` (no new computation).
- **Routes** edges with `path_t95 > 0` through existing cohort + LAG pipeline (no new code paths).
- **Reuses** existing viewer logic (no changes required).

The result is that more edges in cohort mode get `p.latency` populated, giving coherent F/E semantics throughout the graph without bespoke hacks.

