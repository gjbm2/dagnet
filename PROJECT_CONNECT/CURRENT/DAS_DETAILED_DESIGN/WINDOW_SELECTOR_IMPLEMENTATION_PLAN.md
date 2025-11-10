# Window Selector & Time-Series Aggregation - Implementation Plan

**Feature:** Incremental time-series data fetching with windowed aggregation  
**Status:** 🔵 Design Complete - Ready for Implementation  
**Complexity:** High (procedural but fiddly - needs comprehensive testing)  
**Estimate:** 16-22 hours (8-11 implementation + 8-11 testing)

---

## Overview

This feature enables efficient historical data management:
- **Incremental fetching**: Only fetch missing days from external sources
- **Time-series caching**: Store daily data in parameter files (up to 365 days)
- **Window aggregation**: Aggregate cached data for user-selected date ranges
- **Statistical enhancement**: Plugin architecture for future Bayesian/trend analysis

### Key Design Decisions

1. **Cache Location**: Parameter files (git-friendly, survives IDB clears)
2. **Fetch Strategy**: Incremental only - never re-fetch existing days unless forced
3. **Aggregation**: Naive (sum n, sum k) with enhancement plugin point
4. **Window State**: GraphContext (runtime, not persisted in graph files)

---

## Architecture

### Data Flow

```
┌─────────────────────────────────────────────────────────────────┐
│ User Action: "Get from Source" with window [2025-11-03 to 11-10]│
└─────────────────────────────────────────────────────────────────┘
                          ↓
┌─────────────────────────────────────────────────────────────────┐
│ 1. Query Consistency Check                                      │
│    - Compute query signature (hash of DSL + filters + events)   │
│    - Compare with cached signature                              │
│    - Warn user if changed, offer clear cache option             │
└─────────────────────────────────────────────────────────────────┘
                          ↓
┌─────────────────────────────────────────────────────────────────┐
│ 2. Gap Detection                                                │
│    - File has: [2025-08-12 to 2025-11-08] (days 1-89)          │
│    - Need:     [2025-11-03 to 2025-11-10] (last 7 days)        │
│    - Missing:  [2025-11-09, 2025-11-10] (2 days)               │
└─────────────────────────────────────────────────────────────────┘
                          ↓
┌─────────────────────────────────────────────────────────────────┐
│ 3. Incremental Fetch (ONLY missing days)                        │
│    - Group consecutive days: [[2025-11-09, 2025-11-10]]        │
│    - Fetch with mode='daily' from Amplitude                     │
│    - Returns: [{date: '11-09', n: 1000, k: 320}, ...]          │
└─────────────────────────────────────────────────────────────────┘
                          ↓
┌─────────────────────────────────────────────────────────────────┐
│ 4. Merge & Persist                                              │
│    - Merge new days into param.evidence.time_series             │
│    - Sort by date                                               │
│    - Write to param file                                        │
└─────────────────────────────────────────────────────────────────┘
                          ↓
┌─────────────────────────────────────────────────────────────────┐
│ 5. Window Aggregation (Naive)                                   │
│    - Filter cached data to window [11-03 to 11-10]             │
│    - Sum n = 7000, sum k = 2240                                 │
│    - Compute p = k/n = 0.32                                     │
│    - Compute naive stdev = sqrt(p(1-p)/n) = 0.0056             │
└─────────────────────────────────────────────────────────────────┘
                          ↓
┌─────────────────────────────────────────────────────────────────┐
│ 6. Statistical Enhancement (Plugin Point)                       │
│    - Input: raw aggregation                                     │
│    - Method: 'none' (current) or 'bayesian'/'trend' (future)   │
│    - Output: enhanced mean/stdev/confidence                     │
└─────────────────────────────────────────────────────────────────┘
                          ↓
┌─────────────────────────────────────────────────────────────────┐
│ 7. Update Graph                                                 │
│    - edge.p.mean = 0.32                                         │
│    - edge.p.stdev = 0.0056                                      │
│    - edge.p.evidence = {n, k, window, fetched_at, ...}         │
└─────────────────────────────────────────────────────────────────┘
```

---

## Component Specifications

### 1. QuerySignatureService

**Responsibility:** Detect when query parameters have changed

**File:** `/graph-editor/src/services/QuerySignatureService.ts`

```typescript
interface QuerySignature {
  connection: string;
  event_ids: string[];       // Sorted
  filters: string;           // Normalized JSON
  query_dsl: string;         // Canonical form
  hash: string;              // SHA-256
}

interface ConsistencyCheck {
  consistent: boolean;
  reason?: string;
  diffs?: string[];
}

class QuerySignatureService {
  computeSignature(param, edge, connection): Promise<QuerySignature>
  checkConsistency(param, edge, connection): Promise<ConsistencyCheck>
  private normalizeFilters(filters): string
  private canonicalizeQueryDSL(dsl): string
}
```

**Test Cases:**
1. ✓ Same query → same hash
2. ✓ Reordered visited() nodes → same hash (canonical)
3. ✓ Different event_id → different hash
4. ✓ Different filters → different hash
5. ✓ Different connection → different hash
6. ✓ Filter key order doesn't matter → same hash

---

### 2. IncrementalFetchService

**Responsibility:** Fetch only missing days from external sources

**File:** `/graph-editor/src/services/IncrementalFetchService.ts`

```typescript
interface DateRange {
  start: string;  // YYYY-MM-DD
  end: string;
}

interface TimeSeriesPoint {
  date: string;
  n: number;
  k: number;
  p: number;
}

class IncrementalFetchService {
  fetchMissingDays(param, edge, window, connection): Promise<TimeSeriesPoint[]>
  private detectGaps(existing, window): string[]  // Array of missing dates
  private groupConsecutiveDays(dates): DateRange[]
  private fetchDailyData(param, edge, range, connection): Promise<TimeSeriesPoint[]>
  private expandDateRange(range): string[]
}
```

**Test Cases:**

1. **Empty cache (cold start)**
   - Input: No cached data, need [Day 1 to Day 7]
   - Expected: Fetch all 7 days in one call

2. **Partial overlap (warm cache)**
   - Input: Cached [Day 1 to Day 5], need [Day 3 to Day 8]
   - Expected: Fetch only [Day 6 to Day 8]

3. **Full cache hit**
   - Input: Cached [Day 1 to Day 90], need [Day 84 to Day 90]
   - Expected: Fetch nothing (gap detection returns empty)

4. **Multiple gaps**
   - Input: Cached [Day 1-5, Day 10-15, Day 20-25], need [Day 1 to Day 25]
   - Expected: Fetch [Day 6-9, Day 16-19] as 2 separate calls

5. **Consecutive day grouping**
   - Input: Missing [Day 1, Day 2, Day 3, Day 7, Day 8, Day 15]
   - Expected: Group as [[1-3], [7-8], [15-15]]

6. **Single day gap**
   - Input: Cached [Day 1 to Day 89], need [Day 84 to Day 90]
   - Expected: Fetch [Day 90] only

7. **Future dates**
   - Input: Cached up to today, need [today - 7 days to today + 1]
   - Expected: Fetch only up to today (tomorrow doesn't exist yet)

8. **Non-consecutive cached days**
   - Input: Cached [Day 1, Day 3, Day 5, Day 7], need [Day 1 to Day 7]
   - Expected: Fetch [Day 2, Day 4, Day 6] as separate calls (or optimize grouping)

---

### 3. WindowAggregationService

**Responsibility:** Aggregate cached time-series for a date range

**File:** `/graph-editor/src/services/WindowAggregationService.ts`

```typescript
interface RawAggregation {
  method: 'naive';
  n: number;
  k: number;
  mean: number;
  stdev: number;
  raw_data: TimeSeriesPoint[];
  window: DateRange;
}

class WindowAggregationService {
  aggregateWindow(timeSeries, window): RawAggregation
}
```

**Test Cases:**

1. **Simple aggregation**
   - Input: 7 days, each with n=1000, k=300
   - Expected: n=7000, k=2100, p=0.3

2. **Variable sample sizes**
   - Input: [n=1000, k=300], [n=500, k=150], [n=2000, k=600]
   - Expected: n=3500, k=1050, p=0.3

3. **Empty window (no data)**
   - Input: Cached [Day 1-10], window [Day 20-30]
   - Expected: Error "No data available for window"

4. **Partial window (some days missing)**
   - Input: Cached [Day 1, Day 2, Day 5, Day 6, Day 7], window [Day 1-7]
   - Expected: Aggregate only available days (warn user?)

5. **Single day window**
   - Input: Cached [Day 1-90], window [Day 45-45]
   - Expected: n=Day45.n, k=Day45.k, p=Day45.p

6. **Zero conversions**
   - Input: 7 days, all with k=0
   - Expected: n=7000, k=0, p=0, stdev=0

7. **Zero sample size (data error)**
   - Input: Some days have n=0
   - Expected: Skip those days or error

8. **Extreme values**
   - Input: One day with n=1000000, k=500000 among normal days
   - Expected: Correct weighted aggregation

---

### 4. StatisticalEnhancementService

**Responsibility:** Plugin point for future statistical methods

**File:** `/graph-editor/src/services/StatisticalEnhancementService.ts`

```typescript
interface EnhancedAggregation {
  method: string;
  n: number;
  k: number;
  mean: number;
  stdev: number;
  confidence_interval?: [number, number] | null;
  trend?: {
    direction: 'increasing' | 'decreasing' | 'stable';
    slope: number;
    significance: number;
  } | null;
  metadata: {
    raw_method: string;
    enhancement_method: string;
    data_points: number;
  };
}

interface StatisticalEnhancer {
  enhance(raw: RawAggregation): EnhancedAggregation;
}

class StatisticalEnhancementService {
  enhance(raw, method): EnhancedAggregation
  registerEnhancer(name, enhancer): void
}

class NoOpEnhancer implements StatisticalEnhancer {
  enhance(raw): EnhancedAggregation  // Pass-through
}
```

**Test Cases (v1 - NoOp only):**

1. **Pass-through**
   - Input: {method: 'naive', n: 1000, k: 300, mean: 0.3, stdev: 0.0145}
   - Expected: Same values returned with metadata

2. **Unknown method fallback**
   - Input: enhance(raw, 'bayesian')
   - Expected: Warn, fallback to 'none'

**Test Cases (v2 - Future Bayesian):**

3. **Bayesian with prior**
   - Input: Prior Beta(α=300, β=700), new data n=100, k=30
   - Expected: Posterior mean shrunk toward prior

4. **Sparse data**
   - Input: Only 2 days of data, high variance
   - Expected: Wide confidence interval, prior-weighted

---

### 5. Updated Evidence Schema

**File:** `/graph-editor/public/schemas/parameter-schema.json`

```json
{
  "evidence": {
    "type": "object",
    "properties": {
      "n": { "type": "number" },
      "k": { "type": "number" },
      "mean": { "type": "number" },
      "stdev": { "type": "number" },
      "source": { "type": "string" },
      "fetched_at": { "type": "string", "format": "date-time" },
      "window_from": { "type": "string", "format": "date" },
      "window_to": { "type": "string", "format": "date" },
      "query_signature": { "type": "string" },
      "query_dsl": { "type": "string" },
      "event_ids": { "type": "array", "items": { "type": "string" } },
      "filters_hash": { "type": "string" },
      "aggregation_method": { "enum": ["naive", "bayesian", "trend-aware", "robust"] },
      "time_series": {
        "type": "array",
        "items": {
          "type": "object",
          "required": ["date", "n", "k", "p"],
          "properties": {
            "date": { "type": "string", "format": "date" },
            "n": { "type": "number", "minimum": 0 },
            "k": { "type": "number", "minimum": 0 },
            "p": { "type": "number", "minimum": 0, "maximum": 1 }
          }
        }
      }
    }
  }
}
```

**TypeScript Types:**

**File:** `/graph-editor/src/types/parameter.ts`

```typescript
export interface TimeSeriesPoint {
  date: string;  // YYYY-MM-DD
  n: number;
  k: number;
  p: number;
}

export interface Evidence {
  n: number;
  k: number;
  mean: number;
  stdev: number;
  source: string;
  fetched_at: string;
  window_from: string;
  window_to: string;
  query_signature?: string;
  query_dsl?: string;
  event_ids?: string[];
  filters_hash?: string;
  aggregation_method: 'naive' | 'bayesian' | 'trend-aware' | 'robust';
  time_series?: TimeSeriesPoint[];
}
```

---

### 6. Amplitude Adapter (Daily Mode)

**File:** `/graph-editor/public/defaults/connections.yaml`

Update Amplitude adapter to support daily mode:

```yaml
connections:
  - name: amplitude-prod
    provider: amplitude
    adapter:
      request:
        endpoint: POST /api/2/funnels
        body_template: |
          {
            "events": [{{#events}}{...}{{/events}}],
            "mode": "{{context.mode}}",  # 'daily' or 'aggregate'
            "start": "{{window.start}}",
            "end": "{{window.end}}",
            "i": 1
          }
      response:
        extract:
          # For aggregate mode (current)
          jmes_aggregate: "data[0].cumulativeRaw[0]"
          
          # For daily mode (new)
          jmes_daily: "data[0].series[] | [*].[date, cumulativeRaw[0], cumulativeRaw[1]]"
          # Returns: [["2025-11-09", 1000, 320], ["2025-11-10", 1050, 336], ...]
        
        transform:
          - jsonata: |
              (
                $mode := $context.mode;
                $mode = 'daily' ? 
                  $result.jmes_daily ~> $map(function($v) {
                    {
                      "date": $v[0],
                      "n": $v[1],
                      "k": $v[2],
                      "p": $v[2] / $v[1]
                    }
                  }) : {
                    "n": $result.jmes_aggregate[0],
                    "k": $result.jmes_aggregate[1],
                    "p": $result.jmes_aggregate[1] / $result.jmes_aggregate[0]
                  }
              )
```

**Test Cases:**

1. **Daily mode returns time-series**
   - Input: mode='daily', window [Day 1 to Day 7]
   - Expected: Array of 7 {date, n, k, p} objects

2. **Aggregate mode returns single value**
   - Input: mode='aggregate', window [Day 1 to Day 7]
   - Expected: Single {n, k, p} object

3. **Amplitude API error (404, 500)**
   - Expected: Throw with helpful message

4. **Empty result (no data for date range)**
   - Expected: Return empty array with warning

---

### 7. WindowSelector UI Component

**File:** `/graph-editor/src/components/WindowSelector.tsx`

```typescript
export function WindowSelector() {
  const { dataFetchContext, setWindow } = useGraphContext();
  const [dateRange, setDateRange] = useState<[Dayjs, Dayjs]>([
    dayjs().subtract(7, 'days'),
    dayjs()
  ]);
  
  const handleChange = (newRange: [Dayjs | null, Dayjs | null]) => {
    if (newRange[0] && newRange[1]) {
      setDateRange(newRange as [Dayjs, Dayjs]);
      setWindow({
        start: newRange[0].format('YYYY-MM-DD'),
        end: newRange[1].format('YYYY-MM-DD')
      });
    }
  };
  
  return (
    <Box sx={{ /* floating position */ }}>
      <DateRangePicker
        value={dateRange}
        onChange={handleChange}
        maxDate={dayjs()}  // Can't select future dates
      />
    </Box>
  );
}
```

**Test Cases (UI):**

1. **Default window (last 7 days)**
   - Expected: Picker shows [today - 7, today]

2. **Change window**
   - User selects [Day 1, Day 30]
   - Expected: Context updated, graph re-aggregates

3. **Invalid ranges (end before start)**
   - Expected: Validation error

4. **Future dates disabled**
   - Expected: Cannot select tomorrow

5. **Window persisted per graph (localStorage)**
   - Expected: Close/reopen graph → window restored

---

## Integration Tests (End-to-End)

### Scenario 1: Cold Start (No Cached Data)

**Setup:**
- Parameter file has no `evidence.time_series`
- User selects window [2025-11-03 to 2025-11-10] (7 days)
- Clicks "Get from Source"

**Expected Flow:**
1. ✓ Query signature computed (no previous to compare)
2. ✓ Gap detection: All 7 days missing
3. ✓ Fetch 7 days from Amplitude (mode='daily')
4. ✓ Write to param file: `time_series: [{date: '11-03', ...}, ..., {date: '11-10', ...}]`
5. ✓ Aggregate: n=7000, k=2240, p=0.32
6. ✓ Enhance: NoOp (pass-through)
7. ✓ Update graph: edge.p.mean=0.32, edge.p.evidence.n=7000

**Verify:**
- Param file has 7 time-series entries
- Graph shows p=0.32
- Console log: "✓ Fetched 7 days from amplitude-prod"

---

### Scenario 2: Incremental Update (Next Day)

**Setup:**
- Parameter file has cached data [Day 1 to Day 89]
- Today is Day 90
- User selects window [Day 84 to Day 90] (last 7 days)
- Clicks "Get from Source"

**Expected Flow:**
1. ✓ Query signature matches (consistent)
2. ✓ Gap detection: Only Day 90 missing
3. ✓ Fetch 1 day from Amplitude
4. ✓ Merge into param file: `time_series` now has 90 entries
5. ✓ Aggregate: Filter to [Day 84-90], sum n/k
6. ✓ Update graph

**Verify:**
- Only 1 API call made
- Param file has 90 entries (not duplicates)
- Console log: "✓ Fetched 1 day from amplitude-prod"

---

### Scenario 3: Window Change (Pure Aggregation)

**Setup:**
- Parameter file has cached data [Day 1 to Day 90]
- Current window: [Day 84 to Day 90]
- User changes window to: [Day 60 to Day 90] (30 days)

**Expected Flow:**
1. ✓ Gap detection: No gaps (all cached)
2. ✓ No API call
3. ✓ Aggregate: Filter to [Day 60-90], sum n/k
4. ✓ Update graph instantly

**Verify:**
- No API call
- Graph updates immediately (<100ms)
- Console log: "✓ All data cached, no fetch needed"

---

### Scenario 4: Query Changed (Inconsistency)

**Setup:**
- Parameter file has cached data with query_signature: "abc123"
- User changes event filter (e.g., adds property filter)
- Clicks "Get from Source"

**Expected Flow:**
1. ✓ Query signature computed: "def456"
2. ✓ Consistency check fails
3. ✓ Dialog shown: "Query changed. Clear cache?"
4. User clicks "Clear & Refetch"
5. ✓ Clear `time_series`
6. ✓ Fetch full window (as if cold start)

**Verify:**
- Warning dialog shown
- After clear: param file has new query_signature
- Cache rebuilt with new query

---

### Scenario 5: Multiple Gaps (Fragmented Cache)

**Setup:**
- Parameter file has cached [Day 1-10, Day 20-30, Day 40-50]
- User selects window [Day 1 to Day 50]

**Expected Flow:**
1. ✓ Gap detection: Missing [Day 11-19, Day 31-39]
2. ✓ Group gaps: [[11-19], [31-39]]
3. ✓ Fetch 2 ranges in parallel (2 API calls)
4. ✓ Merge into param file
5. ✓ Aggregate across all 50 days

**Verify:**
- 2 API calls made (parallel)
- Param file has 50 continuous entries
- Console log: "✓ Fetched 18 days from amplitude-prod (2 ranges)"

---

### Scenario 6: Large Window (90 Days)

**Setup:**
- Empty cache
- User selects window [Day 1 to Day 90]
- Amplitude has daily data available

**Expected Flow:**
1. ✓ Fetch 90 days from Amplitude (mode='daily')
2. ✓ Write to param file (~270 lines for time_series)
3. ✓ Aggregate: Sum all 90 days
4. ✓ Update graph

**Verify:**
- Single API call (Amplitude supports up to 365 days)
- Param file size reasonable (<50KB)
- Subsequent window changes are instant

---

### Scenario 7: Edge vs Parameter File (Direct Mode)

**Setup:**
- Edge has `p.connection = 'amplitude-prod'` but NO parameter file
- User clicks "Get from Source (direct)"

**Expected Flow:**
1. ✓ No param file to cache in
2. ✓ Fetch data (mode='aggregate', not 'daily')
3. ✓ Update graph directly (no caching)
4. ✓ evidence stored on edge.p.evidence (no time_series)

**Verify:**
- No param file created/modified
- Edge has evidence but no time_series
- Next fetch re-fetches (no cache)

---

## Test Suite Structure

### Unit Tests

**File:** `/graph-editor/src/services/__tests__/QuerySignatureService.test.ts`
- 6 test cases for signature consistency

**File:** `/graph-editor/src/services/__tests__/IncrementalFetchService.test.ts`
- 8 test cases for gap detection & grouping

**File:** `/graph-editor/src/services/__tests__/WindowAggregationService.test.ts`
- 8 test cases for aggregation math

**File:** `/graph-editor/src/services/__tests__/StatisticalEnhancementService.test.ts`
- 2 test cases for NoOp enhancer

**Total Unit Tests:** ~24 tests

---

### Integration Tests

**File:** `/graph-editor/src/services/__tests__/DataOperationsService.integration.test.ts`

Test all 7 scenarios above with:
- Mock Amplitude API responses
- Mock UpdateManager
- Mock parameter file I/O
- Real date arithmetic

**Total Integration Tests:** 7 scenarios × ~5 assertions each = ~35 assertions

---

### E2E Tests (Manual / Playwright)

**File:** `/graph-editor/e2e/window-selector.spec.ts`

1. Load graph with parameter
2. Open window selector
3. Change date range
4. Verify graph updates
5. Check console logs for cache hits

**Total E2E Tests:** 3-5 user flows

---

## Implementation Phases

### Phase 1: Schema & Types (2 hours)

**Tasks:**
- [ ] Update `parameter-schema.json` with time_series field
- [ ] Update TypeScript types (Evidence, TimeSeriesPoint)
- [ ] Add query signature fields to Evidence
- [ ] Validate schemas

**Tests:**
- [ ] Schema validation passes
- [ ] TypeScript compiles without errors

**Gate:** Schemas locked

---

### Phase 2: Query Signature Service (2-3 hours)

**Tasks:**
- [ ] Implement `computeSignature()`
- [ ] Implement `checkConsistency()`
- [ ] Add filter normalization
- [ ] Add DSL canonicalization

**Tests:**
- [ ] Unit tests: 6 signature tests
- [ ] Mock crypto.subtle.digest for deterministic hashes

**Gate:** All 6 unit tests pass

---

### Phase 3: Incremental Fetch Service (3-4 hours)

**Tasks:**
- [ ] Implement `detectGaps()`
- [ ] Implement `groupConsecutiveDays()`
- [ ] Implement `fetchMissingDays()`
- [ ] Add date range utilities

**Tests:**
- [ ] Unit tests: 8 gap detection tests
- [ ] Mock DASRunner responses

**Gate:** All 8 unit tests pass

---

### Phase 4: Aggregation Services (2-3 hours)

**Tasks:**
- [ ] Implement `WindowAggregationService.aggregateWindow()`
- [ ] Implement `StatisticalEnhancementService` (NoOp only)
- [ ] Add mergeTimeSeries utility

**Tests:**
- [ ] Unit tests: 8 aggregation tests
- [ ] Unit tests: 2 enhancement tests

**Gate:** All 10 unit tests pass

---

### Phase 5: Amplitude Adapter Update (2 hours)

**Tasks:**
- [ ] Add `mode: 'daily'` support to connections.yaml
- [ ] Update response extraction for daily mode
- [ ] Add transform logic for daily vs aggregate

**Tests:**
- [ ] Mock Amplitude API with daily response
- [ ] Verify time-series extraction
- [ ] Verify aggregate extraction

**Gate:** Both modes working

---

### Phase 6: Integration (2-3 hours)

**Tasks:**
- [ ] Update `DataOperationsService.getFromSourceWithWindow()`
- [ ] Integrate all services
- [ ] Add consistency check UI dialog
- [ ] Add progress indicators

**Tests:**
- [ ] Integration tests: 7 scenarios
- [ ] Mock all external dependencies

**Gate:** All 7 scenarios pass

---

### Phase 7: Window Selector UI (2-3 hours)

**Tasks:**
- [ ] Implement WindowSelector component
- [ ] Add to GraphEditor
- [ ] Hook up to GraphContext
- [ ] Add localStorage persistence

**Tests:**
- [ ] Component renders
- [ ] Date range changes trigger re-aggregation
- [ ] Invalid ranges rejected

**Gate:** UI functional

---

### Phase 8: Testing & Polish (3-4 hours)

**Tasks:**
- [ ] Run full test suite
- [ ] Fix any discovered bugs
- [ ] Add error handling & user messages
- [ ] Performance testing (1000+ cached days)
- [ ] Documentation

**Tests:**
- [ ] All 24 unit tests pass
- [ ] All 7 integration tests pass
- [ ] 3 E2E tests pass
- [ ] Performance: Aggregation <100ms for 365 days

**Gate:** 100% test pass rate

---

## Success Criteria

### Functional Requirements

- [ ] User can select date range with WindowSelector
- [ ] Only missing days fetched from Amplitude
- [ ] Time-series cached in parameter files
- [ ] Window changes trigger instant re-aggregation (no API calls)
- [ ] Query changes detected and user warned
- [ ] Multiple gaps handled correctly
- [ ] Large windows (90+ days) work efficiently

### Performance Requirements

- [ ] Gap detection: <10ms for 365 cached days
- [ ] Aggregation: <100ms for 365 cached days
- [ ] Fetch optimization: Grouped consecutive days
- [ ] UI responsive: Window change updates graph in <200ms (cached data)

### Quality Requirements

- [ ] 24+ unit tests passing
- [ ] 7 integration scenarios passing
- [ ] 3+ E2E tests passing
- [ ] No TypeScript errors
- [ ] No schema validation errors
- [ ] Clear error messages for all failure modes

### User Experience Requirements

- [ ] Clear feedback on cache hits vs fetches
- [ ] Progress indicators for API calls
- [ ] Warning dialogs for query changes
- [ ] Helpful error messages
- [ ] Console logs for debugging

---

## Edge Cases & Error Handling

### Edge Cases

1. **Leap years** - Date math handles Feb 29
2. **Time zones** - All dates in UTC, no time component
3. **DST transitions** - Not applicable (dates only)
4. **Very old data** - Support up to 2 years back
5. **Future dates** - Reject in UI, filter in backend
6. **Single-day windows** - Handle correctly
7. **Empty results** - Warn user, don't crash
8. **Duplicate dates** - Newer data wins on merge
9. **Out-of-order dates** - Always sort after merge
10. **Zero sample sizes** - Skip or error with message

### Error Handling

1. **API failures** → Retry once, then show error dialog
2. **Network timeout** → Show "Fetching is slow..." message
3. **Invalid date ranges** → Validation error in UI
4. **Missing event_id** → Error with fix instructions
5. **Query signature mismatch** → User dialog with diff
6. **Cache corruption** → Clear and refetch
7. **Insufficient data** → Warn "Only X of Y days available"
8. **Amplitude rate limit** → Exponential backoff + message

---

## Performance Optimization

### Implemented

1. **Gap grouping** - Batch consecutive days into single API call
2. **Parallel fetches** - Multiple gaps fetched simultaneously
3. **Incremental only** - Never refetch existing data
4. **In-memory aggregation** - Fast sum/filter operations
5. **Lazy time-series** - Only load when needed

### Future Optimizations

1. **Binary search** - For finding date ranges in sorted array
2. **Indexing** - Hash map for O(1) date lookups
3. **Compression** - Gzip time_series in parameter files
4. **Pagination** - For very large time_series (1000+ days)
5. **Web Worker** - Offload aggregation for huge datasets

---

## Documentation

### User-Facing Docs

- [ ] How to use Window Selector
- [ ] Understanding cache vs live fetches
- [ ] What to do when query changes
- [ ] Performance tips (fetch large windows once)

### Developer Docs

- [ ] Architecture overview
- [ ] Service interfaces
- [ ] Test strategy
- [ ] How to add new statistical enhancers

---

## Rollout Plan

### Phase 1: Internal Testing (Week 1)
- Deploy to dev environment
- Test with real Amplitude data
- Fix bugs, tune performance

### Phase 2: Beta Users (Week 2)
- Enable for 2-3 power users
- Gather feedback on UX
- Monitor cache hit rates

### Phase 3: General Availability (Week 3)
- Deploy to production
- Announce feature
- Monitor performance metrics

---

## Future Enhancements

### v2: Bayesian Statistics
- Beta-binomial prior/posterior
- Credible intervals
- Shrinkage for sparse data

### v3: Trend Detection
- Linear regression on daily p values
- Anomaly detection
- Seasonality analysis

### v4: Multi-Source Aggregation
- Combine Amplitude + Sheets + PostgreSQL
- Weighted averages across sources
- Conflict resolution

### v5: Predictive Analytics
- Forecast future conversions
- Detect concept drift
- Recommend optimal window sizes

---

## Appendix: Example Parameter File

**Before (no time-series):**

```yaml
id: p_signup_to_onboard
mean: 0.32
stdev: 0.05
connection: amplitude-prod
evidence:
  n: 7000
  k: 2240
  source: amplitude-prod
  fetched_at: 2025-11-10T14:30:00Z
  window_from: 2025-11-03
  window_to: 2025-11-10
```

**After (with time-series cache):**

```yaml
id: p_signup_to_onboard
mean: 0.32
stdev: 0.05
connection: amplitude-prod
evidence:
  n: 7000
  k: 2240
  source: amplitude-prod
  fetched_at: 2025-11-10T14:30:00Z
  window_from: 2025-11-03
  window_to: 2025-11-10
  query_signature: "a1b2c3d4e5f6..."
  query_dsl: "from(signup).to(onboard)"
  event_ids: ["household-created", "delegation-completed"]
  filters_hash: '{"level":["DO_ALL_OF_IT_FOR_ME"]}'
  aggregation_method: naive
  time_series:
    - date: 2025-08-12
      n: 1000
      k: 320
      p: 0.320
    - date: 2025-08-13
      n: 1050
      k: 336
      p: 0.320
    # ... 88 more days ...
    - date: 2025-11-10
      n: 980
      k: 314
      p: 0.320
```

---

**Total Estimate:** 16-22 hours
- Implementation: 8-11 hours (Phases 1-7)
- Testing: 8-11 hours (Phase 8 + ongoing)

**Complexity:** High - procedural and fiddly, requires thorough testing

**Status:** Ready to implement

---

*Document created: 2025-11-10*  
*Next step: Begin Phase 1 (Schema & Types)*

