# Element Palette in Sidebar — Design & Implementation

**Status**: Design required before implementation  
**Date**: 5-Mar-26  
**Context**: Phase 1e of canvas objects. The element palette must appear above the sidebar tabs when the sidebar is maximised, and in the icon bar when minimised.

---

## 1. Problem Statement

The element palette (Select, Pan, Node, Post-It icons) needs to render above the sidebar tab bar when the sidebar is maximised:

```
┌──────────────────────┐
│ [↖] [✋] │ [□] [📝]  │  ← element palette (above tabs, inside sidebar)
├──────────────────────┤
│ Scenarios │ Props    │  ← rc-dock tab bar
│ Tools │ Analytics    │
├──────────────────────┤
│  (panel content)     │
└──────────────────────┘
```

When minimised, the palette renders in the SidebarIconBar (already working).

The challenge: the sidebar is managed by rc-dock, and the codebase has extensive, fragile sidebar management code that directly manipulates the sidebar panel's DOM element. Any structural change to the rc-dock layout risks breaking resize, minimise/maximise, floating panels, saved layout restoration, and width tracking.

---

## 2. Current Sidebar Architecture

### 2.1 rc-dock Layout Structure

```
dockbox (horizontal)
  ├─ graph-canvas-panel (left, flex weight 1000)
  │   └─ canvas-tab
  └─ graph-sidebar-panel (right, fixed width)
      ├─ what-if-tab
      ├─ properties-tab
      ├─ tools-tab
      └─ analytics-tab
```

The sidebar is `dockbox.children[1]` — a single rc-dock panel with 4 tabs. It is NOT a box; it is a leaf panel.

### 2.2 DOM Element Targeting

The sidebar panel is found via `[data-dockid="graph-sidebar-panel"]`. This selector appears in 6 distinct locations in `GraphEditor.tsx`, each performing direct DOM manipulation:

| Location | Purpose |
|----------|---------|
| Mouseup handler (~line 719) | After resize: reads `getBoundingClientRect().width`, calls `setSidebarWidth` |
| useLayoutEffect #6b (~line 790) | Applies width CSS: minimised → 0, maximised → stored width |
| ResizeObserver setup (~line 854) | Observes the panel for size changes, applies stored width |
| ResizeObserver retry (~line 950) | Fallback if panel not found initially |
| Layout init fallback (~line 1324) | Measures initial width when no stored width exists |
| onLayoutChange tab restore (~line 2012) | Finds sidebar in `dockbox.children` to restore closed tabs |

### 2.3 Width Management

`sidebarState.sidebarWidth` stores the sidebar width as a number. On every relevant state change:

1. `useLayoutEffect` finds `[data-dockid="graph-sidebar-panel"]` and sets `flex`, `width`, `minWidth`, `maxWidth` inline styles
2. During resize, mousedown/mouseup on `.dock-divider` or `.dock-splitter` toggles `isResizing`
3. On mouseup after resize, the sidebar panel's final width is captured and persisted

### 2.4 Minimise/Maximise

- **Minimise**: sidebar panel gets `flex: 0 0 0px; width: 0px; minWidth: 0px; maxWidth: 0px`. The SidebarIconBar renders as a 48px absolute-positioned strip on the right.
- **Maximise**: sidebar panel gets `flex: 0 0 ${width}px; width: ${width}px`. The icon bar is hidden.

### 2.5 Saved Layout & Floating Panels

- `onLayoutChange` fires whenever rc-dock's layout changes (tabs moved, panels floated, etc.)
- The handler strips the sidebar's `size` before saving (width is managed separately)
- Floating panels are detected by examining `floatbox.children`
- "At home" is determined by `tabData.parent?.id === 'graph-sidebar-panel'`
- If all tabs are floated, the sidebar auto-minimises
- Missing (closed) tabs are restored by finding `graph-sidebar-panel` in `dockbox.children` and re-adding them

### 2.6 `createLayoutStructure`

Builds the initial layout from `getGraphEditorLayout()` / `getGraphEditorLayoutMinimized()`. Sets `dockbox.children[1].size` to the stored sidebar width. Injects React components into each tab. The function assumes `children[1]` is the sidebar panel directly.

---

## 3. Proposed Change: Sidebar Becomes a Vertical Box

To place the element palette above the tabs, the sidebar changes from a single panel to a **vertical box** containing two panels:

```
dockbox (horizontal)
  ├─ graph-canvas-panel (left, flex weight 1000)
  │   └─ canvas-tab
  └─ graph-sidebar-vbox (right, fixed width)      ← NEW: vbox wrapper
      ├─ element-palette-panel (fixed ~40px)       ← NEW: palette
      │   └─ element-palette-tab
      └─ graph-sidebar-panel (flex)                ← EXISTING: tabs
          ├─ what-if-tab
          ├─ properties-tab
          ├─ tools-tab
          └─ analytics-tab
```

### 3.1 Key Structural Difference

`dockbox.children[1]` changes from a **panel** (with `id: 'graph-sidebar-panel'`) to a **box** (with `mode: 'vertical'`, no `id` by default in rc-dock, or a custom `id` if supported). The actual tabbed panel moves one level deeper.

---

## 4. Impact Analysis — Every Affected Code Path

### 4.1 Width Management (useLayoutEffect #6b)

**Current**: targets `[data-dockid="graph-sidebar-panel"]` to set flex/width CSS.

**After change**: the vbox container is the element that needs width control, not the inner tabbed panel. rc-dock renders the vbox as a `.dock-box` div. It may or may not have a `data-dockid` attribute (boxes typically don't have IDs in rc-dock unless explicitly set).

**Required change**: target the vbox container instead. Options:
- Give the vbox an explicit `id` (e.g. `'graph-sidebar-vbox'`) and target `[data-dockid="graph-sidebar-vbox"]`
- Navigate the DOM: find `graph-sidebar-panel` and use `.closest('.dock-box')` to find its vbox parent
- Target `dockbox.children[1]` positionally (fragile if layout changes)

**Recommendation**: use `id` on the vbox if rc-dock supports it (check: does `BoxData.id` exist?). If not, use the `.closest('.dock-box')` approach.

### 4.2 Resize Detection (mousedown/mouseup)

**Current**: mousedown on `.dock-divider` / `.dock-splitter` sets `isResizing`. Mouseup reads sidebar panel width.

**After change**: the horizontal splitter is between the canvas and the vbox (not the canvas and the tabbed panel). There is also a vertical splitter between the palette panel and the tabbed panel (which should be hidden or disabled).

**Required changes**:
- Mouseup reads the **vbox container** width, not the tabbed panel width
- The vertical splitter between palette and tabbed panel must be hidden via CSS (`.dock-divider` inside the vbox) and prevented from being interactive
- Resize detection can stay as-is (it detects any splitter drag within the container)

### 4.3 Saved Layout Restoration

**Current**: `savedDockLayout` stores the layout tree. `reinjectComponents` walks it recursively. `stripSidebarSize` removes `size` from nodes with `id === 'graph-sidebar-panel'`.

**After change**: the layout tree now has a vbox between the dockbox and the tabbed panel. `stripSidebarSize` needs to strip size from the **vbox** (which controls the sidebar column width), not the inner panel. `reinjectComponents` already walks recursively, so it will find the palette tab as well as the sidebar tabs — just needs an injection for `element-palette-tab`.

**Required changes**:
- `stripSidebarSize`: target the vbox node, not `graph-sidebar-panel`
- `setSidebarSize` (in `createLayoutStructure`): set size on the vbox node, not `graph-sidebar-panel`
- `reinjectComponents`: add `element-palette-tab` injection

### 4.4 `createLayoutStructure`

**Current**: `layout.dockbox.children[1]` is the sidebar panel. Sets its `size` and injects tab components.

**After change**: `layout.dockbox.children[1]` is the vbox. The tabbed panel is `layout.dockbox.children[1].children[1]`. Size is set on the vbox. Tab injection targets the inner panel.

**Required changes**: update the positional references from `children[1]` (panel) to `children[1]` (vbox) for size, and `children[1].children[1]` (panel) for tab injection.

### 4.5 Floating Panel Tracking

**Current**: `tabData.parent?.id === 'graph-sidebar-panel'` determines "at home".

**After change**: same — tabs that are "at home" still have `parent.id === 'graph-sidebar-panel'` (the inner tabbed panel hasn't changed its ID). Floating detection is unaffected.

**No change needed.**

### 4.6 Minimise/Maximise

**Current**: minimise sets width to 0 on `graph-sidebar-panel`. Maximise sets it to the stored width.

**After change**: minimise/maximise sets width on the **vbox container**, not the inner panel. When minimised, both the palette and the tabbed panel are hidden (width 0 on the vbox).

**Required change**: target the vbox container in the useLayoutEffect. The inner panels don't need width management — the vbox handles the column width.

### 4.7 Tab Restore (onLayoutChange)

**Current**: finds `graph-sidebar-panel` in `dockbox.children` to add missing tabs.

**After change**: `graph-sidebar-panel` is now inside the vbox (`dockbox.children[1].children[1]`). The code needs to search recursively or navigate the vbox to find it.

**Required change**: use recursive search for `graph-sidebar-panel` instead of assuming it's a direct child of `dockbox.children`.

### 4.8 Palette Panel Configuration

The palette panel must be:
- **Non-resizable**: no splitter between palette and tabbed panel (or splitter hidden via CSS)
- **Non-floatable**: cannot be dragged out
- **Non-closable**: no close button
- **No tab bar**: uses the `graph-canvas` group (which hides tab bars via existing CSS)
- **Fixed height**: `size: 40` (rc-dock interprets as flex weight or pixels depending on context)

---

## 5. CSS Changes

```css
/* Hide element-palette tab bar (reuses existing pattern for canvas) */
.dock-bar:has([data-node-key="element-palette-tab"]) {
  display: none !important;
  height: 0 !important;
  /* ... same as canvas-tab hide rules ... */
}

/* Hide the vertical splitter between palette and sidebar panels */
/* This targets the dock-divider inside the sidebar vbox */
[data-dockid="graph-sidebar-vbox"] > .dock-divider {
  display: none !important;
  pointer-events: none !important;
}
```

The second selector depends on whether rc-dock sets `data-dockid` on box elements. If not, a structural selector (`.dock-box.dock-vbox > .dock-divider` within the sidebar area) is needed.

---

## 6. Palette Panel Content

The palette panel's content is injected via `reinjectComponents` as `ElementPalette` with `layout="horizontal"`, `activeTool`, and `onToolSelect` props.

When the sidebar is minimised, the palette panel is hidden (vbox width 0). The SidebarIconBar's palette (already working) provides the palette in minimised mode.

---

## 7. Open Questions

1. **Does rc-dock's `BoxData` support an `id` field?** If yes, the vbox can have `id: 'graph-sidebar-vbox'` and all DOM targeting uses `[data-dockid="graph-sidebar-vbox"]`. If not, DOM navigation (`.closest('.dock-box')`) is needed. *** HOW WILL YOU INVESTIGATE & ANSWER THIS? ***

2. **Does rc-dock render a splitter between children of a vbox?** If yes, it needs to be hidden. If the palette panel is the first child with a fixed size and the tabbed panel is the second with flex, rc-dock may render a draggable splitter between them. *** HOW WILL YOU INVESTIGATE & ANSWER THIS? ***

3. **Does changing `dockbox.children[1]` from a panel to a vbox break saved layout restoration?** Users with a saved layout in their tab state will have the old structure (single panel). The layout restoration code needs to handle migration: if `children[1]` is a panel (old format), wrap it in a vbox with the palette panel added. *** HOW WILL YOU INVESTIGATE & ANSWER THIS? ***

4. **Does the palette panel need to be in the minimised layout?** When minimised, the vbox has `size: 0`. The palette panel exists in the layout structure but is invisible. It could be omitted from the minimised layout for simplicity, but this creates a structural mismatch between maximised and minimised layouts that `loadLayout` transitions would need to handle. *** WE ALREADY DISPALY THE TOOLS IN MINIMISED LAYOUT JUST FINE, SO DON'T SEE WHY WE NEED IT IN MINIMISED MODE ***

---

## 8. Implementation Steps

### Step 1: Verify rc-dock capabilities

- Check if `BoxData.id` is supported (read rc-dock source/types)
- Check how splitters render between vbox children
- Check if `PanelData.panelLock` can prevent resize/float/close for the palette panel

### Step 2: Update layout structures

- `getGraphEditorLayout()`: change `children[1]` from panel to vbox with palette + tabbed panel
- `getGraphEditorLayoutMinimized()`: same structural change
- Set palette panel as non-floatable, non-closable via group or `panelLock`

### Step 3: Update `createLayoutStructure`

- Size setting: target vbox (now `children[1]`) instead of panel
- Tab injection: navigate into `children[1].children[1]` for the tabbed panel

### Step 4: Update `reinjectComponents`

- Add `element-palette-tab` injection (already walks recursively, just needs the new case)

### Step 5: Update DOM targeting

- All 6 `[data-dockid="graph-sidebar-panel"]` references: evaluate whether each should target the vbox container or the inner panel
- Width management (useLayoutEffect, mouseup, ResizeObserver): target vbox container
- Floating/tab restore: keep targeting inner panel (unchanged)

### Step 6: Update `onLayoutChange`

- `stripSidebarSize`: strip size from the vbox node
- Tab restore: recursive search for `graph-sidebar-panel` instead of positional `dockbox.children`

### Step 7: CSS

- Hide palette tab bar
- Hide palette-sidebar splitter

### Step 8: Layout migration

- Handle old saved layouts (single panel at `children[1]`) by wrapping them in the new vbox structure during restoration

### Step 9: Test

- Sidebar maximise/minimise with palette visible
- Sidebar resize (horizontal splitter between canvas and sidebar)
- Floating a sidebar tab out and back
- Floating all tabs → auto-minimise
- Close and restore a sidebar tab
- Saved layout restoration (with and without legacy format)
- Palette visible in both maximised sidebar and minimised icon bar
- Palette tool selection works in both modes
