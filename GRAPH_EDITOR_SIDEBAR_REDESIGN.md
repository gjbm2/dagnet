# Graph Editor Sidebar Redesign - Audit & Design Proposal

**Date**: 2025-10-30  
**Status**: Design Proposal  
**Goal**: Reduce sidebar clutter, improve UX, and properly wire cases + conditional probabilities

---

## 1. AUDIT: Current Sidebar Functionality

### 1.1 Current Structure

```
┌─────────────────────────────────┐
│   GRAPH EDITOR SIDEBAR          │
│   (Right side, collapsible)     │
├─────────────────────────────────┤
│                                 │
│  📊 What-If Analysis            │ ← CollapsibleSection
│  ├─ Case Nodes (N items)        │
│  │  ├─ Node A: [variant▼]      │
│  │  ├─ Node B: [variant▼]      │
│  │  └─ ...                      │
│  └─ Conditional Probs (M groups)│
│     ├─ visited(X,Y): [override]│
│     ├─ visited(Z): [override]   │
│     └─ ...                      │
│                                 │
│  📝 Properties Panel            │ ← CollapsibleSection  
│  └─ Context-sensitive content:  │
│     ├─ No selection:            │
│     │  • Graph metadata         │
│     │  • Title, description     │
│     ├─ Node selected:           │
│     │  • Label, slug            │
│     │  • Description, tags      │
│     │  • Absorbing checkbox     │
│     │  • Outcome type           │
│     │  • Entry conditions       │
│     │  • **CASE MODE:**         │
│     │    - Case ID             │
│     │    - Parameter selector  │
│     │    - Variants list       │
│     │    - Add/edit/delete     │
│     └─ Edge selected:           │
│        • Probability input      │
│        • Parameter selector     │
│        • Costs (monetary/time)  │
│        • Case variant (if case) │
│        • **CONDITIONAL PROBS:** │
│          - Conditions list      │
│          - Add/edit/delete      │
│          - Node selector        │
│          - Color coding         │
└─────────────────────────────────┘
```

### 1.2 Mode Changes & Context Switching

| Context | Properties Panel Shows | What-If Panel Shows |
|---------|------------------------|---------------------|
| **No Selection** | Graph metadata | All case nodes + all conditionals (can be 20+ items) |
| **Normal Node Selected** | Standard node props | Same |
| **Case Node Selected** | Node props + **Case Mode UI** (variants editor, parameter link) | Same |
| **Normal Edge Selected** | Edge props (p, costs, parameter) | Same |
| **Edge with Conditional P** | Edge props + **Conditional Probs Section** (conditions editor, node selector) | Same |
| **Case Edge Selected** | Edge props + case variant selector | Same |



## 2. rc-dock Capabilities Assessment

### 2.1 What rc-dock Offers

From research and existing implementation:

```typescript
// rc-dock supports nested layouts (already used at app level)
export const dockGroups = {
  'graph-panels': {
    floatable: true,      // Can drag out panels
    maximizable: true,    // Can maximize
    tabLocked: true,      // Prevent closing panels
    animated: true
  }
};

// Example from TAB_SYSTEM_DESIGN_FINAL.md:
// Graph Editor can contain its own DockLayout
function GraphEditor() {
  return (
    <DockLayout
      layout={{
        dockbox: {
          mode: 'horizontal',
          children: [
            { id: 'canvas', tabs: [...] },      // Canvas (flex)
            { 
              mode: 'vertical',                  // Right sidebar panels
              children: [
                { id: 'whatif', tabs: [...] },   // What-If panel
                { id: 'properties', tabs: [...] } // Properties panel
              ]
            }
          ]
        }
      }}
    />
  );
}
```

### 2.2 Benefits of Using rc-dock for Sidebar

✅ **Floatable Panels**: User can drag Properties/What-If out into separate windows  
✅ **Dockable**: User can re-dock or rearrange panel order  
✅ **Maximizable**: User can maximize a panel temporarily  
✅ **Consistent UX**: Same docking behavior as main tabs  
✅ **Layout Persistence**: Panel arrangement saves per-tab  
✅ **Minimal Implementation**: Already using rc-dock, no new dependencies

### 2.3 Recommendation

✅ **USE rc-dock for sidebar panels** instead of custom CollapsibleSection

**Rationale**:
- More flexible than custom accordion
- Professional IDE-like experience
- Less code to maintain
- Users already familiar with rc-dock drag behavior from main tabs

---

## 3. Final Panel Structure

### 3.1 Three Panels

#### Panel 1: Properties (Context-Sensitive Editor)

**Purpose**: Edit currently selected item (graph/node/edge)  
**Behavior**: Content changes based on selection  
**Always Available**: Yes (can't close this panel)

**Content Structure** (using accordion within panel):
```
┌─────────────────────────────────┐
│ 📝 Properties                   │
├─────────────────────────────────┤
│                                 │
│  ▼ Basic Properties             │ ← Accordion section
│  ┌───────────────────────────┐  │
│  │ Slug                      │  │ ← CONNECTION FIELD (5px blue border)
│  │ [checkout-flow      ▼][⋮]│  │   Pastel styling draws eye to connection
│  └───────────────────────────┘  │
│  Label: [input]                 │
│  Description: [textarea]        │
│                                 │
│  ▼ ☑ Case Configuration         │ ← Checkbox toggles section
│  ┌───────────────────────────┐  │
│  │ Case                      │  │ ← CONNECTION FIELD (5px purple border)
│  │ [ab-test            ▼][⋮]│  │   Pastel styling draws eye to connection
│  └───────────────────────────┘  │
│  Variants:                      │
│  ├─ control    ●──── 50%       │ ← Sliders (existing UI)
│  └─ treatment  ●──── 50%       │
│  Status: [active ▼]            │
│                                 │
│  ▼ Probability (Edge only)      │
│  ┌───────────────────────────┐  │
│  │ Parameter                 │  │ ← CONNECTION FIELD (5px orange border)
│  │ [conversion-rate    ▼][⋮]│  │   Pastel styling draws eye to connection
│  └───────────────────────────┘  │
│  Base: ●──────────── 0.75      │ ← Slider (existing UI)
│  Stdev: [0.05]                 │ ← Input (standard styling)
│                                 │
│  ▼ Cost 1 (Edge only)           │
│  ┌───────────────────────────┐  │
│  │ Parameter                 │  │ ← CONNECTION FIELD (5px orange border)
│  │ [time-cost          ▼][⋮]│  │   Each cost has independent connection
│  └───────────────────────────┘  │
│  Value: [2.5]                   │
│                                 │
│  ▼ Cost 2 (Edge only)           │
│  ┌───────────────────────────┐  │
│  │ Parameter                 │  │ ← CONNECTION FIELD (5px orange border)
│  │ [money-cost         ▼][⋮]│  │   Each cost has independent connection
│  └───────────────────────────┘  │
│  Value: [150]                   │
│                                 │
└─────────────────────────────────┘
```

**Key Visual Design**:
- **CONNECTION FIELDS = Prominent 5px pastel borders** to draw user attention
- **Color-coded by type**: Blue (node), Purple (case), Orange (parameter), Green (context)
- Each connection field is a contained box with the standard selector + `[⋮]` sync menu
- Other inputs (Label, Description, Value, Stdev) have standard minimal styling

#### Panel 2: What-If Analysis

**Purpose**: Temporary overrides for analysis (ephemeral, per-tab)  
**Behavior**: Independent of selection  
**Can Close**: Yes (optional panel)

**Content**: (Existing implementation - styling improvements ONLY)
```
┌─────────────────────────────────┐
│ What-If Analysis (3 active)     │ ← Header with count
│                           [Clear]│ ← Clear button
├─────────────────────────────────┤
│                                 │
│  Case Overrides                 │
│  ├─ checkout-flow               │
│  │  [treatment ▼]              │ ← Dropdown selector
│  ├─ pricing-case                │
│  │  [variant-b ▼]              │
│  └─ payment-method              │
│     [control ▼]                 │
│                                 │
│  Conditional Overrides          │
│  ├─ visited(node-a, node-b)     │
│  │  ☑ Active                    │ ← Checkboxes
│  └─ visited(node-c)              │
│     ☐ Inactive                   │
│                                 │
└─────────────────────────────────┘
```

**STYLING CHANGES ONLY**:
- Match Navigator collapsible section styling
- Consistent spacing/padding with Properties panel
- **NO NEW FEATURES** (no save/load, no scenarios, no comparison)

#### Panel 3: Tools (Optional)

**Purpose**: Canvas tools and settings  
**Behavior**: Independent controls  
**Can Close**: Yes (optional panel)

**Content**:
```
┌─────────────────────────────────┐
│ 🛠️ Tools                        │
├─────────────────────────────────┤
│                                 │
│  🎨 Layout                      │
│  ├─ Auto-layout: [TB ▼]        │
│  └─ ☑ Auto-reroute             │
│                                 │
│  📏 Edge Scaling                 │
│  ├─ Global: ───●── 0.5 Local    |
│  └─ ☑ Uniform edge width       │
│                                 │
│  🔍 Visibility                  │
│  ├─ Hide unselected             │
│  └─ Show all                    │
│                                 │
│  ⚙️ View Options               │
│  ├─ ☑ Show node IDs            │
│  ├─ ☑ Show edge labels         │
│                                 │
└─────────────────────────────────┘
```

---

## 4. Implementation Plan

### Phase 1: Icon Bar Foundation (3-4 days)

**Tasks**:
1. Create icon bar component (48px width, right edge of canvas)
2. Implement three states: minimized (icon view), maximized (panel view), floating (rc-dock)
3. Add hover preview overlay system (shows panel content on hover when minimized)
4. Implement click to toggle maximize/minimize
5. State management: per-tab persistence of sidebar state
6. Smart auto-open logic: opens on first selection per tab, then respects user preference

**Files**:
- `graph-editor/src/components/SidebarIconBar.tsx` (NEW)
- `graph-editor/src/components/SidebarHoverPreview.tsx` (NEW)
- `graph-editor/src/components/editors/GraphEditor.tsx` (modify for icon bar integration)
- `graph-editor/src/hooks/useSidebarState.ts` (NEW - per-tab state management)

### Phase 2: Convert Sidebar to rc-dock Panels (3-4 days)

**Tasks**:
1. Replace `CollapsibleSection` with nested `DockLayout` in GraphEditor
2. Define `graph-panels` group with floatable/dockable settings
3. Create three panel tabs: Properties, What-If, Tools
4. Apply consistent styling to existing What-If content (no new features)
5. Test drag-out, re-dock, and layout persistence

**Files**:
- `graph-editor/src/components/editors/GraphEditor.tsx` (major refactor)
- `graph-editor/src/layouts/graphEditorLayout.ts` (NEW - default sidebar layout)
- `graph-editor/src/components/WhatIfPanel.tsx` (styling updates only)
- `graph-editor/src/components/ToolsPanel.tsx` (NEW)

### Phase 3: Accordion Styling for Properties (2-3 days)

**Tasks**:
1. Create accordion components matching Navigator style
2. Refactor Properties Panel sections to use accordions
3. Ensure smooth animations and state persistence
4. Add visual hierarchy (icons, colors, spacing)

**Files**:
- `graph-editor/src/components/Accordion.tsx` (NEW or reuse CollapsibleSection)
- `graph-editor/src/components/PropertiesPanel.tsx` (refactor sections)
- `graph-editor/src/components/Accordion.css` (styling)

### Phase 4: Case & Conditional Wiring (2-3 days)

**Tasks**:
1. Ensure case node UI in Properties Panel is fully wired
2. Verify conditional probabilities section updates graph correctly
3. Add validation for case variants (must sum to 1.0)
4. Add validation for conditional probability conditions (no duplicates)
5. Test edge cases (empty variants, orphaned conditions, etc.)

**Files**:
- `graph-editor/src/components/PropertiesPanel.tsx` (test & fix)
- `graph-editor/src/components/ConditionalProbabilitiesSection.tsx` (test & fix)
- `graph-editor/src/lib/validation.ts` (NEW - validation rules)

### Phase 5: Polish & Testing (2-3 days)

**Tasks**:
1. Responsive design (sidebar collapses on small screens)
2. Keyboard shortcuts (toggle panels, focus search, etc.)
3. Performance testing (large graphs with 50+ cases)
4. Accessibility audit (screen reader, keyboard nav)
5. User testing (get feedback on new layout)

**Total Estimate**: 10-15 days

---

## 5. Open Questions & Decisions

### Q1: Should Tools panel be separate or merged into What-If?

**Option A: Separate Tools Panel**
- ✅ Clean separation of concerns
- ✅ User can float tools independently
- ❌ More panels = more complexity

**Option B: Merge into What-If as "Advanced" section**
- ✅ Fewer panels
- ✅ All "control" UI in one place
- ❌ What-If panel gets crowded

**Recommendation**: Start with separate Tools panel, can merge later if users prefer

---

## 6. Visual Mockup (ASCII)

### Default Layout

```
┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓
┃  GRAPH EDITOR: conversion-flow.json                                  ┃
┣━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┳━━━━━━━━━━━━━━━━━━━━━━━━━┫
┃                                            ┃ 📝 Properties │ 🎭 │🛠️  ┃
┃                                            ┣━━━━━━━━━━━━━━━━━━━━━━━━━┫
┃                                            ┃                         ┃
┃   CANVAS                                   ┃  ▼ Basic Properties     ┃
┃                                            ┃  ├─ Label: Checkout     ┃
┃            ┌────┐         ┌────┐          ┃  ├─ Slug: checkout      ┃
┃            │ A  │────────▶│ B  │          ┃  └─ Desc: ...           ┃
┃            └────┘         └────┘          ┃                         ┃
┃               │              │             ┃  ▼ Case Configuration   ┃
┃               │              │             ┃  ├─ Mode: Registry      ┃
┃               ▼              ▼             ┃  ├─ Param: checkout-…   ┃
┃            ┌────┐         ┌────┐          ┃  └─ Variants:           ┃
┃            │ C  │         │ D  │          ┃     ├─ control (50%)    ┃
┃            └────┘         └────┘          ┃     └─ treatment (50%)  ┃
┃                                            ┃                         ┃
┃                                            ┃                         ┃
┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┻━━━━━━━━━━━━━━━━━━━━━━━━━┛
                                                   ↑
                                         Sidebar (300px, resizable)
```

---

## 7. Final Design Decisions

### 7.1 Icon Bar + rc-dock Integration

**How They Work Together**:

The sidebar has **three states**:

1. **Minimized (Icon Bar)** - Default state
   - 48px wide vertical bar on right edge
   - Shows 3 icons (🎭 What-If, 📝 Properties, 🛠️ Tools)
   - **Hover preview**: Hovering over icon shows overlay with panel content
   - **Click to open**: Clicking icon maximizes sidebar to full panel view
   
2. **Maximized (rc-dock Panels)** - User opened sidebar
   - 300px wide sidebar with rc-dock tab system
   - Shows one panel at a time (three tabs at top)
   - User can switch between panels via tabs
   - **Floating**: User can drag tabs out (rc-dock native feature)
   - **Minimize button**: Click to return to icon bar mode
   
3. **Floating (rc-dock Windows)** - User dragged panel out
   - Panel becomes floating window
   - Can be docked back **while sidebar is maximized** (rc-dock native)
   - If user closes floating panel → returns as icon in icon bar
   - **Cannot dock back when sidebar is minimized** (icon bar is custom UI, not rc-dock)

**State Persistence** (per-tab):
```typescript
interface SidebarState {
  mode: 'minimized' | 'maximized';        // Icon bar or full panel view
  activePanel: 'what-if' | 'properties' | 'tools';  // Which tab is selected
  floatingPanels: string[];               // Which panels are floating
  hasAutoOpened: boolean;                 // Smart auto-open tracker
}
```

---

### 7.2 Smart Auto-Open Logic

**Behavior**: Sidebar opens automatically once per tab, then respects user preference

```typescript
function handleNodeOrEdgeSelected(tabId: string) {
  const state = getSidebarState(tabId);
  
  // First selection in this tab?
  if (!state.hasAutoOpened && state.mode === 'minimized') {
    // Auto-open Properties panel
    setSidebarState(tabId, {
      mode: 'maximized',
      activePanel: 'properties',
      hasAutoOpened: true
    });
  }
  
  // User has manually minimized before? Respect their choice
  // (Don't auto-open again)
}
```

**User Actions That Override**:
- User clicks minimize → sidebar goes to icon bar, `hasAutoOpened` stays true
- Subsequent selections → sidebar stays minimized (user preference respected)
- User clicks icon → sidebar opens (manual action)
- User hovers icon → preview shows (quick access, doesn't change state)

---

### 7.3 Object Creation - Existing Affordances

**Decision**: Use existing right-click context menu for object creation

```typescript
// Canvas right-click context menu (existing)
onCanvasContextMenu(position: { x: number, y: number }) {
  showContextMenu([
    { label: 'New Node', action: () => createNode(position) },
    { label: 'Paste', action: () => paste() },
    { label: 'Select All', action: () => selectAll() }
  ]);
}

// Unified node creation (used by all creation methods)
function createNode(position: { x: number, y: number }): void {
  const newNode = {
    id: generateNodeId(),
    label: 'New Node',
    slug: generateSlug(),
    position,
    layout: { x: position.x, y: position.y, rank: 0 }
  };
  
  addNodeToGraph(newNode);
  selectNode(newNode.id);  // Auto-select → Properties opens
}
```

**Current creation methods**:
1. Right-click canvas → "New Node"
2. Objects menu (if exists) → "New Node"
3. Keyboard shortcut (if exists)

**Deferred**:
- Drag & drop from object palette (not needed yet)
- Click-to-create from palette (not needed yet)

**Benefits**:
- ✅ No new UI paradigms to learn
- ✅ Familiar interaction (right-click)
- ✅ Can add palette later when needed

---

### 7.3 Keyboard Shortcuts

**Proposed Shortcuts** (following VS Code conventions):

| Shortcut | Action | Context |
|----------|--------|---------|
| `Ctrl/Cmd + B` | Toggle sidebar (minimize ↔ maximize) | Global |
| `Ctrl/Cmd + Shift + W` | Open What-If panel | Sidebar maximized |
| `Ctrl/Cmd + Shift + P` | Open Properties panel | Sidebar maximized |
| `Ctrl/Cmd + Shift + T` | Open Tools panel | Sidebar maximized |
| `Ctrl/Cmd + 1/2/3` | Switch to panel 1/2/3 | Sidebar maximized |
| `Esc` | Close dropdowns/overlays | When dropdown open |
| `Tab` | Navigate between form fields | Properties panel |
| `Enter` | Confirm selection | Dropdown menu |
| `Up/Down` | Navigate dropdown items | Dropdown menu |

**Implementation Notes**:
- Register shortcuts in GraphEditor component
- Shortcuts disabled when modal/dialog open
- Visual indicators (tooltip showing shortcut on hover)

---

### 7.4 Sidebar Panel Structure - THREE Panels

**Decision**: Three panels of equal width (300px each)

1. **🎭 What-If** - Temporary analysis overrides (ephemeral, per-tab)
   - Case variant overrides
   - Conditional probability overrides
   - Clear button
   
2. **📝 Properties** - Context-sensitive editor
   - Graph properties (no selection)
   - Node properties + Case configuration
   - Edge properties + Conditional probabilities
   
3. **🛠️ Tools** - Canvas controls
   - Layout (auto-layout, mass generosity, auto-reroute)
   - Scaling (uniform edge width)
   - Visibility (hide/show)

**Rationale**:
- rc-dock panels in same sidebar must be same width
- Clean separation: analysis (What-If) vs editing (Properties) vs controls (Tools)
- All three panels are optional (can minimize to icon bar)
- Object creation deferred - use existing right-click context menu

```
┌────────────────────────────┬─────────────┐
│  CANVAS                    │🎭│📝│🛠️      │ ← 3 tabs
│                            ├─────────────┤
│  Right-click for:          │ What-If     │
│  • New Node                │             │
│  • New Edge                │ ▼ Cases (2) │
│  • Delete                  │ • checkout  │
│  • Properties              │ • pricing   │
│                            │             │
│   ┌───┐      ┌───┐        │ ▼ Cond. (1) │
│   │ A │─────▶│ B │        │ • visited(A)│
│   └───┘      └───┘        │             │
│                            │ [Clear]     │
└────────────────────────────┴─────────────┘
```

**Deferred**: Object Palette
- Not needed initially (only one object type: node)
- Right-click context menu is sufficient
- Can add later when we have rectangles, labels, etc.

---

### 7.5 Full Properties Panel Content Specification

This section defines complete field lists for each selection context.

#### 7.5.1 Graph Properties (No Selection)

```
┌─────────────────────────────────────┐
│ 📝 Properties                       │
├─────────────────────────────────────┤
│ ▼ Graph Metadata                    │
│ ├─ Name: [text input]               │
│ ├─ Description: [textarea]          │
│ ├─ Version: [text, read-only]       │
│ ├─ Author: [text, read-only]        │
│ ├─ Created: [date, read-only]       │
│ └─ Modified: [date, read-only]      │
│                                     │
│ ▼ Statistics                        │
│ ├─ Total Nodes: [15]                │
│ ├─ Total Edges: [23]                │
│ ├─ Case Nodes: [3]                  │
│ └─ Conditional Edges: [2]           │
└─────────────────────────────────────┘
```

#### 7.5.2 Node Properties (Standard Node, No Case)

**Field Order** (top to bottom):

```
┌─────────────────────────────────────┐
│ 📝 Properties                       │
├─────────────────────────────────────┤
│ ▼ Basic Properties                  │
│ ┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓  │
│ ┃ Slug                        ┃  │  ← CONNECTION (blue border)
│ ┃ 🔌 [checkout-flow   ▼][⋮]  ┃  │
│ ┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛  │
│ Label: [Checkout Flow]             │
│ Description: [textarea]            │
│ Tags: [chip input]                 │
│                                    │
│ ▼ Node Behavior                    │
│ ☐ Start                           │
│ ☐ Terminal                        │
│ Outcome Type: [success ▼]         │
│   Options: success, failure, neutral│
│                                    │
│ ▼ ☐ Case Configuration             │  ← Collapsed by default
│   (Expands when checkbox enabled)  │
└─────────────────────────────────────┘
```

#### 7.5.3 Edge Properties (Standard Edge, No Conditionals)

**Field Order** (top to bottom):

```
┌─────────────────────────────────────┐
│ ➡️ Properties                        │
├─────────────────────────────────────┤
│ ▼ Probability                       │
│ ┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓  │
│ ┃ Parameter                   ┃  │  ← CONNECTION (orange border)
│ ┃ 🔌 [conversion-rate ▼][⋮]  ┃  │
│ ┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛  │
│ Base: ●──────────── 0.75          │ ← existing slider component
│ Stdev: [0.05]                     │
│                                    │
│ ▼ Cost 1                           │
│ ┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓  │
│ ┃ Parameter                   ┃  │  ← CONNECTION (orange border)
│ ┃ 🔌 [time-cost       ▼][⋮]  ┃  │
│ ┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛  │
│ Monetary: [$2.50]                 │
│ ± [$0.50]                         │
│ Time: [5.0] sec                   │
│ ± [0.5] sec                       │
│                                    │
│ ▼ Cost 2                           │
│ ┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓  │
│ ┃ Parameter                   ┃  │  ← CONNECTION (orange border)
│ ┃ 🔌 [money-cost      ▼][⋮]  ┃  │
│ ┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛  │
│ Monetary: [$1.00]                 │
│ ± [$0.25]                         │
│ Time: [2.0] sec                   │
│ ± [0.2] sec                       │
│                                    │
│ ▼ ☐ Conditional Probabilities      │  ← Collapsed by default
│   (Expands when checkbox enabled)  │
└─────────────────────────────────────┘
```

---

### 7.6 Tools Panel - Full Specification

**Purpose**: Provide quick access to existing canvas manipulation tools

**Content**: All tools lifted from existing View menu and graph controls

```
┌─────────────────────────────────────┐
│ 🛠️ Tools                            │
├─────────────────────────────────────┤
│ ▼ Layout                            │
│ [Auto-Layout]                       │  ← Calls existing auto-layout - with sub menus (like existing View menu)
│ [Force Re-route]                    │  ← Calls existing re-route
│                                     │
│ Edge scaling:         │
│ Global ────x──── Local                     │  ← Slider for edge spacing (re-use existing view menu component)
│ ☑ Uniform Edge Width                │  ← Checkbox
│                                     │
│ ▼ Visibility                        │
│ [Hide Unselected]                   │  ← Toggles visibility
│ [Show All]                          │  ← Restores visibility
└─────────────────────────────────────┘
```

**Implementation**:
- **Refactor through service**: Create `graphToolsService.ts` to centralize logic
- **Single code path**: Menu bar and Tools panel both call service methods
- **Existing functionality**: No new features, just convenient access

```typescript
// graph-editor/src/services/graphToolsService.ts
export const graphToolsService = {
  autoLayout(graph: GraphData): GraphData {
    // Existing auto-layout logic
  },
  
  forceReroute(graph: GraphData): GraphData {
    // Existing re-route logic
  },
  
  setMassGenerosity(graph: GraphData, value: number): GraphData {
    // Update edge spacing
  },
  
  toggleUniformEdgeWidth(enabled: boolean): void {
    // Update render settings
  },
  
  hideUnselected(graph: GraphData, selectedIds: string[]): GraphData {
    // Hide non-selected nodes
  },
  
  showAll(graph: GraphData): GraphData {
    // Restore all visibility
  }
};
```

---

### 7.7 Accordion Behavior Specification

**Behavior**:
- **Multiple open**: Yes, multiple accordions can be open simultaneously
- **State persistence**: Per-tab, stored in tab state
- **Animation**: Yes, smooth expand/collapse (150ms ease-in-out) - not critical
- **Nested accordions**: Not supported in initial implementation
- **Default states**:
  - Basic Properties: Open
  - Case Configuration: Closed (unless node is case)
  - Conditional Probabilities: Closed (unless edge has conditionals)
  - Node Behavior: Open
  - Layout/Scaling/Visibility (Tools): Open

```typescript
interface AccordionState {
  [accordionId: string]: boolean;  // true = open, false = closed
}

// Per-tab storage
interface TabState {
  sidebarState: SidebarState;
  accordionStates: AccordionState;
}
```

---

### 7.8 Conditional Probabilities - Complete Workflow

**Scenario**: User wants to set edge A→B probability to 0.9 if user visited nodes X and Y

#### Step 1: Enable Conditional Probabilities on Edge

```
1. User selects edge A→B
2. Properties panel shows edge properties
3. User checks "☑ Conditional Probabilities" checkbox
4. Accordion expands to show conditional probability editor
```

#### Step 2: Add First Condition

```
┌─────────────────────────────────────┐
│ ▼ ☑ Conditional Probabilities       │
│                                     │
│ [+ Add Condition]                   │  ← User clicks
│                                     │
└─────────────────────────────────────┘
```

After click, new condition card appears:

```
┌─────────────────────────────────────┐
│ ▼ ☑ Conditional Probabilities       │
│                                     │
│ ┌─────────────────────────────┐ [×]│  ← Delete button
│ │ Condition 1                 │    │
│ │ Color: [🔵]                 │    │  ← Color selector
│ │                             │    │
│ │ IF VISITED:                 │    │
│ │ ┏━━━━━━━━━━━━━━━━━━━━━━━┓  │    │
│ │ ┃ 🔌 [Select nodes ▼][⋮]┃  │    │  ← Node selector (CONNECTION)
│ │ ┗━━━━━━━━━━━━━━━━━━━━━━━┛  │    │
│ │ [+ Add Node]                │    │  ← Add multiple nodes (AND logic)
│ │                             │    │
│ │ THEN:                       │    │
│ │ ┏━━━━━━━━━━━━━━━━━━━━━━━┓  │    │
│ │ ┃ Parameter              ┃  │    │  ← Param selector (CONNECTION) for probability sub-type
│ │ ┃ 🔌 [high-conv ▼][⋮]   ┃  │    │
│ │ ┗━━━━━━━━━━━━━━━━━━━━━━━┛  │    │
│ | Base: ●──────────── 0.75     |     │ ← existing slider component
│ | Stdev: [0.05]                |     │
│ └─────────────────────────────┘    │
│                                     │
│ [+ Add Condition]                   │  ← Add more (OR logic)
│                                     │
└─────────────────────────────────────┘
```

#### Step 3: User Selects Nodes (Multi-Select)

```
User clicks "Select nodes ▼" dropdown:

┌─────────────────────────────────────┐
│ 📋 Current Graph (5)                │  ← Only for "If Visited" context
│ ├─ • node-a                         │
│ ├─ • node-b                         │
│ ├─ 🔌 node-x (Used in Cond A→C)    │  ← In-use indicator + sub-line
│ ├─ • node-y                         │
│ └─ • node-z                         │
│                                     │
│ 📑 Node Registry (12)               │
│ ├─ • checkout-node                  │
│ ├─ • payment-node                   │
│ └─ ...                              │
│                                     │
│ Showing 17 of 17                    │
└─────────────────────────────────────┘
```

User selects "node-x", dropdown closes, chip appears:

```
│ IF VISITED:                 │
│ ┏━━━━━━━━━━━━━━━━━━━━━━━┓  │
│ ┃ 🔌 [              ▼][⋮]┃  │
│ ┗━━━━━━━━━━━━━━━━━━━━━━━┛  │
│ [node-x ×]                  │  ← Chip with delete
│ [+ Add Node]                │
```

User clicks "[+ Add Node]" to add "node-y" (AND condition):

```
│ IF VISITED:                 │
│ ┏━━━━━━━━━━━━━━━━━━━━━━━┓  │
│ ┃ 🔌 [              ▼][⋮]┃  │
│ ┗━━━━━━━━━━━━━━━━━━━━━━━┛  │
│ [node-x ×] [node-y ×]       │  ← Multiple chips = AND
│ [+ Add Node]                │
```

#### Step 4: User Selects Parameter

User clicks parameter selector, chooses "high-conversion":

```
│ THEN:                       │
│ ┏━━━━━━━━━━━━━━━━━━━━━━━┓  │
│ ┃ Parameter              ┃  │
│ ┃ 🔌 [high-conv     ▼][⋮]┃  │  ← Now connected (black plug)
│ ┗━━━━━━━━━━━━━━━━━━━━━━━┛  │
│ Probability: 0.90           │  ← Auto-populated from parameter
│ Color: [🔵]                 │  ← Auto-populated or user-selectable
```

#### Step 5: Add Second Condition (OR logic)

User clicks "[+ Add Condition]" to add alternative scenario:


```

#### Step 6: Canvas Visualization Updates

As user adds conditions, the edge on canvas updates:
- Edge color shows first matching condition color
- Tooltip shows "Conditional: 2 rules"
- Existing canvas visualization renders condition indicators

**Logic**:
- **Within a condition**: Multiple nodes = AND (all must be visited)
- **Between conditions**: Multiple conditions = OR (first match wins)
- **Evaluation order**: Top to bottom (reorder by dragging cards)

**Deletion**:
- Click [×] on chip → Removes that node from condition
- Click [×] on card → Deletes entire condition
- Uncheck "Conditional Probabilities" → Removes all conditions, reverts to base probability

---

## 8. Summary & Recommendation

### ✅ Recommended Approach

1. **Icon Bar + rc-dock Integration** - Icon bar for minimized state, rc-dock for maximized panels
2. **Three Panels** - What-If, Properties, Tools (300px width when maximized)
3. **Smart Auto-Open** - Properties opens on first selection per tab, then respects user
4. **Hover Preview** - Quick access to panel content when sidebar is minimized
5. **Per-Tab State** - All sidebar and accordion states persist per-tab
6. **Keyboard Shortcuts** - VS Code-style shortcuts for toggle/navigation
7. **Existing Creation Methods** - Right-click context menu (no palette needed)

### 🎯 Expected Outcomes

- ✅ **Cleaner canvas** - Icon bar only takes 48px when minimized (default)
- ✅ **Quick access** - Hover preview for instant viewing without state change
- ✅ **Less annoying** - Smart auto-open respects user preferences
- ✅ **Professional UX** - VS Code-style panel management with rc-dock power
- ✅ **Flexible layout** - Panels can float, dock, resize via rc-dock
- ✅ **Consistent experience** - Tools panel uses same code paths as menus
- ✅ **Future-proof** - Easy to add new panels or object types

### 📋 Implementation Phases (Aligned with Section 4)

**Phase 1: Icon Bar Foundation (3-4 days)**
- Icon bar component (48px, right edge, minimized state)
- Three icon states: minimized, maximized, floating
- Hover preview overlay system
- Smart auto-open logic (once per tab)
- Per-tab state persistence (SidebarState interface)

**Phase 2: Convert Sidebar to rc-dock Panels (3-4 days)**
- Replace CollapsibleSection with rc-dock layout
- Three tabs: What-If, Properties, Tools
- Floatable/dockable configuration
- Integration with icon bar (minimize/maximize)
- Handle floating panel close → return to icon bar

**Phase 3: Accordion Styling for Properties (2-3 days)**
- Create accordion components (or reuse/enhance CollapsibleSection)
- Apply to Properties panel (Graph/Node/Edge contexts)
- Per-tab accordion state persistence
- Smooth animations (150ms, non-critical)

**Phase 4: Case & Conditional Wiring (2-3 days)**
- Full node properties specification (Slug first, Case configuration)
- Full edge properties specification (Probability + Cost 1 + Cost 2)
- Conditional probability workflow (multi-node selector, parameter connection)
- Case node boolean toggle + variants editor
- Validation and canvas synchronization

**Phase 5: Polish & Testing (2-3 days)**
- Keyboard shortcuts implementation (Ctrl/Cmd + B, etc.)
- Tools panel (refactor through graphToolsService)
- Responsive design considerations
- Accessibility audit
- Performance testing (large graphs, long dropdowns)
- User testing and bug fixes

**Total Estimate: 13-16 days**

### 📋 Next Steps

1. ✅ Design clarified - Icon bar AND rc-dock work together
2. ✅ All ambiguities resolved - State management, workflow, specifications
3. ✅ Full property lists defined - Graph, Node, Edge
4. ✅ Conditional probability workflow narrated - Step-by-step interaction
5. ✅ Color selector specified - HTML5 native picker
6. ✅ Inline creation specified - Create new registry items from selector
7. 🔄 **Ready for implementation** - Start Phase 1

### 🎯 Design Decisions Summary

**✅ Resolved**:
- Icon bar + rc-dock integration (how they work together)
- State management (per-tab, SidebarState interface)
- Smart auto-open logic (once per tab)
- Keyboard shortcuts (full set proposed)
- Property panel content (Graph, Node, Edge - all fields)
- Tools panel content (existing menu items refactored)
- Accordion behavior (multiple open, per-tab persistence)
- Conditional probabilities workflow (complete step-by-step)
- **Color selector**: HTML5 native picker with 9 presets + custom
- **Inline creation**: Create new registry item when typed ID doesn't exist
- **Design consolidation**: Removed duplicate Section 9.4, clarified source of truth

**📐 Document Structure** (Source of Truth):
- **Section 7.5**: Functional specifications (field lists, order, behavior)
- **Section 7.8**: Interaction workflows (conditional probabilities step-by-step)
- **Section 9**: Visual design (colors, borders, styling, mockups)
- **Rule**: If conflicts exist, Section 7.x takes precedence over Section 9.x

**⏳ Deferred to Implementation Phase**:
- Reordering condition cards (drag handle UI)
- Smart sorting (in-use first vs alphabetical)
- Template selection for complex types
- Multi-select for conditional "visited" nodes (Phase 2+)

**⏳ Deferred to Phase 5 (Polish)**:
- Mobile/responsive breakpoints
- Accessibility specifics (ARIA labels, focus management)
- Performance optimizations (virtual scrolling, debouncing)
- Preview pane for registry items on hover

---

## Appendix: Icon Bar Visual States

### Icon Visual Indicators

```
Icon States:
📝  ← Gray (in icon bar, click to open)
📝  ← Blue (in sidebar, click to focus)
📝↗ ← Orange dot (floating, click to focus window)

Icon Order (top to bottom):
🎭 What-If
📝 Properties
🛠️ Tools
```

### Hover Preview Behavior

```
TRIGGER: Mouse enters icon + 300ms delay
SHOW: Panel slides in from right (200ms animation)
STABLE: Mouse enters panel content → stays open
HIDE: Mouse leaves panel + 500ms delay

EXCEPTION: If user clicks icon → permanently docks
```

### Smart Auto-Open Logic

```typescript
// Per-tab state
interface TabPanelState {
  propertiesAutoOpened: boolean;   // Has auto-opened in this tab?
  propertiesUserClosed: boolean;   // User explicitly closed?
}

// Decision tree
if (selection && !propertiesAutoOpened && !propertiesUserClosed) {
  openProperties();  // First time only
  propertiesAutoOpened = true;
}
```

---

## 9. Visual Language & Color System

**Purpose of This Section**: This section provides the **visual design specification** for components defined functionally in earlier sections.

**Relationship to Other Sections**:
- **Section 7.5**: Functional specifications (what fields, what order, what behavior)
- **Section 9**: Visual design (colors, borders, styling, layout)
- **Section 7.8**: Interaction workflows (step-by-step user flows)

**⚠️ SOURCE OF TRUTH**:
- **Functional specs**: Section 7.5 (field lists, order, behavior)
- **Interaction flows**: Section 7.8 (conditional probabilities complete workflow)
- **Visual styling**: Section 9 (colors, borders, input styling)

If there are conflicts, the functional spec in Section 7.x takes precedence over visual mockups in Section 9.x.

---

### 9.1 Object Type Color Palette

**Purpose**: Provide consistent visual language across Navigator, tabs, and Properties panel

```
📊 Graphs:      #FEF3C7 (light amber)   - Accent: #FBBF24
🔵 Nodes:       #DBEAFE (light blue)    - Accent: #3B82F6
🗂️  Cases:       #F3E8FF (light purple)  - Accent: #A78BFA
📄 Contexts:    #D1FAE5 (light green)   - Accent: #34D399
📋 Parameters:  #FED7AA (light orange)  - Accent: #FB923C
🔗 Edges:       #E0E7FF (light indigo)  - Accent: #6366F1
⚙️  Special:     #F3F4F6 (light grey)    - Accent: #9CA3AF
```

**Applied to**:
1. Navigator section headers (gradient)
2. Tab top borders and backgrounds
3. Connection fields in Properties panel
4. Node types in canvas (optional subtle tint)

---

### 9.2 Connection Fields - Critical Affordance

**Philosophy**: Connections are **optional but preferred**
- Connecting to registry enables automation (auto-load variants, probabilities)
- Manual mode still fully functional (user defines inline)
- Visual treatment highlights connection opportunity without forcing it

#### Node Properties

```
┌─────────────────────────────────────────┐
│ 📝 Node Properties                      │
├─────────────────────────────────────────┤
│ ▼ Basic Properties                      │
│                                         │
│ ┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓  │
│ ┃ Slug                             ┃  │ ← CONNECTION (5px blue border)
│ ┃ [checkout-flow      ▼][⋮]       ┃  │   Pastel blue background
│ ┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛  │
│                                         │
│ Label: [Checkout Flow            ]     │ ← Standard input (minimal)
│ Description: [textarea...        ]     │ ← Standard input (minimal)
│                                         │
│ ▼ ☑ Case Configuration                 │ ← Checkbox in section header
│                                         │
│ ┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓  │
│ ┃ Case                             ┃  │ ← CONNECTION (5px purple border)
│ ┃ [checkout-ab-test   ▼][⋮]       ┃  │   Pastel purple background
│ ┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛  │
│                                         │
│ Variants:                               │
│ ├─ control    ●────────────── 50%      │ ← Slider (existing style)
│ ├─ treatment  ●────────────── 50%      │
│ └─ [+ Add Variant]                     │
│                                         │
│ Status: [active ▼]                     │ ← Standard dropdown (minimal)
└─────────────────────────────────────────┘
```

**Sync Menu** (appears when clicking [⋮] icon):
```
┌────────────────────────────┐
│ ↓ Pull from Registry       │
│ ↑ Push to Registry         │
│ 🔄 Retrieve Latest (live)  │
└────────────────────────────┘
```

**Behavior**:
1. **Slug Selector**: Dropdown shows graph nodes + node registry
   - Selecting slug = connecting to node definition
   - Auto-populates label, description
2. **Sync Menu [⋮]**: Integrated into selector (appears when value set)
   - ↓ Pull from Registry: Refresh from node definition
   - ↑ Push to Registry: Save changes back to definition
   - 🔄 Retrieve Latest: Pull live data from external data source (if defined on param)
3. **Case Checkbox**: Toggle case configuration section on/off
4. **Case Selector**: Same pattern as slug (dropdown + [⋮] menu)
5. **Variants**: Always editable with sliders (existing UI)
6. **No Locking**: User can always overtype values

#### Edge Properties

```
┌─────────────────────────────────────────┐
│ ➡️ Edge Properties                       │
├─────────────────────────────────────────┤
│ ▼ Probability                           │
│                                         │
│ ┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓  │
│ ┃ Parameter                        ┃  │ ← CONNECTION (5px orange border)
│ ┃ [conversion-rate    ▼][⋮]       ┃  │   Pastel orange background
│ ┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛  │
│                                         │
│ Base:  ●────────────────── 0.75        │ ← Slider (existing style)
│ Stdev: [0.05              ]            │ ← Standardized input (minimal)
│                                         │
│ ▼ Cost 1                                │
│                                         │
│ ┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓  │
│ ┃ Parameter                        ┃  │ ← CONNECTION (5px orange border)
│ ┃ [cost-checkout      ▼][⋮]       ┃  │   Pastel orange background
│ ┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛  │
│                                         │
│ Monetary: [$2.50              ]        │ ← Standardized input (minimal)
│ ± [0.50              ]                 │
│ Time:     [5.0                ] sec    │
│ ± [0.5               ] sec             │
│                                         │
│ ▼ Cost 2                                │
│                                         │
│ ┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓  │
│ ┃ Parameter                        ┃  │ ← CONNECTION (5px orange border)
│ ┃ [cost-alt           ▼][⋮]       ┃  │   Pastel orange background
│ ┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛  │
│                                         │
│ Monetary: [$1.00              ]        │ ← Standardized input (minimal)
│ ± [0.25              ]                 │
│ Time:     [2.0                ] sec    │
│ ± [0.2               ] sec             │
│                                         │
│ ▼ ☑ Conditional Probabilities           │
│   [See Section 7.8 for complete workflow]│
└─────────────────────────────────────────┘
```

**Note**: For conditional probability interaction flow and complete field layout, see **Section 7.8**.

**Sync Menu** (same [⋮] icon pattern):
```
┌────────────────────────────┐
│ ↓ Pull from Registry       │
│ ↑ Push to Registry         │
│ 🔄 Retrieve Latest (live)  │
└────────────────────────────┘
```

**Behavior**:
1. **Parameter Selectors**: Each with dropdown + integrated [⋮] sync menu
   - Probability has its own parameter connection
   - Cost 1 has its own parameter connection
   - Cost 2 has its own parameter connection (independent)
2. **Sync Menu [⋮]**: Same pattern as node properties
   - ↓ Pull from Registry: Refresh from parameter definition
   - ↑ Push to Registry: Save changes back to definition
   - 🔄 Retrieve Latest: Pull live data from external data source (if defined on param)
3. **Sliders**: Use existing slider UI for probability values
4. **Inputs**: Standardized text inputs for stdev, costs
5. **No Locking**: User can always overtype values

---

### 9.3 Standardized Input Styling

**Problem**: Currently using inconsistent input styles (sliders, plain text, ±, etc.)

**Solution**: Unified input component system

```css
/* Base input styling - all text/numeric inputs */
.property-input {
  width: 100%;
  padding: 6px 10px;
  font-size: 13px;
  font-family: 'Monaco', 'Menlo', monospace;
  border: 1px solid #D1D5DB;
  border-radius: 4px;
  background: white;
  transition: all 0.2s;
}

.property-input:focus {
  outline: none;
  border-color: #3B82F6;
  box-shadow: 0 0 0 3px rgba(59, 130, 246, 0.1);
}

.property-input:hover:not(:focus) {
  border-color: #9CA3AF;
}

/* Connected to registry - subtle indicator */
.property-input[data-connected="true"] {
  background: linear-gradient(to right, #F3F4F6, white);
  border-left: 3px solid #6366F1;
}

/* Modified from registry value */
.property-input[data-modified="true"] {
  background: #FEF3C7;
  border-left: 3px solid #FBBF24;
}

/* Input with unit suffix */
.property-input-with-unit {
  display: flex;
  align-items: center;
  gap: 6px;
}

.property-input-with-unit input {
  flex: 1;
}

.property-input-with-unit .unit {
  font-size: 11px;
  color: #6B7280;
  min-width: 30px;
}
```

**Usage Example**:
```tsx
// Standard numeric input
<input 
  type="number" 
  className="property-input"
  data-connected={isConnectedToRegistry}
  data-modified={userModifiedValue}
  value={value}
  onChange={handleChange}
/>

// Input with unit
<div className="property-input-with-unit">
  <input type="number" className="property-input" value={5.0} />
  <span className="unit">sec</span>
</div>

// Slider (existing) - keep as is
<Slider value={0.75} onChange={handleChange} />
```

---

### 9.5 Color Selector Component

**Purpose**: Standard component for selecting visual indicators (used in conditional probabilities, case variants, etc.)

**Default View** (inline, no modal):
```
┌────────────────────────────────────────────────────────┐
│ Color:                                                 │
│ [●] [○] [○] [○] [○] [○] [○] [○] [○] [Custom...]      │
│  ↑   Red Blue Ylw Prpl Orng Cyan Pink Blk              │
│  Green (selected)                                      │
└────────────────────────────────────────────────────────┘
```

**When "Custom..." clicked**:
Opens **HTML5 native color picker** (`<input type="color">`) - no custom modal needed

```
┌────────────────────────────────────────────────────────┐
│ Color:                                                 │
│ [○] [○] [○] [○] [○] [○] [○] [○] [○] [■]              │
│                                          ↑             │
│                                    User clicked        │
│                                    Browser's native    │
│                                    picker opened       │
└────────────────────────────────────────────────────────┘
```

After user selects custom color, the custom swatch shows the chosen color:
```
│ [○] [○] [○] [○] [○] [○] [○] [○] [○] [■]              │
│                                          ↑             │
│                                       #FF5733          │
│                                    (user's choice)     │
```

**Preset Colors** (bold & bright for canvas visibility):
- 🟢 Green: `#10B981` (Emerald 500) - Success/positive
- 🔴 Red: `#EF4444` (Red 500) - Error/high priority
- 🔵 Blue: `#3B82F6` (Blue 500) - Default/neutral
- 🟡 Yellow: `#F59E0B` (Amber 500) - Warning/attention
- 🟣 Purple: `#A78BFA` (Purple 400) - Alternative
- 🟠 Orange: `#FB923C` (Orange 400) - Emphasis
- 🩵 Cyan: `#06B6D4` (Cyan 500) - Information
- 🩷 Pink: `#EC4899` (Pink 500) - Highlight

**Implementation**:
```tsx
<ColorSelector
  value="#10B981"
  onChange={(color) => setConditionColor(color)}
  presets={[
    '#10B981', // Green
    '#EF4444', // Red
    '#3B82F6', // Blue
    '#F59E0B', // Yellow
    '#A78BFA', // Purple
    '#FB923C', // Orange
    '#06B6D4', // Cyan
    '#EC4899', // Pink
    '#1F2937'  // Black
  ]}
  allowCustom={true}  // Shows "Custom..." button with HTML5 picker
/>
```

**HTML5 Color Picker**:
- Uses `<input type="color">` - native browser picker
- No need for custom modal or hex input field
- Browser handles all color selection UX
- Returns hex value (e.g., `#FF5733`)
- Works consistently across modern browsers
- Accessible and familiar to users

**Behavior**:
1. User clicks one of 5 preset color circles → Immediate selection
2. User clicks "Custom..." → HTML5 color picker opens
3. User chooses color in native picker → Custom swatch updates
4. Custom color is saved to component state
5. On next open, custom color persists and shows in custom swatch

---

### 9.6 CSS Implementation

```css
/* Connection field container */
.connection-field {
  border: 2px solid transparent;
  border-radius: 8px;
  padding: 12px;
  margin: 12px 0;
  background: white;
  transition: all 0.2s;
  position: relative;
}

/* Type-specific borders */
.connection-field.case {
  border-color: #E9D5FF;  /* Purple */
  background: linear-gradient(to right, #FAF5FF, white);
}

.connection-field.parameter {
  border-color: #FDBA74;  /* Orange */
  background: linear-gradient(to right, #FFFBEB, white);
}

.connection-field.context {
  border-color: #86EFAC;  /* Green */
  background: linear-gradient(to right, #F0FDF4, white);
}

.connection-field.node {
  border-color: #93C5FD;  /* Blue */
  background: linear-gradient(to right, #EFF6FF, white);
}

/* Connected state */
.connection-field.connected {
  border-width: 3px;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.08);
}

.connection-field.connected::before {
  content: '✓';
  position: absolute;
  top: 8px;
  right: 8px;
  color: #10B981;
  font-weight: bold;
}

/* Hover state */
.connection-field:hover {
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.12);
  transform: translateY(-2px);
}

/* Label */
.connection-field-label {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
  font-weight: 600;
  color: #374151;
  margin-bottom: 8px;
}

.connection-field-label::before {
  content: '🔗';
}

/* Clear button */
.connection-field-clear {
  background: none;
  border: none;
  color: #9CA3AF;
  cursor: pointer;
  padding: 4px 8px;
  border-radius: 4px;
  transition: all 0.2s;
}

.connection-field-clear:hover {
  background: #FEE2E2;
  color: #DC2626;
}
```

---

### 9.4 Navigator Section Colors

```css
/* Navigator section headers with pastel gradients */
.object-type-section {
  border-radius: 4px;
  margin: 4px 0;
}

.object-type-section.graphs {
  background: linear-gradient(90deg, #FEF3C7 0%, transparent 100%);
  border-left: 3px solid #FBBF24;
}

.object-type-section.parameters {
  background: linear-gradient(90deg, #FED7AA 0%, transparent 100%);
  border-left: 3px solid #FB923C;
}

.object-type-section.contexts {
  background: linear-gradient(90deg, #D1FAE5 0%, transparent 100%);
  border-left: 3px solid #34D399;
}

.object-type-section.cases {
  background: linear-gradient(90deg, #F3E8FF 0%, transparent 100%);
  border-left: 3px solid #A78BFA;
}

.object-type-section.nodes {
  background: linear-gradient(90deg, #DBEAFE 0%, transparent 100%);
  border-left: 3px solid #3B82F6;
}

/* Remove light blue "open file" background */
.navigator-item.is-open {
  /* background: #EFF6FF; ← REMOVED */
  font-weight: 600;
  /* Blue dots (●●) are sufficient indicator */
}
```

---

### 9.5 Tab Colors (rc-dock)

```css
/* Tab styling with pastel backgrounds and accent borders */
.dock-tab {
  transition: all 0.2s;
}

.dock-tab[data-type="graph"] {
  background: #FEF3C7;
  border-top: 3px solid #FBBF24;
}

.dock-tab[data-type="parameter"] {
  background: #FED7AA;
  border-top: 3px solid #FB923C;
}

.dock-tab[data-type="context"] {
  background: #D1FAE5;
  border-top: 3px solid #34D399;
}

.dock-tab[data-type="case"] {
  background: #F3E8FF;
  border-top: 3px solid #A78BFA;
}

.dock-tab[data-type="credentials"] {
  background: #F3F4F6;
  border-top: 3px solid #9CA3AF;
}

/* Active tab - slightly darker */
.dock-tab.active[data-type="graph"] {
  background: #FDE68A;
  box-shadow: 0 2px 8px rgba(251, 191, 36, 0.3);
}

.dock-tab.active[data-type="parameter"] {
  background: #FED7AA;
  box-shadow: 0 2px 8px rgba(251, 146, 60, 0.3);
}

/* And so on for each type... */
```

---

### 9.6 Standard Selector Component - Comprehensive Design

**Purpose**: ONE universal selector component for ALL registry connections  
**Key Feature**: This is a core affordance of the application - connecting graph items to registry definitions

---

#### Component Anatomy

```
┌─────────────────────────────────────────────────────────┐
│ CONNECTION FIELD (5px pastel border by type)            │
│ ┌─────────────────────────────────────────────────────┐ │
│ │ [●] [checkout-flow_____________] [×] [⋮]           │ │
│ │  ↑          ↑                     ↑    ↑            │ │
│ │  │          │                     │    │            │ │
│ │  │          │                     │    └─ Sync menu │ │
│ │  │          │                     └───── Clear btn  │ │
│ │  │          └────────────────────────── Text input  │ │
│ │  └───────────────────────────────────── Status icon │ │
│ └─────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────┘
```

**Visual Mockup** (disconnected state):
```
┌───────────────────────────────────────────┐
│ ┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓ │
│ ┃ 🔌 Select parameter...    [×] [⋮] ┃ │ ← 5px orange border (parameter)
│ ┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛ │   Pastel orange background
└───────────────────────────────────────────┘
  ↑                             ↑    ↑
  Grey plug (disconnected)      │    Sync menu (disabled)
                                Clear button (hidden)
```

**Visual Mockup** (connected state, typing):
```
┌───────────────────────────────────────────┐
│ ┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓ │
│ ┃ 🔌 conv|                  [×] [⋮] ┃ │ ← 6px orange border (connected)
│ ┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛ │   Stronger shadow (plug is black)
│   ┌───────────────────────────────────┐   │   Text input = live filter
│   │ 📑 Parameter Registry (5)         │   │ ← Dropdown menu
│   ├───────────────────────────────────┤   │
│   │ • conv-base                       │   │
│   │                                   │   │
│   │ 🔌 conv-premium                   │   │ ← Already connected (grey plug)
│   │    Used in Edge A→B               │   │ ← Usage info sub-line (small, grey)
│   │                                   │   │
│   │ • conv-standard                   │   │
│   │ ...                               │   │
│   ├───────────────────────────────────┤   │
│   │ Showing 5 of 15 • 1 in use        │   │ ← Status bar
│   └───────────────────────────────────┘   │
└───────────────────────────────────────────┘
  ↑
  Black plug (connected to registry)
```

---

#### Component Elements

**1. Connection Status Icon** (left edge, inside field):
- `🔌` Plug icon: Visual metaphor for connection
- Grey (`#9CA3AF`): Not connected / disconnected
- Black (`#1F2937`): Connected to registry
- Position: 8px from left edge, vertically centered
- Size: 14×14px
- **Reusable**: Same icon used on canvas, in dropdowns, Navigator to indicate connection state

**2. Text Input** (center, flex-grow):
- Type: `<input type="text">` with autocomplete
- Behavior: 
  - Typing filters dropdown list in real-time
  - Up/Down arrows navigate filtered list
  - Enter selects highlighted item
  - Escape closes dropdown
- Placeholder: "Select {type}..." (e.g., "Select parameter...")
- Font: 14px, system font

**3. Clear Button** (right, before sync):
- Icon: `×` (multiplication sign, not 'x')
- Visibility: Only shown when value is set
- Action: Clears value, resets to disconnected state
- Size: 20×20px clickable area
- Color: #6B7280 (gray), hover: #374151 (darker)

**4. Sync Menu Button** (right edge, inside field):
- Icon: `⋮` (vertical ellipsis)
- Visibility: Always visible (disabled when no value)
- Action: Opens sync menu dropdown
- Size: 20×20px clickable area
- States:
  - Disabled (no value): #D1D5DB (light grey)
  - Enabled: #6B7280 (grey), hover: #374151 (darker)

**5. Outer Container** (connection field):
- Border: 5px solid (disconnected) / 6px solid (connected)
- Border color: Type-specific pastel (blue/purple/orange/green)
- Border radius: 8px
- Padding: 12px
- Background: Linear gradient (pastel → white)
- Shadow: 
  - Disconnected: none
  - Connected: `0 3px 10px rgba(0, 0, 0, 0.12)`
  - Modified: Amber tint overlay

---

#### Dropdown Menu Design

**⚠️ DESIGN NOTE**: The dropdown menu logic requires deeper consideration. Key questions:
1. When should "Current Graph" group appear vs just "Registry"? ONLY WHEN SELETING NODES FOR 'VISITED' CONDITIONAL P PURPOSES
2. How to visually indicate items already connected/in-use elsewhere? PLUG ICON
3. Should we support multi-select or creation of new items inline? NO
4. How to handle hierarchical/nested registries (e.g., parameter sub-types)? NOT YET
5. Remember to ensure that visual styling mirrors that used in nav bar

**Contextual Grouping Logic**:

| Context | Show "Current Graph"? | Show "Registry"? | Rationale |
|---------|----------------------|------------------|-----------|
| Node Slug | ❌ **No** | ✅ Yes (node registry) | Attaching same node to itself doesn't make sense |
| Edge Parameter | ❌ No | ✅ Yes (param registry) | Edge params are always registry connections |
| Case ID | ❌ No | ✅ Yes (case registry) | Cases are always registry connections |
| Context ID | ❌ No | ✅ Yes (context registry) | Contexts are always registry connections |
| Conditional "If Visited" | ✅ **Yes** | ✅ Yes (node registry) | Need to check if specific graph nodes were visited |

**Proposed Structure** (Registry-only context, e.g., parameter/case/context selection):
```
┌─────────────────────────────────────────┐
│ 📑 Parameter Registry (15)              │ ← Single group header
├─────────────────────────────────────────┤
│ • conv-base                             │ ← Available item
│                                         │
│ 🔌 conv-premium                         │ ← Already in use (grey plug)
│    Used in Edge A→B                     │ ← Usage info (smaller, grey, sub-line)
│                                         │
│ • conv-standard                         │
│                                         │
│ 🔌 conv-high                            │
│    Used in Node checkout-flow           │
│                                         │
│ • conv-baseline                         │
│ ... (10 more)                           │
├─────────────────────────────────────────┤
│ Showing 15 of 15 • 2 in use            │ ← Status bar
└─────────────────────────────────────────┘

Note: Text input at top acts as live filter (no separate filter field)
```

**Proposed Structure** (Mixed context - conditional "If Visited" nodes only):
```
┌─────────────────────────────────────────┐
│ 📋 Current Graph (3)                    │ ← Collapsible
│ • checkout-flow                         │
│                                         │
│ 🔌 payment-flow                         │
│    Used in Edge C→D                     │
│                                         │
│ • confirmation                          │
├─────────────────────────────────────────┤
│ 📑 Node Registry (12)                   │ ← Collapsible
│ • abandoned-cart                        │
│                                         │
│ • checkout-v2                           │
│                                         │
│ 🔌 payment-gateway                      │
│    Used 3 times                         │
│                                         │
│ ... (9 more)                            │
├─────────────────────────────────────────┤
│ Showing 15 of 15 • 3 in use            │ ← Status bar
└─────────────────────────────────────────┘

Note: "Current Graph" only shown for conditional "If Visited" context
```

**Connection State Indicators**:
1. **🔌 Plug Icon** (grey): Item is already connected/in-use elsewhere
2. **Usage Sub-Line**: Second line below item name, small text (11px), grey, indented
   - Examples: "Used in Edge A→B" or "Used in Node checkout-flow" or "Used 3 times"
   - Provides context without taking horizontal space from long item names
3. **Still Selectable**: User can reuse same item (common pattern)
4. **Visual Distinction**: Slightly muted text color for in-use items

**Dropdown Features**:
1. **Contextual Grouping**: "Current Graph" only shown for conditional "If Visited" context
2. **Collapsible Groups**: Only when multiple groups present (mixed context only)
3. **Live Filtering**: Main text input acts as filter - dropdown updates as user types
4. **Connection Indicators**: 🔌 plug icon + usage sub-line for items already in use
5. **Navigator-Style Items**: Consistent visual treatment
6. **Status Bar**: Bottom bar shows counts: "Showing 3 of 15 • 2 in use"
7. **Inline Creation**: Create new registry item when typed ID doesn't exist (see below)
8. **Keyboard Navigation**:
   - Up/Down: Navigate items (skip group headers)
   - Enter: Select highlighted item
   - Escape: Close dropdown

---

#### Inline Creation Workflow

**Trigger**: User types an ID that doesn't exist in any filtered results

**Scenario**: User types "new-checkout-param" in parameter selector but it doesn't exist

**UI State 1** - No matches found:
```
┌─────────────────────────────────────────┐
│ 🔌 new-checkout-param     [×] [⋮]      │ ← User typed this
└─────────────────────────────────────────┘
  ┌───────────────────────────────────────┐
  │ 📑 Parameter Registry (0)             │
  ├───────────────────────────────────────┤
  │ No matches found for                  │
  │ "new-checkout-param"                  │
  │                                       │
  │ ┌───────────────────────────────────┐ │
  │ │ [+ Create "new-checkout-param"]   │ │ ← Create button appears
  │ └───────────────────────────────────┘ │
  ├───────────────────────────────────────┤
  │ Showing 0 of 15                       │
  └───────────────────────────────────────┘
```

**Action Flow**:

1. **User clicks "[+ Create...]"**
   - System creates new file:
     - Type: Determined by selector type (parameter/case/context/node)
     - ID: Taken from user's input text (`new-checkout-param`)
     - Schema: Default template for that type
     - Location: Appropriate registry path (`params/new-checkout-param.yaml`)
   
2. **File is created and loaded**:
   - New file added to FileRegistry (local, dirty, not saved)
   - File marked as dirty (needs save/commit)
   - File opens in new tab for editing (optional: can be deferred)

3. **Connection is made**:
   - Selector automatically connects to newly created item
   - UI updates to connected state (black plug, 6px border)
   - Dropdown closes

4. **User can now edit**:
   - New tab shows form editor for the new item
   - User fills in fields (name, description, distribution, etc.)
   - User saves/commits when ready

**UI State 2** - After creation:
```
┌─────────────────────────────────────────┐
│ 🔌 new-checkout-param     [×] [⋮]      │ ← Now connected (black plug)
└─────────────────────────────────────────┘
  ↑
  Connected to newly created parameter
  (6px border, shadow appears)
```

**TypeScript Interface Updates**:

```typescript
interface SelectorProps {
  // ... existing props ...
  
  // Creation handler
  onCreate?: (id: string) => Promise<void>;  // Handler to create new item
  allowInlineCreation?: boolean;             // Enable/disable feature (default: true)
}
```

**Implementation Notes**:

1. **Validation**: Check if ID is valid for that type (alphanumeric, hyphens, etc.)
2. **Error Handling**: Show error if creation fails (permissions, duplicate, invalid ID)
3. **Feedback**: Brief toast/notification confirming creation
4. **Undo**: User can delete newly created file if it was a mistake
5. **Auto-open**: Optionally open the new file in editor tab for immediate editing
6. **Template Selection**: For complex types, might need to choose template (defer to Phase 2)

**Dropdown Layout**:
1. **Max Height**: 300px with scroll for long lists
2. **Smart Sorting**: Open question - in-use items first? Or maintain alphabetical?

**Future Enhancements** (defer to Phase 2+):
- Multi-select: Select multiple items (for conditional "visited" nodes - add chips)
- Preview pane: Show item details on hover
- Recent items: "Recently Used" section at top

---

#### TypeScript Interface

```typescript
interface SelectorItem {
  id: string;
  name: string;
  inUse?: boolean;              // Item is already connected elsewhere
  usageInfo?: string;           // e.g., "Used in Edge A→B" or "Used 3 times" (shown on sub-line)
}

interface SelectorProps {
  // Core
  type: 'case' | 'parameter' | 'context' | 'node';  // Visual styling + determines grouping logic
  value: string | null;
  onChange: (value: string | null) => void;
  placeholder?: string;
  
  // Data sources (contextual - see Dropdown Menu Design section)
  graphItems?: Array<SelectorItem>;     // Items in current graph (conditionally shown)
  registryItems?: Array<SelectorItem>;  // Items in registry (always shown)
  
  // Context control
  showGraphItems?: boolean;    // Override default logic for showing "Current Graph" group
  
  // Sync handlers (stubbed for now)
  onSyncFrom?: () => void;   // Pull from registry
  onSyncTo?: () => void;     // Push to registry
  onRetrieve?: () => void;   // Retrieve latest (live data from external source)
  
  // State
  isConnected?: boolean;     // Show black vs grey plug icon
  isModified?: boolean;      // Show amber tint
  disabled?: boolean;
}

export function Selector(props: SelectorProps) {
  const {
    type,
    value,
    onChange,
    placeholder = `Select ${type}...`,
    graphItems = [],
    registryItems = [],
    onSyncFrom,
    onSyncTo,
    onRetrieve,
    isConnected = !!value,
    isModified = false,
    disabled = false
  } = props;
  
  const [inputValue, setInputValue] = useState(value || '');
  const [showDropdown, setShowDropdown] = useState(false);
  const [showSyncMenu, setShowSyncMenu] = useState(false);
  const [filterTerm, setFilterTerm] = useState('');
  
  // Filter items based on input
  const filteredGraphItems = graphItems.filter(item => 
    item.name.toLowerCase().includes(inputValue.toLowerCase())
  );
  const filteredRegistryItems = registryItems.filter(item => 
    item.name.toLowerCase().includes(inputValue.toLowerCase())
  );
  
  return (
    <div 
      className={`connection-field ${isConnected ? 'connected' : ''} ${isModified ? 'modified' : ''}`}
      data-type={type}
    >
      {/* Connection status icon - plug icon */}
      <span className={`connection-icon ${isConnected ? 'connected' : 'disconnected'}`}>
        🔌
      </span>
      
      {/* Text input with autocomplete */}
      <input
        type="text"
        className="selector-input"
        value={inputValue}
        onChange={(e) => {
          setInputValue(e.target.value);
          setShowDropdown(true);
        }}
        onFocus={() => setShowDropdown(true)}
        placeholder={placeholder}
        disabled={disabled}
      />
      
      {/* Dropdown menu */}
      {showDropdown && !disabled && (
        <div className="selector-dropdown">
          {/* Current Graph section (conditionally shown - only for "If Visited" context) */}
          {showGraphItems && filteredGraphItems.length > 0 && (
            <div className="selector-group">
              <div className="selector-group-header">
                📋 Current Graph ({filteredGraphItems.length})
              </div>
              {filteredGraphItems.map(item => (
                <div 
                  key={item.id}
                  className={`selector-item-wrapper ${item.inUse ? 'in-use' : ''}`}
                  onClick={() => {
                    onChange(item.id);
                    setInputValue(item.name);
                    setShowDropdown(false);
                  }}
                >
                  <div className="selector-item">
                    {item.inUse ? '🔌' : '•'} {item.name}
                  </div>
                  {item.usageInfo && (
                    <div className="selector-item-usage">{item.usageInfo}</div>
                  )}
                </div>
              ))}
            </div>
          )}
          
          {/* Registry section (always shown) */}
          {filteredRegistryItems.length > 0 && (
            <div className="selector-group">
              <div className="selector-group-header">
                📑 {type.charAt(0).toUpperCase() + type.slice(1)} Registry ({filteredRegistryItems.length})
              </div>
              {filteredRegistryItems.map(item => (
                <div 
                  key={item.id}
                  className={`selector-item-wrapper ${item.inUse ? 'in-use' : ''}`}
                  onClick={() => {
                    onChange(item.id);
                    setInputValue(item.name);
                    setShowDropdown(false);
                  }}
                >
                  <div className="selector-item">
                    {item.inUse ? '🔌' : '•'} {item.name}
                  </div>
                  {item.usageInfo && (
                    <div className="selector-item-usage">{item.usageInfo}</div>
                  )}
                </div>
              ))}
            </div>
          )}
          
          {/* Status bar at bottom */}
          <div className="selector-status">
            Showing {filteredGraphItems.length + filteredRegistryItems.length} of {graphItems.length + registryItems.length}
            {(graphItems.filter(i => i.inUse).length + registryItems.filter(i => i.inUse).length) > 0 && 
              ` • ${graphItems.filter(i => i.inUse).length + registryItems.filter(i => i.inUse).length} in use`
            }
          </div>
        </div>
      )}
      
      {/* Clear button (only when value exists) */}
      {value && !disabled && (
        <button 
          className="selector-clear"
          onClick={() => {
            onChange(null);
            setInputValue('');
          }}
          title="Clear selection"
        >
          ×
        </button>
      )}
      
      {/* Sync menu button */}
      <button 
        className="selector-sync-icon"
        onClick={() => setShowSyncMenu(!showSyncMenu)}
        disabled={!value || disabled}
        title="Sync options"
      >
        ⋮
      </button>
      
      {/* Sync menu dropdown */}
      {showSyncMenu && value && (
        <div className="selector-sync-dropdown">
          {onSyncFrom && (
            <button onClick={onSyncFrom}>↓ Pull from Registry</button>
          )}
          {onSyncTo && (
            <button onClick={onSyncTo}>↑ Push to Registry</button>
          )}
          {onRetrieve && (
            <button onClick={onRetrieve}>🔄 Retrieve Latest (live)</button>
          )}
        </div>
      )}
    </div>
  );
}
```

---

#### CSS Implementation

```css
/* ========================================
   CONNECTION FIELD - Outer container
   ======================================== */
.connection-field {
  display: flex;
  align-items: center;
  gap: 8px;
  position: relative;
  padding: 12px;
  border-radius: 8px;
  border: 5px solid transparent;  /* 5px border for prominence */
  margin: 8px 0;
  transition: all 0.2s;
}

/* Type-specific PASTEL borders - visual language */
.connection-field[data-type="node"] {
  border-color: #BFDBFE;  /* Blue 200 - pastel */
  background: linear-gradient(to right, #EFF6FF, white);
}

.connection-field[data-type="case"] {
  border-color: #DDD6FE;  /* Purple 200 - pastel */
  background: linear-gradient(to right, #FAF5FF, white);
}

.connection-field[data-type="parameter"] {
  border-color: #FED7AA;  /* Orange 200 - pastel */
  background: linear-gradient(to right, #FFF7ED, white);
}

.connection-field[data-type="context"] {
  border-color: #BBF7D0;  /* Green 200 - pastel */
  background: linear-gradient(to right, #F0FDF4, white);
}

/* Connected state (has value) - even more prominent */
.connection-field.connected {
  border-width: 6px;  /* Thicker when connected */
  box-shadow: 0 3px 10px rgba(0, 0, 0, 0.12);
}

/* Modified state (user has changed value from registry) */
.connection-field.modified {
  background: linear-gradient(to right, #FEF3C7, white);  /* Amber tint */
}

/* ========================================
   CONNECTION STATUS ICON (left edge) - PLUG
   ======================================== */
.connection-icon {
  flex-shrink: 0;
  width: 14px;
  height: 14px;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 14px;
  line-height: 1;
  filter: grayscale(1);  /* Default grey */
  opacity: 0.5;
  transition: all 0.2s;
}

.connection-icon.disconnected {
  filter: grayscale(1);  /* Grey plug */
  opacity: 0.4;
}

.connection-icon.connected {
  filter: grayscale(0);  /* Full color (or black if using monochrome icon) */
  opacity: 1;
}

/* ========================================
   TEXT INPUT (center, flex-grow)
   ======================================== */
.selector-input {
  flex: 1;
  padding: 8px 4px;
  border: none;
  background: transparent;
  font-size: 14px;
  font-family: inherit;
  outline: none;
  min-width: 0;  /* Allow flex shrink */
}

.selector-input::placeholder {
  color: #9CA3AF;
  font-style: italic;
}

.selector-input:disabled {
  color: #D1D5DB;
  cursor: not-allowed;
}

/* ========================================
   CLEAR BUTTON (right, before sync)
   ======================================== */
.selector-clear {
  flex-shrink: 0;
  width: 20px;
  height: 20px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: none;
  border: none;
  cursor: pointer;
  font-size: 18px;
  line-height: 1;
  color: #6B7280;
  padding: 0;
  transition: color 0.15s;
}

.selector-clear:hover {
  color: #374151;
}

/* ========================================
   SYNC MENU BUTTON (right edge)
   ======================================== */
.selector-sync-icon {
  flex-shrink: 0;
  width: 20px;
  height: 20px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: white;
  border: 1px solid #D1D5DB;
  border-radius: 4px;
  cursor: pointer;
  font-size: 16px;
  line-height: 1;
  color: #6B7280;
  padding: 0;
  transition: all 0.15s;
}

.selector-sync-icon:hover:not(:disabled) {
  background: #F3F4F6;
  border-color: #9CA3AF;
  color: #374151;
}

.selector-sync-icon:disabled {
  color: #D1D5DB;
  cursor: not-allowed;
  opacity: 0.5;
}

/* ========================================
   DROPDOWN MENU
   ======================================== */
.selector-dropdown {
  position: absolute;
  top: calc(100% + 4px);
  left: 0;
  right: 0;
  background: white;
  border: 1px solid #D1D5DB;
  border-radius: 6px;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
  z-index: 1000;
  max-height: 300px;
  overflow-y: auto;
}

/* Dropdown group (Current Graph / Registry) */
.selector-group {
  border-bottom: 1px solid #E5E7EB;
}

.selector-group:last-child {
  border-bottom: none;
}

.selector-group-header {
  padding: 8px 12px;
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
  color: #6B7280;
  background: #F9FAFB;
  border-bottom: 1px solid #E5E7EB;
  letter-spacing: 0.05em;
}

/* Dropdown item wrapper (contains item + usage sub-line) */
.selector-item-wrapper {
  cursor: pointer;
  transition: background 0.1s;
}

.selector-item-wrapper:hover {
  background: #F3F4F6;
}

.selector-item-wrapper:active {
  background: #E5E7EB;
}

/* Item name line (Navigator-style) */
.selector-item {
  padding: 8px 12px 4px 20px;  /* Less bottom padding for sub-line */
  font-size: 13px;
  color: #374151;
  display: flex;
  align-items: center;
  gap: 4px;
}

/* Usage info sub-line */
.selector-item-usage {
  padding: 0 12px 6px 36px;  /* Indented, aligned with item text */
  font-size: 11px;
  color: #9CA3AF;
  font-style: italic;
  line-height: 1.2;
}

/* Items already in use - slightly muted */
.selector-item-wrapper.in-use .selector-item {
  color: #6B7280;
}

/* Status bar (at bottom) */
.selector-status {
  padding: 6px 12px;
  border-top: 1px solid #E5E7EB;
  background: #F9FAFB;
  font-size: 11px;
  color: #6B7280;
  text-align: center;
}

/* ========================================
   SYNC MENU DROPDOWN
   ======================================== */
.selector-sync-dropdown {
  position: absolute;
  top: calc(100% + 4px);
  right: 0;
  background: white;
  border: 1px solid #D1D5DB;
  border-radius: 6px;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
  z-index: 1001;  /* Above dropdown menu */
  min-width: 200px;
}

.selector-sync-dropdown button {
  display: block;
  width: 100%;
  text-align: left;
  padding: 10px 14px;
  border: none;
  background: none;
  cursor: pointer;
  font-size: 13px;
  color: #374151;
  transition: background 0.1s;
}

.selector-sync-dropdown button:hover {
  background: #F3F4F6;
}

.selector-sync-dropdown button:first-child {
  border-radius: 6px 6px 0 0;
}

.selector-sync-dropdown button:last-child {
  border-radius: 0 0 6px 6px;
}
```

---

#### Usage Example

```tsx
// Example 1: Parameter selector in Edge Properties (registry-only context)
<Selector
  type="parameter"
  value={edge.probability?.parameter_id}
  onChange={(paramId) => updateEdgeParameter(paramId)}
  placeholder="Select parameter..."
  showGraphItems={false}  // Edge params don't need "Current Graph" group
  registryItems={[
    { id: 'param-1', name: 'conv-base' },
    { id: 'param-2', name: 'conv-premium', inUse: true, usageInfo: 'Used in Edge A→B' },
    { id: 'param-3', name: 'conv-standard' },
    { id: 'param-4', name: 'conv-high-very-long-parameter-name', inUse: true, usageInfo: 'Used in Node checkout-flow' }
  ]}
  isConnected={!!edge.probability?.parameter_id}
  isModified={edge.probability?.value !== registryValue}
  onSyncFrom={() => pullFromRegistry(edge.probability?.parameter_id)}
  onSyncTo={() => pushToRegistry(edge.probability)}
  onRetrieve={() => fetchLiveData(edge.probability?.parameter_id)}
/>

// Example 2: Node selector for Conditional "If Visited" (mixed context - only case that shows graph items)
<Selector
  type="node"
  value={condition.nodeId}
  onChange={(nodeId) => updateCondition(nodeId)}
  placeholder="Select node..."
  showGraphItems={true}  // ONLY true for conditional "If Visited" context
  graphItems={[
    { id: 'node-1', name: 'checkout-flow' },
    { id: 'node-2', name: 'payment-flow', inUse: true, usageInfo: 'Used in Edge C→D' }
  ]}
  registryItems={[
    { id: 'node-reg-1', name: 'abandoned-cart' },
    { id: 'node-reg-2', name: 'checkout-v2' },
    { id: 'node-reg-3', name: 'payment-gateway', inUse: true, usageInfo: 'Used 3 times' }
  ]}
  isConnected={!!condition.nodeId}
  onSyncFrom={() => pullNodeDefinition(condition.nodeId)}
  onSyncTo={() => pushNodeDefinition(condition.nodeId)}
/>
```

---

### 9.7 Critical User Flows

#### Flow 1: Node Slug (Canonical Reference)

```
1. Create node (right-click canvas)
2. Properties panel opens automatically
3. FIRST FIELD: Slug (with selector dropdown)
4. Click dropdown → shows nodes from graph + node registry
5. Select "checkout-flow"
6. ✓ Label and description auto-populate from node definition
7. User can overtype any value (no locking)
8. Click [⋮] icon → sync menu appears:
   - ↓ Pull from Registry (refresh from node definition)
   - ↑ Push to Registry (save changes back to node definition)
   - 🔄 Retrieve Latest (pull live data from external data source if defined)
```

#### Flow 2: Case Node Configuration

```
1. Select node
2. Check "☑ Case Configuration" checkbox
3. Section expands
4. Case field has selector dropdown + [⋮] sync menu
5. Select "checkout-ab-test" from dropdown
6. ✓ Variants auto-load (control: 50%, treatment: 50%)
7. User adjusts sliders (always editable)
8. Set Status: [active ▼]
9. Click [⋮] for sync options when needed
```

#### Flow 3: Edge Probability

```
1. Create edge
2. Properties panel shows Probability section
3. Parameter field has selector + [⋮] sync menu
4. Select "conversion-rate-baseline" from dropdown
5. ✓ Base probability (0.75) and stdev (0.05) auto-load
6. User can overtype values (no locking)
7. Click [⋮] for sync options
```

#### Flow 4: Edge Costs (Two Sections)

```
1. Select edge
2. Expand "Cost 1" section
3. Parameter field with selector + [⋮] menu
4. Select "cost-checkout" (optional)
5. Enter monetary: $2.50 ± 0.50
6. Enter time: 5.0 ± 0.5 sec
7. Expand "Cost 2" section (independent)
8. Repeat for second cost profile
9. Each has own parameter connection + sync menu
```

#### Flow 5: Conditional Probabilities

```
1. Select edge
2. Expand "Conditional Probabilities"
3. Click [+ Add Condition]
4. New condition card appears inline
5. Parameter field with selector + [⋮] menu
6. Select "high-conv" (optional)
7. Click [Select node...] → selector shows graph + registry nodes
8. Select node-checkout → chip appears
9. Click [+ Add] to add node-payment → second chip
10. Adjust probability slider: 0.90
11. Set stdev: 0.03
12. Choose color: Click green preset [●]
13. Click [⋮] on parameter selector for sync options
14. Condition auto-saves
15. Repeat for more conditions
16. First matching condition wins (AND within, OR between)
```

---

### 9.8 Design Rationale

**Why slug IS the connection?**
- ✅ Canonical reference: Slug is the node_id, the primary key
- ✅ No duplicate fields: Don't separate "connection" from "slug"
- ✅ Direct: Selecting slug from dropdown = connecting to node definition
- ✅ First field: Most important property, appears at top

**Why integrate sync into selector?**
- ✅ One component: Don't create separate sync UI class
- ✅ Right-edge icon: [⋮] menu appears when value is set
- ✅ Clean layout: No extra rows of sync buttons
- ✅ Consistent: Same pattern everywhere (nodes, cases, parameters)

**Why optional connections?**
- ✅ Flexibility: Users can prototype without creating registry entries
- ✅ Gradual adoption: Start manual, refactor to registry later
- ✅ Offline mode: Graph works without full registry loaded
- ✅ No forced workflows: User controls when to connect

**Why no locking of values?**
- ✅ User override: Always allow overtyping values, even when connected
- ✅ Experimentation: Quick "what-if" changes without disconnecting
- ✅ Visual feedback: Show when value differs from registry (amber highlight)
- ✅ Sync when ready: User decides when to push/pull values

**Why three sync options?**
- ✅ **↓ From Registry**: Pull latest - standard workflow
- ✅ **↑ To Registry**: Push back - enables inline editing of registry
- ✅ **🔄 Retrieve Latest**: Pull live data from external data source (if configured on param)

**Why checkbox for case configuration?**
- ✅ Clear toggle: Obvious what you're enabling/disabling
- ✅ Section visibility: Only shows when checked
- ✅ No mode switching: Simpler than radio buttons
- ✅ Consistent pattern: Matches other boolean properties

**Why standardized inputs?**
- ✅ Consistency: Same look/feel across all properties
- ✅ Visual feedback: Connection state shown via border
- ✅ Monospace font: Better for numeric values
- ✅ Units display: Clear suffix (sec, $, etc.)

**Why TWO cost sections?**
- ✅ Schema compliance: Edges support two independent cost profiles
- ✅ Flexibility: Different cost models for different scenarios
- ✅ Each can connect: Independent parameter connections

**Why inline editing (no modals)?**
- ✅ Faster workflow: No context switching
- ✅ Less clicking: Direct manipulation of condition cards
- ✅ Cleaner UX: No modal management

**Why existing selector component?**
- ✅ One high-quality class: Maintain single selector for params/nodes/cases/contexts
- ✅ Proven UX: Already shows graph items + registry
- ✅ Less code: Don't duplicate selector logic

**Why color selector component?**
- ✅ Standard interface: Reusable across conditional probabilities
- ✅ Preset options: Quick selection for common colors
- ✅ Custom option: HTML5 color picker for flexibility
- ✅ Visual consistency: Same component everywhere

**Why conditional probabilities?**
- ✅ Realistic modeling: Probability depends on path taken
- ✅ Multiple conditions: Handle complex scenarios
- ✅ First match wins: Simple evaluation model
- ✅ Parameter connections: Each condition can sync to registry

**Why pastel colors?**
- ✅ Consistent language: Same color = same object type
- ✅ Gentle: Not distracting, supports content
- ✅ Accessible: Sufficient contrast for readability
- ✅ Professional: Modern, cohesive design system

---

**End of Document**

