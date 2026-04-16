# D20: Weak prior in forecast sweep allows IS conditioning to overwhelm

**Date**: 16-Apr-26
**Status**: Open.
**Severity**: High for per-cohort consumers (daily conversions).
Lower for aggregate consumers (cohort maturity chart, topo pass)
where many cohorts stabilise the IS.
**Affects**: `compute_forecast_sweep` (line 1041) and
`compute_conditioned_forecast` (line 497) in `forecast_state.py`.

---

## Problem

When `resolved.alpha` and `resolved.beta` are not available (the
common case for `analytic_be` model source, which provides p_mean
but no posterior concentration), the engine constructs a fallback
prior for the MC p draws:

- `compute_forecast_sweep`: `Beta(1, 1)` — flat, uninformative.
  Equivalent to 2 trials of information.
- `compute_conditioned_forecast`: `Beta(p×20, (1-p)×20)` — weak
  informative. Equivalent to 20 trials.

IS conditioning then resamples these draws against per-cohort
evidence. A single cohort with n=1247 trials and k=56 successions
at 9% maturity has ~50× the information of the kappa=20 prior and
~600× the flat prior. The IS overwhelms the prior completely,
shifting the posterior from p_mean=10% to ~50%.

## Why this matters for daily conversions

Daily conversions evaluates individual cohorts independently (one
`CohortEvidence` per anchor_day with `eval_age`). A single young
cohort with slightly above-expected evidence swings the posterior
wildly because the prior offers no resistance.

Cohort maturity and the topo pass aggregate many cohorts — the IS
conditioning is more stable because individual cohort noise averages
out. The problem is specific to per-cohort evaluation with a weak
prior.

## Why the prior is weak

The `analytic_be` model source computes p from FE data (n-weighted
mean of observed rates across param file cohorts). It stores
`p_mean` but not `alpha`/`beta` — the concentration parameter is
lost. The `bayesian` source stores full posterior `(alpha, beta)`
from MCMC, which encodes thousands of observations.

The resolver (`resolve_model_params`) returns `alpha=None`,
`beta=None` for analytic sources. The sweep falls back to
`Beta(1, 1)`.

## What the prior should be

The prior should reflect how much information went into estimating
p_mean. For `analytic_be`, that's the total n across all cohorts
in the param file — typically thousands. A Beta prior with
`kappa = total_n` (or a fraction thereof to account for
autocorrelation) would resist individual-cohort IS appropriately.

Options:

**A. Resolver emits kappa for analytic sources.** The resolver
already reads the param file. It could compute `total_n` from the
cohort data and return `alpha = p_mean × total_n`,
`beta = (1-p_mean) × total_n`. This is the cleanest — the prior
strength reflects the actual evidence base.

**B. Sweep infers kappa from cohort_data.** The sweep receives
`CohortEvidence` objects with `x_frozen` (n per cohort). It could
sum these as a proxy for the evidence base. But this conflates the
conditioning cohorts with the prior — conceptually wrong (the
prior should reflect ALL evidence, the conditioning should use
only the scoped cohorts).

**C. FE sends n_baseline.** The FE already computes `n_baseline`
from window slices (used in edge_contexts). This could be used as
the kappa for the prior. But it's not always available and
conflates window/cohort scoping.

**Recommended: Option A.** The resolver already touches the model
source data. Adding kappa derivation there keeps the prior
construction close to the evidence base, and all consumers get it
automatically via `resolved.alpha` / `resolved.beta`.

## Where to fix

1. `runner/model_resolver.py` — `resolve_model_params` should
   compute `alpha`/`beta` from `p_mean` and total evidence n when
   the source is analytic. The total n is available from the edge's
   param data (or from the topo pass's `cohort_data`).

2. `forecast_state.py` lines 1041–1042 — remove the `Beta(1, 1)`
   fallback. If alpha/beta are always provided by the resolver, the
   fallback never fires. Keep a sensible fallback (e.g.
   `kappa = 100`) as a safety net, not as the normal path.

3. `forecast_state.py` lines 497–504 — same fix for
   `compute_conditioned_forecast` (surprise gauge path). Remove
   `_KAPPA_DEFAULT = 20` and use resolver-provided alpha/beta.

## Files touched

- `runner/model_resolver.py` — derive alpha/beta from p_mean + n
- `runner/forecast_state.py` — remove weak fallback priors
- `lib/api_handlers.py` — may need to pass n_total to resolver if
  not available on the edge

## Verification

- Daily conversions per-cohort: conditioned rate should stay within
  a reasonable range of p_mean, not swing to 50% on one cohort
- Topo pass: `blended_mean` should not change materially (alpha/beta
  already available for bayesian edges; analytic edges get a stronger
  prior)
- v2-v3 parity: unaffected (this changes engine behaviour, not v3
  row building)
