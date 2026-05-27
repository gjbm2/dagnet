# Selected-Cohort Projection Cutover — Action Plan

**Status**: active execution plan
**Date**: 15-May-26
**Replaces**: prior `selected-cohort-projection-cutover-plan.md` and the partial `ACTION_PLAN_selected_cohort_spine_cutover.md` draft
**Phase context**: discharges Phase 6 implementation + Phase 7 + Phase 8 + Phase 9 of [model-first-strict-span-cutover-plan-13-May-26.md](model-first-strict-span-cutover-plan-13-May-26.md). Phase 5.5 (extracted spine) is closed; this plan starts from that state.

## Source contracts (external)

| Reference | What it pins |
|---|---|
| [phase-6-evidence-operator-contract.md](phase-6-evidence-operator-contract.md) | Four rules (§3), unified DAG mass-propagation (§4.3), cohort cancellation (§4.4), window non-cancellation (§4.5), **empirical kernel form** (§4.9), spine mapping (§5), blind test families (§6.1, §6.2), 14-failure crosswalk (§6.5). **Supersession note (25-May-26)**: the old adjusted-evidence / IPW / MCAR §5.6 branch is no longer an active cutover requirement; coverage was reduced to row applicability/freshness after the coverage-design rollback. |
| [checkpoint-frontier-coverage-proposal.md](checkpoint-frontier-coverage-proposal.md) | Historical coverage proposal. Its adjusted-evidence/IPW direction was not adopted as the active cutover contract after coverage proved poorly designed for row semantics. |
| [cohort-maturity-evidence-coverage-design.md](../cohort-maturity-evidence-coverage-design.md) | Three-state per-edge trichotomy (§3.1), per-row coverage (§2), display semantics (§4) |
| [COHORT_ANALYSIS_NUMERATOR_DENOMINATOR_SEMANTICS.md](../codebase/COHORT_ANALYSIS_NUMERATOR_DENOMINATOR_SEMANTICS.md) | Cohort vs window semantics; Appendix A invariant 5 (two-clocks T1 = role-root) |
| [CF_ROW_PIPELINE.md](../codebase/CF_ROW_PIPELINE.md) | Current legacy pipeline; the seam invariant (§3) |
| [FORECAST_RUNTIME_ARCHITECTURE.md](../codebase/FORECAST_RUNTIME_ARCHITECTURE.md) | `ResolvedCFRuntime` shape; live call order |
| [INVARIANTS.md](../codebase/INVARIANTS.md) I-45/I-46/I-47/I-48 | One resolution path; projections don't re-decide; engine fallbacks perimeter-only; single conditioning locus |
| [KNOWN_ANTI_PATTERNS.md](../codebase/KNOWN_ANTI_PATTERNS.md) AP58/AP59 | Forking by case; "architecturally complete" closure with the new path default-OFF |

This plan does not restate the algebra or the contracts. It states the imperatives needed to bring the engine, runtime, and row pipeline into conformance.

## Goal

Replace the legacy selected-Cohort row machinery (`_SelectedSourceDayMass`, `_CarrierOnlyDenominatorPrefix`, `_RateAttributedSubjectPrefix`, `_selected_cohort_group_rate_draws`, `_build_observed_span_evidence_surface`, `_join_conditioned_carrier_backmap`, `_interpolated_rate_at`, and `SelectedAClockEvidence` as a prefix authority) with a Spine-orchestrated row reducer that reads from **two operator families** through one DP/readout core:

- **Conditioned model operator** (already in place, per Phase 6 §4.1) — per-edge kernel is the fitted posterior CDF (`p × Δcdf`) from `ConditionedTransitionPrimitive` via `condition_primitive`. Drives `midpoint`, `fan_*`, `forecast_x`, `forecast_y`, `completeness`, and the model-only surfaces.
- **Empirical evidence operator** (landed, per Phase 6 §4.9) — per-edge kernel is `Δk_emp/n_emp` from admitted snapshot rows on the selected clock, forward-filled across absent ages, per-draw. Drives strict per-anchor `evidence_x_strict_by_anchor_tau` / `evidence_y_strict_by_anchor_tau`. The reducer derives only strict row-level surfaces (`evidence_x`, `evidence_y`, `rate`) from these. The abandoned adjusted/IPW surfaces (`evidence_x_adjusted`, `evidence_y_adjusted`, `rate_adjusted`) are deliberately absent.

Both operators share: the same admitted candidate rows, the same arrival-map clock placement, the same `compose_primitive_span` composer, the same DAG DP, the same three-stream support/exposure mask, the same `seed_subject_from_carrier` per-cohort handoff. They differ only in the per-edge kernel construction (parametric posterior vs empirical row-derived).

**Critical**: the cutover must not collapse the empirical evidence surface into the conditioned model surface. Doing so would silently change E+F semantics (evidence_y would become posterior-projected instead of observed). Current legacy E+F semantics are correct and must be preserved; what changes is how they are computed.

## Outcome (unambiguous)

When this plan closes:

1. `_project_runtime_rows` calls exactly one selected-Cohort projection function for window, `cohort(A=X)`, and active `cohort(A!=X)`. No mode branch at the call site, no mode flag inside the reducer.
2. A **new empirical evidence operator** exists in the spine alongside the conditioned model operator. Both feed a single `project_selected_cohort_rows` reducer through the same DP/readout core; the reducer routes row fields to the appropriate operator (model fields ← conditioned; evidence fields ← empirical).
3. Per-cell observation masks (Phase 6 §4.7) plumb from snapshot evidence rows through `bind_primitive_evidence` → `condition_primitive` → `ConditionedTransitionPrimitive` → `compose_primitive_span` → the composer's three-stream DP, and equivalently through the new empirical-evidence path. The `mask = np.ones((S, T))` placeholder at [subject_span_composer.py:473](../../graph-editor/lib/runner/subject_span_composer.py#L473) is gone.
4. `_SelectedSourceDayMass`, `_CarrierOnlyDenominatorPrefix`, `_RateAttributedSubjectPrefix`, `_selected_cohort_group_rate_draws`, `_build_observed_span_evidence_surface`, `_build_zero_edge_observed_surface`, `_join_conditioned_carrier_backmap`, `_interpolated_rate_at` (and its caches), `_composed_pair_request_cdf_draws`, and `generalised_span_model_shadow.py` are deleted. `grep -rn` over `graph-editor/lib/runner/` returns zero hits.
5. `SelectedAClockEvidence` is reduced to a diagnostic/schema adapter — owns no amplitude arithmetic, no prefix construction, no frontier authority.
6. Outside-in oracle remains green. **Strict evidence semantics are preserved exactly** — `evidence_x`, `evidence_y`, and `rate` come from the empirical spine and match the accepted selected-clock evidence contract. `coverage` is no longer the old masked-support/IPW surface; it is a simple row applicability/freshness signal. The abandoned `rate_blended` / `rate_adjusted` line is not a closure target. No new xfail markers. No loosened tolerances. No fixture or DSL weakening. No flag-OFF acceptance (per AP59).
7. Codebase docs ([CF_ROW_PIPELINE.md](../codebase/CF_ROW_PIPELINE.md), [FORECAST_RUNTIME_ARCHITECTURE.md](../codebase/FORECAST_RUNTIME_ARCHITECTURE.md)) describe the cutover state, not the legacy state.

## Risk structure (honest)

The cutover is **monolithic** at one line — the call site at [cohort_forecast_v3.py:5382](../../graph-editor/lib/runner/cohort_forecast_v3.py#L5382). Per-mode staging is forbidden by the mode-blind contract (re-introducing a per-mode branch is the AP58 fork the cutover exists to remove). Per-fixture staging would require a runtime topology flag inside the reducer — same problem. The new reducer takes all three modes the moment the call-site is flipped.

Two real risk gates:

1. **Build acceptance** — Phase 6 §6.1 / §6.2 blind algebra tests. Catches algorithmic correctness against the contract. Doesn't touch production.
2. **Cutover acceptance** — outside-in oracle. Catches integration with real fixtures. **This is the risk event.**

Everything before the call-site flip is a non-event against production behaviour (legacy is still authoritative). Everything after it is grep-and-delete (no behavioural change once legacy is unreachable).

Shadow comparison (running new alongside legacy under `--diag`) is an **optional implementer triage aid**, not a gate. Parity against legacy is misleading where legacy is known-buggy; tied as a gate, it pulls the new path back toward bugs the cutover exists to remove.

## Hard constraints

- **No role-by-role migration.** The call-site flip moves all three modes simultaneously.
- **No new production branch.** The new reducer does not coexist with the legacy reducer in production. Diagnostic comparison hooks are admissible during build; they are removed at cutover.
- **No Pop C / Pop D enumeration.** The reducer projects ΣY/ΣX directly. The carrier-residual and subject-residual conditional formulas live inside the DAG DP, not as arithmetic blocks in the reducer.
- **No mode flag inside the reducer.** Mode is encoded upstream — in which root mass is supplied, in which carrier span is supplied (zero-edge identity for window / A=X, active for A≠X), in which primitives are bound on which arrival map.
- **AP59 closure discipline.** Cutover is complete only when the legacy path is unreachable. "Architecture done, semantics deferred" or "tests pass with legacy still authoritative" is not closure.

---

## Implementation progress

<!-- managed by /implement-carefully — edit checkboxes manually only when the skill is not running -->

- [x] Stage 1 — Prep — completed 16-May-26
- [x] Stage 2 — Build — completed 16-May-26
  - [x] Stage 2(a) — atoms 2.1–2.3 (per-anchor outputs) + core 2.4/2.5 tests — landed 16-May-26
  - [x] Stage 2(b) — strict empirical spine and §6.1/§6.2 blind tests landed 16-May-26. The adjusted/IPW/MCAR branch that briefly existed here is superseded by the coverage rollback; do not count it as remaining work.
  - **16-May-26 review note** — Atom 2.1 source-day mask defect fixed after review: conditioned support/exposure now read row presence by source day where the primitive binding supplies source-day masks, while preserving local-clock aggregate masks for identity/window helper bindings.
  - **25-May-26 coverage rollback note** — adjusted evidence, IPW, MCAR recovery, and `rate_adjusted` are no longer active requirements. Coverage is an applicability/freshness display scalar, not an evidence reweighting denominator.
  - **16-May-26 kernel-construction resolution** — the Appendix A discretisation question is answered in code by separating two surfaces from the same per-draw particles: endpoint `G(τ)` is what lives on `TimingPosterior.cdf_draws` (the chart-published "value at age τ" surface, consumed by the composer and the legacy reducer); day-averaged `B(τ) = ∫_τ^{τ+1} G(v) dv` stays local to the IS likelihood cell-differencing in `primitive_conditioning._run_is_proposal` so cell probabilities are formed against the daily-bucket convention snapshot rows already use. The two helpers (`_build_per_draw_cdf` for endpoint, `timing_particles.build_row_aligned_lognormal_cdf_from_draws` for row-aligned) are both scipy-free via `numpy_stats.normal_cdf`. The earlier failure mode — feeding the row-aligned `B(τ)` onto `TimingPosterior.cdf_draws` — shifted the model curve ~½ day forward and was visible as the no-evidence single-hop oracle mismatch in `test_no_evidence_single_hop_matches_unconditioned_fw_convolution_midline` and the two `test_v3_empty_frames_*` contract tests.
- [x] Stage 3 — Cut over — completed 26-May-26 (committed `5ce6fe8a2`). Call-site flipped to `model_span_spine.project_selected_cohort_rows`; legacy `_selected_cohort_group_rate_draws` is now uncalled dead code (Stage 4 deletes it). Outside-in gate reported green. No-weakening audit: the three deleted test files are superseded/migrated, not dropped failures — `test_active_cohort_display_invariants.py` pinned the rolled-back masked-support coverage design + legacy observed-prefix coupling (covered-zero/absent invariants migrated to the new blind suites); `test_mcar_sparsity_recovery.py` superseded by the coverage rollback (Atom 2.5); `test_span_engine_generalisation.py` was a build-phase suite. All five surviving `strict=True` xfails belong to other projects (73q ×3, Doc 60 WP8 ×2), none named this cutover.
- [x] Stage 4 — Clean up — completed 27-May-26. Built `SelectedRetrievalFrontier` (behaviour-preserving frontier re-source); deleted legacy authorities (`_selected_cohort_group_rate_draws` and the pre-Atom-6 spliced surfaces `rate_draws_spliced`/`x_draws_spliced`/`y_draws_spliced` + `shadow_delta` diagnostic); grep-verified zero residual legacy refs in lib/runner; I-47 audit (removed `_origin_day_for_anchor` fallback + 2 `np.clip` value-clamps + dead `_degraded_timing`; retained 3 documented load-bearing span-core guards — accepted deviation); rewrote 6 codebase docs; perf review (hot path already BLAS-vectorised, no change). Final spine-suite gate green (39/39 in the one migrated file; other 8 gate files unchanged and green). Test migration: 29 spine tests moved to real-date anchors, ~10 property tests retargeted `*_draws_spliced`→`ef_*`, and `test_f_surface_is_unspliced_while_ef_surface_is_prefix_pinned` rewritten to the genuine post-frontier separation (ef continues from the empirical prefix; f carries the unspliced model) — the old "surfaces coincide past frontier" assertion was a spliced-era artifact, not weakened.
- [x] Stage 5 — stale FE / output follow-ups — completed 27-May-26. 5.1: removed the dead `rateBlended`/`rateBlendedEpochA` FE surface in `cohortComparisonBuilders.ts` (BE emits no `rate_blended`/`rate_adjusted` since the coverage rollback, so the hidden epoch-A diagnostic was permanently empty) — dispatch test 47/47 green. 5.2: active FE paths verified intact (strict `baseRate` E line, `midpoint` E+F curve, `coverage`/`modelMidpoint`/`modelCurveMidpoint`) — no edit. 5.3: in-scope `src/` copy audit clean (no adjusted/IPW/coverage-blend promises for the cohort chart); the stale `lag-statistics-reference.md` §7.0 "adjusted evidence rate" is a 73f-owned FE-topo-blend artifact in a different subsystem, left alone. 5.4: codebase `GLOSSARY.md` gained a "Selected retrieval frontier / frontier τ per anchor" entry; "row-presence mask" deliberately NOT added (it did not survive the coverage rollback — `observation_mask` exists nowhere in `lib/runner/`); public `glossary.md` already correct (coverage-as-applicability, frontier, unadjusted strict evidence; no IPW/MCAR). 5.5: this plan + the superseded `ACTION_PLAN_selected_cohort_spine_cutover.md` archived to `docs/archive/project-generalise/`, with the active inbound links (README, INVARIANTS, KNOWN_ANTI_PATTERNS, cf-defensive-coding-audit, phase-6-evidence-operator-contract, model-first-strict-span-cutover-plan, and 3 test-comment headers) repointed; the two point-in-time handover notes left as historical.

---

## Stage 1 — Prep

### Atom 1.1 — Photocopy

`/photocopy phase-7-selected-cohort-cutover-start`. Record stash name in the tracking ledger.

### Atom 1.2 — Baseline test capture

Already passing. Record the pass/skip/xfail counts in the tracking ledger. These are the floor for every subsequent gate. No `head` / `tail` on test output.

### Atom 1.3 — Strict-xfail ledger

Grep `grep -rn 'strict=True' graph-editor/lib/tests/` and record every xfail whose `reason=` names this cutover (Pop D/C deletion, mode-blind reducer, mask plumbing, multi-hop evidence parity) as the flip-to-green trigger. They must XPASS by Stage 3 acceptance and the markers must be deleted in the same commit. AP59 demands the deletion, not just the XPASS.

---

## Stage 2 — Build

Four pieces of code land here. All are purely additive to production: legacy remains authoritative until Stage 3.

### Atom 2.1 — Plumb the per-cell observation mask

The mask convention (Phase 6 §4.7): for every concrete edge U→V and every (source_day, age), `mask = 1` iff the snapshot at the request's retrieval window contains a row for this edge at that cell (covered-positive **or** covered-zero are both `mask = 1`); `mask = 0` iff no row exists (absent). Independent of `k` / `n` values — row presence only.

Four files change:

- [primitives.py](../../graph-editor/lib/runner/primitives.py) — `ConditionedTransitionPrimitive` carries the per-(draw, τ) observation mask, shape `(S, T_p)`. **Mask default depends on why the path is prior-only**: F-mode unconditioned overlays (no evidence consulted by design) leave the mask at all-ones — safe because coverage / exposure are never read from this path. A conditioned path with zero admitted rows (evidence pool empty after admission) MUST emit an all-zeros mask, not all-ones — defaulting to all-ones here would silently claim full observation and inflate coverage / exposure for an evidentially-empty edge. The distinction lives in `bind_primitive_evidence` / `condition_primitive`: F-mode overlays bypass evidence binding; conditioned paths always go through evidence binding and emit a row-presence mask (all-zeros where no rows are admitted).
- [primitive_evidence.py](../../graph-editor/lib/runner/primitive_evidence.py) — `bind_primitive_evidence` emits the mask from candidate rows: 1 where any admitted row exists, 0 elsewhere. Projection onto the (S, T_p) grid uses the same arrival-weighted projection the value side already applies.
- [primitive_conditioning.py](../../graph-editor/lib/runner/primitive_conditioning.py) — `condition_primitive` forwards the mask unchanged. Conditioning does not modify observation.
- [subject_span_composer.py:473](../../graph-editor/lib/runner/subject_span_composer.py#L473) — replace `mask = np.ones((S, T))` with a read of the per-edge primitive's mask, padded via `_align_cdf_grid` to the composer's `T`. Delete the "Phase 7 plumbs real masks here" comment.

The mask is shared by both operator families introduced in 2.2 and 2.3 — it is row-presence data, not posterior-derived.

### Atom 2.2 — Write the new empirical evidence operator

**THE LOAD-BEARING ATOM.** Add a second operator family alongside the conditioned model operator — sharing the same admitted rows, clock placement, DAG topology, DP/readout core, and three-stream mask machinery; differing only at the per-edge kernel supply boundary (observed `(n, k)` rows instead of fitted parametric posterior draws). The chart's evidence surfaces (`evidence_x`, `evidence_y`, `rate`) and the strict per-anchor cumulatives must come from this operator, not from the conditioned posterior — sourcing them from posterior draws would silently change E+F semantics.

**Core algebra**: for one edge `U → V`, source day `s`, and age `τ`, define the empirical cumulative rate:

```
B_UV(s, τ) = k_UV(s, τ) / n_UV(s)
```

The empirical operator supplies the per-day **rate kernel**:

```
kernel_UV^empirical_value(s, τ) = ΔB_UV(s, τ)
                                 = Δk_UV(s, τ) / n_UV(s)
```

The span DP then scales that kernel by the incoming selected mass at the edge source:

```
effective_Δk_UV(s, τ) = m_U(s) × Δk_UV(s, τ) / n_UV(s)
```

This is Phase 6 §4.3's `m_U(s) × Δk / n` term. In the single-hop / cohort-cancellation case, `m_U(s) = n_UV(s)`, so the formula degenerates to raw observed `Δk`. In window multi-hop, `m_U(s)` is synthetic propagated mass and `n_UV(s)` is the downstream edge's local observed denominator, so the ratio does **not** cancel; the operator deliberately synthesises an effective `k` for the propagated cohort.

**What this is not**: do not fake the empirical operator as a model primitive supplying `probability_draws = k(∞)/n` and `timing_draws = k(τ)/n` — `k(τ)/n` is an amplitude-bearing cumulative rate, not a conditional timing CDF, and that shape relies on accidental normalisation to avoid double-scaling. If an implementation adapts empirical rows into an existing composer hook, the adapter must emit `Δ(k/n)` explicitly as kernel-supply code and preserve `p = 0`, covered-zero, absent-support, and mask cases.

**Location**: new module `graph-editor/lib/runner/empirical_evidence_operator.py`. Imported by `model_span_spine.resolve_request_spans` or by the sibling operator-supply path that constructs empirical `ComposedPrimitiveSpan` surfaces.

**Shape**: define an empirical edge-operator surface, provisionally `EmpiricalEvidencePrimitive`, that exposes kernel data rather than posterior semantics:

- `value_kernel_draws() → ndarray(S, T_p)` — per-draw empirical value kernel `Δ(k_emp/n_emp)` on the row-aligned daily grid. Per-draw via arrival-weighted aggregation of admitted rows (Phase 6 §4.9); not a broadcast of a single deterministic surface.
- `support_kernel_draws() → ndarray(S, T_p)` — value kernel multiplied by the row-presence mask per Phase 6 §4.8. **Note**: under §4.9 the empirical value kernel is already zero at absent cells, so `value × mask = value` identically. This stream is retained for interface symmetry with the conditioned operator but is structurally redundant against value for the empirical kernel; coverage / exposure are not read from the empirical operator (Phase 6 §4.9 — coverage requires the parametric kernel's positive-everywhere value stream).
- `exposure_kernel_draws() → ndarray(S, T_p)` — `unit_density_shape × mask` per edge. Retained for interface symmetry. Per Phase 6 §4.9, exposure / coverage are read exclusively from the conditioned operator's streams; this empirical exposure is not used in row-level coverage computations.
- `observation_mask_draws() → ndarray(S, T_p)` — row-presence mask from Atom 2.1's plumbing; `1` for observed-positive or covered-zero, `0` for absent.

The empirical operator is **per-draw**, not deterministic — see Phase 6 §4.9. The arrival-map weighting that aggregates rows into `n_emp(s, draw)` and `k_emp(s, age, draw)` is per-draw because the carrier's reach to U varies across posterior draws; the same admitted rows produce non-identical per-edge kernel realisations across the `S` axis. Storage shape is `(S, T_p)`, not `(1, T_p)`.

**Builder**: a function `build_empirical_evidence_primitive(*, transition, primitive_scope, arrival_weights, request_candidates) -> EmpiricalEvidencePrimitive`. Reads the same admitted candidate rows `bind_primitive_evidence` reads. Builds the row-aligned cumulative empirical rate `B(s, age) = k(s, age) / n(s)`, applies the legacy row-policy decisions that Phase 6 preserved (per-source-day support, admissible source-day aggregation, latest-at-or-before carry-forward where that is the chosen empirical definition), differences once to produce `ΔB`, and emits the value/support/exposure kernels. The arrival-map weighting is the same logic `bind_primitive_evidence` already applies for parametric conditioning — re-use that path; do not duplicate.

**Spine integration**: extend [`model_span_spine.resolve_request_spans`](../../graph-editor/lib/runner/model_span_spine.py) or its operator-supply sibling to also build empirical edge operators for every edge in the carrier and subject closures, compose them through the same DAG DP/readout core, and return the result as new fields on `ResolvedSpans`:

- `ResolvedSpans.composed_empirical_carrier: ComposedPrimitiveSpan` — A → X carrier through empirical kernels.
- `ResolvedSpans.composed_empirical_subject: ComposedPrimitiveSpan` — X → end subject through empirical kernels.

The existing `composed_carrier` / `composed_subject` keep their meaning (conditioned operator). The empirical pair is sibling, not replacement. The shared contract is "same DP/readout core and same node-id-keyed surfaces", not "same posterior primitive interface".

**Architectural sanity**: at saturation, the empirical operator's terminal cumulative equals the algebraic `Σ_s m_U(s) × k_UV(s,∞) / n_UV(s)` propagated through the chain. In the exact single-hop evidence case this equals raw `Σ k_observed_at_saturation`. In synthetic multi-hop cases, especially `window()` multi-hop, it is intentionally an effective selected-cohort count scaled from local edge evidence. The conditioned operator's saturation remains the model projection (`N × Π p_posterior` under the relevant root mass). These are different quantities — when evidence is rich and the parametric fit is good they're close; when evidence is sparse, local, or the fit deviates they diverge. That divergence is the chart's E vs F-mode story; the two operators MUST be separate to preserve it.

**Acceptance**:
- `composed_empirical_carrier` and `composed_empirical_subject` exist on `ResolvedSpans` for every request.
- Same admitted candidate rows feed both operator families.
- Same arrival-map weighting applied in both.
- Same row-presence mask applied in both (Atom 2.1), and the mask is row-presence, not `k > 0`.
- Same `seed_subject_from_carrier` will work against either span in Atom 2.3.
- Focused test in `test_empirical_evidence_operator.py`: single-hop saturation degenerates to raw `Σ k_observed`; window multi-hop saturation equals the analytic `Σ_s m_U(s) × k(s,∞)/n(s)` effective-count oracle; the conditioned operator's saturation is independently the model projection. The two are explicitly checked to be allowed to differ.

### Atom 2.3 — Build `project_selected_cohort_rows`

One new function in [model_span_spine.py](../../graph-editor/lib/runner/model_span_spine.py). **Reads from BOTH operator families.** Routes row fields to the appropriate operator.

Signature:

```
project_selected_cohort_rows(
    *,
    composed_carrier: ComposedPrimitiveSpan,          # conditioned (for model surfaces)
    composed_subject: ComposedPrimitiveSpan,          # conditioned
    composed_empirical_carrier: ComposedPrimitiveSpan,   # empirical (for evidence surfaces)
    composed_empirical_subject: ComposedPrimitiveSpan,   # empirical
    selected_cohorts: Sequence[Mapping[str, Any]],
    horizon: int,
) -> SelectedCohortRowProjection
```

`selected_cohorts` as before. `SelectedCohortRowProjection` grows fields to distinguish the two operator readouts:

- **From conditioned operator (model surfaces)**: `rate_draws_model`, `x_draws_model`, `y_draws_model` shape `(S, T)`. These drive `midpoint`, `fan_*`, `forecast_x`, `forecast_y`.
- **Applicability/freshness coverage (corrected 25-May-26)**:
  `applicability_row` and `applicable_cohort_count` are simple selected-Cohort
  freshness signals. They do not come from masked support/exposure streams
  and do not drive IPW or adjusted evidence.
- **From empirical operator (strict per-anchor cumulatives, per Phase 6 §4.9)**: `evidence_x_strict_by_anchor_tau`, `evidence_y_strict_by_anchor_tau` — `Mapping[anchor_day, ndarray(T,)]`. These are the unadjusted per-anchor cumulatives, summed across draws to the per-anchor scalar surface. The reducer derives the strict row-level fields (`evidence_x`, `evidence_y`, `rate`) from these; no adjusted row fields are produced.

Body — top-to-bottom, no branches, two operator passes:

1. Build per-cohort seed at X via `seed_subject_from_carrier(...)` against `composed_carrier` (conditioned). Per-anchor seed for model projection.
2. Build per-cohort seed at X via `seed_subject_from_carrier(...)` against `composed_empirical_carrier`. Per-anchor seed for evidence projection. (Identity carrier degenerates trivially in both — zero-edge identity span has `δ(0)` at root.)
3. Read the conditioned operator's value stream for model surfaces:
   aggregate per (draw, anchor, τ) → `rate_draws_model`,
   `x_draws_model`, `y_draws_model`, plus the unspliced `f_*`
   conditioned-model surface used by the chart-surface workstream.
4. Convolve empirical seed through `composed_empirical_subject` per-node ledgers — value stream only, per Phase 6 §4.9. Aggregate per (anchor, τ) → `evidence_x_strict_by_anchor_tau`, `evidence_y_strict_by_anchor_tau`. These are the per-anchor strict cumulatives the reducer uses to derive row-level strict evidence.
5. Applicability per anchor comes from the selected-Cohort input horizons (`tau_observed` / `tau_max`), not masked support/exposure coverage.
6. Return populated dataclass.

The reducer never reads `runtime.population_root`, `runtime.denominator_node`, `is_window`, `is_active_carrier`, `engine_cohorts.obs_x/obs_y`, or any mode flag. Identity vs active produces different numerics solely because the carrier spans differ.

### Atom 2.4 — Blind algebraic tests

New file: `graph-editor/lib/tests/test_model_span_spine_selected_cohort.py`. Coverage:

- Phase 6 §6.1 invariants 1–12 against the **conditioned operator** (parametric kernels).
- Phase 6 §6.2 W1–W4 against the conditioned operator.
- **Two-surface separation tests**: for a fixture where parametric posterior and empirical rate visibly disagree (sparse evidence; bimodal data; outlier-shaped k/n curve), verify that:
  - `rate_draws_model` reflects the parametric posterior.
  - `evidence_x_by_anchor_tau` / `evidence_y_by_anchor_tau` reflect the empirical rows.
  - The two surfaces are **distinct** (not numerically equal) but **clock-aligned** (the τ axis is the same; the same per-anchor seed flows through both).
- **Same-data parity test**: for a fixture where the parametric fit is good and evidence is rich, verify that empirical-operator saturation Y ≈ conditioned-operator saturation Y to within sampling noise. This is the "agreement at the limit" check — they may disagree at finite τ, but at saturation with rich data they converge.
- **Strict evidence / applicability split (corrected 25-May-26)**:
  - Strict path: `evidence_x` / `evidence_y` / `rate` equal the accepted empirical selected-clock surface.
  - Applicability path: `coverage` fades as selected Cohorts move past their last fresh observation.
  - No adjusted evidence, no IPW divide, and no per-terminal coverage arithmetic are active cutover requirements.

### Atom 2.5 — MCAR sparsity oracle (superseded)

This atom is superseded by the 25-May-26 coverage rollback. The MCAR/IPW
oracle was only meaningful for the abandoned adjusted-evidence design.
Do not treat `test_mcar_sparsity_recovery.py` or Horvitz-Thompson
variance bounds as Stage 3 blockers for the corrected strict-evidence
cutover.

### Build acceptance

- Stage 1.2 baseline still passes (mask plumbing is behaviour-preserving — all-ones default for the F-mode overlay path that legacy callers exercise; empirical operator is purely additive, not on any production call site).
- `test_empirical_evidence_operator.py` all green (single-hop saturation matches raw `Σ k_observed`; multi-hop saturation matches the effective-count oracle `Σ_s m_U(s) × k(s,∞)/n(s)`; arrival-map weighting matches `bind_primitive_evidence`).
- `test_model_span_spine_selected_cohort.py` all green — both algebraic invariants AND two-surface separation tests.
- `test_subject_span_composer.py`, `test_span_readout.py`, `test_span_operator_supply.py`, `test_span_engine_generalisation.py` all green.

If any §6.1/§6.2 invariant fails, the algebra is wrong — fix here, not in Stage 3. If the two-surface separation test fails (the surfaces collapse), the empirical operator is wired wrong — fix here.

### Where the legacy quadrature machinery goes

Legacy carried numerical machinery for turning sparse `(source_day, snapshot_date, n, k)` rows into a dense per-(s, τ) empirical rate kernel: `_interpolated_rate_at` (linear interpolation + 3-point Simpson-style curvature correction), `_build_source_day_rate_cache` / `_build_age_only_rate_cache` (per-s vs stationarity-fallback aggregation), `_monotone_rate_array` (cumulative-to-increment), midpoint placement, forward-fill (`n_atorbef`, `k_atorbef`).

That entire machinery is **deleted**, not relocated. Phase 6 §3.1 + §4.9 are explicit: empirical rows already carry the row-bucket interpretation (snapshot `k_observed(s, age) / n_observed(s)` integrates same-day conversions by construction); the empirical kernel applies no continuous-model quadrature, no interpolation, no midpoint shift, no curvature correction. Forward-fill of the cumulative across absent ages is the only completion policy, and it emerges structurally from the increment form (Δ = 0 at absent cells) — not as a separate code path.

| Legacy mechanism | Disposition in the empirical operator |
|---|---|
| Linear interpolation between observed `(τ, k/n)` points | **Forbidden.** No interpolation in the empirical kernel builder. Absent cells contribute `Δrate = 0`; the cumulative jump is absorbed at the next observed age. Sparsity surfaces as reduced coverage downstream, not as interpolated values. |
| 3-point curvature correction | **Forbidden.** No curvature correction. The empirical cumulative `R(s, age) = k(s, age)/n(s)` is read from rows, forward-filled, and differenced — nothing more. |
| Midpoint placement at first subject layer | **Forbidden.** No midpoint shift on empirical rows. Phase 6 §3.1 row-bucket convention captures same-day conversions empirically; midpoint corrections are a continuous-model artefact and do not apply. The single-hop X-clock case must reproduce admitted `window()` evidence exactly — any midpoint shift would break that invariant. |
| Forward-fill within source day | Retained as the canonical CDF completion: `R(s, age) = R(s, age − 1)` at absent ages. Emerges from `Δrate = 0` at absent cells; the increment at the next observed age absorbs the cumulative jump across the gap. This is a property of the increment form, not a separate code path. |
| Per-source-day rate cache | Implementation detail of building `R(s, age, draw)` and `ΔR(s, age, draw)` efficiently. The semantic output is the per-edge per-draw kernel `Δk_emp(s, age, draw) / n_emp(s, draw)`; caching must not become a second authority. |
| Cumulative-to-increment | One differencing step: build per-draw forward-filled cumulative `R(s, age, draw) = k_emp(s, age, draw) / n_emp(s, draw)`, then `ΔR = R(s, age) − R(s, age − 1)`. Internal DP consumes densities; cumulative projection happens once at readout. |

Single-hop X-clock preserves admitted `window()` evidence exactly (no transformation applied); multi-hop and active-cohort derive from the same admitted rows via the DAG DP under §4.4 cancellation. If a blind-oracle discrepancy that legacy interpolation would have masked appears, fix the fixture or the §3–§4 algebra — not by re-introducing interpolation. Phase 6 Appendix A's discretisation question is scoped to the conditioned kernel only.

### ⚠ Open: discretisation kernel construction (conditioned operator only)

> **✅ Resolved 16-May-26.** Two surfaces, two callers, one set of particles. Endpoint `G(τ)` from `_build_per_draw_cdf` lives on `TimingPosterior.cdf_draws` and drives every chart-published curve (composer input, F-mode overlay, conditioned posterior CDF). Day-averaged `B(τ) = ∫_τ^{τ+1} G(v) dv` from `timing_particles.build_row_aligned_lognormal_cdf_from_draws` stays local to the IS likelihood's cell-differencing loop in `primitive_conditioning._run_is_proposal`, where snapshot rows are themselves daily buckets and the integrated form is the right comparand. Both helpers are scipy-free via `numpy_stats.normal_cdf`. The earlier failure mode — feeding the row-aligned `B(τ)` onto `TimingPosterior.cdf_draws` — produced a ~½-day model-curve advance, visible as the no-evidence single-hop oracle mismatch and the `test_v3_empty_frames_*` contract drift; both go green after the separation. Phase 6 Appendix A contract text still needs the matching update.

There is an unresolved question about the **conditioned** operator's per-edge kernel construction. See [phase-6-evidence-operator-contract.md Appendix A](phase-6-evidence-operator-contract.md#appendix-a--under-review-discretisation-kernel-construction) (UNDER REVIEW). It does NOT affect the empirical operator: the empirical kernel reads observed cumulative rates which integrate same-day conversions by construction (matches Phase 6 §3.1 directly). The discretisation question is whether the parametric posterior CDF, evaluated at integer τ, gives the right per-day kernel — and whether a half-day shift is needed. **Stage 2 of this plan blocks at the kernel-construction question for the conditioned operator until Appendix A closes.** The empirical operator can be built in parallel; it has no such question.

### Optional: shadow diagnostic during build

The implementer may add a temporary `--diag`-only call site in `_project_runtime_rows` that runs `project_selected_cohort_rows` alongside `_selected_cohort_group_rate_draws` and logs per-(draw, τ) deltas for triage. Use it to categorise pre-cutover deltas as legacy bug / display difference / new-path defect. It is **diagnostic-only — not a gate**. It is removed in Stage 3.

---

## Stage 2(a) and Stage 2(b) — explicit sub-stage split

Stage 2's atoms were partially landed on 16-May-26 in a context-constrained pass that delivered the load-bearing code (atoms 2.1, 2.2, 2.3). This split is retained as historical context, but the original Stage 2(b) adjusted/IPW obligations are superseded by the 25-May-26 coverage rollback.

To keep that boundary explicit, Stage 2 is split into two sub-stages:

- **Stage 2(a)** — landed 16-May-26. Atoms 2.1, 2.2, 2.3 fully delivered.
- **Stage 2(b)** — corrected 25-May-26. The active closure signal is the strict empirical / conditioned model two-operator split plus §6.1/§6.2 blind coverage. The old adjusted/IPW/MCAR acceptance is not required.

### Stage 2(b) status correction — adjusted/IPW branch superseded

This section was originally the home for adjusted evidence, MCAR recovery,
and Horvitz-Thompson tolerance tests. That branch is no longer active.
The coverage design it depended on was rolled back: row `coverage` now
means applicability/freshness for display, not a reweighting denominator.

Do **not** implement the old outstanding adjusted-evidence checklist:

- no `evidence_x_adjusted`;
- no `evidence_y_adjusted`;
- no `rate_adjusted`;
- no `rate_blended = rate_adjusted` compatibility shim;
- no MCAR/IPW battery as a cutover gate.

The live Stage 2 substrate is:

- empirical and conditioned operator families exist;
- `project_selected_cohort_rows` returns strict empirical surfaces
  (`evidence_x_strict`, `evidence_y_strict`, `rate_strict`);
- coverage is reduced to `applicability_row`;
- the adjusted-output fields are intentionally absent.

Stage 3 may proceed against this corrected contract. Any future patch that
reintroduces adjusted evidence must be treated as new design work, not as
completion of this cutover plan.

**Empirical operator dependency note**: across this section and §5.6, the empirical operator is described as sharing inputs with the conditioned operator. To be precise: both operators share the *same admitted candidate rows* and the *same pre-conditioning arrival-map weighting* (the role-clock latency map built upstream of primitive conditioning). The empirical operator does NOT read conditioned probability, value-stream, coverage, exposure, or any posterior-conditioned output. Phrasings that suggest otherwise (e.g. "depends on the conditioned operator") are imprecise — the correct framing is "shares the pre-conditioning arrival-map input used by evidence binding".

### Stage 2 review defect — source-day-aware conditioned mask

**Surfaced**: 16-May-26 code review after Stage 2(b) tests passed.

**Fixed**: 16-May-26. `ConditionedTransitionPrimitive` now carries `observation_mask_draws_by_source_day`; conditioned primitives build that map from admitted rows; `subject_span_composer` selects source-day masks during support/exposure DP propagation. Value/model mass still uses the original unmasked DP. Identity/window-local bindings preserve the aggregate age mask when a propagated calendar day has no source-day entry, because window helpers are local-clock primitives; composed/active bindings treat missing source-day entries as absent.

**Defect**: Atom 2.1 and Phase 6 §4.7 define the observation mask per concrete edge and per `(source_day, age)` cell. The current conditioned-path mask is age-only: `_build_observation_mask_from_weighted_view` sets `age_mask[age] = 1` if any admitted source day has a row at that age, then tiles that mask across draws. In a multi-source-day or active-cohort case, a row for source day `s1` at age `a` can incorrectly mark source day `s2` at age `a` as observed. Downstream, the conditioned support/exposure streams overstate coverage along wavefront cells that route through `s2`.

**Fix scope**:

- Carry source-day-aware row presence through the conditioned operator, not just the empirical operator. The representation can mirror the empirical operator's `*_by_source_day` maps or another source-day-indexed structure, but the composer must be able to select the mask matching the actual source day reached by the wavefront.
- Update `subject_span_composer.compose_primitive_span` so support/exposure propagation reads the source-day-specific mask when convolving from a source node. Padding/truncation must not use CDF saturation padding for masks; absent future cells remain absent unless an explicit row exists at that age/source-day.
- Keep F-mode unconditioned overlays as the only all-ones default (`observation_mask_draws=None`). Conditioned prior-only / degraded paths with zero admitted rows remain all-zero.
- Add a blind regression in `test_model_span_spine_selected_cohort.py` or `test_subject_span_composer.py`: two source days, same edge, row present at `(s1, age=a)` and absent at `(s2, age=a)`; seed mass routed through both source days; assert coverage/support drops only for the `s2` wavefront and remains observed for `s1`.
- Add an active-carrier-style regression where carrier timing lands mass at multiple X source days and subject evidence is sparse by source day. This is the high-risk production shape because the current age-only mask can look correct in single-source-day window tests.

**Exit condition**: focused Stage 2 tests still pass, plus the new source-day-mask regression protects against the age-only collapse. There is no remaining adjusted-evidence prose blocker for Stage 3; cleanup now means removing stale adjusted/IPW references from docs.

---

## Stage 3 — Cut over

**THE RISK EVENT.** One commit, one call-site flip, three modes activated simultaneously.

### Atom 3.1 — Build the cohort-list helper

Add `_build_selected_cohort_inputs(engine_cohorts, n_by_anchor) -> Sequence[Mapping]` in `cohort_forecast_v3.py`. Returns the per-cohort dict the new reducer takes — `anchor_day`, `N_anchor` from `n_by_anchor`, `tau_max` from `engine_cohorts`. This is the only piece of the row layer that still touches per-anchor `N` — appropriate at the row layer because it is perimeter admission (Phase 6 §5.2).

**Current status (25-May-26)**: landed in `cohort_forecast_v3.py`.

### Atom 3.2 — Flip the call site

At [cohort_forecast_v3.py:5382](../../graph-editor/lib/runner/cohort_forecast_v3.py#L5382), replace the call to `_selected_cohort_group_rate_draws` with the four-span signature from Atom 2.3:

```
selected_projection = project_selected_cohort_rows(
    composed_carrier=resolved_spans.composed_carrier,
    composed_subject=resolved_spans.composed_subject,
    composed_empirical_carrier=resolved_spans.composed_empirical_carrier,
    composed_empirical_subject=resolved_spans.composed_empirical_subject,
    selected_cohorts=_build_selected_cohort_inputs(...),
    horizon=max_tau,
)
```

Both empirical spans are required — Atom 2.2 puts them on `ResolvedSpans` and Atom 2.3 reads from them to produce strict per-anchor evidence cumulatives. Dropping either empirical span here would silently revert the strict E-mode readout to model-projected mass, violating I-46 and the two-operator contract. Preserve the variable name `selected_projection` so downstream `_quantiles` / `_draw_mean` calls keep working.

**Current status (25-May-26)**: landed. `_project_runtime_rows` calls
`model_span_spine.project_selected_cohort_rows(...)` with conditioned,
predictive, and empirical carrier/subject spans.

### Atom 3.3 — Migrate row-field reads

Inside `_project_runtime_rows`, update the row-field reads to source from the new projection. Existing row schema is preserved except that the abandoned adjusted/IPW fields are **not** added. Each row field is routed to one of: empirical operator (strict observed counts), conditioned operator (model projection), or row applicability/freshness.

| Row field | Legacy source | New source | Operator family |
|---|---|---|---|
| `midpoint`, `fan_*`, `fan_bands`, `projected_rate` | `_selected_cohort_group_rate_draws.rate_draws` quantiled at τ | `project_selected_cohort_rows.rate_draws_model` quantiled — identical algebra | **Conditioned** |
| `forecast_x`, `forecast_y` | Reducer's `.x_draws`/`.y_draws` mean − evidence | New projection's `.x_draws_model`/`.y_draws_model` mean − evidence | **Conditioned** |
| `evidence_x`, `evidence_y` (strict evidence line) | `selected_evidence_by_tau[tau]['sum_x'/'sum_y']` from `SelectedAClockEvidence.aggregate_by_tau` over admitted rows | `project_selected_cohort_rows.evidence_x_strict[tau]` / `.evidence_y_strict[tau]` — empirical operator's strict per-anchor terminal cumulative, frozen past each Cohort's data extent and summed across anchors | **Empirical (strict)** |
| `rate` (strict — E-mode line) | `evidence_y / evidence_x` from `SelectedAClockEvidence.aggregate_by_tau` | `evidence_y / evidence_x` (both strict). Legacy formula preserved; the inputs are the strict empirical sums above. | **Empirical (strict)** |
| `evidence_x_adjusted`, `evidence_y_adjusted`, `rate_adjusted` | n/a | **Absent by design.** The adjusted/IPW branch was removed with the coverage rollback. | n/a |
| `coverage` | Per-cell `*_landing_coverage` aggregated and capped at [cohort_forecast_v3.py:5548-5571](../../graph-editor/lib/runner/cohort_forecast_v3.py#L5548-L5571) | `project_selected_cohort_rows.applicability_row[tau]` — applicable Cohorts / selected Cohorts. This is display freshness, not masked-support evidence coverage and not an IPW denominator. | **Applicability** |
| `evidence_x_coverage`, `evidence_y_coverage` | Per-terminal coverage scalars | **No active owner in the corrected Stage 3 contract.** If a downstream consumer still requires these fields, define them explicitly before deletion rather than reviving masked-support/IPW semantics. | n/a |
| `cohorts_covered_base`, `cohorts_covered_projected` | `bucket['n_cohorts']` and `_observation_frontier` | `applicable_cohort_count[tau]` from the projection. | **Applicability** |
| `model_midpoint`, `model_fan_*`, `model_bands`, `model_curve_*` | F-mode + epistemic overlay through spine | **Unchanged** (already on spine, conditioned operator with prior-only primitives) | **Conditioned (unconditioned overlay)** |
| `rate_pure` | Empirical aggregation | Strict empirical per `rate` above. | **Empirical (strict)** |
| `rate_blended` | Legacy linear blend at [cohort_forecast_v3.py:5701-5704](../../graph-editor/lib/runner/cohort_forecast_v3.py#L5701-L5704) | **Removed / stale consumer surface.** Do not remap to `rate_adjusted`; adjusted no longer exists. | n/a |
| `p_infinity_*`, `completeness*` | `ResolvedCFRuntime.public_moments` / `_runtime_completeness` | **Unchanged** | (Scalar; orthogonal to the row-reducer) |

**Why this split matters**: two distinct chart concerns route to different operator readouts — empirical strict evidence from the empirical operator, and model/forecast surfaces from the conditioned operator. Coverage is no longer a third evidence arithmetic authority; it is display applicability. Reintroducing `rate_blended`, adjusted evidence, or masked-support/IPW coverage would reopen the design branch this rollback closed.

### Atom 3.4 — Outside-in gate

```
cd graph-editor && pytest lib/tests/test_cohort_factorised_outside_in.py -xvs
cd graph-editor && pytest lib/tests/test_selected_evidence_natural_degeneracy.py lib/tests/test_selected_cohort_pop_d_distribution.py lib/tests/test_multihop_evidence_parity.py lib/tests/test_cf_query_scoped_degradation.py lib/tests/test_doc56_phase0_behaviours.py lib/tests/test_active_cohort_display_invariants.py -xvs
```

Acceptance:

- All tests pass.
- Strict xfails recorded in 1.3 that named this cutover as flip-to-green: XPASS. Marker **deleted in the same commit** (AP59 — XPASS without deletion is not closure).
- No new xfail markers, no loosened tolerances, no fixture weakening since Stage 1.2 baseline. Verify via `git diff <stage-1-commit> -- lib/tests/`.

If any test fails: triage.

- **New-path defect**: failing test decomposes a case the §6.1/§6.2 blind tests didn't cover. Add the missing blind test, fix Stage 2, return.
- **Legacy was accidentally right**: legacy carried a workaround that compensated for an upstream defect. Document in the commit, accept the new behaviour, update the test if it pinned a workaround.
- **Legacy was wrong** (the y-deficit 1-day-shift signature; the rising-flank curvature symptom; the H-1 monotone clamp masking a real defect): legacy was buggy. The new path corrects it. Document the delta and the §3–§4 invariant that explains it.

What is **not** acceptable: flipping a green test to xfail, loosening a tolerance, weakening a fixture, or attributing the failure to "probably HMR staleness" without running `scripts/dev-server-check.sh`. AP6 + AP59.

### Atom 3.5 — Remove any shadow diagnostic

If a shadow comparison was added during build (optional Atom 2's aid), delete it now. Diagnostics must not retain a "legacy vs new" comparison after cutover.

### Output routing post-cutover

The row dict schema is mostly preserved. Downstream consumers (cohort_maturity endpoint, conditioned-forecast endpoint, FE chart code at [cohortComparisonBuilders.ts](../../graph-editor/src/services/analysisECharts/cohortComparisonBuilders.ts)) should not receive or expect `rate_adjusted`, `evidence_x_adjusted`, or `evidence_y_adjusted`.

The FE follow-up is stale-comment cleanup and removal of any `rate_blended` diagnostic remnants, not a switch to `rateAdjusted`.

Diagnostic side-channels (`rows[0]['_selected_a_clock_evidence']`, `rows[0]['_selected_cohort_projection']`) — shape preserved by the Stage 4 adapter; values now derive from spine surfaces.

---

## Stage 4 — Clean up

Mechanical. Grep gate after each deletion. Production hits → block (means a consumer was missed at Stage 3, return upstream).

### Atom 4.1 — Reduce `SelectedAClockEvidence` to an adapter

**Refinement (26-May-26) — re-source the two live frontier consumers, then delete the object outright; do not rebuild it.**

Audit of the post-Stage-3 tree shows the *entire* legacy stack hangs off one live call — `_build_selected_a_clock_evidence_from_runtime` at [cohort_forecast_v3.py:6251](../../graph-editor/lib/runner/cohort_forecast_v3.py#L6251). Its product `SelectedAClockEvidence` has only **two** live (non-diagnostic) row-path consumers; everything else it touches is dead (`_selected_cohort_group_rate_draws`, `projection_bases`) or `--diag`-only. Inside `_project_runtime_rows` the object is already forensic-only — all row *values* come from the spine `selected_projection`.

The two live consumers are both **frontier** surfaces. The original cleanup assumption was that the relevant frontier was already materialised on `fe.cohort_list` by the `tau_observed = (data_retrieved_at − anchor).days` derivation in `build_cohort_evidence_from_frames` ([cohort_forecast_v3.py:5744](../../graph-editor/lib/runner/cohort_forecast_v3.py#L5744)), and that `SelectedAClockEvidence.frontier_tau_bounds` / `prefixes_for_cohorts(use_retrieval_frontier=True)` merely recomputed it off a parallel object. The attempted fix below disproved that assumption: `cohort_list['tau_observed']` is not a reliable selected retrieval frontier after multi-hop frame composition.

**The four τ that matter (do not conflate them):**

| τ | Meaning | Engine var | Source | Re-sourced? |
|---|---|---|---|---|
| Epoch **A→B** | solid evidence ends (all Cohorts still observed) | `row_tau_solid_max` | `min(tau_observed)` over evidenced Cohorts (retrieval frontier) | **yes** |
| Epoch **B→C** | all evidence ends (forecast-only beyond) | `row_tau_future_max` | `max(tau_observed)` over evidenced Cohorts (retrieval frontier) | **yes** |
| **Drawn extent** | chart x-axis / row count | `max_tau` | `fe.tau_future_max` (**calendar** span) + latency `t95`, clamped 400 | no — never read the legacy object |
| **Calc extent** | internal sweep for `p_infinity` | `saturation_tau` | `max_tau` + path latency | no |

The B→C boundary (`row_tau_future_max`, retrieval frontier) and the drawn extent (`max_tau`, calendar + latency) are **different variables computed in different places** — the comment at [5795](../../graph-editor/lib/runner/cohort_forecast_v3.py#L5795) forbidding `data_retrieved_at` coupling refers to the calendar one feeding `max_tau`, not the epoch boundary. The forecast tail (epoch C) is drawn out to `max_tau` regardless; `row_tau_future_max` only marks where *evidence* stops (FE solid/dashed/future split at [cohortComparisonBuilders.ts:95–97](../../graph-editor/src/services/analysisECharts/cohortComparisonBuilders.ts#L95)).

**Attempted fix (26-May-26) — DISPROVEN, reverted.** The first attempt replaced the `if has_cells()` override at [6263–6270](../../graph-editor/lib/runner/cohort_forecast_v3.py#L6263) and the active-carrier `prefixes_for_cohorts(...).frontier_age` read at [6280](../../graph-editor/lib/runner/cohort_forecast_v3.py#L6280) with `min`/`max` of `cohort_list['tau_observed']`, on the premise that `tau_observed` *is* the per-Cohort retrieval frontier (same `data_retrieved_at` formula). **That premise is false for multi-hop `window()`.** The outside-in oracle `test_window_multihop_ef_boundary_matches_rate_attributed_selected_evidence[from(wrp-a).to(wrp-c)]` failed (`tau_solid_max` expected 27, got 0). A probe at the bounds site showed **every** Cohort in that fixture has `cohort_list['tau_observed'] = 0` and `engine_cohort.frontier_age = 0`, while `SelectedAClockEvidence.frontier_tau_bounds(use_retrieval_frontier=True)` correctly returns `(27, 40)` — the per-Cohort retrieval frontier `(data_retrieved_at − anchor).days` (here ≈ the fully-retrieved calendar age). For multi-hop window the frame-derived `tau_observed`/`frontier_age` collapse to 0 (the frame `cohort_at_tau` does not carry per-Cohort retrieval ages through the multi-hop composition), so they are **not** a usable frontier source. The retrieval frontier genuinely lives only in `SelectedAClockEvidence`, computed from the admitted-evidence rows' `data_retrieved_at`.

**Revised scope.** Re-sourcing the frontier consumers is therefore **not** a `cohort_list` read-swap. The per-Cohort retrieval frontier must come from admitted evidence rows after the same role placement/admission logic that feeds the empirical spine. The failed shortcut proved two separate facts:

- `cohort_list['tau_observed']` is a frame/display frontier and can collapse to `0` for multi-hop `window()` even when admitted rows prove a later retrieval frontier.
- The spine currently consumes that same `tau_observed` as the per-Cohort frontier `f_c` in `_build_selected_cohort_inputs`, so fixing only the row epoch bounds would leave FC continuation prefix-pinned to the wrong frontier.

**Specific solution.** Move the retrieval-frontier computation into the empirical spine as a support sidecar, then make `cohort_forecast_v3.py` consume that sidecar before row projection. The sidecar is not a rebuilt `SelectedAClockEvidence`; it carries only frontier/support facts, while row values remain owned by `project_selected_cohort_rows`.

The implementation shape is:

1. Extend `EmpiricalEvidencePrimitive` in `empirical_evidence_operator.py` with a strict support ledger derived during empirical-kernel construction. The ledger records admitted row support by primitive source day and row age, carrying the row's real `retrieved_at` date. It is built from `WeightedPrimitiveEvidenceView.rows`, so it sees the same per-primitive admitted rows as the empirical value kernel. It must ignore forward-filled value cells and must never fall back to `observed_date`, `snapshot_date`, or frame dates.
2. Thread that support ledger through the empirical carrier and subject trace evaluators alongside value mass. This can be a compact "latest retrieval support" trace, not a second value DP: each propagated contribution carries the latest real retrieval date that supports the cell, and absent support stays absent while value may still forward-fill. The trace must preserve provenance to selected anchor days the same way the empirical value trace preserves source-bucket provenance.
3. Add a `SelectedRetrievalFrontier` surface in `model_span_spine.py`. It is built from the empirical carrier trace and empirical subject trace for the selected cohort set. For each anchor it exposes carrier frontier, subject frontier, paired frontier, and the selected-group `(min, max)` bounds. Identity carrier is represented as structural carrier support, so its paired frontier is the subject frontier. Active carrier uses the existing support rule: paired frontier is the minimum of carrier value support and subject support, and is absent if a required role has no real support.
4. Add a spine pre-pass, before `_project_runtime_rows`, that builds `SelectedRetrievalFrontier` from `runtime.composed_empirical_carrier`, `runtime.composed_empirical_subject`, the selected cohort list, and the row horizon. This pre-pass runs after `build_resolved_cf_runtime` because empirical primitives and their admitted rows do not exist before runtime construction.
5. Change `_build_selected_cohort_inputs` so the `tau_observed` it passes to `project_selected_cohort_rows` comes from `SelectedRetrievalFrontier.paired_frontier_by_anchor`, not from `cohort_list['tau_observed']`. `cohort_list['tau_observed']` remains a frame/display fallback only for the malformed/no-support case and must be labelled as such in diagnostics.
6. Change the row epoch setup so `row_tau_solid_max` and `row_tau_future_max` read `SelectedRetrievalFrontier.bounds`, replacing the current `SelectedAClockEvidence.frontier_tau_bounds(use_retrieval_frontier=True)` override.
7. Change active-carrier completeness setup so `cohort_eval_ages` reads `SelectedRetrievalFrontier.paired_frontier_by_anchor`, replacing `SelectedAClockEvidence.prefixes_for_cohorts(... use_retrieval_frontier=True)`. The completeness weight remains `a_pop`; only the frontier age source changes.
8. Keep `project_selected_cohort_rows` strict: it receives the frontier as part of each selected cohort input and does no frontier derivation of its own. It should continue to treat a missing `tau_observed` as a perimeter contract violation unless the caller explicitly constructed a malformed/no-support fallback input.

This is the minimal untangling that deletes the old authority without creating a new projection-layer shortcut. The old object currently bundled three concerns: selected value cells, retrieval-frontier support, and diagnostics. Stage 3 moved selected values to the empirical spine. Stage 4 must now move retrieval-frontier support to the empirical spine. Only diagnostics may remain as an adapter, and only after both production concerns are gone.

Acceptance for Atom 4.1:

1. In the multi-hop `window()` oracle where `cohort_list['tau_observed'] == 0`, `SelectedRetrievalFrontier.bounds` returns the same `(27, 40)` currently returned by `SelectedAClockEvidence.frontier_tau_bounds(use_retrieval_frontier=True)`.
2. The selected cohort inputs passed to `project_selected_cohort_rows` carry those per-anchor paired frontiers, so FC continuation prefix-pins to the retrieval frontier rather than the broken frame frontier.
3. `row_tau_solid_max`, `row_tau_future_max`, and active-carrier `cohort_eval_ages` no longer read `SelectedAClockEvidence`.
4. Grep shows `frontier_tau_bounds` and `prefixes_for_cohorts` are production-dead before `_build_selected_a_clock_evidence_from_runtime` is deleted.
5. A focused regression protects both surfaces: the row epoch split and the spine `f_c` input must stay correct when frame `tau_observed` is zero but admitted empirical rows carry real `retrieved_at` support.

Do **not** rebuild `SelectedAClockEvidence` from spine values as a compatibility shim. That preserves the old object as a second authority and reintroduces the exact projection-layer semantic decision this cutover is deleting.

Diagnostic shape check: run a `--diag` request through `graph-ops/scripts/analyse.sh`; diff the diagnostics JSON against a pre-cutover capture. Shape must match. Value deltas are expected; categorise in the commit message.

### Atom 4.2 — Delete legacy authorities

Delete in order, grep after each:

**Prefix dataclasses:**
- `_SelectedSourceDayMass`, `_SelectedEvidencePropagationLedger`, `_CarrierOnlyDenominatorPrefix`, `_RateAttributedSubjectPrefix` ([cohort_forecast_v3.py:586-774](../../graph-editor/lib/runner/cohort_forecast_v3.py#L586-L774))
- `SelectedCohortProjection` ([cohort_forecast_v3.py:778](../../graph-editor/lib/runner/cohort_forecast_v3.py#L778)) — superseded by `SelectedCohortRowProjection`
- `ResolvedCFRuntime` fields: `selected_x_prefix`, `selected_y_prefix`, `selected_source_day_mass`, `observed_carrier_a_to_x`, `observed_subject_x_to_end`, `generalised_span_shadow_carrier_resolutions`, `generalised_span_shadow_subject_resolutions`

**Builders:**
- `_build_selected_source_day_mass` ([:2044](../../graph-editor/lib/runner/cohort_forecast_v3.py#L2044))
- `_build_carrier_only_denominator_prefix` ([:2241](../../graph-editor/lib/runner/cohort_forecast_v3.py#L2241))
- `_build_rate_attributed_subject_prefix` ([:4078](../../graph-editor/lib/runner/cohort_forecast_v3.py#L4078))
- `_build_evidence_local_rate_attributed_subject_prefix` ([:3772](../../graph-editor/lib/runner/cohort_forecast_v3.py#L3772))

**Reducer:**
- `_selected_cohort_group_rate_draws` ([:4889-5283](../../graph-editor/lib/runner/cohort_forecast_v3.py#L4889-L5283))
- `_pad_cdf_to_horizon` ([:4876](../../graph-editor/lib/runner/cohort_forecast_v3.py#L4876)) if no other callers

**Observed-surface and placement helpers:**
- `_build_observed_span_evidence_surface` ([:3074](../../graph-editor/lib/runner/cohort_forecast_v3.py#L3074))
- `_build_zero_edge_observed_surface` ([:2945](../../graph-editor/lib/runner/cohort_forecast_v3.py#L2945))
- `ObservedSpanEvidenceCell`, `ObservedSpanEvidenceSurface`, `_SubjectChainEvidenceBuckets` ([:111, :132, :2922](../../graph-editor/lib/runner/cohort_forecast_v3.py#L111))
- `_role_topology_edges` ([:2820](../../graph-editor/lib/runner/cohort_forecast_v3.py#L2820)), `_max_flow_for_observed_span` ([:2863](../../graph-editor/lib/runner/cohort_forecast_v3.py#L2863)) if no other callers
- `_join_conditioned_carrier_backmap` ([:2748](../../graph-editor/lib/runner/cohort_forecast_v3.py#L2748)), `_PriorCarrierBackmap` ([:2658](../../graph-editor/lib/runner/cohort_forecast_v3.py#L2658))
- `_row_selected_a_clock_placements`, `_primitive_weighted_rows`, `_row_snapshot_date`, `_row_observed_date`, `_parse_date_prefix`, `_analysis_observation_frontier_date`, `_latest_value_at_or_before`, `_latest_nk_at_or_before` ([:2521-3666](../../graph-editor/lib/runner/cohort_forecast_v3.py#L2521-L3666)) — confirm no consumers before each deletion

**Quadrature / interpolation policy:**
- `_interpolated_rate_at` ([:3567](../../graph-editor/lib/runner/cohort_forecast_v3.py#L3567))
- `_build_source_day_rate_cache` ([:3666](../../graph-editor/lib/runner/cohort_forecast_v3.py#L3666))
- `_build_age_only_rate_cache` ([:3695](../../graph-editor/lib/runner/cohort_forecast_v3.py#L3695))
- `_monotone_rate_array` ([:3740](../../graph-editor/lib/runner/cohort_forecast_v3.py#L3740))
- `_mass_series_for_anchor` ([:3754](../../graph-editor/lib/runner/cohort_forecast_v3.py#L3754))
- `_date_plus_days` ([:3649](../../graph-editor/lib/runner/cohort_forecast_v3.py#L3649)), `_days_between` ([:3656](../../graph-editor/lib/runner/cohort_forecast_v3.py#L3656)) if only consumed by the deleted helpers

**Dead and shadow code:**
- `_composed_pair_request_cdf_draws` ([:1779](../../graph-editor/lib/runner/cohort_forecast_v3.py#L1779)) — already annotated DEAD CODE
- `_runtime_provenance_with_generalised_span_shadow` ([:1121](../../graph-editor/lib/runner/cohort_forecast_v3.py#L1121)), `_build_generalised_span_shadow_plans`, `_shadow_operators_from_resolutions`, `_shadow_operator_from_primitive`, `_shadow_expected_curve_from_composed_spans`, `_build_generalised_evidence_shadow_plans`, `_shadow_operator_from_cumulative_curve` ([:1121-1411](../../graph-editor/lib/runner/cohort_forecast_v3.py#L1121-L1411))
- [graph-editor/lib/runner/generalised_span_model_shadow.py](../../graph-editor/lib/runner/generalised_span_model_shadow.py) — entire file
- [graph-editor/lib/tests/test_generalised_span_model_shadow.py](../../graph-editor/lib/tests/test_generalised_span_model_shadow.py) — entire file

### Atom 4.3 — Global grep verification

```
cd graph-editor && grep -rn '_SelectedSourceDayMass\|_CarrierOnlyDenominatorPrefix\|_RateAttributedSubjectPrefix\|_SelectedEvidencePropagationLedger\|_selected_cohort_group_rate_draws\|_build_selected_source_day_mass\|_build_carrier_only_denominator_prefix\|_build_rate_attributed_subject_prefix\|_build_evidence_local_rate_attributed_subject_prefix\|_build_observed_span_evidence_surface\|_build_zero_edge_observed_surface\|_join_conditioned_carrier_backmap\|_interpolated_rate_at\|_composed_pair_request_cdf_draws\|ObservedSpanEvidenceCell\|ObservedSpanEvidenceSurface\|generalised_span_model_shadow' lib/runner/ lib/tests/
```

Required: zero hits in `lib/runner/`. Hits in `lib/tests/` acceptable only if the test was migrated or is a snapshot of archived code (`cf-v3-snapshots/`, `cohort_forecast_v3.generalisation-attempt.py`).

### Atom 4.4 — Full suite re-run and lint

```
cd graph-editor && pytest lib/tests/ --strict-markers
cd graph-editor && ruff check lib/runner/model_span_spine.py lib/runner/cohort_forecast_v3.py lib/runner/subject_span_composer.py lib/runner/primitive_evidence.py lib/runner/primitive_conditioning.py lib/runner/primitives.py
```

Full suite green. Lint clean. Post-cutover `wc -l graph-editor/lib/runner/cohort_forecast_v3.py` substantially smaller than the 6644 baseline; expect ~3500–4500.

### Atom 4.5 — No-defensive-code audit on new code

Read `project_selected_cohort_rows` and its helpers. Confirm zero violations of I-47:
- No `or 0.0`, `or []`, `or {}`
- No `np.clip`
- No `try/except: pass`
- No `if x is None: return`
- No `max(0.0, residual)` clamps
- No silent schema case-forks

Any violation found is a Stage 2 defect; fix before closing.

### Atom 4.6 — Codebase docs

The legacy `rate_blended = empirical × coverage + model × (1 − coverage)` linear blend and the abandoned `rate_adjusted` / IPW replacement are both superseded. The active contract is strict empirical evidence plus model/forecast surfaces; `coverage` is applicability/freshness only. The display-contract docs that previously described either linear blending or adjusted evidence MUST be updated explicitly; silent supersession across authority docs is itself an AP58 hazard.

- [CF_ROW_PIPELINE.md](../codebase/CF_ROW_PIPELINE.md) — rewrite §1–§4 to describe the new pipeline including the empirical / conditioned operator split (Phase 6 §4.9), strict empirical evidence ownership, and applicability-only coverage; delete §7 detail and §8 midpoint-shift block; replace any `rate_blended`, `rate_adjusted`, or adjusted-evidence-as-E+F-contract passage with the corrected contract.
- [cohort-maturity-evidence-coverage-design.md](../cohort-maturity-evidence-coverage-design.md) — update §2 (per-row coverage) and §4 (display semantics): remove the linear-blend carry-forward formula and do not replace it with adjusted/IPW semantics. Coverage continues only as a display freshness/applicability signal.
- [FORECAST_RUNTIME_ARCHITECTURE.md](../codebase/FORECAST_RUNTIME_ARCHITECTURE.md) — update §1, §2, §4, §5, §6 to remove deleted fields, the mode-equality identity-carrier check, and stale per-terminal coverage / exposure claims if those are no longer engine outputs.
- [INVARIANTS.md](../codebase/INVARIANTS.md) I-45/I-46/I-48 — add the cutover as a realisation; remove citations to deleted authorities.
- [KNOWN_ANTI_PATTERNS.md](../codebase/KNOWN_ANTI_PATTERNS.md) AP58 — record the realised closure of the BE cohort-forecast row reducer fork and the removal of both `rate_blended` and adjusted/IPW coverage semantics.
- [cf-defensive-coding-audit.md](cf-defensive-coding-audit.md) — mark H-5, F-1, H-1, H-4, M-1 closed.
- Cross-check: `grep -rn 'rate_blended\|rate_adjusted\|coverage-blended\|linear blend\|IPW\|MCAR' docs/current/` returns only historical/superseded references.

### Atom 4.7 — Performance / vectorisation review

After the legacy reducer and shadow paths are unreachable, profile the single steady-state reducer path and decide whether the remaining draw-axis loops should be vectorised. Focus on batched convolution in `project_selected_cohort_rows`, conditioned/empirical span composition over `(S, T)`, and source-day-aware masked DP; do not optimise pre-cutover scaffolding or reintroduce a second arithmetic authority.

### Atom 4.8 — Span-core defensive-guard audit

Audit and remove defensive conditionals inside the shared span core (`timing_span.py` and `subject_span_composer.py`). These files are not boundary code; they are algebra-only. They receive valid kernels/primitives by construction. Malformed inputs should crash naturally. The span core must not degrade, clamp, pad, truncate, substitute masks, validate shapes, reject inputs, or emit compatibility fallbacks. Specific hotspots to eliminate after cutover:

- `timing_span.py`: `_degraded_timing` return paths for no-path / zero-reach / missing-transition / horizon-inadequate cases; `resolve_timing_transitions_from_graph` returning `None`; `np.clip` on composed CDFs / MC CDFs; density padding/truncation in `compose_timing_span_from_densities`; `p_mean <= 0` / `sigma < 0` silent refusal.
- `subject_span_composer.py`: deterministic-shift validity branch; draw/CDF shape guards that should be producer invariants; `cdf_renorm_tolerance` / `np.where` row-sum substitution; CDF and mask padding/truncation helpers; `_mask_for_source_day` aggregate-mask fallback and missing-source-day zero substitution.

Exit condition: every remaining conditional in these two files is pure algebraic case structure such as latency-family kernel construction or zero-edge identity. Shape checks, validity checks, missing-data handling, and refusal decisions are gone. No branch may return a degraded span, fabricated zeros, clipped values, padded kernels, compatibility fallback, or rejection from inside the span core.

---

## Stage 5 — FE / output follow-ups

Stage 5 is no longer a `rateAdjusted` adoption stage. It is a stale-surface cleanup stage after the BE row contract is proven and legacy authorities are deleted.

### Atom 5.1 — Remove stale adjusted/blended FE surfaces

At [cohortComparisonBuilders.ts](../../graph-editor/src/services/analysisECharts/cohortComparisonBuilders.ts), remove or explicitly quarantine stale `rateBlended` / `rate_blended` parsing, hidden diagnostic lines, and TEMP DIAGNOSTIC comments that imply a future switch to `rate_adjusted`.

Do **not** add:

- `rateAdjusted`;
- `evidenceXAdjusted`;
- `evidenceYAdjusted`;
- an E+F line sourced from `rate_adjusted`.

### Atom 5.2 — Preserve active FE paths

No semantic FE switch is required by this cutover unless Stage 3/4 discovers a live consumer of a deleted field. Preserve:

- E-mode line reading strict `baseRate`;
- F-mode/model surfaces that were moved to `model_midpoint` / `model_curve_midpoint` by the FC chart-surface workstream;
- alpha/freshness rendering driven by `coverage`, now understood as applicability/freshness rather than IPW coverage.

### Atom 5.3 — Tooltip and copy audit

Audit tooltip/copy consumers via `grep -rn "baseRate\|rate_blended\|rate_adjusted\|coverage" graph-editor/src/`. Remove copy promising adjusted evidence, IPW, or coverage-blended E+F. Keep user-facing language centred on strict observed evidence plus model/forecast surfaces.

### Atom 5.4 — Glossary updates

Add or update only the terms that survive the rollback:

- **Codebase glossary** ([docs/current/codebase/GLOSSARY.md](../codebase/GLOSSARY.md)): empirical operator, conditioned operator, value kernel, row-presence mask, strict evidence, applicability/freshness coverage, frontier τ per anchor if still live.
- **Public glossary** ([graph-editor/public/docs/glossary.md](../../graph-editor/public/docs/glossary.md)): user-facing subset — coverage/freshness, frontier, strict evidence. Do not add adjusted evidence, IPW, or MCAR as active product terms.
- **Existing Bayes terms** — audit and add standalone entries for those currently only mentioned within other definitions: EWMA, ESS, R̂ (rhat), PPC. Cross-check against [docs/current/codebase/GLOSSARY.md](../codebase/GLOSSARY.md) §Statistical.

### Atom 5.5 — Archive the plan

Move this plan from `docs/current/project-generalise/selected-cohort-projection-cutover-plan.md` to `docs/archive/project-generalise/selected-cohort-projection-cutover-plan.md`. Move the superseded `ACTION_PLAN_selected_cohort_spine_cutover.md` likewise. Update [docs/current/project-generalise/README.md](README.md) §"Picking this up later" to point at the archive.

---

## Stop conditions

Halt if:

- **The plan is about to source strict empirical fields (`evidence_x`, `evidence_y`, `rate`, `evidence_x_strict_by_anchor_tau`, `evidence_y_strict_by_anchor_tau`) from the conditioned operator.** Per Phase 6 §4.9, these must come from the empirical kernel (per-anchor `Δk_emp/n_emp` propagated through the DAG DP and summed). Sourcing them from the conditioned operator's terminal cumulative is the silent semantic regression — the E line would become a posterior projection of admitted evidence rather than a display of admitted evidence. Hard stop.
- **The plan is about to use `coverage` as an evidence reweighting denominator.** Coverage is now applicability/freshness only. Do not source coverage from the empirical operator, the conditioned masked stream, or any revived support/exposure ratio for IPW arithmetic without a new accepted design.
- **The two-surface separation test (Atom 2.4) fails** because `rate_draws_model` and the strict empirical readout (`evidence_y_strict_by_anchor_tau` / `evidence_x_strict_by_anchor_tau`) are numerically equal where they shouldn't be. This means the operators have been wired with the same kernel family by mistake. The operator construction in Atom 2.2 has collapsed; fix before continuing.
- **Appendix A (discretisation kernel) of the Phase 6 contract has not closed** for the conditioned operator. Stage 2 cannot finalise the conditioned operator's kernel construction until that closes. The empirical operator can be built and tested independently while Appendix A is open.
- **A patch reintroduces adjusted evidence, IPW, MCAR recovery, `rate_adjusted`, or `rate_blended` as active output semantics.** Those were removed with the coverage rollback. Treat reintroduction as new design work requiring explicit approval, not cutover completion.
- **Stage 4 tries to delete `SelectedAClockEvidence` while `cohort_list['tau_observed']` still supplies the spine frontier.** The selected retrieval frontier must be extracted from admitted empirical/support rows first and threaded into both the row epoch bounds and `project_selected_cohort_rows`'s per-Cohort `f_c`.
- A Phase 6 §6.1 / §6.2 blind test fails and the failure is not pinned to a Stage 2 mask-plumbing or reducer defect.
- An outside-in failure at Stage 3 cannot be triaged into one of the three categories (new-path defect, legacy-was-accidentally-right, legacy-was-wrong).
- A new code path is needed inside the reducer (`if mode == ...`, `if carrier_is_identity ...`, `if window_or_a_equals_x ...`). The spine's degeneracy-by-data principle has broken; fix the spine before continuing.
- A grep gate after Stage 4 deletions shows reachable legacy references.
- An outside-in failure is attributed to "probably staleness" without running `scripts/dev-server-check.sh` (AP6).
- A test is loosened, weakened, or flipped to xfail to make the cutover pass (AP59).

---

## Tracking ledger

| Item | Status | Notes |
|---|---|---|
| 1.1 photocopy | waived 16-May-26 | at HEAD; user waived |
| 1.2 baseline | ✓ green 16-May-26 | |
| 1.3 strict-xfail ledger | ✓ 16-May-26 | see [Atom 1.3 strict-xfail ledger](#atom-13-strict-xfail-ledger) |
| 2.1 mask plumbing | ✓ fixed 16-May-26 | `observation_mask_draws_by_source_day` added; composer support/exposure DP selects source-day masks for composed bindings and preserves aggregate local-clock masks for identity/window helpers. Regression: `test_composer_masks_support_by_source_day_not_age_only`. |
| 2.2 empirical operator | ✓ 16-May-26 | `empirical_evidence_operator.py` + 11 blind tests + spine integration |
| 2.3 row reducer in spine | ✓ 16-May-26; corrected 25-May-26 | `project_selected_cohort_rows` in `model_span_spine.py` with strict empirical row fields. Adjusted/IPW fields were removed by the coverage rollback and are not part of closure. |
| 2.4 blind algebra tests | ✓ 16-May-26 (Stage 2(a) + 2(b)) | Core §6.1/§6.2 blind tests protect the two-operator split. Any §5.6 adjusted-evidence assertions are historical only. |
| 2.5 MCAR sparsity oracle | superseded 25-May-26 | MCAR/HT adjusted-evidence acceptance is obsolete because adjusted evidence was removed. |
| 3.2 call-site flip | ✓ landed | `_project_runtime_rows` calls `model_span_spine.project_selected_cohort_rows(...)`; ledger still needs commit SHA if desired. |
| 3.4 outside-in gate | — | pass count + which strict xfails XPASSed and were deleted |
| 4.1 selected retrieval frontier | blocked by residual legacy frontier | Add the empirical-spine `SelectedRetrievalFrontier` sidecar: admitted-row `retrieved_at` support on empirical primitives → support trace through empirical carrier/subject spans → per-anchor paired frontier → `_build_selected_cohort_inputs`, row epoch bounds, and completeness eval ages. `cohort_list['tau_observed']` is not a valid substitute for multi-hop `window()`. |
| 4.2 deletions | — | post-cutover `wc -l cohort_forecast_v3.py`: _N_ |
| 4.6 codebase docs | — | |
| 5.1 FE stale adjusted/blended cleanup | — | remove/quarantine `rateBlended` / `rate_blended` / `rate_adjusted` promises |
| 5.4 glossary updates | — | codebase + public glossaries; no adjusted/IPW/MCAR active terms |

---

## Atom 1.3 strict-xfail ledger

Survey of `strict=True` markers in `graph-editor/lib/tests/` captured 16-May-26 via `grep -rn 'strict=True' graph-editor/lib/tests/`.

### Flip-to-green triggers for this cutover

Strict xfails whose `reason=` names this cutover (Pop D/C deletion, mode-blind reducer, mask plumbing, multi-hop evidence parity). Each MUST XPASS by Stage 3 acceptance and the marker MUST be deleted in the same commit — XPASS without deletion is not closure (AP59).

| # | Test | Location | Trigger phrase from `reason=` |
|---|---|---|---|
| 1 | `test_first_latency_edge_with_nonlatent_chain_observed_collapses_to_window` | `test_cohort_factorised_outside_in.py:2339` | "Active-cohort row pipeline derives observed-prefix mass from the carrier-reclock surface (`SelectedAClockEvidence` + `_join_conditioned_carrier_backmap`) instead of reading realised X-day counts directly. … forks on `is_active_carrier`. … Flips green when the case-fork is removed and the row pipeline degenerates algebraically — one formula whose carrier-reach factor structurally vanishes under δ(0)." |

### Non-trigger strict xfails (record for context; not in scope for this cutover)

These markers do **not** name this cutover and are unrelated workstreams. Listed only so we can detect surprise XPASS / XFAIL flips during the baseline gate.

| # | Test | Location | Owning workstream |
|---|---|---|---|
| 2 | `test_cli_single_hop_downstream_cohort_parity_and_admitted_provenance` | `test_cohort_factorised_outside_in.py:2841` | Doc 60 WP8 (cohort admission provenance) |
| 4 | `test_surprise_gauge_prefers_temporal_candidate_regime` | `test_cf_query_scoped_degradation.py:268` | Doc 60 WP8 (cohort regime selection) |
| 5 | `test_lag_fit_and_surprise_gauge_share_downstream_temporal_mode_split` | `test_doc56_phase0_behaviours.py:613` | 73q Phase 5a (surprise_gauge migration to `ResolvedCFRuntime`) |

(Index #3 is a docstring-only mention of a previously-removed marker at `test_cohort_factorised_outside_in.py:4022`, not an active xfail.)

### Strict xfails affected by Stage 4 deletions (disposition required at Stage 4)

These markers cite 73q Phases 2-3, NOT this cutover, but their test bodies reference symbols this cutover deletes at Atom 4.2 (e.g. `_build_selected_source_day_mass`, per-source-day forward-fill quadrature). They will fail to even import after deletion and require explicit disposition during Stage 4 cleanup (rewrite against new APIs, delete entirely, or migrate as part of a `73q` follow-up). Not a Stage 3 flip-to-green trigger.

| # | Test | Location | Affected symbol(s) |
|---|---|---|---|
| 6 | `test_per_source_day_forward_fill_preserves_monotonicity_under_sparse` | `test_selected_cohort_pop_d_distribution.py:1308` | per-source-day forward-fill machinery (Atom 4.2 quadrature deletions) |
| 7 | `test_m_select_construction_for_multi_hop_downstream_node` | `test_selected_cohort_pop_d_distribution.py:1608` | imports `_build_selected_source_day_mass` (deleted at Atom 4.2) |
