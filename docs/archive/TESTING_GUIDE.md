# Testing Guide: Local Workspace & Navigator Enhancements

This guide will help you test the newly implemented local workspace persistence model and Navigator UI enhancements.

## 🎯 Test Scenarios

### 1. File Persistence (Critical)

**Test: Files persist after tab close**
1. Open the app
2. Add credentials (File > Settings > Credentials)
3. Close the credentials tab
4. Refresh the page
5. Open credentials again (File > Settings > Credentials)
6. **✅ Expected:** Credentials are still there

**Test: Local files persist**
1. Create a new parameter/context/case
2. Close all tabs viewing that file
3. Refresh the page
4. Open Navigator
5. **✅ Expected:** The local file is still listed (in italic with "local" badge)

### 2. Navigator Filter UI

**Test: Filter dropdown**
1. Open Navigator (View > Navigator or ⌘E)
2. Click the ⚙️ icon in the search bar
3. **✅ Expected:** Filter dropdown appears with:
   - View Mode: All / Files Only
   - Show: Local Only, Dirty Only, Open Only checkboxes
   - Sort By dropdown
   - Group By options

**Test: Search functionality**
1. Type in the search bar
2. **✅ Expected:** Items filter in real-time

**Test: Local Only filter**
1. Open filter dropdown
2. Check "Local Only"
3. **✅ Expected:** Only files with "local" badge shown

**Test: Sorting**
1. Open filter dropdown
2. Change "Sort By" to "Type"
3. **✅ Expected:** Items re-sort by type

### 3. Visual State Indicators

**Test: Open files show blue dot**
1. Open a parameter file
2. Look in Navigator
3. **✅ Expected:** Blue dot (●) appears next to that parameter

**Test: Dirty files show orange dot**
1. Edit a parameter
2. Don't save
3. **✅ Expected:** Orange dot (●) appears next to that parameter

**Test: Multiple tabs show count**
1. Open the same file in two panels
2. **✅ Expected:** Shows "2" next to the dots

**Test: Local files show badge**
1. Create a new local parameter
2. **✅ Expected:** Italic text + "local" badge

### 4. Index File Icons

**Test: Index icons appear**
1. Open Navigator
2. Look at Parameters, Contexts, Cases, Nodes section headers
3. **✅ Expected:** 🔍 icon appears on the right of each header

**Test: Click index icon**
1. Click the 🔍 icon next to "Parameters"
2. **✅ Expected:** Opens `parameters-index.yaml` in a tab

**Test: Dirty index shows orange dot**
1. Create a new parameter (this marks index dirty)
2. Look at the 🔍 icon in Navigator
3. **✅ Expected:** Orange dot appears on the index icon

### 5. Repository Menu

**Test: Menu appears**
1. Click "Repository" in menu bar
2. **✅ Expected:** Menu shows:
   - Switch Repository...
   - Switch Branch...
   - Pull Latest
   - Push Changes (disabled if no dirty files)
   - Refresh Status
   - Show Dirty Files (disabled if no dirty files)
   - Discard Local Changes... (disabled if no dirty files)

**Test: Switch Repository modal**
1. Repository > Switch Repository...
2. **✅ Expected:** Modal opens
3. If you have dirty files: Warning appears
4. Can select different repository from dropdown
5. Options: "Commit First" / "Discard & Switch" / "Cancel"

**Test: Switch Branch modal**
1. Repository > Switch Branch...
2. **✅ Expected:** Similar to repository modal
3. Shows current branch
4. Can select different branch

### 6. Sync Index from Graph

**Test: Menu item appears (only in graph mode)**
1. Open a graph file in interactive mode
2. Look at "Objects" menu
3. **✅ Expected:** "Sync Index from Graph..." appears

**Test: Sync modal**
1. Objects > Sync Index from Graph...
2. **✅ Expected:** Modal opens
3. Select a graph from dropdown
4. Click "Scan for Missing Index Entries"
5. **✅ Expected:** Shows categorized list of missing IDs
6. Can collapse/expand categories
7. Can select/deselect items
8. Shows selection count

**Test: Search in modal**
1. Open Sync Index modal
2. Scan a graph
3. Type in search box
4. **✅ Expected:** Filters missing entries in real-time

### 7. Collapse State Persistence

**Test: Section collapse persists**
1. Collapse "Parameters" section in Navigator
2. Refresh the page
3. **✅ Expected:** "Parameters" is still collapsed

### 8. Index Auto-Management

**Test: Create updates index**
1. Create a new parameter
2. Click the 🔍 icon next to "Parameters"
3. Look at the index file
4. **✅ Expected:** New entry appears in index (as dirty)

**Test: Delete updates index**
1. Delete a parameter
2. Check the index file
3. **✅ Expected:** Entry removed from index (marked dirty)

## 🐛 Common Issues to Watch For

### Issue: Navigator doesn't show filter dropdown
- **Check:** Make sure you're clicking the ⚙️ icon, not the search bar itself

### Issue: Files still disappear after closing tabs
- **Check:** Browser console for errors
- **Check:** IndexedDB in DevTools > Application > IndexedDB > dagnet-app > files

### Issue: Visual indicators don't appear
- **Check:** CSS file is loaded: `src/styles/file-state-indicators.css`
- **Check:** Browser console for CSS errors

### Issue: Repository menu doesn't show
- **Check:** Menu bar is visible (not hidden)

### Issue: Index icons don't appear
- **Check:** You're looking at Parameters/Contexts/Cases/Nodes sections
- **Note:** Graphs section doesn't have an index

### Issue: Sync Index modal doesn't open
- **Check:** You must have a graph file open in interactive mode
- **Check:** Objects menu should be visible

## 📝 Test Checklist

Print this and check off as you test:

- [ ] Files persist after tab close (credentials)
- [ ] Local files persist after refresh
- [ ] Filter dropdown opens
- [ ] Search filters items
- [ ] Local Only filter works
- [ ] Sorting changes order
- [ ] Blue dot shows for open files
- [ ] Orange dot shows for dirty files
- [ ] Tab count shows for multiple tabs
- [ ] Local badge shows on local files
- [ ] Index icons appear (🔍)
- [ ] Clicking index icon opens index file
- [ ] Dirty index shows orange dot
- [ ] Repository menu shows all items
- [ ] Switch Repository modal opens
- [ ] Switch Repository warns about dirty files
- [ ] Switch Branch modal opens
- [ ] Sync Index menu item appears (in graph mode)
- [ ] Sync Index modal opens
- [ ] Sync Index scans and shows results
- [ ] Sync Index search filters results
- [ ] Section collapse state persists
- [ ] Creating item updates index
- [ ] Deleting item updates index

## 🎉 Success Criteria

All checkboxes above should be checked. If any fail, check the "Common Issues" section or report the issue with:
- What you did
- What you expected
- What actually happened
- Browser console errors (if any)

---

**Happy Testing!** 🚀

