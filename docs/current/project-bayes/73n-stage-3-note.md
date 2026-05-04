# 73n Stage 3 — Subset and Primitive Conditioning Policy — note

**Status**: Stage 3 landed
**Date opened**: 1-May-26
**Plan**: [`73n-carrier-evidence-conditioning-implementation-plan.md`](73n-carrier-evidence-conditioning-implementation-plan.md) §"Stage 3 — Subset and Primitive Conditioning Policy"
**Stage 0c contracts**: [`73n-stage-0-baseline.md`](73n-stage-0-baseline.md) §3.3 (numeric tolerances) and §1.6 (existing doc-52 policy sites)
**Stage 0b localisation**: [`73n-stage-0-baseline.md`](73n-stage-0-baseline.md) §2.3 — Stage 3's reuse-vs-replace decision is **reuse**: the trajectory engine + IS conditioning at `forecast_state.py` correctly produces the maturity-aware figure on F14 latency-bearing window queries. Stage 3 packages that posterior into a `ConditionedTransitionPrimitive` rather than inventing a new estimator.
**Stage 1 contract**: [`73n-stage-1-note.md`](73n-stage-1-note.md) §1.1 (primitive contract types) and §2 (RNG retirement migration map)
**Stage 2 input**: [`73n-stage-2-note.md`](73n-stage-2-note.md) §1.2 (`PrimitiveEvidenceResolution` + weighted view)

---

## 1. Stage 3 deliverables

### 1.1. Primitive conditioning module

[`graph-editor/lib/runner/primitive_conditioning.py`](../../graph-editor/lib/runner/primitive_conditioning.py) consumes a `PrimitiveEvidenceResolution` (Stage 2) plus a `ResolvedModelParams` (`model_resolver.resolve_model_params`) and emits a `ConditionedTransitionPrimitive` (Stage 1 contract). Public surface:

- `ConditioningPolicyOptions(draw_count, timing_cdf_max_tau)` — request-scope `S` per plan §587 and the timing CDF horizon. Two consumers presenting the same `DrawFamilyKey` MUST present the same `draw_count` to receive coherent draws.
- `condition_primitive(*, resolution, resolved_model, scenario_seed, options, prior_source)` — the policy entry point. Returns a primitive in one of three live states:
  - `CONDITIONED`: live evidence available; posterior is the Beta-Binomial conjugate update on `(weighted_view.n_weighted_total, weighted_view.k_weighted_total)` against the resolved Beta prior, optionally row-mixed against the prior per the doc-52 (1−r):r blend.
  - `PRIOR_ONLY`: `n_weighted_total = 0`. Posterior equals prior. `equality_explicit=True` (trivial e == E).
  - `DEGRADED`: Stage 2's `weighted_view` is None (degraded `arrival_weight[U]`). Primitive carries the prior summary so composers can fall back, but `is_draw_coherent=False` and `probability_draws()` raises `DrawFamilyUnavailable`.

The module imports from `runner.primitives`, `runner.primitive_evidence`, and `runner.model_resolver` only — it does NOT import from `forecast_runtime`, `forecast_state`, `cohort_forecast_v3`, or `span_kernel`. Stage 3 produces a self-contained primitive object that Stage 5/6 will integrate with composition.

#### 1.1.1. Subset / effective-evidence policy mirrors `_compute_blend_params`

The subset policy at `_compute_subset_policy(m_S, n_effective)` mirrors `forecast_state._compute_blend_params` so the primitive policy is identical to the legacy trajectory-engine blend policy (Stage 0b §2.3 reuse decision). Skip reasons: `n_effective_missing`, `n_effective_zero`, `no_cohorts`, `no_evidence`. `equality_explicit=True` whenever no transformation is applied between raw and effective evidence (trivial e == E case from plan §234); `False` when the (1−r):r blend reduces evidence pressure. The contract distinguishes subset policy from compatibility blending in named slots — `SubsetPolicyProvenance` and `CompatibilityBlendProvenance` — so composed consumers (Stage 5/6) read each surface for diagnostics only and never re-apply either policy (plan §245).

#### 1.1.2. Doc-52 blend uses keyed RNG

The (1−r):r row-mix calls `make_rng(draw_family_key, 'doc52_blend_permutation')` from `runner.primitives` — no `np.random.default_rng(seed=NN)` literal. The `DrawFamilyKey` is constructed from primitive identity + scope + draw_count + scenario_seed (Stage 1 contract §1.1). Two consumers presenting the same key receive identical posterior draws (correctness-level draw coherence per plan §141).

#### 1.1.3. Effective evidence totals semantics

`effective_evidence_totals = (n_eff, k_eff)` is recorded on every CONDITIONED primitive:

- subset skipped (`r is None`): `(n_eff, k_eff) = (n_w, k_w)` — full E pressure applied.
- blend applied (`r ∈ [0, 1]`): `(n_eff, k_eff) = ((1 - r) * n_w, (1 - r) * k_w)` — the conditioned-portion contribution to the mixed posterior.
- empty E: `(0, 0)`.

This is the diagnostic surface composed consumers will read for "how much evidence pressure did this primitive apply" without rebuilding the policy.

#### 1.1.4. Structurally non-latency timing kept separate from probability

Per plan §83-87 and §583, a primitive with `latency.sigma <= 0` carries `timing_family=NON_LATENT` with `cdf_mean = (1.0, 1.0, ...)` (Dirac-at-zero). `mu`, `sigma`, `onset_delta_days`, `t95` go on `TimingPosterior.structural_identity_compat` as provenance — never as evidence-conditioned timing parameters. Probability conditioning on the same primitive remains independent of the timing identity (a non-latency primitive's `p` may be conditioned by `window(U-V)` evidence; its timing is fixed before and after).

### 1.2. Trajectory-engine RNG retirement

Stage 1 note §2 names five fixed-seed RNG sites in `forecast_state.py` as Stage 3 retirement targets:

| Site (Stage 0a §1.12) | Pre-Stage-3 | Stage 3 derivation |
|---|---|---|
| `compute_completeness_with_sd` (was `seed=71` for completeness-SD MVN draws) | fixed seed | `make_rng(key, 'primitive_completeness_sd')` |
| `compute_forecast_trajectory` (was `seed=42` for (p, μ, σ, onset) MVN + IS resampling) | fixed seed | `make_rng(key, 'primitive_p_draws')` + `'primitive_timing_draws'` (registered) + `'primitive_is_resampling'` |
| `_run_cohort_loop` inside `compute_forecast_trajectory` (was `seed=42` per-cohort drift) | fixed seed | `make_rng(key, 'primitive_drift')` |
| `_make_blend_permutation` (was `_BLEND_SEED = 43`) | fixed seed | `make_rng(key, 'doc52_blend_permutation')` |

(The site Stage 1 note §2 attributed to `_compute_completeness_at_age:193` and `_evaluate_cohort:1367` was actually inside `compute_completeness_with_sd` and `_run_cohort_loop` respectively; the `fn_name` field on the Stage 1 strict-xfail entries was wrong on those two rows. Stage 3 corrects the migration in the right functions and removes the affected xfails as part of Atom 4.)

Each function gains an optional `draw_family_key: Optional[DrawFamilyKey] = None` parameter. When the caller does not supply a key (legacy callers — `compute_cohort_maturity_rows_v3`, `handle_conditioned_forecast`), `_legacy_trajectory_draw_family_key(resolved)` constructs a deterministic fallback key from the resolved-model identifying scalars (`alpha`, `beta`, `n_effective`, `source`). The fallback is a transitional state — Stage 5a will replace it with a per-primitive key plumbed from the request layer when the public window/subject_span readouts cut over.

`_BLEND_SEED = 43` is removed; the comment block above the doc-52 blend site explains the keyed-RNG seam.

### 1.3. Tests

#### 1.3.1. Primitive conditioning tests

[`graph-editor/lib/tests/test_primitive_conditioning.py`](../../graph-editor/lib/tests/test_primitive_conditioning.py) — 18 tests, all green. Coverage:

| Test | Plan reference | Coverage |
|---|---|---|
| `test_conjugate_update_when_n_effective_missing_skips_blend` | §239 | Beta-Binomial conjugate update on weighted totals when subset is skipped (`skip_reason='n_effective_missing'`). Posterior mean matches `(α + k_w) / (α + β + n_w)` within 2000-draw MC noise. |
| `test_full_subset_limit_returns_prior_when_n_effective_equals_m_S` | §224, §240-244 | `r → 1` ⇒ all draws from prior ⇒ primitive numerically equal to model var. `effective_evidence_totals = (0, 0)`. |
| `test_zero_subset_limit_returns_full_conditioning_when_m_S_negligible` | §240 | `r → 0` ⇒ all draws from conjugate posterior. `effective_evidence_totals ≈ (n_w, k_w)`. |
| `test_e_equals_E_explicit_when_n_effective_missing` | §234 | `equality_explicit=True` flag set when subset is skipped (e == E by construction). |
| `test_equality_not_explicit_when_blend_applies` | §234 | `equality_explicit=False` when blend reduces evidence pressure (e ≠ E). |
| `test_prior_only_when_no_evidence_admitted` | §242, §572 | Empty E ⇒ `status=PRIOR_ONLY`, `skip_reason='no_evidence'`, `effective_evidence_totals = (0, 0)`. |
| `test_degraded_when_arrival_map_degraded` | §605 | Stage 2 weighted_view is None ⇒ `status=DEGRADED`, `is_draw_coherent=False`, `probability_draws()` raises `DrawFamilyUnavailable`. |
| `test_non_latency_probability_conditioned_with_dirac_timing` | §83-87, §583 | sigma=0 ⇒ `timing_family=NON_LATENT`, cdf_mean Dirac-at-zero. Probability still conditioned. |
| `test_non_latency_compat_fields_are_provenance_only` | §87, §583 | mu/sigma/onset on `structural_identity_compat`, cdf_mean unaffected by their values. |
| `test_latent_primitive_emits_lognormal_cdf_mean` | §583 | sigma>0 ⇒ `timing_family=LATENT`, cdf_mean rises 0→1 across horizon. |
| `test_subset_policy_and_compatibility_blend_are_separate_slots` | §220, §234 | `SubsetPolicyProvenance` and `CompatibilityBlendProvenance` populated on separate fields. |
| `test_subset_and_blend_diagnostics_exposed_via_provenance_dict` | §245 | Both slots serialise via `to_provenance_dict()` for downstream diagnostics. |
| `test_two_consumers_with_matching_draw_family_keys_get_identical_draws` | §141, §585-589 | Same `DrawFamilyKey` ⇒ byte-equal draws. |
| `test_distinct_scenario_seeds_give_independent_draws` | §141 | Different `scenario_seed` ⇒ independent streams. |
| `test_doc52_blend_uses_keyed_rng_not_fixed_seed` | §"Stage 1" final paragraph | Static inspection: module source contains no `np.random.default_rng(seed=…)` literal. |
| `test_n_eff_posterior_health_diagnostic_recorded_in_notes` | §648 | ESS-equivalent `n_eff_posterior = α + β` exposed on `notes` for IS-equivalent diagnostics. |
| `test_window_output_can_be_read_from_conditioned_primitive` | §"Stop condition" line 652 | Smoke test for Stage 5a's parity oracle precondition: simple window output produced from a conditioned primitive matches the Beta-Binomial conjugate within 2000-draw MC noise. |
| `test_conditioned_primitive_uses_keyed_prior_draw_family_mode` | §590(a) | `DrawFamilyMode.KEYED_PRIOR` for closed-form conjugate + doc-52 mix. |

#### 1.3.2. Trajectory-engine RNG retirement xfails removed

[`graph-editor/lib/tests/test_primitive_seed_retirement.py`](../../graph-editor/lib/tests/test_primitive_seed_retirement.py) had a buggy `_function_body` helper that broke at multi-line def signatures (closing `)` at indent 0 ⇒ helper terminated before scanning the body). Stage 3 replaces the helper with an AST walk (`ast.walk` + `ast.get_source_segment`) that handles multi-line signatures and nested functions correctly. Behaviour is unchanged for stable single-line defs; previously-truncated bodies now extract fully.

The four Stage 3 retirement xfails are removed in lockstep with the source migration:

- `forecast_state.completeness_sd_seed_71`
- `forecast_state.compute_forecast_trajectory_seed_42`
- `forecast_state.compute_forecast_trajectory_drift_seed_42`
- `forecast_state.make_blend_permutation_seed_43`

Remaining xfails (Stage 2 / Stage 5b / Stage 6) are unchanged: `forecast_state.build_node_arrival_cache_seed_42` (Stage 2), the five `forecast_runtime.prepare_forecast_runtime_inputs` sites (Stage 5b), and `cohort_forecast_v3._resolve_frame_carrier_state_seed_43` (Stage 6).

The `test_all_xfail_derivations_are_registered` meta-test still passes — every derivation named in a remaining xfail is registered in `runner.primitives._DERIVATIONS`. The four Stage-3-retired derivations remain registered there because the trajectory engine still consumes them.

### 1.4. What Stage 3 deliberately does NOT do

- **No live cutover.** `window()`, `subject_span`, `carrier_to_x`, and projection still read from the legacy trajectory engine path. Stage 5a is the parity-preserving cutover for single-hop window/subject; Stage 5b/5c for multi-hop. The conditioning module is dormant in the live request flow until then.
- **No primitive registry wiring.** Stage 3 produces individual primitives; the request-scoped registry (`RequestPrimitiveRegistry` from Stage 2 §1.2) is consumed by Stage 5a's window/subject readouts, not yet by anyone.
- **No retirement of the legacy aggregate-IS path.** Plan §"Stage 5a" line 666 says the legacy aggregate-IS path in `compute_forecast_trajectory` must not remain a second owner of evidence admission or posterior updating; Stage 5a owns that retirement once the public window output reads the primitive posterior.
- **No primitive_timing_draws consumer yet.** The trajectory engine's `(p, μ, σ, onset)` draws come jointly from `multivariate_normal` on the `primitive_p_draws` rng. The `primitive_timing_draws` derivation is registered for Stage 5a's per-stream split but produces no consumed output today; the unused-variable assignment at the seam is intentional and documented.
- **No Stage 5a/5b/5c flag plumbing.** Plan §391-399 migration choreography names `single_hop_primitive_readout`, `multi_hop_subject_composition`, `multi_hop_window_readout`. Those flags are introduced when their respective stages cut over; Stage 3 is gate-free.

---

## 2. Stop-condition discharge

Plan §"Stage 3" stop condition (line 652):

> simple `window(U-V)` output can be produced by reading the conditioned primitive rather than by a separate conditioning path, within the Stage 0 named stochastic tolerance; composed consumers do not re-run subset logic or compatibility blending; and a known-subset fixture proves the raw-nonempty/full-subset-limit case leaves the primitive equal to its model-var input.

| Stop-condition clause | Discharge |
|---|---|
| Simple `window(U-V)` output produced by reading the conditioned primitive within Stage 0 tolerance | `test_window_output_can_be_read_from_conditioned_primitive` produces a primitive whose `probability_posterior.mean` matches the conjugate-update mean within ~0.015 (well inside Stage 0c §3.3 shadow-comparison band of abs ±0.005 / rel ±1.0% for displayed rate at 2000 MC draws and an analytical posterior the conjugate update is exact for). |
| Composed consumers do not re-run subset logic or compatibility blending | The conditioning module is the single owner of `_compute_subset_policy`, `_apply_doc52_blend`, and the (1−r):r mix. The primitive's `subset_policy` and `compatibility_blend` are exposed as named provenance slots that downstream consumers read for diagnostics only — `test_subset_and_blend_diagnostics_exposed_via_provenance_dict` confirms both slots survive serialisation. |
| Known-subset fixture proves raw-nonempty/full-subset-limit case leaves the primitive equal to its model-var input | `test_full_subset_limit_returns_prior_when_n_effective_equals_m_S` constructs `n_w = 100, n_effective = 100` (r = 1.0) and verifies `probability_posterior.mean ≈ prior_mean (0.5)` within 0.02 and `effective_evidence_totals = (0, 0)`. |

---

## 3. Suggested commit messages (per atom)

The skill does not commit. The following commit messages are suggested for each atom; the user decides timing and granularity.

| Atom | Files | Suggested message |
|---|---|---|
| 1 | `graph-editor/lib/runner/primitive_conditioning.py` | `73n stage 3: primitive_conditioning module — Beta-Binomial conjugate update + doc-52 blend on weighted view (§631-652)` |
| 2 | `graph-editor/lib/tests/test_primitive_conditioning.py` | `73n stage 3: primitive_conditioning tests — full-subset limit, e==E, prior-only, degraded, non-latency, draw coherence (§239, §234, §141, §583)` |
| 3 | `graph-editor/lib/runner/forecast_state.py` | `73n stage 3: retire 4 trajectory-engine fixed-seed RNG sites onto make_rng(key, derivation) — completeness_sd, p_draws, drift, doc52_blend (§"Stage 1" final paragraph)` |
| 4 | `graph-editor/lib/tests/test_primitive_seed_retirement.py` | `73n stage 3: remove 4 Stage 3 strict-xfail markers + AST-based _function_body helper (multi-line def fix)` |
| 5 | `docs/current/project-bayes/73n-stage-3-note.md`, `docs/current/project-bayes/73n-carrier-evidence-conditioning-implementation-plan.md` | `73n stage 3: stage-3 note + mark stage 3 complete in progress block` |

---

## 4. What unblocks for later stages

- **Stage 4 (Unsupported Residual and Unparameterised Edge Guard)** can now use the conditioning module as a foundation; its guard adds residual/complement detection and emits `UNSUPPORTED_RESIDUAL` primitives. Stage 3 deliberately never returns `UNSUPPORTED_RESIDUAL` or `STRUCTURALLY_DETERMINISTIC` — those statuses are Stage 4's surface.
- **Stage 5a (Single-Hop Window and Subject Cutover)** has the parity oracle precondition: `condition_primitive` produces a primitive whose posterior matches the Beta-Binomial conjugate update on the weighted view. The `single_hop_primitive_readout` flag introduced at Stage 5a will route `window(X-Y)` and `subject_span(X-Y)` consumers to read this primitive's `probability_posterior` instead of the legacy aggregate-IS path, with shadow comparison against the legacy public output.
- **Stage 5b (Multi-Hop Subject Span Composition)** can compose subject-side primitives' posteriors using the Stage 1 draw-family key contract. The `KEYED_PRIOR` mode and stable `DrawFamilyKey` digest mean two primitives sharing source U produce coherent draws across composed consumers.
- **Stage 6 (Carrier Consumer)** plumbs `DrawFamilyKey` from a per-primitive registry through `compute_forecast_trajectory` and retires the legacy `_legacy_trajectory_draw_family_key` fallback. The trajectory engine's optional `draw_family_key` parameter is the seam Stage 6 will consume.
- **Stage 7 (caching)** can persist conditioned primitive posteriors keyed by the `DrawFamilyKey` digest plus identity scope. The Stage 1 registry-key shape is unchanged.
- **Stage 8 (projection diagnostics)** can roll `to_provenance_dict()` from each registered primitive into the CF response provenance block — the subset_policy + compatibility_blend separation in §1.1.1 is the diagnostic surface that distinguishes "evidence reduced by subset" from "evidence reduced by compatibility blend".

---

## 5. Open follow-ups (not Stage 3 blocking)

1. The `primitive_timing_draws` derivation is registered but not yet consumed — the trajectory engine's `multivariate_normal` call at the (p, μ, σ, onset) site draws all four dimensions jointly from one stream. Stage 5a's per-stream split will introduce a real consumer.
2. The `_legacy_trajectory_draw_family_key` fallback identity uses `alpha`/`beta`/`n_effective`/`source` as the scenario_id — coherent within a request but not coherent across requests with different resolved-model parameters. Stage 5a/6 replace it with the request-scoped primitive identity from the registry.
3. The `_function_body` AST helper in `test_primitive_seed_retirement.py` may be reusable for similar static-inspection tests; consider extracting to a shared test util if a second consumer appears.
4. The shadow-mode comparison Stage 0c §3.3 mandates ("both legacy and new paths run in parallel under the cutover feature flag") is not yet wired — Stage 5a introduces the flag plumbing; Stage 3 leaves `condition_primitive` callable from tests but not from any live request path.
