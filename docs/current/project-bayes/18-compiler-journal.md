# Doc 18: Compiler Development Journal

**Purpose**: Chronological record of what was tried, what worked, what
failed, and what was learned during Bayes compiler development. Prevents
re-exploring dead ends and preserves reasoning for future reference.

Entries are reverse-chronological (newest first).

---

## 22-Mar-26: Synthetic data generator → parameter recovery attempt

### What was done

Built the `synth-simple-abc` graph: A → B → C linear chain with dropout
nodes, realistic latencies (onset 1–2d, median 10–14d), complement edges
for mass conservation. Ground truth: p(A→B)=0.7, p(B→C)=0.6.

**synth_gen.py restructured**: simulation and observation phases fully
separated. Window and cohort observations now represent genuinely different
populations — window groups by from-node arrival day (cross-day mixture
due to upstream latency), cohort groups by anchor entry day. Verified by
4 new pytest tests (`TestWindowVsCohortSemantics`), 27/27 pass.

**Data pipeline working**: 19,220 DB rows (9,610 window + 9,610 cohort),
real FE-computed core hashes (vitest parity verified), param files with
both window and cohort values[] entries. FE renders the graph and shows
cohort maturity S-curves.

**graph-ops moved to dagnet**: Generic playbooks, scripts, reference docs
scrubbed of proprietary content and moved to `dagnet/graph-ops/`. Data
repo retains only proprietary reference docs. Merged to
`nous-conversion/main`.

### Sampling performance problem — investigation log

**Symptom**: 2-edge synth graph takes 15 minutes to sample (887s,
252 divergences, kappa=728/868). The 4-edge production graph
(`bayes-test-gm-rebuild`) samples in ~4 minutes (241s, 151 divergences,
kappa=1.7-24.8). Despite the synth graph being simpler.

**Parameter recovery works**: When sampling completes, the posteriors
recover truth values accurately (mu, sigma, onset all within 1-2%).
The issue is purely sampling efficiency, not model correctness.

**What was ruled out**:

- **Data volume (total rows)**: Synth has fewer total rows (19K) than
  production (76K via hash equivalences). Not the issue.
- **Trajectory density (retrieval ages per anchor_day)**: Synth has 94
  retrieval ages vs production 5-27. The DM interval model decomposes
  into independent intervals — thin vs fat intervals contain identical
  statistical information. Extra density costs ~5-7x more gammaln calls
  per step but should NOT change posterior geometry.
- **Traffic per day**: Tried 5000/day and 300/day — same result.
- **PyTensor type bug**: Found `bool→float64` composite rewrite failure
  in `obs_daily_` path with small arrays. Fixed but didn't help — issue
  is in the trajectory Potentials.

**Key structural difference (NOT YET TESTED)**:

Production graph: 2 edges `latent_latency=False` (simple Binomial) +
2 edges `latent_latency=True` (CDF-based DM potentials).

Synth graph (`synth-simple-abc`): ALL edges `latent_latency=True`.
The `update_graph_edge_metadata` in synth_gen was hardcoding
`latency_parameter: True` on all fetchable edges — fixed to respect
the truth config.

**Hypothesis**: ALL-CDF models have worse geometry than mixed models.
The Binomial potentials provide well-conditioned probability anchors.
Without them, onset↔mu correlations (corr=-0.88) create narrow ridges.

**Next step**: Build `synth-mirror-4step` matching production structure
exactly (2 no-latency + 2 latency edges, similar traffic/p values).
Compare sampling performance. If it samples in ~4 minutes, the
hypothesis is confirmed.

**Also documented**: Bayes compiler uses `query_snapshots_for_sweep`
(all raw rows) while FE uses `query_virtual_snapshot` (latest-wins).
See `docs/current/codebase/snapshot-db-data-paths.md`.

### Blocked: FE stats pass not available in Python

The Bayes compiler needs priors (mu, sigma, onset, t95, forecast.mean)
on graph edges. These come from the FE "stats pass" which fits a
lognormal CDF to the maturation trajectories. Currently only implemented
in TypeScript (`statisticalEnhancementService.ts`).

For synthetic data graphs, we either:
1. Fake priors from the truth config (current hack)
2. Port the stats pass to Python (overdue, enables automated compiler
   development iteration)

Option 2 is next — the stats pass is conceptually simple (scipy
curve_fit on lognormal CDF, ~50–100 lines) and unblocks the full
generate → stats → compile → evaluate loop.

---

## 22-Mar-26: path_onset_delta_days — analytic model onset separation

### Problem statement

The analytic model (FE stats pass in `statisticalEnhancementService.ts`)
computes `path_mu`/`path_sigma` (FW-composed A→Y lognormal params) but
had no path-level onset field. The Bayes compiler has `PathLatency.
path_delta` (Σ edge onsets along path), but this was never parameterised
in the analytic model. Consumers (completeness calculations, Cohort
Maturity charts) either used edge-level onset as a fallback or had no
onset at all.

### What was implemented

Added `path_onset_delta_days` as a DP accumulator in the topo traversal,
mirroring the existing `nodePathMu`/`nodePathSigma` pattern:

- **Stats pass**: `nodePathOnset` map, initialised to 0 at anchor,
  accumulated as `upstream + edgeOnsetDeltaDays` at each edge. Propagated
  through all four skip/main paths. Written to `EdgeLAGValues.latency.
  path_onset_delta_days`.
- **Persistence**: `UpdateManager.applyBatchLAGValues` writes to graph
  edge. `mappingConfigurations.ts` syncs graph↔file bidirectionally.
- **Types**: Added to `Latency` interface (TS), `LatencyConfig` and
  `ModelVarsLatency` (Pydantic), `EdgeLAGValues` (stats pass internal).
- **Consumers**: `api_handlers.py` reads `path_onset_delta_days` (was
  `path_delta` which never existed on graph). `localAnalysis
  ComputeService.ts` falls through `posterior.path_onset_delta_days →
  lat.path_onset_delta_days → edgeOnset`.

### The onset separation problem

Attempted to make the system mathematically clean: path_onset = Σδ
carries the deterministic shift, path_mu/sigma carry onset-free
lognormal shape. This requires the anchor fit (A→X empirical data) to
subtract upstream onset before fitting.

**The anchor fit** (`fitLagDistribution(anchorMedian, anchorMean, ...)`)
takes raw `anchor_median_lag_days` from 3-step funnel data. These are
empirical observations in calendar time, including any A→X onset.

**Attempted fix**: subtract `nodePathOnset.get(nodeId)` (DP-accumulated
upstream onset) from anchor median/mean before fitting.

**Result**: curves looked worse. The DP-accumulated onset is a sum of
statistical estimates (weighted quantiles from window slice data), not
a direct measurement. Subtracting this noisy estimate from clean
empirical data distorted the fit.

### Why the old approach worked

Before this change, the system was internally consistent in an
approximate way:

1. Anchor fit uses raw empirical A→X data — onset absorbed into μ
2. FW composes this with onset-free X→Y edge fit → `path_mu`,
   `path_sigma` (A→X onset baked into lognormal shape)
3. Consumer shifts CDF by edge onset only (δ_xy)
4. Net effect: A→X onset handled implicitly through μ shape, X→Y
   onset handled via explicit shift

The lognormal has enough shape flexibility to approximate a shifted
lognormal. The anchor fit captures the real empirical distribution
directly — no estimated quantity subtracted, no noise introduced.

### Two approaches to compare

**Approach A (status quo + field)**: Keep anchor fit raw (onset absorbed
into μ). Write `path_onset_delta_days = Σδ` to graph for informational
purposes, but consumers continue using edge onset when paired with
analytic `path_mu`/`path_sigma`. The field exists for Bayes and other
consumers that have onset-free μ/σ.

**Approach B (clean separation)**: Subtract upstream onset from anchor
moments before fitting, so path_mu/sigma are onset-free. Consumers use
`path_onset_delta_days = Σδ` as the CDF shift. Mathematically cleaner
but depends on onset estimate quality.

### Decision: empirical comparison needed

Rather than guessing which approach produces better fits, we should
measure it. Plan: use `synth_gen.py` to generate datasets with known
ground-truth parameters (including known onset per edge), run both
approaches on the same data, and compare fit accuracy using a
well-defined metric (e.g. integrated CDF error against the true
distribution). This parallels the parameter recovery testing approach
already planned for Bayes model validation (doc 17).

### Current state

Both approaches implemented: `path_onset_delta_days` DP accumulator,
onset-adjusted anchor fit (Approach B), and consumers using path onset.
Empirical comparison via synth_gen needed to validate whether Approach B
produces better or worse fits than Approach A (raw anchor + edge onset).

### Key invariant discovered

**Empirical anchor data should not be adjusted by estimated quantities
without validation.** The anchor_median_lag_days is a direct observation;
the DP onset sum is a derived estimate. Subtracting derived from observed
can only improve things if the derived quantity is accurate. This must be
verified, not assumed.

---

## 21-Mar-26: Diagnostic instrumentation reveals real problem

### What we did
Built `diag_run.py` — a diagnostic MCMC runner that dumps per-variable
rhat/ESS, per-chain step sizes, energy stats, tree depth, and per-chain
means for problematic variables. Output to `/tmp/bayes_diagnostics.txt`.

### Critical discovery: data wasn't binding
First two diagnostic runs showed **0 potentials, 0 observed** — the
model was sampling from priors. Root cause: the diag script called
`bind_evidence()` (param-file path) instead of `bind_snapshot_evidence()`
(snapshot DB path). Also had wrong DB connection string (hardcoded
localhost instead of reading from `graph-editor/.env.local`). Both bugs
masked the real model behaviour for hours.

**Lesson**: Always check potentials/observed count before interpreting
MCMC results. A model with 0 likelihood terms will converge perfectly
and tell you nothing.

### Real diagnostic result (with data)
Once evidence was binding correctly (49 free vars, 20 potentials,
2 observed):

- **0 divergences** — the sampler is NOT struggling with geometry
- **Max rhat: 1.53, Min ESS: 7, 65.7% converged**
- **The problem is ONE edge**: `delegation-straight-to-energy-rec`
  (`8c23ea34`). Chain 0 found a completely different posterior mode:
  - Chain 0: p=0.575, mu=5.43, sigma=3.01, kappa=6.0
  - Chains 1-3: p=0.157, mu=0.52, sigma=0.67, kappa=0.95
- Chain 0 energy: 108,608 vs chains 1-3: ~108,529 (chain 0 in higher-
  energy / worse mode)
- The bimodality drags along the sibling edge `delegated-to-non-energy-
  rec` (`10e37cc7`) via the shared Dirichlet

**Diagnosis**: Classic p-latency identifiability — high-p/slow-latency
and low-p/fast-latency both explain the arrival curve. NOT a join-node
geometry problem. NOT a gradient scale catastrophe.

### Excluded-edge confirmation
Ran with `--exclude delegation-straight`:
- **0 divergences, max rhat 1.027, 97.1% converged**
- Removing that single edge fixed convergence completely

### Compilation time concern
Both runs took ~155s for PyTensor compilation (nutpie
`compile_pymc_model`). The simple 4-edge graph compiles in ~3s. For
49 vars and 18-20 potentials this seems excessive. Investigated data
volumes: some edges have 10,000-12,000 age points flattened into
Potentials. May be a representation issue (each age point → symbolic
gammaln/erfc node in the gradient graph) rather than a data volume
issue. Open question.

---

## 21-Mar-26: Window/cohort independence insight

### Reasoning
Window observations (edge-level: "of people at X, how many reached Y
by age t?") are fundamentally independent of graph structure:
- Window p is an edge-level quantity — doesn't depend on how people
  reached the source node
- Window latency CDF uses only the edge's own (onset, mu, sigma)
- No upstream path composition, no join-node mixture, no Dirichlet
  coupling

Cohort observations (anchor-level: "of people at the anchor, how many
reached Y by age t?") depend on full graph structure:
- p_path = product of p's along the path
- CDF = FW-composed latency of all edges on the path
- At joins: mixture of path CDFs weighted by path probabilities

### Implication
All convergence problems we've encountered are in cohort likelihoods,
specifically at join-downstream edges. Window fitting is well-conditioned
and always converges. This suggests a natural two-phase decomposition:

**Phase 1**: Fit all window observations per-edge (no graph structure).
Produces well-estimated p_window and (mu, sigma) per edge.

**Phase 2**: Fit cohort observations using Phase 1 posteriors as strong
priors on latency. The p-latency bimodality at joins disappears because
latency is already pinned from window data.

**Status**: Not yet implemented. Under consideration.

---

## 21-Mar-26: Mixture-path DP reverted

### What we did
Removed the mixture-path dynamic programming code from `model.py`
(lines 105-232) and all `node_components` / `mixture_components`
references. Reverted to the simpler approach where topology handles
join collapse at analysis time and the model builder does linear FW
composition along pre-selected `path_edge_ids`.

### Why
The mixture-path approach (carrying all path components forward as
separate CDFs) timed out at 900s on the branch graph — stuck at 52%
with 2 chains permanently stalled. Also doubled PyTensor compilation
time (60s → 125s). Wanted a simpler starting point for diagnostic
instrumentation.

---

## 20-Mar-26: External review of join-node convergence

### What we did
Wrote comprehensive briefing note (`bayes-join-node-convergence-
briefing.md`) documenting the join-node convergence problem, shared
for external review.

### Reviewer feedback
1. **Diagnosis agreed**: posterior geometry / identifiability problem,
   not a graph-DP bug. Low-weight paths at joins have weakly identified
   mu/sigma.
2. **Recommended**: two-stage model (fit latency first, then p with
   fixed latency at joins).
3. **Alternative**: softmax reparameterisation of join-node path shares
   + stronger non-exchangeable priors.
4. **Against**: mean-field ADVI (too weak for ridged/multimodal
   posteriors). PyMC SMC better for diagnosing multimodality.
5. **Ranking**: fixed/drawn join latencies > softmax repar > SMC
   diagnostic > more moment matching.

### Our counter-argument
The two-stage approach has a fundamental flaw for immature cohorts:
`E[count] = n × p × CDF(t)`. If CDF < 1, you can't separate p from
latency without fitting the trajectory shape jointly. Fixing latency
and fitting p introduces bias precisely when it matters most (immature
cohorts where completeness correction is large).

The window/cohort independence insight (above) offers a better version
of the two-stage idea: Phase 1 pins latency from window data (which
IS edge-level and well-conditioned), then Phase 2 uses those strong
priors for cohort fitting at joins.

---

## 20-Mar-26: Mixture-path CDF approach (failed)

### What we tried
Instead of collapsing to a single lognormal at joins, carry all path
components forward as separate CDFs:
```
node_components[node_id] = [(weight_i, onset_i, mu_i, sigma_i), ...]
```
At joins: concatenate component lists from all inbound edges. CDF at
any point: `Σ w_i × CDF_LN(t, onset_i, mu_i, sigma_i) / Σ w_i`.

### Result
Timed out at 900s, stuck at 52%. Two of four chains completed; two
permanently stalled. Compilation time doubled (60s → 125s).

### Why it failed
Even without the `exp()` blowup of moment-matching, the weight-CDF
coupling remains: changing one path's weight (by adjusting constituent
p values) while component CDF shapes also change creates ridges and
funnels. Low-weight paths are weakly identified. The fundamental
identifiability issue isn't the parameterisation — it's that the
data can't decompose the mixture into per-path components.

---

## 20-Mar-26: Moment-matched collapse at joins (failed)

### What we tried
At each join node, collapse the mixture of inbound path latencies into
a single shifted lognormal by matching first two moments. Implemented
in PyTensor for differentiability (`pt_moment_matched_collapse`).

### Result
rhat=2.83, ESS=5, massive divergences.

### Why it failed: gradient scale catastrophe
The moment computation requires `exp(mu + sigma²/2)`:
- Direct path (1 hop): mu~0.7 → exp(0.82) ≈ 2.3
- BDS path (3 hops): mu~3.5 → exp(4.0) ≈ 55

25x gradient scale mismatch across components. NUTS uses a single
(diagonal) mass matrix and cannot simultaneously take appropriate
step sizes for both.

### Attempted fixes
1. **Log-sum-exp version**: Rewrote moment computation in log-space.
   Same failure — the problem is the nonlinear coupling, not numerical
   overflow.
2. **Warm-start from previous posteriors**: rhat=1.53, ESS=7. The
   problem is geometry, not starting point.

---

## 20-Mar-26: Per-edge overdispersion (succeeded)

### What we tried
Replace Binomial with BetaBinomial, Multinomial with Dirichlet-
Multinomial. Per-edge latent κ ~ Gamma(3, 0.1) controls overdispersion.

### Result
0 divergences on both test graphs. Per-edge κ values range from 1.5
(heavily overdispersed, early funnel) to 23.7 (nearly Binomial, late
funnel). Matches expectation: traffic-dependent edges have more day-to-
day jitter.

### Key: per-edge, not global
Initially considered a single global κ. User questioned why κ=4.1
would be appropriate throughout the graph. Switched to per-edge κ.
This was the right call — κ varies 15x across edges.

---

## 19-Mar-26: Snapshot evidence pipeline aligned

### What we tried
Rewrote `worker._query_snapshot_subjects` to use `snapshot_service.
query_snapshots_for_sweep()` instead of hand-rolled SQL.

### Why
The FE sends `equivalent_hashes` as ClosureEntry objects (`{core_hash,
operation, weight}`). The hand-rolled SQL passed these dicts into
`ANY(%s)`, causing `can't adapt type 'dict'` errors. All snapshot
queries were failing silently, so the model ran with zero trajectory
data and latency fell back to priors with huge uncertainty.

### Result
FE roundtrip confirmed working. Snapshot data flowing correctly.

---

## 19-Mar-26: Latency prior source debate

### Question
Where should first-run latency priors come from? Options:
1. `median_lag_days` / `mean_lag_days` from param file values[]
2. t95 from graph edge latency block
3. Uninformative defaults (mu=0, sigma=0.5)

### Problem
Window-type values[] entries have zero `median_lag_days` / `mean_lag_
days` (doc 16 defect). So option 1 produces pathological priors.

### Resolution
Uninformative priors (mu=1.5, sigma=1.5) tried first: rhat=1.734,
ESS=6 — too diffuse for NUTS.

Then t95 fallback implemented: `mu = log(t95 - onset) - 1.645 × 0.7`,
`sigma = 0.7`. User initially questioned this but accepted after
confirming t95 comes from a manually-operated lag fit process (not raw
data). Produces sensible priors. 17 divergences → 0 with t95 priors.

### Future
Warm-start from previous posteriors is the proper solution. t95 fallback
is a pragmatic bridge for first runs.

---

## 19-Mar-26: Second test graph added

### What we did
Created the branch test graph (complex topology) in the data repo
with all dependencies (10 params, 8 events, 1 context, 12 nodes).
Branch groups, join nodes, diamond patterns.

### Why
Phase D join-node handling needs a graph with non-trivial joins. The
simple 4-edge linear chain doesn't exercise branch groups or joins.

---

## 18-Mar-26: Dirichlet-Multinomial for branch groups with trajectories

### Problem
`_identify_branch_group_window_edges` only checked `ev.window_obs`
(the old param-file path). With snapshot data, window evidence lives
in trajectories inside `ev.cohort_obs[].trajectories` where
`obs_type == "window"`. Branch groups were silently not emitting DM
likelihoods.

### Fix
Updated the check to also inspect trajectory data in cohort_obs.

---

## Phase S: Potential vectorisation (delivered)

### What we tried
Replace per-day `pm.Multinomial` observed nodes with a single
`pm.Potential` per obs_type per edge, flattening all trajectory
intervals into vectorised array operations.

### Why
PyTensor compilation was taking 5+ minutes with per-day observed
nodes (hundreds of small symbolic subgraphs). A single Potential with
vectorised numpy arrays + PyTensor ops compiles in seconds.

### Result
Compilation time dropped from 5 minutes to <3 seconds (simple graph).
Branch graph still takes ~155s — under investigation.

---

## Approaches NOT yet tried

For reference, these remain in the possibility space:

1. **Window-first two-phase decomposition** (21-Mar-26 insight):
   fit window data per-edge first, use posteriors as priors for
   cohort fitting. Most promising next step.

2. **Softmax reparameterisation at joins**: parameterise join-node
   path shares on unconstrained logits instead of products of upstream
   p's. Reviewer-recommended. Concern: creates over-parameterisation
   (path shares must agree with edge-level p values).

3. **Synthetic data generator** (doc 17): Monte Carlo simulator for
   parameter recovery tests. Would definitively separate model issues
   from data issues. High priority.

4. **SMC (Sequential Monte Carlo)**: PyMC's SMC sampler uses tempering
   from prior to posterior. Better probe for multimodality than ADVI.
   Diagnostic tool, not primary inference.

5. **Non-centred reparameterisation of path latency**: parameterise
   path-level latency directly instead of composing from edge-level.

6. **Per-sibling completeness in branch group DM**: each sibling's
   CDF may differ (different latency). Currently uses a single
   completeness for the group.

7. **Variational inference (ADVI / normalising flows)**: rejected by
   reviewer as primary method (mean-field too weak for ridged
   posteriors). May have role as initialiser.

---

## Feature flags added (21-Mar-26)

`build_model()` now accepts a `features` dict for controlled A/B
testing:

- `latent_latency`: if False, skip latent mu/sigma (Phase S behaviour)
- `cohort_latency`: if False, skip cohort latency hierarchy
- `overdispersion`: if False, use Binomial/Multinomial (no per-edge κ)

`diag_run.py` exposes these as `--no-latency`, `--no-cohort-latency`,
`--no-overdispersion` flags.

---

## Key invariants discovered

1. **Window observations are edge-local**: never depend on graph
   structure, upstream paths, cohort slices, or join-node behaviour.
   Window fitting is always well-conditioned.

2. **Convergence problems come from cohort likelihoods at joins**:
   specifically from the p-latency coupling in the mixture CDF.
   Window-only models converge perfectly.

3. **Per-edge κ matters**: overdispersion varies 15x across edges.
   A single global κ would be wrong.

4. **The bimodality on `delegation-straight-to-energy-rec` is the
   sole convergence blocker**: excluding it gives rhat=1.03. May be
   a data quality issue rather than a model structure issue.

5. **155s compilation time for 49 vars is suspicious**: the simple
   graph (24 vars) compiles in 3s. Likely a representation issue in
   the PyTensor graph, not inherent model complexity.
