# Analysis Types Catalogue

**Date**: 2-Apr-26
**Purpose**: What each analysis type computes, its inputs, outputs, and chart
kinds. Companion to `ANALYSIS_RETURN_SCHEMA.md` (output container spec) and
`adding-analysis-types.md` (code checklist for registration).

**Registration source of truth**: `graph-editor/src/components/panels/analysisTypes.ts`
and the predicate-driven routing in `analysis_types.yaml`.

---

## Routing Model

Analysis type is determined by the DSL pattern — number of nodes, presence
of from/to/visited/visitedAny, sibling relationships, and scenario count.
First matching predicate wins. The `injectLocalAnalysisTypes()` function
adds info-card types (node_info, edge_info, surprise_gauge) based on graph
structure.

---

## Local Compute Types (Frontend Only)

These compute entirely from in-memory graph data.

### graph_overview

| | |
|---|---|
| **Selection** | None (whole graph) |
| **Computes** | All entry nodes → all absorbing nodes: probability, cost |
| **Dimensions** | scenario_id, outcome (absorbing node) |
| **Metrics** | probability (%), expected_cost_gbp, expected_labour_cost |
| **Chart kinds** | bar_grouped, pie, table |
| **Notes** | Default when no selection; also available as explicit option |

### from_node_outcomes

| | |
|---|---|
| **Selection** | Exactly 1 node via `from(A)` |
| **Computes** | This node → all absorbing nodes |
| **Dimensions** | scenario_id, outcome |
| **Metrics** | probability, expected_cost_gbp, expected_labour_cost |
| **Chart kinds** | bar_grouped, table |

### to_node_reach

| | |
|---|---|
| **Selection** | Exactly 1 node via `to(B)`, scenario_count ≠ 2 |
| **Computes** | All entry nodes → this node (reach probability) |
| **Dimensions** | scenario_id |
| **Metrics** | probability, expected_cost_gbp, expected_labour_cost |
| **Chart kinds** | bar, table |

### bridge_view

| | |
|---|---|
| **Selection** | Exactly 1 node via `to(B)` + exactly 2 visible scenarios |
| **Computes** | Decomposes reach probability difference between two scenarios |
| **Dimensions** | scenario_id |
| **Metrics** | probability, probability_delta, cost metrics |
| **Chart kinds** | bridge, bridge_horizontal, table |
| **Special** | Custom minimised renderer (144×48 px, horizontal arrow + delta label) |

### path_through

| | |
|---|---|
| **Selection** | Exactly 1 node via `visited(A)` (no from/to) |
| **Computes** | Probability of paths passing through this node |
| **Dimensions** | scenario_id, outcome |
| **Metrics** | probability, cost metrics |
| **Chart kinds** | bar, table |

### path_between

| | |
|---|---|
| **Selection** | Exactly 2 nodes via `from(A).to(B)` |
| **Computes** | Probability and cost from start to end (all paths) |
| **Dimensions** | scenario_id |
| **Metrics** | probability, expected_cost_gbp, expected_labour_cost |
| **Chart kinds** | funnel, bridge, bar_grouped, table |

### conversion_funnel

| | |
|---|---|
| **Selection** | 3+ nodes via `from(A).to(B).visited(C,D,...)` |
| **Computes** | Per-stage probability plus hi/lo bands. Calls the conditioned-forecast (CF) machinery once per scenario with the whole graph, then extracts the subgraph for the selected path. Per-edge epistemic and predictive σ are blended by the completeness-weighted variance mixture (σ²_total = c·σ²_epi + (1−c)·σ²_pred), so bands widen naturally at low completeness and tighten as evidence matures — no special-case branching is required in the funnel itself. Does NOT enforce waypoint ordering — all paths counted. |
| **Dimensions** | scenario_id, stage |
| **Metrics** | probability (stage value), probability_lo / probability_hi (band), conversion_rate (δ between stages), cost |
| **Chart kinds** | funnel, bridge, bar_grouped, table |
| **Runner** | `run_conversion_funnel` in `lib/runner/runners.py` |
| **Snapshot linkage** | FE `snapshotContract` declared (scopeRule=`funnel_path`, readMode=`cohort_maturity`) so the request carries `candidate_regimes_by_edge` — CF needs regime identity to read snapshot evidence. Deliberately **NOT** in BE `ANALYSIS_TYPE_SCOPE_RULES`, so the dispatcher routes to the standard runner rather than the snapshot-subject handler. See §"Compute-stage asymmetry" below. |

### constrained_path

| | |
|---|---|
| **Selection** | 3+ nodes via `from(A).to(B).visited(C,D,...)` |
| **Computes** | Paths through **all** waypoints in order (pruned). User must explicitly choose over conversion_funnel. |
| **Dimensions** | scenario_id, stage |
| **Metrics** | probability, cost metrics |
| **Chart kinds** | funnel, bridge, bar_grouped, table |

### outcome_comparison

| | |
|---|---|
| **Selection** | 2+ nodes via `visitedAny(A,B,...)`, not siblings |
| **Computes** | Compare reach probabilities across independent nodes |
| **Dimensions** | scenario_id, outcome |
| **Metrics** | probability, cost metrics |
| **Chart kinds** | bar_grouped, pie, table |
| **Snapshot** | Yes (raw_snapshots, perScenario) |

### branch_comparison

| | |
|---|---|
| **Selection** | 2+ sibling nodes via `visitedAny(A,B,...)` |
| **Computes** | Traffic split across parallel branches (siblings) |
| **Dimensions** | scenario_id, branch |
| **Metrics** | probability, count, cost metrics |
| **Chart kinds** | bar_grouped, pie, table |
| **Snapshot** | Yes (raw_snapshots, perScenario) |
| **Also triggered** | Single node with multiple children (auto-analyses immediate children) |

### branches_from_start

| | |
|---|---|
| **Selection** | `from(A)` + `visitedAny(B,C,...)` |
| **Computes** | Branch outcomes from a starting point |
| **Dimensions** | scenario_id, branch |
| **Metrics** | probability, cost metrics |
| **Chart kinds** | bar_grouped, pie, table, time_series |

### multi_outcome_comparison

| | |
|---|---|
| **Selection** | 3+ non-sibling nodes via `visitedAny(A,B,C,...)` |
| **Computes** | Compare reach probabilities across 3+ independent nodes |
| **Dimensions** | scenario_id, outcome |
| **Metrics** | probability, cost metrics |
| **Chart kinds** | bar_grouped, pie, table |
| **Snapshot** | Yes |
| **Runner** | Reuses `end_comparison_runner` |

### multi_branch_comparison

| | |
|---|---|
| **Selection** | 3+ sibling nodes via `visitedAny(A,B,C,...)` |
| **Computes** | Traffic split across 3+ parallel branches |
| **Dimensions** | scenario_id, branch |
| **Metrics** | probability, count, cost metrics |
| **Chart kinds** | bar_grouped, pie, table |
| **Runner** | Reuses `branch_comparison_runner` |

### multi_waypoint

| | |
|---|---|
| **Selection** | 2+ nodes via `visited(A).visited(B)` (no from/to) |
| **Computes** | Path probability through multiple waypoints |
| **Dimensions** | scenario_id, waypoint |
| **Metrics** | probability |
| **Chart kinds** | bar_grouped, table |

### general_selection

| | |
|---|---|
| **Selection** | Any (fallback) |
| **Computes** | General statistics for selected nodes |
| **Dimensions** | scenario_id, node |
| **Metrics** | probability, reach_prob, cost metrics |
| **Chart kinds** | bar_grouped, table |

---

## Info Card Types (Injected by `injectLocalAnalysisTypes`)

### node_info

| | |
|---|---|
| **Selection** | Exactly 1 node (any DSL pattern) |
| **Computes** | Curated summary: metadata, cost, reach, predecessors/successors |
| **View** | Cards only (overview, structure) |
| **Chart kinds** | info |

### edge_info

| | |
|---|---|
| **Selection** | `from(A).to(B)` where direct edge exists, no visited nodes |
| **Computes** | Edge summary: probability, latency distribution, evidence quality, model vars (analytic, bayesian), uncertainty, onset |
| **View** | Cards only (overview, latency, evidence, forecast, depth, diagnostics) |
| **Chart kinds** | info |

### surprise_gauge

| | |
|---|---|
| **Selection** | Edge with model_vars (probability.mean and stdev > 0) |
| **Computes** | Bayesian surprise: compares observed evidence against posterior. Returns quantile, zone (on-target / surprising / very surprising) per variable (p, mu, sigma). |
| **Chart kinds** | surprise_gauge, table |
| **Special** | Custom minimised renderer (32×32 px coloured dot). Display setting `surprise_var` selects variable. |
| **Notes** | Phase 1 uses parameter file scalars; Phase 2 adds snapshot DB queries for onset evidence. |

---

## Snapshot-Based Types (Require Snapshot Database)

These require snapshot data and route to the Python backend via
`_handle_snapshot_analyze_subjects` in `api_handlers.py`.

### lag_histogram

| | |
|---|---|
| **Selection** | Path via `from(A).to(B)` with `window()` or `cohort()` |
| **Computes** | Histogram of conversion lags (time from A to B) |
| **Dimensions** | lag_days |
| **Metrics** | conversions (count per bin), pct |
| **Chart kinds** | histogram, table |
| **Snapshot** | readMode: raw_snapshots |
| **Notes** | Computes Y deltas per (anchor_day, slice_key) independently to avoid mixing slices. |

### daily_conversions

| | |
|---|---|
| **Selection** | Path via `from(A).to(B)` with `window()` or `cohort()` |
| **Computes** | Conversion counts by calendar date, with forecast engine integration (G.1b) |
| **Dimensions** | date |
| **Metrics** | conversions, cumulative_conversions, evidence_y, forecast_y, projected_y, completeness |
| **Chart kinds** | daily_conversions, table, time_series |
| **Snapshot** | readMode: raw_snapshots |
| **Engine** | Per-cohort coordinate B via `compute_forecast_trajectory` with `CohortEvidence.eval_age` set to maturity τ. Reads `cohort_evals` from `ForecastTrajectory`. Fallback to legacy `annotate_rows` if engine fails. |
| **Display settings** | `show_bars`, `show_rates`, `smooth_lines`, `moving_avg`, `aggregate`, `bayes_band_level`, `show_latency_bands` |
| **Chart features** | 3-layer stacked bars (E/F/N), dual rate lines with epoch A/B/forecast styling, forecast dispersion bands (MC draws), optional latency bands at 25/50/75 percentile maturity ages. Latency bands only for latency edges. |

### cohort_maturity

| | |
|---|---|
| **Selection** | Path via `from(A).to(B)` with `window()` or `cohort()` |
| **Computes** | How conversion rates evolved over time (maturity curves). When model params and observed data exist, appends synthetic future frames extending from last snapshot to t95 horizon. |
| **Dimensions** | snapshot_date, anchor_day |
| **Metrics** | rate (Y/x), completeness, evidence_y, forecast_y, projected_y |
| **Chart kinds** | cohort_maturity, table |
| **Snapshot** | readMode: cohort_maturity (sweep-based) |

### lag_fit

| | |
|---|---|
| **Selection** | Path via `from(A).to(B)` with `window()` or `cohort()` |
| **Computes** | Fitted log-normal distribution vs observed cohort completeness. Assesses model fit quality. |
| **Dimensions** | cohort_age_days |
| **Metrics** | observed_completeness, model_completeness, confidence_lower, confidence_upper |
| **Chart kinds** | lag_fit, table |
| **Snapshot** | readMode: sweep_simple |
| **Output** | Also returns fitted_params: mu, sigma, onset_delta_days |

### conversion_rate

| | |
|---|---|
| **Selection** | Path via `from(A).to(B)` — non-latency edges only (see gate below) |
| **Computes** | Per-bin observed conversion rate (k/n per day/week/month) with a model-rate band derived from the edge's promoted source (doc 49 Part B). |
| **Dimensions** | bin_start, scenario_id, subject_id |
| **Metrics** | rate, x (cohort size), y (conversions), plus per-bin epistemic block (hdi_lower/upper, posterior_mean, evidence_grade, fitted_at, source_slice, source_model) |
| **Chart kinds** | conversion_rate, table |
| **Snapshot** | readMode: raw_snapshots, scopeRule: funnel_path |
| **Band resolution** | Per bin: if promoted source is `bayesian` AND `fit_history` has an entry on-or-before the bin date, use that entry's alpha/beta (with sibling-slice fallback — see gotchas). Otherwise use the edge's current promoted alpha/beta from `resolve_model_params`. Fall-back chain inside the resolver: posterior cohort_alpha/beta → posterior alpha/beta → analytic-mirror prob_cohort_alpha/beta → analytic-mirror prob_alpha/beta. When none of those are populated (no Bayes posterior and FE-topo moment-match infeasible), the resolver returns α=β=0 — the bin renders midline only, no band. Doc 73f F16 removed the previous κ=200 fixed-prior fallback. |
| **Gate** | Latency edges (those with `latency.latency_parameter: true`) are rejected per-subject with a "not yet supported" error. Doc 49 Phase 3 addresses latency edges separately. Gate checks the authoritative flag, not `sigma > 0` — promoted sigma/mu appears on non-latency edges too (see [KNOWN_ANTI_PATTERNS.md](./KNOWN_ANTI_PATTERNS.md)). |
| **Display settings** | `bin_size`, `show_epistemic_bands`, `show_model_midpoint` + common font/axis/legend/label/tooltip/animation/reference_line |
| **Chart features** | Sized scatter (circle area ∝ cohort n), dashed model-rate line (filled forward/backward across sparse fit_history), non-striated HDI band, size legend via graphic in top-right. Multi-scenario supported via the standard concept+swatch legend pattern. |
| **Blind test** | [graph-ops/scripts/conversion-rate-blind-test.sh](../../../graph-ops/scripts/conversion-rate-blind-test.sh) — 8 invariants on `synth-mirror-4step`. |

### bayes_fit (Internal Only)

| | |
|---|---|
| **Selection** | N/A (internal use) |
| **Computes** | Generates snapshot subjects for the Bayes compiler's evidence assembly phase |
| **Snapshot** | readMode: sweep_simple, scopeRule: all_graph_parameters |
| **Notes** | Never appears in user-facing selectors. Used by `useBayesTrigger()`. |

---

## Design Patterns

**Predicate-driven routing**: DSL pattern determines analysis type. First
match in the ordered predicate list wins.

**Declarative output**: All analyses return structured results with a
`semantics` block declaring dimensions, metrics, and chart specs. Renderers
never special-case by analysis type.

**Multi-scenario**: FE always provides `all_scenarios`; runners compute per
scenario and merge with `scenario_id` dimension.

**Two-phase computation**: Phase 1 (local) runs immediately on DSL change.
Phase 2+ (snapshot) supplements with DB queries triggered via chart
computation hooks.

---

## Compute-stage asymmetry (conversion_funnel)

`conversion_funnel` is the only analysis type that declares an FE
`snapshotContract` but is **intentionally absent** from the BE's
`ANALYSIS_TYPE_SCOPE_RULES` / `ANALYSIS_TYPE_READ_MODES` tables in
`lib/analysis_subject_resolution.py`. This cross-layer asymmetry is
load-bearing — neither side can be "aligned" with the other without
breaking the analysis.

**Why the FE side carries a contract**: the runner calls the CF
machinery, which reads snapshot evidence internally. CF needs regime
identity per edge to select the right snapshot rows. The FE populates
`candidate_regimes_by_edge` in `analysisComputePreparationService.ts`
inside `if (params.needsSnapshots)` — and `needsSnapshots` is derived
from `!!snapshotContract`. Without the contract, regimes are absent
from the request and CF falls back to the unconditioned prior
(`conditioned: false`, no evidence applied).

**Why the BE side must omit it**: the dispatcher in
`lib/api_handlers.py:521` checks `analysis_type in
ANALYSIS_TYPE_SCOPE_RULES`. If present, the request is routed to
`_handle_snapshot_analyze_subjects`, which validates
`snapshot_subjects[].core_hash`. The funnel's request payload is
compute-shaped, not snapshot-envelope-shaped, so that validator
rejects with `"snapshot_subjects[].core_hash required
(scenario=current, subject_id=...)"`. Omitting the type from the
table routes the request to the standard runner, which forwards
`candidate_regimes_by_edge` to `run_conversion_funnel` and lets CF
handle the snapshot read.

**Three signals `snapshotContract` implicitly conflates**:

1. **Request-build populates `candidate_regimes_by_edge`** — FE-side,
   gated on `!!snapshotContract`.
2. **BE dispatches via the snapshot-subject handler** — BE-side, gated
   on `ANALYSIS_TYPE_SCOPE_RULES` membership.
3. **Response is normalised as a snapshot envelope** — follows
   mechanically from (2), because the FE retry/normalisation logic
   keys on `result.metadata.source === 'snapshot_db'`, which is
   stamped only by the snapshot handler.

For every existing snapshot-envelope type (daily_conversions,
cohort_maturity, etc.) all three co-occur. For `conversion_funnel`
only (1) is true; (2) is false, so (3) falls away. If more
compute-stage types emerge that need this asymmetric treatment,
consider splitting `snapshotContract` into two explicit signals
(`populatesRegimes` vs `snapshotResponseShape`) rather than relying on
the cross-layer asymmetry. The current shape is the minimum-viable fix
and costs ~15 lines; a flag split would touch ~8 FE files.
