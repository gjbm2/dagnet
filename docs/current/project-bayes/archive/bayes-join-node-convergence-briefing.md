# Bayes Model: Join-Node Latency Convergence Problem

**Status**: Blocked
**Date**: 20-Mar-26
**Seeking**: Second opinions on model geometry / parameterisation at DAG join nodes

---

## 1. System Overview

DagNet is a conversion-graph modelling platform. Users define directed acyclic graphs where:
- **Nodes** represent observable user states (e.g. "household created", "delegated", "registered", "success")
- **Edges** represent transitions between states, each with:
  - A **probability** p (what fraction of people reaching the source node transition along this edge)
  - A **latency** model: shifted lognormal T = onset + LogNormal(mu, sigma) (how long the transition takes)

The **Bayes compiler** fits these p and latency parameters jointly from observational trajectory data using PyMC/NUTS (via nutpie). The data comes from periodic snapshots: for each edge, we observe cohorts of people entering the funnel on a given day, then see how many have completed each transition at various retrieval ages (e.g. after 1 day, 3 days, 7 days, 14 days, 30 days...).

### What works well

The following are all implemented and converging with 0 divergences, rhat ~1.00, ESS > 1000:

- **Solo edges** (no branching): latent p, latent (mu, sigma) for latency, BetaBinomial likelihood with per-edge overdispersion kappa
- **Branch groups** (one node splitting to N siblings): Dirichlet-Multinomial ensuring sum(p_i) <= 1, with per-edge kappa
- **Window trajectories** (edge-level CDF): observe entrants to source node X, count arrivals at target node Y over time. CDF uses edge-level latency only.
- **Cohort trajectories** (path-level CDF): observe entrants at the anchor node A, count arrivals at a downstream node Y. CDF uses the composed path latency A -> ... -> Y via Fenton-Wilkinson approximation of the sum of lognormals.
- **Differentiable FW path composition**: for linear chains (no joins), the path CDF is a differentiable function of all upstream edge-level latent (mu, sigma) variables. NUTS gradients flow through the FW composition. This is confirmed working.
- **Recency-weighted likelihood**: exponential decay weighting on trajectory days
- **Per-edge overdispersion**: each edge learns its own kappa ~ Gamma(3, 0.1)

### The blocker: graphs with join nodes

A **join node** is a node with in-degree >= 2 (multiple edges converging). At a join, people arriving at the node came via different paths with different latency profiles. The path-level CDF downstream of a join must somehow account for this mixture of arrival times.

**For graphs without joins, everything converges perfectly.** The problem is exclusively about how to handle the latency CDF at and downstream of join nodes.

---

## 2. The Test Graph

The branch test graph has 12 nodes and 17 edges with meaningful structural complexity:

```
                                    household-created (anchor)
                                     /              \
                       household-delegated     abandoned (terminal)
                      /     |      |       \
                     /      |      |        \
          viewed-coffee  mob-rec  energy-rec  no-rec-sent (terminal)
           /    |    \           /    |    \
     gave-bds  E-rec  no-rec  /      |     \
      / | \                  /       |      \
   E-rec no-rec ...         /        |       \
                           /         |        \
                     switch-reg  post-rec-fail  ...
                      /     \
                 success  post-reg-fail
```

### Key join nodes

| Join Node | Inbound Edges | Paths from Anchor |
|-----------|---------------|-------------------|
| **energy-rec** | 4 inbound: from delegated (direct), from coffee, from bds, delegation-straight | 4 distinct paths, each 2-4 hops |
| **switch-registered** | 2 inbound: from mob-rec, from energy-rec | 5+ distinct paths (energy-rec itself is a 4-way join) |
| **no-recommendation-sent** | 3+ inbound | Terminal, unevented (no data, doesn't need CDF) |

### Edge probabilities (from data)

| Path to energy-rec | p (approx) | Latency character |
|---------------------|------------|-------------------|
| delegated -> energy-rec (direct) | 0.40 | Fast (short path) |
| delegated -> coffee -> energy-rec | 0.33 * 0.57 = 0.19 | Medium |
| delegated -> coffee -> bds -> energy-rec | 0.33 * 0.41 * 0.82 = 0.11 | Slow (3 latency hops) |
| delegated -> mob-rec (bypasses energy-rec) | 0.21 | Goes to switch-registered directly |

The paths to energy-rec have **very different latency profiles** (1 hop vs 3 hops from delegated). The direct path might have median latency ~2 days; the bds path might have median latency ~10+ days. This is not a minor perturbation -- the mixture is genuinely multimodal.

### Variable count

The full model has ~46 free variables: per-edge p, mu, sigma, kappa for each of the 10 data-bearing edges, plus cohort latency hierarchy variables for multi-hop paths. The simple (non-join) graph has ~24 variables and converges in ~60s.

---

## 3. The Fundamental Problem

### What the CDF must represent at a join

Consider edge energy-rec -> switch-registered. A cohort observation says: "Of the 1000 people who entered at the anchor (household-created), how many have reached switch-registered after t days?"

To compute the expected count, we need:

```
E[count at age t] = n_anchor * p_path * CDF_path(t)
```

where `p_path` is the probability of reaching switch-registered via any route, and `CDF_path(t)` is the **mixture CDF** of arrival times, weighted by how much traffic each path carries.

For switch-registered, the arrival time distribution is a mixture of 5+ shifted lognormals (one per distinct path from anchor), each with different onset and (mu, sigma), weighted by the product of edge probabilities along that path.

### Why this is hard for NUTS

NUTS (No-U-Turn Sampler) relies on Hamiltonian Monte Carlo, which needs smooth gradients of the log-posterior. The problem is the interaction between:

1. **Latent probability variables** (p per edge) -- these determine the mixture weights
2. **Latent latency variables** (mu, sigma per edge) -- these determine each component CDF's shape
3. **The CDF evaluation** -- a nonlinear function (erfc of log of age minus onset)

At a join, changing one edge's p redistributes traffic weight across paths, which shifts the mixture CDF, which changes the likelihood of all downstream observations. Simultaneously, changing an upstream edge's mu shifts one component of the mixture CDF. The sampler must navigate a space where p and latency interact nonlinearly through the mixture.

---

## 4. Approach 1: Moment-Matched Collapse (Failed)

### Method

At each join node, collapse the mixture of inbound path latencies into a single shifted lognormal by matching the first two moments:

```python
# For each inbound path i with shifted lognormal (delta_i, mu_i, sigma_i):
E[T_i] = delta_i + exp(mu_i + sigma_i^2/2)

# Mixture moments (w_i = traffic weight, function of latent p vars):
E_mix = sum(w_i * E[T_i])
Var_mix = sum(w_i * E[T_i^2]) - E_mix^2

# Collapse to single shifted lognormal:
delta_mix = min(delta_i)
sigma_mix^2 = log(1 + Var_mix / (E_mix - delta_mix)^2)
mu_mix = log(E_mix - delta_mix) - sigma_mix^2/2
```

This was implemented in pure Python (for topology analysis) and in PyTensor (for the differentiable model).

### Why it failed: gradient scale catastrophe

The moment computation requires `exp(mu + sigma^2/2)`. For our test graph:
- Direct path (1 hop): mu ~ 0.7, so exp(0.7 + 0.12) ~ 2.3
- BDS path (3 hops, FW-composed): mu ~ 3.5, so exp(3.5 + 0.5) ~ 55

The gradient of E_mix with respect to a component's mu is proportional to exp(mu + sigma^2/2), creating a ~25x gradient scale mismatch across components. NUTS uses a single mass matrix (or diagonal adaptation) for all variables, so it cannot simultaneously take appropriate step sizes for both high-mu and low-mu components.

### PyTensor log-sum-exp version

We reimplemented the moment computation in log-space to avoid numerical overflow:

```python
log(E_shifted_i) = log(delta_i - delta_mix + exp(mu_i + sigma_i^2/2))
log(E_mix) = logsumexp(log(w_i) + log(E_shifted_i))
# ... variance via log(E2 - E^2) = log_E2 + log1mexp(...)
```

### Result

Still failed. rhat = 2.83, ESS = 5, massive divergences. The problem is not numerical overflow -- it's the fundamental nonlinear coupling through the moment-matching equations. The collapse maps a high-dimensional space (per-path latency components) through `exp()` into a 2D summary (mu_mix, sigma_mix), creating ridges and funnels in the posterior.

### Warm-start attempt

We also tried warm-starting from a previous successful run's posteriors (initialising the sampler near a known good point). Result: rhat = 1.53, ESS = 7. The geometry is the problem, not the starting point.

---

## 5. Approach 2: Mixture-Path CDF (Failed)

### Method

Instead of collapsing to a single lognormal, carry all path components forward as separate CDFs. At each node, store a list of mixture components:

```python
node_components[node_id] = [(weight_i, onset_i, mu_i, sigma_i), ...]
```

**At non-join nodes**: inherit parent's components, compose each with the edge's latency via FW, multiply weight by edge's p.

**At join nodes**: concatenate component lists from all inbound edges.

The CDF at any point is:

```
CDF(t) = sum(w_i * CDF_LN(t - onset_i, mu_i, sigma_i)) / sum(w_i)
```

where each CDF_LN is the standard lognormal CDF (erfc), and w_i are products of latent p variables along the path (so gradients flow through).

### Rationale

- No moment-matching, no `exp()` blowup
- Each component CDF is individually well-behaved (erfc of log)
- The weighted sum is linear in the weights and CDF values
- FW composition along each path is in log-space (stable)

### Implementation

Dynamic programming builds the component lists in node-topological order. For the test graph, energy-rec accumulates 4 components; switch-registered accumulates 5+ (energy-rec's 4 plus mob-rec's 1).

The CDF evaluation in the likelihood:
```python
for w_i, onset_i, mu_i, sigma_i in mixture_components:
    eff_ages_i = pt.maximum(ages - onset_i, 1e-6)
    z_i = (log(eff_ages_i) - mu_i) / (sigma_i * sqrt(2))
    cdf_i = 0.5 * erfc(-z_i)
    weighted_cdfs.append(w_i * cdf_i)

cdf_all = sum(weighted_cdfs) / sum(weights)
p_expr = sum(weights)  # total path probability
```

### Result

**Timed out at 900s, stuck at 52% progress.** Two of four chains appear to have completed; two got permanently stuck. The estimated remaining time was increasing, indicating the stuck chains were making zero effective progress.

Additional cost: PyTensor compilation time doubled from ~60s to ~125s due to the expanded computation graph (multiple CDF evaluations per observation point, each involving latent variables from different upstream edges).

### Why it likely failed

Even though the mixture CDF avoids the `exp()` blowup of moment-matching, the fundamental issue remains: **the mixture weights are products of latent p variables, and the CDF shapes depend on latent mu/sigma variables from different edges**. The posterior has:

1. **Weight-CDF correlation**: increasing one path's weight (by changing its constituent p values) while decreasing another's, while the CDF shape for each path is also changing, creates a complex nonlinear coupling surface.

2. **Multiple ridges**: if two paths have similar total latency but very different weight, the sampler can trade weight between them without much likelihood change, creating a ridge.

3. **Funnel geometry at low-weight paths**: paths with very small weight (e.g. 5% of traffic) contribute little to the mixture CDF, so their latency parameters are weakly identified, creating a funnel (wide prior, narrow likelihood).

---

## 6. What Has NOT Been Tried

### A. Fixed latency at joins, latent p only

Use point-estimate (non-latent) latency for any CDF downstream of a join node. Only the probability variables are latent through join nodes; latency uses the fixed prior values from topology analysis.

**Pros**: Completely avoids the latency-at-joins geometry problem. Probability estimation (the primary goal) is unaffected. Falls back to the Phase S (fixed-latency) approach for join-downstream edges.

**Cons**: Loses the ability to learn latency from cohort data at join-downstream edges. Edge-level latency is still learnable from window data (which uses edge-level CDF, not path-level).

### B. Dominant-path approximation

At each join, use only the single highest-weight inbound path for the cohort CDF. The probability mixture still captures all paths' contributions, but the latency CDF uses one path only.

**Pros**: Reduces to single-path CDF (which works). If one path dominates (>70% weight), the approximation error is small.

**Cons**: For energy-rec, the direct path is ~40% and the coffee path is ~19%. No single path dominates. The approximation may introduce bias.

### C. Two-phase fitting (decouple p and latency)

First pass: fit all p variables with fixed latency (Phase S approach). Second pass: condition on MAP estimates of p, fit latency variables.

**Pros**: Avoids the joint p-latency geometry at joins entirely.

**Cons**: Loses joint uncertainty quantification. The posterior of latency given MAP(p) is not the same as the marginal posterior of latency. May underestimate uncertainty.

### D. Non-centred reparameterisation at the path level

Instead of composing per-edge latent variables, parameterise the path latency directly and constrain it to be consistent with edge-level latencies.

### E. Variational inference (ADVI or normalising flows)

Replace NUTS with variational inference. VI approximates the posterior with a simpler distribution (e.g. mean-field Gaussian) and may handle multimodality and funnels better than HMC.

**Pros**: Much faster. May handle the geometry issues that trip NUTS.

**Cons**: VI typically underestimates posterior variance. Normalising flows are more accurate but complex. PyMC supports ADVI natively.

### F. Marginalising out latency analytically

If the latency prior is conjugate or semi-conjugate, integrate out the latency variables analytically, reducing the effective dimensionality.

### G. Rethinking the CDF coupling

Currently, every trajectory observation at every retrieval age evaluates the full mixture CDF. Perhaps the observations could be decomposed or the coupling could be approximated in a way that's more NUTS-friendly.

### H. Block sampling / Gibbs within NUTS

Sample p variables and latency variables in alternating blocks, each conditioned on the other. PyMC doesn't natively support this, but it could be implemented manually.

---

## 7. Technical Details for Reference

### Fenton-Wilkinson composition

Approximation for the sum of independent lognormals:
```
X1 ~ LN(mu1, sigma1), X2 ~ LN(mu2, sigma2)
X1 + X2 ~ approx LN(mu_fw, sigma_fw)

e_sum = exp(mu1 + sigma1^2/2) + exp(mu2 + sigma2^2/2)
v_sum = (exp(sigma1^2) - 1)*exp(2*mu1 + sigma1^2)
      + (exp(sigma2^2) - 1)*exp(2*mu2 + sigma2^2)

sigma_fw^2 = log(1 + v_sum / e_sum^2)
mu_fw = log(e_sum) - sigma_fw^2 / 2
```

This is used to compose sequential edge latencies into a path latency. The PyTensor version (`pt_fw_chain`) is differentiable and NUTS gradients flow through it. **FW composition works fine for linear chains** -- the problem is only at join nodes where multiple composed paths meet.

### Shifted lognormal CDF

```
T = onset + LN(mu, sigma)
CDF(t) = 0.5 * erfc(-(log(max(t - onset, eps)) - mu) / (sigma * sqrt(2)))
```

In the model, `onset` is deterministic (sum of edge onsets along path), `mu` and `sigma` are latent.

### Dirichlet-Multinomial log-probability (trajectory likelihood)

For a trajectory day with denominator n, cumulative counts y_1 < y_2 < ... < y_K at retrieval ages t_1 < t_2 < ... < t_K:

```
intervals: count_i = y_i - y_{i-1}  (y_0 = 0)
remainder: count_R = n - y_K

prob_i = p * (CDF(t_i) - CDF(t_{i-1}))
prob_R = 1 - p * CDF(t_K)

DM logp = sum_i [logGamma(count_i + kappa*prob_i) - logGamma(kappa*prob_i)]
        + logGamma(kappa) - logGamma(n + kappa)
```

kappa ~ Gamma(3, 0.1) is a per-edge overdispersion parameter. Large kappa -> Binomial; small kappa -> heavy day-to-day variation.

### Model variable structure (branch graph)

```
Per edge (10 data-bearing edges):
  p_window_{edge} or p_base_{edge}    ~ Beta(alpha, beta)
  kappa_{edge}                         ~ Gamma(3, 0.1)

Per latency edge (subset with has_latency=True):
  mu_lat_{edge}                        ~ Normal(mu_prior, 0.5)
  sigma_lat_{edge}                     ~ Gamma(alpha, beta)  [mode at prior sigma]

Per multi-hop cohort path (edges with 2+ latency hops on path):
  onset_cohort_{edge}                  ~ HalfNormal(onset_prior)
  eps_mu_cohort_{edge}                 ~ Normal(0, 1)
  eps_sigma_cohort_{edge}              ~ Normal(0, 1)
  mu_cohort_{edge} = FW_composed_mu + eps_mu * tau    [Deterministic]
  sigma_cohort_{edge} = FW_composed_sigma + eps_sigma * tau  [Deterministic]

Branch group variables:
  p_dropout_{group}                    ~ Beta(1, 1)

Total: ~46 free variables
```

### Sampling configuration

```
draws: 2000, tune: 1000, chains: 4, target_accept: 0.90
Sampler: nutpie (Rust-based NUTS, faster than PyMC default)
```

### What converges fine (simple graph, no joins)

4 edges in linear chain: landing -> created -> delegated -> registered -> success

- 24 free variables
- 0 divergences
- rhat = 1.004, ESS = 1805
- Total time: ~90s (60s compile + 30s sampling)
- Latency and probability both well-identified

---

## 8. Key Questions for Reviewers

1. **Is the fundamental issue multi-modality, funnels, or gradient scale mismatch?** The symptoms (chains stuck, increasing estimated time) are consistent with several pathologies. Understanding which one dominates would guide the solution.

2. **Is there a standard approach for mixture CDFs with latent weights and latent component parameters in HMC?** This is essentially a finite mixture model where both the mixing proportions and the component parameters are latent, and the mixture appears inside a CDF evaluation in the likelihood. Is this a known-hard problem for NUTS?

3. **Would reparameterisation help?** E.g., parameterising the path-level latency directly instead of composing from edge-level latencies. Or non-centring the mixture weights.

4. **Would marginalisation help?** If we could analytically marginalise out either the latency or the probability variables at joins, the reduced posterior might be more tractable.

5. **Is variational inference (ADVI, normalising flows) a pragmatic path forward?** We're fitting ~46 variables. VI might handle the geometry better than NUTS, at the cost of some posterior accuracy.

6. **Is there a way to decompose the problem?** E.g., fit each sub-tree independently, then combine. The graph structure (tree with joins) might admit a message-passing approach.

7. **Are we over-complicating this?** The production graph has max 4-5 paths to any node. Is there a simpler formulation that handles small mixtures without the full generality of arbitrary mixture CDFs?

---

## 9. File References

| File | Purpose |
|------|---------|
| `bayes/compiler/model.py` | Model builder -- lines 105-232 (mixture DP), 649-933 (cohort likelihoods), 1033-1089 (path latency resolution) |
| `bayes/compiler/types.py` | IR dataclasses (TopologyAnalysis, EdgeTopology, JoinNode, etc.) |
| `bayes/compiler/topology.py` | Topology analysis (join detection, FW composition, path enumeration) |
| `bayes/compiler/completeness.py` | FW composition (pure Python + PyTensor versions), moment-matched collapse |
| `bayes/compiler/inference.py` | Posterior extraction |
| `bayes/compiler/evidence.py` | Evidence binding |
| `bayes/test_harness.py` | Test harness with graph configs |
| `docs/current/project-bayes/6-compiler-and-worker-pipeline.md` | Design doc (FW, joins, overdispersion) |
| `docs/current/project-bayes/8-compiler-implementation-phases.md` | Phase D design and status |

---

## 10. Summary of Attempts

| Approach | What Happened | Probable Cause |
|----------|--------------|----------------|
| **Moment-matched collapse** (differentiable, PyTensor) | rhat=2.83, ESS=5, massive divergences | Gradient scale catastrophe: exp(mu) varies 25x across components |
| **Moment-matched + log-sum-exp** (numerically stable version) | Same failure | Not a numerical issue -- the nonlinear coupling is the problem |
| **Moment-matched + warm start** (init from previous posteriors) | rhat=1.53, ESS=7 | Geometry problem, not starting point |
| **Mixture-path CDF** (carry all components, no collapse) | Timed out at 900s, stuck at 52% | Multi-chain stalling suggests multimodality or ridges in the joint p-latency posterior |
