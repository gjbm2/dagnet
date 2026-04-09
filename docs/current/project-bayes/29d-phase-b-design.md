# Phase B — Multi-Hop Cohort Maturity: Upstream x Provider

**Date**: 9-Apr-26
**Status**: Design outline (pre-implementation)
**Depends on**: Phase A (doc 29c) — span kernel and x_provider
interface must be implemented first
**Companion docs**:
- Phase A design: `29c-phase-a-design.md`
- Operator algebra + stress tests: `29b-span-kernel-operator-algebra.md`
  (live companion — 16 stress cases, plus the DAG-cover planner design
  in §3 which is the reference for Policy B's upstream cover problem)

---

## 1. What Phase B Does

Phase B replaces the denominator model. It swaps the Phase A
x_provider implementation for a proper anchor-to-x propagation solve,
and introduces completeness-adjusted frontier conditioning.

**One sentence**: given anchor population a_pop, compute how cohort
mass arrives at x over time by recursively propagating through the
upstream DAG using available evidence and model operators.

### What Phase B does NOT do

- Does not change the span kernel (K_{x→y} from Phase A)
- Does not change the row builder structure (composition layer from
  Phase A)
- Does not change evidence frame composition (Phase A)

The interface is clean: Phase B only swaps the x_provider
implementation. Everything downstream of x_provider is untouched.

---

## 2. Notation

Same as Phase A (doc 29c §2): a = anchor, x = query start, y = query
end, u = last edge's source (legacy only).

---

## 3. The Upstream Problem

### 3.1 What Phase A leaves approximate

When x ≠ a in cohort() mode, Phase A's x_provider uses:
- Observed x from evidence frames up to tau_observed
- Carry-forward beyond tau_observed

This is adequate when x is mostly mature by tau_observed (well
upstream of y). It breaks down when:
- x is deep in the funnel (long a→x path, significant latency)
- The frontier is young (tau_observed is small relative to a→x
  latency)
- The upstream DAG has branching with different latency profiles

### 3.2 Asymmetry with subject

The upstream side and subject side are **not the same problem** (see
doc 29b §9):

- **Subject** (x→y): true operator-cover problem. Must tile the full
  DAG with operators and compose them. Always required for multi-hop.

- **Upstream** (a→x): much thinner problem. Decomposes into:
  1. Latency carrier — temporal shape of arrivals at x
  2. Mass policy — scale of arrivals at x

The latency carrier is usually available from ingress blocks at x
(Phase A already uses this). The mass policy is where Phase B adds
value.

---

## 4. Evidence-Driven Upstream Propagation (Policy B)

### 4.1 Core idea

Use snapshot evidence at each edge in the upstream sub-graph to
reconstruct observed arrivals at x over tau. Walk upstream recursively,
sum at joins, propagate forward.

### 4.2 Resolution order

**Policy B is preferable where k(τ) evidence exists across the fully
recursed upstream sub-graph. Where it does not, fall back to Policy A.**

1. **x = a**: no upstream problem. X_x = a_pop(s). Done. (Same as
   Phase A — this case never reaches Phase B.)

2. **x ≠ a, full upstream evidence available**: k(τ) observed at every
   edge in G_up for the relevant cohort window. Use Policy B:
   reconstruct X_x(τ) from upstream snapshot evidence recursively.

3. **x ≠ a, partial or missing upstream evidence**: fall back to
   Policy A (reach × F_{a→x}(τ) from Phase A §6.4).

### 4.3 Algorithm

Build G_up = closure(a→x). This is the same DAG-cover problem
described in doc 29b §3 (two-pass planner), applied to the upstream
regime. The planner's admissibility rules, block preference ordering,
and cover solving apply here.

For each edge in G_up, retrieve the cohort() snapshot X field (a-cohort
arrivals at the edge's from-node by retrieved_at). These are observed
values, not model outputs.

Propagate through the DAG:
1. Start at a: X_a(s, τ) = a_pop(s) for all τ
2. For each node v in topological order after a:
   X_v(s, τ) = Σ_{edges u→v} observed_Y_{u→v}(s, τ)
   where observed_Y is the y field from the cohort() snapshot for
   edge u→v
3. At fan-in nodes: sum contributions from all incoming edges
4. Result: X_x(s, τ) from observed evidence

Beyond the evidence frontier (τ > tau_observed for the upstream
edges): use the operator model. Apply the same DP as Phase A's span
kernel (§5.3), but over G_up instead of G_sub, starting from the
frontier state rather than a unit impulse.

### 4.4 Evidence completeness check

Before choosing Policy B, verify that evidence covers G_up:
- Every edge in G_up has cohort() snapshot rows for the query's anchor
  and cohort window
- Coverage spans the relevant tau range (at least to tau_observed of
  the subject analysis)

If any edge lacks evidence, the recursive propagation has a gap. Fall
back to Policy A for the entire upstream regime (do not mix policies
within a single regime — partial evidence + partial model creates
accounting ambiguity at the seams).

---

## 5. Completeness-Adjusted Frontier Conditioning

### 5.1 The Phase A approximation

Phase A's frontier update:
`β_post = β₀ + (x_obs − y_obs)`

This treats all x-arrivals not yet at y as failures. For multi-hop,
many are in transit. The bias is conservative (underestimates rate).

### 5.2 Phase B fix

Use completeness-adjusted exposure:

```
x_effective(s) = Σ_u ΔX_x(s, u) · K_{x→y}(tau_obs − u) / span_p
```

This is the expected number of x-arrivals that have had enough time
to reach y by tau_observed, adjusted for the kernel's temporal shape.
Arrivals that entered x recently (large u, small tau_obs − u) haven't
had time to traverse x→y and shouldn't count as full trials.

Update:
```
α_post = α₀ + y_obs
β_post = β₀ + (x_effective − y_obs)
```

This removes the in-transit bias. The posterior rate is higher (more
accurate) because x_effective < x_obs when the kernel has significant
latency.

### 5.3 Requirement

Completeness-adjusted conditioning requires the span kernel K_{x→y}
from Phase A and the ΔX_x arrival profile from the x_provider. Both
are already available — Phase B only uses them in the frontier update,
not in new computation.

---

## 6. Improved MC Uncertainty (Phase B+)

Two potential enhancements beyond the core Phase B work:

### 6.1 Prior composition via method-of-moments

Instead of using last edge's posterior_path_alpha/beta:
- Compute span_p from the kernel
- Estimate span-level rate uncertainty from per-edge posterior SDs
  (propagated through the convolution)
- Derive α₀, β₀ via method of moments: κ = span_p(1−span_p)/σ² − 1

More principled. Only matters when the span has significantly
different rate uncertainty than the last edge alone.

### 6.2 Per-draw kernel reconvolution

Instead of using last edge's path SDs for latency-shape draws:
- For each MC draw, independently perturb each edge's (mu, sigma,
  onset) from their posterior distributions
- Reconvolve the kernel per draw
- Cost: O(num_draws × |E| × max_tau²)

Correct treatment of span uncertainty. Expensive but parallelisable.
Only matters for wide spans with many edges where cross-edge
uncertainty compounds.

---

## 7. Implementation Outline

Phase B is not yet scheduled. This section captures the known scope.

### 7.1 Prerequisites

- Phase A complete and parity-proven
- x_provider interface established (Phase A §6)

### 7.2 Scope

| Component | Work |
|-----------|------|
| Evidence completeness checker | New: verify G_up coverage |
| Recursive upstream propagator | New: walk G_up, use snapshot X/Y fields |
| x_provider Policy B implementation | New: swap in recursive propagator |
| Completeness-adjusted frontier update | Modify: change β_post formula |
| Policy A fallback | Existing: retain for incomplete evidence |

### 7.3 Acceptance criteria

1. **Policy B parity with Policy A**: When upstream evidence is
   complete and the graph is a single edge (x adjacent to a), Policy B
   produces identical X_x to Policy A.

2. **Multi-hop upstream correctness**: For a multi-hop a→x path with
   full evidence, X_x(τ) from Policy B matches the observed x values
   from snapshot data.

3. **Frontier conditioning improvement**: For multi-hop spans, the
   completeness-adjusted posterior rate is higher than the Phase A
   rate (less conservative bias from in-transit arrivals).

4. **Graceful fallback**: When evidence is incomplete, x_provider
   falls back to Policy A without error. The chart is produced with
   the approximation documented.

---

## 8. Relationship to Broader Forecast Engine

Phase B completes the multi-hop story for cohort maturity. After
Phase B:

- Subject regime: fully solved (Phase A span kernel)
- Upstream regime: evidence-driven where possible, model-based
  fallback (Phase B x_provider)

The broader forecast engine (Phases 0–6 in doc 29) generalises both
for all consumers. Phase B's x_provider becomes the denominator
component of the forecast-state contract. Phase A's span kernel
becomes the numerator component.

| Phase | Delivers | Interface |
|-------|----------|-----------|
| **A** | Span kernel + x_provider interface | K_{x→y}(τ), x_provider(s, τ) |
| **B** | Evidence-driven x_provider | Swaps x_provider implementation |
| **0–6** | Generalised forecast engine | Consumes both via forecast-state contract |
