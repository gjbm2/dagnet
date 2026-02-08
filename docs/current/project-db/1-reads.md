# Snapshot DB Reads: Design Specification

**Status**: Draft (revised 8-Feb-26)  
**Date**: 8-Feb-26  
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
    ├─ Frontend: POST /api/runner/analyze
    │    Body: { analysis_type, query_dsl, scenarios, snapshot_subjects }
    │
    └─ Backend: for each subject, query DB using provided coordinates
         ├─ Uses core_hash directly (no derivation)
         ├─ Runs appropriate derivation function
         └─ Returns analysis result
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

  /** Whether per_scenario separation is needed */
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

### 7.1 Concrete Contracts for Initial Analysis Types

| Analysis type | scopeRule | readMode | slicePolicy | timeBoundsSource | perScenario |
|---|---|---|---|---|---|
| `lag_histogram` | `selection_edge` | `raw_snapshots` | `mece_fulfilment_allowed` | `query_dsl_window` | false |
| `daily_conversions` | `selection_edge` | `raw_snapshots` | `mece_fulfilment_allowed` | `query_dsl_window` | false |
| `cohort_maturity` (new) | `selection_edge` | `cohort_maturity` | `mece_fulfilment_allowed` | `query_dsl_window` | false |
| `funnel_time_series` (future) | `funnel_path` | `cohort_maturity` | `mece_fulfilment_allowed` | `query_dsl_window` | true |

---

## 8. Request Payload Shape

### 8.1 Snapshot Subject Request (what the frontend emits per subject)

```typescript
interface SnapshotSubjectRequest {
  // === Identity (frontend-computed, backend uses directly) ===

  /** Stable ID for joining results back to analysis scope */
  subject_id: string;  // buildItemKey({type, objectId, targetId, slot, conditionalIndex})

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
interface RunnerAnalyzeRequest {
  analysis_type: string;
  query_dsl?: string;

  // Existing: scenario graphs for graph-based analyses
  scenarios?: ScenarioData[];

  // NEW: snapshot subjects for DB-backed analyses
  snapshot_subjects?: SnapshotSubjectRequest[];
}
```

Note: `snapshot_subjects` is a flat list, not grouped by scenario. For `perScenario: true` analysis types, the `subject_id` includes the scenario context and the frontend emits subjects per scenario. The backend does not need to understand scenario grouping — it just queries each subject it's given.

**Forecasting metadata**: The snapshot DB rows each carry per-anchor-day `median_lag_days`, `mean_lag_days`, and `onset_delta_days`. The backend aggregates these from the retrieved rows to fit the lognormal model. The graph edge's `edge.p.latency.t95` (located via `target.targetId`) is used as an **authoritative constraint** on the fit (one-way: can only widen sigma, never narrow). Note: `edge.p.latency.median_lag_days` and `edge.p.latency.mean_lag_days` are **display outputs** from the frontend's last enhancement pass, not primary fitting inputs — the backend computes aggregates from the actual snapshot data being analysed.

---

## 9. Resolver Algorithm

The resolver is a new frontend service: `snapshotDependencyPlanService.ts`.

**Inputs**:
- `analysis_type` (to look up the contract)
- scenario graph(s)
- `query_dsl`
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

5. **Resolve slice keys** for each subject:
   - Read the parameter file's persisted values
   - If `slicePolicy === 'explicit'`: use DSL context constraints to determine slice key, or `['']`
   - If `slicePolicy === 'mece_fulfilment_allowed'`: use `resolveMECEPartitionForImplicitUncontextedSync()` to find MECE partition keys when the semantic series is uncontexted

6. **Compute identity** for each subject:
   - `param_id`: `${repo}-${branch}-${objectId}`
   - `canonical_signature`: read from parameter file's persisted values (most recent `query_signature`)
   - `core_hash`: compute via `computeShortCoreHash(canonical_signature)` — **frontend-computed** (see `hash-fixes.md`)
   - `subject_id`: `buildItemKey({type, objectId, targetId, slot, conditionalIndex})`

7. **Emit** `SnapshotSubjectRequest[]`.

Note: lag fit metadata is NOT included in the subject request. The backend derives lag statistics from the **snapshot rows it retrieves** (each row has `median_lag_days`, `mean_lag_days`, `onset_delta_days`). The graph edge (located via `target.targetId`) provides only the **authoritative `t95` constraint** (if set). The `edge.p.latency.median_lag_days`/`mean_lag_days` on the graph are display outputs from the frontend, not fitting inputs.

---

## 10. Backend Execution

### 10.1 Handler Changes

`_handle_snapshot_analyze` in `api_handlers.py` is extended to accept `snapshot_subjects`:

```python
def _handle_snapshot_analyze(data: Dict[str, Any]) -> Dict[str, Any]:
    analysis_type = data.get('analysis_type')
    subjects = data.get('snapshot_subjects', [])

    # For each subject, query DB using frontend-provided coordinates
    all_rows_by_subject = {}
    for subject in subjects:
        rows = query_snapshots(
            param_id=subject['param_id'],
            core_hash=subject['core_hash'],  # frontend-computed, used directly
            slice_keys=subject.get('slice_keys', ['']),
            anchor_from=date.fromisoformat(subject['anchor_from']),
            anchor_to=date.fromisoformat(subject['anchor_to']),
            as_at=parse_as_at(subject.get('as_at')),
        )
        all_rows_by_subject[subject['subject_id']] = rows

    # Route to appropriate derivation
    if analysis_type == 'lag_histogram':
        result = derive_lag_histogram(all_rows_by_subject, t95_constraints=extract_t95_constraints(subjects, scenarios))
    elif analysis_type == 'daily_conversions':
        result = derive_daily_conversions(all_rows_by_subject, t95_constraints=extract_t95_constraints(subjects, scenarios))
    elif analysis_type == 'cohort_maturity':
        result = derive_cohort_maturity(all_rows_by_subject, subjects, t95_constraints=extract_t95_constraints(subjects, scenarios))
    # ... etc

    return result
```

### 10.2 Cohort Maturity Execution

For `cohort_maturity` read mode, the backend:

1. Queries all raw snapshots in `[anchor_from, anchor_to]` with `retrieved_at` in `[sweep_from, sweep_to]`
2. Identifies distinct retrieval dates (or uses a reasonable binning if there are many)
3. At each retrieval boundary, computes virtual snapshot (latest per anchor_day as-of that timestamp)
4. Returns a series of `{as_at_date, data_points: [{anchor_day, x, y, ...}]}` frames

When forecasting is enabled (Phase 5), the backend fits the lognormal model from the snapshot rows' own `median_lag_days` and `mean_lag_days` (aggregated across anchor_days), constrained by `edge.p.latency.t95` from the scenario graph (located via `target.targetId`). Each frame's data points are then annotated with `completeness` (from CDF evaluation using cohort age at that retrieval date).

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

| File | Change |
|------|--------|
| `analysisTypes.ts` | Add `snapshotContract` field to `AnalysisTypeMeta`; populate for `lag_histogram`, `daily_conversions` |
| `snapshotDependencyPlanService.ts` (NEW) | Resolver: analysis scope → `SnapshotSubjectRequest[]` |
| `coreHashService.ts` (NEW) | Frontend `computeShortCoreHash()` (see `hash-fixes.md`) |
| `AnalyticsPanel.tsx` | When analysis type has `snapshotContract`, call resolver and include `snapshot_subjects` in request |
| `graphComputeClient.ts` | Extend request types to carry `snapshot_subjects`; update `analyzeSnapshots()` or unify with `analyzeSelection()` |
| `snapshotWriteService.ts` | Update all API calls to send frontend-computed `core_hash` (see `hash-fixes.md`) |
| `api_handlers.py` | Extend `_handle_snapshot_analyze` to accept `snapshot_subjects`; use frontend `core_hash` directly |
| `snapshot_service.py` | Accept `core_hash` as parameter (not derived); add cohort maturity query function |
| `histogram_derivation.py` | Accept `t95_constraints` parameter (unused in Phase 1) |
| `daily_conversions_derivation.py` | Accept `t95_constraints` parameter (unused in Phase 1) |
| `cohort_maturity_derivation.py` (NEW) | Cohort maturity sweep derivation |

---

## 14. Implementation Phases

### Phase 1: Hash Fix + Basic Plumbing

**Goal**: Frontend computes all hashes. Basic `lag_histogram` and `daily_conversions` work end-to-end via the new `snapshot_subjects` path.

**Tasks**:
1. Implement `coreHashService.ts` with golden cross-language tests (`hash-fixes.md` Steps 1-2)
2. Update frontend API calls to send `core_hash` (`hash-fixes.md` Steps 3-4)
3. Define `SnapshotContract` type and add to `lag_histogram` / `daily_conversions` in `analysisTypes.ts`
4. Create `snapshotDependencyPlanService.ts` (resolver for `selection_edge` scope rule)
5. Wire `AnalyticsPanel.tsx` to call resolver when analysis type has `snapshotContract`
6. Update `_handle_snapshot_analyze` to accept `snapshot_subjects`
7. Remove backend hash derivation from production paths (`hash-fixes.md` Step 5)

### Phase 2: Cohort Maturity

**Goal**: The `cohort_maturity` read mode works. Users can see how a cohort's observed conversion rate evolved over time.

**Tasks**:
1. Add `cohort_maturity` as a new analysis type with its contract
2. Implement cohort maturity sweep query on backend
3. Implement `cohort_maturity_derivation.py`
4. Frontend chart component for maturity curves (solid/dashed by maturity)

### Phase 3: Multi-Subject Scope Rules

**Goal**: `funnel_path`, `reachable_from`, and `all_graph_parameters` scope rules work.

**Tasks**:
1. Implement funnel path resolution (DSL from/to → edge traversal)
2. Implement BFS reachable-from resolution
3. Implement all-graph-parameters scope
4. Backend handles multiple subjects in a single request, returns per-subject results
5. Frontend aggregates/displays multi-subject results

### Phase 4: MECE Slice Resolution + Conditional Parameters

**Goal**: Uncontexted semantic series fulfilled by MECE partition slices. Conditional parameters are first-class.

**Tasks**:
1. Resolver correctly emits MECE slice keys for uncontexted series
2. Resolver includes conditional parameters (`conditionalIndex`) in subjects
3. Backend aggregates across MECE slices per subject
4. Tests for MECE union and conditional parameter parity

### Phase 5: Forecasting Integration

**Goal**: Backend can annotate results with completeness estimates and projections.

**Prerequisite**: `analysis-forecasting.md` §6 (port pure maths to Python)

**Tasks**:
1. Port `lagDistributionUtils.ts` to Python with golden tests
2. Share latency constants via YAML
3. Backend aggregates lag stats from snapshot rows (`median_lag_days`, `mean_lag_days` per row) and fits lognormal model
4. Backend reads authoritative `t95` constraint from graph edge (`edge.p.latency.t95`) via `target.targetId` — used as one-way sigma constraint only
5. Backend derivation functions use fitted model for completeness annotation per anchor_day
6. Cohort maturity results include `completeness` and `projected` fields
7. Frontend charts render evidence/forecast distinction

---

## 15. Testing Strategy

### Unit Tests

- `snapshotDependencyPlanService.test.ts`: Given (graph + analysis_type + DSL + selection), emits correct `SnapshotSubjectRequest[]`
- `coreHashService.test.ts`: Frontend `computeShortCoreHash` matches golden fixtures
- Scope rule tests: each rule correctly identifies subjects from test graphs

### Integration Tests

- Extend existing `cohortAxy.meceSum.vsAmplitude.local.e2e.test.ts` to verify the full pipeline:
  - Frontend builds `snapshot_subjects` with correct coordinates
  - Backend queries DB using frontend-provided `core_hash` (no derivation)
  - Derivation produces correct results
  - MECE aggregation is correct (no double counting)

### Cross-Language Parity Tests

- `core-hash-golden.json`: shared fixture for `computeShortCoreHash` parity
- `lag-distribution-golden.json` (Phase 5): shared fixture for statistical function parity

---

## 16. Risk Assessment

| Risk | Mitigation |
|------|------------|
| Hash parity (TS vs Python) | Golden test suite; run before any migration |
| Signature not available in parameter file | Resolver skips subjects without signatures; backend reports per-subject status |
| MECE slice enumeration differs from write-time | Same MECE resolution code used by both paths; explicit tests |
| Conditional parameters missed | `enumerateFetchTargets` already includes them; add explicit tests |
| Cohort maturity query is slow (many rows) | Date-bounded sweep range limits data volume; potential for query optimisation (materialised view) if needed |
| Forecasting model changes | Deferred to Phase 5; golden tests ensure TS/Python parity |

---

## 17. Acceptance Criteria

1. Frontend computes ALL hashes (`core_hash`); backend uses them directly (no derivation)
2. `lag_histogram` and `daily_conversions` work end-to-end via `snapshot_subjects`
3. The request shape supports multi-subject, multi-slice, and includes optional forecasting metadata
4. Cohort maturity mode produces a time series of virtual snapshots over a sweep range
5. MECE union is supported: multiple `slice_keys` per subject, backend aggregates
6. Conditional parameters are first-class in subject enumeration
7. Availability gating based on batch inventory for all subjects in scope

---

## 18. Related Documents

- `hash-fixes.md` — Critical fix: frontend must be sole producer of all hashes
- `analysis-forecasting.md` — Statistics on the backend (deferred, but anticipated in request shape)
- `00-snapshot-db-design.md` — Full DB design spec
- `3-asat.md` — As-at feature design
- `2-time-series-charting.md` — Phase 5 charting requirements
