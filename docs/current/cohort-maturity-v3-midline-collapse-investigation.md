# Cohort Maturity v3 — Midline Collapse Investigation

**Status**: Open investigation, ready for external review
**Date**: 29-Apr-26
**Revision**: 5 — material reframe. Earlier revisions (1-4) framed the
underlying defect as "predictive prior + joint IS mismatch" with two fix
options labelled A and B. External review made it clear that framing was
confused about which *level* of `p` the chart is reporting. The revision
restructures around three levels of `p` (per-user, per-cohort-date,
per-group), shows where the current code conflates them, and proposes a
hierarchical Level 2 / Level 3 fix rather than a prior-swap. Two earlier
items survive intact: Defect 1 (the `int(remaining)` truncation) and the
disambiguation-instrumentation-first sequencing.

**Scope**: documents the symptom, the levels of `p` involved, two distinct
defects (one trajectory-arithmetic, one model-shape), an
instrumentation-first plan, and the contracts that any fix has to honour.

## See also

- `docs/current/codebase/COHORT_ANALYSIS_NUMERATOR_DENOMINATOR_SEMANTICS.md` —
  semantic contract this investigation works against.
- `docs/current/project-bayes/49-epistemic-uncertainty-bars-design.md` —
  origin of the kappa-inflated predictive Beta. The comment at
  `forecast_state.py:937` cites this doc as the justification for sampling
  forecast MC draws from the predictive prior; whether doc 49 actually
  intended the predictive to enter the *conditioned* trajectory or only the
  unconditioned model fan needs explicit confirmation from the doc owner.
- `graph-editor/lib/runner/forecast_state.py` — `compute_forecast_trajectory`.
- `graph-editor/lib/runner/cohort_forecast_v3.py` —
  `compute_cohort_maturity_rows_v3`. The load-bearing comment block around
  lines 1290-1303 distinguishes `p_draws` from `rate_draws` (the latter is
  the per-particle group trajectory). That distinction is at the heart of
  the level-confusion this revision corrects.
- `graph-editor/lib/tests/test_cohort_factorised_outside_in.py` — the
  outside-in acceptance suite. Contains the cross-mode `p_infinity_mean`
  invariants (window vs cohort identity collapse, anchor depth monotonicity,
  subject-equivalent cohort-window convergence) that any fix has to
  preserve. These tests pin **anchor independence** at saturation — a real
  semantic invariant, not just a tolerance.
- `graph-editor/lib/tests/test_v2_v3_parity_outside_in.py` — pins midpoint
  parity per τ between v2 and v3 within 0.06 absolute. Less load-bearing
  than the outside-in suite (its tolerance is broad), but still a guardrail
  against regressions.

## TL;DR

Symptom: on the captured trace (marks `cf 1` / `cf 2`), the v3 cohort
maturity midline plateaus at ≈ 0.49 while the analytic posterior on the
underlying rate parameter sits at `p_mean = 0.852`. No visible forecast
crown.

There are **two defects**, on different layers, and a third **internal
inconsistency** that's worth fixing alongside but isn't the cause of the
visible plateau:

1. **Defect 1 — `int(remaining)` truncation in Pop D arithmetic.**
   `forecast_state.py:726` runs `np.random.binomial(int(remaining), q_late)`
   where `remaining = N_i − k_i` is fractional for every cohort in this
   trace (carrier-projected populations are sub-unit because
   `reach = 0.0151`). `int(0.34) = 0`, so Pop D contributes 0. The
   trajectory then collapses to `Σk_i / Σ(N_i + X_C_i) ≈ 0.485` — exactly
   the observed plateau. Pure arithmetic / boundary defect; no model
   semantics involved.

2. **Defect 2 — level confusion at the rate-conditioning seam.**
   The forecast samples a single shared `(p, μ, σ, onset)` per particle
   (Level 1 / shared-rate shape) using the *predictive Beta width*
   (`α_pred, β_pred`, which is Level 2 — between-cohort-date dispersion),
   then conditions it against per-cohort evidence with a **joint
   likelihood** (Level 1 shape again). Three levels are wired together
   incoherently. The intended chart output is at Level 3 (the group's
   posterior aggregate trajectory), and what the code actually produces is
   neither a clean Level 1 posterior nor a clean Level 3 hierarchical solve.

3. **Internal inconsistency — `p_infinity_mean` reads `sweep.p_draws`.**
   The chart's `midpoint` curve reads `rate_draws[:, τ]` (per-particle group
   trajectory; Level 3). The same row's `p_infinity_mean` field reads
   `sweep.p_draws` (rate parameter; Level 1/2). These can diverge —
   documented in `cohort_forecast_v3.py`'s comment block — but it means the
   chart is reporting two different objects under what the user thinks is
   one consistent contract.

Sequencing: instrument first; fix Defect 1; fix the `p_infinity_mean`
source conflation; *then* decide on the model-shape fix for Defect 2.

## Symptom (unchanged)

Captured at marks `cf 1` (ts 1777456394512) and `cf 2` (ts 1777456409284).

- Query: `from(switch-registered).to(switch-success).cohort(30-Mar-26:28-Apr-26)`
- Anchor: `Landing-page` (so `A ≠ X`, real upstream carrier in play)
- `reach = 0.0151`
- 30 cohorts (one per anchor day in the cohort range)
- Resolved span params: `mu = 2.282, sigma = 0.654, onset = 0.3`
- Resolved rate: `p_mean = 0.852, α = 323.80, β = 56.46, α_pred = 7.93, β_pred = 1.41`
- Sweep: `IS_ESS = 38, cohorts_conditioned = 27, shape = (2000, 92)`
- Aggregate `Y_total / X_total` plateaus at ≈ 0.485 from τ ≈ 20 onward.

On the chart: dashed evidence line and dotted "Total Forecast" midline
overlap; no visible crown.

## Three levels of `p`

The single-letter `p` carries three different meanings in this stack. The
existing code does not consistently keep them apart, and that's the heart
of the model-shape confusion.

| Level | Object | What it represents |
|---|---|---|
| 1 | per-user `p` | A user who reaches `X` either converts or doesn't. Bernoulli outcome. The "true" Level-1 rate is the long-run conversion probability for an individual user given everything we condition on. |
| 2 | per-cohort-date `p_d` | Each anchor day `d` has its own rate, because campaigns / day-of-week / market state / etc. vary across days. Hierarchically `p_d ~ Beta(α_pop, β_pop)` where the Beta width is **kappa**. |
| 3 | per-cohort-group `p_group` | The user asked about the group `[start:end]`. They want one number (and one curve) describing the group as a whole. `p_group(τ) = Σ_d Y_d(τ) / Σ_d X_d(τ)` — an n-weighted aggregate across the cohort dates *in this group*. Derived quantity, not a primitive parameter. |

### Where each model var lives

| Object | Level | What it represents |
|---|---|---|
| `α, β` (epistemic posterior) | 1 | Posterior on the per-user underlying rate, after all historical evidence. |
| `α_pred, β_pred` (predictive Beta) | 2 | Marginal distribution of `p_d` for a fresh anchor day, accounting for between-date variation. |
| `mu, sigma, onset` (lognormal latency) | 1 | Per-user time-to-convert distribution. |
| `mu_sd, sigma_sd, onset_sd` | 1 (epistemic) | Posterior uncertainty on per-user latency parameters. |
| `kappa` (implicit in `α_pred, β_pred`) | 2 | Between-date dispersion magnitude. |
| Per-cohort `(k_d, n_d, a_d)` | 2 (per date) | Evidence for date `d`'s rate. |
| Aggregate `Σ k / Σ n` at frontier | 3 (group) | Empirical group rate at last observation. |
| Chart `midpoint` curve | 3 (group) | **Should be:** posterior on `p_group(τ)`. |
| Chart fan / dispersion bands | 3 (group) | **Should be:** posterior dispersion on `p_group(τ)` — match the model spark charts' contract that dispersion represents "best guess of an actual conversion journey on this edge". |
| `p_infinity_mean` field | 3 (should be) | **Currently reads `sweep.p_draws` (Level 1/2)**, conflating with the parameter posterior. Should read `np.median(rate_draws[:, saturation_tau])`. |

### Window vs cohort — both are groups of cohorts

`window()` and `cohort()` are *both* groups of cohorts. They differ only in
where the per-member anchor sits:

- **`window(s:e)`** — group of cohorts each anchored on its day-of-arrival
  at `X`. `carrier_to_x` collapses to identity per cohort (population is
  already at `X` on day 0). Pop C is empty.
- **`cohort(A, s:e)`** — group of cohorts each anchored on its day-of-arrival
  at `A`. `carrier_to_x` is non-trivial per cohort. Pop C is non-empty.

Same hierarchical structure underneath; the temporal slicing differs. Both
produce a Level-3 group trajectory.

This makes the existing cross-mode `p_infinity_mean` tests
(`test_a_equals_x_identity_collapses_to_window`,
`test_anchor_depth_monotonicity_for_same_subject`,
`test_cohort_and_window_p_infinity_converge_for_same_subject_rate`,
`test_cohort_frame_evidence_does_not_retarget_carrier_or_subject`) look much
more sensible than earlier revisions of this doc claimed. They pin
**anchor independence**: the asymptotic group rate should be a property of
the edge and the date range, not of which upstream node the user picks as
the temporal origin. That's a real invariant and any fix must preserve it.

## Defect 1 — `int(remaining)` truncation

### Location

`graph-editor/lib/runner/forecast_state.py:719-726`:

```
remaining = max(N_i - k_i, 0.0)
...
Y_D = loop_rng.binomial(int(remaining), q_late)
```

`N_i` and `k_i` are the cohort's `x_frozen` and `y_frozen` — for
`cohort()` mode with a real upstream carrier, these are the
carrier-projected expected arrivals at `X`
(`a_pop × reach × carrier_cdf(a_i)`), which is fractional when `reach` is
small.

For the trace in §"Symptom", `reach = 0.0151`. Per-cohort `N_i` values
range from 0.23 to 1.99, with `k_i` typically `~0.4 × N_i`. So `remaining
= N_i − k_i` is in `[0.0, 1.2]` — every cohort in the trace lands under
1.0. (Spot check from the captured per-cohort log: `a_i=14, N_i=1.99,
k_i=1.07 → remaining=0.92`; `a_i=19, N_i=0.95, k_i=0.64 → remaining=0.31`;
`a_i=13, N_i=1.10, k_i=0.55 → remaining=0.55`.)

### Effect

`np.random.Generator.binomial(0, q_late)` returns 0 deterministically. So
`Y_D = 0` for every cohort with `remaining < 1`. In this trace that is all
30 cohorts. With `Y_D = 0`:

```
Y_forecast = k_i + 0 + Y_C ≈ k_i + small_Y_C
aggregate Y_total / X_total ≈ Σ k_i / Σ (N_i + X_C_i) ≈ 0.485
```

Matches the observed plateau exactly without `p_draws` having to move.

### Generality

The general statement is "`Y_D = 0` for every sub-unit-remaining cohort",
not "for every fractional-population cohort". A cohort with
`remaining = 1.4` would get `Y_D = binomial(1, q_late)` — a non-zero but
heavily quantised draw. A cohort with `remaining = 12.3` would get
`Y_D = binomial(12, q_late)` — only marginally biased. The disambiguation
log (§"Disambiguation") includes counts/min/median/max of `remaining` and
`int(remaining)` so the actual distribution across cohorts in any given
trace is visible.

### Fix — use the continuous mean

```
remaining = max(N_i - k_i, 0.0)
...
Y_D = remaining * q_late          # (S, T) per-draw mean Pop D contribution
```

Justification:

- **The values are expected masses, not integer people.** `N_i` and `k_i`
  are carrier-projected expected arrivals and conversions. Treating them as
  integer counts is a category error.
- **Pop C already uses mean arithmetic** (`Y_C = p × convolve(arrivals,
  span_cdf)`, line 757). Pop D should match.
- **Stochastic rounding adds noise without semantic benefit.** The
  underlying expected mass already accounts for population uncertainty in
  the carrier projection upstream.

The fan / quantile structure is preserved because `Y_D` is still per-draw
`(S, T)` — `q_late` varies per draw via `p_i`, so quantiles across draws
still represent posterior uncertainty.

### RNG parity break — must be addressed alongside

`_evaluate_cohort` consumes `loop_rng` sequentially per cohort (drift
normal, then Pop D binomial). Removing the binomial removes one consumption
per cohort, so every later cohort's drift draw shifts. Quantile values
across cohorts will move slightly even on inputs Defect 1 doesn't directly
affect.

Three handling options:

1. **Accept the parity break and re-baseline.** Anchoring RNG parity to a
   known-broken binomial isn't worth preserving. **Recommended.**
2. **Separate drift RNG from Pop D RNG** — separate generator instance for
   drift so its draws no longer depend on Pop D consumption.
3. **Keep a no-op RNG consumption** — `_ = loop_rng.binomial(...)` followed
   by the continuous-mean `Y_D`. Ugly transitional state if test
   re-baselining needs to be staged.

## Defect 2 — level confusion at the rate-conditioning seam

### What the current code does

`forecast_state.py:937-948` samples `p_draws` from the **predictive Beta**
`Beta(α_pred = 7.93, β_pred = 1.41)`. Width std ≈ 0.11. That width is the
Level 2 marginal — between-cohort-date dispersion (kappa).

`forecast_state.py:1094-1147` then runs **joint** importance sampling: for
each cohort, accumulate a per-cohort log-likelihood
`k_i · log p + E_fail · log(1 - p)` into a *single* shared `log_lik`
vector, then resample particles once at the end. The shape — all cohorts
evaluated against the same `p` per draw, summed — is the Level 1 /
shared-rate likelihood.

The output is then aggregated to Level 3 (`rate_draws[s, τ]` is
`Σ_d Y_d[s, τ] / Σ_d X_d[s, τ]`) for the chart.

So:
- **Width** is Level 2 ("dates vary").
- **Likelihood shape** is Level 1 ("there is one shared rate").
- **Reported output** is Level 3 ("the group's rate").

These are three different statistical objects glued into one calculation.

### Why it produces the wrong answer

The hierarchical model has cohorts at Level 2, drawn from a Level 1
hyperprior, aggregated to Level 3 for the chart. A defensible solve looks
like this:

1. Each cohort `d` has its own latent rate `p_d ~ Beta(α_pop, β_pop)`
   (Level 2).
2. Hyperprior on `(α_pop, β_pop)` summarises historical Level 1 evidence
   — long-run belief about per-user rates and their date-to-date scatter.
3. Evidence `(k_d, n_d, a_d)` per cohort updates `p_d`'s posterior given
   the hyperprior. Sharing strength across cohorts updates the hyperprior
   posterior too.
4. Per particle `s`, draw per-cohort `(p_d, μ_d, σ_d, onset_d)_d`,
   project per-cohort `(Y_d[s, τ], X_d[s, τ])`, sum across `d` to form
   the per-particle group trajectory `rate_draws[s, τ]`.
5. Chart reads quantiles across `s`. Level 3 dispersion, properly
   composed.

The current code does not draw per-cohort latents. It draws one shared
`(p, μ, σ, onset)` per particle and applies that same vector to every
cohort, then accumulates a likelihood that pretends cohorts share — but
sized as if they don't. That's not a Level 2 hierarchical solve; it's a
Level 1 solve with the wrong width.

The visible consequence depends on data:
- Homogeneous cohorts (kappa-effects small, observed `k_d/n_d` similar
  across `d`): Level 1 and Level 2 give similar answers; the mismatch
  doesn't visibly bite.
- Heterogeneous cohorts or strong systematic departure from the Level 1
  prior: the joint likelihood collapses the wide Level 2 prior onto
  whatever the cohorts collectively show, producing a posterior that's
  far from the long-run rate the historical α / β encode.

### Proposed fix shape — hierarchical Level 2 / Level 3

Per particle `s`:

1. Draw hyperparameters `(α_pop, β_pop, μ_pop, σ_pop)_s` from the
   appropriate prior. (For an Empirical-Bayes-style approximation, fix
   these at the analytic `(α, β)` and analytic latency means — i.e. don't
   sample at the hyperprior level. This is a tractable shortcut and
   probably enough for the chart's purposes.)
2. For each cohort `d`, draw per-cohort latents from the hyperprior:
   `p_d ~ Beta(α_pop, β_pop)`, latency similarly. Apply each cohort's
   evidence as a per-cohort posterior update (closed-form Beta update
   for `p_d`).
3. Project per-cohort `(Y_d[s, τ], X_d[s, τ])` using `(p_d, μ_d, σ_d,
   onset_d)_s`.
4. `rate_draws[s, τ] = Σ_d Y_d[s, τ] / Σ_d X_d[s, τ]`.

This is consistent with what the chart reports (Level 3 group trajectory)
and respects the kappa width (each cohort gets its own rate, drawn from a
distribution wide enough to allow real between-date variation). It is also
what makes the cross-mode `p_infinity_mean` anchor-independence test pass
*by construction* on the same edge population — both modes integrate over
the same Level 2 latents and produce the same Level 3 aggregate.

The existing two-pass IS structure (conditioned + unconditioned, blended
per doc 52) can be preserved within this hierarchical shape — the
unconditioned pass uses the unconditioned hyperprior; the conditioned pass
uses per-cohort posteriors.

### Why this isn't "Option A vs Option B"

Earlier revisions framed the fix as "swap predictive for epistemic"
(Option A) or "do per-cohort IS keeping predictive" (Option B). Both
preserved the assumption that there's one shared `p` per particle —
i.e. they stayed at Level 1. Per-cohort IS was an attempt to side-step
the issue without committing to a hierarchical solve. Neither is the
honest answer. The honest answer is a Level 2 hierarchical model
aggregated to Level 3.

In particular, **Option A would have suppressed legitimate current-cohort
evidence** (the tight epistemic prior overrides recent variation). It
should not be used even as a stopgap.

A proper hierarchical solve — even an Empirical-Bayes-style approximation
with fixed `(α, β)` hyperprior and closed-form per-cohort updates — is
both more honest and not dramatically more code than per-cohort IS would
have been.

## Internal inconsistency — `p_infinity_mean` source conflation

In `cohort_forecast_v3.py` around lines 1304-1308:

```
if sweep.p_draws is not None and sweep.p_draws.size:
    _asymp_draws = sweep.p_draws
else:
    _asymp_draws = sweep.rate_draws[:, min(saturation_tau, t - 1)]
_p_infinity_mean = float(np.median(_asymp_draws))
```

When `sweep.p_draws` is populated, `p_infinity_mean` reports the rate
*parameter* posterior median (Level 1 / 2). When it's not, it falls back
to the trajectory aggregate at saturation (Level 3). The chart's
`midpoint` curve unconditionally reads `rate_draws[:, τ]` (Level 3).

**These are different statistical objects.** The doc-comment block
preceding this code acknowledges the divergence ("the trajectory's
saturation rate collapses to raw Σy_frozen/Σx_frozen whenever every
cohort is mature"). But the field's *contract* — what the user thinks
they're reading — should be one consistent thing.

For the chart, Level 3 is the right contract: midpoint, dispersion bands,
and `p_infinity_mean` should all describe the group's posterior aggregate
trajectory. This matches how the model spark charts already report
`p.epist` and `p.forecast` ("best guess of an actual conversion journey
on this edge"); the cohort maturity chart's contract should mirror it.

### Fix

Change `_asymp_draws` to *unconditionally* read
`rate_draws[:, saturation_tau]`. Drop the `sweep.p_draws` branch. Update
the comment block to reflect the Level-3 contract.

Small, isolated, no model-shape implications. Can land alongside Defect 1
without waiting on Defect 2.

## Disambiguation — what to instrument before any fix

We need to know which defects are dominant before committing model-shape
changes. The instrumentation is cheap and reproducible against the `cf 1`
/ `cf 2` capture.

1. **Make the cohort-mode forensic survive.** Today
   `forecast_state.py:1547-1549` writes to `/tmp/v3_forensic.json` on every
   sweep call, so the last sweep wins — typically the window scenario,
   which doesn't IS-condition. Either (a) include the sweep's `mode` and
   `n_cohorts` in the filename, or (b) append rather than overwrite. Then
   re-run with `cf` marks and read the cohort-mode `f14_is.pre_IS_p_median`
   and `post_IS_p_median` directly.

2. **Print Pop D internals per cohort.** Add to the existing per-cohort
   `[v3-debug] cohort` log line: `remaining` (the unrounded `N_i − k_i`),
   `int(remaining)`, `q_late_max_med`, `Y_D_max_med`, `Y_C_max_med`,
   `Y_forecast_max_med`.

3. **Aggregate summary across cohorts.** Add a single line per sweep:
   `count_with_remaining_lt_1`, `count_with_int_remaining_zero`, plus
   `min/median/max` of both `remaining` and `int(remaining)`. Makes the
   trace's actual distribution visible.

After (1)–(3):

- If `Y_D_max_med ≈ 0` for many cohorts and `q_late_max_med` is
  non-trivial: Defect 1 is confirmed in situ for that subset.
- If `post_IS_p_median ≈ 0.85` (unmoved from prior): the IS step did not
  collapse the rate parameter. Whatever's left to explain the visible
  plateau is explained by Defect 1, and Defect 2's *visible* effect is
  small or zero on this trace (though the seam-level structure is still
  wrong and worth fixing).
- If `post_IS_p_median ≈ 0.5`: Defect 2's level confusion is producing a
  visible rate-parameter collapse on top of (or instead of) Defect 1.

**Important sequencing note**: fixing Defect 1 will not move
`post_IS_p_median`. The IS likelihood is built from `cohort.evidence_n` and
`cohort.evidence_k` (`forecast_state.py:1073-1092`) before
`_evaluate_cohort` runs and does not depend on `Y_D`. Fixing Defect 1 will
move the visible chart midpoint via `rate_draws`, but not the rate
parameter posterior. After Defect 1 lands, re-read `midpoint` at large τ
and compare against the asymptote implied by the per-cohort posteriors.
If suppression remains, Defect 2's effect is visible.

## Sequencing

1. **Instrumentation first.** §"Disambiguation" — ships as a standalone
   change. No semantic risk.
2. **Defect 1 fix** (continuous-mean `Y_D`). Pick one of the three
   RNG-handling options. Re-baseline the v2/v3 parity test if needed; the
   outside-in suite's `p_infinity_mean` invariants do not depend on Pop D
   arithmetic (they read the trajectory at saturation, which Defect 1
   does affect, but the cross-mode invariant — anchor independence — is
   preserved by symmetry).
3. **`p_infinity_mean` source fix.** Drop the `sweep.p_draws` branch;
   read unconditionally from `rate_draws[:, saturation_tau]`. Small,
   isolated. Aligns the field with the Level 3 contract.
4. **Re-measure.** With (2) and (3) in, capture marks again. Read the
   chart and the cohort-mode forensic. Decide whether Defect 2 is
   producing a visible suppression.
5. **Defect 2 fix** (hierarchical Level 2 / Level 3 model), if (4)
   confirms it's needed. This is the largest of the four steps and
   needs prior alignment with whoever owns
   `COHORT_ANALYSIS_NUMERATOR_DENOMINATOR_SEMANTICS.md` and doc 49 — not
   because the math is contentious but because the implementation
   touches the rate-conditioning seam, which has wider consumers than
   just the cohort maturity chart.

## Contracts the fix must preserve

1. **Anchor independence at saturation.** For the same edge population,
   `p_infinity_mean` should be invariant under the choice of anchor —
   `window`, `cohort(X, …)`, `cohort(A, …)` for `A` upstream of `X`. The
   outside-in suite pins this within 1e-3 (modulo S=2000 IS noise floor).
2. **Anchor depth monotonicity.** Far-anchor `evidence_x` ≤ near-anchor
   ≤ identity ≤ window. Midpoints follow the same ordering. The
   outside-in suite pins this.
3. **Carrier-driven lag.** `cohort(A, …)` with latent upstream should
   show a midpoint trajectory that *lags* the window trajectory in
   epoch B but converges to the same `p_infinity_mean` at saturation.
   Already pinned in `test_single_hop_latent_upstream_lags_window_*`.
4. **Zero-evidence baseline.** Both surfaces (FE-only and CF) should
   return the prior mean on degenerate-zero evidence. Already pinned in
   `test_parity_zero_evidence_cohort_returns_prior`.
5. **Oracle parity.** Low-evidence and no-evidence cohort midpoints
   should match a factorised-convolution oracle within fixture-noise
   tolerance. Already pinned in
   `test_*_factorised_convolution_oracle` and
   `test_*_unconditioned_fw_convolution_midline`.

A hierarchical Level 2 / Level 3 fix preserves all five by construction.
Per-cohort IS *might* preserve them depending on aggregation rule. The
flat shared-`p` Level 1 approximation that's currently in place preserves
(1)–(4) on homogeneous synth fixtures by accident, and (5) only because
the oracles use the same flat approximation.

## Things we do not yet know

1. **Whether doc 49 actually mandates predictive draws into the
   IS-conditioned trajectory** or only into the unconditioned model fan.
   The comment at `forecast_state.py:937` reads as the former; my
   reading of doc 49 is the latter. If doc 49 *did* intend the former,
   that intention itself needs revisiting in light of this analysis.
2. **The right shape for hyperprior updates under per-cohort evidence.**
   Empirical-Bayes (fix the hyperprior at analytic α/β) is tractable;
   full-Bayesian hyperprior posteriors are correct but more work.
   Decision needs to come from whoever owns the semantics doc.
3. **Whether other `int(...)`-on-fractional-mass sites exist** in the
   cohort loop. Sweep recommended as part of the Defect 1 change set.

## Decision points — open

1. **RNG-parity handling for Defect 1.** Accept-and-rebaseline (preferred)
   vs separate-drift-stream vs no-op consumption.
2. **Empirical-Bayes vs full-Bayesian hierarchical solve for Defect 2.**
3. **Doc 49 intent.** Resolution before Defect 2 lands, or after?
4. **Whether the `p_infinity_mean` source fix should ship with Defect 1
   or as a separate change.** Both are small; bundling reduces churn but
   also bundles two distinct contract changes.

## Glossary

- **Level 1 / per-user `p`**: per-user Bernoulli rate.
- **Level 2 / per-cohort-date `p_d`**: rate for one anchor day, drawn
  from `Beta(α_pop, β_pop)`. Width = kappa.
- **Level 3 / per-cohort-group `p_group(τ)`**: aggregate
  `Σ_d Y_d(τ) / Σ_d X_d(τ)` across the cohort dates in the queried
  group. Derived; not a primitive parameter.
- **`α, β` (epistemic posterior)**: Level 1 posterior on the underlying
  per-user rate.
- **`α_pred, β_pred` (predictive Beta)**: Level 2 marginal — fresh
  cohort date's rate, accounting for kappa.
- **`p_draws` (sweep field)**: per-particle Level-1/2 rate draws. The
  joint shared `p` per particle in the current code.
- **`rate_draws[s, τ]`**: per-particle Level-3 group trajectory.
- **`p_conditioning_evidence` / "the seam"**: the named site in the
  runtime bundle that selects which evidence family is allowed to move
  the rate posterior.
- **Pop C, Pop D**: Pop D = frontier survivors at `X` not yet at `Y`;
  Pop C = future arrivals to `X` after the frontier.
- **Carrier `A → X`**: in factorised representation, the upstream
  half. Collapses to identity when `A = X`.
