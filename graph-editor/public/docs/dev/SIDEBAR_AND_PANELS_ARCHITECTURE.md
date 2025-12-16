# Sidebar and Panels Architecture

## Overview

The GraphEditor implements a sophisticated sidebar and panel system built on top of `rc-dock`. This document explains how the system works, what customizations override rc-dock's default behavior, and what state is persisted where.

## Architecture Layers

### 1. Nested rc-dock Instances

The application uses **TWO levels** of rc-dock:

1. **App-level dock** (`AppShell.tsx`): Manages main application tabs (graph-test, graph-WA-case-conversion, etc.)
2. **Graph-level dock** (`GraphEditor.tsx`): Manages canvas + sidebar panels within each graph tab

This nesting allows each graph tab to have its own independent layout with floating/docked panels.

### 2. Core Components

#### GraphEditor Components
- **Canvas Panel** (`graph-canvas-panel`): Main graph visualization area
- **Sidebar Panel** (`graph-sidebar-panel`): Contains three tabs:
  - **What-If** (`what-if-tab`): What-If analysis controls
  - **Properties** (`properties-tab`): Node/edge property editor
  - **Tools** (`tools-tab`): Graph layout and display tools

#### Key Identifiers
- `data-dockid="graph-sidebar-panel"`: Stable identifier for the sidebar panel (used in CSS and DOM queries)
- `data-dockid="graph-canvas-panel"`: Stable identifier for the canvas panel
- `.graph-editor-dock-container`: Class on GraphEditor's container (excludes it from app-level CSS rules)

## State Management

### Persisted State (IndexedDB via TabContext)

The following state is persisted per graph tab:

```typescript
sidebarState: {
  mode: 'minimized' | 'maximized',        // Sidebar collapsed to icons or full width
  activePanel: 'what-if' | 'properties' | 'tools',  // Which tab is selected
  sidebarWidth: number,                   // Sidebar width in pixels (e.g., 300)
  floatingPanels: string[],               // Which panels are floating (e.g., ['what-if-tab'])
  savedDockLayout: object,                // Complete rc-dock layout structure (components stripped)
  whatIfOpen: boolean,                    // Per-panel open/closed states
  propertiesOpen: boolean,
  toolsOpen: boolean
}
```

**NOT persisted (session-only):**
- `hasAutoOpened`: Flag to prevent sidebar from auto-opening on every selection
- `isTransitioning`: Transient animation flag
- `isResizing`: Transient flag during resize drag

### Layout Persistence Strategy

#### What We Save
On every layout change (`onLayoutChange`), we save:
```javascript
const layoutToSave = JSON.parse(JSON.stringify(newLayout, (key, value) => {
  if (key === 'content') return undefined;  // Strip React components
  return value;
}));

// Also strip sidebar panel size (we manage this separately)
stripSidebarSize(layoutToSave);

sidebarOps.updateState({ savedDockLayout: layoutToSave });
```

This captures:
- All panel positions (docked or floating)
- Floating panel coordinates (x, y, w, h)
- Tab arrangements
- Active tabs

#### What We Restore
On initialization (`useEffect#9`):
```javascript
if (sidebarState.savedDockLayout) {
  layout = sidebarState.savedDockLayout;
  
  // Re-inject React components into all tabs
  reinjectComponents(layout.dockbox);
  reinjectComponents(layout.floatbox);
  
  // Set sidebar size from our stored width
  if (sidebarState.mode === 'maximized' && sidebarState.sidebarWidth) {
    setSidebarSize(layout.dockbox, sidebarState.sidebarWidth);
  }
}
```

This ensures:
- Panel positions are restored exactly
- React components are re-injected (can't be serialized)
- Sidebar width is managed by our CSS, not rc-dock's flex system

## Custom Behavior Overrides

### 1. Sidebar Width Management

**Problem:** rc-dock uses flex weights for panel sizing, which don't translate well across container resizes.

**Solution:** We override rc-dock's flex system with CSS:

```typescript
// useLayoutEffect#6b - Apply fixed width CSS
const sidebarPanel = containerRef.current.querySelector('[data-dockid="graph-sidebar-panel"]');

if (sidebarState.mode === 'minimized') {
  sidebarPanel.style.flex = '0 0 0px';
  sidebarPanel.style.width = '0px';
} else if (sidebarState.mode === 'maximized') {
  const targetWidth = sidebarState.sidebarWidth || 300;
  sidebarPanel.style.flex = `0 0 ${targetWidth}px`;
  sidebarPanel.style.width = `${targetWidth}px`;
}
```

**When this runs:**
- Whenever `sidebarState.mode` changes
- Whenever `sidebarState.sidebarWidth` changes
- Whenever `sidebarState.isResizing` changes

### 2. Width Tracking During Resize

**Problem:** Need to capture the exact width when user drags the splitter.

**Solution:** Two mechanisms work together:

#### A. Mouse Event Listeners (`useEffect#6`)
```javascript
handleMouseDown: () => {
  // Detect splitter drag start
  if (target is dock-divider or dock-splitter) {
    isResizingRef.current = true;
    sidebarOps.setIsResizing(true);
  }
}

handleMouseUp: () => {
  // Capture final width BEFORE clearing isResizing flag
  const sidebar = querySelector('[data-dockid="graph-sidebar-panel"]');
  const finalWidth = sidebar.getBoundingClientRect().width;
  sidebarOps.setSidebarWidth(finalWidth);
  
  isResizingRef.current = false;
  sidebarOps.setIsResizing(false);
}
```

#### B. ResizeObserver (`useEffect#7`)
Tracks width changes in real-time, but **skips** during:
- User is actively resizing (`isResizingRef.current === true`)
- Sidebar is minimized (`sidebarState.mode === 'minimized'`)
- Width hasn't changed (`newWidth === lastSidebarWidthRef.current`)

This prevents:
- Capturing transient widths during drag
- Corrupting stored width with 0px when minimized
- Infinite update loops

### 3. Closed Panel Restoration

**Problem:** When all panels are floating and user closes one, it should return to the sidebar dock.

**Solution:** `onLayoutChange` handler detects missing tabs:

```javascript
const expectedSidebarTabs = ['what-if-tab', 'properties-tab', 'tools-tab'];
const allTabIds = collectAllTabIds(layout);
const missingSidebarTabs = expectedSidebarTabs.filter(id => !allTabIds.has(id));

if (missingSidebarTabs.length > 0) {
  // Check if sidebar already has tabs
  const existingSidebarTabs = getSidebarTabs(layout);
  
  if (existingSidebarTabs.length > 0) {
    // Sidebar exists with tabs - just add missing ones
    missingSidebarTabs.forEach(tabId => {
      sidebarPanel.tabs.push(createTab(tabId));
    });
    dockRef.current.loadLayout(layout);
  } else {
    // Sidebar is empty - rebuild with only the missing tabs
    const freshLayout = createLayoutStructure(sidebarState.mode, missingSidebarTabs);
    freshLayout.floatbox = currentLayout.floatbox; // Preserve floating panels
    dockRef.current.loadLayout(freshLayout);
  }
  
  // Trigger ResizeObserver re-initialization
  setDockLayout(freshLayout);
}
```

### 4. Auto-Minimize When All Panels Float

**Behavior:** When all 3 sidebar panels are floating, the sidebar automatically minimizes.

**Implementation:**
```javascript
if (sidebarFloatingIds.length === 3 && sidebarState.mode === 'maximized') {
  sidebarOps.minimize();
}
```

**Rationale:** Empty sidebar wastes space. Minimize button is also hidden when all panels are floating.

### 5. Smart Auto-Open (Once Per Session)

**Behavior:** On first node/edge selection, sidebar opens to Properties panel. Subsequent selections don't re-open.

**Implementation:**
Uses a `useRef` (not state) to prevent race conditions:

```typescript
const hasAutoOpenedRef = useRef<boolean>(false);

const handleSelection = useCallback(() => {
  if (hasAutoOpenedRef.current) return; // Already opened
  
  hasAutoOpenedRef.current = true; // Set immediately
  
  if (state.mode === 'minimized') {
    updateState({ mode: 'maximized', activePanel: 'properties' });
  } else {
    updateState({ activePanel: 'properties' });
  }
}, [state.mode, updateState]);
```

**Why a ref?**
- `hasAutoOpened` in state is stripped during persistence (session-only)
- State sync from IndexedDB would overwrite it (race condition)
- Ref is immune to state sync and provides immediate, synchronous checks

### 6. Close Button Visibility

**Rule:** Close buttons (✕) should be:
- Hidden when tabs are in their home position (sidebar)
- Visible when floating or docked elsewhere

**Implementation (CSS):**
```css
/* Hide in home position */
[data-dockid="graph-sidebar-panel"] .dock-tab-close-btn {
  display: none !important;
}

/* Show when floating */
.dock-fbox .dock-tab-close-btn {
  display: inline-block !important;
}
```

**Why this works:**
- Uses stable `data-dockid` attribute (rc-dock's native ID system)
- Works regardless of where sidebar is positioned in DOM
- Handles user docking panels on left/right/top/bottom

### 7. Minimize Button Positioning

**Challenge:** Button must be positioned at the sidebar splitter, which can be anywhere depending on docked panels.

**Solution:**

#### Horizontal Position
```javascript
right: sidebarState.mode === 'maximized' 
  ? `${sidebarState.sidebarWidth ?? 300}px` 
  : '48px'
```

Tracked via ResizeObserver on sidebar panel width.

#### Vertical Position
```javascript
top: splitterCenterY > 0 ? `${splitterCenterY}px` : '50%'
```

Tracked via ResizeObserver on the hbox container (`useEffect#7b`):
```javascript
const updateSplitterPosition = () => {
  const hbox = containerRef.current?.querySelector('.dock-box.dock-hbox');
  const rect = hbox.getBoundingClientRect();
  const containerRect = containerRef.current.getBoundingClientRect();
  const centerY = rect.top - containerRect.top + (rect.height / 2);
  setSplitterCenterY(centerY);
};
```

**Why this matters:**
- If user docks a panel on top, the hbox shifts down
- Button must stay centered on the actual splitter, not the container

### 8. Hover Preview (Minimized Mode)

**Behavior:** Hovering over icons shows a temporary preview panel.

**Implementation:**
```jsx
{/* Icon Bar */}
<SidebarIconBar onIconHover={handleIconHover} />

{/* Hover Preview Panel */}
{hoveredPanel && (
  <div onMouseLeave={() => setHoveredPanel(null)}>
    <SidebarHoverPreview panel={hoveredPanel} />
  </div>
)}
```

**Logic:**
- Icon hover sets `hoveredPanel` state
- Panel appears at `right: 48px` (left of icon bar)
- Mouse leave from panel clears `hoveredPanel`
- No complex timers or wrappers (kept simple after many failed attempts)

### 9. Hover Lock During Interactions

**Problem:** When user interacts with controls in hover panel (dropdowns, inputs), we don't want the panel to close.

**Solution:** Custom event system:
```javascript
// WhatIfAnalysisControl dispatches on dropdown open
window.dispatchEvent(new CustomEvent('dagnet:suspendLayout', { 
  detail: { durationMs: 5000 } 
}));

// GraphEditor listens and locks hover
useEffect(() => {
  const handler = (e) => {
    suspendLayoutUntilRef.current = Date.now() + e.detail.durationMs;
    setIsHoverLocked(true);
    
    // Auto-unlock after duration
    setTimeout(() => setIsHoverLocked(false), e.detail.durationMs);
  };
  window.addEventListener('dagnet:suspendLayout', handler);
  return () => window.removeEventListener('dagnet:suspendLayout', handler);
}, []);
```

**What gets suspended:**
- Hover panel closing (`handleIconHover` checks `isHoverLocked`)
- rc-dock layout changes (`onLayoutChange` checks suspension timestamp)
- Graph sync effects (file-to-store, store-to-file)

## Panel ID Tracking

### Finding the Sidebar Panel

**Always use:** `querySelector('[data-dockid="graph-sidebar-panel"]')`

**Why:**
- Works regardless of where sidebar is positioned in DOM
- User can dock panels on left, moving sidebar to position 2 or 3
- Stable across layout changes
- rc-dock's native ID system

**Where this is used:**
- ResizeObserver setup (tracking width)
- CSS application (setting width)
- Mouse event handlers (capturing resize)
- Close button visibility rules

### Panel State Tracking

```typescript
// Track which panels are floating
floatingPanels: string[]  // e.g., ['what-if-tab', 'tools-tab']

// Updated on every onLayoutChange
const sidebarFloatingIds = floatingTabIds.filter(id => 
  id === 'what-if-tab' || id === 'properties-tab' || id === 'tools-tab'
);
sidebarOps.updateState({ floatingPanels: sidebarFloatingIds });
```

## Persistence Details

### What Gets Saved to IndexedDB

Via `TabContext` → `editorState.sidebarState`:

1. **savedDockLayout**: Entire rc-dock layout structure
   - All panel positions (docked and floating)
   - Floating panel coordinates (x, y, w, h)
   - Tab arrangements
   - Active tabs
   - **Stripped:** React `content` components
   - **Stripped:** Sidebar panel `size` (we manage this with CSS)

2. **mode**: 'minimized' | 'maximized'

3. **activePanel**: 'what-if' | 'properties' | 'tools'

4. **sidebarWidth**: Pixel width of sidebar when maximized

5. **floatingPanels**: Quick reference array (redundant with savedDockLayout but useful)

6. **Panel open states**: whatIfOpen, propertiesOpen, toolsOpen

### What's Session-Only (NOT Persisted)

1. **hasAutoOpened**: Uses `useRef`, never written to state
   - Prevents auto-open from happening on every selection
   - Resets when tab is closed and reopened
   - Immune to state sync race conditions

2. **isTransitioning**: Stripped during persistence
   - Only relevant during minimize/maximize animation
   - Always reset to `false` on restore

3. **isResizing**: Stripped during persistence
   - Only relevant during active resize drag
   - Always reset to `false` on restore

### Persistence Flow

```
User action (drag splitter, float panel, etc.)
    ↓
rc-dock fires onLayoutChange
    ↓
GraphEditor strips components, saves to sidebarState
    ↓
useSidebarState detects change
    ↓
Memoization check (prevents redundant saves)
    ↓
tabOps.updateTabState(tabId, { sidebarState })
    ↓
TabContext writes to IndexedDB (async)
    ↓
TabContext re-renders with new state
    ↓
useSidebarState syncs from stored state (but preserves session-only flags)
```

## CSS Overrides

### 1. Sidebar Width (Fixed vs Flex)

**rc-dock default:** Uses flex weights that change when container resizes

**Our override:**
```css
/* Applied via inline styles in useLayoutEffect#6b */
sidebar.style.flex = '0 0 300px';  /* Fixed basis */
sidebar.style.width = '300px';     /* Explicit width */
```

**Why:** Flex weights are relative. When container resizes, flex weights stay the same but pixel widths change. We want absolute pixel widths.

### 2. Close Button Visibility

**rc-dock default:** All tabs are closable, close button always visible

**Our override:**
```css
[data-dockid="graph-sidebar-panel"] .dock-tab-close-btn {
  display: none !important;
}
```

**Why:** Panels in their home position shouldn't be closable (they can only be floated out).

### 3. Tab Bar Padding (Navigator Button Overlap)

**Problem:** When Navigator is unpinned, its button overlaps the left edge of tab bars at the top of the app.

**Solution:**
```css
/* Add padding to app-level tab bars (not nested, not floating) */
.app-shell.nav-unpinned .dock-box.dock-vbox > .dock-panel .dock-bar,
.app-shell.nav-unpinned .dock-box.dock-vbox > .dock-box.dock-hbox > .dock-panel .dock-bar {
  padding-left: 115px !important;
}

/* Remove padding for GraphEditor nested docks */
.graph-editor-dock-container .dock-bar {
  padding-left: 4px !important;
}

/* Remove padding for floating panels */
.dock-fbox .dock-bar {
  padding-left: 4px !important;
}
```

**Why the complex selectors:**
- Only affects tab bars at the top level of the app
- Excludes nested docks (GraphEditor has its own dock instance)
- Excludes floating panels (they don't overlap with Navigator)
- Uses hierarchy depth to identify top-level panels

## Component Injection

### The Problem with rc-dock Persistence

rc-dock's `loadLayout()` expects tab `content` to be React components, but:
- React components can't be serialized to JSON
- We need to persist layout across page refreshes
- IndexedDB can only store serializable data

### Our Solution

**On Save:**
```javascript
const layoutToSave = JSON.parse(JSON.stringify(layout, (key, value) => {
  if (key === 'content') return undefined;  // Strip components
  return value;
}));
```

**On Restore:**
```javascript
const reinjectComponents = (node) => {
  if (node.tabs) {
    node.tabs.forEach(tab => {
      if (tab.id === 'canvas-tab') {
        tab.content = canvasComponent;
        tab.title = '';
      } else if (tab.id === 'what-if-tab') {
        tab.content = whatIfComponent;
        tab.title = '🎭 What-If';
      }
      // ... etc for all tabs
    });
  }
  if (node.children) node.children.forEach(reinjectComponents);
};
```

**Why recursion:** Layout structure is a tree (dockbox > children > panels > tabs). We must traverse the entire tree to re-inject all components.

### Component Stability

Components are created once and reused:
```javascript
const whatIfComponent = useMemo(() => <WhatIfPanel tabId={tabId} />, [tabId]);
const propertiesComponent = useMemo(() => <PropertiesPanelWrapper tabId={tabId} />, [tabId]);
const toolsComponent = useMemo(() => <ToolsPanel ... />, [deps]);
```

**Why memoization:**
- Prevents unnecessary re-renders
- Ensures component identity stability for rc-dock's caching
- Dependencies only include props that should trigger re-creation

### Special Case: Canvas Component

The canvas is **NOT memoized**:
```javascript
const CanvasHost: React.FC = () => {
  const whatIf = useWhatIfContext();
  return <GraphCanvas {...props} {...whatIf} />;
};
const canvasComponent = (<CanvasHost />);
```

**Why not memoized:**
- Must re-render when What-If state changes
- What-If changes should NOT trigger rc-dock layout reload
- Wrapping in `CanvasHost` allows it to consume context directly

## What-If Analysis Integration

### The Challenge

What-If analysis updates frequently (every dropdown change), and we need:
- Immediate UI updates (no lag)
- No rc-dock layout reloads (avoid 2-3s delay)
- Persistence to IndexedDB (for undo/redo)

### The Solution: Dual State

#### 1. Local State (Fast, In-Memory)
```typescript
const [whatIfLocal, setWhatIfLocal] = useState({
  whatIfAnalysis: null,
  caseOverrides: {},
  conditionalOverrides: {}
});
```

Provided via `WhatIfContext` to all components.

#### 2. Persisted State (Slow, IndexedDB)
```typescript
// Async update, doesn't block UI
const schedulePersist = (next) => {
  setTimeout(() => {
    tabOps.updateTabState(tabId, { 
      caseOverrides: next.caseOverrides,
      conditionalOverrides: next.conditionalOverrides 
    });
  }, 0);
};
```

**Flow:**
```
User changes What-If dropdown
    ↓
WhatIfAnalysisControl calls context.setCaseOverride()
    ↓
GraphEditor updates whatIfLocal (synchronous)
    ↓
CanvasHost re-renders with new What-If state (immediate)
    ↓
schedulePersist queued (async, non-blocking)
    ↓
TabContext writes to IndexedDB (later)
```

## Event System

### Custom Events for Cross-Component Communication

#### 1. `dagnet:suspendLayout`
```javascript
window.dispatchEvent(new CustomEvent('dagnet:suspendLayout', { 
  detail: { durationMs: 5000 } 
}));
```

**Dispatched by:** WhatIfAnalysisControl (when dropdown opens)

**Listened by:** GraphEditor

**Effect:** 
- Sets `suspendLayoutUntilRef.current = Date.now() + 5000`
- Sets `isHoverLocked = true`
- Guards in multiple `useEffect` hooks check suspension timestamp

**Guards layout changes, file sync, and hover panel closing for specified duration**

#### 2. `dagnet:openSidebarPanel`
```javascript
window.dispatchEvent(new CustomEvent('dagnet:openSidebarPanel', { 
  detail: { panel: 'what-if' } 
}));
```

**Listened by:** GraphEditor

**Effect:** `sidebarOps.maximize(panel)`

#### 3. `dagnet:openPropertiesPanel`
```javascript
window.dispatchEvent(new CustomEvent('dagnet:openPropertiesPanel'));
```

**Dispatched by:** 
- GraphCanvas (context menu "Properties" item)
- GraphCanvas (double-click on node/edge)

**Listened by:** GraphEditor

**Effect:** `sidebarOps.maximize('properties')`

## Critical Timing Sequences

### Sidebar Width Restoration After Panel Closure

**Scenario:** All panels floating → close Properties → minimize button shows → click maximize

**The Problem:**
1. When all panels are floating, sidebar has NO sidebar tabs (only Canvas)
2. Properties is closed → we restore it via `loadLayout`
3. User clicks maximize → ResizeObserver tries to find sidebar
4. Sidebar doesn't exist yet (DOM hasn't rendered)

**The Solution:**
```javascript
// After loadLayout, update dockLayout state
setDockLayout(freshLayout);
```

This triggers ResizeObserver (`useEffect#7`) to re-run:
- Disconnects old observer
- Queries for sidebar using `[data-dockid="graph-sidebar-panel"]`
- Creates new observer for the restored sidebar

**Retry mechanism:**
If sidebar not found, retry after 200ms (DOM may still be rendering).

### Mode Change Without Layout Reload

**Old approach (SLOW):**
```javascript
useEffect(() => {
  if (sidebarState.mode === 'maximized') {
    dockRef.current.loadLayout(getGraphEditorLayout());
  } else {
    dockRef.current.loadLayout(getGraphEditorLayoutMinimized());
  }
}, [sidebarState.mode]);
```

**Problem:** `loadLayout()` causes 2-3s delay, flicker, component remounts.

**New approach (FAST):**
```javascript
useLayoutEffect(() => {
  const sidebar = querySelector('[data-dockid="graph-sidebar-panel"]');
  if (sidebarState.mode === 'minimized') {
    sidebar.style.width = '0px';
  } else {
    sidebar.style.width = `${sidebarState.sidebarWidth || 300}px`;
  }
}, [sidebarState.mode, sidebarState.sidebarWidth]);
```

**Why it works:**
- CSS changes are instant (no layout reload)
- rc-dock's internal state remains valid
- Sidebar panel still exists in DOM, just width=0

## Memoization Strategy in useSidebarState

### The Challenge

Prevent infinite loops between:
- Local state changes → persist to TabContext
- TabContext updates → sync back to local state

### The Solution

```typescript
const stateMatchesMemoized = memoizedStoredState && 
  state.mode === memoizedStoredState.mode &&
  state.activePanel === memoizedStoredState.activePanel &&
  state.sidebarWidth === memoizedStoredState.sidebarWidth &&
  state.isResizing === memoizedStoredState.isResizing &&
  JSON.stringify(state.floatingPanels.sort()) === JSON.stringify(...) &&
  state.savedDockLayout === memoizedStoredState.savedDockLayout; // Reference equality

if (!stateMatchesMemoized) {
  const { isTransitioning, hasAutoOpened, ...stateToSave } = state;
  tabOps.updateTabState(tabId, { sidebarState: stateToSave });
}
```

**Key points:**
- `savedDockLayout` uses **reference equality** (`===`), not deep comparison
  - Prevents crashes from circular references in layout
  - New layout = new object reference = triggers persist
  - Same object = same reference = skips persist
- `hasAutoOpened` and `isTransitioning` are stripped (session-only)

### Sync Guard

```typescript
useEffect(() => {
  if (memoizedStoredState && !isUpdatingRef.current) {
    const newState = {
      ...DEFAULT_SIDEBAR_STATE,
      ...memoizedStoredState,
      isTransitioning: false,  // Always reset
    };
    
    // Preserve session-only hasAutoOpened
    newState.hasAutoOpened = state.hasAutoOpened;
    
    setState(newState);
  }
}, [memoizedStoredState, state.hasAutoOpened]);
```

**Critical:** `state.hasAutoOpened` in dependency array ensures we re-sync when it changes locally, but the sync always preserves the local value.

## Performance Optimizations

### 1. Throttled ResizeObserver

```javascript
ResizeObserver(() => {
  if (isResizingRef.current) return;  // Skip during drag
  if (mode === 'minimized') return;   // Skip when collapsed
  
  const newWidth = Math.round(rect.width);  // Integer only
  if (newWidth === lastWidthRef.current) return;  // Skip if unchanged
  
  lastWidthRef.current = newWidth;
  
  rafRef.current = requestAnimationFrame(() => {
    sidebarOps.setSidebarWidth(newWidth);
  });
});
```

**Optimizations:**
- Skip during resize drag (width is transient)
- Skip when minimized (width is 0, would corrupt state)
- Round to integers (prevent sub-pixel loops)
- RAF throttling (one update per frame max)
- Early return if unchanged

### 2. Layout Suspension

During critical interactions (dropdown open, drag operations):
```javascript
if (Date.now() < suspendLayoutUntilRef.current) return;
```

Guards multiple effects:
- `onLayoutChange` handler
- File-to-store sync
- Store-to-file sync
- Mode change effects

**Why:** Prevents cascading layout changes during user interactions.

### 3. Separate What-If Context

**Before:** What-If changes triggered TabContext updates → rc-dock layout reload

**After:** What-If changes update local context → Canvas re-renders (no layout reload)

```typescript
<WhatIfProvider value={whatIfLocal}>
  <CanvasHost />  {/* Consumes WhatIfContext */}
</WhatIfProvider>
```

**Result:** What-If dropdown changes are instant, no 2-3s lag.

## Common Pitfalls and Solutions

### Pitfall 1: State Sync Race Conditions

**Problem:** Local state update → persist → stored state updates → sync overwrites local change

**Solution:** 
- Use refs for truly session-only data (`hasAutoOpened`)
- Strip session-only fields during persist
- Preserve local values during sync

### Pitfall 2: Width Corruption on Minimize

**Problem:** ResizeObserver captures width=0 when minimized, corrupts stored width

**Solution:** Skip ResizeObserver when `mode === 'minimized'`

### Pitfall 3: Component Re-mounting on Layout Changes

**Problem:** `loadLayout()` causes all components to remount, losing internal state

**Solution:** 
- Avoid `loadLayout()` except when absolutely necessary
- Use CSS for visual changes (minimize/maximize)
- Only call `loadLayout()` for structural changes (panel restoration)

### Pitfall 4: Finding Sidebar When Panels Docked Elsewhere

**Problem:** Assuming sidebar is at `panels[1]` breaks when user docks panels on left

**Solution:** Always use `querySelector('[data-dockid="graph-sidebar-panel"]')`

### Pitfall 5: Layout Persistence Breaking Custom CSS

**Problem:** Saving entire layout includes inline styles and flex values that override our CSS

**Solution:** 
- Strip `content` (React components)
- Strip sidebar panel `size` (we manage separately)
- Re-apply our CSS after restoration via `useLayoutEffect`

## Key useEffect Hooks in GraphEditor

### useEffect#6 - Resize Detection
Listens for mousedown/mouseup on splitters, sets `isResizing` flag.

### useLayoutEffect#6b - Apply Fixed Width CSS
Synchronously applies CSS width to sidebar panel after DOM updates.

### useEffect#7 - ResizeObserver Setup
Creates ResizeObserver to track sidebar width changes (with guards and throttling).

### useEffect#7b - Splitter Position Tracker
Tracks vertical center of hbox for minimize button positioning.

### useEffect#9 - Initialize Dock Layout
Runs once on mount. Restores saved layout or creates default.

### useEffect#10 - Mode Change Check
Logs mode changes (CSS handles the visual transition).

### useEffect#11 - Active Panel Change
Only runs when actively switching panels while maximized. Calls `loadLayout()` to switch tabs.

## Future Refactoring: Generic Panel System

### Current State
The sidebar system is tightly coupled to GraphEditor:
- Hardcoded panel IDs (`what-if-tab`, `properties-tab`, `tools-tab`)
- Hardcoded panel components (WhatIfPanel, PropertiesPanel, ToolsPanel)
- `useSidebarState` hook specific to graph editor needs

### Proposed Generic System

#### 1. Generic Hook: `usePanelDock`

```typescript
interface PanelDockConfig {
  containerId: string;                    // e.g., 'graph-sidebar-panel'
  panels: PanelDefinition[];              // Array of panel configs
  defaultMode: 'minimized' | 'maximized';
  defaultWidth: number;
  persistenceKey: string;                 // Key in editorState
}

interface PanelDefinition {
  id: string;                             // e.g., 'what-if'
  tabId: string;                          // e.g., 'what-if-tab'
  title: string;                          // e.g., '🎭 What-If'
  component: React.ComponentType<any>;    // The panel component
  icon?: string;                          // For icon bar
}

function usePanelDock(config: PanelDockConfig) {
  // All the logic from useSidebarState, but generic
  // Returns: { state, operations, components }
}
```

#### 2. Generic Component: `PanelDockLayout`

```tsx
<PanelDockLayout
  config={panelDockConfig}
  canvasComponent={<MyCanvas />}
  onPanelChange={(panelId) => {}}
>
  {/* Canvas content */}
</PanelDockLayout>
```

#### 3. Configuration-Driven Panels

```typescript
// In GraphEditor
const GRAPH_PANELS: PanelDefinition[] = [
  { 
    id: 'what-if', 
    tabId: 'what-if-tab',
    title: '🎭 What-If',
    component: WhatIfPanel,
    icon: '🎭'
  },
  { 
    id: 'properties', 
    tabId: 'properties-tab',
    title: '📝 Props',
    component: PropertiesPanelWrapper,
    icon: '📝'
  },
  { 
    id: 'tools', 
    tabId: 'tools-tab',
    title: '🛠️ Tools',
    component: ToolsPanel,
    icon: '🛠️'
  }
];

// In FormEditor (future)
const FORM_PANELS: PanelDefinition[] = [
  { id: 'validation', title: '✅ Validation', component: ValidationPanel },
  { id: 'preview', title: '👁️ Preview', component: PreviewPanel }
];
```

#### 4. Shared CSS via Container Class

```css
/* Generic panel dock container */
.panel-dock-container .dock-bar {
  padding-left: 4px !important;  /* No app-level padding */
}

/* Generic sidebar panel (any editor type) */
[data-panel-role="sidebar"] .dock-tab-close-btn {
  display: none !important;  /* No close in home position */
}
```

#### 5. Abstraction Layers

```
┌─────────────────────────────────────┐
│   Editor Components (GraphEditor,   │
│   FormEditor, TableEditor, etc.)    │
└──────────────┬──────────────────────┘
               │ uses
┌──────────────▼──────────────────────┐
│   PanelDockLayout (Generic)         │
│   - Manages DockLayout instance     │
│   - Handles panel floating/docking  │
│   - Width management                │
│   - Component injection             │
└──────────────┬──────────────────────┘
               │ uses
┌──────────────▼──────────────────────┐
│   usePanelDock Hook (Generic)       │
│   - State management                │
│   - Persistence                     │
│   - Memoization                     │
│   - Session-only flags              │
└──────────────┬──────────────────────┘
               │ persists to
┌──────────────▼──────────────────────┐
│   TabContext                        │
│   editorState.panelDockState        │
└─────────────────────────────────────┘
```

### Benefits of Refactoring

1. **Code Reuse:** Same panel system for all editor types
2. **Consistency:** Users learn panel behavior once, applies everywhere
3. **Maintainability:** Fixes/improvements apply to all editors
4. **Flexibility:** Easy to add new panel types via configuration
5. **Testing:** Generic system can be tested once, thoroughly

### Migration Path

1. **Phase 1:** Extract `useSidebarState` logic into `usePanelDock` (keep GraphEditor using it)
2. **Phase 2:** Create `PanelDockLayout` component, migrate GraphEditor to use it
3. **Phase 3:** Add panel docks to FormEditor, TableEditor as they're developed
4. **Phase 4:** Deprecate old GraphEditor-specific implementation

### Challenges to Consider

1. **Editor-Specific Panel Content:**
   - What-If panel needs access to graph data
   - Validation panel needs access to form schema
   - Solution: Pass editor context via props or nested providers

2. **Different Panel Types Per Editor:**
   - Graph: What-If, Properties, Tools
   - Form: Validation, Preview, Logic
   - Table: Filters, Aggregations, Formatting
   - Solution: Panel definitions are just configuration arrays

3. **Cross-Panel Communication:**
   - Properties panel modifies graph, What-If panel reads it
   - Solution: Shared context (GraphStoreContext, FormStoreContext, etc.)

4. **Keyboard Shortcuts:**
   - Ctrl+B toggles sidebar (currently hardcoded to graph)
   - Solution: Register shortcuts per editor type in a shortcuts registry

## Debugging Checklist

When sidebar behavior is broken:

1. **Check `data-dockid` attributes:** All queries use `[data-dockid="graph-sidebar-panel"]`
2. **Check `isResizing` flag:** Should be `false` except during active drag
3. **Check `mode` state:** Should match visual state (minimized vs maximized)
4. **Check `savedDockLayout`:** Should exist and contain floatbox for floating panels
5. **Check ResizeObserver:** Should re-initialize when `dockLayout` state changes
6. **Check memoization:** Look for "Skipping persist (matches memoized)" spam
7. **Check suspension:** Look for "SUSPENDED" logs during interactions
8. **Check component injection:** All tabs should have `content` after restoration

## Testing Scenarios

### Essential Tests

1. **Basic Flow:**
   - Open graph → sidebar should be maximized at 300px
   - Select node → sidebar opens to Properties (first time only)
   - Select another node → sidebar doesn't re-open
   - Minimize → sidebar collapses to icons
   - Maximize → sidebar restores to 300px

2. **Floating Panels:**
   - Float What-If → should appear as floating window
   - Move and resize it → F5 → should restore to same position/size
   - Close What-If → should return to sidebar
   - Maximize sidebar → What-If should appear

3. **Panel Docking:**
   - Drag Properties to left edge → should dock on left
   - Close button should appear (not in home position)
   - F5 → should restore docked on left
   - Minimize button should still work (finds sidebar via ID)

4. **All Panels Floating:**
   - Float all 3 panels → sidebar auto-minimizes
   - Minimize button hides
   - Close Properties → sidebar rebuilds with Properties only
   - Click maximize → sidebar shows at 300px with Properties

5. **Resize Behavior:**
   - Drag splitter → resize sidebar
   - Release → width captured and persisted
   - F5 → sidebar restores to resized width
   - With panel docked on left → resize still works (uses data-dockid, not position)

6. **Hover Preview:**
   - Minimize sidebar
   - Hover over What-If icon → preview appears
   - Move mouse to preview → stays open
   - Interact with controls → stays open (hover lock)
   - Move mouse away → closes

## File Locations

### Core Files
- `/graph-editor/src/components/editors/GraphEditor.tsx` - Main implementation
- `/graph-editor/src/hooks/useSidebarState.ts` - State management hook
- `/graph-editor/src/layouts/graphSidebarLayout.ts` - Layout structure definitions
- `/graph-editor/src/components/SidebarIconBar.tsx` - Minimized icon bar
- `/graph-editor/src/components/SidebarHoverPreview.tsx` - Hover preview panel

### Panel Components
- `/graph-editor/src/components/panels/WhatIfPanel.tsx`
- `/graph-editor/src/components/panels/PropertiesPanelWrapper.tsx`
- `/graph-editor/src/components/panels/ToolsPanel.tsx`

### Styling
- `/graph-editor/src/components/editors/GraphEditor.css` - GraphEditor-specific styles
- `/graph-editor/src/styles/dock-theme.css` - rc-dock customizations (close buttons, padding)

## Key Decisions and Rationale

### Why Not Use rc-dock's Built-in Minimize?
rc-dock doesn't have a native minimize/maximize API. We implemented it via CSS width changes to avoid expensive `loadLayout()` calls.

### Why Store Entire Layout vs. Just Positions?
Users can dock panels anywhere (left, top, bottom, right). Storing individual positions wouldn't capture complex arrangements. Storing the entire structure is simpler and handles all cases.

### Why Strip Components from Saved Layout?
React components contain closures, refs, and circular references. They can't be serialized. We strip them on save and re-inject on restore.

### Why Use Custom Events Instead of Props?
Deeply nested components (What-If controls, context menus) need to communicate with GraphEditor. Prop drilling would be messy. Events provide clean decoupling.

### Why Session-Only hasAutoOpened?
It's a UX preference that shouldn't persist across sessions. Each time you open a tab, the first selection should open the sidebar. After closing and reopening the same tab, it should auto-open again.

## Maintenance Notes

### When Adding New Panels

1. Add panel definition to `graphSidebarLayout.ts`
2. Create panel component in `/components/panels/`
3. Add to `PANEL_TO_TAB_ID` mapping
4. Add icon to `SidebarIconBar`
5. Add component injection in `reinjectComponents`
6. Update `expectedSidebarTabs` array for restoration logic

### When Debugging Performance

1. Check for `loadLayout()` calls in logs (should be rare)
2. Check for ResizeObserver spam (should have guards)
3. Check for state sync loops (look for memoization skips)
4. Use `performance.mark()` and `performance.measure()` for timing
5. Check suspension logs during interactions

### When Porting to Other Editors

Consider these editor-specific aspects:
- What panels make sense for this editor type?
- What should auto-open on selection? (Properties for graph, Validation for form, etc.)
- What context does the panel need? (GraphStoreContext, FormStoreContext, etc.)
- What keyboard shortcuts? (Ctrl+B for sidebar, etc.)

The core mechanics (floating, docking, width management, persistence) should be identical and could be extracted into the proposed `usePanelDock` hook.

---

*Last Updated: 2-Nov-25*
*GraphEditor Sidebar Implementation - Phase 2 Complete*

