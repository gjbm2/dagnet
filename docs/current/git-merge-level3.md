# Git Merge — Level 3: Full Client-Side Conflict Resolution

**Status:** Plan  
**Date:** 13-Feb-26  
**Depends on:** Level 1 (merged — GitHub merge API with conflict-abort UX)

---

## 1. Goal

Replace the Level 1 "conflicts detected — go to GitHub" dead-end with a complete
in-app merge flow:

1. User picks head and base branches.
2. App detects whether the merge is clean or conflicted **before** touching either branch.
3. If clean, create a merge commit on the remote (same as Level 1).
4. If conflicted, present the existing `MergeConflictModal` for per-file resolution,
   then create a merge commit from the resolved content.
5. After merge, intelligently sync the local workspace (no full re-clone).

The existing pull-conflict infrastructure (`merge3Way`, `MergeConflictModal`,
`conflictResolutionService`) handles the hard parts. The work here is
**orchestration**: fetching the right content, finding the merge base, driving the
resolution flow, and creating a two-parent merge commit via the Git Data API.

---

## 2. Existing Infrastructure (already built)

| Component | File | What it does |
|---|---|---|
| 3-way merge algorithm | `services/mergeService.ts` | Line-level `merge3Way(base, local, remote)` with conflict markers |
| Conflict resolution UI | `components/modals/MergeConflictModal.tsx` | Monaco DiffEditor, three view modes, per-file keep-local / use-remote / manual |
| Resolution application | `services/conflictResolutionService.ts` | Applies user choices back to IDB + FileRegistry |
| Pull-merge orchestration | `services/workspaceService.ts` `pullLatest()` | Fetches remote tree, compares SHAs, runs `merge3Way`, feeds conflicts to modal |
| GitHub tree fetching | `services/gitService.ts` `getRepositoryTree()` | Fetches full repo tree (SHA + path for every file) in one API call |
| GitHub blob fetching | `services/gitService.ts` `getFileContent()` | Fetches decoded content for a single file |
| Atomic commit | `services/gitService.ts` `commitAndPushFiles()` | Creates tree → commit → updates ref (single-parent only today) |
| Level 1 merge | `services/gitService.ts` `mergeBranch()` | GitHub merge API, returns conflict/success/up-to-date |
| Session logging | `services/sessionLogService.ts` | Structured logging for all git operations |

---

## 3. What Needs To Be Built

### 3.1 Merge-Base Discovery

**Where:** New method `gitService.getMergeBase(branchA, branchB)`

Uses `octokit.repos.compareCommits({ base: branchA, head: branchB })`.
The response includes `merge_base_commit.sha` — this is the common ancestor
we need for 3-way merge.

Single API call, returns one SHA. Straightforward.

### 3.2 Tree Comparison (diff between branches)

**Where:** New helper, likely in a new `services/branchMergeService.ts`

Given three trees (merge-base, head, base), classify every file path into:

- **Unchanged** — same SHA in all three trees → skip
- **Changed on head only** — head SHA differs from merge-base, base matches → auto-accept head version
- **Changed on base only** — base SHA differs from merge-base, head matches → already in base, skip
- **Changed on both sides** — both SHAs differ from merge-base → needs 3-way merge
- **Added on head** — path exists in head but not merge-base → include in merge
- **Added on base** — path exists in base but not merge-base → already in base, skip
- **Added on both** — path added in both but with different SHA → needs 3-way merge
- **Deleted on head** — path exists in merge-base but not head → delete from base
- **Deleted on base** — path exists in merge-base but not base → already deleted, skip
- **Deleted on one, changed on other** — conflict (delete vs modify)

The tree data comes from three `getRepositoryTree()` calls (merge-base SHA, head
branch, base branch). Each returns `{ path, sha, type }` for every file. Building
the diff is pure in-memory comparison — no extra API calls.

### 3.3 Content Fetching for Conflicted Files

For each file classified as "changed on both sides", we need three versions:

- **merge-base version** — fetch blob at merge-base commit
- **head version** — fetch blob at head branch HEAD
- **base version** — fetch blob at base branch HEAD

This uses `gitService.getFileContent()` scoped to the right ref. For efficiency,
batch these with `Promise.all` (respecting rate limits via the existing Octokit
throttling plugin).

Only conflicted files need content fetching. Clean merges (one-side-only changes)
just need the SHA and path — the tree API already gave us that.

### 3.4 Client-Side Merge Execution

For each "changed on both" file, run `merge3Way(mergeBaseContent, baseContent, headContent)`.

- If clean → record the merged content for the merge commit.
- If conflicted → add to the conflicts array for the modal.

Files changed on one side only don't need merge — just carry forward the changed version.

### 3.5 Conflict Resolution Flow

Feed the conflicts into the existing `MergeConflictModal`. The modal already
supports:

- Per-file resolution (keep-local, use-remote, manual)
- Monaco DiffEditor with three comparison modes
- "All resolved" gating before apply

**Adaptation needed:** The modal currently uses the terms "local" and "remote"
in the context of pull (local = your workspace, remote = incoming). For branch
merge, the terminology becomes "base branch" and "head branch". The modal needs
a minor prop to control the labels (e.g. `localLabel` / `remoteLabel`) rather
than hardcoding "LOCAL" / "REMOTE".

After the user resolves all conflicts, we have the final content for every file.

### 3.6 Merge Commit Creation (Two-Parent Commit)

**Where:** New method `gitService.createMergeCommit(...)` or extend
`commitAndPushFiles()`

The existing `commitAndPushFiles()` creates single-parent commits via the Git
Data API:

1. Get base commit SHA
2. Create blobs for each file
3. Create a tree from the blobs
4. Create a commit (single parent)
5. Update the branch ref

For a merge commit, step 4 needs **two parents**: the HEAD of the base branch
and the HEAD of the head branch. The Octokit `git.createCommit` API supports a
`parents` array.

This is a small extension to the existing flow — the blob/tree creation is
identical, only the commit creation call changes.

After the merge commit is created and the base branch ref is updated, the merge
is complete on the remote.

### 3.7 Post-Merge Workspace Sync

If the user is currently on the base (target) branch, the local workspace is now
behind the remote. Rather than a full re-clone:

1. Compare the local workspace SHAs against the new remote tree (same logic as
   `pullLatest` already does).
2. Update only the files that changed.
3. This is exactly what "Pull All Latest" does — so the simplest approach is to
   trigger a pull after a successful merge when the user is on the target branch.

### 3.8 Dirty-Workspace Guard

Before starting a merge where the target is the current branch, check for
uncommitted local changes. If dirty files exist:

- Warn the user that local changes may conflict with the merge result.
- Offer: commit first, discard, or cancel.
- Same pattern as `SwitchBranchModal` already implements.

If the target is **not** the current branch, no guard is needed — the merge
happens entirely on the remote.

---

## 4. New / Modified Files

| File | Change |
|---|---|
| `services/gitService.ts` | Add `getMergeBase()`, `createMergeCommit()` |
| **`services/branchMergeService.ts`** (new) | Orchestration: tree comparison, content fetching, merge execution, commit creation |
| `services/repositoryOperationsService.ts` | Add `mergeBranchWithResolution()` wrapper with session logging |
| `components/modals/MergeBranchModal.tsx` | Upgrade from Level 1 abort-on-conflict to full resolution flow |
| `components/modals/MergeConflictModal.tsx` | Add `localLabel` / `remoteLabel` props for customisable terminology |
| `hooks/usePullAll.ts` | No change (post-merge sync reuses existing pull) |

---

## 5. API Call Budget

For a typical merge of a repo with ~100 files where 5 files differ between branches:

| Step | API calls | Notes |
|---|---|---|
| Merge-base discovery | 1 | `compareCommits` |
| Fetch three trees | 3 | `getRepositoryTree` × 3 (merge-base, head, base) |
| Fetch content for conflicted files | 0–15 | 3 versions × up to 5 conflicted files (only "both-changed" files) |
| Create blobs | 1–5 | One per changed file |
| Create tree | 1 | |
| Create commit | 1 | Two-parent merge commit |
| Update ref | 1 | |
| **Total** | **~8–27** | Well within GitHub rate limits |

Files changed on one side only don't need content fetching — we can reference
their existing blob SHAs directly in the new tree.

---

## 6. User Flow

### Happy Path (no conflicts)

1. Repository → Merge Branch...
2. User selects head and base branches
3. App shows "Checking for conflicts..." spinner
4. App detects clean merge → creates merge commit on remote
5. Toast: "Merged feature/x → main"
6. If user is on target branch, auto-pulls to sync workspace

### Conflict Path

1. Repository → Merge Branch...
2. User selects head and base branches
3. App shows "Checking for conflicts..." spinner
4. App detects N conflicted files
5. `MergeConflictModal` opens with the conflicted files
6. User resolves each file (keep-base / use-head / manual edit)
7. User clicks "Apply & Merge"
8. App creates merge commit with resolved content
9. Toast: "Merged feature/x → main (N conflicts resolved)"
10. If user is on target branch, auto-pulls to sync workspace

### Already Up To Date

1. Repository → Merge Branch...
2. User selects branches
3. App detects no diff → toast "Already up to date"

---

## 7. Edge Cases

| Case | Handling |
|---|---|
| File deleted on head, modified on base | Conflict — show in modal with "delete" vs "keep modified" options |
| File added on both branches with different content | Conflict — show in modal as normal |
| File added on both branches with same content | Auto-resolve (same SHA) |
| Binary files | Skip merge — warn user, recommend resolving on GitHub |
| Very large files (>1 MB) | Fetch content lazily only when user selects file in modal |
| Empty merge (no differing files) | "Already up to date" toast |
| User cancels during conflict resolution | No changes made to either branch |
| Rate limiting during content fetch | Octokit throttling plugin handles retries automatically |
| Merge-base is one of the branch HEADs (fast-forward) | Detect and offer fast-forward (just update ref, no merge commit) |

---

## 8. Implementation Phases

### Phase A: Orchestration Core

Build `branchMergeService.ts` with:

- `getMergeBase()` wrapper
- `compareBranchTrees()` — classifies files into unchanged / one-side / both-sides / added / deleted
- `fetchConflictContent()` — fetches base/local/remote content for conflicted files
- `executeMerge()` — runs `merge3Way` on each conflicted file, returns clean results + conflicts

Test with integration tests using mocked GitHub responses.

### Phase B: Merge Commit Creation

Extend `gitService.ts`:

- `createMergeCommit()` — creates a two-parent commit via the Git Data API
- Reuses existing blob/tree creation from `commitAndPushFiles()`

### Phase C: UI Integration

- Upgrade `MergeBranchModal` to use the new orchestration service
- Add `localLabel` / `remoteLabel` props to `MergeConflictModal`
- Wire up the full flow: check → resolve → commit → sync
- Add dirty-workspace guard for merges targeting the current branch

### Phase D: Post-Merge Sync

- After successful merge, trigger pull on target branch if it's the current workspace
- Reuse existing `pullLatest` / `usePullAll` infrastructure

### Phase E: Polish and Edge Cases

- Fast-forward detection and handling
- Delete-vs-modify conflict presentation
- Binary file warnings
- Progress indicators during content fetching
- Error recovery (partial failures during commit creation)

---

## 9. Testing Strategy

### Integration Tests (primary)

- Orchestration: tree comparison logic with various file-change combinations
  (both-changed, one-side-only, added, deleted, renamed)
- Merge commit creation: verify two-parent commit is created correctly
- Conflict detection: verify conflicts are correctly identified and content is correct
- Post-merge sync: verify workspace updates after merge

### Existing Tests to Extend

- `mergeService` tests — already cover 3-way merge; add branch-merge-specific
  scenarios (delete-vs-modify, add-on-both)
- `workspaceService` tests — verify post-merge pull works correctly

### Manual Testing

- Merge two branches with no conflicts
- Merge two branches with YAML conflicts (most common in this app)
- Merge two branches with JSON (graph) conflicts
- Merge when target branch is current workspace (verify auto-sync)
- Merge when target branch is not current workspace (verify no workspace impact)
- Cancel during conflict resolution (verify no side effects)
- Merge with dirty workspace (verify guard works)

---

## 10. Risk Assessment

**Low risk:**
- The 3-way merge algorithm and conflict UI are proven in production (pull flow)
- GitHub API calls are well-understood (tree, blob, commit, ref)
- No changes to existing pull flow or workspace management

**Medium risk:**
- Tree comparison logic has edge cases (deletes, renames, nested paths)
  — mitigate with thorough integration tests
- Two-parent merge commit creation is new code
  — mitigate by keeping it close to the existing `commitAndPushFiles` pattern

**Low risk of data loss:**
- The merge only writes to the remote after all conflicts are resolved
- If anything fails during commit creation, neither branch is modified
- The user can always cancel during conflict resolution with no side effects
