# Contexts: Implementation Plan

**Status**: Ready for implementation  
**Target**: v1 contexts support  
**Duration**: 8-10 weeks  
**Last Updated**: 2025-11-24

---

## Overview

This document provides a task-oriented implementation plan for contexts v1. For detailed design specifications, refer to the linked design documents.

**Design Documentation**:
- **[README.md](./README.md)** — Navigation and overview
- **[CONTEXTS_ARCHITECTURE.md](./CONTEXTS_ARCHITECTURE.md)** — Core architecture
- **[CONTEXTS_REGISTRY.md](./CONTEXTS_REGISTRY.md)** — Context definitions
- **[CONTEXTS_AGGREGATION.md](./CONTEXTS_AGGREGATION.md)** — Aggregation algorithms
- **[CONTEXTS_ADAPTERS.md](./CONTEXTS_ADAPTERS.md)** — Data source integrations
- **[CONTEXTS_UI_DESIGN.md](./CONTEXTS_UI_DESIGN.md)** — Visual design & UX
- **[CONTEXTS_TESTING_ROLLOUT.md](./CONTEXTS_TESTING_ROLLOUT.md)** — Testing & rollout

---

## Phase 1: Core Infrastructure (Weeks 1-2)

**Goal**: Establish foundational schemas, types, and parsing infrastructure

**Prerequisites**: None  
**Risk Level**: Low  
**Estimated Duration**: 1-2 weeks

---

### Task 1.1: Schema Extensions

**Owner**: Backend/Schema team  
**Duration**: 2 days  
**Design Reference**: [CONTEXTS_ARCHITECTURE.md → Data Model & Schema Changes](./CONTEXTS_ARCHITECTURE.md#data-model--schema-changes)

**Deliverables**:
1. Update `param-registry/schemas/conversion-graph-1.0.0.json`:
   - Add `dataInterestsDSL?: string` field
   - Add `currentQueryDSL?: string` field

2. Update `graph-editor/src/types/index.ts`:
   - Add fields to `Graph` interface
   - Add fields to `ParameterValue` interface:
     - `sliceDSL: string` (required, empty string default)
     - Ensure `query_signature?: string` remains optional

3. Extend `param-registry/param-schemas/context-definition-schema.yaml`:
   - Add `otherPolicy` enum field (null | computed | explicit | undefined)
   - Add `sources` object with `field`, `filter`, `pattern`, `patternFlags`

4. Update `graph-editor/public/schemas/query-dsl-1.0.0.json`:
   - Register `context`, `contextAny`, `window` functions

**Acceptance Criteria**:
- [ ] All schema files validate
- [ ] TypeScript types compile without errors
- [ ] No breaking changes to existing fields

---

### Task 1.2: Extend Constraint Parser

**Owner**: Core services team  
**Duration**: 2 days  
**Design Reference**: [CONTEXTS_ARCHITECTURE.md → Constraint Parsing Extensions](./CONTEXTS_ARCHITECTURE.md#constraint-parsing-extensions)

**Existing**: `queryDSL.ts` already has `parseConstraints()`, `normalizeConstraintString()`, and `context(key:value)` parsing

**Deliverables**:
1. Extend `ParsedConstraints` interface in `queryDSL.ts`:
   - Add `contextAnys: Array<{ pairs: Array<{ key: string; value: string }> }>`
   - Add `window: { start?: string; end?: string } | null`

2. Update `parseConstraints()` function:
   - Add regex for `contextAny(key:val,key:val,...)`
   - Add regex for `window(start:end)`

3. Update `normalizeConstraintString()`:
   - Include contextAny and window in canonical order
   - Normalize window dates to `d-MMM-yy` format

4. Write unit tests for new constraint types

**Acceptance Criteria**:
- [ ] `contextAny` and `window` parse correctly
- [ ] Normalization includes new types
- [ ] Existing `context()` parsing unchanged
- [ ] Test coverage >95% for new code

**Dependencies**: Task 1.1 (schema updates)

---

### Task 1.3: Query Signature Service

**Owner**: Core services team  
**Duration**: 3 days  
**Design Reference**: [CONTEXTS_ARCHITECTURE.md → Data Query Signature Service](./CONTEXTS_ARCHITECTURE.md#data-query-signature-service)

**Deliverables**:
1. Create `graph-editor/src/services/querySignatureService.ts`:
   - Define `DataQuerySpec` interface
   - Implement `QuerySignatureService` class:
     - `buildDailySignature(spec)` — excludes window bounds
     - `buildAggregateSignature(spec)` — includes window bounds
     - `validateSignature(storedSig, currentSpec)`
     - `normalizeSpec(spec)` — deterministic ordering
     - `hashSpec(normalized)` — SHA-256

2. Write unit tests:
   - Same spec → same signature (deterministic)
   - Daily mode: different window → same signature
   - Aggregate mode: different window → different signature
   - Different topology/mappings → different signature

**Acceptance Criteria**:
- [ ] Signatures are deterministic
- [ ] Daily vs aggregate modes work correctly
- [ ] Test coverage >95%

**Dependencies**: Task 1.2 (ParsedConstraints for DataQuerySpec)

---

### Task 1.4: Context Registry & Definitions

**Owner**: Registry team  
**Duration**: 2 days  
**Design Reference**: [CONTEXTS_REGISTRY.md → Context Registry Loading](./CONTEXTS_REGISTRY.md#context-registry-loading)

**Existing**: `paramRegistryService` already has `loadContext()` and `loadContextsIndex()`

**Deliverables**:
1. Create `contextRegistry.ts` wrapper (thin layer over paramRegistryService):
   - `getContext(id)` — wraps paramRegistryService.loadContext
   - `getSourceMapping(key, value, source)` — extracts source mappings
   - `getValuesForContext(key)` — respects otherPolicy

2. Create context definition files:
   - `param-registry/contexts/channel.yaml` (example with otherPolicy, sources)
   - `param-registry/contexts/browser-type.yaml` (example)
   - `param-registry/contexts-index.yaml` (if doesn't exist)

**Acceptance Criteria**:
- [ ] Context YAML files parse against extended schema
- [ ] Registry wrapper provides otherPolicy-aware value lists
- [ ] Source mappings accessible via getSourceMapping()

**Dependencies**: Task 1.1 (schema extensions for otherPolicy, sources)

---

### Task 1.5: Monaco DSL Registration

**Owner**: Frontend team  
**Duration**: 1 day  
**Design Reference**: [CONTEXTS_ARCHITECTURE.md → DSL Parsing & Normalization](./CONTEXTS_ARCHITECTURE.md#dsl-parsing--normalization)

**Deliverables**:
1. Update `graph-editor/src/lib/queryDSL.ts`:
   - Add `context`, `contextAny`, `window` to `QUERY_FUNCTIONS`
   - Include signatures, descriptions, examples

2. Register functions in Monaco language definition

**Acceptance Criteria**:
- [ ] Autocomplete suggests new functions
- [ ] Function signatures display in hover tooltips

**Dependencies**: Task 1.1 (DSL schema)

---

### Task 1.6: Python Parser Extensions

**Owner**: Backend team  
**Duration**: 2 days  
**Design Reference**: [CONTEXTS_ARCHITECTURE.md → DSL Parsing & Normalization](./CONTEXTS_ARCHITECTURE.md#dsl-parsing--normalization)

**Deliverables**:
1. Update `python-backend/query_dsl.py`:
   - Add `context`, `contextAny`, `window` to constraint patterns
   - Mirror TypeScript normalization logic
   - Ensure canonical ordering matches TypeScript

2. Write unit tests (mirror TypeScript tests)

**Acceptance Criteria**:
- [ ] Python normalization matches TypeScript output
- [ ] Test coverage >95%

**Dependencies**: Task 1.2 (TypeScript parser as reference)

---

## Phase 2: Data Operations Refactoring (Weeks 3-5)

**Goal**: Separate sliceDSL (indexing) from query_signature (integrity); implement context-aware aggregation

**Prerequisites**: Phase 1 complete  
**Risk Level**: ⚠️ **HIGH** (data corruption if done incorrectly)  
**Estimated Duration**: 2-3 weeks

---

### Task 2.1: Data Operations Service Refactoring

**Owner**: Core services team  
**Duration**: 5 days  
**Design Reference**: [CONTEXTS_ARCHITECTURE.md → Implementation Risks & Critical Paths](./CONTEXTS_ARCHITECTURE.md#implementation-risks--critical-paths)

**Deliverables**:
1. Refactor `graph-editor/src/services/dataOperationsService.ts` (lines ~2100-2300):
   - Replace ALL `filter(v => v.query_signature === sig)` with `filter(v => v.sliceDSL === targetSlice)`
   - Add mandatory `targetSlice` parameter to relevant functions
   - Add assertions: error if `values` has contexts but no `targetSlice` specified
   - Use `querySignatureService.validateSignature()` AFTER slice isolation
   - Build `DataQuerySpec` from current graph state for signature checks

2. Add safeguards:
   ```typescript
   if (values.some(v => v.sliceDSL) && !targetSlice) {
     throw new Error('targetSlice required when operating on contexted data');
   }
   ```

**Acceptance Criteria**:
- [ ] All functions filter by sliceDSL first
- [ ] No query_signature used for indexing
- [ ] Safeguards prevent cross-slice aggregation
- [ ] Existing tests pass (with modifications for new parameters)

**Dependencies**: Task 1.2 (constraintParser), Task 1.3 (querySignatureService)

**⚠️ CRITICAL**: This task has highest risk. Requires careful review and extensive testing.

---

### Task 2.2: Window Aggregation Service Refactoring

**Owner**: Core services team  
**Duration**: 4 days  
**Design Reference**: [CONTEXTS_AGGREGATION.md → Data Lookup Pattern](./CONTEXTS_AGGREGATION.md#data-lookup-pattern-mandatory)

**Deliverables**:
1. Refactor `graph-editor/src/services/windowAggregationService.ts`:
   - Add `targetSlice: string` parameter to all aggregation functions
   - First line of each function: `const sliceValues = values.filter(v => v.sliceDSL === targetSlice)`
   - Replace ad-hoc signature checks with `querySignatureService.validateSignature()`
   - Add safeguard assertion (same as Task 2.1)

2. Update callers to pass `targetSlice` parameter

**Acceptance Criteria**:
- [ ] All aggregation functions accept targetSlice
- [ ] Slice isolation happens before any logic
- [ ] No mixing of different slices
- [ ] Existing tests pass

**Dependencies**: Task 2.1, Task 1.3 (querySignatureService)

**⚠️ CRITICAL**: Must not aggregate across slices.

---

### Task 2.3: MECE Detection Implementation

**Owner**: Registry team  
**Duration**: 3 days  
**Design Reference**: [CONTEXTS_REGISTRY.md → MECE Detection Algorithm](./CONTEXTS_REGISTRY.md#mece-detection-algorithm)

**Deliverables**:
1. Implement in `contextRegistry.ts`:
   - `detectMECEPartition(windows, contextKey, registry)`
   - `getExpectedValuesForPolicy(contextDef)`
   - `determineAggregationSafety(contextDef, isComplete)`

2. Return object:
   ```typescript
   {
     isMECE: boolean,
     isComplete: boolean,
     canAggregate: boolean,
     missingValues: string[],
     policy: string
   }
   ```

3. Handle all 4 otherPolicy variants:
   - `null`: explicit values only, MECE if complete
   - `computed`: explicit + "other", MECE if complete
   - `explicit`: explicit + "other", MECE if complete
   - `undefined`: NOT MECE, never canAggregate

**Acceptance Criteria**:
- [ ] All 4 otherPolicy variants tested
- [ ] Detects duplicates and extras correctly
- [ ] canAggregate flag correct for each policy

**Dependencies**: Task 1.4 (contextRegistry)

---

### Task 2.4: Daily Grid Aggregation Logic

**Owner**: Core services team  
**Duration**: 5 days  
**Design Reference**: [CONTEXTS_AGGREGATION.md → Daily Grid Aggregation: Step-by-Step](./CONTEXTS_AGGREGATION.md#daily-grid-aggregation-step-by-step)

**Deliverables**:
1. Implement in `windowAggregationService.ts` (or new file):
   - `determineContextCombinations(constraints)`
   - `getExistingDatesForContext(variable, contextCombo)`
   - `generateMissingSubqueries(variable, contextCombo, window)`
   - `executeMissingSubqueries(subqueries, variable)`
   - `mergeTimeSeriesForContext(variable, contextCombo, newData)`
   - `aggregateWindowsWithContexts(request): AggregationResult`

2. Implement `tryMECEAggregationAcrossContexts`:
   - Handle mixed otherPolicy (MECE vs non-MECE keys)
   - Aggregate across MECE key only
   - Ignore non-MECE keys with warning

3. Return `AggregationResult` with status:
   - `'complete'` | `'mece_aggregation'` | `'partial_data'` | `'prorated'`

**Acceptance Criteria**:
- [ ] All 7 daily grid scenarios pass tests
- [ ] MECE aggregation works correctly
- [ ] Mixed otherPolicy edge case handled
- [ ] Subquery generation correct

**Dependencies**: Task 2.2 (refactored windowAggregationService), Task 2.3 (MECE detection)

**⚠️ CRITICAL**: Complex logic. Requires comprehensive testing.

---

### Task 2.5: In-Memory Aggregation Cache

**Owner**: Core services team  
**Duration**: 2 days  
**Design Reference**: [CONTEXTS_AGGREGATION.md → Performance Considerations](./CONTEXTS_AGGREGATION.md#performance-considerations)

**Deliverables**:
1. Create `VariableAggregationCache` class:
   - `getWindowForContext(variable, contextCombo)` — O(1) lookup
   - `buildIndexForVariable(variable)` — lazy build on first access
   - `invalidate(variableId)` — clear on write

2. Build index mapping: `contextComboKey → ParameterValue`

3. Integrate into aggregation functions

**Acceptance Criteria**:
- [ ] Index builds lazily (first query per variable)
- [ ] Subsequent lookups are O(1)
- [ ] Invalidates correctly on writes
- [ ] Meets <1s aggregation latency target (profile with realistic data)

**Dependencies**: Task 2.4 (aggregation logic)

---

## Phase 3: UI Components (Weeks 6-7)

**Goal**: Build context selection UI with dynamic chips and dropdowns

**Prerequisites**: Phase 1 complete, Phase 2 partially complete (for data binding)  
**Risk Level**: Medium  
**Estimated Duration**: 2 weeks

---

### Task 3.1: QueryExpressionEditor Extensions

**Owner**: Frontend team  
**Duration**: 3 days  
**Design Reference**: [CONTEXTS_UI_DESIGN.md → Extension to QueryExpressionEditor](./CONTEXTS_UI_DESIGN.md#extension-to-queryexpressioneditor)

**Deliverables**:
1. Extend `graph-editor/src/components/QueryExpressionEditor.tsx`:
   - Add chip rendering for `context`, `contextAny`, `window`
   - Add `▾` dropdown trigger button to each context chip
   - Add `✕` remove button to each chip
   - Wire up `openValueDropdownForChip(chip)` handler

2. Implement dynamic width behavior:
   - Min: 60px (empty), Max: 450px
   - Smooth transitions (0.2s ease-out)
   - CSS: `max-width: min(450px, 40vw)`

**Acceptance Criteria**:
- [ ] Context chips render correctly
- [ ] Per-chip dropdown opens on `▾` click
- [ ] Remove button works
- [ ] Dynamic width transitions smoothly
- [ ] Responsive (wraps gracefully on narrow screens)

**Dependencies**: Task 1.2 (constraintParser for DSL binding)

---

### Task 3.2: ContextValueSelector Component

**Owner**: Frontend team  
**Duration**: 4 days  
**Design Reference**: [CONTEXTS_UI_DESIGN.md → Components Breakdown](./CONTEXTS_UI_DESIGN.md#components-breakdown)

**Deliverables**:
1. Create `graph-editor/src/components/ContextValueSelector.tsx`:
   - Props: `mode: 'single-key' | 'multi-key'`, `contextKey`, `availableValues`, `currentValues`, `onValuesChange`
   - Render checkboxes for values
   - Implement Apply/Cancel buttons (draft mode)
   - For `multi-key` mode: accordion sections
   - For `multi-key` mode: auto-uncheck logic (expanding one section collapses others)

2. Implement value list logic:
   - Query `contextRegistry.getValuesForContext(key)`
   - Respect otherPolicy (show/hide "other" checkbox)

3. Implement all-values-checked logic:
   - If all checked AND canAggregate → remove chip (show tooltip)
   - If all checked AND NOT canAggregate → keep chip

**Acceptance Criteria**:
- [ ] Single-key mode works (per-chip dropdown)
- [ ] Multi-key mode works (Add Context dropdown)
- [ ] Auto-uncheck behavior correct
- [ ] Apply commits changes, Cancel abandons
- [ ] otherPolicy respected (show/hide "other")

**Dependencies**: Task 1.4 (contextRegistry for value lists)

---

### Task 3.3: WindowSelector Integration

**Owner**: Frontend team  
**Duration**: 2 days  
**Design Reference**: [CONTEXTS_UI_DESIGN.md → WindowSelector Toolbar](./CONTEXTS_UI_DESIGN.md#windowselector-toolbar-single-line)

**Deliverables**:
1. Remove existing Context button (lines 794-816)
2. Remove What-if button (moved to Scenarios panel)
3. Add context chips area using QueryExpressionEditor:
   - Dynamic width (60-450px)
   - Positioned after date picker
   - Bind to `graph.currentQueryDSL` (context portion)
4. Add `[+ Context ▾]` button (new, not same as old Context button)
   - Opens ContextValueSelector in multi-key mode
   - Shows accordion sections from `dataInterestsDSL`
5. Add `[⤵]` unroll button
   - Shows full DSL + Pinned query button

**Acceptance Criteria**:
- [ ] Old Context button removed
- [ ] What-if button removed
- [ ] Context chips display correctly
- [ ] New `[+ Context ▾]` button works
- [ ] Unroll state functional

**Dependencies**: Task 3.1 (QueryExpressionEditor), Task 3.2 (ContextValueSelector)

---

### Task 3.4: Pinned Query Modal

**Owner**: Frontend team  
**Duration**: 2 days  
**Design Reference**: [CONTEXTS_UI_DESIGN.md → Pinned Query Modal](./CONTEXTS_UI_DESIGN.md#pinned-query-modal)

**Deliverables**:
1. Create modal component for editing `dataInterestsDSL`:
   - Monaco editor for DSL input
   - Live preview of implied slices:
     - Show count (e.g., "47 atomic slices")
     - Enumerate first 10-20 slices
     - If count > 50: show warning
     - If count > 500: show error (but allow save)
   - Save/Cancel buttons

2. Implement slice enumeration preview:
   - Parse `dataInterestsDSL`
   - Expand bare `context(key)` to all registry values
   - Show resulting atomic slices

**Acceptance Criteria**:
- [ ] Modal opens from unrolled state button
- [ ] Monaco editor works with syntax highlighting
- [ ] Preview shows slice count and enumeration
- [ ] Warnings display correctly (>50, >500)
- [ ] Save updates graph.dataInterestsDSL

**Dependencies**: Task 1.4 (contextRegistry for expansion)

---

### Task 3.5: Data Coverage Integration

**Owner**: Frontend team  
**Duration**: 2 days  
**Design Reference**: [CONTEXTS_UI_DESIGN.md → Integration with Implementation Documents](./CONTEXTS_UI_DESIGN.md#integration-with-implementation-documents)

**Deliverables**:
1. Integrate aggregation status into UI:
   - After Apply in dropdown → call `aggregateWindowsWithContexts`
   - Map `AggregationResult.status` to UI behavior:
     - `'complete'`: hide Fetch button, show data
     - `'mece_aggregation'`: hide Fetch, show data + inline hint
     - `'partial_data'`: show Fetch + "Partial" badge + toast
     - `'prorated'`: hide Fetch + "Prorated" badge + toast

2. Implement Fetch button logic:
   - Show when data not cached
   - Click triggers adapter query
   - Update UI after successful fetch

**Acceptance Criteria**:
- [ ] Data displays instantly if cached
- [ ] Fetch button appears when needed
- [ ] Badges and toasts display correctly for each status
- [ ] No hard failures (graceful degradation)

**Dependencies**: Task 2.4 (aggregation logic), Phase 4 for actual fetching

---

## Phase 4: Adapter Extensions (Weeks 6-7, parallel with Phase 3)

**Goal**: Extend Amplitude and Sheets adapters to handle context filters

**Prerequisites**: Phase 1 complete, Task 2.4 (aggregation spec)  
**Risk Level**: Medium  
**Estimated Duration**: 2 weeks (parallel with Phase 3)

---

### Task 4.1: Amplitude Adapter Extensions

**Owner**: Backend/adapter team  
**Duration**: 4 days  
**Design Reference**: [CONTEXTS_ADAPTERS.md → Amplitude Adapter Extensions](./CONTEXTS_ADAPTERS.md#amplitude-adapter-extensions)

**Deliverables**:
1. Extend `graph-editor/src/lib/das/buildDslFromEdge.ts`:
   - Add `constraints?: ParsedConstraints` parameter
   - Implement `buildContextFilters(constraints, source)`
   - Implement `resolveWindowDates(windowConstraint)`
   - Add filters to DSL object

2. Implement context filter generation:
   - For each `context(key:value)`: look up `sources[amplitude].filter` from registry
   - For `contextAny(...)`: build OR clauses within key, AND across keys
   - Handle regex patterns: `mapping.pattern` → regex filter syntax
   - Handle `otherPolicy: computed`: dynamically generate NOT filter

3. Integrate query signature:
   - Build `DataQuerySpec` from request
   - Call `querySignatureService.buildDailySignature(spec)`
   - Store signature on returned `ParameterValue`

4. Verify Amplitude API syntax:
   - Confirm exact filter syntax with API docs
   - Test regex filter syntax
   - Validate time-series response parsing

**Acceptance Criteria**:
- [ ] Context filters build correctly
- [ ] Regex patterns work
- [ ] otherPolicy: computed generates correct NOT filter
- [ ] Query signature stored correctly
- [ ] API calls succeed (integration test)

**Dependencies**: Task 1.2 (constraintParser), Task 1.3 (querySignatureService), Task 1.4 (contextRegistry)

---

### Task 4.2: Sheets Adapter Extensions

**Owner**: Backend/adapter team  
**Duration**: 2 days  
**Design Reference**: [CONTEXTS_ADAPTERS.md → Sheets Adapter Extensions](./CONTEXTS_ADAPTERS.md#sheets-adapter-extensions)

**Deliverables**:
1. Update `graph-editor/src/services/ParamPackDSLService.ts`:
   - Extend regex to include `contextAny` and `window`
   - Implement fallback policy (Option B: fallback with warning)
   - Implement `resolveSheetParameter(hrn, paramPack, fallbackPolicy)`
   - Implement `removeContextFromHRN(hrn)` for fallback

2. Integration:
   - Use `querySignatureService.buildAggregateSignature()` (Sheets returns aggregates)
   - Include window bounds in signature

**Acceptance Criteria**:
- [ ] Context HRNs parse correctly
- [ ] Fallback to uncontexted works (with warning)
- [ ] Warnings surface in UI (toast or badge)

**Dependencies**: Task 1.2 (constraintParser), Task 1.3 (querySignatureService)

---

### Task 4.3: Nightly Runner Implementation

**Owner**: Backend team  
**Duration**: 4 days  
**Design Reference**: [CONTEXTS_ADAPTERS.md → Nightly Runner Integration](./CONTEXTS_ADAPTERS.md#nightly-runner-integration)

**Deliverables**:
1. Implement `python-backend/nightly_runner.py` (or equivalent):
   - `run_nightly_for_graph(graph_id)`
   - `expand_clause(clause)` — explode `context(key)` to all registry values
   - `expand_pinned_dsl(pinned_dsl)` — full explosion with cap

2. Implement explosion cap:
   - Warn if > 500 atomic slices
   - Log warning but proceed (non-blocking)

3. Implement scheduling:
   - Run for all graphs with `dataInterestsDSL` set
   - Deduplicate by `sliceDSL` before writing
   - Use incremental fetch per context

4. Error handling:
   - Log failures per graph
   - Continue to next graph on error
   - No hard crash

**Acceptance Criteria**:
- [ ] Explosion logic works (bare keys → all values)
- [ ] Cap warning displays correctly
- [ ] Nightly run completes for all graphs
- [ ] Errors logged but don't block other graphs

**Dependencies**: Task 1.4 (contextRegistry for expansion), Task 1.6 (Python parser)

---

## Phase 5: Testing & Validation (Week 8-10)

**Goal**: Comprehensive testing and performance validation

**Prerequisites**: Phases 1-4 complete  
**Risk Level**: Low (catch issues before rollout)  
**Estimated Duration**: 2-3 weeks

---

### Task 5.1: Unit Test Suite

**Owner**: All teams  
**Duration**: Ongoing (parallel with development)  
**Design Reference**: [CONTEXTS_TESTING_ROLLOUT.md → Unit Tests](./CONTEXTS_TESTING_ROLLOUT.md#unit-tests)

**Test Files to Create**:

1. `constraintParser.test.ts`:
   - Parse all constraint types
   - Normalization idempotence
   - Date normalization
   - Malformed strings

2. `contextRegistry.test.ts`:
   - Load index and definitions
   - Schema validation
   - otherPolicy handling (all 4 variants)
   - Regex pattern support

3. `sliceIsolation.test.ts`:
   - Slice lookup by sliceDSL
   - Incremental fetch isolation
   - Signature mismatch handling
   - Aggregation assertions

4. `querySignatureService.test.ts`:
   - Deterministic signatures
   - Daily vs aggregate modes
   - Different specs → different signatures

5. `windowAggregation.dailyGrid.test.ts`:
   - All 7 daily grid scenarios

6. `windowAggregation.mece.test.ts`:
   - All 4 otherPolicy variants
   - Cross-key aggregation (mixed otherPolicy)

7. `windowAggregation.subqueries.test.ts`:
   - Missing date range detection
   - Multiple contexts with different coverage
   - MECE aggregation triggers subqueries

8. `sheetsFallback.test.ts`:
   - Exact match, fallback, warnings

9. `amplitudeAdapter.contexts.test.ts`:
   - Context filter generation
   - Regex patterns
   - otherPolicy in adapter

**Acceptance Criteria**:
- [ ] All test files created
- [ ] Test coverage >95% for new code
- [ ] All tests passing

---

### Task 5.2: Integration Tests

**Owner**: QA team  
**Duration**: 1 week  
**Design Reference**: [CONTEXTS_TESTING_ROLLOUT.md → Integration Tests](./CONTEXTS_TESTING_ROLLOUT.md#integration-tests)

**Test Scenarios**:

1. **End-to-End Query Flow**:
   - User selects context + window in UI
   - App aggregates windows
   - Fetch button appears
   - User clicks Fetch
   - Query executes
   - Data displays

2. **Nightly Runner Explosion**:
   - Graph with `dataInterestsDSL`
   - Runner explodes to atomic slices
   - All slices fetched
   - Data stored correctly

3. **UpdateManager Rebalancing**:
   - Edge with context-bearing conditions
   - Edit one entry
   - Verify rebalancing per condition
   - Verify PMF sums to 1.0

**Acceptance Criteria**:
- [ ] All integration scenarios pass
- [ ] No data corruption
- [ ] Errors handled gracefully

---

### Task 5.3: Performance Validation

**Owner**: Performance team  
**Duration**: 3 days  
**Design Reference**: [CONTEXTS_TESTING_ROLLOUT.md → Performance Tests](./CONTEXTS_TESTING_ROLLOUT.md#performance-tests)

**Test Scenarios**:
1. Load 100 params × 16 slices × 365 days
2. Query touching 20 params
3. Measure:
   - Index build time (first query per param)
   - Aggregation time (subsequent queries)
   - Memory usage

**Acceptance Criteria**:
- [ ] Aggregation latency <1s (p95)
- [ ] Index build <10ms per param
- [ ] Memory usage acceptable

---

### Task 5.4: Regression Testing

**Owner**: QA team  
**Duration**: 2 days  
**Design Reference**: [CONTEXTS_TESTING_ROLLOUT.md → Regression Tests](./CONTEXTS_TESTING_ROLLOUT.md#regression-tests)

**Test Cases**:
- [ ] Existing graphs without `dataInterestsDSL` still work
- [ ] Existing windows without `sliceDSL` treated as uncontexted
- [ ] Existing HRNs with `visited(...)`, `case(...)` parse correctly
- [ ] ParamPackDSLService handles non-contexted params
- [ ] Window aggregation for non-contexted queries works as before

**Acceptance Criteria**:
- [ ] No regressions in existing functionality
- [ ] Backward compatibility maintained

---

### Task 5.5: Documentation & Examples

**Owner**: Documentation team  
**Duration**: 3 days

**Deliverables**:
1. User-facing documentation:
   - How to add contexts to a graph
   - How to use context filters in UI
   - Example context definitions
   - Pinned query DSL guide

2. Developer documentation:
   - API documentation for new services
   - Integration guide for adapters
   - Troubleshooting guide

**Acceptance Criteria**:
- [ ] User docs complete
- [ ] Developer docs complete
- [ ] Examples tested and verified

---

## Rollout Plan (Post-Implementation)

**Design Reference**: [CONTEXTS_TESTING_ROLLOUT.md → Rollout Steps](./CONTEXTS_TESTING_ROLLOUT.md#rollout-steps)

### Week 1: Core Infrastructure
- Deploy schema changes
- Deploy context registry
- Enable DSL parsing (no UI yet)
- Monitor for parsing errors

### Week 2: Data Operations
- Deploy updated `dataOperationsService` and `windowAggregationService`
- Enable query signature service
- Monitor for aggregation errors
- Verify no regression

### Week 3: UI Components
- Deploy WindowSelector with context chips
- Enable context dropdowns
- Enable Pinned Query modal
- Monitor user interactions

### Week 4: Nightly Runner
- Enable nightly runner for graphs with `dataInterestsDSL`
- Monitor slice counts and API usage
- Adjust caps/throttling as needed

### Week 5+: Polish & Iterate
- Collect user feedback
- Fix bugs and polish UX
- Optimize performance if needed
- Add additional context definitions

---

## Success Criteria

### Functional
- [ ] All unit tests passing (>95% coverage)
- [ ] All integration tests passing
- [ ] No data corruption incidents
- [ ] All user flows work correctly

### Performance
- [ ] Query latency <1s (p95)
- [ ] Amplitude API usage within budget
- [ ] Nightly runner completes successfully

### Adoption
- [ ] 10+ graphs using contexts within first month
- [ ] User feedback predominantly positive
- [ ] <1% error rate in aggregation

---

## Risk Mitigation

### Critical Risks

1. **Data Operations Refactoring (Task 2.1, 2.2)**
   - **Risk**: Cross-slice aggregation → data corruption
   - **Mitigation**:
     - Mandatory code review by 2+ senior engineers
     - Comprehensive unit tests before merge
     - Staged rollout with canary graphs
     - Monitor aggregation results closely

2. **Daily Grid Aggregation (Task 2.4)**
   - **Risk**: Complex logic → subtle bugs
   - **Mitigation**:
     - Test all 7 scenarios + 4 otherPolicy variants
     - Write tests before implementation (TDD)
     - Compare results with manual calculations

3. **Amplitude API Integration (Task 4.1)**
   - **Risk**: Incorrect filter syntax → failed queries
   - **Mitigation**:
     - Verify syntax with Amplitude API docs
     - Test with mock API first
     - Integration tests with real API (staging)

### Monitoring

**Metrics to track during rollout**:
- Parse errors in DSL parsing
- Aggregation errors/warnings
- Query latency (p50, p95, p99)
- Amplitude API call volume
- Nightly runner slice counts
- User adoption (graphs with `dataInterestsDSL`)

**Alerts**:
- Aggregation error rate >1%
- Query latency >1s (p95)
- Amplitude API errors >5%
- Nightly runner failures

---

## Dependencies & Prerequisites

### External Dependencies
- Amplitude Dashboard REST API access
- Context registry files in param-registry repo
- Schema update approval

### Internal Dependencies
- Phase 1 must complete before Phase 2
- Phase 2 must complete before Phase 3 (for data binding)
- Phase 4 can run parallel with Phase 3
- Phase 5 requires Phases 1-4 complete

### Resource Requirements
- Core services team (2-3 engineers): Phases 1, 2, 4
- Frontend team (2 engineers): Phase 3
- Backend team (1-2 engineers): Phases 1, 4
- QA team (1 engineer): Phase 5
- Performance team (1 engineer): Phase 5 (Task 5.3)

---

## Estimated Timeline

| Phase | Duration | Dependencies | Risk |
|-------|----------|--------------|------|
| Phase 1: Core Infrastructure | 1-2 weeks | None | Low |
| Phase 2: Data Operations | 2-3 weeks | Phase 1 | ⚠️ HIGH |
| Phase 3: UI Components | 2 weeks | Phase 1, partial Phase 2 | Medium |
| Phase 4: Adapters | 2 weeks (parallel) | Phase 1 | Medium |
| Phase 5: Testing | 2-3 weeks | Phases 1-4 | Low |

**Total Duration**: 8-10 weeks

**Critical Path**: Phase 1 → Phase 2 → Phase 5

---

## Next Steps

1. ✅ Review and approve this implementation plan
2. ⬜ Assign tasks to teams
3. ⬜ Set up project board with tasks
4. ⬜ Schedule kick-off meeting
5. ⬜ Begin Phase 1: Core Infrastructure

---

**For detailed design specifications**, refer to the design documents linked at the top of this plan.

**For questions or clarifications**, consult:
- Architecture questions → [CONTEXTS_ARCHITECTURE.md](./CONTEXTS_ARCHITECTURE.md)
- Registry questions → [CONTEXTS_REGISTRY.md](./CONTEXTS_REGISTRY.md)
- Aggregation questions → [CONTEXTS_AGGREGATION.md](./CONTEXTS_AGGREGATION.md)
- UI questions → [CONTEXTS_UI_DESIGN.md](./CONTEXTS_UI_DESIGN.md)
- Testing questions → [CONTEXTS_TESTING_ROLLOUT.md](./CONTEXTS_TESTING_ROLLOUT.md)

