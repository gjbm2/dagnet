# Doc 23: Two-Phase Model Design

**Purpose**: Specification for the two-phase (window → cohort) model
architecture. Replaces the single-pass p_base/p_window/p_cohort
hierarchy which creates inconsistent Hamiltonians in NUTS.

**Status**: Implementing (26-Mar-26)

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

After fixes 1-7, registered-to-success cohort p recovered to 0.760
(analytic 0.700, 1.09x). delegated-to-registered improved but still
off (0.060 vs 0.113). No-latency edges still wrong (landing 0.191
vs 0.147, created 0.314 vs 0.559).

---

## 10. Known Residual Issues

**1.3x inflation on 3rd-hop latency edge**: both synth and prod show
~1.3x on delegated-to-registered with neutral priors in Phase 1.
This is a window-only p-latency geometry issue, not a data or
hierarchy issue. Separate investigation needed — not addressed by
Phase 2.
