# File Lifecycle Management - Redesign Proposal

## Current Problems

1. **Inconsistent state tracking**: Files exist in 3 places (IndexedDB, in-memory FileRegistry, Navigator localItems) with no clear source of truth
2. **Missing from memory**: Files in IndexedDB aren't always loaded into FileRegistry's in-memory cache
3. **Confusing lifecycle**: Unclear when files are created/deleted/persisted
4. **No clear warnings**: Users lose work because we don't warn consistently
5. **Delete is broken**: Can't delete files that aren't in memory
6. **Local vs committed confusion**: No clear distinction between "new unsaved file" vs "uncommitted changes to existing file"

---

## File Type Taxonomy

Before we dive into architecture, let's categorize the different file types:

### 1. Registry Files (Index Files)
- `parameter-index.yaml`, `case-index.yaml`, `node-index.yaml`, etc.
- **Purpose**: Catalog of available objects in the repository
- **Lifecycle**: Auto-managed, updated on CRUD operations
- **Committable**: Yes (part of repo structure)
- **Location**: Repo root

### 2. Var Files (Variable Definition Files)
- `parameters/*.yaml`, `cases/*.yaml`, `nodes/*.yaml`, `contexts/*.yaml`, `events/*.yaml`
- **Purpose**: Reusable data objects (probability distributions, case schedules, node metadata)
- **Lifecycle**: User-managed
- **Committable**: Yes
- **Can be**: Local (uncommitted) OR in repo (committed)
- **Location**: `{type}s/` subdirectory
- Parameters also have sub-type 

### 3. Graph Files
- `graphs/*.json`
- **Purpose**: Graph topology and structure
- **Lifecycle**: User-managed
- **Committable**: Yes
- **Can be**: Local (uncommitted) OR in repo (committed)
- **Location**: `graphs/` subdirectory

### 4. System Files (Non-committable)
- `credentials.yaml` (Git credentials, API keys)
- `connections.yaml` (future: Amplitude, Sheets, API connection configs)
- **Purpose**: User-specific configuration
- **Lifecycle**: User-managed, but **NEVER committed to repo**
- **Committable**: NO (excluded from Git)
- **Can be**: Local only
- **Location**: Workspace root or special system directory

---

## Proposed Architecture

### Core Principle: Single Source of Truth

**IndexedDB is the workspace.** The in-memory FileRegistry is just a cache. **Git is the shared repository.**

```
                    ┌─────────────────────────────────────┐
                    │         Git Repository              │
                    │      (Shared, Multi-branch)         │
                    │                                     │
                    │  - Graphs (committed)               │
                    │  - Var files (committed)            │
                    │  - Registry files (committed)       │
                    │  - History & branches               │
                    │                                     │
                    │  System files NOT in Git:           │
                    │    ✗ credentials.yaml               │
                    │    ✗ connections.yaml               │
                    └─────────────────────────────────────┘
                              ▲           ▼
                              │           │
                    Clone on init    Commit/Push
                         Pull           (user action)
                              │           │
                              ▼           ▲
┌─────────────────────────────────────────────────────────┐
│                     IndexedDB                           │
│              (Local Workspace - Single Source of Truth) │
│                                                          │
│  - Cloned files (from Git)                              │
│  - Local files (not yet committed)                      │
│  - System files (never committed)                       │
│  - File state (dirty, lifecycle, etc.)                  │
│  - Survives app restarts                                │
│                                                          │
│  File Categories:                                       │
│    • Registry files  (auto-managed, committable)        │
│    • Var files       (user-managed, committable)        │
│    • Graph files     (user-managed, committable)        │
│    • System files    (user-managed, NOT committable)    │
└─────────────────────────────────────────────────────────┘
                    ▲                    ▼
                    │                    │
                    │    Read/Write      │
                    │                    │
          ┌─────────┴────────────────────┴──────────┐
          │       FileRegistry (Memory)             │
          │         (Hot Cache Only)                │
          │                                         │
          │  - Recently accessed files              │
          │  - Lazy loaded from IndexedDB           │
          │  - Can be evicted/reloaded              │
          │  - Notifies listeners on changes        │
          └─────────────────────────────────────────┘
                            ▲
                            │
                    ┌───────┴────────┐
                    │   Navigator    │
                    │   (View Layer) │
                    │                │
                    │  Shows:        │
                    │  • Graphs      │
                    │  • Var files   │
                    │                │
                    │  Hidden:       │
                    │  • Registry    │
                    │  • System      │
                    └────────────────┘
```

### Data Flow Examples

**Clone Repository (First Use)**
```
Git Repo → API call → Download files → IndexedDB → FileRegistry (on demand)
```

**Create New File**
```
User action → Create in IndexedDB → Load into FileRegistry → Show in Navigator
              (uncommitted-new state)
```

**Edit File**
```
User edits → Update FileRegistry → Persist to IndexedDB → Mark dirty
             (Show indicator in Navigator)
```

**Commit Changes**
```
User commits → Gather dirty files from IndexedDB → Git API (write) 
            → Update IndexedDB (mark clean, add commitSha)
            → Refresh Navigator
```

**Pull Latest**
```
Git API (read) → Download changed files → Update IndexedDB 
               → Evict from FileRegistry → Refresh Navigator
               (Conflict resolution if local changes exist)
```

**Delete File (Committed)**
```
User deletes → Mark as deleted-pending in IndexedDB 
            → On commit: Git API (delete) → Remove from IndexedDB
            → Refresh Navigator
```

**Delete File (Uncommitted)**
```
User deletes → Remove from IndexedDB → Remove from FileRegistry 
            → Refresh Navigator
            (No Git interaction needed)
```

---

## File States & Lifecycle

### 1. File States (Finite State Machine)

```typescript
type FileLifecycleState = 
  | 'uncommitted-new'      // New file, never committed to repo
  | 'uncommitted-modified' // Cloned from repo, has local changes
  | 'committed-clean'      // In repo, no local changes
  | 'committed-dirty'      // In repo, has local changes since last commit
  | 'deleted-pending'      // Marked for deletion, not yet committed
```

### 2. File Properties

```typescript
type FileCategory = 'registry' | 'var' | 'graph' | 'system';

type ObjectType = 
  // Registry files
  | 'parameter-index' | 'case-index' | 'node-index' | 'context-index' | 'event-index'
  // Var files
  | 'parameter' | 'case' | 'node' | 'context' | 'event'
  // Graph files
  | 'graph'
  // System files
  | 'credentials' | 'connections';

interface FileState {
  fileId: string;
  type: ObjectType;
  category: FileCategory;   // Derived from type
  data: any;
  
  // Lifecycle
  lifecycleState: FileLifecycleState;
  
  // Provenance
  source: {
    repository: string;     // 'local' or repo name
    branch: string;
    path: string;
    commitSha?: string;     // If cloned from repo
  };
  
  // Committability
  isCommittable: boolean;   // false for system files, true for others
  
  // Dirty tracking
  isDirty: boolean;         // Has unsaved changes in editor
  originalData: any;        // For dirty comparison
  
  // Timestamps
  createdAt: number;
  modifiedAt: number;
  lastCommitAt?: number;
  
  // View tracking
  viewTabs: string[];       // Currently open tabs
}

// Helper to determine file category
function getFileCategory(type: ObjectType): FileCategory {
  if (type.endsWith('-index')) return 'registry';
  if (type === 'credentials' || type === 'connections') return 'system';
  if (type === 'graph') return 'graph';
  return 'var';
}

// Helper to determine if file is committable
function isFileCommittable(category: FileCategory): boolean {
  return category !== 'system';
}
```

---

## Operations & Warnings

### Create New File

```typescript
async function createFile(name: string, type: ObjectType): Promise<FileState> {
  // 1. Create in IndexedDB
  const file = {
    fileId: `${type}-${name}`,
    lifecycleState: 'uncommitted-new',
    isDirty: false,  // New files start clean
    source: { repository: 'local', branch: 'main', path: `${type}s/${name}.yaml` },
    createdAt: Date.now()
  };
  
  await db.files.add(file);
  
  // 2. Load into memory cache
  fileRegistry.loadFromDb(file.fileId);
  
  // 3. Add to Navigator
  navigator.refresh();
  
  return file;
}
```

**Warnings**: None (file is clean on creation)

---

### Open File

```typescript
async function openFile(item: RepositoryItem): Promise<void> {
  const fileId = `${item.type}-${item.id}`;
  
  // 1. Check memory cache
  let file = fileRegistry.get(fileId);
  
  // 2. If not in cache, load from IndexedDB
  if (!file) {
    file = await db.files.get(fileId);
    if (file) {
      fileRegistry.set(fileId, file);
    }
  }
  
  // 3. If not in IndexedDB either, this is first access - clone from repo or create
  if (!file) {
    file = await loadFileFromRepo(item);
    await db.files.add(file);
    fileRegistry.set(fileId, file);
  }
  
  // 4. Create tab
  await tabs.create(fileId);
}
```

**Warnings**: None

---

### Close Tab (Last Tab for File)

```typescript
async function closeTab(tabId: string): Promise<void> {
  const tab = tabs.get(tabId);
  const file = await fileRegistry.getOrLoad(tab.fileId);
  
  const isLastTab = file.viewTabs.length === 1;
  
  // No warning - just close
  // File stays in workspace with dirty state preserved
  
  // Close tab
  file.viewTabs = file.viewTabs.filter(id => id !== tabId);
  await db.files.put(file);
  
  // File stays in workspace (IndexedDB + Navigator)
  // Dirty indicator remains visible in Navigator
  
  toast.info(`Closed ${file.name || file.fileId}${file.isDirty ? ' (unsaved changes preserved)' : ''}`);
}
```

**Warnings**: No. Toast only.

**Rationale**: 
- Files persist in workspace, so no data loss
- Dirty state is preserved and visible in Navigator
- User can reopen and continue editing or use "Discard changes" explicitly
- Less interruption to workflow

---

### Discard Changes (Revert File)

```typescript
async function discardChanges(fileId: string): Promise<void> {
  const file = await fileRegistry.getOrLoad(fileId);
  if (!file) throw new Error('File not found');
  
  // Confirm discard
  const confirmed = await showDialog({
    title: 'Discard changes',
    message: `Discard all unsaved changes to "${file.name || fileId}"?`,
    confirmLabel: 'Discard',
    cancelLabel: 'Cancel',
    confirmVariant: 'danger'
  });
  
  if (!confirmed) return;
  
  // Revert to original data
  file.data = structuredClone(file.originalData);
  file.isDirty = false;
  
  // Update cache and persist
  fileRegistry.cache.set(fileId, file);
  await db.files.put(file);
  
  // Notify listeners (to refresh UI)
  fileRegistry.notifyListeners(fileId, file);
  
  // Emit dirty state change
  window.dispatchEvent(new CustomEvent('dagnet:fileDirtyChanged', { 
    detail: { fileId, isDirty: false } 
  }));
  
  toast.success('Changes discarded');
}
```

**Warnings**: Yes - confirm discard

**Available from**:
- File menu (when file is dirty)
- Right-click tab context menu (when file is dirty)
- Right-click Navigator item (when file is dirty)

---

### Delete File

```typescript
async function deleteFile(fileId: string): Promise<void> {
  // 1. Load file (from memory or IDB)
  const file = await fileRegistry.getOrLoad(fileId);
  if (!file) throw new Error('File not found');
  
  // 2. Check for open tabs
  if (file.viewTabs.length > 0) {
    const confirmed = await showDialog({
      title: 'File has open tabs',
      message: `Close ${file.viewTabs.length} tab(s) and delete?`,
      confirmLabel: 'Close & Delete',
      confirmVariant: 'danger'
    });
    
    if (!confirmed) return;
    await closeAllTabs(fileId);
  }
  
  // 3. Warn about unsaved changes
  if (file.isDirty) {
    const confirmed = await showDialog({
      title: 'Unsaved changes',
      message: 'File has unsaved changes. Delete anyway?',
      confirmLabel: 'Delete',
      confirmVariant: 'danger'
    });
    
    if (!confirmed) return;
  }
  
  // 4. Different behavior based on lifecycle state
  switch (file.lifecycleState) {
    case 'uncommitted-new':
      // Just delete from workspace
      await db.files.delete(fileId);
      fileRegistry.remove(fileId);
      navigator.removeLocal(fileId);
      break;
      
    case 'committed-clean':
    case 'committed-dirty':
      // Confirm deletion from repo
      const confirmed = await showDialog({
        title: 'Delete from repository',
        message: 'This will delete the file from the repository on next commit.',
        confirmLabel: 'Delete',
        confirmVariant: 'danger'
      });
      
      if (!confirmed) return;
      
      // Mark for deletion (will be deleted on next commit)
      file.lifecycleState = 'deleted-pending';
      await db.files.put(file);
      navigator.markDeleted(fileId);
      break;
  }
}
```

**Warnings**: 
- If file has open tabs
- If file is dirty
- If file is in repository (will be deleted on commit)

---

### Commit Changes

```typescript
async function commitChanges(message: string): Promise<void> {
  const dirtyFiles = await db.files
    .where('lifecycleState')
    .anyOf(['uncommitted-new', 'uncommitted-modified', 'committed-dirty', 'deleted-pending'])
    .toArray();
  
  // Filter out non-committable files (system files)
  const committableFiles = dirtyFiles.filter(f => f.isCommittable);
  const systemFiles = dirtyFiles.filter(f => !f.isCommittable);
  
  if (systemFiles.length > 0) {
    console.log(`Skipping ${systemFiles.length} system files (not committable):`, 
      systemFiles.map(f => f.fileId));
  }
  
  if (committableFiles.length === 0) {
    toast.info('No changes to commit');
    return;
  }
  
  // Show commit dialog with list of changes
  const confirmed = await showCommitDialog({
    files: committableFiles,
    message,
    warning: systemFiles.length > 0 
      ? `Note: ${systemFiles.length} system file(s) will not be committed` 
      : undefined
  });
  
  if (!confirmed) return;
  
  // Commit to Git (only committable files)
  for (const file of committableFiles) {
    if (file.lifecycleState === 'deleted-pending') {
      await git.deleteFile(file.source.path);
      await db.files.delete(file.fileId);
      fileRegistry.remove(file.fileId);
    } else {
      await git.writeFile(file.source.path, file.data);
      file.lifecycleState = 'committed-clean';
      file.isDirty = false;
      file.lastCommitAt = Date.now();
      await db.files.put(file);
    }
  }
  
  await git.commit(message);
  await git.push();
}
```

**Warnings**: 
- If system files are dirty but can't be committed
- None otherwise (user is explicitly committing)

---

## FileRegistry Refactor

### Core Methods

```typescript
class FileRegistry {
  private cache = new Map<string, FileState>();
  
  /**
   * Get file - loads from IDB if not in cache
   */
  async getOrLoad(fileId: string): Promise<FileState | null> {
    // Check cache
    if (this.cache.has(fileId)) {
      return this.cache.get(fileId)!;
    }
    
    // Load from IndexedDB
    const file = await db.files.get(fileId);
    if (file) {
      this.cache.set(fileId, file);
      return file;
    }
    
    return null;
  }
  
  /**
   * Update file - writes to both cache and IDB
   */
  async update(fileId: string, data: any): Promise<void> {
    const file = await this.getOrLoad(fileId);
    if (!file) throw new Error('File not found');
    
    file.data = data;
    file.modifiedAt = Date.now();
    file.isDirty = !deepEqual(data, file.originalData);
    
    // Update cache
    this.cache.set(fileId, file);
    
    // Persist to IDB
    await db.files.put(file);
    
    // Notify listeners
    this.notifyListeners(fileId, file);
  }
  
  /**
   * Delete file - removes from both cache and IDB
   */
  async delete(fileId: string): Promise<void> {
    // Remove from cache
    this.cache.delete(fileId);
    
    // Remove from IDB
    await db.files.delete(fileId);
    
    // Notify listeners
    this.notifyListeners(fileId, null);
  }
  
  /**
   * Evict from cache (but keep in IDB)
   */
  evict(fileId: string): void {
    this.cache.delete(fileId);
  }
}
```

---

## Navigator Integration

```typescript
// Navigator shows different file types in different sections
async function getNavigatorItems(): Promise<RepositoryItem[]> {
  const allFiles = await db.files.toArray();
  
  return allFiles
    .filter(f => {
      // Don't show deleted files
      if (f.lifecycleState === 'deleted-pending') return false;
      
      // Don't show system files in main navigator
      // (they get their own settings area)
      if (f.category === 'system') return false;
      
      // Don't show registry files in main navigator
      // (they're auto-managed, users don't interact directly)
      if (f.category === 'registry') return false;
      
      return true;
    })
    .map(f => ({
      id: f.fileId.split('-').slice(1).join('-'),
      type: f.type,
      category: f.category,
      path: f.source.path,
      isLocal: f.lifecycleState === 'uncommitted-new',
      isDirty: f.isDirty || f.lifecycleState !== 'committed-clean',
      isOpen: f.viewTabs.length > 0,
      isCommittable: f.isCommittable
    }));
}

// System files get their own UI (Settings panel)
async function getSystemFiles(): Promise<FileState[]> {
  return await db.files
    .where('category')
    .equals('system')
    .toArray();
}

// Navigator sections:
// - Graphs (graphs)
// - Parameters (var files - parameters)
// - Cases (var files - cases)
// - Nodes (var files - nodes)
// - Contexts (var files - contexts)
// - Events (var files - events)
// 
// Settings panel:
// - Credentials (system files)
// - Connections (system files)
```

---

## Testing Strategy

### Unit Tests

```typescript
describe('FileRegistry', () => {
  describe('getOrLoad', () => {
    it('returns cached file if in memory');
    it('loads from IndexedDB if not in cache');
    it('returns null if file does not exist');
  });
  
  describe('update', () => {
    it('updates cache');
    it('persists to IndexedDB');
    it('marks as dirty if data changed');
    it('notifies listeners');
  });
  
  describe('delete', () => {
    it('removes from cache');
    it('removes from IndexedDB');
    it('notifies listeners');
  });
});

describe('File Lifecycle', () => {
  describe('createFile', () => {
    it('creates file in IDB with uncommitted-new state');
    it('adds to Navigator');
    it('does not warn on creation');
  });
  
  describe('closeTab', () => {
    it('closes tab without warning');
    it('preserves dirty state in workspace');
    it('keeps file in workspace after closing');
    it('shows dirty indicator in Navigator');
  });
  
  describe('discardChanges', () => {
    it('warns before discarding');
    it('reverts to originalData');
    it('clears dirty flag');
    it('notifies listeners to refresh UI');
    it('shows success toast');
  });
  
  describe('deleteFile', () => {
    it('warns if file has open tabs');
    it('warns if file is dirty');
    it('warns if file is in repository');
    it('loads from IDB if not in cache');
    it('marks committed files as deleted-pending');
    it('removes uncommitted-new files immediately');
  });
});
```

### Integration Tests

```typescript
describe('File Lifecycle Integration', () => {
  it('creates file -> edits -> closes tab with save -> reopens -> file is saved');
  it('creates file -> edits -> closes tab with discard -> reopens -> file is clean');
  it('creates file -> edits -> deletes -> file is gone');
  it('clones file -> edits -> commits -> file is in repo');
  it('clones file -> edits -> deletes -> commits -> file is deleted from repo');
  it('creates file -> closes app -> reopens -> file is still there');
  it('creates file -> edits -> closes app -> reopens -> file is dirty');
});
```

### E2E Tests

```typescript
describe('User Workflows', () => {
  it('User creates graph, edits it, saves, closes, reopens - sees saved graph');
  it('User creates graph, edits it, closes without saving - file stays dirty in Navigator');
  it('User creates graph, edits it, closes, reopens - can continue editing');
  it('User creates graph, edits it, discards changes - reverts to clean state');
  it('User creates graph, deletes it - gets warned if dirty, then deleted');
  it('User clones repo, edits file, commits - file is updated in repo');
  it('User creates multiple files, commits all at once - all files in repo');
  it('User edits file, closes all tabs, file stays in Navigator with dirty indicator');
  it('User edits file, uses Discard Changes from Navigator - file becomes clean');
});
```

---

## Migration Plan

1. **Phase 1**: Add `lifecycleState` and `category` to FileState schema
   - Migration script to add fields to existing files in IndexedDB
   - Add helper functions (`getFileCategory`, `isFileCommittable`)
   
2. **Phase 2**: Refactor FileRegistry with `getOrLoad()` pattern
   - Implement lazy loading from IndexedDB
   - Add cache eviction logic
   - Ensure all operations go through FileRegistry
   
3. **Phase 3**: Update all file operations (create, open, close, delete) to use new pattern
   - Create: Set proper lifecycleState and category
   - Open: Always use getOrLoad (memory or IDB)
   - Close: Check dirty state, show warnings
   - Delete: Load from IDB if needed, different logic per lifecycleState
   
4. **Phase 4**: Add comprehensive warnings
   - Close dirty tab warning
   - Delete uncommitted file warning
   - Commit with system files warning
   
5. **Phase 5**: Refactor commit/pull operations
   - Filter committable files only
   - Handle system files separately
   - Proper conflict resolution on pull
   
6. **Phase 6**: Write tests (unit, integration, E2E)
   
7. **Phase 7**: Remove old Navigator localItems tracking (use IDB as source of truth)

---

## Benefits

1. ✅ **Single source of truth**: IndexedDB
2. ✅ **Predictable lifecycle**: Clear state machine
3. ✅ **No lost work**: Comprehensive warnings
4. ✅ **Reliable delete**: Always works (loads from IDB if needed)
5. ✅ **Testable**: Clear interfaces and behaviors
6. ✅ **Performant**: Memory cache for hot files, lazy loading for cold
7. ✅ **Survives restarts**: Everything in IndexedDB

---

## File Type Specific Behavior

### Registry Files
- **Creation**: Auto-created on first access, never manually created
- **Updates**: Auto-updated when var files are created/deleted
- **Deletion**: Never deleted manually
- **Commit**: Always committed with var files
- **Warnings**: None (invisible to user)

### Var Files (Parameters, Cases, Nodes, etc.)
- **Creation**: User creates via UI (Navigator context menu, selector "+New")
- **Updates**: User edits in properties panel
- **Deletion**: User deletes via context menu (with confirmation)
- **Commit**: User commits to repo
- **Warnings**: Yes (dirty on close, delete uncommitted, etc.)
- **Can reference**: Other var files (e.g., edge references parameter)

### Graph Files
- **Creation**: User creates via File > New Graph, or "Show in new graph" from selection
- **Updates**: User edits graph topology
- **Deletion**: User deletes via context menu (with confirmation)
- **Commit**: User commits to repo
- **Warnings**: Yes (dirty on close, delete uncommitted, etc.)
- **Can reference**: Var files (nodes reference node files, edges reference parameters)

### System Files
- **Creation**: Auto-created on first use
- **Updates**: User edits in Settings panel
- **Deletion**: Never deleted (can be cleared/reset)
- **Commit**: NEVER committed to repo (excluded from Git)
- **Warnings**: Different warnings (e.g., "Credentials will not be backed up")
- **Special handling**: 
  - Encrypted storage for sensitive data
  - Never shown in Navigator
  - Special UI in Settings panel

---

## Open Questions

1. **Cache eviction policy**: When do we evict files from memory? LRU? Fixed size?
   
2. **Conflict resolution**: What happens if file changes in repo while user has local changes?
   - Options:
     - Show 3-way merge UI
     - Force user to choose (keep local or take remote)
     - Auto-merge if possible, conflict UI otherwise
     - Use Git SHA to detect conflicts on pull
   
3. **Offline mode**: How do we handle Git operations when offline?
   - Queue commits for later?
   - Show "Offline" indicator?
   - Allow full editing with warning?
   
4. **File size limits**: Do we need special handling for large graphs?
   - Stream large files instead of loading entirely?
   - Warn on graphs > X nodes?
   
5. **System file encryption**: Should credentials/connections be encrypted in IndexedDB?
   - Probably yes for credentials
   - How to manage encryption keys?
   
6. **Connections config**: What's the schema for connections.yaml (Amplitude, Sheets, APIs)?
   - Similar to credentials structure?
   - Per-data-source configuration?
   
7. **Branch strategy**: How do we handle multiple branches?
   - Can user work on multiple branches simultaneously?
   - Do we need separate workspaces per branch?
   - Or single workspace that switches branches (like Git checkout)?
   
8. **Pull conflicts**: When pulling latest from Git:
   - What if user has uncommitted changes?
   - Do we force commit first?
   - Or allow dirty workspace and handle conflicts?

---

## Decision Required

**Should we implement this redesign now, or wait until after MVP?**

- **Pros of doing now**: Fixes fundamental bugs, prevents data loss, makes system reliable
- **Cons of doing now**: Large refactor, might introduce new bugs, delays other features

**Recommendation**: Do Phase 1-3 now (core refactor), Phase 4-6 in next sprint.

