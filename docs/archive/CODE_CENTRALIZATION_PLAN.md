# Code Centralization Plan

## Problem Statement

We have **massive code duplication** across menu handlers. The same logic for file operations (create, open, delete, duplicate) is copy-pasted in multiple places:

### Current Duplication:

**File Creation** - Identical code in 3+ places:
1. `FileMenu.handleCreateFile()` - lines 69-128
2. `NavigatorSectionContextMenu.handleCreateFile()` - lines 40-98
3. `NavigatorItemContextMenu.handleCreateFile()` - lines 246-304
4. `ParameterSelector.handleCreateFile()` - similar logic

**File Deletion** - Similar code in:
1. `FileMenu.handleDelete()`
2. `NavigatorItemContextMenu` delete handler
3. `TabContextMenu` delete handler

**File Opening** - Repeated in:
1. `NavigatorContent.handleItemClick()`
2. Menu handlers
3. Keyboard shortcuts
4. URL parameter handlers

**Duplicate File** - In:
1. `TabContextMenu.handleDuplicate()`
2. `NavigatorItemContextMenu.handleDuplicate()`

## Proposed Solution

### Create Centralized `FileOperationsService`

**Location:** `graph-editor/src/services/fileOperationsService.ts`

```typescript
class FileOperationsService {
  /**
   * Create new file with default content
   * Handles:
   * - Creating FileState
   * - Updating index
   * - Adding to Navigator
   * - Opening tab
   */
  async createFile(
    name: string, 
    type: ObjectType,
    options?: {
      openInTab?: boolean;
      basedOn?: string; // For duplication
      metadata?: any;
    }
  ): Promise<{ fileId: string; item: RepositoryItem }> {
    // ... single implementation
  }

  /**
   * Open file in tab
   * Handles:
   * - Checking if already open
   * - Switching to existing tab vs opening new
   * - Panel placement
   * - Navigator close if unpinned
   */
  async openFile(
    item: RepositoryItem,
    options?: {
      viewMode?: ViewMode;
      switchIfExists?: boolean;
      targetPanel?: string;
    }
  ): Promise<string> { // Returns tabId
    // ... single implementation
  }

  /**
   * Delete file
   * Handles:
   * - Checking for open tabs
   * - Checking for dirty state
   * - Confirmation dialog
   * - Updating index
   * - Removing from Navigator
   * - Removing from FileRegistry
   */
  async deleteFile(
    fileId: string,
    options?: {
      force?: boolean;
      skipConfirm?: boolean;
    }
  ): Promise<boolean> {
    // ... single implementation
  }

  /**
   * Duplicate file
   * Handles:
   * - Loading source file
   * - Creating copy with new name
   * - Updating index
   * - Opening in tab
   */
  async duplicateFile(
    sourceFileId: string,
    newName: string
  ): Promise<{ fileId: string; item: RepositoryItem }> {
    // ... single implementation
  }

  /**
   * Rename file
   * Handles:
   * - Updating FileState
   * - Updating index
   * - Updating all open tabs
   * - Updating Navigator
   */
  async renameFile(
    fileId: string,
    newName: string
  ): Promise<void> {
    // ... single implementation
  }

  /**
   * Close all tabs for file
   */
  async closeAllTabsForFile(fileId: string): Promise<void> {
    // ... single implementation
  }
}
```

### Refactor Menu Handlers

**Before:**
```typescript
// FileMenu.tsx
const handleCreateFile = async (name: string, type: ObjectType) => {
  // 30 lines of logic
  await fileRegistry.getOrCreateFile(...);
  await fileRegistry.updateIndexOnCreate(...);
  navOps.addLocalItem(...);
  await operations.openTab(...);
  // ... etc
};

// NavigatorSectionContextMenu.tsx
const handleCreateFile = async (name: string, type: ObjectType) => {
  // EXACT SAME 30 lines
};

// NavigatorItemContextMenu.tsx
const handleCreateFile = async (name: string, type: ObjectType) => {
  // EXACT SAME 30 lines AGAIN
};
```

**After:**
```typescript
// FileMenu.tsx
const handleCreateFile = async (name: string, type: ObjectType) => {
  await fileOperationsService.createFile(name, type, { openInTab: true });
};

// NavigatorSectionContextMenu.tsx
const handleCreateFile = async (name: string, type: ObjectType) => {
  await fileOperationsService.createFile(name, type, { openInTab: true });
};

// NavigatorItemContextMenu.tsx
const handleCreateFile = async (name: string, type: ObjectType) => {
  await fileOperationsService.createFile(name, type, { openInTab: true });
};
```

### Implementation Plan

#### Phase 1: Create FileOperationsService (2 hours)
1. Create `fileOperationsService.ts`
2. Implement `createFile()`
3. Implement `openFile()`
4. Implement `deleteFile()`
5. Implement `duplicateFile()`

#### Phase 2: Refactor Menus (1 hour)
1. Update `FileMenu.tsx` to use service
2. Update `NavigatorSectionContextMenu.tsx` to use service
3. Update `NavigatorItemContextMenu.tsx` to use service
4. Update `TabContextMenu.tsx` to use service
5. Update `ParameterSelector.tsx` to use service

#### Phase 3: Refactor Other Callers (1 hour)
1. Update `NavigatorContent.handleItemClick()` to use service
2. Update keyboard shortcut handlers
3. Update URL parameter handlers
4. Update any other direct callers

#### Phase 4: Testing & Cleanup (30 min)
1. Test all file operations
2. Remove old duplicated code
3. Verify all menus still work

### Benefits

✅ **DRY** - Don't Repeat Yourself
✅ **Single source of truth** - File operations logic in one place
✅ **Easier to maintain** - Fix bugs in one place
✅ **Easier to extend** - Add features once, everywhere gets it
✅ **Consistency** - All menus behave identically
✅ **Testing** - Test service once, not every menu

### Estimated Effort

**Total:** 4-5 hours of careful refactoring

**Breakdown:**
- FileOperationsService: 2 hours
- Menu refactoring: 1 hour
- Other callers: 1 hour
- Testing: 30-60 min

### Other Duplication to Consider

Beyond file operations, we also have duplication in:

**Menu Building** - Similar menu structures across:
- `FileMenu.tsx`
- `EditMenu.tsx`
- `ViewMenu.tsx`
- Context menus

**Tab Operations** - Repeated logic:
- Opening tabs
- Switching tabs
- Closing tabs
- Tab state management

**Navigator Operations** - Similar patterns:
- Section expanding/collapsing
- Item selection
- Context menu triggering

**Potential Future Service:**
- `MenuService` - Centralized menu building
- `TabService` - Centralized tab operations (might merge with FileOperations)
- `NavigatorService` - Centralized navigator operations

---

## Recommendation

**Immediate:** Create `FileOperationsService` and refactor file CRUD operations (4-5 hours)

**Later:** Consider menu service and other centralizations as we add features

This will massively improve code quality and maintainability.

---

## Repository Operations Service

### Problem

Repository menu commands are NOT properly wired up:
- ❌ "Pull Latest" → calls `navOps.refreshItems()` which is the old implementation  
- ❌ "Push Changes" → Not implemented (just console.log)
- ❌ "Refresh Status" → Same as Pull (wrong)
- ❌ "Show Dirty Files" → Not implemented
- ❌ "Discard Local Changes" → Not implemented
- ❌ NO "Clone Repository" option (should force re-clone)

### Current Issues in `RepositoryMenu.tsx`:

```typescript
const handlePullLatest = async () => {
  await navOps.refreshItems(); // ← OLD IMPLEMENTATION, NOT WORKSPACE-AWARE
};

const handlePushChanges = () => {
  // TODO: Implement push all dirty files ← NOT IMPLEMENTED
  console.log('Push changes to', state.selectedBranch);
};
```

### Solution: Create `RepositoryOperationsService`

**Location:** `graph-editor/src/services/repositoryOperationsService.ts`

```typescript
class RepositoryOperationsService {
  /**
   * Pull latest changes from remote
   * - Delete local workspace
   * - Re-clone from Git
   * - Reload Navigator
   */
  async pullLatest(repo: string, branch: string): Promise<void> {
    await workspaceService.deleteWorkspace(repo, branch);
    await workspaceService.cloneWorkspace(repo, branch, gitCreds);
    // Trigger Navigator reload
  }

  /**
   * Clone/refresh workspace
   * - Force delete and re-clone
   */
  async cloneWorkspace(repo: string, branch: string): Promise<void> {
    await workspaceService.deleteWorkspace(repo, branch);
    await workspaceService.cloneWorkspace(repo, branch, gitCreds);
  }

  /**
   * Push all dirty files
   * - Get all dirty files from FileRegistry
   * - Commit and push to remote
   * - Mark as saved
   */
  async pushChanges(message: string, branch: string): Promise<void> {
    const dirtyFiles = fileRegistry.getDirtyFiles();
    // ... commit logic
  }

  /**
   * Discard all local changes
   * - Revert all dirty files
   * - Reload from workspace (IDB)
   */
  async discardLocalChanges(): Promise<void> {
    // ... revert logic
  }

  /**
   * Get repository status
   * - Count dirty files
   * - Check connection
   * - Show branch info
   */
  async getStatus(): Promise<RepositoryStatus> {
    // ... status logic
  }
}
```

### Update `RepositoryMenu.tsx`:

```typescript
const handlePullLatest = async () => {
  await repositoryOps.pullLatest(state.selectedRepo, state.selectedBranch);
};

const handlePushChanges = async () => {
  await repositoryOps.pushChanges(commitMessage, state.selectedBranch);
};
```

### Estimated Effort: 2-3 hours

