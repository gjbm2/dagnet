# Doc 20 — Trajectory Data Compression for NUTS Sampling

**Status**: Resolved (24-Mar-26) — smooth clip floors fix the defect
**Date**: 24-Mar-26
**Purpose**: Detailed briefing on the CDF trajectory compression problem.
Summarises the model machinery, what broke, why, the fix, and lessons
learned. Retains candidate solutions and external reviews for reference.

---

## 1. What the model does

### 1.1 The data

The Bayes compiler fits conversion probability and latency jointly from
**snapshot trajectory data**. Each trajectory represents one cohort day
(anchor_day) observed at multiple retrieval ages:

```
anchor_day = 2026-01-15
ages:  [1,  2,  3,  5,  7,  10, 14, 20, 30, 45, 60]
cum_y: [0,  0,  0,  0,  2,   8, 15, 22, 27, 29, 30]
n:     310  (total at risk)
```

The trajectory is a discretely-observed CDF: `cum_y(t) / n` approximates
`p × F(t)` where `p` is the conversion probability and `F(t)` is the
shifted lognormal latency CDF.

### 1.2 The likelihood

Each trajectory is modelled as a **Dirichlet-Multinomial** (DM) over
time intervals. The intervals are defined by consecutive retrieval ages:

```
interval [t_{j-1}, t_j]:
  count_j = cum_y[j] - cum_y[j-1]     (conversions in this interval)
  α_j = κ · p · (F(t_j) - F(t_{j-1})) (expected proportion × concentration)

remainder:
  count_R = n - cum_y[final]           (never converted by horizon)
  α_R = κ · (1 - p · F(t_final))
```

The DM logp per trajectory:

```
ℓ = Σ_j [gammaln(count_j + α_j) - gammaln(α_j)]
  + gammaln(count_R + α_R) - gammaln(α_R)
  + gammaln(κ) - gammaln(n + κ)
```

Where `κ` is per-edge overdispersion (learned). `p` and the latency
parameters `(onset, μ, σ)` are latent — the CDF `F(t)` is a PyTensor
expression of these, so gradients flow through to all parameters.

### 1.3 The redundancy problem

Production data typically has 25-35 retrieval ages per trajectory (one
per nightly fetch). Synthetic data can have 90+ ages (full triangular
matrix). Many consecutive ages show no new conversions — the CDF
plateaus between conversion events.

A typical trajectory for a latency edge:

```
age:    [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, ...]
cum_y:  [0, 0, 0, 0, 0, 0, 0, 0, 1, 13, 16, 16, 25, 27, ...]
                                  ↑         ↑
                            onset region    zero-count gap
```

Ages 1-8: zero conversions (onset period). Ages 11-12: zero increment
(gap between conversion events). Each zero-count age generates a CDF
evaluation (`erfc` call) and a `gammaln` pair in the PyTensor graph,
but contributes zero to the logp.

For a graph with 8 edges × 100 trajectories × 30 ages, the model has
24,000 CDF evaluations and 24,000 gammaln pairs. Reducing to only the
~10 informative ages per trajectory would cut this to 8,000.

### 1.4 Why compression matters

- **PyTensor compilation time** scales with symbolic graph size.
  The diamond graph (6 edges, ~60 ages/traj) takes 117s to compile.
  Linear graphs with ~30 ages compile in 3-5s.
- **Sampling time** scales with gradient evaluation cost per step.
  More CDF evaluations = slower steps.
- **Memory** scales with the flattened interval arrays.
- Larger production graphs (10+ edges) will be infeasible without
  compression.

---

## 2. What we tried

### 2.1 Zero-count bin dropping

**Implementation** (in `compiler/evidence.py`): After building a
trajectory from snapshot rows, scan consecutive ages. Keep an age if:
- It's the first or last age
- `cum_y` changed from the previous age (non-zero conversion increment)
- `cum_x` changed (upstream arrivals changed — cohort mode)
- It's the age immediately before a change point (preserves the left
  boundary of the next non-zero interval)

This preserves all non-zero interval CDF coefficients exactly.

### 2.2 Mathematical analysis

For a zero-count interval (count = 0):

```
gammaln(0 + α) - gammaln(α) = gammaln(α) - gammaln(α) = 0
```

This is true for any α > 0. The term contributes exactly zero to logp.

The gradient is also zero:

```
d/dμ [gammaln(α) - gammaln(α)] = 0
```

The CDF coefficients of kept (non-zero) intervals are preserved exactly
by the predecessor-keeping rule. The remainder alpha `κ·(1 - p·F(H))`
is unchanged because the last age is preserved. The CDF coefficients
telescope: `Σ(kept cdf_coeffs) = F(t_final)` regardless of which
intermediate ages are dropped. Total `Σα = κ` is preserved.

**Conclusion**: The filter is provably likelihood-lossless. The logp,
gradient, and DM internal consistency are mathematically identical with
and without the filter.

### 2.3 Empirical result

**Breaks NUTS on production data.** Reproducible:
- With filter: rhat=1.53, ess=7, every run
- Without filter: rhat=1.002, ess=2700, every run
- Same code, same data, same random seed behaviour
- Confirmed with `--asat` (historical data replay)
- Synth 4-step regression test PASSES with filter — issue is specific
  to production data with marginal posterior geometry

The problematic edge (7bb83fbf, delegated-to-registered) has a strong
onset-μ correlation (corr ≈ 0.85-0.90) and a posterior that sits far
from the prior (posterior μ ≈ 5.4, prior μ ≈ 1.6). The filter pushes
this edge into a bimodal regime where chains disagree.

---

## 3. Why likelihood-lossless ≠ NUTS-lossless

### 3.1 The mechanism

NUTS (No U-Turn Sampler) adapts two quantities during warmup:
- **Step size** (ε): global, controls trajectory length
- **Mass matrix** (M): diagonal, one entry per parameter, controls
  per-parameter scaling

Both are adapted from the gradient landscape during warmup draws. The
mass matrix entries are estimated from the variance of the gradients.

When zero-count intervals are removed:
- The logp is unchanged (zero terms removed)
- The gradient is unchanged (zero terms removed)
- But the **number of CDF evaluation points** changes, which changes
  the PyTensor symbolic graph, which changes the compiled gradient
  function, which can change the floating-point trajectory of warmup
  draws

### 3.2 Gradient anchor points

Even though zero-count intervals contribute zero gradient in the DM
formulation, the CDF evaluations at those ages serve as **structural
anchor points** in the computational graph. PyTensor's autodiff
system builds a graph connecting parameters (μ, σ, onset) to the logp
through these CDF nodes. Fewer nodes = different graph topology =
different compilation path = different numerical behaviour during
warmup.

This is NOT a mathematical issue — it's a computational one. The
compiled gradient function produces the same values in exact
arithmetic, but different floating-point accumulation orders can
lead to different warmup trajectories, different mass matrix
estimates, and ultimately different sampling behaviour.

### 3.3 Why it's deterministic, not stochastic

The same filter → same dropped ages → same PyTensor graph → same
compiled function → same warmup trajectory → same mass matrix →
same sampling behaviour. It's reproducible because the filter is
deterministic and the compilation is deterministic.

### 3.4 Literature

- Tran & Kleppe (2024): "Tuning diagonal scale matrices for HMC"
  — documents sensitivity of NUTS to mass matrix initialisation
- Stan HMC Algorithm Parameters reference — step size and mass
  matrix adaptation interact
- Hoffman & Gelman (2014): "The No-U-Turn Sampler" — NUTS adapts
  trajectory length based on gradient curvature

---

## 4. Candidate solutions

### 4.1 Poisson exposure penalty (Approach B)

**Idea**: Replace the identically-zero DM terms for zero-count
intervals with Poisson-like exposure terms that carry non-zero
gradient.

For a merged zero-event block spanning CDF range ΔF:

```
logp_zero_block = -κ · p · ΔF
```

This is the piecewise-exponential / counting-process formulation. In
survival analysis, a zero-event interval over exposure E with hazard λ
contributes `logp = -λ·E` to the likelihood. The analogous DM term:
the expected count `κ·p·ΔF` serves as the exposure penalty.

**Properties**:
- Non-zero logp and gradient (preserves anchor points)
- Mergeable: `-Σ(κpΔF_i) = -κp·Σ(ΔF_i)` (lossless compression)
- Consistent: approaches 0 as ΔF→0
- Provides "nothing happened here" signal proportional to how much
  the model EXPECTED to happen

**Concerns**:
- Mixes DM and Poisson in the same likelihood — is this principled?
- The DM already accounts for zero-count intervals through κ and the
  remainder. Adding a Poisson penalty changes the posterior.
- Needs validation that it doesn't bias parameter recovery.

**Literature**: Rodríguez (GLM notes §7.4), piecewise-exponential
models for grouped survival data.

### 4.2 Grouped mixture-cure likelihood

**Idea**: Reformulate the entire trajectory likelihood as a grouped
survival model instead of a DM.

```
ℓ = Σ_{j: y>0} y_j · [log(p) + log(F(t_j) - F(t_{j-1}))]
  + (N - Σy) · log(1 - p · F(H))
```

Zero-count bins don't appear at all. This is the standard incidence +
latency separation from the survival literature.

**Properties**:
- Clean formulation — no zero-count bins to worry about
- Naturally compressed — only non-zero event bins + censoring remainder
- Well-established in survival / mixture-cure literature
- Overdispersion would need separate handling (not built into the
  base multinomial)

**Concerns**:
- This is algebraically equivalent to the DM with zero-count terms
  removed. Same gradient landscape issue.
- Loses the per-edge κ overdispersion model (would need a different
  overdispersion mechanism)
- Major refactor of the model builder

**Literature**: Mixture cure models (OUP Academic), Stan User's Guide
§25.9 (sufficient statistics).

### 4.3 Fixed evaluation grid

**Idea**: Instead of data-dependent filtering, project all trajectories
onto a fixed grid of evaluation ages (e.g. [1, 2, 3, 5, 7, 10, 15,
20, 30, 50, 100]). Interpolate cum_y at grid points via step function.

**Properties**:
- Deterministic, data-independent — same grid for every trajectory
- Fixed PyTensor graph size
- CDF evaluated at same points for every trajectory

**Concerns**:
- Lossy — loses exact conversion timing within bins
- Grid choice affects resolution (too coarse = lost detail, too fine
  = no compression)
- Still removes gradient anchor points at non-grid ages

### 4.4 Adaptive binning by CDF span

**Idea**: Choose bin boundaries to give approximately equal CDF
increments. Denser bins where the CDF is changing rapidly (near
onset + median), sparser in the tails.

**Properties**:
- Adapts to the CDF shape — more resolution where it matters
- Predictable number of bins per trajectory
- Could preserve gradient information better than uniform grids

**Concerns**:
- CDF depends on latent parameters — can't compute exact CDF at
  filter time. Would need to use prior or analytic estimates.
- Data-dependent (different bins for different prior estimates)
- Adds complexity to the evidence binder

### 4.5 Maintain all evaluation points, reduce gammaln cost

**Idea**: Don't compress the data. Instead, optimise the DM logp
computation to handle many zero-count bins efficiently.

For zero-count intervals, skip the gammaln computation entirely
(it's zero). Only evaluate gammaln for non-zero intervals + remainder.
But keep all CDF evaluation points for gradient flow.

**Properties**:
- No data loss at all — not even gradient anchor points
- Reduces gammaln cost but not CDF cost
- Simple implementation (conditional in the logp computation)

**Concerns**:
- Doesn't reduce CDF evaluations (the main cost for large graphs)
- Doesn't reduce PyTensor graph size (compilation time unchanged)
- May not be sufficient for large graphs

### 4.6 Sparse CDF evaluation with interpolation

**Idea**: Evaluate the CDF at a sparse set of ages, then interpolate
to get CDF values at all trajectory ages. The DM uses ALL intervals
(preserving gradient anchors) but the CDF computation is cheaper.

**Properties**:
- Preserves all DM intervals (no gradient loss)
- Reduces CDF evaluations (erfc calls)
- CDF interpolation is cheap (linear or spline)

**Concerns**:
- CDF interpolation introduces approximation error
- Interpolated CDF is not differentiable w.r.t. parameters at the
  same points → gradient flow may be disrupted
- Adds complexity

---

## 5. Implementation detail

This section contains enough detail to engage with the problem without
reading the full codebase.

### 5.1 Data flow

```
Snapshot DB rows (per edge, per anchor_day, per retrieval_age)
    ↓
Evidence binder (compiler/evidence.py)
  - Groups rows by anchor_day into trajectories
  - Monotonises cumulative_y (ensures non-decreasing)
  - Applies zero-count filter HERE (currently disabled)
  - Produces CohortDailyTrajectory objects:
      { date, n, retrieval_ages[], cumulative_y[], obs_type, recency_weight }
    ↓
Model builder (compiler/model.py)
  - Flattens all trajectories for one edge into one pm.Potential
  - One Potential per (edge × obs_type) — typically 2 per edge
    (window + cohort)
```

### 5.2 How the Potential is built (Phase D, latent latency)

All trajectory ages for one edge are flattened into a single 1D array.
The DM logp is computed via advanced indexing — no Python loops at
sample time.

**Step 1 — Flatten ages**:
```python
all_ages_raw = []
for traj in trajs:            # trajs = all trajectories for this edge/obs_type
    all_ages_raw.extend(traj.retrieval_ages)
ages_tensor = pt.as_tensor_variable(np.array(all_ages_raw))
```

**Step 2 — CDF at all ages** (single vectorised call):
```python
# onset, mu_var, sigma_var are latent PyTensor variables
effective_ages = pt.softplus(ages_tensor - onset)   # differentiable onset
log_ages = pt.log(pt.maximum(effective_ages, 1e-30))
z_all = (log_ages - mu_var) / (sigma_var * pt.sqrt(2.0))
cdf_all = 0.5 * pt.erfc(-z_all)                    # shape: (N_total_ages,)
```

**Step 3 — Build interval index arrays** (numpy, at model build time):
```python
curr_indices = []    # index into cdf_all for right boundary of each interval
prev_indices = []    # index for left boundary (-1 sentinel for first interval)
interval_counts = [] # conversion count in each interval
interval_weights = [] # recency weight per interval

for traj in trajs:
    for j, age in enumerate(traj.retrieval_ages):
        curr_indices.append(age_offset + j)
        prev_indices.append(age_offset + j - 1 if j > 0 else -1)
        count = cum_y[j] - cum_y[j-1] if j > 0 else cum_y[0]
        interval_counts.append(count)
        interval_weights.append(traj.recency_weight)
    # Remainder for this trajectory
    remainder_indices.append(age_offset + len(ages) - 1)
    remainder_counts.append(traj.n - cum_y[-1])
    age_offset += len(ages)
```

**Step 4 — CDF coefficients via advanced indexing** (PyTensor):
```python
cdf_curr = cdf_all[curr_idx_np]           # CDF at right boundary
cdf_prev = cdf_all[prev_safe]             # CDF at left boundary (0 for first)
is_first = (prev_idx_np < 0).astype(float)
cdf_coeffs = cdf_curr - cdf_prev * (1.0 - is_first)
cdf_coeffs = pt.clip(cdf_coeffs, 1e-12, 1.0)
```

**Step 5 — DM alpha and logp** (PyTensor):
```python
alpha_interval = kappa * p_expr * cdf_coeffs
alpha_interval = pt.maximum(alpha_interval, 1e-12)

# Interval terms: Σ w_j · [gammaln(count_j + α_j) - gammaln(α_j)]
logp_intervals = pt.sum(
    weights * (pt.gammaln(counts + alpha_interval) - pt.gammaln(alpha_interval))
)

# Remainder terms: one per trajectory
cdf_finals = cdf_all[remainder_idx_np]
alpha_remainder = kappa * (1.0 - p_expr * cdf_finals)
alpha_remainder = pt.maximum(alpha_remainder, 1e-12)
logp_remainders = pt.sum(
    rem_weights * (pt.gammaln(rem_counts + alpha_remainder) - pt.gammaln(alpha_remainder))
)

# Normalisation: one per trajectory
logp_norm = pt.sum(
    traj_weights * (pt.gammaln(kappa) - pt.gammaln(n_per_traj + kappa))
)

logp = logp_intervals + logp_remainders + logp_norm
pm.Potential(f"traj_{obs_type}_{edge_id}", logp)
```

### 5.3 What the filter changes

Without filter: `ages_tensor` has N entries (all raw ages).
With filter: `ages_tensor` has M < N entries (zero-count ages removed).

The index arrays (`curr_indices`, `prev_indices`, etc.) are rebuilt
from the filtered trajectory. The counts, weights, and remainder are
the same (zero-count intervals contribute 0 to counts; non-zero
intervals are preserved exactly; remainder uses CDF at final age).

The `cdf_all` tensor has M entries instead of N. This means:
- Fewer `erfc` evaluations in the forward pass
- Fewer `gammaln` evaluations
- Smaller PyTensor symbolic graph → different compilation path
- Fewer gradient computation nodes → different gradient landscape
  for NUTS mass matrix adaptation

### 5.4 The clip floors

Two clip operations in the computation:

```python
cdf_coeffs = pt.clip(cdf_coeffs, 1e-12, 1.0)
alpha_interval = pt.maximum(alpha_interval, 1e-12)
```

For zero-count intervals with small CDF spans (e.g., in the tail),
`cdf_coeffs` may be very small. The clip to 1e-12 activates,
replacing the true (tiny) value with 1e-12. This zeroes the gradient
through that coefficient. When the filter merges adjacent small-CDF
intervals into wider ones, the merged coefficient may be above 1e-12,
meaning the gradient flows through. This is one concrete mechanism by
which the filter could change gradient behaviour — not through the
zero-count logp (which is 0 regardless) but through the clip floor
on very small CDF coefficients.

### 5.5 Recency weighting

Each trajectory carries a recency weight:
```python
w = exp(-ln2 · age_days / half_life)
```

where `age_days` is the number of days since the trajectory's
anchor_day. Recent trajectories have w ≈ 1; old ones decay. The
weight multiplies each interval's logp contribution.

This is relevant because the filter affects ALL trajectories
uniformly (same ages removed from all), but the recency weights
mean recent trajectories contribute more to the gradient. If the
filter disproportionately removes ages from recent vs old
trajectories (which it does — recent trajectories have fewer
retrieval ages), the gradient reweighting changes.

---

## 6. External review — two competing approaches

Two independent analyses of the briefing produced different
recommendations. Both agree the filter is mathematically lossless and
the issue is computational (NUTS warmup sensitivity). They disagree
on the fix.

### 6.1 Response A — "Don't change the model, optimise the computation"

**Core argument**: The Poisson exposure hybrid is a new model, not a
compression of the existing one. The proposed term `-κ·p·ΔF` is
suspect: under the DM, expected interval count is `n·p·ΔF`, not
`κ·p·ΔF`. Splicing Poisson penalties into a DM creates a model that
needs separate calibration. The correct approach is to keep the DM
unchanged and reduce the computational cost.

**Recommended path**:

1. **Immediate exact optimisation** (no model change):
   - Keep all original age boundaries in the data
   - Deduplicate repeated ages per (edge, obs_type) before the CDF
     call, then gather back by index
   - Skip `gammaln` terms for zero-count intervals in the sum, but
     do NOT drop their CDF evaluation points
   - The PyTensor graph retains full gradient structure

2. **If still too slow**: Replace the trajectory Potential with a
   fused custom likelihood Op (PyTensor custom Op or JAX-backed).
   Same formula, same clips — just fewer symbolic nodes.

3. **Survival/counting-process formulation**: Only as a separate
   model project. Do not splice into the existing DM.

**Key objection to Approach B**: The Poisson hybrid is not the
literature-backed continuation of the current DM. Grouped survival /
piecewise-exponential is an end-to-end reparameterisation (Rodríguez
GLM §7.4), not a free penalty you bolt onto a compound multinomial.

### 6.2 Response B — "The clip floor is the root cause; smooth it"

**Core argument**: The regression is caused by `pt.clip(cdf_coeffs,
1e-12, 1.0)` and `pt.maximum(alpha, 1e-12)` creating dead-gradient
regions. Stan explicitly warns against step-like functions in
gradient-based samplers (Stan Functions Reference §3.7). When the
filter merges intervals, merged CDF spans cross the 1e-12 threshold,
changing which parameters receive gradient during warmup.

**Recommended path (two layers)**:

**Layer 1 — Smooth clip floors** (try first, ~10 lines):
```python
def _soft_floor(x, floor, sharpness=1e6):
    return floor + pt.softplus(sharpness * (x - floor)) / sharpness
```
Replace the 4 hard clip/maximum sites in model.py. This ensures
gradient is never exactly zero, making the landscape invariant to
whether zero-count bins are present or merged.

Risk: Low. At sharpness=1e6, indistinguishable from hard clip for
values well above floor. Standard practice (TFP SoftClip bijector).

**Layer 2 — Poisson exposure penalty** (only if Layer 1 insufficient):
Add counting-process censoring term for merged zero-event blocks.
Justified as the standard piecewise-exponential formulation for
interval-censored data, not as a "bolt-on" — the DM's zero-count
term is identically zero, so the Poisson replaces nothing with the
standard censoring contribution.

**Additional measure**: Dense mass matrix (`dense_mass=True`) to
capture the onset-μ correlation (0.85-0.90) directly. Tran & Kleppe
(2024) show diagonal mass matrices are fragile in this regime.

### 6.3 Where they agree

- The filter IS mathematically lossless (DM aggregation property)
- The problem IS computational (NUTS warmup, not likelihood)
- The clip floors ARE a plausible mechanism
- A fused/custom Op is the nuclear option if simpler fixes fail
- The Poisson hybrid needs careful justification if pursued

### 6.4 Where they disagree

| | Response A | Response B |
|---|---|---|
| **First step** | Keep all CDF points, skip zero gammaln | Smooth the clip floors |
| **On Poisson hybrid** | Reject — different model | Conditional accept — Layer 2 fallback |
| **On the clip mechanism** | Implicit (not the focus) | Central thesis |
| **Philosophy** | Don't touch the model | Fix the gradient landscape |

### 6.5 Synthesis — recommended investigation order

1. **Smooth clip floors** (Response B, Layer 1) — cheapest test,
   directly addresses the identified mechanism. ~10 lines. If the
   filter works with smooth clips, the problem is solved.

2. **Skip zero-count gammaln, keep CDF points** (Response A, Step 1)
   — if smooth clips don't suffice, keep all gradient anchors but
   reduce gammaln cost. Requires restructuring the interval sum to
   conditionally skip zero-count terms.

3. **Fused custom Op** (both agree) — if compilation time is still
   the bottleneck, wrap the entire logp in a single differentiable
   kernel. Same model, fewer symbolic nodes.

4. **Poisson exposure / survival reformulation** — only if all above
   fail. Requires separate validation.

---

### 6.6 Response C — "Clip floors + dense mass matrix"

**Core argument**: Agrees with Response B that smooth clip floors are
the primary fix. Adds a second mechanism: the onset-μ correlation
(0.85-0.90) is in the regime where diagonal mass matrices are fragile
(Tran & Kleppe 2024). A dense mass matrix would stabilise warmup
independently of the gradient landscape.

**Recommended path (staged)**:

1. **Smooth clip floors** (same as Response B, Layer 1) — eliminate
   dead-gradient traps from `pt.clip`/`pt.maximum`.

2. **Dense mass matrix** for highly correlated parameters — use
   `nuts_sampler_kwargs={"dense_mass": True}` or per-block dense
   matrix for (onset, μ) pairs. Captures the correlation structure
   directly, making sampling robust to gradient perturbations.

3. **Re-enable filter** — with both fixes, the filter is safe.

4. **Fallback: fused custom Op** if compilation still too slow.

**Additional analysis on the Poisson hybrid**: Rejects Approach B
Layer 2 more strongly — notes that scaling by κ (overdispersion)
rather than n (population) is statistically incoherent. The expected
interval count under the DM is `n·p·ΔF`, not `κ·p·ΔF`.

**On floating-point chaos**: Identifies a second mechanism beyond the
clip floors — the filter changes PyTensor graph topology, which
changes floating-point accumulation order. In the pathological
onset-μ geometry (corr ≈ 0.85-0.90), even tiny numerical
perturbations during warmup can produce catastrophically different
mass matrix estimates. The smooth clips address this by ensuring
continuous gradient flow regardless of accumulation order.

### 6.7 Updated synthesis

All three responses now converge:
- **Smooth clip floors**: Unanimous. Implemented and validated.
- **Dense mass matrix**: Responses B and C recommend. Not yet tested.
- **Poisson hybrid**: Response A rejects, Response C rejects more
  strongly (κ vs n scaling issue), Response B proposed conditionally.
  **Deprioritised.**
- **Fused custom Op**: All agree as nuclear fallback.

### 6.8 Current status (24-Mar-26)

**Step 1 (smooth clips) is IMPLEMENTED AND VALIDATED.**

Results with filter ON + smooth clips:

| Test | rhat | ess | divs | Status |
|---|---|---|---|---|
| Production (today's data) | 1.002 | 2655 | 0 | PASS |
| Production (yesterday's asat) | 1.002 | 2825 | 0 | PASS |
| Synth 4-step mirror | — | — | — | PASS |
| Synth 2-step | — | — | — | PASS |

The blocking defect is resolved. The filter losslessly compresses
trajectory data (29 ages → from 33 raw for the production graph)
and NUTS converges correctly with smooth gradient floors.

**Step 2 (dense mass matrix)** is recommended as a robustness measure
but not yet tested. Worth investigating for edges with onset-μ
correlation > 0.85.

---

## 7. Lessons learned

### 7.1 Hard clip floors are dangerous in NUTS models

Stan Functions Reference §3.7 explicitly warns against step-like
functions (`clip`, `maximum`, `if_else`) in gradient-based samplers.
We had 4 instances of `pt.clip`/`pt.maximum` at 1e-12 in the DM logp.
These created dead-gradient traps that were invisible in normal
operation but became catastrophic when the data compression filter
changed which intervals hit the floor.

**Rule**: In any NUTS model, replace `pt.clip(x, floor)` and
`pt.maximum(x, floor)` with a smooth softplus-based approximation
(`_soft_floor`). The cost is negligible; the robustness gain is
significant.

### 7.2 Likelihood-lossless ≠ NUTS-lossless

A transformation that preserves the logp and its mathematical
gradient can still break NUTS sampling if it changes the computational
graph in ways that interact with:
- Hard clip/maximum floors (dead gradient regions)
- Floating-point accumulation order (warmup trajectory perturbation)
- Mass matrix adaptation (curvature estimation during warmup)

This is especially dangerous when the posterior has pathological
geometry (high parameter correlations, multimodality, narrow ridges).

### 7.3 Dense mass matrix as future robustness

For edges with onset-μ correlation > 0.85, the diagonal mass matrix
is fragile (Tran & Kleppe 2024). A dense or block-dense mass matrix
would capture the correlation directly. Not yet implemented but worth
considering as a complementary hardening measure for production graphs
with marginal geometry.

### 7.4 The investigation process

The defect was found by:
1. Confirming the regression was deterministic (not stochastic)
2. Using `--asat` to rule out data changes
3. Reverting model.py to rule out mixture CDF changes
4. Bisecting to the evidence.py filter via git diff
5. Disabling the filter to confirm
6. Soliciting three independent analyses of the briefing
7. Implementing the consensus fix (smooth clips)
8. Validating on production + synth regression tests

The `--asat` flag (added during this investigation) proved essential
for reproducing historical runs. It loads graph/param files from git
at a specified date and filters snapshot DB rows to `retrieved_at <=
date`.

---

## 8. Reproduction steps

```bash
# Current state (filter ON, smooth clips ON — should pass):
python bayes/test_harness.py --graph simple --no-webhook

# To reproduce the original failure (revert smooth clips):
# In model.py, replace _soft_floor() calls with pt.clip/pt.maximum
python bayes/test_harness.py --graph simple --no-webhook
# Expected: rhat ≈ 1.53

# Historical replay:
python bayes/test_harness.py --graph simple --asat 2026-03-23 --no-webhook

# Regression tests:
pytest bayes/tests/test_param_recovery.py -v -s
```
