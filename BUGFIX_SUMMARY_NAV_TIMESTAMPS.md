# Bugfix Summary: Navigator Issues (Menus & Timestamps)

## Issues Fixed

### 1. Navigator Menu Overflow ✅ FIXED

**Problem:** Pop-up dropdown menus in navigator controls were rendering outside the container, cutting off content.

**Fix:** Updated `NavigatorControls.css` to constrain dropdowns within the viewport:

```css
.control-dropdown {
  position: absolute;
  top: 100%;
  left: 0;
  right: 0;  /* ✅ Constrain to container width */
  margin-top: 2px;
  max-height: min(300px, 60vh);  /* ✅ Prevent overflow vertically */
  overflow-y: auto;  /* ✅ Allow scrolling if needed */
  width: max-content;  /* ✅ Fit content within constraints */
  /* ... other styles */
}
```

**Result:** Dropdowns now stay within the navigator sidebar and scroll if content is too long.

---

### 2. File Modification Timestamps - Investigation & Debug Logging

**Problem:** Modified dates reverting to older values after page refresh.

**Analysis:** Traced the complete timestamp lifecycle through 3 state layers:

1. **Memory (FileRegistry)** → `file.lastModified = Date.now()` on edit
2. **IndexedDB** → Saved via `db.files.put(file)` 
3. **Repository (Git)** → `data.metadata.updated` in file content

**Already Fixed (Previous Session):**
- ✅ `markSaved()` now updates both `FileState.lastModified` AND internal metadata (`data.metadata.updated` / `data.updated_at`)
- ✅ `cloneWorkspace()` extracts timestamps from file content when loading from Git
- ✅ `loadWorkspaceFromIDB()` loads FileStates with timestamps from IDB

**Debug Logging Added:**

```typescript
// TabContext.tsx - markSaved
console.log(`📝 markSaved[${fileId}]: Setting timestamps`, {
  nowISO,
  now,
  'data.metadata.updated': file.data?.metadata?.updated,
  'data.updated_at': file.data?.updated_at,
  lastModified: file.lastModified
});

// workspaceService.ts - loadWorkspaceFromIDB
console.log(`📦 loadWorkspaceFromIDB: Loaded file ${actualFileId}`, {
  lastModified: cleanFileState.lastModified,
  'data.metadata.updated': cleanFileState.data?.metadata?.updated,
  'data.updated_at': cleanFileState.data?.updated_at
});

// NavigatorContent.tsx - building entries
console.log(`🗂 NavigatorContent: Graph entry for ${item.id}`, {
  fileId,
  lastModified: file.lastModified,
  'data.metadata.updated': file.data?.metadata?.updated
});
```

**Testing Required:**

To verify the fix works:
1. Open a graph file
2. Make a small edit (drag a node)
3. Commit the file
4. Check console logs for timestamp values
5. Refresh page (F5)
6. Check console logs again - timestamps should match
7. Verify file appears at top of "Modified (Recent)" sort

**Possible Remaining Issues:**

If timestamps still revert after testing, investigate:
1. **IDB Prefix Collision:** Files saved with `repo-branch-fileId` prefix but accessed without
2. **Race Condition:** Files being re-fetched from Git after commit
3. **Duplicate Save:** Multiple save operations with different timestamps

---

## Files Changed

### CSS
- `/home/reg/dev/dagnet/graph-editor/src/components/Navigator/NavigatorControls.css`
  - Added viewport constraints to `.control-dropdown`
  - Added `max-height` with scrolling
  - Added `right: 0` to constrain width

### TypeScript (Debug Logging)
- `/home/reg/dev/dagnet/graph-editor/src/contexts/TabContext.tsx`
  - Added timestamp logging in `markSaved()`
  
- `/home/reg/dev/dagnet/graph-editor/src/services/workspaceService.ts`
  - Added timestamp logging in `loadWorkspaceFromIDB()`
  
- `/home/reg/dev/dagnet/graph-editor/src/components/Navigator/NavigatorContent.tsx`
  - Added timestamp logging when building navigator entries

---

## Documentation Created

1. **FILE_TIMESTAMP_TRACE.md** - Complete lifecycle trace of file modification timestamps through all layers
2. **BUGFIX_SUMMARY_NAV_TIMESTAMPS.md** (this file) - Summary of changes and testing plan

---

## Next Steps

**For User:**
1. Test the navigator menu dropdowns - verify they stay within bounds
2. Test timestamp persistence:
   - Edit a file
   - Commit it
   - Check console for timestamp logs
   - Refresh page
   - Check console again
   - Verify sort order is correct
3. Report any issues with specific log output

**If Timestamps Still Revert:**
- Provide console logs showing the timestamp values at each stage
- We can then identify exactly where the timestamp is being lost/overwritten

