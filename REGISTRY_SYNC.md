# Registry Index Synchronization Strategy

## The Problem

Registry indexes (e.g., `parameters-index.yaml`, `nodes-index.yaml`) serve as a lightweight catalog of available items. However, they can become out of sync with the actual files in the repository in several scenarios:

1. **New local file created** - User creates a new parameter via UI, but it's not committed yet
2. **File committed** - Local file is committed to GitHub, should now be in index
3. **File deleted** - User deletes a file from repo, index should be updated
4. **Manual edits** - Someone edits files directly in GitHub without updating index

## Current State

- **Indexes are manually maintained** in the repository
- Local files are tracked separately in `NavigatorContext.localItems`
- `ParameterSelector` combines registry items + local items for display
- No automatic sync mechanism

## Proposed Solution: Hybrid Approach

### Phase 1: Manual Index + Local Overlay (Current) ✅

**What we have now:**
- Registry indexes are **manually curated** and committed to Git
- Local (uncommitted) files are tracked in `NavigatorContext.localItems`
- `ParameterSelector` shows both registry + local items
- On commit, files are pushed but indexes are NOT auto-updated

**Why manual indexes are actually good:**
- Allows **curation**: Not every file needs to be in the index
- Supports **planned items**: Index entry without file (e.g., "coming soon")
- Enables **metadata enrichment**: Index can have tags, descriptions, authors
- **Stable references**: Index entry can exist before/after file

### Phase 2: Commit Hook for Index Update (Recommended Next Step)

When a user commits files via the UI, automatically generate a **proposed index update**:

```typescript
// In CommitModal or gitService.commitAndPushFiles()
async function generateIndexUpdates(committedFiles: CommittedFile[]): Promise<IndexUpdate[]> {
  const updates: IndexUpdate[] = [];
  
  for (const file of committedFiles) {
    const { type, id, data } = file;
    
    // Skip non-registry types (e.g., graphs)
    if (!['parameter', 'context', 'case', 'node'].includes(type)) continue;
    
    const indexFile = `${type}s-index.yaml`;
    
    // Check if this ID is already in the index
    const currentIndex = await loadIndex(indexFile);
    const existingEntry = currentIndex[`${type}s`].find(item => item.id === id);
    
    if (!existingEntry) {
      // New entry - generate from file data
      const newEntry = {
        id: id,
        name: data.name || id,
        description: data.description || '',
        file_path: `${type}s/${id}.yaml`,
        type: data.type, // For parameters
        status: 'active',
        tags: data.tags || [],
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        author: 'ui-user', // Could come from credentials
        version: '1.0.0'
      };
      
      updates.push({
        indexFile,
        action: 'add',
        entry: newEntry
      });
    } else {
      // Existing entry - update timestamp and metadata if changed
      const updatedEntry = {
        ...existingEntry,
        name: data.name || existingEntry.name,
        description: data.description || existingEntry.description,
        updated_at: new Date().toISOString()
      };
      
      updates.push({
        indexFile,
        action: 'update',
        entry: updatedEntry
      });
    }
  }
  
  return updates;
}

// In CommitModal, show proposed index changes:
"The following items will be added to the registry index:
 - parameters-index.yaml: +1 entry (conversion-rate-landing-page-2)
 
 [ ] Include index updates in this commit"
```

**Benefits:**
- User can review before index is updated
- Maintains manual curation (user can uncheck)
- Keeps indexes in sync with most commits
- Simple to implement

### Phase 3: Background Index Validation (Future)

Periodically (or on-demand) scan the repository and suggest index updates:

```typescript
async function validateIndexes(): Promise<ValidationReport> {
  const report = {
    missingInIndex: [],
    missingFiles: [],
    outdatedMetadata: []
  };
  
  // For each type (parameter, context, case, node)
  for (const type of ['parameter', 'context', 'case', 'node']) {
    // Load index
    const index = await loadIndex(`${type}s-index.yaml`);
    
    // Get all files from GitHub
    const files = await listFilesInDirectory(`${type}s/`);
    
    // Check for files not in index
    for (const file of files) {
      const id = file.name.replace(/\.(yaml|yml|json)$/, '');
      const inIndex = index[`${type}s`].some(item => item.id === id);
      if (!inIndex) {
        report.missingInIndex.push({ type, id, file: file.path });
      }
    }
    
    // Check for index entries without files
    for (const entry of index[`${type}s`]) {
      if (entry.file_path) {
        const fileExists = files.some(f => f.path.endsWith(entry.file_path));
        if (!fileExists) {
          report.missingFiles.push({ type, id: entry.id, expected: entry.file_path });
        }
      }
    }
  }
  
  return report;
}
```

Show in UI:
- Repository Menu > "Validate Registry Indexes"
- Shows report with suggestions
- User can click "Auto-fix" to commit index updates

## Implementation Priority

### ✅ Completed
- Local items tracked in `NavigatorContext`
- `ParameterSelector` shows registry + local items
- Manual index maintenance

### 🎯 Next Steps (Recommended)
1. **Add index update to commit flow**
   - In `CommitModal`, detect if committed files need index updates
   - Show checkbox: "[ ] Update registry indexes"
   - If checked, generate and commit index updates alongside files

2. **Add "Validate Indexes" to Repository menu**
   - Scans repo and shows mismatches
   - Suggests fixes
   - Optional: Auto-commit fixes

### 🔮 Future Enhancements
- GitHub Actions workflow to validate indexes on every push
- Auto-generate index files from directory scans (with manual override)
- Index versioning and migration tools

## Decision: Manual Indexes Are Fine For Now

**Recommendation:** Keep manual indexes for Phase 1a/1b. The current approach where:
- Committed files → in registry index (manual)
- Local files → in `NavigatorContext.localItems` (automatic)
- `ParameterSelector` → combines both (automatic)

...is **sufficient and intentional**. The index is a curated catalog, not an auto-generated directory listing.

When we implement delete, we should prompt:
"This file is referenced in the registry index. Remove it from the index too?"

When we implement commit for new files, we should prompt:
"Add this new parameter to the registry index?"

This gives users **control** over what goes in the registry.


