# UI Components - Complete Specification

**Component:** UI Integration for External Data System  
**Status:** 🔵 Design Complete  
**Reference:** Original design Section 4.3 (lines 1270-1761) and Section 4 (lines 1961-2190)

---

## 1. Overview

This document specifies all UI components for the external data system:
- FormEditor for connections.yaml (with custom widgets)
- Window Selector (graph-level date range picker)
- Context Selector (stubbed for v1)
- Connection dropdown in parameter/case editors
- Evidence display
- "Get from source" button

---

## 2. connections.yaml UI Schema

**File:** `/graph-editor/public/ui-schemas/connections-ui-schema.json`

**See:** `../../ARCHIVE/EXTERNAL_DATA_SYSTEM_DESIGN.md` lines 1277-1602 for complete JSON

### 2.1 Key Features

1. **Sub-Tabbed Array** - Each connection in its own tab:
   - Uses `TabbedArrayWidget`
   - Tab label from connection `name` field
   - "+ New" tab for adding connections

2. **Accordion Sections** - Collapsible major sections:
   - ⚙️ Connection Defaults (expanded by default)
   - 📋 Connection String Schema (collapsed, Monaco JSON)
   - 🔌 Adapter Configuration (collapsed, 5 numbered sub-sections)

3. **Monaco Editor Integration:**
   - All code/JSON/YAML fields use `MonacoWidget`
   - Different configurations per field type:
     - `body_template`, `connection_string_schema`: JSON, 200-300px, line numbers ON
     - `script` (pre_request): JavaScript, 150px, line numbers ON
     - `jmes`, `jsonata`: Plaintext, 40-60px, line numbers OFF

4. **Smart Defaults:**
   - Collapsed: adapter sections, connection_string_schema, metadata
   - Expanded: name, provider, enabled, defaults
   - Read-only: metadata (auto-generated timestamps)

### 2.2 Visual Layout

```
┌─────────────────────────────────────────────────────────────────┐
│ FormEditor: connections.yaml                             [×][□] │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  SUB-TABS (each connection):                                    │
│  [amplitude-prod] [sheets-metrics] [statsig-prod] [+ New]       │
│  ───────────────                                                │
│                                                                 │
│  ┌───────────────────────────────────────────────────────────┐ │
│  │ Name:  [amplitude-prod                              ]    │ │
│  │ Provider: [Amplitude Analytics ▼]                        │ │
│  │ Enabled: [✓]                                             │ │
│  ├───────────────────────────────────────────────────────────┤ │
│  │ ⚙️ Connection Defaults                              [▼] │ │
│  │   project_id: [12345                              ]      │ │
│  │   exclude_test_users: [✓]                               │ │
│  │   [+ Add Default]                                        │ │
│  ├───────────────────────────────────────────────────────────┤ │
│  │ 📋 Connection String Schema                         [▶] │ │
│  ├───────────────────────────────────────────────────────────┤ │
│  │ 🔌 Adapter Configuration                            [▶] │ │
│  │   ┌─────────────────────────────────────────────────┐   │ │
│  │   │ 1️⃣ Pre-Request Scripts                   [▶]  │   │ │
│  │   │ 2️⃣ HTTP Request                          [▼]  │   │ │
│  │   │   POST /api/2/funnels                           │   │ │
│  │   │   ┌─────────────────────────────────────────┐   │   │ │
│  │   │   │  Monaco Editor (JSON)                   │   │   │ │
│  │   │   │  body_template:                         │   │   │ │
│  │   │   │  {                                      │   │   │ │
│  │   │   │    "project_id": "{{defaults.id}}"    │   │   │ │
│  │   │   │  }                                      │   │   │ │
│  │   │   └─────────────────────────────────────────┘   │   │ │
│  │   │ 3️⃣ Response Extraction                   [▶]  │   │ │
│  │   │ 4️⃣ Transform Data                        [▶]  │   │ │
│  │   │ 5️⃣ Upsert to Graph                       [▶]  │   │ │
│  │   └─────────────────────────────────────────────────┘   │ │
│  └───────────────────────────────────────────────────────────┘ │
│                                                                 │
│  [Cancel] [Save]                                                │
└─────────────────────────────────────────────────────────────────┘
```

---

## 3. Custom Widgets

### 3.1 MonacoWidget

**File:** `/graph-editor/src/components/widgets/MonacoWidget.tsx`

```typescript
import Editor from '@monaco-editor/react';
import { WidgetProps } from '@rjsf/utils';

export function MonacoWidget(props: WidgetProps) {
  const { value, onChange, options, disabled, readonly, id } = props;
  
  return (
    <div className="monaco-widget">
      <Editor
        height={options?.height || '200px'}
        language={options?.language || 'json'}
        value={value || ''}
        onChange={(v) => onChange(v || '')}
        options={{
          minimap: { enabled: options?.minimap !== false },
          lineNumbers: options?.lineNumbers || 'on',
          readOnly: disabled || readonly,
          wordWrap: options?.wordWrap || 'off',
          scrollBeyondLastLine: options?.scrollBeyondLastLine !== false,
          formatOnPaste: true,
          formatOnType: options?.formatOnType || false,
          theme: 'vs-light',
          fontSize: 12,
          tabSize: 2
        }}
        onMount={(editor) => {
          // Auto-format on blur if enabled
          if (options?.formatOnBlur && options?.language === 'json') {
            editor.onDidBlurEditorText(() => {
              try {
                const formatted = JSON.stringify(JSON.parse(editor.getValue()), null, 2);
                editor.setValue(formatted);
              } catch {
                // Invalid JSON, don't format
              }
            });
          }
        }}
      />
    </div>
  );
}
```

**Usage in UI Schema:**
```json
{
  "body_template": {
    "ui:widget": "MonacoWidget",
    "ui:options": {
      "language": "json",
      "height": "200px",
      "minimap": false,
      "lineNumbers": "on",
      "formatOnBlur": true
    }
  }
}
```

### 3.2 TabbedArrayWidget

**File:** `/graph-editor/src/components/widgets/TabbedArrayWidget.tsx`

```typescript
import React, { useState } from 'react';
import { ArrayFieldTemplateProps } from '@rjsf/utils';
import { Tabs, Tab, IconButton, Box } from '@mui/material';
import AddIcon from '@mui/icons-material/Add';
import DeleteIcon from '@mui/icons-material/Delete';

export function TabbedArrayWidget(props: ArrayFieldTemplateProps) {
  const [activeTab, setActiveTab] = useState(0);
  const { items, onAddClick, canAdd, uiSchema } = props;
  
  const tabField = uiSchema?.['ui:options']?.tabField || 'name';
  const addButtonText = uiSchema?.['ui:options']?.addButtonText || '+ New';
  
  return (
    <Box sx={{ width: '100%' }}>
      <Tabs 
        value={activeTab} 
        onChange={(e, v) => setActiveTab(v)}
        variant="scrollable"
        scrollButtons="auto"
      >
        {items.map((item, i) => {
          const itemData = item.children.props.formData;
          const label = itemData?.[tabField] || `Item ${i + 1}`;
          
          return (
            <Tab 
              key={i} 
              label={
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                  {label}
                  {item.hasRemove && (
                    <IconButton
                      size="small"
                      onClick={(e) => {
                        e.stopPropagation();
                        item.onDropIndexClick(item.index)();
                        if (activeTab >= i && activeTab > 0) {
                          setActiveTab(activeTab - 1);
                        }
                      }}
                    >
                      <DeleteIcon fontSize="small" />
                    </IconButton>
                  )}
                </Box>
              }
            />
          );
        })}
        {canAdd && (
          <Tab 
            icon={<AddIcon />} 
            label={addButtonText}
            onClick={() => {
              onAddClick();
              setActiveTab(items.length); // Switch to new tab
            }}
          />
        )}
      </Tabs>
      
      <Box sx={{ p: 2, border: '1px solid #ddd', borderTop: 'none' }}>
        {items.map((item, i) => (
          <Box key={i} sx={{ display: activeTab === i ? 'block' : 'none' }}>
            {item.children}
          </Box>
        ))}
        {items.length === 0 && (
          <Box sx={{ p: 4, textAlign: 'center', color: 'text.secondary' }}>
            No connections yet. Click "+ New" to add one.
          </Box>
        )}
      </Box>
    </Box>
  );
}
```

**Usage in UI Schema:**
```json
{
  "connections": {
    "ui:widget": "TabbedArrayWidget",
    "ui:options": {
      "tabField": "name",
      "addButtonText": "+ New Connection"
    }
  }
}
```

### 3.3 Widget Registration

**File:** `/graph-editor/src/components/FormEditor.tsx`

```typescript
import { MonacoWidget } from './widgets/MonacoWidget';
import { TabbedArrayWidget } from './widgets/TabbedArrayWidget';

const customWidgets = {
  MonacoWidget,
  // TabbedArrayWidget registered as ArrayFieldTemplate, not widget
};

const customTemplates = {
  ArrayFieldTemplate: TabbedArrayWidget
};

<Form
  schema={schema}
  uiSchema={uiSchema}
  widgets={customWidgets}
  templates={customTemplates}
  formData={formData}
  onChange={handleChange}
/>
```

---

## 4. Window Selector

**Component:** Graph-level date range picker for data fetching

### 4.1 Specification

**Location:** Floating at top-middle of graph canvas  
**Default:** Last 7 days  
**State:** GraphContext (runtime, NOT persisted in graph file)  
**Synced:** Across all tabs viewing same graph

### 4.2 Implementation

**File:** `/graph-editor/src/components/WindowSelector.tsx`

```typescript
import React from 'react';
import { Box, TextField } from '@mui/material';
import { LocalizationProvider } from '@mui/x-date-pickers/LocalizationProvider';
import { AdapterDayjs } from '@mui/x-date-pickers/AdapterDayjs';
import { DateRangePicker } from '@mui/x-date-pickers-pro/DateRangePicker';
import dayjs, { Dayjs } from 'dayjs';
import { useGraphContext } from '../contexts/GraphContext';

export function WindowSelector() {
  const { window, setWindow } = useGraphContext();
  
  const handleChange = (newValue: [Dayjs | null, Dayjs | null]) => {
    const [start, end] = newValue;
    if (start && end) {
      setWindow({
        start: start.format('YYYY-MM-DD'),
        end: end.format('YYYY-MM-DD')
      });
    }
  };
  
  return (
    <Box
      sx={{
        position: 'absolute',
        top: 16,
        left: '50%',
        transform: 'translateX(-50%)',
        zIndex: 100,
        backgroundColor: 'white',
        padding: 1,
        borderRadius: 1,
        boxShadow: 2
      }}
    >
      <LocalizationProvider dateAdapter={AdapterDayjs}>
        <DateRangePicker
          startText="From"
          endText="To"
          value={[
            window?.start ? dayjs(window.start) : dayjs().subtract(7, 'days'),
            window?.end ? dayjs(window.end) : dayjs()
          ]}
          onChange={handleChange}
          renderInput={(startProps, endProps) => (
            <>
              <TextField {...startProps} size="small" />
              <Box sx={{ mx: 1 }}> to </Box>
              <TextField {...endProps} size="small" />
            </>
          )}
        />
      </LocalizationProvider>
    </Box>
  );
}
```

### 4.3 Integration

**File:** `/graph-editor/src/components/GraphEditor.tsx`

```typescript
import { WindowSelector } from './WindowSelector';

export function GraphEditor() {
  const { graph } = useGraphContext();
  
  // Only show window selector if graph has external connections
  const hasExternalConnections = useMemo(() => {
    return graph?.edges?.some(e => e.p?.connection) || false;
  }, [graph]);
  
  return (
    <div className="graph-editor">
      {hasExternalConnections && <WindowSelector />}
      <ReactFlowProvider>
        {/* ... graph canvas ... */}
      </ReactFlowProvider>
    </div>
  );
}
```

### 4.4 GraphContext State

**File:** `/graph-editor/src/contexts/GraphContext.tsx`

```typescript
interface DataFetchContext {
  window?: {
    start: string;  // ISO date YYYY-MM-DD
    end: string;
  };
  context?: {
    id?: string;
    label?: string;
    filters?: Record<string, any>;
  };
}

interface GraphContextType {
  graph: any;
  setGraph: (graph: any) => void;
  dataFetchContext: DataFetchContext;
  setWindow: (window: {start: string; end: string}) => void;
  setContext: (context: any) => void;
}

const GraphContext = createContext<GraphContextType>(null!);

export function GraphContextProvider({ children }) {
  const [graph, setGraph] = useState(null);
  const [dataFetchContext, setDataFetchContext] = useState<DataFetchContext>({
    window: {
      start: dayjs().subtract(7, 'days').format('YYYY-MM-DD'),
      end: dayjs().format('YYYY-MM-DD')
    }
  });
  
  const setWindow = useCallback((window: {start: string; end: string}) => {
    setDataFetchContext(prev => ({ ...prev, window }));
  }, []);
  
  const setContext = useCallback((context: any) => {
    setDataFetchContext(prev => ({ ...prev, context }));
  }, []);
  
  return (
    <GraphContext.Provider value={{
      graph,
      setGraph,
      dataFetchContext,
      setWindow,
      setContext
    }}>
      {children}
    </GraphContext.Provider>
  );
}
```

---

## 5. Connection Selector Dropdown

**Component:** Dropdown in parameter/case editors for selecting connection

### 5.1 Implementation

**File:** `/graph-editor/src/components/ConnectionSelector.tsx`

```typescript
import React, { useEffect, useState } from 'react';
import { Select, MenuItem, FormControl, InputLabel, Chip } from '@mui/material';
import { IndexedDBConnectionProvider } from '../lib/das/ConnectionProvider';

interface Connection {
  name: string;
  provider: string;
  enabled: boolean;
  description?: string;
}

interface ConnectionSelectorProps {
  value: string;
  onChange: (connectionName: string) => void;
  label?: string;
}

export function ConnectionSelector({ value, onChange, label }: ConnectionSelectorProps) {
  const [connections, setConnections] = useState<Connection[]>([]);
  const [loading, setLoading] = useState(true);
  
  useEffect(() => {
    loadConnections();
  }, []);
  
  async function loadConnections() {
    try {
      const provider = new IndexedDBConnectionProvider();
      const allConnections = await provider.getAllConnections();
      setConnections(allConnections.filter(c => c.enabled));
    } catch (error) {
      console.error('Failed to load connections:', error);
      setConnections([]);
    } finally {
      setLoading(false);
    }
  }
  
  return (
    <FormControl fullWidth size="small">
      <InputLabel>{label || 'Connection'}</InputLabel>
      <Select
        value={value || ''}
        onChange={(e) => onChange(e.target.value)}
        label={label || 'Connection'}
        disabled={loading}
      >
        <MenuItem value="">
          <em>None (manual input)</em>
        </MenuItem>
        {connections.map(conn => (
          <MenuItem key={conn.name} value={conn.name}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              {conn.name}
              <Chip label={conn.provider} size="small" variant="outlined" />
            </div>
            {conn.description && (
              <div style={{ fontSize: '0.85em', color: '#666', marginLeft: 24 }}>
                {conn.description}
              </div>
            )}
          </MenuItem>
        ))}
      </Select>
      {connections.length === 0 && !loading && (
        <div style={{ fontSize: '0.85em', color: '#999', marginTop: 4 }}>
          No connections configured. Go to File > Connections to add one.
        </div>
      )}
    </FormControl>
  );
}
```

### 5.2 Integration in EdgePropertiesPanel

**File:** `/graph-editor/src/components/EdgePropertiesPanel.tsx`

```typescript
import { ConnectionSelector } from './ConnectionSelector';

export function EdgePropertiesPanel() {
  const { selectedEdge, updateEdge } = useGraphContext();
  
  return (
    <div className="properties-panel">
      <h3>Edge Properties</h3>
      
      {/* Existing fields: mean, stdev, etc. */}
      
      <Divider sx={{ my: 2 }} />
      
      <Typography variant="h6" gutterBottom>External Data Source</Typography>
      
      <ConnectionSelector
        value={selectedEdge.p?.connection}
        onChange={(connection) => {
          updateEdge({
            ...selectedEdge,
            p: { ...selectedEdge.p, connection }
          });
        }}
        label="Data Connection"
      />
      
      {selectedEdge.p?.connection && (
        <>
          <Button
            variant="outlined"
            onClick={handleEditConnectionString}
            startIcon={<SettingsIcon />}
            sx={{ mt: 1 }}
          >
            Edit Connection Settings
          </Button>
          
          <Button
            variant="contained"
            onClick={handleGetFromSource}
            startIcon={<RefreshIcon />}
            disabled={loading}
            sx={{ mt: 1 }}
          >
            {loading ? 'Fetching...' : 'Get from Source'}
          </Button>
          
          {selectedEdge.p?.evidence && (
            <EvidenceDisplay evidence={selectedEdge.p.evidence} />
          )}
        </>
      )}
    </div>
  );
}
```

---

## 6. Evidence Display

**Component:** Read-only display of last fetch metadata

### 6.1 Implementation

**File:** `/graph-editor/src/components/EvidenceDisplay.tsx`

```typescript
import React from 'react';
import { Box, Typography, Chip } from '@mui/material';
import CheckCircleIcon from '@mui/icons-material/CheckCircle';
import dayjs from 'dayjs';
import relativeTime from 'dayjs/plugin/relativeTime';

dayjs.extend(relativeTime);

interface EvidenceDisplayProps {
  evidence: {
    n: number;
    k: number;
    window_from: string;
    window_to: string;
    source: string;
    fetched_at: string;
    context_id?: string;
  };
}

export function EvidenceDisplay({ evidence }: EvidenceDisplayProps) {
  const p = evidence.k / evidence.n;
  const fetchedAgo = dayjs(evidence.fetched_at).fromNow();
  
  return (
    <Box
      sx={{
        mt: 2,
        p: 2,
        backgroundColor: '#f5f5f5',
        borderRadius: 1,
        border: '1px solid #e0e0e0'
      }}
    >
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 1 }}>
        <CheckCircleIcon color="success" fontSize="small" />
        <Typography variant="subtitle2">
          Data fetched {fetchedAgo}
        </Typography>
      </Box>
      
      <Typography variant="body2" color="text.secondary">
        Source: <Chip label={evidence.source} size="small" variant="outlined" />
      </Typography>
      
      <Typography variant="body2" color="text.secondary">
        Window: {dayjs(evidence.window_from).format('MMM D, YYYY')} → {dayjs(evidence.window_to).format('MMM D, YYYY')}
      </Typography>
      
      {evidence.context_id && (
        <Typography variant="body2" color="text.secondary">
          Context: {evidence.context_id}
        </Typography>
      )}
      
      <Box sx={{ mt: 1, p: 1, backgroundColor: 'white', borderRadius: 0.5 }}>
        <Typography variant="body2" fontFamily="monospace">
          n = {evidence.n.toLocaleString()} (sample size)
        </Typography>
        <Typography variant="body2" fontFamily="monospace">
          k = {evidence.k.toLocaleString()} (conversions)
        </Typography>
        <Typography variant="body2" fontFamily="monospace">
          p = {(p * 100).toFixed(2)}%
        </Typography>
      </Box>
    </Box>
  );
}
```

---

## 7. Context Selector (Stubbed for v1)

**Component:** Future context/segment selector

### 7.1 v1 Implementation (Minimal)

```typescript
export function ContextSelector() {
  return (
    <Box sx={{ ml: 2, display: 'inline-flex', alignItems: 'center', opacity: 0.5 }}>
      <Typography variant="body2" color="text.secondary">
        Context:
      </Typography>
      <Select value="none" disabled size="small" sx={{ ml: 1, minWidth: 120 }}>
        <MenuItem value="none">None</MenuItem>
      </Select>
    </Box>
  );
}
```

**Future (v2):** Full context selector with:
- Load contexts from configuration
- Apply filters to data fetches
- Save context as part of view state

---

## 8. Implementation Checklist

Phase 1 (10-14 hours):
- [ ] Implement MonacoWidget (3-4 hrs)
- [ ] Implement TabbedArrayWidget (4-5 hrs)
- [ ] Register widgets in FormEditor (1 hr)
- [ ] Create connections-ui-schema.json (1-2 hrs)
- [ ] Test connections.yaml editing (1-2 hrs)

Phase 3 (10-12 hours):
- [ ] Implement WindowSelector (2-3 hrs)
- [ ] Add GraphContext state management (2 hrs)
- [ ] Implement ConnectionSelector (2 hrs)
- [ ] Implement EvidenceDisplay (1-2 hrs)
- [ ] Add "Get from source" button & logic (3-4 hrs)

---

**Reference:** See `../../ARCHIVE/EXTERNAL_DATA_SYSTEM_DESIGN.md` lines 1270-1761 for complete UI schema JSON and lines 1961-2190 for Window Selector details

