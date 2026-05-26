# 73q Daily Conversions Shared Runtime Cutover Plan

**Status**: Proposal (rewrite) — 7-May-26; test-architecture amendment 13-May-26; CF/FC machinery rethink 26-May-26
**Supersedes**: the 4-May-26 version of this document, archived at `docs/archive/project-bayes/73q-daily-conversions-shared-runtime-cutover-plan.md`. The 13-May-26 amendment restructures Phase 1 into a four-tier test architecture and adds Phase 1d (retirement of `test_doc56_phase0_behaviours.py`). The 26-May-26 rethink retargets this plan at the current CF row pipeline and frontier-conditioned (`ef_*`) projection surfaces, and changes the implementation shape: 73q is now a reducer over a shared **CF projection bundle**, not over generic "conditioned draws".
**Scope**: Move daily conversions onto the shared CF runtime by adding a date reducer over the same projection bundle as the cohort-maturity tau reducer, without implementing 73p hierarchical per-Cohort conditioning, and without trusting the current legacy daily-conversions arithmetic as an oracle.

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
- the selected A-clock evidence object and projection bases;
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

## Current code reality as of 26-May-26

This is the part that makes 73q non-trivial after the FC work. The current code is close, but it does **not** yet expose the reducer contract this document needs.

- `model_span_spine.SelectedCohortRowProjection` exposes aggregate `(S, T)` surfaces only: `f_*`, `ef_*`, `rate_draws_spliced`, strict evidence totals, and strict evidence by anchor maps. Inside `project_selected_cohort_rows`, per-Cohort arrays (`x_model_by_anchor`, `y_model_by_anchor`, empirical traces, FC ledgers) exist during computation but are reduced before return.
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

### Saturation tau

The runtime already computes a single principled saturation horizon per request. `build_cohort_evidence_from_frames` produces `fe.saturation_tau = max(max_tau, ceil(2 × t95))` capped at 400, where `t95` is the resolved latency 95th percentile (path-level in cohort mode, edge-level in window mode). This is the existing single source of truth. The date reducer reads `fe.saturation_tau` from the projection bundle for every field whose contract requires "evaluated at saturation". This plan does not introduce a new saturation definition, a percentile threshold, a floor, or a fallback. If the existing definition is wrong for some semantic question, that is a runtime change outside 73q's scope.

The projection bundle's per-Cohort arrays must extend to `fe.saturation_tau`. The existing public tau rows can stop at `fe.max_tau`, which can be smaller than `fe.saturation_tau`. Phase 2 aligns the spine projection horizon with `fe.saturation_tau` so the date reducer can index per-Cohort FC draws at saturation without re-running the projection at a different horizon.

### Completeness

Completeness is owned by the runtime per `COHORT_ANALYSIS_NUMERATOR_DENOMINATOR_SEMANTICS.md` §9: "Chart rows, CF scalar responses, graph-enrichment fields, and overlays are projections of the already-resolved runtime object. They must not contain their own carrier, subject-span, p∞, completeness, or admission logic." The date reducer therefore does not choose a completeness flavour. It reads a per-Cohort variant of the existing `_runtime_completeness` object — the same request-rooted CDF readout that cohort_maturity's scalar completeness already uses — at each Cohort's `eval_age`. Phase 2 exposes the pre-aggregation per-Cohort values from `_runtime_completeness`'s existing internal computation; it does not introduce a new completeness definition. If the runtime's request-rooted definition is later judged wrong for active-mode daily-conversions display semantics, that is a runtime change with its own atom and its own tests, not a date-reducer-local override.

### Layer

`layer` is a daily-conversions-only field (cohort_maturity rows do not carry one). The rule is the existing rule from `forecast_application.annotate_data_point`: `c ≥ MATURITY_THRESHOLD → 'mature'; c > COMPLETENESS_EPSILON → 'forecast'; else 'evidence'`, with `MATURITY_THRESHOLD = 0.95` and `COMPLETENESS_EPSILON = 1e-9`.

Because this plan later deletes the legacy `annotate_rows` / `annotate_data_point` surface, Phase 2 first extracts the constants and rule into a small non-legacy helper owned by the runtime/projection boundary. The date reducer imports that helper. No new constants, no local reimplementation.

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
- `latency_bands`. A map keyed by canonical band labels matching the legacy labels (`'25d'`, `'50d'`, `'75d'`). Band taus are inverse-CDF percentiles of the resolved latency distribution at 0.25, 0.50, 0.75 plus `onset_delta_days` — the existing legacy derivation, lifted into a single projection-bundle accessor. Per band:
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
- `cf_mode`, `cf_reason`. Read from `runtime` via `get_cf_mode_and_reason(runtime.resolved_override)` exactly as cohort_maturity does today.
- `promoted_source`. Read from `runtime.runtime_provenance.p_conditioning_evidence.source`. Falls back to `runtime.resolved_override.source` if the provenance block is absent. The two sources currently agree by construction; the runtime-provenance form is canonical going forward.

### Cross-reducer consistency

The projection bundle is the same object for both reducers, so a strong cross-reducer invariant exists, but it is more delicate than a naive aggregation equivalence. The clean form: for any single-Cohort fixture, the cohort_maturity FC tau-row at `tau = saturation_tau` and the daily-conversions row for that Cohort must agree on the projected `Y / X` rate at that tau. For multi-Cohort fixtures, the cohort_maturity tau-row at any tau equals the across-Cohort sum of per-Cohort FC `(Y[i, :, τ], X[i, :, τ])` divided once at the end (the bundle's own aggregation rule); daily-conversions per-Cohort rows expose the un-summed view at each Cohort's `fe.saturation_tau`. Phase 1 tests for cross-reducer consistency are restricted to single-Cohort fixtures or to the explicit aggregation rule, never to a casual "weighted average" form.

## Phases

Each phase is a separable, mergeable chunk. Phases 2 and 3 are mechanically safe (they add capability without changing daily-conversions behaviour). Phase 1 is the calibration step that hardens the contract. Phase 4 is the cutover.

### Phase 1 — Test architecture for the cutover

This phase delivers the test architecture 73q ships against. It comprises four tiers organised by what each tier proves and what it costs to run, plus the retirement of `test_doc56_phase0_behaviours.py`, whose current empirical cross-consumer matrix is rendered structurally redundant by the shared projection-bundle architecture and whose runtime cost (several real-DB pipeline runs per assertion) is disproportionate to the claims it still polices.

The four tiers, in increasing wall-cost:

1. **Projection-bundle algebra unit tests** — sub-second; mock bundles assembled from numpy arrays; assert reducer algebra at the (Cohort, particle, τ) tensor level. No DB, no conditioning, no composition.
2. **Projection-bundle integration tests** — seconds; tiny in-memory fixtures (a handful of edges, anchor days, and snapshots); assert properties of the extracted shared projection-bundle builder. No DB.
3. **Cross-consumer projection tests via shared bundle** — seconds; a known bundle injected into the handler shims; assert tau reducer, date reducer, and (after Phase 5a) the scalar projector produce coherent readouts of the same per-Cohort surfaces.
4. **Outside-in semantic acceptance oracle** — slow; the existing `test_cohort_factorised_outside_in.py` extended with daily-conversions cases per Phase 1a; full pipeline, real-DB; the load-bearing canary.

Tier 4 retains the original "blind invariant" framing because it is the semantic acceptance oracle and must clear legacy-gap expected-fails in phase 4. Tiers 1–3 do not require calibration against the legacy daily-conversions arithmetic because they assert structural properties of the new architecture (per-Cohort reducer algebra, projection-bundle determinism, single-bundle cross-consumer reads) rather than numerical outputs the legacy engine produced.

The four tiers do not all land in a single Phase 1 burst. Tier 1 can be written early — before Phases 2 and 3 — because it consumes mock projection bundles and drives the date reducer's algebra by pinning what it must implement. Tier 2 lands alongside the Phase 2 projection-bundle/accessor work. Tier 3 lands alongside Phase 3 and again at Phase 5a (surprise_gauge migration). Tier 4 is the existing Phase 1a/1b work below, authored blind against the contract and calibrated against legacy. The doc-56 retirement (Phase 1d) is the final cleanup pass once tiers 1–3 are in place.

#### Phase 1a — Author outside-in tests blind (Tier 4)

Extend the existing outside-in CLI tests with daily-conversions cases. Tests assert the "Reducer field contract" section above. The contract is the source of truth for what each field means; tests assert the contract's claims, not the legacy implementation's outputs. The required coverage classes are:

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

#### Phase 1b — Run outside-in tests against current main and harden (Tier 4)

Run the phase 1a tests against the current daily-conversions path on `main` (the legacy trajectory enrichment in `api_handlers.py`). Three outcomes are possible per assertion:

- **Pass on legacy.** The legacy path satisfies the invariant. The assertion stays as-is and becomes a regression guard for the cutover.
- **Fail on legacy because the test is over-tight.** The invariant is genuinely weaker than the assertion expressed it. Loosen the assertion to the minimum bound that still pins the contract. Record the original tighter form in a comment on the test as a future strengthening candidate.
- **Fail on legacy because the legacy path is wrong.** Mark the test as expected-fail with a written reason, and record the legacy gap in this document's "Known legacy gaps" section (added during phase 1b). The cutover in phase 4 is required to clear that expected-fail.

The phase 1b output is a calibrated invariant suite, a documented list of legacy gaps, and a clear definition of what phase 4 must achieve to be considered correct. No production code changes in phase 1.

#### Phase 1c — Structural fast-tier suite (Tiers 1–3)

Add the three fast structural tiers alongside the outside-in suite. Each tier is its own test file, sibling to `test_cohort_factorised_outside_in.py`. Sequencing within the broader 73q work is natural: Tier 1 lands first and drives Phase 3; Tier 2 lands alongside Phases 2 and 3; Tier 3 lands alongside Phase 3 and again at Phase 5a.

**Tier 1 — projection-bundle algebra unit tests.** These consume mock projection bundles assembled from numpy arrays. A small helper builds a bundle with a chosen number of Cohorts, particles, and tau slots, populating `ef_x_draws_by_cohort[d, s, τ]`, `ef_y_draws_by_cohort[d, s, τ]`, `ef_forecast_y_by_cohort[d, s, τ]`, strict observed fields, per-Cohort completeness, and projection status to whatever shape the test under examination requires; no real conditioning, no real composition, no DB. The tier then exercises the two reducers (and, after Phase 5a, the scalar projector) on those mocked surfaces and asserts the algebra each is contractually required to implement.

The Tier 1 claims are: tau-reducer aggregation rule (the row at τ equals Σ-of-Y over Σ-of-X across selected Cohorts, divided once per particle, then quantiled across particles); date-reducer per-Cohort identity (the row for Cohort d at τ equals the un-summed FC Y/X ratio for that Cohort, quantiled across particles); single-Cohort cross-reducer equality (with one Cohort the two reducers' FC band outputs match to floating-point on the same draws); multi-Cohort explicit-aggregation rule (the tau row equals the bundle's own Σ-of-Y over Σ-of-X built from the per-Cohort FC arrays the date reducer exposes — never a casual weighted-average form); skipped-Cohort emission (a Cohort with zero `a_pop` produces zeros in the per-Cohort arrays and the date reducer emits a row with null projection fields and explicit provenance rather than dropping it); band geometry on per-Cohort FC draws (`forecast_bands[level][hi] ≥ bands[level][lo]`, monotone nesting across levels); layer-rule application (the constants and rule are imported from the shared layer helper and applied to mock completeness values; the three transitions evidence → forecast → mature are verified across COMPLETENESS_EPSILON and MATURITY_THRESHOLD); projection bounds (`projected_y ≥ y`, `forecast_y ≥ 0`, rate ∈ [0, 1] when X > 0); per-band tau selection (latency-band readouts at evidence-side vs forecast-side split at `eval_age ≥ band_tau`).

Tier 1 is cheap enough to run in every CI invocation and fast enough to TDD against during Phase 3 development.

**Tier 2 — projection-bundle integration tests.** These build a real projection bundle from a hand-rolled in-memory graph (no DB) and assert properties of the build itself, not of any reducer. The fixtures are tiny: typically three to four edges, five to ten anchor days, a handful of snapshots constructed in code rather than fetched from the DB. The bundle is built by calling the extracted shared helper that owns the current `compute_cohort_maturity_rows_v3` preparation path, not by calling the public row function and scraping rows.

The Tier 2 claims are: identity-carrier degeneracy (window mode and cohort(A=X) on the same graph produce structurally equivalent composed surfaces — `composed_carrier is None` in both, and the per-Cohort FC arrays the bundle exposes are identical to within the carrier-mode reproducibility tolerance); edge-list reorder invariance (the bundle's runtime is structurally identical under permutation of the input edge list — same composed_carrier, same composed_subject, same conditioned_primitive_map keys, same draws); multi-hop subject preservation (a multi-hop subject span produces a `composed_subject` whose draws are the per-edge convolution, not the terminal-edge CDF — the substrate-level guarantee invariant 5 requires); `fe.saturation_tau` plumbing (the value the bundle exposes matches the value the date reducer reads, and matches the formula `max(max_tau, ceil(2 × t95))` capped at 400); per-Cohort projection horizon alignment (after Phase 2, the per-Cohort arrays cover `fe.saturation_tau`, not just `fe.max_tau`); latency-band tau accessor consistency (the canonical accessor returns the same set both reducers consume — no divergence between the tau-reducer's band tau and the date-reducer's band tau).

Tier 2 catches bundle-build-time defects that Tier 1's mock bundles cannot expose because Tier 1 assumes the bundle is correct.

**Tier 3 — cross-consumer projection tests via shared bundle.** These inject a known projection bundle (mock or fixture-built) into the handler shims and assert that all consumers — the cohort-maturity tau reducer, the new date reducer, and post-5a the surprise_gauge scalar projector — produce coherent reads of the same `(Cohort, particle, τ)` surfaces. The structural claim being tested is invariant 1 (one machinery) plus invariant 9 (projection does not re-decide semantics) at integration level: if every consumer routes through the same bundle, they cannot numerically disagree on the same quantity.

The Tier 3 claims are: single-bundle cross-consumer reading (cohort_maturity_v3's FC row at τ = saturation_tau and daily_conversions's `projected_y` / `forecast_bands` for the single-Cohort case read from the same per-Cohort FC arrays and agree to floating-point — replaces the doc-56 `cf_p_mean_matches_v3_p_infinity` empirical matrix with a surface-specific claim); scalar projector coherence (post-5a, surprise_gauge's `p` and `completeness` z-score inputs read from `runtime.public_moments`, per-Cohort completeness, and `runtime.unconditioned_overlays['predictive']`, not from the legacy trajectory engine); response-shape invariants (`cf_mode`, `cf_reason`, `promoted_source` are populated identically on all consumers when emitted at all).

Tier 3 lands in two waves: first alongside Phase 3 covering tau reducer and date reducer; second alongside Phase 5a covering the surprise_gauge scalar projector. The bayesian-sidecar variants are covered as additional fixtures within these tests rather than as separate test files.

Phase 1c is complete when the three tiers exist as separate test files (sibling to `test_cohort_factorised_outside_in.py`), each runs in its named cost envelope on CI, and the assertions named above are all in place and green against the architecture as it stands at each tier's landing phase.

#### Phase 1d — Retire `test_doc56_phase0_behaviours.py`

The doc-56 file dates from the v1→v2/v3 cut-over period and was framed as "phase-0 cross-consumer cut-over regression guard". The doc-64 authoring receipt in the file already retires the doc-56 framing in favour of Family C (cross-consumer agreement). 73q completes that retirement by absorbing each remaining claim into the new test architecture and deleting the file.

Each of the seven tests in the file is reassigned explicitly so no semantic claim is silently lost:

- **`test_cf_and_v3_chart_carrier_tier_agree`** — claim is about `model_resolver` carrier-tier selection, not about CF runtime semantics. Moved to a new `test_model_resolver_carrier_tier.py` unit test (millisecond cost, no pipeline). 73q ships the moved test in Phase 1d.
- **`test_cf_p_mean_matches_v3_p_infinity`** — structurally redundant after 73q. The replacement is Tier 3's surface-specific cross-consumer test: scalar/public-moment consumers and row/date reducers read from the shared projection bundle or runtime public moments rather than independently reconstructing p@∞. Deleted with no replacement in the doc-56 file.
- **`test_query_scoped_identity_carrier_collapses_public_evidence_basis`** — claim is about identity-carrier degeneracy. Replaced by Tier 2's identity-carrier degeneracy test, which asserts the same property at projection-bundle level rather than at chart-row level (cheaper, sharper). Deleted.
- **`test_whole_graph_cf_is_invariant_under_edge_reorder`** — claim is about runtime/projection determinism under input permutation. Replaced by Tier 2's edge-reorder invariance test, which exercises the projection-bundle builder directly rather than running two full pipelines. Deleted.
- **`test_lag_fit_and_surprise_gauge_share_downstream_temporal_mode_split`** — currently xfail-strict pending Phase 5a (per the ledger below). Rewritten in Phase 5a against the runtime-backed surprise_gauge as a Tier 3 cross-consumer test or as a Tier 4 outside-in case. Deleted from the doc-56 file at that point.
- **`test_chart_and_daily_conversions_do_not_collapse_window_and_cohort`** — the current claim ("both consumers expose a window/cohort split") is a weaker form of what 73q makes available. Replaced by two stronger assertions: Tier 1's single-Cohort cross-reducer equality (cohort_maturity row at τ = saturation_tau equals daily_conversions row for that Cohort to floating-point) and Tier 4's mode invariants (window vs cohort produce demonstrably different per-Cohort projections under the shared projection bundle). Deleted.
- **`test_bayesian_sidecar_preserves_downstream_window_cohort_chart_split`** — currently xfail-non-strict (stale under WP8 per the existing pytest marker). The structural claim (multi-hop subject preservation, downstream split survival) is covered more directly by Tier 2's multi-hop subject preservation test and Tier 1's mode-invariant assertions. Deleted (no replacement in this file; the bayesian-sidecar code path itself is exercised as a fixture variant within the Tier 3 cross-consumer tests).

Phase 1d is complete when the file is deleted, the moved and replaced tests exist in their new homes and run green, and a static search shows no remaining references to the seven test names anywhere in the codebase or in CI manifests. The runtime cost saved is several minutes of CI per invocation.

Phase 1 acceptance tests:

- Tier 1 mock-bundle reducer tests exist and fail against a no-op date reducer. They cover `projected_y`, `forecast_y`, `forecast_bands`, `completeness`, `layer`, `latency_bands`, skipped-Cohort rows, and multi-Cohort mass-first aggregation.
- Tier 2 projection-bundle integration tests exist for identity carrier, active carrier, and multi-hop subject fixtures. They do not use DB and do not call public row output as their oracle.
- Tier 3 cross-consumer tests exist for single-Cohort tau/date agreement and explicit multi-Cohort `ΣY/ΣX` aggregation.
- Tier 4 outside-in daily-conversions cases are authored or calibrated, with every legacy failure either passing, explicitly expected-failing with a named legacy gap, or narrowed to the weakest assertion that still expresses the contract.
- `test_doc56_phase0_behaviours.py` is either deleted per the reassignment table or every remaining test in it has a named blocking phase and replacement home.

### Phase 2 — Projection Bundle Expansion

The CF runtime and selected-Cohort spine currently produce the right aggregate chart surfaces, but the date reducer needs a shared bundle with per-Cohort views. Phase 2 extracts that bundle and adds the accessors required by the field contract above. Phase 2 is internal to the runtime/projection machinery and has zero observable effect on daily conversions, cohort_maturity, or any other current consumer.

Required accessors and refactors. Each is a plumbing or shape change against an existing principled object; none introduce a new mathematical definition or a magic constant.

- **Shared CF projection bundle.** Extract the preparation/projection sequence currently embedded in `compute_cohort_maturity_rows_v3` into a helper that returns `FrameEvidence`, `ResolvedCFRuntime`, selected A-clock evidence, projection bases, `n_by_anchor`, and `SelectedCohortRowProjection`. The public row function becomes "build bundle → tau reducer"; daily conversions becomes "build bundle → date reducer". Neither reducer rebuilds runtime state.
- **Per-Cohort projection arrays at saturation horizon.** Refactor `model_span_spine.project_selected_cohort_rows` / `SelectedCohortRowProjection` so its natural intermediate is per-Cohort `(N_cohorts, S, T)` arrays for FC `X`, FC `Y`, FC future residuals, and FC rate, with the across-Cohort `(S, T)` aggregate computed at consume time. Return both views on the projection object. The tau reducer sums per-Cohort into the aggregate it already uses for `ef_*`; the date reducer indexes per-Cohort directly. Per-Cohort `ef_rate_draws_by_cohort` is computed as `ef_y_draws_by_cohort / ef_x_draws_by_cohort` with the projection's existing NaN policy. Build the bundle's projection at `fe.saturation_tau` for date-reducer use; the tau reducer still emits only public rows through `fe.max_tau`.
- **`fe.saturation_tau` plumbed through the projection bundle.** The bundle returns `fe.saturation_tau` so the date reducer reads it without retraversing internals. No new derivation; this is the existing value.
- **Per-Cohort completeness from `_runtime_completeness`.** Refactor `_runtime_completeness` to expose the per-Cohort values it already computes internally, prior to the across-Cohort weighted reduce. The existing scalar return becomes one view; the per-Cohort array becomes the other. Same underlying CDF object, same horizon, same definition. The cohort_maturity scalar caller is unchanged.
- **Latency-band tau accessor.** The legacy daily-conversions enrichment computes the band tau set inline in `api_handlers.py` from the resolved latency: `inverse_cdf(0.25/0.50/0.75, mu, sigma) + onset_delta_days`, with `max(1, round(raw))` to discretise and a deduplication step on the resulting integer set. Lift that exact derivation into a projection-bundle accessor so both reducers and any future consumer share one definition. No new derivation. When a band tau exceeds `fe.saturation_tau` the accessor still returns it; the date reducer emits `null` for that band per the field contract.
- **Layer helper extraction.** Move `MATURITY_THRESHOLD`, `COMPLETENESS_EPSILON`, and the completeness → layer rule out of the legacy `forecast_application.annotate_data_point` surface into a non-legacy helper. Existing callers can be retargeted or left as compatibility wrappers until Phase 7 deletes the old helpers.
- **Resolved-source provenance.** Confirm `runtime.runtime_provenance.p_conditioning_evidence.source` is populated at runtime construction time and accessible without traversing diagnostic blobs. The `promoted_source` field on the daily-conversions response reads from this. No alternative source.

Phase 2 is complete when:

- Existing cohort-maturity outside-in tests pass unchanged through the extracted projection-bundle helper.
- A focused bundle test proves public aggregate `ef_x_draws`, `ef_y_draws`, `ef_rate_draws`, `ef_forecast_x`, and `ef_forecast_y` are exactly the sum or mass-first reduction of the new per-Cohort arrays.
- A focused horizon test proves the bundle's per-Cohort FC arrays cover `fe.saturation_tau` when `fe.saturation_tau > fe.max_tau`, while public cohort-maturity rows still emit only through `fe.max_tau`.
- A focused completeness test proves the exported per-Cohort completeness values reduce to the existing scalar `_runtime_completeness` result with the same weights.
- A focused latency-band accessor test proves both reducers see the same dynamically-labelled band taus and that a band beyond `fe.saturation_tau` remains representable as unavailable rather than clamped.
- A focused skipped-Cohort test proves active Cohorts with no root-window carrier evidence remain present in bundle metadata with a reason, even if they contribute zero to aggregate FC arrays.
- A layer-helper test proves the extracted helper exactly matches the legacy `annotate_data_point` thresholds.
- A static check or focused unit test proves no daily-conversions `api_handlers.py` wiring has changed in Phase 2.

### Phase 3 — Date reducer

Add a sibling of the existing tau-axis row builder, in the same module, implementing the field contract above. The date reducer takes the shared projection bundle from Phase 2 and reads from it mechanically: observed row shape from `derive_daily_conversions`, per-Cohort FC projection surfaces from `SelectedCohortRowProjection`, per-Cohort completeness from the completeness view, `fe.saturation_tau`, and the latency-band tau set.

For each Cohort the reducer emits one `rate_by_cohort` row whose fields are populated from the contract. The contract names which bundle accessor and which tau index each field reads — the reducer is mechanical relative to that contract. In particular: `projected_y`, `forecast_y`, and `forecast_bands` slice per-Cohort FC surfaces at `fe.saturation_tau`; `completeness` reads the per-Cohort variant of the existing `_runtime_completeness` object at `eval_age`; `layer` uses the extracted shared layer helper; `latency_bands` per band tau use the evidence-vs-forecast split based on `eval_age[i] ≥ band_tau`. Cohort_maturity rows do not carry `layer` or per-Cohort `completeness` fields today; this work does not change that.

Skipped-Cohort rows in active mode are emitted with snapshot-derived observed fields populated and projection fields null, per the contract. The date reducer does not bind evidence, condition primitives, choose priors, recompute carrier state, or introduce any per-Cohort posterior. It is a strict readout of the existing bundle. Where the bundle cannot project (degraded runtime), the reducer emits null projection fields with explicit `_projection_provenance` rather than substituting any other machinery.

Phase 3 still does not change daily-conversions response behaviour, because the new daily-conversions row builder is not yet wired in.

Phase 3 is complete when:

- Existing cohort-maturity outside-in tests pass unchanged through the extracted projection-bundle path.
- Date-reducer unit tests over mock bundles pass for every field in the field contract: observed fields, `projected_y`, `forecast_y`, `forecast_bands`, `completeness`, `layer`, `latency_bands`, `cf_mode`, `cf_reason`, and `promoted_source`.
- Date-reducer tests cover at least: identity/window immature Cohort, active Cohort, multi-hop subject, skipped active Cohort, band tau above saturation, and all-NaN FC rate draws.
- Cross-reducer tests prove single-Cohort date/tau agreement at `fe.saturation_tau` and multi-Cohort mass-first aggregation from the same per-Cohort arrays.
- A static check proves `api_handlers.py` still uses the legacy daily-conversions enrichment in Phase 3; the date reducer is not production-wired yet.

### Phase 4 — Wire into daily conversions and retire the legacy path

Replace the daily-conversions enrichment block in `api_handlers.py` with a single call into the new projection-bundle builder plus date reducer. Delete:

- the local imports of `compute_forecast_trajectory` and `CohortEvidence` inside the daily-conversions branch;
- the ad hoc `_engine_cohorts`, `_row_map`, and `_cohort_real_ages` construction whose only purpose is to drive `compute_forecast_trajectory`;
- the main `_sweep` trajectory call;
- the per-latency-band `_band_cohorts` construction and `_band_sweep` call;
- the daily-conversions `annotate_rows` fallback block (already a silent no-op for projection fields under a known field-name mismatch);
- comments that describe daily conversions as a surviving legacy trajectory-engine consumer.

Rewrite, do not preserve, any test whose only purpose is to bless `compute_forecast_trajectory` as the daily-conversions enrichment mechanism. Keep the semantic assertions; point them at the runtime-backed projection.

Keep:

- `derive_daily_conversions` and its observed-delta tests, because the calendar-date `data` series remains observed-only and continues to come from snapshot rows.
- FE normalisation of `rate_by_cohort` fields in `graphComputeClient.ts`.
- `compute_forecast_trajectory` itself, because `surprise_gauge` remains outside this plan.
- `annotate_rows` generally, because other legacy paths still use it; only the daily-conversions fallback is retired here.
- `cohort_y_at_age`, because the latency-band evidence side reads it. (The bundle already carries per-Cohort observed `y_at_age` in `engine_cohorts[i].obs_y[tau]`; the FE field `cohort_y_at_age` is preserved as the response-shape contract, populated by the date reducer where applicable.)

Phase 4 is complete when:

- the phase 1 invariant suite passes against the runtime-backed daily-conversions path;
- every assertion that was marked expected-fail in phase 1b for legacy-gap reasons now passes (the cutover is required to clear those);
- no assertion that passed against legacy now regresses;
- a static search shows no daily-conversions call to `compute_forecast_trajectory` and no daily-conversions fallback to `annotate_rows`.
- daily-conversions outside-in tests prove the public response still contains `data`, `rate_by_cohort`, `cohort_y_at_age`, `total_conversions`, `date_range`, `cf_mode`, `cf_reason`, and `promoted_source` where applicable.
- `test_conditioned_forecast_parity.py::TestPhase4AsatVisibility::test_daily_conversions_boundary_shift` has its xfail removed or its contract deliberately updated in this plan.
- Focused response-normalisation tests prove `graphComputeClient.ts` still preserves `forecast_y`, `projected_y`, `forecast_bands`, and `latency_bands` from `rate_by_cohort`.

### Phase 5 — Remaining Consumer Decisions And Legacy-Engine Migration

Phase 5 is no longer "make every chart use the date reducer". The FC work makes the boundary clearer:

- daily conversions needs the date reducer from Phases 2-4;
- `surprise_gauge` still needs a real migration off the legacy trajectory engine;
- `conversion_funnel`, `bridge_view`, and `conversion_rate` need explicit decisions or regression coverage, but they are not hidden prerequisites for the daily-conversions cutover.

The work splits into actual migrations (where a legacy call still exists), hold-out reducer decisions, and verification of display-mode assumptions that changed under the CF/FC row mapping.

The state today, audited by static reads of the relevant modules:

- `surprise_gauge` ([api_handlers.py:130+](graph-editor/lib/api_handlers.py#L130)) calls `compute_forecast_trajectory` directly. After phase 4 it is the **only** remaining public-path consumer of the legacy trajectory engine. Its own docstring records this and names migration as the precondition for deleting the engine.
- `conversion_funnel` ([runners.py:1519](graph-editor/lib/runner/runners.py#L1519)) consumes a scoped `_whole_graph_cf` response and then runs `funnel_engine`. It is not a legacy trajectory-engine caller, but `funnel_engine` remains a hold-out `ΣY / ΣX` reducer and has its own F/E/E+F display contract.
- `bridge_view` ([runners.py:365](graph-editor/lib/runner/runners.py#L365)) does not call backend CF directly. Its Reach-decomposition arithmetic reads probabilities from the FE-supplied scenario graph. The old e2e xfail is not really a "shared runtime" issue; it is a display-surface issue because `p.mean` is now canonical/blended and invariant across visibility modes.
- `conversion_rate` ([conversion_rate_derivation.py](graph-editor/lib/runner/conversion_rate_derivation.py)) is observed-only with epistemic bands resolved from `epistemic_bands.resolve_rate_bands`. It does not call backend CF and does not handle latency edges (gated out per doc 49 §B.2). A CF extension would be a new bin reducer over the same per-Cohort FC arrays, not a side effect of daily conversions.

Phase 5 therefore comprises:

#### Phase 5a — `surprise_gauge` migration off the legacy trajectory engine

Replace the `compute_forecast_trajectory` call in `surprise_gauge` with reads from `ResolvedCFRuntime`. The two scalar variables the gauge computes (`p` and `completeness`, both projected as z-scores from unconditioned vs conditioned means) are sourced from runtime-owned objects:

- The **conditioned** posterior moments come from `runtime.public_moments` and the per-Cohort completeness exposed for daily-conversions in phase 2.
- The **unconditioned** moments come from the unconditioned `predictive` overlay already exposed at `runtime.unconditioned_overlays['predictive']` (see `ResolvedCFRuntime.unconditioned_overlays` in [cohort_forecast_v3.py:907](graph-editor/lib/runner/cohort_forecast_v3.py#L907)). This is the runtime-owned prior-only overlay object, not F mode and not the optional `model_curve_*` display overlay. Reusing it for surprise_gauge does not introduce a new unconditioned object.

The gauge is a scalar projection, not a row reducer, so this migration adds no new date/bin reducer. It removes the last public-path consumer of `compute_forecast_trajectory`. Note: `cohort_forecast_v3.py` still imports `CohortEvidence` from `forecast_state` as a data-container dataclass; phase 5a does not delete `forecast_state` or its symbols. Deletion happens in phase 7 after the v1/v2 cohort-maturity paths have been retired in phase 6 and the residual consumers identified.

The variable definitions for `surprise_gauge` (`p`, `completeness`, the z-score formula, the zone classification thresholds in `classify_zone`) are the existing definitions in `api_handlers.py` and are not redefined by this work. Phase 5a is a substitution of the data source, not a redesign of the gauge.

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

### Phase 5 acceptance

Phase 5 is complete when:

- `surprise_gauge` emits its two variables from runtime-owned objects (no `compute_forecast_trajectory` call remains in `api_handlers.py` outside of explicitly retained test paths) and its outside-in tests pass;
- `conversion_funnel` outside-in tests pass against the post-refactor CF response / funnel display contract (no funnel code changes unless a regression is found);
- `bridge_view` decision is recorded in this plan; if direct-CF was chosen, the migration is shipped with tests;
- `conversion_rate` decision is recorded in this plan; if in-scope was chosen, the bin reducer is shipped with phase-1-style blind tests; otherwise the deferral note is recorded with a pointer to doc 49 Phase 3 as the next home.
- the Phase 5 xfail/fixme ledger entries for `surprise_gauge`, `conversion_funnel`, `bridge_view`, and `conversion_rate` are all either passing, rewritten with replacement coverage, or explicitly moved to a documented non-73q follow-up.

### Temporary xfail ledger for pre-73q / companion consumers

The following existing tests are marked `xfail` / `fixme` while 73q or its companion consumer decisions are incomplete. This is intentional skip debt, not closure: each marker must be re-run and either rewritten against the shared projection-bundle contract, converted to a passing test, or retired with replacement coverage named.

- `test_doc56_phase0_behaviours.py::test_lag_fit_and_surprise_gauge_share_downstream_temporal_mode_split` — currently xfail-strict pending Phase 5a; absorbed into the Phase 1d retirement of `test_doc56_phase0_behaviours.py`. Rewritten in Phase 5a against the runtime-backed `surprise_gauge` as a Tier 3 cross-consumer test or as a Tier 4 outside-in case; the doc-56 file is then deleted with its remaining six tests reassigned per the Phase 1d coverage table.
- `test_funnel_contract.py::TestF4FModeMatchesPathProductOfPromotedMeans::test_f_median_matches_path_product_of_evidence_means` — revisit during Phase 5b. It must either be rewritten against the post-FC `conversion_funnel` outside-in contract or retired in favour of the Phase 5b tests. Its old "73q graph projections" reason is stale; this is a funnel display/reducer contract question.
- `test_selected_cohort_pop_d_distribution.py::test_per_source_day_forward_fill_preserves_monotonicity_under_sparse` and `test_selected_cohort_pop_d_distribution.py::test_m_select_construction_for_multi_hop_downstream_node` — revisit during Phases 2-3. They must be rewritten if their low-level M-select/Y-prefix assertions still express the shared projection-bundle contract after per-Cohort FC arrays and accessors are introduced; otherwise retire them with the replacement coverage named.
- `graph-editor/e2e/shareLiveChart.spec.ts::live share (conserve-mass fixture) produces distinct scenario graphs + non-empty inbound-n (regression)` — revisit during Phase 5c (`bridge_view` decision). The assertion checks that the two scenarios on the analyze request differ on `edge.p.mean` for `switch-registered-to-switch-success` when visibility_mode is `'e'` vs `'f'`. That divergence relied on the pre-73q semantic where `p.mean` was overwritten from `p.evidence.mean` or `p.forecast.mean` according to visibility_mode. Under current semantics `p.mean` is canonical/blended and invariant across visibility modes; visibility-mode divergence now lives in display-layer projections. If bridge remains graph-state-driven, rewrite the test to assert the chosen display-level discriminator. If bridge becomes display-surface-driven, rewrite it against the new bridge output.

73q core is not complete until the daily-conversions and projection-bundle markers above have been cleared. Phase 5 is not complete until the companion funnel/bridge/surprise/conversion-rate markers have likewise been converted, rewritten, or removed with explicit replacement coverage named.

### Phase 6 — Retire cohort_maturity v1 and v2

The legacy chart paths `cohort_maturity_v1` and `cohort_maturity_v2` are independent of daily-conversions but block phase 7's cleanup sweep because their handlers, modules, registries, and tests still reference symbols phase 7 needs to delete. Phase 6 retires them as a self-contained chunk.

Removal scope, audited by static reads:

- **Backend handlers and dispatch.** Delete `_handle_cohort_maturity_v2` and the `cohort_maturity_v2` branch at [api_handlers.py:652-653](graph-editor/lib/api_handlers.py#L652-L653). Delete the `cohort_maturity_v1` branch at [api_handlers.py:654-655](graph-editor/lib/api_handlers.py#L654-L655) and remove the `cohort_maturity_v1` membership from `_is_cohort_maturity` at [api_handlers.py:2551](graph-editor/lib/api_handlers.py#L2551). The `_handle_snapshot_analyze_subjects` function survives because non-v1 analyses still route through it; only the v1-specific logic inside it is removed.
- **Subject-resolution mappings.** Delete the `cohort_maturity_v1` and `cohort_maturity_v2` entries in `analysis_subject_resolution.py` (scope-rule and read-mode tables at lines 73-74 and 88-89).
- **Frontend registries.** Delete the `cohort_maturity_v1` and `cohort_maturity_v2` entries from [analysisTypes.ts](graph-editor/src/components/panels/analysisTypes.ts), [analysisTypeResolutionService.ts](graph-editor/src/services/analysisTypeResolutionService.ts), and the alias mappings at [AnalysisChartContainer.tsx:254-255](graph-editor/src/components/charts/AnalysisChartContainer.tsx#L254-L255). Update [snapshotBootTrace.ts:104](graph-editor/src/lib/snapshotBootTrace.ts#L104) to drop the v1/v2 disjuncts.
- **Span-evidence emit labels.** [span_evidence.py:45,61,188,210](graph-editor/lib/runner/span_evidence.py) emits `analysis_type: 'cohort_maturity_v2'` in its diagnostic output. Either retarget those to `'cohort_maturity'` or remove the field if it's unused; choose by inspecting the consumer.
- **Tests.** Delete tests that exclusively cover v1 or v2 surfaces (e.g. `analysisRequestContract.test.ts:150-151,169` lines pinning the v2 contract). Tests that cover behaviour shared with v3 are retargeted to v3 if not already present elsewhere.

Phase 6 is purely a deletion plus a retargeting of three diagnostic labels. The chart family observable from the FE collapses from `cohort_maturity` / `cohort_maturity_v1` / `cohort_maturity_v2` to a single `cohort_maturity`. No migration of behaviour: v1 and v2 charts have been superseded by v3 since 73n; this just removes the dead routes.

Phase 6 acceptance:

- A static search shows zero references to `cohort_maturity_v1` or `cohort_maturity_v2` in production code (BE Python, FE TypeScript, BE / FE registries).
- The v3 cohort_maturity outside-in tests still pass unchanged.
- The phase 1 daily-conversions invariant suite still passes (it does not depend on v1/v2 paths).
- No new dead-code references appear: imports that became unused are also removed.

### Phase 7 — Cleanup sweep

Phase 7 is the cleanup atom that becomes possible once phases 4, 5, and 6 are landed. It is a deletion-and-quietening sweep. Every item below is justified by an audit of static references; nothing is deleted speculatively.

#### Modules and symbols deletable post phases 4–6

- **`runner/forecast_state.py` symbols.**
  - `compute_forecast_trajectory` and its supporting helpers (`build_node_arrival_cache`, `_resolve_edge_p`, `_compute_completeness_at_age` if no internal residual remains): no public callers after phases 4 and 5a; no v1/v2 callers after phase 6.
  - `_warn_legacy_pmean_carrier`: still imported at [path_runner.py:113](graph-editor/lib/runner/path_runner.py#L113) and [graph_builder.py:209](graph-editor/lib/runner/graph_builder.py#L209). Phase 7 inspects each call site: if the warning fires for a code path that no longer exists, delete the warning and its call sites; if the warning still applies to live code, keep it and rehome to a non-legacy module.
  - `CohortEvidence`: still imported by `cohort_forecast_v3.py:4267` as a data container. Phase 7 either rehomes the dataclass to a non-legacy module (e.g. into `cohort_forecast_v3.py` directly or into a new `runner/cohort_evidence.py`) or shrinks `forecast_state.py` down to just this dataclass.
  - The remaining `forecast_state.py` is deleted only when every symbol is either deleted or rehomed and the file is empty.

- **`runner/cohort_forecast.py` (v1, 1526 LOC).** Used only by `cohort_forecast_v2.py` and the v1 dispatch path; both gone after phase 6. Deleted whole.

- **`runner/cohort_forecast_v2.py` (1210 LOC).** Used only by `_handle_cohort_maturity_v2`; gone after phase 6. Deleted whole.

- **`runner/forecast_application.py` symbols.**
  - `annotate_rows` and `annotate_data_point`: callers at [api_handlers.py:1210, 2547, 3312](graph-editor/lib/api_handlers.py) sit in v1/v2 chart paths that go away in phase 6. After phase 6 there are no callers; both functions are deleted.
  - `compute_completeness`: still used by [_append_synthetic_future_frames@api_handlers.py:2400](graph-editor/lib/api_handlers.py#L2400), which is called by both the v1 path (gone) and the v3 path (alive). The v3 path's residual model-derived completeness call is a legitimate item but **not** in 73q's scope: it is named here as a follow-up atom (migrate `_append_synthetic_future_frames` to read runtime-owned completeness instead of model-CDF). `compute_completeness` and `_append_synthetic_future_frames` survive phase 7.

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

- the phase 1 invariant suite (Tier 4 outside-in) is calibrated and committed;
- the three fast structural tiers (Tier 1 projection-bundle algebra unit tests; Tier 2 projection-bundle integration tests; Tier 3 cross-consumer projection tests via shared bundle) are in place as separate test files, each running in its named cost envelope on CI, with the assertions listed in Phase 1c all green at each tier's landing phase;
- `test_doc56_phase0_behaviours.py` is deleted, with each of its seven tests reassigned to its new home per the Phase 1d coverage table or deleted with explicit rationale; a static search shows no remaining references to the seven test names;
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
