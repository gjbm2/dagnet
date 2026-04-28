u 73b — Final Outstanding Items

**Date**: 28-Apr-26
**Status**: Open punch list — captured at end of Stage 5, with Stage 6 underway
**Related**: `73b-be-topo-removal-and-forecast-state-separation-plan.md`

## Purpose

Stages 0–5 of plan 73b have landed. Stage 6 is in flight. This doc captures the items that remain open at this point so they are not lost when the plan itself is closed. They fall into seven sections:

1. Held-over Python test failures from Stage 4(d) acceptance.
2. Two BE regressions surfaced during Stage 4 part 2 work — superseded by §5.
3. Spot-check observations from late-stage review that point to gaps between what 73b says is happening and what production actually does.
4. The two key outside-in CLI suites that act as the load-bearing acceptance gates for cohort_maturity v3.
5. Outside-in run results from 28-Apr-26 — 10 failing tests grouped into three failure shapes.
6. Triage order — §3 spot-checks first, then §5 engine work; tolerance vs semantic distinction.
7. Additional forensic review findings from a static 73a/73b implementation pass.

None of these is a Stage 6 entry condition; they are tracked here for follow-up.

---

## 1. Held-over Python failures (Stage 4(d) acceptance)

Eight Python tests are still red after the Stage 4(d) §6.5 reroute landed in [graph-editor/lib/runner/graph_builder.py](graph-editor/lib/runner/graph_builder.py) and [graph-editor/lib/runner/path_runner.py](graph-editor/lib/runner/path_runner.py). The reroute is in effect — every direct `p.mean` carrier read now goes through `resolve_model_params` first and falls back through `_warn_legacy_pmean_carrier` only via the §3.8 documented path — but it does not change the numerical outputs of these eight cases.

The failure mode is `cohort multi-hop midpoint != product of single-hop midpoints` (one case is ~641% off). That is not a §6.5 carrier-read symptom. The arithmetic gap originates inside `cohort_forecast_v3`'s multi-hop composition step, which is independent of the §6.5 reroute work. This overlaps with the territory of [47-multi-hop-cohort-window-divergence.md](47-multi-hop-cohort-window-divergence.md) and should be picked up as a continuation of that line, not as a 73b atom.

**Action**: investigate as a cohort-engine math issue in the 47-series, not as a 73b carrier-read issue.

## 2. Two BE regressions with unknown root cause (superseded by §5)

`test_cohort_factorised_outside_in::test_low_evidence_*` (two cases) regressed during Stage 4 part 2 work and remained red. Two hypotheses (atom 5's analytic `onset_mu_corr` extraction; atom 5's `_src.forecast_mean` preference) were experimentally **falsified** — Option C `onset_mu_corr = 0` override and revert of the `_src.forecast_mean` preference each left the failures unchanged.

The full 28-Apr-26 test run (see §5) revealed that these two failures are not isolated regressions but instances of a wider Group 3 pattern (low-evidence cohort drifts ~60% from the factorised oracle on `synth-simple-abc b→c`). Treat §5's Group 1 / 2 / 3 framing as the authoritative picture; this section's narrower "two regressions" framing is retained only for traceability.

## 3. Spot-check observations

These were surfaced during a late-stage review and are recorded as-found. Each one is a real gap; whether to close it now or carry it as known-debt is a separate call.

### 3.1 `posteriorSliceContexting` does not update `model_vars[bayesian]` in production

73b Stage 4(a/e) says re-contexting projects onto `model_vars[bayesian]`, `p.posterior.*`, and `p.latency.posterior.*`.

In production, [graph-editor/src/hooks/useDSLReaggregation.ts](graph-editor/src/hooks/useDSLReaggregation.ts) only calls `contextLiveGraphForCurrentDsl`. It does **not** upsert the bayesian model_vars and does **not** re-run promotion. After a DSL change, `p.forecast.*` is stale on the live graph.

The test [liveEdgeReContextOnDslChange.test.ts](graph-editor/src/services/__tests__/liveEdgeReContextOnDslChange.test.ts) manually performs the missing upsert in its helper and so passes despite the production gap. The test is asserting an end state that production does not actually reach via the production hook path.

**Action**: either move the bayesian upsert + promotion into the production re-contexting flow, or rewrite the test to exercise the actual production path. As-is, the test does not protect against the regression it is named for.

### 3.2 `prepareAnalysisComputeInputs` can mutate the caller's graph in custom mode

In [graph-editor/src/services/analysisComputePreparationService.ts](graph-editor/src/services/analysisComputePreparationService.ts), for `visibility_mode: 'f+e'`, `applyProbabilityVisibilityModeToGraph` returns the original graph object (no copy on this branch), and then `recontextScenarioGraph` mutates it in place — engorging `_posteriorSlices`, `_bayes_evidence`, and `_bayes_priors` onto the live object.

This violates 73b's "request-graph copy only" rule and risks transient BE-request fields leaking back onto the live or restored graph the user is editing.

**Action**: ensure the f+e branch goes through a deep clone before any engorgement. Add a mutation-detection test (input-vs-output identity check on the live graph after `prepareAnalysisComputeInputs` returns) so the rule is enforced going forward.

### 3.3 CF / analysis parity coverage is thinner than the test names imply

`buildConditionedForecastGraphSnapshot` in [graph-editor/src/lib/conditionedForecastGraphSnapshot.ts](graph-editor/src/lib/conditionedForecastGraphSnapshot.ts) only engorges. It does not perform DSL contexting.

[cfAndAnalysisDerivationParity.test.ts](graph-editor/src/services/__tests__/cfAndAnalysisDerivationParity.test.ts) is named to suggest it covers `model_vars[bayesian]` parity, but its assertions are scoped to `p.posterior`, `p.latency.posterior`, and `_posteriorSlices`. The bayesian model_vars surface is not asserted.

**Action**: either rename the test to reflect its actual scope, or extend it to assert `model_vars[bayesian]` parity end-to-end. Renaming is the lower-risk move; extension is the higher-value move.

### 3.4 73a transport core is aligned; cliAnalyse coverage remains thin for non-CF analyses

73a's core transport rules look broadly aligned: CLI `analyse` passes `populatedGraph` via `customScenarios[].graph`; graph wins over params; `extractParamsFromGraph` is not used for analysis transport.

The remaining 73a concern is coverage. Many cases in `cliAnalyse.test.ts` manually `POST` to the backend rather than exercising the public `analyse` command path. That means non-CF analyses are tested at the wrong seam — the test suite asserts BE behaviour given a payload, not that the CLI builds the right payload.

**Action**: convert non-CF cases to exercise the public command path so the CLI surface is what is under test.

### 3.5 Stale comment in `test_carrier_read_via_shared_resolver.py`

[graph-editor/lib/tests/test_carrier_read_via_shared_resolver.py](graph-editor/lib/tests/test_carrier_read_via_shared_resolver.py) still contains a comment claiming that `graph_builder.py` and `path_runner.py` are "kept on `p.mean`". After Stage 4(d), both files now route those reads through `resolve_model_params` first and only fall back to a logged `p.get('mean')` read via `_warn_legacy_pmean_carrier`.

**Action**: update the comment to reflect the §6.5 reroute. Trivial edit; flag here so it does not get lost.

### 3.6 Pre-retirement contract pins after Stage 6 discriminator retirement

Stage 6 (28-Apr-26) retired the `alpha_beta_query_scoped` discriminator on the source side: property collapsed to `False`, all `already_query_scoped` consumer branches removed, `is_cf_sweep_eligible` / `get_cf_mode_and_reason` reduced to constants, `analytic_degraded` consumer branches removed in TS and Python. Test surface still carries assertions written against the *pre*-retirement contract. They were left untouched in Stage 6 — the user's instruction was that test failures here may indicate genuine CF-machinery faults the discriminator was previously hiding, not test maintenance.

The pins fall into two categories:

**Category A — source-text existence pins.** These are `re.search` checks on source files for literal strings that no longer exist after retirement. Their assertion subject is "the discriminator code is still in the source". They were placed deliberately as Stage 0 retirement gates and are expected to fail when the gate triggers.

- `test_register_entry_3_analytic_degraded_projection_guard_present` ([test_stage0_fallback_register_pinning.py:90](graph-editor/lib/tests/test_stage0_fallback_register_pinning.py#L90))
- `test_register_entry_3_emitter_present_in_runtime` ([test_stage0_fallback_register_pinning.py:125](graph-editor/lib/tests/test_stage0_fallback_register_pinning.py#L125))

**Category B — pins on the discriminator's True branch behaviour.** These set up `source='analytic'` and assert outputs that *only* hold when the True branch fires (no conjugate update, no blend application).

- `test_query_scoped_direct_read_analytic` ([test_non_latency_rows.py:155](graph-editor/lib/tests/test_non_latency_rows.py#L155)) — line 158 asserts `resolved.alpha_beta_query_scoped is True`. After retirement that property is unconditionally `False`.
- `test_query_scoped_direct_read_analytic_again` ([test_non_latency_rows.py:170](graph-editor/lib/tests/test_non_latency_rows.py#L170)) — same `is True` guard.
- `test_query_scoped_model_bands_match_posterior` ([test_non_latency_rows.py:276](graph-editor/lib/tests/test_non_latency_rows.py#L276)) — asserts `model_midpoint == midpoint`; the `model_*` band is the unconditioned prior, so equality only holds when no conjugate update fires.
- `test_blend_non_latency_skip_query_scoped` ([test_non_latency_rows.py:338](graph-editor/lib/tests/test_non_latency_rows.py#L338)) — asserts `blend_skip_reason == 'source_query_scoped'`. That skip reason only existed as the True-branch's blend-suppression marker.

**Pure source-existence pins on retired text.** Same shape as Category A.

- `test_doc56_phase0_behaviours.py:675-676` — asserts `cf_mode == "analytic_degraded"` for window/cohort daily output. After retirement `cf_mode` is always `'sweep'`. The surrounding test (`test_bayesian_sidecar_preserves_downstream_window_cohort_chart_split`) also carries a load-bearing `window_total != cohort_total` and per-day `x` / `y` divergence assertion — those are *not* discriminator pins and any failure of those is real CF behaviour.
- The whole of `test_cf_query_scoped_degradation.py` — built around the retired contract.
- `test_wp8_default_off.py` — patches `alpha_beta_query_scoped` to False and asserts post-Stage-2 behaviour; should still pass but the comments name a now-non-existent toggle.
- `test_forecast_state_cohort.py:721` — comment claims `resolved.source = 'analytic'` toggles the property; that's no longer true. Comment-only.

**Action**: review each pin against the new source code. Distinguish (i) pins that were deliberately retirement gates and should be deleted, from (ii) tests whose numerical expectations are now wrong because the underlying CF arithmetic on the conjugate-update path produces a *different* answer than the discriminator's shortcut did. Category (ii) is the one that may be unmasking CF bugs rather than expecting test updates.

### 3.7 FE E2E parity echo: `abBcSmoothLag` blended-reach undershoot

After Stage 6 (and the subsequent Atom A revert that restored `bayesPriorService.ts` `_posteriorSlices` cleanup hygiene), the full vitest suite reports **1 remaining failure**: [abBcSmoothLag.paramPack.amplitude.e2e.test.ts:748](graph-editor/src/services/__tests__/abBcSmoothLag.paramPack.amplitude.e2e.test.ts#L748) — `Jul–Aug window reach(to(C)) is stable; f+e (blended) > e (evidence-only) after step-up`. The test asserts `reachBlended ∈ [0.16, 0.22]` after a step-up in evidence; observed `reachBlended = 0.125`.

Behavioural invariant, not a contract pin. The test is run end-to-end through the param-pack stats pipeline on a synth-simple-ABC `b→c` step-up scenario. The undershoot is most plausibly the FE-side analogue of §5 Group 3 (low-evidence cohort drifts ~60% from the factorised oracle, same `synth-simple-abc b→c` shape). Likely causes from Stage 6 source edits, in order of likelihood:

1. Analytic-source edges now run conjugate update + blend instead of the direct-read shortcut — analytic α/β shifts toward the query window's evidence and the post-update mean drops for this fixture.
2. `_compute_blend_params` no longer skips for analytic, so doc 52 blend now applies where it was previously skipped — moment-matched output drifts.
3. `_non_latency_rows` model_* band path now executes the prior-bands branch unconditionally for analytic, cascading into reachBlended via the bands the param-pack reads from.

Should be triaged alongside §5 Group 3 — same suspected root cause, different surface.

---

## 4. Key outside-in CLI suites for cohort_maturity v3

Two carefully-constructed outside-in CLI suites are the load-bearing acceptance gates for cohort_maturity v3. Both live inside the same file — [`graph-editor/lib/tests/test_cohort_factorised_outside_in.py`](graph-editor/lib/tests/test_cohort_factorised_outside_in.py) (created 26-Apr-26) — under two distinct sections that the file's docstring names explicitly.

Both suites drive `graph-ops/scripts/analyse.sh` and `graph-ops/scripts/param-pack.sh` through the daemon, so they exercise the same path the live FE / CLI tooling does. Neither suite is a v2/v3 parity comparison; they assert absolute properties (oracle truth, scalar identity across surfaces).

### Suite A — semantic correctness under defined degeneracy conditions (12 tests)

Drives cohort_maturity rows under named degeneracy / metamorphic conditions and compares them to factorised CDF/PDF oracles built from `bayes/truth/*.yaml`.

1. `test_a_equals_x_identity_collapses_to_window`
2. `test_single_hop_non_latent_upstream_collapses_to_window` (parametrised over fanout subjects)
3. `test_single_hop_latent_upstream_lags_window_but_converges_to_same_subject_p`
4. `test_anchor_depth_monotonicity_for_same_subject`
5. `test_same_carrier_shared_across_different_subjects`
6. `test_low_evidence_cohort_matches_factorised_convolution_oracle`
7. `test_no_evidence_single_hop_matches_unconditioned_fw_convolution_midline`
8. `test_low_evidence_single_hop_remains_near_unconditioned_oracle`
9. `test_degenerate_identity_and_instant_carrier_oracles_reduce_to_subject_kernel`
10. `test_multihop_non_latent_upstream_collapse`
11. `test_multihop_latent_upstream_divergence`
12. `test_multihop_subject_span_is_not_last_edge_or_param_pack_scalar`

### Suite B — param-pack ↔ cohort-analysis-v3 parity (8 tests, "CLI public parity canaries")

Asserts that param-pack edge scalars (`p.mean`, `p.latency.completeness`) equal the same-edge scalars produced by `cohort_maturity` (last-row `p_infinity_mean`, `completeness`) and `conditioned_forecast` (`p_mean`, `completeness`) across a range of conditions.

1. `test_cli_window_single_edge_scalar_identity_across_public_surfaces`
2. `test_cli_identity_collapse_matches_window_across_public_surfaces`
3. `test_cli_single_hop_downstream_cohort_parity_and_admitted_provenance`
4. `test_cli_projection_parity_uses_last_row_saturation_not_arbitrary_tau_curve_point`
5. `test_cohort_and_window_p_infinity_converge_for_same_subject_rate` (parametrised × 3)
6. `test_cohort_frame_evidence_is_admitted_only_for_single_hop_anchor_override_case`
7. `test_cohort_frame_evidence_does_not_retarget_carrier_or_subject`
8. `test_zero_evidence_window_rises_as_subject_cdf`

These two suites are the primary signal for whether the live cohort_maturity v3 path is healthy end-to-end. Other outside-in files (v2/v3 parity, multi-hop evidence parity, doc-56 cross-consumer agreement, cf-truth-parity, etc.) are useful but secondary to these two.

---

## 5. Outside-in run results — 28-Apr-26

Ran `pytest graph-editor/lib/tests/test_cohort_factorised_outside_in.py -v` through the daemon against the live Python BE and snapshot DB. **10 failed, 13 passed in 6 min 37 s.**

Suite A (semantic correctness, 13 parametrised entries): 5 fail / 8 pass. Suite B (param-pack ↔ cohort-analysis-v3 parity, 10 parametrised entries): 5 fail / 5 pass.

The ten failures fall into three shapes that almost certainly correspond to fewer than three underlying defects.

### Group 1 — small drift (~4e-4) on cohort ↔ window asymptote convergence

Subject-equivalent cohort and window queries should converge to the same `p_infinity_mean` to 1e-6 (tighter where graph fixtures support it). They are drifting by ~4.7e-4 on synth-lat4. The same 4.7e-4 number appears across multiple tests, which is consistent with one drift source.

- `test_single_hop_non_latent_upstream_collapses_to_window[fast]` — `model_midpoint` diff 4.2e-4 at τ=1 vs tol 1e-9.
- `test_single_hop_latent_upstream_lags_window_but_converges_to_same_subject_p` — window=0.4944, cohort=0.4949, delta 4.7e-4 vs tol 1e-6.
- `test_cohort_and_window_p_infinity_converge_for_same_subject_rate[synth-lat4 (-1d:)]` — same 4.7e-4.
- `test_cli_identity_collapse_matches_window_across_public_surfaces` — pack `p.mean`=0.6406 vs cm last-row=0.6402, delta 4.4e-4 vs tol 1e-4.

Plausibly explained by conditioning that previously did not run now running uniformly under the Decision-13 sweep path. If so, the right move is to relax these tolerances (and write down *why*), not chase the arithmetic.

### Group 2 — large (~12–18%) anchor-depth divergence on synth-lat4 c→d

The anchor-depth invariant says window, identity-A=X, near-anchor B, far-anchor A all converge to the same subject `p_infinity` (the four queries are subject-equivalent — the same edge under different anchors). They don't. The `cohort(synth-lat4-b, -90d:)` arm sits ~12% below the others. Same 0.66 → 0.52 number recurs in three tests.

- `test_anchor_depth_monotonicity_for_same_subject` — p_values spread max 0.6640, min 0.5217 = 0.142 absolute.
- `test_cohort_frame_evidence_does_not_retarget_carrier_or_subject` — identical 0.66 → 0.52 numbers.
- `test_cohort_and_window_p_infinity_converge_for_same_subject_rate[synth-lat4 (-90d:) cohort(synth-lat4-b)]` — window=0.640, cohort=0.522, delta 0.118.
- `test_cli_single_hop_downstream_cohort_parity_and_admitted_provenance` — completeness_delta 0.036 below the 0.05 lower bound (cohort anchor override under-shifts completeness).

This is **not** a tolerance issue. The cohort anchor override is producing materially different subject `p_infinity` than window for the same edge. This is the closest test-level analogue to the funnel symptom on the live app and is the most likely real engine defect of the three groups.

### Group 3 — low-evidence cohort drifts ~60% from the factorised oracle

On `synth-simple-abc b→c` with `cohort(1-Mar-26:3-Mar-26).asat(3-Mar-26)` (very low evidence, 2-day cohort range), the live curve undershoots the factorised CDF/PDF oracle from `bayes/truth/synth-simple-abc.truth.yaml`. At τ=16 actual=0.0149 vs oracle=0.0421 (64.6% relative under). Drift grows monotonically through τ=20.

- `test_low_evidence_cohort_matches_factorised_convolution_oracle`
- `test_low_evidence_single_hop_remains_near_unconditioned_oracle`

This subsumes the older "two BE regressions" §2 framing — same tests, now contextualised against an oracle gap rather than against a within-engine baseline. Real engine defect; not tolerance.

### Headline interpretation

Group 1 is plausibly tolerance / new-conditioning behaviour and may be acceptable after relaxing tolerances and documenting why. Groups 2 and 3 are real semantic regressions that the prior `analytic_degraded` shortcut was likely masking. The user's working hypothesis — retired pathway exposed real CF issues; FE now sees what CLI sees — fits the evidence.

---

## 6. Triage order

Per the user's direction:

1. **First, confirm 73a & 73b were built per spec.** Walk §3 spot-check items: §3.1 (production re-contexting not upserting `model_vars[bayesian]`), §3.2 (analysis-prep mutation in f+e mode), §3.3 (CF/analysis parity test scope narrower than name), §3.4 (cliAnalyse non-CF coverage), §3.5 (stale comment), §3.6 (pre-retirement contract pins). Some of these are simple corrections; the §3.1 and §3.2 items in particular are spec-vs-implementation gaps that may themselves be downstream contributors to the cohort_maturity v3 failures in §5.
2. **Then move to the outside-in failures in §5.** Working hypothesis: the suite was passing before 73 because the retired `analytic_degraded` / discriminator pathway shortcut was masking real CF issues. The retired path and its fallbacks were the obfuscating layer; what FE now sees should be much closer to what CLI sees, exposing the actual engine defects rather than the symptom mosaic that was being papered over.
3. **Tolerance vs semantic divergence.** Group 1 (~4e-4 drift on previously-1e-6 contracts) is a candidate for tolerance relaxation rather than engine work — those contracts may have held under no-conditioning and now drift slightly under uniform sweep conditioning; relaxing the test tolerance with a documented reason is the right response if that's the cause. Group 2 (~12–18% anchor-depth) and Group 3 (~60% oracle drift) are substantial semantic divergences and warrant real engine investigation — these are not tolerance issues and should not be silenced.

---

## 7. Static forensic review findings — 28-Apr-26

The following items were confirmed by source inspection against the 73a-2 / 73b contracts. No tests were run for this review.

### 7.1 `analyse --type conditioned_forecast` drops prepared display settings

The CLI `analyse` command runs `prepareAnalysisComputeInputs`, which resolves compute-affecting display settings, including `tau_extent: 'auto'`. The standard `runPreparedAnalysis` path forwards those settings to the backend as `display_settings`.

The conditioned-forecast branch in [graph-editor/src/cli/commands/analyse.ts](graph-editor/src/cli/commands/analyse.ts) builds a separate `/api/forecast/conditioned` payload from the prepared scenarios but omits both top-level `display_settings` and per-scenario `display_settings`. The backend handler in [graph-editor/lib/api_handlers.py](graph-editor/lib/api_handlers.py) explicitly reads `scenario.display_settings || data.display_settings` when computing `axis_tau_max`.

This violates 73a-2 Stage 3's "conditioned forecast analysis and normal analysis dispatch must continue to share the same preparation state" rule for compute-affecting display state, even though the scenario graph transport itself is aligned.

**Action**: forward `prepared.displaySettings` on the conditioned-forecast CLI payload, and decide whether the browser `conditionedForecastService` should use the same payload field for consistency.

### 7.2 `parity-test` still replays thin params instead of scenario-owned enriched graphs

[graph-editor/src/cli/commands/parity-test.ts](graph-editor/src/cli/commands/parity-test.ts) still aggregates each scenario graph, immediately calls `extractParamsFromGraph`, and then calls `prepareAnalysisComputeInputs(mode: 'live')` with `currentParams` / `scenarioLikes.params`. It does not pass the aggregated `graph` through `customScenarios[].graph`.

That repeats the historical `populatedGraph -> param pack -> rebuilt graph` pattern that 73a-2 was created to remove from analysis transport. `parity-test` is not the public `analyse` command, but it is a CLI diagnostic surface that calls the shared preparation service and can therefore give false confidence about the very transport seam 73a-2 is meant to protect.

**Action**: either migrate `parity-test` to scenario-owned enriched graph transport, or retire / relabel it as an old params-overlay diagnostic that must not be used as a 73a/73b parity signal.

### 7.3 `read_edge_cohort_params` bypasses the shared resolver

[graph-editor/lib/runner/forecast_runtime.py](graph-editor/lib/runner/forecast_runtime.py) `read_edge_cohort_params` builds upstream carrier probability directly from `p.posterior.cohort_alpha/beta`, then `p.posterior.alpha/beta`, then `p.forecast.mean`. It does not call `resolve_model_params` and does not read the 73b Stage 2 analytic mirror under `model_vars[analytic].probability`.

This function feeds `build_x_provider_from_graph` and then `build_upstream_carrier`, so upstream carrier Tier 1 can disagree with the shared resolver whenever `p.posterior` is empty but L1 analytic shape exists, or when L2 `p.forecast.mean` is stale relative to L1. That violates 73b §6.5 / Appendix B's rule that carrier consumers read L1/L1.5/L2 through the single shared resolver and never invent their own model-input precedence.

**Action**: route upstream carrier parameter extraction through `resolve_model_params` for probability and latency selection, with any genuinely required path-level latency handling documented as a narrow extension rather than a parallel resolver.

### 7.4 Bayes patch Tier 1 projects bare `window()` / `cohort()` slices onto the graph

[graph-editor/src/services/bayesPatchService.ts](graph-editor/src/services/bayesPatchService.ts) merges the full `patchEdge.slices` object into the parameter file, but the direct graph update path then reads only `slicesRaw['window()']` and `slicesRaw['cohort()']` to populate `p.posterior`, `p.latency.posterior`, `model_vars[bayesian]`, and promotion.

That bypasses the shared `resolvePosteriorSlice(slices, effectiveDsl)` / `buildSliceKey` projection contract that 73b Appendix B defines for I4. If the graph is open, Tier 2 later calls `getParameterFromFile(... targetSlice: currentDSL)` and may correct the live GraphStore. If the graph is not open, Tier 2 is skipped and the graph file in FileRegistry/IDB is left with a bare-slice projection even if the current graph DSL is contexted or otherwise should select a non-bare slice.

**Action**: either remove the direct graph posterior/model-vars projection from Tier 1 and let the canonical file-to-graph projection own it, or make Tier 1 call the same slice resolver using the graph's effective DSL.

### 7.5 Missing parameter-file posterior slices leave stale graph projection in place

The docstring for `contextProbabilityBlock` in [graph-editor/src/services/posteriorSliceContexting.ts](graph-editor/src/services/posteriorSliceContexting.ts) says that when `posterior.slices` is absent on the parameter file, the helper clears `p.posterior` and `p.latency.posterior` so stale projections cannot persist.

The implementation does the opposite: when `!fileposterior?.slices`, it returns without clearing either in-schema field, only clearing `_posteriorSlices` when request-graph engorgement is enabled. A parameter file with posterior material removed or stripped can therefore leave an old in-schema projection on the live/request graph.

**Action**: make the missing-slices branch match the stated strict-clearing contract, and cover the already-clean case so the cleanup remains idempotent.

### 7.6 Forecast runtime still has always-on debug stdout

The live Python forecast paths still contain unconditional `print` diagnostics such as `[v3-debug]`, `[sweep-diag]`, `[sweep_diag]`, `[rate_draws_sha256]`, and `[v2] carrier tier=...` in [graph-editor/lib/runner/forecast_state.py](graph-editor/lib/runner/forecast_state.py), [graph-editor/lib/runner/forecast_runtime.py](graph-editor/lib/runner/forecast_runtime.py), and [graph-editor/lib/runner/cohort_forecast_v3.py](graph-editor/lib/runner/cohort_forecast_v3.py).

Some neighbouring diagnostics are correctly gated behind `DAGNET_COHORT_DEBUG`, but these are not. This is residue / CLI noise from the forecast debugging work and conflicts with 73b Work package A's explicit cleanup goal.

**Action**: gate these diagnostics behind a debug flag or convert them to structured diagnostics that are only emitted when requested.

---

## Summary

| # | Item | Severity | Owner-area |
|---|---|---|---|
| 1 | 8 held-over Python tests (cohort multi-hop midpoint) | High | 47-series, not 73b |
| 2 | 2 BE regressions, root cause unknown | High | Fresh investigation |
| 3.1 | Production re-contexting does not upsert `model_vars[bayesian]` | High | Stage-4 follow-up |
| 3.2 | Analysis prep mutates caller graph in f+e mode | Medium | Cleanup + guard test |
| 3.3 | CF/analysis parity test scope narrower than name | Low | Rename or extend |
| 3.4 | cliAnalyse non-CF cases hit BE directly, not CLI | Low | Test refactor |
| 3.5 | Stale comment in carrier-read shared-resolver test | Trivial | One-line fix |
| 4 | Two outside-in CLI suites in `test_cohort_factorised_outside_in.py` are the primary cohort_maturity v3 acceptance gates | Reference | Run as primary signal |
| 5 | Outside-in run 28-Apr-26: 10 fail / 13 pass — Group 1 small drift, Group 2 anchor-depth ~12–18%, Group 3 low-evidence oracle ~60% | High | Engine investigation (Groups 2, 3); tolerance call (Group 1) |
| 6 | Triage order: §3 spot-checks first; then §5 engine work; tolerance vs semantic distinction | Reference | Sequencing |
| 7.1 | `analyse --type conditioned_forecast` omits prepared display settings | Medium | CLI CF payload |
| 7.2 | `parity-test` still uses param replay instead of enriched scenario graphs | Medium | CLI diagnostics |
| 7.3 | `read_edge_cohort_params` bypasses `resolve_model_params` | High | Python forecast runtime |
| 7.4 | Bayes patch Tier 1 projects bare slices instead of effective-DSL slices | Medium | Bayes patch / contexting |
| 7.5 | Missing `posterior.slices` leaves stale graph posterior projection in place | Medium | Posterior contexting |
| 7.6 | Forecast runtime emits always-on debug stdout | Low | Python forecast runtime cleanup |

---

