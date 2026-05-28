# 73q Daily Conversions Shared Runtime Cutover Plan

**Status**: Proposal (rewrite) — 7-May-26; test-architecture amendment 13-May-26; CF/FC machinery rethink 26-May-26
**Supersedes**: the 4-May-26 version of this document, archived at `docs/archive/project-bayes/73q-daily-conversions-shared-runtime-cutover-plan.md`. The 27-May-26 revision replaces the earlier interleaved test-phase framing with phase-owned acceptance: Phase 1 calibrates the legacy contract, Phase 2 owns projection-bundle tests, Phase 3 owns date-reducer/cross-consumer tests, and Phase 5a owns surprise-gauge replacement coverage. The implementation target remains the current CF row pipeline and frontier-conditioned (`ef_*`) projection surfaces: 73q is a reducer over a shared **CF projection bundle**, not over generic "conditioned draws".
**Scope**: Move daily conversions onto the shared CF runtime by adding a date reducer over the same projection bundle as the cohort-maturity tau reducer, without implementing 73p hierarchical per-Cohort conditioning, and without trusting the current legacy daily-conversions arithmetic as an oracle.

## Implementation progress

<!-- managed by /implement-carefully — edit checkboxes manually only when the skill is not running -->

- [x] Phase 1 — Legacy Contract Calibration — completed 27-May-26
- [x] Phase 2 — Projection Bundle Expansion — completed & closed 27-May-26 (horizon model reconciled; no-branch approvals recorded; cross-scenario tau-extent deferred — see Phase 2 close-out)
- [x] Phase 3 — Date reducer — completed 27-May-26
- [x] Phase 4 — Wire into daily conversions and retire the legacy path — completed 27-May-26 (shared `runner/cf_analysis.py` boundary + registry-driven reducer selection; cohort_maturity, conditioned_forecast, and daily_conversions all route through `prepare_cf_projection_bundle`; legacy inline trajectory enrichment deleted; boundary_shift contract reclassified — see Phase 4 close-out)
- [ ] Phase 5 — Remaining consumer decisions and legacy-engine migration
- [ ] Phase 6 — Retire cohort_maturity v1 and v2
- [ ] Phase 7 — Cleanup sweep

## Why this is a rewrite

The first draft of 73q was written before the 73m/73n carrier composition and unified CF runtime work landed. It also predates the frontier-conditioned chart-surface work. The current target is therefore sharper: there is no second pipeline to build, and the date reducer must read the same CF/FC projection surfaces that now feed `cohort_maturity`.

The maintained references for that target are:

- [`CF_MAP.md`](../codebase/CF_MAP.md) — orientation and file-to-role map for the CF cluster.
- [`FORECAST_RUNTIME_ARCHITECTURE.md`](../codebase/FORECAST_RUNTIME_ARCHITECTURE.md) — `ResolvedCFRuntime`, shared preparation/runtime shape, and row projection ownership.
- [`CF_ROW_PIPELINE.md`](../codebase/CF_ROW_PIPELINE.md) — row schema and display mapping: strict evidence fields, `f_*` conditioned model surface, `ef_*` frontier-conditioned forecast surface, and optional `model_curve_*` overlay.
- [`frontier-conditioned-chart-surface-proposal-21-May-26.md`](../project-generalise/frontier-conditioned-chart-surface-proposal-21-May-26.md) Appendix B — terminology for E/F/E+F display modes versus internal surfaces.

The older framing around "conditioned draws" is no longer precise enough. 73q must target a shared projection bundle containing:

- `FrameEvidence` and cohort metadata from `build_cohort_evidence_from_frames`;
- the `ResolvedCFRuntime`;
- the selected retrieval frontier object used by the current row projection;
- `SelectedCohortRowProjection` generated to the required horizon;
- per-Cohort views of the FC (`ef_*`) projection surfaces that are not yet exposed today.

Daily conversions needs a per-Cohort date reducer over that bundle. It must not call `compute_cohort_maturity_rows_v3` and scrape public rows, because public rows are tau-reduced, display-gated, and currently limited to the chart horizon. It must also not build its own runtime, evidence binding, Pop C/D arithmetic, or post-hoc forecast residuals.

A second reason to rewrite: the team is not yet confident enough in the current legacy daily-conversions arithmetic to use it as a parity oracle for the cutover. The old plan implicitly leaned on parity-style assertions. The new plan replaces parity with semantic invariants written blind, exercised first against the current legacy path so the tests themselves get hardened before they are asked to bless the cutover.

## Conceptual model

The CF runtime plus selected-Cohort spine exposes one projection family over two axes: **Cohort** and **tau**. Calendar date is not an independent axis; it is the relabel `calendar_date = Cohort.anchor_day + tau`.

The relevant surfaces are already named by the row pipeline:

- strict evidence: observed `X`/`Y`/rate prefixes;
- `f_*`: the unspliced query-conditioned model surface on the epistemic basis;
- `ef_*`: the frontier-conditioned forecast surface on the predictive basis, prefix-pinned to strict evidence and continuing only unresolved future mass;
- `model_curve_*`: the optional unconditioned model overlay.

The same per-(Cohort, tau) projection family can be reduced two ways:

- **Tau reducer** (existing, used by cohort_maturity): keep tau, collapse Cohorts → one row per relative age.
- **Date reducer** (new, used by daily_conversions): keep Cohort=anchor_day=date, emit one row per Cohort, and read the contract-specific tau for each field (`eval_age`, `fe.saturation_tau`, or a latency-band tau).

Both reducers consume the same runtime, the same strict evidence prefixes, the same FC forecast surface, the same conditioned model surface where a field explicitly asks for F-mode/model-only output, the same optional overlay object where enabled, the same band/quantile machinery, and the same active-mode carrier/subject split. The difference between the two charts lives in which axis is iterated and which axis is collapsed.

For daily conversions specifically, forecast enrichment fields read the FC surface, not F mode:

- `projected_y` reads per-Cohort `ef_y` at the contract horizon;
- `forecast_y` reads per-Cohort `ef_forecast_y`, including identity/window modes where the public cohort-maturity row field may be display-gated away;
- `forecast_bands` and forecast-side `latency_bands` read per-Cohort `ef_rate_draws`;
- observed `data`, `x`, `y`, `rate`, and `cohort_y_at_age` remain owned by `derive_daily_conversions`.

A would-be third reducer (collapse Cohorts on the calendar-date diagonal to produce a projected daily-count series) has no consumer. The existing daily-conversions `data` series is observed-only and already produced directly from snapshot rows by `derive_daily_conversions`; it is not a projection of the runtime.

## Terminology

Capitalisation is semantic.

- **Cohort** means the dated population selected by the query.
- **`cohort()`** means the QueryDSL mode.
- **Cohort mode** means the semantics selected by `cohort()`.
- **Window mode** means the semantics selected by `window()`.

Lower-case "cohort" must not appear as a generic population term in the plan, code comments, or tests added for this work.

## Current state

`derive_daily_conversions` owns observed snapshot arithmetic and produces three artefacts: `data` (observed daily Y deltas keyed by retrieval date, summed across Cohorts), `rate_by_cohort` (per-Cohort latest observed `x`, `y`, `rate`), and `cohort_y_at_age` (per-Cohort cumulative `y` keyed by Cohort age). The bespoke part is the enrichment block in `api_handlers.py` that runs after `derive_daily_conversions` returns: it builds ad hoc evidence objects from `rate_by_cohort` and calls `compute_forecast_trajectory` once for `projected_y` / `forecast_y` / `completeness` / `forecast_bands`, optionally calls `compute_forecast_trajectory` once per latency-band tau, and falls back to `annotate_rows` if the engine call fails.

The CF row/scalar path migrated to `ResolvedCFRuntime` in 73n and now routes public row fields through the CF/FC row pipeline: strict evidence, `ef_*` forecast layer, `f_*` conditioned model surface, and optional `model_curve_*` overlay. Daily conversions did not migrate. This atom finishes that migration by adding a date reducer over those already-owned surfaces.

The FE consumes `rate_by_cohort` as the primary chart input when present and reads observed `data` only as a fallback. The cutover therefore prioritises `rate_by_cohort` correctness; the calendar-date `data` series is preserved unchanged because `derive_daily_conversions` continues to produce it.

## Current code reality as of 27-May-26

This is the part that makes 73q non-trivial after the FC work. The current code is close, but it does **not** yet expose the reducer contract this document needs.

- `model_span_spine.SelectedCohortRowProjection` exposes aggregate `(S, T)` surfaces only: `f_*`, `ef_*`, strict evidence totals, and strict evidence by anchor maps. The legacy spliced transition fields have been removed from the public projection object. Inside `project_selected_cohort_rows`, per-Cohort arrays (`x_model_by_anchor`, `y_model_by_anchor`, empirical traces, FC ledgers) still exist during computation but are reduced before return.
- `_project_runtime_rows` calls `project_selected_cohort_rows(..., horizon=max_tau)`. Daily conversions needs FC arrays at `fe.saturation_tau`, which may exceed public chart `max_tau`.
- `_runtime_completeness` returns only an across-Cohort weighted mean and SD. Daily conversions needs the per-Cohort completeness values before that reduction.
- Public cohort-maturity `forecast_x` / `forecast_y` row fields are emitted only for active carrier mode, as a display contract. Daily conversions cannot inherit that gate: an immature window Cohort still needs a `forecast_y` residual from `ef_forecast_y`.
- The daily-conversions enrichment block in `api_handlers.py` still imports and calls `forecast_state.compute_forecast_trajectory`, builds ad hoc `CohortEvidence` rows, runs separate latency-band sweeps, clamps `forecast_y` through `max(0, projected_y - y)`, and falls back to `annotate_rows`.
- The `layer` rule currently lives in `forecast_application.annotate_data_point`, but this plan later deletes that legacy helper. 73q must first extract the layer constants/rule to a non-legacy home, then use that shared helper from the date reducer.

The revised phases below are built around those facts.

## Semantic preservation target

The legacy daily-conversions path asks broadly correct questions: observed daily conversions are evidence deltas from snapshot rows; each `rate_by_cohort` row represents one selected Cohort's latest observed `x`, `y`, and `Y / X` rate; immature selected Cohorts get projected future `Y` rather than being frozen at observed `y`; Window mode and Cohort mode remain different when the carrier is not identity; optional latency bands display evidence when the selected Cohort is old enough and forecast bands otherwise.

These semantic behaviours must survive the cutover. The legacy arithmetic is **not** treated as an oracle. Where the legacy trajectory engine and the shared runtime disagree, the cutover prefers the shared runtime if it is answering the same semantic question more directly. Acceptance is judged by independently-derived semantic invariants, not by line-for-line parity with the old engine.

Non-negotiable preservation points:

- `data` remains observed evidence, not forecast output.
- `rate_by_cohort[].y` and `rate_by_cohort[].x` remain observed latest values.
- `projected_y` remains an eventual or requested-horizon projected count for the selected Cohort, not a rate. Post-refresh, it is read from the per-Cohort FC `ef_y` surface at the contract tau.
- `forecast_y` remains the projected future residual over observed `y`. It is read from the FC future-residual surface, not recomputed by subtracting evidence from a full-root model projection.
- `forecast_bands` and forecast `latency_bands` remain rate bands over `Y / X`.
- Active Cohort mode uses the runtime's `A → X` carrier for denominator arrival and the runtime's `X → end` subject span for numerator progression.

## Arithmetic authority

The shared runtime and selected-Cohort spine are the authority for conditioned probability, timing, strict evidence, and FC continuation surfaces. Daily conversions does not reproduce the legacy trajectory engine's internal Pop C / Pop D implementation and does not rebuild the FC residual. The date reducer encodes only the accounting that is genuinely specific to per-Cohort rows: selected Cohort identity and `anchor_day`, observed latest `x` and `y`, per-Cohort tau slices into the runtime/spine surfaces (multiple slices, see contract below), and the per-Cohort layer/completeness decision. Projection horizon selection is the runtime's responsibility but is not a single number: the contract names which tau index is read for each field, so a Cohort's `projected_y`, `forecast_y`, `completeness`, and `latency_bands` may read different tau positions from the same per-Cohort projection family.

## Reducer field contract

This section is binding for phases 2, 3, and 4. Every consumer field of the daily-conversions response is named here with its projection-bundle source, the tau index at which it is read, the variant of any ambiguous mathematical object it depends on, and its behaviour when the bundle cannot produce the value. Phase 1 tests assert the contract directly. The contract must not be edited without a corresponding plan revision; phase 4 cannot relax it silently.

### Saturation tau and latent extent

Revised 27-May-26 to match the latent-chart-extent work that landed after this section was first drafted. Two horizons now exist with distinct roles; the earlier single derived `saturation_tau` is superseded.

- **`fe.saturation_tau` — the composition ceiling.** `build_cohort_evidence_from_frames` sets `fe.saturation_tau = 400` (a flat ceiling, no longer the per-request `max(max_tau, ⌈2·t95⌉)` derivation). The composed spans are built to this ceiling — a cheap per-primitive pass — so the runtime CDF is available to 400 without re-composition.
- **`latent_extent` — the data-latent reach.** `_latent_chart_extent` reads the t95 reach off the composed *predictive* request CDF, floors it at `fe.max_tau`, extends it (extend-only) by any FE `axis_tau_max`, and caps it at the `fe.saturation_tau` ceiling. This is the chart/row horizon, emergent from the model's own latency rather than a fixed setting.

The expensive per-Cohort `(C, S, T)` projection is sized to `latent_extent`, not the ceiling — that is the cost saving (compose cheaply to 400, project only as far as conversions actually land). The bundle reports `bundle.max_tau = latent_extent`. Public cohort-maturity rows and the date reducer both read per-Cohort FC through `bundle.max_tau`. Because the predictive CDF has plateaued by its own t95, reading "at saturation" and reading at `latent_extent` return the same plateau value, so the date reducer's "evaluated at saturation" fields are satisfied by the per-Cohort arrays at `latent_extent` without projecting the full 400-wide grid. This plan still introduces no percentile threshold, magic floor, or fallback; both horizons are existing principled quantities (a fixed ceiling and the composed-span t95).

**Multi-scenario caveat (deferred — see Phase 2 close-out).** `latent_extent` is computed per CF flow. For a multi-scenario overlay the chart axis should be the `max()` reach across scenarios; that cross-scenario `max()` is not computed today (flows run one-by-one). Deferred as a named atom.

### Completeness

Completeness is owned by the runtime per `COHORT_ANALYSIS_NUMERATOR_DENOMINATOR_SEMANTICS.md` §9: "Chart rows, CF scalar responses, graph-enrichment fields, and overlays are projections of the already-resolved runtime object. They must not contain their own carrier, subject-span, p∞, completeness, or admission logic." The date reducer therefore does not choose a completeness flavour. It reads a per-Cohort variant of the existing `_runtime_completeness` object — the same request-rooted CDF readout that cohort_maturity's scalar completeness already uses — at each Cohort's `eval_age`. Phase 2 exposes the pre-aggregation per-Cohort values from `_runtime_completeness`'s existing internal computation; it does not introduce a new completeness definition. If the runtime's request-rooted definition is later judged wrong for active-mode daily-conversions display semantics, that is a runtime change with its own atom and its own tests, not a date-reducer-local override.

### Layer

`layer` is a daily-conversions-only field (cohort_maturity rows do not carry one). The rule is the existing rule from `forecast_application.annotate_data_point`: `c ≥ 0.95 → 'mature'; c > COMPLETENESS_EPSILON → 'forecast'; else 'evidence'`, with `COMPLETENESS_EPSILON = 1e-9`.

Because this plan later deletes the legacy `annotate_rows` / `annotate_data_point` surface, Phase 2 first extracts the threshold value, `COMPLETENESS_EPSILON`, and the completeness-to-layer rule into a small non-legacy helper owned by the runtime/projection boundary. The date reducer imports that helper. No new thresholds, no local reimplementation.

### Per-Cohort un-aggregation

The current public row projection exposes aggregate draw surfaces to the tau reducer. The date reducer requires per-Cohort `Y[i, :, τ]` and `X[i, :, τ]` arrays from the same spine projection to compute per-Cohort projected counts, future residuals, and rate bands. Phase 2 refactors `model_span_spine.project_selected_cohort_rows` / `SelectedCohortRowProjection` so per-Cohort arrays are the natural intermediate for the relevant surfaces:

- `ef_x_draws_by_cohort`, `ef_y_draws_by_cohort`, `ef_rate_draws_by_cohort`;
- `ef_forecast_x_by_cohort`, `ef_forecast_y_by_cohort`;
- ordered strict-evidence arrays aligned to the selected-Cohort order, in addition to the current anchor-keyed maps;
- per-Cohort projection status / skip reason, so the date reducer can emit rows for skipped active Cohorts without guessing from all-zero arrays.

The across-Cohort aggregate becomes a derived view for callers that need it. The tau reducer sums per-Cohort arrays into the existing `(S, T)` aggregate when it builds its rows; the date reducer indexes per-Cohort directly. Memory cost is `(N_cohorts, S, T)` for X and Y; for production request shapes this is acceptable and the projection already materialises comparable arrays internally. An alternative that runs the loop twice (once aggregated, once per-Cohort) is rejected because the per-Cohort arrays are the canonical product of the projection and the aggregate is a derived view.

### Field-by-field contract for `rate_by_cohort` rows

- `date`. The Cohort's `anchor_day` taken from `cohort_list[i]['anchor_day']`. ISO date string. Always populated (a Cohort row implies a known anchor_day). Same value cohort_maturity sees per-Cohort.
- `x`, `y`, `rate`. Sourced unchanged from `derive_daily_conversions(rows)` output — the snapshot-derived observed denominator, numerator, and ratio per Cohort. The projection bundle carries its own `x_frozen` / `y_frozen` per Cohort (from the active-mode prefix or the engine_cohort, depending on the seam invariants the runtime already enforces) which it uses internally for projection arithmetic; the displayed `x` / `y` / `rate` on the response row are not overwritten by the bundle's view. This preserves legacy display behaviour and avoids surfacing projection-prefix vs snapshot-display disagreements as a behaviour change in this atom.
- `evidence_y`. Equal to `y`. Field preserved for FE compatibility; no separate projection-bundle read.
- `projected_y`. The mean of per-Cohort FC `ef_y_draws_by_cohort[i, :, fe.saturation_tau]`. This is the projected Y for the Cohort after its observed prefix has been pinned and only unresolved future mass has been continued, evaluated at the bundle's existing saturation horizon (defined above). Not at `eval_age[i]`. When the bundle is moments-only (per-Cohort FC draws unavailable) or the Cohort is skipped (active mode with no admissible carrier evidence), `projected_y` is `null` and the row's `_projection_provenance` records the reason.
- `forecast_y`. The mean of per-Cohort FC future residual `ef_forecast_y_by_cohort[i, :, fe.saturation_tau]` when available; otherwise `null`. This applies in both identity/window and active carrier modes. The public cohort-maturity row field may suppress `forecast_y` for identity-carrier display reasons; the date reducer reads the underlying per-Cohort FC residual directly. The reducer does not compute this by post-hoc subtraction from a full model surface and does not clamp through `max(0, projected_y - y)`. If a display compatibility field requires `projected_y - y`, it must be an explicit compatibility projection over the FC surfaces, not a replacement for `ef_forecast_y`.
- `forecast_bands`. Quantiles of per-Cohort FC `ef_rate_draws_by_cohort[i, :, fe.saturation_tau]` at the band levels the tau reducer already emits, computed by the same `_quantiles` helper the tau reducer uses. When per-Cohort FC rate draws are unavailable or all-NaN at `fe.saturation_tau`, `forecast_bands` is `null`. Band-level set is whatever the tau reducer is already producing today; this plan does not redefine it.
- `completeness`. Per-Cohort variant of `_runtime_completeness` evaluated at `eval_age[i]` (see "Completeness" above). Range `[0.0, 1.0]`. Null when the runtime cannot produce a CDF readout at all.
- `layer`. Derived from `completeness` by the extracted shared layer helper (see "Layer" above). When `completeness` is null, `layer` is `'evidence'` (the natural value at the rule's `c ≤ COMPLETENESS_EPSILON` branch when `c` is treated as zero).
- `latency_bands`. A map keyed by dynamic day labels matching the legacy public shape (for example `'8d'`, `'12d'`, depending on the resolved latency). Band taus are inverse-CDF percentiles of the resolved latency distribution at 0.25, 0.50, 0.75 plus `onset_delta_days`, discretised with the existing `max(1, round(raw_tau))` rule and deduplicated by tau. This derivation is lifted into a single projection-bundle accessor. Per band:
  - **Evidence side** (`eval_age[i] ≥ band_tau`): the value is `obs_y_at_age[i, band_tau] / x_frozen[i]`, sourced from `engine_cohorts[i].obs_y[band_tau]` (or the active prefix's `obs_y[band_tau]`) and the Cohort's `x_frozen`. Single rate value.
  - **Forecast side** (`eval_age[i] < band_tau`): the value is the quantile band of per-Cohort FC `ef_rate_draws_by_cohort[i, :, band_tau]` at the same band level the tau reducer is emitting today.
  - When `band_tau > fe.saturation_tau` (the bundle's draw horizon, the largest tau the per-Cohort projection arrays cover), the band is `null` with `_projection_provenance.reason = 'band_tau_above_saturation'`. The reducer does not silently clamp band_tau or substitute a different value; the bundle's saturation horizon is authoritative and a band beyond it is genuinely unavailable.

### Skipped-Cohort handling in active mode

In active Cohort mode, a Cohort whose anchor_day has no admissible root-window carrier evidence is excluded from projection aggregation by setting `a_pop = 0`, and the per-Cohort projection arrays carry zeros for that Cohort. The date reducer **must still emit a `rate_by_cohort` row** for such Cohorts, populated from `derive_daily_conversions`'s observed snapshot output: `date`, `x`, `y`, `rate`, `evidence_y` are populated; `projected_y`, `forecast_y`, `forecast_bands`, `completeness`, `layer`, `latency_bands` are `null`; the row carries a `_projection_provenance` field with reason `'no_root_window_evidence'`. This preserves Cohort visibility in the FE — the legacy path produces the row from snapshot reads regardless of whether the engine call succeeds; the new path must do the same.

### Response-level fields

- `data`. Calendar-date observed Y deltas across snapshot rows. Produced by `derive_daily_conversions` unchanged. Not a projection; not derived from the projection bundle.
- `cohort_y_at_age`. Per-Cohort cumulative observed Y by Cohort age. Produced by `derive_daily_conversions` unchanged. The projection bundle carries equivalent information in `engine_cohorts[i].obs_y`, but the response field shape is preserved by `derive_daily_conversions`.
- `total_conversions`, `date_range`. Produced by `derive_daily_conversions` unchanged.
- `analysis_type`. Static string `'daily_conversions'`.
- `cf_mode`, `cf_reason`. Read from explicit projection-bundle scalar metadata. The bundle builder computes these from the same resolved model object the tau reducer uses, via `get_cf_mode_and_reason(resolved)`. The date reducer must not infer them from row fields or scrape runtime diagnostics.
- `promoted_source`. Read from explicit projection-bundle scalar metadata, sourced from the resolved model source used to build the runtime. The date reducer must not scrape `runtime.runtime_provenance`; that provenance block is diagnostic and does not expose a stable `p_conditioning_evidence.source` contract today.

### Cross-reducer consistency

The projection bundle is the same object for both reducers, so a strong cross-reducer invariant exists, but it is more delicate than a naive aggregation equivalence. The clean form: for any single-Cohort fixture, the cohort_maturity FC tau-row at `tau = saturation_tau` and the daily-conversions row for that Cohort must agree on the projected `Y / X` rate at that tau. For multi-Cohort fixtures, the cohort_maturity tau-row at any tau equals the across-Cohort sum of per-Cohort FC `(Y[i, :, τ], X[i, :, τ])` divided once at the end (the bundle's own aggregation rule); daily-conversions per-Cohort rows expose the un-summed view at each Cohort's `fe.saturation_tau`. These cross-reducer tests belong to Phase 3, after the date reducer exists.

## Phases

Each phase is a separable, mergeable chunk. Phases 2 and 3 are mechanically safe (they add capability without changing daily-conversions behaviour). Phase 1 is the calibration step that hardens the contract. Phase 4 is the cutover.

### Standard analysis shape

The daily-conversions cutover is also the first enforcement point for a broader rule: analysis handlers must not grow bespoke forecast-preparation code. Analyses may differ in which reducer they run and which response envelope they emit, but the upstream shape must be standard:

1. request/scenario normalisation;
2. subject resolution;
3. evidence acquisition and regime selection;
4. optional observed-only derivation;
5. optional shared projection bundle;
6. analysis-specific reducer;
7. response envelope.

Not every analysis uses every slot. Graph-only runners skip snapshot evidence and projection bundles. Observed-only snapshot analyses stop after the observed derivation. Forecast-backed analyses must use the same preparation-to-projection boundary and then choose a reducer:

- `cohort_maturity` reads the shared `CFProjectionBundle` through the tau reducer;
- `daily_conversions` reads the same bundle through the date reducer, while preserving the observed fields produced by `derive_daily_conversions`;
- future forecast-backed consumers must either read the same bundle/runtime surfaces or explicitly document why they are not forecast-backed.

Phase 4 must therefore not add a local daily-conversions forecast spine, ad hoc evidence candidates, local carrier/subject assembly, or a private call sequence that parallels cohort_maturity. Before wiring the date reducer into daily conversions, the forecast-preparation-to-`CFProjectionBundle` sequence currently embedded in the cohort-maturity handler must be exposed as a shared boundary and both cohort_maturity and daily_conversions must call that boundary. This is plumbing standardisation, not a new statistical path.

Every phase follows the same test discipline:

- Write the phase's contract tests **blind and before** the production change.
- The tests must assert the semantic contract, not current implementation output.
- If the tests cannot be written before implementation, the contract is not specified well enough. Stop and refine the contract in this plan before coding.
- A phase cannot close on prose, wiring, or "architecture complete" alone. Its phase-owned tests must run against the new path, and any legacy-gap xfail it owns must either flip or be reclassified with an explicit plan update.
- For Phases 2-4, no new guards, conditionals, fallback branches, or mode/type branches are allowed unless explicitly approved before implementation. This includes branches on `window` vs `cohort`, identity carrier vs active carrier, single-hop vs multi-hop, latent vs non-latent, one vs many Cohorts, missing bundle fields, and "temporary" legacy fallback routes. Variation must enter as projection-bundle data, reducer selection, or explicit projection status. If an implementer believes a conditional is unavoidable, they must stop and get approval before coding it.

### Phase 1 — Legacy Contract Calibration

Phase 1 is deliberately narrow and closeable. It does **not** create the projection bundle, the date reducer, cross-consumer tests, or doc56 replacement coverage. Those belong to the phases that create the relevant production surfaces.

This phase writes and calibrates the daily-conversions semantic contract against the current legacy path. The output is a contract test ledger: assertions that pass today become regression guards; assertions that correctly fail today become named legacy gaps that Phase 4 must clear.

Extend the existing outside-in CLI tests with daily-conversions cases. Tests assert the "Reducer field contract" section above. The contract is the source of truth for what each field means; tests assert the contract's claims, not the legacy implementation's outputs. This section is a contract checklist with phase ownership; Phase 1 calibrates only the full-machinery outside-in claims that can run against the legacy path.

- **Observed-evidence derivation.** The `data` series equals the simple sum of positive Y deltas across snapshot rows by `retrieved_at`, derivable from raw snapshot rows without consulting any runtime output. Each `rate_by_cohort[].x` and `[].y` equal the Cohort's latest observed snapshot `x` and `y` (or the active-mode prefix `x_frozen` and `y_frozen` when the seam invariant requires it). `evidence_y` per Cohort equals the row's observed `y`.
- **Saturation-tau slicing.** `projected_y` for an immature Cohort is strictly greater than the Cohort's observed `y`, because `projected_y` is read at `fe.saturation_tau` (not at the Cohort's current age). For a Cohort whose age is at or beyond `fe.saturation_tau`, `projected_y ≈ y`. The test references `fe.saturation_tau` directly from the projection bundle, not a hardcoded number.
- **Projection bounds.** For every Cohort row with non-null projection: `projected_y ≥ y`, `forecast_y ≥ 0` as the FC future-residual readout, `projected_y` not exceeding the row's `x` denominator under window or cohort(A=X) modes (in active mode the bound is the bundle-derived `a_pop`, not `x`), and `rate ∈ [0, 1]` whenever `x > 0`.
- **Band geometry.** For each Cohort and each `forecast_bands` level, `bands[level][hi] ≥ bands[level][lo]`. Higher confidence levels strictly contain lower ones at every level pair the tau reducer also emits. The band midpoint is plausible relative to `projected_y / x`.
- **Completeness identity with cohort_maturity.** For the same request and the same Cohort's `eval_age`, the date reducer's per-Cohort completeness reads the same `_runtime_completeness` underlying CDF that cohort_maturity scalar uses, evaluated at this Cohort's `eval_age` rather than weighted across all Cohorts. Test: take cohort_maturity's scalar completeness for a single-Cohort fixture and confirm the daily-conversions per-Cohort completeness equals it. This pins the contract that the date reducer does not have its own completeness logic.
- **Layer rule.** Layer values come from the extracted shared layer helper applied to the per-Cohort completeness. Tests parameterise Cohort age relative to `fe.saturation_tau` and confirm the three transitions; threshold values are imported from the helper, not hardcoded in the test.
- **Mode invariants.** In Window mode, two Cohorts with similar evidence and dissimilar age-on-eval-date converge to a common asymptotic projected rate as both ages grow (because saturation_tau readout is the same for both). In active Cohort mode, `rate` remains `Y / X` (never `Y / A`); changing the carrier identity changes `projected_y` for the same observed `(x, y)`.
- **Multi-hop subjects.** A multi-hop subject's daily-conversions projection differs from a hypothetical terminal-edge-only projection when the intermediate edges have non-trivial `p`; a synthetic graph with a known intermediate-edge `p` can assert this without revealing the exact projection number.
- **Latency bands.** Per the contract: when `eval_age[i] ≥ band_tau`, the band reads observed evidence (`obs_y[band_tau] / x_frozen`); when `eval_age[i] < band_tau`, the band reads per-Cohort FC `ef_rate_draws_by_cohort[:, band_tau]` quantiles. Band rates are non-decreasing in tau within a Cohort because Y is monotone in age. Band taus above `fe.saturation_tau` produce null bands with provenance, not silently substituted values. The bundle's band-tau accessor returns one canonical set; both reducers see it.
- **Skipped-Cohort visibility.** In active Cohort mode, a Cohort with no admissible root-window carrier evidence still produces a `rate_by_cohort` row, with snapshot-derived `date`, `x`, `y`, `rate`, `evidence_y` populated and projection fields null with `_projection_provenance.reason == 'no_root_window_evidence'`. The Cohort is not silently dropped.
- **Selected set.** The number of `rate_by_cohort` rows equals the number of Cohorts admitted by the `window()` or `cohort()` clause and the same date bounds extracted by subject resolution.
- **Cross-reducer consistency (single-Cohort fixtures only).** For a single-Cohort synthetic graph, the cohort_maturity row at `tau = saturation_tau` and the daily-conversions row for that Cohort agree on `Y / X` at saturation. Multi-Cohort cross-reducer assertions express the explicit aggregation rule (across-Cohort `Σ Y[i, :, τ] / Σ X[i, :, τ]` matches cohort_maturity at tau τ), never a casual weighted-average form.
- **Static-shape invariants.** The daily-conversions response under the runtime-backed path includes `cf_mode`, `cf_reason`, and `promoted_source` whenever the legacy path emits them, with no removed or renamed fields.

Tests must use synthetic graphs whose semantic answers are derivable independently of the implementation. Where an exact value is not derivable blind, the assertion is a bound, an ordering, a contract-defined relationship, or a single-Cohort cross-reducer equality, never a hard-coded number copied from a current run.

Run the phase 1a tests against the current daily-conversions path on `main` (the legacy trajectory enrichment in `api_handlers.py`). Three outcomes are possible per assertion:

- **Pass on legacy.** The legacy path satisfies the invariant. The assertion stays as-is and becomes a regression guard for the cutover.
- **Fail on legacy because the test is over-tight.** The invariant is genuinely weaker than the assertion expressed it. Loosen the assertion to the minimum bound that still pins the contract. Record the original tighter form in a comment on the test as a future strengthening candidate.
- **Fail on legacy because the legacy path is wrong.** Mark the test as expected-fail with a written reason, and record the legacy gap in this document's "Known legacy gaps" section (added during phase 1b). The cutover in phase 4 is required to clear that expected-fail.

The Phase 1 output is a calibrated invariant suite, a documented list of legacy gaps, and a clear definition of what Phase 4 must achieve to be considered correct. No production code changes in Phase 1.

Structural test ownership is phase-local:

- Phase 2 owns projection-bundle integration tests, because the bundle builder does not exist before Phase 2.
- Phase 3 owns mock-bundle date-reducer algebra tests and cross-consumer tau/date tests, because the date reducer does not exist before Phase 3.
- Phase 5a owns surprise-gauge cross-consumer tests.
- Doc56 retirement happens only after the replacement coverage from Phases 2, 3, and 5a exists.

#### Doc56 Reassignment Ledger

The doc-56 file dates from the v1→v2/v3 cut-over period and was framed as "phase-0 cross-consumer cut-over regression guard". The doc-64 authoring receipt in the file already retires the doc-56 framing in favour of Family C (cross-consumer agreement). 73q completes that retirement by absorbing each remaining claim into the new test architecture and deleting the file.

Each of the seven tests in the file is reassigned explicitly so no semantic claim is silently lost:

- **`test_cf_and_v3_chart_carrier_tier_agree`** — claim is about `model_resolver` carrier-tier selection, not about CF runtime semantics. Move to a new `test_model_resolver_carrier_tier.py` unit test (millisecond cost, no pipeline).
- **`test_cf_p_mean_matches_v3_p_infinity`** — structurally redundant after 73q. The replacement is Phase 3's surface-specific cross-consumer test: scalar/public-moment consumers and row/date reducers read from the shared projection bundle or runtime public moments rather than independently reconstructing p@∞. Deleted with no replacement in the doc-56 file.
- **`test_query_scoped_identity_carrier_collapses_public_evidence_basis`** — claim is about identity-carrier degeneracy. Replaced by Phase 2's identity-carrier projection-bundle test, which asserts the same property at bundle level rather than at chart-row level (cheaper, sharper). Deleted.
- **`test_whole_graph_cf_is_invariant_under_edge_reorder`** — claim is about runtime/projection determinism under input permutation. Replaced by Phase 2's edge-reorder projection-bundle test, which exercises the bundle builder directly rather than running two full pipelines. Deleted.
- **`test_lag_fit_and_surprise_gauge_share_downstream_temporal_mode_split`** — currently xfail-strict pending Phase 5a (per the ledger below). Rewritten in Phase 5a against the runtime-backed surprise_gauge as a Phase 5a cross-consumer test or outside-in case. Deleted from the doc-56 file at that point.
- **`test_chart_and_daily_conversions_do_not_collapse_window_and_cohort`** — the current claim ("both consumers expose a window/cohort split") is a weaker form of what 73q makes available. Replaced by Phase 3's single-Cohort cross-reducer equality (cohort_maturity row at τ = saturation_tau equals daily_conversions row for that Cohort to floating-point) and Phase 1/4 outside-in mode invariants (window vs cohort produce demonstrably different per-Cohort projections under the shared projection bundle). Deleted.
- **`test_bayesian_sidecar_preserves_downstream_window_cohort_chart_split`** — currently xfail-non-strict (stale under WP8 per the existing pytest marker). The structural claim (multi-hop subject preservation, downstream split survival) is covered more directly by Phase 2's multi-hop subject preservation test and Phase 3's mode-invariant assertions. Deleted (no replacement in this file; the bayesian-sidecar code path itself is exercised as a fixture variant within the Phase 3 cross-consumer tests).

Doc56 retirement is **not** Phase 1 acceptance. It closes only after the replacement coverage named above exists in the phases that own it, including Phase 5a for the surprise-gauge test. Until then, this ledger is a dependency map, not a checkbox.

Phase 1 acceptance tests:

- Outside-in daily-conversions cases are authored or calibrated, with every legacy failure either passing, explicitly expected-failing with a named legacy gap, or narrowed to the weakest assertion that still expresses the contract.
- The legacy-gap ledger names the exact Phase 4 assertions that must flip when daily conversions moves onto the projection bundle.
- The doc56 reassignment ledger names the future owner phase for every remaining doc56 claim.
- No projection-bundle code, date reducer, `api_handlers.py` daily-conversions wiring, or doc56 deletion is required or allowed for Phase 1 closure.
- **No-branch check:** Phase 1 makes no production code changes, so no new guards, conditionals, fallback branches, or mode/type branches are introduced.

#### Known legacy gaps (Phase 1 calibration output, 27-May-26)

Calibrating the daily-conversions field contract against the current legacy enrichment path surfaced **two legacy gaps** (both `xfail(strict=False)`, confirmed XFAIL 27-May-26) and **one passing regression guard**. The gaps are the exact assertions the Phase 4 cutover must flip from `xfail` to passing. All three live in `test_conditioned_forecast_parity.py::TestPhase4AsatVisibility`.

**Legacy gaps — Phase 4 must flip these:**

- **As-at maturity boundary band** — `test_daily_conversions_boundary_shift`. synth-simple-abc, `window(12-Dec-25:20-Mar-26)` live vs `.asat(15-Jan-26)`. Legacy enrichment produces `mature → forecast` directly and emits no null-completeness boundary band on `asat()` queries (`asat.null_completeness_rows == 0`). The contract (§"Reducer field contract" — Completeness / Layer) requires the band to fall out of the per-Cohort `_runtime_completeness` readout the date reducer inherits from the shared bundle. Phase 4 must make the runtime-backed path produce `asat.forecast_rows > 0`, `asat.null_completeness_rows > 0`, `asat.mature_rows < live.mature_rows`, with `live.forecast_rows == 0` and `live.null_completeness_rows == 0`.

  **Phase 4 outcome (27-May-26) — reclassified, test passes.** The runtime-backed date reducer reads per-Cohort completeness from the shared `_runtime_completeness` CDF, so every admitted Cohort carries a *real* completeness (tiny for the youngest, e.g. ~9e-6), never `None`. Measured: live = 30 `mature` / 0 `forecast` / 0 null; asat(15-Jan-26) = 10 `mature` / 23 `forecast` / **0 null-completeness**. The boundary shift is real and exactly as intended (the `mature` zone shrinks, a `forecast` zone appears), but the legacy *null-completeness band* was an enrichment artefact the runtime path does not — and should not — reproduce: a young Cohort past the asat frontier has a genuine tiny completeness, not an undefined one. Per the Phase 4 acceptance ("xfail removed **or** contract deliberately updated"), the test's contract was updated to drop the `asat.null_completeness_rows > 0` condition while keeping the mature→forecast shift; the xfail is removed and the test now passes. The companion completeness gap (`test_daily_conversions_completeness_matches_cohort_maturity`) flipped to passing naturally.
- **Completeness identity with cohort_maturity** — `test_daily_conversions_completeness_matches_cohort_maturity`. Single immature Cohort (arrivals at simple-b on 10-Jan, observed `.asat(20-Jan-26)`, age 10). Legacy daily_conversions computes completeness via its own `forecast_application.compute_completeness` (analytic lognormal CDF), not the runtime's `_runtime_completeness`; measured dc=0.42067 vs cohort_maturity=0.41820 at tau=10 (Δ≈2.5e-3, above the 1e-4 floor). The contract (§"Reducer field contract" — Completeness) requires the date reducer to read the *same* `_runtime_completeness` object. Phase 4 must make `|dc.completeness − cohort_maturity.completeness| ≤ 1e-4` at the Cohort's eval_age.

**Regression guard — passes on legacy, must stay passing:**

- **Window/cohort non-collapse** — `test_daily_conversions_window_cohort_do_not_collapse`. Edge b→c, `window(1-Mar-26:14-Mar-26)` vs `cohort(simple-a,1-Mar-26:14-Mar-26)` (active, A=a≠X=b). Legacy keeps the modes materially distinct (measured max |Δrate| ≈ 0.36; |Δprojected_y| ≈ 1272). The cutover must not collapse them.

**Not calibratable against legacy on current synths:** skipped-Cohort visibility in active mode (a Cohort with no admissible root-window carrier evidence must still emit a row with null projection + `_projection_provenance.reason == 'no_root_window_evidence'`). The dense synth fixtures do not produce a no-carrier-evidence active Cohort, so this invariant cannot be exercised against the legacy path now; it remains a Phase-4 contract requirement (needs a sparse-evidence fixture), not a Phase-1 runnable gap.

Curation note (27-May-26): outside-in is reserved for full-machinery semantic invariants only — not mechanical sanity checks. The remaining contract properties were deliberately *not* authored as outside-in tests: reducer algebra (projection bounds, band geometry, layer-rule thresholds, saturation-tau slicing) is owned by Phase 3 mock-bundle unit tests; single-Cohort cross-reducer agreement by Phase 3; bundle-build properties (multi-hop subject preservation, latency-band tau accessor) by Phase 2.

### Phase 2 — Projection Bundle Expansion

The CF runtime and selected-Cohort spine currently produce the right aggregate chart surfaces, but the date reducer needs a shared bundle with per-Cohort views. Phase 2 extracts that bundle and adds the accessors required by the field contract above. The bundle extraction itself is behaviour-preserving for daily conversions, cohort_maturity, and every other current consumer. One observable change rides along: the concurrent latent-chart-extent work moved the public cohort-maturity **row horizon** from `fe.max_tau` to `latent_extent` (the data-latent reach, ≥ `fe.max_tau`), per §"Saturation tau and latent extent". That is an intended chart-extent change, validated by the outside-in oracle; it is the only observable effect, and daily-conversions response behaviour is unchanged (still on the legacy enrichment path until Phase 4).

Required accessors and refactors. Each is a plumbing or shape change against an existing principled object; none introduce a new mathematical definition or a magic constant.

Before touching production code in this phase, write the focused projection-bundle tests listed below in failing form against the current public surfaces. If any test cannot be written without inventing unstated bundle semantics, pause and add the missing contract to this section first.

- **Shared CF projection bundle.** Extract the preparation/projection sequence currently embedded in `compute_cohort_maturity_rows_v3` into a helper that returns `FrameEvidence`, `ResolvedCFRuntime`, selected retrieval frontier, `n_by_anchor`, `SelectedCohortRowProjection`, and explicit scalar metadata (`resolved`, `cf_mode`, `cf_reason`, `promoted_source`). The public row function becomes "build bundle → tau reducer"; daily conversions becomes "build bundle → date reducer". Neither reducer rebuilds runtime state or scrapes runtime diagnostics for scalar metadata.
- **Per-Cohort projection arrays at the latent extent.** Refactor `model_span_spine.project_selected_cohort_rows` / `SelectedCohortRowProjection` so its natural intermediate is per-Cohort `(N_cohorts, S, T)` arrays for FC `X`, FC `Y`, FC future residuals, and FC rate, with the across-Cohort `(S, T)` aggregate computed at consume time. Return both views on the projection object. The tau reducer sums per-Cohort into the aggregate it already uses for `ef_*`; the date reducer indexes per-Cohort directly. Per-Cohort `ef_rate_draws_by_cohort` is computed as `ef_y_draws_by_cohort / ef_x_draws_by_cohort` with the projection's existing NaN policy. Build the bundle's projection at `latent_extent` — the data-latent reach (§"Saturation tau and latent extent") — and report `bundle.max_tau = latent_extent`; both the tau reducer and the date reducer read per-Cohort FC through `bundle.max_tau`.
- **`fe.saturation_tau` plumbed through the projection bundle.** The bundle returns `fe.saturation_tau` so the date reducer reads it without retraversing internals. No new derivation; this is the existing value.
- **Per-Cohort completeness from `_runtime_completeness`.** Refactor `_runtime_completeness` to expose the per-Cohort values it already computes internally, prior to the across-Cohort weighted reduce. The existing scalar return becomes one view; the per-Cohort array becomes the other. Same underlying CDF object, same horizon, same definition. The cohort_maturity scalar caller is unchanged.
- **Latency-band tau accessor.** The legacy daily-conversions enrichment computes the band tau set inline in `api_handlers.py` from the resolved latency: `inverse_cdf(0.25/0.50/0.75, mu, sigma) + onset_delta_days`, with `max(1, round(raw))` to discretise and a deduplication step on the resulting integer set. Lift that exact derivation into a projection-bundle accessor so both reducers and any future consumer share one definition. No new derivation. When a band tau exceeds `fe.saturation_tau` the accessor still returns it; the date reducer emits `null` for that band per the field contract.
- **Layer helper extraction.** Move the `0.95` maturity threshold, `COMPLETENESS_EPSILON`, and the completeness → layer rule out of the legacy `forecast_application.annotate_data_point` surface into a non-legacy helper. Existing callers can be retargeted or left as compatibility wrappers until Phase 7 deletes the old helpers.
- **Scalar metadata.** Add explicit projection-bundle metadata for `cf_mode`, `cf_reason`, and `promoted_source`, sourced from the resolved model object used to build the runtime. Reducers read these fields directly; they do not inspect `runtime_provenance` internals.

Phase 2 is complete when:

- Existing cohort-maturity outside-in tests pass unchanged through the extracted projection-bundle helper.
- A focused bundle test proves public aggregate `ef_x_draws`, `ef_y_draws`, `ef_rate_draws`, `ef_forecast_x`, and `ef_forecast_y` are exactly the sum or mass-first reduction of the new per-Cohort arrays.
- A focused horizon test proves the bundle's per-Cohort FC arrays and the public cohort-maturity rows both extend to `bundle.max_tau = latent_extent`, which floors at `fe.max_tau` and stays strictly below the `fe.saturation_tau` ceiling on a long-lag fixture (`test_per_cohort_arrays_cover_latent_extent_below_ceiling`, `test_public_rows_stop_at_latent_extent_not_ceiling`).
- A focused completeness test proves the exported per-Cohort completeness values reduce to the existing scalar `_runtime_completeness` result with the same weights.
- A focused latency-band accessor test proves both reducers see the same dynamically-labelled band taus and that a band beyond `fe.saturation_tau` remains representable as unavailable rather than clamped.
- A focused skipped-Cohort test proves active Cohorts with no root-window carrier evidence remain present in bundle metadata with a reason, even if they contribute zero to aggregate FC arrays.
- A layer-helper test proves the extracted helper exactly matches the legacy `annotate_data_point` thresholds.
- A focused scalar-metadata test proves the bundle exposes `cf_mode`, `cf_reason`, and `promoted_source` without requiring reducers to inspect `runtime_provenance` internals.
- **No-branch check:** the bundle builder and `project_selected_cohort_rows` introduce no new guards, conditionals, fallback branches, or mode/hop/latency-specific runtime routes unless explicitly approved. Per-Cohort arrays, skipped-Cohort status, identity carrier, active carrier, single-hop, and multi-hop all flow through the same projection-bundle construction.
- A static check or focused unit test proves no daily-conversions `api_handlers.py` wiring has changed in Phase 2.

**Phase 2 close-out (reconciled and closed 27-May-26).**

- **Acceptance.** All eight focused criteria above pass; the cohort-maturity outside-in oracle is green (54 passed / 1 xfailed); daily-conversions `api_handlers` wiring is unchanged (still legacy `compute_forecast_trajectory`).
- **No-branch check — approved retained conditionals.** The bundle builder retains three conditionals, none of which are window/cohort/hop/latency runtime routes; each is approved here:
  1. The perimeter `is_window` → `population_root` / `temporal_mode` translation at the bundle entry — the *single* location where the temporal distinction is read; below it the substrate is topology-keyed (`population_root == x`). Approved as the perimeter translation point.
  2. `resolved = resolved_override if resolved_override is not None else resolve_model_params(...)` — input-defaulting: the perimeter (`api_handlers`) passes a pre-resolved model and the `else` computes it when absent. Approved as lazy-init of a real perimeter input.
  3. `unconditioned_overlay_bases = (..., 'epistemic') if show_model_curve else (...)` — an FE feature flag that builds the extra epistemic overlay only when the model curve is requested. Approved as product logic.
  All earlier defensive guards (`np.clip` on eval_age, `cdf is None`, the `_latent_chart_extent` validity guards) were removed; the zero-population completeness case is handled algebraically (uniform-weighting degeneration: `weights + float(Σw == 0)`), not by a guard.
- **Horizon-model reconciliation.** §"Saturation tau and latent extent" was revised this date to match the landed code: `fe.saturation_tau` is the flat-400 composition ceiling, `latent_extent` is the data-latent reach, and the public row horizon is `bundle.max_tau = latent_extent`. The "evaluated at saturation" field-contract language is satisfied at `latent_extent` because the predictive CDF has plateaued by its t95.
- **Deferred atom — cross-scenario tau extent.** `latent_extent` is computed per CF flow; a multi-scenario overlay needs the `max()` reach across scenarios for a common axis, which is not computed today (flows run one-by-one, so no point sees the whole scenario set). Three resolutions, none in Phase 2 scope: (a) conservative — a low fixed tau-max; (b) aggressive — a high tau-max, paying the per-Cohort projection width; (c) split the spine after the latency map but before the projection passes, compute compose+reach for all scenarios, take the `max()`, then project each at the common horizon — correct and cheap to project, but it persists every scenario's latency map in memory and makes the multi-scenario driver two-pass. Tracked for a future phase/doc.

### Phase 3 — Date reducer

Add a sibling of the existing tau-axis row builder, in the same module, implementing the field contract above. The date reducer takes the shared projection bundle from Phase 2 and reads from it mechanically: observed row shape from `derive_daily_conversions`, per-Cohort FC projection surfaces from `SelectedCohortRowProjection`, per-Cohort completeness from the completeness view, `fe.saturation_tau`, and the latency-band tau set.

Before implementing the reducer, write mock-bundle date-reducer tests in failing form. The mock bundle should contain only the fields named by the contract. If a test needs information not named in the contract, add that field to the Phase 2 bundle contract before continuing.

For each Cohort the reducer emits one `rate_by_cohort` row whose fields are populated from the contract. The contract names which bundle accessor and which tau index each field reads — the reducer is mechanical relative to that contract. In particular: `projected_y`, `forecast_y`, and `forecast_bands` slice per-Cohort FC surfaces at `fe.saturation_tau`; `completeness` reads the per-Cohort variant of the existing `_runtime_completeness` object at `eval_age`; `layer` uses the extracted shared layer helper; `latency_bands` per band tau use the evidence-vs-forecast split based on `eval_age[i] ≥ band_tau`. Cohort_maturity rows do not carry `layer` or per-Cohort `completeness` fields today; this work does not change that.

Skipped-Cohort rows in active mode are emitted with snapshot-derived observed fields populated and projection fields null, per the contract. The date reducer does not bind evidence, condition primitives, choose priors, recompute carrier state, or introduce any per-Cohort posterior. It is a strict readout of the existing bundle. Where the bundle cannot project (degraded runtime), the reducer emits null projection fields with explicit `_projection_provenance` rather than substituting any other machinery.

Phase 3 still does not change daily-conversions response behaviour, because the new daily-conversions row builder is not yet wired in.

Phase 3 is complete when:

- Existing cohort-maturity outside-in tests pass unchanged through the extracted projection-bundle path.
- Date-reducer unit tests over mock bundles pass for every field in the field contract: observed fields, `projected_y`, `forecast_y`, `forecast_bands`, `completeness`, `layer`, `latency_bands`, `cf_mode`, `cf_reason`, and `promoted_source`.
- Date-reducer tests cover at least: identity/window immature Cohort, active Cohort, multi-hop subject, skipped active Cohort, band tau above saturation, and all-NaN FC rate draws.
- Cross-reducer tests prove single-Cohort date/tau agreement at `fe.saturation_tau` and multi-Cohort mass-first aggregation from the same per-Cohort arrays.
- **No-branch check:** the date reducer introduces no new guards, conditionals, or fallback branches unless explicitly approved. It must not rebuild carrier, subject, completeness, latency-band taus, or FC residuals by mode/hop/latency case. Any unavoidable conditional for field availability, projection status, or the public evidence-vs-forecast latency-band display decision must be named in the phase note with the approval that allowed it.
- A static check proves `api_handlers.py` still uses the legacy daily-conversions enrichment in Phase 3; the date reducer is not production-wired yet.

### Phase 4 — Wire into daily conversions and retire the legacy path

Replace the daily-conversions enrichment block in `api_handlers.py` with the standard forecast-backed analysis shape:

1. run the same shared forecast-preparation-to-`CFProjectionBundle` boundary used by `cohort_maturity`;
2. run `derive_daily_conversions(rows)` for the observed-only response fields;
3. pass the observed derivation plus the shared bundle to the date reducer.

The first step is load-bearing. Daily conversions must not construct an incomplete bundle from local rows, empty candidates, one-point `CohortEvidence`, or a private subset of the cohort-maturity preparation chain. Active Cohort mode (`A != X`) needs the same carrier-side and subject-side evidence candidates, envelope plan, composed frames, runtime inputs, context scope, and scalar metadata as cohort_maturity. If those inputs are missing, the cutover can silently collapse active cohort semantics into a prior-only or window-like projection.

Phase 4 therefore begins by exposing the existing cohort-maturity bundle preparation as a shared helper/boundary, then proving cohort_maturity still reads the same bundle through the tau reducer before daily conversions reads it through the date reducer.

Delete:

- the local imports of `compute_forecast_trajectory` and `CohortEvidence` inside the daily-conversions branch;
- the ad hoc `_engine_cohorts`, `_row_map`, and `_cohort_real_ages` construction whose only purpose is to drive `compute_forecast_trajectory`;
- the main `_sweep` trajectory call;
- the per-latency-band `_band_cohorts` construction and `_band_sweep` call;
- the daily-conversions `annotate_rows` fallback block (already a silent no-op for projection fields under a known field-name mismatch);
- comments that describe daily conversions as a surviving legacy trajectory-engine consumer.

Rewrite, do not preserve, any test whose only purpose is to bless `compute_forecast_trajectory` as the daily-conversions enrichment mechanism. Keep the semantic assertions; point them at the runtime-backed projection.

Before wiring production, run the Phase 1 legacy-gap tests against the not-yet-wired reducer path through a direct helper or handler shim. The expected result is that the Phase 1 legacy-gap xfails now pass against the new path before `api_handlers.py` switches over.

Known legacy-path tests that must be rewritten or retired in this phase:

- `test_cf_query_scoped_degradation.py::test_daily_conversions_uses_shared_sweep_surface` currently asserts the legacy trajectory enrichment path despite its name. Keep any valid public response assertions, but point them at the projection-bundle/date-reducer path.
- Any daily-conversions test that imports, monkeypatches, or indirectly blesses `compute_forecast_trajectory`, one-point `CohortEvidence`, `_maturity_tau = max(t95, 30)`, post-hoc `forecast_y = projected_y - y`, or the `annotate_rows` fallback is a Phase 4 rewrite/delete target.

Keep:

- `derive_daily_conversions` and its observed-delta tests, because the calendar-date `data` series remains observed-only and continues to come from snapshot rows.
- FE normalisation of `rate_by_cohort` fields in `graphComputeClient.ts`.
- `compute_forecast_trajectory` itself, because `surprise_gauge` remains outside this plan.
- `annotate_rows` generally, because other legacy paths still use it; only the daily-conversions fallback is retired here.
- `cohort_y_at_age`, because the latency-band evidence side reads it. This response field remains produced by `derive_daily_conversions`; the date reducer may read it but must not take ownership of producing it.

Phase 4 is complete when:

- cohort_maturity and daily_conversions both obtain their forecast-backed surfaces through the same shared forecast-preparation-to-`CFProjectionBundle` boundary;
- the phase 1 invariant suite passes against the runtime-backed daily-conversions path;
- every assertion that was marked expected-fail in phase 1b for legacy-gap reasons now passes (the cutover is required to clear those);
- no assertion that passed against legacy now regresses;
- a static search shows no daily-conversions call to `compute_forecast_trajectory` and no daily-conversions fallback to `annotate_rows`.
- daily-conversions outside-in tests prove the public response still contains `data`, `rate_by_cohort`, `cohort_y_at_age`, `total_conversions`, `date_range`, `cf_mode`, `cf_reason`, and `promoted_source` where applicable.
- `test_conditioned_forecast_parity.py::TestPhase4AsatVisibility::test_daily_conversions_boundary_shift` has its xfail removed or its contract deliberately updated in this plan.
- Focused response-normalisation tests prove `graphComputeClient.ts` still preserves `forecast_y`, `projected_y`, `forecast_bands`, and `latency_bands` from `rate_by_cohort`.
- **No-branch check:** the `api_handlers.py` cutover calls the shared projection-bundle builder plus date reducer once for the request shape. It introduces no new guards, conditionals, or fallback branches unless explicitly approved. It must not retain a legacy fallback branch, a mode-specific forecast path, a per-band trajectory call, or a local reconstruction of FC residual/completeness semantics.

### Phase 5 — Remaining Consumer Decisions And Legacy-Engine Migration

Phase 5 is no longer "make every chart use the date reducer". The FC work makes the boundary clearer:

- daily conversions needs the date reducer from Phases 2-4;
- `surprise_gauge` still needs a real migration off the legacy trajectory engine;
- `conversion_funnel`, `bridge_view`, and `conversion_rate` need explicit decisions or regression coverage, but they are not hidden prerequisites for the daily-conversions cutover;
- the param-pack scalar `p.latency.completeness` needs to be sourced from a dedicated scalar reducer (Phase 5e below). The cohort_maturity row reducer still co-produces this scalar today via `_runtime_completeness`; the pre-Phase-5 now-work implementing `docs/current/cohort-maturity-render-calc-policy.md` lifts CALC/SHOW scope to the perimeter and applies a stopgap to the `_runtime_completeness` compose horizon, but defers row-field deletion and CF endpoint repoint to Phase 5e so the param-pack write path is not regressed during the gap.

The work splits into actual migrations (where a legacy call still exists), hold-out reducer decisions, verification of display-mode assumptions that changed under the CF/FC row mapping, and the param-pack scalar source-of-truth change.

The state today, audited by static reads of the relevant modules:

- `surprise_gauge` (`api_handlers.py`) calls `compute_forecast_trajectory` directly. After phase 4 it is the **only** remaining public-path consumer of the legacy trajectory engine. Its own docstring records this and names migration as the precondition for deleting the engine.
- `conversion_funnel` (`runners.py`) consumes a scoped `_whole_graph_cf` response and then runs `funnel_engine`. It is not a legacy trajectory-engine caller, but `funnel_engine` remains a hold-out `ΣY / ΣX` reducer and has its own F/E/E+F display contract.
- `bridge_view` (`runners.py`) does not call backend CF directly. Its Reach-decomposition arithmetic reads probabilities from the FE-supplied scenario graph. The old e2e xfail is not really a "shared runtime" issue; it is a display-surface issue because `p.mean` is now canonical/blended and invariant across visibility modes.
- `conversion_rate` ([conversion_rate_derivation.py](graph-editor/lib/runner/conversion_rate_derivation.py)) is observed-only with epistemic bands resolved from `epistemic_bands.resolve_rate_bands`. It does not call backend CF and does not handle latency edges (gated out per doc 49 §B.2). A CF extension would be a new bin reducer over the same per-Cohort FC arrays, not a side effect of daily conversions.

Phase 5 therefore comprises:

#### Phase 5a — `surprise_gauge` migration off the legacy trajectory engine

Replace the `compute_forecast_trajectory` call in `surprise_gauge` with reads from the same runtime/projection-bundle machinery used by the other forecast-backed reducers. The two scalar variables the gauge computes (`p` and `completeness`, both projected as z-scores from unconditioned vs conditioned means) must have an explicit field mapping before implementation:

- The **conditioned** posterior moments come from `runtime.public_moments` and the per-Cohort completeness exposed for daily-conversions in phase 2.
- The **unconditioned** moments come from the unconditioned `predictive` overlay already exposed at `runtime.unconditioned_overlays['predictive']`. This is the runtime-owned prior-only overlay object, not F mode and not the optional `model_curve_*` display overlay. Reusing it for surprise_gauge does not introduce a new unconditioned object.
- The replacement contract must name where the gauge reads: observed conversion rate, conditioned p mean/sd, unconditioned p mean/sd, conditioned completeness mean/sd, and unconditioned completeness mean/sd. If one of these values is not available from current runtime/projection surfaces, Phase 5a must extend the bundle contract before changing `_compute_surprise_gauge`.

The gauge is a scalar projection, not a row reducer, so this migration adds no new date/bin reducer. It removes the last public-path consumer of `compute_forecast_trajectory`. Note: `cohort_forecast_v3.py` still imports `CohortEvidence` from `forecast_state` as a data-container dataclass; phase 5a does not delete `forecast_state` or its symbols. Deletion happens in phase 7 after the v1/v2 cohort-maturity paths have been retired in phase 6 and the residual consumers identified.

The variable definitions for `surprise_gauge` (`p`, `completeness`, the z-score formula, the zone classification thresholds in `classify_zone`) are the existing definitions in `api_handlers.py` and are not redefined by this work. Phase 5a is a substitution of the data source, not a redesign of the gauge.

Before changing `_compute_surprise_gauge`, write the replacement surprise-gauge tests against a mock or fixture-built projection bundle. If the expected `p` or `completeness` z-score source cannot be named without looking at the legacy trajectory return shape, the surprise-gauge reducer contract is underspecified and must be clarified here first.

Phase 5a tests assert that the gauge's two variables, the cf_mode/cf_reason emission, and the unavailable-with-reason error path are unchanged in shape and behaviour against the same synthetic graphs the daily-conversions phase 1 suite uses. The numerical z-score values may shift relative to the legacy trajectory output by the same magnitude phase 4 shifts daily-conversions projection values; the assertions are about contract preservation, not parity.

#### Phase 5b — `conversion_funnel` regression verification

`conversion_funnel` already obtains scoped CF scalars through `_whole_graph_cf`, so Phases 2-4 must not change its response shape (`p_mean`, `p_sd`, `p_sd_epistemic`, `evidence_k`, `evidence_n`, `completeness`, `conditioned`). But the funnel still runs its own hold-out reducer (`funnel_engine`) and its tests mention stale "73q graph projections" language.

Phase 5b therefore does **verification and xfail cleanup**, not a date-reducer migration. Add outside-in CLI tests that exercise `conversion_funnel` end-to-end against synthetic graphs spanning window mode, cohort(A=X), and active cohort mode, asserting that the per-stage `bar`, `lo`, `hi`, `bar_e`, `bar_f_residual`, `lo_epi`/`hi_epi`/`lo_pred`/`hi_pred` fields are produced and that the e/f/e+f mode selection still routes correctly under the post-FC row/response naming. If the existing xfail is still a valid contract, rewrite its reason around `funnel_engine`'s display contract; if not, retire it with the replacement coverage named.

No code changes to `conversion_funnel` or `funnel_engine` are expected in phase 5b unless the verification exposes a real regression. If a regression appears in the scoped CF response, fix the shared CF runtime. If it appears only in funnel bar assembly, record that as hold-out reducer debt rather than folding funnel migration into 73q silently.

#### Phase 5c — `bridge_view` decision and (optional) migration

Bridge view is currently CF-aware only indirectly through whatever the FE has populated on the scenario graph. The old xfail asserts divergence on `edge.p.mean` between E and F visibility modes; that expectation is stale. Under current semantics `p.mean` is canonical/blended and visibility-mode divergence lives in display-layer projections (`p.evidence.*`, `p.forecast.*`, chart series, or a scoped CF response), not necessarily in the request graph's `p.mean`.

Two options exist:

- **Display-graph status quo**: continue reading edge probabilities from the FE-supplied scenario graph, but rewrite the e2e assertion to check a display-level discriminator instead of `p.mean` if bridge view is intended to remain graph-driven.
- **Direct CF/display-aware bridge**: call `_whole_graph_cf` per scenario inside `run_bridge_view`, exactly as `run_conversion_funnel` does, or otherwise pass explicit display-surface probabilities into the bridge reducer. This guarantees Reach decomposition uses the same conditioned/evidence/model surface the selected visibility mode asks for.

The two options have different acceptance criteria: status quo only needs a rewritten display-level regression for the existing bridge output; direct CF/display-aware bridge needs a backend CF integration or an explicit display-surface input contract with its own outside-in tests.

This plan does **not** silently choose one. Phase 5c begins with a documented decision in this plan, taken at the time the phase starts. Until that decision is recorded, the migration work cannot start. The decision must answer: should bridge view be a graph-state reach decomposition, or a visibility-mode display-surface decomposition? If graph-state is correct, close Phase 5c by rewriting the stale e2e assertion. If display-surface is correct, implement the direct-CF/display-aware route with tests.

#### Phase 5d — `conversion_rate` decision and (optional) extension

Conversion rate is observed-only with epistemic bands; it does not consume CF and explicitly excludes latency edges (doc 49 §B.2). Wiring it onto the CF machinery is a feature extension, not a cutover: it would add forecast-mode bands for immature bins (parity with daily-conversions's `forecast_bands`) and lift the latency-edge exclusion via the same FC per-Cohort projections daily-conversions uses, reduced over a calendar-bin axis (day, week, month) instead of a per-Cohort axis.

The projection bundle supports the necessary FC arrays after Phase 2. A bin reducer would be a third sibling of the tau reducer (cohort_maturity) and date reducer (daily_conversions), summing per-Cohort per-tau projections onto calendar-bin-keyed buckets via the `calendar_date = anchor_day + tau` mapping the conceptual model already names. This is the diagonal-collapse reducer 73q's main body deliberately ruled out as "no daily-conversions consumer"; conversion_rate would be that consumer.

This plan does **not** silently scope conversion_rate's CF extension into 73q. Phase 5d begins with a documented decision in this plan recording one of:

- **Out of scope**: leave conversion_rate observed-only, accept the latency-edge gap, treat any forecast-mode upgrade as a separate atom (probably as part of doc 49 Phase 3, which is already named in the conversion_rate module docstring as the home for that work). 73q closes without changing conversion_rate.
- **In scope**: design the bin reducer and its field contract here, run it through phase 1-style blind tests over the outside-in suite, and ship the wiring. The cost is a third reducer plus the contract specifying which bundle accessors a bin reducer reads (largely the same as the date reducer, with `eval_age` replaced by per-bin saturation slices, and observed-side accumulated across the bin's calendar dates).

Until the decision is recorded, the work cannot start. The default if the decision is deferred is **out of scope** — the conversion_rate module continues to function exactly as it does today.

#### Phase 5e — Dedicated scalar reducer for the param pack

**Pre-Phase-5 context:** the cohort_maturity row reducer still attaches a query-level `completeness` / `completeness_sd` scalar to every row via a call to `_runtime_completeness` inside `_project_runtime_rows`. The pre-Phase-5 now-work implementing [`docs/current/cohort-maturity-render-calc-policy.md`](../cohort-maturity-render-calc-policy.md) applies a stopgap to that function (widening the internal CDF compose horizon to cover the per-Cohort frontier eval points) but keeps the call, the row fields, and their consumers live. Today's param-pack `p.latency.completeness` write is sourced from this scalar through three hops: `_runtime_completeness` → row field → CF endpoint's `last_row.get("completeness")` read at `api_handlers.py:2042-2043` → `conditionedForecastService.extractCfEdgeWriteSpec` → `edge.p.latency.completeness`. Phase 5e replaces this chain with a dedicated scalar reducer and then retires the row field, the FE forward, the CF endpoint's row read, and the `_runtime_completeness` call.

Phase 5e introduces a dedicated scalar reducer as the third CF client (sibling of the tau reducer `cohort_maturity` and the date reducer `daily_conversions`). It reduces the shared `CFProjectionBundle` to scalar moments — at minimum `p_at_saturation_mean/_sd` and `completeness_at_frontier_mean/_sd`, with naming finalised in the contract pass below. The reducer owns its own CALC scope at the perimeter (CALC = `saturation_τ`, because `p_infinity` requires the plateau); it is ignorant of charting and rendering.

Once the reducer exists, Phase 5e repoints the CF endpoint at `api_handlers.py:2042-2043` (`_handle_conditioned_forecast_impl`) from `last_row.get("completeness")` / `last_row.get("completeness_sd")` to the scalar reducer's output. The CF endpoint response shape stays the same; the FE write through `conditionedForecastService` is unchanged; param-pack reads are unchanged. Only the upstream source of the two scalars moves.

With the CF endpoint repointed, Phase 5e then deletes the now-orphaned co-production:

- Delete the `_runtime_completeness` call at `cohort_forecast_v3.py:1416` and the `completeness` / `completeness_sd` row fields it populated (alongside the now-work stopgap to its compose horizon, which becomes moot).
- Retire the FE normaliser forward at `graphComputeClient.ts:500` that surfaced the row scalar to cohort_maturity consumers.
- Rewrite the param-pack parity test at `test_cohort_factorised_outside_in.py:1429-1471` to derive cohort_maturity's completeness scalar from per-Cohort row data via the ratio identity (`evidence rate at frontier_τ_i ÷ FC rate at saturation`, population-weighted), since the row field is no longer available as a direct comparison source.

Surprise_gauge (Phase 5a) becomes a downstream consumer of the same scalar pipeline rather than reading completeness mean/sd from the bundle directly. The two phases can land independently; 5e formalises the surface that 5a depends on.

Before implementation, name the reducer's field contract: which bundle accessors the reducer reads, the perimeter call site that invokes it, where the resulting scalars are persisted (param-pack edge `p.latency`, plus any direct consumers), and which existing tests pin the round trip. If any required scalar is not yet on the bundle, 5e extends the bundle contract before changing the call sites.

**Acceptance:**

- A scalar reducer module exists alongside `reduce_cohort_maturity_rows` and `reduce_daily_conversions_rows`. Its inputs are the shared bundle; its outputs are the named scalar fields; it owns its own CALC at the perimeter.
- The CF endpoint at `api_handlers.py:2042-2043` reads its `completeness` / `completeness_sd` from the scalar reducer's output, not from `last_row`.
- `p.latency.completeness` and `p.latency.completeness_stdev` writes on the param pack come from the scalar reducer's output (via the unchanged CF response and FE write path).
- The `_runtime_completeness` call, the cohort_maturity row `completeness` / `completeness_sd` fields, and the FE forward at `graphComputeClient.ts:500` are deleted. The param-pack parity test is rewritten to derive the comparison via the ratio identity.
- Surprise_gauge's `p` and `completeness` z-score variables consume the same scalar pipeline.
- The reducer's CALC scope is independent of cohort_maturity's and daily_conversions's CALC scopes — it does not piggy-back on either chart's calc.
- **No-branch check:** the scalar reducer reads existing bundle accessors. New per-Cohort scalar fields on the bundle are permitted if needed; new conditioning, new spine arithmetic, or new fallback branches in the engine are not.

### Phase 5 acceptance

Phase 5 is complete when:

- `surprise_gauge` emits its two variables from runtime-owned objects (no `compute_forecast_trajectory` call remains in `api_handlers.py` outside of explicitly retained test paths) and its outside-in tests pass;
- `conversion_funnel` outside-in tests pass against the post-refactor CF response / funnel display contract (no funnel code changes unless a regression is found);
- `bridge_view` decision is recorded in this plan; if direct-CF was chosen, the migration is shipped with tests;
- `conversion_rate` decision is recorded in this plan; if in-scope was chosen, the bin reducer is shipped with phase-1-style blind tests; otherwise the deferral note is recorded with a pointer to doc 49 Phase 3 as the next home.
- the Phase 5 xfail/fixme ledger entries for `surprise_gauge`, `conversion_funnel`, `bridge_view`, and `conversion_rate` are all either passing, rewritten with replacement coverage, or explicitly moved to a documented non-73q follow-up.
- the scalar reducer from 5e exists and is the source of truth for `p.latency.completeness` / `p.latency.completeness_stdev` on the param pack; surprise_gauge consumes the same pipeline.
- **No-branch check:** any Phase 5 implementation consumes existing runtime/projection-bundle surfaces or public CF scalar responses. It introduces no new guards, conditionals, or fallback branches unless explicitly approved. It must not add a new private forecast spine for `surprise_gauge`, `conversion_funnel`, `bridge_view`, or `conversion_rate`.

### Temporary xfail ledger for pre-73q / companion consumers

The following existing tests are marked `xfail` / `fixme` while 73q or its companion consumer decisions are incomplete. This is intentional skip debt, not closure: each marker must be re-run and either rewritten against the shared projection-bundle contract, converted to a passing test, or retired with replacement coverage named.

- `test_doc56_phase0_behaviours.py::test_lag_fit_and_surprise_gauge_share_downstream_temporal_mode_split` — currently xfail-strict pending Phase 5a; absorbed into the doc56 reassignment ledger above. Rewritten in Phase 5a against the runtime-backed `surprise_gauge` as a cross-consumer test or outside-in case; the doc-56 file is then deleted with its remaining six tests reassigned per the ledger.
- `test_funnel_contract.py::TestF4FModeMatchesPathProductOfPromotedMeans::test_f_median_matches_path_product_of_evidence_means` — revisit during Phase 5b. It must either be rewritten against the post-FC `conversion_funnel` outside-in contract or retired in favour of the Phase 5b tests. Its old "73q graph projections" reason is stale; this is a funnel display/reducer contract question.
- Historical references to `test_selected_cohort_pop_d_distribution.py::{test_per_source_day_forward_fill_preserves_monotonicity_under_sparse, test_m_select_construction_for_multi_hop_downstream_node}` — the file is not live in the current tree. Do not carry these as active xfails. Phase 2/3 replacement coverage is the projection-bundle and date-reducer test set above; any archived reference can be closed once that coverage exists.
- `graph-editor/e2e/shareLiveChart.spec.ts::live share (conserve-mass fixture) produces distinct scenario graphs + non-empty inbound-n (regression)` — revisit during Phase 5c (`bridge_view` decision). The assertion checks that the two scenarios on the analyze request differ on `edge.p.mean` for `switch-registered-to-switch-success` when visibility_mode is `'e'` vs `'f'`. That divergence relied on the pre-73q semantic where `p.mean` was overwritten from `p.evidence.mean` or `p.forecast.mean` according to visibility_mode. Under current semantics `p.mean` is canonical/blended and invariant across visibility modes; visibility-mode divergence now lives in display-layer projections. If bridge remains graph-state-driven, rewrite the test to assert the chosen display-level discriminator. If bridge becomes display-surface-driven, rewrite it against the new bridge output.

73q core is not complete until the daily-conversions and projection-bundle markers above have been cleared. Phase 5 is not complete until the companion funnel/bridge/surprise/conversion-rate markers have likewise been converted, rewritten, or removed with explicit replacement coverage named.

### Phase 6 — Retire cohort_maturity v1 and v2

The legacy chart paths `cohort_maturity_v1` and `cohort_maturity_v2` are independent of daily-conversions but block phase 7's cleanup sweep because their handlers, modules, registries, and tests still reference symbols phase 7 needs to delete. Phase 6 retires them as a self-contained chunk.

Removal scope, audited by static reads:

- **Backend handlers and dispatch.** Delete `_handle_cohort_maturity_v2`, the `cohort_maturity_v2` dispatch branch, the `cohort_maturity_v1` dispatch branch, and any helper membership that treats `cohort_maturity_v1` as a live cohort-maturity family member. The `_handle_snapshot_analyze_subjects` function survives because non-v1 analyses still route through it; only the v1-specific logic inside it is removed.
- **Subject-resolution mappings.** Delete the `cohort_maturity_v1` and `cohort_maturity_v2` entries in `analysis_subject_resolution.py`.
- **Frontend registries.** Delete the `cohort_maturity_v1` and `cohort_maturity_v2` entries from `analysisTypes.ts`, `analysisTypeResolutionService.ts`, chart-container alias mappings, and snapshot boot tracing.
- **Span-evidence emit labels.** `span_evidence.py` emits `analysis_type: 'cohort_maturity_v2'` in diagnostic output. Either retarget those to `'cohort_maturity'` or remove the field if it is unused; choose by inspecting the consumer.
- **Tests.** Delete tests that exclusively cover v1 or v2 surfaces. Tests that cover behaviour shared with the canonical `cohort_maturity` path are retargeted there if not already present elsewhere.

Phase 6 is purely a deletion plus a retargeting of three diagnostic labels. The chart family observable from the FE collapses from `cohort_maturity` / `cohort_maturity_v1` / `cohort_maturity_v2` to a single `cohort_maturity`. No migration of behaviour: v1 and v2 charts have been superseded by v3 since 73n; this just removes the dead routes.

Phase 6 acceptance:

- A static search shows zero references to `cohort_maturity_v1` or `cohort_maturity_v2` in production code (BE Python, FE TypeScript, BE / FE registries).
- The v3 cohort_maturity outside-in tests still pass unchanged.
- The phase 1 daily-conversions invariant suite still passes (it does not depend on v1/v2 paths).
- No new dead-code references appear: imports that became unused are also removed.
- **No-branch check:** v1/v2 retirement introduces aliases or compatibility normalisation only at the perimeter, and only if that compatibility is explicitly retained. It introduces no new guards, conditionals, or fallback branches unless explicitly approved. It must not preserve separate v1/v2 runtime or reducer branches behind the canonical `cohort_maturity` name.

### Phase 7 — Cleanup sweep

Phase 7 is the cleanup atom that becomes possible once phases 4, 5, and 6 are landed. It is a deletion-and-quietening sweep. Every item below is justified by an audit of static references; nothing is deleted speculatively.

#### Modules and symbols deletable post phases 4–6

- **`runner/forecast_state.py` symbols.**
  - `compute_forecast_trajectory` and its supporting helpers (`build_node_arrival_cache`, `_resolve_edge_p`, `_compute_completeness_at_age` if no internal residual remains): no public callers after phases 4 and 5a; no v1/v2 callers after phase 6.
  - `_warn_legacy_pmean_carrier`: still imported outside `forecast_state.py`. Phase 7 inspects each call site: if the warning fires for a code path that no longer exists, delete the warning and its call sites; if the warning still applies to live code, keep it and rehome to a non-legacy module.
  - `CohortEvidence`: still imported by `cohort_forecast_v3.py` as a data container. Phase 7 either rehomes the dataclass to a non-legacy module (e.g. into `cohort_forecast_v3.py` directly or into a new `runner/cohort_evidence.py`) or shrinks `forecast_state.py` down to just this dataclass.
  - The remaining `forecast_state.py` is deleted only when every symbol is either deleted or rehomed and the file is empty.

- **`runner/cohort_forecast.py` (v1, 1526 LOC).** Used only by `cohort_forecast_v2.py` and the v1 dispatch path; both gone after phase 6. Deleted whole.

- **`runner/cohort_forecast_v2.py` (1210 LOC).** Used only by `_handle_cohort_maturity_v2`; gone after phase 6. Deleted whole.

- **`runner/forecast_application.py` symbols.**
  - `annotate_rows` and `annotate_data_point`: callers in `api_handlers.py` sit in v1/v2 chart paths or daily-conversions legacy fallback paths that go away earlier in this plan. After those removals, both functions are deleted or reduced to compatibility wrappers with no production callers.
  - `compute_completeness`: still used by synthetic-future-frame helpers in `api_handlers.py`. The v3 path's residual model-derived completeness call is a legitimate item but **not** in 73q's scope: it is named here as a follow-up atom (migrate synthetic future frames to read runtime-owned completeness instead of model-CDF). `compute_completeness` and the synthetic-frame helper survive phase 7 unless that follow-up lands first.

- **API handler residuals.**
  - The daily-conversions enrichment block (already deleted in phase 4): confirm static absence.
  - The surprise-gauge enrichment block (rewritten in phase 5a): confirm static absence of `compute_forecast_trajectory` import and call.
  - Comments labelled `POST-73n`, `73n follow-up`, "still surviving", "legacy trajectory consumer": delete or rewrite. The migration is no longer pending.

- **TODO.md entries.** Delete the `73n follow-up` items that name daily-conversions, surprise-gauge, or v1/v2 retirement. Other `73n` items unrelated to this work are left alone.

#### Tests

Phase 7 deletes tests whose only purpose is to bless deleted production code:

- Tests that import `compute_forecast_trajectory`, `CohortEvidence` (as legacy-engine fixtures, not as a v3 data container), or `annotate_rows` to assert legacy behaviour, except where the test has been retargeted to the runtime-backed path in phase 4 or phase 5a.
- Tests for `_handle_cohort_maturity_v2`, the v1 dispatch path, or v1/v2 chart contracts in the FE.
- Tests for the v1/v2 entries in `analysisTypes.ts`, `analysisTypeResolutionService.ts`, etc.
- Tests for the daily-conversions `annotate_rows` fallback (already a silent no-op in production; the test was pinning the no-op).

Each deleted test is checked for any unique semantic assertion not covered elsewhere; if found, the assertion is rehomed to a v3 test before the legacy test is deleted.

#### Documentation

- Archive the doc-29 series of forecast-engine implementation plans where they describe the legacy trajectory engine that no longer exists. Documents that contain mixed legacy/current content are split: legacy sections move to `docs/archive/project-bayes/`, current sections stay.
- Update `docs/current/codebase/INVARIANTS.md` and `docs/current/codebase/COHORT_ANALYSIS_NUMERATOR_DENOMINATOR_SEMANTICS.md` to remove any "still pending migration" footnotes that this work has cleared.
- Archive 73q itself when phase 7 completes — it has done its job and the cleanup it specifies is complete.

#### Phase 7 acceptance

- `forecast_state.py` is either deleted or contains only `CohortEvidence` (with deletion of the rest); a follow-up atom is filed if `CohortEvidence` rehome is chosen but not done here.
- `cohort_forecast.py` and `cohort_forecast_v2.py` are deleted.
- `annotate_rows` and `annotate_data_point` are deleted from `forecast_application.py`.
- A static search shows zero remaining references to `compute_forecast_trajectory`, `cohort_maturity_v1`, `cohort_maturity_v2`, or the daily-conversions/surprise-gauge legacy enrichment markers.
- No tests reference deleted symbols.
- TODO.md no longer carries `73n follow-up` items related to this work.
- Anti-regression invariants are recorded in `INVARIANTS.md` so future work cannot reintroduce the deleted symbols by accident.
- **No-branch check:** cleanup removes legacy branches rather than hiding them behind wrappers. Any surviving guard, conditional, fallback branch, or compatibility wrapper requires explicit approval, a named non-production caller, and a dated deletion plan.

## Invariants

The plan as a whole must preserve these controls:

- **Selected-set conditioning.** The posterior is conditioned on the full selected set of Cohorts scoped by the `window()` or `cohort()` query, exactly as the current shared CF runtime does.
- **No 73p semantics.** No hierarchical per-Cohort posterior, no hyperprior fitting, no partial pooling, no new per-Cohort posterior schema.
- **No duplicate forecast engine.** After phase 4, daily conversions does not call `compute_forecast_trajectory`. After phase 5a, neither does `surprise_gauge`. After both, the legacy trajectory engine has no public-path callers and is deletable.
- **No projection-time conditioning.** The date reducer does not bind evidence, condition primitives, apply doc-52, choose priors, or rebuild carrier or subject spans.
- **`Y / X` invariant.** Rates are always subject-end `Y` over denominator-at-`X`; Cohort mode never becomes `Y / A`.
- **Carrier ownership.** In active Cohort mode, denominator arrival is owned by the runtime carrier object. Daily conversions does not recompute or bypass `A → X`.
- **Subject ownership.** Numerator progression is owned by the runtime subject span. Daily conversions does not silently use a terminal edge when the request subject is multi-hop.
- **Observed evidence preserved.** `derive_daily_conversions` remains the source for observed daily deltas and observed `y_at_age`; the runtime projection does not rewrite observed history.
- **No legacy fallback.** The daily-conversions `annotate_rows` fallback is removed in phase 4. If the runtime cannot project, the response emits unavailable / degraded projection fields with provenance rather than silently switching machinery.
- **Two reducers, one projection bundle.** The projection bundle is built by one shared helper and consumed by both the tau reducer (cohort_maturity) and the date reducer (daily_conversions). No new subject-resolution path, no new evidence-binding path, no second runtime construction.
- **Field contract is binding.** The "Reducer field contract" section is the source of truth for every field of the daily-conversions response. The date reducer implements that contract; phase 1 tests assert it; phase 4 cannot relax it without a corresponding plan revision.
- **Projections do not own runtime semantics.** Per `COHORT_ANALYSIS_NUMERATOR_DENOMINATOR_SEMANTICS.md` §9, the date reducer does not introduce its own `completeness`, saturation horizon, layer rule, or any other semantic decision. Every value the reducer reads is sourced from the projection bundle, an existing runtime-owned object, or the extracted shared layer helper. Daily_conversions emits some fields (`layer`, `completeness`) that cohort_maturity does not, but the underlying definitions are shared.
- **Terminology discipline.** Use **Cohort**, **`cohort()`**, **Cohort mode**, and **Window mode** consistently.

## Non-goals

- No 73p hierarchical per-Cohort conditioning.
- No per-Cohort posterior schema.
- No new frontend chart type requirement.
- No change to observed snapshot delta derivation.
- No change to FE normalisation, except for accepting additive fields already present in the backend response.
- No gross-fitted numerator admission.
- No broad rewrite of cohort_maturity row arithmetic.
- No projected calendar-date forecast series. The third theoretical reducer (Cohort-collapsed diagonal of the projection bundle) has no daily-conversions consumer and is explicitly out of scope.

## Acceptance

The atom is complete when:

- the Phase 1 outside-in invariant suite is calibrated and committed;
- the phase-owned structural tests are in place: Phase 2 projection-bundle integration tests, Phase 3 date-reducer and cross-consumer tests, and Phase 5a surprise-gauge replacement coverage;
- `test_doc56_phase0_behaviours.py` is deleted, with each of its seven tests reassigned to its new home per the doc56 reassignment ledger or deleted with explicit rationale; a static search shows no remaining references to the seven test names;
- the projection bundle exposes per-Cohort FC draws, FC future residuals, per-Cohort completeness, and a latency-band tau accessor;
- the date reducer exists alongside the tau reducer over a single shared projection-bundle builder;
- daily conversions in `api_handlers.py` derives forecast enrichment from the projection bundle plus date reducer, not from the trajectory engine;
- the phase 1 invariant suite passes against the runtime-backed daily-conversions path;
- every legacy-gap expected-fail recorded in phase 1b is cleared by the cutover;
- existing daily-conversions response fields remain present;
- a static search shows no daily-conversions `compute_forecast_trajectory` call and no daily-conversions `annotate_rows` fallback;
- after phase 5a, a static search shows no `surprise_gauge` `compute_forecast_trajectory` call;
- after phase 5b, `conversion_funnel` outside-in tests pass against the post-refactor CF response / funnel display contract;
- phase 5c and 5d decisions are recorded in this plan; any in-scope migration is shipped with its tests, any deferral has a documented next home;
- after phase 6, no production code references `cohort_maturity_v1` or `cohort_maturity_v2`;
- after phase 7, the legacy modules and symbols listed in the cleanup sweep are deleted, dead tests are gone, the doc references are archived, and anti-regression invariants are recorded.

## Test debt to pick up when this lands (added 12-May-26)

The following canary is currently `xfail(strict=False)` pending this cutover:

- **`graph-editor/lib/tests/test_conditioned_forecast_parity.py::TestPhase4AsatVisibility::test_daily_conversions_boundary_shift`**. Asserts the asat-vs-live boundary contract on synth-simple-abc: live → all `mature` rows; asat → fewer `mature` rows, plus a `forecast` zone, plus a **null-completeness** boundary band where data thins out before the forecast horizon. Today the legacy enrichment in `api_handlers.py` produces mature → forecast directly with no null-completeness band, so the test fails on `asat.null_completeness_rows > 0`. The post-cutover date reducer described under §"Reducer field contract — Completeness / Layer" inherits the band from the shared projection bundle, at which point this canary should pass naturally; remove the xfail then. If the cutover deliberately changes the band semantics, the test's threshold conditions need updating to match the new contract rather than being deleted.
