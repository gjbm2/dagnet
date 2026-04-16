# Surprise Gauge Analysis Type

**Status**: Phase 2 — engine-backed posterior-predictive
**Date**: 16-Apr-26 (Phase 2); 27-Mar-26 (Phase 1 revised; original 24-Mar-26)

---

## 1. Purpose

Shows at a glance whether current evidence for an edge is surprising
given the Bayesian posterior. For each model variable, computes where
the observed value falls in the posterior distribution and renders a
colour-coded gauge or band.

---

## 2. Layouts

### 2.1 Single var, single scenario — Semicircular dial

Needle points to observed quantile. Coloured arcs show confidence zones.
Centre = posterior mean (50th percentile, "expected").

### 2.2 One var, multiple scenarios — Horizontal band stack

Each row is a scenario. Bands are on a **shared real axis** (same units),
shifted left/right to each scenario's posterior mean. A dot marks the
observed value. The band shift shows how expectations differ across
scenarios; the dot position within its band shows how surprising the
observation is.

### 2.3 One scenario, multiple vars — Horizontal band stack

Each row is a variable. Bands are **individually centred** on each
variable's expected value. The axis is normalised (linear in σ, labelled
in percentiles). Dot position shows how far observed is from expected
in posterior-SD units.

---

## 3. Colour scheme

Symmetric. Same for dial arcs and band fills.

| Zone | Percentile range | σ range | Colour | Meaning |
|------|-----------------|---------|--------|---------|
| Centre | 20th–80th | 0–1.28σ | Green | Expected |
| Inner | 10th–20th / 80th–90th | 1.28–1.64σ | Yellow | Noteworthy |
| Mid | 5th–10th / 90th–95th | 1.64–1.96σ | Amber | Unusual |
| Outer | 1st–5th / 95th–99th | 1.96–2.58σ | Red | Surprising |
| Tail | <1st / >99th | >2.58σ | Dark red | Alarming |

Axis is linear in σ but tick labels show percentiles (50%, 80%, 90%,
95%, 99%). This gives uniform visual spacing with familiar labels.

---

## 4. Variables

### Phase 1 — available from parameter file scalars

| Variable | Posterior | Observed evidence | Derivation |
|----------|----------|-------------------|------------|
| **p** | Beta(α, β) | `evidence.k`, `evidence.n` from edge | Completeness-adjusted normal approx (see §5.1) |
| **mu** | mu_mean ± mu_sd | `median_lag_days` from analytic model_vars | `obs_mu = ln(median_lag - onset_mean)`, combined-SD normal (see §5.2) |
| **sigma** | sigma_mean ± sigma_sd | `mean_lag_days` / `median_lag_days` from analytic model_vars | `obs_sigma = sqrt(2 × ln(mean/median))`, combined-SD normal (see §5.2). Guard: n_dates ≥ 30 |

### Phase 2 — requires snapshot DB query (BE has access)

| Variable | Posterior | Observed evidence | Derivation |
|----------|----------|-------------------|------------|
| **onset** | onset_mean ± onset_sd | Earliest conversion age in current window | Query snapshot DB: `min(lag_days) where y > 0`. Heuristic needed for robustness (e.g. 5th percentile of lag, not bare minimum) |
| **path_onset** | path_onset ± path_onset_sd | Earliest cohort conversion age | Query snapshot DB cohort frames: `min(cohort_age) where y > 0`. Same heuristic. |

---

## 5. Statistical tests

### 5.0 Evidence-only comparison (all variables)

The surprise gauge always compares **pure evidence** against the
model posterior. It never uses the blended f+e value from `p.mean`.

**Why**: In f+e visibility mode, `p.mean` is a weighted blend of
forecast and evidence. The forecast component is *derived from* the
posterior being tested against. Comparing a model-contaminated value
back against its own source is circular — it dampens surprise
regardless of what the data actually shows. The gauge must answer
"is the data surprising given the model?", which requires keeping
model and observation separate.

**Sources**:
- **p**: `evidence.k` / `evidence.n` on the edge (raw counts, never blended)
- **mu, sigma**: from the `analytic_be` (preferred) or `analytic`
  model_vars entry (evidence-fitted lag parameters, not the promoted
  latency which may incorporate forecast adjustments)
- **f-only mode**: gauge shows "no evidence available" — comparing
  a forecast against its own posterior is meaningless

### 5.1 p — engine-backed posterior-predictive (Phase 2)

The BE surprise gauge calls `compute_conditioned_forecast` from the
forecast engine (doc 29) to compute a proper MC-based posterior-predictive
z-score. This replaces the Phase 1 analytic formula.

#### How it works

1. `resolve_model_params` resolves the edge's best-available model
   (respecting source preference, temporal mode, quality gate).
2. Snapshot query retrieves per-cohort evidence `(age, n, k)` — same
   pattern as cohort maturity v3.
3. `compute_conditioned_forecast` draws S=2000 samples from the joint
   posterior `(p, μ, σ, onset)` with correlated onset-μ draws.
4. For each draw s, compute the n-weighted expected evidence rate:

```
expected_rate_s = p_s × Σ(n_i × C(age_i; μ_s, σ_s, onset_s)) / n_total
```

   where C is the lognormal CDF (with carrier convolution in cohort mode).

5. The z-score is:

```
z = (k_total/n_total − mean(expected_rate)) / sd(expected_rate)
```

   where mean and sd are taken across the S unconditioned draws.

#### What this captures that the analytic formula missed

- **Completeness uncertainty**: each draw evaluates CDF at different
  latency params, so the spread of `expected_rate_s` includes maturity
  uncertainty. The analytic formula treated completeness as known exactly.
- **Carrier convolution** (cohort mode): upstream arrival lag from the
  node arrival cache. The analytic formula used simple edge-level CDF.
- **Joint posterior correlations**: onset-μ correlation narrows the
  true posterior-predictive spread. The analytic formula assumed
  independence between p and latency.
- **No separate var_samp term**: MC spread already includes the full
  posterior-predictive variance. No need to compose posterior + sampling
  components analytically.

#### Fallback: analytic formula (Phase 1)

When snapshot data is unavailable (no param_id, DB error, no rows),
the gauge falls back to the Phase 1 analytic formula:

```
expected = μ_p × c̄_w
var_post = σ²_p × c̄_w²
var_samp = expected × (1 − expected) / n_total
var_c    = c_sd² × μ_p²                         # completeness_stdev from engine
combined = sqrt(var_post + var_samp + var_c)
z        = (k_total/n_total − expected) / combined
```

The FE local compute always uses this analytic fallback (no BE access),
but now includes `completeness_stdev` from the topo pass when available.

### 5.2 mu, sigma — combined-SD normal approximation

The posterior marginals for mu and sigma are approximately normal.
The observed values are aggregated across n_dates daily cohorts in
the window, so their sampling variance depends on n_dates.

```
n_dates = (anchor_to − anchor_from).days + 1

For mu:   obs = ln(median_lag − onset_mean)
          obs_se = sqrt(π/2) × σ_lag / sqrt(n_dates)
          combined_sd = sqrt(mu_sd² + obs_se²)
          z = (obs − mu_mean) / combined_sd
          quantile = Φ(z)

For sigma: obs = sqrt(2 × ln(mean_lag / median_lag))
           Guard: skip if n_dates < 30 or mean_lag ≤ median_lag
           sigma_se = σ_lag / sqrt(2 × n_dates)
           combined_sd = sqrt(sigma_sd² + sigma_se²)
           z = (obs − sigma_mean) / combined_sd
           quantile = Φ(z)
```

The sqrt(π/2) factor for mu is the asymptotic relative efficiency of
the sample median of a log-normal. The 1/sqrt(2n) factor for sigma
comes from the sampling distribution of the log-normal scale parameter.

**Note**: completeness does not directly bias mu/sigma. These are
estimated from the lag distribution of conversions that *did* occur,
regardless of how many cohorts are still maturing. There is a subtle
selection bias with very young cohorts (only fast converters observed),
but this is second-order and not corrected in Phase 1.

### 5.3 onset, path_onset — normal approximation (Phase 2)

```
obs = heuristic from snapshot DB (e.g. 5th percentile of lag)
z = (obs − onset_mean) / onset_sd
quantile = Φ(z)
```

Note: onset sampling variance is harder to estimate. Phase 2 may
use just the posterior SD (ignoring observation noise) as a first
approximation, since the onset posterior SD is typically wide enough
to absorb it.

---

## 6. Implementation plan

### Phase 1

**Backend** (`api_handlers.py` — `_compute_surprise_gauge()`):
- Read `evidence.k`, `evidence.n` from edge (not `p.mean`)
- Read `completeness` (c̄_w) from `edge.p.latency`
- Read posterior α, β from raw posterior or MoM reconstruction
- Compute completeness-adjusted z-score per §5.1
- Read `anchor_from`/`anchor_to` from `subj` for n_dates (mu/sigma)
- Compute combined-SD z-scores for mu/sigma per §5.2
- Return: `{ variables: [{ name, quantile, sigma, observed, expected,
  posterior_sd, zone, label, completeness_used }] }`

**Frontend** (`localAnalysisComputeService.ts` — `buildSurpriseGaugeResult()`):
- Mirror the BE logic for offline/preview fallback
- Use `evidence.k`/`evidence.n`, not `p.mean`
- Use `latency.completeness` for completeness-adjusted expectation

**Display** (already implemented):
- ECharts gauge series for single-var dial
- Horizontal band renderer for multi-var/multi-scenario
- Display settings: variable selector, orientation toggle

### Phase 2 (implemented 16-Apr-26)

**Backend** (`_surprise_gauge_engine_p` in `api_handlers.py`):
- Calls `resolve_model_params` + `query_snapshots_for_sweep` + `compute_conditioned_forecast`
- MC posterior-predictive z-score from unconditioned draws (see §5.1)
- Carrier convolution in cohort mode via `build_node_arrival_cache`
- Falls back to Phase 1 analytic formula when snapshots unavailable

**Frontend** (`localAnalysisComputeService.ts`):
- Includes `completeness_stdev` in combined SD when available from topo pass

**mu/sigma**: `resolve_model_params` provides canonical mu_sd/sigma_sd,
replacing ad-hoc posterior lookup chains.

### Phase 3 (future)

- Onset variable: snapshot DB query for observed onset (min lag where y > 0)
- Path onset from cohort frames
- Add `onset` and `path_onset` to variable selector options

---

## 7. Analysis type registration

```
id: 'surprise_gauge'
name: 'Expectation Gauge'
shortDescription: 'How surprising is current evidence given the Bayesian posterior'
icon: Gauge (or AlertTriangle)
snapshotContract: {
  scopeRule: 'single_edge',
  readMode: 'none',          // gauge queries snapshots internally for engine path
  slicePolicy: 'any',
  timeBoundsSource: 'query_dsl_window',
  perScenario: true,
}
```

---

## 8. Design principles

1. **All computation in the BE.** The FE renders what it's given.
   (The FE has a local fallback for offline/preview, but the BE
   is authoritative.)
2. **Evidence only.** The gauge compares pure evidence against the
   model. Never use the blended f+e value — it's circular (see §5.0).
   In f-only mode, show "no evidence available."
3. **Completeness-adjusted expectation.** The model's long-run rate
   is scaled by c̄_w (n-weighted average completeness across the
   window's cohort dates) to produce the expected evidence rate at the
   window's aggregate maturity. The gauge measures deviation from
   *what the model predicts you should see at this maturity*, not
   from the long-run rate (see §5.1).
4. **Completeness from the topo pass.** The surprise gauge reads
   `edge.p.latency.completeness` (c̄_w) directly — it does not
   recompute completeness. This is the same n-weighted aggregate
   already computed by the topo pass and used by the per-day blending
   loop.
5. **Sampling noise matters.** The surprise score must account for
   both posterior uncertainty AND observation noise. A single day
   with k=2, n=50 is noisy — the gauge should reflect that. A 30-day
   window with k=600, n=1500 is precise — the gauge should reflect
   that too.
6. **Guard rails.** Skip sigma when n_dates < 30. Skip onset/path_onset
   when snapshot data is insufficient. Show "insufficient data"
   rather than a misleading gauge. Fall back to c_d = 1 when no
   lag model is available (assume full maturity).
7. **Linear-in-σ axis, percentile labels.** Uniform visual spacing,
   familiar units.
