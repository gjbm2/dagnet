# 73n Stage 0 baseline note

Companion to [`73n-carrier-evidence-conditioning-implementation-plan.md`](73n-carrier-evidence-conditioning-implementation-plan.md). Records baseline state, surfaces, line numbers, and tolerances at the entry of each 73n stage. Stage 0 is split into 0a, 0b, 0c per the plan; each sub-stage adds its own section here.

This note is documentation-only. No code or test changes are made by Stage 0 work. Later stages cite specific 0a/0b/0c artefacts here, not "Stage 0" generically.

Inherits the handoff package from [`73m-stage-0-baseline.md`](73m-stage-0-baseline.md). Cross-references in the form `73m §<n>` resolve there; cross-references in the form `plan §"<heading>"` resolve to 73n's plan doc.

## 1. Stage 0a — Code inventory and precondition check — added 1-May-26

Stage 0a records the current conditioning sites, line numbers, topology surface, and 73m precondition state. Documentation-only, no source-code or test edits. Outputs are the contracts Stages 1–9 are bound by; later stages must cite this section, not "Stage 0" generically.

### 1.1. 73m precondition state

73m completed all eight stages on 1-May-26 (see [`73m-carrier-composition-and-router-unification-implementation-plan.md`](73m-carrier-composition-and-router-unification-implementation-plan.md) Implementation progress block). Each precondition the 73n plan §"Preconditions" demands has been verified against the working tree:

- **No live latency/non-latency router owns v3 cohort_maturity semantics.** Confirmed. The legacy router fork that previously dispatched non-latency targets to `_non_latency_rows` was retired by 73m Stage 5. The retirement is documented in [`graph-editor/lib/runner/cohort_forecast_v3.py:1065-1082`](../../graph-editor/lib/runner/cohort_forecast_v3.py) (comment block). All cohort_maturity v3 rows now flow through `compute_forecast_trajectory` invoked from `compute_cohort_maturity_rows_v3` near `cohort_forecast_v3.py:1180` onwards. The trajectory-engine return is read at `cohort_forecast_v3.py:1252-1396` for per-τ row assembly.
- **Subject-span composition is the live `X → end` object** for both single-hop and multi-hop subjects. Entry sites: `forecast_runtime.py:300` (`build_prepared_span_execution_from_topology`), `forecast_runtime.py:375` (`build_prepared_span_execution`), `span_kernel.py:291` (`compose_span_kernel`). Single-hop is the degenerate one-edge case of the same kernel (no separate code path).
- **Carrier composition is the live `A → X` object for active `cohort(A != X)`.** Canonical composer: [`graph-editor/lib/runner/carrier_composition.py:164`](../../graph-editor/lib/runner/carrier_composition.py) (`compose_carrier_to_x`). Used by `forecast_runtime.py:946,955` (`build_x_provider_from_graph`, 73m Stage 3) and `forecast_state.py:401,425` (`build_node_arrival_cache`, 73m Stage 3). Both sites use the semantic active gate `enabled = (reach > 0 and A != X)` defined near `forecast_runtime.py:937-939`.
- **Empirical Tier 2 is no longer the live conditioning mechanism on the corrected CF path.** The composed `compose_carrier_to_x` is the canonical live carrier writer for whole-graph CF and for `XProvider.carrier_to_x`. The remaining empirical-tier surface is the scoped frame path through `_resolve_frame_carrier_state` (see §1.3 below); 73m treats this as a documented 73n handoff gap, not as a closed precondition. This matches plan §"Preconditions" lines 33–35.

### 1.2. Subject-span / carrier composition live runtime objects

`PreparedForecastRuntimeBundle` (`forecast_runtime.py:122-137`) carries the resolved CF runtime objects for one subject:

- `PreparedCarrierToX` — denominator-side `A → X` arrival object.
- `PreparedSubjectSpan` — numerator-side `X → end` progression kernel.
- `PreparedConditioningEvidence` — `forecast_runtime.py:103-110`. Fields: `temporal_family` (`'window'` | `'cohort'`), `source` (`'none'` | `'frame_evidence'` | `'direct_cohort_exact_subject'` | `'snapshot_frames'`), `evidence_points`, `total_x`, `total_y`. Constructed by `build_prepared_runtime_bundle` (`forecast_runtime.py:269-272`); populated by `cohort_forecast_v3.py:1050-1062`; consumed by `api_handlers.handle_conditioned_forecast` for response construction (`evidence_n` ← `total_x`, `evidence_k` ← `total_y` near `api_handlers.py:2421-2423`).
- `PreparedAdmissionPolicy` — gross-fitted-evidence admissibility (numerator_representation, whole_query_numerator_admitted, subject_helper_admitted, helper_reason).
- `runtime_bundle_diag` (Optional[Dict]) — populated by `serialise_runtime_bundle` in `forecast_runtime.py` with carrier-to-X cdf_source / horizon / transition_source labels and the `legacy_non_latency_router_bypassed` flag (always `True` post-73m Stage 5).

The trajectory engine reads the bundle at `forecast_state.py:compute_forecast_trajectory` and consumes the prepared subject-span object as `mc_cdf_arr` and `det_norm_cdf` near `:1055-1062`. The σ ≤ 0 early-return guard at `forecast_state.py:1062` only fires when **both** terminal-edge `lat.sigma ≤ 0` **and** no prepared subject-span CDF is available — the Stage 4 (73m) narrowing that removed the 73h "computed and discarded" pattern.

### 1.3. Carrier construction sites — canonical vs scoped vs legacy

| Site | File:line | Status |
|---|---|---|
| Whole-graph CF carrier writer | `forecast_runtime.py:946,955` (`build_x_provider_from_graph`) calls `compose_carrier_to_x` | **canonical** — live |
| Whole-graph node arrival cache | `forecast_state.py:401,425` (`build_node_arrival_cache`) calls `compose_carrier_to_x` | **canonical** — live; uses `np.random.default_rng(seed=42)` at `:405` (Stage 1 RNG retirement target) |
| Scoped cohort_maturity frame path | `cohort_forecast_v3.py:408` (`_resolve_frame_carrier_state`) calls `build_upstream_carrier` from `forecast_runtime.py:1522` | **scoped compatibility** — live; 73n handoff gap per plan §27–37 |
| `build_upstream_carrier` (production) | `forecast_runtime.py:1522` | live (called only from the scoped frame path above) |
| `build_upstream_carrier` (v2) | `cohort_forecast_v2.py:407` | dev-only (`devOnly: true` in `analysis_types.yaml`); v2 frozen |

The split is the documented 73m Stage 8 handoff: whole-graph paths read the composed runtime object, but the scoped frame materialisation path in `_resolve_frame_carrier_state` can still build a `NodeArrivalState` through the legacy tiered timing (Tier 1 parametric → Tier 2 empirical → Tier 3 weak-prior). 73n is expected to retire or bypass this site as part of its primitive-registry / composition pass; until then, treating it as a 73n surface (not a 73m regression) is the correct disposition.

### 1.4. AP58 fork — `build_cohort_evidence_from_frames` count axis

The AP58 instance flagged by 73m §9 is unchanged in the working tree. `build_cohort_evidence_from_frames` (`cohort_forecast_v3.py:434` onwards) contains two parallel forks:

- **Fork 1 — `is_window`-gated population fallback** at `cohort_forecast_v3.py:750-769`. Controlling lines: `last_x = raw_n_i if is_window else 0.0` (`:752`), `elif is_window: last_x = raw_n_i` (`:760-761`).
- **Fork 2 — specialised carrier-projection rebuild** at `cohort_forecast_v3.py:775-803`. Controlling line: `if use_factorised_carrier:` (`:775`); `projected_x = a_pop * carrier_reach * _carrier_cdf_at_tau(t)` (`:800`).

The two forks produce systematically different `obs_x`/`obs_y` per τ between `is_window=True` and `is_window=False`; the trajectory engine derives different `rate_draws` as a consequence. Resolution is owned by 73n's primitive registry + composition pass + projection pass, which replaces the entire `build_cohort_evidence_from_frames` machinery with a clean primitive-readout projection. The four strict-xfailed tests in `test_cohort_factorised_outside_in.py` (see §1.12) are the regression net for this replacement.

### 1.5. Empirical Tier 2 / weak-prior carrier timing classification

| Path | Status |
|---|---|
| `XProvider.carrier_to_x` (whole-graph) | composed only — `compose_carrier_to_x` writes the canonical object; 73m §10 confirms `'empirical_tier_*'` would surface as a Stage 3 regression on `runtime_bundle_diag.carrier_to_x.cdf_source`. |
| `build_node_arrival_cache` (whole-graph) | composed only — `compose_carrier_to_x` per non-anchor node. |
| `_resolve_frame_carrier_state` (scoped frame path in `cohort_forecast_v3.py`) | tiered — `build_upstream_carrier` retains Tier 1 parametric → Tier 2 empirical → Tier 3 weak-prior fallback. Live for scoped cohort_maturity evidence materialisation. **73n surface.** |
| `cohort_forecast_v2.py:build_upstream_carrier` | dev-only, v2 frozen. |
| `cohort_forecast.py:_*` (v1) | dev-only. |

### 1.6. Evidence layer — roles, gates, EvidenceSet, adapters, doc-52 blend

**Evidence role enum** ([`graph-editor/lib/evidence_merge.py:31-35`](../../graph-editor/lib/evidence_merge.py)):

```
WINDOW_SUBJECT_HELPER
DIRECT_COHORT_EXACT_SUBJECT
BAYES_PHASE1_WINDOW
BAYES_PHASE2_COHORT
```

**Role resolver** at `forecast_runtime.py:1637-1669` (`_resolve_evidence_role`). Returns `DIRECT_COHORT_EXACT_SUBJECT` only when `direct_cohort_enabled=True` AND single-hop (`not is_multi_hop`) AND cohort mode (`not is_window`) AND `anchor_node_id != query_from_node`. Default return: `WINDOW_SUBJECT_HELPER`. Docstring at `:1645-1656` declares pre-WP8 behaviour: every CF subject reads file evidence under `WINDOW_SUBJECT_HELPER`.

**WP8 `direct_cohort_enabled` flag.** Defined as a `prepare_forecast_runtime_inputs` parameter at `forecast_runtime.py:1697` with default `False`. Docstring at `:1706-1708` declares it as the WP8 admission flag and confirms the typed-merge role is forced to `WINDOW_SUBJECT_HELPER` regardless of resolved temporal mode when `False`. Passed through to `_resolve_evidence_role` at `forecast_runtime.py:1970`. No persistent override in `forecasting_settings.py`; the flag is a request parameter only.

**`is_window` / `is_multi_hop` propagation** through `prepare_forecast_runtime_inputs` reaches `_resolve_subject_temporal_mode` (`forecast_runtime.py:1734-1738`), `should_use_anchor_relative_subject_cdf` (`:1739-1742`), `resolve_subject_cdf_start_node` (`:1745-1748`), and `_resolve_evidence_role` (`:1966,1970`). It also carries into `build_cohort_evidence_from_frames` at `cohort_forecast_v3.py:440-441` and gates the fork at `:750-803` (the AP58 instance).

**Canonical `EvidenceSet` shape** (`evidence_merge.py:204-211`) carries `scope`, `points`, `skipped`, `totals` (integer `n`/`k`), `totals_by_source`, `provenance`. **No floating-point weighted view** (`n_weighted` / `k_weighted`) exists — this is the new object Stage 1 owns separately from the canonical merge.

**`EvidenceScope`** (`evidence_merge.py:140-153`) carries `role`, `subject_from`, `subject_to`, `date_from`, `date_to`, `as_at`, `scenario_id`, `anchor`, `context_key`, `regime_key`, `population_universe_key`, `selected_anchor_days`, `scope_population_identity`. `selected_anchor_days` admission-vs-provenance status is **not pinned by current code**: it is supplied by callers but its admission-active role is not enforced inside `_validate_candidate`. Stage 0c will need to commit this contract.

**Evidence adapters** (`graph-editor/lib/runner/evidence_adapters.py`): `bayes_file_evidence_to_candidates` at `:139-251` (default `n=int(n_daily[idx])`, `k=int(k_daily[idx])` at `:221-222`); `bayes_parameter_file_evidence_to_candidates` at `:254-393`; `reconstructed_asat_to_candidates` at `:428-555` (default edge-rate evidence `n=x, k=y` at `:504-511`; `is_window=False` override forces `n=a` at `:508-509`, the WP8 first-edge identity case). The intended primitive evidence mapping is the file/parameter-file path's `n=x, k=y` convention.

**`merge_evidence_candidates`** (`evidence_merge.py:498-537+`) is the canonical merge entry point; signature `(scope, candidates, *, snapshot_covered_observations=None) -> EvidenceSet`. Implements the 73h merge algorithm steps 1–6 (scope-level admission, coverage dedup, snapshot-beats-file priority).

**Doc-52 subset / effective-evidence policy.**
- Closed-form non-latency oracle (dev-only): `cohort_forecast_v3.py:_non_latency_rows` lines 69–325. `m_S = sum_x` at `:143`; `m_S`, `m_G` populated into `NonLatencyResult` at `:187-193, 304-307`. The `(1−r):r` blend mixes updated `(α', β')` with unblended `(α, β)` per `:77-85`. Live status: only the dev-only oracle for `TestNonLatencyClosedFormEquivalence` after 73m Stage 5; deletion deadline aligned with 73n's primitive-registry stage (per 73m §11).
- Trajectory-engine blend: `forecast_state.py:_compute_blend_params` at `:689-720`. Deterministic permutation seeded at `_BLEND_SEED = 43` (`:653`); `blend_rng = np.random.default_rng(seed=_BLEND_SEED)` at `:731`. Threads `m_S`, `m_G` and `r` through `ForecastTrajectory` (`forecast_state.py:574-578`).

Both paths apply the policy at the carrier/projection layer, not at primitive construction. 73n moves this into per-primitive conditioning (plan §"Stage 3").

### 1.7. Snapshot DB read surface and as-at admission

Read entry points (`graph-editor/lib/snapshot_service.py`):

- `query_snapshots_for_sweep(param_id, core_hash, slice_keys, anchor_from, anchor_to, sweep_from, sweep_to, equivalent_hashes, limit)` at `:733-760` — returns `List[Dict]`, all rows in anchor range with `retrieved_at ∈ [sweep_from, sweep_to]` (date-level, inclusive).
- `query_virtual_snapshot(param_id, as_at, anchor_from, anchor_to, core_hash, slice_keys, equivalent_hashes, limit)` at `:2328-2360+` — point-in-time snapshot, latest-per-(anchor_day, slice_key); implements the `asat()` DSL.

CF callers: `forecast_preparation.py:355` imports `query_snapshots_for_sweep` and consumes via `resolve_forecast_subjects` at `:367`. Evidence adapters consume rows via caller-supplied lists (no direct DB calls in `evidence_merge.py` or `evidence_adapters.py`).

**`retrieved_at` ≤ `as_at` admission.** Validation in `evidence_merge._validate_candidate` at `:481-490`. Logic: non-materialised candidates require `retrieved_at` set and `retrieved_at <= scope.as_at`; FE tier-1 `asat_materialised=True` exempts from the check.

**Retrieval shape today.** Per-frame, not a contiguous primitive-local superset. `build_cohort_evidence_from_frames` (`cohort_forecast_v3.py:434+`) builds per-τ observations from caller-supplied frames; merge happens at frame granularity, not at the union of primitive-local clocks. Stage 2's evidence-clock alignment contract therefore introduces a new retrieval shape (a union-of-primitive-clocks superset with per-primitive binding) on top of the existing snapshot reads.

**Snapshot DB workstream owner.** **Not identified in current docs.** Plan §"Stage 0c" line 539 demands the workstream owner and contact point be named. No owner is recorded in `docs/current/project-bayes/` or `TODO.md`. The current branch `feature/snapshot-db-phase0` indicates an active workstream; the owner contact must be obtained before Stage 0c can be closed. **This is the only Stage 0c-blocking gap surfaced by Stage 0a; not a Stage 0a gate.**

### 1.8. Trajectory-local IS conditioning + projection layer

**Aggregate IS reweight** (`forecast_state.py:compute_forecast_trajectory`):
- Binomial likelihood: `_cohort_binomial_log_likelihood` at `:153-169`. Formula at `:169`: `k_obs * log(p_effective) + (n_obs - k_obs) * log1p(-p_effective)` with `p_effective = p_draws * c_clip` at `:168`.
- IS weight normalisation: `_normalise_log_weights` at `:116-133` (log-sum-exp stabilised, shift by `max_log_weight` at `:128`).
- Tempering: target `_IS_TARGET_ESS = 20.0` at `:1244`; binary search on `tempering_lambda ∈ [0,1]` at `:1263-1275`; per-cohort likelihood accumulation at `:1255-1259` (reads `c_i` from `cdf_arr[:S, _t_idx]`); resampling-with-replacement at `:1277-1289`.
- Per-cohort evaluation loop: `_evaluate_cohort` at `:735-844`; consumes `N_i = cohort.x_frozen`, `k_i = cohort.y_frozen`, `a_i = cohort.frontier_age`, `a_pop = cohort.a_pop` at `:773-776`; per-cohort drift `loop_rng.normal(0.0, drift_sds, size=(S, 4))` at `:788`.

**σ ≤ 0 guards in `compute_forecast_trajectory`.**
- Sole control-flow gate: `forecast_state.py:1062`: `if lat.sigma <= 0 and mc_cdf_arr is None and det_norm_cdf is None:` — Stage 4 (73m) narrowing. Honours prepared subject-span CDF even when terminal edge has `sigma=0`.
- `lag_distribution_utils.py:109` performs an earlier σ ≤ 0 check for CDF evaluation (pre-forecast); not a control-flow gate at the trajectory level.

**Projection readout.**
- Trajectory invocation: `cohort_forecast_v3.py:1180-1197` — `sweep = compute_forecast_trajectory(...)`.
- Per-τ row assembly: `cohort_forecast_v3.py:1252-1396`. Reads `sweep.rate_draws[:, tau]`, `sweep.det_y_total[tau]`, `sweep.det_x_total[tau]`, `sweep.completeness_mean`, `sweep.completeness_sd`, `sweep.p_draws`.
- Row metadata attachment: `_attach_cf_row_metadata` at `cohort_forecast_v3.py:52-66` — attaches `_conditioning`, `_conditioned`, `_cf_mode`, `_cf_reason` to first-row sentinel.
- Whole-graph CF projection (`api_handlers.handle_conditioned_forecast` at `:2130-2500+`): extracts `p_mean = last_row.get('p_infinity_mean')` at `:2385-2406`, with a `last_row.get('midpoint')` fallback. Writes `p.mean`, `p.sd`, `completeness` onto the graph edge.

**`prepare_forecast_runtime_inputs`** at `forecast_runtime.py:1672-2125` is the request → bundle entry point. **`build_prepared_runtime_bundle`** at `forecast_runtime.py:185-2190` (the role-selection + bundle assembly site).

### 1.9. Topology coverage — doc 29b cases vs span/carrier algebra

Topology cases are catalogued in [`docs/current/project-bayes/29b-span-kernel-operator-algebra.md`](29b-span-kernel-operator-algebra.md) §4–5. Coverage against current code:

| Case | Description | Code support |
|---|---|---|
| 1a | Trivial (x = a) | identity → identity, F_up = δ(τ=0). Supported. |
| 1b | Single-edge upstream + single-edge subject | W blocks; supported by `compose_span_kernel`. |
| 2 | Upstream diamond | C[a\|a→x] or atomic compose. Supported via topological DP at `span_kernel.py:_run_dp` (`:201-225` Kahn's algorithm in `_build_span_topology` at `:131-237`). |
| 3 | Upstream diamond+tail | Macro-block + seam composition. Supported. |
| 4 | Subject diamond | Sum-at-join; supported by `compose_span_kernel`. |
| 5 | Subject diamond+tail | Three-stage composition. Supported. |
| 6 | Both regimes complex | Cartesian composition. Supported. |
| 7 | Upstream leakage | Encoded in edge `p`; supported. |
| 8 | Subject leakage | Encoded in edge `p`; supported. |
| 9 | Diamond+leakage on both sides | Combined leakage encoded in edge `p`; supported. |
| 10 | Overhanging/underhanging block crossing X boundary | Correctly **rejected** (composition ambiguity at X seam). |
| 11 | Metadata mismatch | Correctly **rejected** (incompatible context/asat/slice types). |

**Code support for each supported case is via the existing DAG algebra**: `span_kernel.compose_span_kernel`, `span_kernel._run_dp`, `span_kernel._build_span_topology`, `carrier_composition.compose_carrier_to_x` (which itself calls `_build_span_topology(graph, anchor, X)` at `:219` and `compose_span_kernel` at `:262`). No second timing implementation. Non-latency edges degenerate to `δ(τ=0)` at `span_kernel._edge_sub_probability_density:83-113`.

**Rejection paths** in `compose_carrier_to_x`: `_no_path_carrier` if A→X disconnected (`:220-224`); zero-reach refusal (`:259-260`); horizon-inadequate refusal if `K[max_tau] / topological_reach < 0.99` (`:272-291`). These are admission decisions, not topology gaps.

**No live production CF requires residual/complement sibling primitives.** Grep across `carrier_composition.py`, `forecast_runtime.py`, `forecast_state.py`, `cohort_forecast_v3.py`, `span_kernel.py`, `span_evidence.py`, `span_upstream.py` returned no `1 - p`, residual-sibling, or branch-complement code. CF composition uses topological path-closure and edge-probability encoding; sibling rebalancing is owned downstream at the FE writeback layer (see §1.11).

**F14 query topology classification.**
- `from(simple-a).to(simple-b).window(-90d:)` (pinned to `window(29-Jan-26:29-Apr-26)` per `test_cohort_factorised_outside_in.py:741`): graph `synth-simple-abc`, serial single-hop, x = a, **doc 29b Case 1a** (deterministic identity upstream).
- `from(simple-b).to(simple-c).cohort(1-Mar-26:3-Mar-26).asat(3-Mar-26)` (per `test_cohort_factorised_outside_in.py:742`, derived from `_SIMPLE_BC`): graph `synth-simple-abc`, serial single-hop, x ≠ a, **doc 29b Case 1b** (single-edge upstream + single-edge subject).

Both queries are simple serial topologies. Diamond / fan-in / fan-out / leakage cases are exercised by the synth fixtures behind `test_cohort_factorised_outside_in.py` parametrisations and by `test_carrier_object_contract.py` (15 green tests covering identity, A=X, multi-edge upstream, latent-chain saturation, mixed-latency-then-non-latency, horizon adequacy, metadata mismatch).

### 1.10. Building blocks for Stage 2's prefix-arrival map

Stage 2 must construct the request-scoped `arrival_weight[node_id][calendar_day]` map. The map does NOT exist in live code (grep confirms zero hits for `arrival_weight` across `graph-editor/lib/runner/`). Building blocks Stage 2 may consume:

- `compose_carrier_to_x` (`carrier_composition.py:164`) — produces a `CarrierToX` per `(anchor, X)` pair; signature accepts `transitions: Optional[Dict[Tuple[str, str], TransitionPrimitive]] = None` (the seam Stage 2 will populate with conditioned primitives).
- `build_node_arrival_cache` (`forecast_state.py:382-410+`) — Dict keyed by node id, values = `NodeArrivalState` (CDF + reach + metadata); Stage 3 (73m) calls `compose_carrier_to_x(anchor → node_id)` per non-anchor node.
- `compose_span_kernel` (`span_kernel.py:291-309`) — deterministic span CDF via DP convolution.
- `mc_span_cdfs` (`span_kernel.py:312-360+`) — per-MC-draw span CDFs from prepared per-edge params; returns `(cdf_arr, p_s)` of shape `(S, T)` and `(S,)`.

Stage 2's deliverable is the new `arrival_weight` map keyed by `(scenario id, request root, context and case scope, regime/hash family, as-at boundary, source-preference, parameter fingerprint)`, built in topological order, reused across primitives within the request. No second timing implementation is required; every prefix delay PMF the map consumes must come from the existing span/carrier composition layer.

### 1.11. UpdateManager sibling rebalancing (FE writeback)

`UpdateManager.applyBatchLAGValues` at [`graph-editor/src/services/UpdateManager.ts:2027-2390`](../../graph-editor/src/services/UpdateManager.ts) is the live owner of graph-surface sibling mass balancing after CF writes. After applying latency + mean changes (STEP 2), it identifies edges whose `p.mean` changed, collects siblings, and invokes `rebalanceSiblingEdges` at `:127-174` in normal mode (does not clear `mean_overridden`). Conditional probabilities are routed separately. Other rebalancing entry points: `rebalanceEdgeProbabilities` at `:2650`, `rebalanceConditionalProbabilities` at `:2881`, `rebalanceVariantWeights` at `:3027`.

CF composition contains no sibling rebalancing logic; the design rejection of moving `1 - p` or proportional sibling rebalancing into CF primitive composition (plan §"Review Checklist") is consistent with current behaviour.

### 1.12. Fixed-seed RNG inventory — Stage 1 retirement targets

Stage 1 (plan §"Stage 1") must replace each fixed-seed RNG site that feeds primitive draws with a key-derived seed stream. The complete inventory:

**Primitive-draw machinery (Stage 1 retirement REQUIRED)** — 11 sites at `seed=42`, 2 sites at `seed=43`:

| File:line | Function | Seed | Role |
|---|---|---|---|
| `forecast_state.py:405` | `build_node_arrival_cache` | 42 | Whole-graph node arrival cache RNG passed to `compose_carrier_to_x` |
| `forecast_state.py:1031` | `compute_forecast_trajectory` | 42 | Multivariate-normal `(p, μ, σ, onset)` draws + IS resampling |
| `forecast_state.py:1367` | `compute_forecast_trajectory` (unconditioned loop) | 42 | Per-cohort drift (`loop_rng.normal`) |
| `forecast_state.py:653,731` | doc-52 blend | 43 (`_BLEND_SEED`) | Subset-conditioning blend permutation |
| `forecast_runtime.py:1826` | `prepare_forecast_runtime_inputs` (subject-span full-path MC) | 42 | `mc_span_cdfs` |
| `forecast_runtime.py:1836` | `prepare_forecast_runtime_inputs` (subject-span epistemic overlay) | 42 | `mc_span_cdfs` epistemic-only |
| `forecast_runtime.py:1854` | `prepare_forecast_runtime_inputs` (anchor-relative edge `p` MC) | 42 | `mc_span_cdfs` for edge-level p |
| `forecast_runtime.py:1864` | `prepare_forecast_runtime_inputs` (anchor-relative edge epistemic) | 42 | `mc_span_cdfs` epistemic only |
| `forecast_runtime.py:1895` | `prepare_forecast_runtime_inputs` (last-edge frontier CDF) | 42 | `mc_span_cdfs` for edge CDF (multi-hop) |
| `cohort_forecast_v3.py:399` | `compute_cohort_maturity_rows_v3` (scoped frame `_resolve_frame_carrier_state`) | 43 | `build_upstream_carrier` legacy empirical |

`forecast_state.py:193` uses `seed=71` inside `_compute_completeness_at_age` for completeness-SD draws (mu/onset jointly correlated). This draws on per-edge timing posterior, so it touches primitive timing draws and joins the Stage 1 retirement list.

**Primitive-draw retirement list total: 14 sites** (10 × `seed=42`, 2 × `seed=43`, 1 × `seed=71`, plus the `_BLEND_SEED=43` constant). Stage 1 must replace each with a key-derived seed deterministically derived from `(primitive identity, scenario scope, evidence role, date bounds, context/case scope, regime/hash family, as-at boundary, model-source preference, draw count S, scenario seed)`.

**Out-of-scope-classified non-primitive RNG sites (Stage 1 retirement NOT required)**:

| File:line | Role |
|---|---|
| `funnel_engine.py:165` (`_compute_path_bars`) — seed=42 | Bar-chart MC sampling of FE epistemic α/β; not part of CF primitive draws. |
| `funnel_engine.py:240` (`_compute_path_bars_cf`) — seed=42 | CF bar-chart variance mixture; chart visualisation only. |
| `confidence_bands.py:106` (`reconstruct_band_from_heuristic_sigma`) — seed=42 | FE topo fallback; heuristic-σ reconstruction, not CF primitive draws. |
| `cohort_forecast.py:645,944` (v1) — seed=42 | dev-only (`devOnly: true` in `analysis_types.yaml`). |
| `cohort_forecast_v2.py:659,721` (v2) — seed=42/43 | dev-only, v2 frozen. |

These sites are out-of-scope-classified because they do not feed any CF primitive draw; they remain at fixed seeds for chart determinism / dev-only diagnostics. Stage 1 must explicitly classify each one in its own Stage 1 note before claiming primitive draw coherence.

### 1.13. Test baseline — inherited xfails, present functions, WP8 default-off

#### Inherited strict-xfails — 73n flip-to-green targets

All four are in [`graph-editor/lib/tests/test_cohort_factorised_outside_in.py`](../../graph-editor/lib/tests/test_cohort_factorised_outside_in.py):

| Test (line) | Decorator (line) | 73n stage that flips it green |
|---|---|---|
| `test_single_hop_non_latent_upstream_collapses_to_window[from(synth-fo-gate).to(synth-fo-fast)]` (827, parametrised) | 785 | "Composition pass" + "Projection pass" (plan §304, §330, §356, §372). Reason text names AP58 fork at `cohort_forecast_v3.py:750-769` vs `:775-803` and 73n's primitive-registry / composition / projection split. **Do NOT widen `_P_MEAN_ABS_TOL` to mask divergence.** |
| `test_single_hop_non_latent_upstream_collapses_to_window[from(synth-fo-gate).to(synth-fo-slow)]` (827, parametrised) | 785 | Same as above (parametrised variant) |
| `test_degenerate_identity_and_instant_carrier_oracles_reduce_to_subject_kernel` (1115) | 1086 | "Composition pass" + "Projection pass". Reason: AP58 fork produces zero at τ=0 for non-latency runtime objects instead of σ=0 Dirac mass (per `span_kernel.py:_edge_sub_probability_density:83-113`). **Do NOT soften assertion or skip τ=0.** |
| `test_multihop_non_latent_upstream_collapse` (1185) | 1155 | "Composition pass" + "Projection pass". Reason: at τ=1 window rate ~0.058 vs cohort rate ~0.125 (2× divergence) caused by AP58 fork producing materially different `obs_x`/`obs_y`. **Do NOT widen `_P_MEAN_ABS_TOL` to mask divergence.** |

These four are 73n acceptance criteria (per 73m §11 open item 1). `strict=True` ensures any XPASS during 73n surfaces as a suite failure prompting marker removal.

**Other strict-xfails in the same file** — out of scope for 73n proper:

| Test (line) | Decorator (line) | Reason class |
|---|---|---|
| `test_cli_single_hop_downstream_cohort_parity_and_admitted_provenance` (1509) | 1494 | Post-WP8 admission contract (selected_family='cohort', decision_reason='single_hop_anchor_override'). **WP8 is a non-goal for this plan** (plan §"Non-Goals" line 45); this xfail is not a 73n acceptance criterion. |

#### `test_cohort_factorised_outside_in.py` — full function inventory

34 test functions, 38 parametrised items. Status snapshot (1-May-26 — 73m Phase 1 closure exit):

- **GREEN (32)**: `test_a_equals_x_identity_collapses_to_window` (740), `test_single_hop_latent_upstream_lags_window_but_converges_to_same_subject_p` (863), `test_anchor_depth_monotonicity_for_same_subject` (899), `test_same_carrier_shared_across_different_subjects` (958), `test_low_evidence_cohort_matches_factorised_convolution_oracle` (986), `test_no_evidence_single_hop_matches_unconditioned_fw_convolution_midline` (1025), `test_low_evidence_single_hop_remains_near_unconditioned_oracle` (1056), `test_multihop_latent_upstream_divergence` (1213), `test_multihop_subject_span_is_not_last_edge_or_param_pack_scalar` (1235), `test_multihop_with_terminal_non_latency_window_must_honour_upstream_subject_latency` (1289), `test_multihop_with_terminal_non_latency_cohort_must_honour_upstream_subject_latency` (1330), `test_cli_window_single_edge_scalar_identity_across_public_surfaces` (1363), `test_cli_identity_collapse_matches_window_across_public_surfaces` (1380), `test_analyse_cli_does_not_pre_run_graph_mutating_cf_for_needs_snapshots` (1447), `test_cli_projection_parity_uses_last_row_saturation_not_arbitrary_tau_curve_point` (1595), `test_cohort_and_window_p_infinity_converge_for_same_subject_rate` (1642, ×3 parametrised), `test_cohort_frame_evidence_is_admitted_only_for_single_hop_anchor_override_case` (1664), `test_cohort_frame_evidence_does_not_retarget_carrier_or_subject` (1723), `test_zero_evidence_window_rises_as_subject_cdf` (1766), `test_parity_window_mature_high_evidence_p_mean` (1925), `test_parity_cohort_identity_collapse_p_mean` (1954), `test_parity_subject_equivalent_cohort_anchor_override_p_mean` (1987), `test_fe_topo_cohort_c_to_d_p_mean_stays_near_truth` (2028, parametrised), `test_parity_zero_evidence_cohort_returns_prior` (2051), `test_d0_bayes_vars_actually_promotes_to_bayesian` (2240), `test_d1_parity_analytic_vs_bayes_mature_window` (2281), `test_d2_parity_analytic_vs_bayes_identity_collapse_cohort` (2328), `test_d3_parity_analytic_vs_bayes_zero_evidence_returns_prior` (2365), `test_d4_parity_analytic_vs_bayes_low_evidence_cohort_F1_signature` (2405).
- **XFAIL strict (5)**: four 73n flip-to-green targets above + `test_cli_single_hop_downstream_cohort_parity_and_admitted_provenance` (post-WP8).
- **RED (1)**: `test_v3_midline_at_saturation_converges_to_p` (1792). Stage 1B observed side effect from 73m Stage 0 entry. Same numerics: midpoint=0.5766 vs p_inf=0.6788. **The 73m plan does not commit to closing this; 73n inherits it as RED unchanged.** Not a 73n acceptance criterion.

Plan-level regression discipline (plan §"Stage 9" line 812): no xfailing or skipping existing passing tests; no relaxing assertions to hide changed semantics.

#### Other test files load-bearing for 73n

- [`test_carrier_object_contract.py`](../../graph-editor/lib/tests/test_carrier_object_contract.py) — 15 tests, all green (Stage 1 carrier-object contract). Lines 120, 140, 161, 189, 239, 265, 304, 366, 395, 463, 506, 525, 542, 563, 594.
- [`test_subject_span_cdf_ownership.py`](../../graph-editor/lib/tests/test_subject_span_cdf_ownership.py) — `TestNonLatencyClosedFormEquivalence` (269–445; 2 tests using `_non_latency_rows` as oracle, deletion deadline at 73n's primitive-registry stage); `TestStage6ProjectionDiagnostics` (447–656; 4 tests on Stage 6 carrier-side diagnostic surface).
- [`test_forecast_state_cohort.py`](../../graph-editor/lib/tests/test_forecast_state_cohort.py) — 17 tests across `TestForecastRuntimeIngressOrdering` (169–256), `TestNodeArrivalCache` (257–348), `TestScopeAndCarrierConsistency` (350–407), `TestAggregateISLikelihood` (409–436), `TestSubsetConditioningBlend` (438–507), `TestPreparedRuntimeBundle` (509–807). All green.
- [`test_evidence_merge.py`](../../graph-editor/lib/tests/test_evidence_merge.py) — exercises `merge_evidence_candidates` and `EvidenceSet`.
- [`test_evidence_adapters.py`](../../graph-editor/lib/tests/test_evidence_adapters.py) — exercises adapter composition and temporal family dispatch.
- [`test_conditioned_forecast_response_contract.py`](../../graph-editor/lib/tests/test_conditioned_forecast_response_contract.py) — CF response shape.
- [`test_daily_conversions.py`](../../graph-editor/lib/tests/test_daily_conversions.py), [`test_cf_query_scoped_degradation.py`](../../graph-editor/lib/tests/test_cf_query_scoped_degradation.py), [`test_v2_v3_parity.py`](../../graph-editor/lib/tests/test_v2_v3_parity.py), [`test_forecast_stack_dependencies.py`](../../graph-editor/lib/tests/test_forecast_stack_dependencies.py) — adjacent green coverage.
- [`test_non_latency_rows.py`](../../graph-editor/lib/tests/test_non_latency_rows.py) — 406 lines; **deletion deadline aligned with 73n's primitive-registry stage** (73m §11 open item 2). Survives only as the dev-only oracle for `TestNonLatencyClosedFormEquivalence`.

#### WP8 default-off baseline

[`test_wp8_default_off.py`](../../graph-editor/lib/tests/test_wp8_default_off.py) — 4 tests asserting pre-WP8 admission:

| Test | Line | Asserts |
|---|---|---|
| `test_wp8_admission_hook_returns_false_for_all_inputs` | 42 | `should_enable_direct_cohort_p_conditioning` returns `False` for all `(is_window, is_multi_hop)` combos |
| `test_wp8_runtime_bundle_parameter_default_is_false` | 59 | `build_prepared_runtime_bundle` defaults `p_conditioning_direct_cohort` to `False` |
| `test_wp8_diagnostic_off_under_default_bundle_build` | 73 | Default bundle build: `'direct_cohort_enabled'` absent; `p_conditioning_evidence.temporal_family != 'cohort'`; source `!= 'direct_cohort_exact_subject'`; family must not be `'cohort'` (default merge admits under `WINDOW_SUBJECT_HELPER`) |
| `test_wp8_off_for_post_stage_2_analytic_with_query_scoped_false` | 107 | Post-Stage-2 analytic edges (`alpha_beta_query_scoped=False`) still default to non-WP8 path |

### 1.14. Defect classification — primitive vs composition vs projection

Plan §"Stage 0a" line 503 demands the baseline note "distinguishes primitive conditioning defects from carrier composition defects and projection defects". Classification of the open defects:

- **Primitive conditioning defects** — none currently observable on the live whole-graph CF path. The 73h F14 0.546-vs-0.70 gap localisation is a Stage 0b deliverable (see §2 below when added).
- **Carrier composition defects** — none in `compose_carrier_to_x` / `compose_span_kernel` themselves. The remaining surface where carrier construction can degrade is the scoped frame path through `_resolve_frame_carrier_state` → `build_upstream_carrier`. This is a 73n handoff gap, not a defect in canonical composition.
- **Projection defects** — the AP58 fork in `build_cohort_evidence_from_frames` (`cohort_forecast_v3.py:750-803`) is the dominant projection-layer defect. It is the second AP58 variant ("a downstream projection grows its own carrier / subject-span / `p∞` logic because the upstream object didn't carry the information it needed" — KNOWN_ANTI_PATTERNS AP58). The fork produces materially different `obs_x`/`obs_y` per τ between `is_window=True` and `is_window=False`, and the trajectory engine derives different `rate_draws` as a consequence. This is the open issue 73n owns; the four flip-to-green xfails are the regression net.

The relative-DSL test wallclock-flakiness pattern (KNOWN_ANTI_PATTERNS AP57) affects test pinning rather than runtime defect classification; relevant for assertion authoring in Stages 5a/5b/5c/6 but not a Stage 0a defect.

### 1.15. Stage 0a stop-condition discharge and Stage 3+ blocking risk

Plan §"Stage 0a" stop condition (line 503): "a Stage 0a baseline note records every item above with file paths and line numbers, distinguishes primitive conditioning defects from carrier composition defects and projection defects, and states whether Stage 3+ is blocked by any missing 73m precondition, by a live production requirement for unsupported residual/complement primitives, or by a current topology case not covered by the existing doc 29b/span-kernel DAG algebra."

Discharge:

- **Items recorded**: §§1.1–1.13 cover every Stage 0a inventory item (router state, subject-span/carrier composition, scoped compatibility paths, empirical Tier 2 classification, evidence layer roles/gates/EvidenceSet/adapters/doc-52 blend, snapshot DB API surface, retrieval shape, `p_conditioning_evidence` call sites, residual/complement evidence, topology classification, code support per topology case, sibling rebalancing path, snapshot DB admission/as-at API, evidence retrieval shape and `selected_anchor_days` status, building blocks for Stage 2's prefix-arrival map, canonical `EvidenceSet` shape with floating-point weighted view absence, line inventory for `prepare_forecast_runtime_inputs` / `compute_forecast_trajectory` / aggregate IS / doc-52 blend / projection readout, fixed-seed RNG inventory, baseline test suites and tolerances, inherited strict xfails). File paths and line numbers are given throughout.
- **Defect classification**: §1.14 distinguishes primitive conditioning defects (none currently observable on the live whole-graph CF path), carrier composition defects (none in canonical composition; scoped frame path is a 73n handoff gap), and projection defects (AP58 fork in `build_cohort_evidence_from_frames`).
- **Stage 3+ blocking risk**:
  - **No missing 73m precondition.** All eight 73m stages are complete. The scoped-frame `build_upstream_carrier` path is a documented 73n handoff gap, not a missing precondition.
  - **No live production requirement for unsupported residual/complement primitives.** Grep confirmed CF composition does not contain `1 - p`, residual-sibling, or branch-complement code; doc 29b cases 1–9 are covered by the existing DAG algebra; cases 10–11 are correctly rejected.
  - **No topology case unsupported by the existing doc 29b/span-kernel DAG algebra.** All supported cases route through `compose_span_kernel` / `_run_dp` / `_build_span_topology` / `compose_carrier_to_x`.

**Stage 3+ is NOT blocked.** Stage 0c will need to close one Stage 0c-scoped gap (snapshot DB workstream owner not identified, §1.7); this gap does not block Stage 0b or any subsequent stage.

**Outstanding items for Stage 0c to commit (not Stage 0a deliverables)**:
1. Snapshot DB workstream owner contact point — surfacing and naming required.
2. `selected_anchor_days` admission-vs-provenance status under `EvidenceScope` — current code does not enforce it; Stage 0c contract decides whether to keep it provenance-only or make it admission-active.
3. Numeric parity tolerances per cutover quantity (displayed rate / carrier reach / ESS) for Stages 5a–6, plus shadow-comparison vs acceptance bands.
4. Evidence-clock alignment contract for `arrival_weight[node_id][calendar_day]` map and retrieval superset shape.
5. Primitive-count and runtime baselines for scoped `cohort_maturity`, scoped `window()`, and whole-graph CF.

These are explicitly Stage 0c surfaces per plan §527-557 and are not Stage 0a's responsibility.

## 2. Stage 0b — Forensic localisation and test triage — added 1-May-26

Stage 0b localises F14 against the live working tree, audits the five named functions for local projection/evidence logic that bypasses composed primitives, classifies every existing non-latency / identity-carrier / A=X / multi-hop terminal-non-latency / instant-carrier test against its 73n disposition, and records the disposition for `build_cohort_evidence_from_frames` and adjacent surfaces. Documentation-only, no source-code or test edits.

### 2.1. Five-function audit — local projection/evidence logic that could bypass composed primitives

Plan §"Stage 0b" line 515 demands an audit of `build_cohort_evidence_from_frames`, `_resolve_frame_carrier_state`, `compute_forecast_trajectory`, `span_kernel._edge_sub_probability_density`, and `UpdateManager.applyBatchLAGValues` for "local projection/evidence logic that could bypass the composed primitive runtime object". Findings:

**`build_cohort_evidence_from_frames`** (`graph-editor/lib/runner/cohort_forecast_v3.py:434`) — **HAS local projection logic that bypasses composition.** The AP58 fork at `:750-769` (is_window-gated population fallback) and `:775-803` (specialised carrier-projection rebuild — `projected_x = a_pop * carrier_reach * _carrier_cdf_at_tau(t)` at `:800`) re-applies carrier scaling that should already be encoded in the resolved runtime object. This is the second-variant AP58: "a downstream projection grows its own carrier / subject-span / `p∞` logic because the upstream object didn't carry the information it needed" (KNOWN_ANTI_PATTERNS AP58). The `if use_factorised_carrier:` branch at `:775` and the fall-through `if subject_span_curve is not None:` block at `:730-738` together rebuild evidence from carrier_reach × _carrier_cdf_at_tau × subject_span_curve when the caller supplies an x_provider — instead of letting `compute_forecast_trajectory` consume the prepared subject-span CDF directly.

**`_resolve_frame_carrier_state`** (`cohort_forecast_v3.py:345`) — **HAS legacy compatibility logic that bypasses canonical composition.** The function lazily builds `x_provider_local` if the caller didn't supply one. When `graph` is supplied, anchor != X, and we are in cohort mode (`:368-374`), it calls `build_x_provider_from_graph` (canonical, `:377`) AND the legacy `build_upstream_carrier` path (`:408`) which goes through Tier 1 parametric → Tier 2 empirical → Tier 3 weak-prior fallback (per 73n plan §27-37 lines 33-35). The `np.random.default_rng(43)` at `:399` is the legacy-tier carrier RNG (Stage 1 retirement target — see Stage 0a §1.12). This is the documented 73m → 73n handoff gap: scoped frame materialisation can still see the legacy tiered carrier object even though whole-graph paths use only the composed runtime object.

**`compute_forecast_trajectory`** (`forecast_state.py:940`) — **NO local projection bypass.** The function reads `mc_cdf_arr` and `det_norm_cdf` from the prepared subject-span object at `:1055-1062`; the σ ≤ 0 guard at `:1062` was narrowed in 73m Stage 4 so that prepared subject-span CDFs are honoured even when terminal-edge `lat.sigma=0`. The IS reweight at `:1095-1199` consumes evidence already built upstream by `build_cohort_evidence_from_frames`; it does not re-derive carrier or subject semantics. Defects observable in the trajectory engine output trace back to upstream evidence-builder behaviour, not to the trajectory engine itself.

**`span_kernel._edge_sub_probability_density`** (`span_kernel.py:83-128`) — **NO bypass; this IS the composition primitive.** Correctly handles σ ≤ 0 → delta at τ=0 (`:108-113`), 0 < σ < 0.1 → delta at `onset + exp(mu)` (`:115-122`), σ ≥ 0.1 → full lognormal PDF (`:124-128`). The natural-degeneration substrate that the four flip-to-green xfails want to see emerging through `compute_forecast_trajectory`. No local projection logic; no evidence binding.

**`UpdateManager.applyBatchLAGValues`** (`graph-editor/src/services/UpdateManager.ts:2027-2390`) — **NO bypass; this is the post-CF FE writeback layer.** Sibling rebalancing at `:127-174` (`rebalanceSiblingEdges`) is invoked after CF writes the new `p.mean` onto the graph edge. It does not perform CF-internal projection or evidence logic; it consumes CF outputs. Plan §"Review checklist" line 866 explicitly says no `1 - p` rebalancing should move from UpdateManager into CF composition; this remains the live owner of graph-surface sibling mass balancing.

**Audit verdict.** Two of the five functions contain local projection/evidence logic that bypasses composed primitives: `build_cohort_evidence_from_frames` (AP58 fork on the count axis) and `_resolve_frame_carrier_state` (scoped-frame legacy carrier path). Both are 73n surfaces. The other three are clean.

### 2.2. F14 forensic queries — captured 1-May-26 against the live working tree

Plan §"Stage 0b" line 520 demands the two named F14 queries be run, with public scalar, internal trajectory-local posterior summary, raw Σy/Σx, and maturity-aware likelihood point estimate captured for each. Output captured via `bash graph-ops/scripts/analyse.sh synth-simple-abc <dsl> --type cohort_maturity --format json`.

#### Q1: `from(simple-a).to(simple-b).window(-90d:)` (resolved to `window(1-Feb-26:1-May-26)` today)

| Quantity | Value | Source |
|---|---|---|
| **Public scalar `p_infinity_mean`** | **0.6925** | last row, `result.data[-1].p_infinity_mean` |
| **Public scalar `p_infinity_sd`** | 0.0829 | last row |
| **Truth `p`** (synth) | **0.7000** | `synth-simple-abc.truth.yaml`: `simple-a-to-b.p` |
| **Gap (public vs truth)** | **+0.0075 absolute / +1.07% relative** | 0.6925 − 0.7000 |
| **Last solid-τ midpoint** (τ=90) | 0.6911 | `result.data[-1].midpoint` |
| **Forecast-mean (model curve)** | 0.6957 | `metadata.model_curves...params.forecast_mean` |
| **Maturity-aware completeness** | 0.7685 | last row `completeness` |
| **Raw Σy/Σx (latest-per-anchor)** | **132835 / 249918 = 0.5315** | `metadata.export_tables.cohort_maturity_points`, latest snapshot per anchor day |
| **Raw Σy/Σx (sum-over-all snapshots)** | 19929259 / 38852103 = 0.5130 | export_tables, double-counts by snapshot date |
| **`_conditioning` block** | `{r: 1, m_S: 249918, m_G: 101367, applied: True, skip_reason: None}` | first-row sentinel `_conditioning` |
| **`_conditioned`** | `True` | first-row sentinel |
| **`_cf_mode`** | `sweep` | first-row sentinel |
| **`promoted_source`** | `analytic` | model_curves params |
| **`mode`** | `span_convolved_mc_median` | model_curves params |
| **Frontier `tau_solid_max`** | 1 | last row |
| **First evidenced τ** | 1 | `evidence_y=0, evidence_x=249918` |
| **Cohorts covered** | up to 49 | `cohorts_covered_base/projected` field |

**The 73f-reported 0.546-vs-0.70 gap is CLOSED on this query.** The current public scalar `p_infinity_mean = 0.6925` is within 1.1% of truth `p = 0.7000`; the maturity-aware likelihood + IS conditioning correctly produces the mature edge rate, not the under-matured raw Σy/Σx (0.5315) that 73f originally reported. The IS conditioning block reports `applied=True` with `r = m_S/m_G = 249918/101367 ≈ 2.47` clamped to `r=1` (full subset).

#### Q2: `from(simple-b).to(simple-c).cohort(1-Mar-26:3-Mar-26).asat(3-Mar-26)`

| Quantity | Value | Source |
|---|---|---|
| **Public scalar `p_infinity_mean`** | **0.6010** | last row |
| **Truth `p`** (synth) | **0.6000** | `synth-simple-abc.truth.yaml`: `simple-b-to-c.p` |
| **Gap (public vs truth)** | **+0.0010 absolute / +0.17% relative** | exact match within numeric tolerance |
| **Last-row midpoint** (τ=61) | 0.5907 | last row |
| **Per-row evidence_y/evidence_x** | all `None` | no observed evidence under as-at boundary in 3-day cohort window |
| **Raw Σy/Σx (latest-per-anchor)** | 0 / 3535 = 0 | only one anchor day admitted; no observed conversions |
| **`cohorts_covered_base/projected`** | 0 throughout | no admitted cohorts |
| **Forecast progression** (τ=3 fx=1.6 → τ=61 fx=2463.9) | non-zero forecast x | carrier composition is producing the population progression even with no observed evidence |

This is a no-evidence corner case — the `asat(3-Mar-26)` boundary on a 3-day cohort window admits no observed evidence, so the public scalar is the prior projection. **The output is exactly the truth value (within 0.2% tolerance).** Carrier composition is active (the cohort mode + non-zero `forecast_x` progression confirm `compose_carrier_to_x` is producing the A→B carrier object); subject-span returns the prior `p = 0.60`.

### 2.3. Localisation of the F14 0.546-vs-0.70 gap

Plan §"Stage 0b" line 522 demands the gap be localised to one of:
- **(a) the maturity-aware likelihood itself produces the raw figure (defect inside conditioning).** REJECTED. On Q1, the IS conditioning block reports `_conditioned=True, applied=True` and the public scalar is 0.6925 — the maturity-aware likelihood produces the correct mature figure, not the raw 0.5315 figure.
- **(b) the likelihood produces the mature figure but projection overwrites it (defect inside projection).** REJECTED. The public scalar matches the last-row midpoint (0.6925 vs 0.6911) — projection is reading from the resolved trajectory, not overwriting with raw evidence.
- **(c) another object on the runtime trace.** REJECTED. No runtime object visibly contradicts the 73g invariants on these two queries.

**Conclusion: the F14 0.546-vs-0.70 gap as originally reported in 73f is no longer reproducible on either named query.** 73m's combined Stage 4 σ ≤ 0 narrowing + Stage 5 router retirement + the IS conditioning seam in `compute_forecast_trajectory` correctly produces the maturity-aware figure at the public layer.

The first runtime object whose actual state still contradicts the 73g invariants is **`build_cohort_evidence_from_frames`** (the AP58 fork — see §2.1 audit and §1.4 of Stage 0a). It manifests not on the headline F14 queries but on:
- non-latency single-hop / multi-hop subject cases at small τ (the four flip-to-green xfails — Stage 0a §1.13);
- instant-carrier τ=0 cases (the `test_degenerate_identity_and_instant_carrier_oracles_reduce_to_subject_kernel` xfail).

This invalidates 73g invariant 7 ("Projection must not re-decide semantics") because the AP58 fork rebuilds evidence locally instead of reading the resolved runtime object.

**Implication for Stage 3's reuse-vs-replace decision** (plan §"Stage 0b" line 523 → 73n plan §"Stage 3" lines 631-654): **reuse**. The current trajectory engine + IS conditioning at `forecast_state.py:1095-1199` correctly produces the maturity-aware posterior on the F14 latency-bearing window query. Stage 3 inherits this conditioning machinery as the per-primitive policy substrate. The replacement work is at the upstream evidence-builder layer (`build_cohort_evidence_from_frames`) and the projection-readout layer (`compute_cohort_maturity_rows_v3:1252-1396`), not at the conditioning layer. Plan §"Stage 3" line 635: "The initial conditioning policy should reuse the current CF maturity-aware likelihood discipline rather than inventing a new estimator" — confirmed by the §2.2 evidence.

### 2.4. AP58 / non-latency / identity-carrier test inventory and classification

Plan §"Stage 0b" lines 511-514 demands every test asserting non-latency, identity-carrier, A=X, multi-hop terminal-non-latency, or instant-carrier behaviour be inventoried and classified into one of:
- **already-correct guard** (must stay GREEN);
- **wrong-contract assertion** to delete or replace;
- **73n flip-to-green xfail** (carry as strict xfail until 73n's named stage flips it);
- **source-timestamp/admission test** where τ=0 has data-source meaning rather than runtime-object meaning.

Stage 0a §1.13 already gave the broader test snapshot; this section narrows to AP58/non-latency surface and tags each by 73n stage.

#### `graph-editor/lib/tests/test_cohort_factorised_outside_in.py`

| Test (line) | Classification | 73n stage that flips | Notes |
|---|---|---|---|
| `test_a_equals_x_identity_collapses_to_window` (740) | already-correct guard | — | A=X identity-carrier collapse parity with window. Rate-axis assertions correct. Must stay GREEN. |
| `test_single_hop_non_latent_upstream_collapses_to_window[FAST]` (827, parametrised) | **73n flip-to-green xfail** (already xfailed at 785) | Stage 5a (Single-Hop Window and Subject Cutover) + Composition pass + Projection pass | AP58 fork in `build_cohort_evidence_from_frames` produces materially different `obs_x`/`obs_y` per τ between is_window=True and is_window=False. Wrong-contract count-equality assertion already deleted in 73m Stage 7. Surviving rate-axis assertions correct. **Do NOT widen `_P_MEAN_ABS_TOL`.** |
| `test_single_hop_non_latent_upstream_collapses_to_window[SLOW]` (827, parametrised) | **73n flip-to-green xfail** (already xfailed at 785) | Stage 5a + Composition pass + Projection pass | Same as FAST variant. |
| `test_single_hop_latent_upstream_lags_window_but_converges_to_same_subject_p` (863) | already-correct guard | — | Latent upstream cohort lags window in evidence_x; both converge to same `p∞`. |
| `test_anchor_depth_monotonicity_for_same_subject` (899) | already-correct guard | — | Anchor-depth monotonicity for same subject. |
| `test_same_carrier_shared_across_different_subjects` (958) | already-correct guard | — | Fanout topology parity check. |
| `test_low_evidence_cohort_matches_factorised_convolution_oracle` (986) | already-correct guard | — | Oracle parity. |
| `test_no_evidence_single_hop_matches_unconditioned_fw_convolution_midline` (1025) | already-correct guard | — | No-evidence oracle. |
| `test_low_evidence_single_hop_remains_near_unconditioned_oracle` (1056) | already-correct guard | — | Low-evidence convergence. |
| `test_degenerate_identity_and_instant_carrier_oracles_reduce_to_subject_kernel` (1115) | **73n flip-to-green xfail** (already xfailed at 1086) | Stage 5a + Composition pass + Projection pass | AP58 fork produces zero at τ=0 for non-latency runtime objects instead of σ=0 Dirac mass. **Reads τ=0 explicitly — must NOT be skipped.** Plan line 514 forbids skipping τ=0 to make non-latency behaviour pass. |
| `test_multihop_non_latent_upstream_collapse` (1185) | **73n flip-to-green xfail** (already xfailed at 1155) | Stage 5b (Multi-Hop Subject Span Composition) + Composition pass + Projection pass | At τ=1 window rate ~0.058 vs cohort rate ~0.125 (2× divergence). AP58 fork is the defect. **Do NOT widen tolerance.** |
| `test_multihop_latent_upstream_divergence` (1213) | already-correct guard | — | Latent multi-hop divergence is expected behaviour. |
| `test_multihop_subject_span_is_not_last_edge_or_param_pack_scalar` (1235) | already-correct guard | — | Pins subject-span ownership invariant (73g invariant 4). Must stay GREEN. |
| `test_multihop_with_terminal_non_latency_window_must_honour_upstream_subject_latency` (1289) | already-correct guard | — | **Currently GREEN.** 73m Stage 4 narrowed σ ≤ 0 early-return; trajectory engine now honours composed subject-span CDF when terminal edge is non-latency. |
| `test_multihop_with_terminal_non_latency_cohort_must_honour_upstream_subject_latency` (1330) | already-correct guard | — | **Currently GREEN.** Same Stage 4 fix applied to cohort mode. |
| `test_cli_window_single_edge_scalar_identity_across_public_surfaces` (1363) | already-correct guard | — | Single-edge window scalar identity across public surfaces. |
| `test_cli_identity_collapse_matches_window_across_public_surfaces` (1380) | already-correct guard | — | A=X identity collapse parity across CLI surfaces. |
| `test_cli_single_hop_downstream_cohort_parity_and_admitted_provenance` (1509) | **out-of-scope post-WP8 xfail** (already xfailed at 1494) | post-WP8 admission (NOT a 73n stage) | Post-WP8 cohort admission contract. WP8 is plan §"Non-Goals" line 45. **NOT a 73n acceptance criterion.** |
| `test_v3_midline_at_saturation_converges_to_p` (1792) | **observation-only RED** (not xfailed; 73m §1B carry-over) | not closed by this plan | Stage 1B observed side effect. midpoint ~0.5766 vs p_inf ~0.6788. Investigation in `cohort-maturity-v3-midline-collapse-investigation.md`. Plan does not commit to closing this; 73n inherits as RED unchanged. |

#### `graph-editor/lib/tests/test_carrier_object_contract.py`

15 tests, all currently GREEN. AP58/non-latency-relevant subset:

| Test (line) | Classification | Notes |
|---|---|---|
| `test_window_mode_returns_inactive_carrier` (120) | already-correct guard | Window identity-carrier degeneration: `reach=0`, `enabled=False`. |
| `test_a_equals_x_cohort_returns_inactive_carrier` (140) | already-correct guard | A=X cohort identity-carrier degeneration. |
| `test_a_not_x_topological_reach_is_product_of_upstream_probabilities` (161) | already-correct guard | Reach computed via topological product. |
| `test_carrier_conditional_cdf_saturates_to_one_for_latent_chain` (189) | already-correct guard | Conditional CDF saturates to 1.0 (not to reach). |
| `test_a_not_x_all_non_latency_chain_must_enable_carrier` (239) | already-correct guard | All-non-latency A≠X chain enables active carrier. **Currently GREEN per 73m §10 Stage 6 closure.** |
| `test_all_non_latency_chain_carrier_cdf_is_dirac_at_zero` (265) | already-correct guard | All-non-latency carrier CDF is Dirac-at-zero. **Currently GREEN.** |
| `test_mixed_latency_then_non_latency_chain_carrier_reflects_latency_edge_timing` (304) | already-correct guard | Mixed chain CDF reflects latency edge. **Currently GREEN.** |
| `test_horizon_adequacy_returns_at_least_99_percent_saturation_when_horizon_is_sufficient` (366) | already-correct guard | Horizon adequacy contract `K[max_τ]/reach ≥ 0.99`. |
| `test_horizon_inadequacy_below_95_percent_must_be_refused_or_diagnosed` (395) | already-correct guard | Refuses < 0.95 saturation. |
| `test_composer_accepts_synthetic_transitions_without_invoking_resolver` (463) | already-correct guard | **The Stage 2 seam — accepts synthetic `TransitionPrimitive` objects.** This is where 73n's primitive registry plugs in. Must stay GREEN. |
| (the remaining 5 composer tests) | already-correct guard | identity / A=X / no-path / mc_cdf / diagnostic surface — all GREEN. |

#### `graph-editor/lib/tests/test_subject_span_cdf_ownership.py`

| Test (line) | Classification | Notes |
|---|---|---|
| `test_subject_span_source_is_prepared_mc_when_mc_cdf_supplied` (66) | already-correct guard | Stage 4 (73m) contract: prepared MC CDF is honoured. |
| `test_subject_span_source_is_edge_level_when_no_prepared` (90) | already-correct guard | Fallback when no prepared span. |
| `test_subject_span_source_is_prepared_det_when_only_det_cdf_supplied` (105) | already-correct guard | Deterministic span CDF path. |
| `test_per_draw_cdf_variation_drives_is_separation` (131) | already-correct guard | Per-draw CDF variation reduces ESS — IS contract. |
| `test_uniform_cdf_no_is_separation` (186) | already-correct guard | Uniform CDF preserves ESS. |
| `test_sigma_zero_with_prepared_mc_cdf_does_not_early_return` (221) | already-correct guard | **Stage 4 narrowing — σ=0 + prepared CDF does NOT trigger early return.** |
| `TestNonLatencyClosedFormEquivalence.test_*` (291) | already-correct guard (dev-only oracle scope) | Uses `_non_latency_rows` as Beta-Binomial oracle. **Deletion deadline aligned with 73n's primitive-registry stage** (73m §11). |
| `TestStage6ProjectionDiagnostics.test_*` (475-550) | already-correct guard | 4 tests on Stage 6 carrier-side diagnostic surface. All GREEN. |

#### `graph-editor/lib/tests/test_non_latency_rows.py`

11 tests covering `_non_latency_rows` closed-form Beta-Binomial. **All classified as dev-only oracle.** Per 73m §11 open item 2: "`_non_latency_rows` deletion is on 73n's plate". The test module + `_non_latency_rows` itself + the `cohort-maturity-no-evidence-truth-test.sh` helper are jointly retired alongside 73n's primitive-registry stage. Do not flip these to xfail in advance; delete them when the registry lands and `TestNonLatencyClosedFormEquivalence` no longer needs the oracle.

#### `graph-editor/lib/tests/test_forecast_state_cohort.py`

17 tests across 6 classes. None currently xfailed. AP58/non-latency-relevant subset:

| Class / Test (line) | Classification | Notes |
|---|---|---|
| `TestNodeArrivalCache.test_anchor_node_has_delta_arrival` (260) | already-correct guard | Identity carrier delta arrival at anchor. |
| `TestNodeArrivalCache.test_downstream_node_has_carrier` (276) | already-correct guard | Downstream node has composed carrier. |
| `TestNodeArrivalCache.test_multi_hop_reach_propagates` (292) | already-correct guard | Multi-hop reach via topological product. |
| `TestPreparedRuntimeBundle.test_phase1_window_queries_use_identity_carrier` (631) | already-correct guard | Window mode uses identity carrier. |
| `TestPreparedRuntimeBundle.test_phase1_cohort_leading_edge_uses_identity_carrier` (654) | already-correct guard | Cohort leading edge uses identity carrier. |
| `TestPreparedRuntimeBundle.test_phase1_non_latent_upstream_produces_active_dirac_carrier` (677) | already-correct guard | Non-latent upstream produces active Dirac-at-zero carrier. |
| `TestPreparedRuntimeBundle.test_phase1_latent_upstream_retains_real_carrier` (719) | already-correct guard | Latent upstream retains real carrier. |
| Other `TestForecastRuntimeIngressOrdering`, `TestScopeAndCarrierConsistency`, `TestAggregateISLikelihood`, `TestSubsetConditioningBlend`, `TestPreparedRuntimeBundle` | already-correct guards | All GREEN; no AP58/non-latency-specific assertions. |

#### `graph-editor/lib/tests/test_wp8_default_off.py`

Already inventoried in Stage 0a §1.13. All four tests are already-correct guards for the pre-WP8 admission contract; `WINDOW_SUBJECT_HELPER` is the live evidence family. Out of scope for 73n's AP58 sweep but pinned for Phase 1 invariance.

### 2.5. Single classified target list — AP58/non-latency targets and their 73n stages

| Test | File | Line | Target stage |
|---|---|---|---|
| `test_single_hop_non_latent_upstream_collapses_to_window[FAST]` | `test_cohort_factorised_outside_in.py` | 827 | Stage 5a (and Composition / Projection passes) |
| `test_single_hop_non_latent_upstream_collapses_to_window[SLOW]` | `test_cohort_factorised_outside_in.py` | 827 | Stage 5a (and Composition / Projection passes) |
| `test_degenerate_identity_and_instant_carrier_oracles_reduce_to_subject_kernel` | `test_cohort_factorised_outside_in.py` | 1115 | Stage 5a (and Composition / Projection passes) |
| `test_multihop_non_latent_upstream_collapse` | `test_cohort_factorised_outside_in.py` | 1185 | Stage 5b (and Composition / Projection passes) |

These four tests are the **named 73n acceptance criteria** inherited from 73m §11 open item 1. `strict=True` ensures any XPASS during 73n surfaces as a suite failure that prompts marker removal. No other AP58/non-latency tests in the inventory are 73n flip-to-green targets — every other AP58/non-latency test is either an already-correct guard, a dev-only oracle, an out-of-scope WP8 case, or the 73m §1B side-effect observation that the plan does not commit to closing.

**No test rewrite that skips τ=0 is acceptable** (plan §"Stage 0b" line 514): the four flip-to-green tests are the only `τ=0`-reading tests in the inventory; they assert correct contracts and must not be softened.

### 2.6. Disposition for `build_cohort_evidence_from_frames` and adjacent surfaces

Plan §"Stage 0b" line 516 demands a recorded decision for `build_cohort_evidence_from_frames` and adjacent surfaces — flip / retire / reduce-to-adapter.

**Decision: retire.** Not flip, not reduce-to-adapter.

Rationale:

- The function's sole live consumer post-73m is the cohort_maturity v3 row builder (`compute_cohort_maturity_rows_v3` at `cohort_forecast_v3.py:1180-1197`). Per 73m §10 / KNOWN_ANTI_PATTERNS AP58 the function contains the AP58 fork on the count axis at `:750-769` vs `:775-803`.
- 73n's design (plan §"Composition pass" line 356 + §"Projection pass" line 372) replaces the fork with two clean separations: (1) per-primitive conditioning produces conditioned timing/probability draws; (2) `subject_span` and `carrier_to_x` composition consume those primitives and produce the resolved runtime object; (3) projection reads the resolved object and writes rows. There is no `build_cohort_evidence_from_frames`-shaped intermediate.
- An adapter-reduction would preserve the function's name + signature while replacing the body. This is undesirable because the function's signature carries `is_window`, `frames`, `target_edge`, `anchor_from`, `anchor_to`, `sweep_to` — input-shape arguments that map to the legacy "build evidence from snapshot frames" abstraction. Stage 5b/c's projection takes a resolved primitive registry instead, so the input shape changes.
- Adjacent surfaces:
  - **`_resolve_frame_carrier_state`** (`cohort_forecast_v3.py:345`): retire alongside, including the legacy `build_upstream_carrier` call at `:408` and its `seed=43` RNG. The whole-graph path through `build_x_provider_from_graph` already consumes only `compose_carrier_to_x`; the scoped frame path is the documented 73n handoff gap and should be migrated to read the same composed runtime object.
  - **`build_upstream_carrier`** (`forecast_runtime.py:1522`): retire once `_resolve_frame_carrier_state` no longer calls it. The v2 copy at `cohort_forecast_v2.py:407` stays (v2 is dev-only, frozen).
  - **`_non_latency_rows`** (`cohort_forecast_v3.py:69-325`) + `test_non_latency_rows.py`: retire alongside per 73m §11 open item 2. Closed-form Beta-Binomial oracle status is no longer needed once the trajectory engine is the only row builder reading composed primitives.
  - **`FrameEvidence` dataclass** (`cohort_forecast_v3.py:318-342`): retire once `build_cohort_evidence_from_frames` is gone.

The retirement deadline is the same stage that lands the projection layer reading composed primitives directly — namely Stage 5a / 5b / 5c (the cutover stages, with feature flags per plan §"Stage 5a" line 664). The four named flip-to-green xfails (§2.5) reactivate green when retirement lands; if `strict=True` triggers an XPASS during the cutover stages, that is the signal to remove the xfail markers.

### 2.7. Stage 0b stop-condition discharge

Plan §"Stage 0b" stop condition (line 525): "a Stage 0b note produces (a) a single classified AP58/non-latency target list with each item carrying its target stage, (b) the F14 0.546-vs-0.70 gap localised to either the maturity-aware likelihood or the projection layer with concrete diagnostic numbers for each candidate, and (c) a recorded decision for `build_cohort_evidence_from_frames` and adjacent surfaces — flip target, retirement target, or reduced-to-adapter target."

Discharge:

- **(a) Classified target list**: §2.4 inventories every relevant test across five test files and assigns one of four classifications; §2.5 distils to the four named flip-to-green targets and their 73n stages (Stage 5a × 3, Stage 5b × 1).
- **(b) F14 gap localisation**: §2.2 captures concrete public-scalar / raw-Σy/Σx / IS-conditioning / model-curve numbers for both queries against the live working tree. §2.3 localises the gap as **closed at the public layer**: the maturity-aware likelihood now correctly produces the mature figure (Q1: 0.6925 vs truth 0.7000; Q2: 0.6010 vs truth 0.6000). The first runtime object whose state still contradicts the 73g invariants is `build_cohort_evidence_from_frames` (AP58 fork — 73g invariant 7 violation), but it does not affect the F14 public scalars on these queries — it manifests at small τ and on non-latency upstream/subject test fixtures.
- **(c) Recorded decision**: §2.6 records `build_cohort_evidence_from_frames` as a **retirement target**, with adjacent surfaces (`_resolve_frame_carrier_state`, `build_upstream_carrier`, `_non_latency_rows`, `FrameEvidence`, `test_non_latency_rows.py`) named for retirement at the same Stage 5a/5b/5c cutover.

**Stage 0b is complete. Stage 0c remains the next gating stage.**

A consequence of §2.3's localisation: Stage 3's "reuse-vs-replace" question for the existing maturity-aware likelihood resolves to **reuse** — the trajectory engine + IS conditioning at `forecast_state.py:1095-1199` is the conditioning substrate Stage 3 builds on top of, not a substrate Stage 3 replaces. This frames Stage 3's plan execution.

## 3. Stage 0c — Contracts, tolerances, and read coordination — added 1-May-26

Stage 0c commits the numeric oracles, snapshot DB read/admission contract, evidence-clock alignment contract, and primitive-count performance estimate that Stages 1–9 are bound by. Documentation-only, no source-code or test edits. Persistent-cache invalidation is not a Stage 0c gate (Stage 7 owns it).

### 3.1. Snapshot DB read/admission contract

#### Owner and contact point

- **Workstream**: `feature/snapshot-db-phase0` (current branch). Phase 0–4.5 complete (per [`docs/current/project-db/1-reads.md`](../project-db/1-reads.md), 9-Feb-26 status). Phase 5 (forecasting integration) is "not started — blocked on `analysis-forecasting.md`". The forecasting layer that 73n's Stages 2–6 will widen has not yet had its own Phase 5 cutover; 73n is implementation-coupled to that work but does not gate on it (CF reads the existing API surface today).
- **Owner / contact point**: greg@nous.co (current git user; sole owner of `feature/snapshot-db-phase0`). For read-contract questions during 73n Stages 2–7, escalate via direct user prompt or via comments on the snapshot DB design docs in [`docs/current/project-db/`](../project-db/).
- **No third-party owner exists** for the snapshot DB workstream as of 1-May-26. The plan §"Stage 0c" line 539 contact-point requirement is discharged by recording this fact: any read-contract change required by 73n is a self-coordinated change.

#### API surface CF evidence resolution consumes today

Defined in [`graph-editor/lib/snapshot_service.py`](../../graph-editor/lib/snapshot_service.py):

| Function | Purpose | Used by | Returns |
|---|---|---|---|
| `query_snapshots_for_sweep` (`:733-832`) | Returns ALL raw snapshot rows in `[anchor_from, anchor_to]` whose `retrieved_at` falls in `[sweep_from, sweep_to]` (date-level, inclusive). Mandatory `core_hash`; supports `equivalent_hashes` closure expansion. | `forecast_preparation.py:355` (`resolve_forecast_subjects`) → `compute_cohort_maturity_rows_v3` chain. | `List[Dict]` of `(param_id, core_hash, slice_key, anchor_day, retrieved_at, A, X, Y, median_lag_days, mean_lag_days, anchor_median_lag_days, anchor_mean_lag_days, onset_delta_days)`. |
| `query_virtual_snapshot` (`:2328-2510+`) | Latest-per-(anchor_day × slice_key) reconstruction with `retrieved_at <= as_at`. Implements the `asat()` DSL at the read layer. | Reconstructed via `evidence_adapters.reconstructed_asat_to_candidates` (`evidence_adapters.py:428-555`). | Dict with `success`, `rows`, `count`, `latest_retrieved_at_used`, `has_anchor_to`. |
| `query_snapshots_for_sweep_aggregated` (`:835-947`) | SQL-pushed-down aggregate of the same data shape (one row per `(anchor_day, tau)` summed across slice_keys). | Performance-optimised consumer; same logical contract as `query_snapshots_for_sweep`. | List of aggregated rows. |
| `query_snapshot_retrievals` (`:1939+`) | Retrieval-history audit. | Diagnostic only. | List of retrieval coordinates. |
| `query_batch_retrievals` (`:2177+`) | Batched retrieval of multiple param_ids at once. | Inventory pages. | Per-param_id retrieval lists. |

#### `retrieved_at` handling

- **Sweep**: filter is `retrieved_at >= sweep_from AND retrieved_at < (sweep_to + 1 day)` (date-level inclusive on both ends). Sweep returns ALL retrieved_at values within the window so the derivation layer can reconstruct virtual snapshots at each retrieval boundary.
- **As-at**: filter is `retrieved_at <= as_at` (datetime-level ceiling). `query_virtual_snapshot` then ranks rows per `(anchor_day, slice_key)` by `retrieved_at DESC` and emits the latest row in each group.
- **Materialised candidates** (`asat_materialised=True` per `evidence_merge.py:481-490`): exempt from the `retrieved_at <= as_at` admission gate, since FE-tier-1 materialisation has already enforced the boundary upstream of the merge layer. Default for all other candidate sources is to enforce the gate.
- **Per-primitive clock implication for Stage 2**: when a downstream primitive's local evidence day exceeds the public anchor `as_at`, the primitive can still admit observations whose `retrieved_at <= as_at` even if the primitive-local day comes later. Stage 2's evidence-clock alignment (§3.2 below) must respect this.

#### Read-through cache and write invalidation

- **Cache**: module-level `_cache: Dict[str, Tuple[float, Any]]` at `snapshot_service.py:132`, with default TTL `_CACHE_DEFAULT_TTL_S = 15 * 60` (15 minutes) and `_CACHE_MAX_ENTRIES = 256`. Cache keys are deterministic (`_cache_key` at `:184`): SHA-256 of the call's `(fn, args, kwargs)` JSON encoded.
- **Cache bypass**: ContextVar `_bypass_var` (`:139`) is request-scoped — concurrent async requests on a shared event loop see their own bypass state. `cache_bypass_ctx` context manager at `:164-181`; `set_cache_bypass` / `reset_cache_bypass` at `:146-157`.
- **Write invalidation**: `append_snapshots` (at `:319-495`, line 494) and `delete_snapshots` (at `:1890-1937`, line 1929) call `cache_clear()` (`:233-241`). **This is a coarse global clear**, not targeted invalidation. Every entry in the cache is dropped; the next read repopulates. This is acceptable today because reads are infrequent enough that the cost of a full repopulate is small, and CF currently does a fresh read per request.
- **CF cache exposure**: CF reads the cache transparently — `query_snapshots_for_sweep` and `query_virtual_snapshot` both check the cache before SQL. CF response identity does not depend on stable cache state across reads (the cache only reduces latency on warm calls). A snapshot write during a CF request might cause the next request to repopulate, but does not corrupt any in-flight CF response.
- **Stage 7 implication**: when 73n Stage 7 introduces persistent primitive or composition caches, the existing `cache_clear()` mechanism is too coarse — it would invalidate every primitive whether or not the snapshot write is relevant. Stage 7 must define a finer invalidation policy keyed on the snapshot-write coordinates (`param_id`, `core_hash`, `slice_key`, `anchor_day` range) intersecting each cached primitive's identity. **Not designed in this Stage 0c**; recorded here as the Stage 7 hand-off.

### 3.2. Evidence-clock alignment contract

#### Retrieval shape today vs Stage 2 deliverable

- **Today**: per-frame retrieval. `build_cohort_evidence_from_frames` (`cohort_forecast_v3.py:434+`) is fed pre-built virtual frames built upstream from snapshot reads. Per-primitive evidence binding does not exist — the function consumes `tau_data` indexed by `(anchor_day, tau)` and rebuilds per-cohort observations, but every primitive in a multi-hop request reuses the public anchor date bounds.
- **Stage 2 deliverable**: a request-scoped union-of-primitive-clocks superset. Evidence retrieval fetches a date range broad enough to cover every primitive-local clock in the request closure, and the per-primitive binding layer admits rows from each primitive's local arrival support. Stage 2 must NOT change unrelated callers of `merge_evidence_candidates`; the weighted view is confined to primitive evidence resolution.
- **Single retrieval pass vs per-primitive pass**: Stage 2 should fetch a single scenario-wide superset where possible (one `query_snapshots_for_sweep` call covering the union of primitive-local clock ranges) and bind per primitive in memory. The snapshot DB API supports this — `query_snapshots_for_sweep`'s mandatory `core_hash` plus `equivalent_hashes` closure means one call can cover the family. Per-primitive separate reads are acceptable only when primitives have disjoint hash families.

#### `arrival_weight[node_id][calendar_day]` map — Stage 2 construction deliverable

The new request-scoped abstraction. **Does not exist in live code today** — verified in Stage 0a §1.10.

- **Identity (cache key)**: `(scenario_id, request_root, context_and_case_scope, regime_or_hash_family, as_at, model_source_preference, parameter_fingerprint)`.
- **Field shape**: nested `Dict[node_id: str, Dict[calendar_day: date, weight: float]]` plus per-node provenance (which prefix CDFs / which composed transitions sourced the weights). The map's outer key set is the topologically-ordered set of primitive source nodes `U` reachable in the request topology.
- **Construction order**: graph topological order over the request closure. Each `arrival_weight[U]` consumes the prefix delay PMF from the source-of-truth provider (§ next bullet), and is reused across every primitive that takes `U` as its source node within the same request.
- **Source of truth for prefix delay PMFs**: existing span/carrier composition layer — `compose_carrier_to_x` (`carrier_composition.py:164`) produces deterministic and per-draw CDFs through `compose_span_kernel` (`span_kernel.py:291`) and `mc_span_cdfs` (`:312-360+`). `build_node_arrival_cache` (`forecast_state.py:382-410+`) is the per-node consumer. **No second timing implementation.** Plan §"Stage 0c" line 547 explicitly forbids one.
- **DAG topology**: doc 29b cases 1–9 (catalogued in Stage 0a §1.9) are covered by the existing DAG algebra in `compose_span_kernel._run_dp` and the topological iteration in `compose_carrier_to_x`. Stage 2 reuses that algebra unchanged. Cases 10–11 (overhanging-block-across-X, metadata mismatch) remain rejected. No special split/join branch may be introduced for evidence-clock alignment — the same DAG algebra serves both subject/carrier composition and evidence-clock provider.
- **Degraded entries**: when Stage 0c records a topology case as degraded or unsupported, the prefix-arrival map produces a degraded entry with explicit provenance, not a silently-approximate weight. None of doc 29b cases 1–9 are degraded today.

#### `as_at()` × primitive-local clocks

- **Rule**: a primitive's evidence-day support is defined by its source-node arrival clock (the prefix-arrival weights from anchor → U), NOT by the public anchor date bounds.
- **As-at admission**: each candidate observation must satisfy `retrieved_at <= scope.as_at`, regardless of how the primitive-local evidence day relates to the anchor date. The admission gate is on `retrieved_at`, not on `anchor_day`.
- **Anchor-date reuse failure mode**: a downstream primitive that reuses the public anchor date bounds will mis-admit when the primitive's local arrival clock shifts the support. The Stage 2 deterministic-shift test (plan §"Stage 2" line 612) is the primary regression net for this.
- **Tests vulnerable to anchor-date reuse**: cohort fixtures with non-trivial upstream prefix where `arrival_weight[U]` would shift the local evidence day. In the current test inventory:
  - Multi-hop cohort fixtures in `test_cohort_factorised_outside_in.py` parametrised by `cf-fix-deep-mixed` (multi-hop latent + non-latent terminal) — these run through `build_cohort_evidence_from_frames` today and already use `arrival_weight`-equivalent logic via the AP58 fork's `_carrier_cdf_at_tau`. After Stage 2's primitive-clock map lands, the assertions remain the same; only the upstream evidence-builder changes.
  - Any single-hop cohort fixture where the carrier path is non-trivial — synth-fo-gate single-hop tests (`test_single_hop_non_latent_upstream_collapses_to_window`) currently rely on the `is_window` fallback path; primitive-clock alignment changes their internal evidence accounting.

### 3.3. Numeric parity tolerances per axis and per stage

Plan §"Stage 0c" line 533 demands per-axis tolerances committed as concrete numbers (not "stochastic tolerance"), separated into shadow-comparison (parallel-run) and acceptance (flag-flip) bands.

#### Public-quantity tolerances per cutover stage

| Quantity | Stage | Shadow-comparison band | Acceptance band | Notes |
|---|---|---|---|---|
| Displayed rate (`p_infinity_mean`, `p.mean`, `midpoint` at saturation) | 5a (single-hop window + subject) | abs ±0.005, rel ±1.0% | abs ±0.002, rel ±0.4% | F14 Q1 oracle (§3.4) is the calibration anchor. |
| Displayed rate | 5b (multi-hop subject span) | abs ±0.008, rel ±1.5% | abs ±0.003, rel ±0.6% | Multi-hop has more accumulated MC variance; loosen slightly vs 5a. |
| Displayed rate | 5c (multi-hop window readout) | abs ±0.005, rel ±1.0% | abs ±0.002, rel ±0.4% | Window mode is single-clock; tighten back toward 5a's band. |
| Displayed rate | 6 (carrier consumer) | abs ±0.008, rel ±1.5% | abs ±0.003, rel ±0.6% | Active cohort A≠X: same MC tolerance as 5b. |
| Carrier reach (`carrier_reach`) | 5a / 5c | n/a (window mode → reach=1.0 identity) | exact match (1.0) | Window mode and A=X cohort. |
| Carrier reach | 5b / 6 | abs ±0.005, rel ±1.0% | abs ±0.002, rel ±0.4% | Active cohort A≠X. |
| ESS | all stages | ratio ≥ 0.5 (i.e. ESS ≥ S × 0.5) | ratio ≥ 0.7 (ESS ≥ S × 0.7) | `_IS_TARGET_ESS = 20.0` at `forecast_state.py:1244` is the per-cohort target; whole-trajectory ESS is the aggregate. Below 0.5 ratio, IS resampling is degraded; below 0.7 acceptance, refuse the cutover. |

These are the bands Stage 5a/5b/5c/6 cutover gates measure. Tests in `test_cohort_factorised_outside_in.py` use `_P_MEAN_ABS_TOL` (0.05 currently) — which is too loose for cutover gating. **Cutover-gate tests need to introduce tighter tolerances** that match the bands above; existing test tolerances stay at 0.05 for the broad regression net but the named cutover tests bind tighter.

#### Shadow-comparison vs acceptance — the protocol

- **Shadow phase**: both legacy and new paths run in parallel under the cutover feature flag (per plan §"Stage 5a" line 664). Outputs are compared row-by-row using the shadow band. Any breach produces a diagnostic record but does NOT abort the request — legacy output remains canonical.
- **Acceptance phase**: at flag flip, the new path becomes canonical. Outputs of representative fixtures (§3.4) must satisfy the acceptance band against the F14 oracle and against the legacy public output captured in §3.4 below. A breach blocks the flip.

#### Test rewrites — disciplined

Plan §"Stage 9" line 812 forbids tolerance-relaxation rewrites that hide changed semantics. The bands above are absolute floors for cutover gating; loosening any band requires Stage 0c to be re-opened with a recorded reason. The four flip-to-green xfails (Stage 0a §1.13) are the regression net for AP58 — tightening their tolerance is the cutover-flip signal.

### 3.4. Legacy public oracles for F14 and representative fixtures

Plan §"Stage 0c" line 535 demands legacy public outputs recorded for the named F14 queries plus representative `window(X-Y)` and `cohort(A, X-end)` fixtures.

Captured 1-May-26 against the live working tree (post-73m Phase 1 closure) using `bash graph-ops/scripts/analyse.sh <graph> <dsl> --type cohort_maturity --format json`:

| Fixture | DSL | Truth `p` | Public `p_infinity_mean` | Public `midpoint` (last τ) | `completeness` | Notes |
|---|---|---|---|---|---|---|
| F14 Q1 | `synth-simple-abc` `from(simple-a).to(simple-b).window(-90d:)` | 0.7000 | **0.6925** | 0.6911 | 0.7685 | §2.2 Q1. Resolved to `window(1-Feb-26:1-May-26)` today; pin to absolute window for wallclock invariance per AP57 if reused. |
| F14 Q2 | `synth-simple-abc` `from(simple-b).to(simple-c).cohort(1-Mar-26:3-Mar-26).asat(3-Mar-26)` | 0.6000 | **0.6010** | 0.5907 | 0 (no-evidence corner) | §2.2 Q2. As-at + narrow cohort window admits no observed evidence; output is prior projection. |
| Representative window — A=X identity | `synth-simple-abc` `from(simple-a).to(simple-b).window(-90d:)` (same as Q1) | 0.7000 | 0.6925 | — | — | A=X identity collapse fixture; same numbers as Q1. |
| Representative cohort — single-hop active | (TODO at Stage 5b entry — to be captured against `synth-fo-gate` or `cf-fix-deep-mixed` from `test_cohort_factorised_outside_in.py`) | — | — | — | — | The Stage 5a/5b cutover will need this oracle captured before flip. |
| Representative cohort — multi-hop active | (TODO at Stage 5b entry) | — | — | — | — | Same. |

The two F14 fixtures are sufficient to anchor Stage 5a and Stage 5c (single-hop and multi-hop window) tolerance gates. The representative cohort fixtures TODO will be captured at Stage 5b/6 entry against the synth-fo-gate / cf-fix-deep-mixed graphs that today drive the four flip-to-green xfails.

#### F14 gap commitment

The 73f-reported 0.546-vs-0.70 gap on Q1 is **closed**. The current public `p_infinity_mean = 0.6925` is within the 5a acceptance band (abs ±0.002 against the 0.7000 truth gives a target window of `[0.6980, 0.7020]`; Q1 currently produces 0.6925, slightly below the target window — but the 5a acceptance gate measures against the **legacy public output** (0.6925), not against truth. Truth comparison is for sanity-checking only.). Cutover acceptance is a same-output match within the §3.3 band, not a truth-recovery gate.

### 3.5. Primitive-count and runtime baselines

Plan §"Stage 0c" line 552 demands representative primitive counts and runtime cost recorded for scoped cohort_maturity, scoped window, and whole-graph CF.

#### Definition of a "primitive"

A transition primitive is a parameterised edge in the request closure (per 73n plan §"Transition primitive" line 60). For each primitive, the system resolves identity, scenario scope, evidence (when available), and posterior probability/timing draws — see plan §"Transition primitive" line 65–77 for the full contract.

#### Representative counts

| Fixture | Closure topology | Primitives | Note |
|---|---|---|---|
| F14 Q1 — `synth-simple-abc` window | single-hop, `x = a`, no carrier | **1** | The simple-a → simple-b edge. Identity carrier; no upstream primitive. |
| F14 Q2 — `synth-simple-abc` cohort | single-hop, `x ≠ a`, single-edge upstream | **2** | Carrier: simple-a → simple-b. Subject: simple-b → simple-c. |
| Whole-graph CF on `synth-simple-abc` | 3 nodes, 2 parameterised edges, no branching | **2** | Equal to the edge count; no closure expansion. |
| `synth-fo-gate` (fanout topology, used by single-hop xfails) | 1 anchor node → 1 fanout node → multiple subjects | 3-5 | Anchor → gate → fast / slow leg. Each leg is a separate subject query but shares the carrier. |
| `cf-fix-deep-mixed` (multi-hop, used by multi-hop xfails) | deeper chain, mixed latency/non-latency | 5-8 (estimated) | Used by `test_multihop_*` tests. Exact count to be measured at Stage 5b entry. |
| Representative production graph (e.g. real data-repo graph used by 73h F14 investigation) | many nodes, branching, leakage | 20-100+ | Whole-graph CF on a real production graph. Not measured here. |

#### Runtime baselines

Captured 1-May-26 with `time bash graph-ops/scripts/analyse.sh ...`:

| Fixture | Wall-clock | Notes |
|---|---|---|
| F14 Q1 (cold cache) | ~5.3 s | After BE restart; Node startup + module loads dominate. |
| F14 Q2 (warm cache) | ~3.6 s | No-evidence corner; less BE work. |
| F14 Q1 (warm cache repeat) | ~6.3 s | Variance ±1 s. |

CLI round-trip includes Node startup, HTTP, and BE compute. BE compute alone is ~1-2 s for these fixtures. Whole-graph CF on real production graphs has not been measured in this Stage 0c — recorded as a gap to close at Stage 5b/6/7 entry when whole-graph rollout begins.

#### Measurement method (re-runnable by later stages)

```
time bash graph-ops/scripts/analyse.sh <graph-name> '<dsl>' --type cohort_maturity --format json > /dev/null
```

Run with the BE warm (e.g. after one priming call). For Stage 7 cache hit-rate measurement, log `_cache_stats` from `snapshot_service.py` before and after the test; for primitive registry hit rate (Stage 7 deliverable), the registry will need its own counters.

### 3.6. Stage 0c stop-condition discharge

Plan §"Stage 0c" stop condition (line 557): "a Stage 0c contract note (a) commits specific numeric parity tolerances per axis for each of Stages 5a, 5b, 5c, and 6; (b) records the snapshot DB read/admission contract that Stages 2 and 3 will consume; (c) records the evidence-clock alignment contract that Stage 2 must implement, naming the request-scoped `arrival_weight[node_id][calendar_day]` map as a Stage 2 construction deliverable rather than something already available, and stating how complex topology reuses the existing DAG algebra; and (d) records the primitive-count and runtime baselines that performance gating decisions in later stages will reference."

Discharge:

- **(a) Numeric parity tolerances**: §3.3 commits per-axis bands (rate, carrier reach, ESS) for each of Stages 5a, 5b, 5c, 6, separated into shadow-comparison and acceptance phases. Concrete numbers, not "stochastic tolerance".
- **(b) Snapshot DB read/admission contract**: §3.1 records owner (greg@nous.co), Phase 0–4.5 status, full read API surface (`query_snapshots_for_sweep`, `query_virtual_snapshot`, plus aggregates), `retrieved_at` semantics for sweep vs as-at, materialised-candidate exemption, 15-min TTL read-through cache, and coarse cache_clear() invalidation on writes. Stage 7 hand-off recorded for finer invalidation.
- **(c) Evidence-clock alignment contract**: §3.2 records the retrieval shape (per-frame today; union-of-primitive-clocks superset for Stage 2), the new `arrival_weight[node_id][calendar_day]` map as a Stage 2 construction deliverable (not something live code produces), the source of truth for prefix delay PMFs (existing `compose_span_kernel` / `compose_carrier_to_x` building blocks; no second timing implementation), the topology coverage (doc 29b cases 1–9 via the existing DAG algebra; cases 10–11 rejected; no special split/join branch), the as-at × primitive-clock interaction, and tests vulnerable to anchor-date reuse.
- **(d) Primitive counts and runtime baselines**: §3.5 records representative primitive counts (1 / 2 / 2 for the three synth-simple-abc fixtures; 3-5 for synth-fo-gate; 5-8 estimated for cf-fix-deep-mixed; 20-100+ for production graphs not measured here) and runtime baselines (~3.6-6.3 s wall-clock for F14 fixtures with the analyse CLI). Measurement method recorded for later stages.

**Stage 0 (0a + 0b + 0c) is complete. Stage 1 is the next gating stage.**

#### Open follow-ups for later stages (not Stage 0c-blocking)

1. Stage 5a/5b/6 entry must capture the representative cohort fixture oracles flagged TODO in §3.4.
2. Stage 5b entry must measure exact primitive counts on `synth-fo-gate` and `cf-fix-deep-mixed`.
3. Stage 7 must define a finer cache invalidation policy on snapshot writes (the current global `cache_clear()` is too coarse for primitive caches).
4. Stage 7 must measure whole-graph CF runtime on at least one representative production graph before it widens whole-graph rollout.
5. Stage 5a/5b/5c/6 must introduce tightened tolerance constants that match the §3.3 acceptance bands; the existing test `_P_MEAN_ABS_TOL = 0.05` is too loose for cutover gating but stays for the broad regression net.

