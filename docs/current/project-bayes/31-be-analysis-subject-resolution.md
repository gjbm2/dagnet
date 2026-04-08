# Doc 31 — BE Analysis Subject Resolution

**Status**: Implemented 8-Apr-26
**Date**: 7-Apr-26 (design), 8-Apr-26 (implemented)
**Depends on**: Doc 30 (Snapshot Regime Selection Contract) — assumed
implemented immediately prior. All references to "candidate regimes",
"regime selection", and `select_regime_rows()` refer to doc 30's
design.

**Purpose**: Move analysis data-subject resolution from FE to BE. The
FE currently resolves analytics DSL strings (`from(a).to(b)`) into
per-edge UUIDs, signatures, hashes, and `SnapshotSubjectRequest`
objects before the BE ever sees the request. This doc designs the
change where the FE sends the DSL string and the BE resolves it.

**Related**: `30-snapshot-regime-selection-contract.md` (regime
selection), `29-generalised-forecast-engine-design.md` (multi-hop
maturity), `../codebase/DSL_PARSING_ARCHITECTURE.md` (DSL parsing),
`../codebase/HASH_SIGNATURE_INFRASTRUCTURE.md` (hash computation)

---

## 1. Problem statement

### 1.1 Graph logic split across FE and BE

The FE currently performs graph-topology-aware resolution that belongs
on the BE:

1. **Scope rule application** — BFS traversal of the graph to find
   in-scope edges (`resolveFunnelPathEdges`,
   `resolveImmediateChildEdges`, `resolveReachableEdges`)
2. **Subject assembly** — mapping in-scope edges to
   `SnapshotSubjectRequest` objects with read modes, time bounds,
   and slice keys

The BE already has the graph (sent in the request), already has a
full DSL parser (`query_dsl.py`), and already has graph path
resolution (`graph_select.py`). It duplicates none of this work
because the FE pre-resolves everything.

### 1.2 Multi-hop is hard with the current split

Doc 29 (generalised forecast engine) identifies that `from(A).to(Z)`
across multiple hops requires the BE to know which edge is first
(denominator) and which is last (numerator). Under the current
contract, the FE resolves the path and sends per-edge subjects — but
the path structure (ordering, first/last role) is lost. The BE
receives a flat list of subjects with no relationship between them.

Adding `from_node_uuid` and `to_node_uuid` fields to
`SnapshotSubjectRequest` (doc 29's recommendation) patches the
symptom. The cleaner fix: the BE resolves the path itself, from the
DSL, and knows the structure natively.

### 1.3 Every snapshot-aware analysis type duplicates the same resolution

All 10 snapshot-aware analysis types go through
`mapFetchPlanToSnapshotSubjects` on the FE — the same scope
resolution, signature computation, hash closure, and time bounds
extraction. The BE then receives the pre-resolved subjects and
processes them generically. The FE resolution is shared infrastructure
pretending to be per-analysis-type configuration.

### 1.4 Post-doc-30 the FE still does too much

After doc 30, the FE still:

- Resolves DSL → in-scope edges via graph traversal
- Builds `candidate_regimes` per edge (doc 30 §4.1 — now for all
  edges via `buildCandidateRegimesByEdge`)
- Assembles `SnapshotSubjectRequest` objects with read modes, time
  bounds, and slice keys
- Performs preflight + epoch segmentation for `cohort_maturity`
  (retained in doc 30 implementation; removed by this doc)

The scope rule application, subject assembly, and epoch planning are
pure functions of the graph + DSL + DB state. The graph and DSL are
already sent to the BE; the DB is on the BE. The candidate regime
construction requires FE-side state (context registry, hash
mappings) and stays on the FE — but the FE already computes it for
all edges, removing the need to know which edges the BE will
select.

---

## 2. What changes

### 2.1 The revised FE→BE contract

**Before (current + doc 30)**:

```
FE sends per scenario:
  graph: { ... }
  effective_query_dsl: 'from(registration).to(purchase).window(-90d:)'
  snapshot_subjects: [
    {
      subject_id: 's1',
      param_id: 'repo-branch-param-1',
      canonical_signature: '...',
      core_hash: 'abc123...',
      read_mode: 'cohort_maturity',
      anchor_from: '2025-10-01',
      anchor_to: '2025-10-31',
      sweep_from: '2025-10-01',
      sweep_to: '2026-04-07',
      slice_keys: ['cohort()'],
      equivalent_hashes: [...],
      candidate_regimes: [...],     // doc 30 addition
      target: { targetId: 'edge-uuid-1', slot: 'p' }
    }
  ]
```

**After**:

```
FE sends:
  analysis_type: 'cohort_maturity'
  query_dsl: 'from(registration).to(purchase).window(-90d:)'
  mece_dimensions: ['channel', ...]   // doc 30 — for aggregation safety
  scenarios: [
    {
      graph: { ... }
      analytics_dsl: 'from(registration).to(purchase)'
      candidate_regimes_by_edge: {    // doc 30 — for ALL edges in graph
        'edge-uuid-1': [CandidateRegime, ...],
        'edge-uuid-2': [CandidateRegime, ...],
        ...
      }
    }
  ]
```

No `snapshot_subjects`. The BE resolves the DSL against each
scenario's graph, identifies in-scope edges, looks up their
candidate regimes from the per-scenario map, and uses doc 30's
`select_regime_rows()` to serve the right data.

**Note on doc 30 implementation**: the current doc 30 code attaches
regimes **per-subject** (`subject.candidate_regimes`) on the
analysis path, and as a **top-level `candidate_regimes_by_edge`
map** on the Bayes path. Doc 31 adopts the Bayes-path pattern
(top-level map per scenario) since there are no pre-resolved
subjects. The BE handler's `_apply_regime_selection()` will shift
from reading `subj.get('candidate_regimes')` to looking up by
edge UUID from the scenario-level map.

### 2.2 What the FE still owns

The FE remains responsible for:

- **DSL construction**: building `analytics_dsl` and `query_dsl` from
  user selections (edge clicks, node picks, DSL editor)
- **Candidate regime construction** (doc 30 §4.1): for **every edge
  in the graph**, compute candidate regimes from DSL explosion + hash
  mappings + context registry → `candidate_regimes_by_edge` map.
  This stays on the FE because it requires the context registry
  (MECE status per dimension) which is FE-side state. Computing for
  all edges (not just in-scope ones) is trivially cheap and avoids
  the FE needing to know which edges the BE will select.
- **MECE dimensions** (doc 30 implementation): `computeMeceDimensions`
  returns the list of context dimensions that are safe to aggregate
  over. Sent as a top-level `mece_dimensions` field for the BE's
  `validate_mece_for_aggregation()` check after regime selection.
- **Signature + hash computation**: still needed per edge for
  candidate regime construction. The FE retains `coreHashService`
  and `plannerQuerySignatureService` for this purpose.
- **Display settings**: chart kind, orientation, legend, etc.
- **Scenario management**: which scenarios exist, what-if overlays,
  visibility modes

### 2.3 What moves to the BE

| Responsibility | Current owner | New owner | Mechanism |
|---|---|---|---|
| DSL → edge resolution | FE (`applyScopeRule`, BFS) | BE (`graph_select.py`, `query_dsl.py`) | BE parses DSL + traverses graph |
| Path structure (first/last edge) | Not tracked | BE | BE knows the resolved path natively |
| Signature + hash computation | FE (`plannerQuerySignatureService`, `coreHashService`) | FE (unchanged) | Still needed for candidate regime construction (doc 30) |
| Candidate regime construction | FE (in-scope edges only) | FE (all edges) | FE computes for all edges; BE selects in-scope ones |
| Subject assembly | FE (`mapFetchPlanToSnapshotSubjects`) | BE (new resolution step in handler) | BE builds subject list internally from resolved path + regime map |
| Epoch segmentation | FE (removed by doc 30) | BE (doc 30 `select_regime_rows`) | Already handled by doc 30 |
| Regime selection | FE preflight (removed by doc 30) | BE (doc 30 `select_regime_rows`) | Already handled by doc 30 |

### 2.4 What the BE gains

With DSL resolution on the BE side:

- **Path structure is first-class.** The BE knows the ordered path
  from A to Z, which edges are first/last, and can compose multi-hop
  maturity natively (doc 29 Phase A). No new fields needed on the
  request.
- **Scope rules are centralised.** `graph_select.py` already does
  path-finding. Extending it to handle all scope rules
  (`funnel_path`, `children_of_selected_node`, `reachable_from`,
  `all_graph_parameters`) puts all graph-topology logic in one place.
- **No signature drift risk.** The FE remains sole producer of
  signatures and hashes (for candidate regimes). The BE consumes them
  as opaque coordinates. No cross-language serialisation parity
  concern.
- **Analysis-type-specific resolution becomes possible.** The BE can
  resolve subjects differently per analysis type (e.g. multi-hop
  composition for `cohort_maturity`, per-child subjects for
  `outcome_comparison`) without the FE needing to encode these
  differences.

---

## 3. Scope rules on the BE

### 3.1 Current FE scope rules

| Scope rule | Used by | FE implementation |
|---|---|---|
| `funnel_path` | cohort_maturity, daily_conversions, lag_histogram, lag_fit, surprise_gauge | `resolveFunnelPathEdges` — bidirectional BFS from from-node to to-node |
| `children_of_selected_node` | outcome_comparison, branch_comparison | `resolveImmediateChildEdges` — BFS from selected node |
| `reachable_from` | (unused currently) | `resolveReachableEdges` — forward BFS |
| `all_graph_parameters` | bayes_fit | All parameter items, no filtering |

### 3.2 BE equivalents

`graph_select.py` already implements path-finding via
`apply_query_to_graph()`. It parses the DSL, resolves from/to nodes,
and finds valid paths through the graph. This covers `funnel_path`.

The other scope rules are simple graph traversals (BFS for children,
BFS for reachable, all-parameters) that are trivial to implement in
Python given the graph adjacency structure.

### 3.3 What `graph_select` returns today vs what's needed

Today `apply_query_to_graph` returns a filtered graph (nodes + edges
on valid paths). For subject resolution, the BE needs:

- **Ordered edge list** per path (for multi-hop: which is first,
  which is last)
- **Per-edge parameter identity** (param_id, targetId, slot)
- **Scope-filtered edge set** (for non-path scope rules)

This requires extending `graph_select` to return structured path
information, not just a filtered graph. A new function
`resolve_analysis_subjects(graph, query_dsl, scope_rule,
candidate_regimes_by_edge)` that returns an ordered list of resolved
edges with their parameter identities and looked-up candidate
regimes.

---

## 4. Signature, hash, and closure computation stays on FE

### 4.1 Why it stays

The FE computes candidate regimes for all edges (§2.2). Each
candidate regime requires a `core_hash` (derived from the canonical
signature) and `equivalent_hashes` (from hash-mapping closure). The
FE already has the machinery for all of this: `plannerQuerySignature
Service` for signatures, `coreHashService` for hashes,
`hashMappingsService` for closures.

Moving signature computation to the BE was proposed in the original
draft but is no longer necessary. The FE computes regimes for all
edges and ships them. The BE looks up regimes by edge UUID after
resolving which edges are in scope. No BE-side signature or hash
computation needed.

### 4.2 What the BE receives

The `candidate_regimes_by_edge` map contains pre-computed
`CandidateRegime` objects per doc 30 §4.1 — each with `core_hash`,
`equivalent_hashes`, `slice_keys`, `regime_kind`. These are opaque
DB coordinates from the BE's perspective. The BE does not need to
know how they were computed.

### 4.3 Future option: BE-side computation

If the BE ever needs to construct candidate regimes independently
(e.g. for Bayes automation without FE involvement), it would need:
- A Python equivalent of `computePlannerQuerySignaturesForGraph`
- Promotion of `short_core_hash_from_canonical_signature()` from
  test-only to production
- Access to `hash-mappings.json` for closure computation

This is deferred. The existing Python hash function and the
`core-hash-golden.json` parity fixtures prove it's feasible when
needed.

---

## 5. The resolved request shape

After BE resolution, the internal representation (never sent over the
wire — constructed by the BE handler) looks like:

```python
@dataclass
class ResolvedAnalysisSubject:
    """One edge's worth of resolved analysis data."""
    edge_id: str
    param_id: str                      # workspace-prefixed
    slot: str                          # 'p', 'cost_gbp', etc.
    conditional_index: Optional[int]
    path_role: Optional[str]           # 'first', 'last', 'intermediate', None
    candidate_regimes: list[CandidateRegime]  # looked up from FE map

@dataclass
class ResolvedAnalysisPath:
    """The fully resolved path for one analysis request."""
    from_node: str
    to_node: str
    ordered_edges: list[str]           # edge UUIDs in path order
    subjects: list[ResolvedAnalysisSubject]
    anchor_from: str
    anchor_to: str
    sweep_from: Optional[str]
    sweep_to: Optional[str]
    temporal_mode: str                 # 'window' or 'cohort'
```

The handler builds this from the DSL + graph + candidate regime map,
then passes it to the appropriate derivation function.
`cohort_maturity` uses `path_role` to identify first-edge
(denominator) and last-edge (numerator) for multi-hop composition.
Other analysis types initially ignore `path_role` and process
per-edge independently. Each subject carries its own candidate
regimes (from the FE-provided map) for doc 30's
`select_regime_rows()` to use.

---

## 6. Multi-hop and full subgraph traversal fall out naturally

### 6.1 The key consequence

Moving DSL resolution to the BE is not merely a tidier FE/BE split.
It means **the BE owns the full resolved graph topology for the
analysis**. When a user commissions `from(A).to(Z)` for cohort
maturity, the BE:

1. Parses `from(A).to(Z)` from the DSL
2. Resolves the **complete subgraph** between A and Z via
   `graph_select` — all edges on all valid paths, with ordering,
   branching structure, fan-in/fan-out, and first/last annotations
3. Queries snapshot DB for all in-scope edges
4. Applies doc 30's `select_regime_rows()` per edge
5. Has access to **every edge's Bayes posteriors** (mu, sigma, onset,
   p) from the graph it already holds
6. Can therefore **convolve per-edge shifted-lognormal latency
   distributions** along the path to derive the true path-level CDF,
   rather than using the last-edge approximation from doc 29 §A
7. Can apply the **DAG propagation engine** (doc in
   `cohort-backend-propagation-engine-design.md`) to compute x(s,tau)
   through upstream immaturity, rather than the local shortcut
8. Passes composed frames to `compute_cohort_maturity_rows()`

This is the structural enabler for the full generalised forecast
engine (doc 29 Phases 2–4). The BE doesn't just know "which edges
are on the path" — it knows the complete topology and can traverse
any fully-encapsulated subgraph over which it needs to compose
probabilities, convolve latencies, and propagate maturity state.

### 6.2 Immediate vs deferred sophistication

**Immediate (Phase 5 of this doc)**: approximate multi-hop composition
using doc 29 Phase A scaffolding — product of per-edge p values,
last-edge path posterior for CDF, first-edge x as denominator. This
is the same logic doc 29 describes but now lives inside the BE's
resolved path structure rather than being encoded in the request.

**Deferred (doc 29 Phases 2–4)**: the BE replaces the scaffolding
with correct implementations:
- Per-edge latency convolution along the resolved path to derive the
  true A→Z CDF
- DAG-wide x(s,tau) propagation through the resolved subgraph to
  model upstream immaturity
- Consistent probability bases across all edges on the path
- Unified tau_observed from the path's frontier semantics

Both the approximate and correct implementations are **internal BE
concerns**. The FE sends the same `from(A).to(Z)` DSL regardless.
The sophistication of the computation evolves without touching the
request contract. This is only possible because the BE owns the
topology.

### 6.3 Other analysis types

The same resolved path structure enables multi-hop for every
`funnel_path` analysis type when each is ready:

- `daily_conversions`: path-level daily rate = y_Z / x_A per day
- `lag_histogram`: path-level latency distribution (A entry → Z
  arrival), derived from the convolved path CDF
- `lag_fit`: fit against path-level latency
- `surprise_gauge`: compare path-level observed rate against
  path-level posterior

Each requires its own composition function, but the resolved path
and the topology traversal infrastructure are shared. The BE builds
the resolved path once and each analysis type consumes the parts it
needs.

---

## 7. What changes per component

### 7.1 BE changes (Python)

- **New module: `lib/analysis_subject_resolution.py`**
  - `resolve_analysis_subjects(graph, query_dsl, analysis_type,
    scope_rule, candidate_regimes_by_edge) → ResolvedAnalysisPath`
  - Uses `query_dsl.py` for parsing, `graph_select.py` for path
    finding
  - Looks up candidate regimes per resolved edge from the FE-provided
    map
  - Annotates path roles (first/last/intermediate)

- **Extend `graph_select.py`** — add `resolve_ordered_path()` that
  returns ordered edge list with from/to node identification, not
  just a filtered graph

- **Modify `_handle_snapshot_analyze_subjects()`** — when the
  request contains `analytics_dsl` + `analysis_type` instead of
  pre-resolved `snapshot_subjects`, call
  `resolve_analysis_subjects()` to build subjects internally. When
  `snapshot_subjects` is present, use existing path (backward
  compatible).

- **`compose_path_maturity_frames()`** (doc 29 §A.1) — pure function
  for multi-hop evidence composition. Only called for
  `cohort_maturity` with multi-hop paths.

### 7.2 FE changes

- **Remove from `snapshotDependencyPlanService`**: scope rule
  application (`applyScopeRule`, `resolveFunnelPathEdges`,
  `resolveImmediateChildEdges`, `resolveReachableEdges`) and
  subject assembly (`mapFetchPlanToSnapshotSubjects`). After doc 30
  already removes epoch segmentation and preflight, this removes
  most of the remaining logic.

- **Remove `snapshotSubjectResolutionService`**: the orchestration
  layer that calls the dependency plan service. No longer needed.

- **Simplify `analysisComputePreparationService`**: instead of
  building `snapshot_subjects[]`, send `analytics_dsl` +
  `query_dsl` + `analysis_type` + `candidate_regimes_by_edge`.

- **Keep `coreHashService`**: still needed for candidate regime
  construction (computing core_hash per edge per regime).

- **Keep `hashMappingsService`**: still needed for candidate regime
  construction (equivalent_hashes per regime).

- **Keep `plannerQuerySignatureService`**: still needed for candidate
  regime construction (computing canonical signatures per edge).

- **New: build `candidate_regimes_by_edge` map** — iterate all edges
  in graph, compute candidate regimes per edge using existing
  signature + hash + closure machinery. This replaces the current
  per-in-scope-edge computation with a per-all-edges computation.
  Trivially cheap.

### 7.3 FE dead code removal (after full migration)

Once the BE handles all analysis subject resolution:

- `mapFetchPlanToSnapshotSubjects()` — dead
- `applyScopeRule()` and all scope rule functions — dead
- `SnapshotSubjectRequest` interface — dead (replaced by the simpler
  request shape)
- `snapshotSubjectResolutionService.ts` — dead
- Epoch-related functions (`selectLeastAggregationSliceKeysForDay`,
  `segmentSweepIntoEpochs`, `chooseLatestRetrievalGroupPerDay`,
  preflight `querySnapshotRetrievals` call) — dead. These were
  retained in the doc 30 implementation for backward compatibility
  with the per-subject architecture; they become dead once subjects
  are no longer assembled on the FE.

These are removed in a final cleanup phase, not during the migration.

---

## 8. Test design

### 8.0 Principles (from CLAUDE.md testing standards)

- **Zero mocks by default.** Every mock must pass the three-gate
  budget (name the assumption, name the risk, justify why the real
  thing is impractical).
- **Parity tests are mandatory** when replacing a code path. Call
  both paths with identical inputs, assert field-by-field equality,
  use real data, mock nothing.
- **Blind test design**: tests designed from the contract/spec, not
  from reading the implementation.
- **Assert on observable outcomes at real boundaries**, not on
  intermediate state. No `toBeDefined()` or `toBeTruthy()` as
  primary assertions.
- **Test names are specifications**: name the invariant, not the
  action.

### 8.1 Candidate regime map integrity (Phase 1 gate)

**What real bug would this catch?** The FE builds
`candidate_regimes_by_edge` for all edges, but the map is missing
an edge that the BE resolves as in-scope. Or the FE computes regimes
against a stale graph (different edge UUIDs). The BE looks up a
resolved edge in the map and gets nothing — analysis fails silently
or falls back incorrectly.

**What is real vs mocked?** Real graph from data repo. FE computes
the regime map. BE resolves path from DSL. Assert that every
BE-resolved edge UUID exists in the FE-provided map. No mocks.

**What would a false pass look like?** The test uses a graph where
every edge is on the path, so the map trivially covers all resolved
edges. A graph with many edges where only some are in-scope would
expose missing coverage. Mitigation: use a graph with 10+ edges
where the path covers 3.

**Test file**: `graph-editor/lib/tests/test_regime_map_coverage.py`
(new — validates the FE→BE contract for candidate regimes)

**Scenarios**:

| # | Scenario | Why it matters |
|---|----------|----------------|
| RC-1 | Simple 2-edge path in a 10-edge graph | Map has entries for all 10; BE resolves 2; both found |
| RC-2 | Diamond path in graph with disconnected components | Edges outside path and in disconnected component all present |
| RC-3 | perScenario type with what-if graph (edge added) | What-if graph may have edges not in base graph — FE must compute regimes for per-scenario graph |
| RC-4 | Graph with no context (uncontexted only) | Each edge has exactly one candidate regime (uncontexted) |
| RC-5 | Graph with multiple context dimensions | Each edge has 3+ candidate regimes (channel, device, bare) |
| RC-6 | Edge with hash-mapping equivalents | Candidate regime includes equivalent_hashes from closure |

**Assertions**: for every edge UUID returned by
`resolve_ordered_path()`, assert `edge_uuid in candidate_regimes_by_edge`.
For each regime entry, assert non-empty `core_hash`, valid
`regime_kind`, `slice_keys` consistent with regime kind.

### 8.2 Path resolution parity (Phase 2 gate)

**What real bug would this catch?** The BE resolves a different set
of edges than the FE for the same (graph, DSL, scope_rule). A
`funnel_path` query misses an edge on a parallel route, or includes
an edge outside the path. The analysis computes over wrong data.

**What is real vs mocked?** Real graph structures from the data repo.
The FE's `resolveFunnelPathEdges` is exercised via the existing TS
test infrastructure (or golden fixture export). The BE's
`resolve_ordered_path` is called directly. No mocks.

**What would a false pass look like?** Both resolve correctly on
linear chains (A→B→C) but diverge on diamond graphs (A→B→D, A→C→D)
where parallel paths exist. Mitigation: include diamond, fan-in, and
fan-out topologies.

**Test file**: `graph-editor/lib/tests/test_path_resolution_parity.py`
(new — no existing home for cross-language path parity)

**Scenarios**:

| # | Scenario | Why it matters |
|---|----------|----------------|
| PR-1 | Linear chain A→B→C, `from(A).to(C)` | Baseline: 2 edges, ordered |
| PR-2 | Single edge A→B, `from(A).to(B)` | Degenerate case: 1 edge, first=last |
| PR-3 | Diamond A→B→D, A→C→D, `from(A).to(D)` | Parallel paths: both routes included, first/last correct |
| PR-4 | Fan-out A→B, A→C, `children_of_selected_node` on A | Scope rule: 2 child edges, no ordering needed |
| PR-5 | Fan-in B→D, C→D, `from(B).to(D)` where C→D is not on path | Must exclude C→D (not reachable from B) |
| PR-6 | Graph with disconnected component, `from(A).to(Z)` where Z unreachable | Must return empty path, not error |
| PR-7 | Longer chain A→B→C→D→E, `from(A).to(E)` | 4 edges: verify ordering and first=A→B, last=D→E |
| PR-8 | `all_graph_parameters` scope rule | Must return every parameter edge in graph |

**Assertions**: identical edge UUID sets between FE and BE. For
ordered paths, identical ordering. For `funnel_path`, first-edge
from-node == DSL's from-node, last-edge to-node == DSL's to-node.
Path roles (`first`, `last`, `intermediate`) correct per position.

### 8.3 Subject resolution parity (Phase 2 gate)

**What real bug would this catch?** The BE produces different
`SnapshotSubjectRequest`-equivalent structures than the FE for the
same inputs. Wrong param_id, wrong core_hash, wrong time bounds,
wrong read_mode. The BE queries the DB with incorrect coordinates.

**What is real vs mocked?** Real graphs from data repo. Real DSLs
from existing canvas analyses in those graphs. Both FE and BE
resolution pipelines run end-to-end. No mocks.

**What would a false pass look like?** Parity passes for
`cohort_maturity` but fails for `outcome_comparison` because the
`children_of_selected_node` scope rule resolves differently. Or
passes for window mode but fails for cohort mode because time bounds
derivation diverges. Mitigation: cover all 5 scope rules × both
temporal modes.

**Test file**: extend `test_signature_parity.py` or
`test_path_resolution_parity.py` — whichever houses the golden
fixture infrastructure.

**Scenarios**: one scenario per (analysis_type, temporal_mode)
combination for all 8 snapshot-aware analysis types (excluding
`bayes_fit` which is internal). Focus on:

| # | Analysis type | Mode | Key assertion |
|---|---|---|---|
| SR-1 | `cohort_maturity` | cohort | core_hash, anchor_from/to, sweep_from/to, read_mode='cohort_maturity' |
| SR-2 | `cohort_maturity` | window | same fields, different temporal extraction |
| SR-3 | `daily_conversions` | window | read_mode='raw_snapshots', no sweep fields |
| SR-4 | `lag_histogram` | window | read_mode='raw_snapshots', funnel_path scope |
| SR-5 | `lag_fit` | window | read_mode='sweep_simple' |
| SR-6 | `surprise_gauge` | window | read_mode='sweep_simple' |
| SR-7 | `outcome_comparison` | window | children_of_selected_node scope, perScenario=true |
| SR-8 | `branch_comparison` | window | children_of_selected_node scope, perScenario=true |

**Assertions**: field-by-field equality on: edge_id (same edges
resolved), param_id, read_mode, anchor_from, anchor_to, sweep_from,
sweep_to, slot. Candidate regimes per edge looked up correctly from
the map (core_hash in regime matches the FE-computed value for that
edge). Path roles correct for funnel_path types.

### 8.4 End-to-end analysis parity (Phase 4 gate)

**What real bug would this catch?** The BE resolves subjects
correctly in isolation, but when wired into the full handler, the
analysis output differs — because the handler passes subjects to
derivation functions in a different order, or the regime selection
interacts differently with BE-resolved vs FE-resolved subjects.

**What is real vs mocked?** Real graph, real DSL, real snapshot DB
(requires `DB_CONNECTION`), real Python server. Both paths exercise
the full `_handle_snapshot_analyze_subjects` handler. No mocks.

**What would a false pass look like?** Parity passes because the
snapshot DB happens to have only one regime's data (no regime
selection ambiguity). Mitigation: use a graph+timespan where
multiple regimes exist (contexted + uncontexted data for
overlapping dates).

**Test file**: `graph-editor/lib/tests/test_analysis_resolution_e2e.py`
(new — integration test requiring live server + DB)

**Scenarios**: for each snapshot-aware analysis type:

1. Send request via old path (FE-resolved `snapshot_subjects`)
2. Send request via new path (BE-resolved from `analytics_dsl`)
3. Assert identical analysis output: same number of result rows,
   same values (within floating-point tolerance for computed fields),
   same metadata (subject_id mapping aside — those will differ by
   construction)

| # | Scenario | Why it matters |
|---|----------|----------------|
| E2E-1 | `cohort_maturity`, single edge, real DB data | Baseline: identical chart rows |
| E2E-2 | `cohort_maturity`, multi-hop A→B→C, real DB data | Multi-hop composition: path-level rate matches |
| E2E-3 | `daily_conversions`, single edge | Different read_mode, same resolution |
| E2E-4 | `surprise_gauge`, single edge | sweep_simple mode, model_vars from graph |
| E2E-5 | `outcome_comparison`, fan-out node | children_of_selected_node scope |
| E2E-6 | Any type, graph with mixed regimes (contexted + bare) | Regime selection interacts correctly with BE resolution |

**Assertions**: row-count equality. For numeric fields (rate,
midpoint, fan_upper, fan_lower, x, y): equality within 1e-9
relative tolerance. For string fields (anchor_day, tau_days):
exact equality. For metadata fields that legitimately differ
(subject_id): excluded from comparison.

### 8.5 Multi-hop topology tests (Phase 5 gate)

**What real bug would this catch?** The BE resolves the path
correctly but the composition logic produces wrong maturity curves —
e.g. the denominator uses an intermediate edge's x instead of the
first edge's x, or fan-in at the last node double-counts y from
parallel routes, or the path CDF uses the wrong edge's posterior.

**What is real vs mocked?** Real graph from data repo with known
multi-hop structure. Real snapshot data in DB. Real Bayes posteriors
on edges. No mocks.

**What would a false pass look like?** Composition works on a
linear chain (A→B→C) but fails on a diamond (A→B→D, A→C→D) because
fan-in y-summation is wrong. Or works when from_node == anchor_node
but fails when from_node != anchor_node because the denominator
source switches. Mitigation: test both linear and diamond topologies,
both anchor-aligned and non-anchor-aligned from-nodes.

**Test file**: `graph-editor/lib/tests/test_path_maturity_composition.py`
(new — no existing home for path-level frame composition)

**Scenarios**:

| # | Scenario | Invariant |
|---|----------|-----------|
| MH-1 | Single edge A→B: path composition degenerates to per-edge | Composed output == existing per-edge output, field-by-field |
| MH-2 | Linear chain A→B→C: denominator = first-edge x, numerator = last-edge y | rate = y_C / x_A, not y_C / x_B |
| MH-3 | Diamond A→B→D, A→C→D: fan-in at D | y_D = sum of y from B→D and C→D routes; rate = y_D / x_A |
| MH-4 | As tau→∞, path rate → path_p (product of per-edge p) | Asymptotic convergence within 5% for large tau |
| MH-5 | All cohorts fully mature (tau >> onset): rate ≈ path_p | Mature-limit convergence |
| MH-6 | Zero evidence (empty frames): falls back to model forecast curve | Fan chart driven by path posterior only |
| MH-7 | from_node == anchor_node: denominator = `a` field | Uses `a` (anchor population) not `x` (edge entrants) |
| MH-8 | from_node != anchor_node: denominator = first-edge `x` | Falls back correctly when `a` is not the right denominator |
| MH-9 | Path with 4+ edges: ordering preserved, intermediate edges contribute nothing to rate | Only first and last edges' frames used for composition |

**Assertions**:
- MH-1: field-by-field equality with existing single-edge output
  (this is the parity test — if the degenerate case diverges, the
  composition function is fundamentally wrong)
- MH-2/3: explicit numeric rate checks against hand-calculated
  values from known fixture data
- MH-4/5: asymptotic convergence checks (rate approaches path_p
  within tolerance as tau increases)
- MH-6: fan chart bounds match model-only forecast (same pattern as
  `TestWindowZeroMaturityDegeneration` in `test_cohort_forecast.py`)
- MH-7/8: denominator source switches correctly based on
  from_node/anchor_node relationship
- MH-9: intermediate edges' x and y values do not appear in the
  composed output

### 8.6 Mock budget for all tests

| Test suite | Mocks permitted | Justification |
|---|---|---|
| RC (regime map coverage) | None | Map construction and path resolution are pure; inputs are graph JSON |
| PR (path resolution) | None | Graph traversal is pure; inputs are graph JSON |
| SR (subject resolution) | None | Resolution is pure; golden fixtures capture FE output |
| E2E (analysis parity) | None | Real server + real DB required; mocking either defeats the purpose |
| MH (multi-hop topology) | None | Composition is pure; snapshot data from real DB or real fixtures |

**If a test cannot run without a mock**, it means the test
infrastructure is missing a prerequisite (DB connection, server
running, data repo available). The correct response is to mark the
test as requiring that prerequisite (`@pytest.mark.requires_db`,
`@pytest.mark.requires_server`), not to add a mock.

### 8.7 Test infrastructure requirements

- **Golden fixture generator** (TypeScript): a script that runs the
  FE resolution pipeline on real graphs from the data repo and emits
  `subject-resolution-golden.json` (resolved edges, param_ids, time
  bounds, read modes per analysis type). Run once to generate;
  committed to the repo. Used by BE parity tests to validate that
  the BE resolves identical subjects.

- **Data repo availability**: tests that load real graphs need the
  data repo path. Use `DATA_REPO_DIR` from `.private-repos.conf`.
  Skip gracefully if unavailable.

- **DB availability**: E2E tests need `DB_CONNECTION`. Skip
  gracefully if unavailable.

- **Server availability**: E2E tests need the Python server running.
  Mark with `@pytest.mark.requires_server`. Do not mock the server.

---

## 9. Migration path

### 9.1 Phase 1: BE path resolution + regime map lookup

Implement `resolve_analysis_subjects()` in Python. Extend
`graph_select.py` with `resolve_ordered_path()`. The function
parses the DSL, resolves the path, annotates first/last edges, and
looks up candidate regimes from the FE-provided
`candidate_regimes_by_edge` map. Run path resolution parity tests
(§8.2) and regime map coverage tests (§8.1). No callers changed
yet.

FE side: implement `candidate_regimes_by_edge` map construction —
iterate all edges in graph, compute candidate regimes per edge using
existing signature + hash + closure machinery. Run regime map
integrity tests.

### 9.2 Phase 2: Dual-path handler

Modify `_handle_snapshot_analyze_subjects()` to accept EITHER
pre-resolved `snapshot_subjects` (existing) OR `analytics_dsl` +
`analysis_type` + `candidate_regimes_by_edge` (new). When the new
fields are present, call `resolve_analysis_subjects()` internally.
Both paths produce the same internal representation and feed the
same derivation functions. Run subject resolution parity tests
(§8.3).

### 9.3 Phase 3: FE switches to new path

Update `analysisComputePreparationService` to send `analytics_dsl`
+ `candidate_regimes_by_edge` instead of `snapshot_subjects` for
all snapshot-aware analysis types. Run end-to-end parity tests
(§8.4). The old `snapshot_subjects` path remains available but
unused.

### 9.4 Phase 4: Multi-hop maturity

With the BE resolving paths natively, implement
`compose_path_maturity_frames()` (doc 29 §A.1). The BE identifies
first/last edges from the resolved path and composes them. No FE
changes needed — the FE sends the same `from(A).to(Z)` DSL
regardless of hop count. Run multi-hop topology tests (§8.5).

### 9.5 Phase 5: Dead code removal

Remove FE resolution pipeline (`snapshotDependencyPlanService` scope
rules, `snapshotSubjectResolutionService`, subject assembly logic).
Remove `snapshot_subjects` from the request type. Remove the
backward-compatible dual-path in the BE handler.

---

## 10. Sequencing relative to doc 30

Doc 30 is a prerequisite. The dependency:

| Doc 30 delivers | Doc 31 uses |
|---|---|
| `select_regime_rows()` utility | Called by BE after subject resolution |
| `candidate_regimes` on request | Passed through to regime selection |
| FE epoch machinery removed | Unblocks removing FE subject machinery |
| BE does per-date regime selection | BE does per-edge subject resolution |

Doc 31 Phase 1 (path resolution + regime map) can run in parallel
with doc 30 Phase 2–3 (wiring regime selection into BE paths). The
integration point is Phase 2 of doc 31, where the BE handler accepts
DSL-based requests — this requires doc 30's regime selection to
already be wired in.

Doc 31 Phase 4 (multi-hop maturity) requires both doc 30 (regime
selection prevents double-counting in composed frames) and doc 31
Phase 2 (BE resolves paths natively).

---

## 11. Open questions

1. **Hash mappings transport**: Option A (FE sends closures inline)
   keeps hash-mappings as FE-owned state. But the candidate regimes
   from doc 30 already contain equivalent hashes per regime. Does the
   BE need raw hash-mappings beyond what's in the candidate regimes?
   If not, Option A is sufficient indefinitely.

2. **Context registry on the BE**: The FE uses the context registry
   (MECE status per dimension) for candidate regime construction
   (doc 30). If the BE ever needs to construct candidate regimes
   itself (e.g. for Bayes automation without FE involvement), it
   would need access to context definitions. For now, FE-computed
   candidates are sufficient.

3. **Scope rule for `outcome_comparison` / `branch_comparison`**:
   These use `children_of_selected_node`, which requires knowing
   which node the user selected — not derivable from the DSL alone.
   The DSL for these types uses `visitedAny()` which names the child
   nodes. The BE can resolve children from the DSL's node list
   rather than from a "selected node" concept. Needs verification
   that the DSL always contains sufficient information.

4. **Backward compatibility duration**: How long should the
   dual-path handler (Phase 3) remain? Until all FE clients are
   updated, or permanently as a fallback? A permanent fallback adds
   maintenance cost but provides resilience.

5. **`candidate_regimes_by_edge` payload size**: Sending regimes for
   all edges in the graph adds to the request payload. For a graph
   with 50 edges and 3 regimes per edge, this is ~150 small objects
   (~50KB). Negligible for typical graphs. If graphs grow very large,
   the FE could filter to edges reachable from the anchor node — but
   this optimisation risks missing edges the BE needs for upstream
   traversal (see §6.1). Defer until a real problem exists.

---

## 12. Adversarial review

### 12.1 Gaps identified

**G1: `candidate_regimes` is still per-edge but the BE now resolves
edges.** Doc 30 §4.1 has the FE building candidate regimes per edge
(each regime has a core_hash computed from the edge's query
signature). If the BE resolves edges from the DSL, there appeared to
be a circular dependency: the FE needs edge identities to compute
per-edge hashes for candidate regimes, but the BE resolves edges.

**Resolution**: the FE computes candidate regimes for **all edges in
the graph**, not just the in-scope ones. The request includes a
`candidate_regimes_by_edge` map keyed by edge UUID. The BE resolves
which edges are on the path from the DSL, then looks up their
candidate regimes from the map the FE already sent.

This is cheap. A typical graph has tens of edges. Computing a
signature + core_hash + hash-mapping closure per edge per regime is
milliseconds — negligible compared to DB queries and derivation
compute. The FE already has the graph, the signature machinery, and
the hash mappings. Running it for all edges rather than just in-scope
ones adds trivial cost.

Doc 30's `CandidateRegime` stays exactly as designed — pre-computed
`core_hash`, `equivalent_hashes`, `slice_keys`, `regime_kind`. No
redesign needed. The only change is that the FE sends regimes for the
full graph rather than for a pre-resolved subset.

**G2: ~~Adapter options in signature computation.~~** RESOLVED — the
BE no longer computes signatures. The FE computes all signatures and
hashes for candidate regimes and ships them in
`candidate_regimes_by_edge`. The BE treats core_hashes as opaque DB
coordinates.

**G3: Workspace prefix in param_id.** The FE constructs param_id
as `${repo}-${branch}-${objectId}`. The BE receives the graph but
may not know the workspace prefix (repo-branch). The request must
include workspace identity or the param_id construction on the BE
will diverge.

**Impact**: Wrong param_id means wrong DB lookup coordinates.

**Mitigation**: Include workspace prefix in the request (it's
already present in the current request format — verify it persists
in the new format).

**G4: `perScenario` analysis types.** `outcome_comparison` and
`branch_comparison` have `perScenario: true` in their snapshot
contract, meaning each scenario can have different snapshot subjects
(because each scenario's graph may have different edges/topology
after what-if overlays).

**Status**: Partially resolved by doc 30 implementation. The FE's
`analysisComputePreparationService` already calls
`buildCandidateRegimesByEdge` per scenario's graph, so
`candidate_regimes_by_edge` is correct per-scenario. For doc 31,
the BE must also resolve subjects per-scenario (using each
scenario's graph). The request shape (§2.1) places
`candidate_regimes_by_edge` and `analytics_dsl` per-scenario, which
is correct.

**G5: The `surprise_gauge` special path.** In the current BE handler
(line 1223), `surprise_gauge` skips the normal snapshot query path
and reads model_vars directly from the graph edge. If the BE now
resolves subjects uniformly, this special case must be preserved —
surprise gauge needs the resolved edge (to read model_vars) but
doesn't need snapshot rows in the same way other types do.

**Impact**: If surprise gauge is forced through the standard
snapshot query path, it may fail or produce wrong results.

**Mitigation**: The `read_mode` field on the resolved subject still
controls dispatch. `sweep_simple` for surprise gauge routes to the
existing special handler. Subject resolution provides the edge
identity; the handler decides what to do with it.

**G6: The `bayes_fit` scope rule is `all_graph_parameters`.** This
is not path-based — it returns every parameter edge in the graph.
The resolved-path data structure (`ResolvedAnalysisPath` with
`from_node`, `to_node`, `ordered_edges`) doesn't fit this scope
rule. It needs a different return type.

**Impact**: The resolver either fails for `bayes_fit` or returns a
nonsensical path.

**Mitigation**: `resolve_analysis_subjects` should return a union
type: `ResolvedAnalysisPath` for path-based scope rules,
`ResolvedAnalysisSubjectSet` (unordered) for non-path scope rules.
Or: `ResolvedAnalysisPath` with optional from/to and optional
ordering — `all_graph_parameters` returns subjects with no path
structure.

### 12.2 Ambiguities identified

**A1: Which DSL does the BE parse?** The doc mentions both
`analytics_dsl` (`from(a).to(b)`) and `query_dsl`
(`from(a).to(b).window(-90d:)`). The analytics DSL defines the
graph scope (which nodes). The query DSL adds temporal constraints
(window/cohort bounds). Both are needed: analytics DSL for path
resolution, query DSL for time bounds and temporal mode. The doc
should make explicit that the BE uses analytics DSL for scope
resolution and query DSL for time bounds + signature computation.

**A2: What happens when from(A).to(B) is adjacent (single edge)?**
The resolved path has one edge where path_role is simultaneously
'first' and 'last'. The doc doesn't specify this. Multi-hop
composition must degenerate cleanly — test MH-1 covers this, but
the data structure needs to represent it.

**A3: ~~Candidate regimes per edge vs per path.~~** RESOLVED —
candidate regimes are per-edge, shipped in `candidate_regimes_by_edge`
keyed by edge UUID. Different edges may have different regime
structures (e.g. different connection types produce different
signatures). The BE looks up regimes per resolved edge from the map.
The FE computes them for all edges, so this is always correct
regardless of which edges the BE selects.

**A4: ~~Hash mappings scope.~~** RESOLVED — the BE does not compute
hashes or closures. The FE computes everything and ships it in
`candidate_regimes_by_edge`. No hash-mapping access needed on the BE.
The closures are guaranteed consistent because the same FE code that
produced the core_hash also produced the closure for that hash.

### 12.3 Risks

**R1: ~~Signature parity is harder than it looks.~~** RESOLVED — the
BE no longer computes signatures. The FE remains sole producer of
canonical signatures and core hashes. Cross-language serialisation
divergence is no longer a risk for this migration. (It remains a
concern for any future move to BE-side signature computation per
§4.3, but that is deferred.)

**R2: Regression risk during dual-path phase.** While both old
(FE-resolved) and new (BE-resolved) paths coexist, a bug in the
new path could silently produce wrong results if the handler
dispatches to the wrong path. The dual-path handler must log which
path was used so regressions are diagnosable.

**R3: Graph payload size.** The graph is already sent in the
request. But currently the FE pre-resolves subjects, so the BE only
needs the graph for parameter lookups (model_vars on edges). After
this change, the BE needs the full graph for topology traversal.
If graphs grow large, this could increase request latency.
Currently not a concern (graphs are typically <1MB) but worth
monitoring.

### 12.4 Decisions needed before implementation

1. ~~**G1 resolution**~~: RESOLVED — FE computes candidate regimes
   for all edges in the graph; BE selects the in-scope ones after
   resolving the path. No doc 30 redesign needed.

2. **A1 clarification**: confirm that BE uses analytics_dsl for scope
   resolution and query_dsl for time bounds extraction.

3. **G4 handling**: confirm per-scenario resolution for perScenario
   analysis types.

4. **G6 handling**: confirm the return type for non-path scope rules.
