# Doc 39: Phase 2 JAX Gradient NaN — Problem Statement

**Date**: 13-Apr-26
**Status**: Open — blocking JAX backend for Phase 2 on join-node graphs
**Impact**: 180s numba compile penalty per Phase 2 run instead of ~15s JAX
**Severity**: High — 12x slower compilation, blocks iteration speed

---

## The Problem

Phase 2 model initialisation fails with JAX backend on diamond-context
(and likely all join-node graphs with deep composed path onsets):

```
RuntimeError: All initialization points failed
— Could not initialize state because of bad initial gradient
```

The model is mathematically correct. Numba backend samples it without
issue. The numerical gradient (finite differences) is healthy (~49 and
~89 for the two affected variables). **The NaN is purely a JAX autodiff
artefact.**

---

## What We Know

### Affected variables

Exactly 2 of 75 gradient components are NaN at x=0:

| Index | Variable | Edge | Value at x=0 |
|-------|----------|------|--------------|
| 21 | `eps_onset_cohort_31c26576` | path-b-to-join | 0.0 |
| 37 | `eps_onset_cohort_395d3cb6` | gate-to-path-b | 0.0 |

Both are on **path B** of the diamond — the longer path with larger
composed onset (5.9 days and 3.9 days respectively).

### The numerical gradient is finite

```python
# At x=0, perturbing only index 21:
numerical_grad = (logp(+eps) - logp(-eps)) / (2*eps)  # = 49.04
jax_autodiff_grad = jax.grad(logp)(x0)[21]             # = NaN
```

This proves the logp surface is smooth and differentiable. The NaN
is in JAX's backward pass, not in the mathematics.

### Feature flag isolation

| Configuration | NaN count |
|--------------|-----------|
| Full model (74 free, 19 obs, 18 pot) | 2 NaN |
| `cohort_latency=False` | 0 NaN |
| `overdispersion=False` (keeps cohort_latency) | 2 NaN |
| `latency_dispersion=False` (keeps cohort_latency) | 2 NaN |
| Without join-to-outcome edge evidence | 2 NaN |
| Numba backend (any configuration) | 0 NaN |

The NaN requires `cohort_latency=True`. It does NOT require the
mixture (join-to-outcome) edge — the NaN comes from the single-path
trajectory potentials for edges 31c26576 and 395d3cb6 themselves.

### JAX `debug_nans` output

```
FloatingPointError: invalid value (nan) encountered in pad
```

The NaN originates in a `pad` operation in JAX's backward pass.
This is pytensor's compiled representation of array indexing or
concatenation being differentiated by JAX.

### The computational chain

`eps_onset_cohort` flows through:

```
eps_onset_cohort (Normal(0,1))
  → onset_cohort = softplus(ws_onset + eps × path_onset_sd)
    → _compute_cdf_at_ages(onset_cohort, mu_cohort, sigma_cohort):
        age_minus_onset = ages_tensor - onset_cohort     # negative for young ages
        effective_ages = softplus(k × age_minus_onset) / k  # ≈ 0 for age < onset
        log_ages = log(max(effective_ages, 1e-30))       # ≈ -69
        z = (log_ages - mu) / (sigma × √2)              # very negative (< -40)
        z = max(z, -25)                                  # z-clamp (our fix)
        CDF = 0.5 × erfc(-z)                            # ≈ 2.8e-278 (not 0)
      → interval decomposition:
          cdf_curr = CDF[curr_idx]                       # gather
          cdf_prev = CDF[prev_idx]                       # gather (sentinel handling)
          delta_F = cdf_curr - cdf_prev × (1 - is_first)
          ...
        → q_j = clip(p × delta_F / surv, floor, ceil)
          → log(q_j) × d_j + log(1-q_j) × (n-d_j)      # Binomial logp
```

### What we tried (all failed to fix the NaN)

1. **Z-clamp** (`z = max(z, -25)` before `erfc`): Prevents erfc
   underflow to exact 0. CDF is now 2.8e-278 instead of 0.0.
   NaN persists — the issue is not in erfc.

2. **Prepend-zero to CDF array**: Replace sentinel index -1 with a
   prepended 0.0 element. Eliminates the `prev_safe = where(idx>=0, idx, 0)`
   pattern. NaN persists.

3. **Point-to-curr for first intervals**: For first intervals, set
   `prev_idx = curr_idx` and zero contribution via numpy mask
   `(1 - is_first_np)`. The mask is a numpy constant (no gradient).
   NaN persists.

### What we did NOT try

- **Tracing the exact pytensor op that becomes `pad`**: The JAX
  `debug_nans` says "pad" but doesn't identify which pytensor node
  compiles to this pad. Needs deeper JAX/pytensor interop tracing.

- **Full log-CDF refactor**: Restructure the likelihood to work in
  log-CDF space using asymptotic series for `log(erfc)`. High risk,
  may not address the actual issue (which appears to be in `pad`,
  not `erfc`).

- **Custom JVP rule**: Register a custom JAX JVP for the problematic
  op that returns 0 gradient when the CDF is below a threshold.

- **`tfp-nightly` for `erfcx`**: Would enable PyMC's `normal_lcdf`
  (which uses `erfcx` for numerical stability). But `erfcx` might
  not be the issue.

---

## Why This Only Affects Path B

Path B has larger composed onsets:

| Edge | Composed path onset | Min trajectory age |
|------|--------------------|--------------------|
| 395d3cb6 (gate-to-path-b) | 3.9 days | 1 day |
| 31c26576 (path-b-to-join) | 5.9 days | 1 day |

Path A edges have smaller onsets (≤ 4.0 days) and don't produce NaN.
The difference is the **depth of the underflow**: at age=1 with
onset=5.9, the shifted lognormal CDF is astronomically small
(~10^{-300}), producing extreme values in the computational graph
that JAX's backward pass can't handle.

Path A at age=1 with onset=4.0 is also very small (~10^{-100}) but
apparently below JAX's NaN threshold.

---

## Root Cause Hypothesis

The NaN is NOT from `erfc` (we clamped z and it didn't help) and
NOT from the interval sentinel indexing (we tried three different
patterns). It likely comes from an **intermediate pytensor operation**
that JAX compiles into a `pad` — possibly:

1. The `softplus(k × (age - onset)) / k` computation when the
   argument is very negative (k=10, age-onset=-4.9 → softplus(-49))
2. The `log(max(softplus_result, 1e-30))` when softplus_result is
   denormalised
3. A pytensor graph rewrite that introduces a `pad` node during
   compilation, and whose backward pass has a `0 × inf` issue

The fact that numba handles this correctly suggests the issue is in
**JAX's handling of pytensor's compiled graph**, not in the
mathematical operations themselves. Numba and JAX may compile the
same pytensor graph into different low-level ops with different
gradient implementations.

---

## Reproduction

```python
import pickle, json, sys
sys.path.insert(0, '/path/to/dagnet/bayes')
sys.path.insert(0, '/path/to/dagnet/graph-editor/lib')

DUMP = '/tmp/bayes_debug-graph-synth-diamond-context'
with open(f'{DUMP}/topology.pkl', 'rb') as f:
    topo = pickle.load(f)
with open(f'{DUMP}/evidence.pkl', 'rb') as f:
    evidence = pickle.load(f)
with open(f'{DUMP}/phase2_frozen.json') as f:
    phase2_frozen = json.load(f)
with open(f'{DUMP}/settings.json') as f:
    sb = json.load(f)

from compiler.model import build_model
model2, _ = build_model(topo, evidence, features=sb['features'],
                        phase2_frozen=phase2_frozen, settings=sb['settings'])

import nutpie
compiled = nutpie.compile_pymc_model(model2, backend='jax', gradient_backend='jax')

import jax, jax.numpy as jnp
raw_fn = compiled._raw_logp_fn
def logp_scalar(x): return raw_fn(x)[0]

x0 = jnp.zeros(compiled.n_dim)
g = jax.grad(logp_scalar)(x0)
print(f'NaN count: {int(jnp.isnan(g).sum())}')  # → 2
```

Takes ~20s (model build + JAX compile). No MCMC needed.

---

## Next Steps

1. **Identify the exact pytensor node**: Use `pytensor.dprint` on
   the model's logp graph, find the node that compiles to `pad` in
   JAX, and check its gradient implementation.

2. **Minimal reproduction**: Strip the model down to just one edge
   (31c26576) with `cohort_latency=True` and find the smallest
   pytensor graph that reproduces the NaN. This eliminates noise
   from the other 73 variables.

3. **Compare pytensor JAX vs C compilation**: Compile the same logp
   graph with both backends and compare the gradient at x=0. If the
   C backend also produces NaN, the issue is in pytensor's symbolic
   gradient. If only JAX, it's in the JAX dispatch.

4. **File upstream issue**: If the NaN is in pytensor's JAX dispatch
   of a specific op (likely `AdvancedSubtensor` or `Pad`), file an
   issue on pytensor GitHub with the minimal reproduction.

---

## Current Workaround

Phase 2 falls back to numba when JAX init fails. Cost: 180s compile
(vs ~15s JAX). The `--phase2-from-dump` flag enables iteration
without re-running Phase 1.

```bash
python bayes/param_recovery.py --graph synth-diamond-context \
  --phase2-from-dump /tmp/bayes_debug-graph-synth-diamond-context \
  --feature jax_backend=true --chains 2 --draws 500 --tune 1000 --timeout 0
```
