## Blending logic fix: make `p.mean` converge to evidence in mature cohorts

**Status**: Draft  
**Last updated**: 22-Dec-25  
**Owner**: DagNet  
**Context**: Fix probability blending so that, for cohort-mode latency edges, the blended probability (`p.mean`) behaves in an intuitive and mathematically defensible way across maturity regimes.

### Problem statement

We currently compute a blended probability (`p.mean`) from:

- **Evidence**: cohort-mode observed conversion (`p.evidence.mean`, derived from \(k/n\) on the cohort query)
- **Forecast**: a stable baseline conversion estimate (`p.forecast.mean`, derived from window-mode baselines with recency weighting)
- **Completeness**: a maturity signal derived from latency (`p.latency.completeness`)

Empirically, we see edges with very high completeness (e.g. ~95%+ complete) where `p.mean` remains dominated by forecast and is not well-explained by evidence. This violates the intended user semantics:

- When a cohort is mature, the user is looking at evidence.
- When it is immature, the user expects a sensible blend that compensates for censoring and limited information.
- When there is effectively no evidence, the user expects forecast (with recency bias).

This document specifies a new blending design that satisfies those semantics without discontinuities or arbitrary per-edge constants.

### Goals (behavioural requirements)

#### A) Regime behaviour (no discontinuities)

- **Mature**: as completeness approaches 1, `p.mean` should converge rapidly to the evidence signal (after any maturity correction used for blending).
- **Immature**: for low completeness, `p.mean` should lean towards forecast and avoid the “blow-up” behaviour of naive \( (k/n)/\text{completeness} \).
- **No evidence**: when the effective evidence sample size is ~0, `p.mean` should be essentially forecast.

The transition between regimes must be smooth (no threshold switching).

#### B) Evidence semantics remain clean

`p.evidence.mean` must remain the raw observed \(k/n\) in the requested cohort window, for interpretability and debugging.

Any completeness-driven correction to the evidence signal is used only for blending and must be exposed separately in debug (or derivable from stored fields).

#### C) Scale-awareness (no global caps)

The blending should behave sensibly for edges whose populations differ by orders of magnitude, without introducing hard caps or absolute sample-size constants that are fragile across graphs and products.

#### D) Explainability

Given `p.mean`, `p.evidence.mean`, `p.forecast.mean`, completeness, and the effective evidence population, it must be possible to explain why the blend is where it is.

### Non-goals

- Changing how `p.evidence.mean` is computed (it remains raw \(k/n\)).
- Changing the definition of forecast (still window-derived, with recency weighting).
- Changing the latency/completeness model itself (handled in separate LAG documents).

### Current behaviour (root cause)

The current blend weight is effectively “evidence sample size vs forecast baseline sample size”, scaled by completeness:

- The forecast baseline can behave like an extremely strong prior when the window baselines are large.
- That strength does not decay sufficiently as completeness approaches 1.
- As a result, `p.mean` can remain materially closer to forecast than evidence even in cohorts that are already mature.

This is the specific failure mode this document fixes.

### Design principle (first principles)

Forecast is only intended to compensate for:

- right-censoring from immaturity (low completeness), and
- statistical uncertainty from limited sample size.

Therefore, the influence of forecast must decay smoothly to near-zero as cohorts become mature. Put differently:

- Completeness is not merely “another multiplier on evidence”; it must control how much we trust forecast as a prior.

### Proposed blending design

We define blending in terms of:

- **Evidence signal for blending**: a maturity-aware estimate of the eventual conversion probability (distinct from raw `p.evidence.mean`)
- **Effective evidence information**: how much information the evidence provides (increases with both sample size and maturity)
- **Forecast prior influence**: decays smoothly as maturity increases

#### A) Evidence signal used for blending

We keep `p.evidence.mean` as raw \(k/n\). For blending we use a maturity-aware evidence estimate that corrects right-censoring in immature cohorts in a bounded way (no blow-up).

Requirements for this evidence-for-blend signal:

- equals raw \(k/n\) when cohorts are mature
- increases relative to raw \(k/n\) when cohorts are immature (because late conversions are missing)
- remains bounded in \([0,1]\)
- does not explode when completeness is small

The existing Bayesian completeness adjustment in the current implementation can be retained or refined, provided it meets these properties.

#### B) Effective evidence information

Define an effective evidence information term that increases smoothly with maturity:

- when completeness is low, evidence provides little information about the eventual rate
- when completeness is high, evidence provides almost full information

This effective information must be proportional to the edge’s own population (so scale is respected).

#### C) Forecast prior influence that vanishes as completeness approaches 1

The current defect arises because forecast can remain “strong” even at high completeness. The new design requires the prior influence to be down-weighted by a smooth function of the remaining incompleteness.

Design constraint:

- As completeness → 1, the effective prior influence → 0 (smoothly).
- As completeness → 0, the effective prior influence → its baseline value (forecast dominates when evidence is unusable).

This removes the need for global hard caps while ensuring mature cohorts are essentially evidence-driven.

#### D) Final blend as a convex combination

Compute `p.mean` as a convex combination of:

- maturity-aware evidence-for-blend
- forecast mean

The combination weight is derived from the ratio of:

- effective evidence information
- effective forecast prior influence

This keeps the blend explainable, dimensionally consistent, and robust across scales.

### Acceptance criteria (what “fixed” means)

#### A) Convergence in mature cohorts

For edges with:

- completeness at or above the high-maturity regime (e.g. ~95%+ in typical use), and
- non-trivial evidence population (not a tiny \(n\))

`p.mean` must be very close to the evidence-for-blend signal, and therefore close to raw \(k/n\) unless the maturity correction is still meaningfully active.

#### B) Sensible behaviour in immature cohorts

For low completeness:

- `p.mean` should not collapse to raw \(k/n\) (which is right-censored)
- `p.mean` should not “blow up” to implausible values
- `p.mean` should remain stable and forecast-anchored unless evidence is strong

#### C) Forecast-only behaviour when evidence is absent

If there is effectively no evidence (zero or near-zero effective evidence information), `p.mean` should be essentially forecast.

#### D) Explainability outputs

The system should expose (via debug fields and/or session logging) enough data to explain a given `p.mean`:

- evidence raw \(k/n\), evidence \(n,k\)
- evidence-for-blend (maturity-aware)
- forecast mean
- completeness used
- effective evidence information and effective prior influence (or the resulting evidence weight)

### Runner / E-mode implications (separate but related)

This blending fix addresses `p.mean` behaviour. It does not by itself fix E-mode path analysis semantics.

Because the UI may “rebalance evidence” for display (complement edges at render time), the Python runner must not treat missing evidence as a reason to fall back to `p.mean` when operating in evidence mode. That requires a separate update to runner semantics so evidence mode builds a coherent evidence-only probability layer.

This section specifies the required runner update at a behavioural and data-contract level.

#### Runner problem statement

The runner currently computes path/reach probabilities using a per-edge scalar probability `p` stored on the networkx edge data.

In E mode, the runner attempts to use evidence when available, but it implicitly falls back to the already-populated `p` value (which originates from `p.mean`) when evidence is missing. This mixes semantics:

- evidence-backed edges use evidence
- non-evidence edges use blended/forecast-driven `p.mean`

This is unintelligible in E mode and produces non-conservative probability flows (row sums not equal to 1) for graphs that intentionally rely on “complement evidence” for failure/other branches.

#### Runner target semantics

##### A) E mode must never use `p.mean` as a substitute for missing evidence

In E mode, the runner must treat missing evidence as “unknown evidence”, not as a justification to use `p.mean`.

Consequence:

- If an edge does not have evidence, E-mode path probabilities must not silently inherit `p.mean`.

##### B) E mode must operate on an evidence-complete probability layer

E mode needs a coherent transition model in which, for each non-absorbing node, outgoing probabilities are well-formed for path calculations.

The intended graph semantics in DagNet are MECE at splits, where one or more edges represent disjoint evidence events and an “other/failure” edge represents the complement. In the UI this complement may be derived at render time.

For the runner, the complement logic must be applied before path calculations.

##### C) Complement assignment must be explicit and safe

For any node where at least one outgoing edge has evidence:

- The runner should compute the sum of evidence probabilities across the evidence-backed outgoing edges.
- If there is a designated “failure/other” outgoing edge (typically an absorbing failure node), the residual probability (one minus the evidence sum) should be assigned to that edge for E mode.
- If no suitable “other/failure” edge exists, the runner must not guess. It should emit a warning and leave the row incomplete rather than inventing probability mass or hiding missing mass.

The runner must clamp residual probabilities to remain within valid bounds and must warn loudly when evidence sums exceed 1 (which indicates inconsistent upstream fetching or non-MECE event semantics).

##### D) Forecast and blended modes remain unchanged

- F mode uses forecast probabilities only (where available).
- F+E mode uses `p.mean` (the blended model probability).

Only E mode gains the “evidence completion” preprocessing.

#### Data requirements for runner correctness

The runner fix must not rely on UI-only derived values. It must be derived from the graph data in a deterministic way:

- evidence probability is taken from `p.evidence.mean` when present
- “complement evidence” is computed from the set of outgoing evidence-backed edges from the same source node
- candidate “other/failure” edges should be determined from node metadata (absorbing + failure outcome) and/or a clear schema field if available

If the graph does not provide sufficient information to identify the complement edge, the runner must record the ambiguity and avoid silently using `p.mean` as a fallback.

#### Acceptance criteria for runner fix

- In E mode, there are no edges whose probability comes from `p.mean` when evidence exists somewhere in the outgoing set from that node.
- For nodes with an evidence-backed split and a clear “other/failure” edge, the outgoing probabilities in E mode sum to 1 (within a small numerical tolerance).
- When evidence sums exceed 1, the runner emits an integrity warning that includes the node id and the outgoing edge set.
- When the complement edge cannot be identified, the runner emits a warning explaining which node is ambiguous and which edges lacked evidence.

#### Testing strategy for runner fix (prose, no code)

- A minimal MECE split graph with one evidence edge and one failure edge:
  - verify E mode assigns complement probability to the failure edge and row sums to 1
- A graph where the failure edge is missing:
  - verify E mode does not fall back to `p.mean` and emits a warning about missing complement
- A graph where two evidence edges sum to greater than 1:
  - verify E mode emits an integrity warning and clamps/resolves consistently (no silent behaviour)
- A graph with no evidence on any edge:
  - verify E mode behaves predictably (either all zeros or explicit “no evidence” result) and does not silently become F+E

### Testing strategy (prose, no code)

#### Unit tests (service level)

- A mature cohort case: set completeness very high and verify `p.mean` is near evidence-for-blend for a range of populations.
- An immature cohort case: low completeness with modest \(n\); verify `p.mean` is forecast-anchored and does not exceed plausible bounds.
- A “no evidence” case: \(n=0\) (or no evidence data); verify `p.mean` equals forecast (or the best-available forecast fallback).
- Scale robustness: compare small-\(n\) and large-\(n\) edges under the same completeness; ensure behaviour is consistent without global caps.

#### Integration tests (graph level)

- A small latency graph with mixed maturity across edges; verify that as each edge’s completeness increases, its `p.mean` moves monotonically toward evidence-for-blend.
- A MECE-split scenario in cohort mode; verify blending does not introduce contradictions across siblings when evidence is mature.

### Rollout plan

- Implement behind a feature flag or configuration toggle so we can compare old vs new blending in controlled runs.
- Log per-edge diagnostics (weight, evidence-for-blend, prior influence) for a representative cohort window and context slices.
- Validate on known “worst offender” edges where current behaviour is visibly wrong.
- Remove the old blending logic once results are stable and tests cover the intended invariants.

### Risks and mitigations

- **Risk: behaviour changes in dashboards and saved graphs**: mitigate with side-by-side comparison runs and explicit release notes.
- **Risk: tests that assert exact numeric values may fail**: mitigate by asserting behavioural invariants (convergence, monotonicity, bounds) rather than exact numbers.
- **Risk: interaction with sibling rebalancing (`p.mean` normalisation)**: mitigate by keeping blending and sibling rebalancing conceptually separate and verifying end-to-end flows in integration tests.


