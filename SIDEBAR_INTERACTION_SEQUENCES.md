# Sidebar Interaction Sequences - Complete Analysis

## All Possible User Interactions

### A. INITIAL STATE SEQUENCES
1. **A1: Open graph for first time (fresh tab)**
   - Initial: sidebar minimized, icon bar visible, no selection
   
2. **A2: Reopen graph (existing tab state)**
   - Initial: restore previous sidebar state (minimized or maximized)

### B. SELECTION SEQUENCES
3. **B1: Select node when sidebar minimized**
   - User clicks node
   - Sidebar should maximize
   - Properties panel should show
   - Node properties should display

4. **B2: Select edge when sidebar minimized**
   - User clicks edge
   - Sidebar should maximize
   - Properties panel should show
   - Edge properties should display

5. **B3: Select node when sidebar already maximized**
   - User clicks node
   - Sidebar stays maximized
   - Switch to Properties tab (if not already there)
   - Node properties should display

6. **B4: Select edge when sidebar already maximized**
   - User clicks edge
   - Sidebar stays maximized
   - Switch to Properties tab (if not already there)
   - Edge properties should display

7. **B5: Click canvas background (deselect)**
   - User clicks empty canvas
   - Sidebar behavior: stays in current state
   - Properties panel: shows graph properties

### C. MINIMIZE/MAXIMIZE SEQUENCES
8. **C1: Click minimize button when sidebar maximized**
   - User clicks minimize button
   - Sidebar should collapse to icon bar
   - Canvas should expand
   - Icon bar should appear at right edge

9. **C2: Click icon when sidebar minimized**
   - User clicks icon (What-If, Props, or Tools)
   - Sidebar should maximize
   - Clicked panel should become active tab
   - Icon bar should disappear

10. **C3: Click same icon twice**
    - First click: maximize with that panel
    - Second click: should stay maximized (no change)

### D. HOVER SEQUENCES
11. **D1: Hover over icon when minimized (no selection)**
    - User hovers over icon
    - Preview overlay should appear immediately adjacent to icon bar
    - Preview should show panel content

12. **D2: Move mouse from icon into preview**
    - User moves mouse from icon → preview
    - Preview should stay open
    - Mouse can interact with preview content

13. **D3: Move mouse out of preview**
    - User moves mouse away from preview
    - Preview should close

14. **D4: Hover during transition (just minimized)**
    - User minimizes, immediately hovers
    - Hover should NOT work (isTransitioning = true)
    - After 300ms, hover works normally

### E. FLOATING PANEL SEQUENCES
15. **E1: Drag panel out to float (from sidebar)**
    - User drags tab header from sidebar
    - Tab becomes floating window
    - Can move anywhere over graph canvas
    - Sidebar still shows other tabs

16. **E2: Close floating panel**
    - User clicks X on floating panel
    - Panel closes
    - Panel should return to sidebar dock
    - If all panels closed, sidebar minimizes

17. **E3: Dock floating panel back (drag to sidebar)**
    - User drags floating panel back to sidebar
    - Panel re-docks in sidebar
    - Normal sidebar behavior resumes

18. **E4: Multiple panels floating**
    - User drags multiple panels out
    - All can float independently
    - Sidebar can be empty (then auto-minimizes)

### F. RESIZE SEQUENCES
19. **F1: Resize sidebar by dragging divider**
    - User drags divider between canvas and sidebar
    - Sidebar width changes in real-time
    - Minimize button follows sidebar edge
    - Canvas adjusts width

20. **F2: Resize while panels are floating**
    - User resizes sidebar
    - Floating panels stay in their positions
    - Sidebar resizes normally

### G. TAB SWITCHING SEQUENCES  
21. **G1: Click different tab in sidebar**
    - User clicks Tools tab (while Properties is active)
    - Sidebar stays maximized
    - Active tab switches to Tools
    - Previous tab content preserved (cached)

22. **G2: Switch tabs via icon click (while maximized)**
    - User clicks icon while sidebar already maximized
    - Should switch to that tab
    - Sidebar stays maximized

---

## REQUIRED STATE VARIABLES

### SidebarState (per-tab)
- `mode`: 'minimized' | 'maximized'
- `activePanel`: 'what-if' | 'properties' | 'tools'
- `hasAutoOpened`: boolean (prevent auto-open after user manually minimizes)
- `isTransitioning`: boolean (prevent hover during animation)
- `floatingPanels`: string[] (track which panels are floating)

### Local State
- `dockLayout`: LayoutData | null (rc-dock layout config)
- `sidebarWidth`: number (for minimize button positioning)
- `hoveredPanel`: 'what-if' | 'properties' | 'tools' | null
- `selectedNodeId`: string | null
- `selectedEdgeId`: string | null

---

## CODE PATH TRACES

### SEQUENCE B1: Select node when sidebar minimized

**Current Code Path:**
1. User clicks node → GraphCanvas calls `onSelectedNodeChange(nodeId)`
2. `handleNodeSelection(nodeId)` called
3. Checks: `prevSelectedNodeRef.current !== nodeId` (true, new selection)
4. Calls: `sidebarOps.handleSelection()`
5. In useSidebarState: `handleSelection()` checks `state.mode === 'minimized'`
6. Calls: `updateState({ mode: 'maximized', activePanel: 'properties', hasAutoOpened: true })`
7. `useSidebarState` persist effect: saves to tab state
8. `GraphEditor` effect (line 290-332): detects `sidebarState.mode` changed
9. Checks: `prevModeRef.current !== sidebarState.mode` (minimized !== maximized)
10. Calls: `createLayoutWithContent('maximized')`
11. Creates: layout with canvas panel + sidebar panel
12. Calls: `dockRef.current.loadLayout(layout)`
13. Updates: `setDockLayout(layout)` and `prevModeRef.current = 'maximized'`

**Expected Result:** Sidebar appears with Properties panel
**Actual Result:** Sidebar disappears

**BUG IDENTIFIED:** `setDockLayout(layout)` triggers effect to run again, but layout content has React components which are NEW INSTANCES, causing remount.

---

### SEQUENCE C1: Click minimize button when sidebar maximized

**Current Code Path:**
1. User clicks minimize button → `onClick={() => sidebarOps.minimize()}`
2. In useSidebarState: `minimize()` calls `updateState({ mode: 'minimized', isTransitioning: true })`
3. After 300ms: `updateState({ isTransitioning: false })`
4. `GraphEditor` effect (line 290-332): detects mode changed to 'minimized'
5. Calls: `createLayoutWithContent('minimized')`
6. Creates: layout with ONLY canvas panel (no sidebar)
7. Calls: `dockRef.current.loadLayout(layout)`
8. Updates: `setDockLayout(layout)`

**Expected Result:** Sidebar collapses, icon bar appears
**Actual Result:** Works on first minimize, then sidebar disappears on re-maximize

**BUG IDENTIFIED:** Same issue - component instances change on each layout creation.

---

## ROOT CAUSE

**The fundamental problem:** Every call to `createLayoutWithContent()` creates NEW React component instances for GraphCanvas and panels. When we call `setDockLayout(layout)` and then `dockRef.current.loadLayout(layout)`, rc-dock unmounts the old components and mounts the new ones, losing all internal state.

**The solution:** Use `loadLayout()` to update the structure WITHOUT changing component instances. OR use a stable reference for components.

---

## PROPOSED FIX

Use **component references** that don't change on every render, and only update the STRUCTURE via loadLayout, not the content.

1. Create component instances ONCE and store in refs
2. Use those same refs in all layouts
3. Only call `loadLayout()` to change structure (minimize/maximize)
4. Never recreate component instances

