# Merge and Conflict Resolution

How DagNet performs 3-way merges during pull, and how conflicts are detected, presented, and resolved.

## Two Merge Strategies

Chosen by file type.

### Text-level line merge (`merge3Way`)

**Used for**: YAML files (parameters, contexts, cases, nodes, events, index files)

Algorithm:
1. Split base, local, remote content by newlines
2. Compute diffs via simplified Myers algorithm (lookahead up to 10 lines for sync points)
3. Iterate base lines, applying changes in sorted order
4. Both sides changed the same region:
   - Identical changes: apply once
   - Different changes: record conflict with markers

Conflict markers in merged output:
```
<<<<<<< LOCAL
local content
=======
remote content
>>>>>>> REMOTE
```

### Structural JSON merge (`mergeJson3Way`)

**Used for**: graph files (JSON), hash mappings

Algorithm (BitSquid-style):
1. **Different keys**: auto-merge without conflict
2. **Same key, same value**: auto-merge
3. **Same key, different values**:
   - Both objects: recurse key-by-key
   - Both arrays with identity keys (`uuid`, `id`): merge element-by-element
   - Otherwise: record conflict (default to local)
4. **Key added by one side only**: kept
5. **Key deleted by one side, unchanged by other**: deleted
6. **Key deleted by one side, modified by other**: conflict

### Domain-specific policies

| Field pattern | Policy | Rationale |
|---------------|--------|-----------|
| `_bayes` | Remote always wins | Bayes service is authoritative |
| `updated_at`, `created_at` | Most recent wins | Timestamp freshness |
| Arrays with `uuid`/`id` fields | Merge by identity | Preserves element-level semantics |

## When Merge Happens

During `workspaceService.pullLatest()`:

1. Compare local file with remote
2. Local has no changes (`data === originalData`): fast-forward, skip merge
3. Local has changes: 3-way merge using `originalData` as base
4. Merge succeeds (no conflicts): apply merged result, set `isDirty: false`
5. Merge conflicts: return conflict object without modifying the file

## Conflict Representation

```typescript
interface MergeConflict {
  fileId: string;           // File identifier
  fileName: string;         // Display name
  path: string;             // Git path
  type: ObjectType;         // 'graph' | 'parameter' | etc.
  localContent: string;     // User's current version
  remoteContent: string;    // Incoming version
  baseContent: string;      // Original before changes
  mergedContent: string;    // Auto-merge result (may contain conflict markers)
  hasConflicts: boolean;    // True if conflicts found
}
```

For JSON conflicts, individual key-level conflicts are also tracked:

```typescript
interface JsonKeyConflict {
  path: string[];           // Dot path: ['_bayes', 'posteriors']
  base: unknown;
  local: unknown;
  remote: unknown;
}
```

## Conflict Resolution UI

**Location**: `src/components/modals/MergeConflictModal.tsx`

### Features

1. **File list panel**: all conflicted files with resolution badges
2. **Diff views** (switchable):
   - `local-merged` (default): your version vs proposed merge result
   - `local-remote`: your version vs incoming changes
   - `base-local`: original vs your changes
   - `base-remote`: original vs incoming changes
3. **Monaco diff editor**: side-by-side read-only comparison with syntax highlighting
4. **Per-file resolution options**:
   - **Accept Merged**: use auto-merged result
   - **Keep Local**: keep your version (marks dirty for commit)
   - **Use Remote**: accept remote (overwrites local)
   - **Manual**: leave for user to edit directly
5. **Batch actions**: accept merged/remote/local for all files

### Resolution outcomes

| Resolution | `isDirty` after | Behaviour |
|-----------|----------------|-----------|
| `'merged'` | `false` | Apply auto-merged result, update IDB and registry |
| `'remote'` | `false` | Apply remote version, update IDB and registry |
| `'local'` | `true` | Keep local unchanged (needs commit) |
| `'manual'` | `true` | Leave conflicted content for user |

## Post-Merge Application

After resolution, `conflictResolutionService.applyResolutions()`:

1. Applies chosen content to `fileState.data`
2. Updates `originalData` (for merged/remote: set to resolved content)
3. Sets `isDirty` per resolution type
4. Updates `lastModified` timestamp
5. Writes to IDB (both prefixed and unprefixed records)
6. Notifies FileRegistry listeners

For successful auto-merges (no conflicts):

1. `localFileState.data = mergedData`
2. `localFileState.originalData = structuredClone(mergedData)`
3. `localFileState.isDirty = false`
4. `localFileState.isInitializing = true` (allow normalisation)
5. Update `sha` and `lastSynced`
6. Write both IDB records
7. Schedule `completeInitialization()` after 500ms

## DiffService

**Location**: `src/services/DiffService.ts`

DiffService is **scenario-specific**, not file-level merge. It computes diffs in scenario parameters:

- `computeDiff()`: sparse diff between current and base params (modes: `'all'` or `'differences'`)
- `diffEdgeParams()`: probabilities, weights, costs, conditional probabilities
- `diffNodeParams()`: entry weights, costs, case variants
- Epsilon threshold for numeric comparisons (default 1e-6)

Used by the scenario system, not the pull/merge flow.

## Parse Validation

After text-level merge, the merged content is parsed to verify it produces valid YAML/JSON. If parsing fails, the result is downgraded to a conflict even if the merge algorithm reported no conflicts. Safety net against structurally-valid but semantically-broken merges.

## Key Design Decisions

1. **Dual strategy**: text for YAML (simple, safe), structural for JSON (understands semantics)
2. **Conservative conflict reporting**: parse errors after merge are treated as conflicts
3. **Base version stored**: `originalData` tracks last pulled/committed state for accurate 3-way merge
4. **Clean-update optimisation**: if local has no changes, skip merge entirely (fast-forward)
5. **Dirty-state propagation**: only `'local'` and `'manual'` resolutions mark files dirty

## Key Files

| File | Role |
|------|------|
| `src/services/mergeService.ts` | `merge3Way` (text) and `mergeJson3Way` (structural) |
| `src/services/conflictResolutionService.ts` | Apply resolution choices to files |
| `src/services/DiffService.ts` | Scenario-specific diffing (not merge) |
| `src/components/modals/MergeConflictModal.tsx` | Conflict resolution UI |
| `src/services/workspaceService.ts` | Pull flow that triggers merge |
