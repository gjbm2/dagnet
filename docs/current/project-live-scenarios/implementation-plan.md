# Live Scenarios: Implementation Plan

**Status:** Ready for Implementation  
**Created:** 2-Dec-25  
**Design Reference:** `docs/current/project-live-scenarios/design.md`

---

## Overview

This document provides a detailed file-by-file implementation plan for the Live Scenarios feature. Each section references the relevant design sections but contains no design materials.

---

## Phase 1: Core Infrastructure (MVP)

### 1.1 Type Definitions

#### File: `graph-editor/src/types/scenarios.ts`

**Changes:**
- Add `queryDSL?: string` field to `ScenarioMeta` interface
- Add `isLive?: boolean` field to `ScenarioMeta` interface
- Add `lastRegeneratedAt?: string` field to `ScenarioMeta` interface
- Add `lastEffectiveDSL?: string` field to `ScenarioMeta` interface

**Design Reference:** §3.1 Scenario Type Extension

---

#### File: `graph-editor/src/types/index.ts`

**Changes:**
- Add `baseDSL?: string` field to `ConversionGraph` interface

**Design Reference:** §3.2 Base Query Storage

---

### 1.2 Context & State Management

#### File: `graph-editor/src/contexts/ScenariosContext.tsx`

**Changes:**

1. **Add state for baseDSL:**
   - Add `baseDSL: string` state
   - Add `setBaseDSL` setter
   - Load/save baseDSL from graph on file change

2. **Add `createLiveScenario` function:**
   - Accept `queryDSL`, optional `name`, `tabId`
   - Default name to queryDSL string
   - Set `meta.queryDSL`, `meta.isLive = true`
   - Trigger initial regeneration

3. **Add `regenerateScenario` function:**
   - Parse queryDSL with `parseConstraints()`
   - Compute inherited DSL from lower live scenarios
   - Split into fetch parts and what-if parts
   - Build effective fetch DSL using `augmentDSLWithConstraint`
   - Call `dataOperationsService.getFromSourceDirect()`
   - Apply what-if using `computeEffectiveEdgeProbability()`
   - Update scenario.params and `lastRegeneratedAt`

4. **Add `regenerateAllLive` function:**
   - Filter scenarios where `meta.isLive === true`
   - Call `regenerateScenario` for each in parallel
   - Show progress via toast

5. **Add `putToBase` function:**
   - Get current DSL from `graphStore.currentDSL`
   - Update `graph.baseDSL`
   - Call `regenerateAllLive()`

6. **Add DSL inheritance computation:**
   - New helper: `computeInheritedDSL(scenarioId, scenarioOrder)`
   - Traverse scenarios from base up to target
   - Accumulate DSL from live scenarios only (skip static)
   - Use smart merge for each layer

**Design Reference:** §3.3 ScenariosContext Extensions, §3.4 Mixed DSL Storage & Processing, §2.2 Query DSL Composition & Inheritance

---

#### File: `graph-editor/src/contexts/GraphStoreContext.tsx`

**Changes:**
- No changes required — `currentDSL` already exists as authoritative runtime source

**Design Reference:** §3.2 Base Query Storage (note on graphStore.currentDSL)

---

### 1.3 DSL Processing Utilities

#### File: `graph-editor/src/lib/queryDSL.ts`

**Changes:**
- No changes required — `parseConstraints()` already parses all needed element types
- Verify `augmentDSLWithConstraint` handles smart merge correctly

**Design Reference:** §2.2 Query DSL Composition & Inheritance, §2.3 Mixed DSL (parsing strategy)

---

#### File: `graph-editor/src/services/scenarioRegenerationService.ts` (NEW)

**Create new service file with:**

1. **`splitDSLParts(queryDSL: string)`:**
   - Call `parseConstraints(queryDSL)`
   - Return `{ fetchParts, whatIfParts }`
   - fetchParts: window, context, contextAny
   - whatIfParts: cases, visited, visitedAny, exclude

2. **`buildFetchDSL(parts: FetchParts)`:**
   - Reconstruct DSL string from parsed parts
   - Return string like `window(...).context(...)`

3. **`buildWhatIfDSL(parts: WhatIfParts)`:**
   - Reconstruct DSL string from parsed parts
   - Return string like `case(...).visited(...)`

4. **`computeEffectiveParams(graph, whatIfDSL)`:**
   - Reuse logic from `createSnapshot` in ScenariosContext
   - Call `computeEffectiveEdgeProbability()` for each edge
   - Apply case variant weights
   - Return `ScenarioParams`

**Design Reference:** §2.3 Mixed DSL (regeneration flow), §3.4 Mixed DSL Storage & Processing

---

### 1.4 UI: Scenarios Panel Changes

#### File: `graph-editor/src/components/panels/ScenariosPanel.tsx`

**Changes:**

1. **Rename "Original" to "Base":**
   - Find text "Original" in JSX
   - Replace with "Base"
   - Update tooltip text

2. **Add live scenario indicators in scenario row:**
   - Import `Zap` icon from lucide-react
   - Show ⚡ icon after colour swatch if `scenario.meta?.isLive`
   - Show ↻ refresh button if live (onClick → `regenerateScenario`)
   - Show ✎ pencil button if live (onClick → open DSL edit modal)

3. **Update scenario label:**
   - If live and no custom name: display `scenario.meta.queryDSL`
   - Truncate if > 30 chars, full DSL in tooltip

4. **Add "From current query" menu item:**
   - In `showCreateMenu` dropdown
   - Add separator after "Create blank"
   - Add "From current query" option
   - onClick: call `createLiveScenario(graphStore.currentDSL, undefined, tabId)`

5. **Add "Refresh All" header button:**
   - Show only if any `scenario.meta?.isLive`
   - Icon: `RefreshCw` from lucide-react
   - onClick: call `regenerateAllLive()`

6. **Update footer actions:**
   - Rename "Flatten All" to "Flatten"
   - Add "To Base" button with `CalendarArrowDown` icon
   - onClick: call `putToBase()`

7. **Add "Create Snapshot" to context menu:**
   - Show only for live scenarios
   - onClick: create snapshot from scenario.params

**Design Reference:** §4.1.1 through §4.1.7

---

#### File: `graph-editor/src/components/panels/ScenariosPanel.css`

**Changes:**
- Add styles for `.scenario-live-indicator` (zap icon)
- Add styles for `.scenario-refresh-btn`
- Add styles for `.scenario-edit-btn`
- Adjust `.scenario-row` padding to accommodate new icons

**Design Reference:** §4.1.3 Scenario Row for Live Scenarios

---

### 1.5 UI: DSL Edit Modal

#### File: `graph-editor/src/components/modals/ScenarioQueryEditModal.tsx` (NEW)

**Create new modal component:**

1. **Props:**
   - `isOpen: boolean`
   - `scenarioId: string`
   - `onClose: () => void`
   - `onSave: (newDSL: string) => void`

2. **State:**
   - `editingDSL: string` — local edit state
   - `effectiveDSL: string` — computed preview

3. **Render:**
   - Modal header: "Edit Live Scenario Query"
   - `QueryExpressionEditor` component for DSL input
   - Read-only display of effective DSL (merged with base)
   - Cancel button
   - "Save & Refresh" button

4. **On save:**
   - Call `onSave(editingDSL)`
   - Parent calls `regenerateScenario(scenarioId)`

**Design Reference:** §4.1.4 DSL Edit Modal

---

#### File: `graph-editor/src/components/modals/index.ts`

**Changes:**
- Export `ScenarioQueryEditModal`

---

### 1.6 Service Integration

#### File: `graph-editor/src/services/dataOperationsService.ts`

**Changes:**
- No changes required — `getFromSourceDirect` already accepts `currentDSL` parameter
- Verify it handles the DSL correctly for regeneration use case

**Design Reference:** §2.3 Mixed DSL (Step 3: Fetch data from source)

---

#### File: `graph-editor/src/services/CompositionService.ts`

**Changes:**
- No changes required — compositing works on `params`, not DSL
- Verify `composeParams` handles sparse overlays correctly

**Design Reference:** §2.4 Live Scenarios in Compositing

---

---

## Phase 2: Bulk Creation

### 2.1 Cache Checking Service

#### File: `graph-editor/src/services/cacheCheckService.ts` (NEW)

**Create new service with:**

1. **`checkDSLNeedsFetch(dsl: string, graph: Graph)`:**
   - Extract from existing `useFetchData.itemNeedsFetch` logic
   - Return `{ needsFetch: boolean, items: FetchItem[] }`

2. **`checkMultipleDSLsNeedFetch(dsls: string[], graph: Graph)`:**
   - Call `checkDSLNeedsFetch` for each
   - Return `Array<{ dsl: string, needsFetch: boolean }>`

3. **`getItemsNeedingFetchForDSL(dsl: string, graph: Graph, window: DateRange)`:**
   - Reuse `calculateIncrementalFetch` from windowAggregationService
   - Return items needing fetch

**Design Reference:** §4.2.1 Context Chips (behaviour: if ALL in cache...)

---

#### File: `graph-editor/src/hooks/useFetchData.ts`

**Changes:**
- Extract `itemNeedsFetch` logic to `cacheCheckService`
- Keep hook as thin wrapper calling service
- Ensure backward compatibility

**Design Reference:** §4.2.1 (cache checking for bulk creation)

---

### 2.2 Bulk Creation Modal

#### File: `graph-editor/src/components/modals/BulkScenarioCreationModal.tsx` (NEW)

**Create new modal component:**

1. **Props:**
   - `isOpen: boolean`
   - `contextKey: string`
   - `values: Array<{ id: string, label: string }>`
   - `onClose: () => void`
   - `onCreate: (selectedValues: string[]) => void`

2. **State:**
   - `selectedValues: Set<string>`
   - `fetchStatus: Record<string, boolean>` — whether each needs fetch

3. **On mount:**
   - Call `checkMultipleDSLsNeedFetch` for all values
   - Populate `fetchStatus`

4. **Render:**
   - Header: "Create Scenarios for '{contextKey}'"
   - Checkbox list of values
   - Show `[fetch]` indicator next to items needing fetch
   - Select All / Select None buttons
   - Cancel and "Create N" buttons

5. **On create:**
   - Call `onCreate` with selected values
   - Parent creates live scenarios for each

**Design Reference:** §4.2.1 Context Chips (modal when fetch required)

---

### 2.3 Context Chip Context Menu

#### File: `graph-editor/src/components/QueryExpressionEditor.tsx`

**Changes:**

1. **Add context menu to context chips:**
   - onContextMenu handler on chip elements
   - Show menu with:
     - "Remove"
     - separator
     - "Create [N] scenarios..."

2. **"Create [N] scenarios..." handler:**
   - Get context key from chip
   - Get all values from `contextRegistry.getValuesForContext(key)`
   - Check cache status via `checkMultipleDSLsNeedFetch`
   - If all cached: create scenarios immediately
   - If any need fetch: open `BulkScenarioCreationModal`

**Design Reference:** §4.2.1 Context Chips in WindowSelector

---

### 2.4 Window Preset Context Menu

#### File: `graph-editor/src/components/WindowSelector.tsx`

**Changes:**

1. **Add context menu to preset buttons (7d, 30d, 90d):**
   - Wrap preset buttons in context menu trigger
   - Generate menu items dynamically based on preset

2. **For 7d preset, generate:**
   - "Create scenario (-7d:-1d)"
   - "Create scenario (-14d:-7d)"
   - "Create scenario (-21d:-14d)" + fetch indicator
   - "Create scenario (-28d:-21d)" + fetch indicator
   - separator
   - "Create 4 scenarios (weekly)" + fetch indicator

3. **Similar patterns for 30d (monthly) and 90d (quarterly)**

4. **Menu item onClick:**
   - Check cache via `checkDSLNeedsFetch`
   - If cached: create live scenario immediately
   - If fetch needed: show confirmation toast, then create

**Design Reference:** §4.3.1 Quick Date Preset Context Menu

---

### 2.5 Context Sidebar Affordance

#### File: `graph-editor/src/components/Navigator/NavigatorItemContextMenu.tsx`

**Changes:**

1. **For context files (type === 'context'):**
   - Add "Create [N] scenarios..." menu item
   - Get all values from context file
   - Same logic as context chip: check cache, show modal if needed

**Design Reference:** §4.2.2 Context Sidebar Navigation

---

---

## Phase 3: Base Propagation

### 3.1 To Base Action

#### File: `graph-editor/src/components/panels/ScenariosPanel.tsx`

**Changes (additional to Phase 1):**

1. **"To Base" button logic:**
   - Get live scenarios: `scenarios.filter(s => s.meta?.isLive)`
   - Call `checkMultipleDSLsNeedFetch` for each
   - If any need fetch: show confirmation modal with count
   - If all cached: proceed immediately
   - Call `putToBase()` from ScenariosContext

**Design Reference:** §4.4 "To Base" Action

---

#### File: `graph-editor/src/components/modals/ToBaseConfirmModal.tsx` (NEW)

**Create confirmation modal:**

1. **Props:**
   - `isOpen: boolean`
   - `scenariosNeedingFetch: number`
   - `totalLiveScenarios: number`
   - `onConfirm: () => void`
   - `onCancel: () => void`

2. **Render:**
   - "This will update the base DSL and regenerate N live scenarios."
   - "M of N scenarios require data fetch."
   - Confirm / Cancel buttons

**Design Reference:** §4.4 (shows confirmation with count)

---

### 3.2 Regenerate All Live

#### File: `graph-editor/src/contexts/ScenariosContext.tsx`

**Changes (additional to Phase 1):**

1. **`regenerateAllLive` implementation:**
   - Use `Promise.all` for parallel regeneration
   - Track progress: completed / total
   - Show progress toast
   - Handle errors per-scenario (don't fail all if one fails)

**Design Reference:** §6.3 Phase 3 (Regenerate all live — Parallel fetch with progress)

---

### 3.3 Refresh All Header Button

#### File: `graph-editor/src/components/panels/ScenariosPanel.tsx`

**Changes (additional to Phase 1):**

1. **"Refresh All" button:**
   - Visible only if `scenarios.some(s => s.meta?.isLive)`
   - Check cache status before refresh
   - If any need fetch: show confirmation
   - Call `regenerateAllLive()`

**Design Reference:** §4.1.2 Header Actions

---

---

## Phase 4: URL Parameters

### 4.1 URL Parsing

#### File: `graph-editor/src/App.tsx` (or appropriate entry point)

**Changes:**

1. **Add URL parameter parsing on app load:**
   - Extract `scenarios` param from URL
   - Extract `hidecurrent` param from URL
   - Store in app state for processing after graph loads

**Design Reference:** §5.2 URL Format

---

#### File: `graph-editor/src/hooks/useURLScenarios.ts` (NEW)

**Create new hook:**

1. **`useURLScenarios()`:**
   - Parse URL on mount
   - Return `{ scenariosParam: string | null, hideCurrent: boolean }`

2. **Effect after graph loads:**
   - If `scenariosParam` is set:
     - URL-decode the param
     - Call `explodeDSL(scenariosParam)` 
     - Create live scenario for each returned slice
   - If `hideCurrent`:
     - Update `visibleScenarioIds` to exclude 'current'

**Design Reference:** §5.4 Implementation

---

#### File: `graph-editor/src/lib/dslExplosion.ts`

**Changes:**
- No changes required — `explodeDSL` already handles semicolons and bare key expansion
- Verify it handles URL-decoded input correctly

**Design Reference:** §5.4 Implementation (USE EXISTING explodeDSL)

---

### 4.2 Scenario Creation on Load

#### File: `graph-editor/src/contexts/ScenariosContext.tsx`

**Changes (additional):**

1. **Add `createScenariosFromURL` function:**
   - Accept array of DSL strings
   - Create live scenario for each
   - Handle errors gracefully (toast + skip)

**Design Reference:** §5.4 Implementation (step 3: Create one live scenario per returned slice)

---

#### File: `graph-editor/src/components/GraphEditor.tsx` (or tab loading logic)

**Changes:**

1. **After graph load completes:**
   - Check for pending URL scenarios
   - Call `createScenariosFromURL` if present
   - Apply `hidecurrent` visibility setting

**Design Reference:** §5.4 Implementation (step 1: After graph load)

---

---

## Testing Requirements

### Overview

Testing is critical for this feature due to:
1. **Complex DSL inheritance logic** — scenarios build on each other's DSL
2. **Cache checking generalisation** — new reusable logic with many edge cases
3. **Mixed DSL parsing** — fetch vs what-if element separation
4. **Compositing correctness** — params must compose correctly across live/static

Ref: Design §5.8 (DSL Inheritance Chain), §3 (Data Model)

---

### Unit Tests

#### File: `graph-editor/src/services/__tests__/scenarioRegenerationService.test.ts` (NEW)

**`splitDSLParts` function tests:**

- Verify fetch-only DSL returns only window and context in fetchParts, empty whatIfParts
- Verify what-if-only DSL returns only cases/visited in whatIfParts, empty fetchParts
- Verify mixed DSL correctly separates fetch elements (window, context) from what-if elements (case, visited, exclude)
- Verify empty DSL returns empty structures for both parts
- Verify contextAny is categorised as fetch element
- Verify visitedAny is categorised as what-if element
- Verify exclude is categorised as what-if element

**`buildFetchDSL` function tests:**

- Verify window-only input produces correct window DSL string
- Verify context-only input produces correct context DSL string
- Verify window + context produces combined DSL string
- Verify multiple contexts are all included in output
- Verify empty input produces empty string

**`buildWhatIfDSL` function tests:**

- Verify case-only input produces correct case DSL string
- Verify visited-only input produces correct visited DSL string
- Verify multiple what-if elements (case + visited + exclude) all included
- Verify empty input produces empty string

**`computeEffectiveParams` function tests:**

- Verify empty what-if DSL returns unchanged params from base graph
- Verify case override sets variant weights to 100%/0% for specified variant
- Verify visited conditional applies the conditional_p probability instead of base
- Verify multiple what-if overrides are all applied to final params

Ref: Design §5.7 (What-If Baking)

---

#### File: `graph-editor/src/services/__tests__/cacheCheckService.test.ts` (NEW) — **CRITICAL**

This is the most important test file as it validates the generalised cache checking logic.

Ref: Design §5.4 (Bulk Scenario Creation Modal), existing `useFetchData` cache logic

**`checkDSLNeedsFetch` — window coverage tests:**

- Verify returns needsFetch=false when param file contains all requested dates
- Verify returns needsFetch=true when requested dates are outside param file range
- Verify returns needsFetch=true when only partial date coverage exists
- Verify relative window syntax (e.g. -30d:-1d) is correctly resolved before checking

**`checkDSLNeedsFetch` — context/slice coverage tests:**

- Verify returns needsFetch=false when sliceDSL matches requested context exactly
- Verify returns needsFetch=true when sliceDSL does not match requested context
- Verify uncontexted query against contexted cache returns needsFetch=true (different data slices)
- Verify contexted query against uncontexted cache returns needsFetch=true

**`checkDSLNeedsFetch` — edge cases:**

- Verify returns needsFetch=false for graph with no connections (nothing to fetch)
- Verify returns needsFetch=true when param file does not exist in registry
- Verify case nodes with connections are checked for coverage
- Verify empty graph returns needsFetch=false with empty items list
- Verify malformed DSL does not throw, returns graceful result

**`checkDSLNeedsFetch` — conditional parameters:**

- Verify conditional_p entries are also checked for cache coverage
- Verify both base param and conditional param must be cached for needsFetch=false

**`checkMultipleDSLsNeedFetch` — batch checking tests:**

- Verify multiple DSLs are checked and results returned in same order
- Verify mix of cached/uncached DSLs returns correct needsFetch per DSL
- Verify each result contains the original DSL string for identification
- Verify empty input array returns empty results array
- Verify all-cached scenario returns all needsFetch=false
- Verify all-uncached scenario returns all needsFetch=true
- Verify same context with different windows correctly differentiates cache hits/misses

**`getItemsNeedingFetchForDSL` tests:**

- Verify returns list of items when fetch needed, with correct structure (id, type, name, objectId, targetId)
- Verify parameter items include paramSlot field
- Verify returns empty array when all items are cached

---

#### File: `graph-editor/src/contexts/__tests__/ScenariosContext.liveScenarios.test.ts` (NEW)

**`createLiveScenario` tests:**

- Verify scenario created with isLive=true in meta
- Verify scenario.meta.queryDSL equals the DSL passed in
- Verify scenario name defaults to the queryDSL when no name provided
- Verify scenario name uses provided name when given
- Verify initial regeneration is triggered on creation

Ref: Design §3.1 (ScenarioMeta changes)

**`regenerateScenario` — DSL inheritance tests:**

- Verify live scenario inherits DSL from lower live scenarios in stack
- Verify static scenarios are skipped during DSL inheritance (only live scenarios contribute)
- Verify baseDSL is used as foundation when no lower live scenarios exist
- Verify smart merge: same-type constraints replace, different-type constraints combine
- Verify lastEffectiveDSL is recorded after regeneration

Ref: Design §5.8 (DSL Inheritance Chain)

**`regenerateScenario` — what-if application tests:**

- Verify what-if elements are baked into params (case variants set to 100%/0%)
- Verify visited conditionals are applied to edge probabilities

Ref: Design §5.7 (What-If Baking)

**`regenerateScenario` — timestamp tests:**

- Verify lastRegeneratedAt is updated after each regeneration

**`putToBase` tests:**

- Verify baseDSL is set from current graph DSL
- Verify all live scenarios are regenerated (called for each)
- Verify static scenarios are NOT regenerated
- Verify regeneration uses the new baseDSL

Ref: Design §5.5 (To Base Action)

---

### Integration Tests

#### File: `graph-editor/src/services/__tests__/liveScenarios.integration.test.ts` (NEW)

**Full regeneration flow:**

- Verify create → regenerate → params match fetched data (e.g. edge probability = k/n from API)

**DSL inheritance across stack:**

- Test scenario: A(live: context), B(static), C(live: window)
- Verify C's effective DSL combines A's context with C's window
- Verify B is skipped in inheritance chain
- Verify correct API call is made with effective DSL

Ref: Design §5.8 (DSL Inheritance Chain), worked example in §5.8.2

**What-if baking:**

- Test scenario with case node and case override DSL
- Verify case variant weights are baked into scenario.params
- Verify baked params are used by compositing (not re-evaluated at render)

Ref: Design §5.7 (What-If Baking)

**Compositing with mixed live/static:**

- Test stack: Base → Live(A) → Static(B) → Live(C) → Static(D)
- Verify compositing applies in order: base + A + B + C + D
- Verify top-of-stack param overrides take precedence
- Verify live scenarios contribute via their params (not queryDSL at render time)

Ref: Design §5.8.4 (Example)

---

#### File: `graph-editor/tests/urlScenarios.e2e.test.ts` (NEW)

**URL parameter parsing:**

- Verify semicolon-separated DSLs create multiple scenarios
- Verify bare key (e.g. context(channel)) is exploded to one scenario per value
- Verify window DSL creates scenario with that window

Ref: Design §5.6 (URL Parameters)

**hidecurrent parameter:**

- Verify hidecurrent param hides the Current layer in scenarios panel

**Error handling:**

- Verify invalid DSL in URL shows error toast but does not crash
- Verify graph remains usable after URL parse error

---

### Test Coverage Summary

| Service/Component | Test Count | Priority |
|-------------------|------------|----------|
| `cacheCheckService` | 25+ scenarios | **CRITICAL** — new generalised logic |
| `scenarioRegenerationService` | 15+ scenarios | High |
| `ScenariosContext` (live scenario methods) | 20+ scenarios | High |
| Integration (full flow) | 10+ scenarios | High |
| URL parameters (E2E) | 5+ scenarios | Medium |
| UI components | 10+ scenarios | Medium |

### Test Execution Order

1. **Phase 1:** `cacheCheckService.test.ts` — foundational, must pass first
2. **Phase 1:** `scenarioRegenerationService.test.ts`
3. **Phase 1:** `ScenariosContext.liveScenarios.test.ts`
4. **Phase 2-3:** `liveScenarios.integration.test.ts`
5. **Phase 4:** `urlScenarios.e2e.test.ts`

---

## File Summary

### New Files (12)

| File | Phase | Purpose |
|------|-------|---------|
| `services/scenarioRegenerationService.ts` | 1 | DSL splitting, effective params computation |
| `services/cacheCheckService.ts` | 2 | Multi-DSL cache checking |
| `components/modals/ScenarioQueryEditModal.tsx` | 1 | DSL editing modal |
| `components/modals/BulkScenarioCreationModal.tsx` | 2 | Bulk creation with fetch indicators |
| `components/modals/ToBaseConfirmModal.tsx` | 3 | Confirmation for To Base |
| `hooks/useURLScenarios.ts` | 4 | URL parameter parsing |
| `services/__tests__/scenarioRegenerationService.test.ts` | 1 | Unit tests |
| `services/__tests__/cacheCheckService.test.ts` | 2 | Unit tests |
| `contexts/__tests__/ScenariosContext.liveScenarios.test.ts` | 1 | Context tests |
| `services/__tests__/liveScenarios.integration.test.ts` | 1-3 | Integration tests |
| `tests/urlScenarios.e2e.test.ts` | 4 | E2E tests |

### Modified Files (14)

| File | Phase | Changes |
|------|-------|---------|
| `types/scenarios.ts` | 1 | Add queryDSL, isLive, lastRegeneratedAt fields |
| `types/index.ts` | 1 | Add baseDSL to ConversionGraph |
| `contexts/ScenariosContext.tsx` | 1,3 | Add live scenario operations, baseDSL state |
| `components/panels/ScenariosPanel.tsx` | 1,3 | UI for live scenarios, To Base, Refresh All |
| `components/panels/ScenariosPanel.css` | 1 | Styles for live scenario indicators |
| `components/modals/index.ts` | 1,2,3 | Export new modals |
| `hooks/useFetchData.ts` | 2 | Extract cache checking to service |
| `components/QueryExpressionEditor.tsx` | 2 | Context chip context menu |
| `components/WindowSelector.tsx` | 2 | Preset button context menus |
| `components/Navigator/NavigatorItemContextMenu.tsx` | 2 | Context file "Create scenarios" |
| `App.tsx` | 4 | URL parameter extraction |
| `components/GraphEditor.tsx` | 4 | Scenario creation on graph load |

### Unchanged Files (verified)

| File | Reason |
|------|--------|
| `lib/queryDSL.ts` | Already has `parseConstraints` with all element types |
| `lib/dslExplosion.ts` | Already has `explodeDSL` for URL parsing |
| `services/CompositionService.ts` | Compositing uses params, no DSL changes |
| `services/dataOperationsService.ts` | Already accepts currentDSL parameter |
| `contexts/GraphStoreContext.tsx` | currentDSL already exists |

---

## Implementation Order

### Phase 1: Core Infrastructure

1. `types/scenarios.ts` — Add ScenarioMeta fields
2. `types/index.ts` — Add baseDSL to ConversionGraph
3. `services/scenarioRegenerationService.ts` (NEW) — DSL splitting and what-if computation
4. `contexts/ScenariosContext.tsx` — Core live scenario functions
5. `components/modals/ScenarioQueryEditModal.tsx` (NEW) — DSL editing modal
6. `components/panels/ScenariosPanel.tsx` — UI changes for live scenarios
7. Unit tests for Phase 1

### Phase 2: Bulk Creation

8. `services/cacheCheckService.ts` (NEW) — Multi-DSL cache checking
9. `hooks/useFetchData.ts` — Refactor to use cache check service
10. `components/modals/BulkScenarioCreationModal.tsx` (NEW) — Bulk creation with fetch indicators
11. `components/QueryExpressionEditor.tsx` — Context chip context menu
12. `components/WindowSelector.tsx` — Preset button context menus
13. Navigator context menu — "Create scenarios..." option
14. Unit tests for Phase 2

### Phase 3: Base Propagation

15. `components/modals/ToBaseConfirmModal.tsx` (NEW) — Confirmation modal
16. `ScenariosPanel.tsx` — To Base and Refresh All completion
17. `ScenariosContext.tsx` — regenerateAllLive completion
18. Integration tests

### Phase 4: URL Parameters

19. `hooks/useURLScenarios.ts` (NEW) — URL parameter parsing
20. `App.tsx` — URL extraction on load
21. `GraphEditor.tsx` — Scenario creation on graph load
22. E2E tests

---

## Estimated Effort

| Phase | Files | Effort |
|-------|-------|--------|
| Phase 1: Core Infrastructure | 7 + tests | 2-3 days |
| Phase 2: Bulk Creation | 6 + tests | 2 days |
| Phase 3: Base Propagation | 3 + tests | 1 day |
| Phase 4: URL Parameters | 3 + tests | 1 day |
| **Total** | **19 files** | **6-7 days** |

