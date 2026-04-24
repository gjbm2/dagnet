# Forecasting settings

DagNet’s forecasting settings are **repository-wide** knobs stored in `settings/settings.yaml`.

They materially change computed probabilities (and anything derived from them), so treat changes like code changes:
- Commit them
- Pull them on other machines before comparing results
- Call out the change in team comms when it affects analysis

This page explains what each knob does, how to think about indicative values, and the failure modes each knob is trying to manage.

## Mental model

DagNet forecasts using one of several model sources per edge. The default (`best_available`) prefers **Bayesian posteriors** when available — the conditioned forecast model writes `p.mean` directly from the MC population model. When no Bayesian posterior exists (new edges, first setup, Bayes not yet run), the **analytic pipeline** provides instant estimates.

**The knobs on this page govern the analytic pipeline.** When a Bayesian posterior is the active source for an edge, these settings do not apply — the posterior drives probability directly. See [Model Source Preference](#model-source-preference--model_source_preference) for how the active source is determined.

For edges using the analytic source, we care about:
- **Evidence**: what we’ve actually observed in the query window (\(k/n\)).
- **Forecast**: what we believe the long-run conversion rate should be for *mature* cohorts, usually estimated from historical mature days.
- **Maturity / completeness**: how much of the query window is likely “fully observed” given conversion latency.

When the newest cohorts are immature, raw evidence (\(k/n\)) is biased downward (late converters haven’t arrived yet). The analytic pipeline therefore:
- Estimates a **baseline forecast** from mature data.
- Estimates **completeness** using a latency model.
- **Blends** forecast and evidence based on completeness and sample size.

## Knobs

> **Applicability:** The following settings control the **analytic fallback pipeline**. They affect edges whose active model source is `analytic`. Edges with an active Bayesian posterior are not affected — their probability comes from the conditioned forecast model. See [Which settings matter when?](#which-settings-matter-when) below.

## Recency Half-Life (days) — `RECENCY_HALF_LIFE_DAYS`

**What it controls**  
How strongly *recent mature* cohorts are weighted when estimating the baseline forecast probability.

**Definition**  
A mature cohort that is \(H\) days older has **half** the weight of a brand-new mature cohort (exponential half-life).

**When to change it**  
- Lower it if your conversion rate genuinely shifts quickly (campaign changes, product changes).
- Raise it if you want a more stable baseline and you suspect noise / small-sample volatility is dominating.

**Indicative values**  
- **7–14**: very responsive
- **30**: balanced (default)
- **60–90**: conservative
- **Very large** (e.g. \(10^7\)): effectively disables recency weighting (mature-day totals dominate without age weighting)

**Failure modes**  
- Too low: forecast chases noise and can swing sharply week-to-week.
- Too high: forecast lags behind real shifts and can look “stale”.

## Minimum Effective Sample Size — `LATENCY_MIN_EFFECTIVE_SAMPLE_SIZE`

**What it controls**  
A stability guardrail for recency weighting.

With recency weighting, the *effective* sample size (\(N_{eff}\)) can be much smaller than the raw \(N\), because older cohorts contribute less weight. If \(N_{eff}\) becomes too small, forecasts become unstable; this threshold triggers more conservative behaviour.

**Indicative values**  
- **50–150**: more responsive, but can be noisy on thin data
- **150–500**: typical range (default **150**)
- **500+**: very conservative (slower reaction to change)

**Failure modes**  
- Too low: you can end up with a forecast dominated by a tiny sliver of recent data.
- Too high: you can prevent the system from responding when it actually should.

## Default t95 (days) — `DEFAULT_T95_DAYS`

**What it controls**  
The fallback “maturity horizon” used when an edge does not have a reliable latency estimate.

Operationally, this governs how much of the newest data is treated as potentially incomplete (immature).

**Indicative values**  
- **0–2**: only if latency is genuinely near-instant and you’re confident in that
- **7–21**: typical for many behavioural funnels
- **30**: conservative default
- **60–90**: very conservative

**Failure modes**  
- Too low: you may treat immature data as mature (systematically under-estimating completeness).
- Too high: you may throw away too much recent data and become sluggish / over-conservative.

## Forecast Blend λ (lambda) — `FORECAST_BLEND_LAMBDA`

**What it controls**  
How strongly the baseline forecast acts as a prior when blending forecast and evidence for immature data.

Higher λ means the forecast “hangs on longer”; lower λ means evidence dominates sooner.

**Indicative values**  
- **0.05–0.20**: typical range (default **0.15**)
- **0.20–0.50**: more conservative (forecast dominates longer)
- **0**: disables the prior (generally not recommended)

**Failure modes**  
- Too low: early evidence (\(k/n\)) can drag p.mean down aggressively for immature cohorts.
- Too high: p.mean can remain pinned to forecast even when evidence is clearly informative.

## Completeness Power η (eta) — `LATENCY_BLEND_COMPLETENESS_POWER`

**What it controls**  
An additional conservatism knob that down-weights completeness *only for the purpose of computing the blend weight*.

η > 1 makes the system less willing to trust evidence when completeness is below 1 (immature).

**Indicative values**  
- **1.0**: canonical behaviour (no extra conservatism)
- **1.5–3.0**: typical safety range (default **2.25**)
- **3.0–5.0**: very conservative

**Failure modes**  
- Too low: immature cohorts can influence p.mean more than intended.
- Too high: p.mean can cling to forecast for too long, even when evidence is adequately mature.

## Anchor Delay Blend K (conversions) — `ANCHOR_DELAY_BLEND_K_CONVERSIONS`

**What it controls**  
How quickly *observed* anchor-delay evidence overrides the *prior* anchor delay when computing cohort-mode completeness on downstream edges.

This exists because observed anchor-lag information can be sparse/noisy for short or highly-filtered cohort windows. We therefore “soft transition” from a prior (accumulated from upstream baseline median lags) to observed anchor lag once there is enough credible evidence.

**Shape of the transition**  
The weight grows roughly like:
\[
w = 1 - e^{-x / K}
\]
where \(x\) is the effective number of forecast conversions supporting the observed anchor delay.

**Indicative values**  
- **20–50**: responsive (trust observed anchor lag quickly)
- **50–150**: typical range (default **50**)
- **150–300**: conservative (prior dominates longer; reduces instability when anchor lag is sparse)

**Failure modes**  
- Too low: noisy / partial anchor-lag measurements can cause completeness to jump around.
- Too high: the system may ignore real observed anchor-delay information longer than it should.

## Onset Mass Fraction α — `ONSET_MASS_FRACTION_ALPHA`

**What it controls**  
How `onset_delta_days` is derived from **window() lag histograms** (dead‑time detection).

**Definition**  
Let \(H(t)\) be the empirical CDF of conversion lag (from the window() lag histogram). We define onset \(\delta\) as the earliest day such that:

\[
H(\delta) \ge \alpha
\]

Intuition: choose the earliest time by which an \(\alpha\) fraction of conversion mass has occurred. This makes the onset estimate robust to noise in the very first bins (and robust to “zero‑mass” early bins).

**Indicative values**  
- **0.005–0.02**: typical range (default **0.01**)
- Smaller: more sensitive (onset tends to be earlier)
- Larger: more conservative (onset tends to be later)

**Failure modes**  
- Too low: onset may collapse to ~0 due to tiny early noise, even when there is real dead‑time.
- Too high: onset may be overstated, shifting too much mass into the post‑onset model and making completeness overly conservative.

## Onset Aggregation β — `ONSET_AGGREGATION_BETA`

**What it controls**  
How per‑slice `onset_delta_days` values are aggregated across **window() slice families** in the LAG topo pass.

**Definition**  
Given slice‑family onset values, DAGNet computes a **weighted β‑quantile** (weights are based on the number of dates in each slice family).  

**Indicative values**  
- **0.5**: robust median (default)
- Lower than 0.5: more aggressive (prefers smaller onset)
- Higher than 0.5: more conservative (prefers larger onset)

**Failure modes**  
- Too low: a single slice family with near‑zero onset can dominate, re‑introducing early false mass.
- Too high: a single outlier slice family can push onset too large, making completeness too conservative.

## Lag Fit Guardrail: Max mean/median ratio — `LATENCY_MAX_MEAN_MEDIAN_RATIO`

**What it controls**  
A guardrail used when fitting a lognormal from moments (median + mean). If the implied \(\text{mean}/\text{median}\) ratio exceeds this threshold, the fit is treated as unreliable and falls back to a default \(\sigma\).

**Why it exists**
Very heavy‑tailed moment pairs can imply extremely large \(\sigma\), which can destabilise downstream calculations.

## Bayes Band Level — `bayes_band_level`

**What it controls**
The credible interval width for the Bayesian confidence band on cohort maturity charts. When a Bayesian posterior is available, the chart draws a shaded polygon between the upper and lower model curves.

**Options**
- **off**: no band shown
- **80%**: narrower band (80% credible interval)
- **90%**: default — 90% credible interval
- **95%**: wider band
- **99%**: widest band

**Where it appears**
Display settings in the chart toolbar and properties panel (cohort maturity charts only). Persisted in `display.bayes_band_level`.

**Data requirement**
Requires `bayesBandUpper` and `bayesBandLower` arrays in the analysis result (populated by the backend when Bayesian posteriors are available for the edge's latency model).

**Current shipped default**  
The default is **999999**, which effectively disables the guardrail (i.e. the fit will infer \(\sigma\) from moments even for very heavy tails). This was chosen because onset shifting can make the post‑onset median very small while the histogram still contains a real tail.

**Failure modes**  
- Too low: real heavy tails get suppressed (tail “cut‑off”), which can break completeness and horizons.
- Too high: pathological inputs can produce very large \(\sigma\) and unstable fits (use with care if changing from the shipped default).

## Model Source Preference — `model_source_preference`

**What it controls**
Which candidate model source is promoted to drive completeness, forecast, and blended probability for each edge.

**Options**

| Value | Behaviour |
|-------|-----------|
| `best_available` | Default. Prefers Bayesian (if present and quality gate passed), then analytic |
| `bayesian` | Forces Bayesian source (falls back to analytic if no posterior exists) |
| `analytic` | Forces analytic source |
| `manual` | Forces user-edited values |

**Scope**
Can be set per-edge (with `model_source_preference_overridden` flag) or as a graph-level default in graph metadata. Per-edge overrides take precedence.

**Where to change it**
- **Per-edge**: Edge Info → Model tab → Source Preference dropdown
- **Graph-level**: Graph metadata (edit via Properties panel or YAML)

See [LAG Statistics Reference §12](lag-statistics-reference.md) for the full promotion waterfall.

**Effect on analytic knobs:** When an edge is promoted to `bayesian`, the backend conditioned forecast drives its probability directly — the analytic knobs above (RECENCY_HALF_LIFE, BLEND_LAMBDA, COMPLETENESS_POWER, etc.) are not used for that edge. They remain relevant for edges where no Bayesian posterior exists or where the source is forced to `analytic`.

## Which settings matter when?

| Active source | Which settings apply |
|---|---|
| `analytic` | All knobs on this page |
| `bayesian` | MODEL_SOURCE_PREFERENCE, quality tiers, bayes_band_level only |
| `manual` | MODEL_SOURCE_PREFERENCE only |

## Quality Tiers (Bayesian fit results)

After a Bayesian fit completes, each edge receives a quality tier based on MCMC diagnostics. Quality tiers determine:

1. **Display**: Shown in the Bayesian Posterior Card, operations toast, and session log
2. **Warm-start eligibility**: Only Good and Fair posteriors can be reused as starting values for the next fit
3. **Promotion**: `best_available` source preference only promotes Bayesian posteriors that pass the quality gate

| Tier | Meaning |
|------|---------|
| **Good** | Converged, adequate effective sample size |
| **Fair** | Minor convergence warnings |
| **Poor** | Convergence issues — use with caution. Amber warning persists until dismissed |
| **Very poor** | Failed convergence — results unreliable |

## Run Bayes — `runBayes` flag

**What it controls**
Whether a graph is included in nightly Bayesian model fitting.

**How to enable**
Mark a graph for automatic Bayes fitting via graph metadata. When enabled, the daily automation pipeline includes a Bayes submission step after the retrieve-all completes:

1. Daily fetch pulls latest data
2. Retrieve All fetches all slices
3. **Bayes fit is submitted** for the graph
4. Results are delivered via webhook and committed as patch files

**Prerequisite**: The Python backend must be available (locally or via Modal) for Bayes fits to execute.

