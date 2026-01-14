# ARCHIVED (Superseded)
#
# **Status**: Archived on 14-Jan-26
# **Superseded by**: `docs/current/refactor/src-slimdown.md`
#
# This document is retained for historical context only. It previously served as an analysis and
# refactor recommendation set for GraphEditor; the current canonical plan is the slimdown doc.

# GraphEditor Architecture

## Overview

`GraphEditor.tsx` is the main editor component for DAG graphs. At ~2100 lines, it's one of the largest components in the codebase and handles:

- Graph canvas rendering
- Sidebar panel management (rc-dock)
- Selection state
- Tab state synchronization
- What-If DSL propagation
- Scenario management integration

## File Location
`graph-editor/src/components/editors/GraphEditor.tsx`

---

## Component Hierarchy

```
GraphEditor (export)
  └── GraphStoreProvider          # Isolated store for this graph
      └── GraphEditorInner        # React.memo'd main component
          ├── SelectionContext.Provider
          │   └── ScenariosProvider
          │       └── ViewPreferencesProvider
          │           └── Container div
          │               ├── DockLayout (rc-dock)
          │               │   ├── Canvas Panel
          │               │   │   └── CanvasHost → GraphCanvas
          │               │   └── Sidebar Panel
          │               │       ├── WhatIfPanel
          │               │       ├── PropertiesPanelWrapper
          │               │       ├── ToolsPanel
          │               │       └── AnalyticsPanel
          │               ├── WindowSelector
          │               ├── ScenarioLegendWrapper
          │               ├── SidebarIconBar (minimized mode)
          │               ├── SidebarHoverPreview (hover preview)
          │               ├── Minimize/Maximize button
          │               └── SelectorModal
```

---

## Major Sections

### 1. Imports & Setup (Lines 1-55)
- React hooks
- Context imports (TabContext, GraphStoreContext, VisibleTabsContext)
- rc-dock layout library
- Panel components
- Sidebar state hook
- Layout configuration

### 2. SelectionContext (Lines 29-54)
Local context for sharing selection state between GraphEditor and sidebar panels.

```typescript
interface SelectionContextType {
  selectedNodeId: string | null;
  selectedEdgeId: string | null;
  onSelectedNodeChange: (id: string | null) => void;
  onSelectedEdgeChange: (id: string | null) => void;
  openSelectorModal: (config: SelectorModalConfig) => void;
}
```

### 3. ScenarioLegendWrapper (Lines 56-126)
Wrapper component that:
- Accesses ScenariosContext
- Renders ScenarioLegend with proper state
- Handles scenario visibility toggling and deletion

### 4. GraphEditorInner (Lines 128-2089)
The main component, wrapped in `React.memo` with custom comparison.

#### 4a. State & Refs (Lines 134-226)
- Tab state from TabContext
- Visibility from VisibleTabsContext
- **whatIfDSL** from `tabState.whatIfDSL`
- Sidebar state from `useSidebarState(tabId)`
- Selection state (node/edge)
- Modal state
- Various refs for:
  - GraphCanvas functions (addNode, deleteSelected, autoLayout, etc.)
  - DockLayout ref
  - ResizeObservers
  - Timers

#### 4b. Selection Handlers (Lines 228-267)
- `handleNodeSelection` - updates state, dispatches events, persists to tab
- `handleEdgeSelection` - same pattern
- Auto-opens Properties panel on first selection

#### 4c. Sidebar Icon Handlers (Lines 269-349)
- `handleIconClick` - maximizes sidebar to panel
- `handleIconHover` - shows hover preview
- Event listeners for:
  - `dagnet:suspendLayout`
  - `dagnet:openSidebarPanel`
  - `dagnet:openPropertiesPanel`
  - `dagnet:openScenariosPanel`

#### 4d. Layout Effects (Lines 350-881)
Multiple useEffect hooks for:
- Sync sidebar state with dock layout
- ResizeObserver setup for sidebar width tracking
- Applying sidebar width on mode changes
- Container resize handling
- Keyboard shortcuts (Ctrl+B)

#### 4e. Canvas & Panel Components (Lines 890-956)
Memoized component creation:

```typescript
const canvasComponent = useMemo(() => <CanvasHost />);
const whatIfComponent = useMemo(() => <WhatIfPanel tabId={tabId} />);
const propertiesComponent = useMemo(() => <PropertiesPanelWrapper tabId={tabId} />);
const toolsComponent = useMemo(() => <ToolsPanel ... />);
const analyticsComponent = useMemo(() => <AnalyticsPanel tabId={tabId} />);
```

#### 4f. createLayoutStructure (Lines 958-1033)
Helper function that:
- Creates rc-dock LayoutData
- Back-calculates flex weights for pixel widths
- Injects React components into tabs
- Sets active tab based on sidebar state

#### 4g. Layout Initialization (Lines 1038-1600)
- Restore saved layout or create new
- Re-inject React components into saved layouts
- Handle mode changes (minimized ↔ maximized)
- Track floating panels

#### 4h. Render (Lines 1604-2082)
JSX structure:
1. Loading/error states
2. SelectionContext.Provider
3. ScenariosProvider
4. ViewPreferencesProvider
5. Container div with:
   - DockLayout
   - WindowSelector
   - ScenarioLegendWrapper
   - SidebarIconBar (minimized)
   - SidebarHoverPreview (hover)
   - Minimize button
   - SelectorModal

### 5. GraphEditor Export (Lines 2091-2101)
Simple wrapper that provides GraphStoreProvider.

---

## What-If DSL Flow

**Current Implementation:**

```
TabContext (source of truth)
  └── tabState.whatIfDSL
      │
      ├─→ GraphEditorInner reads at line 173:
      │     const whatIfDSL = tabState.whatIfDSL;
      │
      ├─→ Passed to GraphCanvas as prop (line 923):
      │     <GraphCanvas whatIfDSL={whatIfDSL} />
      │
      └─→ GraphCanvas uses it for:
          ├── effectiveWhatIfDSL calculation (line 227)
          ├── Edge data.whatIfDSL (lines 1548, 2020, etc.)
          └── Direct computeEffectiveEdgeProbability calls
```

**Problem**: What-If calculations happen in MULTIPLE places:
1. GraphCanvas - calculates `effectiveWhatIfDSL`, passes to edges
2. ConversionEdge - calls `computeEffectiveEdgeProbability` directly
3. edgeBeadHelpers - has its own composition logic
4. buildScenarioRenderEdges - computes edge widths
5. AnalyticsPanel - builds graphs for analysis

---

## Duplicated/Scattered Logic

### 1. What-If Application
- `computeEffectiveEdgeProbability()` called in 10+ places
- GraphCanvas (lines 1659, 1883, 3652, 3717, 3874, 3989)
- ConversionEdge (line 385)
- ConversionNode (line 136)
- buildScenarioRenderEdges (line 226)

### 2. Edge Probability Calculation
- GraphCanvas has inline composition logic
- edgeLabelHelpers has `getEdgeInfoForLayer` with 3 code paths
- buildScenarioRenderEdges has `getEdgeProbability`

### 3. Scenario Composition
- ScenariosContext has `composeVisibleParams`
- CompositionService has `getComposedParamsForLayer`
- Various inline lookups: `scenariosContext.baseParams.edges?.[key]`

---

## Refactoring Recommendations

### High Priority

1. **Centralize What-If Logic**
   - Single entry point: `CompositionService.getEffectiveEdgeProbability()`
   - All consumers call this, never `computeEffectiveEdgeProbability` directly
   - whatIfDSL flows through ScenariosContext (receives as prop from GraphEditor)

2. **Extract Layout Logic**
   - Move rc-dock layout management to custom hook
   - ~500 lines of layout effects could be isolated

3. **Extract Selection Logic**
   - Move SelectionContext and handlers to separate file
   - Currently ~100 lines embedded in GraphEditor

### Medium Priority

4. **Consolidate Edge Rendering**
   - Single source for edge data construction
   - Remove duplicate probability calculations

5. **Simplify Component Creation**
   - The component injection (lines 1055-1130) is complex
   - Consider a registry pattern

### Low Priority

6. **Remove Debug Logging**
   - ~50 console.log statements
   - Should use configurable debug flag

---

## Key Dependencies

### Contexts Used
- `TabContext` - tab state, operations
- `GraphStoreContext` - graph data
- `VisibleTabsContext` - tab visibility for optimization
- `ScenariosContext` - scenario management
- `ViewPreferencesContext` - view settings

### Hooks Used
- `useSidebarState` - sidebar mode, width, panels
- `useFileState` - file data and dirty state
- `useGraphStore` - graph access

### External Libraries
- `rc-dock` - dockable panel layout
- `lucide-react` - icons

---

## File Size Breakdown

| Section | Approx Lines |
|---------|-------------|
| Imports & types | 55 |
| ScenarioLegendWrapper | 70 |
| State & refs | 90 |
| Selection handlers | 40 |
| Icon/hover handlers | 80 |
| Layout effects | 530 |
| Component creation | 70 |
| Layout structure | 75 |
| Layout init & mode | 560 |
| Render JSX | 480 |
| **Total** | **~2100** |

---

## Testing Considerations

When testing GraphEditor:
1. Mock TabContext, GraphStoreContext, VisibleTabsContext
2. Test sidebar mode transitions
3. Test selection state propagation
4. Test what-if DSL propagation to GraphCanvas
5. Test layout persistence (saved/restored)

