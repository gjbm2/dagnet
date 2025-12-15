## Retrieval Date Logic – Implementation Plan to Align Code with Design

**Date:** 9-Dec-25  
**Status:** Implementation plan (prose only)  
**Related docs:** `design.md`, `window-fetch-planner-service.md`, `window-fetch-planner-detailed-design.md`, `retrieval-date-logic-redux.md`

---

## 1. Objectives and Scope

This plan describes, in concrete yet code-free terms, how to close the gap between the current implementation and the project‑LAG design for retrieval date logic, with particular focus on:

- Using `t95` and `path_t95` to bound **retrieval horizons** for `cohort()` and `window()` queries.
- Implementing a **central window fetch planner service** that:
  - Distinguishes **covered and stable**, **not covered**, and **covered but potentially stale** outcomes.
  - Uses `t95` / `path_t95` plus `retrieved_at` to classify **stale refresh candidates**.
- Ensuring the **WindowSelector** and fetch hooks use a single planner‑driven path for:
  - Auto‑aggregation decisions.
  - Fetch vs refresh calls to action.
- Minimising new code surface area and avoiding duplicate decision paths.

Out of scope:

- Changes to external adapters or low‑level statistical routines beyond what is already agreed in `design.md`.
- New user‑facing configuration flags for refetch aggressiveness.

---

## 2. High‑Level Phasing

The work is broken into coherent phases that can be delivered incrementally:

1. **Phase 0 – Ground truth consolidation**
   - Confirm and document invariants around `t95`, `path_t95`, and retrieval timestamps.
2. **Phase 1 – Wire up `path_t95` computation and application**
   - Ensure `path_t95` is actually computed and applied to the in‑memory graph after relevant fetches.
3. **Phase 2 – Implement a retrieval‑aware window fetch planner service**
   - Introduce a service that analyses coverage, maturity, and staleness for a given graph and query.
4. **Phase 3 – Align cohort retrieval horizons with `t95` / `path_t95`**
   - Introduce helpers that bound how far back we retrieve cohorts, and integrate them into fetch planning.
5. **Phase 4 – Integrate planner with UI and existing fetch paths**
   - Replace ad‑hoc coverage/staleness logic in WindowSelector and related components with planner output.
6. **Phase 5 – Tests and migration**
   - Add and adjust service‑level and integration tests to reflect the new behaviour.

Each phase below describes:

- Target files and responsibilities (in words).
- Behavioural changes.
- Order‑of‑operations and safe rollout considerations.

---

## 3. Current Code State (Window Selector and Planner)

Before describing the target design, this section summarises the current implementation as of this plan.

- **WindowSelector:**
  - Maintains the current window and authoritative DSL (`graphStore.currentDSL`), updating both when the user changes the date range or presets.
  - Has a feature flag (`USE_PLANNER`) that switches between:
    - **Legacy path** (flag false): coverage and `needsFetch` are computed inside WindowSelector using `hasFullSliceCoverageByHeader`, `calculateIncrementalFetch`, and a separate `batchItemsToFetch` list.
    - **Planner path** (flag true): the component calls `windowFetchPlannerService.analyse()` for analysis and `windowFetchPlannerService.executeFetchPlan()` when the user clicks Fetch, while still retaining some legacy coverage logic alongside it.

- **WindowFetchPlannerService:**
  - Already implemented as a real service, not just a stub.
  - Delegates coverage classification to `fetchDataService.getItemsNeedingFetch()` / `getItemsNeedingFetch()` so that its `needs_fetch` view matches execution.
  - Uses `shouldRefetch` and the current graph edge latency config to classify covered items as stale vs stable, and produces:
    - `autoAggregationItems`, `fetchPlanItems`, `staleCandidates`, `unfetchableGaps`.
  - Does **not yet** use `path_t95`; all maturity decisions are edge‑local (`t95`/`legacy maturity field`), and cohort retrieval horizons are still implicitly “full slice” rather than horizon‑bounded.

- **Path `t95` computation:**
  - TypeScript helpers for `computePathT95` / `applyPathT95ToGraph` exist in `statisticalEnhancementService.ts`.
  - They are **not currently wired** into any production flow (no calls from planner, `fetchDataService`, or `dataOperationsService`).

- **Execution path:**
  - All real fetches still go through `fetchDataService.fetchItem(s)` and `dataOperationsService.getFromSource`, which:
    - Handle incremental window gap detection.
    - Apply maturity‑aware refetch policy (`shouldRefetch`) per edge.
    - Merge time series into parameter files and propagate updated scalars (including `t95`) back to the graph.

The phases below describe how to move from this mixed state (legacy + planner behind a flag, no `path_t95` wiring, no horizon‑aware cohorts) to the target architecture in a controlled way.

---

## 3. Phase 0 – Ground Truth Consolidation

### 3.1 Clarify invariants in design docs

**Files:**

- `docs/current/project-lag/design.md`
- `docs/current/project-lag/window-fetch-planner-service.md`

**Actions (prose only):**

- Re‑state explicitly in the docs that:
  - `t95` is the primary scalar maturity horizon for an individual edge and is **persisted** on the graph.
  - `path_t95` is the cumulative maturity horizon from the anchor to a downstream edge, computed per scenario and **never persisted**; it is always recomputed cheaply from persisted `t95` and the current scenario topology.
  - Retrieval staleness tests for cohorts should use a **freshly computed** `path_t95` where available, falling back to edge `t95` or `legacy maturity field`.
- Add a concise subsection summarising the intended relationship between:
  - Query DSL windows (`window()` and `cohort()` clauses).
  - Retrieval horizons derived from `t95` / `path_t95`.
  - Coverage/staleness classification in the planner.

**Goal:** Have a single, unambiguous statement of retrieval‑date invariants that can be referenced by code comments and tests.

---

## 4. Phase 1 – Wire Up `path_t95` Computation and Application

Currently, the TypeScript functions to compute and apply `path_t95` exist but are unused. This phase makes them part of the standard fetch pipeline without altering planner or UI behaviour yet.

### 4.1 Decide when to compute `path_t95`

**Files:**

- `graph-editor/src/services/statisticalEnhancementService.ts`
- `graph-editor/src/services/fetchDataService.ts`
- `graph-editor/src/services/dataOperationsService.ts`

**Behavioural intent:**

- After a batch of latency‑relevant window slices has been fetched and their `t95` values recomputed:
  - Compute `path_t95` **from persisted `t95` and the current scenario topology** for active edges under that scenario.
  - Apply `path_t95` to the in‑memory graph’s `p.latency.path_t95` fields as **transient, per‑scenario data**.
- When computing `path_t95`, respect cohort anchoring as described in `design.md`:
  - For latency edges with `latency.anchor_node_id`, treat that node as the cohort anchor A and only propagate `path_t95` along paths that are reachable from that anchor under the current scenario.
  - For non‑latency edges or edges without an anchor, treat their effective lag as zero for the purposes of path maturity.
- Ensure this happens:
  - Once per relevant batch fetch or query evaluation where retrieval decisions are needed, not per individual edge.
  - In a way that does not introduce extra external calls or expensive recomputation (the DP is linear in the number of active edges).

### 4.2 Integration steps (conceptual)

- In the place where we already:
  - Sort fetch items topologically for latency purposes.
  - Finish applying `t95` back onto `edge.p.latency.t95`.
- Insert a **pure in‑memory step** that:
  - Builds a minimal `GraphForPath` representation from the current graph.
  - Calls the existing `computePathT95` helper with the set of edges that are active under the current scenario.
  - Applies results via `applyPathT95ToGraph`.
- Ensure that:
  - Scenario‑specific active edge selection is consistent with `design.md` (same notion of “active” as the what‑if engine).
  - `path_t95` is not persisted to disk; it should only live in the in‑memory graph for the lifetime of the scenario/query context and is **recomputed whenever a new scenario or query context requires it**.

### 4.3 Testing strategy (high level)

- Add service‑level tests under `graph-editor/src/services/__tests__/` that:
  - Construct small graphs with known `t95` per edge.
  - Invoke the new combined logic (fetch completion + path computation) and assert:
    - `p.latency.path_t95` on each edge matches the expected cumulative sums.
    - Behaviour with disabled edges (inactive under scenario) matches the DP spec.

**Exit criteria:** `path_t95` is reliably populated in the runtime graph after latency‑relevant fetches, with no user‑visible behavioural change yet.

---

## 5. Phase 2 – Implement Retrieval‑Aware Window Fetch Planner Service

This phase introduces the planner service described in the planner docs, but initially runs it in “analysis‑only” mode (produce decisions and logs without changing UI behaviour).

### 5.1 Service placement and responsibilities

**Files:**

- New service file under `graph-editor/src/services/`, for example `windowFetchPlannerService.ts`.
- Optionally, a small types file or internal types block within the service.

**Planner responsibilities (in prose):**

- Accept:
  - The current graph (with `t95` persisted on edges and, for the current scenario, `path_t95` either already computed in memory or available to be recomputed on demand from `t95` and topology).
  - The authoritative query DSL (from `graphStore.currentDSL`).
  - Any configuration needed for maturity/staleness decisions (reused from existing latency config).
- Analyse, for each relevant parameter or case:
  - Coverage for the requested window or cohort (using existing coverage utilities such as `hasFullSliceCoverageByHeader` and `calculateIncrementalFetch` for windows, and appropriate cohort coverage checks for cohorts).
  - Maturity and staleness status by:
    - Comparing query horizons with `t95` / `path_t95`.
    - Comparing retrieval timestamps with those same horizons.
  - Classify items into:
    - Fully covered and stable.
    - Not covered (missing data that is fetchable).
    - Covered but potentially stale (refresh candidates).
    - Unfetchable file‑only gaps.
- Produce:
  - A **planner result object** (internal type), mirroring the structure sketched in `window-fetch-planner-service.md`:
    - Overall outcome state.
    - Auto‑aggregation plan (items safe to aggregate from cache).
    - Fetch plan (items requiring retrieval from source).
    - Stale candidates.
    - Fetch‑independent summaries for tooltips/logging.

### 5.2 Use existing primitives, do not duplicate logic

Within the planner service:

- Reuse:
  - Coverage helpers from `windowAggregationService` and any existing case coverage utilities.
  - Refetch policy decisions (`shouldRefetch`) as a building block to understand latency‑driven refetch needs, without re‑implementing the state machine.
  - Latency metadata (`t95`) from the graph as the persisted source of truth, and `path_t95` as a **per‑call, recomputed** view derived from the active edges and active parameters under the current scenario and their `t95` values.
- Ensure the planner is **side‑effect free**:
  - No direct calls to external APIs.
  - No file system or IndexedDB writes.
  - No direct graph mutations; only read from the graph and files.

### 5.3 Logging and analysis‑only integration

Initially, introduce the planner as an **analysis tool only**:

- Provide a function that can be called from:
  - A dedicated test harness.
  - Instrumented versions of WindowSelector or background diagnostics (behind a feature flag).
- Ensure each planner run:
  - Starts a session log operation with the DSL and window context.
  - Logs the counts of:
    - Covered items.
    - Missing items.
    - Stale candidates.
    - Unfetchable gaps.
  - Logs the chosen outcome state.

**Exit criteria:** A planner service exists, can be called in isolation, and produces stable, inspectable decisions without being wired into UI behaviour.

---

## 6. Phase 3 – Align Cohort Retrieval Horizons with `t95` / `path_t95`

This is the main behavioural change for cohort queries. The goal is to stop refetching full historical cohorts by default and instead:

- Respect cumulative lag horizons along the path (anchored at `latency.anchor_node_id` for latency edges).
- Still honour the user’s `cohort()` DSL window as the outer envelope.

### 6.1 Define a retrieval‑horizon helper

**Files:**

- New helper under `graph-editor/src/services/` (either in the planner service or as a small separate module) that:
  - Knows how to interpret `t95` and `path_t95` in the context of a query.

**Responsibilities:**

- Given:
  - An edge with `p.latency.t95` (persisted) and, for the current scenario, either:
    - A freshly computed `p.latency.path_t95`, or
    - Enough information (graph topology plus `t95`) to compute `path_t95` on demand.
  - Today’s date (or a supplied reference date).
  - The requested cohort DSL (start and end dates).
- Compute:
  - A **recommended maximum look‑back** for cohort entry dates based on:
    - Path‑level maturity (`path_t95`) when present or computed on demand.
    - Otherwise, edge‑level `t95`.
  - A **bounded cohort window** for retrieval that:
    - Does not extend further back than needed for the cohorts that materially contribute under the current `t95`/`path_t95`.
    - Still respects the forward end of the requested window (i.e. does not truncate recent cohorts).

The helper should be pure and return a clear description of:

- Original cohort window from the DSL.
- Bounded cohort retrieval window actually recommended for fetch.

In addition, for clarity, the helper must:

- Derive, per edge, the **incremental A‑entry band** introduced by the new query relative to existing coverage (for example, `[-9d, 0d]` when moving from `cohort(-100d:-10d)` to `cohort(-90d:)`).
- Use that incremental band together with the edge’s `path_t95` to determine how far back along A‑entry time that edge needs cohort data so that the new band is correctly represented at that edge.
- From that derived horizon and existing coverage, separate:
  - Strictly missing cohorts that must be fetched now.
  - Older cohorts inside the horizon that may be refreshed if `retrieved_at + path_t95` indicates they were previously immature or are now stale.
- Never shrink or widen the user’s `cohort()` DSL window; it only decides which cohorts within that window (and its implied horizon) actually require retrieval or refresh for each individual edge.

### 6.2 Integrate horizon helper into fetch planning

**Files:**

- `graph-editor/src/services/dataOperationsService.ts`
- `graph-editor/src/services/fetchDataService.ts`
- `graph-editor/src/services/fetchRefetchPolicy.ts`

**Behavioural changes (in words):**

- When a cohort refetch is required (e.g. `replace_slice` from `shouldRefetch`):
  - Instead of automatically using the full DSL cohort window for retrieval, pass the edge and DSL into the horizon helper to obtain a **bounded retrieval window**.
  - Use this bounded window for:
    - The external API call.
    - The cohort slice we construct and merge.
- Ensure:
  - The planner and any diagnostics see and log both:
    - The user‑requested DSL cohort window.
    - The actual retrieval window used after applying the horizon.
  - The merge semantics for cohort slices remain “replace slice”, but the slice being written corresponds to the bounded horizon rather than the entire original range.

### 6.3 Edge cases to handle

Design the helper and integration to cope with:

- Missing or zero `t95` / `path_t95`:
  - Fall back to `legacy maturity field` or a conservative default, as per design.
- Very large `t95` values:
  - Allow retrieval windows to remain long when the lag statistics justify it.
- Cohort DSLs that are already shorter than the horizon:
  - Avoid widening them; use the original range.

**Exit criteria:** For cohort refetches on latency edges, the **retrieval window is now bounded by cumulative lag horizons**, rather than always matching the full DSL cohort range.

---

## 7. Phase 4 – Integrate Planner with UI and Fetch Hooks

Once the planner and horizon helper are stable, the next step is to make UI and hooks rely on the planner instead of bespoke coverage/staleness logic.

### 7.1 Replace WindowSelector coverage logic with planner calls

**Files:**

- `graph-editor/src/components/WindowSelector.tsx`
- `graph-editor/src/hooks/useFetchData.ts`

**Conceptual changes:**

- Remove or deprecate the long effect chain in WindowSelector that:
  - Directly iterates edges and parameters.
  - Uses `hasFullSliceCoverageByHeader` and `calculateIncrementalFetch` independently to decide `needsFetch`.
- Replace with:
  - A single effect that:
    - Observes changes in the authoritative DSL and window selection.
    - Calls the planner analysis function.
    - Stores the planner result and derived outcome state in component state.
  - Additional small effects that:
    - Trigger auto‑aggregation when planner says it is safe and desirable.
    - Drive shimmer/animation and toasts based on planner outcome summaries.

### 7.2 Fetch buttons and batch operations

**Files:**

- Fetch‑related components or menus that currently:
  - Manually construct lists of items to fetch.
  - Make independent decisions about when to enable/disable the fetch button.

**Behavioural intent:**

- All such UI entry points should:
  - Use the planner’s **fetch plan** and **stale candidates** lists to decide:
    - Whether to show “Fetch data” vs “Fetch latest” vs a neutral state.
    - Which items to pass to `useFetchData.fetchItems`.
  - Avoid re‑implementing coverage or maturity logic locally.

### 7.3 Hook integration

Ensure `useFetchData`:

- Continues to encapsulate the single underlying code path:
  - UI components ask the planner “what needs to be fetched or refreshed”.
  - They then delegate execution to the hook/service without re‑evaluating coverage.
- Exposes any additional outcome hints needed for UI (for example, whether the planner currently considers the DSL “covered but stale”).

**Exit criteria:** WindowSelector and other fetch entry points no longer contain bespoke coverage and staleness logic; they delegate decisions to the planner and focus only on wiring user interactions to service calls.

---

## 8. Phase 5 – Tests and Migration

### 8.1 Planner service tests

**Files:**

- `graph-editor/src/services/__tests__/windowFetchPlannerService.test.ts` (new).

**Scenarios to cover (described in words):**

- Fully covered and stable windows:
  - All relevant items have complete coverage within the window.
  - Cohorts and windows are mature beyond their respective horizons.
  - Planner outcome is “covered and stable”; fetch plan is empty; stale candidates list is empty.
- Not covered – missing data:
  - At least one item has missing dates or slices for the window/cohort.
  - Planner outcome is “not covered”; fetch plan lists missing items; stale candidates may be empty.
- Covered but potentially stale:
  - All items covered, but one or more are within the staleness threshold defined by retrieval timestamps plus `t95`/`path_t95`.
  - Planner outcome is “covered but potentially stale”; fetch plan may be empty or limited to stale candidates.

### 8.2 Cohort retrieval horizon tests

**Files:**

- New tests alongside `fetchRefetchPolicy` integration tests.

**Scenarios (in words):**

- Explicit `cohort(-90d:)` where `path_t95` is much shorter:
  - Verify that the horizon helper bounds retrieval to something closer to `path_t95`, not the full 90 days.
  - Use graphs where earlier cohorts are already fully covered in the file, and assert that only a short tail is refetched.
- Cohorts where `path_t95` is longer than the requested range:
  - Verify no widening occurs; the original window is used.
- Mixed cases where some portions of the requested range are older than the horizon:
  - Ensure the bounded retrieval window still covers all cohorts that are expected to contribute materially.
- Non‑latency vs latency edges on the same path:
  - Construct a path `a→b→c→d` with:
    - Upstream edge with `legacy maturity field = 0` (non‑latency).
    - Middle edge with a moderate `t95` (for example, around 10 days).
    - Downstream edge with a shorter `t95`, so that `path_t95` grows along the path.
  - Pre‑populate cohort data so that:
    - Files contain a wider historical window (for example, `cohort(-100d:-10d)` or `cohort(-91d:-1d)`).
    - New queries request a slightly different range (for example, `cohort(-90d:)`).
  - Assert that the planner produces **distinct per‑edge fetch plans**, such as:
    - Non‑latency edges fetching only strictly missing cohorts inside the requested window.
    - Mid‑path latency edges fetching a short tail close to their own `t95` horizon.
    - Deepest latency edges using a longer tail derived from `path_t95`, but still never refetching the entire historical range when not warranted.
- Staleness vs immaturity:
  - Vary the retrieval timestamps so that:
    - In some cases, recent immature cohorts have never been refreshed since they were first fetched.
    - In others, cohorts that were once immature have now “aged past” the `t95` / `path_t95` horizon.
  - Verify that the planner:
    - Treats previously immature cohorts that are now well beyond the horizon as **covered and stable** (no repeated refresh pressure).
    - Treats genuinely recent or stale cohorts as **covered but potentially stale**, recommending a refresh for only the relevant horizon segment.
- Scenario where prior coverage stops just before a new query window (for example, files contain `cohort(-100d:-10d)` and the new query is `cohort(-9d:)`):
  - Verify that all edges correctly classify the entire requested window as “not covered”, and that the horizon helper does **not** shrink or widen the retrieval window when the requested range already lies wholly inside the `path_t95` band.
- Graphs with mixed latency configurations along a path (for example, non‑latency `a→b`, latency `b→c`, shorter‑latency `c→d`):
  - Verify that the planner produces **per‑edge** cohort retrieval windows: non‑latency edges refetch only the strictly missing cohorts, while latency edges bound their refetch windows by their own `path_t95`, even for the same global `cohort()` DSL.
- Scenarios where `t95` is undefined or zero for some edges:
  - Verify that the helper falls back to `legacy maturity field` or a conservative default and still produces sensible, per‑edge cohort windows without ever expanding the window beyond the user’s query.
- Cases where retrieval timestamps vary between edges:
  - Verify that edges with very recent retrievals treat cohorts near the horizon as “stable”, while edges with older retrievals treat the same cohorts as “covered but stale” and appear as refresh candidates in the planner result.


### 8.3 UI and hook tests

**Files:**

- Existing WindowSelector tests.
- New tests for any planner‑driven hooks or selectors.

**Behavioural assertions:**

- WindowSelector:
  - Calls the planner when DSL or window changes.
  - Shows “Fetch data” only when planner outcome is “not covered”.
  - Shows “Fetch latest” only when outcome is “covered but potentially stale”.
  - Leaves the button neutral and disabled when outcome is “covered and stable”.
- Hook integration:
  - `getItemsNeedingFetch` is only used as a plumbing detail under the planner, not directly by UI components.

### 8.4 Migration and guards

**Approach:**

- Initially, run the planner in parallel with the existing WindowSelector logic under a behind‑the‑scenes guard (for development and tests only).
  - Compare planner outcomes with legacy behaviour on a curated set of graphs.
  - Log discrepancies and use them to refine planner rules before fully cutting over.
- Once confidence is high:
  - Remove legacy coverage and staleness logic from WindowSelector and any other duplicate paths.
  - Keep planner as the single source of truth for fetch and refresh decisions.

**Exit criteria:** All relevant tests pass, legacy logic has been removed, and the only remaining coverage/maturity/staleness decision path is via the planner and its associated helpers.

---

## 9. Open Decisions

The following points require explicit resolution before or during implementation:

### 9.1 Exact staleness thresholds

- **Decision:** Reuse the existing pre‑fetch funnel staleness predicate as the single source of truth.
  - As of this plan, that predicate treats a covered slice as **stale** if `days_since_retrieval > 1` **and** the slice's cohort/window end date is within `t95` (or `path_t95` for cohorts) of today.
  - Cohorts and windows use the same rule, substituting `path_t95` for cohorts and edge-level `t95` for windows. The canonical definition of the inequality lives in the pre‑fetch funnel design; the planner and horizon helper call into that shared logic rather than redefining it.
- **Fallback:** When `t95` is missing or zero, use `legacy maturity field`; if that is also missing, treat the slice as **stable** (no refresh pressure).

### 9.2 Per-anchor `path_t95` computation

- **Decision:** Compute `path_t95` by a single dynamic‑programming pass per anchor, rather than ad‑hoc per‑edge walks.
  - Concretely, for each distinct `anchor_node_id` in the active scenario, traverse edges in topological order starting from that anchor, accumulating `t95` along each path so that, for any given edge, the resulting `path_t95` is exactly what you would get by “reaching upstream from the edge to its anchor and summing `t95` as you go”.
  - Each run yields `path_t95` values only for edges reachable from that anchor; edges not reachable from a given anchor are ignored for that anchor's horizon calculations.
- **Edges with no anchor:** Treat as non-latency for cohort horizon purposes (`path_t95 = 0`); they still use edge-level `t95` for staleness of their own slices.

### 9.3 Planner vs `shouldRefetch` ownership

- **Decision:** Make the planner and horizon helper the single source of truth for “fetch vs cache” and “which window to retrieve”, and reuse the existing refetch policy machinery inside that planner path rather than calling it independently from other code.
  - In practice, the planner calls into the existing refetch policy once per item to obtain the policy (`gaps_only`, `partial`, `replace_slice`, `use_cache`), then applies the horizon helper to bound any retrieval windows; UI components and execution code consume only the planner result and never call `shouldRefetch` directly.
- **Conflict resolution:** If the planner says "no fetch needed" but `shouldRefetch` on the same inputs would have said `replace_slice`, the planner wins (it has already incorporated staleness). This avoids double-checking and prevents competing code paths.

### 9.4 Baseline vs query window interaction

- **Decision:** `t95` is **only updated** when the baseline latency-detection window is fetched (Flow A in `design.md`). Ad-hoc user queries with narrower or shifted windows **read** existing `t95` but do not overwrite it.
- **`path_t95`:** Always recomputed per scenario/query from persisted `t95` values; not affected by the baseline vs query distinction.

### 9.5 Anchoring semantics in the horizon helper

- **Decision needed:** What happens when `latency.anchor_node_id` is missing, invalid, or not the graph's global start node?
  - Proposed:
    - Missing/invalid anchor: Treat edge as non-latency for cohort horizons (`path_t95 = 0`), but still use edge `t95` for staleness.
    - Mid-path anchors: The DP starts at the anchor node; edges upstream of the anchor are unreachable and therefore have no `path_t95` contribution from that anchor.
- **DSL date mapping:** Cohort DSL dates are always interpreted in the coordinate system of the edge's anchor. If different edges have different anchors, their horizon windows are computed independently.
  - In practice, such cases should be rare because topological changes cause a re-calculation of `a_anchors`, but the behaviour is defined here for completeness.

### 9.6 Test coverage for multi-anchor and what-if scenarios

- **Decision:** Treat multi-anchor and what-if scenarios as first-class test cases and add explicit, high-coverage tests for them, with creative variations on topology and scenario toggling, in addition to the scenarios listed in section 8.2.

---

## 10. Summary

This plan deliberately separates:

- **Data production** (t95, path_t95, completeness) from
- **Decision logic** (planner analysis, refetch policy, retrieval horizons) and
- **UI wiring** (WindowSelector and menus),

and routes them all through a single planner‑centric architecture. The key behavioural shift is that cohort and window retrieval are no longer driven solely by the DSL and simple header/daily coverage checks, but are **bounded and classified using `t95` and `path_t95`**, with clear, testable distinctions between "missing", "stale", and "stable" states.


