# Conditional Probability Test Gap Analysis

## Summary

- **27 test files** exercise `edge.p` operations
- **Only 5 files** have any `conditionalIndex` coverage
- **0 files** test the complete data operation flow with `conditionalIndex`

## Files Requiring `conditional_p` Parallel Tests

### Priority 1: Data Operations (Critical)

| File | Tests `edge.p` | Tests `conditional_p` | Gap |
|------|---------------|----------------------|-----|
| `dataOperations.integration.test.ts` | 21 operations | 0 | **CRITICAL** |
| `dataOperationsService.integration.test.ts` | 15 operations | 0 | **CRITICAL** |
| `dataOperationsService.test.ts` | 13 operations | 0 | **CRITICAL** |
| `versionedFetchFlow.e2e.test.ts` | 12 operations | 0 | **CRITICAL** |
| `versionedFetch.integration.test.ts` | 14 operations | 0 | **CRITICAL** |

**Required parallel tests:**
- `getFromSourceDirect` with `conditionalIndex` → applies to `conditional_p[idx].p`
- `getParameterFromFile` with `conditionalIndex` → applies to `conditional_p[idx].p`  
- `putParameterToFile` with `conditionalIndex` → creates from `conditional_p[idx].p`
- Verify NO cross-contamination with base `edge.p`

### Priority 2: Multi-Slice & Caching

| File | Tests `edge.p` | Tests `conditional_p` | Gap |
|------|---------------|----------------------|-----|
| `multiSliceCache.e2e.test.ts` | 55 operations | 0 | **HIGH** |
| `parameterCache.e2e.test.ts` | 45 operations | 0 | **HIGH** |
| `contextPassthrough.e2e.test.ts` | 3 operations | 0 | **MEDIUM** |

**Required parallel tests:**
- Multi-slice retrieval for `conditional_p`
- Cache hit/miss with `conditionalIndex`
- Context/window aggregation for `conditional_p`

### Priority 3: ID Preservation & Provenance

| File | Tests `edge.p` | Tests `conditional_p` | Gap |
|------|---------------|----------------------|-----|
| `idPreservation.test.ts` | ~15 tests | 0 | **HIGH** |
| `provenance.test.ts` | ~15 tests | 0 | **HIGH** |
| `arrayAppend.test.ts` | ~10 tests | 0 | **MEDIUM** |
| `valuesLatest.test.ts` | ~18 tests | 0 | **MEDIUM** |

**Required parallel tests:**
- `conditional_p[idx].p.id` preserved through operations
- Provenance (`data_source`) applied to `conditional_p`
- `values[latest]` resolution for `conditional_p` parameter files

### Priority 4: Sheets Integration

| File | Tests `edge.p` | Tests `conditional_p` | Gap |
|------|---------------|----------------------|-----|
| `sheets.e2e.integration.test.ts` | 15 operations | 3 (extraction only) | **HIGH** |
| `sheetsContextFallback.test.ts` | 40 operations | 0 | **MEDIUM** |
| `sheetsUpdateExtraction.test.ts` | 3 tests | 0 | **LOW** |
| `dataOperations.sheets.integration.test.ts` | 6 tests | 0 | **MEDIUM** |

**Required parallel tests:**
- Sheets extraction WITH application to `conditional_p`
- Context fallback for `conditional_p` HRNs
- End-to-end Sheets → `conditional_p[idx].p` flow

### Priority 5: Rebalancing & Scenarios

| File | Tests `edge.p` | Tests `conditional_p` | Gap |
|------|---------------|----------------------|-----|
| `UpdateManager.rebalance.test.ts` | 49 (edge) | 14 (conditional) | Partial |
| `scenarios.conditional.test.ts` | 10 tests | Some | Partial |
| `ParamPackDSLService.test.ts` | 15 tests | Some | Partial |
| `CompositionService.test.ts` | 5 tests | Some | Partial |

**Required additions:**
- Rebalancing after `conditionalIndex` data fetch
- Scenario composition with `conditional_p` values

### Priority 6: Other Operations

| File | Tests `edge.p` | Tests `conditional_p` | Gap |
|------|---------------|----------------------|-----|
| `fetchDataService.test.ts` | 7 operations | 1 (default value) | **MEDIUM** |
| `batchOperations.test.ts` | 12 operations | 0 | **MEDIUM** |
| `dirtyStateTracking.test.ts` | 4 operations | 0 | **LOW** |
| `edgeReconnection.test.ts` | 4 operations | 0 | **LOW** |

## Existing `conditional_p` Tests (Review)

### `conditionalProbability.integration.test.ts` (29 mentions)

**Current coverage:**
- Query selection when `conditionalIndex` provided ✅
- Connection fallback ✅
- String-based condition processing ✅
- Super-funnel URL construction ✅
- Dual query n/k separation ✅
- n_query handling ✅

**Missing:**
- Actual `getFromSourceDirect` call with `conditionalIndex` ❌
- Actual `getParameterFromFile` call with `conditionalIndex` ❌
- Graph update verification ❌
- Cross-contamination checks ❌

### `sheets.e2e.integration.test.ts` (3 mentions)

**Current coverage:**
- `extractSheetsUpdateDataForEdge` with `conditionalIndex` ✅

**Missing:**
- Full end-to-end: Sheets → service → graph update ❌
- Verify `conditional_p[idx].p` updated ❌

### `UpdateManager.rebalance.test.ts` (14 mentions)

**Current coverage:**
- Conditional probability rebalancing ✅

**Missing:**
- Rebalancing triggered after data fetch ❌

## Test Template for Parity

Every test that does this for `edge.p`:

```typescript
it('should do X for edge.p', async () => {
  const edge = createTestEdge({ p: { mean: 0.5 } });
  await someOperation({ edgeId, paramSlot: 'p' });
  expect(edge.p.mean).toBe(expectedValue);
});
```

**MUST have a parallel test:**

```typescript
it('should do X for conditional_p[idx]', async () => {
  const edge = createTestEdge({ 
    p: { mean: 0.5 },
    conditional_p: [{ condition: 'visited(promo)', p: { mean: 0.7 } }]
  });
  await someOperation({ edgeId, paramSlot: 'p', conditionalIndex: 0 });
  
  // Verify conditional_p updated
  expect(edge.conditional_p[0].p.mean).toBe(expectedValue);
  
  // CRITICAL: Verify base p NOT changed
  expect(edge.p.mean).toBe(0.5);
});
```

## Implementation Plan

### Phase 1: Critical Data Operations
1. `dataOperations.integration.test.ts` - Add `conditional_p` roundtrip tests
2. `dataOperationsService.integration.test.ts` - Add `conditionalIndex` tests
3. `versionedFetchFlow.e2e.test.ts` - Add versioned flow with `conditionalIndex`

### Phase 2: Caching & Multi-Slice  
4. `multiSliceCache.e2e.test.ts` - Add slice tests for `conditional_p`
5. `parameterCache.e2e.test.ts` - Add cache tests with `conditionalIndex`

### Phase 3: ID Preservation & Provenance
6. `idPreservation.test.ts` - Add `conditional_p[idx].p.id` tests
7. `provenance.test.ts` - Add `conditional_p` provenance tests

### Phase 4: Sheets Integration
8. `sheets.e2e.integration.test.ts` - Add full flow tests
9. `dataOperations.sheets.integration.test.ts` - Add `conditionalIndex` tests

### Phase 5: Clean-up
10. Update `conditionalProbability.integration.test.ts` with actual service calls
11. Add cross-contamination tests to all relevant files

## Estimated Effort

- **~50 new test cases** required for full parity
- Tests follow existing patterns - primarily copy + modify
- Most critical: Phase 1 (data operations) - ~15 tests

