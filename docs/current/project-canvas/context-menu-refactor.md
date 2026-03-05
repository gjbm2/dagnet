# Context Menu Consolidation

**Status**: Scoped — ready to implement  
**Date**: 5-Mar-26  
**Priority**: Should be done before Phase 2 (containers will add another context menu)

---

## 1. Problem

There are 9+ context menu implementations across the codebase using 3 different styling approaches. This causes:

- Inconsistent border-radius (4px vs 6px)
- Inconsistent padding (6px 12px vs 8px 12px)
- Mixed icon treatment (none / emoji / Lucide) even within the same menu
- Hardcoded light-mode colours in dividers and labels (no dark mode)
- Different DOM elements (`<div>` vs `<button>`)
- Duplicated positioning/viewport-constraining logic

---

## 2. Current State

### 2.1 Styling Approaches

| Approach | Used by | Notes |
|----------|---------|-------|
| Shared `ContextMenu` component (inline styles, theme-aware) | PostItContextMenu, TabContextMenu (root), NavigatorItemContextMenu, NavigatorSectionContextMenu, ScenariosPanel | No icon support; item-array pattern |
| `dagnet-popup` CSS classes | EdgeContextMenu, DataSectionSubmenu, ConversionEdge inline menu, GraphCanvas pane menu | Has dark mode via `[data-theme="dark"]`; some files don't import the CSS directly |
| Fully inline styles (no classes, no shared component) | NodeContextMenu, WindowSelector, QueryExpressionEditor, RemoveOverridesMenuItem | Duplicated hover logic; hardcoded colours; no dark mode on some |

### 2.2 Specific Inconsistencies

| Issue | Affected files |
|-------|---------------|
| `border-radius: 4px` (should be 6px) | NodeContextMenu |
| Container `padding: 8px` (should be 4px) | EdgeContextMenu |
| Item `padding: 6px 12px` (should be 8px 12px) | TabBar/TabContextMenu |
| Hardcoded `#eee` dividers (not theme-aware) | NodeContextMenu, DataSectionSubmenu |
| Hardcoded `color: '#333'` labels (not theme-aware) | EdgeContextMenu labels |
| No dark mode at all | WindowSelector preset menu |
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

---

## 4. Implementation Plan

### 4a. Update `popup-menu.css` — add icon item variant

Add `.dagnet-popup-item-icon` (or just rely on the existing flex layout with a nested `<span>` for icon + label). Add `.dagnet-popup-label` for section headers (font-size 12px, font-weight 600, not clickable). Ensure all colour values have dark-mode counterparts.

**File**: `graph-editor/src/styles/popup-menu.css`

### 4b. Update shared `ContextMenu` component — emit `dagnet-popup` classes + icon support

Replace the inline styles in `MenuLevel` with `dagnet-popup` / `dagnet-popup-item` classes. Add optional `icon?: React.ReactNode` to `ContextMenuItem`. When present, render the icon before the label in a flex row.

This makes all consumers of the shared component (PostItContextMenu, TabContextMenu, NavigatorItemContextMenu, NavigatorSectionContextMenu, ScenariosPanel) automatically consistent.

**File**: `graph-editor/src/components/ContextMenu.tsx`

### 4c. NodeContextMenu — use `dagnet-popup` classes

Replace inline styles on the container and all items with `dagnet-popup` / `dagnet-popup-item` classes. Replace hardcoded `#eee` dividers with `dagnet-popup-divider`. Replace emoji paste icons (📋) with Lucide `Clipboard` icon. Keep all functional logic unchanged.

This is the largest single file change because NodeContextMenu is ~1000 lines with many items. But the change is purely mechanical: swap inline `style={{...}}` for `className="dagnet-popup-item"`.

**File**: `graph-editor/src/components/NodeContextMenu.tsx`

### 4d. EdgeContextMenu — fix container padding, theme-aware labels

Container padding 8px → 4px (standard). Section header labels (`color: '#333'`) → use CSS class for theme awareness. Already uses `dagnet-popup` classes for most items.

**File**: `graph-editor/src/components/EdgeContextMenu.tsx`

### 4e. GraphCanvas pane context menu — Lucide icons, `dagnet-popup` classes

Replace emoji icons (🖥️ ✖ ➕ 📝 📋 ⬜) with Lucide equivalents. Use `dagnet-popup-item` class on all items.

**File**: `graph-editor/src/components/GraphCanvas.tsx` (pane context menu JSX block)

### 4f. RemoveOverridesMenuItem — use `dagnet-popup-item` class

Replace inline styles with `dagnet-popup-item` class. Already uses Lucide `RotateCcw` icon.

**File**: `graph-editor/src/components/RemoveOverridesMenuItem.tsx`

### 4g. DataSectionSubmenu — theme-aware dividers

Replace hardcoded `#eee` dividers with `dagnet-popup-divider` class. Already imports `popup-menu.css` and uses `dagnet-popup` classes.

**File**: `graph-editor/src/components/DataSectionSubmenu.tsx`

### 4h. WindowSelector preset menu — use `dagnet-popup` classes + dark mode

Replace inline styles with `dagnet-popup` / `dagnet-popup-item`. This adds dark mode support automatically.

**File**: `graph-editor/src/components/WindowSelector.tsx` (preset context menu block)

### 4i. QueryExpressionEditor chip menu — use `dagnet-popup` classes

Replace inline styles with `dagnet-popup` / `dagnet-popup-item`. Already uses `dark` flag but has inline colours.

**File**: `graph-editor/src/components/QueryExpressionEditor.tsx` (chip context menu block)

### 4j. TabBar/TabContextMenu (Radix) — align padding

The TabBar uses Radix `DropdownMenu` with its own CSS classes (`tab-context-menu`, `tab-context-item`). Update `TabBar.css` to match standard dimensions (padding 8px 12px). This one uses a different mechanism (Radix) so it keeps its own classes but with aligned values.

**File**: `graph-editor/src/components/TabBar/TabBar.css`

### 4k. ConversionEdge inline context menu — use `dagnet-popup` classes

The edge label right-click menu already uses `dagnet-popup` classes. Verify it uses `dagnet-popup-divider` for dividers and has no hardcoded colours.

**File**: `graph-editor/src/components/edges/ConversionEdge.tsx`

---

## 5. Risk Assessment

**Low risk overall.** All changes are CSS class swaps — no functional logic changes, no data flow changes, no new state.

**Medium risk items:**
- NodeContextMenu (4c) is large and complex. Careful not to accidentally remove a `stopPropagation()` or `onClick` handler during the class migration. Do this as a focused, line-by-line pass.
- Shared ContextMenu (4b) is used by 5 different menus. Changes to its rendering must be backward-compatible. The icon field is optional, so existing consumers are unaffected.

**Testing**: manual verification of each menu in both light and dark mode. No automated tests needed — this is purely visual.

---

## 6. Order of Work

1. **4a** (CSS) + **4b** (shared component) — foundation
2. **4c** (NodeContextMenu) — highest-impact fix
3. **4d** (EdgeContextMenu) — quick fix
4. **4e** (pane menu) — quick fix
5. **4f–4k** (remaining menus) — mechanical cleanup

Total estimate: 1–2 focused sessions. Each step is independently shippable.
