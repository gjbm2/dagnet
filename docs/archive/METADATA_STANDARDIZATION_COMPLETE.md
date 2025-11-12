# Metadata Standardization - Complete Schema Alignment

## ✅ All Schemas Now Aligned

All file types now use the **same metadata structure** with consistent field names.

---

## Standard Metadata Structure

**Every file type (graph, parameter, context, case, node) uses this structure:**

```yaml
metadata:
  created_at: "2025-10-30T12:00:00Z"    # ISO 8601 timestamp (required)
  updated_at: "2025-10-30T15:30:00Z"    # ISO 8601 timestamp (optional)
  author: "username"                     # Git username or team (optional)
  version: "1.0.0"                       # Semantic version (required)
  status: "active"                       # active|deprecated|draft|archived (optional)
  tags: ["tag1", "tag2"]                # Tags array (optional)
```

---

## Schema Status - All File Types

| File Type | Schema Path | `metadata` Section | Status |
|-----------|-------------|-------------------|--------|
| **Graph (JSON)** | `/schema/conversion-graph-1.0.0.json` | ✅ `metadata.created_at`, `metadata.updated_at`, `metadata.author`, `metadata.version` | ✅ **ALIGNED** |
| **Parameter (YAML)** | `/graph-editor/public/param-schemas/parameter-schema.yaml` | ✅ `metadata.created_at`, `metadata.updated_at`, `metadata.author`, `metadata.version`, `metadata.status`, `metadata.tags` | ✅ **ALIGNED** |
| **Context (YAML)** | `/graph-editor/public/param-schemas/context-definition-schema.yaml` | ✅ `metadata.created_at`, `metadata.updated_at`, `metadata.author`, `metadata.version`, `metadata.status` | ✅ **ALIGNED** |
| **Node (YAML)** | `/graph-editor/public/param-schemas/node-schema.yaml` | ✅ `metadata.created_at`, `metadata.updated_at`, `metadata.author`, `metadata.version`, `metadata.status` | ✅ **ALIGNED** |
| **Case (YAML)** | `/graph-editor/public/param-schemas/case-parameter-schema.yaml` | ✅ `metadata.created_at`, `metadata.updated_at`, `metadata.author`, `metadata.version`, `metadata.status`, `metadata.tags` | ✅ **JUST FIXED** |

---

## Schema Field Details

### Required Fields (All Types)
- `metadata.created_at` - ISO 8601 timestamp
- `metadata.version` - Semantic version (x.y.z)

### Optional Fields (All Types)
- `metadata.updated_at` - ISO 8601 timestamp
- `metadata.author` - String (2-64 chars)
- `metadata.status` - Enum: `active`, `deprecated`, `draft`, `archived`
- `metadata.tags` - Array of strings

---

## Example Files

### Graph (JSON)
```json
{
  "nodes": [...],
  "edges": [...],
  "policies": {...},
  "metadata": {
    "version": "1.0.0",
    "created_at": "2025-10-30T10:00:00Z",
    "updated_at": "2025-10-30T15:30:00Z",
    "author": "team-name",
    "description": "My conversion graph",
    "tags": ["conversion", "checkout"]
  }
}
```

### Parameter (YAML)
```yaml
id: conversion-rate-baseline
name: "Baseline Conversion Rate"
type: probability
values:
  - mean: 0.30
    stdev: 0.05

metadata:
  created_at: "2025-10-30T10:00:00Z"
  updated_at: "2025-10-30T15:30:00Z"
  author: "data-team"
  version: "1.0.0"
  status: "active"
  description: "Baseline conversion rate across all channels"
  tags: ["conversion", "baseline"]
```

### Context (YAML)
```yaml
id: channel
name: "Marketing Channel"
description: "Source channel for user acquisition"
type: categorical
values:
  - id: google
    label: "Google Ads"
  - id: facebook
    label: "Facebook Ads"

metadata:
  category: marketing
  data_source: "utm_parameters"
  created_at: "2025-10-30T10:00:00Z"
  updated_at: "2025-10-30T15:30:00Z"
  version: "1.0.0"
  status: "active"
  author: "data-team"
```

### Node (YAML)
```yaml
id: homepage
name: "Homepage / Landing Page"
description: "The main entry point for users"

tags:
  - landing
  - seo

resources:
  - type: notion
    url: "https://notion.so/team/homepage-specs"
    title: "Homepage Specifications"

metadata:
  created_at: "2025-10-30T10:00:00Z"
  updated_at: "2025-10-30T15:30:00Z"
  author: "growth-team"
  version: "1.0.0"
  status: "active"
```

### Case (YAML)
```yaml
parameter_id: case-checkout-redesign
parameter_type: case
name: "Checkout Redesign Experiment"
description: "Testing new checkout flow design"

case:
  id: checkout-redesign-2024
  slug: checkout-redesign
  status: active
  
  platform:
    type: manual
  
  variants:
    - name: control
      weight: 0.5
    - name: treatment
      weight: 0.5

metadata:
  created_at: "2025-10-30T10:00:00Z"
  updated_at: "2025-10-30T15:30:00Z"
  author: "product-team"
  version: "1.0.0"
  status: "active"
  tags: ["checkout", "ux", "conversion"]
```

---

## Code Changes Required

### 1. Update Timestamp Reading (workspaceService.ts)

**Before (inconsistent):**
```typescript
let fileModTime = Date.now();
if (data) {
  // Graph - old wrong field names
  if (data.metadata?.updated) {
    fileModTime = new Date(data.metadata.updated).getTime();
  } else if (data.metadata?.created) {
    fileModTime = new Date(data.metadata.created).getTime();
  }
  // YAML - old wrong location
  else if (data.updated_at) {
    fileModTime = new Date(data.updated_at).getTime();
  } else if (data.created_at) {
    fileModTime = new Date(data.created_at).getTime();
  }
}
```

**After (consistent):**
```typescript
let fileModTime = Date.now();
// ALL file types: check metadata.updated_at / metadata.created_at
if (data?.metadata) {
  if (data.metadata.updated_at) {
    fileModTime = new Date(data.metadata.updated_at).getTime();
  } else if (data.metadata.created_at) {
    fileModTime = new Date(data.metadata.created_at).getTime();
  }
}
```

### 2. Update Timestamp Writing (AppShell.tsx, NavigatorItemContextMenu.tsx, TabContext.tsx)

**Before (inconsistent):**
```typescript
const nowISO = new Date().toISOString();

if (fileState.type === 'graph' && fileState.data.metadata) {
  fileState.data.metadata.updated = nowISO;  // ❌ Wrong field
} else if (['parameter', 'context', 'case', 'node'].includes(fileState.type)) {
  fileState.data.updated_at = nowISO;  // ❌ Wrong location
}
```

**After (consistent):**
```typescript
const nowISO = new Date().toISOString();

// ALL file types: update metadata.updated_at
if (!fileState.data.metadata) {
  fileState.data.metadata = {
    created_at: nowISO,
    version: '1.0.0'
  };
}
fileState.data.metadata.updated_at = nowISO;
```

### 3. Migration for Old Files

For backwards compatibility, add migration logic when loading files:

```typescript
function migrateMetadataToStandard(data: any, fileType: string): void {
  // Skip if already has proper metadata.updated_at
  if (data?.metadata?.updated_at) {
    return;
  }
  
  // Initialize metadata if it doesn't exist
  if (!data.metadata) {
    data.metadata = {};
  }
  
  // Migrate old graph format (metadata.updated -> metadata.updated_at)
  if (fileType === 'graph') {
    if (data.metadata.updated && !data.metadata.updated_at) {
      data.metadata.updated_at = data.metadata.updated;
      delete data.metadata.updated;
    }
    if (data.metadata.created && !data.metadata.created_at) {
      data.metadata.created_at = data.metadata.created;
      delete data.metadata.created;
    }
  }
  
  // Migrate old YAML format (root-level timestamps -> metadata.timestamps)
  if (['parameter', 'context', 'case', 'node'].includes(fileType)) {
    if (data.created_at && !data.metadata.created_at) {
      data.metadata.created_at = data.created_at;
      delete data.created_at;
    }
    if (data.updated_at && !data.metadata.updated_at) {
      data.metadata.updated_at = data.updated_at;
      delete data.updated_at;
    }
    if (data.author && !data.metadata.author) {
      data.metadata.author = data.author;
      delete data.author;
    }
    if (data.version && !data.metadata.version) {
      data.metadata.version = data.version;
      delete data.version;
    }
  }
  
  // Ensure required fields exist
  if (!data.metadata.version) {
    data.metadata.version = '1.0.0';
  }
  if (!data.metadata.created_at) {
    data.metadata.created_at = new Date().toISOString();
  }
}
```

---

## Benefits of Standardization

### ✅ Single Code Path
```typescript
// One function works for ALL file types
function updateTimestamp(fileData: any): void {
  if (!fileData.metadata) {
    fileData.metadata = { created_at: new Date().toISOString(), version: '1.0.0' };
  }
  fileData.metadata.updated_at = new Date().toISOString();
}
```

### ✅ Schema Compliance
- All schemas now define the same metadata structure
- Validation works consistently across all file types

### ✅ Easy to Extend
```typescript
// Adding new metadata fields is trivial
function addAuthorMetadata(fileData: any, gitUsername: string): void {
  if (!fileData.metadata) {
    fileData.metadata = {};
  }
  if (!fileData.metadata.author) {
    fileData.metadata.author = gitUsername;
  }
}
```

### ✅ Consistent UI/UX
- Navigator sorting by "modified" works identically for all file types
- File property panels show same metadata fields
- Search/filter by author, version, status works uniformly

---

## Implementation Checklist

- [x] ✅ Update case schema to include `metadata` section
- [ ] Update `workspaceService.ts` to read `metadata.updated_at` / `metadata.created_at`
- [ ] Update `AppShell.tsx` commit logic to use `metadata.updated_at`
- [ ] Update `NavigatorItemContextMenu.tsx` commit logic to use `metadata.updated_at`
- [ ] Update `TabContext.tsx` markSaved to use `metadata.updated_at`
- [ ] Add migration helper for old file formats
- [ ] Test with all file types
- [ ] Update documentation

---

## Files to Update

### Schemas (✅ ALL DONE)
- ✅ `/schema/conversion-graph-1.0.0.json` - Already correct
- ✅ `/graph-editor/public/param-schemas/parameter-schema.yaml` - Already correct
- ✅ `/graph-editor/public/param-schemas/context-definition-schema.yaml` - Already correct
- ✅ `/graph-editor/public/param-schemas/node-schema.yaml` - Already correct
- ✅ `/graph-editor/public/param-schemas/case-parameter-schema.yaml` - **JUST FIXED**

### Code (Next Steps)
1. `/graph-editor/src/services/workspaceService.ts` - Timestamp reading on load
2. `/graph-editor/src/AppShell.tsx` - Timestamp update on commit
3. `/graph-editor/src/components/NavigatorItemContextMenu.tsx` - Timestamp update on commit
4. `/graph-editor/src/contexts/TabContext.tsx` - Timestamp update on save
5. `/graph-editor/src/services/fileMetadataService.ts` - **NEW** central service

---

## Next Steps

Should I proceed with updating the code files to use the standardized `metadata.updated_at` / `metadata.created_at` structure?


