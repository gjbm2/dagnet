# Forecast Preparation

**Status**: Active reference, 13-May-26
**Scope**: the BE preparation layer that sits between HTTP dispatch and the v3 runtime — subject resolution, snapshot fetch with regime selection, frame composition, and request-envelope construction. Companion to [FORECAST_RUNTIME_ARCHITECTURE.md](FORECAST_RUNTIME_ARCHITECTURE.md) (the runtime that consumes this layer's output) and [FORECAST_STACK_DATA_FLOW.md](FORECAST_STACK_DATA_FLOW.md) (the surrounding I/O contracts).

This doc covers the modules `analysis_subject_resolution.py` and `forecast_preparation.py` plus the `request_envelope.py` boundary. Without it the runtime docs read as if the runtime materialises from nothing; in fact the runtime's inputs are produced by a four-stage pipeline that owns DSL parsing, snapshot DB I/O, regime selection, frame composition, and the request-scoped fetch envelope.

---

## 1. Position in the stack

```
   HTTP route                  api_handlers.handle_runner_analyze
        │
        │  dispatch (analysis_type → handler)
        ▼
   handler (_handle_cohort_maturity_v3, _handle_conditioned_forecast, …)
        │
        │  per scenario:
        ▼
   ┌─────────────────────────────────────────────────────────────┐
   │ PREPARATION  (this doc)                                     │
   │                                                             │
   │  1. resolve_forecast_subjects                               │
   │       (DSL → subjects with candidate regimes)               │
   │                                                             │
   │  2. prepare_forecast_subject_group                          │
   │       2a. envelope plan construction                        │
   │       2b. per-subject snapshot fetch + regime selection     │
   │       2c. per-edge cohort-maturity derivation               │
   │       2d. compose_path_maturity_frames                      │
   │                                                             │
   │  returns ForecastPreparation                                │
   └─────────────────────────────────────────────────────────────┘
        │
        │  ForecastPreparation (composed_frames, per_edge_results,
        │                       envelope_plan, anchor_node, …)
        ▼
   RUNTIME                cohort_forecast_v3.compute_cohort_maturity_rows_v3
                          → build_resolved_cf_runtime
                          → primitive_readout.compute_resolved_runtime_readout
```

Every snapshot-backed analysis goes through the same preparation entry points; the only difference is which downstream consumer reads the result. The v3 row builder and the conditioned-forecast endpoint share this layer entirely.

---

## 2. Stage 1 — Subject Resolution

**Module**: `graph-editor/lib/analysis_subject_resolution.py`
**Entry point**: `resolve_analysis_subjects(graph, query_dsl, analysis_type, candidate_regimes_by_edge)`
**Wrapper used by forecast consumers**: `forecast_preparation.resolve_forecast_subjects`

### 2.1 What it does

Takes the request's DSL string, the graph, and the FE-computed `candidate_regimes_by_edge` map. Parses the DSL, walks the graph under a scope rule chosen by analysis type, and returns a list of typed `ResolvedAnalysisSubject` records — one per parameterised edge in scope, each carrying its candidate regimes.

### 2.2 The three scope rules

`ANALYSIS_TYPE_SCOPE_RULES` ([analysis_subject_resolution.py:71-84](graph-editor/lib/analysis_subject_resolution.py#L71-L84)) maps each analysis type to one of three scope rules:

| Scope rule | Resolver | Returns |
|---|---|---|
| `funnel_path` | `_resolve_funnel_path` → `graph_select.resolve_ordered_path` | Ordered edges on every path from(A) to(B); subjects carry `path_role ∈ {'first','last','intermediate','only'}` |
| `children_of_selected_node` | `_resolve_children` → `graph_select.resolve_children_edges` | All outgoing edges from one node; subjects carry `path_role='child'` |
| `all_graph_parameters` | `_resolve_all_parameters` → `graph_select.resolve_all_parameter_edges` | Every parameterised edge in the graph; subjects carry `path_role='all'` |

`cohort_maturity*`, `daily_conversions`, `conversion_rate`, `lag_histogram`, `lag_fit`, `surprise_gauge` all use `funnel_path`. `conditioned_forecast` and `bayes_fit` use `all_graph_parameters`.

### 2.3 The two read modes

`ANALYSIS_TYPE_READ_MODES` ([analysis_subject_resolution.py:86-99](graph-editor/lib/analysis_subject_resolution.py#L86-L99)) labels the temporal evidence shape each type expects:

| Read mode | Used by | Sweep semantics |
|---|---|---|
| `cohort_maturity` | `cohort_maturity*`, `conditioned_forecast` | sweep_from = earliest anchor day; sweep_to capped at `asat` |
| `raw_snapshots` | `daily_conversions`, `lag_histogram`, `outcome_comparison`, `branch_comparison`, `conversion_rate` | No sweep bounds — raw rows only |
| `sweep_simple` | `lag_fit`, `surprise_gauge`, `bayes_fit` | sweep_from = anchor_from; sweep_to capped at `asat` |

`_resolve_sweep_bounds` ([analysis_subject_resolution.py:458](graph-editor/lib/analysis_subject_resolution.py#L458)) applies the asat cap honouring [DATE_MODEL_COHORT_MATURITY.md](DATE_MODEL_COHORT_MATURITY.md) — without this, sweep_to would default to today and silently include data the user pinned out via `asat()`.

### 2.4 DSL parsing within this stage

Subject resolution uses three DSL extraction surfaces. See [DSL_PARSING_ARCHITECTURE.md](DSL_PARSING_ARCHITECTURE.md) for the canonical reference (including the Python-side parsers).

- `query_dsl.parse_query()` — the formal grammar parser. Handles `from()`, `to()`, `visited()`, `window()`, etc. **Does not parse `cohort()`** — that's the historical reason for the auxiliary regex extractors below.
- `_extract_temporal_mode()` ([:398](graph-editor/lib/analysis_subject_resolution.py#L398)) — returns `'cohort'` / `'window'` / `None` by string match on the raw DSL.
- `_extract_time_bounds()` ([:474](graph-editor/lib/analysis_subject_resolution.py#L474)) — regex-extracts `anchor_from` / `anchor_to` from `window(start:end)` or `cohort([anchor,]start:end)`. The optional `anchor,` prefix is the [AP31](DSL_PARSING_ARCHITECTURE.md#anti-pattern-31-regex-not-handling-optional-prefixes-in-dsl-clauses) defect site; the current regex (line 492) handles it correctly.

A second regex extractor, `_extract_cohort_anchor_node()` in `forecast_preparation.py:245`, pulls *just* the anchor node from `cohort(anchor,start:end)` for the subject-resolution callsite. Different concern from `_extract_time_bounds` (anchor vs dates); co-located by necessity since the formal parser doesn't own `cohort()` yet.

### 2.5 Output: `synthesise_snapshot_subjects`

After scope resolution, `synthesise_snapshot_subjects(result, analysis_type)` projects each `ResolvedAnalysisSubject` into the `snapshot_subjects` dict shape the downstream preparation expects. Each dict carries:

- `param_id`, `core_hash`, `equivalent_hashes`, `candidate_regimes`
- `from_node`, `to_node`, `path_role`
- `anchor_from`, `anchor_to`, `sweep_from`, `sweep_to`
- `target.targetId` (edge UUID)
- `anchor_node_id` (set later by `resolve_forecast_subjects` if `cohort(anchor,...)` is present)

### 2.6 Legacy fallback

`resolve_forecast_subjects` ([forecast_preparation.py:166](graph-editor/lib/runner/forecast_preparation.py#L166)) wraps `resolve_analysis_subjects` and falls back to `scenario.snapshot_subjects` ([:237](graph-editor/lib/runner/forecast_preparation.py#L237)) if subject resolution returns empty. This is for old clients that send pre-computed snapshot_subjects directly. New code should not rely on this path.

---

## 3. Stage 2 — Snapshot Fetch and Regime Selection

**Module**: `graph-editor/lib/runner/forecast_preparation.py`
**Entry point**: `prepare_forecast_subject_entry` (per subject) — called by `prepare_forecast_subject_group` for each subject in the group.

### 3.1 What it does

For each subject:
1. Query the snapshot DB for the subject's `(param_id, core_hash, anchor_from, anchor_to, sweep_from, sweep_to)` coordinates, including `equivalent_hashes` to widen the fetch across regime equivalents.
2. Apply temporal regime selection to pick one regime family per retrieved date.
3. Run `derive_cohort_maturity` over the surviving rows to produce per-edge derivation frames.

### 3.2 Regime selection

`apply_temporal_regime_selection` ([:47](graph-editor/lib/runner/forecast_preparation.py#L47)) is the core selector. The snapshot DB may return rows for multiple regime families (window-anchored vs cohort-anchored) — they have distinct `core_hash` values. The selector ranks the requested temporal mode first, then delegates to `snapshot_regime_selection.select_regime_rows` to pick one regime per retrieved date.

Anchor matching: if a `cohort(anchor,...)` clause specifies an explicit anchor node, cohort-mode candidates whose `cohort_anchor` doesn't match are excluded ([:104-106](graph-editor/lib/runner/forecast_preparation.py#L104-L106)). Unanchored cohort candidates are still admissible (they represent the app's convention-derived anchor).

`flatten_candidate_regime_hashes` ([:120](graph-editor/lib/runner/forecast_preparation.py#L120)) flattens the candidate-regimes list into one primary hash plus equivalents, mirroring the synthesis in `analysis_subject_resolution`. The DB query can then return rows across every candidate regime family in one shot.

### 3.3 Per-edge cohort-maturity derivation

After regime selection, `runner.cohort_maturity_derivation.derive_cohort_maturity(rows, sweep_from, sweep_to)` runs over the surviving rows and produces the per-edge derivation result: per-anchor-day x/y/a frames, anchor-day → tau-observed map, cohort statistics. This is the per-edge half of the frame stream; the multi-edge composition happens in Stage 3.

### 3.4 Output shape per subject

```
{
  "raw_row_count": int,
  "regime_diagnostic": {                  # for response provenance
    "from_node", "to_node", "path_role",
    "pre_rows", "post_rows",
    "n_candidates", "candidate_modes",
    "hashes_surviving", "candidate_hashes",
    ...
  },
  "per_edge_result": {                    # for stage 3 + runtime
    "path_role", "from_node", "to_node",
    "subject": {…},                       # the original snapshot subject dict
    "snapshot_covered_days": set[str],
    "evidence_superset_rows": list,       # post-regime-selection rows
    "derivation_result": {…}              # per-anchor x/y/a frames
  }
}
```

The `evidence_superset_rows` field is load-bearing: it is what the runtime later translates into `EvidenceCandidate`s via `build_superset_candidates_by_edge`. The runtime never re-fetches.

---

## 4. Stage 3 — Frame Composition

**Module**: `graph-editor/lib/runner/span_evidence.py`
**Entry point**: `compose_path_maturity_frames(per_edge_results, query_from_node, query_to_node, anchor_node)`

### 4.1 What it does

Takes the per-edge derivation results from Stage 2 and merges them into a single multi-edge frame stream. Each frame is one snapshot date carrying the joint observed state across the whole `from → to` path: `data_points = [{anchor_day, x, y, a}, …]`.

For single-edge paths this is mostly a passthrough (`composed.frames` matches the lone edge's derivation frames). For multi-hop paths the composer aligns cohorts by anchor day, propagates x through chain reach, and reports `cohorts_analysed` as the number of distinct cohorts with composed data.

### 4.2 Single-subject fallback

If only one subject was prepared and it lacks `from_node`/`to_node` metadata (rare; happens with legacy `snapshot_subjects`), the prep skips the composer and surfaces the lone derivation's frames directly ([forecast_preparation.py:652-669](graph-editor/lib/runner/forecast_preparation.py#L652-L669)). This keeps minimal cohort handlers emitting frames even when path composition is impossible.

---

## 5. Stage 4 — Envelope Plan Construction

**Module**: `graph-editor/lib/runner/request_envelope.py`
**Entry point**: `build_request_envelope_plan(graph, query_from_node, query_to_node, anchor_node_id, anchor_from, anchor_to, is_window, …)`

### 5.1 What it does

Builds a `RequestEnvelopePlan` for the request, owning:
- `subject_arrival_map` — X-rooted prefix arrival map for subject primitives
- `carrier_arrival_map` — A-rooted prefix arrival map for carrier primitives (active mode only)
- per-edge fetch bounds (`by_edge_uuid`, `by_edge_id`) — derived from the arrival maps' support, used to override the public-window anchor bounds at fetch time

This is the structural replacement for the historical 73n "in-runtime widening" (the runtime would issue a second DB call to widen the fetch retroactively). The envelope plan computes the widened bounds once, up-front, from the topology — the snapshot fetch then uses those bounds and no second call is needed.

See [`docs/current/snapshot-fetch-envelope-design.md`](../snapshot-fetch-envelope-design.md) for the algebra (two-clocks split: subject roots = carrier's X-arrival days; carrier roots = cohort A-anchor range; donor lookback is diagnostic).

### 5.2 Two construction sites — known debt

The envelope plan can be built in two places:

1. **Preparation layer** (canonical): `prepare_forecast_subject_group` ([forecast_preparation.py:574-596](graph-editor/lib/runner/forecast_preparation.py#L574-L596)) builds the plan when the caller doesn't supply one, then threads it forward to each subject's fetch.

2. **Runtime inline fallback**: `build_resolved_cf_runtime` ([cohort_forecast_v3.py:1353-1376](graph-editor/lib/runner/cohort_forecast_v3.py#L1353-L1376)) builds the plan inline in active mode when `envelope_plan is None`. This is the "legacy/test entry points still work" path the runtime's docstring mentions ([:1261-1262](graph-editor/lib/runner/cohort_forecast_v3.py#L1261-L1262)).

Both paths call `build_request_envelope_plan` with the same arguments, but the duplication is real: same construction logic, two sites. Production requests go through the preparation layer; tests and legacy callers occasionally trigger the runtime inline. This is tracked as case-fork debt in [CF_DEFENSIVE_FINDINGS.md](CF_DEFENSIVE_FINDINGS.md) and should consolidate when every caller routes through preparation.

### 5.3 Window mode

For `window()` queries the envelope plan leaves arrival maps unset (per Appendix A's local-clock binding contract); the runtime builds an identity X-rooted subject map inline ([cohort_forecast_v3.py:1380-1402](graph-editor/lib/runner/cohort_forecast_v3.py#L1380-L1402)). This is data degeneracy, not a separate path: window mode = cohort(A=X) with identity carrier.

---

## 6. The `ForecastPreparation` contract

`prepare_forecast_subject_group` returns one `ForecastPreparation` dataclass ([forecast_preparation.py:24](graph-editor/lib/runner/forecast_preparation.py#L24)):

| Field | Read by | Notes |
|---|---|---|
| `query_from_node` | runtime, response | First subject's source node (path role `first`/`only`) |
| `query_to_node` | runtime, response | Last subject's destination (path role `last`/`only`) |
| `anchor_node` | runtime | Either explicit from DSL (`cohort(anchor,...)`) or resolved via `_resolve_anchor_node` (furthest upstream start node reachable from the target edge's `from`) |
| `last_edge_id` | runtime | Edge UUID of the subject path's terminal edge — the target for model param resolution |
| `is_multi_hop` | runtime, row builder | `True` if more than one subject |
| `anchor_from`, `anchor_to`, `sweep_to` | runtime, row builder | Public-window temporal bounds (not the envelope bounds) |
| `total_rows`, `cohorts_analysed` | response diagnostics | Aggregate counts |
| `per_edge_results` | runtime | The Stage 2 per-edge dicts — translated to candidates by `build_superset_candidates_by_edge` |
| `composed_frames` | row builder | The Stage 3 multi-edge frame stream — input to `build_cohort_evidence_from_frames` |
| `regime_diagnostics` | response | Per-subject regime selection trace |
| `envelope_plan` | runtime | Optional `RequestEnvelopePlan`; runtime falls back to inline construction if None (§5.2) |

### 6.1 Anchor resolution

`_resolve_anchor_node` ([forecast_preparation.py:266](graph-editor/lib/runner/forecast_preparation.py#L266)) handles the case where the DSL doesn't carry an explicit anchor. It walks the graph backward from the target edge's `from` node, finds reachable start nodes (nodes with `entry.is_start = true`), picks the **furthest** one (max BFS distance, tie-broken alphabetically). This is the "where did this population originate?" question; in single-source graphs it's deterministic.

If the target edge's `from` is already a start node, that's the anchor. If no start nodes are reachable, the anchor is `None` and the request will be treated as window mode.

---

## 7. What this layer does NOT do

- **Does not condition or run inference.** All conditioning happens in `primitive_conditioning.condition_primitive`. The preparation layer translates request inputs into evidence-superset rows; the runtime translates rows into typed candidates and conditions primitives.
- **Does not read graph-side evidence fields** (`p.evidence.*`, `_bayes_evidence`, etc.). The preparation layer only reads snapshots from the DB.
- **Does not pick a model source.** Source selection (bayesian vs analytic) happens at the runtime layer via `resolve_model_params`. The preparation layer threads `graph_preference` through to the envelope plan only.
- **Does not own the response envelope.** The response shape is owned by the handler (`api_handlers._handle_cohort_maturity_v3` etc.); preparation produces input for the row builder, not the response payload.
- **Does not run the row pipeline.** Frame composition produces frames; the row pipeline ([CF_ROW_PIPELINE.md](CF_ROW_PIPELINE.md)) consumes them.

---

## 8. Where to read next

- [FORECAST_RUNTIME_ARCHITECTURE.md](FORECAST_RUNTIME_ARCHITECTURE.md) — what `ForecastPreparation` flows into.
- [FORECAST_STACK_DATA_FLOW.md](FORECAST_STACK_DATA_FLOW.md) — the I/O contracts surrounding this layer (especially I10, I11, I12).
- [DSL_PARSING_ARCHITECTURE.md](DSL_PARSING_ARCHITECTURE.md) — DSL parsing on both FE (TypeScript) and BE (Python) sides; AP31 anti-pattern.
- [DATE_MODEL_COHORT_MATURITY.md](DATE_MODEL_COHORT_MATURITY.md) — anchor / sweep / asat semantics.
- [`docs/current/snapshot-fetch-envelope-design.md`](../snapshot-fetch-envelope-design.md) — the envelope plan's algebra and the two-clocks split.
- [CF_MAP.md](CF_MAP.md) — file → role map across the full CF cluster.
