# Canvas Analysis Feature

How visual analysis cards work on the graph canvas: creation, computation, scenarios, and mutation.

## What Canvas Analyses Are

Visual analysis cards positioned on the graph canvas. They display computed analytical insights (funnel metrics, cohort maturity, lag histograms, etc.) inline without leaving the canvas view.

## Data Model: Container + Content Items

### CanvasAnalysis (container)

Owns only spatial and structural metadata:
- `id` -- unique identifier
- `x, y, width, height` -- positioning on canvas
- `content_items[]` -- ordered list of renderable analysis items (tabs)
- `minimised` -- visibility state
- `minimised_anchor` -- which corner the minimised icon anchors to

### ContentItem (authority)

Each tab owns all analytical properties:

| Field | Purpose |
|-------|---------|
| `id` | UUID, stable across reorder/drag |
| `analysis_type` | Analysis identifier ('edge_info', 'cohort_maturity', 'lag_histogram', etc.) |
| `view_type` | Rendering mode: 'chart', 'cards', or 'table' |
| `kind` | Variant within analysis_type x view_type (e.g. 'overview', 'pie', 'funnel') |
| `display` | Rendering settings (font_size, scale_with_canvas, hidden_scenarios[]) |
| `analytics_dsl` | Data subject DSL (e.g. `'from(X).to(Y)'`) |
| `chart_current_layer_dsl` | Live-mode constraint fragment |
| `mode` | Scenario policy: 'live', 'custom', or 'fixed' |
| `scenarios[]` | Stored scenario set (custom/fixed modes only) |
| `what_if_dsl` | What-if constraint DSL |
| `analysis_type_overridden` | Whether user manually selected the type |

## Creation Pipeline

All creation paths funnel through `canvasAnalysisCreationService.ts`:

1. **`buildCanvasAnalysisPayload(args)`** -- synchronous, pure. Builds creation payload from known fields (analytics DSL, analysis type, chart kind, view mode).
2. **`buildCanvasAnalysisObject(payload, position, size)`** -- converts payload into a graph-ready `CanvasAnalysis` with UUIDs for container and content items.

Entry points: analytics panel (drag/pin), element palette, elements menu, context menus.

## Computation Pipeline

**Hook**: `useCanvasAnalysisCompute`

### Three-level cache

1. **Transient cache**: seeded at creation (one-shot)
2. **Container-level cache**: keyed by analysis ID
3. **Per-content-item cache**: when a tab carries its own result

### Dependency gates

- Graph must be ready (not undefined/null)
- For snapshot-requiring analyses: snapshot resolution must complete
- Scenario hydration must complete (when in custom/fixed mode)

### Computation flow

1. Prepare inputs via `analysisComputePreparationService` (validate DSL, analysis type, dependencies)
2. Run computation with `runPreparedAnalysis`
3. 2000ms debounce between requests to reduce backend load

### Triggers

- Manual refresh
- Active content item change (tab switch)
- Graph updates (debounced)
- Analysis type registry version changes

## Three-Mode Scenario System

Content items support a tristate mode cycle:

### Live (default)

- Scenarios reflect the active tab's current state
- On mutation, auto-promotes to Custom
- Clears `scenarios` and `what_if_dsl`

### Custom (captured overrides)

- Captured scenarios stored as delta DSL relative to base DSL
- Deltas rebased via `computeRebaseDelta(base, absoluteDsl)`
- Supports `what_if_dsl` and per-scenario visibility toggling
- Mutations (rename, delete, reorder, colour) via `useCanvasAnalysisScenarioCallbacks`

### Fixed (baked absolutes)

- Each scenario's delta baked into absolute DSL
- No longer linked to base DSL
- Clears `what_if_dsl` and hidden list

### Mode transitions

```
Live --> Custom: capture scenarios from tab, rebase to deltas
Custom --> Fixed: bake deltas into absolute DSLs
Fixed --> Live: clear scenarios and what_if_dsl
```

**Auto-promotion**: any scenario mutation in Live mode silently captures and promotes to Custom.

## Mutation Service

**Location**: `canvasAnalysisMutationService.ts`

All mutations use immutable patterns (clone graph, mutate, return):

### Container mutations

- `mutateCanvasAnalysisGraph(graph, analysisId, mutator)` -- clone, find, mutate, return
- `deleteCanvasAnalysisFromGraph(graph, analysisId)` -- remove from graph

### Content item mutations

- `mutateContentItem(graph, analysisId, contentItemIndex, mutator)` -- per-tab mutation
- `setContentItemAnalysisType(graph, analysisId, contentItemIndex, analysisTypeId)` -- **canonical path** for type changes (all code paths must use this)
- `addContentItem(analysis, preset?)` -- add new tab
- `removeContentItem(analysis, contentItemId)` -- remove tab (returns true if last tab removed)

### Mode cycling

- `advanceMode(ci, currentDSL, captured, currentColour?)` -- advance one step in Live --> Custom --> Fixed --> Live

## Tab Architecture

Canvas analyses support multiple content items (tabs):

- Tab switching on hover/click
- Tab drag-out with ghost (portalled to document.body)
- Snap-in preview on drag-over
- Add/remove tabs
- Per-tab context menu (change type, rename, hide, overlay toggle)

Tab labels map `kind` to display names: Overview, Structure, Evidence, Model, Latency, Data Depth, Diagnostics.

## Legacy Migration

`normaliseCanvasAnalysis()` migrates old flat fields (recipe, mode, view_mode, chart_kind, title, display) into `content_items[]` and strips them from the container on load.

## Evidence Tab (Snapshot Calendar)

The `edge_info` analysis type supports an `evidence` card kind which renders `SnapshotCalendarSection` — a dual-month calendar showing which days have snapshot data for that edge.

### Single codepath for hover and canvas

`SnapshotCalendarSection` is defined in `HoverAnalysisPreview.tsx` and exported for use by both:
- **Hover preview**: `ConversionEdge` passes a `snapshotSource` prop to `HoverAnalysisPreview`, which renders `SnapshotCalendarSection` via `tabExtra`
- **Canvas pinned**: `CanvasAnalysisNode` resolves the edge from `analyticsDsl` via `resolveEdgeFromDsl` (exported from `localAnalysisComputeService.ts`), then passes `source` to `SnapshotCalendarSection` via `evidenceTabExtra`

Both paths pass a `source` object `{ graph, edgeId, effectiveDSL, workspace }`. The component self-fetches via `getSnapshotRetrievalsForEdge` (unfiltered) or `buildSnapshotRetrievalsQueryForEdge` + `querySnapshotRetrievals` (context-filtered with `slice_keys`).

### Context filtering

The evidence tab includes a context filter UI driven by `useContextDropdown` (shared hook, same as WindowSelector's "+ Context" button). Three-state UI pattern: button → `ContextValueSelector` dropdown → `QueryExpressionEditor` chips.

Context filtering uses two levels:
1. **Hash level**: context *dimension* changes the `core_hash` (channel-contexted ≠ device-contexted ≠ uncontexted). Selecting a dimension causes a re-fetch with the dimension-specific hash.
2. **Slice level**: context *value* is carried in `slice_key` within a hash family. All values in one dimension share the same hash. Value-level filtering requires the `slice_keys` parameter on the query, constructed by `buildSnapshotRetrievalsQueryForEdge`.

### Boot timing

The evidence tab depends on `NavigatorContext` for workspace (`selectedRepo`, `selectedBranch`). Navigator loads asynchronously and can take several seconds after F5. The fetch effect guards on `sourceRepo && sourceBranch` being non-empty to avoid firing with `workspace: undefined`. The `evidenceTabExtra` memo in `CanvasAnalysisNode` also guards on `navState.selectedRepo && navState.selectedBranch`.

`edge_info` is a FE-only analysis type that bypasses the `scenariosReady` gate in `analysisComputePreparationService.ts` — it doesn't need scenario composition.

## Key Design Principles

1. **Container-only placement, content-only logic**: container owns position/size, content items own everything else
2. **Single mutation path**: e.g. `setContentItemAnalysisType()` is the ONE function all paths must use for type changes
3. **Immutable mutations**: all graph mutations clone, mutate the clone, return new graph
4. **Auto-promotion in Live mode**: scenario mutations silently promote to Custom

## Key Files

| File | Role |
|------|------|
| `src/services/canvasAnalysisCreationService.ts` | Payload building and object construction |
| `src/services/canvasAnalysisMutationService.ts` | All mutation operations |
| `src/hooks/useCanvasAnalysisCompute.ts` | Computation orchestration |
| `src/hooks/useCanvasAnalysisScenarioCallbacks.ts` | Scenario mutations with auto-promotion |
| `src/utils/canvasAnalysisAccessors.ts` | Accessors, legacy migration, helpers |
| `src/components/CanvasAnalysisCard.tsx` | Shared renderer for pinned and hover modes |
| `src/components/CanvasAnalysisContextMenu.tsx` | Per-analysis context menu |
| `src/hooks/useContextDropdown.ts` | Shared context filter dropdown state (used by WindowSelector + evidence tab) |
| `src/components/HoverAnalysisPreview.tsx` | `SnapshotCalendarSection` — dual-month snapshot calendar with context filter |
