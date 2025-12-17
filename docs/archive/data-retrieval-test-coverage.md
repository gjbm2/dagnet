# Data Retrieval Test Coverage Review

> Generated from codebase analysis. Date: 1-Dec-25

## Executive Summary

**Total test files**: 104  
**Total individual tests**: 1,188  
**Data fetch related test files**: 21  
**Data fetch specific tests**: ~150+

### Coverage Assessment: ✅ GOOD but with some gaps

The data retrieval system has **solid coverage** of the main paths, but there are some edge cases and error scenarios that could benefit from additional tests.

---

## Test File Inventory (Data Fetch Related)

### Core Hook Tests
| File | Test Count | Coverage |
|------|------------|----------|
| `useFetchData.test.ts` | 19 | ✅ Mode routing, node fallback, getters |

### Service Integration Tests
| File | Test Count | Coverage |
|------|------------|----------|
| `dataOperationsService.integration.test.ts` | 15 | ✅ Real service with mocked HTTP |
| `versionedFetch.integration.test.ts` | 25 | ✅ Window parsing, date handling, slice isolation |
| `conditionalProbability.integration.test.ts` | 37 | ✅ Dual queries, n_query, conditional_p |
| `contextPassthrough.e2e.test.ts` | 19 | ✅ Context filters through API |
| `multiSliceCache.e2e.test.ts` | 13 | ✅ Multi-slice caching, isolation |

### Aggregation Tests
| File | Test Count | Coverage |
|------|------------|----------|
| `windowAggregationService.test.ts` | 16 | ✅ Aggregation maths, window filtering |
| `sliceIsolation.test.ts` | 10 | ✅ Slice matching, MECE errors |
| `contextAggregation.test.ts` | - | ✅ Context-based aggregation |

### DAS/Query Building Tests
| File | Test Count | Coverage |
|------|------------|----------|
| `buildDslFromEdge.contexts.test.ts` | - | ✅ Context filter building |
| `buildDslFromEdge.upstreamVisited.test.ts` | - | ✅ Visited upstream handling |
| `compositeQueryExecutor.integration.test.ts` | - | ✅ minus/plus query execution |
| `nQueryEventDefinitions.test.ts` | - | ✅ n_query event resolution |

### UI Component Tests
| File | Test Count | Coverage |
|------|------------|----------|
| `WindowSelector.coverage.test.ts` | - | ⚠️ Coverage unknown |

---

## Coverage by Feature

### ✅ WELL COVERED

1. **Mode Routing** (useFetchData)
   - Versioned → getFromSource ✅
   - Direct → getFromSourceDirect ✅
   - From-file → getParameterFromFile ✅
   - Node fallback to getNodeFromFile ✅

2. **Window Aggregation**
   - Date range filtering ✅
   - Statistical aggregation (mean, stdev) ✅
   - Partial coverage handling ✅
   - UK date format parsing ✅

3. **Slice Isolation**
   - Context matching ✅
   - MECE violation detection ✅
   - Cross-slice contamination prevention ✅

4. **Conditional Probabilities**
   - Dual query execution ✅
   - n_query handling ✅
   - Conditional_p array indexing ✅
   - n_query_overridden flag ✅

5. **Query Building**
   - Event ID resolution ✅
   - Context filter threading ✅
   - Upstream visited handling ✅
   - Composite (minus/plus) queries ✅

6. **Incremental Fetch**
   - Missing date detection ✅
   - Query signature staleness ✅
   - Cache validation ✅

### ⚠️ PARTIAL COVERAGE

1. **Error Handling**
   - Network failures: ~25 error tests exist, but more could be added for:
     - Connection timeout
     - API rate limiting
     - Malformed API response
   
2. **UpdateManager Data Application**
   - 6 test files reference, but could use:
     - More edge cases for override flag combinations
     - Tests for partial data updates

3. **No-Graph Scenarios**
   - 5 tests explicitly cover no-graph fallback ✅
   - Could add more for:
     - Missing event files during fallback
     - Partial query resolution

### ❌ COVERAGE GAPS

1. **Case Fetch Flow**
   - getCaseFromFile with windowed aggregation
   - Statsig API response handling
   - Case schedule merging

2. **Node Fetch Flow**
   - getNodeFromFile edge cases
   - Node property sync

3. **Batch Operations**
   - BatchOperationsModal progress tracking
   - Partial batch failure handling
   - Batch cancellation

4. **Auto-Aggregation (WindowSelector)**
   - Coverage check caching
   - Auto-run triggers
   - Shimmer animation state

5. **EnhancedSelector Auto-Get**
   - setAutoUpdating callback
   - Race condition handling

---

## Recommended Additional Tests

### High Priority (Missing Coverage)

```typescript
// 1. Case fetch with window aggregation
describe('getCaseFromFile', () => {
  it('should aggregate case schedules within window');
  it('should respect weight_overridden flags');
  it('should handle empty schedules array');
  it('should merge schedules from multiple sources');
});

// 2. Batch operation edge cases
describe('BatchOperationsModal', () => {
  it('should continue on individual item failure');
  it('should report progress correctly for large batches');
  it('should handle mixed success/failure results');
  it('should rollback on critical errors');
});

// 3. WindowSelector auto-aggregation
describe('WindowSelector auto-aggregation', () => {
  it('should trigger on DSL change when cache is valid');
  it('should NOT trigger when fetching is in progress');
  it('should update shimmer state correctly');
  it('should handle rapid DSL changes (debouncing)');
});
```

### Medium Priority (Edge Cases)

```typescript
// 4. Network error handling
describe('Network error handling', () => {
  it('should retry on 429 rate limit');
  it('should show appropriate toast on timeout');
  it('should preserve partial data on mid-fetch failure');
});

// 5. Date edge cases
describe('Date handling edge cases', () => {
  it('should handle window spanning year boundary');
  it('should handle single-day windows');
  it('should handle future dates (no data)');
});

// 6. Override flag combinations
describe('Override flag matrix', () => {
  it('should skip mean when mean_overridden=true');
  it('should skip stdev when stdev_overridden=true');
  it('should skip both when both overridden');
  it('should apply neither when neither overridden');
});
```

### Low Priority (Nice to Have)

```typescript
// 7. Concurrent fetch handling
describe('Concurrent fetches', () => {
  it('should queue fetches for same parameter');
  it('should not duplicate API calls for same window');
});

// 8. Memory/performance
describe('Performance', () => {
  it('should handle large values[] arrays efficiently');
  it('should not leak memory on repeated fetches');
});
```

---

## Test Quality Assessment

### Strengths

1. **E2E tests use real services** - Only mocks HTTP layer
2. **Good slice/context coverage** - MECE violations detected
3. **Date format tests** - UK format parsing verified
4. **Integration tests trace full path** - Hook → Service → File → Graph

### Weaknesses

1. **Limited UI component tests** - WindowSelector coverage unknown
2. **No performance/stress tests** - Large data handling untested
3. **Limited concurrent operation tests** - Race conditions possible

---

## Suggested Test Organisation

Current test locations are somewhat scattered. Consider consolidating:

```
src/services/__tests__/
├── data-fetch/
│   ├── useFetchData.test.ts           # Hook tests
│   ├── dataOperationsService.test.ts  # Service unit tests
│   ├── versionedFetch.e2e.test.ts     # Full versioned path
│   ├── directFetch.e2e.test.ts        # Full direct path
│   └── fromFile.e2e.test.ts           # Full from-file path
├── aggregation/
│   ├── windowAggregation.test.ts
│   ├── sliceIsolation.test.ts
│   └── contextAggregation.test.ts
├── query-building/
│   ├── buildDslFromEdge.test.ts
│   ├── compositeQuery.test.ts
│   └── nQuery.test.ts
└── integration/
    ├── conditionalProbability.test.ts
    ├── multiSliceCache.test.ts
    └── batchOperations.test.ts
```

---

## Conclusion

**Overall Coverage**: 7/10

The core data fetch functionality is well-tested, especially:
- Mode routing
- Aggregation maths
- Slice isolation
- Query building

Priority gaps to address:
1. Case fetch windowed aggregation
2. Batch operation edge cases
3. Auto-aggregation in WindowSelector
4. Network error scenarios

The test suite is comprehensive enough for current functionality but would benefit from the additional tests outlined above before major refactoring.

