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
| **Computes** | Probability at each stage (funnel drop-off). Does NOT enforce waypoint ordering — all paths counted. |
| **Dimensions** | scenario_id, stage |
| **Metrics** | probability, conversion_rate (δ between stages), cost |
| **Chart kinds** | funnel, bridge, bar_grouped, table |

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
| **Computes** | Edge summary: probability, latency distribution, evidence quality, model vars (analytic, analytic_be, bayesian), uncertainty, onset |
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
| **Computes** | Conversion counts by calendar date |
| **Dimensions** | date |
| **Metrics** | conversions, cumulative_conversions |
| **Chart kinds** | daily_conversions, table, time_series |
| **Snapshot** | readMode: raw_snapshots |

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
