# Scenarios Manager - Fixes Applied

## Critical Fixes Completed

### ✅ 1. Source Filtering (Item 92)
**Issue**: createSnapshot with source='visible' was composing ALL scenarios, not just visible ones.

**Fix**: Now filters to only visible scenarios for the tab.
```typescript
const visibleScenarios = visibleScenarioIds
  ? scenarios.filter(s => visibleScenarioIds.includes(s.id))
  : scenarios;
```

**Files**: `ScenariosContext.tsx`, `ScenariosPanel.tsx`

---

### ✅ 2. Validation Don't Block (Item 88)
**Issue**: Validation was throwing errors and blocking Apply.

**Fix**: Validation still runs but warnings shown, Apply proceeds anyway.
```typescript
// Log validation results but don't throw
if (!validation.valid || validation.warnings.length > 0) {
  console.warn('Scenario validation issues:', validation);
}
```

**Files**: `ScenariosContext.tsx`

---

### ✅ 3. Metadata Tooltip (Items 10, 97-101)
**Issue**: Tooltip only showed note, not full metadata.

**Fix**: Added `getScenarioTooltip()` function that shows:
- Window dates
- What-If summary/DSL
- Context values
- Source type and detail
- Created timestamp
- Note

**Files**: `ScenariosPanel.tsx`

---

### ✅ 4. Monaco Modal Size (Item 25)
**Issue**: Modal too small at 900px width, 400px editor height.

**Fix**: Increased to 1200px width, 500px editor height.

**Files**: `ScenarioEditorModal.css`, `ScenarioEditorModal.tsx`

---

### ✅ 5. Base/Current Modal Handling (Items 30-32)
**Issue**: Opening Base or Current didn't handle them specially.

**Fix**:
- Base: Apply edits mutates `baseParams` directly
- Current: Shows error message (create new scenario not yet fully implemented)
- Both load their respective params into editor

**Files**: `ScenarioEditorModal.tsx`

---

### ✅ 6. Rendering Implementation
**Issue**: Scenario overlays not rendering at all.

**Fix**: 
- GraphCanvas creates overlay edges for each visible scenario
- Adds `scenarioOverlay`, `scenarioColor`, `scenarioParams` to edge data
- ConversionEdge renders overlay edges with scenario color, multiply blend, 0.3 opacity

**Files**: `GraphCanvas.tsx` (lines 1855-1917), `ConversionEdge.tsx` (lines 102-106, 1588-1604)

---

## Remaining RED Items

### ❌ 1. Auto-unhide Current (Items 36, 37, 106-108, 113, 114, 125)
**Status**: Not yet implemented

**Need**: 
- Listen for graph mutations (param edits)
- Listen for What-If changes
- Auto-show Current if hidden
- Toast: "Current shown to reflect your change"

---

### ❌ 2. Validation Visual Feedback (Item 16)
**Status**: Validation messages show below editor, but could be more prominent

**Need**: Better visual indicators for validation state

---

### ❌ 3. Create New from Current Edits (Item 30, 186-192)
**Status**: Shows error message, not implemented

**Need**: When editing Current and clicking Apply, create new scenario with edited params

---

### ❌ 4. "Save as Snapshot" Button for Base (Item 31-32)
**Status**: Missing button in modal

**Need**: When editing Base, show "Save as Snapshot" button to create overlay instead of mutating Base

---

## Summary

**Completed**:
- ✅ Source filtering to visible only
- ✅ Validation warns but doesn't block
- ✅ Full metadata tooltip
- ✅ Larger Monaco modal
- ✅ Base editing mutates Base
- ✅ Scenario overlay edges created
- ✅ ConversionEdge renders overlays

**Remaining**:
- ❌ Auto-unhide Current on edit/What-If
- ❌ Create new scenario from Current edits
- ❌ "Save as Snapshot" button for Base
- ⚠️ Better validation feedback

**Status**: Most critical functionality fixed. Main missing piece is auto-unhide Current, which requires hooking into graph mutation events.


