# Context Menu Consolidation

**Status**: Scoped — ready to implement  
**Date**: 5-Mar-26 (updated 9-Mar-26: full menu audit, target structures, registry-driven display settings)  
**Priority**: Phase 4 of canvas objects work

---

## 1. Problem

There are 15+ context menu implementations across the codebase using 3 different styling approaches. This causes:

- Inconsistent border-radius (4px vs 6px)
- Inconsistent padding (6px 12px vs 8px 12px)
- Mixed icon treatment (none / emoji / Lucide) even within the same menu
- Hardcoded light-mode colours in dividers and labels (no dark mode)
- Different DOM elements (`<div>` vs `<button>`)
- Duplicated positioning/viewport-constraining logic
- Canvas analysis context menu missing key actions (Open as Tab, Refresh) and display settings

---

## 2. Current State

### 2.1 Styling Approaches

| Approach | Used by | Notes |
|----------|---------|-------|
| Shared `ContextMenu` component (inline styles, theme-aware) | PostItContextMenu, CanvasAnalysisContextMenu, TabContextMenu (root), NavigatorItemContextMenu, NavigatorSectionContextMenu, ScenariosPanel | No icon support; item-array pattern |
| `dagnet-popup` CSS classes | EdgeContextMenu, DataSectionSubmenu, ConversionEdge inline menu, GraphCanvas pane menu | Has dark mode via `[data-theme="dark"]`; some files don't import the CSS directly |
| Fully inline styles (no classes, no shared component) | NodeContextMenu, WindowSelector, QueryExpressionEditor, RemoveOverridesMenuItem | Duplicated hover logic; hardcoded colours; no dark mode on some |
| Radix DropdownMenu with own CSS | TabBar/TabContextMenu | Separate system, own `tab-context-*` classes |

### 2.2 Specific Inconsistencies

| Issue | Affected files |
|-------|---------------|
| `border-radius: 4px` (should be 6px) | NodeContextMenu |
| Container `padding: 8px` (should be 4px) | EdgeContextMenu |
| Item `padding: 6px 12px` (should be 8px 12px) | TabBar/TabContextMenu |
| Hardcoded `#eee` dividers (not theme-aware) | NodeContextMenu, DataSectionSubmenu |
| Hardcoded `color: '#333'` labels (not theme-aware) | EdgeContextMenu labels |
| No dark mode at all | WindowSelector preset menu, RemoveOverridesMenuItem |
| Emoji icons (📋 ➕ 📝 etc.) | GraphCanvas pane menu, NodeContextMenu paste items, EdgeContextMenu paste |
| No icon support | Shared ContextMenu component |
| `<button>` elements instead of `<div>` | WindowSelector, QueryExpressionEditor |

---

## 3. Target State

All context menus use `dagnet-popup` / `dagnet-popup-item` CSS classes for layout and theming. Menus that need the item-array pattern continue using the shared `ContextMenu` component, which is updated to emit `dagnet-popup` classes. Menus with complex custom content (NodeContextMenu, EdgeContextMenu) use the CSS classes directly on their hand-written JSX.

### 3.1 Standard Dimensions

| Property | Value |
|----------|-------|
| Container border-radius | 6px |
| Container padding | 4px |
| Item padding | 8px 12px |
| Item border-radius | 2px |
| Font size | 13px |
| Divider margin | 4px 0 |
| Min width | 160px |
| Icon size | 14px (Lucide) |
| Icon–label gap | 8px |

### 3.2 Icon Policy

- All icons are **Lucide** (14px). No emoji in menus.
- Icons are optional — not every item needs one.
- Items with icons use `display: flex; align-items: center; gap: 8px`.
- The shared `ContextMenu` component gains an optional `icon` field on `ContextMenuItem`.

### 3.3 Theme Support

All menus get dark mode automatically via the `[data-theme="dark"] .dagnet-popup` CSS rules already in `popup-menu.css`. No inline colour calculations needed.

### 3.4 Registry-Driven Display Settings in Context Menus

The `analysisDisplaySettingsRegistry` already marks settings with `contextMenu: true`. A new helper function `buildContextMenuSettingItems()` in the registry converts `DisplaySettingDef[]` into `ContextMenuItem[]`:

- **checkbox** → `{ label: 'Show legend', icon: <Check /> when active, onClick: toggle }`
- **radio** → `{ label: 'Sort by', submenu: [{ label: 'Graph order', icon: <Check /> when active }, ...] }`

This is the same pattern as `renderTraySetting()` (floating toolbar) and `renderSettingControl()` (props panel) — three rendering functions, one registry. No bespoke per-setting code in any menu.

---

## 4. Target Menu Structures

### 4.1 PostItContextMenu

Uses shared `ContextMenu`. No structural changes — add icons only.

| Item | Icon | Conditional | Submenu |
|------|------|-------------|---------|
| Colour | `Palette` | — | Canary Yellow, Power Pink, Aqua Splash, Limeade, Neon Orange, Iris (● for current) |
| Font Size | `Type` | — | Small, Medium, Large, Extra Large (● for current) |
| ──── | | `postitCount > 1` | |
| Bring to Front | `ArrowUpToLine` | `postitCount > 1` | |
| Bring Forward | `ArrowUp` | `postitCount > 1` | |
| Send Backward | `ArrowDown` | `postitCount > 1` | |
| Send to Back | `ArrowDownToLine` | `postitCount > 1` | |
| ──── | | | |
| Copy | `Copy` | | |
| Cut | `Scissors` | | |
| Delete | `Trash2` | | |

### 4.2 ContainerContextMenu

Uses shared `ContextMenu`. No structural changes — add icons only.

| Item | Icon | Conditional | Submenu |
|------|------|-------------|---------|
| Colour | `Palette` | — | Colour options from `CONTAINER_COLOURS` (● for current) |
| ──── | | `containerCount > 1` | |
| Bring to Front | `ArrowUpToLine` | `containerCount > 1` | |
| Bring Forward | `ArrowUp` | `containerCount > 1` | |
| Send Backward | `ArrowDown` | `containerCount > 1` | |
| Send to Back | `ArrowDownToLine` | `containerCount > 1` | |
| ──── | | | |
| Copy | `Copy` | | |
| Cut | `Scissors` | | |
| Delete | `Trash2` | | |

### 4.3 CanvasAnalysisContextMenu — significant changes

Uses shared `ContextMenu`. Adds: registry-driven Display submenu, Open as Tab, Refresh.

New props: `effectiveChartKind?: string`, `display?: Record<string, unknown>`, `onDisplayChange?: (key: string, value: any) => void`, `onOpenAsTab?: () => void`, `onRefresh?: () => void`.

| Item | Icon | Conditional | Submenu / Notes |
|------|------|-------------|-----------------|
| View Mode | `Eye` | — | Chart (● when active), Cards (● when active) |
| ──── | | | |
| Switch to Custom scenarios | `Lock` | `analysis.live` | Captures from tab, sets `live: false` |
| Return to Live scenarios | `Zap` | `!analysis.live` | Clears scenarios, sets `live: true` |
| Edit scenario DSL | `Code` | `!live && scenarios.length > 0` | One item per scenario |
| Use as Current query | `ArrowUpCircle` | `!live && current has DSL` | Pushes DSL to `graphStore.setCurrentDSL` |
| ──── | | | |
| Display | `SlidersHorizontal` | `effectiveChartKind` set | Registry-driven submenu via `buildContextMenuSettingItems()` |
| ──── | | | |
| Open as Tab | `ExternalLink` | result available | Opens chart in new tab |
| Refresh | `RefreshCw` | — | Re-triggers compute |
| ──── | | `analysisCount > 1` | |
| Bring to Front | `ArrowUpToLine` | `analysisCount > 1` | |
| Bring Forward | `ArrowUp` | `analysisCount > 1` | |
| Send Backward | `ArrowDown` | `analysisCount > 1` | |
| Send to Back | `ArrowDownToLine` | `analysisCount > 1` | |
| ──── | | | |
| Copy | `Copy` | | |
| Cut | `Scissors` | | |
| Delete | `Trash2` | | |

**Display submenu contents** (varies by `effectiveChartKind`, driven by `contextMenu: true` in registry):

For `daily_conversions` (densest case, ~14 items):
- Show legend (checkbox)
- Show data labels (checkbox)
- Y-axis scale > Linear / Logarithmic (radio submenu)
- Series type > Bar / Line (radio submenu)
- Group by > Day / Week / Month (radio submenu)
- Moving average > None / 3-day / 7-day / 14-day / 30-day (radio submenu)
- Stack mode > Grouped / Stacked / 100% (radio submenu)
- Metric > Proportional / Absolute (radio submenu)
- Sort by > Graph order / Value / Name (radio submenu)
- Show trend line (checkbox)
- Smooth lines (checkbox)
- Show point markers (checkbox)
- Area fill (checkbox)
- Cumulative values (checkbox)

For `cards` view mode: just Font size > S / M / L / XL.

### 4.4 NodeContextMenu

Hand-written JSX. Replace inline styles with `dagnet-popup` classes, emoji with Lucide. Add "Add chart from selection" item.

| Item | Icon | Conditional | Notes |
|------|------|-------------|-------|
| Properties | `Settings` | — | Selects node + opens Properties panel |
| Add chart from selection | `BarChart3` | | **NEW** — dispatches `dagnet:addAnalysis` with current selection DSL, enters draw mode |
| Paste node: {id} | `Clipboard` | `copiedNode` | Was emoji 📋 |
| Paste case: {id} | `Clipboard` | `copiedCase` | Was emoji 📋 |
| Paste event: {id} | `Clipboard` | `copiedEvent` | Was emoji 📋 |
| ──── | | `hasVariants` | |
| *Variant Weights* | | `hasVariants` | `.dagnet-popup-label` header, inline `VariantWeightInput` per variant |
| ──── | | `dataOperationSections.length > 0` | |
| *Data sections* | | Per section | `DataSectionSubmenu` (see §4.11) |
| ──── | | | |
| Copy (N nodes) | `Copy` | | Was `Clipboard` |
| Cut (N nodes) | `Scissors` | | |
| ──── | | | |
| Copy vars (N nodes) | `ClipboardCopy` | | |
| Remove overrides (N) | `RotateCcw` | `hasOverrides` | Already Lucide |
| Show in new graph (N) | `Share2` | `isMultiSelect` | Already Lucide |
| ──── | | | |
| Show N nodes / Hide N nodes | `Eye` / `EyeOff` | | Toggle based on `allHidden` |
| Delete node | `Trash2` | | |

### 4.5 EdgeContextMenu

Hand-written JSX, partial `dagnet-popup`. Fix padding, labels, dividers. Replace remaining emoji.

| Item | Icon | Conditional | Notes |
|------|------|-------------|-------|
| *Probability* | | — | Inline `ParameterEditor` (slider, rebalance, clear) |
| *Conditional Probabilities* | | `hasConditionalP` | One `ParameterEditor` per conditional |
| *Variant Weight (name)* | | `isCaseEdge` | Inline `ParameterEditor` |
| ──── | | `dataOperationSections.length > 0` | |
| *Data sections* | | Per section | `DataSectionSubmenu` (see §4.11) |
| ──── | | | |
| Confidence Intervals | `ChevronRight` | — | Submenu: 99%, 95%, 90%, 80%, None (`Check` icon for current) |
| Animate Flow | | — | `Check` icon when active |
| ──── | | | |
| Copy vars (N edges) | `ClipboardCopy` | | |
| Paste parameter: {id} | `Clipboard` | `copiedParameter` | Was emoji 📋 |
| Remove overrides (N) | `RotateCcw` | `hasOverrides` | Already Lucide |
| Snapshot Manager | `Camera` | `edgeData?.p?.id` | |
| ──── | | | |
| Add chart from selection | `BarChart3` | | **NEW** — dispatches `dagnet:addAnalysis` with current selection DSL, enters draw mode |
| Properties | `Settings` | | |
| Delete edge | `Trash2` | | |

Changes: container padding 8px → 4px; section header labels `color: '#333'` → `.dagnet-popup-label`; `✓` selection markers → Lucide `Check`; `#eee` dividers → `.dagnet-popup-divider`.

### 4.6 GraphCanvas Pane Context Menu

Hand-written JSX, already `dagnet-popup`. Replace emoji with Lucide, add dividers, add "Add chart" item.

| Item | Icon | Conditional | Notes |
|------|------|-------------|-------|
| Enter/Exit dashboard mode | `Monitor` / `MonitorOff` | | Was emoji 🖥️ |
| Close tab | `X` | `tabId` | Was emoji ✖ |
| ──── | | | **NEW divider** |
| Add node | `Plus` | | Was emoji ➕ |
| Add post-it | `StickyNote` | | Was emoji 📝 |
| Add container | `Square` | | Was emoji ▢ |
| Add chart | `BarChart3` | | **NEW item** — dispatches `dagnet:addAnalysis`, enters draw mode (blank chart, no selection DSL) |
| ──── | | | **NEW divider** |
| Paste node: {id} | `Clipboard` | `copiedNode` | Was emoji 📋 |
| Paste (N nodes, N edges, …) | `Clipboard` | `copiedSubgraph` | Was emoji 📋 |
| ──── | | | **NEW divider** |
| Select All | `CheckSquare` | `nodes.length > 0` | Was emoji ⬜ |

### 4.7 TabContextMenu (Root, Position-Based)

Uses shared `ContextMenu`. Add icons for key items. No structural changes.

| Item | Icon | Conditional | Notes |
|------|------|-------------|-------|
| Open Editor View | `FileText` | | |
| Open JSON View | `Code` | | |
| Open YAML View | `Code` | | |
| ──── | | | |
| Save | `Save` | `!isTemporaryFile` | |
| Revert | `Undo2` | `!isTemporaryFile` | |
| Discard Changes | `Undo2` | `!isTemporary && isDirty` | |
| Duplicate... | `Copy` | `!isTemporaryFile` | |
| ──── | | graph tab, interactive | |
| Reset Sidebar | `PanelLeftClose` | graph tab, interactive | |
| ──── | | `!isTemporaryFile` | |
| Pull Latest | `Download` | `canPull` | |
| Pull All Latest | `Download` | | |
| Commit This File... | `Upload` | `isFileCommittable` | |
| Commit All Changes... | `Upload` | | |
| View History | `History` | `canViewHistory` | |
| Open Historical Version | `Clock` | `canOpenHistorical` | Submenu: date → commits |
| Snapshot Manager... | `Camera` | `canManageSnapshots` | |
| ──── | | | |
| Delete | `Trash2` | `!isTemporaryFile` | |
| ──── | | | |
| Close | `X` | | |
| Close Others | | | |
| Close All | | | |
| ──── | | `canShare` | |
| Copy Working Link | `Link` | `canCopyWorkingLink` | |
| Copy Static Share Link | `Link` | `canShareStatic` | |
| Copy Live Share Link | `Link` | | Disabled if not live |
| ──── | | | |
| Copy File ID | `Clipboard` | | |

### 4.8 TabBar/TabContextMenu (Radix)

Radix DropdownMenu with own `tab-context-*` CSS. Align padding to standard dimensions only. No icon changes (Radix system, separate mechanism).

Changes: `tab-context-item` padding → `8px 12px`.

### 4.9 NavigatorItemContextMenu

Uses shared `ContextMenu`. Add icons for key items. No structural changes.

| Item | Icon | Conditional | Notes |
|------|------|-------------|-------|
| Open in Editor | `FileText` | | |
| Open as JSON | `Code` | | |
| Open as YAML | `Code` | | |
| Copy | `Copy` | `canCopy` (node/param/case) | |
| ──── | | | |
| Close All Views (N) | `X` | `openTabs.length > 0` | |
| ──── | | | |
| Rename... | `Pencil` | | Disabled if `!canRename` |
| Duplicate... | `Copy` | | |
| Edit Tags... | `Tag` | | |
| Add to / Remove from Favourites | `Star` / `StarOff` | | |
| ──── | | | |
| Commit This File... | `Upload` | `isFileCommittable` | |
| Commit All Changes... | `Upload` | | |
| View History | `History` | `canViewHistory` | |
| Open Historical Version | `Clock` | `canOpenHistorical` | Submenu: date → commits |
| Where Used... | `Search` | `canSearchWhereUsed` | |
| Copy Working Link | `Link` | `canShare && canCopyWorkingLink` | |
| Copy Static Share Link | `Link` | `canShare && canShareStatic` | |
| Copy Live Share Link | `Link` | `canShare` | |
| Clear data file | `Trash2` | `isDataFile` | Disabled if `!hasDataToClear` |
| Snapshots | `Camera` | `item.type === 'parameter'` | Submenu: Download, Delete N, Manage... |
| Snapshot Manager... | `Camera` | `item.type === 'graph' && canManageSnapshots` | |
| ──── | | | |
| Pull Latest | `Download` | `canPull` | |
| Pull All Latest | `Download` | | |
| Revert | `Undo2` | | |
| Discard Changes | `Undo2` | `isDirty` | |
| ──── | | | |
| Delete | `Trash2` | | |
| ──── | | | |
| Copy Name | `Clipboard` | | |
| Copy Path | `Clipboard` | | |

### 4.10 NavigatorSectionContextMenu

Uses shared `ContextMenu`. Single item — add icon.

| Item | Icon | Notes |
|------|------|-------|
| New {SectionType}... | `Plus` | Opens NewFileModal |

### 4.11 DataSectionSubmenu

Hand-written JSX submenu, used by NodeContextMenu and EdgeContextMenu. Already uses `dagnet-popup`. Fix dividers and hint colours.

| Item | Icon | Conditional | Notes |
|------|------|-------------|-------|
| Open file | `FileText` | | |
| ──── | | | Replace `#eee` → `.dagnet-popup-divider` |
| Get from Source (direct) | `Database` | `ops.getFromSourceDirect` | |
| Get from Source | `DatabaseZap` | `ops.getFromSource` | |
| Get from file | `Folders` | `ops.getFromFile` | |
| Put to file | `Upload` | `ops.putToFile` | |
| ──── | | `ops.clearCache` | Replace `#eee` → `.dagnet-popup-divider` |
| Unsign file cache | `X` | `ops.clearCache` | |
| Clear data file | `Trash2` | `ops.clearDataFile` | |
| Manage snapshots... | `Camera` | `onManageSnapshots` | |

Hint text colours `#666`/`#999` → `.dagnet-popup-hint` class.

### 4.12 ConversionEdge Inline Context Menu

Hand-written JSX, already `dagnet-popup`. Verify only.

| Item | Icon | Conditional | Notes |
|------|------|-------------|-------|
| Reconnect Source | | | |
| Reconnect Target | | | |
| ──── | | | Already `.dagnet-popup-divider` |
| Delete Edge | | | `.dagnet-popup-item.danger` |

Hidden when `data?.scenarioOverlay` is set.

### 4.13 WindowSelector Preset Context Menu

Hand-written JSX, inline styles, no dark mode. Replace with `dagnet-popup` classes.

| Item | Icon | Conditional | Notes |
|------|------|-------------|-------|
| Create scenario ({dsl}) | `Zap` | | Per window offset (3 items) |
| ──── | | | |
| Create 4 scenarios | `Zap` | | Weekly/monthly/quarterly batch |

### 4.14 QueryExpressionEditor Chip Context Menu

Hand-written JSX, inline theme styles. Replace with `dagnet-popup` classes.

| Item | Icon | Conditional | Notes |
|------|------|-------------|-------|
| Remove | `X` | | Removes chip from expression |
| ──── | | `contextKey && contextValuesCount > 0` | |
| Create N scenarios... | `Zap` | `contextKey && contextValuesCount > 0` | Creates scenarios from context values |

### 4.15 ScenariosPanel Context Menu

Uses shared `ContextMenu`. Add icons. No structural changes.

| Item | Icon | Conditional | Notes |
|------|------|-------------|-------|
| Hide / Show | `EyeOff` / `Eye` | | Toggle visibility |
| Show only | `Eye` | | Hide all others |
| ──── | | | |
| Edit | `Code` | | Opens scenario editor |
| Share link (static) | `Link` | `canShareScenario` | |
| Share link (live) | `Link` | `canShareScenario` | |
| Use as current | `ArrowUpCircle` | `scenarioId !== 'current'` | |
| Merge down | `ArrowDownCircle` | `hasLayerBelow` | |
| ──── | | `isUserScenario` | |
| Delete | `Trash2` | `isUserScenario` | |

### 4.16 RemoveOverridesMenuItem

Single composite item used by NodeContextMenu and EdgeContextMenu. Replace inline styles with `.dagnet-popup-item`.

| Item | Icon | Conditional | Notes |
|------|------|-------------|-------|
| Remove overrides (N) | `RotateCcw` | `hasOverrides` | Already Lucide |

---

## 5. Registry Helper: `buildContextMenuSettingItems()`

Add to `analysisDisplaySettingsRegistry.ts`. Pure function: takes registry defs + current display state, returns `ContextMenuItem[]`.

```
function buildContextMenuSettingItems(
  chartKind: string | undefined,
  viewMode: 'chart' | 'cards',
  display: Record<string, unknown> | undefined,
  onChange: (key: string, value: any) => void,
): ContextMenuItem[]
```

Rendering rules (matching the contract table in the registry header):

- `type: 'checkbox'` → flat item with `Check` icon when value is truthy, toggle on click
- `type: 'radio'` → parent item with submenu, each option has `Check` icon when selected
- `type: 'select'` → same as radio (submenu)
- `type: 'slider'`, `number-range`, `text`, `list` → not rendered in context menus (already `contextMenu: false` in registry)

This is the third rendering function alongside `renderTraySetting()` (floating toolbar) and `renderSettingControl()` (props panel). All three are driven by the same `DisplaySettingDef[]` from the same registry.

---

## 6. Implementation Plan

### 6a. Update `popup-menu.css` — add label + divider classes

Add `.dagnet-popup-label` for section headers (font-size 12px, font-weight 600, padding 4px 12px, muted colour, not clickable). Add dark-mode counterpart. Existing `.dagnet-popup-item`, `.dagnet-popup-divider`, `.dagnet-popup-hint`, `.dagnet-popup-arrow` are sufficient for all other cases.

**File**: `graph-editor/src/styles/popup-menu.css`

### 6b. Update shared `ContextMenu` component — emit `dagnet-popup` classes + icon support

Replace all inline styles in `MenuLevel` with `dagnet-popup` / `dagnet-popup-item` / `dagnet-popup-divider` CSS classes. Add optional `icon?: React.ReactNode` to `ContextMenuItem`. When present, render icon before label. Remove `MenuColours` interface, `LIGHT_COLOURS`, `DARK_COLOURS` constants, and `useTheme()` import — dark mode handled entirely by CSS.

All consumers (PostItContextMenu, ContainerContextMenu, CanvasAnalysisContextMenu, TabContextMenu, NavigatorItemContextMenu, NavigatorSectionContextMenu, ScenariosPanel) get the visual update for free.

**File**: `graph-editor/src/components/ContextMenu.tsx`

### 6c. `buildContextMenuSettingItems()` helper

Add to `analysisDisplaySettingsRegistry.ts`. Implements the rendering rules from §5. Import `ContextMenuItem` type from `ContextMenu.tsx`.

**File**: `graph-editor/src/lib/analysisDisplaySettingsRegistry.ts`

### 6d. CanvasAnalysisContextMenu — add Display submenu, Open as Tab, Refresh

Wire `buildContextMenuSettingItems()` for the Display submenu. Add `effectiveChartKind`, `display`, `onDisplayChange`, `onOpenAsTab`, `onRefresh` props. Add Open as Tab and Refresh as top-level items. Add icons per §4.3.

Update `GraphCanvas.tsx` to pass the new props when rendering the context menu.

**File**: `graph-editor/src/components/CanvasAnalysisContextMenu.tsx`, `graph-editor/src/components/GraphCanvas.tsx`

### 6e. NodeContextMenu — use `dagnet-popup` classes, add "Add chart from selection"

Replace container inline styles with `className="dagnet-popup"`. Replace all item inline styles with `className="dagnet-popup-item"`. Replace `#eee` dividers with `.dagnet-popup-divider`. Replace section labels with `.dagnet-popup-label`. Replace emoji paste icons with Lucide `Clipboard`. Add icons per §4.4. Remove theme colour variables. Preserve all handlers exactly.

Add "Add chart from selection" item — dispatches `dagnet:addAnalysis` with current selection's DSL (same codepath as Element palette), enters draw mode.

**File**: `graph-editor/src/components/NodeContextMenu.tsx`

### 6f. EdgeContextMenu — fix padding, labels, dividers

Container padding 8px → 4px (inherit from `.dagnet-popup`). Section header labels → `.dagnet-popup-label`. `✓` markers → Lucide `Check`. Paste emoji → Lucide `Clipboard`. Dividers → `.dagnet-popup-divider`.

**File**: `graph-editor/src/components/EdgeContextMenu.tsx`

### 6f-edge. EdgeContextMenu — add "Add chart from selection"

Add "Add chart from selection" item — same `dagnet:addAnalysis` dispatch with selection DSL. Placed above Properties.

**File**: `graph-editor/src/components/EdgeContextMenu.tsx`

### 6g. GraphCanvas pane menu — Lucide icons, dividers, add chart

Replace emoji with Lucide per §4.6. Add dividers between logical groups. Add "Add chart" item (dispatches `dagnet:addAnalysis`, enters draw mode with no selection DSL).

**File**: `graph-editor/src/components/GraphCanvas.tsx`

### 6h. Remaining shared-component menus — add icons

Add icons to PostItContextMenu (§4.1), ContainerContextMenu (§4.2), NavigatorItemContextMenu (§4.9), NavigatorSectionContextMenu (§4.10), ScenariosPanel (§4.15) per target tables above.

**Files**: `PostItContextMenu.tsx`, `ContainerContextMenu.tsx`, `NavigatorItemContextMenu.tsx`, `NavigatorSectionContextMenu.tsx`, `ScenariosPanel.tsx`

### 6i. Mechanical cleanup — remaining menus

- **RemoveOverridesMenuItem** (§4.16): inline styles → `.dagnet-popup-item`
- **DataSectionSubmenu** (§4.11): `#eee` dividers → `.dagnet-popup-divider`, `#666`/`#999` → `.dagnet-popup-hint`
- **WindowSelector** (§4.13): inline styles → `dagnet-popup` classes (gains dark mode)
- **QueryExpressionEditor** (§4.14): inline theme styles → `dagnet-popup` classes
- **TabBar.css** (§4.8): align `tab-context-item` padding to `8px 12px`
- **ConversionEdge** (§4.12): verify, likely no changes

### 6j. TabContextMenu (root) — add icons

Add icons per §4.7.

**File**: `graph-editor/src/components/TabContextMenu.tsx`

---

## 7. Risk Assessment

**Low risk overall.** Most changes are CSS class swaps — no functional logic changes, no data flow changes, no new state.

**Medium risk items:**
- **NodeContextMenu (6e)** is large (~770 lines) and complex. Careful not to accidentally remove a `stopPropagation()` or `onClick` handler during the class migration. Line-by-line pass required.
- **Shared ContextMenu (6b)** is used by 7 different menus. Changes to its rendering must be backward-compatible. The icon field is optional, so existing consumers are unaffected.
- **CanvasAnalysisContextMenu (6d)** adds new functional items (Open as Tab, Refresh, Display submenu) — this is the only step with new behaviour, not just visual changes.

**Testing**: manual verification of each menu in both light and dark mode. The CanvasAnalysisContextMenu changes (6d) should be verified: Display submenu items update the chart, Open as Tab opens correct chart, Refresh triggers recompute.

---

## 8. Order of Work

1. **6a + 6b** (CSS + shared component) — foundation; everything else builds on this
2. **6c + 6d** (registry helper + CanvasAnalysisContextMenu) — new behaviour
3. **6e** (NodeContextMenu) — highest-impact visual fix, most complex
4. **6f + 6g** (EdgeContextMenu + pane menu) — moderate
5. **6h + 6i + 6j** (remaining menus) — mechanical cleanup

Each step is independently shippable. Total estimate: 2–3 focused sessions.
