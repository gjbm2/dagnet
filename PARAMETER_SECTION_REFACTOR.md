# Parameter Section Refactoring - ✅ COMPLETE

**Status:** Implemented and tested  
**Date Completed:** Nov 7, 2025  
**Result:** PropertiesPanel reduced from 3129 → 2357 lines (25% reduction)

## Problem

1. **QueryExpressionEditor has too much logic in PropertiesPanel**
   - onChange/onBlur handlers are verbose
   - Override management is duplicated
   - Label/icon rendering is external

2. **Parameter sections are highly repetitive**
   - Probability (p)
   - Cost GBP (cost_gbp)
   - Cost Time (cost_time)
   - Conditional Probability (conditional_p)
   
   Each follows the same pattern:
   - EnhancedSelector for param ID
   - QueryExpressionEditor for query
   - AutomatableField-wrapped inputs for values (mean, stdev, distribution)
   - Get/Push/Open buttons
   - Override flag management

## Proposed Solution

### 1. Create `ParameterSection` Component

A generalized component that handles all parameter types:

```typescript
interface ParameterSectionProps {
  // Which parameter slot
  type: 'probability' | 'cost_gbp' | 'cost_time';
  
  // Current state
  param: ProbabilityParam | CostParam | null;
  
  // Callbacks
  onUpdate: (updates: Partial<ProbabilityParam | CostParam>) => void;
  onConnect: (paramId: string) => void;
  onDisconnect: () => void;
  
  // Context
  graph: ConversionGraph;
  objectId: string; // edge or node ID
  objectType: 'edge' | 'node';
  
  // Optional customization
  label?: string;
  hideQuery?: boolean;
  hideDistribution?: boolean;
  customFields?: React.ReactNode;
}
```

**Features:**
- Automatically handles all CRUD operations
- Manages override flags internally
- Provides GET/PUSH/OPEN actions
- Renders QueryExpressionEditor with proper integration
- Wraps all inputs in AutomatableField

### 2. Enhance AutomatableField for Custom Layouts

Add layout flexibility WITHOUT duplicating logic:

**Add to AutomatableField:**
```typescript
interface AutomatableFieldProps {
  // ... existing props ...
  
  // New: Custom label content (e.g., Info icon)
  labelExtra?: React.ReactNode;
  
  // New: Layout mode
  layout?: 'default' | 'label-above';  // default = inline, label-above = stacked
}
```

**Usage in ParameterSection:**
```typescript
<AutomatableField
  label="Data Retrieval Query"
  labelExtra={
    <Info 
      size={14} 
      title="Define constraints for retrieving data..."
      style={{ color: '#9CA3AF', cursor: 'help' }}
    />
  }
  layout="label-above"  // Label + Info + ZapOff in row ABOVE editor
  value={param?.query || ''}
  overridden={param?.query_overridden || false}
  onClearOverride={() => onUpdate({ query: '', query_overridden: false })}
>
  <QueryExpressionEditor
    value={param?.query || ''}
    onChange={(q) => onUpdate({ query: q, query_overridden: true })}
    graph={graph}
    edgeId={objectId}
  />
</AutomatableField>
```

**Benefits:**
- ✅ Reuses ALL AutomatableField logic (animation, dirty state, ZapOff)
- ✅ No code duplication
- ✅ QueryExpressionEditor stays simple - just Monaco + chips
- ✅ Consistent behavior across all fields

### 3. Usage in PropertiesPanel

**Before (current):**
```typescript
// 100+ lines of boilerplate for each parameter type
<EnhancedSelector ... />
<QueryExpressionEditor ... complex handlers ... />
<AutomatableField><input mean /></AutomatableField>
<AutomatableField><input stdev /></AutomatableField>
// ... etc
```

**After:**
```typescript
// Edge probability parameter
<ParameterSection
  type="probability"
  param={selectedEdge?.p}
  onUpdate={(updates) => updateEdgeParam('p', updates)}
  onConnect={(id) => connectParam('p', id)}
  onDisconnect={() => disconnectParam('p')}
  graph={graph}
  objectId={selectedEdgeId}
  objectType="edge"
/>

// Edge cost_gbp parameter
<ParameterSection
  type="cost_gbp"
  param={selectedEdge?.cost_gbp}
  onUpdate={(updates) => updateEdgeParam('cost_gbp', updates)}
  onConnect={(id) => connectParam('cost_gbp', id)}
  onDisconnect={() => disconnectParam('cost_gbp')}
  graph={graph}
  objectId={selectedEdgeId}
  objectType="edge"
/>

// Edge cost_time parameter
<ParameterSection
  type="cost_time"
  param={selectedEdge?.cost_time}
  onUpdate={(updates) => updateEdgeParam('cost_time', updates)}
  onConnect={(id) => connectParam('cost_time', id)}
  onDisconnect={() => disconnectParam('cost_time')}
  graph={graph}
  objectId={selectedEdgeId}
  objectType="edge"
/>
```

## Benefits

1. **Massive code reduction** in PropertiesPanel
   - From ~500 lines to ~50 lines for all parameter sections
   
2. **Consistency** - all parameters work identically

3. **Maintainability** - logic is centralized

4. **Reusability** - can use ParameterSection anywhere (context menus, modals, etc.)

5. **Testability** - can test ParameterSection in isolation

## Implementation Plan

1. Enhance AutomatableField:
   - Add `labelExtra?: React.ReactNode` prop for Info icons, etc.
   - Add `layout?: 'default' | 'label-above'` prop for flexible layouts
   - Update CSS for label-above layout (label + extra + ZapOff in row above input)

2. Simplify QueryExpressionEditor:
   - Remove self-contained override props (will use AutomatableField instead)
   - Keep focused on Monaco + chips functionality
   - Remove redundant label rendering

3. Create ParameterSection component:
   - Use EnhancedSelector for connection
   - Use AutomatableField for all inputs (including QueryExpressionEditor)
   - Handle GET/PUSH/OPEN actions
   - Manage all override flags
   - Call saveHistoryState internally

4. Refactor PropertiesPanel:
   - Replace verbose parameter sections with ParameterSection
   - Add helper methods: updateEdgeParam, connectParam, disconnectParam
   - Remove duplicate code

5. Test all parameter types:
   - Probability on edges
   - Cost GBP on edges
   - Cost Time on edges
   - Conditional probabilities
   
6. Remove old code and update types

## Questions

1. ✅ Should ParameterSection handle conditional_p differently, or create a separate ConditionalProbabilitySection?
   - **Answer**: Same pattern - use ParameterSection for both
   
2. ✅ Should we also generalize the selector connection UI (GET/PUSH/OPEN buttons)?
   - **Answer**: Use existing EnhancedSelector WITHIN ParameterSection
   
3. ✅ Should history/undo be handled inside ParameterSection or remain in PropertiesPanel?
   - **Answer**: Handle internally with smart messages, add `skipHistory` prop for batching
   - **Note**: History transaction batching for GET operations is documented in PROJECT_CONNECT/README.md as future work

---

## ✅ Implementation Summary

### Components Created

1. **`ParameterSection.tsx`** (263 lines)
   - Generic parameter UI component
   - Handles probability, cost_gbp, cost_time, and conditional_p
   - Integrated EnhancedSelector for parameter file connections
   - Integrated QueryExpressionEditor for data retrieval queries
   - All inputs wrapped in AutomatableField for override management

2. **`ParameterSection.css`** (53 lines)
   - Consistent styling across all parameter fields
   - Fixed-width labels (85px) for alignment
   - `flex: 1` + `min-width: 0` for responsive behavior
   - Grey placeholder text
   - Proper right-edge alignment

### AutomatableField Enhancements

- Added `labelExtra?: React.ReactNode` prop for Info icons
- Added `layout?: 'default' | 'label-above'` prop for flexible layouts
- `label-above` layout: Label + extra content + ZapOff button in row above input
- Maintained all existing functionality (animation, dirty state, override management)

### PropertiesPanel Changes

**Before:** 3129 lines  
**After:** 2357 lines  
**Reduction:** 772 lines (24.7%)

**Replaced sections:**
- Probability parameter (lines 1647-2067) → `<ParameterSection paramSlot="p" />`
- Cost (£) parameter (lines ~2100-2300) → `<ParameterSection paramSlot="cost_gbp" />`
- Cost (Time) parameter (lines ~2300-2500) → `<ParameterSection paramSlot="cost_time" />`
- 3x Conditional probability parameters → 3x `<ParameterSection paramSlot="p" />` (in conditional blocks)

**Helper functions added:**
- `updateEdgeParam()` - Update parameter field
- `updateConditionalPParam()` - Update conditional probability parameter
- `rebalanceConditionalP()` - Handle rebalancing across conditional probabilities

### UI Improvements

- ✅ Stdev changed from slider to number input
- ✅ Inline labels added: "£ cost", "Time cost", "Std Dev", "Distribution"
- ✅ Separate lines for Std Dev and Distribution (not cramped)
- ✅ Consistent right-edge alignment across all fields
- ✅ Grey placeholder text
- ✅ Time cost placeholder: "120" with hover hint for future formats (2d, 10m)
- ✅ Probability label removed from slider (redundant)

### Testing

- ✅ Manually tested all parameter types (probability, cost_gbp, cost_time)
- ✅ Verified override icons work consistently
- ✅ Verified animations work on GET updates
- ✅ Verified right-edge alignment at various sidebar widths
- ✅ All existing functionality preserved

### Next Steps

- Polish QueryExpressionEditor (detailed refinements needed)
- Graph auto-updates (auto-build queries, automated GET operations)

