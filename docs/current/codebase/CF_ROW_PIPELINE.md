# CF Row Pipeline

**Status**: Active reference, 12-May-26
**Scope**: how the v3 conditioned-forecast row builder turns a `ResolvedCFRuntime` into chart rows — the dual-prefix object model, the selected-cohort reducer, the row schema, the epoch model. Companion to [CF_PRIMITIVE_SUBSTRATE.md](CF_PRIMITIVE_SUBSTRATE.md) (the substrate that produces the runtime) and [FORECAST_RUNTIME_ARCHITECTURE.md](FORECAST_RUNTIME_ARCHITECTURE.md) (the runtime object).

> New to the CF cluster? Read [CF_MAP.md](CF_MAP.md) first for orientation and the canonical reading order.

This is the chart-evidence engine for `cohort_maturity_v3` and the row surface the conditioned-forecast endpoint returns. The pipeline is concentrated in `cohort_forecast_v3.py` (lines 4112 onward).

---

## ⚠️ STOP — read this before adding any code

**Defensive coding inside the engine is dangerous and must be avoided.** No `or 0.0`, no `np.clip`, no `try/except: pass`, no `if x is None: return`, no `max(0.0, ...)` clamps on residuals, no schema case-forks (`y` vs `Y`, `str` vs `date`). All defence lives at the perimeter ([INVARIANTS.md](INVARIANTS.md) I-47).

**Branching by case is the recurring failure mode** ([KNOWN_ANTI_PATTERNS.md](KNOWN_ANTI_PATTERNS.md) AP58). The row pipeline carries the worst of it — ~10 `if identity_carrier:` branches in the selected-Cohort reducer (audit H-5, partially retired May 2026 when the `_synthesize_identity_carrier_observed_surface` parallel pipeline was folded into the unified `_build_observed_span_evidence_surface` as a zero-edge degeneracy). These remaining branches are **debt to be retired gradually**, not precedent. Identity carrier is **data**, not a route — `composed_carrier = None`, reach=1, CDF=Dirac(0) — and the design target is one code path that degenerates algebraically.

**The maintainer constantly polices these patterns and will revert new instances.** Rules: [CF_ENGINE_DISCIPLINE.md](CF_ENGINE_DISCIPLINE.md). If existing code in this file seems to justify a fallback or a case-fork ("look, the surrounding code already does it"), you are looking at exactly the debt that's being retired. Match the substrate's discipline. The 21 findings in [`cf-defensive-findings.md`](../project-generalise/cf-defensive-findings.md) — H-1 monotone-repair clamp at `:3587`, H-4 residual floor at `:5347`, H-5 pervasive identity-carrier branching, M-1 try/except swallows around `runtime.selected_y_prefix` — are all on the remediation list. None are precedent.

When in doubt: **let X=0 produce NaN, let missing prefixes refuse cleanly, let downstream consumers see the absent state**. Algebraic degenerate is the contract. The seam invariant (§3 below) is what makes it work end-to-end.

---

## 1. The pipeline at a glance

```
                                  RESOLVED RUNTIME (substrate output)
                                         │
                                         ▼
┌────────────────────────────────────────────────────────────────────┐
│ 1. Frame evidence                build_cohort_evidence_from_frames │
│    Raw observed snapshot rows  →  engine_cohorts, cohort_list,     │
│    epoch boundaries (tau_solid_max, tau_future_max), max_tau.      │
│    Active-mode: subject prefixes zeroed (X-frames ≠ A-clock).      │
├────────────────────────────────────────────────────────────────────┤
│ 2. Selected base mass         _root_window_carrier_n_by_anchor_day │
│    Per-anchor a_pop from the first carrier primitive's root-window │
│    n. Frame-bundle 'a' is NOT admissible. Active mode only.        │
├────────────────────────────────────────────────────────────────────┤
│ 3. Source-day mass surface         _build_selected_source_day_mass │
│    M_select(U, C, u) = N_cohort(C) × g_{A→U}[u − C] for every      │
│    subject primitive source node U. A→U composed through shared    │
│    timing algebra. U = X is one element, not a separate path.      │
├────────────────────────────────────────────────────────────────────┤
│ 4. Carrier-only X prefix      _build_carrier_only_denominator_prefix│
│    X_prefix(C, τ) = N_cohort × G_carrier(C, τ) at the denominator  │
│    node. Sourced from M_select(X) — same carrier reference as Y.   │
├────────────────────────────────────────────────────────────────────┤
│ 5. Selected A-clock evidence   _build_selected_a_clock_evidence_   │
│    Carrier + subject observed surfaces (topology max-flow). Subject│
│    placement via _join_conditioned_carrier_backmap. Cell amplitude │
│    from X_prefix and Y_prefix. Per-anchor strict support frontiers.│
├────────────────────────────────────────────────────────────────────┤
│ 6. Rate-attributed Y prefix    _build_rate_attributed_subject_prefix│
│    Y_prefix(C, τ) = Σ_u M_select(U, C, u) × k_atorbef(u, τ)/n      │
│    layered through subject chain in topology order. Terminal       │
│    edge's cumulative IS Y_prefix.                                  │
├────────────────────────────────────────────────────────────────────┤
│ 7. Selected-cohort reducer    _selected_cohort_group_rate_draws    │
│    Per-particle Pop D + Pop C mass on factorised carrier × subject.│
│    rate(s, τ) = ΣY(s, τ) / ΣX(s, τ); NaN where X=0. The E+F        │
│    midpoint / fan authority.                                       │
├────────────────────────────────────────────────────────────────────┤
│ 8. Row projection                       _project_runtime_rows      │
│    Aggregates SelectedAClockEvidence per-τ; quantiles the reducer  │
│    draws (E+F) and overlay draws (F-mode, model-curve); blends     │
│    rate_blended; emits coverage signals; attaches forecast_y/x.    │
└────────────────────────────────────────────────────────────────────┘
```

Identity-carrier mode (`population_root == denominator_node` — i.e. `window()` and `cohort(A=X)`) used to bypass steps 2-7 and read prefixes directly off `engine_cohorts.obs_x/obs_y` via a rescue branch in the reducer. Atom-3 stage 4 (May 2026) deleted that branch. **All modes — identity carrier and active — now run through the full pipeline (steps 1-8) and read prefixes from `SelectedAClockEvidence`.** When the candidate pool contains no `subject_from = pop_root` rows with `slice_family = WINDOW`, the prefix-construction layers (2-6) refuse and the reducer reports zero-prefix-from-prior (visible degradation, not silent rescue).

**Known structural debt against this unified model** (`docs/current/cohort-maturity-evidence-coverage-design.md`, [`cf-defensive-findings.md`](../project-generalise/cf-defensive-findings.md) H-5):

- The reducer (`_selected_cohort_group_rate_draws`) still has ~10 `if identity_carrier:` branches for Pop D / Pop C arithmetic. These compute correct degenerate values but are case-forks against the AP58 contract; the target factoring expresses them as `composed_carrier=None ⇒ identity reach=1, Dirac arrival` flowing through one formula.

**Recently retired** (May 2026):

- `_synthesize_identity_carrier_observed_surface` parallel pipeline. Folded into `_build_observed_span_evidence_surface` as a zero-edge degeneracy: when `root_node == end_node`, the unified function dispatches to `_build_zero_edge_observed_surface`, which reads `n_weighted` off the primitive rooted at the node. This still has an internal "topology empty?" clause that selects between reading `n_weighted` from the X-rooted primitive vs accumulating `k_weighted` through chain max-flow. Collapsing that final clause requires a design decision about how the carrier observed surface should encode chain-side coverage gaps in active mode (the two readings diverge under incomplete observations).

### 1a. Data flow vs call order

The 8-step listing above describes the **data flow** — what each layer reads and produces. The **call order** inside the public entry `compute_cohort_maturity_rows_v3` is **interleaved** with the primitive substrate (CF_PRIMITIVE_SUBSTRATE.md Stage A):

```
compute_cohort_maturity_rows_v3:
  1. resolve_model_params                       (resolves priors)
  2. build_cohort_evidence_from_frames          ←  Row layer 1
  3. _aggregate_request_candidates              (flatten evidence to one pool)
  4. build_resolved_cf_runtime                  ←  Substrate stage A (A1–A5)
  5. _root_window_carrier_n_by_anchor_day       ←  Row layer 2
  6. _build_selected_source_day_mass            ←  Row layer 3
  7. _build_carrier_only_denominator_prefix     ←  Row layer 4
  8. _build_selected_a_clock_evidence_from_runtime
                                                ←  Row layers 5 + 6
  9. _project_runtime_rows                      ←  Row layers 7 + 8
```

Row layer 1 runs **before** the substrate, not after. Row layers 5+6 are produced together inside one call; layers 7+8 likewise. The primitive substrate (A1–A5) sits between row layer 1 and row layer 2. This is by design: the substrate consumes the candidate pool the row pipeline already flattened, and the row pipeline then reads runtime objects the substrate produced.

### 1b. Single-pool invariant for evidence

Per `COHORT_ANALYSIS_NUMERATOR_DENOMINATOR_SEMANTICS.md` invariant 2 ("one entry point for evidence"), **every consumer in the row pipeline reads evidence from the same canonical pool: `runtime.request_evidence_candidates`**. This is the flat, deduplicated `Sequence[EvidenceCandidate]` built by `_aggregate_request_candidates` before `build_resolved_cf_runtime` is called.

Concrete consequences:

- The primitive substrate (Stage A) consumes the pool via `evidence_candidates=` on `build_resolved_cf_runtime`, which copies it onto the runtime as `request_evidence_candidates` (a tuple).
- Row layer 2 (`_root_window_carrier_n_by_anchor_day`) reads `runtime.request_evidence_candidates` directly. It accepts the flat sequence — not a per-edge-keyed dict shape.
- The public entry `compute_cohort_maturity_rows_v3` still accepts the legacy `per_edge_subject_candidates` and `per_edge_upstream_candidates` parameters. They are a caller convenience for production (`api_handlers.py` builds them via `build_(carrier_)superset_candidates_by_edge` and passes both). They feed `_aggregate_request_candidates` only and are not read elsewhere.

A test or production call that supplies `evidence_candidates=` directly drives the same data path as production — no parameter-shape switch.

---

## 2. The dual-prefix object family

Active `cohort(A != X)` exposes a four-piece object family. Together they are the **selected** chart evidence — observed cumulative mass paired with rate-attributed projection on the **selected A-clock**, not the X-clock.

### 2.1 `_SelectedSourceDayMass` — `M_select(U, C, u)`

For each subject primitive source node U (including U=X as one element of the set), `M_select(U, C, u_U) = N_cohort(C) × g_{A→U}[u_U − C]`. `g_{A→U}` is the per-day arrival increment of the A→U distribution from the **shared timing algebra** (the same composer `prefix_arrival.py` uses for the runtime's carrier and subject arrival maps). Reach-preserving: `Σ_τ g_{A→U}[τ] = reach_{A→U}`, so `Σ_τ M_select(U, C, τ) = N_cohort × reach_{A→U}` is the actual physical selected-cohort mass that arrives at U.

Single-hop is U=X plus the terminal subject destination. Multi-hop is U=X plus intermediate subject sources. **One uniform construction**, no branch on hops.

Source: `cohort-1apr-falling-k-problem-statement.md` §A.1, §A.3 line 153, §A.6 phase 1. I-45.

### 2.2 `_CarrierOnlyDenominatorPrefix` — `X_prefix(C, τ)`

`X_prefix(C, τ) = N_cohort(C) × G_carrier(C, τ)` at the denominator node X. Sourced by integrating `M_select(X, C, ·)` per anchor day — **same carrier reference as Y_prefix**. Plateaus at `N_cohort × reach_{A→X}`.

Critical: this must use the **prior** carrier-only A→X composition (from M_select), NOT the joint-conditioned `composed_carrier`. The joint object re-smooths evidence with the posterior it is meant to inform. §A.3.

### 2.3 `_RateAttributedSubjectPrefix` — `Y_prefix(C, τ)`

The terminal subject primitive's per-source-day rate-attributed cumulative count, summed across source days **after** per-source-day carry-forward. Built layer-by-layer in subject-chain topology order: each primitive U→V accumulates per-(C, source_day, τ) buckets, the per-cell contribution is `M_select(U, C, u) × k_atorbef(u, τ) / n_atorbef(u, τ)`. The terminal primitive's per-(C, τ) cumulative is Y_prefix.

Single-hop is chain-of-length-1: the first primitive is also the terminal. Composition pattern uniform. §A.1 §159.

Two evaluation modes coexist (`use_evidence_local_ledger=True` for identity carrier, deterministic rate push-forward; `False` for active, M_select-keyed propagation). The audit's H-1 monotone-repair clamp lives at `:3587` inside this builder — see [`cf-defensive-findings.md`](../project-generalise/cf-defensive-findings.md).

### 2.4 `SelectedAClockEvidence` — the cell surface

`SelectedAClockEvidenceCell(anchor_day, τ, x_at_query_x, y_at_subject_end, carrier_landing_coverage, subject_landing_coverage)` — one cell per `(anchor, τ)` where any role has observed support at-or-before τ.

Cell **presence** is observed-evidence-driven (carrier observed surface or subject observed surface or Y_prefix has a landing). Cell **amplitude** reads from `X_prefix` and `Y_prefix`. The two concerns are decoupled — §A.1 §157: "the carrier observed surface gates whether a cell exists; X_prefix carries amplitude."

`strict_support_by_anchor` records per-anchor `(carrier_fresh_tau, carrier_value_tau, subject_tau, paired_tau)` from observed-surface landings where `landing_coverage > 0`. Forward-fill is for value, never for coverage. `analysis_observation_frontier_date` is the **single** query-wide as-of datum, capped by explicit asat or today. See `selected-a-clock-retrieval-frontier-provenance-proposal.md`.

---

## 3. The seam invariant

The reducer (`_selected_cohort_group_rate_draws`) and the row builder (`aggregate_by_tau`) **MUST** read the **same** selected prefix object for every selected cohort. This is the "seam invariant" (§A.4): if they read different prefixes, the chart's `midpoint` and `evidence_y/evidence_x` numerically diverge across the epoch boundary even when they should agree.

The seam is enforced at `cohort_forecast_v3.py:4751-4761`:

> "in active mode the reducer's `x_frozen` / `y_frozen` and the row builder's `aggregate_by_tau` must read the SAME selected prefix object. When `selected_a_clock_evidence` is provided, it is authoritative for every selected cohort; the legacy `engine_cohort.obs_x/obs_y` fallback is refused to prevent the seam from gapping."

Active cohorts without selected cells become **zero-prefix, frontier 0** (whole `a_pop` projected from the prior through the model arm) — NOT a fallback to `engine_cohort.obs_x/obs_y` (which is the legacy frame-derived path the active builder explicitly supersedes).

The seam runs through every active row: cells in `SelectedAClockEvidence` ↔ prefixes consumed by the reducer ↔ buckets aggregated for the E rows.

---

## 4. The selected-cohort reducer

`_selected_cohort_group_rate_draws` is the E+F trajectory authority — the per-particle group `ΣY(τ) / ΣX(τ)` after observed prefixes, Pop D, Pop C, carrier continuation, and subject progression have all been projected into mass.

For each selected cohort `d`, particle `s`, row age τ:

| τ relative to frontier | What happens |
|---|---|
| `τ ≤ frontier_d` | Observed prefix: `X_total[s, τ] += obs_x[τ]`, `Y_total[s, τ] += obs_y[τ]`. Deterministic across particles. |
| `τ > frontier_d`, identity carrier | `X_total[s, τ] += x_frozen` (forward-fill). Pop D residual via subject-only calibrated CDF ratio anchored at frontier: `Y_pop_D[s, τ] = (x_frozen − y_frozen) × R_y_d`. Pop C empty (`window()` defines later X-arrivals out of cohort; identity `A=X` has no carrier). |
| `τ > frontier_d`, active carrier | `X_total[s, τ] += x_frozen + (a_pop − x_frozen) × R_x` where `R_x = (G(τ) − G(f))/(1 − G(f))` is the conditional carrier residual. Pop D mixed over pre-frontier arrival distribution (each arrival slice has its own subject-clock age at frontier). Pop C = future X-arrivals × subject progression: `Y_pop_C` is the convolution of conditional post-frontier carrier increments `arr_inc` with the **unshifted** subject CDF `H_subj_unshifted` (Pop C members are fresh at X on arrival, subject clock starts at zero). |

Notable code-level subtleties:

- **Pop D uses `x_frozen` as upper bound, not `a_pop`.** The empirical `rate` row aggregates `Σy/Σx` with `obs_x` carry-forward past the frontier, so the per-particle reducer's denominator basis must match across the epoch A→B boundary. Substituting `a_pop` here produced a vertical cliff in conditioned (E+F) midpoint at `τ = tau_solid_max + 1`. `cohort_forecast_v3.py:4869-4882`.
- **Identity carrier `X_total[:, future_slice] += x_frozen`, not `a_pop`.** Same boundary-continuity rationale. `:4929-4942`.
- **NaN where `X_total = 0`, not zero.** Row quantiles ignore NaN cells and return `None` only when every particle is undefined at that age. Rate-cell NaN propagation is the contract.
- **No Y ≤ X cap at display layer.** X_prefix and Y_prefix share one `M_select(X)` reference; by construction `Y_prefix(C, τ) ≤ X_prefix(C, τ)` because every Y contribution is `mass × k/n` with `k/n ≤ 1` and X is `Σ_{u≤τ} mass`. Reintroducing the cap would silently repair a regression. §A.6 phase 6.

---

## 5. Row schema — three projection surfaces

`_project_runtime_rows` emits one row per `τ ∈ [0, max_tau]` with three independent projection surfaces. Terminology follows the frontier-conditioned chart-surface proposal, [Appendix B](../project-generalise/frontier-conditioned-chart-surface-proposal-21-May-26.md#appendix-b-standard-terminology-and-display-mapping) — **E, F, and E+F name display modes only; `ef_*` / `f_*` / overlay name internal surfaces**:

| Row surface | Source | Display mapping |
|---|---|---|
| `midpoint`, `fan_*`, `fan_bands`, `projected_rate` | `selected_projection.ef_rate_draws` (the spine's FC continuation surface, predictive operator basis) | **Forecast layer in E+F mode**. Prefix-pinned to strict evidence through each Cohort's frontier; predictive fan opens only after the frontier. Rendered in epochs B/C; suppressed in epoch A. |
| `forecast_x`, `forecast_y` | `selected_projection.ef_forecast_x` / `ef_forecast_y` (future residual emitted directly by the FC continuation DP) | Active-carrier future-only residual count fields. No post-hoc subtraction of strict evidence from full model means. |
| `model_midpoint`, `model_fan_*`, `model_bands` | `selected_projection.f_rate_draws` (the spine's unspliced query-conditioned model surface, epistemic operator basis) | **Conditioned model surface; F mode renders this**. |
| `model_curve_midpoint`, `model_curve_*`, `model_curve_bands` | `_composed_pair_per_tau_rate_draws` on `runtime.unconditioned_overlays['epistemic']` | **Optional model overlay** — existing unconditioned model curve with epistemic bands. Not a display mode; opt-in via the display setting `show_model_curve` and rendered alongside the active mode. |

Observed-evidence fields are separate from projection:

| Field | Identity carrier | Active carrier |
|---|---|---|
| `rate` | `Σy/Σx` from forward-filled `engine_cohorts` prefixes | `Σy/Σx` from `SelectedAClockEvidence.aggregate_by_tau` |
| `rate_pure` | Same | Frozen at the A/B boundary: `sum_y / boundary_x` for `τ > tau_solid_max` |
| `evidence_x`, `evidence_y` | From `engine_cohorts` | From selected cells (carrier-only X, rate-attributed Y) |
| `coverage` | Simple Cohort applicability scalar for display opacity | Same |
| `cohorts_covered_base`, `cohorts_covered_projected` | `n_cohorts` reporting observation at-or-before τ | Same |
| `rate_blended` | `empirical × coverage + model_midpoint × (1 − coverage)` — uniform expression across A/B/C epochs | Same |
| `forecast_y`, `forecast_x` | None (residual semantics only meaningful for active) | `ef_forecast_y` / `ef_forecast_x` (future-only residual emitted directly by the FC continuation DP — no post-hoc subtraction from full model means) |

The old `rate_blended` and terminal-coverage fields have been removed. E mode reads strict evidence; E+F reads the strict evidence layer plus the FC forecast layer (`ef_*`) per the display-mode mapping in §6.

`p_infinity_mean`, `p_infinity_sd`, `p_infinity_sd_epistemic` come from `ResolvedCFRuntime.public_moments`. They are scalar subject-span moments — **not** a promise that the selected-cohort group trajectory converges numerically to the final row midpoint.

---

## 6. The epoch model

Three epochs run across τ:

- **Epoch A** (`τ ≤ tau_solid_max`): every selected cohort is observed. `rate` is the solid empirical line. `midpoint`/`fan_*` (the FC continuation `ef_*`) are prefix-pinned to strict evidence here by construction, so they coincide with `rate` to particle-quantile noise; the output layer suppresses the forecast layer in epoch A so the solid evidence line owns the epoch.
- **Epoch B** (`tau_solid_max < τ ≤ tau_future_max`): some cohorts have aged past their `tau_observed` but the oldest cohort hasn't aged out yet. `rate` continues with forward-fill (dwindling cohort coverage); `midpoint`/`fan_*` from the FC continuation extend through the unresolved future as the predictive fan opens past each Cohort's frontier.
- **Epoch C** (`τ > tau_future_max`): every cohort has aged past `tau_max`. `rate` is `None`; only the forecast layer (and the optional model overlay, if enabled) is rendered.

`tau_solid_max` is `min(frontier_age)` across **selected** cohorts (the shallowest observed depth, not the youngest cohort's frontier — staleness varies per anchor). `tau_future_max` is `(sweep_to_d − anchor_from_d).days` — the oldest cohort's calendar age. Both are intentionally decoupled from per-cohort `data_retrieved_at` to preserve the `tau_solid_max ≤ tau_future_max` invariant the row builder and chart both rely on.

When `selected_a_clock_evidence` is present with cells, `row_tau_solid_max` and `row_tau_future_max` are recomputed from the selected frontier bounds (`frontier_tau_bounds`). The frontier on the selected A-clock can differ from the frame-derived frontier.

### 6.1 Display-mode epoch mapping

Per the frontier-conditioned chart-surface proposal, [Appendix B](../project-generalise/frontier-conditioned-chart-surface-proposal-21-May-26.md#appendix-b-standard-terminology-and-display-mapping):

| Display mode | Epoch A | Epoch B | Epoch C |
|---|---|---|---|
| **E mode** | strict evidence surface | strict evidence surface (cohort coverage dwindles) | no evidence layer |
| **F mode** | conditioned model surface (`f_*`) | conditioned model surface (`f_*`) | conditioned model surface (`f_*`) |
| **E+F mode** | evidence layer only (forecast layer suppressed in epoch A) | evidence layer + forecast layer (FC `ef_*`) | forecast layer only (FC `ef_*`) |
| **Optional model overlay** | overlay if enabled | overlay if enabled | overlay if enabled |

The FC surface (`ef_*`) is **generated across the full tau sweep regardless of display gating**. Epoch-A suppression of the forecast layer is an output-layer rendering choice, not a data gap. Every `ef_*` draw is pinned to strict evidence through each Cohort's frontier and continues only the unresolved future on the predictive operator basis, so prefix-pinning, continuity, and fan-opening are testable directly from the generated arrays.

---

## 7. The `_root_window_carrier_n_by_anchor_day` rule

Active selected base mass `a_pop` per anchor comes **only** from any candidate whose `subject_from` matches the population root **AND** whose slice family is `WINDOW` — i.e. the root-window evidence on the first carrier primitive rooted at A. Other candidates are filtered out. Per anchor day, `result[obs_date] = max(n)` across matching candidates.

Identity carrier: A == X, so the candidate-set matching `subject_from == X` is the X-rooted subject primitive itself — same function, same filter, different sub-object degenerates naturally. Sub-stage 2b natural-degeneracy framing.

Anchors without admissible root-window evidence in active mode get `a_pop = 0` and are **excluded from the active projection**. The frame-bundle `a` is **not** an admissible fallback (Phase 3 implementation plan). One exception: empty-frames synthesis (`tau_observed = -1` sentinel) preserves `a_pop = 1.0` as the natural Bayesian degeneracy — posterior reduces to prior at unit population.

Provenance is recorded per anchor: `'root_window_carrier_n'` / `'empty_frames_prior'` / `'no_root_window_evidence'`. Exposed on `rows[0]['_a_pop_provenance']`.

---

## 8. The midpoint shift

`_RateAttributedSubjectPrefix` integration applies a `midpoint_shift = 0.5` ONLY at the first subject layer (`U == query_denominator_X`) and ONLY when M_select places mass at multiple source days. The shift compensates for mass spread within the bucket-day axis: when `M_select(X, anchor)` is a Dirac at a single source day there is no interval to integrate; when it spans multiple days the integration is over `[s, s+1)` per day and the midpoint approximates the integral as `rate(τ − 0.5)`.

Downstream subject layers have already been placed by composed A→U timing — applying the shift again double-corrects the chain. Computed once per `(edge, anchor)` from the M_select shape so identity / single-source active / dense-spread active all flow through one expression without mode-flag forks. Code: `_build_rate_attributed_subject_prefix:3816`.

A separate three-point central curvature correction in `_interpolated_rate_at:3232-3251` handles the convexity bias from linear interpolation on a lognormal CDF — the chart-vs-oracle "rising-flank +3%" symptom in `cohort-outside-in-post-73n-regression-tracker.md`.

---

## 9. Sentinels and degeneracies

`frontier_age = -1` (the `tau_observed = -1` empty-frames sentinel) propagates from `build_cohort_evidence_from_frames`'s synthesised default through to `engine_cohort.frontier_age` and `engine_cohort.eval_age` separately. `eval_age = max(frontier_age, 0)` because completeness "at frontier" is undefined when there is no frontier. The reducer's observed-prefix loop iterates zero times under the sentinel and the future arm covers `τ = 0..T-1` against the prior — natural Bayesian degeneracy (posterior = prior).

`a_pop = 1.0` in the empty-frames branch preserves the unit-population unconditioned projection. Active-mode no-evidence (`no_root_window_evidence`) zeros `a_pop` instead, excluding the cohort.

`X_total > 1e-12` is the NaN-emission threshold. Below it the rate cell is undefined (`np.nan`).

---

## 10. What `_project_runtime_rows` does NOT do

- **Does not condition.** All conditioning is in `primitive_conditioning.condition_primitive`. See [INVARIANTS.md](INVARIANTS.md) I-48.
- **Does not re-run subset policy.** The doc-52 blend is at the primitive layer, not the projection layer. See [CF_PRIMITIVE_SUBSTRATE.md](CF_PRIMITIVE_SUBSTRATE.md) §3.7.
- **Does not re-decide semantics.** I-46. Row schema reads already-resolved runtime objects. If a projection needs information the runtime doesn't expose, fix the runtime — never synthesise the missing piece in the projection.
- **Does not invent or mutate `M_select`.** That is a runtime-resolved object (§A.6 phase 1). The projection reads `runtime.selected_source_day_mass`.
- **Does not patch active rows from local subject evidence.** X-clocked target frames are zeroed by `build_cohort_evidence_from_frames` in active mode. Selected A-clock observations only. Frame-bundle `a` is not an admissible fallback.
- **Does not run the legacy trajectory engine.** `forecast_state.compute_forecast_trajectory` is post-73n legacy with two surviving callers; the v3 row builder does not reach it. See [CF_HOLD_OUT_ENGINES.md](CF_HOLD_OUT_ENGINES.md).

---

## 11. Diagnostic surfaces

`emit_diagnostics=True` (CLI `--diag`) populates several forensic side-channels:

- `rows[0]['_selected_cohort_projection']` — per-cohort `i`, `frontier`, `a_pop`, `x_frozen`, `y_frozen`, `Y_pop_d_med`, `Y_pop_c_med`, `from_selected`.
- `rows[0]['_selected_a_clock_evidence']` — full cell dump, `rate_attributed_dual_eval_by_edge` (production / midpoint / integer / ff_integer conventions), carrier and subject observed-surface provenance, per-row placement lineage. Large enough to overflow V8's string limit on multi-hop active queries — emit only with `--diag`.
- `rows[0]['_a_pop_provenance']` — per-anchor `root_window_carrier_n` / `no_root_window_evidence` / `empty_frames_prior`.
- `rows[0]['_projection_basis']` — `has_observed_frontier`, `model_mass`, `model_mass_source` per cohort.

Without `--diag` these are absent — the production payload is much smaller.

---

## 12. Where to read next

- [CF_PRIMITIVE_SUBSTRATE.md](CF_PRIMITIVE_SUBSTRATE.md) — what produces the `ResolvedCFRuntime` this pipeline consumes.
- [FORECAST_RUNTIME_ARCHITECTURE.md](FORECAST_RUNTIME_ARCHITECTURE.md) — runtime fields the row builder reads.
- [COHORT_ANALYSIS_NUMERATOR_DENOMINATOR_SEMANTICS.md](COHORT_ANALYSIS_NUMERATOR_DENOMINATOR_SEMANTICS.md) — semantic contract, Pop C / Pop D / factorised vs gross-fitted.
- [`cf-defensive-findings.md`](../project-generalise/cf-defensive-findings.md) — known defensive-code violations in the row pipeline (monotone-repair clamp H-1; residual clamp H-4; identity-carrier branching H-5).
- [CF_REFACTOR_TRACKERS.md](CF_REFACTOR_TRACKERS.md) — the in-flight design trackers the code cites by `§`-number.
- [FORECAST_RUNTIME_SEMANTIC_PSEUDOCODE.md](FORECAST_RUNTIME_SEMANTIC_PSEUDOCODE.md) §A.7–A.9 — semantic pseudo-code for the selected-cohort reduction and row projection.
