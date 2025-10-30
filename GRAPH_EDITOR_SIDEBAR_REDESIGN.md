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
│  ├─ Slug                        │ ← SELECTOR (connection to node registry)
│  │  [checkout-flow      ▼][⋮]  │   Standard selector with sync menu
│  ├─ Label: [input]              │
│  └─ Description: [textarea]     │
│                                 │
│  ▼ ☑ Case Configuration         │ ← Checkbox toggles section
│  ├─ Case                        │ ← SELECTOR (connection to case registry)
│  │  [ab-test            ▼][⋮]  │   Standard selector with sync menu
│  ├─ Variants:                   │
│  │  ├─ control    ●──── 50%    │ ← Sliders (existing UI)
│  │  └─ treatment  ●──── 50%    │
│  └─ Status: [active ▼]         │
│                                 │
│  ▼ Probability (Edge only)      │
│  ├─ Parameter                   │ ← SELECTOR (connection to param registry)
│  │  [conversion-rate    ▼][⋮]  │   Standard selector with sync menu
│  ├─ Base: ●──────────── 0.75   │ ← Slider (existing UI)
│  └─ Stdev: [0.05]              │ ← Input (standard styling)
│                                 │
└─────────────────────────────────┘
```

**Key Points**:
- **Slug, Case, Parameter = STANDARD SELECTOR COMPONENT** (connects to registry)
- Each selector has integrated `[⋮]` sync menu
- All use ONE selector component class with connection-type styling
- Accordions match Navigator style

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

### Phase 1: Move WhatsApp to FAB (1-2 days)

**Tasks**:
1. Create `WhatsAppFloatingButton` component
2. Position at `top-right` of GraphCanvas
3. Implement dropdown menu with existing export functions
4. Remove WhatsApp section from Properties Panel
5. Test on mobile (FAB should remain accessible)

**Files**:
- `graph-editor/src/components/WhatsAppFloatingButton.tsx` (NEW)
- `graph-editor/src/components/editors/GraphEditor.tsx` (modify)
- `graph-editor/src/components/PropertiesPanel.tsx` (remove WhatsApp section)

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
┃                          [⚙️ WhatsApp ▼]   ┃  ▼ Entry Conditions     ┃
┃                                  ↑         ┃  └─ ...                 ┃
┃                                  │         ┃                         ┃
┃                              FAB button    ┃                         ┃
┃                                            ┃                         ┃
┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┻━━━━━━━━━━━━━━━━━━━━━━━━━┛
                                                   ↑
                                         Sidebar (300px, resizable)
```

---

## 7. Final Design Decisions

### 7.1 Object Creation - Existing Affordances

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

### 7.2 Sidebar Panel Structure - THREE Panels

**Decision**: Three panels of equal width (300px each)

1. **🎭 What-If** - Scenario analysis
   - Case overrides
   - Conditional probability overrides
   - Clear all functionality
   
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
│                            │ [Clear All] │
└────────────────────────────┴─────────────┘
```

**Deferred**: Object Palette
- Not needed initially (only one object type: node)
- Right-click context menu is sufficient
- Can add later when we have rectangles, labels, etc.

---

### 7.3 Auto-Open Properties - Smart Behavior

**Decision**: Auto-open Properties ONCE per tab, then respect user preference

```typescript
interface TabState {
  propertiesAutoOpened: boolean;  // Has Properties auto-opened in this tab?
  propertiesUserClosed: boolean;  // Did user explicitly close it?
}

function handleSelection(nodeId: string, tabState: TabState) {
  if (!tabState.propertiesAutoOpened && !tabState.propertiesUserClosed) {
    // First selection in this tab - auto-open Properties
    openPropertiesPanel();
    tabState.propertiesAutoOpened = true;
  }
  // Subsequent selections - respect user's panel state
}

function handlePropertiesClose() {
  // User explicitly closed - don't auto-open again
  tabState.propertiesUserClosed = true;
}
```

**Behavior**:
1. User opens graph → All panels minimized (icon bar)
2. User selects node → Properties auto-opens (first time only)
3. User closes Properties → Stays closed
4. User selects another node → Properties stays closed (respects preference)
5. User can manually open Properties from icon bar anytime

**Benefits**:
- ✅ Helpful on first selection (shows relevant UI)
- ✅ Not annoying on subsequent selections
- ✅ Respects user's workspace preference
- ✅ Clear mental model (once per tab)

---

## 8. Summary & Recommendation

### ✅ Recommended Approach

1. **Icon Bar with Hover Preview** - VS Code-style panel access
2. **Three Panels (equal width)** - What-If, Properties, Tools
3. **Smart Auto-Open** - Properties opens once per tab, then respects user
4. **Existing Creation Methods** - Right-click context menu (no new UI)
5. **Phased Implementation** - Icon bar first, then panels, defer palette

### 🎯 Expected Outcomes

- ✅ **Cleaner canvas** - Icon bar only takes 48px when minimized
- ✅ **Quick access** - Hover preview for instant panel viewing
- ✅ **Less annoying** - Smart auto-open respects user preferences
- ✅ **Professional UX** - VS Code-style panel management
- ✅ **Unified creation** - Consistent object creation across all methods
- ✅ **Future-proof** - Easy to add object types and tools

### 📋 Implementation Phases

**Phase 1: Icon Bar Foundation (3-4 days)**
- Icon bar component (48px, right edge)
- Hover preview overlay system
- State management (iconbar/sidebar/floating)
- Click to dock/undock functionality

**Phase 2: Tools Panel (1-2 days)**
- Extract existing tools from GraphEditor
- Auto-layout controls
- Mass generosity slider
- Uniform scaling toggle
- Visibility controls (hide/show)

**Phase 3: What-If Panel (1-2 days)**
- Extract from existing WhatIfAnalysisControl
- Maintain current functionality (dropdowns + chips)
- Integration with icon bar

**Phase 4: Properties Panel (2-3 days)**
- Smart auto-open logic (once per tab)
- Split into Graph/Node/Edge variants
- Case node toggle (simple boolean)
- Conditional probability UI

**Phase 5: Polish & Testing (2-3 days)**
- Keyboard shortcuts
- State persistence per-tab
- rc-dock floating integration
- Testing & bug fixes

**Total Estimate: 9-13 days** (reduced by removing object palette)

### 📋 Next Steps

1. ✅ Design approved - Three panels (What-If, Properties, Tools)
2. ✅ Object palette deferred - Use existing right-click menu
3. 🔄 Start Phase 1 - Icon bar foundation
4. 🔄 Iterate on feedback after each phase

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
│ Slug: [checkout-flow    ▼][⋮]         │ ← Selector + sync menu
│       ^^^^^^^^^^^^^^^^^                 │   (canonical reference)
│       Node slug IS the connection       │
│                                         │
│ Label: [Checkout Flow            ]     │
│ Description: [textarea...        ]     │
│                                         │
│ ▼ ☑ Case Configuration                 │ ← Checkbox in section header
│                                         │
│ Case: [checkout-ab-test ▼][⋮]         │ ← Selector + sync menu
│                                         │
│ Variants:                               │
│ ├─ control    ●────────────── 50%      │ ← Slider (existing style)
│ ├─ treatment  ●────────────── 50%      │
│ └─ [+ Add Variant]                     │
│                                         │
│ Status: [active ▼]                     │
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
│ Parameter: [conversion-rate ▼][⋮]     │ ← Selector + sync menu
│                                         │
│ Base:  ●────────────────── 0.75        │ ← Slider (existing style)
│ Stdev: [0.05              ]            │ ← Standardized input
│                                         │
│ ▼ Cost 1                                │
│                                         │
│ Parameter: [cost-checkout   ▼][⋮]     │ ← Selector + sync menu
│                                         │
│ Monetary: [$2.50              ]        │
│ ± [0.50              ]                 │
│ Time:     [5.0                ] sec    │
│ ± [0.5               ] sec             │
│                                         │
│ ▼ Cost 2                                │
│                                         │
│ Parameter: [cost-alt        ▼][⋮]     │ ← Selector + sync menu
│                                         │
│ Monetary: [$1.00              ]        │
│ ± [0.25              ]                 │
│ Time:     [2.0                ] sec    │
│ ± [0.2               ] sec             │
│                                         │
│ ▼ Conditional Probabilities             │
│   [See detailed mockup below]          │
└─────────────────────────────────────────┘
```

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

### 9.4 Conditional Probabilities - Detailed Mockup

**Context**: Edges can have conditional probabilities based on visited nodes

```
┌─────────────────────────────────────────────────────┐
│ ➡️ Edge Properties: A → B                            │
├─────────────────────────────────────────────────────┤
│ ▼ Conditional Probabilities                         │
│                                                     │
│   ┌───────────────────────────────────────────┐   │
│   │ Condition 1                          [×]  │   │
│   ├───────────────────────────────────────────┤   │
│   │                                           │   │
│   │ Parameter: [high-conv     ▼][⋮]         │   │ ← Selector + sync menu
│   │                                           │   │
│   │ If visited (AND):                         │   │
│   │ [Select node... ▼]           [+ Add]     │   │ ← Existing selector
│   │   • node-checkout                [×]      │   │ ← Chips
│   │   • node-payment                 [×]      │   │
│   │                                           │   │
│   │ Then probability: ●──────── 0.90         │   │ ← Slider
│   │       Stdev: [0.03              ]         │   │
│   │                                           │   │
│   │ Color: [●][○][○][○][○][Custom]          │   │ ← Color selector
│   └───────────────────────────────────────────┘   │
│                                                     │
│   ┌───────────────────────────────────────────┐   │
│   │ Condition 2                          [×]  │   │
│   ├───────────────────────────────────────────┤   │
│   │                                           │   │
│   │ Parameter: [low-conv      ▼][⋮]         │   │ ← Selector + sync menu
│   │                                           │   │
│   │ If visited (AND):                         │   │
│   │ [Select node... ▼]           [+ Add]     │   │
│   │   • node-abandoned               [×]      │   │
│   │                                           │   │
│   │ Then probability: ●──────── 0.20         │   │
│   │       Stdev: [0.10              ]         │   │
│   │                                           │   │
│   │ Color: [○][●][○][○][○][Custom]          │   │ ← Red selected
│   └───────────────────────────────────────────┘   │
│                                                     │
│   [+ Add Condition]                                │
│                                                     │
└─────────────────────────────────────────────────────┘
```

**Behavior**:
1. **Inline Editing**: No modal, expand condition card in place
2. **Parameter Connection**: Each condition can connect to parameter (existing selector)
3. **Node Selection**: Use existing selector component (shows graph nodes + node registry)
4. **Multiple Nodes**: Add multiple node chips per condition
5. **AND Logic**: All listed nodes must be visited (implicit)
6. **Color Selector**: Standard component with 5 preset colors + custom option
7. **Evaluation Order**: Conditions checked in order, first match wins
8. **Fallback**: If no condition matches, use base probability

---

### 9.5 Color Selector Component

**Purpose**: Standard component for selecting visual indicators

```
┌─────────────────────────────────────┐
│ Color Selector                      │
├─────────────────────────────────────┤
│                                     │
│ Preset Colors:                      │
│ [●] [○] [○] [○] [○]                │
│ Green Red Blue Yellow Black         │
│                                     │
│ [Custom...]                         │
│                                     │
└─────────────────────────────────────┘
```

**When "Custom..." clicked**:
```
┌─────────────────────────────────────┐
│ Custom Color                        │
├─────────────────────────────────────┤
│                                     │
│ ┌─────┐                            │
│ │     │ ← Color picker (HTML5)     │
│ └─────┘                            │
│                                     │
│ Hex: [#FF5733]                     │
│                                     │
│ [Cancel] [Apply]                   │
└─────────────────────────────────────┘
```

**Preset Colors** (bold & bright for visibility):
- 🟢 Green: `#10B981` (Emerald 500)
- 🔴 Red: `#EF4444` (Red 500)
- 🔵 Blue: `#3B82F6` (Blue 500)
- 🟡 Yellow: `#F59E0B` (Amber 500)
- ⚫ Black: `#1F2937` (Gray 800)

**Usage**:
```tsx
<ColorSelector
  value="#10B981"
  onChange={(color) => setConditionColor(color)}
  presets={['#10B981', '#EF4444', '#3B82F6', '#F59E0B', '#1F2937']}
  allowCustom={true}
/>
```

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

### 9.6 Standard Selector Component (Universal Connection UI)

**Purpose**: ONE selector component for ALL registry connections  
**Enhancement**: Extend existing selector with `[⋮]` sync menu integration  
**Visual Styling**: Connection type determines border/background color (pastel)

```typescript
// Enhance existing Selector component with integrated sync menu
// This is the ONLY selector component - used for node slug, case, parameter, context connections
interface SelectorProps {
  type: 'case' | 'parameter' | 'context' | 'node';  // Determines visual styling
  value: string | null;
  onChange: (value: string | null) => void;
  placeholder?: string;
  // NEW: Sync handlers (integrated [⋮] menu)
  onSyncFrom?: () => void;   // Pull from registry
  onSyncTo?: () => void;     // Push to registry
  onRetrieve?: () => void;   // Retrieve latest (live data from external source)
}

export function Selector({
  type,
  value,
  onChange,
  placeholder,
  onSyncFrom,
  onSyncTo,
  onRetrieve
}: SelectorProps) {
  const [showSyncMenu, setShowSyncMenu] = useState(false);
  
  return (
    <div className="selector-container">
      {/* Existing dropdown */}
      <select value={value || ''} onChange={(e) => onChange(e.target.value)}>
        <option value="">{placeholder}</option>
        {/* Current graph items */}
        <optgroup label="Current Graph">
          {/* ... graph items ... */}
        </optgroup>
        {/* Registry items */}
        <optgroup label="Registry">
          {/* ... registry items ... */}
        </optgroup>
      </select>
      
      {/* NEW: Sync menu icon (only when value is set) */}
      {value && (onSyncFrom || onSyncTo || onRetrieve) && (
        <div className="selector-sync-menu">
          <button 
            className="selector-sync-icon"
            onClick={() => setShowSyncMenu(!showSyncMenu)}
            title="Sync options"
          >
            ⋮
          </button>
          
          {showSyncMenu && (
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
      )}
    </div>
  );
}
```

**CSS for Type-Specific Styling**:
```css
/* Container with connection-type styling */
.selector-container {
  display: flex;
  align-items: center;
  gap: 4px;
  position: relative;
  padding: 8px;
  border-radius: 6px;
  border: 2px solid transparent;
  transition: all 0.2s;
}

/* Type-specific pastel styling (for connection fields) */
.selector-container[data-type="node"] {
  border-color: #BFDBFE;  /* Blue 200 */
  background: linear-gradient(to right, #EFF6FF, white);
}

.selector-container[data-type="case"] {
  border-color: #DDD6FE;  /* Purple 200 */
  background: linear-gradient(to right, #FAF5FF, white);
}

.selector-container[data-type="parameter"] {
  border-color: #FED7AA;  /* Orange 200 */
  background: linear-gradient(to right, #FFF7ED, white);
}

.selector-container[data-type="context"] {
  border-color: #BBF7D0;  /* Green 200 */
  background: linear-gradient(to right, #F0FDF4, white);
}

/* Connected state (has value) */
.selector-container.connected {
  border-width: 3px;
  box-shadow: 0 2px 6px rgba(0, 0, 0, 0.08);
}

/* Sync menu button */
.selector-sync-icon {
  background: white;
  border: 1px solid #D1D5DB;
  border-radius: 4px;
  padding: 4px 8px;
  cursor: pointer;
  font-size: 16px;
  color: #6B7280;
  flex-shrink: 0;
}

.selector-sync-icon:hover {
  background: #F3F4F6;
  border-color: #9CA3AF;
}

.selector-sync-dropdown {
  position: absolute;
  top: 100%;
  right: 0;
  margin-top: 4px;
  background: white;
  border: 1px solid #D1D5DB;
  border-radius: 6px;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
  z-index: 1000;
  min-width: 180px;
}

.selector-sync-dropdown button {
  display: block;
  width: 100%;
  text-align: left;
  padding: 8px 12px;
  border: none;
  background: none;
  cursor: pointer;
  font-size: 13px;
  color: #374151;
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

