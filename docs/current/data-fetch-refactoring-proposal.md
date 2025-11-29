# Data Fetch Architecture Refactoring Proposal

**Status**: Proposed  
**Date**: 2024-11-29  
**Author**: AI Assistant  
**Priority**: High (maintainability blocker)

## Problem Statement

The current data fetching architecture has **10+ UI entry points** calling **3 different service methods** with inconsistent parameter handling. This has caused numerous bugs:

1. **Stale closures** in batch operations (rebalancing lost)
2. **Missing `targetSlice`** causing wrong data to be loaded
3. **Missing `currentDSL`** causing fetches with stale window
4. **Timezone bugs** from duplicate parsing functions
5. **Missing `type` field** causing UpdateManager conditions to fail
6. **Double-updates** from redundant internal calls

Each bug required fixing in 7+ locations because the same logic is duplicated across:
- `WindowSelector.handleFetchData()`
- `BatchOperationsModal` (3 different operation types)
- `AllSlicesModal`
- `EdgeContextMenu` (multiple handlers)
- `NodeContextMenu`
- `DataOperationsMenu`
- `DataMenu`
- `PropertiesPanel`
- `EnhancedSelector`

## Current Architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│  UI COMPONENTS (10+ entry points, each with its own fetch logic)           │
├─────────────────────────────────────────────────────────────────────────────┤
│  WindowSelector.handleFetchData()     → getFromSource()                     │
│  BatchOperationsModal                 → getFromSource() / getFromSourceDirect() / getParameterFromFile() │
│  AllSlicesModal                       → getFromSource()                     │
│  EdgeContextMenu                      → getFromSource() / getFromSourceDirect() / getParameterFromFile() │
│  NodeContextMenu                      → getFromSource()                     │
│  DataOperationsMenu                   → getFromSource() / getFromSourceDirect()│
│  DataMenu                             → getParameterFromFile()              │
│  PropertiesPanel                      → getParameterFromFile()              │
│  EnhancedSelector                     → getParameterFromFile()              │
└──────────────────────────────────┬──────────────────────────────────────────┘
                                   │
                                   ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│  dataOperationsService.ts (4000+ lines, 3 overlapping methods)              │
├─────────────────────────────────────────────────────────────────────────────┤
│  getFromSource()           ─────────▶ getFromSourceDirect() ───────┐        │
│       │                                     │                      │        │
│       │                                     ▼                      │        │
│       │                           getParameterFromFile() ◀─────────┘        │
│       │                                     │                               │
│       ▼                                     ▼                               │
│  [Sometimes calls getParameterFromFile() AGAIN - double update!]            │
└─────────────────────────────────────────────────────────────────────────────┘
                                   │
                                   ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│  UpdateManager.handleFileToGraph()                                          │
│  - Applies changes to graph edges                                           │
│  - Triggers rebalancing                                                     │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Problems with Current Architecture

| Problem | Impact | Root Cause |
|---------|--------|------------|
| Stale closures | Rebalancing lost in batch operations | Graph state captured at loop start, not updated |
| Missing parameters | Wrong data loaded/fetched | Each call site must remember to pass `targetSlice`, `currentDSL`, etc. |
| Double updates | Race conditions, state corruption | `getFromSource` calls `getParameterFromFile` after `getFromSourceDirect` already did |
| Inconsistent error handling | Some paths toast, some throw, some silently fail | No unified error handling |
| Difficult to test | Mocking requires understanding internal call chains | Logic spread across 3 methods |
| Hard to add features | Must update 10+ locations | No single entry point |

## Proposed Architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│  UI COMPONENTS (thin wrappers - NO fetch logic)                             │
├─────────────────────────────────────────────────────────────────────────────┤
│  All components use hooks:                                                  │
│    const { fetch, isLoading, error } = useFetchParameter(paramId, edgeId)   │
│    const { fetchAll, progress } = useBatchFetch(items)                      │
└──────────────────────────────────┬──────────────────────────────────────────┘
                                   │
                                   ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│  HOOKS LAYER (hooks/useDataFetch.ts)                                        │
├─────────────────────────────────────────────────────────────────────────────┤
│  useFetchParameter({ paramId, edgeId, options })                            │
│  useFetchCase({ caseId, nodeId, options })                                  │
│  useFetchNode({ nodeId, options })                                          │
│  useBatchFetch({ items, options })                                          │
│                                                                             │
│  Responsibilities:                                                          │
│    - Get graph/setGraph from GraphStoreContext                              │
│    - Build currentDSL from WindowSelector state                             │
│    - Manage loading/error state                                             │
│    - Show toasts                                                            │
│    - Handle abort for batch operations                                      │
└──────────────────────────────────┬──────────────────────────────────────────┘
                                   │
                                   ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│  dataFetchService.ts (NEW - single entry point)                             │
├─────────────────────────────────────────────────────────────────────────────┤
│  fetchParameter({                                                           │
│    paramId: string,                                                         │
│    edgeId: string,                                                          │
│    graph: Graph,                                                            │
│    setGraph: (g: Graph) => void,                                            │
│    mode: 'versioned' | 'direct' | 'file-only',                              │
│    currentDSL: string,           // REQUIRED - no fallback to graph state   │
│    options?: {                                                              │
│      bustCache?: boolean,                                                   │
│      paramSlot?: 'p' | 'cost_gbp' | 'cost_time',                            │
│      conditionalIndex?: number,                                             │
│    }                                                                        │
│  }): Promise<FetchResult>                                                   │
│                                                                             │
│  fetchCase({ ... }): Promise<FetchResult>                                   │
│  fetchNode({ ... }): Promise<FetchResult>                                   │
│  batchFetch({ items, ... }): AsyncGenerator<BatchProgress>                  │
└──────────────────────────────────┬──────────────────────────────────────────┘
                                   │
                                   ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│  INTERNAL MODULES (private, not exported)                                   │
├─────────────────────────────────────────────────────────────────────────────┤
│  fetchFromSource.ts     - DAS runner execution, API calls                   │
│  parameterFileOps.ts    - Read/write parameter files, daily data merge      │
│  graphUpdater.ts        - Single point for graph mutations + rebalancing    │
│  cacheManager.ts        - Incremental fetch logic, bust cache               │
│  dslParser.ts           - Parse DSL, extract window/context (SINGLE impl)   │
└─────────────────────────────────────────────────────────────────────────────┘
```

## Key Design Principles

### 1. DSL is Always Explicit

**Current (Bad)**:
```typescript
// Some paths read from graph, some use parameter, some default to 7 days
const effectiveDSL = currentDSL || graph?.currentQueryDSL || '';
```

**Proposed (Good)**:
```typescript
// Caller MUST provide DSL - no hidden fallbacks
fetchParameter({ ..., currentDSL: 'window(1-Oct-25:31-Oct-25).context(channel:google)' })
```

### 2. Single Graph Update Point

**Current (Bad)**:
```typescript
// getFromSourceDirect updates graph
// Then getParameterFromFile updates graph AGAIN
// Then rebalancing happens (maybe)
```

**Proposed (Good)**:
```typescript
// graphUpdater.ts is the ONLY place that calls setGraph
// Rebalancing always happens as part of applyChanges()
function applyChanges(graph, changes, setGraph) {
  const updated = applyMappings(graph, changes);
  const rebalanced = rebalanceSiblings(updated);
  setGraph(rebalanced);
}
```

### 3. Mode Parameter Instead of 3 Methods

**Current (Bad)**:
```typescript
// UI must know which method to call
await getFromSource({ ... });        // versioned (file-backed)
await getFromSourceDirect({ ... });  // direct to graph
await getParameterFromFile({ ... }); // file to graph only
```

**Proposed (Good)**:
```typescript
// Single method, mode parameter
await fetchParameter({ ..., mode: 'versioned' });  // fetch → file → graph
await fetchParameter({ ..., mode: 'direct' });     // fetch → graph
await fetchParameter({ ..., mode: 'file-only' });  // file → graph
```

### 4. Background Fetches (No Graph Update)

A key design goal is supporting **background data retrieval** that writes to files without touching the graph. This is enabled by making `setGraph` optional:

**Use cases:**
- Pre-fetching data for adjacent time windows
- Speculative fetches based on predicted user navigation
- Nightly runner batch operations
- Deferred batch updates (fetch many, apply once)

**Pattern:**
```typescript
// Background fetch - data goes to file only
const result = await dataFetchService.fetchParameter({
  paramId: 'my-param',
  edgeId: 'edge-123',
  graph,                    // Needed for context
  currentDSL: 'window(1-Nov-25:30-Nov-25)',
  mode: 'versioned',
  // setGraph OMITTED - no graph mutation
});

// Later, when user navigates to that window:
await dataFetchService.fetchParameter({
  ...sameOptions,
  setGraph,                 // Now provided - pulls from file → graph
  mode: 'file-only',        // Just apply cached data
});
```

### 5. Hooks for UI Components

Hooks are the primary interface for UI components. They always update the graph.

**Current (Bad)**:
```typescript
// WindowSelector.tsx - 50+ lines of fetch logic
const handleFetchData = async () => {
  const items = collectItems(graph);
  for (const item of items) {
    if (item.type === 'parameter') {
      await dataOperationsService.getFromSource({
        objectType: 'parameter',
        objectId: item.objectId,
        targetId: item.targetId,
        graph,
        setGraph,
        paramSlot: item.paramSlot,
        currentDSL: effectiveDSL,
        targetSlice: effectiveDSL,
      });
    } else if (item.type === 'case') {
      // ... duplicate logic
    }
  }
  // ... error handling, toast, etc.
};
```

**Proposed (Good)**:
```typescript
// WindowSelector.tsx - 3 lines
const { fetchMissing, isLoading } = useFetchMissing();
const handleFetchData = () => fetchMissing({ bustCache: false });
```

## Implementation Plan

### Phase 1: Create New Service (Non-Breaking)

1. Create `src/services/dataFetchService.ts` with new API
2. Create `src/hooks/useDataFetch.ts` with hooks
3. New code calls new service; old code unchanged
4. Add comprehensive tests for new service

### Phase 2: Migrate One Component

1. Update `WindowSelector` to use new hooks
2. Test thoroughly (this is the most complex case)
3. Verify no regressions

### Phase 3: Migrate Remaining Components

1. Update components one by one:
   - `BatchOperationsModal`
   - `AllSlicesModal`
   - `EdgeContextMenu`
   - `NodeContextMenu`
   - `DataOperationsMenu`
   - `DataMenu`
   - `PropertiesPanel`
   - `EnhancedSelector`
2. Each migration is a separate PR

### Phase 4: Cleanup

1. Remove old methods from `dataOperationsService.ts`
2. Delete unused code paths
3. Update documentation

## API Reference (Draft)

### fetchParameter

```typescript
interface FetchParameterOptions {
  paramId: string;
  edgeId: string;
  graph: Graph;                    // REQUIRED - provides context (edges, params, DSL)
  currentDSL: string;              // REQUIRED - no fallback to graph state
  mode: 'versioned' | 'direct' | 'file-only';
  
  // Graph mutation is OPTIONAL - omit for background/speculative fetches
  setGraph?: (g: Graph) => void;   // If omitted, fetches to file only (graph unchanged)
  
  bustCache?: boolean;
  paramSlot?: 'p' | 'cost_gbp' | 'cost_time';
  conditionalIndex?: number;
  signal?: AbortSignal;
}

interface FetchResult {
  success: boolean;
  changes: Change[];               // Always returned - what WOULD be applied to graph
  fetchedData?: ParameterValue;    // The actual data retrieved (for inspection)
  source: 'api' | 'cache' | 'file';
  window?: { start: string; end: string };
  error?: Error;
}

async function fetchParameter(options: FetchParameterOptions): Promise<FetchResult>
```

**Behavior:**
- If `setGraph` provided → fetches data, writes to file, updates graph
- If `setGraph` omitted → fetches data, writes to file, returns changes without applying

This enables background pre-fetching, speculative fetches, and deferred graph updates.

### useFetchParameter

Hooks always update the graph (they get `graph`/`setGraph` from context). For background fetches that don't update the graph, call `dataFetchService.fetchParameter()` directly without `setGraph`.

```typescript
interface UseFetchParameterOptions {
  paramId: string;
  edgeId: string;
  paramSlot?: 'p' | 'cost_gbp' | 'cost_time';
}

interface UseFetchParameterResult {
  fetch: (mode: 'versioned' | 'direct' | 'file-only', bustCache?: boolean) => Promise<FetchResult>;
  isLoading: boolean;
  error: Error | null;
  lastResult: FetchResult | null;
}

function useFetchParameter(options: UseFetchParameterOptions): UseFetchParameterResult
```

### useBatchFetch

```typescript
interface BatchItem {
  type: 'parameter' | 'case' | 'node';
  objectId: string;
  targetId: string;
  paramSlot?: string;
}

interface BatchProgress {
  total: number;
  completed: number;
  current: BatchItem;
  results: FetchResult[];
}

interface UseBatchFetchResult {
  fetchAll: (items: BatchItem[], mode: string, bustCache?: boolean) => Promise<FetchResult[]>;
  progress: BatchProgress | null;
  isLoading: boolean;
  abort: () => void;
}

function useBatchFetch(): UseBatchFetchResult
```

## Testing Strategy

### Unit Tests (New Service)

- `fetchParameter` with each mode
- Cache hit/miss logic
- Error handling for each failure mode
- DSL parsing (single implementation)

### Integration Tests

- Full flow: UI → hook → service → DAS → file → graph
- Batch operations with abort
- Rebalancing after updates
- Context slice isolation

### Migration Tests

- Before/after comparison for each component
- Ensure identical behavior during migration
- Performance benchmarks

## Risks and Mitigations

| Risk | Mitigation |
|------|------------|
| Breaking existing functionality | Phased migration, old code remains until fully tested |
| Performance regression | Benchmark before/after, optimize hot paths |
| Incomplete migration | Track all call sites, automated grep checks |
| New bugs in new code | Comprehensive test suite before migration |

## Success Criteria

1. **Single entry point**: All parameter fetches go through `fetchParameter()`
2. **No duplicate DSL parsing**: One `parseConstraints` function
3. **No stale closures**: Hooks manage state correctly
4. **Testable**: New service has 90%+ test coverage
5. **Maintainable**: Adding a new fetch mode requires changes in ONE file

## Appendix: Current Call Sites

```bash
# Count of direct service calls in UI components
grep -r "getFromSource\|getFromSourceDirect\|getParameterFromFile" src/components --include="*.tsx" | wc -l
# Result: 137 references across 19 files
```

All of these should be replaced with hook calls after refactoring.

