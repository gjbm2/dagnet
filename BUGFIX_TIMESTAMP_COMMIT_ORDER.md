# Bugfix: File Timestamps Not Persisting Through Git Commits

## The Problem

User reported:
1. Edit file → Commit → File shows at top of "Modified" list ✅
2. Refresh page → File moves to bottom of list ❌
3. File > Clear Data → Re-clone from Git → File still at bottom ❌

**Root Cause**: Timestamps were being updated AFTER committing to Git, so Git received the file with the OLD timestamp.

## The Broken Flow

### Before Fix:
```
1. User edits file
2. Prepare file content for commit (with OLD timestamp)
3. ⬇ Commit to Git (OLD timestamp saved to Git)
4. Call markSaved() → Update timestamp (TOO LATE!)
```

**Result**: Git has old timestamp, so fresh clone loads old timestamp.

### What Was Happening:

**AppShell.tsx:1025-1040** (OLD CODE):
```typescript
const filesToCommit = files.map(file => {
  return {
    path: fullPath,
    content: file.content,  // ❌ OLD TIMESTAMP IN CONTENT
    sha: file.sha
  };
});

await gitService.commitAndPushFiles(filesToCommit, message, branch);

// ❌ TOO LATE - Git already has the old timestamp!
for (const file of files) {
  await fileRegistry.markSaved(file.fileId);  // Updates timestamp NOW
}
```

**NavigatorItemContextMenu.tsx:70-98** had the same problem.

---

## The Fix

### After Fix:
```
1. User edits file
2. Update timestamp in file content FIRST
3. ⬇ Commit to Git (NEW timestamp saved to Git) ✅
4. Call markSaved() → Sync FileState with updated content
```

**Result**: Git has new timestamp, fresh clone loads correct timestamp.

### What Changed:

**AppShell.tsx:1025-1053** (NEW CODE):
```typescript
// IMPORTANT: Update file timestamps BEFORE committing to Git
const nowISO = new Date().toISOString();
const filesToCommit = files.map(file => {
  const fileState = fileRegistry.getFile(file.fileId);
  let content = file.content;
  
  // ✅ Update timestamp in the file content itself
  if (fileState?.data) {
    if (fileState.type === 'graph' && fileState.data.metadata) {
      fileState.data.metadata.updated = nowISO;
    } else if (['parameter', 'context', 'case', 'node'].includes(fileState.type)) {
      fileState.data.updated_at = nowISO;
    }
    
    // ✅ Re-serialize with updated timestamp
    content = fileState.type === 'graph' 
      ? JSON.stringify(fileState.data, null, 2)
      : YAML.stringify(fileState.data);
  }
  
  return {
    path: fullPath,
    content,  // ✅ NEW TIMESTAMP IN CONTENT
    sha: file.sha
  };
});

// ✅ Commit to Git with NEW timestamp
await gitService.commitAndPushFiles(filesToCommit, message, branch);

// ✅ Now just syncs FileState (content already updated above)
for (const file of files) {
  await fileRegistry.markSaved(file.fileId);
}
```

**NavigatorItemContextMenu.tsx:70-115** - Applied the same fix.

---

## Files Changed

1. **AppShell.tsx**
   - Added `import YAML from 'yaml';`
   - Updated commit flow to set timestamps BEFORE committing

2. **NavigatorItemContextMenu.tsx**
   - Added `import YAML from 'yaml';`
   - Updated commit flow to set timestamps BEFORE committing

3. **TabContext.tsx** (from previous fix)
   - `markSaved()` now updates BOTH prefixed and unprefixed IDB entries

---

## Complete Timestamp Flow (Now Fixed)

### 1. Edit File
- `FileRegistry.updateFile()` sets `FileState.lastModified = Date.now()`
- Saved to IDB (unprefixed)
- UI updates immediately

### 2. Commit File
- **BEFORE commit**: Update `data.metadata.updated` (graphs) or `data.updated_at` (YAML) with `nowISO`
- **Re-serialize** file content with new timestamp
- **Commit to Git** with updated content
- **AFTER commit**: `markSaved()` updates FileState and IDB (both prefixed & unprefixed)

### 3. Page Refresh
- Load from IDB (prefixed version)
- Timestamps match because IDB was updated on commit
- ✅ File stays at top of "Modified" list

### 4. File > Clear Data (Fresh Clone)
- Delete IDB, re-clone from Git
- Parse file content from Git
- Extract timestamp from `metadata.updated` or `updated_at`
- ✅ File shows correct recent timestamp (matches Git commit)

---

## Testing

### Test 1: Edit → Commit → Refresh ✅
```
1. Open a graph file
2. Edit (drag a node)
3. Commit the file
4. Check file is at top of "Modified (Recent)" sort
5. Refresh page (F5)
6. ✅ File STAYS at top
```

### Test 2: Commit → Clear Data → Re-clone ✅
```
1. Commit a file
2. File > Clear Data
3. Workspace re-clones from Git
4. ✅ File shows at top with correct timestamp from Git content
```

### Test 3: Multiple Files ✅
```
1. Edit File A at 10:00, commit
2. Edit File B at 10:05, commit
3. ✅ B appears above A in sort
4. Refresh page
5. ✅ B still above A
6. File > Clear Data
7. ✅ B still above A (timestamps from Git match)
```

---

## Why This Approach

The user correctly pointed out two options:
1. **Get timestamp from Git** (expensive - requires separate API call per file)
2. **Store timestamp in file content** (cheap - already in the file)

We chose option 2 because:
- ✅ No extra API calls during clone
- ✅ Timestamp travels with the file
- ✅ Works offline/in any context
- ✅ Single source of truth
- ✅ Portable across systems

The fix ensures the file content timestamp gets updated BEFORE committing to Git, so it's always in sync.

---

## Related Fixes

This fix works in combination with:

1. **IDB Prefix Fix** (`TabContext.tsx:markSaved`)
   - Updates BOTH prefixed and unprefixed IDB entries
   - Prevents stale data on page refresh

2. **Navigator Reload Fix** (`NavigatorContext.tsx`)
   - Removed unnecessary `loadItems()` call on dirty state change
   - Prevents FileRegistry clearing

3. **Initial Clone Timestamp** (`workspaceService.ts:cloneWorkspace`)
   - Already extracts timestamps from file content during clone
   - No changes needed - already correct

---

## Result

✅ Timestamps now persist correctly through:
- Edit → Commit → Refresh
- Edit → Commit → Clear Data → Re-clone
- Multiple sequential commits
- Page refreshes
- Workspace reloads

The file modification date now accurately reflects when the file was last committed to Git, as stored in the file content itself.

