# Surprise Gauge Analysis Type

**Status**: Doc 55 rework — thin projection of `compute_forecast_summary`
**Date**: 20-Apr-26 (rework); Phase-1/2 history below
**Authority**: [doc 55 in project-bayes](../project-bayes/55-surprise-gauge-rework.md)
 is the design doc of record. This file is the codebase-level reference
for consumers and is written to reflect the post-rework shape.

---

## 1. Purpose

Shows at a glance whether current evidence for an edge is surprising
given the Bayesian posterior and the current query context
(window / cohort plus anchor range). Two variables:

- **p** — observed aggregate conversion rate vs. the unconditioned
  posterior-predictive expected rate at current maturity.
- **completeness** — the model's prior-mean maturity vs. the same
  quantity after conditioning on the window's cohort evidence.

Both are single-number z-score projections of scalars returned by the
same CF engine invocation. The gauge owns no statistics of its own.

---

## 2. Layouts

### 2.1 Single var, single scenario — Semicircular dial

Needle points to the conditioned / observed value. Coloured arcs
show confidence zones around the unconditioned / expected mean.

### 2.2 One var, multiple scenarios — Horizontal band stack

Each row is a scenario. Bands are on a **shared real axis** (same
units), shifted left/right to each scenario's expected mean. A dot
marks the observed value.

### 2.3 One scenario, multiple vars — Horizontal band stack

Each row is a variable. Bands are individually centred on each
variable's expected value. Axis is normalised (linear in σ, labelled
in percentiles).

### 2.4 Fallback when the requested variable is unavailable

If the user-selected variable (`p` or `completeness`) is not
available for the current subject, the builder renders the dial of
whichever variable *is* available. Bands are only used when two or
more variables are available simultaneously (i.e. the "all" setting,
or an unexpanded pair). This avoids a one-row band chart, which
looked degenerate. See `buildSurpriseGaugeEChartsOption` in
`surpriseGaugeBuilder.ts`.

---

## 3. Colour scheme

Symmetric (R-A-G-A-R) by default; directional-positive and
directional-negative schemes available. Same scheme for dial arcs
and band fills. Zone classification is from |σ| regardless of scheme.

| Zone | Percentile range | σ range | Colour | Meaning |
|------|-----------------|---------|--------|---------|
| Centre | 20th–80th | 0–1.28σ | Green | Expected |
| Inner | 10th–20th / 80th–90th | 1.28–1.64σ | Yellow | Noteworthy |
| Mid | 5th–10th / 90th–95th | 1.64–1.96σ | Amber | Unusual |
| Outer | 1st–5th / 95th–99th | 1.96–2.58σ | Red | Surprising |
| Tail | <1st / >99th | >2.58σ | Dark red | Alarming |

Axis is linear in σ, tick labels in percentiles (50, 80, 90, 95, 99).

---

## 4. Variables

Two. Both produced by the backend handler from a single call to
`compute_forecast_summary`. There are no other variables. μ, σ,
and onset have been explicitly descoped per doc 55 §2.5.

| Variable | Expected (dial) | Observed (needle) | z |
|----------|-----------------|-------------------|---|
| **p** | `pp_rate_unconditioned ± pp_rate_unconditioned_sd` | `Σk / Σn` over the cohorts the CF call consumed | `(Σk/Σn − pp_rate_unconditioned) / pp_rate_unconditioned_sd` |
| **completeness** | `completeness_unconditioned ± completeness_unconditioned_sd` | `completeness` (i.e. `completeness_conditioned`) | `(completeness − completeness_unconditioned) / completeness_unconditioned_sd` |

All four `pp_rate_unconditioned*` / `completeness_unconditioned*`
scalars are fields on `ForecastSummary` (see `forecast_state.py`).
They are populated by `compute_forecast_summary` from its
already-computed unconditioned draws; the gauge does not recompute
them.

The p variable's draws are taken from the **predictive** alpha/beta
(kappa-inflated per doc 49) inside the CF engine. The gauge asks
whether the observed aggregate is a plausible realisation the model
would generate, which requires observation-noise-inflated draws.

---

## 5. Data flow

1. The FE builds an analysis request for the `surprise_gauge` type
   with the current scenario graph, analytics DSL (`from(…).to(…)`),
   and query DSL (window / cohort + anchor dates + slice keys).
2. The BE resolves the subject via the standard subject resolver
   (`analysis_subject_resolution`, doc 31), yielding a snapshot
   query with the correct `anchor_from`, `anchor_to`, `param_id`,
   `core_hash`, and `slice_keys`.
3. `_compute_surprise_gauge` (in `api_handlers.py`) runs the
   snapshot query, derives cohort maturity frames, extracts per-cohort
   `(age, n, k)` tuples, and — in cohort mode — builds an upstream
   node arrival cache for carrier convolution.
4. `compute_forecast_summary` is called with the resolved params,
   cohort ages / weights, and evidence tuples. It returns a
   `ForecastSummary` with the conditioned and unconditioned draws,
   along with the four scalar fields the gauge projects.
5. The gauge handler computes `Σk, Σn` from the same evidence list
   it passed in, divides to get `obs_rate`, computes the two z-scores
   and quantiles from the summary scalars, and returns
   `{variables: [p_var, completeness_var]}`.
6. The FE renders the selected variable through the gauge builder
   (`surpriseGaugeBuilder.ts`).

The FE does not perform any local gauge computation. The frontend
local-compute path for `surprise_gauge` was removed in the doc-55
rework; `LOCAL_COMPUTE_TYPES` no longer contains it.

---

## 6. Failure modes

A variable is marked `available: false` with a stated reason when
any of the following hold:

- `resolve_model_params` returns nothing usable for the current
  scope / temporal mode (or `σ ≤ 0`).
- Required subject fields (`param_id`, `core_hash`, `anchor_from`,
  `anchor_to`) are missing.
- The snapshot query returns no rows.
- Cohort frames derive to empty.
- No valid `(age, n, k)` cohorts remain after filtering.
- `compute_forecast_summary` raises.
- For `p`: `pp_rate_unconditioned_sd` is effectively zero
  (degenerate posterior — nothing can be surprising).
- For `completeness`: `completeness_unconditioned_sd` is effectively
  zero (same reason).

Low importance-sampling ESS is **not** a failure mode. There is no
warning surfaced for it either: with `_IS_TARGET_ESS = 20` enforced
inside `compute_forecast_summary`, a low post-tempering ESS signals
strong prior–evidence divergence (the gauge's whole point), not
sparse data. An earlier "limited evidence" warning was removed
because the metric was a sampling-quality diagnostic, not an
evidence-quantity one, and so it tended to fire precisely when the
surprise signal was strongest.

There is no analytic fallback, no method-of-moments reconstruction.
If the engine cannot run, the gauge says so. Previous designs had
Phase-1 analytic formulas for `p`, `μ`, and `σ` — those are all
removed.

---

## 7. Analysis type registration

```
id: 'surprise_gauge'
name: 'Expectation Gauge'
shortDescription: 'How surprising is current evidence given the Bayesian posterior'
icon: Gauge
snapshotContract: {
  scopeRule: 'funnel_path',
  readMode: 'none',
  slicePolicy: 'mece_fulfilment_allowed',
  timeBoundsSource: 'query_dsl_window',
  perScenario: true,
}
cf_dependency: 'none' (interim per doc 55 / doc 54 §8)
```

The gauge calls `compute_forecast_summary` inline for its own subject.
It does not consume on-edge CF scalars. A Tier-2 cut-over (doc 55
§4.6, doc 54 §8.1) would change that once the whole-graph CF pass
persists the necessary scalars on the edge.

---

## 8. Design principles (preserved from earlier versions)

1. **All gauge computation in the BE.** The FE renders what it's given.
2. **Evidence-only comparison.** The gauge never uses the blended
   `p.mean` scalar. The observed side for `p` is aggregated raw
   counts; `completeness` has no observed side (the comparison is
   between two posterior views).
3. **Window-aware by construction.** Window-vs-cohort intent is
   captured by `resolve_model_params(scope, temporal_mode)`, which
   picks the right posterior slice and triggers carrier convolution
   in cohort mode. The gauge itself contains no cohort-vs-window
   branch.
4. **Observed and expected come from one source.** Both are derived
   from the cohort list that `compute_forecast_summary` consumes.
5. **Guard rails.** Zero posterior-predictive SD → variable
   unavailable. No snapshot rows → variable unavailable. No ad-hoc
   fallbacks. Low IS ESS is not surfaced as a warning — see §6.
6. **Linear-in-σ axis, percentile labels.** Uniform visual spacing,
   familiar units.

---

## 9. History

- **24-Mar-26**: Initial Phase 1 proposal. Analytic formulas for
  `p`, `μ`, `σ` computed on the FE from parameter-file scalars.
- **27-Mar-26**: Phase 1 revised to use completeness-adjusted normal
  approx for `p`; `μ`/`σ` combined-SD normal (§5.2 in the old doc).
- **16-Apr-26**: Phase 2 adds an engine-backed posterior-predictive
  path for `p` via `_surprise_gauge_engine_p`, coexisting with the
  Phase-1 analytic fallback.
- **20-Apr-26**: Doc 55 rework. All analytic paths removed. Gauge
  is a thin projection of `compute_forecast_summary`. Variables
  contracted to `p` and `completeness`. μ, σ, onset descoped.
  Limited-evidence warning was briefly introduced then removed the
  same day after it proved to be a sampling-quality diagnostic
  rather than an evidence-quantity one (§6). Single-variable fallback
  added: when the selected variable is unavailable but another is,
  the dial of the available variable is shown instead of a one-row
  band (§2.4). Completeness label (not "Maturity") throughout.
  This is the current shape.

Earlier Phase-1 / Phase-2 formulas and mu/sigma derivations are not
reproduced here because they are deleted from the codebase. If
needed for historical reference, see the git history of this file
prior to 20-Apr-26.
