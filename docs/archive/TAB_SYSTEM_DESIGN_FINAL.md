# Tab System Design - Complete Specification

**Status**: Final Design - Ready for Implementation  
**Last Updated**: 2025-10-27  
**Timeline**: 20 days  
**Technology**: rc-dock + React + TypeScript + IndexedDB

**Key Innovation**: Multiple views of same file can be open simultaneously in separate tabs (e.g., graph view + JSON view side-by-side), sharing data and updating in real-time. This leverages rc-dock's power for flexible workspace layouts.

---

## Table of Contents

1. [Overview & Goals](#overview--goals)
2. [Architecture](#architecture)
3. [Visual Layout & Mockups](#visual-layout--mockups)
4. [rc-dock Integration](#rc-dock-integration)
5. [Core Features](#core-features)
6. [Technology Stack](#technology-stack)
7. [Implementation Plan](#implementation-plan)
8. [Before & After Comparison](#before--after-comparison)

---

## Overview & Goals

### Vision
Transform the app from two separate pages into a **unified workspace** with:
- Multiple objects open simultaneously in tabs
- Drag-and-drop tab management
- Floating/docking windows
- Atomic multi-file commits
- Persistent state across sessions
- Professional IDE-like experience

### Problems Solved
1. ❌ **Context switching** - Currently lose context when navigating between graph/params pages
2. ❌ **No multi-file commits** - Each save creates separate commit
3. ❌ **No dirty tracking** - Can lose unsaved changes
4. ❌ **Inefficient navigation** - 7+ clicks to open a parameter
5. ❌ **No workspace management** - Can't compare or work on multiple objects

### Success Criteria
- ✅ Open 10+ tabs without lag
- ✅ Drag tabs to reorder, float, dock
- ✅ Commit multiple files atomically
- ✅ Dirty state accurate (no data loss)
- ✅ State persists across reload
- ✅ All existing graph features work
- ✅ Professional, polished UX

---

## Architecture

### High-Level Structure

```
rc-dock DockLayout (root)
├─ Menu Bar (locked panel, 40px height)
│  └─ File | Edit | View | Git | Help
│
├─ Navigator + Tab Bar (44px height)
│  ├─ Navigator Header [240px]
│  │  └─ [🔍 Search... | 📌 × ▲]
│  └─ Tab Bar [flex]
│     └─ [tab1] [tab2 *] [tab3] [+]
│
├─ Content Area (remaining height)
│  ├─ Navigator Panel [240px, collapsible]
│  │  ├─ Repo selector
│  │  ├─ Branch selector
│  │  └─ Object tree (Graphs, Params, Contexts, Cases)
│  │
│  └─ Main Tab Content [flex]
│     └─ Active editor (Graph, Form, or Raw)
│
└─ Float Boxes (dragged-out tabs)
   └─ Floating windows
```

### Key Hierarchies

**Visual Hierarchy**:
```
Menu Bar (global actions)
  ↓
Navigator Header + Tab Bar (workspace management)
  ↓
Navigator Panel | Tab Content (work area)
```

**Information Hierarchy**:
```
Menu > Navigator > Tabs > Content > Tab-specific panels
```

---

## Visual Layout & Mockups

### State 1: Navigator Collapsed (Default)

```
┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓
┃ File   Edit   View   Git   Help                                        ┃ Menu (40px)
┣━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┫
┃ [Navigator ▼] │ [graph-1.json *] [alpha] [beta] [context-1] [+]       ┃ Nav+Tabs (44px)
┣━━━━━━━━━━━━━━━┷━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┫
┃                                                                         ┃
┃                         Graph Editor (Full Width)                      ┃
┃              ┌───┐                    ┌───┐                            ┃
┃              │ A │───────────────────▶│ B │                            ┃
┃              └───┘                    └───┘                            ┃
┃                                                                         ┃
┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛
```

### State 2: Navigator Expanded (Overlay)

```
┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓
┃ File   Edit   View   Git   Help                                        ┃
┣━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┫
┃ [🔍 Search...  │📌 × ▲] │ [graph-1 *] [alpha] [beta] [+]              ┃
┣━━━━━━━━━━━━━━━━━━━━━━━━━┷━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┫
┃╔═════════════════════════╗                                             ┃
┃║ Repo: [dagnet ▼]       ║  Graph Editor (content behind)              ┃
┃║ Branch: [main ▼]       ║                                             ┃
┃║ ─────────────────────   ║                                             ┃
┃║ ▼ 📊 Graphs (12)       ║                                             ┃
┃║   • graph-1.json     ● ║  • = open tab                               ┃
┃║   • graph-2.json       ║  ● = dirty tab                              ┃
┃║                         ║                                             ┃
┃║ ▼ 📋 Parameters (45)   ║  Click item → opens tab                     ┃
┃║   • alpha            ● ║  Click 📌 → pins navigator                  ┃
┃║   • beta             ● ║  Click × → closes navigator                 ┃
┃║   • gamma              ║  Click outside → closes                     ┃
┃║                         ║                                             ┃
┃║ ▶ 📄 Contexts (8)      ║                                             ┃
┃║ ▶ 🗂  Cases (23)       ║                                             ┃
┃╚═════════════════════════╝                                             ┃
┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛
```

### State 3: Navigator Pinned (Continuous Vertical Panel)

```
┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓
┃ File   Edit   View   Git   Help                                        ┃
┣━━━━━━━━━━━━━━━━━━━━━━━━┯━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┫
┃ [🔍 Search...  │📌 × ▲] │ [graph-1.json *] [alpha] [beta] [+]         ┃
┣━━━━━━━━━━━━━━━━━━━━━━━━┼━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┫
┃ Repo: [dagnet ▼]       │                                              ┃
┃ Branch: [main ▼]       │           Graph Editor                       ┃
┃ ─────────────────────   │           (width reduced)                    ┃
┃                         │                                              ┃
┃ ▼ 📊 Graphs (12)       │       ┌───┐              ┌───┐              ┃
┃   • graph-1.json     ● │       │ A │─────────────▶│ B │              ┃
┃   • graph-2.json       │       └───┘              └───┘              ┃
┃                         │                                              ┃
┃ ▼ 📋 Parameters (45)   │                                              ┃
┃   • alpha            ● │                                              ┃
┃   • beta             ● │                                              ┃
┃   • gamma              │                                              ┃
┃                         │                                              ┃
┃ ▶ 📄 Contexts (8)      │                                              ┃
┃ ▶ 🗂  Cases (23)       │                                              ┃
┃                         │                                              ┃
┗━━━━━━━━━━━━━━━━━━━━━━━━┷━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛
  ↑ Navigator (240px)     ↑ Tab content (flex)
```

**Key Layout Features**:
- ✅ Navigator is **continuous vertical panel** (header + content)
- ✅ Navigator header **inline with tab bar** (same row)
- ✅ Search **integrated in header** (always accessible)
- ✅ Panel width **matches header width** (240px)
- ✅ Clean **vertical separator** between navigator and tabs

---

### State 4: Multiple Views of Same File (Side-by-Side)

```
┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓
┃ File   Edit   View   Git   Help                                        ┃
┣━━━━━━━━━━━━━━━━━━━━━━━━┯━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┫
┃ [🔍 Search...  │📌 × ▲] │ [graph-1.json *] [graph-1 (JSON) *] [+]     ┃
┣━━━━━━━━━━━━━━━━━━━━━━━━┼━━━━━━━━━━━━━━━━━━━━━━━┯━━━━━━━━━━━━━━━━━━━━━┫
┃ Repo: [dagnet ▼]       │   Graph Editor         │   JSON Editor       ┃
┃ Branch: [main ▼]       │   (Interactive View)   │   (Raw View)        ┃
┃ ─────────────────────   │                        │                     ┃
┃                         │   ┌───┐      ┌───┐   │  {                  ┃
┃ ▼ 📊 Graphs (12)       │   │ A │─────▶│ B │   │    "nodes": [       ┃
┃   • graph-1.json     ●●│   └───┘      └───┘   │      {              ┃
┃   • graph-2.json       │      │          │      │        "id": "a",  ┃
┃                         │      ▼          ▼      │        "label":"A" ┃
┃ ▼ 📋 Parameters (45)   │   ┌───┐      ┌───┐   │      },             ┃
┃   • alpha            ● │   │ C │─────▶│ E │   │      {              ┃
┃   • beta             ● │   └───┘      └───┘   │        "id": "b",  ┃
┃                         │                        │        "label":"B" ┃
┃ ▶ 📄 Contexts (8)      │                        │      }             ┃
┃ ▶ 🗂  Cases (23)       │                        │    ],              ┃
┃                         │                        │    "edges": [      ┃
┗━━━━━━━━━━━━━━━━━━━━━━━━┷━━━━━━━━━━━━━━━━━━━━━━━┷━━━━━━━━━━━━━━━━━━━━━┛
  ↑ Navigator              ↑ Left panel              ↑ Right panel
                           (Split layout via rc-dock)
```

**Key Features**:
- ✅ Both tabs show `graph-1.json *` (same file, dirty)
- ✅ Second tab labeled `(JSON)` to differentiate view type
- ✅ Navigator shows `●●` (two tabs open for same file)
- ✅ Edit in either view → other updates in real-time
- ✅ User can drag tabs to arrange: horizontal split, vertical split, floating
- ✅ Single save operation clears `*` on both tabs

---

## rc-dock Integration

### Why rc-dock?

**Selected**: rc-dock (v3.2.15)  
**Rationale**: Single cohesive UI framework for menu, navigator, tabs, floating

**Features Used**:
- ✅ Docking panels
- ✅ Tab management
- ✅ Drag & drop
- ✅ Floating windows
- ✅ Custom styling
- ✅ Layout persistence
- ✅ TypeScript support

### Layout Configuration

```typescript
import { DockLayout, LayoutData } from 'rc-dock';

const defaultLayout: LayoutData = {
  dockbox: {
    mode: 'vertical',
    children: [
      // Menu Bar (40px, locked)
      {
        mode: 'horizontal',
        size: 40,
        children: [{
          tabs: [{ 
            id: 'menu', 
            title: '', 
            content: <MenuBar />, 
            cached: true,
            closable: false
          }],
          panelLock: { panelStyle: 'menu-bar' }
        }]
      },
      
      // Main workspace
      {
        mode: 'horizontal',
        children: [
          // Navigator panel (240px, collapsible)
          {
            id: 'navigator',
            size: 240,
            tabs: [{ 
              id: 'nav', 
              title: '🔍 Navigator',
              content: <NavigatorContent />,
              cached: true,
              closable: false,
              // Custom header with search
              renderTab: (props) => <NavigatorTabHeader {...props} />
            }],
            panelLock: { 
              panelStyle: 'navigator',
              minSize: 180,
              maxSize: 400
            }
          },
          
          // Main tabs area
          {
            id: 'main-tabs',
            tabs: [], // User's tabs
            panelLock: {
              panelStyle: 'main-tabs'
            }
          }
        ]
      }
    ]
  },
  
  floatbox: {
    mode: 'float',
    children: [] // Floating windows
  }
};
```

### Opening New Tabs

```typescript
import { useContext } from 'react';
import { DockContext } from 'rc-dock';

function useTabs() {
  const dockContext = useContext(DockContext);
  
  const openTab = (item: RepositoryItem) => {
    const editor = getEditorForType(item.type);
    
    const tab = {
      id: `${item.type}-${item.id}`,
      title: item.name,
      content: editor,
      closable: true,
      group: 'main-content', // Allows floating
      
      // Custom data for dirty tracking
      data: {
        type: item.type,
        source: item.source,
        isDirty: false
      }
    };
    
    // Add to main tabs panel
    dockContext.dockMove(tab, 'main-tabs', 'middle');
    
    // User can now:
    // - Drag tab to reorder
    // - Drag tab out to float
    // - Drag to edges to dock
    // - Close, maximize, etc.
  };
  
  return { openTab };
}
```

### Editor Type Registry

```typescript
function getEditorForType(type: ObjectType, item: any) {
  const editors = {
    graph: <GraphEditor data={item} />,      // Contains nested rc-dock!
    parameter: <FormEditor data={item} schema={paramSchema} />,
    context: <FormEditor data={item} schema={contextSchema} />,
    case: <FormEditor data={item} schema={caseSchema} />
  };
  
  return editors[type];
}
```

### Nested rc-dock: Graph Editor with Flexible Sidebar

**Key Design**: Graph tabs contain their own rc-dock layout for flexible panels

```typescript
// GraphEditor component (content of graph tab)
function GraphEditor({ graphId, fileId }: EditorProps) {
  const { data, updateData } = useFileState(fileId);
  
  // Each graph tab has its own panel layout
  const [panelLayout, setPanelLayout] = useState<LayoutData>({
    dockbox: {
      mode: 'horizontal',
      children: [
        // Main canvas (left, flex)
        {
          id: `canvas-${graphId}`,
          tabs: [{
            id: 'canvas',
            title: '', // Hidden tab bar
            content: <GraphCanvas graph={data} onChange={updateData} />,
            closable: false
          }],
          size: 1,
          panelLock: { 
            panelStyle: 'canvas',
            minSize: 400
          }
        },
        
        // Sidebar panels (right, movable)
        {
          id: `sidebar-${graphId}`,
          mode: 'vertical',
          size: 300,
          children: [
            // What-If Analysis panel
            {
              tabs: [{
                id: 'whatif',
                title: 'What-If Analysis',
                content: <WhatIfAnalysis graph={data} />,
                closable: false
              }]
            },
            
            // Properties panel
            {
              tabs: [{
                id: 'properties',
                title: 'Properties',
                content: <PropertiesPanel graph={data} onChange={updateData} />,
                closable: false
              }]
            }
          ]
        }
      ]
    }
  });
  
  return (
    <DockLayout
      layout={panelLayout}
      onLayoutChange={setPanelLayout}
      groups={{
        'graph-panels': {
          floatable: true,      // Can drag out panels
          maximizable: true,    // Can maximize
          tabLocked: true       // Prevent closing panels
        }
      }}
    />
  );
}
```

**Benefits**:
- ✅ Each graph instance has independent panel layout
- ✅ User can float/snap What-If and Properties panels
- ✅ Multiple tabs of same graph can show different scenarios
- ✅ Panel arrangement persists per tab
- ✅ JSON View removed (handled by separate JSON tabs)

**Two Levels of rc-dock**:
```
App-Level DockLayout (outer)
├─ Navigator Panel
├─ Main Tabs Panel
│  └─ Graph Tab (contains...)
│     └─ Graph-Level DockLayout (inner, nested)
│        ├─ Canvas Panel
│        ├─ What-If Panel (floatable within graph)
│        └─ Properties Panel (floatable within graph)
```

**Sidebar Contents** (simplified):
- What-If Analysis (scenarios for THIS graph instance)
- Properties Panel (node/edge/graph properties)
- ~~JSON View~~ (removed - now separate JSON tabs)

---

## Core Features

### 1. Multiple Views of Same File (NEW: Leverages rc-dock)

**Feature**: Open same file in multiple tabs with different views

**Workflow**:
1. Open `graph.json` → Interactive tab (graph editor)
2. Right-click tab → "Open JSON View" → New tab with JSON editor
3. Both tabs share same underlying data
4. Edit in JSON → Graph tab updates in real-time
5. Edit in Graph → JSON tab updates in real-time
6. Can arrange side-by-side to see both simultaneously

**Tab Structure**:
```typescript
interface TabState {
  id: string;                      // Unique tab ID
  fileId: string;                  // Shared ID for same file
  viewMode: 'interactive' | 'raw-json' | 'raw-yaml';
  
  // Shared data reference
  data: any;                       // Points to same object
  isDirty: boolean;                // Shared dirty state
  
  source: {
    repository: string;
    path: string;                  // Same for all views
    branch: string;
  };
}

// Example: Same file, 3 tabs
// Tab 1: fileId="graph-123", viewMode="interactive"
// Tab 2: fileId="graph-123", viewMode="raw-json"
// Tab 3: fileId="graph-123", viewMode="raw-yaml"
```

**Benefits**:
- ✅ **Side-by-side comparison** - See graph and JSON simultaneously
- ✅ **Live updates** - Changes in one view update others
- ✅ **Flexible layout** - Drag tabs to split, float, or arrange
- ✅ **Multiple perspectives** - Interactive, JSON, YAML all open at once
- ✅ **Single source of truth** - One dirty state, one save operation
- ✅ **Power user friendly** - Edit JSON while seeing visual impact

### 2. View Menu (Context-Sensitive)

**When Graph Tab Active**:
```
View
├─ Open in New Tab
│  ├─ Open JSON View
│  └─ Open YAML View
├─ ─────────────
├─ Edge Scaling ⭐
│  ├─ ☑ Uniform
│  └─ Mass Generosity [slider]
├─ Re-route ⭐
├─ Auto Re-route ⭐
├─ Auto Layout ⭐
│  ├─ Left-to-right
│  ├─ Right-to-left
│  ├─ Top-to-bottom
│  └─ Bottom-to-top
├─ ─────────────
├─ Properties Panel ⭐
├─ What-If Analysis ⭐
└─ JSON View ⭐

⭐ = Preserved from current graph editor
```

**When Parameter/Context/Case Tab Active**:
```
View
├─ Open in New Tab
│  ├─ Open JSON View
│  └─ Open YAML View
├─ ─────────────
├─ Navigator Bar
└─ Tab Bar
```

**When JSON/YAML View Tab Active**:
```
View
├─ Open in New Tab
│  ├─ Open Interactive View
│  └─ Open YAML View (if currently JSON)
│      Open JSON View (if currently YAML)
├─ ─────────────
├─ Navigator Bar
└─ Tab Bar
```

### 3. Linked Tabs (Same File, Multiple Views)

**Implementation**: Tabs viewing the same file share data and dirty state

```typescript
// File registry (single source of truth)
interface FileState<T> {
  fileId: string;              // e.g. "graph-abc123"
  type: ObjectType;
  
  // Shared data
  data: T;                     // Current state
  originalData: T;             // For revert
  isDirty: boolean;            // Shared across all views
  
  // Source
  source: {
    repository: string;
    path: string;
    branch: string;
    commitHash?: string;
  };
  
  // Which tabs are viewing this file
  viewTabs: string[];          // Array of tab IDs
}

// Individual tab (view of a file)
interface TabState {
  id: string;                  // Unique tab ID
  fileId: string;              // Points to FileState
  viewMode: 'interactive' | 'raw-json' | 'raw-yaml';
  title: string;               // Display name (includes view type)
}

// Example:
// FileState: fileId="graph-123", isDirty=true, data={...}
// Tab 1: id="tab-1", fileId="graph-123", viewMode="interactive", title="my-graph.json *"
// Tab 2: id="tab-2", fileId="graph-123", viewMode="raw-json", title="my-graph.json (JSON) *"
```

**Tab Synchronization**:
```typescript
class FileRegistry {
  private files = new Map<string, FileState>();
  private listeners = new Map<string, Set<(data: any) => void>>();
  
  // Update file data (triggers all linked tabs to re-render)
  updateFile(fileId: string, newData: any) {
    const file = this.files.get(fileId);
    file.data = newData;
    file.isDirty = true;
    
    // Notify all tabs viewing this file
    this.listeners.get(fileId)?.forEach(callback => callback(newData));
  }
  
  // Subscribe tab to file updates
  subscribe(fileId: string, tabId: string, callback: (data: any) => void) {
    if (!this.listeners.has(fileId)) {
      this.listeners.set(fileId, new Set());
    }
    this.listeners.get(fileId).add(callback);
  }
}
```

**User Experience**:
1. User opens `graph.json` in Interactive mode → Tab 1
2. User opens JSON view → Tab 2 (shares same fileId)
3. User edits in Tab 1 (graph editor) → data updates
4. Tab 2 (JSON view) automatically updates with new data
5. User edits in Tab 2 (JSON editor) → data updates
6. Tab 1 (graph view) automatically redraws
7. Both tabs show `*` (dirty indicator)
8. Save once → saves for both tabs, clears `*` on both

**Visual Indicators**:
- All tabs of same file show asterisk: `my-graph.json *`, `my-graph.json (JSON) *`
- Tab titles differentiate view type: `(JSON)`, `(YAML)`
- Closing one view doesn't affect others
- Closing last view with unsaved changes → triggers save dialog

### 4. Multi-File Commit

**Workflow**:
1. User edits 3 parameters + 1 graph (all marked dirty)
2. User clicks Git → Commit All
3. Dialog shows all dirty files with checkboxes
4. User selects files to commit
5. Choose new branch or existing
6. Enter commit message
7. Single atomic commit created

**Commit Dialog**:
```
┌─────────────────────────────────────┐
│  Commit Changes                     │
├─────────────────────────────────────┤
│  Select files:                      │
│  ☑ parameters/alpha.json    [Diff] │
│  ☑ parameters/beta.json     [Diff] │
│  ☑ parameters/gamma.json    [Diff] │
│  ☑ graphs/my-graph.json     [Diff] │
│                                      │
│  Target:                            │
│  ● New branch                       │
│     [feature/multi-update      ]   │
│  ○ Existing: [main ▼]              │
│                                      │
│  Message:                           │
│  ┌──────────────────────────────┐  │
│  │ Update params and graph      │  │
│  └──────────────────────────────┘  │
│                                      │
│  [Cancel]           [Commit]       │
└─────────────────────────────────────┘
```

### 5. Tab Context Menu (Right-Click)

**Options**:
```
┌──────────────────────┐
│ Open in New Tab      │ →  ┌────────────────────┐
├──────────────────────┤    │ Open JSON View     │
│ Save                 │    │ Open YAML View     │
│ Revert               │    └────────────────────┘
├──────────────────────┤
│ Close                │
│ Close Others         │
│ Close to Right       │
│ Close All            │
├──────────────────────┤
│ Copy Path            │
│ Reveal in Navigator  │
└──────────────────────┘
```

**Behavior**:
- "Open JSON View" → Creates new tab with same fileId, viewMode="raw-json"
- "Open YAML View" → Creates new tab with same fileId, viewMode="raw-yaml"
- Both tabs share data and dirty state
- Can be arranged side-by-side via drag & drop

### 6. Floating & Docking

**Capabilities** (built-in with rc-dock):
- Drag tab out of tab bar → floating window
- Drag floating window to edge → docks back
- Drag tab to split panel → creates split layout
- Double-click tab bar → maximize
- Drag tabs between panels to reorganize

**Use Cases**:
- Compare two graphs side-by-side
- View JSON and interactive side-by-side while editing
- Float parameters while editing graph
- Multi-monitor workflows
- Custom workspace layouts

### 7. Persistent State (IndexedDB)

**Storage**: Dexie.js wrapper around IndexedDB

```typescript
class AppDatabase extends Dexie {
  tabs!: Table<TabRecord>;       // All open tabs
  appState!: Table<AppState>;    // UI state
  authTokens!: Table<AuthToken>; // Git credentials (encrypted)
}

// Saves:
// - Open tabs (id, type, data, source)
// - Dirty state
// - Active tab
// - Navigator state (open/pinned)
// - Layout configuration (rc-dock layout)
// - Last repository/branch

// Survives:
// - Browser restart ✅
// - Tab reload ✅
// - Crashes ✅

// Cleared:
// - User clears browser data
// - Manual "Clear Storage" in settings
```

### 8. Navigator Features

**Search**:
- Fuzzy search across all object types
- Filters tree in real-time
- Highlights matched text
- Search integrated in header (always visible when navigator open)

**Tree Structure**:
- Accordion sections per type (Graphs, Parameters, Contexts, Cases)
- Lazy load items when section expanded
- Visual indicators: ● open tab, • dirty tab
- Click item → opens/switches to tab
- Context menu (right-click) for actions

**Repository/Branch Selector**:
- Dropdown to select repository
- Dropdown to select branch
- Refresh objects when changed
- Shows current selection

---

## Technology Stack

### Core Dependencies

```json
{
  "dependencies": {
    // NEW - Primary UI Framework
    "rc-dock": "^3.2.15",                // Docking, tabs, floating
    "dexie": "^3.2.4",                   // IndexedDB wrapper
    "@monaco-editor/react": "^4.6.0",    // Raw JSON/YAML editor
    "js-yaml": "^4.1.0",                 // YAML parsing
    
    // EXISTING - Keep using
    "react": "^18.2.0",
    "react-dom": "^18.2.0",
    "react-router-dom": "^6.20.0",
    "reactflow": "^11.10.0",             // Graph editor
    "@rjsf/core": "^5.15.0",             // Form editor
    "zustand": "^4.4.7",                 // Graph state
    "@radix-ui/react-dropdown-menu": "^2.0.6"
  }
}
```

### Bundle Size Impact

| Component | Size | Notes |
|-----------|------|-------|
| rc-dock | ~50kb | Replaces custom tab/menu code |
| Dexie | ~20kb | IndexedDB wrapper |
| Monaco | ~500kb | Lazy loaded (only when Raw view used) |
| js-yaml | ~20kb | YAML support |
| **Total** | **~90kb** | Net: +90kb for all features |

**Acceptable**: Professional UI framework worth the size

---

## Implementation Plan

### Timeline: 20 Days (~160 hours)

### Phase 1: Foundation (Days 1-3)
**Goal**: Core infrastructure + rc-dock setup

- [ ] Install rc-dock + dependencies
- [ ] Define TypeScript interfaces (TabState, ObjectType, etc.)
- [ ] Create AppDatabase (Dexie schema)
- [ ] Set up rc-dock default layout
- [ ] Create TabContext provider
- [ ] Implement tab state management

**Deliverable**: Basic rc-dock layout renders, can open/close tabs

---

### Phase 2: Menu Bar (Days 4-5)
**Goal**: Functional menu bar integrated with rc-dock

- [ ] Create MenuBar component
- [ ] Implement File menu (New, Open, Save, etc.)
- [ ] Implement Edit menu (Undo, Redo, context-sensitive)
- [ ] Implement View menu (Display Mode, graph options, etc.)
- [ ] Implement Git menu (Commit, Branch, etc.)
- [ ] Wire menu actions to handlers
- [ ] Context-sensitive enable/disable

**Deliverable**: Working menu bar with all options

---

### Phase 3: Navigator (Days 6-7)
**Goal**: Navigator panel with search and tree

- [ ] Create NavigatorContent component
- [ ] Implement custom Navigator tab header (with search)
- [ ] Create ObjectTypeSection (accordion)
- [ ] Implement search/filter logic
- [ ] Add repository/branch selector
- [ ] Implement lazy loading
- [ ] Add visual indicators (open, dirty)
- [ ] Wire click handlers (open tab)

**Deliverable**: Functional navigator with search and object tree

---

### Phase 4: Tab System (Days 8-9)
**Goal**: Tab management and rc-dock integration

- [ ] Implement openTab() function
- [ ] Implement closeTab() with dirty check
- [ ] Implement switchTab()
- [ ] Add dirty state indicators (visual)
- [ ] Create unsaved changes dialog
- [ ] Test tab DND (reorder, float, dock)
- [ ] Implement tab context menu

**Deliverable**: Tabs open/close/switch correctly, can drag/float

---

### Phase 5: Editors (Days 10-13)
**Goal**: All editor types working in tabs

- [ ] Wrap GraphEditor for tab system
- [ ] Extract FormEditor from ParamsPage
- [ ] Create RawView component (Monaco)
- [ ] Implement View → Display Mode toggle
- [ ] Wire editor onChange to dirty state
- [ ] Test all editor types in tabs
- [ ] Preserve editor state when switching tabs

**Deliverable**: Graph, Form, and Raw editors all work in tabs

---

### Phase 6: Git & Storage (Days 14-16)
**Goal**: Commit workflow and persistence

- [ ] Create CommitDialog component
- [ ] Create DiffViewer component
- [ ] Implement batch save logic
- [ ] Create GitService
- [ ] Implement layout persistence (rc-dock state)
- [ ] Implement tab restoration on load
- [ ] Test multi-file commit workflow

**Deliverable**: Can commit multiple dirty files, state persists

---

### Phase 7: Polish (Days 17-19)
**Goal**: UX refinements and edge cases

- [ ] Add loading states (spinners)
- [ ] Add error boundaries
- [ ] Add toast notifications
- [ ] Implement keyboard shortcuts
- [ ] Add animations/transitions
- [ ] Custom rc-dock styling
- [ ] Accessibility audit (ARIA labels, focus, keyboard nav)
- [ ] Responsive behavior (min-width warnings)

**Deliverable**: Polished, professional UX

---

### Phase 8: Testing & Deployment (Day 20)
**Goal**: Integration testing and launch

- [ ] Integration testing (workflows)
- [ ] Performance testing (10+ tabs, large files)
- [ ] Accessibility testing (screen reader, keyboard)
- [ ] Update routing (remove old /params route)
- [ ] Write documentation (usage guide)
- [ ] Deploy to staging
- [ ] User acceptance testing
- [ ] Deploy to production

**Deliverable**: Shipped to production ✅

---

## Before & After Comparison

### Current State (Before)

#### Architecture: Two Separate Pages

**Page 1**: Graph Editor (`/`)
- Full-screen graph canvas
- Right sidebar with properties
- Can only view one graph at a time
- No connection to parameters

**Page 2**: Params Page (`/params`)
- Three-panel layout (repo | list | form)
- Can only edit one object at a time
- No connection to graphs
- Separate commits per file

#### Problems

1. **Context Switching**: Lose your place when navigating
2. **No Multi-File Commits**: 5 files = 5 separate commits
3. **No Dirty Tracking**: Can lose unsaved changes
4. **Inefficient Navigation**: 7+ clicks to open parameter
5. **No Comparison**: Can't view multiple objects

---

### New State (After)

#### Architecture: Unified Workspace

**Single App** with rc-dock:
- Menu bar (global actions)
- Navigator (browse all objects)
- Tabs (work on multiple objects)
- Floating windows (advanced layouts)
- Atomic commits (multiple files)

#### Benefits

1. ✅ **Seamless Context**: Multiple tabs open, switch with one click
2. ✅ **Atomic Commits**: Commit 5 files in single operation
3. ✅ **Dirty Tracking**: Visual indicators, warnings, no data loss
4. ✅ **Instant Navigation**: Search + click = open
5. ✅ **Workspace Management**: Compare, float, organize tabs

---

### Task Comparison

**Task**: Edit graph + 2 parameters for a feature

**Before** (18 steps, 2-3 minutes):
1. Go to graph editor
2. Load graph
3. Edit graph
4. Save graph → commit 1
5. Click "Params Page"
6. Select repository
7. Select "Parameters"
8. Scroll to param1
9. Click param1
10. Edit param1
11. Save param1 → commit 2
12. Scroll to param2
13. Click param2
14. Edit param2
15. Save param2 → commit 3
16. Click "Back to Graph"
17. Verify changes
18. Lost context multiple times

**Result**: 3 separate commits, messy history

---

**After** (10 steps, 1 minute):
1. Search "my-graph" → opens in tab
2. Edit graph → tab shows *
3. Click "Edit param" → opens in new tab
4. Edit param1 → tab shows *
5. Search "param2" → opens in tab
6. Edit param2 → tab shows *
7. Git → Commit All
8. Select all 3 files
9. Enter message: "feat: update graph and params"
10. Commit

**Result**: 1 atomic commit, clean history, all context preserved

**Improvement**: 44% fewer steps, 50% faster, cleaner git history ✅

---

## Key Design Decisions

### Navigator Placement
**Decision**: Continuous vertical panel, header inline with tabs  
**Rationale**: Professional IDE pattern, clear hierarchy

### Search Integration
**Decision**: Search input integrated in Navigator header  
**Rationale**: Always accessible, saves vertical space

### Tab Library
**Decision**: rc-dock for entire UI  
**Rationale**: Single cohesive framework, less custom code, more features

### Storage
**Decision**: IndexedDB via Dexie  
**Rationale**: Semi-durable, large capacity, structured data

### View Modes
**Decision**: Interactive/JSON/YAML toggle for all tabs  
**Rationale**: Useful for debugging, diffs, power users

### Commit Strategy
**Decision**: Multi-file with checkboxes  
**Rationale**: Maximum flexibility, atomic commits

---

## Success Metrics

### Must Pass Before Ship
- [ ] All existing graph features work
- [ ] Can open 10+ tabs without lag
- [ ] Dirty state accurate (no data loss)
- [ ] Commit all saves correctly
- [ ] Raw view validates JSON/YAML
- [ ] State persists across reload
- [ ] Navigator 3 states work smoothly
- [ ] No accessibility regressions
- [ ] Load time <3 seconds
- [ ] All View menu options functional

### Nice to Have (v1.1)
- [ ] Tab search (Cmd+P)
- [ ] Recently closed tabs (Cmd+Shift+T)
- [ ] Workspace presets (save layouts)
- [ ] Dark mode

### Future (v2)
- [ ] Git authentication (PATs)
- [ ] OAuth integration
- [ ] Collaboration (multiple users)
- [ ] Pull request creation

---

## Appendix: File Structure

```
graph-editor/src/
├─ App.tsx                          # Main app with rc-dock
├─ components/
│  ├─ AppShell.tsx                 # Layout wrapper
│  ├─ MenuBar/
│  │  ├─ MenuBar.tsx               # Menu bar component
│  │  ├─ FileMenu.tsx
│  │  ├─ EditMenu.tsx
│  │  ├─ ViewMenu.tsx
│  │  └─ GitMenu.tsx
│  ├─ Navigator/
│  │  ├─ NavigatorContent.tsx      # Navigator panel
│  │  ├─ NavigatorTabHeader.tsx    # Custom header with search
│  │  ├─ ObjectTypeSection.tsx     # Accordion sections
│  │  └─ ObjectList.tsx            # Item lists
│  ├─ TabBar/
│  │  ├─ Tab.tsx                   # Tab component
│  │  └─ TabContextMenu.tsx        # Right-click menu
│  ├─ editors/
│  │  ├─ GraphEditor.tsx           # Wrap existing
│  │  ├─ FormEditor.tsx            # Extract from ParamsPage
│  │  ├─ RawView.tsx               # Monaco editor
│  │  └─ EditorRegistry.ts         # Map types to editors
│  └─ dialogs/
│     ├─ CommitDialog.tsx          # Multi-file commit
│     ├─ DiffViewer.tsx            # Show diffs
│     └─ UnsavedChangesDialog.tsx  # Dirty check
├─ contexts/
│  ├─ TabContext.tsx               # Tab state management
│  └─ NavigatorContext.tsx         # Navigator state
├─ hooks/
│  ├─ useTabs.ts                   # Tab operations
│  ├─ useNavigator.ts              # Navigator logic
│  └─ useKeyboardShortcuts.ts      # Keyboard shortcuts
├─ services/
│  ├─ repositoryService.ts         # Load/save objects
│  ├─ gitService.ts                # Git operations
│  └─ layoutService.ts             # rc-dock layout persistence
├─ db/
│  └─ appDatabase.ts               # Dexie schema
├─ layouts/
│  └─ defaultLayout.ts             # rc-dock layout config
└─ styles/
   └─ dock-theme.css               # rc-dock custom styling
```

---

## Design Test: Settings Tab (Special Case)

### Use Case
Add a Settings tab accessible from menu bar (not Navigator) for editing:
- Git authentication tokens
- Application preferences
- Theme settings
- Keyboard shortcuts
- etc.

### What's Involved?

#### 1. Extend ObjectType
```typescript
// Add 'settings' as a special type
type ObjectType = 'graph' | 'parameter' | 'context' | 'case' | 'settings';
```

#### 2. Settings Tab Characteristics
```typescript
interface SettingsTab {
  type: 'settings';
  fileId: 'app-settings';        // Singleton ID
  source: {
    repository: 'local',         // Not from git
    path: 'app://settings',      // Virtual path
    branch: 'n/a'
  };
  
  // Settings data stored in IndexedDB, not git
  data: {
    git: {
      defaultRepo: string;
      authTokens: Record<string, string>;  // Encrypted
    };
    ui: {
      theme: 'light' | 'dark';
      navigatorDefaultOpen: boolean;
      tabLimit: number;
    };
    editor: {
      autoSave: boolean;
      showLineNumbers: boolean;
    };
  };
}
```

#### 3. Opening Settings Tab

**From Menu Bar**:
```typescript
// File menu or Help menu
Menu
├─ File
│  ├─ Settings...        ← Opens settings tab
│  
// Or
├─ Help
   └─ Settings...

// Handler
function openSettings() {
  const existingTab = findTabByFileId('app-settings');
  
  if (existingTab) {
    // Settings already open → switch to it (singleton)
    switchTab(existingTab.id);
  } else {
    // Create new settings tab
    openTab({
      type: 'settings',
      fileId: 'app-settings',
      title: 'Settings',
      icon: '⚙️',
      viewMode: 'interactive',
      closable: true,
      
      // Load from IndexedDB (not git)
      data: await loadSettings(),
      
      source: {
        repository: 'local',
        path: 'app://settings',
        branch: 'n/a'
      }
    });
  }
}
```

#### 4. Custom Settings Editor

**Register in Editor Registry**:
```typescript
const editors = {
  graph: GraphEditor,
  parameter: FormEditor,
  context: FormEditor,
  case: FormEditor,
  settings: SettingsEditor,     // ← NEW
};
```

**Settings Editor Component**:
```typescript
function SettingsEditor({ data, onChange }: EditorProps) {
  return (
    <div className="settings-editor">
      <SettingsTabs>
        <SettingsTab label="General">
          <SettingsSection title="Git Authentication">
            <RepositoryAuthList 
              tokens={data.git.authTokens}
              onChange={(tokens) => onChange({ 
                ...data, 
                git: { ...data.git, authTokens: tokens }
              })}
            />
          </SettingsSection>
          
          <SettingsSection title="Default Repository">
            <Select 
              value={data.git.defaultRepo}
              onChange={(repo) => onChange({
                ...data,
                git: { ...data.git, defaultRepo: repo }
              })}
            />
          </SettingsSection>
        </SettingsTab>
        
        <SettingsTab label="Appearance">
          <SettingsSection title="Theme">
            <RadioGroup 
              value={data.ui.theme}
              options={['light', 'dark']}
              onChange={(theme) => onChange({
                ...data,
                ui: { ...data.ui, theme }
              })}
            />
          </SettingsSection>
        </SettingsTab>
        
        <SettingsTab label="Editor">
          {/* Editor preferences */}
        </SettingsTab>
      </SettingsTabs>
    </div>
  );
}
```

#### 5. Saving Settings (Not to Git)

**Save Handler** (different from file save):
```typescript
async function saveSettings(data: SettingsData) {
  // Save to IndexedDB (not git)
  await db.appState.put({
    id: 'settings',
    data: data,
    updatedAt: Date.now()
  });
  
  // Apply settings immediately
  applySettings(data);
  
  // Clear dirty state
  updateTab('settings-tab', { isDirty: false });
}
```

#### 6. Exclude from Git Operations

**Commit Dialog** - filter out special tabs:
```typescript
function getCommittableTabs(): TabState[] {
  return tabs.filter(tab => 
    tab.isDirty && 
    tab.source.repository !== 'local'  // ← Exclude settings
  );
}

// Settings tab won't appear in "Commit All" dialog
```

#### 7. Navigator - No Listing

Settings doesn't appear in Navigator tree (not a repository file).  
Only accessible via menu.

---

### What Changes Are Needed?

#### Minimal Changes ✅

1. **Add `'settings'` to `ObjectType`** (1 line)
2. **Add `SettingsEditor` to editor registry** (1 line)
3. **Create `SettingsEditor` component** (new file)
4. **Add menu item** (1 line in MenuBar)
5. **Add `openSettings()` handler** (function in useTabs hook)
6. **Filter settings from git operations** (1 conditional)

#### No Changes Needed ✅

- Tab system (already handles any ObjectType)
- Dirty tracking (works the same)
- Tab UI (looks like any other tab)
- rc-dock integration (just another tab)
- Storage system (already has IndexedDB)

---

### Result: Seamless Integration

**Settings tab behaves like any other tab**:
- ✅ Shows in tab bar with ⚙️ icon
- ✅ Can be closed (with dirty check if unsaved)
- ✅ Can be moved/floated like any tab
- ✅ Has dirty state indicator (*)
- ✅ Save/Revert buttons work
- ✅ Keyboard shortcuts work (Cmd+S to save)

**But with special handling**:
- ✅ Singleton (only one instance)
- ✅ Opens from menu (not Navigator)
- ✅ Saves to IndexedDB (not git)
- ✅ Excluded from "Commit All"

---

### Testing Other Special Cases

#### Example: "About" Dialog Tab
```typescript
type ObjectType = '...' | 'about';

// Even simpler: read-only, no dirty state
openTab({
  type: 'about',
  fileId: 'app-about',
  title: 'About DagNet',
  closable: true,
  data: {
    version: '1.0.0',
    // ...
  }
});
```

#### Example: "Log Viewer" Tab
```typescript
type ObjectType = '...' | 'logs';

// Real-time updating tab
openTab({
  type: 'logs',
  fileId: 'app-logs',
  title: 'Logs',
  closable: true,
  data: logStream // Observable
});
```

---

### Design Strength: Extensible ✅

The tab system is **flexible enough** to handle:
- ✅ Repository files (graphs, params, etc.)
- ✅ Local app state (settings, preferences)
- ✅ Singleton tabs (only one instance)
- ✅ Special-purpose tabs (about, logs, etc.)
- ✅ Read-only tabs (no dirty state)
- ✅ Any custom editor component

**Without major architectural changes** - just:
- Add to ObjectType enum
- Create editor component
- Add menu item or open handler
- Done!

---

## Appendix: TypeScript Interfaces

```typescript
// Core Types (Extended)
type ObjectType = 
  | 'graph' 
  | 'parameter' 
  | 'context' 
  | 'case'
  | 'settings'        // ← Special: local app state
  | 'about'           // ← Special: read-only info
  | 'logs';           // ← Special: real-time stream

type ViewMode = 'interactive' | 'raw-json' | 'raw-yaml';

// Tab State
interface TabState<T = any> {
  id: string;
  type: ObjectType;
  title: string;
  icon?: string;
  
  source: {
    repository: string;
    path: string;
    branch: string;
    commitHash?: string;
  };
  
  isDirty: boolean;
  data: T;
  originalData: T;
  
  viewMode: ViewMode;
  editorState?: any;
}

// Tab Operations
interface TabOperations {
  openTab: (item: RepositoryItem) => void;
  closeTab: (tabId: string) => void;
  switchTab: (tabId: string) => void;
  updateTab: (tabId: string, updates: Partial<TabState>) => void;
  getDirtyTabs: () => TabState[];
}

// Navigator State
interface NavigatorState {
  isOpen: boolean;
  isPinned: boolean;
  searchQuery: string;
  selectedRepo: string;
  selectedBranch: string;
}

// Repository Item
interface RepositoryItem {
  id: string;
  type: ObjectType;
  name: string;
  path: string;
  description?: string;
  metadata?: Record<string, any>;
}
```

---

## Next Steps

1. ✅ Review and approve this design
2. ✅ Create feature branch `feature/tab-system`
3. ✅ Begin Phase 1 implementation
4. ✅ Iterate through phases 1-8
5. ✅ Ship to production

**Status**: Ready to implement ✅  
**Estimated Completion**: 20 working days from start

---

*Document maintained by: Assistant*  
*Last review: 2025-10-27*

