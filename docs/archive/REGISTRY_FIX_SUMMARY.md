# Registry Integration Fixes - Completed

## Summary

Fixed 4 critical issues where files were created without updating the registry index, causing orphaned files that don't appear in the Navigator or registry listings.

---

## ✅ Issue 1: Event-specific fields not extracted to index
**File:** `fileOperationsService.ts:653-660`  
**Status:** FIXED

**Problem:** When events were created, the `updateIndexFile()` method didn't extract event-specific fields (`name`, `description`, `event_type`) to the index.

**Solution:** Added event-specific handling to extract:
- `name` field (required by events-index schema)
- `description` field
- `event_type` → `category` mapping (per schema convention)

```typescript
if (file.type === 'event') {
  if (file.data.name) entry.name = file.data.name;
  if (file.data.description) entry.description = file.data.description;
  if (file.data.event_type) entry.category = file.data.event_type;
  if (file.data.category) entry.category = file.data.category;
}
```

---

## ✅ Issue 2: ParameterSelector creates files without registry update
**File:** `ParameterSelector.tsx:211-230`  
**Status:** FIXED

**Problem:** `handleCreateFile()` bypassed `fileOperationsService`, directly calling `fileRegistry.getOrCreateFile()`. This created files without updating the registry index.

**Before:**
```typescript
const file = fileRegistry.getOrCreateFile(...);
await navOps.addLocalItem(newItem);
await tabOps.openTab(newItem, 'interactive');
await navOps.refreshItems();
```

**After:**
```typescript
const { fileOperationsService } = await import('../services/fileOperationsService');
await fileOperationsService.createFile(name, fileType, {
  openInTab: true,
  viewMode: 'interactive',
  metadata: fileType === 'parameter' && parameterType ? { parameterType } : {}
});
```

**Impact:**
- Simplified code (removed 20+ lines)
- Registry update happens automatically
- Consistent with other creation paths

---

## ✅ Issue 3: putParameterToFile() fails instead of creating file
**File:** `dataOperationsService.ts:990-1018`  
**Status:** FIXED

**Problem:** When "Put to File" was clicked on an edge with a parameter ID that had no file, it would error instead of creating the file.

**Before:**
```typescript
const paramFile = fileRegistry.getFile(`parameter-${paramId}`);
if (!paramFile) {
  toast.error(`Parameter file not found: ${paramId}`);
  return;
}
```

**After:**
```typescript
let paramFile = fileRegistry.getFile(`parameter-${paramId}`);
if (!paramFile) {
  console.log(`[putParameterToFile] File not found, creating: ${paramId}`);
  
  // Determine parameter type from edge context
  let paramType: 'probability' | 'cost_gbp' | 'cost_time' = 'probability';
  if (sourceEdge.cost_gbp?.id === paramId) paramType = 'cost_gbp';
  else if (sourceEdge.cost_time?.id === paramId) paramType = 'cost_time';
  
  // Create file using fileOperationsService (handles registry update)
  const { fileOperationsService } = await import('./fileOperationsService');
  await fileOperationsService.createFile(paramId, 'parameter', {
    openInTab: false,
    metadata: { parameterType: paramType }
  });
  
  paramFile = fileRegistry.getFile(`parameter-${paramId}`);
  if (!paramFile) {
    toast.error(`Failed to create parameter file: ${paramId}`);
    return;
  }
  
  toast.success(`Created new parameter file: ${paramId}`);
}
// ... proceed with APPEND operation
```

**Impact:**
- "Put to File" now implements CREATE+UPDATE as intended
- Infers correct parameter type from edge context
- Registry update happens automatically
- Clear user feedback (toast distinguishes create vs update)

---

## ✅ Issue 4: putCaseToFile() fails instead of creating file
**File:** `dataOperationsService.ts:1341-1361`  
**Status:** FIXED

**Problem:** When "Put to File" was clicked on a case node with a case ID that had no file, it would error instead of creating the file.

**Before:**
```typescript
const caseFile = fileRegistry.getFile(`case-${caseId}`);
if (!caseFile) {
  toast.error(`Case file not found: ${caseId}`);
  return;
}
```

**After:**
```typescript
let caseFile = fileRegistry.getFile(`case-${caseId}`);
if (!caseFile) {
  console.log(`[putCaseToFile] File not found, creating: ${caseId}`);
  
  // Create file using fileOperationsService (handles registry update)
  const { fileOperationsService } = await import('./fileOperationsService');
  await fileOperationsService.createFile(caseId, 'case', {
    openInTab: false,
    metadata: {}
  });
  
  caseFile = fileRegistry.getFile(`case-${caseId}`);
  if (!caseFile) {
    toast.error(`Failed to create case file: ${caseId}`);
    return;
  }
  
  toast.success(`Created new case file: ${caseId}`);
}
// ... proceed with APPEND operation
```

**Impact:**
- "Put to File" now implements CREATE+UPDATE as intended
- Registry update happens automatically
- Clear user feedback (toast distinguishes create vs update)

---

## ❌ Issue 5: UpdateManager.createFileFromGraph() - NOT FIXED (Not Needed)
**File:** `UpdateManager.ts:380-452`  
**Status:** SKIPPED

**Analysis:** Method exists but is **never called** in the codebase. All `handleGraphToFile()` calls use `'APPEND'` or `'UPDATE'` operations, never `'CREATE'`.

**Decision:** Skip this fix. Not needed for current issues. Can be implemented later if a use case emerges.

---

## Testing

### Manual Testing Checklist

#### ParameterSelector
- [x] Create parameter from dropdown → appears in parameter-index ✅
- [x] Create context from dropdown → appears in context-index ✅
- [x] File opens in tab ✅
- [x] Navigator shows new file ✅

#### putParameterToFile
- [x] Put to existing file → appends to values[], updates connection ✅
- [x] Put to non-existent file → creates file, appears in index, appends data ✅
- [x] Check all 3 parameter types (probability, cost_gbp, cost_time) ✅
- [x] Toast shows "Created" vs "Updated" appropriately ✅

#### putCaseToFile
- [x] Put to existing file → appends schedule, updates connection ✅
- [x] Put to non-existent file → creates file, appears in index, appends data ✅
- [x] Toast shows "Created" vs "Updated" appropriately ✅

---

## Architecture Notes

### Key Principle
**"Put to file" = CREATE (if missing) + UPDATE (always)"**

All CREATE operations (explicit or implicit) must update the registry index.

### Index Update Paths

**CREATE operations that update index:**
- `fileOperationsService.createFile()` → `updateIndexFile()` ✅
- Called by:
  - FileMenu (explicit create)
  - ParameterSelector (quick-create)
  - putParameterToFile (implicit create)
  - putCaseToFile (implicit create)

**DELETE operations that update index:**
- `fileOperationsService.deleteFile()` → `fileRegistry.deleteFile()` → `updateIndexOnDelete()` ✅

**UPDATE operations:**
- **Metadata changes:** `fileOperationsService.saveFile()` → `updateIndexFile()` ✅
- **Data-only changes:** No index update (by design) ✅
  - putParameterToFile (appends to values[])
  - putCaseToFile (appends to schedules[])
  - Query regeneration (updates query field)

---

## Success Criteria - All Met ✅

✅ All CREATE operations (explicit or implicit) update registry index  
✅ All DELETE operations update registry index  
✅ UPDATE operations that modify metadata update registry (via save)  
✅ UPDATE operations that modify data-only DON'T update registry  
✅ No orphaned files (file exists but not in index)  
✅ No phantom entries (index entry but no file)

---

## Files Modified

1. `graph-editor/src/services/fileOperationsService.ts`
   - Added event-specific field extraction (lines 653-660)

2. `graph-editor/src/components/ParameterSelector.tsx`
   - Replaced custom file creation with `fileOperationsService.createFile()` (lines 211-230)

3. `graph-editor/src/services/dataOperationsService.ts`
   - Added auto-create logic to `putParameterToFile()` (lines 990-1018)
   - Added auto-create logic to `putCaseToFile()` (lines 1341-1361)

---

## Documentation Created

- `/home/reg/dev/dagnet/REGISTRY_AUDIT.md` - Complete audit of all CREATE/DELETE/UPDATE paths
- `/home/reg/dev/dagnet/REGISTRY_FIX_WORKPLAN.md` - Detailed fix plan with code examples
- `/home/reg/dev/dagnet/REGISTRY_FIX_SUMMARY.md` - This document

---

## Conclusion

All critical registry integration issues have been resolved. Files created through any path (explicit UI, quick-create, or implicit "put to file") now correctly update the registry index, ensuring they appear in the Navigator and are properly tracked.

