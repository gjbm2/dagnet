# State Management Reference Document

**Version**: 1.0  
**Last Updated**: 28-Oct-25  
**Purpose**: Comprehensive reference for state management across the DagNet Graph Editor

THIS FILE SHOULD BE RETAINED AS REFERENCE DOCUMENTATION

---

## Table of Contents

1. [Overview](#overview)
2. [State Storage Layers](#state-storage-layers)
3. [State Scope](#state-scope)
4. [Graph-Specific State Architecture](#graph-specific-state-architecture)
5. [Data Flow Scenarios](#data-flow-scenarios)
6. [Undo/Redo (History) Management](#undoredo-history-management)
7. [Critical Implementation Details](#critical-implementation-details)

---

## Overview

The application uses a **layered state architecture** with different scopes and persistence levels. Understanding these layers is critical for maintaining consistency and preventing state synchronization bugs.

### Key Principles

1. **Single Source of Truth**: FileState in FileRegistry is the canonical data store
2. **Per-File Stores**: Graph stores are created per file, shared across tabs viewing the same file
3. **Tab Independence**: UI state (selections, panel visibility) is per-tab
4. **Lazy Synchronization**: Data flows bidirectionally with guards to prevent loops
5. **Transform Boundaries**: Clear separation between raw graph data and ReactFlow presentation state

---

## State Storage Layers

### Layer 1: Non-Durable Client State (React State)

**Location**: React component state, Zustand stores  
**Lifetime**: Lost on page refresh  
**Purpose**: UI interactions, derived state, temporary values

#### Examples:
- **ReactFlow State** (`useNodesState`, `useEdgesState`)
  - Transformed presentation state
  - Positions, visual styling, interaction state
  - Rebuilt from raw data on mount
  
- **UI Component State**
  - Modal open/closed state
  - Input field values during editing
  - Hover states, focus states
  - Context menu positions

- **GraphStore (Zustand)**
  - Raw graph data (nodes, edges, policies, metadata)
  - Undo/redo history stacks
  - Per-file instance, but non-durable

### Layer 2: Durable Client State (IndexedDB)

**Location**: IndexedDB via Dexie (`db.files`, `db.tabs`, `db.appState`)  
**Lifetime**: Persists across page refreshes, cleared on browser data clear  
**Purpose**: Working state, unsaved changes, UI layout

#### Tables:

**`db.files`** (FileState records)
```typescript
{
  fileId: string;              // Primary key: "graph-example", "parameter-conversion-rate"
  type: ObjectType;            // "graph", "parameter", "context", "case"
  data: any;                   // Current working data (raw JSON)
  originalData: any;           // Last saved/loaded state (for revert, diff)
  isDirty: boolean;            // Has unsaved changes
  source: FileSource;          // { repository, path, branch, commitHash }
  viewTabs: string[];          // Tab IDs currently viewing this file
  lastModified: number;        // Timestamp
  lastSaved?: number;          // Timestamp of last git commit
}
```

**`db.tabs`** (TabState records)
```typescript
{
  id: string;                  // Primary key: "tab-graph-example-interactive"
  fileId: string;              // Foreign key to files table
  viewMode: ViewMode;          // "interactive", "raw-json", "raw-yaml"
  editorState: any;            // Tab-specific UI state (see below)
  isActive: boolean;           // Currently focused tab
  createdAt: number;
}
```

**`db.appState`** (Singleton: "app-state")
```typescript
{
  id: 'app-state';
  layout: any;                 // rc-dock layout state
  activeTabId: string | null;  // Last active tab
  navigatorState: any;         // Navigator panel state
  updatedAt: number;
}
```

**`db.settings`** (Singleton: "settings")
```typescript
{
  id: 'settings';
  theme: 'light' | 'dark';
  // ... other user preferences
}
```

### Layer 3: Durable Remote State (Git Repository)

**Location**: GitHub repository via API  
**Lifetime**: Permanent, versioned  
**Purpose**: Source of truth for saved state, collaboration, history

#### Stored Files:
- **Graphs**: `/graphs/{name}.json`
- **Parameters**: `/parameters/{name}.json` or `.yaml`
- **Contexts**: `/contexts/{name}.json` or `.yaml`
- **Cases**: `/cases/{name}.json` or `.yaml`

---

## State Scope

### Global State (Application-Wide)

**Storage**: `db.appState`, React Context  
**Components**: `TabContext`, `DialogContext`

#### Managed State:
- Open tabs list
- Active tab ID
- rc-dock layout
- Navigator tree state
- Global dialogs (save, commit, conflict resolution)

### Per-File State (Shared Across Tabs)

**Storage**: `FileRegistry` (in-memory Map), `db.files` (durable), `GraphStore` (Zustand)  
**Key Insight**: Multiple tabs viewing the same file share this state

#### FileState (in FileRegistry):
```typescript
// Single source of truth for file data
FileState {
  fileId: "graph-example"
  data: { nodes: [...], edges: [...], policies: {...}, metadata: {...} }
  originalData: { ... }  // Snapshot from last git load/save
  isDirty: true          // Shared dirty flag
  source: { repository, path, branch }
  viewTabs: ["tab-graph-example-interactive", "tab-graph-example-raw-json"]
}
```

#### GraphStore (per fileId):
```typescript
// Zustand store for interactive graph operations
GraphStore {
  graph: GraphData | null       // Raw graph data (NOT ReactFlow format)
  setGraph: (graph) => void
  
  // History (undo/redo)
  history: GraphData[]          // Array of graph snapshots
  historyIndex: number          // Current position in history
  canUndo: boolean
  canRedo: boolean
  saveHistoryState: () => void
  undo: () => void
  redo: () => void
  resetHistory: () => void
}
```

**Registry Pattern**:
```typescript
// One store per file, not per tab
const storeRegistry = new Map<string, GraphStoreHook>();

// Multiple tabs of same file share same store
GraphStoreProvider({ fileId: "graph-example" }) {
  const store = storeRegistry.get(fileId) || createGraphStore();
  // ...
}
```

### Per-Tab State (Tab-Specific UI)

**Storage**: `TabState.editorState` in `db.tabs`  
**Purpose**: Independent UI state for each tab view

#### Tab-Specific State:
```typescript
TabState.editorState {
  // Graph Editor (interactive view)
  selectedNodeId: string | null
  selectedEdgeId: string | null
  sidebarOpen: boolean
  whatIfOpen: boolean
  propertiesOpen: boolean
  jsonOpen: boolean
  useUniformScaling: boolean
  massGenerosity: number
  autoReroute: boolean
  whatIfAnalysis: any         // What-if scenario state
  caseOverrides: Record<string, string>
  conditionalOverrides: Record<string, any>
  
  // Raw View (Monaco editor)
  lineWrap: boolean
  showDiff: boolean
  
  // Form Editor
  // (mostly uses FileState directly, minimal tab state)
}
```

---

## Graph-Specific State Architecture

### Understanding the Dual Representation

Graphs have **two representations** that must stay synchronized:

1. **Raw Graph Data** (Schema Format)
2. **ReactFlow Presentation Data** (UI Format)

#### Raw Graph Data (Canonical)

**Location**: `FileState.data`, `GraphStore.graph`  
**Format**: Matches `schema/conversion-graph-1.0.0.json`

```typescript
GraphData {
  nodes: Array<{
    id: string;
    id: string;
    label?: string;
    description?: string;
    tags?: string[];
    type?: 'normal' | 'case';
    absorbing?: boolean;
    outcome_type?: 'success' | 'failure' | 'error' | 'neutral' | 'other';
    layout?: { x: number; y: number; colour?: string };  // ← Position stored here
    case?: { ... };
    entry?: { ... };
    costs?: { ... };
  }>;
  
  edges: Array<{
    id: string;
    id?: string;
    from: string;              // ← Source node ID
    to: string;                // ← Target node ID
    fromHandle?: string;       // ← Handle on source node
    toHandle?: string;         // ← Handle on target node
    p?: { mean?: number; stdev?: number; locked?: boolean; };
    conditional_p?: Array<{ ... }>;
    costs?: { ... };
    case_variant?: string;
    case_id?: string;
  }>;
  
  policies?: { ... };
  metadata?: { ... };
}
```

#### ReactFlow Presentation Data (Derived)

**Location**: `useNodesState`, `useEdgesState` in GraphCanvas  
**Format**: ReactFlow's internal format

```typescript
Node[] = [{
  id: string;
  type: 'conversion';
  position: { x: number; y: number };  // ← Extracted from raw node.layout
  data: {                              // ← Most raw properties copied here
    id, label, id, absorbing, outcome_type, description,
    entry, type, case, layout,
    onUpdate, onDelete, onDoubleClick  // ← Callbacks attached
  }
}]

Edge[] = [{
  id: string;
  type: 'conversion';
  source: string;                      // ← from raw edge.from
  target: string;                      // ← from raw edge.to
  sourceHandle?: string;               // ← from raw edge.fromHandle
  targetHandle?: string;               // ← from raw edge.toHandle
  data: {                              // ← Transformed from raw edge.p, etc.
    id, id, probability, stdev, locked,
    description, costs, weight_default,
    case_variant, case_id,
    onUpdate, onDelete, onDoubleClick, onReconnect  // ← Callbacks
  }
}]
```

### Transformation Functions

**`toFlow(graph, callbacks)`**: Raw Graph → ReactFlow Format
- Extracts `layout.x/y` → `position.x/y`
- Renames `from/to` → `source/target`
- Renames `fromHandle/toHandle` → `sourceHandle/targetHandle`
- Flattens `p.mean` → `probability`
- Attaches UI callbacks to `data`

**`fromFlow(nodes, edges, original)`**: ReactFlow Format → Raw Graph
- Extracts `position.x/y` → `layout.x/y`
- Renames `source/target` → `from/to`
- Renames `sourceHandle/targetHandle` → `fromHandle/toHandle`
- Reconstructs `p: { mean: probability, ... }`
- Preserves fields from original graph

### What Lives Where

#### On Raw Graph (FileState, GraphStore)
- Node structural properties (id, label, absorbing, type, case data)
- Node positions (`layout.x`, `layout.y`)
- Node colours (`layout.colour`)
- Edge structural properties (from, to, handles, probability, costs)
- Graph-level metadata (version, created_at, updated_at)
- Graph-level policies (default_outcome, overflow_policy)

#### On ReactFlow State Only
- **Selection state** (which nodes/edges are selected)
- **Drag state** (currently dragging)
- **Zoom/pan state** (viewport transform)
- **Animation state** (transitions, highlights)
- **Interaction state** (hover, focus)
- **Temporary visual state** (connection preview lines)

#### Critical: Position Syncing

Positions are stored in **raw graph** (`node.layout.x/y`) and **copied** to ReactFlow (`node.position.x/y`).

When user drags nodes:
1. ReactFlow updates its internal `position` immediately (smooth dragging)
2. On drag end, positions sync back to raw graph via `fromFlow()`
3. Raw graph updates trigger FileState.data update (marks dirty)
4. FileState update propagates to other tabs viewing same file

---

## Data Flow Scenarios

### Scenario 1: User Edits Graph Through Graph Editor

**Example**: User drags a node, adds an edge, changes a probability

```
┌─────────────────────────────────────────────────────────────────┐
│ 1. User drags node in GraphCanvas (ReactFlow)                  │
└─────────────────────────────────────────────────────────────────┘
                           ↓
┌─────────────────────────────────────────────────────────────────┐
│ 2. ReactFlow updates internal position state immediately       │
│    (for smooth interaction, no lag)                            │
└─────────────────────────────────────────────────────────────────┘
                           ↓
┌─────────────────────────────────────────────────────────────────┐
│ 3. On drag end: onNodesChange callback                         │
│    → GraphCanvas calls fromFlow(nodes, edges, graph)           │
│    → Converts ReactFlow format → Raw graph format              │
│    → Updates position: layout.x/y from position.x/y            │
└─────────────────────────────────────────────────────────────────┘
                           ↓
┌─────────────────────────────────────────────────────────────────┐
│ 4. GraphCanvas calls setGraph(updatedGraph)                    │
│    → Updates GraphStore.graph (raw format)                     │
│    → Sets isSyncingRef.current = true (prevent loop)           │
└─────────────────────────────────────────────────────────────────┘
                           ↓
┌─────────────────────────────────────────────────────────────────┐
│ 5. GraphEditor detects GraphStore.graph change                 │
│    → useEffect([graph]) triggers                               │
│    → Checks syncingRef to prevent loop                         │
│    → Calls updateData(graph) to sync to FileState             │
└─────────────────────────────────────────────────────────────────┘
                           ↓
┌─────────────────────────────────────────────────────────────────┐
│ 6. FileRegistry.updateFile(fileId, graph)                      │
│    → Updates FileState.data (raw graph)                        │
│    → Sets isDirty = true                                       │
│    → Notifies all listeners (tabs viewing this file)           │
│    → Persists to db.files (IndexedDB)                          │
└─────────────────────────────────────────────────────────────────┘
                           ↓
┌─────────────────────────────────────────────────────────────────┐
│ 7. Other tabs' useFileState hooks receive notification         │
│    → Their GraphEditor.useEffect([data]) triggers              │
│    → Updates their GraphStore.graph                            │
│    → Their GraphCanvas rebuilds ReactFlow nodes via toFlow()   │
│    → Positions updated across all tabs                         │
└─────────────────────────────────────────────────────────────────┘
```

**Key Mechanisms**:
- `isSyncingRef.current`: Prevents feedback loops during GraphStore ↔ FileState sync
- `fromFlow()`: Ensures positions written back to canonical `layout.x/y`
- FileRegistry notification: Broadcasts changes to all tabs viewing file

---

### Scenario 2: User Edits JSON View on Graph

**Example**: User switches to raw JSON view, edits nodes array, changes edge probability

```
┌─────────────────────────────────────────────────────────────────┐
│ 1. User types in Monaco editor (RawView)                       │
│    → handleEditorChange(value) called on each keystroke        │
│    → Debounced (300ms) to avoid excessive parsing              │
└─────────────────────────────────────────────────────────────────┘
                           ↓
┌─────────────────────────────────────────────────────────────────┐
│ 2. After 300ms pause, debounce fires                           │
│    → Parses JSON: parsedData = JSON.parse(value)               │
│    → If parse fails: sets parseError state (show error)        │
│    → If parse succeeds: continue                               │
└─────────────────────────────────────────────────────────────────┘
                           ↓
┌─────────────────────────────────────────────────────────────────┐
│ 3. RawView calls updateData(parsedData)                        │
│    → Sets isEditorChangeRef.current = true (prevent loop)      │
│    → Calls FileRegistry.updateFile(fileId, parsedData)         │
└─────────────────────────────────────────────────────────────────┘
                           ↓
┌─────────────────────────────────────────────────────────────────┐
│ 4. FileRegistry.updateFile(fileId, parsedData)                 │
│    → Updates FileState.data (raw graph)                        │
│    → Sets isDirty = true                                       │
│    → Deep clones data (JSON.parse(JSON.stringify()))           │
│    → Notifies all listeners (including graph editor tabs)      │
│    → Persists to db.files (IndexedDB)                          │
└─────────────────────────────────────────────────────────────────┘
                           ↓
┌─────────────────────────────────────────────────────────────────┐
│ 5. Graph editor tabs receive notification                      │
│    → GraphEditor.useEffect([data]) triggers                    │
│    → Checks: if syncingRef is false, proceed                   │
│    → Calls setGraph(data) to update GraphStore                │
│    → Saves to history (external change)                        │
└─────────────────────────────────────────────────────────────────┘
                           ↓
┌─────────────────────────────────────────────────────────────────┐
│ 6. GraphStore.graph updated → triggers GraphCanvas sync        │
│    → GraphCanvas.useEffect([graph]) triggers                   │
│    → Checks: graphJson !== lastSyncedGraphRef.current          │
│    → Calls toFlow(graph) to rebuild ReactFlow nodes/edges      │
│    → Calls setNodes(flowNodes), setEdges(flowEdges)            │
│    → ReactFlow re-renders with new data                        │
└─────────────────────────────────────────────────────────────────┘
                           ↓
┌─────────────────────────────────────────────────────────────────┐
│ 7. Monaco editor checks isEditorChangeRef                      │
│    → useEffect([data]) sees isEditorChangeRef = true           │
│    → Skips updating editor content (prevents cursor jump)      │
│    → After 500ms, resets isEditorChangeRef = false             │
└─────────────────────────────────────────────────────────────────┘
```

**Key Mechanisms**:
- **Debouncing (300ms)**: Waits for user to stop typing before parsing/syncing
- **isEditorChangeRef**: Prevents Monaco from updating itself (cursor jumps)
- **Delayed flag reset (500ms)**: Allows round-trip through GraphStore before resetting
- **Deep cloning**: FileRegistry ensures new object references for React change detection

---

### Scenario 3: User Plays with What-If Analysis

**Example**: User opens What-If panel, selects a case variant, adjusts conditional probability

```
┌─────────────────────────────────────────────────────────────────┐
│ 1. User opens What-If Analysis panel                           │
│    → GraphEditor sets whatIfOpen = true (tab state)            │
│    → Persists to TabState.editorState in db.tabs               │
└─────────────────────────────────────────────────────────────────┘
                           ↓
┌─────────────────────────────────────────────────────────────────┐
│ 2. User selects case variant override                          │
│    → WhatIfAnalysisControl calls setCaseOverride(nodeId, var)  │
│    → Updates caseOverrides state (React state in GraphEditor)  │
│    → Persists to TabState.editorState                          │
│    → DOES NOT modify FileState or GraphStore                   │
└─────────────────────────────────────────────────────────────────┘
                           ↓
┌─────────────────────────────────────────────────────────────────┐
│ 3. GraphEditor passes overrides to GraphCanvas                 │
│    → <GraphCanvas caseOverrides={caseOverrides}                │
│                   conditionalOverrides={conditionalOverrides}   │
│                   whatIfAnalysis={whatIfAnalysis} />            │
└─────────────────────────────────────────────────────────────────┘
                           ↓
┌─────────────────────────────────────────────────────────────────┐
│ 4. GraphCanvas applies what-if logic visually                  │
│    → In toFlow(), edge widths computed with overrides:         │
│      const effectiveP = computeEffectiveEdgeProbability(...)   │
│    → Edges rendered with different widths (visual only)        │
│    → Nodes highlighted if they're overridden                   │
│    → Graph DATA unchanged (no FileState mutation)              │
└─────────────────────────────────────────────────────────────────┘
                           ↓
┌─────────────────────────────────────────────────────────────────┐
│ 5. User closes What-If or clears overrides                     │
│    → GraphEditor clears caseOverrides state                    │
│    → GraphCanvas re-renders with original probabilities        │
│    → No data changes, no history entries, no dirty flag        │
└─────────────────────────────────────────────────────────────────┘
```

**Critical Insight**: What-If Analysis is **non-destructive**. It:
- Stores overrides in **tab state only** (not FileState)
- Applies transformations **at render time** (in toFlow())
- Does NOT modify raw graph data
- Does NOT trigger FileState.isDirty
- Does NOT create history entries
- Is **per-tab** (different tabs can have different what-if scenarios)

---

### Scenario 4: User Drags Graph Elements (Position Update)

**Example**: User drags 3 nodes at once, positions update

```
┌─────────────────────────────────────────────────────────────────┐
│ 1. User clicks and drags nodes                                 │
│    → ReactFlow handles drag internally                         │
│    → Updates node.position.x/y on every mouse move             │
│    → Smooth, immediate visual feedback (no lag)                │
└─────────────────────────────────────────────────────────────────┘
                           ↓
┌─────────────────────────────────────────────────────────────────┐
│ 2. During drag: onNodesChange called continuously              │
│    → type: 'position', dragging: true                          │
│    → GraphCanvas filters these (position changes during drag)  │
│    → NO graph updates yet (would cause lag)                    │
└─────────────────────────────────────────────────────────────────┘
                           ↓
┌─────────────────────────────────────────────────────────────────┐
│ 3. User releases mouse (drag end)                              │
│    → onNodesChange called with dragging: false                 │
│    → GraphCanvas detects position change + not dragging        │
│    → Triggers position sync to raw graph                       │
└─────────────────────────────────────────────────────────────────┘
                           ↓
┌─────────────────────────────────────────────────────────────────┐
│ 4. GraphCanvas syncs positions to raw graph                    │
│    → Calls fromFlow(nodes, edges, graph)                       │
│    → Updates node.layout.x/y from node.position.x/y            │
│    → Calls setGraph(updatedGraph)                              │
│    → Sets isSyncingRef = true                                  │
└─────────────────────────────────────────────────────────────────┘
                           ↓
┌─────────────────────────────────────────────────────────────────┐
│ 5. Auto-reroute (if enabled)                                   │
│    → After position change, auto-reroute may trigger           │
│    → Recalculates optimal edge handles based on new positions  │
│    → Updates edge.fromHandle/toHandle in raw graph             │
│    → Updates graph again with new handles                      │
└─────────────────────────────────────────────────────────────────┘
                           ↓
┌─────────────────────────────────────────────────────────────────┐
│ 6. GraphEditor syncs to FileState                              │
│    → useEffect([graph]) triggers                               │
│    → Checks syncingRef (allows store→file sync)                │
│    → Calls updateData(graph)                                   │
│    → FileRegistry updates FileState.data                       │
│    → Sets isDirty = true                                       │
│    → Saves history state (position change)                     │
└─────────────────────────────────────────────────────────────────┘
                           ↓
┌─────────────────────────────────────────────────────────────────┐
│ 7. Other tabs notified                                         │
│    → Other graph editor tabs receive FileState update          │
│    → Their GraphCanvas rebuilds with new positions             │
│    → Nodes appear in new positions across all tabs             │
└─────────────────────────────────────────────────────────────────┘
```

**Key Details**:
- Positions stored in `layout.x/y` (raw graph), not just ReactFlow
- Drag is optimistic (ReactFlow updates first, sync happens on release)
- Auto-reroute is a follow-up operation after position sync
- Position changes create history entries (undoable)

---

## Undo/Redo (History) Management

### History Architecture by Editor Type

Different editors have different history mechanisms due to their distinct data flows:

#### 1. Graph Editor (Interactive Graph View)

**Storage**: `GraphStore.history[]`, `GraphStore.historyIndex`  
**Scope**: Per-file (shared across tabs viewing same file)  
**Granularity**: Full graph snapshots

```typescript
GraphStore {
  history: GraphData[]           // Stack of graph snapshots
  historyIndex: number           // Current position (-1 = no history)
  canUndo: boolean               // historyIndex > 0
  canRedo: boolean               // historyIndex < history.length - 1
  
  saveHistoryState(): void {
    // Remove any redo states after current index
    const newHistory = history.slice(0, historyIndex + 1);
    
    // Add current graph as new snapshot
    newHistory.push(JSON.parse(JSON.stringify(graph)));
    
    // Limit to 20 snapshots
    if (newHistory.length > 20) newHistory.shift();
    
    // Update state
    set({
      history: newHistory,
      historyIndex: newHistory.length - 1,
      canUndo: true,
      canRedo: false
    });
  }
  
  undo(): void {
    if (historyIndex > 0) {
      const newIndex = historyIndex - 1;
      setGraph(JSON.parse(JSON.stringify(history[newIndex])));
      set({ historyIndex: newIndex, canUndo: newIndex > 0, canRedo: true });
    }
  }
  
  redo(): void {
    if (historyIndex < history.length - 1) {
      const newIndex = historyIndex + 1;
      setGraph(JSON.parse(JSON.stringify(history[newIndex])));
      set({ historyIndex: newIndex, canUndo: true, canRedo: newIndex < history.length - 1 });
    }
  }
}
```

**When History is Saved**:
1. **Initial load**: First snapshot saved after graph loads
2. **Interactive edits**: After each meaningful change (node add/delete/update, edge add/delete/update, position change)
3. **External changes**: When JSON editor or form editor modifies the graph

**When History is NOT Saved**:
- During what-if analysis (non-destructive, temporary)
- During drag (only on release)
- During multi-step operations (e.g., auto-layout is one history entry)

**Keyboard Shortcuts**:
- `Cmd+Z` / `Ctrl+Z`: Undo
- `Cmd+Shift+Z` / `Ctrl+Shift+Z`: Redo

**Implementation Details**:
- GraphEditor has `useEffect` for `Cmd+Z` / `Ctrl+Z` keyboard handling
- History state persists in GraphStore (not durable, lost on refresh)
- Undo/redo updates GraphStore → GraphEditor syncs to FileState → other tabs notified

---

#### 2. Form Editor (Parameter, Context, Case Editors)

**Storage**: `historyRef` (React ref), local to each FormEditor component  
**Scope**: Per-component instance (per-tab)  
**Granularity**: Full data snapshots

```typescript
FormEditor {
  const historyRef = useRef<any[]>([]);
  const historyIndexRef = useRef<number>(-1);
  const [canUndo, setCanUndo] = useState(false);
  const [canRedo, setCanRedo] = useState(false);
  
  const addToHistory = (data: any) => {
    // Remove any redo states
    const newHistory = historyRef.current.slice(0, historyIndexRef.current + 1);
    
    // Add new snapshot
    newHistory.push(JSON.parse(JSON.stringify(data)));
    
    // Limit to 50 snapshots
    const MAX_HISTORY = 50;
    if (newHistory.length > MAX_HISTORY) {
      newHistory.shift();
    }
    
    historyRef.current = newHistory;
    historyIndexRef.current = newHistory.length - 1;
    setCanUndo(true);
    setCanRedo(false);
  };
  
  const undo = () => {
    if (historyIndexRef.current > 0) {
      const newIndex = historyIndexRef.current - 1;
      const prevState = historyRef.current[newIndex];
      
      // Update form without triggering onChange
      setFormData(prevState);
      updateData(prevState);  // Sync to FileState
      
      historyIndexRef.current = newIndex;
      setCanUndo(newIndex > 0);
      setCanRedo(true);
    }
  };
  
  const redo = () => {
    if (historyIndexRef.current < historyRef.current.length - 1) {
      const newIndex = historyIndexRef.current + 1;
      const nextState = historyRef.current[newIndex];
      
      // Update form without triggering onChange
      setFormData(nextState);
      updateData(nextState);  // Sync to FileState
      
      historyIndexRef.current = newIndex;
      setCanUndo(true);
      setCanRedo(newIndex < historyRef.current.length - 1);
    }
  };
}
```

**When History is Saved**:
1. **Initial load**: First snapshot saved after form data loads
2. **Form changes**: After each form field change (debounced by react-jsonschema-form)
3. **External changes**: When raw JSON editor modifies the data

**UI Elements**:
- Undo/Redo buttons in FormEditor toolbar
- Keyboard shortcuts work when form has focus

**Implementation Details**:
- History is NOT shared across tabs (each tab has independent history)
- History is NOT persisted (lost on tab close or refresh)
- Limit: 50 snapshots (larger than GraphEditor's 20)

---

#### 3. Monaco Editor (Raw JSON/YAML View)

**Storage**: Monaco's internal undo stack  
**Scope**: Per-editor instance (per-tab)  
**Granularity**: Character-level edits

```typescript
RawView {
  // Monaco Editor has built-in undo/redo
  // Keyboard shortcuts: Cmd+Z / Ctrl+Z (undo), Cmd+Shift+Z / Ctrl+Shift+Z (redo)
  
  const handleEditorMount = (editor: any) => {
    // Monaco automatically manages undo stack for text edits
    // No custom history implementation needed
  };
}
```

**When History is Saved**:
- Automatically on every character typed
- Monaco's internal undo manager handles this

**Implementation Details**:
- Monaco's undo stack is independent of FileState history
- Undoing in Monaco only affects editor content, not FileState (until debounce fires)
- After typing pause (300ms), parsed data syncs to FileState
- If user undoes in Monaco before debounce fires, FileState never updates

**Caveat**: Monaco's undo stack is cleared if external data changes arrive (e.g., from graph editor editing same file). This is by design to prevent conflicts.

---

### History Synchronization Challenges

#### Challenge 1: Cross-Tab History

**Problem**: If Tab A undoes a graph edit, should Tab B's history stack update?

**Current Behavior**: No, history is per-GraphStore (per-file), but undo/redo operations propagate via FileState:
1. Tab A calls `undo()` → GraphStore.graph updated with history[index-1]
2. GraphEditor syncs GraphStore → FileState
3. Tab B receives FileState update → syncs to its GraphStore
4. Tab B's current graph changes, but its history stack is unchanged
5. Tab B's user can still undo/redo based on its own history

**Consequence**: Each tab maintains independent history stack, but current state is shared.

#### Challenge 2: Editor-Type History Independence

**Problem**: If user edits in Graph Editor then switches to Form Editor, undo should work independently.

**Current Behavior**: Correct. Each editor type has separate history:
- Graph Editor: GraphStore history (shared per-file)
- Form Editor: Local historyRef (per-tab)
- Monaco Editor: Monaco's internal stack (per-tab)

Switching editors does NOT merge or transfer history stacks.

---

## Critical Implementation Details

### 1. Preventing Feedback Loops

**Problem**: Bidirectional sync can cause infinite loops (FileState ↔ GraphStore ↔ ReactFlow).

**Solutions**:

#### A. `isSyncingRef` (GraphEditor)
```typescript
const syncingRef = useRef(false);

// FileState → GraphStore sync
useEffect(() => {
  if (syncingRef.current) return;  // Skip if we're in a sync
  syncingRef.current = true;
  setGraph(data);
  setTimeout(() => { syncingRef.current = false; }, 100);
}, [data]);

// GraphStore → FileState sync
useEffect(() => {
  if (syncingRef.current) return;  // Skip if we're in a sync
  syncingRef.current = true;
  updateData(graph);
  setTimeout(() => { syncingRef.current = false; }, 100);
}, [graph]);
```

#### B. `isEditorChangeRef` (RawView)
```typescript
const isEditorChangeRef = useRef(false);

// Handle editor change
const handleEditorChange = (value: string) => {
  isEditorChangeRef.current = true;
  updateData(parsedData);
  
  // Reset after round-trip
  setTimeout(() => {
    isEditorChangeRef.current = false;
  }, 500);
};

// Prevent updating editor from its own changes
useEffect(() => {
  if (isEditorChangeRef.current) {
    // Skip updating editor (prevents cursor jump)
    return;
  }
  setEditorValue(JSON.stringify(data, null, 2));
}, [data]);
```

#### C. `lastSyncedGraphRef` (GraphCanvas)
```typescript
const lastSyncedGraphRef = useRef<string>('');

useEffect(() => {
  const graphJson = JSON.stringify(graph);
  if (graphJson === lastSyncedGraphRef.current) {
    // No change, skip rebuild
    return;
  }
  
  lastSyncedGraphRef.current = graphJson;
  const { nodes, edges } = toFlow(graph, callbacks);
  setNodes(nodes);
  setEdges(edges);
}, [graph]);
```

---

### 2. Deep Cloning for Change Detection

React relies on **reference equality** for change detection. To ensure React detects changes, FileRegistry deep-clones data:

```typescript
// FileRegistry.notifyListeners
private notifyListeners(fileId: string, file: FileState): void {
  const callbacks = this.listeners.get(fileId);
  if (callbacks) {
    // Deep clone to ensure NEW object references
    const fileCopy: FileState = {
      ...file,
      data: JSON.parse(JSON.stringify(file.data))  // ← Deep clone
    };
    callbacks.forEach(callback => callback(fileCopy));
  }
}
```

Without this, React's `useEffect([data])` might not trigger if data is mutated in place.

---

### 3. Debouncing User Input

#### Monaco Editor (300ms debounce)
```typescript
const handleEditorChange = (value: string) => {
  setEditorValue(value);
  
  if (parseDebounceRef.current !== null) {
    clearTimeout(parseDebounceRef.current);
  }
  
  parseDebounceRef.current = window.setTimeout(() => {
    // Parse and update FileState
    const parsedData = JSON.parse(value);
    updateData(parsedData);
  }, 300);  // Wait 300ms after last keystroke
};
```

Why: Prevents excessive parsing and state updates during typing.

#### Form Editor (debounced by react-jsonschema-form)
The library handles this internally, typically 200-300ms debounce on field changes.

---

### 4. Transform Boundary Enforcement

**Critical Rule**: Raw graph data NEVER contains ReactFlow properties.

```typescript
// ❌ WRONG: Don't store ReactFlow props in raw graph
graph.nodes[0].position = { x: 100, y: 200 };  // BAD
graph.edges[0].source = 'node-1';              // BAD

// ✅ CORRECT: Use canonical schema properties
graph.nodes[0].layout = { x: 100, y: 200 };    // GOOD
graph.edges[0].from = 'node-1';                // GOOD
```

The `toFlow()` and `fromFlow()` functions are the ONLY places where these transformations happen. All other code works with raw schema format.

---

### 5. Tab-Specific State Persistence

TabState.editorState stores per-tab UI state:

```typescript
// GraphEditor persists tab state
useEffect(() => {
  tabOps.updateTabState(tabId!, {
    selectedNodeId,
    selectedEdgeId,
    sidebarOpen,
    whatIfOpen,
    propertiesOpen,
    jsonOpen,
    useUniformScaling,
    massGenerosity,
    autoReroute,
    whatIfAnalysis,
    caseOverrides,
    conditionalOverrides
  });
}, [selectedNodeId, selectedEdgeId, sidebarOpen, whatIfOpen, /* ... */]);
```

This state is:
- Saved to `db.tabs` (IndexedDB)
- Restored on tab reopen
- Independent per tab (two tabs of same file can have different selections)

---

## Summary Diagram

```
┌──────────────────────────────────────────────────────────────────┐
│                         APPLICATION STATE                         │
├──────────────────────────────────────────────────────────────────┤
│                                                                   │
│  ┌─────────────────────────────────────────────────────────┐    │
│  │ GLOBAL (App-Wide)                                       │    │
│  │  • TabContext (open tabs, active tab)                   │    │
│  │  • rc-dock layout                                       │    │
│  │  • Navigator tree state                                 │    │
│  │  Storage: db.appState (IndexedDB)                       │    │
│  └─────────────────────────────────────────────────────────┘    │
│                                                                   │
│  ┌─────────────────────────────────────────────────────────┐    │
│  │ PER-FILE (Shared Across Tabs)                          │    │
│  │  ┌──────────────────────────────────────────────────┐   │    │
│  │  │ FileState (FileRegistry)                         │   │    │
│  │  │  • data (raw JSON)                  ← CANONICAL  │   │    │
│  │  │  • originalData (last saved)                     │   │    │
│  │  │  • isDirty                                       │   │    │
│  │  │  • source (repo, branch, commit)                 │   │    │
│  │  │  Storage: db.files (IndexedDB)                   │   │    │
│  │  └──────────────────────────────────────────────────┘   │    │
│  │                          ↕                               │    │
│  │  ┌──────────────────────────────────────────────────┐   │    │
│  │  │ GraphStore (Zustand, per fileId)                 │   │    │
│  │  │  • graph (raw graph data)                        │   │    │
│  │  │  • history[] (undo/redo stack)                   │   │    │
│  │  │  • historyIndex                                  │   │    │
│  │  │  Storage: In-memory (non-durable)                │   │    │
│  │  └──────────────────────────────────────────────────┘   │    │
│  └─────────────────────────────────────────────────────────┘    │
│                                                                   │
│  ┌─────────────────────────────────────────────────────────┐    │
│  │ PER-TAB (Tab-Specific UI)                              │    │
│  │  • TabState.editorState                                 │    │
│  │    - selectedNodeId, selectedEdgeId                     │    │
│  │    - panel visibility (sidebar, what-if, properties)    │    │
│  │    - what-if overrides (caseOverrides, conditional)     │    │
│  │    - editor preferences (lineWrap, autoReroute)         │    │
│  │  Storage: db.tabs (IndexedDB)                           │    │
│  └─────────────────────────────────────────────────────────┘    │
│                                                                   │
│  ┌─────────────────────────────────────────────────────────┐    │
│  │ GRAPH PRESENTATION (ReactFlow, per GraphCanvas)         │    │
│  │  • useNodesState, useEdgesState                         │    │
│  │  • Zoom/pan/viewport state                              │    │
│  │  • Selection state                                      │    │
│  │  • Drag state                                           │    │
│  │  Storage: ReactFlow internal (non-durable)              │    │
│  │  ← Rebuilt from GraphStore.graph via toFlow()          │    │
│  └─────────────────────────────────────────────────────────┘    │
│                                                                   │
└──────────────────────────────────────────────────────────────────┘

Data Flow:
  User Edit (GraphCanvas) → ReactFlow State
                          → fromFlow() → GraphStore.graph
                          → GraphEditor sync → FileState.data
                          → Notify listeners → Other tabs' GraphStore
                          → toFlow() → Other tabs' ReactFlow State
```

---

## Conclusion

This state architecture provides:
- **Single source of truth**: FileState is canonical
- **Per-file stores**: GraphStore shared across tabs viewing same file
- **Tab independence**: UI state isolated per tab
- **Clear boundaries**: Raw graph ↔ ReactFlow transform at GraphCanvas
- **Robust syncing**: Guards prevent feedback loops
- **Undo/redo**: Per-editor history stacks

Understanding these patterns is critical for maintaining consistency and avoiding state synchronization bugs as the application grows.

---

**End of Reference Document**

