# Tab System Design - Critical Review

**Purpose**: Identify potential issues, gaps, and forgotten requirements before implementation

---

## 1. Current Features - Are They All Accommodated?

### ✅ Preserved Features

**From GraphEditorPage**:
- ✅ Graph canvas (React Flow)
- ✅ Node/edge selection and editing
- ✅ Properties panel
- ✅ What-If analysis
- ✅ JSON view (moved to separate tabs)
- ✅ Undo/Redo
- ✅ Auto-layout
- ✅ Edge scaling controls
- ✅ Re-routing
- ✅ Load from repository
- ✅ Save to repository
- ✅ Load/save from file
- ✅ Share URL functionality

**From ParamsPage**:
- ✅ Repository selector
- ✅ Branch selector
- ✅ Object type filtering
- ✅ Search across objects
- ✅ Form editing with validation
- ✅ Save to repository

---

## 2. Potential Issues Identified

### ⚠️ Issue 1: Share URL Functionality

**Current**: GraphEditorPage has "Save as shareable URL"
```typescript
onShare() {
  const encoded = encodeStateToUrl(graph);
  // Creates URL with graph data
}
```

**Question**: How does this work with tab system?
- Does URL open graph in a tab?
- Can URL encode multiple open tabs?
- What about tab layouts (split views, etc.)?

**Proposed Solution**:
```typescript
// URL patterns:
// Single graph: /graph?data=...
// Multiple tabs: /workspace?layout=...&tabs=...

// On load
if (url.includes('?data=')) {
  // Open single graph tab from URL
  openTabFromEncodedData(url.data);
} else if (url.includes('?layout=')) {
  // Restore entire workspace from URL
  restoreWorkspaceFromUrl(url);
}
```

**Action Required**: ✅ Add workspace URL encoding/decoding

---

### ⚠️ Issue 2: "Load from Sheets" Integration

**Current**: GraphEditorPage has Google Sheets integration
```typescript
loadFromSheet() // Load graph from Google Sheets
saveToSheet()   // Save graph to Google Sheets
```

**Question**: How does this fit with tab system?

**Proposed Solution**:
- Add Sheets as a repository type: `source.repository = 'google-sheets'`
- Navigator shows Sheets repos alongside Git repos
- Open from Sheets → creates tab with `source.repository = 'google-sheets'`
- Save → updates Sheet (not git)
- Excluded from "Commit All" (like Settings)

**Action Required**: ✅ Add Sheets repository type to design

---

### ⚠️ Issue 3: Zustand Store for Graph State

**Current**: GraphEditorPage uses Zustand for undo/redo
```typescript
const { graph, setGraph, canUndo, canRedo, undo, redo } = useGraphStore();
```

**Question**: How does this work with multiple graph tabs?

**Problem**: Zustand store is global singleton. If you have 3 graph tabs open, they'd all share the same undo/redo history!

**Proposed Solution**:
```typescript
// Create store per graph instance
function useGraphInstance(graphId: string) {
  const store = useMemo(() => 
    createGraphStore(graphId), // Separate store per ID
    [graphId]
  );
  
  return {
    graph: store.graph,
    setGraph: store.setGraph,
    undo: store.undo,
    redo: store.redo
  };
}

// Or: Single store with multiple histories keyed by graphId
const graphStore = create((set) => ({
  instances: {}, // Map<graphId, GraphState>
  getGraph: (id) => state.instances[id],
  updateGraph: (id, graph) => // ...
}));
```

**Action Required**: ⚠️ **CRITICAL** - Refactor Zustand store for multi-instance

---

### ⚠️ Issue 4: React Flow Instance Management

**Current**: Single React Flow instance per page

**Question**: Can we have multiple React Flow instances (one per graph tab)?

**Answer**: Yes, React Flow supports multiple instances. Each needs:
- Unique `id` prop
- Own state
- Own node types registry

**Concern**: Performance with 5+ graph tabs open simultaneously?

**Mitigation**:
- Unmount inactive tabs? (loses What-If state)
- Lazy render inactive tabs? (keep state, don't render)
- Tab limit (20 max)

**Proposed Solution**:
```typescript
// Each graph tab
<ReactFlowProvider key={graphId}>
  <ReactFlow id={graphId} {...props} />
</ReactFlowProvider>

// React Flow handles multiple instances internally
```

**Action Required**: ✅ Test React Flow multi-instance performance

---

### ⚠️ Issue 5: Keyboard Shortcuts Conflicts

**Current**: Keyboard shortcuts in GraphEditorPage
- Ctrl+Z: Undo
- Ctrl+Shift+Z: Redo
- Ctrl+B: Toggle sidebar
- Ctrl+S: Save

**New**: App-level shortcuts
- Ctrl+S: Save (which tab?)
- Ctrl+W: Close tab
- Ctrl+Tab: Switch tabs
- Ctrl+N: New file

**Problem**: Conflicts between graph-specific and app-level shortcuts

**Proposed Solution**:
```typescript
// Context-aware keyboard handler
function useKeyboardShortcuts() {
  const activeTab = useActiveTab();
  
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      // Ctrl+S: Save active tab
      if (e.ctrlKey && e.key === 's') {
        e.preventDefault();
        saveTab(activeTab);
      }
      
      // Ctrl+Z: Undo in graph (if graph is active)
      if (e.ctrlKey && e.key === 'z' && activeTab.type === 'graph') {
        e.preventDefault();
        undoInGraph(activeTab.id);
      }
      
      // Ctrl+W: Close tab (app-level)
      if (e.ctrlKey && e.key === 'w') {
        e.preventDefault();
        closeTab(activeTab.id);
      }
    }
    
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [activeTab]);
}
```

**Action Required**: ✅ Design comprehensive keyboard shortcut map

---

### ⚠️ Issue 6: Menu Bar State Updates

**Current**: Menu bar is part of GraphEditorPage, knows graph state directly

**New**: Menu bar is separate, needs to know active tab state

**Problem**: How does menu bar know:
- Can undo/redo? (for Edit menu)
- Which graph options to show? (for View menu)
- Is there dirty state? (for Save menu)

**Proposed Solution**:
```typescript
// Menu bar subscribes to active tab state
function MenuBar() {
  const { activeTab, getTabState } = useTabs();
  const tabState = getTabState(activeTab);
  
  // Edit menu
  const canUndo = tabState.type === 'graph' 
    ? getGraphInstance(activeTab).canUndo
    : false;
  
  // File menu
  const canSave = tabState.isDirty;
  
  return (
    <MenuBarComponent 
      canUndo={canUndo}
      canSave={canSave}
      // ...
    />
  );
}
```

**Action Required**: ✅ Define tab state interface for menu bar

---

### ⚠️ Issue 7: File Watch / Auto-Refresh

**Question**: If file changes on disk (or in git), do tabs auto-refresh?

**Scenarios**:
1. User has graph.json open in tab
2. External process updates graph.json
3. What happens?

**Options**:
A. **No auto-refresh** (safer, user has control)
   - Show notification: "graph.json changed on disk"
   - Offer: [Reload] [Keep Current]
   
B. **Auto-refresh if clean** (smart)
   - If tab is clean (not dirty) → reload automatically
   - If tab is dirty → show notification (conflict)

**Proposed Solution**: Option B
```typescript
// File watcher (git webhook or polling)
onFileChanged(path: string) {
  const affectedTabs = findTabsByPath(path);
  
  for (const tab of affectedTabs) {
    if (!tab.isDirty) {
      // Auto-reload clean tabs
      reloadTab(tab.id);
    } else {
      // Show conflict dialog for dirty tabs
      showConflictDialog(tab.id, {
        message: `${path} changed remotely`,
        options: ['Keep My Changes', 'Reload', 'Compare']
      });
    }
  }
}
```

**Action Required**: ⚠️ Add file watching / conflict detection

---

### ⚠️ Issue 8: Navigator Search Performance

**Question**: What if repository has 10,000 objects?

**Current Design**: Load all objects, filter client-side

**Problem**: Slow, memory-intensive

**Proposed Solution**:
```typescript
// Lazy load + virtual scrolling
function Navigator() {
  const [searchQuery, setSearchQuery] = useState('');
  
  // Only load visible objects
  const { data, fetchMore } = useInfiniteQuery({
    queryKey: ['objects', searchQuery],
    queryFn: ({ pageParam = 0 }) => 
      fetchObjects({ 
        search: searchQuery, 
        offset: pageParam, 
        limit: 50 
      })
  });
  
  return (
    <VirtualList
      data={data}
      itemHeight={32}
      onScrollEnd={fetchMore}
    />
  );
}
```

**Action Required**: ✅ Implement pagination + virtual scrolling for Navigator

---

### ⚠️ Issue 9: Tab Restoration - What Gets Saved?

**Question**: When restoring tabs from IndexedDB, what do we save?

**Options**:
A. **Full data** (easy but large)
   - Save entire graph JSON in IndexedDB
   - Pro: Works offline
   - Con: Large storage, stale data

B. **References only** (smaller, always fresh)
   - Save only: `{ type, path, branch, viewMode }`
   - Reload data from git on restore
   - Pro: Small storage, fresh data
   - Con: Requires network, slower

C. **Hybrid** (smart)
   - Save references + dirty state
   - On restore: reload from git, re-apply unsaved changes
   - Pro: Best of both worlds
   - Con: More complex

**Proposed Solution**: Option C
```typescript
interface TabRecord {
  id: string;
  type: ObjectType;
  viewMode: ViewMode;
  
  source: {
    repository: string;
    path: string;
    branch: string;
  };
  
  // Only save if dirty
  unsavedChanges?: {
    data: any;
    timestamp: number;
  };
}

// On restore
async function restoreTab(record: TabRecord) {
  // Load fresh data from git
  const freshData = await loadFromGit(record.source);
  
  // If there were unsaved changes, prompt user
  if (record.unsavedChanges) {
    const result = await showDialog({
      message: `Restore unsaved changes from ${formatTime(record.unsavedChanges.timestamp)}?`,
      options: ['Restore Changes', 'Use Fresh Data']
    });
    
    return result === 'Restore Changes' 
      ? record.unsavedChanges.data 
      : freshData;
  }
  
  return freshData;
}
```

**Action Required**: ⚠️ **IMPORTANT** - Design tab restoration strategy

---

### ⚠️ Issue 10: rc-dock Layout Persistence

**Question**: Save layout to IndexedDB or just user preference?

**Concern**: rc-dock layouts are complex JSON structures. If we change layout schema, old saved layouts might break.

**Proposed Solution**:
```typescript
// Version layouts
interface SavedLayout {
  version: number;      // Schema version
  layout: LayoutData;
  savedAt: number;
}

// On load
async function loadLayout() {
  const saved = await db.layouts.get('current');
  
  if (!saved || saved.version !== CURRENT_LAYOUT_VERSION) {
    // Use default layout if version mismatch
    return defaultLayout;
  }
  
  return saved.layout;
}

// Migrations
function migrateLayout(old: SavedLayout): SavedLayout {
  if (old.version === 1) {
    // Migrate v1 → v2
    return { version: 2, layout: transformV1toV2(old.layout) };
  }
  return old;
}
```

**Action Required**: ✅ Version layout schema, add migration path

---

## 3. Missing Requirements

### 🔴 Missing: Bulk Operations

**Use Case**: User wants to:
- Close all tabs of type "parameter"
- Reload all dirty tabs
- Export all open tabs as workspace

**Proposed Solution**: Add to tab context menu
```typescript
Context Menu:
├─ Close
├─ Close Others
├─ Close All
├─ ──────────
├─ Close All Parameters     ← NEW
├─ Close All Except Dirty   ← NEW
├─ ──────────
├─ Export Workspace         ← NEW
└─ Import Workspace         ← NEW
```

**Action Required**: ✅ Add bulk operations to design

---

### 🔴 Missing: Tab Groups / Workspaces

**Use Case**: User working on Feature A (3 graphs, 5 params). Needs to switch to Feature B.

**Proposed Solution** (future v2):
```typescript
// Tab groups
interface TabGroup {
  name: string;
  tabs: string[];  // Tab IDs
}

// Switch group
function switchGroup(groupName: string) {
  closeAllTabs();
  openGroup(groupName);
}
```

**Action Required**: Document as future feature (not MVP)

---

### 🔴 Missing: Tab Search (Cmd+P)

**Use Case**: User has 15 tabs open, can't find the one they want

**Proposed Solution**:
```typescript
// Quick switcher (like VS Code)
Cmd+P → Opens dialog:
┌──────────────────────────────┐
│ 🔍 [type to filter...]      │
├──────────────────────────────┤
│ graph-1.json *               │
│ alpha (Parameter)            │
│ graph-2.json                 │
│ beta (Parameter) *           │
└──────────────────────────────┘
```

**Action Required**: ✅ Add to implementation plan (Phase 7 - Polish)

---

### 🔴 Missing: Recently Closed Tabs (Cmd+Shift+T)

**Use Case**: User accidentally closes tab, wants to reopen

**Proposed Solution**:
```typescript
// Keep history of closed tabs
const closedTabs = useRef<TabState[]>([]);

function closeTab(tabId: string) {
  const tab = getTab(tabId);
  closedTabs.current.unshift(tab);
  // Keep last 10
  if (closedTabs.current.length > 10) {
    closedTabs.current.pop();
  }
  removeTab(tabId);
}

function reopenLastClosed() {
  const tab = closedTabs.current.shift();
  if (tab) openTab(tab);
}

// Keyboard shortcut
Cmd+Shift+T → reopenLastClosed()
```

**Action Required**: ✅ Add to implementation plan

---

## 4. Performance Concerns

### ⚠️ Concern 1: Memory with Many Tabs

**Issue**: 20 open tabs = 20 React Flow instances + graph data in memory

**Mitigation**:
- Limit tabs (20 max, warn at 15)
- Lazy render inactive tabs (keep state, don't mount)
- Clear undo history for old tabs

---

### ⚠️ Concern 2: IndexedDB Write Performance

**Issue**: Saving tab state on every edit = lots of writes

**Mitigation**:
- Debounce saves (1 second)
- Only save dirty state, not full data
- Background sync (Web Workers?)

---

### ⚠️ Concern 3: React Flow + rc-dock Interactions

**Issue**: Nested DockLayout might cause re-render issues

**Testing Required**:
- Does dragging graph nodes work smoothly?
- Does floating panels interfere with React Flow?
- Does tab switching cause unnecessary re-renders?

---

## 5. User Experience Gaps

### 🔵 Gap 1: No Visual Diff for Changes

**Issue**: User edited graph, can't easily see what changed

**Future Enhancement**:
- Add "Show Diff" button
- Highlight changed nodes/edges
- Show before/after comparison

---

### 🔵 Gap 2: No Collaborative Editing

**Issue**: Two users can't edit same file simultaneously

**Future Enhancement**:
- WebSocket sync
- Conflict resolution
- Presence indicators

---

### 🔵 Gap 3: No Offline Mode

**Issue**: App requires network to load files

**Future Enhancement**:
- Service worker
- Cache files locally
- Offline-first architecture

---

## 6. Migration Risks

### ⚠️ Risk 1: User Confusion

**Issue**: UI change is dramatic

**Mitigation**:
- Tutorial on first load
- "What's New" banner
- Documentation
- Keep old UI accessible for 1 month

---

### ⚠️ Risk 2: Browser Compatibility

**Issue**: IndexedDB, rc-dock might not work in older browsers

**Mitigation**:
- Show warning if unsupported
- Graceful degradation (no persistence)
- Target: Modern browsers (Chrome 90+, Firefox 88+, Safari 14+)

---

### ⚠️ Risk 3: Data Loss During Migration

**Issue**: User has unsaved work in old UI

**Mitigation**:
- Warn before switching to new UI
- Offer to save all current work
- Keep old UI route active (/legacy)

---

## 7. Summary: Action Items Before Implementation

### 🔴 Critical (Must Fix)

1. ⚠️ **Zustand store refactor** - Multi-instance support
2. ⚠️ **Tab restoration strategy** - References vs full data
3. ⚠️ **File conflict detection** - Handle external changes
4. ⚠️ **Keyboard shortcuts** - Resolve conflicts

### 🟡 Important (Should Fix)

5. ✅ Share URL functionality - Encode workspace
6. ✅ Google Sheets integration - Add as repository type
7. ✅ Navigator pagination - Handle large repos
8. ✅ Layout versioning - Migration strategy
9. ✅ Tab search (Cmd+P) - Quick switcher
10. ✅ Recently closed tabs - Reopen history

### 🟢 Nice to Have (Can Defer)

11. Bulk operations (Close All X)
12. Tab groups / workspaces
13. Visual diffs
14. Offline mode

---

## 8. Design Validation: ✅ PASS

**Overall Assessment**: Design is **sound and implementable**

**Strengths**:
- ✅ Flexible architecture (handles edge cases)
- ✅ Clear separation of concerns
- ✅ Extensible for future features
- ✅ Leverages rc-dock effectively

**Gaps Identified**: 10 issues (4 critical, 6 important)

**Recommendation**: 
1. Address critical issues in design doc
2. Add important items to implementation plan
3. Document nice-to-haves for v2
4. **Proceed with implementation** after updates

---

## Next Steps

1. Update design doc with critical fixes
2. Update implementation plan with new tasks
3. Create prototype to validate:
   - Nested rc-dock performance
   - Multi-instance React Flow
   - Tab switching smoothness
4. Begin Phase 1 implementation

