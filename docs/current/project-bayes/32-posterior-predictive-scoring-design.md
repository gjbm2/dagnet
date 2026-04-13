# 32 — Posterior Predictive Scoring (LOO-ELPD)

**Status**: Phase 1 implemented (8-Apr-26), Phase 2 (trajectory scoring) pending  
**Date**: 8-Apr-26  
**Depends on**: doc 6 (compiler pipeline), doc 13 (quality gating), doc 15
(model_vars provenance), doc 21 (unified posterior schema)  
**Purpose**: Per-edge model adequacy scoring via LOO-ELPD, benchmarked
against the analytic stats pass as null model.

---

## 1. Objective

Rhat, ESS, and divergence counts tell us whether MCMC **converged** —
they say nothing about whether the model **fits the data**. A model can
converge perfectly on a wrong answer.

LOO-ELPD (leave-one-out expected log pointwise predictive density)
answers the question: "how well does the Bayesian model predict each
observation when that observation is held out?" It is a proper scoring
rule (Gneiting & Raftery 2007) — it cannot be gamed by a misspecified
model.

By computing ΔELPD against the analytic stats pass (the existing
`analytic`/`analytic_be` model_vars), we get a per-edge answer to:
"does the Bayesian model improve on the analytic point estimates?"

---

## 2. What we score

The Bayesian model emits five kinds of likelihood term per edge (see
doc 6 §model structure). Four are named PyMC distributions; one is a
`pm.Potential`:

| Likelihood node | PyMC name pattern | What it represents | LOO? |
|---|---|---|---|
| Aggregate window | `obs_w_{edge}` | Collapsed window() snapshot: Binomial(n, p×F). Scalar observation. | Yes |
| Per-anchor-day counts | `obs_daily_{edge}` | Single-retrieval snapshot rows per anchor day: BetaBinomial or Binomial. **Vectorised** — one log-likelihood per anchor day in the array. | Yes |
| Window endpoint counts | `endpoint_bb_{edge}` | Per-anchor-day final-state counts (window), CDF-adjusted: BetaBinomial. **Vectorised.** | Yes |
| Cohort endpoint counts | `cohort_endpoint_bb_{edge}` | Per-anchor-day final-state counts (cohort), CDF-adjusted: BetaBinomial. **Vectorised.** | Yes |
| Branch group | `obs_bg_{group}` | DirichletMultinomial or Multinomial across sibling edges from a shared source node. **Vectorised** across anchor days. | Yes — but see §2.1 |
| Maturation trajectories | `traj_{type}_{edge}` | Multi-retrieval cohort curves: product-of-conditional-Binomials via Potential | No |

**Vectorised nodes**: `obs_daily_`, `endpoint_bb_`, `cohort_endpoint_bb_`,
and `obs_bg_` each pass arrays to a single PyMC call. PyMC's
`log_likelihood` group produces a (n_draws × n_data_points) array for
each — one log-likelihood per anchor day, not per node. The
aggregation step (§4.4) must map individual data points back to their
edge, not just map node names.

**Phase 1 scope**: the five named distribution types. These cover the
conversion rate (p) and overdispersion (κ) model. The trajectory
Potential constrains latency shape (onset, μ, σ) most strongly but
requires manual log-likelihood decomposition — deferred to Phase 2.

Each phase of the two-phase model (Phase 1 window, Phase 2 cohort)
produces its own set of named observation nodes. LOO runs independently
on each phase's trace, yielding separate window and cohort scores per
edge.

### 2.1 Branch groups and conditional independence

LOO assumes observations are conditionally independent given θ. For
branch groups sharing a Dirichlet prior, this is violated — sibling
edges' probabilities are constrained to sum to 1 (or ≤ 1 with
dropout). Leaving out one sibling's count changes the predictive
distribution for the others.

**Practical treatment**: compute LOO on the `obs_bg_` node as a whole
(one ELPD per anchor-day row in the DirichletMultinomial), then
attribute the ELPD equally across the sibling edges. This avoids the
conditional independence problem at the cost of per-sibling
granularity. The Pareto k for the group node flags influential
anchor days across all siblings jointly.

For edges that appear in **both** a branch group node and a solo node
(e.g. `obs_w_{edge}` plus `obs_bg_{group}`), sum the ELPD
contributions from both.

---

## 3. The null model: analytic model_vars

The LOO null is the FE analytic topo pass — the `analytic` model_vars
entry on each graph edge. This is the point-estimate model the user
already sees before a Bayes fit runs. ΔELPD answers: "does the
Bayesian model improve on what the user already had?"

The analytic model_vars provide per-edge: `probability.mean` (p),
`probability.stdev` (p_sd), and `latency.mu`, `latency.sigma`,
`latency.onset_delta_days`. The implementation reads these from the
graph snapshot via `extract_analytic_baselines()` in `loo.py`,
preferring `analytic` (FE, currently authoritative) and falling back
to `analytic_be`.

From p and p_sd, the null's Beta concentration κ is moment-matched:
`v = p_sd², common = p(1−p)/v − 1, κ = common` (when common > 0).
For BetaBinomial nodes, the null uses `α = p×F×κ, β = (1−p×F)×κ`.
For Binomial nodes, `p×F` directly. When κ is not derivable (p_sd
too large or p at boundary), Binomial is used.

### 3.1 Completeness in the null model

For endpoint observation nodes (where completeness depends on latency),
the null uses the analytic latency parameters (onset, μ, σ from the
`analytic` model_vars) to compute F via `shifted_lognormal_cdf`.
This gives each model credit for its own latency estimates.

For `obs_daily_` and `obs_w_` nodes, the completeness is pre-baked on
the evidence observations (computed during evidence binding from
topology priors). These topology priors are the analytic values, so
the completeness is already the analytic completeness.

### 3.2 Fairness of plug-in vs LOO for the null

The analytic model is fitted to the same snapshot data. Strictly, its
plug-in log-likelihood is slightly optimistic vs what LOO would give.
However, the analytic model has very few effective parameters
(essentially p and κ from moment-matching), so the LOO correction
is negligible. We use plug-in log-likelihood as a practical
approximation.

### 3.3 Phase C: per-slice analytic baselines

The analytic model_vars are DSL-dependent — the FE topo pass runs on
data filtered by the active query DSL, including context dimensions.
For Phase C (context-slice pooling, doc 14), each context slice gets
its own Bayesian posterior. The ΔELPD for each slice must compare
against the analytic baseline for **that slice**.

This requires the FE to:
1. Explode the pinned DSL into per-slice DSLs (parent + children)
2. Run the topo pass per slice (same `enhance_graph_latencies`, called
   once per exploded slice)
3. Put per-slice analytic model_vars on the graph, keyed by context_key

The Bayes worker then reads the correct per-slice baseline from the
graph snapshot when computing ΔELPD.

For Phase A/B (no context), only one slice exists per edge (the
aggregate). The current implementation handles this correctly — one
`analytic` model_vars entry per edge, one baseline per edge.

See doc 14 §14.8 for the full FE commissioning contract.

---

## 4. Compute requirements

### 4.1 Compute log-likelihoods from the trace

The primary sampling path uses **nutpie** (`inference.py:1067`), which
bypasses `pm.sample()` and constructs InferenceData manually from Arrow
batches. The nutpie path does not populate the `log_likelihood` group.

**Solution**: after nutpie returns the trace and observed data have
been attached, call:

```python
pm.compute_log_likelihood(trace, model=model)
```

This evaluates log p(y_i | θ⁽ˢ⁾) for each posterior draw and each
named observation node, populating `trace.log_likelihood` in-place.
It is a forward pass through the existing computation graph — no
additional MCMC.

For the `pm.sample()` fallback path (when nutpie is not installed),
pass `idata_kwargs={"log_likelihood": True}` to get the same result
during sampling.

**Cost**: one forward pass per posterior draw through the existing
computation graph. No additional sampling. Storage is
(n_chains × n_draws × n_data_points) floats. For vectorised nodes,
n_data_points is the sum of array lengths across all observation
nodes — typically a few hundred. With 2000 draws × 4 chains, this is
~800K floats. Negligible.

### 4.2 Run PSIS-LOO

After log-likelihoods are populated, call
`az.loo(trace, pointwise=True)`. This performs Pareto-smoothed
importance sampling to approximate leave-one-out predictive densities
without refitting.

**Cost**: pure numpy. Subsecond for the data point counts in a
typical graph.

### 4.3 Compute null log-likelihoods

For each named observation node, evaluate the log-pmf at the analytic
point estimates with analytic completeness (§3.1). Single forward
pass, no sampling.

- Binomial nodes: `log Binom(k | n, p_analytic × F_analytic)`
- BetaBinomial nodes: `log BetaBinom(k | n, α_null × F_analytic, β_null × (1 − F_analytic))` — note: completeness enters the BetaBinomial via the α/β parameterisation, mirroring how the Bayesian model applies it
- DirichletMultinomial nodes: `log DirMult(k_vec | n, κ_null × p_vec × F_analytic)` — same pattern for branch groups

Use `scipy.stats.binom.logpmf`, `scipy.stats.betabinom.logpmf`,
and the DirichletMultinomial log-pmf (scipy does not provide this;
use the gammaln-based formula directly or a small utility).

For vectorised nodes, evaluate per data point (per anchor day) and
sum to get the per-node null log-likelihood.

### 4.4 Aggregate per edge

The raw LOO output gives one ELPD value per **data point** (per anchor
day within each vectorised node). Multiple nodes can contribute to the
same edge (e.g. `obs_w_reg_to_sub`, `obs_daily_reg_to_sub`,
`endpoint_bb_reg_to_sub`).

Aggregation:
1. Map each data point's ELPD_i to its edge (via the node name pattern
   and, for branch groups, the sibling attribution rule in §2.1).
2. Sum ELPD_i values per edge. Do the same for null log-likelihoods.
3. Compute ΔELPD = ELPD_bayes − ELPD_null per edge.
4. Compute max Pareto k per edge.

### 4.5 Where in the pipeline

In `worker.py`, between `run_inference()` and `summarise_posteriors()`,
for each phase:

```
trace, quality = run_inference(model, ...)
pm.compute_log_likelihood(trace, model=model)              # ← new
loo_result = az.loo(trace, pointwise=True)                 # ← new
null_loglik = compute_null_loglikelihoods(evidence, topology)  # ← new
elpd_per_edge = aggregate_loo_by_edge(loo_result, null_loglik, model)  # ← new
inference_result = summarise_posteriors(trace, ..., elpd_per_edge=elpd_per_edge)
```

### 4.6 Total additional wall-clock

`pm.compute_log_likelihood` dominates — one forward pass per draw.
Estimated 1–3 seconds for a typical graph. `az.loo` adds < 1 second.
Total: under 5 seconds on top of MCMC time (which is typically
30–120 seconds). Acceptable.

---

## 5. Output schema

### 5.1 Per-edge LOO metrics

Added to `PosteriorSummary` and `LatencyPosteriorSummary` (or a
companion structure passed through the pipeline):

| Field | Type | Meaning |
|---|---|---|
| `elpd` | float | LOO-ELPD for this edge (sum of per-data-point ELPD_i) |
| `elpd_se` | float | Standard error of the ELPD estimate |
| `elpd_null` | float | Plug-in log-likelihood under the analytic null (same data points) |
| `delta_elpd` | float | `elpd − elpd_null`. Positive = Bayesian improves on analytic. |
| `pareto_k_max` | float | Worst Pareto k across this edge's data points |
| `n_loo_obs` | int | Number of data points contributing |

Separate values for window (Phase 1) and cohort (Phase 2), stored on
their respective posterior slices.

### 5.2 Graph-level summary

Added to the `_bayes` metadata block on the graph:

| Field | Type | Meaning |
|---|---|---|
| `total_elpd` | float | Sum of per-edge ELPD across all edges |
| `total_delta_elpd` | float | Sum of per-edge ΔELPD |
| `worst_pareto_k` | float | Max Pareto k across all data points |
| `n_high_k` | int | Count of data points with Pareto k > 0.7 |

### 5.3 Webhook patch payload

The per-edge LOO fields flow through the same path as existing
posterior fields: `InferenceResult` → webhook patch → param file
posterior slices → graph edge posteriors. Add the six fields from §5.1
to the per-slice payload in the patch file.

---

## 6. Interpretation

### 6.1 ΔELPD

The primary user-facing metric. Interpretation:

| ΔELPD | Meaning |
|---|---|
| > 0 | Bayesian model predicts better than the analytic stats pass |
| ≈ 0 | No improvement (Bayesian model adds no value for this edge) |
| < 0 | Bayesian model is **worse** — potential overfitting or misspecification |

ΔELPD is on the log scale: a difference of 1 means an e-fold
(~2.7×) difference in predictive probability. Small absolute
differences can be practically important.

### 6.2 Pareto k

Reliability diagnostic for the LOO estimate itself:

| Pareto k | Meaning | Action |
|---|---|---|
| < 0.5 | Reliable | Use as-is |
| 0.5–0.7 | Acceptable | Minor concern |
| > 0.7 | Unreliable | LOO estimate for this data point is not trustworthy; the observation is highly influential |

High Pareto k typically occurs on edges with very small sample sizes
or extreme conversion rates — the posterior changes substantially when
that observation is removed.

### 6.3 What ΔELPD does NOT assess

ΔELPD on the named distribution types assesses p and κ. It does
**not** directly assess latency shape (onset, μ, σ). The completeness
factor F enters the likelihood, so gross latency errors will affect
ΔELPD indirectly (the product p×F will be wrong). But it cannot
distinguish "p is wrong" from "F is wrong" — those are confounded in
a count observation. Direct latency assessment requires trajectory
scoring (Phase 2, §8).

### 6.4 When ΔELPD < 0: system behaviour

ΔELPD < 0 means the Bayesian model predicts worse than the analytic
point estimates for this edge. This is a meaningful signal — not
necessarily a reason to reject the Bayesian result, but a reason to
investigate.

**Quality gate interaction** (doc 13): ΔELPD < 0 does **not**
automatically fail the quality gate. The existing gate checks
convergence (rhat, ESS, divergences). ΔELPD is a fit adequacy
metric, not a convergence metric — a model can converge well on a
specification that doesn't match the data.

**Recommended policy** (to be confirmed during implementation):
- ΔELPD < 0 → **warning tier** in the quality overlay (amber, not
  red). The Bayesian result is retained but flagged.
- ΔELPD < −X (threshold TBD, calibrated against real graphs) →
  **advisory in session log** suggesting the Bayesian model may not
  be appropriate for this edge.
- The user can still manually override to analytic via model_vars
  source preference (doc 15).

**Not recommended**: automatically demoting to analytic on ΔELPD < 0.
The Bayesian model provides uncertainty quantification (HDI, posterior
distributions) that the analytic model does not, even when its point
prediction is marginally worse. Automatic demotion would discard this.

---

## 7. Frontend exposure

### 7.1 Forecast Quality overlay (canvas)

**Current**: each edge bead shows a quality tier reason string (e.g.
"rhat 1.003 marginal", "Full Bayesian — strong evidence") computed in
`bayesQualityTier.ts`.

**Change**: add ΔELPD and Pareto k to the tier computation.

New warning conditions:
- `pareto_k_max > 0.7` → warning: "influential observations (k={v})"
- `delta_elpd < 0` → warning: "worse than analytic (ΔELPD={v})"

The existing green spectrum (good-0 through good-3) reflects evidence
grade. ΔELPD could refine this — an edge with strong evidence but
poor predictive fit should not be good-3 — but this is a design choice
to be resolved during implementation.

Bead text: the existing tier label, e.g. "Strong evidence" or
"Warning: worse than analytic". No raw ΔELPD numbers — business
users cannot interpret log-probability units.

### 7.2 Edge Info → Model tab (BayesPosteriorCard)

**Current**: shows p ± stdev, HDI, α/β, latency params, rhat, ESS,
evidence grade, fitted timestamp, and quality tier label.

**No raw LOO numbers in the headline footer.** The quality tier
label already absorbs LOO signals — "Warning: worse than analytic"
or "Warning: influential observations" appear when ΔELPD < 0 or
Pareto k > 0.7. The user sees a clear good/bad signal without
needing to interpret ELPD values.

Raw ΔELPD and Pareto k numbers are available in the diagnostic
popover (§7.3) for technical inspection.

### 7.3 PosteriorIndicator popover (diagnostic detail)

Add ΔELPD and Pareto k rows to the "Convergence" section of the
diagnostic table, alongside rhat and ESS. These are the raw values
for technical users — colour-coded amber/red at the same thresholds
as the quality tier warnings.

### 7.4 Graph-level summary

The `_bayes` metadata block already contains `quality: { max_rhat,
min_ess, converged_pct }`. Add `total_delta_elpd` and
`worst_pareto_k`. The `computeGraphQualityTier()` function can
incorporate these into its good/fair/poor/very poor classification.

---

## 8. Phase 2: trajectory scoring (future)

The trajectory likelihood (`traj_{type}_{edge}`) uses `pm.Potential`,
which PyMC cannot decompose into per-observation log-likelihoods.

**Approach — post-hoc log-likelihood computation**: after sampling,
loop over posterior draws and manually compute the conditional Binomial
log-probabilities for each trajectory interval using the same formula
as the Potential (doc 6 §product-of-conditional-Binomials). Feed these
to `az.loo()` as a pre-computed `log_likelihood` array merged into the
InferenceData.

This is the only correct approach. Adding named `pm.Binomial` nodes
alongside the Potential would **double-count** the trajectory data in
the model (both the Potential and the named nodes would contribute
log-probability), producing a wrong posterior.

Post-hoc trajectory scoring would extend LOO to the latency shape
model, providing direct assessment of onset, μ, σ.

---

## 9. References

1. Vehtari, Gelman & Gabry (2017). Practical Bayesian model evaluation
   using leave-one-out cross-validation and WAIC. *Statistics and
   Computing* 27, 1413–1432.
2. Gneiting & Raftery (2007). Strictly Proper Scoring Rules, Prediction,
   and Estimation. *JASA* 102(477), 359–378.
3. Czado, Gneiting & Held (2009). Predictive Model Assessment for Count
   Data. *Biometrika* 96(4), 777–792.
4. Gabry, Simpson, Vehtari, Betancourt & Gelman (2019). Visualisation
   in Bayesian workflow. *JRSS-A* 182(2), 389–402.
5. Vehtari, Simpson, Gelman, Yao & Gabry (2024). Pareto Smoothed
   Importance Sampling. *JMLR* 25(72), 1–58.
