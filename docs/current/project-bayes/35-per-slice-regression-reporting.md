# Doc 35: Per-Slice Regression Reporting

**Status**: Implemented
**Date**: 11-Apr-26
**Implemented**: 11-Apr-26
**Depends on**: Doc 34 (kappa_lat), Doc 30 (regime selection), Doc 14 (Phase C slices)

---

## Problem

The regression pipeline treats each graph as a single unit for pass/fail
reporting. When a graph's pinned DSL explodes into N context slices and the
model creates per-slice variables (p_slice, mu_slice, sigma_slice,
onset_slice, kappa_slice, kappa_lat_slice), the current report shows only
edge-level aggregates. A per-slice binding failure, prior mismatch, or
recovery miss is invisible in the report.

This matters because **contexted regression is the next validation
frontier**. The model's hierarchical per-slice structure (Beta shrinkage
around edge-level base, tau_slice precision, per-slice latency offsets) is
substantially more complex than the uncontexted case. False passes from
incomplete reporting are the exact failure mode the multi-layered audit was
built to prevent.

### Concrete failure modes this hides

1. **Binding**: one context slice has 0 rows (hash mismatch for that
   slice_key) while the aggregate has data. The edge-level receipt shows
   `source=snapshot` because *some* rows bound. The slice with no data
   falls back silently — its p_slice posterior is prior-dominated, but the
   report says PASS.

2. **Priors**: the truth file specifies `p_mult: 0.70` for email channel
   but the param file prior is uninformative. The edge-level prior looks
   fine. The per-slice prior is wrong. Not reported.

3. **Recovery**: edge-level p recovers within threshold, but
   `context(channel:email)` slice has `p_truth=0.49` (0.70 × 0.70) and
   `p_post=0.68` — the shrinkage pulled it toward the base. This is a
   real model behaviour question (is tau_slice too strong?) that the report
   should surface, not hide.

4. **LOO**: per-slice observation variables (`obs_daily_{edge}__{ctx}`,
   trajectory potentials with slice-qualified data) don't match
   `_EDGE_RE`, so they aren't scored. The LOO ΔELPD reflects only
   edge-level observations. A slice where the model performs worse than
   the analytic null is undetectable.

5. **kappa_lat**: per-slice kappa_lat variables exist
   (`kappa_lat_{edge}__{ctx}_{obs_type}`) but aren't counted or reported
   separately. A slice with collapsed ESS on its kappa_lat is invisible.

### What a correct report looks like

For a contexted graph like `synth-simple-abc-context` with DSL
`(window(...);cohort(...))(context(synth-channel))`, the explosion
produces slices for google, direct, email — each of which gets its own
model variables per edge. The report should iterate layers 3-8 for each
slice:

```
── synth-simple-abc-context ── PASS ──
  0. DSL:   (window(12-Dec-25:21-Mar-26);cohort(12-Dec-25:21-Mar-26))(context(synth-channel))
     Subjects: 12 snapshot, 6 candidate regimes
  1. Completion:  complete
  2. Feature flags: latency_dispersion=True, phase1_sampled, phase2_sampled

  ── aggregate (edge-level) ──
    3. Data binding:  OK — 2 snapshot, 0 fallback
       ok simple-a-to-b PASS  source=snapshot  rows: raw=4872 regime=4872 final=4872
       ok simple-b-to-c PASS  source=snapshot  rows: raw=4872 regime=4872 final=4872
    4. Priors:         2 edges — mu_prior=2.300, 2.500
    5. kappa_lat:      2 edges
    6. Convergence:    rhat=1.003 ess=4200 converged=100%
    7. Recovery:
         simple-a-to-b:
           ok p      truth=0.700  post=0.702±0.03  Δ=0.002
           ok mu     truth=2.300  post=2.303±0.01  Δ=0.003
           ...
         simple-b-to-c:
           ok p      truth=0.600  post=0.601±0.04  Δ=0.001
           ...
    8. LOO-ELPD:      2 edges, ΔELPD=1100.0, worst_pareto_k=0.25

  ── context(synth-channel:google) ──
    3. Data binding:  OK — 2 edges with slice data
         simple-a-to-b: 1584 rows (window), 1200 rows (cohort)
         simple-b-to-c: 1584 rows (window), 1200 rows (cohort)
    4. Priors:         hierarchical — tau_slice=8.2, base p shrinkage
    5. kappa_lat:      2 edges (per-slice)
    6. Convergence:    (shared with aggregate — single model)
    7. Recovery:
         simple-a-to-b:
           ok p_slice  truth=0.840  post=0.838±0.09  Δ=0.002
           ok mu       truth=2.100  post=2.104±0.01  Δ=0.004
           ...
         simple-b-to-c:
           ok p_slice  truth=0.690  post=0.685±0.10  Δ=0.005
           ...
    8. LOO-ELPD:      2 edges (per-slice obs), ΔELPD=340.0, worst_pareto_k=0.30

  ── context(synth-channel:email) ──
    3. Data binding:  WARN — 2 edges
         simple-a-to-b: 264 rows (window), sparse
         simple-b-to-c: 264 rows (window), sparse
    4. Priors:         hierarchical — tau_slice=8.2
    5. kappa_lat:      2 edges
    6. Convergence:    (shared)
    7. Recovery:
         simple-a-to-b:
           !! p_slice  truth=0.490  post=0.580±0.12  Δ=0.090  z=0.8
           ...
    8. LOO-ELPD:      2 edges, ΔELPD=-12.0, worst_pareto_k=0.55

  ** WARN: context(synth-channel:email) simple-a-to-b p_slice:
           posterior pulled toward base (shrinkage). Check tau_slice.
```

---

## Current state

### What exists per-slice

| Component | Per-slice data available | Where |
|-----------|------------------------|-------|
| **Evidence binding** | `ev.slice_groups[dim].slices[ctx_key]` with window_obs, cohort_obs, total_n | `evidence.py` |
| **Model variables** | `p_slice_{edge}_{ctx}`, `kappa_slice_`, `mu_slice_`, `sigma_slice_`, `onset_slice_`, `kappa_lat_{edge}__{ctx}_{obs_type}` | `model.py` §5 |
| **Inference extraction** | `post.slice_posteriors[ctx_key]` with mean, stdev, alpha, beta, HDI, mu/sigma/onset/kappa per slice | `inference.py` lines 919-1016 |
| **Harness log** | `p_slice {uuid}… context(...): mean±sd HDI=[...] kappa=... mu=... sigma=...` | harness log diagnostics |
| **param_recovery** | Per-slice truth-vs-posterior comparison using `context_dimensions` from truth file, with per-slice z-scores | `param_recovery.py` lines 385-479 |
| **Truth file** | `context_dimensions[].values[].edges[].{p_mult, mu_offset, onset_offset, sigma_mult}` | `.truth.yaml` |

### What's missing

| Gap | Impact | Files affected |
|-----|--------|---------------|
| **Binding receipt has no per-slice breakdown** | Can't tell if one slice got 0 rows while another got 4000. The edge-level `rows_raw→post_regime→final` hides the distribution. | `worker.py` (receipt construction), `types.py` (EdgeBindingReceipt) |
| **LOO `_EDGE_RE` doesn't match per-slice variables** | `obs_daily_{edge}__{ctx}` and slice-qualified trajectory potentials aren't scored. LOO covers only aggregate obs. | `loo.py` |
| **LOO null model has no per-slice path** | `_null_ll_edge_var` uses edge-level analytic baseline. Per-slice data should use per-slice truth (p × p_mult, mu + mu_offset). | `loo.py` |
| **Audit parser doesn't parse `p_slice` lines** | Per-slice posteriors from the harness log aren't structured in the audit dict. | `run_regression.py` `_audit_harness_log()` |
| **Report doesn't iterate slices** | Layers 3-8 render once per graph, not once per slice. | `run_regression.py` summary section |
| **`_parse_recovery_output` doesn't parse per-slice recovery** | Per-slice truth-vs-posterior from `param_recovery.py` stdout isn't captured. | `run_regression.py` `_parse_recovery_output()` |
| **Pointwise log-likelihood for per-slice trajectory potentials** | `ll_traj_` Deterministics are created per edge, not per slice. When slice-qualified trajectories exist, they're summed into the edge-level Potential. | `model.py`, `inference.py` |

---

## Implementation approach

### Principle: each slice is a reporting unit

In `--verbose` mode, the report renders layers 0-2 once (DSL, completion,
feature flags — these are graph-level), then iterates layers 3-8 for each
**reporting unit**:

- The **aggregate** (edge-level, bare data) — always present
- One unit per **context slice** that the model created variables for

Convergence (layer 6) is shared across all units (single MCMC run) but
should still appear in each unit for readability.

### Phase 1: per-slice binding detail

Add per-slice row counts to the binding receipt. The evidence binder
already routes rows to `ctx_window_rows[ctx_key]` and
`ctx_cohort_rows[ctx_key]` — expose these counts in the receipt.

**Files**: `worker.py` (receipt construction), `types.py`
(EdgeBindingReceipt — add `slice_row_counts: dict[str, int]`).

### Phase 2: per-slice audit parsing

Extend `_audit_harness_log()` to parse `p_slice` diagnostic lines and
group them by context_key. Extend `_parse_recovery_output()` to parse
the "Per-slice recovery" section from `param_recovery.py`.

**Files**: `run_regression.py`.

### Phase 3: per-slice LOO

1. Add per-slice variable name patterns to `_EDGE_RE` in `loo.py`.
2. Create `ll_traj_` Deterministics per slice (not just per edge) in
   `model.py` when slice-qualified trajectories exist.
3. Build per-slice null model using slice truth values.

**Files**: `loo.py`, `model.py`, `inference.py`.

### Phase 4: verbose report renderer

Restructure the summary section to iterate over reporting units. Each
unit gets layers 3-8. The aggregate unit uses existing edge-level data.
Context slice units use per-slice audit data from phases 1-3.

**Files**: `run_regression.py`.

### Phase 5: per-slice pass/fail gates

Extend `assert_recovery()` to apply per-slice z-score thresholds from
the truth file's `per_slice_thresholds`. A per-slice failure should fail
the graph (not just warn).

**Files**: `run_regression.py`.

---

## Scope notes

- **Uncontexted graphs** are unaffected — they have one reporting unit
  (the aggregate) and the report looks the same as today.
- **Summary mode** (non-verbose) can be developed later — it would show
  one line per graph with slice counts, like
  `PASS synth-abc-ctx  3 slices  data=6snap/0fb  kl=6  mu=6`.
- The per-slice LOO null model for synth graphs should use truth file
  values (`p × p_mult`, `mu + mu_offset`) not evidence priors. For prod
  graphs it should use per-slice analytic model_vars when available.
- The harness log format is the contract between the worker and the
  audit parser. Any new per-slice diagnostic lines must follow the
  existing pattern (`  p_slice {uuid}… {ctx_key}: ...`) so the parser
  can extract them with regexes.
