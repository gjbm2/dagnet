# Per-Date Prior Schedules in the Conditioned-Forecast Projection Apparatus

**Status**: Staged implementation plan, revised 2-Jun-26
**Trigger**: 73q Phase 8b (`conversion_rate` migration onto the shared CF runtime)
**Audience**: written to be engageable by someone who does not know this codebase. Domain terms are defined as they appear; a code-surface appendix at the end points maintainers at the exact symbols.

---

## 1. Summary

The system's conditioned-forecast (CF) projection machinery currently behaves as if every request has **one promoted model fit per parameterised edge**. That is right for the normal question users ask: "given the latest and greatest model, what do we expect?"

One analysis needs a different question. `conversion_rate` is a calendar time-series whose purpose is to show **how the model's expectation evolved over time**. A row for January should use the fit current in January; a row for March should use the fit current in March. With daily fits, a 30-day chart can have 30 distinct prior states.

The generalisation we need is therefore not "run CF once per date". That would rebuild the whole topology, evidence, runtime, projection, and reducer for every displayed date. It is also not "let a chart reducer look up fit history locally". That repeats the current `conversion_rate` hack and lets projection re-decide model semantics.

The clean generalisation is:

**Every CF request receives a `PriorSchedule` at the perimeter.**

- For ordinary latest-view requests, the perimeter supplies a **uniform** schedule: every row/date entry points at the same current promoted fit.
- For `conversion_rate`, the perimeter supplies a **date-indexed** schedule: each displayed row/date points at the fit current as of that date.
- The CF engine always consumes the schedule. It does not branch on "latest" versus "historical". Uniform latest-view is a data degeneracy of the same scheduled interface.

This matters because priors do more than initialise the conditioning step. In the live CF code, prior-derived model parameters feed all prior-bearing operator families:

- the epistemic conditioned primitive family that produces the conditioned model surface (`f_*`);
- the predictive conditioned primitive family that produces the frontier-conditioned forecast surface (`ef_*`);
- the unconditioned overlay family used for optional model curves and saturation-style reads.

So the requirement is broader and sharper than "select alpha/beta by date". The runtime needs a row-aligned prior schedule that supplies the full `ResolvedModelParams` surface wherever the existing code currently consumes a single `ResolvedModelParams`.

---

## 2. Domain Context

A few concepts are load-bearing for the rest of this note.

**The product.** A browser-based editor for conversion-funnel models, backed by a Python service that does Bayesian inference and forecasting. Users draw a directed graph of user states (for example, *signed up → activated → purchased*). Each **edge** carries a **conversion rate** `p = y / x`: of the `x` users who reached the edge's start, `y` converted to its end.

**Latency and maturity.** Conversions are not instantaneous. A user who arrives today may convert next week. So for a recently-started **Cohort** (a dated group of users), the observed `y / x` understates the eventual rate: not enough time has passed. As the Cohort ages, `y` climbs toward its eventual value. The fraction of eventual conversions already observed is the Cohort's **completeness**. A chart that plots recent calendar periods alongside old ones therefore shows a characteristic "reverse trumpet": recent periods look artificially low with wide uncertainty because their Cohorts are immature. Edges where this matters are called **latency edges**.

**Fits and priors.** Offline, a Bayesian inference job fits, per edge, a posterior distribution over conversion rate, plus latency parameters. The CF runtime consumes that fitted posterior as a **prior** for query-time conditioning. The job is re-run periodically, so each edge accumulates a **fit history**: a timeline of priors, each stamped with when it was fitted. "The fit current as of date D" means the latest fit-history entry on or before D: what the model believed at that point in time.

**Promotion.** At read time the system selects the best-available fit for an edge: a quality-gated Bayesian fit, else an analytic fallback. The selected one is the **promoted** fit. Today, promotion is current-state promotion: it resolves the single current `model_vars` entry.

**The conditioned-forecast apparatus.** For a given query, CF resolves graph topology, binds evidence, conditions per-edge primitives, composes carrier and subject spans, and projects selected-Cohort surfaces. Its output is a **projection bundle**. Reducers read that bundle into chart-specific shapes: one keeps the age axis, one keeps the calendar/Cohort axis, and one collapses to scalars.

**`asat()` query mode.** The query language has an `asat(D)` clause meaning "answer as if it were date D". By specification, `asat(D)` must affect both evidence selection and posterior/fit-history selection. The current shared resolver does not yet honour that posterior frontier. `conversion_rate` is the first consumer forcing the issue at row granularity rather than request granularity.

---

## 3. The `conversion_rate` Analysis Today

`conversion_rate` produces a time-series: conversion rate per calendar **bin** (day, week, or month), with an uncertainty band per bin. Today it is a standalone derivation that **bypasses the projection apparatus entirely**. Two things to note about how it computes:

- **Central value**: the *observed* `Σy / Σx`, aggregated over the cohorts whose anchor day falls in the bin, using each cohort's latest snapshot. It is an as-observed number.
- **Uncertainty band**: resolved *per bin* by walking the edge's **fit history** and taking the `Beta(α, β)` of the fit **current as of that bin's date**. Bin in January uses January's fit; bin in March uses March's fit.

So the chart's distinctive character is a **historical expectation monitor**: "how did our expected conversion rate evolve over calendar time?" This is different from the ordinary CF question, "given the latest model, what is the best current estimate for this selected Cohort set?"

The code audit on 2-Jun-26 also found an important frontier mismatch in the current implementation. The observed central value uses the latest snapshot admitted by the request-level evidence cap, while the band uses a per-bin fit-history walk. In other words, today's `conversion_rate` is already a hybrid: latest or request-capped evidence, historical prior bands. That is useful as a diagnostic chart, but it is not an honest row-wise `asat(D)` answer.

The standalone derivation also excludes latency edges. That exclusion is not a product feature; it is a limitation of the standalone path. For immature recent bins, raw observed `y / x` is misleading, and the standalone derivation has no forecast machinery to continue unresolved future mass.

---

## 4. What the CF Code Actually Does With Priors

The live runtime does not use priors in just one place. The prior-bearing surfaces are built at several coordinated points.

### 4.1 Current Model Resolution

The shared resolver, `resolve_model_params`, returns one current `ResolvedModelParams` object. That object carries:

- epistemic probability shape (`alpha`, `beta`);
- predictive probability shape (`alpha_pred`, `beta_pred`);
- subset mass (`n_effective`);
- latency moments and dispersions;
- source and fit metadata.

The existing `conversion_rate` band helper, `resolve_rate_bands`, only resolves display bands from fit history. It is not enough for CF because CF needs the full resolved model object, not just an HDI.

### 4.2 Primitive Conditioning

`primitive_readout.prepare_primitive` first binds evidence for one primitive, then calls `condition_primitive` with one resolved model. `condition_primitive` consumes the resolved prior to build probability draws and timing draws. Its `dispersion_basis` selects which prior moment family to use:

- `epistemic`: uses `alpha` / `beta` and epistemic latency dispersion. This is the basis for the conditioned model surface.
- `predictive`: uses `alpha_pred` / `beta_pred` and predictive latency dispersion where available. This is the basis for the frontier-conditioned forecast surface.

Therefore a prior schedule must feed both basis families. A historical chart that varies only the epistemic family but leaves predictive FC on the current fit would be internally inconsistent.

### 4.3 Model and FC Surfaces

`model_span_spine.resolve_request_spans` prepares multiple operator families:

- an epistemic conditioned family, composed into `composed_carrier` and `composed_subject`;
- a predictive conditioned family, composed into `composed_carrier_predictive` and `composed_subject_predictive`;
- empirical evidence families, which are prior-free;
- optional unconditioned overlays, built from priors without evidence.

`project_selected_cohort_rows` then projects those families:

- `f_*` comes from the epistemic conditioned model family;
- `ef_*` comes from the predictive conditioned FC family, prefix-pinned to strict empirical evidence through each Cohort's frontier;
- strict evidence fields come from empirical operators and are not prior-bearing;
- optional model-curve fields come from unconditioned overlays.

So a date-indexed prior requirement must reach the operator families before projection. It must not be patched into the reducer after projection.

### 4.4 Existing Per-Cohort Axis

The date reducer already consumes per-Cohort arrays such as `f_rate_draws_by_cohort` and `ef_rate_draws_by_cohort`, with shape conceptually `(Cohort, Draw, Tau)`. That is exactly the axis `conversion_rate` needs: one row/date per displayed Cohort/bin.

The missing capability is that the kernels feeding those arrays are currently cohort-invariant. Every Cohort row uses the same resolved prior. A `PriorSchedule` makes those kernels row-aware.

This is not just a resolver-plumbing change. In the live code, the row axis appears after primitive conditioning and span composition. Primitives and composed spans are currently scalar-prior objects with request-wide `(Draw, Tau)` kernels; the bundle later scatters their outputs onto a `(Cohort, Draw, Tau)` date-axis view. A date-indexed schedule therefore has to change the prior-bearing primitive/kernel surfaces themselves. Passing row metadata to the reducer after projection would be too late.

---

## 5. The Proposed Abstraction: `PriorSchedule`

`PriorSchedule` is the row-aligned model-prior input for a CF request.

It should be prepared at the perimeter, alongside the request envelope and selected-Cohort set. The engine should never decide whether a request is latest-view or historical-view. It should simply consume the schedule it was given.

Conceptually, a schedule contains:

- the ordered row/date keys it aligns to;
- for each parameterised edge and each row/date key, the resolved `ResolvedModelParams`;
- schedule metadata describing whether all rows share the same resolved parameters or vary by row;
- source/fitted-at provenance for diagnostics and chart labelling.

Two important degeneracies:

- **Uniform latest schedule**: every row key maps to the same current promoted fit. This is the ordinary CF request. It should preserve current behaviour and current fast paths.
- **Date-indexed schedule**: each row key maps to the fit current as of that row's date. This is the `conversion_rate` historical expectation request.

The current single `ResolvedModelParams` object is therefore the special case of a schedule whose row entries are all identical.

---

## 6. Where the Schedule Threads Through the Stack

### 6.1 Perimeter Preparation

The shared boundary in `cf_analysis.prepare_cf_projection_bundle` should arrange for a prior schedule before the runtime is built. It already sequences preparation and bundle construction; schedule construction belongs in the same perimeter layer.

For latest-view requests, the perimeter should resolve the current promoted model once per edge and broadcast it across the selected row keys. For historical expectation requests, it should resolve fit history against each row date.

The schedule is part of the request's mathematical identity. Its provenance should be visible in runtime diagnostics, and its identity should participate in cache keys wherever the prior currently participates.

### 6.2 Span Resolutions

Today `SpanEdgeResolution` and `CarrierEdgeResolution` carry a single `resolved_model`. They should instead carry a prior schedule entry for that edge.

This keeps topology resolution unchanged:

- the subject span is still `X -> end`;
- the carrier span is still `A -> X` when active;
- identity carrier is still a data degeneracy;
- single-hop and multi-hop still compose through the same span machinery.

Only the per-edge model payload changes from scalar to scheduled.

### 6.3 Primitive Construction

`prepare_primitive` should continue to bind evidence once for the primitive scope. Then, instead of passing one `ResolvedModelParams` to `condition_primitive`, it passes the row-aligned schedule for that primitive.

The scheduled primitive is still a single primitive object in the runtime sense: one transition, one scope, one evidence binding, one row-aligned prior schedule. It is not 30 independent primitive objects and it is not 30 request builds.

The scheduled primitive should produce row-aware draw/kernel surfaces. In uniform mode, every row slice is identical by construction.

### 6.4 Conditioned Operator Families

The schedule must be consumed consistently by every prior-bearing operator family:

- epistemic conditioned family for `f_*`;
- predictive conditioned family for `ef_*`;
- unconditioned overlay family where overlays are requested.

Empirical operator families do not consume the schedule. They remain driven by admitted evidence and arrival-clock binding.

This split is important: the strict evidence layer answers "what was observed"; the scheduled prior-bearing layers answer "what the model expected under this row's prior state, after the selected evidence policy is applied".

### 6.5 Projection

`project_selected_cohort_rows` should not gain fit-selection logic. It should continue to consume composed spans and selected Cohorts, producing `f_*`, `ef_*`, strict evidence, and residual forecast arrays.

If the composed spans were built from a uniform schedule, projection output matches today's latest-view output. If they were built from a date-indexed schedule, each Cohort row's prior-bearing surfaces already reflect that row's prior date.

Reducers then stay simple readouts.

---

## 7. Execution Policy: Toeplitz When Uniform, Banded When Scheduled

The current fast path relies on cohort-invariant kernels. In `subject_span_composer._build_flat_stream_kernel_provider`, the provider ignores `cohort_index`; the same kernel is broadcast to every Cohort. That is valid for a uniform schedule.

The DP already has the right abstraction for avoiding an engine branch: execution policy is declared at the provider boundary and consumed by `timing_span` as data.

The policy rule should be:

- **Uniform schedule**: kernels are cohort-invariant and source-bucket shift-invariant. Use the existing `TOEPLITZ_APPLY` policy.
- **Date-indexed schedule**: kernels vary by Cohort/date. Use a scheduled/banded policy that can contract row-specific kernels across the Cohort axis.

This is not a mode branch inside the engine. It is the same pattern already used by the DP core: the caller declares an operator-application strategy, the DP body calls the resulting applier uniformly.

The current `SOURCE_BANDED` policy is the closest existing shape. It supports kernels indexed by Cohort and source bucket. A scheduled-prior provider may be a model-side analogue of that policy rather than a literal reuse of the empirical provider, but the algebraic shape is the same: the kernel is allowed to vary across the row/Cohort axis.

The invariant is:

**Schedule homogeneity decides the operator policy at the perimeter/provider boundary; the DP core remains policy-generic.**

### 7.1 Non-Latency / Instant-Maturity Optimisation

Non-latency edges are the important degenerate case for `conversion_rate`. Their timing kernel is Dirac-at-zero: every Cohort is mature immediately with respect to the edge's own conversion latency. For a single non-latency edge, a date-indexed prior changes the row's probability surface, but it does not need a latency projection over future `tau` to correct censoring.

That does not mean the current shared CF bundle can skip `tau` today. The live projection contract still emits `(Cohort, Draw, Tau)` arrays, and the date reducer reads the saturation column. The optimisation opportunity is therefore an execution-policy question, not a semantic fork: a scheduled non-latency provider may be able to contract row-specific probability kernels directly at the date axis, while latency edges continue to use the full frontier-conditioned tau projection.

Acceptance for this optimisation should be strict:

- it must be selected from the same schedule/operator metadata that selects Toeplitz versus banded execution;
- it must leave the public bundle/reducer contract coherent, or introduce an explicit scalar/date-axis projection contract at the perimeter;
- it must not create a `conversion_rate`-local fit-history lookup or a separate analysis engine.

---

## 8. Evidence Semantics

There are two different questions that a historical expectation chart might ask:

1. **Honest as-at expectation**: for row date D, use the fit current as of D and admit only evidence available as of D.
2. **Historical prior with latest evidence**: for row date D, use the fit current as of D but condition on the latest available evidence.

Only the first is a true `asat(D)` answer. The second can be useful diagnostically, but it is a hybrid and should be labelled as such.

This decision should be explicit in the schedule/evidence contract. The evidence side already carries `retrieved_at` and `as_at` concepts; the scheduled path must not silently mix a date-indexed prior frontier with a different evidence frontier.

For `conversion_rate`, the product intent sounds closest to "how has our expectation evolved over time". That usually implies the honest as-at version: prior frontier and evidence frontier both move with the row date. But if the desired chart is "today's data interpreted under historical priors", that should be specified separately.

---

## 9. Constraints Any Solution Must Respect

- **Always scheduled at the perimeter.** Latest-view requests do not bypass schedules; they receive a uniform schedule. This avoids an engine branch and makes the new interface universal.
- **One conditioning locus.** Evidence still updates primitives only in the primitive-conditioning layer. A schedule changes the prior supplied to that layer; it does not introduce projection-time conditioning.
- **Projection does not select fits.** Reducers and chart code never walk fit history. If a reducer sees `f_*` or `ef_*`, the relevant prior choice is already baked into those surfaces.
- **All prior-bearing surfaces use the same schedule.** `f_*`, `ef_*`, and unconditioned overlays must not silently diverge by using different fit dates.
- **Empirical evidence remains prior-free.** Strict evidence fields are not reinterpreted through the prior schedule.
- **Execution policy is data.** Uniform schedules may use Toeplitz. Non-uniform schedules use a banded/scheduled policy. The DP body does not branch on analysis type or schedule type.
- **Cache identity includes schedule identity.** Primitive and span caches currently include scalar prior values, evidence identity, scope identity, and composed primitive object identity. Scheduled priors must be keyed so uniform and non-uniform requests cannot collide, and so two date-indexed schedules with different historical fit selections cannot share primitive, span, or draw-family artefacts accidentally.
- **No N-request sweep.** A daily 30-row chart should not run the full CF machinery 30 times. It should build one request, one evidence superset, one scheduled runtime, and one projection.

---

## 10. Open Questions

1. **What is the evidence frontier for `conversion_rate`?** Is the chart an honest row-wise as-at answer, or a historical-prior/latest-evidence hybrid?

2. **What is the exact row key?** For day bins it is probably the Cohort/bin date. Today the standalone `conversion_rate` path uses bin start for week/month bins. Should the shared schedule preserve that rule, move to bin end, or declare a separate representative date?

3. **How dense and durable is fit history?** Daily fits make the use case natural, but retention settings can leave older bins before the earliest retained fit. The schedule resolver needs an explicit rule for missing historical priors.

4. **How should analytic fallback behave historically?** Bayesian fit history exists in parameter files. Analytic model vars are current graph-derived material. If the historical Bayesian fit is missing or fails the gate, should the schedule fall back to current analytic, historical analytic if available, or no prior for that row?

5. **How far should scheduled priors extend beyond `conversion_rate`?** The abstraction should be general, but the first acceptance target can be the row/date reducer path. Other CF consumers can receive uniform schedules until they need historical expectation.

6. **Can instant-maturity schedules bypass tau projection?** For non-latency single-edge `conversion_rate`, the timing kernel is Dirac-at-zero and each Cohort is mature immediately with respect to the edge. The implementation should decide whether this remains a full `(Cohort, Draw, Tau)` bundle degeneracy, or whether a date-axis scalar projection is introduced as an explicit optimisation without forking semantics.

---

## 11. Staged Implementation Plan

This is no longer just a problem statement. It is the staged plan for getting `conversion_rate` out of its broken standalone implementation and rebuilding it on the shared CF machinery.

### Stage 1 — Retire The Broken `conversion_rate` Path

This is the urgent cleanup stage. It must remove the broken processing logic while preserving the public `conversion_rate` slot that Stage 2 will reuse. Do **not** tear out the analysis id, chart kind, display-settings key, or registry identity just to recreate them later. The target state is a dormant, explicit, non-computing `conversion_rate` analysis whose old derivation is unreachable.

Implement Stage 1 in the following atoms.

#### Stage 1.1 — Add One Shared Retirement Payload

Add a small helper in `graph-editor/lib/api_handlers.py` near the snapshot handlers:

- name it something explicit, for example `_conversion_rate_retired_result`;
- return a response-shaped result with `analysis_type: 'conversion_rate'`, `data: []`, and metadata such as `unavailable: true`, `retired_stage: 'stage_1'`, and a message like `conversion_rate is temporarily unavailable while it is rebuilt on the shared CF runtime`;
- use the same helper for the main runner path and the legacy snapshot-query path.

The goal is one canonical dormant payload. Do not leave multiple string literals in separate branches.

#### Stage 1.2 — Sever The Main BE Production Path

Edit `graph-editor/lib/api_handlers.py` in `_handle_snapshot_analyze_subjects`.

Current live branch:

- matches `analysis_type == 'conversion_rate'`;
- imports `derive_conversion_rate`;
- looks up `_cr_edge`;
- runs a conversion-rate-specific `latency_parameter` gate;
- reads `display_settings.bin_size`;
- calls `derive_conversion_rate(rows, bin_size, edge, temporal_mode)`;
- prints `[conversion_rate]` debug messages.

Replace that whole branch with a call to the shared retirement payload. Keep the per-subject envelope shape used by the snapshot handler, but do not query or derive bins for `conversion_rate`.

Remove from the branch:

- the import of `derive_conversion_rate`;
- the `_cr_edge` lookup;
- the `latency_parameter` gate;
- the `bin_size` read;
- the `temporal_mode` read;
- the `try/except` around `derive_conversion_rate`;
- all `[conversion_rate]` prints.

Do not remove `conversion_rate` from `ANALYSIS_TYPE_SCOPE_RULES` in this atom. Keeping it there is what prevents explicit `conversion_rate` requests from falling through to `path_runner` and returning the wrong analysis.

#### Stage 1.3 — Sever The Legacy Snapshot-Query Path

Edit `graph-editor/lib/api_handlers.py` in `_handle_snapshot_analyze_legacy`.

Current legacy branch:

- matches `analysis_type == 'conversion_rate'`;
- imports `derive_conversion_rate`;
- calls `derive_conversion_rate(rows, bin_size='day')`.

Replace it with the same shared retirement payload. This closes the second live entry point.

#### Stage 1.4 — Preserve Registries, But Change Their Meaning

Keep these identifiers in place:

- `conversion_rate` in `graph-editor/src/components/panels/analysisTypes.ts`;
- `conversion_rate` in `graph-editor/lib/runner/analysis_types.yaml`;
- `conversion_rate` in `graph-editor/src/services/analysisTypeResolutionService.ts`;
- `conversion_rate` chart kind in `graph-editor/src/components/charts/AnalysisChartContainer.tsx`;
- `conversion_rate` display settings in `graph-editor/src/lib/analysisDisplaySettingsRegistry.ts`.

Change their copy to dormant/rebuild language:

- in `analysisTypes.ts`, replace the old short description and selection hint with "temporarily unavailable while rebuilt on CF";
- in `analysis_types.yaml`, replace "Per-bin observed rate with Bayesian epistemic uncertainty bands" with "temporarily unavailable while rebuilt on the shared CF runtime";
- in `analysisDisplaySettingsRegistry.ts`, update the comment above `conversion_rate` so it no longer says "doc 49 Part B. Non-latency edges only" as a live contract.

Do **not** remove these entries unless a specific caller cannot display a dormant state. The point is to clean up the processing, not churn the public identity.

#### Stage 1.5 — Make FE Normalisation Render The Dormant State

Edit `graph-editor/src/lib/graphComputeClient.ts` in `normaliseSnapshotConversionRateResponse`.

Add explicit handling for the retirement payload before the normal bin-flattening path:

- recognise `analysis_type: 'conversion_rate'` with metadata `unavailable` or the agreed retirement marker;
- return a valid `AnalysisResult` with `analysis_type: 'conversion_rate'`, `analysis_name: 'Conversion Rate'`, `metadata.unavailable: true`, the migration message, and `data: []`;
- keep `chart.recommended: 'conversion_rate'` and `alternatives: ['table']` so the chart container can render a controlled empty/unavailable state.

Do not let all-subject failure fall through to `null`, because that becomes a generic "No result returned" failure instead of the migration state.

#### Stage 1.6 — Make The Chart Builder Harmless For Dormant Results

Edit `graph-editor/src/services/analysisECharts/snapshotBuilders.ts`.

In `buildConversionRateEChartsOption`:

- update the docstring so it no longer describes the old observed-rate plus HDI contract as live;
- if `result.metadata.unavailable` is true, return `null` without attempting to build old scatter/model-band series;
- leave the rest of the builder in place as a dormant Stage 2 shell.

Do not delete the builder in Stage 1.

#### Stage 1.7 — Ensure UI Entry Points Agree

Review these callers and make only the minimal changes needed for a coherent dormant state:

- `graph-editor/src/components/panels/AnalysisTypeCardList.tsx` already filters `devOnly`, but Stage 1 should not rely on `devOnly` as the primary mechanism;
- `graph-editor/src/components/charts/ExpressionToolbarTray.tsx` currently uses `ANALYSIS_TYPES.filter(tm => !tm.internal)` for "Show all"; if `conversion_rate` is marked `devOnly`, this must also filter `devOnly` outside dev;
- `graph-editor/src/components/charts/AnalysisChartContainer.tsx` should be able to show the normal "Chart unavailable" / no-chart state for the dormant result;
- saved canvas analyses in `CanvasAnalysisNode` should receive the FE-normalised dormant result, not a generic thrown error.

Preferred Stage 1 behaviour: the slot remains visible only where useful, and any attempt to run it shows the same CF-rebuild-pending message.

#### Stage 1.8 — Quarantine The Old Contract Tests

Edit `graph-editor/lib/tests/test_conversion_rate_blind.py`.

The current tests assert the broken live contract:

- T1: `analysis_type == 'conversion_rate'`;
- T2/T3/T7: non-empty bins;
- T4: `rate == y / x`;
- T6: latency-edge rejection;
- T8: `epistemic` key on every bin.

Do not keep these as default green tests. Either:

- move them to a historical-contract test module excluded from normal runs; or
- mark the class skipped with an explicit Stage 1 retirement reason.

Add a new Stage 1 test in the same area or a new targeted BE test:

- call `handle_runner_analyze` or the CLI with `analysis_type: 'conversion_rate'`;
- assert the retired/unavailable result;
- assert no successful `data` bins are returned;
- assert the old `rate == y / x` contract is not published.

Update `graph-ops/scripts/conversion-rate-blind-test.sh` so the default command no longer runs old-contract tests as if they were acceptance. If kept, it should be an explicit historical-contract runner.

#### Stage 1.9 — Mark Helper Modules Reference-Only

Edit `graph-editor/lib/runner/conversion_rate_derivation.py`.

At minimum:

- change the module docstring to say it is retired/reference-only after Stage 1;
- state that production dispatch must not import it;
- point to this staged plan.

Do not delete the file in Stage 1 if its code is still useful as historical reference.

Edit `graph-editor/lib/runner/epistemic_bands.py`.

At minimum:

- change the module docstring to say it is no longer a live `conversion_rate` production dependency after Stage 1;
- preserve it as fit-history selection reference for the Stage 4 schedule resolver.

#### Stage 1.10 — Update Stale Docs In The Same Change

Update at least these docs so they do not describe the old path as live:

- `docs/current/codebase/ANALYSIS_TYPES_CATALOGUE.md`;
- `docs/current/codebase/BE_RUNNER_CLUSTER.md`;
- `docs/current/codebase/FORECAST_STACK_DATA_FLOW.md`;
- `docs/current/codebase/CF_MAP.md`;
- `docs/current/codebase/GRAPH_COMPUTE_CLIENT.md`;
- `docs/current/project-bayes/73q-daily-conversions-shared-runtime-cutover-plan.md`;
- `docs/current/project-generalise/MASTER-PLAN-cf-spine-detachment-and-analysis-standardisation.md`.

The wording should be consistent: Stage 1 retires the standalone `conversion_rate` processing path first; later stages rebuild the analysis on CF.

Stage 1 acceptance:

- Production dispatch no longer routes `conversion_rate` through the raw snapshot derivation.
- The analysis id, chart kind, and display settings are preserved unless a specific caller cannot safely render a dormant state. Avoid remove/re-add churn.
- The registry, UI, CLI, and BE handler agree on the temporary state: unavailable with an explicit migration message, or routed to a CF-backed replacement from Stage 2 if that lands in the same change set.
- Legacy snapshot-query handling cannot reach the standalone derivation.
- The old conversion-rate-specific latency gate and debug branch are gone from production handling.
- FE normalisation renders the dormant state explicitly rather than producing an empty or generic failure.
- Tests prove the old path is not reachable from the public analysis surface.
- Existing tests that asserted the old hybrid contract are rewritten or quarantined as historical-contract tests, not green acceptance for the new work.
- The old helpers are marked as reference-only or moved out of the production path; if retained, they have no production callers.

### Stage 2 — Extract A Shared CF Date-Axis Readout, Then Present It Two Ways

Stage 2 reintroduces working `conversion_rate` by making it a second presentation of the same CF date-axis readout that powers `daily_conversions`.

Substantively, for day granularity, the two analyses should consume the same backend rows. They differ in visual grammar:

- `daily_conversions` is the **mass/count presentation**: stacked bars and count decomposition are primary; rate is supporting context.
- `conversion_rate` is the **rate presentation**: strict/projected/model rates and bands are primary; evidence mass is supporting context, encoded as scatter size and tooltip detail.

Binning is not `conversion_rate`-specific. Both chart contracts can benefit from day/week/month bins. Therefore Stage 2 must introduce a shared date-axis binning/readout layer and make both analyses consume it.

It must not restore `derive_conversion_rate`, `resolve_rate_bands`, a chart-local fit-history walk, separate snapshot admission, or one CF request per displayed date. It may use uniform latest priors; historical per-date priors are Stage 6.

Implement Stage 2 in the following atoms.

#### Stage 2.1 — Extract The Shared Backend Date-Axis Readout

Edit `graph-editor/lib/runner/cohort_forecast_v3.py`.

Extract the shared computation currently embedded in `reduce_daily_conversions_rows` into a neutral helper, for example `build_cf_date_axis_readout(bundle, *, bin_size='day')`.

The helper should:

- read `bundle.date_axis_projection`;
- use `bundle.max_tau` as the saturation column, matching current `reduce_daily_conversions_rows`;
- read strict evidence masses from `proj.evidence_x_strict` and `proj.evidence_y_strict`;
- read FC/projected masses and rate draws from `proj.ef_*`;
- read conditioned model masses and rate draws from `proj.f_*`;
- carry `completeness`, `frontier_age`, latency-band reads, and provenance currently exposed by `reduce_daily_conversions_rows`;
- support `bin_size` values `day`, `week`, and `month`.

For `bin_size='day'`, each output row corresponds to one `DateAxisProjection` row.

For `week` and `month`, the helper must aggregate at the mass/draw level, not by averaging already-derived rates:

- group Cohort/date indices into the bin;
- sum strict evidence `x` and `y`, then compute strict rate as `sum_y / sum_x`;
- sum projected/model `x` and `y` draw arrays across Cohorts in the bin, then compute rate draws as `sum_y_draw / sum_x_draw`;
- compute medians and bands from the bin-level rate draws;
- sum count fields such as `evidence_y`, `forecast_y`, `projected_y`, and `projected_x`.

This helper is the single backend authority for date/bin rows. Do not create a separate conversion-rate calculation.

#### Stage 2.2 — Refactor `daily_conversions` Onto The Shared Readout

Edit `reduce_daily_conversions_rows` in `graph-editor/lib/runner/cohort_forecast_v3.py`.

Make it a presentation adapter over `build_cf_date_axis_readout`:

- call the shared helper with `bin_size` from the handler, defaulting to `day`;
- map shared rows into the existing `daily_conversions` response fields;
- preserve the mass/count fields the chart already consumes: `x`, `y`, `evidence_y`, `forecast_x`, `forecast_y`, `projected_x`, `projected_y`, model fields, bands, completeness, frontier age, and provenance.

Do not let `daily_conversions` keep a private date-axis computation after the shared helper exists.

#### Stage 2.3 — Add `conversion_rate` As A Presentation Adapter

Edit `graph-editor/lib/runner/cohort_forecast_v3.py`.

Add a reducer sibling, for example `reduce_conversion_rate_rows(bundle, *, bin_size='day')`, that also consumes `build_cf_date_axis_readout`.

It should:

- call the same shared helper as `daily_conversions`;
- emit `analysis_type: 'conversion_rate'`;
- expose the same bin labels/date range;
- make rate fields primary: strict/evidence rate, projected/FC rate, model rate, and forecast/model bands;
- include mass/support fields (`x`, `y`, projected denominator, evidence mass) for scatter sizing and tooltip support;
- not emit historical `epistemic` bands from `resolve_rate_bands`.

This is not a shim over the `daily_conversions` response. It is a sibling presentation adapter over the same shared date-axis readout.

#### Stage 2.4 — Share The Backend Handler Skeleton

Edit `graph-editor/lib/api_handlers.py`.

Do not copy `_handle_daily_conversions` into a second near-identical handler. Extract a small internal helper, for example `_handle_cf_date_axis_analysis(data, *, analysis_type, log_prefix)`, that owns the common work:

- read `scenarios`, `analytics_dsl`, `display_settings`, `mece_dimensions`, and `forecasting_settings`;
- call `runner.forecast_admission.admit_forecast_evidence`;
- extract context scope with `extract_forecast_context_scope`;
- parse `asat` with `parse_asat_from_dsl`;
- compute `compute_extent` with `_compute_extent_for_scenario`;
- call `runner.cf_analysis.prepare_cf_projection_bundle`;
- call `runner.cf_analysis.reducer_for(analysis_type)` with the bundle and `bin_size`;
- return the same scenario/subject envelope shape.

Then make:

- `_handle_daily_conversions(data)` call `_handle_cf_date_axis_analysis(data, analysis_type='daily_conversions', log_prefix='[daily_conv]')`;
- `_handle_conversion_rate_cf(data)` call `_handle_cf_date_axis_analysis(data, analysis_type='conversion_rate', log_prefix='[conversion_rate_cf]')`.

The only analysis-specific branching in this helper should be the reducer selected by `analysis_type` and display copy/provenance labels. If the helper starts making statistical decisions based on analysis type, stop.

#### Stage 2.5 — Wire Router Dispatch To The CF Date-Axis Path

Edit `_handle_runner_analyze_impl` in `graph-editor/lib/api_handlers.py`.

Current router special-cases:

- `cohort_maturity`;
- `daily_conversions`;
- then all other snapshot types fall through to `_handle_snapshot_analyze_subjects`.

Add `conversion_rate` beside `daily_conversions`, before the generic snapshot handler:

- `if analysis_type == 'conversion_rate': return _handle_conversion_rate_cf(data)`.

Keep `conversion_rate` in `ANALYSIS_TYPE_SCOPE_RULES` until the new handler no longer depends on snapshot-aware routing. The routing goal is explicit CF-backed handling, not fallback to `path_runner`.

#### Stage 2.6 — Add Reducer Registry Entries

Edit `graph-editor/lib/runner/analysis_types.yaml`.

For `daily_conversions`:

- keep `reducer: daily_conversions`;
- update description if binning is now supported.

For `conversion_rate`:

- keep id/name/when/runner identity;
- add `reducer: conversion_rate`;
- change description away from "observed rate with epistemic uncertainty bands" to CF-backed rate presentation wording.

Edit `graph-editor/lib/runner/cf_analysis.py`.

In `reducer_for`, import and map both presentation adapters:

- `'daily_conversions': reduce_daily_conversions_rows`;
- `'conversion_rate': reduce_conversion_rate_rows`.

Both adapters should call the same shared date-axis readout helper.

#### Stage 2.7 — Make `bin_size` A Shared Date-Axis Display Setting

Edit `graph-editor/src/lib/analysisDisplaySettingsRegistry.ts`.

Move `bin_size` conceptually out of "conversion-rate-only" status:

- keep the key name `bin_size`;
- expose it for both `daily_conversions` and `conversion_rate`;
- keep values `day`, `week`, and `month`;
- keep `computeAffecting: true`.

Edit `graph-editor/lib/api_handlers.py` in the shared CF date-axis handler:

- read `(data.get('display_settings') or {}).get('bin_size') or 'day'`;
- pass it to both `reduce_daily_conversions_rows` and `reduce_conversion_rate_rows`.

Do not duplicate binning logic in frontend chart builders.

#### Stage 2.8 — Normalise Two Presentations From The Shared Readout

Edit `graph-editor/src/lib/graphComputeClient.ts`.

For `normaliseSnapshotDailyConversionsResponse`:

- preserve the existing mass/count fields;
- preserve any new `bin_start` / `bin_end` or bin label fields from the shared readout;
- keep `source: 'cf_projection_bundle'` metadata.

For `normaliseSnapshotConversionRateResponse`:

- stop assuming old `epistemic` fit-history bands;
- normalise the rate-first fields emitted by `reduce_conversion_rate_rows`;
- preserve mass/support fields for scatter sizing and tooltips;
- continue to handle the Stage 1 dormant payload.

The normalisers may share internal helper code for scenario/subject block extraction, but they should produce distinct analysis results because the chart contracts are distinct.

#### Stage 2.9 — Update The Two Chart Builders As Presentations

Edit `graph-editor/src/services/analysisECharts/snapshotBuilders.ts`.

For `buildDailyConversionsEChartsOption`:

- keep the stacked bar/count presentation;
- make sure day/week/month bin labels render correctly;
- consume the same CF-backed mass/rate fields produced by the shared readout.

For `buildConversionRateEChartsOption`:

- render the rate-first presentation over the same backend rows;
- show evidence/mass as scatter size and tooltip support;
- render projected/model rates and CF bands where present;
- remove live assumptions about fit-history `epistemic` bands and non-latency-only support.

Do not create a new chart kind. Keep `daily_conversions` and `conversion_rate` as distinct chart kinds over the shared readout.

#### Stage 2.10 — Keep Type Resolution And UI Slots Stable

Edit only copy where needed:

- `graph-editor/src/components/panels/analysisTypes.ts`: describe `daily_conversions` as count-first and `conversion_rate` as rate-first, both CF-backed;
- `graph-editor/lib/runner/analysis_types.yaml`: same;
- `graph-editor/src/services/analysisTypeResolutionService.ts`: keep `daily_conversions: ['daily_conversions', 'table']` and `conversion_rate: ['conversion_rate', 'table']`;
- `graph-editor/src/components/charts/AnalysisChartContainer.tsx`: keep subject selector behaviour for both date-axis analyses;
- `graph-editor/src/lib/analysisDisplaySettingsRegistry.ts`: keep shared `bin_size`; review whether old conversion-rate `show_epistemic_bands` / `show_model_midpoint` should become CF band/model toggles.

Do not remove and re-add either analysis type.

#### Stage 2.11 — Add Shared-Readout And Presentation Tests

Add backend tests:

- a shared readout test near `graph-editor/lib/tests/test_cf_date_reducer.py` or a new `test_cf_date_axis_readout.py` proving day/week/month binning is mass-first;
- a parity test proving `daily_conversions` and `conversion_rate` day rows read the same underlying masses/rate surfaces;
- a handler test that `handle_runner_analyze` with `analysis_type: 'conversion_rate'` reaches the CF date-axis path;
- a handler test that `daily_conversions` still reaches the same shared path;
- a test proving latency edges are not rejected by an old conversion-rate-specific gate;
- a static or behavioural test proving production code does not import `conversion_rate_derivation`.

Add frontend tests:

- normaliser tests for both date-axis presentations from the shared backend shape;
- chart dispatch tests in `analysisEChartsService.dispatch.test.ts` for both chart kinds;
- a chart test proving conversion-rate scatter size uses mass/support while daily conversions renders mass/count bars;
- if dormant Stage 1 tests were added, update them to the live Stage 2 expected result.

Quarantine old blind tests until rewritten. Do not revive the old T4 `rate == y / x` assertion as the primary contract.

#### Stage 2.12 — Update Documentation

Update the same docs touched in Stage 1:

- `ANALYSIS_TYPES_CATALOGUE.md`: describe the shared CF date-axis readout and the two presentations;
- `BE_RUNNER_CLUSTER.md`: stop listing `conversion_rate_derivation.py` as the production implementation;
- `FORECAST_STACK_DATA_FLOW.md`: remove `epistemic_bands.py` as a live BE consumer for conversion-rate bands;
- `CF_MAP.md`: update fit-history note to reference future schedule work, not live conversion-rate bands;
- `73q-daily-conversions-shared-runtime-cutover-plan.md`: replace old Phase 8b text with a pointer to this staged plan;
- the master generalisation plan: mark Stage 1 retirement and Stage 2 shared-date-axis reintroduction progress accurately.

Stage 2 acceptance:

- `conversion_rate` has a CF-backed analysis boundary.
- The row/date axis comes from `DateAxisProjection` or its direct successor.
- Latest-view behaviour is represented as a uniform prior schedule, even if that schedule is still implicit in code.
- Latency edges are no longer hard-rejected by the old standalone gate; if unsupported cases remain, they degrade through CF/runtime eligibility and provenance rather than a conversion-rate-specific latency block.
- The FE normaliser and chart builder consume the CF-backed response shape, not the old `{rate, epistemic}` hybrid payload as a production contract.

### Stage 3 — Introduce `PriorSchedule` With Uniform Behaviour First

Make `PriorSchedule` an explicit perimeter object for every CF request, but start with uniform schedules only. This stage should be behaviour-preserving for existing latest-view CF consumers.

The schedule should carry row keys, per-edge resolved model entries, schedule homogeneity metadata, and provenance. A uniform schedule is the current scalar `ResolvedModelParams` model lifted into the scheduled interface. This gives the engine one contract before historical date-indexing is enabled.

Stage 3 acceptance:

- `cf_analysis.prepare_cf_projection_bundle` constructs or receives a `PriorSchedule`.
- `SpanEdgeResolution` and `CarrierEdgeResolution` no longer treat the scalar `resolved_model` shape as the only model payload.
- Uniform schedules preserve current CF numerical behaviour.
- Primitive, span, and draw/cache identity include enough schedule identity to distinguish the scheduled interface from accidental scalar reuse.
- Existing CF analyses continue to run with a uniform schedule without analysis-type branches inside projection or reducers.

### Stage 4 — Build Historical Schedule Resolution

Generalise current model resolution so the perimeter can resolve the full `ResolvedModelParams` surface as of each row date. This replaces the display-only `resolve_rate_bands` walk with a real model-prior schedule resolver.

This resolver must select more than `alpha` and `beta`: it must resolve epistemic probability, predictive probability, `n_effective`, latency moments and dispersions, source, quality/fallback state, and fitted-at provenance. It also needs explicit rules for missing historical fits, retained-history gaps, and analytic fallback.

Stage 4 acceptance:

- Date-indexed schedules can be built without calling `resolve_rate_bands`.
- Historical fit selection returns full model parameters, not display bands.
- Missing historical Bayesian fits and analytic fallback are handled by explicit policy, not incidental current-state promotion.
- Week/month row-date selection is declared and tested. The old standalone path used bin start; preserving or changing that rule must be an intentional decision.
- Schedule provenance is visible enough to explain which fit each row used.

### Stage 5 — Make Primitive And Kernel Construction Schedule-Aware

Thread the schedule through primitive construction and all prior-bearing operator families. This is the core CF generalisation stage.

The live runtime currently conditions one scalar-prior primitive per edge and builds request-wide `(Draw, Tau)` kernels that are later scattered onto the Cohort/date axis. Date-indexed priors require row-aware primitive or kernel surfaces. The schedule must feed the epistemic conditioned family, the predictive conditioned family, and the unconditioned overlays consistently.

Stage 5 acceptance:

- `prepare_primitive` and `condition_primitive` consume scheduled model input for prior-bearing families.
- Uniform schedules still take the Toeplitz fast path and match Stage 3 parity.
- Date-indexed schedules select a banded/scheduled provider policy at the provider boundary; the DP core remains policy-generic.
- `f_*`, `ef_*`, and model-overlay surfaces cannot diverge by using different row dates for the same row.
- Empirical evidence operators remain prior-free.
- Cache identity prevents collisions between uniform and date-indexed schedules, and between two date-indexed schedules with different fit selections.

### Stage 6 — Enable Historical `conversion_rate`

Turn on the date-indexed `conversion_rate` behaviour on top of the scheduled CF runtime.

This stage must decide the evidence contract before implementation: honest row-wise `asat(D)` or explicitly labelled historical-prior/latest-evidence hybrid. The old implementation accidentally mixed those frontiers; the new one must not.

Stage 6 acceptance:

- `conversion_rate` uses a date-indexed `PriorSchedule`.
- Projection and reducers remain readouts; no chart or reducer walks fit history.
- Evidence frontier semantics are explicit in the response provenance and chart labelling.
- Non-latency single-edge cases use the instant-maturity degeneracy correctly.
- Latency edges are supported by the shared CF machinery, or unsupported cases degrade visibly through shared provenance rather than through the old conversion-rate-specific exclusion.
- Public tests cover daily bins, week/month representative-date policy, missing-fit policy, non-latency instant maturity, and at least one latency-edge case.

### Stage 7 — Delete Or Retire The Old Surface Area

After the CF-backed historical path is live, remove the old analysis surface area that was kept only for reference.

Stage 7 acceptance:

- `derive_conversion_rate` is deleted or demoted to test/reference code with no production imports.
- `resolve_rate_bands` is deleted or replaced by the schedule resolver's tested fit-selection helper.
- The old blind tests no longer assert the broken hybrid contract as success.
- Documentation and analysis registry text describe the CF-backed semantics, not "observed rate with epistemic bands" from the old implementation.
- The generalisation master plan no longer needs to special-case `conversion_rate` as a hold-out.

### Plan Invariants

Across all stages:

1. Build a row-aligned `PriorSchedule` at the perimeter for every CF request.
2. Use uniform schedules for the existing latest-view behaviour.
3. Use date-indexed schedules for `conversion_rate`.
4. Thread schedules through span resolutions into primitive construction.
5. Build epistemic, predictive, and unconditioned prior-bearing operator families from the same schedule.
6. Select Toeplitz or banded execution from schedule homogeneity as provider data.
7. Leave projection and reducers as readouts of already-resolved scheduled surfaces.

This preserves the architecture's core discipline: one runtime path, cases differ by data degeneracy, and projection never re-decides semantics.

---

## Appendix — Code Surfaces

- `graph-editor/lib/runner/conversion_rate_derivation.py` — standalone `conversion_rate` derivation. It computes observed `Σy / Σx` and calls `resolve_rate_bands`; it excludes latency edges.
- `graph-editor/lib/runner/epistemic_bands.py` — `resolve_rate_bands`, the existing local fit-history walk. Useful as reference for date selection, but insufficient for CF because it returns display bands rather than full resolved model parameters.
- `graph-editor/lib/runner/model_resolver.py` — `resolve_model_params`, the shared current-fit resolver. A schedule resolver should generalise this contract, not bypass it.
- `graph-editor/lib/runner/cf_analysis.py` — `prepare_cf_projection_bundle`, the shared perimeter orchestration boundary where schedule preparation belongs.
- `graph-editor/lib/runner/cohort_forecast_v3.py` — `build_cf_projection_bundle`, `_build_span_resolutions`, `build_resolved_cf_runtime`, and the reducers. `_build_span_resolutions` currently attaches a single resolved model to each span edge.
- `graph-editor/lib/runner/primitive_readout.py` — `prepare_primitive`, `SpanEdgeResolution`, `CarrierEdgeResolution`; the immediate seam where single `ResolvedModelParams` should become scheduled model params.
- `graph-editor/lib/runner/primitive_conditioning.py` — `condition_primitive` and `make_unconditioned_primitive`. These consume priors for epistemic, predictive, and unconditioned surfaces.
- `graph-editor/lib/runner/model_span_spine.py` — `resolve_request_spans` builds the epistemic conditioned family, predictive conditioned family, empirical family, and unconditioned overlays. `project_selected_cohort_rows` emits `f_*`, `ef_*`, strict evidence, and residual surfaces.
- `graph-editor/lib/runner/subject_span_composer.py` — `_build_flat_stream_kernel_provider` currently ignores `cohort_index` because kernels are uniform. Scheduled priors make this provider cohort-aware.
- `graph-editor/lib/runner/timing_span.py` — `DPExecutionPolicy`, `TOEPLITZ_APPLY`, and `SOURCE_BANDED`. The DP already treats execution strategy as declared data rather than a loop-internal branch.
- `graph-editor/lib/runner/cf_projection_bundle.py` — `CFProjectionBundle` and `DateAxisProjection`, the existing per-Cohort/date projection surfaces consumed by date reducers.
- Reserved-term definition of `asat()` and the semantic invariants the runtime must preserve live in `docs/current/codebase/RESERVED_QUERY_TERMS_GLOSSARY.md` and `docs/current/codebase/COHORT_ANALYSIS_NUMERATOR_DENOMINATOR_SEMANTICS.md`; the runtime overview is `docs/current/codebase/FORECAST_RUNTIME_ARCHITECTURE.md`.
- Programme context: `docs/current/project-bayes/73q-daily-conversions-shared-runtime-cutover-plan.md` (Phase 8b is the consumer that surfaced this).
