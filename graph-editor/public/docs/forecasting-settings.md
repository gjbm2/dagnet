# Forecasting settings

DagNet’s forecasting settings are **repository-wide** knobs stored in `settings/settings.yaml`.

They materially change computed probabilities (and anything derived from them), so treat changes like code changes:
- Commit them
- Pull them on other machines before comparing results
- Call out the change in team comms when it affects analysis

This page explains what each knob does, how to think about indicative values, and the failure modes each knob is trying to manage.

## Mental model (what DagNet is trying to do)

For an edge \(X \rightarrow Y\) we care about:
- **Evidence**: what we’ve actually observed in the query window (\(k/n\)).
- **Forecast**: what we believe the long-run conversion rate should be for *mature* cohorts, usually estimated from historical mature days.
- **Maturity / completeness**: how much of the query window is likely “fully observed” given conversion latency.

When the newest cohorts are immature, raw evidence (\(k/n\)) is biased downward (late converters haven’t arrived yet). DagNet therefore:
- Estimates a **baseline forecast** from mature data.
- Estimates **completeness** using a latency model.
- **Blends** forecast and evidence based on completeness and sample size.

## Knobs

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


