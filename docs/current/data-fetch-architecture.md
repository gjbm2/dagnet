# Data Fetch Architecture

This document traces the complete code path from UI components through to data shown to the user, highlighting props passed at each stage.

## Overview: The Three Fetch Modes

```
┌─────────────────────────────────────────────────────────────────────────┐
│                           useFetchData Hook                              │
│                                                                          │
│   fetchItem(item, { mode: 'versioned' | 'direct' | 'from-file' })       │
│                                                                          │
│   Props: graph, setGraph, currentDSL (from WindowSelector)              │
└─────────────────────────────────────────────────────────────────────────┘
                                    │
              ┌─────────────────────┼─────────────────────┐
              ▼                     ▼                     ▼
     ┌────────────────┐   ┌────────────────┐   ┌────────────────┐
     │   VERSIONED    │   │     DIRECT     │   │   FROM-FILE    │
     │                │   │                │   │                │
     │ API → File →   │   │ API → Graph    │   │ File → Graph   │
     │ Graph          │   │ (no file)      │   │ (no API)       │
     └────────────────┘   └────────────────┘   └────────────────┘
```

## Entry Points (UI Components)

All fetch operations flow through `useFetchData` hook:

```
┌──────────────────────────────────────────────────────────────────────────┐
│                            UI ENTRY POINTS                                │
├──────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│  CANVAS COMPONENTS                                                       │
│  ─────────────────                                                       │
│  ┌─────────────────────┐                                                 │
│  │  WindowSelector     │ ──► Fetch button (versioned)                    │
│  │                     │     Auto-aggregation when data cached           │
│  └─────────────────────┘                                                 │
│                                                                          │
│  ┌─────────────────────┐                                                 │
│  │  EdgeContextMenu    │ ──► Get from File / Source / Direct             │
│  │                     │     For edge parameters (p, cost_gbp, cost_time)│
│  └─────────────────────┘                                                 │
│                                                                          │
│  ┌─────────────────────┐                                                 │
│  │  NodeContextMenu    │ ──► Get from File / Source / Direct             │
│  │                     │     For node data and case variants             │
│  └─────────────────────┘                                                 │
│                                                                          │
│  ┌─────────────────────┐                                                 │
│  │  DataOperationsMenu │ ──► Shared menu (used by LightningMenu/Zap)     │
│  │                     │     All fetch modes for any object type         │
│  └─────────────────────┘                                                 │
│                                                                          │
│  PANEL COMPONENTS                                                        │
│  ────────────────                                                        │
│  ┌─────────────────────┐                                                 │
│  │  PropertiesPanel    │ ──► "Get" button for edge params                │
│  │                     │     mode: 'from-file'                           │
│  └─────────────────────┘                                                 │
│                                                                          │
│  ┌─────────────────────┐                                                 │
│  │  EnhancedSelector   │ ──► Auto-get on item selection                  │
│  │                     │     mode: 'from-file', with setAutoUpdating     │
│  └─────────────────────┘                                                 │
│                                                                          │
│  MENU BAR                                                                │
│  ────────                                                                │
│  ┌─────────────────────┐                                                 │
│  │  DataMenu           │ ──► "Get from Source" (versioned)               │
│  │                     │ ──► "Get from Source (Direct)"                  │
│  │                     │ ──► "Get from File"                             │
│  └─────────────────────┘                                                 │
│                                                                          │
│  MODALS                                                                  │
│  ──────                                                                  │
│  ┌─────────────────────┐                                                 │
│  │  BatchOperationsModal│ ──► Batch fetch for multiple items             │
│  │                     │     Uses graphRef + getEffectiveDSL getters     │
│  └─────────────────────┘                                                 │
│                                                                          │
└──────────────────────────────────────────────────────────────────────────┘
```

### Entry Point Summary

| Component | Modes Used | Trigger |
|-----------|------------|---------|
| WindowSelector | versioned, from-file | Fetch button, auto-aggregate |
| EdgeContextMenu | versioned, direct, from-file | Right-click menu |
| NodeContextMenu | versioned, direct, from-file | Right-click menu |
| DataOperationsMenu | versioned, direct, from-file | Lightning/Zap menu |
| PropertiesPanel | from-file | "Get" button in panel |
| EnhancedSelector | from-file | Auto-get on selection |
| DataMenu | versioned, direct, from-file | Menu bar > Data |
| BatchOperationsModal | versioned, direct, from-file | Batch operations |

```
                                    │
                                    ▼
┌──────────────────────────────────────────────────────────────────────────┐
│                          useFetchData Hook                                │
│                                                                          │
│  const { fetchItem } = useFetchData({                                    │
│    graph,           // Graph or () => graphRef.current                   │
│    setGraph,        // Updates graph state                               │
│    currentDSL,      // DSL string or () => getEffectiveDSL()             │
│  });                                                                      │
│                                                                          │
│  CRITICAL PROPS:                                                         │
│  ┌────────────────────────────────────────────────────────────────┐      │
│  │ currentDSL = "window(1-Dec-25:7-Dec-25).context(geo=UK)"       │      │
│  │                                                                 │      │
│  │ This determines:                                                │      │
│  │ 1. API fetch window (what dates to request)                    │      │
│  │ 2. File slice isolation (which context's data to load/store)  │      │
│  │ 3. Window aggregation (what dates to aggregate over)          │      │
│  └────────────────────────────────────────────────────────────────┘      │
└──────────────────────────────────────────────────────────────────────────┘
```

## Mode 1: VERSIONED (Source → File → Graph)

Default mode. Fetches from API, stores time-series in file, aggregates to graph.

```
┌─────────────────────────────────────────────────────────────────────────┐
│ VERSIONED MODE: fetchItem(item, { mode: 'versioned' })                  │
└─────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                     dataOperationsService.getFromSource()                │
│                                                                          │
│  Props received:                                                         │
│  ┌────────────────────────────────────────────────────────────────┐     │
│  │ objectType: 'parameter' | 'case' | 'node'                       │     │
│  │ objectId:   'my-param-id'                                       │     │
│  │ targetId:   'edge-uuid-123'                                     │     │
│  │ paramSlot:  'p' | 'cost_gbp' | 'cost_time'                      │     │
│  │ conditionalIndex?: number (for conditional probabilities)      │     │
│  │ currentDSL: 'window(1-Dec-25:7-Dec-25).context(geo=UK)'         │     │
│  └────────────────────────────────────────────────────────────────┘     │
└─────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                      Step 0: Check Cache Coverage                        │
│                                                                          │
│  Before hitting API, calculateIncrementalFetch() checks:                │
│  - What dates are already in the file for this slice?                   │
│  - What dates are needed for the requested window?                      │
│  - If all dates covered → skip API, go to Step 3 (aggregate from file) │
│  - If gaps exist → fetch only missing dates (or all if bustCache=true)  │
│                                                                          │
└─────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                      Step 1: Fetch from External API                     │
│                                                                          │
│  ┌─────────────────────┐     ┌─────────────────────────────────────┐    │
│  │  Amplitude/Statsig  │ ──► │ Response: daily time-series data   │    │
│  │  API Provider       │     │                                     │    │
│  │                     │     │ { date: '2025-12-01', n: 100, k: 50 } │   │
│  │  Query uses:        │     │ { date: '2025-12-02', n: 120, k: 55 } │   │
│  │  - window dates     │     │ ...                                  │    │
│  │  - edge query DSL   │     │                                     │    │
│  │  - edge n_query DSL │     │ NOTE: Dates stored as ISO (2025-12-01)│   │
│  │                     │     │ DSL display uses 1-Dec-25 format     │    │
│  └─────────────────────┘     └─────────────────────────────────────┘    │
│                                                                          │
│  Query strings come from:                                                │
│                                                                          │
│  For edge parameters (p, cost_gbp, cost_time):                          │
│    1. Edge's query field (for k)                                        │
│    2. Edge's n_query field (for n, if different)                        │
│    3. Fallback: parameter file's query/n_query                          │
│                                                                          │
│  For conditional probabilities:                                          │
│    - condition[i].query (each condition has its own)                    │
│                                                                          │
│  For case nodes:                                                         │
│    - case.query field on the case file                                  │
└─────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                     Step 2: Write to Parameter File                      │
│                                                                          │
│  File: parameter-{objectId}.yaml                                        │
│                                                                          │
│  ┌────────────────────────────────────────────────────────────────┐     │
│  │ id: my-param-id                                                 │     │
│  │ query: "from(nodeA).to(nodeB)"      # Copied from edge          │     │
│  │ n_query: "from(nodeA).to(nodeC)"    # Copied if edge has it     │     │
│  │ connection:                                                      │     │
│  │   provider: amplitude                                            │     │
│  │   ...                                                            │     │
│  │                                                                  │     │
│  │ values:                              # Time-series storage       │     │
│  │   - slice: ""                        # Uncontexted data          │     │       
│  │     data:                                                        │     │
│  │       - date: "2025-12-01"                                       │     │
│  │         n: 100                                                   │     │
│  │         k: 50                                                    │     │
│  │       - date: "2025-12-02"                                       │     │
│  │         n: 120                                                   │     │
│  │         k: 55                                                    │     │
│  │                                                                  │     │
│  │   - slice: "context(geo=UK)"         # UK-specific data          │     │
│  │     data:                                                        │     │
│  │       - date: "2025-12-01"                                       │     │
│  │         n: 30                                                    │     │
│  │         k: 15                                                    │     │
│  │       ...                                                        │     │
│  └────────────────────────────────────────────────────────────────┘     │
│                                                                          │
│  CRITICAL: targetSlice (= currentDSL) determines which values[] entry   │
│  to write to. They are THE SAME string - just different variable names. │
└─────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                     Step 3: Aggregate and Apply to Graph                 │
│                                                                          │
│  WindowAggregationService.aggregateForWindow()                          │
│                                                                          │
│  Input:                                                                  │
│  ┌────────────────────────────────────────────────────────────────┐     │
│  │ values[].data (time-series from file)                           │     │
│  │ targetSlice: "window(1-Dec-25:7-Dec-25).context(geo=UK)"        │     │
│  │              ▲                                                  │     │
│  │              └── Window parsed from DSL, context for filtering  │     │
│  └────────────────────────────────────────────────────────────────┘     │
│                                                                          │
│  Output (applied to graph edge):                                        │
│  ┌────────────────────────────────────────────────────────────────┐     │
│  │ edge.p.mean = 0.50        # Aggregated k/n = 250/500           │     │
│  │ edge.p.stdev = 0.023      # Computed from time-series          │     │
│  │ edge.p.evidence = {                                             │     │
│  │   n: 500,                                                       │     │
│  │   k: 250,                                                       │     │
│  │   window_from: '2025-12-01',                                    │     │
│  │   window_to: '2025-12-07',                                      │     │
│  │   method: 'sum',                                                │     │
│  │   source: 'amplitude'                                           │     │
│  │ }                                                                │     │
│  └────────────────────────────────────────────────────────────────┘     │
└─────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                        Step 4: Render in UI                              │
│                                                                          │
│  EdgeBeads component reads from graph:                                  │
│                                                                          │
│  ┌─────────────────────────────────────────────────────────────────┐    │
│  │  const edge = graph.edges.find(e => e.id === edgeId);           │    │
│  │  const p = edge.p;                                               │    │
│  │                                                                  │    │
│  │  // Display bead with:                                           │    │
│  │  // - Color from scenario                                        │    │
│  │  // - Value: p.mean (50%)                                        │    │
│  │  // - Tooltip: evidence.n, evidence.k, window                    │    │
│  │  // - Override indicator if p_overridden                         │    │
│  │  // - Connection icon if has connection                          │    │
│  └─────────────────────────────────────────────────────────────────┘    │
│                                                                          │
│  PropertiesPanel shows detailed evidence and allows editing             │
└─────────────────────────────────────────────────────────────────────────┘
```

## Mode 2: DIRECT (Source → Graph, no file storage)

For immediate application without time-series storage.

```
┌─────────────────────────────────────────────────────────────────────────┐
│ DIRECT MODE: fetchItem(item, { mode: 'direct' })                        │
└─────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                  dataOperationsService.getFromSourceDirect()             │
│                                                                          │
│  For parameter/case: Fetches and applies directly to graph              │
│  For case nodes: CAN have API sources (Statsig, Sheets, etc.)           │
│  For regular nodes: Falls back to from-file (no API source)             │
│                                                                          │
│  Key difference from versioned:                                         │
│  - Does NOT store time-series in file                                   │
│  - Applies snapshot directly to graph                                   │
│  - No time-series aggregation (API returns pre-aggregated snapshot)     │
│  - Window in DSL still used for API query date range                    │
│  - Context in DSL still used for API segmentation                       │
└─────────────────────────────────────────────────────────────────────────┘
                                    │
               ┌────────────────────┴────────────────────┐
               ▼                                         ▼
     ┌──────────────────┐                      ┌──────────────────┐
     │ parameter/case   │                      │      node        │
     │                  │                      │                  │
     │ API ──► Graph    │                      │ (falls back to   │
     │ (no file write)  │                      │  from-file mode) │
     └──────────────────┘                      └──────────────────┘
```

## Mode 3: FROM-FILE (File → Graph, no API)

Loads existing data from file without fetching.

```
┌─────────────────────────────────────────────────────────────────────────┐
│ FROM-FILE MODE: fetchItem(item, { mode: 'from-file' })                  │
└─────────────────────────────────────────────────────────────────────────┘
                                    │
               ┌────────────────────┼────────────────────┐
               ▼                    ▼                    ▼
     ┌──────────────────┐  ┌──────────────────┐  ┌──────────────────┐
     │    parameter     │  │       case       │  │       node       │
     │                  │  │                  │  │                  │
     │ getParameterFrom │  │  getCaseFromFile │  │  getNodeFromFile │
     │ File()           │  │  ()              │  │  ()              │
     └──────────────────┘  └──────────────────┘  └──────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                   Read from file and aggregate                           │
│                                                                          │
│  1. Read file from fileRegistry                                         │
│  2. Filter by targetSlice (match context)                               │
│  3. Aggregate over window dates                                         │
│  4. Apply to graph via UpdateManager                                    │
└─────────────────────────────────────────────────────────────────────────┘
```

## The DSL: Single Source of Truth

The DSL string `"window(1-Dec-25:7-Dec-25).context(geo=UK)"` contains EVERYTHING:

| Component | Parsed For | Example |
|-----------|------------|---------|
| `window(...)` | API date range, aggregation dates | `window(1-Dec-25:7-Dec-25)` |
| `context(...)` | File slice isolation | `context(geo=UK)` |

**Terminology:**
- `currentDSL` = the DSL passed to useFetchData hook
- `targetSlice` = same value, passed to service layer
- These are THE SAME STRING. No separate "window" parameter.

**File Slice Isolation:**
```yaml
# parameter-my-param.yaml
values:
  - sliceDSL: ""                    # Global (uncontexted) data
    data: [{date: "2025-12-01", n: 100, k: 50}, ...]
    
  - sliceDSL: "context(geo=UK)"     # UK-specific data
    data: [{date: "2025-12-01", n: 30, k: 15}, ...]
    
  - sliceDSL: "context(geo=US)"     # US-specific data  
    data: [{date: "2025-12-01", n: 70, k: 35}, ...]
```

When fetching with `context(geo=UK)`, only that slice is read/written.

## Override Flags and Data Priority

```
┌─────────────────────────────────────────────────────────────────────────┐
│                     OVERRIDE FLAG FLOW                                   │
└─────────────────────────────────────────────────────────────────────────┘

Edge can have override flags:
┌───────────────────────────────────────────────────────────────────────┐
│ edge.p = {                                                              │
│   mean: 0.50,                                                           │
│   mean_overridden: false,     ◄── If true, ignore incoming mean        │
│   stdev: 0.02,                                                          │
│   stdev_overridden: false,    ◄── If true, ignore incoming stdev       │
│   evidence: {...},                                                      │
│   connection: {...}                                                     │
│ }                                                                        │
│                                                                          │
│ edge.query = "from(a).to(b)"                                            │
│ edge.query_overridden = false  ◄── If true, don't copy from file       │
│                                                                          │
│ edge.n_query = "from(a).to(c)"                                          │
│ edge.n_query_overridden = false                                         │
└───────────────────────────────────────────────────────────────────────┘

UpdateManager respects these flags:
┌───────────────────────────────────────────────────────────────────────┐
│                                                                         │
│  Incoming data from file:   { mean: 0.45, stdev: 0.03 }                │
│  Edge has:                  { mean: 0.50, mean_overridden: true }       │
│                                                                         │
│  Result:                    { mean: 0.50 (kept), stdev: 0.03 (updated)}│
│                                                                         │
└───────────────────────────────────────────────────────────────────────┘
```

## Query String Storage Pattern

```
┌─────────────────────────────────────────────────────────────────────────┐
│              QUERY STRING: "Mastered on graph, copied to file"          │
└─────────────────────────────────────────────────────────────────────────┘

User edits query on edge in PropertiesPanel:
┌───────────────────────────────────────────────────────────────────────┐
│ edge.query = "from(nodeA).to(nodeB)"                                    │
│ edge.query_overridden = false                                           │
│                                                                          │
│ edge.n_query = "from(nodeA).to(nodeC)"  ◄── Optional, for separate n   │
│ edge.n_query_overridden = false                                         │
└───────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼ (on fetch from source)
┌───────────────────────────────────────────────────────────────────────┐
│ Parameter file gets query copied:                                       │
│                                                                          │
│ parameter-my-param.yaml:                                                │
│   id: my-param                                                          │
│   query: "from(nodeA).to(nodeB)"      ◄── Copied from edge              │
│   n_query: "from(nodeA).to(nodeC)"    ◄── Copied from edge              │
│   connection: {...}                                                      │
│   values: [...]                                                          │
└───────────────────────────────────────────────────────────────────────┘

WHY copy to file?
─────────────────
When loading parameter file standalone (no graph):
1. File has query string → can still fetch from API
2. No dependency on graph state
3. Enables headless/batch operations
```

## Complete Data Types

```
┌─────────────────────────────────────────────────────────────────────────┐
│                           FetchItem Interface                            │
└─────────────────────────────────────────────────────────────────────────┘

interface FetchItem {
  id: string;                              // Unique identifier
  type: 'parameter' | 'case' | 'node';     // Object type
  name: string;                            // Display name
  objectId: string;                        // File ID (e.g., 'my-param')
  targetId: string;                        // Graph element UUID
  paramSlot?: 'p' | 'cost_gbp' | 'cost_time';  // For parameters
  conditionalIndex?: number;               // For conditional probs
}

┌─────────────────────────────────────────────────────────────────────────┐
│                           FetchOptions Interface                         │
└─────────────────────────────────────────────────────────────────────────┘

interface FetchOptions {
  mode?: 'versioned' | 'direct' | 'from-file';  // Operation mode
  bustCache?: boolean;                           // Force re-fetch
  versionedCase?: boolean;                       // For case versioning
  setAutoUpdating?: (updating: boolean) => void; // Animation callback
}

NOTE: Window is NOT a separate parameter. It is parsed from currentDSL.
The DSL "window(1-Dec-25:7-Dec-25).context(geo=UK)" contains both
the window dates AND the context - single source of truth.
```

## Summary: When to Use Each Mode

| Mode | Use When | File Updated | API Called | Aggregation |
|------|----------|--------------|------------|-------------|
| `versioned` | Normal data refresh | ✅ | ✅ | ✅ |
| `direct` | Quick preview, testing | ❌ | ✅ | ❌ |
| `from-file` | Offline, switch context | ❌ | ❌ | ✅ |

## WindowSelector: Auto-Aggregation and Fetch Button Logic

The WindowSelector has complex logic for determining when to auto-aggregate vs show the Fetch button:

```
┌─────────────────────────────────────────────────────────────────────────┐
│              WINDOW/CONTEXT CHANGE DETECTION FLOW                        │
└─────────────────────────────────────────────────────────────────────────┘

User changes window or context in WindowSelector:
                                    │
                                    ▼
┌───────────────────────────────────────────────────────────────────────┐
│  useEffect triggers (debounced 300ms)                                  │
│                                                                         │
│  Checks:                                                                │
│  1. Has window changed from lastAggregatedWindow?                      │
│  2. Has context changed from lastAggregatedDSL?                        │
│                                                                         │
│  DONE: Now uses single DSL comparison (window IS part of DSL).        │
│                                                                         │
│  If BOTH match → No action needed, return                              │
│  If EITHER differs → Continue to coverage check                        │
└───────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌───────────────────────────────────────────────────────────────────────┐
│                     COVERAGE CACHE CHECK                               │
│                                                                         │
│  Cache key = graphHash | dslKey                                         │
│  (Window is part of DSL, no separate key needed)                        │
│                                                                         │
│  ┌─────────────────────┐     ┌─────────────────────────────────────┐  │
│  │  Cache HIT?         │ YES │ Use cached result:                   │  │
│  │  + graph unchanged  │────►│ - hasMissingData                     │  │
│  │                     │     │ - paramsToAggregate[]                │  │
│  └─────────────────────┘     └─────────────────────────────────────┘  │
│           │ NO                                                          │
│           ▼                                                             │
│  ┌─────────────────────────────────────────────────────────────────┐  │
│  │  COMPUTE COVERAGE:                                               │  │
│  │                                                                   │  │
│  │  For each edge.p, edge.cost_gbp, edge.cost_time:                │  │
│  │    1. Check if has connection (file or direct)                   │  │
│  │    2. If file exists:                                            │  │
│  │       - calculateIncrementalFetch() → needsFetch?               │  │
│  │       - If data complete → add to paramsToAggregate[]           │  │
│  │    3. If no file:                                                │  │
│  │       - Check if window matches lastAggregatedWindow             │  │
│  │       - If not → hasMissingData = true                          │  │
│  │                                                                   │  │
│  │  For each case node:                                              │  │
│  │    - Similar connection + file check                             │  │
│  │                                                                   │  │
│  │  Cache result for next time                                       │  │
│  └─────────────────────────────────────────────────────────────────┘  │
└───────────────────────────────────────────────────────────────────────┘
                                    │
                 ┌──────────────────┴──────────────────┐
                 ▼                                     ▼
┌──────────────────────────────┐       ┌──────────────────────────────┐
│    hasMissingData = TRUE     │       │    hasMissingData = FALSE    │
│                              │       │                              │
│  ┌────────────────────────┐  │       │  ┌────────────────────────┐  │
│  │  setNeedsFetch(true)   │  │       │  │  AUTO-AGGREGATE:       │  │
│  │                        │  │       │  │                        │  │
│  │  Show "Fetch" button   │  │       │  │  For each param in     │  │
│  │  with shimmer effect   │  │       │  │  paramsToAggregate:    │  │
│  │                        │  │       │  │    getParameterFrom    │  │
│  │  User clicks →         │  │       │  │    File() with DSL     │  │
│  │  useFetchData hook     │  │       │  │                        │  │
│  │  (versioned mode)      │  │       │  │  (calls service        │  │
│  └────────────────────────┘  │       │  │   directly, not hook)  │  │
│                              │       │  │                        │  │
│                              │       │  │  Graph updates          │  │
│                              │       │  │  automatically!         │  │
│                              │       │  └────────────────────────┘  │
└──────────────────────────────┘       └──────────────────────────────┘

NOTE: Both auto-aggregation AND the Fetch button now use the useFetchData hook.
Auto-aggregation uses `mode: 'from-file'` (no API call), while Fetch button
uses `mode: 'versioned'` (API → File → Graph). ONE CODE PATH for all fetches.
```

### Key State Variables

| Variable | Purpose |
|----------|---------|
| `lastAggregatedWindow` | Last window that was successfully aggregated (persisted) |
| `lastAggregatedDSL` | Last DSL (context) that was successfully aggregated |
| `needsFetch` | Whether Fetch button should be shown |
| `isAggregatingRef` | Prevents re-triggering during aggregation |
| `coverageCache` | Caches coverage results to avoid recomputing |

### Example Scenarios

**Scenario 1: Change window, all data in cache**
```
User: Changes window from Dec 1-7 to Dec 8-14
System: 
  1. Coverage check finds all params have data for Dec 8-14 in files
  2. hasMissingData = false
  3. Auto-aggregates all params for new window
  4. Graph updates immediately (no Fetch button shown)
```

**Scenario 2: Change window, some data missing**
```
User: Changes window from Dec 1-7 to Dec 15-21
System:
  1. Coverage check finds param-A missing Dec 15-21 data
  2. hasMissingData = true
  3. Shows Fetch button with shimmer
  4. User clicks Fetch → API called → file updated → graph updated
```

**Scenario 3: Change context only**
```
User: Changes from geo=UK to geo=US (same window)
System:
  1. DSL changed (lastAggregatedDSL !== currentDSL)
  2. Coverage check runs with new context
  3. If US data exists in files → auto-aggregate
  4. If US data missing → show Fetch button
```

### calculateIncrementalFetch Details

```
┌─────────────────────────────────────────────────────────────────────────┐
│                    calculateIncrementalFetch()                           │
│                                                                          │
│  Input:                                                                  │
│  - parameterFileData (values[], with time-series)                       │
│  - targetSlice (DSL with window + context)                              │
│    → Window parsed internally, context used for slice matching          │
│                                                                          │
│  Process:                                                                │
│  1. Find values[] entry matching targetSlice                            │
│  2. Extract dates from data[]                                           │
│  3. Compare to window dates:                                             │
│     - totalDays = count of days in window                               │
│     - daysAvailable = dates in file ∩ window                            │
│     - daysToFetch = window - daysAvailable                              │
│                                                                          │
│  Output:                                                                 │
│  {                                                                       │
│    needsFetch: daysToFetch.length > 0,                                  │
│    totalDays: 7,                                                         │
│    daysAvailable: 5,                                                     │
│    daysToFetch: 2,                                                       │
│    missingDates: ['2025-12-06', '2025-12-07'],                          │
│    coverage: 0.714  // 5/7                                               │
│  }                                                                       │
└─────────────────────────────────────────────────────────────────────────┘
```

## Key Invariants

1. **Single codepath**: All UI entry points use `useFetchData` hook
2. **DSL is single source of truth**: Window AND context are in the DSL string
   - `"window(1-Dec-25:7-Dec-25).context(geo=UK)"` contains everything
   - No separate `window` parameter - parsed from DSL when needed
3. **Query mastering**: Query strings mastered on graph, copied to file
4. **Override respect**: UpdateManager never overwrites `*_overridden` fields
5. **Slice isolation**: Each context gets its own `values[]` entry in file
6. **Auto-aggregate when possible**: If all data exists in files, aggregate automatically on window/context change
7. **Show Fetch only when needed**: Button only appears when data is missing from files

## Test Coverage

### Service Layer (Comprehensive)

The underlying `dataOperationsService` is extensively tested:

| Test File | Coverage |
|-----------|----------|
| `dataOperationsService.integration.test.ts` | Core getFromSource, getFromSourceDirect, getParameterFromFile |
| `versionedFetch.integration.test.ts` | Versioned fetch flow (API → File → Graph) |
| `versionedFetchFlow.e2e.test.ts` | Full E2E versioned fetch |
| `fetchButtonE2E.integration.test.tsx` | Fetch button behavior |
| `parameterCache.e2e.test.ts` | Cache and incremental fetch logic |
| `multiSliceCache.e2e.test.ts` | Multi-context slice isolation |
| `contextPassthrough.e2e.test.ts` | Context DSL passthrough |
| `fullE2EMultiSlice.integration.test.tsx` | Full multi-slice workflow |
| `windowAggregationService.test.ts` | Window aggregation and calculateIncrementalFetch |
| `sliceIsolation.test.ts` | Slice isolation behavior |

**Total: ~146 test cases across 13 files**

### Hook Layer

The `useFetchData` hook has dedicated tests in `src/hooks/__tests__/useFetchData.test.ts`:

| Test Category | Tests |
|---------------|-------|
| Mode routing | versioned/direct/from-file → correct service call (6 tests) |
| Node fallback | node type falls back to getNodeFromFile (2 tests) |
| Getter support | graph/DSL getters work for batch ops (2 tests) |
| Error handling | network error, no graph loaded (2 tests) |
| DSL fallback | empty DSL, default DSL generation (2 tests) |
| createFetchItem | parameter, case, node item creation (3 tests) |
| fetchItems batch | sequential processing, progress callback (2 tests) |

**Total: 19 tests for the hook**

