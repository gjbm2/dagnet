# Phase 1: UI Integration Points

**Date:** 2025-11-05  
**Phase:** Phase 1 - Task 3 (REVISED)  
**Purpose:** Define where and how users trigger data sync operations

---

## Overview

Users interact with data sync in **3 places only:**
- **A. Properties Panel** (via connect/selector)
- **B. Context Menus** (right-click on edges/nodes)
- **C. Data Menu** (new top menu)

All operations write to **local files (IndexedDB)**, marking them **dirty (orange)**.

---

## Iconography Standard

**From `DATA_CONNECTIONS.md` Section 2.4:**

### Entity Icons
- `<TrendingUpDown>` - Graph
- `<Folders>` - **ALL Files** (parameters, cases, nodes, contexts, events)
- `<DatabaseZap>` - External Source (Amplitude, Sheets, etc.)

### Connection States (Tristate - on connect/selector)
- `<Unplug>` - No connection (manual values only)
- `<Plug>` - Connected to parameter file
- `<HousePlug>` - Connected to parameter file + live data source

### Data Source Status (on connect/selector)
- `<Zap fill="currentColour">` - Live data source configured (filled)
- `<Zap fill="none">` - Manual data only / no external source (stroke only)

### Override Indicators (ONLY on RHS of fields in PropertiesPanel which can be overridden)
- `<ZapOff>` - Field has `overridden=true` (auto-updates disabled)
- No icon - Field not overridden (accepts auto-updates)

### Canonical Operations (with Pathway Icons)

**Four core operations, each with its pathway visualization:**

1. **Get from File** → `Folders → TrendingUpDown`
   - Get data from parameter/case/node file into graph
   - Uses existing file values

2. **Get from Source** → `DatabaseZap → Folders → TrendingUpDown`
   - Retrieve from external source (Amplitude, Sheets, StatsIG)
   - Updates parameter file (versioned, history preserved)
   - Then updates graph from file
   - Default pathway (versioned)

3. **Get from Source (direct)** → `DatabaseZap → TrendingUpDown`
   - Retrieve from external source directly into graph
   - Bypasses parameter file (not versioned)
   - Override mode for quick analysis

4. **Put to File** → `TrendingUpDown → Folders`
   - Put current graph values into parameter/case/node file
   - Appends to values[]/schedules[] array

### State/Sync Icons
- `<Check>` - Synced (graph matches file)
- `<AlertCircle>` - Out of sync (values differ)
- `<Clock>` - Stale (last retrieve > refresh frequency)

### UI Icon Convention
- ✅ **Use icons for:** Small action buttons (e.g., lightning button), state indicators, pathway visualization
- ❌ **NO icons in context menus:** Too cluttered - text labels only (deprecating existing menu icons)

---

## A. Properties Panel (Connect/Selector)

**Location:** PropertiesPanel → when edge/node property has connect/selector  
**Visual:** Lightning bolt icon (`<Zap>` or `<ZapOff>`) next to selector

### Lightning Menu Actions

When user clicks lightning icon, show dropdown menu:

```typescript
// Context: Edge probability parameter
┌─────────────────────────────────────────────────────────┐
│ Get from File                                           │  // if param_id exists in registry
│   Folders → TrendingUpDown                             │  // pathway visualization
│                                                         │
│ Get from Source                                         │  // if external source configured
│   DatabaseZap → Folders → TrendingUpDown               │  // pathway visualization (default)
│                                                         │
│ Get from Source (direct)                                │  // if external source configured
│   DatabaseZap → TrendingUpDown                         │  // pathway visualization (override)
│                                                         │
│ Put to File                                             │  // if param_id exists in registry
│   TrendingUpDown → Folders                             │  // pathway visualization
│ ─────────────────────────────────────────────────────  │
│ Connection Settings...                                  │  // if param_id exists
│ Sync Status...                                          │
└─────────────────────────────────────────────────────────┘
```

**Behavior:**
- **Get from File:** 
  - Pathway: `Folders → TrendingUpDown`
  - Calls `UpdateManager.handleFileToGraph()`
  - Updates edge/node with mapped fields from existing file
  - Respects `_overridden` flags (skips overridden fields)
  - Shows toast: "Updated from {param_id}.yaml"

- **Get from Source:**
  - Pathway: `DatabaseZap → Folders → TrendingUpDown` (versioned)
  - Only enabled if external source configured (e.g., `amplitude` connector)
  - Calls external connector → retrieves fresh data
  - Updates parameter file (appends to values[])
  - Then updates graph from file
  - Marks param file + index as dirty (orange)
  - Shows toast: "Retrieved from {source_type}, updated {param_id}.yaml"

- **Get from Source (direct):**
  - Pathway: `DatabaseZap → TrendingUpDown` (not versioned)
  - Only enabled if external source configured
  - Calls external connector → retrieves fresh data
  - Updates graph directly, bypasses file
  - No file changes (nothing marked dirty)
  - Shows toast: "Retrieved from {source_type} (not saved to file)"

- **Put to File:**
  - Pathway: `TrendingUpDown → Folders`
  - Calls `UpdateManager.handleGraphToFile()`
  - Appends current graph values to `values[]` array in param file
  - Marks param file + index as dirty (orange)
  - Shows toast: "{param_id}.yaml updated (unsaved)"

- **Connection Settings:**
  - Opens modal for editing external source configuration
  - Per-parameter settings (not per-edge) - multiple edges can share same param file connection
  - Configures: source type (Amplitude, Sheets, API), credentials, workspace, etc.
  - "Save to File" writes to `parameter.connection` object in param file
  - Marks param file + index as dirty (orange)
  - Only visible if `param_id` exists
  - Used by "Get from Source" to build API requests
  - See `CONNECTION_SETTINGS_WORKFLOW.md` for detailed design
  - Stub implementation for Phase 1 (show "Feature coming soon" toast)

- **Sync Status:**
  - Opens modal showing:
    - Current value in graph
    - Latest value in file (if linked)
    - Last sync timestamp
    - Override status per field
    - External source status (if configured)
    - Pathway being used

### Connection State Icon (Tristate)

The **selector itself** shows one of three connection states:

```typescript
// Connection state icon on selector (left side, replacing dropdown arrow):
if (!parameter_id && !external_source) {
  icon = <Unplug className="text-gray-400" />;
  tooltip = "No connection (manual values only)";
} else if (parameter_id && !external_source) {
  icon = <Plug className="text-blue-500" />;
  tooltip = "Connected to {parameter_id}.yaml";
} else if (parameter_id && external_source) {
  icon = <HousePlug className="text-green-500" />;
  tooltip = "Connected to {parameter_id}.yaml + {source_type}";
} else if (!parameter_id && external_source) {
  // Direct to graph (rare, override mode)
  icon = <DatabaseZap className="text-amber-500" />;
  tooltip = "Direct from {source_type} (not versioned)";
}
```

### Data Source Icon (Lightning Menu Button)

The **lightning menu button** (right side of selector) shows:

```typescript
// Lightning button state:
if (external_source) {
  icon = <Zap fill="currentColour" className="text-blue-500" />;
  tooltip = "Retrieve from {source_type}";
} else {
  icon = <Zap fill="none" className="text-gray-400" />;
  tooltip = "No external source";
  disabled = true; // Can't retrieve if no source
}
```

### Auto-Behavior on First Connect

**When user first selects a parameter/node via selector:**

```typescript
async function onConnect(selectedId: string) {
  // 1. Check if file exists in registry
  const existsInRegistry = await checkRegistry(selectedId);
  
  if (existsInRegistry) {
    // 2. Auto "Get from File"
    await handleGetFromFile(selectedId);
    showToast(`Loaded values from ${selectedId}.yaml`);
  } else {
    // File doesn't exist - just link the ID
    edge.parameter_id = selectedId;
  }
}
```

### "+ Create File" Button Behavior

**When user clicks "+ Create File" in selector:**

```typescript
async function onCreateFile(newId: string) {
  // 1. Create file with current graph values (like "Put to File")
  await UpdateManager.handleGraphToFile('CREATE', 'parameter', edge, newId);
  
  // 2. Link to new file
  edge.parameter_id = newId;
  
  // 3. Files marked dirty (auto via fileOperationsService)
  showToast(`Created ${newId}.yaml (unsaved)`);
}
```

### Parameter Usage Indicator (NEW)

**Show how many graphs use each parameter in selector list:**

**Why?** Helps user understand:
- Which params are canonical/reusable (used by many graphs)
- Which params are specific to one graph
- Impact of editing a param file

**UI in Selector List:**

```typescript
┌─────────────────────────────────────────────┐
│ Choose Parameter                            │
├─────────────────────────────────────────────┤
│                                             │
│ checkout-conversion           [5 graphs] 📊 │  ← Used by 5 graphs
│ add-to-cart-rate             [12 graphs] 📊 │  ← Used by 12 graphs
│ mobile-checkout-v2            [1 graph]  📊 │  ← Used by 1 graph only
│ homepage-engagement          [23 graphs] 📊 │  ← Heavily reused!
│                                             │
│ [+ Create New Parameter]                    │
└─────────────────────────────────────────────┘
```

**Behavior:**
- Count graphs in **current repo** (local clone, already available)
- Click graph count badge → Show modal with list of graphs using this param
- Helps user decide: "Should I create a new param or reuse existing?"

**Implementation:**
```typescript
interface ParamUsageInfo {
  paramId: string;
  graphCount: number;
  graphList: Array<{
    graphId: string;
    graphName: string;
    lastModified: string;
  }>;
}

// Scan repo for usage
async function getParamUsage(paramId: string): Promise<ParamUsageInfo> {
  const allGraphs = await fileRegistry.getAllGraphFiles();
  const usedBy = allGraphs.filter(graph => {
    return graph.edges.some(e => 
      e.p?.parameter_id === paramId ||
      e.cost_gbp?.parameter_id === paramId ||
      e.cost_time?.parameter_id === paramId
    );
  });
  
  return {
    paramId,
    graphCount: usedBy.length,
    graphList: usedBy.map(g => ({
      graphId: g.id,
      graphName: g.name || g.id,
      lastModified: g.metadata?.last_modified
    }))
  };
}
```

**Graph List Modal:**
```typescript
┌──────────────────────────────────────────────────┐
│ Graphs Using "checkout-conversion"              │
├──────────────────────────────────────────────────┤
│                                                  │
│ • Main Funnel Analysis    (modified 2 days ago)  │
│ • Mobile vs Desktop       (modified 1 week ago)  │
│ • Seasonal Comparison     (modified 3 weeks ago) │
│ • Regional Breakdown      (modified 1 month ago) │
│ • Cohort Analysis 2024    (modified 2 months ago)│
│                                                  │
│ 5 graphs total                                   │
│                                                  │
│                             [Close]              │
└──────────────────────────────────────────────────┘
```

**This addresses user's insight:**
> "the 'multiple graphs use this param' point makes me think we should probably make a point to surface that on connect/selector"

---

## B. Context Menus (Right-Click)

### B1. Node Context Menu

**Trigger:** Right-click on node  
**Condition:** Node has `node.id` that exists in nodes-index

```typescript
┌─────────────────────────────────────────┐
│ ... (existing menu items)               │
│ ─────────────────────────────────────   │
│ Get from Node File                      │  // if node.id in registry
│ Get from Source                         │  // if external source configured
│ Put to Node File                        │  // if node.id in registry
└─────────────────────────────────────────┘
```

**Operations:**
- **Get from Node File:**
  - Pathway: `Folders → TrendingUpDown`
  - Loads `nodes/{node.id}.yaml`
  - Updates `node.label`, `node.description`, `node.event_id`, etc.
  - Respects `label_overridden`, `description_overridden` flags

- **Get from Source:**
  - Pathway: `DatabaseZap → Folders → TrendingUpDown`
  - Only if external source configured for node metadata (rare, future)
  - Updates node properties

- **Put to Node File:**
  - Pathway: `TrendingUpDown → Folders`
  - Writes current node properties to `nodes/{node.id}.yaml`
  - Updates nodes-index.yaml
  - Both files marked dirty

### B2. Case Node Context Menu (Additional Items)

**Trigger:** Right-click on case node (node with `case_id`)  
**Condition:** Node has `case_id` that exists in cases-index

```typescript
┌─────────────────────────────────────────┐
│ ... (existing + node items above)       │
│ ─────────────────────────────────────   │
│ Case: {case_id}                         │
│   Get from Case File                    │
│   Get from Source                       │  // e.g., StatsIG
│   Put to Case File                      │
└─────────────────────────────────────────┘
```

**Operations:**
- **Get from Case File:**
  - Pathway: `Folders → TrendingUpDown`
  - Loads `cases/{case_id}.yaml`
  - Updates case variants, schedules, etc.

- **Get from Source:**
  - Pathway: `DatabaseZap → Folders → TrendingUpDown`
  - Fetches from StatsIG (or other case source)
  - Updates case file then graph

- **Put to Case File:**
  - Pathway: `TrendingUpDown → Folders`
  - Writes case data to file
  - Marks dirty

### B3. Edge Context Menu

**Trigger:** Right-click on edge  
**Condition:** Edge has `parameter_id`, `cost_parameter_id`, etc. that exist in parameters-index

```typescript
┌─────────────────────────────────────────┐
│ ... (existing menu items)               │
│ ─────────────────────────────────────   │
│ Parameter: {parameter_id}               │  // Show for each linked param
│   Get from File                         │
│   Get from Source                       │  // if external source configured
│   Get from Source (direct)              │  // if external source configured
│   Put to File                           │
│ ─────────────────────────────────────   │
│ Cost: {cost_parameter_id}               │  // If cost param linked
│   Get from File                         │
│   Put to File                           │
└─────────────────────────────────────────┘
```

**Operations:**
- Same as Properties Panel lightning menu
- Pathways shown inline (not in menu text)
- Contextualized by parameter type (probability vs cost vs duration)
- Multiple sections if multiple params linked

**Notes:**
- Only show param sections if `parameter_id` exists in parameters-index
- "Get from Source" options only if external source configured on that parameter
- Respect `_overridden` flags on all get operations

---

## C. Data Menu (New Top Menu)

**Location:** Top menu bar → new "Data" menu  
**Always Available**

### Menu Structure

```typescript
Data
├─ Get All from Files...
├─ Get All from Sources...
├─ Put All to Files...
├─ Sync Status...
├─ ──────────────────────────────
└─ (Contextual items if node/edge selected)
   └─ Same as context menu for selected element
```

### Batch Operations (First 3 Items)

All three open a **selection modal** (similar to "Commit All" modal):

#### "Get All from Files..." Modal

```typescript
┌──────────────────────────────────────────────────┐
│ Get Data from Files                              │
│ Pathway: Folders → TrendingUpDown                │
├──────────────────────────────────────────────────┤
│                                                  │
│ Select items to update:                          │
│                                                  │
│ ☑ Nodes (3 linked)                               │
│   ☑ homepage          nodes/homepage.yaml        │
│   ☑ product-page      nodes/product-page.yaml    │
│   ☑ checkout          nodes/checkout.yaml        │
│                                                  │
│ ☑ Edge Parameters (5 linked)                     │
│   ☑ homepage-to-product  parameters/...yaml      │
│   ☑ product-to-cart      parameters/...yaml      │
│   ☑ cart-to-checkout     parameters/...yaml      │
│   ☐ checkout-complete    (overridden - skip)     │  // Grayed out if overridden
│   ☑ checkout-cost        parameters/...yaml      │
│                                                  │
│ ☑ Cases (1 linked)                               │
│   ☑ checkout-redesign    cases/...yaml           │
│                                                  │
│ [ ] Overwrite overridden values                  │  // Checkbox
│                                                  │
│           [Cancel]  [Get Selected (9)]           │
└──────────────────────────────────────────────────┘
```

**Behavior:**
- Pathway: `Folders → TrendingUpDown`
- Lists all graph elements with registry links
- Default: all selected
- User can unselect items
- Grayed out items have overridden flags (skip unless checkbox enabled)
- Click "Get Selected" → batch calls `UpdateManager.handleFileToGraph()` for each
- Shows progress: "Getting 9 items... 3/9 complete"
- Final toast: "Got 9 items from files"

#### "Get All from Sources..." Modal

Similar structure, but:
- Only lists items with external sources configured
- Shows source type per item (Amplitude, Sheets, StatsIG)
- May take longer (actual API calls)
- Shows progress with spinner per item

#### "Put All to Files..." Modal

```typescript
┌──────────────────────────────────────────────────┐
│ Put Data to Files                                │
│ Pathway: TrendingUpDown → Folders               │
├──────────────────────────────────────────────────┤
│                                                  │
│ This will update files (marking them dirty):     │
│                                                  │
│ ☑ Nodes (3)                                      │
│   ☑ homepage          → nodes/homepage.yaml      │
│   ☑ product-page      → nodes/product-page.yaml  │
│   ☑ checkout          → nodes/checkout.yaml      │
│                                                  │
│ ☑ Edge Parameters (5)                            │
│   ☑ homepage-to-product  → append values[]       │
│   ☑ product-to-cart      → append values[]       │
│   ☑ cart-to-checkout     → append values[]       │
│   ☑ checkout-complete    → append values[]       │
│   ☑ checkout-cost        → append values[]       │
│                                                  │
│ ☑ Cases (1)                                      │
│   ☑ checkout-redesign    → append schedules[]    │
│                                                  │
│ ⚠️ 9 files will be marked dirty                  │
│                                                  │
│           [Cancel]  [Put Selected (9)]           │
└──────────────────────────────────────────────────┘
```

**Behavior:**
- Pathway: `TrendingUpDown → Folders`
- Lists all items that CAN be put (have registry links)
- Shows what will happen (append, update, etc.)
- Warning about dirty files
- Batch calls `UpdateManager.handleGraphToFile()` for each
- All updated files + indices marked dirty
- Toast: "Put 9 items to files (unsaved)"

### "Sync Status..." Modal

**Purpose:** Show comprehensive view of what's synced where

```typescript
┌─────────────────────────────────────────────────────────────────┐
│ Data Sync Status                                                │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│ Nodes (3 linked, 7 unlinked)                                    │
│ ┌─────────────────────────────────────────────────────────────┐ │
│ │ homepage                                                    │ │
│ │   Registry:  nodes/homepage.yaml (linked)                   │ │
│ │   Modified:  2025-11-05 14:30                               │ │
│ │   Overrides: label ✓, description ✗                        │ │
│ │   Source:    None configured                                │ │
│ │   [Get] [Put] [View File]                                   │ │
│ └─────────────────────────────────────────────────────────────┘ │
│ │                                                                 │
│ │ product-page                                                  │ │
│ │   Registry:  nodes/product-page.yaml (linked)                │ │
│ │   Modified:  2025-11-04 10:15                                │ │
│ │   Overrides: None                                            │ │
│ │   Source:    None configured                                 │ │
│ │   [Get] [Put] [View File]                                    │ │
│ └─────────────────────────────────────────────────────────────┘ │
│                                                                 │
│ Edge Parameters (5 linked, 12 unlinked)                         │
│ ┌─────────────────────────────────────────────────────────────┐ │
│ │ homepage-to-product                                         │ │
│ │   Registry:  parameters/homepage-to-product.yaml            │ │
│ │   Modified:  2025-11-05 09:00                               │ │
│ │   Graph:     p.mean = 0.35 (overridden ✗)                  │ │
│ │   File:      values[latest].mean = 0.32                     │ │
│ │              (from 2025-11-04, n=1000, k=320)               │ │
│ │   Source:    Amplitude (last retrieved: 2025-11-04 08:00)   │ │
│ │   Status:    ⚠️ Graph value differs from file              │ │
│ │   [Get] [Put] [Retrieve from Amplitude] [View File]         │ │
│ └─────────────────────────────────────────────────────────────┘ │
│                                                                 │
│ Cases (1 linked)                                                │
│ ┌─────────────────────────────────────────────────────────────┐ │
│ │ checkout-redesign                                           │ │
│ │   Registry:  cases/checkout-redesign.yaml                   │ │
│ │   Modified:  2025-11-03 16:45                               │ │
│ │   Variants:  control, variant-a, variant-b                  │ │
│ │   Source:    StatsIG (last synced: never)                   │ │
│ │   [Get] [Put] [Retrieve from StatsIG] [View File]           │ │
│ └─────────────────────────────────────────────────────────────┘ │
│                                                                 │
│                                      [Close]                    │
└─────────────────────────────────────────────────────────────────┘
```

**Features:**
- Shows every graph element (nodes, edges, cases)
- Indicates if linked to registry
- Shows override status per field
- Shows external source status (if configured)
- **Highlights discrepancies** between graph and file values
- Action buttons for quick operations
- "View File" opens file in tab for inspection

---

## Implementation Details

### Checking Registry Existence

```typescript
function isInRegistry(type: 'node' | 'parameter' | 'case', id: string): boolean {
  // Check if index file has this ID
  const indexFileId = `${type}-index`;
  const indexFile = fileRegistry.getFile(indexFileId);
  
  if (!indexFile) return false;
  
  const entries = indexFile.data[`${type}s`];
  return entries?.some((e: any) => e.id === id) || false;
}
```

### Respecting Override Flags

```typescript
async function handleGetFromFile(sourceData: any, targetObject: any, mappings: Mapping[]) {
  for (const mapping of mappings) {
    // Skip if field is overridden
    if (mapping.overrideFlag && targetObject[mapping.overrideFlag]) {
      console.log(`Skipping ${mapping.targetField} - overridden by user`);
      continue;
    }
    
    // Apply mapping
    const newValue = applyTransform(sourceData[mapping.sourceField], mapping.transform);
    targetObject[mapping.targetField] = newValue;
  }
}
```

### External Source Configuration Check

```typescript
function hasExternalSource(type: 'node' | 'parameter' | 'case', id: string): boolean {
  // For parameters: check if parameter file has `query` field
  const paramFile = fileRegistry.getFile(`parameter-${id}`);
  if (paramFile?.data?.query) return true;
  
  // For cases: check if case file has `platform` config
  const caseFile = fileRegistry.getFile(`case-${id}`);
  if (caseFile?.data?.case?.platform) return true;
  
  // For nodes: currently no external sources (future)
  return false;
}
```

---

## Priority Implementation Order

### Phase 1.1 (Critical - 2 days)
1. ✅ Auto index sync (COMPLETE)
2. ⏳ **Properties Panel lightning menu** (Get/Put/Source)
3. ⏳ Auto "Get from File" on first connect
4. ⏳ "+ Create File" behavior

### Phase 1.2 (Important - 2 days)
5. ⏳ **Context menus** (node, case node, edge)
6. ⏳ Registry existence checks
7. ⏳ Override flag respect in all operations

### Phase 1.3 (Nice to have - 2 days)
8. ⏳ **Data Menu** batch operations
9. ⏳ Selection modal (like commit modal)
10. ⏳ **Sync Status modal**

### Phase 1.4 (Future)
11. ⏳ External source connectors (Amplitude, Sheets, StatsIG)
12. ⏳ "Get from Source" full implementation

---

## Design Decisions

1. **Sync Status Modal Design:** ✅ Use tree view pattern from connect/selector 'expand' mode. Reuse existing modal classes, don't create new ones.

2. **External Source Logic:** ✅ Stub "Get from Source" for now (shows toast "Feature coming soon"). Full connector infrastructure is Phase 2.

3. **Batch Operation Feedback:** ✅ Stub batch operations for now (menu items exist but show "Feature coming soon"). Full implementation is Phase 2.

---

