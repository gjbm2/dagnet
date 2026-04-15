# 41a — Per-Slice `a` Implementation Plan

**Date**: 15-Apr-26
**Depends on**: doc 41 (root cause analysis, §4)
**Status**: Plan only. No code written.

---

## Overview

Add per-slice `a` offsets to the Bayesian compiler's (m, a, r)
reparameterisation. This addresses the onset-HIGH / mu-LOW bias
on contexted graphs (doc 41 §3.3–3.5) by allowing each context
slice to find its own onset/mu ratio instead of sharing one `a`
across all slices.

Feature flags:
- `per_slice_a` (boolean, default `False`) — per-slice `a` offsets
- `shared_sigma_slices` (boolean, default `False`) — forces all
  slices to share edge-level sigma (overrides `latency_reparam_slices`
  for the `r` component only)

---

## Phase 1: Feature flag and per-slice `a` hierarchy

### 1.1 Feature flags

Add `per_slice_a` and `shared_sigma_slices` to the features dict
in `model.py` `build_model()`. Add both to the diagnostics
banner alongside existing flags.

`shared_sigma_slices` suppresses per-slice `r` offsets even when
`latency_reparam_slices >= 2`. When True, all slices use
`sigma_base` (edge-level). This is orthogonal to `per_slice_a`
— both flags can be independently toggled to test four
configurations:

- Baseline: both False (current biased behaviour)
- Per-slice a only: `per_slice_a=True`, `shared_sigma=False`
- Per-slice a + shared sigma: both True (review's recommendation)
- Shared sigma only: `per_slice_a=False`, `shared_sigma=True`
  (isolates sigma's contribution to bias)

### 1.2 Per-slice `a` hierarchy in model.py

In the per-slice latency hierarchy section (~lines 1462–1537),
when `per_slice_a` is True and `_reparam_slice_level >= 1` and
`_n_slices >= 3`:

- Add `tau_a` per context dimension: `HalfNormal(sigma=1.0)`.
  Weakly informative on the logit scale (Gelman 2006). The data
  determines pooling strength — no arbitrary fudge numbers.

- Add `delta_a_slice_vec` with zero-sum constraint. The
  implementation should sample K-1 free offsets and derive the
  Kth as the negative sum of the others, or use a softmax-style
  centring. The constraint ensures `a_base` remains the true
  edge-level onset fraction, not a floating hierarchy mean.

- Centred parameterisation (consistent with winning formula):
  `a_slice_vec = a_base + delta_a_slice_vec`.

- Change the three back-transforms to use `a_slice_vec` instead
  of `a_base_var`:
  - `onset_slice_vec`: use `sigmoid(a_slice_vec)` not
    `sigmoid(a_base_var)`
  - `mu_slice_vec`: use `softplus(a_slice_vec)` not
    `softplus(a_base_var)`
  - `sigma_slice_vec`: unchanged (depends on `r`, not `a`)

- When `per_slice_a` is False, behaviour is unchanged — `a_base`
  is shared across all slices as before.

### 1.3 Diagnostics line

Update the slice_latency diagnostic to indicate per-slice `a`:
label should read `"per-slice (m,a)"` or `"per-slice (m,a,r)"`
depending on `_reparam_slice_level`.

---

## Phase 2: Onset anchor binding fix

### 2.1 Aggregate-only onset observations

In `evidence.py` (~lines 785–803), the onset observation
collector currently iterates all rows for an edge regardless of
context. Change this to filter for aggregate-only rows (those
without a context prefix in their `slice_key`) when context
slices exist. This ensures `a_base` is anchored by aggregate
onset data, not a row-order-dependent mix of aggregate and
context rows.

When no aggregate rows exist (fully exhaustive slices with no
bare rows), fall back to the current pooled behaviour or skip
the onset anchor entirely for this edge.

---

## Phase 3: Per-slice diagnostics

### 3.1 Per-slice ESS and Rhat

In `inference.py` reparam diagnostics (~lines 1418–1433), when
`per_slice_a` is True and `a_slice_vec` variables exist in the
trace:

- Extract per-slice `a_slice` posteriors
- Compute per-slice ESS (bulk and tail) and Rhat
- Log any slices with ESS < 200 or Rhat > 1.05 as warnings
- Compute `corr(a_slice, sigma)` per slice (or
  `corr(a_slice, r_slice)` if per-slice r is active) — this is
  the ridge diagnostic. High correlation (|r| > RIDGE_CORR_THRESHOLD) indicates
  the within-slice (a, sigma) confounding is active.

### 3.2 Recovery comparison

In `param_recovery.py` / `test_harness.py`, ensure per-slice
onset and mu recovery comparisons use the per-slice truth values
from the truth file context dimensions, not just the base edge
values.

---

## Phase 4: Verification

Run in this order, each gated on the previous:

### 4.1 Four-way comparison on context-solo

Run all four configurations on context-solo (1 edge, 3 slices).
2000 tune / 2000 draws / 3 chains each.

| Config | `per_slice_a` | `shared_sigma_slices` |
|--------|--------------|----------------------|
| A (baseline) | False | False |
| B (shared σ only) | False | True |
| C (per-slice a only) | True | False |
| D (a + shared σ) | True | True |

Compare per-slice onset/mu z-scores across all four. This tells
us:
- A→B: how much bias is removed by constraining sigma alone
- A→C: how much by per-slice a alone
- A→D: combined effect (should be best)
- C vs D: whether within-slice ridge is active with per-slice a

Pass criteria for config D:
- Per-slice onset z-scores < 2.5 (currently 6+ everywhere)
- Per-slice mu z-scores < 2.5 (currently 4+ everywhere)
- `a_base` posterior HDI contains truth
- Email slice ESS > 200, Rhat < 1.05
- `corr(a_slice, sigma)` below RIDGE_CORR_THRESHOLD on all slices

### 4.2 diamond-context, lattice-context

Best configuration from 4.1. These test joins and multi-path
topology.

Pass criteria: same as 4.1.

### 4.3 Full contexted regression

All contexted synth graphs with best configuration.

Pass criteria: no graph worse than current baseline.

### 4.4 Uncontexted regression

All uncontexted synth graphs. Confirm zero regression.

### 4.5 Per-slice r experiment (optional)

Only if 4.1–4.4 are clean. Re-run context-solo with config C
(`per_slice_a=True`, `shared_sigma_slices=False`,
`latency_reparam_slices=2`).

Check whether within-slice (a, sigma) ridge reappears via
`corr(a_slice, r_slice)`. If correlation is high or bias
returns, per-slice r is not safe to combine with per-slice a.

---

## Files to modify

| File | Change |
|------|--------|
| `bayes/compiler/model.py` | Feature flags (`per_slice_a`, `shared_sigma_slices`), per-slice a hierarchy, back-transforms, sigma sharing gate |
| `bayes/compiler/evidence.py` | Onset anchor binding (aggregate-only filter) |
| `bayes/compiler/inference.py` | Per-slice ESS/Rhat/correlation diagnostics |
| `bayes/compiler/types.py` | Add `per_slice_a` to feature flag type if needed |
| `bayes/test_harness.py` | Per-slice recovery comparison against truth |

---

## What does NOT change

- Edge-level `(m_base, a_base, r_base)` priors and sampling
- t95 anchor (edge-level, unchanged)
- Per-slice p hierarchy (orthogonal)
- Per-slice kappa (orthogonal)
- Batched trajectory path (`_emit_batched_window_trajectories`)
  — already indexes into `onset_slice_vec` and `mu_slice_vec`
- `summarise_posteriors` — reads Deterministic values which will
  automatically reflect per-slice `a`
- Uncontexted code paths (no slices → no per-slice hierarchy)

---

## Risks

1. **Weak-slice identification**: email slice (10% traffic) may
   have wide `a_slice` posterior. Mitigated by hierarchy pooling
   toward `a_base` and by constraining sigma (shared, step 1).

2. **Within-slice (a, sigma) ridge**: with shared sigma
   (step 1), this is suppressed. If per-slice r is later added
   (step 4.5), the ridge could reappear per-slice. The
   `corr(a_slice, sigma)` diagnostic detects this.

3. **Sampling cost**: one extra latent per slice plus one `tau_a`
   per dimension. For K=3: 4 extra parameters. For K=10: 11
   extra. Modest.

4. **Zero-sum implementation**: the constraint must be correctly
   implemented. Standard approach: sample K-1 unconstrained
   deltas, derive Kth as negative sum. Verify by checking
   `sum(delta_a_slice_vec)` ≈ 0 in posterior.
