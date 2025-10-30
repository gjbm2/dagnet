# Bugfix: Dirty State Triggering Full App Resync

## Issue Description

When editing a file (e.g., dragging a node in a graph), two problems occurred:

1. **Full Workspace Resync**: The entire workspace was reloaded, clearing the FileRegistry and reloading all files from IndexedDB
2. **Duplicate Files**: The active file was loaded twice during the resync
3. **Performance Hit**: Unnecessary work on every edit

## Root Cause

Located in `NavigatorContext.tsx` (lines 64-79), there was a `useEffect` listening for `dagnet:fileDirtyChanged` events that would trigger a **full workspace reload** via `loadItems()`:

```typescript
// OLD CODE (INCORRECT):
useEffect(() => {
  const handleFileDirtyChanged = (event: any) => {
    const { fileId, isDirty } = event.detail;
    console.log(`File ${fileId} dirty state changed, triggering refresh...`);
    
    // 🚨 THIS IS THE PROBLEM - reloads entire workspace!
    if (state.selectedRepo && state.selectedBranch) {
      loadItems(state.selectedRepo, state.selectedBranch);
    }
  };
  
  window.addEventListener('dagnet:fileDirtyChanged', handleFileDirtyChanged);
  return () => {
    window.removeEventListener('dagnet:fileDirtyChanged', handleFileDirtyChanged);
  };
}, [state.selectedRepo, state.selectedBranch]);
```

### Why This Was Wrong

1. **Unnecessary Work**: When a file's dirty state changes, the file is already loaded in memory. There's no need to reload anything.

2. **Race Conditions**: The `loadItems()` function:
   - Clears the FileRegistry (`Cleared 20 files from FileRegistry`)
   - Reloads all files from IndexedDB
   - Can cause duplicate loading of the active file
   - Interrupts ongoing edits

3. **Circular Updates**: The reload can trigger additional state updates, causing render cascades.

## The Fix

**File**: `graph-editor/src/contexts/NavigatorContext.tsx`

Removed the `loadItems()` call and its dependencies:

```typescript
// NEW CODE (CORRECT):
useEffect(() => {
  const handleFileDirtyChanged = (event: any) => {
    const { fileId, isDirty } = event.detail;
    
    // Ignore credentials file
    if (fileId === 'credentials-credentials') {
      return;
    }
    
    console.log(`🔄 NavigatorContext: File ${fileId} dirty state changed to ${isDirty}`);
    // NOTE: No need to reload items! The Navigator will automatically update
    // because NavigatorContent subscribes to registry changes via registryService.
    // Reloading here causes unnecessary work and can create race conditions.
  };

  window.addEventListener('dagnet:fileDirtyChanged', handleFileDirtyChanged);
  return () => {
    window.removeEventListener('dagnet:fileDirtyChanged', handleFileDirtyChanged);
  };
}, []); // No dependencies - just logging
```

## Why This Works

The Navigator doesn't need to reload because:

1. **NavigatorContent Already Subscribes**: In `NavigatorContent.tsx` (lines 85-109), there's already a separate subscription that properly refreshes the registry items when files change dirty state.

2. **Registry Service Tracks State**: The `registryService.getItems()` calls in NavigatorContent already check each file's dirty state from the FileRegistry.

3. **Reactive Updates**: React's reactivity ensures the UI updates when registryItems state changes.

## Testing

### Before Fix
1. Open a graph
2. Drag a node
3. **Problem**: Console shows `Cleared 20 files from FileRegistry` and all files reload
4. **Problem**: Duplicate file entries in memory
5. **Problem**: Noticeable lag

### After Fix
1. Open a graph
2. Drag a node
3. **Success**: Console shows only `File dirty state changed to true`
4. **Success**: No FileRegistry clear
5. **Success**: No reload, just UI updates
6. **Success**: Smooth, no lag

## Impact

- ✅ Fixes unnecessary workspace reloads on every edit
- ✅ Eliminates race conditions
- ✅ Prevents duplicate file loading
- ✅ Improves performance (no IDB reads on every edit)
- ✅ Cleaner console logs
- ✅ More predictable state management

## Related Code

The proper dirty state handling flow is:

1. **User edits** → GraphEditor updates file data
2. **FileRegistry detects change** → Sets `isDirty: true`
3. **FileRegistry emits event** → `dagnet:fileDirtyChanged`
4. **NavigatorContent receives event** → Refreshes registry items (lightweight)
5. **Navigator UI updates** → Shows dirty indicator

No workspace reload needed!

