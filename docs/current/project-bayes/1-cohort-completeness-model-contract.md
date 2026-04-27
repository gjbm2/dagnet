# Project Bayes: Cohort completeness model contract

**Historical note (`27-Apr-26`)**: this contract pre-dates the removal of the quick BE topo pass (24-Apr-26). The reference below to deleting `forecastingParityService.ts` "entirely" is now landed; the parity service no longer exists. See [project-bayes/73b](73b-be-topo-removal-and-forecast-state-separation-plan.md) for the current BE surface. The cohort-completeness contract itself is independent of that pipeline topology and remains applicable.

**Status**: Draft  
**Date**: 11-Mar-26  
**Purpose**: Define the contract for `cohort()` completeness, forecasting, and
chart inspection so that current runtime analysis, pre-Bayes model fitting, and
future Bayes artefacts all use congruent semantics grounded in the data we
actually have.

**Related**: `programme.md` (programme), `0-high-level-logical-blocks.md` (Logical blocks), `../project-db/analysis-forecasting.md`, `../cohort_latency_params.md`

**Phase naming**: this doc uses internal numbering (Phase 1, 2, 2.5, 3).
The programme doc uses descriptive names. Mapping:

| This doc | Programme |
|---|---|
| Phase 1 | Evaluator unification |
| Phase 2 | Python model ownership |
| Phase 2.5 | FE stats deletion |
| Phase 3 | Bayesian inference |

---

## 1. Why this note exists

We have uncovered a real semantic problem in the current `cohort()` modelling:

- `window()` and `cohort()` are answering different latency questions, but the
  system has not represented that difference consistently.
- Runtime completeness logic and cohort maturity chart overlays are not
  currently congruent.
- The chart is supposed to let the user inspect whether the model matches the
  observed evidence. If the chart and the analysis logic use different model
  semantics, the chart becomes actively misleading.

This note reframes the problem as part of the architecture needed for Project
Bayes rather than as an isolated chart defect.

---

## 2. Core distinction: canonical edge models vs derived path models

### 2.1 `X→Y` is the canonical fast-learning model

For an edge-level conversion, the canonical latency model is the `X→Y` model.
This is the model that should:

- train earliest from fresh evidence
- update frequently as new evidence arrives
- underpin `window()` forecasting
- remain valid even if upstream topology changes

Conceptually:

- `T_edge = delta_edge + X_edge`
- `delta_edge` is deterministic onset / dead-time
- `X_edge` is stochastic post-onset lag

The persisted `X→Y` contract is therefore the right home for:

- `mu`
- `sigma`
- `onset_delta_days`
- `t95`
- training and provenance metadata

### 2.2 `A→Y` is a cohort application model

For `cohort()` semantics, the relevant question is not "how long after reaching
`X` do users convert to `Y`?" but "how long after entering at anchor `A` do
users convert to `Y`?"

That requires a path-level model:

- `T_path = T(A→Y) = sum(T_edge_i) = delta_path + X_path`

So `cohort()` needs an `A→Y` description, but that description is not an
intrinsic edge contract in the same way as `X→Y`. It depends on:

- anchor identity
- upstream topology
- join policy
- current upstream `X→Y` model state
- available path-level evidence

This makes `A→Y` a derived cohort application model, not the primary semantic
identity of the edge.

---

## 3. Required invariant

This is the invariant the system must satisfy:

- for any `cohort()` analysis, the analysis logic and the chart overlay must use
  the same chosen `A→Y` model source and the same evaluator
- for any `window()` analysis, the analysis logic and the chart overlay must use
  the same chosen `X→Y` model source and the same evaluator

Corollaries:

- there must be exactly one semantic evaluator for `cohort()` completeness
- charting must not reinterpret model variables differently from analysis
- onset must be applied consistently as part of the model contract, not as an ad
  hoc display tweak
- the runtime must always know what kind of `A→Y` model it is applying, not
  merely whether some path scalars happen to be present on the graph

---

## 4. Data reality: what we actually have, and when

The architecture must be designed around the evidence that actually exists in
the app, not around idealised data we wish we had.

### 4.1 What exists at fetch time

For a 3-step `A→X→Y` funnel query, Amplitude returns the following fields that
the system actively uses (extracted via JMESPath/JSONata in
`connections.yaml`):

**Counts:**

- `cumulativeRaw` — user counts at each funnel step. For a 3-step funnel:
  `[A_count, X_count, Y_count]`. Extracted as `A`, `X` (from-step), `Y`
  (to-step).
- `dayFunnels.series` — per-anchor-day counts at each step.
  `series[dayIdx][stepIdx]` gives the count for that day and step. Transformed
  into per-day `n` (from-count) and `k` (to-count) records.

**Lag moments (aggregate):**

- `medianTransTimes` — aggregate median transition times in milliseconds per
  step. For `A→X→Y`: index 0 is `A→X` median, index 1 is `X→Y` median.
  Converted to days: `median_lag_days` (for `X→Y`) and
  `anchor_median_lag_days` (for `A→X`).
- `avgTransTimes` — aggregate mean transition times in milliseconds per step.
  Same indexing. Converted to `mean_lag_days` and `anchor_mean_lag_days`.

**Lag moments (per anchor day):**

- `dayMedianTransTimes.series` — per-day median transition times.
  `series[dayIdx][stepIdx]` = median milliseconds for that step on that day.
  Converted to days and placed in per-day `median_lag_days`.
- `dayAvgTransTimes.series` — per-day mean transition times. Same structure.
  Converted to per-day `mean_lag_days`.

**Lag distribution (histogram):**

- `stepTransTimeDistribution` — histogram of transition time distribution per
  step. Contains bins with `start` (ms), `end` (ms), and `bin_dist` (with
  `uniques`, `sums`, `totals`). Used for onset estimation and lag CDF fitting.

**What Amplitude returns but the system discards:**

- `cumulative` — normalised conversion rates (0–1). Redundant with
  `cumulativeRaw`.
- `converted`, `dropoff`, `excludedDropoff` and their `ByDay` variants —
  per-user conversion/dropoff tracking.
- `convertedCounts`, `dropoffCounts` and their `Total`/`Unique` variants —
  aggregate count breakdowns.
- `stepPrevStepCountDistribution`, `avgPrevStepCounts`,
  `medianPrevStepCounts` — distribution of users by previous step count.
- `dayFunnels.isComplete` — completion flag per day.
- All top-level metadata (`wasCached`, `novaRuntime`, `costMetadata`, etc.).

**Important limitations of the histogram data:**

The `stepTransTimeDistribution` histogram is bounded by Amplitude's conversion
window. For long-latency conversions (weeks to months), the histogram only
covers a short horizon near the start and does not reveal the full long-tail
shape. The per-day lag moment data (`dayMedianTransTimes`, `dayAvgTransTimes`)
is available for all days but provides only two summary statistics (median and
mean) per day, not the full distribution.

This means the durable long-tail signal must come from repeated snapshot
observations over time, not from a single fetch's histogram.

### 4.2 What is persisted into snapshot DB

The snapshot DB persists repeated observations over time for the same anchored
cohorts. This is the durable evidence layer for pre-Bayes and Bayes fitting.

Per snapshot row, the DB currently preserves:

- `A`, `X`, `Y`
- `median_lag_days`, `mean_lag_days`
- `anchor_median_lag_days`, `anchor_mean_lag_days`
- `onset_delta_days`
- `anchor_day`
- `retrieved_at`

This means the durable long-tail signal is not a full histogram. It is the
panel of repeated observations:

- same `anchor_day`
- observed at successive `retrieved_at`
- with `Y / X` increasing as the cohort matures

That repeated snapshot panel is the core persisted censoring evidence for
`A→Y`.

### 4.3 What does not exist durably today

**Not available from Amplitude at all:**

- Direct `A→Y` lag summaries — Amplitude reports `A→X` and `X→Y` transition
  times separately in a 3-step funnel. Path-level timing must be derived by
  composition.
- Path-route identity through joins — Amplitude has no knowledge of graph
  topology.

**Exists transiently at fetch time but not persisted:**

- `stepTransTimeDistribution` histogram bins — used for onset derivation
  then discarded; only the scalar `onset_delta_days` survives. Persisting
  the bins would allow re-fitting onset with different parameters and give
  an empirical CDF for short-horizon edges. However, the histogram is
  bounded by Amplitude's conversion window and does not reveal the long-tail
  shape — the snapshot panel (§4.2) is the correct long-tail evidence.

The pre-Bayes architecture must not assume that later analysis can
reconstruct a full path distribution from the DB alone. The durable
evidence is the snapshot panel of repeated `(anchor_day, retrieved_at,
Y/X)` observations.

### 4.4 Immediate consequence

The model contract must be built around three realities:

- `X→Y` evidence learns fastest
- `A→Y` censoring evidence accumulates over repeated snapshots
- some useful fetch-time information is currently discarded and should be
  persisted if we want better pre-Bayes path fitting

---

## 5. Why this matters for forecasting

The value of the canonical `X→Y` model layer is that it learns fast:

- `X→Y` evidence arrives sooner than the full `A→Y` maturity curve is visible
- this lets the system react quickly when the local edge starts completing
  faster or slower than expected

We do not want to lose that property by moving everything to a slow,
topology-bound `A→Y` world.

So the right architecture is not "replace `X→Y` with `A→Y`", but:

- keep `X→Y` as the canonical fast-learning model family
- build `A→Y` as the cohort application layer
- let `A→Y` become more empirical as evidence accrues
- degrade gracefully back toward `X→Y`-driven priors when path evidence is thin

This same principle should hold both pre-Bayes and in a future Bayes world.

---

## 6. Bayes-world target

In a proper Bayes world, the system should not treat `A→Y` cohort rows as mere
display evidence.

The model should use:

- canonical `X→Y` edge evidence
- incomplete `A`-anchored cohort rows
- mature `A`-anchored cohort rows
- topology-defined path composition

The key contract is:

- `X→Y` remains the canonical latent model family
- `A→Y` path behaviour is a deterministic path-level application of those edge
  latents for the current topology
- incomplete cohort rows enter the likelihood through completeness, not merely
  as chart dots

This matches the intended Bayes architecture described in
`0-high-level-logical-blocks.md`:

- path-level composition is deterministic, not an independent hierarchy level
- immature rows constrain both eventual conversion probability and path latency

So the long-term target is not "persist arbitrary path scalars and hope". The
target is:

- canonical edge models
- topology-aware path application
- path-level posterior summaries where helpful
- explicit provenance and fallback rules

---

## 7. Pre-Bayes target

Before Bayes, the system still needs a coherent `A→Y` model contract that uses
the evidence we actually have and degrades gracefully when that evidence is
weak.

### 7.1 Canonical ownership

Python should be the sole owner of model fitting and path-model derivation.

The frontend should be a pure applier for:

- analysis-time completeness evaluation
- chart overlays
- offline display of persisted model scalars

This follows the broader split already established in
`analysis-forecasting.md`:

- fitting belongs in Python
- application belongs to one semantic evaluator
- analysis requests must not refit models opportunistically

### 7.2 Why not dual FE and BE path derivation

If `A→Y` is derived independently in both frontend and backend, the system will
carry two implementations of:

- onset handling
- `A→X` plus `X→Y` composition
- tail constraints
- join handling
- completeness evaluation
- chart sampling

That drift risk is too high for this app, especially once joins and path
mixtures are considered.

So pre-Bayes should not be a dual-implementation runtime-composition system.

### 7.3 Why not wait for a full signature system

Phase 2 should not be blocked on inventing and validating a heavy new topology
signature system first.

Signatures may still be desirable later, but they are complex and costly to
build and test. They are not required to make progress now.

Instead, the pre-Bayes contract can use:

- Python-owned derived `A→Y` artefacts
- frontend application only
- aggressive stale marking and invalidation policy

This is weaker than proof-by-signature, but much simpler and more realistic for
an interim phase.

The rule is:

- without signatures, do not validate on read
- instead invalidate on write
- never silently treat stale `A→Y` artefacts as authoritative

---

## 8. How pre-Bayes `A→Y` should be fitted

The pre-Bayes path model should use both fast-learning edge evidence and slower
path evidence.

### 8.1 Inputs

For a target edge in `cohort()` mode, Python should use:

- canonical `X→Y` model vars
- fetched or persisted `A→X` anchor-relative lag summaries
- repeated snapshot rows for `A→X→Y` over successive `retrieved_at`

Concretely, the durable evidence is:

- local `median_lag_days`, `mean_lag_days`
- upstream `anchor_median_lag_days`, `anchor_mean_lag_days`
- per-cohort `X`, `Y`, `anchor_day`, `retrieved_at`

### 8.2 Prior path model

Build a path prior from the current best upstream and local evidence:

- fit or read `X→Y` canonical model
- estimate `A→X` from anchor-relative lag summaries
- compose them into an initial `A→Y` prior

In chain regions:

- deterministic onset adds across latency edges
- post-onset stochastic lag composes additively
- FW is an acceptable approximation for the initial path prior

At joins:

- the mathematically correct object is a weighted path mixture
- pre-Bayes may still collapse this to a practical approximation internally
- but that approximation should be treated as a prior, not as the final truth

### 8.3 Empirical path calibration

Use the repeated snapshot panel as the main empirical path-evidence source.

For each anchored cohort row:

- age is derived from `retrieved_at - anchor_day`
- observed fraction is `Y / X`
- that observed fraction is a censored view of the eventual `A→Y` completion
  rate

The pre-Bayes fitter should:

- estimate eventual path-level conversion rate from mature cohorts where
  possible
- use immature cohorts to constrain the path completion curve
- pull the fitted `A→Y` parameters toward the composed prior when data is thin

So the pre-Bayes path fit is not:

- pure direct `A→Y` fit ignoring `X→Y`

and not:

- pure synthetic composition ignoring actual `A→Y` cohort evidence

It is:

- a prior from `A→X` plus `X→Y`
- corrected by actual `A→Y` censoring evidence

### 8.4 What should be learnt strongly vs weakly

Pre-Bayes should learn most strongly from data where the evidence is durable and
realistic.

Strong learning target:

- `path_mu`
- `path_sigma`
- eventual path-level completion rate if the architecture needs it explicitly

More conservative target:

- `path_delta`

Reason:

- the system does not retain rich full-horizon onset evidence today
- short-horizon histogram data is incomplete and truncated
- onset should therefore remain more constrained by edge-level and fetch-time
  information than by heroic re-inference from sparse persisted summaries

---

## 9. Graceful degradation ladder

Any pre-Bayes or Bayes implementation must degrade gracefully by design,
especially for new graphs where little or no snapshot history exists yet.

### Level 0: cold start

Evidence available:

- canonical `X→Y` only
- maybe a little current fetch-time anchor information

Behaviour:

- build a provisional `A→Y` prior from topology and current edge models
- mark it as low-confidence and derived

### Level 1: fresh graph, weak path evidence

Evidence available:

- current fetched `A→X→Y` cohort rows
- little or no repeated snapshot history

Behaviour:

- start from the composed prior
- allow weak empirical correction from current fetched `A`-anchored evidence
- still treat the result as prior-dominated

### Level 2: enough snapshot panel to calibrate

Evidence available:

- repeated `(anchor_day, retrieved_at)` observations for the same cohorts

Behaviour:

- use the snapshot panel as the main path calibration signal
- produce a genuinely evidence-informed `A→Y` fit

### Level 3: Bayes posterior

Evidence available:

- full canonical edge evidence
- repeated snapshot panel
- incomplete and mature cohort evidence in the likelihood

Behaviour:

- infer posterior edge models
- apply topology-aware path composition
- emit posterior `A→Y` summaries

### Required operational rule

The runtime must always know which level produced the current `A→Y` artefact.

At minimum, the model source should be explicit:

- composed prior
- prior plus current fetch
- snapshot calibrated
- Bayes posterior

This is necessary so the UI and runtime do not silently present a weak prior as
if it were a mature path fit.

---

## 10. What should be persisted additionally

### 10.1 What Amplitude actually provides (and what we discard)

For a 3-step A→X→Y funnel, `stepTransTimeDistribution.step_bins` contains
**four** entries:

| Index | Content | Currently used? |
|-------|---------|-----------------|
| `step_bins[0]` | Entry step (trivial) | No |
| `step_bins[1]` | A→X transition histogram | No — discarded |
| `step_bins[2]` | X→Y transition histogram | Yes — onset extraction only |
| `step_bins[3]` | A→Y overall histogram | No — discarded |

We currently extract `step_bins[to_step_index]` (= X→Y) and use it solely
to derive the scalar `onset_delta_days`. The raw bins are then discarded.

### 10.2 Why histogram bins are not worth persisting

The histogram data is bounded by Amplitude's conversion window (~10 days).
For a real A→X edge, the reference data shows:

- Days 3–9: 421 uniques with granular per-day counts (29% of mass)
- Day 10+: 1,029 uniques in a single catch-all bucket (71% of mass)

This means the histogram's value is **edge-dependent**: for fast edges where
the bulk of mass falls within ~10 days, it captures useful shape; for slow
edges it is dominated by the catch-all and adds nothing beyond the scalars.

Persisting the bins was considered and rejected on several grounds:

- **Storage mismatch.** The histogram is aggregate-per-fetch, not
  per-anchor-day. The snapshots table is keyed per-anchor-day. Storing it
  requires either redundant JSONB on every row or a new table — neither is
  clean.
- **Unpredictable utility.** Whether the histogram is informative depends on
  the edge's latency relative to the conversion window. The architecture
  would need to handle both useful and useless histograms gracefully, meaning
  two code paths regardless.
- **Snapshot panel supersedes it.** Once snapshots accrue (~10 days), the
  daily `(anchor_day, retrieved_at, Y/X)` panel provides strictly richer
  censoring evidence. The histogram's value window is only the first ~10
  days before snapshots accrue.
- **Bayesian integration is not straightforward.** Truncated histogram bins
  can be expressed as a multinomial likelihood, but by the time a Bayesian
  model is sophisticated enough to consume them, it will already be
  consuming the snapshot panel — which is better evidence for the same
  purpose.

### 10.3 Current use: onset derivation

The X→Y histogram (`step_bins[to_step_index]`) is used at fetch time to
derive `onset_delta_days` — the minimum delay before conversions begin. This
is the correct use of the data: extract the durable scalar insight, discard
the raw bins.

### 10.4 Recommendation: derive and persist A→X onset

The A→X histogram (`step_bins[from_step_index]`) is available at fetch time
for 3-step funnels but currently discarded entirely. We should apply the
same onset derivation to it, producing a scalar `anchor_onset_delta_days`.

**Extraction change** (connections.yaml):

```yaml
- name: anchor_lag_histogram
  jsonata: "step_trans_time_distribution.step_bins[$number($queryPayload.from_step_index)]"
```

Then run `deriveOnsetDeltaDaysFromLagHistogram()` on it at fetch time, persist
only the scalar. For 2-step funnels `from_step_index = 0` gives the trivial
entry step, so onset derivation correctly returns null.

**Persistence:** one new nullable column on the `snapshots` table —
`anchor_onset_delta_days FLOAT` — mirroring the existing `onset_delta_days`
column. Same per-row redundancy pattern. Also add the field to
`SnapshotRow` (snapshotWriteService.ts) and `LatencyConfig` (graph_types.py).

**Backwards compatibility:** older snapshot rows will have `NULL` for this
column. All consumers must treat missing `anchor_onset_delta_days` as
"not available" and fall back to user-space A→X fitting (onset = 0) — which
is exactly what they do today. No regression for existing data.

**Why this matters for path composition:**

Currently the A→X leg is fitted from just two scalars
(`anchor_median_lag_days`, `anchor_mean_lag_days`) with no onset — implicitly
assuming onset = 0. With `anchor_onset_delta_days` we can fit a proper
shifted lognormal in model-space:

```
mu_ax  = ln(anchor_median - anchor_onset)
sigma_ax = sqrt(2 * ln(mean_model / median_model))
```

This is the same fitting method used for X→Y edges, applied to the anchor
leg. It feeds directly into FW convolution with a properly shifted A→X
distribution.

**What NOT to persist:** the raw histogram bins. The scalar onset is the
durable insight; the bins are bounded by the conversion window and superseded
by the snapshot panel once it accrues. No additional histogram persistence
is proposed for A→X, X→Y, or A→Y.

---

## 11. Phase plan

### Phase 1: make the current system semantically honest

Goal:

- restore congruence between analysis logic and cohort maturity charts

What this phase must achieve:

- no more zero-onset reinterpretation of path models
- one evaluator for `cohort()` completeness and charting
- explicit provenance for which model source is being applied

This phase is about semantic correctness, not yet about changing the broader
model ownership pattern.

### Phase 2: Python-owned persisted `A→Y` without mandatory topology signatures

Goal:

- move `A→Y` derivation and fitting into Python
- keep the frontend as a pure applier

Policy:

- do not gate this phase on a new signature system
- use stale marking and invalidation policy rather than proof-by-signature
- never silently apply stale `A→Y` as if it were current

What this phase should include:

- persisted path-model vars
- model-source grade
- stale flag or equivalent invalidation metadata
- better persistence of fetch-time evidence when it materially improves fitting

### Phase 3: richer model structures and optional stronger validation

Goal:

- formalise the long-term Bayes-compatible model architecture

This phase is where the system can decide whether it needs:

- explicit topology signatures
- richer provenance structures
- cleaner separation between canonical edge models and optional path summaries

This phase should happen after the semantics and operational behaviour are
proven in practice, not before.

---

## 12. Design principles to preserve

- `X→Y` remains the canonical fast-learning model family.
- `A→Y` is a cohort application model whose validity depends on topology,
  upstream model state, and available path evidence.
- Analysis logic and chart logic must always use the same evaluator for the same
  selected model source.
- The architecture must reflect the data that actually exists, not idealised
  full-horizon histogram data that is unavailable in practice.
- Repeated snapshot observations over successive `retrieved_at` are the primary
  durable path-maturity evidence.
- If fetch time exposes useful evidence that is currently discarded, the upgrade
  should preserve it.
- Pre-Bayes and Bayes systems must both degrade gracefully when path evidence is
  weak.
- The runtime must prefer explicit provenance and fallback rules over silent
  reinterpretation.

---

## 13. Immediate implication for the current defect

The current cohort maturity chart problem should be treated as a symptom of a
larger contract failure:

- the wrong question is not merely "why does the curve start too early?"
- the right question is "what is the authoritative `cohort()` model contract,
  what evidence does it use, and are analysis and charting using the same one?"

The current answer should not be:

- derive more runtime path maths in both frontend and backend

The better direction is:

- make the semantics honest now
- move path ownership toward Python
- use the snapshot panel as the durable `A→Y` evidence base
- preserve additional fetch-time evidence where it will materially improve later
  fitting

That is the minimum architectural work needed to make `cohort()` analysis
trustworthy and to keep the system on a sensible path toward Bayes.

### 13.1 Concrete divergences identified in the current codebase

Three distinct semantic divergences exist:

**Divergence 1: BE annotation vs BE chart CDF**

`api_handlers.py` lines 636–639 annotate cohort maturity data points
(`annotate_rows()`) using edge-level `mu`, `sigma`, `onset_delta_days` in all
modes — even in cohort mode. Lines 674–692 of the same file generate the chart
CDF overlay and correctly branch: in cohort mode it uses `path_mu`/`path_sigma`
when available, falling back to edge params otherwise.

Result: the chart overlay shows an `A→Y` model curve, but each data point's
completeness and layer classification use the `X→Y` model. The dots and the
curve are on different time scales.

**Divergence 2: FE evaluator vs BE evaluator**

The frontend LAG pass (`statisticalEnhancementService.ts` lines 2460–2518)
computes its own `A→Y` completeness via Fenton–Wilkinson composition
(`approximateLogNormalSumFit`) and `calculateCompletenessWithTailConstraint`,
producing `completenessMode='cohort_path_anchored'`. This is entirely
independent of the backend's `compute_completeness()` in
`forecast_application.py`. The two evaluators use different inputs, different
tail-constraint logic, and different onset handling.

**Divergence 3: onset handling is incorrect for path params**

The backend chart CDF (`api_handlers.py` line 686) sets `cdf_onset = 0.0` when
using path params, with the comment "path params already incorporate upstream
delay". This is wrong.

Tracing through the code: the FE edge fitting is in **model-space**
(`statisticalEnhancementService.ts` line 1030–1031):

```
toModelSpace(onsetDeltaDays, aggregateMedianLag, aggregateMeanLag)
fitLagDistribution(model.medianXDays, model.meanXDays, ...)
```

The median and mean have onset subtracted *before* fitting. So
`latencyStats.fit.mu = ln(median_T - onset_E)` — model-space.

The FW composition at line 2482 combines:
- `anchorFit`: user-space `A→X` moments (includes upstream onsets implicitly)
- `latencyStats.fit`: model-space `X→Y` (onset subtracted)

The result represents the distribution of `(A→X_user + X→Y_post_onset)` — it
does **not** include the target edge's onset.

The FE correctly compensates at line 2507: it passes `edgeOnsetDeltaDays` to
`calculateCompletenessWithTailConstraint`, effectively computing
`CDF(age - edge_onset, path_mu, path_sigma)`. This is correct for a 2-hop path.

But in chains > 2 hops, a further problem appears: when `B→C`'s `pathMu`
propagates as `nodePathMu(C)`, it represents `(A→B_user + B→C_post_onset)`.
`B→C`'s onset is lost. When `C→Y` composes `FW(upstream, C→Y_model_space)`, the
result is `(A→B_user + B→C_post_onset + C→Y_post_onset)`. Only `C→Y`'s onset
is applied at evaluation. **Intermediate edge onsets are permanently lost.**

See §15.3 for the full analysis and proposed resolution.

---

## 14. Phase scope boundaries

### Phase 1: semantic honesty and evaluator unification

Phase 1 is about making the existing system internally consistent. It fixes
divergences 1 and 3 above. It does not move model ownership to Python.

**Phase 1 IS**:

- making BE annotation and BE chart CDF share the same parameter resolution
  logic (a single helper that selects mu/sigma/onset by mode)
- fixing onset handling for path params (use edge onset, not `0.0`)
- adding an explicit `query_mode` field to analysis requests (replacing fragile
  string matching on slice keys)
- adding provenance metadata to the analysis response so consumers can verify
  which model was applied

**Phase 1 IS NOT**:

- moving the FE completeness computation to Python (that is Phase 2)
- changing the FE LAG pass or its evaluator
- adding new fitting infrastructure
- fixing intermediate onset loss in chains > 2 hops (that requires `path_delta`
  propagation, which is Phase 2)
- fixing join handling (Phase 2)

**Phase 1 exit criterion**: for every `cohort_maturity` analysis response,
`completeness_model.mode == model_curve_params.mode` and
`completeness_model.onset_delta_days == model_curve_params.onset_delta_days`.

**Relationship to analysis-forecasting phases**: Phase 1 here is conceptually a
defect fix within the existing Phases 1–8 framework of `analysis-forecasting.md`.
It does not require new fitting infrastructure and can proceed independently of
the parallel-run soak.

### Phase 2: Python-owned `A→Y` with correct convolution

Phase 2 moves path-model derivation into Python with correct mathematical
treatment of chains and joins.

**Phase 2 IS**:

- Python computing the `A→Y` path model from snapshot evidence + `X→Y` edge
  models, with correct onset composition and mixture-based join handling
- Python publishing `(path_mu, path_sigma, path_delta)` and model-source grade
  through graph/parameter files for FE consumption
- FE becoming a pure applier (reads path model, does not derive it)
- MVP topology invalidation (stale-marking on write)
- porting the tail-constraint logic to Python
- porting `approximateLogNormalSumFit` to Python

**Phase 2 IS NOT**:

- full Bayes fitting (Phase 3)
- topology signatures (Phase 3)

**Phase 2 exit criterion**: FE LAG pass completeness computation removed. All
consumers (charting, commissioned analysis, inline analysis) use BE-published
`A→Y` model with consistent semantics.

### Phase 2.5: FE stats code cutover and deletion

Phase 2.5 is the final step of the FE→BE migration. Once Phase 2 exits
(FE LAG pass completeness computation removed, all consumers use BE-published
`A→Y` model), the FE statistical fitting code is dead and must be deleted.

This is explicitly part of project-bayes because:

- The Bayesian model (Phase 3) replaces the moment-based fitting that the FE
  code implements. Leaving the FE code in place creates confusion about which
  implementation is authoritative.
- The FE code is substantial (~4000+ lines across multiple files) and its
  continued presence inflates the code surface area, complicates refactoring,
  and risks accidental re-use.
- The cutover must happen before or early in Phase 3 so that Bayes development
  proceeds against a clean codebase where Python is the sole fitting owner.

**Phase 2.5 IS**:

- Completing the parallel-run soak (`analysis-forecasting.md` Phase 9) and
  confirming parity
- Disabling the FE topo/LAG fitting pass (`analysis-forecasting.md` Phase 10)
- Deleting the FE fitting codepaths (`analysis-forecasting.md` Phase 11):
  - `statisticalEnhancementService.ts` — remove fitting orchestration (~3200
    lines; retain only display helpers if any are still called)
  - `lagDistributionUtils.ts` — remove or delete entirely (pure maths layer;
    all fitting functions move to Python; assess whether any display-only
    functions remain needed)
  - `forecastingParityService.ts` — delete entirely (parallel-run comparison
    layer, no longer needed after cutover)
  - `lagRecomputeService.ts` — simplify (remove parallel-run comparison;
    retain the recompute API client)
  - `constants/latency.ts` — remove fitting-only constants; retain
    `buildForecastingSettings()` (still needed for API requests)
  - `utils/confidenceIntervals.ts` — assess; beta quantile and CI functions
    may still be needed for display
  - `lagMixtureAggregationService.ts` — assess; mixture quantile functions
    may move to Python if no FE consumer remains
  - `lagFitAnalysisService.ts` — assess; lag fit chart rendering may still
    need the fitted curve display (but reads params from graph, not fitting)
  - `lagHorizonsService.ts` — assess; horizon recomputation moves to BE
  - Related test files in `src/services/__tests__/` — update or remove as the
    code they test is deleted

**Phase 2.5 IS NOT**:

- Changing the BE fitting implementation (that is Phase 3)
- Removing `buildForecastingSettings()` or the API request contract (still
  needed by the BE)
- Removing display-only code that reads persisted model params from graph edges

**Phase 2.5 exit criterion**: no FE code path calls `fitLagDistribution`,
`computeEdgeLatencyStats`, `approximateLogNormalSumFit`, or any other fitting
function. Build and lint confirm zero references to deleted functions. Full
test suite passes with reduced code surface.

**Detailed plan**: `../project-db/analysis-forecasting.md` §7.5 (Cutover) and
§7.6 (Cleanup), and `../project-db/analysis-forecasting-implementation-plan.md`
Phases 10–11.

### Phase 3: Bayes-compatible model structures

Phase 3 formalises the model architecture for Bayesian inference. It includes
topology signatures, richer provenance, and the transition from FW
approximation to exact MCMC-based path composition.

Phase 3 should happen after the pre-Bayes semantics and operational behaviour
are proven in practice, and after the FE stats code has been deleted (Phase
2.5).

---

## 15. `A→Y` path model derivation — the maths

This section specifies the mathematical foundation for path-level model
derivation. It must be self-contained enough that an implementer can code from
it.

### 15.1 Edge-level lognormal model (review)

The canonical edge model is:

```
T_edge = delta_edge + X_edge
```

where:
- `delta_edge >= 0` is deterministic onset (dead-time before any conversions)
- `X_edge ~ LogNormal(mu, sigma)` is the stochastic post-onset lag

Fitting from observed data:
- The data source reports `median_T` and `mean_T` in user-space (calendar days
  including onset)
- Convert to model-space: `median_X = max(eps, median_T - delta)`,
  `mean_X = max(eps, mean_T - delta)`
- Fit: `mu = ln(median_X)`, `sigma = sqrt(2 * ln(mean_X / median_X))`

Completeness evaluation:
```
P(T_edge <= t) = P(delta + X <= t) = P(X <= t - delta)
               = CDF_LN(max(0, t - delta), mu, sigma)
```

Already implemented:
- Fitting: `lag_distribution_utils.py:fit_lag_distribution()`
- Evaluation: `forecast_application.py:compute_completeness()`
- FE fitting: `statisticalEnhancementService.ts:computeEdgeLatencyStats()` calls
  `toModelSpace()` then `fitLagDistribution()`

### 15.2 Fenton–Wilkinson approximation for sum of lognormals

For independent lognormal random variables
`X_1 ~ LN(mu_1, sigma_1)` and `X_2 ~ LN(mu_2, sigma_2)`:

The sum `S = X_1 + X_2` is not exactly lognormal, but can be approximated as
`S ~ LN(mu_S, sigma_S)` by matching the first two moments.

**Moment formulae for a lognormal:**

```
E[X] = exp(mu + sigma^2 / 2)
Var[X] = (exp(sigma^2) - 1) * exp(2*mu + sigma^2)
```

**FW approximation:**

```
E[S] = E[X_1] + E[X_2]
Var[S] = Var[X_1] + Var[X_2]

sigma_S^2 = ln(1 + Var[S] / E[S]^2)
mu_S = ln(E[S]) - sigma_S^2 / 2
```

Quality gate: return failure if any input is non-finite, sigma < 0, or the
result is degenerate (E[S] <= 0 or Var[S] < 0).

FW extends to n components by iterative pairwise application.

Currently implemented in FE only:
`statisticalEnhancementService.ts:approximateLogNormalSumFit()` (lines 593–624).
Must be ported to Python for Phase 2.

### 15.3 Chain composition and onset handling

For a chain of edges `A→B→...→X→Y`, each edge `i` has:
- onset `delta_i >= 0`
- post-onset lag `X_i ~ LN(mu_i, sigma_i)`

The total path latency is:

```
T_path = sum_i(delta_i + X_i) = sum_i(delta_i) + sum_i(X_i)
       = path_delta + S
```

where:
- `path_delta = sum_i(delta_i)` — deterministic, the sum of all edge onsets
- `S = sum_i(X_i) ~ LN(path_mu, path_sigma)` via iterative FW

The path model is therefore a **shifted lognormal**:

```
T_path ~ path_delta + LN(path_mu, path_sigma)
```

Completeness evaluation:

```
P(T_path <= t) = P(S <= t - path_delta)
               = CDF_LN(max(0, t - path_delta), path_mu, path_sigma)
```

**This means the system must persist three path-level scalars**:
`path_mu`, `path_sigma`, and `path_delta`.

#### 15.3.1 Current implementation and its onset handling

The current FE implementation at `statisticalEnhancementService.ts` composes
path models via two routes:

**(a) Full FW from anchor lag moments** (lines 2466–2515): For downstream edges
with `anchor_median_lag_days` available, the FE fits an `anchorFit` from
`A→X` lag moments and composes with the edge's model-space fit:

```
anchorFit = fitLagDistribution(anchor_median, anchor_mean, n)  // user-space currently
ayFit = approximateLogNormalSumFit(anchorFit, latencyStats.fit)  // model-space edge
```

Currently `anchorFit.mu = ln(anchor_median)` — fitted in user-space because
no A→X onset is available. With the proposed `anchor_onset_delta_days` (§10.4),
this should become model-space:
`anchorFit.mu = ln(anchor_median - anchor_onset)`. The A→X onset would then
be tracked as part of `path_delta` alongside the target edge's onset.

`latencyStats.fit.mu = ln(median_X - onset_E)` — model-space, onset subtracted.

So the FW result represents the distribution of
`(A→X_user_space + X→Y_post_onset)`. This does **not** include the target
edge's onset.

The FE correctly compensates: at line 2507 it evaluates completeness with
`edgeOnsetDeltaDays`, computing `CDF(age - onset_E, path_mu, path_sigma)`.

For a **2-hop chain** `A→X→Y`, this is correct:
- FW gives params for `(A→X_user + X→Y_model)`
- Evaluation: `CDF(age - onset_Y, path_mu, path_sigma)`
- = `P(A→X_user + X→Y_model <= age - onset_Y)`
- = `P(A→X_user + onset_Y + X→Y_model <= age)`
- = `P(T_path <= age)` ✓

**(b) Upstream DP propagation** (lines 2522–2533): For edges where the anchor
lag path didn't fire, the FE composes upstream `nodePathMu`/`nodePathSigma`
with the edge's own fit.

#### 15.3.2 The intermediate onset problem in chains > 2 hops

For a chain `A→B→C→Y`:

When processing `B→C`:
- `anchorFit` is from user-space `A→B` moments (includes `A→B` onset)
- `latencyStats.fit` is `B→C` model-space (onset subtracted)
- `ayFit` = FW result = params for `(A→B_user + B→C_post_onset)`
- `pathMu = ayFit.mu`, `pathSigma = ayFit.sigma` → stored, propagated to
  `nodePathMu(C)`
- **`B→C`'s onset is not encoded anywhere in the propagated path params**

When processing `C→Y`:
- upstream = `nodePathMu(C)` = params for `(A→B_user + B→C_post_onset)`
- compose: FW(upstream, `C→Y_model`) = params for
  `(A→B_user + B→C_post_onset + C→Y_post_onset)`
- evaluation: `CDF(age - onset_CY, path_mu, path_sigma)`
- this gives `P(A→B_user + B→C_post_onset + C→Y_post_onset + onset_CY <= age)`
- but the true path time is
  `A→B_user + onset_BC + B→C_post_onset + onset_CY + C→Y_post_onset`
- **`onset_BC` is lost**

The error magnitude is `onset_BC` days. For typical graphs, individual edge
onsets are 0–2 days. In a 3-hop chain, the maximum error is the sum of
intermediate onsets. This is small relative to typical path durations (weeks to
months) but is a real systematic bias that makes the model predict completion
slightly too early.

#### 15.3.3 Options for fixing onset in chains

**Option A: Track `path_delta` through the DP**

Add a `path_delta` accumulator alongside `path_mu`/`path_sigma` in the topo DP.
Each edge adds its own onset to the running total:

```
edgePathDelta = upstreamPathDelta + edge.onset_delta_days
```

Persist `path_delta` alongside `path_mu`/`path_sigma`. At evaluation time:

```
completeness = CDF(max(0, age - path_delta), path_mu, path_sigma)
```

Pros:
- Mathematically correct for any chain length
- Simple to implement (one new scalar in the DP)
- Clean separation: `path_delta` is deterministic, `(path_mu, path_sigma)` is
  stochastic

Cons:
- Requires a new field on the schema (`path_delta`)
- Requires propagation through all skip paths in the LAG pass
- The shifted-lognormal CDF is `CDF_LN(t - delta, mu, sigma)` which has a hard
  onset at `t = delta`, whereas the true multi-edge onset is "softer" because
  upstream delays are stochastic — the hard onset is only correct for the
  *earliest* edge in the chain

The last point deserves attention: if `path_delta = sum(delta_i)` and the first
edge has onset 2 and the second has onset 1, the composed model says zero
completeness before `t = 3`. But in reality, users who traversed the first edge
quickly (say in 2.5 days) could start the second edge's onset clock earlier.
The hard-onset model is conservative (underestimates early completeness).

**Option B: Absorb onset into the lognormal via moment-matching**

Instead of tracking `path_delta` separately, absorb each edge's onset into the
lognormal approximation at each DP step. After composing
`S = upstream + edge_post_onset`, the true path time is
`path_delta_new + S`. Convert the shifted lognormal `(path_delta_new, mu_S,
sigma_S)` into an unshifted lognormal `LN(mu_absorbed, sigma_absorbed)` by
moment-matching:

```
E[T] = path_delta + exp(mu_S + sigma_S^2/2)
Var[T] = Var[S] = (exp(sigma_S^2) - 1) * exp(2*mu_S + sigma_S^2)

sigma_absorbed^2 = ln(1 + Var[T] / E[T]^2)
mu_absorbed = ln(E[T]) - sigma_absorbed^2 / 2
```

Then propagate `(mu_absorbed, sigma_absorbed)` with `onset = 0`.

Pros:
- No new field needed — just `(path_mu, path_sigma)` with `onset = 0`
- The "soft onset" that emerges from the moment-matching better reflects the
  reality that upstream delays are stochastic
- Compatible with the current 2-field schema

Cons:
- The approximation is lossy: a shifted lognormal is not lognormal, so the
  moment-matched version has the wrong shape near zero (it has a soft rise
  instead of a hard onset)
- Approximation error compounds through the chain — each absorption step adds
  distortion
- Cannot recover the original onset information once absorbed

**Option C: Use edge onset only (interim, Phase 1)**

Keep the current schema (`path_mu`, `path_sigma`, no `path_delta`). At
evaluation time, use the *target edge's* `onset_delta_days` as the onset for
path params. This matches the current FE behaviour.

Pros:
- Minimal change — fixes the `onset = 0.0` bug in the BE chart without new
  fields
- Correct for 2-hop chains
- Correct for the target edge's onset in any chain

Cons:
- Intermediate onsets remain lost
- Systematic underestimate of path latency in chains > 2 hops
- The error is bounded by `sum(intermediate_onsets)`, typically 0–4 days

#### 15.3.4 Recommended approach

Phase 1: Option C (use edge onset). Fixes the immediate BE chart bug.

Phase 2: Option A (track `path_delta`). Provides the correct answer. The
hard-onset conservatism is acceptable for a pre-Bayes system — it
underestimates early completeness, which is the safe direction. Option B may
seem attractive (no new field) but the compounding approximation error and loss
of onset information make it harder to reason about and debug.

Phase 3 (Bayes): onset composition can be handled exactly within MCMC draws.

### 15.4 Join handling — path mixture at convergent nodes

When multiple paths converge at a node `X`, the `A→X` latency distribution is a
weighted mixture of the inbound path distributions. This section analyses the
problem and proposes the pre-Bayes solution.

#### 15.4.1 The problem

Node `X` has `k` inbound edges from nodes `U_1, ..., U_k`. Each inbound path
`i` has a path model `(path_mu_i, path_sigma_i, path_delta_i)` representing:

```
T_i ~ path_delta_i + LN(path_mu_i, path_sigma_i)
```

The `A→X` latency for a randomly chosen user arriving at `X` is drawn from the
mixture:

```
T_A→X ~ sum_i(w_i * f_i(t))
```

where `w_i` is the fraction of traffic arriving through path `i` and `f_i` is
the PDF of `T_i`.

This mixture is **not** lognormal (or shifted lognormal). It can be multimodal
if the paths have very different timings.

For the downstream edge `X→Y`, the `A→Y` path model requires composing this
mixture with the `X→Y` edge model. This is mathematically the convolution of a
lognormal mixture with a shifted lognormal — intractable in closed form.

#### 15.4.2 Current implementation: dominant path selection

The current FE implementation selects the inbound path with the largest
`path_t95` and uses its `(path_mu, path_sigma)` for the downstream edge:

```
if edgePathT95 > (nodePathT95.get(toNodeId) ?? 0):
    nodePathMu.set(toNodeId, pathMu)
    nodePathSigma.set(toNodeId, pathSigma)
```

This discards all non-dominant paths. The resulting `A→Y` model only reflects
one path's timing, regardless of how much traffic flows through the others.

This is not analytically defensible: if 80% of traffic arrives via a fast path
(10-day median) and 20% via a slow path (60-day median), dominant path selection
uses the slow path's model for *all* downstream completeness evaluation.

#### 15.4.3 Proposed: weighted mixture collapse via moment-matching

Collapse the mixture to a single shifted lognormal by matching the first two
moments. This is a standard approximation technique for lognormal mixtures.

**Step 1: Compute moments of each path's shifted lognormal.**

For path `i` with model `(delta_i, mu_i, sigma_i)`:

```
E[T_i] = delta_i + exp(mu_i + sigma_i^2 / 2)
E[T_i^2] = delta_i^2 + 2 * delta_i * exp(mu_i + sigma_i^2 / 2)
           + exp(2*mu_i + 2*sigma_i^2)
```

**Step 2: Compute mixture moments.**

```
E[T_mix] = sum_i(w_i * E[T_i])
E[T_mix^2] = sum_i(w_i * E[T_i^2])
Var[T_mix] = E[T_mix^2] - E[T_mix]^2
```

Note: `Var[T_mix]` includes both within-path variance and between-path variance
(due to different means). This is correct — the mixture is more dispersed than
any individual path when the paths have different timings.

**Step 3: Collapse to shifted lognormal.**

Choose `delta_mix = min_i(delta_i)` — the earliest any path can begin delivering
traffic.

Then match moments of `T_mix - delta_mix`:

```
E_shifted = E[T_mix] - delta_mix
Var_shifted = Var[T_mix]   (shift does not change variance)

sigma_mix^2 = ln(1 + Var_shifted / E_shifted^2)
mu_mix = ln(E_shifted) - sigma_mix^2 / 2
```

Result: `(delta_mix, mu_mix, sigma_mix)` — a shifted lognormal that preserves
the mean and variance of the full mixture.

**Step 4: Compose with downstream edge.**

Use `(delta_mix, mu_mix, sigma_mix)` as the upstream path model for node `X`.
Compose with `X→Y` via FW as usual:

```
path_mu_XY = FW(LN(mu_mix, sigma_mix), LN(mu_XY, sigma_XY)).mu
path_sigma_XY = FW(...).sigma
path_delta_XY = delta_mix + onset_XY
```

**Where the weights come from**: During the topo DP, each inbound edge carries a
flow mass (conversion volume `Y` or traffic volume `X`). These provide natural
weights. Normalise: `w_i = flow_i / sum(flow_i)`.

If flow mass is unavailable for some paths (e.g. skipped edges with no data),
use equal weights as a fallback and mark the result as lower-confidence.

#### 15.4.4 Properties and limitations of the moment-matching collapse

**What it preserves:**
- Mean path latency (exactly)
- Variance of path latency (exactly)
- The resulting CDF has the correct median and spread in a global sense

**What it loses:**
- Multimodality: if two paths have very different timings (e.g. one at 5 days,
  another at 50 days), the mixture is bimodal but the collapsed lognormal is
  unimodal. The CDF will be too high in the gap between the modes and too low
  at the modes.
- Tail behaviour: the collapsed distribution has the correct variance but may
  over- or under-represent the actual tail weight depending on the mixture
  structure.

**When this matters in practice:**
- For typical graphs with 2–3 inbound paths of similar timing, the error is
  small.
- For graphs with one dominant path (> 80% of traffic), the collapse is very
  close to the dominant path's distribution (the minority path adds small
  variance).
- For graphs with paths of dramatically different timings and similar weights,
  the collapse is a poor approximation. This should be detectable (high ratio
  of between-path variance to within-path variance) and flagged.

**Why this is better than dominant path selection:**
- It uses information from all paths, weighted by traffic
- It correctly inflates variance when paths disagree
- It degrades gracefully to the single-path case when one path dominates
- It is analytically defensible (moment-matching is a standard technique in
  actuarial science and reliability engineering)

**What Phase 3 (Bayes) would do differently:**
- In MCMC, each posterior draw gives concrete edge-level
  `(mu_i, sigma_i)` values
- For each draw, the exact path mixture can be evaluated by simulation:
  draw `N` samples from each path distribution weighted by flow mass, compute
  the empirical path CDF
- No FW or moment-matching approximation needed
- This is the "right" answer but requires the Bayes infrastructure

### 15.5 Partial availability — degradation ladder with exact computations

This section maps the degradation ladder from §9 to exact computations.

#### Level 0: cold start — `X→Y` only

No upstream path information exists. No anchor lag moments. No snapshot history.

**Computation:**
- Use edge-level model: `mu = edge.mu`, `sigma = edge.sigma`
- onset = `edge.onset_delta_days`
- completeness = `CDF_LN(max(0, age - onset), mu, sigma)`

This is the `X→Y` model applied directly. It answers the wrong question
(`X→Y` timing instead of `A→Y` timing) but is the only thing available.

**Model-source grade:** `edge_only`

#### Level 1: fresh graph — current fetch has anchor lag moments

The current fetch provides `anchor_median_lag_days` and `anchor_mean_lag_days`
on the cohort data. No snapshot history yet.

**Computation:**
1. Fit `A→X` as shifted lognormal from anchor lag moments:
   - If `anchor_onset_delta_days` is available (§10.4):
     `anchorFit = fit_lag_distribution(anchor_median - anchor_onset, anchor_mean - anchor_onset, total_k)`
     (model-space, onset subtracted — same method as X→Y edge fitting)
   - Otherwise fall back to user-space:
     `anchorFit = fit_lag_distribution(anchor_median, anchor_mean, total_k)`
2. Compose via FW:
   `pathFit = approximate_lognormal_sum_fit(anchorFit, edgeFit)`
   where `edgeFit` is model-space (onset subtracted).
3. `path_mu = pathFit.mu`, `path_sigma = pathFit.sigma`
4. `path_delta = anchor_onset + edge.onset_delta_days` (if anchor onset
   available) or `edge.onset_delta_days` (fallback)
5. completeness = `CDF_LN(max(0, age - path_delta), path_mu, path_sigma)`

**Model-source grade:** `composed_prior`

#### Level 2: snapshot panel available — empirical calibration

Repeated `(anchor_day, retrieved_at)` observations exist for the same cohorts
in the snapshot DB.

**Computation:**
1. Build the composed prior as in Level 1.
2. For each snapshot observation, compute the predicted rate:
   `predicted_rate = p_infinity * CDF_LN(max(0, age - path_delta), path_mu, path_sigma)`
   where `age = retrieved_at - anchor_day`.
3. Compare against observed rate: `observed_rate = Y / X`.
4. Calibrate `(path_mu, path_sigma)` to minimise discrepancy between
   predicted and observed rates across the panel, using the composed prior as
   regularisation.
5. Method: weighted least squares on the CDF curve. Weight each observation
   by `X` (denominator size) and by recency (exponential decay).

**Model-source grade:** `snapshot_calibrated`

**What to learn strongly vs weakly:**
- `path_mu` and `path_sigma`: learn strongly — the panel directly constrains
  these through the shape and timing of the maturity curve.
- `path_delta`: learn weakly — the system does not retain rich full-horizon
  onset evidence today. Onset should remain constrained by edge-level onset
  sums rather than re-inferred from sparse data.

#### Level 3: Bayes posterior

See `0-high-level-logical-blocks.md`. Canonical edge models are inferred, and
path composition is a deterministic function within each MCMC draw.

**Model-source grade:** `bayes_posterior`

### 15.6 When FW is a bad approximation

FW moment-matching is known to be poor when:

- Component sigmas are very different (e.g. one very peaked, one very dispersed)
- Many components are summed and approximation error accumulates
- Component means differ by orders of magnitude
- The true sum distribution is multimodal (FW produces a unimodal
  approximation)

For pre-Bayes in this application:

- Chains are typically 2–5 hops. FW is acceptable for this range.
- The quality gate (finite, positive results) catches degenerate cases.
- The mixture collapse at joins is an additional approximation layer. Its
  quality can be assessed by checking the ratio of between-path variance to
  within-path variance — high ratios indicate the collapse is lossy.
- Phase 3 (Bayes MCMC) can use exact simulation within each draw instead of
  FW.

---

## 16. Onset semantics — precise rules

### 16.1 Truth table

| Mode | path params? | path_delta? | mu used | sigma used | onset used | mode tag |
|------|-------------|-------------|---------|------------|------------|----------|
| window | (ignored) | (ignored) | edge mu | edge sigma | edge onset | `window` |
| cohort | yes | yes | path_mu | path_sigma | path_delta | `cohort_path` |
| cohort | yes | no | path_mu | path_sigma | edge onset | `cohort_path` |
| cohort | no | — | edge mu | edge sigma | edge onset | `cohort_edge_fallback` |

### 16.2 Why `onset = 0.0` is wrong for path params

The current BE chart code (`api_handlers.py` line 686) sets `cdf_onset = 0.0`
with the comment "path params already incorporate upstream delay". The
`cohort_latency_params.md` doc makes the same claim.

This is wrong. As traced in §13.1:

- `path_mu` and `path_sigma` are fitted from `FW(A→X_user_space,
  X→Y_model_space)`. The `X→Y` edge fit is in model-space — onset has been
  subtracted from the median and mean before fitting.
- The FW result represents the distribution of `(A→X_user + X→Y_post_onset)`.
  The target edge's onset is **not** included.
- The FE correctly applies edge onset at evaluation time (line 2507). The BE
  must do the same.

### 16.3 What "soft onset" means and when it applies

The FW combined distribution does produce a natural "soft onset" in the sense
that `CDF(0) = 0` and the CDF rises gradually. This is because the upstream
`A→X` timing is stochastic — users arrive at `X` over a range of times, not
all at once.

But this soft onset reflects the **upstream** stochastic timing, not the
**target edge's** deterministic onset. The target edge's onset is additional
dead-time after arriving at `X` before conversions can begin.

Using `onset = 0.0` conflates these two distinct phenomena and overestimates
early completeness by the target edge's onset.

---

## 17. Evaluator unification

### 17.1 Single parameter resolution helper

A new helper in `api_handlers.py` encapsulates the mode-dependent parameter
selection:

```python
def _resolve_completeness_params(model_params, query_mode):
    """Select mu/sigma/onset based on query mode and path param availability."""
    if query_mode == 'window':
        return (model_params['mu'], model_params['sigma'],
                model_params['onset_delta_days'], 'window')
    # cohort mode
    path_mu = model_params.get('path_mu')
    path_sigma = model_params.get('path_sigma')
    if path_mu is not None and path_sigma is not None:
        path_delta = model_params.get('path_delta',
                                       model_params['onset_delta_days'])
        return path_mu, path_sigma, path_delta, 'cohort_path'
    return (model_params['mu'], model_params['sigma'],
            model_params['onset_delta_days'], 'cohort_edge_fallback')
```

Both the annotation block (line 636) and the chart CDF block (line 674) call
this helper. This eliminates the current divergence where annotation always
uses edge-level params while the chart CDF branches by mode.

### 17.2 FE evaluator relationship

**Phase 1**: The FE continues to compute its own completeness for the LAG pass
analysis path (`calculateCompletenessWithTailConstraint` with
`completenessMode='cohort_path_anchored'`). The BE uses the shared helper for
annotation + charting. These are independent consumers and will produce
different completeness values (different models, different tail constraints).

**Phase 2**: The FE stops computing completeness. The BE publishes the path
model; the FE reads and applies `compute_completeness()` with the published
params. One evaluator, one set of params.

**During parallel-run**: FE completeness vs BE annotation completeness can be
compared per `anchor_day`. Divergence is expected (different models) but should
be logged for investigation to understand the practical impact.

---

## 18. Mode detection — replace string matching

### 18.1 Current fragility

`api_handlers.py` line 666 detects window vs cohort mode by:

```python
has_window_slice = any('window(' in str(sk) for sk in subj_slice_keys)
```

This is fragile: if slice key naming conventions change, it breaks silently.

### 18.2 Fix

Add an explicit `query_mode: 'window' | 'cohort'` field to the per-subject
analysis request object. The FE already knows the mode (it determines
`lagSliceSource` from its own state). It should pass this through.

The string-matching fallback should remain for backward compatibility but log a
deprecation warning when used.

### 18.3 Files affected

- FE: `graphComputeClient.ts` — add `query_mode` to subject request object
- BE: `api_handlers.py` — read `query_mode` from subject, fall back to string
  matching when absent

---

## 19. Provenance and model-source tracking

### 19.1 Per-subject provenance in analysis response

Each subject in a cohort maturity analysis response should include a
`completeness_model` object (transient — not DB-persisted):

```python
'completeness_model': {
    'mode': 'cohort_path',          # matches model_curve_params.mode
    'mu': path_mu,
    'sigma': path_sigma,
    'onset_delta_days': path_delta,
    'path_params_available': True,
    'model_source_grade': 'composed_prior',  # Phase 2
}
```

The critical invariant: `completeness_model.mode == model_curve_params.mode`
and `completeness_model.onset_delta_days == model_curve_params.onset_delta_days`.
If these do not match, there is a bug.

### 19.2 Model-source grades

Phase 1: only `mode` and the params actually used. No grade tracking.

Phase 2 grades:
- `edge_only` — no path information available, using `X→Y` model
- `composed_prior` — FW composition from `A→X` + `X→Y`, no snapshot calibration
- `fetch_augmented` — composed prior plus current fetch-time data
- `snapshot_calibrated` — calibrated against repeated snapshot panel

Phase 3: `bayes_posterior`

### 19.3 Why this matters

Without explicit provenance, the UI and runtime cannot distinguish a weak prior
from a mature path fit. A `composed_prior` for a new graph with 3 days of data
should not be presented with the same confidence as a `snapshot_calibrated`
model built from 60 days of repeated observations.

---

## 20. MVP topology invalidation

### 20.1 When path models become stale

A persisted `A→Y` model becomes stale when the topology between anchor and
target changes, because the model was derived from a specific path structure.

Invalidation events:
- Edge added or removed on any path from anchor to target
- Node added or removed on any path from anchor to target
- Edge `latency_parameter` flag toggled
- Anchor node changed
- Edge conditional probability structure changed (alters effective topology)

### 20.2 MVP mechanism: clear on structural mutation

On any structural graph mutation, clear `path_mu`/`path_sigma`/`path_delta` on
all edges. This is aggressive but safe:
- The next LAG pass (FE) or recompute (BE, Phase 2) will repopulate them
- No stale path model is ever silently applied
- Simple to implement

### 20.3 Phase 2 refinement: stale detection

Add two fields alongside path model vars:
- `path_model_fitted_at` — timestamp of last fit
- `path_model_topo_hash` — hash of the subgraph from anchor to this edge

On read: if `path_model_topo_hash` does not match the current topology, treat
the model as stale. Stale models can be used with an explicit warning or
degraded to edge-level params.

### 20.4 Why not full topology signatures now

Signatures must handle joins, conditional edges, scenario-dependent topology,
and the distinction between structural and parametric changes. They are
substantial engineering. The MVP (clear-and-recompute) is adequate for
pre-Bayes. Signatures can be revisited in Phase 3 if the recompute cost
becomes unacceptable.

---

## 21. File-level change specification

### 21.1 Phase 1

| File | Change |
|------|--------|
| `lib/api_handlers.py` | Extract `_resolve_completeness_params()`. Use in both annotation (line 636) and chart CDF (line 674). Read `query_mode` from subject. Fix onset: use edge onset, not `0.0`. Add `completeness_model` to response. |
| FE: `graphComputeClient.ts` | Add `query_mode: 'window' \| 'cohort'` to subject request |
| `lib/runner/forecast_application.py` | No changes (evaluator is already correct) |

### 21.2 Phase 2

| File | Change |
|------|--------|
| `lib/runner/lag_distribution_utils.py` | Port `approximate_lognormal_sum_fit()` from TS. Add `collapse_lognormal_mixture()` for join handling. |
| `lib/runner/lag_model_fitter.py` | Add `fit_path_model()`: compose `A→X` + `X→Y` via FW, handle joins via mixture collapse, optionally calibrate against snapshot panel. |
| `lib/api_handlers.py` | Add `/api/lag/recompute-path-models` route. |
| `lib/graph_types.py` | Add `path_delta`, `path_model_fitted_at`, `path_model_source_grade` to `LatencyConfig`. |
| FE: types (`index.ts`) | Add `path_delta` to `LatencyConfig`. |
| FE: `UpdateManager.ts` | Persist `path_delta` and new model metadata fields. |
| FE: `statisticalEnhancementService.ts` | Add `path_delta` accumulation to topo DP. After cutover: remove FE completeness computation. |

---

## 22. Testing strategy

### 22.1 Phase 1: congruence

- For `cohort_maturity` analysis with path params: assert
  `completeness_model.mode == model_curve_params.mode`
- Assert `completeness_model.onset_delta_days == model_curve_params.onset_delta_days`
- Assert annotation completeness values match
  `compute_completeness(age, resolved_mu, resolved_sigma, resolved_onset)`
- Window mode regression: annotation behaviour must be unchanged

### 22.2 Phase 2: FW port parity

- Golden fixture: `approximate_lognormal_sum_fit(a, b)` in Python must match TS
  within tolerance (1e-6)
- Test cases: typical chains (2-hop, 3-hop), edge cases (very small sigma, very
  large sigma, sigma = 0, degenerate inputs)

### 22.3 Phase 2: mixture collapse correctness

- Verify moment preservation: for a known mixture of 2–3 lognormals, the
  collapsed result must have `E[T]` and `Var[T]` matching the true mixture
  moments within floating-point tolerance
- Test: single dominant path (w > 0.9) — collapsed result ≈ dominant path
- Test: equal-weight paths with similar timing — collapsed result is reasonable
- Test: equal-weight paths with very different timing — flag for quality warning

### 22.4 Phase 2: chain onset correctness

- 3-hop chain `A→B→C→Y` with `onset_B = 1`, `onset_C = 2`, `onset_Y = 1`:
  assert `path_delta = 4`
- Verify completeness at `t = 3.9` is 0 (before `path_delta`)
- Verify completeness at `t = 100` ≈ 1 (well beyond path timing)

### 22.5 Phase 2: degradation ladder

- Test each level (Full FW → Upstream DP → Pass-through → Edge only) produces
  valid completeness values
- Verify that lower levels produce less accurate but still safe estimates
- Verify model-source grade is set correctly at each level

### 22.6 Phase 2: invalidation

- Topo change clears `path_mu`/`path_sigma`/`path_delta`
- Next recompute repopulates them
- Analysis with stale/missing path params falls back to edge-level

---

## 23. Derivation pipeline trade-off (16-Mar-26)

**Context**: the Bayes webhook commits posteriors (alpha, beta, mu_mean,
sigma_mean, HDI, ESS, r-hat) to parameter files and `_bayes` metadata to the
graph file. The question is: who derives the scalar fields that consumers
read — `p.mean`, `p.stdev`, `latency.t95`, `completeness`, `forecast`?

### Why the webhook does not derive scalars

Multiple triggers require scalar re-derivation, not just Bayes completion:

- User changes query expression → different evidence scope
- User changes date window → different evidence slice
- User changes visible contexts → different cohort filter
- Time passes → completeness changes (lognormal CDF is time-dependent)

The Bayes worker cannot handle any of these. So derivation logic must live
somewhere the FE can reach for all triggers. Putting it in the webhook would
create a second code path that only handles one trigger — a maintenance
burden with no benefit.

### What the worker uniquely produces

Just the posterior distribution parameters. That's the heavy compute (MCMC
sampling, convergence diagnostics). Everything else is derivable:

- `p.mean` = alpha / (alpha + beta) — trivial
- `p.stdev` = sqrt(alpha·beta / ((alpha+beta)² · (alpha+beta+1))) — trivial
- `latency.mu`, `latency.sigma` = posterior means — already in the posterior
- `t95` = exp(mu + 1.645·sigma) — one line
- `completeness` = lognormal CDF at elapsed time — needs scipy or JS approx
- `forecast` = blend of prior and evidence weighted by completeness

### Trade-off: FE vs BE for derivation

**BE (Python) advantages**: scipy available, same code as batch/nightly
derivation, no risk of FE/BE divergence for complex stats (CDF, FW
approximation).

**FE advantages**: works offline, no round-trip latency, can respond
immediately to user changes (query, context, dates). FE already has
derivation code for the trivial cases (posterior mean, t95 from mu/sigma).

**Current position (open, not resolved)**: lean toward FE doing trivial
derivations (posterior mean/stdev, t95) and commissioning BE for complex
derivations (completeness from lognormal CDF, forecast blending, FW path
composition). This mirrors the current architecture where py-stats handles
the heavy lifting but FE can display intermediate results without a BE
call. The exact boundary is TBD — it depends on whether the JS lognormal
CDF approximation is accurate enough for production use.

**What this means for the webhook**: the webhook is intentionally simple.
It commits posteriors to param files + `_bayes` to graph. No derived
scalars, no cascade. The FE pulls, sees the posteriors, and runs the
derivation pipeline (FE-local for trivial, BE-commissioned for complex).
The derived scalars are then written to graph edges via the normal
file_to_graph cascade on the next commit.
