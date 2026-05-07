# Active Cohort A≠X — Selected Projection & Display Evidence

**Date**: 5-May-26
**Branch**: `feature/snapshot-db-phase0`
**Status**: Partial implementation — reducer fix conformant; display-evidence override is algebraically wrong and needs reauthoring.

---

## Objective

Fix the cohort maturity E+F chart for active `cohort(A, X-end)` queries where `A ≠ X`. The "speed mark" exposed an impossible inflated denominator: terminal subject reported `n=407` at switch-registered while the immediately-prior carrier into switch-registered delivered only `k=323` of this cohort. The chart starts from an over-admitted X population and Y appears to rise too quickly.

Root cause (per [docs/current/cohort-maturity-selected-cohort-projection-pattern.md](../cohort-maturity-selected-cohort-projection-pattern.md) Phase 3, finalised during this session): `build_cohort_evidence_from_frames` materialises `obs_x`/`obs_y`/`x_frozen`/`y_frozen` from window-prepared subject frames. Those frames are X-clocked across cohorts and inadmissible as A-clock selected-row prefixes. The selected-Cohort reducer then treats them as if they were the cohort's A-clock prefix, inflating Pop D and seeding the projection with phantom mass.

Constraint reaffirmed by user (do not violate): primitive conditioning stays window-led — no new cohort-conditioned primitive posteriors, no second evidence acquisition path, no new MC pass. The fix is at the *selected projection* layer, not at conditioning.

Canonical semantic doc: [docs/current/codebase/COHORT_ANALYSIS_NUMERATOR_DENOMINATOR_SEMANTICS.md](../codebase/COHORT_ANALYSIS_NUMERATOR_DENOMINATOR_SEMANTICS.md). Phase 3 was reviewed in this session and confirmed conformant.

---

## Current State

- **DONE** — Phase 3 design captured in [docs/current/cohort-maturity-selected-cohort-projection-pattern.md](../cohort-maturity-selected-cohort-projection-pattern.md) §"Phase 3: Active-Carrier A-Clock Selected Projection". User authored Phase 3 during this session; agent reviewed against canonical semantics and confirmed conformance.
- **DONE** — Phase 3 outside-in red test: `test_active_multihop_cohort_midpoint_matches_a_clock_convolution_oracle` already exists at [graph-editor/lib/tests/test_cohort_factorised_outside_in.py:1266](../../graph-editor/lib/tests/test_cohort_factorised_outside_in.py). Pins midpoint against an independent A-clock carrier⊗subject oracle for `cohort(A, B-D)` on `synth-lat4`. Passes after the reducer-side fix.
- **DONE** — Selected-prefix seeding gated for active A≠X. Edits in [graph-editor/lib/runner/cohort_forecast_v3.py](../../graph-editor/lib/runner/cohort_forecast_v3.py):
  - `build_cohort_evidence_from_frames` accepts `is_active_carrier` parameter.
  - When `is_active_carrier`: zeros `raw_obs_x`, `raw_obs_y`, sets `a_i = 0` (frontier_age), so `x_frozen = 0`, `y_frozen = 0`. The reducer's Pop D pool collapses to zero; Pop C drives the unanchored projection from `a_pop × composed_carrier ⊗ composed_subject`.
  - Wrapper `compute_cohort_maturity_rows_v3` computes `_is_active_carrier = not is_window and anchor_node_id and query_from_node and anchor_node_id != query_from_node` and passes it through.
- **DONE — Phase 3 reducer test passes** — `test_active_multihop_cohort_midpoint_matches_a_clock_convolution_oracle` PASSES with the reducer-side fix in place.
- **BLOCKED / WRONG** — Display-evidence override in `_project_runtime_rows`. Added an active-carrier branch that computes `evidence_x_tau`, `evidence_y_tau`, `rate` from `F_X` (carrier `cdf_mean`) and `F_Y` (joint A→end `cdf_mean`) scaled by `Σ a_pop`. The user pointed out this is **algebraically wrong**:
  - `F_X` is `carrier.cdf_mean`, not `carrier.span_p_mean × carrier.cdf_mean` — missing carrier reach.
  - `F_Y` is the carrier⊗subject timing CDF, missing `carrier.span_p_mean × subject.span_p_mean` — missing both reaches.
  - Resulting `rate = F_Y / F_X` tends toward 1, not toward subject span probability. Should be roughly `p_subject × (carrier⊗subject_cdf) / carrier_cdf`.
  - The reducer (`_selected_cohort_group_rate_draws`) is correct because it uses `G = p_car × F_car` and `H_subj_unshifted = p_subj × F_subj`. The display-evidence path is the part that's wrong.
- **NOT DONE** — Verify chart renders correctly end-to-end with the corrected display-evidence formula.
- **NOT DONE** — Reauth the test `test_active_selected_cohort_observed_x_is_controlled_by_carrier_arrivals` at [graph-editor/lib/tests/test_selected_cohort_pop_d_distribution.py:125](../../graph-editor/lib/tests/test_selected_cohort_pop_d_distribution.py#L125). Authored against the partial-patch shape Phase 3 forbids (asserts `cohort.obs_x[2] == 6.0` from a carrier `upstream_obs` lookup). Under Phase 3 strict, `obs_x[2] == 0` (no frame-seeded prefix) and `a_pop` carries the cohort's base mass. Test currently fails with `assert 10.0 == 6.0` then with `assert 0 == 6.0` — needs to be replaced with assertions against engine_cohort.x_frozen=0, engine_cohort.a_pop=expected, and a separate reducer-output test if carrier bound semantics are wanted.

### Pre-existing failures (not caused by this work)
- `test_low_evidence_single_hop_remains_near_unconditioned_oracle` — confirmed pre-existing failure by reverting and re-running; fails identically with no edit.
- `test_v3_fan_widens_through_epoch_b` — brand-new test (the file is untracked in git). Docstring says "until the projection reducer lands these tests are expected to fail — that is the point." Window-mode query, my edits don't reach.

---

## Key Decisions & Rationale

1. **Phase 3 supersedes my band-aid** — Initially I proposed a partial patch where `obs_x` for active A≠X would be sourced from carrier `upstream_obs`, and `obs_y` would zero out. Phase 3 (which the user authored mid-session) explicitly forbids this:
   - Line 188: "Carrier-side window evidence may condition carrier primitives. It should not be used as a partial patch over selected rows unless it is represented as a coherent A-clock selected-prefix object."
   - Line 187: "Window/local target frames must not seed selected active-cohort `obs_x`, `obs_y`, `x_frozen`, or `y_frozen`."
   - Line 194: "For active carrier rows without exact selected observations, the E+F trajectory is still defined by the resolved runtime's carrier and subject spans; it is not undefined and it must not fall back to X-clock observed frame prefixes."

   Direction: don't partial-patch the prefix; remove it for active and let the reducer project from runtime spans. The reducer (`_selected_cohort_group_rate_draws`) already implements the correct factorised algebra (G = p_car × F_car, H = p_subj × F_subj, Pop D + Pop C, divide once at end).

2. **`a_pop` from `dp.a` is the canonical selected base mass** — User: "for the first carrier primitive rooted at `A`, the window row's `n`/`X` count is the selected anchor-day population that reached `A` on that day." `dp.a` flows through to `engine_cohort.a_pop`. This is window evidence (per Appendix A of canonical semantics, `window-evidence(A, A-X)` is the root carrier primitive's local-clock evidence) but it is a coherent A-day count by construction — the cohort's selected base mass. Not a "fallback for missing data" — the canonical input.

3. **Displayed rate stays Y/X, never Y/A** — User flagged this explicitly. The danger: projecting `carrier ⊗ subject` alone and treating that as the displayed curve gives Y/A (a path probability). The displayed curve must be `(carrier ⊗ subject) / carrier`, both as masses, divided once at the end. `A_base` cancels in the ratio. This is preserved by the reducer's `Y_total / X_total` division.

4. **No "missing data" framing** — User retracted the agent's elaborations about hard-degrade and E-mode absence as elaborations around a phantom failure class. In the live runtime, root-window n is always there, the carrier composition is always there for active A≠X (it's what makes it active), and the subject span is always there. There is no failure class to design for.

5. **Empty-cohort handling** — User: zero-base-mass cohorts contribute zero on both numerator and denominator sides. Drops out naturally in aggregation. If all selected cohorts are empty, `ΣX = 0` → row rate undefined (None / no point), not zero. Only guard needed: divide-by-zero at final ΣY/ΣX. The reducer's existing `np.where(X_total > 1e-12, Y / X, np.nan)` already implements this.

6. **`is_active_carrier` detection** — Two options: (a) plumb a flag through; (b) detect inside `_project_runtime_rows` using `runtime.population_root != runtime.denominator_node` plus `composed_carrier is not None`. Chose (a) for `build_cohort_evidence_from_frames` because the function doesn't have the runtime yet at call time. Chose (b) for `_project_runtime_rows` because the runtime is right there.

7. **Don't change `tau_observed` / `tau_solid_max` for active** — Tried this; broke the chart's epoch boundary handling. Reverted. The fix is at the *display-evidence* layer (what the chart reads per τ), not at the epoch boundary layer.

---

## Discoveries & Gotchas

1. **`obs_x` is read by two roles** —
   - Role A: reducer's pre-frontier observed-prefix loop in `_selected_cohort_group_rate_draws` (lines 1120-1126). For active under Phase 3 this should be zero.
   - Role B: chart's per-tau evidence display in `_project_runtime_rows` (lines 1430-1454). For active this needs an A-clock projection source, NOT zero.
   - My edit zeroed `obs_x`/`obs_y` for active and got role A right, but starved role B. The user's diagnosis: "the implementation now zeros the active-carrier observed prefix arrays, and the display path still reads evidence exclusively from those arrays."

2. **Chart epoch A vs epoch B gating** — Lines 1470-1480 of `_project_runtime_rows`: midpoint is gated off (set to None) for `tau < tau_solid_max`. The chart in epoch A renders `rate` (from observed evidence), not midpoint. So when `rate=None` AND `midpoint=None`, the chart is blank in epoch A. For active under Phase 3, this is what produced the user's "no epoch a/b at all" screenshot.

3. **F_X and F_Y already computed in `_project_runtime_rows`** — Lines 1342-1374. `F_X` is `composed_carrier.cdf_mean` padded to max_tau; `F_Y` for active is the joint A→end CDF mean (via `_runtime_request_cdf_draws(runtime).mean(axis=0)`).
   - Critically: these are CDFs, not joint-reach surfaces. `F_X` is `P(timing reaches X by τ | reaches X)`, not `P(reach X by τ)`. The latter is `p_car × F_X = G` in the reducer.
   - Similarly `F_Y` is timing CDF, not joint-reach.
   - This is the bug in my display-evidence override: I used `F_X` and `F_Y` directly instead of scaling by `span_p_mean`.

4. **Reducer's correct algebra (for reference)** — In `_selected_cohort_group_rate_draws`:
   - `p_car = carrier.span_p_draws` (S, draws)
   - `F_car = carrier.cdf_draws` padded (S × T)
   - `G = p_car[:, None] × F_car` — joint A→X reach surface (per particle, per τ)
   - `p_subj = subject.span_p_draws`
   - `F_subj` padded
   - `H_subj_unshifted = p_subj[:, None] × F_subj` — joint X→end reach surface
   - Denominator (active): `X_total += x_frozen + (a_pop − x_frozen) × R_x` where `R_x = (G_future − G_anchor) / (1 − G_anchor)` clipped
   - Numerator Pop C (active): convolve `arr_inc` (from G increments) with `H_subj_unshifted` kernel, scaled by `pool_c = a_pop − x_frozen`

5. **Pop D collapses to zero under Phase 3 for active** — Because `pool_y_d = max(x_frozen − y_frozen, 0)` and both are zero for active, Pop D pool is empty. Pop C carries the entire numerator. This is correct per canonical semantics: "If a Cohort has no observed evidence (`x_d_frozen = y_d_frozen = 0`) contributes zero numerator and zero denominator at every τ" — the additive Pop D + Pop C accounting is preserved; Pop D simply has zero pool.

6. **Identity carrier semantic test** — `roots_equal_at_X` is `population_root == denominator_node`. Window mode and `cohort(A=X)` both set `population_root = X`. Even if `composed_carrier` exists in those cases (e.g. from upstream construction), the reducer treats it as identity to honour semantics.

7. **AP58 is the documented home of this bug** — [BE_RUNNER_CLUSTER.md §4](../codebase/BE_RUNNER_CLUSTER.md#L213-L214) names `build_cohort_evidence_from_frames` as the outstanding AP58 instance. 73n stages were expected to fix it via the primitive substrate but stalled (see [KNOWN_ANTI_PATTERNS.md](../codebase/KNOWN_ANTI_PATTERNS.md) AP59 — the "architecturally complete but semantically deferred" pattern).

---

## Relevant Files

### Backend (Python, `lib/runner/`)
- [graph-editor/lib/runner/cohort_forecast_v3.py](../../graph-editor/lib/runner/cohort_forecast_v3.py) — Primary edit surface.
  - `build_cohort_evidence_from_frames` (line 1800) — selected-prefix materialisation, takes `is_active_carrier` param, zeros prefix when active.
  - `_selected_cohort_group_rate_draws` (line 990) — reducer with Pop D / Pop C arithmetic. Correct algebra. No change needed.
  - `_project_runtime_rows` (line 1281) — chart row builder. Has the display-evidence override (lines 1418-1495) that is currently algebraically wrong.
  - `compute_cohort_maturity_rows_v3` (line 2256) — wrapper. Computes `_is_active_carrier` and passes to evidence builder.
  - `_composed_pair_request_cdf_draws` (line 851) — convolves carrier × subject; reference algebra.
- [graph-editor/lib/runner/forecast_runtime.py](../../graph-editor/lib/runner/forecast_runtime.py) — `ResolvedCFRuntime` carries `composed_carrier`, `composed_subject` (each `ComposedPrimitiveSpan` with `span_p_draws`, `span_p_mean`, `cdf_draws`, `cdf_mean`).
- [graph-editor/lib/runner/primitive_readout.py](../../graph-editor/lib/runner/primitive_readout.py) — `ComposedPrimitiveSpan` definition (line 455 area).
- [graph-editor/lib/runner/forecast_preparation.py](../../graph-editor/lib/runner/forecast_preparation.py) — line 582-610 confirms subject is window-led even in cohort mode.

### Tests
- [graph-editor/lib/tests/test_cohort_factorised_outside_in.py](../../graph-editor/lib/tests/test_cohort_factorised_outside_in.py) — Phase 3 outside-in tests live here.
  - `test_active_multihop_cohort_midpoint_matches_a_clock_convolution_oracle` (line 1266) — passes after the reducer-side fix.
  - `test_anchor_depth_monotonicity_for_same_subject` (line 949) — tests `evidence_x` for window vs cohort identity vs cohort active near vs cohort active far.
  - `test_same_carrier_shared_across_different_subjects` (line 1008) — fanout subjects on shared carrier.
  - `test_a_equals_x_identity_collapses_to_window` — A=X identity case (must not regress).
  - `test_cli_identity_collapse_matches_window_across_public_surfaces` (line 1462) — A=X identity, completeness scalar parity.
  - `_active_cohort_span_oracle_curve` (line 590) — the truth-file oracle: convolves carrier reach with subject CDF on A-clock.
- [graph-editor/lib/tests/test_selected_cohort_pop_d_distribution.py](../../graph-editor/lib/tests/test_selected_cohort_pop_d_distribution.py) — Phase 2 tests + the partial-patch test that needs reauthoring (line 125).
- [graph-editor/lib/tests/test_cohort_maturity_v3_projection_contract.py](../../graph-editor/lib/tests/test_cohort_maturity_v3_projection_contract.py) — brand-new file, untracked. Phase 1 contract pin tests.

### Documentation
- [docs/current/cohort-maturity-selected-cohort-projection-pattern.md](../cohort-maturity-selected-cohort-projection-pattern.md) — implementation pattern, **Phase 3 added during this session** (line 175 onwards).
- [docs/current/cohort-maturity-mc-wrong-object-problem-statement.md](../cohort-maturity-mc-wrong-object-problem-statement.md) — companion problem statement.
- [docs/current/codebase/COHORT_ANALYSIS_NUMERATOR_DENOMINATOR_SEMANTICS.md](../codebase/COHORT_ANALYSIS_NUMERATOR_DENOMINATOR_SEMANTICS.md) — canonical semantics. Phase 3 verified conformant.
- [docs/current/project-bayes/59-cohort-window-forecast-implementation-scheme.md](../project-bayes/59-cohort-window-forecast-implementation-scheme.md) — target runtime contract.
- [docs/current/project-bayes/47-multi-hop-cohort-window-divergence.md](../project-bayes/47-multi-hop-cohort-window-divergence.md) — the multi-hop subject divergence (separate but related defect).
- [docs/current/codebase/BE_RUNNER_CLUSTER.md](../codebase/BE_RUNNER_CLUSTER.md) — points at AP58 as outstanding instance (§4).
- [docs/current/codebase/KNOWN_ANTI_PATTERNS.md](../codebase/KNOWN_ANTI_PATTERNS.md) — AP58 (forking by case) and AP59 (architecturally complete, semantically deferred).

---

## Next Steps

1. **Fix the display-evidence formula in `_project_runtime_rows`**. Currently at [cohort_forecast_v3.py:1477-1485](../../graph-editor/lib/runner/cohort_forecast_v3.py#L1477-L1485):
   - Current (wrong): `ev_x = a_pop × F_X[τ]`, `ev_y = a_pop × F_Y[τ]`. Misses `span_p_mean` on both sides.
   - Right shape: `ev_x = a_pop × carrier.span_p_mean × F_X[τ]` (joint A→X reach mass), `ev_y = a_pop × p_car × p_subj × F_carrier⊗subject[τ]`.
   - Cleanest implementation: read `runtime.composed_carrier.span_p_mean` and `runtime.composed_subject.span_p_mean`, multiply through. Or alternatively: use the reducer's per-particle output `rate_draws.mean(axis=0)` for the displayed `rate`, and derive `ev_x`/`ev_y` from `X_total.mean(axis=0)` and `Y_total.mean(axis=0)` — but those aren't currently exposed by the reducer (would need to plumb).
   - Simplest path: reuse the reducer's per-particle output. `rate_draws` is already computed at line 1329. Take `rate_draws.mean(axis=0)` per τ for the displayed rate. For `evidence_x`/`evidence_y` separately, expose `X_total` and `Y_total` from `_selected_cohort_group_rate_draws` (return them alongside `rate`) and the per-τ display reads `Σ_particle X / S` and `Σ_particle Y / S`.
2. **Verify chart renders correctly end-to-end**. Use `bash graph-ops/scripts/analyse.sh <graph> <dsl> --type cohort_maturity ...` for the speed-mark fixture, or trigger from the live UI on the same DSL the user was using ("Switch registered → Switch success" with `cohort(...)`).
3. **Reauth `test_active_selected_cohort_observed_x_is_controlled_by_carrier_arrivals`** at [test_selected_cohort_pop_d_distribution.py:125](../../graph-editor/lib/tests/test_selected_cohort_pop_d_distribution.py#L125). Replace assertion `cohort.obs_x[2] == 6.0` with assertions appropriate for Phase 3:
   - `cohort.x_frozen == 0.0` and `cohort.obs_x[2] == 0.0` (no frame-seeded prefix for active)
   - `cohort.a_pop == 100.0` (selected A-day base mass survives)
   - The carrier-bound semantics belong in a reducer-level test that calls `_selected_cohort_group_rate_draws` and checks `X_total[:, τ]` matches `a_pop × p_car × F_car[τ]` per particle. (Already covered structurally by the existing pop_d Phase 2 tests + the multi-hop oracle test.)
4. **Run the full active-cohort regression set** in [test_cohort_factorised_outside_in.py](../../graph-editor/lib/tests/test_cohort_factorised_outside_in.py): `test_a_equals_x_identity_collapses_to_window`, `test_anchor_depth_monotonicity_for_same_subject`, `test_same_carrier_shared_across_different_subjects`, `test_active_multihop_cohort_midpoint_matches_a_clock_convolution_oracle`, the CLI parity tests. Confirm all pass. Note pre-existing failure `test_low_evidence_single_hop_remains_near_unconditioned_oracle` is unrelated.

---

## Open Questions

1. **(Non-blocking)** — Should the chart's `evidence_x`/`evidence_y` for active A≠X be the per-particle MEAN of `X_total`/`Y_total`, or the per-particle MEDIAN, or the deterministic `a_pop × p_car × F_car`/etc? The reducer outputs draws; the chart needs scalars. Mean is the natural choice for a "displayed mass" and matches what midpoint→median produces for rate. Confirm with user before plumbing if ambiguous.
2. **(Non-blocking)** — `_selected_cohort_group_rate_draws` currently returns only `rate` (S, T). To use it as the source of display evidence, it would need to also return `X_total` and `Y_total` arrays (or expose a parallel helper). Worth adjusting return shape vs computing display evidence separately?
3. **(Non-blocking)** — Phase 3 line 195: "evidence-only rows should be absent unless exact selected A-clock observations are available." Under the corrected understanding, the *displayed rate* (E+F mode) is the projection. But the *E-only mode* — what does that show? Per Phase 3 strict, blank. Confirm this is intended UX (the chart has an E-only display toggle the user has shown a screenshot of in this conversation that includes the orange "Current" overlay; verify orange line behaviour for active under Phase 3).
4. **(Non-blocking)** — Should we delete `test_active_selected_cohort_observed_x_is_controlled_by_carrier_arrivals` outright (it pins the partial-patch shape Phase 3 forbids; the multi-hop oracle test in outside-in covers the contract end-to-end), or rewrite it to assert Phase 3-conformant invariants on the evidence builder?
