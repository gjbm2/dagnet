# Edge Label Rendering Consolidation Analysis

## Current State: Multiple Code Paths

### Path 1: Composite Label (Multi-Layer Scenario View)
**Trigger**: `compositeLabel && compositeLabel.segments.length > 1`  
**Location**: `ConversionEdge.tsx` lines 1946-2073

Renders when:
- Scenarios context exists
- Active tab exists  
- At least one scenario is visible (including base, current, or user scenarios)

Logic:
- Builds `LabelSegment[]` array with probability, variantWeight, edgeProbability, stdev for each visible layer
- Adds hidden 'current' segment if not visible
- Checks if all visible segments are identical
- If identical and hidden matches, shows single black label
- If identical but hidden differs, shows simplified visible + grey bracketed hidden
- Otherwise shows coloured labels for each segment

**Handles**:
- Case edges (variant weight + edge probability)
- Normal edges (just probability)
- Standard deviation
- Hidden vs visible layers
- Colour coding by scenario

### Path 2: Fallback Rendering (Single Layer / No Scenarios)
**Trigger**: `!(compositeLabel && compositeLabel.segments.length > 1)`  
**Location**: `ConversionEdge.tsx` lines 2074-2144

Sub-paths:
1. **No probability** (lines 2074-2085): Shows warning
2. **What-If override** (lines 2086-2106): Green for conditional, purple for case variant
3. **Case edge without override** (lines 2107-2127): Purple background, shows variant name
4. **Normal edge** (lines 2128-2143): Basic percentage with optional stdev

**Handles**:
- What-If DSL overrides
- Case edges
- Parameter connections (⛓️ icon)
- Standard deviation

### Path 3: Cost Rendering (Shared by Both Paths)
**Location**: `ConversionEdge.tsx` lines 2145-2180

Shows GBP and time costs below probability label.

---

## Problems Identified

### 1. **Duplicate Probability Calculation Logic**
- Composite path: Manually computes prob for each layer (lines 421-580)
- Fallback path: Uses `effectiveProbability` hook (line 2097, 2118, 2136)
- **Risk**: Inconsistent results if logic diverges

### 2. **Duplicate Case Edge Handling**
- Composite path: Extracts `variantWeight` and `edgeProbability` separately for each layer
- Fallback path: Shows `effectiveProbability` (already multiplied) + variant name
- **Risk**: Different display formats for same edge type

### 3. **Duplicate Variant Weight Extraction**
- Appears in 4 places:
  - Lines 432-456 (current layer, visible)
  - Lines 466-508 (base layer)
  - Lines 536-578 (scenario layer)
  - Lines 601-626 (current layer, hidden)
- **Risk**: Code maintenance nightmare, easy to introduce bugs

### 4. **Inconsistent Display Logic**
- Composite path: Shows `25%/100%` for case edges
- Fallback path: Shows `25%` (effective) + variant name below
- **Risk**: Confusing UX when toggling scenarios

### 5. **Conditional Rendering Complexity**
- 8 nested ternary operators in fallback path
- Composite path has its own complexity with identity checking
- **Risk**: Hard to test, hard to understand

---

## Chevron Rendering Analysis

**Answer**: Chevrons are rendered **once globally for all edges**, NOT per layer.

**Evidence**:
- `ChevronClipPaths` component (lines 16-130) renders a single set of SVG `<clipPath>` definitions
- It's rendered once at the GraphCanvas level
- Each edge (base or overlay) references these clip paths via `sourceClipPathId` and `targetClipPathId`
- The clip paths are based on bundle width calculations that aggregate ALL edges (not per-scenario)

**Implications**:
- ✅ Efficient: Only one set of clip paths regardless of scenario count
- ✅ Consistent: All scenario overlays use the same chevron shapes
- ⚠️ Limitation: Chevron shapes don't vary per scenario (based on aggregate width)

---

## Proposed Consolidation Strategy

### Phase 1: Extract Reusable Helper Functions

#### 1.1: `getCaseEdgeVariantInfo(edge, graph, params?)`
```typescript
interface CaseEdgeInfo {
  variantWeight: number;
  edgeProbability: number;
  variantName: string;
  caseId: string;
}

function getCaseEdgeVariantInfo(
  edge: any,
  graph: any,
  params?: ScenarioParams
): CaseEdgeInfo | null {
  // Single implementation of variant extraction
  // Used by all rendering paths
}
```

**Benefits**:
- Single source of truth
- Easier to test
- Eliminates 4 copies of same logic

#### 1.2: `getEdgeProbabilityForLayer(layerId, edgeId, graph, scenariosContext, whatIfDSL?)`
```typescript
interface EdgeProbabilityInfo {
  probability: number;
  stdev?: number;
  variantWeight?: number;
  edgeProbability?: number;
  isOverridden: boolean;
  overrideType?: 'conditional' | 'case' | 'whatif';
}

function getEdgeProbabilityForLayer(
  layerId: string,
  edgeId: string,
  graph: any,
  scenariosContext: any,
  whatIfDSL?: string | null
): EdgeProbabilityInfo {
  // Unified probability calculation for any layer
  // Handles: base, current, scenarios, what-if, case edges
}
```

**Benefits**:
- Consistent calculations across all paths
- Centralized what-if logic
- Single place to fix bugs

#### 1.3: `formatEdgeProbabilityLabel(info: EdgeProbabilityInfo, options)`
```typescript
interface LabelFormatOptions {
  showColour?: boolean;
  colour?: string;
  showParens?: boolean;
  showVariantName?: boolean;
  compact?: boolean;
}

function formatEdgeProbabilityLabel(
  info: EdgeProbabilityInfo,
  options: LabelFormatOptions
): React.ReactNode {
  // Unified label formatting
  // Handles all display variations
}
```

**Benefits**:
- Consistent display formatting
- Easy to adjust styling globally
- Testable independently

### Phase 2: Unified Label Rendering

#### 2.1: Always Build Composite Label Structure
**Change**: Remove the early return at line 400-403

Instead of:
```typescript
if (visibleScenarioIds.length === 0) {
  return null; // Falls back to old rendering
}
```

Do:
```typescript
if (visibleScenarioIds.length === 0) {
  // Build single-segment composite label for 'current'
  const info = getEdgeProbabilityForLayer('current', lookupId, graph, scenariosContext, whatIfDSL);
  return {
    segments: [{ ...info, layerId: 'current', color: '#000', isHidden: false }],
    isSingleLayer: true
  };
}
```

**Benefits**:
- Composite label becomes the ONLY rendering path
- Fallback logic can be deleted
- Consistent behavior regardless of scenario count

#### 2.2: Simplify Rendering Logic
With unified structure, the rendering becomes:
```typescript
<EdgeLabelRenderer>
  {!data?.suppressLabel && compositeLabel && (
    <div>{renderCompositeLabel(compositeLabel)}</div>
  )}
</EdgeLabelRenderer>
```

Where `renderCompositeLabel()` is a single, well-tested function.

### Phase 3: Testing & Validation

Create test cases for:
1. ✓ No scenarios, normal edge
2. ✓ No scenarios, case edge  
3. ✓ No scenarios, what-if override
4. ✓ Single scenario visible
5. ✓ Multiple scenarios, identical values
6. ✓ Multiple scenarios, different values
7. ✓ Hidden current matching visible
8. ✓ Hidden current differing from visible

---

## Implementation Priority

### High Priority (Do First)
1. Extract `getCaseEdgeVariantInfo()` helper
2. Extract `getEdgeProbabilityForLayer()` helper
3. Replace all 4 variant extraction sites with helper call

### Medium Priority
4. Extract `formatEdgeProbabilityLabel()` helper
5. Unify composite label to always build (even for single layer)

### Low Priority (Cleanup)
6. Delete fallback rendering path entirely
7. Simplify conditional logic
8. Add comprehensive tests

---

## Migration Strategy

**Approach**: Incremental, non-breaking

1. **Week 1**: Add helper functions alongside existing code
2. **Week 2**: Switch composite path to use helpers (validate no regressions)
3. **Week 3**: Switch fallback path to use helpers (validate no regressions)  
4. **Week 4**: Unify paths, delete redundant code

**Rollback Plan**: Each phase is independently committable. Can revert any phase without breaking others.

---

## Metrics for Success

- **Code Reduction**: Expect ~300 lines deleted from ConversionEdge.tsx
- **Cyclomatic Complexity**: Should drop from ~25 to ~8 in label rendering
- **Test Coverage**: Should increase from ~0% to >80% for label logic
- **Bug Rate**: Should see fewer "label shows wrong value" bugs

---

## Related Files

- `graph-editor/src/components/edges/ConversionEdge.tsx` (main file)
- `graph-editor/src/lib/whatIf.ts` (what-if calculation logic)
- `graph-editor/src/services/CompositionService.ts` (scenario compositing)
- `graph-editor/src/components/ChevronClipPaths.tsx` (chevron rendering)

---

## Questions for Stakeholders

1. Should case edges always show `variantWeight/edgeProb` format, or only when scenarios are visible?
2. Is the "hidden current in brackets" UX working well, or should we explore alternatives?
3. Are there performance concerns with always building composite label structure?
4. Should we maintain backward compatibility with old label format during migration?


