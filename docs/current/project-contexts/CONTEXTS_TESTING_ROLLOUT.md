# Contexts: Testing Strategy & Rollout

**Part of**: Contexts v1 implementation  
**See also**: 
- `CONTEXTS_ARCHITECTURE.md` — Core architecture
- `CONTEXTS_REGISTRY.md` — Context definitions
- `CONTEXTS_AGGREGATION.md` — Aggregation algorithms
- `CONTEXTS_ADAPTERS.md` — Adapter implementations

---

## Overview

This document defines:
- Comprehensive testing strategy for contexts v1
- Test coverage requirements for all components
- Rollout phases and validation steps
- Migration considerations

---

## Testing Strategy

### Coverage Scope

All intricate aspects of the implementation MUST have comprehensive test coverage, including:
- **DSL parsing edge cases** (malformed, mixed constraints, normalization idempotence)
- **2D grid aggregation logic** (all 7 scenarios from revised matrix)
- **Subquery generation** (missing date ranges per context, batching, de-duplication)
- **MECE detection** (complete/incomplete partitions, cross-dimension)
- **Amplitude adapter** (context filter generation, query building, response handling)
- **Sheets fallback** (exact match, fallback, warnings)
- **UpdateManager** (rebalancing with context-bearing conditions)

**Test-driven approach**: Implement aggregation window logic and subquery generation WITH tests in parallel; each scenario from the matrix gets at least one test case.

---

## Unit Tests

### DSL Parsing & Normalization

**File**: `graph-editor/src/services/__tests__/constraintParser.test.ts` (NEW)

- ✓ Parse `context(key:value)` correctly
- ✓ Parse `contextAny(key:v1,v2,...)` correctly
- ✓ Parse `window(start:end)` with absolute and relative dates
- ✓ Parse complex chains: `visited(a).context(b:c).window(d:e).p.mean`
- ✓ `normalizeConstraintString` produces deterministic, sorted output
- ✓ `normalizeConstraintString` is idempotent (normalize(normalize(x)) === normalize(x))
- ✓ Date normalization: ISO → d-MMM-yy, relative offsets unchanged
- ✓ Handles malformed strings gracefully (error or return empty?)

### Context Registry

**File**: `graph-editor/src/services/__tests__/contextRegistry.test.ts` (NEW)

- ✓ Load and parse `contexts.yaml`
- ✓ Validate schema (required fields, value uniqueness)
- ✓ Retrieve source mappings by context key + value + source
- ✓ **otherPolicy handling** (all 4 policies):
  - `null`: "other" not in enumeration; values asserted MECE
  - `computed`: "other" in enumeration; filter computed dynamically
  - `explicit`: "other" in enumeration with explicit filter
  - `undefined`: "other" not in enumeration; NOT MECE (aggregation disallowed)
- ✓ **Regex pattern support**:
  - Pattern matching for value mappings
  - Pattern + flags (case-insensitive, etc.)
  - Computed "other" with pattern-based explicit values
  - Error when both pattern and filter provided
- ✓ Detect unmapped context values (values not in registry)

### Slice Isolation & Query Signatures (CRITICAL — Data Integrity)

**File**: `graph-editor/src/services/__tests__/sliceIsolation.test.ts` (NEW)

Test separation of indexing (sliceDSL) vs integrity (query_signature):

- ✓ **Slice lookup by sliceDSL**:
  - File contains 3 slices: `channel:google`, `channel:fb`, `channel:other`
  - All share same `query_signature` (same base config)
  - Lookup for `channel:google` returns ONLY that slice's data, not others
- ✓ **Incremental fetch isolation**:
  - `channel:google` has dates [1,2,5], `channel:fb` has dates [2,3,4]
  - Query for `channel:google` + window [1-5] should request dates [3,4] ONLY
  - NOT dates [1,5] (which would assume fb's data counts for google)
- ✓ **Signature mismatch handling**:
  - Slice has data with signature A
  - New query has signature B (config changed)
  - System warns but still uses slice (keyed by sliceDSL, not signature)
- ✓ **Empty sliceDSL handling**:
  - Legacy data without sliceDSL treated as empty string (uncontexted)
  - Can coexist with contexted slices in same file
- ✓ **Aggregation assertion**:
  - Call aggregation on file with contexts but no targetSlice specified
  - Should throw error, not silently aggregate mixed slices

### Query Signature Service

**File**: `graph-editor/src/services/__tests__/querySignatureService.test.ts` (NEW)

- ✓ Same spec → same signature (deterministic)
- ✓ Spec + different window → same signature (daily mode)
- ✓ Spec + different window → different signature (aggregate mode)
- ✓ Spec + different topology → different signature
- ✓ Spec + different context mapping → different signature
- ✓ `normalizeSpec` produces deterministic ordering
- ✓ Hash function is consistent across calls

### Window Aggregation & MECE Logic (CRITICAL TEST COVERAGE)

**Files**: 
- `graph-editor/src/services/__tests__/windowAggregation.dailyGrid.test.ts` (NEW — daily grid model)
- `graph-editor/src/services/__tests__/windowAggregation.mece.test.ts` (NEW — MECE logic)
- `graph-editor/src/services/__tests__/windowAggregation.subqueries.test.ts` (NEW — subquery generation)

#### Daily Grid Model Tests

Test that **context × date** grid works correctly:

| Test # | Scenario | Expected Outcome |
|--------|----------|------------------|
| 1 | Query window = stored window (exact daily coverage) | Aggregate from existing daily points; no fetch |
| 2 | Query window < stored window (subset of days) | Filter daily series to requested range; no fetch |
| 3 | Query window > stored window (superset of days) | Reuse existing days; generate subqueries for missing days only |
| 4 | Query window partially overlaps stored (some overlap) | Reuse overlapping days; fetch non-overlapping days |
| 5 | Multiple windows for same context with duplicate dates | De-duplicate by date key; latest write wins |
| 6 | Query has no context, data has MECE partition | Aggregate across MECE context values; daily series summed per-day then totaled |
| 7 | Query has context, data has finer partition (e.g., query=channel:google, data=channel:google+browser:*) | Aggregate across finer dimension (MECE check), sum daily series |

#### Subquery Generation Tests (CRITICAL)

Test that `generateMissingSubqueries` correctly identifies gaps in the 2D grid:

- ✓ **Single context, no existing data**: Generates 1 subquery for full date range
- ✓ **Single context, partial date coverage**: 
  - Existing: days 1-10, 20-30
  - Query: days 1-30
  - Expected: 1 subquery for days 11-19
- ✓ **Single context, multiple gaps**:
  - Existing: days 1-5, 15-20
  - Query: days 1-30
  - Expected: 2 subqueries (days 6-14, days 21-30)
- ✓ **Multiple contexts, different coverage per context**:
  - Context A: has days 1-30
  - Context B: has days 1-10
  - Query: both contexts, days 1-30
  - Expected: 0 subqueries for A, 1 subquery for B (days 11-30)
- ✓ **MECE aggregation triggers subqueries for missing context values**:
  - Have: `context(channel:google)` for days 1-30
  - Query: uncontexted, days 1-30
  - Registry: channel has values {google, meta, other}, otherPolicy: computed
  - Expected: 2 subqueries (`channel:meta.window(1-Jan:30-Jan)`, `channel:other.window(1-Jan:30-Jan)`)
- ✓ **Mixed otherPolicy: aggregate across MECE key only** (CRITICAL EDGE CASE):
  - Have: `context(browser-type:chrome)`, `context(browser-type:safari)`, `context(browser-type:firefox)` (days 1-30)
  - Also: `context(channel:google)`, `context(channel:meta)` (days 1-30)
  - Registry: browser-type otherPolicy:null (MECE, complete); channel otherPolicy:undefined (NOT MECE)
  - Query: uncontexted, days 1-30
  - Expected: Aggregate across browser-type values ONLY (ignore channel slices)
  - Result: Sum of chrome + safari + firefox data
  - Warning: "Aggregated across MECE partition of 'browser-type' (complete coverage)"
- ✓ **Multiple MECE keys available**:
  - Have: All browser-type values (MECE) AND all device-type values (MECE)
  - Query: uncontexted
  - Expected: Aggregate across first complete MECE key (browser-type or device-type)
  - Warning: "Also have MECE keys {...} (would give same total if complete)"

#### MECE Detection Tests (with otherPolicy variants)

**otherPolicy: null** (values are MECE as-is):
- ✓ Complete partition (all values present) → `canAggregate: true`
- ✓ Incomplete partition (missing values) → `canAggregate: false`
- ✓ "other" value NOT included in expected values
- ✓ Cannot query for `context(key:other)` (error)

**otherPolicy: computed** (other = ALL - explicit):
- ✓ Complete partition (all explicit + "other") → `canAggregate: true`
- ✓ Missing "other" → `canAggregate: false`, missingValues includes "other"
- ✓ "other" filter built dynamically as NOT (explicit values)
- ✓ Works correctly when explicit values use regex patterns

**otherPolicy: explicit** (other has its own filter):
- ✓ Complete partition (all explicit + "other") → `canAggregate: true`
- ✓ "other" filter read from registry mapping
- ✓ Behaves like any other value

**otherPolicy: undefined** (NOT MECE):
- ✓ Even with all values present → `canAggregate: false` (never safe)
- ✓ "other" NOT included in expected values
- ✓ Warns user that aggregation across this key is unsupported
- ✓ Use case: exploratory context that's not yet well-defined

**General MECE tests**:
- ✓ Detects duplicate values (non-MECE)
- ✓ Detects extra values not in registry
- ✓ Handles windows with missing sliceDSL (treated as uncontexted)

**Cross-key aggregation tests** (mixed otherPolicy):
- ✓ **Scenario 1**: browser-type (MECE, null) + channel (NOT MECE, undefined)
  - Uncontexted query aggregates across browser-type only
  - Channel slices ignored (NOT MECE)
  - Result is complete
- ✓ **Scenario 2**: Both keys MECE (browser-type:null, channel:computed)
  - Either key can be used for aggregation
  - Prefer complete partition over incomplete
  - Warn that multiple MECE keys available
- ✓ **Scenario 3**: Both keys NOT MECE (browser-type:undefined, channel:undefined)
  - Cannot aggregate at all
  - Return error/warning: "No MECE partition available"
- ✓ **Scenario 4**: One key incomplete MECE, other NOT MECE
  - Use incomplete MECE key (browser-type missing 'other')
  - Status: 'partial_data' with missing values listed
  - Ignore NOT MECE key entirely

**Merge & De-duplication Tests**:
- ✓ `mergeTimeSeriesForContext` de-duplicates by date (latest wins)
- ✓ Handles existing + new daily data correctly
- ✓ Preserves `n_daily`, `k_daily`, `dates` array integrity

### Sheets Fallback Policy

**File**: `graph-editor/src/services/__tests__/sheetsFallback.test.ts` (NEW)

- ✓ Exact match found → use it
- ✓ Exact match not found, uncontexted exists → fallback with warning
- ✓ Neither found → return null with warning
- ✓ Strict mode → error on missing exact match

### Amplitude Adapter (Context Filters & Regex)

**File**: `graph-editor/src/lib/das/__tests__/amplitudeAdapter.contexts.test.ts` (NEW)

**Context filter generation**:
- ✓ Single `context(key:value)` → generates correct filter string
- ✓ Multiple contexts (AND) → filters combined with AND logic
- ✓ `contextAny(key:v1,v2)` → generates OR clause for values, AND across keys

**Regex pattern support**:
- ✓ Value with `pattern` field → generates regex filter (not literal filter)
- ✓ Pattern with flags (case-insensitive) → includes flags in query
- ✓ Multiple values with patterns → OR them correctly
- ✓ Error when value has both pattern and filter

**otherPolicy in adapter**:
- ✓ `otherPolicy: null` → error if user queries for "other"
- ✓ `otherPolicy: computed` → dynamically builds NOT (explicit values) filter
- ✓ `otherPolicy: computed` with patterns → NOT includes pattern-based filters
- ✓ `otherPolicy: explicit` → uses filter from "other" value mapping
- ✓ `otherPolicy: undefined` → error if user queries for "other"

---

## Integration Tests

### End-to-End Query Flow

1. User selects `context(channel:google)` + `window(1-Jan-25:31-Mar-25)` in UI
2. App aggregates windows; finds none matching
3. App shows "Fetch required" indicator
4. User clicks Fetch; query constructs with context filter
5. (Mock) Amplitude returns data
6. New window written to var with correct `sliceDSL = "context(channel:google).window(1-Jan-25:31-Mar-25)"`
7. Subsequent query for same slice finds cached window (status='exact_match')

### Nightly Runner Explosion

1. Graph has `dataInterestsDSL = "context(channel);context(browser-type).window(-90d:)"`
2. Runner splits on `;` → 2 clauses
3. First clause `context(channel)` → enumerate all channel values from registry
4. Generates: `context(channel:google).window(-90d:)`, `context(channel:meta).window(-90d:)`, etc.
5. Second clause similar for browser-type
6. Runner executes all atomic queries
7. Each result stored as window with normalized `sliceDSL`

### UpdateManager Rebalancing with Contexts

**File**: `graph-editor/src/services/__tests__/UpdateManager.contexts.test.ts` (NEW)

1. Create edge with `conditional_ps`:
   - `{ condition: "context(channel:google)", mean: 0.3 }`
   - `{ condition: "context(channel:google)", mean: 0.7 }` (sibling edge)
   - `{ condition: "context(channel:meta)", mean: 0.2 }` (different context)
2. Edit first entry to mean = 0.4
3. Verify second entry rebalanced to mean = 0.6 (same condition)
4. Verify third entry unchanged (different condition)
5. Verify per-condition PMF sums to 1.0

---

## Regression Tests

- ✓ Existing graphs without `dataInterestsDSL` still load and work
- ✓ Existing windows without `sliceDSL` are treated as uncontexted, all-time
- ✓ Existing HRNs with `visited(...)`, `case(...)` still parse correctly
- ✓ ParamPackDSLService continues to handle non-contexted params
- ✓ Window aggregation for non-contexted queries works as before

---

## Performance Tests

**Target**: <1s aggregation latency (excluding external API calls)

**Test scenarios**:
1. 100 params × 16 slices each × 365 days
2. Query touches 20 params
3. Measure:
   - Index build time (first query per param)
   - Aggregation time (subsequent queries)
   - Memory usage
4. Verify <1s latency budget met

**Optimization if needed**:
- Profile hotspots
- Optimize date filtering/aggregation
- Consider caching parsed DSL strings

---

## Rollout Phases

### Phase 1: Core Infrastructure ✓

**Schema & Types**:
- Add `dataInterestsDSL` and `currentQueryDSL` to graph schema
- Add `sliceDSL` to `ParameterValue` (required field; empty string for legacy)
- Extend `context-definition-schema.yaml` (add `otherPolicy`, `sources` with `field`/`filter`/`pattern`)

**DSL Parsing**:
- Implement `constraintParser.ts` (shared parsing utility for `context`, `contextAny`, `window`)
- Update `query-dsl-1.0.0.json` schema (register new functions)
- Mirror changes in Python `query_dsl.py`

**Query Signature Service (NEW)**:
- Implement `querySignatureService.ts` (centralized signature generation/validation)
  - `buildDailySignature()` — excludes date bounds for daily-capable sources
  - `buildAggregateSignature()` — includes date bounds for aggregate sources
  - `validateSignature()` — checks if stored sig matches current spec
- Define `DataQuerySpec` interface (normalized form of "what we'd send to external source")

**Context Registry**:
- Deploy `contexts-index.yaml` + individual context definition files
- Implement `ContextRegistry.ts` (lazy-load definitions, validate against extended schema)

**Date Handling**:
- All date formatting uses `d-MMM-yy` format from day one (no YYYY-MM-DD anywhere)

### Phase 2: Data Operations Refactoring (CRITICAL) ⚠️

**Risk Mitigation**: Phase 2 blocks Phase 3. To reduce delay risk:
- Break into sub-releases: Tasks 2.1-2.2 (refactoring) merge separately from 2.4 (new aggregation)
- Phase 3 can start after 2.1-2.2 complete (basic chip rendering doesn't need full MECE logic)
- Allocate 2-3 senior engineers to Phase 2 exclusively

**Existing Code Updates** (to fix signature/indexing conflation):

1. **`dataOperationsService.ts`** (~200 lines affected, lines 2100-2300):
   - Replace all `filter(v => v.query_signature === sig)` with `filter(v => v.sliceDSL === targetSlice)`
   - Use `querySignatureService.validateSignature()` for staleness checks AFTER slice isolation
   - Build `DataQuerySpec` from current graph state before signature comparison
   - Add assertions: if file has contexts but no `targetSlice` specified, throw error

2. **`windowAggregationService.ts`** (~100 lines affected):
   - All functions accept `targetSlice: string` parameter
   - First line of each function: `const sliceValues = values.filter(v => v.sliceDSL === targetSlice)`
   - Replace ad-hoc signature checks with `querySignatureService.validateSignature()`
   - Add safeguard: if `values` has contexts but no `targetSlice` → error

3. **Amplitude/Sheets Adapters**:
   - Replace inline signature generation with `querySignatureService.buildDailySignature()` or `buildAggregateSignature()`
   - Build `DataQuerySpec` from adapter request parameters
   - Store returned `query_signature` on fetched `ParameterValue` entries

**New Aggregation Logic**:
- Implement context-aware window aggregation (2D grid, MECE detection, otherPolicy)
- Add in-memory `VariableAggregationCache` for performance (<1s latency target)

### Phase 3: UI Components 🎨

- Extend `WindowSelector.tsx` with context chips (using enhanced QueryExpressionEditor)
- Implement `ContextValueSelector` component (shared for per-chip and Add Context dropdowns)
- Add unroll state with full DSL editor
- Implement Pinned Query modal with slice count/enumeration preview
- Remove What-if button from WindowSelector (moved to Scenarios panel)

### Phase 4: Nightly Runner 🌙

- Implement `expand_clause()` logic with explosion cap (warn if >500 slices)
- Schedule nightly runs for graphs with `dataInterestsDSL`
- Monitor API usage and query volume
- Implement graceful degradation (skip graph on errors, log warnings)

### Phase 5: Validation & Polish ✨

- Graph-level validation of `dataInterestsDSL` against registry
- AggregationResult status → UI behavior (toasts, badges, Fetch button logic)
- Comprehensive test suite (all 7 daily grid scenarios + 4 otherPolicy variants + regex)
- Performance profiling (confirm <1s aggregation latency)

---

## Migration & Rollout Validation

**Note**: Contexts is a **new feature** built from scratch. No legacy data migration needed.

### Pre-Rollout Checklist

- [ ] All unit tests passing (DSL parsing, registry, MECE, aggregation)
- [ ] All integration tests passing (end-to-end query flow, nightly runner)
- [ ] Performance tests meet <1s latency target
- [ ] Regression tests confirm existing functionality unaffected
- [ ] Context registry deployed with initial definitions (channel, browser-type, etc.)
- [ ] Monaco autocomplete includes `context`, `contextAny`, `window` functions
- [ ] UI components tested in isolation (Storybook or equivalent)

### Rollout Steps

1. **Week 1: Core infrastructure**
   - Deploy schema changes
   - Deploy context registry
   - Enable DSL parsing (no UI yet)
   - Monitor for parsing errors

2. **Week 2: Data operations refactoring**
   - Deploy updated `dataOperationsService` and `windowAggregationService`
   - Enable query signature service
   - Monitor for aggregation errors
   - Verify no regression in existing queries

3. **Week 3: UI components**
   - Deploy WindowSelector with context chips
   - Enable context dropdowns
   - Enable Pinned Query modal
   - Monitor user interactions

4. **Week 4: Nightly runner**
   - Enable nightly runner for graphs with `dataInterestsDSL`
   - Monitor slice counts and API usage
   - Adjust caps/throttling as needed

5. **Week 5+: Polish & iterate**
   - Collect user feedback
   - Fix bugs and polish UX
   - Optimize performance if needed
   - Add additional context definitions as requested

### Monitoring Metrics

**During rollout, monitor**:
- Parse errors in DSL parsing
- Aggregation errors/warnings
- Query latency (p50, p95, p99)
- Amplitude API call volume
- Nightly runner slice counts
- User adoption (graphs with `dataInterestsDSL` set)

**Success criteria**:
- <1% error rate in aggregation
- <1s query latency (p95)
- Amplitude API usage within budget
- 10+ graphs using contexts within first month

---

## Implementation Priority

**Critical path** (must complete in order):
1. ✅ Schema updates and DSL parsing
2. ⚠️ **Data operations refactoring** (highest risk; must get right)
3. ✅ Context registry and MECE detection
4. ✅ Window aggregation algorithm
5. ✅ Amplitude adapter extensions
6. 🎨 UI components
7. 🌙 Nightly runner

**Parallel tracks** (can work simultaneously):
- UI design and component implementation
- Testing infrastructure setup
- Documentation and examples

---

## Test Coverage Summary

### Must-Have Coverage

- [x] DSL parsing (all constraint types, normalization, edge cases)
- [x] Context registry (schema, otherPolicy, regex patterns)
- [x] Slice isolation (prevent cross-slice corruption)
- [x] Query signature service (deterministic, daily vs aggregate)
- [x] MECE detection (all 4 otherPolicy variants)
- [x] Daily grid aggregation (all 7 scenarios)
- [x] Subquery generation (gap detection, batching)
- [x] Amplitude adapter (filters, regex, otherPolicy)
- [x] Sheets fallback (exact, fallback, warnings)
- [x] UpdateManager rebalancing (context-bearing conditions)

### Nice-to-Have Coverage

- [ ] Performance benchmarks (large datasets)
- [ ] UI component unit tests (Storybook + Jest)
- [ ] End-to-end UI tests (Playwright or Cypress)
- [ ] Nightly runner stress tests (>500 slices)

---

## Next Steps

1. Begin Phase 1 implementation (core infrastructure)
2. Set up test files and infrastructure
3. Implement `constraintParser.ts` with full test coverage
4. Implement `querySignatureService.ts` with full test coverage
5. Proceed to Phase 2 (data operations refactoring) once Phase 1 complete

