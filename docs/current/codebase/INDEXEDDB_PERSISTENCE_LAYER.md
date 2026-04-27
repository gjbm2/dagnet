# IndexedDB Persistence Layer

How DagNet stores and retrieves all file state, workspace metadata, and application configuration via IndexedDB.

## Database Identity

- **Name**: `DagNetGraphEditor` (standard) or `DagNetGraphEditorShare:<scopeKey>` (live share isolation)
- **Schema version**: 5 (managed by Dexie)
- **Implementation**: `graph-editor/src/db/appDatabase.ts`

## Tables

| Table | Primary Key | Indexes | Purpose |
|-------|-------------|---------|---------|
| `files` | `fileId` (string) | `type`, `isDirty`, `source.repository`, `source.branch`, `lastModified` | Source of truth for all file content and metadata |
| `tabs` | `id` (string) | `fileId`, `viewMode` | Open tab state (references FileState by fileId) |
| `appState` | `id` (singleton: `'app-state'`) | `updatedAt` | Layout, navigator state (pinned, search, sections) |
| `settings` | `id` (singleton: `'settings'`) | -- | User settings (theme, tab limit, editor prefs). Local-only, not synced to git |
| `credentials` | `id` | `source`, `timestamp` | Auth credentials. Local-only; **explicitly excluded from `clearAll()`** |
| `workspaces` | `id` (format: `${repository}-${branch}`) | `repository`, `branch`, `lastSynced` | Workspace metadata (clone state, commit SHA, file list). Single-workspace policy enforced |
| `scenarios` | `id` | `fileId`, `createdAt`, `updatedAt` | Parameter scenario overlays per file |
| `automationRunLogs` | `runId` | `timestamp` | Persisted automation run diagnostics |
| `schedulerJobs` | `jobId` | `jobDefId`, `status`, `submittedAtMs` | Long-lived scheduler jobs that survive browser close |

## Workspace Prefix Contract

### The dual-storage invariant

Every file is stored **twice** in IDB:

1. **Unprefixed**: `fileId: "graph-myanalysis"` -- used by FileRegistry lookups
2. **Prefixed**: `fileId: "${repository}-${branch}-graph-myanalysis"` -- used by workspace operations (commit, pull, discard)

### Construction

```
prefixedId  = `${repository}-${branch}-${fileId}`
workspacePrefix = `${repository}-${branch}-`
```

### When each form is used

| Context | ID form | Why |
|---------|---------|-----|
| FileRegistry in-memory operations | Unprefixed | Fast lookup, no workspace context needed |
| Cloning workspace (writing to IDB) | Prefixed | Workspace isolation |
| Pulling/syncing files | Unprefixed (via FileRegistry) | Editor interactions use unprefixed |
| Committing dirty files | Prefixed (filter `db.getDirtyFiles()` by prefix) | Must isolate workspace-specific dirty files |
| Discarding changes | Prefixed (query), then strip to unprefixed for registry | Find workspace files, then update registry |
| Loading workspace from cache | Prefixed on query, stripped to unprefixed on load | IDB query finds prefixed; memory uses unprefixed |

### The dual-write pattern

Every write to IDB must update **both** records. This is enforced in TabContext.tsx (FileRegistry):

```
await db.files.put(file);                                           // Unprefixed
await db.files.put({ ...file, fileId: `${repo}-${branch}-${fileId}` }); // Prefixed
```

If only one record is updated, subsequent operations see stale data or duplicates.

## FileState Schema

The `files` table stores `FileState` objects (`src/types/index.ts`):

| Field | Type | Purpose |
|-------|------|---------|
| `fileId` | string | Unique identifier (prefixed or unprefixed depending on record) |
| `type` | ObjectType | `'graph'`, `'parameter'`, `'node'`, `'event'`, `'context'`, `'case'`, `'image'`, etc. |
| `name` | string? | Display name |
| `path` | string? | File path in repository |
| `data` | any | Current file content (structured JSON/YAML) |
| `originalData` | any | Clean version (baseline for dirty detection, used for revert) |
| `isDirty` | boolean? | Whether content differs from originalData |
| `isInitializing` | boolean? | During initial load, absorbs normalisation without marking dirty |
| `source` | `{ repository, path, branch, commitHash? }` | Git source metadata |
| `isLoaded` | boolean? | Whether content has been loaded |
| `isLocal` | boolean? | True if not yet committed to repo |
| `viewTabs` | string[] | Tab IDs viewing this file |
| `lastModified` | number? | Timestamp of last content change |
| `lastSaved` | number? | Timestamp of last commit |
| `syncRevision` | number? | Monotonic counter for store-to-file bridge (reject stale echoes) |
| `syncOrigin` | `'store' \| 'external'` | Where the last update came from |
| `sha` | string? | Git blob SHA (conflict detection) |
| `lastSynced` | number? | Last sync timestamp |

## Dirty Tracking

### Source of truth: IDB, not FileRegistry

For git operations (commit, discard), **always** use `db.getDirtyFiles()`, never `fileRegistry.getDirtyFiles()`. IDB survives page reload; FileRegistry is empty on startup.

### How dirty is determined

Content-based comparison via JSON stringification:

- **During initialisation** (`isInitializing: true`): all edits absorbed as baseline updates to `originalData`. `isDirty` stays false. This prevents editor normalisation (key sorting, default injection) from marking files dirty on load.
- **After initialisation**: any `JSON.stringify(data) !== JSON.stringify(originalData)` sets `isDirty: true`.

### Dirty lifecycle

1. **Create**: `isDirty: false`
2. **Initialisation phase**: edits absorbed, `isDirty` stays false
3. **Active editing**: content diverges from `originalData` --> `isDirty: true`
4. **Commit** (`markSaved`): `isDirty: false`, `isLocal: false`, `originalData` updated
5. **Revert** (`revertFile`): `data` restored to `originalData`, `isDirty: false`

### Custom events

When dirty state changes, FileRegistry fires `dagnet:fileDirtyChanged`:

```
window.dispatchEvent(new CustomEvent('dagnet:fileDirtyChanged', {
  detail: { fileId, isDirty }
}));
```

## getDirtyFiles() -- Two Implementations

### db.getDirtyFiles() (appDatabase.ts)

Scans entire `files` table. Returns **both** prefixed and unprefixed copies. Callers must filter by `workspacePrefix` for commit operations.

### fileRegistry.getDirtyFiles() (TabContext.tsx)

Scans in-memory Map. Returns **unprefixed** copies only. Used for UI indicators (dirty tab dots, FileMenu state). **Not suitable for git operations.**

## Key Access Patterns

### Commit flow

1. `db.getDirtyFiles()` -- query IDB
2. Filter: `f.fileId.startsWith(workspacePrefix)`
3. Strip prefix: `f.fileId.substring(workspacePrefix.length)`
4. Load from FileRegistry for canonical state

### Workspace load

1. Query: `db.files.where('source.repository').equals(repo).and(f => f.source.branch === branch).toArray()`
2. Deduplicate by unprefixed fileId (keep most recent by timestamp)
3. Strip prefix, load into FileRegistry
4. Notify index listeners explicitly (direct `Map.set()` bypasses listener firing)

### Clone / pull

1. Fetch files from GitHub API
2. Create FileState with unprefixed fileId
3. Write to IDB with **both** unprefixed and prefixed records
4. Add to FileRegistry memory with unprefixed fileId

## Gotchas

1. **Dual storage**: every IDB write must update both prefixed and unprefixed records, or subsequent operations see stale data.

2. **Initialisation phase**: files start with `isInitializing: true`. Editor normalisation is absorbed as baseline. If `completeInitialization()` is not called, dirty tracking never activates.

3. **Single-workspace policy**: before cloning or hydrating, `workspaceService` clears all existing workspaces. Prevents stale files from one repo polluting IDB when loading another.

4. **Deduplication on load**: when loading workspace from IDB, duplicate unprefixed fileIds are deduplicated by keeping the most recent. Handles edge cases where both prefixed and unprefixed copies were written.

5. **Index listeners need explicit notification**: after bulk-loading files via direct `Map.set()`, index file listeners must be explicitly notified. Without this, selectors (EnhancedSelector, ParameterSelector) show stale state.

6. **Credentials survive clearAll()**: the `credentials` table is deliberately excluded from workspace clear operations.

7. **WorkspaceState.fileIds stores unprefixed IDs**: the workspace metadata file list uses unprefixed fileIds, not prefixed.

## Pitfalls

### Anti-pattern 12: Unprefixed IDB key in file lookups

**Signature**: a function loads a file from `db.files.get(fileId)` using the FileRegistry-style unprefixed key (e.g. `event-myEvent`), but IDB stores files under workspace-prefixed keys (e.g. `nous-conversion-main-event-myEvent`). The lookup silently returns nothing.

**Root cause**: FileRegistry uses unprefixed file IDs; IDB uses `${repository}-${branch}-${fileId}` as the primary key. A direct `db.files.get(unprefixedId)` will never find a workspace-loaded file.

**Fix**: use `fileRegistry.restoreFile(fileId, workspaceScope)` which handles both unprefixed and prefixed key lookups.

### Anti-pattern 16: E2E test seeding IDB but assuming FileRegistry is populated

**Signature**: you seed data into IDB via `db.files.put()` in a Playwright test, but the from-file pipeline returns empty/stale results because it reads from FileRegistry (in-memory), not IDB.

**Root cause**: `db.files.put()` writes to IndexedDB but does NOT notify FileRegistry. FileRegistry is populated lazily via `restoreFile()` or proactively via `getOrCreateFile()`.

**Fix**: after seeding IDB and reloading, use `dagnetDebug.refetchFromFiles()` to trigger the full from-file pipeline.

## Key Files

| File | Role |
|------|------|
| `src/db/appDatabase.ts` | Schema definition, `getDirtyFiles()`, table declarations |
| `src/contexts/TabContext.tsx` | FileRegistry class (in-memory cache, dual-write to IDB) |
| `src/types/index.ts` | FileState, ObjectType type definitions |
| `src/services/workspaceService.ts` | Workspace load/clone with prefix handling |
| `src/services/repositoryOperationsService.ts` | Commit flow using `db.getDirtyFiles()` |
