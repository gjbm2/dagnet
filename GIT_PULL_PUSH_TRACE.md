# Git Pull/Push Code Path Trace

## Summary

✅ **PULL**: Single code path, properly implemented  
⚠️ **PUSH/COMMIT**: TWO code paths - one working, one BROKEN (dead code)

---

## PULL Code Path (✅ Working)

### UI Entry Points
1. **FileMenu.tsx** → `handlePullLatest()` (line 169)
2. **RepositoryMenu.tsx** → `handlePullLatest()` (line 85)
3. **GitMenu.tsx** → `handlePull()` (line 35) - **STUB ONLY** (just console.log)

### Service Chain (Single Path)

```
FileMenu/RepositoryMenu.handlePullLatest()
    ↓
repositoryOperationsService.pullLatest(repository, branch)
    ↓
workspaceService.pullLatest(repository, branch, gitCreds)
    ↓
gitService.getRepositoryTree(branch, recursive=true)  ← Fetch all files/SHAs
    ↓
gitService.getBlobContent(sha)  ← Fetch changed file contents (parallel)
```

### Implementation Details

**workspaceService.pullLatest()** (lines 530-910):
1. Load local files from IndexedDB with their SHAs
2. Fetch remote tree via `gitService.getRepositoryTree()`
3. Compare local SHA vs remote SHA for each file
4. Only fetch changed/new files via `gitService.getBlobContent()`
5. Perform 3-way merge if local file is dirty
6. Update IndexedDB with new file contents and SHAs
7. Delete files removed from remote
8. Return conflicts if any

**Graph Files:**
- Included in pull (filtered by `graphs/` directory and `.json` extension)
- Parsed as JSON after fetching
- Stored in IndexedDB with correct SHA
- Subject to 3-way merge if locally modified

---

## PUSH/COMMIT Code Paths

### ⚠️ PROBLEM: TWO DIFFERENT CODE PATHS

---

### Path #1: CommitModal → gitService.commitAndPushFiles (✅ WORKING)

**UI Entry Points:**
1. **FileMenu.tsx** → `handleCommitFiles()` (line 219)
2. **RepositoryMenu.tsx** → `handleCommitFiles()` (line 176)

**Service Chain:**

```
FileMenu/RepositoryMenu.handleCommitFiles(files, message, branch)
    ↓
gitService.commitAndPushFiles(files, message, branch)
    ↓
For each file:
    gitService.makeRequest(`/contents/${file.path}?ref=${branch}`)  ← Fetch current SHA
    gitService.createOrUpdateFile(path, content, message, branch, sha)
        ↓
        makeRequest(`/contents/${path}`, PUT, body)  ← GitHub API commit
```

**Implementation (gitService.ts, lines 427-544):**
1. Loop through each file
2. Fetch current SHA from GitHub (to prevent 409 conflicts)
3. Call `createOrUpdateFile()` which uses Contents API
4. Each file committed separately (NOT atomic)
5. Mark files as saved via `fileRegistry.markSaved()`

**Graph Files:**
- ✅ Committed via this path
- Content properly formatted as JSON
- Paths include basePath if configured
- SHA tracking works correctly

**Issues:**
- ❌ Not atomic - if one file fails, repo left in inconsistent state
- ❌ Makes N API calls (one per file)
- ❌ Slow for multiple files

---

### Path #2: repositoryOperationsService.pushChanges → gitService.commitFile (❌ BROKEN)

**Status:** DEAD CODE - **NEVER CALLED**

**Would be called from:**
- ❓ No UI entry points found

**Implementation (repositoryOperationsService.ts, lines 186-265):**

```typescript
async pushChanges(repository: string, branch: string, message: string) {
    const dirtyFiles = fileRegistry.getDirtyFiles();
    
    for (const file of dirtyFiles) {
        // Determine file path
        let filePath = file.path;
        if (!filePath) {
            if (file.fileId.endsWith('-index')) {
                filePath = `${file.type}s-index.yaml`;  // ✅ Correct
            } else {
                filePath = `${file.type}s/${file.fileId}.yaml`;  // ✅ Correct
            }
        }
        
        // ❌ BROKEN: gitService.commitFile() DOESN'T EXIST
        await (gitService as any).commitFile(
            filePath, content, message, branch,
            gitCreds.owner, gitCreds.repo, gitCreds.token, file.sha
        );
    }
}
```

**Problems:**
1. ❌ **`gitService.commitFile()` method DOESN'T EXIST**
2. ❌ This code would crash if ever called
3. ❌ Never actually called from anywhere (dead code)
4. ✅ Path construction logic is correct (but unused)

---

## GitService Methods (Actual)

**Methods that DO exist in gitService.ts:**

1. `createOrUpdateFile(path, content, message, branch, sha?, encoding?)` - Single file commit
2. `commitAndPushFiles(files[], message, branch)` - Multiple files (loops over createOrUpdateFile)
3. `deleteFile(path, message, branch)` - Delete a file
4. `getRepositoryTree(branch, recursive)` - Fetch all file SHAs
5. `getBlobContent(sha)` - Fetch file content by SHA
6. `createBlob(content, encoding)` - Create blob (for atomic commits - not used yet)
7. `createTree(tree, baseTree?)` - Create tree (for atomic commits - not used yet)
8. `createCommit(message, tree, parents)` - Create commit (for atomic commits - not used yet)
9. `updateRef(ref, sha)` - Update branch (for atomic commits - not used yet)

**Methods that DON'T exist:**
- ❌ `commitFile()` - **CALLED BY repositoryOperationsService.pushChanges BUT DOESN'T EXIST**

---

## Recommendations

### 1. ✅ Keep Current Commit Flow (Path #1)
The CommitModal → gitService.commitAndPushFiles path works correctly.

### 2. ❌ Remove Dead Code (Path #2)
Delete `repositoryOperationsService.pushChanges()` or fix it to call the correct methods.

**Option A: Delete it** (simplest)
```typescript
// Remove entire pushChanges() method from repositoryOperationsService.ts
```

**Option B: Fix it** (if you want to keep this API)
```typescript
async pushChanges(repository: string, branch: string, message: string) {
    const dirtyFiles = fileRegistry.getDirtyFiles();
    
    // Convert to format expected by commitAndPushFiles
    const files = dirtyFiles.map(file => ({
        fileId: file.fileId,
        path: file.path || (file.fileId.endsWith('-index') 
            ? `${file.type}s-index.yaml` 
            : `${file.type}s/${file.fileId}.yaml`),
        content: typeof file.data === 'string' 
            ? file.data 
            : JSON.stringify(file.data, null, 2),
        sha: file.sha
    }));
    
    // Call existing working method
    await gitService.commitAndPushFiles(files, message, branch);
    
    // Mark files as saved
    for (const file of dirtyFiles) {
        await fileRegistry.markSaved(file.fileId);
    }
}
```

### 3. 🚀 Future: Implement Atomic Commits
The gitService has methods for atomic commits (createBlob, createTree, createCommit, updateRef) but they're not used yet. These would:
- Commit all files in one transaction
- Prevent partial commits on failure
- Be much faster (4+N API calls vs 2N calls)

---

## Graph Files Handling

### Pull (✅ Correct)
- Graphs filtered by `graphs/` directory path
- Extension: `.json`
- Parsed via `JSON.parse()`
- SHA tracked correctly
- 3-way merge if locally modified

### Push (✅ Correct for working path)
- Content serialized via `JSON.stringify(file.data, null, 2)`
- Path includes basePath if configured
- SHA fetched before commit to prevent conflicts
- Committed via Contents API (PUT /contents/{path})

---

## Verification: Only ONE Active Code Path?

### Pull: ✅ YES
- Only `workspaceService.pullLatest()` is used
- GitMenu.handlePull() is just a stub (not functional)

### Commit/Push: ⚠️ TECHNICALLY YES, BUT...
- Only `gitService.commitAndPushFiles()` is actually functional
- `repositoryOperationsService.pushChanges()` exists but is **DEAD CODE** (calls non-existent method)
- **No UI calls pushChanges()** - it's completely unused

**Conclusion:** One WORKING path, one BROKEN unused path that should be deleted.

