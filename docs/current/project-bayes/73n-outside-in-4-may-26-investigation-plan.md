# 73n — Outside-in failures investigation & resolution plan (4-May-26)

**Status**: open — investigation plan, no code changes proposed yet
**Date opened**: 4-May-26
**Anchored contract**: [`73n-unified-cf-runtime-invariants-and-audit.md`](73n-unified-cf-runtime-invariants-and-audit.md) (3-May-26 "Latest Current State" section)
**Supersedes for triage purposes**: [`73n-stage-9-failure-catalogue.md`](73n-stage-9-failure-catalogue.md) (2-May-26) — its F1/F6/F9/F10 closed under the unified-runtime cutover; F2/F3/F4/F5/F7/F8 persist with shifted numbers; five new failures opened that the 2-May catalogue did not cover.
**Status of 73f**: stale. [`73f-outside-in-cohort-engine-investigation.md`](73f-outside-in-cohort-engine-investigation.md) is dated against the pre-deletion-pass substrate (Stage 5a/5b/5c/6 staged readouts, `compose_carrier_to_x` as the carrier path, `_resolve_frame_carrier_state`). Those surfaces are no longer live. 73f's workstreams WS1/WS2 and its F-numbered failure rows do not map cleanly onto the current code. This plan replaces 73f as the active triage entry point. 73f stays in the tree as historical record only; do not cite its line numbers as if they were current.

## Purpose

`graph-editor/lib/tests/test_cohort_factorised_outside_in.py` is the public-semantic acceptance gate for 73n. On a clean run today it reports **11 failed / 25 passed / 4 skipped / 1 xfailed** out of 41 collected. The unified-runtime cutover described in §"Latest Current State — 3-May-26" of the invariants doc explicitly defers test reconciliation as Closure Stage 6 and explicitly does not claim the public semantic suite is green. This plan opens that work.

The plan is investigation-first. It does not propose fixes. Its goal is to (a) pin the current state so drift between sessions is visible, (b) cluster the failures by hypothesised root cause, (c) define the order in which clusters should be diagnosed, (d) define what each cluster's resolution must prove against the lettered invariants A–O, and (e) define acceptance for the suite as a whole.

## Pinning: 4-May-26 outside-in state

Run command (deterministic, no diag noise):
`pytest lib/tests/test_cohort_factorised_outside_in.py --tb=no -q` from `graph-editor/` with `venv` active.

Initial baseline: 11 failed / 25 passed / 4 skipped / 1 xfailed in ~138 s.

After the orphan fix (4-May-26 — see "Orphan — bayes-vars sidecar promotion failure" below): **10 failed / 26 passed / 4 skipped / 1 xfailed**. No regressions.

After the Cluster A fix (4-May-26 — see "Resolution applied 4-May-26" inside Cluster A): **7 failed / 29 passed / 4 skipped / 1 xfailed**. Cluster A's three failures (#1, #7, #8) closed; Cluster B's #6 (`cli_projection_parity`) narrowed from |Δ|=0.00146 to 0.00024 — confirming the plan's prediction that #6 was a Cluster A satellite, though it remains over the 1e-4 completeness tolerance and stays open with B's other completeness-parity failures.

Failures verbatim, with the assertion delta as the test prints it:

1. `test_anchor_depth_monotonicity_for_same_subject` — 0.6609 vs 0.6538, |Δ|=0.0071, tol=1e-3.
2. `test_no_evidence_single_hop_matches_unconditioned_fw_convolution_midline` — at τ=17 actual=0.0480 expected=0.0587, |Δ|=0.0107, tol=0.01 abs / 15% rel.
3. `test_multihop_latent_upstream_divergence` — found 0 divergent τ; needs ≥5.
4. `test_cli_window_single_edge_scalar_identity_across_public_surfaces` — completeness mismatch on simple-a→b window.
5. `test_cli_identity_collapse_matches_window_across_public_surfaces` — completeness mismatch on synth-lat4 c→d window.
6. `test_cli_projection_parity_uses_last_row_saturation_not_arbitrary_tau_curve_point` — |Δ|=0.00146, tol=1e-3.
7. `test_cohort_and_window_p_infinity_converge_for_same_subject_rate[synth-lat4 c→d window vs cohort(b)]` — p_infinity mismatch.
8. `test_cohort_frame_evidence_does_not_retarget_carrier_or_subject` — 0.6609 vs 0.6538 (same numbers as #1).
9. `test_d0_bayes_vars_actually_promotes_to_bayesian` — `promoted_source` field is empty string `''`, not `'analytic'`.
10. `test_f_mode_anti_vacuity_local_window_diverges_from_global_aggregate` — at τ=53 saturation gap |F−E+F|=0.0088, floor 0.10. F=0.4658, E+F=0.4746.
11. `test_f_mode_diverges_from_ef_off_frontier_under_drift` — at τ=11 |Δ|=0.0126, floor 0.05. F=0.3612, E+F=0.3738.

Closed since 2-May-26 catalogue (no longer in the failure set; do not regression-pursue without re-running):
- F1 / F6 `single_hop_latent_upstream_lags_window_but_converges_to_same_subject_p` and the `lat4 b→c -1d:` parametrisation of the convergence test.
- F9 / F10 `d1_parity_analytic_vs_bayes_mature_window` and `d2_parity_analytic_vs_bayes_identity_collapse_cohort`.

These should be re-verified once the cluster work below moves — Suite D is now gated by the bayes-vars promotion regression in failure #9 above, so D1/D2/D3/D4 may pass for the wrong reason (sidecar silently inert).

## Clusters

The 11 failures resolve to four hypothesis-bearing clusters and one orphan. Numbers and call-paths are taken from the test diagnostics; clusters are working hypotheses to be confirmed per-test before fixing, not pre-decided fixes.

### Cluster A — Subject-scalar substitution divergence between identity-carrier and active-carrier paths

Failures: 1 (`anchor_depth_monotonicity_for_same_subject`), 7 (`cohort_and_window_p_infinity_converge_for_same_subject_rate[synth-lat4 c→d cohort(b)]`), 8 (`cohort_frame_evidence_does_not_retarget_carrier_or_subject`).

#### Investigation completed 4-May-26

Diagnostic capture across the four `synth-lat4 c→d` queries (window, cohort(c) identity, cohort(b) near, cohort(a) far) produced the following picture. All four queries hit `subject_probability_source = primitive_span.subject` and `projection.substituted = True`; all four return identical legacy IS posteriors (`f14_is.post_IS_p_median = 0.655462`, `sum_N = sum_k = 0` because the legacy aggregate IS counts a different thing — the "no aggregate cohorts conditioned" path). The substrate's composed-public-moments differ:

| Query | carrier role | composed `p_mean` | composed `p_sd` |
|---|---|---|---|
| window | identity | 0.6538 | 0.0036 |
| cohort(c) identity | identity | 0.6538 | 0.0036 |
| cohort(b) near | carrier_to_x | 0.6609 | 0.0206 |
| cohort(a) far | carrier_to_x | 0.6574 | 0.0235 |

The `p_sd` widens 5x between identity-carrier and active-carrier on the same subject edge. That is structural, not MC noise. The cause is in the request-scoped primitive registry's binding decisions for the subject primitive `synth-lat4-c → synth-lat4-d`:

| Query | c→d topology_case | c→d raw_total_n | c→d weighted_total_n | c→d weighted_k | empirical k/n |
|---|---|---|---|---|---|
| window | identity | 54091 | 54091 | 33655 | 0.6222 |
| cohort(c) identity | identity | 54091 | 54091 | 33655 | 0.6222 |
| cohort(b) near | composed | 60710 | **598.86** | 338.88 | 0.5659 |
| cohort(a) far | composed | 59777 | **510.80** | 271.42 | 0.5314 |

For active-carrier requests, the c→d primitive is bound under `topology_case = composed`: every raw row is multiplied by the prefix arrival weight at node `c` induced by the request root `A = b` (or `a`). The b→c latency CDF spreads uniform per-day rows into a thin convolution, so the effective weighted sample size collapses from ~54 000 to ~600 — a 100× reduction in evidence pressure. Under that reduced effective evidence the conditioned posterior on `p_{c→d}` widens from `sd ≈ 0.004` (driven by the analytic prior with `α+β` ≈ tens of thousands) to `sd ≈ 0.020` (much weaker effective `α+β`), and its mean drifts toward the synth fixture's broad prior mean.

This is the bug. Per invariant K ("`subject_span` Owns Numerator Progression — given mass at `X`, when does it reach the subject end?"), the subject rate `Y/X` is conditional on arrival at `X` by definition. The subject primitive `c→d`'s evidence belongs on the **c-clock identity** (source `c` is `X` for the subject span — its own root), not on the b-clock arrival-weighted clock that the active-carrier path is currently applying. Per invariant I ("Displayed Rate Is Always `Y / X`"), the displayed subject rate must not change with the cohort anchor; the same `c→d` primitive must produce the same posterior regardless of `A`.

The current code has a single request-scoped arrival map rooted at `population_root` (which equals `A` for active cohort) and applies it uniformly to both carrier and subject primitives. Subject primitives downstream of `A` therefore receive carrier-induced arrival weighting. That conflates carrier-side arrival semantics ("who reaches `X` by tau") into the subject-side rate evidence ("of those at `X`, what fraction converts").

Construction site (current tree):

- `cohort_forecast_v3.build_resolved_cf_runtime` at [graph-editor/lib/runner/cohort_forecast_v3.py:701-708](graph-editor/lib/runner/cohort_forecast_v3.py#L701-L708) builds the single map with `root_node_id = population_root` over the union of `carrier_resolutions + subject_resolutions`.
- `primitive_readout.compute_resolved_runtime_readout` consumes it and the binder/conditioner emit the `composed` topology_case for the subject primitive whenever the source node is non-root.

Fix surface (4-May-26): the arrival map must be split into a **carrier map** rooted at `A` (used to bind carrier primitives `A → X`) and a **subject map** rooted at `X` (used to bind subject primitives `X → end`). Every subject-side primitive's source node sits under the X-rooted map and resolves to its identity entry when the subject is one edge, or to a downstream entry when multi-hop — but never to a carrier-influenced arrival distribution. Window and `cohort(A = X)` collapse naturally: the X-rooted subject map is identity at `X`, the carrier map is degenerate. Active cohort's carrier weighting only flows into the carrier composition (and thence into reach), not into the subject rate.

This is consistent with the semantics doc's two-clocks contract (`COHORT_ANALYSIS_NUMERATOR_DENOMINATOR_SEMANTICS.md` lines 482-514): denominator clock = carrier `A→X`, numerator clock = subject-span `X→end`, "it is correct for the denominator side and numerator side to use different latencies." The current single-map implementation collapses these into one clock (the carrier's), violating the decoupling.

The fix unblocks Cluster A's three failures and is expected to also resolve the related `f14_is` mismatch the legacy engine logs (currently masked because the legacy IS reports zero aggregate evidence for these zero-cohort queries; the substrate is the active source).

#### Resolution criteria

Identity-carrier and active-carrier requests against the same subject primitive scope must produce the same `composed_subject.span_p_mean` to within `_P_MEAN_ABS_TOL` (1e-3) and the same `composed_subject.span_p_sd` to within MC noise (`<5e-3` on `S=2000` for this fixture). The c→d primitive's `weighted_total_n` must equal its `raw_total_n` for both identity-carrier and active-carrier requests (the subject's own root is `c`, identity weights apply). No tolerance softening on the test side.

#### Resolution applied 4-May-26

Two-clocks split implemented across `cohort_forecast_v3.build_resolved_cf_runtime`, `primitive_readout.compute_resolved_runtime_readout`, and `primitive_evidence.RequestPrimitiveRegistry.register`. The single request-scoped arrival map became two: a **subject map** rooted at `query_from_node` (= `X`) for binding subject primitives, and a **carrier map** rooted at `population_root` (= `A`) for binding carrier primitives. Carrier map is only constructed when `carrier_resolutions` is non-empty (active cohort with `A != X`); window and `cohort(A = X)` build only the subject map and behave identically to the pre-fix shape. The registry is keyed by the subject map's identity; carrier primitives are registered with an explicit `prefix_identity=carrier_arrival_map.identity` override so their registry keys encode the carrier clock independently. Retrieval-superset widening uses the subject map (the subject side is what `target_subject_metadata` describes).

Diagnostic re-capture across the same four queries:

| Query | composed `p_mean` | composed `p_sd` |
|---|---|---|
| window | 0.6538 | 0.0036 |
| cohort(c) identity | 0.6538 | 0.0036 |
| cohort(b) near | **0.6538** | **0.0036** |
| cohort(a) far | **0.6538** | **0.0036** |

All four identical to MC tolerance. The subject c→d primitive now binds on identity weights at `c` regardless of the cohort anchor, satisfying invariants I and K.

### Cluster B — CLI public-surface parity (param-pack vs cohort_maturity vs cf)

Failures: 4 (`cli_window_single_edge_scalar_identity_across_public_surfaces`), 5 (`cli_identity_collapse_matches_window_across_public_surfaces`), 6 (`cli_projection_parity_uses_last_row_saturation_not_arbitrary_tau_curve_point`).

These were 73n catalogue Cluster C (completeness drift) plus the F5 partial-pack scalar drift. Failures 4 and 5 still report a completeness mismatch; failure 6 reports a small p_infinity drift (|Δ|=0.00146 against 1e-3, an order of magnitude off the wider Cluster A 0.0071 number).

Failures 4 and 5 are sensitive to whether two-site completeness computation has been collapsed to one site — historically FE `statisticalEnhancementService.ts` and BE `forecast_state.py` ran independent completeness projections. Invariant N says projection must not re-decide; under the unified runtime, completeness should be data on `ResolvedCFRuntime` consumed by both surfaces. The cluster needs verification that the completeness number now flows from one runtime field, not two parallel computations.

Failure 6 is plausibly downstream of Cluster A — when the active-cohort subject scalar shifts, the param-pack `p.mean` (which the test compares to last-row `p_infinity_mean`) may also shift. Confirm dependency before treating as independent. If Cluster A closure also closes 6, this failure is a Cluster A satellite; otherwise it indicates a pack-vs-runtime read-time inconsistency.

Investigation order:
1. Run failures 4, 5, 6 individually with `--diag` and capture both surfaces' completeness numbers (and for 6, both pack `p.mean` and last-row `p_infinity_mean`).
2. For 4 and 5: trace the BE completeness number to its construction site on `ResolvedCFRuntime` (or trajectory output), and the FE/pack completeness number to its construction site. Are they the same field, or two computations? If two, that is the closure violation under invariant N.
3. For 6: re-check after Cluster A's investigation lands. If Cluster A's diagnosis converges on a single subject-scalar source that flows through the pack as well, failure 6 should resolve as a side-effect.

Resolution must prove: param-pack and cohort_maturity public surfaces consume the same conditioned primitive's public scalar and the same completeness number on the same query. Not "agree to within tolerance"; the same field. Tolerance is downstream of MC noise, not architecture.

### Cluster C — Multi-hop / no-evidence trajectory shape regressions (NEW since 2-May-26)

Failures: 2 (`no_evidence_single_hop_matches_unconditioned_fw_convolution_midline`), 3 (`multihop_latent_upstream_divergence`).

These did not appear in the 2-May catalogue. They are casualties of the trajectory-engine reduction-to-projector deletion pass and the carrier-composition cutover — both shipped after the catalogue.

Failure 2: simple-b→c with no evidence, `cohort(-1d:)`. The model midline at τ=17 reads 0.0480; the unconditioned FW-convolution oracle reads 0.0587 at the same τ. The test allows |Δ|≤0.01 *or* rel≤15%; the actual is 0.0107 / 18.2%, just past both. This is a small but real shape divergence between the runtime's projected midline and a closed-form FW oracle on a no-evidence single-hop case. Candidate causes: trajectory engine consuming a slightly different conditioned-p draw stream than the oracle assumes; subject-span composer producing a mildly different CDF on the upstream a→b convolution leg; `prepare_subject_span_cdf` width/grid mismatch with the oracle. Single-hop no-evidence is the cleanest possible test — passing it is a precondition for trusting any of the more conditioned shape tests.

Failure 3: cf-fix-deep e→g multi-hop. The test asserts that *window* mode `evidence_x` and *cohort* mode `evidence_x` should diverge at ≥5 τ values by ≥5% relative — under latent upstream, cohort and window must report different observed-x curves because cohort folds in upstream arrival latency, window does not. Test reports 0 divergent τ. Under the unified runtime, window and cohort enter the same runtime-assembly path with carrier identity vs composed A→X represented as data; if the data carrying the carrier identity is being applied uniformly to both, that explains zero divergence. This is a candidate violation of invariant H ("Single Cohort/Window Handler") — degenerate-as-data, not as no-op.

Investigation order:
1. Failure 2: in isolation, with `--diag`, compare the runtime's row-level `evidence_x`, `forecast_x`, `forecast_y`, `model_midpoint` on simple-b→c `cohort(-1d:)` against the FW oracle output (the test imports `_single_hop_oracle_curve`; check whether the oracle still reflects current FW semantics or has drifted). Identify whether the gap is a midline projection error or an oracle staleness.
2. Failure 3: capture `evidence_x` for both window and cohort runs of cf-fix-deep e→g, plus runtime provenance. Identify which runtime field carries the carrier-identity vs composed-carrier branch and whether `evidence_x` is recomputed off that field or produced ahead of it.
3. Both failures: confirm there is no shared root cause with Cluster A (subject-scalar substitution); these are row/curve quantities not scalar quantities.

Resolution must prove: no-evidence single-hop midline is within 1% of FW closed form (relax the existing 0.01/15% tolerance only after confirming the oracle is what it claims to be); multi-hop latent-upstream window vs cohort `evidence_x` curves diverge across at least the asserted τ count by at least the asserted relative magnitude.

### Cluster D — F-mode pure-projection regression (NEW since 2-May-26)

Failures: 10 (`f_mode_anti_vacuity_local_window_diverges_from_global_aggregate`), 11 (`f_mode_diverges_from_ef_off_frontier_under_drift`).

These are paired anti-tests for the F-mode contract: F is the pure-aggregate-model projection (`p × CDF(τ)`); E+F is the data-conditioned trajectory. Under drift, F at saturation must diverge from E+F at saturation by ≥0.10, and at frontier+10 by ≥0.05. Currently 0.0088 and 0.0126 — F has collapsed back onto E+F.

The test docstring is explicit: "F is tracking the cohort-loop output instead of projecting the aggregate model — the regression class addressed by the F-mode pure-projection fix." This is a known regression class with a known fix that has been undone by the recent refactor. The trajectory engine's reduction to a projector and the substrate's takeover of doc-52 are the two recent changes most likely to have removed the seam where F was being projected from the aggregate model rather than from the cohort-loop conditioning. This requires a `git log` against `forecast_state.py` and the analysis-display chart-builder for `f_curve` / `ef_curve` to identify when the seam was removed and what the prior fix relied on.

Investigation order:
1. `git log -p` against the F-mode projection sites (search for `f_curve`, `ef_curve`, F-mode in `forecast_state.py`, `cohort_forecast_v3.py`, and the analysis-display builders in `src/services/analysisECharts/`). Identify the commit where F was last clearly projecting the aggregate model independently of the cohort loop.
2. Re-derive the F-mode contract against the unified-runtime invariants: F should be a projection of `p_infinity` (the aggregate posterior) times the runtime's subject-span CDF; E+F is the trajectory's per-cohort output. Both should consume `ResolvedCFRuntime` fields, but they must read different fields.
3. Confirm the fmode-drift fixture itself is intact: the docstring warns that if drift was disabled (`synth_gen.py drift_p_to` removed) both lines collapse silently. Run a synthetic verification that the truth file has the drift baked in.

Resolution must prove: F at frontier+10 ≥ 0.05 away from E+F under linear-in-p drift, and saturation gap ≥ 0.10. Both numbers come straight from the test; do not soften.

### Orphan — bayes-vars sidecar promotion failure (CLOSED 4-May-26)

Failure: 9 (`d0_bayes_vars_actually_promotes_to_bayesian`).

Root cause confirmed by diagnostic capture: the `cohort_maturity_v3` BE handler stopped emitting `promoted_source` after the staged-readout deletion pass — the pre-deletion code in `_handle_snapshot_analyze_subjects` set `result['model_curve_params']['promoted_source']` and `result['promoted_source']`, but the cohort-maturity-v3 handler's response builder was reduced to `{ analysis_type, maturity_rows, frames, span_kernel }` plus runtime_provenance. The FE normaliser `normaliseSnapshotCohortMaturityResponse` in `graphComputeClient.ts` then reshapes that into the `AnalysisResult` envelope and does not propagate any source label. The test reader looked for the now-deleted `result.metadata.model_curves[<key>].params.promoted_source` path.

Fix applied:

- `_handle_cohort_maturity_v3` now lifts the resolved source from `_prepared_runtime_v3.resolved_override.source` onto `subject_result['promoted_source']` ([graph-editor/lib/api_handlers.py:1867-1879](graph-editor/lib/api_handlers.py#L1867-L1879)).
- `normaliseSnapshotCohortMaturityResponse` propagates the first per-block `promoted_source` to `result.metadata.promoted_source` ([graph-editor/src/lib/graphComputeClient.ts:627-650](graph-editor/src/lib/graphComputeClient.ts#L627-L650)). This is the same field path the existing chart-hint code in `analysisEChartsService.ts:312` already falls back to when `result.promoted_source` is absent.
- Test reader `_promoted_source_from_cm` updated to read `result.promoted_source` first, then `result.metadata.promoted_source`, dropping the legacy `model_curves` lookup that was deleted post-73n.

Verification: `test_d0_bayes_vars_actually_promotes_to_bayesian` passes; full outside-in suite drops from 11→10 failures with no regressions.

Suite D tests D1/D2/D3/D4 should be re-run after each subsequent cluster lands to confirm they are exercising real analytic-vs-bayesian differences rather than two analytic runs (the previous risk was that the source label was empty so the assertion could pass for both runs trivially). With the field now flowing, that risk is moot — D1/D2 either really compare the two sources or fail.

## Investigation order across clusters

The clusters interact, so investigation order matters:

1. **Orphan (failure 9) first.** Suite D currently passes for unknown reasons. Until the promotion diagnostic is provably round-tripping, every other cluster's diagnostic capture is at risk of misreading source labels. This is also the smallest cluster — likely a single field-name fix.
2. **Cluster A second.** Three failures, single hypothesised root cause, sits squarely in closure stages 4 and 5. Closing it likely resolves failure 6 in Cluster B as a side-effect. Closing it does not require touching the trajectory engine.
3. **Cluster B remainder (failures 4, 5) third.** Once Cluster A is closed and failure 6 is re-checked, what remains in B is purely the completeness-projection unification under invariant N. This is a row/diagnostic projection question, not a primitive-binding question.
4. **Cluster C fourth.** Failures 2 and 3 are independent of A and B. Failure 2 is the cleanest possible probe (no-evidence single-hop midline); failure 3 is the multi-hop window-vs-cohort discriminator. Together they sit on closure stages 3 and 4.
5. **Cluster D last.** F-mode regression. Most likely a single seam to restore, but should be done after A–C so the runtime substrate underneath F is stable; otherwise the F fix may need redoing.

## Acceptance for the suite

The outside-in suite is the public semantic acceptance gate per invariant O. Acceptance for this plan:

- All 11 currently-red tests green at their existing tolerances. Tolerances may be tightened post-closure but must not be loosened.
- The four currently-skipped tests reviewed: each skip rationale verified against the closed clusters; skips removed where the rationale no longer holds, retained where they still apply with the rationale updated to cite the unified-runtime contract rather than 73n implementation Stage 5a/5b/5c/6 routing.
- The one xfail reviewed similarly: either flipped to xpass (and decorator removed) or rationale updated.
- No test asserts staged-readout sentinels, staged eligibility predicates, or 73n implementation Stage 5a/5b/5c/6 diagnostic labels as durable contract — invariant O. Any such assertion must be deleted or rewritten around `ResolvedCFRuntime` provenance.

Suite-level acceptance is not the same as 73n closure. Closure also requires the audit checklist in the invariants doc to pass; the outside-in suite is necessary but not sufficient. This plan is bounded to the suite.

## Doc maintenance after this plan lands

Once each cluster closes, update the cluster's section in this doc with:

- the actual root cause confirmed by diagnostic capture (not the working hypothesis);
- the fix surface (file/symbol against the current tree, not the 2-May tree);
- the invariant letters proven by the fix.

When the suite is fully green, retire 73f formally (move to `docs/archive/`) and mark this doc closed. The 73n stage-9 catalogue can also retire at that point. The unified-runtime invariants doc remains as the durable contract.

## Out of scope

- Any closure work beyond the outside-in suite (audit checklist items not exercised by these 41 tests).
- Codebase-doc reconciliation for the unified runtime — invariants doc explicitly defers this to closure stage 7, after tests settle.
- Bayes-side regression-suite work (`bayes/run_regression.py`, `param_recovery.py`, `test_harness.py`, `stress_*`). These remain gated by the per-job permission rule in CLAUDE.md gate 5.
- FE chart-builder rework beyond what is required to satisfy the F-mode anti-tests (Cluster D) and CLI parity (Cluster B).
