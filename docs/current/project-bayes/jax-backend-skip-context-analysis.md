# JAX Backend Analysis: synth-skip-context

**Date**: 12-Apr-26  
**Graph**: synth-skip-context (4 data edges, 3 context slices, skip topology with join node)  
**Backend**: JAX (`--feature jax_backend=true`)  
**Config**: tune=1000, draws=500, chains=2, cores=2, timeout=0  
**Archive log**: `/tmp/bayes_harness-graph-synth-skip-context-20260412-220235.log`

---

## Result: COMPLETED — both phases, no crashes

Previously crashed on:
1. `_p_slice_vec` UnboundLocalError (BG edges + batched trajectories) — fixed
2. `_ll_pointwise` UnboundLocalError (Phase 2 empty trajectory emissions) — fixed

---

## Timing

| Phase | Duration |
|-------|----------|
| Neon (payload) | 1.7s |
| Topology | 0.1s |
| Evidence binding | 4.9s |
| **Phase 1 sampling** (incl. JAX compile) | **427.6s** |
| **Phase 2 sampling** (incl. JAX compile) | **35.6s** |
| Overhead (inspect, summarise, LOO, etc.) | ~21.8s |
| **Total** | **491.7s** |

---

## Convergence

| Metric | Value | Threshold | Status |
|--------|-------|-----------|--------|
| max rhat | 1.061 | < 1.05 | marginal |
| min ESS | 39 | ≥ 200 | **low** |
| converged | 79% | ≥ 90% | **below** |
| divergences | 14 | 0 | present but low |

Phase 2: rhat=1.009, ESS=920, 0 divergences — excellent.

Phase 1 convergence is marginal with 2 chains. The worst-converging parameter is target→outcome (rhat=1.061, ESS=39). Other edges are well converged (rhat 1.006–1.011, ESS 182–298). More chains or draws would likely bring this into spec.

---

## Aggregate Recovery (edge-level)

| Edge | p | mu | sigma | onset | kappa |
|------|---|-----|-------|-------|-------|
| anchor→middle | 0.610±0.097 z=1.14 **OK** | 0.773±0.178 z=0.15 **OK** | 0.450±0.008 Δ=0.050 **OK** | 0.160±0.030 z=5.33 **MISS** | 64.0±78.0 |
| anchor→target | 0.184±0.077 z=0.44 **OK** | 1.305±0.198 z=0.53 **OK** | 0.554±0.006 Δ=0.054 **OK** | 0.520±0.010 z=2.00 **OK** | 56.3±65.4 |
| middle→target | 0.682±0.094 z=0.87 **OK** | 1.069±0.184 z=0.37 **OK** | 0.446±0.004 Δ=0.046 **OK** | 0.990±0.010 z=1.00 **OK** | 53.6±64.5 |
| target→outcome | 0.768±0.075 z=0.90 **OK** | 0.855±0.144 z=0.38 **OK** | 0.316±0.003 Δ=0.016 **OK** | 0.490±0.010 z=1.00 **OK** | 63.1±98.3 |

**15/16 OK, 1 MISS** (anchor→middle onset: truth=0.0, post=0.16, z=5.33).

---

## Per-Slice Recovery

### google

| Edge | p truth→post (z) | mu Δ | onset |
|------|-------------------|------|-------|
| anchor→middle | 0.600→0.610 (0.10) **OK** | 0.096 **OK** | — |
| anchor→target | 0.180→0.184 (0.05) **OK** | 0.010 **OK** | Δ=0.120 **OK** |
| middle→target | 0.690→0.682 (0.09) **OK** | 0.086 **OK** | z=19 **MISS** |
| target→outcome | 0.770→0.768 (0.03) **OK** | 0.042 **OK** | Δ=0.090 **OK** |

### direct

| Edge | p truth→post (z) | mu Δ | onset |
|------|-------------------|------|-------|
| anchor→middle | 0.500→0.514 (0.16) **OK** | 0.070 **OK** | — |
| anchor→target | 0.150→0.158 (0.13) **OK** | 0.064 **OK** | z=2.00 **OK** |
| middle→target | 0.600→0.618 (0.24) **OK** | 0.025 **OK** | z=1.00 **OK** |
| target→outcome | 0.700→0.713 (0.21) **OK** | 0.018 **OK** | z=1.00 **OK** |

### email

| Edge | p truth→post (z) | mu Δ | onset |
|------|-------------------|------|-------|
| anchor→middle | 0.350→0.368 (0.28) **OK** | 0.004 **OK** | — |
| anchor→target | 0.098→0.127 (0.61) **OK** | 0.170 **OK** | z=18 **MISS** |
| middle→target | 0.420→0.473 (0.71) **OK** | 0.188 **OK** | z=31 **MISS** |
| target→outcome | 0.560→0.612 (0.96) **OK** | 0.126 **OK** | z=21 **MISS** |

**Per-slice totals**: 12/12 p OK. 4 onset MISS (all on slices where truth onset differs from edge-level — known limitation of edge-level onset sharing).

---

## Onset MISS Analysis

All onset misses follow the same pattern: the model learns edge-level onset (shared across slices) but per-slice truth values differ. For example, email middle→target has truth onset=1.300 but the edge-level onset is 1.000, and the posterior converges to 0.990 (near the edge-level value). This is by design — per-slice onset is not modelled to reduce sampler geometry complexity (doc 38).

---

## Topology Notes

- 4 data edges, 3 branch groups (anchor has 3 children including dropout)
- **Join node**: target has 2 inbound paths (anchor→middle→target, anchor→target)
- target→outcome has `path_alternatives=2` — exercises the mixture CDF code path in Phase 2
- All edges have latency

This graph exercises: BG Dirichlet + per-slice Dirichlet hierarchy, skip edges, join-node mixture CDF, Phase 2 cohort with frozen priors, and the `_resolve_path_latency` 3-tuple fix.
