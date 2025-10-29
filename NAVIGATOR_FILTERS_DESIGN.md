# Navigator Filters & Repository Switching Design

## Overview

Design for Navigator filtering UI and safe repository/branch switching with workspace management.

## Part 1: File State Analysis

### File State Matrix

Navigator shows the **superset of index entries and files**. An entry can exist in multiple states:

| State | Description | Visual Indicator | Click Action |
|-------|-------------|------------------|--------------|
| **In Index Only** | Listed in index, no file yet | Gray text, "create" badge | Create new file with this ID |
| **Has File (Remote)** | File exists in Git repo | Normal text | Open file in tab |
| **Has File (Local)** | File created locally, not committed | Italic text | Open file in tab |
| **In File, Not Index** | File exists but not in index | Yellow warning icon | Prompt to add to index |
| **Dirty** | Has unsaved changes | Orange dot (●) | Open (shows changes) |
| **Open** | Has active tab | Blue dot (●) | Switch to existing tab |

### Visual Treatment Examples

```
homepage                    ● ●  ← Dirty + Open + Remote file
checkout-flow               ●    ← Dirty + Remote file  
abandoned-cart         [create] ← In index only, no file yet
local-test-param       (local) ● ← Local only + Dirty
product-page                     ← Clean remote file
orphan-param              ⚠️     ← In file, not in index
```

### "All" vs "Files Only" Mode

**All Mode (Default)**:
- Shows **superset** of index entries + files
- Includes entries that are:
  - In index with files
  - In index without files (creation candidates)
  - In files but not in index (orphans - should be rare)
- Clicking "create" entry → creates new local file with that ID → opens tab
- This is the **working mode** for building new parameters/contexts/etc.

**Files Only Mode**:
- Shows **only items with actual files** (remote or local)
- Hides index-only entries
- Useful for:
  - Seeing what's actually implemented
  - Committing (only files can be committed)
  - Finding files to open
- This is the **browsing mode** for existing content

### Filter Dimensions

Users want to filter by:
1. **File existence**: All vs Files Only (exclude planned)
2. **Location**: Remote + Local vs Remote Only vs Local Only
3. **Status**: All vs Dirty Only vs Open Only
4. **Type**: All Types vs specific type (parameter, graph, etc.)

## Part 2: Navigator Filter UI Design

### Location in Navigator

```
┌─────────────────────────────────────────┐
│ Navigator                          [×]  │
├─────────────────────────────────────────┤
│ Repository: dagnet              [↓]    │
│ Branch: main                    [↓]    │
├─────────────────────────────────────────┤
│ ┌─────────────────────────────────────┐ │  ← NEW: Filter bar
│ │ [All] [Files Only]  [🔍 Search...]  │ │
│ │ ☐ Local ☐ Dirty ☐ Open            │ │
│ └─────────────────────────────────────┘ │
├─────────────────────────────────────────┤
│ Parameters                          🔍● │
│ ├─ conversion-rate                  ● ● │
│ ├─ email-signup                       ● │
│ └─ abandoned-cart           (planned)   │
│                                         │
│ Contexts                            🔍  │
│ ├─ user-segment                         │
│ └─ time-window                          │
...
```

### Filter Bar Design (Revised for Width)

#### Option A: Search Full Width + Filter Dropdown (Recommended)

```
┌─────────────────────────────────────────────────┐
│ [🔍 Search parameters, contexts, cases...] [⚙️] │
│      ↑                                       ↑   │
│   Full width search                    Filters  │
└─────────────────────────────────────────────────┘

Clicking [⚙️] opens dropdown:
┌─────────────────────────────────────┐
│ Show Mode:                          │
│ ⚫ All (index + files)              │
│ ⚪ Files Only                       │
│ ─────────────────────────────────── │
│ Filter by State:                    │
│ ☐ Local only                       │
│ ☐ Dirty only                       │
│ ☐ Open only                        │
│ ─────────────────────────────────── │
│ Include:                            │
│ ☑ Not yet files                    │
│ ☑ Orphans (no index)               │
│ ─────────────────────────────────── │
│ Sort By:                            │
│ ⚫ Name (A-Z)                       │
│ ⚪ Name (Z-A)                       │
│ ⚪ Recently Modified                │
│ ⚪ Recently Opened                  │
│ ⚪ Status (Dirty first)             │
│ ⚪ Type                             │
│ ─────────────────────────────────── │
│ Group By:                           │
│ ☑ Sub-categories                   │
│ ☐ Tags                             │
└─────────────────────────────────────┘
```

#### Option B: Search + Inline Chips

```
┌─────────────────────────────────────────────────┐
│ [🔍 Search...]  Mode:[All▾] [Dirty ×] [Local ×]│
└─────────────────────────────────────────────────┘
```

#### Option C: Two-Line Layout

```
┌─────────────────────────────────────────────────┐
│ ⚫ All  ⚪ Files   ☐ Local ☐ Dirty ☐ Open      │
│ [🔍 Search parameters, contexts, cases...]      │
└─────────────────────────────────────────────────┘
```

**Recommendation: Option A** 
- Search gets full width (most important)
- Filters accessible but don't clutter
- Dropdown allows explanatory text
- Can show active filter count on icon: [⚙️ 2]

### Filter Logic (Revised)

```typescript
interface NavigatorEntry {
  id: string;
  name: string;
  type: ObjectType;
  
  // File existence
  hasFile: boolean;         // Has actual file (remote or local)
  isLocal: boolean;         // File is local only
  inIndex: boolean;         // Listed in index
  
  // State flags
  isDirty: boolean;         // Has unsaved changes
  isOpen: boolean;          // Has open tab
  isOrphan: boolean;        // In file but not in index
  
  // For display
  tags?: string[];
  path?: string;
}

interface NavigatorFilters {
  mode: 'all' | 'files-only';     // All entries or only with files
  showLocalOnly: boolean;          // Filter: show only local files
  showDirtyOnly: boolean;          // Filter: show only dirty files
  showOpenOnly: boolean;           // Filter: show only open files
  includeNotYetFiles: boolean;     // Include index-only entries (no file)
  includeOrphans: boolean;         // Include files not in index
  searchQuery: string;             // Text search
  
  // NEW: Sorting
  sortBy: 'name-asc' | 'name-desc' | 'modified' | 'opened' | 'status' | 'type';
  
  // NEW: Grouping
  groupBySubCategories: boolean;   // Show sub-categories (Parameters, Nodes, Cases)
  groupByTags: boolean;            // Group by tags instead of sub-categories
}

function buildNavigatorEntries(): NavigatorEntry[] {
  // 1. Get all index entries
  const indexEntries = Object.values(registryIndexes).flatMap(
    index => index?.items || []
  );
  
  // 2. Get all files
  const files = fileRegistry.getAll();
  
  // 3. Build superset
  const entriesMap = new Map<string, NavigatorEntry>();
  
  // Add index entries
  for (const indexEntry of indexEntries) {
    entriesMap.set(indexEntry.id, {
      id: indexEntry.id,
      name: indexEntry.name || indexEntry.id,
      type: indexEntry.type,
      hasFile: false,        // Will update if file exists
      isLocal: false,
      inIndex: true,
      isDirty: false,
      isOpen: false,
      isOrphan: false,
      tags: indexEntry.tags
    });
  }
  
  // Add/update with file data
  for (const file of files) {
    const existing = entriesMap.get(file.fileId);
    if (existing) {
      // File exists for index entry
      existing.hasFile = true;
      existing.isLocal = file.isLocal;
      existing.isDirty = file.isDirty;
      existing.isOpen = file.viewTabs.length > 0;
      existing.path = file.source.path;
    } else {
      // Orphan: file exists but not in index
      entriesMap.set(file.fileId, {
        id: file.fileId,
        name: file.name,
        type: file.type,
        hasFile: true,
        isLocal: file.isLocal,
        inIndex: false,        // Not in index!
        isDirty: file.isDirty,
        isOpen: file.viewTabs.length > 0,
        isOrphan: true,        // WARNING state
        path: file.source.path
      });
    }
  }
  
  return Array.from(entriesMap.values());
}

function applyFiltersAndSort(
  entries: NavigatorEntry[], 
  filters: NavigatorFilters
): NavigatorEntry[] {
  
  // 1. Filter
  let filtered = entries.filter(entry => {
    // Mode filter
    if (filters.mode === 'files-only' && !entry.hasFile) {
      return false; // Exclude index-only entries
    }
    
    // Include filters
    if (!filters.includeNotYetFiles && !entry.hasFile && entry.inIndex) {
      return false; // Hide index-only entries
    }
    
    if (!filters.includeOrphans && entry.isOrphan) {
      return false; // Hide orphan files
    }
    
    // State filters (when checked, ONLY show matching)
    if (filters.showLocalOnly && !entry.isLocal) {
      return false;
    }
    
    if (filters.showDirtyOnly && !entry.isDirty) {
      return false;
    }
    
    if (filters.showOpenOnly && !entry.isOpen) {
      return false;
    }
    
    // Search filter
    if (filters.searchQuery) {
      const query = filters.searchQuery.toLowerCase();
      return entry.name.toLowerCase().includes(query) ||
             entry.id.toLowerCase().includes(query) ||
             entry.tags?.some(t => t.toLowerCase().includes(query)) ||
             entry.path?.toLowerCase().includes(query);
    }
    
    return true;
  });
  
  // 2. Sort
  filtered.sort((a, b) => {
    switch (filters.sortBy) {
      case 'name-asc':
        return a.name.localeCompare(b.name);
      
      case 'name-desc':
        return b.name.localeCompare(a.name);
      
      case 'modified':
        return (b.lastModified || 0) - (a.lastModified || 0);
      
      case 'opened':
        return (b.lastOpened || 0) - (a.lastOpened || 0);
      
      case 'status':
        // Dirty first, then open, then clean
        if (a.isDirty !== b.isDirty) return a.isDirty ? -1 : 1;
        if (a.isOpen !== b.isOpen) return a.isOpen ? -1 : 1;
        return 0;
      
      case 'type':
        return a.type.localeCompare(b.type);
      
      default:
        return 0;
    }
  });
  
  return filtered;
}

// 3. Group (if enabled)
function groupEntries(
  entries: NavigatorEntry[],
  filters: NavigatorFilters
): Record<string, NavigatorEntry[]> {
  
  if (!filters.groupBySubCategories && !filters.groupByTags) {
    return { 'all': entries }; // No grouping
  }
  
  if (filters.groupByTags) {
    // Group by tags
    const groups: Record<string, NavigatorEntry[]> = {};
    for (const entry of entries) {
      for (const tag of entry.tags || ['untagged']) {
        if (!groups[tag]) groups[tag] = [];
        groups[tag].push(entry);
      }
    }
    return groups;
  }
  
  if (filters.groupBySubCategories) {
    // Group by sub-category (type-specific logic)
    const groups: Record<string, NavigatorEntry[]> = {};
    
    for (const entry of entries) {
      let subCategory = 'other';
      
      // Type-specific categorization
      if (entry.type === 'parameter') {
        if (entry.parameter_type === 'probability') subCategory = 'probability';
        else if (entry.parameter_type === 'cost_gbp') subCategory = 'cost_gbp';
        else if (entry.parameter_type === 'cost_time') subCategory = 'cost_time';
      } else if (entry.type === 'node') {
        if (entry.node_type === 'entry') subCategory = 'entry';
        else if (entry.node_type === 'conversion') subCategory = 'conversion';
        else if (entry.node_type === 'exit') subCategory = 'exit';
      } else if (entry.type === 'case') {
        if (entry.case_type === 'ab_test') subCategory = 'ab_test';
        else if (entry.case_type === 'feature_flag') subCategory = 'feature_flag';
      }
      
      if (!groups[subCategory]) groups[subCategory] = [];
      groups[subCategory].push(entry);
    }
    
    return groups;
  }
  
  return { 'all': entries };
}
```

### Filter Presets

Common filter combinations as one-click presets:

```
┌─────────────────────────────────────────┐
│ Presets: [All] [Dirty] [Open] [Local] │
└─────────────────────────────────────────┘

All    = mode: all, no filters
Dirty  = mode: all, showDirty: true
Open   = mode: all, showOpen: true  
Local  = mode: all, showLocal: true (hides remote)
```

### State Persistence

```typescript
// Save filter state to localStorage
const FILTER_STORAGE_KEY = 'dagnet:navigator:filters';

function saveFilters(filters: NavigatorFilters) {
  localStorage.setItem(FILTER_STORAGE_KEY, JSON.stringify(filters));
}

function loadFilters(): NavigatorFilters {
  const saved = localStorage.getItem(FILTER_STORAGE_KEY);
  return saved ? JSON.parse(saved) : defaultFilters;
}
```

## Part 3: Repository & Branch Switching

### Current Problem

Repository and branch selectors look like casual dropdowns, but changing them is a **major destructive operation** that:
1. Flushes entire workspace
2. Loses all uncommitted changes
3. Requires re-cloning from Git

### Switching Rules

#### Repository Change = Full Workspace Flush

```
User selects different repo
  ↓
Check for dirty files
  ↓
If dirty: Show warning modal
  ↓
User confirms
  ↓
1. Close all tabs
2. Clear workspace (db.files)
3. Clone new repo
4. Reinitialize Navigator
```

#### Branch Change = Depends on Implementation

**Option A: Branch Switch = Flush (Simpler, Safer)**
- Same as repo change
- Clear workspace, re-clone from new branch
- No merge conflicts possible

**Option B: Branch Switch = Git Checkout (Complex)**
- Keep local changes if possible
- Attempt to merge with new branch
- Handle conflicts
- More work, more risk

**Recommendation: Option A for Phase 1**, Option B for later

### UI Changes

#### Current (Problematic)

```
Repository: [dagnet            ▾]  ← Looks like safe dropdown
Branch:     [main              ▾]  ← Looks like safe toggle
```

#### Proposed: Guarded Selectors

```
Repository: dagnet         [Switch...]  ← Button, not dropdown
Branch:     main          [Switch...]  ← Button, not dropdown
```

Or with modal pattern:

```
Repository: dagnet                [⚙️]  ← Opens modal
Branch:     main                  [⚙️]  ← Opens modal
```

### Switch Repository Modal

```
┌───────────────────────────────────────────────┐
│ Switch Repository                             │
├───────────────────────────────────────────────┤
│                                               │
│ Current Repository: dagnet                    │
│ Current Branch: main                          │
│                                               │
│ ⚠️  Warning: Switching repository will:       │
│   • Close all open tabs                       │
│   • Discard uncommitted changes               │
│   • Clear local workspace                     │
│                                               │
│ You have 3 uncommitted changes:               │
│   • parameters/conversion-rate.yaml           │
│   • graphs/funnel.yaml                        │
│   • parameters-index.yaml                     │
│                                               │
│ ┌───────────────────────────────────────────┐ │
│ │ Select Repository:                        │ │
│ │ ⚪ dagnet (current)                        │ │
│ │ ⚪ example-project                         │ │
│ │ ⚪ test-repo                               │ │
│ └───────────────────────────────────────────┘ │
│                                               │
│ ┌───────────────────────────────────────────┐ │
│ │ Or enter new repository URL:              │ │
│ │ [https://github.com/...]                  │ │
│ └───────────────────────────────────────────┘ │
│                                               │
│        [Cancel]  [Commit & Switch]  [Switch]  │
│                     ↑                   ↑      │
│                  Safe option      Force switch │
└───────────────────────────────────────────────┘
```

### Switch Branch Modal

```
┌───────────────────────────────────────────────┐
│ Switch Branch                                 │
├───────────────────────────────────────────────┤
│                                               │
│ Current Branch: main                          │
│                                               │
│ ⚠️  Warning: Switching branch will:           │
│   • Close all open tabs                       │
│   • Discard uncommitted changes               │
│   • Reload workspace from new branch          │
│                                               │
│ You have 3 uncommitted changes.               │
│                                               │
│ ┌───────────────────────────────────────────┐ │
│ │ Select Branch:                            │ │
│ │ ⚪ main (current)                          │ │
│ │ ⚪ develop                                 │ │
│ │ ⚪ feature/new-parameters                  │ │
│ │ ⚪ staging                                 │ │
│ └───────────────────────────────────────────┘ │
│                                               │
│        [Cancel]  [Commit & Switch]  [Switch]  │
└───────────────────────────────────────────────┘
```

### Implementation

```typescript
// In NavigatorHeader.tsx
async function handleSwitchRepository() {
  // 1. Check for dirty files
  const dirtyFiles = fileRegistry.getAllDirty();
  
  if (dirtyFiles.length > 0) {
    const action = await showSwitchRepositoryModal({
      currentRepo: state.selectedRepo,
      dirtyFiles: dirtyFiles,
      availableRepos: credentialsManager.getRepositories()
    });
    
    if (!action) return; // User cancelled
    
    if (action.commitFirst) {
      // Commit all changes first
      await commitAll("Pre-switch commit", state.selectedBranch);
    }
  }
  
  // 2. Close all tabs
  await tabContext.closeAllTabs(true); // force = true
  
  // 3. Clear workspace
  await db.files.clear();
  fileRegistry.clear();
  
  // 4. Update credentials/config
  await updateSelectedRepository(action.newRepo);
  
  // 5. Clone new repo
  await cloneRepository(action.newRepo, state.selectedBranch);
  
  // 6. Reload Navigator
  await loadWorkspace();
  
  // 7. Show success message
  showNotification(`Switched to ${action.newRepo}`);
}

async function handleSwitchBranch() {
  // Similar logic for branch switching
  const dirtyFiles = fileRegistry.getAllDirty();
  
  if (dirtyFiles.length > 0) {
    const action = await showSwitchBranchModal({
      currentBranch: state.selectedBranch,
      dirtyFiles: dirtyFiles,
      availableBranches: await gitService.listBranches()
    });
    
    if (!action) return;
    
    if (action.commitFirst) {
      await commitAll("Pre-switch commit", state.selectedBranch);
    }
  }
  
  // Close tabs, clear workspace, re-clone from new branch
  await tabContext.closeAllTabs(true);
  await db.files.clear();
  fileRegistry.clear();
  
  await cloneRepository(state.selectedRepo, action.newBranch);
  await loadWorkspace();
  
  showNotification(`Switched to branch ${action.newBranch}`);
}
```

### Safety Mechanisms

#### 1. Prevent Accidental Clicks

```typescript
// Require confirmation for destructive actions
const confirmed = await showConfirm({
  title: 'Switch Repository?',
  message: 'This will close all tabs and discard uncommitted changes.',
  confirmLabel: 'Switch Repository',
  confirmVariant: 'danger',
  requireTyping: dirtyFiles.length > 5 // Extra safety for many changes
});
```

#### 2. Auto-Save Before Switch (Optional)

```typescript
// Offer to create backup
const action = await showSwitchModal({
  // ...
  options: {
    backupToLocalStorage: true, // Save dirty files to restore later
    commitBeforeSwitch: true,   // Commit changes first
    cancelSwitch: true          // Just cancel
  }
});
```

#### 3. Undo/Restore (Advanced)

```typescript
// Keep last workspace state for 24 hours
interface WorkspaceSnapshot {
  repository: string;
  branch: string;
  files: FileState[];
  timestamp: number;
}

// Allow restore if user switches back quickly
if (canRestoreSnapshot(newRepo, newBranch)) {
  const restore = await showConfirm({
    title: 'Restore Previous Workspace?',
    message: 'Found recent workspace snapshot. Restore instead of re-cloning?'
  });
  
  if (restore) {
    await restoreSnapshot(newRepo, newBranch);
    return;
  }
}
```

## Part 4: Complete Navigator Layout (Revised with Sub-Categories)

```
┌─────────────────────────────────────────────────┐
│ Navigator                              [×]      │
├─────────────────────────────────────────────────┤
│ Repository: dagnet            [Switch Repo...] │
│ Branch:     main             [Switch Branch...] │
├─────────────────────────────────────────────────┤
│ [🔍 Search parameters, contexts, cases...] [⚙️]│
│                                            ↑    │
│                                        Filters  │
├─────────────────────────────────────────────────┤
│ 📊 Graphs (2)                           🔍     │
│ ├─ conversion-funnel                    ● ●    │
│ └─ user-journey                               │
│                                                 │
│ 📊 Parameters (18 + 5 create)           🔍●    │
│ ├─ ▼ Probability (8 + 2)                      │ ← Collapsible sub-category
│ │  ├─ conversion-rate                   ● ●    │
│ │  ├─ email-signup                        ●    │
│ │  ├─ checkout-complete                        │
│ │  ├─ abandoned-rate              [create]     │
│ │  └─ ...                                      │
│ ├─ ▼ Cost (GBP) (6 + 2)                       │
│ │  ├─ acquisition-cost                   ●     │
│ │  ├─ support-cost                             │
│ │  ├─ local-cost             (local)     ●     │
│ │  └─ ...                                      │
│ ├─ ▼ Cost (Time) (4 + 1)                      │
│ │  ├─ processing-time                          │
│ │  ├─ wait-time                   [create]     │
│ │  └─ ...                                      │
│ └─ ▶ Other / Uncategorized (0)                │ ← Collapsed by default if empty
│                                                 │
│ 🎯 Contexts (2)                         🔍     │
│ ├─ user-segment                                │
│ └─ time-window                  [create]       │
│                                                 │
│ 🎲 Cases (3)                            🔍     │
│ ├─ ▼ A/B Tests (2)                            │
│ │  ├─ homepage-test                     ●      │
│ │  └─ checkout-variant          [create]       │
│ └─ ▶ Feature Flags (1)                        │
│    └─ experiment-123            [create]       │
│                                                 │
│ 🔷 Nodes (15 + 8 create)                🔍●    │
│ ├─ ▼ Entry Points (3)                         │
│ │  ├─ homepage                                 │
│ │  ├─ landing-page-a            [create]       │
│ │  └─ search-entry              [create]       │
│ ├─ ▼ Conversion (5 + 2)                       │
│ │  ├─ checkout-complete                        │
│ │  ├─ product-page              [create]       │
│ │  └─ ...                                      │
│ └─ ▼ Exit Points (7 + 4)                      │
│    ├─ abandoned-cart            [create]       │
│    ├─ help-center               [create]       │
│    └─ ...                                      │
...
```

### Visual Treatment Legend

```
Clean remote file:     normal-text
Dirty file:            normal-text     ●
Open tab:              normal-text   ●
Open + Dirty:          normal-text   ● ●
Local only:            italic-text  (local)
Local + Dirty:         italic-text  (local) ●
Index only:            gray-text    [create]
Orphan (warning):      normal-text     ⚠️
```

### Category Header with Counts

```tsx
<CategoryHeader>
  <Icon>📊</Icon>
  <span>Parameters</span>
  <Count>(18 + 5 create)</Count>  {/* 18 files, 5 index-only */}
  <IndexFileIcon 
    fileId="parameters-index"
    isDirty={true}  {/* Shows orange dot */}
    onClick={() => openIndexFile('parameters-index')}
  />
</CategoryHeader>
```

### Sub-Category Structure

```tsx
<Category name="Parameters">
  <SubCategory 
    name="Probability" 
    count={8} 
    createCount={2}
    isCollapsible={true}
    defaultOpen={true}
  >
    {/* Items with type=probability */}
  </SubCategory>
  
  <SubCategory 
    name="Cost (GBP)" 
    count={6} 
    createCount={2}
    isCollapsible={true}
    defaultOpen={true}
  >
    {/* Items with type=cost_gbp */}
  </SubCategory>
  
  <SubCategory 
    name="Cost (Time)" 
    count={4} 
    createCount={1}
    isCollapsible={true}
    defaultOpen={true}
  >
    {/* Items with type=cost_time */}
  </SubCategory>
  
  <SubCategory 
    name="Other / Uncategorized" 
    count={0}
    isCollapsible={true}
    defaultOpen={false}  {/* Collapsed if empty */}
  >
    {/* Items without clear type */}
  </SubCategory>
</Category>
```

### Sub-Categorization Logic

#### Parameters
Categorize by `parameter_type` field in index/file:

```typescript
const parameterSubCategories = {
  'probability': {
    name: 'Probability',
    icon: '📊',
    match: (param: Parameter) => 
      param.parameter_type === 'probability' ||
      param.type === 'probability' ||
      (param.value >= 0 && param.value <= 1) // Heuristic
  },
  'cost_gbp': {
    name: 'Cost (GBP)',
    icon: '💷',
    match: (param: Parameter) => 
      param.parameter_type === 'cost_gbp' ||
      param.unit === 'GBP' ||
      param.id.includes('cost')
  },
  'cost_time': {
    name: 'Cost (Time)',
    icon: '⏱️',
    match: (param: Parameter) => 
      param.parameter_type === 'cost_time' ||
      param.unit === 'seconds' ||
      param.id.includes('time')
  },
  'other': {
    name: 'Other / Uncategorized',
    icon: '📋',
    match: () => true  // Catch-all
  }
};
```

#### Nodes
Categorize by `node_type` or `category` field:

```typescript
const nodeSubCategories = {
  'entry': {
    name: 'Entry Points',
    match: (node: Node) => node.type === 'entry'
  },
  'conversion': {
    name: 'Conversion',
    match: (node: Node) => 
      node.type === 'conversion' ||
      node.category === 'conversion'
  },
  'exit': {
    name: 'Exit Points',
    match: (node: Node) => 
      node.type === 'exit' ||
      node.type === 'success' ||
      node.type === 'failure'
  },
  'flow': {
    name: 'Flows',
    match: (node: Node) => node.type === 'flow'
  }
};
```

#### Cases
Categorize by `case_type` or tags:

```typescript
const caseSubCategories = {
  'ab_test': {
    name: 'A/B Tests',
    match: (caseItem: Case) => 
      caseItem.type === 'ab_test' ||
      caseItem.tags?.includes('ab-test')
  },
  'feature_flag': {
    name: 'Feature Flags',
    match: (caseItem: Case) => 
      caseItem.type === 'feature_flag' ||
      caseItem.tags?.includes('feature-flag')
  },
  'multivariate': {
    name: 'Multivariate Tests',
    match: (caseItem: Case) => 
      caseItem.type === 'multivariate' ||
      caseItem.variants?.length > 2
  }
};
```

#### Contexts
May not need sub-categories initially (typically small count)

```typescript
// Optional: If contexts grow large
const contextSubCategories = {
  'user': {
    name: 'User Attributes',
    match: (ctx: Context) => 
      ctx.category === 'user' ||
      ctx.tags?.includes('user')
  },
  'temporal': {
    name: 'Temporal',
    match: (ctx: Context) => 
      ctx.type === 'temporal' ||
      ctx.tags?.includes('time')
  }
};
```

### Collapsible State Persistence

```typescript
interface NavigatorCollapseState {
  [categoryId: string]: {
    [subCategoryId: string]: boolean;  // true = expanded
  };
}

// Save to localStorage
const COLLAPSE_STATE_KEY = 'dagnet:navigator:collapse';

function saveCollapseState(state: NavigatorCollapseState) {
  localStorage.setItem(COLLAPSE_STATE_KEY, JSON.stringify(state));
}

function loadCollapseState(): NavigatorCollapseState {
  const saved = localStorage.getItem(COLLAPSE_STATE_KEY);
  return saved ? JSON.parse(saved) : {};
}

// Example usage
const collapseState = loadCollapseState();
const isExpanded = collapseState['parameters']?.['probability'] ?? true; // Default: expanded
```

## Part 5: Visual Consistency Across Components

### Standard Visual Treatment (Use Everywhere)

These visual treatments should be **consistent** across:
1. **Navigator panel** - list items
2. **Tab headers** - tab titles  
3. **Sidebar selectors** - dropdown options in graph editor

### Component-Specific Rendering

#### Navigator Item
```tsx
<NavigatorItem entry={entry}>
  <Icon>{getIcon(entry.type)}</Icon>
  <Name className={getNameClass(entry)}>
    {entry.name}
  </Name>
  {!entry.hasFile && <Badge>[create]</Badge>}
  {entry.isLocal && <Badge>(local)</Badge>}
  {entry.isOrphan && <WarningIcon>⚠️</WarningIcon>}
  <StatusDots>
    {entry.isOpen && <Dot color="blue">●</Dot>}
    {entry.isDirty && <Dot color="orange">●</Dot>}
  </StatusDots>
</NavigatorItem>

function getNameClass(entry: NavigatorEntry): string {
  if (!entry.hasFile) return 'text-gray-500'; // Index only
  if (entry.isLocal) return 'italic';          // Local file
  if (entry.isOrphan) return 'text-yellow-600'; // Warning
  return 'text-normal';                        // Normal
}
```

#### Tab Header
```tsx
<TabHeader tab={tab}>
  <Icon>{getIcon(tab.type)}</Icon>
  <Title className={getTitleClass(tab)}>
    {tab.title}
  </Title>
  {tab.isLocal && <Badge>(local)</Badge>}
  {tab.isDirty && <Dot color="orange">●</Dot>}
  <CloseButton onClick={() => closeTab(tab.id)}>×</CloseButton>
</TabHeader>
```

#### Selector Option (in Graph Editor)
```tsx
<SelectorOption entry={entry}>
  <Icon>{getIcon(entry.type)}</Icon>
  <Name className={getNameClass(entry)}>
    {entry.name}
  </Name>
  {!entry.hasFile && <Badge>[create]</Badge>}
  {entry.isLocal && <Badge>(local)</Badge>}
  {entry.isOrphan && <WarningIcon>⚠️</WarningIcon>}
  {entry.isDirty && <Dot color="orange">●</Dot>}
  {/* Show additional context in selector */}
  {entry.path && <Path>({entry.path})</Path>}
</SelectorOption>
```

### CSS Classes (Shared Stylesheet)

```css
/* File state classes */
.file-state-normal {
  color: var(--text-normal);
  font-style: normal;
}

.file-state-local {
  color: var(--text-normal);
  font-style: italic;
}

.file-state-not-yet-file {
  color: var(--text-gray);
  font-style: normal;
}

.file-state-orphan {
  color: var(--text-warning);
  font-style: normal;
}

/* Status badges */
.status-badge {
  display: inline-block;
  padding: 2px 6px;
  border-radius: 3px;
  font-size: 11px;
  font-weight: 500;
  margin-left: 4px;
}

.status-badge-create {
  background: var(--bg-gray-light);
  color: var(--text-gray);
  border: 1px dashed var(--border-gray);
}

.status-badge-local {
  background: var(--bg-blue-light);
  color: var(--text-blue);
}

/* Status dots */
.status-dot {
  display: inline-block;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  margin-left: 4px;
}

.status-dot-open {
  background: var(--color-blue);
}

.status-dot-dirty {
  background: var(--color-orange);
}

/* Warning icon */
.status-warning {
  color: var(--color-warning);
  margin-left: 4px;
}
```

## Part 6: Sync Index from Graph Operation

### The Problem

When building graphs, users reference IDs (node_ids, case_ids, parameter_ids, context_ids) that may not exist in indexes yet. This creates **orphan references** - the graph uses an ID but the index doesn't know about it.

### The Solution: Batch Index Sync

Add operation to:
1. Scan a graph file for all referenced IDs
2. Check which ones are NOT in their respective indexes
3. Present checklist modal to user
4. Batch create index entries for selected IDs

### UI Entry Points

#### Option A: Graph Context Menu
```
Right-click graph in Navigator
  → Sync Index from Graph...
```

#### Option B: Graph Editor Menu
```
Edit Menu
  ├─ Undo
  ├─ Redo
  ├─ ──────────
  ├─ Sync Index from Graph...  ← NEW
  └─ Preferences
```

#### Option C: Both (Recommended)

### Sync Modal Design

```
┌─────────────────────────────────────────────────┐
│ Sync Index from Graph: conversion-funnel.yaml  │
├─────────────────────────────────────────────────┤
│                                                 │
│ Found 8 IDs used in graph that are missing     │
│ from their respective indexes.                  │
│                                                 │
│ Select which to add to indexes:                │
│                                                 │
│ ┌─────────────────────────────────────────────┐ │
│ │ Parameters (3):                             │ │
│ │ ☑ abandoned-cart-rate      Used 2× in graph│ │
│ │ ☑ checkout-completion      Used 1× in graph│ │
│ │ ☐ legacy-metric           Used 0× in graph│ │
│ │                                             │ │
│ │ Contexts (1):                               │ │
│ │ ☑ mobile-web              Used 3× in graph│ │
│ │                                             │ │
│ │ Cases (2):                                  │ │
│ │ ☑ homepage-variant-test   Used 1× in graph│ │
│ │ ☐ old-experiment          Used 0× in graph│ │
│ │                                             │ │
│ │ Nodes (2):                                  │ │
│ │ ☑ abandoned-cart          Used 5× in graph│ │
│ │ ☑ help-center             Used 1× in graph│ │
│ └─────────────────────────────────────────────┘ │
│                                                 │
│ [Select All]  [Select None]  [Cancel]  [Add]   │
└─────────────────────────────────────────────────┘
```

### Implementation

```typescript
interface GraphIndexSync {
  graphId: string;
  missingEntries: {
    parameters: Array<{ id: string; usageCount: number }>;
    contexts: Array<{ id: string; usageCount: number }>;
    cases: Array<{ id: string; usageCount: number }>;
    nodes: Array<{ id: string; usageCount: number }>;
  };
}

async function scanGraphForMissingIndexEntries(
  graphId: string
): Promise<GraphIndexSync> {
  // 1. Load graph file
  const graphFile = await fileRegistry.getFile(graphId);
  const graphData = graphFile.data;
  
  // 2. Extract all referenced IDs
  const referencedIds = {
    parameters: new Set<string>(),
    contexts: new Set<string>(),
    cases: new Set<string>(),
    nodes: new Set<string>()
  };
  
  // Extract parameter IDs from edges
  for (const edge of graphData.edges || []) {
    if (edge.p?.parameter_id) {
      referencedIds.parameters.add(edge.p.parameter_id);
    }
    if (edge.cost_gbp?.parameter_id) {
      referencedIds.parameters.add(edge.cost_gbp.parameter_id);
    }
    if (edge.cost_time?.parameter_id) {
      referencedIds.parameters.add(edge.cost_time.parameter_id);
    }
    
    // Conditional probabilities
    for (const condP of edge.conditional_p || []) {
      if (condP.p?.parameter_id) {
        referencedIds.parameters.add(condP.p.parameter_id);
      }
    }
  }
  
  // Extract node IDs
  for (const node of graphData.nodes || []) {
    referencedIds.nodes.add(node.id);
    
    // Case IDs
    if (node.case?.id) {
      referencedIds.cases.add(node.case.id);
    }
  }
  
  // Extract context IDs (when implemented)
  // for (const context of graphData.contexts || []) {
  //   referencedIds.contexts.add(context.id);
  // }
  
  // 3. Load indexes
  const indexes = {
    parameters: await loadIndex('parameters'),
    contexts: await loadIndex('contexts'),
    cases: await loadIndex('cases'),
    nodes: await loadIndex('nodes')
  };
  
  // 4. Find missing entries
  const missing = {
    parameters: [],
    contexts: [],
    cases: [],
    nodes: []
  };
  
  for (const [type, ids] of Object.entries(referencedIds)) {
    const index = indexes[type];
    const existingIds = new Set(
      index?.items?.map((item: any) => item.id) || []
    );
    
    for (const id of ids) {
      if (!existingIds.has(id)) {
        // Count usage in graph
        const usageCount = countUsageInGraph(graphData, type, id);
        missing[type].push({ id, usageCount });
      }
    }
  }
  
  return {
    graphId,
    missingEntries: missing
  };
}

async function addToIndexes(
  selectedEntries: GraphIndexSync['missingEntries']
): Promise<void> {
  // For each type, update the index
  for (const [type, entries] of Object.entries(selectedEntries)) {
    if (entries.length === 0) continue;
    
    const indexFileId = `${type}-index`;
    const indexFile = await fileRegistry.getFile(indexFileId);
    const indexData = indexFile.data;
    
    // Add new entries
    for (const entry of entries) {
      indexData[type].push({
        id: entry.id,
        file_path: null,  // No file yet
        status: 'planned',
        created_at: new Date().toISOString(),
        usage_count: entry.usageCount,
        tags: [],
        notes: `Auto-added from graph scan`
      });
    }
    
    // Mark index as dirty
    await fileRegistry.updateFile(indexFileId, indexData);
  }
  
  // Refresh Navigator to show new entries
  await navigatorContext.refresh();
}
```

### Integration into Menu

```typescript
// In GraphEditorMenu.tsx or context menu
<MenuItem onClick={handleSyncIndex}>
  Sync Index from Graph...
</MenuItem>

async function handleSyncIndex() {
  const sync = await scanGraphForMissingIndexEntries(currentGraphId);
  
  if (getTotalMissing(sync.missingEntries) === 0) {
    showNotification('All IDs in graph are already in indexes');
    return;
  }
  
  const selected = await showSyncIndexModal(sync);
  
  if (selected) {
    await addToIndexes(selected);
    showNotification('Added entries to indexes');
  }
}
```

## Part 5: Implementation Phases

### Phase 1: Filter UI (MEDIUM PRIORITY)
**Goal**: Basic filtering works

1. Add filter bar component
2. Implement filter logic
3. Add search functionality
4. Persist filter state

**Deliverable**: Users can filter Navigator items

### Phase 2: Safe Repository Switching (HIGH PRIORITY)
**Goal**: Prevent data loss on repo/branch switch

1. Change repo/branch to buttons (not dropdowns)
2. Add switch modals with warnings
3. Implement dirty file checking
4. Add "Commit & Switch" option
5. Implement workspace flush and re-clone

**Deliverable**: Safe repo/branch switching

### Phase 3: Filter Presets (LOW PRIORITY)
**Goal**: Quick access to common filters

1. Add preset buttons
2. Implement preset logic
3. Allow custom presets (saved)

**Deliverable**: One-click common filters

### Phase 4: Sync Index from Graph (MEDIUM PRIORITY)
**Goal**: Keep indexes in sync with graph usage

1. Implement ID extraction from graphs
2. Implement missing entry detection
3. Add "Sync Index from Graph" menu item
4. Create SyncIndexModal component
5. Batch add entries to indexes

**Deliverable**: Easy way to sync indexes from graph references

###Phase 5: Advanced Features (FUTURE)
1. Workspace snapshots for undo
2. Smart branch switching (merge local changes)
3. Filter by file type
4. Saved filter configurations
5. Auto-detect orphan references on file open

## Part 6: Component Structure

```typescript
// NavigatorHeader.tsx
export function NavigatorHeader() {
  return (
    <div className="navigator-header">
      {/* Repository & Branch */}
      <RepositorySelector 
        value={state.selectedRepo}
        onChange={handleSwitchRepository}
      />
      <BranchSelector
        value={state.selectedBranch}
        onChange={handleSwitchBranch}
      />
      
      {/* Filters */}
      <NavigatorFilters
        filters={filters}
        onChange={setFilters}
      />
    </div>
  );
}

// NavigatorFilters.tsx (NEW)
export function NavigatorFilters({ filters, onChange }) {
  return (
    <div className="navigator-filters">
      {/* Mode toggle */}
      <ToggleGroup value={filters.mode} onChange={...}>
        <Toggle value="all">All</Toggle>
        <Toggle value="files-only">Files Only</Toggle>
      </ToggleGroup>
      
      {/* Status checkboxes */}
      <div className="filter-checks">
        <Checkbox 
          checked={filters.showLocal}
          onChange={(checked) => onChange({ ...filters, showLocal: checked })}
        >
          Local
        </Checkbox>
        <Checkbox 
          checked={filters.showDirty}
          onChange={(checked) => onChange({ ...filters, showDirty: checked })}
        >
          Dirty
        </Checkbox>
        <Checkbox 
          checked={filters.showOpen}
          onChange={(checked) => onChange({ ...filters, showOpen: checked })}
        >
          Open
        </Checkbox>
      </div>
      
      {/* Search */}
      <SearchInput
        value={filters.searchQuery}
        onChange={(query) => onChange({ ...filters, searchQuery: query })}
        placeholder="Search..."
      />
    </div>
  );
}

// SwitchRepositoryModal.tsx (NEW)
export function SwitchRepositoryModal({ 
  currentRepo, 
  dirtyFiles, 
  availableRepos,
  onConfirm,
  onCancel 
}) {
  // Implementation as designed above
}

// SwitchBranchModal.tsx (NEW)  
export function SwitchBranchModal({ 
  currentBranch, 
  dirtyFiles, 
  availableBranches,
  onConfirm,
  onCancel 
}) {
  // Implementation as designed above
}
```

## Summary

### Key Design Principles

1. **Filters are additive** - each filter narrows the view
2. **Search is global** - searches across all metadata
3. **Presets for convenience** - one-click common views
4. **State persists** - filters remembered across sessions
5. **Repository/branch switching is guarded** - prevent data loss
6. **Clear warnings** - show what will be lost before switching
7. **Safe options** - offer "Commit & Switch" as default
8. **No casual toggles** - major operations require modals

### User Flows

#### Filter to Dirty Files
```
User checks "Dirty" → Navigator shows only dirty files
User unchecks → Shows all again
```

#### Switch Repository with Changes
```
User clicks "Switch Repo..." 
  → Modal shows warning + dirty file list
  → User clicks "Commit & Switch"
  → Changes committed
  → Workspace flushed
  → New repo cloned
  → Navigator refreshed
```

#### Search for File
```
User types "checkout" in search
  → Navigator shows only matching items
  → Highlights across all categories
  → Clears with empty search
```

---

**Document Version**: 1.0  
**Date**: October 29, 2025  
**Status**: Design Document  
**Priority**: MEDIUM (Filters), HIGH (Safe Switching)

