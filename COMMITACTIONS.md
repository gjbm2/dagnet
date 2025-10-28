# Commit Actions Design

## Overview
Simple, extensible commit system supporting pull/push operations with optional branch creation.

**Note**: This design deprecates the existing Git menu in favor of more intuitive File and Repository menu integration.

## UI Integration

### File Menu Integration (File-Level Operations)
- **Pull Latest** - Fetch latest changes from remote
- **Commit Changes** - Open commit modal for dirty files
- **Commit All Changes** - Commit all modified files
- **View History** - Show commit history for current file

### Repository Menu Integration (System-Level Operations)
- **Switch Branch** - Change active branch
- **Create Branch** - Create new branch from current state
- **Promote Treatment** - Promote treatment to baseline (workflow)
- **Merge Branch** - Merge feature branch to main (workflow)
- **Repository Settings** - Manage repository configuration

### Context Menus
- **Tab Right-Click**: Pull Latest, Commit This File, Commit All Changes, View History
- **Navigator Right-Click**: Pull Latest, Commit Selected Files, Commit All Changes
- **Branch Right-Click**: Switch Branch, Merge to Main, Create Branch

### Navigator Header
- **Pull Button** - Quick pull operation (always visible)
- **Commit Button** - Opens commit modal (only when files are dirty)
- **Branch Dropdown** - Shows current branch, allows switching

## Push Modal Design

### Modal Layout
```
┌─────────────────────────────────────────┐
│ Commit Changes                          │
├─────────────────────────────────────────┤
│ Files to commit:                        │
│ ☑ graph-conversion.json                 │
│ ☑ parameter-cost.yaml                   │
│ ☐ context-device.yaml                   │
│                                         │
│ Branch: [main ▼] [+ Create New Branch]  │
│                                         │
│ Commit message:                         │
│ ┌─────────────────────────────────────┐ │
│ │ Fix edge weights and add new param │ │
│ └─────────────────────────────────────┘ │
│                                         │
│ [Cancel]              [Commit & Push]   │
└─────────────────────────────────────────┘
```

### File Selection
- **Auto-detect**: Show all modified files (dirty state)
- **Multi-select**: Checkboxes for each file
- **File types**: Graph, parameter, context, case files only
- **Exclude**: Credentials, settings (handled separately)

### Branch Selection
- **Dropdown**: Show available branches from credentials
- **Default**: Current branch from navigator state
- **Create New**: Button opens subflow for new branch creation

### New Branch Subflow
```
┌─────────────────────────────────────────┐
│ Create New Branch                       │
├─────────────────────────────────────────┤
│ Branch name:                            │
│ ┌─────────────────────────────────────┐ │
│ │ feature/new-conversion-logic        │ │
│ └─────────────────────────────────────┘ │
│                                         │
│ Base branch: [main ▼]                   │
│                                         │
│ [Cancel]              [Create Branch]   │
└─────────────────────────────────────────┘
```

## Implementation Architecture

### Components
- `CommitModal.tsx` - Main commit dialog
- `BranchSelector.tsx` - Branch dropdown + create new
- `FileSelector.tsx` - File selection with checkboxes
- `NavigatorActions.tsx` - Pull/commit buttons in navigator header
- `TabContextMenu.tsx` - Right-click menu for tabs
- `NavigatorContextMenu.tsx` - Right-click menu for navigator items

### Services
- `commitService.ts` - Git commit/push operations
- `branchService.ts` - Branch management (list, create)

### State Management
- **Commit state**: Modal open/closed, selected files, branch
- **File state**: Track dirty files per tab (already exists in TabContext)
- **Branch state**: Available branches, current branch (already exists in NavigatorContext)
- **Context menu state**: Which menu is open, selected items

## API Design

### Commit Service
```typescript
interface CommitService {
  // Pull operations
  pull(repo: string, branch: string): Promise<Result<void>>;
  
  // Push operations  
  commitAndPush(files: CommitFile[], message: string, branch: string): Promise<Result<void>>;
  createBranch(repo: string, branchName: string, baseBranch: string): Promise<Result<void>>;
}

interface CommitFile {
  path: string;
  content: string;
  sha?: string; // For updates
}
```

### Git Operations
- **Pull**: `git pull origin <branch>`
- **Commit**: `git add <files>` + `git commit -m "<message>"`
- **Push**: `git push origin <branch>`
- **New Branch**: `git checkout -b <new-branch> <base-branch>`

## Extensibility Points

### Future Features
1. **Checkout**: Add branch switching capability
2. **Merge**: Add merge request creation
3. **History**: Add commit history viewer
4. **Conflicts**: Add conflict resolution UI
5. **Staging**: Add git staging area management

### Extension Hooks
- `onBeforeCommit()` - Pre-commit validation
- `onAfterCommit()` - Post-commit actions
- `onBranchChange()` - Branch switch handlers

## Security Considerations

### Authentication
- Use existing credentials system
- Validate token permissions before operations
- Handle authentication failures gracefully

### File Validation
- Validate file schemas before commit
- Prevent committing invalid YAML/JSON
- Check file size limits

## Error Handling

### Common Scenarios
- **Network failure**: Retry with exponential backoff
- **Authentication error**: Prompt for new credentials
- **Merge conflicts**: Show conflict resolution UI
- **File validation errors**: Highlight invalid files

### User Feedback
- Loading states during operations
- Success/error notifications
- Progress indicators for large commits

## Implementation Phases

### Phase 1a: Basic File Operations
- File selection modal
- Simple commit message
- Push to current branch
- Pull operations
- Branch creation
- **Deprecate Git menu** - Remove existing Git menu items

### Phase 1b: Advanced Operations & Workflows
- Branch checkout/switching
- Promote operations (treatment → baseline)
- Merge operations (branch → main)
- Conflict resolution
- Commit history viewer

### Phase 1c: Advanced Features
- Staging area management
- Merge requests
- Branch comparison
- Automated workflows

## Phase 2: Advanced Operations Design

### Branch Checkout/Switching
**UI Integration:**
- **Repository Menu**: "Switch Branch" → Branch selection modal
- **Navigator Header**: Branch dropdown with checkout option
- **Context Menu**: "Switch to Branch" on branch items

**Behavior:**
- Warn if uncommitted changes exist
- Option to stash changes or commit first
- Refresh all open tabs after branch switch
- Update navigator to show new branch contents

### Promote Operations
**Purpose**: Take a treatment/experiment and make it the new baseline

**UI Integration:**
- **Repository Menu**: "Promote Treatment" (only available for treatment files)
- **Context Menu**: "Promote to Baseline" on treatment files
- **Special Modal**: Promotion confirmation with impact analysis

**Promote Modal:**
```
┌─────────────────────────────────────────┐
│ Promote Treatment to Baseline           │
├─────────────────────────────────────────┤
│ Treatment: conversion-rate-treatment    │
│ Current Baseline: conversion-rate-baseline│
│                                         │
│ Impact Analysis:                        │
│ • 3 graphs will be updated             │
│ • 2 parameters will change             │
│ • 1 context will be modified          │
│                                         │
│ Promotion Strategy:                     │
│ ☑ Replace baseline file                │
│ ☑ Update dependent graphs              │
│ ☐ Create backup of current baseline    │
│                                         │
│ Commit message:                         │
│ ┌─────────────────────────────────────┐ │
│ │ Promote treatment to baseline       │ │
│ └─────────────────────────────────────┘ │
│                                         │
│ [Cancel]              [Promote]         │
└─────────────────────────────────────────┘
```

### Merge Operations
**Purpose**: Merge feature branch into main branch

**UI Integration:**
- **Repository Menu**: "Merge Branch" (only when on feature branch)
- **Navigator Header**: "Merge to Main" button (when on feature branch)
- **Branch Context Menu**: "Merge to Main" option

**Merge Modal:**
```
┌─────────────────────────────────────────┐
│ Merge Branch to Main                    │
├─────────────────────────────────────────┤
│ Source Branch: feature/new-conversion   │
│ Target Branch: main                     │
│                                         │
│ Changes to merge:                      │
│ • 2 new graphs                         │
│ • 3 modified parameters                │
│ • 1 updated context                    │
│                                         │
│ Merge Strategy:                        │
│ ☑ Fast-forward merge (if possible)     │
│ ☐ Create merge commit                  │
│ ☐ Squash commits                      │
│                                         │
│ Commit message:                         │
│ ┌─────────────────────────────────────┐ │
│ │ Merge feature/new-conversion to main│ │
│ └─────────────────────────────────────┘ │
│                                         │
│ [Cancel]              [Merge]           │
└─────────────────────────────────────────┘
```

### Conflict Resolution
**When Conflicts Occur:**
- Show conflict resolution modal
- Side-by-side diff view
- Options: Accept incoming, keep current, manual edit
- Preview resolution before applying

**Conflict Resolution Modal:**
```
┌─────────────────────────────────────────┐
│ Resolve Merge Conflicts                 │
├─────────────────────────────────────────┤
│ File: conversion-rate-baseline.yaml     │
│                                         │
│ ┌─────────────┬─────────────┬─────────┐ │
│ │ Current     │ Resolution  │ Incoming│ │
│ │ (main)      │             │ (branch)│ │
│ ├─────────────┼─────────────┼─────────┤ │
│ │ conversion: │ conversion: │conversion:│ │
│ │   rate: 0.15│   rate: 0.18│   rate: │ │
│ │   cost: 0.05│   cost: 0.05│   0.05  │ │
│ └─────────────┴─────────────┴─────────┘ │
│                                         │
│ [Keep Current] [Accept Incoming] [Edit] │
│                                         │
│ [Cancel]              [Resolve All]     │
└─────────────────────────────────────────┘
```

### Commit History Viewer
**UI Integration:**
- **File Menu**: "View History" (for current file)
- **Repository Menu**: "Repository History" (for entire repo)
- **Context Menu**: "Show History" on files
- **Navigator**: "History" tab/section

**History View:**
- Timeline of commits affecting current file/repo
- Diff view for each commit
- Branch visualization
- Quick checkout to specific commits

## Advanced Operations Architecture

### Services
- `branchService.ts` - Branch operations (checkout, merge, promote)
- `conflictService.ts` - Conflict detection and resolution
- `historyService.ts` - Commit history and diff operations
- `promotionService.ts` - Treatment promotion logic

### Components
- `BranchCheckoutModal.tsx` - Branch switching interface
- `PromoteModal.tsx` - Treatment promotion workflow
- `MergeModal.tsx` - Branch merge interface
- `ConflictResolutionModal.tsx` - Conflict resolution UI
- `HistoryViewer.tsx` - Commit history timeline
- `DiffViewer.tsx` - Side-by-side diff display

### State Management
- **Branch state**: Current branch, available branches, checkout in progress
- **Conflict state**: Active conflicts, resolution choices
- **History state**: Commit timeline, selected commit, diff view
- **Promotion state**: Treatment analysis, promotion strategy

## Workflow Integration

### Treatment Promotion Workflow
1. User selects treatment file
2. System analyzes dependencies and impact
3. User confirms promotion strategy
4. System creates backup of current baseline
5. System updates baseline and dependent files
6. System commits changes with descriptive message

### Branch Merge Workflow
1. User initiates merge from feature branch
2. System analyzes changes and conflicts
3. If conflicts exist, show resolution interface
4. User resolves conflicts or chooses strategy
5. System performs merge operation
6. System updates branch status and notifications

### Branch Checkout Workflow
1. User selects target branch
2. System checks for uncommitted changes
3. If changes exist, offer stash/commit options
4. System switches branch and refreshes UI
5. System updates all open tabs and navigator
