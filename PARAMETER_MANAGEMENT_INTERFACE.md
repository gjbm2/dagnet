# Parameter Management Interface - Schema-Driven CRUD

**Purpose:** Unified interface for managing all registry data (contexts, parameters, cases, registry)

---

## The Core Insight

All our data types are:
- ✅ YAML files with defined schemas
- ✅ Need basic CRUD operations (create, read, update, delete)
- ✅ Require schema validation
- ✅ Should be version controlled (Git)
- ✅ Have similar structure (id, metadata, values)

**Solution:** Build a single **schema-driven form builder** that works for all types!

---

## Architecture: Schema-Driven Forms

```
┌─────────────────────────────────────────────────────────────┐
│                 PARAMETER MANAGEMENT APP                     │
│                 (Standalone or mode in graph editor)         │
├─────────────────────────────────────────────────────────────┤
│                                                              │
│  [Contexts] [Parameters] [Cases] [Registry] [Graphs]        │
│      ↓                                                       │
│  ┌────────────────────────────────────────────────────┐    │
│  │  Schema Loader                                      │    │
│  │  • Reads YAML schema for selected type             │    │
│  │  • Parses schema structure                          │    │
│  └────────────────┬───────────────────────────────────┘    │
│                   ↓                                          │
│  ┌────────────────────────────────────────────────────┐    │
│  │  Form Generator                                     │    │
│  │  • Generates form fields from schema                │    │
│  │  • String → text input                              │    │
│  │  • Enum → dropdown                                  │    │
│  │  • Array → repeatable fields                        │    │
│  │  • Object → nested sections                         │    │
│  └────────────────┬───────────────────────────────────┘    │
│                   ↓                                          │
│  ┌────────────────────────────────────────────────────┐    │
│  │  CRUD Operations                                    │    │
│  │  • Create: New entity from schema                   │    │
│  │  • Read: Load existing YAML                         │    │
│  │  • Update: Edit and validate                        │    │
│  │  • Delete: Remove file (with confirmation)          │    │
│  └────────────────┬───────────────────────────────────┘    │
│                   ↓                                          │
│  ┌────────────────────────────────────────────────────┐    │
│  │  File Persistence                                   │    │
│  │  • Write YAML files                                 │    │
│  │  • Update registry index                            │    │
│  │  • Git commit (optional)                            │    │
│  └────────────────────────────────────────────────────┘    │
│                                                              │
└──────────────────────────────────────────────────────────────┘
```

---

## Data Types We Need to Manage

| Type | File(s) | Schema | Complexity |
|------|---------|--------|------------|
| **Contexts** | `contexts.yaml` | `context-schema.yaml` | Low |
| **Parameters** | `parameters/**/*.yaml` | `parameter-schema.yaml` | Medium |
| **Cases** | `parameters/cases/*.yaml` | `parameter-schema.yaml` (type=case) | Low |
| **Registry** | `registry.yaml` | `registry-schema.yaml` | Low (mostly auto-generated) |
| **Graphs** | `graphs/*.json` | `conversion-graph-1.0.0.json` | High (already have editor) |

---

## Proposal: Standalone Parameter Manager First

### Option A: Separate App (RECOMMENDED)
```
dagnet/
├── graph-editor/          # Existing graph editor
└── param-manager/         # NEW: Parameter management app
    ├── src/
    │   ├── App.tsx
    │   ├── SchemaLoader.ts
    │   ├── FormGenerator.tsx
    │   └── FileOperations.ts
    └── package.json
```

**Benefits:**
- ✅ Focused tool for data management
- ✅ Simpler, faster development
- ✅ Can be used independently
- ✅ Easier testing
- ✅ Can later integrate into graph editor

**Use case:** Data team manages parameters, then graph editor uses them

---

### Option B: Integrated Mode in Graph Editor
```
Graph Editor
├── Graph Mode (existing)
└── Parameter Management Mode (new)
    └── Same schema-driven interface
```

**Benefits:**
- ✅ Single app
- ✅ Tight integration
- ❌ More complex
- ❌ Slower to build

**Recommendation:** Start with **Option A**, integrate later

---

## UI Design: Schema-Driven Form Builder

### Main Interface

```
┌─ Parameter Manager ────────────────────────────────────────────┐
│                                                                 │
│  [Contexts] [Parameters] [Cases] [Registry]                    │
│     ↓                                                           │
│  ┌─ Parameters ─────────────────────────────────────────────┐ │
│  │                                                            │ │
│  │  Search: [____________] 🔍  [+ New Parameter]            │ │
│  │                                                            │ │
│  │  Filters:                                                  │ │
│  │  Type: [All ▼] Status: [Active ▼] Context: [All ▼]      │ │
│  │                                                            │ │
│  │  ┌─────────────────────────────────────────────────────┐ │ │
│  │  │ signup-google-mobile           📊 Probability       │ │ │
│  │  │ Signup conversion - Google mobile                   │ │ │
│  │  │ Updated: 2h ago | Status: Active                    │ │ │
│  │  │ [Edit] [Duplicate] [Delete]                         │ │ │
│  │  └─────────────────────────────────────────────────────┘ │ │
│  │                                                            │ │
│  │  ┌─────────────────────────────────────────────────────┐ │ │
│  │  │ checkout-mobile                📊 Probability       │ │ │
│  │  │ Checkout conversion - Mobile                        │ │ │
│  │  │ Updated: 1d ago | Status: Active                    │ │ │
│  │  │ [Edit] [Duplicate] [Delete]                         │ │ │
│  │  └─────────────────────────────────────────────────────┘ │ │
│  │                                                            │ │
│  └────────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────┘
```

---

### Edit Parameter: Schema-Driven Form

```
┌─ Edit Parameter: signup-google-mobile ─────────────────────────┐
│                                                                 │
│  ┌─ Basic Information ────────────────────────────────────┐   │
│  │                                                          │   │
│  │  ID: signup-google-mobile                               │   │
│  │  (read-only after creation)                             │   │
│  │                                                          │   │
│  │  Name: [Signup Conversion - Google Mobile            ] │   │
│  │                                                          │   │
│  │  Type: [probability            ▼]                      │   │
│  │        • probability                                     │   │
│  │        • monetary_cost                                   │   │
│  │        • time_cost                                       │   │
│  │        • case                                            │   │
│  │                                                          │   │
│  └──────────────────────────────────────────────────────────┘   │
│                                                                 │
│  ┌─ Reference (Optional) ─────────────────────────────────┐   │
│  │                                                          │   │
│  │  Edge Reference:                                         │   │
│  │  [e.signup.context(channel='google',device='mobile').p.m│   │
│  │                                                          │   │
│  │  [Build from Edge Selector] (opens builder)            │   │
│  │                                                          │   │
│  └──────────────────────────────────────────────────────────┘   │
│                                                                 │
│  ┌─ Context Filters ──────────────────────────────────────┐   │
│  │                                                          │   │
│  │  channel: [google          ▼] [Remove]                 │   │
│  │  device:  [mobile          ▼] [Remove]                 │   │
│  │                                                          │   │
│  │  [+ Add Context Filter]                                 │   │
│  │                                                          │   │
│  └──────────────────────────────────────────────────────────┘   │
│                                                                 │
│  ┌─ Value ────────────────────────────────────────────────┐   │
│  │                                                          │   │
│  │  Mean:  [0.32]                                          │   │
│  │  StDev: [0.06]                                          │   │
│  │                                                          │   │
│  │  ▼ Advanced (optional)                                  │   │
│  │    Distribution: [beta     ▼]                           │   │
│  │    Min: [0.0]  Max: [1.0]                              │   │
│  │                                                          │   │
│  └──────────────────────────────────────────────────────────┘   │
│                                                                 │
│  ┌─ Metadata ─────────────────────────────────────────────┐   │
│  │                                                          │   │
│  │  Description:                                            │   │
│  │  [Signup conversion rate for Google Ads traffic on mob] │   │
│  │  [ile devices                                         ] │   │
│  │                                                          │   │
│  │  Tags: [conversion] [signup] [google] [mobile] [+]     │   │
│  │                                                          │   │
│  │  Status: [active ▼]                                     │   │
│  │                                                          │   │
│  │  Author: [data-team        ]                            │   │
│  │                                                          │   │
│  │  Version: [1.0.0]                                       │   │
│  │                                                          │   │
│  └──────────────────────────────────────────────────────────┘   │
│                                                                 │
│  [Cancel]  [Save]  [Save & New]                                │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

**Key Feature:** Form is **generated from schema**!

- Schema says `type: string` → Text input
- Schema says `enum: [active, deprecated]` → Dropdown
- Schema says `type: array` → Repeatable fields with [+] button
- Schema says `type: object` → Nested section

---

## Implementation: Form Generator from Schema

### Core Logic

```typescript
interface SchemaField {
  name: string;
  type: string;
  enum?: string[];
  items?: SchemaField;
  properties?: Record<string, SchemaField>;
  required?: boolean;
  description?: string;
  pattern?: string;
  minimum?: number;
  maximum?: number;
}

export function generateFormFields(schema: SchemaField): React.ReactNode {
  // String with enum → Dropdown
  if (schema.type === 'string' && schema.enum) {
    return (
      <select>
        {schema.enum.map(val => (
          <option key={val} value={val}>{val}</option>
        ))}
      </select>
    );
  }
  
  // String → Text input
  if (schema.type === 'string') {
    return (
      <input 
        type="text" 
        pattern={schema.pattern}
        placeholder={schema.description}
      />
    );
  }
  
  // Number → Number input
  if (schema.type === 'number') {
    return (
      <input 
        type="number" 
        min={schema.minimum}
        max={schema.maximum}
        step="any"
      />
    );
  }
  
  // Array → Repeatable fields
  if (schema.type === 'array') {
    return (
      <RepeatableField
        itemSchema={schema.items}
        onAdd={() => {/* add item */}}
        onRemove={(idx) => {/* remove item */}}
      />
    );
  }
  
  // Object → Nested section
  if (schema.type === 'object') {
    return (
      <fieldset>
        <legend>{schema.name}</legend>
        {Object.entries(schema.properties || {}).map(([key, field]) => (
          <div key={key}>
            <label>{field.name || key}</label>
            {generateFormFields(field)}
          </div>
        ))}
      </fieldset>
    );
  }
}
```

---

### Complete Example: Parameter Editor Component

```typescript
import React, { useState, useEffect } from 'react';
import { loadSchema } from './SchemaLoader';
import { generateFormFields } from './FormGenerator';
import { saveParameter, validateParameter } from './FileOperations';

interface ParameterEditorProps {
  parameterId?: string;  // undefined = new parameter
  onSave: () => void;
  onCancel: () => void;
}

export const ParameterEditor: React.FC<ParameterEditorProps> = ({
  parameterId,
  onSave,
  onCancel,
}) => {
  const [schema, setSchema] = useState<any>(null);
  const [data, setData] = useState<any>({});
  const [errors, setErrors] = useState<string[]>([]);
  
  useEffect(() => {
    // Load parameter schema
    loadSchema('parameter-schema.yaml').then(setSchema);
    
    // If editing, load existing data
    if (parameterId) {
      loadParameter(parameterId).then(setData);
    }
  }, [parameterId]);
  
  const handleSave = async () => {
    // Validate against schema
    const validationErrors = await validateParameter(data, schema);
    
    if (validationErrors.length > 0) {
      setErrors(validationErrors);
      return;
    }
    
    // Save to file
    await saveParameter(data);
    
    // Update registry index
    await updateRegistryIndex(data.id);
    
    // Git commit (optional)
    if (config.autoCommit) {
      await gitCommit(`Update parameter: ${data.id}`);
    }
    
    onSave();
  };
  
  if (!schema) return <div>Loading...</div>;
  
  return (
    <div className="parameter-editor">
      <h2>{parameterId ? 'Edit' : 'New'} Parameter</h2>
      
      {errors.length > 0 && (
        <div className="errors">
          {errors.map((err, idx) => (
            <div key={idx} className="error">{err}</div>
          ))}
        </div>
      )}
      
      <form onSubmit={(e) => { e.preventDefault(); handleSave(); }}>
        {/* Generate form from schema */}
        {Object.entries(schema.properties).map(([key, field]: [string, any]) => (
          <FormField
            key={key}
            name={key}
            schema={field}
            value={data[key]}
            onChange={(val) => setData({ ...data, [key]: val })}
            required={schema.required?.includes(key)}
          />
        ))}
        
        <div className="actions">
          <button type="button" onClick={onCancel}>Cancel</button>
          <button type="submit">Save</button>
        </div>
      </form>
    </div>
  );
};
```

---

## File Operations

### Save Parameter

```typescript
export async function saveParameter(data: Parameter): Promise<void> {
  // 1. Generate YAML
  const yaml = stringifyYAML(data);
  
  // 2. Determine file path
  const path = `param-registry/parameters/${data.type}/${data.id}.yaml`;
  
  // 3. Write file
  await writeFile(path, yaml);
  
  // 4. Update registry index
  await updateRegistryIndex({
    id: data.id,
    path: path,
    type: data.type,
    tags: data.metadata.tags,
    status: data.metadata.status,
    last_updated: new Date().toISOString()
  });
}
```

### Update Registry Index

```typescript
export async function updateRegistryIndex(paramEntry: RegistryEntry): Promise<void> {
  // 1. Load registry
  const registry = await loadRegistry();
  
  // 2. Update or add entry
  const idx = registry.parameters.findIndex(p => p.id === paramEntry.id);
  if (idx >= 0) {
    registry.parameters[idx] = paramEntry;
  } else {
    registry.parameters.push(paramEntry);
  }
  
  // 3. Sort by ID
  registry.parameters.sort((a, b) => a.id.localeCompare(b.id));
  
  // 4. Update metadata
  registry.metadata.updated_at = new Date().toISOString();
  registry.metadata.count = registry.parameters.length;
  
  // 5. Write back
  const yaml = stringifyYAML(registry);
  await writeFile('param-registry/registry.yaml', yaml);
}
```

---

## Tech Stack Options

### Option 1: React + Vite (Same as Graph Editor)
```
param-manager/
├── src/
│   ├── App.tsx
│   ├── components/
│   │   ├── ParameterList.tsx
│   │   ├── ParameterEditor.tsx
│   │   ├── ContextEditor.tsx
│   │   └── FormGenerator.tsx
│   ├── lib/
│   │   ├── SchemaLoader.ts
│   │   ├── FileOperations.ts
│   │   └── Validation.ts
│   └── main.tsx
├── package.json
└── vite.config.ts
```

**Benefits:**
- ✅ Same stack as graph editor (easier integration later)
- ✅ Fast development with Vite
- ✅ TypeScript support

---

### Option 2: Electron App (Desktop)
**Benefits:**
- ✅ Direct file system access
- ✅ No need for backend API
- ✅ Can run locally without server
- ❌ More complex deployment

---

### Option 3: Web App + Backend API
```
param-manager-frontend/ (React)
param-manager-backend/ (Node/Express)
  └── Routes for file operations
```

**Benefits:**
- ✅ Multi-user support
- ✅ Authentication/authorization
- ✅ Web-based (no install)
- ❌ Need to deploy backend

**Recommendation:** Start with **Option 1** (React + Vite), add backend later if needed

---

## Reusable Schema-Driven Components

### 1. FormField (Universal Field Generator)

```typescript
interface FormFieldProps {
  name: string;
  schema: SchemaField;
  value: any;
  onChange: (value: any) => void;
  required?: boolean;
}

export const FormField: React.FC<FormFieldProps> = ({
  name,
  schema,
  value,
  onChange,
  required
}) => {
  return (
    <div className="form-field">
      <label>
        {schema.description || name}
        {required && <span className="required">*</span>}
      </label>
      
      {generateInputForSchema(schema, value, onChange)}
      
      {schema.description && (
        <small className="help-text">{schema.description}</small>
      )}
    </div>
  );
};
```

### 2. SchemaValidator

```typescript
export function validateAgainstSchema(
  data: any,
  schema: any
): ValidationError[] {
  const errors: ValidationError[] = [];
  
  // Check required fields
  for (const field of schema.required || []) {
    if (!data[field]) {
      errors.push({
        field,
        message: `${field} is required`
      });
    }
  }
  
  // Check types
  for (const [key, value] of Object.entries(data)) {
    const fieldSchema = schema.properties[key];
    if (!fieldSchema) continue;
    
    if (fieldSchema.type === 'string' && typeof value !== 'string') {
      errors.push({
        field: key,
        message: `${key} must be a string`
      });
    }
    
    // Enum validation
    if (fieldSchema.enum && !fieldSchema.enum.includes(value)) {
      errors.push({
        field: key,
        message: `${key} must be one of: ${fieldSchema.enum.join(', ')}`
      });
    }
    
    // Pattern validation
    if (fieldSchema.pattern && !new RegExp(fieldSchema.pattern).test(value)) {
      errors.push({
        field: key,
        message: `${key} does not match required pattern`
      });
    }
  }
  
  return errors;
}
```

---

## Integration Plan

### Phase 1: Standalone Parameter Manager (2 weeks)
1. Build basic CRUD interface
2. Schema-driven form generation
3. File operations (read/write YAML)
4. Validation against schemas
5. Support for parameters and contexts

**Deliverable:** Working parameter manager app

---

### Phase 2: Enhanced Features (1 week)
6. Search and filtering
7. Bulk operations (duplicate, delete multiple)
8. Import/export
9. Preview (see YAML before saving)
10. Git integration (commit, push, pull)

**Deliverable:** Full-featured management interface

---

### Phase 3: Graph Editor Integration (1 week)
11. "Parameter Management" mode in graph editor
12. Context switching between graph/parameter modes
13. Shared components (FormGenerator, etc.)
14. Link from graph editor ("Edit parameter" button)

**Deliverable:** Unified interface

---

## Summary

**Yes, you're right** - this is relatively straightforward:

### What We Need
1. **Schema-driven form generator** (the core reusable piece)
2. **CRUD operations** over YAML files
3. **Validation** against schemas
4. **List/search interface** for browsing entities

### Recommendation
- ✅ **Start with standalone parameter manager** (2-3 weeks)
- ✅ Use **same tech stack as graph editor** (React + Vite)
- ✅ Build **reusable schema-driven components**
- ✅ **Integrate into graph editor later** (1 week)

### Why Standalone First?
1. Simpler, faster to build
2. Data team can use independently
3. Easier to test
4. Can integrate later without breaking existing graph editor
5. Proves out the schema-driven approach

**Next step:** Build the parameter manager as a separate app, then integrate!



