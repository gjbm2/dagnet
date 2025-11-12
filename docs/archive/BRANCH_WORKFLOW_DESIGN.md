 # Branch Workflow & Checkout Design

## Overview

This document explores how branch operations will work and their impact on UI/UX, particularly Navigator display and file state indicators.

## Part 1: Branch Workflow Scenarios

### Scenario 1: Single Branch (Current/Simple)

**Pattern**: Everyone works on `main`

```
User workflow:
1. Open app → clones main to local workspace
2. Edit files → marked dirty
3. Commit → push to main
4. Pull → fetch others' changes
```

**Branching**: None
**UI Complexity**: Low
**Suitable for**: Small teams, simple projects

### Scenario 2: Feature Branches (Standard Git Flow)

**Pattern**: Branch per feature, PR to merge

```
User workflow:
1. Work on main
2. Create feature branch: feature/new-parameters
3. Edit files, commit to feature branch
4. Push feature branch to remote
5. Open PR: feature/new-parameters → main
6. After merge, delete feature branch
7. Switch back to main, pull
```

**Branching**: Frequent (per feature)
**UI Complexity**: Medium
**Suitable for**: Teams with code review, standard Git flow

**Key questions**:
- When user switches to feature branch, what happens to workspace?
- How do we show "this file is ahead of main"?
- How do we handle files that exist in feature but not in main?

### Scenario 3: Personal Working Branches (GitFlow-style)

**Pattern**: Each developer has their own branch

```
User workflow:
1. Always work on reg/working branch
2. Periodically merge main → reg/working
3. Cherry-pick or merge commits from reg/working → main
4. Never directly edit main
```

**Branching**: Persistent personal branches
**UI Complexity**: Medium-High
**Suitable for**: Developers who want isolation

### Scenario 4: Multi-Branch Comparison

**Pattern**: Compare files across branches

```
User workflow:
1. Working on main
2. Want to see what's in feature/experiment branch
3. Switch to view feature/experiment (read-only?)
4. Compare parameters between branches
5. Merge specific changes
```

**Branching**: Viewing multiple branches
**UI Complexity**: High
**Suitable for**: Advanced users, large teams

## Part 2: Branch Operations Analysis

### Operation: Checkout (Switch Branch)

#### Option A: Flush & Re-clone (Simpler)

```
User clicks: Branch → switch to feature/new-params
  ↓
Check for dirty files
  ↓
If dirty: Show warning (same as repo switch)
  ↓
User confirms (or commits first)
  ↓
1. Close all tabs
2. Clear workspace
3. Clone from new branch
4. Reload Navigator
```

**Pros**:
- Simple to implement
- No merge conflicts possible
- Clean state every time

**Cons**:
- Loses uncommitted work (must commit first)
- Slower (re-clone everything)
- No ability to "stash" changes

**Suitable for**: Infrequent branch switching (Scenario 1, some of 2)

#### Option B: Git Checkout (Complex)

```
User clicks: Branch → switch to feature/new-params
  ↓
Check for dirty files
  ↓
For each dirty file:
  - If file unchanged in target branch: Keep local changes
  - If file changed in target branch: CONFLICT
  ↓
If conflicts: Show conflict resolution UI
  ↓
If no conflicts: Switch branches, keep working
```

**Pros**:
- Faster (no re-clone)
- Can keep uncommitted work
- Real Git-style workflow

**Cons**:
- Complex conflict resolution UI needed
- Risk of losing work if bugs
- Harder to reason about file states

**Suitable for**: Frequent branch switching (Scenarios 2, 3, 4)

#### Recommendation: Phase 1 = Option A, Phase 2 = Option B

Start simple (flush & re-clone), add smart checkout later.

### Operation: Push to Branch, PR to Main

#### Workflow

```
User working on: feature/new-parameters branch

1. Edit parameter files
2. Commit locally
3. Push to remote: feature/new-parameters
4. (Outside app) Open PR on GitHub: feature/new-parameters → main
5. (Outside app) PR reviewed and merged
6. (In app) Switch back to main
7. Pull main to get merged changes
```

#### What App Needs to Support

**Minimum (Phase 1)**:
- Commit & push to current branch
- Branch indicator showing current branch
- Switch branch (with flush)

**Nice to Have (Phase 2)**:
- Show if local branch is ahead/behind remote
- Show if branch has open PR
- Integrate PR status from GitHub API
- One-click "Create PR" button

**Advanced (Phase 3)**:
- In-app PR review
- Merge conflicts resolution UI
- Branch comparison view

## Part 3: File State Matrix (Branch-Aware)

### Current States (No Branch Awareness)

| State | Visual | Meaning |
|-------|--------|---------|
| Clean remote | Normal text | In sync with remote |
| Dirty | Orange dot | Local changes |
| Local only | Italic + (local) | Not committed |
| Open | Blue dot | Has open tab |

### Enhanced States (Branch-Aware)

| State | Visual | Meaning |
|-------|--------|---------|
| Clean (on branch) | Normal text | In sync with current branch |
| Dirty (on branch) | Orange dot | Local changes |
| Local only (on branch) | Italic + (local) | Not committed to current branch |
| Ahead of main | Green up arrow ↑ | Committed to branch, not in main yet |
| Behind main | Red down arrow ↓ | Main has newer version |
| Diverged | Yellow warning ⚠️ | Both branch and main have changes |
| Different in main | Blue dot ◉ | Exists in main but different |
| Only in branch | Branch badge (branch) | Only exists in this branch |
| Only in main | Faded text | Exists in main, not in branch |

### Visual Examples

```
Working on branch: feature/new-params

Parameters (in Navigator):
├─ conversion-rate              ● ●  ← Dirty + Open (normal)
├─ email-signup              (local) ← Local only (new param)
├─ checkout-rate                  ↑  ← Committed to branch, ahead of main
├─ abandoned-rate                 ↓  ← Behind main (main has newer version)
├─ legacy-param                  ⚠️  ← Diverged (conflict potential)
└─ main-only-param          (faded) ← Only in main, not in branch
```

### Complexity Assessment

**Low Complexity** (Phase 1):
- Just show current branch name
- All other states work as before (dirty, local, open)
- No cross-branch comparison

**Medium Complexity** (Phase 2):
- Show ahead/behind indicators (↑ ↓)
- Fade items that exist in main but not in current branch
- Show (branch) badge for branch-only items

**High Complexity** (Phase 3):
- Full divergence detection (⚠️)
- Conflict resolution UI
- Side-by-side branch comparison

## Part 4: Branch Selector Placement

### Question: Navigator Header or Menu?

**Factors to consider**:

| Factor | Navigator Header | Repository Menu |
|--------|------------------|-----------------|
| **Access frequency** | High visibility, quick access | Hidden, intentional action |
| **Screen space** | Takes up permanent space | No space cost |
| **User expectation** | "Current context" indicator | "Major operation" |
| **Consistency** | Like VS Code, Git tools | Like repo switching |

### Usage Frequency Analysis

| Scenario | Branch Switches per Day | Recommendation |
|----------|------------------------|----------------|
| Single main branch | 0-1 | Menu |
| Feature branches | 2-5 | Header or Menu |
| Personal branches | 5-10 | Header |
| Multi-branch workflow | 10+ | Header (essential) |

### Proposed Solution: Adaptive

#### Phase 1: Menu Only (Simple)
```
Navigator header:
[🔍 Search...]  [⚙️]

Repository menu:
├─ Switch Repository...
├─ Switch Branch...     ← In menu
├─ Pull Latest
└─ ...
```

**When**: Single branch workflow, rare switching

#### Phase 2: Header with Smart Display (Advanced)
```
Navigator header:
Branch: feature/new-params ↑2 ↓1  [Switch...]
         ↑                 ↑  ↑
    Current branch    Ahead Behind
```

**When**: Multi-branch workflow, frequent switching

**Smart display**:
- Shows current branch name
- Shows ahead/behind counts (↑2 = 2 commits ahead of main)
- Click to switch (opens modal)

#### Phase 3: Full Branch UI (Pro)
```
Navigator header:
Branch: [feature/new-params ▾]     ← Dropdown
  ├─ feature/new-params ●          ← Current
  ├─ main                          
  ├─ feature/experiment
  └─ Create New Branch...

Status: ↑2 ↓1  [Pull] [Push]      ← Quick actions
```

**When**: Power users, heavy branch usage

### Recommendation: Start with Phase 1

For now:
- Branch in **Repository menu** (rare operation)
- Flush & re-clone on switch (simple, safe)
- No branch state indicators (keep current visual treatment)
- Add phases 2 & 3 when usage patterns emerge

## Part 5: Checkout Implementation Strategy

### Phase 1: Simple Checkout (Flush Model)

```typescript
async function switchBranch(newBranch: string): Promise<void> {
  // 1. Same as repository switch
  const dirtyFiles = fileRegistry.getAllDirty();
  
  if (dirtyFiles.length > 0) {
    const action = await showSwitchBranchModal({
      currentBranch: state.selectedBranch,
      newBranch: newBranch,
      dirtyFiles: dirtyFiles,
      availableBranches: await gitService.listBranches()
    });
    
    if (!action) return;
    
    if (action.commitFirst) {
      await commitAll("Pre-branch-switch commit", state.selectedBranch);
    }
  }
  
  // 2. Flush workspace
  await tabContext.closeAllTabs(true);
  await db.files.clear();
  fileRegistry.clear();
  
  // 3. Clone from new branch
  await cloneRepository(state.selectedRepo, newBranch);
  
  // 4. Update state
  setState({ selectedBranch: newBranch });
  
  // 5. Reload Navigator
  await loadWorkspace();
  
  showNotification(`Switched to branch ${newBranch}`);
}
```

**Result**: Works exactly like repository switch, just changes branch parameter

### Phase 2: Smart Checkout (Preserve Local Changes)

```typescript
async function smartCheckout(newBranch: string): Promise<void> {
  // 1. Get current workspace state
  const localFiles = fileRegistry.getAll();
  const dirtyFiles = localFiles.filter(f => f.isDirty);
  
  // 2. Fetch new branch file tree
  const newBranchFiles = await gitService.listFiles(state.selectedRepo, newBranch);
  
  // 3. Detect conflicts
  const conflicts = [];
  for (const dirtyFile of dirtyFiles) {
    const newBranchVersion = newBranchFiles.find(f => f.path === dirtyFile.source.path);
    if (newBranchVersion && newBranchVersion.sha !== dirtyFile.source.sha) {
      // File changed in new branch AND locally modified
      conflicts.push({
        file: dirtyFile,
        localChanges: true,
        branchChanges: true
      });
    }
  }
  
  // 4. Handle conflicts
  if (conflicts.length > 0) {
    const resolution = await showConflictModal(conflicts);
    if (!resolution) return; // User cancelled
    
    // Apply resolution (keep local, use branch, or manual merge)
    for (const conflict of conflicts) {
      await resolveConflict(conflict, resolution[conflict.file.fileId]);
    }
  }
  
  // 5. Switch branch (keep compatible files)
  for (const file of localFiles) {
    if (!dirtyFiles.includes(file)) {
      // Clean file, load from new branch
      const newVersion = newBranchFiles.find(f => f.path === file.source.path);
      if (newVersion) {
        await fileRegistry.updateFromRemote(newVersion);
      } else {
        // File doesn't exist in new branch
        file.onlyInOldBranch = true; // Mark for user awareness
      }
    }
  }
  
  // 6. Update state and reload
  setState({ selectedBranch: newBranch });
  await navigatorContext.refresh();
}
```

**Result**: Preserves local changes, handles conflicts, faster

### Phase 3: Git-Style with Stash

```typescript
async function gitStyleCheckout(newBranch: string): Promise<void> {
  // 1. Offer to stash changes
  const dirtyFiles = fileRegistry.getAllDirty();
  
  if (dirtyFiles.length > 0) {
    const action = await showCheckoutModal({
      options: ['Commit', 'Stash', 'Discard', 'Cancel']
    });
    
    switch (action) {
      case 'Commit':
        await commitAll("Pre-checkout commit", state.selectedBranch);
        break;
      case 'Stash':
        await stashChanges(dirtyFiles);
        break;
      case 'Discard':
        for (const file of dirtyFiles) {
          await fileRegistry.revertFile(file.fileId);
        }
        break;
      case 'Cancel':
        return;
    }
  }
  
  // 2. Checkout (preserving non-conflicting changes)
  await smartCheckout(newBranch);
  
  // 3. If had stash, offer to apply
  if (action === 'Stash') {
    const apply = await showConfirm({
      title: 'Apply Stashed Changes?',
      message: 'Apply your stashed changes to the new branch?'
    });
    
    if (apply) {
      await applyStash();
    }
  }
}
```

**Result**: Full Git-style workflow with stash support

## Part 6: Visual Treatment Requirements

### Branch Indicator in Navigator Header

**Phase 1 (Minimal)**:
```
Repository menu > Current Branch: main
(No header indicator)
```

**Phase 2 (Contextual)**:
```
┌─────────────────────────────────────┐
│ Navigator                           │
├─────────────────────────────────────┤
│ Branch: main           [Switch...]  │
├─────────────────────────────────────┤
```

**Phase 3 (Rich)**:
```
┌─────────────────────────────────────┐
│ Navigator                           │
├─────────────────────────────────────┤
│ Branch: feature/new ↑2 ↓1  [Pull]  │
│                      ↑  ↑            │
│                  Ahead Behind        │
├─────────────────────────────────────┤
```

### File State Indicators

**Phase 1**: Current indicators (no branch awareness)
- Normal text (clean)
- Italic (local)
- Orange dot (dirty)
- Blue dot (open)

**Phase 2**: Add ahead/behind (if on non-main branch)
- ↑ (ahead of main)
- ↓ (behind main)

**Phase 3**: Full cross-branch state
- ⚠️ (diverged)
- (branch) (only in this branch)
- Faded (exists in other branches)

### CSS Additions Needed

```css
/* Branch indicators */
.file-ahead-main {
  &::after {
    content: "↑";
    color: var(--color-success);
    margin-left: 4px;
  }
}

.file-behind-main {
  &::after {
    content: "↓";
    color: var(--color-warning);
    margin-left: 4px;
  }
}

.file-diverged {
  &::after {
    content: "⚠️";
    margin-left: 4px;
  }
}

.file-branch-only {
  &::after {
    content: "(branch)";
    color: var(--text-muted);
    font-size: 0.9em;
    margin-left: 4px;
  }
}

.file-other-branch {
  opacity: 0.5;
  font-style: italic;
}
```

## Part 7: Recommendations

### Immediate (Phase 1)
1. **Branch in Repository menu** - rare operation, no header clutter
2. **Flush & re-clone on switch** - simple, safe, works
3. **No branch indicators** - keep current visual treatment
4. **Commit first modal** - same as repo switch

### Near-Term (Phase 2 - when branch usage grows)
1. **Add branch to Navigator header** - if users switch frequently
2. **Show ahead/behind counts** - if on feature branch
3. **Smart checkout** - preserve local changes
4. **Branch-only indicators** - (branch) badge for clarity

### Long-Term (Phase 3 - power users)
1. **Full conflict resolution UI**
2. **Stash support**
3. **Cross-branch comparison**
4. **PR integration**

## Part 8: Decision for Current Design

Based on this analysis:

### Navigator Header (Revised)

**Recommendation**: No branch indicator for Phase 1

```
┌─────────────────────────────────────┐
│ Navigator                      [×]  │
├─────────────────────────────────────┤
│ [🔍 Search...]              [⚙️]   │  ← Just search & filters
├─────────────────────────────────────┤
│ 📊 Parameters (18 + 5)        🔍●  │
│ ...                                 │
```

Branch access via:
```
Repository menu:
├─ Switch Repository...
├─ Switch Branch...       ← Here
├─ Pull Latest
└─ Push Changes
```

### Visual Treatment (Unchanged)

Keep current states for Phase 1:
- Normal text (clean)
- Italic + (local) (local only)
- Orange dot ● (dirty)
- Blue dot ● (open)
- Gray + [create] (index only)
- ⚠️ (orphan)

No branch-aware indicators yet - add when needed.

### Future: Branch Header Returns

When usage patterns show frequent branch switching:

```
┌─────────────────────────────────────┐
│ Navigator                      [×]  │
├─────────────────────────────────────┤
│ Branch: main          [Switch...]  │  ← Add back when needed
├─────────────────────────────────────┤
│ [🔍 Search...]              [⚙️]   │
├─────────────────────────────────────┤
```

But not initially - YAGNI principle.

---

**Document Version**: 1.0  
**Date**: October 29, 2025  
**Status**: Design Document  
**Priority**: MEDIUM (Phase 2+)  
**Current Phase**: Phase 1 (simple, menu-based)

