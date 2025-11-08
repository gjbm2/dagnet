# Conditional Probability Migration & Graph-to-Graph Update Architecture

## What Changed

**Old Format:**
```typescript
conditional_p: [{
  condition: { visited: ['node-a', 'node-b'] },  // Structured object
  p: { mean: 0.8 },
  query: "from(x).to(y).visited(node-a, node-b)",
  query_overridden: false
}]
```

**New Format:**
```typescript
conditional_p: [{
  condition: "visited(node-a, node-b)",  // Query expression string
  p: { mean: 0.8 },
  query: "from(x).to(y).visited(node-a, node-b)",
  query_overridden: false
}]
```

## Semantic Implications

### Old Format Limitations
- **Only supported**: Simple node visitation checks
- **Logic**: "Has the user visited ALL of these nodes?"
- **Use case**: `visited: ['promo', 'cart']` = "visited promo AND visited cart"

### New Format Capabilities
- **Supports**: Full query expression DSL
- **Examples**:
  - `visited(promo)` - simple visitation
  - `case(pricing-test)` - case variant check
  - `visited(promo).exclude(cart)` - visitation with exclusions
  - `context(device:mobile)` - context checks
  - Arbitrary combinations of the above

### Breaking Changes
The new format is **MORE EXPRESSIVE** than the old format. This means:

1. **Forward Migration**: Old `{visited: [...]}` can be mechanically converted to `visited(...)` strings
2. **Backward Migration**: New expressions **CANNOT** always be converted back to old format
3. **Validation Logic**: Code that checked `condition.visited.length` or iterated `condition.visited` will break
4. **Equality Checks**: Code comparing conditions via `JSON.stringify(condition.visited.sort())` will break

## Backward Compatibility Hacks Already Deployed

### 1. `conditionalColors.ts` (Line ~90)
```typescript
// HACK: Handle both formats
if (typeof cp.condition === 'string') {
  return cp.condition;
} else if (cp.condition?.visited) {
  return JSON.stringify(cp.condition.visited.sort());
}
```

### 2. `conditionalValidation.ts` (Lines 19-42)
```typescript
function getVisitedNodeIds(condition: any): string[] {
  // HACK: Extracts visited nodes from both formats
  // Problem: Only works for simple visited() expressions
  // Fails for: case(), exclude(), context(), combinations
}
```
Used in 7 locations throughout the file.

### 3. `ConversionEdge.tsx` (Lines 27-50)
```typescript
function getVisitedNodeIds(condition: any): string[] {
  // HACK: Duplicate of above
}
```

### 4. `WhatIfAnalysisControl.tsx` (Lines 123-131, 478-491, 543-545)
```typescript
// HACK: Multiple checks for both formats
displayName: edges[0]?.conditional_p?.[0]?.condition
  ? (typeof edges[0].conditional_p[0].condition === 'string'
      ? edges[0].conditional_p[0].condition
      : /* old format handling */)
  : 'Empty condition'
```

### 5. `ConditionalProbabilityEditor.tsx` (Lines 135-140)
```typescript
// HACK: Display old format as string
typeof condition.condition === 'string' ? condition.condition : ''
```

## Files Still Using Old Format (BROKEN)

| File | Occurrences | Impact | Priority |
|------|-------------|--------|----------|
| `EdgeContextMenu.tsx` | 12 | Context menu for edges | **HIGH** |
| `ConditionalProbabilitiesSection.tsx` | 31 | Old UI component | **MEDIUM** (may be unused) |
| `runner.ts` | 3 | Simulation runner | **HIGH** |
| `conditionalReferences.ts` | 4 | Graph operations | **HIGH** |
| `whatIf.ts` | 4 | What-if calculations | **CRITICAL** |

## Proper Migration Strategy

### Phase 1: Data Migration (ONE-TIME)
1. **Graph File Migration Script**
   - Scan all `.json` graph files
   - Convert `condition: {visited: [...]}` → `condition: "visited(...)"`
   - Validate no data loss
   - Backup before migration

2. **UpdateManager Migration**
   - When loading old format from file, auto-migrate to new format
   - Log migration for audit trail
   - Never write old format back to files

### Phase 2: Code Migration (REQUIRED)
1. **Remove all backward compatibility hacks** (listed above)
2. **Update all consumers to use new format**:
   - Parse condition strings using proper query expression parser
   - Extract semantics (visited nodes, cases, contexts) via parser, not regex hacks
   - Update equality/comparison logic to use parsed expressions

3. **Query Expression Parser**
   - Build proper parser for condition strings
   - Extract: `getVisitedNodes()`, `getCases()`, `getContexts()`, `getExclusions()`
   - Use throughout codebase instead of ad-hoc regex

### Phase 3: Feature Restoration & UpdateManager Architecture

#### 3.1 Complementary Conditional Creation (LOST FEATURE)

**What It Was:**
When user added a conditional_p to an edge, the system would automatically:
1. Find all sibling edges (same `from` node)
2. Add a complementary conditional_p to each sibling with:
   - **Same condition** (e.g., if edge A gets `visited(promo)`, siblings get `visited(promo)` too)
   - **Same color** (visual grouping across siblings)
   - **Complementary probability** (auto-rebalanced, as if user pressed "rebalance")
   - **Auto-updating** unless `condition_overridden` flag set

**Example:**
```
Node A has 3 outgoing edges:
- Edge A→B: p=0.6
- Edge A→C: p=0.3  
- Edge A→D: p=0.1

User adds conditional_p to A→B:
  condition: "visited(promo)"
  p: 0.8

System AUTO-ADDS to A→C and A→D:
  A→C.conditional_p: { condition: "visited(promo)", p: 0.15, color: <same> }
  A→D.conditional_p: { condition: "visited(promo)", p: 0.05, color: <same> }
  (0.8 + 0.15 + 0.05 = 1.0)
```

**Where It Was:**
- Likely in `ConditionalProbabilitiesSection.tsx` (old UI component)
- Direct graph manipulation (not through UpdateManager)

**How To Restore:**
1. Implement as **graph-to-graph update in UpdateManager** (not direct manipulation)
2. Trigger: `onConditionalProbabilityAdded(edgeId, conditionalIndex)`
3. Logic:
   ```typescript
   // In UpdateManager.ts
   addComplementaryConditionals(edge: GraphEdge, newCondition: ConditionalProbability) {
     const siblings = findSiblingEdges(edge);
     const color = getOrAssignConditionalColor(newCondition.condition);
     
     for (const sibling of siblings) {
       if (!sibling.conditional_p) sibling.conditional_p = [];
       
       // Check if this condition already exists
       const existing = sibling.conditional_p.find(cp => 
         cp.condition === newCondition.condition
       );
       
       if (!existing && !sibling.condition_overridden) {
         sibling.conditional_p.push({
           condition: newCondition.condition,
           p: { mean: 0 }, // Will be rebalanced
           query: '', // Will be auto-generated by MSMDC
           query_overridden: false
         });
         sibling.display.conditional_color = color;
       }
     }
     
     // Auto-rebalance all siblings
     rebalanceConditionalProbabilities(siblings, newCondition.condition);
   }
   ```

#### 3.2 Color Picker (LOST FEATURE)

**What It Was:**
- UI control in properties panel for conditional probabilities
- Allowed user to select color for a condition
- Color would be set on `edge.display.conditional_color`
- Color would propagate to all sibling edges with same condition
- Used for visual grouping in graph view

**Where It Was:**
- Likely in `ConditionalProbabilitiesSection.tsx` (old UI component)
- ColorPicker component from UI library

**Where It Should Go:**
- `ConditionalProbabilityEditor.tsx` - add color picker next to condition field
- Or in properties panel, at the edge level (one color picker per unique condition across all edge's conditional_ps)

**How To Restore:**
```typescript
// In ConditionalProbabilityEditor.tsx
<div className="conditional-color-picker">
  <label>Condition Color</label>
  <ColorPicker
    value={condition.display?.conditional_color || getNextAvailableColor()}
    onChange={(color) => {
      // Update this edge
      updateCondition(index, { 
        display: { conditional_color: color } 
      });
      
      // Update all siblings with same condition (via UpdateManager)
      updateManager.propagateConditionalColor(
        edgeId, 
        condition.condition, 
        color
      );
    }}
  />
</div>
```

#### 3.3 Use UpdateManager for All Graph-to-Graph Updates

**The New World: File-Mastered Probabilities**

Now that `p.mean` can be mastered on external files (pulled via GET operations), we have a fundamental problem:

**Scenario:**
```
Node A has outgoing edges:
- A→B: p=0.4 (connected to param file X)
- A→C: p=0.6 (not connected)

PMF constraint: 0.4 + 0.6 = 1.0 ✓

User connects A→B.event_id = "checkout_started"
File X updates from event data → new p.mean = 0.3

PMF constraint: 0.3 + 0.6 = 0.9 ✗ BROKEN
```

**What Do We Do About A→C?**

**Option 1: Do Nothing** (Current behavior)
- Violates PMF constraint
- Graph is now invalid
- Downstream calculations will be wrong

**Option 2: Auto-Rebalance** (Requires graph-to-graph update)
```typescript
// When A→B updates from file:
updateManager.onEdgeProbabilityChanged(edgeId: 'A→B', oldValue: 0.4, newValue: 0.3) {
  const siblings = findUnconnectedSiblings('A→B'); // [A→C]
  const deficit = oldValue - newValue; // 0.1
  
  // Policy: Distribute deficit proportionally across unconnected siblings
  for (const sibling of siblings) {
    const proportion = sibling.p.mean / sumOfSiblings;
    sibling.p.mean += deficit * proportion;
  }
  
  // A→C becomes 0.6 + 0.1 = 0.7
  // PMF: 0.3 + 0.7 = 1.0 ✓
}
```

**Option 3: Missing Weight Policy**
```typescript
// Add virtual "other" edge to capture missing weight
updateManager.ensureMissingWeightEdge(nodeId: 'A') {
  const total = sumOutgoingEdges('A'); // 0.9
  if (total < 1.0 - TOLERANCE) {
    addVirtualEdge('A', 'missing_weight', p: 1.0 - total);
  }
}
```

**Option 4: Censoring Policy**
```typescript
// In example: No event corresponds to node C (it's inferred from absence)
// After X days without ghi event, we censor to C
// C's probability = 1 - sum(all observed events)
// This is similar to Option 3 but with semantic meaning
```

### Graph-to-Graph Update Architecture

**Core Principle:**
ALL graph modifications that affect other graph elements MUST go through UpdateManager.

**Categories of Updates:**

#### A. Conditional Probability Updates
```typescript
// Conditional-specific
updateManager.addConditionalProbability(edgeId, condition);
updateManager.removeConditionalProbability(edgeId, condIndex);
updateManager.updateConditionalCondition(edgeId, condIndex, newCond);
updateManager.rebalanceConditionalProbabilities(edgeIds, condition);
updateManager.propagateConditionalColor(edgeId, condition, color);
```

#### B. Normal Edge Probability Updates
```typescript
// When edge probability changes (user edit OR file GET)
updateManager.onEdgeProbabilityChanged(
  edgeId: string,
  oldValue: number,
  newValue: number,
  source: 'user' | 'file' | 'computed'
) {
  // 1. Check if this edge is connected to a file
  const isFileMastered = edge.parameter_id !== undefined;
  
  // 2. Find sibling edges
  const siblings = findSiblingEdges(edgeId);
  
  // 3. Apply rebalancing policy
  if (source === 'file' && !isFileMastered) {
    // This edge was updated by file, rebalance others
    rebalanceSiblings(siblings, edgeId, newValue);
  } else if (source === 'user') {
    // User edit - check if rebalance requested
    // (user might press "rebalance" button)
  }
  
  // 4. Validate PMF constraint
  validateOutgoingProbabilities(edge.from);
}

// Rebalancing strategies
updateManager.rebalanceSiblings(
  siblings: Edge[],
  changedEdge: Edge,
  policy: 'proportional' | 'equal' | 'missing_weight'
) {
  switch (policy) {
    case 'proportional':
      // Distribute deficit proportionally across unconnected siblings
      distributeProportionally(siblings, changedEdge);
      break;
    case 'equal':
      // Distribute deficit equally
      distributeEqually(siblings, changedEdge);
      break;
    case 'missing_weight':
      // Add virtual edge for missing weight
      addMissingWeightEdge(changedEdge.from);
      break;
  }
}
```

#### C. Case Variant Weight Updates
```typescript
// When case variant weight changes
updateManager.onVariantWeightChanged(
  nodeId: string,
  variantId: string,
  oldWeight: number,
  newWeight: number
) {
  // 1. Find all edges for this case node + variant
  const variantEdges = findEdgesForVariant(nodeId, variantId);
  
  // 2. Rebalance across other variants
  const otherVariants = findOtherVariants(nodeId, variantId);
  rebalanceVariantWeights(otherVariants, nodeId, newWeight);
  
  // 3. Validate total weight = 1.0 across all variants
  validateVariantWeights(nodeId);
}
```

#### D. Cascading Updates After GET Operations
```typescript
// Hook into file→graph sync
updateManager.afterFileToGraph(
  entityType: 'edge' | 'node',
  entityId: string,
  updatedFields: string[]
) {
  if (updatedFields.includes('p.mean')) {
    // Edge probability was updated from file
    onEdgeProbabilityChanged(entityId, oldVal, newVal, 'file');
  }
  
  if (updatedFields.includes('case_variant_weight')) {
    // Variant weight was updated from file
    onVariantWeightChanged(nodeId, variantId, oldVal, newVal);
  }
}
```

### UpdateManager Architecture Enhancement

**Current State:**
```typescript
class UpdateManager {
  // Only handles file ↔ graph sync
  fileToGraph(entity, fields);
  graphToFile(entity, fields);
}
```

**Enhanced State:**
```typescript
class UpdateManager {
  // File ↔ Graph sync (existing)
  fileToGraph(entity, fields);
  graphToFile(entity, fields);
  
  // Graph → Graph updates (NEW)
  graphToGraph: {
    // Edge probability management
    onEdgeProbabilityChanged(edgeId, old, new, source);
    rebalanceSiblings(siblings, policy);
    validateOutgoingProbabilities(nodeId);
    
    // Case variant management
    onVariantWeightChanged(nodeId, variantId, old, new);
    rebalanceVariantWeights(nodeId);
    validateVariantWeights(nodeId);
    
    // Conditional probability management
    addConditionalProbability(edgeId, condition);
    removeConditionalProbability(edgeId, index);
    updateConditionalCondition(edgeId, index, newCond);
    rebalanceConditionalProbabilities(edgeIds, condition);
    propagateConditionalColor(edgeId, condition, color);
    
    // Query generation
    generateConditionalQuery(edgeId, condIndex);
    regenerateAllQueries(); // MSMDC pass
  },
  
  // Policies (configurable)
  policies: {
    rebalancingStrategy: 'proportional' | 'equal' | 'missing_weight',
    autoRebalanceOnFileUpdate: boolean,
    validatePMFConstraints: boolean,
    missingWeightThreshold: number,
  }
}
```

### Benefits of This Architecture

1. **Single Source of Truth** - All graph mutations go through one place
2. **Testable** - Can test update logic in isolation
3. **Auditable** - Can log all graph-to-graph updates
4. **History Integration** - Can batch graph-to-graph updates into single history entry
5. **Policy-Based** - Can change rebalancing policies without changing UI code
6. **Validation** - Can enforce constraints (PMF = 1.0) consistently
7. **Cascading Updates** - File update → rebalance siblings → regenerate queries → validate

### Example: User Edits Edge Probability

**Old Pattern (Direct Manipulation):**
```typescript
// In PropertiesPanel.tsx
const handleProbabilityChange = (newValue) => {
  edge.p.mean = newValue; // Direct mutation
  setGraph({...graph}); // Hope for the best
};
```

**New Pattern (Via UpdateManager):**
```typescript
// In PropertiesPanel.tsx
const handleProbabilityChange = (newValue) => {
  updateManager.graphToGraph.onEdgeProbabilityChanged(
    edgeId,
    edge.p.mean,
    newValue,
    'user'
  );
  // UpdateManager handles:
  // 1. Update edge.p.mean
  // 2. Check if rebalancing needed
  // 3. Validate PMF
  // 4. Create single history entry
  // 5. Trigger re-render
};
```

### Implementation Priority

**Phase 1 (Current)**: Conditional probabilities only
- Focus on getting conditional_p working
- Use UpdateManager for conditional operations

**Phase 2 (Next)**: Normal edge probabilities
- Implement rebalancing policies
- Handle file-mastered probability updates
- Add PMF validation

**Phase 3 (Future)**: Case variant weights
- Similar to edge probabilities
- Rebalancing across variants
- Validation

**Phase 4 (Polish)**: Full integration
- Comprehensive testing
- Policy configuration UI
- Advanced features (missing weight nodes, etc.)

### Phase 4: Enhanced Semantics
1. **Support full query expression features in validation**
2. **Support case(), exclude(), context() in what-if analysis**
3. **Update UI to show/edit full expression capabilities**

## Where Old Features Likely Were

### ConditionalProbabilitiesSection.tsx (OLD UI)
This component (1000+ lines) was the old UI for managing conditional probabilities. It likely contained:
- Color picker UI
- Complementary conditional creation logic
- Rebalancing logic
- Node selection chips

**Current Status**: ✅ VERIFIED - Imported in PropertiesPanel.tsx but NOT rendered (dead code)

**Action Required**: 
1. ✅ Confirmed not used (no `<ConditionalProbabilitiesSection` JSX tags found)
2. ⚠️ Extract useful logic BEFORE removal:
   - Line ~XXX: Complementary conditional creation
   - Line ~XXX: Color picker component
   - Line ~XXX: Rebalancing logic
3. Move extracted logic to UpdateManager
4. Remove component and import from PropertiesPanel.tsx

### PropertiesPanel.tsx
Current implementation uses `ConditionalProbabilityEditor` (new) but imports `ConditionalProbabilitiesSection` (old).

**Action Required**:
1. Verify old component is not rendered
2. Remove import if unused
3. If it IS used, we need to fix it or replace it with new component

## Implementation Order

1. ✅ **DONE**: Update types, schema, ConditionalProbabilityEditor to use string format
2. ⚠️ **IN PROGRESS**: Quick hacks to prevent crashes (TEMPORARY)
3. ❌ **TODO Phase 1**: Assess ConditionalProbabilitiesSection.tsx
   - Is it still rendered? (grep usage)
   - Extract complementary creation logic
   - Extract color picker logic
   - Document for preservation
4. ❌ **TODO Phase 2**: Fix broken files (see README.md)
5. ❌ **TODO Phase 3**: Remove backward compatibility hacks
6. ❌ **TODO Phase 4**: Restore features via UpdateManager
7. ❌ **TODO Phase 5**: Full testing

## Rollback Plan

If migration fails:
1. Revert schema changes
2. Restore `condition: { visited: string[] }` type
3. Remove QueryExpressionEditor from condition field
4. Keep old chip-based selector

**DO NOT PROCEED** with half-baked backward compatibility. Either:
- **Option A**: Complete proper migration (Phases 1-4)
- **Option B**: Revert to old format entirely

