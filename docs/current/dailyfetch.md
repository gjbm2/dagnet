# Daily Fetch Feature Design

## Overview

Add a `dailyFetch` boolean flag to graphs that marks them for inclusion in unattended nightly automation. When `?retrieveall` is specified **without** a graph name, the system enumerates all graphs in IndexedDB with `dailyFetch: true` and processes them sequentially.

## Current Behaviour

- `?retrieveall=graph-a,graph-b` — explicit list of graphs processed in sequence
- `?retrieveall=graph-a` — single graph
- `?graph=name&retrieveall` — boolean flag with graph param
- PowerShell script (`setup-daily-retrieve.ps1`) prompts user for graph name(s) and stores them in the task URL

## Proposed Behaviour

- `?retrieveall` (no value) — enumerate all graphs in IDB where `dailyFetch === true`, process in sequence
- **Workspace scoped**: enumeration only considers graphs from the **currently selected repository and branch** (other repos require separate browser containers)
- **IDB dedupe**: must dedupe prefixed vs unprefixed fileIds (use existing `dedupeWorkspacePrefixedVariants` pattern from `IntegrityCheckService`)
- Graphs **must** be loaded into IDB before the check (workspace must be cloned/opened)
- **Missing pinned query**: graphs with `dailyFetch=true` but no `dataInterestsDSL` will still be processed; existing behaviour (warning + skip retrieve step) is acceptable
- PowerShell script gains option to schedule without specifying graph names (relies on IDB `dailyFetch` flags)
- UI: "Pinned Data Interests" modal gains a "Fetch daily" checkbox to set/unset `dailyFetch`
- UI: Data menu gains "Automated Daily Fetches…" modal for bulk management (current workspace only)

---

## Code Changes Required

### 1. TypeScript Type: `ConversionGraph`

**File:** `graph-editor/src/types/index.ts`

Add new boolean field to `ConversionGraph` interface (around line 875):

```typescript
export interface ConversionGraph {
  nodes: GraphNode[];
  edges: GraphEdge[];
  policies: Policies;
  metadata: Metadata;
  postits?: PostIt[];
  debugging?: boolean;
  
  dataInterestsDSL?: string;
  currentQueryDSL?: string;
  baseDSL?: string;
  
  /** If true, this graph is included in unattended `?retrieveall` runs (no explicit graph name). */
  dailyFetch?: boolean;  // <-- ADD THIS
}
```

### 2. JSON Schema Update

**File:** `graph-editor/public/schemas/conversion-graph-1.1.0.json`

Add `dailyFetch` property to root object (after `baseDSL`, around line 33):

```json
"dailyFetch": {
  "type": "boolean",
  "default": false,
  "description": "If true, this graph is included in unattended daily automation runs when ?retrieveall is used without an explicit graph list."
}
```

### 2.1 Python Pydantic Model Update

**File:** `graph-editor/lib/graph_types.py`

Add `dailyFetch` field to the `Graph` class (around line 325, after `debugging`):

```python
class Graph(BaseModel):
    """Complete conversion funnel graph."""
    nodes: List[Node] = Field(..., min_length=1)
    edges: List[Edge]
    policies: Policies
    metadata: Metadata
    baseDSL: Optional[str] = Field(None, description="Base DSL that is always applied (e.g. global context filters)")
    currentQueryDSL: Optional[str] = Field(None, description="Current user query DSL for UI persistence")
    dataInterestsDSL: Optional[str] = Field(None, description="Pinned DSL for batch/overnight fetches")
    debugging: Optional[bool] = Field(None, description="If true, run Graph Issues checks while this graph is open and show an Issues indicator overlay.")
    dailyFetch: Optional[bool] = Field(None, description="If true, this graph is included in unattended daily automation runs when ?retrieveall is used without an explicit graph list.")  # <-- ADD THIS
```

### 2.2 Schema Consistency Tests

The existing schema consistency tests will automatically verify alignment:

- **TypeScript vs JSON Schema:** `graph-editor/src/services/__tests__/schemaTypesConsistency.test.ts`
- **Python vs JSON Schema:** `graph-editor/lib/tests/test_schema_python_consistency.py`

**Optional enhancement:** Add an explicit test for `dailyFetch` in both test files to ensure the field is present in all three places (JSON schema, TypeScript type, Python model).

In `test_schema_python_consistency.py`, add to `TestGraphSchemaConsistency`:

```python
def test_daily_fetch_field_exists(self, schema):
    """Graph should have dailyFetch field in both schema and Python."""
    schema_props = set(schema.get('properties', {}).keys())
    python_props = get_pydantic_field_names(Graph)
    
    assert 'dailyFetch' in schema_props, "Schema missing dailyFetch"
    assert 'dailyFetch' in python_props, "Python missing dailyFetch"
    
    # Python model should accept the field
    graph_data = {
        'nodes': [{'uuid': '123e4567-e89b-12d3-a456-426614174000', 'id': 'start'}],
        'edges': [],
        'policies': {'default_outcome': 'success'},
        'metadata': {'version': '1.0.0'},
        'dailyFetch': True
    }
    graph = Graph(**graph_data)
    assert graph.dailyFetch is True
```

In `schemaTypesConsistency.test.ts`, add to the Graph schema tests:

```typescript
it('should have dailyFetch field in schema and type', () => {
  const schemaProps = Object.keys(schema.properties || {});
  expect(schemaProps).toContain('dailyFetch');
  
  // TypeScript compile-time check: if dailyFetch isn't in ConversionGraph, this won't compile
  const testGraph: ConversionGraph = {
    nodes: [{ uuid: '123', id: 'start' }],
    edges: [],
    policies: { default_outcome: 'success' },
    metadata: { version: '1.0.0' },
    dailyFetch: true  // Must be allowed by type
  };
  expect(testGraph.dailyFetch).toBe(true);
});
```

### 3. Hook: `useURLDailyRetrieveAllQueue`

**File:** `graph-editor/src/hooks/useURLDailyRetrieveAllQueue.ts`

#### 3.1 New Helper: Enumerate Daily-Fetch Graphs from IDB

Add a new function to enumerate graphs from IndexedDB:

```typescript
import { db } from '../db/appDatabase';
import type { GraphData } from '../types';
import { IntegrityCheckService } from '../services/integrityCheckService';

/**
 * Enumerate all graphs in IndexedDB that have `dailyFetch: true`.
 * Returns graph names (without 'graph-' prefix), sorted alphabetically for determinism.
 * 
 * IMPORTANT: Applies workspace scoping (repo/branch) and dedupes prefixed/unprefixed fileIds.
 */
async function enumerateDailyFetchGraphsFromIDB(workspace: { repository: string; branch: string }): Promise<string[]> {
  const allGraphFiles = await db.files
    .where('type')
    .equals('graph')
    .and((file) =>
      file.source?.repository === workspace.repository &&
      file.source?.branch === workspace.branch
    )
    .toArray();

  // Dedupe prefixed vs unprefixed variants (IDB can have both)
  const deduped = IntegrityCheckService.dedupeWorkspacePrefixedVariants(allGraphFiles);

  const names: string[] = [];
  for (const file of deduped) {
    const graph = file.data as GraphData | null;
    if (graph?.dailyFetch) {
      // fileId is 'graph-<name>' or 'repo-branch-graph-<name>', extract canonical name
      const canonicalFileId = file.fileId.includes('-graph-') 
        ? file.fileId.split('-graph-').pop()! 
        : (file.fileId.startsWith('graph-') ? file.fileId.slice(6) : file.fileId);
      names.push(canonicalFileId);
    }
  }

  return names.sort((a, b) => a.localeCompare(b));
}
```

#### 3.2 Modify `resolveTargetGraphNames` Logic

In the main effect, after determining that `hasRetrieveAllFlag` is true but `targetGraphNames.length === 0`, call the enumeration function:

```typescript
function resolveTargetGraphNames(params: URLDailyRetrieveAllQueueParams): string[] {
  const fromRetrieveAll = normaliseGraphNames(params.retrieveAllValues);
  if (fromRetrieveAll.length > 0) return fromRetrieveAll;

  if (params.hasRetrieveAllFlag && params.graphParam && params.graphParam.trim() !== '') {
    return [params.graphParam.trim()];
  }

  // CHANGE: Return empty array to signal "enumerate from IDB" mode
  // The caller will handle this case separately.
  return [];
}
```

#### 3.3 Main Effect Changes

In the main `useEffect`, after the waiting loop completes and `repoFinal`/`branchFinal` are known:

```typescript
// Resolve target graphs — if empty, enumerate from IDB
let targetGraphNames = resolveTargetGraphNames(params);

if (targetGraphNames.length === 0 && params.hasRetrieveAllFlag) {
  // Enumerate dailyFetch graphs from IDB
  sessionLogService.info(
    'session',
    'DAILY_RETRIEVE_ALL_ENUMERATE',
    'Enumerating graphs with dailyFetch=true from workspace',
    undefined,
    { repository: repoFinal, branch: branchFinal }
  );

  targetGraphNames = await enumerateDailyFetchGraphsFromIDB({
    repository: repoFinal,
    branch: branchFinal,
  });

  if (targetGraphNames.length === 0) {
    sessionLogService.warning(
      'session',
      'DAILY_RETRIEVE_ALL_NO_GRAPHS',
      'No graphs with dailyFetch=true found in workspace',
      undefined,
      { repository: repoFinal, branch: branchFinal }
    );
    return; // Nothing to process
  }

  sessionLogService.info(
    'session',
    'DAILY_RETRIEVE_ALL_FOUND',
    `Found ${targetGraphNames.length} graph(s) with dailyFetch=true`,
    targetGraphNames.join(', '),
    { graphs: targetGraphNames }
  );
}

if (targetGraphNames.length === 0) return; // No graphs specified or found

// IMPORTANT: Create runId AFTER enumeration so it reflects actual graph list
// (existing code creates runId early from URL params; for enumeration mode, defer until here)
const runId = `retrieveall-queue:${targetGraphNames.join(',')}:${Date.now()}`;
automationRunService.start({
  runId,
  graphFileId: `graph-${targetGraphNames[0]}`,
  graphName: targetGraphNames[0],
});
```

#### 3.4 Enhanced Session Logging for Multi-Graph Runs

Update the main processing loop to log sequence position:

```typescript
for (let idx = 0; idx < targetGraphNames.length; idx++) {
  const graphName = targetGraphNames[idx];
  const sequenceInfo = `[${idx + 1}/${targetGraphNames.length}]`;

  if (automationRunService.shouldStop(runId)) {
    sessionLogService.warning(
      'session',
      'DAILY_RETRIEVE_ALL_ABORTED',
      `${sequenceInfo} Daily automation aborted by user`,
      undefined,
      { graphs: targetGraphNames, stoppedAt: graphName }
    );
    return;
  }

  sessionLogService.info(
    'session',
    'DAILY_RETRIEVE_ALL_GRAPH_START',
    `${sequenceInfo} Starting: ${graphName}`,
    undefined,
    { graph: graphName, index: idx, total: targetGraphNames.length }
  );

  // ... existing logic to open tab, wait for data, run automation ...

  sessionLogService.info(
    'session',
    'DAILY_RETRIEVE_ALL_GRAPH_COMPLETE',
    `${sequenceInfo} Completed: ${graphName}`,
    undefined,
    { graph: graphName, index: idx, total: targetGraphNames.length }
  );
}
```

### 4. UI: "Fetch daily" Checkbox in Pinned Query Modal

**File:** `graph-editor/src/components/modals/PinnedQueryModal.tsx`

#### 4.1 Update Props Interface

```typescript
interface PinnedQueryModalProps {
  isOpen: boolean;
  currentDSL: string;
  dailyFetch: boolean;  // <-- ADD
  onSave: (newDSL: string, dailyFetch: boolean) => void;  // <-- CHANGE
  onClose: () => void;
}
```

#### 4.2 Add State and Checkbox

```typescript
export function PinnedQueryModal({ isOpen, currentDSL, dailyFetch, onSave, onClose }: PinnedQueryModalProps) {
  const [draftDSL, setDraftDSL] = useState(currentDSL);
  const [draftDailyFetch, setDraftDailyFetch] = useState(dailyFetch);  // <-- ADD
  // ... existing state ...

  // Update drafts when modal opens
  useEffect(() => {
    if (isOpen) {
      setDraftDSL(currentDSL);
      setDraftDailyFetch(dailyFetch);  // <-- ADD
    }
  }, [isOpen, currentDSL, dailyFetch]);

  const handleSave = () => {
    onSave(draftDSL, draftDailyFetch);  // <-- CHANGE
    onClose();
  };
  // ...
}
```

#### 4.3 Add Checkbox UI (in modal body, after DSL editor section)

```tsx
<div style={{ marginTop: '16px', marginBottom: '16px' }}>
  <label style={{ display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer' }}>
    <input
      type="checkbox"
      checked={draftDailyFetch}
      onChange={(e) => setDraftDailyFetch(e.target.checked)}
      style={{ width: '16px', height: '16px' }}
    />
    <span style={{ fontSize: '13px', color: '#374151' }}>
      Fetch daily
    </span>
  </label>
  <p style={{ fontSize: '11px', color: '#6B7280', marginTop: '4px', marginLeft: '24px' }}>
    Include this graph in unattended nightly automation runs
  </p>
</div>
```

### 5. New Modal: DailyFetchManagerModal

**File:** `graph-editor/src/components/modals/DailyFetchManagerModal.tsx` (new file)

A transfer-list style modal for bulk management of which graphs have `dailyFetch: true`.

**Key constraints:**
- **Workspace scoped**: only shows graphs from the currently selected repository/branch (other repos require separate browser containers)
- **IDB dedupe**: must dedupe prefixed/unprefixed fileIds before display (same pattern as enumeration)
- **No logic in UI**: the modal is a pure access point; save logic lives in a **service method** (e.g. `dailyFetchService.applyChanges()` or extend `workspaceService`), not inline in the modal or DataMenu

#### 5.1 Modal Structure

```
┌─────────────────────────────────────────────────────────────┐
│  Automated Daily Fetches                              [X]   │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  ┌─────────────────────┐       ┌─────────────────────┐     │
│  │ Available Graphs    │       │ Daily Fetch Enabled │     │
│  ├─────────────────────┤       ├─────────────────────┤     │
│  │ ☐ conversion-funnel │       │ ☐ marketing-metrics │     │
│  │ ☐ sales-pipeline    │  [>]  │ ☐ user-journey      │     │
│  │ ☐ checkout-flow     │  [<]  │                     │     │
│  │                     │       │                     │     │
│  └─────────────────────┘       └─────────────────────┘     │
│                                                             │
│  ℹ️ Graphs with Daily Fetch enabled will be processed      │
│     automatically when using ?retrieveall (no graph name)   │
│                                                             │
├─────────────────────────────────────────────────────────────┤
│                                    [Cancel]  [Save Changes] │
└─────────────────────────────────────────────────────────────┘
```

#### 5.2 Props Interface

```typescript
interface DailyFetchManagerModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSave: (changes: Array<{ graphFileId: string; dailyFetch: boolean }>) => Promise<void>;
}
```

#### 5.3 Implementation Outline

```typescript
import React, { useState, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { X, ChevronRight, ChevronLeft } from 'lucide-react';
import { db } from '../../db/appDatabase';
import type { GraphData } from '../../types';
import './Modal.css';

interface GraphItem {
  fileId: string;
  name: string;
  dailyFetch: boolean;
  hasPinnedQuery: boolean;  // Show warning if no dataInterestsDSL
}

export function DailyFetchManagerModal({ isOpen, onClose, onSave }: DailyFetchManagerModalProps) {
  const [allGraphs, setAllGraphs] = useState<GraphItem[]>([]);
  const [selectedLeft, setSelectedLeft] = useState<Set<string>>(new Set());
  const [selectedRight, setSelectedRight] = useState<Set<string>>(new Set());
  const [pendingChanges, setPendingChanges] = useState<Map<string, boolean>>(new Map());
  const [saving, setSaving] = useState(false);

  // Load all graphs from IDB on open
  useEffect(() => {
    if (!isOpen) return;
    
    (async () => {
      const graphFiles = await db.files
        .where('type')
        .equals('graph')
        .toArray();
      
      const items: GraphItem[] = graphFiles.map(file => {
        const data = file.data as GraphData | null;
        const name = file.fileId.startsWith('graph-') 
          ? file.fileId.slice(6) 
          : file.fileId;
        return {
          fileId: file.fileId,
          name,
          dailyFetch: data?.dailyFetch ?? false,
          hasPinnedQuery: !!(data?.dataInterestsDSL),
        };
      });
      
      // Sort alphabetically
      items.sort((a, b) => a.name.localeCompare(b.name));
      setAllGraphs(items);
      setPendingChanges(new Map());
    })();
  }, [isOpen]);

  // Derive current state (original + pending changes)
  const getEffectiveDailyFetch = (item: GraphItem): boolean => {
    return pendingChanges.has(item.fileId) 
      ? pendingChanges.get(item.fileId)! 
      : item.dailyFetch;
  };

  const availableGraphs = allGraphs.filter(g => !getEffectiveDailyFetch(g));
  const enabledGraphs = allGraphs.filter(g => getEffectiveDailyFetch(g));

  const moveToEnabled = () => {
    const newChanges = new Map(pendingChanges);
    selectedLeft.forEach(fileId => newChanges.set(fileId, true));
    setPendingChanges(newChanges);
    setSelectedLeft(new Set());
  };

  const moveToAvailable = () => {
    const newChanges = new Map(pendingChanges);
    selectedRight.forEach(fileId => newChanges.set(fileId, false));
    setPendingChanges(newChanges);
    setSelectedRight(new Set());
  };

  const handleSave = async () => {
    if (pendingChanges.size === 0) {
      onClose();
      return;
    }
    
    setSaving(true);
    try {
      const changes = Array.from(pendingChanges.entries()).map(([fileId, dailyFetch]) => ({
        graphFileId: fileId,
        dailyFetch,
      }));
      await onSave(changes);
      onClose();
    } finally {
      setSaving(false);
    }
  };

  if (!isOpen) return null;

  return createPortal(
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-container" onClick={e => e.stopPropagation()} style={{ maxWidth: '700px' }}>
        <div className="modal-header">
          <h2 className="modal-title">Automated Daily Fetches</h2>
          <button onClick={onClose} className="modal-close-btn"><X size={20} /></button>
        </div>
        
        <div className="modal-body">
          <div style={{ display: 'flex', gap: '16px', alignItems: 'stretch' }}>
            {/* Left: Available graphs */}
            <div style={{ flex: 1 }}>
              <div style={{ fontWeight: 600, marginBottom: '8px', fontSize: '13px' }}>
                Available Graphs ({availableGraphs.length})
              </div>
              <div style={{ 
                border: '1px solid #E5E7EB', 
                borderRadius: '4px', 
                height: '250px', 
                overflowY: 'auto',
                background: '#F9FAFB'
              }}>
                {availableGraphs.map(g => (
                  <label key={g.fileId} style={{ 
                    display: 'flex', 
                    alignItems: 'center', 
                    gap: '8px', 
                    padding: '8px 12px',
                    cursor: 'pointer',
                    borderBottom: '1px solid #E5E7EB',
                    background: selectedLeft.has(g.fileId) ? '#DBEAFE' : 'transparent'
                  }}>
                    <input
                      type="checkbox"
                      checked={selectedLeft.has(g.fileId)}
                      onChange={e => {
                        const newSet = new Set(selectedLeft);
                        e.target.checked ? newSet.add(g.fileId) : newSet.delete(g.fileId);
                        setSelectedLeft(newSet);
                      }}
                    />
                    <span style={{ fontSize: '13px' }}>{g.name}</span>
                    {!g.hasPinnedQuery && (
                      <span title="No pinned query set" style={{ color: '#F59E0B' }}>⚠️</span>
                    )}
                  </label>
                ))}
                {availableGraphs.length === 0 && (
                  <div style={{ padding: '16px', color: '#6B7280', fontSize: '12px', textAlign: 'center' }}>
                    All graphs are enabled for daily fetch
                  </div>
                )}
              </div>
            </div>
            
            {/* Center: Transfer buttons */}
            <div style={{ display: 'flex', flexDirection: 'column', justifyContent: 'center', gap: '8px' }}>
              <button
                onClick={moveToEnabled}
                disabled={selectedLeft.size === 0}
                style={{ 
                  padding: '8px 12px', 
                  borderRadius: '4px',
                  border: '1px solid #D1D5DB',
                  background: selectedLeft.size > 0 ? '#3B82F6' : '#F3F4F6',
                  color: selectedLeft.size > 0 ? 'white' : '#9CA3AF',
                  cursor: selectedLeft.size > 0 ? 'pointer' : 'not-allowed'
                }}
              >
                <ChevronRight size={16} />
              </button>
              <button
                onClick={moveToAvailable}
                disabled={selectedRight.size === 0}
                style={{ 
                  padding: '8px 12px', 
                  borderRadius: '4px',
                  border: '1px solid #D1D5DB',
                  background: selectedRight.size > 0 ? '#3B82F6' : '#F3F4F6',
                  color: selectedRight.size > 0 ? 'white' : '#9CA3AF',
                  cursor: selectedRight.size > 0 ? 'pointer' : 'not-allowed'
                }}
              >
                <ChevronLeft size={16} />
              </button>
            </div>
            
            {/* Right: Enabled graphs */}
            <div style={{ flex: 1 }}>
              <div style={{ fontWeight: 600, marginBottom: '8px', fontSize: '13px' }}>
                Daily Fetch Enabled ({enabledGraphs.length})
              </div>
              <div style={{ 
                border: '1px solid #E5E7EB', 
                borderRadius: '4px', 
                height: '250px', 
                overflowY: 'auto',
                background: '#F0FDF4'
              }}>
                {enabledGraphs.map(g => (
                  <label key={g.fileId} style={{ 
                    display: 'flex', 
                    alignItems: 'center', 
                    gap: '8px', 
                    padding: '8px 12px',
                    cursor: 'pointer',
                    borderBottom: '1px solid #E5E7EB',
                    background: selectedRight.has(g.fileId) ? '#DBEAFE' : 'transparent'
                  }}>
                    <input
                      type="checkbox"
                      checked={selectedRight.has(g.fileId)}
                      onChange={e => {
                        const newSet = new Set(selectedRight);
                        e.target.checked ? newSet.add(g.fileId) : newSet.delete(g.fileId);
                        setSelectedRight(newSet);
                      }}
                    />
                    <span style={{ fontSize: '13px' }}>{g.name}</span>
                    {!g.hasPinnedQuery && (
                      <span title="No pinned query set" style={{ color: '#F59E0B' }}>⚠️</span>
                    )}
                  </label>
                ))}
                {enabledGraphs.length === 0 && (
                  <div style={{ padding: '16px', color: '#6B7280', fontSize: '12px', textAlign: 'center' }}>
                    No graphs enabled for daily fetch
                  </div>
                )}
              </div>
            </div>
          </div>
          
          <p style={{ marginTop: '16px', fontSize: '12px', color: '#6B7280', lineHeight: '1.5' }}>
            ℹ️ Graphs with Daily Fetch enabled will be processed automatically when using 
            <code style={{ background: '#F3F4F6', padding: '2px 4px', borderRadius: '2px' }}>?retrieveall</code> 
            (without specifying graph names). Graphs without a pinned query (⚠️) will be skipped during automation.
          </p>
        </div>
        
        <div className="modal-footer">
          <button onClick={onClose} className="modal-btn modal-btn-secondary">
            Cancel
          </button>
          <button 
            onClick={handleSave} 
            className="modal-btn modal-btn-primary"
            disabled={saving || pendingChanges.size === 0}
          >
            {saving ? 'Saving...' : `Save Changes${pendingChanges.size > 0 ? ` (${pendingChanges.size})` : ''}`}
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}
```

#### 5.4 Save Handler (in service layer)

**File:** `graph-editor/src/services/dailyFetchService.ts` (new file, or add to `workspaceService.ts`)

The save logic **must live in a service** (not inline in modal/menu). The `onSave` callback calls this service method to update each graph file in IDB and mark it dirty:

```typescript
const handleSaveDailyFetchChanges = async (
  changes: Array<{ graphFileId: string; dailyFetch: boolean }>
) => {
  for (const { graphFileId, dailyFetch } of changes) {
    const file = await db.files.get(graphFileId);
    if (!file || file.type !== 'graph') continue;
    
    const data = file.data as GraphData;
    const updatedData = { ...data, dailyFetch };
    
    await db.files.update(graphFileId, {
      data: updatedData,
      isDirty: true,
      lastModified: Date.now(),
    });
    
    // Also update FileRegistry if the graph is open
    const registryFile = fileRegistry.getFile(graphFileId);
    if (registryFile) {
      fileRegistry.updateFile(graphFileId, { data: updatedData, isDirty: true });
    }
    
    // If the graph is open in a tab, update its store
    const store = getGraphStore(graphFileId);
    if (store) {
      store.getState().setGraph(updatedData);
    }
  }
  
  toast.success(`Updated ${changes.length} graph(s)`);
};
```

### 6. Data Menu: Add "Automated Daily Fetches" Item

**File:** `graph-editor/src/components/MenuBar/DataMenu.tsx`

#### 6.1 Add State and Modal

```typescript
// Near other modal state declarations
const [showDailyFetchManager, setShowDailyFetchManager] = useState(false);
```

#### 6.2 Add Menu Item

Add after existing menu items (e.g., after "Pinned Data Interests" or in Automation section):

```tsx
<Menubar.Item
  className="menubar-item"
  onSelect={() => setShowDailyFetchManager(true)}
>
  <Calendar size={14} style={{ marginRight: 8 }} />
  Automated Daily Fetches...
</Menubar.Item>
```

#### 6.3 Render Modal

At the end of the component, render the modal:

```tsx
<DailyFetchManagerModal
  isOpen={showDailyFetchManager}
  onClose={() => setShowDailyFetchManager(false)}
  onSave={handleSaveDailyFetchChanges}
/>
```

### 7. Update Callers of PinnedQueryModal

#### 5.1 WindowSelector.tsx

**File:** `graph-editor/src/components/WindowSelector.tsx`

Update the `<PinnedQueryModal>` usage (around line 1518):

```tsx
<PinnedQueryModal
  isOpen={showPinnedQueryModal}
  currentDSL={graph?.dataInterestsDSL || ''}
  dailyFetch={graph?.dailyFetch ?? false}  // <-- ADD
  onSave={(newDSL, newDailyFetch) => {  // <-- CHANGE
    if (setGraph && graph) {
      setGraph({ ...graph, dataInterestsDSL: newDSL, dailyFetch: newDailyFetch });  // <-- CHANGE
      toast.success('Pinned query updated');
      // ... existing validation logic ...
    }
  }}
  onClose={() => setShowPinnedQueryModal(false)}
/>
```

#### 5.2 useRetrieveAllSlices.ts

**File:** `graph-editor/src/hooks/useRetrieveAllSlices.ts`

Update `handleSavePinnedQuery` callback and return type:

```typescript
const handleSavePinnedQuery = useCallback(async (newDSL: string, newDailyFetch: boolean) => {
  if (!graph) return;
  
  setGraph({ ...graph, dataInterestsDSL: newDSL, dailyFetch: newDailyFetch });
  // ... rest unchanged ...
}, [graph, setGraph, pendingAllSlices]);
```

Update the `PinnedQueryModalProps` passed to consumers of this hook.

### 6. PowerShell Script Updates

**File:** `graph-editor/scripts/scheduling/setup-daily-retrieve.ps1`

#### 6.1 Add "Daily Fetch Mode" Option in Add-Graph

In the `Add-Graph` function, add a new prompt before asking for graph names:

```powershell
Write-Host ""
Write-Host "=== Add New Schedule ===" -ForegroundColor Cyan
Write-Host ""

Write-Host "Schedule mode:" -ForegroundColor Gray
Write-Host "  [1] Specific graph(s) - you specify which graphs to run"
Write-Host "  [2] Daily-fetch mode  - run all graphs marked 'Fetch daily' in DagNet"
Write-Host ""
$modeChoice = Read-Host "Choice (default: 1)"
if ([string]::IsNullOrWhiteSpace($modeChoice)) { $modeChoice = "1" }

$isDailyFetchMode = ($modeChoice -eq "2")
```

#### 6.2 Modify URL Construction

If daily-fetch mode is selected:

```powershell
if ($isDailyFetchMode) {
    $graphName = "daily-fetch-all"
    $retrieveAllParam = ""  # Empty = enumerate from IDB
    $fullUrl = "$url/?retrieveall"  # Boolean flag only
    
    Write-Host ""
    Write-Host "Daily-fetch mode: will process all graphs with 'Fetch daily' enabled in DagNet." -ForegroundColor Cyan
    Write-Host "Make sure to enable 'Fetch daily' in each graph's Pinned Data Interests modal." -ForegroundColor Yellow
} else {
    # Existing logic for specific graph names
    $graphInput = Read-Host "Graph name(s)"
    # ... existing parsing ...
    $fullUrl = "$url/?retrieveall=$retrieveAllParam"
}
```

#### 6.3 Update Task Name and Display

For daily-fetch mode tasks:

```powershell
$taskName = if ($isDailyFetchMode) {
    "DagNet_DailyFetch_All"
} else {
    "DagNet_DailyRetrieve_$graphName"
}
```

Update `Show-Menu` to handle and display daily-fetch mode tasks distinctively:

```powershell
# In Show-Menu, after extracting graphs from decoded command:
$isDailyFetchMode = $false
if ($decoded -match '\?retrieveall(?:$|&)' -and $decoded -notmatch 'retrieveall=') {
    $isDailyFetchMode = $true
}

if ($isDailyFetchMode) {
    Write-Host "      Mode: Daily-fetch (all graphs with 'Fetch daily' enabled)" -ForegroundColor Magenta
} elseif ($graphCount -gt 1) {
    Write-Host "      Graphs ($graphCount, run in sequence):" -ForegroundColor Cyan
    # ... existing multi-graph display ...
}
```

---

## Test Coverage

### 7. Unit Tests

**File:** `graph-editor/src/hooks/__tests__/useURLDailyRetrieveAllQueue.test.ts`

Add test scenarios:

1. **Empty `?retrieveall` with no dailyFetch graphs in IDB** — should log warning and exit
2. **Empty `?retrieveall` with 2 dailyFetch graphs** — should process both in sequence
3. **Empty `?retrieveall` with mixed graphs (some dailyFetch, some not)** — should only process dailyFetch ones
4. **Explicit `?retrieveall=specific-graph`** — should ignore dailyFetch flags, process only specified graph

### 8. Playwright E2E Test

**File:** `graph-editor/e2e/dailyFetchEnumeration.spec.ts`

This test verifies that:
1. The app loads and the workspace initialises correctly
2. Graphs are present in IDB with correct `dailyFetch` flags
3. The `?retrieveall` enumeration finds the correct graphs

```typescript
import { test, expect } from '@playwright/test';
import { installShareLiveStubs, type ShareLiveStubState } from './support/shareLiveStubs';

test.describe.configure({ timeout: 120_000 });

function buildDailyFetchTestUrl(repo: string) {
  const params = new URLSearchParams();
  params.set('e2e', '1');
  params.set('repo', repo);
  params.set('branch', 'main');
  // Provide credentials via URL creds
  params.set(
    'creds',
    JSON.stringify({
      defaultGitRepo: repo,
      git: [
        {
          name: repo,
          owner: 'owner-1',
          repo: repo,
          token: 'test-token',
          branch: 'main',
          basePath: '',
        },
      ],
    })
  );
  return `/?${params.toString()}`;
}

test('dailyFetch enumeration: finds graphs with dailyFetch=true in IDB', async ({ browser, baseURL }) => {
  const state: ShareLiveStubState = { version: 'v1', counts: {} };
  const context = await browser.newContext();
  const page = await context.newPage();
  await installShareLiveStubs(page, state);

  const url = new URL(buildDailyFetchTestUrl('test-repo'), baseURL).toString();
  await page.goto(url, { waitUntil: 'domcontentloaded' });

  // Wait for app to initialise
  await expect(page.locator('[data-testid="app-shell"]')).toBeVisible({ timeout: 30_000 });

  // Seed test graphs into IDB via page.evaluate
  await page.evaluate(async () => {
    const db: any = (window as any).db;
    if (!db) throw new Error('DB not available');

    // Add two graphs: one with dailyFetch=true, one without
    await db.files.bulkPut([
      {
        fileId: 'graph-alpha',
        type: 'graph',
        source: { repository: 'test-repo', branch: 'main' },
        data: {
          nodes: [{ uuid: '1', id: 'start' }],
          edges: [],
          policies: {},
          metadata: { name: 'Alpha' },
          dailyFetch: true,
          dataInterestsDSL: 'context(channel)',
        },
        isDirty: false,
      },
      {
        fileId: 'graph-beta',
        type: 'graph',
        source: { repository: 'test-repo', branch: 'main' },
        data: {
          nodes: [{ uuid: '2', id: 'start' }],
          edges: [],
          policies: {},
          metadata: { name: 'Beta' },
          dailyFetch: false,  // Not included
        },
        isDirty: false,
      },
      {
        fileId: 'graph-gamma',
        type: 'graph',
        source: { repository: 'test-repo', branch: 'main' },
        data: {
          nodes: [{ uuid: '3', id: 'start' }],
          edges: [],
          policies: {},
          metadata: { name: 'Gamma' },
          dailyFetch: true,
          dataInterestsDSL: 'context(browser)',
        },
        isDirty: false,
      },
    ]);
  });

  // Now enumerate dailyFetch graphs via the helper we'll expose for testing
  const result = await page.evaluate(async () => {
    // Access the enumeration function (we'll expose it on window in dev/e2e mode)
    const enumFn = (window as any).__dagnetEnumerateDailyFetchGraphs;
    if (!enumFn) return { error: 'enumFn not available' };
    return await enumFn({ repository: 'test-repo', branch: 'main' });
  });

  expect(result).toEqual(['alpha', 'gamma']); // Sorted alphabetically, only dailyFetch=true

  await context.close();
});
```

**Note:** The E2E test requires exposing `enumerateDailyFetchGraphsFromIDB` on `window` in dev/e2e mode. Add this to the hook file:

```typescript
// Expose for E2E testing (dev mode only)
if (import.meta.env.DEV && typeof window !== 'undefined') {
  (window as any).__dagnetEnumerateDailyFetchGraphs = enumerateDailyFetchGraphsFromIDB;
}
```

---

## Session Log Output Examples

### Enumeration Mode

```
[INFO] DAILY_RETRIEVE_ALL_ENUMERATE - Enumerating graphs with dailyFetch=true from workspace
[INFO] DAILY_RETRIEVE_ALL_FOUND - Found 3 graph(s) with dailyFetch=true
       Detail: conversion-funnel, marketing-metrics, sales-pipeline
[INFO] DAILY_RETRIEVE_ALL_GRAPH_START - [1/3] Starting: conversion-funnel
  ... (existing pull/retrieve/commit logs) ...
[INFO] DAILY_RETRIEVE_ALL_GRAPH_COMPLETE - [1/3] Completed: conversion-funnel
[INFO] DAILY_RETRIEVE_ALL_GRAPH_START - [2/3] Starting: marketing-metrics
  ...
```

### No Graphs Found

```
[INFO] DAILY_RETRIEVE_ALL_ENUMERATE - Enumerating graphs with dailyFetch=true from workspace
[WARN] DAILY_RETRIEVE_ALL_NO_GRAPHS - No graphs with dailyFetch=true found in workspace
```

---

## Migration / Backward Compatibility

1. **Existing graphs without `dailyFetch`** — treated as `dailyFetch: false` (not included in enumeration)
2. **Existing scheduled tasks with explicit graph names** — continue working unchanged
3. **New tasks created with daily-fetch mode** — require at least one graph to have `dailyFetch: true`

---

## Summary of Files to Modify

| File | Change |
|------|--------|
| `src/types/index.ts` | Add `dailyFetch?: boolean` to `ConversionGraph` |
| `public/schemas/conversion-graph-1.1.0.json` | Add `dailyFetch` property |
| `lib/graph_types.py` | Add `dailyFetch` field to `Graph` Pydantic model |
| `src/hooks/useURLDailyRetrieveAllQueue.ts` | Add IDB enumeration logic, enhanced logging |
| `src/components/modals/PinnedQueryModal.tsx` | Add `dailyFetch` prop, checkbox UI |
| `src/components/modals/DailyFetchManagerModal.tsx` | **New file:** Transfer-list modal for bulk management |
| `src/services/dailyFetchService.ts` | **New file:** Service for bulk dailyFetch changes (or extend `workspaceService`) |
| `src/components/MenuBar/DataMenu.tsx` | Add "Automated Daily Fetches..." menu item |
| `src/components/WindowSelector.tsx` | Pass `dailyFetch` to modal, handle in save |
| `src/hooks/useRetrieveAllSlices.ts` | Update `handleSavePinnedQuery` signature |
| `scripts/scheduling/setup-daily-retrieve.ps1` | Add daily-fetch mode option |
| `src/hooks/__tests__/useURLDailyRetrieveAllQueue.test.ts` | Add enumeration tests |
| `lib/tests/test_schema_python_consistency.py` | Add `dailyFetch` consistency test |
| `src/services/__tests__/schemaTypesConsistency.test.ts` | Add `dailyFetch` consistency test |
| `e2e/dailyFetchEnumeration.spec.ts` | New E2E test for enumeration |
| `public/docs/dev/URL_PARAMS.md` | Document `?retrieveall` (no value) behaviour |
| `public/docs/automation-and-scheduling.md` | Document daily-fetch mode and UI checkbox |

---

## 9. Public Documentation Updates

### 9.1 Developer Docs: `public/docs/dev/URL_PARAMS.md`

Update the `?retrieveall` section (around line 84) to document the new enumeration mode:

**Current text:**
```markdown
### `?retrieveall=<graph_name>` / `?graph=<graph_name>&retrieveall`

Runs a **headless daily automation** workflow for a specific graph:
```

**Updated text:**
```markdown
### `?retrieveall=<graph_name>` / `?retrieveall` (daily-fetch mode)

Runs a **headless daily automation** workflow:

- Pull latest from git (**remote wins** for any merge conflicts)
- Retrieve All Slices (headless; no Retrieve All modal)
- Commit all committable changes back to the repo

This is intended for simple local schedulers (e.g. Windows Task Scheduler) on a machine left running.

For a user-facing overview, see: `public/docs/automation-and-scheduling.md`.

**Graph selection modes:**

| URL | Behaviour |
|-----|-----------|
| `?retrieveall=graph-a` | Process single named graph |
| `?retrieveall=graph-a,graph-b` | Process multiple named graphs (comma-separated) |
| `?retrieveall=a&retrieveall=b` | Process multiple named graphs (repeated param) |
| `?graph=name&retrieveall` | Process single graph (boolean flag with graph param) |
| `?retrieveall` | **Daily-fetch mode**: enumerate all graphs in workspace with `dailyFetch: true` |

**Daily-fetch mode details:**

When `?retrieveall` is used without a graph name, DagNet:
1. Waits for workspace to initialise (repo selected, credentials loaded)
2. Queries IndexedDB for all graphs where `dailyFetch === true`
3. Processes matching graphs in alphabetical order (serialised, one at a time)
4. Logs sequence progress: `[1/3] Starting: graph-a`, etc.

If no graphs have `dailyFetch: true`, the automation logs a warning and exits.

**To enable daily-fetch for a graph:**
1. Open the graph
2. Click the gear icon in the Context selector → "Pinned Data Interests"
3. Check the "Fetch daily" checkbox
4. Save

**Examples:**
```
# Single graph (explicit)
https://dagnet.vercel.app/?retrieveall=conversion-funnel

# Multiple graphs (explicit, serialised)
https://dagnet.vercel.app/?retrieveall=graph-a,graph-b,graph-c

# Daily-fetch mode (enumerate from workspace)
https://dagnet.vercel.app/?retrieveall
```
```

### 9.2 User Docs: `public/docs/automation-and-scheduling.md`

Update to document daily-fetch mode and the UI checkbox.

**Add new section after "How to trigger automation" (around line 40):**

```markdown
---

## Daily-fetch mode (recommended for multiple graphs)

Instead of listing graphs explicitly in the URL, you can mark graphs for daily automation and let DagNet enumerate them automatically.

### Enabling daily-fetch for a graph

**Option A: Individual graph (via Pinned Data Interests)**

1. Open the graph you want to include in automation
2. Click the **gear icon** (⚙️) in the Context selector bar
3. Select **"Pinned Data Interests"**
4. Check the **"Fetch daily"** checkbox
5. Click **Save**

**Option B: Bulk management (via Data menu)**

1. Go to **Data** menu → **Automated Daily Fetches...**
2. In the modal, select graphs from the left panel ("Available Graphs")
3. Click **[>]** to move them to the right panel ("Daily Fetch Enabled")
4. Click **Save Changes**

This is useful for enabling/disabling multiple graphs at once without opening each one individually.

### Triggering daily-fetch mode

Use `?retrieveall` **without** a graph name:

```
https://dagnet.vercel.app/?retrieveall
```

DagNet will:
1. Wait for the workspace to initialise
2. Find all graphs with "Fetch daily" enabled
3. Process them one at a time in alphabetical order
4. Log progress with sequence indicators: `[1/3] Starting: graph-a`

### Benefits

- **Centralised control**: enable/disable graphs from the UI without editing scheduled task URLs
- **Self-documenting**: the graph itself records whether it's part of automation
- **Simpler scheduling**: one scheduled task covers all daily-fetch graphs

### Notes

- Graphs must be cloned/loaded into the workspace before automation runs
- If no graphs have "Fetch daily" enabled, the automation logs a warning and exits
- You can still use explicit `?retrieveall=graph-a,graph-b` if you prefer URL-based control
```

**Update the "Scheduling (Windows Task Scheduler)" section to mention daily-fetch mode:**

Add after "High-level workflow:" bullet list:

```markdown
**Daily-fetch mode option:**

When adding a new schedule, the setup script offers two modes:
1. **Specific graphs** — you specify which graphs to run (existing behaviour)
2. **Daily-fetch mode** — runs all graphs marked "Fetch daily" in DagNet

Daily-fetch mode uses `?retrieveall` (no graph names), so you can add/remove graphs from automation by toggling the "Fetch daily" checkbox in DagNet rather than editing the scheduled task.
```

---

## Approval Checklist

- [ ] TypeScript type changes approved (`src/types/index.ts`)
- [ ] JSON schema changes approved (`public/schemas/conversion-graph-1.1.0.json`)
- [ ] Python Pydantic model changes approved (`lib/graph_types.py`)
- [ ] Hook enumeration logic approved (`useURLDailyRetrieveAllQueue.ts`)
- [ ] UI checkbox in Pinned Query modal approved (`PinnedQueryModal.tsx`)
- [ ] Daily Fetch Manager modal design approved (`DailyFetchManagerModal.tsx`)
- [ ] Daily Fetch service layer approved (`dailyFetchService.ts` or `workspaceService`)
- [ ] Data Menu integration approved (`DataMenu.tsx`)
- [ ] PowerShell script changes approved (`setup-daily-retrieve.ps1`)
- [ ] Test coverage scope approved (unit + E2E + schema consistency)
- [ ] Public docs updates approved (`URL_PARAMS.md`, `automation-and-scheduling.md`)
