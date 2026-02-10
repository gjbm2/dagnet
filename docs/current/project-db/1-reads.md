# Snapshot DB Reads: Design Specification

**Status**: Phases 1–4.5 complete (9-Feb-26). Phase 5 (forecasting integration) and Phase 6 (additional analysis types) not started — blocked on `analysis-forecasting.md`.  
**Date**: 9-Feb-26 · 10-Feb-26 (status review)  
**Related**: `00-snapshot-db-design.md` §2, `hash-fixes.md`, `analysis-forecasting.md`

---

## 1. Problem Statement

The snapshot DB write path is working: data fetched from Amplitude is shadow-written to PostgreSQL via `appendSnapshots()`. The `asat()` DSL function provides point-in-time parameter reads.

The snapshot DB **read path for analysis** is not wired into the production UI. Specifically:

- `lag_histogram` and `daily_conversions` are registered as analysis types but have no invocation path from the AnalyticsPanel
- There is no mechanism to build snapshot dependency coordinates for analysis requests
- The backend analysis handler (`_handle_snapshot_analyze`) works but is never called
- There is no availability gating based on snapshot inventory

---

## 2. Design Principle

> **Frontend does ALL planning, signature computation, and hash derivation. Backend is told what to retrieve — it receives fully-formed DB keys and uses them directly.**

| Layer | Responsibility |
|-------|----------------|
| **Frontend** | DSL parsing, target enumeration, signature computation, `core_hash` derivation, slice resolution, MECE verification, date range extraction, building `snapshot_subjects` coordinates |
| **Backend** | DB query execution using frontend-provided coordinates, MECE aggregation (sum over slices), lag statistics aggregation from retrieved rows, analysis derivation (histogram, daily conversions, cohort maturity, etc.) |

The backend MUST NOT:
- Derive hashes from signatures (see `hash-fixes.md`)
- Infer which parameters are in scope
- Determine slice keys or MECE partitions
- Compute signatures or any transformation of frontend-provided identity values

---

## 3. Architecture

### 3.1 Request Flow

```
User triggers analysis (AnalyticsPanel)
    │
    ├─ Frontend: look up analysis type contract (snapshotContract on AnalysisTypeMeta)
    │    └─ Does this analysis require snapshot data? If not, use existing scenario path.
    │
    ├─ Frontend: enumerate parameter subjects in scope
    │    └─ Using scopeRule + graph + selection → list of EnumeratedFetchTarget
    │
    ├─ Frontend: for each subject, compute DB coordinates
    │    ├─ param_id (workspace-prefixed)
    │    ├─ canonical_signature (from parameter file)
    │    ├─ core_hash (frontend-computed, see hash-fixes.md)
    │    ├─ anchor_from / anchor_to (from DSL window/cohort clause)
    │    ├─ slice_keys (from DSL context + MECE resolution)
    │    └─ target.targetId (so backend can find authoritative t95 constraint from graph edge)
    │
    ├─ Frontend: for EACH scenario, derive effective DSL and build scenario-specific
    │    FetchPlan → snapshot_subjects (live scenarios have their own DSL)
    │
    ├─ Frontend: POST /api/runner/analyze
    │    Body: { analysis_type, query_dsl, scenarios: [{ ..., snapshot_subjects }, ...] }
    │    (snapshot_subjects are PER SCENARIO, not global)
    │
    └─ Backend: for each scenario's subjects, query DB using provided coordinates
         ├─ Uses core_hash directly (no derivation)
         ├─ Runs appropriate derivation function
         └─ Returns analysis result grouped by scenario
```

### 3.2 Single Trip

The frontend does all planning locally and sends a single POST. There is no separate inventory check, no pre-flight, no double trip. If snapshot data is missing for some subjects, the backend reports this in the response (per-subject status), and the frontend handles gracefully.

---

## 4. Subject Scope Rules

Each analysis type declares a `scopeRule` that determines which parameters are in scope.

| Rule | Description | Resolution |
|------|-------------|------------|
| `selection_edge` | Single selected edge → one parameter | `enumerateFetchTargets(graph).filter(t => t.targetId === selectedEdgeId && t.type === 'parameter')` |
| `selection_edges` | Multiple selected edges → set of parameters | Same filter, multiple edge IDs |
| `funnel_path` | From/to path → ordered set of edge parameters | Parse DSL to get from/to nodes, enumerate edges on the path between them |
| `reachable_from` | BFS from selected node → all reachable edge parameters | Graph traversal from selected node(s), collect all reachable edges, enumerate their parameters |
| `all_graph_parameters` | Every parameter in the graph | `enumerateFetchTargets(graph).filter(t => t.type === 'parameter')` |

All scope rules include conditional parameters (`edge.conditional_p[i].p`) as first-class subjects. The `enumerateFetchTargets()` function already handles this.

---

## 5. Read Modes

The read mode determines what shape of DB query is needed.

| Mode | What backend does | Use case |
|------|-------------------|----------|
| `raw_snapshots` | Returns all rows ordered by `(anchor_day, slice_key, retrieved_at)` | DeltaY derivation: lag histogram, daily conversions. Needs successive retrieval timestamps to compute deltas. |
| `virtual_snapshot` | Returns latest row per `(anchor_day, slice_key)` as-of a given `as_at` timestamp | Point-in-time views. "What did we know about this date range as of timestamp T?" |
| `cohort_maturity` | For a given anchor range, returns the virtual snapshot at each distinct retrieval boundary within a sweep range | Cohort maturity curves. "How did our view of October evolve as data arrived?" Shows how the cumulative picture built up over time. |

### 5.1 Cohort Maturity Mode (Detail)

This is the most important read mode for cohort visualisation. It answers: "for a given set of cohort days (anchor range), show me how the observed conversion rate changed over time as more data was retrieved."

**Frontend provides**:
- `anchor_from` / `anchor_to` — the cohort date range of interest
- `sweep_from` / `sweep_to` — the retrieval-time range to sweep over (e.g. "from 1-Oct to today")
- `core_hash`, `param_id`, `slice_keys` — standard DB coordinates

**Backend executes**:
- Query all raw snapshots in the anchor range with `retrieved_at` between `sweep_from` and `sweep_to`
- Group by `retrieved_at` date (or by distinct retrieval timestamps)
- At each retrieval point, compute the virtual snapshot (latest per anchor_day as-of that timestamp)
- Return a time series of virtual snapshots, each representing "what we knew at time T"

This produces the data needed to draw:
- **Maturity curve**: line chart where X-axis is retrieval date, Y-axis is cumulative conversion rate
- **Solid/dashed split**: mature section (completeness >= threshold) as solid, immature as dashed
- **Fan chart extensions** (future): project the immature section forward using the lognormal model

The sweep is over a **date range**, not specific dates. The backend determines the natural boundaries (distinct `retrieved_at` dates in the data).

---

## 6. Time Dimension Modes

| Mode | `anchor_from/to` | `as_at` | `sweep_from/to` | Use case |
|------|------------------|---------|-----------------|----------|
| Range, latest | Yes | None | None | "Daily conversions for October" using all available data |
| Range, as-at | Yes | Single timestamp | None | "What did we know about October as of 15-Nov?" |
| Cohort maturity | Yes | None | Yes | "How did our view of October evolve over time?" |

---

## 7. Analysis Type Contract

Each analysis type declares its snapshot requirements via a `snapshotContract` field on the existing `AnalysisTypeMeta` in `analysisTypes.ts`.

```typescript
// Added to existing AnalysisTypeMeta in analysisTypes.ts

interface SnapshotContract {
  /** Which parameters are in scope */
  scopeRule: 'selection_edge' | 'selection_edges' | 'funnel_path'
           | 'reachable_from' | 'all_graph_parameters';

  /** What DB query shape is needed */
  readMode: 'raw_snapshots' | 'virtual_snapshot' | 'cohort_maturity';

  /** How slices are resolved for each subject */
  slicePolicy: 'explicit' | 'mece_fulfilment_allowed';

  /** How anchor_from/to are derived */
  timeBoundsSource: 'query_dsl_window' | 'analysis_arguments';

  /** Whether per_scenario separation is needed (NOTE: snapshot_subjects are always
      per-scenario at the wire level; this flag controls whether the *analysis type*
      semantically requires scenario-specific results vs a single aggregated result) */
  perScenario: boolean;
}

// Example: extend existing AnalysisTypeMeta
interface AnalysisTypeMeta {
  id: string;
  name: string;
  shortDescription: string;
  selectionHint: string;
  icon: any;
  snapshotContract?: SnapshotContract; // undefined = no snapshot deps (standard graph analysis)
}
```

### 7.1 Concrete Contracts for Implemented Analysis Types

| Analysis type | scopeRule | readMode | slicePolicy | timeBoundsSource | perScenario | Status |
|---|---|---|---|---|---|---|
| `lag_histogram` | `funnel_path` | `raw_snapshots` | `mece_fulfilment_allowed` | `query_dsl_window` | false | DONE |
| `daily_conversions` | `funnel_path` | `raw_snapshots` | `mece_fulfilment_allowed` | `query_dsl_window` | false | DONE |
| `cohort_maturity` | `funnel_path` | `cohort_maturity` | `mece_fulfilment_allowed` | `query_dsl_window` | false | DONE |

### 7.2 Outstanding Analysis Types (Not Yet Implemented)

| Analysis type | scopeRule | readMode | slicePolicy | timeBoundsSource | perScenario | Notes |
|---|---|---|---|---|---|---|
| `funnel_time_series` | `funnel_path` | `cohort_maturity` | `mece_fulfilment_allowed` | `query_dsl_window` | true | Multi-edge time series along a path; requires multi-subject charting |
| `context_comparison` | `funnel_path` | `raw_snapshots` | `explicit` | `query_dsl_window` | false | Compare conversion rates across different context slices for the same edge |
| `cohort_completeness` | `selection_edge` | `cohort_maturity` | `mece_fulfilment_allowed` | `query_dsl_window` | false | Requires forecasting machinery (Phase 5) — annotates each cohort with estimated completeness |

These types require either additional backend derivation functions, forecasting support (see §7.3), or multi-subject charting in the frontend.

### 7.3 Forecasting Dependency

Several planned analysis features cannot be meaningfully delivered without the forecasting machinery described in `analysis-forecasting.md`. Without forecasting:

- **Cohort maturity** shows raw observed rates but cannot indicate which cohorts are immature or project their final values
- **Evidence/forecast split** is impossible — all data appears as "evidence" even when cohorts are clearly incomplete
- **Fan charts** and confidence bands require lognormal model projection
- **Completeness overlay** (solid vs dashed rendering) has no completeness signal to drive it

**Current state**: the read pipeline (Phases 1–4) correctly retrieves and charts snapshot data. But the data is presented without statistical context — the user cannot distinguish mature from immature cohorts, and projections are not available.

**Next step**: implement `analysis-forecasting.md` §7 (Python modelling library, model persistence, recompute API) to unlock Phase 5 of this document.

---

## 8. Request Payload Shape

### 8.1 Snapshot Subject Request (what the frontend emits per subject)

```typescript
interface SnapshotSubjectRequest {
  // === Identity (frontend-computed, backend uses directly) ===

  /** Stable ID for joining results back to analysis scope */
  subject_id: string;  // buildItemKey({type, objectId, targetId, slot, conditionalIndex})

  /** Human-readable label for display (e.g. "registration → success").
   *  Derived from the graph edge's from/to node IDs. Never contains UUIDs. */
  subject_label?: string;

  /** Workspace-prefixed DB parameter identity */
  param_id: string;  // `${repo}-${branch}-${objectId}`

  /** Full canonical signature (for audit/registry) */
  canonical_signature: string;

  /** Frontend-computed DB lookup key (see hash-fixes.md) */
  core_hash: string;

  // === Read intent ===

  read_mode: 'raw_snapshots' | 'virtual_snapshot' | 'cohort_maturity';

  // === Time bounds ===

  /** Anchor day range (ISO dates) */
  anchor_from: string;
  anchor_to: string;

  /** Point-in-time cut-off (ISO datetime; only for virtual_snapshot mode) */
  as_at?: string;

  /** Sweep range for cohort maturity mode (ISO dates) */
  sweep_from?: string;
  sweep_to?: string;

  // === Slice semantics ===

  /** Slice keys: MECE union → N keys; uncontexted → [''] */
  slice_keys: string[];

  // === Provenance (used for logging AND for graph lookups) ===

  target: {
    targetId: string;  // edge UUID — backend uses this to find edge in scenario graph
    slot?: 'p' | 'cost_gbp' | 'labour_cost';
    conditionalIndex?: number;
  };
}
```

### 8.2 Analysis Request (extended)

```typescript
interface ScenarioData {
  scenario_id: string;
  name?: string;
  colour?: string;
  visibility_mode?: 'f+e' | 'f' | 'e';
  graph: any;
  param_overrides?: Record<string, any>;

  // Per-scenario snapshot DB coordinates (only for analysis types with snapshotContract)
  snapshot_subjects?: SnapshotSubjectRequest[];
}

interface RunnerAnalyzeRequest {
  analysis_type: string;
  query_dsl?: string;
  scenarios: ScenarioData[];
}
```

**Per-scenario architecture**: `snapshot_subjects` is carried on each `ScenarioData`, not at the top level. Each scenario (especially live scenarios) can have a different effective DSL and thus different snapshot subjects. The frontend builds a `FetchPlan` per scenario using that scenario's effective DSL (`meta.lastEffectiveDSL` for live scenarios, `queryDSL` for the current layer), then maps each plan to `SnapshotSubjectRequest[]`. Scenarios without snapshot data (e.g. non-live scenarios or analyses that don't need snapshots) simply omit `snapshot_subjects`.

**Forecasting metadata**: The snapshot DB rows each carry per-anchor-day `median_lag_days`, `mean_lag_days`, and `onset_delta_days`. The backend aggregates these from the retrieved rows to fit the lognormal model. The graph edge's `edge.p.latency.t95` (located via `target.targetId`) is used as an **authoritative constraint** on the fit (one-way: can only widen sigma, never narrow). Note: `edge.p.latency.median_lag_days` and `edge.p.latency.mean_lag_days` are **display outputs** from the frontend's last enhancement pass, not primary fitting inputs — the backend computes aggregates from the actual snapshot data being analysed.

---

## 9. Resolver Algorithm

The resolver is `snapshotDependencyPlanService.ts` — a thin mapper over the existing `FetchPlan`.

The resolver runs **once per scenario**. For multi-scenario requests, the `AnalyticsPanel` iterates over visible scenarios and calls the resolver for each, using that scenario's effective DSL.

**Inputs (per scenario)**:
- `analysis_type` (to look up the contract)
- scenario graph (the composed graph for this scenario)
- effective DSL for this scenario (`meta.lastEffectiveDSL` for live scenarios, panel `queryDSL` for current layer)
- selection (selectedEdgeUuids, selectedNodeUuids)
- workspace (repo, branch)

**Algorithm**:

1. **Look up contract** from `analysisTypes.ts` by `analysis_type`. If no `snapshotContract`: return `undefined` (standard graph analysis).

2. **Enumerate parameter subjects** using `enumerateFetchTargets(graph)`. Filter to `type === 'parameter'`.

3. **Apply scope rule**:
   - `selection_edge`: keep subjects whose `targetId` matches the selected edge
   - `selection_edges`: keep subjects whose `targetId` is in selected edges set
   - `funnel_path`: parse DSL to identify from/to, traverse graph to find path edges, keep those subjects
   - `reachable_from`: BFS from selected nodes, collect reachable edges, keep those subjects
   - `all_graph_parameters`: keep all

4. **Derive time bounds** from DSL:
   - Parse `query_dsl` to extract window/cohort range
   - For `cohort_maturity` mode: set `sweep_from` = `anchor_from`, `sweep_to` = today (or as specified)
   - Convert UK dates to ISO at the API boundary

5. **Resolve slice keys** for each subject:d
   - Read the parameter file's persisted values
   - If `slicePolicy === 'explicit'`: use DSL context constraints to determine slice key, or `['']`
   - If `slicePolicy === 'mece_fulfilment_allowed'`: use `resolveMECEPartitionForImplicitUncontextedSync()` to find MECE partition keys when the semantic series is uncontexted

6. **Compute identity** for each subject:
   - `param_id`: `${repo}-${branch}-${objectId}`
   - `canonical_signature`: read from parameter file's persisted values (most recent `query_signature`)
   - `core_hash`: compute via `computeShortCoreHash(canonical_signature)` — **frontend-computed** (see `hash-fixes.md`)
   - `subject_id`: `buildItemKey({type, objectId, targetId, slot, conditionalIndex})`
   - `subject_label`: look up the edge by `targetId` UUID in the graph, resolve from/to node IDs, format as `"from → to"` (e.g. `"registration → success"`). Never contains UUIDs.

7. **Emit** `SnapshotSubjectRequest[]`.

Note: lag fit metadata is NOT included in the subject request. The backend derives lag statistics from the **snapshot rows it retrieves** (each row has `median_lag_days`, `mean_lag_days`, `onset_delta_days`). The graph edge (located via `target.targetId`) provides only the **authoritative `t95` constraint** (if set). The `edge.p.latency.median_lag_days`/`mean_lag_days` on the graph are display outputs from the frontend, not fitting inputs.

---

## 10. Backend Execution

### 10.1 Handler Changes

`_handle_snapshot_analyze_subjects` in `api_handlers.py` processes `snapshot_subjects` **per scenario**:

```python
def _handle_snapshot_analyze_subjects(data: Dict[str, Any]) -> Dict[str, Any]:
    analysis_type = data.get('analysis_type')

    for scenario in data['scenarios']:
        subjects = scenario.get('snapshot_subjects', [])
        if not subjects:
            continue  # no snapshot work for this scenario

        for subject in subjects:
            # query DB using frontend-provided coordinates
            rows = query_snapshots(
                param_id=subject['param_id'],
                core_hash=subject['core_hash'],  # frontend-computed, used directly
                slice_keys=subject.get('slice_keys', ['']),
                anchor_from=date.fromisoformat(subject['anchor_from']),
                anchor_to=date.fromisoformat(subject['anchor_to']),
                as_at=parse_as_at(subject.get('as_at')),
            )
            # route to appropriate derivation per subject ...

    # return results grouped by scenario
```

The response groups results by scenario. Single-scenario / single-subject cases are flattened for backward compatibility.

### 10.2 Cohort Maturity Execution

For `cohort_maturity` read mode, the backend:

1. Queries all raw snapshots in `[anchor_from, anchor_to]` with `retrieved_at` in `[sweep_from, sweep_to]`
2. Identifies distinct retrieval dates (or uses a reasonable binning if there are many)
3. At each retrieval boundary, computes virtual snapshot (latest per anchor_day as-of that timestamp)
4. Returns a series of `{as_at_date, data_points: [{anchor_day, x, y, ...}]}` frames

When forecasting is enabled (Phase 5), the backend fits the lognormal model from the snapshot rows' own `median_lag_days` and `mean_lag_days` (aggregated across anchor_days), constrained by `edge.p.latency.t95` from the scenario graph (located via `target.targetId`). Each frame's data points are then annotated with `completeness` (from CDF evaluation using cohort age at that retrieval date).

### 10.3 Compute Caching Opportunities

With per-scenario snapshot subjects, multiple scenarios may request overlapping data from the snapshot DB — for example, two live scenarios that cover the same edge parameter but with overlapping (or identical) anchor ranges. Several caching opportunities exist:

| Layer | Opportunity | Status |
|-------|-------------|--------|
| **Backend: DB query deduplication** | When processing a multi-scenario request, the backend could build a set of unique `(param_id, core_hash, anchor_from, anchor_to, sweep_from, sweep_to)` tuples across all scenarios' subjects. Identical tuples need only be queried once, with results shared across scenarios. This is pure request-level deduplication (no persistent cache). | NOT YET IMPLEMENTED — straightforward optimisation when needed |
| **Backend: LRU row cache** | A short-lived (per-request or TTL-based) cache keyed by `(param_id, core_hash, anchor_range, sweep_range)` avoiding duplicate DB round-trips within a single request. Useful when many scenarios share the same parameter but differ only in graph overrides (same raw data, different derivation context). | NOT YET IMPLEMENTED — evaluate if multi-scenario analysis becomes slow |
| **Frontend: FetchPlan deduplication** | When building per-scenario FetchPlans, the frontend could detect scenarios whose effective DSL produces identical `(querySignature, sliceFamily)` tuples and share snapshot subjects rather than mapping each independently. The `computeShortCoreHash` call is the primary per-item cost. | NOT YET IMPLEMENTED — evaluate if per-scenario planning becomes a bottleneck |
| **Frontend: GraphComputeClient cache** | The existing `analysisCache` in `graphComputeClient.ts` already caches analysis responses keyed by scenario graph signatures. This cache continues to work — if graphs and DSLs haven't changed, the cached response is reused and no snapshot resolution runs. | ALREADY IMPLEMENTED |

**Recommendation**: The most impactful optimisation is backend DB query deduplication (first row), since the DB query is the slowest step. This should be implemented when multi-scenario cohort maturity analysis is tested with real data and latency is measured.

---

## 11. Availability Gating

Availability is determined by the frontend checking whether snapshot data exists for the required subjects. This uses the existing batch inventory endpoint (`/api/snapshots/batch-inventory-v2`).

**Gating logic** (in the frontend, when building the available analyses list):

1. For each analysis type with a `snapshotContract`:
   - Run the resolver to enumerate subjects (cheap, no IO)
   - Check batch inventory for all `param_id`s
   - If sufficient coverage: analysis is available
   - If insufficient: analysis is disabled with a reason ("no snapshot history for 3/5 parameters")

2. This is a soft gate: the analysis can still be triggered manually (with a warning), and the backend reports per-subject status in the response.

---

## 12. MECE Union as First-Class Series

When the analysis scope refers to an uncontexted semantic series but the DB only has contexted slice rows, the frontend provides:

- A list of slice keys representing the MECE partition (e.g. `['context(channel:google)', 'context(channel:facebook)', 'context(channel:organic)']`)
- A stable `subject_id` that represents the semantic series (not a specific slice key)

The backend sums across the provided slice keys per anchor_day. It does not need to know or infer which slices form a MECE partition — it just aggregates what it's told.

---

## 13. File Changes Summary

| File | Change | Phase |
|------|--------|-------|
| `analysisTypes.ts` | Add `snapshotContract` field to `AnalysisTypeMeta`; populate for `lag_histogram`, `daily_conversions`, `cohort_maturity` | 1–2 |
| `snapshotDependencyPlanService.ts` (NEW) | Thin mapper: `FetchPlan` → `SnapshotSubjectRequest[]` (scope filtering + `core_hash` + `read_mode` + `subject_label`). Reuses existing planner. Also exports graph traversal helpers. | 1 |
| `coreHashService.ts` (NEW) | Frontend `computeShortCoreHash()` (see `hash-fixes.md`) | 1 |
| `AnalyticsPanel.tsx` | When analysis type has `snapshotContract`, build `FetchPlan` **per scenario** (using each scenario's effective DSL), map to `snapshot_subjects`, include in each scenario entry. Edge selection populates `from(a).to(b)` DSL. | 1, 4.5 |
| `graphComputeClient.ts` | `snapshot_subjects` is per-scenario on `ScenarioData`, not top-level on `AnalysisRequest`. `SnapshotSubjectPayload` carries `subject_label`. `normaliseSnapshotCohortMaturityResponse` uses `subject_label` for chart dimension display names with `humaniseSubjectId()` fallback. | 1, 4.5 |
| `snapshotWriteService.ts` | Update all API calls to send frontend-computed `core_hash` (see `hash-fixes.md`) | 1 |
| `api_handlers.py` | `_handle_snapshot_analyze_subjects` processes per-scenario `snapshot_subjects`; use frontend `core_hash` directly | 1 |
| `snapshot_service.py` | Accept `core_hash` as parameter (not derived); add cohort maturity query function | 1–2 |
| `histogram_derivation.py` | Accept `t95_constraints` parameter (unused in Phase 1) | 1 |
| `daily_conversions_derivation.py` | Accept `t95_constraints` parameter (unused in Phase 1) | 1 |
| `cohort_maturity_derivation.py` (NEW) | Cohort maturity sweep derivation (virtual snapshot per retrieval date) | 2 |
| `query_snapshots_for_sweep` in `snapshot_service.py` | Date-range filter on `retrieved_at` for sweep queries | 2 |
| `test_cohort_maturity_derivation.py` (NEW) | 10 Python tests covering the derivation algorithm | 2 |

---

## 14. Implementation Phases

### Phase 1: Hash Fix + Basic Plumbing — DONE

**Goal**: Frontend computes all hashes. Basic `lag_histogram` and `daily_conversions` work end-to-end via the new `snapshot_subjects` path.

**Tasks**:
1. ~~Implement `coreHashService.ts` with golden cross-language tests (`hash-fixes.md` Steps 1-2)~~ — DONE
2. ~~Update frontend API calls to send `core_hash` (`hash-fixes.md` Steps 3-4)~~ — DONE
3. ~~Define `SnapshotContract` type and add to `lag_histogram` / `daily_conversions` in `analysisTypes.ts`~~ — DONE
4. ~~Create `snapshotDependencyPlanService.ts` — thin mapper over existing `FetchPlan` (NOT a parallel planner)~~ — DONE (refactored: calls `buildFetchPlanProduction` then maps `FetchPlanItem[]` → `SnapshotSubjectRequest[]`)
5. ~~Wire `AnalyticsPanel.tsx` to build a FetchPlan via the existing planner, then map to snapshot subjects~~ — DONE
6. ~~Update `_handle_snapshot_analyze` to accept `snapshot_subjects`~~ — DONE (renamed to `_handle_snapshot_analyze_subjects`; legacy `_handle_snapshot_analyze_legacy` preserved)
7. ~~Remove backend hash derivation from production paths (`hash-fixes.md` Step 5)~~ — DONE
8. ~~Per-scenario snapshot subjects: move `snapshot_subjects` from top-level `AnalysisRequest` to per-`ScenarioData`~~ — DONE (live scenarios use `meta.lastEffectiveDSL` for their own FetchPlan; backend processes each scenario's subjects independently)

### Phase 2: Cohort Maturity — DONE (backend + plumbing; charting is Phase 5 / `2-time-series-charting.md`)

**Goal**: The `cohort_maturity` read mode works. Backend can produce a time series of virtual snapshots showing how a cohort's observed conversion rate evolved.

**Tasks**:
1. ~~Add `cohort_maturity` as a new analysis type with its contract~~ — DONE
2. ~~Implement cohort maturity sweep query on backend (`query_snapshots_for_sweep`)~~ — DONE
3. ~~Implement `cohort_maturity_derivation.py`~~ — DONE (with 10 Python tests)
4. ~~Wire backend handler to route `cohort_maturity` via sweep query + derivation~~ — DONE
5. Frontend chart component for maturity curves (solid/dashed by maturity) — deferred to `2-time-series-charting.md`

### Phase 3: Multi-Subject Scope Rules — DONE

**Goal**: `funnel_path`, `reachable_from`, and `all_graph_parameters` scope rules work.

**Tasks**:
1. ~~Implement funnel path resolution (DSL from/to → edge traversal)~~ — DONE (forward+backward BFS intersection)
2. ~~Implement BFS reachable-from resolution~~ — DONE (BFS from edge start nodes)
3. ~~Implement all-graph-parameters scope~~ — DONE (was trivially implemented in Phase 1)
4. ~~Backend handles multiple subjects in a single request, returns per-subject results~~ — DONE (was implemented in Phase 1)
5. Frontend aggregates/displays multi-subject results — deferred (no UI consumer yet; will be used when `funnel_time_series` analysis type is added)

### Phase 4: MECE Slice Resolution + Conditional Parameters — DONE (implicit)

**Goal**: Uncontexted semantic series fulfilled by MECE partition slices. Conditional parameters are first-class.

**Resolution**: These are already handled by the existing fetch planner. Since `snapshotDependencyPlanService` was refactored (Phase 1 fix) to be a thin mapper over `FetchPlan`, all MECE slice resolution, conditional parameter enumeration, and signature computation are inherited from the planner's existing, tested code paths. No separate implementation needed.

- `FetchPlanItem.sliceFamily` already carries the resolved slice key (MECE or uncontexted)
- `FetchPlanItem.conditionalIndex` already enumerates conditional parameters
- `FetchPlanItem.querySignature` already carries the execution-grade signature

### Phase 4.5: Edge Selection DSL + Subject Labels — DONE (9-Feb-26)

**Goal**: Selecting an edge on the graph canvas auto-populates the Analytics panel's query DSL with `from(a).to(b)`. Chart headers display human-readable edge labels instead of internal IDs/UUIDs.

**Tasks**:
1. ~~AnalyticsPanel tracks `selectedEdgeUuids` alongside `selectedNodeIds`~~ — DONE
2. ~~`autoGeneratedDSL` produces `from(A).to(B)` when a single edge is selected (no nodes)~~ — DONE
3. ~~`SnapshotSubjectRequest` and `SnapshotSubjectPayload` carry `subject_label` (human-readable, e.g. "registration → success")~~ — DONE
4. ~~`snapshotDependencyPlanService` resolves edge UUID → from/to node IDs from graph to derive `subject_label`~~ — DONE
5. ~~`normaliseSnapshotCohortMaturityResponse` uses `subject_label` for chart dimension display names~~ — DONE
6. ~~Fallback `humaniseSubjectId()` extracts readable slug from itemKey format when label is missing~~ — DONE

### Phase 5: Forecasting Integration — NOT YET STARTED

**Goal**: Backend can annotate results with completeness estimates and projections. This is the critical missing piece that makes snapshot analysis actually useful for decision-making.

**Prerequisite**: `analysis-forecasting.md` §6–7 (port pure maths to Python, model persistence, recompute API)

**Tasks**:
1. Port `lagDistributionUtils.ts` to Python with golden tests
2. Share latency constants via YAML
3. Backend aggregates lag stats from snapshot rows (`median_lag_days`, `mean_lag_days` per row) and fits lognormal model
4. Backend reads authoritative `t95` constraint from graph edge (`edge.p.latency.t95`) via `target.targetId` — used as one-way sigma constraint only
5. Backend derivation functions use fitted model for completeness annotation per anchor_day
6. Cohort maturity results include `completeness` and `projected` fields
7. Frontend charts render evidence/forecast distinction (solid vs dashed/striped bars)
8. Add `cohort_completeness` analysis type (depends on forecasting output)

### Phase 6: Additional Analysis Types — NOT YET STARTED

**Goal**: Broader coverage of snapshot-powered analysis beyond the initial three types.

**Tasks**:
1. `funnel_time_series`: multi-edge time series along a from/to path, per scenario — requires multi-subject charting
2. `context_comparison`: compare conversion rates across context slices for same edge — requires explicit slice enumeration
3. Frontend multi-subject chart rendering (currently only single-subject selector exists)

---

## 15. Testing Strategy

### Unit Tests

- `snapshotDependencyPlanService.test.ts`: Given (FetchPlan + analysis_type + DSL + selection), maps to correct `SnapshotSubjectRequest[]` — tests the thin mapper, NOT the planner
- `coreHashService.test.ts`: Frontend `computeShortCoreHash` matches golden fixtures
- Scope rule tests: `resolveFunnelPathEdges` and `resolveReachableEdges` tested with graph topologies (BFS, diamond, disconnected)
- Planner tests (existing): `fetchPlanBuilderService` tests cover target enumeration, MECE slice resolution, signature computation, staleness — all reused by the snapshot mapper

### Integration Tests

- Extend existing `cohortAxy.meceSum.vsAmplitude.local.e2e.test.ts` to verify the full pipeline:
  - Frontend builds `snapshot_subjects` with correct coordinates
  - Backend queries DB using frontend-provided `core_hash` (no derivation)
  - Derivation produces correct results
  - MECE aggregation is correct (no double counting)

### Cross-Language Parity Tests

- `core-hash-golden.json`: shared fixture for `computeShortCoreHash` parity
- `lag-distribution-golden.json` (Phase 5): shared fixture for statistical function parity

### Live Share Mode Testing

The full snapshot read pipeline must be verified in **live share mode** (read-only shared links served from Vercel). This is a distinct deployment context with different constraints:

- **Backend routing**: Vercel serverless functions handle `/api/*` routes. Snapshot DB queries (`/api/snapshots/*`, `/api/runner/analyze`) must work from the Vercel deployment, not just local dev.
- **DB connectivity**: The Vercel serverless backend must reach the snapshot PostgreSQL instance. Connection pooling, timeouts, and cold-start latency may differ from local dev.
- **Auth / CORS**: Shared links are unauthenticated and served from a different origin. Snapshot API calls must not be blocked by CORS or auth gates.
- **Graph + workspace context**: In share mode, the graph is embedded in the shared payload (no git workspace). The frontend must still build valid `snapshot_subjects` (including `param_id`, `core_hash`, `slice_keys`) from the embedded graph. Workspace identity (`repository`/`branch`) must be available in the share payload.
- **Edge selection → DSL**: Verify that `from(a).to(b)` DSL auto-population works when an edge is selected in the shared graph viewer.
- **Chart rendering**: Cohort maturity charts, lag histograms, and daily conversions must render correctly with human-readable `subject_label` (not raw IDs/UUIDs).
- **Error handling**: If DB is unreachable or snapshot data is missing, the UI must degrade gracefully (clear error messages, no blank panels).

**Test plan**:
1. Create a live share link for a graph with snapshot data
2. Open the share link in a clean browser session (no local state)
3. Select an edge → verify `from(a).to(b)` populates the analytics DSL
4. Run each snapshot analysis type (`lag_histogram`, `daily_conversions`, `cohort_maturity`) → verify results render with human-readable labels
5. Verify multi-scenario analysis works if the share includes scenario state
6. Test with a graph that has no snapshot data → verify graceful error messaging

---

## 16. Risk Assessment

| Risk | Mitigation |
|------|------------|
| Hash parity (TS vs Python) | Golden test suite; run before any migration |
| Signature not available in parameter file | Resolver skips subjects without signatures; backend reports per-subject status |
| MECE slice enumeration differs from write-time | Same MECE resolution code used by both paths; explicit tests |
| Conditional parameters missed | `enumerateFetchTargets` already includes them; add explicit tests |
| Cohort maturity query is slow (many rows) | Date-bounded sweep range limits data volume; potential for query optimisation (materialised view) if needed |
| Multi-scenario DB query duplication | Multiple scenarios may query same `(param_id, core_hash)` with overlapping ranges; see §10.3 for caching opportunities |
| Forecasting model changes | Deferred to Phase 5; golden tests ensure TS/Python parity |
| Live share mode untested | Snapshot DB queries, workspace identity resolution, and chart rendering have not been verified in Vercel-served share links; must be tested end-to-end before relying on shared analysis views |

---

## 17. Acceptance Criteria

1. Frontend computes ALL hashes (`core_hash`); backend uses them directly (no derivation)
2. `lag_histogram` and `daily_conversions` work end-to-end via `snapshot_subjects`
3. The request shape supports multi-subject, multi-slice, and includes optional forecasting metadata
4. Cohort maturity mode produces a time series of virtual snapshots over a sweep range
5. MECE union is supported: multiple `slice_keys` per subject, backend aggregates
6. Conditional parameters are first-class in subject enumeration
7. Availability gating based on batch inventory for all subjects in scope
8. Multi-scenario analysis: each scenario carries its own `snapshot_subjects` derived from its effective DSL; live scenarios use `meta.lastEffectiveDSL`

---

## 18. Related Documents

- `hash-fixes.md` — Critical fix: frontend must be sole producer of all hashes
- `analysis-forecasting.md` — Statistics on the backend (deferred, but anticipated in request shape)
- `00-snapshot-db-design.md` — Full DB design spec
- `3-asat.md` — As-at feature design
- `2-time-series-charting.md` — Phase 5 charting requirements
