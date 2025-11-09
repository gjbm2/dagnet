# External Data System - Implementation Plan

**Date:** 2025-11-09  
**Status:** 🟡 In Progress (Phase 0 & 1)  
**Total Estimate:** 59-77 hours  
**Completed:** ~11 hours (schemas, seed, file menu, MonacoWidget with UI schema example)

---

## Recent Updates (Nov 9, 2025)

**✅ Completed Today:**
- Created `connections-schema.json` with full DAS adapter spec
- Updated all schemas: graph, parameter, case with `connection`, `connection_string`, `evidence` fields
- Updated TypeScript types to match all schema changes
- Implemented `seedConnections.ts` with automatic git sync on app startup
- Added `connections` to file type registry and themes
- Fixed schema directory conflicts (moved conversion-graph to top-level)
- ✅ **Added "Connections" to File menu** → Users can now open/edit connections.yaml!
- ✅ **MonacoWidget implemented** → Rich code editing for JSON/YAML/JS fields!
- ✅ **connections-ui-schema.json created** → Maps MonacoWidget to all code fields!
- ✅ **UI schema loading in FormEditor** → Automatic application of custom widgets!
- ✅ **Default connections.yaml** → Realistic examples for Amplitude, Sheets, Statsig, Postgres!
- ✅ **Clear Data resets connections** → File > Clear Data restores defaults

**🎯 Phase 1 Status:** ✅ COMPLETE (100%)
- ✅ TabbedArrayWidget: Conditional template that renders tabs when `ui:options.tabField` is set
- ✅ Default connections with 4 real examples (Amplitude, Sheets, Statsig, Postgres)
- ✅ UI schema properly structured (removed JSON Schema metadata)
- ✅ **CRITICAL FIX**: Connections initialized in TabContext, openTab loads from IndexedDB (no empty file creation)
- ✅ Clear Data resets to defaults on next reload
- Users can now create and edit complete DAS adapters with rich UI!

**🎯 Next Session:**
- Phase 0 completion: Mustache docs, example connections (can happen in parallel)
- Phase 2: DAS Runner implementation

---

## Quick Links

- **Architecture**: See `ARCHITECTURE.md` for system overview and design decisions
- **Detailed Design**: See `DETAILED_DESIGN/DAS_RUNNER.md` for component specs
- **Original Design**: See `../ARCHIVE/EXTERNAL_DATA_SYSTEM_DESIGN.md` (full context)

---

## Phase Tracker

| Phase | Description | Estimate | Status |
|-------|-------------|----------|--------|
| 0 | Schema Lock | 2-4 hrs | 🟡 In Progress (67% done) |
| 1 | Foundation + UI | 10-14 hrs | 🟡 In Progress (60% done) |
| 2a | Abstraction Layer | 3 hrs | ⏸️ Waiting |
| 2b | DAS Core | 10-12 hrs | ⏸️ Waiting |
| 3 | UI Integration | 10-12 hrs | ⏸️ Waiting |
| 4 | First Adapter | 8-10 hrs | ⏸️ Waiting |
| 5 | Polish | 4-6 hrs | ⏸️ Waiting |
| 6 | Testing | 10-14 hrs | ⏸️ Waiting |

**Legend:** 🔴 Blocker | 🟡 In Progress | 🟢 Complete | ⏸️ Waiting

---

## Phase 0: Schema Lock (2-4 hours) 🟡 In Progress

**Must complete before any implementation!**

### Tasks

#### 1. Write connections-schema.json (1.5 hrs) ✅ DONE
**File:** `/graph-editor/public/schemas/connections-schema.json`

```json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "$id": "https://dagnet.dev/schemas/connections/v1.json",
  "version": "1.0.0",
  "type": "object",
  "required": ["connections"],
  "properties": {
    "connections": {
      "type": "array",
      "items": {
        "type": "object",
        "required": ["name", "provider", "kind"],
        "properties": {
          "name": {"type": "string", "pattern": "^[a-z0-9-]+$"},
          "provider": {"enum": ["amplitude", "google-sheets", "statsig", "postgres"]},
          "kind": {"enum": ["http", "sql"]},
          "enabled": {"type": "boolean", "default": true},
          "credsRef": {"type": "string"},
          "defaults": {"type": "object"},
          "connection_string_schema": {"type": "object"},
          "adapter": {
            "type": "object",
            "properties": {
              "request": {"type": "object"},
              "response": {"type": "object"},
              "transform": {"type": "array"},
              "upsert": {"type": "object"}
            }
          }
        }
      }
    }
  }
}
```

**Validation:** Run against example connections.yaml from `ARCHITECTURE.md`

#### 2. Update graph-schema.json (30 min) ✅ DONE
**File:** `/graph-editor/public/schemas/conversion-graph-1.0.0.json`

Added fields:
```json
{
  "connection": {"type": "string"},
  "connection_string": {"type": "string"},
  "evidence": {"type": "object"}
}
```

#### 3. Update parameter-schema.yaml (30 min) ✅ DONE
**File:** `/graph-editor/public/param-schemas/parameter-schema.yaml`

Added to probability/cost params:
```json
{
  "connection": {"type": "string"},
  "connection_string": {"type": "string"},
  "query": {
    "type": "object",
    "properties": {
      "from": {"type": "string"},
      "to": {"type": "string"},
      "visited": {"type": "array", "items": {"type": "string"}},
      "excluded": {"type": "array", "items": {"type": "string"}}
    }
  },
  "evidence": {
    "type": "object",
    "properties": {
      "n": {"type": "number"},
      "k": {"type": "number"},
      "window_from": {"type": "string", "format": "date"},
      "window_to": {"type": "string", "format": "date"},
      "source": {"type": "string"},
      "fetched_at": {"type": "string", "format": "date-time"}
    }
  }
}
```

**IMPORTANT:** Removed old enum constraint on `connection` field!

#### 4. Update case-parameter-schema.yaml (30 min) ✅ DONE
**File:** `/graph-editor/public/param-schemas/case-parameter-schema.yaml`

Added connection, connection_string, evidence fields

#### 5. Document Mustache templating (1 hr) ⏳ TODO
Create: `/graph-editor/src/lib/templates/TEMPLATE_SYNTAX.md`

```markdown
# Template Syntax

## Variables
- `{{variable}}` - Simple variable
- `{{object.field}}` - Nested object access
- `{{array[0]}}` - Array index access

## Filters
- `{{data | json}}` - JSON.stringify()
- `{{text | url_encode}}` - encodeURIComponent()

## Available Variables
- `dsl`: {from_event_id, to_event_id, visited_event_ids, excluded_event_ids}
- `connection`: Connection defaults
- `credentials`: Resolved credentials object
- `window`: {start, end, timezone}
- `context`: User-defined context
- `connection_string`: Parsed connection_string JSON
- Any extracted variables from previous phases

## Error Handling
- Undefined variable → Throw error
- Failed filter → Throw error with template context
```

#### 6. Write 2 example connections (30 min) ⏳ TODO
Create: `/graph-editor/public/examples/connections-examples.yaml`

Include:
- Amplitude production example
- Google Sheets example

**Gate:** All schemas validate, examples parse correctly

**Phase 0 Status:** 4/6 tasks complete. Remaining: Mustache docs, example connections.

---

## Phase 1: Foundation + UI (10-14 hours) 🟡 In Progress

### 1.1 Seed connections.yaml (1 hr) ✅ DONE

**File:** `/graph-editor/src/init/seedConnections.ts`

✅ Implemented with git sync! On app startup:
- Attempts to load `connections/connections.yaml` from configured git repo
- Syncs to IndexedDB if file exists and differs
- Falls back to creating empty local file if git fails
- Mirrors pattern used for registry files (params, cases, nodes)

Called from `AppShell.tsx` initialization

### 1.2 Add "Connections" to File menu (1 hr) ✅ DONE

**File:** `/graph-editor/src/components/MenuBar/FileMenu.tsx`

✅ Added menu item after "Credentials":
- Created `handleConnections()` function (mirrors `handleCredentials`)
- Opens `connections-connections` file in FormEditor
- Uses default RJSF rendering (good enough for v1)
- Will be enhanced with MonacoWidget and TabbedArrayWidget in next tasks

### 1.3 Implement MonacoWidget (3-4 hrs) ✅ DONE

**Files:**
- `/graph-editor/src/components/widgets/MonacoWidget.tsx`
- `/graph-editor/src/components/widgets/index.ts`
- Updated `/graph-editor/src/components/editors/FormEditor.tsx`

✅ **Implemented features:**
- Rich code editor widget for RJSF with Monaco Editor
- Supports JSON, YAML, JavaScript, JMESPath, JSONata languages
- Auto-parse/validate JSON fields
- Configurable height, minimap, line numbers, word wrap
- Error display for invalid syntax
- Registered with FormEditor's custom widgets registry
- Factory function `createMonacoWidget()` for pre-configured variants

✅ **Example UI schema created:**
- `/graph-editor/public/ui-schemas/connections-ui-schema.json`
- Shows how to use MonacoWidget for connections.yaml fields

### 1.4 Implement TabbedArrayWidget (4-5 hrs)

**File:** `/graph-editor/src/components/widgets/TabbedArrayWidget.tsx`

```typescript
import { Tabs, Tab } from '@mui/material';
import { ArrayFieldTemplateProps } from '@rjsf/utils';

export function TabbedArrayWidget(props: ArrayFieldTemplateProps) {
  const [activeTab, setActiveTab] = useState(0);
  const { items, onAddClick } = props;
  const tabField = props.uiSchema?.['ui:options']?.tabField || 'name';
  
  return (
    <div>
      <Tabs value={activeTab} onChange={(e, v) => setActiveTab(v)}>
        {items.map((item, i) => (
          <Tab key={i} label={item.children.props.formData?.[tabField] || `Item ${i+1}`} />
        ))}
        <Tab icon={<AddIcon />} label="New" onClick={onAddClick} />
      </Tabs>
      {items.map((item, i) => (
        <div key={i} hidden={activeTab !== i}>
          {item.children}
        </div>
      ))}
    </div>
  );
}
```

### 1.5 Write connections UI schema (1-2 hrs) ✅ DONE

**Files:**
- `/graph-editor/public/ui-schemas/connections-ui-schema.json` - UI schema definition
- Updated `/graph-editor/src/config/fileTypeRegistry.ts` - Added `uiSchemaFile` field and `getUiSchemaFile()` helper
- Updated `/graph-editor/src/components/editors/FormEditor.tsx` - Loads and applies UI schemas

✅ **Implemented features:**
- UI schema file configuration in file type registry
- Automatic UI schema loading in FormEditor
- Merges loaded UI schema with defaults
- connections-ui-schema.json maps all MonacoWidget usages:
  - `defaults` → JSON Monaco
  - `connection_string_schema` → JSON Monaco
  - `pre_request.script` → JavaScript Monaco
  - `body_template` → JSON Monaco
  - `response.extract.jmes` → JMESPath Monaco
  - `transform.jsonata` → JSONata Monaco
  - Plus layout hints for all other fields

**Gate:** ✅ Can open connections.yaml in FormEditor with MonacoWidget for all code fields!

---

## Phase 2a: Abstraction Layer (3 hours)

### 2a.1 HttpExecutor (1.5 hrs)

**Files:**
- `/graph-editor/src/lib/das/HttpExecutor.ts`
- `/graph-editor/src/lib/das/BrowserHttpExecutor.ts`
- `/graph-editor/src/lib/das/ServerHttpExecutor.ts`

See `DETAILED_DESIGN/DAS_RUNNER.md` Section 3 for implementation

### 2a.2 ConnectionProvider (1 hr)

**Files:**
- `/graph-editor/src/lib/das/ConnectionProvider.ts`
- `/graph-editor/src/lib/das/IndexedDBConnectionProvider.ts`

See `DETAILED_DESIGN/DAS_RUNNER.md` Section 4 for implementation

### 2a.3 DASRunnerFactory (30 min)

**File:** `/graph-editor/src/lib/das/DASRunnerFactory.ts`

See `DETAILED_DESIGN/DAS_RUNNER.md` Section 2.2 for implementation

**Gate:** Unit tests pass for each abstraction

---

## Phase 2b: DAS Runner Core (10-12 hours)

### 2b.1 DASRunner class scaffold (1 hr)

**File:** `/graph-editor/src/lib/das/DASRunner.ts`

Basic structure with constructor and execute() method

### 2b.2 Mustache interpolation (2 hrs)

Install: `npm install mustache`

Implement `interpolateTemplate()` method with custom filters

Test: Unit tests for variables, filters, nested access

### 2b.3 Request building (2 hrs)

Implement `buildRequest()` method

Interpolate: path, headers, query params, body

### 2b.4 JMESPath extraction (2 hrs)

Install: `npm install jmespath`

Implement `extractData()` method

Test: Complex nested extractions, array access

### 2b.5 JSONata transformation (2 hrs)

Install: `npm install jsonata`

Implement `transformData()` method

Test: Math operations, conditionals

### 2b.6 Update generation (1 hr)

Implement `buildUpdates()` method

Output: Array of {target, value, mode} for UpdateManager

### 2b.7 Error handling (1-2 hrs)

Custom error classes

User-friendly error messages

Credential masking in logs

**Gate:** Integration test passes (mock HTTP, end-to-end flow)

---

## Phase 3: UI Integration (10-12 hours)

### 3.1 Window Selector (4-5 hrs)

**File:** `/graph-editor/src/components/WindowSelector.tsx`

```typescript
export function WindowSelector() {
  const [window, setWindow] = useState({
    start: dayjs().subtract(7, 'days').format('YYYY-MM-DD'),
    end: dayjs().format('YYYY-MM-DD')
  });
  
  return (
    <div style={{
      position: 'absolute',
      top: 16,
      left: '50%',
      transform: 'translateX(-50%)',
      zIndex: 100
    }}>
      <LocalizationProvider dateAdapter={AdapterDayjs}>
        <DateRangePicker
          startText="From"
          endText="To"
          value={[dayjs(window.start), dayjs(window.end)]}
          onChange={(newValue) => {
            setWindow({
              start: newValue[0]?.format('YYYY-MM-DD'),
              end: newValue[1]?.format('YYYY-MM-DD')
            });
          }}
          renderInput={(startProps, endProps) => (
            <>
              <TextField {...startProps} size="small" />
              <Box sx={{ mx: 1 }}> to </Box>
              <TextField {...endProps} size="small" />
            </>
          )}
        />
      </LocalizationProvider>
    </div>
  );
}
```

Add to GraphEditor when graph has connections

### 3.2 Connection selector dropdown (2 hrs)

**File:** Add to EdgePropertiesPanel, CaseEditor

```typescript
function ConnectionSelector({ value, onChange }) {
  const [connections, setConnections] = useState([]);
  
  useEffect(() => {
    loadConnections();
  }, []);
  
  async function loadConnections() {
    const provider = new IndexedDBConnectionProvider();
    const allConns = await provider.getAllConnections();
    setConnections(allConns.filter(c => c.enabled));
  }
  
  return (
    <Select value={value} onChange={(e) => onChange(e.target.value)}>
      <MenuItem value="">None</MenuItem>
      {connections.map(c => (
        <MenuItem key={c.name} value={c.name}>
          {c.name} ({c.provider})
        </MenuItem>
      ))}
    </Select>
  );
}
```

### 3.3 "Get from source" button (2 hrs)

**File:** Add to EdgePropertiesPanel

```typescript
async function handleGetFromSource() {
  if (!edge.p.connection) {
    alert('Please select a connection first');
    return;
  }
  
  setLoading(true);
  
  try {
    const runner = createDASRunner();
    const window = graphContext.window || getDefaultWindow();
    
    const result = await runner.execute(
      edge.p.connection,
      buildDslFromEdge(edge, graph),
      { window, connection_string: edge.p.connection_string }
    );
    
    if (result.success) {
      await updateManager.applyUpdates(result.updates);
      showSuccess(`Updated ${result.updates.length} values`);
    } else {
      showError(result.error);
    }
  } catch (error) {
    showError(error.message);
  } finally {
    setLoading(false);
  }
}
```

### 3.4 Evidence display (1-2 hrs)

Show in EdgePropertiesPanel:
```
Last fetched: 2025-01-15 10:30 from amplitude-prod
Window: 2025-01-01 to 2025-01-31
n=10,000, k=8,000 (p=0.80)
```

### 3.5 buildDslFromEdge helper (1-2 hrs)

**File:** `/graph-editor/src/lib/das/buildDslFromEdge.ts`

```typescript
export function buildDslFromEdge(edge: any, graph: any): any {
  const query = edge.p?.query;
  if (!query) {
    throw new Error(`Edge missing query object`);
  }
  
  const findNode = (ref: string) => {
    return graph.nodes.find((n: any) => n.id === ref || n.uuid === ref);
  };
  
  const fromNode = findNode(query.from);
  const toNode = findNode(query.to);
  
  if (!fromNode || !toNode) {
    throw new Error(`Query nodes not found`);
  }
  
  if (!fromNode.event_id || !toNode.event_id) {
    throw new Error(`Nodes missing event_id field`);
  }
  
  return {
    from_event_id: fromNode.event_id,
    to_event_id: toNode.event_id,
    visited_event_ids: (query.visited || []).map(ref => {
      const node = findNode(ref);
      if (!node?.event_id) throw new Error(`Node missing event_id`);
      return node.event_id;
    }),
    excluded_event_ids: (query.excluded || []).map(ref => {
      const node = findNode(ref);
      if (!node?.event_id) throw new Error(`Node missing event_id`);
      return node.event_id;
    })
  };
}
```

**Gate:** Can fetch data from connection and see updates in UI

---

## Phase 4: First Working Adapter (8-10 hours)

### 4.1 CORS investigation (1-2 hrs)

Test browser fetch() to Amplitude API

If CORS blocked → implement `/api/proxy` passthrough

### 4.2 Write Amplitude adapter (3-4 hrs)

**File:** In connections.yaml

```yaml
- name: amplitude-prod
  provider: amplitude
  kind: http
  credsRef: amplitude
  defaults:
    base_url: "https://amplitude.com"
    project_id: "12345"
    exclude_test_users: true
  
  adapter:
    request:
      method: POST
      path_template: "/api/2/funnels"
      headers:
        Authorization: "Bearer {{credentials.api_key}}"
        Content-Type: "application/json"
      body_template: |
        {
          "project_id": "{{connection.project_id}}",
          "events": [
            {"event_type": "{{dsl.from_event_id}}"},
            {"event_type": "{{dsl.to_event_id}}"}
          ],
          "start": "{{window.start}}",
          "end": "{{window.end}}"
        }
    
    response:
      extract:
        - name: from_count
          jmes: "data.steps[0].count"
        - name: to_count
          jmes: "data.steps[1].count"
    
    transform:
      - name: p_mean
        jsonata: "to_count / from_count"
      - name: n
        jsonata: "from_count"
      - name: k
        jsonata: "to_count"
    
    upsert:
      mode: replace
      writes:
        - target: "/edges/{{edgeId}}/p/mean"
          value: "{{p_mean}}"
        - target: "/edges/{{edgeId}}/p/evidence/n"
          value: "{{n}}"
        - target: "/edges/{{edgeId}}/p/evidence/k"
          value: "{{k}}"
```

### 4.3 Test end-to-end (3-4 hrs)

1. Create test graph with event_ids
2. Configure Amplitude connection
3. Add credentials
4. Click "Get from source"
5. Verify updates

Debug and iterate

**Gate:** Successfully fetches real data from Amplitude and updates graph

---

## Phase 5: Polish (4-6 hours)

### 5.1 Better error messages (2 hrs)

User-friendly error formatting

Show actionable guidance

### 5.2 Loading states (1 hr)

Spinner on "Get from source" button

Disable during fetch

### 5.3 Success feedback (1 hr)

Toast notification

Highlight updated fields

### 5.4 Basic caching (optional, 1-2 hrs)

Simple in-memory cache

Key: `${connection}:${dsl}:${window}`

---

## Phase 6: Testing (10-14 hours)

See original design Section 15.5 for full testing strategy

### 6A: Unit Tests (4-6 hrs)
- Mustache template engine
- HttpExecutor
- ConnectionProvider
- buildDslFromEdge
- DAS Runner methods

### 6B: Integration Tests (3-4 hrs)
- End-to-end with mocked APIs
- Multi-connection scenarios
- Error handling

### 6C: Contract Tests (3-4 hrs)
- Amplitude adapter (golden fixtures)
- Google Sheets adapter
- Statsig adapter

**Gate:** 80% code coverage, all critical paths tested

---

## Progress Tracking

Update this section as you complete tasks:

**Completed:**
- [🟡] Phase 0: Schema Lock (4/6 tasks - 67%)
  - ✅ connections-schema.json
  - ✅ graph schema (conversion-graph-1.0.0.json)
  - ✅ parameter schema (parameter-schema.yaml)
  - ✅ case schema (case-parameter-schema.yaml)
  - ⏳ Mustache templating docs
  - ⏳ Example connections.yaml
- [🟢] Phase 1: Foundation (4/5 tasks - 80% - TabbedArrayWidget optional for v1)
  - ✅ Seed connections.yaml with git sync
  - ✅ Add "Connections" to File menu
  - ✅ MonacoWidget
  - ⏳ TabbedArrayWidget (can defer to v2 - default array UI is acceptable)
  - ✅ Connections UI schema with FormEditor integration
- [ ] Phase 2a: Abstraction Layer
- [ ] Phase 2b: DAS Core
- [ ] Phase 3: UI Integration
- [ ] Phase 4: First Adapter
- [ ] Phase 5: Polish
- [ ] Phase 6: Testing

**Current Blockers:**
- None

**Next Up:**
1. **MonacoWidget** (Phase 1.3, 3-4 hrs) - Rich code editing for JSON/YAML fields in FormEditor
2. **TabbedArrayWidget** (Phase 1.4, 4-5 hrs) - Sub-tabbed view for connections array  
3. **Connections UI Schema** (Phase 1.5, 1-2 hrs) - Custom layout for better UX
4. In parallel: **Mustache docs** (Phase 0.5) and **Example connections** (Phase 0.6)

**Decisions Made:**
- ✅ Option C: Portable DAS Runner
- ✅ Reuse existing CredentialsManager
- ✅ Reuse existing UpdateManager
- ✅ Vitest for testing
- ✅ Sub-tabbed connections UI
- ✅ Window selector at top-middle of graph canvas

---

## Quick Reference

**Key Files:**
- `/graph-editor/public/schemas/connections-schema.json`
- `/graph-editor/src/lib/das/DASRunner.ts`
- `/graph-editor/src/lib/das/DASRunnerFactory.ts`
- `/graph-editor/src/components/WindowSelector.tsx`
- `/graph-editor/src/components/widgets/MonacoWidget.tsx`
- `/graph-editor/src/components/widgets/TabbedArrayWidget.tsx`

**Dependencies to Install:**
```bash
npm install mustache jmespath jsonata
npm install @types/mustache --save-dev
```

**Testing:**
```bash
npm test -- --coverage
npm test -- integration-tests/
```

---

## Notes & Learnings

**Add notes here as you implement:**

- 

---

**Last Updated:** 2025-11-09  
**Next Review:** After Phase 0 completion

