# Data Depth v2 — Composite Coverage Score

**Status**: Design
**Date**: 19-Mar-26

## 1. Motivation

Data Depth v1 uses `evidence.n` on a derived log₁₀ scale — a single-axis proxy
that misses two critical dimensions:

- **Temporal/slice coverage**: Do I have data across the full date range and all
  context slices the pinned DSL demands?  Recency-weighted, because recent gaps
  matter more than old ones.
- **Snapshot DB coverage**: For those dates, can I retrieve/refresh from the
  snapshot DB?  This is the safety net — without snapshots I'm flying blind.

A graph can have high `n` on a handful of days and still be poorly covered.
Conversely, an edge with modest `n` spread evenly across 60 days with full
snapshot backing is deeply instrumented.

## 2. Reference Frame

The **pinned DSL defines the total data scope**.  100 % coverage means: for every
edge, every slice family the DSL produces (window/cohort × context dimensions),
every date in the requested window — data exists and a snapshot backs it.

The composite score measures how far each edge is from that ceiling.

## 3. Three Dimensions

### 3.1 f₁ — Slice × date coverage

**Source**: `buildFetchPlan()` / `calculateIncrementalFetch()` in
`windowAggregationService.ts`.

For each edge, the fetch plan already enumerates every `FetchPlanItem` (one per
slice family) and classifies every date as `covered`, `missing`, or `stale`.

Score (recency-weighted):

```
f₁ = Σ(w_d  for covered dates across all slice families)
   / Σ(w_d  for all expected dates across all slice families)

w_d = exp(-ln(2) × age_d / RECENCY_HALF_LIFE_DAYS)
```

Uses the existing `RECENCY_HALF_LIFE_DAYS` constant (currently 30 d).

### 3.2 f₂ — Snapshot DB coverage

**Source**: `getSnapshotRetrievalsForEdge()` in `snapshotRetrievalsService.ts`.

Per edge, returns `retrieved_days: string[]` — the dates with at least one
snapshot.  Same recency weighting:

```
f₂ = Σ(w_d  for dates with snapshots)
   / Σ(w_d  for all dates in the DSL window)
```

### 3.3 f₃ — Sample size adequacy

**Source**: `edge.p.evidence.n` (already on graph edge).

Graph-relative via hyperbolic scaling:

```
f₃ = n / (n + n_median)
```

Where `n_median` is the median `evidence.n` across all edges in the graph that
have data (n > 0).  This gives 0.5 at the median and asymptotes to 1.

### 3.4 Composite

```
depth = f₁ × f₂ × f₃
```

Multiplicative (weakest-link): any single weak dimension pulls the whole score
down.  All factors ∈ [0, 1], so the product is too.

**Future**: component weights (e.g. `depth = f₁^w₁ × f₂^w₂ × f₃^w₃`) can be
introduced via constants if tuning is needed.  Starting with equal (w = 1)
weighting.

## 4. Architecture

### 4.1 Async computation

v1 was synchronous (read `evidence.n` from graph edges in a `useMemo`).  v2
requires:

1. **Param file reads from IDB** (async) — for per-slice date arrays (f₁)
2. **Snapshot DB queries** (async) — for per-edge snapshot days (f₂)
3. **Edge n** (sync) — already on graph (f₃)

### 4.2 New hook: `useDataDepthScores`

```
useDataDepthScores(graph, dsl, active) →
  { scores: Map<edgeId, DataDepthScore>, loading: boolean }
```

Where `DataDepthScore`:

```
{ depth: number,  f1: number,  f2: number,  f3: number }
```

**Computation flow** (when `active` transitions to true):

1. Call `buildFetchPlanProduction()` for current DSL — may already be cached by
   the planner.  Extract per-edge coverage from plan items.
2. Call `getSnapshotCoverageForEdges()` for all connected edges — parallel
   queries, same as @ menu.
3. Compute `n_median` from graph edges (sync).
4. For each edge: compute f₁, f₂, f₃, depth.
5. Cache result keyed on `(graphHash, dsl)`.

### 4.3 Service layer: `dataDepthService.ts`

Pure scoring logic (no React dependencies).  Functions:

- `computeDataDepthScores(plan, snapshotCoverage, edges, halflife)` →
  `Map<edgeId, DataDepthScore>`
- `depthToColour(depth, theme)` → colour string (continuous gradient mapping)
- `depthToLabel(score)` → human-readable summary for bead text

### 4.4 Context distribution

Scores are computed once per `(graph, DSL)` when overlay activates.  Distributed
to edges via the existing `ViewPreferencesContext` pattern or a dedicated
`DataDepthContext` — whichever avoids prop-drilling through ReactFlow edges.

## 5. UI Integration

### 5.1 Edge colouring (fade-out)

Reuses the existing `qualityOverlayColour` mechanism in `ConversionEdge.tsx`.
When data-depth is active, `edgeColour` comes from the depth score instead of
the scenario colour.  `effectiveScenarioColour` is overridden — same fade-out
as Forecast Quality.

### 5.2 Edge beads

When overlay is active, single bead per edge showing a concise summary, e.g.
`"73% — n=12.4k"`.  Background colour matches the depth score colour.

### 5.3 Legend

Replace the v1 bucket legend with a continuous gradient bar:
- Left (red): 0 % coverage
- Right (blue): 100 % coverage
- Label: "Data Coverage"
- Plus "No data" grey swatch for unconnected/unfetchable edges

### 5.4 Hover preview tab: "Data Depth"

Following the Forecast Quality → `forecast` tab pattern:

- `infoDefaultTab = 'data-depth'` when overlay is active
- Populate `tab: 'data-depth'` rows in `localAnalysisComputeService` edge_info:

| Section | Properties |
|---|---|
| **Coverage** | Composite score (%), Date coverage (f₁ %), Snapshot coverage (f₂ %), n adequacy (f₃ %) |
| **Date Detail** | Covered days / total days, Missing days (list if few), Window range |
| **Snapshot Detail** | Days with snapshots / total days, Latest snapshot date |
| **Sample Size** | n, k, observed rate, graph median n |
| **By Slice** | One row per context slice family, showing: slice label, date coverage %, days covered / total, n for that slice |

The **By Slice** section is the key diagnostic: when an edge scores low, the
user sees immediately which context slice is the culprit — e.g.
`context(channel:organic)` at 45 % vs `context(channel:paid-search)` at 92 %.
The data is already per-slice: each `FetchPlanItem` is keyed by
`(edge, sliceFamily)`, so the breakdown falls out of the existing plan
structure with no extra queries.

For edges with no context slices (uncontexted DSL), the section shows a single
"(all)" row.  For edges with many slices, rows are sorted by coverage ascending
so the weakest slices are most visible.

### 5.5 View menu / toolbar

Already wired from v1: View → Data Depth toggle, toolbar pill with Database
icon.  No changes needed.

## 6. Existing Code Reuse

| Need | Existing code path |
|---|---|
| Slice × date coverage | `buildFetchPlan()` → `FetchPlanItem.classification` + `FetchWindow` gaps |
| Snapshot coverage | `getSnapshotRetrievalsForEdge()` → `retrieved_days` |
| Recency halflife | `RECENCY_HALF_LIFE_DAYS` constant (30 d) |
| Edge fade-out | `qualityOverlayColour` mechanism in `ConversionEdge.tsx` |
| Hover default tab | `infoDefaultTab` prop flow: `HoverAnalysisPreview` → `AnalysisChartContainer` → `AnalysisInfoCard` |
| Tab data population | `localAnalysisComputeService.computeEdgeInfo()` → `data.push({ tab, section, property, value })` |
| Graph hash for caching | `windowFetchPlannerService.computeGraphHash()` |

## 7. Files to Change

### New files
- `graph-editor/src/services/dataDepthService.ts` — pure scoring logic
- `graph-editor/src/hooks/useDataDepthScores.ts` — async hook orchestrating the
  three data sources

### Modified files
- `graph-editor/src/utils/dataDepthTier.ts` — replace derived-scale logic with
  continuous gradient mapping; keep as thin colour utility
- `graph-editor/src/components/DataDepthLegend.tsx` — continuous gradient bar
  instead of bucket swatches
- `graph-editor/src/components/edges/ConversionEdge.tsx` — consume depth scores
  from hook/context instead of inline `deriveDataDepthScale`
- `graph-editor/src/components/edges/EdgeBeads.tsx` — consume depth scores;
  show composite summary on bead
- `graph-editor/src/components/editors/GraphEditor.tsx` — wire
  `useDataDepthScores` hook; update `DataDepthLegendWrapper`
- `graph-editor/src/services/localAnalysisComputeService.ts` — add
  `tab: 'data-depth'` rows to edge_info
- `graph-editor/src/components/HoverAnalysisPreview.tsx` — set
  `infoDefaultTab = 'data-depth'` when overlay active

### Unchanged
- `graph-editor/src/hooks/useViewOverlayMode.ts` — already has `toggleDataDepth`
- `graph-editor/src/components/MenuBar/ViewMenu.tsx` — already has menu item
- `graph-editor/src/types/index.ts` — `ViewOverlayMode` already includes
  `'data-depth'`

## 8. Performance Considerations

- `buildFetchPlanProduction()` is the heaviest call — but the planner may
  already have a cached result for the current DSL.  If not cached, it reads
  param files from IDB (one per connected edge).
- `getSnapshotCoverageForEdges()` fires one network request per connected edge
  to the snapshot DB backend.  For a 40-edge graph this is ~40 parallel
  requests.  The @ menu already does this on dropdown open, so the backend
  handles the load.  Consider throttling if graphs exceed ~100 connected edges.
- Scores are cached and only recomputed when `(graphHash, dsl)` changes.
- The overlay shows a brief loading indicator on first activation, then is
  instant from cache.

## 9. Future Extensions

- **Component weights**: `depth = f₁^w₁ × f₂^w₂ × f₃^w₃` with configurable
  constants, if tuning shows one dimension should dominate.
- **Staleness dimension**: `stale` dates (classified by fetch planner) could be
  a fourth factor, or folded into f₁ with a penalty weight.
