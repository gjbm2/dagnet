# FormEditor and Monaco Integration

How the dynamic form system works (JSON Schema → UI Schema → RJSF → custom widgets) and where Monaco editor is used.

## Overview

DagNet uses two complementary editing systems:
1. **FormEditor** — schema-driven dynamic forms for structured data (parameters, connections, settings, credentials)
2. **Monaco** — rich code editor for raw JSON/YAML, query DSL, merge diffs, and code fields within forms

## FormEditor architecture

### Data flow

```
fileTypeRegistry.ts
  ├─ getSchemaFile(type) → URL (JSON or YAML schema)
  └─ getUiSchemaFile(type) → URL (JSON UI schema)
        ↓
FormEditor.tsx
  ├─ Fetch + parse schema (YAML or JSON → RJSFSchema)
  ├─ Fetch + parse UI schema (JSON → UiSchema)
  ├─ Register custom widgets + templates
  └─ Render @rjsf/mui Form
        ├─ MonacoWidget (code fields)
        ├─ TabbedArrayWidget (tabbed array items)
        ├─ AccordionObjectFieldTemplate (collapsible object groups)
        ├─ ThreeColumnFieldTemplate (label | input | description layout)
        └─ SectionHeadingWidget (visual dividers)
```

### File type registry (`src/config/fileTypeRegistry.ts`)

Central configuration mapping file types to their schemas, directories, icons, and editor modes:

| Field | Purpose |
|-------|---------|
| `type` | Object type (graph, parameter, context, case, node, event, credentials, connections, settings, etc.) |
| `schemaFile` | Path to JSON/YAML schema (in `public/schemas/` or `public/param-schemas/`) |
| `uiSchemaFile` | Path to UI schema (in `public/ui-schemas/`) |
| `directory` | Primary storage directory (e.g. `parameters/`) |
| `indexFile` | Index filename (e.g. `parameters-index.yaml`) |
| `interactiveEditor` | Editor type: `'graph'` (GraphEditor), `'form'` (FormEditor), `'chart'` (ChartViewer) |

Key functions: `getSchemaFile(type)`, `getUiSchemaFile(type)`, `inferFileTypeFromPath(path)`, `getAllDirectories(type)`.

### Schema loading

FormEditor fetches schemas at render time:
1. Get URL from `fileTypeRegistry.getSchemaFile(type)`
2. Fetch and parse (YAML via `yaml.parse()`, JSON via `JSON.parse()`)
3. Validate form data with `@rjsf/validator-ajv8`
4. Fall back to permissive schema `{type: 'object', additionalProperties: true}` if schema not found

### RJSF integration

**Dependencies**: `@rjsf/mui` (v5.24), `@rjsf/core`, `@rjsf/utils`, `@rjsf/validator-ajv8`

FormEditor registers custom widgets and templates:

```
widgets = { MonacoWidget }
templates = {
  ArrayFieldTemplate: TabbedArrayWidget,
  ObjectFieldTemplate: AccordionObjectFieldTemplate,
  FieldTemplate: ThreeColumnFieldTemplate
}
```

The `uiSchema` controls per-field rendering: widget selection, field ordering, grouping, display options.

## Custom widgets (`src/components/widgets/`)

### MonacoWidget

Rich code editor for form fields. Configured via `ui:options`:

| Option | Default | Purpose |
|--------|---------|---------|
| `language` | `'json'` | Syntax highlighting: json, yaml, javascript, jmespath, jsonata |
| `height` | `'200px'` | Editor height |
| `minimap` | `true` | Show minimap |
| `lineNumbers` | `'on'` | Line numbers |
| `wordWrap` | `'off'` | Word wrap |
| `fontSize` | `14` | Font size |

Language-specific variants exported: `JsonMonacoWidget`, `YamlMonacoWidget`, `JavaScriptMonacoWidget`, `JMESPathMonacoWidget`, `JSONataMonacoWidget`.

For JSON fields: parses before calling onChange (validates syntax, stores parse errors). For other languages: passes string directly.

### TabbedArrayWidget

Renders array items as tabs instead of a vertical list. Activated when UI schema sets `ui:options.tabField`:

```json
"values": {
  "ui:options": { "tabField": "window_from" }
}
```

Tab label derived from the specified field. Falls back to default RJSF array template if `tabField` not present.

### AccordionObjectFieldTemplate

Three rendering modes controlled by UI schema:

1. **Grouped accordion**: `ui:options.groups` partitions properties into collapsible sections (each with title, fields list, defaultExpanded)
2. **Single accordion**: `ui:options.accordion = true`
3. **Plain**: default — title + description + flat field list

### ThreeColumnFieldTemplate

Grid layout: 10% label | 50% input | 40% description. All CSS classes prefixed `fe-` in `FormEditor.css`.

### SectionHeadingWidget

Visual divider with heading text. Activated via `ui:widget: "SectionHeading"` in UI schema. Uses CSS variables `--accent-color` and `--text-muted`.

## UI schemas (`public/ui-schemas/`)

| File | Pairs with | Key features |
|------|-----------|--------------|
| `parameter-ui-schema.json` | `parameter-schema.yaml` | Field ordering, query DSL help text |
| `context-ui-schema.json` | `context-definition-schema.yaml` | Context variable form |
| `event-ui-schema.json` | `event-schema.yaml` | Event definition form |
| `credentials-ui-schema.json` | `credentials-schema.json` | Git/provider credentials |
| `connections-ui-schema.json` | `connections-schema.json` | Heavy Monaco usage: JSON for headers/body, JavaScript for scripts, JMESPath/JSONata for transforms |
| `settings-ui-schema.json` | `settings-schema.json` | Forecasting settings with grouped accordion |

UI schema changes must stay in sync with the paired data schema. See SCHEMA_AND_TYPE_PARITY.md.

## Monaco editor usage (outside FormEditor)

### RawView (`editors/RawView.tsx`)

Standalone Monaco `Editor` + `DiffEditor` for raw file editing:
- Auto-detects language from file content/type (JSON, YAML, Markdown)
- Line wrap toggle
- Diff view mode comparing `originalData` vs current `data`
- Parse error detection with visual feedback (red border)
- Theme-aware: `vs-light` / `vs-dark`

### QueryExpressionEditor (`QueryExpressionEditor.tsx`)

IDE-like Monaco editor for query DSL strings:
- Custom autocomplete for DSL functions: `from()`, `to()`, `exclude()`, `visited()`, `case()`, `context()`, `window()`, `cohort()`
- Configurable `allowedFunctions` prop to restrict available functions
- Visual chip parsing for query tokens
- Used in properties panel, scenario editors, and inline expression fields

### MergeConflictModal (`modals/MergeConflictModal.tsx`)

`DiffEditor` for side-by-side conflict comparison:
- Multiple diff view modes: local-merged, local-remote, local-base, remote-base
- Language detection: JSON for graphs, YAML for .yaml files, Markdown for .md
- Read-only display (resolution choices are buttons, not inline edits)

## Theme support

Both Monaco and FormEditor respect `ThemeContext`:
- Monaco: `'vs-light'` (light) / `'vs-dark'` (dark)
- FormEditor CSS: uses CSS variables `--accent-color`, `--text-muted`, `--border-primary`

## Key files

| File | Role |
|------|------|
| `src/components/editors/FormEditor.tsx` | Dynamic form renderer (RJSF + custom widgets) |
| `src/config/fileTypeRegistry.ts` | File type → schema/editor mapping |
| `src/components/widgets/MonacoWidget.tsx` | Monaco-in-form widget |
| `src/components/widgets/TabbedArrayWidget.tsx` | Tabbed array rendering |
| `src/components/widgets/AccordionObjectFieldTemplate.tsx` | Collapsible object groups |
| `src/components/widgets/ThreeColumnFieldTemplate.tsx` | 3-column field layout |
| `src/components/widgets/SectionHeadingWidget.tsx` | Visual section dividers |
| `src/components/editors/RawView.tsx` | Standalone Monaco editor |
| `src/components/QueryExpressionEditor.tsx` | DSL autocomplete editor |
| `src/components/modals/MergeConflictModal.tsx` | Monaco diff for conflicts |
| `public/ui-schemas/*.json` | UI schema definitions |
| `public/schemas/*.json` | Data schema definitions |
| `public/param-schemas/*.yaml` | Parameter registry schemas |
