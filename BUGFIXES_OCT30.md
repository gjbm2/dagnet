# Bug Fixes - October 30, 2025

## Issues Fixed

### 1. ✅ Force Reload button in wrong location
**Problem:** Force Reload was added to Navigator filter dropdown (⚙️), but Repository operations belong in the Repository menu.

**Fix:** 
- Removed Force Reload button from Navigator filter dropdown
- Updated existing "Force Clone Repository" in Repository menu to use the new `forceFullReload()` operation
- Renamed to "Force Full Reload" for consistency
- Added better confirmation dialog and success/error alerts

**Files Changed:**
- `graph-editor/src/components/Navigator/NavigatorHeader.tsx` - Removed button
- `graph-editor/src/components/MenuBar/RepositoryMenu.tsx` - Updated to use `navOps.forceFullReload()`

---

### 2. 🔍 Switch Repository modal not showing all repos
**Problem:** User reports only seeing "<private-repo>" in dropdown despite having both "<private-repo>" and "dagnet" in credentials.

**Investigation:**
- Logs show both repos ARE loaded: `Available repos: <private-repo>, dagnet` (tmp.log line 38)
- Modal code looks correct - it shows current repo + filtered list of other repos
- **Added debug logging** to `SwitchRepositoryModal` to diagnose when user tests

**Files Changed:**
- `graph-editor/src/components/modals/SwitchRepositoryModal.tsx` - Added console.log to show modal state

**Status:** Needs user testing to see what the modal actually shows

---

### 3. ❌ CRITICAL: All blob fetches failing (0 files loaded)
**Problem:** After File > Clear and refresh, workspace loads 0 files. Logs show:
```
⚠️ WorkspaceService: Failed to fetch blob b451b1c3... for graphs/case-conversion-base2.json
```
**All 20 files failed to fetch!**

**Root Cause:** `Buffer.from()` doesn't exist in browser - it's a Node.js API

**Fix:**
- Changed `Buffer.from(blobResponse.data.content, 'base64').toString('utf-8')` to `atob(blobResponse.data.content)`
- Added error logging to `getBlobContent()` to show actual error messages
- Added debug logging to show which blob is being fetched

**Files Changed:**
- `graph-editor/src/services/gitService.ts` - `getBlobContent()` method

**Before:**
```typescript
const content = Buffer.from(blobResponse.data.content, 'base64').toString('utf-8');
```

**After:**
```typescript
// atob works in browser, Buffer is Node.js
const content = atob(blobResponse.data.content);
```

---

### 4. ❌ CRITICAL: Files loaded but not visible in Navigator
**Problem:** After fixing blob fetches, logs show:
- ✅ `Clone complete in 700ms! 20 files loaded`
- ✅ Files saved to IndexedDB
- ❌ `RegistryService: Processing 0 parameter files`
- ❌ Navigator shows `Loaded 0 parameters, 0 contexts, 0 cases, 0 nodes`

**Root Cause:** `cloneWorkspace()` only saved files to IndexedDB, but forgot to add them to FileRegistry's in-memory cache!

**Fix:**
- Added `(fileRegistry as any).files.set(fileId, fileState);` after saving to IndexedDB
- Now files are in BOTH IndexedDB (persistence) AND FileRegistry (in-memory for fast access)
- RegistryService calls `fileRegistry.getAllFiles()` which needs the in-memory cache

**Files Changed:**
- `graph-editor/src/services/workspaceService.ts` - Added FileRegistry.files.set() in cloneWorkspace

**Before:**
```typescript
// Save to IndexedDB
await db.files.put(fileState);
console.log(`✅ WorkspaceService: Cloned...`);
```

**After:**
```typescript
// Save to IndexedDB
await db.files.put(fileState);

// Add to FileRegistry memory cache
(fileRegistry as any).files.set(fileId, fileState);

console.log(`✅ WorkspaceService: Cloned...`);
```

**Why This Bug Happened:**
- Old `cloneWorkspace` used `getDirectoryContents` + `getFileContent` which automatically added files to FileRegistry
- New tree-based clone bypassed those methods and went straight to IndexedDB
- Forgot to manually add to FileRegistry

---

### 5. ❌ CRITICAL: Duplicate files when switching repos (race condition)
**Problem:** When switching repositories, files from BOTH repos appear in Navigator because two parallel clone operations add duplicate files to FileRegistry.

**Root Cause:** Race condition in `loadItems`:
1. `loadItems` called during initialization (line 60 in NavigatorContext)
2. State updates, triggering useEffect which calls `loadItems` again (line 543)
3. Both calls run in parallel because `isLoading` state doesn't update synchronously
4. Both clones complete and both add files to FileRegistry
5. Result: 40 files in memory (20 from each clone) but only 20 in IndexedDB (last write wins)

**Fix:**
- Added `loadingRef` (useRef) to track loading state synchronously
- Check `loadingRef.current` at start of `loadItems` and reject duplicate calls
- Reset ref in finally block

**Files Changed:**
- `graph-editor/src/contexts/NavigatorContext.tsx`

**Before:**
```typescript
const loadItems = useCallback(async (repo: string, branch: string) => {
  if (!repo) return;
  setIsLoading(true); // ❌ State update is async, doesn't prevent race
  // ...
}, []);
```

**After:**
```typescript
const loadingRef = useRef(false);

const loadItems = useCallback(async (repo: string, branch: string) => {
  if (!repo) return;
  
  // ✅ Synchronous check prevents race condition
  if (loadingRef.current) {
    console.log(`⚠️ WorkspaceService: Already loading, ignoring duplicate call`);
    return;
  }
  
  loadingRef.current = true;
  setIsLoading(true);
  try {
    // ... load logic
  } finally {
    loadingRef.current = false;
    setIsLoading(false);
  }
}, []);
```

**Why This Matters:**
- React state updates are batched and async
- `setIsLoading(true)` doesn't immediately update `isLoading`
- Second call checks old `isLoading` value (still false) and proceeds
- `useRef` provides synchronous mutable value that updates immediately

---

### 6. ❌ CRITICAL: File ID collisions when switching repos/branches
**Problem:** When switching between repositories OR branches, files from multiple workspaces appear mixed in Navigator because:
1. Files with same IDs from different workspaces overwrite each other in FileRegistry
2. FileRegistry is never cleared when switching workspaces
3. Result: `parameter-checkout-duration` from `<private-repo>` gets overwritten by `parameter-checkout-duration` from `dagnet`
4. Same issue when switching branches - old branch's files remain in FileRegistry

**Evidence from Logs:**
```
Line 1108: 📊 WorkspaceService: FileRegistry now has 35 files in memory
           (21 from <private-repo> + 14 from dagnet - some shared IDs)
Line 1156: FileRegistry has 35 total files (after switching back to <private-repo>)
Line 1287: NavigatorContent: Loaded 12 parameters, 2 contexts, 1 cases, 6 nodes
           (Shows files from BOTH repos mixed together!)
```

**Root Cause:**
- FileIds don't include repository name (e.g. `parameter-checkout-duration` not `<private-repo>-parameter-checkout-duration`)
- When cloning second repo, files with matching IDs overwrite files from first repo in FileRegistry
- FileRegistry accumulates files from all repos ever loaded in the session
- Navigator displays ALL files in FileRegistry, regardless of which repo is active

**Fix:**
Clear FileRegistry at the start of `loadItems` before loading any workspace. Both `selectRepository` and `selectBranch` call `loadItems`, so clearing happens automatically:

```typescript
// In loadItems (called by both selectRepository and selectBranch):
// Clear FileRegistry before loading new workspace to prevent file ID collisions
console.log(`🧹 WorkspaceService: Clearing FileRegistry before loading ${repo}/${branch}`);
const registrySize = (fileRegistry as any).files.size;
(fileRegistry as any).files.clear();
(fileRegistry as any).listeners.clear();
console.log(`🧹 WorkspaceService: Cleared ${registrySize} files from FileRegistry`);
```

Added logging to both operations:
```typescript
// selectRepository
console.log(`🔄 NavigatorContext: Loading items for ${repo}/${selectedBranch} (loadItems will clear FileRegistry)`);

// selectBranch  
console.log(`🔄 NavigatorContext: Loading items for ${currentRepo}/${branch}`);
```

**Files Changed:**
- `graph-editor/src/contexts/NavigatorContext.tsx` - Clear FileRegistry at start of loadItems

**Why This Works:**
- FileRegistry is an in-memory cache, cleared each time we load a workspace
- IndexedDB stores files per workspace (with repository in workspace ID)
- When loading workspace A, we clear FileRegistry then load only A's files from IDB
- When loading workspace B, we clear FileRegistry then load only B's files from IDB
- No cross-contamination between repositories

**Alternative Considered:**
Include repo name in fileIds (e.g. `<private-repo>-parameter-checkout-duration`), but this would require:
- Refactoring all fileId references throughout the codebase
- Changing how tabs are identified
- More complex workspace switching logic
- Clearing is simpler and works with existing architecture

---

### 7. ❌ CRITICAL: Files lost in IndexedDB when switching repos (ID collision)
**Problem:** When switching from repo A to repo B and back to A, repo A loses all non-graph files (parameters, contexts, cases, indexes). Only 9 graph files remain instead of 20 total files.

**Evidence from Logs:**
```
Line 198: ⚡ WorkspaceService: Clone complete! 20 files loaded (<private-repo>)
Line 419: ⚡ WorkspaceService: Clone complete! 25 files loaded (dagnet)
Line 536: 📦 WorkspaceService: Loaded 9 files from IndexedDB (<private-repo> - MISSING 11 FILES!)
Line 548: Items by type: {graph: 9} (NO parameters, contexts, cases!)
```

**Root Cause:**
- IndexedDB uses `fileId` as the **primary key** (e.g. `parameter-checkout-duration`)
- Files with the **same IDs** exist in both repos:
  - `<private-repo>`: `parameter-checkout-duration`, `context-channel`, `context-device`, `case-checkout-redesign`
  - `dagnet`: Same fileIds!
- When cloning `dagnet`, it **overwrites** the `<private-repo>` files in IndexedDB
- Result: Files from repo A get replaced by files from repo B with same IDs

**Why This Happens:**
FileIds don't include repository/branch info, so:
1. Clone `<private-repo>` → saves `parameter-checkout-duration` to IDB
2. Clone `dagnet` → overwrites with its own `parameter-checkout-duration`
3. Switch back to `<private-repo>` → tries to load, but file now contains `dagnet` data!

**Fix:**
Prefix fileIds with `repository-branch-` when saving to IndexedDB:
- **In FileRegistry (memory):** Use clean fileId (`parameter-checkout-duration`)
- **In IndexedDB (disk):** Use prefixed fileId (`<private-repo>-main-parameter-checkout-duration`)
- Strip prefix when loading from IDB back into FileRegistry

**Changes:**
1. `cloneWorkspace`: Save to IDB with prefixed ID
2. `loadWorkspaceFromIDB`: Strip prefix when loading
3. `deleteWorkspace`: Strip prefix for FileRegistry cleanup
4. `getWorkspaceFiles`: Strip prefix in returned files

**Code:**
```typescript
// Save with prefix
const idbFileId = `${repository}-${branch}-${fileId}`;
const idbFileState = { ...fileState, fileId: idbFileId };
await db.files.put(idbFileState);

// Load with prefix stripped
const prefix = `${repository}-${branch}-`;
const actualFileId = file.fileId.startsWith(prefix) 
  ? file.fileId.substring(prefix.length)
  : file.fileId;
const cleanFileState = { ...file, fileId: actualFileId };
(fileRegistry as any).files.set(actualFileId, cleanFileState);
```

**Files Changed:**
- `graph-editor/src/services/workspaceService.ts` - All IDB operations now use prefixed IDs

**Why This Works:**
- Each workspace's files get unique IDs in IndexedDB
- FileRegistry continues using clean IDs for UI/tabs
- No cross-contamination between repos
- Backwards compatible (old files without prefix still load)

---

## Testing Required

### Test 1: Force Full Reload (Fixed)
1. Open app
2. Repository menu → Force Full Reload
3. Confirm dialog
4. ✅ Should see success alert and files reload

### Test 2: Switch Repository (Needs Investigation)
1. Open app with both <private-repo> and dagnet in credentials
2. Repository menu → Switch Repository...
3. Check console for debug log: `🔄 SwitchRepositoryModal: {...}`
4. **Report:** What do you see in the dropdown? What does console log show?

### Test 3: Blob Fetching (Should be Fixed)
1. Clear IndexedDB (File > Clear or F12 → Application → IndexedDB → delete all)
2. Hard refresh (Ctrl+Shift+R)
3. ✅ Should see files load successfully
4. Check console for:
   - `📦 GitService.getBlobContent: Fetching blob...` (one per file)
   - `⚡ WorkspaceService: Clone complete in XXXms! 20 files loaded` (not 0!)
5. ✅ Navigator should show all parameters, contexts, cases

---

## Expected Console Output (After Fixes)

### Good Output:
```
📦 GitService.getRepositoryTree: Got 29 items
📦 WorkspaceService: Fetching 20 files in parallel...
📦 GitService.getBlobContent: Fetching blob b451b1c3 for gjbm2/<private-repo>
📦 GitService.getBlobContent: Fetching blob 9cde8ac5 for gjbm2/<private-repo>
... (18 more)
✅ WorkspaceService: Cloned graphs/case-conversion-base2.json (b451b1c3)
✅ WorkspaceService: Cloned graphs/WA-case-conversion.json (9cde8ac5)
... (18 more)
⚡ WorkspaceService: Clone complete in 700ms! 20 files loaded
📦 WorkspaceService: Loaded 20 files total, 16 non-index items
RegistryService: Processing 3 parameter files for dirty state
RegistryService: Processing 2 context files for dirty state
RegistryService: Processing 1 case files for dirty state
📦 NavigatorContent: Loaded 3 parameters, 2 contexts, 1 cases, 0 nodes
```

### Bad Output (Should not see anymore):
```
⚠️ WorkspaceService: Failed to fetch blob b451b1c3... for graphs/case-conversion-base2.json
⚡ WorkspaceService: Clone complete in 1668ms! 0 files loaded
```

---

## Root Cause Analysis

### Why did Buffer fail?
- `Buffer` is a Node.js global, not available in browsers
- We're running in browser (Vite dev server)
- Octokit works in both Node and browser
- When I wrote `getBlobContent()`, I used Node.js pattern instead of browser-safe `atob()`

### Why didn't we catch this earlier?
- The optimization was just implemented (same session)
- User tested immediately after implementation
- Good catch! This would have broken production

### Lesson Learned:
- ✅ Always use browser-safe APIs: `atob()`/`btoa()` not `Buffer`
- ✅ Add error logging early to catch issues fast
- ✅ Test immediately after major refactors

---

## Files Modified This Session

1. `graph-editor/src/services/gitService.ts` - Fixed Buffer→atob, added logging
2. `graph-editor/src/components/Navigator/NavigatorHeader.tsx` - Removed Force Reload button
3. `graph-editor/src/components/MenuBar/RepositoryMenu.tsx` - Updated Force Reload to use new API
4. `graph-editor/src/components/modals/SwitchRepositoryModal.tsx` - Added debug logging

---

## Next Steps

1. ✅ User test File > Clear + Refresh (should load files now)
2. 🔍 User test Repository > Switch Repository (check console logs)
3. ✅ User test Repository > Force Full Reload
4. If Switch Repository still broken, investigate based on console logs

