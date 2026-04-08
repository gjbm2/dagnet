# Doc 23: Two-Phase Model Design

**Purpose**: Specification for the two-phase (window → cohort) model
architecture. Replaces the single-pass p_base/p_window/p_cohort
hierarchy which creates inconsistent Hamiltonians in NUTS.

**Status**: Phase 1 likelihood rewrite complete (27-Mar-26).
DM→Binomial, BB→Binomial, onset obs, t95 constraint. Synth clean.
Production del-to-reg 1.94x→1.19x. Phase 2 needs stabilisation.

---

## 1. Problem Statement

The single-pass model shares `p_base` between window and cohort
likelihoods:

```
p_base  ← shared Beta RV
p_window = sigmoid(logit(p_base) + eps_w × tau_w)
p_cohort = sigmoid(logit(p_base) + eps_c × tau_c)
```

Cohort likelihoods constrain `p_base` through path products. The
`stop_p_gradient` mechanism blocks gradient but not log-probability,
creating an inconsistent Hamiltonian (dlogp says p is prior-only,
logp includes cohort terms). NUTS requires consistent (logp, dlogp)
pairs. Result: corrupted posterior, p inflation up to 10x on
production data. See Plummer 2015, Carmona & Nicholls 2025.

## 2. Solution: Two Separate MCMC Passes

### 2.1 Phase 1 — Window Pass

**Purpose**: Determine edge.p and edge.latency from window data only.

**Free variables**:
- `p` per edge (Beta prior, k/n-derived or neutral)
- `mu_lat`, `sigma_lat` per latency edge
- `onset` per latency edge
- `kappa` per edge (overdispersion)

**Data**:
- Window trajectories (latency edges) → DM potential
- Window daily obs (no-latency edges) → BetaBinomial
- No cohort trajectories

**Topology**:
- Dirichlet/Multinomial for branch groups (split constraints)
- Path products at join-downstream edges (gradient flows freely)

**Key properties**:
- All gradient flows freely — consistent Hamiltonian
- No p_base/p_window/p_cohort hierarchy
- No sigma_temporal
- Window is sole authority on edge.p

**Output**: posterior means for edge.p, edge.latency (mu, sigma,
onset) per edge.

### 2.2 Phase 2 — Cohort Pass

**Purpose**: Determine cohort-specific quantities (drift, dispersion,
path-level latency) using frozen Phase 1 edge values.

**Relationship between edge and path quantities**:

```
edge.p  ──(product along path, drift in p)──→  path.p
  ↕                                               ↕
edge.latency ──(convolution, drift in latency)──→ path.latency
```

- `edge.p` and `edge.latency`: frozen constants from Phase 1
- `path.p`: derived from ∏(edge.p_i) with per-edge drift
- `path.latency`: derived from convolution of edge latencies with
  drift (cohort_latency_vars)

Path.p and path.latency are NOT free variables. They are
distributions derived from Phase 1 frozen values, characterised by
their drift and dispersion.

**Free variables**:
- `eps_drift` per edge: drift in p (per-edge, non-centred)
  `logit_p_cohort = logit(p_frozen) + eps_drift × tau_drift`
  `p_cohort = sigmoid(logit_p_cohort)`
  `tau_drift` small (e.g. `path_sigma_ax` or 0.1)
- `onset_cohort`, `mu_cohort`, `sigma_cohort` per path edge:
  drift in latency (cohort-level, non-centred around FW-composed
  frozen edge latency)
- `kappa` per edge (overdispersion)

**Data**:
- Cohort trajectories only → DM potential
- No window trajectories (Phase 1 handles those)

**Topology**:
- Dirichlet at branch groups: constrains `p_cohort` siblings for
  mass conservation (cohort split ratios may differ from window
  due to drift, but must still conserve mass)
- Joins: path products use `p_cohort` values → mixture at join
  nodes. Gradient flows to drift parameters, not to edge.p.

**Key properties**:
- edge.p is a constant — no gradient, no coupling to Phase 1
- Drift allows cohort rates to differ systematically from window
- Kappa handles day-to-day random variation (separate from drift)
- Dirichlet ensures mass conservation for drifted split ratios
- Consistent Hamiltonian (all free variables have matching logp
  and dlogp)

**Output**: cohort-specific p (drift-adjusted), cohort latency,
kappa per edge.

## 3. Why Per-Edge Drift (Not Per-Path)

Three options were considered:

| Option | Parameters | Pros | Cons |
|---|---|---|---|
| Per-edge drift | N_edges | Parsimonious, interpretable | Assumes drift is edge-local |
| Per-path drift | N_paths | Can capture path-specific selection | Many parameters, identifiability |
| Kappa absorbs | 0 extra | Simplest | Conflates systematic + random |

Per-edge drift is recommended: the selection effect at X→Y is a
property of that edge regardless of path. It's structurally identical
to the old `p_cohort` perturbation but with `p_frozen` as a constant
instead of a shared `p_base`. The coupling is broken by the phase
boundary, not by gradient tricks.

## 4. No-Latency Edge Routing

Edges without latency (onset=0, sigma=0) have no maturation curve.
All observations are logically (n, k) binomial draws regardless of
retrieval count. The evidence binder's routing (≥2 retrievals →
trajectory, 1 → daily obs) is an artefact of fetch frequency for
these edges.

**Fix**: in `_emit_cohort_likelihoods`, detect no-latency edges and
convert window trajectories to daily obs → BetaBinomial. This avoids
the DM fallback (sigma=0.01, CDF(1d)=0.5) which distorts the
likelihood.

## 5. Post-Maturation Trajectory Dedup

Production data includes old anchor days with 2 snapshot rows at
high ages (e.g. ages [75, 77]) where y is identical — conversion
completed long ago. The zero-count dedup filter had a guard
(`len >= 4`) and unconditional `keep[-1]` that preserved these as
2-point trajectories.

**Fix**: remove the `len >= 4` guard, remove unconditional
`keep[-1]`. Flat trajectories collapse to single points → daily obs.
This prevents the p-latency degeneracy where flat post-maturation
trajectories are compatible with both (low p, fast latency) and
(high p, slow latency).

## 6. Progress and Logging

Two-phase runs report progress for each phase:
- Phase 1: compiling → sampling → diagnostics
- Phase 2: compiling → sampling → diagnostics
- Each phase has its own compilation step (PyTensor graph)
- Timing reported per phase in the result log

## 7. Implementation Checklist

- [x] Phase 1: remove p_base/p_window/p_cohort hierarchy
- [x] Phase 1: remove sigma_temporal
- [x] Phase 1: single p per edge, skip_cohort_trajectories=True
- [x] Phase 1: no-latency edge BetaBinomial routing
- [x] Phase 1: post-maturation trajectory dedup fix
- [x] Phase 1: neutral_prior feature flag
- [ ] Phase 2: per-edge drift (eps_drift × tau_drift)
- [ ] Phase 2: Dirichlet on p_cohort for mass conservation at splits
- [ ] Phase 2: cohort trajectories only (no window)
- [ ] Phase 2: frozen edge.p and edge.latency from Phase 1
- [ ] Phase 2: cohort_latency_vars (free, priors from FW-composed frozen)
- [ ] Phase 2: progress indicators per phase
- [ ] Phase 2: merge cohort posteriors into Phase 1 results
- [ ] Phase 2: inference.py handles Phase 2 trace (no p in trace)
- [ ] Test: synth-mirror-4step param recovery (both phases)
- [ ] Test: production graph (both phases)
- [ ] Test: synth-fanout-test (split topology)
- [ ] Journal: results in 18-compiler-journal.md

## 8. Open Defect: Drift at Branch Groups

The current Phase 2 implementation treats branch group edges and solo
edges differently for drift:

- **Solo edges**: per-edge `eps_drift × tau_drift` applied to
  `logit(p_frozen)` → `p_cohort`. Correct.
- **Branch group edges**: Dirichlet with concentrations centred on
  Phase 1 frozen p values. The Dirichlet allows the allocation to
  shift, but there is NO explicit per-edge drift parameter. The
  Dirichlet concentration acts as an implicit drift mechanism, but
  it's not the same parameterisation and doesn't allow the same
  granularity of control.

**The problem**: branch group edges should ALSO have per-edge drift.
The selection effects that cause cohort p to differ from window p
apply equally to branch group edges. The Dirichlet should enforce
mass conservation on the DRIFTED values, not replace the drift
mechanism entirely.

**Possible fix**: apply per-edge drift to get `p_cohort_i` for each
sibling, then use a Dirichlet-like soft constraint to ensure
`Σ p_cohort_i ≤ 1`. Or: use the drifted p values as Dirichlet
concentrations (with small kappa for loose constraint). Needs
careful thought about the parameterisation — the drift eps and the
Dirichlet draw are competing to control the same quantity.

**For now**: the production test graph has simple branch groups
(1 evented edge + 1 dropout), so the Dirichlet with Phase 1
concentrations is adequate. The defect matters for complex
topologies (fan-out, diamond) where multiple evented siblings
compete.

---

## 9. Phase 2 Defects Found and Fixed (26-Mar-26)

| # | Defect | Effect | Fix |
|---|---|---|---|
| 1 | Branch group Multinomial ran in Phase 2 | Window data constrained cohort p | Guard with `if not is_phase2` |
| 2 | No-latency window traj→daily ran in Phase 2 | Window data leaked as BetaBinomial | Guard with `p_window_var is not None` |
| 3 | `stop_p_gradient=True` hardcoded for cohort | Cohort DM couldn't constrain p_cohort | Conditional on phase |
| 4 | cohort_latency_vars skipped for 1-latency paths | Frozen wrong latency, no free adjustment | Allow in Phase 2 |
| 5 | cohort_latency tau=0.1 (tight non-centred) | Can't escape frozen garbage latency | Wide independent priors in Phase 2 |
| 6 | Window trajs collected for cohort DM in Phase 2 | Window potentials in Phase 2 model | Skip when p_window_var is None |
| 7 | Dirichlet kappa=10 too small for low-p | Mode at 0.03 instead of 0.13 | Scale kappa so min(α) > 2 |

| # | Defect | Effect | Fix |
|---|---|---|---|
| 8 | `_resolve_path_probability` searched for `p_window_` in Phase 2 | Path product silently omitted upstream edges → potentials had no free vars → 0 potentials in model | Search `p_cohort_` first regardless of phase |
| 9 | Cohort daily obs dropped for no-latency edges | No-latency edges' p_cohort unconstrained in Phase 2 (prior only) | Add cohort daily to BetaBinomial for first-edge; downstream constrained via path products |

After all fixes, synth Phase 2 (neutral priors):

| Edge | Truth | Phase 2 p_cohort | Ratio |
|---|---|---|---|
| landing-to-created | 0.180 | 0.181 | 1.01x |
| created-to-delegated | 0.551 | 0.607 | 1.10x |
| delegated-to-registered | 0.110 | 0.240 | 2.18x |
| registered-to-success | 0.697 | 0.773 | 1.11x |

Phase 2 converges (rhat=1.002, ess=1777). Three of four edges
recover within ~10%. delegated-to-registered remains inflated at
2.18x — the p-latency degeneracy.

---

## 10. DM Bias on Low-p Edges (the 1.3x problem)

### The problem

The DM interval term `gammaln(count + α) - gammaln(α)` increases
monotonically with α for any count > 0. Since α = κ × p × ΔCDF,
higher p → higher α → higher interval logp, even when the expected
count overshoots the observed. The ONLY penalty for higher p is the
remainder term (lower α_R), but when n >> y (low-p edges), the
remainder is insensitive to p changes.

Verified numerically: for delegated-to-registered (p=0.11, n≈158),
the DM logp at posterior (p=0.143, sigma=0.92) is 0.6 nats higher
than at truth (p=0.11, sigma=0.57). The interval terms gain +12.4
nats while the remainder loses only -11.8 nats.

This bias is worse for low-p edges (y/n small → remainder dominates)
and absent for high-p edges (y/n large → balanced). This explains
why the Phase S test (p=0.35) passes but production (p=0.095) fails.

### Attempted fix: mature-point BetaBinomial anchor

Added BetaBinomial at mature ages (CDF≈1.0) alongside the DM.
Result: Phase 1 improved from 1.30x to 1.13x. But this is
mathematically unsound — double-counting the same data in two
likelihood terms corrupts the posterior. Reverted.

### Correct fix: conditional decomposition

The DM can be decomposed into two orthogonal parts:

1. **Shape** (conditional Multinomial given total y): how are the
   y conversions distributed across age intervals? Constrains the
   CDF shape (latency) only. Does NOT depend on p.

   ```
   logp_shape = DM(counts | total=y, probs=ΔCDF/CDF_final, κ_shape)
   ```

2. **Rate** (marginal BetaBinomial): out of n people, y converted.
   Constrains p × CDF_final only. Does NOT depend on CDF shape.

   ```
   logp_rate = BetaBinomial(n, y, p·CDF_final·κ_rate, (1-p·CDF_final)·κ_rate)
   ```

This decomposition eliminates the p-latency tradeoff: the shape
constrains latency without p involvement, and the rate constrains
p without latency shape involvement. Standard in categorical data
analysis (conditional + marginal factorisation).

### Why the decomposition doesn't lose information

Concern: with immature data (curve still rising, CDF_final << 1),
can the model still jointly infer p and latency?

Yes. Both terms share the same latency variables in the same MCMC:

1. Shape term sees conversions concentrated at ages 3-5 → constrains
   latency (onset, mu, sigma)
2. Given that latency, CDF_final at the observation horizon is
   determined (e.g. 0.40 at age 5)
3. Rate term sees y_total out of n → constrains p × CDF_final →
   p ≈ y_total / (n × CDF_final)

The information flows: shape → latency → CDF_final → rate → p.
When NUTS proposes a new latency, it changes BOTH the shape logp
AND the rate logp (through CDF_final). The posterior over
(p, latency) is computed jointly.

The difference from the joint DM: the DM lets each age bin pull p
directly (the bias). The decomposition only lets bins pull latency,
which influences p through CDF_final. This is the correct
information flow — shape tells timing, timing tells completeness,
completeness tells p.

### Why the BetaBinomial rate term doesn't have the same bias

In the joint DM, ~8 interval bins each have their own
`gammaln(count_j + α_j) - gammaln(α_j)` term. Each independently
pulls α upward → higher p. The single remainder term pulls down.
Eight up vs one down → upward bias for low-p edges.

In the rate BetaBinomial, all conversions collapse to ONE count
(k=17). One term pulls up (k=17, α=κ×p×CDF), one pulls down
(n-k=983, β=κ×(1-p×CDF)). The downward pull wins because 983>>17.
The multi-bin amplification is eliminated.

### Results with conditional decomposition

| Approach | Phase 1 deleg-to-reg ratio |
|---|---|
| Original joint DM | 1.30x |
| Shape+rate, shared κ | 1.19x |
| Shape+rate, separate κ (loose prior) | 1.23x |
| Shape+rate, separate κ (tight prior) | 1.17x |

Improvement from 1.30x to 1.17x confirms the decomposition helps
but doesn't fully solve the problem. The remaining bias comes from
immature trajectories where CDF_final < 1 allows p × CDF_final to
trade off.

---

## 11. Sequential BetaBinomial (Discrete Hazard) Formulation

Based on cure model literature review (Maller & Zhou 1996, Chen
Ibrahim & Sinha 1999, Bender et al 2021).

### The formulation

Replace the DM (or shape+rate decomposition) with interval-by-
interval binomials:

```
Interval [t_{j-1}, t_j):
  at_risk = n - y_{j-1}   (people who haven't converted yet)
  Δy = y_j - y_{j-1}      (new conversions in this interval)
  Δy ~ BetaBinomial(at_risk, κ×h_j, κ×(1-h_j))
```

where h_j is the discrete hazard. For the mixture cure model:

```
h_j = p × ΔF_j / (1 - p × F_{j-1})
```

The hazard has p in BOTH numerator and denominator. As conversions
accumulate, the denominator (1 - p × F) shrinks, naturally
penalising higher p through risk set depletion.

### Why this eliminates the bias

At mature intervals (F ≈ 1): h_j ≈ 0, at_risk = n - y_final. The
risk set size directly tells the model how many will NEVER convert.
This pins p without any CDF shape involvement.

At active intervals: h_j jointly constrains p and latency through
the hazard shape. Each interval is penalised independently — no
multi-bin amplification of the DM α bias.

### Key advantage over shape+rate decomposition

The sequential formulation uses the ORDERING of conversions across
intervals. If early intervals show high hazard and late intervals
show zero hazard, the model can distinguish (correct p, correct
latency) from (high p, slow latency). The shape+rate decomposition
aggregates this into total count + shape — losing the sequential
depletion signal.

### Downside

Harder to vectorise (each interval depends on previous through
at_risk). But with ~5-15 intervals per trajectory, a loop over
intervals vectorised across trajectories is feasible.

---

## 12. Promotion Time Parameterisation

Instead of p (cure fraction) directly, use θ (promotion rate):

```
θ = -log(1 - p)      →  p = 1 - exp(-θ)
S_pop(t) = exp(-θ × F(t))
```

Benefits:
- θ ∈ (0, ∞): unconstrained, good for HMC/NUTS
- The exp link makes the p-latency coupling NONLINEAR instead of
  multiplicative, curving the ridge in the likelihood surface
- The hazard becomes h_j = 1 - exp(-θ × ΔF_j), which is
  well-behaved for small ΔF
- Log-normal or Normal prior on log(θ) is mildly informative
  toward moderate cure fractions

Can be combined with the sequential BetaBinomial: use promotion
time hazard instead of mixture hazard in each interval.

---

## 13. PC Prior on Sigma (Penalised Complexity)

The residual p inflation comes from sigma inflating (CDF too
dispersed). A PC prior (Simpson et al 2017) penalises deviation
from the base model (all conversions at onset):

```
sigma ~ Exponential(λ)
```

Calibrate: P(sigma > σ_max) = α. For our data, σ_max ≈ 2.0 and
α = 0.01 gives λ = -log(0.01)/2.0 ≈ 2.3.

This directly attacks the sigma-inflation mechanism without
constraining p.

---

## 14. Implementation Plan

1. Replace DM with sequential BetaBinomial (discrete hazard)
2. Use promotion time parameterisation (θ instead of p)
3. Add PC prior on sigma
4. Test on synth-mirror-4step with neutral priors
5. Compare against baseline (joint DM: 1.30x, shape+rate: 1.17x)

### Results (26-Mar-26)

| Approach | Phase 1 deleg-to-reg | Notes |
|---|---|---|
| Original joint DM | 1.30x | Baseline |
| Shape+rate, shared κ | 1.19x | Best decomposition |
| Shape+rate, separate κ (tight prior) | 1.17x | **Best overall** |
| Sequential BB (discrete hazard) | 1.30x | No improvement |
| Sequential BB + PC prior on sigma | 1.28x | Marginal |

**Finding**: the sequential BetaBinomial doesn't help for window
trajectories at n≈158. The logp check shows truth beats posterior
by only 0.5 nats — enough in principle but not enough signal
relative to the prior and other model terms. The shape+rate
decomposition at 1.17x remains the best approach.

**Key insight from logp analysis**: the sequential BB still has the
bias when n >> y (anchor-denominator cohort). It only helps for
window-scale denominators (n≈158). But at that scale, the original
DM was already manageable. The shape+rate decomposition works better
because it structurally separates p from the CDF shape, rather than
relying on the hazard's p/(1-pF) ratio to provide the penalty.

**Current status**: reverting to shape+rate decomposition with
separate kappas (tight prior) as the production approach.
Delegated-to-registered at 1.17x with neutral priors — acceptable
given the data. With k/n priors it should be closer to 1.0x.

**Status**: stabilising (26-Mar-26).

---

## 11. Known Residual Issues

**1.3x → 1.19x on del-to-reg (27-Mar-26)**: resolved from 1.94x to
1.19x via: (a) DM→Binomial likelihood, (b) BB→Binomial for daily obs,
(c) per-retrieval onset observations from Amplitude, (d) t95 soft
constraint from analytics pass. Remaining 1.19x is genuine tension
between trajectory data (sparse coverage of full maturation curve in
production) and analytic-derived constraints.

**Bimodal latency edges (registered-to-success)**: some edges have
genuinely bimodal conversion timing — a fast cluster of early
conversions, then a lull, then the bulk arrives more slowly. The
shifted log-normal is unimodal and cannot represent this. The model
compensates by starting early and rising too gradually, which
overstates completeness in the 10–30d range for immature cohorts.
p and onset still converge well; the CDF shape error is bounded but
real.

## 12. Future Work: Mixture Latency Models

Some edges (e.g. registered-to-success on the prod graph) show
clearly bimodal conversion timing that a single shifted log-normal
cannot fit. A mixture of two log-normals would handle this:

```
CDF(t) = w × CDF_fast(t | onset_1, mu_1, sigma_1)
       + (1-w) × CDF_slow(t | onset_2, mu_2, sigma_2)
```

Per edge: 7 parameters (w, onset_1, mu_1, sigma_1, onset_2, mu_2,
sigma_2) vs 3 for the single log-normal. This should be opt-in per
edge — most edges are unimodal and don't need the complexity.

**Detection**: bimodality can be detected from the Amplitude lag
histogram (bimodal test, or Hartigan's dip test on the histogram
bins). Edges flagged as bimodal would automatically get the mixture
model.

**Implementation considerations**:
- The trajectory Binomial likelihood generalises naturally: q_j uses
  the mixture CDF instead of the single CDF. No structural change.
- The onset/t95 constraints apply to the mixture's overall CDF.
- Identifiability: needs enough data to separate the two components.
  The fast cluster and slow bulk are visually distinct on
  registered-to-success, so identification should be feasible.
- Context slices (future): each context may have different mixing
  weights, allowing the model to capture population heterogeneity.

**Priority**: medium. The single log-normal gives acceptable p and
onset for bimodal edges. The CDF shape error matters most for
completeness derivation on immature cohorts. Address when the core
model (DM→Binomial, onset obs, t95) is stabilised.
