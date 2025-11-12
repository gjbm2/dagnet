# File I/O Infrastructure Audit

**Date:** 2025-11-05  
**Phase:** Pre-Phase 1  
**Purpose:** Audit existing file I/O capabilities before building Phase 1

---

## Executive Summary

✅ **Good News:** We have substantial I/O infrastructure already built  
⚠️ **Gap:** Local file writes work but index files aren't auto-updated  
🎯 **Phase 1 Scope:** 
- Write to LOCAL files (IndexedDB) - marks files as **dirty** (orange in Navigator)
- AUTO-UPDATE index files whenever YAML files change (CRITICAL) - also marked dirty
- Add UI triggers for Pull/Push operations
- User inspects dirty files, makes manual adjustments if needed
- User commits when happy via existing git workflow (Ctrl+Shift+G)
- Git automation is OUT OF SCOPE (future phase)

## User Workflow (Example: Push Edge to Param File)

```
┌─────────────────────────────────────────────────────────────────┐
│ 1. User right-clicks edge → "Push to Parameter File"           │
└─────────────────────────────────────────────────────────────────┘
                            ↓
┌─────────────────────────────────────────────────────────────────┐
│ 2. UpdateManager.handleGraphToFile()                            │
│    - Applies field mappings (edge.p.mean → param.values[])     │
│    - Calls fileRegistry.updateFile(paramFileId, newData)       │
└─────────────────────────────────────────────────────────────────┘
                            ↓
┌─────────────────────────────────────────────────────────────────┐
│ 3. fileRegistry auto-detects change                             │
│    - Marks param file as dirty                                  │
│    - Emits 'dagnet:fileDirtyChanged' event                      │
└─────────────────────────────────────────────────────────────────┘
                            ↓
┌─────────────────────────────────────────────────────────────────┐
│ 4. fileOperationsService.updateIndexFile() (automatic)          │
│    - Loads parameters-index.yaml into fileRegistry              │
│    - Updates entry for this parameter                           │
│    - Calls fileRegistry.updateFile(indexFileId, updatedIndex)   │
│    - Index file ALSO marked dirty                               │
└─────────────────────────────────────────────────────────────────┘
                            ↓
┌─────────────────────────────────────────────────────────────────┐
│ 5. Navigator UI updates                                         │
│    📄 homepage-to-product.yaml        🟠 (dirty)                │
│    📄 parameters-index.yaml           🟠 (dirty)                │
└─────────────────────────────────────────────────────────────────┘
                            ↓
┌─────────────────────────────────────────────────────────────────┐
│ 6. User reviews changes                                         │
│    - Opens homepage-to-product.yaml                             │
│    - Sees new value in values[] array with n/k evidence         │
│    - Makes manual tweaks if needed (description, tags, etc.)    │
│    - Opens parameters-index.yaml (optional)                     │
│    - Confirms entry looks correct                               │
└─────────────────────────────────────────────────────────────────┘
                            ↓
┌─────────────────────────────────────────────────────────────────┐
│ 7. User commits (when happy)                                    │
│    - Ctrl+Shift+G (or git commands)                             │
│    - Reviews git diff                                            │
│    - Commits both files together                                │
│    - files marked clean, orange indicators disappear            │
└─────────────────────────────────────────────────────────────────┘
```

---

## What We Have: READ Operations

### 1. **paramRegistryService.ts** - Full READ capability
✅ Loads YAML from GitHub or local filesystem  
✅ Handles all file types: parameters, cases, contexts, nodes, events  
✅ Index file reading (parameters-index.yaml, cases-index.yaml, etc.)  
✅ Schema validation  
✅ Fallback logic (index → direct file → minimal default)  

**Methods:**
```typescript
async loadParameter(id: string): Promise<Parameter>
async loadContext(id: string): Promise<Context>
async loadCase(id: string): Promise<Case>
async loadNode(id: string): Promise<Node>
async loadRegistry(): Promise<Registry>
async loadContextsIndex(): Promise<ContextsIndex>
async loadCasesIndex(): Promise<CasesIndex>
async loadNodesIndex(): Promise<NodesIndex>
async loadGraph(filename: string): Promise<Graph>
async loadSchema(schemaName: string): Promise<any>
```

**Configuration:**
- Supports `local` and `git` sources via `RegistryConfig`
- Uses `js-yaml` for YAML parsing
- Handles authentication tokens

---

## What We Have: WRITE Operations

### 2. **paramRegistryService.ts** - Limited WRITE capability
⚠️ Write methods exist but only download to browser, don't commit to repository

**Methods:**
```typescript
async saveParameter(parameter: Parameter): Promise<void>  // Downloads YAML to browser
async saveContext(context: Context): Promise<void>        // Downloads YAML to browser
async saveCase(caseData: Case): Promise<void>             // Downloads YAML to browser
async saveGraph(graph: Graph): Promise<void>              // Downloads JSON to browser
```

**Current Implementation:**
```typescript
async saveParameter(parameter: Parameter): Promise<void> {
  const yamlStr = yaml.dump(parameter);
  const blob = new Blob([yamlStr], { type: 'application/x-yaml' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${parameter.id}.yaml`;
  a.click();
  URL.revokeObjectURL(url);
}
```

### 3. **gitService.ts** - Full GitHub API write capability
✅ Can create/update files in GitHub repository  
✅ Can delete files  
✅ Handles file SHA for updates  
✅ Proper base64 encoding/decoding  

**Methods:**
```typescript
async createOrUpdateFile(
  path: string, 
  content: string, 
  message: string,
  branch: string,
  sha?: string
): Promise<GitOperationResult>

async deleteFile(
  path: string, 
  message: string,
  branch: string
): Promise<GitOperationResult>

async getFile(
  path: string,
  branch?: string
): Promise<GitOperationResult>
```

### 4. **fileOperationsService.ts** - In-memory file management
✅ Creates files in fileRegistry (in-memory + IndexedDB)  
✅ Handles file duplication  
✅ Updates index files (in-memory)  
✅ Navigator integration  

**Methods:**
```typescript
async createFile(
  name: string,
  type: ObjectType,
  options: CreateFileOptions
): Promise<{ fileId: string; item: RepositoryItem }>

async saveFile(fileId: string): Promise<boolean>
```

**Limitation:** `saveFile()` logs but doesn't actually persist to repository:
```typescript
async saveFile(fileId: string): Promise<boolean> {
  const file = fileRegistry.getFile(fileId);
  if (!file) return false;

  // TODO: Implement actual save to repository
  console.log('Saving file:', file);

  await fileRegistry.markSaved(fileId);
  return true;
}
```

### 5. **fileRegistry (TabContext.tsx)** - State management
✅ Single source of truth for file data  
✅ **Automatic dirty state tracking** - compares current data to originalData  
✅ Persists to IndexedDB (browser storage)  
✅ Multi-tab synchronization  
✅ Change notifications via events: `dagnet:fileDirtyChanged`  
✅ Navigator UI already reflects dirty state (orange indicator)  

**Methods:**
```typescript
async getOrCreateFile(fileId, type, source, data): Promise<FileState>
async updateFile(fileId, newData): Promise<void>  // AUTO-MARKS DIRTY if data changed
async markSaved(fileId): Promise<void>
async revertFile(fileId): Promise<void>
getDirtyFiles(): FileState[]
```

**Key Implementation Detail:**
```typescript
async updateFile(fileId: string, newData: any): Promise<void> {
  // ...
  file.data = newData;
  
  // AUTO-DIRTY DETECTION
  const originalDataStr = JSON.stringify(file.originalData);
  const newDataStr = JSON.stringify(newData);
  file.isDirty = newDataStr !== originalDataStr;
  
  // Emit event for Navigator UI update
  if (wasDirty !== file.isDirty) {
    window.dispatchEvent(new CustomEvent('dagnet:fileDirtyChanged', { 
      detail: { fileId, isDirty: file.isDirty } 
    }));
  }
}
```

**This means:** Any call to `fileRegistry.updateFile()` automatically handles dirty tracking! We just need to call it.

---

## What's MISSING for Phase 1

### 1. **Automatic Index File Updates (CRITICAL)**
When a YAML file is created/updated/deleted in fileRegistry, the corresponding index file must be automatically updated.

**Current Gap:** 
- User creates a new parameter file → saves to IndexedDB
- parameters-index.yaml is NOT updated
- Navigator shows stale data / file is "invisible" to system

**Key Requirement:**
- Index file must be loaded into fileRegistry (if not already)
- Index file must be updated via `fileRegistry.updateFile()` 
- This will **automatically mark index as dirty** → shows orange in Navigator
- User sees both the data file AND index file are dirty → can review both → commits both

**Need:**
```typescript
// In fileOperationsService.ts - hook into save operations
async saveFile(fileId: string): Promise<boolean> {
  const file = fileRegistry.getFile(fileId);
  if (!file) return false;

  // 1. Mark file as saved in registry
  await fileRegistry.markSaved(fileId);
  
  // 2. AUTO-UPDATE INDEX FILE (CRITICAL)
  await this.updateIndexFile(file);
  
  return true;
}

private async updateIndexFile(file: FileState): Promise<void> {
  // Determine index file based on type
  const indexFileId = `${file.type}-index`;
  
  // Load index from fileRegistry (or create if doesn't exist)
  let indexFile = fileRegistry.getFile(indexFileId);
  if (!indexFile) {
    // Create index file if it doesn't exist
    const indexData = this.createEmptyIndex(file.type);
    indexFile = await fileRegistry.getOrCreateFile(
      indexFileId,
      file.type, // Index files have same type as their contents
      { repository: file.source.repository, path: `${file.type}s-index.yaml`, branch: file.source.branch },
      indexData
    );
  }
  
  // Update index entry
  const index = indexFile.data;
  const entries = index[`${file.type}s`] || [];
  
  const existingIdx = entries.findIndex((e: any) => e.id === file.data.id);
  const entry = {
    id: file.data.id,
    file_path: file.source.path,
    type: file.data.type || file.type,
    status: file.data.metadata?.status || 'active',
    tags: file.data.metadata?.tags,
    created_at: file.data.metadata?.created_at,
    updated_at: new Date().toISOString(),
    author: file.data.metadata?.author,
    version: file.data.metadata?.version
  };
  
  if (existingIdx >= 0) {
    entries[existingIdx] = entry;
  } else {
    entries.push(entry);
  }
  
  // Sort by id
  entries.sort((a: any, b: any) => a.id.localeCompare(b.id));
  
  // Update index
  index[`${file.type}s`] = entries;
  index.updated_at = new Date().toISOString();
  
  // Save index back to fileRegistry
  await fileRegistry.updateFile(indexFileId, index);
}
```

### 2. **Index File Updates on DELETE**
When a file is deleted, remove its entry from the index.

**Need:**
```typescript
// In fileOperationsService.ts
async deleteFile(fileId: string): Promise<void> {
  const file = fileRegistry.getFile(fileId);
  if (!file) return;

  // 1. Remove from fileRegistry
  await fileRegistry.deleteFile(fileId);
  
  // 2. AUTO-UPDATE INDEX FILE (remove entry)
  await this.removeFromIndexFile(file);
}

private async removeFromIndexFile(file: FileState): Promise<void> {
  const indexFileId = `${file.type}-index`;
  const indexFile = fileRegistry.getFile(indexFileId);
  if (!indexFile) return;
  
  const index = indexFile.data;
  const entries = index[`${file.type}s`] || [];
  
  // Remove entry
  const filtered = entries.filter((e: any) => e.id !== file.data.id);
  index[`${file.type}s`] = filtered;
  index.updated_at = new Date().toISOString();
  
  // Save index back
  await fileRegistry.updateFile(indexFileId, index);
}
```

### 3. **UpdateManager Integration**
Wire UpdateManager to use local file operations (not git).

**Need:**
```typescript
// In UpdateManager.ts
async handleGraphToFile(
  operation: 'CREATE' | 'UPDATE' | 'APPEND',
  subdest: 'parameter' | 'case' | 'node',
  sourceData: any,
  targetFileId?: string
): Promise<void> {
  // 1. Apply mappings to transform data
  const targetData = this.applyMappings(...);
  
  // 2. Save to fileRegistry (LOCAL)
  if (operation === 'CREATE') {
    await fileOperationsService.createFile(
      targetData.id,
      subdest,
      { openInTab: false, metadata: targetData.metadata }
    );
  } else if (operation === 'UPDATE' || operation === 'APPEND') {
    // Update existing file in fileRegistry
    await fileRegistry.updateFile(targetFileId, targetData);
    // Index will be auto-updated by fileOperationsService
  }
  
  // 3. Emit success event
  this.emit('updateComplete', { ... });
}
```

---

## What Phase 1 Should Build

### 1. **Automatic Index File Sync (CRITICAL)**
Extend `fileOperationsService.ts` with automatic index updates:
```typescript
// Add private method
private async updateIndexFile(file: FileState): Promise<void>
private async removeFromIndexFile(file: FileState): Promise<void>
private createEmptyIndex(fileType: ObjectType): any

// Hook into existing methods
async saveFile(fileId: string): Promise<boolean> {
  // ... existing code ...
  await this.updateIndexFile(file);  // ADD THIS
}

async deleteFile(fileId: string, options?: DeleteFileOptions): Promise<void> {
  // ... existing code ...
  await this.removeFromIndexFile(file);  // ADD THIS
}
```

### 2. **Wire UpdateManager to Local File Operations**
Update `UpdateManager.ts` to use fileRegistry (not git):
```typescript
// Import fileOperationsService
import { fileOperationsService } from './fileOperationsService';
import { fileRegistry } from '../contexts/TabContext';

// Update direction handlers to use local operations
async handleGraphToFile(...) {
  // Use fileOperationsService.createFile() or fileRegistry.updateFile()
  // Index files auto-update via saveFile() hook
}

async handleFileToGraph(...) {
  // Read from fileRegistry, apply mappings, update graph
}
```

### 3. **UI Integration Points (COMPREHENSIVE)**
This is the crucial part - add UI triggers throughout the app. 

**Full list of UI integration points to be detailed after Tasks 1-2 are complete.**

---

## Dependencies Already Installed

✅ `js-yaml` - YAML parsing/dumping  
✅ `dexie` - IndexedDB wrapper (for fileRegistry)  
✅ GitHub API access via gitService  

---

## Summary: Phase 1 Tasks

| Task | Effort | Status |
|------|--------|--------|
| 1. Add automatic index file sync to fileOperationsService | 3h | ⏳ TODO |
| 2. Wire UpdateManager to local file operations (fileRegistry) | 3h | ⏳ TODO |
| 3. Add UI triggers - comprehensive mapping | 2h | ⏳ TODO |
| 4. Implement UI triggers across all identified locations | 4h | ⏳ TODO |
| 5. Test end-to-end flows | 2h | ⏳ TODO |
| 6. Write tests for index sync logic | 2h | ⏳ TODO |

**Total Estimate:** 16 hours (~2 days)

**Out of Scope (Future Phase):**
- ❌ Git automation (commits, pushes)
- ❌ Repository write operations
- ❌ CI/CD integration for file syncing
- User manually commits when ready via existing git workflow

---

## Next Steps

1. ✅ **Audit complete** (this document)
2. ⏳ Task 1: Implement automatic index file sync in fileOperationsService
3. ⏳ Task 2: Wire UpdateManager to local file operations
4. ⏳ Task 3: Map ALL UI integration points (comprehensive list)
5. ⏳ Task 4: Implement UI triggers
6. ⏳ Task 5-6: Test and validate

**User will review Task 3 (UI integration points) before proceeding with Task 4.**

---


