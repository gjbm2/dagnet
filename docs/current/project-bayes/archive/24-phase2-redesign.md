# Doc 24: Phase 2 Redesign — Posterior-as-Prior with Drift Constraint

**Created**: 29-Mar-26
**Status**: Design (not yet implemented)
**Purpose**: Replace the current Phase 2 freeze+drift mechanism with a
principled posterior-as-prior approach that carries Phase 1's evidence
weight through the phase boundary.

---

## 1. Problem Statement

Phase 2 currently freezes Phase 1 edge parameters to point estimates
and applies hardcoded perturbation mechanisms (eps_drift × tau for p,
wide priors for cohort latency). This discards Phase 1's posterior
precision. Consequences:

1. **p-CDF ridge**: free cohort latency + any p freedom creates the
   cure model identifiability problem (p inflates, CDF compensates)
2. **Arbitrary drift constraint**: tau_drift = 0.1 regardless of
   Phase 1's evidence strength
3. **Branch group instability**: Dirichlet or drift+simplex both
   failed to adequately constrain branch group p
4. **Option A failure**: per-cohort random effects created spurious
   modes that trapped the sampler

Root cause: the phase boundary collapses posterior → point estimate,
losing precision information.

## 2. Design Principles

1. **Phase 1 evidence weight must flow into Phase 2** — prior widths
   in Phase 2 are derived from Phase 1 posterior precision, not
   hardcoded.

2. **Drift freedom is bounded by elapsed time** — the only reason
   2.edge.p can differ from 1.edge.p is temporal drift, which is
   bounded by the time the cohort took to traverse the upstream path
   (a→x). Zero elapsed time = zero drift.

3. **Path latency must be correctable** — FW convolution of edge
   latencies is an approximation. Phase 2's path latency must be
   free to deviate, but constrained by Phase 1's propagated
   evidence weight.

4. **Conservative default** — when drift rate cannot be estimated,
   assume no drift (prior = full Phase 1 precision).

## 3. Variable Structure

### 3.1 Edge probability (2.edge.p)

**Type**: free Beta variable per edge.

**Prior**: Phase 1 posterior, ESS-decayed by elapsed time.

```
Phase 1 posterior: Beta(α₁, β₁)
elapsed = median_path_latency(a → from_node(x→y))
scale = 1 / (1 + elapsed × σ²_drift / V₁)
Phase 2 prior: Beta(α₁ × scale, β₁ × scale)
```

Where:
- V₁ = p(1-p) / (α₁ + β₁) — Phase 1 posterior variance
- σ²_drift = daily drift variance (estimated from Phase 1 data,
  default 0)
- scale = 1 when elapsed = 0 (first edge, full precision)
- scale → 0 when elapsed is large relative to timescale

**Branch groups**: Dirichlet on 2.edge.p values. Concentrations
from ESS-decayed Phase 1 posteriors. Each sibling's α, β are
individually decayed, then used as Dirichlet concentration
components.

### 3.2 Path probability (2.path.p)

**Type**: derived (not a free variable).

**Computed as**: product of 2.edge.p values along the path.

Composition is exact (product of probabilities). No approximation
error. Used in the cohort trajectory likelihood.

### 3.3 Edge latency (2.edge.latency)

**Type**: frozen constants per edge.

**Values**: Phase 1 posterior means for onset, mu, sigma.

Edge-level latency is well-determined by Phase 1 (onset obs, t95
constraint, window trajectories). Freezing is justified because the
edge CDF shape is an intrinsic property of the conversion
mechanism, not time-dependent (unlike p, which can drift with
campaigns/seasonality).

### 3.4 Path latency (2.path.latency)

**Type**: free variables per path endpoint (onset_cohort, mu_cohort,
sigma_cohort).

**Prior**: centred on FW-composed Phase 1 edge latencies, with
widths from propagated Phase 1 posterior SDs.

```
FW composition: (onset_path, mu_path, sigma_path) = FW(1.edge latencies)
Prior widths: RSS of per-edge posterior SDs through the path
  onset_sd = sqrt(Σ onset_sd_edge²)
  mu_sd = sqrt(Σ mu_sd_edge²)
  sigma_sd = sqrt(Σ sigma_sd_edge²)
```

These allow the path CDF to deviate from the FW approximation
(which is structurally imperfect for multi-edge paths) while
being constrained by Phase 1's evidence weight.

### 3.5 Path CDF (2.path.CDF)

**Type**: derived from 2.path.latency variables.

Used directly in the cohort trajectory likelihood.

## 4. Drift Rate Estimation (σ²_drift)

### 4.1 Model

True conversion rate drifts as a random walk:
```
p_true(t) = p_true(t-1) + η_t,  η ~ Normal(0, σ²_drift)
```

Observed rate includes noise:
```
p_obs(t) = p_true(t) + ε_t,  ε ~ Normal(0, σ²_noise)
```

### 4.2 Estimator

For observations k days apart:
```
Var(Δ^(k)) = k × σ²_drift + 2 × σ²_noise
```

Using lag 1 and lag 7:
```
σ²_drift = max(0, (Var(Δ⁷) - Var(Δ¹)) / 6)
```

Data source: per-anchor-day maturity-adjusted conversion rates
from Phase 1 evidence.

### 4.3 Conservative defaults

- σ²_drift = 0 when: Var(Δ⁷) ≤ Var(Δ¹), or fewer than 25 anchor
  days, or per-day rates unavailable
- No drift detected → scale = 1 for all edges → Phase 2 p prior
  = full Phase 1 precision

### 4.4 Timescale interpretation

timescale = V₁ / σ²_drift (days until drift variance equals
Phase 1 posterior variance). Examples:

| Phase 1 SD | σ²_drift/day | timescale | 30d scale |
|---|---|---|---|
| ±0.035 | 0.0001 | 12 days | 0.29 |
| ±0.035 | 0.00001 | 123 days | 0.80 |
| ±0.035 | 0 | ∞ | 1.00 |

## 5. Likelihood Structure

### 5.1 Denominator and p expression

The snapshot DB stores cohort data as (a, x, y) per anchor day ×
retrieval date, where:
- a = anchor count (entered funnel on this anchor day)
- x = from-node count (reached this edge's from-node)
- y = to-node count (reached this edge's to-node)

The natural observation is **edge x→y denominated from x**: the
question "of those who reached x, how many converted to y?" This
matches the data structure (y/x is the meaningful signal; y/a is
tiny and noisy for downstream edges). It also matches the output
consumers (cohort maturity chart, surprise gauge display x→y rates).

**Decision: keep phase2_cohort_use_x.** The likelihood uses:
- n = cumulative_x (from-node arrivals)
- p = 2.edge.p (edge probability)
- CDF = 2.path.CDF (path-level CDF from 2.path.latency or
  frozen edge latency)

```
q_j = p_edge × ΔF_path(t_j) / (1 - p_edge × F_path(t_{j-1}))
d_j ~ Binomial(n_at_risk_j, q_j)
```

### 5.2 Why edge p with path CDF

The CDF F_path accounts for the full maturation from anchor: the
time for someone entering at a to first reach x (upstream latency)
and then convert at x→y (edge latency). With from-node denominator
(x arrivals), the CDF describes what fraction of x-arrivals have
converted by each observation age (measured from anchor entry, not
from x arrival). The path CDF is correct because the observation
age IS from anchor entry.

## 6. Remaining Design Questions

### 6.1 Join-node CDF (independent fix)

Phase 2 with phase2_cohort_use_x picks one arbitrary path for
join-downstream edges. Must be fixed to build the weighted mixture
of incident path CDFs. Independent of this redesign. See journal
28-Mar-26.

### 6.2 Between-cohort kappa (Williams method)

Williams moment estimator on trajectory residuals gives empirical
between-cohort kappa for honest cohort alpha/beta. Already
implemented. Independent of this redesign. May become redundant if
Phase 2's posterior uncertainty is correctly calibrated — to be
evaluated empirically.

### 6.3 Fit history (source 2 for drift rate)

Once nightly scheduling is running, the time series of fitted p
values across runs directly measures drift. More reliable than the
Phase 1 lag-variance estimator (source 1). Future work.

### 6.4 Single-edge latency paths

When the upstream path a→x has zero latency (elapsed = 0), the
cohort observes edge x→y at the same time as the window.
2.edge.latency = 1.edge.latency exactly. No cohort_latency_vars
needed — frozen edge CDF is correct.

cohort_latency_vars should only be created when the upstream path
has nonzero latency (elapsed > 0), i.e. when the path CDF might
genuinely differ from the FW composition.

## 7. Implementation Sequence

1. **Step 1**: Phase 2 with σ²_drift = 0 (all edges get full
   Phase 1 posterior precision). Free 2.path.latency with Phase 1-
   propagated widths (only for edges with upstream latency).
   Confirm p recovery on synth drift graphs.

2. **Step 2**: Add σ²_drift estimation from Phase 1 lag-variance.
   Test on synth graphs with drift_sigma > 0 in truth config.

3. **Step 3**: Validate on production. Compare p_cohort, cohort
   latency, and surprise gauge behaviour against current approach.

4. **Step 4**: Evaluate whether to remove phase2_cohort_use_x and
   revert to anchor denominator + path p.

## 8. What This Replaces

- eps_drift / tau_drift mechanism
- Hardcoded cohort_latency prior widths
- drift+simplex workaround for branch groups
- Option A (per-cohort random effects in Phase 2)
- Option C (Phase 1 kappa_p plumbing for cohort predictive)
