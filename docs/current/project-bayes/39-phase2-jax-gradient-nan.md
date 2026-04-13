# Doc 39: Phase 2 JAX Gradient NaN — Root Cause and Fix

**Date**: 13-Apr-26
**Status**: Resolved — fix applied 13-Apr-26
**Impact**: Was 180s numba compile penalty per Phase 2 run; now ~31s JAX
**Severity**: Was High — now resolved

---

## The Problem

Phase 2 model initialisation failed with JAX backend on diamond-context
(and likely all join-node graphs with deep composed path onsets):

```
RuntimeError: All initialization points failed
— Could not initialize state because of bad initial gradient
```

The model is mathematically correct. Numba backend samples it without
issue. The numerical gradient (finite differences) is healthy (~49 and
~89 for the two affected variables). **The NaN was purely a JAX autodiff
artefact.**

---

## Root Cause

nutpie's `compile_pymc_model` has two gradient modes:

- **`gradient_backend='pytensor'`** — pytensor computes symbolic
  gradients using its own differentiation rules, then compiles both
  forward pass and gradient to JAX. The symbolic rules handle the
  erfc/softplus chain correctly.

- **`gradient_backend='jax'`** — pytensor compiles only the forward
  logp function to JAX. Then `jax.value_and_grad()` differentiates
  that function using JAX's own reverse-mode AD.

We were using `gradient_backend='jax'`. JAX's autodiff produces NaN
when differentiating backward through the erfc/softplus/gather chain
for deep-onset edges. The exact failure is a `pad` operation in JAX's
backward pass — an implementation artefact in how JAX dispatches the
gradient of pytensor's `AdvancedSubtensor` (integer array indexing)
combined with extreme values in the erfc gradient chain.

**Why pytensor's gradient works and JAX's doesn't**: pytensor applies
its own differentiation rules to each op in the computation graph
*before* compilation. These rules handle the numerical edge cases
(z-clamped erfc, softplus with very negative arguments) correctly. JAX
never sees the problematic intermediate values because pytensor has
already simplified the gradient symbolically. When JAX differentiates
the forward pass directly, it traces through the actual numerical
computation and hits `0 × inf = NaN` in the backward pass.

---

## The Fix

One-line change in `bayes/compiler/inference.py:1496`:

```
# Before (broken):
_grad_backend = "jax" if config.jax_backend else "pytensor"

# After (fixed):
_grad_backend = "pytensor"
```

Always use `gradient_backend='pytensor'`, even with the JAX backend.
pytensor computes symbolic gradients, compiles them to JAX, same JIT
performance.

---

## Verification

| Path | NaN count | grad[21] | grad[37] |
|------|-----------|----------|----------|
| `gradient_backend='jax'` at x=0 | 2 | NaN | NaN |
| `gradient_backend='pytensor'` at x=0 | 0 | 49.04 | 89.23 |
| Numerical (finite difference) | — | 49.03 | 89.23 |

Gradient agreement between pytensor and numerical: ~1e-3.
Gradient agreement between pytensor and jax (non-NaN indices): ~3e-9.

### Performance

Per-gradient-call benchmark (500 iterations, JIT-warmed):

| Path | Time per call |
|------|--------------|
| `jax.value_and_grad` (old) | 4.031 ms |
| pytensor symbolic grad (fix) | 3.882 ms |

**No performance penalty.** The pytensor path is marginally faster
(0.96x ratio). Compile time increases from ~15s to ~31s (one-time
cost), but this eliminates the 180s numba fallback entirely.

---

## Affected Variables

Exactly 2 of 75 gradient components were NaN at x=0:

| Index | Variable | Edge | Value at x=0 |
|-------|----------|------|--------------|
| 21 | `eps_onset_cohort_31c26576` | path-b-to-join | 0.0 |
| 37 | `eps_onset_cohort_395d3cb6` | gate-to-path-b | 0.0 |

Both are on **path B** of the diamond — the longer path with larger
composed onset (5.9 days and 3.9 days respectively).

---

## Why This Only Affected Path B

Path B has larger composed onsets:

| Edge | Composed path onset | Min trajectory age |
|------|--------------------|--------------------|
| 395d3cb6 (gate-to-path-b) | 3.9 days | 1 day |
| 31c26576 (path-b-to-join) | 5.9 days | 1 day |

At age=1 with onset=5.9, the shifted lognormal CDF is astronomically
small (~10^{-300}). The erfc/softplus/gather chain produces extreme
intermediate values that JAX's backward pass can't handle. pytensor's
symbolic gradient avoids these intermediate values entirely.

---

## What Was Tried Before the Fix (all failed)

These targeted the wrong layer — they tried to fix the forward pass
numerics, but the issue was in which autodiff engine computes the
gradient.

1. **Z-clamp** (`z = max(z, -25)` before `erfc`): Prevents erfc
   underflow to exact 0. NaN persisted.
2. **Prepend-zero to CDF array**: Eliminates sentinel index pattern.
   NaN persisted.
3. **Point-to-curr for first intervals**: Eliminates another sentinel
   pattern. NaN persisted.

These fixes remain in the codebase as good numerical hygiene but are
not what resolved the NaN.

---

## Reproduction

The dump at `/tmp/bayes_debug-graph-synth-diamond-context` can
reproduce the issue. The diagnostic script `bayes/diag_jax_nan_lean.py`
demonstrates both paths (broken and fixed) without going through
nutpie's full compilation (avoiding the 180s numba fallback).

---

## Key Insight for Future Work

When using nutpie with the JAX backend, always prefer
`gradient_backend='pytensor'` over `gradient_backend='jax'`. The
pytensor symbolic gradient is numerically safer than JAX's autodiff on
pytensor-compiled forward passes, with no performance penalty. This
applies to any model with deep softplus/erfc/gather chains — not just
Phase 2.
