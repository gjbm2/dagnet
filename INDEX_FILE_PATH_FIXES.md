# Index File Path Fixes

## Problem

Index files were being created/updated with inconsistent paths:
- ❌ Some code used SINGULAR: `parameter-index.yaml`, `node-index.yaml`
- ✅ Correct is PLURAL: `parameters-index.yaml`, `nodes-index.yaml`

This caused git pull/push to fail because:
1. Pull expected files at ROOT with PLURAL names
2. Some creation code used SINGULAR names
3. SHA tracking broke due to path mismatches

## Root Cause

Multiple files had inconsistent logic for constructing index file paths:
- Some used `${type}-index.yaml` (singular: `parameter-index.yaml`)
- Others used `${type}s-index.yaml` (plural: `parameters-index.yaml`)

## Files Fixed

### 1. ✅ workspaceService.ts
**Location:** Pull and remote check logic  
**Status:** Already correct - looks for plural index files at root

### 2. ✅ fileOperationsService.ts  
**Location:** Line 672 - index file creation  
**Status:** Already correct - uses `${pluralKey}-index.yaml`  
**Comment updated:** Line 280

### 3. ✅ TabContext.tsx
**Location:** Line 447 - `updateIndexOnCreate()`  
**Fixed:** Changed from `${indexFileId}.yaml` to `${type}s-index.yaml`
```typescript
// BEFORE
const indexFileName = `${indexFileId}.yaml`;  // parameter-index.yaml ❌

// AFTER
const indexFileName = `${type}s-index.yaml`;  // parameters-index.yaml ✅
```

### 4. ✅ indexRebuildService.ts
**Location:** Lines 191-192, 205 - index file creation  
**Fixed:** Changed from `${indexFileId}.yaml` to `${arrayKey}-index.yaml`
```typescript
// BEFORE
name: `${indexFileId}.yaml`,  // parameter-index.yaml ❌
path: `${indexFileId}.yaml`,

// AFTER
name: `${arrayKey}-index.yaml`,  // parameters-index.yaml ✅
path: `${arrayKey}-index.yaml`,
```

### 5. ✅ repositoryOperationsService.ts
**Location:** Line 229 - push logic  
**Fixed:** Changed from `${file.fileId}.yaml` to `${file.type}s-index.yaml`
```typescript
// BEFORE
filePath = `${file.fileId}.yaml`;  // parameter-index.yaml ❌

// AFTER
filePath = `${file.type}s-index.yaml`;  // parameters-index.yaml ✅
```
**Comment updated:** Line 228

## Correct Index File Names

All index files must use PLURAL form at repository ROOT:

| Type | Correct Filename | Location |
|------|-----------------|----------|
| Parameter | `parameters-index.yaml` | Root |
| Context | `contexts-index.yaml` | Root |
| Case | `cases-index.yaml` | Root |
| Node | `nodes-index.yaml` | Root |
| Event | `events-index.yaml` | Root |

## FileId vs Path Convention

**Internal FileId (in IndexedDB):**
- Uses SINGULAR: `parameter-index`, `node-index`, `event-index`
- This is for internal registry lookup

**Git Repository Path:**
- Uses PLURAL: `parameters-index.yaml`, `nodes-index.yaml`, `events-index.yaml`
- This is the actual file path in the repo

**Mapping:**
```typescript
const indexFileId = `${type}-index`;        // 'parameter-index' (internal)
const indexFilePath = `${type}s-index.yaml`; // 'parameters-index.yaml' (git)
```

## Testing

After these fixes:
1. ✅ Index files will be created at correct ROOT paths with PLURAL names
2. ✅ Pull will correctly fetch index files and track SHAs
3. ✅ Push will commit index files to correct paths
4. ✅ Remote check will correctly detect changes

## Next Steps for User

1. Move any misplaced index files in your repository:
   ```bash
   # If you have index files in directories, move them to root
   git mv nodes/index.yaml nodes-index.yaml
   git mv events/index.yaml events-index.yaml
   ```

2. Clear local IndexedDB cache (optional but recommended):
   - Browser DevTools → Application → IndexedDB → Delete database

3. Re-clone workspace to get fresh data with correct paths

4. Test pull/push cycle to verify fixes work

