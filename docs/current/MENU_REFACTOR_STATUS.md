# Menu Refactor Status

## ✅ Phase 1: Core Foundation (COMPLETE)

### Created Files:
1. **`DataOperationsSections.tsx`** - Single source of truth for computing available data operations
   - `getAllDataSections(nodeId, edgeId, graph)` - Main API
   - `getNodeDataSections()` - Returns sections for node (node file, case data)
   - `getEdgeDataSections()` - Returns sections for edge (p, conditional_p[], cost_gbp, cost_time)
   - **✅ Fixed**: Iterates over ALL conditional_p entries (not just first one)

2. **`DataSectionSubmenu.tsx`** - Reusable submenu component
   - Renders a single data operation section
   - Shows Get/Put/Source operations based on `section.operations` flags
   - Used by NodeContextMenu and EdgeContextMenu (avoids 200+ lines of duplicate code)

3. **`MENU_REFACTOR_PLAN.md`** - Detailed implementation plan

---

## 🔄 Phase 2: NodeContextMenu Refactor (IN PROGRESS)

### Status:
- ✅ Import `getAllDataSections` and `DataSectionSubmenu`
- ✅ Replace inline logic with `getAllDataSections(nodeId, null, graph)`
- ✅ Added section-based handlers
- ⏳ **TODO**: Replace hardcoded menu rendering with `dataOperationSections.map()` and `<DataSectionSubmenu>`

### Code to Replace:

**Current** (lines 403-665): Hardcoded submenus for "Node file" and "Case Data"
```tsx
{hasAnyFile && (
  <>
    {canPutNodeToFile && (
      <div>Node file submenu...</div>  // ~95 lines of hardcoded JSX
    )}
    {isCaseNode && ... && (
      <div>Case Data submenu...</div>  // ~165 lines of hardcoded JSX
    )}
  </>
)}
```

**Target**: Render using dataOperationSections
```tsx
{dataOperationSections.length > 0 && (
  <>
    <div style={{ height: '1px', background: '#eee', margin: '8px 0' }} />
    
    {dataOperationSections.map(section => (
      <DataSectionSubmenu
        key={section.id}
        section={section}
        isOpen={openSubmenu === section.id}
        onMouseEnter={() => handleSubmenuEnter(section.id)}
        onMouseLeave={handleSubmenuLeave}
        onSubmenuContentEnter={handleSubmenuContentEnter}
        onSubmenuContentLeave={handleSubmenuContentLeave}
        onGetFromFile={handleSectionGetFromFile}
        onPutToFile={handleSectionPutToFile}
        onGetFromSource={handleSectionGetFromSource}
        onGetFromSourceDirect={handleSectionGetFromSourceDirect}
      />
    ))}
  </>
)}
```

**Result**: ~260 lines → ~20 lines

---

## ⏳ Phase 3: EdgeContextMenu Refactor (TODO)

### Same pattern as NodeContextMenu:
1. Import `getAllDataSections` and `DataSectionSubmenu`
2. Replace inline logic with `getAllDataSections(null, edgeId, graph)`
3. Replace hardcoded submenus (Probability, Conditional[], Cost GBP, Cost Time) with `sections.map()`

**Estimated reduction**: ~300 lines → ~20 lines

---

## ⏳ Phase 4: DataMenu Refactor (TODO)

### Current Problem:
Top Data menu has generic items that try to detect "the" file:
```tsx
<Menubar.Item onSelect={handleGetFromFile}>
  Get data from file...
</Menubar.Item>
```

Handlers are ambiguous:
```tsx
const handleGetFromFile = () => {
  if (selectedEdgeId) {
    const paramId = edge.p?.id || edge.cost_gbp?.id || ...; // WRONG - which param?
  } else if (selectedNodeId) {
    const caseId = node.case?.id; // WRONG - node file or case file?
  }
};
```

### Target:
Use submenus (one per file type), matching context menu structure:
```tsx
import { getAllDataSections } from './DataOperationsSections';

const sections = getAllDataSections(selectedNodeId, selectedEdgeId, graph);

{sections.map(section => (
  <Menubar.Sub key={section.id}>
    <Menubar.SubTrigger>{section.label}</Menubar.SubTrigger>
    <Menubar.SubContent>
      {section.operations.getFromFile && (
        <Menubar.Item onSelect={() => handleGetFromFile(section)}>
          Get from File
        </Menubar.Item>
      )}
      {section.operations.getFromSourceDirect && (
        <Menubar.Item onSelect={() => handleGetFromSourceDirect(section)}>
          Get from Source (direct)
        </Menubar.Item>
      )}
      {section.operations.getFromSource && (
        <Menubar.Item onSelect={() => handleGetFromSource(section)}>
          Get from Source
        </Menubar.Item>
      )}
      {section.operations.putToFile && (
        <Menubar.Item onSelect={() => handlePutToFile(section)}>
          Put to File
        </Menubar.Item>
      )}
    </Menubar.SubContent>
  </Menubar.Sub>
))}
```

**Handlers are simple** - they get ALL info from the section:
```tsx
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

---

## Benefits (After Full Refactor)

1. **✅ Single Source of Truth**: Logic computed once in `DataOperationsSections.tsx`
2. **✅ Consistency**: All three menus ALWAYS show identical options
3. **✅ Top Menu Fixed**: Shows multiple submenus (one per file type) - no more ambiguity
4. **✅ Maintainability**: Change logic in ONE place, all menus update
5. **✅ Multiple conditional_p**: Handles edges with multiple conditional probabilities correctly
6. **✅ Code Reduction**: ~500 lines of duplicate logic → ~60 lines total

---

## Immediate Next Steps

1. **Complete NodeContextMenu refactor** (10 mins)
   - Replace lines 403-665 with `dataOperationSections.map()` rendering

2. **Refactor EdgeContextMenu** (15 mins)
   - Follow same pattern as NodeContextMenu

3. **Refactor DataMenu** (20 mins)
   - Replace generic items with submenus
   - Update handlers to use section data

4. **Testing** (30 mins)
   - Node with node file + case file → verify both submenus show
   - Edge with multiple conditional_p → verify each has its own submenu
   - Top Data menu → verify matches context menu structure

**Total Time**: ~75 minutes to complete full refactor

---

## Files Changed

### ✅ Created:
- `DataOperationsSections.tsx`
- `DataSectionSubmenu.tsx`
- `MENU_REFACTOR_PLAN.md`
- `MENU_REFACTOR_STATUS.md`

### 🔄 In Progress:
- `NodeContextMenu.tsx` (imports added, handlers added, menu rendering TODO)

### ⏳ TODO:
- `EdgeContextMenu.tsx`
- `DataMenu.tsx` (MenuBar/DataMenu.tsx)

---

## Testing Checklist

After completing refactor:

### Test 1: Node with both files
- [x] Create node with `node.id = "abc"` and `node.case.id = "coffee"`
- [ ] Right-click → verify 2 submenus (Node file, Case Data)
- [ ] Top Data menu → verify 2 submenus (Node file, Case Data)
- [ ] Operations work correctly in both menus

### Test 2: Edge with multiple conditional_p
- [ ] Create edge with 3 conditional probabilities
- [ ] Right-click → verify 5 submenus (Probability, Conditional #1, Conditional #2, Conditional #3, Cost GBP)
- [ ] Top Data menu → verify same 5 submenus
- [ ] Each conditional can fetch its own file independently

### Test 3: Ambiguous cases (now resolved)
- [ ] Node with both node file and case file
  - [ ] "Get from File" → opens modal to choose which file (NOT IMPLEMENTED - shows separate submenus instead)
  - [ ] Actually: Shows "Node file" submenu and "Case Data" submenu separately
- [ ] Edge with all 4 parameters
  - [ ] Top Data menu shows 4 separate submenus
  - [ ] No ambiguity about which file to operate on

---

**Status**: Phase 1 complete, Phase 2 in progress
**Next**: Complete NodeContextMenu refactor (replace lines 403-665)

