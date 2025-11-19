# Registry Integration Fix Workplan

## Issues Identified

### ✅ Issue 1: Event-specific fields not extracted to index
**Status:** FIXED
**File:** `fileOperationsService.ts:653-660`
**Fix:** Added event-specific handling for `name`, `description`, `event_type` → `category`

### ❌ Issue 2: ParameterSelector creates files without registry update
**File:** `ParameterSelector.tsx:211-255`
**Problem:** Bypasses `fileOperationsService.createFile()`, no index update
**Impact:** Files created from parameter selector dropdown don't appear in registry

### ❌ Issue 3: putParameterToFile() fails instead of creating file
**File:** `dataOperationsService.ts:984-988`
**Problem:** Returns error if file doesn't exist instead of creating it
**Impact:** Can't "put to file" if file missing - should CREATE+UPDATE

### ❌ Issue 4: putCaseToFile() fails instead of creating file  
**File:** `dataOperationsService.ts:1312-1316`
**Problem:** Returns error if file doesn't exist instead of creating it
**Impact:** Can't "put to file" if file missing - should CREATE+UPDATE

### ❓ Issue 5: UpdateManager.createFileFromGraph() - NOT NEEDED
**File:** `UpdateManager.ts:380-452`
**Status:** METHOD NEVER CALLED - designed but not used
**Analysis:** All `handleGraphToFile` calls use APPEND or UPDATE, never CREATE
**Decision:** Skip this fix - not needed for current issues. Can be implemented later if needed.

---

## Fix Strategy

### Principle
**"Put to file" = CREATE (if missing) + UPDATE (always)**
- Check if file exists
- If not → Create file via `fileOperationsService.createFile()` (handles registry)
- Then → Proceed with UPDATE/APPEND operation

### Implementation Plan

## Fix 2: ParameterSelector.handleCreateFile()
**Location:** `ParameterSelector.tsx:211-255`

**Current Code:**
```typescript
const handleCreateFile = async (name: string, fileType: ObjectType) => {
  const defaultData = fileType === 'graph' ? { ... } : { id: name, name, description: '' };
  
  const file = fileRegistry.getOrCreateFile(
    `${fileType}-${name}.yaml`, 
    fileType, 
    { repository: 'local', path: `${fileType}s/${name}.yaml`, branch: 'main' },
    defaultData
  );
  
  await navOps.addLocalItem(newItem);
  await tabOps.openTab(newItem, 'interactive');
  await navOps.refreshItems();
  
  setInputValue(name);
  onChange(name);
  setShowSuggestions(false);
};
```

**Fixed Code:**
```typescript
const handleCreateFile = async (name: string, fileType: ObjectType) => {
  // Use centralized file operations service (handles registry updates)
  await fileOperationsService.createFile(name, fileType, {
    openInTab: true,
    viewMode: 'interactive',
    metadata: {}
  });
  
  // Set as selected value
  setInputValue(name);
  onChange(name);
  setShowSuggestions(false);
};
```

**Rationale:** 
- Single line of responsibility: use the service
- Handles registry update, navigator update, tab opening
- Eliminates code duplication

---

## Fix 3: putParameterToFile() - Auto-create if missing
**Location:** `dataOperationsService.ts:957-1082`

**Current Code (lines 984-988):**
```typescript
const paramFile = fileRegistry.getFile(`parameter-${paramId}`);
if (!paramFile) {
  toast.error(`Parameter file not found: ${paramId}`);
  return;
}
```

**Fixed Code:**
```typescript
let paramFile = fileRegistry.getFile(`parameter-${paramId}`);
if (!paramFile) {
  console.log(`[putParameterToFile] File not found, creating: ${paramId}`);
  
  // Determine parameter type from edge
  let paramType: 'probability' | 'cost_gbp' | 'cost_time' = 'probability';
  const sourceEdge = graph.edges?.find((e: any) => e.uuid === edgeId || e.id === edgeId);
  if (sourceEdge?.cost_gbp?.id === paramId) paramType = 'cost_gbp';
  else if (sourceEdge?.cost_time?.id === paramId) paramType = 'cost_time';
  
  // Create file using fileOperationsService (handles registry update)
  await fileOperationsService.createFile(paramId, 'parameter', {
    openInTab: false,
    metadata: { parameterType: paramType }
  });
  
  // Now get the created file
  paramFile = fileRegistry.getFile(`parameter-${paramId}`);
  if (!paramFile) {
    toast.error(`Failed to create parameter file: ${paramId}`);
    return;
  }
  
  toast.success(`Created new parameter file: ${paramId}`);
}
```

**Rationale:**
- "Put to file" should create if missing
- Infers parameter type from edge context
- Uses `fileOperationsService.createFile()` → registry update happens automatically
- Toast message distinguishes create vs update

---

## Fix 4: putCaseToFile() - Auto-create if missing
**Location:** `dataOperationsService.ts:1298-1396`

**Current Code (lines 1312-1316):**
```typescript
const caseFile = fileRegistry.getFile(`case-${caseId}`);
if (!caseFile) {
  toast.error(`Case file not found: ${caseId}`);
  return;
}
```

**Fixed Code:**
```typescript
let caseFile = fileRegistry.getFile(`case-${caseId}`);
if (!caseFile) {
  console.log(`[putCaseToFile] File not found, creating: ${caseId}`);
  
  // Create file using fileOperationsService (handles registry update)
  await fileOperationsService.createFile(caseId, 'case', {
    openInTab: false,
    metadata: {}
  });
  
  // Now get the created file
  caseFile = fileRegistry.getFile(`case-${caseId}`);
  if (!caseFile) {
    toast.error(`Failed to create case file: ${caseId}`);
    return;
  }
  
  toast.success(`Created new case file: ${caseId}`);
}
```

**Rationale:**
- Same pattern as putParameterToFile
- Uses centralized service → registry update automatic
- Clear user feedback

---

## Implementation Order

1. **Fix 1** - ✅ DONE (Event fields)
2. **Fix 2** - ParameterSelector (simplest, isolated)
3. **Fix 3** - putParameterToFile (critical user path)
4. **Fix 4** - putCaseToFile (critical user path)
5. **~~Fix 5~~** - ❌ SKIPPED (UpdateManager.createFileFromGraph never called)

---

## Testing Checklist

### Test Fix 2: ParameterSelector
- [ ] Create parameter from dropdown → appears in parameter-index
- [ ] Create context from dropdown → appears in context-index
- [ ] File opens in tab
- [ ] Navigator shows new file

### Test Fix 3: putParameterToFile
- [ ] Put to existing file → appends to values[], updates connection
- [ ] Put to non-existent file → creates file, appears in index, appends data
- [ ] Check all 3 parameter types (probability, cost_gbp, cost_time)
- [ ] Toast shows "Created" vs "Updated" appropriately

### Test Fix 4: putCaseToFile  
- [ ] Put to existing file → appends schedule, updates connection
- [ ] Put to non-existent file → creates file, appears in index, appends data
- [ ] Toast shows "Created" vs "Updated" appropriately

---

## Success Criteria

✅ All CREATE operations (explicit or implicit) update registry index
✅ All DELETE operations update registry index
✅ UPDATE operations that modify metadata update registry (via save)
✅ UPDATE operations that modify data-only DON'T update registry
✅ No orphaned files (file exists but not in index)
✅ No phantom entries (index entry but no file)

