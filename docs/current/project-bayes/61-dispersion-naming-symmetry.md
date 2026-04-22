# 61 — Dispersion Field Naming Symmetry and Reporting/Forecasting Separation

**Status**: Implementation plan — awaiting approval to begin work
**Date**: 22-Apr-26
**Supersedes**: Doc 49 §A.6 Invariant 9 ("bare name is predictive for latency `mu_sd`"); Doc 49 §A.9 Invariant 5 (model card displays predictive ± values). Other parts of doc 49 remain in force.
**Relates to**: Doc 49 (epistemic/predictive separation design), doc 51 (model curve overlay unification), doc 52 (funnel hi/lo bars — existing epi/pred precedent), doc 34 (latency dispersion κ), handover 11-Apr-26-mu-dispersion-and-regression-tooling.md (original kappa_lat design decision)

---

## 1. Purpose

Two linked corrections to the dispersion contract that doc 49 Phase 0 has already partially landed:

First, eliminate the asymmetric naming that doc 49 introduced. Today `alpha` means the epistemic probability posterior and `alpha_pred` means the kappa-inflated predictive counterpart. That is clean. But for latency μ the convention was inverted: `mu_sd` is the predictive value when `kappa_lat` is fitted and `mu_sd_epist` is the always-epistemic companion. Doc 49 adopted that inversion explicitly "to minimise churn" at the time. The inversion makes the meaning of the bare field name context-dependent, the audit of consumer call sites harder, and the overall contract harder to reason about. We fix it now by renaming so that, throughout the system, the bare field name is always epistemic and the `_pred` suffix always means predictive.

Second, correct the reporting-vs-forecasting consumer contract. Doc 49 §A.9 ruled that the model card (and other "what should I expect to see" surfaces) should display predictive ± values on the basis that a reader wants "the useful at-a-glance number for daily observations". That framing made sense when the forecast fan was the only serious consumer of predictive dispersion. In practice the "model belief" reading — "do these two models' μ posteriors overlap?", "how precisely does the fit know this parameter?" — is a distinct and legitimate user question, and it is currently answered with a predictive band that is materially too wide to be informative. We therefore flip the reporting surfaces onto the epistemic flavour and keep the forecasting surfaces on the predictive flavour.

The two corrections are logically independent, but they land cleanest as a single coordinated change because the renaming is a grep-time simplification of the consumer rewire and vice versa.

## 2. Principle

After this change, the system obeys two simple rules with no context-dependent exceptions.

**Naming rule**. Any dispersion or uncertainty field without a suffix is epistemic. The `_pred` suffix, when present, always denotes the kappa-inflated predictive counterpart. σ and onset dispersions have no predictive mechanism in the current model and therefore never carry a `_pred` variant; the bare names are their only form and are always epistemic. Probability posteriors continue to carry `alpha` and `beta` as their epistemic forms and `alpha_pred` / `beta_pred` as predictive; HDI endpoints follow the same pattern. Path-level fields follow the rule through the `path_` prefix without interfering with the `_pred` suffix.

**Consumer rule**. Surfaces whose purpose is to report what the model currently believes about the underlying parameters ("model belief" surfaces) read the bare fields. This includes the posterior card's textual ± labels and HDI ranges, the model-rate mini-chart embedded in the posterior card and any edge-properties or edge-info panel, and the "model belief" overlay curves rendered on the cohort maturity v3 chart and any analogous analysis type. Surfaces whose purpose is to project future outcomes — forecast fan charts, the conditioned-forecast MC sweep, any analysis that traces scenario evolution forward — read the `_pred` variants where they exist and the bare fields for σ, onset, and any other dispersion that has no predictive variant.

These two rules are sufficient. No flag argument is introduced on any function; no caller has to know which flavour a downstream consumer wanted; the decision is made at the leaf by the name of the field being read.

## 3. Background

Doc 49 formalised the distinction between epistemic and predictive dispersion in April 2026. Its Phase 0 was substantially implemented: the Bayes compiler computes both flavours, the webhook payload serialises both, the FE patch service projects both onto the graph edge posterior and the `model_vars[bayesian].latency` block, and the FE TypeScript types declare both. What remained unfinished was the consumer-side wiring: no Python code reads `mu_sd_epist`, and the FE consumers all continue to read `mu_sd` on the basis of doc 49 §A.9's model-card display rule.

The original decision to leave `mu_sd` as the predictive value with `mu_sd_epist` added alongside was driven by the kappa_lat handover of 11-Apr-26. That handover concluded that kappa_lat should not surface as a user-facing concept and that users would reason about the inflated `mu_sd` the way they already reason about the inflated posterior on `p` — as "the natural band". The framing assumed that the only consumer of `mu_sd` was the forecast fan, in which case predictive is correct, and that surface-level views would not independently need an epistemic band.

Two developments since then have invalidated that assumption. Doc 51's overlay unification (20-Apr-26) routed the cohort_maturity_v3 "model belief" overlap curves through the span kernel's monte-carlo draws, which draw per-edge parameters from the posterior means and SDs passed in via `build_prepared_span_execution_from_topology` — i.e. via `mu_sd`. That fed predictive dispersion into a surface whose explicit purpose is to answer "do these two models' mean curves overlap?". At the same time the funnel hi/lo-bar design (doc 52 Level 2) established an explicit epi/pred distinction in the frontend under the names `probabilityLoEpi/HiEpi` and `probabilityLo/Hi`, proving both that the distinction is live and that a symmetric pair of variables per surface is a workable UI pattern.

The current state — Phase 0 partially landed, asymmetric names, no reporting consumer using the epistemic field — is the worst of both worlds: the infrastructure cost has been paid but no user-visible surface benefits from it, while the naming mismatch makes every future audit harder.

## 4. Scope

In scope are every site where a dispersion field, uncertainty band, HDI range, or monte-carlo envelope is produced or consumed in a way that depends on μ. Probability naming is already symmetric and requires no rename, but the reporting-vs-forecasting consumer audit still applies to probability ± and HDI displays.

Two slice-to-graph projection paths exist on the FE and both must be renamed together. The first is the one-shot application of an incoming Bayes patch, handled in `bayesPatchService.ts`. The second is the posterior-slice resolver in `posteriorSliceResolution.ts`, whose `projectProbabilityPosterior` and `projectLatencyPosterior` helpers project the currently-selected slice onto a per-edge posterior shape on demand. Those helpers are called from `analysisComputePreparationService.ts` when preparing compute inputs and from `updateManager/mappingConfigurations.ts` inside the `posterior` mapping configuration that the UpdateManager runs when a parameter file posterior changes. Both consumers must be considered part of the atomic rename; otherwise a live slice-to-graph path continues to project `mu_sd_epist` / `path_mu_sd_epist` onto the graph edge after the bare fields have been renamed elsewhere, and the two projection paths disagree about which field name carries which quantity.

On the Python side the audit includes every call site that reads the bare `mu_sd` or `path_mu_sd` off a latency posterior block or the flat `bayes_mu_sd` / `bayes_path_mu_sd` promoted field. The concrete list is: the edge-params fallback chain inside `cohort_forecast.py` around lines 589 and 602 that selects between `bayes_path_mu_sd` and `bayes_mu_sd`; the `read_edge_cohort_params` function in the same file at line 224, whose tail-loop copies `path_mu_sd` / `mu_sd` (and sigma, onset analogues) out of the latency-posterior block into the returned params dict; and the identical `read_edge_cohort_params` definition in `forecast_runtime.py` at line 605 (the doc 56 Phase 1 verbatim port, which is now the production-facing copy). The v1 copy in `cohort_forecast.py` remains live because `_handle_snapshot_analyze_subjects` and the v1 dev-chart path still import it; both copies are renamed together, with the v1 copy following exactly so its behaviour stays aligned with the v3 copy until doc 56's eventual deletion workstream retires it.

Out of scope are σ and onset dispersions, which are already always epistemic under a bare name; the non-Bayesian `ModelCard` rendering, which reads heuristic analytic SDs that never had a predictive variant; the funnel chart's epi/pred machinery, which already follows the target pattern and needs no change; and the `cohort_maturity_v2` dev-only chart handler, which remains a parity oracle under doc 56's partial-retirement boundary and should not be touched. Its own copy of `build_span_params` inside `cohort_forecast_v2.py` likewise stays on the old field names.

Doc 49's rename conversation assumed the data model could evolve incrementally under the `_epist` suffix convention. That assumption is now retracted: this plan replaces it with a clean rename rather than extending the asymmetric pattern. Doc 49 as a whole remains correct on the underlying Bayesian separation; only the two invariants named at the top of this document are superseded.

## 5. Data populations affected

Persisted graphs contain the affected fields in three distinct shapes depending on when their last Bayes fit occurred.

Recent graphs, fitted on or after 18-Apr-26, carry both the old `mu_sd` field (which meant "predictive when kappa_lat, else epistemic fallback") and the `mu_sd_epist` field (always epistemic). The same is true at the path level. These graphs are the common case and migrate cleanly in place: the old `mu_sd` becomes `mu_sd_pred`, and the old `mu_sd_epist` becomes the new bare `mu_sd`.

Older graphs fitted before the 18-Apr-26 Phase 0 changes carry only `mu_sd`. Whether that value was predictive or epistemic at write time depends on whether kappa_lat was fitted for that edge. There is no way to distinguish the two cases post hoc from the stored field alone. These graphs are migrated by duplicating the single old value into both new fields: the bare `mu_sd` and the new `mu_sd_pred` both take the value of the old `mu_sd`. This is exact in the common kappa_lat-off case (where epistemic and predictive were equal by construction) and benign in the kappa_lat-on case (reporting surfaces continue to show the same width they showed before this change — not correct under the new semantics but not a regression either). A session-log entry flags each such edge as "pre-doc-49 shape, re-fit recommended". The migration rule is applied centrally by the canonical hook described in §8; no consumer branches on the shape.

Graphs without a Bayes fit have no `mu_sd` / `mu_sd_epist` on the bayesian model_vars block at all, because the heuristic analytic stats pass produces its own fields under `analytic` and `analytic_be` sources which were never part of the epistemic/predictive split. Nothing in those sources changes.

## 6. Architecture

### 6.1 Bayes compiler output

The compiler's `LatencyPosteriorSummary` dataclass and its `to_webhook_dict` serialisation currently produce `mu_sd` (always written last, overwritten from the predictive computation when kappa_lat is present) and `mu_sd_epist` (always written from the raw posterior SD of μ). The rename swaps these: the compiler now computes the raw posterior SD into the bare `mu_sd` field and the predictive value into `mu_sd_pred`. The compiler's internal `_predictive_mu_sd()` helper continues to exist and produces the same numerical value as before; only the field name into which the result is deposited changes. The same applies at the path level: `path_mu_sd` becomes the epistemic posterior SD of path-μ, `path_mu_sd_pred` holds the predictive counterpart when it exists.

`PosteriorSummary` is untouched at the field level because its existing `alpha` / `beta` / `alpha_pred` / `beta_pred` naming already complies with the new rule. The `to_webhook_dict` output gains the renamed latency fields and drops `mu_sd_epist` / `path_mu_sd_epist`.

The underlying MCMC model, priors, and sampling are unchanged. Only the summarisation step and the field in which each quantity is stored move. Numerical outputs on the same trace are identical before and after the rename, up to which field name holds which number.

### 6.2 Worker packing and webhook transport

The worker packs per-slice entries with both flavours. Today's `mu_sd` / `mu_sd_epist` keys on the slice dict become `mu_sd_pred` / `mu_sd` respectively. HDI endpoints already follow the symmetric pattern and need no change. The same rename happens for `path_mu_sd` / `path_mu_sd_epist`.

The webhook contract is a breaking change for external consumers. In practice the webhook is consumed only by `bayesPatchService.ts` inside this repository and by the synth-regression test harness that reads committed patch JSONs. A version bump on the patch payload signals the new schema, and the reader side tolerates both the old and new shapes for a one-release transition window.

### 6.3 FE slice-to-graph projection (two paths)

Two independent projection paths project slice entries onto the per-edge posterior shape that UI components read, and both must be renamed together.

The first is the Bayes-patch apply path. `bayesPatchService.ts` projects slice fields onto the graph edge's `posterior` block and onto the bayesian `model_vars` entry when a new patch arrives from the compiler webhook. After this change, the projection writes `mu_sd` for the epistemic value and `mu_sd_pred` for the predictive value into both locations, mirroring the renamed slice shape. The path-level projection follows the same rule.

The second is the on-demand slice resolver. `posteriorSliceResolution.ts` exports `projectProbabilityPosterior` and `projectLatencyPosterior`, which take a parameter-file posterior plus an effective query DSL and project the best-matching slice onto a per-edge posterior shape. These helpers are used by `analysisComputePreparationService.ts` when building the engorged graph for backend analysis calls, and by the `posterior` mapping configuration in `updateManager/mappingConfigurations.ts` that the UpdateManager runs whenever a parameter file's posterior changes. Both callers therefore produce graph-edge posterior shapes via the resolver, not via the patch-apply path.

Today `projectLatencyPosterior` reads `edgeSlice.mu_sd` directly and conditionally copies `edgeSlice.mu_sd_epist` alongside; the cohort-slice projection reads `cohortSlice.mu_sd` and conditionally copies `cohortSlice.mu_sd_epist` as `path_mu_sd_epist`. After the rename the resolver reads the renamed slice fields: the bare `mu_sd` on the slice holds the epistemic value and goes into the projected `mu_sd`; the `mu_sd_pred` on the slice holds the predictive value and goes into the projected `mu_sd_pred`. The `mu_sd_epist` output key disappears from both projection paths. Both FE projection paths emit identical field shapes, so consumers that load a graph through either the patch-apply route or the on-demand resolver route see exactly the same keys.

Both projection paths contain a small migration shim that tolerates old-shape slice entries for one release: when a slice carries the old `mu_sd_epist` key and no `mu_sd_pred` key, the shim treats the slice as old-shape and remaps the two fields during projection. The shim is implemented once, as a slice-normalisation helper exported from `posteriorSliceResolution.ts`, and called from both `bayesPatchService.ts` and the two resolver exports so the two projection paths behave identically during the transition window. The shim emits a session-log warning on every remap so the transition is visible and so its removal point is findable by log search. The shim is removed in the release after the rename lands.

### 6.4 Python backend consumer layer

`forecast_runtime._PROMOTED_FIELDS` and the parallel promotion pass in `api_handlers.py` around the bayesian-edge-params collector both learn to promote two fields where they previously promoted one. The epistemic posterior SD becomes `bayes_mu_sd` on the flat promoted dict; the predictive posterior SD becomes `bayes_mu_sd_pred`. Path-level variants follow the same rule. `sidecar.py`'s `_PROMOTED_FIELDS`, which serves the synth-test-fixture injection path, is updated in the same commit.

`ResolvedLatency` in the model resolver grows a `mu_sd_pred` field alongside the existing `mu_sd`. The resolver populates the epistemic field into the bare slot and the predictive field into the `_pred` slot, with the same source-priority logic it already applies for `alpha` / `alpha_pred`. Consumers that want the predictive flavour read `mu_sd_pred`; consumers that want the epistemic flavour read the bare `mu_sd`; no flag is passed through any function boundary.

`build_prepared_span_execution_from_topology` in `forecast_runtime.py` is the critical preparation point for the span kernel and currently emits a single `edge_sds` dict built from `resolved.edge_latency.mu_sd`. After the change it emits two dicts: one built from `mu_sd` (the new bare, epistemic) for use by reporting consumers, and one built from `mu_sd_pred` for use by forecasting consumers. Sigma and onset dispersions appear identically in both dicts because they have only the one flavour. The returned structure gains one new field and preserves the existing one unchanged so that forecasting callers need no mechanical update beyond reading the correctly-flavoured dict.

`build_span_params` in `forecast_runtime.py`, which builds the `SpanParams` dataclass used by `compute_forecast_trajectory`'s prior and carrier machinery, reads `bayes_mu_sd_pred` because every caller of `build_span_params` is in a forecasting path. This is the single largest concentration of predictive SD reads in the backend and is correct by intent; the rename merely makes the correctness visible in the name.

`read_edge_cohort_params` in `forecast_runtime.py` (the production-facing copy, at line 605) and the identical copy still live in `cohort_forecast.py` (at line 224) both contain a tail-loop that copies dispersions from the latency-posterior block into the returned params dict via the pairs `('path_mu_sd', 'mu_sd')`, `('mu_sd', 'mu_sd')`, `('path_sigma_sd', 'sigma_sd')`, `('sigma_sd', 'sigma_sd')`, `('path_onset_sd', 'onset_sd')`, `('onset_sd', 'onset_sd')`. The μ pair lookups are renamed to read the predictive names — `path_mu_sd_pred` and `mu_sd_pred` — because the result dict feeds the upstream-carrier and span-prior machinery that lives in the forecasting call graph. The σ and onset pairs are unchanged because those dispersions are epistemic-only. Both copies of the function are renamed together so the v1-v3 behaviour stays aligned until doc 56's retirement workstream eventually deletes the v1 module. The edge-params fallback chain at `cohort_forecast.py:589,602` — the two `edge_params.get('bayes_path_mu_sd', edge_params.get('bayes_mu_sd', 0.0))` lookups — is renamed in the same way to read the predictive promoted-field names.

`compute_confidence_band` in `confidence_bands.py` remains a flavour-agnostic pure function: it accepts an SD parameter and draws accordingly. Its callers change according to their intent. The callers in `api_handlers.py` that today build model-overlay curves for cohort_maturity_v3 — the block around lines 1960 through 2000 and the secondary call at line 4234 — switch to reading the epistemic `edge_sds` dict from `build_prepared_span_execution_from_topology`. Forecasting callers continue to read the predictive dict.

### 6.5 FE consumer layer

The posterior card's textual ± labels and HDI ranges are the primary reporting surface. The display of μ for edge and path switches from `lat.mu_sd` to the new bare `lat.mu_sd`, which now holds the epistemic value. The display of probability switches from the `alpha_pred ?? alpha` fallback pattern to reading `alpha` directly, on the principle that the reporting card shows the model's belief rather than the noisy expected observation range. HDI endpoints likewise switch to the bare forms `hdi_lower` / `hdi_upper`. The `*` epistemic footnote and its tooltip are removed; the card is now uniformly epistemic and the footnote's explanation is no longer needed.

`ModelRateChart`, the model-rate mini-chart embedded in both the posterior card and any edge-properties or edge-info panel that uses it, receives `lat.mu_sd` (now epistemic) in its `edgeMuSd` and `pathMuSd` props. Its internal unscented-transform band construction is unchanged; only the SD value it receives moves.

`ModelCard` for non-Bayesian sources continues to read its heuristic SD values from the `model_vars.latency` block. Those values are epistemic by construction and need no change. When `ModelCard` delegates to `BayesPosteriorCard` for a Bayesian source, it inherits the corrected reporting behaviour automatically.

`cohortComparisonBuilders.ts` renders bands supplied by the backend in the `source_model_curves` response dictionary. No FE change is required here: the backend change at the overlay-handler level flows through to the bands the builder renders.

### 6.6 Docs and tests

Doc 49 gains a header note marking §A.6 Invariant 9 and §A.9 Invariant 5 as superseded by this doc. Doc 49's body is not rewritten in place: readers who follow cross-references land on the superseding note and follow the link to this doc. STATS_SUBSYSTEMS.md's field-authority cheat sheet is updated to reflect the renamed fields and the reporting/forecasting consumer contract. The bayesPatchService.ts comments that today cite doc 49 §A.9 are rewritten to cite this document.

A ratchet test is added under the CI suite that greps the codebase for references to the `_pred` suffix variants in files identified as reporting surfaces (the posterior card, the model-rate mini-chart, the relevant sections of the api_handlers overlay builder), and fails if any such reference is introduced. A parallel test fails if any known forecasting file reads the bare `mu_sd` in a span-kernel preparation context. The whitelist is explicit and reviewed.

A migration test proves that the apply-time shim correctly renames old-shape slice keys to new-shape projection keys on a saved old-format patch fixture. A component test proves that `BayesPosteriorCard` narrows its μ band noticeably when kappa_lat is fitted on a fixture where the two flavours differ materially. A backend integration test proves that the cohort_maturity_v3 overlay band on a kappa_lat-fitted fixture is narrower than the corresponding forecast fan band from the same fixture, confirming that the reporting and forecasting surfaces now use different flavours.

## 7. Phasing

The rename and the consumer rewire must land as a single atomic change across the backend and frontend; intermediate states where half the system knows the new names and half the old would produce silently wrong numerical outputs on in-flight requests. The one piece that can land independently is the migration shim in `bayesPatchService.ts`, which is added as an additive read path in a pre-phase, so that when the main phase lands the shim is already in place and ready to handle old-shape patches.

Within the atomic phase the delivery order is bayes compiler first, then webhook transport, then FE patch projection, then Python backend consumers, then FE consumers, all in one commit. The component and integration tests land in the same commit. The doc updates land in a second commit immediately after, so the supersession note on doc 49 becomes active the moment the code change is merged.

A follow-up phase, targeted one release later, removes the old-shape migration shim and the associated session-log warnings. By then every Bayes fit will have produced a new-shape patch, and any graph whose last fit predates this change will already have been migrated on load or surfaced as a re-fit prompt.

A second follow-up, not blocking, sweeps daily conversions, bridge, and surprise-gauge chart builders for reporting-vs-forecasting intent and applies the same consumer rule to any bands they produce. The initial commit covers the three known reporting surfaces — posterior card, model-rate mini-chart, cohort_maturity_v3 overlap curves — plus the forecast-fan consumers that are already correct. Other chart types are not currently known to render a reporting-vs-forecasting uncertainty band but need a quick audit once the machinery is in place.

## 8. Backwards compatibility and migration

### 8.1 Principle: one canonical migration hook

The contract consumers see is strictly "bare name is epistemic, `_pred` suffix is predictive". No consumer — in the FE, on the BE, or in the CLI — carries any schema-compat logic or any fallback through a "legacy" field name. Every dispersion read goes straight to the new name.

To make that contract real, migration from old-shape to new-shape data is concentrated at **two narrow entry boundaries** that every piece of graph state passes through before any consumer touches it. There is no third hook and no per-consumer fallback. If a consumer encounters an old-shape field, it is a migration-hook bug, not a consumer concern.

The two entry boundaries are:

**Boundary 1 — incoming Bayes patches.** Every patch file the FE receives passes through `bayesPatchService.applyPatch`, which is the single entry point for writing patch data into per-parameter files and onto graph-edge posteriors. A slice-normalisation step at the head of the apply flow inspects each slice entry and rewrites old-shape keys (`mu_sd` meaning "predictive-or-fallback", `mu_sd_epist` meaning "always epistemic") into new-shape keys (bare `mu_sd` meaning "always epistemic", `mu_sd_pred` meaning "always predictive"). The rewrite is idempotent. Old-format patches still produced by versions of the worker that predate the webhook version bump continue to apply cleanly after this rewrite. Old patch files already in the repo's `_bayes/patch-*.json` area are likewise handled on scan-and-apply.

**Boundary 2 — stored graph and parameter-file loads.** Every graph file and every parameter file that the FE loads from IndexedDB or from git passes through a single normalisation pass during the initialisation phase that already exists for key sorting and default injection. The same slice-normalisation helper used by boundary 1 is invoked here. After this pass, the in-memory graph and parameter-file posterior slices carry only new-shape fields. The FE workspace service is the canonical owner of this hook. The CLI analyse path, which loads graph and parameter files directly from disk into a similar in-memory shape before dispatching to the BE, uses the same helper at its graph-engorgement step. No Python-side migration is needed because every BE request receives a payload that has already passed through one of the two boundaries.

The two boundaries share a single slice-normalisation helper exported from `posteriorSliceResolution.ts`, so their behaviour is guaranteed identical. The helper's contract is: take a slice entry, return an entry in new-shape; old-shape inputs are rewritten; new-shape inputs pass through unchanged. No information loss, no semantic interpretation, no flags.

### 8.2 Migration rules for the three data populations

Recent graphs whose last Bayes fit occurred on or after 18-Apr-26 carry both `mu_sd` (the old context-dependent slot, always predictive when kappa_lat was present) and `mu_sd_epist` (always epistemic). The normalisation rule for these is mechanical: the new bare `mu_sd` takes the value of the old `mu_sd_epist`, and the new `mu_sd_pred` takes the value of the old `mu_sd`. The `mu_sd_epist` key is dropped. Path-level fields follow the same rule. The result is lossless and semantically correct: the bare field genuinely is epistemic, the `_pred` field genuinely is predictive.

Older graphs whose last Bayes fit occurred before 18-Apr-26 carry only `mu_sd`, with no `mu_sd_epist` companion. The normalisation rule duplicates the value: the new `mu_sd_pred` takes the old `mu_sd` value, and the new bare `mu_sd` also takes the same old value. This is correct in the majority case (kappa_lat was off, in which case old-`mu_sd` was epistemic and the two flavours were equal anyway) and benign in the minority case (kappa_lat was on, in which case old-`mu_sd` was predictive and reporting surfaces continue to show a predictive-width band for those edges — exactly the pre-migration behaviour, so no regression). A session-log entry flags each such edge as "pre-doc-49 shape, re-fit recommended"; users who re-fit subsequently receive clean two-flavour data. No `_legacy` field is ever introduced. Consumers are unaware of the distinction.

Graphs without any Bayes fit are unaffected. The analytic and analytic_be sources write heuristic epistemic SDs under the bare `mu_sd` name already, which is compliant with the new rule without any change.

### 8.3 Transport and version

The webhook patch-file payload carries an explicit schema version. The compiler emits the incremented version when it writes new-shape patches; the FE patch service reads the version to choose between the direct new-shape apply path and the old-shape-then-normalise path. After one release, the old-shape branch and its associated warnings are removed in a follow-up commit, and the slice-normalisation helper collapses to a pass-through for its remaining duty on stored files (which by then will also all be new-shape for any graph that has been loaded at least once).

### 8.4 What consumers are guaranteed

After boundaries 1 and 2 have run, every in-memory graph, parameter file, and patch payload in every runtime — FE, BE request payload, CLI in-memory — carries exclusively new-shape dispersion fields. The BE never sees old-shape data because every BE request is constructed from an in-memory graph that has already passed through boundary 2. Consumers therefore compile and test against exactly one schema. The "simplicity" claim at the head of this plan is load-bearing: there is no per-consumer compat layer, no legacy-field fallback, and no schema-version branching below the two boundaries.

## 9. Risks and mitigations

The chief risk is a mismatched rename: one call site left reading the old name and silently falling into a default path, producing wrong numerical outputs that pass tests because the test fixture happens not to exercise the kappa_lat-fitted case. The mitigation is a comprehensive grep-based ratchet test run in CI, plus a component-level visual test that deliberately uses a kappa_lat-fitted fixture and asserts band width.

A second risk is that pre-doc-49 graphs have their single old `mu_sd` duplicated into both new fields, which means reporting surfaces for those edges continue to render predictive-width bands (when the edge had kappa_lat fitted at its original write time) until a re-fit produces clean two-flavour data. This is a correctness gap for stale graphs, not a regression. The mitigation is a session-log warning emitted once per such edge when the migration hook runs, plus a one-click "re-fit to clean schema" affordance in the Bayes quality panel added alongside the rename. Users with a stale graph see the warning and have a direct path to remediate.

A third risk is confusion during review: a reviewer reading the diff sees the field name `mu_sd` suddenly changing meaning, and without reading this document may miss that fact. The mitigation is an explicit note in the PR description and a cross-reference from the renamed file's headers to this document. The naming comment in types.py `LatencyPosteriorSummary` is updated to state the new rule unambiguously, so any future reader starting from the compiler output also lands on the correct interpretation.

A fourth risk is that the forecast fan on kappa_lat-fitted edges renders a visibly wider band than before because the fan was incorrectly narrow under some prior code path that happened to read the epistemic value. Investigation to date indicates this is not the case — the fan path already reads `mu_sd` which is predictive when kappa_lat is fitted — but the baseline-recapture commit on the existing cf-truth-parity harness catches any band-width drift introduced by the rename.

## 10. What remains untouched

The Bayesian model itself is unchanged. No prior, likelihood, sampling parameter, or model structure is modified. The MCMC trace is identical. The compiler's internal `_predictive_mu_sd()` helper and its call conditions are unchanged; only the field into which its output is deposited moves.

The forecast engine in `forecast_state.py` and `span_kernel.py` is unchanged at the behaviour level. Span composition, IS conditioning, upstream carrier construction, and monte-carlo sweep logic all operate on prepared per-edge dispersion tuples as they did before. The dispersion values inside those tuples are the correct flavour because the preparation step knows which flavour to read.

The non-Bayesian `analytic` and `analytic_be` model_vars sources are unchanged. Their heuristic dispersion SDs are epistemic by construction and fit the new naming rule without modification. The FE topo pass and BE topo pass continue to write the same fields they wrote before.

The funnel chart's compound-whisker band construction is unchanged because it already distinguishes epi and pred flavours under names that comply with the new rule.

The `cohort_maturity_v2` dev-only chart handler is unchanged. Doc 56's partial-retirement boundary keeps that handler on the frozen v2 module, which continues to carry the old field shape for parity-oracle purposes. Its continued divergence from production is expected and documented.

Existing test fixtures for the Bayes regression pipeline need their stored posterior JSON updated to the new field names. The fixture-update commit lands with the rename commit to keep the regression harness green across the transition.

## 11. Acceptance criteria

The change is considered complete when the following are all true. The Bayes compiler emits patch files whose slice entries carry `mu_sd` as the epistemic posterior SD and `mu_sd_pred` as the predictive one, at both edge and path level. The webhook-transport contract version is incremented and the reader tolerates both old and new shapes. The FE patch service projects the new fields onto the graph edge and runs the migration shim on old-shape patches with a session-log warning. All Python backend consumers read the flavour matching their intent, with forecast_runtime preparation emitting both flavours and each downstream caller selecting the correct one. The posterior card displays epistemic values for μ, σ, onset, and probability, and its `*` footnote is removed. The model-rate mini-chart draws bands from the epistemic SDs. The cohort_maturity_v3 overlap curves are materially narrower than before on a kappa_lat-fitted fixture. The cohort_forecast_v3 forecast fan is unchanged numerically because it continues to read the predictive flavour under its new name. The CI ratchet test prevents regression. Doc 49's superseded invariants carry the supersession note, STATS_SUBSYSTEMS.md reflects the new contract, and the code comments in bayesPatchService.ts cite this document.

The migration shim in bayesPatchService.ts is removed, and the associated session-log warning retired, in a follow-up one release after the main change lands.
