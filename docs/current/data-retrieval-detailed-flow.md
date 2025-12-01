# Data Retrieval: Detailed Flow Documentation

> Generated from current codebase state. This document traces **every step** from user action through to graph display.

## Overview: Single Unified Path

All data retrieval operations flow through a **single centralised hook**: `useFetchData`. This ensures consistent behaviour regardless of UI entry point.

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                          UI ENTRY POINTS                                     │
│  WindowSelector │ DataMenu │ BatchModal │ ContextMenus │ PropertiesPanel    │
└────────────────────────────────┬────────────────────────────────────────────┘
                                 │
                                 ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                         useFetchData HOOK                                    │
│  • fetchItem(item, { mode: 'versioned' | 'direct' | 'from-file' })          │
│  • fetchItems(items[], options)                                              │
│  • getItemsNeedingFetch(window)                                              │
│  • itemNeedsFetch(item, window)                                              │
└────────────────────────────────┬────────────────────────────────────────────┘
                                 │
                                 ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                      dataOperationsService                                   │
│  • getFromSource()       → Versioned: API → File → Graph                    │
│  • getFromSourceDirect() → Direct: API → Graph (daily mode optional)        │
│  • getParameterFromFile()→ From File: File → Graph                          │
│  • getCaseFromFile()     → From File: File → Graph                          │
│  • getNodeFromFile()     → From File: File → Graph                          │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## Part 1: UI Entry Points → Hook

### All Entry Points (Confirmed Unified)

| Component | File | Hook Usage |
|-----------|------|------------|
| WindowSelector | `components/WindowSelector.tsx` | `useFetchData` for Fetch button + auto-aggregation |
| DataMenu | `components/MenuBar/DataMenu.tsx` | `useFetchData` for section-level fetches |
| BatchOperationsModal | `components/modals/BatchOperationsModal.tsx` | `useFetchData` for batch operations |
| EdgeContextMenu | `components/EdgeContextMenu.tsx` | `useFetchData` for edge param fetches |
| NodeContextMenu | `components/NodeContextMenu.tsx` | `useFetchData` for node/case fetches |
| DataOperationsMenu | `components/DataOperationsMenu.tsx` | `useFetchData` for lightning menu |
| PropertiesPanel | `components/PropertiesPanel.tsx` | `useFetchData` for individual param fetches |
| EnhancedSelector | `components/EnhancedSelector.tsx` | `useFetchData` for auto-get on selection |

### Example: WindowSelector Fetch Button Click

```
User clicks "Fetch" button
         │
         ▼
WindowSelector.tsx:
  fetchItems(batchItemsToFetch, { mode: 'versioned' })
         │
         ▼
useFetchData.ts:
  for each item in items:
    fetchItem(item, { mode: 'versioned' })
         │
         ▼
  mode === 'versioned' → dataOperationsService.getFromSource(...)
```

---

## Part 2: useFetchData Hook Internals

### Location: `src/hooks/useFetchData.ts`

### Hook Initialisation
```typescript
const { fetchItem, fetchItems, getItemsNeedingFetch } = useFetchData({
  graph: graphOrGetter,      // Graph or getter function for batch ops
  setGraph: setGraph,         // State setter for graph updates
  currentDSL: dslOrGetter,    // DSL string or getter (e.g., "window(1-Dec-25:7-Dec-25)")
});
```

### FetchItem Structure
```typescript
interface FetchItem {
  id: string;                           // Unique ID for tracking
  type: 'parameter' | 'case' | 'node';  // Object type
  name: string;                          // Display name
  objectId: string;                      // File ID (e.g., "my-param-id")
  targetId: string;                      // Edge/Node UUID on graph
  paramSlot?: 'p' | 'cost_gbp' | 'cost_time';  // For parameters
  conditionalIndex?: number;             // For conditional_p entries
}
```

### FetchOptions
```typescript
interface FetchOptions {
  mode?: 'versioned' | 'direct' | 'from-file';  // Default: 'versioned'
  bustCache?: boolean;              // Ignore cache, refetch all dates
  setAutoUpdating?: (boolean) => void;  // Animation callback
}
```

### Mode Routing Logic (fetchItem)

```
fetchItem(item, { mode })
         │
         ├── mode === 'from-file'
         │   ├── type === 'parameter' → getParameterFromFile()
         │   ├── type === 'case'      → getCaseFromFile()
         │   └── type === 'node'      → getNodeFromFile()
         │
         ├── mode === 'direct'
         │   ├── type === 'node'      → getNodeFromFile()  (fallback)
         │   └── type !== 'node'      → getFromSourceDirect()
         │
         └── mode === 'versioned' (default)
             ├── type === 'node'      → getNodeFromFile()  (no API)
             └── type !== 'node'      → getFromSource()
```

---

## Part 3: Service Layer Detail

### Location: `src/services/dataOperationsService.ts`

---

### 3.1 VERSIONED PATH: getFromSource()

**Purpose**: Fetch from external API, store in file, then apply to graph.

```
getFromSource(options)
         │
         ├── objectType === 'parameter'
         │   │
         │   ▼
         │   getFromSourceDirect({ dailyMode: true, ... })
         │           │
         │           ▼
         │   [Internally calls getParameterFromFile() after write]
         │
         └── objectType === 'case'
             │
             ▼
             getFromSourceDirect({ versionedCase: true, ... })
                     │
                     ▼
             getCaseFromFile()  [Apply windowed aggregation]
```

### 3.2 DIRECT PATH: getFromSourceDirect()

**Purpose**: Fetch from external API, optionally write to file, apply to graph.

```
getFromSourceDirect(options)
         │
         ├─── Step 1: RESOLVE CONNECTION
         │    ├── Check parameter/case/node FILE for connection
         │    └── Fallback to edge/node connection on graph
         │
         ├─── Step 2: BUILD QUERY (if parameter)
         │    ├── Parse edge.query (or conditional_p[idx].query)
         │    ├── Merge with graph.currentQueryDSL (window, context)
         │    └── Call buildDslFromEdge() to resolve event IDs
         │
         ├─── Step 3: DUAL QUERY CHECK (for conditional probabilities)
         │    ├── Detect explicit n_query on edge
         │    ├── OR detect visited_upstream in query
         │    └── Build separate baseQueryPayload for denominator (n)
         │
         ├─── Step 4: INCREMENTAL FETCH CHECK
         │    ├── calculateIncrementalFetch(paramData, window, signature, bustCache, slice)
         │    ├── Returns: { needsFetch, missingDates[], windowsToFetch[] }
         │    └── If all dates cached, skip API call
         │
         ├─── Step 5: CALL DAS (if needsFetch)
         │    ├── createDASRunner()
         │    ├── runner.run({ connection, query, eventDefinitions })
         │    │
         │    ├─── COMPOSITE QUERY HANDLING:
         │    │    ├── Detect minus()/plus() in query
         │    │    ├── Execute sub-queries via CompositeQueryExecutor
         │    │    └── Combine results with arithmetic
         │    │
         │    └── Returns: { n, k, mean, stdev, daily_data[], etc. }
         │
         ├─── Step 6: WRITE TO FILE (if dailyMode)
         │    ├── mergeTimeSeriesIntoParameter(existingData, newDaily, slice)
         │    ├── Add query_signature for staleness tracking
         │    ├── Add sliceDSL for context isolation
         │    └── fileRegistry.setFile() + markDirty()
         │
         └─── Step 7: APPLY TO GRAPH
              ├── getParameterFromFile() [if dailyMode]
              └── OR UpdateManager.handleExternalToGraph() [if direct apply]
```

### 3.3 FROM-FILE PATH: getParameterFromFile()

**Purpose**: Read from file, aggregate for window, apply to graph.

```
getParameterFromFile(options)
         │
         ├─── Step 1: PARSE WINDOW FROM DSL
         │    └── parseConstraints(targetSlice) → { window: { start, end } }
         │
         ├─── Step 2: LOAD FILE
         │    └── fileRegistry.getFile(`parameter-${paramId}`)
         │
         ├─── Step 3: SLICE ISOLATION
         │    ├── isolateSlice(values, targetSlice)
         │    └── Filter values[] to only those matching sliceDSL
         │
         ├─── Step 4: SIGNATURE VALIDATION
         │    ├── Compare cached query_signature vs current
         │    └── Warn if stale signatures found
         │
         ├─── Step 5: WINDOW AGGREGATION
         │    ├── windowAggregationService.aggregateWindow()
         │    ├── Sum n_daily/k_daily arrays for date range
         │    ├── Compute mean = k/n
         │    └── Compute stdev from wilson_interval or beta
         │
         ├─── Step 6: STATISTICAL ENHANCEMENT
         │    └── statisticalEnhancementService.enhanceParameter()
         │
         └─── Step 7: APPLY TO GRAPH
              ├── UpdateManager.handleFileToGraph()
              ├── Respects override flags (mean_overridden, stdev_overridden)
              ├── Applies evidence metadata (window_from, window_to)
              └── setGraph(updatedGraph)
```

---

## Part 4: Key Sub-systems

### 4.1 Query Building: buildDslFromEdge()

**Location**: `src/lib/das/buildDslFromEdge.ts`

```
buildDslFromEdge(edge, graph, provider, eventLoader, constraints)
         │
         ├─── Parse edge.query: "from(A).to(B).visited(C)"
         │
         ├─── Resolve node IDs to event IDs:
         │    ├── graph.nodes.find(id === 'A') → node.event_id → 'amplitude_event_1'
         │    └── eventLoader('amplitude_event_1') → event file data
         │
         ├─── Build query payload:
         │    {
         │      from: 'amplitude_event_1',
         │      to: 'amplitude_event_2',
         │      visited: ['amplitude_event_3'],
         │      context_filters: [...],  // From constraints.context
         │      start: '2025-12-01',     // From constraints.window
         │      end: '2025-12-07',
         │    }
         │
         └─── Return { queryPayload, eventDefinitions }
```

### 4.2 Incremental Fetch: calculateIncrementalFetch()

**Location**: `src/services/windowAggregationService.ts`

```
calculateIncrementalFetch(paramData, window, signature, bustCache, slice)
         │
         ├─── If bustCache → return needsFetch: true
         │
         ├─── Filter values[] by slice (sliceDSL match)
         │
         ├─── Filter values[] by signature (query_signature match)
         │
         ├─── Extract all cached dates from values[].dates
         │
         ├─── Generate requested date range
         │
         ├─── Find missing dates = requested - cached
         │
         └─── Return {
                needsFetch: missingDates.length > 0,
                missingDates: ['1-Dec-25', '2-Dec-25'],
                windowsToFetch: [{ start, end }],
              }
```

### 4.3 Window Aggregation: aggregateWindow()

**Location**: `src/services/windowAggregationService.ts`

```
aggregateWindow(paramData.values, window, sliceDSL)
         │
         ├─── Filter values[] by sliceDSL
         │
         ├─── For each value entry with n_daily/k_daily:
         │    ├── Filter to dates within window.start..window.end
         │    ├── Sum n values
         │    └── Sum k values
         │
         ├─── Aggregate across all matching entries:
         │    total_n = Σ(n_daily in range)
         │    total_k = Σ(k_daily in range)
         │
         ├─── Compute statistics:
         │    mean = total_k / total_n
         │    stdev = compute from beta distribution or wilson interval
         │
         └─── Return {
                mean, stdev, n: total_n, k: total_k,
                window: { start, end },
                coverage: { is_complete, message },
              }
```

### 4.4 Slice Isolation: isolateSlice()

**Location**: `src/services/sliceIsolation.ts`

```
isolateSlice(values, targetSlice)
         │
         ├─── Parse targetSlice → { context: [{ key, value }], window }
         │
         ├─── Extract slice dimensions from targetSlice
         │
         ├─── For each value in values[]:
         │    ├── Parse value.sliceDSL → { context, window }
         │    ├── Check if dimensions match targetSlice dimensions
         │    └── Include if match OR if value has no sliceDSL (legacy)
         │
         └─── Return filtered values[]
```

### 4.5 UpdateManager: Graph Application

**Location**: `src/services/UpdateManager.ts`

```
UpdateManager.handleFileToGraph(fileData, targetEdge, 'UPDATE', 'parameter')
         │
         ├─── Build mapping rules based on parameter type
         │
         ├─── For each field (mean, stdev, n, k):
         │    ├─── Check if edge.p[field_overridden] === true
         │    ├─── If overridden → SKIP (preserve user edit)
         │    └─── If not overridden → map file value to edge
         │
         ├─── Apply evidence metadata:
         │    edge.p.evidence = {
         │      window_from: '1-Dec-25',
         │      window_to: '7-Dec-25',
         │      retrieved_at: ISO timestamp,
         │    }
         │
         └─── Return { success, changes[], conflicts[] }
```

---

## Part 5: Complete Trace - Versioned Fetch

**Scenario**: User clicks Fetch in WindowSelector, DSL = "window(1-Dec-25:7-Dec-25).context(geo=UK)"

```
1. WindowSelector.tsx
   │  fetchItems(batchItemsToFetch, { mode: 'versioned' })
   │  └── batchItemsToFetch = [
   │        { type: 'parameter', objectId: 'my-param', targetId: 'edge-uuid-1', paramSlot: 'p' },
   │        { type: 'case', objectId: 'my-case', targetId: 'node-uuid-1' },
   │      ]
   │
2. useFetchData.fetchItems()
   │  for each item:
   │    fetchItem(item, { mode: 'versioned' })
   │
3. useFetchData.fetchItem()
   │  mode === 'versioned', type === 'parameter'
   │  → dataOperationsService.getFromSource({
   │      objectType: 'parameter',
   │      objectId: 'my-param',
   │      targetId: 'edge-uuid-1',
   │      graph: currentGraph,
   │      setGraph: setGraph,
   │      paramSlot: 'p',
   │      currentDSL: 'window(1-Dec-25:7-Dec-25).context(geo=UK)',
   │      targetSlice: 'window(1-Dec-25:7-Dec-25).context(geo=UK)',
   │    })
   │
4. dataOperationsService.getFromSource()
   │  objectType === 'parameter'
   │  → getFromSourceDirect({
   │      dailyMode: true,  // Enables file write + incremental fetch
   │      ...same options
   │    })
   │
5. dataOperationsService.getFromSourceDirect()
   │
   ├── 5a. Resolve connection
   │   │  fileRegistry.getFile('parameter-my-param')
   │   │  → connection = 'amplitude'
   │   │  → connectionString = { ... }
   │
   ├── 5b. Build query
   │   │  buildDslFromEdge(edge, graph, 'amplitude', eventLoader, constraints)
   │   │  → queryPayload = {
   │   │      from: 'event_signup_started',
   │   │      to: 'event_signup_completed',
   │   │      start: '2025-12-01',
   │   │      end: '2025-12-07',
   │   │      context_filters: [{ property: 'geo', value: 'UK' }],
   │   │    }
   │
   ├── 5c. Check incremental fetch
   │   │  calculateIncrementalFetch(paramData, window, signature, false, slice)
   │   │  → { needsFetch: true, missingDates: ['1-Dec-25', '2-Dec-25'] }
   │
   ├── 5d. Execute DAS query
   │   │  runner.run({ connection: 'amplitude', query: queryPayload })
   │   │  → HTTP POST to Amplitude API
   │   │  → Response: {
   │   │      n: 1000, k: 450,
   │   │      daily_data: [
   │   │        { date: '1-Dec-25', n: 150, k: 68 },
   │   │        { date: '2-Dec-25', n: 142, k: 65 },
   │   │        ...
   │   │      ]
   │   │    }
   │
   ├── 5e. Write to file
   │   │  mergeTimeSeriesIntoParameter(existingData, newDaily, sliceDSL)
   │   │  → values.push({
   │   │      n_daily: [150, 142, ...],
   │   │      k_daily: [68, 65, ...],
   │   │      dates: ['1-Dec-25', '2-Dec-25', ...],
   │   │      sliceDSL: 'window(1-Dec-25:7-Dec-25).context(geo=UK)',
   │   │      query_signature: 'abc123...',
   │   │    })
   │   │  fileRegistry.setFile('parameter-my-param', updatedData)
   │   │  markDirty()
   │
   └── 5f. Apply to graph
       │  getParameterFromFile({
       │    paramId: 'my-param',
       │    edgeId: 'edge-uuid-1',
       │    graph: currentGraph,
       │    setGraph: trackingSetGraph,
       │    targetSlice: 'window(1-Dec-25:7-Dec-25).context(geo=UK)',
       │  })
       │
       ├── Parse window from DSL
       │
       ├── Load file + slice isolation
       │   │  isolateSlice(values, targetSlice)
       │   │  → Only values where sliceDSL matches context(geo=UK)
       │
       ├── Aggregate for window
       │   │  aggregateWindow(filteredValues, window)
       │   │  → { mean: 0.452, stdev: 0.016, n: 1000, k: 452 }
       │
       ├── Apply to edge
       │   │  UpdateManager.handleFileToGraph(aggregated, edge, 'UPDATE', 'parameter')
       │   │  → edge.p.mean = 0.452  (if not mean_overridden)
       │   │  → edge.p.stdev = 0.016 (if not stdev_overridden)
       │   │  → edge.p.evidence = { window_from: '1-Dec-25', window_to: '7-Dec-25' }
       │
       └── Update graph
           │  setGraph(updatedGraph)
           │  → React re-renders with new edge.p values
```

---

## Part 6: Data Storage Format

### Parameter File (YAML in IndexedDB)

```yaml
id: my-param
type: probability
connection: amplitude
connection_string: '{"api_key": "...", "secret_key": "..."}'
query: "from(signup_started).to(signup_completed)"  # Copied from edge

values:
  - sliceDSL: "window(1-Dec-25:7-Dec-25).context(geo=UK)"
    query_signature: "abc123..."
    n_daily: [150, 142, 155, 148, 160, 145, 100]
    k_daily: [68, 65, 71, 67, 73, 66, 42]
    dates: ["1-Dec-25", "2-Dec-25", "3-Dec-25", "4-Dec-25", "5-Dec-25", "6-Dec-25", "7-Dec-25"]
    window_from: "1-Dec-25"
    window_to: "7-Dec-25"
    data_source:
      retrieved_at: "2025-12-07T14:30:00.000Z"
      connection: amplitude
```

### Graph Edge Parameter

```typescript
edge.p = {
  id: 'my-param',
  mean: 0.452,
  stdev: 0.016,
  n: 1000,
  k: 452,
  connection: 'amplitude',
  mean_overridden: false,
  stdev_overridden: false,
  evidence: {
    window_from: '1-Dec-25',
    window_to: '7-Dec-25',
    retrieved_at: '2025-12-07T14:30:00.000Z',
  },
}
```

---

## Part 7: Legacy Code Review

### Confirmed: No Duplicate Code Paths

| Code Path | Status | Notes |
|-----------|--------|-------|
| WindowSelector.fetchItems | ✅ Uses hook | Via `useFetchData.fetchItems()` |
| WindowSelector auto-aggregation | ✅ Uses hook | Via `useFetchData.fetchItems({ mode: 'from-file' })` |
| DataMenu section fetches | ✅ Uses hook | Via `useFetchData.fetchItem()` |
| BatchOperationsModal | ✅ Uses hook | Via `useFetchData.fetchItem()` |
| EdgeContextMenu | ✅ Uses hook | Via `useFetchData.fetchItem()` |
| NodeContextMenu | ✅ Uses hook | Via `useFetchData.fetchItem()` |
| DataOperationsMenu | ✅ Uses hook | Via `useFetchData.fetchItem()` |
| PropertiesPanel | ✅ Uses hook | Via `useFetchData.fetchItem()` |
| EnhancedSelector | ✅ Uses hook | Via `useFetchData.fetchItem()` |

### Potential Legacy to Watch

1. **`batchGetFromSource()`** in dataOperationsService - Still exists but only used internally by the hook
2. **Direct service calls** - All migrated to hook; grep confirms no direct `dataOperationsService.getFromSource` calls from UI components

---

## Part 8: Date Format Standards

All dates in UI and files use **d-MMM-yy** format:
- `1-Dec-25` (not `2025-12-01`)
- `15-Jan-24` (not `2024-01-15`)

ISO format (`YYYY-MM-DD`) only at API boundaries, immediately converted.

Utility functions in `src/lib/dateFormat.ts`:
- `formatDateUK(date)` → `'1-Dec-25'`
- `parseUKDate(str)` → `Date` (UTC)
- `normalizeToUK(str)` → Always outputs `d-MMM-yy`

---

## Appendix: File Locations

| Component | Path |
|-----------|------|
| useFetchData hook | `src/hooks/useFetchData.ts` |
| dataOperationsService | `src/services/dataOperationsService.ts` |
| windowAggregationService | `src/services/windowAggregationService.ts` |
| sliceIsolation | `src/services/sliceIsolation.ts` |
| UpdateManager | `src/services/UpdateManager.ts` |
| buildDslFromEdge | `src/lib/das/buildDslFromEdge.ts` |
| dateFormat utilities | `src/lib/dateFormat.ts` |
| queryDSL parser | `src/lib/queryDSL.ts` |

