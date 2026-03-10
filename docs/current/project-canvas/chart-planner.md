# Chart Planner

## Purpose

The chart planner is a small decision layer that sits between:

- raw analysis results (`semantics`, metrics, dimensions, chart recommendations)
- user display settings / chart overrides
- concrete chart builders (`analysisEChartsService.ts`)

Its job is to choose the **most legible default presentation** for a result while still allowing users to specialise the display when they want to.

Core principle:

> **Automate, degrade gracefully, allow override.**

That means:

1. infer a sensible default
2. avoid invalid or confusing combinations automatically
3. fall back to a simpler valid view when needed
4. still respect explicit user overrides where they remain meaningful

## Why this exists

Different chart families hit the same visual reasoning constraints repeatedly:

- multiple scenarios vs time-series on the x-axis
- `f` / `e` / `f+e` visibility modes
- dense legends and labels
- pie charts that only make sense for single-scenario views
- stacked charts that need different metric bases (`p`, `p.e`, `p.f`, `k`)

If each chart builder solves these ad hoc, the logic drifts. The planner centralises those decisions.

## Initial scope

The initial planner in `graph-editor/src/services/chartDisplayPlanningService.ts` currently reasons about:

- time-series vs scenario-axis arbitration
- multi-scenario collapse for time-series kinds
- FE split eligibility (`f+e` with both evidence + forecast metrics available)
- metric basis selection (`absolute_k` vs probability)

It is intentionally small and conservative. It should grow incrementally as more chart kinds adopt it.

## Planner output

The planner returns an effective display plan, including:

- `effectiveChartKind`
- `xAxisMode`
  - `time`
  - `scenario`
  - `category`
  - `stage`
- `scenarioIdsToRender`
- `scenarioSelectionMode`
  - `all_visible`
  - `current_only`
  - `explicit_single`
- `metricBasis`
  - `blended_probability`
  - `forecast_probability`
  - `evidence_probability`
  - `absolute_k`
- `feRenderingMode`
  - `none`
  - `blended_single_series`
  - `split_fe_stack`
- `fallbackReasons`

Builders should consume the effective plan rather than embedding their own one-off arbitration logic.

## Reusable rules

### 1. Axis arbitration

Only one primary comparison axis should own the x-axis at a time.

Examples:

- time-series charts: x-axis = time
- multi-scenario comparison charts: x-axis = scenario
- waterfall/bridge charts: x-axis = stage/category

Avoid charts that try to put both scenario progression and time progression on the same x-axis. They become hard to parse quickly.

### 2. Scenario collapse

If a chart kind is time-series and multiple scenarios are visible:

- default to the last/current visible scenario
- keep the x-axis as time
- surface this as a graceful fallback, not a hidden failure

### 3. FE decomposition

If visibility mode is `f+e` and both evidence and forecast metrics are available:

- prefer a split FE rendering
- show evidence as a solid base segment
- show forecast residual (`f−e`) as a distinct but related segment

If FE decomposition is not possible:

- fall back to a single blended series

### 4. Pie chart validity

Pie charts are only a good default when the chart is effectively single-scenario.

Rules:

- 1 visible scenario: pie may be valid
- >1 visible scenarios: prefer stack/grouped comparison instead

### 5. Density degradation

When category/series count is too high:

- hide value labels
- simplify or compact the legend
- prefer grouped/stacked bar over pie
- prefer table/cards when the visual form becomes noisy

## Existing FE precedent

The conversion funnel already uses a split FE stack pattern in `analysisEChartsService.ts`:

- evidence segment
- forecast-minus-evidence crown

That pattern should be reused for future chart types that need FE-aware rendering, especially:

- branch comparison / split-by-child
- outcome comparison
- future time-series split charts

## Branch comparison / split-by-child

`branch_comparison` is the first major target for this planner model.

Desired behaviour:

- selecting a single parent node with multiple immediate children should expose `branch_comparison`
- the same analysis may be rendered as:
  - pie (single scenario only)
  - stacked scenario comparison
  - future time-series stack

Display planning rules for this family:

- if chart kind is time-series:
  - x-axis = time
  - if multiple scenarios visible, render current/last only
- if chart kind is non-time comparison:
  - x-axis = scenario
  - render all visible scenarios
- if visibility mode is `f+e`:
  - prefer split FE stack
- if absolute mode is selected:
  - use `k` metrics, not probabilities

## Issues found in first time-series implementation

The first pass at branch-comparison time-series support exposed several important design and factoring problems. These should inform future planner work rather than being treated as one-off bugs.

### 1. Some of the implementation is reusable, some is too bespoke

Reusable pieces:

- `chartDisplayPlanningService.ts`
- comparison chart builders in `analysisEChartsService.ts`
- chart-kind persistence and recompute-key fixes
- cache-key improvements that include snapshot subject identity

Still too analysis-specific:

- `children_of_selected_node` snapshot scope rule
- branch-specific snapshot response normalisation
- complement-child derivation logic in the normaliser
- branch-specific chart-kind augmentation
- branch-specific "time_series implies snapshots" switch in the canvas compute hook

Long-term direction:

- extract a generic "snapshot comparison over time" normalisation path
- extract shared FE split helpers rather than embedding branch-specific logic
- reduce special-case analysis handling in UI selection code

### 2. Snapshot-backed time-series is strategically right but tactically heavier

For latency-aware edges, snapshot-backed derivation is the correct long-term substrate because it can support:

- cohort/date time-series
- completeness-aware `f` / `e` / `f+e` behaviour
- evidence/forecast decomposition
- future chart families beyond branch comparison

But the cost is higher:

- subject resolution is more complex
- cache identity must include subject signatures
- result normalisation is more complex than static point-estimate analyses
- sparse/missing subject rows require complement handling and graceful degradation

Conclusion:

- **Strategically**: snapshots are the right long-term direction for latency-aware comparison time-series
- **Tactically**: the current branch-comparison implementation still contains too much bespoke glue and should be generalised before many more analyses reuse it

### 3. Time-series support requires a different result shape, not just a different chart renderer

Static comparison results are shaped like:

- dimensions: `branch`, `scenario_id`
- metrics: point-estimate probabilities / counts

Time-series comparison results need:

- dimensions: `date`, `scenario_id`, `branch`
- metrics: per-date `x`, `y`, `rate`, and optionally `evidence_y`, `forecast_y`, `projected_y`, `completeness`

This means "time series support" cannot be implemented only in the frontend. The analysis must be recomputed onto a time-bucketed result shape.

### 4. Two concrete bugs we hit and what they taught us

#### 4a. Local chart-kind state was not enough

The chart header could show `Time Series` while the underlying canvas analysis object still had no persisted `chart_kind`. That meant the live compute path continued treating the chart as `bar_grouped`.

Lesson:

- chart-kind changes that affect compute shape must always persist into analysis state
- local UI-only chart-kind state is insufficient for compute-bearing chart families

#### 4b. Cached non-time-series results could mask the time-series transition

Switching from grouped comparison to time-series initially kept showing stale static branch results because:

- compute keys did not include all relevant inputs
- `GraphComputeClient` cache keys did not include snapshot subject identity
- stale point-estimate results could remain visible during the chart-kind transition

Lesson:

- cache identity must incorporate all inputs that materially change result shape
- time-series transitions should aggressively invalidate stale non-time results when necessary

#### 4c. FE split logic degraded to zero forecast crown

In time-series FE rendering, using observed `rate` as the total meant:

- evidence base = observed evidence
- total = also observed evidence
- forecast crown = `0`

Lesson:

- FE split total must use the projected total (`projected_y` or derived projected rate), not the observed evidence-only rate

#### 4d. Split-by-child can fail if only one child subject resolves

Snapshot subject resolution may yield rows for only one child branch. Without fallback logic, the chart shows only one branch even though the analysis concept is "split by child".

Lesson:

- for two-child branch splits, deriving the complement branch is often necessary for intelligible rendering
- this complement derivation should eventually become a generic comparison-time-series utility, not remain branch-specific glue

### 5. Current recommendation

Before layering many more analyses onto this pattern, prioritise refactoring toward:

1. generic snapshot-comparison normalisation
2. shared FE decomposition helpers
3. reusable complement-derivation utilities
4. clearer separation between:
   - static comparison analyses
   - snapshot-backed comparison time-series analyses

## Future chart families to bring under the planner

### Near-term

- branch comparison / split-by-child
- outcome comparison
- multi-branch comparison
- multi-outcome comparison

### Existing charts that should gradually migrate

- conversion funnel
- bridge view
- daily conversions
- cohort maturity
- lag fit

### Likely future additions

- grouped vs stacked comparison bars
- pie / donut variants
- area / stacked area time-series
- small-multiple scenario pies
- FE-aware absolute stacks
- chart-to-table fallback logic

## User override philosophy

The planner computes defaults first. User settings then specialise the result.

Examples:

- user forces pie with multiple scenarios:
  - planner should coerce to a valid comparison view
- user forces time-series while multiple scenarios are visible:
  - planner should preserve time-series and collapse to a single scenario
- user forces labels on a dense chart:
  - planner may still hide overlaps for legibility

The goal is not to let users create incomprehensible charts. It is to let them specialise within safe, intelligible bounds.

## Rollout strategy

1. add planner as a pure service with tests
2. use it for scenario/time arbitration in existing chart container code
3. migrate FE split logic into reusable helpers
4. adopt it chart family by chart family
5. only then add more aggressive automatic fallbacks

This keeps the change surface manageable while establishing a single long-term direction.
