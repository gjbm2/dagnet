# 73n Stage 1 — Primitive Posterior Contract — note

**Status**: Stage 1 landed
**Date opened**: 1-May-26
**Plan**: [`73n-carrier-evidence-conditioning-implementation-plan.md`](73n-carrier-evidence-conditioning-implementation-plan.md) §"Stage 1 — Primitive Posterior Contract"
**Stage 0a baseline**: [`73n-stage-0-baseline.md`](73n-stage-0-baseline.md) §1.12 (fixed-seed RNG inventory)

---

## 1. Stage 1 deliverables

### 1.1. Primitive posterior contract module

[`graph-editor/lib/runner/primitives.py`](../../graph-editor/lib/runner/primitives.py) defines the runtime shape of a conditioned transition primitive. It is contract-only: pure dataclasses, enums, hashed key derivation, and the keyed-RNG seam. The module deliberately imports nothing from `forecast_runtime`, `forecast_state`, `span_kernel`, `carrier_composition`, or `cohort_forecast_v3` so that contract construction can be tested without invoking composition (plan §595).

Public surfaces:

- `TransitionIdentity`, `PrimitiveScope` — identity and scenario scope.
- `ConditioningStatus` — `CONDITIONED`, `PRIOR_ONLY`, `STRUCTURALLY_DETERMINISTIC`, `UNSUPPORTED_RESIDUAL`, `DEGRADED`, `UNAVAILABLE`.
- `DrawFamilyMode` — `KEYED_PRIOR`, `REUSED_IS`, `MOMENTS_ONLY`.
- `TimingFamily` — `LATENT`, `NON_LATENT`, `DETERMINISTIC`.
- `WeightedEvidenceRow`, `WeightedPrimitiveEvidenceView` — separate from `evidence_merge.EvidenceSet`; floating-point `n_weighted`/`k_weighted` per the plan §565 contract.
- `SubsetPolicyProvenance`, `CompatibilityBlendProvenance`, `ResidualPolicyProvenance` — three named slots that keep effective-evidence selection, doc-52 row/draw blending, and residual-closure refusal distinct (plan §234).
- `ProbabilityPosterior`, `TimingPosterior` — posterior summaries; non-latency timing keeps Dirac-at-zero structural identity separate from probability conditioning (plan §583).
- `ConditionedTransitionPrimitive` — the runtime object the request-scoped primitive registry will store from Stage 2 onward. Contract-level draw-family refusal is enforced via `is_draw_coherent`, `probability_draws()`, `timing_draws()`, all of which raise `DrawFamilyUnavailable` for moments-only / degraded / unavailable / unsupported-residual primitives (plan §591).
- `to_provenance_dict()` — JSON-friendly serialisation reusable by Stage 8 diagnostics.
- `DrawFamilyKey`, `make_rng(key, derivation)` — the keyed-RNG seam. Stage 1's deliverable for retiring fixed-seed RNG sites.

### 1.2. Contract tests

[`graph-editor/lib/tests/test_primitive_contract.py`](../../graph-editor/lib/tests/test_primitive_contract.py) — 14 tests, all green. Coverage:

- Construction and serialisation for each of the four states named in plan §567-572: conditioned parameterised, prior-only parameterised, unsupported residual, unavailable/degraded.
- Structurally non-latency primitive: probability draws live, Dirac-at-zero timing tiled across draws, `mu`/`sigma`/`onset` compatibility fields are provenance-only.
- Raw `E` (scope key), weighted view, and effective `e` are explicitly separate even when numerically equal — `SubsetPolicyProvenance.equality_explicit` flags the case.
- Draw-family identity: matching keys produce byte-equal draws, distinct keys produce independent streams, distinct derivations under the same key produce independent streams.
- `make_rng` rejects unknown derivations.
- Moments-only and unavailable primitives refuse to serve coherent draws regardless of `DrawFamilyMode` (status takes precedence over mode for refusal).
- The weighted view does not subclass `evidence_merge.EvidenceSet`; it carries floating-point totals while preserving raw integer counts on each row.

### 1.3. Fixed-seed retirement xfails

[`graph-editor/lib/tests/test_primitive_seed_retirement.py`](../../graph-editor/lib/tests/test_primitive_seed_retirement.py) — 11 strict xfails plus 1 meta-test. Each xfail tracks one primitive-draw fixed-seed call site recorded in 73n-stage-0-baseline.md §1.12. The meta-test asserts every derivation named in an xfail reason is registered in `runner.primitives._DERIVATIONS`.

Each xfail uses `strict=True` so that when migration lands, the assertion passes, the XPASS surfaces as a suite failure, and the next PR removes the marker. The xfail reason on each site names:

- the file:line and function from the Stage 0a inventory;
- the seed value being retired;
- the target Stage that owns the migration;
- the `make_rng` derivation the site must consume after migration.

Static inspection (read the source file, locate the named function body, assert the body does not contain `np.random.default_rng(seed=…)`) is sufficient because the keyed seam is a contract: a call site either consumes `make_rng` or it doesn't. If a future refactor moves a site into a different function, update the test's `fn_name` parameter.

---

## 2. Migration map — primitive-draw fixed-seed retirement targets

Stage 0a baseline §1.12 records 14 lines across 11 distinct call sites (lines 653 and 731 in `forecast_state.py` are one logical site — the `_BLEND_SEED = 43` constant and its single use in `_make_blend_permutation`). Each is tracked by an xfail in `test_primitive_seed_retirement.py`.

| Site (Stage 0a §1.12) | Function | Seed | Target stage | `make_rng` derivation |
|---|---|---|---|---|
| `forecast_state.py:193` | `_compute_completeness_at_age` | 71 | Stage 3 | `primitive_completeness_sd` |
| `forecast_state.py:405` | `build_node_arrival_cache` | 42 | Stage 2 | `node_arrival_cache` |
| `forecast_state.py:1031` | `compute_forecast_trajectory` | 42 | Stage 3 | `primitive_p_draws` (also `primitive_timing_draws`, `primitive_is_resampling` — one of three streams the site needs) |
| `forecast_state.py:1367` | `_evaluate_cohort` (unconditioned-loop drift) | 42 | Stage 3 | `primitive_drift` |
| `forecast_state.py:653,731` | `_BLEND_SEED` + `_make_blend_permutation` | 43 | Stage 3 | `doc52_blend_permutation` |
| `forecast_runtime.py:1826` | `prepare_forecast_runtime_inputs` (subject-span full-path MC) | 42 | Stage 5b | `subject_span_full_path_mc` |
| `forecast_runtime.py:1836` | `prepare_forecast_runtime_inputs` (subject-span epistemic overlay) | 42 | Stage 5b | `subject_span_epistemic_overlay` |
| `forecast_runtime.py:1854` | `prepare_forecast_runtime_inputs` (anchor-relative edge p MC) | 42 | Stage 5b | `anchor_relative_edge_p_mc` |
| `forecast_runtime.py:1864` | `prepare_forecast_runtime_inputs` (anchor-relative edge epistemic) | 42 | Stage 5b | `anchor_relative_edge_epistemic` |
| `forecast_runtime.py:1895` | `prepare_forecast_runtime_inputs` (last-edge frontier CDF, multi-hop) | 42 | Stage 5b | `last_edge_frontier_cdf` |
| `cohort_forecast_v3.py:399` | `_resolve_frame_carrier_state` (legacy `build_upstream_carrier`) | 43 | Stage 6 | `legacy_upstream_carrier_v3` (or DELETION — see note below) |

**Note on `_resolve_frame_carrier_state`**: Stage 0b §2.6 records this site as a retirement target; Stage 6 ("Carrier Consumer") removes the scoped compatibility split entirely. The `make_rng` derivation `legacy_upstream_carrier_v3` is registered for the case where the site is retained behind an explicit reviewed dev/diagnostic flag. If Stage 6 deletes the path outright, the xfail flips green by virtue of the function ceasing to exist, the XPASS surfaces, and the marker is removed alongside the deletion.

**Why the IS-resampling and drift sites share Stage 3**: the plan's "Primitive conditioning pass" (§330) names primitive posterior construction as the new owner of the maturity-aware likelihood. Stage 3 consequently owns the retirement of every RNG site inside the trajectory engine that participates in primitive-draw construction. The (p, μ, σ, onset) MVN draws and IS-resampling at `forecast_state.py:1031` are split into three separate `make_rng` derivations (`primitive_p_draws`, `primitive_timing_draws`, `primitive_is_resampling`) so consumers of just the probability stream don't inadvertently consume timing-resampling state.

---

## 3. Out-of-scope-classified non-primitive RNG sites

Stage 0a baseline §1.12 explicitly classifies the following five fixed-seed RNG sites as out of scope for primitive draw coherence. Stage 1 confirms each classification stands; these sites do NOT need to migrate to `make_rng` and remain at their fixed seeds for chart determinism or dev-only diagnostic reasons.

| Site | Role | Why out of scope |
|---|---|---|
| `funnel_engine.py:165` (`_compute_path_bars`) | Bar-chart MC sampling of FE epistemic α/β | Not part of CF primitive draws. Chart visualisation only. |
| `funnel_engine.py:240` (`_compute_path_bars_cf`) | CF bar-chart variance mixture | Chart visualisation only; consumes per-edge CF response scalars, not primitive posteriors. |
| `confidence_bands.py:106` (`reconstruct_band_from_heuristic_sigma`) | FE topo fallback heuristic-σ reconstruction | Used only when CF has not landed; not a primitive-draw site. |
| `cohort_forecast.py:645,944` (v1) | Legacy v1 cohort maturity row builder | `devOnly: true` in `analysis_types.yaml`. v1 is frozen. |
| `cohort_forecast_v2.py:659,721` (v2) | Legacy v2 cohort maturity row builder | `devOnly: true`. v2 is frozen. |

These five sites must remain identifiable by an audit so that any later regression that wires them into a primitive-draw pathway is caught. The Stage 1 note here is the canonical record of their out-of-scope status; if any site moves into a primitive-draw pathway, the audit must reclassify it (move to §2 above) and wire an xfail in `test_primitive_seed_retirement.py` with a target stage.

---

## 4. Stop-condition discharge

Plan §595 stop condition for Stage 1:

> tests can construct and serialise primitive posterior objects for each state without invoking carrier or subject composition, can distinguish raw `E`, the weighted evidence view, effective `e`, primitive conditioning policy, and any separate compatibility blend, can verify that two test consumers presenting the same draw-family key receive identical draws while a moments-only primitive refuses to act as a coherent draw family, and can verify that no primitive's draw construction reads a fixed-seed call site recorded by Stage 0a unless that site is explicitly out-of-scope-classified.

| Stop-condition clause | Discharge |
|---|---|
| Construct + serialise primitive posterior objects for each state | `test_conditioned_parameterised_primitive_construct_and_serialise`, `test_prior_only_primitive_has_empty_evidence_and_is_not_misreported`, `test_unsupported_residual_primitive_names_required_branch_and_does_not_serve_draws`, `test_unavailable_or_degraded_primitive_records_missing_inputs_and_refuses_draws`. All green. |
| Without invoking carrier or subject composition | `runner/primitives.py` imports nothing from `forecast_runtime`, `forecast_state`, `span_kernel`, `carrier_composition`, or `cohort_forecast_v3`. Tests construct primitives directly without calling any composer. |
| Distinguish raw `E`, weighted view, effective `e`, conditioning policy, compatibility blend | `test_raw_weighted_and_effective_evidence_are_explicitly_separate`. The primitive carries five separate slots: `raw_evidence_scope_key`, `weighted_evidence`, `effective_evidence_totals`, `subset_policy`, `compatibility_blend`. `SubsetPolicyProvenance.equality_explicit` flags the e == E case. |
| Two consumers with the same draw-family key receive identical draws | `test_two_consumers_with_matching_draw_family_keys_receive_identical_draws`, `test_make_rng_separates_derivations_under_a_single_key`, `test_draw_family_key_digest_is_stable_across_calls`. |
| Moments-only primitive refuses to act as a coherent draw family | `test_moments_only_primitive_refuses_to_serve_a_coherent_draw_family`, `test_unavailable_status_refuses_draws_even_when_mode_is_keyed_prior`. Refusal raises `DrawFamilyUnavailable` from `probability_draws()` and `timing_draws()`. |
| No primitive's draw construction reads a fixed-seed call site recorded by Stage 0a unless that site is explicitly out-of-scope-classified | `test_primitive_seed_retirement.py`: 11 strict xfails record every primitive-draw site from Stage 0a §1.12; meta-test verifies every named derivation is registered. The 5 out-of-scope sites are recorded in §3 above. |

---

## 5. What Stage 1 deliberately does NOT do

- It does not migrate any of the 14 primitive-draw fixed-seed sites. Each is recorded as a strict xfail with a target stage (§2).
- It does not change `evidence_merge.EvidenceSet` semantics for any non-primitive caller (plan §565). The weighted view is a SEPARATE object.
- It does not implement the request-scoped prefix-arrival map `arrival_weight[node_id][calendar_day]`. Stage 2 owns that construction (plan §605).
- It does not call `merge_evidence_candidates` or any retrieval-superset binding. Stage 2 owns evidence-clock alignment (plan §603-605).
- It does not touch any Stage 0a inventory site that is currently in production. The contract is dormant until Stages 2-6 wire it in behind `single_hop_primitive_readout`, `multi_hop_subject_composition`, `multi_hop_window_readout`, and the carrier consumer flag.

Open question for later stages: the `prepare_forecast_runtime_inputs` site has five `seed=42` MC sites; if Stage 5b's flag-gated cutover migrates them in lockstep, the five xfails should flip together. If they migrate independently, each xfail is independent — the existing markers already accommodate this.
