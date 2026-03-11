# Project Bayes: Cohort completeness model contract

**Status**: Draft  
**Date**: 11-Mar-26  
**Purpose**: Define the contract for `cohort()` completeness, forecasting, and
chart inspection so that current runtime analysis, pre-Bayes model fitting, and
future Bayes artefacts all use congruent semantics grounded in the data we
actually have.

**Related**: `0-high-level-logical-blocks.md`, `../project-db/analysis-forecasting.md`, `../cohort_latency_params.md`

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

At fetch time, the system can receive:

- local `X→Y` counts and lag summaries
- `A→X` anchor-relative lag summaries on downstream cohort fetches
- current `A`-anchored cohort counts for `A→X→Y`
- short-horizon histogram-derived onset and lag shape information

However, the histogram-style information is not fully available over the full
path horizon. In practice it is only available for a short window near the
start of the cohort and does not directly reveal the long tail.

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

The system does not currently retain all of the fetch-time information that
would be useful for richer path fitting.

In particular, it does not durably preserve:

- a full lag histogram over the whole path horizon
- explicit direct `A→Y` lag summaries separate from `A→X` plus `X→Y`
- explicit path-route identity through joins
- rich onset evidence beyond compressed scalar summaries

So the pre-Bayes architecture must not assume that later analysis can reconstruct
an exact path mixture or a full path histogram from the DB alone.

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

If fetch time exposes information that is useful later but is currently
discarded, the upgrade should explicitly add persistence for it.

### 10.1 Why this matters

The durable long-tail signal is the repeated snapshot panel, but fetch time may
still expose useful short-horizon structure that later disappears.

If that structure is informative for path fitting, it should not be thrown away
simply because the current schema did not anticipate it.

### 10.2 Candidate additions

If available from fetch time, the system should consider persisting:

- short-horizon `X→Y` lag bucket counts or equivalent early-path shape summaries
- short-horizon `A→X` lag bucket counts when available
- explicit bucket-window metadata so truncation is known rather than guessed
- lag sample sizes and lag coverage metadata
- richer onset evidence than a single collapsed scalar where the source exposes
  it

These additions are not mandatory for the first pre-Bayes phase, but they are a
worthwhile part of the upgrade because they improve later path fitting without
requiring Bayes first.

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
