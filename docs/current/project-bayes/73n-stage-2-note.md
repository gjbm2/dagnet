# 73n Stage 2 — Primitive Evidence Resolution — note

**Status**: Stage 2 landed
**Date opened**: 1-May-26
**Plan**: [`73n-carrier-evidence-conditioning-implementation-plan.md`](73n-carrier-evidence-conditioning-implementation-plan.md) §"Stage 2 — Primitive Evidence Resolution"
**Stage 0 baseline**: [`73n-stage-0-baseline.md`](73n-stage-0-baseline.md) §1.10 (building blocks), §3.1 (snapshot DB read contract), §3.2 (evidence-clock alignment contract)
**Stage 1 note**: [`73n-stage-1-note.md`](73n-stage-1-note.md)

---

## 1. Stage 2 deliverables

### 1.1. Prefix-arrival map module

[`graph-editor/lib/runner/prefix_arrival.py`](../../graph-editor/lib/runner/prefix_arrival.py) constructs the request-scoped `arrival_weight[node_id][calendar_day]` map on top of the existing `compose_carrier_to_x` / `compose_span_kernel` building blocks. Public surface:

- `PrefixArrivalIdentity` — request-scoped key covering `(scenario_id, request_root, context_key, regime_key, as_at, model_source_preference, parameter_fingerprint)`. The plan §145 primitive registry key plus the items Stage 0c §3.2 names as load-bearing for prefix-arrival construction. `cache_key` is a 16-char SHA-256 prefix.
- `NodeArrivalWeights` — per-node payload with `weights: Mapping[str, float]` (calendar-day → normalised probability), `reach_from_root`, and `NodeArrivalProvenance` recording topology case (`identity` / `composed` / `degraded`), composed edge count, latency presence, transition source, horizon ratio, and a free-text note.
- `PrefixArrivalMap` — frozen dataclass holding the identity, the per-node mapping, the original `root_day_weights` (normalised), and per-construction diagnostics (`composed_count`, `degraded_count`, `no_path_count`, `horizon_inadequate_count`).
- `build_prefix_arrival_map(*, graph, root_node_id, root_day_weights, transitions, identity, max_tau, target_node_ids=None)` — builder. The root entry is identity; non-root entries come from one `compose_carrier_to_x(root → node)` call per node. The conditional CDF returned is differenced into a delay PMF and convolved with the normalised root-day weights to produce calendar-day arrival mass. Per-node weights are normalised again so each entry sums to 1.0 within a node.

The module deliberately imports only from `carrier_composition` (which itself routes through `span_kernel`) plus stdlib (`hashlib`, `dataclasses`, `datetime`, `typing`) and `numpy`. It does NOT import from `forecast_runtime`, `forecast_state`, `cohort_forecast_v3`, `lag_distribution_utils`, or `span_evidence` — every prefix delay PMF flows through the same span/carrier composition layer that subject and carrier composition consume (plan §605, baseline §3.2).

### 1.2. Primitive evidence resolution module

[`graph-editor/lib/runner/primitive_evidence.py`](../../graph-editor/lib/runner/primitive_evidence.py) is the per-primitive binding layer. Public surface:

- `RetrievalSupersetSpec` — date envelope and metadata for one BE evidence retrieval pass.
- `derive_retrieval_superset(*, arrival_map, primitive_source_nodes, context_keys, regime_keys, as_at)` — computes the `(date_from, date_to)` envelope as the union of every primitive-local clock the request needs. Degraded source nodes contribute nothing (so the BE call is not widened to chase rows the primitive cannot live-use).
- `bind_primitive_evidence(*, transition, primitive_scope, evidence_scope, candidates, arrival_weights)` — calls `merge_evidence_candidates` (UNCHANGED) for raw `E`, then iterates the admitted points and weights each by `arrival_weights.weight_on(observed_date)` to produce a `WeightedPrimitiveEvidenceView`. Rows whose `observed_date` is off the primitive's local clock are rejected by binding — they belong to a different primitive in the same retrieval superset and must not leak (plan §621). WP8 default-off enforcement raises `PrimitiveBindingError` for any role other than `WINDOW_SUBJECT_HELPER`.
- `RequestPrimitiveRegistry` — pass-local owner of primitive resolution within one request. Bound to one `PrefixArrivalMap` (one identity); `register` computes a 24-char registry key keyed on `(transition identity, primitive scope, prefix-arrival identity)` so cross-request collisions are architecturally impossible (plan §145, §626). Duplicate registration (same primitive + same scope + same identity) raises `ValueError`. `to_provenance_dict()` emits the shadow primitive inventory (plan §"Stop condition" line 629).
- `validate_span_primitive(*, span, carrier_closure, subject_closure, request_slice_metadata, request_context_key, request_regime_key, request_as_at)` — refuses prepared span primitives that cross the `X` boundary (nodes split between carrier closure and subject closure) or mix incompatible slice / context / regime / as-at metadata (plan §123, §431, §619). Returns `SpanValidationResult(accepted, rejection_reason, suggested_fallback)`. The first 73n implementation prefers edge primitives; this validator exists so the fallback path is testable without wiring spans into the live registry.
- `make_primitive_scope_from_evidence_scope` — convenience to project an `EvidenceScope` onto a `PrimitiveScope`.

The module imports only from `evidence_merge` (for the unchanged merge call), `runner.prefix_arrival`, and `runner.primitives` (Stage 1 contract types). No imports from `forecast_runtime`, `forecast_state`, or `cohort_forecast_v3`; Stage 2 is dormant in the live request flow until Stage 3+ wire it in behind the migration choreography flags (plan §391-399).

### 1.3. Tests

#### 1.3.1. Prefix-arrival tests

[`graph-editor/lib/tests/test_prefix_arrival.py`](../../graph-editor/lib/tests/test_prefix_arrival.py) — 15 tests, all green. Coverage of the plan §609 evidence-clock invariants relating to the map itself:

| Test | Plan reference | Coverage |
|---|---|---|
| `test_window_clock_identity_root_equals_primitive_source` | §611 | window(X-Y): root entry equals normalised root day weights, including tau=0 |
| `test_cohort_clock_identity_a_equals_x_collapses_to_anchor_clock` | §611, §201 | cohort(A=X): root entry collapses to anchor clock |
| `test_non_latency_chain_preserves_root_clock_including_tau_zero` | §611 | all-non-latency prefix → arrival_weight equals root day weights |
| `test_deterministic_prefix_shifts_clock_by_exact_day_count` | §612 | deterministic prefix shifts arrival_weight by exact day count, keeps leading primitive on anchor day |
| `test_topological_map_builds_once_and_reuses_across_primitives` | §613, §195 | two primitives sharing source U get IDENTICAL `NodeArrivalWeights` object |
| `test_topological_map_does_not_invoke_carrier_composer_after_construction` | §613 | post-construction queries are pure dict reads (monkeypatched sentinel) |
| `test_contexted_source_changes_cache_key` | §614 | identity changes → cache_key differs (5 axes) |
| `test_stochastic_prefix_arrival_mean_matches_lognormal_mean` | §615 | latent prefix arrival_weight mean matches `exp(mu + σ²/2)` within ~1.5 days |
| `test_carrier_dag_diamond_arrival_weight_matches_composer_reach` | §616 | doc 29b upstream diamond: arrival_weight[X] reach + cumulative shape match `compose_carrier_to_x` |
| `test_subject_dag_fanout_subject_primitives_share_root_arrival` | §617 | downstream fan-out: all subject-side primitives' source nodes share map entries |
| `test_boundary_join_at_x_carrier_owns_upstream_primitives` | §618 | join at X owned by carrier_to_x (composed_edges ≥ 2 at X) |
| `test_boundary_split_at_x_subject_primitives_read_root_for_window_mode` | §618 | split at X: window-mode subject primitives read X as identity root |
| `test_no_second_timing_path_module_imports_only_existing_layer` | §605, §620 | static import audit — no second timing implementation introduced |
| `test_degraded_entry_carries_explicit_reason_for_no_path_node` | §605 | unreachable nodes get explicit degraded provenance, never silent zeros |
| `test_unnormalised_root_day_weights_are_normalised_within_each_entry` | (callability) | builder normalises root day weights before propagation |

#### 1.3.2. Primitive-evidence tests

[`graph-editor/lib/tests/test_primitive_evidence.py`](../../graph-editor/lib/tests/test_primitive_evidence.py) — 18 tests, all green. Coverage of the plan §609 invariants relating to per-primitive binding, the registry, retrieval superset, and span validation:

| Test | Plan reference | Coverage |
|---|---|---|
| `test_window_mode_weighted_totals_equal_raw_totals` | §"Stop condition" line 629 | window-mode weighted totals match raw totals (parity oracle precondition for Stage 5a) |
| `test_wp8_default_off_rejects_cohort_role` | §"Stop condition" line 629; baseline §1.13 | `DIRECT_COHORT_EXACT_SUBJECT` role raises `PrimitiveBindingError` |
| `test_weighted_view_weights_contradictory_days_by_arrival_weight` | §623 | uniform arrival_weight over two contradictory days → weighted totals reflect average |
| `test_weighted_view_skewed_arrival_weight_drives_skewed_k` | §623 | 80/20 arrival_weight → weighted rate 0.36, raw rate 0.6 (proves binding mixes by mass not by row) |
| `test_outside_in_anti_leak_downstream_primitive_conditions_on_shifted_day` | §627 | contradictory anchor-day vs shifted-day evidence → primitive binds shifted only |
| `test_as_at_admission_uses_retrieved_at_not_anchor_day` | §622, baseline §3.1 | retrieved_at gates as_at admission even when primitive day is past anchor |
| `test_retrieval_superset_envelopes_all_primitive_local_clocks` | §621, §326 | superset date span equals union of primitive-local clocks |
| `test_retrieval_superset_skips_degraded_source_nodes` | §621 | degraded nodes don't widen the BE retrieval envelope |
| `test_merge_evidence_candidates_signature_unchanged_for_non_primitive_callers` | §624, §565 | non-primitive callers see no behavioural change to `EvidenceSet` |
| `test_doc52_mass_inputs_come_from_weighted_view_not_retrieval_superset` | §625 | m_S = `n_weighted_total` from primitive-local rows, not retrieval-superset totals |
| `test_registry_key_includes_evidence_clock_alignment_identity` | §626 | two prefix-arrival identities produce different registry keys for the same primitive |
| `test_registry_within_one_request_dedupes_same_primitive_scope` | §314, §316 | duplicate registration raises `ValueError` |
| `test_span_primitive_crossing_x_boundary_is_rejected` | §123, §619 | span spanning carrier and subject closures rejected |
| `test_span_primitive_metadata_mismatch_is_rejected` | §431, §619 | span with mismatched context_key rejected |
| `test_span_primitive_in_carrier_closure_with_matching_metadata_is_accepted` | §123 | acceptance path |
| `test_registry_to_provenance_dict_emits_per_primitive_inventory` | §"Stop condition" line 629 | shadow inventory reviewable: per-primitive transition + topology + raw + weighted totals + identity cache key |
| `test_degraded_arrival_weight_yields_no_weighted_view_but_preserves_raw` | §605 | degraded arrival → no weighted view, raw E preserved, topology_case='degraded' diagnostic |
| `test_raw_and_weighted_evidence_are_explicitly_separate_even_when_equal` | §"Stop condition" line 629 | raw int n/k coexists with float n_weighted/k_weighted on a separate object |

### 1.4. What Stage 2 deliberately does NOT do

- **No live wiring.** `compute_forecast_trajectory`, `prepare_forecast_runtime_inputs`, `_resolve_frame_carrier_state`, `build_cohort_evidence_from_frames`, and `cohort_forecast_v3` are unchanged. The new modules are dormant until Stages 3-6 wire them in (plan §391-399 migration choreography).
- **No change to numerical conditioning.** The likelihood, IS resampling, and doc-52 blend remain at their existing call sites with their existing seeds. Stage 1's keyed-RNG seam covers retirement of those seeds; the actual cutover happens at Stage 3 (primitive_p_draws, primitive_timing_draws, primitive_is_resampling, primitive_drift, doc52_blend_permutation, primitive_completeness_sd) and Stage 5b (subject_span / anchor_relative_edge / last_edge_frontier MC seeds).
- **No change to `merge_evidence_candidates`.** The shared merge layer's contract for non-primitive callers (Bayes Phase 1 / Phase 2, the BE CF adapter, the as-at reconstruction adapter, the Bayes parameter-file adapter) is byte-for-byte preserved. The weighted view is constructed AFTER merge by primitive_evidence.py and is confined to primitive callers.
- **No empirical Tier 2 / `build_upstream_carrier` retirement.** Plan §284 lists this as a Stage 6 retirement target; Stage 2 only provides the substrate that Stage 6 will consume.
- **No retrieval-pass implementation.** `derive_retrieval_superset` returns a spec; the actual BE call into `query_snapshots_for_sweep` and the per-primitive binding orchestration are Stage 3 deliverables. Stage 2 owns the contract; Stage 3 owns the orchestration.

---

## 2. Stop-condition discharge

Plan §"Stage 2" stop condition (line 629):

> primitive evidence totals match existing window evidence totals for simple window queries; downstream `cohort()` primitive evidence scopes show prefix-clock-weighted local evidence clocks where appropriate; supported carrier-DAG and subject-DAG fixtures use the same doc 29b/span-kernel topology algebra as the shared span/carrier composer; prepared span primitives, if used, obey regime-boundary and metadata compatibility rules or fall back to edge primitives; no cohort-family rows are admitted while WP8 is default-off; the shadow primitive inventory is reviewable; raw `E`, weighted evidence view, and effective `e` are stored separately even when they are numerically equal; and diagnostics show the retrieval superset, the contexted scenario/root prefix-arrival map, topology case, and the per-primitive binding decision.

| Stop-condition clause | Discharge |
|---|---|
| Window-mode weighted totals match raw window totals | `test_window_mode_weighted_totals_equal_raw_totals`. Stage 5a's parity oracle precondition. |
| Downstream `cohort()` primitive scopes use prefix-clock-weighted local clocks | `test_cohort_clock_identity_a_equals_x_collapses_to_anchor_clock`, `test_deterministic_prefix_shifts_clock_by_exact_day_count`, `test_stochastic_prefix_arrival_mean_matches_lognormal_mean`, `test_outside_in_anti_leak_downstream_primitive_conditions_on_shifted_day`. |
| Carrier-DAG and subject-DAG fixtures use shared span/carrier algebra | `test_carrier_dag_diamond_arrival_weight_matches_composer_reach` compares cumulative shape with `compose_carrier_to_x` directly; `test_subject_dag_fanout_subject_primitives_share_root_arrival`; `test_no_second_timing_path_module_imports_only_existing_layer` (static import audit). |
| Prepared spans obey regime-boundary / metadata or fall back | `test_span_primitive_crossing_x_boundary_is_rejected`, `test_span_primitive_metadata_mismatch_is_rejected`, `test_span_primitive_in_carrier_closure_with_matching_metadata_is_accepted`. |
| No cohort-family rows admitted while WP8 default-off | `test_wp8_default_off_rejects_cohort_role`. The binder raises `PrimitiveBindingError` for `DIRECT_COHORT_EXACT_SUBJECT` regardless of candidates supplied. |
| Shadow primitive inventory reviewable | `test_registry_to_provenance_dict_emits_per_primitive_inventory`. The dump records identity cache key, per-primitive transition, topology case, raw + weighted totals, off-clock rejection counts, plus arrival map construction diagnostics. |
| Raw E, weighted view, and effective e stored separately even when equal | `test_raw_and_weighted_evidence_are_explicitly_separate_even_when_equal`. EvidenceSet keeps int totals; WeightedPrimitiveEvidenceView holds float weighted totals on a separate object with `binding_policy='weighted_day_binding.v1'`. Stage 1's `SubsetPolicyProvenance.equality_explicit` flag is the explicit-equality marker that Stage 3 will populate. |
| Diagnostics show retrieval superset, prefix-arrival map, topology case, per-primitive binding decision | `test_retrieval_superset_envelopes_all_primitive_local_clocks` (superset extents per primitive), `test_registry_to_provenance_dict_emits_per_primitive_inventory` (per-primitive topology + binding decision + map diagnostics roll-up). |

---

## 3. Reach-back to other documents

### 3.1. Stage 0c contract → Stage 2 implementation

| Stage 0c §3.2 contract item | Stage 2 deliverable |
|---|---|
| Single retrieval pass envelope (union of primitive-local clocks) | `derive_retrieval_superset` |
| `arrival_weight[node_id][calendar_day]` map identity | `PrefixArrivalIdentity` (7-tuple matching the listed identity dimensions) |
| Source of truth for prefix delay PMFs | `compose_carrier_to_x` invocation per non-root node; static-import audit (`test_no_second_timing_path_module_imports_only_existing_layer`) confirms no alternative provider |
| DAG topology coverage (doc 29b cases 1-9) | Inherited from `compose_carrier_to_x`'s DAG algebra; tested via `test_carrier_dag_diamond_arrival_weight_matches_composer_reach` (case 2 — upstream diamond) and `test_subject_dag_fanout_subject_primitives_share_root_arrival` (case 4 — fan-out) |
| `as_at()` × primitive-local clocks rule (`retrieved_at <= as_at` regardless of primitive day) | `test_as_at_admission_uses_retrieved_at_not_anchor_day` proves the merge layer's existing rule survives binding, and the off-clock rejection for primitive-local days continues to gate independently |

### 3.2. Stage 1 contract → Stage 2 instances

| Stage 1 type | First Stage 2 instance |
|---|---|
| `WeightedPrimitiveEvidenceView` | Built by `bind_primitive_evidence`, stored on `PrimitiveEvidenceResolution.weighted_view` |
| `WeightedEvidenceRow` | Per admitted point, `n_weighted` and `k_weighted` populated from `arrival_weight[U][observed_date]` |
| `PrimitiveScope` | Constructed by `make_primitive_scope_from_evidence_scope` from the existing `EvidenceScope` |
| `TransitionIdentity` | Constructed by callers; passed through to `bind_primitive_evidence` and onto the registry key |
| `DrawFamilyKey` | NOT instantiated yet — Stage 3 owns posterior construction and seed retirement at the conditioning sites |

### 3.3. Inherited test baseline

The four 73n flip-to-green strict-xfails in `test_cohort_factorised_outside_in.py` (baseline §1.13) remain xfailed after Stage 2; they target Stage 5a/5b/5c/6 cutover, not Stage 2. The pre-existing RED `test_v3_midline_at_saturation_converges_to_p` (1 failure, midpoint=0.5766 vs p_inf=0.6788) is unchanged from the baseline — Stage 2 introduces no live behaviour and cannot have moved it. Stage 1's seed-retirement strict-xfails (11 sites) remain xfailed; Stage 3 retires the trajectory-engine seeds, Stage 5b retires the runtime-input MC seeds, Stage 6 retires the legacy upstream-carrier seed.

---

## 4. Suggested commit messages (per atom)

The skill does not commit. The following commit messages are suggested for each atom; the user decides timing and granularity.

| Atom | Files | Suggested message |
|---|---|---|
| 1 | `graph-editor/lib/runner/prefix_arrival.py` | `73n stage 2: prefix_arrival module — request-scoped arrival_weight[node][day] map (§605)` |
| 2 | `graph-editor/lib/tests/test_prefix_arrival.py` | `73n stage 2: prefix_arrival tests — clock identity, deterministic shift, topological reuse, DAG fixtures (§609-620)` |
| 3 | `graph-editor/lib/runner/primitive_evidence.py` | `73n stage 2: primitive_evidence module — bind, retrieval superset, registry, span validator (§597-629)` |
| 4 | `graph-editor/lib/tests/test_primitive_evidence.py` | `73n stage 2: primitive_evidence tests — weighted view, retrieval superset, as-at, anti-leak, mass accounting, registry-key (§621-627)` |
| 5 | `docs/current/project-bayes/73n-stage-2-note.md`, `docs/current/project-bayes/73n-carrier-evidence-conditioning-implementation-plan.md` | `73n stage 2: stage-2 note + mark stage 2 complete in progress block` |

---

## 5. What unblocks for later stages

- **Stage 3 (Subset and Primitive Conditioning Policy)** can now consume the shared `PrimitiveEvidenceResolution` per primitive: raw `EvidenceSet`, `WeightedPrimitiveEvidenceView`, `PrimitiveBindingDiagnostics`. It owns the maturity-aware likelihood retirement of the trajectory-engine seeds (Stage 0a §1.12 retirement targets at `forecast_state.py:193`, `:1031`, `:1367`, `:653`/`:731`) onto `make_rng(key, derivation)` derivations registered by Stage 1, the e == E case via `SubsetPolicyProvenance.equality_explicit`, and the m_S/m_G/r computation per §625.
- **Stage 5a (Single-Hop Window and Subject Cutover)** can read its parity oracle from `bind_primitive_evidence` directly, since window-mode weighted totals already equal raw window totals (`test_window_mode_weighted_totals_equal_raw_totals`).
- **Stage 5b/5c (multi-hop)** can compose subject spans by enumerating subject-side primitives whose source nodes have entries in the prefix-arrival map (`test_subject_dag_fanout_subject_primitives_share_root_arrival`), reading bound primitive posteriors from the `RequestPrimitiveRegistry` rather than re-resolving evidence per primitive (plan §143).
- **Stage 6 (Carrier Consumer)** can read carrier-side primitives from the same registry (the validator and binding layer are already shared across carrier and subject closures); the legacy `_resolve_frame_carrier_state` / `build_upstream_carrier` retirement target lands here.
- **Stage 7 (caching)** has the registry's `_registry_key` shape to seed any persistent cache; the `PrefixArrivalIdentity.cache_key` is a stable 16-char digest suitable for cross-request reuse keys when caching becomes desirable.
- **Stage 8 (projection diagnostics)** can call `RequestPrimitiveRegistry.to_provenance_dict()` for the shadow primitive inventory and roll it into the CF response provenance block.
