# 73k — Aggregate-IS likelihood: comment / code discrepancy

**Status**: **RESOLVED 30-Apr-26.** Code now matches the documented model. The aggregate IS step now calls a new helper `_cohort_binomial_log_likelihood` at [`forecast_state.py:153-169`](../../graph-editor/lib/runner/forecast_state.py#L153) which implements the comment-form likelihood `k_i ~ Binomial(n_i, p_s · c_i_s)` — completeness is multiplied into the success probability via `p_effective = p_draws * c_clip`, then `k · log(p_eff) + (n − k) · log1p(−p_eff)`. The previous inline implementation that computed `Binomial(n_i × c_i, p)` (completeness shrinking the trial count, with `E_eff = max(n_i × c_i, k_i)` and `E_fail = E_eff − k_i`) is gone. Caller updated at [`forecast_state.py:1177`](../../graph-editor/lib/runner/forecast_state.py#L1177). The body of this note is preserved below for traceability.

**Date opened**: 30-Apr-26
**Date resolved**: 30-Apr-26
**Parent contracts**:
- [`73g-general-purpose-f14-problem-and-invariants.md`](73g-general-purpose-f14-problem-and-invariants.md), invariant 6 ("evidence binding must match the object it conditions").
- [`docs/current/codebase/COHORT_ANALYSIS_NUMERATOR_DENOMINATOR_SEMANTICS.md`](../codebase/COHORT_ANALYSIS_NUMERATOR_DENOMINATOR_SEMANTICS.md) §"Practical consequences for `p` in cohort mode" / §"Practical consequences for latency in cohort mode".

**Related but distinct**: [`73j-is-proposal-and-likelihood-only-weights.md`](73j-is-proposal-and-likelihood-only-weights.md) — concerns the IS weight construction (missing `prior / q` ratio). This note concerns a different layer: whether the likelihood term itself matches the model documented in the function's own comment.

---

## Background for a cold reader

The cohort_maturity v3 forecast engine runs an aggregate tempered importance-sampling step inside `compute_forecast_trajectory` in `graph-editor/lib/runner/forecast_state.py`. For each Monte Carlo draw `s`, the engine has sampled `(p_s, μ_s, σ_s, onset_s)` from upstream proposals. It then assigns each draw a log-likelihood across the observed cohort evidence: each cohort contributes `(τ_i, n_i, k_i)` — its frontier age, the number of subjects exposed by that age, and the number that converted. The per-draw log-likelihoods feed an ESS-targeted tempered resample.

The likelihood model that connects `(p, μ, σ, onset)` to `(n, k, τ)` is the load-bearing piece. It is what makes the IS reweight correct in the binomial / cohort sense — it dictates how immature cohorts (small `c_i = CDF(τ_i; μ, σ, onset)`) are weighted relative to mature ones.

## The discrepancy

The function header at `forecast_state.py:1095-1102` explicitly documents the likelihood model:

```
# ── Aggregate tempered IS conditioning (doc 73f F14) ─────────────
# Replaces the per-cohort sequential IS that previously lived inside
# `_evaluate_cohort`. The likelihood per cohort i is
#   y_i ~ Binomial(n_i, p∞ · c_i_s)
# with `c_i_s = lag_cdf(τ_i, μ_s, σ_s, onset_s)` per draw — i.e.
# completeness inside the binomial parameter, NOT as an external
# cohort weight. Immature cohorts therefore contribute appropriately
# reduced certainty rather than amplified weight.
```

Reading this as a statistical model:

```
y_i | (p, μ_s, σ_s, onset_s) ~ Binomial(n = n_i, success probability = p × c_i_s)
log L_i = k_i × log(p × c_i_s) + (n_i − k_i) × log(1 − p × c_i_s)
```

The implementation at `forecast_state.py:1146-1170` does something different. Specifically:

```
1149     for tau_i, n_i, k_i in _evidence:
1150         E_i = np.zeros(S)
1151         for s in range(S):
1152             E_i[s] = float(n_i) * _compute_completeness_at_age(...)
1158         E_eff = np.maximum(E_i, float(k_i))
1159         E_fail = E_eff - float(k_i)
1163         p_clip = np.clip(p_draws, 1e-15, 1 - 1e-15)
1166         cohort_log_w = ... float(k_i) * np.log(p_clip) + E_fail * np.log(1 - p_clip) ...
```

In symbols:

```
E_i,s   = n_i × c_i,s
E_eff,s = max(E_i,s, k_i)        # floor at k_i to keep E_fail ≥ 0
E_fail,s = E_eff,s − k_i = max(0, n_i × c_i,s − k_i)
log L_i,s = k_i × log(p_s) + E_fail,s × log(1 − p_s)
```

This is the log-likelihood of:

```
y_i | (p_s, μ_s, σ_s, onset_s) ~ Binomial(n = n_i × c_i,s, success probability = p_s)
```

(modulo the `max(·, k_i)` floor on the trial count, which only kicks in when `n_i × c_i,s < k_i` — i.e., when the implied trial count would be smaller than the observed successes; in that regime the contribution flattens to `k_i × log(p)` only, since `E_fail = 0`).

So:

- **Comment claims**: `Binomial(n_i, p × c_i)` — completeness shrinks the success probability.
- **Code computes**: `Binomial(n_i × c_i, p)` — completeness shrinks the trial count.

These are not the same likelihood. Both put completeness "inside the binomial parameter" in some sense (matching the comment's emphasis), but they put it inside *different* binomial parameters.

## Mathematical comparison

The two log-likelihoods are:

```
Comment form: log L_C = k × log(p × c) + (n − k) × log(1 − p × c)
Code form:    log L_K = k × log(p)     + (n × c − k) × log(1 − p)
```

Difference (per cohort, per draw, ignoring the floor):

```
log L_C − log L_K = k × log(c) + (n − k) × log(1 − p × c) − (n × c − k) × log(1 − p)
```

The first term is `k × log(c)`. This is constant in `p` for fixed `c`, but depends on `c` and therefore varies across IS draws (since `c_s = CDF(τ_i; μ_s, σ_s, onset_s)`). When IS-reweighting on the differences between draws, this term contributes to the weight on `(μ, σ, onset)` parameters, not just on `p`.

The remaining terms can be expanded for small `p`, `c` using `log(1 − x) ≈ −x − x²/2 − …`:

```
(n − k) × log(1 − p × c) ≈ −(n − k) × p × c − (n − k) × (p × c)² / 2 − …
(n × c − k) × log(1 − p) ≈ −(n × c − k) × p − (n × c − k) × p² / 2 − …
```

To first order:

```
−(n − k) × p × c − (−(n × c − k) × p) = −n × p × c + k × p × c + n × c × p − k × p
                                       = k × p × c − k × p = k × p × (c − 1) = −k × p × (1 − c)
```

Adding the `k × log(c)` term:

```
log L_C − log L_K ≈ k × log(c) − k × p × (1 − c) + O(p²)
```

So the two forms agree only in the limit where `k × log(c)` and `k × p × (1 − c)` are both negligible — i.e., when `c → 1` (mature cohorts) or `k → 0` (no observed conversions). Outside those regimes, the discrepancy is non-negligible and depends on `c` per draw.

For an immature cohort (`c < 1`), `log(c) < 0`, so the comment form *penalises draws with smaller `c`* more heavily than the code form does. This is consistent with the comment's stated intent ("immature cohorts therefore contribute appropriately reduced certainty"). The code form penalises smaller-`c` draws differently — through the `n × c × log(1 − p)` term, which is approximately `−n × c × p` per cohort.

The two parameterisations are not statistically equivalent except in the rare-event limit (small `p`, `c` close to 1). They produce different posteriors over `(p, μ, σ, onset)` when evidence is non-trivial.

## What this means semantically

The two models correspond to different stories about what completeness represents:

- **Comment form** (`Binomial(n, p × c)`): every subject in the cohort is a Bernoulli trial whose success probability is `p × c` — the joint probability of "will eventually convert" and "has converted by τ". Completeness is folded into the per-trial event probability. Each subject is "in the trial".
- **Code form** (`Binomial(n × c, p)`): a fraction `c` of the cohort is "mature enough to be in the trial"; the remaining `(1 − c)` is censored. Among the `n × c` mature subjects, each converts with probability `p`. Completeness selects which trials count.

Both are coherent stories. They are distinct stories. The chosen story affects how immature cohorts shape the posterior on `p` and on `(μ, σ, onset)`.

The comment-form model is the more standard treatment in survival/maturation literature. The code-form model is non-standard but not unreasonable — it can be read as a Bernoulli-thinning of the trial set followed by a binomial on the thinned set.

## Why this matters

Per `73g` invariant 6: "Evidence binding must match the object it conditions." The likelihood model is the formal binding between observed evidence `(n, k, τ)` and the latent objects `(p, μ, σ, onset)`. If the documented model and the implemented model differ, then either:

- The implemented model is the actual contract and the comment is misleading documentation. Consumers reading the code with the comment's intent will compute IS posteriors expecting the wrong shape.
- The comment captures the intended contract and the implementation is incorrect. The IS step is performing a reweight on the wrong likelihood; downstream posteriors on `(p, μ, σ, onset)` are mis-conditioned in a regime-dependent way that affects trajectory bands.
- A deliberate approximation was chosen — perhaps for computational simplicity (the code form has only `log(p)` and `log(1 − p)` outside `E_fail`, whereas the comment form would require `log(p × c)` and `log(1 − p × c)` per draw per cohort) — and the comment was written in the intended-model form rather than the implemented-model form. The two would coincide in the rare-event regime where DagNet's typical conversion rates sit; the cost of the approximation in the strong-conversion regime is unmeasured.

The investigation needs to determine which of the three cases applies.

## What to investigate

1. **Provenance of the comment**: when was the `Binomial(n, p · c)` claim added relative to the `E_fail × log(1 − p)` implementation? Git blame on the comment block versus the implementation reveals whether the two were written together (suggesting the writer believed they matched) or whether the comment predates a refactor.

2. **Doc 73f F14 attribution**: the comment cites doc 73f F14. Re-read [`73f-outside-in-cohort-engine-investigation.md`](73f-outside-in-cohort-engine-investigation.md) for what F14 specifies the likelihood as. If the design doc states `Binomial(n, p × c)`, the implementation diverges from design. If the design doc is silent, the comment is the only spec.

3. **Reference to `_evaluate_cohort`**: the comment refers to "the per-cohort sequential IS that previously lived inside `_evaluate_cohort`". Recover that function from git history. Did it use the comment form or the code form? If it used the comment form, the aggregate-IS migration may have inadvertently changed the likelihood; if it used the code form, the comment was already misaligned before this function was written.

4. **Test coverage**: does any existing test pin down the likelihood shape? Tests that assert IS posterior values in a regime where `c << 1` would discriminate between the two forms. Outside-in parity tests in `73f` may already exercise this and silently accept either form.

5. **Numerical comparison**: implement both forms, run on a synthetic test cohort with known posterior under the comment form (e.g., a small evidence set with `c ∈ {0.3, 0.7}`), and compare. The posterior on `p` should differ measurably; the posterior on `(μ, σ, onset)` will differ through the `log(c)` Jacobian term.

6. **Downstream consequence**: trace what consumers do with the IS-conditioned draws. The trajectory bands at low τ (where `c` is small for the youngest cohorts) are the most likely surface to show the discrepancy. The 73f outside-in tests are a candidate witness.

## Findings (30-Apr-26)

Investigation items 1–4 are answered directly. Item 5 (numerical comparison) was not run; item 6 (downstream consequence) is bounded by item 4. A new finding outside the original list — a cross-subsystem divergence between the CF pass and the offline Bayes compiler — is recorded as well.

The findings preserve 73k's two-form framing for the CF-pass function, but recast the contract question one layer up: the "comment form" and "code form" are not just two ways one function could be written; they are the placements actually used by two distinct BE Python subsystems that both bind single-retrieval per-Cohort evidence.

### Provenance (item 1)

`git blame` on `forecast_state.py:1095-1170` shows commit `475879d0` (28-Apr-26, "73f - some progress on outside-in parity tests") introduced both the new comment block and the aggregate-IS body in the same patch. The implementation form (`k_i · log(p) + E_fail · log(1 − p)`) predates this. The predecessor `_evaluate_cohort` body in `475879d0^` computes the same expression. `git log -S "k_i * np.log"` traces the form back through `5b4b31ab` ("Rebuild v3 & generalisation") and `05dc0c79` ("Generalised cohort maturity") — months earlier. The aggregate-IS migration preserved the math; only the prose is new. The comment cannot be read as a written-first design contract that the implementation later violated.

### 73f F14 attribution (item 2)

[`73f-outside-in-cohort-engine-investigation.md`](73f-outside-in-cohort-engine-investigation.md) at line 290 — same author, same commit — derives the joint MLE explicitly as `p* = Σk_i / Σ(n_i · c_i)`. That closed-form MLE only exists for the code form `Binomial(n · c, p)`. For the comment form, the score equation in `p` is transcendental when `c_i` varies across Cohorts and does not collapse to `Σk / Σ(n · c)`. The design doc reasons in code-form mathematics; the comment in the same commit prose-describes the comment form. The conflation is local to the comment block.

### Predecessor `_evaluate_cohort` (item 3)

The pre-`475879d0` `_evaluate_cohort` body used the same `k_i · log(p) + E_fail · log(1 − p)` expression with `E_i` derived from the per-Cohort `obs_x` exposure trajectory rather than `n × c` directly. The placement of completeness was identical: in the trial-count side. The aggregate-IS migration changed how `E_i` is constructed (from `n_i · c_i,s` per draw, replacing the deterministic `obs_x · det_cdf` accumulator) but did not change the placement of completeness within the Binomial. The code form has been the durable contract since at least the v2 era.

### Test coverage (item 4)

No test in `lib/tests/` or `bayes/tests/` pins down the placement of completeness within the Binomial. The outside-in parity tests on synth fixtures are the closest candidate, but `73f:294` explicitly notes that for those fixtures `c_i ≈ 1` for every Cohort (frontier age past `t95` for the entire 90-day window), and in that limit both forms collapse numerically to `Binomial(n, p)`. The current parity suite cannot witness the discrepancy. A targeted test would need synthetic Cohorts with non-trivial `c ∈ (0, 1)` chosen such that the joint posterior on `p` differs visibly between the two forms.

### New finding — cross-subsystem divergence between the CF pass and the offline Bayes compiler

The same conceptual binding — single-retrieval per-Cohort evidence to a Binomial likelihood — is implemented with different placements of completeness in two BE Python subsystems (per [`docs/current/codebase/STATS_SUBSYSTEMS.md`](../codebase/STATS_SUBSYSTEMS.md)):

- **CF pass** (subsystem 3, `forecast_state.py:1166`): `Binomial(n_i · c_i,s, p_s)`. Per-draw completeness `c_i,s = lag_cdf(τ_i, μ_s, σ_s, onset_s)` from the lognormal proposal. Code form.
- **Bayes compiler** (subsystem 1): `Binomial(n, p · c)` — comment form — for both single-retrieval evidence shapes the compiler binds:
  - Window observations (`_emit_window_likelihoods` at `bayes/compiler/model.py:2401-2409`): `p_effective = p_var × w_obs.completeness; pm.Binomial.dist(n=w_obs.n, p=p_effective)`. The function docstring at `model.py:2386` states the contract: `k ~ Binomial(n, p × completeness)`.
  - Daily Cohort observations (`obs_daily_*` Potential at `bayes/compiler/model.py:3160-3177`): `p_effective = p_var * compl_arr; pm.Binomial.dist(n=n_arr, p=p_effective)` (or BetaBinomial(n, α=p·c·κ, β=(1−p·c)·κ) when `kappa` is fitted).

Completeness `c` in the compiler is **deterministic** (computed at fit time from the point-estimate latency prior); in the CF pass it is **per-draw** (sampled with `(μ, σ, onset)`). So aligning the CF pass to the comment form would also be the first place per-draw completeness lives in the success-probability slot.

The two subsystems produce different posteriors on `p` whenever `c < 1`. They agree only in the asymptotic-mature limit, which is the regime the existing outside-in parity suite happens to exercise.

The compiler's trajectory path (product-of-conditional-Binomials via `pm.Potential` for multi-retrieval observations of one Cohort day at multiple ages — `bayes/compiler/model.py:3044-3115` and the `Product-of-conditional-Binomials` glossary entry at `model.py:94-105`) is a third likelihood entirely, not implicated in this discrepancy. [`archive/6-compiler-and-worker-pipeline.md`](archive/6-compiler-and-worker-pipeline.md) at line 1197 cautions specifically against `Binomial(n, p · CDF(t_j))` for trajectory data because cumulative rows would double-count — a constraint that does not bear on the single-retrieval per-Cohort case under discussion here.

Doc-level support for the two forms is split:

- Code-form supporters: [`52-subset-conditioning-double-count-correction.md`](52-subset-conditioning-double-count-correction.md) at line 418 ("Cohort-mode fits use an effective exposure `E_i = n_i × c_i` in per-Cohort Binomial likelihoods"); [`73f-outside-in-cohort-engine-investigation.md`](73f-outside-in-cohort-engine-investigation.md) at line 290; [`cohort-maturity/cohort-x-per-date-estimation.md`](cohort-maturity/cohort-x-per-date-estimation.md) at line 357 (`n_eff_i_s = x_frozen_i(s) × c_i_s`).
- Comment-form supporters: `bayes/compiler/model.py:146-150` (top-level docstring nominating `Binomial(n, p × completeness)` for window obs and daily Cohort obs); `model.py:2386` (`_emit_window_likelihoods` docstring); [`32-posterior-predictive-scoring-design.md`](32-posterior-predictive-scoring-design.md) at line 38 (`Binomial(n, p×F)`); [`18-compiler-journal.md`](18-compiler-journal.md) at line 3740; the `forecast_state.py` subject comment itself.

No design doc explicitly compares the two placements and names a canonical one.

### Refined answer to the three-case framing

The three cases above ("comment is misleading documentation", "implementation is incorrect", "deliberate approximation") collapse to:

- The CF pass's implementation has been the durable contract since at least v2 and is documented in 52. The new comment block is fresh prose that misdescribes the math, not a contract that the implementation ever met.
- The deeper question is across subsystems, not within this function. The Bayes compiler and the CF pass implement different placements for the same conceptual single-retrieval Cohort binding. A design decision is needed to align them, leaving the compiler's trajectory path (product-of-conditional-Binomials) untouched.

Either form can be argued from first principles; the literature has both. The investigation does not narrow the choice further.

### Relation to F14 on the offending query

73f's diagnostic shows `c_i ≈ 1` for every Cohort in the failing query `from(simple-a).to(simple-b).window(-90d:)`. Both forms collapse to `Binomial(n, p)` and pin at raw `Σk/Σn` for that query. The discrepancy here is a separate correctness question that surfaces only when Cohorts meaningfully exercise `c < 1`. It is not the F14 mechanism on the current failing query.

### Relation to the parity canary closure (30-Apr-26 evening)

The two `test_cohort_factorised_outside_in.py` parity canaries that 73f F4 and
73l were tracking — `test_cli_identity_collapse_matches_window_across_public_surfaces`
and `test_cli_projection_parity_uses_last_row_saturation_not_arbitrary_tau_curve_point`
— were eventually closed by a fix in `formatDateUK` at
[`src/lib/dateFormat.ts`](../../graph-editor/src/lib/dateFormat.ts). The
likelihood placement debated in this note (CF pass `Binomial(n·c, p)` vs Bayes
compiler `Binomial(n, p·c)`) was *not* the canary cause. The canary cause was
a TZ-dependent off-by-one in d-MMM-yy round-tripping that shifted the analyse
CLI's window-end by one day; param-pack avoided it because it passed the
user's DSL straight through to fetchItems without renormalisation. See
[`73l-cli-completeness-parity-canary-drift.md`](73l-cli-completeness-parity-canary-drift.md)
for the forensic trace.

This does not change the substance of 73k. The cross-subsystem placement
question between the CF pass and the Bayes compiler is real and remains
worth resolving with a deliberate design decision, but it is not gated by
the parity canaries and the parity canaries are not evidence about which
placement is correct.

## Reading list

- `forecast_state.py:1095-1199` — the function body in question.
- [`73f-outside-in-cohort-engine-investigation.md`](73f-outside-in-cohort-engine-investigation.md) — F14 origin and outside-in oracle tests.
- [`73g-general-purpose-f14-problem-and-invariants.md`](73g-general-purpose-f14-problem-and-invariants.md) §invariant 6 — the contract this discrepancy potentially violates.
- [`73j-is-proposal-and-likelihood-only-weights.md`](73j-is-proposal-and-likelihood-only-weights.md) — separate IS-weight defect at the proposal/correction layer; both 73j and 73k can be in play simultaneously and a fix to one does not address the other.
- [`docs/current/codebase/STATISTICAL_DOMAIN_SUMMARY.md`](../codebase/STATISTICAL_DOMAIN_SUMMARY.md) — completeness semantics and the standard binomial/maturity model the comment-form reflects.

## What this note does NOT do

- Recommend a fix. Either form might be the correct contract; the investigation determines which.
- Quantify the size of the error if the code form is wrong. That requires running both implementations on test data.
- Reproduce the analysis above for the dispersion parameters `(μ, σ, onset)` posterior implications. The discrepancy on `p`'s posterior is the most direct symptom; the lognormal-parameter posteriors are downstream and require simulation.
