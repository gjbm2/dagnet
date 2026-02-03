# Snapshot DB Reads: Implementation Proposal

**Status**: Draft  
**Date**: 2-Feb-26  
**Related**: `00-snapshot-db-design.md` §2, `TODO.md` (CRITICAL missing integration section)

---

## 1. Problem Statement

The snapshot DB write path is implemented and working: when data is fetched from Amplitude, it is shadow-written to the DB via `appendSnapshots()` in `dataOperationsService.ts`.

The snapshot DB **read path** is **not wired into the production UI**, and (more importantly) we do not yet have a **general mechanism** to supply snapshot-backed analyses with the **DB coordinates they require**, across **all scenarios** and across **all relevant data subjects** (parameters) within the analysis scope.

| Component | Current State | Design Intent |
|-----------|---------------|---------------|
| Snapshot dependency planning | Does not exist | Frontend builds `snapshot_dependencies` per scenario and per parameter in analysis scope |
| Analysis request payload | Only scenario graphs + DSL | For snapshot-enabled analyses: include graphs **and** snapshot dependency coordinates |
| Scope resolution | Implicit / selection-biased | Deterministic resolver: analysis scope → set of parameters (including conditional) per scenario |
| DB coordinate construction | Ad-hoc / missing | Frontend emits `param_id`, `slice_keys`, date bounds, and (when enabled) `core_hash` |
| Availability gating | DSL-matched `runner/available-analyses` | Gate based on snapshot inventory coverage for *all* required subjects (batch) |

**Result**: The "Lag Histogram" and "Daily Conversions" analysis types appear in the UI but cannot function — they always invoke the scenario-based analysis path (which returns errors or wrong data).

---

## 2. Design Principle (reiterated from §2 of design doc)

> **Frontend does ALL logical resolution. Python is told what to retrieve and derives the result.**

| Layer | Responsibility |
|-------|----------------|
| **Frontend** | DSL parsing, signature computation, slice resolution, MECE verification, date coverage analysis, building `snapshot_query` coordinates |
| **Backend** | DB query execution, MECE aggregation (sum over slices), histogram/daily derivation |

For snapshot-enabled analyses (`lag_histogram`, `daily_conversions`):
- The frontend **can still pass the graph** (as it does for scenario-based analyses)
- But it **must also pass** **snapshot dependency coordinates** (DB query plan) for every scenario and every parameter the analysis depends on
- Python uses those coordinates to query the DB and derive results
- The graph may be used for context (labels/metadata), but the **data source is the DB**, not the graph’s embedded values

---

## 3. Required Implementation

### 3.1 Core Change: Treat snapshot reads as **analysis dependencies**, not a special-case UI action

The current document implicitly assumes “snapshot analysis” means “the user selects one parameter edge, and we run a special DB analysis for that edge”. That is too narrow.

Instead, we need a general pattern:

- Any analysis type may depend on snapshot-backed data for one or more **data subjects**
- A data subject is typically a **parameter** (including conditional parameters), identified by its workspace-prefixed `param_id`
- The frontend must compute a **snapshot dependency plan** for the analysis request, and include it in the request payload
- The backend uses this dependency plan to run DB queries and then derive the requested analysis output

Single-edge snapshot analyses become a special case where the dependency plan contains exactly one subject.

### 3.2 Define a general “snapshot dependency plan” schema

We need an explicit, general structure that supports:
- **Multiple scenarios** (current/base/what-if scenarios)
- **Multiple parameters** within an analysis scope
- **Multiple slices** per parameter (MECE unions; explicit slices; future keys)
- Both “raw snapshots” reads and “virtual snapshot as-at” reads, depending on analysis type

Proposed conceptual schema (names are illustrative; exact field names can be finalised during implementation):

- **`snapshot_dependencies`**: optional object included on analysis requests
  - **`by_scenario`**: map keyed by `scenario_id` (because scenario graphs can imply different effective parameters and/or effective DSLs)
    - Each entry is a list of **`snapshot_subject`** requests

Each `snapshot_subject` request must carry enough information for Python to query DB without re-implementing planner logic:

- **Identity**:
  - `subject_id`: stable identifier for joining results back to the analysis scope (e.g. `${scenario_id}:${param_id}:${family_key}`)
  - `param_id`: workspace-prefixed parameter identity (`${repo}-${branch}-${objectId}`)
  - `core_hash`: optional in V1 (recommended to include once signature policy is stable again)
  - `slice_keys`: list of slice keys to query (MECE union => many; uncontexted => `['']`)

- **Time bounds**:
  - `anchor_from`, `anchor_to`: anchor-day date range for the subject (derived from the analysis DSL window)
  - `as_at` (optional): for virtual snapshot reconstruction / time-travel queries

- **Read intent** (so Python can select the correct DB query shape):
  - `read_mode`: one of
    - `raw_snapshots` (needs longitudinal sequence; used by ΔY-derived analyses)
    - `virtual_snapshot` (one row per anchor_day as-of `as_at` or “latest”; used by anchor-day series views)

### 3.3 How the frontend builds the dependency plan (must reuse existing planning logic)

We must not invent a new ad-hoc resolver for snapshot reads. The plan should reuse the existing machinery used for normal fetching:

- **Target enumeration**: identify the parameters in the analysis scope (including conditional parameters) using the canonical enumeration path already used by fetch planners
- **Signature computation**: compute `core_hash` the same way the write path does (once signature policy is re-enabled)
- **Slice resolution**:
  - Determine whether the query is uncontexted but satisfiable via MECE slices
  - Enumerate slice keys deterministically from context definitions and parameter slice state
  - Emit the list of slice keys as the “semantic series” for the subject

Critically, this must be done **per scenario** (because scenario graphs can change which parameter IDs are referenced, and can change the effective DSL that defines time bounds).

### 3.4 Analysis-type contract: declare the required data scope (SPEC)

To make `snapshot_dependencies` systematic (not ad-hoc per analysis), each analysis type must expose a **contract** which is:
- **specific** (machine-readable)
- **resolvable** (given runtime state, it yields a concrete set of parameter subjects)
- **executable** (the backend can query DB using only the emitted coordinates)

This contract is part of the **analysis type definition machinery**.

#### 3.4.1 Where it lives (repo paths)

- **UI metadata** lives today in `graph-editor/src/components/panels/analysisTypes.ts` as `AnalysisTypeMeta`.
- We extend the “analysis type frame” by adding a parallel map of **contracts** (do not overload the UI-only meta):
  - `graph-editor/src/components/panels/analysisTypeContracts.ts` (NEW)

This keeps UI labels/icons separate from the executable data contract, while still giving the UI a single place to look up “how do I build the analysis request”.

#### 3.4.2 TypeScript interfaces (exact)

```ts
// graph-editor/src/components/panels/analysisTypeContracts.ts

export type AnalysisScopeRule =
  | 'selection_edges'            // selection identifies the parameter subjects directly
  | 'selection_nodes_reachable'  // derive subjects from traversal starting at selected nodes
  | 'all_graph_parameters'       // all parameter subjects in the graph
  | 'explicit_subjects';         // caller provides the subject list (rare; admin/debug)

export type SnapshotReadMode =
  | 'raw_snapshots'     // ΔY-derived analyses (needs longitudinal rows by retrieved_at)
  | 'virtual_snapshot'; // “as-at” / anchor-series views (needs latest-as-of per anchor_day)

export type SlicePolicy =
  | 'explicit'                  // only slices explicitly implied by request (if any)
  | 'mece_fulfilment_allowed'   // uncontexted semantic series may be fulfilled by MECE partition
  | 'mece_required';            // force decomposition (future)

export type TimeBoundsSource =
  | 'query_dsl_window'          // derive anchor_from/to from the analysis DSL window/cohort clause
  | 'analysis_arguments';       // derive from explicit args (future, e.g. date picker)

export interface SnapshotDependencyContract {
  requires_snapshot_data: true;
  per_scenario: boolean;

  // Which parameter subjects are in scope (MUST include conditional params)
  scope_rule: AnalysisScopeRule;

  // Which DB query shape is needed
  read_mode: SnapshotReadMode;

  // How slices are chosen for each subject
  slice_policy: SlicePolicy;

  // How anchor_from/to are derived
  time_bounds_source: TimeBoundsSource;

  // Whether to include core_hash once signature policy is enabled
  include_core_hash: boolean;
}

export interface AnalysisTypeContract {
  analysis_type: string; // matches AnalysisTypeMeta.id and backend analysis_type
  snapshot?: SnapshotDependencyContract; // undefined => no snapshot deps required
}
```

#### 3.4.3 Concrete request payload shape (what `/api/runner/analyze` receives)

We keep the existing analysis request shape (graphs/scenarios), and add an optional `snapshot_dependencies` pack.

```ts
export interface SnapshotSubjectRequest {
  // Stable ID so responses can be joined back to analysis scope.
  // MUST include conditionalIndex when relevant (conditional parameters are first-class).
  subject_id: string; // use buildItemKey({type:'parameter', objectId, targetId, slot, conditionalIndex})

  // Workspace-prefixed DB identity (matches write path)
  param_id: string;   // `${repo}-${branch}-${objectId}`

  // Optional: once signature policy is re-enabled (recommended)
  core_hash?: string;

  // Read intent
  read_mode: 'raw_snapshots' | 'virtual_snapshot';

  // Time bounds (anchor_day range)
  anchor_from: string; // ISO date
  anchor_to: string;   // ISO date
  as_at?: string;      // ISO timestamp (only meaningful for virtual_snapshot / time-travel)

  // Slice semantics
  slice_keys: string[]; // MECE union => N keys; uncontexted => ['']

  // Diagnostics / provenance (not used for DB lookup, but logged)
  target: {
    targetId: string;                 // edge UUID
    slot?: 'p' | 'cost_gbp' | 'labour_cost';
    conditionalIndex?: number;
  };
}

export interface SnapshotDependencies {
  by_scenario: Record<string, SnapshotSubjectRequest[]>;
}

// Existing runner/analyze request (today) + extension:
export interface RunnerAnalyzeRequest {
  analysis_type: string;
  query_dsl?: string;
  scenarios?: Array<{ scenario_id: string; graph: any; /* ...existing fields... */ }>;
  graph?: any; // existing single-scenario convenience

  // NEW:
  snapshot_dependencies?: SnapshotDependencies;
}
```

#### 3.4.4 Resolver algorithm (exact, reusing existing code)

Resolver entrypoint (NEW):
- `graph-editor/src/services/snapshotDependencyPlanService.ts`

Inputs:
- `analysis_type`
- scenario graphs (the same ones we already construct for analysis calls)
- `query_dsl`
- selection (`selectedNodeUuids`, `selectedEdgeUuids`) if the scope rule needs it
- workspace (`repo`, `branch`)

Algorithm:

1. **Look up contract** by `analysis_type` from `analysisTypeContracts.ts`.
   - If no `snapshot` contract: return `snapshot_dependencies: undefined`.

2. **For each scenario** (if `per_scenario=true`, else treat as a single scenario key):
   - Let `scenarioGraph` be the graph used for that scenario’s analysis.

3. **Enumerate parameter subjects (including conditional params)** using the canonical enumerator:
   - Call `enumerateFetchTargets(scenarioGraph)` from `graph-editor/src/services/fetchTargetEnumerationService.ts`.
   - Filter to `t.type === 'parameter'`.
   - This enumeration is already schema-parity-safe and includes:
     - edge.p / edge.cost_gbp / edge.labour_cost
     - edge.conditional_p[i].p with `conditionalIndex`

4. **Apply `scope_rule`**:
   - `all_graph_parameters`: keep all enumerated parameter targets.
   - `selection_edges`: keep targets whose `targetId` is in `selectedEdgeUuids`.
   - `selection_nodes_reachable`: implement BFS/DFS traversal starting at `selectedNodeUuids` to identify reachable edges, then keep targets whose edge is in that reachable set. (This is deterministic graph traversal; no data IO.)
   - `explicit_subjects`: caller supplies a list of `objectId` (and optionally `targetId`/slot/conditionalIndex); match against enumeration.

5. **Derive time bounds** (`anchor_from`, `anchor_to`):
   - Parse the analysis `query_dsl` (existing parser in `../lib/queryDSL` is already used by planners).
   - For cohort/window mode: derive anchor range from the DSL’s date clause.
   - Output ISO dates. (UI displays UK dates; external boundary uses ISO.)

6. **Resolve slice keys** for each subject:
   - Start from the subject’s parameter file values (read-only): `fileRegistry.getFile('parameter-${objectId}')` when available.
   - If `slice_policy === 'explicit'`: emit `['']` unless the DSL contains explicit context constraints that map to a specific slice family.
   - If `slice_policy === 'mece_fulfilment_allowed'`:
     - Use `resolveMECEPartitionForImplicitUncontextedSync()` from `graph-editor/src/services/meceSliceService.ts` on the parameter’s persisted values to select a MECE partition when the semantic series is uncontexted.
     - Emit `slice_keys` from the selected `ParameterValue[].sliceDSL` strings (normalised to slice keys).
     - If MECE is not resolvable and there is no explicit uncontexted slice, emit a structured “unfulfillable” diagnostic (used for gating).

7. **Compute `core_hash` (when enabled)**:
   - If `include_core_hash=true` and signature policy is enabled, compute via `computePlannerQuerySignaturesForGraph()` from `graph-editor/src/services/plannerQuerySignatureService.ts`.
   - Map the resulting signature back onto each subject via the same canonical item key (`buildItemKey`).
   - If signature policy is disabled, omit `core_hash`.

8. **Emit subjects**:
   - `subject_id` MUST be: `buildItemKey({type:'parameter', objectId, targetId, slot, conditionalIndex})` from `graph-editor/src/services/fetchPlanTypes.ts`.
   - `param_id` MUST be: `${repo}-${branch}-${objectId}` (matches write path in `dataOperationsService.ts`).
   - `target` fields come from enumeration (`targetId`, `paramSlot`, `conditionalIndex`) for logging only.

9. **Return**:
   - `snapshot_dependencies.by_scenario[scenario_id] = SnapshotSubjectRequest[]`.

Backend invariant:
- Python must not infer scope or slice plans. It executes the explicit `snapshot_dependencies` it is given and fails with a structured error if required deps are missing or empty.

### 3.5 Where this integrates: analysis request becomes “graph + snapshot deps” (not a separate one-off route)

We should treat snapshot-backed reads as an optional dependency pack that can travel alongside the existing analysis request (scenarios + graphs).

This yields the general pattern:

- The UI builds scenario graphs as it does today
- The UI also builds `snapshot_dependencies.by_scenario[...]` for analysis types that require DB-backed inputs
- Python uses `snapshot_dependencies` to query the DB (and derive), and uses the graph only for context/metadata as needed

This supports *both*:
- “classic scenario analyses” (no snapshot deps; backend uses the passed scenario graphs)
- “snapshot-enabled analyses” (snapshot deps present; backend uses DB; graphs are contextual)
- “hybrid analyses” (future): some metrics from DB, others from graph, if ever needed

### 3.6 What remains UI/selection-specific (and what should not)

Some analyses still have UI affordances (e.g. “this analysis needs an edge selection”), but that is merely one way to decide the analysis scope.

The core implementation must not assume a single selected edge; it must support any analysis scope that can implicate multiple parameters.

So:
- **Selection capture** (nodes/edges) is an input to the scope resolver, not the resolver itself
- **Scope resolution** outputs a dependency plan over parameters and scenarios

### 3.7 Availability gating (generalised)

Availability cannot be determined purely from DSL matching if the analysis requires snapshot-backed inputs.

Instead, gating should be based on whether the dependency plan can be satisfied from the DB:

- For a given analysis request, compute `snapshot_dependencies` (cheap: mostly planning, not IO)
- Query inventory for all `param_id`s in the plan (batch) and decide:
  - **Enabled** if required coverage exists (or if graceful degradation is acceptable for that analysis type per design)
  - **Disabled** with a precise reason if not (e.g. “no snapshot history for 7/12 parameters in scope”)

### 3.8 MECE union as a first-class series

Where the analysis scope refers to an *uncontexted* semantic series but the DB only has contexted slice rows, the frontend must provide:

- A list of slice keys representing the MECE partition that fulfils the semantic series
- A stable `subject_id` that represents the semantic series (not a specific slice key)

Python aggregates across slices, but it must not need to infer which slices are MECE; it just sums what it is told.

---

## 4. Implementation Phases

### Phase 1: Establish the general dependency-plan plumbing (single subject still works, but is not the design centre)

**Goal**: Make analysis requests capable of carrying snapshot dependency plans per scenario, even if the first concrete consumer is `lag_histogram` / `daily_conversions`.

**Tasks**:
1. [ ] Define `snapshot_dependencies` request structure in shared TS types (alongside existing analysis request types)
2. [ ] Update Python handler to accept `snapshot_dependencies` (even if unused by most analyses initially)
3. [ ] Create a central resolver service that can, given:
   - scenario graphs (or scenario IDs)
   - an analysis type
   - the effective DSL window
   produce `snapshot_dependencies.by_scenario`
4. [ ] Wire `AnalyticsPanel` to call this resolver and include `snapshot_dependencies` when needed
5. [ ] Add batch inventory gating for all `param_id`s in scope (not just “one selected edge”)

**Estimate**: 4-6 hours

### Phase 2: First concrete consumer(s): migrate snapshot-enabled analyses onto dependency-plan path

**Goal**: `lag_histogram` and `daily_conversions` run via the dependency plan, and the same mechanism can support future snapshot-enabled analysis types without new bespoke plumbing.

**Tasks**:
1. [ ] Implement backend execution of dependency-plan reads for these analyses
2. [ ] Ensure subject mapping is correct (semantic series IDs; MECE unions; per-scenario separation)
3. [ ] Confirm “rows analysed” and result totals behave under successive `as_at` (no double counting)

**Estimate**: 2-3 hours

### Phase 3: MECE slice resolution and conditional-parameter parity under the same mechanism

**Goal**: The resolver correctly emits slice keys for MECE unions for any parameter type (direct and conditional) and Python aggregates safely.

**Tasks**:
1. [ ] Ensure target enumeration includes conditional parameters as first-class subjects
2. [ ] Ensure slice resolution mirrors write-path slice keys exactly
3. [ ] Expand tests to cover conditional parameter snapshot reads and MECE unions

**Estimate**: 3-4 hours

### Phase 4: As-At Support

**Goal**: Support point-in-time queries for `as_at` views.

**Tasks**:
1. [ ] Add optional `as_at` input to AnalyticsPanel (date picker)
2. [ ] Populate `as_at` on all relevant `snapshot_subject` entries in `snapshot_dependencies`
3. [ ] Python uses virtual snapshot reconstruction for the given date

**Estimate**: 2-3 hours (design overlap with time-series charting)

---

## 5. File Changes Summary

| File | Change |
|------|--------|
| `AnalyticsPanel.tsx` | Include `snapshot_dependencies` when analysis type requires snapshot-backed inputs |
| `snapshotDependencyPlanService.ts` (NEW) | General resolver: analysis scope → per-scenario snapshot dependency plan |
| `analysis scope resolver` (NEW or extend existing) | Identify all parameters (including conditional) implicated by analysis scope |
| `analysisTypes.ts` | Mark snapshot-enabled analysis types as requiring dependency plans (not “special edge selection”) |
| `graphComputeClient.ts` | Extend request types to carry `snapshot_dependencies` alongside scenarios/graphs |
| Python runner API | Accept and execute `snapshot_dependencies` for relevant analysis types |

---

## 6. Testing Strategy

### Unit Tests

- `snapshotDependencyPlanService.test.ts`: given (graph + scenarios + analysis_type + query window), emits stable `snapshot_dependencies.by_scenario` with correct subjects
- `analysisScopeResolver.test.ts`: enumerates parameters in scope including **conditional parameters** (first-class), and produces stable `subject_id` mapping
- MECE slice resolution tests: uncontexted semantic series fulfilled by MECE partition slices; emitted `slice_keys` match write-path keys

### Integration Tests (extend existing E2E)

The existing `cohortAxy.meceSum.vsAmplitude.local.e2e.test.ts` already calls `/api/runner/analyze` with snapshot query coordinates directly. Once dependency-plan wiring is complete:

1. Add a test that simulates the analysis request being built with `snapshot_dependencies` for both:
   - a direct parameter subject
   - a conditional-parameter subject
2. Verify the backend reads all subjects via DB and produces deterministic outputs
3. Verify MECE union aggregation produces correct totals (no double-counting) when multiple `slice_keys` are supplied for a semantic subject

### Manual Verification

1. Open a graph with a mix of direct and conditional parameters
2. Run an analysis that is flagged “snapshot-enabled”
3. Confirm the request payload includes `snapshot_dependencies` with multiple subjects (and, if multi-scenario, per-scenario separation)
4. Confirm Python logs/exposes “subjects read” counts and any missing coverage
5. Spot-check DB rows for one subject and confirm the derived result is consistent with those rows

---

## 6.1 Hardening Procedure (contracts + stress tests on realistic fixtures)

This section defines a concrete procedure to validate that the **analysis-type contract → dependency-plan resolver → backend DB execution** pipeline is correct and stable, including for **conditional parameters** and **MECE slice fulfilment**.

### 6.1.1 Finalise a minimal, representative set of snapshot-enabled analysis/chart types

Add contracts (in `graph-editor/src/components/panels/analysisTypeContracts.ts`) for at least the following **three** classes, because they exercise distinct read modes and scope rules:

1. **ΔY-derived attribution (raw snapshots)**:
   - `lag_histogram` (raw snapshot sequences; `read_mode='raw_snapshots'`)
   - `daily_conversions` (raw snapshot sequences; `read_mode='raw_snapshots'`)

2. **Anchor-day “point view” (virtual snapshot)**:
   - Add one concrete analysis type (new or existing) whose output is an anchor-day series taken “as of” a date:
     - `anchor_day_series_as_at` (or similar name aligned with runner types)
   - Must use `read_mode='virtual_snapshot'` and accept `as_at`.

3. **Multi-subject scope (not single-edge)**:
   - Add one concrete analysis type (new or existing) that explicitly requires multiple parameter subjects in scope, e.g.:
     - `graph_snapshot_health` (counts subjects with coverage vs missing; per-scenario)
   - Purpose: force the dependency plan to carry **many subjects**, not just one.

Acceptance criterion for this subsection: each selected analysis type has a fully specified `SnapshotDependencyContract` (scope_rule, per_scenario, read_mode, slice_policy, include_core_hash policy).

### 6.1.2 Curate fixture graphs + contexts that reflect real complexity

Use existing fixtures (do not invent new graphs) and explicitly standardise the test fixture set:

- **Graphs** (already present in repo):
  - `param-registry/test/graphs/ecommerce-checkout-flow.json` (rich, realistic)
  - `param-registry/test/graphs/sample.json` (smaller; contains `conditional_p`)

- **Contexts** (already present in repo):
  - `param-registry/test/contexts/channel-mece-local.yaml` (MECE partition)
  - `param-registry/test/contexts/channel.yaml` (non-MECE or broader categorical; compare behaviour)

Acceptance criterion: for each fixture graph, enumerate which parameters (including conditional) exist and confirm at least one graph contains conditional parameters in `edge.conditional_p[i].p`.

### 6.1.3 Define scenario set for stress testing

For each fixture graph, run the resolver under **three** scenario conditions:

- **Current**: baseline graph
- **Base**: baseline graph (same as current for now; ensures per-scenario separation logic is exercised)
- **One what-if scenario**: modify probabilities in a way that changes parameter identities where possible (or at least changes scenario graph content) so the “per scenario graph” inputs are not byte-identical.

Acceptance criterion: dependency plans are emitted per scenario key (even if identical), and the plan’s `subject_id`s are stable across runs.

### 6.1.4 Golden-plan testing (frontend-only, no DB)

Add a new unit test suite:

- `graph-editor/src/services/__tests__/snapshotDependencyPlanService.contracts.test.ts`

For each (analysis_type × fixture graph × scenario set):

1. Run the resolver to produce `snapshot_dependencies`.
2. Assert invariants:
   - **Subject enumeration parity**: subjects match `enumerateFetchTargets(graph)` filtered to parameters, after applying scope_rule.
   - **Conditional parity**: when a fixture contains `conditional_p`, the plan includes at least one subject whose `subject_id` includes a `conditionalIndex` segment (via `buildItemKey`).
   - **Slice policy**:
     - if `slice_policy='mece_fulfilment_allowed'` and the semantic series is uncontexted, the subject emits `slice_keys.length > 1` (MECE union) *or* explicitly emits `['']` only when an uncontexted slice exists.
   - **Determinism**: repeated invocations produce identical plans (deep-equal, stable ordering).

Acceptance criterion: these tests fail loudly if conditional parameters are dropped, if MECE slice planning drifts, or if ordering is unstable.

### 6.1.5 End-to-end dependency execution test (DB-backed, minimal mocking)

Extend the existing real-Amplitude DB E2E (or add a new focused integration suite if it is a better home) to assert that:

1. The analysis request is constructed with `snapshot_dependencies` for **multiple subjects** and **multiple scenarios**.
2. Python consumes the dependency plan and reports (in response metadata) which subjects were read and how many rows were analysed per subject.
3. For `raw_snapshots` analyses, verify “no double counting” across as-at boundaries.

The existing file `graph-editor/src/services/__tests__/cohortAxy.meceSum.vsAmplitude.local.e2e.test.ts` is already structured to persist artifacts and call `/api/runner/analyze`. It is the correct place to:
- capture the emitted `snapshot_dependencies` payload (persist to `graph-editor/debug/`)
- verify DB writes correspond to the slice keys and date windows referenced by the dependency plan

Acceptance criterion: E2E run proves the full pipeline (frontend plan → DB reads → derived result) for both `raw_snapshots` and `virtual_snapshot` read modes.

### 6.1.6 Coverage checklist (must pass before claiming “hardened”)

Before declaring this design hardened, ensure the fixture suite covers:
- **Conditional parameters** present in the plan and executed end-to-end
- **MECE union**: subject uses multiple slice keys to represent a semantic series
- **Multi-subject**: analysis depends on more than one parameter subject
- **Per-scenario**: dependency plans differ or at least are emitted separately per scenario
- **Both read modes**: `raw_snapshots` and `virtual_snapshot`

---

## 7. Risk Assessment

| Risk | Mitigation |
|------|------------|
| Signature mismatch (writes used different `core_hash` than reads query) | V1: Match by `param_id` + `slice_key` only, ignore `core_hash`. Add `core_hash` matching in V2 after signature policy is re-enabled. |
| MECE slice enumeration differs from write-time | Use same context resolution code as write path; test explicitly. |
| Conditional parameters missed | Ensure canonical target enumeration includes conditional parameters; add explicit tests for conditional-p read deps. |
| Inventory gating only checks “one edge” | Gate based on full dependency plan; batch inventory for all `param_id`s in scope. |

---

## 8. Acceptance Criteria

1. Snapshot-enabled analyses accept and use a per-scenario `snapshot_dependencies` plan (not ad-hoc UI assumptions).
2. The dependency plan can include multiple parameters; Python queries DB for each subject deterministically.
3. MECE union is supported by passing multiple `slice_keys` for a single semantic subject; Python aggregates without double counting.
4. Conditional parameters are first-class in dependency enumeration and read planning.
5. Availability gating is computed from the dependency plan and snapshot inventory coverage (batch), with precise error messages when missing.

---

## 9. Open Questions

1. **Signature matching policy**: Should reads require `core_hash` match, or is `param_id` + `slice_key` sufficient for V1? **Recommendation**: Skip `core_hash` for V1 (signature policy is disabled anyway per TODO.md).

2. **Scope definition for snapshot-enabled analyses**: For a given analysis type, is the scope driven by UI selection, by the DSL, by “all params in graph”, or by “all params reachable from selected nodes”? **Recommendation**: encode per-analysis scope rules in the frontend resolver; do not let Python infer scope from graphs.

3. **Date range source**: If no `queryDSL` is set, should we derive dates from the edge's `p.query`? **Recommendation**: Yes, fall back to edge's query if panel DSL is empty.

4. **As-at UI**: Where should the `as_at` date picker live? **Recommendation**: Defer to Phase 4; design alongside time-series charting feature.

---

## 10. Related Documents

- `00-snapshot-db-design.md` — Full design spec
- `3-asat.md` — As-at feature design
- `TODO.md` — Issue documentation and E2E test status
- `implementation-plan.md` — Overall project phases
