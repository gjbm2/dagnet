# File Type Registry

## Overview

The File Type Registry (`src/config/fileTypeRegistry.ts`) is a centralized configuration system that associates file types with their schemas, directories, index files, and other metadata.

## Why Centralized Configuration?

**Before:** Schema associations and directory paths were scattered across:
- `FormEditor.tsx` (schema selection)
- `ParamsPage.tsx` (old editor schema loading)
- `paramRegistryService.ts` (hardcoded directory paths)
- `NavigatorContext.tsx` (directory scanning)

**After:** Single source of truth in `fileTypeRegistry.ts`

## Configuration Structure

```typescript
interface FileTypeConfig {
  type: 'graph' | 'parameter' | 'context' | 'case';
  displayName: string;              // "Parameter"
  displayNamePlural: string;        // "Parameters"
  schemaFile: string;               // Absolute URL to schema
  directory: string;                // "parameters"
  alternativeDirectories?: string[]; // ["params"]
  indexFile?: string;               // "parameters-index.yaml"
  extensions: string[];             // [".yaml", ".yml", ".json"]
  icon: string;                     // "📋"
  interactiveEditor: 'graph' | 'form'; // Which editor component to use
  supportsInteractiveEdit: boolean;
  supportsRawEdit: boolean;
}
```

## Current Configuration

### Parameters
- **Schema**: `https://raw.githubusercontent.com/gjbm2/nous-conversion/main/param-registry/schemas/parameter-schema.yaml`
- **Directories**: `parameters/` (primary), `params/` (fallback)
- **Index**: `parameters-index.yaml` (optional)
- **Extensions**: `.yaml`, `.yml`, `.json`
- **Editor**: FormEditor

### Contexts
- **Schema**: `https://raw.githubusercontent.com/gjbm2/nous-conversion/main/param-registry/schemas/context-schema.yaml`
- **Directory**: `contexts/`
- **Index**: `contexts-index.yaml` (optional)
- **Extensions**: `.yaml`, `.yml`, `.json`
- **Editor**: FormEditor

### Cases
- **Schema**: `https://raw.githubusercontent.com/gjbm2/nous-conversion/main/param-registry/schemas/case-parameter-schema.yaml`
- **Directory**: `cases/`
- **Index**: `cases-index.yaml` (optional)
- **Extensions**: `.yaml`, `.yml`, `.json`
- **Editor**: FormEditor

### Graphs
- **Schema**: `https://raw.githubusercontent.com/gjbm2/dagnet/main/schema/conversion-graph-1.0.0.json`
- **Directory**: `graphs/`
- **Extensions**: `.json`
- **Editor**: GraphEditor

## Usage

### Get Schema for a File Type
```typescript
import { getSchemaFile } from '../config/fileTypeRegistry';

const schemaFile = getSchemaFile('parameter');
// Returns: "parameter-schema.yaml"
```

### Get Directories (with fallbacks)
```typescript
import { getAllDirectories } from '../config/fileTypeRegistry';

const dirs = getAllDirectories('parameter');
// Returns: ["parameters", "params"]
```

### Get File Type Configuration
```typescript
import { getFileTypeConfig } from '../config/fileTypeRegistry';

const config = getFileTypeConfig('context');
console.log(config.displayName);       // "Context"
console.log(config.directory);         // "contexts"
console.log(config.schemaFile);        // "https://raw.githubusercontent.com/..."
console.log(config.interactiveEditor); // "form"
```

### Get Editor Component (NEW)
```typescript
import { getEditorComponent } from '../components/editors/EditorRegistry';

// EditorRegistry queries FILE_TYPE_REGISTRY to determine the correct editor
const EditorComponent = getEditorComponent('parameter', 'interactive');
// Returns: FormEditor

const GraphEditorComponent = getEditorComponent('graph', 'interactive');
// Returns: GraphEditor
```

**This eliminates hardcoded checks like:**
```typescript
// ❌ OLD: Hardcoded checks scattered everywhere
if (fileId.startsWith('graph-')) {
  return <GraphEditor />;
} else {
  return <FormEditor />;
}

// ✅ NEW: Single source of truth via registry
const EditorComponent = getEditorComponent(type, viewMode);
return <EditorComponent {...props} />;
```

## Components Using Registry

### EditorRegistry (NEW)
- **Uses `getFileTypeConfig()` to determine which editor component to use**
- Queries `interactiveEditor` field from registry
- No hardcoded `if (type === 'graph')` checks
- Single source of truth for editor selection

### FormEditor
- Uses `getSchemaFile()` to load appropriate schema
- No longer has hardcoded schema name mappings
- Automatically adapts if schema filenames change in registry

### paramRegistryService
- Uses `getAllDirectories()` for fallback directory loading
- Uses `getFileTypeConfig()` for directory/index lookups
- Supports loading files even without index files

### NavigatorContext
- Uses registry for directory scanning
- Validates file extensions against registry
- Gets file icons from registry

## Adding a New File Type

1. **Add to Registry**:
```typescript
export const FILE_TYPE_REGISTRY = {
  // ... existing types ...
  
  myNewType: {
    type: 'myNewType',
    displayName: 'My Type',
    displayNamePlural: 'My Types',
    schemaFile: 'my-type-schema.yaml',
    directory: 'my-types',
    indexFile: 'my-types-index.yaml',  // optional
    extensions: ['.yaml', '.json'],
    icon: '🆕',
    supportsInteractiveEdit: true,
    supportsRawEdit: true
  }
};
```

2. **No other code changes needed!**
   - FormEditor automatically loads the schema
   - paramRegistryService automatically scans the directory
   - Navigator can discover files

## Benefits

✅ **Single Source of Truth** - All file type metadata in one place  
✅ **Easy Maintenance** - Change schema/directory in one location  
✅ **Type Safety** - TypeScript ensures configuration is complete  
✅ **Backwards Compatibility** - Supports alternative directories  
✅ **Flexible Loading** - Works with or without index files  
✅ **Extensible** - Easy to add new file types  

## Deprecated: Old ParamsPage

The old full-page parameter editor (`src/pages/ParamsPage.tsx`) has been deprecated and replaced with:
- Tab-based editing in `AppShell`
- Reusable `FormEditor` component
- Centralized file type registry

**Migration**: All editing now happens through the main application with proper tab management, undo/redo, and file synchronization.

## Future Enhancements

Potential additions to the registry:
- **Validation rules** per file type
- **Custom UI schemas** for form customization
- **File templates** for creating new files
- **Save paths** for different file types
- **Permission levels** (read-only, editable, etc.)

