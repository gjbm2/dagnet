# Phase 1B Partial: DataOperationsService Core Wiring & Critical Bug Fixes

**Date:** 2025-11-07  
**Status:** 🟡 Partially Complete (Core operations working, conditional p/events pending)  
**Duration:** ~8 hours (debugging-heavy session)

---

## What Was Accomplished

**⚠️ NOTE:** Core parameter/case/node operations are working, but **NOT yet tested with:**
- Conditional probabilities (Properties Panel UI not updated yet)
- Event connections (event_id selector not in Properties Panel yet)
- Full end-to-end workflows

**Phase 1C (Properties Panel updates) required before this phase can be fully validated.**

---

### 1. DataOperationsService Core Operations ✅

**Files Modified:**
- `graph-editor/src/services/dataOperationsService.ts` (661 lines)
- `graph-editor/src/services/UpdateManager.ts` (1330+ lines)

**Operations Implemented:**
- `getParameterFromFile()` - Pull parameter data from file → graph edge
- `putParameterToFile()` - Push edge data → parameter file (with provenance)
- `getNodeFromFile()` - Pull node data from file → graph node
- `getCaseFromFile()` - Pull case data from file → graph case node
- `putCaseToFile()` - Push case variants → case file (with provenance)

**Key Features:**
- Filtered edge data to prevent writing all parameters at once
- Added `validateOnly: true` flag to prevent double-appending
- Connection ID preservation after file updates
- Proper slot detection (p, cost_gbp, cost_time)

---

## 2. Critical Bug Fixes ✅

### Bug #1: Selector "Bouncing" (Value Doesn't Stick)
**Symptom:** When connecting a parameter, the selector ID would appear briefly then disappear

**Root Causes:**
1. `transform.ts:fromFlow()` was rebuilding `p` object without spreading existing `p.id`
2. `PropertiesPanel` wasn't refreshing `localEdgeData` after UpdateManager loaded file data
3. Cost parameter data was displaying but `localEdgeData` wasn't updated

**Fixes:**
- Modified `fromFlow()` to spread `...originalEdge?.p` to preserve `p.id` (and all other fields)
- Modified `toFlow()` to correctly map nested `p.id` → flat `parameter_id` with fallback
- Added `useEffect` in PropertiesPanel (lines 270-296) to refresh display when graph changes
- Added selective refresh: only updates cost params and probability IF `p.id` exists

**Files:**
- `graph-editor/src/lib/transform.ts`
- `graph-editor/src/components/PropertiesPanel.tsx`

---

### Bug #2: Wrong Values Loaded ("values[latest]" Not Working)
**Symptom:** When connecting to a parameter, old/wrong values were loaded instead of latest

**Root Causes:**
1. `values[latest]` was using array index (`array.length - 1`) instead of timestamp sorting
2. Manual "Put to File" entries had NO timestamp, so they sorted as oldest (timestamp = 0)

**Fixes:**
- Modified `UpdateManager.getNestedValue()` to sort by `window_from` timestamp (lines 1208-1216)
- Modified APPEND transforms to add `window_from: new Date().toISOString()` for all manual edits
- Most recent entry now correctly identified by timestamp, not array order

**Files:**
- `graph-editor/src/services/UpdateManager.ts`

---

### Bug #3: Duplicate Entries on "Put to File"
**Symptom:** Every "Put to File" operation wrote TWO identical entries with same timestamp

**Root Cause:**
- UpdateManager's `appendToFileHistory()` called `setNestedValue()` which appended to array
- Then `dataOperationsService` called `applyChanges()` which appended AGAIN
- Result: same data written twice

**Fix:**
- Pass `validateOnly: true` to UpdateManager so it ONLY returns changes, doesn't apply them
- Let `applyChanges()` be the single point of array modification

**Files:**
- `graph-editor/src/services/dataOperationsService.ts` (line 296)

---

### Bug #4: Multiple Parameters Written to Wrong Files
**Symptom:** Probability parameter file had `mean: 310` (time cost data) and beta distribution mixed with lognormal

**Root Cause:**
- When calling `putParameterToFile()`, entire edge was passed to UpdateManager
- Edge had `p`, `cost_gbp`, AND `cost_time` data
- All three APPEND mappings tried to write to the same file

**Fix:**
- Filter edge data before passing to UpdateManager (lines 267-282)
- Only include the parameter slot that matches `paramId`:
  - If `edge.p.id === paramId` → pass `{ p: edge.p }`
  - If `edge.cost_gbp.id === paramId` → pass `{ cost_gbp: edge.cost_gbp }`
  - If `edge.cost_time.id === paramId` → pass `{ cost_time: edge.cost_time }`

**Files:**
- `graph-editor/src/services/dataOperationsService.ts`

---

### Bug #5: Data Loss in `applyChanges()`
**Symptom:** `values[]` field created instead of appending to array

**Root Cause:**
- `applyChanges()` in dataOperationsService didn't handle `[]` array syntax
- Created literal `values[]` key instead of pushing to array

**Fix:**
- Added array append handling in `applyChanges()` (lines 77-90)
- Detects `field.endsWith('[]')`, extracts array name, calls `.push()`

**Files:**
- `graph-editor/src/services/dataOperationsService.ts`

---

## 3. Provenance Tracking ✅

### Added to APPEND Operations:
**Parameters** (`values[]` entries):
```javascript
{
  mean: value,
  stdev: source.p.stdev,
  distribution: source.p.distribution,
  window_from: new Date().toISOString(),  // ← Timestamp for sorting
  data_source: {
    type: 'manual',                        // ← Source type
    edited_at: new Date().toISOString()    // ← Edit timestamp
    // TODO: author from credentials
  }
}
```

**Cases** (`schedules[]` entries):
```javascript
{
  variants: [...],
  window_from: new Date().toISOString(),   // ← Timestamp
  source: 'manual',                        // ← Source type
  edited_at: new Date().toISOString()      // ← Edit timestamp
  // TODO: author from credentials
}
```

### Schema Updates:
**`parameter-schema.yaml`** (`values[].data_source`):
- Added `edited_at: string (date-time)` - when manually edited
- Added `author: string` - who made the edit
- Clarified `retrieved_at` is for external sources only

**`case-parameter-schema.yaml`** (`schedules[]`):
- Added `edited_at: string (date-time)` - when schedule manually changed
- Added `author: string` - who made the change
- `source` enum already included `'manual'`

**Files:**
- `graph-editor/public/param-schemas/parameter-schema.yaml`
- `graph-editor/public/param-schemas/case-parameter-schema.yaml`

---

## 4. Connection ID Preservation ✅

**Problem:** After "Get from File", connection IDs (`p.id`, `cost_gbp.id`, `cost_time.id`, `node.id`, `node.case.id`) were getting lost

**Solution:** 
- After `applyChanges()`, explicitly check and restore connection IDs
- For parameters: Check which slot was updated, restore matching ID (lines 168-184)
- For nodes: Restore `node.id` (lines 388-394)
- For cases: Restore `node.case.id` (lines 396-406)

**Files:**
- `graph-editor/src/services/dataOperationsService.ts`

---

## 5. Enhanced Logging for Debugging 🔍

Added comprehensive logging throughout the data flow:

**UpdateManager:**
- APPEND mapping checks (which mappings run, conditions passed/failed)
- Transform results

**DataOperationsService:**
- Function entry points with timestamps
- Before/after `applyChanges()`
- Connection ID preservation

**PropertiesPanel:**
- onChange handlers with edge lookup results
- useEffect triggers for data refresh

**These logs were critical for debugging and can be removed later if desired.**

---

## Technical Debt & Future Work

### 1. State Management Cache Issue 🔴
**Problem:** FileRegistry caches files in memory. If you manually edit YAML in Monaco, then create a new edge and connect to that parameter, it loads stale data from cache instead of your cleaned YAML.

**Current Workaround:** F5 (refresh browser) to clear cache

**Proper Fix:** FileRegistry should detect when data changes and invalidate cache, OR provide a way to force refresh from "disk" (IndexedDB)

**Location:** `graph-editor/src/contexts/TabContext.tsx` (FileRegistry class)

---

### 2. Credentials Integration Pending 🟡
**Missing:** `author` field in provenance tracking

**TODO:** When credentials system is available:
1. Import credentials manager in UpdateManager
2. Get current user from credentials
3. Add to `data_source.author` and `author` fields

**Files to update:**
- `graph-editor/src/services/UpdateManager.ts` (lines 782, 802, 822, 876)

---

### 3. Properties Panel Refresh Logic 🟡
**Current Approach:** 
- useEffect refreshes `localEdgeData` when graph changes
- Only updates if connection ID exists (`edge.p.id`) to avoid overwriting user edits

**Limitation:** If user types a value but doesn't blur (commit), then connects a cost param, the uncommitted value is lost

**Potential Improvement:** Track "dirty" state for individual fields, only refresh non-dirty fields

---

### 4. Array Append in Two Places ⚠️
**Current State:**
- `UpdateManager.setNestedValue()` has array append logic
- `dataOperationsService.applyChanges()` has array append logic

**Issue:** Two implementations of same feature (DRY violation)

**TODO:** Consolidate into single implementation, or clearly document when each is used

---

## What's Next (Phase 1C)

### Immediate Next Steps:
1. **Properties Panel Updates** (~4-6 hrs)
   - Add evidence display (n, k, window_from, window_to)
   - Add override indicators (show when field is overridden)
   - Add event_id selector for nodes
   - Polish connection settings display

2. **Query String Builder** (~6-8 hrs)
   - Implement MSMDC algorithm for auto-generating queries
   - `from(node-a).to(node-b).exclude(node-c).visited(node-d)`
   - Handle case variants: `.case(case-id:variant-name)`
   - Update on graph topology changes
   - Respect `query_overridden` flag

3. **Top Menu Bar "Data" Section** (~2-3 hrs)
   - Batch "Get All from Files"
   - Batch "Push All to Files"  
   - "Refresh All Connections"
   - Progress indicators

### Then Phase 2: External Connectors (~20-30 hrs)
- Amplitude connector
- Google Sheets connector
- Generic API connector
- Connection settings UI
- Credential management integration

---

## Files Changed

### Services:
- `graph-editor/src/services/dataOperationsService.ts` ✏️ Created/Modified
- `graph-editor/src/services/UpdateManager.ts` ✏️ Modified

### Components:
- `graph-editor/src/components/PropertiesPanel.tsx` ✏️ Modified
- `graph-editor/src/lib/transform.ts` ✏️ Modified

### Schemas:
- `graph-editor/public/param-schemas/parameter-schema.yaml` ✏️ Modified
- `graph-editor/public/param-schemas/case-parameter-schema.yaml` ✏️ Modified

---

## Lessons Learned

1. **State synchronization is hard** - Multiple sources of truth (FileRegistry, GraphStore, ReactFlow, localEdgeData) require careful coordination

2. **Logging is essential** - The comprehensive logging added during debugging was critical for finding the root causes

3. **Array semantics matter** - `values[latest]` using index vs timestamp was a subtle but critical difference

4. **Transform boundaries must be clean** - Data loss in `fromFlow()` cascaded through the entire system

5. **Validation modes are useful** - `validateOnly: true` flag prevented double-application of changes

---

## Acceptance Criteria

### Completed ✅
- [x] Can connect parameter to edge, auto-gets data from file
- [x] Can edit parameter value in graph, put to file with provenance
- [x] Can connect node to registry, auto-gets data
- [x] Can connect case to registry, auto-gets variants
- [x] Can put case variants to file with provenance
- [x] `values[latest]` correctly finds most recent entry by timestamp
- [x] No duplicate entries on "Put to File"
- [x] Connection IDs preserved after file operations
- [x] Only relevant parameter slot written (not all three at once)
- [x] Schemas updated to support provenance fields
- [x] 0 linter errors

### Pending (Blocked by Phase 1C) ⏳
- [ ] Conditional probabilities connection/operations (UI not ready)
- [ ] Event connections for nodes (selector not in Properties Panel)
- [ ] Full end-to-end validation across all entity types
- [ ] Evidence display in Properties Panel (n, k, window_from, etc.)
- [ ] Override indicators in UI

---

**Phase 1B Status:** 🟡 **PARTIAL** (Core working, needs Phase 1C to complete)

**Next Phase:** 1C - Properties Panel Updates (conditional p, events, evidence, overrides)

