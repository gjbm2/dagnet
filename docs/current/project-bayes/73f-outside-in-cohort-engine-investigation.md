# 73f — Outside-in CLI cohort-engine investigation

**Status**: Active — diagnosis-only, no fixes yet
**Date opened**: 28-Apr-26
**Canonical contract**: [`docs/current/codebase/COHORT_ANALYSIS_NUMERATOR_DENOMINATOR_SEMANTICS.md`](../codebase/COHORT_ANALYSIS_NUMERATOR_DENOMINATOR_SEMANTICS.md) (review pack 1 of 3)

## Purpose

Single working location for the outside-in CLI cohort-engine failures and their diagnosis. Spun out of [73b-final-outstanding.md](73b-final-outstanding.md) §4, §5, §3.7, §3.10, and §8 so the engine-side investigation is managed in one place rather than scattered across the post-73e transport-cleanup punch list.

The 73b doc retains the post-73e transport-cleanup items (§3.1–§3.6, §3.8 PW regression, §3.9 surprise gauge, §7.4–§7.6) and references this doc for engine-side work. The 73e plan ([73e-FE-construction.md](73e-FE-construction.md)) carries a forward note pointing here for the post-73e follow-up.

## Working hypothesis

The outside-in cohort_maturity v3 acceptance suite ([`graph-editor/lib/tests/test_cohort_factorised_outside_in.py`](../../graph-editor/lib/tests/test_cohort_factorised_outside_in.py)) was passing before 73b §3.9 / Decision 13 because the retired `alpha_beta_query_scoped` discriminator's True branch was short-circuiting around real CF arithmetic defects. Post-retirement, every cohort_maturity query runs the full population sweep regardless of evidence quality or analytic-source state. The retired path and its fallbacks were the obfuscating layer; what FE now sees should be much closer to what CLI sees, exposing the actual engine defects rather than the symptom mosaic that was being papered over.

## The acceptance suites

Two carefully-constructed outside-in CLI suites are the load-bearing acceptance gates for cohort_maturity v3. Both live inside the same file — [`graph-editor/lib/tests/test_cohort_factorised_outside_in.py`](../../graph-editor/lib/tests/test_cohort_factorised_outside_in.py) (created 26-Apr-26) — under two distinct sections that the file's docstring names explicitly.

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

**Caveat (per F11)**: every Suite B test compares scalars all of which are CF-conditioned (param-pack runs CF inside `aggregateAndPopulateGraph`). Cross-surface parity at 1e-4 is therefore a *response-shape consistency* check across CF entry paths, not an arithmetic check against an analytic baseline. Pre-Suite-C, the suite did not catch CF arithmetic defects that affected all three CF surfaces uniformly (e.g. F9's window-mode under-shoot on `simple-a-to-b`).

### Suite C — FE/BE parity canaries via `--no-be` (4 tests, added 28-Apr-26)

Doc 73e §8.3 Stage 6's `--no-be` flag suppresses every BE-bound call, leaving `param-pack`'s `p.mean` at FE topo Step 2's `blendedMean = w_e · evidence.mean + (1 − w_e) · forecast.mean`. Without the flag, the same field carries CF's IS-conditioned posterior mean. Suite C runs `param-pack` twice on each query (with and without `--no-be`) and asserts FE/BE parity. **This is the first outside-in arithmetic check that uses an analytic baseline (FE-topo) to pin CF output.**

1. `test_parity_window_mature_high_evidence_p_mean` — sanity / golden-path. Mature window on `simple-a-to-b`.
2. `test_parity_cohort_identity_collapse_p_mean` — `cohort(synth-lat4-c, -90d:)` on c→d. `use_factorised_carrier=False` short-circuit case.
3. `test_parity_subject_equivalent_cohort_anchor_override_p_mean` — `cohort(synth-lat4-b, -90d:)` on c→d. The Group 2 catcher.
4. `test_parity_zero_evidence_cohort_returns_prior` — degenerate one-day cohort window.

Helper change: `_run_param_pack_cached` / `_run_param_pack` extended with `no_be: bool = False` kwarg ([test_cohort_factorised_outside_in.py:213-287](../../graph-editor/lib/tests/test_cohort_factorised_outside_in.py#L213)). Tolerance: `_PARITY_P_MEAN_TOL = 1e-3`. See F8 for the 28-Apr-26 results table and F9–F11 for the analysis.

### Suite D — analytic ↔ bayes source parity canaries via `--bayes-vars` (6 tests, added 28-Apr-26)

Where Suite C pins the FE/BE arithmetic boundary by toggling `--no-be`, Suite D pins the **source axis** by toggling `--bayes-vars`. Each test runs `analyse --type cohort_maturity` twice on the same DSL — once **without** sidecar (analytic source promoted, kappa-derived prior with α+β ≈ 50) and once **with** the matching `bayes/fixtures/<graph>.bayes-vars.json` sidecar (bayesian source promoted, fitted posterior with α+β ≈ 11500). Both runs use full BE/CF.

`analyse` (not `param-pack`) is the surface here because the low-evidence defects manifest at intermediate τ: the asymptote can land near truth while the conditioned median collapses at τ=15-20. Curve-vs-curve comparison via `_numeric_curve(field='midpoint')` catches what a scalar comparison would miss.

1. `test_d0_bayes_vars_actually_promotes_to_bayesian` — sanity guard: without sidecar `promoted_source='analytic'`, with sidecar `promoted_source='bayesian'`. If this fails, the rest of Suite D is meaningless.
2. `test_d1_parity_analytic_vs_bayes_mature_window` — source-axis parity. Mature window on `simple-a-to-b`; analytic and bayes should agree if source selection is not the cause. This does **not** prove CF arithmetic correctness (F14 shows both sources can agree on the wrong raw evidence basis). Asymptote tol 1e-3, curve tol 2e-2.
3. `test_d2_parity_analytic_vs_bayes_identity_collapse_cohort` — source-axis parity. `cohort(simple-b,-90d:)` on b→c (A=X identity); carrier collapses, so source choice should not create material divergence. The run exposed F13/F14 because both sources agreed near the wrong raw-evidence rate.
4. `test_d3_parity_analytic_vs_bayes_zero_evidence_returns_prior` — golden parity. One-day cohort; both → respective prior. Asymptote tol 5e-3 (kappa-vs-fit drift at source).
5. `test_d4_parity_analytic_vs_bayes_low_evidence_cohort_F1_signature` — currently named for F1, but now best understood as an F14/F1-sensitive parity canary (**xfail strict**). Same DSL as Group 3. Currently fails because invalid under-matured evidence moves the small analytic prior much more than the large bayes prior. Passes when the general evidence-binding defect is fixed; strict marker fires as the closure signal.
6. `test_d5_anti_parity_analytic_vs_bayes_low_evidence_cohort_F1_pinned` — currently named for F1, but now best understood as the anti-parity twin of D4. Asserts the two surfaces *do* diverge by ≥ 30% on the Group 3 query. Currently passes; fails when F14/F1-sensitive divergence is removed and both surfaces converge.

D4 + D5 together are a two-angle low-evidence source-sensitivity detector: D4's xfail-strict trips on convergence; D5's anti-parity trips on convergence. A single trip without the other indicates D0 should be re-checked (sidecar may have stopped taking effect). Helper additions: `_bayes_vars_path`, `_promoted_source_from_cm`, `_max_pointwise_relative_diff` ([test_cohort_factorised_outside_in.py](../../graph-editor/lib/tests/test_cohort_factorised_outside_in.py)). Constants: `_SOURCE_PARITY_TOL = 1e-3`, `_ZERO_EVIDENCE_PARITY_TOL = 5e-3`, `_F1_DIVERGENCE_FLOOR = 0.30` (name retained in tests for now, but semantically this is now F14/F1 sensitivity).

Coverage limitation: only `synth-simple-abc` has a sidecar at `bayes/fixtures/`. `synth-lat4` does not, so Group 2's anchor-override case (`cohort(synth-lat4-b,-90d:)` on c→d) is not yet directly testable in Suite D. When a synth-lat4 sidecar is generated (independently), an analogous Group-2-class test becomes possible.

Open caveat: [model_resolver.py:487-491](../../graph-editor/lib/runner/model_resolver.py#L487) reads `posterior_block.get('cohort_n_effective')` / `window_n_effective`, but the sidecar's slice carries plain `n_effective`. If `bayesPatchService` does not translate this on projection, bayesian promotion can succeed (rhat/ess gate passes) while `n_effective` remains None on the resolved object — silently making the bayes path behave like analytic on the doc-52 blend specifically. D0 only checks `promoted_source` text and would miss this. Strengthen D0 later to assert the resolved source mass fields, not just the promoted source label.

Four suites are now the primary signal for whether the live cohort_maturity v3 path is healthy end-to-end. Other outside-in files (v2/v3 parity, multi-hop evidence parity, doc-56 cross-consumer agreement, cf-truth-parity, etc.) are useful but secondary to these four.

## Test results

### 28-Apr-26 baseline (post-73b §3.9, pre-73e merge)

Ran `pytest graph-editor/lib/tests/test_cohort_factorised_outside_in.py -v` through the daemon against the live Python BE and snapshot DB. **10 failed, 13 passed in 6 min 37 s.**

Suite A (semantic correctness, 13 parametrised entries): 5 fail / 8 pass. Suite B (param-pack ↔ cohort-analysis-v3 parity, 10 parametrised entries): 5 fail / 5 pass.

The ten failures fall into three shapes that almost certainly correspond to fewer than three underlying defects.

#### Group 1 — small drift (~4e-4) on cohort ↔ window asymptote convergence

Subject-equivalent cohort and window queries should converge to the same `p_infinity_mean` to 1e-6 (tighter where graph fixtures support it). They are drifting by ~4.7e-4 on synth-lat4. The same 4.7e-4 number appears across multiple tests, which is consistent with one drift source.

- `test_single_hop_non_latent_upstream_collapses_to_window[fast]` — `model_midpoint` diff 4.2e-4 at τ=1 vs tol 1e-9.
- `test_single_hop_latent_upstream_lags_window_but_converges_to_same_subject_p` — window=0.4944, cohort=0.4949, delta 4.7e-4 vs tol 1e-6.
- `test_cohort_and_window_p_infinity_converge_for_same_subject_rate[synth-lat4 (-1d:)]` — same 4.7e-4.
- `test_cli_identity_collapse_matches_window_across_public_surfaces` — pack `p.mean`=0.6406 vs cm last-row=0.6402, delta 4.4e-4 vs tol 1e-4.

Plausibly explained by conditioning that previously did not run now running uniformly under the Decision-13 sweep path. If so, the right move is to relax these tolerances (and write down *why*), not chase the arithmetic.

#### Group 2 — large (~12–18%) anchor-depth divergence on synth-lat4 c→d

The anchor-depth invariant says window, identity-A=X, near-anchor B, far-anchor A all converge to the same subject `p_infinity` (the four queries are subject-equivalent — the same edge under different anchors). They don't. The `cohort(synth-lat4-b, -90d:)` arm sits ~12% below the others. Same 0.66 → 0.52 number recurs in three tests.

- `test_anchor_depth_monotonicity_for_same_subject` — p_values spread max 0.6640, min 0.5217 = 0.142 absolute.
- `test_cohort_frame_evidence_does_not_retarget_carrier_or_subject` — identical 0.66 → 0.52 numbers.
- `test_cohort_and_window_p_infinity_converge_for_same_subject_rate[synth-lat4 (-90d:) cohort(synth-lat4-b)]` — window=0.640, cohort=0.522, delta 0.118.
- `test_cli_single_hop_downstream_cohort_parity_and_admitted_provenance` — completeness_delta 0.036 below the 0.05 lower bound (cohort anchor override under-shifts completeness).

This is **not** a tolerance issue. The cohort anchor override is producing materially different subject `p_infinity` than window for the same edge. This is the closest test-level analogue to the funnel symptom on the live app and is the most likely real engine defect of the three groups.

#### Group 3 — low-evidence cohort drifts ~60% from the factorised oracle

On `synth-simple-abc b→c` with `cohort(1-Mar-26:3-Mar-26).asat(3-Mar-26)` (very low evidence, 2-day cohort range), the live curve undershoots the factorised CDF/PDF oracle from `bayes/truth/synth-simple-abc.truth.yaml`. At τ=16 actual=0.0149 vs oracle=0.0421 (64.6% relative under). Drift grows monotonically through τ=20.

- `test_low_evidence_cohort_matches_factorised_convolution_oracle`
- `test_low_evidence_single_hop_remains_near_unconditioned_oracle`

This subsumes the older "two BE regressions" framing in [73b-final-outstanding §2](73b-final-outstanding.md) — same tests, now contextualised against an oracle gap rather than against a within-engine baseline. Real engine defect; not tolerance.

#### Headline interpretation

Group 1 is plausibly tolerance / new-conditioning behaviour and may be acceptable after relaxing tolerances and documenting why. Groups 2 and 3 are real semantic regressions that the prior `analytic_degraded` shortcut was likely masking.

#### Triage hint via 73e Stage 6 `--no-be` (28-Apr-26)

73e Stage 6 added a `--no-be` flag (FE: `FetchOptions.skipBackendCalls`; runner-analyze surface: `BackendCallsSkippedError`) that suppresses every BE-bound call in a run. Re-running `cli analyse` under the flag distinguishes BE arithmetic divergence (CF, snapshot DB queries, runner-analyze outputs) from upstream FE-only divergence:

- For Group 1 (small ~4e-4 drift): `--no-be` is not a useful triage tool here because the affected analyses are runner-analyze types that fail-fast under the flag. These are tolerance / new-conditioning issues, not arithmetic.
- For Group 2 (anchor-depth divergence on synth-lat4 c→d): same — runner-analyze types short-circuit under the flag. Triage requires a CF-specific bisect rather than a wholesale BE suppression.
- For Group 3 (low-evidence cohort drift on synth-simple-abc b→c): the failing scalar in the param-pack-style assertion (`p.mean` undershoot) collapses to `evidence.k/n` under `--no-be`, which is the unconditioned average and matches the factorised oracle reference at τ=∞ within tolerance. The conditional-engine drift visible at τ=16 is genuinely a CF arithmetic issue. This pins Group 3 to CF and is the same root cause as the [§3.7 abBcSmoothLag undershoot](73b-final-outstanding.md#37-fe-e2e-parity-echo-abbcsmoothlag-blended-reach-undershoot).

Net: `--no-be` confirms §3.7 + Group 3 are the same defect — CF-side conditioning under low-evidence cohorts. Groups 1 and 2 are unaddressed by the flag and need separate triage.

### 28-Apr-26 post-73e re-run

Re-ran `pytest graph-editor/lib/tests/test_cohort_factorised_outside_in.py -v` after all 8 stages of 73e merged. **12 failed, 11 passed in 2 min 37 s** (faster than the 6 min 37 s baseline run, almost certainly because the daemon and BE caches were warm).

Delta vs the 10 fail / 13 pass baseline:

- All 10 baseline failures still fail. 73e is transport cleanup; it was not expected to move engine arithmetic, and it didn't.
- **2 new failures** appeared, both inside Suite B's parity canaries:
  - `test_cli_window_single_edge_scalar_identity_across_public_surfaces` — `from(simple-a).to(simple-b).window(-90d:)`: pack `p.mean = 0.545800` vs CF `p_mean = 0.546332`, delta **5.3e-4** vs tolerance 1e-4. Was previously passing; this is a Group 1-shape drift on a fixture that was previously below tolerance.
  - `test_cli_projection_parity_uses_last_row_saturation_not_arbitrary_tau_curve_point` — `synth-lat4-c→d` cohort: pack `p.mean = 0.5217` vs `cm last-row p_infinity_mean = 0.522247`, delta **5.5e-4** vs tolerance 1e-4. Was previously passing; same numbers as the Group 2 anchor-depth pair, suggesting it has been pulled across the tolerance threshold by post-73e prep changes.
- Group magnitudes within already-failing tests:
  - Group 1 latent-upstream pair: was 4.7e-4 → now **6.2e-4** (slightly worse but still small-drift).
  - Group 1 `cli_identity_collapse_matches_window`: was 4.4e-4 → now **4.79e-3** (10× worse — promoted into Group 2 territory).
  - Group 2 anchor-depth on synth-lat4 c→d: 0.66 → 0.52 spread unchanged.
  - Group 2 `cohort_and_window_p_infinity_converge` (-90d:): was 0.118 → now **0.123** (marginally worse).
  - Group 3 low-evidence cohort: τ=16 was 64.6% relative → now **68.6%** (~3pp worse), curve still drifting through τ=20.

**Interpretation.** 73e introduced no engine-side fixes. The 2 new failures and the slightly larger Group 1 deltas are consistent with the Stage 5 item 7 change — graph-bearing custom recipes are now uniformly re-materialised (FE topo + projection refresh) rather than replayed from captured numbers. This shifts intermediate values by O(1e-4) for fixtures whose previous parity rested on FE-topo-equivalent captured scalars, pushing two formerly-passing tests across their 1e-4 tolerance. None of the Group 1 deltas are large enough to indicate a new arithmetic defect; the `cli_identity_collapse` 10× jump is the only one that warrants closer inspection.

### 28-Apr-26 post F2+F6 cleanup + posterior-strict-clear re-run (working-tree, uncommitted)

Re-ran `pytest graph-editor/lib/tests/test_cohort_factorised_outside_in.py -v` after the live workstream changes had been applied but not yet committed:

- **F2 dead-code removal** in `cohort_forecast_v3.py` (−348 lines), `forecast_runtime.py` (−26 lines), and `api_handlers.py` (−2 lines): `_query_scoped_latency_rows`, `is_cf_sweep_eligible`, the `sweep_eligible` bundle field, and all callsites deleted.
- **F6 resolver routing** for `read_edge_cohort_params` (in `forecast_runtime.py`): now delegates to `resolve_model_params(scope='path', temporal_mode='cohort')` instead of reading posterior fields directly.
- **73b §7.5 strict-clear** in `posteriorSliceContexting.ts`: when a parameter file carries no posterior slices the existing edge `posterior` projection is now wiped (was: left as a no-op).

**13 failed, 19 passed, 1 xfailed in 150.14 s** (2 m 30 s). Daemon was fresh (pid age ≤ 80 s during slow-call diagnostics). Compared with F8 (Suite C run, 28-Apr-26 earlier) and F12 (Suite D run, 28-Apr-26 earlier), the picture has shifted in three ways that are not minor. The shifts are recorded as observations; the mechanisms below are working hypotheses pending source-level confirmation.

#### Shift 1 — Suite C all four parity tests now PASS

Suite C in F8 had four failures with FE-only ↔ Full BE deltas of 0.15, 0.15, 0.29, 0.002. In the fresh run all four pass:

| Test | F8 FE-only | F8 Full BE | F8 Δ | Fresh result |
|---|---|---|---|---|
| `test_parity_window_mature_high_evidence_p_mean` | 0.6985 | 0.5458 | 0.1527 | **PASS** |
| `test_parity_cohort_identity_collapse_p_mean` | 0.8105 | 0.6640 | 0.1465 | **PASS** |
| `test_parity_subject_equivalent_cohort_anchor_override_p_mean` | 0.8105 | 0.5217 | 0.2888 | **PASS** |
| `test_parity_zero_evidence_cohort_returns_prior` | 0.6031 | 0.6013 | 0.0018 | **PASS** |

#### Shift 2 — Suite B pack-vs-CF deltas have jumped ~300× into the 0.15–0.29 band

The same fixtures that Suite C now treats as parity-clean produce Suite B pack-vs-CF deltas that look like Suite C's old FE-vs-BE deltas:

| Suite B test | Pack `p.mean` | CF `p_mean` | Δ | Post-73e Δ |
|---|---|---|---|---|
| `test_cli_window_single_edge_scalar_identity_across_public_surfaces` | 0.6985 | 0.5463 | **0.1522** | 5.3e-4 |
| `test_cli_identity_collapse_matches_window_across_public_surfaces` | 0.8105 | 0.6454 | **0.1651** | 4.79e-3 |
| `test_cli_single_hop_downstream_cohort_parity_and_admitted_provenance` | 0.8105 | 0.5222 | **0.2883** | new (was passing in baseline) |
| `test_cli_projection_parity_uses_last_row_saturation_not_arbitrary_tau_curve_point` | 0.8105 | 0.5222 | **0.2883** | 5.5e-4 |

Reading Shifts 1 + 2 together: `param-pack p.mean` on these queries now matches the FE-topo `blendedMean` value (0.6985 / 0.8105) rather than the CF posterior pin (0.5458 / 0.6454 / 0.5222 — close to the F14 raw `k/n` numbers). `cohort_maturity p_infinity_mean` and `conditioned_forecast p_mean` still report the CF-pinned scalars within ~5e-4 of their pre-cleanup values, so the F14 mechanism is intact at those surfaces — only `param-pack`'s scalar appears to have changed source. **Working hypothesis (unconfirmed at source): pack now writes FE-topo's `blendedMean` into `p.mean` regardless of whether the BE call ran, so the with-`--no-be` and without-`--no-be` runs converge.** The `posteriorSliceContexting.ts` strict-clear above is the most likely upstream cause — when no posterior slices are present, the projected `pBlock.posterior` is wiped, removing the surface that pack's promotion logic previously read CF results from. That hypothesis has not yet been verified by reading the pack scalar-selection code.

Implication for F11: with pack reading FE-topo regardless of `--no-be`, Suite C's parity is satisfied trivially and **the suite no longer functions as the FE-vs-CF arithmetic baseline check** that F11 / F8 relied on. F14's confirmed undershoot mechanism is still alive — it is just no longer visible at the `param-pack p.mean` surface. F14's diagnostic evidence still holds: CF on `simple-a→b.window(-90d:)` returns ~0.5458, exactly the raw `k/n = 144516/265035` ratio. The CF-vs-truth gaps documented in F9 (window 0.15 under) and F13 (identity-collapse cohort 0.30 under) remain visible at Suite B (pack-vs-CF mismatch on the same numbers F14 anchors), Suite A oracle assertions, and Suite D D2 (still failing marginally at the same numbers).

#### Shift 3 — Group 3 low-evidence cohort trajectory flipped sign and grew ~13×

`test_low_evidence_cohort_matches_factorised_convolution_oracle` — same DSL, same oracle. Reading at τ=16:

| Run | actual | oracle | rel diff | direction |
|---|---|---|---|---|
| baseline | 0.0149 | 0.0421 | 64.6% | under |
| post-73e | (similar undershoot, ~68.6%) | 0.0421 | 68.6% | under |
| post F2+F6 + strict-clear | 0.1949 | 0.0421 | 362.9% | **over** |

`test_low_evidence_single_hop_remains_near_unconditioned_oracle` similarly trips at τ=15 with actual=0.1704 vs expected=0.0285 (497.2% over). The trajectory defect did not shrink — it inverted, and the τ-row actuals rose roughly 13× (from O(0.015) to O(0.17)) on the failing rows.

Note: this is a **trajectory** shift (per-τ midpoint values from `compute_forecast_trajectory.rate_draws`), not an asymptote shift. F14's evidence-binding mechanism explains the asymptote pin (`p∞ → raw k/n`), and the asymptote numbers in this run are essentially unchanged from F8 / F12 (window-edge `p_mean ≈ 0.5463`, identity-collapse cohort `p_mean ≈ 0.422`, anchor-override cohort `p_infinity_mean ≈ 0.5222` — all within ~5e-4 of their pre-cleanup values). What has changed is the **shape** of the trajectory at intermediate τ on `synth-simple-abc`: the row outputs at τ=15…20 now sit far above the factorised oracle rather than far below it.

Working hypothesis (unconfirmed at source): F6's switch to `resolve_model_params(temporal_mode='cohort')` plus the strict-clear of `pBlock.posterior` together change which carrier α/β feeds the upstream-carrier construction on `synth-simple-abc` (the fixture's parameter file has no posterior block, so the strict-clear leaves the resolver to find α/β through analytic-mirror or kappa fallback). A different upstream carrier shape changes the per-τ projection of `obs_x` / `obs_y` and shifts the `rate_draws` trajectory. The asymptote pin is set by the binomial pull on the IS log-weight regardless (F14), so it stays at raw `k/n`; only the path between prior and pin moves. Group 2's synth-lat4 anchor-override numbers are essentially unchanged, consistent with that fixture having a different carrier-fallback profile (synth-lat4 b→c carries posterior structure that synth-simple-abc b→c does not).

#### Shifts that did NOT happen

- Group 1 small drifts: 4.23e-4, 6.23e-4 — within ~5e-5 of the post-73e numbers.
- Group 2 anchor-depth on synth-lat4 c→d: spread 0.66 → 0.52 = 0.137 (was 0.142 in baseline, 0.142 post-73e). Marginal narrowing of ~5e-3.
- Suite D D0/D1/D3/D4/D5: identical pass/xfail status. D2 still marginally fails at delta=0.001264 (identical to F12 to 6 sig figs). The D4↔D5 lockstep is unchanged: **F1/F14 still alive on the bayes-vars axis.**
- F14 asymptote pin: CF `p_mean` on `simple-a→b.window(-90d:)` is 0.5463 in this run vs 0.5458 in F14's diag — the raw-`k/n` pin survives the cleanup unchanged.

#### Headline interpretation

The F2 cleanup is harmless (it deletes dead code that the runtime never reached). The F6 + strict-clear cleanups have **not** changed the dominant arithmetic defect — F14's raw-`k/n` pin on the asymptote is intact across every CF-bearing surface that still exposes the CF result. They have changed two things downstream of that pin:

- the trajectory shape on `synth-simple-abc` (Group 3 inversion / Shift 3) — most likely a carrier-projection consequence of the resolver-routed `read_edge_cohort_params` on a fixture without a posterior block;
- (apparently) which scalar `param-pack` exposes as `p.mean` (Shifts 1 + 2) — most likely a consequence of the strict-clear leaving no `pBlock.posterior` for pack's scalar promotion to read CF results from.

Suite C's loss of its arithmetic-baseline role is the most consequential bookkeeping change: F11's "first outside-in arithmetic-correctness check that uses an analytic baseline (FE-topo) to pin CF's IS-conditioned output" no longer holds, because pack and CF are reading from different fields under the new pack wiring. Two viable rebuilds: (i) pack writes back the CF posterior mean as before (so Suite C catches FE/CF divergence again), or (ii) Suite C's reference moves from `param-pack p.mean` to `cohort_maturity` / `conditioned_forecast` directly with `--no-be` semantics applied at those surfaces — which would require the `--no-be` flag to be honoured by runner-analyze rather than fail-fast as it does today (per F8's triage hint).

F14 remains the priority workplan item. Once the maturity-aware evidence binding lands, the asymptote should move from raw `k/n` toward truth on Suites C C1 / D D2 / Group 3, and the trajectory shape on Group 3 should re-converge whether its current overshoot is a carrier-projection consequence or its own residual.

## Diagnostic findings

Every claim below is verified at the cited file:line. Source-inspection only; no test reruns beyond the two captured above.

### F1 — Reach-scaled evidence counts feeding the IS log-weight (working hypothesis for Groups 2 and 3)

Latency-edge `p_infinity_mean` is produced by the sweep, not by `_non_latency_rows`. For latency edges (synth-lat4 c→d has σ=0.50; synth-simple-abc b→c has σ=0.60), the scalar comes from [cohort_forecast_v3.py:1541](../../graph-editor/lib/runner/cohort_forecast_v3.py#L1541) — `np.median(_asymp_draws)` on `sweep.rate_draws[:, _sat_tau]`. The sweep itself is `compute_forecast_trajectory` invoked at [cohort_forecast_v3.py:1454](../../graph-editor/lib/runner/cohort_forecast_v3.py#L1454), fed by the `engine_cohorts` produced by `build_cohort_evidence_from_frames`. `_non_latency_rows` ([cohort_forecast_v3.py:69](../../graph-editor/lib/runner/cohort_forecast_v3.py#L69)) is the Class B (non-latency-edge) builder and is **not** on the path that produces these failures.

The asymmetry between `window(c→d)` and `cohort(synth-lat4-b, c→d)` enters at the gate at [cohort_forecast_v3.py:953-959](../../graph-editor/lib/runner/cohort_forecast_v3.py#L953):

`use_factorised_carrier = (not is_window) and x_provider.enabled and reach > 0 and upstream_path_cdf_arr is not None`

For window queries this gate is False and the carrier-materialisation block is skipped. For `cohort(b, c→d)` it is True, so the per-cohort `obs_x` is re-projected onto the upstream b→c carrier CDF at [cohort_forecast_v3.py:1019-1057](../../graph-editor/lib/runner/cohort_forecast_v3.py#L1019):

```
projected_x[t] = a_pop * carrier_reach * carrier_cdf[t]
```

with `obs_y[t]` derived by convolving arrival increments against the subject-side ratio curve. Both `obs_x` and `obs_y` are scaled by `carrier_reach` (≈0.5 for synth-lat4 b→c with truth p=0.50). The y/x **ratio** is therefore invariant to the reach scaling — but the absolute **observation counts** that flow downstream are not.

The bias enters via the IS reweighting in the sweep at [forecast_state.py:1149-1173](../../graph-editor/lib/runner/forecast_state.py#L1149):

```
log_w_i = k_i * log(p_i_clip) + _E_fail * log(1 - p_i_clip)
```

`k_i` and `_E_fail = E_eff - k_i` are interpreted as observation counts (binomial log-likelihood). When these counts are reach-scaled to ~50% of the raw cohort counts, the IS-conditioned posterior weights the prior more heavily relative to the evidence than the window path does, biasing `p_infinity_mean` away from the window result by an amount that depends on `prior_strength / effective_evidence_count`. The `_compute_blend_params` mass at [forecast_state.py:1020-1042](../../graph-editor/lib/runner/forecast_state.py#L1020) inherits the same scaling: `r = m_S / n_effective` uses reach-scaled `m_S = sum_x` ([cohort_forecast_v3.py:451](../../graph-editor/lib/runner/cohort_forecast_v3.py#L451)), so the blend ratio is shifted as well.

This explains why the under-shift is largest for `cohort(b, c→d)` (one upstream hop, reach≈0.5) and small or absent for `cohort(c, c→d)` (zero upstream hops, identity carrier, reach≈1) and `cohort(a, c→d)` (deeper anchor where compound reach can approach 1 again). The pre-Stage-6 `alpha_beta_query_scoped` True-branch shortcut bypassed this code path for analytic sources, which is why the defect was previously masked.

**Why this manifests as Group 3 on synth-simple-abc.** The same code path with two differences:

- The cohort range is 2 days rather than 90 days, so raw `N_i` is small and the reach-scaling effect on prior:evidence ratio is more severe.
- Frontier ages span (0, 1, 2) — the test oracle integrates over all three; the engine binds evidence per-cohort with `frontier_age = a_i` from [cohort_forecast_v3.py:990, 1080](../../graph-editor/lib/runner/cohort_forecast_v3.py#L990).

The IS gate at [forecast_state.py:1152](../../graph-editor/lib/runner/forecast_state.py#L1152) — `if E_eff > 0 and a_i > 0 and _E_fail >= 1.0` — fires inconsistently for these ultra-sparse cohorts. When it does fire, the SMC mutation kernel at [forecast_state.py:1167-1171](../../graph-editor/lib/runner/forecast_state.py#L1167) re-explores around the empirical k/E rate, dragging the rate_draws curve below the unconditioned prior at intermediate τ. The blend at [forecast_state.py:1671](../../graph-editor/lib/runner/forecast_state.py#L1671) cannot fully compensate because `r = m_S / n_effective` with reach-scaled `m_S` is small (sparse evidence × low reach × low n_effective) so the conditioned pass dominates.

**Status**: working hypothesis with file:line evidence. The 60% under at τ=16 (Group 3) and the 12–18% under (Group 2) are two amplitudes of the same evidence-count-scaling defect, with sparse evidence × low reach amplifying it on the synth-simple-abc fixture.

**Caveat needing live confirmation**: the hypothesis says `k_i` / `_E_fail` are reach-scaled when they enter the IS log-weight. Source inspection gives a strong but indirect chain (`obs_x` is reach-scaled; `obs_x` feeds the per-cohort `evidence` tuples; the IS loop reads `(tau_i, n_i, k_i)` from those tuples). Direct instrumentation at [forecast_state.py:730](../../graph-editor/lib/runner/forecast_state.py#L730) capturing `(n_i, k_i)` for the failing run is the cheapest way to convert hypothesis into proof.

**Recommended fix direction (no fix taken yet)**: either pass un-reach-scaled `k_i` / `N_i` into the IS log-weight while keeping the reach-projected `obs_x` for the sweep's arrival-shape role, or scale the prior strength up by `1/carrier_reach` so the prior:evidence ratio is reach-invariant. Both options touch `compute_forecast_trajectory` and the per-cohort evidence binding inside it.

### F2 — deterministic-prior dispatch removed; shared sweep is the only latency-edge path

Evidence:
- `get_cf_mode_and_reason` is unconditional `('sweep', None)`.
- `is_cf_sweep_eligible`, the `sweep_eligible` bundle field, `_query_scoped_latency_rows`, and the `if not _sweep_eligible:` branch have been removed from the live code path.
- The retired deterministic route used prior α/β with the deterministic latency CDF and no shared sweep. It is no longer an implementation option.

This makes the structural Decision-13 outcome explicit: every latency-edge cohort_maturity query, regardless of evidence quality or analytic-source state, runs the shared population sweep. The "low evidence and short horizon → use the prior with the deterministic CDF" route that previously produced oracle-correct numbers for cases like the failing test no longer exists.

**Decision for this investigation**: do **not** re-introduce a separate deterministic-prior dispatch route. It adds another branch and is only semantically clean in a narrow set of cases: no admissible subject conditioning evidence, no admissible upstream carrier observation evidence, and valid priors for every required carrier / subject object. Instead, the full sweep must naturally degenerate to the unconditioned model projection when there is genuinely no admissible evidence. If the sweep is noisy or biased in that limit, fix the degeneration inside the shared sweep rather than masking it with a parallel route.

### F3 — Outside-in tests run on analytic source, not bayes posterior

Per the canonical doc's "subject-side reuse rule" ([COHORT_ANALYSIS_NUMERATOR_DENOMINATOR_SEMANTICS.md lines 381-403](../codebase/COHORT_ANALYSIS_NUMERATOR_DENOMINATOR_SEMANTICS.md)), bayesian posterior projection is the principled source for X→end subject behaviour. The test decorator `@requires_synth(_SIMPLE, enriched=True)` reads as "fixture should carry commissioned posteriors".

Evidence:
- [synth-simple-abc-simple-b-to-c.yaml](../../nous-conversion/parameters/synth-simple-abc-simple-b-to-c.yaml) carries only `values:` (raw evidence), `latency:`, and `metadata:` blocks. No `posterior:` block. No `model_vars:` block.
- CLI YAML output reports `promoted_source: analytic` for the failing edge.
- [model_resolver.py:486-506](../../graph-editor/lib/runner/model_resolver.py#L486) reads `n_effective` from the bayesian posterior block when `promoted_source == 'bayesian'`; falls back to `_src.get('prob_*_n_effective')` for analytic. The synth fixture's analytic source layer doesn't carry these fields.

**Status**: evidence-backed factual observation. Whether it is itself a defect or simply means "this fixture wasn't bayes-commissioned" needs a separate decision (does `enriched=True` formally require posterior data, or is it a convention?).

**Implication for diagnosis**: every cohort assertion in the outside-in suite that passed prior to 73b §3.9 retirement was passing under the analytic-source path with the `alpha_beta_query_scoped` discriminator's True branch active. Post-retirement that path is gone (see F2). This puts the suite under stronger pressure than the pre-retirement code ever exercised.

### F4 — Group 1 + post-73e ~1e-4 drifts: two independent sources

**Source A (Stage 6 / `alpha_beta_query_scoped` retirement).** [model_resolver.py:104](../../graph-editor/lib/runner/model_resolver.py#L104) returns `False` unconditionally; the docstring at [model_resolver.py:95-102](../../graph-editor/lib/runner/model_resolver.py#L95) confirms this is the post-Decision-13 contract. The pre-retirement True branch's conjugate-update short-circuit no longer fires; `_non_latency_rows` ([cohort_forecast_v3.py:114-161](../../graph-editor/lib/runner/cohort_forecast_v3.py#L114)) and the sweep's blend at [forecast_state.py:1671](../../graph-editor/lib/runner/forecast_state.py#L1671) now run uniformly even on no-evidence / subject-equivalent queries. Result: a small posterior shift on every test that previously rested on the True-branch shortcut.

**Source B (73e Stage 5 item 7).** `paramPack` runs `aggregateAndPopulateGraph` ([paramPack.ts:125](../../graph-editor/src/cli/commands/paramPack.ts#L125)), whose comment at [paramPack.ts:134-138](../../graph-editor/src/cli/commands/paramPack.ts#L134) records that FE topo, BE topo, CF, promotion, and UpdateManager all run inside that call. `analyse` runs the same `aggregateAndPopulateGraph` ([analyse.ts:204](../../graph-editor/src/cli/commands/analyse.ts#L204)) **then additionally** calls `prepareAnalysisComputeInputs` ([analyse.ts:263](../../graph-editor/src/cli/commands/analyse.ts#L263)), which in turn invokes `runScenarioMaterialisation` ([analysisComputePreparationService.ts:87-119](../../graph-editor/src/services/analysisComputePreparationService.ts#L87)) — Stage 4(a) `recontextScenarioGraph` plus Stage 5 item 7 `materialiseScenarioFeTopo`. So `analyse` runs an extra recontext + FE-topo pass that pack does not. The pre-Stage-5-item-7 baseline had pack and analyse converging on FE-topo-equivalent captured scalars; the new pass shifts intermediate values by O(1e-4) for fixtures whose previous parity rested on that equivalence.

The 10× spike on `cli_identity_collapse` (4.4e-4 → 4.79e-3 post-73e) is harder to attribute to either source alone. That test is `cohort(synth-lat4-c, c→d)` — the identity-collapse case — and the spike's appearance only post-73e suggests Source B's extra materialisation pass intersecting with the broader CF evidence-binding defect. Worth bisecting before tolerance-relaxing: if fixing F14 (and any residual F1 work) also brings this back inside 1e-4, the 10× jump was an echo of the same engine defect amplified by the materialisation pass.

**Recommended fix direction (no fix taken yet)**: tolerance-relax the four steady ~4e-4 drifts in `test_cohort_factorised_outside_in.py:62` (`_P_MEAN_ABS_TOL` and the 1e-9 / 1e-6 inline tolerances) with a comment naming Sources A and B, but only after F14 and any residual F1 work are classified — to confirm the 10× spike on `cli_identity_collapse` collapses back. If it does, no further alignment is needed; if it doesn't, route param-pack through `runScenarioMaterialisation` as well so both surfaces produce the same materialised state.

### F5 — `n_effective` missing → blend skips (dispersion only, ruled out as catastrophe)

Evidence:
- [forecast_state.py:1020-1042](../../graph-editor/lib/runner/forecast_state.py#L1020) `_compute_blend_params` returns `applied: False, skip_reason: 'n_effective_missing'` when `getattr(resolved, 'n_effective', None) is None`.
- CLI diagnostic (cohort_maturity row metadata): `m_S: 0.00227, m_G: null, skip_reason: n_effective_missing`. The blend in [forecast_state.py:802-817](../../graph-editor/lib/runner/forecast_state.py#L802) does not run.

**Status**: evidence-backed. On its own this is a dispersion-only effect (`p_draws` mix vs `p_draws_unconditioned` mix). It cannot explain a 60-70% median collapse. **Logged for traceability but ruled out as the catastrophe mechanism.** If the F14 fix requires corrected source-mass blending, this finding may resolve incidentally because `n_effective` would be needed for the corrected blend ratio.

### F6 — `read_edge_cohort_params` resolver bypass removed

Original finding: `read_edge_cohort_params` read `p.posterior.cohort_alpha/beta` → `p.posterior.alpha/beta` → `p.forecast.mean` directly without `resolve_model_params`. This function feeds `build_x_provider_from_graph` and then `build_upstream_carrier`, so a divergence between this bypass and the shared resolver's analytic-mirror / kappa-fallback view of the upstream carrier shape could itself produce a different `carrier_reach` or `upstream_path_cdf_arr` than the rest of the engine assumes.

**Status: v3 path fixed (28-Apr-26), pending full outside-in re-run.** [forecast_runtime.py:728-796](../../graph-editor/lib/runner/forecast_runtime.py#L728) `read_edge_cohort_params` now delegates to `resolve_model_params(edge, scope='path', temporal_mode='cohort')` and maps the resolved object's fields onto the existing `{p, mu, sigma, onset, alpha, beta, mu_sd, sigma_sd, onset_sd, p_sd}` return shape. Carrier construction now sees the same promoted source, quality gates, and fallback behaviour as the rest of the engine. Two unconditional `[v3-debug]` `print` statements that the previous body left in were removed at the same time.

**Scope limit**: only the v3 reproduction in `forecast_runtime.py` was touched. The v1 copy at [cohort_forecast.py:224](../../graph-editor/lib/runner/cohort_forecast.py#L224) (still imported by `api_handlers.py` for legacy v1 paths) is unchanged and retains the bypass; it can be removed in a follow-up once v1 deprecation is in scope.

**Dependency on F15.** With F15's hardening live in `model_resolver.py` ([model_resolver.py:459-498](../../graph-editor/lib/runner/model_resolver.py#L459)) — kappa=200 fabricated prior replaced with `ValueError` when evidence is present but `model_vars[analytic].probability` is missing — the F6 delegation is correct on production graphs (FE-topo Step 1 populates the model_vars block) but trips the same `ValueError` on minimal unit-test fixtures that don't carry `model_vars`. The pre-existing 18 unit-test failures from F15 are not caused by F6 — the same fixtures fail at `forecast_state.py:313 / _resolve_edge_p` which calls `resolve_model_params` directly. F6 simply expands the surface area where F15's contract applies. Fixture updates to add `model_vars[analytic].probability` to evidence-bearing test edges are required before either F6 or F15 stop tripping unit tests.

This removes F6 as a likely first-order cause of Group 2. Re-test Group 2 after F14 lands; if a residual anchor-depth under-shift remains, return to F1's reach-scaled count hypothesis.

(Originally tracked as [73b-final-outstanding §7.3](73b-final-outstanding.md#73-read_edge_cohort_params-bypasses-the-shared-resolver). Reproduced here for working-doc completeness.)

### F7 — Mapping to canonical doc abstractions

Per [COHORT_ANALYSIS_NUMERATOR_DENOMINATOR_SEMANTICS.md lines 449-479](../codebase/COHORT_ANALYSIS_NUMERATOR_DENOMINATOR_SEMANTICS.md) (general abstraction points), the implementation should expose:

1. `population_root` — selected population definition
2. `carrier_to_x` — denominator-side A→X object
3. `subject_span` — numerator-side X→end object
4. `numerator_representation` — factorised vs gross-fitted
5. `admission_policy` — reuse rule

[forecast_runtime.py:137,203,297,501](../../graph-editor/lib/runner/forecast_runtime.py#L137) and the bundle construction in [cohort_forecast_v3.py:1196-1294](../../graph-editor/lib/runner/cohort_forecast_v3.py#L1196) confirm that `PreparedForecastRuntimeBundle` does carry `carrier_to_x`, `numerator_representation` (set to `'factorised'` at L1216), `p_conditioning_evidence`, etc. The skeleton matches the doc's abstractions. Whether each object is **populated correctly** for a single-hop A≠X cohort under short-horizon / analytic-source conditions is exactly the F1 / F6 investigation surface.

### Retracted earlier claims (for traceability)

An earlier annotation pass asserted that the catastrophic collapse came from a lag-blind conjugate update at [cohort_forecast_v3.py:124](../../graph-editor/lib/runner/cohort_forecast_v3.py#L124) (`alpha_post = alpha_prior + sum_y; beta_post = beta_prior + (sum_x - sum_y)`). That claim was on the wrong code path. Line 124 is inside `_non_latency_rows`, gated by `if not _is_latency_edge` at [cohort_forecast_v3.py:1304](../../graph-editor/lib/runner/cohort_forecast_v3.py#L1304). The b→c parameter file carries `latency.latency_parameter: true` (line 1351 of the YAML), so `_is_latency_edge = True` and `_non_latency_rows` does not run for the failing test. Retracted.

### F8 — Suite C (FE/BE parity canaries via `--no-be`) results — 28-Apr-26

Four parity canaries added at the foot of [`graph-editor/lib/tests/test_cohort_factorised_outside_in.py`](../../graph-editor/lib/tests/test_cohort_factorised_outside_in.py). Each runs `param-pack` twice on the same query — once with `--no-be` (FE topo Step 2 `blendedMean`) and once without (CF-conditioned `p.mean`) — and asserts parity to `_PARITY_P_MEAN_TOL = 1e-3`. With the helper `_run_param_pack` extended with a `no_be: bool` kwarg ([test_cohort_factorised_outside_in.py:213-287](../../graph-editor/lib/tests/test_cohort_factorised_outside_in.py#L213)), the two surfaces are queryable from the same daemon session.

**Outcome (28-Apr-26 daemon run, 48.8s total): all four fail.** The numbers are more revealing than the parity-failure framing suggests. (**Subsequent re-run after the F2 + F6 + posterior-strict-clear cleanups inverted this result — all four Suite C tests now pass trivially because `param-pack p.mean` no longer reads CF; see the post-cleanup re-run section under "Test results" for the new picture.**)

| Test | Query | Truth p | FE-only (`--no-be`) | Full BE | Δ FE−BE | FE−truth | BE−truth |
|---|---|---|---|---|---|---|---|
| `test_parity_window_mature_high_evidence_p_mean` | `from(simple-a).to(simple-b).window(-90d:)` | 0.7 | **0.6985** | **0.5458** | 0.1527 | −0.0015 ✓ | −0.1542 ✗ |
| `test_parity_cohort_identity_collapse_p_mean` | `from(synth-lat4-c).to(synth-lat4-d).cohort(synth-lat4-c,-90d:)` | 0.65 | **0.8105** | **0.6640** | 0.1465 | +0.1605 ✗ | +0.0140 ✓ |
| `test_parity_subject_equivalent_cohort_anchor_override_p_mean` | `from(synth-lat4-c).to(synth-lat4-d).cohort(synth-lat4-b,-90d:)` | 0.65 | **0.8105** | **0.5217** | 0.2888 | +0.1605 ✗ | −0.1283 ✗ |
| `test_parity_zero_evidence_cohort_returns_prior` | `from(simple-b).to(simple-c).cohort(1-Mar-26:1-Mar-26).asat(1-Mar-26)` | 0.6 (prior) | **0.6031** | **0.6013** | 0.0018 | +0.0031 ✓ | +0.0013 ✓ |

The Δ tolerance was set on the assumption that FE-topo's `blendedMean` and CF's IS-conditioned posterior should both converge on the same long-run rate when evidence is abundant or the prior dominates. The actual parity gaps (0.15, 0.15, 0.29) are 100–290× the tolerance and reveal a richer picture than the existing 73f F1–F7 framing predicts. The detailed analysis is split across F9–F11.

**Test 4 is borderline only.** A 1.8e-3 delta on zero-evidence (where both surfaces should return the prior) is within SMC sampling noise on the conditioned-pass draws around an unchanged prior; the test could reasonably tighten its specific tolerance to 5e-3 with a documented justification, separately from the engine-defect work.

#### Suite C invariant-strength classification

Suite C is intellectually coherent as a diagnostic suite, but the four canaries should not be treated as equivalent invariants:

1. **C1 mature window high-evidence (`simple-a→b.window(-90d:)`) is a strong arithmetic invariant.** In window mode, `population_root = X` and the carrier degenerates to identity. With 90 mature days and truth p=0.7, FE-topo and CF should both collapse near the empirical / truth rate. The observed FE≈truth and CF−truth≈−0.15 gap is therefore a direct CF arithmetic signal, not a cohort-carrier artefact.
2. **C4 zero-evidence prior return is a strong prior-stability invariant, with a looser tolerance.** Both FE-topo and CF should return the prior when no evidence can condition the solve. The current 1.8e-3 gap is small enough to be MC / SMC noise unless a deterministic zero-evidence path is introduced; keep the invariant, but use a specific tolerance around 5e-3 rather than the Suite-wide 1e-3.
3. **C2 identity-collapse parity is semantically valid but not clean as a FE-vs-CF truth oracle.** The identity case (`A = X`) should degenerate to the window solve on the CF side. The result shows CF is close to truth while FE-topo overshoots badly, so failing FE/BE parity here means "one or both writers are wrong", not necessarily "CF is wrong".
4. **C3 anchor-override parity is a useful divergence detector, not a stand-alone correctness oracle.** It catches the Group 2 under-shift, but F10 shows FE-topo overshoots on the same fixture. Future assertions should compare each side to truth / factorised oracle separately before using parity as the acceptance condition.

Net: Suite C upgrades the outside-in pack by adding the first `--no-be` arithmetic smoke tests, but C2/C3 need oracle assertions before they can be used as clean pass/fail semantics for either writer.

### F9 — CF significantly under-shoots truth on a high-evidence mature window query (NEW signal)

Suite C Test 1 reveals a defect not previously articulated in 73f: **for `from(simple-a).to(simple-b).window(-90d:)` on `synth-simple-abc` (truth p=0.7, t95 ≈ 24d, 90 days of mature evidence), the CF-conditioned `p.mean` is 0.5458, while FE-topo's `blendedMean` is 0.6985.** FE-topo lands within 0.002 of truth; CF lands 0.154 under truth.

This is the same edge and same query whose [Suite B failure](73b-final-outstanding.md#5-outside-in-run-results--28-apr-26) was previously logged as `pack p.mean = 0.545800 vs CF p_mean = 0.546332, delta 5.3e-4` — a Group 1 small-drift framing. That framing is now revealed to have been masking a much larger defect: **the existing pack value (0.5458) was already CF-conditioned**, so Suite B was comparing CF against CF. The 5.3e-4 between two CF values was a small parity drift between two CF entry paths; the 0.15 between FE-topo and CF is the *actual* engine defect on this fixture.

Why this defect was previously invisible:
- Existing Suite B parity tests (`test_cli_window_single_edge_scalar_identity_across_public_surfaces` and friends) compared `param-pack` `p.mean` against `cohort_maturity` `p_infinity_mean` against `conditioned_forecast` `p_mean`. All three traverse CF — they share the same engine output. Cross-surface parity to 1e-4 was therefore an integrity check on CF's response shape, not an arithmetic check.
- The factorised CDF/PDF oracle in Suite A is constructed on cohort queries with sparse evidence. The mature-window-with-truth-known fixture `simple-a-to-b` with truth p=0.7 wasn't being checked against truth at all.
- The CF undershoot on mature window mode for synth-simple-abc was therefore present but unflagged.

**Implication for the F1 hypothesis.** F1 attributes Groups 2 and 3 to reach-scaled evidence counts feeding the IS log-weight via the carrier-materialisation block (which fires only on cohort queries with `use_factorised_carrier=True`). That block is **not active** on a window query — `is_window=True` → gate at [cohort_forecast_v3.py:953](../../graph-editor/lib/runner/cohort_forecast_v3.py#L953) is False. So F9's defect cannot be explained by the F1 hypothesis as currently stated. CF is producing a 0.15 absolute under-shift on a window query whose code path **does not** go through the suspected reach-scaling block.

Possible alternate hypotheses (not yet investigated):
- The conjugate update + IS reweighting in `compute_forecast_trajectory` is biased on the window path too — perhaps a similar prior:evidence-strength imbalance, but with a different mechanism (e.g. `n_effective` from the resolver dwarfs the query-scoped evidence count even at 90 days × 5000/day traffic).
- The doc-52 blend at [forecast_state.py:1671](../../graph-editor/lib/runner/forecast_state.py#L1671) is mixing the conditioned posterior with an unconditioned prior whose mean is far from truth, dragging the result toward the prior. F5 noted that blend skips with `n_effective_missing` for analytic-only fixtures — but here the diagnostic on synth-simple-abc was missing. Worth re-checking whether F5's blend skip applies on this fixture and what it would mean for the conditioned/unconditioned mix.
- The proposal distribution `Beta(α_pred, β_pred)` is far from the empirical rate, so IS draws are systematically over-weighted toward the prior. On a fixture with no Bayes commissioning (the synth fixture's analytic source has no `n_effective` per F3), the predictive α/β may collapse to the unconditioned analytic Step 1 fit, which itself may not reflect truth.

**Current status after F14**: F9 was the signal that broke the F1-only framing. F14 now explains the mechanism directly: CF is binding raw under-matured `(Σy, Σx)` and therefore pins to raw `k/n`. Treat F9 as one manifestation of F14 rather than a separate window-mode defect.

**Update from Suite D (28-Apr-26)**: F9 is no longer specific to window-mode. **F13** documents the same defect class manifesting on a 90-day **identity-collapse cohort** on `simple-b-to-c` (analytic=0.422 / bayes=0.423 vs truth=0.6, ~30% under). This rules out reach-scaling as the mechanism (identity collapse means reach=1) and rules out window-vs-cohort as the discriminator. The defect is general CF.

### F10 — FE-topo over-shoots truth on synth-lat4 c→d cohort queries — likely fixture/asymptote interaction

Suite C Tests 2 and 3 show FE-topo's `blendedMean` at **0.8105 for both `cohort(synth-lat4-c, -90d:)` and `cohort(synth-lat4-b, -90d:)`** on edge c→d, where truth p=0.65. The identical FE-topo number across both queries is consistent with FE-topo being temporal-mode-blind (it doesn't apply cohort-anchor semantics — see FE_BE_STATS_PARALLELISM.md §"Two logical steps in one pass"). But FE-topo *should* track truth on a 90-day cohort window over a mature edge — and it doesn't.

Plausible mechanisms (not yet investigated; ranked by likelihood):

1. **`forecast.mean` is set to ~0.81 by promotion from `model_vars[analytic].probability.mean`.** The Step 1 analytic fit on synth-lat4 c→d, given the simulation seed and recency-weighting, may produce 0.81 rather than 0.65. With sparse query-scoped evidence on a cohort frame (90 days of evidence at the anchor doesn't translate to 90 days of edge-local evidence — cohort accumulation is gated by upstream maturation), `w_evidence` is small and `blendedMean → forecast.mean ≈ 0.81`.
2. **`evidence.mean` is biased high for cohort mode.** If cohort-frame evidence aggregation under-counts `x` (denominator) or over-counts `y` (numerator) — e.g. by anchoring on entries that actually completed b→c rather than entries that reached c — the rate would be inflated. FE-topo would consume this biased evidence directly.
3. **F3's "no posterior, no `n_effective`" condition leaves the analytic source's promotion unchecked.** The truth p=0.65 is the simulation parameter; the Step 1 analytic fit estimates it from observed conversions. If the fit's recency-weighted mean diverges materially on this fixture, the discrepancy is real but is a **fixture / analytic-fit issue**, not a CF issue.

**Triage**: this is interesting but not in the engine-defect critical path. Concretely: FE-topo's number is what `param-pack --no-be` returns to the user; if it's wrong on synth-lat4 cohort queries by 25%, it's a meaningful FE-side accuracy issue, but the fix surface is in `statisticalEnhancementService.ts` / Step 1 analytic fit / promotion, not in the CF / cohort_forecast_v3 hot-path that F1–F2 target.

For the parity-test purpose, F10 muddies the FE-vs-BE signal on cohort queries (because FE-topo isn't a clean baseline either). Suite C Tests 2 and 3 still serve as **divergence detectors** — when FE and BE differ by >1e-3 on subject-equivalent queries something is wrong somewhere — but they no longer tell us which of FE-topo or CF is closer to truth without external reference (which Suite A's factorised oracles provide).

**Recommended Suite C extension after engine work lands:** add a third assertion to Tests 2 and 3 comparing `param-pack --no-be` against the factorised oracle directly (the same oracle Suite A uses), so the FE-topo overshoot is detected separately from the CF undershoot.

### F11 — Pre-existing pack-vs-CF parity tests were CF-vs-CF, not FE-vs-BE

Cross-cutting observation extracted from F8 / F9: every parity test in Suite B (e.g. `test_cli_window_single_edge_scalar_identity_across_public_surfaces`, `test_cli_identity_collapse_matches_window_across_public_surfaces`, `test_cli_projection_parity_uses_last_row_saturation_not_arbitrary_tau_curve_point`) was constructed before `--no-be` existed. They compare:

- `param-pack p.mean` (CF-conditioned via `aggregateAndPopulateGraph` → `runStage2EnhancementsAndInboundN` → CF call)
- `cohort_maturity p_infinity_mean` (CF-conditioned via `compute_cohort_maturity_rows_v3` → `compute_forecast_trajectory`)
- `conditioned_forecast p_mean` (CF directly)

All three sources end up reading from the same CF pipeline. Their cross-surface parity at 1e-4 is an integrity check on response-shape consistency (does CF return the same scalar for the same query through three different transport paths?). It is **not** an arithmetic check — there is no analytic baseline in the comparison.

This re-frames the small-drift Group 1 numbers: a 5.3e-4 delta on `cli_window_single_edge_scalar_identity_across_public_surfaces` is a CF transport drift between three CF entry paths. The 73b §5 / Source A + Source B framing in F4 still applies (the drift is real and explainable), but the test's assertion does not pin CF arithmetic correctness — it only pins consistency across CF surfaces.

**Implication**: Suite C is the **first** outside-in arithmetic-correctness check that uses an analytic baseline (FE-topo) to pin CF's IS-conditioned output. The four Suite C tests are therefore stronger evidence than Suite B's full-pass parity on the questions they cover. The F8 result table is the dataset to act on.

**Update (post F2 + F6 + posterior-strict-clear cleanup)**: Suite C now passes trivially because `param-pack p.mean` and `param-pack --no-be p.mean` converge on the same FE-topo `blendedMean` value. Pack no longer surfaces the CF posterior pin, so this suite has lost its FE-vs-CF arithmetic-baseline role until either pack is re-wired to CF or Suite C's reference moves to `cohort_maturity` / `conditioned_forecast` with `--no-be` honoured at those surfaces. See the post-cleanup re-run section under "Test results".

### F12 — Suite D (analytic ↔ bayes parity canaries) results — 28-Apr-26

Ran `pytest -v -k "test_d0_ or test_d1_ or test_d2_ or test_d3_ or test_d4_ or test_d5_"` through the daemon against full BE/CF. **5 passed, 1 failed, 1 xfailed in 60.45 s.** (Re-confirmed in the post F2+F6+strict-clear re-run: Suite D outcomes are bit-identical to F12 — D0/D1/D3/D5 PASS, D2 FAIL at delta=0.001264, D4 XFAIL. F14's mechanism survives the cleanup unchanged.)

| Test | Result | Numbers | Interpretation |
|---|---|---|---|
| D0 `bayes_vars_actually_promotes_to_bayesian` | **PASS** | analytic: `promoted_source='analytic'`; with sidecar: `'bayesian'` | Sidecar plumbing works; rest of Suite D is interpretable. |
| D1 `parity_analytic_vs_bayes_mature_window` (`from(simple-a).to(simple-b).window(-90d:)`) | **PASS** | asymptote parity & curve parity within tolerance | Source choice is not the cause; both surfaces can still agree on the wrong raw evidence basis (see F14). |
| D2 `parity_analytic_vs_bayes_identity_collapse_cohort` (`from(simple-b).to(simple-c).cohort(simple-b,-90d:)`) | **FAIL** (marginal) | analytic=0.422027, bayes=0.423292, delta=1.26e-3 vs tol 1e-3 | See F13 — the parity miss is small; the absolute numbers are the real signal, 30% under truth. |
| D3 `parity_analytic_vs_bayes_zero_evidence_returns_prior` | **PASS** | both surfaces → respective prior within 5e-3 | Zero-evidence prior wiring agrees across sources. |
| D4 `parity_analytic_vs_bayes_low_evidence_cohort_F1_signature` (xfail-strict) | **XFAIL (expected)** | divergence > 30% on Group 3 DSL | Low-evidence source-sensitivity still alive; now primarily F14, with F1 possible as residual. |
| D5 `anti_parity_analytic_vs_bayes_low_evidence_cohort_F1_pinned` | **PASS** | curves diverge by > 30% on Group 3 DSL | Same signal from the anti-parity angle. |

**D4 + D5 lockstep is the low-evidence source-sensitivity signature.** D4 fails (xfail-strict not fired) and D5 passes simultaneously. When the F14/F1-sensitive defect is fixed, both will trip together: D4's marker fires (test starts passing) and D5's anti-parity assertion fails (curves converge). Today's run confirms the defect is unchanged since F8.

D0 + D1 + D3 confirm the core analytic ↔ bayesian projection pipeline works on the queries where source parity should hold. The bayes-vars sidecar promotes correctly; source choice is not the root cause of F9/F14; zero-evidence returns the appropriate prior on each side.

The unexpected signal is D2 — see F13.

### F13 — D2 surfaces F9 generalised: CF undershoots truth on identity-collapse cohort too

D2 was designed as a golden parity check: A=X identity collapse → carrier reach=1 → both surfaces should compute the same edge rate as a window query. The test asserts only that analytic and bayes agree to 1e-3; it does not assert correctness against truth.

The marginal parity failure (delta=1.26e-3) is itself small drift between two CF-conditioned numbers. The bigger signal is the absolute value: **both surfaces produce ~0.422 on `cohort(simple-b, -90d:)` for `simple-b-to-c`, against truth p=0.6 and evidence k/n ≈ 0.6034**. That is a 30% absolute under-shoot, on a 90-day mature cohort with abundant evidence, on the identity-collapse path where the carrier should collapse to reach=1.

This is the same defect class as F9 (CF mature-window undershoot on `simple-a-to-b`: 0.5458 vs truth 0.7, ~22% under), now also observed on:

- a different edge (`simple-b-to-c` vs F9's `simple-a-to-b`)
- a different temporal mode (cohort identity-collapse vs F9's window)
- a similar magnitude undershoot (~30% here, ~22% in F9)

**Implication**: F9 is not specific to window-mode or to the `a→b` edge of synth-simple-abc. It hits at least one cohort identity-collapse query on a different edge of the same fixture with similar magnitude. The F1 hypothesis (reach-scaled cohort evidence feeding IS log-weight) is **doubly inadequate** as a single explanation:

- F9 already showed the defect on a window query whose code path bypasses the F1 carrier-materialisation block
- D2 / F13 now shows the defect on an identity-collapse cohort query where reach=1 (no carrier scaling at all — `use_factorised_carrier` may even be False per the gate at [cohort_forecast_v3.py:953](../../graph-editor/lib/runner/cohort_forecast_v3.py#L953) when `is_window=False` AND identity-collapse short-circuits)

A general CF defect — affecting both window and cohort modes, both at high evidence and in the absence of any reach-scaling — is now the working framing. This observation led directly to F14, which confirms F9 + F13 are the same evidence-binding defect.

The marginal parity miss between analytic (0.422) and bayes (0.423) is consistent with Source-A-shape drift (F4) — the bayes path's larger prior produces a 1e-3-scale shift in the conditioned posterior even when both are far below truth. Tightening D2's tolerance is not the right response; the right response is to fix the underlying CF undershoot, after which the two surfaces should converge to truth and parity will hold trivially.

### F14 — Mechanism for F9 / F13: CF binds raw under-matured `(Σy, Σx)` to the IS update; posterior pins at empirical `k/n`

**Status: confirmed by direct diagnostic.** This is the underlying mechanism for the F9 window-mode undershoot and the F13 / D2 cohort identity-collapse undershoot. F1's reach-scaling hypothesis is reframed as a possible secondary effect; the dominant defect is one layer up, in evidence binding.

**Evidence.** `bash graph-ops/scripts/param-pack.sh synth-simple-abc 'from(simple-a).to(simple-b).window(-90d:)' --no-cache --format json --diag` (28-Apr-26):

```
e.simple-a-to-b.p.evidence.k       = 144,516
e.simple-a-to-b.p.evidence.n       = 265,035
e.simple-a-to-b.p.evidence.mean    = 0.7054      ← maturity-corrected, ≈ truth
e.simple-a-to-b.p.forecast.mean    = 0.6971      ← analytic asymptote, ≈ truth
e.simple-a-to-b.p.mean             = 0.5458      ← CF output (the F9 bug)
```

Raw count ratio: `144,516 / 265,035 = 0.54527`. CF's `p.mean = 0.5458` differs from this raw ratio by 0.0005 — exactly the small pull a kappa-order prior centred near 0.7 contributes when conjugate-updated against n = 265k of evidence. **CF is returning the empirical raw `k/n`**, not the maturity-corrected asymptote that FE-topo Step 2 produces and that `forecast.mean` already records.

**Mechanism.** `_non_latency_rows` reads aggregate evidence at [cohort_forecast_v3.py:99-101](../../graph-editor/lib/runner/cohort_forecast_v3.py#L99) — `sum_y = Σ c.y_frozen`, `sum_x = Σ c.x_frozen` over per-cohort frame entries. The latency-edge sweep path consumes the same per-cohort `(y_frozen, x_frozen)` via `engine_cohorts` fed into `compute_forecast_trajectory`. The IS reweighting at [forecast_state.py:1149-1173](../../graph-editor/lib/runner/forecast_state.py#L1149) computes `log_w_i = k_i · log(p) + (n_i − k_i) · log(1−p)` — a binomial log-likelihood whose maximum is at `p = k_i / n_i`. The conjugate pre-step does the same in closed form: `α_post / (α + β) → Σy / Σx` as the prior is dwarfed.

`y_frozen` is "users observed converted by frontier age `a_i`". `x_frozen` is "users entered by `a_i`". Neither is forward-projected through the edge's lag CDF. On `simple-a-to-b` with t95 ≈ 24 days and a 90-day window, ~25–30% of cohort entries (the most recent ~24 days) have not yet had time to mature — they sit in `x_frozen` but not in `y_frozen`. Raw `Σy/Σx = 0.5453` is biased downward by exactly that maturity gap. Truth = 0.70; gap = 0.16; matches the F9 undershoot exactly.

FE-topo Step 2 doesn't have this defect because it consumes `evidence.mean = 0.7054` (already maturity-corrected upstream) and `forecast.mean = 0.6971` (the analytic asymptote). Both account for the lag CDF. Hence Suite C Test 1's FE-only result ≈ 0.6985 ≈ truth.

**Reframing F13 / D2.** Same mechanism. `simple-b-to-c` cohort identity-collapse over 90 days has the same maturity-gap shape: cohort entries within ~t95 of the right edge of the window haven't matured. Raw `k/n` for that query lands at ~0.42; CF returns ~0.42; truth is 0.6. Identical defect, different edge, different temporal mode — confirming F13's "general CF defect" framing.

**Reframing Group 3.** Same mechanism with thinner evidence. `synth-simple-abc.cohort(1-Mar-26:3-Mar-26).asat(3-Mar-26)` on `b→c` is a 2-day cohort with t95 ≈ 22 days; almost nothing has matured by τ = 16. Raw `y` is tiny relative to raw `x`. The IS update pins `p` far below truth. The 60% under-shoot is F14 amplified by sparse evidence, not a separate engine bug.

**F1 reframed (not retracted).** F1 hypothesised that the reach-scaling at [cohort_forecast_v3.py:1019-1057](../../graph-editor/lib/runner/cohort_forecast_v3.py#L1019) was the F9 / Group 2 driver. F14 shows that route is at most a secondary contribution on cohort-anchor-override paths. Re-test after the F14 fix; if Group 2 closes alongside Group 3, F9, and F13, F1 was subsumed. If Group 2 lingers with a residual under-shift, F1 is a second contribution worth its own fix.

**Recommended fix direction.** CF's evidence binding needs to be **completeness-aware inside the likelihood**, not as an external reweighting. Per cohort `i` with frontier age `a_i` and completeness `c_i = completeness(a_i)`:

```
y_i ~ Binomial(x_i, p∞ · c_i)
```

(or its factorised carrier/subject equivalent). The likelihood's per-cohort `p_i` is the *expected fraction of `x_i` that will have converted by `a_i`*, not the steady-state rate. An immature cohort with small `y_i / x_i` then still supports a large `p∞` because `c_i` is small — the data is not over-interpreted as a mature observation. The IS log-weight follows the same shape: `log_w_i = y_i · log(p∞ · c_i) + (x_i − y_i) · log(1 − p∞ · c_i)`.

Equivalent reformulations (any one of these closes F9, F13/D2, Group 3, and 73b §3.7):

- **Likelihood with `p_i = p∞ · c_i`** as above. Cleanest specification — completeness sits where it belongs (inside the binomial parameter), not as a heuristic weight.
- **Maturity-corrected sufficient statistic.** Equivalent moment-match: bind on `(Σy_frozen, Σ(x_i · c_i))` rather than `(Σy_frozen, Σx_i)`. The asymptote pins at the maturity-corrected ratio for free.
- **Forward-project `Σy_frozen` through the lag CDF** before binding. Mathematically related to the second form; can be more or less convenient depending on how the per-cohort `(τ, x, y)` tuples are constructed.

Avoid the obvious-looking "weight each cohort's log-likelihood by `1 / c_i`" — it amplifies immature cohorts rather than appropriately discounting their certainty, and tightens the posterior toward whatever raw rate they happen to carry. Completeness must enter the binomial parameter, not the cohort weight.

Either of the three routes above closes F9, F13 / D2, and Group 3 cleanly. Group 2 may close fully or partially.

73b §3.7 (`abBcSmoothLag` E2E undershoot) is the FE-side analogue and was already pinned to the same CF arithmetic via `--no-be` triage. F14 explains it: the FE chart reads `p.mean` from CF, which is the under-matured pin. Expected to close when F14 is fixed.

### F15 — Kappa=200 silent fallback prior is dangerous regardless of whether it fires

**Status: design defect, independent of F14.** Recorded for follow-up.

[model_resolver.py:467-477](../../graph-editor/lib/runner/model_resolver.py#L467) silently fabricates a Beta prior `Beta(p·200, (1−p)·200)` with provenance `analytic_point_estimate_degraded` whenever neither the posterior block nor the source-layer α/β yields valid values. It never fails or warns; it only writes a provenance label that downstream consumers must remember to inspect.

The existing diag output doesn't expose the resolved provenance, so the live state on synth fixtures isn't directly readable from the current diagnostic surface. Two possible worlds:

- **Fallback never fires on properly-loaded edges.** FE-topo Step 1's `buildAnalyticProbabilityBlock` succeeds whenever `stdev² < mean·(1−mean)`, which is trivially satisfied on any edge with non-trivial evidence. If this is the case, the fallback is dead code — and dead code in a numerical resolver is worse than absent code, because it normalises "silent recovery from missing inputs" as a design pattern.
- **Fallback fires on at least some fixtures.** Then it is silently masking an upstream binding bug — `model_vars[analytic].probability` not being populated, or being lost in TS→Python serialisation. The numerical output looks legitimate but is built on a fabricated prior whose strength is unrelated to the edge.

**Either way the design is wrong.** The right behaviour when `resolve_model_params` cannot produce α/β from real source data is to fail loudly: raise / return a typed error / refuse to compute. Surface the missing-input condition to the caller so the upstream binding bug becomes visible. If the fallback is in fact dead, removing it costs nothing; if it isn't, replacing it with a hard failure flushes out the upstream bugs it was hiding.

**Note on F9 / F14:** with n = 265k of evidence on `simple-a-to-b`, any reasonable prior (kappa = 200 or kappa = 2000 from a real moment-match) is dwarfed; F14's evidence-side defect explains the undershoot regardless of which prior the resolver picked. So F15 is independent of the F14 fix. But it should be addressed before further engine work — silent prior fabrication is the kind of design that makes future engine bugs harder to triage.

**Action**: instrument the resolver once to log every fallback firing with edge ID + DSL across a Suite A/B/C/D run; then either remove the fallback (if zero firings) or replace it with a hard failure and fix the upstream binding paths it was masking.

## Priority workplan

This replaces the earlier F1-first plan. F14 is now the dominant, confirmed mechanism: CF binds raw under-matured `(Σy, Σx)` to the rate update and therefore pins to raw `k/n` instead of a maturity-corrected asymptote. F1 remains a possible residual on cohort-anchor paths after F14 is fixed.

1. **Fix F14 — maturity-aware CF evidence binding.** This is top priority. The shared sweep should only condition the rate side on evidence expressed on the correct semantic basis for `p∞`. Raw under-matured `y_frozen/x_frozen` must not be treated as mature binomial evidence. The fix should close F9, F13/D2, Group 3, and 73b §3.7. Candidate implementation directions remain: project observed numerator mass forward through the lag CDF before binding, or construct a per-cohort likelihood that accounts for completeness directly.
2. **Strengthen source-mass diagnostics around Suite D.** D0 currently proves only `promoted_source`. Add a follow-up check for resolved `alpha/beta`, `alpha_pred/beta_pred`, and `n_effective` on the bayes path so Suite D cannot pass with a promoted but truncated posterior.
3. **Address F15 — silent kappa=200 fallback.** Instrument whether `analytic_point_estimate_degraded` fires across Suite A/B/C/D. If it does not fire, remove the fallback. If it does, replace it with a typed failure and fix the upstream binding path it was hiding. This is independent of F14 but important for future diagnostics.
4. **Re-run Suite A/B/C/D after F14.** Expected closure signals: Suite C C1 moves near FE/truth, Suite D D2 moves near truth and parity, Group 3 compresses toward the factorised oracle, and D4/D5 trip together. Suite B remains a CF transport-parity check, not an arithmetic oracle.
5. **Only then revisit F1 / Group 2.** If synth-lat4 anchor-depth divergence remains after F14 and the resolver-backed carrier fix (F6), instrument `cohort(synth-lat4-b,-90d:)` on c→d for reach-scaled counts. If it closes, F1 was subsumed by F14.
6. **Keep F2 closed.** The deterministic-prior branch has been removed. Do not reintroduce `_query_scoped_latency_rows`; if no-evidence or short-horizon cases misbehave, fix the shared sweep degeneration.
7. **Handle F10 separately.** FE-topo's 0.8105 overshoot on synth-lat4 c→d cohort queries is a separate FE analytic-fit / evidence-aggregation issue. It should not block F14, but Suite C C2/C3 should eventually gain truth/oracle assertions so FE and CF can be judged separately.
8. **Make tolerance calls last.** Only after F14/F1/F10 are classified should residual Source A / Source B transport drifts or C4's small zero-evidence delta be relaxed.

## Recommended next research steps (no fixes yet)

1. Design the F14 likelihood / binding change explicitly: define whether CF should bind a maturity-corrected numerator, a completeness-aware binomial likelihood, or an equivalent sufficient statistic. The chosen object must preserve the canonical split: `carrier_to_x` owns denominator arrival, `subject_span` owns `X -> end`, and rate evidence must answer the subject `p∞` question.
2. Add a narrow F14 unit/integration witness before editing engine arithmetic: `simple-a→b.window(-90d:)` should not condition to raw `144516/265035`; `simple-b→c.cohort(simple-b,-90d:)` should not condition to ~0.422. Both should remain on the shared sweep path.
3. Add Suite D source-mass diagnostics or a separate small test proving `--bayes-vars` projection preserves `n_effective` through to the Python resolver.
4. Re-run the focused outside-in canaries after the F14 fix: Suite C C1/C4, Suite D D1/D2/D3/D4/D5, then Group 3 oracle tests.
5. Investigate F10 separately: dump the analytic Step 1 fit's `model_vars[analytic].probability.mean` on synth-lat4 c→d, plus `evidence.mean` on the cohort-frame query, to confirm whether the 0.81 overshoot is in the analytic asymptote, the cohort-frame evidence aggregation, or both.

## Implementation changes logged in this workstream

The changes below are code / test changes made while working through this investigation, not merely proposed fixes.

1. **Removed the deterministic-prior latency-edge branch.**
   - Deleted `_query_scoped_latency_rows` from [`cohort_forecast_v3.py`](../../graph-editor/lib/runner/cohort_forecast_v3.py).
   - Deleted the `if not _sweep_eligible` dispatch block that would have called it.
   - Removed `is_cf_sweep_eligible`, the `sweep_eligible` runtime-bundle field, and the associated diagnostic projection from [`forecast_runtime.py`](../../graph-editor/lib/runner/forecast_runtime.py).
   - Removed the corresponding `sweep_eligible=True` plumbing from [`api_handlers.py`](../../graph-editor/lib/api_handlers.py).
   - Net behaviour: latency-edge cohort maturity has one path — the shared sweep. No deterministic-prior escape route remains.

2. **Updated stale branch-pinning tests.**
   - Updated [`test_cf_query_scoped_degradation.py`](../../graph-editor/lib/tests/test_cf_query_scoped_degradation.py) so it asserts the shared sweep contract (`cf_mode='sweep'`) instead of `analytic_degraded` / `query_scoped_posterior`.
   - Removed the obsolete surprise-gauge "unavailable for query-scoped posterior" assertion, since the mode no longer exists.
   - Updated the daily-conversions branch test to assert shared-sweep output shape rather than the deleted closed-form degraded surface.
   - Updated [`test_stage0_fallback_register_pinning.py`](../../graph-editor/lib/tests/test_stage0_fallback_register_pinning.py) to record that register entry 3 has been retired rather than pinning the old emitter / consumer guard.
   - Updated doc-56 behaviour tests to expect `cf_mode='sweep'` where they previously expected `analytic_degraded`.

3. **Aligned analytic-source blend expectations with Decision 13.**
   - Updated [`test_non_latency_rows.py`](../../graph-editor/lib/tests/test_non_latency_rows.py) and [`test_forecast_state_cohort.py`](../../graph-editor/lib/tests/test_forecast_state_cohort.py) so analytic aggregate α/β uses the same doc-52 blend contract as bayesian instead of expecting `source_query_scoped` skip behaviour.
   - This matches the post-73b contract: analytic α/β is an aggregate source-layer prior, not a query-scoped posterior.

4. **Updated TypeScript CF result expectations.**
   - Updated [`conditionedForecastCompleteness.test.ts`](../../graph-editor/src/services/__tests__/conditionedForecastCompleteness.test.ts) so the example CF response uses `cf_mode='sweep'` / `cf_reason=null` and no longer references `analytic_degraded`.

5. **Documented the live resolver-carrier state.**
   - F6 now records that `read_edge_cohort_params` is resolver-backed in the live branch, so carrier construction should see the same promoted source / quality gates / fallbacks as the rest of the engine.
   - This is documented as branch state pending full outside-in re-run; it is no longer the first-priority fix surface.

Focused verification already run:

- Python compile for edited backend modules.
- `test_cf_query_scoped_degradation.py` focused shared-sweep tests.
- `test_stage0_fallback_register_pinning.py`.
- `test_non_latency_rows.py::test_blend_non_latency_analytic_source_uses_same_blend_contract`.
- `test_forecast_state_cohort.py::TestSubsetConditioningBlend::test_summary_blend_analytic_source_uses_same_contract`.
- `conditionedForecastCompleteness.test.ts`.
- `ReadLints` on edited Python, TS test, and this document.

## Related items (cross-references to other docs)

- [73b-final-outstanding.md §3.7](73b-final-outstanding.md#37-fe-e2e-parity-echo-abbcsmoothlag-blended-reach-undershoot) — abBcSmoothLag E2E undershoot. Same defect surface as F14 / Group 3 per `--no-be` triage; expected to close when maturity-aware CF evidence binding is fixed.
- [73b-final-outstanding.md §3.6](73b-final-outstanding.md#36-pre-retirement-contract-pins-after-stage-6-discriminator-retirement) — pre-retirement contract pins. Several pins (notably `test_query_scoped_model_bands_match_posterior`) are unmasking the Source A drift from F4 rather than expecting test updates. Per-pin classification kept in 73b §8.5.
- [73b-final-outstanding.md §7.4](73b-final-outstanding.md#74-bayes-patch-tier-1-projects-bare-window--cohort-slices-onto-the-graph) — Bayes patch Tier 1 contexting bypass. Separate workstream; only bites contexted DSL slices and is unrelated to the outside-in failures.
- [73b-final-outstanding.md §3.8](73b-final-outstanding.md#38-playwright-regression--sharelivechart-distinct-scenario-graphs-post-73e) — Playwright regression. Different defect class (transport / share-restore), not engine. Stays in 73b.
- [73b-final-outstanding.md §3.9](73b-final-outstanding.md#39-surprise-gauge-has-stopped-working-post-73e) — surprise gauge. Different defect class (runner-analyze dispatch). Stays in 73b until reproduction / triage.

---

## Glossary of identifiers used in this doc

- **Group 1 / Group 2 / Group 3** — failure clusters within the outside-in suite, named by symptom shape (small drift / anchor-depth divergence / low-evidence oracle drift). Defined at the top of the Test results section.
- **F1–F15** — diagnostic findings, evidence-backed source-inspection observations or test-result observations. F12 records the Suite D 28-Apr-26 run results; F13 reframes F9 as a general CF undershoot affecting at least one cohort identity-collapse query in addition to the original window-mode signal; F14 identifies the dominant evidence-binding mechanism; F15 records the separate silent-fallback risk.
- **Source A / Source B** — two independent O(1e-4) drift sources contributing to Group 1 and the post-73e new failures. Defined inside F4.
- **Suite A / Suite B / Suite C / Suite D** — four test groupings inside [`test_cohort_factorised_outside_in.py`](../../graph-editor/lib/tests/test_cohort_factorised_outside_in.py). Suite A asserts factorised CDF/PDF oracle correctness. Suite B asserts cross-surface scalar parity (pack ↔ cohort_maturity ↔ CF — all CF-conditioned in the F8 era, see F11). Suite C asserts FE/BE parity via `--no-be` (was the arithmetic baseline check in the F8 era; trivialised post-cleanup, see the post F2+F6+strict-clear re-run section). Suite D asserts analytic ↔ bayesian source parity via `--bayes-vars`; D4 + D5 are currently the low-evidence source-sensitivity detector for F14/F1, despite their historical F1 names.
- **`alpha_beta_query_scoped`** — retired discriminator property, removed in 73b Stage 6 / Decision 13. The True branch's conjugate-update short-circuit was the masking mechanism for many of the defects in F1–F4.
