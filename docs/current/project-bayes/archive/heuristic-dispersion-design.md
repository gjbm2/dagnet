# Heuristic Dispersion Estimation for the Non-Bayes Stats Pass

> **SUPERSEDED — 28-Apr-26.** Superseded by
> [`docs/current/codebase/EPISTEMIC_DISPERSION_DESIGN.md`](../../codebase/EPISTEMIC_DISPERSION_DESIGN.md).
> The `1.25 × σ / √N` location-SD formula in §3.2 is the asymptotic
> variance of the **sample-median** estimator, not the maximum-likelihood
> estimator, and the qualityInflation, drift-fraction, and floor
> corrections layered on top compounded the error. The replacement
> proposal uses the Student-t / scaled inverse chi-squared posterior
> under a Jeffreys prior with an interval-matched effective SD for the
> downstream Gaussian-shaped consumer interface. This document is
> retained for historical context and to explain the provenance of
> dispersion values in fixtures generated under the old method.

**Status:** Superseded — see banner above
**Date:** 2-Apr-26
**Depends on:** Stats pass consolidation (FE/BE parity)

---

## 1. Problem

The analytic stats pass produces point estimates (mu, sigma, onset, p)
with no uncertainty. Downstream consumers — CohortMaturity fan chart,
confidence bands, model curve bands — need standard deviations to
generate uncertainty envelopes. Today, only the Bayesian pipeline
provides these. Without Bayes, the fan chart is either absent or
zero-width, implying false certainty.

**Goal:** Add mathematically grounded heuristic SDs to the stats pass
output so that every edge with a fitted model produces uncertainty
estimates. When Bayes runs, its posterior SDs replace these entirely.

---

## 2. Available Information at Estimation Time

After `computeEdgeLatencyStats` / `compute_edge_latency_stats` completes,
the following data is available:

| Known | Source | Notes |
|-------|--------|-------|
| mu (log-normal location) | Method of moments: `ln(median_lag)` | |
| sigma (log-normal scale) | Method of moments: `sqrt(2 * ln(mean/median))` | Falls back to default (0.5) when mean unavailable |
| onset_delta_days | Derived from data (D2 weighted quantile) or user-set | |
| p_infinity (asymptotic rate) | Recency-weighted k/n from mature cohorts | `undefined` if no mature cohorts |
| p_evidence (raw k/n) | Direct from cohort data | |
| totalK | Sum of k_i across all cohorts | Number of converters (drives lag fit) |
| totalN | Sum of n_i across all cohorts | Total cohort population |
| Per-cohort n_i, k_i, age_i | Input cohort data | |
| Mature cohort count | count where age_i >= t95 | 0 if no cohort has reached t95 |
| empirical_quality_ok | Fit quality gate result | False if totalK < 30, bad ratio, etc. |
| sigma_moments vs sigma_final | Pre/post tail-constraint sigma | Indicates whether t95 constraint widened sigma |
| tail_constraint_applied | Boolean | Whether improvement increased sigma |

**Not available:** residuals, cross-validation, bootstrap CIs, per-cohort
lag variance, goodness-of-fit metrics (R^2, AIC).

---

## 3. Proposed Heuristic SDs

### 3.1 Rate uncertainty: `p_sd`

**Derivation:** Beta-binomial posterior standard deviation.

The observed data gives k converters out of n trials. With a weakly
informative Beta(1, 1) prior (uniform on [0, 1]), the posterior is
Beta(alpha, beta) where:

```
alpha = k + 1
beta  = n - k + 1
```

The posterior SD is:

```
p_sd = sqrt( alpha * beta / ((alpha + beta)^2 * (alpha + beta + 1)) )
```

**Which k and n to use:** If `p_infinity` was estimated from mature
cohorts (i.e. `forecast_available = true`), use the recency-weighted
effective sample size from the `estimatePInfinity` computation. This
means the SD reflects the actual basis for the rate estimate, not the
full population which may include immature cohorts.

If `p_infinity` is unavailable (no mature cohorts), use totalK and
totalN directly. The wider SD is appropriate — the rate estimate itself
is less certain.

**Floor:** When totalK < 30 (fit quality gate fails), apply
`p_sd = max(computed_sd, 0.10)`. This prevents overconfidence from
tiny samples that happen to land near the true rate.

**Properties:**
- Large samples -> small SD (scales as ~1/sqrt(n))
- Extreme p (near 0 or 1) -> smaller SD than p near 0.5
- n=100, p=0.5: SD ~ 0.049
- n=10000, p=0.5: SD ~ 0.005
- Reduces to the exact Bayesian posterior SD when the prior is flat
- Consistent with the Bayesian pipeline's posterior_alpha/posterior_beta

### 3.2 Latency location uncertainty: `mu_sd`

**Derivation:** Sampling distribution of the log-median.

mu is estimated as `ln(median_lag)` from the aggregate of totalK
converters. For a log-normal(mu, sigma) distribution, the sample
median has approximate variance:

```
Var(sample_median) ~ (pi/2) * sigma^2 / n_lag
```

where n_lag = totalK (the number of converters contributing lag
observations). Since mu = ln(median), by the delta method:

```
Var(mu_hat) ~ Var(median) / median^2
            = (pi/2) * sigma^2 / (n_lag * exp(2*mu))
```

In log-space this simplifies (because Var(ln(X)) ~ Var(X)/E[X]^2 for
concentrated distributions):

```
mu_sd = sigma * sqrt(pi / (2 * n_lag))
      ~ 1.25 * sigma / sqrt(totalK)
```

**Floor:** 0.02 (prevents false precision with very large samples where
the method-of-moments approximation breaks down).

**Properties:**
- Scales as 1/sqrt(totalK) — more converters -> tighter mu
- Proportional to sigma — higher dispersion -> less certain location
- sigma=0.5, totalK=100: mu_sd ~ 0.063
- sigma=0.5, totalK=10000: mu_sd ~ 0.006

### 3.3 Latency scale uncertainty: `sigma_sd`

**Derivation:** Asymptotic variance of the sigma estimator.

For a log-normal sample of size n, the MLE for sigma has asymptotic
variance sigma^2 / (2n). Our estimator is method-of-moments, which
has lower efficiency than MLE. Apply an efficiency correction factor
of ~1.5 (conservative estimate for the moments-based estimator):

```
sigma_sd = sigma * sqrt(1.5 / (2 * totalK))
         = sigma * sqrt(0.75 / totalK)
         ~ 0.87 * sigma / sqrt(totalK)
```

**Floor:** 0.02 (same rationale as mu_sd).

**Special case — default sigma:** When sigma falls back to the default
(0.5) because the mean lag is unavailable, we have genuine ignorance
about the true dispersion. Use an inflated SD:

```
sigma_sd = 0.25  (50% relative uncertainty)
```

This is flagged by `quality_failure_reason` containing "Mean lag not
available" or by comparing sigma to LATENCY_DEFAULT_SIGMA.

**Properties:**
- Scales as 1/sqrt(totalK)
- Proportional to sigma — wider distributions are harder to pin down
- sigma=0.5, totalK=100: sigma_sd ~ 0.043
- sigma=0.5, totalK=10000: sigma_sd ~ 0.004

### 3.4 Onset uncertainty: `onset_sd`

**Derivation:** Proportional heuristic.

Onset is derived from data (D2 weighted-quantile method) or set by the
user. It represents a dead-time before any conversions can occur. Unlike
mu and sigma, it is not fitted from the lag distribution, so we cannot
derive its uncertainty from the same sampling theory.

```
onset_sd = min(1.0, max(0.2, 0.10 * onset))
```

**Rationale:**
- Onset has outsized influence on band width near the CDF inflection
  point because ∂rate/∂onset peaks there. The delta method amplifies
  onset uncertainty enormously in that region.
- Bayesian posteriors typically give onset_sd ≈ 0.1–0.3 days.
- Floor of 0.2 days (not 1.0 — that produced bands spanning 0–100%).
- 10% relative uncertainty (not 25% — onset is relatively well-
  determined by the data).
- Capped at 1.0 day to prevent extreme values for large onsets.
- Not sample-size dependent because onset derivation uses a different
  estimation method (weighted quantile of per-cohort onsets).

### 3.5 Onset-mu correlation: `onset_mu_corr`

**Derivation:** Structural prior.

In the Bayesian posterior, onset and mu are typically anti-correlated:
a longer dead-time implies a shorter active-phase median for the same
overall latency. Without MCMC, we cannot measure this correlation.

```
onset_mu_corr = -0.3
```

**Rationale:**
- The sign is almost always negative (structural trade-off)
- Magnitude -0.3 is conservative: the Bayesian posterior often shows
  -0.4 to -0.8, but a weaker assumption avoids over-constraining the
  fan for the heuristic case
- Set to 0.0 when onset = 0 (no correlation if no onset)

---

## 4. Quality-Gate Inflation

When `empirical_quality_ok = false`, the fit itself is suspect (too few
converters, bad mean/median ratio, etc.). All heuristic SDs should be
inflated to signal reduced confidence:

```
inflation = 2.0  (when empirical_quality_ok = false)
```

Applied multiplicatively to mu_sd, sigma_sd, onset_sd. The p_sd floor
of 0.10 already handles the rate case.

This ensures that edges with poor-quality fits produce visibly wider
fans, signalling to the user that the model is uncertain.

---

## 5. Tail-Constraint Interaction

When `tail_constraint_applied = true`, the stats pass has increased
sigma beyond the moment-based estimate to match an authoritative t95.
This means:

1. `sigma_final > sigma_moments` — the tail is wider than the data
   suggests
2. The sigma uncertainty should reflect the *moment-based* estimate,
   not the inflated one, because the tail constraint is a deterministic
   adjustment:

```
sigma_for_sd_calc = sigma_moments  (not sigma_final)
```

The SD measures uncertainty in the *data-derived* parameter. The tail
constraint is a known correction, not a source of additional
uncertainty.

However, `sigma_final` is what flows into the model. So `sigma_sd`
should be computed from `sigma_moments` but applied to `sigma_final`.
The downstream MC draws will be:

```
sigma_draw = sigma_final + Normal(0, sigma_sd)
```

where `sigma_sd` is sized relative to `sigma_moments`. This preserves
the tail constraint while allowing the data-driven portion to vary.

---

## 6. Path-Level SDs (Cohort Mode)

For cohort mode, the stats pass produces path-level parameters
(`path_mu`, `path_sigma`, `path_onset`) via Fenton-Wilkinson
composition. These need their own SDs.

**Approach:** Propagate edge-level SDs through the composition.

For Fenton-Wilkinson sum of two independent log-normals with parameters
(mu_1, sigma_1) and (mu_2, sigma_2):

```
path_mu_sd    ~ sqrt(mu_1_sd^2 + mu_2_sd^2)      (quadrature sum)
path_sigma_sd ~ sqrt(sigma_1_sd^2 + sigma_2_sd^2) (quadrature sum)
path_onset_sd ~ sqrt(onset_1_sd^2 + onset_2_sd^2) (onsets are additive)
```

This is approximate (ignores the nonlinearity of the FW composition)
but correctly captures that path uncertainty grows with path length.
The Bayesian compiler does the equivalent but from MCMC samples of the
composed distribution.

**Path-level onset_mu_corr:** Use the same heuristic (-0.3) or 0.0 if
either edge in the path has onset = 0.

---

## 7. Storage: Where Do the SDs Go?

### 7.1 Stats Pass Output (new fields)

**EdgeLatencyStats (TS) / EdgeLAGValues (Py) — add:**

| Field | Type | Source |
|-------|------|--------|
| `mu_sd` | number | Heuristic (section 3.2) |
| `sigma_sd` | number | Heuristic (section 3.3) |
| `onset_sd` | number | Heuristic (section 3.4) |
| `onset_mu_corr` | number | Heuristic (section 3.5) |
| `p_sd` | number | Beta posterior (section 3.1) |
| `path_mu_sd` | number (optional) | Propagated (section 6) |
| `path_sigma_sd` | number (optional) | Propagated (section 6) |
| `path_onset_sd` | number (optional) | Propagated (section 6) |
| `dispersion_source` | 'heuristic' \| 'bayesian' | Provenance tag |

### 7.2 Model Vars (extend ModelVarsLatency)

The `model_vars` entries on parameter files currently store only point
estimates. Extend `ModelVarsLatency` with SD fields so that the SDs
persist alongside the point estimates:

```python
class ModelVarsLatency(BaseModel):
    mu: float
    sigma: float = Field(..., ge=0)
    t95: float = Field(..., ge=0)
    onset_delta_days: float = Field(..., ge=0)
    path_mu: Optional[float] = None
    path_sigma: Optional[float] = Field(None, ge=0)
    path_t95: Optional[float] = Field(None, ge=0)
    path_onset_delta_days: Optional[float] = Field(None, ge=0)
    # NEW: dispersion fields
    mu_sd: Optional[float] = Field(None, ge=0)
    sigma_sd: Optional[float] = Field(None, ge=0)
    onset_sd: Optional[float] = Field(None, ge=0)
    onset_mu_corr: Optional[float] = None
    path_mu_sd: Optional[float] = Field(None, ge=0)
    path_sigma_sd: Optional[float] = Field(None, ge=0)
    path_onset_sd: Optional[float] = Field(None, ge=0)
```

Extend `ModelVarsProbability` with SD:

```python
class ModelVarsProbability(BaseModel):
    mean: float = Field(..., ge=0, le=1)
    stdev: float = Field(..., ge=0)
    # stdev is already the p_sd — no change needed here
```

Note: `ModelVarsProbability.stdev` already exists and serves as `p_sd`.
The stats pass just needs to populate it with the Beta posterior SD
from section 3.1 (currently it may be set to 0 or omitted for
non-Bayes entries).

### 7.3 Graph Edge Schema (extend JSON schema)

`conversion-graph-1.1.0.json` needs the following additions to the
`edge.p.latency.posterior` object:

- `onset_mean` (number)
- `onset_sd` (number)
- `onset_mu_corr` (number)
- `path_mu_mean` (number)
- `path_mu_sd` (number)
- `path_sigma_mean` (number)
- `path_sigma_sd` (number)
- `path_onset_delta_days` (number)
- `path_onset_sd` (number)
- `path_onset_mu_corr` (number)

These are already in the TypeScript types (`LatencyPosterior`) and
Python types (`SlicePosteriorEntry`) but missing from the JSON schema.

### 7.4 Backend Consumption (_read_edge_model_params)

`_read_edge_model_params` already reads `bayes_mu_sd` etc. from the
Bayesian posterior. The resolution hierarchy becomes:

1. **Bayesian posterior** (from `lat_posterior`): authoritative SDs
2. **Model vars** (from `source_curves`): contains SDs from either
   Bayes or heuristic depending on source
3. **Synthesise at read-time**: if neither source has SDs, compute
   heuristic SDs from point estimates (using the formulas above)

Option 3 is the safety net — in practice the stats pass should always
populate the SDs in model_vars, making option 3 unnecessary. But the
fallback avoids silent zero-SD when old data is loaded.

### 7.5 `dispersion_source` Provenance Tag

Each model_vars entry already has a `source` field ('analytic',
'analytic_be', 'bayesian', 'manual'). The SD provenance is implicitly
determined by this:

- `source = 'bayesian'` -> SDs from MCMC posterior
- `source = 'analytic'` or `'analytic_be'` -> SDs from heuristic
- `source = 'manual'` -> SDs may be zero (user override)

No separate `dispersion_source` field is needed — the existing `source`
field is sufficient. The UI can label bands as "estimated" vs
"Bayesian" based on this.

---

## 8. Consumption Map: Full Wiring Audit

Before implementation, every consumption point must be identified.
This section traces the complete path from computation to display.

### 8.1 What already works (no change needed)

These consumers read from pre-computed data and will automatically
pick up heuristic dispersion once the BE populates the fields:

| Consumer | File | What it reads | Why no change |
|----------|------|--------------|---------------|
| Fan chart rendering | `cohortComparisonBuilders.ts:242-317` | `fan_bands[level]` from BE response | No source gate; renders whatever BE sends |
| `BayesPosteriorCard` | `BayesPosteriorCard.tsx:105-279` | `mu_sd, sigma_sd, onset_sd, onset_mu_corr` from posterior object | Displays whatever SDs exist; no source check |
| `PosteriorIndicator` | `PosteriorIndicator.tsx` | SDs from posterior object | Same — auto-displays |
| CSV export | `analysisExportService.ts:24-116` | Whatever is in `result.data` rows | Auto-exports if BE includes band values |
| Confidence band FE rendering | `cohortComparisonBuilders.ts:401-551` | `band_upper`, `band_lower` (pre-computed by Python) | FE just draws the polygon; computation is BE-side |

### 8.2 Gates that must be widened

These locations check for `source === 'bayesian'` and would suppress
heuristic dispersion even if the data is present:

| Location | File:Line | Current gate | Required change |
|----------|-----------|-------------|-----------------|
| Promoted curve confidence band | `cohortComparisonBuilders.ts:403` | `isBayesianPromoted` | Widen to `hasDispersion` — true when `promoted_source` has SD data, regardless of source |
| Per-source curve bands | `cohortComparisonBuilders.ts:508` | `srcName === 'bayesian'` | Widen to `srcData?.band_upper != null` — render bands for any source that has them |

### 8.3 Structural gaps (the real work)

These are missing pieces in the data flow. Without these changes,
heuristic SDs computed in the stats pass would not reach consumers.

#### Gap 1: ModelVarsLatency has no SD fields

**Files:**
- `graph-editor/src/types/index.ts` — TS `ModelVarsLatency` interface
- `graph-editor/lib/graph_types.py` — Py `ModelVarsLatency` Pydantic model

**Current state:** Only point estimates (mu, sigma, t95, onset, path_*).
No SD fields.

**Required:** Add `mu_sd`, `sigma_sd`, `onset_sd`, `onset_mu_corr`,
`path_mu_sd`, `path_sigma_sd`, `path_onset_sd` (all Optional).

#### Gap 2: Analytic model_vars write path omits SDs

**File:** `fetchDataService.ts:1692-1733`

After the FE stats pass runs `enhanceGraphLatencies()`, results are
written to model_vars entries with `source: 'analytic'`. Currently
only point estimates are written. The new SD fields from
`EdgeLatencyStats` must be mapped into `ModelVarsLatency`.

**Also:** `bayesPatchService.ts:333-346` — when creating the Bayesian
model_vars entry, SDs from the patch slices are **not written** to
`model_vars.latency` (they go only to `edge.p.latency.posterior`).
Both paths need fixing.

#### Gap 3: Promotion cascade omits SDs

**File:** `modelVarsResolution.ts:149-159`

`applyPromotion()` writes promoted point values to `p.latency.*` but
does not write SDs. The promoted model_vars entry's SDs are lost.

**Required:** After promoting point values, also promote SDs:
```
p.latency.promoted_mu_sd = result.latency.mu_sd
p.latency.promoted_sigma_sd = result.latency.sigma_sd
p.latency.promoted_onset_sd = result.latency.onset_sd
p.latency.promoted_onset_mu_corr = result.latency.onset_mu_corr
```

(And path-level equivalents.)

**Decision needed:** naming convention. Currently promoted point values
use `promoted_*` prefix (e.g. `promoted_t95`). SDs should follow the
same pattern.

#### Gap 4: `_read_edge_model_params()` SD resolution

**File:** `api_handlers.py:708-945`

Currently reads SDs from two places:
1. `lat_posterior` (the Bayesian posterior on the edge)
2. `source_curves` (per-source model_vars entries)

With heuristic SDs in model_vars, the resolution hierarchy becomes:
1. Bayesian posterior (authoritative)
2. Promoted model_vars SDs (from whichever source won promotion)
3. Source curves SDs (per-source)
4. Fallback: synthesise from point estimates (safety net for old data)

The existing code at lines 894-904 reads `bayes_*_sd` from the
posterior. It needs a parallel path that reads from the promoted
latency fields when the posterior is absent.

#### Gap 5: Edge properties panel and info tab

**Current state:** Three distinct rendering approaches for four cards:
- Bayesian card: `BayesPosteriorCard` — rich display (params ± sd,
  HDI, quality footer, spark chart, actions)
- Analytic FE/BE cards: bespoke `RoField` rows — bare point values
- Output card: `OutputCardBody` — editable probability, read-only
  latency

Both `ModelVarsCards.tsx` (edge properties) and
`AnalysisInfoCard.tsx` (edge info tab) consume `BayesPosteriorCard`.
The info tab gates on `effectiveKind === 'forecast' && posteriorsMeta`
— Bayesian only.

**Required:** Once all sources have SDs, all read-only source cards
should display params with uncertainty and a spark chart. The Output
card stays separate (editable UX is fundamentally different).

#### Gap 6: Generalised `ModelCard` component

Today's `BayesPosteriorCard` is already close to the right shape.
It renders a params grid, a spark chart with confidence bands, a
quality footer, and action buttons. The generalisation is to make
the Bayesian-specific elements conditional rather than assumed, and
to accept data from any source.

**The spark chart is already source-agnostic.** `BayesModelRateChart`
(→ `ModelRateChart`) takes point estimates + optional SDs via
`ModelRateChartProps`. When SDs are zero/null, bands don't render
and you get a plain CDF curve. Every source can drive this today.

**What each source provides:**

| Element | Bayesian | Analytic | Manual |
|---------|----------|----------|--------|
| Point estimates + spark chart | Yes | Yes | Yes |
| ± SD on estimates | Yes (posterior) | Yes (heuristic) | No |
| Onset↔mu correlation | Yes | Yes (-0.3 heuristic) | No |
| HDI ranges (credible intervals) | Yes | No | No |
| Quality footer (rhat, ESS, grade) | Yes | No | No |
| Provenance (MCMC/warm-start) | Yes | No | No |
| Actions (reset priors, delete) | Yes | No | No |

The conditional sections are **additive**. The card always shows
the params grid and spark chart. Bayesian sources add quality +
actions. Nothing needs hiding for non-Bayes — it's just absent.

**Proposed component decomposition:**

```
ModelCard (generalised, read-only)
├── Header: source label, promoted/pinned badges, timestamp
├── ProbabilityRow: mean ± sd
├── LatencyParamsGrid: two-column (edge / path)
│   ├── onset ± sd, HDI row if available
│   ├── mu ± sd, HDI row if available
│   ├── sigma ± sd, HDI row if available
│   ├── t95 (HDI if available)
│   └── onset↔mu corr (if nonzero)
├── ModelRateChart (spark CDF ± bands)
├── QualityFooter (conditional: present only when quality prop given)
│   └── rhat, ESS, grade, divergences, provenance
└── ActionsBar (conditional: present only when callbacks given)
    └── Reset priors, delete history

OutputCard (separate — editable UX)
├── ProbabilityInput (slider, blur-to-commit, source flipping)
├── LatencyParamsGrid (read-only, shared sub-component)
├── ModelRateChart (shared sub-component)
└── Own editing logic (not shared with ModelCard)
```

**Heuristic visual treatment:** When an analytic card displays
heuristic SDs, a subtle cue (e.g. lighter text on `± sd` values,
or a small "est." label) distinguishes from posterior-derived
uncertainty. The `model_vars.source` field drives this — no new
field needed.

**Consumption points after generalisation:**

1. `ModelVarsCards.tsx` — renders `ModelCard` for Bayesian, Analytic
   FE, Analytic BE. Bayesian gets `quality` and `actions` props;
   analytic cards don't. All get the same params grid and spark
   chart. Output card stays separate.

2. `AnalysisInfoCard.tsx` — currently gates on `posteriorsMeta`
   (Bayesian only). After: renders `ModelCard` whenever model
   params with latency are available, regardless of source. Gate
   changes from "has posterior" to "has model params".

**Migration path:**
1. Extract `LatencyParamsGrid` and `ModelRateChart` as shared
   sub-components from `BayesPosteriorCard` (mostly rename + props)
2. Generalise `BayesPosteriorCard` into `ModelCard` — quality and
   actions become conditional on props
3. Replace bespoke `RoField` rows in analytic cards with `ModelCard`
4. Update `AnalysisInfoCard` gate to support non-Bayes sources
5. Update Output card to use shared sub-components

#### Gap 7: JSON schema

**File:** `public/schemas/conversion-graph-1.1.0.json`

Missing from `edge.p.latency.posterior`:
- `onset_mean`, `onset_sd`, `onset_mu_corr`
- `path_mu_mean`, `path_mu_sd`
- `path_sigma_mean`, `path_sigma_sd`
- `path_onset_delta_days`, `path_onset_sd`, `path_onset_mu_corr`

These exist in TS/Py types but not in the JSON schema. Must be added
for schema validation to pass.

### 8.4 Data flow diagram (target state)

```
Stats Pass (FE or BE)
│ computeEdgeLatencyStats() now returns:
│   mu, sigma, onset, t95, p_infinity, p_evidence,
│   mu_sd, sigma_sd, onset_sd, onset_mu_corr, p_sd    ← NEW
│
├─► model_vars entry (source: 'analytic')
│     probability: { mean: p_inf, stdev: p_sd }        ← p_sd now populated
│     latency: { mu, sigma, t95, onset,
│                mu_sd, sigma_sd, onset_sd,             ← NEW fields
│                onset_mu_corr,
│                path_mu_sd, path_sigma_sd,             ← NEW fields
│                path_onset_sd }
│
├─► Promotion cascade (modelVarsResolution.ts)
│     Selects winning model_vars entry (analytic or bayesian)
│     Writes to edge: p.latency.promoted_mu_sd, etc.    ← NEW promotion
│
├─► BE: _read_edge_model_params()
│     Reads SDs from:
│       1. lat_posterior (Bayesian)
│       2. p.latency.promoted_*_sd (from model_vars)    ← NEW fallback
│     Assembles: bayes_mu_sd, bayes_sigma_sd, etc.
│
├─► BE: compute_cohort_maturity_rows()
│     Uses SDs for MC fan chart ← already wired
│
├─► BE: compute_confidence_band()
│     Uses SDs for analytic bands ← already wired
│
├─► BE: model curve generation
│     Produces band_upper/band_lower arrays
│     Includes in response.source_model_curves
│
├─► FE: cohortComparisonBuilders.ts
│     Renders: fan polygons, confidence band polygons,
│     model curve bands — for ALL sources with SD data   ← gate widened
│
└─► FE: Edge properties + info tab
      model_vars → ModelCard (generalised)
      ├── LatencyParamsGrid: point values ± sd
      ├── ModelRateChart: spark CDF ± bands
      ├── QualityFooter (Bayesian only)
      └── ActionsBar (Bayesian only)
      AnalysisInfoCard gate widened: "has model params" not "has posterior"
```

### 8.5 What does NOT need to change

- `cohort_forecast.py` (MC fan) — already consumes `bayes_mu_sd` etc.
  from the params dict. Once `_read_edge_model_params()` populates
  these from heuristic sources, it works.
- `confidence_bands.py` — same, already takes SD params.
- `BayesPosteriorCard` — auto-displays.
- Fan chart rendering — auto-consumes `fan_bands`.
- `localAnalysisComputeService.ts` — will inherit from the same
  model_vars path.

---

## 9. Implementation Plan

### Phase 1: Type system and storage

1. Extend `ModelVarsLatency` in both TS (`types/index.ts`) and Py
   (`graph_types.py`) with SD fields (all Optional)
2. Update JSON schema (`conversion-graph-1.1.0.json`) with missing
   posterior fields
3. Extend `EdgeLatencyStats` (TS) and `EdgeLAGValues` (Py) with SD
   fields in the stats pass return types

### Phase 2: Computation (both stats passes)

1. **FE** (`statisticalEnhancementService.ts`):
   - Add SD computation to `computeEdgeLatencyStats()` per section 3
   - Propagate path-level SDs during FW composition in
     `enhanceGraphLatencies()`
2. **BE** (`stats_engine.py`):
   - Mirror the same computation
3. **Parity tests**: Extend both `statsParity.contract.test.ts` and
   `test_stats_engine_parity.py` with SD test vectors

### Phase 3: Write path

1. `fetchDataService.ts` — write SDs to analytic model_vars entries
2. `bayesPatchService.ts` — write SDs to Bayesian model_vars entries
   (currently only written to posterior object)
3. `beTopoPassService.ts` — write SDs to analytic_be model_vars entries

### Phase 4: Promotion and read path

1. `modelVarsResolution.ts` — promote SD fields alongside point values
2. `_read_edge_model_params()` — read SDs from promoted fields when
   posterior is absent; fallback synthesis for old data

### Phase 5: Chart display gates

1. `cohortComparisonBuilders.ts` — widen `isBayesianPromoted` gate to
   `hasDispersion` (any promoted source with SD data)
2. `cohortComparisonBuilders.ts` — widen per-source band gate from
   `srcName === 'bayesian'` to `srcData?.band_upper != null`

### Phase 6: Generalised ModelCard component

1. Extract `LatencyParamsGrid` and `ModelRateChart` as shared
   sub-components from `BayesPosteriorCard`
2. Generalise `BayesPosteriorCard` into `ModelCard` — quality footer
   and actions become conditional on props
3. Replace bespoke `RoField` rows in analytic cards with `ModelCard`
4. Update Output card to use shared sub-components
   (`LatencyParamsGrid`, `ModelRateChart`)
5. Update `AnalysisInfoCard` gate from "has posterior" to "has model
   params with latency"
6. Add heuristic visual treatment (subtle label/styling on estimated
   SDs to distinguish from Bayesian posterior SDs)

### Phase 7: Verification

1. Visual: load a non-Bayes edge, verify fan chart and confidence
   bands render with heuristic dispersion
2. Comparison: load an edge with both Bayes and analytic, verify
   Bayesian SDs take precedence and heuristic SDs are not displayed
3. Export: verify CSV includes band values if present

---

## 10. Numerical Examples

### Example A: Well-observed edge (totalK=5000, totalN=10000)

| Parameter | Point estimate | Heuristic SD | Notes |
|-----------|---------------|-------------|-------|
| p | 0.50 | 0.005 | Beta(5001, 5001): very tight |
| mu | 1.44 (median=4.2 days) | 0.009 | 1.25 * 0.5 / sqrt(5000) |
| sigma | 0.50 | 0.006 | 0.87 * 0.5 / sqrt(5000) |
| onset | 2.0 days | 0.2 | max(0.2, 0.10×2.0) = 0.2, floor |

Fan width: very narrow. Appropriate — we have lots of data.

### Example B: Sparse edge (totalK=50, totalN=200)

| Parameter | Point estimate | Heuristic SD | Notes |
|-----------|---------------|-------------|-------|
| p | 0.25 | 0.030 | Beta(51, 151) |
| mu | 2.30 (median=10 days) | 0.088 | 1.25 * 0.5 / sqrt(50) |
| sigma | 0.50 | 0.061 | 0.87 * 0.5 / sqrt(50) |
| onset | 0.0 days | 0.2 | max(0.2, 0) = 0.2, floor |

Fan width: moderate. Appropriate — limited data, visible uncertainty.

### Example C: Very sparse edge (totalK=15, totalN=100)

| Parameter | Point estimate | Heuristic SD | Notes |
|-----------|---------------|-------------|-------|
| p | 0.15 | 0.100 | floor (totalK < 30) |
| mu | 1.10 (median=3 days) | 0.228 | 1.25 * 0.5 / sqrt(15), then 2x quality inflation |
| sigma | 0.50 (default) | 0.250 | default sigma -> 0.25 |
| onset | 1.0 days | 0.2 | max(0.2, 0.10×1.0) = 0.2, floor |

Fan width: wide. Appropriate — very little data, honest uncertainty.
Quality gate failure triggers 2x inflation on mu_sd.

---

## 11. Comparison with Bayesian Posterior SDs

For edges that have both Bayesian and analytic fits, we can compare:

| Parameter | Typical Bayes SD | Heuristic SD | Agreement |
|-----------|-----------------|-------------|-----------|
| p_sd | 0.01-0.05 | 0.005-0.05 | Good (same Beta model) |
| mu_sd | 0.02-0.15 | 0.01-0.10 | Reasonable (heuristic slightly tighter at high n) |
| sigma_sd | 0.02-0.10 | 0.01-0.07 | Reasonable (same pattern) |
| onset_sd | 0.3-2.0 | 1.0-2.5 | Heuristic wider (appropriate for less info) |

The heuristic SDs should generally be **at least as wide** as the
Bayesian ones, since the Bayesian posterior has strictly more
information (it uses the full likelihood, not just summary statistics).
If a heuristic SD is tighter than the Bayesian SD for the same data,
that indicates a flaw in the heuristic.

---

## 12. Open Questions

### Q1: Recency weighting for p_sd

Should the effective sample size for p_sd use recency-weighted n_eff
(matching how p_infinity is estimated) rather than raw totalN?

**Recommendation:** Yes, when `forecast_available = true`. The p_sd
should reflect the same basis as the point estimate. If p_infinity
depends heavily on 3 recent cohorts, the SD should reflect that small
effective sample, not the full 50-cohort population.

### Q2: Should the UI distinguish heuristic from Bayesian bands?

**Recommendation:** Yes, subtly. E.g. a lighter/more transparent fan
fill, or a tooltip label. The existing `model_vars.source` field
provides the provenance — no new field needed.

### Q3: What happens when Bayes runs after analytics?

**Answer:** The Bayesian model_vars entry (source='bayesian') is
promoted over the analytic entry. Its SDs replace the heuristic SDs
in the promotion cascade. No conflict — the existing precedence
hierarchy handles this.

### Q4: Manual overrides

When `source = 'manual'`, the user has set point estimates by hand.
Should we still compute heuristic SDs?

**Recommendation:** Set SDs to zero for manual entries. The user has
expressed a specific belief; adding uncertainty would contradict it.
If they want uncertainty, they can run the stats pass or Bayes.
