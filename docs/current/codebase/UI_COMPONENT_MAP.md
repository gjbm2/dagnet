# UI Component Map

The app's visual anatomy: what each component area is, how it's structured, what renders where, and the display state management patterns used across the UI.

## Visual hierarchy

```
document.body
├─ Modals (ConfirmDialog, TripleChoiceDialog, CommitModal) [z-index 10000+]
├─ react-hot-toast (Toaster) [bottom-centre]
├─ #root
│  └─ AppShell (ErrorBoundary + all context providers)
│     └─ DockLayout (rc-dock, main app)
│        ├─ Menu Bar (locked 40px, non-closable)
│        ├─ Navigator Panel (left, 240px collapsible, starts hidden)
│        ├─ Main Tabs Area (flex, one tab per open file)
│        │  └─ GraphEditor (if graph file — nested rc-dock inside the tab)
│        │     ├─ Canvas Panel (left, flex — GraphCanvas with ReactFlow)
│        │     └─ Sidebar (right, collapsible)
│        │        ├─ Element Palette (top, 64px fixed — tool buttons)
│        │        └─ Tabbed Panel (bottom, flex)
│        │           ├─ Scenarios tab (WhatIfPanel)
│        │           ├─ Props tab (PropertiesPanelWrapper)
│        │           ├─ Tools tab (ToolsPanel)
│        │           └─ Analytics tab (AnalyticsPanel)
│        └─ Float Box (dragged-out tabs become floating windows)
│
├─ BannerHost [portalled to document.body, top-of-app]
├─ AutomationBanner [portalled]
└─ OperationsToast [fixed position bottom-centre]
```

## Two-level rc-dock system

### App-level dock (AppShell)

Defined in `layouts/defaultLayout.ts`. Manages: menu bar, navigator, main content area, floating panels.

### Graph-level dock (GraphEditor)

Defined in `layouts/graphSidebarLayout.ts`. A **nested** rc-dock inside each graph tab. Manages: canvas panel, sidebar with element palette + tabbed panels.

Sidebar state is persisted to IndexedDB per tab via `useSidebarState(tabId)`: open/closed panels, sidebar width, active panel. See SIDEBAR_AND_PANELS_ARCHITECTURE.md for full detail.

### Dashboard dock (DashboardShell)

Defined in `layouts/dashboardDockLayout.ts`. Tiled grid of chart tabs using sqrt(n) column count. Activated by `?dashboard=1` URL param.

## Context provider nesting

```
ErrorBoundary → ThemeProvider → ShareModeProvider → Toaster →
DashboardModeProvider → ProjectionModeProvider → DialogProvider →
ValidationProvider → TabProvider → NavigatorProvider →
VisibleTabsProvider → CopyPasteProvider → AppShellContent
```

Inside GraphEditor: `ElementToolContext`, `ViewPreferencesContext`, `ScenariosContext`, `WhatIfContext`, `DataDepthContext`, `ScenarioHighlightContext`

## Key contexts

| Context | State | Persistence | Purpose |
|---------|-------|-------------|---------|
| `ElementToolContext` | `activeElementTool: 'select' \| 'pan' \| 'new-node' \| ...` | None | Canvas tool mode |
| `ViewPreferencesContext` | Sankey, images, auto-update, confidence intervals, etc. | Tab editorState (IDB) | Per-tab view toggles |
| `DashboardModeContext` | `isDashboardMode: boolean` | URL param | Switches entire UI mode |
| `DialogContext` | `showConfirm()`, `showTripleChoice()` | None | Modal system |
| `ThemeContext` | `theme: 'light' \| 'dark'` | localStorage | Theme toggle |
| `ShareModeContext` | `mode: 'none' \| 'static' \| 'live'` | URL params (immutable) | Share mode signal |
| `TabContext` | File tabs, FileRegistry, editor state | IDB | File management |
| `NavigatorContext` | File browser tree | Tab-derived | Navigator sidebar |

## Canvas object types

ReactFlow renders four custom node types, each with distinct display state:

| Node type | Component | RF type prefix | Display states |
|-----------|-----------|---------------|----------------|
| Conversion node | `ConversionNode.tsx` | `conversion-` | Normal, selected, hover preview, image stack |
| Container (group) | `ContainerNode.tsx` | `container-` | Normal, selected, colour variants, child drag visual |
| Post-it | `PostItNode.tsx` | `postit-` | Normal, editing (inline editor), minimised (32px icon) |
| Canvas analysis | `CanvasAnalysisNode.tsx` | `analysis-` | Normal (chart/cards/table), minimised (icon at anchor corner) |

Z-order: DOM append order = conversion → container → post-it → analysis. See CANVAS_RENDERING_ARCHITECTURE.md.

Minimise/maximise logic: see CANVAS_OBJECT_DISPLAY_STATES.md.

## Context menus (11)

| Menu | Component | Trigger |
|------|-----------|---------|
| Canvas background | `canvas/CanvasContextMenus.tsx` | Right-click canvas |
| Conversion node | `NodeContextMenu.tsx` | Right-click node |
| Edge | `EdgeContextMenu.tsx` | Right-click edge |
| Container | `ContainerContextMenu.tsx` | Right-click container |
| Post-it | `PostItContextMenu.tsx` | Right-click post-it |
| Canvas analysis | `CanvasAnalysisContextMenu.tsx` | Right-click analysis card |
| Scenario | `ScenarioContextMenu.tsx` | Right-click scenario legend |
| Navigator item | `NavigatorItemContextMenu.tsx` | Right-click nav item |
| Navigator section | `NavigatorSectionContextMenu.tsx` | Right-click nav section header |
| Tab | `TabContextMenu.tsx` | Right-click tab |
| Multi-select | `MultiSelectContextMenu.tsx` | Right-click with multiple selected |

`CanvasContextMenus.tsx` is the dispatcher — it determines which specific menu to show based on what was right-clicked.

## Modals (21+)

All in `src/components/modals/`. Major groups:

- **Git**: MergeBranchModal, MergeConflictModal, NewBranchModal, SwitchBranchModal, SwitchRepositoryModal, RepositoryHistoryModal
- **Data**: DailyFetchManagerModal, AllSlicesModal, BatchOperationsModal
- **Scenarios**: ScenarioEditorModal, ScenarioQueryEditModal, BulkScenarioCreationModal
- **Other**: HashMappingModal, PinnedQueryModal, ShareLinkModal, CredsShareLinkModal, ForceReplaceOnPullModal, SyncIndexModal, GuardedOperationModal, ToBaseConfirmModal

Modals use `DialogContext.showConfirm()` for simple confirm/cancel, or render as standalone components with local open/close state.

## Notification systems

| System | Component | Position | Purpose |
|--------|-----------|----------|---------|
| BannerHost | `BannerHost.tsx` | Top of app | Version updates, countdown banners |
| OperationsToast | `OperationsToast.tsx` | Bottom-centre, fixed | Git/file/data operation progress |
| react-hot-toast | `Toaster` | Bottom-centre | General notifications (3s default) |
| ShareModeBanner | `ShareModeBanner.tsx` | Below banner host | Share mode indicator |
| AutomationBanner | `AutomationBanner.tsx` | Below others | Automation run progress |

OperationsToast auto-removes after 8s opaque + 2s fade + 20s semi-transparent. Errors never auto-remove.

## Element palette and tool modes

`ElementPalette.tsx` renders tool buttons: Select, Pan, New-Node, New-PostIt, New-Container, New-Analysis.

Selection sets `ElementToolContext.activeElementTool`. GraphCanvas reads this to change cursor and interaction mode. `useCanvasCreation` hook handles drop/click creation based on active tool.

Analysis creation uses a custom event: `window.dispatchEvent(new CustomEvent('dagnet:addAnalysis'))`.

## Chart settings pills

`charts/settingPillRenderer.tsx` is the shared renderer for inline display setting controls:

- Checkboxes (show_trend_line, cumulative, scale_with_canvas)
- Radio pills (series_type: bar/line, metric_mode: proportional/absolute)
- Custom renderers (colour scheme swatches)
- Short labels (day/week/month, grouped/stacked/100%)

Used by `AnalysisChartContainer` (chart toolbar) and `ExpressionToolbarTray` (expression display options).

## Display state management patterns

The codebase uses 7 distinct patterns for UI state. Choose the right one:

| Pattern | When to use | Persists? | Example |
|---------|-------------|-----------|---------|
| **React useState** | Transient UI (collapse, hover, modal open) | No | CollapsibleSection, modal visibility |
| **React useRef** | Session-only guards, animation flags | No | `hasAutoOpenedRef`, `restoreAnimUntilRef` |
| **React context** | Shared across sibling components in a subtree | No (unless context syncs) | ElementToolContext, WhatIfContext |
| **Tab editorState (IDB)** | Per-tab preferences that should survive reload | Yes | ViewPreferences, sidebar state, whatIfDSL |
| **Graph data (IDB)** | Part of the graph structure, saved to file | Yes | Canvas analysis minimised, post-it minimised |
| **rc-dock layout** | Panel positions, tab arrangement, floating windows | Yes (JSON) | Sidebar panels, dock layout |
| **localStorage** | Global user preferences | Yes | Theme, dismissed banners |

**Decision tree**:
1. Does it affect the saved graph file? → **Graph data**
2. Does it need to survive page reload but is per-tab? → **Tab editorState**
3. Is it a panel/dock arrangement? → **rc-dock layout**
4. Is it shared across components in same subtree? → **Context**
5. Is it transient interaction state? → **useState** or **useRef**
6. Is it global user preference? → **localStorage**

## Key files

| File | Role |
|------|------|
| `src/AppShell.tsx` | Top-level providers + app layout |
| `src/layouts/defaultLayout.ts` | App-level rc-dock config |
| `src/layouts/graphSidebarLayout.ts` | Graph sidebar rc-dock config |
| `src/layouts/dashboardDockLayout.ts` | Dashboard grid layout |
| `src/components/editors/GraphEditor.tsx` | Nested layout, sidebar, canvas |
| `src/components/GraphCanvas.tsx` | ReactFlow canvas, sync effects |
| `src/components/ElementPalette.tsx` | Tool mode buttons |
| `src/components/canvas/CanvasContextMenus.tsx` | Context menu dispatcher |
| `src/components/BannerHost.tsx` | Banner system |
| `src/components/OperationsToast.tsx` | Operation progress |
| `src/components/charts/settingPillRenderer.tsx` | Chart settings pills |
| `src/contexts/DialogContext.tsx` | Modal/dialog system |
| `src/contexts/ElementToolContext.tsx` | Tool mode state |
| `src/contexts/ViewPreferencesContext.tsx` | Per-tab view toggles |
