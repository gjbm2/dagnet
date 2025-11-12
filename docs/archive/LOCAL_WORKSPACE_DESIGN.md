# Local Workspace Persistence Design

## Overview

This document outlines the redesign of file state management to support a proper local workspace model where files persist independently of tabs.

## Core Principles

1. **Local workspace mirrors remote repo** - IndexedDB contains cloned repo state
2. **Files persist independently of tabs** - closing tabs doesn't delete files
3. **Dirty tracking survives tab closure** - files can be dirty without open tabs
4. **Index files auto-managed** - updated automatically on param CRUD operations
5. **Visual state indicators** - clear UI showing open/dirty/local states

## Architecture Changes

### 1. File State Model

#### Current (Problematic)
```
FileState exists in memory only while tab open
→ Tab closes → FileState deleted from registry & IDB
```

#### Proposed (Correct)
```
FileState exists in IDB for ALL repo files
→ Tab references FileState
→ Tab closes → FileState remains
→ Only deleted on explicit user action or repo sync
```

### 2. File Lifecycle States

```typescript
interface FileState {
  fileId: string;
  type: ObjectType;
  data: any;
  
  // Source tracking
  source: {
    repository: string;
    path: string;
    branch: string;
    sha?: string;  // Git SHA for conflict detection
  };
  
  // State flags
  isDirty: boolean;        // Has unsaved changes
  isLocal: boolean;        // Doesn't exist in remote repo
  isLoaded: boolean;       // Content loaded into memory
  
  // View tracking
  viewTabs: string[];      // Tabs currently viewing this file
  
  // Timestamps
  lastModified: number;
  lastSynced?: number;     // Last sync with remote
  originalData: any;       // For dirty comparison
}
```

### 3. Initialization Flow

```
App Startup
├─ Load credentials
├─ Initialize workspace
│  ├─ Check if local workspace exists (IDB)
│  ├─ If not: Clone repo to IDB
│  │  ├─ Fetch file tree from Git
│  │  ├─ Load index files (parameters-index, contexts-index, etc.)
│  │  ├─ Create FileState for each
│  │  └─ Mark as clean, not local
│  └─ If exists: Use cached local workspace
│     ├─ Load FileStates from IDB
│     └─ Optionally check for remote updates
├─ Load Navigator (shows all files from workspace)
└─ Restore open tabs (references to FileStates)
```

### 4. Index File Management

#### Index Files as First-Class Citizens

```yaml
# Index files are special FileStates
fileId: "parameters-index"
type: "parameter-index"  # New type
path: "parameters-index.yaml"
isIndexFile: true
```

#### Auto-Update on CRUD

```typescript
// When creating new parameter
async createParameter(name: string, data: any) {
  // 1. Create parameter file
  const paramFile = await fileRegistry.createFile(
    `parameter-${name}`,
    'parameter',
    data
  );
  
  // 2. Update index file
  const indexFile = await fileRegistry.getFile('parameters-index');
  const indexData = indexFile.data;
  indexData.parameters.push({
    id: name,
    file_path: `parameters/${name}.yaml`,
    status: 'active',
    created_at: new Date().toISOString(),
    usage_count: 0
  });
  
  // 3. Mark index as dirty
  await fileRegistry.updateFile('parameters-index', indexData);
  // → This marks index as dirty, will be committed with param
}

// Similar for delete, update
```

### 5. Navigator UI Enhancements

#### Visual Indicators

```
Parameters                            🔍  ← Index file icon (click to open)
├─ 📄 conversion-rate-baseline            Blue dot: open tab
├─ 📄 email-signup-rate            ●      Orange dot: dirty
├─ 📄 checkout-completion          ●      Both: open AND dirty
└─ 📄 local-param              (local)    Italic: not in remote

Contexts                              🔍  ●  ← Index dirty
├─ 📄 user-segment
└─ 📄 time-window

Cases                                 🔍
├─ 📄 homepage-test               ●
└─ 📄 checkout-variant

Nodes                                 🔍  ●  ← NEW: Nodes index
├─ 📄 homepage
├─ 📄 checkout-complete
└─ 📄 abandoned-cart          (planned)   ← In index, no file yet
```

#### Status Badge Component

```typescript
interface FileStatusBadge {
  isOpen: boolean;      // Has open tab
  isDirty: boolean;     // Has unsaved changes
  isLocal: boolean;     // Not in remote repo
  isPlanned: boolean;   // In index, no file yet
}

// Visual mapping
isOpen → blue dot (•)
isDirty → orange dot (•)
isLocal → italic text
isPlanned → gray text + (planned) badge
```

### 6. Index File UI

#### Category Header with Index Icon

```tsx
<CategoryHeader>
  <span>Parameters</span>
  <IndexFileIcon
    fileId="parameters-index"
    isDirty={indexFile?.isDirty}
    isOpen={hasOpenTab('parameters-index')}
    onClick={() => openIndexFile('parameters-index')}
  />
</CategoryHeader>
```

#### Index File Tab

When opened, shows form editor with index schema:

```yaml
# parameters-index-schema.yaml
type: object
properties:
  version:
    type: string
  parameters:
    type: array
    items:
      type: object
      properties:
        id: { type: string }
        file_path: { type: string }
        status: { enum: [active, planned, deprecated] }
        created_at: { type: string }
        usage_count: { type: integer }
        # ... etc
```

Users can manually edit index, or it updates automatically.

### 7. FileRegistry Refactor

#### Key Changes

```typescript
class FileRegistry {
  // Remove file deletion on tab close
  async removeViewTab(fileId: string, tabId: string): Promise<void> {
    const file = this.files.get(fileId);
    if (!file) return;

    file.viewTabs = file.viewTabs.filter(id => id !== tabId);
    
    // NEVER delete file - just update view tabs
    await db.files.put(file);
    
    console.log(`FileRegistry: Removed tab ${tabId} from ${fileId}, file persists`);
  }
  
  // New: Explicit file deletion (user action only)
  async deleteFile(fileId: string): Promise<void> {
    // Check for open tabs
    const file = this.files.get(fileId);
    if (file?.viewTabs.length > 0) {
      throw new Error('Cannot delete file with open tabs');
    }
    
    // Check if dirty
    if (file?.isDirty) {
      throw new Error('Cannot delete dirty file');
    }
    
    // Delete from registry and IDB
    this.files.delete(fileId);
    this.listeners.delete(fileId);
    await db.files.delete(fileId);
    
    // Update index file
    await this.updateIndexOnDelete(fileId);
  }
  
  // New: Index file management
  async updateIndexOnCreate(type: ObjectType, id: string, metadata: any): Promise<void> {
    const indexFileId = `${type}s-index`;
    const indexFile = await this.getOrCreateFile(
      indexFileId,
      `${type}-index` as ObjectType,
      { repository: 'local', path: `${type}s-index.yaml`, branch: 'main' },
      { version: '1.0.0', [type + 's']: [] }
    );
    
    const indexData = indexFile.data;
    const items = indexData[type + 's'] || [];
    
    // Add new entry
    items.push({
      id,
      file_path: `${type}s/${id}.yaml`,
      status: 'active',
      created_at: new Date().toISOString(),
      usage_count: 0,
      ...metadata
    });
    
    // Update index
    await this.updateFile(indexFileId, {
      ...indexData,
      [type + 's']: items
    });
  }
  
  async updateIndexOnDelete(fileId: string): Promise<void> {
    // Extract type and id from fileId
    const [type, id] = fileId.split('-', 2);
    const indexFileId = `${type}s-index`;
    
    const indexFile = this.files.get(indexFileId);
    if (!indexFile) return;
    
    const indexData = indexFile.data;
    const items = indexData[type + 's'] || [];
    
    // Remove entry
    const filtered = items.filter((item: any) => item.id !== id);
    
    // Update index
    await this.updateFile(indexFileId, {
      ...indexData,
      [type + 's']: filtered
    });
  }
}
```

### 8. Repository Operations

#### New Menu: Repository

```
Repository
├─ Switch Repository...      # Change to different configured repo
├─ ───────────────
├─ Clone Repository...       # Initial clone to local workspace
├─ Pull Latest               # Fetch updates from remote
├─ Push Changes              # Push all dirty files
├─ ───────────────
├─ Refresh Status            # Check for remote changes
├─ Show Dirty Files          # List all dirty files
└─ Discard Local Changes...  # Revert to remote state
```

**Note**: "Switch Repository" at top of menu - major operation that affects workspace. Repositories are configured in File > Configuration.

#### Pull Operation

```typescript
async pullRepository(): Promise<void> {
  // 1. Check for dirty files
  const dirtyFiles = Array.from(fileRegistry.getAll())
    .filter(f => f.isDirty);
  
  if (dirtyFiles.length > 0) {
    const confirmed = await showConfirm({
      title: 'Uncommitted Changes',
      message: `You have ${dirtyFiles.length} files with unsaved changes. Pull anyway?`,
      details: dirtyFiles.map(f => f.source.path).join('\n')
    });
    
    if (!confirmed) return;
  }
  
  // 2. Fetch file tree from Git
  const remoteFiles = await gitService.listFiles();
  
  // 3. For each file, check if local version needs update
  for (const remoteFile of remoteFiles) {
    const localFile = fileRegistry.getFile(remoteFile.id);
    
    if (!localFile) {
      // New file in remote, add to local
      await fileRegistry.createFromRemote(remoteFile);
    } else if (localFile.source.sha !== remoteFile.sha) {
      // Changed in remote
      if (localFile.isDirty) {
        // CONFLICT - mark for user resolution
        console.warn(`Conflict: ${localFile.fileId}`);
        localFile.hasConflict = true;
      } else {
        // Update local with remote version
        await fileRegistry.updateFromRemote(remoteFile);
      }
    }
  }
  
  // 4. Refresh Navigator
  await navigatorContext.refresh();
}
```

### 9. Commit Operation Enhancement

```typescript
async commitAll(message: string, branch: string): Promise<void> {
  // 1. Get all dirty files (including indexes!)
  const dirtyFiles = Array.from(fileRegistry.getAll())
    .filter(f => f.isDirty);
  
  // 2. Prepare files for commit
  const filesToCommit = dirtyFiles.map(file => ({
    path: file.source.path,
    content: serializeFile(file),
    sha: file.source.sha
  }));
  
  // 3. Commit to Git
  const result = await gitService.commitAndPushFiles(
    filesToCommit,
    message,
    branch
  );
  
  if (result.success) {
    // 4. Mark all as clean, update SHAs
    for (const file of dirtyFiles) {
      file.isDirty = false;
      file.originalData = structuredClone(file.data);
      file.source.sha = result.shas[file.source.path];
      file.lastSynced = Date.now();
      await db.files.put(file);
    }
  }
}
```

### 10. Navigator Context Enhancement

```typescript
interface NavigatorState {
  // Files (from workspace, not just open tabs)
  items: RepositoryItem[];      // All files in workspace
  localItems: RepositoryItem[]; // Files not in remote
  
  // Registry indexes (loaded from workspace)
  registryIndexes: {
    parameters?: ParametersIndex;
    contexts?: ContextsIndex;
    cases?: CasesIndex;
    nodes?: NodesIndex;
  };
  
  // NEW: Workspace metadata
  workspace: {
    initialized: boolean;
    lastPulled?: number;
    remoteUrl?: string;
    branch: string;
  };
  
  // NEW: File states
  fileStates: Map<string, {
    isOpen: boolean;
    isDirty: boolean;
    isLocal: boolean;
  }>;
}

// Enhanced load function
async function loadWorkspace() {
  // 1. Load all FileStates from IDB
  const allFiles = await db.files.toArray();
  
  // 2. Build items list
  const items = allFiles
    .filter(f => !f.isLocal)
    .map(fileStateToRepositoryItem);
  
  const localItems = allFiles
    .filter(f => f.isLocal)
    .map(fileStateToRepositoryItem);
  
  // 3. Load indexes (they're just FileStates too!)
  const registryIndexes = {
    parameters: JSON.parse(
      allFiles.find(f => f.fileId === 'parameters-index')?.data || '{}'
    ),
    contexts: JSON.parse(
      allFiles.find(f => f.fileId === 'contexts-index')?.data || '{}'
    ),
    cases: JSON.parse(
      allFiles.find(f => f.fileId === 'cases-index')?.data || '{}'
    ),
    nodes: JSON.parse(
      allFiles.find(f => f.fileId === 'nodes-index')?.data || '{}'
    )
  };
  
  // 4. Build file states map for UI
  const fileStates = new Map();
  for (const file of allFiles) {
    fileStates.set(file.fileId, {
      isOpen: file.viewTabs.length > 0,
      isDirty: file.isDirty,
      isLocal: file.isLocal
    });
  }
  
  setState({ items, localItems, registryIndexes, fileStates });
}
```

## Navigator Filters & Visual Consistency

**Note**: See `NAVIGATOR_FILTERS_DESIGN.md` for complete details. Key points:

### Navigator Shows Superset of Index + Files

- **All Mode (Default)**: Shows index entries + files (including "create" entries with no files yet)
- **Files Only Mode**: Shows only items with actual files
- Clicking "create" entry → creates new local file with that ID → opens tab

### Visual Treatment Standard (Consistent Everywhere)

Apply across **all** these locations:
1. **Navigator panel** - list items
2. **Tab headers** - tab titles
3. **Sidebar selectors** - parameter/node/case selectors in graph editor

| State | Visual Treatment |
|-------|------------------|
| Index only (no file) | Gray text + `[create]` badge |
| Has file (remote) | Normal text |
| Has file (local) | Italic text + `(local)` badge |
| Orphan (file, no index) | Warning text + ⚠️ icon |
| Dirty | Orange dot (●) |
| Open | Blue dot (●) |

**Key Principle**: Selection dropdowns in graph editor should function as **"mini-Navigators"**:
- Same visual treatment
- Same sub-categorization (Probability, Cost GBP, Cost Time)
- Searchable
- Shows all states (create, local, dirty, orphan)

### Filter UI

```
[🔍 Search parameters, contexts, cases...] [⚙️]
                                            ↑
                                        Filters dropdown
```

Filters include:
- Mode: All vs Files Only
- State: Local only, Dirty only, Open only
- Include: Not-yet-files, Orphans

### Sync Index from Graph

New operation to scan graph for referenced IDs and batch-add missing ones to indexes:

```
Edit > Sync Index from Graph...
  → Scans graph for all parameter_ids, node_ids, case_ids, context_ids
  → Shows checklist of missing entries
  → Batch creates index entries for selected IDs
```

## Implementation Phases

### Phase 1: Core Persistence (HIGH PRIORITY)
**Goal**: Files survive tab closure

1. Remove file deletion from `FileRegistry.removeViewTab()`
2. Add special handling for credentials and settings (IMMEDIATE)
3. Test: Create file, open tab, close tab, reopen → file still there

**Deliverable**: Credentials bug fixed + foundation for full workspace

### Phase 2: Workspace Clone (HIGH PRIORITY)
**Goal**: Full repo mirrored in IDB

1. Add "Clone Repository" operation
2. Load all files from Git on init (if not cached)
3. Cache in IDB with clean state
4. Navigator shows all files (not just open ones)

**Deliverable**: Persistent local workspace

### Phase 3: Index File Management (HIGH PRIORITY)
**Goal**: Indexes auto-update on CRUD

1. Create index file types in fileTypeRegistry
2. Load index files on init (always)
3. Hook into param CRUD operations
4. Auto-update index files
5. Mark indexes as dirty when updated

**Deliverable**: Indexes stay in sync automatically

### Phase 4: Navigator UI (MEDIUM PRIORITY)
**Goal**: Visual state indicators

1. Add status badges component
2. Show blue dot for open tabs
3. Show orange dot for dirty files
4. Show italic for local-only files
5. Add index file icons to category headers

**Deliverable**: Clear visual feedback on file states

### Phase 5: Repository Operations (MEDIUM PRIORITY)
**Goal**: Pull, Push, Refresh

1. Add Repository menu
2. Implement Pull operation
3. Implement conflict detection
4. Implement "Show Dirty Files" view
5. Implement "Discard Changes"

**Deliverable**: Full Git workflow

### Phase 6: Advanced Features (LOW PRIORITY)
1. Auto-pull on timer
2. Conflict resolution UI
3. File history browser
4. Branch switching

## Migration Strategy

### Backward Compatibility

Existing IndexedDB data:
- Files in `db.files` table remain
- Just stop deleting them on tab close
- Gradually populate with more files on pull

### User Experience

No breaking changes:
- App works exactly the same
- Just files persist better
- More files appear in Navigator

## Technical Considerations

### Performance

- **IndexedDB size**: Full repo could be large
  - Solution: Lazy load file content, keep metadata only
  - Index files always loaded (small)
  
- **Memory usage**: All FileStates in memory
  - Solution: LRU cache, unload unused files
  - Keep indexes always loaded

### Conflicts

- Phase 1: Warn user, manual resolution
- Phase 2: Three-way merge UI
- Phase 3: Operational transform (future)

### Testing

Critical scenarios:
1. File dirty → close tab → reopen → still dirty ✓
2. Index updated → close app → reopen → index persisted ✓
3. Pull with dirty files → warning shown ✓
4. Create param → index auto-updated → commit includes both ✓

## Success Criteria

✅ Files persist when tabs close
✅ Credentials survive tab closure
✅ Indexes update automatically on CRUD
✅ Navigator shows open/dirty/local states
✅ Commit includes index changes
✅ Pull refreshes local workspace
✅ No data loss scenarios

## Next Steps

1. **Immediate**: Fix FileRegistry.removeViewTab() to preserve special files
2. **This week**: Implement Phase 1 (core persistence)
3. **Next week**: Implement Phase 2 & 3 (workspace + indexes)
4. **Following week**: Implement Phase 4 & 5 (UI + repo ops)

---

**Document Version**: 1.0  
**Date**: October 29, 2025  
**Status**: Design Document - Ready for Implementation  
**Priority**: HIGH - Blocks proper file management

