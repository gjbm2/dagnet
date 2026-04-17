# Project TODOs

## Data Fetch Architecture

---

### 1. Date Format Standardization ✓ COMPLETED
**Priority: HIGH** | **Effort: 3-4 days** | **Risk: Medium**

Standardize all dates to `d-mmm-yy` format (e.g., `1-Dec-25`).
- ✓ Added conversion utilities (`toISO`, `fromISO`, `normalizeToUK`)
- ✓ Updated storage layer (`windowAggregationService`, `dataOperationsService`)
- ✓ Updated graph evidence fields (`UpdateManager`)
- ✓ Updated UI components (`DateRangePicker`)
- ✓ Updated tests to expect UK format

#### Implementation Plan

**Phase 1: Core Utilities (2 hours)**

1. Add conversion functions to `src/lib/dateFormat.ts`:
```typescript
// Convert UK date to ISO for API calls
export function toISO(ukDate: string): string {
  const d = parseUKDate(ukDate);
  return d.toISOString().split('T')[0]; // "2025-12-01"
}

// Convert ISO to UK date from API responses
export function fromISO(isoDate: string): string {
  return formatDateUK(isoDate);
}

// Detect format and normalize to UK
export function normalizeToUK(date: string): string {
  if (date.match(/^\d{4}-\d{2}-\d{2}/)) {
    return fromISO(date);
  }
  return date; // Already UK format
}
```

2. Update `windowAggregationService.ts`:
   - Replace `normalizeDate()` to return UK format
   - Update all date comparisons to use UK format

**Phase 2: Storage Layer (4 hours)**

1. `dataOperationsService.ts`:
   - Update `getFromSource()` to convert API response dates to UK
   - Update file writing to use UK dates
   - Update `getParameterFromFile()` date handling

2. Add auto-migration on file load:
```typescript
// In file loading code
function migrateFileDates(fileData: any): any {
  if (fileData.values) {
    for (const value of fileData.values) {
      if (value.dates) {
        value.dates = value.dates.map(normalizeToUK);
      }
    }
  }
  return fileData;
}
```

**Phase 3: Graph Evidence Fields (2 hours)**

Update `UpdateManager.ts`:
- `window_from`, `window_to` in evidence objects
- Add migration for existing graph files

**Phase 4: UI Components (2 hours)**

1. `DateRangePicker.tsx` - ensure UK format in state
2. `WindowSelector.tsx` - verify date handling
3. `PropertiesPanel.tsx` - display dates in UK format

**Phase 5: Tests (4 hours)**

1. Update test fixtures (batch find/replace)
2. Add format validation tests
3. Run full test suite

#### Acceptance Criteria
- [ ] `formatDateUK()` used for all display/storage
- [ ] `parseUKDate()` used for all parsing
- [ ] ISO only at API boundary (conversion functions)
- [ ] All tests pass
- [ ] No ISO dates in saved files

---

### 2. Simplify Window/Context Check in WindowSelector ✓ COMPLETED
**Priority: MEDIUM** | **Effort: 2 hours** | **Risk: Low**

~~Currently WindowSelector checks window and context separately. Since window IS part of DSL, this is redundant.~~

**Implemented**: Now uses single DSL comparison instead of separate window + context checks.

#### Current Code (lines 462-467)
```typescript
// Redundant: window is already IN the DSL
if (windowsMatch(normalizedWindow, normalizedLastAggregated) && currentDSL === lastDSL) {
  setNeedsFetch(false);
  return;
}
```

#### Target Code
```typescript
// Single check: DSL contains everything
if (currentDSL === lastAggregatedDSLRef.current) {
  setNeedsFetch(false);
  return;
}
```

#### Implementation Plan

**Step 1: Remove redundant state (30 min)**

In `WindowSelector.tsx`:
```typescript
// REMOVE these:
const [lastAggregatedWindow, setLastAggregatedWindow] = useState<DateRange | null>(null);
const lastAggregatedWindowRef = useRef<DateRange | null>(null);

// KEEP only:
const lastAggregatedDSLRef = useRef<string | null>(null);
```

**Step 2: Simplify comparison logic (30 min)**

Replace lines 462-475 with:
```typescript
// DSL contains window + context - single source of truth
if (dslFromState === lastAggregatedDSLRef.current) {
  setNeedsFetch(false);
  return;
}
```

**Step 3: Update cache key (15 min)**

Simplify line 486:
```typescript
// BEFORE
const cacheKey = `${windowKey}|${currentGraphHash}|${dslKey}`;

// AFTER
const cacheKey = `${dslFromState}|${currentGraphHash}`;
```

**Step 4: Clean up refs (15 min)**

Remove `lastAggregatedWindowRef` updates throughout the file.
Keep only `lastAggregatedDSLRef` updates.

**Step 5: Test (30 min)**

- Test window change triggers re-aggregation
- Test context change triggers re-aggregation
- Test same DSL skips re-aggregation

#### Files Changed
- `src/components/WindowSelector.tsx`

---

### 3. Refactor WindowSelector Auto-Aggregation to Use Hook ✓ COMPLETED
**Priority: MEDIUM** | **Effort: 4 hours** | **Risk: Medium**

~~WindowSelector's auto-aggregation bypasses `useFetchData` hook, creating two code paths.~~

**Implemented**: Auto-aggregation now uses `useFetchData` hook with `mode: 'from-file'`. 
Both Fetch button and auto-aggregation use the same code path through the hook.

#### Current Flow (two paths)
```
Fetch button click:
  → useFetchData.fetchDataBatch()
  → dataOperationsService.getFromSource()

Auto-aggregation on window change:
  → dataOperationsService.getParameterFromFile() ← BYPASSES HOOK
```

#### Target Flow (one path)
```
Fetch button click:
  → useFetchData.fetchDataBatch()
  → dataOperationsService.getFromSource()

Auto-aggregation on window change:
  → useFetchData.fetchItem(..., { mode: 'from-file' })
  → dataOperationsService.getParameterFromFile()
```

#### Implementation Plan

**Step 1: Extract items for auto-aggregation (1 hour)**

Create a function to build FetchItems from paramsToAggregate:
```typescript
// In WindowSelector.tsx
import { createFetchItem, FetchItem } from '../hooks/useFetchData';

function buildFetchItems(paramsToAggregate: Array<{paramId, edgeId, slot}>): FetchItem[] {
  return paramsToAggregate.map(({ paramId, edgeId, slot }) => 
    createFetchItem('parameter', paramId, edgeId, { paramSlot: slot })
  );
}
```

**Step 2: Update auto-aggregation to use hook (2 hours)**

Replace lines 665-684 (the for loop calling service directly):

```typescript
// BEFORE (lines 669-683)
for (const { paramId, edgeId, slot } of paramsToAggregate) {
  await dataOperationsService.getParameterFromFile({
    paramId,
    edgeId,
    graph: updatedGraph,
    setGraph: (g) => { if (g) updatedGraph = g; },
    targetSlice: dslFromState,
  });
}

// AFTER
const items = buildFetchItems(paramsToAggregate);
await fetchItems(items, { mode: 'from-file' });
```

**Step 3: Handle graph ref updates (1 hour)**

The hook needs to work with refs for batch operations. Ensure:
```typescript
const { fetchItem, fetchItems } = useFetchData({
  graph: () => graphRef.current,  // Getter for fresh state
  setGraph: (g) => {
    if (g) {
      graphRef.current = g;
      setGraph(g);
    }
  },
  currentDSL: () => dslFromState,  // Getter for current DSL
});
```

**Step 4: Remove duplicate code paths**

Remove the direct service calls in:
- Lines 505-511 (cached result aggregation)
- Lines 672-680 (computed result aggregation)

Both should use `fetchItems()` from the hook.

**Step 5: Test**

- Test auto-aggregation still works
- Test Fetch button still works
- Test batch operations still work
- Verify single code path in logs

#### Files Changed
- `src/components/WindowSelector.tsx`
- `src/hooks/useFetchData.ts` (may need minor updates for batch getters)

#### Rollback Plan
If issues arise, revert to direct service calls - the hook is a wrapper, not new functionality.

---

## UI/UX

### 4. Scenario Legend Chip Hover Fix
**Status: DONE** ✓

Fixed oscillation when chip expands and wraps lines.

### 5. Edge Tooltip Redesign
**Status: TODO**

Tooltips need proper redesign to show data provenance (which slices contributed to evidence/forecast), completeness, and lag info. Currently tooltips are ad-hoc.

### 6. Semi-Transparent Current Layer Rendering
**Status: TODO**

Current "hidden layer" rendering (semi-transparent) is confusing and will become more so with Project LAG adding striped forecast/evidence layers. Need to rethink visual treatment for hidden vs visible vs forecast vs evidence states.

---

## Implementation Order

1. **Item 2** (Simplify checks) - Low risk, quick win, simplifies code for item 3
2. **Item 3** (Refactor to hook) - Medium risk, depends on item 2
3. **Item 1** (Date format) - Can be done in parallel, independent

## Test Strategy

For each item:
1. Run relevant tests: `npm test -- --run --testNamePattern="<pattern>"`
2. Manual test in app
3. Only run full suite if changes are pervasive

## Notes

- All implementations should maintain backward compatibility during rollout
- Add feature flags if needed for gradual rollout
- Update `data-fetch-architecture.md` after each change
