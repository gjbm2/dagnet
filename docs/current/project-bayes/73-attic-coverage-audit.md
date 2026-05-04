# 73n Attic Coverage Audit

- **Status**: proposal (4-May-26)
- **Scope**: `graph-editor/lib/tests/_attic/` — 10 stale pytest files, ~5,900 lines
- **Companion plan**: `73n-carrier-evidence-conditioning-implementation-plan.md` (Stage 9 closure removed `runner/carrier_composition.py` and the per-surface readout entry points the attic was written against)

## Background

The 4-May commit `e15e9a9b` ("73n proceeding (generalisation of CF conditioning)") deleted `graph-editor/lib/runner/carrier_composition.py` and replaced the four per-surface readout entry points (`compute_single_hop_readout`, `compute_multi_hop_subject_readout`, `compute_multi_hop_window_readout`, `compute_active_cohort_carrier_readout`) with a single unified `compute_resolved_runtime_readout` in `graph-editor/lib/runner/primitive_readout.py`. The 10 attic files imported the deleted module and the retired entry points; they were quarantined rather than rewritten.

This audit maps every test intent in the attic to one of four classifications — COVERED, PARTIAL, GAP, OBSOLETE — against the live test corpus (84 files). The output is a workplan to close the gaps before the user deletes the attic.

## Method

- Read each attic file (full file or in two passes for the larger ones) to extract one INTENT sentence per logical test — parametrised variants of the same rule grouped into one row.
- For each intent, ran 2-4 targeted greps under `graph-editor/lib/tests/` (excluding `_attic/`) using assertion substrings, helper names, status-string literals, and semantic keywords. When a candidate live test surfaced from a grep hit, the candidate's body was opened and read before being cited.
- Anti-fabrication discipline: every cited `path::test_name` was first verified by `grep -n "def test_name"` against the cited path. Live successor tests (`test_primitive_contract.py`, `test_active_cohort_carrier_audit.py`, `test_subject_span_composer.py`, `test_carrier_object_contract.py`, `test_primitive_residual_guard.py`, `test_primitive_seed_retirement.py`, `test_result_cache.py`, `test_primitive_readout_integration.py`, `test_subject_span_cdf_ownership.py`, `test_cohort_factorised_outside_in.py`, `test_v2_v3_parity_outside_in.py`, `test_evidence_merge.py`, `test_evidence_adapters.py`) were the principal targets but the whole live tree was searched.
- Where the live function exists but pins a weaker version of the attic's claim (fewer parameters, integration-only when attic was unit, missing edge cases), the row is PARTIAL with the precise gap noted.
- Where the API the test pinned no longer exists by design (per-surface readout entry points retired in favour of unified `compute_resolved_runtime_readout`; `runner/carrier_composition.compose_carrier_to_x` deleted), the row is OBSOLETE and the row notes whether the underlying behaviour was relocated to the unified entry point.
- Reference docs consulted to classify retired-vs-relocated: `73n-carrier-evidence-conditioning-implementation-plan.md`; `runner/primitive_readout.py` source (which now exposes only `compute_resolved_runtime_readout`); `test_active_cohort_carrier_audit.py` (which is the live recorded reachability test for the deleted carrier surface).

---

## File 1 — `test_active_cohort_carrier_readout.py` (Stage 6 active cohort A!=X)

The file's overall intent: pin Stage 6's active-cohort A!=X readout — the unified flag plumbing, eligibility gate, OFF/SHADOW/ON modes, soft-skip branches for incomplete inputs, target-count-invalid, carrier_no_path, subject_no_path, and the §727 connectivity invariants (changing upstream evidence moves carrier reach; changing target subject evidence does not). Diagnostics expected to expose carrier and subject provenance separately. Source-level guard prevents trajectory-engine reimports.

1. **Eligibility gate accepts active cohort A!=X.** OBSOLETE — `is_active_cohort_carrier_eligible` no longer exists; the unified `compute_resolved_runtime_readout` performs gating internally with no public boolean entry point. Behaviourally absorbed into the unified call.

2. **Eligibility rejects window mode (single-hop / multi-hop window are other surfaces).** OBSOLETE — same reason; the per-surface gates were collapsed.

3. **Eligibility rejects cohort A==X (collapses to a single-hop / multi-hop subject).** OBSOLETE — same reason. Behavioural collapse is covered indirectly by `test_cohort_factorised_outside_in.py::test_a_equals_x_identity_collapses_to_window` (line 762).

4. **Eligibility rejects missing anchor / missing query_from_node.** OBSOLETE — direct gate retired.

5. **ON mode substitutes with composed subject moments when carrier is active and subject composition is draw-coherent (mean ≈ Beta(6,6).mean × Beta(4,6).mean).** PARTIAL — `test_subject_span_composer.py::test_two_hop_serial_composes_probability_via_doc_29b_dp` (line 294) and `test_subject_span_composer.py::test_two_hop_does_not_collapse_to_terminal_edge` (line 326) pin the composer mean for two-hop subject spans, and `test_carrier_object_contract.py::test_a_not_x_topological_reach_is_product_of_upstream_probabilities` (line 156) pins the carrier reach algebra. Missing: an end-to-end Stage 6 substitution test that asserts `should_substitute=True` with the composed-mean numeric outcome.

6. **Ineligible request returns a diagnostic skip (no substitution, skip_reason recorded).** PARTIAL — `test_cf_query_scoped_degradation.py` (search hit at line 168 for `skip_reason='primitive_substrate_owns_doc52_blend'`) pins skip-reason plumbing on a related surface, but no live test asserts the Stage 6 ineligible-request soft skip.

7. **Incomplete inputs (missing anchor/x/end) return soft skip and name the missing input.** GAP — searched `missing_inputs` substring under live tests, no hit.

8. **Subject_edge_resolutions with !=1 target returns `target_count_invalid`.** GAP — `target_count_invalid` is an attic-only literal; no live equivalent.

9. **Carrier no-path surfaces in diagnostics (no_path / horizon_inadequate) and blocks substitution (§727).** PARTIAL — `test_carrier_object_contract.py::test_composer_returns_no_path_when_chain_is_disconnected` (line 529) and `test_carrier_object_contract.py::test_horizon_inadequacy_below_95_percent_must_be_refused_or_diagnosed` (line 382) pin the carrier composer's no-path / horizon-inadequacy diagnostics. Gap: no live test verifies that Stage 6 substitution is blocked when the carrier composer surfaces these tiers.

10. **Subject no-path returns soft skip (subject_composition_error / carrier_composition_error).** PARTIAL — `test_subject_span_composer.py::test_no_path_raises` (line 437) pins the underlying composer's behaviour, but no live test verifies the readout layer's soft-skip wrapper.

11. **§727 connectivity invariant: changing upstream resolved-model on a carrier edge moves composed_carrier.reach.** PARTIAL — covered topologically by `test_carrier_object_contract.py::test_a_not_x_topological_reach_is_product_of_upstream_probabilities` (line 156), but no live test pins this specifically as an invariant under the unified readout.

12. **§727 connectivity invariant: changing target subject-only evidence does not move composed_carrier.reach.** GAP — search returned no hits in live tree for this isolation property.

13. **Diagnostics expose flag, eligibility, primitive counts (carrier+subject), composed_public_moments, legacy_public_moments, delta_p_mean, within_shadow_band, binding_policy, subject_probability_source.** PARTIAL — `test_primitive_contract.py::test_to_provenance_dict_carries_stage_8_closure_required_items` (line 602) pins per-primitive substrate keys; `test_primitive_readout_integration.py::TestStage5aSingleHopIntegration::test_substitutes_identically_on_both_surfaces` (line 128) pins `subject_probability_source` for single-hop. Gap: no live test asserts the carrier-side diag block fields (`composed_carrier`, `subject_probability_source == 'primitive_backed_carrier_and_subject'`, `binding_policy`, `delta_p_mean`, `within_shadow_band`) on the active-cohort surface.

14. **Carrier and subject non-target edges remain prior-only with explicit provenance and is_draw_coherent=True.** PARTIAL — `test_primitive_contract.py::test_prior_only_primitive_has_empty_evidence_and_is_not_misreported` (line 190) pins the primitive-level invariant; `test_subject_span_composer.py::test_draw_coherence_preserved_across_primitives` (line 361) pins the composer-level invariant. Gap: no Stage 6-specific carrier+subject mixed prior-only assertion.

15. **`should_substitute=True` when eligible AND carrier active AND subject draw-coherent AND p_mean set.** GAP — no live unit test exercises a `should_substitute` property on a Stage 6 readout result; `should_substitute` is an attic-era attribute on the retired result class.

16. **AP58 source-level guard: `primitive_readout.py` does not import `forecast_state` / `forecast_runtime` / `cohort_forecast_v3`.** PARTIAL — `test_active_cohort_carrier_audit.py::test_active_cohort_carrier_readout_does_not_call_build_upstream_carrier` (line 144) and `test_active_cohort_carrier_readout_uses_primitive_span_composer` (line 162) cover related anti-import invariants; the specific forecast_state/forecast_runtime/cohort_forecast_v3 imports are NOT pinned.

---

## File 2 — `test_composed_cache.py` (Stage 7 composed-object cache integration)

Overall intent: prove that the cache hooks INSIDE `compose_carrier_to_x` and `compose_primitive_span` are correctly registered, keyed, flushed by snapshot bustcache, suppressed by ContextVar bypass, and skip MC-mode calls. The §417 invariant: composed caches must invalidate when their primitives invalidate.

The carrier-cache half (`TestCarrierCacheWiring`) is built around `compose_carrier_to_x` from the deleted `runner/carrier_composition.py`. That function is gone; `test_active_cohort_carrier_audit.py::test_active_cohort_carrier_readout_uses_primitive_span_composer` (line 162) confirms the live readout uses `compose_primitive_span` for both carrier and subject sides. So the carrier-cache rows are OBSOLETE at the API level. The subject-span cache rows still describe live behaviour (`compose_primitive_span` exists).

1. **Carrier composer: identical calls return cached object (object identity).** OBSOLETE — `compose_carrier_to_x` deleted.

2. **Carrier composer: different transitions miss; different reach.** OBSOLETE — same.

3. **Carrier composer: different max_tau misses.** OBSOLETE.

4. **Carrier composer: MC-mode call does not return the cached deterministic result; mc_cdf is populated.** OBSOLETE — but the principle (MC bypass) may still apply to the unified composer; not pinned anywhere live.

5. **Carrier composer: snapshot_service.cache_clear flushes the cache via shared registry.** OBSOLETE.

6. **Carrier composer: snapshot_service.set_cache_bypass propagates through the same ContextVar.** OBSOLETE.

7. **Carrier composer: cached and bypassed results are numerically equivalent (reach, deterministic_cdf, tier).** OBSOLETE.

8. **Carrier cache registered under name `composed_carrier`.** OBSOLETE — name retired with the module.

9. **Subject-span composer: identical calls return cached object.** GAP — `test_result_cache.py::TestPutGet` (line 91) pins the underlying ResultCache get/round-trip, but no live test verifies that `compose_primitive_span` actually integrates with that cache. The §417 hooking is not pinned at the integration level live.

10. **Subject-span composer: different endpoints miss (e.g. X→M vs X→Y).** GAP — no live `compose_primitive_span` integration test exercises a cache miss on a different end node.

11. **Subject-span composer: primitive-cache flush invalidates subject-span cache (§417 invariant: composed caches invalidate when their primitives invalidate).** GAP — load-bearing invariant. Not pinned anywhere.

12. **Subject-span composer: snapshot_service.cache_clear flushes the cache via the shared registry.** GAP.

13. **Subject-span composer: snapshot_service.set_cache_bypass suppresses both get and put.** GAP — `test_result_cache.py::TestBypass` (lines 158-205) pins this against a bare ResultCache, but not against the subject-span integration.

14. **Subject-span composer: cached and bypassed results are numerically equivalent (span_p_mean, cdf_mean).** GAP.

15. **Subject-span cache registered under name `composed_subject_span`.** GAP — `test_result_cache.py::TestRegistry` (line 285) pins generic registry behaviour, not this specific named cache.

---

## File 3 — `test_multi_hop_subject_readout.py` (Stage 5b multi-hop subject A==X)

Overall intent: multi-hop subject-span readout for cohort A==X — eligibility gate, OFF/SHADOW/ON, soft skips, prior-only non-target sub-spans, diagnostics with composed-moments + delta + shadow-band.

1. **Eligible: multi-hop cohort A==X.** OBSOLETE — `is_multi_hop_subject_eligible` retired with per-surface readout split.

2. **Ineligible: multi-hop window deferred to Stage 5c.** OBSOLETE.

3. **Ineligible: multi-hop active cohort A!=X (Stage 6's surface).** OBSOLETE.

4. **Ineligible: single-hop (Stage 5a's surface).** OBSOLETE.

5. **Ineligible: cohort missing anchor (conservative defer).** OBSOLETE.

6. **ON mode substitutes with composed moments (mean ≈ 0.5 × 0.4 = 0.20).** PARTIAL — `test_subject_span_composer.py::test_two_hop_serial_composes_probability_via_doc_29b_dp` (line 294) pins the composer numeric mean. Gap: end-to-end multi-hop substitution is not asserted at the unified-readout level.

7. **Ineligible request returns diagnostic skip; no substitution.** GAP — no live multi-hop ineligible-skip assertion.

8. **Incomplete inputs (graph None) returns soft skip and names `graph` in missing_inputs.** GAP — `missing_inputs` substring not in live tree.

9. **Two targets in span_edge_resolutions returns `target_count_invalid`.** GAP — same as File 1 row 8.

10. **Composer path failure returns `composition_error`.** PARTIAL — `test_subject_span_composer.py::test_no_path_raises` (line 437) pins the composer raise. The readout layer's soft-skip wrapping is not pinned.

11. **Diagnostics carry flag, eligibility, primitive_count, composed.composition_mode='draws', composed.is_draw_coherent, composed_public_moments, legacy_public_moments, delta_p_mean, within_shadow_band, subject_probability_source.** PARTIAL — `test_subject_span_composer.py::test_provenance_records_composition_mode_draws` (line 475) pins composer-level provenance; readout-level diagnostics are unmapped.

12. **Non-target edges with no admitted evidence remain prior-only and is_draw_coherent (Stage 5b prior-only fix preserved).** PARTIAL — `test_primitive_contract.py::test_prior_only_primitive_has_empty_evidence_and_is_not_misreported` (line 190) pins the primitive level; `test_subject_span_composer.py::test_draw_coherence_preserved_across_primitives` (line 361) pins composer-level. Gap: explicit "prior-only non-target sub-span composes correctly through the multi-hop readout" assertion is missing.

13. **`should_substitute` property is True under (eligible AND draw-coherent AND p_mean set).** GAP — same as File 1 row 15.

---

## File 4 — `test_multi_hop_window_readout.py` (Stage 5c multi-hop window)

Overall intent: multi-hop window readout (root=X) — eligibility gate, OFF/SHADOW/ON, an explicit anti-collapse-to-terminal-edge test (§709), soft skips, prior-only non-target sub-spans, diagnostics including `subject_probability_source == 'composed_subject_span_window'`.

1. **Eligible: multi-hop window.** OBSOLETE — eligibility helper retired.

2. **Ineligible: multi-hop cohort deferred to Stage 5b.** OBSOLETE.

3. **Ineligible: single-hop window deferred to Stage 5a.** OBSOLETE.

4. **Ineligible: single-hop cohort.** OBSOLETE.

5. **ON mode substitutes with composed moments.** PARTIAL — same as File 3 row 6.

6. **§709 anti-collapse-to-terminal-edge: composer reads the composed span (upstream concentrated near 1.0, terminal at 0.4 → composed ≈ 0.396), NOT the terminal edge alone.** PARTIAL — `test_subject_span_composer.py::test_two_hop_does_not_collapse_to_terminal_edge` (line 326) pins the composer-level non-collapse claim. Gap: not pinned at the readout integration level.

7. **Ineligible request returns diagnostic skip.** GAP.

8. **Incomplete inputs returns soft skip with `graph` named.** GAP.

9. **target_count_invalid soft skip.** GAP.

10. **Composer path failure returns soft skip `composition_error`.** PARTIAL — same as File 3 row 10.

11. **Diagnostics include `subject_probability_source == 'composed_subject_span_window'`.** GAP — the literal string is unique to multi-hop window and is not pinned anywhere in live tests.

12. **Non-target edges remain prior-only and is_draw_coherent (Stage 5b prior-only fix Stage 5c inherits).** PARTIAL — same as File 3 row 12.

13. **`should_substitute` property True under (eligible AND draw-coherent AND p_mean set).** GAP.

---

## File 5 — `test_prefix_arrival.py` (Stage 2 prefix-arrival map)

Overall intent: pin the request-scoped prefix-arrival map (`build_prefix_arrival_map`) — clock identity for window/cohort/non-latency-chain, deterministic shift, topological-map build-once-reuse, contexted-source cache key, stochastic-prefix mean parity, diamond DAG matching `compose_carrier_to_x` reach, subject-side fanout sharing root arrival, boundary-at-X behaviour, no-second-timing-path import guard, degraded-entry diagnostics.

The `prefix_arrival` module still exists in `runner/`, but importantly the file's diamond/reach test (row 9) compares to the deleted `compose_carrier_to_x`, which is gone — that specific oracle is OBSOLETE. The other rows pin behaviour of a still-live module.

1. **Window-clock identity: root entry holds raw `root_day_weights` (no normalisation).** GAP — `test_subject_span_composer.py` (line 137) constructs a `PrefixArrivalMap` for fixtures but does not assert this contract; no live test pins identity-mask preservation.

2. **Cohort A==X clock collapses to anchor-day weights at root.** GAP.

3. **Non-latency chain preserves root clock including tau=0 (Dirac shift = 0).** GAP — load-bearing for non-latency primitives.

4. **Deterministic prefix shifts clock by exact day count (degenerate lognormal sigma in [0.01,0.1), onset=d).** GAP.

5. **Topological map builds once and reuses across primitives (object identity for shared source nodes).** GAP — `test_subject_span_composer.py` consumes the map but does not assert reuse identity.

6. **Topological map does not invoke `compose_carrier_to_x` after construction (instrumented sentinel).** OBSOLETE — `compose_carrier_to_x` deleted; the sentinel pattern would now point at the new internal composition primitive. Equivalent live invariant absent.

7. **Contexted-source identity: changing context_key / regime_key / model_source_preference / parameter_fingerprint produces 5 distinct cache keys.** GAP — load-bearing for cache safety.

8. **Stochastic-prefix lognormal: arrival_weight[B] mean matches exp(mu + sigma^2/2) within ~1.5 days on a 200-day grid.** GAP.

9. **Carrier DAG diamond: arrival_weight[X].reach_from_root and cumulative shape match `compose_carrier_to_x` deterministic_cdf within 1e-6.** OBSOLETE — comparator deleted; the reach property is still live but no comparator remains.

10. **Subject DAG fanout: every downstream node enumerated as a composed entry; primitives sharing source node read the same NodeArrivalWeights object.** GAP.

11. **Boundary join at X: with root=A, carrier-side primitives populate; X has composed_edges >= 2.** GAP.

12. **Boundary split at X: with root=X, identity topology_case at X.** GAP.

13. **No second timing path: static import check that `prefix_arrival` does not import `forecast_runtime` / `forecast_state` / `cohort_forecast` / `lag_distribution_utils` / `span_evidence`.** GAP — AP58-style guard with no live coverage.

14. **Degraded entry: stranded node returns is_degraded entry with empty weights, reach=0, non-empty note, and is in `arrival_map.degraded_nodes`.** GAP.

15. **Root-day-weights pass through unchanged to root entry; downstream entries are normalised to sum to 1.** GAP.

---

## File 6 — `test_primitive_cache.py` (Stage 7 primitive posterior cache)

Overall intent: pin the cache wrapping `condition_primitive` — hit/miss for every load-bearing input axis (scenario_seed, prior alpha/beta, evidence rows, transition, n_effective, latency moments, options, prior_source); cached and uncached numerically identical; bypass returns fresh objects and does not pollute the cache; `result_cache.clear_all()` and `snapshot_service.cache_clear()` flush; cache registered under name `primitive`.

The underlying `condition_primitive` and its cache wrapper still exist (the function is referenced in `test_subject_span_composer.py` line 189 and `test_subject_span_cdf_ownership.py`), so these rows describe live behaviour. The closest live test is `test_result_cache.py`, which exercises the bare ResultCache contract but not the `condition_primitive` integration.

1. **Cache hit: identical inputs return same object (object identity, hits counter increments).** PARTIAL — `test_result_cache.py::TestPutGet::test_round_trip_hit` (line 99) pins the bare cache get/put hit; no live test exercises this through `condition_primitive`.

2. **Cache miss for different scenario_seed.** GAP.

3. **Cache miss for different prior alpha/beta (with verified posterior-mean change).** GAP — load-bearing for evidence sensitivity.

4. **Cache miss for different evidence rows (k differs).** GAP.

5. **Cache miss for different transition identity.** GAP.

6. **Cache miss for different n_effective (None vs numeric).** GAP.

7. **Cache miss for different latency moments (mu, sigma).** GAP.

8. **Cache miss for different ConditioningPolicyOptions (draw_count).** GAP.

9. **Cache miss for different prior_source (analytic vs bayesian).** GAP.

10. **Cached and uncached produce field-by-field numerical equivalence on probability_posterior, status, effective_evidence_totals, and identical draws array.** GAP — §739 stop-condition equivalent for the primitive cache. Critical.

11. **Bypass returns fresh objects on each call.** PARTIAL — `test_result_cache.py::TestBypass::test_get_returns_miss_under_bypass` (line 158) pins bare-cache bypass; not pinned through `condition_primitive`.

12. **Bypass does not pollute cache for other callers (`entries==0` afterwards).** PARTIAL — `test_result_cache.py::TestBypass::test_put_skipped_under_bypass` (line 168) pins this generically.

13. **Bypass uses same ContextVar as `snapshot_service.set_cache_bypass`.** PARTIAL — `test_result_cache.py::TestBypass::test_set_reset_bypass_token_pair` (line 184) and `test_bypass_propagates_across_caches` (line 192) pin the ContextVar at the cache layer; the cross-boundary `snapshot_service` re-export and the integration with `condition_primitive` are not pinned.

14. **`result_cache.clear_all()` flushes the primitive cache.** PARTIAL — `test_result_cache.py::TestClear::test_clear_all_flushes_every_registered_cache` (line 253) pins the generic flush.

15. **`snapshot_service.cache_clear()` flushes the primitive cache.** GAP — the cross-boundary snapshot-service hook is not pinned anywhere in live tests.

16. **Primitive cache is registered under name `primitive` (`result_cache.get_cache('primitive')`).** GAP — `test_result_cache.py::TestRegistry` (line 285) pins generic registry behaviour, but no live test asserts this specific registration name for the primitive cache.

---

## File 7 — `test_primitive_conditioning.py` (Stage 3 primitive conditioning)

Overall intent: pin the Stage 3 conditioner — Beta-Binomial conjugate update, doc-52 mass-ratio policy across full/zero subset limits and the n_effective-missing skip, e==E equality_explicit semantics, PRIOR_ONLY when no admitted evidence, DEGRADED when arrival map is degraded, structurally non-latency primitive separates probability conditioning from Dirac-at-zero timing, subset_policy and compatibility_blend on separate slots, latent primitive emits lognormal cdf_mean, keyed-RNG seam (matching keys → identical draws; distinct seeds → independent draws; no fixed-seed call sites), n_eff_posterior diagnostic exposed in `notes`, conditioned primitive uses KEYED_PRIOR draw_family_mode.

The `condition_primitive` function still exists (used in live tests) but the attic exercises it through more conditioning-policy cases than the live tree.

1. **Conjugate update when n_effective is missing: skip_reason='n_effective_missing', no blend, posterior mean = (1+30)/(1+1+100) = 31/102.** GAP — `test_primitive_residual_guard.py` (line 90) covers a related "parameterised requirement" but not this conjugate-update + skip-reason invariant.

2. **Full subset limit r=1.0 returns prior moments; effective_evidence_totals=(0,0).** PARTIAL — `test_subject_span_cdf_ownership.py::TestNonLatencyClosedFormEquivalence` (around line 269-330) pins the doc-52 blend in equilibrium for a related composer-level test; the primitive-level r=1 boundary is not directly pinned.

3. **doc-52 subset mass uses raw admitted rows, not arrival-weighted total: m_S equals raw admitted sum, not weighted.** GAP — load-bearing semantic separation.

4. **Zero subset limit r→0 returns full conjugate update; effective evidence ≈ raw weighted.** GAP.

5. **e==E equality_explicit=True when n_effective missing (no transformation).** GAP.

6. **e!=E equality_explicit=False when blend applies.** GAP.

7. **PRIOR_ONLY status when no evidence admitted; subset_policy.skip_reason='no_evidence'; effective_evidence_totals=(0,0); posterior mean = prior mean.** PARTIAL — `test_primitive_contract.py::test_prior_only_primitive_has_empty_evidence_and_is_not_misreported` (line 190) pins the prior-only construction; the conditioner's specific subset_policy.skip_reason wiring is not pinned through `condition_primitive` directly.

8. **DEGRADED status when arrival map is degraded; is_draw_coherent=False; `probability_draws()` raises DrawFamilyUnavailable.** PARTIAL — `test_primitive_contract.py::test_unavailable_or_degraded_primitive_records_missing_inputs_and_refuses_draws` (line 279) pins DEGRADED + draw refusal at the primitive level. Gap: not driven through `condition_primitive` from a degraded arrival map.

9. **Non-latency primitive: probability conditioned, timing_family=NON_LATENT, cdf_mean Dirac-at-zero.** PARTIAL — `test_primitive_contract.py::test_non_latency_primitive_keeps_p_separate_from_dirac_at_zero_timing` (line 329) pins this at the primitive contract level. Gap: not driven through the `condition_primitive` entry point with a non-zero mu/onset compat input.

10. **Non-latency compat fields `mu`/`sigma`/`onset`/`completeness` are provenance-only; cdf_mean stays Dirac even when compat carries non-zero values.** PARTIAL — same as row 9; the live test pins separation but not the specific compat-fields-vs-cdf-mean isolation under `condition_primitive`.

11. **Latent primitive emits lognormal cdf_mean: cdf[0]=0, cdf[-1]>0.99 by tau=90 for mu=2,sigma=0.5.** GAP.

12. **subset_policy and compatibility_blend on separate slots, both populated when blend applies; permutation_seed_derivation='doc52_blend_permutation'.** PARTIAL — `test_primitive_contract.py::test_to_provenance_dict_carries_stage_8_closure_required_items` (line 602) pins the SubsetPolicyProvenance shape; `test_primitive_residual_guard.py` (line 265) checks subset_policy+compatibility_blend slots when None. Gap: live tests do not exercise the populated-blend case via `condition_primitive`.

13. **Provenance dict serialises subset_policy.r and compatibility_blend.applied=True.** PARTIAL — `test_primitive_contract.py::test_to_provenance_dict_carries_stage_8_closure_required_items` (line 602) pins the dict shape with subset_policy.r=0.1 explicitly. Equivalent for the active path.

14. **Two consumers with matching DrawFamilyKey produce identical draws.** PARTIAL — `test_primitive_contract.py::test_two_consumers_with_matching_draw_family_keys_receive_identical_draws` (line 449) pins this at primitive level. Gap: not pinned through `condition_primitive`.

15. **Distinct scenario seeds produce independent draws (coincidence count < 5).** PARTIAL — `test_primitive_contract.py::test_different_draw_family_keys_produce_independent_draws` (line 465) pins independence at primitive level.

16. **doc-52 blend uses keyed RNG, not fixed seed: regex check that `primitive_conditioning.py` source contains no `np.random.default_rng(seed=N)`.** PARTIAL — `test_primitive_seed_retirement.py::test_primitive_draw_site_consumes_keyed_rng` (line 77) pins the keyed-RNG pattern at the draw-site level. Gap: the specific module-source regex check on `primitive_conditioning.py` is not pinned.

17. **`n_eff_posterior=...` line in `notes` records ESS-equivalent diagnostic.** GAP — load-bearing per plan §648; no live test searches the `notes` field for this diagnostic.

18. **Stop condition: simple window U-V output read from conditioned primitive equals expected conjugate posterior within Stage 0c ±0.015 band.** PARTIAL — `test_primitive_readout_integration.py::TestStage5aSingleHopIntegration::test_substitutes_identically_on_both_surfaces` (line 128) pins the parity at the integration level via the F14 Q1 oracle (p_infinity_mean = 0.6925), which subsumes the unit-level parity claim.

19. **Conditioned primitive uses DrawFamilyMode.KEYED_PRIOR.** GAP — no live test explicitly asserts `prim.draw_family_mode == KEYED_PRIOR` for a freshly-conditioned primitive.

---

## File 8 — `test_primitive_evidence.py` (Stage 2 primitive evidence resolution)

Overall intent: pin per-primitive binding atop the prefix-arrival map — `bind_primitive_evidence`, weighted-day binding, retrieval superset planner, request-scoped registry, span-primitive validator, WP8 default-off, outside-in anti-leak, raw/weighted/effective separation, registry provenance dict.

These are largely Stage 2 unit tests. The `primitive_evidence` module is still live (used in `test_subject_span_composer.py` line 42, and in attic helpers).

1. **Window-mode weighted totals equal raw totals when arrival_weight[U]=identity over single anchor day.** GAP — load-bearing parity oracle.

2. **WP8 default-off: cohort role (DIRECT_COHORT_EXACT_SUBJECT) raises PrimitiveBindingError.** PARTIAL — `test_wp8_default_off.py` (line 25-27 docstring; lines 91, 154 inspect `p_conditioning_evidence` source/temporal_family) pins WP8 at the consumer level. Gap: the binder-level rejection is not pinned live.

3. **Weighted view weights contradictory days by arrival_weight (identity-mask: n_w=40, k_w=20 from two opposing 20/20 vs 0/20 days).** GAP.

4. **Skewed arrival weight (0.8/0.2) drives skewed weighted k (raw 0.6 vs weighted 0.36).** GAP — load-bearing for the Stage 2 stop condition.

5. **Outside-in anti-leak: deterministic 5-day delay rejects anchor-day evidence; only shifted-day evidence binds; off_clock_rejection_count=1.** GAP — pins §627 anti-leak invariant. Critical.

6. **As-at admission uses retrieved_at not anchor day: row with retrieved_at after as_at is rejected; primitive-local day later than anchor does not cause rejection.** PARTIAL — `test_evidence_merge.py::test_observed_date_after_retrieved_at_is_skipped` (line 391) and `test_raw_row_after_as_at_boundary_is_skipped` (line 408) pin the merge-layer behaviour. Gap: the binder-level interaction with shifted clocks is not pinned.

7. **Retrieval superset envelopes all primitive-local clocks (A→B delay 3 → C delay 7 → D: superset=[anchor, anchor+10]).** GAP.

8. **Retrieval superset skips degraded source nodes (Z degraded → Z not in primitive_clock_extents).** GAP.

9. **`merge_evidence_candidates` signature unchanged for non-primitive callers (no weighted_view attribute, integer totals).** PARTIAL — `test_evidence_merge.py` has many tests on `merge_evidence_candidates` (e.g. `test_file_supplements_only_uncovered_days` line 181, `test_window_role_skips_cohort_file_entries` line 217). Gap: the explicit "no weighted_view attribute" pin is not in any live test.

10. **Admitted mass excludes retrieval-superset off-clock rows: m_S = sum of admitted raw n, not retrieval-superset raw n.** GAP — load-bearing for doc-52 numerator semantics.

11. **Registry key includes evidence-clock alignment identity: two registries with maps differing only in parameter_fingerprint produce different keys for the same primitive.** GAP — load-bearing for cache safety.

12. **Registry within one request dedupes same primitive scope: registering twice with the same (transition, primitive_scope) raises ValueError.** GAP.

13. **Span-primitive validator rejects span crossing X boundary; suggests `edge_primitives` fallback.** GAP.

14. **Span-primitive validator rejects metadata mismatch (context_key) even when topology fits.** GAP.

15. **Span-primitive validator accepts span fitting wholly inside one closure with matching metadata.** GAP.

16. **Registry to_provenance_dict emits per-primitive inventory: transition, topology_case, raw_total_n/k, weighted_total_n/k, identity_cache_key, arrival_map_diagnostics.** PARTIAL — `test_primitive_contract.py::test_to_provenance_dict_carries_stage_8_closure_required_items` (line 602) pins primitive-level provenance. Gap: registry-level inventory shape (`primitive_count`, identity_cache_key, arrival_map_diagnostics envelope) is not pinned live.

17. **Degraded arrival weight: empty rows, n_weighted_total=0, raw EvidenceSet still carries admitted rows; topology_case='degraded'; off_clock_rejection_count=1.** GAP.

18. **Raw and weighted evidence are explicitly separate even when numerically equal: distinct objects, weighted_view rows have float n/k while raw rows have int n/k; binding_policy='weighted_day_binding.v1'.** PARTIAL — `test_primitive_contract.py` (line 587) asserts `isinstance(view.n_weighted_total, float)` for the weighted-view shape, but the explicit raw-vs-weighted separation invariant is not pinned.

---

## File 9 — `test_primitive_readout.py` (Stage 5a single-hop)

Overall intent: pin the single-hop primitive readout — flag plumbing, eligibility gate (single-hop window / cohort A==X eligible; multi-hop / A!=X deferred), synthetic identity-clock binding (no re-merge), closed-form posterior parity, full/zero subset limits, shadow-band constants, soft skips, diagnostics, identity-mask preservation of evidence totals, `should_substitute` property.

1. **Eligible single-hop window.** OBSOLETE — `is_single_hop_window_eligible` retired with per-surface readout split.

2. **Eligible single-hop cohort A==X.** OBSOLETE.

3. **Ineligible single-hop cohort A!=X (Stage 6's surface).** OBSOLETE.

4. **Ineligible multi-hop window / multi-hop cohort.** OBSOLETE.

5. **Ineligible cohort missing anchor (conservative defer).** OBSOLETE.

6. **Single-hop posterior mean matches maturity-aware primitive posterior; provenance carries `maturity_aware_mode=` note.** PARTIAL — `test_primitive_readout_integration.py::TestStage5aSingleHopIntegration::test_substitutes_identically_on_both_surfaces` (line 128) pins the primitive-posterior parity end-to-end; the specific `maturity_aware_mode=` notes prefix is not pinned.

7. **Full subset limit r=1.0: posterior tracks prior within Stage 0c ±0.002.** PARTIAL — `test_subject_span_cdf_ownership.py::TestNonLatencyClosedFormEquivalence` (line 269-330) explores the doc-52 blend equilibrium at the composer level. Gap: the readout-level r=1 boundary is not directly pinned.

8. **Zero subset limit r≈0: posterior ≈ full conditional (10/14 ≈ 0.7143).** GAP.

9. **Shadow band constants: SHADOW_ABS_BAND==0.005 and ACCEPTANCE_ABS_BAND==0.002.** GAP — Stage 0c contract.

10. **Ineligible request returns diagnostic skip; `primitive is None`; skip_reason='multi_hop'.** GAP.

11. **Eligible but inputs missing (evidence_set None) records soft skip; missing_inputs lists `evidence_set`.** GAP.

12. **Diagnostics carry eligible, primitive_status, primitive_n_weighted_total, primitive_k_weighted_total, closed_form_public_moments, legacy_public_moments, delta_p_mean, within_shadow_band.** PARTIAL — `test_primitive_readout_integration.py::TestStage5aSingleHopIntegration::test_substitutes_identically_on_both_surfaces` (line 128) checks `subject_probability_source=='primitive_posterior'` and `closed_form_public_moments['p_mean']`. Gap: full diagnostic-key inventory and shadow-band signal are not pinned.

13. **Canonical binder preserves evidence totals under identity mask (n_weighted_total=100, k_weighted_total=70 for the n=100,k=70 fixture); binding_policy='weighted_day_binding.v1'; evidence_scope_key starts with 'scope:'.** PARTIAL — `test_primitive_contract.py` (line 172) pins `n_weighted_total==12.0` for a synthetic primitive. Gap: the readout-level identity-mask preservation through `compute_resolved_runtime_readout` is not pinned.

14. **`should_substitute` is True for an eligible request with full inputs.** PARTIAL — `test_primitive_readout_integration.py::TestStage5aSingleHopIntegration::test_substitutes_identically_on_both_surfaces` (line 128) asserts `cm_pr["substituted"] is True` and `cf_pr["substituted"] is True` — the integration form of the same property.

---

## File 10 — `test_stage_8_substrate_provenance.py` (Stage 8 cross-surface provenance)

Overall intent: pin the closure-required substrate items per plan §745 across all four readout surfaces — `to_provenance_dict()` populating `primitive_provenance` (single-hop) or `primitives[].provenance` (multi-hop); plus `composed`, `composed_carrier`, `composed_subject` topology summaries; cache_status snapshot; JSON-serialisability; refusal of `p_conditioning_evidence` parameter; PreparedConditioningEvidence carrying `compatibility_metadata_note`.

1. **Single-hop diag carries primitive_provenance with all closure-required keys; weighted_evidence n_weighted_total agrees with primitive_n_weighted_total flat field; prior_source flows through.** PARTIAL — `test_primitive_contract.py::test_to_provenance_dict_carries_stage_8_closure_required_items` (line 602) pins the primitive-level closure-required keys (transition, scope, raw_evidence_scope_key, weighted_evidence with all subfields, effective_evidence_totals, prior_source, status, draw_family_mode, draw_family_key_digest, timing_family, subset_policy, residual_policy). Gap: the single-hop-readout-level wrapping (a top-level `primitive_provenance` slot in the readout's diag, plus the `primitive_n_weighted_total` flat-field consistency check) is not pinned live.

2. **Multi-hop subject readout: per-primitive provenance in `diagnostics['primitives']`; non-target prior-only with weighted_evidence None or zero; target with bound weighted totals (0 < n_w < 100, k_w == 0.7×n_w); composed block has primitive_count, span_p_mean, span_p_sd; subject_probability_source starts with 'composed_subject_span'.** PARTIAL — `test_subject_span_composer.py::test_provenance_records_composition_mode_draws` (line 475) pins composer-level provenance with primitive_count. Gap: the readout-wrapping (`diagnostics['primitives']` inventory with per-primitive provenance blocks; `subject_probability_source`) is not pinned live.

3. **Multi-hop window readout: same closure-required substrate per primitive; subject_probability_source starts with 'composed_subject_span_window'.** GAP.

4. **Active cohort A!=X readout carries TWO primitive lists (carrier + subject); composed_carrier with anchor_node_id, x_node_id, reach, role='carrier_to_x', primitive_count; composed_subject with x_node_id, end_node_id, span_p_mean; subject_probability_source starts with 'primitive_backed_carrier'.** GAP — the dual-list shape is unique to Stage 6 and is not pinned anywhere live.

5. **All four substrate diags are JSON-serialisable (`json.dumps(dict(diag))`).** GAP — JSON-serialisability is implicit in any test that round-trips through HTTP, but no live test asserts this directly for the readout diagnostics.

6. **All four diags carry a `cache_status` snapshot with `name, entries, hits, misses, evictions, invalidations, bypasses` per entry (plan §760).** GAP — `test_result_cache.py::TestRegistry::test_stats_all_lists_every_registered_cache` (line 307) pins generic `stats_all` shape, but no live test verifies that the readout diag exposes this snapshot.

7. **Readouts do not accept `p_conditioning_evidence` / `conditioning_evidence` / `pce_total_x` / `pce_total_y` parameter (plan §762).** GAP — directly inspectable as a signature check; not pinned live. The principle is also pinned at a different level by `test_wp8_default_off.py` (which inspects `p_conditioning_evidence` on the runtime bundle, not on the readout signatures).

8. **PreparedConditioningEvidence.serialise_runtime_bundle: pce dict carries `compatibility_metadata_note` referring to plan §762.** GAP — pins compatibility-metadata labelling.

---

## Summary table

| File | COVERED | PARTIAL | GAP | OBSOLETE | Total |
|---|---|---|---|---|---|
| test_active_cohort_carrier_readout.py | 0 | 7 | 4 | 5 | 16 |
| test_composed_cache.py | 0 | 0 | 7 | 8 | 15 |
| test_multi_hop_subject_readout.py | 0 | 4 | 4 | 5 | 13 |
| test_multi_hop_window_readout.py | 0 | 4 | 5 | 4 | 13 |
| test_prefix_arrival.py | 0 | 0 | 13 | 2 | 15 |
| test_primitive_cache.py | 0 | 5 | 11 | 0 | 16 |
| test_primitive_conditioning.py | 0 | 9 | 10 | 0 | 19 |
| test_primitive_evidence.py | 0 | 4 | 14 | 0 | 18 |
| test_primitive_readout.py | 0 | 5 | 4 | 5 | 14 |
| test_stage_8_substrate_provenance.py | 0 | 2 | 6 | 0 | 8 |
| **Totals** | **0** | **40** | **78** | **29** | **147** |

No row was classified COVERED outright: every live citation that covers a related claim does so at a different layer (composer-level vs readout-level, primitive-level vs registry-level, integration-level vs unit-level). PARTIAL is correct.

---

## Gap workplan

Items below are ordered by behavioural risk — invariants whose silent regression would corrupt user-visible CF / cohort_maturity outputs come first, source-level guards last. Complexity rubric: S = ~30-line additive test in an existing file; M = ~80-line new fixture or integration scaffold; L = sizeable test scaffolding (new graph fixture, custom monkeypatching, or cross-module wiring).

### Tier A — load-bearing numeric correctness

1. **Outside-in anti-leak through `bind_primitive_evidence`.** Target: `test_primitive_evidence.py` (new file) or augment `test_evidence_merge.py`. Suggested test: `test_outside_in_anti_leak_downstream_primitive_conditions_on_shifted_day`. Behaviour: contradictory anchor-day vs shifted-day rows under a deterministic-shift prefix; only shifted-day binds; off_clock_rejection_count=1. Complexity: M.

2. **Admitted mass excludes off-clock retrieval-superset rows (doc-52 numerator).** Target: as Tier A.1. Test: `test_admitted_mass_inputs_exclude_retrieval_superset_off_clock_rows`. Behaviour: superset spans two days; arrival_weight delta on day A; only day-A row admitted; raw_admitted_n != raw_evidence_set.totals.n. Complexity: M.

3. **Composed caches invalidate when their primitives invalidate (§417).** Target: extend `test_result_cache.py` or new `test_composed_subject_span_cache.py`. Test: `test_primitive_cache_flush_invalidates_subject_span_cache`. Behaviour: warm both caches; flush primitive cache only; rebuild primitive (new id); composer must miss the subject-span cache. Complexity: L.

4. **Cached and uncached primitive posteriors are field-by-field numerically identical.** Target: extend `test_primitive_contract.py` or new `test_primitive_cache.py`. Test: `test_cached_and_uncached_results_have_identical_posterior_fields`. Behaviour: §739 stop condition for the primitive cache. Complexity: M.

5. **doc-52 subset mass uses raw admitted rows, not arrival-weighted total.** Target: new `test_primitive_conditioning.py` or augment `test_subject_span_cdf_ownership.py`. Test: `test_doc52_subset_mass_uses_raw_admitted_rows_not_arrival_weighted_total`. Complexity: M.

6. **Window-mode weighted totals equal raw totals (parity oracle).** Target: new `test_primitive_evidence.py`. Test: `test_window_mode_weighted_totals_equal_raw_totals`. Complexity: S.

7. **Anti-collapse-to-terminal-edge through the readout (§709).** Target: extend `test_primitive_readout_integration.py`. Test: `test_multi_hop_window_does_not_collapse_to_terminal_edge`. Behaviour: upstream concentrated near 1.0, terminal at 0.4, composed ≈ 0.4 — not the terminal alone. Complexity: M.

8. **Stage 6 connectivity invariant: target subject-only evidence does not move composed_carrier.reach.** Target: extend or new `test_active_cohort_substitution_invariants.py`. Test: `test_target_subject_only_change_does_not_move_carrier`. Complexity: M.

9. **Stage 6 connectivity invariant: changing upstream resolved-model on a carrier edge moves composed_carrier.reach.** Target: as Tier A.8. Test: `test_changing_upstream_resolved_model_moves_carrier_reach`. Complexity: M.

### Tier B — request-scoped registry / cache contract

10. **Registry key includes evidence-clock alignment identity (parameter_fingerprint differs → distinct keys).** Target: new `test_primitive_evidence.py`. Test: `test_registry_key_includes_evidence_clock_alignment_identity`. Complexity: M.

11. **Registry refuses duplicate registration for same (transition, primitive_scope).** Target: as Tier B.10. Test: `test_registry_within_one_request_dedupes_same_primitive_scope`. Complexity: S.

12. **Contexted-source identity: 5 fields produce 5 distinct cache keys.** Target: new `test_prefix_arrival.py`. Test: `test_contexted_source_changes_cache_key`. Complexity: S.

13. **`snapshot_service.cache_clear()` flushes the primitive cache (cross-boundary hook).** Target: extend `test_result_cache.py` or new `test_snapshot_cache_integration.py`. Test: `test_snapshot_cache_clear_flushes_primitive_cache`. Complexity: M.

14. **`snapshot_service.set_cache_bypass()` propagates to `condition_primitive` (cross-boundary ContextVar).** Target: as Tier B.13. Test: `test_bypass_uses_same_contextvar_as_snapshot_cache`. Complexity: M.

15. **Primitive cache registered under name `primitive` and subject-span cache under `composed_subject_span`.** Target: as Tier B.13. Tests: `test_primitive_cache_is_registered_under_known_name`, `test_subject_span_cache_registered_under_known_name`. Complexity: S.

16. **Cache miss for each load-bearing input axis (scenario_seed, prior alpha/beta, evidence rows, transition, n_effective, latency moments, options, prior_source).** Target: new `test_primitive_cache.py`. Tests: parametrise the 8 axes. Complexity: M.

17. **Subject-span composer integrates with the cache: identical calls hit; different endpoints miss; bypass returns fresh objects; cached and bypassed numerically equivalent.** Target: new `test_composed_subject_span_cache.py`. Tests: `test_identical_calls_return_cached_object`, `test_different_endpoints_miss`, `test_bypass_returns_fresh_object`, `test_cached_and_bypassed_results_are_numerically_equivalent`. Complexity: L.

### Tier C — Stage 2 prefix-arrival map invariants

18. **Window-clock identity: root entry holds raw root_day_weights (no normalisation).** Target: new `test_prefix_arrival.py`. Test: `test_window_clock_identity_root_equals_primitive_source`. Complexity: S.

19. **Cohort A==X identity: root entry equals anchor-day weights.** Target: as Tier C.18. Test: `test_cohort_clock_identity_a_equals_x_collapses_to_anchor_clock`. Complexity: S.

20. **Non-latency chain preserves root clock including tau=0.** Target: as Tier C.18. Test: `test_non_latency_chain_preserves_root_clock_including_tau_zero`. Complexity: S.

21. **Deterministic prefix shifts clock by exact day count.** Target: as Tier C.18. Test: `test_deterministic_prefix_shifts_clock_by_exact_day_count`. Complexity: M.

22. **Topological map builds once and reuses across primitives (object identity).** Target: as Tier C.18. Test: `test_topological_map_builds_once_and_reuses_across_primitives`. Complexity: S.

23. **Stochastic-prefix mean matches lognormal mean.** Target: as Tier C.18. Test: `test_stochastic_prefix_arrival_mean_matches_lognormal_mean`. Complexity: M.

24. **Subject DAG fanout: every downstream node is a composed entry; primitives sharing source read the same NodeArrivalWeights.** Target: as Tier C.18. Test: `test_subject_dag_fanout_subject_primitives_share_root_arrival`. Complexity: M.

25. **Boundary join at X with root=A: composed_edges>=2 at X.** Target: as Tier C.18. Test: `test_boundary_join_at_x_carrier_owns_upstream_primitives`. Complexity: M.

26. **Boundary split at X with root=X: identity topology_case at X.** Target: as Tier C.18. Test: `test_boundary_split_at_x_subject_primitives_read_root_for_window_mode`. Complexity: S.

27. **Degraded entry has empty weights, reach=0, non-empty note, listed in degraded_nodes.** Target: as Tier C.18. Test: `test_degraded_entry_carries_explicit_reason_for_no_path_node`. Complexity: S.

28. **Root-day-weights pass through unchanged; downstream entries normalise to 1.** Target: as Tier C.18. Test: `test_root_day_weights_pass_through_unchanged_to_root_entry`. Complexity: S.

### Tier D — Stage 2 binder details

29. **Weighted view weights contradictory days by arrival_weight.** Target: new `test_primitive_evidence.py`. Test: `test_weighted_view_weights_contradictory_days_by_arrival_weight`. Complexity: M.

30. **Skewed arrival weight (0.8/0.2) drives skewed weighted k.** Target: as Tier D.29. Test: `test_weighted_view_skewed_arrival_weight_drives_skewed_k`. Complexity: M.

31. **Retrieval superset envelopes all primitive-local clocks; skips degraded nodes.** Target: as Tier D.29. Tests: `test_retrieval_superset_envelopes_all_primitive_local_clocks`, `test_retrieval_superset_skips_degraded_source_nodes`. Complexity: M.

32. **Span-primitive validator: rejects X-boundary crossing; rejects metadata mismatch; accepts in-closure with matching metadata.** Target: as Tier D.29. Tests: 3 cases. Complexity: M.

33. **Degraded arrival weight produces empty rows but preserves raw EvidenceSet; topology_case='degraded'.** Target: as Tier D.29. Test: `test_degraded_arrival_weight_yields_zero_row_view_but_preserves_raw`. Complexity: M.

34. **Raw and weighted evidence are explicitly separate even when equal (distinct objects, float vs int row types, binding_policy='weighted_day_binding.v1').** Target: as Tier D.29. Test: `test_raw_and_weighted_evidence_are_explicitly_separate_even_when_equal`. Complexity: S.

35. **Registry to_provenance_dict emits per-primitive inventory with primitive_count, identity_cache_key, arrival_map_diagnostics envelope.** Target: as Tier D.29. Test: `test_registry_to_provenance_dict_emits_per_primitive_inventory`. Complexity: M.

36. **WP8 default-off rejects DIRECT_COHORT_EXACT_SUBJECT role at the binder.** Target: extend `test_wp8_default_off.py`. Test: `test_bind_primitive_evidence_rejects_cohort_role_under_wp8_default_off`. Complexity: S.

### Tier E — Stage 3 conditioning detail

37. **Conjugate update with n_effective missing: skip_reason='n_effective_missing'; expected posterior mean.** Target: new `test_primitive_conditioning.py`. Test: `test_conjugate_update_when_n_effective_missing_skips_blend`. Complexity: S.

38. **Full and zero subset limits at the conditioner level.** Target: as Tier E.37. Tests: `test_full_subset_limit_returns_prior_when_n_effective_equals_m_S`, `test_zero_subset_limit_returns_full_conditioning_when_m_S_negligible`. Complexity: M.

39. **e==E equality_explicit semantics (True when n_effective missing; False when blend applies).** Target: as Tier E.37. Tests: 2 cases. Complexity: S.

40. **PRIOR_ONLY when no admitted evidence; subset_policy.skip_reason='no_evidence'.** Target: as Tier E.37. Test: `test_prior_only_when_no_evidence_admitted`. Complexity: S.

41. **DEGRADED status from a degraded arrival map; refuses draws.** Target: as Tier E.37. Test: `test_degraded_when_arrival_map_degraded`. Complexity: M.

42. **Latent primitive emits lognormal cdf_mean (cdf[0]=0, cdf[-1]>0.99).** Target: as Tier E.37. Test: `test_latent_primitive_emits_lognormal_cdf_mean`. Complexity: M.

43. **Subset_policy and compatibility_blend separately populated when blend applies; permutation_seed_derivation literal.** Target: as Tier E.37. Test: `test_subset_policy_and_compatibility_blend_are_separate_slots`. Complexity: S.

44. **doc-52 blend uses keyed RNG: source-text regex check on `primitive_conditioning.py`.** Target: extend `test_primitive_seed_retirement.py`. Test: `test_primitive_conditioning_module_uses_only_keyed_rng`. Complexity: S.

45. **n_eff_posterior diagnostic recorded in primitive.notes.** Target: as Tier E.37. Test: `test_n_eff_posterior_health_diagnostic_recorded_in_notes`. Complexity: S.

### Tier F — Stage 5/6/8 readout integration

46. **Stage 5b/5c/6 readouts return soft skips (no exception) for: ineligible request, incomplete inputs (missing_inputs surfaces field name), target_count_invalid, composer path failure (composition_error / carrier_composition_error / subject_composition_error).** Target: new `test_unified_readout_soft_skips.py`. Tests: parametrised across all four legacy surfaces and skip reasons. Complexity: L.

47. **Stage 6 carrier no-path / horizon-inadequate blocks substitution (§727).** Target: extend `test_active_cohort_carrier_audit.py`. Test: `test_carrier_no_path_blocks_substitution`. Complexity: M.

48. **Stage 8: per-readout diag carries a `primitive_provenance` block (single-hop) or `primitives[].provenance` (multi-hop) with all closure-required keys.** Target: extend `test_primitive_readout_integration.py`. Tests: 4, one per legacy surface (single-hop, multi-hop subject, multi-hop window, active cohort). Complexity: L.

49. **Stage 8: `cache_status` snapshot present on every readout diag with required fields.** Target: as Tier F.48. Test: `test_readout_diag_carries_cache_status_snapshot`. Complexity: M.

50. **Stage 8: readout diags are JSON-serialisable.** Target: as Tier F.48. Test: `test_readout_diags_are_json_serialisable`. Complexity: S.

51. **Stage 8: `compute_resolved_runtime_readout` does not accept `p_conditioning_evidence` / `conditioning_evidence` / `pce_total_x` / `pce_total_y` (plan §762).** Target: as Tier F.48. Test: `test_unified_readout_does_not_accept_p_conditioning_evidence_parameter`. Complexity: S.

52. **PreparedConditioningEvidence.serialise_runtime_bundle marks `compatibility_metadata_note`.** Target: extend `test_forecast_state_cohort.py` (which already inspects `p_conditioning_evidence` at line 566) or a new test in `test_doc56_phase0_behaviours.py`. Test: `test_prepared_conditioning_evidence_to_dict_marks_compatibility_metadata`. Complexity: S.

53. **Stage 6 `subject_probability_source` literal `'primitive_backed_carrier_and_subject'`; `binding_policy == 'primitive_span.active_cohort_carrier.v1'`.** Target: as Tier F.48. Complexity: S.

54. **Stage 5c `subject_probability_source` literal `'composed_subject_span_window'`.** Target: as Tier F.48. Complexity: S.

### Tier G — source-level / AP58-style guards

55. **No-second-timing-path in `prefix_arrival.py` (no imports from forecast_runtime / forecast_state / cohort_forecast / lag_distribution_utils / span_evidence).** Target: extend `test_active_cohort_carrier_audit.py`. Test: `test_prefix_arrival_module_imports_only_existing_layer`. Complexity: S.

56. **`primitive_readout.py` does not import forecast_state / forecast_runtime / cohort_forecast_v3 (AP58 prevention).** Target: extend `test_active_cohort_carrier_audit.py`. Test: `test_primitive_readout_module_does_not_import_trajectory_engine`. Complexity: S.

---

## Recommendations

The attic should not be deleted as-is. Three observations drive this:

First, the OBSOLETE rows (29 of 147) genuinely retire with the API split — the per-surface eligibility helpers and the deleted `compose_carrier_to_x` are not coming back, and the `test_active_cohort_carrier_audit.py` reachability test already pins their absence. Those rows can be discarded.

Second, the 78 GAP rows include several behaviours that are load-bearing for production correctness and have no live test pinning them anywhere. The Stage 2 outside-in anti-leak invariant (Tier A.1), the §417 composed-cache invalidation invariant (Tier A.3), the §739 cached-vs-uncached primitive equivalence (Tier A.4), and the doc-52 admitted-mass semantics (Tier A.2 + Tier A.5) are the highest-value items. If any of these regresses silently, user-visible CF / cohort_maturity outputs become wrong without test failure. They must be salvaged.

Third, several attic test bodies contain non-trivial fixture scaffolding that the new live tests will need verbatim — the `_make_graph` / `_identity` / `_evidence_scope` / `_candidate` / `_build_resolution` / `_build_arrival_map` helpers in `test_primitive_evidence.py` and `test_primitive_conditioning.py` are the most reusable. The Stage 8 closure-required key set in `test_stage_8_substrate_provenance.py::_CLOSURE_REQUIRED_KEYS` (line 160) is the canonical inventory of plan §745 substrate items and should be transcribed into the new `test_unified_readout_diag.py` or similar.

Salvage candidates (functions worth referencing as patterns when writing the new tests, ordered by reuse value):

- `test_primitive_evidence.py::test_outside_in_anti_leak_downstream_primitive_conditions_on_shifted_day` (line 361) — full anti-leak fixture and assertion pattern.
- `test_primitive_evidence.py::test_admitted_mass_inputs_exclude_retrieval_superset_off_clock_rows` (line 573) — admitted mass vs retrieval superset assertion pattern.
- `test_primitive_conditioning.py::test_full_subset_limit_returns_prior_when_n_effective_equals_m_S` (line 283) — doc-52 subset limit boundary fixture.
- `test_composed_cache.py::TestSubjectSpanCacheWiring::test_primitive_cache_flush_invalidates_subject_span_cache` (line 522) — the §417 invariant scaffolding.
- `test_primitive_cache.py::test_cached_and_uncached_results_have_identical_posterior_fields` (line 322) — §739 stop-condition assertion pattern.
- `test_stage_8_substrate_provenance.py::_CLOSURE_REQUIRED_KEYS` (line 160) and `_assert_closure_keys` (line 179) — canonical Stage 8 substrate inventory.
- `test_prefix_arrival.py::test_carrier_dag_diamond_arrival_weight_matches_composer_reach` (line 419) — though the comparator (`compose_carrier_to_x`) is gone, the diamond fixture and the reach-equality assertion shape transfer to a new oracle if one is built.
- `test_active_cohort_carrier_readout.py::test_changing_upstream_resolved_model_moves_carrier_reach` (line 351) and `test_target_subject_only_change_does_not_move_carrier` (line 399) — Stage 6 §727 connectivity invariants paired pattern.

Once the gap workplan is delivered (Tiers A through G, ~56 new test items, the highest-priority ones from Tier A first), the attic can be deleted with confidence that no load-bearing behaviour has dropped uncovered.
