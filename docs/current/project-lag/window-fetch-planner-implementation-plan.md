# Window Fetch Planner – Implementation Plan

**Date:** 9-Dec-25  
**Status:** Ready for implementation  
**Design doc:** `window-fetch-planner-detailed-design.md`  
**High-level doc:** `window-fetch-planner-service.md`

---

## Overview

This plan implements the Window Fetch Planner Service as specified in the detailed design. The work is organised into phases to enable incremental testing and reduce risk.

---

## Phase 1: Core Planner Service

**Goal:** Create the planner service with types and analysis logic.

### 1.1 Create Service File

**File:** `graph-editor/src/services/windowFetchPlannerService.ts` (NEW)

**Actions:**
1. Create file with singleton pattern matching existing services
2. Define all types: `FetchOutcome`, `PlannerItem`, `AnalysisTrigger`, `PlannerResult` (ref: §2.2)
3. Implement class skeleton with `analyse()`, `executeFetchPlan()`, `invalidateCache()` methods (ref: §3.1)
4. Implement cache management with `cachedResult`, `cachedDSL`, `cachedGraphHash` (ref: §14)

### 1.2 Implement DSL Extraction

**File:** `graph-editor/src/services/windowFetchPlannerService.ts`

**Actions:**
1. Implement `extractWindowFromDSL()` using `parseConstraints()` from `lib/queryDSL.ts`
2. Handle both `window()` and `cohort()` clauses (ref: §5.2)
3. Support relative date resolution via `resolveRelativeDate()`
4. Return `null` for DSLs without temporal clauses

### 1.3 Implement Coverage Analysis

**File:** `graph-editor/src/services/windowFetchPlannerService.ts`

**Actions:**
1. Delegate coverage check to `fetchDataService.getItemsNeedingFetch()` (ref: §4.1, §4.2)
2. Call with `checkCache=true` to get items needing fetch
3. Call with `checkCache=false` to get all connectable items
4. Classify items by comparing the two results
5. Implement `isFileOnlyItem()` helper to detect items without connections
6. Implement `checkFileOnlyCoverage()` for file-only items

### 1.4 Implement Slice Matching

**File:** `graph-editor/src/services/windowFetchPlannerService.ts`

**Actions:**
1. Implement `findMatchingSlice()` using pattern from `dataOperationsService.ts` lines 3646-3657 (ref: §18.3)
2. Use `extractSliceDimensions()` from `sliceIsolation.ts` for dimension comparison
3. Use `isCohortModeValue()` from `windowAggregationService.ts` for mode matching
4. Return matching slice with `data_source.retrieved_at` accessible

### 1.5 Implement Parameter Staleness Check

**File:** `graph-editor/src/services/windowFetchPlannerService.ts`

**Actions:**
1. Implement `checkStaleness()` method (ref: §6.3)
2. Call `shouldRefetch()` from `fetchRefetchPolicy.ts` for cohort immaturity
3. Implement retrieval timestamp test: >1 day since retrieval AND within t95/path_t95
4. Select correct threshold: `t95` for window queries, `path_t95` for cohort queries (ref: §6.2)
5. Return staleness classification with reason and timestamp

### 1.6 Implement Case Staleness Check

**File:** `graph-editor/src/services/windowFetchPlannerService.ts`

**Actions:**
1. Add case handling branch in `checkStaleness()` (ref: §7.2)
2. Implement `getMostRecentCaseRetrievedAt()` to find latest schedule timestamp
3. Apply simple >1 day threshold for case staleness
4. Treat missing `retrieved_at` as stale (refresh to be safe)

### 1.7 Implement Outcome Derivation

**File:** `graph-editor/src/services/windowFetchPlannerService.ts`

**Actions:**
1. Implement `deriveOutcome()` function (ref: §12)
2. Exclude `file_only_gap` items from outcome calculation
3. Return `not_covered` if any `needs_fetch`
4. Return `covered_stale` if no `needs_fetch` but any `stale_candidate`
5. Return `covered_stable` otherwise

### 1.8 Implement Message Generation

**File:** `graph-editor/src/services/windowFetchPlannerService.ts`

**Actions:**
1. Implement `buildButtonTooltip()` (ref: §13.1)
2. Distinguish stale parameters ("maturing cohorts") from stale cases (">1 day old")
3. Implement `buildToastMessage()` (ref: §13.2)
4. Handle unfetchable gaps messaging

---

## Phase 2: Existing Service Modifications

**Goal:** Make required changes to existing services.

### 2.1 Export computeEffectiveMaturity

**File:** `graph-editor/src/services/fetchRefetchPolicy.ts`

**Actions:**
1. Change `function computeEffectiveMaturity` to `export function computeEffectiveMaturity` (ref: §11.2)

### 2.2 Add parentLogId to FetchOptions

**File:** `graph-editor/src/services/fetchDataService.ts`

**Actions:**
1. Add `parentLogId?: string` to `FetchOptions` interface (ref: §11.1, §9.3)
2. Modify `fetchItems()` to use `parentLogId` for log linkage when provided
3. Add child entries under parent log instead of starting new operation

---

## Phase 3: Planner Execution

**Goal:** Implement the execution path.

### 3.1 Implement executeFetchPlan

**File:** `graph-editor/src/services/windowFetchPlannerService.ts`

**Actions:**
1. Re-run `analyse()` at start of execution to guarantee fresh plan (ref: §4.3)
2. Combine `fetchPlanItems` and `staleCandidates` into items to fetch
3. Convert `PlannerItem[]` to `FetchItem[]` using `createFetchItem()`
4. Call `fetchDataService.fetchItems()` with `mode: 'versioned'` and `parentLogId`
5. Invalidate cache after fetch completes
6. Re-run analysis with `trigger: 'post_fetch'` and return result

### 3.2 Implement Session Logging

**File:** `graph-editor/src/services/windowFetchPlannerService.ts`

**Actions:**
1. Add `PLANNER_ANALYSIS` logging in `analyse()` (ref: §9.1)
2. Log item counts by classification as child entries
3. Log derived outcome
4. Add `FETCH_TRIAGE` logging in `executeFetchPlan()` (ref: §9.2)
5. Log gap items and stale items separately
6. Log "no fetch needed" when outcome is `covered_stable`
7. Pass `triageLogId` to `fetchItems()` for linkage

---

## Phase 4: Unit Tests

**Goal:** Add comprehensive unit tests for planner.

### 4.1 Create Test File

**File:** `graph-editor/src/services/__tests__/windowFetchPlannerService.test.ts` (NEW)

**Actions:**
1. Create test file with standard Vitest setup
2. Set up mocks for `fetchDataService`, `fileRegistry`, `sessionLogService`

### 4.2 Single Path Verification Tests

**Actions:**
1. Test that planner uses `getItemsNeedingFetch()` output for `needs_fetch` classification (ref: §16.1 item 1)
2. Verify planner does NOT call `hasFullSliceCoverageByHeader()` directly

### 4.3 Coverage Classification Tests

**Actions:**
1. Test items from `getItemsNeedingFetch()` → `needs_fetch` (ref: §16.1 item 2)
2. Test covered items → check staleness
3. Test file-only items → `file_only_gap` or `covered_stable`

### 4.4 Staleness Classification Tests

**Actions:**
1. Test mature cohorts with `shouldRefetch` returning `use_cache` → check retrieval timestamp (ref: §16.1 item 3)
2. Test immature cohorts → `stale_candidate`
3. Test retrieved >1 day ago, within t95 → `stale_candidate`
4. Test retrieved >1 day ago, beyond t95 → `covered_stable`

### 4.5 DSL Extraction Tests

**Actions:**
1. Test `window(1-Dec-25:7-Dec-25)` → correct DateRange (ref: §16.1 item 4)
2. Test `cohort(1-Dec-25:7-Dec-25)` → correct DateRange (not null)
3. Test relative dates (`-7d:`) → resolved correctly

### 4.6 Case Staleness Tests

**Actions:**
1. Test case retrieved <1 day ago → `covered_stable` (ref: §16.1 item 5)
2. Test case retrieved >1 day ago → `stale_candidate`
3. Test case with no `retrieved_at` → `stale_candidate`
4. Test file-only cases → `file_only_gap`

### 4.7 Outcome Derivation Tests

**Actions:**
1. Test all `covered_stable` → outcome `covered_stable` (ref: §16.1 item 6)
2. Test any `needs_fetch` → outcome `not_covered`
3. Test no `needs_fetch`, some stale → outcome `covered_stale`
4. Test only `file_only_gap` → outcome `covered_stable` (with toast)

### 4.8 Message Generation Tests

**Actions:**
1. Test button tooltips for each outcome (ref: §16.1 item 7)
2. Test distinct text for stale params vs stale cases
3. Test toast messages for unfetchable gaps

---

## Phase 5: WindowSelector Integration

**Goal:** Refactor WindowSelector to use planner.

### 5.1 Add Feature Flag

**File:** `graph-editor/src/components/WindowSelector.tsx`

**Actions:**
1. Add feature flag constant (e.g., `USE_PLANNER = true`)
2. Wrap new planner-based logic in flag check initially

### 5.2 Update State

**File:** `graph-editor/src/components/WindowSelector.tsx`

**Actions:**
1. Add `plannerResult` state (ref: §10.1)
2. Add `isExecuting` state
3. Keep `showShimmer` state (preserved)
4. Add derived values: `isAnalysing`, `outcome`, `buttonLabel`, `buttonDisabled`, `buttonTooltip`, `buttonNeedsAttention`

### 5.3 Implement Effect 1: Analysis Trigger

**File:** `graph-editor/src/components/WindowSelector.tsx`

**Actions:**
1. Create effect that triggers on `graph` and `graphStore.currentDSL` changes (ref: §10.2)
2. Skip if `isExecuting`
3. Determine trigger type: `initial_load` or `dsl_change`
4. Call `windowFetchPlannerService.analyse()`
5. Update `plannerResult` state
6. Show toast if `result.summaries.showToast`

### 5.4 Implement Effect 2: Auto-Aggregation

**File:** `graph-editor/src/components/WindowSelector.tsx`

**Actions:**
1. Create effect that triggers on `plannerResult` changes (ref: §10.2)
2. Trigger for BOTH `covered_stable` AND `covered_stale` outcomes (not just stable)
3. Skip if `outcome === 'not_covered'`
4. Convert `autoAggregationItems` to `FetchItem[]`
5. Call `fetchItems()` with `mode: 'from-file'`
6. Update `lastAggregatedWindow` and `lastAggregatedDSLRef`

### 5.5 Preserve Shimmer Effects

**File:** `graph-editor/src/components/WindowSelector.tsx`

**Actions:**
1. Implement Effect 3: shimmer on `buttonNeedsAttention` change (ref: §10.2)
2. Implement Effect 4: re-shimmer on DSL change when fetch needed
3. Keep existing CSS classes and timing unchanged

### 5.6 Update Fetch Button Handler

**File:** `graph-editor/src/components/WindowSelector.tsx`

**Actions:**
1. Implement new `handleFetchData` using planner (ref: §10.4)
2. Set `isExecuting` true at start
3. Call `windowFetchPlannerService.executeFetchPlan()`
4. Update `plannerResult` with returned result
5. Update `lastAggregatedWindow` and `lastAggregatedDSLRef`
6. Set `isExecuting` false in finally block

### 5.7 Update Button Rendering

**File:** `graph-editor/src/components/WindowSelector.tsx`

**Actions:**
1. Update button `disabled` prop to use `buttonDisabled` (ref: §10.3)
2. Update button `title` prop to use `buttonTooltip`
3. Update button label to show `buttonLabel` when not loading
4. Keep shimmer class binding: `showShimmer ? 'shimmer' : ''`
5. **No CSS changes**

---

## Phase 6: Remove Old Logic

**Goal:** Remove superseded coverage logic from WindowSelector.

### 6.1 Remove Old State

**File:** `graph-editor/src/components/WindowSelector.tsx`

**Actions:**
1. Remove `needsFetch` state
2. Remove `isCheckingCoverage` state
3. Remove `showButton` state (button always shown based on `hasParameterFiles`)
4. Remove `coverageCache` Map
5. Remove `CoverageCacheEntry` interface

### 6.2 Remove Old Effects

**File:** `graph-editor/src/components/WindowSelector.tsx`

**Actions:**
1. Remove monolithic coverage check effect (lines 491-798 approximately)
2. Remove old shimmer trigger effect that used `needsFetch`
3. Remove old `batchItemsToFetch` useMemo if superseded

### 6.3 Remove Feature Flag

**File:** `graph-editor/src/components/WindowSelector.tsx`

**Actions:**
1. Remove feature flag constant
2. Remove conditional branches

---

## Phase 7: Update Existing Tests

**Goal:** Update tests affected by the refactor.

### 7.1 Update autoFetchCoverage.test.ts

**File:** `graph-editor/src/services/__tests__/autoFetchCoverage.test.ts`

**Actions:**
1. Update to test planner-based coverage instead of direct WindowSelector logic (ref: §16.3)
2. Mock `windowFetchPlannerService` where appropriate
3. Verify coverage decisions match expected outcomes

### 7.2 Update WindowSelector.autoAggregation.test.ts

**File:** `graph-editor/src/components/__tests__/WindowSelector.autoAggregation.test.ts`

**Actions:**
1. Update to verify auto-agg for both stable and stale outcomes (ref: §16.3)
2. Add test for stale outcome triggering auto-aggregation

### 7.3 Update fetchButtonE2E.integration.test.tsx

**File:** `graph-editor/src/services/__tests__/fetchButtonE2E.integration.test.tsx`

**Actions:**
1. Update button assertions for new labels: "Fetch data" / "Refresh" / "Up to date" (ref: §16.3)
2. Update tooltip assertions to match planner-generated text

### 7.4 Update fetchDataService.test.ts

**File:** `graph-editor/src/services/__tests__/fetchDataService.test.ts`

**Actions:**
1. Add tests for `parentLogId` option (ref: §16.3)
2. Verify log linkage when `parentLogId` provided

---

## Phase 8: Integration Tests

**Goal:** Add integration tests for full flow.

### 8.1 Create Integration Test File

**File:** `graph-editor/src/services/__tests__/windowFetchPlannerService.integration.test.ts` (NEW)

**Actions:**
1. Create test file with real `getItemsNeedingFetch()` (ref: §16.2)
2. Set up mock graphs and file registry with realistic data

### 8.2 End-to-End Analysis Tests

**Actions:**
1. Test analysis with real coverage delegation
2. Verify correct outcome for various graph configurations

### 8.3 Execution Flow Tests

**Actions:**
1. Test execution through to mock `fetchItems`
2. Verify items passed to fetch match analysis result

### 8.4 Cache Invalidation Tests

**Actions:**
1. Test cache invalidates after execution
2. Test re-analysis after invalidation produces fresh result

### 8.5 Log Linkage Tests

**Actions:**
1. Verify parent/child log structure
2. Capture session logs and assert hierarchy

---

## Phase 9: Verification

**Goal:** Final verification and cleanup.

### 9.1 Verify DSL Persistence

**Actions:**
1. Trace `graph.currentQueryDSL` save to disk (ref: §18.1)
2. Add test if not already covered
3. Document finding in detailed design if needed

### 9.2 Run Full Test Suite

**Actions:**
1. Run all planner unit tests
2. Run all planner integration tests
3. Run updated existing tests
4. Verify no regressions in unrelated tests

### 9.3 Manual Testing

**Actions:**
1. Test covered_stable outcome: verify no fetch button CTA
2. Test not_covered outcome: verify "Fetch data" button
3. Test covered_stale outcome: verify "Refresh" button
4. Verify shimmer animation works on outcome changes
5. Verify tooltips show correct information
6. Verify toasts for file-only gaps

---

## Files Impacted Summary

### New Files
| File | Phase |
|------|-------|
| `services/windowFetchPlannerService.ts` | 1 |
| `services/__tests__/windowFetchPlannerService.test.ts` | 4 |
| `services/__tests__/windowFetchPlannerService.integration.test.ts` | 8 |

### Modified Files
| File | Phase | Changes |
|------|-------|---------|
| `services/fetchRefetchPolicy.ts` | 2 | Export `computeEffectiveMaturity` |
| `services/fetchDataService.ts` | 2 | Add `parentLogId` to FetchOptions |
| `components/WindowSelector.tsx` | 5, 6 | Major refactor to use planner |
| `services/__tests__/autoFetchCoverage.test.ts` | 7 | Update for planner |
| `components/__tests__/WindowSelector.autoAggregation.test.ts` | 7 | Update for planner |
| `services/__tests__/fetchButtonE2E.integration.test.tsx` | 7 | Update button assertions |
| `services/__tests__/fetchDataService.test.ts` | 7 | Add parentLogId tests |

### Unchanged Files (used but not modified)
| File | Usage |
|------|-------|
| `services/sliceIsolation.ts` | `extractSliceDimensions()` |
| `services/windowAggregationService.ts` | `isCohortModeValue()` |
| `lib/queryDSL.ts` | `parseConstraints()`, `resolveRelativeDate()` |
| `services/sessionLogService.ts` | Logging |
| `services/dataOperationsService.ts` | Referenced pattern only |

---

## Dependency Order

```
Phase 1.1-1.2  ─┬─► Phase 1.3 ─► Phase 1.4 ─► Phase 1.5-1.8 ─► Phase 3
               │
Phase 2.1-2.2  ─┘

Phase 3 ─► Phase 4 ─► Phase 5 ─► Phase 6 ─► Phase 7 ─► Phase 8 ─► Phase 9
```

- Phases 1.1-1.2 and 2.1-2.2 can run in parallel
- Phases 1.3-1.8 depend on 1.1-1.2
- Phase 3 depends on Phase 1 and Phase 2
- Phases 4-9 are sequential

---

## Estimated Effort

| Phase | Description | Estimate |
|-------|-------------|----------|
| 1 | Core Planner Service | 3-4 hours |
| 2 | Existing Service Mods | 30 mins |
| 3 | Planner Execution | 1-2 hours |
| 4 | Unit Tests | 2-3 hours |
| 5 | WindowSelector Integration | 2-3 hours |
| 6 | Remove Old Logic | 1 hour |
| 7 | Update Existing Tests | 1-2 hours |
| 8 | Integration Tests | 1-2 hours |
| 9 | Verification | 1 hour |
| **Total** | | **13-18 hours** |

---

## Rollback Plan

If issues discovered after Phase 5:
1. Revert WindowSelector changes
2. Keep planner service (no harm if unused)
3. Investigate issue using planner's session logs
4. Fix and retry integration

Feature flag in Phase 5.1 enables quick disable if needed.

