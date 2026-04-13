# Doc 33 — Bayes Compiler Dispersion Forensic Review

**Status**: Open
**Date**: 9-Apr-26
**Purpose**: Engineering-facing summary of a read-only forensic review of mathematical and statistical defects in `bayes/compiler`, with emphasis on how dispersion is fitted, propagated, and exported.

---

## 1. Executive summary

A read-only review of `bayes/compiler` and direct result-export
consumers found six material issues.

Two likely affect the fitted posterior itself:

- trajectory endpoints are currently counted in both
  `bayes/compiler/model.py:_emit_cohort_likelihoods()` and the
  `endpoint_bb_*` likelihood emitted by
  `bayes/compiler/model.py:build_model()`
- the Phase 2 non-exhaustive branch-group prior in
  `bayes/compiler/model.py:build_model()` is order-dependent

Four additional issues primarily affect exported uncertainty or
model-quality diagnostics rather than the sampler itself:

- `bayes/compiler/inference.py:summarise_posteriors()` exports
  `cohort()` alpha/beta via post-hoc empirical
  `_estimate_cohort_kappa()` rather than the sampled posterior
- `bayes/compiler/loo.py:compute_loo_scores()` does not mirror the
  fitted likelihood for non-exhaustive branch groups or cohort
  endpoint likelihoods
- predictive alpha/beta summaries are re-simulated non-deterministically
  during export
- path provenance is hard-coded to `"bayesian"` without path-level
  convergence gating

The most important engineering distinction is between defects that bias
inference and defects that mis-state confidence. The first category
should be treated as model-correctness work. The second category can
still mislead product and engineering decisions because the frontend
consumes `cohort()` alpha/beta, `delta_elpd`, and provenance fields in
posterior displays and quality warnings.

## 2. Scope and method

This review covered:

- `bayes/compiler/completeness.py`
- `bayes/compiler/model.py`
- `bayes/compiler/inference.py`
- `bayes/compiler/loo.py`
- `bayes/compiler/types.py`
- direct exporters and consumers in `bayes/worker.py`,
  `graph-editor/src/services/bayesPatchService.ts`,
  `graph-editor/src/utils/bayesQualityTier.ts`, and
  `graph-editor/src/components/shared/PosteriorIndicator.tsx`

Dispersion fields traced included `p_sd`, `mu_sd`, `sigma_sd`,
`onset_sd`, `onset_mu_corr`, `kappa`, `path_mu_sd`,
`path_sigma_sd`, `path_onset_sd`, `window_alpha`, `window_beta`,
`cohort_alpha`, `cohort_beta`, `delta_elpd`, `pareto_k_max`, and
posterior provenance fields.

Targeted tests inspected and run were:

- `bayes/tests/test_serialisation.py`
- `bayes/tests/test_loo.py`
- `bayes/tests/test_model_wiring.py`

They passed. That should be read as a coverage gap rather than as
evidence that the findings below are false.

## 3. Triage summary

| Finding | Severity | Category | Trigger conditions | Primary user-visible surface |
|---|---|---|---|---|
| Endpoint double-counting between trajectory and endpoint likelihoods | High | Fitted-model bias | Edges with window trajectories and emitted `endpoint_bb_*` terms | `p`, `kappa`, latency posteriors, downstream warm-started Phase 2 priors |
| Order-dependent Phase 2 non-exhaustive branch-group prior | Medium-high, conditional | Fitted-model bias | Multi-sibling non-exhaustive cohort branch groups, especially sparse data | sibling `p_cohort`, branch uncertainty, downstream path probabilities |
| `cohort()` alpha/beta exported from empirical `_estimate_cohort_kappa()` | Medium | Reporting and contract drift | Any edge with `p_cohort_*` export and sufficient mature cohort data | `cohort()` probability bands, `path_alpha/path_beta`, posterior detail views |
| LOO null does not mirror fitted likelihood | Medium | Diagnostic and quality-gating defect | Branch groups, cohort endpoint likelihoods, any edge surfacing `delta_elpd` | `delta_elpd`, quality warnings, posterior detail panels |
| Predictive summaries are non-deterministic | Low-medium | Reproducibility defect | Any export path that re-simulates predictive Beta draws | jitter in alpha/beta, HDI, and derived stdev |
| Path provenance always reports `"bayesian"` | Low | Metadata defect | Any exported path latency posterior | provenance display and human interpretation of quality |

## 4. Detailed findings

### 4.1 Endpoint double-counting changes the fitted posterior

The highest-risk issue is in `bayes/compiler/model.py`.

`_emit_cohort_likelihoods()` decomposes each trajectory into
conditional Binomial intervals across all retrieval ages, including the
final interval. Later in `build_model()`, the compiler also builds an
`endpoint_bb_*` likelihood from the same mature trajectory endpoint via
`traj.cumulative_y[-1]`.

This means the final observation of a mature window trajectory is used
twice: once in the interval product and once in the endpoint
BetaBinomial. The two terms are not isolated to separate parameter
blocks; they pull on shared probability, latency, and dispersion terms.

This is not just a stylistic concern. The 27-Mar-26 design note in
`docs/current/project-bayes/18-compiler-journal.md` explicitly states
that the endpoint observations must be excluded from one side of the
shape-plus-rate decomposition to avoid partial double-counting. The
current implementation appears to contradict that design.

Severity is high when the pattern is active because it changes the
likelihood itself. It can bias `p`, `kappa`, and latency jointly, and
the distortion can then propagate because `bayes/worker.py` freezes
Phase 1 outputs into Phase 2 priors.

The right engineering test is a synthetic trajectory case in which the
same endpoint is present as both a trajectory terminal point and an
eligible endpoint observation. The model should be invariant to whether
that endpoint is routed through the trajectory path or the endpoint
path, provided it is used exactly once.

### 4.2 The Phase 2 non-exhaustive branch-group prior is order-dependent

The second fitted-model issue is in the Phase 2 branch-group prior
assembly in `bayes/compiler/model.py`.

For non-exhaustive multi-sibling groups, the compiler builds
Dirichlet concentration terms for the explicit siblings and then
constructs a dropout remainder. The current code overwrites the
beta-side concentration while iterating siblings, then computes the
remainder using the final sibling's beta-side concentration and
`sum(dir_alphas[1:])`.

That has two consequences:

- the first sibling is excluded from the subtraction used to form the
  remainder
- the last sibling visited determines the scale of the remainder

As a result, reordering `BranchGroup.sibling_edge_ids` can change the
prior. A Bayesian posterior should not depend on arbitrary sibling
ordering, so this is a mathematical defect rather than merely a code
smell.

The severity is conditional. Exhaustive groups are not affected.
Data-rich non-exhaustive groups may swamp the prior. Sparse or
prior-dominated groups are where this matters most.

The correct validation is an invariance test: same graph, same
evidence, same random seed, different sibling ordering, same posterior.

### 4.3 Exported cohort uncertainty currently comes from post-hoc empirical kappa, not the sampled posterior

The cohort uncertainty export path in
`bayes/compiler/inference.py:summarise_posteriors()` does not appear to
match the current documented design.

When `p_cohort_*` samples exist, the exporter computes cohort
alpha/beta by combining those samples with a fresh scalar estimate from
`_estimate_cohort_kappa()`. Those cohort alpha/beta values are then
merged in `bayes/worker.py` and projected onto the graph in
`graph-editor/src/services/bayesPatchService.ts` as the `cohort()`
probability slice and `path_alpha/path_beta`.

This means the displayed cohort uncertainty band is not currently a
direct export of sampled posterior dispersion. It is an empirical
predictive band built from a post-hoc estimator operating on mature
cohort observations.

That may reflect an intentional fallback at some stage of the
dispersion work, but it diverges from the direction stated in
`docs/current/project-bayes/programme.md` and the 27-Mar-26 notes in
`docs/current/project-bayes/18-compiler-journal.md`, both of which
describe the cohort confidence-band path as model-based rather than
diagnostic-estimator-based.

This issue does not change the sampler itself, so its severity is lower
than the first two findings. It is still important because engineering
and product users are shown those bands as Bayesian cohort uncertainty.
Any consumer of `cohort()` alpha/beta inherits the mismatch.

The key engineering decision is to make the contract explicit. Either:

- restore a fully model-based cohort export path, or
- keep the empirical predictive path but document it as such and stop
  presenting it as a direct sampled-posterior output

### 4.4 LOO adequacy scoring does not mirror the fitted likelihood

`bayes/compiler/loo.py` computes useful diagnostics, but the null model
currently diverges from the fitted likelihood in two important places.

First, `_null_ll_bg_var()` builds a Dirichlet-Multinomial null over
sibling branches only. The fitted non-exhaustive branch-group
likelihood in `bayes/compiler/model.py` includes a dropout bucket and
scales concentrations by kappa. The null therefore compares a different
geometry from the fitted model, and in non-exhaustive cases the count
vector can contain a dropout category that the null alpha vector does
not represent.

Second, `_null_ll_edge_var()` scores cohort endpoint likelihoods using
the edge-level latency fields available through `AnalyticBaseline`.
Phase 2 cohort endpoint likelihoods are path-latency objects in the
fitted model, so the null is not comparing against the same latency
surface.

This does not alter posterior inference, but it does make `delta_elpd`
less trustworthy as an adequacy measure. That matters because
`bayes/worker.py` exports the metric and
`graph-editor/src/utils/bayesQualityTier.ts` treats negative
`delta_elpd` as a warning reason. In other words, this is already part
of the quality story shown to users.

The right fix is not only to avoid crashes. The null must mirror the
fitted likelihood variable by variable, including dropout structure and
path-level latency semantics, otherwise `delta_elpd` is not a clean
like-for-like comparison.

### 4.5 Predictive summaries are not deterministic for a fixed posterior trace

The predictive export path in `bayes/compiler/inference.py` re-simulates
predictive Beta draws during summarisation by calling `np.random.beta()`
without a deterministic local RNG.

Those draws are then moment-matched back into alpha/beta, HDI, and
derived standard deviations. That means a fixed posterior trace can
produce slightly different exported summaries on different runs even if
sampling itself was deterministic.

This is primarily a reproducibility and auditability defect rather than
a mathematical blocker. It still matters for engineering because it
adds noise to exact comparisons, snapshot diffs, and confidence-band
inspection when nothing in the posterior trace changed.

The correct expectation is that summarising a saved trace twice should
produce identical exports unless the system explicitly documents
stochastic post-processing.

### 4.6 Path provenance overstates convergence

The final issue is low severity but worth documenting because it affects
how posterior quality is communicated.

Edge-level latency exports in `bayes/compiler/inference.py` use ESS and
Rhat thresholds to decide whether provenance is `"bayesian"` or
`"pooled-fallback"`. The path-level export path does not mirror that
logic and instead sets path provenance to `"bayesian"` unconditionally
when path samples exist.

`bayes/worker.py` and
`graph-editor/src/services/bayesPatchService.ts` then propagate that
field into the frontend, where it is shown in posterior detail panels.

This does not change the fitted posterior. It does make the metadata
less reliable, especially when path-level cohort latency convergence is
weaker than edge-level latency convergence.

## 5. Existing coverage gaps

Current tests do not appear to exercise the defects above directly.

- `bayes/tests/test_serialisation.py` checks field wiring and rounding
  for `PosteriorSummary` and `LatencyPosteriorSummary`, not the
  statistical correctness of the exported values
- `bayes/tests/test_loo.py` covers `AnalyticBaseline.kappa`, helper
  mapping, and multi-variable `az.loo()` plumbing, but not
  non-exhaustive branch groups with dropout or cohort-latency null
  parity
- `bayes/tests/test_model_wiring.py` covers warm-start and model
  construction wiring, not endpoint reuse, branch-order invariance, or
  deterministic summarisation

Specific missing tests:

- a regression that proves each mature trajectory endpoint contributes
  exactly once
- a branch-group permutation invariance test
- a cohort uncertainty export test that distinguishes sampled-posterior
  dispersion from empirical predictive dispersion
- a LOO parity test for non-exhaustive branch groups with dropout
- a deterministic summarisation test on a fixed saved trace
- a path-provenance gating test mirroring the edge-level provenance
  logic

## 6. Recommended engineering order

1. Fix the two likelihood-changing issues first:
   endpoint double-counting and branch-group order dependence.
2. Decide the contract for exported cohort uncertainty and align code,
   docs, and UI wording around that contract.
3. Make `bayes/compiler/loo.py` mirror the fitted likelihood exactly,
   or reduce UI reliance on `delta_elpd` until parity exists.
4. Make predictive summarisation deterministic.
5. Apply path-level convergence gating to path provenance.

## 7. Verification plan after fixes

Recommended validation work:

- a synthetic single-edge trajectory case that isolates endpoint reuse
- a synthetic non-exhaustive branch-group case with reordered sibling
  lists to prove posterior invariance
- repeated summarisation of the same saved trace to prove deterministic
  export
- a LOO fixture covering non-exhaustive branch groups and Phase 2 cohort
  endpoint likelihoods
- frontend verification that `cohort()` bands, `path_alpha/path_beta`,
  provenance, and quality warnings reflect the intended corrected
  semantics

## 8. Cross-reference note

`docs/current/project-bayes/programme.md` previously described the
kappa-to-confidence-band pipeline as verified for both window and cohort
modes. The current code path appears less settled than that statement
implies because cohort alpha/beta export still routes through
`_estimate_cohort_kappa()`. The programme doc should therefore be read
alongside this review until the export contract is made explicit.
