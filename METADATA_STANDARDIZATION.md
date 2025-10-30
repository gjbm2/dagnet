# Metadata Field Standardization

## Problem

Our code uses inconsistent metadata field names across file types:

| File Type | Current Code | Schema | Status |
|-----------|--------------|--------|--------|
| Graph (JSON) | `metadata.updated` | `metadata.updated_at` | ❌ MISMATCH |
| Graph (JSON) | `metadata.created` | `metadata.created_at` | ❌ MISMATCH |
| Parameter (YAML) | `updated_at` (root) | `metadata.updated_at` | ❌ MISMATCH |
| Parameter (YAML) | `created_at` (root) | `metadata.created_at` | ❌ MISMATCH |
| Context (YAML) | `updated_at` (root) | `metadata.updated_at` | ❌ MISMATCH |
| Node (YAML) | `updated_at` (root) | `metadata.updated_at` | ❌ MISMATCH |
| Case (YAML) | `updated_at` (root) | `metadata.updated_at` | ❌ MISMATCH |

## Solution

### Standard Metadata Structure (ALL file types)

```yaml
metadata:
  created_at: "2025-10-30T12:00:00Z"    # ISO 8601 timestamp
  updated_at: "2025-10-30T15:30:00Z"    # ISO 8601 timestamp
  author: "username"                     # Git username or email
  version: "1.0.0"                       # Semantic version
  name: "Display Name"                   # Optional: display name
  description: "..."                     # Optional: description
  tags: ["tag1", "tag2"]                # Optional: tags
  status: "active"                       # Optional: active|deprecated|draft|archived
```

### Changes Required

#### 1. Update All Code References

**Before:**
```typescript
// Graphs
if (file.type === 'graph' && file.data.metadata) {
  file.data.metadata.updated = nowISO;  // ❌ WRONG
}

// YAML files
if (file.type === 'parameter') {
  file.data.updated_at = nowISO;  // ❌ WRONG (root level)
}
```

**After:**
```typescript
// ALL file types use same structure
if (file.data.metadata) {
  file.data.metadata.updated_at = nowISO;  // ✅ CONSISTENT
}
```

#### 2. Update Timestamp Reading (workspaceService.ts)

**Before:**
```typescript
let fileModTime = Date.now();
if (data) {
  if (data.metadata?.updated) {  // ❌ WRONG field name
    fileModTime = new Date(data.metadata.updated).getTime();
  } else if (data.metadata?.created) {  // ❌ WRONG field name
    fileModTime = new Date(data.metadata.created).getTime();
  } else if (data.updated_at) {  // ❌ WRONG location (root)
    fileModTime = new Date(data.updated_at).getTime();
  } else if (data.created_at) {  // ❌ WRONG location (root)
    fileModTime = new Date(data.created_at).getTime();
  }
}
```

**After:**
```typescript
let fileModTime = Date.now();
if (data?.metadata) {
  if (data.metadata.updated_at) {  // ✅ CONSISTENT
    fileModTime = new Date(data.metadata.updated_at).getTime();
  } else if (data.metadata.created_at) {  // ✅ CONSISTENT
    fileModTime = new Date(data.metadata.created_at).getTime();
  }
}
```

#### 3. Update Commit Logic (AppShell.tsx & NavigatorItemContextMenu.tsx)

**Before:**
```typescript
if (fileState.type === 'graph' && fileState.data.metadata) {
  fileState.data.metadata.updated = nowISO;  // ❌ WRONG field
} else if (['parameter', 'context', 'case', 'node'].includes(fileState.type)) {
  fileState.data.updated_at = nowISO;  // ❌ WRONG location
}
```

**After:**
```typescript
// ALL file types use same logic
if (fileState.data.metadata) {
  fileState.data.metadata.updated_at = nowISO;  // ✅ CONSISTENT
} else {
  // Create metadata if it doesn't exist
  fileState.data.metadata = {
    created_at: nowISO,
    updated_at: nowISO
  };
}
```

#### 4. Update markSaved (TabContext.tsx)

**Before:**
```typescript
if (file.type === 'graph' && file.data.metadata) {
  file.data.metadata.updated = nowISO;  // ❌ WRONG
} else if (file.type === 'parameter' || file.type === 'context' || file.type === 'case' || file.type === 'node') {
  file.data.updated_at = nowISO;  // ❌ WRONG
}
```

**After:**
```typescript
// ALL file types use same logic
if (!file.data.metadata) {
  file.data.metadata = {};
}
file.data.metadata.updated_at = nowISO;  // ✅ CONSISTENT
```

#### 5. Migrate Existing Files

For YAML files with root-level `created_at`/`updated_at`, we need migration:

```typescript
// Migration helper
function migrateMetadata(data: any): void {
  // If metadata doesn't exist but root-level timestamps do, migrate them
  if (!data.metadata && (data.created_at || data.updated_at || data.author)) {
    data.metadata = {
      created_at: data.created_at,
      updated_at: data.updated_at,
      author: data.author,
      version: data.version || '1.0.0'
    };
    
    // Clean up old root-level fields
    delete data.created_at;
    delete data.updated_at;
    delete data.author;
    // Keep data.name at root (it's not metadata)
  }
}
```

### Files to Update

#### Code Files:
1. ✅ `/graph-editor/src/AppShell.tsx` - commit logic
2. ✅ `/graph-editor/src/components/NavigatorItemContextMenu.tsx` - commit logic
3. ✅ `/graph-editor/src/contexts/TabContext.tsx` - markSaved logic
4. ✅ `/graph-editor/src/services/workspaceService.ts` - timestamp reading
5. ✅ `/graph-editor/src/services/fileMetadataService.ts` - NEW: central metadata service

#### Schema Files (Already Correct):
- ✅ `/schema/conversion-graph-1.0.0.json` - uses `metadata.created_at`, `metadata.updated_at`
- ✅ `/graph-editor/public/param-schemas/parameter-schema.yaml` - uses `metadata.created_at`, `metadata.updated_at`
- ✅ `/graph-editor/public/param-schemas/context-schema.yaml` - already consistent
- Cases and Nodes - need to verify schemas exist and are consistent

### Benefits

1. **Single Code Path** - No more type checking or branching based on file type
2. **Schema Compliance** - Code matches schemas
3. **Consistency** - Same structure everywhere
4. **Maintainability** - Update in one place
5. **Extensibility** - Easy to add new metadata fields
6. **Migration Path** - Clear upgrade strategy for existing files

### Implementation Order

1. ✅ Create `fileMetadataService.ts` with standard metadata handling
2. ✅ Update `workspaceService.ts` to read `metadata.updated_at`/`created_at`
3. ✅ Update `AppShell.tsx` & `NavigatorItemContextMenu.tsx` commit logic
4. ✅ Update `TabContext.tsx` markSaved logic
5. ✅ Add migration helper for loading old files
6. ✅ Test with all file types
7. ✅ Update documentation

### Migration Strategy

**For Existing Files:**
- On load: Detect old format, migrate to new format
- On save: Always use new format
- Backwards compatible: Can still read old format
- Forward compatible: New format matches schemas

**No Breaking Changes:**
- Migration happens transparently
- Old files work immediately
- Next commit writes new format
- Gradual migration as files are edited

