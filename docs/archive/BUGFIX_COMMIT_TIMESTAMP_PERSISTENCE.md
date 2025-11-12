# Bugfix: Commit Timestamp Persists After Page Refresh

## Issue Description

When a user:
1. Opens a graph
2. Makes edits
3. Commits the file
4. File appears at top of "Modified" list (correct)
5. Refreshes the page
6. File returns to bottom of list (incorrect)

## Root Cause

The `markSaved()` function was updating the `FileState.lastSaved` and `FileState.lastModified` timestamps, but **not** updating the file's internal metadata timestamp (`data.metadata.updated` for graphs, `data.updated_at` for parameters/contexts/cases/nodes).

When the page refreshes:
1. Workspace reloads files from IndexedDB/Git
2. `workspaceService.ts` extracts timestamps from file content metadata
3. Old metadata timestamp is used, overwriting the actual modification time
4. File appears with old timestamp

## The Fix

**File**: `graph-editor/src/contexts/TabContext.tsx` (Lines 173-198)

### Before
```typescript
async markSaved(fileId: string): Promise<void> {
  const file = this.files.get(fileId);
  if (!file) return;

  file.originalData = structuredClone(file.data);
  file.isDirty = false;
  file.lastSaved = Date.now();  // ✅ Updates FileState
  // ❌ Does NOT update file.data.metadata.updated

  await db.files.put(file);
  this.notifyListeners(fileId, file);
  
  window.dispatchEvent(new CustomEvent('dagnet:fileDirtyChanged', { 
    detail: { fileId, isDirty: false } 
  }));
}
```

### After
```typescript
async markSaved(fileId: string): Promise<void> {
  const file = this.files.get(fileId);
  if (!file) return;

  const now = Date.now();
  const nowISO = new Date(now).toISOString();
  
  // ✅ Update internal file metadata timestamp
  if (file.data) {
    if (file.type === 'graph' && file.data.metadata) {
      file.data.metadata.updated = nowISO;
    } else if (file.type === 'parameter' || file.type === 'context' || 
               file.type === 'case' || file.type === 'node') {
      file.data.updated_at = nowISO;
    }
  }

  file.originalData = structuredClone(file.data);
  file.isDirty = false;
  file.lastSaved = now;
  file.lastModified = now;  // ✅ Also update lastModified

  await db.files.put(file);
  this.notifyListeners(fileId, file);
  
  window.dispatchEvent(new CustomEvent('dagnet:fileDirtyChanged', { 
    detail: { fileId, isDirty: false } 
  }));
}
```

## Changes Made

1. **Added timestamp variables** (lines 184-185)
   - `now`: Unix timestamp for FileState
   - `nowISO`: ISO string for file metadata

2. **Update internal metadata** (lines 187-194)
   - For graphs: Updates `data.metadata.updated`
   - For params/contexts/cases/nodes: Updates `data.updated_at`
   - Timestamp is stored in ISO format to match Git conventions

3. **Update FileState.lastModified** (line 198)
   - Ensures FileState also reflects the modification

4. **Clone includes updated metadata** (line 196)
   - `originalData` now includes the updated timestamp
   - Prevents timestamp from appearing as a change

## How It Works

### Commit Flow
```
User commits file
  ↓
markSaved() called
  ↓
Update data.metadata.updated (in file content)
  ↓
Update lastModified (in FileState)
  ↓
Save to IndexedDB
  ↓
Notify listeners → UI updates
```

### Reload Flow
```
Page refresh
  ↓
Load from IndexedDB
  ↓
workspaceService reads metadata.updated
  ↓
Sets FileState.lastModified from metadata
  ↓
Sort by "Modified" uses FileState.lastModified
  ↓
✅ File appears at top with correct timestamp
```

## Testing

### Test Scenario 1: Commit and Refresh
1. Open a graph file
2. Make a small edit (e.g., drag a node)
3. Commit the file
4. ✅ Verify file appears at top when sorted by "Modified"
5. Refresh the page (F5)
6. ✅ Verify file STILL appears at top
7. ✅ Timestamp matches pre-refresh timestamp

### Test Scenario 2: Multiple Files
1. Edit and commit File A
2. Edit and commit File B (5 seconds later)
3. ✅ Verify B appears above A in "Modified" sort
4. Refresh page
5. ✅ Verify B still appears above A
6. ✅ Order is preserved

### Test Scenario 3: Different File Types
- Test with graph (`.json`)
- Test with parameter (`.yaml`)
- Test with context (`.yaml`)
- Test with case (`.yaml`)
- ✅ All file types persist timestamps correctly

## Related Code

This fix works in conjunction with:

**`workspaceService.ts` (lines 161-175)**: Reads timestamps from file metadata
```typescript
let fileModTime = Date.now();
if (data) {
  if (data.metadata?.updated) {
    fileModTime = new Date(data.metadata.updated).getTime();
  } else if (data.metadata?.created) {
    fileModTime = new Date(data.metadata.created).getTime();
  } else if (data.updated_at) {
    fileModTime = new Date(data.updated_at).getTime();
  } else if (data.created_at) {
    fileModTime = new Date(data.created_at).getTime();
  }
}
```

## Benefits

- ✅ Timestamps persist across page refreshes
- ✅ "Sort by Modified" works correctly after commits
- ✅ File metadata matches actual modification time
- ✅ Consistent behavior across all file types
- ✅ Works with Git timestamps (ISO format)
- ✅ No data loss on refresh

## Edge Cases Handled

1. **File with no metadata object**: Safely skips update
2. **Graph without metadata.updated field**: Creates it
3. **Parameter without updated_at field**: Creates it
4. **Unknown file types**: Safely ignored (falls back to lastModified)


