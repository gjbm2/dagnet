# Sidebar Logic Fix - Complete Rewrite

## ROOT CAUSE OF ALL ISSUES

**Problem:** Every time we called `createLayoutWithContent()`, we created NEW React component instances. When rc-dock loaded this layout, it unmounted the old components and mounted the new ones, causing:
- Canvas to remount (lost state, flickering)
- Sidebar panels to remount (lost state)
- Components to "disappear" during transitions

## THE FIX

### STABLE COMPONENT INSTANCES

Created component instances ONCE and stored in refs:
```typescript
const canvasComponentRef = useRef<React.ReactElement | null>(null);
const whatIfComponentRef = useRef<React.ReactElement | null>(null);
const propertiesComponentRef = useRef<React.ReactElement | null>(null);
const toolsComponentRef = useRef<React.ReactElement | null>(null);
```

Components are created on first render and REUSED in all subsequent layouts.

### SIMPLIFIED LAYOUT LOGIC

**Before:**
- `createLayoutWithContent()` - created new components every time
- Called both `setDockLayout()` AND `loadLayout()` - double update
- Complex pending state management
- Multiple effects fighting each other

**After:**
- `createLayoutStructure()` - uses stable component refs
- ONLY calls `loadLayout()` to change structure
- NO state update on mode change
- Single effect handles all mode changes

### CODE FLOW FOR EACH INTERACTION

#### B1: Select node when minimized
1. User clicks node → `handleNodeSelection(nodeId)`
2. Calls `sidebarOps.handleSelection()`
3. Sets `sidebarState.mode = 'maximized'`
4. Effect detects mode change
5. Calls `createLayoutStructure('maximized')` with stable refs
6. Calls `dockRef.current.loadLayout(layout)`
7. ✅ Sidebar appears with same component instances (no remount)

#### C1: Click minimize button
1. User clicks minimize → `sidebarOps.minimize()`
2. Sets `sidebarState.mode = 'minimized'`
3. Effect detects mode change
4. Calls `createLayoutStructure('minimized')` with stable canvas ref
5. Calls `dockRef.current.loadLayout(layout)`
6. ✅ Sidebar collapses, canvas stays mounted

#### C2: Click icon when minimized
1. User clicks icon → `handleIconClick(panel)`
2. Calls `sidebarOps.maximize(panel)`
3. Sets `sidebarState.mode = 'maximized'`, `activePanel = panel`
4. Effect detects mode change
5. Calls `createLayoutStructure('maximized')` with stable refs
6. Sets `sidebarPanel.activeId = PANEL_TO_TAB_ID[panel]`
7. Calls `dockRef.current.loadLayout(layout)`
8. ✅ Sidebar appears with correct tab active

## WHAT CHANGED

### 1. Component Instance Management
- ✅ Refs declared before use
- ✅ Components created once (if not exists)
- ✅ Same instances reused in all layouts

### 2. Layout Update Logic
- ✅ Removed `setDockLayout()` from mode change effect
- ✅ Only call `loadLayout()` to update structure
- ✅ Removed complex pending/state management
- ✅ Single source of truth for layout updates

### 3. Minimize Button
- ✅ Simplified to just call `sidebarOps.minimize()`
- ✅ No manual layout manipulation
- ✅ Effect handles everything

### 4. Icon Click
- ✅ Simplified to just call `sidebarOps.maximize(panel)`
- ✅ No manual layout manipulation
- ✅ Effect handles everything

## EXPECTED BEHAVIOR NOW

- ✅ Minimize → Icon bar appears, canvas stays mounted
- ✅ Maximize → Sidebar appears, canvas stays mounted
- ✅ Select object when minimized → Sidebar maximizes smoothly
- ✅ Minimize while object selected → Sidebar minimizes, selection preserved
- ✅ Float panels → Work independently
- ✅ Close floating panels → Return to dock
- ✅ Hover → Preview appears, no gap
- ✅ Resize → Minimize button tracks edge in real-time

