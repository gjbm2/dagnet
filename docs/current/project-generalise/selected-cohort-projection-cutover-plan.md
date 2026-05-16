# Selected-Cohort Projection Cutover — Action Plan

**Status**: active execution plan
**Date**: 15-May-26
**Replaces**: prior `selected-cohort-projection-cutover-plan.md` and the partial `ACTION_PLAN_selected_cohort_spine_cutover.md` draft
**Phase context**: discharges Phase 6 implementation + Phase 7 + Phase 8 + Phase 9 of [model-first-strict-span-cutover-plan-13-May-26.md](model-first-strict-span-cutover-plan-13-May-26.md). Phase 5.5 (extracted spine) is closed; this plan starts from that state.

## Source contracts (external)

| Reference | What it pins |
|---|---|
| [phase-6-evidence-operator-contract.md](phase-6-evidence-operator-contract.md) | Four rules (§3), unified DAG mass-propagation (§4.3), cohort cancellation (§4.4), window non-cancellation (§4.5), three-stream coverage (§4.8), **empirical kernel form** (§4.9), spine mapping (§5), **strict vs adjusted readout** (§5.6), blind test families (§6.1, §6.2), 14-failure crosswalk (§6.5). **Appendix A (UNDER REVIEW)** — discretisation kernel construction (ΔG vs ΔH); the kernel-shift correction blocks Stage 2 until resolved. |
| [cohort-maturity-evidence-coverage-design.md](../cohort-maturity-evidence-coverage-design.md) | Three-state per-edge trichotomy (§3.1), per-row coverage (§2), display semantics (§4) |
| [COHORT_ANALYSIS_NUMERATOR_DENOMINATOR_SEMANTICS.md](../codebase/COHORT_ANALYSIS_NUMERATOR_DENOMINATOR_SEMANTICS.md) | Cohort vs window semantics; Appendix A invariant 5 (two-clocks T1 = role-root) |
| [CF_ROW_PIPELINE.md](../codebase/CF_ROW_PIPELINE.md) | Current legacy pipeline; the seam invariant (§3) |
| [FORECAST_RUNTIME_ARCHITECTURE.md](../codebase/FORECAST_RUNTIME_ARCHITECTURE.md) | `ResolvedCFRuntime` shape; live call order |
| [INVARIANTS.md](../codebase/INVARIANTS.md) I-45/I-46/I-47/I-48 | One resolution path; projections don't re-decide; engine fallbacks perimeter-only; single conditioning locus |
| [KNOWN_ANTI_PATTERNS.md](../codebase/KNOWN_ANTI_PATTERNS.md) AP58/AP59 | Forking by case; "architecturally complete" closure with the new path default-OFF |

This plan does not restate the algebra or the contracts. It states the imperatives needed to bring the engine, runtime, and row pipeline into conformance.

## Goal

Replace the legacy selected-Cohort row machinery (`_SelectedSourceDayMass`, `_CarrierOnlyDenominatorPrefix`, `_RateAttributedSubjectPrefix`, `_selected_cohort_group_rate_draws`, `_build_observed_span_evidence_surface`, `_join_conditioned_carrier_backmap`, `_interpolated_rate_at`, and `SelectedAClockEvidence` as a prefix authority) with a Spine-orchestrated row reducer that reads from **two operator families** through one DP/readout core:

- **Conditioned model operator** (already in place, per Phase 6 §4.1) — per-edge kernel is the fitted posterior CDF (`p × Δcdf`) from `ConditionedTransitionPrimitive` via `condition_primitive`. Drives `midpoint`, `fan_*`, `forecast_x`, `forecast_y`, `completeness`, and — via the §4.8 masked-kernel streams — `coverage_x` / `coverage_y` / `exposure_x` / `exposure_y` / `frontier`.
- **Empirical evidence operator** (NEW — must be written, per Phase 6 §4.9) — per-edge kernel is `Δk_emp/n_emp` from admitted snapshot rows on the selected clock, forward-filled across absent ages, per-draw. Drives strict per-anchor `evidence_x_strict_by_anchor_tau` / `evidence_y_strict_by_anchor_tau`. The reducer derives strict (`evidence_x`, `evidence_y`, `rate`) and adjusted (`evidence_x_adjusted`, `evidence_y_adjusted`, `rate_adjusted`) row-level surfaces from these plus the conditioned coverage streams, per Phase 6 §5.6.

Both operators share: the same admitted candidate rows, the same arrival-map clock placement, the same `compose_primitive_span` composer, the same DAG DP, the same three-stream support/exposure mask, the same `seed_subject_from_carrier` per-cohort handoff. They differ only in the per-edge kernel construction (parametric posterior vs empirical row-derived).

**Critical**: the cutover must not collapse the empirical evidence surface into the conditioned model surface. Doing so would silently change E+F semantics (evidence_y would become posterior-projected instead of observed). Current legacy E+F semantics are correct and must be preserved; what changes is how they are computed.

## Outcome (unambiguous)

When this plan closes:

1. `_project_runtime_rows` calls exactly one selected-Cohort projection function for window, `cohort(A=X)`, and active `cohort(A!=X)`. No mode branch at the call site, no mode flag inside the reducer.
2. A **new empirical evidence operator** exists in the spine alongside the conditioned model operator. Both feed a single `project_selected_cohort_rows` reducer through the same DP/readout core; the reducer routes row fields to the appropriate operator (model fields ← conditioned; evidence fields ← empirical).
3. Per-cell observation masks (Phase 6 §4.7) plumb from snapshot evidence rows through `bind_primitive_evidence` → `condition_primitive` → `ConditionedTransitionPrimitive` → `compose_primitive_span` → the composer's three-stream DP, and equivalently through the new empirical-evidence path. The `mask = np.ones((S, T))` placeholder at [subject_span_composer.py:473](../../graph-editor/lib/runner/subject_span_composer.py#L473) is gone.
4. `_SelectedSourceDayMass`, `_CarrierOnlyDenominatorPrefix`, `_RateAttributedSubjectPrefix`, `_selected_cohort_group_rate_draws`, `_build_observed_span_evidence_surface`, `_build_zero_edge_observed_surface`, `_join_conditioned_carrier_backmap`, `_interpolated_rate_at` (and its caches), `_composed_pair_request_cdf_draws`, and `generalised_span_model_shadow.py` are deleted. `grep -rn` over `graph-editor/lib/runner/` returns zero hits.
5. `SelectedAClockEvidence` is reduced to a diagnostic/schema adapter — owns no amplitude arithmetic, no prefix construction, no frontier authority.
6. Outside-in oracle remains green. **Strict E-mode semantics preserved exactly** — `evidence_x`, `evidence_y`, `rate` match legacy aggregations on the selected clock; `coverage`, `evidence_x_coverage`, `evidence_y_coverage`, `cohorts_covered_*`, frontier match legacy reductions. **E+F semantics shift cleanly** from the legacy linear `rate_blended` to the explicit IPW `rate_adjusted` per Phase 6 §5.6 — the row dict carries both names during cutover (`rate_blended` set equal to `rate_adjusted` for back-compat) and the FE switch from `baseRate` to `rate_adjusted` is a post-cutover follow-up. No new xfail markers. No loosened tolerances. No fixture or DSL weakening. No flag-OFF acceptance (per AP59).
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
- **From conditioned operator (masked — §4.8 streams, read at both terminals per Phase 6 §5.6)**:
  - At X (carrier terminal): `coverage_x_by_anchor_tau`, `exposure_x_by_anchor_tau` from `project_coverage_draws` / `project_cumulative_exposure_draws(read_node_*_draws(composed_carrier, x_node_id))`.
  - At Z (chain terminal): `coverage_y_by_anchor_tau`, `exposure_y_by_anchor_tau`, `frontier_by_anchor` from the same projections applied at the subject terminal.
  - All `Mapping[anchor_day, ndarray(T,)]`. Drive `evidence_x_coverage`, `evidence_y_coverage`, row-level `coverage`, `cohorts_covered_*`, frontier τ per anchor, and the IPW scaling factors for the adjusted evidence variants below.
- **From empirical operator (strict per-anchor cumulatives, per Phase 6 §4.9)**: `evidence_x_strict_by_anchor_tau`, `evidence_y_strict_by_anchor_tau` — `Mapping[anchor_day, ndarray(T,)]`. These are the unadjusted per-anchor cumulatives, summed across draws to the per-anchor scalar surface. The reducer derives the strict (E-mode) and adjusted (E+F-mode) row-level fields from these plus the per-anchor `coverage_x` / `coverage_y` / `exposure_x` / `exposure_y` above, per Phase 6 §5.6.

Body — top-to-bottom, no branches, two operator passes:

1. Build per-cohort seed at X via `seed_subject_from_carrier(...)` against `composed_carrier` (conditioned). Per-anchor seed for model projection.
2. Build per-cohort seed at X via `seed_subject_from_carrier(...)` against `composed_empirical_carrier`. Per-anchor seed for evidence projection. (Identity carrier degenerates trivially in both — zero-edge identity span has `δ(0)` at root.)
3. Read the conditioned operator's three streams (value / support / exposure with row-presence mask, per Phase 6 §4.8) at **both** terminals against the per-anchor model seed:
   - At Z (chain terminal): aggregate per (draw, anchor, τ) → `rate_draws_model`, `x_draws_model`, `y_draws_model`, `coverage_y_by_anchor_tau`, `exposure_y_by_anchor_tau`.
   - At X (carrier terminal): aggregate per (anchor, τ) → `coverage_x_by_anchor_tau`, `exposure_x_by_anchor_tau`.
   Both terminals share the same conditioned propagation through `composed_subject` / `composed_carrier`; only the read node differs. In window or `A=X` mode the carrier is the identity span and `coverage_x = 1`, `exposure_x = 1` trivially per (anchor, τ).
4. Convolve empirical seed through `composed_empirical_subject` per-node ledgers — value stream only, per Phase 6 §4.9. Aggregate per (anchor, τ) → `evidence_x_strict_by_anchor_tau`, `evidence_y_strict_by_anchor_tau`. These are the per-anchor strict cumulatives the reducer uses to derive both strict (E-mode) and adjusted (E+F-mode) row-level evidence.
5. Frontier per anchor = `max τ where exposure_y > 0` (chain-terminal exposure; the conditioned mask-propagated stream).
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
- **Strict vs adjusted decomposition (Phase 6 §5.6)**:
  - Strict path: with a fixture of full coverage everywhere, `evidence_x` / `evidence_y` / `rate` equal the per-anchor admissibility-filtered sums of `evidence_*_strict_by_anchor_tau`.
  - Adjusted path: with a fixture where some cohorts are partially observed (`coverage_y_A ∈ (0, 1)`), `evidence_y_adjusted = Σ_admissible evidence_y_strict_A / coverage_y_A` recovers the model's projected mass exactly when the empirical kernel is set equal to the conditioned kernel (sanity check on the IPW formula). With genuine empirical data, adjusted is bounded above by model-projected total and approaches it as coverage → 1.
  - Admissibility filter: cohorts with `exposure_y_A[τ] = 0` contribute neither to strict nor adjusted sums at that τ.
  - Per-terminal coverage: `coverage_x_A` and `coverage_y_A` are read at distinct nodes (X and Z) and used independently in the adjusted formula. Active-cohort fixture verifies `coverage_y_A ≤ coverage_x_A` in mass-weighted terms.

### Atom 2.5 — MCAR sparsity outside-in oracle (new test family)

New file: `graph-editor/lib/tests/test_mcar_sparsity_recovery_outside_in.py`. Synthetic-graph oracle that injects missing-completely-at-random sparsity into a fully-observed baseline and verifies the adjusted readout recovers the dense-data baseline within a stated noise tolerance. The dense baseline is the ground truth; sparsity injection is the deviation; IPW under MCAR is the claim that the adjusted output reverts to baseline.

**Fixture shape**:

- Synthetic multi-hop graph (3–4 edges, mix of serial / parallel-paths / branching topologies) generated with deterministic, calibrated edge probabilities and latencies — no MC noise in the data generation itself, so the dense baseline is analytic.
- A "dense" snapshot pool that admits a row at every (edge, source-day, age) cell in the wavefront support — this is the baseline. Run the row reducer; capture `evidence_y_dense[τ]`, `evidence_x_dense[τ]`, `coverage_dense[τ]`, `rate_dense[τ]`.
- A "sparse" snapshot pool derived from the dense pool by removing rows at random, independently per cell, with a fixed probability `p_drop ∈ {0.1, 0.3, 0.5}` per fixture variant. Independence is the MCAR injection; the dropout is uncorrelated with `(s, age, edge, k_value, n_value)` by construction.
- For each `p_drop` variant, run the reducer on the sparse pool. Capture `evidence_y_strict_sparse[τ]`, `evidence_y_adjusted_sparse[τ]`, `coverage_sparse[τ]`, `rate_adjusted_sparse[τ]`.

**Assertions**:

- **Strict shows the drop**: `evidence_y_strict_sparse[τ] < evidence_y_dense[τ]` at sufficiently high τ for `p_drop > 0`. Direction of inequality, not magnitude — strict undercounts when rows are missing, by definition.
- **Coverage drops proportionally to `p_drop`**: row-level `coverage_sparse[τ] ≈ 1 − p_drop`-ish at small τ where most cohorts are admissible; the relationship is mass-weighted so it's approximate, not exact. Quantitative check: `coverage_sparse` is monotone decreasing in `p_drop` across the variants.
- **Adjusted recovers the dense baseline**: for each `p_drop` variant, `evidence_y_adjusted_sparse[τ] ≈ evidence_y_dense[τ]` and `rate_adjusted_sparse[τ] ≈ rate_dense[τ]` within an explicit tolerance. The tolerance is bias-free (centred on zero) but grows with `1/coverage²` per Phase 6 §5.6 — use a finite-sample variance bound derived from the per-anchor admissible-count and `p_drop`, not a fixed numeric tolerance.
- **Admissibility filter behaves**: at τ past the synthetic frontier, exposure_y drops to 0 for late anchors; the adjusted row evidence shrinks toward zero as fewer cohorts contribute, while the model curve (read separately from the conditioned operator) continues smoothly. Verify the adjusted curve does not blow up at the frontier.
- **Per-terminal coverage**: at the carrier terminal (X), `coverage_x_sparse[τ]` recovers correctly under the same `p_drop`-injected sparsity restricted to carrier edges only; verify it's independent of subject-edge dropouts.

**Tolerance derivation**: the IPW estimator's variance is `Var[evidence_adjusted] ≈ Σ_A (evidence_strict_A)² × Var[1/coverage_A] ≈ Σ_A evidence_strict_A² × p_drop × (1 − p_drop) / (n_admitted_A × coverage_A²)` per Horvitz-Thompson. Use this to set a per-τ tolerance band; pass iff the observed delta is within ~3 standard deviations.

**Build acceptance** (in addition to the existing tests):
- `test_mcar_sparsity_recovery_outside_in.py` all green across `p_drop ∈ {0.1, 0.3, 0.5}` variants.
- A "stress" variant with `p_drop = 0.8` confirmed to fail the standard tolerance but still bias-free in mean over many fixture seeds — proving the variance-blowup story without claiming pointwise accuracy.

Tests are blind — expected numerics from first principles, not from current production output. Tolerance: float precision where deterministic (empirical operator); sampling-noise tolerance where MC (conditioned operator).

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

There is an unresolved question about the **conditioned** operator's per-edge kernel construction. See [phase-6-evidence-operator-contract.md Appendix A](phase-6-evidence-operator-contract.md#appendix-a--under-review-discretisation-kernel-construction) (UNDER REVIEW). It does NOT affect the empirical operator: the empirical kernel reads observed cumulative rates which integrate same-day conversions by construction (matches Phase 6 §3.1 directly). The discretisation question is whether the parametric posterior CDF, evaluated at integer τ, gives the right per-day kernel — and whether a half-day shift is needed. **Stage 2 of this plan blocks at the kernel-construction question for the conditioned operator until Appendix A closes.** The empirical operator can be built in parallel; it has no such question.

### Optional: shadow diagnostic during build

The implementer may add a temporary `--diag`-only call site in `_project_runtime_rows` that runs `project_selected_cohort_rows` alongside `_selected_cohort_group_rate_draws` and logs per-(draw, τ) deltas for triage. Use it to categorise pre-cutover deltas as legacy bug / display difference / new-path defect. It is **diagnostic-only — not a gate**. It is removed in Stage 3.

---

## Stage 3 — Cut over

**THE RISK EVENT.** One commit, one call-site flip, three modes activated simultaneously.

### Atom 3.1 — Build the cohort-list helper

Add `_build_selected_cohort_inputs(engine_cohorts, n_by_anchor) -> Sequence[Mapping]` in `cohort_forecast_v3.py`. Returns the per-cohort dict the new reducer takes — `anchor_day`, `N_anchor` from `n_by_anchor`, `tau_max` from `engine_cohorts`. This is the only piece of the row layer that still touches per-anchor `N` — appropriate at the row layer because it is perimeter admission (Phase 6 §5.2).

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

### Atom 3.3 — Migrate row-field reads

Inside `_project_runtime_rows`, update the row-field reads to source from the new projection. **Existing row schema preserved for back-compat; strict/adjusted fields added** per Phase 6 §5.6. Each row field is routed to one of: empirical operator (strict observed counts), conditioned operator (model projection), or conditioned-with-mask (§4.8 streams). Evidence fields exist in both strict and adjusted variants; the chart picks the variant per display mode.

| Row field | Legacy source | New source | Operator family |
|---|---|---|---|
| `midpoint`, `fan_*`, `fan_bands`, `projected_rate` | `_selected_cohort_group_rate_draws.rate_draws` quantiled at τ | `project_selected_cohort_rows.rate_draws_model` quantiled — identical algebra | **Conditioned** |
| `forecast_x`, `forecast_y` | Reducer's `.x_draws`/`.y_draws` mean − evidence | New projection's `.x_draws_model`/`.y_draws_model` mean − evidence | **Conditioned** |
| `evidence_x`, `evidence_y` (strict — E-mode line) | `selected_evidence_by_tau[tau]['sum_x'/'sum_y']` from `SelectedAClockEvidence.aggregate_by_tau` over admitted rows | `Σ_admissible evidence_y_strict_by_anchor_tau[anchor][tau]` (and `_x_strict`) — empirical operator's per-anchor terminal cumulative, admissibility-filtered by `exposure_y_A > 0` then summed across anchors | **Empirical (strict)** |
| `rate` (strict — E-mode line) | `evidence_y / evidence_x` from `SelectedAClockEvidence.aggregate_by_tau` | `evidence_y / evidence_x` (both strict). Legacy formula preserved; the inputs are the strict empirical sums above. | **Empirical (strict)** |
| `evidence_x_adjusted`, `evidence_y_adjusted` (NEW — E+F-mode line) | (none — replaces legacy `rate_blended`) | `Σ_admissible evidence_y_strict_A[τ] / coverage_y_A[τ]` (and `_x` analogously with `coverage_x_A`). IPW under MCAR per Phase 6 §5.6. | **Empirical (adjusted)** |
| `rate_adjusted` (NEW — E+F-mode line) | (none) | `evidence_y_adjusted / evidence_x_adjusted`. Supersedes legacy `rate_blended`. | **Empirical (adjusted)** |
| `coverage`, `evidence_x_coverage`, `evidence_y_coverage` | Per-cell `*_landing_coverage` aggregated and capped at [cohort_forecast_v3.py:5548-5571](../../graph-editor/lib/runner/cohort_forecast_v3.py#L5548-L5571) | Per-anchor `coverage_x_by_anchor_tau` (at X, carrier terminal) and `coverage_y_by_anchor_tau` (at Z, chain terminal) from the §4.8 masked-kernel construction against the conditioned operator; reduced across anchors via the same `min(...)` cap-and-reduce. `evidence_x_coverage` and `evidence_y_coverage` are the per-terminal row-level scalars; `coverage` is the combined min reduction. | **Conditioned (masked)** |
| `cohorts_covered_base`, `cohorts_covered_projected`, frontier τ per anchor | `bucket['n_cohorts']` and `_observation_frontier` | `Σ_anchor 𝟙[exposure_y_A > 0]` and `frontier_by_anchor` from the conditioned operator's exposure stream at Z. Admissibility per (anchor, τ) drives both. | **Conditioned (masked)** |
| `model_midpoint`, `model_fan_*`, `model_bands`, `model_curve_*` | F-mode + epistemic overlay through spine | **Unchanged** (already on spine, conditioned operator with prior-only primitives) | **Conditioned (unconditioned overlay)** |
| `rate_pure` | Empirical aggregation | Strict empirical per `rate` above. | **Empirical (strict)** |
| `rate_blended` (DEPRECATED) | Legacy linear blend at [cohort_forecast_v3.py:5701-5704](../../graph-editor/lib/runner/cohort_forecast_v3.py#L5701-L5704) | **Superseded by `rate_adjusted`** per Phase 6 §5.6. During cutover the field can be set equal to `rate_adjusted` for back-compat with any consumer still reading it; final removal is a post-cutover follow-up. | n/a — deprecated |
| `p_infinity_*`, `completeness*` | `ResolvedCFRuntime.public_moments` / `_runtime_completeness` | **Unchanged** | (Scalar; orthogonal to the row-reducer) |

**Why this split matters**: three distinct chart concerns route to three different operator readouts per Phase 6 §4.9 + §5.6 — (1) empirical readout in strict / adjusted variants from the empirical operator; (2) coverage / frontier from the conditioned operator with row-presence mask (§4.8 — requires a value kernel positive everywhere; the empirical kernel's value collapses the ratio to 1); (3) model surfaces from the conditioned operator. The strict / adjusted decomposition replaces the legacy `rate_blended` linear blend with explicit IPW under MCAR; E+F shows adjusted and model as two separate lines, not a row-level blend. Collapsing any two of the three concerns into a single operator is AP58.

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

The row dict schema is unchanged. JSON shape is preserved. Downstream consumers (cohort_maturity endpoint, conditioned-forecast endpoint, FE chart code at [cohortComparisonBuilders.ts](../../graph-editor/src/services/analysisECharts/cohortComparisonBuilders.ts)) don't change as a result of cutover.

The FE rate-line switch from raw `baseRate` (strict, E-mode) to `rate_adjusted` (IPW-scaled, E+F-mode) at [cohortComparisonBuilders.ts:519-528](../../graph-editor/src/services/analysisECharts/cohortComparisonBuilders.ts#L519-L528) is **not** a Stage 3 atom; it's a post-cutover follow-up per Phase 6 §5.6. It needs production data showing the adjusted curve degrades smoothly across the frontier (admissibility-filtering thins contributing anchors → adjusted thins toward zero) while the unconditioned model curve continues as a separate line. The legacy `rate_blended` field is set equal to `rate_adjusted` during cutover for back-compat and removed in a later cleanup once consumers migrate to the explicit `_adjusted` names.

Diagnostic side-channels (`rows[0]['_selected_a_clock_evidence']`, `rows[0]['_selected_cohort_projection']`) — shape preserved by the Stage 4 adapter; values now derive from spine surfaces.

---

## Stage 4 — Clean up

Mechanical. Grep gate after each deletion. Production hits → block (means a consumer was missed at Stage 3, return upstream).

### Atom 4.1 — Reduce `SelectedAClockEvidence` to an adapter

Inside `_build_selected_a_clock_evidence_from_runtime` at [cohort_forecast_v3.py:4401](../../graph-editor/lib/runner/cohort_forecast_v3.py#L4401), delete the `_build_observed_span_evidence_surface` / `_join_conditioned_carrier_backmap` / `_build_rate_attributed_subject_prefix` calls. Build the `SelectedAClockEvidence` instance from the new projection's surfaces — `cells_by_anchor_day` derived from per-anchor cumulative value/denominator surfaces. Preserve the `--diag` JSON shape; values derive from spine.

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

The legacy `rate_blended = empirical × coverage + model × (1 − coverage)` linear blend is superseded by IPW-based `rate_adjusted` — a user-visible contract change. The display-contract docs that previously described the linear-blend semantic MUST be updated explicitly; silent supersession across authority docs is itself an AP58 hazard.

- [CF_ROW_PIPELINE.md](../codebase/CF_ROW_PIPELINE.md) — rewrite §1–§4 to describe the new pipeline including the empirical / conditioned operator split (Phase 6 §4.9) and the strict / adjusted readout decomposition (Phase 6 §5.6); delete §7 detail and §8 midpoint-shift block; replace any `rate_blended`-as-E+F-contract passage with the new strict / adjusted decomposition.
- [cohort-maturity-evidence-coverage-design.md](../cohort-maturity-evidence-coverage-design.md) — update §2 (per-row coverage) and §4 (display semantics): remove the linear-blend carry-forward formula and replace with the strict (E) / adjusted (E+F) decomposition per §5.6. Coverage continues to drive alpha-on-blobs and dashing; E+F shows adjusted and model as two separate curves.
- [FORECAST_RUNTIME_ARCHITECTURE.md](../codebase/FORECAST_RUNTIME_ARCHITECTURE.md) — update §1, §2, §4, §5, §6 to remove deleted fields and the mode-equality identity-carrier check; add per-terminal coverage / exposure streams (`coverage_x`, `coverage_y`, `exposure_x`, `exposure_y`) as engine outputs.
- [INVARIANTS.md](../codebase/INVARIANTS.md) I-45/I-46/I-48 — add the cutover as a realisation; remove citations to deleted authorities.
- [KNOWN_ANTI_PATTERNS.md](../codebase/KNOWN_ANTI_PATTERNS.md) AP58 — record the realised closure of the BE cohort-forecast row reducer fork and the `rate_blended` → `rate_adjusted` supersession.
- [cf-defensive-coding-audit.md](cf-defensive-coding-audit.md) — mark H-5, F-1, H-1, H-4, M-1 closed.
- Cross-check: `grep -rn 'rate_blended\|coverage-blended\|linear blend' docs/current/` returns only superseded-as-of references.

---

## Stage 5 — FE / output follow-ups

The row dict carries the strict and adjusted fields after Stage 3; this stage adopts them in the chart code and in published terminology. Stage 5 atoms are post-cutover but blocking for closure of this plan, per the user-visible E+F semantic change.

### Atom 5.1 — Parse new row fields in the FE

At [cohortComparisonBuilders.ts:170-242](../../graph-editor/src/services/analysisECharts/cohortComparisonBuilders.ts#L170-L242), add the new row fields to the point object:

- `rateAdjusted: parse(r?.rate_adjusted)`
- `evidenceXAdjusted: parse(r?.evidence_x_adjusted)`
- `evidenceYAdjusted: parse(r?.evidence_y_adjusted)`

Existing fields stay (`baseRate ← rate`, `rateBlended ← rate_blended`, `evidenceXCoverage`, `evidenceYCoverage`). `rate_blended` is set equal to `rate_adjusted` in the row dict per Atom 3.3, so legacy consumers keep working.

### Atom 5.2 — Switch E+F mode to `rateAdjusted`

At [cohortComparisonBuilders.ts:519-555](../../graph-editor/src/services/analysisECharts/cohortComparisonBuilders.ts#L519-L555):

- Replace the `baseRate` filter/map in `solidPts` / `dashedPts` with `rateAdjusted` (the E+F line is now IPW-scaled empirical, not strict).
- Remove the `rateBlended` hidden dashed diagnostic line ([cohortComparisonBuilders.ts:557-570](../../graph-editor/src/services/analysisECharts/cohortComparisonBuilders.ts#L557-L570)) — superseded; the visible E+F line IS `rateAdjusted`.
- Remove the TEMP DIAGNOSTIC comment block; replace with a comment noting "E+F shows `rate_adjusted` (IPW under MCAR per Phase 6 §5.6); E mode shows `baseRate` (strict per Phase 6 §5.6); F mode shows model curve only."
- Keep the `midpoint` dotted line (the model curve in E+F mode) unchanged.

### Atom 5.3 — Preserve unchanged FE paths (no-change confirmation)

No FE change at three sites; flagged explicitly to prevent accidental drift:
- E-mode solid/dashed lines ([cohortComparisonBuilders.ts:491-516](../../graph-editor/src/services/analysisECharts/cohortComparisonBuilders.ts#L491-L516)) — continue reading `baseRate` (strict).
- F-mode midpoint ([cohortComparisonBuilders.ts:573-580](../../graph-editor/src/services/analysisECharts/cohortComparisonBuilders.ts#L573-L580)) — unchanged.
- Alpha-on-blobs ([cohortComparisonBuilders.ts:702-711](../../graph-editor/src/services/analysisECharts/cohortComparisonBuilders.ts#L702-L711)) — continue reading `coverage` (min-reduction of `evidence_x_coverage` and `evidence_y_coverage` per Atom 3.3); document the min reduction in the comment.

### Atom 5.4 — Update FE row-meta type for type safety

In the same file's `Point` interface ([cohortComparisonBuilders.ts:170](../../graph-editor/src/services/analysisECharts/cohortComparisonBuilders.ts#L170)):

- Add `rateAdjusted: number | null`, `evidenceXAdjusted: number | null`, `evidenceYAdjusted: number | null`.
- Leave `rateBlended` for back-compat; comment that it is now `rate_adjusted` carried under the legacy field name and that consumers should migrate.

### Atom 5.5 — Tooltip and copy update

At [cohortComparisonBuilders.ts:886-911](../../graph-editor/src/services/analysisECharts/cohortComparisonBuilders.ts#L886-L911): tooltip currently reads `baseRate` as the rate. In E+F mode the rate-shown-to-user is now `rate_adjusted`; tooltip should reflect the active value (whichever curve the user is hovering, with a label distinguishing strict vs adjusted). Audit other tooltip consumers in the codebase via `grep -rn "baseRate\|rate_blended" graph-editor/src/`.

### Atom 5.6 — Glossary updates

Add the novel terms of art to both glossaries (per Phase 6 §4.9 + §5.6):

- **Codebase glossary** ([docs/current/codebase/GLOSSARY.md](../codebase/GLOSSARY.md)): empirical operator, conditioned operator, value kernel, support kernel, exposure kernel, masked kernel, row-presence mask, coverage (§4.8), exposure (§4.8), strict evidence, adjusted evidence, IPW, MCAR, admissibility, frontier τ per anchor, per-terminal coverage (X vs Z).
- **Public glossary** ([graph-editor/public/docs/glossary.md](../../graph-editor/public/docs/glossary.md)): user-facing subset — coverage, exposure, frontier, strict evidence, adjusted evidence, IPW (with friendly explanation), MCAR (with friendly explanation). Omit internal-only algebraic concepts (carrier span, subject span, value/support/exposure kernels as named entities — fold their behaviour into the user-facing entries).
- **Existing Bayes terms** — audit and add standalone entries for those currently only mentioned within other definitions: EWMA, ESS, R̂ (rhat), PPC. Cross-check against [docs/current/codebase/GLOSSARY.md](../codebase/GLOSSARY.md) §Statistical.

### Atom 5.7 — Archive the plan

Move this plan from `docs/current/project-generalise/selected-cohort-projection-cutover-plan.md` to `docs/archive/project-generalise/selected-cohort-projection-cutover-plan.md`. Move the superseded `ACTION_PLAN_selected_cohort_spine_cutover.md` likewise. Update [docs/current/project-generalise/README.md](README.md) §"Picking this up later" to point at the archive.

---

## Stop conditions

Halt if:

- **The plan is about to source strict empirical fields (`evidence_x`, `evidence_y`, `rate`, `evidence_x_strict_by_anchor_tau`, `evidence_y_strict_by_anchor_tau`) from the conditioned operator.** Per Phase 6 §4.9, these must come from the empirical kernel (per-anchor `Δk_emp/n_emp` propagated through the DAG DP and summed). Sourcing them from the conditioned operator's terminal cumulative is the silent semantic regression — the E line would become a posterior projection of admitted evidence rather than a display of admitted evidence. Hard stop.
- **The plan is about to source coverage or exposure from the empirical operator.** Per Phase 6 §4.9 coverage paragraph, the empirical kernel is zero exactly where the mask is zero, so support/value collapses to 1 — coverage from the empirical operator is meaningless. Coverage and exposure must come from the conditioned operator with the row-presence mask (§4.8), read at X and Z. Hard stop.
- **The two-surface separation test (Atom 2.4) fails** because `rate_draws_model` and the strict empirical readout (`evidence_y_strict_by_anchor_tau` / `evidence_x_strict_by_anchor_tau`) are numerically equal where they shouldn't be. This means the operators have been wired with the same kernel family by mistake. The operator construction in Atom 2.2 has collapsed; fix before continuing.
- **Appendix A (discretisation kernel) of the Phase 6 contract has not closed** for the conditioned operator. Stage 2 cannot finalise the conditioned operator's kernel construction until that closes. The empirical operator can be built and tested independently while Appendix A is open.
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
| 1.1 photocopy | — | stash name: _record on completion_ |
| 1.2 baseline | ✓ passing | record outside-in pass count + xfail count |
| 1.3 strict-xfail ledger | — | list strict xfails citing this cutover here |
| 2.1 mask plumbing | — | |
| 2.2 empirical operator | — | |
| 2.3 row reducer in spine | — | |
| 2.4 blind algebra tests | — | including strict / adjusted decomposition tests |
| 2.5 MCAR sparsity oracle | — | test outside-in IPW recovery across p_drop variants |
| 3.2 call-site flip | — | _commit sha_ |
| 3.4 outside-in gate | — | pass count + which strict xfails XPASSed and were deleted |
| 4.2 deletions | — | post-cutover `wc -l cohort_forecast_v3.py`: _N_ |
| 4.6 codebase docs | — | |
| 5.2 FE rateAdjusted switch | — | E+F mode reads rate_adjusted from row dict |
| 5.6 glossary updates | — | codebase + public glossaries |
