# Latency Topological Pass Refactor – Implementation Plan

## 1. Problem Statement

The current implementation computes latency statistics (t95, completeness) per-edge in arbitrary order during fetch, then runs a separate topological pass afterwards to compute path_t95. This means completeness is calculated before path_t95 exists, so downstream edges overstate their maturity.

The design intent was: run a single topological pass that computes t95, path_t95, and path-adjusted completeness together, so downstream edges correctly reflect their effective cohort ages.


## 2. Files Involved

| File | Current Role | Change Required |
|------|--------------|-----------------|
| `graph-editor/src/services/statisticalEnhancementService.ts` | Owns `computeEdgeLatencyStats`, `computePathT95`, `computeInboundN` | Add new graph-level entry point that combines LAG stats and path_t95 in one topo pass |
| `graph-editor/src/services/fetchDataService.ts` | Calls `computeAndApplyPathT95` and `computeAndApplyInboundN` after fetch | Replace with call to the new unified topo pass |
| `graph-editor/src/services/dataOperationsService.ts` | Calls `computeEdgeLatencyStats` per-edge inside `addEvidenceAndForecastScalars` | Remove per-edge LAG recompute in main path; read completeness from graph instead |
| `graph-editor/src/services/windowAggregationService.ts` | Has `aggregateCohortData`, `aggregateLatencyStats`, `parameterValueToCohortData` | Keep as-is or move helpers to stats service; ensure stats service can import them |


## 3. Changes to `statisticalEnhancementService.ts`

### 3.1 New function: `enhanceGraphLatencies`

Location: after existing `computePathT95` function (around line 1206).

Inputs:
- `graph: Graph` – the current graph with nodes and edges
- `paramLookup: Map<string, ParameterValue[]>` – maps edge id to its fetched parameter values
- `queryDate: Date` – the "now" for computing cohort ages

Behaviour:
1. Get active latency edges using existing `getActiveEdges` helper.
2. Build adjacency and compute topological order (reuse logic from `computePathT95`).
3. Initialise `nodePathT95: Map<string, number>` with 0 for all start nodes.
4. For each edge in topo order:
   - Get `pathT95ToSource = nodePathT95.get(edge.from) ?? 0`.
   - Look up `paramValues = paramLookup.get(edgeId)`.
   - If no param values or no latency config, skip this edge.
   - Call `aggregateCohortData(paramValues, queryDate)` to get cohorts.
   - Call `aggregateLatencyStats(cohorts)` to get aggregate median/mean lag.
   - Read `maturityDays` from `edge.p.latency.maturity_days`.
   - Call `computeEdgeLatencyStats(cohorts, medianLag, meanLag, maturityDays, pathT95ToSource)`.
   - Write results to edge: `p.latency.t95`, `p.latency.completeness`, `p.latency.median_lag_days`, `p.latency.mean_lag_days`.
   - Compute `edgePathT95 = pathT95ToSource + edge.p.latency.t95`.
   - Write `edge.p.latency.path_t95 = edgePathT95`.
   - Update `nodePathT95.set(edge.to, Math.max(nodePathT95.get(edge.to) ?? 0, edgePathT95))`.
5. Return the updated graph.

### 3.2 Move cohort helpers into stats service (or import from windowAggregationService)

The following functions are needed by `enhanceGraphLatencies`:
- `aggregateCohortData` – converts ParameterValue[] to CohortData[]
- `aggregateLatencyStats` – computes weighted median/mean lag from CohortData[]
- `parameterValueToCohortData` – converts a single ParameterValue to CohortData[]

Currently in `windowAggregationService.ts`. Either:
- Option A: Import them into `statisticalEnhancementService.ts` from `windowAggregationService.ts`.
- Option B: Move them into `statisticalEnhancementService.ts` and re-export.

Option A is simpler; Option B is cleaner long-term.

### 3.3 Keep `computeEdgeLatencyStats` signature as-is

It already accepts `pathT95` as the 5th parameter (default 0). No change needed.

### 3.4 Keep `computePathT95` for other callers

`windowFetchPlannerService.ts` and `cohortRetrievalHorizon.ts` use `computePathT95` for horizon planning. Keep it available but mark it as a low-level utility; the main analysis path should use `enhanceGraphLatencies`.


## 4. Changes to `fetchDataService.ts`

### 4.1 Build param lookup after fetch

Location: inside `fetchItems`, after all items have been fetched and merged (around line 990).

Add code to:
1. Iterate over fetched items.
2. For each item that is a probability parameter with latency config, extract its edge id and the merged `ParameterValue[]`.
3. Build `paramLookup: Map<string, ParameterValue[]>`.

### 4.2 Replace `computeAndApplyPathT95` call

Location: around line 1006.

Currently:
```
if (hasLatencyItems) {
  computeAndApplyPathT95(finalGraph, setGraph, batchLogId);
}
```

Change to:
1. Import `enhanceGraphLatencies` from `statisticalEnhancementService.ts`.
2. Call `enhanceGraphLatencies(finalGraph, paramLookup, new Date())`.
3. Call `setGraph(updatedGraph)` with the result.

### 4.3 Keep `computeAndApplyInboundN` after the new call

The inbound-n pass should run after latency enhancement, so it sees updated `p.mean`, `p.latency.t95`, and `p.latency.completeness`.

No change to `computeAndApplyInboundN` itself.


## 5. Changes to `dataOperationsService.ts`

### 5.1 Remove per-edge LAG recompute in `addEvidenceAndForecastScalars`

Location: around lines 1311-1365.

Currently this code:
1. Checks if edge has `maturity_days > 0`.
2. Builds cohorts from time series.
3. Calls `computeEdgeLatencyStats`.
4. Writes results to latency fields.

Change to:
1. Check if `targetEdge.p.latency.completeness` already exists on the graph.
2. If yes, use that completeness for forecast blending; do not recompute.
3. If no, invoke a minimal fallback (see below).

### 5.2 Fallback for legacy/isolated edge operations

Keep a narrow fallback for:
- Files that predate latency and have no latency fields.
- Single-edge "Get from File" where graph context is unavailable.

In this fallback:
1. Build cohorts from stored values.
2. Call `computeEdgeLatencyStats` with `pathT95 = 0` (approximate).
3. Write results to parameter value only.
4. Log a warning that this is an approximation.

### 5.3 Update cohort-fallback path (around line 6128)

Same principle: read `completeness` from `originalParamData.latency.completeness` if present, rather than recomputing.


## 6. Single-Edge Operations

### 6.1 Get from File

Default: reuse existing `p.latency.*` fields from the parameter file or graph edge. Do not recompute unless fields are missing.

### 6.2 Get from Source (single edge)

Preferred: treat as a mini-batch that runs `enhanceGraphLatencies` on the full graph (including the newly fetched edge). This ensures topo order is respected.

Fallback: if that is too expensive, compute LAG for just this edge with `pathT95 = 0` and document the approximation.


## 7. Test Updates

### 7.1 `statisticalEnhancementService.test.ts`

Add tests for `enhanceGraphLatencies`:
- Linear graph A→B→C: verify path_t95 accumulates, completeness decreases downstream.
- Branching graph: verify max path_t95 is used at merge points.
- Edge with no latency config: verify it is skipped.

### 7.2 `fetchDataService.test.ts`

Add integration test:
- Mock a batch fetch for a 3-edge graph.
- Verify that after fetch, all edges have `p.latency.{t95, completeness, path_t95}` populated.
- Verify downstream edge completeness < upstream edge completeness.

### 7.3 `addEvidenceAndForecastScalars.test.ts`

Update tests to:
- Assume completeness is provided via latency fields.
- Verify it is consumed correctly in blending.
- Test fallback path produces finite values.


## 8. Migration Steps

1. Implement `enhanceGraphLatencies` in `statisticalEnhancementService.ts`.
2. Add tests for the new function.
3. Wire it into `fetchDataService.ts` after fetch, alongside (not replacing) existing code initially.
4. Verify outputs match expectations on test graphs.
5. Remove per-edge LAG recompute from `dataOperationsService.ts` main path.
6. Remove old `computeAndApplyPathT95` call from `fetchDataService.ts`.
7. Run full test suite and manual validation.
8. Clean up any dead code.
