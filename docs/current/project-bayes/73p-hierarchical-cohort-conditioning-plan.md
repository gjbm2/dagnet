# 73p Hierarchical Cohort Conditioning Plan

**Status**: Proposal under review — 4-May-26 (rev 15)
**Scope**: BE architectural upgrade to hierarchical per-cohort posterior inference; routes daily-conversions through the unified CF runtime
**Source contracts**:
- `docs/current/project-bayes/73g-general-purpose-f14-problem-and-invariants.md`
- `docs/current/project-bayes/73n-carrier-evidence-conditioning-implementation-plan.md`
- `docs/current/project-bayes/73n-unified-cf-runtime-invariants-and-audit.md`
- `docs/current/project-bayes/29f-daily-conversions-engine-guidance.md`
- Doc 49 / 61 (dispersion contract definitions)
- Doc 52 (subset conditioning double-count correction)

---

## Summary

Today's CF runtime treats every cohort in a multi-cohort query as one pooled-evidence Bayesian update — one Beta posterior per primitive, shared by every chart row. This is statistically wrong under cohort heterogeneity and structurally insufficient for any consumer that needs per-cohort projections.

This plan replaces group pooling with a **hierarchical Beta-Binomial** in which a request-scoped hyperprior `(α_g, β_g)` is fit per primitive from per-cohort observations, regularised by a Bayesian prior centred on the resolver prior. Per-cohort posteriors are the conjugate update against the fitted hyperprior, **doc-52-mixed against the resolver prior** (not the hyperprior) so the doc-52 r=1 boundary returns the resolver unchanged. The aggregated chart lane is computed by draw-level mixture across per-cohort posteriors. Daily conversions, currently on a separate code path, routes through the per-cohort posteriors instead of building a parallel mechanism.

The work is BE-only. Zero new dependencies. Zero schema break for the existing aggregated lane. Daily conversions integration is the FE-visible deliverable.

**Design invariant**: no architectural branching, no fallbacks, no defensive coding at the boundaries. One architectural path handles all inputs. Numerical safeguards live inside specific kernels (the MAP optimiser's step damping, finite-value guards, condition-number checks) and are not exposed as conditional code paths to callers. There is one structural type dispatch on `timing_family` (latency vs non-latency) inside the conditioner — type dispatch, not data-quality fallback.

---

## The problem

`build_resolved_cf_runtime` constructs one `RequestPrimitiveRegistry` per request. The prefix-arrival map's root carries `root_day_weights = {day: 1.0}` for every day in the public anchor range — uniform weighting across all cohorts ([primitive_readout.py:365-378](../../../graph-editor/lib/runner/primitive_readout.py#L365-L378)). One primitive resolution per edge, one Beta posterior, one trajectory shared by every cohort lane.

This breaks under: (a) partial immaturity, where immature cohorts inherit a posterior driven by mature cohorts; (b) cohort-size variation, where size-blind arrival-weight kernels over-state effective sample size in tight ranges; (c) per-date and per-cohort projections, which today's runtime cannot produce — the daily-conversions handler in `api_handlers.py` works around this by calling `compute_forecast_trajectory` directly, the last surviving parallel CF pathway from 73n.

The MCMC layer (upstream) already produces fitted variables per `window()` segment of the graph. The resolver prior in CF represents that fit — strong, evidence-derived, the source of cross-edge cross-window information. CF conditioning is a **small adjustment** to that prior to account for current observations and cohort-specific drift. The required behaviour: per-cohort projections; cross-cohort information sharing without losing per-cohort distinctness; natural respect for the upstream fit so uninformative current evidence defaults to the resolver and informative current evidence overrides it. This is the standard hierarchical Bayes shape.

---

## Design

### Hierarchical Beta-Binomial with branch-free MAP

For each primitive `U → V` in a request:

```
Hyperprior on hyperparameters:  H(α_g, β_g)   centred on the resolver prior
Cohort-level prior:             p_i ~ Beta(α_g, β_g)
Cohort-level likelihood:        k_i_w ~ Binomial(n_i_w, p_i)   on arrival-weighted (n_i_w, k_i_w)
Per-cohort conjugate update:    p_i | data ~ Beta(α_g + k_i_w, β_g + n_i_w − k_i_w)
```

The hyperparameters `(α_g, β_g)` are shared across all cohorts of the same primitive within one request. This is the partial-pooling structure: per-cohort posteriors borrow strength through a shared hyperprior fit from the cohort observations themselves, regularised toward the resolver prior.

**Notation — three distinct mass units, kept named throughout**:

| Symbol | Meaning | Source |
|---|---|---|
| `(n_i_raw, k_i_raw)` | Raw row counts in cohort `i`'s scoped evidence — the doc-52 "raw mass" sense | `WeightedPrimitiveEvidenceView.row_count_total`, `event_count_total` per cohort |
| `(n_i_w, k_i_w)` | Arrival-weighted sufficient stats for cohort `i` — feed the likelihood and the MAP fit | `WeightedPrimitiveEvidenceView.weighted_n`, `weighted_k` per cohort (today's `bind_primitive_evidence` output) |
| `m_S_set` | Aggregate raw selected mass across cohorts — fed to `compute_subset_policy` per doc 52 | `Σ_i n_i_raw` (NOT the weighted sum — doc 52's `m_S` is raw evidence mass that overlaps the training set) |
| `n_effective` | Effective conditioning pressure from the resolver — the doc-52 denominator | Existing `compute_subset_policy` input from `resolver_prior.n_effective` |

The MAP fit consumes weighted stats `(n_i_w, k_i_w)` because the likelihood is on arrival-weighted observations (the time-binding correction is already applied in the binder). Doc-52's `r` is computed from raw mass `m_S_set = Σ_i n_i_raw` against `n_effective`, matching the existing `compute_subset_policy` call signature in today's `condition_primitive`. The two mass units stay separate by name in code and in this document.

### Fitting `(α_g, β_g)` — Newton MAP

We compute the MAP estimate of `(α_g, β_g)` under the joint posterior:

```
log P(α_g, β_g | data) = log H(α_g, β_g) + Σ_i log BetaBinom(k_i_w | n_i_w, α_g, β_g) + const
```

`H(α_g, β_g)` is a normal on `(log α_g, log β_g)` centred at the offline-fitted posterior `(log resolver.α, log resolver.β)`. Its scale is **derived from the offline fit's effective sample size, not chosen as a free parameter**:

```
regularising_scale = 1 / sqrt(resolver.α + resolver.β)
```

The principle: the regularising prior should match the data strength of the object it's centred on. A strong offline fit (large `α + β`) implies a tight regulariser — runtime cohorts cannot easily perturb a well-supported posterior. A weak offline fit implies a loose regulariser — runtime cohorts are permitted to drift the hyperprior more freely. The scale is computed once per primitive per request from the resolver; there is no tunable knob.

In code this scale is the parameter `sigma_h` on `fit_hyperprior`; we refer to it below as **the regularising scale** without the symbol.

The regularising prior bounds the log-posterior from above (preventing escape to infinity), localises the optimisation around the offline posterior, and degenerates naturally: in the small-data limit (few cohorts, weak likelihood) the hyperprior stays near the offline posterior; in the large-data limit (many informative cohorts) the data dominates.

**Inputs**: weighted per-cohort sufficient stats `(n_i_w, k_i_w)` from each cohort's binder output. The MAP fitter does not know about doc-52 or `r`; doc-52 mixing happens later (against the offline-fitted posterior, not against the hyperprior) and uses raw mass `m_S_set = Σ_i n_i_raw`, not the weighted stats.

The fit is Newton on `(log α, log β)` initialised at `(log resolver.α, log resolver.β)`, fixed iteration cap (10 iterations is the production setting; gradient-norm convergence tested to 1e-6). Inside the optimiser kernel: bounded log-parameters, finite-value guards on gradient and Hessian, determinant conditioning (damped gradient step when Hessian determinant falls below tolerance), step damping (trust-region bound on `(log α, log β)`), gradient-norm convergence with hard iteration cap. These safeguards live inside `fit_hyperprior` and are not exposed as conditional code paths to callers; their activation is logged in `HyperpriorFit.diagnostics`.

The required `digamma` (gradient) and `trigamma` (Hessian) are implemented inline using the asymptotic series plus the recurrence `digamma(x+1) = digamma(x) + 1/x` to push small arguments into the asymptotic regime (~30 LoC each, pure numpy). `math.lgamma` from stdlib provides the BetaBinom marginal directly.

### Doc-52 mixture: unconditioned leg is the resolver prior

Today's `condition_primitive` applies the doc-52 compatibility correction as a sample-level mixture between conditioned and unconditioned draws ([`_apply_doc52_blend`](../../../graph-editor/lib/runner/primitive_conditioning.py)). When the selected set's scoped evidence mass `m_S` is small relative to `n_effective`, the posterior draw set is `(1−r):r` row-permuted between the conditioned draws and the unconditioned-prior draws. Per [doc 52](52-subset-conditioning-double-count-correction.md), the unconditioned-prior leg is the **resolver prior** — it is the statistical baseline that does not include the selected evidence. At `r = 1`, the doc-52 boundary returns exactly the resolver prior with no runtime update.

**The hierarchical proposal preserves the doc-52 mixture exactly by pinning the unconditioned leg to the resolver prior, not the hyperprior.** The hyperprior `(α_g, β_g)` is itself fit from the selected evidence (via MAP), so using it as the unconditioned leg would violate doc-52: at `r = 1` the posterior would be `Beta(α_g, β_g)` ≠ `Beta(resolver.α, resolver.β)`, an evidence-conditioned baseline.

**Set-level `r`** (one scalar per primitive per request, computed from the aggregate raw selected mass per doc 52):
```
m_S_set       = Σ_i n_i_raw                                       # raw mass — NOT Σ_i n_i_w
subset_policy = compute_subset_policy(m_S_set, n_effective)
r             = subset_policy.r                                   # one scalar in [0, 1]
```

**Per-cohort posterior** is the doc-52 sample-level mixture:
- Conditioned leg per cohort `i`: `cond_p_draws_i ∼ Beta(α_g + k_i_w, β_g + n_i_w − k_i_w)` (closed form for non-latency, IS resample for latency). Uses **weighted** stats — the conjugate update is on the arrival-weighted likelihood.
- Unconditioned leg (shared across all cohorts): `prior_p_draws ∼ Beta(resolver.α, resolver.β)` — the resolver prior, NOT the hyperprior. Sampled once per primitive per request; used as the doc-52 baseline.
- Doc-52 row permutation per cohort `i`: take `(1−r)·S` rows of `cond_p_draws_i` and `r·S` rows of `prior_p_draws`, permuted into one `(S,)` posterior draw set per cohort. The same row permutation indices apply to `cond_cdf_draws_i` and `prior_cdf_draws` to preserve within-cohort `(p, CDF)` joint coherence.
- The same set-level `r` governs every cohort's blend.

**Boundary behaviour**:
- `r = 1`: every cohort's posterior is `Beta(resolver.α, resolver.β)` exactly. Today's "no runtime update" boundary is preserved byte-for-byte; the hyperprior plays no role at this boundary.
- `r = 0`: every cohort's posterior is `Beta(α_g + k_i_w, β_g + n_i_w − k_i_w)` — full hierarchical conjugate update against the fitted hyperprior.
- `0 < r < 1`: row-permuted mix of resolver-prior draws and per-cohort conditioned draws. Per-cohort posteriors borrow strength through the conditioned leg's hyperprior; the resolver leg holds the doc-52 baseline.

**Cohort with `n_i_w = 0`**: the conjugate update reduces to `Beta(α_g, β_g)` (the hyperprior). The mixture then yields `(1−r) · Beta(α_g, β_g) + r · Beta(resolver.α, resolver.β)`, which is the natural answer — an empty cohort gets only the borrowed-strength prior plus the doc-52 resolver baseline. No code branch.

**Hyperprior self-learning effect (named, bounded)**: the hyperprior is fit from the same evidence that drives the conditioned leg's per-cohort update. This is a known property of EB-MAP. The effect is bounded by the regularising scale (which scales as `1/√(resolver.α + resolver.β)`, so a strong offline fit makes the effect small) AND by `(1−r)` (the conditioned leg's mixture weight). At `r = 1` the effect is zero. The derived scale rule is what controls the residual; there is no tunable knob.

[73n](73n-unified-cf-runtime-invariants-and-audit.md) **invariant B** — subset/blend logic applied exactly once at primitive posterior construction — is preserved. The blend runs once per cohort per primitive per request, with one shared set-level `r`.

### Joint conditioning preserved per cohort (latency edges)

For latency edges the existing IS pass jointly conditions on `(p, μ, σ, onset)` ([primitive_conditioning.py:725-913](../../../graph-editor/lib/runner/primitive_conditioning.py#L725-L913)). Joint coherence — same draw index selecting matching `(p, CDF)` particles — is preserved per cohort by sampling proposal particles **once per primitive per request** from the κ-inflated hyperprior and resampling per cohort from the shared pool:

- Proposal particles `(p_s, μ_s, σ_s, onset_s)` and the per-particle CDF grid `(S, T)` are sampled once. Rate proposal `p_s` comes from the κ-inflated hyperprior `Beta(α_g/κ, β_g/κ)` where `κ = (resolver.α + resolver.β) / (alpha_pred + beta_pred)` is the precision ratio recovered from the resolver. Both depend only on primitive identity and hyperprior fit, not cohort identity.
- **IS weight per cohort `i`, particle `s`** includes the prior-vs-proposal correction (the proposal is intentionally wider than the per-cohort target prior `Beta(α_g, β_g)` for coverage):

  ```
  w_i_s ∝ ( BetaPdf(p_s; α_g, β_g) / BetaPdf(p_s; α_g/κ, β_g/κ) )       # prior / proposal correction
        · likelihood_i(p_s, μ_s, σ_s, onset_s | weighted rows for cohort i)
  ```

  Without the prior/proposal correction term the IS posterior would target `q · L` (proposal × likelihood) rather than `prior · L`, biasing every per-cohort `cond_p_draws_i` toward the wider proposal. **This corrects a gap in today's `_maturity_aware_conditioned_draws`** (which weights particles by likelihood only and so produces a posterior shifted toward the κ-inflated proposal). The hierarchical proposal closes that gap explicitly because the per-cohort target prior is the per-request-fitted `Beta(α_g, β_g)`, narrower than the κ-inflated proposal `Beta(α_g/κ, β_g/κ)` by construction; without the ratio the posterior would inherit the proposal width, not the prior width.
- Per-cohort log-likelihood, tempering, and resampling vary by cohort because each has different row evidence on its own arrival clock.
- Per-cohort `(cond_p_draws_i, cond_cdf_draws_i)` come from indexing the shared proposal pool with cohort-specific resample indices.
- **Doc-52 unconditioned leg (latency)**: `prior_p_draws ∼ Beta(resolver.α, resolver.β)` and `prior_cdf_draws` is the **unconditioned latency CDF sampled from the resolver's predictive parameters** (NOT the κ-inflated hyperprior, which is itself an evidence-conditioned object). This keeps the doc-52 r=1 boundary on a resolver-only baseline. Sampled once per primitive per request from `(resolver.α_pred, resolver.β_pred)` and the resolver-supplied latency moments.
- **IS ESS-failure handling per cohort**: when cohort `i`'s tempering binary search cannot reach the target ESS, that cohort produces a **`DegradedTransitionPrimitive`**, NOT a `ConditionedTransitionPrimitive`. This is a separate type so the composer cannot mistake a degraded cohort for a draw-coherent posterior. Object contract:
  - `DegradedTransitionPrimitive` carries `degraded_reason: DEGRADED_CONJUGATE_ON_TOTALS_RATE_PROPOSAL_TIMING` (or another degraded reason) and **moments-only** summaries derived from the closed-form `Beta(α_g + k_i_w, β_g + n_i_w − k_i_w)` (mean, sd) plus the unconditioned proposal CDF moments. It does **not** carry `posterior_p_draws` or `posterior_cdf_draws` — there are no draws to expose, because the rate and timing kernels are independent and would not be draw-coherent if joined.
  - The conditioner returns `Union[ConditionedTransitionPrimitive, DegradedTransitionPrimitive]` per cohort. The list is `(N,)` long; each slot is one or the other type by named status, not by data inspection.
  - `cohort_draw_family_status: ndarray (N,) enum` on `HyperpriorFit` lifts the per-slot type to a tensor-friendly status with values `COHERENT_IS_POSTERIOR`, `DEGRADED_CONJUGATE_ON_TOTALS_RATE_PROPOSAL_TIMING`, and (for non-latency edges, by structural type dispatch) `COHERENT_CLOSED_FORM_BETA`.
  - The composer signature accepts only `ConditionedTransitionPrimitive` per cohort. Degraded cohorts are handled by the runtime layer above the composer: their entries in the per-cohort runtime list are flagged degraded; the composer is not called for them; their `BatchedComposedPrimitiveSpan` rows are filled with `viability_per_cohort_per_draw[i, :] = False` and `degraded_reason_per_cohort_per_draw[i, :] = DEGRADED_DRAW_FAMILY` for every draw `s`. This makes the degraded cohort visibly degraded in the same provenance channel as zero-reach / horizon-inadequate cells.
  - **Aggregator behaviour for degraded cohorts**: their viability-mask rows are False, so they are excluded from rate-aggregation viable-mass and from count-mode availability. Per-cohort lanes render the moments-only summary as a degraded band at the row level. Enforced by the named status and the type contract, not by data-quality conditional dispatch.

  This is numerical hygiene inside the conditioner kernel surfaced as explicit provenance — not a silent fallback. Because `DegradedTransitionPrimitive` carries no `posterior_p_draws` / `posterior_cdf_draws` fields and the composer's typed signature accepts only `ConditionedTransitionPrimitive`, a degraded cohort cannot reach the composer without an explicit adapter at the call site. This is an API-boundary guarantee enforced at the type contract, not a runtime check.

Non-latency edges keep the **exact closed-form conjugate path** ([primitive_conditioning.py:799-801](../../../graph-editor/lib/runner/primitive_conditioning.py#L799-L801)), vectorised across cohorts:
```
cond_p_draws_per_cohort = rng.beta(α_g + k_per_cohort, β_g + (n_per_cohort − k_per_cohort), size=(S, N))
prior_p_draws            = rng.beta(resolver.α, resolver.β, size=(S,))            # shared, doc-52 baseline
```
Doc-52 mixture combines these per cohort using the row-permutation scheme above. The conjugate path is reached by structural type dispatch on `timing_family`, not a data-quality fallback.

### Dispersion contracts

73p does not introduce a new dispersion mechanism. Per [doc 49](49-epistemic-uncertainty-bars-design.md) and [doc 61](61-dispersion-naming-symmetry.md), the codebase already separates two quantities and exposes them via two helpers:

- **Epistemic** (uncertainty about the parameter itself): `_fit_beta_to_samples(p_samples)` — direct moment match of MCMC / per-draw posterior samples; never κ-inflated.
- **Predictive** (epistemic plus overdispersion in observations): `_predictive_alpha_beta(p_samples, kp_samples)` — κ-inflated. `kp_samples` is the per-draw κ source from the resolver.

Per [doc 61](61-dispersion-naming-symmetry.md) the field-naming rule is invariant across surfaces: bare dispersion fields are epistemic; the `_pred` suffix is predictive. There is no CF-specific exception. Surfaces that show "where is the rate" (cohort-maturity overlay, model card) read bare fields; surfaces that show "what range of observations to expect" (forecast fan, daily-conversions bands) read `_pred`.

73p uses these helpers verbatim. The change vs today is only the source of `p_samples`: instead of pooled posterior draws, the helpers consume per-cohort blended posterior draws (the `(S,)` output of the doc-52 mixture per cohort) and aggregated draws (the `(S,)` output of the rate aggregator). κ is recovered from the resolver as today (precision ratio between `(α, β)` and `(α_pred, β_pred)`).

**Per-cohort fields** are computed by feeding cohort `i`'s blended posterior draws and the resolver's κ-samples into the existing helpers, producing `p_alpha_i` / `p_beta_i` (epistemic) and `p_alpha_pred_i` / `p_beta_pred_i` (predictive); `p_sd_i` etc. derive from those Betas.

**Aggregated lane fields** are computed by feeding the rate aggregator's per-draw output `aggregated_rate_per_draw ∈ (S,)` into the same helpers, with κ-samples shared across cohorts (the request-scoped κ).

W4 wires the helpers; no new formulae here, no field rename, no schema break.

### Aggregation over cohorts

Two distinct projections: rate (Y/X) and count (Y). Different per-cohort surfaces, different weight conventions.

**Rate aggregation (cohort-maturity headline, Y/X)** — uses per-cohort `subject_p`, `carrier_cdf`, `end_to_end_cdf`. Population-weighted average across cohorts:

```
For each draw s and each emitted τ_A:
    rate_per_cohort = (subject_p_draws[:, s] · end_to_end_cdf_draws[:, s, τ_A]) / carrier_cdf_draws[:, s, τ_A]
    viable_s        = viability_per_cohort_per_draw[:, s]                               # (N,) bool
    w_viable        = cohort_weights * viable_s                                         # (N,)
    W_s             = w_viable.sum()
    aggregated_rate_per_draw[s] = (w_viable · rate_per_cohort).sum() / W_s   if W_s > 0 else NaN
```

For window mode (`A == X`, carrier identity), `carrier_cdf = 1`, `end_to_end_cdf = subject_cdf`, and the formula collapses to today's `subject_p · subject_cdf[τ_A]` per cohort.

Why per-draw renormalisation: a rate is intrinsically conditional on what's being averaged. At each draw, the aggregate is "the rate among the cohorts that exist for this draw" — the only honest answer when some cohorts can't be projected at that draw. `nanmean` and `nanquantile` reduce the draw axis, skipping NaN draws; per-cohort viability fractions are surfaced in diagnostics so consumers can render an "X% of draws unavailable at this τ_A" hint.

**Count aggregation (daily-conversions Y count)** — uses per-cohort `end_to_end_p`, `end_to_end_cdf`. Raw cohort-size weights, no normalisation. Non-viable cells handled with explicit availability tracking, NOT silent zero substitution:

```
COUNT_AVAILABILITY_THRESHOLD = 0.95     # require ≥95% of population mass viable at each (date, draw) cell

For each draw s and each emitted τ_A:
    viable_s         = viability_per_cohort_per_draw[:, s]                              # (N,) bool
    available_mass_s = (cohort_weights * viable_s).sum() / cohort_weights.sum()         # in [0, 1]

    if available_mass_s >= COUNT_AVAILABILITY_THRESHOLD:
        count_per_cohort = cohort_weights * end_to_end_p_draws[:, s] * end_to_end_cdf_draws[:, s, τ_A]
        # Non-viable cells contribute zero ONLY because their mass-share is below threshold and the
        # remaining viable mass is enough to make the count meaningful. The viability mask is
        # broadcast into the multiplication explicitly:
        aggregated_count_per_draw[s] = (viable_s * count_per_cohort).sum()
    else:
        # Insufficient viable mass — emitting a count would silently substitute "we don't know"
        # for "zero". Refuse to project at this draw.
        aggregated_count_per_draw[s] = NaN

# Reduce with nanmean/nanquantile across draws.
# Diagnostic: per-(date, τ_A) availability histogram (fraction of draws emitted vs NaN'd).
```

Why this rather than silent zero: a non-viable cohort's "true" projected count is unavailable, not zero. Substituting zero biases the aggregate downward whenever a meaningfully sized cohort cannot be projected. The threshold (default 95%) treats small unavailability as numerically harmless (the 5%-or-less unavailable mass contributing zero is a bounded error) and refuses to fabricate a count when more than 5% of the population cannot be projected. Per-draw NaN propagation through nanmean/nanquantile yields honest mean/quantile bands that reflect only the draws where the projection was viable. If too many draws are NaN at a (date, τ_A) cell, the row emits NaN with a diagnostic explaining the unavailability.

The threshold is exposed as an aggregator parameter (`count_availability_threshold`) for tuning; default 0.95.

**Asymptotic `p_infinity_*`** for the rate headline uses rate aggregation: `aggregated_p_infinity_s = Σ_i ŵ_i · subject_p_draws_i[s]` over viable cohorts at draw `s`, then nanmean and nanquantiles across `s`.

**Completeness aggregation**: per-cohort `completeness_i` is today's CF completeness metric — model-side, derived from the **lag-CDF evaluated at the cohort's age** (i.e. `subject_cdf_draws_i[:, τ_A_i(now)]` averaged over draws, in the canonical case). It is *not* an evidence-coverage ratio over realised rows; it is the model's expected fraction of the cohort that has had time to convert by now under the per-cohort posterior CDF. Per-cohort completeness is computed per cohort from that cohort's own per-cohort CDF surface and exposed in per-cohort lanes.

Aggregated `completeness` (headline lane) is the cohort-size-weighted mean over viable cohorts: `Σ_i ŵ_i · completeness_i` where `ŵ_i = cohort_size_i / Σ_j cohort_size_j` over viable `i`. Degraded cohorts (per `cohort_draw_family_status`) are excluded from numerator and denominator. The aggregated value preserves today's CF schema field; no new completeness concept is introduced. If all cohorts are non-viable or degraded, aggregated completeness is `NaN` with a degraded-reason diagnostic. 73p does not change the completeness definition; it lifts today's per-row computation to per-cohort and aggregates by cohort weight.

---

## Architecture

### Three named projection surfaces

The composer produces three explicit per-cohort surfaces, NOT one overloaded `cdf_draws`:

- **Subject span** `(subject_p_draws, subject_cdf_draws)`: X → end. T axis is τ-since-X. Drives Y/X numerator. Identity for window mode.
- **Carrier span** `(carrier_p_draws, carrier_cdf_draws)`: A → X. T axis is τ-since-A. Carrier_p ≡ 1, carrier_cdf is the unit step for window mode (compressed broadcast tensor).
- **End-to-end span** `(end_to_end_p_draws, end_to_end_cdf_draws)`: A → end via per-draw FFT convolution of carrier ⊛ subject PMFs. T axis is τ-since-A. Drives count numerator. Equal to subject for window mode.

For window mode (`A == X`), `end_to_end ≡ subject` by construction. For active cohort (`A != X`), end-to-end is built once at composer time, so projection consumers do not run a second convolution layer.

The Y/X-never-Y/A invariant is enforced by the type contract: consumers select surfaces by name. Cohort-maturity Y/X reads `subject_p`, `subject_cdf`, `carrier_cdf`, `end_to_end_cdf`. Daily-conversions Y count reads `end_to_end_p`, `end_to_end_cdf`. Latency-band overlay reads `subject_p`, `subject_cdf`. There is no auto-select wrapper.

### Single batched conditioning API

```
condition_primitive_per_cohort(
    *,
    transition,
    primitive_scope,
    resolved_model,
    per_cohort_resolutions: List[PrimitiveEvidenceResolution],
    scenario_seed,
    options,
    prior_source,
) -> Tuple[List[Union[ConditionedTransitionPrimitive, DegradedTransitionPrimitive]], HyperpriorFit]
```

Internally:
1. Extract per-cohort sufficient stats from each cohort's binder output: weighted `(n_i_w, k_i_w)` and raw `(n_i_raw, k_i_raw)`.
2. Compute set-level `r` from `m_S_set = Σ_i n_i_raw` (raw mass per doc 52) via `compute_subset_policy`.
3. Fit hyperprior `(α_g, β_g)` via `fit_hyperprior(n_per_cohort_w, k_per_cohort_w, resolver_prior)` — weighted stats, no pro-rata scaling. The regularising scale is computed inside `fit_hyperprior` from `resolver_prior.α + resolver_prior.β` per the derivation rule; not passed in.
4. Structural dispatch on `timing_family`:
   - **Non-latency**: closed-form `cond_p_draws ∈ (N, S) ~ Beta(α_g + k_i_w, β_g + n_i_w − k_i_w)`; closed-form `prior_p_draws ∈ (S,) ~ Beta(resolver.α, resolver.β)`; `cdf_draws` are mass at τ=0.
   - **Latency**: shared proposal pool sampled from κ-inflated hyperprior `Beta(α_g/κ, β_g/κ)` × resolved latency. Per-cohort log-likelihood `(N, max_rows, S)` einsum reduced to `(N, S)`; per-cohort tempering and resampling produce `cond_p_draws ∈ (N, S)`, `cond_cdf_draws ∈ (N, S, T)`. Unconditioned leg `prior_p_draws ∈ (S,) ~ Beta(resolver.α, resolver.β)` and `prior_cdf_draws ∈ (S, T)` from the resolver predictive (not the κ-inflated hyperprior — doc-52 baseline must be evidence-free).
5. **Doc-52 mixture per cohort** with set-level `r`:
   - For each cohort `i`: row-permutation index tensor `(N, S)` with per-cohort RNG fold; `(1−r)·S` rows from `cond_*_i` and `r·S` rows from `prior_*` (broadcast across the cohort axis from the shared `(S,)` / `(S, T)` arrays). Same indices applied to `p` and `CDF` to preserve joint coherence.
   - At `r = 1`: every cohort's posterior is `prior_*` exactly (resolver baseline). At `r = 0`: every cohort's posterior is `cond_*_i` exactly.
6. Return `(N,)` list of `ConditionedTransitionPrimitive`, each carrying `posterior_p_draws ∈ (S,)`, `posterior_cdf_draws ∈ (S, T)`, plus provenance: weighted `(n_i_w, k_i_w)`, raw `(n_i_raw, k_i_raw)`, set-level `subset_policy`, `r`, the hyperprior `(α_g, β_g)`, and the cohort's `cohort_draw_family_status` value (set during the IS pass for latency edges; `COHERENT_CLOSED_FORM_BETA` for non-latency).

Existing `condition_primitive` becomes `condition_primitive_per_cohort([single_resolution])[0]` plus the fit. No separate single-cohort code path.

### Vectorised composer over the cohort axis

Three functions across two files become tensor-shaped along the cohort and draw axes:

| Function | File | Today | After W3 |
|---|---|---|---|
| `_compose_draws` | `subject_span_composer.py` | `(S, T)` per edge, `for s in range(S)` loop | `(N, S, T)` per edge; cohort and draw folded into one batched DP call; outer Python loop deleted |
| `compose_timing_span_from_densities` | `timing_span.py` | `(T,)` per edge | `(N, S, T)` per edge; canonical entry point |
| `_run_dp_density_grid` | `timing_span.py` | per-edge `np.convolve`, `(T,)` accumulator | per-edge `np.fft.rfft / irfft` along τ; `(N, S, T)` accumulator |
| `_topological_reach` | `timing_span.py` | per-draw scalar | `(N, S)` from `(N, S, n_edges)` |

**Linear-chain fast path** (common case): one batched `rfft → multiply along edge axis → irfft` along τ. **Branching topologies**: batched per-node DP using `rfft(g[p]) * rfft(f_edge[p,n])` accumulation. Both produce `(N, S, T)` density CDFs feeding the same downstream code.

**Active-cohort end-to-end CDF**: one additional batched FFT convolves `carrier_pmf ⊛ subject_pmf` per draw, producing `end_to_end_cdf_draws ∈ (N, S, T)`. Window mode short-circuits to `end_to_end = subject`.

**Mask-based degeneracy** (no early returns): `viability_per_cohort_per_draw ∈ (N, S) bool` and `degraded_reason_per_cohort_per_draw ∈ (N, S) enum` (`OK / ZERO_REACH / HORIZON_INADEQUATE / MISSING_PATH`) computed elementwise via `np.where`; non-viable cells become zero in `subject_p_draws` / `subject_cdf_draws` by `np.divide(..., where=viable, out=zeros)`. Aggregation operators consult the viability mask explicitly (no silent zero contributions).

### Per-cohort runtime

```
GroupedCohortRuntimes:
    cohort_anchor_days:    List[date]                    # (N,)
    cohort_weights:        ndarray of shape (N,)         # population sizes
    per_cohort_runtimes:   List[ResolvedCFRuntime]       # one per cohort, batched-tensor backed
    aggregated_runtime:    ResolvedCFRuntime             # for the headline lane (rate-aggregated)
    hyperpriors_by_edge:   Dict[edge_id, HyperpriorFit]  # MAP fits + diagnostics
    batched_composer_span: BatchedComposedPrimitiveSpan  # the (N, S, T) tensor backing
```

Per-cohort arrival map construction uses `root_day_weights = {single_anchor_day: 1.0}` per cohort. The aggregated runtime is derived from per-cohort runtimes by the rate aggregation operator. There is no separate Bayesian fit at the aggregated layer.

### Cache key extension

The existing `_primitive_cache` and `_subject_span_cache` keys discriminate on every input that affects the per-cohort posterior. A per-cohort posterior depends on:

1. The primitive identity and scope (today's discriminators).
2. The prefix arrival map (today's discriminator).
3. The fitted hyperprior `(α_g, β_g)` (new — different MAP fit produces different conditioned-leg posteriors).
4. The set-level doc-52 policy `r` (new — different `r` produces a different mixture per cohort).
5. The per-cohort evidence vector for that primitive (new — even with identical hyperprior and `r`, different per-cohort `(n_i_w, k_i_w)` and per-row weighted evidence produce different `Beta(α_g + k_i_w, β_g + n_i_w − k_i_w)` and different IS likelihoods).
6. The cohort axis (new — cohort identity is part of the per-cohort posterior identity).
7. The resolver prior / predictive parameters (today's discriminator, retained — the resolver-prior unconditioned leg depends on these).
8. Seed and options (today's discriminator).

```
per_cohort_evidence_identity = sha256(
    tuple of per-cohort:
        ( raw_scope_signature,                      # date range, anchor_day, scope filters per cohort
          weighted_totals,                          # (n_i_w, k_i_w) per cohort
          weighted_row_evidence_signature,          # sha256 over per-row (observed_date, retrieved_at, n_w, k_w)
        )
)

_primitive_cache_key = (
    transition,
    primitive_scope,
    prefix_arrival_identity,
    resolver_prior_identity,         # sha256(α, β, α_pred, β_pred, latency_moments)
    seed_options_identity,
    hyperprior_identity,             # sha256(α_g, β_g)
    subset_policy_identity,          # sha256(r, m_S_set, n_effective)
    cohort_axis_identity,            # sha256(tuple(cohort_anchor_days), tuple(cohort_weights))
    per_cohort_evidence_identity,    # sha256 over per-cohort scope, weighted totals, weighted row evidence
)

_subject_span_cache_key = _primitive_cache_key + (composer_topology_identity,)
```

This is the spirit of today's `condition_primitive` discrimination (raw scope, weighted totals, per-row weighted evidence, resolver prior/predictive params, seed/options) lifted to the per-cohort tensor case. Two requests sharing hyperprior, `r`, cohort axis, and prefix identity but with different per-cohort evidence vectors correctly miss cache. Cache invalidation correctness follows from key inequality at every component.

### Type contract

```
@dataclass
class HyperpriorFit:
    alpha_g: float
    beta_g: float
    sigma_h: float                                    # derived from resolver α + β; not a tunable input
    diagnostics: HyperpriorDiagnostics                # gradient norm, iteration count, safeguard activations
    cohort_draw_family_status: ndarray                # (N,) enum: COHERENT_IS_POSTERIOR / COHERENT_CLOSED_FORM_BETA
                                                      #            / DEGRADED_CONJUGATE_ON_TOTALS_RATE_PROPOSAL_TIMING

@dataclass
class DegradedTransitionPrimitive:
    """Per-cohort primitive emitted instead of ConditionedTransitionPrimitive when the
    conditioner cannot produce a draw-coherent posterior. Carries moments only.
    The composer's typed signature does not accept this type — degraded cohorts are
    handled at the runtime layer above (see GroupedCohortRuntimes / aggregator)."""
    degraded_reason: DegradedReason                   # DEGRADED_CONJUGATE_ON_TOTALS_RATE_PROPOSAL_TIMING etc.
    cohort_draw_family_status: CohortDrawFamilyStatus # mirror of the HyperpriorFit per-cohort enum value
    rate_mean: float                                  # mean of closed-form Beta(α_g + k_i_w, β_g + n_i_w − k_i_w)
    rate_sd: float                                    # sd of the same closed-form Beta
    timing_cdf_mean: ndarray                          # (T,) — mean of the unconditioned proposal CDF
    timing_cdf_sd: ndarray                            # (T,) — sd of the unconditioned proposal CDF
    n_i_w: float                                      # provenance
    k_i_w: float                                      # provenance
    n_i_raw: float                                    # provenance
    k_i_raw: float                                    # provenance
    hyperprior_alpha_g: float                         # provenance
    hyperprior_beta_g: float                          # provenance
    # Intentionally NO posterior_p_draws or posterior_cdf_draws fields. Degraded
    # cohorts have no draw-coherent samples to expose.

@dataclass
class BatchedComposedPrimitiveSpan:
    subject_p_draws:        ndarray   # (N, S)
    subject_cdf_draws:      ndarray   # (N, S, T_subject)
    carrier_p_draws:        ndarray   # (N, S)
    carrier_cdf_draws:      ndarray   # (N, S, T_carrier)      — unit step compressed for window mode
    end_to_end_p_draws:     ndarray   # (N, S)
    end_to_end_cdf_draws:   ndarray   # (N, S, T_endtoend)

    viability_per_cohort_per_draw:       ndarray   # (N, S) bool
    degraded_reason_per_cohort_per_draw: ndarray   # (N, S) enum

    def per_cohort_view(i: int) -> PerCohortComposedSurfaces:
        """Returns a view exposing all six named-surface fields for cohort i.
        Consumers select which surface they need by name. No auto-select."""
```

Single-instance callers (today's transition-primitive composer, moments-only composer) instantiate `N=1, S=1` tensors and route through the batched core. There is one composer math path.

### What stays unchanged

- `bind_primitive_evidence` — same code, called per cohort with each cohort's weighted view.
- `build_prefix_arrival_map` — same code, called per cohort with per-cohort root day weights.
- `compute_subset_policy` — same logic, called once per primitive per request with `m_S_set`.
- [73g](73g-general-purpose-f14-problem-and-invariants.md) and [73n](73n-unified-cf-runtime-invariants-and-audit.md) invariants — single primitive evidence-binding pathway, single conditioning pathway, single composition substrate. Shapes change (cohort axis added) but the contract surfaces stay singular.
- **Per-primitive-local-clock evidence retrieval (Cluster A precondition)**: the `EvidenceScope` bounds for each primitive's per-cohort retrieval are computed on that primitive's local arrival clock (its `subject` / `carrier` arrival map slice for the cohort), NOT from public anchor bounds. The Cluster A bug from F1 (synth-lat4 b→c `window(-1d:)`) was a retrieval-superset hole driven by using public bounds for a primitive whose effective evidence window started days earlier on its local clock. The per-cohort binder must continue to honour per-primitive-local-clock retrieval bounds for every cohort. W2 acceptance gates this on the synth-lat4 b→c fixture: the per-cohort weighted view for the immature cohort must include the same evidence rows as today's per-primitive-local-clock retrieval (no rows missing because anchor-based bounds excluded them).

### Schema

The aggregated chart lane returns the same fields as today (`p_infinity_mean`, `p_infinity_sd`, `fan_*`, `model_*`, `evidence_x`, `completeness_*`). Numbers are computed differently — strictly more correct under heterogeneity, close to today on homogeneous cohorts (with a small band-widening that reflects between-cohort sampling variance honestly).

Per-cohort posteriors are exposed as additive optional fields: in diagnostics (per-cohort `(α_g, β_g)`, viability fractions, doc-52 `r`); as a per-cohort lane in the row schema for opt-in consumers (initially: daily conversions; later: any per-cohort drill-down chart). No FE rendering change for the existing aggregated lane.

---

## Daily conversions integration

Per `29f-daily-conversions-engine-guidance.md` (16-Apr-26), the daily-conversions handler in `api_handlers.py` calls `compute_forecast_trajectory` directly at **two** call sites:

1. **Main projected_y / forecast_y sweep** ([api_handlers.py:~3497](../../../graph-editor/lib/api_handlers.py)): per-cohort projected forecasts at the cohort's natural eval age.
2. **Latency-band overlay sweep** ([api_handlers.py:~3593](../../../graph-editor/lib/api_handlers.py)): when `display_settings.show_latency_bands` is set, runs `compute_forecast_trajectory` once per latency band τ producing per-cohort projections at fixed band τ values.

Both must be migrated.

**Main projection cutover** — count surface, raw cohort-size weights, no normalisation:

```
τ_A_i(X) = X − anchor_i

cum_conv_i_per_draw(X) = cohort_size_i  ·  end_to_end_p_draws_i  ·  end_to_end_cdf_draws_i[:, τ_A_i(X)]
daily_conv_i_per_draw(X) = cum_conv_i_per_draw(X) − cum_conv_i_per_draw(X − 1)            # np.diff with prepend=0

# Aggregated count across cohorts on calendar date X:
aggregated_daily_count_per_draw(X) = count-mode aggregation operator over daily_conv_i_per_draw(X)
                                     # uses COUNT_AVAILABILITY_THRESHOLD per draw, NaN otherwise
```

Per-cohort lanes use `daily_conv_i_per_draw(X)` directly. For active-cohort (`A != X`), `end_to_end_cdf_draws_i` already represents the carrier⊛subject convolution at the per-draw level — no additional convolution layer is needed at projection.

**Latency-band overlay cutover** — subject rate surface (NOT end-to-end):

```
For each band label (τ_band, label) and cohort i:
    band_rate_i_per_draw = subject_p_draws_i · subject_cdf_draws_i[:, τ_band]                   # (S,)
    row['latency_bands'][label]['rate']  = mean over s of band_rate_i_per_draw
    row['latency_bands'][label]['q05'], row['latency_bands'][label]['q95'] = quantiles over s
```

Y/X-never-Y/A check: the overlay reads `subject_*`, not `end_to_end_*`. Mixing them silently produces Y/A. The named field accesses on `BatchedComposedPrimitiveSpan` enforce this; the W5 latency-band parity gate verifies it.

Both `compute_forecast_trajectory` call sites in `api_handlers.py` are deleted in W5. After W5 the only remaining call site in `api_handlers.py` is `surprise_gauge` (separate consumer, separate plan).

---

## Compute analysis

**Hyperprior MAP fit per primitive**: Newton with 10 iterations. Each iteration O(N) for the gradient and Hessian sums plus O(1) for the 2×2 solve. Per primitive: ~1–5 ms at N=90. Total across primitives per request: ~10–50 ms. Negligible.

**Per-primitive conditioning**: shared-proposal IS pass per primitive; per-cohort log-likelihood as a `(N, max_rows, S)` einsum reduced to `(N, S)`; per-cohort tempering and resampling vectorised over the cohort axis. For 90 cohorts at S=2000: tens to low hundreds of milliseconds per primitive.

**Composer**: linear-chain subject spans need one batched FFT per request. At `N=90, S=2000, T=400, n_edges=4`, the FFT operates on a `(90, 2000, 4, 1024)` tensor; cost ≈ `2 · N · S · n_edges · T · log(T) ≈ 4 × 10⁹` flops; well under one second on the standard dev box. Active-cohort end-to-end CDF: one additional batched FFT per cohort axis, ≈ 10⁹ flops, tens of milliseconds. Branching topologies: batched DP issuing one FFT per (predecessor, node) pair; expected on the order of seconds for a 4-node diamond at the same dimensions; measured in W3.

**Memory** at `N=90, S=2000, T=400, T_pad=1024, T_freq=513`:
- Sequential per-edge FFT processing keeps one running complex accumulator and FFTs each edge's real tensor in turn; peak transient during one edge: real `(N, S, T_pad) ≈ 1.47 GB` + frequency `(N, S, T_freq) ≈ 1.48 GB` + accumulator `≈ 1.48 GB` ≈ **4.5 GB peak** during the FFT loop, dropping to ~2 GB after.
- All-edges-at-once mode allocates all `n_edges` real and frequency tensors simultaneously: ≈ **14 GB peak**. Not recommended.
- Per-cohort composed spans (resident for request lifetime): subject_cdf + carrier_cdf + end_to_end_cdf at 8 bytes each ≈ **1.7 GB resident** (active cohort); ~1.2 GB for window mode.
- Total working-set during request: ~6 GB peak, ~2 GB resident at S=2000; halved at S=1000.

W6 sets a hard memory budget (suggested cap: 8 GB at N=90, S=2000); the composer issues `gc.collect()` after the FFT to reclaim transient tensors before passing to the aggregator.

**Net estimate**: a 90-cohort query completes in roughly **1.5×–3× a single-cohort request today**.

---

## Work items

One production-ready implementation. Items are sequencing units, not ship gates; every item is needed.

### W1 — MAP-fitted hyperprior

- New module `hierarchical_map.py`:
  - `fit_hyperprior(n_per_cohort_w: ndarray, k_per_cohort_w: ndarray, resolver_prior: ResolverPrior) -> HyperpriorFit`. Stats are arrival-weighted `(n_i_w, k_i_w)` from each cohort's binder output (the likelihood is on the arrival-weighted observations). Doc-52 raw mass `m_S_set = Σ_i n_i_raw` is computed and applied outside the fitter. The regularising scale is computed inside the fitter from `resolver_prior.α + resolver_prior.β` per the derivation rule (`scale = 1/√(α + β)`); not a parameter.
  - `HyperpriorFit` carries `(α_g, β_g)` plus the derived `sigma_h` plus `HyperpriorDiagnostics` (starting point, final log-posterior, gradient norm at termination, iteration count, step damping fired flag, determinant conditioning fired flag).
  - Newton on `(log α, log β)` with regularising normal prior centred at `(log resolver.α, log resolver.β)` and the derived scale. Numerical safeguards inside the kernel (bounded log-params, finite guards, determinant conditioning, step damping, gradient-norm convergence with hard iteration cap).
  - Inline `digamma` and `trigamma` (~30 LoC each, pure numpy). Tested against `math.lgamma` central differences to within 1e-10 / 1e-9.
- Verification on synth fixtures (stats here are weighted by construction — fixtures use unit arrival weights):
  - **Resolver-matched** (10 cohorts at `n_w=100, k_w_i ~ Beta(resolver.α, resolver.β) × 100`): MAP within 5% of resolver `(α, β)`.
  - **Coherent drift** (10 cohorts at `n_w=100, k_w_i = 30`, resolver mean 0.50): MAP shifted toward 0.30; precision finite.
  - **Heterogeneous** (10 cohorts spread across `[0.2, 0.8]`): MAP mean ≈ 0.5, precision lower than resolver.
  - **Single cohort, derivation rule check**: with the derived scale, single-cohort MAP departure from resolver shrinks as `(resolver.α + resolver.β)` grows. Tested across resolver strengths `(α + β) ∈ {10, 100, 1000}`; departure ratio matches the predicted `1/√(α + β)` scaling within MC tolerance.
  - **Empty cohorts** (5 with `n_w=0` mixed with 5 informative): MAP identical to a fit on just the 5 informative cohorts.
  - **Saturated** (5 cohorts at `k_w_i = n_w_i = 100`): MAP returns finite `(α_g, β_g)` with high mean; regularising prior bounds α from infinity.
  - **Convergence**: gradient norm at iteration 10 below 1e-6; iteration-10 result within 1e-8 of iteration-20 result.

### W2 — Batched conditioning API with shared proposal particles, doc-52 mixture against resolver prior

- New `condition_primitive_per_cohort` API in `primitive_conditioning.py` per the signature above.
- Internally:
  1. Extract per-cohort weighted `(n_i_w, k_i_w)` and raw `(n_i_raw, k_i_raw)` from each binder output.
  2. Compute set-level `r = compute_subset_policy(Σ_i n_i_raw, n_effective).r` (raw mass per doc 52).
  3. Call W1's `fit_hyperprior(n_per_cohort_w, k_per_cohort_w, resolver_prior)` with weighted stats. The regularising scale is derived inside the fitter from the resolver.
  4. Structural dispatch on `timing_family`:
     - **Non-latency**: `cond_p_draws ∈ (N, S)` from per-cohort `Beta(α_g + k_i_w, β_g + n_i_w − k_i_w)`. `prior_p_draws ∈ (S,)` from `Beta(resolver.α, resolver.β)`. CDFs are mass at τ=0. `cohort_draw_family_status[i] = COHERENT_CLOSED_FORM_BETA` for all cohorts. No degraded path on this branch.
     - **Latency**: shared proposal pool from κ-inflated hyperprior `Beta(α_g/κ, β_g/κ)` × resolved latency. Per-cohort log-likelihood with prior/proposal correction (see §"Joint conditioning preserved per cohort"), tempering, resample. For cohorts where the tempering binary search reaches the ESS target: `cond_p_draws_i ∈ (S,)`, `cond_cdf_draws_i ∈ (S, T)` are the resampled IS particles; `cohort_draw_family_status[i] = COHERENT_IS_POSTERIOR`. `prior_p_draws ∈ (S,) ~ Beta(resolver.α, resolver.β)` and `prior_cdf_draws ∈ (S, T)` from the resolver predictive (`alpha_pred`, `beta_pred`, resolver latency moments). For ESS-failure cohorts: no `cond_p_draws_i` or `cond_cdf_draws_i` are produced (independent kernels would not be draw-coherent); the cohort is flagged `cohort_draw_family_status[i] = DEGRADED_CONJUGATE_ON_TOTALS_RATE_PROPOSAL_TIMING` and emits a `DegradedTransitionPrimitive` (see step 6).
  5. **Doc-52 mixture per cohort against the resolver-prior leg** (only for cohorts with status `COHERENT_*`): row-permutation index tensor `(N_coherent, S)` with per-cohort RNG fold; `(1−r)·S` rows from `cond_*_i` and `r·S` rows broadcast from the shared `prior_*`. Same indices on `(p, CDF)` to preserve joint coherence. Degraded cohorts are skipped at this step (no draw families to mix).
  6. Build the per-cohort return list of length `N`. For each cohort `i`:
     - `cohort_draw_family_status[i] in {COHERENT_IS_POSTERIOR, COHERENT_CLOSED_FORM_BETA}` → emit a `ConditionedTransitionPrimitive` carrying the doc-52-mixed `posterior_p_draws ∈ (S,)`, `posterior_cdf_draws ∈ (S, T)`, weighted/raw provenance, hyperprior `(α_g, β_g)`, and `cohort_draw_family_status[i]`.
     - `cohort_draw_family_status[i] = DEGRADED_CONJUGATE_ON_TOTALS_RATE_PROPOSAL_TIMING` (or any future `DEGRADED_*`) → emit a `DegradedTransitionPrimitive` carrying `degraded_reason`, moments-only summaries (mean and sd of the closed-form `Beta(α_g + k_i_w, β_g + n_i_w − k_i_w)` for rate; moments of the unconditioned proposal CDF for timing), weighted/raw provenance, hyperprior `(α_g, β_g)`. **No `posterior_p_draws` / `posterior_cdf_draws` field on this type.**
     - Return the `(N,)` list of `Union[ConditionedTransitionPrimitive, DegradedTransitionPrimitive]` plus `HyperpriorFit`.
- Existing `condition_primitive` becomes `condition_primitive_per_cohort([single_resolution])[0]`.
- Verification:
  - **Doc-52 r=1 boundary**: at `r = 1`, each per-cohort posterior equals the shared `prior_*` draws exactly (resolver baseline). Tested on a synthetic fixture forcing `r = 1` and asserting `posterior_p_draws_i == prior_p_draws` for every cohort.
  - **Doc-52 r=0 boundary**: at `r = 0`, each per-cohort posterior equals `cond_*_i` exactly (full hierarchical update). Tested.
  - **Single-cohort departure** at `0 < r < 1`: bounded by the regularising scale (which is `1/√(resolver.α + resolver.β)`) and by `(1−r)`. Tested by asserting that on the production-representative single-cohort fixture, departure from today's chart numbers is below MC noise — given the resolver's actual `α + β`, no tuning needed.
  - **Per-cohort joint coherence**: for each cohort `i` and draw `s`, `posterior_p_draws_i[s]` and `posterior_cdf_draws_i[s, :]` derive from the same row index in the row-permutation tensor.
  - **No-conditioned-on-failure invariant** (HARD): cohorts with `cohort_draw_family_status[i] ∈ {DEGRADED_*}` MUST NOT produce a `ConditionedTransitionPrimitive` carrying status `CONDITIONED`, and MUST NOT propagate a `p_infinity_*` value through the public response. Tested by forcing IS ESS-failure on one cohort and asserting (a) that cohort's primitive carries an explicit degraded status label, (b) the public response either omits or marks `p_infinity_*` for that cohort with the degraded reason, (c) the aggregated lane excludes the degraded cohort from rate viable mass and count availability mass. The legacy "latent k/n fallback silently producing a CONDITIONED primitive" failure mode (called out by 73n) must not regress.
  - **Per-primitive-local-clock retrieval acceptance gate** (Cluster A): on synth-lat4 b→c `window(-1d:)`, the per-cohort weighted view for the immature cohort must include all evidence rows that today's per-primitive-local-clock retrieval includes — no rows missing because per-cohort retrieval bounds collapsed to public anchor bounds.
  - **Shape contract conformance** at every boundary in the type contract above.

### W3 — Vectorised composer

- Rewrite `_compose_draws`, `compose_timing_span_from_densities`, `_run_dp_density_grid`, `_topological_reach` as `(N, S, T)`-tensor operations per the table above.
- Linear-chain fast path: batched FFT along τ. Branching topologies: batched per-node DP. Both produce `(N, S, T)` density CDFs feeding the same downstream.
- Active-cohort end-to-end via batched `rfft(carrier_pmf) * rfft(subject_pmf)`; window mode short-circuits to `end_to_end = subject`.
- Mask-based degeneracy with `viability_per_cohort_per_draw` and `degraded_reason_per_cohort_per_draw` per the §"Mask-based degeneracy" sketch; non-viable cells become zero in `subject_p_draws` / `subject_cdf_draws` via `np.divide(..., where=viable, out=zeros)`. No early returns.
- Wrapper types `BatchedTimingSpan` and `BatchedComposedPrimitiveSpan` carry the surfaces and the viability/reason provenance. `per_cohort_view(i)` returns a `PerCohortComposedSurfaces` exposing all six named surface fields.
- Verification:
  - Numerical agreement with the existing per-draw DP at `N=1` to within FFT-vs-spatial-convolution tolerance (`atol = 1e-9, rtol = 1e-7` on `subject_cdf_draws` and `subject_p_draws`).
  - Joint coherence: composed `subject_cdf_draws[i, s]` and `subject_p_draws[i, s]` for cohort `i` derive from the same per-edge per-draw particles `s` for that cohort.
  - Active-cohort `end_to_end_cdf_draws` matches a reference implementation that explicitly carrier-then-subject convolves per draw on a 2-edge active fixture.
  - Mask-degeneracy: a cohort with `reach = 0` produces zero contribution and other cohorts unchanged at every `s`; composer never raises, never early-returns, never logs a fallback message.
  - Linear-chain wall time at `N=90, S=2000, T=400, n_edges=4`: under 1 second.
  - Branching wall time on a 4-node diamond at the same dimensions: measured and reported; gates production rollout if it exceeds 5 seconds.

### W4 — Per-cohort runtime + draw-level aggregation operator

- `GroupedCohortRuntimes` dataclass per the §"Per-cohort runtime" structure.
- Per-cohort arrival maps with `root_day_weights = {single_anchor_day: 1.0}` per cohort.
- Per-cohort composed spans via W3's vectorised composer.
- `aggregate_grouped_cohort_runtimes(grouped_runtimes, *, mode: 'rate' | 'count', count_availability_threshold=0.95)`:
  - **Rate mode** reads `subject_p_draws`, `carrier_cdf_draws`, `end_to_end_cdf_draws`. Per-draw renormalisation over viable cohorts. NaN draws skipped via nanmean / nanquantile reduction. Per-cohort viability fractions surfaced in diagnostics.
  - **Count mode** reads `end_to_end_p_draws`, `end_to_end_cdf_draws`. Per-draw availability check against `count_availability_threshold`; below threshold → NaN draw; else viable-cell sum (non-viable cells contribute zero by viability mask multiplication, bounded by the threshold). Per-(date, τ_A) availability histogram surfaced in diagnostics.
  - **Streaming over τ_A**: each iteration reads only `[:, :, τ_A]` slices from the CDF tensors.
- **Dispersion fields** computed inline per the pinned formulae above (CF schema: bare `p_sd` = predictive, `p_sd_epistemic` = epistemic):
  - Per-cohort `p_sd_i` (predictive) and `p_sd_epistemic_i` (epistemic) from `rate_i_per_draw` and `cohort_size_i`.
  - Aggregated `p_sd` (predictive) and `p_sd_epistemic` (epistemic) from `aggregated_rate_per_draw` and `Σ_i cohort_size_i`.
- **Cache key extension** per §"Cache key extension".
- Verification:
  - **Window mode close-to-parity**: `N=1` invocation, `scenario_seed = 42`, on synth-lat4 b→c `window(-1d:)` and three additional fixtures (synth-simple-abc window, synth-lat4 c→d window, synth-fanout window). With the derived regularising scale: `p_infinity_mean` within 5e-3 absolute, `p_infinity_sd` within 5% relative, fan band edges within 5e-3 absolute, `completeness_mean` within 2e-3 absolute. Justification: today's MC noise on these fixtures is ~2e-3; allowing 2.5× headroom. Exact parity NOT asserted; bounded departure asserted.
  - **Doc-52 r=1 parity** (separate, architectural — independent of regularising scale): at `r = 1` the new path's per-cohort posteriors are exactly `Beta(resolver.α, resolver.β)` draws (the hyperprior plays no role at this boundary), and aggregated lane equals today's r=1 resolver-only output to within MC noise.
  - **Aggregated lane on heterogeneous fixtures**: per-cohort posteriors visibly distinct; aggregated mean and bands reflect the mixture; coherent group-wide drift detected through `hyperprior_mean ≠ resolver_mean` to within a measurable threshold on a drift fixture.
  - **Dispersion contracts** (CF schema): per-cohort and aggregated `p_sd` (predictive) and `p_sd_epistemic` (epistemic) computed from the pinned formulae; tested on a fixture with known posterior `Var[p]` and `E[p(1-p)]` to within MC tolerance. Field-naming parity with today's CF response asserted.
  - **Cache key correctness**: every key component is asserted to discriminate. Tests construct paired requests differing only in (a) hyperprior `(α_g, β_g)`; (b) `r`; (c) cohort axis (anchor days, weights); (d) per-cohort weighted totals `(n_i_w, k_i_w)`; (e) per-cohort weighted row evidence (same totals, different per-row distribution); (f) resolver `(α, β, α_pred, β_pred)`; (g) seed/options. Each pair is asserted to miss cache. A negative test (two genuinely identical requests) asserts a cache hit.
  - **Degraded draw-family handling**: a fixture forcing IS ESS-failure on one cohort produces `cohort_draw_family_status[i] = DEGRADED_CONJUGATE_ON_TOTALS_RATE_PROPOSAL_TIMING` for that cohort. The aggregator excludes it from rate-mode viable mass and from count-mode availability. The per-cohort lane carries the `DEGRADED_DRAW_FAMILY` reason on every draw; tested.

### W5 — Daily conversions cutover

The daily-conversions handler in `api_handlers.py` has **two** legacy `compute_forecast_trajectory` call sites; W5 migrates and deletes both.

- **Main projection** ([api_handlers.py:~3497](../../../graph-editor/lib/api_handlers.py)):
  - New operator `daily_conversions_projection(grouped_runtimes, date_axis) -> rows` in `cohort_forecast_v3.py`. Reads `runtime_i.batched_composer_span.end_to_end_p_draws` and `end_to_end_cdf_draws` per cohort.
  - Per-(cohort, date X): `cum_conv_i_per_draw = cohort_size_i · end_to_end_p_draws_i · end_to_end_cdf_draws_i[:, τ_A_i(X)]`.
  - Daily increment via `np.diff` along the date axis with `prepend=0`.
  - Aggregated daily count via W4's count-mode aggregation with `count_availability_threshold=0.95`.
  - Mean and quantiles across the draw axis per (date, cohort or aggregated).
  - Replace the main `compute_forecast_trajectory` call with `compute_cohort_maturity_rows_v3` returning `GroupedCohortRuntimes` plus `daily_conversions_projection`.
- **Latency-band overlay** ([api_handlers.py:~3593](../../../graph-editor/lib/api_handlers.py)):
  - For each band `(τ_band, label)` and cohort `i`: read `subject_p_draws_i` and `subject_cdf_draws_i` (NOT end-to-end). Compute `band_rate_i_per_draw = subject_p_draws_i · subject_cdf_draws_i[:, τ_band]`. Mean and quantiles → `row['latency_bands'][label]`.
  - Observed rate at band τ uses today's `cohort_y_at_age` lookup unchanged.
  - Delete the second `compute_forecast_trajectory` call (~line 3593).
- **Legacy deletion**: delete both `compute_forecast_trajectory` call sites, the `_band_sweep` cohort construction loop and its `CohortEvidence` builder, the `_sweep` cohort construction and `_proj_y` annotation block, and the legacy fallback comment block. After W5, the only `compute_forecast_trajectory` call site remaining in `api_handlers.py` is `surprise_gauge`. Confirmed by grep.
- Verification:
  - **Window mode parity (main projection)**: single-cohort daily-conversions matches today's `compute_forecast_trajectory`-derived `projected_y` / `forecast_y` to within MC noise.
  - **Active-cohort daily conversions**: cohort with `A != X` matches a reference implementation explicitly carrier-then-subject-convolving per draw on a 2-edge active fixture.
  - **Latency-band overlay parity**: per-(cohort, band τ) `band_rate` matches today's output to within MC noise on a synth fixture with `show_latency_bands` enabled.
  - **Y/X-never-Y/A check**: latency-band overlay reads `subject_*` only; tested by asserting a value differing from `end_to_end_*` on a non-trivial active-cohort fixture.
  - **Count availability handling**: a fixture where one large cohort fails viability at some draws produces NaN bands at those (date, draw) cells; diagnostic histogram populated.

### W6 — Heterogeneous synth fixture

- New synthetic graph + truth.yaml exercising calendar-drift edge rates across cohorts (`synth_gen.py` extension).
- Outside-in tests that pass on this fixture only when hierarchical conditioning detects the drift through the MAP-fitted hyperprior.
- Becomes part of the regression suite. Prerequisite for W1's drift verification and W4's heterogeneous test.

---

## Risks

- **Single-cohort departure from today**: under hierarchical empirical-Bayes MAP the same cohort's evidence informs both the hyperprior fit and the per-cohort conjugate update. The departure from today's posterior is bounded by the regularising scale (`1/√(resolver.α + resolver.β)` — small for strong offline fits) and by `(1−r)` (the conditioned leg's mixture weight). At `r = 1` the departure is exactly zero ([doc 52](52-subset-conditioning-double-count-correction.md) baseline is the offline posterior).
- **MAP point estimate ignores hyperparameter uncertainty**: the per-cohort posterior is conditioned on a fixed `(α_g_MAP, β_g_MAP)` rather than integrated over the hyperparameter posterior. Mildly understates per-cohort posterior sd in the conditioned leg. Acceptable as the chosen method; full Bayesian hierarchical (MCMC) is out of scope.
- **Aggregated band wider than today's pooled band on homogeneous fixtures**: today's pool conflates `Σ_i n_i_w` evidence into one observation set, under-stating between-cohort sampling variance. The new aggregated band reflects this variance honestly. A small band-widening shift on cutover.
- **Branching-topology composer performance and memory** — see §"Resource budgets"; W3 measures actuals against the proposed caps.
- **κ recovery**: the IS proposal's κ inflation factor is the precision ratio `(resolver.α + resolver.β) / (alpha_pred + beta_pred)`. The κ-inflated hyperprior `Beta(α_g/κ, β_g/κ)` is the IS proposal centre; W1 verifies this coincides with the resolver's κ-inflated predictive in single-cohort mode.

---

## Out of scope

- Full hierarchical MCMC (Stan / PyMC). Chosen method is MAP on the hyperparameter posterior with a regularising Bayesian prior centred on the resolver.
- Time-varying edge rates within a cohort.
- Cross-edge hierarchical structure (sharing strength across edges of the same type). Each primitive's hyperprior is fit independently within a request.
- New chart types beyond daily conversions. Per-cohort drill-down is an independent atom not bundled here.
- Frontend rendering changes for the existing cohort_maturity aggregated lane.
- **Gross-fitted numerator mode (rejected)**. Per [73n](73n-unified-cf-runtime-invariants-and-audit.md) invariant L, every primitive fit and every per-cohort posterior in 73p is **factorised** (per-edge `(p, latency)` jointly, composed by topological convolution per [`COHORT_ANALYSIS_NUMERATOR_DENOMINATOR_SEMANTICS.md`](../codebase/COHORT_ANALYSIS_NUMERATOR_DENOMINATOR_SEMANTICS.md)). Gross-fitted numerator mode — admitting an end-to-end count or numerator as the fitted quantity rather than as the composition of per-edge factors — is out of scope. End-to-end count surfaces in 73p (used by daily conversions and the count aggregator) are *only* factorised carrier⊛subject compositions per draw. No Pop C / Pop D admission. A future gross-fitted view requires a separate plan that revisits 73n invariant L.

---

## What this plan inherits, what it owes, what it gets wrong

This section replaces an earlier "decision points" list. After review against the upstream contracts (docs 49, 52, 61, 73g, 73n, 1), there are no genuinely-open architectural choices for 73p — the contracts pin them. There are inherited preconditions, body errata to fix, and concrete work the plan still owes.

### Preconditions inherited from upstream contracts

73p does not get to choose these. They are stated here so the rest of the plan body can be checked against them.

- [Doc 52](52-subset-conditioning-double-count-correction.md) **fixed-point principle**: as the runtime selected set approaches the entire offline training set (`r → 1`), the runtime conditioning step approaches a no-op against the offline-fitted posterior. Conditioning again on data the offline fit already saw would double-count. **Consequence for 73p**: the doc-52 unconditioned mixture leg is the offline posterior (`Beta(resolver.α, resolver.β)`), not the per-request hyperprior. The hyperprior is a runtime construct fit from the cohort observations and so cannot satisfy the no-update-vs-model-vars boundary.
- [Doc 61](61-dispersion-naming-symmetry.md) **dispersion field naming**: bare dispersion fields are epistemic; `_pred` suffix denotes predictive. No CF exception.
- [Doc 49](49-epistemic-uncertainty-bars-design.md) **helper definitions**: predictive = κ-inflated parameter posterior via `_predictive_alpha_beta(p_samples, kp_samples)`; epistemic = direct MC fit via `_fit_beta_to_samples(p_samples)`. 73p uses these on per-cohort posterior draws.
- [Doc 1](1-cohort-completeness-model-contract.md) **completeness contract**: completeness is the model lag CDF evaluated at a cohort's age. One semantic evaluator per `cohort()` analysis.
- [73g](73g-general-purpose-f14-problem-and-invariants.md) **invariant 1** (single forecast machinery path; cases differ only by natural degeneration): hierarchical conditioning is the same machinery degenerated to one cohort, not a parallel branch. Numerator/denominator semantics for that single chain are documented in [`COHORT_ANALYSIS_NUMERATOR_DENOMINATOR_SEMANTICS.md`](../codebase/COHORT_ANALYSIS_NUMERATOR_DENOMINATOR_SEMANTICS.md).
- [73g](73g-general-purpose-f14-problem-and-invariants.md) **invariant 2** (displayed rate is Y/X, never Y/A): enforced by the named-surface type contract on `BatchedComposedPrimitiveSpan`.
- [73n](73n-unified-cf-runtime-invariants-and-audit.md) **invariant A** (per-primitive-local-clock evidence binding; non-root arrival-map miss is never identity, must become degraded provenance): the Cluster A retrieval contract.
- [73n](73n-unified-cf-runtime-invariants-and-audit.md) **invariant B** (doc-52 blend at primitive posterior construction only; composed consumers do not re-apply).
- [73n](73n-unified-cf-runtime-invariants-and-audit.md) **invariant L** (factorised vs gross-fitted numerators are mutually exclusive; gross-fitted requires a separate plan): gross-fitted out of scope per §"Out of scope".
- [Doc 52](52-subset-conditioning-double-count-correction.md) **§14.4.1** (per-cohort y_draws/x_draws preserved through `cohort_evals`): the W5 daily-conversions cutover preserves this via `end_to_end_p_draws × cohort_size` shaped per cohort.

### What 73p has not yet defended from first principles, and owes

- **Doc-52 mass-unit reconciliation.** [Doc 52](52-subset-conditioning-double-count-correction.md) uses `m_S = sum(c.x_frozen for c in cohorts if c.x_frozen > 0)` at runtime; 73p writes `m_S_set = Σ_i n_i_raw`. These need to be the same quantity (sum of frontier raw n per cohort). Verify against the current code path and align the wording.
- **Stale `alpha_beta_query_scoped` reference.** Doc 52's original skip predicate cited it; per I-25 (28-Apr-26) it was retired (now unconditionally `False`). 73p inherits whatever the current `compute_subset_policy` code does; verify the call site reflects the post-I-25 behaviour and update the description.
- **W6 outside-in fixture scope, derived rather than asserted.** Hierarchical conditioning is a no-op unless cohorts genuinely differ. From first principles the test fixtures must exercise: (a) heterogeneous edge rates across cohorts (the per-request shared posterior should detect drift away from the offline posterior), (b) heterogeneous cohort ages at the same true rate (per-cohort posteriors should differ in width but agree in centre), (c) at least one active-cohort variant (`A != X`) so the end-to-end carrier⊛subject path is exercised. Each fixture asserts (i) per-cohort posteriors differ in the predicted way, (ii) the chart's mass-weighted aggregate matches a hand-computed reference, (iii) for fixture (a), the shared posterior moved off the offline posterior. This is the W6 deliverable; it is not a reviewer choice.

### Defaults and "knobs" — defended away

The earlier draft listed three tunable defaults. None survives first-principles defence; all three are removed.

- **The regularising scale on the per-request shared posterior** (was: σ_H, default 1, "tune empirically"). The principled rule, derived in §"Fitting (α_g, β_g)", is `scale = 1/√(resolver.α + resolver.β)`. The regularising prior should match the data strength of the object it's centred on. There is no knob; the value is computed inside the fitter from the resolver.
- **Cohort weight in aggregation** (was: default `cohort_size_i`, alternatives uniform/recency). The chart's denominator is sum-of-X over cohorts, which is population-weighted by construction. Anything other than population-size would render a chart whose denominator is not what it claims to be. Population-weighting is not a knob; it is the chart's arithmetic.
- **Count availability threshold** (was: default 0.95, NaN below). Removed. Per-draw NaN propagation is the principled rule: at each draw `s`, if any cohort with non-trivial weight cannot be projected, the aggregated count at draw `s` is NaN; reduce via nanmean / nanquantile across draws; surface per-cohort availability fractions in diagnostics. The 0.95 was a fudge dressing up "I didn't know what to do". Consumers decide what to do with NaN bands; the aggregator does not pre-decide for them.

### Resource budgets

W3 measures and reports; if the actuals exceed the proposed caps, reduce S or restrict cohort count.

- Branching-topology composer wall time at N=90, S=2000, T=400 on a 4-node diamond: target ≤ 5 s.
- Working-set memory at N=90, S=2000 (sequential per-edge composer mode): target ≤ 8 GB (~4.5 GB transient peak during the FFT, ~2 GB resident through the request).

---

