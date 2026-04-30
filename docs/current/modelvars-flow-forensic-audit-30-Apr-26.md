# Model-Vars Flow Forensic Audit — 30-Apr-26

**Status**: complete (30-Apr-26). Updates welcome via PRs against the §8 issues catalogue and §9 recommendations.

**Scope**: every field carried on `edge.p.model_vars[*]` for both source families — `analytic` (produced by FE topo) and `bayesian` (produced by the Bayes compiler / patch service / DSL re-projection) — traced from the producer call site, through every upsert / translation / promotion layer, to its three consumers:

1. **FE quick-pass graph output** — FE topo Step 2 (`computeBlendedMean`, `enhanceGraphLatencies`) producing the L5 current-answer scalars `p.mean`, `p.stdev`, `p.latency.completeness`, `p.latency.completeness_stdev` — the values that render when CF doesn't run or arrives slow.
2. **BE CF slow-pass graph output** — `resolve_model_params` → `compute_forecast_trajectory` → `applyConditionedForecastToGraph`, producing the same L5 scalars but via IS-conditioned MC.
3. **ModelCard and PromotedModelCard** — the two UI affordances that present model-vars state to the user. ModelCard renders one `ModelVarsEntry` per source; PromotedModelCard renders the active-source promoted view.

**Looking for**: drops (a field is produced but never consumed; a consumer expects a field that no producer writes), elisions (multiple distinct concepts collapsed into one slot with ambiguous semantics), ambiguities (the same field name carries different meanings on different surfaces), dropped balls (state changes that don't propagate across all the layers they should), residual asymmetries (the post-unification work left some surfaces source-conditional even after the principle was adopted), latent bugs.

**Not in scope**: the `analytic_be` source (removed 24-Apr-26 per doc 73b), the parameter-file `posterior` slice library (different shape, owned by the Bayes webhook). Those are upstream of the model-vars layer and are referenced only as inputs.

---

## §1. Work plan

### Phase 0 — grounding and skeleton (done at the head of this doc)

Read warm-start docs (`SYNC_SYSTEM_OVERVIEW`, `RESERVED_QUERY_TERMS_GLOSSARY`, `KNOWN_ANTI_PATTERNS`, `INVARIANTS`), subsystem references (`STATS_SUBSYSTEMS`, `FE_BE_STATS_PARALLELISM`, `PROBABILITY_BLENDING`, `EPISTEMIC_DISPERSION_DESIGN`, `FORECAST_STACK_DATA_FLOW`), and the active design docs (`posterior-unification-plan-29-Apr-26.md`, key `project-bayes` chapters: 73b, 73f, 49, 61). Locate the concrete code surfaces touched by each phase.

### Phase 1 — producer inventory

**1A. FE topo analytic producer** — trace every write into a `model_vars[analytic]` entry. Cover both fresh writes (`statisticalEnhancementService.ts` Stage 2 / Step 1, `fileToGraphSync.ts` analytic projection from parameter file) and the helper that builds the `probability` sub-block (`buildAnalyticProbabilityBlock` in `modelVarsResolution.ts`). Record exactly which fields are written and from which sources.

**1B. Bayes producer** — trace every write into `model_vars[bayesian]`. Cover `bayesPatchService.applyPatch` (post-unification, lines 296-380 fresh patch + 440-498 entry construction), `posteriorSliceContexting.syncBayesianAndPromote` (DSL-change re-projection), and the workspace-load migration (`workspaceService._migrateBayesianPosteriorToSourceLedgerInPlace`).

### Phase 2 — translation / upsert / projection layers

**2A. `upsertModelVars`** — the entry-level upsert keyed by `source`. Confirm replace-not-merge semantics and identify any caller that bypasses it.

**2B. `applyPromotion`** — the projector that writes the L1.5 promoted surface (`p.posterior`, `p.latency.posterior`, `p.forecast.{mean, stdev, source}`, `p.latency.{mu, sigma, promoted_*}`) from `model_vars[active]`. Document every field it writes, every clear path, and the post-unification 30-Apr-26 + latency v1.1 contract.

**2C. UpdateManager file→graph cascade** — `mappingConfigurations.ts` rows that bring fields from the parameter file onto the graph edge. Map the rows that touch `model_vars` and the (now-removed?) rows that touched `p.posterior` directly.

**2D. Workspace-load migration** — what `_migrateBayesianPosteriorToSourceLedgerInPlace` moves from the legacy `p.posterior` shape into `model_vars[bayesian].{probability, fit_diagnostics, quality}`. Identify any field it leaves behind.

**2E. Transport stripping** — `bayesGraphRuntime.ts` strip helpers; confirm none of them remove model_vars fields.

### Phase 3 — consumer mapping

**3A. FE topo Step 2 (quick-pass blend)** — `computeBlendedMean` / `computePerDayBlendedMean` / `enhanceGraphLatencies` field reads. What does the blend pull from `model_vars[active]` directly? What does it pull from the promoted surfaces (`p.forecast`, `p.latency.*`)? What from `p.evidence`?

**3B. BE CF (slow-pass)** — three reads to map:
- `resolve_model_params` field reads from `posterior_block` and `model_vars[promoted].probability` / `model_vars[promoted].latency`.
- `compute_forecast_trajectory` parameter consumption (which `ResolvedModelParams` fields are touched).
- `applyConditionedForecastToGraph` field writes back to the graph edge (and which fields it leaves alone).

**3C. ModelCard** — fields read from `entry: ModelVarsEntry` (already audited in the spark-chart audit; re-verify and pin in this doc).

**3D. PromotedModelCard** (post-rename) — fields read from `p.posterior`, `p.latency.posterior`, `p.latency.{promoted_t95, promoted_path_t95}`, plus the merged-view utility's contribution from `model_vars[bayesian].fit_diagnostics` / `quality` for the diagnostic popover.

### Phase 4 — per-field flow tables

For every field on each source, build a row: producer → upsert → promotion projection → consumer reads. Cells flag drops (✗), elisions (⚠), source-conditional reads (⊝).

**4A. `model_vars[analytic].probability.*`**
**4B. `model_vars[analytic].latency.*`**
**4C. `model_vars[analytic].quality.*`** (if any — confirm)
**4D. `model_vars[bayesian].probability.*`**
**4E. `model_vars[bayesian].latency.*`**
**4F. `model_vars[bayesian].quality.*`**
**4G. `model_vars[bayesian].fit_diagnostics.{probability, latency}`**

### Phase 5 — issues catalogue

For each finding, classify (drop / elision / ambiguity / dropped ball / residual asymmetry / latent bug), describe the symptom that would surface it, locate the offending code, and rate severity.

### Phase 6 — recommendations

Prioritised follow-ups. Distinguish "must fix to be coherent" from "nice-to-have polish".

---

## §2. Methodology and terminology

**Layer model** (per `SYNC_SYSTEM_OVERVIEW.md` and the doc 73b framing):

- **L1 — source ledger**: `edge.p.model_vars[]` — one entry per source (`analytic`, `bayesian`). Each entry holds that source's view of the edge in `{probability, latency, quality, fit_diagnostics, source_at, source}`. Aggregate; not query-scoped.
- **L1.5 — promoted selector** + **L1.5 surface**: `model_source_preference` decides which entry is active; `applyPromotion` projects active-source fields onto the promoted surfaces (`p.posterior`, `p.latency.posterior`, `p.forecast.{mean, stdev, source}`, `p.latency.{mu, sigma, promoted_*}`). Source-agnostic; one writer.
- **L2 — promoted scalars**: subset of the L1.5 surface — narrow `{mean, stdev, source}` plus latency `promoted_*`. Doc 73b §3.2.
- **L4 — evidence**: `edge.p.evidence.{n, k, mean}` — query-scoped, written by FE topo evidence aggregation upstream of the blend.
- **L5 — current answer**: `edge.p.{mean, stdev, stdev_pred}`, `edge.p.latency.{completeness, completeness_stdev}` — query-scoped, written by FE topo Step 2 (blend) and overwritten by CF if CF runs and returns usable values.

**Trace conventions**:
- `→` denotes a write/projection.
- `↔` denotes a read.
- `✗` denotes a field that exists at the source but has no consumer (or vice versa).
- `⚠` denotes a field whose name or value has multiple semantics depending on context.
- `⊝` denotes a source-conditional read (consumer behaves differently per source).

**Out-of-scope reductions**:
- The "manual" source was retired in doc 73b §3.5. References in legacy code/comments are flagged but not analysed in depth.
- The parameter-file shape (`file.data.posterior`, `file.data.values[].sliceDSL`) is **not** a `model_vars` layer; it is the slice library that the Bayes producer reads from. Touched only at the producer boundary.

---

## §3. Field inventory — `model_vars[analytic]`

The TS shape of any `ModelVarsEntry` (analytic or bayesian) is in `graph-editor/src/types/index.ts:643-710`. For analytic, only a subset of the schema's optional fields is ever populated. The rest are slots reserved for the bayesian source.

### §3.1 Producer call sites

There are **three** call sites that write a `model_vars[analytic]` entry, plus two that mutate fields on an existing entry:

1. **`fileToGraphSync.ts:1937-2002` (probability+latency branch)** — `getParameterFromFile`'s "fresh fetch" code path. Fires when `addEvidenceAndForecastScalars` has just produced a fresh analytic probability triple in the same fetch (the `__fresh_analytic_probability` sidecar at `evidenceForecastScalars.ts:757-765`). Builds the entry via `buildAnalyticProbabilityBlock` and combines with `analyticLatencyFromFile` from the parameter file. Calls `upsertModelVars` followed by `applyPromotion`. **Single-shot replace** — full new entry.

2. **`fileToGraphSync.ts:2003-2044` (latency-only branch)** — same call path, fires when `analyticLatencyFromFile` is present but the sidecar is absent (re-aggregation that doesn't touch the probability block; e.g. user edits the file's latency parameters). Mutates the existing entry's `latency` block in place via index-replace. **Does not seed a stub** when no analytic entry exists — waits for the first probability-bearing fetch. Calls `applyPromotion` after.

3. **`fetchDataService.ts:2030-2151` (horizon bootstrap)** — fires from Stage 2 fetch when an edge with `latency_parameter: true` is missing μ/σ on the parameter file. Constructs the entry from `computeEdgeLatencyStats` output, preserves an existing `probability` block if one is present, otherwise falls back to a `mean`-only block sourced from `latestValue.forecast` (a transient sidecar — never persists to disk). Calls `upsertModelVars` but **does not** call `applyPromotion`; relies on the surrounding fetch's downstream LAG/FE topo + promotion sweep at line 2342.

4. **`UpdateManager.applyBatchLAGValues:2184-2216` (FE topo Step 1 mutation)** — the FE topo pass (`enhanceGraphLatencies`) emits `EdgeLAGValues[]`; UpdateManager applies them. Mutates an **existing** `model_vars[analytic]` entry's `latency` and `probability.mean` (only) fields in place. Does NOT touch `probability.{stdev, alpha, beta, alpha_pred, beta_pred, n_effective, provenance}` — those are owned by the addEvidenceAndForecastScalars/buildAnalyticProbabilityBlock path. Promotion is invoked at the end of `applyBatchLAGValues` per UpdateManager.ts:2337-2345.

5. **`workspaceService._migrateBayesianPosteriorToSourceLedgerInPlace`** — does NOT touch analytic entries; only writes `model_vars[bayesian]` from legacy `p.posterior`. Listed here for completeness; see §4.1.

### §3.2 Field-by-field — `probability`

| Field | Set by | Provenance | Notes |
|---|---|---|---|
| `mean` | `__fresh_analytic_probability.mean` (from `forecastMeanComputed = weighted_k / weighted_n`); also written by UpdateManager step 4 from `update.forecast.mean` | recency-weighted mature-day mean over the chosen target window slice | Always present when entry exists. The UpdateManager Step 4 path overwrites whatever the freshness path wrote — **possible drift if the two compute paths produce different means in the same fetch** (the topo pass's `forecast.mean` vs the addEvidenceAndForecastScalars `forecastMeanComputed`). In practice they should agree because both read from the same recency-weighted mature-day population, but no test pins the equality. **Flag: latent ambiguity.** |
| `stdev` | `buildAnalyticProbabilityBlock` from `forecastStdevComputed = sqrt(p(1-p)/N)` | sample SD on the same weighted population that produced `mean` | Set only on path 1 (fresh fetch). Path 4 (UpdateManager FE-topo mutation) does **not** write `stdev` — it leaves whatever path 1 last wrote. **Drop risk: if UpdateManager fires without a fresh fetch first, stdev is stale relative to the new mean.** In practice it can't, because the forecast.mean update only fires from `enhanceGraphLatencies` results which co-occur with the fresh fetch. But the constraint is implicit, not enforced. **Flag: implicit invariant.** |
| `alpha` | `buildAnalyticProbabilityBlock` from `momentMatchAnalyticBeta(mean, stdev)` (concentration = `mean·(1-mean)/var − 1`, alpha = mean·conc) | epistemic Beta concentration matching `(mean, stdev)` | Optional. Absent when moment-match is infeasible (mean at boundary, variance ≥ mean·(1-mean), stdev ≤ 0). When absent, BE resolver returns α=β=0 and consumers render midline only (doc 73f F16). |
| `beta` | same as alpha | epistemic | same caveats |
| `n_effective` | `buildAnalyticProbabilityBlock` — uses `weighted_n` from sidecar if positive, else the moment-match concentration | source mass behind the Beta shape | Used by the BE engine doc 52 blend correction (m_G in `m_S / m_G`). **Drop risk: if `weighted_n` is missing/zero on the sidecar, falls back to the moment-match concentration which is generally smaller than the actual data mass — this would *under-state* m_G and *over-correct* the engine blend.** Worth checking at runtime that `weighted_n > 0` in production fixtures. **Flag: latent quantitative bias.** |
| `provenance` | `buildAnalyticProbabilityBlock` (defaults to `'analytic_window_baseline'`; caller may override via `opts.provenance`) | source label | Single value `'analytic_window_baseline'` for analytic. The UI's `PromotedModelCard` displays this verbatim. |
| `cohort_alpha`, `cohort_beta`, `cohort_n_effective`, `cohort_provenance` | **Never written by analytic producers.** | — | The cohort-family Beta shape is a bayesian-only field today; analytic only carries the window-family. **Drop: documented absence rather than a defect.** Consumers in cohort mode must fall through to the window-family `{alpha, beta}` per the BE resolver line 425+. |
| `alpha_pred`, `beta_pred` | `buildAnalyticProbabilityBlock` from `momentMatchAnalyticBeta(mean, opts.stdev_pred)` when `opts.stdev_pred > 0` | predictive (overdispersion-aware) Beta from Pearson chi-squared kappa estimator on per-day `(n_i, k_i)` (`evidenceForecastScalars.ts:718-728`) | Doc 49 / EPISTEMIC_DISPERSION_DESIGN.md §6. Required for IS-conditioning to work; without it, the BE proposal collapses and conditioning becomes a no-op. |
| `cohort_alpha_pred`, `cohort_beta_pred` | **Never written by analytic producers.** | — | Same as cohort_*: analytic carries window-family only. |

### §3.3 Field-by-field — `latency`

| Field | Set by | Provenance | Notes |
|---|---|---|---|
| `mu` | (a) `analyticLatencyFromFile.mu` from parameter file, (b) `EdgeLAGValues.mu` from `enhanceGraphLatencies` via UpdateManager.applyBatchLAGValues | log-normal location | Both writers may run in the same fetch; UpdateManager runs after fileToGraphSync, so the FE-topo-fitted value wins. **Implicit ordering invariant; not enforced by code.** |
| `sigma` | same as mu | log-normal scale | same caveats |
| `t95` | (a) parameter-file `latency.t95`, (b) `EdgeLAGValues.t95` (from `computeEdgeLatencyStats`); on the live edge, also set on `p.latency.t95` directly by `applyBatchLAGValues:2175-2178` (the user-edit input field) | 95th percentile lag (days) | The promoted version is `p.latency.promoted_t95` (written by `applyPromotion`); `t95` on the edge itself is the user-input field. **Two surfaces same name — confusion vector.** |
| `onset_delta_days` | (a) parameter-file `latency.onset_delta_days`, (b) `updLat.promoted_onset_delta_days` from FE topo | days | The same field name appears at three layers (`model_vars[analytic].latency.onset_delta_days`, `p.latency.onset_delta_days` user-input, `p.latency.promoted_onset_delta_days`) with subtle distinctions. **Flag: ambiguity.** |
| `path_mu`, `path_sigma`, `path_t95`, `path_onset_delta_days` | (a) parameter file (when present), (b) FE topo `EdgeLAGValues.{path_mu, path_sigma, path_t95, path_onset_delta_days}` | path-level Fenton-Wilkinson composition | Only present on edges where the upstream path is non-trivial. |
| `mu_sd` (epistemic) | FE topo `EdgeLAGValues.mu_sd` (from `EPISTEMIC_DISPERSION_DESIGN.md` §4: t-posterior on μ, dof = N−1, scale `s/√N`, interval-matched effective SD) | t-posterior epistemic SD | Doc 61: bare = epistemic. |
| `mu_sd_pred` (predictive) | **Never written by analytic.** | — | The analytic source has no kappa parameter being estimated, so no predictive μ inflation. BE consumer falls back to `mu_sd` via `ResolvedLatency.mu_sd_predictive` per `STATS_SUBSYSTEMS.md` §6. **Documented absence.** |
| `sigma_sd` (epistemic) | FE topo (scaled-inverse-χ² posterior on σ², interval-matched effective SD) | epistemic | Doc 61. |
| `onset_sd` | FE topo: `max(1.0, onset · 0.15)` heuristic | heuristic floor | Not principled; documented in archive design §3.4. **Flag: heuristic, not statistically derived.** |
| `onset_mu_corr` | FE topo: fixed `−0.5` heuristic | heuristic | Doc 73b §3.9 (analytic dispersion discipline) caveat: analytic onset_mu_corr should be propagated as **0** by the BE resolver to avoid a spec-unjustified MC-vs-deterministic drift. The FE writes `−0.5`; the resolver clamps to `0` for analytic in `model_resolver.py:277`. **Flag: writer/reader disagreement absorbed at the resolver boundary.** |
| `path_mu_sd`, `path_sigma_sd`, `path_onset_sd` | FE topo (quadrature sum: `path_mu_sd = sqrt(mu_sd² + upstream_mu_sd²)`) | epistemic | Doc 61. |
| `path_mu_sd_pred`, `path_sigma_sd_pred` | **Never written by analytic.** Type `mu_sd_pred` exists; `path_mu_sd_pred` is not on the schema today. Type `path_sigma_sd_pred` is not declared. | — | **Documented absence; predictive path not modelled.** |
| `path_onset_mu_corr` | The schema declares `path_mu_sd`, `path_sigma_sd`, `path_onset_sd` but NOT `path_onset_mu_corr`. The TS interface omits it. The bayes patch service writes `model_vars[bayesian].latency.{mu_sd, sigma_sd, onset_sd, onset_mu_corr}` for edge level; for path level it writes `path_mu_sd`, `path_sigma_sd`, `path_onset_sd` but **not** `path_onset_mu_corr`. The FE topo path mirrors this. The BayesPosteriorCard's `ModelRateChart` reads `pathOnsetMuCorr` via `(lat as any)?.path_onset_mu_corr` (BayesPosteriorCard old code; now PromotedModelCard). **Flag: schema-vs-renderer asymmetry — the renderer expects a field the schema doesn't declare. Probably benign (renderer falls back to null / undefined), but confirm in §7.4.** |

### §3.4 Field-by-field — `quality`

`model_vars[analytic].quality` is **never written**. The schema declares it as optional on every entry; only bayesian populates it. Consumers must check `entry.source === 'bayesian'` before reading. **Documented absence.**

### §3.5 Field-by-field — `fit_diagnostics`

`model_vars[analytic].fit_diagnostics` is **never written**. Same as `quality`: bayesian-only. **Documented absence.**

### §3.6 Sidecar trail and provenance for analytic

The full chain for the analytic source on a fresh fetch:

1. `windowAggregationService` builds the per-edge (n, k, age) per-day arrays from the chosen target window slice with recency weighting and maturity exclusion.
2. `addEvidenceAndForecastScalars` (`evidenceForecastScalars.ts:28+`) computes `forecastMeanComputed`, `forecastStdevComputed` (sqrt(p(1-p)/N) on the weighted population), and `forecastStdevPredComputed` (overdispersion-aware via `rateOverdispersionPredictiveBeta`). Attaches the `__fresh_analytic_probability` sidecar to the aggregated data and a transient `forecast` / `forecast_stdev` / `forecast_stdev_pred` triple onto each `values[]` entry (in-memory only — never persists).
3. `fileToGraphSync.ts:1937-2002` reads the sidecar, builds the `model_vars[analytic]` entry via `buildAnalyticProbabilityBlock`, attaches `analyticLatencyFromFile` (from UpdateManager metadata when the file has μ/σ), and calls `upsertModelVars` + `applyPromotion`.
4. FE topo Step 1 (`enhanceGraphLatencies` → `EdgeLAGValues[]`) runs synchronously in Stage 2; UpdateManager.applyBatchLAGValues mutates the entry's `latency` block (mu/sigma/t95/path_*/SDs) and `probability.mean` (re-asserts from `update.forecast.mean`) and finally calls `applyPromotion` once per batch.
5. `applyPromotion` projects `model_vars[analytic].probability.{mean, stdev, alpha, beta, alpha_pred, beta_pred, cohort_*, n_effective, provenance, ...}` onto `p.posterior` (post-30-Apr-26 unification) and `p.forecast.{mean, stdev, source}` (the L2 narrow surface).
6. `applyPromotion` projects `model_vars[analytic].latency.{mu, sigma, t95, onset_delta_days, mu_sd, sigma_sd, onset_sd, onset_mu_corr, path_*}` onto `p.latency.posterior` (post-30-Apr-26 latency v1.1) and `p.latency.{mu, sigma, promoted_t95, promoted_onset_*, promoted_*_sd}` (the L2 narrow latency surface).

A field is "live" for analytic if and only if at least one of steps 2/3/4 wrote it AND step 5/6 projects it.



---

## §4. Field inventory — `model_vars[bayesian]`

The bayesian source carries the richest `ModelVarsEntry`: the full window+cohort Beta on `probability`, a full lognormal posterior on `latency`, MCMC quality gates on `quality`, and bayesian-only metadata (HDI, fitted_at, PPC, LOO, prior_tier, surprise) on `fit_diagnostics`. Schema in `types/index.ts:643-767`.

### §4.1 Producer call sites

Three call sites construct or rebuild a `model_vars[bayesian]` entry:

1. **`bayesPatchService.applyPatch` (lines 298-498)** — the canonical writer. Fires on Bayes fit completion via the webhook → patch flow. Builds a full entry from `patchEdge.slices['window()']` and `patchEdge.slices['cohort()']` (both normalised through `normaliseSliceShape` to absorb the doc 61 `mu_sd_epist → mu_sd` rename). Calls `upsertModelVars` followed by `applyPromotion` (line 496). **Single-shot replace.**

2. **`posteriorSliceContexting.contextProbabilityBlock` → `buildBayesianModelVarFromSlice` (lines 82-206)** — fires on DSL change. Projects the parameter file's `posterior.slices` for the active DSL via `projectProbabilityPosterior` / `projectLatencyPosterior`, then builds a `model_vars[bayesian]` entry. Drops the bayesian entry entirely if the parameter file has no slices, or if `asat()` is in effect and no fit exists on or before that date (strict, no fallback). Calls `applyPromotion` via `syncBayesianAndPromote` (lines 219-281).

3. **`workspaceService._migrateBayesianPosteriorToSourceLedgerInPlace` (lines 211-419)** — one-shot migration that runs at file load. Reads the legacy `p.posterior` shape and projects it into `model_vars[bayesian].{probability, latency, quality, fit_diagnostics}`. Idempotent: skips when `model_vars[bayesian].probability.alpha != null`. Sets the FileState dirty flag so the migrated shape persists across save/reload (plan §9).

There are **no** mutate-in-place writers on `model_vars[bayesian]` analogous to FE topo's `applyBatchLAGValues:2184` for analytic. The bayesian source is treated as immutable between fit events: every change to it goes through one of the three full-entry writers above.

### §4.2 Field-by-field — `probability`

Every field on `ModelVarsEntry.probability` is potentially populated by bayesian. Source data: window/cohort `SlicePosteriorEntry` records on the parameter file (`types/index.ts:785+`).

| Field | Set by | Provenance | Notes |
|---|---|---|---|
| `mean` | `bayesPatchService:351` from `windowSlice.alpha / (alpha+beta)`; mirrored by `buildBayesianModelVarFromSlice:90` and the migration | window-family Beta posterior mean | Always present when entry exists. Doc 61: epistemic. |
| `stdev` | computed closed-form from α/β at `bayesPatchService:352-354` | epistemic Beta σ | Doc 61 supersedes doc 49 §A.9 Invariant 5. The card-side display reads this for "what does the model believe about the rate". |
| `alpha`, `beta` | `windowSlice.{alpha, beta}` | window-family epistemic Beta | These are the load-bearing fields for promotion; without them, `applyPromotion` clears `p.posterior`. |
| `n_effective` | `windowSlice.n_effective` (legacy `window_n_effective` accepted on the migration path at `workspaceService:274`) | training-corpus mass behind the window-family Beta | Used by the BE engine doc 52 blend (`m_S / m_G`). Worker emits per slice. |
| `provenance` | `windowSlice.provenance` | source label — "bayesian", "pooled-fallback", "point-estimate", "skipped" | The card-side popover renders this verbatim. Different values gate the quality tier (e.g. `pooled-fallback` typically maps to `gated_warning`). |
| `cohort_alpha`, `cohort_beta` | `cohortSlice.{alpha, beta}` when cohort slice present | cohort-family epistemic Beta | Read by the BE resolver in cohort mode first. Absent on edges with no cohort fit. |
| `cohort_n_effective` | `cohortSlice.n_effective` | training mass for cohort-family | Used by the BE engine doc 52 blend in cohort mode. |
| `cohort_provenance` | `cohortSlice.provenance` (defaults to `'bayesian'` when source field empty) | source label for cohort fit | Same vocabulary as `provenance`. |
| `alpha_pred`, `beta_pred` | `windowSlice.{alpha_pred, beta_pred}` when present | predictive (κ-inflated) Beta | Required for IS conditioning per doc 49. Absent when the worker did not fit κ. |
| `cohort_alpha_pred`, `cohort_beta_pred` | `cohortSlice.{alpha_pred, beta_pred}` when present | predictive cohort-family Beta | Same caveats. |

**Drops/elisions to flag**:

- The migration path at `workspaceService:280-284` accepts `posterior.source_at` then falls back to `posterior.fitted_at` for `bayesEntry.source_at`. `bayesPatchService:479` writes `patch.fitted_at` directly. **No collision risk** but two slightly different conventions for the same field.
- `cohortSlice.n_effective` flows into `cohort_n_effective` only on `bayesPatchService:371` and `buildBayesianModelVarFromSlice:113`. The migration path at `workspaceService:277-279` accepts `cohort_n_effective` from the legacy posterior shape — **but the legacy posterior never carried that field**. So legacy graphs being migrated lose `cohort_n_effective`. **Documented absence on legacy migrations; cohort doc 52 blend correction is unavailable for unrefitted bayesian entries on pre-30-Apr-26 graphs until the next Bayes run.** Severity: low (one-shot, fixes itself on the next fit).

### §4.3 Field-by-field — `latency`

Same field-name conventions as `model_vars[analytic].latency` (post-30-Apr-26 latency v1.1 unification). Doc 61: bare = epistemic, `_pred` = predictive.

| Field | Set by | Provenance | Notes |
|---|---|---|---|
| `mu`, `sigma`, `t95`, `onset_delta_days` | `bayesPatchService:384-388` from window slice; `t95 = exp(mu + 1.645·σ) + onset` recomputed on the way in | window-mode lognormal posterior parameters | `t95` is recomputed because the slice carries (μ, σ) but not necessarily a coherent `t95` field. |
| `mu_sd`, `sigma_sd`, `onset_sd`, `onset_mu_corr` | `bayesPatchService:393-397` from window slice | epistemic posterior SDs (MCMC trace) | Doc 61: bare. |
| `mu_sd_pred` | `bayesPatchService:394` from `windowSlice.mu_sd_pred` | predictive (κ_lat-inflated) | Only when worker fits κ_lat. Used by BE forecast trajectory's predictive band. |
| `path_mu`, `path_sigma`, `path_t95`, `path_onset_delta_days` | `bayesPatchService:399-402` from cohort slice when present | cohort-mode (path) lognormal posterior | `path_t95` recomputed analogously. |
| `path_mu_sd`, `path_sigma_sd`, `path_onset_sd` | `bayesPatchService:403-406` from cohort slice | path-level epistemic | Doc 61: bare. |
| `path_mu_sd_pred` | `bayesPatchService:404` from `cohortSlice.mu_sd_pred` | path-level predictive | Schema declares it on `ModelVarsEntry.latency`. Today the worker doesn't fit a path-level κ, so this is empirically always absent. |
| `path_sigma_sd_pred` | **Not declared on the schema; never written.** | — | Documented absence. |
| `path_onset_mu_corr` | **Not declared on the schema; never written.** | — | The renderer (`PromotedModelCard`'s `ModelRateChart`) reads `pathOnsetMuCorr` via `(lat as any)?.path_onset_mu_corr` (cast, defensive). Reads as `undefined` and the chart treats it as `null`. **Documented absence; flagged as schema-vs-renderer asymmetry, low severity.** |

### §4.4 Field-by-field — `quality`

Bayesian-only. Five fields. **Always populated** when `model_vars[bayesian]` exists.

| Field | Set by | Provenance | Notes |
|---|---|---|---|
| `rhat` | `bayesPatchService:483` from `windowSlice.rhat ?? 0` | MCMC convergence | `meetsQualityGate` reads this. |
| `ess` | `bayesPatchService:484` from `windowSlice.ess` | effective sample size | gate input. |
| `divergences` | `bayesPatchService:485` from `windowSlice.divergences ?? 0` | NUTS divergent transitions | gate input via doc 49 hard floor. |
| `evidence_grade` | `bayesPatchService:486` from `windowSlice.evidence_grade` | 0=cold, 1=weak, 2=mature, 3=full | UI quality tier display. |
| `gate_passed` | `bayesPatchService:487` from `meetsQualityGate(...)` evaluated at write time | precomputed gate result | Read by `resolveActiveModelVars` via `bayesianIfGated()` (doc 73b OP3). **Frozen at write time** — does not re-evaluate when forecast settings or thresholds change. **Flag: latent staleness** — if the user adjusts the gate config in their forecasting settings, existing fits keep their pre-config gate verdicts until refit. (CLAUDE.md `forecasting-settings.md` notes this is known.) |

**Migration path caveat**: `workspaceService:386-407` infers `gate_passed` from the legacy posterior's `provenance` (`true` when `'bayesian'`, `false` otherwise). This is **conservative and pessimistic**: a legacy `pooled-fallback` provenance gets `gate_passed = false`, so promotion falls through to analytic on the migrated graph until the next fit. Correct behaviour, but worth knowing.

### §4.5 Field-by-field — `fit_diagnostics.probability`

Bayesian-only. Empty for unrefitted edges. Sub-block shape declared at `types/index.ts:721-746`.

| Field | Set by | Provenance | Notes |
|---|---|---|---|
| `fitted_at` | `bayesPatchService:414` from `patch.fitted_at` | Bayes fit timestamp | Identical to `entry.source_at` on the same write. |
| `fingerprint` | `bayesPatchService:415` from `patch.fingerprint` | fit identity hash | Used by warm-start invalidation. |
| `prior_tier` | `bayesPatchService:416` from `patchEdge.prior_tier ?? 'uninformative'` | bayes prior tier (doc 27) | UI displays via `PromotedModelCard` popover. |
| `surprise_z` | from `oldPosterior.surprise_z` (migration path); `bayesPatchService` does not write it | doc 55 surprise gauge scalar | **Drop: `bayesPatchService.applyPatch` does not extract `surprise_z` from `windowSlice` even though the worker may emit it. Migration preserves it from legacy `p.posterior`.** Severity: low; surprise gauge has its own engine path. |
| `hdi_lower`, `hdi_upper`, `hdi_level` | `bayesPatchService:418-422` from `windowSlice.{p_hdi_lower, p_hdi_upper}`; `hdi_level` hardcoded to 0.9 | epistemic 90% credible interval on rate | Doc 49. |
| `hdi_lower_pred`, `hdi_upper_pred` | `bayesPatchService:423-426` from `windowSlice.{hdi_lower_pred, hdi_upper_pred}` | predictive 90% interval | Absent when no κ. |
| `cohort_hdi_lower`, `cohort_hdi_upper` | `bayesPatchService:427-430` from `cohortSlice.{p_hdi_lower, p_hdi_upper}` | cohort-family epistemic HDI | |
| `cohort_hdi_lower_pred`, `cohort_hdi_upper_pred` | `bayesPatchService:431-434` from `cohortSlice.{hdi_lower_pred, hdi_upper_pred}` | cohort-family predictive HDI | |
| `delta_elpd`, `pareto_k_max`, `n_loo_obs` | `bayesPatchService:435-439` from windowSlice | LOO-ELPD model adequacy (doc 32) | Used by quality tier engine for `bayesQualityTier.computeQualityTier` warning gate. |
| `ppc_coverage_90`, `ppc_n_obs` | `bayesPatchService:440-443` from windowSlice | PPC calibration on rate (doc 38) | |
| `ppc_traj_coverage_90`, `ppc_traj_n_obs` | `bayesPatchService:444-447` from windowSlice | PPC calibration on trajectory | |

### §4.6 Field-by-field — `fit_diagnostics.latency`

Sub-block shape at `types/index.ts:748-766`.

| Field | Set by | Provenance | Notes |
|---|---|---|---|
| `fitted_at`, `fingerprint` | `bayesPatchService:452-453` | bayes fit identity for latency posterior | Same value as the probability counterparts on the same write. |
| `ess`, `rhat` | `bayesPatchService:454-455` from windowSlice | latency-specific MCMC diagnostics | Distinct from `quality.{ess, rhat}` only nominally — the worker emits the same scalar; the schema duplicates them under both `quality` and `fit_diagnostics.latency`. **Flag: duplicate storage.** |
| `hdi_t95_lower`, `hdi_t95_upper`, `hdi_level` | `bayesPatchService:457-461` from windowSlice | t95 credible interval | UI-bound. |
| `path_hdi_t95_lower`, `path_hdi_t95_upper` | `bayesPatchService:462-465` from cohortSlice | path-level t95 CI | |
| `delta_elpd`, `pareto_k_max`, `n_loo_obs` | `bayesPatchService:466-470` from windowSlice | LOO for latency | Same scalars as `fit_diagnostics.probability.{delta_elpd, ...}`. **Flag: same scalar copied to two sub-blocks because the worker emits one value across the whole fit.** Symptom-free elision. |
| `ppc_traj_coverage_90`, `ppc_traj_n_obs` | `bayesPatchService:471-474` from windowSlice | PPC for trajectory | |

### §4.7 Producer-coverage matrix (which path writes which field)

|  | `bayesPatchService` | `posteriorSliceContexting` | `_migrateBayesian…` |
|---|---|---|---|
| `probability.{mean, stdev, alpha, beta, provenance}` | ✓ | ✓ | ✓ |
| `probability.{n_effective, alpha_pred, beta_pred}` | ✓ | ✓ | ✓ |
| `probability.cohort_*` | ✓ when cohortSlice | ✓ when cohortSlice | ✓ when legacy fields present |
| `latency.{mu, sigma, t95, onset_delta_days}` | ✓ when windowSlice has μ | ✓ when latProj has mu_mean | ✓ when legacy `p.latency.posterior` had mu_mean |
| `latency.{mu_sd, sigma_sd, onset_sd, onset_mu_corr, mu_sd_pred}` | ✓ | ✓ | ✓ |
| `latency.path_*` | ✓ when cohortSlice has μ | ✓ when latProj has path_mu_mean | ✓ when legacy had path_mu_mean |
| `quality.{rhat, ess, divergences, evidence_grade, gate_passed}` | ✓ | ✓ via `liveSliceMeetsQualityGate` | ✓ inferred from provenance (pessimistic) |
| `fit_diagnostics.probability.{fitted_at, fingerprint, prior_tier}` | ✓ | ✓ when fields on slice | ✓ when fields on legacy |
| `fit_diagnostics.probability.surprise_z` | ✗ **drop** | ✗ **drop** | ✓ from legacy |
| `fit_diagnostics.probability.hdi_*` | ✓ when slice has them | ✓ when slice has them | ✓ when legacy had them |
| `fit_diagnostics.probability.{delta_elpd, pareto_k_max, n_loo_obs, ppc_*}` | ✓ when on slice | ✗ **drop** (`buildBayesianModelVarFromSlice` does NOT propagate LOO/PPC) | ✓ when on legacy |
| `fit_diagnostics.latency.*` | ✓ when on slice | ✗ **drop** (`buildBayesianModelVarFromSlice` does NOT populate `latDiag.{delta_elpd, pareto_k_max, n_loo_obs, ppc_traj_*}`) | ✓ when on legacy |

**Two confirmed drops in `posteriorSliceContexting`**:

- **Drop B1**: `buildBayesianModelVarFromSlice:145-184` does not project `delta_elpd`, `pareto_k_max`, `n_loo_obs`, `ppc_*`, `surprise_z` onto `fit_diagnostics`. The slice projection helpers (`projectProbabilityPosterior`/`projectLatencyPosterior`) likely *do* surface these in their output (worth confirming in §5), but the model_vars builder ignores them. **Symptom: after a DSL change, the `PromotedModelCard` popover loses the LOO/PPC display rows; after the next bayes fit they reappear.** Severity: medium — UI degradation that recovers on next refit.
- **Drop B2**: same function does not populate `fit_diagnostics.latency.{delta_elpd, pareto_k_max, n_loo_obs, ppc_traj_*}`. Same symptom on the latency popover.

These are both invisible in the §3.2 producer descriptions because they're functions of what `buildBayesianModelVarFromSlice` chooses to copy across, not what the slice carries. Will be confirmed by reading `projectProbabilityPosterior`/`projectLatencyPosterior` in Phase 5.

### §4.8 Sidecar trail and provenance for bayesian

The full chain for the bayesian source on a fresh fit:

1. The worker (`bayes/worker.py`) runs MCMC, writes `posterior.slices['window()']` and `posterior.slices['cohort()']` onto the parameter file (doc 21 unified posterior schema).
2. The webhook (`bayesPatchService.applyPatch`) loads the patch, normalises slice shape (doc 61 migration shim), and constructs the `model_vars[bayesian]` entry. Calls `upsertModelVars` then `applyPromotion`.
3. On DSL change, `posteriorSliceContexting.contextLiveGraphForCurrentDsl` re-projects from the param file's slices for the active DSL → `buildBayesianModelVarFromSlice` → `upsertModelVars` → `syncBayesianAndPromote` → `applyPromotion`.
4. On file load (workspaceService), the migration runs idempotently to upgrade legacy `p.posterior` graphs → `model_vars[bayesian]`.
5. `applyPromotion` projects:
   - `model_vars[bayesian].probability.{mean, stdev, alpha, beta, alpha_pred, beta_pred, cohort_*, n_effective, provenance, cohort_provenance}` → `p.posterior` (post-30-Apr-26 source-agnostic surface) + `p.forecast.{mean, stdev, source}`.
   - `model_vars[bayesian].latency.{mu, sigma, t95, onset_*, mu_sd, sigma_sd, onset_sd, onset_mu_corr, mu_sd_pred, path_*}` → `p.latency.posterior` (post-30-Apr-26 latency v1.1 source-agnostic surface, with mu→mu_mean rename) + `p.latency.{mu, sigma, promoted_t95, promoted_onset_*, promoted_*_sd}`.
   - `model_vars[bayesian].{quality, fit_diagnostics}` are **not** projected by `applyPromotion` — they stay on the source ledger entry. Consumers (PromotedModelCard popover, BE resolver gate check) read them via `model_vars.find(s => s.source === 'bayesian')`.

A field is "live" for bayesian if and only if at least one producer (1, 3, or 4 — depending on circumstance) wrote it AND the consumer either reads from `model_vars[bayesian]` directly (quality, fit_diagnostics) or via the promoted projection (probability, latency).



---

## §5. Translation / upsert / projection layers

### §5.1 `upsertModelVars` (entry-level upsert)

`modelVarsResolution.ts:499-507`. Two-line implementation: finds an entry by `source`, replaces in place if present, pushes if absent. Initialises `p.model_vars = []` when missing. **Replace-not-merge semantics** — every caller must pass a fully-formed entry.

Callers (post-30-Apr-26):

- `bayesPatchService.applyPatch:495` (bayesian fresh write)
- `posteriorSliceContexting.syncBayesianAndPromote:270` and `posteriorSliceContexting.contextProbabilityBlock` callers (bayesian DSL re-projection)
- `fileToGraphSync.ts:2001` (analytic fresh write)
- `fetchDataService.ts:2151` (analytic horizon bootstrap)
- `_migrateBayesianPosteriorToSourceLedgerInPlace` does NOT use `upsertModelVars` — it pushes directly with the sentinel "skip when probability.alpha is already set" guard.

**Asymmetry**: there is no `upsertModelVars`-equivalent for the `analytic` latency-only mutation path at `fileToGraphSync.ts:2003-2044`; that path uses `findIndex` + `array[idx] = { ...prev, latency: merged }` directly. Same for `UpdateManager.applyBatchLAGValues:2184` which mutates `analyticEntry.latency.*` in place. **Documented choice** to avoid replacing a probability block; both are intentional in-place mutations.

### §5.2 `applyPromotion` (single L1.5 / L2 writer)

`modelVarsResolution.ts:310-395`. Reads the active `ModelVarsEntry` via `resolveActiveModelVars` (governed by `effectivePreference` of edge × graph preference) and projects fields onto the L1.5 / L2 surfaces.

**Writes (active source resolved with `result.posterior` present)**:

| Target field | Source on `result` | Notes |
|---|---|---|
| `p.forecast.mean` | `result.mean` | Skipped when not finite (preserve upstream). |
| `p.forecast.stdev` | `result.stdev` | Skipped when not finite. |
| `p.forecast.source` | `result.activeSource` | Always set when entry resolved. |
| `p.posterior.{distribution: 'beta', alpha, beta, alpha_pred, beta_pred, cohort_alpha, cohort_beta, cohort_alpha_pred, cohort_beta_pred, n_effective, cohort_n_effective, provenance, cohort_provenance}` | `result.posterior` (from `entry.probability` projection at `promoteModelVars:208-224`) | Atomic replace — either the full block lands or the field is cleared. |
| `p.latency.posterior.{distribution: 'lognormal', mu_mean, sigma_mean, mu_sd, sigma_sd, mu_sd_pred, onset_delta_days, onset_sd, onset_mu_corr, path_mu_mean, path_sigma_mean, path_mu_sd, path_sigma_sd, path_mu_sd_pred, path_onset_delta_days, path_onset_sd, provenance, path_provenance}` | `result.latency_posterior` (from `entry.latency` projection at `promoteModelVars:241-262`, post-30-Apr-26 latency v1.1 source-agnostic) | Atomic replace. Initialises `p.latency = {}` if missing. |
| `p.latency.{mu, sigma, path_mu, path_sigma, promoted_t95, promoted_path_t95, promoted_onset_delta_days, promoted_*_sd, promoted_onset_mu_corr, path_onset_delta_days}` | `result.latency.{mu, sigma, path_mu, path_sigma, t95, path_t95, onset_delta_days, *_sd, onset_mu_corr}` | Per-field guarded writes (skips `undefined`). The user-input `p.latency.onset_delta_days` is also overwritten unless `onset_delta_days_overridden === true`. |

**Clears (no entry resolved or `result` missing fields)**:

- `clearPromotedSurfaces` (lines 282-294) clears `p.forecast.source`, `p.posterior` (if present), and `p.latency.posterior` (if present).
- When `result.posterior` absent: `p.posterior = undefined`.
- When `result.latency_posterior` absent: `p.latency.posterior = undefined` (only if it existed).

**Critical invariant** (from inline comment at line 304): "after this call, `p.posterior` and `p.latency.posterior` reflect the active selector exactly. They are never left stale from a prior promotion."

### §5.3 UpdateManager file→graph cascade

`updateManager/mappingConfigurations.ts`. Maps fields between parameter file structures and graph edge `p` block during fetches.

**Posterior-related rows (post-30-Apr-26 unification)**:

Lines 783-803 of mappingConfigurations.ts document explicitly: "entries that previously projected `posterior.slices` onto `p.posterior` and `p.latency.posterior` directly have been removed." File-side bayesian posteriors no longer cascade onto the graph edge through this path. Instead:

- `bayesPatchService.applyPatch` is the sole writer of `model_vars[bayesian]` from a fresh patch.
- `posteriorSliceContexting.contextProbabilityBlock` is the sole writer of `model_vars[bayesian]` on DSL change (reads from `parameterFile.posterior.slices`).
- `_migrateBayesianPosteriorToSourceLedgerInPlace` handles legacy graphs that still carry the pre-unification `p.posterior` shape on first load.

Lines 1115-1151 of `UpdateManager.ts` (in `updateGraphFromParameter`): the cascade no longer mints `model_vars[analytic]` from file-side `latestValue.forecast` / `forecast_stdev`. Instead, when the file carries `latency.{mu, sigma}`, those values are shipped to the caller as `result.metadata.analyticLatencyFromFile` for `fileToGraphSync.ts` to attach to the analytic entry it builds from the freshness sidecar.

**Net effect**: the file→graph cascade no longer touches `model_vars[*]` directly. The two model_vars writers are `bayesPatchService` (bayesian) and `fileToGraphSync.ts` (analytic) plus their supporting paths.

### §5.4 Workspace-load migration (`_migrateBayesianPosteriorToSourceLedgerInPlace`)

Covered in §4.1 producer 3 and §4.2/§4.4/§4.5/§4.6 field tables. Summary:

- Triggers at file-load time in `workspaceService.ts:888`.
- Reads legacy `p.posterior` (rate Beta + bayesian metadata) and `p.latency.posterior` (lognormal posterior + bayesian metadata) and re-shapes into the post-unification `model_vars[bayesian].{probability, latency, quality, fit_diagnostics}` structure.
- Idempotent (skips when `model_vars[bayesian].probability.alpha != null`).
- Sets `isDirty: true` on the FileState so the migrated shape persists across save/reload.
- Logs `POSTERIOR_UNIFICATION_MIGRATION` to session log.

**Confirmed migration drops** (fields that exist on legacy `p.posterior` shape but are not propagated onward):

- None — the migration is conservative; it copies every legacy field onto the new structure if it was on the old one. The only loss is `cohort_n_effective` for legacy graphs that never had it, which is a documented absence rather than a migration drop.

### §5.5 Transport stripping (`bayesGraphRuntime.ts`)

`stripBayesRuntimeFieldsFromGraphInPlace` and `cloneGraphWithoutBayesRuntimeFields`. Strip the underscore-prefixed transport-only fields:

| Field path | Purpose | Stripped at |
|---|---|---|
| `edge._bayes_evidence` | Bayes submission payload | every persistence boundary |
| `edge._bayes_priors` | Bayes submission payload | same |
| `edge.p._posteriorSlices` | FE re-projection cache used by engorgement | same |
| `edge.p.latency.__parityEvidence` | parity diagnostic | same |
| `edge.p.latency.__parityComputedT95Days` | parity diagnostic | same |

**Confirmed**: the stripper does **not** touch `model_vars[*]`, `p.posterior`, or `p.latency.posterior`. Model-vars round-trip intact through:

- File save / IDB write (`fileRegistry.updateFile`)
- Git commits (graph file in IDB is the source of truth)
- Share bundles
- CLI snapshot exports
- Bayes submission graph (engorgement clones the graph and strips runtime fields, but model_vars are preserved)
- CF submission graph (same)

**No drops at the persistence boundary.**

### §5.6 Layer-flow summary diagram (text)

```
┌─────────────────────────┐    ┌──────────────────────────────┐
│ Bayes worker (offline)  │    │ FE topo Step 1 + addEvidence  │
│ writes posterior.slices │    │ ForecastScalars                │
│ on parameter file       │    │ writes __fresh_analytic_       │
└────────────┬────────────┘    │ probability sidecar            │
             │                  └─────────────┬─────────────────┘
             │                                │
             ↓                                ↓
┌─────────────────────────┐    ┌──────────────────────────────┐
│ bayesPatchService       │    │ fileToGraphSync               │
│ + posteriorSliceContext │    │ (probability+latency branch)  │
│ ing                     │    │ (latency-only branch)         │
│   ↳ upsertModelVars     │    │ + horizon bootstrap            │
│   ↳ applyPromotion      │    │   ↳ upsertModelVars            │
└─────────────────────────┘    │   ↳ applyPromotion             │
             │                  └─────────────┬─────────────────┘
             │  (writes                       │
             │  model_vars[bayesian])         │  (writes model_vars[analytic])
             ↓                                ↓
              ┌──────────────────────┐
              │  edge.p.model_vars   │  ← workspaceService one-shot migration on load
              └──────────┬───────────┘     also writes model_vars[bayesian]
                         │
                         ↓
              ┌──────────────────────┐
              │  applyPromotion      │  ← reads active entry (resolveActiveModelVars)
              │  (single L1.5/L2     │
              │   writer)            │
              └──────────┬───────────┘
                         │
       ┌─────────────────┼──────────────────────┐
       ↓                 ↓                      ↓
┌─────────────┐  ┌────────────────┐  ┌────────────────────────┐
│ p.forecast  │  │ p.posterior    │  │ p.latency.posterior +   │
│ {mean,stdev,│  │ {alpha, beta,  │  │ p.latency.{mu, sigma,   │
│  source}    │  │  cohort_*,     │  │  promoted_t95, …}       │
│             │  │  alpha_pred, …}│  │                         │
└─────────────┘  └────────────────┘  └────────────────────────┘
                         │                      │
                         ↓                      ↓
              ┌──────────────────────────────────────────┐
              │  Consumers (Phase 3): FE topo Step 2,    │
              │  BE CF, ModelCard, PromotedModelCard     │
              └──────────────────────────────────────────┘
```



---

## §6. Per-field flow tables

For each field, a row tracing producer → upsert → promotion projection → which consumers read it. Cell legend: ✓ = read/written; ✗ = drop (no write OR no read); ⚠ = elision/ambiguity (semantic concern); ⊝ = source-conditional behaviour; — = not applicable (field doesn't exist on this source / surface).

Column legend across §6.1–§6.4:

- **A.fE** = analytic producer fileToGraphSync.ts:1937 (probability+latency branch)
- **A.bs** = analytic producer fetchDataService.ts:2030 (horizon bootstrap)
- **A.um** = UpdateManager.applyBatchLAGValues:2184 (FE topo Step 1 mutation)
- **B.bp** = bayesPatchService.applyPatch
- **B.sc** = posteriorSliceContexting.contextProbabilityBlock + buildBayesianModelVarFromSlice
- **B.mig** = workspaceService._migrateBayesianPosteriorToSourceLedgerInPlace
- **AP** = applyPromotion projection (writes `p.posterior` / `p.latency.posterior` / `p.forecast` / promoted scalars)
- **C.fe** = FE topo Step 2 / blend consumer
- **C.cf** = BE CF (resolve_model_params + compute_forecast_trajectory + applyConditionedForecastToGraph)
- **C.mc** = ModelCard (per-source view)
- **C.pmc** = PromotedModelCard (active-source view, via merged views)

### §6.1 `model_vars[analytic].probability`

| Field | A.fE | A.bs | A.um | AP projects to | C.fe | C.cf | C.mc | C.pmc |
|---|---|---|---|---|---|---|---|---|
| `mean` | ✓ via `buildAnalyticProbabilityBlock` | ✓ via `latestValue.forecast` (mean-only) | ✓ from `update.forecast.mean` | `p.forecast.mean`, `p.posterior.mean` (computed) | ✓ via `p.forecast.mean` | ✓ via `p.forecast.mean` (resolver fallback) and α/(α+β) | ✓ direct from entry | ⊝ via `p.posterior.alpha/beta` closed form |
| `stdev` | ✓ from `forecastStdevComputed = sqrt(p(1-p)/N)` | ✗ never written by bootstrap | ✗ not in `update.forecast` schema | `p.forecast.stdev` | ✗ not consumed by blend | ✗ resolver derives from α/β | ✓ direct from entry | ⊝ via Beta closed form |
| `alpha` | ✓ via `momentMatchAnalyticBeta` | ⊝ preserved from existing entry only | ✗ | `p.posterior.alpha` | ✗ | ✓ via `posterior_block.alpha` (preferred) and `_src.prob_alpha` (fallback) | ✗ never displayed by card | ✓ direct read |
| `beta` | ✓ same | ⊝ same | ✗ | `p.posterior.beta` | ✗ | ✓ same | ✗ | ✓ |
| `n_effective` | ✓ from sidecar `weighted_n` (with moment-match fallback) | ⊝ preserved from existing | ✗ | `p.posterior.n_effective` | ✗ | ✓ via `_src.prob_n_effective` (preferred) and posterior_block fallback | ✗ | ✗ shown nowhere |
| `provenance` | ✓ default `'analytic_window_baseline'` | ⊝ preserved | ✗ | `p.posterior.provenance` | ✗ | ✓ part of `ResolvedModelParams.provenance` | ✓ display `entry.probability.provenance` | ✓ display |
| `cohort_alpha`, `cohort_beta`, `cohort_alpha_pred`, `cohort_beta_pred`, `cohort_n_effective`, `cohort_provenance` | ✗ never written by analytic | ✗ | ✗ | — (analytic doesn't emit cohort family) | — | ⊝ resolver in cohort mode falls through to window-family α/β | — | ⚠ when active = analytic in cohort mode, popover shows window-family Beta in the path column slot |
| `alpha_pred`, `beta_pred` | ✓ from `momentMatchAnalyticBeta(mean, stdev_pred)` (Pearson κ overdispersion) | ✗ | ✗ | `p.posterior.alpha_pred`, `p.posterior.beta_pred` | ✗ | ✓ via `_src.prob_alpha_pred` fallback (analytic-only branch) | ✗ | ✗ shown nowhere |

### §6.2 `model_vars[analytic].latency`

| Field | A.fE | A.bs | A.um | AP projects to | C.fe | C.cf | C.mc | C.pmc |
|---|---|---|---|---|---|---|---|---|
| `mu` | ✓ from `analyticLatencyFromFile` | ✓ from `computeEdgeLatencyStats` | ✓ from `updLat.mu` | `p.latency.mu`, `p.latency.posterior.mu_mean` | ⊝ via `p.latency.{mu, posterior.mu_mean}` for the LAG fit fallback | ✓ via resolver → trajectory | ✓ direct | ✓ via `p.latency.posterior.mu_mean` |
| `sigma` | ✓ same | ✓ same | ✓ same | `p.latency.sigma`, `p.latency.posterior.sigma_mean` | ⊝ same | ✓ same | ✓ | ✓ |
| `t95` | ✓ from file | ✓ computed | ✓ from `updLat.t95` (lands on `promoted_t95`) | `p.latency.promoted_t95` | ✓ via `p.latency.t95` (user-input) and via `promoted_t95` indirectly | ✓ via resolver | ✓ direct (entry.latency.t95) | ✓ via `t95` prop (now from `promoted_t95`) |
| `onset_delta_days` | ✓ | ✓ | ✓ | `p.latency.promoted_onset_delta_days` (and copies to `onset_delta_days` unless overridden) | ⊝ | ✓ | ✓ | ✓ |
| `path_mu`, `path_sigma`, `path_t95`, `path_onset_delta_days` | ✓ when on file | ⚠ usually absent on bootstrap | ✓ from `updLat.path_*` | `p.latency.{path_mu, path_sigma, promoted_path_t95, path_onset_delta_days}`; `p.latency.posterior.path_*_mean` | ⊝ | ✓ when scope='path' | ✓ direct | ✓ |
| `mu_sd`, `sigma_sd`, `onset_sd`, `onset_mu_corr` | ✗ not on file format | ✗ not produced by bootstrap | ✓ from `updLat.{mu_sd, sigma_sd, onset_sd, onset_mu_corr}` | `p.latency.promoted_*_sd` and `p.latency.posterior.*_sd` | ✗ not consumed by blend | ✓ via resolver (epistemic) | ✓ direct | ✓ via posterior projection |
| `mu_sd_pred` | ✗ not produced by analytic source | — | — | — | — | — falls back to `mu_sd` | — | — |
| `path_mu_sd`, `path_sigma_sd`, `path_onset_sd` | ✗ | ✗ | ✓ from `updLat.path_*_sd` | promoted + path posterior | ✗ | ✓ when path scope | ✓ | ✓ |

### §6.3 `model_vars[analytic].quality`, `fit_diagnostics`

`model_vars[analytic].quality` is **never written** by any analytic producer. **Documented absence (analytic has no fit-time MCMC diagnostics).** No row table.

`model_vars[analytic].fit_diagnostics` is **never written**. **Documented absence.** No row table.

### §6.4 `model_vars[bayesian].probability`

| Field | B.bp | B.sc | B.mig | AP projects to | C.fe | C.cf | C.mc | C.pmc |
|---|---|---|---|---|---|---|---|---|
| `mean` | ✓ from α/(α+β) | ✓ same | ✓ same | `p.forecast.mean`, `p.posterior.mean` | ✓ via `p.forecast.mean` | ⊝ resolver derives from α/β | ✓ direct | ⊝ via Beta closed form |
| `stdev` | ✓ closed-form Beta σ | ✓ | ✓ | `p.forecast.stdev`, `p.posterior.stdev` | ✗ | ⊝ derived | ✓ direct | ⊝ |
| `alpha`, `beta` | ✓ from windowSlice | ✓ from probProj | ✓ from legacy posterior | `p.posterior.{alpha, beta}` | ✗ | ✓ via posterior_block primary path | ✗ | ✓ |
| `n_effective` | ✓ from windowSlice when present | ✓ same | ⚠ inferred from `n_effective` or `window_n_effective` legacy alias | `p.posterior.n_effective` | ✗ | ✓ via `_src.prob_n_effective` first, fallback to `posterior_block.{n_effective, window_n_effective}` | ✗ | ✗ |
| `provenance` | ✓ from windowSlice (`'bayesian'`/`'pooled-fallback'`/etc.) | ✓ same | ✓ from legacy `oldPosterior.provenance` | `p.posterior.provenance` | ✗ | ✓ part of resolved | ✓ display footer | ✓ display |
| `cohort_alpha`, `cohort_beta`, `cohort_provenance` | ✓ from cohortSlice when present | ✓ same | ✓ when on legacy | `p.posterior.cohort_*` | ✗ | ✓ via posterior_block.cohort_* (cohort mode primary) | ✗ | ✓ |
| `cohort_n_effective` | ✓ when on cohortSlice | ✓ when on cohortProj | ⚠ legacy posterior never carried this — drop on legacy migrations | `p.posterior.cohort_n_effective` | ✗ | ✓ via `_src.prob_cohort_n_effective` first | ✗ | ✗ |
| `alpha_pred`, `beta_pred` | ✓ when worker emits κ | ✓ same | ✓ when on legacy | `p.posterior.{alpha_pred, beta_pred}` | ✗ | ✓ via posterior_block.{cohort_alpha_pred, alpha_pred} | ✗ | ⊝ via Beta closed form (predictive band) |
| `cohort_alpha_pred`, `cohort_beta_pred` | ✓ when on cohortSlice | ✓ same | ✓ when on legacy | `p.posterior.cohort_*_pred` | ✗ | ✓ cohort mode primary | ✗ | ⊝ |

### §6.5 `model_vars[bayesian].latency`

| Field | B.bp | B.sc | B.mig | AP projects to | C.fe | C.cf | C.mc | C.pmc |
|---|---|---|---|---|---|---|---|---|
| `mu`, `sigma`, `onset_delta_days`, `t95` | ✓ from windowSlice (t95 recomputed) | ✓ from latProj | ✓ from legacy `p.latency.posterior` | `p.latency.{mu, sigma, promoted_t95, promoted_onset_*}` and `p.latency.posterior.{mu_mean, sigma_mean, ...}` | ⊝ | ✓ via resolver (model_vars first, then posterior surface) | ✓ direct | ✓ via posterior projection |
| `mu_sd`, `sigma_sd`, `onset_sd`, `onset_mu_corr` | ✓ from windowSlice | ✓ same | ✓ from legacy | promoted_*_sd + posterior_*_sd | ✗ | ✓ via resolver | ✓ | ✓ |
| `mu_sd_pred` | ✓ from windowSlice when worker fits κ_lat | ✓ same | ✓ from legacy | `p.latency.posterior.mu_sd_pred` | ✗ | ✓ via resolver (predictive primary) | ✓ direct | ✓ |
| `path_mu`, `path_sigma`, `path_t95`, `path_onset_delta_days` | ✓ from cohortSlice | ✓ from latProj.path_*_mean | ✓ from legacy `path_mu_mean` etc. | `p.latency.{path_mu, path_sigma, promoted_path_t95, ...}` and `p.latency.posterior.path_*_mean` | ⊝ | ✓ when scope='path' | ✓ direct | ✓ |
| `path_mu_sd`, `path_sigma_sd`, `path_onset_sd` | ✓ from cohortSlice | ✓ same | ✓ from legacy | promoted_path_*_sd + posterior path | ✗ | ✓ when scope='path' | ✓ | ✓ |
| `path_mu_sd_pred` | ✓ when on cohortSlice | ✓ same | ✓ from legacy | `p.latency.posterior.path_mu_sd_pred` | ✗ | ✓ when scope='path' | ✓ direct | ⚠ schema-vs-renderer asymmetry — renderer reads via cast, low severity |
| `path_onset_mu_corr` | ✗ not declared on schema | ✗ | ✗ | — | — | — | ⚠ renderer reads via cast `(lat as any)?.path_onset_mu_corr` — falls back to null | ⚠ same |

### §6.6 `model_vars[bayesian].quality`

| Field | B.bp | B.sc | B.mig | AP projects to | C.fe | C.cf | C.mc | C.pmc |
|---|---|---|---|---|---|---|---|---|
| `rhat` | ✓ from windowSlice | ✓ same | ✓ from legacy | ✗ not projected onto promoted surface | ✗ | ⊝ resolver reads via mv lookup for `gate_passed` only | ✓ display footer | ✓ display via merged view |
| `ess` | ✓ | ✓ | ✓ | ✗ | ✗ | ⊝ same | ✓ | ✓ |
| `divergences` | ✓ | ✓ | ✓ | ✗ | ✗ | ✗ | ✗ | ✓ via merged view (advanced popover) |
| `evidence_grade` | ✓ | ✓ | ✓ | ✗ | ✗ | ✗ | ✓ display tier label | ✓ |
| `gate_passed` | ✓ at write time via `meetsQualityGate` | ✓ via `liveSliceMeetsQualityGate` | ⚠ inferred from legacy provenance (pessimistic) | ✗ not projected | ✗ | ✓ read by `resolveActiveModelVars` upstream of resolver | ✓ via `computeQualityTier` | ✓ via merged view |

**Key**: `quality.*` is never projected onto promoted surfaces. Consumers that want it read `model_vars[bayesian].quality` directly. ModelCard does this directly; PromotedModelCard goes through the merged view. **Documented architectural choice.**

### §6.7 `model_vars[bayesian].fit_diagnostics`

Two sub-blocks: `.probability` and `.latency`. None are projected by `applyPromotion` onto promoted surfaces. Per-source consumer access only.

| Field group | B.bp | B.sc | B.mig | C.mc | C.pmc |
|---|---|---|---|---|---|
| `probability.{fitted_at, fingerprint, prior_tier}` | ✓ | ✓ | ✓ | ✗ | ✓ via merged view |
| `probability.surprise_z` | ✗ **drop** (worker may emit, patch service does not propagate) | ✗ same | ✓ from legacy | ✗ | ✓ when present (only on legacy-migrated graphs) |
| `probability.{hdi_lower, hdi_upper, hdi_level, hdi_*_pred, cohort_hdi_*, cohort_hdi_*_pred}` | ✓ when on slice | ✓ when on slice | ✓ from legacy | ✗ | ✓ HDI rows in popover |
| `probability.{delta_elpd, pareto_k_max, n_loo_obs}` | ✓ | ✗ **drop B1** (`buildBayesianModelVarFromSlice` does not propagate) | ✓ from legacy | ✗ | ✓ LOO badges; **disappear after DSL change until next Bayes refit** |
| `probability.{ppc_coverage_90, ppc_n_obs, ppc_traj_coverage_90, ppc_traj_n_obs}` | ✓ | ✗ **drop B1** | ✓ from legacy | ✗ | ✓ PPC badges; **same DSL-change disappearance** |
| `latency.{fitted_at, fingerprint, ess, rhat, hdi_t95_*, path_hdi_t95_*, hdi_level}` | ✓ | ✓ when on latProj | ✓ from legacy | ✗ | ✓ |
| `latency.{delta_elpd, pareto_k_max, n_loo_obs, ppc_traj_*}` | ✓ | ✗ **drop B2** (`buildBayesianModelVarFromSlice` does not populate `latDiag.{delta_elpd, pareto_k_max, n_loo_obs, ppc_traj_*}`) | ✓ from legacy | ✗ | ✓ LOO/PPC badges on latency popover; **same DSL-change disappearance** |

### §6.8 Cross-reference summary

Every field on every source has been mapped to its producers (3 analytic, 3 bayesian) and four consumers. The drops, elisions, and asymmetries fall into five distinct shapes; they will be catalogued in §8.



---

## §7. Consumer maps

### §7.1 Consumer A — FE topo Step 2 (FE quick-pass blend)

Entry: `statisticalEnhancementService.enhanceGraphLatencies` → `computeBlendedMean` / `computePerDayBlendedMean`. Writes the L5 current-answer scalars: `edge.p.mean`, `edge.p.stdev`, `edge.p.latency.completeness`, `edge.p.latency.completeness_stdev`.

**Field reads from `model_vars[*]`**: **none directly**. The blend reads exclusively from the **promoted L2 scalar surface** that `applyPromotion` projects:

| Reads from | Used for |
|---|---|
| `edge.p.forecast.mean` (L2, promoted from `model_vars[active].probability.mean`) | The forecast-side of the blend (`forecastMean`) — line 2477 (`enhanceGraphLatencies` fallback chain `edge.p.forecast.mean ?? edge.p.mean`), line 2995 (the value placed onto `EdgeLAGValues.forecast.mean`), and the `BlendInputs.forecastMean` parameter to `computeBlendedMean`. |
| `edge.p.evidence.{mean, n, k}` (L4, query-scoped) | The evidence-side of the blend. Read at lines 3000-3004, 3477-3479. |
| `edge.p.latency.t95` (user-input field, NOT `promoted_t95`) | LAG fitting constraint (line 2306) — when present and finite, the topo pass uses the user-set t95 as authoritative input. |
| `edge.p.latency.{mu, sigma, onset_delta_days}` (L2 promoted) | Read indirectly via the LAG fit pipeline (`computeEdgeLatencyStats` etc.) when the file's analytic latency is empty and the topo pass re-fits. |

**No direct `model_vars` reach-through.** Step 2 trusts that `applyPromotion` has correctly projected. **A promotion gap surfaces here as a wrong/missing forecast in the blend output.**

**Drops/elisions**:

- The blend reads `p.forecast.mean` as the promoted forecast; if `applyPromotion` clears it (no source resolved, e.g. edge has empty `model_vars`), the blend reads `edge.p.mean` as a fallback at line 2477. **Risk**: in some edge bootstrap cases (legacy fixtures), `edge.p.mean` is the previous fetch's L5 current-answer scalar — circularly using L5 to compute L5. **Flag: latent feedback loop.** Severity: low; in production paths the sidecar always supplies `forecast.mean` before the blend runs.
- Step 2 does **not** consume any of the predictive (`alpha_pred`, `beta_pred`) or epistemic Beta (`alpha`, `beta`) fields. The blend formula uses `forecastMean` and `evidenceMean` as scalars only; the conjugate update is on the prior pseudo-count `m₀ = λ·nBaseline` (where `nBaseline` is read from `forecast.k` per `BlendInputs.nBaseline`). **Documented absence; the FE topo blend is intentionally narrower than the BE CF conjugate update.**

### §7.2 Consumer B — BE CF (slow-pass)

Three sub-stages:

**§7.2.1 `resolve_model_params` (TS request graph → ResolvedModelParams)**

`graph-editor/lib/runner/model_resolver.py:206+`. Reads from the request graph's `edge.p` block:

| Resolver target | Read order (stops at first match) | Notes |
|---|---|---|
| `mu, sigma, onset_delta_days, t95` | (1) `_src.{mu, sigma, onset_delta_days, t95}` from `model_vars[promoted_source].latency`; (2) fallback `lat_posterior.{mu_mean, sigma_mean, onset_delta_days, ...}` (= `p.latency.posterior`); (3) fallback `latency_block.{mu, sigma, ...}` (= `p.latency.{mu, sigma, promoted_t95}`) | model_vars first, posterior surface second, flat scalars last |
| `mu_sd, sigma_sd, onset_sd, onset_mu_corr, mu_sd_pred` | Same chain (model_vars first, posterior surface second) | Per-field guards drop missing scalars |
| `path_mu, path_sigma, path_t95, path_onset_*, path_*_sd` | Same chain when `scope === 'path'` | Read at lines 328-385 |
| `alpha, beta` | (1) `posterior_block.{cohort_alpha, cohort_beta}` (cohort mode), then `posterior_block.{alpha, beta}` (line 399-414); (2) fallback to `_src.{prob_cohort_alpha, prob_cohort_beta, prob_alpha, prob_beta}` (lines 425-449) | **posterior_block first, model_vars second — INVERTED relative to latency** |
| `alpha_pred, beta_pred` | (1) `posterior_block.{cohort_alpha_pred, alpha_pred}` (lines 535-548); (2) fallback to `_src.{prob_cohort_alpha_pred, prob_alpha_pred}` (analytic only) | Same posterior-first order as α/β |
| `n_effective` | (1) `_src.{prob_cohort_n_effective, prob_n_effective}` from model_vars (lines 498-508); (2) fallback to `posterior_block.{cohort_n_effective, n_effective, window_n_effective}` (lines 510-522) | **model_vars first, posterior_block second — opposite of α/β path** |
| `provenance / fitted_at / gate_passed` | model_vars[promoted].{source_at, quality.gate_passed} directly (lines 575-583) | Single read, no fallback |

**Critical inconsistency** (already flagged in §5.2 narrative): the resolver's read order is **inconsistent across surfaces**:

- Latency path: `model_vars[active]` first, posterior_surface second.
- Rate Beta (α, β, α_pred, β_pred): `posterior_block` first, model_vars[active] second.
- `n_effective`: `model_vars[active]` first, posterior_block second.

**Severity: medium. Symptom: structural confusion when debugging which read won; if `applyPromotion` wrote the rate Beta correctly into `p.posterior` AND `model_vars[active]` carries the same Beta, both branches return the same answer, so the inconsistency is invisible. But on un-promoted graphs (CLI inputs that bypass applyPromotion, or fixtures that populate model_vars but not p.posterior, or vice versa), the two branches can return different answers per surface.**

The post-unification plan §7 recommended reordering the resolver so all surfaces read model_vars first. That recommendation has been applied to **latency** and **n_effective** but NOT to **rate α/β/α_pred/β_pred**. **Documented incomplete reorder.**

**§7.2.2 `compute_forecast_trajectory` (CF inner kernel)**

`graph-editor/lib/runner/forecast_state.py:866+`. Consumes `ResolvedModelParams` (the structured output of `resolve_model_params`). Field reads from the resolved params:

| Reads | Used for | Notes |
|---|---|---|
| `resolved.alpha, resolved.beta` | epistemic prior in the conjugate update step | Returns midline only when both are zero. |
| `resolved.alpha_pred, resolved.beta_pred` | predictive Beta — proposal distribution for IS draws (line 990) | When absent, falls back to epistemic α/β via `ResolvedModelParams` getter convention. |
| `resolved.n_effective` | engine doc 52 blend correction (`m_S / m_G`) | When absent, blend correction is a no-op. |
| `resolved.latency.{mu, sigma, onset_delta_days}` | edge-level lognormal CDF for the per-cohort sweep | Always required for latency edges. |
| `resolved.latency.{mu_sd_pred, sigma_sd, onset_sd, onset_mu_corr}` | predictive parameter dispersion for the MC sweep | `mu_sd_pred` falls back to `mu_sd` when absent. |
| `resolved.path_latency.{path_mu, path_sigma, path_*_sd, ...}` | upstream carrier construction in cohort mode | Only when `scope === 'path'` and a path-level posterior was resolved. |

**Drops/elisions**:

- `compute_forecast_trajectory` does NOT read `model_vars[bayesian].fit_diagnostics.*` — the LOO/PPC/HDI fields don't influence the MC sweep. **Documented absence; bayesian metadata is for human consumption (popover), not engine.**
- `compute_forecast_trajectory` does NOT read `model_vars[*].quality.gate_passed`. The gate has already been honoured by `resolveActiveModelVars` upstream (in the FE) before the request graph is built. **Documented architectural separation.**

**§7.2.3 `applyConditionedForecastToGraph` (CF response → graph apply)**

`graph-editor/src/services/conditionedForecastService.ts:188+`. Receives the per-edge CF response and writes back. Field writes:

| Target | Source | Notes |
|---|---|---|
| `edge.p.mean` (L5) | `edge.p_mean` from CF response | Set on the live edge via `applyBatchLAGValues` merge. |
| `edge.p.stdev` (L5, epistemic) | `edge.p_sd_epistemic` from CF response | Doc 61: bare = epistemic. |
| `edge.p.stdev_pred` (L5, predictive) | `edge.p_sd` from CF response (which is predictive in the CF naming) | Doc 49 → doc 61 naming flip at the boundary. |
| `edge.p.latency.completeness` (L5) | `edge.completeness` from CF response (fallback to existing `lat.completeness`) | CF-authored per doc 45. |
| `edge.p.latency.completeness_stdev` (L5) | `edge.completeness_sd` (fallback to existing) | CF-authored. |
| `edge.p.evidence.{n, k}` (L4) | `edge.evidence_n`, `edge.evidence_k` | When present on response. |

**Field writes NOT performed** (per the sentinel test `cfFieldMappingSentinel.test.ts` and the §6 of the unification plan):

- `edge.p.forecast.{mean, stdev, source}` — owned by `applyPromotion`. Stage 4(c) of doc 73b removed the legacy `p_mean → p.forecast.mean` write.
- `edge.p.posterior.*` — owned by `applyPromotion`.
- `edge.p.latency.posterior.*` — owned by `applyPromotion`.
- `edge.p.model_vars[*].*` — never touched by CF. CF runs query-scoped; model_vars are aggregate.

**Drops/elisions**:

- `p_sd` and `p_sd_epistemic` are returned on the CF response but the projector at line 188 only writes `p.stdev` and `p.stdev_pred` for **single-edge CF**. In **whole-graph** CF (`fetchDataService.ts` Stage 2), the projector at the merge point (`mergeCfIntoFe` in `fetchDataService.ts`) merges these into `EdgeLAGValues` for `applyBatchLAGValues`. **Pinned by `cfFieldMappingSentinel.test.ts`**; **documented in `FORECAST_STACK_DATA_FLOW.md` I12**.
- The CF response carries `tau_max`, `n_rows`, `n_cohorts`, `conditioning{r, m_S, m_G, applied, skip_reason}`, `cf_mode`, `cf_reason` — all returned but **none are persisted to the graph edge**. They are diagnostic-only. **Documented absence; consumers that need them read directly from the response.**

### §7.3 Consumer C — `ModelCard`

`graph-editor/src/components/analytics/ModelCard.tsx`. Renders one card per `ModelVarsEntry`. Used by `ModelVarsCards` (the edge-props panel "Source Cards").

**Reads** (per the contract pinned in the spark-chart audit, this audit's own §7.3, and the docstring at `ModelCard.tsx:8-13`):

| Reads from | Renders |
|---|---|
| `entry.probability.{mean, stdev}` | `p` row + Beta band |
| `entry.probability.provenance` | quality footer label (bayesian only — ignored for analytic) |
| `entry.latency.{mu, sigma, t95, onset_delta_days, mu_sd, sigma_sd, onset_sd, onset_mu_corr, path_mu, path_sigma, path_t95, path_onset_delta_days, path_mu_sd, path_sigma_sd, path_onset_sd}` | Latency edge column + path column rows + `ModelRateChart` lognormal CDF |
| `entry.quality.{rhat, ess, divergences, evidence_grade}` (bayesian only) | quality footer |
| `entry.source_at` | timestamp in footer |

**Reads NOT performed**:

- `entry.probability.{alpha, beta, alpha_pred, beta_pred, cohort_*, n_effective, provenance}` are NEVER read by ModelCard. **Drop**: The Beta-shape and predictive fields exist on `model_vars[*].probability` but the per-source card displays only mean + stdev. Severity: low — the Beta fields are read by `PromotedModelCard` and the BE consumers.
- `entry.fit_diagnostics.*` is NEVER read by ModelCard. **Drop**: HDI / PPC / LOO / surprise_z / fitted_at are never surfaced in the per-source card. PromotedModelCard surfaces them in its diagnostic popover. Severity: low.
- `entry.quality.gate_passed` is NEVER read by ModelCard (it computes a tier label via `computeQualityTier` but doesn't display the gate state directly). The pin/auto badge (rendered by the surrounding `ModelVarsCards`, not the card itself) reflects the active selector instead. **Documented choice.**

**`ModelRateChart` (spark CDF chart) field consumption**:

Per `ModelCard.tsx:270-301` `ModelRateChartFromEntry`, the chart reads:

- `entry.probability.mean` → `edgeP`, `pathP`
- `entry.probability.stdev` → `edgePSd` (when finite > 0)
- `entry.latency.{mu, sigma, onset_delta_days, mu_sd, sigma_sd, onset_sd, onset_mu_corr, t95}` → edge series CDF + bands
- `entry.latency.{path_mu, path_sigma, path_onset_delta_days, path_mu_sd, path_sigma_sd, path_onset_sd, path_t95}` → path series CDF + bands

**Net**: ModelCard is faithful to the source ledger. Promotion gaps cannot be surfaced via this card — that's PromotedModelCard's job.

### §7.4 Consumer D — `PromotedModelCard` (was `BayesPosteriorCard` pre-30-Apr-26)

`graph-editor/src/components/analytics/PromotedModelCard.tsx`. Renders the active-source promoted view. Used by `AnalysisInfoCard` for the edge_info "Model" tab.

**Field consumption** is via the merged-view utilities `getProbabilityPosteriorView(p)` and `getLatencyPosteriorView(p)` (`graph-editor/src/utils/posteriorView.ts`).

**`ProbabilityPosteriorView`** (merged) reads:

| From | Fields |
|---|---|
| `p.posterior` (promoted Beta surface, source-agnostic) | `distribution, alpha, beta, alpha_pred, beta_pred, cohort_alpha, cohort_beta, cohort_alpha_pred, cohort_beta_pred, n_effective, cohort_n_effective, provenance, cohort_provenance` |
| `model_vars[bayesian].fit_diagnostics.probability` (when bayesian source ledger entry exists) | `fitted_at, fingerprint, prior_tier, surprise_z, hdi_*, hdi_*_pred, cohort_hdi_*, cohort_hdi_*_pred, delta_elpd, pareto_k_max, n_loo_obs, ppc_*` |
| `model_vars[bayesian].quality` (when bayesian source ledger entry exists) | `ess, rhat, divergences, evidence_grade` |
| `p.forecast.source` | `source` label (the active source) |

**`LatencyPosteriorView`** (merged) reads:

| From | Fields |
|---|---|
| `p.latency.posterior` (promoted lognormal surface, source-agnostic post-30-Apr-26 latency v1.1) | `distribution, mu_mean, sigma_mean, mu_sd, mu_sd_pred, sigma_sd, onset_delta_days, onset_sd, onset_mu_corr, path_mu_mean, path_sigma_mean, path_mu_sd, path_sigma_sd, path_mu_sd_pred, path_onset_delta_days, path_onset_sd, provenance, path_provenance` |
| `model_vars[bayesian].fit_diagnostics.latency` (when bayesian) | `fitted_at, fingerprint, ess, rhat, hdi_t95_*, path_hdi_t95_*, hdi_level, delta_elpd, pareto_k_max, n_loo_obs, ppc_traj_*` |

**Card field reads from the merged views**:

| Read | Renders |
|---|---|
| `probability.{alpha, beta}` | `p` row + Beta band (computed mean / SD from α, β closed form) |
| `probability.{cohort_alpha, cohort_beta}` | path-mode `p` row + Beta band |
| `probability.{hdi_lower, hdi_upper, hdi_level}` | HDI row |
| `probability.{cohort_hdi_lower, cohort_hdi_upper}` | path-mode HDI row |
| `probability.{rhat, ess, evidence_grade, fitted_at}` | quality footer |
| `probability.{delta_elpd, pareto_k_max}` | LOO badges (warning when negative / >0.7) |
| `probability.{ppc_coverage_90, ppc_traj_coverage_90}` | PPC badges |
| `probability.{prior_tier, surprise_z}` | popover diagnostic rows |
| `latency.{mu_mean, sigma_mean, onset_delta_days, mu_sd, sigma_sd, onset_sd, onset_mu_corr}` | latency edge column + `ModelRateChart` |
| `latency.{path_mu_mean, path_sigma_mean, ...}` | latency path column |
| `t95` prop (separate from view) | x-axis horizon for `ModelRateChart` |
| `pathT95` prop | x-axis horizon for path series |

**Reads NOT performed**:

- `model_vars[active].latency.t95` — the card receives `t95` as a prop from `localAnalysisComputeService.ts:567-568` (post latest fix: reads `p.latency.{promoted_t95, t95}` from the L1.5/L2 promoted scalars, not from `model_vars[bayesian]`). **Confirmed correct post-30-Apr-26 t95-source fix.**
- `entry.probability.{n_effective, cohort_n_effective}` are technically on the merged view but the card renders `mean ± stdev` from α, β closed form, never displays n_effective directly. **Documented absence in current UI.**

**Drops / promotion gaps surfaced through this card**:

- Per the **principle** the card is built for: if a field is on the promoted surfaces but `applyPromotion` left it stale or empty, the card displays the wrong / missing value. This is the intended behaviour — defects in promotion become visible.
- Specifically: when active source is `analytic` but `model_vars[analytic]` lacks an `alpha`/`beta` (moment-match infeasible per doc 73f F16), `applyPromotion` clears `p.posterior` and the card shows "No posterior available". **Correct surfacing.**
- When active source is `bayesian` and `model_vars[bayesian]` lacks `fit_diagnostics.probability.{ess, rhat, ...}` after a DSL change re-projection (per the `posteriorSliceContexting` drop B1/B2 flagged in §4.7), the popover loses the LOO/PPC/quality rows until the next bayes refit. **Symptom of the documented drop.**



---

## §8. Issues catalogue

Findings consolidated and classified. Severity rubric: **high** = produces wrong/missing user-visible data, hard to recover; **medium** = produces wrong/transient user-visible data that recovers on refit/refetch, OR a structural inconsistency that hides bugs; **low** = cosmetic, documented absence, or pattern-only smell with no user-visible symptom; **very low** = redundancy, no functional impact.

### §8.1 Drops (field is produced upstream but not propagated downstream OR a consumer expects something no producer writes)

**Drop B1 — DSL re-projection loses LOO/PPC/surprise on probability popover** *(medium)*

`posteriorSliceContexting.buildBayesianModelVarFromSlice` (lines 145-167) does not populate `fit_diagnostics.probability.{delta_elpd, pareto_k_max, n_loo_obs, ppc_coverage_90, ppc_n_obs, ppc_traj_coverage_90, ppc_traj_n_obs, surprise_z}`. Compare to `bayesPatchService.applyPatch:435-447` which copies all of them from windowSlice.

**Symptom**: when the user changes the DSL after a Bayes fit, `posteriorSliceContexting` re-projects from the parameter file's slices — but the re-projected `model_vars[bayesian].fit_diagnostics.probability` lacks LOO/PPC. The PromotedModelCard popover loses the LOO badge, ΔELPD warning, Pareto-k warning, and PPC coverage rows. They reappear on next Bayes fit. The quality tier engine (`computeQualityTier`) reads ΔELPD and Pareto-k for warning escalation; with both absent it cannot escalate from `gated_warning` even when the fit's LOO actually said it should. **Severity: medium — UI degrades silently between fits; warning state may be incorrectly absent.**

**Location**: `graph-editor/src/services/posteriorSliceContexting.ts:145-167` (`buildBayesianModelVarFromSlice` probability sub-block).

**Fix shape**: read `probProj.{delta_elpd, pareto_k_max, n_loo_obs, ppc_*, surprise_z}` if `projectProbabilityPosterior` surfaces them; mirror the bayesPatchService projection.

**Drop B2 — DSL re-projection loses LOO/PPC on latency popover** *(medium)*

Same function, lines 168-184, does not populate `fit_diagnostics.latency.{delta_elpd, pareto_k_max, n_loo_obs, ppc_traj_*}`. Same symptom shape on the latency tab. Same severity.

**Location**: `graph-editor/src/services/posteriorSliceContexting.ts:168-184`.

**Drop B3 — bayesPatchService never extracts `surprise_z` from windowSlice** *(low)*

The Bayes worker emits `surprise_z` per slice (per doc 55 surprise gauge). `bayesPatchService.applyPatch:413-417` builds `probDiag` with `fitted_at`, `fingerprint`, `prior_tier` — but does not include a `probDiag.surprise_z = windowSlice.surprise_z` line. Migration preserves it from legacy `p.posterior.surprise_z` (workspaceService:327). Re-projection (Drop B1) also does not propagate.

**Symptom**: surprise_z exists on legacy graphs (where the legacy `p.posterior` carried it) but disappears on next Bayes refit because the patch writer doesn't lift it. The surprise gauge has its own analysis-runner path so the engine result is unaffected; only the popover diagnostic row showing surprise_z would be empty.

**Location**: `graph-editor/src/services/bayesPatchService.ts:413-417`.

### §8.2 Resolver inconsistency / partial reorder

**Resolver-1 — Inconsistent read order across surfaces** *(medium)*

`model_resolver.resolve_model_params` reads in three different orders depending on the surface:

- Latency block (lines 246-385): `model_vars[promoted_source].latency` first, `lat_posterior` second, flat `latency_block.{mu, sigma, ...}` third. **model_vars-first.**
- Rate Beta α/β (lines 399-414, 535-548): `posterior_block.{cohort_alpha, alpha, alpha_pred, ...}` first, `model_vars[promoted_source].probability.{prob_alpha, ...}` second. **posterior_block-first.**
- `n_effective` (lines 491-522): `_src.{prob_n_effective, prob_cohort_n_effective}` first, `posterior_block.{n_effective, cohort_n_effective, window_n_effective}` second. **model_vars-first.**

**Symptom**: when the request graph is **freshly promoted** (FE has just run `applyPromotion`), all three branches return the same answer because both surfaces mirror the same source. When the request graph **bypasses FE promotion** (CLI snapshots, share bundles, fixtures populating only one of the two surfaces), the rate Beta branch and the latency branch may resolve to different answers — α/β from posterior_block, latency from model_vars[active]. Hidden by parity tests in normal flow; surfaces only when investigators inject deliberately mismatched state.

**Severity: medium**. Inconsistency is confusing and creates a minefield when extending the resolver. The plan §7 recommended uniform model_vars-first ordering; latency and n_effective adopted it, rate Beta did not.

**Location**: `graph-editor/lib/runner/model_resolver.py:399-414` (rate α/β), `:535-548` (predictive). Compare to `:246-385` (latency) and `:491-522` (n_effective).

**Fix shape**: reorder rate Beta read order so `_src.{prob_alpha, prob_beta, prob_cohort_alpha, prob_cohort_beta}` is consulted first. The existing posterior_block-first branch becomes the fallback for un-promoted graphs.

### §8.3 Promotion-coverage gaps (cleared cleanly but with caveats)

**Promotion-1 — `clearPromotedSurfaces` does not clear `p.forecast.{mean, stdev}`** *(low)*

`modelVarsResolution.clearPromotedSurfaces` (lines 282-294) clears `p.posterior`, `p.latency.posterior`, and sets `p.forecast.source = undefined`. It **does not** set `p.forecast.mean = undefined` or `p.forecast.stdev = undefined`. The inline comment explains: "We only clear the source-label so downstream readers can detect 'no active source' and the Beta / latency-posterior projections so they cannot be stale."

**Consequence**: when `applyPromotion` clears (no source resolved), `p.forecast.{mean, stdev}` retain their last-promoted values. Downstream readers must treat a missing/undefined `p.forecast.source` as "stale forecast scalars; do not trust mean/stdev" or check `p.posterior` presence. Most consumers do not.

**Symptom**: on edge bootstrap or after dropping a source ledger entry, the FE topo blend (line 2477 fallback `edge.p.forecast.mean ?? edge.p.mean`) reads the stale `forecast.mean`. **Latent feedback risk; severity: low because production paths always re-populate `forecast.{mean, stdev}` before the next blend.**

**Location**: `graph-editor/src/services/modelVarsResolution.ts:282-294`.

**Promotion-2 — `model_vars[analytic].probability.stdev` not refreshed by FE topo Step 1 mutation** *(medium)*

UpdateManager's `applyBatchLAGValues:2184-2216` mutates `analyticEntry.latency.*` and `analyticEntry.probability.mean` (when `update.forecast.mean` is set), but does NOT touch `analyticEntry.probability.stdev`. The `stdev` was set by an earlier `addEvidenceAndForecastScalars` call as `sqrt(p(1-p)/N)` over the recency-weighted population.

**Implicit invariant**: the topo pass and the freshness pass produce coherent (mean, stdev) pairs because both read from the same recency-weighted mature-day population. **Not enforced by code** — if a future change to the topo pass produces a `forecast.mean` from a different basis (e.g. the cohort-window evidence), `stdev` would be stale relative to the new `mean`, and the downstream `momentMatchAnalyticBeta` would yield wrong α/β.

**Symptom**: today, none. Tomorrow, hard-to-spot when violated.

**Severity: medium-low**. Worth pinning with a fixture-driven test that asserts `(mean, stdev, alpha, beta)` are jointly consistent on every fetch.

**Location**: `graph-editor/src/services/UpdateManager.ts:2214-2216` only writes `analyticEntry.probability.mean`. `graph-editor/src/services/dataOperations/evidenceForecastScalars.ts:708-711` writes `forecastStdevComputed` from the same population. The implicit pairing is in `fileToGraphSync.ts:1946-1955` via `buildAnalyticProbabilityBlock`.

### §8.4 Quantitative biases / latent risks

**Quant-1 — `n_effective` fallback on analytic** *(low)*

`buildAnalyticProbabilityBlock` (modelVarsResolution.ts:472-478): when `opts.n_effective` is undefined, falls back to `moments.n_effective` (the moment-match concentration `mean·(1-mean)/var − 1`). For the `weighted_n` sidecar this is generally far less than the actual mature-day population mass.

**Consequence**: the BE engine doc 52 blend correction (`m_S / m_G`) under-states `m_G` (the training mass), so over-corrects the conditioning blend.

**Severity: low**. In production paths `weighted_n` is always populated. Surfaces only on synthetic / partial fixtures.

**Location**: `graph-editor/src/services/modelVarsResolution.ts:472-478`.

**Quant-2 — Pessimistic legacy gate inference** *(low)*

`workspaceService._migrateBayesianPosteriorToSourceLedgerInPlace:405-407`: sets `gate_passed = (oldPosterior.provenance === 'bayesian')` for legacy graphs. Other provenance values (`pooled-fallback`, `point-estimate`, `skipped`) get `gate_passed = false`. Per the comment, this is intentional — those provenances imply degraded fits.

**Consequence**: legacy graphs migrated through this path get `gate_passed = false` if the original fit was a successful pooled fallback. Promotion falls through to analytic on first open until next Bayes refit. **Documented and conservative.**

**Severity: low**. Once the next fit lands, `bayesPatchService` writes the correct gate_passed via `meetsQualityGate(...)`.

**Location**: `graph-editor/src/services/workspaceService.ts:405-407`.

**Quant-3 — `gate_passed` frozen at write time** *(low-medium)*

Per the schema and `meetsQualityGate` design, `gate_passed` is computed once at write time using the forecasting-settings thresholds (ESS, Rhat) live at that moment. If the user later raises ESS / lowers Rhat thresholds, existing entries keep their pre-config gate verdicts.

**Symptom**: changing settings doesn't immediately re-gate the existing fits. User has to either refit or wait for the next DSL re-projection (which calls `liveSliceMeetsQualityGate` and rebuilds the entry).

**Severity: low-medium**. CLAUDE.md `forecasting-settings.md` notes this is known. Worth confirming the DSL-change path actually re-evaluates the gate (it does — `liveSliceMeetsQualityGate` is called by `posteriorSliceContexting` per `posteriorSliceContexting.ts:198-205`).

### §8.5 Documented absences (intentional, but worth knowing)

**Absent-1 — Analytic does not emit cohort-family Beta** *(low)*

`model_vars[analytic].probability.{cohort_alpha, cohort_beta, cohort_alpha_pred, cohort_beta_pred, cohort_n_effective, cohort_provenance}` are never written. In cohort mode, the BE resolver falls through to the window-family Beta. PromotedModelCard's path column displays the window-family Beta when active source is analytic (see §7.4 path "p" row).

**Symptom**: confusing path-column display in PromotedModelCard when active source is analytic — the user might expect a "cohort posterior" but gets the window aggregate. **Documented architectural choice (analytic doesn't fit cohort-specific posteriors), but the popover row label could clarify.**

**Severity: low**. Not a defect; opportunity for UI clarification.

**Absent-2 — Analytic does not emit `mu_sd_pred` / `path_mu_sd_pred`** *(low)*

Documented in `STATS_SUBSYSTEMS.md` §6 and `EPISTEMIC_DISPERSION_DESIGN.md`. The BE consumer falls back to `mu_sd` via `ResolvedLatency.mu_sd_predictive`.

**Severity: low**. Designed behaviour.

### §8.6 Schema / renderer / ambiguity issues

**Ambig-1 — `t95` symbol appears at three layers** *(medium)*

`p.latency.t95` (user-input), `p.latency.promoted_t95` (writer-output), `model_vars[X].latency.t95` (source-ledger entry). Different writers, different read paths. Doc 19 explains the distinction; not all consumers honour it.

**Confirmed correct fix landed today (30-Apr-26)**: `localAnalysisComputeService.ts:567-568` now reads `p.latency.{promoted_t95, t95}` for the PromotedModelCard t95 prop, not `model_vars[bayesian].latency.t95`. The earlier `bayesMv?.latency?.t95` defect is gone.

**Residual risk**: any new surface that reads "t95" should explicitly choose the layer. The naming overlap remains a confusion vector; not a defect today, just a confusion vector.

**Severity: medium**. Mitigation: a rename or namespacing convention would help, but is bigger than this refactor.

**Ambig-2 — `onset_delta_days` symbol appears at three layers** *(medium)*

Same shape: `p.latency.onset_delta_days` (user-input), `p.latency.promoted_onset_delta_days` (writer-output), `model_vars[X].latency.onset_delta_days`. The promoted writer copies to the input field unless `onset_delta_days_overridden === true`. Behaviour correct; naming confusing.

**Severity: medium**. Same mitigation as Ambig-1.

**Ambig-3 — `path_onset_mu_corr` schema-vs-renderer asymmetry** *(low)*

The schema (`ModelVarsEntry.latency`) does not declare `path_onset_mu_corr`. `PromotedModelCard.ModelRateChart` (was `BayesPosteriorCard`) reads `pathOnsetMuCorr` via cast `(lat as any)?.path_onset_mu_corr`. Reads as undefined, treated as `null` for band computation. Cosmetic.

**Severity: low**. Either declare the field on the schema and have the bayes patch writer populate it, or remove the cast. No user-visible defect today.

**Location**: schema at `graph-editor/src/types/index.ts:672-692`; renderer at `graph-editor/src/components/analytics/PromotedModelCard.tsx:228`.

### §8.7 Storage / structural redundancies

**Redund-1 — `quality.{ess, rhat}` duplicated in `fit_diagnostics.latency.{ess, rhat}`** *(very low)*

The worker emits one (rhat, ess) pair per fit; both blocks store it. Symptomless.

**Redund-2 — LOO scalars duplicated across `fit_diagnostics.probability` and `fit_diagnostics.latency`** *(very low)*

`{delta_elpd, pareto_k_max, n_loo_obs}` are the same scalars (one LOO score per fit) copied into both sub-blocks. Symptomless storage redundancy.

### §8.8 Heuristic / writer-reader policy mismatches

**Heur-1 — Analytic `onset_mu_corr = -0.5` written, but resolver clamps to 0** *(low)*

FE topo emits a heuristic `onset_mu_corr = -0.5` for the analytic source per `STATS_SUBSYSTEMS.md`. The BE resolver `model_resolver.py:277` clamps to `0` for analytic per doc 73b §3.9 (analytic-dispersion discipline) — analytic's `onset_mu_corr` is a placeholder, not a fitted joint distribution. The disagreement is absorbed at the resolver boundary.

**Symptom**: surface-side card displays `-0.5`, BE engine treats `0`. Reader/writer disagreement is benign but confusing if a debugger tries to reconcile the values.

**Severity: low**. Documented design.

**Heur-2 — Analytic `onset_sd = max(1, onset · 0.15)` heuristic floor** *(low)*

Documented in `EPISTEMIC_DISPERSION_DESIGN.md` archive §3.4. Not statistically derived; a floor for the dispersion model. **Documented absence of principled derivation; severity low.**

### §8.9 Latent feedback risks

**Feedback-1 — FE topo blend fallback reads L5 as L2 input** *(low)*

`statisticalEnhancementService.ts:2477` reads `edge.p.forecast.mean ?? edge.p.mean`. When `p.forecast.mean` is undefined (cleared promotion or freshly bootstrapped edge), the blend uses the prior fetch's `p.mean` as the forecast — circularly using L5 to compute L5.

**Symptom**: in fresh bootstrap with no prior fetch, `p.mean` is also undefined and the fallback resolves to 0; the blend formula handles 0 correctly. In ordinary fetch flow, `p.forecast.mean` is always present. The risk is on edge cases.

**Severity: low**. Worth a defensive check or comment; not urgent.

**Location**: `graph-editor/src/services/statisticalEnhancementService.ts:2477`.



---

## §9. Recommendations

Prioritised follow-ups. **High** = should fix before next significant feature lands; **Medium** = should fix in the next housekeeping pass; **Low** = pattern-only / pin with a test; **None** = documented absence, no action.

### §9.1 High priority — none

No high-severity issues identified. The post-30-Apr-26 unification + latency v1.1 work closed the user-visible parity defect on the `goonthen3` reproducer. The residual issues are structural / latent rather than user-visible.

### §9.2 Medium priority

**R1 — Fix Drops B1 and B2 in `posteriorSliceContexting.buildBayesianModelVarFromSlice`** *(severity: medium; effort: small)*

Symptom: PromotedModelCard popover loses LOO badges, ΔELPD warnings, Pareto-k warnings, PPC coverage, and (on legacy) surprise_z after a DSL change, until the next Bayes refit. Probably also breaks LOO-driven quality tier escalation in `computeQualityTier` for the same window.

Fix: in `buildBayesianModelVarFromSlice` (`posteriorSliceContexting.ts:145-184`), mirror the field-by-field copy from `bayesPatchService.applyPatch:435-447` and `:466-474` so the projected entry carries the same `fit_diagnostics.{probability, latency}` payload as a fresh patch.

Acceptance: write a fixture-based test that simulates a fresh fit, then a DSL change, and asserts the post-DSL-change `model_vars[bayesian].fit_diagnostics.probability.delta_elpd` matches the pre-DSL-change value. Same for the latency sub-block. Add to `liveEdgeReContextOnDslChange.test.ts` or `analysisPrepRecontext.integration.test.ts`.

**R2 — Reorder rate Beta read in `model_resolver.resolve_model_params` to model_vars-first** *(severity: medium; effort: small)*

Symptom: when the request graph is not freshly promoted (CLI inputs, share bundles, fixtures), `posterior_block` and `model_vars[active].probability` may diverge. The resolver returns posterior_block (potentially stale) for rate Beta but model_vars[active] for latency and n_effective. Confusing inconsistency that can mask bugs.

Fix: at `model_resolver.py:399-414` and `:535-548`, reorder so `_src.{prob_alpha, prob_beta, prob_alpha_pred, prob_beta_pred, prob_cohort_alpha, prob_cohort_beta, prob_cohort_alpha_pred, prob_cohort_beta_pred}` is consulted first, with `posterior_block.{cohort_alpha, alpha, ...}` as fallback for un-promoted graphs. Mirrors the latency / n_effective read pattern.

Acceptance: extend `test_model_resolver.py` with a fixture that has divergent posterior_block vs model_vars[active]; assert the resolver returns the model_vars value. Confirm the existing parity tests still pass (they should — when freshly promoted, both surfaces agree).

**R3 — Pin (mean, stdev, alpha, beta) consistency on `model_vars[analytic].probability`** *(severity: medium-low; effort: small)*

Symptom: today none. The implicit invariant "mean, stdev, alpha, beta are jointly consistent — moment-matched from the same recency-weighted population" is maintained by code path coincidence, not by an enforced contract. A future change to FE topo Step 1's `update.forecast.mean` source could violate it silently.

Fix: add a fixture test that exercises a fresh fetch and asserts:

- `mean ≈ alpha / (alpha + beta)` to floating-point tolerance, AND
- `stdev² ≈ alpha · beta / ((alpha+beta)² · (alpha+beta+1))` to tolerance, AND
- both hold after `applyBatchLAGValues` runs (which mutates `mean` from `update.forecast.mean`).

The test would catch a future divergence at write time. Place in `extractDiffParamsContractCoverage.test.ts` or alongside `addEvidenceAndForecastScalars` tests.

**R4 — Disambiguate the `t95` / `onset_delta_days` / `promoted_*` naming** *(severity: medium; effort: medium)*

Symptom: same field name appears at three layers (`p.latency.t95`, `p.latency.promoted_t95`, `model_vars[X].latency.t95`). Cite `model_vars[bayesian].latency.t95` got the PromotedModelCard reading the wrong t95 until the 30-Apr-26 fix. Future readers must consciously remember which `t95` they want.

Two fix shapes (mutually exclusive):

- **Lightweight**: add a JSDoc/Pydantic comment on every "t95"-bearing field that names which layer it is and points to the doc 19 explanation. Cheap; doesn't reduce the cognitive load.
- **Heavyweight**: rename `model_vars[X].latency.t95` to `model_vars[X].latency.fitted_t95` (and likewise for `onset_delta_days` → `fitted_onset_delta_days`) so each layer has a distinct symbol. Costs a coordinated TS+Python schema migration with grep-and-replace through every consumer.

Recommendation: **lightweight first**. Heavyweight is a larger refactor warranting its own scope.

### §9.3 Low priority

**R5 — Extract `surprise_z` in `bayesPatchService.applyPatch`** *(severity: low; effort: trivial)*

Add `if (windowSlice.surprise_z != null) probDiag.surprise_z = windowSlice.surprise_z;` at `bayesPatchService.ts:417`. If the worker emits the field today, it currently ends up nowhere on the model_vars projection; users only see surprise_z on legacy-migrated graphs.

**R6 — Decide the policy on `p.forecast.{mean, stdev}` clear** *(severity: low; effort: small)*

`clearPromotedSurfaces` currently retains the previous `p.forecast.{mean, stdev}` when promotion has nothing to write. Either:

- Document explicitly in the comment that `p.forecast.{mean, stdev}` are **input-style** scalars that survive a clear (alongside `p.latency.t95`); or
- Clear them too, and audit downstream consumers (FE topo blend at line 2477; UI freshness footer) to ensure they handle absence gracefully.

The current design is the conservative-protect-upstream-writes choice and probably correct; just call it out in the doc string.

**R7 — Resolve `path_onset_mu_corr` schema/renderer asymmetry** *(severity: low; effort: trivial)*

Either:

- Declare `path_onset_mu_corr?: number` on `ModelVarsEntry.latency` (TS + Python), then have `bayesPatchService` populate it from `cohortSlice.onset_mu_corr` (worker would also need to start emitting it on the cohort slice if it doesn't already). PromotedModelCard's renderer drops the cast.
- OR: remove the cast in `PromotedModelCard.tsx:228`, since the renderer correctly handles `null` → no path-onset-correlation in the band computation.

Cosmetic-only; either fix removes the asymmetry.

**R8 — Log warning when analytic `weighted_n` is absent** *(severity: low; effort: trivial)*

Add a `console.warn` or session-log entry in `buildAnalyticProbabilityBlock` when `opts.n_effective === undefined` so production pathologies (where `weighted_n` is unexpectedly empty) are surfaced. Today the silent fallback to moment-match concentration produces under-stated `m_G` for the doc 52 blend.

### §9.4 Documented — no action recommended

- **Absent-1, Absent-2**: analytic doesn't emit cohort family / mu_sd_pred. Designed behaviour.
- **Heur-1, Heur-2**: heuristic onset SDs and `onset_mu_corr` are documented placeholders.
- **Redund-1, Redund-2**: storage redundancy is symptomless.
- **Quant-2**: pessimistic legacy gate inference is conservative and self-corrects on next refit.
- **Quant-3**: gate frozen at write-time is documented; DSL re-projection re-evaluates.
- **Promotion-2's stdev pairing**: covered by R3 (test pin).
- **Feedback-1**: FE blend fallback to L5 is benign in production paths; not worth chasing without a reproducer.

### §9.5 Suggested ordering for follow-up work

1. **R1 (Drop B1+B2)** — concrete UI degradation; easy fix; clear acceptance test.
2. **R2 (resolver reorder)** — closes the structural inconsistency; aligns with the unification plan §7 recommendation.
3. **R3 (mean/stdev/alpha/beta pin test)** — defensive contract test for the analytic write path.
4. **R5, R8** — trivial extractor fixes.
5. **R6, R7** — documentation / cosmetic.
6. **R4** — naming disambiguation; consider as a separate refactor when other naming work is in flight.

The audit is complete as of this commit. The next iteration should be a peer review of §6 (per-field flow tables) and §8 (issues catalogue) by someone independent who can argue with each cell.

