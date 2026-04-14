# 29 — Generalised Forecast Engine Design

**Date**: 7-Apr-26
**Revised**: 12-Apr-26 — substantial rewrite of the engine design based
on deeper understanding of the pipeline injection point, two-tier FE/BE
delivery, and the structural difference between window and cohort modes.
Phase A material (§Generalised Cohort Maturity below) unchanged.
**Status**: see §Implementation Status below for what exists as code
vs what is design only.

## Motivation

Cohort maturity does a more sophisticated job at estimating forecast and
uncertainty than e.g. surprise gauge. We want to generalise the relevant
components to allow generalised forecasting across the app — edge cards,
overlays, surprise gauge, cohort maturity, and future consumers should
all draw from a single forecast engine rather than maintaining parallel
implementations.

---

## Implementation Status (12-Apr-26)

### Already built

| Component | Location | Status |
|-----------|----------|--------|
| Span kernel (DP convolution, all topologies) | `runner/span_kernel.py` | Implemented. Includes `mc_span_cdfs` for per-draw reconvolution. |
| Evidence composition (multi-hop) | `runner/span_evidence.py` | Implemented. Handles branching at x, fan-in at y. |
| Span adapter (kernel → edge_params bridge) | `runner/span_adapter.py` | Implemented. Transitional — target is direct kernel consumption. |
| x_provider (upstream arrival model) | `runner/cohort_forecast.py`, `cohort_forecast_v2.py` | Implemented. Three-tier carrier hierarchy (parametric, empirical, weak prior). |
| v2 row builder (factorised X_x + K_{x→y}) | `runner/cohort_forecast_v2.py` | Implemented (1154 lines). Full MC fan bands, IS conditioning, D/C split. |
| `cohort_maturity_v2` analysis type | FE + BE registered | Implemented. Parallel handler in `api_handlers.py`. |
| Completeness computation (point estimate) | `runner/forecast_application.py` | Implemented. `compute_completeness()` — single CDF evaluation. |
| Blend formula (evidence + model) | `runner/forecast_application.py` | Implemented. `annotate_data_point()` — per-point blend. |
| FE topo pass (aggregate CDF completeness) | `statisticalEnhancementService.ts` | Implemented. n-weighted CDF, path-anchored override in cohort mode. |
| BE topo pass (parity computation) | `stats_engine.py` via `/api/lag/topo-pass` | Implemented. Mirrors FE computation. |
| Model vars infrastructure | `modelVarsResolution.ts`, `bayesPatchService.ts` | Implemented. Multi-source (analytic, analytic_be, bayesian, manual), quality gates, promotion. |
| Posterior slice resolution | `posteriorSliceResolution.ts` | Implemented. Edge ← window(), path ← cohort() routing. |
| p.evidence.stdev (binomial sampling) | `evidenceForecastScalars.ts` | Implemented. `sqrt(p(1-p)/n)`. Correct for E-mode display. |

### Not yet built (design only in this document)

| Component | Status |
|-----------|--------|
| Completeness stdev computation | Design only. One new field: latency.completeness_stdev. |
| Promoted model resolver (unified) | Design only. Currently scattered across 4 locations. |
| Completeness with uncertainty (`completeness_sd`) | Design only. Requires sampling from latency dispersions. |
| `rate_conditioned_sd` / `rate_unconditioned_sd` | Design only. Composed uncertainty from p + completeness. |
| Two-tier FE/BE delivery | Design only. Pattern exists for topo pass; not yet applied to improved engine computations. |
| Graph-wide topo pass with per-node arrival caching | Design only. Propagation engine scoped to improved completeness and rate scalars. |
| Surprise gauge migration to engine | Design only. Currently ~400 lines of independent computation. |
| Edge card migration to engine | Design only. Currently ~500 lines of scattered annotation. |
| `cohort_maturity_v3` (clean-room engine consumer) | Design only. v2 frozen as parity reference. |
| `asat()` support in engine (three-date model) | Design only. evidence_cutoff / evaluation / posterior_cutoff. |
| Posterior covariance matrix (5×5 per edge) | Design only. Future enhancement for joint draws. |
| F-mode and F+E-mode bead ± correction | Design only. Currently shows raw stdev; needs composed uncertainty. |

### Parity gates

| Gate | Status |
|------|--------|
| v1 vs v2 single-hop parity (field-by-field) | **PASSED 13-Apr-26.** Window and cohort modes on real graph data. Tests in `test_doc31_parity.py`. |
| v2 multi-hop acceptance | Pending — parallel quality work, does not block engine extraction. |
| v2 → v3 parity | Not applicable yet (v3 not started). |

---

## Consumers

Three consumers today, each computing forecast/completeness
independently:

1. **Edge display** (completeness chevron, bead label) — reads
   `edge.p.latency.completeness` set by the FE/BE topo pass
   (`statisticalEnhancementService.ts` / `stats_engine.py`). Aggregate
   CDF: `Σ(n_i × F(age_i)) / Σ(n_i)`. Path-anchored override in
   cohort mode.

2. **Surprise gauge** — FE: `localAnalysisComputeService.ts` (~250
   lines). BE: `_compute_surprise_gauge` in `api_handlers.py` (~400
   lines). Each independently resolves model params, computes
   completeness, derives expected rate, compares to observed.

3. **Cohort maturity chart** — `cohort_forecast.py` (v1, 1570 lines)
   and `cohort_forecast_v2.py` (v2, 1154 lines). Full trajectory with
   MC fan bands, D/C split, IS conditioning, upstream carrier hierarchy.

All three need: **given a pre-resolved subject (edge + cohort group +
model params), produce completeness, rate, and dispersions — both
unconditioned and conditioned on evidence.**

### Resolution boundary

The FE plans which subjects to query: it resolves the DSL into edges,
determines candidate regimes per edge, segments the sweep range into
epochs (per-day regime grouping), and sends subjects with slice_keys
and candidate_regimes to the BE. The BE performs the actual regime
*selection* — `select_regime_rows()` in `snapshot_regime_selection.py`
filters rows to one coherent regime per (edge, date, retrieval),
consuming the candidates the FE provided (doc 30).

The forecast engine receives pre-resolved, regime-selected data. It
does not know about contexts, DSL, epoch planning, or regime selection
— all of that is upstream. In cohort mode, the FE's epoch planning
is more complex (multiple subjects per edge with different slice_keys
per epoch), but this complexity is fully upstream of the engine.

---

## Two Structurally Different Modes

Window and cohort modes are not parameter variants of the same
computation. They are structurally different:

### Window mode (simple)

x is fixed at observation time. Completeness is `CDF_edge(tau)`.
Upstream dynamics don't matter. A point estimate is:

```
(mu, sigma, onset, p, tau) → {completeness, rate, dispersions}
```

This is a thin wrapper around `compute_completeness()` + the blend
formula from `forecast_application.py`.

### Cohort mode (upstream-aware)

x grows over time. Completeness at the edge depends on the entire
upstream path's maturity dynamics — the x_provider, reach, the upstream
carrier hierarchy (Tier 1 parametric, Tier 2 empirical, Tier 3 weak
prior), IS conditioning on upstream evidence, and the factorised
`X_x + K_{x→y}` representation.

You cannot compute completeness for a cohort-mode edge without
modelling upstream arrivals. A single edge's completeness in cohort mode
is a function of the entire path from anchor to that edge's from-node.

The engine has two paths, not one. The abstraction must not hide this
distinction — consumers need to know which mode they're in.

---

## Schema Change and Field Mapping

The engine improves the computation behind existing graph fields. It
does not introduce a new persisted object on the schema.

### One new schema field

`latency.completeness` changes from a bare number to an object:

```
completeness?: number
completeness_stdev?: number
```

`stdev` is the uncertainty on the completeness estimate, derived by
sampling from the latency dispersions (mu_sd, sigma_sd, onset_sd,
onset_mu_corr). When the topo pass cannot compute a stdev (e.g. no
dispersions available), `stdev` is omitted and consumers display the
value without ±.

This follows the existing `{ mean, stdev }` pattern used by
`p.evidence`, `p.forecast`, and `ModelVarsProbability`. The field is
`value` rather than `mean` because completeness is a maturity
fraction, not a probability mean.

Impact: 29 TS files read `latency.completeness` as a number. All
need updating. See schema cleanup doc 39.

### Engine output → existing graph field mapping

Every other value the engine computes maps to an existing field. The
engine improves the computation; it does not add fields.

| Engine computation | Writes to | Currently written by | What improves |
|---|---|---|---|
| Completeness point estimate | `latency.completeness` | FE/BE topo pass | Uses promoted model params; upstream-aware in cohort mode |
| Completeness uncertainty | `latency.completeness_stdev` | **New** | Samples from latency dispersions |
| Forecast rate | `p.forecast.mean` | FE topo pass (`estimatePInfinity`) | Uses promoted model |
| Forecast rate uncertainty | `p.forecast.stdev` | FE topo pass (heuristic dispersion) | Incorporates completeness uncertainty |
| Evidence rate | `p.evidence.mean` | `addEvidenceAndForecastScalars` | Unchanged |
| Evidence rate uncertainty | `p.evidence.stdev` | `addEvidenceAndForecastScalars` (binomial) | Unchanged |
| Blended rate | `p.mean` | FE topo pass (`computeBlendedMean`) | Uses promoted model + upstream-aware completeness |
| Blended rate uncertainty | `p.stdev` | FE topo pass | Incorporates completeness uncertainty (all three sources in F+E) |
| Latency fit params | `latency.mu`, `latency.sigma` | `applyPromotion` | Unchanged (already promoted) |
| Path-level params | `latency.path_mu`, `latency.path_sigma` | FE/BE topo pass (FW composition) | Unchanged |
| Latency dispersions | `latency.promoted_mu_sd` etc. | `applyPromotion` from `model_vars` | Unchanged (moves to `latency.promoted.*` after schema cleanup doc 39) |
| Horizons | `latency.promoted_t95` etc. | `applyPromotion` | Unchanged (moves to `latency.promoted.*` after doc 39) |
| Model source | `model_vars[]` + `model_source_preference` | `applyPromotion` | Unchanged |

### Internal computation structure

The engine uses a transient in-memory structure during computation
(in Python). This is **not** persisted on the graph and **not** part
of the schema. Its purpose is to collect intermediate results
(completeness with stdev, composed rate SDs, resolved model params)
before writing them to the existing graph fields listed above.

For chart API calls (cohort maturity, surprise gauge), the engine
returns resolved model params as part of the API response — not as
a persisted graph field. v3 consumes these for MC fan bands.

### Completeness with uncertainty

Completeness today is a point estimate: `CDF(age, mu, sigma)`. But
mu and sigma themselves have uncertainty (from posterior SDs or
heuristic dispersion estimates). A large `mu_sd` means the CDF at this
age could range widely — e.g. from 0.2 to 0.5 — even if p is
well-known.

The engine should sample from the latency dispersions to produce
`completeness_sd`: the standard deviation of the completeness estimate
given parameter uncertainty. Concretely: draw `(mu, sigma, onset)` from
their joint distribution (using mu_sd, sigma_sd, onset_sd, and
onset_mu_corr), evaluate the CDF at the current age for each draw,
take the standard deviation across draws.

**Why this matters beyond surprise gauge**:

- **Surprise gauge**: currently compares observed rate against
  `p × completeness` and uses `p_sd` for the error band. But if
  `completeness_sd` is large, the expected rate itself is uncertain.
  The gauge should combine both sources of uncertainty:
  `rate_sd ≈ sqrt((p × completeness_sd)² + (completeness × p_sd)²)`.
  Without this, a discrepancy at low completeness with high latency
  uncertainty looks more surprising than it is.

- **Edge display**: the completeness chevron could show an uncertainty
  band (e.g. the chevron spans the ±1σ range rather than sitting at a
  single point). This communicates "we think maturity is 40–60%" vs
  "maturity is exactly 50%".

- **Staleness nudges**: an edge with high `completeness_sd` relative
  to its completeness value is one where more data would materially
  reduce uncertainty. This could inform fetch priority.

- **Cohort maturity chart**: the trajectory's per-tau `completeness_sd`
  feeds into the forecast uncertainty — the fan bands should be wider
  when the maturity estimate itself is uncertain.

### `asat()` semantics

`asat(date)` varies the epistemic basis for the entire forecast, not
just the observation point:

**asat < now** ("what would have been seen at date X?"):
- Evidence filtered to snapshots retrieved on or before X
- Posterior selected from fit history at or before X (via
  `resolveAsatPosterior`). If the Bayesian posterior didn't exist yet,
  it must not be used
- Completeness evaluated at age = (asat_date - anchor_day), which is
  younger than today's age
- The user sees a historical view with less evidence and potentially a
  different (older, less informed) model

**asat = now** (default):
- Normal operation. All three dates are "now".

**asat > now** ("what do we expect to see at future date X?"):
- No new snapshots exist (haven't been retrieved yet). Evidence is
  frozen at today's frontier.
- Completeness evaluated at the *future* age =
  (asat_date - anchor_day), which is larger than today's age
- The model projects forward: completeness increases, the blend shifts
  toward the model rate
- The gap between evidence_cutoff (now) and evaluation_date (future)
  is the forecast horizon. Uncertainty bands across that gap are the
  model's honest statement of what it expects, given parameter
  uncertainty

The three dates affecting the computation:
- `evidence_cutoff_date`: filter snapshots. For asat < now, this is
  asat. For asat > now, this is now (no future snapshots exist).
- `evaluation_date`: compute completeness at this date's age. Always
  the asat date itself.
- `posterior_cutoff_date`: select model. For asat < now, use
  historical fit. For asat > now, use current best-available.

**Design rules**:

- **Descriptive, not prescriptive.** No tau bucketing, no rate-vs-count
  mode, no fan bands, no zones. Those are consumer-specific.
- **Unconditioned vs conditioned is first-class.** Every edge's forecast
  carries both. Surprise gauge needs the unconditioned baseline to
  measure surprise against. Edge cards need the conditioned estimate.
- **Completeness uncertainty is first-class.** `completeness_sd`
  derived from latency dispersions. Consumers use it for honest error
  bands.
- **The trajectory is optional.** Surprise gauge and edge cards need a
  scalar at `tau_observed`. Only cohort maturity needs the full curve.
  The trajectory is the same engine called at every tau in a range —
  not a separate abstraction layer.
- **Resolved params are optional.** Only MC consumers (v3) need them.
  The engine provides them alongside the deterministic scalars so
  v3 can run its own MC sampling without re-deriving model resolution.

**Consumer mapping**:

| Consumer | Reads from graph |
|----------|--------------------------|
| Edge display (chevron/bead) | `completeness ± completeness_sd`, `rate_conditioned ± rate_conditioned_sd` |
| Surprise gauge | `rate_unconditioned ± rate_unconditioned_sd` vs observed |
| Edge cards / overlays | `completeness`, `rate_conditioned ± rate_conditioned_sd` |
| Cohort maturity chart (v3) | `trajectory` + `resolved_params` (for MC fan bands) |

---

## What the FE Graph Display Needs

The graph canvas renders per-edge: a probability label, a completeness
chevron with bead, a lag indicator, and (optionally) a Sankey
completeness line.

### Current state

After Stage-2, the FE reads from `edge.p`:

| Display element | Current source | What it reads |
|----------------|----------------|---------------|
| Probability label | `p.mean` (F+E), `p.forecast.mean` (F), `p.evidence.mean` (E) | Scalar p |
| Probability ± | `p.stdev` (F+E), `p.forecast.stdev` (F), `p.evidence.stdev` (E) | Scalar stdev |
| Completeness chevron | `latency.completeness` | Scalar 0–1 |
| Bead label ("5d / 70%") | `latency.median_lag_days`, `latency.completeness` | Two scalars |
| Sankey completeness line | `latency.completeness` | Scalar 0–1 |
| Lag anchor fade band | `latency.completeness` | Scalar 0–1 |

No uncertainty is shown on completeness today.

### After engine improvement

The engine writes improved values to the same fields. No new fields
on the graph except `latency.completeness_stdev`.

| Display element | Source field | What changes |
|----------------|-------------|--------------|
| Probability ± (F mode) | `p.forecast.stdev` | Now incorporates completeness uncertainty |
| Probability ± (F+E mode) | `p.stdev` | Now properly composes all three uncertainty sources |
| Probability ± (E mode) | `p.evidence.stdev` | Unchanged — binomial sampling SD is already correct |
| Completeness value | `latency.completeness` | Better computation (promoted model, upstream-aware in cohort mode) |
| Completeness ± | `latency.completeness_stdev` | **New.** Displayed as e.g. "5d / 70% ± 5%" on the latency bead |
| Everything else | Same fields as today | Better computations, same schema |

### Three uncertainty regimes

The ± shown on edge beads means different things in each display
regime. The three regimes layer different sources of uncertainty:

**E (evidence only)**: "We observed k conversions from n trials. The
true population rate is somewhere around k/n, but sampling uncertainty
means it could be higher or lower."

One uncertainty source:
1. **Sampling uncertainty** — binomial: `sqrt(p(1-p)/n)`

No model involved. Completeness doesn't feature.

**Current implementation**: `p.evidence.stdev`. Correct. No change.

---

**F (forecast only)**: "The model predicts this rate, but we're
uncertain about both the rate itself and how mature these cohorts are.
Even if the model is right about p, we're not sure how much of the
eventual conversion we've captured yet."

Two uncertainty sources:
1. **Epistemic + aleatoric model uncertainty** — from `p.forecast.stdev`
   (posterior width or heuristic dispersion)
2. **Completeness uncertainty** — from `latency.completeness_stdev`
   (latency dispersions propagated through the CDF)

The topo pass composes these into `p.forecast.stdev`:
`p.forecast.stdev ≈ sqrt((p × completeness_stdev)² +
(completeness × p_sd)²)`

**Independence assumption and measurement indeterminacy**: the
formula above assumes p and latency params are independent. In
practice they are anti-correlated in the posterior due to
measurement indeterminacy: the model observes (k, n, lag_days) per
cohort, and a high-p/high-mu explanation (many will convert, but
slowly — so few observed yet) is hard to distinguish from a
low-p/low-mu explanation (few will convert, but quickly — so most
already observed). The posterior captures this as negative
correlation between p and mu.

This means:
- The product `p × CDF(age)` is **more constrained** than either
  factor alone — when p is sampled high, CDF is sampled low (because
  mu is compensatingly higher), and vice versa.
- The independent formula **overestimates** combined uncertainty.
  Conservative (wider bands than warranted), not dangerous.
- The proper fix is joint posterior draws via a transformed-space
  covariance matrix (see §Future Enhancements).

**Current implementation**: `p.forecast.stdev` is raw model stdev
without completeness uncertainty. The engine improves this.

---

**F+E (forecast conditioned on evidence)**: "We have some evidence
AND a model. The evidence pins down the mature portion; the model
fills in the immature portion. The ± reflects all three sources."

Three uncertainty sources:
1. **Sampling uncertainty** — from the observed evidence (the mature
   portion). Same as E.
2. **Model uncertainty** — from the forecast for the immature portion.
   Same as F.
3. **Completeness uncertainty applied to evidence** — the model
   predicts what fraction of conversions have been observed
   (completeness), then we observe that fraction. But if completeness
   itself is uncertain, the boundary between "observed" and "forecast"
   is uncertain.

As completeness → 1: F+E converges to E (evidence dominates, model
uncertainty vanishes). As completeness → 0: F+E converges to F (no
evidence, pure model). The blend weights are driven by completeness.

The topo pass composes these into `p.stdev`.

**Current implementation**: `p.stdev` does not properly compose the
three sources. The engine improves this.

---

### Summary of bead ± changes

| Regime | Current source | What changes |
|--------|---------------|--------------|
| E | `p.evidence.stdev` | Unchanged |
| F | `p.forecast.stdev` | Incorporates completeness uncertainty |
| F+E | `p.stdev` | Properly composes all three sources |
| Completeness | bare "70%" | Shows "70% ± 5%" from `latency.completeness_stdev` |

The completeness chevron position is unchanged — it stays at the
point estimate. Uncertainty band on the chevron is a future UX
decision.


## Promoted Model Resolver (Prerequisite)

Both modes need a single resolver: given an edge, return the
best-available model params with provenance.

**Current state**: resolution is scattered across:

- `resolveActiveModelVars()` in `modelVarsResolution.ts` (FE)
- `_resolve_promoted_source()` + `_read_edge_model_params()` in
  `api_handlers.py` (BE)
- `read_edge_cohort_params()` in `cohort_forecast.py` (cohort-specific)
- `posteriorSliceResolution.ts` (slice routing)

These implement overlapping but divergent cascades. The FE and BE each
have their own notion of "which posterior do I use" — e.g.
`read_edge_cohort_params` prefers path-level posteriors because cohort
maturity needs a-anchored parameters, while surprise gauge compares
against the slice-matched posterior.

**Target**: one Python-side resolver that:

1. Accepts `edge` + `model_vars[]` + `preference` (Bayesian if
   gated → analytic_be → analytic → manual)
2. Returns: p (mean + stdev), latency (mu, sigma, onset + SDs),
   path-level equivalents, quality metadata, provenance (which source
   won, when fitted)
3. Respects per-edge and graph-level `model_source_preference`
4. Handles the scope distinction: window → edge-level params,
   cohort → path-level params. The resolver accepts `scope`
   (`edge` | `path`) and `temporal_mode` (`window` | `cohort`).

This eliminates the duplicated cascade logic while preserving the
semantic distinction between edge-level and path-level resolution.

---

## Pipeline Injection: Where the Engine Runs

The forecast engine does not exist as a standalone endpoint called
ad hoc. It slots into the existing fetch pipeline:

```
FE fetch → persist to param file → sync to graph →
  Stage-2 topo pass:
    1. LAG fit (existing: mu, sigma, t95, onset — unchanged)
    2. Model vars upsert (existing: analytic, analytic_be — unchanged)
    3. Promotion (existing: resolve best-available — unchanged)
    4. ★ Forecast engine (NEW)
       - Reads: promoted model params, evidence, mode
       - Window path: CDF → completeness, rate, dispersions
       - Cohort path: upstream-aware → completeness, rate, dispersions
       - Writes improved values to existing graph fields + completeness_stdev
    5. Graph write + render
```

### Two-Tier FE/BE Delivery

The same pattern already used for the topo pass:

1. **FE runs immediately** — computes completeness from its existing
   aggregate-CDF approach (what `enhanceGraphLatencies` does today).
   Edge renders instantly. The FE writes to the same fields as today..

2. **BE forecast engine commissioned in parallel.** If it returns
   within ~500ms, its improved values replace the FE estimates before
   the user notices. If not, the FE estimate stands until the BE
   result arrives.

3. **When the BE result arrives (even late)**, it overwrites the FE
   estimate and the edge re-renders with the better number.
   Quality indicator shows
   which model source produced the values.

**Contract**: the FE estimate must never be worse than what exists
today. The FE path is the floor — aggregate CDF, n-weighted,
path-anchored in cohort mode. The BE path adds: upstream-aware
completeness, promoted model resolution, dispersions,
completeness_stdev. Strictly better but not free.

### Cohort-mode upstream computation in Stage-2

Today the upstream carrier (x_provider, Tier 1/2/3, IS conditioning)
only runs inside `compute_cohort_maturity_rows_v2` — it's
chart-specific. For the generalised engine to produce proper
cohort-mode completeness on every edge after every fetch, that
computation needs to move into the BE topo pass.

The current topo-pass completeness in cohort mode is an approximation
(path-anchored CDF on raw ages). The v2 upstream-aware completeness is
what users actually see in cohort maturity charts. If the edge display
shows a different completeness from the chart, that's a divergence the
engine eliminates.

### Graph-wide topo pass: caching and sequencing

The engine runs for **all edges on a graph** in the Stage-2 pass, not
just one edge. Naively recomputing the full upstream carrier per edge
would repeat reach, upstream CDF mixture, and IS conditioning for every
edge sharing upstream structure. For a 20-edge graph that's wasteful.

**Design**: walk edges in topological order (which the topo pass
already does). At each node, accumulate the arrival state — the
distribution of arrivals at that node over time. When you reach a
node, the arrival distributions from all upstream edges are already
cached. That cached per-node arrival state *is* the x_provider for
every outgoing edge from that node.

This is the propagation engine described in
`cohort-backend-propagation-engine-design.md`, scoped to producing improved
completeness and rate scalars rather than full MC trajectories.

**Per-node cache contents**:

- Deterministic arrival CDF at this node (weighted upstream mixture)
- MC arrival CDF array (if upstream has uncertainty)
- Reach from anchor to this node
- Evidence observations at this node (for IS conditioning)

Each outgoing edge reads this cache and combines it with its own
edge-level model to produce improved completeness and rate values. No re-traversal of the
upstream subgraph.

**Single-edge query**: the graph-wide topo pass serves edge display
only (chevrons and beads after a fetch). Charts always run their own
computation via the `snapshot_analyze` API with specific query
parameters. Within a single API request containing multiple subjects
(edges), the same per-node arrival cache applies — shared upstream
structure is computed once.

Cross-request caching (reusing topo pass results when a chart asks for
the same edge) is not worth pursuing initially — the chart may have
different DSL parameters, date range, or asat. Snapshot query results
are already cached, which reduces the main DB cost. If performance
becomes an issue, caching the per-node arrival state keyed by
(graph_hash, query_mode, date_range) is the natural optimisation.

---

## `cohort_maturity_v3`: Clean-Room Consumer of the Engine

The same discipline that made v2 work: v1 was frozen as the parity
reference while v2 was built freely. Now **v2 becomes the frozen
reference** and v3 is the generalised engine consumer.

**HARD RULE: `cohort_forecast_v2.py` and its call sites in
`_handle_cohort_maturity_v2` are frozen. Do not modify them.** v2 is
the parity reference that Phase 3–6 test against. Any change to v2
invalidates the parity baseline. The engine must produce the same
results as v2 independently — if it can't, the engine is wrong, not v2.
This rule also applies to `cohort_forecast.py` (v1 carrier hierarchy
used by v2) and `span_kernel.py` / `span_evidence.py` / `span_adapter.py`
(v2 infrastructure). All of these are frozen until v3 passes parity
and v2 is retired (Phase 5.5).

**Why v3, not refactoring v2**: v2's 1,154 lines stay untouched during
engine development — no risk of breaking the working implementation
while extracting from it. v3 provides a live benchmark during
development, just as v1 constrained v2.

**What v3 is**: a consumer of the engine (deterministic trajectory
+ resolved model params). The engine provides the deterministic forecast
(completeness with stdev, rates at every tau) plus the resolved model
params (span kernel CDF, upstream carrier, posterior alpha/beta, SDs).
v3 reads those and runs its own MC loop for fan bands.

The MC sampling is genuinely chart-specific: drift fraction, sampling
mode (binomial/normal/none), band levels (80/90/95/99%), per-cohort
IS conditioning are all rendering concerns that other consumers don't
need. Forcing MC into the engine to make v3 thinner would make the
topo pass ~1000x heavier for a feature only one consumer uses.

So v3 is not a pure consumer of the engine's scalar output — it also consumes
the resolved model params. But model resolution, upstream carrier computation,
and completeness are fully delegated to the engine. v3 owns only the
MC sampling and row schema.

**Parity gate**: v3 on adjacent single-edge subjects must produce
identical output to v2, field by field. Same discipline as v1→v2.
When v3 passes parity, v2 is retired wholesale.

**Implementation sequence**:

1. Register `cohort_maturity_v3` as analysis type (FE+BE)
2. v3 handler calls the engine to get the deterministic trajectory
   + resolved model params
3. v3 row builder uses resolved model params to run MC fan bands
   (span kernel CDF, upstream carrier, posterior concentration, SDs)
4. Parity gate: v2 vs v3 on adjacent subjects
5. Multi-hop acceptance: v3 on multi-edge spans
6. Retire v2, promote v3 as `cohort_maturity`

---

## Known Approximations

Documented in `cohort-maturity/INDEX.md` with full pros/cons. None
block the generalised engine:

1. **Graph-wide x(s,τ) propagation not implemented** — current code
   uses subject-edge local shortcut
2. **Y_C heuristic** — uses tau-dependent rate but doesn't convolve
   with arrival-time distribution
3. **Mixed probability bases in denominator** — reach and upstream CDF
   may use different posterior bases
4. **Frontier semantics are consumer-specific** — cohort maturity uses
   per-Cohort `tau_observed`; surprise gauge uses aggregate
   completeness. The completeness field exposes the aggregate; per-cohort data is in the API response.

---

## Sequencing

| Phase | What | Notes |
|-------|------|-------|
| **1** | **Promoted model resolver** | Prerequisite. See INDEX.md §6. |
| **2** | **Window-mode engine** — extract from `forecast_application.py`, add completeness_stdev, improve p.stdev and p.forecast.stdev, inject into BE topo pass. FE instant path unchanged. | Low risk. Surprise gauge and edge cards in window mode consume this. |
| **3** | **Cohort-mode engine** — graph-wide topo pass with per-node arrival caching. Upstream-aware completeness. | Substantive new work. This is the propagation engine scoped to scalars. |
| **4** | **Wire surprise gauge** — replace `_compute_surprise_gauge` (~400 lines) with promoted resolver + improved graph field reads. | First consumer migration. |
| **5** | **Wire edge cards** — replace scattered completeness annotation (~500 lines) with improved graph field reads. | Second consumer. |
| **6** | **`cohort_maturity_v3`** — clean-room consumer of engine trajectory + resolved params. v2 frozen as parity reference. MC fan bands remain chart-specific. | Largest consumer. v2→v3 parity gate before retiring v2. |
| **7** | **Parity and contract tests** | Gate for promotion. |

### Test plan

1. **FE vs BE completeness parity** (window mode): FE instant
   completeness vs BE forecast completeness — must be within tolerance.
2. **Mature-limit convergence**: as tau → ∞, completeness → 1 and
   forecast rate → posterior mean. Analytical invariant for both modes.
3. **Consumer parity on shared payload**: surprise gauge's expected-p
   must equal cohort maturity's unconditioned rate at tau_observed when
   fed the same inputs.
4. **Cohort-mode completeness convergence**: edge-display completeness
   from the engine must match what the cohort maturity chart shows
   for the same edge at the same tau.
5. **FE vs BE surprise gauge parity**: validate before retiring the FE
   implementation.

---

## Superseded Material

The original Steps 1–6 (7-Apr-26) proposed
`evaluate_forecast_at_tau(edge_params, tau)` as the reusable scalar
helper. This was wrong:

- The consumer contract is not `(edge_params, tau) → scalar`. It is
  `(pre-resolved subject + best-available model) → {completeness,
  rate, dispersions}` in both unconditioned and conditioned modes.
- Cohort mode requires upstream-aware computation that cannot be
  hidden behind the same scalar interface as window mode.
- The engine injects into the existing fetch pipeline (Stage-2 topo
  pass), not as a standalone endpoint.
- The "trajectory layer" framing was misleading — cohort maturity just
  calls the same point-estimate engine at every tau in a range, not a
  separate abstraction.

The original Steps are retained in git history for reference.

---

## Generalised Cohort Maturity (x→y Traversal)

**Added**: 7-Apr-26 | **Rewritten**: 8-Apr-26

### Notation

Throughout this section:

| Symbol | Meaning |
|--------|---------|
| **a** | **Anchor node** — the graph entry point that defines cohort identity. Cohort dates are anchored here. |
| **x** | **Query start node** — the `from()` node in the DSL. Denominator of the maturity rate. Often x = a. |
| **y** | **Query end node** — the `to()` node in the DSL. Numerator of the maturity rate. |
| **u** | **Last edge's source node** — the node immediately upstream of the final edge into y. In the current single-edge implementation, u = x. In multi-hop, u ≠ x. |

These are four distinct concepts. The current code conflates x, a, and
u because for a single adjacent edge they are often the same node. The
multi-hop generalisation requires distinguishing them.

### The two problems

The multi-hop maturity question — "of cohorts entering at x, what
fraction reached y by age τ?" — contains two mathematically distinct
sub-problems:

**Problem 1 — the x→y span kernel** (conditional progression):
Given arrival at x, what is the probability of reaching y by age τ?
This is a numerator problem. It does not exist today for multi-hop.

**Problem 2 — the x estimate** (denominator model):
How many cohort members have arrived at x by age τ? The current row
builder already estimates this via `reach(u) × CDF_upstream(τ)`. This
estimate exists and works, but is tuned for u (the last edge's source),
not for x (the query start).

**Phase A fixes the conditional x→y progression. Phase A does not
change the denominator model. Phase B replaces the denominator model.**

This split is correct because:
- It isolates the real numerator problem — the x→y span logic is what
  doesn't exist today.
- It avoids turning one fix into a full graph-propagation rewrite.
- It works cleanly in window() mode and improves cohort() mode
  immediately.
- It gives a stable seam: Phase B can swap in a better x provider
  without rewriting the x→y logic.

### Mode truth

- **In window() mode**, Phase A is the full fix. The denominator x is
  flat (fixed at observation time), so the existing x estimate is
  trivially correct. The span kernel is the only new work.
- **In cohort() mode**, Phase A is a numerator fix over a legacy
  denominator. The y forecast correctly models multi-hop progression,
  but the x forecast still uses the single-edge denominator model
  (reach to u, not reach to x). This is acceptable for the common
  case where x = a (reach = 1.0), but is a known limitation when
  x ≠ a. Phase B fixes this.

### Why multi-hop maturity comes first

1. **Immediate user value.** "Of the cohort that entered at x, what
   fraction reached y?" is a concrete question with a well-defined
   answer.

2. **The evidence part is exact.** Snapshot data for all edges already
   exists in the DB. Cross-edge composition at the frame level requires
   no new maths.

3. **Building multi-hop first creates the consumer that validates the
   forecast-state contract.** The contract from Phase 0 must serve both
   single-edge and multi-hop. Building the consumer first exposes gaps.

### What cohort maturity for x→y means (first principles)

**Definition**: For a group of cohorts anchored at dates d₁..dₙ, the
path maturity curve plots:

```
r(τ) = Σᵢ yᵢ(τ) / Σᵢ xᵢ(τ)
```

Where:
- `yᵢ(τ)` = arrivals at y observed by age τ for cohort i
- `xᵢ(τ)` = arrivals at x for cohort i (fixed in window mode, growing
  in cohort mode)
- τ = days since cohort anchor date

The denominator is **arrivals at x** (the query start node), not
arrivals at u (the last edge's source node). The numerator is
**arrivals at y** (the query end node), which equals `y` on the last
edge(s) into y.

**Relationship to edge-level maturity**: When x and y are adjacent
(single edge), this reduces to the current implementation (`y/x` on
the single edge x→y). The generalisation replaces the single-edge
denominator with arrivals at x (from x-incident edges), and the
single-edge numerator with arrivals at y (from y-incident edges).

**Parallel paths**: If multiple routes exist from x to y (e.g.
x→B→D→y and x→C→D→y), the numerator includes arrivals at y via all
routes. This is correct: `r(τ)` answers "what fraction of x-entrants
reached y by age τ", regardless of route.

### What already works

| Component | Status |
|-----------|--------|
| **Scope rule** (`funnel_path`) | Already finds all edges on any x→y path via BFS |
| **Snapshot retrieval** | Already fetches snapshots for every in-scope edge independently |
| **Per-edge maturity derivation** | `derive_cohort_maturity()` produces frames from one edge's snapshots |
| **Chart rendering** | Row schema (tau_days, rate, midpoint, fan_upper, fan_lower) is edge-agnostic — works unchanged |
| **Epoch planning** | Already handles sweep epochs per subject |

### What needs to change

#### Layer 1: Path structure resolution (post-doc-31: BE-native)

Docs 30+31 are implemented. The BE resolves path structure natively
from the DSL string via `graph_select.py`. The BE knows which edges
are in scope, which edges are incident to x, and which edges are
incident to y. No FE path-resolution changes
needed.

#### Layer 2: Evidence frame composition

Given per-edge frames from `derive_cohort_maturity()`, compose
span-level evidence:

1. **Denominator extraction**: Extract arrivals at x per (anchor_day,
   snapshot_date). **Canonical rule for the denominator carrier**:
   - When x = a (common case): use `a` (anchor population) from any
     edge's frames — all edges share the same `a` per cohort.
   - When x ≠ a: use the `x` field from any edge incident to x. All
     edges leaving x measure arrivals at x, so they should agree. If
     they differ (due to regime selection or data gaps), take the
     maximum — it represents the most complete observation.
   - Note: there is no single "first edge" when x has multiple
     outgoing edges (branching at x). The rule above handles this
     without requiring a singular first edge.

2. **Numerator extraction**: From the last edge(s)' frames, extract
   `y` per (anchor_day, snapshot_date). This is arrivals at y. If
   multiple edges feed into y, sum their `y` values.

3. **Composition**: For each (anchor_day, snapshot_date), compute
   `rate = y_at_y / x_at_x`. Emit a composed frame with the same
   schema as `derive_cohort_maturity` output.

4. **Join key alignment**: Both edges' frames are derived from
   snapshots retrieved on the same dates for the same cohorts.
   `derive_cohort_maturity` interpolates to daily granularity, so the
   join on (anchor_day, snapshot_date) should align naturally.

**New function**: `compose_path_maturity_frames(graph, x_node_id,
y_node_id, all_edge_frames) → composed_frames`. Pure function, no DB
access. The function identifies x-incident and y-incident edges from
the graph, then applies the extraction rules above.

Evidence composition is correct for all topologies including branching
at x and fan-in at y.

#### Layer 3: x→y span kernel (Phase A — new capability)

**Phase A keeps the current x estimate unchanged. It only changes how
y is produced from that x.**

The span kernel K_{x→y}(τ) answers: "given arrival at x at time 0,
what is the probability of having reached y by age τ?" This is the
conditional progression across the full downstream DAG from x to y,
including branching and joins.

##### Algebra

Each edge e_i has a sub-probability density on the discrete tau grid:

```
f_i(τ) = p_i · pdf_i(τ)
```

where `pdf_i` is the density of the shifted-lognormal latency for
edge i, and `p_i` is the edge conversion probability. The
corresponding sub-probability CDF is `F_i(τ) = Σ_{t≤τ} f_i(t)`.
Note: `F_i(∞) = p_i`, not 1.

**Linear chain** x→B→…→y: The path kernel density is the convolution
of per-edge sub-probability densities:

```
f_{x→y}(τ) = (f₁ * f₂ * … * fₙ)(τ) = Σ_t f₁(t) · f₂...ₙ(τ − t)
```

The path kernel CDF is the accumulation:

```
K_{x→y}(τ) = Σ_{t≤τ} f_{x→y}(t)
```

Asymptotic: K_{x→y}(∞) = Π p_i.

**Branching** (x→B→D and x→C→D, both reaching y): Each route r has
its own kernel density f_r(τ) (convolution of that route's per-edge
densities). The combined kernel density is the **sum** of per-route
densities (not a normalised mixture):

```
f_{x→y}(τ) = Σ_r f_r(τ)
```

This is correct because the routes are mutually exclusive given
arrival at x (a cohort member takes one route, not all). The
asymptotic K_{x→y}(∞) = Σ_r Π_{i∈r} p_i, which equals
`calculate_path_probability(x, y)` (already implemented via DFS with
memoisation in `path_runner.py`).

**Fan-in at intermediate node** (x→B→D and x→C→D, then D→y): The
density at D is the sum of per-route densities reaching D. The D→y
edge density is then convolved with this sum. This is handled
naturally by computing per-route path densities and summing.

**Single hop** (x→y is one edge): f_{x→y}(τ) = p · pdf(τ),
K_{x→y}(τ) = p · CDF(τ). Degenerates to the existing computation.

##### Convolution computation

Per-edge densities are shifted-lognormal. Their convolution has no
closed form. Two viable approaches:

1. **Numerical convolution on the tau grid** (recommended for Phase A):
   discretise each f_i onto the integer tau grid (0..max_tau), then
   convolve via standard discrete convolution (O(n²) per edge pair,
   O(n² · num_edges) total). For typical max_tau ≈ 200–400 and
   num_edges ≈ 2–5, this is trivially fast.

2. **Moment-matching approximation**: fit a single shifted-lognormal
   to the convolved density via matching of mean, variance, and onset.
   Faster but loses shape information (skew, multimodality from
   branching). Not recommended for Phase A.

Phase A uses approach 1. Each edge's shifted-lognormal pdf is
evaluated at integer tau values to produce a discrete density vector,
then standard discrete convolution composes the path.

##### Numerator formula

```
Y_y(s, τ) = Σ_u ΔX_x(s, u) · K_{x→y}(τ − u)
```

Where:
- `ΔX_x(s, u)` = incremental arrivals into x for cohort s at age u
  (from `x_provider` — see Layer 4)
- `K_{x→y}(τ)` = span kernel **CDF** (sub-probability, not density)

The convolution is with K (the CDF), not with f (the density). This
is correct because K_{x→y}(τ − u) is the probability that an arrival
at x at age u has reached y by age τ — a cumulative quantity. The
product `ΔX_x(s, u) · K_{x→y}(τ − u)` is the expected number of
those arrivals that have reached y by age τ. Summing over u gives
cumulative arrivals at y, which is what Y_y represents.

In window() mode, `ΔX_x` is a delta at τ=0, so the convolution
simplifies to `Y_y(s, τ) = X_x(s) · K_{x→y}(τ)`.

##### Computation: node-level DP (not path enumeration)

Enumerating all paths from x to y is exponential in the worst case on
wide DAGs. The correct approach is a **forward DP in topological
order**:

1. Topological sort nodes reachable from x that can reach y
2. Initialise: `g_x(τ) = δ(τ=0)` (unit impulse at x)
3. For each node v in topological order after x:
   `g_v(τ) = Σ_{edges u→v} (g_u * f_{u→v})(τ)`
   where `*` is discrete convolution and `f_{u→v}` is the per-edge
   sub-probability density
4. Result: `g_y = f_{x→y}`, the combined kernel density
5. Accumulate: `K_{x→y}(τ) = Σ_{t≤τ} g_y(t)`

This naturally handles branching (fan-out sums at convergence nodes)
and fan-in (multiple incoming edges contribute to g_v). Complexity is
O(|E| · max_tau²) — dominated by per-edge convolution on the tau grid.
For typical graphs (|E| ≈ 2–10, max_tau ≈ 200–400), this is trivially
fast.

##### SpanKernel interface

**New function**: `compose_span_kernel(graph, x_node_id, y_node_id,
is_window, max_tau) → SpanKernel`. The function runs the DP above.

The `SpanKernel` provides:
- `K(τ) → float`: the kernel CDF at tau (used in the numerator
  convolution — see below)
- `span_p`: asymptotic K(∞) = total conditional probability
- `tau_grid`: the discrete tau values the kernel is defined on

##### MC fan bands and frontier conditioning

The current row builder does not just apply the unconditional forecast.
For each cohort, it observes (y_observed, x_observed) up to
tau_observed, updates the prior (α₀, β₀) to a posterior via Bayesian
updating, then uses the posterior predictive for the forecast beyond
tau_observed. This is what makes the fan narrow around observed data
and widen into the future.

**Preservation rule: new operators, same sampler.** Phase A must keep
the current cohort-maturity forecasting discipline and only swap the
inner single-edge ingredients for richer span-level ones. In
particular, it must preserve:

- the observed/forecast splice at `tau_observed`
- the D/C decomposition (frontier survivors vs future arrivals)
- conditional late-conversion sampling for the D population only
- continuous expected-mass treatment of the C population (no Binomial
  noise on model-predicted future arrivals)
- posterior-draw fan generation and the current clipping/boundedness
  discipline

The approach:

1. **Per-cohort frontier conditioning**: At tau_observed, the composed
   evidence frames provide actual (y_at_y, x_at_x). Update the prior
   to posterior: `α_post = α₀ + y_observed`, `β_post = β₀ +
   (x_observed - y_observed)`.

   **In-transit approximation**: This update treats every arrival at x
   that hasn't reached y as a failure. For multi-hop spans, some of
   those arrivals are still in transit through intermediate nodes —
   they haven't failed, they just haven't had enough time. This is the
   **same approximation** as the current single-edge code (which also
   does not adjust for incomplete maturation at the frontier), but the
   effect is larger for multi-hop because more mass is in transit at
   any given tau_observed. The bias is conservative (overestimates
   failures, underestimates the rate), which is safe. A proper fix
   would use completeness-adjusted exposure:
   `x_effective = Σ_u ΔX_x(s, u) · K_{x→y}(tau_obs - u) / span_p`
   and update with `β_post = β₀ + (x_effective - y_observed)`. This
   is a potential Phase A+ improvement, not a Phase A blocker — it
   preserves adjacent-pair parity (where the approximation matches v1).

   **Empty evidence fallback**: If no composed evidence exists (no
   snapshots for the span), the entire chart is pure unconditional
   forecast with no frontier conditioning. This matches the current
   single-edge behaviour when no snapshots exist.

2. **Post-frontier forecast**: Use the posterior predictive with the
   span kernel's temporal shape. The updated rate replaces span_p in
   the forecast; the kernel's CDF shape provides the maturation curve.

3. **MC fan sampling**: Draw rate samples from `Beta(α_post, β_post)`.
   For each draw, forecast the immature portion using the span kernel's
   CDF shape. Aggregate across draws for quantile bands.

4. **Prior composition for multi-hop**: Phase A uses the last edge's
   `posterior_path_alpha/beta` as the span prior. These are already
   path-composed by the Bayes engine for the anchor→y path. When x = a
   this is exactly right. When x ≠ a it's an approximation (the prior
   reflects the a→y rate, not the x→y rate). This matches the single-
   edge behaviour for adjacent pairs (parity) and is adequate for
   Phase A. A more principled approach (method-of-moments from span_p
   + composed uncertainty) can be explored later.

5. **Latency-shape uncertainty for MC draws**: Phase A uses per-edge
   posterior SDs from the last edge's path-level values
   (`bayes_path_mu_sd`, `bayes_path_sigma_sd`, etc.). This
   underestimates true span uncertainty (ignores upstream edge
   uncertainty and cross-edge correlations) but matches the single-edge
   behaviour for adjacent pairs (parity). A per-draw reconvolution
   (draw per-edge params independently, reconvolve the kernel per MC
   sample) is the correct approach but adds O(num_draws × |E| ×
   max_tau²) cost. Recommend as a Phase A+ enhancement.

#### Layer 4: Row builder restructuring (Phase A — make the seam real)

The row builder (`compute_cohort_maturity_rows`) currently does three
things internally:

1. Resolves `edge_params` → edge-level or path-level mu/sigma/p/SDs
2. Computes x forecast: `reach(u) × CDF_upstream(τ)` (where u = last
   edge's source node)
3. Projects y from x using the edge kernel

Phase A introduces two explicit inputs:

- **`x_provider(s, τ) → float`**: returns the estimated cumulative
  arrivals at x for cohort s at age τ.
- **`span_kernel`**: the x→y conditional progression (Layer 3).

The row builder becomes a **composition layer** that applies the
numerator formula from Layer 3 and the frontier conditioning from
Layer 3's MC fan section. It stops hard-coding the single-edge
`p × CDF` ingredients; it does **not** replace the outer
cohort-maturity sampler.

**Why introduce x_provider in Phase A** (not Phase B): If Phase A
leaves x hidden inside the row builder, Phase B must refactor the row
builder *and* swap the implementation simultaneously. By extracting
x_provider now, Phase B only swaps the provider. The seam is real from
day one.

##### x_provider in Phase A

The x_provider must return **arrivals at x** (the query start node),
not arrivals at u or any other node. Feeding arrivals at u into a
kernel K_{x→y} that starts from x would double-apply the x→u portion
of the span. This is a correctness requirement, not an approximation.

**When x = a** (common case): arrivals at x = arrivals at the anchor
= `a_pop` (the cohort starting population). This is a constant for
all τ — there is nothing to model. The convolution
`a_pop · K_{a→y}(τ)` gives the correct numerator directly. No reach
computation, no CDF_upstream, no legacy estimate needed.

**When x ≠ a**: the x_provider needs to estimate how arrivals at x
grow with τ. This is genuinely the Phase B problem (anchor-to-x
propagation). For Phase A:
- **Observed region** (τ ≤ tau_observed): return actual `x_at_x` from
  composed evidence frames. Correct.
- **Forecast region** (τ > tau_observed): carry forward the last
  observed x value. This assumes x is mostly mature by tau_observed
  (reasonable when x is well upstream of y). Documented as an
  approximation.

**Window mode**: `x_provider` returns a constant for all τ (the
observed x from the evidence frame, which equals `a_pop` when x = a).

**Cohort mode, x = a**: `x_provider` returns `a_pop` for all τ.
Trivially correct. No legacy estimate involved.

**Cohort mode, x ≠ a**: Two-regime behaviour (observed, then carry-
forward). Phase B replaces the forecast-region implementation with a
proper a→x propagation solve.

##### What the row builder does

For each cohort s:
1. Call `x_provider(s, τ)` to get X_x(s, τ) for all τ — this is
   arrivals at x (when x = a: simply a_pop; when x ≠ a: observed
   then carry-forward)
2. Use the observed prefix exactly as today: actual `(x_obs, y_obs)` up
   to `tau_observed`, forecast only beyond the frontier
3. Split the immature region exactly as today into:
   - **D**: frontier survivors already at x by `tau_observed`
   - **C**: future arrivals to x after `tau_observed`
4. For **D**, use the span kernel in the same conditional style as the
   current code:
   `q_late(τ) = (K(τ) - K(tau_observed)) / (1 - K(tau_observed))`
   and preserve the existing sampling discipline (`none` / `normal` /
   `binomial`)
5. For **C**, treat future arrivals as model-predicted mass, not as
   observed Binomial trials. Combine arrival increments `ΔX_x` with the
   span kernel to get expected future `y`; do not introduce Binomial
   noise for this term
6. Combine observed prefix + forecast suffix, clip `y` into `[0, x]`,
   and preserve cumulative monotonicity / boundedness as in v1
7. MC fan: draw posterior rate samples (and latency-shape uncertainty
   where enabled), forecast per draw, aggregate quantiles

#### Layer 5: Frontend — chart rendering

No changes needed. The row schema is the same. The chart builder does
not know or care whether the rate is edge-level or span-level.

Cosmetic change: chart title/subtitle should indicate span rate (x→y)
rather than edge rate. Driven by the `subjectLabel` field already
present in the subject metadata.

### Implementation strategy: new analysis type

Phase A is implemented as a **new analysis type** (`cohort_maturity_v2`
or similar) rather than modifying the existing `cohort_maturity`:

1. **Zero regression risk** — existing `cohort_maturity` untouched.
2. **Built-in parity test** — run both types on the same adjacent
   `from(x).to(y)` subject via CLI; assert identical output.
3. **Visible from day one** — full FE+BE registration per the
   adding-analysis-types checklist. Testable in browser and via
   `graph-ops/scripts/analyse.sh --type cohort_maturity_v2`.
4. **CLI parity tooling** — extend `graph-ops/scripts/parity-test.sh`
   or write a dedicated script that runs both types and diffs output.

Once parity is proven and multi-hop is working, either retire the old
type (rename v2 → `cohort_maturity`) or keep both.

### Implementation sequence

| Step | What | Depends on | Risk |
|------|------|-----------|------|
| **A.0** | Register `cohort_maturity_v2` — full FE+BE per adding-analysis-types checklist. Reuse `cohort_maturity` ECharts builder. BE handler initially clones existing pipeline. | — | Low |
| **A.1** | `compose_path_maturity_frames()` — evidence frame composition. Handles all topologies (branching at x, fan-in at y). Uses canonical denominator carrier rule. | — | Medium: join alignment |
| **A.2** | `compose_span_kernel()` — conditional x→y kernel via numerical convolution of per-edge sub-probability densities on tau grid. Route enumeration + summation for branching. | — | Medium: DAG traversal + convolution |
| **A.3** | Extract `x_provider(s, τ)` — a_pop when x = a, observed + carry-forward when x ≠ a. Extract row builder as composition layer **while preserving the current D/C decomposition, frontier conditioning, sampling modes, clipping discipline, and MC fan behaviour**. Uses last edge's path alpha/beta for prior, last edge's path SDs for MC uncertainty. | A.0, A.1, A.2 | High: row builder refactor + frontier conditioning |
| **A.4** | **Single-hop parity gate**: v1 vs v2 on adjacent subjects, field-by-field. Real graph data. | A.3 | Required gate |
| **A.5** | **Multi-hop tests**: evidence parity (all topologies) + forecast convergence (τ→∞, rate→span_p) + frontier conditioning (fan narrows at observed data, widens into future) | A.1, A.2, A.3 | Required gate |

### How this feeds forward

| Phase | What it does | What it does NOT touch |
|-------|-------------|----------------------|
| **A** (span kernel) | New `span_kernel` (full DAG, incl. branching) + `x_provider` interface (a_pop when x = a, observed + carry-forward when x ≠ a). Fixes y projection for all multi-hop topologies. | Does not improve x estimation for x ≠ a beyond carry-forward. |
| **B** (x provider) | Swaps `x_provider` implementation for proper a→x propagation when x ≠ a. Frontier continuity. Completeness-adjusted frontier conditioning. | Does not change span kernel. |
| **0–6** (forecast engine) | Generalises both kernel and provider for all consumers. | — |

### Appendix: legacy key set (transitional)

During the transition from the existing row builder to the new
composition layer, the SpanKernel may need to provide a legacy-
compatible dict for code paths not yet refactored. This is a
**transitional** concern — the target interface is `K(τ)`, `f(τ)`,
`span_p`, and the MC fan parameters defined in Layer 3.

The legacy keys, sourced from `_read_edge_model_params`
(`api_handlers.py` lines 760–880), consumed at lines 390–418 of
`cohort_forecast.py`:

Edge-level: `mu`, `sigma`, `onset_delta_days`, `forecast_mean`,
`posterior_p`, `posterior_alpha`, `posterior_beta`, `p_stdev`,
`bayes_mu_sd`, `bayes_sigma_sd`, `bayes_onset_sd`,
`bayes_onset_mu_corr`, `t95`, `evidence_retrieved_at`.

Path-level: `path_mu`, `path_sigma`, `path_onset_delta_days`,
`posterior_p_cohort`, `posterior_path_alpha`, `posterior_path_beta`,
`p_stdev_cohort`, `bayes_path_mu_sd`, `bayes_path_sigma_sd`,
`bayes_path_onset_sd`, `bayes_path_onset_mu_corr`, `path_t95`.

The row builder selects edge-level or path-level based on `is_window`
(lines 393–418). Once the row builder is fully refactored to use the
SpanKernel interface directly, these legacy keys are no longer needed.

### Note: cross-edge regime coherence (doc 30)

Doc 30's per-edge regime selection guarantees one coherent regime per
(edge, anchor_day, retrieved_at). For multi-hop composition, different
edges need **not** use the same regime. The composition takes arrivals
at x from x-incident edges and arrivals at y from y-incident edges.

This is an approximation, not a proof of correctness: if different
edges' regimes report different populations for the same cohort (e.g.
because contexted and uncontexted retrievals produce different x
values at x-incident edges), the "take the maximum" heuristic in
`compose_path_maturity_frames` may produce inconsistent denominators.
Per-edge regime coherence (doc 30) ensures no double-counting *within*
an edge, but does not guarantee cross-edge population consistency.
In practice the effect is small because regime selection within
`mece_dimensions` constrains the context decomposition to be
compatible across edges. This approximation should be monitored
during multi-hop acceptance testing (Phase 0.2).

### Note: docs 30+31 are implemented

The BE resolves path structure natively from the DSL string via
`graph_select.py`. No FE patch fields (`from_node_uuid`, etc.) are
needed. CLI testing via `graph-ops/scripts/analyse.sh --type
cohort_maturity_v2` provides end-to-end development testing.

---

## Recommended Sequencing

| Phase | What | Why this order |
|-------|------|----------------|
| **A** | **Span kernel**: register `cohort_maturity_v2`. Implement `compose_path_maturity_frames` + `compose_span_kernel` (node-level DP, full DAG incl. branching). Introduce `x_provider(s, τ)` (a_pop when x = a; observed + carry-forward when x ≠ a). Row builder becomes composition layer with frontier conditioning and MC fan. | Numerator-only fix. Full fix in window(). Correct numerator in cohort(). x trivially correct when x = a (common case). |
| **B** | **x provider**: swap `x_provider` implementation for proper a→x propagation. Frontier continuity. | Denominator improvement only. Span kernel untouched. |
| **0** | Design forecast-state contract, informed by A+B | Forces precision on building blocks |
| **1** | Record live cohort() approximations precisely | Prevents contract from freezing stale assumptions |
| **2** | Fix remaining cohort() maths in Python | Hard prerequisite for reusable engine |
| **3** | Implement contract + unify basis resolution | Backend-first |
| **4** | Wire `cohort_maturity` to new contract | First consumer validates |
| **5** | Wire `surprise_gauge`, retire FE duplication | Second consumer proves reusability |
| **6** | Parity and contract tests | Gate for promotion |

---

## Acceptance Criteria

1. **Adjacent-pair parity**: `cohort_maturity_v2` on `from(x).to(y)`
   where x→y is a single edge produces identical output to
   `cohort_maturity`, field by field.

2. **Multi-hop parity** (all topologies): `cohort_maturity_v2` on
   `from(x).to(y)` across multiple hops — including branching and
   fan-in — produces results consistent with manual composition of
   per-edge evidence and forecast.

3. **x_provider extraction correctness**: v2's `x_provider(s, τ)`,
   when called with the same cohort and tau, returns values identical
   to v1's internally-computed x values. This tests that the
   extraction was correct, not that identical code produces identical
   results.

4. **x_provider correctness test**: A test on a multi-hop span
   verifying: (a) when x = a, x_provider returns a_pop for all τ,
   (b) when x ≠ a, x_provider returns observed x to the frontier then
   carry-forward beyond, (c) the convolution Y_y = ΔX_x * K produces
   the correct unconditional forecast.

5. **Sampling-discipline parity**: For adjacent pairs, v2 preserves the
   existing cohort-maturity sampler: observed/forecast splice at the
   frontier, D/C decomposition, no Binomial noise on model-predicted
   future-arrival mass, and fan-band behaviour consistent with v1.

---

## Bottom Line

Phase A fixes the conditional x→y progression over the full downstream
DAG (including branching and joins). Phase A does not change the
denominator model. Phase B replaces the denominator model.

Phase A introduces two explicit inputs to the row builder:

- **`x_provider(s, τ)`** — arrivals at x. When x = a (common case):
  `a_pop` for all τ (trivially correct, no modelling needed). When
  x ≠ a: observed arrivals to the frontier, carry-forward beyond.
- **`span_kernel` K_{x→y}(τ)** — the conditional x→y progression,
  computed via node-level DP (forward convolution of per-edge
  sub-probability densities through the DAG in topological order)

**New operators, same sampler**: the row builder keeps the current
cohort-maturity forecasting discipline — observed/forecast splice,
D/C decomposition, conditional sampling for frontier survivors only,
continuous treatment of future-arrival mass, posterior-draw fan bands,
and clipping/boundedness. What changes is only the inner input pair:
`x_provider(s, τ)` for arrivals at x and `span_kernel K_{x→y}(τ)` for
conditional progression from x to y.

Phase B swaps the x_provider's implementation for x ≠ a with a proper
a→x propagation solve, and introduces completeness-adjusted frontier
conditioning. The span kernel and row builder structure are untouched.

In window() mode, Phase A is the full fix. In cohort() mode with
x = a (common case), Phase A is also the full fix. In cohort() mode
with x ≠ a, Phase A uses carry-forward for x beyond the frontier —
an approximation resolved by Phase B.

**Known approximations in Phase A** (all inherited from or analogous
to current single-edge code; none block adjacent-pair parity):
1. Frontier conditioning treats in-transit arrivals as failures (same
   as v1; worse for multi-hop; completeness-adjusted update is a
   Phase A+ improvement)
2. Prior α₀/β₀ from last edge's path alpha/beta (matches v1 for
   adjacent pairs; approximate for multi-hop)
3. MC latency-shape SDs from last edge's path-level values
   (underestimates span uncertainty; per-draw reconvolution is a
   Phase A+ improvement)
4. x carry-forward when x ≠ a (only affects the uncommon x ≠ a case)

---

## Cross-cutting: shared forward-model primitive (doc 36)

The forecast engine's core computation — evaluating `ShiftedLogNormal`
CDF at retrieval ages and deriving conditional hazard
`q_j = p × ΔF / (1 - p × F_prev)` to produce predictive counts — is
also needed by the posterior predictive calibration checker (doc 36).
PPC evaluates the same forward model pointwise against observed data
to check whether the model's stated uncertainty intervals have honest
coverage.

As the engine generalises (Steps 4-6), extracting a pure-Python
`evaluate_edge_predictive(age, p, mu, sigma, onset, kappa, kappa_lat, n)`
function into a shared `compiler/predictive.py` module would serve
both consumers: the forecast engine calls it to project forward, the
calibration checker calls it to assess backward. This is the
numpy-level forward model, distinct from the PyTensor computation
graph in `model.py`.
