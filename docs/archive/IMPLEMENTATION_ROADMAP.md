# Registry & Selector Implementation Roadmap

## Overview
Implement nodes registry following the exact pattern of parameters/contexts/cases, plus generic selector UI component with validation modes.

---

## Phase 1: Nodes Registry Foundation (1-2 hours)

### 1.1: Add Node Type to File Registry
- [ ] Update `graph-editor/src/config/fileTypeRegistry.ts`
  - Add `node` entry following parameter/context/case pattern
  - Schema: `/param-schemas/node-schema.yaml`
  - Directory: `nodes`
  - Index: `nodes-index.yaml`
  - Extensions: `.yaml`, `.yml`

### 1.2: Create Schemas
- [ ] Create `graph-editor/public/param-schemas/node-schema.yaml`
  - Minimal: id, name, description, tags, metadata
  - Optional: resources[] with url links
- [ ] Create `graph-editor/public/param-schemas/nodes-index-schema.yaml`
  - Registry index structure

### 1.3: Create Test Data
- [ ] Create `param-registry/test/nodes-index.yaml`
  - 2-3 example node entries
- [ ] Create `param-registry/test/nodes/homepage.yaml`
  - Example node detail file

### 1.4: Extend ParamRegistryService
- [ ] Add `loadNodesIndex(): Promise<NodesIndex>`
- [ ] Add `loadNode(nodeId: string): Promise<Node | null>`
- [ ] Update types in `graph-editor/src/services/paramRegistryService.ts`

---

## Phase 2: Navigator Integration (1 hour)

### 2.1: Add Registry Indexes to Navigator State
- [ ] Update `graph-editor/src/types/index.ts`
  ```typescript
  interface NavigatorState {
    // ... existing
    registryIndexes?: {
      parameters?: ParametersIndex;
      contexts?: ContextsIndex;
      cases?: CasesIndex;
      nodes?: NodesIndex;  // NEW
    }
  }
  ```

### 2.2: Load Registry Indexes on Init
- [ ] Update `NavigatorContext.tsx`
  - Load all index files on initialization
  - Store in `registryIndexes` state
  - Add helper: `getRegistryEntries(type: ObjectType)`

### 2.3: Add Nodes to Navigator
- [ ] Update `NavigatorContext.loadItems()`
  - Load nodes from `nodes/` directory
  - Add to items list
  - Follow parameter/context/case pattern exactly

### 2.4: Context Menu for Nodes
- [ ] Update `NavigatorItemContextMenu.tsx`
  - Add node case to all handlers
  - "New Node...", "Duplicate...", etc.

---

## Phase 3: Validation Context (30 min)

### 3.1: Create ValidationContext
- [ ] Create `graph-editor/src/contexts/ValidationContext.tsx`
  - `mode: 'warning' | 'strict' | 'none'`
  - Persists to localStorage
  - Default: 'warning'

### 3.2: Add ValidationProvider to App
- [ ] Update `graph-editor/src/App.tsx` or `AppShell.tsx`
  - Wrap with `<ValidationProvider>`

### 3.3: Add to Edit Menu
- [ ] Update `graph-editor/src/components/MenuBar/EditMenu.tsx`
  - Add "Validation Mode" submenu
  - Radio group for 3 modes
  - Uses `useValidationMode()` hook

---

## Phase 4: Enhanced NewFileModal (2 hours)

### 4.1: Extend NewFileModal Props
- [ ] Update `graph-editor/src/components/NewFileModal.tsx`
  ```typescript
  interface NewFileModalProps {
    // ... existing
    mode?: 'create' | 'select-from-registry' | 'both';
    showRegistryOption?: boolean;
    registryEntries?: RegistryEntry[];
  }
  ```

### 4.2: Add Registry Selection UI
- [ ] Add creation mode toggle (scratch vs. registry)
- [ ] Add registry search/filter
- [ ] Add dropdown with registry entries
- [ ] Show usage counts and status indicators
- [ ] Style two-mode layout

### 4.3: Update All Callers
- [ ] `FileMenu.tsx` - pass registry entries when opening modal
- [ ] `NavigatorItemContextMenu.tsx` - same
- [ ] `NavigatorSectionContextMenu.tsx` - same

---

## Phase 5: ParameterSelector Component (3-4 hours)

### 5.1: Create Component Skeleton
- [ ] Create `graph-editor/src/components/ParameterSelector.tsx`
  ```typescript
  interface ParameterSelectorProps {
    type: 'parameter' | 'context' | 'case' | 'node';
    value: string;
    onChange: (value: string) => void;
    validationMode?: 'strict' | 'warning' | 'none';
    showSuggestions?: boolean;
    showValidationBadge?: boolean;
    placeholder?: string;
    disabled?: boolean;
  }
  ```

### 5.2: Implement Combobox UI
- [ ] Text input with dropdown trigger
- [ ] Dropdown with filtered registry items
- [ ] Search/filter logic
- [ ] Visual indicators (✓, ⚠, 📄, ⭘)
- [ ] Keyboard navigation (arrows, enter, escape)

### 5.3: Add Validation Logic
- [ ] Check if value in registry
- [ ] Display appropriate badge based on mode
- [ ] "strict" mode: prevent invalid values
- [ ] "warning" mode: show badge, allow any
- [ ] "none" mode: no validation

### 5.4: Styling & Accessibility
- [ ] Proper ARIA attributes
- [ ] Keyboard navigation
- [ ] Screen reader support
- [ ] Focus management

---

## Phase 6: PropertiesPanel Integration (1-2 hours)

### 6.1: Replace Text Inputs
- [ ] Edge probability parameter_id → ParameterSelector
- [ ] Conditional probability parameter_id → ParameterSelector
- [ ] Case node case.id → ParameterSelector
- [ ] (Optional) Node ID → ParameterSelector with mode='none'

### 6.2: Test Integration
- [ ] Test all validation modes
- [ ] Test creating new items from selector
- [ ] Test selecting existing items
- [ ] Test custom values

---

## Phase 7: Testing & Polish (1 hour)

### 7.1: Manual Testing
- [ ] Test nodes CRUD (create, read, update, delete)
- [ ] Test registry loading
- [ ] Test selector in all contexts
- [ ] Test all validation modes
- [ ] Test enhanced modal (both modes)

### 7.2: Edge Cases
- [ ] Empty registry
- [ ] Registry without files
- [ ] Custom values not in registry
- [ ] Switching validation modes mid-edit

### 7.3: Polish
- [ ] Fix any visual issues
- [ ] Improve error messages
- [ ] Add helpful tooltips
- [ ] Ensure consistent styling

---

## Estimated Time
- **Phase 1**: 1-2 hours (foundation)
- **Phase 2**: 1 hour (navigator)
- **Phase 3**: 30 min (validation context)
- **Phase 4**: 2 hours (enhanced modal)
- **Phase 5**: 3-4 hours (selector component)
- **Phase 6**: 1-2 hours (integration)
- **Phase 7**: 1 hour (testing)

**Total**: 9-12 hours of focused work

---

## Success Criteria

✅ Nodes appear in navigator just like parameters/contexts/cases  
✅ Can create/edit/delete node files via UI  
✅ Registry indexes load on app start  
✅ Enhanced modal shows "create new" vs "from registry" options  
✅ ParameterSelector works for all types (parameter/context/case/node)  
✅ Validation mode selector in Edit menu  
✅ All three validation modes work correctly  
✅ Backward compatible (existing graphs work unchanged)  

---

## Notes

- **Keep nodes minimal** - just ID, name, description, tags, resources
- **Follow existing patterns** - exact same as parameters/contexts/cases
- **No graph logic in nodes** - separation of concerns
- **Validation is guidance, not gatekeeper** - default to 'warning' mode
- **Registry can contain planned items** - don't require files for all entries

---

## Ready to Start?

**Recommended order**:
1. Phase 1 (foundation) - Get nodes working in registry
2. Phase 2 (navigator) - Get nodes showing in UI
3. Phase 3 (validation) - Add validation context
4. Phase 5 (selector) - Build the core component (skip modal enhancement for now)
5. Phase 6 (integration) - Wire it up to PropertiesPanel
6. Phase 4 (modal) - Enhanced modal as polish
7. Phase 7 (testing) - Verify everything works

Let's start with Phase 1!

