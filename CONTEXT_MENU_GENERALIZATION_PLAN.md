# Generalization Plan: Context Menus & Parameter Handling (UPDATED)

## Key Insight: Use LightningMenu Operations Directly

**LightningMenu already has ALL the operations we need:**
- Get from File
- Get from Source (versioned) - if `hasFileConnection`
- Get from Source (direct) - if `hasConnection`
- Put to File
- Connection Settings
- Sync Status

**Solution**: Extract LightningMenu's menu rendering into a shared component that can be used in:
1. LightningMenu (dropdown from ⚡ button)
2. Context menu submenus (hover submenu)

## Updated Solution

### 1. Create `DataOperationsMenu` Component (Shared Menu Rendering)

**Purpose**: Single component that renders the data operations menu
- Used by LightningMenu (as dropdown)
- Used by EdgeContextMenu/NodeContextMenu (as submenu)
- **PRECISELY the same operations, same conditions, same visual language**

**Interface**:
```typescript
interface DataOperationsMenuProps {
  // Object identification
  objectType: 'parameter' | 'case' | 'node' | 'event';
  objectId: string;
  hasFile: boolean;
  targetId?: string; // edgeId or nodeId
  paramSlot?: 'p' | 'cost_gbp' | 'cost_time';
  conditionalIndex?: number;
  
  // Context
  graph: any;
  setGraph: (graph: any) => void;
  window?: { start: string; end: string } | null;
  
  // Display mode
  mode: 'dropdown' | 'submenu'; // Determines styling/positioning
  
  // Callbacks (optional - can compute internally)
  onGetFromFile?: () => void;
  onPutToFile?: () => void;
  onGetFromSource?: () => void;
  onGetFromSourceDirect?: () => void;
  onConnectionSettings?: () => void;
  onSyncStatus?: () => void;
  
  // Close handler (for submenu mode)
  onClose?: () => void;
}
```

**Implementation**: ~150 lines
- Extracts menu rendering from LightningMenu
- Computes connection flags (same logic as LightningMenu)
- Renders menu items with pathway icons
- Handles all operations via `dataOperationsService`
- **NO special cases** - works for all object types

### 2. Refactor LightningMenu to Use DataOperationsMenu

**Before**: LightningMenu has menu rendering inline (~120 lines)

**After**: LightningMenu becomes thin wrapper (~50 lines)
```typescript
export const LightningMenu: React.FC<LightningMenuProps> = (props) => {
  const [isOpen, setIsOpen] = useState(false);
  // ... positioning logic ...
  
  return (
    <>
      <button onClick={() => setIsOpen(!isOpen)}>
        <Zap ... />
      </button>
      {isOpen && (
        <DataOperationsMenu
          {...props}
          mode="dropdown"
          onClose={() => setIsOpen(false)}
        />
      )}
    </>
  );
};
```

### 3. Refactor EdgeContextMenu to Use DataOperationsMenu

**Before**: 4 nearly identical submenus (~520 lines)

**After**: Single submenu component (~20 lines per parameter)
```typescript
{hasProbabilityParam && (
  <div onMouseEnter={() => setOpenSubmenu('probability')}>
    <span>Probability parameter</span>
    {openSubmenu === 'probability' && (
      <DataOperationsMenu
        objectType="parameter"
        objectId={parameterId}
        hasFile={!!parameterId}
        targetId={edgeId}
        graph={graph}
        setGraph={setGraph}
        paramSlot="p"
        mode="submenu"
        onClose={() => setOpenSubmenu(null)}
      />
    )}
  </div>
)}

{hasConditionalParam && (
  <div onMouseEnter={() => setOpenSubmenu('conditional')}>
    <span>Conditional prob. parameter</span>
    {openSubmenu === 'conditional' && (
      <DataOperationsMenu
        objectType="parameter"
        objectId={parameterId}
        hasFile={!!parameterId}
        targetId={edgeId}
        graph={graph}
        setGraph={setGraph}
        paramSlot="p"
        conditionalIndex={0} // TODO: Handle multiple conditionals
        mode="submenu"
        onClose={() => setOpenSubmenu(null)}
      />
    )}
  </div>
)}

{hasCostGbpParam && (
  <div onMouseEnter={() => setOpenSubmenu('cost_gbp')}>
    <span>Cost (£) parameter</span>
    {openSubmenu === 'cost_gbp' && (
      <DataOperationsMenu
        objectType="parameter"
        objectId={costGbpParameterId}
        hasFile={!!costGbpParameterId}
        targetId={edgeId}
        graph={graph}
        setGraph={setGraph}
        paramSlot="cost_gbp"
        mode="submenu"
        onClose={() => setOpenSubmenu(null)}
      />
    )}
  </div>
)}

{hasCostTimeParam && (
  <div onMouseEnter={() => setOpenSubmenu('cost_time')}>
    <span>Duration parameter</span>
    {openSubmenu === 'cost_time' && (
      <DataOperationsMenu
        objectType="parameter"
        objectId={costTimeParameterId}
        hasFile={!!costTimeParameterId}
        targetId={edgeId}
        graph={graph}
        setGraph={setGraph}
        paramSlot="cost_time"
        mode="submenu"
        onClose={() => setOpenSubmenu(null)}
      />
    )}
  </div>
)}
```

**Result**: 
- **~80 lines** instead of ~520 lines for submenus
- **PRECISELY mirrors LightningMenu operations**
- **Same code, same logic, same behavior**

### 4. Create `ParameterEditor` Component (Context Menu Slider)

**Purpose**: Single component for ALL parameter editing in context menus
- Probability slider
- Conditional probability slider  
- Variant weight slider

**Interface**:
```typescript
interface ParameterEditorProps {
  // Parameter data
  value: number;
  overridden: boolean;
  isUnbalanced?: boolean;
  
  // Parameter type determines UI
  paramType: 'probability' | 'conditional_p' | 'variant_weight';
  
  // Context
  graph: any;
  objectId: string; // edgeId or nodeId
  paramSlot?: 'p' | 'cost_gbp' | 'cost_time';
  conditionalIndex?: number;
  variantIndex?: number;
  allVariants?: any[];
  
  // Handlers
  onCommit: (value: number) => void;
  onRebalance?: () => void;
  onClearOverride: () => void;
  
  // Display
  label?: string;
  disabled?: boolean;
}
```

**Implementation**: ~100 lines
- Wraps `ProbabilityInput` or `VariantWeightInput` in `AutomatableField`
- Handles all override logic
- Calls UpdateManager for rebalancing
- **NO special cases**

### 5. Refactor EdgeContextMenu (Final Structure)

**Before**: 1,112 lines with massive duplication

**After**: ~250 lines using generalized components

```typescript
export const EdgeContextMenu: React.FC<EdgeContextMenuProps> = ({ ... }) => {
  const [openSubmenu, setOpenSubmenu] = useState<string | null>(null);
  
  // Find edge
  const edge = React.useMemo(() => 
    graph?.edges?.find((e: any) => e.uuid === edgeId || e.id === edgeId),
    [graph, edgeId]
  );
  
  // Parameter detection (generalized)
  const params = useMemo(() => ({
    p: {
      id: edge?.parameter_id || edge?.p?.id,
      hasFile: !!(edge?.parameter_id || edge?.p?.id),
      hasConnection: !!getConnection('p'),
      connection: getConnection('p')
    },
    cost_gbp: {
      id: edge?.cost_gbp_parameter_id || edge?.cost_gbp?.id,
      hasFile: !!(edge?.cost_gbp_parameter_id || edge?.cost_gbp?.id),
      hasConnection: !!getConnection('cost_gbp'),
      connection: getConnection('cost_gbp')
    },
    cost_time: {
      id: edge?.cost_time_parameter_id || edge?.cost_time?.id,
      hasFile: !!(edge?.cost_time_parameter_id || edge?.cost_time?.id),
      hasConnection: !!getConnection('cost_time'),
      connection: getConnection('cost_time')
    }
  }), [edge, graph]);
  
  // Conditional probabilities
  const hasConditionalP = edge?.conditional_p && edge.conditional_p.length > 0;
  const hasConditionalParam = edge?.conditional_p?.some((cp: any) => 
    cp.p?.parameter_id || cp.p?.id || cp.p?.connection
  ) || false;
  
  // Variant weights
  const isCaseEdge = edge?.case_id && edge?.case_variant;
  const caseNode = graph?.nodes?.find((n: any) => n.case?.id === edge?.case_id);
  
  return (
    <div>
      {/* Probability Editor */}
      <ParameterEditor
        paramType="probability"
        value={edge?.p?.mean || 0}
        overridden={edge?.p?.mean_overridden || false}
        isUnbalanced={isProbabilityUnbalanced}
        graph={graph}
        objectId={edgeId}
        paramSlot="p"
        onCommit={(value) => updateParam('p', { mean: value })}
        onRebalance={() => rebalanceParam('p')}
        onClearOverride={() => clearOverride('p', 'mean')}
      />
      
      {/* Conditional Probabilities */}
      {hasConditionalP && edge.conditional_p.map((condP, idx) => (
        <ParameterEditor
          key={idx}
          paramType="conditional_p"
          value={condP.p?.mean || 0}
          overridden={condP.p?.mean_overridden || false}
          isUnbalanced={isConditionalUnbalanced.get(idx)}
          graph={graph}
          objectId={edgeId}
          paramSlot="p"
          conditionalIndex={idx}
          onCommit={(value) => updateConditionalParam(idx, { mean: value })}
          onRebalance={() => rebalanceConditionalParam(idx)}
          onClearOverride={() => clearConditionalOverride(idx, 'mean')}
        />
      ))}
      
      {/* Variant Weight */}
      {isCaseEdge && caseNode && (
        <ParameterEditor
          paramType="variant_weight"
          value={variant.weight}
          overridden={variant.weight_overridden || false}
          graph={graph}
          objectId={caseNode.uuid}
          variantIndex={variantIndex}
          allVariants={allVariants}
          onCommit={(value) => updateVariantWeight(value)}
          onRebalance={() => rebalanceVariantWeight()}
          onClearOverride={() => clearVariantOverride()}
        />
      )}
      
      {/* Parameter Operation Submenus */}
      {params.p.hasFile && (
        <SubmenuTrigger label="Probability parameter" submenu="probability">
          <DataOperationsMenu
            objectType="parameter"
            objectId={params.p.id}
            hasFile={params.p.hasFile}
            targetId={edgeId}
            graph={graph}
            setGraph={setGraph}
            paramSlot="p"
            mode="submenu"
          />
        </SubmenuTrigger>
      )}
      
      {hasConditionalParam && (
        <SubmenuTrigger label="Conditional prob. parameter" submenu="conditional">
          <DataOperationsMenu
            objectType="parameter"
            objectId={params.p.id}
            hasFile={params.p.hasFile}
            targetId={edgeId}
            graph={graph}
            setGraph={setGraph}
            paramSlot="p"
            conditionalIndex={0}
            mode="submenu"
          />
        </SubmenuTrigger>
      )}
      
      {params.cost_gbp.hasFile && (
        <SubmenuTrigger label="Cost (£) parameter" submenu="cost_gbp">
          <DataOperationsMenu
            objectType="parameter"
            objectId={params.cost_gbp.id}
            hasFile={params.cost_gbp.hasFile}
            targetId={edgeId}
            graph={graph}
            setGraph={setGraph}
            paramSlot="cost_gbp"
            mode="submenu"
          />
        </SubmenuTrigger>
      )}
      
      {params.cost_time.hasFile && (
        <SubmenuTrigger label="Duration parameter" submenu="cost_time">
          <DataOperationsMenu
            objectType="parameter"
            objectId={params.cost_time.id}
            hasFile={params.cost_time.hasFile}
            targetId={edgeId}
            graph={graph}
            setGraph={setGraph}
            paramSlot="cost_time"
            mode="submenu"
          />
        </SubmenuTrigger>
      )}
      
      {/* Properties, Delete, etc. */}
    </div>
  );
};
```

## Implementation Steps

1. **Extract `DataOperationsMenu` from LightningMenu** (~150 lines)
   - Move menu rendering logic
   - Keep connection detection logic
   - Support both `dropdown` and `submenu` modes
   - Test with LightningMenu first

2. **Refactor LightningMenu** (~50 lines)
   - Use `DataOperationsMenu` component
   - Keep button + positioning logic
   - Verify all functionality preserved

3. **Create `ParameterEditor` component** (~100 lines)
   - Extract slider/input logic from EdgeContextMenu
   - Handle all param types generically
   - Test with probability, conditional_p, variant_weight

4. **Create `SubmenuTrigger` helper** (~30 lines)
   - Handles hover state
   - Renders submenu wrapper
   - Reusable for all submenus

5. **Refactor EdgeContextMenu** (~250 lines)
   - Use `ParameterEditor` for all editing
   - Use `DataOperationsMenu` for all operations
   - Use `SubmenuTrigger` for submenu wrappers
   - Verify all functionality preserved

6. **Refactor NodeContextMenu** (~150 lines)
   - Use `ParameterEditor` for variant weights
   - Use `DataOperationsMenu` if needed

## Key Benefits

1. **PRECISELY mirrors LightningMenu** - Same operations, same conditions, same behavior
2. **Single source of truth** - Menu logic in ONE place (`DataOperationsMenu`)
3. **Zero duplication** - LightningMenu and context menus use same component
4. **Consistent UX** - Same operations available everywhere
5. **Maintainable** - Fix bugs once, works everywhere

## Verification Checklist

- [ ] **DataOperationsMenu** extracts menu rendering from LightningMenu
- [ ] **LightningMenu** uses DataOperationsMenu (dropdown mode)
- [ ] **EdgeContextMenu** uses DataOperationsMenu (submenu mode)
- [ ] **Operations PRECISELY match** LightningMenu
- [ ] **Connection detection logic matches** LightningMenu
- [ ] **Visual language matches** LightningMenu (pathway icons)
- [ ] **ParameterEditor** handles all param types
- [ ] **ZERO special case code** in EdgeContextMenu
- [ ] EdgeContextMenu reduced from 1,112 → ~250 lines
- [ ] All existing functionality preserved
