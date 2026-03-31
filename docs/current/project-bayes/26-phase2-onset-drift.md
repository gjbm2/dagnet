# Doc 26: Phase 2 Cohort Onset Drift — Diagnosis and Fix

**Created**: 30-Mar-26
**Status**: Fix implemented, pending validation
**Context**: item 25 investigation (doc 25), Phase 2 redesign (doc 24)

---

## 1. The Problem

Phase 2 cohort onset drifts to deranged values (~20-23d) even when
Phase 1 edge onset converges correctly (~9d). The resulting path CDF
is visibly wrong: it shows 0% conversion until age ~22d then shoots
vertically to ~78%, while the actual data shows conversions starting
at age ~7d.

Setting `onset_delta_days` on the graph edge has no effect on Phase 2
cohort onset.

## 2. Root Cause

### 2.1 The warm-start bypass

Phase 2 cohort latency priors are set in `model.py` Section 4
(lines 779-793). When `ev.cohort_latency_warm` is populated
(from `evidence.py` line 1145-1156, reading the param file's
`posterior.slices["cohort()"].onset_mean`), the warm-start **overrides**
the composed Phase 1 onset as the prior centre:

```
cw = ev.cohort_latency_warm
if cw is not None:
    ws_onset = cw.get("onset") or onset_prior_val   # ← previous run's cohort posterior
```

This creates a self-reinforcing loop:
- Run N outputs cohort onset = X (possibly deranged)
- X is written to param file as `slices.cohort().onset_mean`
- Run N+1 reads X as the warm-start centre for onset_cohort
- The tight prior (path_onset_sd ~0.6d) prevents the model from
  escaping X, even when Phase 1 of the current run says onset ~9d

### 2.2 The onset-mu ridge

Even without warm-start, onset_cohort is poorly identified in Phase 2.
Phase 1 has direct onset observations (Amplitude histogram 1st
percentile measurements) that break the onset-mu ridge. Phase 2 has
no equivalent — the only constraints are the prior and trajectory
shape. With onset and mu both free, the model can shift onset up
and compensate with mu, maintaining roughly the same CDF shape for
mature cohorts while failing to fit young cohorts.

### 2.3 The architectural violation

Phase 2 should receive priors **exclusively** from Phase 1 of the
current run. The `ev.cohort_latency_warm` path injects state from
a previous run directly into Phase 2, bypassing Phase 1 entirely.
This violates the two-phase design principle (doc 24 §2):

> Phase 1 evidence weight must flow into Phase 2 — prior widths
> in Phase 2 are derived from Phase 1 posterior precision, not
> hardcoded.

No external priors should enter Phase 2 other than those derived
from Phase 1 of the current run.

## 3. The Fix

### 3.1 Principle

Phase 2 path latency priors follow the same discipline as Phase 2
edge probability (doc 24 §3.1):

- **Centre**: Phase 1 composed values (FW convolution of edge
  posteriors)
- **Width**: Phase 1 posterior uncertainties, composed in quadrature
  (`path_onset_sd = sqrt(Σ edge_onset_sd²)`)
- **Drift loosening**: future work — analogous to ESS decay for p,
  allowing onset/mu/sigma to loosen if temporal instability is
  detected and time has elapsed. For now, drift_sigma2 for latency
  is 0 (conservative: full Phase 1 precision carried forward).

### 3.2 Changes

1. **Remove `ev.cohort_latency_warm` from Phase 2 model**: always
   use composed Phase 1 values (onset_prior_val, mu_path_composed,
   sigma_path_composed) as centres for onset_cohort, mu_cohort,
   sigma_cohort.

2. **Keep `cohort_latency_warm` in evidence.py** for now: it still
   populates but model.py ignores it. Can be removed in a future
   cleanup.

### 3.3 Why FW composition is sufficient

FW convolution of edge latencies is an approximation, but:
- Path onset = Σ edge onsets — this is **exact** (additive)
- Path mu and sigma are approximate (lognormal sum ≠ lognormal),
  but the quadrature-composed SDs from Phase 1 posteriors give
  principled widths that reflect the actual uncertainty
- For short paths (2 edges), FW is highly reliable → tight prior
- For long paths (many hops), uncertainty grows naturally via
  quadrature → wider prior, more freedom

The freedom is mathematically disciplined by Phase 1's evidence,
not arbitrary.

## 4. Relationship to Doc 24

Doc 24 §3.4 already specified this design correctly:

> Prior: centred on FW-composed Phase 1 edge latencies, with widths
> from propagated Phase 1 posterior SDs.

The implementation diverged by adding the `cohort_latency_warm`
override. This fix brings the implementation back in line with the
design.

## 5. Deeper Issue: Softplus Onset Leakage

Removing the warm-start fixed the self-reinforcing loop but onset
still drifts (Phase 1 del-to-reg: 9.56d vs Amplitude obs mean 4.0d).
The root cause is deeper: the softplus used in the CDF computation
leaks mass below onset. Combined with large sigma, this allows a
degenerate (onset, mu, sigma) mode that mimics the correct CDF shape.
The sampler lands on this ridge unpredictably — sometimes fitting
well, sometimes catastrophically.

See journal 30-Mar-26 "Softplus onset leakage" for full analysis
and fix options.
