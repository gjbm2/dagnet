# Window Selector & Time-Series Caching - Quick Summary

**Status:** 🔵 Ready for Implementation  
**Estimate:** 16-22 hours  
**Complexity:** High (procedural but fiddly)

---

## What This Enables

### User Workflow

```
1. User selects date range: [Last 7 days]
2. Clicks "Get from Source" on parameter
3. System checks cache: 5 days cached, need 2 more
4. Fetches ONLY 2 missing days from Amplitude
5. Aggregates all 7 days → p = 0.32
6. Updates graph
7. Next time: ALL 7 days cached → instant (no API call)
```

### Key Benefits

- ✅ **Incremental fetching** - Only fetch missing days (1 day vs 90 days)
- ✅ **Smart caching** - Store up to 365 days in parameter files
- ✅ **Instant window changes** - Re-aggregate cached data without API calls
- ✅ **Query consistency** - Detect when filters change, warn user
- ✅ **Future-proof** - Plugin architecture for Bayesian statistics later

---

## Architecture Overview

### 4 Core Services

```typescript
// 1. Detect query changes (prevent cache poisoning)
QuerySignatureService.computeSignature()
  → SHA-256 hash of: connection + events + filters + DSL

// 2. Fetch only missing days (optimize API calls)
IncrementalFetchService.fetchMissingDays()
  → Gap detection → Grouped fetches → Merge with cache

// 3. Aggregate cached data for window
WindowAggregationService.aggregateWindow()
  → Filter to window → Sum n, sum k → Naive p & stdev

// 4. Enhance with statistics (plugin point)
StatisticalEnhancementService.enhance()
  → v1: NoOp (pass-through)
  → v2: Bayesian, trend detection, robust estimators
```

### Data Flow

```
User selects window
  ↓
Query consistency check (compare hash)
  ↓
Gap detection (which days missing?)
  ↓
Incremental fetch (API call for gaps only)
  ↓
Merge & persist (update param file)
  ↓
Window aggregation (filter + sum)
  ↓
Statistical enhancement (plugin point)
  ↓
Update graph (edge.p.mean, evidence)
```

---

## Edge Cases Handled

### 1. Cold Start
- **Problem:** No cached data
- **Solution:** Fetch full window (as normal)

### 2. Daily Update
- **Problem:** Have 89 days, need 90
- **Solution:** Fetch 1 day only, merge into cache

### 3. Window Change
- **Problem:** Have 90 days cached, user changes window 7→30 days
- **Solution:** Re-aggregate instantly (no API call)

### 4. Query Changed
- **Problem:** User adds filter, cache now inconsistent
- **Solution:** Detect via hash, warn user, offer "Clear & Refetch"

### 5. Multiple Gaps
- **Problem:** Have [Days 1-10, 20-30], need [Days 1-30]
- **Solution:** Fetch [Days 11-19], group consecutive for efficiency

### 6. Fragmented Cache
- **Problem:** Have days 1, 3, 5, 7, need days 1-7
- **Solution:** Fetch days 2, 4, 6 (3 API calls or 3 grouped ranges)

### 7. Direct Mode (No Param File)
- **Problem:** Edge connection, no param file to cache in
- **Solution:** Fetch aggregate (not daily), store on edge.p.evidence only

### 8. Large Window (90 Days)
- **Problem:** Need 90 days, slow to fetch?
- **Solution:** Amplitude supports mode='daily' up to 365 days in 1 call

---

## Schema Updates

### Parameter Evidence (Extended)

```typescript
interface Evidence {
  // Existing fields
  n: number;
  k: number;
  mean: number;
  stdev: number;
  source: string;
  fetched_at: string;
  window_from: string;
  window_to: string;
  
  // NEW: Query consistency
  query_signature: string;      // SHA-256 hash
  query_dsl: string;             // Canonical DSL
  event_ids: string[];           // Resolved events
  filters_hash: string;          // Normalized filters
  
  // NEW: Time-series cache
  time_series?: TimeSeriesPoint[];
  aggregation_method: 'naive' | 'bayesian' | 'trend-aware' | 'robust';
}

interface TimeSeriesPoint {
  date: string;  // YYYY-MM-DD
  n: number;
  k: number;
  p: number;
}
```

### Example Parameter File

```yaml
id: p_signup_to_onboard
mean: 0.32
connection: amplitude-prod
evidence:
  n: 7000
  k: 2240
  query_signature: "a1b2c3d4..."
  query_dsl: "from(signup).to(onboard)"
  aggregation_method: naive
  time_series:
    - {date: 2025-08-12, n: 1000, k: 320, p: 0.320}
    - {date: 2025-08-13, n: 1050, k: 336, p: 0.320}
    # ... 88 more days
    - {date: 2025-11-10, n: 980, k: 314, p: 0.320}
```

---

## Testing Strategy

### Unit Tests (24 tests)

**QuerySignatureService (6 tests)**
- Same query → same hash
- Reordered visited() → same hash (canonical)
- Different filters → different hash
- Different events → different hash

**IncrementalFetchService (8 tests)**
- Empty cache → fetch all
- Partial overlap → fetch gap only
- Full cache → fetch nothing
- Multiple gaps → group consecutive
- Single day gap
- Non-consecutive cached days

**WindowAggregationService (8 tests)**
- Simple aggregation (sum n, sum k)
- Variable sample sizes
- Empty window error
- Single day window
- Zero conversions
- Extreme values

**StatisticalEnhancementService (2 tests)**
- NoOp pass-through
- Unknown method fallback

### Integration Tests (7 scenarios)

1. **Cold start** - No cache, fetch full window
2. **Incremental update** - Have 89 days, need 90, fetch 1 day
3. **Window change** - Pure aggregation, no API call
4. **Query changed** - Hash mismatch, user warned
5. **Multiple gaps** - Fetch 2 ranges in parallel
6. **Large window** - Fetch 90 days efficiently
7. **Direct mode** - No param file, no cache

### E2E Tests (3-5 flows)

- User changes window → graph updates
- User changes filter → warning shown
- Multiple parameters → parallel fetches

---

## Implementation Phases

### Phase 1: Schema & Types (2 hrs)
- Update `parameter-schema.json`
- Update TypeScript types
- Add query signature fields

### Phase 2: Query Signature (2-3 hrs)
- Implement signature computation
- Implement consistency checking
- 6 unit tests

### Phase 3: Incremental Fetch (3-4 hrs)
- Implement gap detection
- Implement grouping optimization
- 8 unit tests

### Phase 4: Aggregation (2-3 hrs)
- Implement window aggregation
- Implement NoOp enhancer
- 10 unit tests

### Phase 5: Amplitude Daily (2 hrs)
- Add mode='daily' to adapter
- Update response extraction
- Test both modes

### Phase 6: Integration (2-3 hrs)
- Wire up DataOperationsService
- Add consistency dialog
- 7 integration tests

### Phase 7: UI (2-3 hrs)
- WindowSelector component
- GraphContext integration
- localStorage persistence

### Phase 8: Testing & Polish (3-4 hrs)
- Run full test suite
- Bug fixes
- Performance testing
- Documentation

---

## Performance Targets

- ✅ Gap detection: <10ms for 365 cached days
- ✅ Aggregation: <100ms for 365 cached days
- ✅ Window change: <200ms total (cached data)
- ✅ Fetch optimization: Group consecutive days

---

## User Experience

### Console Feedback

```
✓ Query consistent with cache
✓ All data cached, no fetch needed
✓ Aggregated 7 days: n=7000, k=2240, p=0.3200
✓ Enhancement method: none
✓ Graph updated
```

```
⚠ Query changed: filters modified
→ User clicks "Clear & Refetch"
✓ Cache cleared
✓ Fetching 7 days from amplitude-prod...
✓ Fetched 7 days, cached in parameter file
✓ Aggregated 7 days: n=7000, k=2240, p=0.3200
✓ Graph updated
```

```
✓ Query consistent with cache
✓ Fetching 2 missing days from amplitude-prod...
✓ Fetched 2 days, merged with 88 cached days
✓ Aggregated 7 days: n=7000, k=2240, p=0.3200
✓ Graph updated
```

---

## Future Enhancements

### v2: Bayesian Enhancement
- Use historical data as prior (Beta distribution)
- Update with current window (likelihood)
- Compute posterior mean (shrinkage toward prior)
- Credible intervals (uncertainty quantification)

### v3: Trend Detection
- Linear regression on daily p values
- Detect significant trends
- Flag anomalies
- Adjust mean for trend direction

### v4: Robust Estimation
- Outlier detection
- Winsorization
- Robust standard errors
- Trimmed means

---

## Key Design Principles

1. **Never re-fetch existing data** (unless forced by user)
2. **Query changes invalidate cache** (prevent inconsistency)
3. **Optimize API calls** (group consecutive days)
4. **Fail gracefully** (clear error messages)
5. **Future-proof** (plugin architecture for statistics)
6. **Test thoroughly** (24+ unit tests, 7 scenarios)

---

## Documentation References

- **Full Implementation Plan:** `WINDOW_SELECTOR_IMPLEMENTATION_PLAN.md` (70KB, comprehensive)
- **Architecture:** `ARCHITECTURE.md`
- **DAS Runner:** `DAS_RUNNER.md`
- **Connections Spec:** `CONNECTIONS_SPEC.md`

---

## Ready to Start

✅ Architecture designed  
✅ Edge cases identified  
✅ Test strategy defined  
✅ Phases broken down  
✅ Success criteria clear

**Next Step:** Phase 1 - Schema & Types (2 hours)

---

*Summary created: 2025-11-10*  
*Status: Ready for implementation*

