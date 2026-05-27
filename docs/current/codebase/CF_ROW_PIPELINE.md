# CF Row Pipeline

**Status**: Active reference, 12-May-26
**Scope**: how the v3 conditioned-forecast row builder turns a `ResolvedCFRuntime` into chart rows — the dual-prefix object model, the selected-cohort reducer, the row schema, the epoch model. Companion to [CF_PRIMITIVE_SUBSTRATE.md](CF_PRIMITIVE_SUBSTRATE.md) (the substrate that produces the runtime) and [FORECAST_RUNTIME_ARCHITECTURE.md](FORECAST_RUNTIME_ARCHITECTURE.md) (the runtime object).

> New to the CF cluster? Read [CF_MAP.md](CF_MAP.md) first for orientation and the canonical reading order.

This is the chart-evidence engine for `cohort_maturity_v3` and the row surface the conditioned-forecast endpoint returns. The pipeline is concentrated in `cohort_forecast_v3.py` (lines 4112 onward).

---

## ⚠️ STOP — read this before adding any code

**Defensive coding inside the engine is dangerous and must be avoided.** No `or 0.0`, no `np.clip`, no `try/except: pass`, no `if x is None: return`, no `max(0.0, ...)` clamps on residuals, no schema case-forks (`y` vs `Y`, `str` vs `date`). All defence lives at the perimeter ([INVARIANTS.md](INVARIANTS.md) I-47).

**Branching by case is the recurring failure mode** ([KNOWN_ANTI_PATTERNS.md](KNOWN_ANTI_PATTERNS.md) AP58). The selected-cohort cutover (26-May-26) closed the worst instance: the legacy reducer's ~10 `if identity_carrier:` branches are gone. `model_span_spine.project_selected_cohort_rows` is **mode-blind** (`test_reducer_is_mode_blind_against_a_mode_field`), and identity carrier is now pure operator degeneracy — the carrier operator degenerates to reach=1, CDF=Dirac(0). The contract stands: one code path that degenerates algebraically; a new `if mode == ...` fork near the centre is wrong factoring, not precedent.

**The maintainer constantly polices these patterns and will revert new instances.** Rules: [CF_ENGINE_DISCIPLINE.md](CF_ENGINE_DISCIPLINE.md). If existing code seems to justify a fallback or a case-fork, treat it as debt, not precedent. The audit findings that lived in the legacy row reducer — H-1 (monotone-repair clamp), H-4 (residual floor), H-5 (identity-carrier branching), M-1 (try/except swallows) — were **closed** by the cutover that deleted that reducer; see [`cf-defensive-coding-audit.md`](../project-generalise/cf-defensive-coding-audit.md). Remaining engine-discipline debt lives in other files (span-core, Bayes).

When in doubt: **let X=0 produce NaN, let missing prefixes refuse cleanly, let downstream consumers see the absent state**. Algebraic degenerate is the contract. The seam invariant (§3 below) is what makes it work end-to-end.

---

## 1. The pipeline at a glance

```
                          RESOLVED RUNTIME (substrate output)
                                     │
                                     ▼
┌────────────────────────────────────────────────────────────────────┐
│ 1. Frame evidence              build_cohort_evidence_from_frames     │
│    Observed snapshot rows  →  engine_cohorts, cohort_list, epoch     │
│    boundaries (tau_solid_max, tau_future_max), max_tau.              │
├────────────────────────────────────────────────────────────────────┤
│ 2. Selected base mass       _root_window_carrier_n_by_anchor_day     │
│    Per-anchor a_pop from carrier root-window n. Frame-bundle 'a'     │
│    NOT admissible. Active overwrites a_pop; window/identity keep      │
│    a_frozen. (§7)                                                    │
├────────────────────────────────────────────────────────────────────┤
│ 3. Operators (two families)   model_span_spine.resolve_request_spans │
│    Conditioned/model operator: composed_subject / composed_carrier   │
│    (+ predictive variants). Empirical-evidence operator:             │
│    composed_empirical_subject / composed_empirical_carrier — strict  │
│    per-(source-day, age) observed value/support (Phase 6 §4.9).      │
│    Identity carrier = carrier operator degenerates (reach=1,Dirac0). │
├────────────────────────────────────────────────────────────────────┤
│ 4. Selected retrieval frontier   _build_selected_retrieval_frontier  │
│    One query-wide analysis-observation date → per-anchor frontier    │
│    f_c and row epoch bounds. (Atom 4.1)                              │
├────────────────────────────────────────────────────────────────────┤
│ 5. Selected-cohort reducer                                           │
│    model_span_spine.project_selected_cohort_rows. ONE DP core        │
│    reduces both operators over selected Cohorts × particles →        │
│    selected_projection: ef_rate_draws (FC continuation),             │
│    f_rate_draws (model surface), rate_strict / evidence_*_strict     │
│    (strict empirical Σy/Σx), ef_forecast_*. NaN where X=0.           │
│    Mode-blind: reads no is_window / identity flag.                   │
├────────────────────────────────────────────────────────────────────┤
│ 6. Row projection                       _project_runtime_rows        │
│    Quantiles the reducer draws; maps selected_projection surfaces to │
│    row fields; applicability-only coverage; attaches forecast_y/x.   │
└────────────────────────────────────────────────────────────────────┘
```

The selected-cohort cutover (26-May-26) replaced the legacy per-prefix machinery — the `_SelectedSourceDayMass` / `_CarrierOnlyDenominatorPrefix` / `_RateAttributedSubjectPrefix` dual-prefix family, the `SelectedAClockEvidence` cell surface, and the `_selected_cohort_group_rate_draws` reducer — with **two operators read through one DP core**. Window, cohort, and identity-carrier results are produced by **which operator degenerates**, not by branching: the reducer reads no mode or identity flag (guarded by `test_reducer_is_mode_blind_against_a_mode_field`). Strict observed evidence is owned by the empirical operator; the conditioned operator carries the model and predictive surfaces. The displayed rate is strict `Σy/Σx` plus separate model/forecast surfaces — there is **no** `rate_blended` linear blend and **no** `rate_adjusted` / IPW coverage; `coverage` is a display applicability/freshness signal only. When no admissible window-family evidence resolves, the empirical operator is empty and the reducer reports zero-prefix-from-prior (visible degradation, not silent rescue).

### 1a. Data flow vs call order

The 6-step listing above describes the **data flow** — what each layer reads and produces. The **call order** inside the public entry `compute_cohort_maturity_rows_v3` is **interleaved** with the primitive substrate (CF_PRIMITIVE_SUBSTRATE.md Stage A):

```
compute_cohort_maturity_rows_v3:
  1. resolve_model_params                       (resolves priors)
  2. build_cohort_evidence_from_frames          ←  Row layer 1
  3. _aggregate_request_candidates              (flatten evidence to one pool)
  4. build_resolved_cf_runtime                  ←  Substrate stage A (A1–A5);
                                                   resolves the conditioned +
                                                   empirical operators (layer 3)
  5. _root_window_carrier_n_by_anchor_day       ←  Row layer 2
  6. _build_selected_retrieval_frontier         ←  Row layer 4
  7. _project_runtime_rows                      ←  Row layer 6; internally calls
       └─ model_span_spine.project_selected_cohort_rows   ← Row layer 5
```

Row layer 1 runs **before** the substrate, not after. The primitive substrate (A1–A5) sits between row layer 1 and row layer 2 and resolves **both** operator families onto the runtime. The reducer (`project_selected_cohort_rows`) is invoked inside `_project_runtime_rows`, so row layers 5 and 6 share one call. This is by design: the substrate consumes the candidate pool the row pipeline already flattened, and the row pipeline then reads runtime objects the substrate produced.

### 1b. Single-pool invariant for evidence

Per `COHORT_ANALYSIS_NUMERATOR_DENOMINATOR_SEMANTICS.md` invariant 2 ("one entry point for evidence"), **every consumer in the row pipeline reads evidence from the same canonical pool: `runtime.request_evidence_candidates`**. This is the flat, deduplicated `Sequence[EvidenceCandidate]` built by `_aggregate_request_candidates` before `build_resolved_cf_runtime` is called.

Concrete consequences:

- The primitive substrate (Stage A) consumes the pool via `evidence_candidates=` on `build_resolved_cf_runtime`, which copies it onto the runtime as `request_evidence_candidates` (a tuple).
- Row layer 2 (`_root_window_carrier_n_by_anchor_day`) reads `runtime.request_evidence_candidates` directly. It accepts the flat sequence — not a per-edge-keyed dict shape.
- The public entry `compute_cohort_maturity_rows_v3` still accepts the legacy `per_edge_subject_candidates` and `per_edge_upstream_candidates` parameters. They are a caller convenience for production (`api_handlers.py` builds them via `build_(carrier_)superset_candidates_by_edge` and passes both). They feed `_aggregate_request_candidates` only and are not read elsewhere.

A test or production call that supplies `evidence_candidates=` directly drives the same data path as production — no parameter-shape switch.

---

## 2. The two operators

The selected-cohort reducer reads **two operator families** resolved onto the runtime by `model_span_spine.resolve_request_spans`. Both are `ComposedPrimitiveSpan` objects over the carrier (`A→X`) and subject (`X→end`) spans; they differ by what they carry. This replaces the legacy four-piece dual-prefix family (`_SelectedSourceDayMass` / `_CarrierOnlyDenominatorPrefix` / `_RateAttributedSubjectPrefix`) and the `SelectedAClockEvidence` cell surface — all deleted at the cutover.

### 2.1 Conditioned / model operator — `composed_subject` / `composed_carrier`

The query-conditioned model surface: per-draw `p × CDF` timing built from the conditioned primitives (the posterior after evidence updates the prior at the single conditioning locus, I-48). Predictive variants (`composed_subject_predictive` / `composed_carrier_predictive`) carry the predictive-dispersion draws the FC continuation fan opens against. This operator owns the model (`f_*`) and forecast (`ef_*`) surfaces.

### 2.2 Empirical-evidence operator — `composed_empirical_subject` / `composed_empirical_carrier`

The strict observed-evidence surface: per-(source-day, age) observed value and support read directly from `ConditionedTransitionPrimitive` evidence rows (Phase 6 §4.9). It is endpoint-exact — strict counts, not model smoothing — and owns the strict `rate_strict` / `evidence_*_strict` surfaces. Under §4.9 the empirical value kernel is already zero at absent cells, so it carries the observed prefix without a separate cell-presence object.

### 2.3 Identity carrier is operator degeneracy

`window()` and `cohort(A=X)` have population already at X, so the **carrier** operators (conditioned and empirical) degenerate to reach = 1, Dirac(0) arrival — the carrier convolution is a pass-through. There is no separate identity object and no parallel observed-surface synthesis; the reducer drives the degenerate carrier through the same DP as a non-trivial one.

### 2.4 Base mass and frontier

Two side inputs feed the reducer alongside the operators: the per-anchor base mass `a_pop` (§7) and the selected retrieval frontier `f_c` (§6, Atom 4.1) — the one query-wide analysis-observation date (`_analysis_observation_frontier_date`, capped by asat/today) mapped to each Cohort's age, which also sets the row epoch bounds.

---

## 3. The seam invariant

In the legacy pipeline the reducer and the row builder had to read the **same** selected prefix object or the chart's `midpoint` and `evidence_y/evidence_x` would diverge across the epoch boundary even where they should agree. The cutover makes this structural: `project_selected_cohort_rows` emits the strict evidence surface (`rate_strict`, `evidence_*_strict`) and the FC continuation (`ef_*`) from **one DP core over the same two operators**, so the evidence layer and the forecast layer share a single source by construction. There is no second prefix object to keep in sync — the seam cannot gap.

Cohorts with no admissible evidence are **zero-prefix, frontier 0** (whole `a_pop` projected from the prior through the conditioned operator) — not a fallback to the legacy frame-derived `engine_cohort.obs_x/obs_y`.

---

## 4. The selected-cohort reducer

`model_span_spine.project_selected_cohort_rows` is the E+F trajectory authority — the per-particle group `ΣY(τ) / ΣX(τ)` after observed prefixes (empirical operator), Pop D, Pop C, carrier continuation, and subject progression (conditioned operator) have all been projected into mass through one DP core. It is **mode-blind**: it reads no `is_window` / `identity_carrier` flag (`test_reducer_is_mode_blind_against_a_mode_field`); window/cohort/identity are produced by which operator degenerates.

For each selected cohort `d`, particle `s`, row age τ:

| τ relative to frontier | What happens |
|---|---|
| `τ ≤ frontier_d` | Observed prefix from the empirical operator: `X_total[s, τ] += obs_x[τ]`, `Y_total[s, τ] += obs_y[τ]`. Deterministic across particles. |
| `τ > frontier_d`, carrier degenerate (window / `A=X`) | `X_total[s, τ] += x_frozen` (forward-fill). Pop D residual via subject-only conditional CDF ratio anchored at frontier: `Y_pop_D[s, τ] = (x_frozen − y_frozen) × R_y_d`. Pop C empty (no carrier arrivals out of cohort). |
| `τ > frontier_d`, carrier non-trivial (active) | `X_total[s, τ] += x_frozen + (a_pop − x_frozen) × R_x` where `R_x = (G(τ) − G(f))/(1 − G(f))` is the conditional carrier residual. Pop D mixed over the pre-frontier arrival distribution (each slice has its own subject-clock age at frontier). Pop C = future X-arrivals × subject progression: conditional post-frontier carrier increments convolved with the **unshifted** subject CDF (Pop C members are fresh at X on arrival, subject clock starts at zero). |

Contract notes:

- **Pop D uses `x_frozen` as upper bound, not `a_pop`.** The empirical `rate` row aggregates `Σy/Σx` with `obs_x` carry-forward past the frontier, so the per-particle denominator basis matches across the epoch A→B boundary. Substituting `a_pop` produced a vertical cliff in E+F midpoint at `τ = tau_solid_max + 1`.
- **NaN where `X_total = 0`, not zero.** Row quantiles ignore NaN cells and return `None` only when every particle is undefined at that age. Rate-cell NaN propagation is the contract.
- **No `Y ≤ X` cap at the display layer.** By construction `Y(C, τ) ≤ X(C, τ)` — every Y contribution is `mass × k/n` with `k/n ≤ 1` and X is `Σ_{u≤τ} mass`. Reintroducing a cap would silently repair a regression.

---

## 5. Row schema — three projection surfaces

`_project_runtime_rows` emits one row per `τ ∈ [0, max_tau]` with three independent projection surfaces. Terminology follows the frontier-conditioned chart-surface proposal, [Appendix B](../project-generalise/frontier-conditioned-chart-surface-proposal-21-May-26.md#appendix-b-standard-terminology-and-display-mapping) — **E, F, and E+F name display modes only; `ef_*` / `f_*` / overlay name internal surfaces**:

| Row surface | Source | Display mapping |
|---|---|---|
| `midpoint`, `fan_*`, `fan_bands`, `projected_rate` | `selected_projection.ef_rate_draws` (the spine's FC continuation surface, predictive operator basis) | **Forecast layer in E+F mode**. Prefix-pinned to strict evidence through each Cohort's frontier; predictive fan opens only after the frontier. Rendered in epochs B/C; suppressed in epoch A. |
| `forecast_x`, `forecast_y` | `selected_projection.ef_forecast_x` / `ef_forecast_y` (future residual emitted directly by the FC continuation DP) | Active-carrier future-only residual count fields. No post-hoc subtraction of strict evidence from full model means. |
| `model_midpoint`, `model_fan_*`, `model_bands` | `selected_projection.f_rate_draws` (the spine's unspliced query-conditioned model surface, epistemic operator basis) | **Conditioned model surface; F mode renders this**. |
| `model_curve_midpoint`, `model_curve_*`, `model_curve_bands` | `runtime.unconditioned_overlays['epistemic']` | **Optional model overlay** — existing unconditioned model curve with epistemic bands. Not a display mode; opt-in via the display setting `show_model_curve` and rendered alongside the active mode. |

Observed-evidence fields are separate from projection:

| Field | Identity carrier | Active carrier |
|---|---|---|
| `rate` | `selected_projection.rate_strict` = `evidence_y_strict / evidence_x_strict` — strict empirical `Σy/Σx`, per-Cohort forward-filled through each Cohort's `tau_max` | Same |
| `rate_pure` | Alias of `rate`. The pre-spine "frozen at the A/B boundary `sum_y / boundary_x`" semantic was retired at the spine cutover; the row builder sets `rate_pure = rate` | Same |
| `evidence_x`, `evidence_y` | `selected_projection.evidence_x_strict` / `evidence_y_strict` (Σ-applicable strict empirical cumulatives) | Same |
| `coverage` | Simple Cohort applicability scalar for display opacity | Same |
| `cohorts_covered_base`, `cohorts_covered_projected` | `n_cohorts` reporting observation at-or-before τ | Same |
| `forecast_y`, `forecast_x` | None (residual semantics only meaningful for active) | `ef_forecast_y` / `ef_forecast_x` (future-only residual emitted directly by the FC continuation DP — no post-hoc subtraction from full model means) |

**Source-of-truth note (post-spine cutover).** Production row evidence/rate fields (`rate`, `rate_pure`, `evidence_x`, `evidence_y`) are emitted by `model_span_spine.project_selected_cohort_rows` — the empirical spine `selected_projection` — **not** by `SelectedAClockEvidence.aggregate_by_tau`. The row builder reads them unconditionally for both identity and active carrier (`cohort_forecast_v3.py:5349-5352`; see the `_row_evidence_source` diagnostic note alongside). `aggregate_by_tau` survives only as a shadow-plan diagnostic surface (`_build_generalised_evidence_shadow_plans`). `rate_strict` / `evidence_*_strict` are per-Cohort forward-filled through each Cohort's `tau_max`, so they are **non-null across the full horizon including epoch C** — epoch-C evidence suppression is an FE display choice (§6), not a `None` in the payload.

The old `rate_blended` and terminal-coverage fields have been removed. E mode reads strict evidence; E+F reads the strict evidence layer plus the FC forecast layer (`ef_*`) per the display-mode mapping in §6.

`p_infinity_mean`, `p_infinity_sd`, `p_infinity_sd_epistemic` come from `ResolvedCFRuntime.public_moments`. They are scalar subject-span moments — **not** a promise that the selected-cohort group trajectory converges numerically to the final row midpoint.

---

## 6. The epoch model

Three epochs run across τ:

- **Epoch A** (`τ ≤ tau_solid_max`): every selected cohort is observed. `rate` is the solid empirical line. `midpoint`/`fan_*` (the FC continuation `ef_*`) are prefix-pinned to strict evidence here by construction, so they coincide with `rate` to particle-quantile noise; the output layer suppresses the forecast layer in epoch A so the solid evidence line owns the epoch.
- **Epoch B** (`tau_solid_max < τ ≤ tau_future_max`): some cohorts have aged past their `tau_observed` but the oldest cohort hasn't aged out yet. `rate` continues with forward-fill (dwindling cohort coverage); `midpoint`/`fan_*` from the FC continuation extend through the unresolved future as the predictive fan opens past each Cohort's frontier.
- **Epoch C** (`τ > tau_future_max`): every cohort has aged past `tau_max`. The BE still emits `rate` / `evidence_*` here — the spine forward-fills each Cohort's strict cumulative past its `tau_max`, so the values are **frozen, not `None`**. The **FE** suppresses the evidence layer past `tau_future_max` so only the forecast layer (and the optional model overlay, if enabled) renders. Evidence-layer epoch-C suppression is the display-side mirror of epoch-A forecast suppression — see §6.1.

`tau_solid_max` is `min(frontier_age)` across **selected** cohorts (the shallowest observed depth, not the youngest cohort's frontier — staleness varies per anchor). `tau_future_max` is `(sweep_to_d − anchor_from_d).days` — the oldest cohort's calendar age. Both are intentionally decoupled from per-cohort `data_retrieved_at` to preserve the `tau_solid_max ≤ tau_future_max` invariant the row builder and chart both rely on.

When the selected retrieval frontier resolves (an admitted-evidence observation date is present), `row_tau_solid_max` and `row_tau_future_max` are recomputed from its bounds (`SelectedRetrievalFrontier.bounds`, §2.4 / Atom 4.1). The retrieval frontier can differ from the frame-derived frontier.

### 6.1 Display-mode epoch mapping

Per the frontier-conditioned chart-surface proposal, [Appendix B](../project-generalise/frontier-conditioned-chart-surface-proposal-21-May-26.md#appendix-b-standard-terminology-and-display-mapping):

| Display mode | Epoch A | Epoch B | Epoch C |
|---|---|---|---|
| **E mode** | strict evidence surface | strict evidence surface (cohort coverage dwindles) | no evidence layer |
| **F mode** | conditioned model surface (`f_*`) | conditioned model surface (`f_*`) | conditioned model surface (`f_*`) |
| **E+F mode** | evidence layer only (forecast layer suppressed in epoch A) | evidence layer + forecast layer (FC `ef_*`) | forecast layer only (FC `ef_*`) |
| **Optional model overlay** | overlay if enabled | overlay if enabled | overlay if enabled |

The FC surface (`ef_*`) is **generated across the full tau sweep regardless of display gating**. Epoch-A suppression of the forecast layer is an output-layer rendering choice, not a data gap. Every `ef_*` draw is pinned to strict evidence through each Cohort's frontier and continues only the unresolved future on the predictive operator basis, so prefix-pinning, continuity, and fan-opening are testable directly from the generated arrays.

Symmetrically, the strict evidence surface (`rate` / `evidence_*`) is generated across the full sweep too — the spine forward-fills each Cohort's strict cumulative past its `tau_max`, so the values are non-null in epoch C. The evidence layer's **absence** in epoch C is the same output-layer choice: the FE bounds the evidence series at `tau_future_max` (`cohortComparisonBuilders.ts` — both the E-mode `ratePure` segment and the E+F dashed evidence segment filter `tauDays ≤ sFutureMax`). A `!== null` guard alone would not suppress it, because the frozen evidence is non-null.

---

## 7. The `_root_window_carrier_n_by_anchor_day` rule

Active selected base mass `a_pop` per anchor comes **only** from any candidate whose `subject_from` matches the population root **AND** whose slice family is `WINDOW` — i.e. the root-window evidence on the first carrier primitive rooted at A. Other candidates are filtered out. Per anchor day, `result[obs_date] = max(n)` across matching candidates.

Identity carrier: A == X, so the candidate-set matching `subject_from == X` is the X-rooted subject primitive itself — same function, same filter, different sub-object degenerates naturally. Sub-stage 2b natural-degeneracy framing.

Anchors without admissible root-window evidence in active mode get `a_pop = 0` and are **excluded from the active projection**. The frame-bundle `a` is **not** an admissible fallback (Phase 3 implementation plan). One exception: empty-frames synthesis (`tau_observed = -1` sentinel) preserves `a_pop = 1.0` as the natural Bayesian degeneracy — posterior reduces to prior at unit population.

Provenance is recorded per anchor: `'root_window_carrier_n'` / `'empty_frames_prior'` / `'no_root_window_evidence'`. Exposed on `rows[0]['_a_pop_provenance']`.

---

## 8. Sentinels and degeneracies

`frontier_age = -1` (the `tau_observed = -1` empty-frames sentinel) propagates from `build_cohort_evidence_from_frames`'s synthesised default through to `engine_cohort.frontier_age` and `engine_cohort.eval_age` separately. `eval_age = max(frontier_age, 0)` because completeness "at frontier" is undefined when there is no frontier. The reducer's observed-prefix loop iterates zero times under the sentinel and the future arm covers `τ = 0..T-1` against the prior — natural Bayesian degeneracy (posterior = prior).

`a_pop = 1.0` in the empty-frames branch preserves the unit-population unconditioned projection. Active-mode no-evidence (`no_root_window_evidence`) zeros `a_pop` instead, excluding the cohort.

`X_total > 1e-12` is the NaN-emission threshold. Below it the rate cell is undefined (`np.nan`).

---

## 9. What `_project_runtime_rows` does NOT do

- **Does not condition.** All conditioning is in `primitive_conditioning.condition_primitive`. See [INVARIANTS.md](INVARIANTS.md) I-48.
- **Does not re-run subset policy.** The doc-52 blend is at the primitive layer, not the projection layer. See [CF_PRIMITIVE_SUBSTRATE.md](CF_PRIMITIVE_SUBSTRATE.md) §3.7.
- **Does not re-decide semantics.** I-46. Row schema reads already-resolved runtime objects. If a projection needs information the runtime doesn't expose, fix the runtime — never synthesise the missing piece in the projection.
- **Does not invent or mutate the operators.** The conditioned and empirical operators are runtime-resolved (`model_span_spine.resolve_request_spans`). The projection reads them through `project_selected_cohort_rows`; it does not rebuild span mass or re-resolve evidence.
- **Does not patch active rows from local subject evidence.** X-clocked target frames are zeroed by `build_cohort_evidence_from_frames` in active mode. Selected A-clock observations only. Frame-bundle `a` is not an admissible fallback.
- **Does not run the legacy trajectory engine.** `forecast_state.compute_forecast_trajectory` is post-73n legacy with two surviving callers; the v3 row builder does not reach it. See [CF_HOLD_OUT_ENGINES.md](CF_HOLD_OUT_ENGINES.md).

---

## 10. Diagnostic surfaces

`emit_diagnostics=True` (CLI `--diag`) populates several forensic side-channels on `rows[0]`:

- `_row_evidence_source` — provenance pointer recording that `evidence_x` / `evidence_y` / `rate` are emitted from `model_span_spine.project_selected_cohort_rows` (the empirical spine `selected_projection`), not from any legacy `SelectedAClockEvidence` object.
- `_empirical_spine_diagnostics` — the spine reducer's `selected_projection.diagnostics` (per-operator and per-DP-core forensic detail).
- `_selected_cohort_projection` — per-cohort spine projection summary (`frontier`, `a_pop`, `x_frozen`, `y_frozen`, Pop-D / Pop-C medians), when available.

`rows[0]['_a_pop_provenance']` — per-anchor `root_window_carrier_n` / `empty_frames_prior` / `no_root_window_evidence` — is attached whenever base-mass provenance exists, independent of `--diag`.

Without `--diag` the `--diag`-only surfaces are absent — the production payload is much smaller. The legacy `_selected_a_clock_evidence` cell dump and `_projection_basis` forensic field were removed at the selected-cohort cutover.

---

## 11. Where to read next

- [CF_PRIMITIVE_SUBSTRATE.md](CF_PRIMITIVE_SUBSTRATE.md) — what produces the `ResolvedCFRuntime` this pipeline consumes.
- [FORECAST_RUNTIME_ARCHITECTURE.md](FORECAST_RUNTIME_ARCHITECTURE.md) — runtime fields the row builder reads.
- [COHORT_ANALYSIS_NUMERATOR_DENOMINATOR_SEMANTICS.md](COHORT_ANALYSIS_NUMERATOR_DENOMINATOR_SEMANTICS.md) — semantic contract, Pop C / Pop D / factorised vs gross-fitted.
- [`cf-defensive-findings.md`](../project-generalise/cf-defensive-findings.md) — known defensive-code violations in the row pipeline (monotone-repair clamp H-1; residual clamp H-4; identity-carrier branching H-5).
- [CF_REFACTOR_TRACKERS.md](CF_REFACTOR_TRACKERS.md) — the in-flight design trackers the code cites by `§`-number.
- [FORECAST_RUNTIME_SEMANTIC_PSEUDOCODE.md](FORECAST_RUNTIME_SEMANTIC_PSEUDOCODE.md) §A.7–A.9 — semantic pseudo-code for the selected-cohort reduction and row projection.
