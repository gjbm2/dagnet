# 41a — Per-Slice `a` Implementation Plan

**Date**: 15-Apr-26
**Depends on**: doc 41 (root cause analysis, §4)
**Status**: Implemented (15-Apr-26). Four-way comparison complete. See doc 41 §5 for results.

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
  implementation samples K unconstrained deltas per dimension,
  then subtracts the mean (mean-centring). This is exchangeable
  — no slice is privileged. Applied per dimension to avoid
  coupling unrelated context dimensions. The constraint ensures
  `a_base` remains the true edge-level onset fraction.

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

## Phase 2b: Per-slice onset anchors

### 2b.1 Per-slice onset observation collection

In `evidence.py`, the onset observation collector (Step 4)
now also collects onset observations per context slice, keyed
by the context prefix extracted from `slice_key`. These are
stored on `SliceObservations.onset_observations` (new field
added to `types.py`). Applied after `_route_slices` populates
`ev.slice_groups`.

### 2b.2 Per-slice onset likelihood emission

In `model.py` §1, per-slice onset metadata is computed
alongside edge-level (`_onset_obs_deferred_slice` dict). In
§3, when `per_slice_a` is active and per-slice onset data
exists, `pm.Normal("onset_obs_slice_...")` is emitted per
slice, constraining `onset_slice_vec[k]`.

### 2b.3 Synth data onset noise

`synth_gen.py` onset observation noise changed from clipped
Gaussian (`max(0, Normal(onset, sigma))`) to log-normal
(`onset * lognormal(0, 0.3)`). Three issues with the original:
(a) 10% sigma was unrealistically tight; (b) increasing sigma
to realistic levels introduced clipping bias via `max(0, ...)`
on small-onset edges; (c) log-normal is the natural noise model
for an inherently positive quantity. The `log_sigma=0.3` gives
~30% coefficient of variation, configurable per edge via
`onset_obs_log_sigma` in the truth file.

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
| `bayes/compiler/model.py` | Feature flags, per-slice a hierarchy, back-transforms, sigma sharing gate, `_compute_onset_obs_meta` helper, per-slice onset anchor emission |
| `bayes/compiler/evidence.py` | Onset anchor binding (aggregate-only filter), per-slice onset observation collection |
| `bayes/compiler/inference.py` | Per-slice ESS/Rhat/correlation diagnostics, `RIDGE_CORR_THRESHOLD` import |
| `bayes/compiler/types.py` | `SliceObservations.onset_observations` field, `RIDGE_CORR_THRESHOLD` constant |
| `bayes/synth_gen.py` | Onset observation noise fix (0.1→0.3/1.0), onset summary diagnostic output |
| `bayes/param_recovery.py` | Persistent recovery log (`_TeeWriter`) |
| `bayes/tests/test_compiler_phase_s.py` | 8 `TestPerSliceAWiring` tests |
| `bayes/tests/test_model_wiring.py` | Fixed stale `test_latency_edge_gets_onset_variables` |
| `bayes/tests/test_stall_detector.py` | 4 `TestLaggardDetection` tests |
| `scripts/compare-per-slice-a.py` | New: four-way comparison harness |
| `scripts/resilience-strategies.py` | Unique job labels with timestamps |

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

4. **Zero-sum implementation**: implemented via mean-centring
   (sample K, subtract mean) per dimension. Exchangeable — no
   slice is privileged. Verified by wiring tests
   (`TestPerSliceAWiring`, 8 tests).
