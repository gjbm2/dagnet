# Menu System Refactor: Single Source of Truth

## Problem

Currently, three menus compute data operations independently:
1. **NodeContextMenu**: Right-click on node → submenus for node file, case data
2. **EdgeContextMenu**: Right-click on edge → submenus for parameters (p, conditional_p, cost_gbp, cost_time)
3. **DataMenu**: Top menu bar → generic "Get from File", "Put to File", etc.

**Issues**:
- Logic duplicated 3x
- Easy for menus to drift out of sync (as we just experienced)
- Top menu is broken: tries to be "smart" and detect generically, but fails with multiple files per selection
- Nightmare to maintain

## Solution

**Single Source of Truth**: `DataOperationsSections.tsx`

This module computes ALL available data operations for a selection and returns structured data. All three menus consume this data.

---

## Architecture

### Core Module: `DataOperationsSections.tsx`

```typescript
export interface DataOperationSection {
  id: string;                    // 'node-file', 'case-data', 'param-p', etc.
  label: string;                 // 'Node file', 'Case Data', 'Probability parameter'
  objectType: 'parameter' | 'case' | 'node' | 'event';
  objectId: string;              // File ID
  targetId: string;              // edgeId or nodeId
  paramSlot?: 'p' | 'cost_gbp' | 'cost_time';
  conditionalIndex?: number;
  
  // Flags (computed once, used everywhere)
  hasFile: boolean;
  hasConnection: boolean;
  hasFileConnection: boolean;
  canPutToFile: boolean;
  
  // Available operations (derived from flags)
  operations: {
    getFromFile: boolean;
    getFromSource: boolean;
    getFromSourceDirect: boolean;
    putToFile: boolean;
  };
}

// Main API
export function getAllDataSections(
  selectedNodeId: string | null,
  selectedEdgeId: string | null,
  graph: any
): DataOperationSection[];
```

**Logic**:
- For node: returns `[{node-file}, {case-data}]` (if applicable)
- For edge: returns `[{param-p}, {param-conditional}, {cost-gbp}, {cost-time}]` (if applicable)
- Each section has ALL necessary metadata for rendering

---

## Refactored Components

### 1. NodeContextMenu (Context Menu)

**Before**:
```tsx
// Inline logic to detect node file, case file
const hasNodeFile = ...;
const hasCaseFile = ...;
const canPutNodeToFile = ...;

// Render submenus
{canPutNodeToFile && (
  <div>Node file
    <DataOperationsMenu ... />
  </div>
)}
{isCaseNode && (
  <div>Case Data
    <DataOperationsMenu ... />
  </div>
)}
```

**After**:
```tsx
import { getAllDataSections } from './DataOperationsSections';

const sections = getAllDataSections(selectedNodeId, null, graph);

{sections.map(section => (
  <div key={section.id}>
    {section.label}
    <DataOperationsMenu
      objectType={section.objectType}
      objectId={section.objectId}
      hasFile={section.hasFile}
      targetId={section.targetId}
      paramSlot={section.paramSlot}
      conditionalIndex={section.conditionalIndex}
      {...}
    />
  </div>
))}
```

**Result**: Zero inline logic, just render sections

---

### 2. EdgeContextMenu (Context Menu)

**Before**:
```tsx
// Inline logic for each parameter type
const hasProbabilityParam = ...;
const hasConditionalParam = ...;
const hasCostGbpParam = ...;
const hasCostTimeParam = ...;

// Render submenus for each
{hasProbabilityParam && (
  <div>Probability parameter
    <DataOperationsMenu ... />
  </div>
)}
{hasConditionalParam && (
  <div>Conditional prob. parameter
    <DataOperationsMenu ... />
  </div>
)}
// ... etc
```

**After**:
```tsx
import { getAllDataSections } from './DataOperationsSections';

const sections = getAllDataSections(null, selectedEdgeId, graph);

{sections.map(section => (
  <div key={section.id}>
    {section.label}
    <DataOperationsMenu
      objectType={section.objectType}
      objectId={section.objectId}
      hasFile={section.hasFile}
      targetId={section.targetId}
      paramSlot={section.paramSlot}
      conditionalIndex={section.conditionalIndex}
      {...}
    />
  </div>
))}
```

**Result**: Zero inline logic, just render sections

---

### 3. DataMenu (Top Menu Bar)

**Before**:
```tsx
// Generic operations that try to detect "the" file
<Menubar.Item onSelect={handleGetFromFile}>
  Get data from file...
</Menubar.Item>
<Menubar.Item onSelect={handlePutToFile}>
  Put data to file...
</Menubar.Item>

// Handlers try to figure out WHICH file to operate on
const handleGetFromFile = () => {
  if (selectedEdgeId) {
    // Which parameter? p? cost_gbp? conditional?
    const paramId = edge.p?.id || edge.cost_gbp?.id || ...; // WRONG
  } else if (selectedNodeId) {
    // Node file or case file?
    const caseId = node.case?.id;
    const nodeFileId = node.id; // WRONG - ambiguous
  }
};
```

**After**:
```tsx
import { getAllDataSections } from './DataOperationsSections';

const sections = getAllDataSections(selectedNodeId, selectedEdgeId, graph);

{sections.map(section => (
  <React.Fragment key={section.id}>
    {/* Submenu for this section */}
    <Menubar.Sub>
      <Menubar.SubTrigger>{section.label}</Menubar.SubTrigger>
      <Menubar.SubContent>
        {/* Get from File */}
        {section.operations.getFromFile && (
          <Menubar.Item onSelect={() => handleGetFromFile(section)}>
            Get from File
          </Menubar.Item>
        )}
        {/* Get from Source (direct) */}
        {section.operations.getFromSourceDirect && (
          <Menubar.Item onSelect={() => handleGetFromSourceDirect(section)}>
            Get from Source (direct)
          </Menubar.Item>
        )}
        {/* Get from Source (versioned) */}
        {section.operations.getFromSource && (
          <Menubar.Item onSelect={() => handleGetFromSource(section)}>
            Get from Source
          </Menubar.Item>
        )}
        {/* Put to File */}
        {section.operations.putToFile && (
          <Menubar.Item onSelect={() => handlePutToFile(section)}>
            Put to File
          </Menubar.Item>
        )}
      </Menubar.SubContent>
    </Menubar.Sub>
  </React.Fragment>
))}

// Handlers are simple: they get ALL the info from the section
const handleGetFromFile = (section: DataOperationSection) => {
  dataOperationsService.getFromFile({
    objectType: section.objectType,
    objectId: section.objectId,
    targetId: section.targetId,
    paramSlot: section.paramSlot,
    conditionalIndex: section.conditionalIndex,
    graph,
    setGraph,
  });
};
```

**Result**: 
- ✅ Multiple sections shown (one per file type)
- ✅ No ambiguity (each section knows exactly which file)
- ✅ Mirrors context menu structure EXACTLY

---

## Menu Structure Comparison

### Node Selection

**Context Menu** (right-click node):
```
Node Context Menu
├── ... node operations ...
├── ─────────────────
├── Node file                    ← submenu (hover)
│   ├── Get from File
│   └── Put to File
└── Case Data                    ← submenu (hover)
    ├── Get from Source (direct)
    ├── Get from Source
    ├── Get from File
    └── Put to File
```

**Top Data Menu** (after refactor):
```
Data
├── Batch Operations...
├── ─────────────────
├── Node file                    ← submenu (click)
│   ├── Get from File
│   └── Put to File
└── Case Data                    ← submenu (click)
    ├── Get from Source (direct)
    ├── Get from Source
    ├── Get from File
    └── Put to File
```

**IDENTICAL STRUCTURE** ✅

---

### Edge Selection

**Context Menu** (right-click edge):
```
Edge Context Menu
├── ... edge operations ...
├── ─────────────────
├── Probability parameter        ← submenu (hover)
│   ├── Get from Source (direct)
│   ├── Get from Source
│   ├── Get from File
│   └── Put to File
├── Conditional prob. parameter  ← submenu (hover)
│   ├── Get from Source (direct)
│   ├── Get from Source
│   ├── Get from File
│   └── Put to File
├── Cost (GBP)                   ← submenu (hover)
│   ├── ...
└── Cost (time)                  ← submenu (hover)
    └── ...
```

**Top Data Menu** (after refactor):
```
Data
├── Batch Operations...
├── ─────────────────
├── Probability parameter        ← submenu (click)
│   ├── Get from Source (direct)
│   ├── Get from Source
│   ├── Get from File
│   └── Put to File
├── Conditional prob. parameter  ← submenu (click)
│   ├── ...
├── Cost (GBP)                   ← submenu (click)
│   ├── ...
└── Cost (time)                  ← submenu (click)
    └── ...
```

**IDENTICAL STRUCTURE** ✅

---

## Implementation Steps

### Phase 1: ✅ Core Module (DONE)
- [x] Create `DataOperationsSections.tsx`
- [x] Implement `getNodeDataSections()`
- [x] Implement `getEdgeDataSections()`
- [x] Implement `getAllDataSections()`

### Phase 2: Refactor NodeContextMenu
- [ ] Import `getAllDataSections`
- [ ] Remove inline logic for `hasNodeFile`, `hasCaseFile`, etc.
- [ ] Replace hardcoded submenus with `sections.map()`
- [ ] Test: Right-click node → verify menu structure unchanged

### Phase 3: Refactor EdgeContextMenu
- [ ] Import `getAllDataSections`
- [ ] Remove inline logic for `hasProbabilityParam`, `hasConditionalParam`, etc.
- [ ] Replace hardcoded submenus with `sections.map()`
- [ ] Test: Right-click edge → verify menu structure unchanged

### Phase 4: Refactor DataMenu
- [ ] Import `getAllDataSections`
- [ ] Remove generic "Get from File" / "Put to File" items
- [ ] Add submenus for each section (using `Menubar.Sub`)
- [ ] Update handlers to accept `DataOperationSection` parameter
- [ ] Test: Select node/edge → verify Data menu shows correct submenus

### Phase 5: Cleanup
- [ ] Remove duplicate logic from all three menus
- [ ] Verify all tests pass
- [ ] Update documentation

---

## Benefits

1. **Single Source of Truth**: Logic computed once, used everywhere
2. **Consistency**: All three menus ALWAYS show identical options
3. **Top Menu Fixed**: Now shows multiple sections (one per file type)
4. **Maintainability**: Change logic in ONE place, all menus update
5. **No Ambiguity**: Each section knows exactly which file to operate on
6. **Future-Proof**: Easy to add new file types (just update `DataOperationsSections`)

---

## Testing Strategy

### Test 1: Node with both node file and case file
- Select node with `node.id = "abc"` and `node.case.id = "coffee"`
- **Context menu**: Should show 2 submenus (Node file, Case Data)
- **Top Data menu**: Should show 2 submenus (Node file, Case Data)
- Verify operations in both menus are identical

### Test 2: Edge with multiple parameters
- Select edge with `edge.p.id`, `edge.conditional_p[0].p.id`, and `edge.cost_gbp.id`
- **Context menu**: Should show 3 submenus (Probability, Conditional, Cost GBP)
- **Top Data menu**: Should show 3 submenus (Probability, Conditional, Cost GBP)
- Verify operations in both menus are identical

### Test 3: File operations work correctly
- For each section:
  - "Get from File" → fetches correct file
  - "Put to File" → saves to correct file
  - "Get from Source" → uses correct connection

---

## Migration Notes

**Breaking Changes**: None (external API unchanged)

**Code Cleanup**:
- Can remove ~200 lines of duplicate logic across three menus
- Can remove stale comments about "why this logic is needed"

**Future Work**:
- Consider extracting submenu rendering into its own component
- Add keyboard shortcuts (Ctrl+G for Get from File, etc.)
- Add icons to menu items

---

**Status**: Phase 1 complete (core module created)
**Next**: Phase 2 (refactor NodeContextMenu)

