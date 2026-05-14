# Cohort observed-prefix amplitude defect

**Status**: Open, 13-May-26
**Affected runtime**: `cohort_forecast_v3` row pipeline
**Pinned by**: red test `test_first_latency_edge_with_nonlatent_chain_observed_collapses_to_window` (xfail-strict) in [`test_cohort_factorised_outside_in.py`](../../graph-editor/lib/tests/test_cohort_factorised_outside_in.py)

Prior versions of this document proposed several different root causes (carrier backmap renormalisation, `temporal_mode` propagation into `prob_cohort_*` mirrors, `n_effective` leakage, admitting cohort-family slice rows). None of those is the actual defect. They are documented in §6 as "what this is NOT".

---

## 1. Symptom

For an active-cohort query `cohort(A, X→Y)` whose A→X upstream chain is structurally non-latent (all upstream edges have `latency_parameter: false` resolving to Dirac at τ=0), the observed-evidence row fields (`evidence_x`, `evidence_y`) and derived row fields (`rate`, `midpoint`) must agree with the equivalent `window(t1:t2)` query over the same subject edge.

They do not. On `synth-mirror-4step`:

| field | window | cohort | gap |
|---|---|---|---|
| `evidence_x` | 7125 | 7495 | 5.2% |
| `evidence_y` | 673 | 834.7 | 24% |
| `rate` | 0.0945 | 0.1114 | 18% |
| `midpoint` | 0.1057 | 0.1261 | 19% |
| `model_midpoint` | (agrees) | (agrees) | — |

`model_midpoint` agreement confirms the divergence is not in primitive conditioning. It is in the row pipeline's observed-prefix amplitude.

---

## 2. The defect, precisely

[`cohort_forecast_v3.py:4354-4360`](../../graph-editor/lib/runner/cohort_forecast_v3.py#L4354-L4360) inside `_build_selected_a_clock_evidence_from_runtime`:

```python
# Amplitude reads:
#   X = X_prefix(C, tau) = N_cohort(C) × G_carrier(C, tau)
#     — carrier-only, not from observed surface (docs A.1 §157).
x_val = float(x_prefix.value_at(anchor_day, int(tau)))
```

`x_val` populates `x_at_query_x` on the `SelectedAClockEvidenceCell`, which `_project_runtime_rows` emits as `evidence_x`.

The constituents:

- `N_cohort(C)` = realised landing count on A-day C, read from window-family rows on the A-anchored carrier edge ([`cohort_forecast_v3.py:1716-1778`](../../graph-editor/lib/runner/cohort_forecast_v3.py#L1716)). Realised data.
- `G_carrier(C, τ)` = cumulative of `M_select(X, C, ·) / N_cohort(C)`, built ([`cohort_forecast_v3.py:1781-1955`](../../graph-editor/lib/runner/cohort_forecast_v3.py#L1781)) via `compose_timing_span_from_transition_primitives` over `TimingTransitionPrimitive` objects whose `p` field is `resolved.p_mean = alpha/(alpha+beta)` from the promoted source layer ([`primitive_readout.py:269-300`](../../graph-editor/lib/runner/primitive_readout.py#L269)). Labelled `source='prior_*'`.
- The composed `density_cdf` is **reach-preserving**: `Σ_τ pmf[τ] = Π prior_p_i = reach_A→X` ([`cohort_forecast_v3.py:1891-1906`](../../graph-editor/lib/runner/cohort_forecast_v3.py#L1891)). Under Dirac upstream all mass sits at τ=0 with magnitude `Π prior_p_i`.

So:

> **Cohort `evidence_x` = realised landings × Π aggregate-prior p**

Window mode hits the identity branch ([`cohort_forecast_v3.py:1881-1882`](../../graph-editor/lib/runner/cohort_forecast_v3.py#L1881)) and reads `N_cohort` from window-family rows on the **subject** edge, where the row's `n` is the realised count at X. So:

> **Window `evidence_x` = realised x_frozen**

The two amplitudes are not the same object. They agree only when `Π aggregate-prior p_i` equals realised chain conversion in the cohort sub-window — which it generally does not.

---

## 3. Numerics

Enriched `synth-mirror-4step` priors (from `model_vars[analytic].probability`):

| edge | `latency_parameter` | `α/(α+β)` |
|---|---|---|
| m4-landing → m4-created | False (Dirac) | 0.17469 |
| m4-created → m4-delegated | False (Dirac) | 0.55923 |

`Π prior_p_chain = 0.0977`. Implied realised chain conversion in cohort sub-window = `7125 / (7495 / 0.0977) ≈ 0.0929`. Gap 5.2%, propagating directly into `evidence_x`. `evidence_y` compounds it through `_build_rate_attributed_subject_prefix` (which scales subject-side rate buckets by `M_select` and therefore by the same prior chain factor).

---

## 4. Contract violation

[`COHORT_ANALYSIS_NUMERATOR_DENOMINATOR_SEMANTICS.md`](codebase/COHORT_ANALYSIS_NUMERATOR_DENOMINATOR_SEMANTICS.md) line 292, denominator-side table for `cohort(A, X-Y)`:

> | Observed prefix | Use observed `obs_x` / `x_frozen` | none | **none; already realised** |

"Already realised" is unambiguous: the observed prefix is data, read unchanged. The implementation derives it as `N_cohort × Π prior_p`, a forward projection from upstream.

---

## 5. Root cause: kernel conflation

`g_carrier` bundles two algebraically distinct objects into one density:

1. **Timing kernel** — when does cohort mass arrive at X on the A-clock, conditional on arriving. A PMF over τ summing to 1.
2. **Reach scalar** — Π p_i, the unconditional probability that a cohort member reaches X at all.

`density_cdf` is "reach-preserving": its PMF sums to Π p_i, not to 1. The reach is multiplied into every τ. Once bundled this way, `M_select` cannot be expressed as "realised X count redistributed onto the A-clock" — the reach scalar is structurally inside the kernel and the amplitude must come from somewhere else (N_cohort).

The remedy is to separate the two objects. The reach scalar belongs to the *future* projection (Pop C, unrealised mass), where prior-projecting `N_cohort × Π p_i` is a legitimate forecast. The reach scalar does not belong on the *past* path, where the data already records what actually happened at X.

---

## 6. Algebraic fix (no branching)

Two structural changes:

- **`g_carrier` becomes a normalised timing kernel `T_carrier(C, τ)`**: prior latency only, `Σ_τ T = 1`. Under Dirac upstream, `T = δ(0)`. Under genuinely latent upstream, T is a non-trivial PMF.

- **Past-mass amplitude reads realised `x_frozen` from subject-edge window-family rows**, redistributed onto A-clock days by the Bayes inversion of `T_carrier` weighted by realised landings:

  ```
  evidence_x_cohort(C, τ) = Σ_D x_frozen(D) × share(C | X-day=D, A-clock-age=τ)
  share(C | D, τ) = T_carrier(C, D-C) × N_cohort(C) / Σ_C' T_carrier(C', D-C') × N_cohort(C')
  ```

  (`τ = D - C` enforced via the carrier kernel's support.)

Algebraic degeneracies fall out without branches:

- `A = X` (window or `cohort(A=X)`): `T_carrier = identity`, share is identity, `evidence_x_cohort(C, 0) = x_frozen(C)`. Identical to window.
- Dirac upstream, A ≠ X: `T_carrier(C, ·) = δ(0)` per anchor, `share(C | D, 0) = 1[D=C]`, `evidence_x_cohort(C, 0) = x_frozen(C)`. Identical to window. Test passes.
- Genuinely latent upstream: `T_carrier` redistributes realised X mass across A-clock days. Total mass per cohort is conserved (`Σ_C Σ_τ evidence_x_cohort(C, τ) = Σ_D x_frozen(D)`); per-(C, τ) values are shifted.

The reach scalar Π p_i appears only in the future-projection path (Pop C), which is unaffected by this fix.

`evidence_y` follows the same pattern: realised `y_frozen` from subject-edge rows, redistributed by a subject-side timing kernel applied after the carrier-side A-clocking. Same algebraic structure, same natural degeneracies.

---

## 7. Acceptance criteria

- `test_first_latency_edge_with_nonlatent_chain_observed_collapses_to_window` passes (xfail removed); window and cohort outputs match to within float-aggregation tolerance.
- `test_multihop_latent_upstream_divergence` continues to pass — cohort and window legitimately differ under genuine upstream latency.
- Mass conservation: `Σ_C Σ_τ evidence_x_cohort(C, τ) = Σ_D x_frozen(D)` on the same date support.
- No new `if is_identity_carrier:`, `if is_window:`, or `if reach < 1:` branches. The fix is algebraic separation, not a case-fork.
- Outside-in suite green.

---

## 8. What this is NOT

Prior investigations of this conversation arrived at several wrong diagnoses; pinning them here so future readers don't re-walk them.

- **Not** a `temporal_mode='cohort'` leak into `(alpha, beta)`. `model_resolver.py:431-432` reads `prob_alpha`/`prob_beta` unconditionally. The Pre-WP8 invariant is honoured for the rate prior.
- **Not** an `n_effective` leak. `temporal_mode` does bind `n_effective` selection at `model_resolver.py:477-486`, but that affects the doc-52 blend on per-primitive posteriors, which feeds `model_midpoint` — and `model_midpoint` agrees between modes.
- **Not** a `_join_conditioned_carrier_backmap` defect. The backmap is prior-driven (built from `selected_source_day_mass` which is `prior_*`-sourced) and degenerates to identity under Dirac (single-anchor contribution per X-day).
- **Not** an admission gap for cohort-family slice rows. Cohort-family rows remain correctly reserved for WP8; the fix uses only window-family rows on the subject edge (the same rows window mode reads).
- **Not** a structural "carrier should be null" defect. The carrier topology legitimately exists. The defect is that the carrier composition object bundles reach and timing, forcing the past path to multiply by reach when it should just read the data.
- **Not** subject-side X-day backmap leakage. With M_select degenerated correctly under Dirac, the subject-side backmap is identity and no leakage path remains.

---

## 9. References

- [`COHORT_ANALYSIS_NUMERATOR_DENOMINATOR_SEMANTICS.md`](codebase/COHORT_ANALYSIS_NUMERATOR_DENOMINATOR_SEMANTICS.md) §"Cohort semantics: cohort(A, X-Y)" — denominator-side observed-prefix contract
- [`FORECAST_RUNTIME_ARCHITECTURE.md`](codebase/FORECAST_RUNTIME_ARCHITECTURE.md) §4-§6 — identity carrier, evidence materialisation, selected-cohort reduction
- [`KNOWN_ANTI_PATTERNS.md`](codebase/KNOWN_ANTI_PATTERNS.md) AP58 — case-fork anti-pattern; the fix must not add a new branch
- [`INVARIANTS.md`](codebase/INVARIANTS.md) I-45, I-47 — single resolution path, no engine fallbacks
- [`60-forecast-adaptation-programme.md`](project-bayes/60-forecast-adaptation-programme.md) §WP8 — Pre-WP8 invariant: window mirrors only for factorised composition; this fix does not pre-empt WP8
