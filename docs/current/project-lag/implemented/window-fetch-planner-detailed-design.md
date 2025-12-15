# Window Fetch Planner – Detailed Design

**Date:** 9-Dec-25  
**Status:** Draft  
**Parent:** `window-fetch-planner-service.md` (high-level design)

---

## 1. Document Purpose

This document maps the high-level Window Fetch Planner design to concrete code structures, files, types, and implementation details. It is intended as a development reference rather than a product specification.

---

## 2. New Files and Modules

### 2.1 Core Planner Service

**File:** `graph-editor/src/services/windowFetchPlannerService.ts`

This is the primary new file. It exports:

- `WindowFetchPlannerService` class (singleton pattern matching existing services)
- Type definitions for planner inputs, results, and item classifications
- Helper functions for staleness analysis (coverage is delegated to existing services)

### 2.2 Supporting Types

Types will be co-located in the service file. Major type definitions:

```typescript
/** Outcome state for UI rendering */
export type FetchOutcome = 
  | 'covered_stable'      // All fetchable items covered and mature
  | 'not_covered'         // At least one fetchable item has gaps
  | 'covered_stale';      // Covered but refresh recommended

/** Classification of a single item */
export interface PlannerItem {
  id: string;                           // Unique item ID (matches FetchItem.id pattern)
  type: 'parameter' | 'case';
  objectId: string;                     // Parameter or case file ID
  targetId: string;                     // Edge UUID or node UUID
  paramSlot?: 'p' | 'cost_gbp' | 'labour_cost';
  conditionalIndex?: number;
  
  /** Item classification */
  classification: 
    | 'covered_stable'    // Fully covered, mature, no action needed
    | 'needs_fetch'       // Missing coverage, requires fetch from source
    | 'stale_candidate'   // Covered but immature cohorts may have matured
    | 'file_only_gap';    // Has local data but no connection, cannot be fetched
  
  /** For needs_fetch: number of missing dates */
  missingDates?: number;
  
  /** For stale_candidate: reason for staleness */
  stalenessReason?: string;
  
  /** For stale_candidate: retrieval timestamp of existing data */
  retrievedAt?: string;
  
  /** For latency items: t95 or path_t95 used in staleness test */
  effectiveT95?: number;
}

/** Analysis trigger context for logging */
export type AnalysisTrigger = 'initial_load' | 'dsl_change' | 'user_refresh' | 'post_fetch';

/** Full planner analysis result */
export interface PlannerResult {
  /** Analysis status */
  status: 'pending' | 'complete' | 'error';
  
  /** Error message if status is 'error' */
  error?: string;
  
  /** Derived outcome state */
  outcome: FetchOutcome;
  
  /** Items that can be auto-aggregated from cache */
  autoAggregationItems: PlannerItem[];
  
  /** Items that need fetching from source */
  fetchPlanItems: PlannerItem[];
  
  /** Items that are covered but potentially stale */
  staleCandidates: PlannerItem[];
  
  /** Items with gaps that cannot be fixed (no connection) */
  unfetchableGaps: PlannerItem[];
  
  /** Pre-computed message summaries */
  summaries: {
    /** Tooltip text for fetch button */
    buttonTooltip: string;
    /** Toast message (if any) */
    toastMessage?: string;
    /** Whether toast should be shown */
    showToast: boolean;
  };
  
  /** Metadata for logging */
  analysisContext: {
    trigger: AnalysisTrigger;
    dsl: string;
    timestamp: string;
    durationMs?: number;
  };
}
```

---

## 3. Service Architecture

### 3.1 Class Structure

```typescript
class WindowFetchPlannerService {
  private static instance: WindowFetchPlannerService;
  
  /** Cached result (invalidated on fetch completion or graph change) */
  private cachedResult: PlannerResult | null = null;
  private cachedDSL: string | null = null;
  private cachedGraphHash: string | null = null;
  
  static getInstance(): WindowFetchPlannerService;
  
  /**
   * Analyse coverage and staleness for the current query.
   * This is the main entry point for UI decisions.
   * 
   * SIDE-EFFECT FREE: Does not trigger fetches or modify state.
   * 
   * SINGLE CODE PATH: Coverage classification is delegated to
   * fetchDataService.getItemsNeedingFetch() to ensure the planner's
   * view of "needs fetch" is structurally identical to what
   * execution will actually do.
   */
  async analyse(
    graph: Graph,
    dsl: string,
    trigger: AnalysisTrigger
  ): Promise<PlannerResult>;
  
  /**
   * Execute the fetch plan.
   * 
   * IMPORTANT: Always re-runs analyse() internally to ensure
   * the fetch plan is fresh and matches what would be fetched.
   * This guarantees the single-path property between dry-run and execution.
   */
  async executeFetchPlan(
    graph: Graph,
    setGraph: (g: Graph | null) => void,
    dsl: string,
    parentLogId?: string  // For log linkage
  ): Promise<PlannerResult>;
  
  /**
   * Invalidate cached analysis (called after fetch or graph change).
   */
  invalidateCache(): void;
  
  /** Build human-readable summary for button tooltip */
  private buildButtonTooltip(items: PlannerItem[], outcome: FetchOutcome): string;
  
  /** Build toast message based on outcome */
  private buildToastMessage(outcome: FetchOutcome, items: PlannerItem[]): string | undefined;
}
```

### 3.2 Dependency Graph

```
WindowSelector (component)
    │
    ▼
windowFetchPlannerService.analyse()
    │
    ├── fetchDataService.getItemsNeedingFetch()   ◄── SINGLE SOURCE OF TRUTH for coverage
    │       │
    │       ├── itemNeedsFetch()                   (existing)
    │       ├── hasFullSliceCoverageByHeader()     (windowAggregationService.ts)
    │       └── fileRegistry.getFile()             (existing)
    │
    ├── shouldRefetch()                            (fetchRefetchPolicy.ts) - for staleness
    ├── computeEffectiveMaturity()                 (fetchRefetchPolicy.ts) - for t95 fallback
    ├── parseConstraints()                         (queryDSL.ts) - for window/cohort extraction
    └── sessionLogService.*                        (existing)
    
windowFetchPlannerService.executeFetchPlan()
    │
    ├── analyse()                                  ◄── Re-runs analysis for fresh plan
    ├── fetchDataService.fetchItems()              (existing)
    └── sessionLogService.*                        (existing, with linkage)
```

---

## 4. Single Code Path Guarantee

### 4.1 Principle

The high-level design mandates that the planner analysis acts as a "dry run" for actual fetch execution. This means:

1. The planner MUST NOT reimplement coverage logic.
2. Coverage classification ("needs fetch" vs "covered") MUST be derived from `fetchDataService.getItemsNeedingFetch()`.
3. The planner ADDS staleness semantics on top, but does not redefine what "needs fetch" means.

### 4.2 Enforcement

```typescript
async analyse(graph: Graph, dsl: string, trigger: AnalysisTrigger): Promise<PlannerResult> {
  const window = this.extractWindowFromDSL(dsl);
  if (!window) {
    return this.buildEmptyResult(dsl, trigger, 'No window in DSL');
  }
  
  // ═══════════════════════════════════════════════════════════════════════════
  // CRITICAL: Delegate coverage to existing fetchDataService
  // This ensures planner's "needs_fetch" view matches execution behaviour.
  // ═══════════════════════════════════════════════════════════════════════════
  const fetchableItems = getItemsNeedingFetch(window, graph, dsl, true);  // checkCache=true
  const allConnectableItems = getItemsNeedingFetch(window, graph, dsl, false); // checkCache=false
  
  // Build item classifications
  const items: PlannerItem[] = [];
  
  for (const connectable of allConnectableItems) {
    const needsFetch = fetchableItems.some(f => f.id === connectable.id);
    
    // Determine if file-only (has data but no connection)
    const isFileOnly = this.isFileOnlyItem(connectable, graph);
    
    if (isFileOnly) {
      // File-only items: check coverage for messaging, but never "needs_fetch"
      const hasCoverage = this.checkFileOnlyCoverage(connectable, window, dsl);
      items.push({
        ...this.toBaseItem(connectable),
        classification: hasCoverage ? 'covered_stable' : 'file_only_gap',
      });
      continue;
    }
    
    if (needsFetch) {
      items.push({
        ...this.toBaseItem(connectable),
        classification: 'needs_fetch',
        missingDates: this.countMissingDates(connectable, window, dsl),
      });
      continue;
    }
    
    // Covered: check staleness
    const staleness = this.checkStaleness(connectable, window, dsl, graph);
    if (staleness.isStale) {
      items.push({
        ...this.toBaseItem(connectable),
        classification: 'stale_candidate',
        stalenessReason: staleness.reason,
        retrievedAt: staleness.retrievedAt,
        effectiveT95: staleness.effectiveT95,
      });
    } else {
      items.push({
        ...this.toBaseItem(connectable),
        classification: 'covered_stable',
      });
    }
  }
  
  // ... derive outcome and build result
}
```

### 4.3 Execution Always Re-analyses

To guarantee consistency, `executeFetchPlan()` always re-runs `analyse()`:

```typescript
async executeFetchPlan(
  graph: Graph,
  setGraph: (g: Graph | null) => void,
  dsl: string,
  parentLogId?: string
): Promise<PlannerResult> {
  // ═══════════════════════════════════════════════════════════════════════════
  // CRITICAL: Re-analyse to get fresh plan.
  // Never trust a stale PlannerResult passed from the component.
  // ═══════════════════════════════════════════════════════════════════════════
  const freshResult = await this.analyse(graph, dsl, 'user_refresh');
  
  const itemsToFetch = [
    ...freshResult.fetchPlanItems,
    ...freshResult.staleCandidates,
  ];
  
  if (itemsToFetch.length === 0) {
    return freshResult; // Nothing to do
  }
  
  // Convert to FetchItem[] for fetchDataService
  const fetchItems = itemsToFetch.map(i => createFetchItem(
    i.type, i.objectId, i.targetId, { paramSlot: i.paramSlot }
  ));
  
  // Execute via existing fetch infrastructure
  await fetchDataService.fetchItems(fetchItems, { mode: 'versioned' }, graph, setGraph, dsl);
  
  // Invalidate cache and return fresh analysis
  this.invalidateCache();
  return this.analyse(graph, dsl, 'post_fetch');
}
```

---

## 5. DSL Window/Cohort Extraction

### 5.1 Problem with `extractWindowFromDSL()`

The existing `extractWindowFromDSL()` in `fetchDataService.ts` only handles `window()` clauses, not `cohort()`. For cohort queries, the planner must use `parseConstraints()` directly.

### 5.2 Correct Extraction

```typescript
/**
 * Extract date range from DSL, handling both window() and cohort() clauses.
 */
private extractWindowFromDSL(dsl: string): DateRange | null {
  try {
    const constraints = parseConstraints(dsl);
    
    // Handle cohort() queries
    if (constraints.cohort && constraints.cohort.start) {
      const start = resolveRelativeDate(constraints.cohort.start);
      const end = constraints.cohort.end 
        ? resolveRelativeDate(constraints.cohort.end)
        : this.getTodayUK();
      return { start, end };
    }
    
    // Handle window() queries
    if (constraints.window && constraints.window.start) {
      const start = resolveRelativeDate(constraints.window.start);
      const end = constraints.window.end 
        ? resolveRelativeDate(constraints.window.end)
        : this.getTodayUK();
      return { start, end };
    }
    
    return null;
  } catch (e) {
    console.warn('[windowFetchPlannerService] Failed to parse DSL:', e);
    return null;
  }
}
```

---

## 6. Staleness Semantics

### 6.1 Staleness Only Applies to Covered Items

Staleness is assessed ONLY for items that have passed the coverage check (i.e., `getItemsNeedingFetch()` did NOT include them). Items with gaps are classified as `needs_fetch`, not `stale_candidate`.

### 6.2 t95 / path_t95 Field Selection

The planner uses different latency thresholds depending on query mode:

| Query Mode | Primary Field | Fallback |
|------------|--------------|----------|
| `window()` | `edge.p.latency.t95` | `edge.p.latency.legacy maturity field` |
| `cohort()` | `edge.p.latency.path_t95` | `edge.p.latency.t95` → `legacy maturity field` |

Rationale:
- `t95` is the 95th percentile lag for a single edge.
- `path_t95` is the cumulative latency from the anchor to the edge, computed by `statisticalEnhancementService.computePathT95()`.
- For cohort queries, the relevant maturity horizon is the path (cumulative) latency.

### 6.3 Staleness Check Implementation

```typescript
private checkStaleness(
  item: FetchItem,
  window: DateRange,
  dsl: string,
  graph: Graph
): { isStale: boolean; reason?: string; retrievedAt?: string; effectiveT95?: number } {
  const isCohortQuery = dsl.includes('cohort(');
  
  // Get edge for latency config
  const edge = graph.edges?.find(e => (e.uuid || e.id) === item.targetId);
  const latencyConfig = edge?.p?.latency;
  
  // No latency tracking: not stale by default
  if (!latencyConfig?.legacy maturity field && !latencyConfig?.t95) {
    return { isStale: false };
  }
  
  // Get file and existing slice (matching pattern from dataOperationsService lines 3646-3657)
  const file = fileRegistry.getFile(`parameter-${item.objectId}`);
  if (!file?.data?.values) {
    return { isStale: false }; // No data to assess
  }
  
  const existingSlice = this.findMatchingSlice(file.data.values, dsl, isCohortQuery);
  if (!existingSlice) {
    return { isStale: false }; // No matching slice
  }
  
  // Use existing refetch policy for cohort immaturity check
  const refetchDecision = shouldRefetch({
    existingSlice,
    latencyConfig,
    requestedWindow: window,
    isCohortQuery,
    referenceDate: new Date(),
  });
  
  // If refetch policy says replace_slice or partial, it's stale
  if (refetchDecision.type === 'replace_slice' && refetchDecision.hasImmatureCohorts) {
    return {
      isStale: true,
      reason: refetchDecision.reason || 'immature_cohorts',
      retrievedAt: existingSlice.data_source?.retrieved_at,
    };
  }
  
  if (refetchDecision.type === 'partial') {
    return {
      isStale: true,
      reason: `Immature dates after ${refetchDecision.matureCutoff}`,
      retrievedAt: existingSlice.data_source?.retrieved_at,
    };
  }
  
  // ═══════════════════════════════════════════════════════════════════════════
  // ADDITIONAL STALENESS TEST: retrieval timestamp + t95/path_t95
  // 
  // High-level design §5.2:
  // - If more than 1 day has passed since retrieval AND
  // - Query horizon is still within t95/path_t95 (cohorts may be maturing)
  // → Treat as refresh candidate
  // 
  // - Once query horizon is beyond t95/path_t95
  // → Treat as "reasonably mature" (covered_stable)
  // ═══════════════════════════════════════════════════════════════════════════
  if (refetchDecision.type === 'use_cache') {
    const retrievedAt = existingSlice.data_source?.retrieved_at;
    if (!retrievedAt) {
      return { isStale: false };
    }
    
    const retrievedDate = new Date(retrievedAt);
    const daysSinceRetrieval = (Date.now() - retrievedDate.getTime()) / (24 * 60 * 60 * 1000);
    
    // Select effective t95 based on query mode
    const effectiveT95 = isCohortQuery
      ? (latencyConfig.path_t95 ?? latencyConfig.t95 ?? latencyConfig.legacy maturity field ?? 0)
      : (latencyConfig.t95 ?? latencyConfig.legacy maturity field ?? 0);
    
    // Get query end date
    const queryEnd = this.extractWindowFromDSL(dsl)?.end;
    if (!queryEnd) {
      return { isStale: false, effectiveT95 };
    }
    
    const queryEndDate = parseDate(queryEnd);
    const daysFromQueryEndToNow = (Date.now() - queryEndDate.getTime()) / (24 * 60 * 60 * 1000);
    
    // Staleness test
    if (daysSinceRetrieval > 1 && daysFromQueryEndToNow < effectiveT95) {
      return {
        isStale: true,
        reason: `Data retrieved ${Math.floor(daysSinceRetrieval)}d ago, cohorts may have matured (t95=${effectiveT95.toFixed(1)}d)`,
        retrievedAt,
        effectiveT95,
      };
    }
    
    return { isStale: false, effectiveT95 };
  }
  
  return { isStale: false };
}
```

---

## 7. Case Coverage and Staleness Semantics

### 7.1 Case Coverage

Cases use schedule-based coverage rather than daily time-series coverage. The planner handles cases as follows:

1. **Discovery**: Cases are discovered via `getItemsNeedingFetch()`, which already handles case items through `itemNeedsFetch()`.

2. **Coverage Check**: For cases, `itemNeedsFetch()` checks whether case file data exists. Cases do not have slice headers or date ranges in the same way as parameters; presence of file data is sufficient for "covered".

3. **File-Only Cases**: Cases without connections are handled identically to file-only parameters: they contribute to `unfetchableGaps` if lacking file data, or `covered_stable` if file data exists.

### 7.2 Case Staleness

**Cases use a simple time-based staleness rule: if the most recent schedule was retrieved more than 1 day ago, the case is stale and should be refreshed.**

Rationale:
- Cases represent gate configurations (A/B test weights, variant assignments) that can change at any time in the external system (Statsig, Amplitude, etc.).
- Unlike parameters, cases do not have latency/maturity semantics – there is no concept of "immature cohorts maturing" for A/B test weights.
- A simple 1-day threshold ensures that case data stays reasonably fresh without over-fetching.
- This aligns with the parameter staleness rule (also 1 day since retrieval as a trigger).

Implementation:

```typescript
// In checkStaleness:
if (item.type === 'case') {
  const caseFile = fileRegistry.getFile(`case-${item.objectId}`);
  if (!caseFile?.data) {
    return { isStale: false }; // No data to assess
  }
  
  // Find most recent schedule's retrieved_at
  const schedules = caseFile.data.case?.schedules || [];
  const retrievedAt = this.getMostRecentCaseRetrievedAt(schedules);
  
  if (!retrievedAt) {
    // No retrieval timestamp: cannot assess staleness
    // Treat as stale to be safe (will refresh on next fetch)
    return { 
      isStale: true, 
      reason: 'No retrieval timestamp on case schedules',
    };
  }
  
  const retrievedDate = new Date(retrievedAt);
  const daysSinceRetrieval = (Date.now() - retrievedDate.getTime()) / (24 * 60 * 60 * 1000);
  
  // Simple 1-day threshold
  if (daysSinceRetrieval > 1) {
    return {
      isStale: true,
      reason: `Case retrieved ${Math.floor(daysSinceRetrieval)}d ago`,
      retrievedAt,
    };
  }
  
  return { isStale: false, retrievedAt };
}

/**
 * Get the most recent retrieved_at from case schedules.
 */
private getMostRecentCaseRetrievedAt(schedules: any[]): string | undefined {
  if (!schedules || schedules.length === 0) return undefined;
  
  let mostRecent: string | undefined;
  for (const schedule of schedules) {
    const retrievedAt = schedule.retrieved_at;
    if (retrievedAt && (!mostRecent || retrievedAt > mostRecent)) {
      mostRecent = retrievedAt;
    }
  }
  return mostRecent;
}
```

### 7.3 Case Staleness in Fetch Pipeline

The case staleness check happens in the planner. However, the fetch pipeline (`fetchDataService`) also needs to understand case staleness for the "covered but stale" scenario where `getItemsNeedingFetch()` returns the item as NOT needing fetch (because file exists), but the planner still wants to refresh it.

**Key insight**: For cases, the planner handles staleness classification. The fetch pipeline continues to work as before – when the planner classifies a case as `stale_candidate`, it gets added to the items-to-fetch list and `fetchDataService.fetchItems()` executes it normally.

No changes to `fetchDataService.itemNeedsFetch()` are required for case staleness, because:
1. The planner uses `getItemsNeedingFetch()` to get coverage status.
2. The planner then adds staleness on top for cases that passed coverage.
3. Stale cases are included in the fetch plan alongside gap-filling items.

---

## 8. File-Only Item Handling

### 8.1 Definition

A file-only item is one where:
- `fileRegistry.getFile()` returns data (file exists with content), AND
- No connection exists on either the file or the graph edge/node.

### 8.2 Classification Rules

| File Data | Connection | Coverage | Classification |
|-----------|------------|----------|----------------|
| Yes | No | Complete | `covered_stable` |
| Yes | No | Incomplete | `file_only_gap` |
| Yes | Yes | Complete | `covered_stable` or `stale_candidate` |
| Yes | Yes | Incomplete | `needs_fetch` |
| No | Yes | - | `needs_fetch` |
| No | No | - | (skipped - not discovered) |

### 8.3 UX Implications

- **`file_only_gap` items do NOT block auto-aggregation** of other items.
- **`file_only_gap` items do NOT cause outcome = `not_covered`**.
- **`file_only_gap` items trigger a toast** explaining that sample/file-only data does not cover this window.
- The overall outcome with only file-only gaps is `covered_stable` (no fetch available).

---

## 9. Session Logging with Linkage

### 9.1 Analysis Logging

Each `analyse()` call logs a hierarchical operation:

```typescript
// Start analysis operation
const logOpId = sessionLogService.startOperation(
  'info',
  'data-fetch',
  'PLANNER_ANALYSIS',
  `Analysing fetch requirements for ${dsl}`,
  {
    dsl,
    trigger,
    timestamp: new Date().toISOString(),
  }
);

// Add child entries for each classification bucket
sessionLogService.addChild(logOpId, 'info', 'PLANNER_ITEMS', 
  `Inspected ${items.length} items: ${covered} covered, ${needsFetch} need fetch, ${stale} stale, ${unfetchable} file-only`,
  { itemCount: items.length, covered, needsFetch, stale, unfetchable }
);

// End with outcome
sessionLogService.endOperation(logOpId, 'success', 
  `Outcome: ${outcome}`,
  { outcome, durationMs }
);
```

### 9.2 Fetch Triage Logging with Linkage

When `executeFetchPlan()` is called, a triage operation is started that becomes the **parent for data operations logs**:

```typescript
async executeFetchPlan(
  graph: Graph,
  setGraph: (g: Graph | null) => void,
  dsl: string
): Promise<PlannerResult> {
  const triageLogId = sessionLogService.startOperation(
    'info',
    'data-fetch',
    'FETCH_TRIAGE',
    `Fetch triage for ${dsl}`,
    { dsl }
  );
  
  try {
    const freshResult = await this.analyse(graph, dsl, 'user_refresh');
    
    const fetchItems = freshResult.fetchPlanItems;
    const staleItems = freshResult.staleCandidates;
    
    // Log triage decision
    if (fetchItems.length > 0) {
      sessionLogService.addChild(triageLogId, 'info', 'FETCH_GAPS',
        `Fetching ${fetchItems.length} items with coverage gaps`,
        { items: fetchItems.map(i => i.id) }
      );
    }
    
    if (staleItems.length > 0) {
      sessionLogService.addChild(triageLogId, 'info', 'FETCH_STALE',
        `Refreshing ${staleItems.length} stale items`,
        { items: staleItems.map(i => i.id), reasons: staleItems.map(i => i.stalenessReason) }
      );
    }
    
    if (freshResult.outcome === 'covered_stable') {
      sessionLogService.addChild(triageLogId, 'info', 'NO_FETCH_NEEDED',
        'All items covered and mature, no fetch required',
        { itemCount: freshResult.autoAggregationItems.length }
      );
    }
    
    // ═══════════════════════════════════════════════════════════════════════════
    // LOG LINKAGE: Pass triageLogId to fetchItems so data operations logs
    // become children of this triage operation.
    // ═══════════════════════════════════════════════════════════════════════════
    const allItemsToFetch = [...fetchItems, ...staleItems];
    if (allItemsToFetch.length > 0) {
      const fetchItemsList = allItemsToFetch.map(i => createFetchItem(
        i.type, i.objectId, i.targetId, { paramSlot: i.paramSlot }
      ));
      
      await fetchDataService.fetchItems(
        fetchItemsList,
        { 
          mode: 'versioned',
          parentLogId: triageLogId,  // ◄── Linkage
        },
        graph,
        setGraph,
        dsl
      );
    }
    
    sessionLogService.endOperation(triageLogId, 'success', 
      `Completed: ${allItemsToFetch.length} items fetched`);
    
    this.invalidateCache();
    return this.analyse(graph, dsl, 'post_fetch');
    
  } catch (err) {
    sessionLogService.endOperation(triageLogId, 'error', err.message);
    throw err;
  }
}
```

### 9.3 fetchDataService Enhancement for Log Linkage

To support linkage, `fetchDataService.fetchItems()` needs to accept an optional `parentLogId`:

```typescript
// In fetchDataService.ts

export interface FetchOptions {
  mode?: FetchMode;
  bustCache?: boolean;
  versionedCase?: boolean;
  setAutoUpdating?: (updating: boolean) => void;
  parentLogId?: string;  // ◄── NEW: For log hierarchy linkage
}

export async function fetchItems(
  items: FetchItem[],
  options: FetchOptions & { onProgress?: (...) => void } | undefined,
  graph: Graph,
  setGraph: (g: Graph | null) => void,
  dsl: string,
  getUpdatedGraph?: () => Graph | null
): Promise<FetchResult[]> {
  // ...
  
  // Use parentLogId if provided, otherwise start new operation
  const batchLogId = options?.parentLogId 
    ? options.parentLogId  // Re-use parent's operation
    : sessionLogService.startOperation('info', 'data-fetch', 'BATCH_FETCH', ...);
  
  // When using parent, add children instead of starting new operation
  if (options?.parentLogId) {
    // Add child entries under parent
    for (const item of items) {
      sessionLogService.addChild(batchLogId, 'info', 'FETCH_ITEM', item.name, { itemId: item.id });
    }
  }
  
  // ...
}
```

---

## 10. WindowSelector Integration

### 10.0 Scope of UI Changes

**What CHANGES:**
- Button **label**: "Fetch data" / "Refresh" / "Up to date" based on planner outcome
- Button **tooltip**: Sourced from `plannerResult.summaries.buttonTooltip`

**What is PRESERVED (no changes):**
- Button **visibility**: Still controlled by `hasParameterFiles`
- Button **shimmer animation**: Same CSS class (`.shimmer`) and timing
- Button **disabled state**: Same visual styling
- Button **position/layout**: Same placement in fetch column
- All CSS in `WindowSelector.css`: No modifications

### 10.1 State Reduction

The WindowSelector component currently maintains:

```typescript
// Current state (to be simplified)
const [needsFetch, setNeedsFetch] = useState(false);
const [isCheckingCoverage, setIsCheckingCoverage] = useState(false);
const [isFetching, setIsFetching] = useState(false);
const [showButton, setShowButton] = useState(false);
const [showShimmer, setShowShimmer] = useState(false);

// Coverage cache
const coverageCache = new Map<string, CoverageCacheEntry>();
```

This will be replaced with:

```typescript
// New state (planner-driven)
const [plannerResult, setPlannerResult] = useState<PlannerResult | null>(null);
const [isExecuting, setIsExecuting] = useState(false);

// ═══════════════════════════════════════════════════════════════════════════
// PRESERVED: Shimmer animation state (unchanged from current implementation)
// The shimmer effect draws user attention when fetch is needed.
// ═══════════════════════════════════════════════════════════════════════════
const [showShimmer, setShowShimmer] = useState(false);

// Derive UI state from plannerResult.status
const isAnalysing = plannerResult?.status === 'pending';
const isError = plannerResult?.status === 'error';

// Derive button state from plannerResult
const outcome = plannerResult?.outcome ?? 'covered_stable';
const buttonLabel = outcome === 'not_covered' ? 'Fetch data' 
                  : outcome === 'covered_stale' ? 'Refresh' 
                  : 'Up to date';
const buttonDisabled = isAnalysing || isExecuting || outcome === 'covered_stable';
const buttonTooltip = plannerResult?.summaries.buttonTooltip ?? '';

// Button needs attention when outcome requires user action
const buttonNeedsAttention = outcome === 'not_covered' || outcome === 'covered_stale';
```

### 10.2 Effect Structure

The current monolithic effect (lines 491-798) will be replaced with:

```typescript
// Effect 1: Trigger analysis on DSL change
useEffect(() => {
  if (isExecuting) return;
  
  const authoritativeDSL = graphStore.getState()?.currentDSL || '';
  if (!authoritativeDSL || !graph) return;
  
  const trigger: AnalysisTrigger = isInitialMountRef.current 
    ? 'initial_load' 
    : 'dsl_change';
  
  // Set pending status immediately
  setPlannerResult(prev => prev ? { ...prev, status: 'pending' } : null);
  
  windowFetchPlannerService.analyse(graph, authoritativeDSL, trigger)
    .then(result => {
      setPlannerResult(result);
      isInitialMountRef.current = false;
      
      // Show toast if planner says to
      if (result.summaries.showToast && result.summaries.toastMessage) {
        toast(result.summaries.toastMessage, { icon: '⚠️', duration: 4000 });
      }
    })
    .catch(err => {
      console.error('[WindowSelector] Planner analysis failed:', err);
      setPlannerResult({
        status: 'error',
        error: err.message,
        outcome: 'covered_stable',
        // ... empty arrays
      });
      toast.error(`Coverage check failed: ${err.message}`);
    });
    
}, [graph, graphStore.currentDSL]);

// Effect 2: Auto-aggregate from cache
// ═══════════════════════════════════════════════════════════════════════════
// CRITICAL: Auto-aggregate for BOTH covered_stable AND covered_stale.
// 
// Per high-level design §3.1:
// - covered_stable: "Auto aggregate from cache where possible"
// - covered_stale: "Auto aggregate from cache for all covered items"
// 
// The difference is only in the button CTA, not auto-aggregation behaviour.
// ═══════════════════════════════════════════════════════════════════════════
useEffect(() => {
  if (!plannerResult || plannerResult.status !== 'complete') return;
  // Auto-aggregate for BOTH stable and stale (not for not_covered)
  if (plannerResult.outcome === 'not_covered') return;
  if (plannerResult.autoAggregationItems.length === 0) return;
  if (isAggregatingRef.current) return;
  
  // Trigger auto-aggregation using existing fetchItems with 'from-file' mode
  isAggregatingRef.current = true;
  
  const items = plannerResult.autoAggregationItems.map(i => createFetchItem(
    i.type, i.objectId, i.targetId, { paramSlot: i.paramSlot }
  ));
  
  fetchItems(items, { mode: 'from-file' })
    .then(() => {
      setLastAggregatedWindow(currentWindow);
      lastAggregatedDSLRef.current = graphStore.getState()?.currentDSL || '';
    })
    .finally(() => {
      isAggregatingRef.current = false;
    });
    
}, [plannerResult]);

// ═══════════════════════════════════════════════════════════════════════════
// Effect 3: PRESERVED - Shimmer animation when button needs attention
// This is unchanged from the current implementation.
// ═══════════════════════════════════════════════════════════════════════════
useEffect(() => {
  if (buttonNeedsAttention) {
    // Trigger shimmer after short delay to ensure button is visible
    setTimeout(() => {
      setShowShimmer(true);
      setTimeout(() => setShowShimmer(false), 600); // Match CSS animation duration
    }, 100);
  } else {
    setShowShimmer(false);
  }
}, [buttonNeedsAttention]);

// Effect 4: PRESERVED - Re-trigger shimmer on DSL change when fetch needed
const prevDSLRef = useRef<string | null>(null);
useEffect(() => {
  const authoritativeDSL = graphStore.getState()?.currentDSL || '';
  if (!authoritativeDSL) {
    prevDSLRef.current = null;
    return;
  }
  
  const dslChanged = authoritativeDSL !== prevDSLRef.current;
  prevDSLRef.current = authoritativeDSL;
  
  // If DSL changed and button needs attention, re-trigger shimmer
  if (dslChanged && buttonNeedsAttention) {
    setShowShimmer(false); // Reset first
    setTimeout(() => {
      setShowShimmer(true);
      setTimeout(() => setShowShimmer(false), 600);
    }, 50);
  }
}, [graphStore.currentDSL, buttonNeedsAttention]);
```

### 10.3 Button Rendering (UNCHANGED)

The button JSX remains structurally identical. Only the **label** and **tooltip** change:

```jsx
{hasParameterFiles && (
  <div className="window-selector-fetch-column">
    <button
      onClick={handleFetchData}
      disabled={buttonDisabled}
      className={`window-selector-button ${showShimmer ? 'shimmer' : ''}`}
      title={buttonTooltip}
    >
      {isAnalysing ? 'Checking...' : isExecuting ? 'Fetching...' : buttonLabel}
    </button>
  </div>
)}
```

**CSS unchanged**: The `.shimmer` class and `@keyframes shimmer` animation in `WindowSelector.css` remain as-is.

### 10.4 Fetch Button Handler

```typescript
const handleFetchData = async () => {
  if (!graph) return;
  
  setIsExecuting(true);
  
  try {
    // executeFetchPlan re-analyses internally (single path guarantee)
    const newResult = await windowFetchPlannerService.executeFetchPlan(
      graph,
      setGraph,
      graphStore.getState()?.currentDSL || ''
    );
    setPlannerResult(newResult);
    
    setLastAggregatedWindow(currentWindow);
    lastAggregatedDSLRef.current = graphStore.getState()?.currentDSL || '';
  } catch (err) {
    console.error('[WindowSelector] Fetch failed:', err);
    toast.error(`Fetch failed: ${err.message}`);
  } finally {
    setIsExecuting(false);
  }
};
```

---

## 11. Existing Service Modifications

### 11.1 fetchDataService.ts

**Add `parentLogId` to FetchOptions:**

```typescript
export interface FetchOptions {
  mode?: FetchMode;
  bustCache?: boolean;
  versionedCase?: boolean;
  setAutoUpdating?: (updating: boolean) => void;
  parentLogId?: string;  // NEW: For session log hierarchy
}
```

Modify `fetchItems()` to use `parentLogId` for log linkage as described in §9.3.

### 11.2 fetchRefetchPolicy.ts

**Export `computeEffectiveMaturity`:**

```typescript
// Change from:
function computeEffectiveMaturity(latencyConfig?: LatencyConfig): number {

// To:
export function computeEffectiveMaturity(latencyConfig?: LatencyConfig): number {
```

### 11.3 windowAggregationService.ts

**No changes required.**

The planner delegates coverage checks to `fetchDataService.getItemsNeedingFetch()` which internally uses `hasFullSliceCoverageByHeader()`.

### 11.4 dataOperationsService.ts

**No changes required.**

Execution flows through `fetchDataService.fetchItems()` which already delegates to `dataOperationsService.getFromSource()`.

### 11.5 sliceIsolation.ts

**No changes required.** Used by planner's `findMatchingSlice()` helper (see §18.2).

### 11.6 useFetchData.ts

**No changes required.** WindowSelector will call `fetchDataService` directly via the planner, not through `useFetchData`. The hook remains available for other components.

### 11.7 ScenariosContext.tsx

**Out of scope for this refactor.** `ScenariosContext` uses `getItemsNeedingFetch()` directly for scenario-specific loading flows. The planner is specifically for `WindowSelector` UI decisions. No changes needed.

---

## 12. Outcome Derivation

The overall outcome is derived from item classifications:

```typescript
function deriveOutcome(items: PlannerItem[]): FetchOutcome {
  // Only fetchable items (not file_only_gap) contribute to outcome
  const fetchableItems = items.filter(i => i.classification !== 'file_only_gap');
  
  const hasNeedsFetch = fetchableItems.some(i => i.classification === 'needs_fetch');
  const hasStale = fetchableItems.some(i => i.classification === 'stale_candidate');
  
  if (hasNeedsFetch) {
    return 'not_covered';
  }
  
  if (hasStale) {
    return 'covered_stale';
  }
  
  return 'covered_stable';
}
```

Note: `file_only_gap` items are explicitly excluded from outcome derivation. They affect messaging (toast) but not the fetch button state.

---

## 13. Message Summary Generation

### 13.1 Button Tooltip

```typescript
function buildButtonTooltip(items: PlannerItem[], outcome: FetchOutcome): string {
  if (outcome === 'covered_stable') {
    return 'All data is up to date for this query.';
  }
  
  const fetchItems = items.filter(i => i.classification === 'needs_fetch');
  const staleItems = items.filter(i => i.classification === 'stale_candidate');
  
  const parts: string[] = [];
  
  if (fetchItems.length > 0) {
    const totalMissing = fetchItems.reduce((sum, i) => sum + (i.missingDates ?? 0), 0);
    if (totalMissing > 0) {
      parts.push(`Fetch ${totalMissing} missing date${totalMissing > 1 ? 's' : ''} for ${fetchItems.length} item${fetchItems.length > 1 ? 's' : ''}`);
    } else {
      parts.push(`Fetch ${fetchItems.length} item${fetchItems.length > 1 ? 's' : ''} from source`);
    }
  }
  
  if (staleItems.length > 0) {
    // Distinguish between stale parameters (maturing cohorts) and stale cases (>1 day old)
    const staleParams = staleItems.filter(i => i.type === 'parameter');
    const staleCases = staleItems.filter(i => i.type === 'case');
    
    if (staleParams.length > 0) {
      parts.push(`Refresh ${staleParams.length} param${staleParams.length > 1 ? 's' : ''} with maturing cohorts`);
    }
    if (staleCases.length > 0) {
      parts.push(`Refresh ${staleCases.length} case${staleCases.length > 1 ? 's' : ''} (>1 day old)`);
    }
  }
  
  return parts.join('; ');
}
```

### 13.2 Toast Message

```typescript
function buildToastMessage(outcome: FetchOutcome, items: PlannerItem[]): string | undefined {
  const unfetchable = items.filter(i => i.classification === 'file_only_gap');
  
  if (outcome === 'not_covered') {
    const fetchItems = items.filter(i => i.classification === 'needs_fetch');
    return `${fetchItems.length} item${fetchItems.length > 1 ? 's' : ''} need fetching. Click Fetch to retrieve data.`;
  }
  
  if (outcome === 'covered_stable' && unfetchable.length > 0) {
    return `No cached data for ${unfetchable.length} file-only item${unfetchable.length > 1 ? 's' : ''} in this window. Try a different date range.`;
  }
  
  // No toast for covered_stale (user can see the Refresh button)
  return undefined;
}
```

---

## 14. Cache Invalidation

The planner caches its last result to avoid redundant analysis:

```typescript
class WindowFetchPlannerService {
  private cachedResult: PlannerResult | null = null;
  private cachedDSL: string | null = null;
  private cachedGraphHash: string | null = null;
  
  async analyse(graph: Graph, dsl: string, trigger: AnalysisTrigger): Promise<PlannerResult> {
    const graphHash = this.computeGraphHash(graph);
    
    // Return cached result if DSL and graph unchanged
    if (this.cachedResult && this.cachedDSL === dsl && this.cachedGraphHash === graphHash) {
      return { ...this.cachedResult, status: 'complete' };
    }
    
    // ... perform analysis ...
    
    this.cachedResult = result;
    this.cachedDSL = dsl;
    this.cachedGraphHash = graphHash;
    
    return result;
  }
  
  invalidateCache(): void {
    this.cachedResult = null;
    this.cachedDSL = null;
    this.cachedGraphHash = null;
  }
  
  private computeGraphHash(graph: Graph): string {
    // Hash of edge/node IDs to detect structural changes
    const edgeIds = (graph.edges || []).map(e => e.uuid || e.id).sort().join(',');
    const nodeIds = (graph.nodes || []).map(n => n.uuid || n.id).sort().join(',');
    return `${edgeIds}|${nodeIds}`;
  }
}
```

Invalidation triggers:

1. After `executeFetchPlan()` completes
2. When graph structure changes (edges/nodes added/removed)
3. When file registry content changes (via file save)

---

## 15. Error Handling

### 15.1 Analysis Errors

If analysis fails (e.g., file read error), return an error result:

```typescript
return {
  status: 'error',
  error: err.message,
  outcome: 'covered_stable', // Safe default
  autoAggregationItems: [],
  fetchPlanItems: [],
  staleCandidates: [],
  unfetchableGaps: [],
  summaries: {
    buttonTooltip: 'Error checking coverage. Click to retry.',
    toastMessage: `Coverage check failed: ${err.message}`,
    showToast: true,
  },
  analysisContext: { trigger, dsl, timestamp: new Date().toISOString() },
};
```

### 15.2 Execution Errors

Execution errors are already handled by `fetchDataService.fetchItems()` which returns `FetchResult[]` with individual success/failure statuses.

---

## 16. Testing Strategy

### 16.1 Unit Tests

**File:** `graph-editor/src/services/__tests__/windowFetchPlannerService.test.ts`

Test scenarios:

1. **Single path verification**
   - Mock `getItemsNeedingFetch()` and verify planner uses its output for `needs_fetch` classification
   - Confirm planner does NOT call `hasFullSliceCoverageByHeader()` directly for parameters

2. **Coverage classification (via delegation)**
   - Items returned by `getItemsNeedingFetch()` → `needs_fetch`
   - Items NOT returned by `getItemsNeedingFetch()` but connectable → check staleness
   - File-only items → `file_only_gap` or `covered_stable`

3. **Staleness classification**
   - Mature cohorts (shouldRefetch returns `use_cache`) → check retrieval timestamp
   - Immature cohorts (shouldRefetch returns `replace_slice`) → `stale_candidate`
   - Retrieved > 1 day ago, within t95 → `stale_candidate`
   - Retrieved > 1 day ago, beyond t95 → `covered_stable`

4. **DSL extraction**
   - `window(1-Dec-25:7-Dec-25)` → correct DateRange
   - `cohort(1-Dec-25:7-Dec-25)` → correct DateRange (not null)
   - Relative dates (`-7d:`) → resolved correctly

5. **Case staleness**
   - Case with schedule retrieved <1 day ago → `covered_stable`
   - Case with schedule retrieved >1 day ago → `stale_candidate`
   - Case with no `retrieved_at` on schedules → `stale_candidate` (refresh to be safe)
   - File-only cases → `file_only_gap`

6. **Outcome derivation**
   - All covered_stable → `covered_stable`
   - Any needs_fetch → `not_covered`
   - No needs_fetch, some stale → `covered_stale`
   - Only file_only_gap → `covered_stable` (with toast)

7. **Message generation**
   - Correct button tooltips for each outcome
   - Toast messages for unfetchable gaps

### 16.2 Integration Tests

**File:** `graph-editor/src/services/__tests__/windowFetchPlannerService.integration.test.ts`

Test with mock graphs and file registry:

1. End-to-end analysis with real `getItemsNeedingFetch()` 
2. Execution flow through to mock `fetchItems`
3. Cache invalidation after execution
4. Log linkage verification (parent/child structure)
5. **Auto-aggregation triggers for both `covered_stable` AND `covered_stale`** (per high-level §3.1)

### 16.3 Existing Tests to Update

**Files requiring updates:**

| Test File | Changes Needed |
|-----------|----------------|
| `autoFetchCoverage.test.ts` | Update to test planner-based coverage instead of direct WindowSelector logic |
| `WindowSelector.autoAggregation.test.ts` | Update to verify auto-agg for both stable and stale outcomes |
| `fetchButtonE2E.integration.test.tsx` | Update button assertions for new labels ("Fetch data" / "Refresh" / "Up to date") |
| `fetchDataService.test.ts` | Add tests for `parentLogId` option |

**Tests that should NOT change:**

| Test File | Reason |
|-----------|--------|
| `fetchRefetchPolicy.test.ts` | Tests shouldRefetch() which planner reuses as-is |
| `fetchMergeEndToEnd.test.ts` | Tests merge logic, not coverage decisions |
| `liveScenarios.integration.test.ts` | ScenariosContext is out of scope |

### 16.4 Missing Test Scenarios to Add

1. **Shimmer trigger test**: Verify shimmer activates when `buttonNeedsAttention` changes to true
2. **Cache invalidation timing**: Verify cache invalidates on fetch completion and graph structure change
3. **Window change via DSL**: Verify window changes that update DSL trigger re-analysis

---

## 17. Migration Checklist

1. [ ] Create `windowFetchPlannerService.ts` with types and class skeleton
2. [ ] Implement `analyse()` delegating coverage to `getItemsNeedingFetch()`
3. [ ] Implement parameter staleness check using `shouldRefetch` + t95/path_t95 test
4. [ ] Implement case staleness check (>1 day since most recent schedule `retrieved_at`)
5. [ ] Implement `extractWindowFromDSL()` handling both window() and cohort()
6. [ ] Implement message summary builders (with distinct text for params vs cases)
7. [ ] Export `computeEffectiveMaturity` from `fetchRefetchPolicy.ts`
8. [ ] Add `parentLogId` to `FetchOptions` in `fetchDataService.ts`
9. [ ] Add unit tests for classification logic (including case staleness)
10. [ ] Refactor WindowSelector to use planner (behind feature flag)
11. [ ] Add integration tests for full flow
12. [ ] Update existing tests per §16.3 (autoFetchCoverage, WindowSelector.autoAggregation, fetchButtonE2E)
13. [ ] Remove old coverage logic from WindowSelector
14. [ ] Update button labels to use planner-derived values
15. [ ] Add session logging with triage linkage
16. [ ] Verify DSL persistence (§18.1) and add test if needed

---

## 18. Open Implementation Details

### 18.1 DSL Persistence Verification

The high-level design notes: "confirm that the current DSL is correctly persisted to the graph after fetch completion."

Current behaviour (to verify):

```typescript
// In WindowSelector handleFetchData:
lastAggregatedDSLRef.current = graphStore.getState()?.currentDSL || '';
```

This sets a ref but may not persist to the graph file. Need to trace whether `graph.currentQueryDSL` is saved to disk.

### 18.2 Window Change Detection

The high-level design §7.1 says analysis should trigger when "the selected window changes". The detailed design triggers on DSL change (Effect 1).

**Clarification**: Window changes update the DSL via `buildDSLFromComponents()` or similar. As long as the DSL reflects the window, triggering on DSL change is sufficient. No separate window-change effect is needed.

This is the current behaviour and is preserved by the refactor.

### 18.3 Slice Matching for Staleness (RESOLVED)

**Traced through existing code:** The pattern is already established in `dataOperationsService.ts` lines 3646-3657:

```typescript
// Match by slice type (cohort vs window) and context dimensions
const existingSlice = existingValues?.find(v => {
  const isCorrectMode = isCohortQuery ? isCohortModeValue(v) : !isCohortModeValue(v);
  if (!isCorrectMode) return false;
  
  // Match context/case dimensions using sliceIsolation
  const { extractSliceDimensions } = require('./sliceIsolation');
  const targetDims = extractSliceDimensions(targetSlice || '');
  const valueDims = extractSliceDimensions(v.sliceDSL || '');
  return targetDims === valueDims;
});
```

**Key points from trace:**

1. **Use `extractSliceDimensions()` not `isolateSlice()`** - We need to find ONE matching slice, not filter to multiple. `extractSliceDimensions()` normalizes both sides for comparison.

2. **Must check slice mode** - Use `isCohortModeValue(v)` to ensure cohort queries match cohort slices and window queries match window slices.

3. **Retrieved timestamp location** - `data_source.retrieved_at` (not `scalar.retrieved_at`):
   ```typescript
   // In ParameterValue (paramRegistryService.ts lines 93-95):
   data_source?: {
     type: 'sheets' | 'api' | 'file' | ...;
     retrieved_at?: string; // ISO date-time ← THIS ONE
   };
   ```

**Planner implementation:**

```typescript
private findMatchingSlice(
  values: ParameterValue[] | undefined,
  dsl: string,
  isCohortQuery: boolean
): ParameterValue | undefined {
  if (!values || values.length === 0) return undefined;
  
  const targetDims = extractSliceDimensions(dsl);
  
  return values.find(v => {
    // Must match mode (cohort vs window)
    const isCorrectMode = isCohortQuery 
      ? isCohortModeValue(v) 
      : !isCohortModeValue(v);
    if (!isCorrectMode) return false;
    
    // Must match context/case dimensions
    const valueDims = extractSliceDimensions(v.sliceDSL || '');
    return targetDims === valueDims;
  });
}
```

**This is no longer open** - the implementation pattern is traced and validated.

---

## Appendix A: File References

| Concept | File | Function/Type |
|---------|------|---------------|
| Items needing fetch | `fetchDataService.ts` | `getItemsNeedingFetch()` |
| Item needs fetch check | `fetchDataService.ts` | `itemNeedsFetch()` |
| Coverage by header | `windowAggregationService.ts` | `hasFullSliceCoverageByHeader()` |
| Incremental fetch | `windowAggregationService.ts` | `calculateIncrementalFetch()` |
| Refetch policy | `fetchRefetchPolicy.ts` | `shouldRefetch()` |
| Effective maturity | `fetchRefetchPolicy.ts` | `computeEffectiveMaturity()` |
| t95 computation | `statisticalEnhancementService.ts` | `computeT95()` |
| path_t95 computation | `statisticalEnhancementService.ts` | `computePathT95()` |
| Fetch execution | `fetchDataService.ts` | `fetchItems()` |
| DSL parsing | `lib/queryDSL.ts` | `parseConstraints()` |
| Session logging | `sessionLogService.ts` | `startOperation()`, `addChild()`, `endOperation()` |
| Slice dimension extraction | `services/sliceIsolation.ts` | `extractSliceDimensions()` |
| Cohort mode detection | `windowAggregationService.ts` | `isCohortModeValue()` |
| Graph types | `types/index.ts` | `Graph`, `GraphEdge`, `GraphNode` |
| File registry | `contexts/TabContext.tsx` | `fileRegistry.getFile()` |
| Relative date resolution | `lib/queryDSL.ts` | `resolveRelativeDate()` |

---

## Appendix B: Existing CoverageCacheEntry (for reference)

The current WindowSelector uses this cache structure (to be replaced):

```typescript
interface CoverageCacheEntry {
  dslKey: string;
  hasMissingData: boolean;
  hasAnyConnection: boolean;
  hasUnfetchableGaps: boolean;
  paramsToAggregate: Array<{ paramId: string; edgeId: string; slot: 'p' | 'cost_gbp' | 'labour_cost' }>;
  graphHash: string;
}
```

The planner's `PlannerResult` subsumes this with richer classification.

---

## Appendix C: Changes from Initial Detailed Design

This revision addresses the following gaps identified in critical review:

1. **Single code path guarantee**: Added §4 with explicit delegation to `getItemsNeedingFetch()` instead of reimplementing coverage.

2. **Staleness for cohort()**: Fixed DSL extraction in §5 to handle `cohort()` clauses; documented t95 vs path_t95 field selection in §6.2.

3. **Case staleness**: Updated §7.2 to include case staleness with a simple >1 day rule. Cases are refreshed if the most recent schedule's `retrieved_at` is more than 1 day ago. Added §7.3 explaining how this integrates with the fetch pipeline.

4. **Execution re-analyses**: Updated §3.1 and §4.3 to show `executeFetchPlan()` always re-runs `analyse()`.

5. **Log linkage**: Added §9.3 with `parentLogId` mechanism and required changes to `fetchDataService`.

6. **File-only handling**: Added §8 with explicit classification table and UX implications.

7. **Component state derivation**: Updated §10.1 to derive spinner state from `plannerResult.status` rather than separate flags.

8. **Distinct tooltip text**: Updated §13.1 to generate different tooltip text for stale parameters ("maturing cohorts") vs stale cases (">1 day old").

9. **Shimmer animation preserved**: Added §10.0 explicitly stating that CSS and shimmer animation are unchanged. Added Effects 3 and 4 in §10.2 showing the preserved shimmer logic. Added §10.3 showing button JSX with same structure.

10. **Auto-aggregation for stale items (bug fix)**: Fixed Effect 2 in §10.2 to trigger auto-aggregation for BOTH `covered_stable` AND `covered_stale` outcomes, per high-level design §3.1.

11. **Out-of-scope clarifications**: Added §11.5-11.7 explicitly stating that `sliceIsolation.ts`, `useFetchData.ts`, and `ScenariosContext.tsx` are out of scope or require no changes.

12. **Existing tests to update**: Added §16.3 listing specific test files that need updates and §16.4 listing missing test scenarios.

13. **Slice matching resolved**: Updated §18.3 with concrete implementation traced from `dataOperationsService.ts` (lines 3646-3657). Uses `extractSliceDimensions()` and `isCohortModeValue()` to find matching slice. Retrieved timestamp is at `data_source.retrieved_at`.
