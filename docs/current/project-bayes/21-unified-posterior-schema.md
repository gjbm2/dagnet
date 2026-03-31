# Doc 21 — Unified Posterior Schema

**Status**: Design
**Date**: 24-Mar-26
**Purpose**: Restructure the parameter file posterior schema. Merge the
separate probability (`posterior`) and latency (`latency.posterior`) blocks
into a single `posterior` block with per-slice entries carrying both
probability and latency fields. Enables context-aware model var consumption
without duplicating slice canonicalisation across two trees.

**Related**: Doc 15 (model vars provenance), doc 19 (production/consumption
separation), doc 14 (Phase C slice pooling), programme.md

---

## 1. Problems with the current schema

### 1.1 Probability and latency posteriors live in different trees

Probability posterior sits at `posterior` (top level). Latency posterior sits
at `latency.posterior` (nested). They come from one joint MCMC fit, share
`fitted_at` / `fingerprint` / `_model_state`, but are structurally separated.

### 1.2 Unified per-slice entries are impossible

`posterior.slices` exists (probability only). `latency.posterior` has no
`slices` map. A contexted slice (e.g. `window().context(channel:google)`)
that carries both probability and latency posteriors cannot be represented
without duplicating the slice key structure across both trees.

### 1.3 `_model_state` is parented under probability

`_model_state` holds fit-wide model internals: `p_base`, `tau_window`,
`tau_cohort`, per-edge `kappa`, `onset_hyper_mu`, `tau_onset`. These are
not probability-specific — they span the joint model. Nesting them under
the probability posterior is misleading.

### 1.4 `fit_history` is duplicated

Probability and latency each have their own `fit_history` array. Same fit,
same date, split across two arrays. Unified history per fit date is cleaner.

### 1.5 Top-level `alpha`/`beta` are model internals

The top-level `posterior.alpha/beta` hold `p_base` — the hierarchical anchor
that `p_window` and `p_cohort` deviate from. This is a model internal, not a
consumption quantity. Consumers should read the observation-type-specific
posterior (window or cohort), not the hierarchy anchor.

---

## 2. Design

### 2.1 One `posterior` block, slice-keyed

The parameter file gets a single `posterior` block at the top level. All
consumption quantities live in `posterior.slices`, keyed by DataSubjectDSL
string. Each slice entry carries both probability and latency fields — one
key, one complete parameter set.

The `latency.posterior` sub-block is removed. The `latency` block retains
its non-posterior fields (promoted values, user-configured fields, analytic
scalars) unchanged.

### 2.2 Slice keys follow the exploded DataSubjectDSL

Slice keys are DSL strings matching the evidence structure:

```
"window()"
"window().context(channel:google)"
"window().context(channel:influencer)"
"window().context(browser_type:chrome)"
"cohort()"
"cohort().context(channel:google)"
"cohort().context(channel:influencer)"
```

The hierarchy is implied by the key structure, not encoded in nesting. An
uncontexted key (`window()`, `cohort()`) is the aggregate for that
observation type. Contexted keys are the partially-pooled children.

### 2.3 `_model_state` is fit-wide

`_model_state` moves to the `posterior` top level (sibling of `slices`).
It holds model internals for warm-start: hierarchy anchors, deviation
scales, overdispersion parameters, onset hyperpriors. No consumption
semantics — the FE never reads these directly.

Contents (illustrative, not exhaustive — the compiler writes whatever it
needs):

```yaml
_model_state:
  p_base_alpha_7bb83fbf: 43.0
  p_base_beta_7bb83fbf: 119.5
  tau_window_7bb83fbf: 0.3
  tau_cohort_7bb83fbf: 0.5
  kappa_7bb83fbf: 23.7
  onset_hyper_mu: 5.2
  tau_onset: 2.1
```

### 2.4 Unified `fit_history`

One `fit_history` array with one entry per fit date. Each entry carries
full-fidelity per-slice snapshots (same shape as `SlicePosteriorEntry`)
plus `hdi_level` and `prior_tier` to be self-describing. See doc 27 for
the retention policy and asat query path.

---

## 3. Schema

### 3.1 Parameter file structure (posterior-relevant)

```yaml
posterior:
  fitted_at: "24-Mar-26"
  fingerprint: "abc123def"
  hdi_level: 0.9
  prior_tier: "direct_history"
  surprise_z: 1.2

  _model_state:
    p_base_alpha_7bb83fbf: 43.0
    p_base_beta_7bb83fbf: 119.5
    tau_window_7bb83fbf: 0.3
    tau_cohort_7bb83fbf: 0.5
    kappa_7bb83fbf: 23.7
    onset_hyper_mu: 5.2
    tau_onset: 2.1

  slices:
    "window()":
      alpha: 43.0
      beta: 119.5
      p_hdi_lower: 0.22
      p_hdi_upper: 0.33
      mu_mean: 1.87
      mu_sd: 0.05
      sigma_mean: 0.37
      sigma_sd: 0.02
      onset_mean: 5.3
      onset_sd: 0.8
      hdi_t95_lower: 22.1
      hdi_t95_upper: 36.8
      onset_mu_corr: -0.42
      ess: 1100
      rhat: 1.002
      divergences: 0
      evidence_grade: 3
      provenance: "bayesian"

    "cohort()":
      alpha: 38.0
      beta: 112.0
      p_hdi_lower: 0.20
      p_hdi_upper: 0.35
      mu_mean: 2.41
      mu_sd: 0.08
      sigma_mean: 0.52
      sigma_sd: 0.03
      onset_mean: 8.2
      onset_sd: 1.1
      hdi_t95_lower: 28.4
      hdi_t95_upper: 58.7
      ess: 800
      rhat: 1.01
      divergences: 0
      evidence_grade: 3
      provenance: "bayesian"

    "window().context(channel:google)":
      alpha: 28.0
      beta: 72.0
      p_hdi_lower: 0.24
      p_hdi_upper: 0.36
      mu_mean: 1.92
      mu_sd: 0.06
      sigma_mean: 0.35
      sigma_sd: 0.03
      onset_mean: 5.1
      onset_sd: 0.9
      hdi_t95_lower: 20.8
      hdi_t95_upper: 34.2
      ess: 620
      rhat: 1.003
      divergences: 0
      evidence_grade: 2
      provenance: "bayesian"

  fit_history:
    # Full-fidelity entries (doc 27): same shape as posterior.slices
    - fitted_at: "17-Mar-26"
      fingerprint: "def456ghi"
      hdi_level: 0.9
      prior_tier: "direct_history"
      slices:
        "window()":
          alpha: 40.1
          beta: 115.2
          p_hdi_lower: 0.21
          p_hdi_upper: 0.32
          mu_mean: 1.85
          mu_sd: 0.06
          sigma_mean: 0.36
          sigma_sd: 0.03
          ess: 1050
          rhat: 1.003
          divergences: 0
          evidence_grade: 3
          provenance: "bayesian"
        "cohort()":
          alpha: 35.0
          beta: 108.0
          p_hdi_lower: 0.19
          p_hdi_upper: 0.34
          mu_mean: 2.38
          mu_sd: 0.09
          sigma_mean: 0.50
          sigma_sd: 0.04
          ess: 780
          rhat: 1.008
          divergences: 0
          evidence_grade: 3
          provenance: "bayesian"

latency:
  latency_parameter: true
  t95: 17.36
  mu: 1.87
  sigma: 0.37
  onset_delta_days: 5.5
  # ... promoted/persisted values unchanged
  # NO posterior sub-block
```

### 3.2 `SlicePosteriorEntry`

Each slice carries a complete parameter set:

| Field | Type | Present | Description |
|---|---|---|---|
| `alpha` | float | Always | Beta shape α for probability |
| `beta` | float | Always | Beta shape β for probability |
| `p_hdi_lower` | float | Always | Probability HDI lower bound |
| `p_hdi_upper` | float | Always | Probability HDI upper bound |
| `mu_mean` | float | When latency fitted | Posterior mean of log-normal μ |
| `mu_sd` | float | When latency fitted | Posterior SD of μ |
| `sigma_mean` | float | When latency fitted | Posterior mean of log-normal σ |
| `sigma_sd` | float | When latency fitted | Posterior SD of σ |
| `onset_mean` | float | When latency fitted | Posterior mean of onset (days) |
| `onset_sd` | float | When latency fitted | Posterior SD of onset |
| `hdi_t95_lower` | float | When latency fitted | HDI lower bound for t95 |
| `hdi_t95_upper` | float | When latency fitted | HDI upper bound for t95 |
| `onset_mu_corr` | float | When latent onset | Posterior correlation onset↔μ |
| `ess` | float | Always | Effective sample size (min of p and latency) |
| `rhat` | float | Always | Convergence diagnostic (max of p and latency) |
| `divergences` | int | Always | MCMC divergent transitions |
| `evidence_grade` | int | Always | 0=cold start, 1=weak, 2=mature, 3=full |
| `provenance` | string | Always | "bayesian", "pooled-fallback", "point-estimate", "skipped" |

**Latency field semantics per slice type**: The `mu_mean`/`sigma_mean`
fields always represent the best latency model for that slice's observation
type. For `window()` slices, these are edge-level latency parameters. For
`cohort()` slices, these are path-level latency parameters. The slice key
implies the context — the field names are the same. Consumers do not need
to distinguish `mu_mean` vs `path_mu_mean`; they read the slice matching
their DSL and get the right values.

### 3.3 `Posterior` (top-level)

| Field | Type | Description |
|---|---|---|
| `fitted_at` | string | UK date (d-MMM-yy) of most recent fit |
| `fingerprint` | string | Deterministic model hash |
| `hdi_level` | float | HDI level used (e.g. 0.9) |
| `prior_tier` | string | Evidence tier for priors |
| `surprise_z` | float? | Trajectory surprise z-score |
| `slices` | Record<string, SlicePosteriorEntry> | Per-slice posteriors keyed by DSL |
| `_model_state` | Record<string, float>? | Model internals for warm-start |
| `fit_history` | FitHistoryEntry[]? | Rolling snapshots (capped at 20) |

### 3.4 `FitHistoryEntry`

| Field | Type | Description |
|---|---|---|
| `fitted_at` | string | UK date of this historical fit |
| `fingerprint` | string | Model hash at time of fit |
| `hdi_level` | float | HDI level used for this fit (e.g. 0.9) |
| `prior_tier` | string | Prior tier that produced this fit |
| `slices` | Record<string, SlicePosteriorEntry> | Full-fidelity per-slice snapshot (doc 27) |

Legacy entries may have only `{ alpha, beta, mu_mean?, sigma_mean? }` —
see doc 27 §3.4 for backward compatibility handling.

---

## 4. What changes

### 4.1 Type definitions

| File | Change |
|---|---|
| `graph-editor/src/types/index.ts` | Replace `ProbabilityPosterior`, `LatencyPosterior`, `ProbabilityFitHistoryEntry`, `LatencyFitHistoryEntry` with `Posterior`, `SlicePosteriorEntry`, `FitHistoryEntry`. Remove `posterior` field from `LatencyConfig`. |
| `graph-editor/lib/graph_types.py` | Same: replace Pydantic models. Remove `posterior` field from `LatencyConfig`. |
| `graph-editor/public/param-schemas/parameter-schema.yaml` | Remove `latency.posterior` block. Rewrite `posterior` block with `slices` structure. |

### 4.2 Compiler output (Bayes interface)

| File | Change |
|---|---|
| `bayes/compiler/types.py` | Add `SliceSummary` dataclass combining probability and latency fields. `to_webhook_dict()` produces `slices` map. `PosteriorSummary` and `LatencyPosteriorSummary` can remain as internal intermediate types — the combination happens at serialisation. |
| `bayes/compiler/inference.py` | `summarise_posteriors()` produces per-edge `Dict[sliceDSL, SliceSummary]`. The compiler knows which observation types (window, cohort) it fitted per edge — emits one slice key per obs type. |
| `bayes/worker.py` | Webhook payload shape changes: per-edge block gets `slices` map + `_model_state` instead of separate `probability` and `latency` blocks. |

### 4.3 Warm-start reads (Bayes interface)

| File | Change |
|---|---|
| `bayes/compiler/evidence.py` | `_resolve_prior()` reads `_model_state` for hierarchy anchors (`p_base_alpha/beta`). Reads `slices["window()"]` for per-variable latency priors (mu_mean, mu_sd for ESS-capping). Falls back to uninformative when no previous posterior exists. |

### 4.4 FE services

| File | Change |
|---|---|
| `graph-editor/src/services/bayesPatchService.ts` | Rewrite patch application. Currently writes separate `posterior` (probability) and `latency.posterior`. Changes to write unified `posterior` with `slices`, `_model_state`, unified `fit_history`. |
| `graph-editor/src/services/updateManager/mappingConfigurations.ts` | One cascade entry for `posterior` (instead of two for probability + latency posterior). Strip `fit_history`, `slices`, `_model_state` when cascading file → graph. Project summary fields from the relevant slice onto the graph edge in the shapes the UI already expects. |
| `graph-editor/src/services/dataOperations/fileToGraphSync.ts` | When building model_vars entries during `getParameterFromFile`, look up `posterior.slices[targetSlice]` and build a Bayesian `ModelVarsEntry` from the matching slice. The analytic entry continues to be built from `values[]` data as today. |
| `graph-editor/src/services/localAnalysisComputeService.ts` | Read from `posterior.slices[relevantDSL]` for both probability and latency display fields. Currently reads from two separate posterior blocks. |
| `graph-editor/src/services/analysisComputePreparationService.ts` | Analysis signature computation reads latency posterior params from `posterior.slices` instead of `latency.posterior`. |
| `graph-editor/lib/api_handlers.py` | BE dual-curve output reads from `posterior.slices[matchingDSL]` instead of `latency.posterior.*`. The DSL is available from the analysis request. |
| `graph-editor/src/services/modelVarsResolution.ts` | No structural change. `resolveActiveModelVars` and `applyPromotion` continue to work on `ModelVarsEntry` objects. The Bayesian entry is built upstream (in `fileToGraphSync` or `bayesPatchService`) from the relevant slice. |

### 4.5 UI components

No UI component changes. The cascade in `mappingConfigurations.ts` projects
slice data onto the graph edge in the same shapes that `PosteriorIndicator`,
`ConversionEdge`, and `bayesQualityTier` already consume. The cascade is
the adapter between the new file format and the existing UI contracts.

### 4.6 Tests

| File | Change |
|---|---|
| `graph-editor/src/services/__tests__/bayesPosteriorRoundtrip.e2e.test.ts` | Rewrite fixtures and assertions for unified schema. |
| `graph-editor/e2e/bayesPosteriorFullRoundtrip.spec.ts` | Update expected shapes in E2E assertions. |
| `bayes/tests/test_compiler_phase_*.py` | Update posterior extraction assertions. |
| `bayes/tests/test_serialisation.py` | Update webhook payload shape expectations. |

---

## 5. Consumption flow

### 5.1 How context-aware model vars work

When a scenario with DSL `from(A).to(B).context(channel:google)` fetches:

1. `computeEffectiveFetchDSL` composes the scenario's DSL.
2. `targetSlice` flows to `getParameterFromFile`.
3. For the **analytic** entry: `values[]` are filtered by context (existing
   behaviour via `isolateSlice`). Analytic model_vars entry built from
   context-specific evidence. **No change.**
4. For the **Bayesian** entry: `posterior.slices` is checked for a matching
   key. If `slices["window().context(channel:google)"]` exists, a Bayesian
   `ModelVarsEntry` is built from that slice's probability + latency fields.
   **New behaviour.**
5. `upsertModelVars` → `applyPromotion` → promoted scalars on edge reflect
   the context-specific posteriors.
6. All downstream consumers (beads, analysis, topo pass) see the
   context-specific values.

### 5.2 Scenario layers

All scenarios share one `edge.p` on the graph. The last-fetched scenario's
model vars are promoted. Edge beads are scenario-layer aware — they call
`getComposedParamsForLayer()` per visible layer, so each layer can show
different promoted values. The graph canvas is internally consistent for
one view at a time; analysis charts resolve per-request via their own DSL.

### 5.3 Fallback

If no matching slice exists (new context not yet fitted, or pre-Phase C
param file), the Bayesian model_vars entry is not built. The resolution
function falls through to the analytic entry (or whatever the preference
hierarchy dictates). This is the existing graceful degradation from doc 15.

---

## 6. Warm-start flow

On the 2nd and subsequent Bayes runs, the compiler reads the param file's
`posterior` block for prior seeding:

### 6.1 From `_model_state`

| Key pattern | Seeds | ESS-capped? |
|---|---|---|
| `p_base_alpha_{edge}`, `p_base_beta_{edge}` | `p_base` prior per edge | Yes |
| `tau_window_{edge}`, `tau_cohort_{edge}` | Deviation scale priors | No (point seed) |
| `kappa_{edge}` | Overdispersion prior per edge | No |
| `onset_hyper_mu`, `tau_onset` | Onset hierarchy priors | No |

### 6.2 From `slices`

| Slice key | Seeds | ESS-capped? |
|---|---|---|
| `"window()"` | Edge-level latency prior (mu, sigma, onset) | Yes (via mu_sd, ess) |
| `"cohort()"` | Path-level latency prior | Yes |
| `"window().context(X)"` | Per-context p and latency priors (Phase C) | Yes |

### 6.3 From `fit_history`

`fit_history[].slices` provides the trajectory for surprise detection
(`surprise_z`). The compiler walks the alpha/beta history per slice key
to detect regime changes.

### 6.4 Fallback chain

1. Previous posterior exists in `_model_state` + `slices` → informative
   warm-start prior.
2. No previous posterior, but histogram-derived onset available → soft
   observation prior for onset, uninformative for p.
3. No previous posterior, no histogram → pure uninformative prior from
   graph-level hyperprior.

---

## 7. Invariants

1. **One `posterior` block per param file.** No `latency.posterior`. All
   Bayesian output lives in `posterior.slices` + `posterior._model_state`.

2. **Slice keys are canonical DSL strings.** Same parser, same
   canonicalisation as `values[].sliceDSL`. A slice key matches if and only
   if the DSL strings are identical after canonicalisation.

3. **Each slice is self-contained.** Probability and latency fields for one
   observation-type/context combination in one object. No cross-referencing
   between slices needed.

4. **`_model_state` has no consumption semantics.** The FE never reads it
   directly. It is persisted for the compiler's warm-start and opaque to
   everything else.

5. **`latency.*` (non-posterior) unchanged.** User-configured fields
   (`t95`, `onset_delta_days`), promoted values (`mu`, `sigma`), and
   overrides (`t95_overridden`) stay where they are. These are not
   posterior data.

6. **Webhook is the sole writer of `posterior`.** `bayesPatchService`
   applies webhook payloads. UpdateManager/cascade never writes to
   `posterior` — it only reads (for graph display) and strips
   (fit_history/slices/_model_state) during file → graph cascade.

7. **No backwards compatibility shim needed.** No Bayesian posteriors exist
   in production param files yet. The old schema has zero instances to
   migrate.

---

## 8. Relationship to other docs

- **Doc 15 (model vars provenance)**: Unchanged in principle. `model_vars[]`
  entries continue to be source-tagged (analytic, bayesian, manual).
  `resolveActiveModelVars` and `applyPromotion` are unaffected. The only
  change is WHERE the Bayesian entry is built from — `posterior.slices`
  instead of separate `posterior` + `latency.posterior`.

- **Doc 19 (production/consumption separation)**: `promoted_t95` design
  is compatible. The promoted t95 comes from whichever model_vars entry
  wins promotion. The slice-keyed posterior is upstream of that — it feeds
  into the Bayesian model_vars entry, which may or may not win promotion.

- **Doc 14 (Phase C)**: Phase C populates contexted slice keys. This
  schema is the prerequisite — without unified slices, Phase C posteriors
  have nowhere to go.

- **Programme**: Phase activation table updated — Phase D completion
  includes populating `window()` and `cohort()` slices. Phase C adds
  contexted slice keys.
