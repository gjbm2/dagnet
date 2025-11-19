# Registry Integration Audit

## 1. CREATE Operations

### ✅ fileOperationsService.createFile()
**Location:** `fileOperationsService.ts:67-252`  
**Index Update:** ✅ YES (line 224: `await this.updateIndexFile(file)`)  
**Called by:**
- FileMenu.handleCreateFile() ✅
- NavigatorContext menu
- NewFileModal

### ❌ ParameterSelector.handleCreateFile()
**Location:** `ParameterSelector.tsx:211-255`  
**Index Update:** ❌ NO - Direct call to `fileRegistry.getOrCreateFile()`  
**Issue:** Creates files without updating index  
**Usage:** Quick-create from parameter selector dropdown  
**Fix Needed:** YES - Must call fileOperationsService OR update index manually

### ❓ UpdateManager.createFileFromGraph()
**Location:** `UpdateManager.ts:380-452`  
**Index Update:** ❌ NO - TODO comment at line 436  
**Status:** Not yet implemented (Phase 1 future work)  
**Usage:** Would create node/param files from graph entities

---

## 2. DELETE Operations

### ✅ fileOperationsService.deleteFile()
**Location:** `fileOperationsService.ts:308-483`  
**Index Update:** ✅ YES (via fileRegistry.deleteFile() → updateIndexOnDelete())  
**Called by:**
- FileMenu (line 465) ✅
- TabContextMenu (line 124) ✅
- NavigatorItemContextMenu (line 270) ✅
- repositoryOperationsService.discardChanges() (line 278)

### ✅ fileRegistry.deleteFile()
**Location:** `TabContext.tsx:364-388`  
**Index Update:** ✅ YES (line 385-387: `updateIndexOnDelete()`)  
**Called by:**
- fileOperationsService.deleteFile() ✅
- logFileService (temporary files)
- GuardedOperationModal

---

## 3. UPDATE Operations

### Category A: Data History Updates (NO INDEX UPDATE NEEDED)
**These modify time-series data/history, not catalog metadata:**

1. **putParameterToFile()** - `dataOperationsService.ts:957-1082`
   - Updates: `values[]` array (historical data)
   - Updates: `connection`, `connection_string` (data source)
   - Does NOT change: `id`, `name`, `type`, `description`
   - **Index Update:** ❌ NOT NEEDED

2. **putCaseToFile()** - `dataOperationsService.ts:1298-1396`
   - Updates: `case.variants` (current weights)
   - Updates: `case.schedules[]` (historical schedules)
   - Updates: `case.connection`, `case.connection_string`
   - Does NOT change: `id`, `name`, `description`
   - **Index Update:** ❌ NOT NEEDED

3. **getFromSourceDirect()** - `dataOperationsService.ts:1771+`
   - Fetches data from external sources (Statsig, Amplitude, etc.)
   - Appends to history arrays
   - Does NOT change catalog metadata
   - **Index Update:** ❌ NOT NEEDED

4. **Query Regeneration** - `queryRegenerationService.ts:149-195`
   - Updates: `data_source.query` field
   - Does NOT change: `id`, `name`, `type`, `description`, `tags`
   - **Index Update:** ❌ NOT NEEDED

### Category B: Metadata Updates (INDEX UPDATE REQUIRED)
**These modify catalog-level metadata that appears in index:**

1. **fileRegistry.updateFile()** - `TabContext.tsx:164-211`
   - Called by: 21 locations (all file edits flow through here)
   - Updates: ANY field in file data
   - **Could change:** `name`, `description`, `tags`, `status`, `type`
   - **Current State:** ❌ NO index update
   - **Should Update Index?** 🤔 **ONLY IF metadata fields changed**

2. **fileOperationsService.saveFile()** - `fileOperationsService.ts:737-762`
   - Explicitly saves file
   - **Index Update:** ✅ YES (line 758: `await this.updateIndexFile(file)`)
   - **This is the key moment** - when user explicitly saves

### Category C: Git Pull (NO MANUAL UPDATE NEEDED)
**Location:** `workspaceService.ts:301-555`  
- Git pull fetches BOTH index files AND data files
- Index files are Git-tracked (parameter-index.yaml, etc.)
- **Index Update:** ❌ NOT NEEDED (Git handles it)

---

## 4. Current Issues

### Issue 1: ParameterSelector creates files without index update ❌
**File:** `ParameterSelector.tsx:211-255`  
**Problem:** Bypasses fileOperationsService, no index update  
**Fix:** Use fileOperationsService.createFile() instead

### Issue 2: Event-specific fields not extracted to index ❌ FIXED ✅
**File:** `fileOperationsService.ts:653-660`  
**Problem:** updateIndexFile() didn't handle event.name, event.event_type → category  
**Status:** FIXED in this session

---

## 5. Recommendations

### ✅ Keep Current Behavior:
1. **fileOperationsService.saveFile()** - Updates index ✅
2. **fileOperationsService.createFile()** - Updates index ✅  
3. **fileOperationsService.deleteFile()** - Updates index ✅
4. **Data operations** - Do NOT update index ✅ (correct)
5. **Query regeneration** - Do NOT update index ✅ (correct)

### 🔧 Fix Required:
1. **ParameterSelector.handleCreateFile()** - Must update index
   - Option A: Call fileOperationsService.createFile()
   - Option B: Manually call updateIndexFile() after creation

### ❓ Open Question:
**Should fileRegistry.updateFile() trigger index updates?**

**Arguments FOR:**
- Ensures index stays in sync even with direct edits
- Handles edge cases where user edits metadata fields

**Arguments AGAINST:**
- Creates dirty index file on EVERY edit (even data-only changes)
- Expensive (need to check which fields changed)
- Index is meant to be a "stable catalog", not live mirror
- saveFile() already handles it at the right moment

**Recommendation:** NO - Keep index updates only on explicit save/create/delete
- Index is intentionally a catalog snapshot
- Updates happen at save time (fileOperationsService.saveFile)
- This is when user commits intent to persist changes

---

## 6. Update Paths Summary

```
CREATE:
  ✅ fileOperationsService.createFile() → updateIndexFile()
  ❌ ParameterSelector.handleCreateFile() → MISSING
  ❓ UpdateManager.createFileFromGraph() → TODO (future)

DELETE:
  ✅ fileOperationsService.deleteFile() → fileRegistry.deleteFile() → updateIndexOnDelete()
  ✅ fileRegistry.deleteFile() → updateIndexOnDelete()

UPDATE:
  ✅ fileOperationsService.saveFile() → updateIndexFile()
  ❌ fileRegistry.updateFile() → NO UPDATE (by design)
  ❌ dataOperationsService.put*ToFile() → NO UPDATE (correct - data only)
  ❌ queryRegenerationService → NO UPDATE (correct - query only)
```

