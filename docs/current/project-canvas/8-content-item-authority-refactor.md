# Content Item Authority Refactor

## Problem

Canvas analysis containers currently own fields that belong on content items (tabs). This causes every per-tab feature (compute, connectors, scenarios, display) to require adapter code that reads from the tab but writes to the container, or vice versa. Every such adapter is a bug waiting to happen.

## Principle

**Content item is the unit of authority.** The container is pure geometry + tab list.

```
CanvasAnalysis (container)
  id, x, y, width, height
  content_items: ContentItem[]

ContentItem (tab)
  id
  analysis_type, view_type, kind, title
  analytics_dsl, chart_current_layer_dsl
  analysis_type_overridden
  display
  mode: 'live' | 'custom' | 'fixed'
  scenarios: ChartRecipeScenario[]
  what_if_dsl
```

## What moves from container to content item

| Field | From | To |
|---|---|---|
| `recipe.analysis.analysis_type` | `CanvasAnalysis.recipe` | `ContentItem.analysis_type` (already exists) |
| `recipe.analysis.analytics_dsl` | `CanvasAnalysis.recipe` | `ContentItem.analytics_dsl` (already exists) |
| `recipe.analysis.what_if_dsl` | `CanvasAnalysis.recipe` | `ContentItem.what_if_dsl` (new) |
| `recipe.scenarios` | `CanvasAnalysis.recipe` | `ContentItem.scenarios` (new) |
| `mode` | `CanvasAnalysis.mode` | `ContentItem.mode` (new) |
| `view_mode` | `CanvasAnalysis.view_mode` | `ContentItem.view_type` (already exists) |
| `chart_kind` | `CanvasAnalysis.chart_kind` | `ContentItem.kind` (already exists) |
| `title` | `CanvasAnalysis.title` | `ContentItem.title` (already exists) |
| `display` | `CanvasAnalysis.display` | `ContentItem.display` (already exists) |
| `chart_current_layer_dsl` | `CanvasAnalysis.chart_current_layer_dsl` | `ContentItem.chart_current_layer_dsl` (already exists) |
| `analysis_type_overridden` | `CanvasAnalysis.analysis_type_overridden` | `ContentItem.analysis_type_overridden` (already exists) |

## What stays on container

- `id` — identity
- `x, y, width, height` — placement
- `content_items` — the tabs

That's it.

## CanvasAnalysis no longer extends ChartDefinition

`ChartDefinition` is the schema for chart files and share payloads. Canvas analyses are NOT charts — they're containers. The `extends ChartDefinition` must be removed. Any code that treats a `CanvasAnalysis` as a `ChartDefinition` must be updated to read from the active content item.

## Persistence (YAML / JSON)

The persisted graph JSON must match the new schema. On load, `normaliseCanvasAnalysis` migrates legacy graphs by moving container-level fields into `content_items[0]` and deleting them from the container.

The Python `CanvasAnalysis` Pydantic model must also be updated: strip all flat fields except `id, x, y, width, height, content_items`. Add a `model_validator(mode='before')` that migrates legacy data.

## Files to change

### Types
- `types/index.ts` — `ContentItem`: add `mode`, `scenarios`, `what_if_dsl`. `CanvasAnalysis`: stop extending `ChartDefinition`, keep only placement fields + content_items
- `types/chartRecipe.ts` — `ChartDefinition` unchanged (still used by chart files), but no longer extended by `CanvasAnalysis`

### Migration
- `utils/canvasAnalysisAccessors.ts` — `normaliseCanvasAnalysis`: move all container flat fields into content_items[0], delete from container. `getActiveContentItem`: update legacy synthesis path

### Python
- `lib/graph_types.py` — `CanvasAnalysis`: strip flat fields. `ContentItem`: add `mode`, `scenarios`, `what_if_dsl`. Add migration validator.

### Compute
- `hooks/useCanvasAnalysisCompute.ts` — read `mode`, `scenarios`, `what_if_dsl`, `analysisType`, `analyticsDsl` from content item, not from `analysis.recipe` or `analysis.mode`

### Mutation
- `services/canvasAnalysisMutationService.ts` — `syncFlatFieldsToContentItems`: delete entirely (no more flat fields to sync). `advanceMode`: operates on content item, not container. `mutateCanvasAnalysisGraph`: update to pass content item index for targeted mutations
- `services/canvasAnalysisCreationService.ts` — `buildCanvasAnalysisObject`: build content items with all fields, container has only placement

### Rendering
- `components/nodes/CanvasAnalysisNode.tsx` — read `mode`, `scenarios`, scenario state from content item. All `onUpdate` writes target content items. `handleModeCycle`, `handleScenario*` callbacks operate per-tab
- `components/canvas/CanvasContextMenus.tsx` — scenario mode switch writes to content item
- `components/PropertiesPanel.tsx` — all reads/writes from active content item (most already done)
- `components/SelectionConnectors.tsx` — already reads per-tab DSL (done)

### Creation
- `components/canvas/creationTools.ts` — `createCanvasAnalysisInGraph`: build container with only placement, content items carry everything
- `components/canvas/useCanvasCreation.ts` — snap handler builds content items with full fields
- `components/HoverAnalysisPreview.tsx` — snap/pin dispatches include mode and scenario state

### Boot / hydration
- `hooks/useAnalysisBootCoordinator.ts` — reads analysis type and chart kind for boot scheduling; update to read from content item
- `services/analysisBootCoordinatorService.ts` — same

### Other readers
- `services/bayesPatchService.ts` — reads recipe
- `hooks/useBayesTrigger.ts` — reads analysis type
- `components/charts/AnalysisChartContainer.tsx` — receives props from parent (no direct container access)
- `services/shareLinkService.ts` — reads ChartDefinition-shaped data; must construct from content item

## Additional files to change (found in adversarial review)

### Transform / sync
- `lib/transform.ts` — `toFlow`/`fromFlow` read container fields to build ReactFlow nodes. Must read from content items.
- `components/canvas/useGraphSync.ts` — sync effects read analysis fields for node data. Must read from content items.

### ChartDefinition bridge
- `types/chartRecipe.ts` — add `contentItemToChartDefinition(ci: ContentItem): ChartDefinition` helper. Used by "Open as Tab" and share links. ContentItem has flat fields (analysis_type, analytics_dsl, scenarios); this helper reconstructs the `recipe` shape.

## Design decisions

### hidden_scenarios
Currently on `analysis.display.hidden_scenarios`. Must move to `ci.display.hidden_scenarios` — each tab can have different hidden scenarios in custom/fixed mode.

### Scenario UI
Currently per-container: one scenario tray for the whole analysis. After this, the scenario tray shows the ACTIVE tab's scenarios. The tray already receives `scenarioLayerItems` computed in CanvasAnalysisNode — just needs to compute from the active content item's mode/scenarios instead of from the container's.

### mutateCanvasAnalysisGraph API
Add a content-item-targeted variant:
```
mutateContentItem(graph, analysisId, ciIndex, mutator: (ci: ContentItem) => void): GraphData | null
```
Existing `mutateCanvasAnalysisGraph` remains for container-level mutations (x/y/width/height, adding/removing tabs). Field-level mutations use `mutateContentItem`.

### getActiveContentItem legacy synthesis
Delete the legacy path entirely. After migration, content_items is always populated. If content_items is empty, that's a data error — don't silently synthesise.

### Multi-tab migration
On load, `normaliseCanvasAnalysis`:
1. If content_items is empty/missing: create single item from container flat fields (existing behaviour)
2. For ALL content items: if `mode` is missing, set `mode: 'live'`
3. For content_items[0] only: if container has `recipe.scenarios`, copy them + container `mode` to this item
4. Delete all container flat fields (recipe, mode, view_mode, chart_kind, title, display, chart_current_layer_dsl, analysis_type_overridden)

## Migration strategy

1. Update `ContentItem` type — add `mode`, `scenarios`, `what_if_dsl`
2. Update `CanvasAnalysis` type — remove `extends ChartDefinition`, remove ALL flat fields immediately. Only keep `id, x, y, width, height, content_items`. Let TypeScript break everything.
3. Update `normaliseCanvasAnalysis` — full migration on load (see Multi-tab migration above)
4. Update Python model — strip flat fields, add migration validator for legacy YAML
5. Add `contentItemToChartDefinition` helper
6. Add `mutateContentItem` function
7. Fix every TS error, file by file — each broken site is a reader/writer that needs to move to content item
8. Delete `syncFlatFieldsToContentItems` (dead code)
9. Delete `getActiveContentItem` legacy synthesis path (dead code)
10. Run all tests, fix breakage

No gradual migration. No temporary optional fields. Break it, fix it, done.

## Status (22-Mar-26)

### Completed

- ContentItem type: added `mode`, `scenarios`, `what_if_dsl`
- CanvasAnalysis type: stripped to `id, x, y, width, height, content_items` only. No longer extends ChartDefinition
- Python model: full migration validator, strips container flat fields on load
- JS normalisation: `normaliseCanvasAnalysis` migrates and strips legacy fields
- `mutateContentItem` and `setContentItemAnalysisType` — canonical mutation functions
- `humaniseAnalysisType` — single source of truth for type ID → human title
- `contentItemToChartDefinition` — bridge for "Open as Tab" / share links
- `syncFlatFieldsToContentItems` deleted
- `stripLegacyContainerFields` runs on every mutation (cleans stale in-memory data)
- `advanceMode` operates on ContentItem, not CanvasAnalysis
- All 13 consumer files updated (221 TS errors fixed)
- JSON schema updated for CanvasAnalysis and ContentItem
- SelectionConnectors: per-tab overlay, DSL dedup, unique shape keys
- Properties panel: tab-aware reads/writes
- Context menus: per-tab operations
- Connector persistence: per-tab `display.show_subject_overlay`
- Chrome (title bar, tab bar) gets inverse zoom — always readable
- Tab drag: source tab visually removed during drag, drop-back-on-source cancels
- Container drag: hidden via `visibility: hidden` (not opacity, which CSS `!important` overrides)
- Hover/drag connectors: intensity increased, tab drag shows connectors
- All analysis type changes go through `setContentItemAnalysisType` or `humaniseAnalysisType`
- Red tests for stale-prop bug and title update invariant
- Debugging heuristic added to CLAUDE.md: "recurring defect = multiple code paths"

### Incomplete / follow-up

- **Tab reorder by drag within container** — drop-back-on-source currently cancels; should reorder based on pointer position within tab bar
- **CTRL+drag to duplicate** — see section below
- **Per-tab compute caching** — switching tabs triggers re-compute instead of using cached results. `contentItemResultCache` exists but is only populated at snap time. Need to cache after every successful compute, restore on tab switch without debounce
- **Shared toolbar for all view types** — The chart toolbar (analysis type, view mode, kind, display settings, connectors, scenarios) is built inside `AnalysisChartContainer`. Cards view has a hand-built single-button toolbar. The toolbar composition should be extracted into a shared `CanvasAnalysisToolbar` component driven by the display settings registry. Both chart and cards views use the same toolbar. See design below.
- **Tab context menu parity** — tab context menu should share items with analysis node context menu (one codepath, scoped to the specific tab)

## Shared Toolbar Refactor

### Problem

The chart floating toolbar (analysis type, view mode, kind, display settings, connectors, scenarios) is built inside `AnalysisChartContainer` (~150 lines of inline JSX). Cards view has a hand-built one-button toolbar. Table view inherits from chart container. This means:

- Cards view is missing most toolbar items (analysis type, view mode, kind, font size, etc.)
- Adding a new toolbar item requires editing `AnalysisChartContainer` internals
- The toolbar composition isn't driven by the display settings registry for structural items (analysis type, view mode, kind) — only for display overrides

### Design

Extract toolbar composition into a shared function or component that receives callbacks and returns the tray JSX. Both chart and cards branches in `CanvasAnalysisNode.renderContent` pass it to `ChartFloatingIcon`.

Toolbar sections (in order):
1. **Analysis type palette** — popover with type icons. Props: `analysisTypeId`, `availableAnalyses`, `onAnalysisTypeChange`
2. **View mode switcher** — chart/cards/table pills. Props: `viewType`, `onViewTypeChange`, `availableViewModes`
3. **Kind picker** — pills or popover for chart kind / card kind. Driven by `getKindsForView(analysisType, viewType)` from registry. Props: `kind`, `onKindChange`
4. **Display settings** — from `getDisplaySettings(kind, viewType)` filtered by `inline: 'brief'`. Props: `display`, `onDisplayChange`
5. **Connector toggle** — overlay on/off + colour. Props: `overlayActive`, `overlayColour`, `onOverlayToggle`, `onOverlayColourChange`
6. **Scenario tray** — scenario pills + mode cycle. Only for canvas context. Props: scenario callbacks

All items render identically regardless of view type. The registry controls which display settings appear; the kind picker uses the analysis type registry.

### Implementation

1. Create `src/components/canvas/CanvasAnalysisToolbar.tsx` — pure function `buildToolbarTray(props): React.ReactNode`
2. Extract toolbar JSX from `AnalysisChartContainer` lines 692-900 into this function
3. `AnalysisChartContainer` calls `buildToolbarTray()` and passes result to `ChartFloatingIcon`
4. Cards branch in `CanvasAnalysisNode` also calls `buildToolbarTray()` with same callbacks
5. Delete hand-built card toolbar in `CanvasAnalysisNode` (lines 1200-1218)
6. Extend `CARDS_DISPLAY_SETTINGS` in registry with relevant settings

## CTRL+drag to Duplicate

### Behaviour

While CTRL (or Cmd on Mac) is held during any drag:
- Source object remains visible (not hidden/removed)
- Drop creates a COPY at the target location
- Visual affordance: cursor changes, ghost shows a "+" badge or similar indicator

### Implementation by object type

**Tab drag** (`CanvasAnalysisCard`)
- Already detects `e.ctrlKey || e.metaKey` at drop time (line 344: `duplicate: e.ctrlKey || e.metaKey`)
- While CTRL held during drag: don't filter out source tab from `visibleItems` (source stays visible)
- On drop: snap a COPY of the content item to the target container (don't remove from source)
- `onTabDragComplete` handler in `CanvasAnalysisNode` already receives `duplicate` flag — just needs to skip the source removal when true

**Canvas analysis container drag** (`useNodeDrag`)
- On CTRL+drag over a target dropzone: preview shows a copy, source stays visible (already visible since `visibility: hidden` only applies without CTRL)
- On drop without target: duplicate the entire container at the new position (new ID, cloned content_items with new IDs)
- On drop onto target container: merge a copy of all content items into the target (don't delete source)
- `dagnet:mergeContainers` handler needs a `duplicate` flag to skip source deletion

**Post-it drag** (`useNodeDrag`)
- CTRL+drag duplicates the post-it at the drop position
- Clone the post-it data, generate new ID, place at dropped coordinates
- No merge/snap behaviour — post-its are standalone

**Container object drag** (`useNodeDrag`)
- Same as post-it: CTRL+drag duplicates at drop position
- Clone container + all contained objects, generate new IDs

**Node drag** (`useNodeDrag`)
- CTRL+drag duplicates the node at the drop position
- Clone node data, generate new UUID and new human ID (append suffix like `-copy`)
- Edges are NOT duplicated (the copy is disconnected)
- This needs care: new node must not collide with existing IDs

### Context menu

All draggable objects should have a "Duplicate" item in their context menu:
- Canvas analysis: duplicate container with all tabs (new IDs)
- Tab (tab context menu): duplicate tab within the same container
- Post-it: duplicate at offset position
- Container: duplicate with contents
- Node: duplicate at offset position

### Visual affordance during CTRL+drag

- Ghost/dragged element shows a small "+" badge (top-right corner)
- Source object opacity stays at 1.0 (not hidden)
- Cursor: `copy` instead of `grabbing`

### Implementation order

1. Tab drag CTRL+duplicate (simplest — flag already exists)
2. Context menu "Duplicate" for tabs and containers
3. Canvas analysis container CTRL+drag duplicate
4. Post-it CTRL+drag duplicate
5. Node CTRL+drag duplicate
6. Container object CTRL+drag duplicate

## Risk

Large refactor (~25 files). TypeScript is the safety net — removing fields from the interface breaks every reader/writer immediately. The risk is not missing a site (TS catches those) but introducing subtle behavioural changes in the migration logic (e.g. wrong content item getting the container's scenarios).

## Test coverage needed

- normaliseCanvasAnalysis migrates ALL container fields to content items
- normaliseCanvasAnalysis sets mode='live' on content items that lack it
- normaliseCanvasAnalysis copies container scenarios to content_items[0] only
- Content item with mode='custom' and scenarios is preserved through mutation
- Switching tabs with different modes shows correct scenario state
- advanceMode operates on the correct content item, not the container
- Creation builds content items with mode='live' and no container flat fields
- Python model round-trips content items with mode, scenarios, what_if_dsl
- Python model migrates legacy data (container flat fields) on load
- Graph round-trip: save → load → save produces clean schema (no container flat fields)
- contentItemToChartDefinition produces valid ChartDefinition for "Open as Tab"
- Share link payload constructed from content item
