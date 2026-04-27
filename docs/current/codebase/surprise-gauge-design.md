# Surprise Gauge Analysis Type

**Status**: Doc 55 rework — thin projection of `compute_forecast_summary`
**Date**: 20-Apr-26 (rework); Phase-1/2 history below
**Authority**: [doc 55 in project-bayes](../project-bayes/55-surprise-gauge-rework.md)
is the design doc of record. This file is the codebase-level reference.

---

## 1. Purpose

Shows whether current evidence for an edge is surprising given the
Bayesian posterior and query context (window / cohort plus anchor
range). Two variables:

- **p** — observed aggregate conversion rate vs. unconditioned
  posterior-predictive expected rate at current maturity.
- **completeness** — model's prior-mean maturity vs. the same after
  conditioning on the window's cohort evidence.

Both are single-number z-score projections of scalars from the same
CF engine invocation. The gauge owns no statistics of its own.

---

## 2. Layouts

### 2.1 Single var, single scenario — Semicircular dial

Needle points to conditioned / observed value. Coloured arcs show
confidence zones around the unconditioned / expected mean.

### 2.2 One var, multiple scenarios — Horizontal band stack

Each row is a scenario. Bands on a **shared real axis** (same units),
shifted to each scenario's expected mean. Dot marks observed value.

### 2.3 One scenario, multiple vars — Horizontal band stack

Each row is a variable. Bands individually centred on each variable's
expected value. Axis normalised (linear in σ, labelled in percentiles).

### 2.4 Fallback when the requested variable is unavailable

If the user-selected variable (`p` or `completeness`) is unavailable
for the current subject, the builder renders the dial of whichever
variable *is* available. Bands are only used when two or more variables
are available simultaneously (the "all" setting, or an unexpanded
pair). Avoids a degenerate one-row band. See
`buildSurpriseGaugeEChartsOption` in `surpriseGaugeBuilder.ts`.

---

## 3. Colour scheme

Symmetric (R-A-G-A-R) by default; directional-positive and
directional-negative schemes available. Same scheme for dial arcs and
band fills. Zone classification from |σ| regardless of scheme.

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

Two. Both produced by the BE handler from a single call to
`compute_forecast_summary`. No other variables. μ, σ, onset descoped
per doc 55 §2.5.

| Variable | Expected (dial) | Observed (needle) | z |
|----------|-----------------|-------------------|---|
| **p** | `pp_rate_unconditioned ± pp_rate_unconditioned_sd` | `Σk / Σn` over the cohorts the CF call consumed | `(Σk/Σn − pp_rate_unconditioned) / pp_rate_unconditioned_sd` |
| **completeness** | `completeness_unconditioned ± completeness_unconditioned_sd` | `completeness` (i.e. `completeness_conditioned`) | `(completeness − completeness_unconditioned) / completeness_unconditioned_sd` |

All four `pp_rate_unconditioned*` / `completeness_unconditioned*`
scalars are fields on `ForecastSummary` (see `forecast_state.py`),
populated by `compute_forecast_summary` from its already-computed
unconditioned draws; the gauge does not recompute them.

The p variable's draws come from the **predictive** alpha/beta
(kappa-inflated per doc 49) inside the CF engine. The gauge asks
whether the observed aggregate is a plausible realisation the model
would generate — requiring observation-noise-inflated draws.

---

## 5. Data flow

1. FE builds an analysis request for `surprise_gauge` with current
   scenario graph, analytics DSL (`from(…).to(…)`), and query DSL
   (window / cohort + anchor dates + slice keys).
2. BE resolves the subject via the standard resolver
   (`analysis_subject_resolution`, doc 31), yielding a snapshot query
   with `anchor_from`, `anchor_to`, `param_id`, `core_hash`, `slice_keys`.
3. `_compute_surprise_gauge` (in `api_handlers.py`) runs the snapshot
   query, derives cohort maturity frames, extracts per-cohort
   `(age, n, k)` tuples, and — in cohort mode — builds an upstream
   node arrival cache for carrier convolution.
4. `compute_forecast_summary` is called with resolved params, cohort
   ages / weights, and evidence tuples. Returns a `ForecastSummary`
   with conditioned and unconditioned draws plus the four scalar
   fields the gauge projects.
5. Gauge handler computes `Σk, Σn` from the same evidence list it
   passed in, divides to get `obs_rate`, computes the two z-scores
   and quantiles from the summary scalars, returns
   `{variables: [p_var, completeness_var]}`.
6. FE renders the selected variable through the gauge builder
   (`surpriseGaugeBuilder.ts`).

FE performs no local gauge computation. The frontend local-compute
path for `surprise_gauge` was removed in the doc-55 rework;
`LOCAL_COMPUTE_TYPES` no longer contains it.

---

## 6. Failure modes

A variable is marked `available: false` with a stated reason when:

- `resolve_model_params` returns nothing usable for current scope /
  temporal mode (or `σ ≤ 0`).
- Required subject fields (`param_id`, `core_hash`, `anchor_from`,
  `anchor_to`) are missing.
- Snapshot query returns no rows.
- Cohort frames derive to empty.
- No valid `(age, n, k)` cohorts remain after filtering.
- `compute_forecast_summary` raises.
- For `p`: `pp_rate_unconditioned_sd` effectively zero (degenerate
  posterior — nothing can be surprising).
- For `completeness`: `completeness_unconditioned_sd` effectively zero
  (same reason).

Low importance-sampling ESS is **not** a failure mode, and no warning
is surfaced for it: with `_IS_TARGET_ESS = 20` enforced inside
`compute_forecast_summary`, low post-tempering ESS signals strong
prior–evidence divergence (the gauge's whole point), not sparse data.
An earlier "limited evidence" warning was removed because the metric
was a sampling-quality diagnostic, not an evidence-quantity one, so
it fired precisely when the surprise signal was strongest.

No analytic fallback, no method-of-moments reconstruction. If the
engine cannot run, the gauge says so. Previous designs had Phase-1
analytic formulas for `p`, `μ`, `σ` — all removed.

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
persists the necessary scalars on-edge.

---

## 8. Design principles (preserved from earlier versions)

1. **All gauge computation in BE.** FE renders what it's given.
2. **Evidence-only comparison.** Gauge never uses the blended `p.mean`
   scalar. Observed side for `p` is aggregated raw counts;
   `completeness` has no observed side (comparison is between two
   posterior views).
3. **Window-aware by construction.** Window-vs-cohort intent captured
   by `resolve_model_params(scope, temporal_mode)`, which picks the
   right posterior slice and triggers carrier convolution in cohort
   mode. Gauge itself contains no cohort-vs-window branch.
4. **Observed and expected from one source.** Both derived from the
   cohort list `compute_forecast_summary` consumes.
5. **Guard rails.** Zero posterior-predictive SD → variable
   unavailable. No snapshot rows → variable unavailable. No ad-hoc
   fallbacks. Low IS ESS not surfaced as a warning — see §6.
6. **Linear-in-σ axis, percentile labels.** Uniform visual spacing,
   familiar units.

---

## 9. History

- **24-Mar-26**: Initial Phase 1 proposal. Analytic formulas for `p`,
  `μ`, `σ` computed on FE from parameter-file scalars.
- **27-Mar-26**: Phase 1 revised to use completeness-adjusted normal
  approx for `p`; `μ`/`σ` combined-SD normal (§5.2 in old doc).
- **16-Apr-26**: Phase 2 adds engine-backed posterior-predictive path
  for `p` via `_surprise_gauge_engine_p`, coexisting with the Phase-1
  analytic fallback.
- **20-Apr-26**: Doc 55 rework. All analytic paths removed. Gauge is
  a thin projection of `compute_forecast_summary`. Variables contracted
  to `p` and `completeness`. μ, σ, onset descoped. Limited-evidence
  warning briefly introduced then removed the same day after proving
  a sampling-quality diagnostic rather than evidence-quantity one
  (§6). Single-variable fallback added: when the selected variable
  is unavailable but another is, the dial of the available variable
  is shown instead of a one-row band (§2.4). Completeness label (not
  "Maturity") throughout. Current shape.

Earlier Phase-1 / Phase-2 formulas and mu/sigma derivations are not
reproduced here — deleted from the codebase. For historical reference,
see this file's git history prior to 20-Apr-26.
