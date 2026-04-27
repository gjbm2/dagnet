# FileRegistry and File Lifecycle

How the in-memory FileRegistry caches file state, syncs with IndexedDB, and manages the file lifecycle from creation through editing to commit.

## What FileRegistry Is

FileRegistry is an **in-memory cache** (a `Map<string, FileState>`) holding all currently-loaded files for fast access by editors, panels, and UI components. It lives in `TabContext.tsx` and is **not** the source of truth — IndexedDB is.

### Key distinction

| | FileRegistry | IndexedDB |
|---|---|---|
| **Scope** | In-memory, current session | Persistent, all sessions |
| **fileId format** | Unprefixed: `parameter-channel` | Both: unprefixed + `repo-branch-parameter-channel` |
| **getDirtyFiles()** | For UI only | For git operations |
| **On page reload** | Empty (repopulated from IDB) | Intact |
| **Purpose** | Performance cache + listener notifications | Source of truth |

## FileRegistry API

### Core operations

| Method | Behaviour |
|--------|-----------|
| `getFile(fileId)` | Returns FileState from memory (unprefixed ID) |
| `getOrCreateFile(fileId, type, source, defaultData)` | Returns existing or creates new FileState |
| `updateFile(fileId, newData, opts?)` | Updates content, computes dirty, writes to IDB (both forms), notifies listeners |
| `markSaved(fileId)` | Sets `isDirty: false`, `isLocal: false`, updates `originalData`, writes to IDB |
| `revertFile(fileId)` | Restores `data` to `originalData`, sets `isDirty: false` |
| `deleteFile(fileId)` | Removes from Map, deletes both IDB records (prefixed + unprefixed) |
| `completeInitialization(fileId)` | Sets `isInitializing: false`, writes to IDB |
| `upsertFileClean(fileId, data, source)` | Inserts or updates with `isDirty: false` (used for fresh remote content) |
| `getDirtyFiles()` | Returns array of dirty files from memory (**UI only, not for git ops**) |
| `addViewTab(fileId, tabId)` | Tracks which tabs view this file |
| `removeViewTab(fileId, tabId)` | Removes tab from `viewTabs` array (file persists) |

### Listener system

```
subscribe(fileId, callback)   --> returns unsubscribe function
notifyListeners(fileId, file) --> deep-clones file and calls all subscribers
```

Listeners receive a **deep clone** to ensure React sees new references. Notification is deferred during atomic restore operations (`__DAGNET_ATOMIC_RESTORE_ACTIVE` flag).

### Concurrency guards

- `updatingFiles: Set<string>` — prevents re-entrant updates to the same file
- `pendingUpdates: Map<string, {...}>` — queues updates that arrive during an in-flight update
- `fileGenerations: Map<string, number>` — monotonic counter to detect and reject stale updates

## File Lifecycle

### 1. CREATE

**Entry point**: `fileOperationsService.ts`

1. Service calls `fileRegistry.getOrCreateFile(fileId, type, source, defaultData)`
2. FileState created with `isDirty: false`, `isInitializing: true`
3. Written to IDB immediately (both prefixed and unprefixed)
4. Index file auto-updated (e.g. `parameters-index.yaml`)
5. Tab opened (optional)

### 2. OPEN (workspace load)

**Entry point**: `workspaceService.ts`

1. Query all prefixed files from IDB for the workspace
2. Deduplicate by timestamp (keep newest)
3. Strip workspace prefix, load into FileRegistry via `files.set(actualFileId, cleanFileState)`
4. Set `isInitializing: false` (files from IDB are already normalised)
5. Notify index listeners explicitly

### 3. EDIT

**Entry point**: any editor component calling `fileRegistry.updateFile()`

1. Guard against re-entrant updates (`updatingFiles` set)
2. Compare `newData` against `originalData`:
   - **During `isInitializing`**: absorb normalisation (update both `data` and `originalData`, keep `isDirty: false`)
   - **After init**: set `isDirty = (newDataStr !== originalDataStr)`
3. Write to IDB **twice** (unprefixed + prefixed)
4. Notify listeners (triggers React re-renders)
5. Emit `dagnet:fileDirtyChanged` custom event

### 4. DIRTY

A file becomes dirty when `JSON.stringify(data) !== JSON.stringify(originalData)` after the initialisation phase completes.

Dirty state is:
- Visible in tab indicators and navigator badges
- Persistent across page reload (stored in IDB)
- Used by commit flow to determine what to push

### 5. SAVE / COMMIT

**Entry point**: `repositoryOperationsService.commitFiles()`

1. Commit flow queries `db.getDirtyFiles()` (IDB, not FileRegistry)
2. Filters by workspace prefix
3. Pushes to GitHub via atomic Git Data API
4. On success, calls `fileRegistry.markSaved(fileId)` for each file:
   - `originalData = structuredClone(data)`
   - `isDirty = false`
   - `isLocal = false`
   - Writes both IDB records
   - Fires `dagnet:fileDirtyChanged`

### 6. REVERT

**Entry point**: `fileRegistry.revertFile(fileId)`

1. Restores `data` to `originalData`
2. Sets `isDirty: false`, `lastModified: Date.now()`
3. Notifies listeners

### 7. DELETE

**Entry point**: `fileOperationsService.ts`

1. Removes file from FileRegistry Map
2. Deletes both IDB records (unprefixed + prefixed)
3. Updates index files
4. Closes associated tabs

## Sync Points (FileRegistry <--> IDB)

| Operation | FileRegistry action | IDB action |
|-----------|-------------------|------------|
| Create file | `getOrCreateFile()` | `db.files.add()` |
| Edit file | `updateFile()` | `db.files.put()` x2 (unprefixed + prefixed) |
| Mark saved | `markSaved()` | `db.files.put()` x2 |
| Complete init | `completeInitialization()` | `db.files.put()` x2 |
| Revert file | `revertFile()` | `db.files.put()` |
| Delete file | `deleteFile()` | `db.files.delete()` x2 |
| Load workspace | Populate `files` Map | `db.files.where(...).toArray()` |
| Upsert clean | `upsertFileClean()` | `db.files.put()` x2 |
| Get dirty for commit | **NOT used** | `db.getDirtyFiles()` |

## Invariants

1. **IDB is source of truth for git operations.** Never use `fileRegistry.getDirtyFiles()` for commit, push, or discard.

2. **Dual IDB records.** Every write updates both prefixed and unprefixed. Failure to do so causes zombie files or stale reads.

3. **Initialisation phase absorbs normalisation.** During `isInitializing: true`, editors normalise content (sort keys, inject defaults) without triggering dirty. Prevents spurious 3-way merge on pull.

4. **Files persist after tab close.** `removeViewTab()` removes the tab reference but keeps the file in IDB. Only explicit `deleteFile()` removes it.

5. **Dirty state survives page reload.** If the user closes the browser mid-edit, the file remains dirty in IDB and is restored on next load.

6. **Listener notifications use deep clones.** Prevents stale closure bugs in React subscribers.

## Pitfalls

### Anti-pattern 10: Assuming `isInitializing` is false

**Signature**: dirty detection doesn't work for a newly-loaded file. File appears clean despite real edits.

**Root cause**: `isInitializing` is true for 500ms after file load. During this phase, all edits are absorbed into `originalData` without marking dirty. If `completeInitialization()` doesn't fire (callback lost, file re-loaded), the phase never ends.

**Fix**: check `file.isInitializing` in the debugger. Verify `completeInitialization(fileId)` is scheduled and fires.

## Key Files

| File | Role |
|------|------|
| `src/contexts/TabContext.tsx` | FileRegistry class implementation |
| `src/types/index.ts` | FileState interface |
| `src/db/appDatabase.ts` | IDB schema, `getDirtyFiles()` |
| `src/services/fileOperationsService.ts` | File CRUD operations |
| `src/services/registryService.ts` | Registry item management (nodes, parameters, etc.) |
| `src/services/workspaceService.ts` | Workspace load/clone populating FileRegistry |
| `src/services/repositoryOperationsService.ts` | Commit flow using `db.getDirtyFiles()` |
