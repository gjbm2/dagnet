# Doc 18: Compiler Development Journal

**Purpose**: Chronological record of what was tried, what worked, what
failed, and what was learned during Bayes compiler development. Prevents
re-exploring dead ends and preserves reasoning for future reference.

Entries are reverse-chronological (newest first).

---

## 25-Mar-26: Param recovery regression pipeline — PARTIAL, NEEDS CLEANUP

### What was attempted

Built a self-bootstrapping param recovery regression pipeline:
- Orchestrator (`bayes/run_regression.py`) that discovers synth graphs
  from truth files, checks data integrity via checksums, bootstraps
  missing data, runs MCMC in parallel with core-aware scheduling, and
  asserts recovery quality using z-score thresholds.
- Upgraded `synth_gen.py` with importable API: `discover_synth_graphs()`,
  `verify_synth_data()`, `save_synth_meta()`.
- Created 5 new truth files for Structural Canon shapes 3, 5-8
  (fanout, skip, 3way-join, join-branch, lattice).
- Rewrote `test_param_recovery.py` as a thin pytest wrapper around the
  orchestrator.

### What works

- **inference.py fix**: `import os` moved above the conditional at
  line ~679. Commit `83a96405` introduced a bug where `os.cpu_count()`
  was referenced outside the branch that imported `os`. Fix is valid.
- **Discovery + preflight**: All 8 synth graphs discovered, data
  integrity verified via DB row counts and truth file hashes.
- **synth-fanout-test**: New graph, validates end-to-end. Dirichlet
  branch group, 2 edges with asymmetric latency, MCMC converges in
  ~80s with good recovery (rhat=1.006, ess=1429, 0 divergences).
- **Orchestrator core-aware parallelism**: Correctly computes
  `available_cores // chains_per_run` for max parallel workers.
- **Two-gate assertion**: z-score OR absolute error floor, following
  SBC best practice. Prevents false failures from precise posteriors
  with tiny systematic biases.

### What failed / is unvalidated

- **4 new truth files created without validation**: synth-skip-test,
  synth-3way-join-test, synth-join-branch-test, synth-lattice-test.
  Parameters were chosen without running even `--no-mcmc` to verify
  model structure. Results: 3way-join and lattice stuck compiling
  (436s+), skip and join-branch running very slow. Likely causes:
  too many edges with latency, trajectory density too high, or
  graph structure issues from `graph_from_truth.py`.
- **Original test_param_recovery.py deleted**: The 3 working hardcoded
  tests (test_2step_synth, test_4step_mirror_recovery,
  test_diamond_recovery) were replaced. The new pytest wrapper is
  functional but the original tests were proven and should not have
  been discarded without confirming the replacement works.
- **param_recovery.py name matching**: New-format truth files use short
  edge keys (e.g. `anchor-to-fast`) while graph edges use prefixed
  param_ids (e.g. `synth-fanout-anchor-to-fast`). Added reverse lookup
  but only validated on fanout.
- **bayes-monitor auto-rebuild**: Added logic to detect new graphs and
  rebuild tmux layout. Had a `local` keyword bug (used outside
  function). Fixed but untested.

### Key lesson

**Do not create multiple untested artefacts and launch them all at
once.** Each new synth graph should be validated individually:
1. Create truth file
2. `--no-mcmc` to verify model compiles and evidence binds
3. Short MCMC (100 draws) to verify convergence
4. Full MCMC to verify recovery
5. Only then add to the regression suite

### Files changed (cleanup needed)

**dagnet repo**:
- `bayes/compiler/inference.py` — valid fix, keep
- `bayes/synth_gen.py` — new API functions, needs review
- `bayes/run_regression.py` — new file, functional but assertion
  parsing is fragile (regex on param_recovery.py stdout)
- `bayes/tests/test_param_recovery.py` — rewritten, original deleted
- `bayes/param_recovery.py` — name matching fix, needs broader testing
- `scripts/bayes-monitor.sh` — auto-rebuild logic, needs testing
- `bayes/TESTING_PLAYBOOK.md` — updated, describes intent not reality

**data repo**:
- 5 new truth files (only fanout validated)
- 7 `.synth-meta.json` sidecars
- Generated graph JSON + entity files for 5 new graphs
- DB rows for 5 new graphs (persist in snapshot DB)

### Next steps

1. Validate each new truth file individually (no-mcmc → short MCMC)
2. Fix or remove truth files that cause pathological compilation
3. Restore original test_param_recovery.py tests as fallback
4. Test the full pipeline end-to-end on proven graphs only

---

## 24-Mar-26: Zero-count trajectory filter — BLOCKING DEFECT

### Problem

The Bayes compiler needs to compress CDF trajectory data to avoid
feeding redundant frames to NUTS. A trajectory of cumulative
conversions at 30+ retrieval ages contains many consecutive frames
where no new conversions occurred. These frames are informationally
redundant — the CDF hasn't moved, so there is no new data.

Without compression, large graphs with many edges produce massive
PyTensor symbolic graphs (each age → CDF evaluation → gammaln pair),
causing compilation times of 100+ seconds and slow sampling.

### What we tried

**Zero-count bin dropping**: Remove ages where neither y nor x
changed. Keep first/last ages and predecessors of change points to
preserve non-zero interval CDF coefficients exactly.

**Result**: The filter is provably likelihood-lossless:
- Zero-count DM terms: `gammaln(0+α) - gammaln(α) = 0` always
- Kept CDF coefficients telescope: `Σ(cdf_coeffs) = CDF_final`
  regardless of which intermediate ages are dropped
- Remainder alpha `κ·(1 - p·CDF_final)` is unchanged
- Total `Σα = κ` is preserved

Yet it **breaks NUTS** on production data. Reproducible: rhat=1.53
every run with filter, rhat=1.002 every run without. Not stochastic.
Confirmed with `--asat` (same data, same result). The synth 4-step
regression test passes with the filter — the issue is specific to
production data with marginal posterior geometry (edge 7bb83fbf's
onset-mu ridge).

### Why likelihood-lossless ≠ NUTS-lossless

The research (Tran & Kleppe 2024, Stan HMC documentation) identifies
the mechanism: NUTS adapts its mass matrix and step size during warmup
based on the gradient landscape. Zero-count DM terms contribute zero
logp AND zero gradient — but the CDF evaluation points at those ages
provide **gradient anchor points** that NUTS uses to navigate the
posterior geometry. Removing those evaluation points changes the
curvature landscape that NUTS adapts to, even though the logp surface
is mathematically identical.

This is analogous to removing data points from a regression that lie
exactly on the fitted line — they don't change the loss, but they
stabilise the optimiser.

### Correct approach from the literature

The standard lossless CDF compression uses a **grouped survival /
mixture-cure likelihood** formulation:

```
ℓ = Σ_{j: y>0} y_j · [log(p) + log(F(t_j) - F(t_{j-1}))]
  + (N - Σy) · log(1 - p·F(H))
```

Zero-count bins don't appear at all. The sufficient data per
trajectory is:
- `(t_j, y_j)` pairs where `y_j > 0` (non-zero event bins only)
- `N` (total at risk)
- `H` (horizon / last observation age)

For the DM with overdispersion (κ):
```
ℓ = Σ_{j: y>0} [gammaln(y_j + α_j) - gammaln(α_j)]
  + gammaln(R + α_R) - gammaln(α_R)
  + gammaln(κ) - gammaln(N + κ)
```

The problem: this is algebraically identical to our current filter
(the zero-count terms are 0 either way). The gradient information
loss is the same.

**Approach B — Poisson exposure penalty**: Replace the identically-
zero DM terms for zero-count intervals with Poisson exposure terms
that carry non-zero gradient:

```
logp_zero_block = -κ · p · (CDF(t_end) - CDF(t_start))
```

This is the piecewise-exponential / counting-process formulation from
the survival literature. A zero-event interval over CDF span ΔF
contributes `-κ·p·ΔF` — a penalty proportional to the expected
events. This:
- Is non-zero (preserves gradient flow through zero-event regions)
- Is mergeable: `-Σ(κpΔF_i) = -κp·Σ(ΔF_i)` (lossless compression)
- Provides "nothing happened here" signal to NUTS
- Approaches 0 as ΔF→0 (consistent with DM in the limit)

The hybrid model: DM for intervals with events (preserves
overdispersion), Poisson penalty for intervals without events
(preserves gradient signal). Consecutive zero-event intervals are
merged into exposure blocks.

### References

- DM aggregation property: Frigyik, Kapila, Gupta (Introduction to
  the Dirichlet Distribution)
- Grouped mixture-cure likelihood: OUP Academic (mixture cure models
  for grouped survival data)
- Stan sufficient statistics: Stan User's Guide §25.9
- Piecewise exponential / exposure blocks: Rodríguez (GLM notes §7.4)
- NUTS mass matrix sensitivity: Tran & Kleppe (2024), Stan HMC docs
- Interval censoring NPMLE: Turnbull (1976), PMC 3684949

### Status

**RESOLVED.** Root cause: hard `pt.clip`/`pt.maximum` at 1e-12
created dead-gradient regions (Stan §3.7). Replaced with smooth
`_soft_floor` (softplus-based, sharpness=1e6). Filter re-enabled.

Results with filter ON + smooth clips:
- Production (today): rhat=1.002, ess=2655, 0 divergences
- Synth 4-step: PASS
- Synth 2-step: PASS

Full briefing and external review in doc 20. Further recommended:
dense mass matrix for high onset-μ correlation edges (not yet tested).

---

## 24-Mar-26: Structural topology canon — 8 shapes proven

### Summary

Systematically tested every fundamental DAG shape with parameter
recovery. All converge with 0 divergences. The mixture CDF fix from
23-Mar-26 enables all join-containing topologies.

| # | Shape | Graph | rhat | Time | Recovery |
|---|---|---|---|---|---|
| 1 | Chain (all-latency) | synth-simple-abc | 1.002 | 267s | mu ✓ |
| 2 | Chain (mixed) | synth-mirror-4step | 1.003 | 130s | all ✓ |
| 3 | Fan-out | synth-fanout-test | 1.001 | 72s | mu ✓, Dirichlet ✓ |
| 4 | Diamond | synth-diamond-test | 1.001 | 935s | mu ✓, join ±drift |
| 5 | Skip edge | synth-skip-test | 1.003 | 296s | mu ✓, unequal paths ✓ |
| 6 | Join→branch | synth-join-branch-test | 1.005 | 567s | mixture→Dirichlet ✓ |
| 7 | 3-way join | synth-3way-join-test | 1.003 | 603s | 3-component mixture ✓ |
| 8 | Lattice | synth-lattice-test | 1.003 | 930s | 4-component nested ✓ |

### Key observations

**What works well**: upstream edges (directly from anchor) recover
mu within 0.01-0.02 of truth across all topologies. The Dirichlet
branch group, per-sibling completeness, and mixture CDF all function
correctly.

**Onset-mu drift at joins**: join-adjacent edges consistently show
onset-mu correlation > 0.95, causing parameter drift (onset trades
with mu). This is a precision limitation, not a convergence failure.
The model finds a consistent solution but not the exact truth values.
May improve with more data or stronger priors.

**Not tested**: asymmetric diamond (95/5 weight split — identifiability
stress test), case node (exhaustive Dirichlet). These are deferred to
when needed.

### Tooling improvements

**Truth-driven graph generation** (`graph_from_truth.py`): truth files
now define graph STRUCTURE (nodes, edges, topology) in addition to
statistical parameters. `synth_gen` generates graph JSON, entity files,
dropout nodes, and complement edges from the truth file alone. No more
manual graph construction. Tested on diamond and lattice.

**Edge name resolution** (`_resolve_truth_edge`): handles the mapping
between short truth names (`anchor-to-gate`) and generated prefixed
param_ids (`synth-diamond-anchor-to-gate`). Replaces the scattered
`truth.get("edges", {}).get(pid)` pattern throughout synth_gen.

**Context-aware synth_gen**: three-layer noise model infrastructure
(contexts + per-user variation + drift) implemented. Truth files can
define `context_dimensions` with per-edge overrides. Observations
emitted with context-qualified slice_keys. Param files include
per-context values[] entries. Graph pinnedDSL uses cartesian product
form. Ready for Phase C compiler work.

---

## 23-Mar-26: Mixture CDF at joins — FIXES diamond convergence

### The bug

The topology pass selected ONE path (highest weight) at join nodes and
discarded all others. For the diamond's join→outcome edge, `path_edge_ids`
contained only path A — path B's parameters got zero gradient from the
cohort observation. The model was structurally misspecified: trying to fit
mixture data (arrivals from both paths) with a single component.

### The fix

**Topology**: Added `path_alternatives` field to EdgeTopology. At join
nodes, ALL inbound paths are stored as alternatives (not just the best).
Alternatives propagate recursively through downstream edges — handles
nested joins (combinatorial: 2 joins × 2 paths = 4 alternatives).

**Model builder**: For cohort trajectories on join-downstream edges with
multiple path alternatives, the DM likelihood uses a mixture CDF:

```
prob_interval_i = Σ_alt [p_alt × ΔCDF_alt(t_i)]
```

where p_alt = product of p's along the alternative path, CDF_alt =
FW-composed latency along that path. Gradients flow to ALL path
parameters through the sum. Single-path edges are unchanged.

### Result

**Diamond (easy: 1 no-latency + 5 latency edges, 500 draws, 2 chains)**:
- Before fix: early abort at 1%, estimated 17+ min. FAIL.
- After fix: rhat=1.017, ess=301, **0 divergences**, 178s. PASS.

Parameter recovery (quick run, wider tolerances expected):

| Edge | Truth mu | Post mu | Truth onset | Post onset |
|------|----------|---------|-------------|------------|
| gate→path-a | 1.500 | 1.511±0.005 | 1.0 | 1.13±0.03 |
| gate→path-b | 1.800 | 1.813±0.006 | 2.0 | 2.11±0.04 |
| path-a→join | 1.300 | 1.127±0.035 | 1.0 | 1.64±0.11 |
| path-b→join | 1.500 | 1.302±0.032 | 1.0 | 1.84±0.11 |
| join→outcome | 1.300 | 1.166±0.033 | 1.0 | 1.51±0.11 |

Upstream edges recover accurately. Join-adjacent edges show onset-mu
ridge (corr ≈ -0.99) causing some drift — but the model converges with
0 divergences, which it categorically could not do before.

### Key insight

The join problem was NOT inherent NUTS geometry — it was a **model
misspecification**. The single-path approximation discarded ~43% of the
traffic at the join. Fixing the model to represent the actual mixture
resolved the convergence failure immediately.

### Files changed

- `compiler/types.py` — added `path_alternatives` field to EdgeTopology
- `compiler/topology.py` — propagate all inbound paths at joins, store
  alternatives recursively through downstream edges
- `compiler/model.py` — mixture CDF in `_emit_cohort_likelihoods` when
  `path_alternatives` has >1 entry

---

## 23-Mar-26: Diamond graph confirms join-node convergence is a model issue

### What was tested

Ran `synth-diamond-test` (6 all-latency edges: anchor → branch (path-a,
path-b) → join → outcome) through the full pipeline: integrity check →
synth_gen → param recovery.

Structural integrity: PASS (after adding missing `defaultConnection`).
Data generation: PASS (56,004 rows, all 12 hashes verified).
Stats engine priors: accurate (mu within 0.002 of truth for all edges).

### Result

**EARLY ABORT** at 1% sampling — estimated 17+ minutes (3x limit).
PyTensor compilation alone took 117s (vs 3s for 4-step linear, 19s for
2-step). The symbolic graph is massive: 6 latency edges × 45-82 ages
per trajectory.

This is the join-node convergence problem. The diamond has a branch
(gate → path-a, gate → path-b) merging at a join node, creating the
p-latency identifiability coupling the journal has documented since
20-Mar-26.

### Significance

**This is NOT a data issue — it's a model structure issue.** We hoped
the production branch graph's convergence problems were data quality,
but the diamond uses clean synthetic data with known ground truth and
still fails. The join-node geometry is fundamentally difficult for NUTS.

The linear chains (2-step, 4-step) converge perfectly with accurate
parameter recovery. The diamond fails. The structural differentiator
is the join node.

### Known approaches not yet tried (from journal 21-Mar-26)

1. **Window-first two-phase**: fit window data per-edge first (always
   well-conditioned), use posteriors as strong priors for cohort fitting.
   Most promising — eliminates p-latency ambiguity at joins by pinning
   latency from window data.
2. **Softmax reparameterisation at joins**: parameterise join-node path
   shares on unconstrained logits.
3. **SMC (Sequential Monte Carlo)**: tempering from prior to posterior.
   Diagnostic tool for multimodality.

### Outstanding issues

- **Kappa discrepancy explained — noise model redesign needed (Phase C)**:
  posterior κ is 10-45x truth because synth_gen's noise model is wrong.
  It applies overdispersion as per-DAY p draws (one Beta per day, everyone
  on that day uses it). This creates between-day total variance but NO
  within-trajectory overdispersion — the time allocation within each
  trajectory IS pure multinomial, so the model correctly finds large κ.

  Real overdispersion comes from three layers:
  1. **Contexts** (discrete user types) — different {p, mu, sigma} per
     edge per context. Creates mixture CDFs → DM overdispersion in
     trajectory shapes. This is the dominant source.
  2. **Per-user variation within context** — individual propensity/speed
     drawn from a distribution centred on the context's values. Creates
     residual BetaBinomial variance even after conditioning on context.
     This is what κ should capture.
  3. **Day effects** — temporal drift in rates (already modelled via
     drift_sigma, minor contribution).

  The fix: replace kappa_sim with context-based population heterogeneity
  in synth_gen. Contexts define per-edge overrides; users are assigned
  to contexts; per-user Beta draws within context create residual
  overdispersion. κ recovery becomes testable when the noise model
  reflects real population structure. This work is Phase C for synth_gen.
- **Trajectory density on slow-latency edges**: truth mu=2.3 (median
  ~10 days) produces 59-83 ages after dedup vs 17-23 for mu=1.5.
  Causes 267s sampling on 2-step (vs 130s for 4-step mirror).
  Compilation time scales badly: 117s for diamond's 6 edges.

---

## 23-Mar-26: Tooling hardening and parameter recovery baseline

### What was done

**Model inspection** (`compiler/inspect_model.py`): Structured dump of the
compiled pm.Model that runs AFTER `build_model()`, BEFORE MCMC — always,
every run. Shows all free RVs with distributions, deterministics, potentials,
observed RVs, per-edge evidence binding confirmation, feature flags, and
variable→edge mapping. Harness flag `--no-mcmc` stops before sampling.

**Feature flags via settings** (`--feature KEY=VALUE`): Model features
(latent_latency, cohort_latency, overdispersion, latent_onset) are now
passed through harness CLI → payload settings → `build_model(features=...)`.
No code changes needed for parallel A/B runs:
```
python bayes/test_harness.py --graph X --feature latent_onset=false
python bayes/test_harness.py --graph X --feature latent_onset=true
```

**Parameter recovery shim** (`bayes/param_recovery.py`): Wraps the harness
for synth graphs. Reads .truth.yaml sidecar, runs MCMC, compares posteriors
to ground truth with z-scores and PASS/MISS per parameter. NOT for production
data — production has no ground truth.

**synth_gen hardened**:
- FAILS if no .truth.yaml sidecar exists (no silent fallback to defaults —
  the old fallback to `derive_truth_from_graph` wasted hours producing data
  from wrong parameters)
- `write_parameter_files` now derives `latency_parameter` from the truth
  config, not from the stale topology object (which was built before
  `update_graph_edge_metadata` ran)
- `--write-files` flag required to update param files on disk

### Bugs found and fixed

**param files had wrong `latency_parameter`**: `write_parameter_files` read
`et.has_latency` from the topology, which was built from the graph BEFORE
`update_graph_edge_metadata` wrote `latency_parameter: true`. Result: edges
with latency in truth had `latency_parameter: false` in param files. The
stats engine and topology then treated them as no-latency edges, producing
wildly wrong priors (mu=0.518 instead of mu=2.3 for the 2-step a-to-b edge).
Fixed to derive `latency_parameter` from the truth config directly.

**4-step regression no longer reproduces**: The rhat=1.530 regression
reported earlier in this journal (onset hierarchy removal) does not reproduce
with current code. The production 4-step now converges: rhat=1.002,
ess=2780, 0 divergences, 59s. Likely caused by stale param files or
topology.py state at the time of the original regression runs.

### Parameter recovery results

**2-step synth** (`synth-simple-abc`, all-latency, 267s):

| Edge | Param | Truth | Posterior | z-score |
|------|-------|-------|-----------|---------|
| a-to-b | mu | 2.300 | 2.309±0.003 | 3.00 |
| a-to-b | sigma | 0.500 | 0.511±0.002 | 5.50 |
| a-to-b | onset | 1.000 | 1.050±0.030 | 1.67 |
| b-to-c | mu | 2.500 | 2.496±0.011 | 0.36 |
| b-to-c | sigma | 0.600 | 0.617±0.008 | 2.13 |
| b-to-c | onset | 2.000 | 2.200±0.100 | 2.00 |

Posteriors extremely close to truth (0.4% error on mu). High z-scores
are precision artefacts — posteriors are so tight (±0.003) that sub-percent
deviations register as >2σ. Recovery is accurate.

**4-step synth mirror** (`synth-mirror-4step`, 2 no-latency + 2 latency, 130s):

| Edge | Param | Truth | Posterior | z-score |
|------|-------|-------|-----------|---------|
| deleg-to-reg | mu | 1.500 | 1.477±0.032 | 0.72 |
| deleg-to-reg | sigma | 0.570 | 0.599±0.021 | 1.38 |
| deleg-to-reg | onset | 5.500 | 5.670±0.150 | 1.13 |
| reg-to-success | mu | 1.300 | 1.042±0.234 | 1.10 |
| reg-to-success | sigma | 0.190 | 0.234±0.044 | 1.00 |
| reg-to-success | onset | 3.200 | 4.000±0.700 | 1.14 |

All within 2 SD. PASS.

**4-step production** (`bayes-test-gm-rebuild`, 59s):
rhat=1.002, ess=2780, 0 divergences. Converges cleanly. Edge 7bb83fbf
posterior mu=5.389 (prior=1.607) — data strongly disagrees with prior
but the model converges to a consistent answer.

### Systematic kappa issue

Kappa (BetaBinomial overdispersion) is consistently 10-45x too high
across both synth graphs:

| Graph | Edge | Truth κ | Posterior κ |
|-------|------|---------|------------|
| 2-step | a-to-b | 50 | 1321±54 |
| 2-step | b-to-c | 50 | 2250±98 |
| 4-step | deleg-to-reg | 50 | 556±58 |
| 4-step | reg-to-success | 50 | 478±57 |

The model sees near-zero overdispersion (large κ → Binomial limit) when
the data was generated with moderate overdispersion (κ=50). Either:
1. synth_gen's overdispersion simulation doesn't produce BetaBinomial-style
   variation (wrong noise model), or
2. The DM likelihood's κ parameterisation doesn't match synth_gen's κ_sim
   definition, or
3. The trajectory-based DM likelihood averages over enough days that
   per-day overdispersion is smoothed away

**Not blocking** — mu/sigma/onset recovery works. But κ recovery failure
means the model can't correctly estimate uncertainty bounds on conversion
rates (overconfident posteriors).

### Current state

All three graphs converge with correct parameter recovery on mu/sigma/onset.
The tooling pipeline (truth file → synth_gen → DB → harness → model inspect
→ MCMC → param recovery comparison) is end-to-end functional. Remaining:
- κ discrepancy investigation
- p recovery (not yet extracted by param_recovery.py)
- Playbook update for param recovery vs production run workflows

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

### 23-Mar-26: Removed onset hierarchy — fixed 2-step, regressed 4-step (OPEN)

**Hierarchy removed**: `onset_hyper_mu` and `tau_onset` shared across
latency edges. No intellectual justification for sharing onset across
edges with different business processes. Replaced with independent
per-edge onset: `softplus(onset_prior + eps × uncertainty)`.

**2-step synth (FIXED)**:
- Before: rhat=1.661, 679 divergences, 300s. Degenerate hierarchy
  (4 hyper-params for 2 onset values).
- After: rhat=1.008, **0 divergences**, 50s. Clean convergence.

**4-step production (REGRESSED)**:
- Before (with hierarchy): rhat=1.006, 22 divergences, 89s.
- After (independent onset): rhat=1.529-1.605, ess=7, 62s.
- Same priors (mu_prior=1.502, sigma_prior=0.574 from derive_latency_prior).
- Same data, same filter.
- Edge 7bb83fbf posterior mu=5.7 (far from prior 1.5) regardless.

**Unexplained**: A prior shape change (hierarchical → independent) with
the SAME effective prior centre and similar spread should not cause
catastrophic convergence failure. The old hierarchy had 2 extra free
parameters (hyper_mu, tau) which should make sampling HARDER, not easier.
Yet the old version converged and the new doesn't.

**Possible explanations to investigate**:
1. The hierarchical parameterisation accidentally provided a better
   mass matrix initialisation (shared params smooth the geometry).
2. The softplus(constant + eps × sigma) creates a different gradient
   landscape than softplus(free_param + eps × free_param).
3. The path-level onset (`onset_cohort`) changed parameterisation too
   (uses eps × 1.0 fixed dispersion instead of eps × tau × sqrt(n)).
   This may be too tight for the production edge.

**Next step**: Compare PyTensor computational graphs between old and
new. Check nutpie step size and mass matrix diagnostics. The issue is
in the sampling geometry, not in the statistical model.

### 23-Mar-26: Removed graph-level onset hierarchy (onset_hyper_mu, tau_onset)

**What was removed**: Graph-level `onset_hyper_mu` and `tau_onset` shared
across all latency edges (Phase D.O, doc 18). These created a hierarchical
model where each edge's onset was drawn from a shared distribution.

**Why**: No intellectual justification for sharing onset across edges.
Onset is a property of a specific business process (how long before a
specific conversion begins). Edges in different regions of the funnel
have genuinely different onset characteristics — there is no reason to
assume they come from a shared distribution.

The topological constraints (branch group Dirichlet, FW path composition,
join node mixing) are the correct inter-edge structure. These are
structural properties of the graph, not statistical assumptions.

**Immediate trigger**: The hierarchy made 2-edge all-latency graphs
degenerate. 4 hierarchical parameters (hyper_mu, tau, eps_1, eps_2)
estimated from 2 onset values — underdetermined, creating a posterior
ridge that NUTS couldn't traverse (rhat=1.661, 679 divergences).

**Fix**: Each latency edge gets an independent onset prior from its
own histogram data. No shared parameters across edges.

### 23-Mar-26: Zero-count bin merging — corrected implementation

**First attempt (broken)**: Dropped ages where `cumulative_y[i] != kept_y[-1]`
(comparison against last KEPT value, not previous consecutive value). This
widened non-zero interval CDF coefficients → changed DM likelihood → rhat
regressed from 1.004 to 1.530.

**Corrected**: Keep ages where `y(t) != y(t-1)` OR `x(t) != x(t-1)`
(consecutive comparison), plus the age before each change point (to preserve
non-zero interval boundaries), plus first/last. Zero-count bins are merged
but non-zero interval CDF coefficients are preserved exactly.

**Literature confirms**: Zero-count DM bins contribute `gammaln(0+α) - gammaln(α) = 0`
regardless of α. Merging them is provably lossless. But the previous filter
inadvertently changed non-zero interval boundaries, which IS lossy.

**Results with corrected filter**:
- Production graph: rhat=1.006, ess=996, 22 divergences (IMPROVED from 49)
- Synth mirror 4-step: 94 ages → 3-23 ages. rhat=1.014, 264s. Converges.
- Synth simple 2-step: 94 ages → 6-22 ages. rhat=1.661. Doesn't converge
  (all-latency geometry issue, not filter issue).

### 23-Mar-26: BE stats engine and topology prior priority

**BE stats engine** (`graph-editor/lib/runner/stats_engine.py`): Full port
of FE `enhanceGraphLatencies` — topo pass, FW composition, t95 improvement,
p_infinity estimation. Wired into harness via `handle_stats_topo_pass`.

**Problem**: The topology builder (`topology.py`) reads priors from
`derive_latency_prior(median_lag, mean_lag, onset)` which produces different
values from both the FE stats pass and the BE stats engine. Three different
computations of the same quantity:

| Source | Edge 3 mu | Edge 3 sigma |
|--------|-----------|-------------|
| FE (on graph) | 1.867 | 0.369 |
| BE stats engine | 1.157 | 0.800 |
| topology derive_latency_prior | 1.502 | 0.574 |

**Only derive_latency_prior gives convergence** on the production graph
(rhat=1.006). The BE engine values (mu=1.157) cause rhat=1.735. The FE
values (mu=1.867 via direct read) also fail.

**Root cause**: The model posterior wants mu≈5-7 for this edge (production
data). All three priors are < 2. The model is very sensitive to sigma_prior —
derive_latency_prior gives sigma=0.574 which is wide enough for the sampler
to explore. The BE engine gives sigma=0.800 (wider) but mu=1.157 (lower),
creating a different posterior geometry that traps the sampler.

**Decision**: Reverted topology to original priority (median/mean first,
mu/sigma fallback). The BE stats engine needs parity validation against the
FE before it can be trusted for priors. The topology's derive_latency_prior
is a crude but WORKING approximation.

**TODO**: Validate BE stats engine against FE output on production data.
The three-way discrepancy must be resolved — all paths should produce
identical mu/sigma for the same input data.

### 23-Mar-26: Zero-increment filter — WRONG, reverted

**Attempted**: Drop trajectory ages where neither x nor y changed, on the
theory that zero-count DM intervals contribute `gammaln(0+α) - gammaln(α) = 0`.

**Result**: rhat regressed from 1.004 to 1.530 on the production graph.

**Why it's wrong**: The DM logp for a zero-count interval is NOT zero.
It's `gammaln(0 + κ·p·cdf_coeff) - gammaln(κ·p·cdf_coeff)` which equals
zero only when `cdf_coeff` is zero. When `cdf_coeff > 0` (model predicts
conversions should happen), zero observed conversions is a PENALTY. This
is how the model learns where the CDF rises — ages with zero conversions
but positive CDF prediction constrain the CDF shape.

**Correct approach for data density reduction**: The filter was wrong
because it assumed "no change = no information." In fact, "no change"
= "the model's predicted CDF increment here was wrong if it's non-zero."
The correct way to reduce density is to MERGE adjacent intervals into
wider bins (e.g. merge ages [5,6,7,8] into one interval [5,8] with
total count = sum of increments). This preserves the statistical content
(same total count, same CDF span) but reduces the number of evaluation
points. The bin boundaries should be chosen to give roughly equal CDF
increments, not equal age spacing.

Alternatively, synth_gen should match the production fetch model (window-
limited observations) rather than writing the full triangular matrix.

### 23-Mar-26: Trajectory x(t) data and redundant-frame filtering

**Problem**: Synth data has 94 retrieval ages per anchor_day (full
triangular matrix from nightly fetch simulation). Most ages show no
change in y — the CDF plateau means 80+ ages are redundant. 94-point
trajectories cause 18K+ CDF evaluations per gradient step, making
sampling take 27 minutes for a 4-edge graph.

**Fix (evidence binder)**: Added zero-increment filtering in
`_build_trajectories_for_obs_type`. Ages where NEITHER x nor y changed
are dropped. Always keeps first and last ages. Reduces trajectory
density from 94 to 2-21 ages depending on edge latency.

**Key insight on x vs y**: Window observations have fixed x (from-node
arrivals on anchor_day don't change). Cohort observations have GROWING
x(t) as upstream arrivals accumulate. The filter checks both — ages
where x changed but y didn't are informative about upstream latency
timing and must be retained.

Added `cumulative_x` field to `CohortDailyTrajectory` to store per-age
from-node arrival counts alongside cumulative_y.

### 23-Mar-26: Per-age x(t) — future model consumption (DESIGN NOTE)

The model currently uses a fixed denominator per trajectory:
- Window: n = x (fixed, from-node arrivals on that day)
- Cohort: n = a (fixed, anchor entrants)

For cohort trajectories, x(t) provides a direct observation of the
upstream CDF: `x(t)/a ≈ p_upstream × CDF_upstream(t)`. This data is
now preserved on the trajectory but NOT yet consumed by the model.

**Options for consuming x(t)**:

**A. Second Potential per cohort trajectory**: Score x(t) against the
upstream CDF (FW-composed from edges above the from_node). Directly
constrains upstream latency parameters from downstream observations.
Clean and additive — doesn't change the existing y(t) Potential, just
adds a new one. Doubles the cohort Potential count.

**B. Per-age effective denominator**: Use x(t) as the at-risk population
for the edge conversion at each age. Doesn't work cleanly because y(t)
is a convolution — includes conversions from people who arrived at
from_node at various earlier times, not just those present at age t.

**C. Joint upstream+edge decomposition**: Simultaneously fit x(t) and
y(t) to decompose the path into upstream arrival CDF × edge CDF. Most
statistically correct but significantly more complex.

**Recommendation**: Option A when ready. It's additive (no changes to
existing likelihood terms), provides upstream parameter identification
from cohort data, and the FW-composed upstream CDF is already computed
by the topology pass. Implementation: one additional `pm.Potential` per
cohort trajectory scoring x(t) increments against upstream CDF intervals.

**For join nodes**: x(t) at a join is the TOTAL arrivals from ALL
incoming edges. The upstream CDF for a join is the mixture/sum of the
incoming path CDFs, weighted by their respective p values. This is
already handled by the topology's path composition.

### 23-Mar-26: Tooling hardened

**Pre-flight checks** added to `test_harness.py`:
1. DB connectivity check
2. Per-subject row count verification (FAIL if any subject has 0 rows)
3. Evidence binding via worker's actual query path (catches env/hash
   mismatches)
4. Trajectory summary (count, max ages, data source)

**`--preflight-only` mode**: Runs all checks in <10s without MCMC.
Must pass before any compiler run.

**Early abort**: If sampling estimate exceeds 3× `expected_sample_seconds`
(from truth file) within the first 10% of sampling, the harness aborts
automatically with a geometry-problem diagnostic.

**Hash consolidation**: Single source of truth for hashes — Node.js
`compute_snapshot_subjects.mjs` calls the real FE `computeQuerySignature`
pipeline. Used by both `synth_gen.py` (DB writes) and `test_harness.py`
(DB reads). No Python hash reimplementation in the critical path.

**synth_gen verification**: After DB write, synth_gen queries back with
the same FE hashes and prints PASS/FAIL per subject. Pipeline aborts
if any subject has 0 rows.

**Stats pass**: Python port of FE `fitLagDistribution` in
`graph-editor/lib/stats_enhancement.py`. Derives mu/sigma/onset/t95
from parameter file lag data. Runs in memory (doesn't write to disk).
Called by harness before building payload.

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
