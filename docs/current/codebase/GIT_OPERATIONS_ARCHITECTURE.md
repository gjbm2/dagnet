# Git Operations Architecture

How DagNet manages repository operations: clone, pull, push, commit, rollback, and branch management via the GitHub API.

## Service Layering

```
TIER 1: UI Entry Points (repositoryOperationsService.ts)
  pullLatest(), commitFiles(), cloneWorkspace(), getStatus(), discardLocalChanges()
      |
      v  delegates to
TIER 2: Workspace/Sync Logic (workspaceService.ts)
  pullLatest(gitCreds), cloneWorkspace(gitCreds), checkRemoteAhead(gitCreds)
      |
      v  uses
TIER 3: GitHub API (gitService.ts + Octokit)
  commitAndPushFiles(), getRepositoryTree(), getFileContent(), createBlob/Tree/Commit
```

**Principle**: UI components call Tier 1 only. Tier 1 resolves credentials, then delegates to Tier 2. Tier 2 orchestrates sync logic (SHA comparison, 3-way merge). Tier 3 makes raw GitHub API calls.

## Operations Supported

### Pull

| Method | Behaviour |
|--------|-----------|
| `pullLatest(repository, branch)` | Incremental pull with 3-way merge and conflict detection |
| `pullLatestRemoteWins(repository, branch)` | Auto-resolve conflicts by accepting remote |
| `pullFile(fileId, repository, branch)` | Pull single file with merge |
| `pullAtCommit(repository, branch, commitSha)` | Rollback to specific commit |

### Push

| Method | Behaviour |
|--------|-----------|
| `commitFiles(files[], message, branch, repository, ...)` | Atomic multi-file commit with hash guard |

### Repository

| Method | Behaviour |
|--------|-----------|
| `cloneWorkspace(repository, branch)` | Mirror entire remote repo to IndexedDB |
| `forceFullReload(...)` | Hard reload: delete workspace and re-clone |

### Metadata & Status

| Method | Behaviour |
|--------|-----------|
| `getStatus(repository, branch)` | Count dirty/local-only files |
| `getRemoteHeadSha(branch)` | Get current HEAD commit |
| `getRepositoryTree(branch, recursive)` | Fetch entire tree in one API call |
| `checkRemoteAhead(repository, branch)` | Compare local/remote SHAs |
| `getRepositoryCommits(branch, perPage)` | Fetch commit history |
| `getFileHistory(path, branch)` | Commit history for a single file |

### Branch Management

| Method | Behaviour |
|--------|-----------|
| `createBranch(newBranchName, sourceBranch)` | Create new branch from existing |
| `mergeBranch(headBranch, baseBranch)` | Merge via GitHub API (detects conflicts) |
| `getBranches()` | List all branches |

## Credentials & Authentication

### Credential hierarchy (exclusive, no blending)

Precedence is strict -- only ONE source is used:

1. **URL credentials** (temporary): `?credentials={base64-encoded-json}`, one-shot, cleared after use
2. **System secret credentials** (CI/CD): opt-in via `DAGNET_LOCAL_E2E_CREDENTIALS=1`
3. **IndexedDB credentials** (persistent): from `db.credentials` store, persisted after OAuth flow
4. **Public access** (fallback): read-only, no auth

### OAuth flow

- `githubOAuthService.startOAuthFlow(repoName)` initiates
- `githubOAuthService.consumeOAuthReturn()` decodes URL fragment on return
- `githubOAuthService.applyOAuthToken(data)` stores in IndexedDB
- `githubOAuthService.shouldShowAuthExpiredModal()` validates post-init

### Setting credentials in GitService

Each operation that switches repos must call `gitService.setCredentials()` to reset Octokit's auth token. Failing to do so causes silent failures (wrong repo, wrong token).

## Atomic Commit (Git Data API)

Instead of sequential file updates (fragile, creates orphans), DagNet uses the Git Data API for all-or-nothing commits:

1. **Check remote ahead**: compare `workspace.commitSHA` with remote HEAD
   - If ahead: show triple-choice dialog (Pull Now / Proceed Anyway / Cancel)
2. **Collect dirty files**: `db.getDirtyFiles()` filtered by workspace prefix
3. **Hash guard** (if enabled): detect hash-breaking changes, offer to create `hash-mappings.json` entries
4. **Create blobs**: upload file content (6 concurrent requests)
5. **Create tree**: reference all blobs (base_tree ensures unchanged files persist)
6. **Create commit**: point tree to parent commit
7. **Update ref**: move branch pointer to new commit
8. **Post-commit sync**: `markSaved()` for each file, update `workspace.commitSHA`

## Incremental Pull (SHA Comparison)

1. Compare local SHAs (IDB) with remote tree
2. Only fetch changed/new files (parallel blob fetches, 6 concurrent)
3. For files with local changes: 3-way merge (see MERGE_CONFLICT_RESOLUTION.md)
   - JSON files: structural merge (key-by-key)
   - YAML/text files: line-level merge
4. On merge conflict: return conflict object, don't auto-resolve
5. Delete files removed remotely
6. Update `workspace.lastSynced`

## Non-Blocking Pull

**Purpose**: when remote is ahead, show a countdown toast and auto-pull without blocking the UI.

### Flow

1. Register 'countdown' operation in OperationsToast
2. Start 15-second countdown via `countdownService`
3. Subscribe to countdown ticks (update toast display)
4. User can pause/resume/cancel via toast buttons
5. On countdown expire: execute `repositoryOperationsService.pullLatest()`
6. If conflicts: mark toast as 'error', show action button, call `onConflicts()`
7. If success: mark toast as 'complete', call `onComplete()`

### Design decisions

- Uses `pullLatest()` (3-way merge), **not** `pullLatestRemoteWins()` -- preserves user's uncommitted changes
- No cascade on conflict: `onComplete()` only called on zero-conflict success
- Pause/resume uses `timerActive` flag to prevent re-entry

## File Sync Model

### GitHub --> Local (clone)

```
GitHub Tree API (one call, recursive)
  --> Fetch all blobs in parallel (6 concurrent)
  --> Decode base64, parse YAML/JSON leniently
  --> Write to IDB with workspace prefix: "repo-branch-fileId"
  --> Add unprefixed to FileRegistry
```

### Local --> GitHub (commit)

```
Collect dirty files from IDB (db.getDirtyFiles() + prefix filter)
  --> Create blobs via Git Data API
  --> Create tree --> Create commit --> Update ref
  --> markSaved() for each file
  --> Update workspace.commitSHA
```

### Lenient YAML parsing

Remote YAML files (from Python pipeline) may have duplicate keys. Parse errors for duplicate keys are suppressed; only real parse errors cause failures.

## Error Handling

### Authentication errors (401)

- `GitService` throws `GitAuthError` on 401 responses
- `rethrowIfAuthError()` checks all API responses
- Callers dispatch `gitAuthExpired` event, triggering app-level login modal

### Rate limiting

- Octokit throttle plugin catches rate-limit errors
- Auto-retries only if wait < 30 seconds
- OperationsToast shows ticking countdown so user sees the delay
- Session log: `GIT_RATE_LIMIT` warning with reset time

### Merge conflicts

See MERGE_CONFLICT_RESOLUTION.md for full details.

## Session Logging

All git operations log hierarchically to `sessionLogService`:

```
GIT_PULL (parent)
  +-- PULL_NEW: New file: parameters/channel.yaml
  +-- PULL_CHANGED: Updated: graphs/funnel.json
  +-- PULL_DELETED: Removed: nodes/old-node.yaml
  = success: Pulled 3 files
```

Operation types: `'git'` for all git operations.

## Key Files

| File | Role |
|------|------|
| `src/services/repositoryOperationsService.ts` | UI entry points (Tier 1) |
| `src/services/workspaceService.ts` | Workspace sync logic (Tier 2) |
| `src/services/gitService.ts` | GitHub API via Octokit (Tier 3) |
| `src/services/graphGitService.ts` | Graph-specific git wrapper |
| `src/services/nonBlockingPullService.ts` | Auto-pull with countdown UI |
| `src/services/githubOAuthService.ts` | OAuth flow and token persistence |
| `src/lib/credentials.ts` | Credential loading and precedence |
| `src/services/mergeService.ts` | 3-way merge (used by pull) |
