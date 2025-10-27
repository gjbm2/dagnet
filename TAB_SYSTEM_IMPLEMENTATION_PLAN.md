# Tab System Implementation Plan

## Overview
This document breaks down the tab system implementation into specific, actionable tasks organized by phase. Each task includes acceptance criteria and estimated effort.

---

## Phase 1: Core Infrastructure (Days 1-3)

### Task 1.1: Define TypeScript Interfaces
**File**: `graph-editor/src/types/tabs.ts`

```typescript
// Core types to define:
- TabState<T>
- ObjectType
- TabSource
- TabOperation
- EditorType
```

**Acceptance Criteria**:
- [ ] All tab-related types exported
- [ ] Generic support for different data types
- [ ] Documentation comments on all interfaces
- [ ] No TypeScript errors

**Effort**: 2 hours

---

### Task 1.2: Create Tab Context & Provider
**File**: `graph-editor/src/contexts/TabContext.tsx`

**Implementation**:
```typescript
interface TabContextValue {
  tabs: TabState[];
  activeTabId: string | null;
  
  // CRUD operations
  openTab: (source, data) => void;
  closeTab: (tabId) => void;
  switchTab: (tabId) => void;
  updateTab: (tabId, updates) => void;
  
  // Batch operations
  closeTabs: (tabIds) => void;
  closeAllTabs: () => void;
  closeOtherTabs: (keepTabId) => void;
  
  // State queries
  getDirtyTabs: () => TabState[];
  getTabBySource: (source) => TabState | null;
  
  // Persistence
  saveTabs: () => void;
  restoreTabs: () => void;
}
```

**Acceptance Criteria**:
- [ ] Context provides all operations
- [ ] State updates trigger re-renders correctly
- [ ] Multiple tabs can be open simultaneously
- [ ] Active tab switching works
- [ ] Dirty state tracked correctly

**Effort**: 6 hours

---

### Task 1.3: Implement Tab Persistence
**File**: `graph-editor/src/utils/tabPersistence.ts`

**Features**:
- Save tab state to localStorage on change (debounced)
- Restore tabs on app load
- Handle version migration
- Clear storage on logout/reset

**Acceptance Criteria**:
- [ ] Tabs persist across page reload
- [ ] Data not duplicated (only source references stored)
- [ ] Handles corrupted localStorage gracefully
- [ ] Max storage size respected (5MB)

**Effort**: 4 hours

---

### Task 1.4: Repository Service Enhancement
**File**: `graph-editor/src/services/repositoryService.ts`

**New Methods**:
```typescript
class RepositoryService {
  // Load any object type by path
  loadObject(type: ObjectType, path: string): Promise<any>
  
  // Save any object type
  saveObject(type: ObjectType, path: string, data: any): Promise<void>
  
  // Batch operations
  batchSave(items: SaveItem[]): Promise<void>
  
  // List all objects of type
  listObjects(type: ObjectType): Promise<RepositoryItem[]>
  
  // Delete object
  deleteObject(type: ObjectType, path: string): Promise<void>
  
  // Branch operations
  createBranch(name: string): Promise<void>
  switchBranch(name: string): Promise<void>
  getCurrentBranch(): Promise<string>
}
```

**Acceptance Criteria**:
- [ ] All object types supported (graphs, params, contexts, cases)
- [ ] Works with existing paramRegistryService
- [ ] Error handling for network failures
- [ ] Conflict detection on save

**Effort**: 8 hours

---

## Phase 2: Layout Shell (Days 4-5)

### Task 2.1: Create AppShell Component
**File**: `graph-editor/src/components/AppShell.tsx`

**Structure**:
```
AppShell
├─ MenuBar
├─ TabBar
└─ ContentArea
   ├─ NavigationSidebar
   └─ TabContent
```

**Acceptance Criteria**:
- [ ] Responsive layout using CSS Grid/Flexbox
- [ ] No layout shift during resize
- [ ] Minimum width 1200px enforced
- [ ] Works on common screen sizes (1366px, 1920px, 2560px)

**Effort**: 6 hours

---

### Task 2.2: Implement Resizable Navigation Sidebar
**File**: `graph-editor/src/components/NavigationSidebar.tsx`

**Features**:
- Drag handle on right edge
- Collapse/expand button
- Min width: 180px, Max width: 400px, Default: 240px
- Smooth transitions
- Persist width to localStorage

**Libraries**: Use `react-resizable-panels` or custom implementation

**Acceptance Criteria**:
- [ ] Smooth resize with drag handle
- [ ] Collapse animates smoothly
- [ ] Width persists across reload
- [ ] No jank during resize
- [ ] Touch-friendly on trackpad

**Effort**: 5 hours

---

### Task 2.3: Create MenuBar Component
**File**: `graph-editor/src/components/MenuBar/MenuBar.tsx`

**Structure**:
```
MenuBar
├─ MenuItem (File)
├─ MenuItem (Edit)
├─ MenuItem (View)
├─ MenuItem (Git)
└─ MenuItem (Help)
```

**Features**:
- Dropdown menus with keyboard navigation
- Context-aware enable/disable
- Keyboard shortcuts (show in menu)
- Accessible (ARIA attributes)

**Acceptance Criteria**:
- [ ] All menus functional
- [ ] Keyboard navigation works
- [ ] Shortcuts displayed and functional
- [ ] Context updates based on active tab
- [ ] Accessible to screen readers

**Effort**: 8 hours

---

## Phase 3: Navigation Sidebar (Days 6-7)

### Task 3.1: Implement Object Type Accordion
**File**: `graph-editor/src/components/NavigationSidebar/ObjectTypeSection.tsx`

**Features**:
- Collapsible sections per object type
- Lazy load items when expanded
- Show count in header
- Persist expand/collapse state

**Acceptance Criteria**:
- [ ] Sections expand/collapse smoothly
- [ ] Only load items when expanded
- [ ] Count updates when items change
- [ ] State persists across reload

**Effort**: 4 hours

---

### Task 3.2: Implement Object List
**File**: `graph-editor/src/components/NavigationSidebar/ObjectList.tsx`

**Features**:
- Virtualized list for performance (>100 items)
- Click to open tab
- Visual indicators (open, dirty)
- Hover preview (tooltip with metadata)
- Context menu (right-click)

**Libraries**: `react-virtual` or `react-window`

**Acceptance Criteria**:
- [ ] Handles 1000+ items smoothly
- [ ] Click opens/switches to tab
- [ ] Visual indicators accurate
- [ ] Context menu functional
- [ ] Hover shows metadata

**Effort**: 6 hours

---

### Task 3.3: Implement Search Bar
**File**: `graph-editor/src/components/NavigationSidebar/SearchBar.tsx`

**Features**:
- Fuzzy search across all object types
- Debounced input (300ms)
- Keyboard navigation (arrow keys)
- Clear button
- Show results in dropdown

**Libraries**: `fuse.js` for fuzzy search

**Acceptance Criteria**:
- [ ] Search is fast (<100ms perceived)
- [ ] Results update as you type
- [ ] Keyboard navigation works
- [ ] Can open result directly from dropdown
- [ ] Highlights matched text

**Effort**: 5 hours

---

### Task 3.4: Implement Repository/Branch Selector
**File**: `graph-editor/src/components/NavigationSidebar/RepoSelector.tsx`

**Features**:
- Dropdown to select repository
- Dropdown to select branch
- Show current selection
- Refresh objects when changed

**Acceptance Criteria**:
- [ ] Lists available repositories
- [ ] Lists branches for selected repo
- [ ] Changes update object lists
- [ ] Loading state while switching

**Effort**: 3 hours

---

## Phase 4: Tab Bar & Management (Days 8-9)

### Task 4.1: Create TabBar Component
**File**: `graph-editor/src/components/TabBar/TabBar.tsx`

**Features**:
- Render all open tabs
- Show active tab visually
- Dirty indicator (*)
- Close button (X)
- Overflow handling (scroll or dropdown)
- Add new tab button (+)

**Acceptance Criteria**:
- [ ] All tabs visible or in overflow
- [ ] Active tab clearly indicated
- [ ] Dirty tabs show asterisk
- [ ] Close button works
- [ ] Can open new tab

**Effort**: 6 hours

---

### Task 4.2: Implement Tab Component
**File**: `graph-editor/src/components/TabBar/Tab.tsx`

**Features**:
- Icon based on type
- Title (truncate if too long)
- Dirty indicator
- Close button
- Click to activate
- Right-click for context menu
- Tooltip with full path

**Acceptance Criteria**:
- [ ] Renders correctly for all types
- [ ] Tooltip shows on hover
- [ ] Context menu functional
- [ ] Keyboard accessible

**Effort**: 4 hours

---

### Task 4.3: Implement Tab Context Menu
**File**: `graph-editor/src/components/TabBar/TabContextMenu.tsx`

**Options**:
- Save
- Revert
- ───────
- Close
- Close Others
- Close to Right
- Close All
- ───────
- Copy Path
- Reveal in Navigator

**Acceptance Criteria**:
- [ ] All options functional
- [ ] Disabled states correct
- [ ] Keyboard accessible
- [ ] Position correctly on screen

**Effort**: 3 hours

---

### Task 4.4: Implement Tab Overflow Handling
**File**: `graph-editor/src/components/TabBar/TabOverflow.tsx`

**Approaches**:
- Option A: Horizontal scroll with scroll buttons
- Option B: Dropdown menu for overflow tabs

**Recommendation**: Option A (scroll) - more visual

**Acceptance Criteria**:
- [ ] All tabs accessible
- [ ] Smooth scrolling
- [ ] Active tab scrolls into view
- [ ] Works with keyboard

**Effort**: 4 hours

---

## Phase 5: Generic Editors (Days 10-12)

### Task 5.1: Extract Form Editor Component
**File**: `graph-editor/src/components/editors/FormEditor.tsx`

**Extract from**: `ParamsPage.tsx` (right panel)

**Features**:
- Schema-driven RJSF form
- Sticky header (title, actions)
- Save/Revert buttons
- Validation
- Dirty tracking

**Acceptance Criteria**:
- [ ] Works with any JSON Schema
- [ ] Dirty detection accurate
- [ ] Validation shows errors
- [ ] Save/Revert functional
- [ ] Exactly matches ParamsPage right panel behavior

**Effort**: 6 hours

---

### Task 5.2: Create Editor Registry
**File**: `graph-editor/src/components/editors/EditorRegistry.ts`

**Purpose**: Map object types to editors

```typescript
const EDITOR_REGISTRY = {
  graph: GraphEditor,      // Custom
  parameter: FormEditor,   // Generic
  context: FormEditor,     // Generic
  case: FormEditor,        // Generic
};

function getEditorForType(type: ObjectType): EditorComponent {
  return EDITOR_REGISTRY[type];
}
```

**Acceptance Criteria**:
- [ ] All types have editor
- [ ] Easy to add new types
- [ ] Easy to override with custom editor

**Effort**: 2 hours

---

### Task 5.3: Adapt GraphEditor for Tab System
**File**: `graph-editor/src/components/editors/GraphEditor.tsx`

**Changes**:
- Wrap existing GraphEditorPage
- Connect to TabContext (load/save via tab)
- Remove routing logic
- Remove top menu bar (use global menu)
- Emit events for cross-tab actions

**Acceptance Criteria**:
- [ ] Existing functionality unchanged
- [ ] Loads graph from tab data
- [ ] Updates tab on changes
- [ ] Can open params in new tab
- [ ] No visual regressions

**Effort**: 6 hours

---

### Task 5.4: Create TabContent Component
**File**: `graph-editor/src/components/TabContent.tsx`

**Purpose**: Render active tab's editor

```typescript
function TabContent() {
  const { activeTab } = useTabContext();
  
  if (!activeTab) {
    return <WelcomeScreen />;
  }
  
  const Editor = getEditorForType(activeTab.type);
  return <Editor tab={activeTab} />;
}
```

**Acceptance Criteria**:
- [ ] Renders correct editor for tab type
- [ ] Handles no active tab
- [ ] Preserves editor state when switching
- [ ] No unmount/remount flicker

**Effort**: 3 hours

---

### Task 5.5: Create Welcome Screen
**File**: `graph-editor/src/components/WelcomeScreen.tsx`

**Content** (see Mockup 6):
- Welcome message
- Quick action buttons (New Graph, etc.)
- Recent files list
- Keyboard shortcuts reference

**Acceptance Criteria**:
- [ ] Shows when no tabs open
- [ ] Buttons functional
- [ ] Recent files clickable
- [ ] Visually appealing

**Effort**: 3 hours

---

## Phase 6: Git & Commit Operations (Days 13-14)

### Task 6.1: Create Commit Dialog
**File**: `graph-editor/src/components/dialogs/CommitDialog.tsx`

**Features** (see Mockup 5):
- List dirty files with checkboxes
- Select/deselect all
- View diff for each file
- Branch target selector
- Commit message input
- Validation

**Acceptance Criteria**:
- [ ] Lists all dirty tabs
- [ ] Checkboxes functional
- [ ] Diff view accurate
- [ ] Branch creation works
- [ ] Validation prevents empty commits

**Effort**: 8 hours

---

### Task 6.2: Implement Diff Viewer
**File**: `graph-editor/src/components/dialogs/DiffViewer.tsx`

**Features**:
- Side-by-side or unified view
- Syntax highlighting (JSON)
- Line numbers
- Expand/collapse sections

**Libraries**: `react-diff-view` or `diff2html`

**Acceptance Criteria**:
- [ ] Shows changes clearly
- [ ] Syntax highlighting works
- [ ] Readable and clear
- [ ] Handles large files

**Effort**: 5 hours

---

### Task 6.3: Implement Git Service
**File**: `graph-editor/src/services/gitService.ts`

**Methods**:
```typescript
class GitService {
  commitFiles(files, branch, message): Promise<void>
  createBranch(name): Promise<void>
  switchBranch(name): Promise<void>
  listBranches(): Promise<string[]>
  pull(): Promise<void>
  detectConflicts(files): Promise<Conflict[]>
}
```

**Acceptance Criteria**:
- [ ] Can commit multiple files
- [ ] Can create branches
- [ ] Can switch branches
- [ ] Detects conflicts
- [ ] Integrates with existing paramRegistryService

**Effort**: 8 hours

---

### Task 6.4: Wire Menu Actions to Commit Flow
**File**: `graph-editor/src/components/MenuBar/GitMenu.tsx`

**Actions**:
- Commit Current → Open commit dialog with active tab
- Commit All → Open commit dialog with all dirty tabs
- Create Branch → Prompt for branch name
- Switch Branch → Show branch selector
- Discard All → Confirm and revert all

**Acceptance Criteria**:
- [ ] All actions functional
- [ ] Confirmation dialogs where needed
- [ ] Feedback on success/error
- [ ] Updates UI after commit

**Effort**: 4 hours

---

## Phase 7: Polish & UX (Days 15-16)

### Task 7.1: Implement Unsaved Changes Dialog
**File**: `graph-editor/src/components/dialogs/UnsavedChangesDialog.tsx`

**Triggers**:
- Closing dirty tab
- Switching branch with dirty tabs
- Closing app with dirty tabs

**Options**:
- Save
- Don't Save
- Cancel

**Acceptance Criteria**:
- [ ] Shows when closing dirty tab
- [ ] Blocks navigation if cancelled
- [ ] Saves changes if requested
- [ ] Clear and user-friendly

**Effort**: 3 hours

---

### Task 7.2: Add Loading States
**Files**: Various

**Places**:
- Loading object from repository
- Saving object
- Switching branches
- Committing

**Implementation**:
- Spinner overlays
- Progress bars for multi-file operations
- Skeleton loaders for lists

**Acceptance Criteria**:
- [ ] Never shows blank screen
- [ ] User knows something is happening
- [ ] Can't interact with loading content
- [ ] Accessible (aria-busy)

**Effort**: 4 hours

---

### Task 7.3: Implement Error Boundaries
**File**: `graph-editor/src/components/ErrorBoundary.tsx`

**Scope**:
- Wrap each tab content
- Wrap navigation sidebar
- Wrap tab bar

**Features**:
- Catch React errors
- Show error UI
- Offer recovery actions (reload tab, report bug)
- Log to console/service

**Acceptance Criteria**:
- [ ] Errors don't crash whole app
- [ ] User can continue working
- [ ] Error details logged
- [ ] Recovery actions work

**Effort**: 3 hours

---

### Task 7.4: Add Toast Notifications
**File**: `graph-editor/src/components/ToastProvider.tsx`

**Use Cases**:
- File saved successfully
- Commit completed
- Branch created
- Errors (save failed, network error)

**Libraries**: `react-hot-toast` or `sonner`

**Acceptance Criteria**:
- [ ] Toasts appear in consistent location
- [ ] Auto-dismiss after 3-5 seconds
- [ ] Can be dismissed manually
- [ ] Stack nicely (multiple toasts)
- [ ] Accessible

**Effort**: 2 hours

---

### Task 7.5: Implement Keyboard Shortcuts
**File**: `graph-editor/src/hooks/useKeyboardShortcuts.ts`

**Shortcuts**:
- Cmd/Ctrl+N: New file
- Cmd/Ctrl+O: Open file
- Cmd/Ctrl+S: Save current tab
- Cmd/Ctrl+Shift+S: Save all
- Cmd/Ctrl+W: Close current tab
- Cmd/Ctrl+Tab: Next tab
- Cmd/Ctrl+Shift+Tab: Previous tab
- Cmd/Ctrl+1-9: Jump to tab N

**Libraries**: `react-hotkeys-hook` or custom

**Acceptance Criteria**:
- [ ] All shortcuts work
- [ ] Don't conflict with browser shortcuts
- [ ] Documented in Help menu
- [ ] Can be disabled in inputs/textareas

**Effort**: 4 hours

---

### Task 7.6: Add Animations & Transitions
**Files**: Various CSS/styled-components

**Targets**:
- Tab switching (fade)
- Sidebar collapse (slide)
- Menu dropdowns (fade + slide)
- Dialog appearance (scale + fade)
- Accordion sections (height transition)

**Principles**:
- Fast (150-250ms)
- Ease-out curves
- Respect prefers-reduced-motion
- No layout thrash

**Acceptance Criteria**:
- [ ] Transitions smooth on 60fps
- [ ] No jank or stuttering
- [ ] Reduced for accessibility users
- [ ] Consistent timing across UI

**Effort**: 4 hours

---

### Task 7.7: Responsive Testing & Fixes
**Effort**: 4 hours

Test on:
- 1366x768 (common laptop)
- 1920x1080 (standard monitor)
- 2560x1440 (common large monitor)
- 3840x2160 (4K)

**Check**:
- [ ] No horizontal scroll
- [ ] All text readable
- [ ] Buttons clickable (not too small)
- [ ] Layout doesn't break
- [ ] Performance acceptable

---

## Phase 8: Integration & Testing (Days 17-18)

### Task 8.1: Integration Testing
**Effort**: 8 hours

**Scenarios to Test**:
1. Open graph → Edit parameter → Save → Verify graph updates
2. Open 10 tabs → Commit all → Verify all saved
3. Edit 3 tabs → Close app → Reopen → Verify tabs restored
4. Switch repository → Verify objects refresh
5. Create new branch → Make changes → Commit → Verify branch
6. Conflict scenario → Verify detection and resolution
7. Network failure → Verify graceful handling
8. Corrupt localStorage → Verify recovery

**Deliverable**: Test report with pass/fail for each scenario

---

### Task 8.2: Performance Testing
**Effort**: 4 hours

**Benchmarks**:
- [ ] Open 20 tabs: <2 seconds
- [ ] Switch tabs: <100ms
- [ ] Search 1000 items: <500ms
- [ ] Load nav sidebar: <1 second
- [ ] Resize sidebar: 60fps
- [ ] Commit 10 files: <5 seconds

**Tools**: Chrome DevTools, React Profiler

**Deliverable**: Performance report with metrics

---

### Task 8.3: Accessibility Audit
**Effort**: 3 hours

**Check**:
- [ ] Keyboard navigation works everywhere
- [ ] Screen reader announces important changes
- [ ] Color contrast meets WCAG AA
- [ ] No keyboard traps
- [ ] Focus visible
- [ ] All interactive elements have labels

**Tools**: axe DevTools, Lighthouse

**Deliverable**: Accessibility report with issues

---

### Task 8.4: User Acceptance Testing
**Effort**: 4 hours

**Process**:
1. Document user workflows
2. Have 2-3 users test each workflow
3. Collect feedback
4. Prioritize fixes
5. Implement critical fixes

**Deliverable**: UAT report with user feedback

---

## Phase 9: Migration & Deployment (Day 19)

### Task 9.1: Update Routing
**File**: `graph-editor/src/App.tsx`

**Changes**:
- Remove separate routes for `/params`
- Single route to AppShell
- Handle deep linking (e.g. `/graph/:id` opens that graph in tab)

**Acceptance Criteria**:
- [ ] All URLs resolve correctly
- [ ] Deep links open correct tabs
- [ ] Back/forward buttons work
- [ ] URL updates on tab switch

**Effort**: 3 hours

---

### Task 9.2: Data Migration (if needed)
**Effort**: 2 hours

**Check**:
- [ ] All existing graphs load
- [ ] All existing params load
- [ ] No data corruption
- [ ] Backwards compatible

**If migration needed**: Write migration script

---

### Task 9.3: Documentation
**Files**: 
- `USAGE_GUIDE.md`
- Update `README.md`

**Content**:
- Overview of new UI
- How to open/edit objects
- How to commit changes
- Keyboard shortcuts
- Troubleshooting

**Effort**: 4 hours

---

### Task 9.4: Deployment
**Effort**: 3 hours

**Steps**:
1. Create feature branch
2. Merge all changes
3. Run full test suite
4. Build production bundle
5. Test production build locally
6. Deploy to staging
7. Smoke test staging
8. Deploy to production
9. Monitor for errors

**Acceptance Criteria**:
- [ ] No build errors
- [ ] No runtime errors
- [ ] Performance acceptable
- [ ] All features working

---

## Summary

### Total Estimated Effort: 
**~140-160 hours** (~19 working days at 8 hours/day)

### Critical Path:
1. Core Infrastructure (must be solid)
2. Layout Shell (foundation for UI)
3. Tab System (core functionality)
4. Editors (content display)
5. Polish (user experience)

### Risks & Mitigation:

**Risk 1**: Performance with many tabs
- *Mitigation*: Implement tab limit, virtualization, lazy loading

**Risk 2**: State management complexity
- *Mitigation*: Use React Context + clear interfaces, test thoroughly

**Risk 3**: Git operations complexity
- *Mitigation*: Use existing paramRegistryService patterns, handle conflicts gracefully

**Risk 4**: UI library conflicts (React Flow, RJSF)
- *Mitigation*: Test early, isolate in separate components

**Risk 5**: Browser storage limits
- *Mitigation*: Store minimal state, offer export/import

### Quick Wins (Low-Hanging Fruit):
- Task 1.1: TypeScript interfaces (solid foundation)
- Task 5.5: Welcome screen (nice UX boost)
- Task 7.4: Toast notifications (polish with little effort)

### Can Be Deferred:
- Tab drag-to-reorder
- Extensive theme customization
- Mobile support
- Advanced keyboard shortcuts (beyond basic)
- Tab groups/organization

---

## Next Steps

1. **Review & Approve** this plan
2. **Create Feature Branch**: `feature/tab-system`
3. **Set Up Project Board**: Create GitHub issues for each task
4. **Begin Phase 1**: Start with TypeScript interfaces

Would you like to proceed with implementation, or do you have questions/changes to the plan?

