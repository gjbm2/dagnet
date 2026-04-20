# 53 — Explicit Drift Modelling for Frontier Forecasting

**Status**: Discussion  
**Date**: 20-Apr-26  
**Relates to**: [51-model-curve-overlay-divergence.md](51-model-curve-overlay-divergence.md), [52-b3-spike-workplan.md](52-b3-spike-workplan.md), [programme.md](programme.md), [archive/12-drift-detection-notes.md](archive/12-drift-detection-notes.md)

---

## 1. What problem this note is about

The current Bayes discussion now has two distinct goals that must not be
collapsed into one.

The first goal is to reduce **structural composition error** over long or
complex topologies. That is the problem motivating the B3 spike: mature
a-anchored evidence may tell us that composed edge posteriors are missing
something systematic about the path.

The second goal is to become genuinely **drift-sensitive** for frontier
forecasting. That problem is different. When the user asks how the latest
cohorts are likely to perform, the relevant question is not only how to
compose the path correctly, but how to represent the downstream regime
those cohorts are entering **now**.

This note is about the second goal.

## 2. Working principle for frontier forecasting

Under drift, mature `cohort()` evidence is often answering an older time
question than the user intends.

If downstream conversion performance deteriorates today, recent
`window()` evidence is usually the first place that deterioration becomes
visible after maturity adjustment. Mature a-anchored `cohort()` evidence
will only reflect that change later, once enough time has elapsed for
today's cohorts to traverse the path and mature.

That means the frontier forecasting question should be phrased as
follows: the user wants an anchor-defined population, but they also want
the answer to reflect the **current edge regime** that this population is
about to encounter downstream.

The practical consequence is that, until an explicit drift model exists,
**fast-path `window()` evidence must dominate frontier forecasting**.
Mature `cohort()` evidence can still calibrate structural path behaviour
and mature backtests, but it should not automatically replace the current
window-led signal for the latest cohorts.

## 3. What the ideal model would look like

The conceptually correct object for drift-sensitive forecasting is not a
single static posterior per edge. It is a time-indexed edge regime.

In that ideal model, each edge has a calendar-time state for conversion
behaviour. The latest `window()` evidence is the earliest noisy
observation of that state. Anchor cohorts then propagate through the
topology while encountering the sequence of edge regimes active at the
times they arrive. Mature `cohort()` evidence becomes delayed supervision
on what earlier anchor cohorts actually realised after flowing through
those time-varying regimes.

This is the right long-run picture for drift-sensitive forecasting. It is
also much more ambitious than the current static two-phase compiler.

## 4. Why probability drift comes first

Explicit drift in conversion probability is the obvious first target.

Probability drift is visible directly in recent `window()` counts and can
be modelled as a time-varying state with comparatively simple observation
models. By contrast, explicit latency drift would require a credible
time-varying model for onset and path timing under censoring, which is a
far harder inference problem and would reopen the weakest parts of the
current geometry.

The near-term conclusion is straightforward: if drift is to be modelled
explicitly, it should begin with edge-level probability and not with
latency.

## 5. Best-practice statistical shape

The right starting point is not a collection of independent date-bucket
effects. Best practice is a **structured latent time series**.

The natural first version is a weekly edge-level state for probability on
the logit scale, with neighbouring weeks explicitly shrunk toward one
another. That gives a local time regime which is more current than a
mature cohort fit, but less noisy than treating each recent week in
isolation.

Two kinds of partial pooling matter here. The first is across time:
adjacent weeks should borrow strength from one another rather than behave
as unrelated bins. The second is across edges: the volatility or
week-to-week movement scale should itself be pooled so sparse edges are
shrunk harder than dense ones.

The first explicit drift model should stay `window()` only and `p` only.
That keeps the object aligned with the question it is trying to answer:
what is the current local conversion regime on this edge.

## 6. Filtering and smoothing are different jobs

There is an important distinction between filtered and smoothed time
states.

A smoothed state estimate for week N uses data from both before and after
week N. That is useful for retrospective diagnostics and for
understanding how a regime evolved over time.

A filtered state estimate for week N uses only information available up to
week N. That is the object needed for live forecasting, because it avoids
future-information leakage.

For DagNet, the forecasting consumer needs the filtered version. A
retrospective model-quality view may later want the smoothed version as
well, but they should not be confused.

## 7. Lessons from the current system

The current system does not model drift explicitly. It uses
recency-weighted likelihoods and a configurable half-life so recent
evidence dominates older evidence.

That is useful and should remain in place for now. It is a pragmatic way
to bias a static fit toward current conditions without introducing a
large new latent state surface.

It is also not the same thing as an explicit drift model. Recency
weighting can favour recent evidence, but it does not produce a distinct
current-state estimate for each edge and week. It cannot tell the system
what the current regime is, only which observations should matter more
inside a static posterior.

The archived drift note is informative here. Earlier attempts to add
per-bin drift directly inside the full compiler produced poor geometry or
unreasonable complexity. That suggests the next attempt should not begin
as a full in-compiler dynamic graph model. A smaller auxiliary
`window()`-only regime model is the more credible next step.

## 8. Ambition ladder

The work can be framed as a progression of increasing ambition.

The first level is the current state: static posterior plus recency
half-life. This is a heuristic fast path, not explicit drift modelling.

The second level is a separate recent-regime estimator for `window()`
probability with temporally shrunk weekly states. This would give the
system a current edge regime without rewriting the whole compiler.

The third level is to let frontier forecasting consume that current
filtered state when propagating anchor cohorts through the graph. That is
the first point at which DagNet becomes genuinely drift-sensitive in the
way users actually mean.

The fourth level is a fully integrated dynamic graph model in which the
Bayes engine itself carries time-indexed edge states and the cohort
forecast integrates over them directly.

The fifth level is explicit latency drift. That remains a later research
problem and should not be coupled to the first drift implementation.

## 9. Implications for the near-term roadmap

This discussion has an immediate design consequence.

The B3 spike should not be sold as a solution to drift. Even if mature
cohort evidence proves useful for structural path correction, that does
not make it the right source of truth for the current frontier regime.

Until an explicit drift model exists, frontier forecasting should remain
window-led. Mature cohort evidence should be allowed to calibrate
structural path error, mature backtests, and long-path adequacy, but it
should not automatically override the fast `window()` signal for the
latest cohorts.

That keeps the current recency half-life in its proper role. It is a
pragmatic placeholder for a missing explicit drift model, not a reason to
pretend the system already has one.

## 10. Open design questions

Several design questions remain deliberately open.

The first is time granularity. Weekly states are the most plausible
starting point, but this should be verified against evidence density and
runtime.

The second is where the first explicit drift model should live. A small
auxiliary `window()` regime model may be the right next step, rather than
grafting dynamic states directly into the existing compiler.

The third is how to combine a current regime estimate with anchor arrival
distributions in the forecast consumer. That propagation problem is the
real architectural step from a drift-aware edge model to a genuinely
drift-sensitive cohort forecast.

The fourth is how far partial pooling should extend across slices. That is
not a first-phase question, but it will matter later.

## 11. Summary

Explicit drift modelling is a separate workstream from B3.

The ideal object is a time-indexed edge regime, with `window()` evidence
as the leading observation of the current state and mature `cohort()`
evidence as delayed supervision on realised outcomes.

Because DagNet does not yet have that model, near-term frontier
forecasting should remain fast-path and `window()` dominated. Mature
cohort evidence should calibrate structural composition, not replace the
current regime signal.
