# Doc 41 — Contexted Latency Recovery Bias

**Date**: 15-Apr-26
**Status**: Per-slice `a` + shared sigma reduces onset misses by 50%. Residual small-onset bias under investigation.
**Depends on**: Doc 34 §11.8–11.9 (reparameterisation), §11.11 (centred slices)

---

## 1. Summary

The Bayesian compiler's "winning formula" configuration
(`latency_reparam=true`, `centred_latency_slices=true`,
`centred_p_slices=true`) produces excellent convergence on all
contexted synth graphs — no stalls, rhat < 1.02, 100% chain
convergence. However, the posteriors show a systematic bias in
latency parameter recovery: **onset is biased high and mu is
biased low across all contexted graphs**. The bias is present
on every context slice, every context dimension, and every graph
topology tested. It is NOT present on uncontexted graphs.

The model converges confidently to the wrong answer. This is a
likelihood geometry issue: shared `a` + free `sigma` creates a
ridge where (higher onset, lower mu, inflated sigma) scores
better than truth when `a` must compromise across slices with
heterogeneous true `log(onset) - mu` values. See §3.3–3.5.

---

## 2. Evidence

Full regression run `r1776210023` (15-Apr-26, 2000 tune / 2000
draws / 3 chains, winning formula defaults, 25 graphs).

### 2.1 Uncontexted graphs: all recover well

| Graph | Time | rhat | ESS | Recovery |
|-------|------|------|-----|----------|
| lattice-test | 184s | 1.004 | 1687 | Clean |
| 3way-join-test | 374s | 1.004 | 4272 | Clean |
| diamond-test | 463s | 1.003 | 5328 | Clean |
| join-branch-test | 248s | 1.002 | 1938 | Clean |
| skip-test | 152s | 1.003 | 3042 | Clean |
| fanout-test | 121s | 1.002 | 2598 | Clean |
| mirror-4step | 92s | 1.002 | 5154 | Clean |
| forecast-test | 356s | 1.004 | 1146 | Clean |
| simple-abc | 163s | 1.003 | 7660 | Clean |
| drift10d10d | 146s | 1.001 | 7343 | Clean |
| drift3d10d | 123s | 1.002 | 6841 | Clean |

No mu bias, no onset bias, no systematic issues. The (m, a, r)
reparameterisation works correctly for uncontexted edges.

### 2.2 Contexted graphs: systematic onset-high / mu-low bias

Every contexted graph shows the same pattern. Representative
examples (edge-level, not per-slice):

**context-solo** (simplest: 1 edge, 3 context slices):
- mu: truth=1.500, post=1.154±0.055, z=6.29 — biased LOW by 0.35
- Per-slice onset biased HIGH by 0.37–0.90 across slices

**simple-abc-context** (linear: 2 edges, 3 slices):
- mu: truth=2.300, post=1.989±0.067, z=4.64 — biased LOW by 0.31
- Per-slice onset biased HIGH by 0.34–1.29

**skip-context** (skip edge, no join):
- mu: truth=1.200, post=0.866±0.109, z=3.06 — biased LOW by 0.33
- mu: truth=1.000, post=0.694±0.058, z=5.28 — biased LOW by 0.31
- Per-slice onset biased HIGH by 0.33–0.60

**diamond-context** (1 join, 2 paths, 6 edges):
- mu: truth=2.200, post=1.853±0.056, z=6.20 — biased LOW by 0.35
- Per-slice onset biased HIGH by 0.32–2.21 (worst on email slice)

**lattice-context** (2 joins, 9 edges):
- mu: truth=0.900, post=0.276±0.105, z=5.94 — biased LOW by 0.62
- mu: truth=1.000, post=0.352±0.128, z=5.06 — biased LOW by 0.65
- Per-slice onset biased HIGH by 0.35–1.02

**3way-join-context** (1 join, 3 inputs):
- mu: truth=1.000, post=0.312±0.078, z=8.82 — biased LOW by 0.69
- Per-slice onset biased HIGH by 0.36–1.15
- ESS=154 (lowest of all graphs)

**join-branch-context** (1 join + branch):
- mu: truth=1.300, post=0.981±0.045, z=7.09 — biased LOW by 0.32
- Per-slice onset biased HIGH by 0.32–0.98

**The only contexted graph that passes is mirror-4step-context**,
which has instant edges (onset=0, mu=0, sigma=0) — these bypass
latency modelling entirely.

### 2.3 Severity scales with topology

The mu bias is present in ALL contexted graphs (including the
simplest: context-solo, 1 edge) but is substantially worse on
graphs with join nodes:

| Topology | Typical mu Δ | Max mu z |
|----------|-------------|----------|
| Solo / linear (no join) | 0.30–0.35 | 6.3 |
| Skip edge (no join) | 0.30–0.31 | 5.3 |
| Diamond (1 join) | 0.35 | 6.2 |
| Join-branch (1 join) | 0.32–0.46 | 7.1 |
| 3-way join | 0.43–0.69 | 8.8 |
| Lattice (2 joins) | 0.53–0.65 | 5.9 |

### 2.4 Email slice shows broadest failures

The email context slice (weakest data — lowest traffic multiplier)
consistently shows the most failures: p misses, sigma misses, and
the largest onset biases. This is the expected behaviour for
centred parameterisation — it is optimal for strong data but can
over-constrain weak slices. Examples:

- diamond email path-b-to-join: onset truth=2.300, post=4.510
  (bias of 2.21 — nearly double the truth)
- 3way-join email c-to-join: onset truth=1.300, post=2.450
  (bias of 1.15)
- simple-abc email b-to-c: onset truth=2.300, post=3.590
  (bias of 1.29)

### 2.5 p and sigma recovery is generally good

Probability recovery is largely unaffected by the bias — p
posteriors match truth well across most edges and slices, with
occasional email-slice misses. Sigma is mostly fine, with a few
email-slice inflations. The problem is specifically in the
onset/mu decomposition of the latency distribution.

---

## 3. Diagnosis

### 3.1 The bias is compensatory

Onset biased HIGH and mu biased LOW are compensatory. The shifted
lognormal CDF is `F(t) = Φ((log(t - onset) - mu) / sigma)`. If
onset increases by δ, the distribution shifts right by δ days. To
maintain approximately the same CDF shape, mu must decrease — the
log-median `exp(mu)` pulls closer to onset. The model is finding a
different (onset, mu) decomposition of approximately the same
observed CDF, but one that doesn't match the ground truth.

Sigma inflation is not secondary — it is a key part of the
mechanism. The model inflates sigma to compensate for the raised
onset, recovering early/late mass in the CDF. See §3.3–3.4.

### 3.2 The (m, a, r) reparameterisation and shared a

The winning formula uses (m, a, r) coordinates (doc 34 §11.8):
- m = log(t50) — log of the median conversion time
- a = logit(onset / t50) — logit of the onset fraction
- r = inverse_softplus(Z_95 × sigma) — transformed spread

For per-slice latency variation (doc 34 §11.9), the model uses:
- Per-slice m offsets (m_slice = m_base + δm_slice)
- Per-slice r offsets (r_slice = r_base + δr_slice)
- **Shared a** across all slices

The shared-a decision was made because per-slice a offsets were
poorly identified (§11.9.1.2) — the logit onset fraction is not
well constrained per-slice when onset is small relative to t50.

### 3.3 Root cause: shared-a + free-sigma likelihood degeneracy

**Confirmed** (15-Apr-26, via stripped optimisation on
synth-context-solo using real window trajectories, p fixed to
truth, onset anchor / t95 / endpoint BB all removed).

The back-transforms in `model.py` (lines 1519–1530) are:

    onset_slice = exp(m_slice) × sigmoid(a)
    mu_slice    = m_slice - softplus(a)
    sigma_slice = softplus(r_slice) / Z_95

The critical invariant: with shared a,
`log(onset_slice) - mu_slice` is **constant** across all slices
(equal to `a`). Any per-slice variation in m shifts onset and mu
by exactly the same amount in log-space. The model cannot vary
the onset/mu ratio per slice.

**The bias is created by the interaction of shared `a` with free
`sigma`.** It is not primarily driven by the onset anchor, t95
anchor, or any other auxiliary constraint — the bias persists
when all anchors are removed. It is a property of the likelihood
surface itself.

Quantitative evidence (context-solo, 1 edge, 3 slices):

| Configuration | Optimal shared a | Δ from truth (-1.533) |
|---------------|------------------|-----------------------|
| Per-slice m only, sigma fixed at truth | -1.622 | -0.089 (below) |
| Per-slice m + shared free sigma | -1.094 | +0.440 (above) |
| Per-slice m + per-slice r (free sigma) | -1.082 | +0.451 (above) |

The sign flips from below-truth to above-truth as soon as sigma
is free. Per-slice r barely changes the result. The root problem
is shared a combined with any free sigma.

### 3.4 Mechanism: the (a, sigma) ridge

Trajectories primarily pin t50 = exp(m). At roughly fixed m,
increasing a does two things mechanically:

- Raises onset = exp(m) × sigmoid(a)
- Lowers mu = m - softplus(a)

If sigma is free, the model can inflate sigma to recover the
early/late mass lost by delaying onset. This creates a
better-scoring ridge: later onset + fatter sigma + slightly
lower mu, while leaving t50 mostly intact.

The fitted values from the stripped optimisation confirm this
pattern exactly:

| Slice | onset truth→fit | mu truth→fit | sigma truth→fit |
|-------|-----------------|--------------|-----------------|
| google | 0.70 → 1.01 | 1.20 → 1.10 | 0.50 → 0.58 |
| direct | 1.00 → 1.40 | 1.50 → 1.43 | 0.50 → 0.58 |
| email | 1.50 → 2.15 | 1.90 → 1.86 | 0.50 → 0.58 |

Onset uniformly high, mu uniformly low, sigma inflated. This
mirrors the full MCMC posterior pattern from regression run
r1776210023.

### 3.5 Why uncontexted graphs are clean

In uncontexted mode, the correct a is exactly reachable — there
is only one set of (onset, mu) to fit, so no cross-slice
compromise is needed. The trajectory data pins (m, a, r) at the
correct values. The (a, sigma) ridge exists but does not score
better than the truth because the truth is the exact optimum.

In contexted mode, the shared a must compromise across slices
whose true `log(onset) - mu` values differ:

| Slice | log(onset_truth) - mu_truth |
|-------|-----------------------------|
| google | log(0.7) - 1.2 = -1.557 |
| direct | log(1.0) - 1.5 = -1.500 |
| email | log(1.5) - 1.9 = -1.495 |

The model enforces `log(onset) - mu = a` for all slices. No
single a exactly recovers the truth for every slice. When sigma
is free, the (higher a, higher sigma) compromise scores better
than the "correct" a because inflating sigma absorbs the per-
slice onset mismatch more effectively.

### 3.6 Why the bias is worse at joins and weak slices

Join-node edges have additional constraints from path
composition (mu_path_prior, Dirichlet branch probabilities).
These add rigidity to the posterior geometry, amplifying the
a-sigma ridge effect. Weak slices (e.g. email with low traffic)
have less data to resist the ridge, so the bias is largest there.

### 3.7 Confounds in the edge-level recovery table

The edge-level recovery comparison (in `test_harness.py`)
compares the edge posterior directly against the truth-file base
mu/onset. For exhaustive-slice contexted edges, the edge-level
posterior is a hierarchy centre (doc 14 §Phase C), not a direct
aggregate likelihood term. The weighted slice means are typically
only 0.04–0.14 below the base mu (checked against synth truth
configs), so this confound does not explain the full 0.30–0.69
misses — but it does mean the **per-slice failures are the
cleaner evidence** for the bias.

### 3.7 Synth data generation defects

Exhaustive trace of `synth_gen.py` (15-Apr-26) identified the
following defects in how contexted synth data is generated. The
person-level simulation is correct (per-slice p, mu, sigma, onset
are applied properly, and y-counts reflect genuine per-slice
timing). The defects are in the metadata and parameter file
generation.

**Bug D1 — onset_obs_by_slice edge key matching failure**:
`synth_gen.py` lines 1557–1561 attempted to match UUID `edge_id`
against truth-file short names (e.g. `"anchor-to-target"`). The
comparison never matched because `edge_id` is a UUID. Result:
`onset_offset` was always 0.0. **Fixed** (15-Apr-26): key
matching now resolves correctly.

**Bug D2 — Snapshot DB lag summaries not slice-aware**: context
snapshot rows reuse edge-level lag summaries (`median_lag_days`,
`mean_lag_days`, `anchor_median_lag_days`, `anchor_mean_lag_days`)
from `edge_latency_stats` (lines 1299–1331), which computes from
base edge `onset`, `mu`, `sigma` only. Context rows carry
slice-aware y-counts but base-edge lag summaries.

**Bug D3 — Snapshot DB onset_delta_days not per-slice**: due to
bug D1, `onset_delta_days` on context rows uses the base edge
onset (with noise), not `base_onset + onset_offset`. The y-counts
correctly reflect per-slice timing but the onset metadata does not.

**Bug D4 — Param-file context entries are aggregate clones**:
parameter-file context `values[]` entries (lines 2306–2356) reuse
aggregate `n_daily`, `k_daily`, `mean`, `n`, `k`, `median_lag_days`,
`mean_lag_days`, `anchor_*`, and base `onset` for every context-
qualified entry. No per-slice computation is performed. Only
`sliceDSL` differs between entries.

**Bug D5 — Graph inline latency is base-only**: the graph metadata
writer (lines 2579–2587) writes only the base truth latency block
to the graph edge. This is base-only by design (graph-level latency
is not per-slice), but means the graph carries no per-slice latency
truth for diagnostic comparison.

**Bug D6 — edge_daily aggregates are context-blind**: `edge_daily`
(lines 952–1023) computes `n_daily`, `k_daily`, `median_lag_daily`,
`mean_lag_daily` from all people regardless of context. No
per-context version exists. These aggregate values feed into both
aggregate and context parameter file entries (bug D4).

### 3.8 Assessment of defects vs the onset-HIGH / mu-LOW bias

None of the identified defects (D1–D6) plausibly explain the
systematic **upward** onset bias:

- D1/D3: onset_delta_days defaults to the base edge onset. The
  onset anchor in `model.py` (line 900) is therefore correctly
  centred on the base onset truth value. No directional bias.
- D2/D4/D6: lag summaries and param-file entries are aggregate,
  not per-slice. These fields push context data toward the base/
  aggregate, which would pull onset toward the base value, not
  above it.
- D5: graph-level latency is informational only.

The person-level simulation is correct: per-slice conversion timing
uses the correct `(onset + onset_offset, mu + mu_offset, sigma)`.
The y-counts in context DB rows reflect genuine per-slice timing.
The onset anchor is unbiased (centred on truth).

### 3.9 Model structural differences (contexted vs uncontexted)

Exhaustive trace of `model.py` (15-Apr-26) identified 20
structural differences between contexted and uncontexted code
paths. Most are irrelevant to the bias (p hierarchy, kappa,
branch groups). The key differences:

1. Aggregate emission suppressed for exhaustive slices (line
   1669–1681) — no trajectory directly constrains `m_base`
2. Onset anchor and t95 anchor act on edge-level `(m_base, a)`
   while per-slice trajectories act on `(m_slice, a)`
3. Per-slice hierarchy introduces `tau_m`, `tau_r` with
   HalfNormal priors connecting m_slice to m_base
4. Per-slice onset/mu/sigma Deterministics derived from
   `(m_slice, a, r_slice)` replace edge-level versions in
   all emissions

However, the stripped optimisation (§3.3) showed the bias
persists even with all anchors removed. The structural
differences in how anchors interact with edge-level vs per-slice
variables are secondary. The primary cause is the likelihood
geometry degeneracy described in §3.3–3.4.

---

## 4. Agreed solution: per-slice `a` with constrained sigma

### 4.1 Approach

Based on root cause analysis (§3.3–3.5) and external review,
the agreed fix is per-slice `a` offsets with shared or tightly
regularised sigma. This addresses both failure modes:

- **Cross-slice compromise** (§3.3): per-slice `a` lets each
  slice find its own `log(onset) - mu` ratio. No compromise.
- **Within-slice (a, sigma) ridge** (§3.4): constraining sigma
  prevents it from inflating to accommodate onset errors.

The approach is staged:
1. First experiment: `per_slice_a=True` with
   `latency_reparam_slices=1` (per-slice m + a, shared sigma)
2. If clean: test with `latency_reparam_slices=2` (add per-slice
   r) to assess whether within-slice ridge reappears
3. Only adopt per-slice r if step 2 is clean

### 4.2 Design decisions

**Zero-sum constraint on `delta_a`**: use
`a_slice = a_base + delta_a` where `delta_a` is zero-sum
(or explicitly mean-centred). This keeps `a_base` interpretable
as the true edge-level onset fraction, not just a floating
hierarchy centre. Standard practice for group-mean + deviations.

**`tau_a` prior**: `HalfNormal(sigma=1.0)` — weakly informative
on the logit scale (Gelman 2006). The data determines the
actual pooling strength. No arbitrary fudge numbers — the
hierarchy learns the appropriate scale of cross-slice `a`
variation from the evidence.

**Feature flag**: boolean `per_slice_a` (default `False`),
orthogonal to `latency_reparam_slices`. The first experiment
runs `per_slice_a=True, latency_reparam_slices=1`.

**Onset anchor binding**: fix `evidence.py` (lines 785–803) to
intentionally select aggregate-only rows for the edge-level
onset observations, so `a_base` is anchored by aggregate data
rather than a row-order-dependent mix.

**Diagnostics**: add per-slice ESS, Rhat, and `corr(a_slice,
sigma)` to the reparam diagnostics in `inference.py`. Without
these, we cannot distinguish "bias fixed" from "bias hidden in
weak slices".

### 4.3 Why this should work

Uncontexted graphs (which are equivalent to one slice with its
own `a`) recover cleanly — the within-slice (a, sigma) ridge
exists but does not cause bias when the correct answer is
exactly reachable. Per-slice `a` makes each slice's correct
answer exactly reachable. The hierarchy provides pooling for
weak slices (email).

### 4.4 Risk: weak-slice identification

Email slices (10% traffic) have less data to identify `a_slice`.
With free sigma, the within-slice ridge could cause per-slice
bias even though the cross-slice compromise is removed. This is
why step 1 uses shared sigma — it constrains the ridge while we
verify per-slice `a` works. The hierarchy's pooling toward
`a_base` also helps: poorly-identified slices shrink toward the
edge-level value rather than wandering.

### 4.5 Verification plan

In order:
1. context-solo with `per_slice_a=True`, shared sigma — confirm
   onset bias eliminated, check `a_base` identification
2. Check email slice ESS / Rhat / `corr(a_slice, sigma)` —
   confirm adequate identification despite weak data
3. diamond-context, lattice-context — confirm bias eliminated
   on harder topologies with joins
4. Re-run full contexted regression — confirm no regressions
5. Only then consider `latency_reparam_slices=2` (per-slice r)

---

## 5. Experimental results (15-Apr-26)

### 5.1 Four-way comparison design

Two orthogonal feature flags tested in a 2×2 factorial:

| Config | `per_slice_a` | `shared_sigma_slices` | Description |
|--------|--------------|----------------------|-------------|
| A | False | False | Baseline (current default) |
| B | False | True | Shared sigma only |
| C | True | False | Per-slice a + per-slice r |
| D | True | True | Per-slice a + shared sigma |

All configs use `latency_reparam=true`, `centred_latency_slices=true`,
`centred_p_slices=true`, `latency_reparam_slices=2`, 2000 tune /
2000 draws / 3 chains. Per-slice `a` uses zero-sum (mean-centred)
deltas with `tau_a ~ HalfNormal(sigma=1.0)`.

### 5.2 Results: synth-context-solo (1 edge, 3 slices)

| Config | Onset misses | Sigma misses | Total | ESS | rhat |
|--------|-------------|-------------|-------|-----|------|
| A (baseline) | 3/3 | 1 | 4 | 4325 | 1.002 |
| B (shared σ) | 3/3 | 0 | 3 | 7557 | 1.002 |
| C (a, free σ) | 3/3 | 1 | 4 | 87 | 1.034 |
| D (a + shared σ) | 2/3 | 0 | 2 | 5720 | 1.003 |

Config C has very poor convergence (ESS=87, rhat=1.034) —
the within-slice (a, sigma) ridge is active when per-slice r
is free. This confirms the external review's warning.

Config D is the best: email onset passes (z=0.47 vs baseline
z=7.15), sigma clean. But google (z=8.50) and direct (z=4.29)
onset still biased high.

### 5.3 Results: synth-diamond-context (6 edges, 1 join, 3 slices)

| Config | Onset misses | Sigma misses | Total | Time | ESS |
|--------|-------------|-------------|-------|------|-----|
| A (baseline) | 12/18 | 2 | 16 | 1261s | 1315 |
| B (shared σ) | 12/18 | 0 | 13 | 1140s | 5780 |
| C (a, free σ) | 6/18 | 1 | 9 | 2332s | 438 |
| D (a + shared σ) | 6/18 | 0 | 8 | 996s | 360 |

Key observations:

**A→B (shared σ effect):** eliminates sigma inflation (2→0
sigma misses) but onset misses unchanged (12→12). Constraining
sigma alone does not fix onset. This is consistent: the onset
bias arises from the cross-slice `a` compromise (§3.3), not
from sigma inflation.

**A→C (per-slice a effect):** onset misses halved (12→6). This
is the primary improvement — removing the cross-slice
compromise lets each slice find its own onset/mu ratio. But
convergence is poor (ESS 438, 2332s) due to the within-slice
(a, sigma) ridge.

**A→D (combined effect):** onset misses halved (12→6), sigma
misses eliminated (2→0), fastest run (996s). The combination
of per-slice `a` + shared sigma addresses both the cross-slice
compromise and the within-slice ridge.

**C→D (ridge suppression):** minimal difference (9→8 total).
On diamond-context, the ridge effect is small compared to the
per-slice `a` effect.

### 5.4 Residual onset bias pattern

The 6 remaining onset misses in configs C and D follow a
consistent pattern: edges with small true onset (0.8–1.0 days)
overshoot by 0.2–0.4 days. Edges with larger true onset
(2.0–3.0 days) recover well.

Per-edge detail (config D, diamond-context):

| Edge | onset truth | onset post | z | |
|------|-----------|-----------|---|----|
| anchor-to-a | 0.8 | 1.01 | 5.25 | MISS |
| a-to-join | 1.8 | 2.14 | 3.78 | MISS |
| anchor-to-b | 2.7 | 2.76 | 0.67 | OK |
| b-to-join | 0.8 | 1.09 | 2.90 | OK |
| join-to-c (path a) | 1.8 | 2.37 | 6.33 | MISS |
| join-to-c (path b) | 0.8 | 1.14 | 4.86 | MISS |
| c-to-d | 1.0 | 1.22 | 3.67 | MISS |
| d-to-target (path a) | 2.0 | 2.19 | 1.46 | OK |
| d-to-target (path b) | 3.0 | 3.03 | 0.20 | OK |

The residual bias is **not explained by the shared-a
degeneracy** (per-slice `a` is active). It is consistent
across configs C and D and appears to be a separate effect —
possibly the onset anchor (edge-level `onset_obs` likelihood)
or the softplus onset boundary creating an asymmetric pull on
small-onset edges. Investigation ongoing.

### 5.5 Assessment

Per-slice `a` with shared sigma (config D) is a substantial
improvement:
- 50% reduction in onset misses (12→6 on diamond)
- Sigma inflation eliminated
- Mu recovery clean throughout
- 20% faster than baseline

But it is not a complete fix. A residual onset-high bias
persists on small-onset edges. This residual is independent of
the shared-a / free-sigma degeneracy identified in §3.3–3.4
and requires separate investigation.

### 5.6 Stall detector gap found and fixed

During the diamond-context runs, config A stalled on chain 0
(368 draws after 800+ seconds, while chains 1–2 completed at
4000). The stall detector did not fire because chain 0 never
reached `min_peak=10` draws/s — it was slow from the start.

**Fix:** added `check_laggard()` to `ChainStallDetector` — a
cross-chain comparison that detects chains dramatically behind
their siblings even when they never established a peak rate.
Condition: draws below 10% of sibling median AND rate below
`crawl_floor` AND sustained for `grace_s`. 4 new tests added
(19/19 pass).

---

## 6. Excluded from this analysis

**Data binding failures**: diamond-context-sparse, skip-context-sparse,
fanout-context-mixed, and context-staggered show missing slice data
or 0 kappa_lat variables. These are caused by missing `pinnedDSL` in
the graph JSON (anti-pattern 39, fixed in `graph_from_truth.py`).
Their recovery failures are data pipeline issues, not model issues.
They need regeneration with `--write-files` before their recovery
quality can be assessed.

**"Missing parsed recovery param"**: several graphs report "missing
parsed recovery param(s): onset" or "mu, sigma" for specific edges
or slices. This is a parsing issue in `param_recovery.py` — the
posterior was computed but the output format wasn't matched by the
parser. Not a model issue. Needs a separate fix to the parser.
