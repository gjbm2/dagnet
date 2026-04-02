# Slice Planning and Retrieval

How DagNet plans and executes batch data fetches across all parameter slices.

## What Retrieve-All Is

Batch data fetch across all slices (DSL explosion) to load complete parameter datasets for all graph items. Used by daily automation and manual "Retrieve All" actions.

## Planning

**Location**: `retrieveAllSlicesPlannerService.ts`

`collectTargets()` enumerates fetch targets from the graph:
- Parameters: p, conditional_p, cost_gbp, labour_cost
- Case weights
- Targets enumerated once per graph, not duplicated

## Execution

**Location**: `retrieveAllSlicesService.ts`

`executeRetrieveAllSlices()` iterates slices, then items within each slice:

1. Analyse cache (skip if fully cached)
2. Fetch missing days from API
3. Persist to files
4. Update graph with loaded parameter data
5. Run Stage-2/LAG topo pass if needed

Progress callbacks report slice/item counts, cache hits, API fetches, days fetched.

## Validation

**Location**: `slicePlanValidationService.ts`

`validatePinnedDataInterestsDSL()` checks if the pinned DSL has:
- Explicit uncontexted window/cohort slices, or
- Implicit MECE partitions (for nightly automation)

Returns warnings if MECE partition is incomplete.

## Key Files

| File | Role |
|------|------|
| `src/services/retrieveAllSlicesService.ts` | Execution orchestration |
| `src/services/retrieveAllSlicesPlannerService.ts` | Target enumeration |
| `src/services/slicePlanValidationService.ts` | DSL validation |
| `src/services/sliceIsolation.ts` | Slice isolation logic |
