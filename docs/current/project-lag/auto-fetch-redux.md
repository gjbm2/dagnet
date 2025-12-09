# Auto-Fetch Logic Simplification Proposal

**Date:** 9-Dec-24  
**Status:** Draft for review  
**Component:** WindowSelector.tsx

---

## 1. Problem Statement

The WindowSelector component's fetch trigger logic is overcomplicated and poorly structured. What should be a straightforward question - "does the user need to click Fetch?" - is currently spread across multiple locations with different logic paths, inconsistent data sources, and unnecessary complexity.

### 1.1 Core Question We're Trying to Answer

When the user changes the date window or context filter, we need to determine:

1. **Is there cached data that covers this query?** If yes, auto-aggregate from cache.
2. **Is there missing data that CAN be fetched?** If yes, show enabled Fetch button.
3. **Is there missing data that CANNOT be fetched?** If yes, show a toast explaining the situation.

This is fundamentally simple, but the current implementation makes it bewilderingly complex.

---

## 2. Current Architecture Problems

### 2.1 Two Separate Coverage Calculations

The component computes "what needs fetching" in two completely different places:

1. **Main useEffect** (lines 491-798) - runs on window/DSL change, uses `hasFullSliceCoverageByHeader()` to determine `needsFetch` state
2. **batchItemsToFetch useMemo** (lines 953-1037) - runs on render, uses `calculateIncrementalFetch()` to build the actual fetch list

These use different functions and could theoretically disagree. The result: `needsFetch` might be true, but `batchItemsToFetch` might be empty (or vice versa).

### 2.2 Two Different DSL Sources

The codebase has two "DSL" values that should represent the same thing:

- `graphStore.currentDSL` - labelled as "authoritative"
- `graph.currentQueryDSL` - labelled as "historic record"

The main coverage check uses `graph.currentQueryDSL` when calling `hasFullSliceCoverageByHeader()`, but `batchItemsToFetch` uses `graphStore.currentDSL` when calling `calculateIncrementalFetch()`. This is asking for bugs.

### 2.3 Five Refs Tracking State

The component maintains five refs to track state across renders and async operations:

- `isInitialMountRef` - prevents coverage check on first render
- `isAggregatingRef` - prevents re-triggering during aggregation
- `lastAggregatedDSLRef` - tracks what DSL we last aggregated for
- `graphRef` - avoids stale closures
- `prevDSLRef` - tracks previous DSL for shimmer animation

This is symptomatic of fighting against React's model rather than working with it. The need for so many refs suggests the effect structure is wrong.

### 2.4 Mixed Concerns in Single Effect

The main coverage check effect (200+ lines) does too many things:

- Checks multiple early-exit conditions
- Iterates all edges and params to compute coverage
- Iterates all nodes/cases for coverage
- Determines needsFetch state
- Shows various toast messages
- Performs auto-aggregation
- Updates multiple refs
- Manages aggregation timing with setTimeout

This violates single-responsibility and makes the flow nearly impossible to follow.

### 2.5 Duplicate Iteration

Both the main effect and `batchItemsToFetch` iterate over all edges/params separately. This is wasteful and error-prone - if the iteration logic needs to change, it must be updated in two places.

### 2.6 Inconsistent Function Naming

- `hasFullSliceCoverageByHeader()` - checks if cache covers the window
- `calculateIncrementalFetch()` - also checks if cache covers the window, but returns different structure

Why do we have two functions that answer essentially the same question?

---

## 3. Proposed Architecture

### 3.1 Single Source of Truth for Coverage

Create ONE function that computes coverage state for the current query. This function returns a structured result that answers all the questions we need:

- Which parameters are fully covered (can auto-aggregate)?
- Which parameters need fetching (have connection, missing data)?
- Which parameters have gaps but cannot be fetched (file-only)?
- What toast message (if any) should be shown?

This function is called ONCE when the query changes, and its result is stored in state.

### 3.2 Single DSL Source

Pick ONE authoritative DSL source and use it everywhere. The current split between "authoritative" and "historic" is confusing and bug-prone. If we need to persist DSL to the graph file, that's a separate concern from what DSL is currently active.

Recommendation: Use `graphStore.currentDSL` as the single source. Remove `graph.currentQueryDSL` or make it purely a persistence field that's never read for logic.

### 3.3 Separate Concerns into Distinct Effects

Split the monolithic effect into focused pieces:

1. **Coverage computation effect** - when query changes, compute coverage state
2. **Auto-aggregation effect** - when coverage state shows "fully covered", trigger aggregation
3. **Toast effect** - when coverage state changes, show appropriate toast
4. **Animation effect** - when needsFetch changes, trigger shimmer

Each effect has a single responsibility and clear trigger conditions.

### 3.4 Derive batchItemsToFetch from Coverage State

Instead of recomputing coverage in `batchItemsToFetch`, derive it directly from the coverage state computed by the main effect. This ensures the Fetch button and the fetch list always agree.

### 3.5 Reduce Ref Count

With proper effect structure, most refs become unnecessary:

- `isInitialMountRef` - handle initial state in effect dependencies instead
- `isAggregatingRef` - use explicit state machine states
- `lastAggregatedDSLRef` - store in React state (it's already persisted as `lastAggregatedWindow`)
- `graphRef` - use proper dependency management
- `prevDSLRef` - use `usePrevious` hook pattern or derive from state

Target: zero to one ref maximum.

---

## 4. Proposed State Model

### 4.1 Coverage State

The coverage computation produces a single state object:

- **status**: "checking" | "ready" | "error"
- **canAutoAggregate**: boolean - true if all connected params have full coverage
- **itemsNeedingFetch**: list of param/case identifiers that need fetching
- **hasUnfetchableGaps**: boolean - true if file-only params have coverage gaps
- **lastCheckedDSL**: the DSL this coverage was computed for

### 4.2 Aggregation State

Separate state for aggregation:

- **status**: "idle" | "aggregating" | "complete" | "error"
- **lastAggregatedDSL**: the DSL we successfully aggregated for

### 4.3 Derived Values

From these two state objects, we derive:

- **needsFetch**: `coverage.itemsNeedingFetch.length > 0`
- **showFetchButton**: `hasParameterFiles` (always show if graph has params)
- **fetchButtonEnabled**: `!aggregating && itemsNeedingFetch.length > 0`

---

## 5. Decision Flow (Simplified)

When query (DSL) changes:

1. If DSL equals lastAggregatedDSL, do nothing (already handled)
2. Compute coverage for new DSL (single function call)
3. Store coverage result in state
4. If canAutoAggregate is true, trigger aggregation
5. If itemsNeedingFetch is non-empty, user sees enabled Fetch button
6. If hasUnfetchableGaps is true and no fetchable items, show toast

When user clicks Fetch:

1. Read itemsNeedingFetch from coverage state (already computed)
2. Execute fetch for those items
3. On success, recompute coverage (cache has changed)
4. Update lastAggregatedDSL

---

## 6. Open Questions

### 6.1 Why Two Coverage Functions?

Need to understand why `hasFullSliceCoverageByHeader()` and `calculateIncrementalFetch()` both exist. Are they answering different questions? If so, what? If not, consolidate.

### 6.2 What's the Difference Between graphStore.currentDSL and graph.currentQueryDSL?

The comments say one is "authoritative" and one is "historic record". But they're both read in different places for logic. Need to clarify the intended design and either enforce it or simplify to one source.

### 6.3 Is Auto-Aggregation Actually Wanted?

The current code auto-aggregates when coverage is complete. Is this the desired UX? Or should the user always explicitly click Fetch/Aggregate? If auto-aggregation is wanted, it needs to be more predictable.

### 6.4 What Triggers Should Cause a Coverage Re-check?

Currently: window change, context change, graph structure change. Are there others? Should file data changes trigger a re-check?

---

## 7. Implementation Approach

### Phase 1: Understand the Two Coverage Functions

Before changing anything, investigate why both `hasFullSliceCoverageByHeader()` and `calculateIncrementalFetch()` exist. Document what each does and whether they can be consolidated.

### Phase 2: Create Unified Coverage Computation

Create a single function that returns a complete coverage assessment. This function should be pure (no side effects) and return a structured result.

### Phase 3: Refactor WindowSelector to Use New Model

Replace the current multi-ref, multi-effect approach with:
- Single coverage state
- Single aggregation state  
- Derived needsFetch and button state
- Focused effects with single responsibilities

### Phase 4: Remove Dead Code

After refactoring, remove:
- Unused refs
- Redundant coverage functions (if consolidated)
- Duplicate iteration logic

### Phase 5: Add Tests

The current logic is too complex to test effectively. The new architecture should be testable:
- Coverage computation function: pure, easily unit tested
- State transitions: can test effect triggers in isolation

---

## 8. Risks and Mitigations

### Risk: Breaking Existing Behaviour

The current code, while messy, does work. Refactoring could introduce regressions.

**Mitigation:** Write characterisation tests before refactoring that capture current behaviour. Run after each change to catch regressions.

### Risk: Edge Cases Not Understood

The complexity may exist because of edge cases we don't fully understand yet.

**Mitigation:** Phase 1 investigation should document all edge cases before we simplify.

### Risk: Performance Regression

Computing coverage once and storing it could be slower than lazy computation if the graph is large.

**Mitigation:** Profile before and after. The current code iterates twice anyway, so single iteration should be faster.

---

## 9. Success Criteria

1. Single function answers "what needs fetching" question
2. No disagreement possible between needsFetch state and fetch item list
3. Maximum one ref in the component
4. Each effect has single, clear responsibility
5. New developer can understand the fetch trigger logic in under 5 minutes
6. All existing tests pass (or are updated to match clarified behaviour)

---

## 10. Recommendation

Proceed with investigation (Phase 1) to understand why the dual coverage functions exist. Once that's clear, the refactoring path will be more obvious. Do not attempt to simplify before understanding the current design's intent - there may be subtleties that aren't apparent from code reading alone.

