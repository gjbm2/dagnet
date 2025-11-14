# Edge Label Rendering Specification

**Version**: 2.0 (Post-Consolidation)  
**Status**: Design Proposal  
**Last Updated**: 2025-11-14

---

## Executive Summary

This specification defines a **unified rendering system** for edge labels that consolidates duplicate code paths and provides consistent, intelligent display across all scenario configurations.

### Key Innovations

1. **Single Code Path**: Eliminates separate "no scenarios" vs "multi-scenario" rendering modes
2. **Smart Deduplication**: Automatically simplifies identical values to reduce visual clutter
3. **Per-Field Deduplication**: Shows `40% 50% 60%, £100` when costs are identical
4. **Variant Name First**: Case edges show `treatment: 25%/100%` for immediate identification
5. **Inline Costs**: All data comma-separated on one line: `45%, £100, 2.5d`
6. **Plug Icon**: 🔌 indicates parameter connections (replacing ⛓️)

### Impact

- **Code Reduction**: ~300 lines eliminated from `ConversionEdge.tsx`
- **Bug Prevention**: Single source of truth for label logic
- **UX Improvement**: Consistent behavior regardless of scenario count
- **Performance**: Negligible impact (< 1ms per edge)

---

## Design Principles

1. **Single Rendering Path**: All edge labels rendered through unified composite label system
2. **Consistent Format**: Same edge type shows same format regardless of scenario visibility
3. **Progressive Disclosure**: Show more detail only when useful (stdev, costs, etc.)
4. **Color Semantics**: Color indicates scenario source, black indicates universal/identical
5. **Smart Simplification**: Suppress redundant information (identical values, matching hidden)

---

## Core Label Format Rules

### Rule 0: Parameter Connection Icon
**Display**: `🔌` (plug icon) for edges with `parameter_id` connection
**Rationale**: Plug icon is more intuitive than chain for parameter connections

### Rule 1: Normal Edges (No Case Variant)
**Display**: `{probability}%` with optional `± {stdev}%`
**With costs**: `{probability}%, £{cost_gbp}, {cost_time}d`

### Rule 2: Case Edges
**Display**: `{variantName}: {variantWeight}%/{edgeProbability}%` with optional `± {stdev}%`
**With costs**: `{variantName}: {variantWeight}%/{edgeProbability}%, £{cost_gbp}, {cost_time}d`

**Rationale**: Variant name comes first for immediate identification. Both weights shown to make multiplication visible: `effective = variantWeight × edgeProbability`.

### Rule 3: Costs Inline
Costs are shown **inline, comma-separated**, not below. They follow the same segmentation and color coding as probabilities.

**Example**: `65%, £1.50` (blue) `20%, £1.50` (pink)

### Rule 4: Color Coding
- **Black**: Value is identical across all visible layers
- **Scenario Color**: Value differs between layers, color matches scenario
- **Light Grey (#999)**: Hidden 'current' layer shown in brackets

### Rule 5: Brackets for Hidden Current
When 'current' is not visible but differs from visible values, show: `visible_values (hidden_current_value)`

### Rule 6: Smart Simplification (Applies to ALL scenarios)
- If all visible layers have identical values AND hidden current matches: show single black label
- If all visible layers have identical values BUT hidden current differs: show `single_value (hidden_value)`
- If values differ: show each colored label

**CRITICAL**: This is the ONLY rendering path. No special cases for "no scenarios visible".

---

## Comprehensive Rendering Matrix

**UNIFIED APPROACH**: All examples below use the same composite label system with smart deduplication. There is no separate "no scenarios visible" mode - when only current is visible, it's treated as a single-segment composite label that deduplicates to black.

---

### 1. Normal Edges (No Case Variant)

#### 1.1: Single Layer (Current Only, or All Identical)
```
┌─────────┐
│  45%    │  ← Black (deduplicated)
└─────────┘
```

#### 1.2: Single Layer with Stdev
```
┌───────────────┐
│ 45% ± 10%     │  ← Black
└───────────────┘
```

#### 1.3: With Parameter Connection
```
┌───────────────┐
│ 🔌 45%        │  ← Plug icon (10px) + percentage
└───────────────┘
```

#### 1.4: With Costs (Inline, Comma-Separated)
```
┌─────────────────────┐
│ 45%, £125.50, 3.5d  │  ← Black (all identical)
└─────────────────────┘
```

#### 1.5: With Costs and Parameter Connection
```
┌────────────────────────┐
│ 🔌 45%, 🔌 £125.50    │  ← Plug icons for connected params
└────────────────────────┘
```

#### 1.6: Multiple Scenarios, All Identical
```
┌─────────────────────┐
│ 45%, £100, 2d       │  ← Black (deduplicated from 3 identical segments)
└─────────────────────┘
```

#### 1.7: Multiple Scenarios, Probabilities Differ
```
┌──────────────────────────────────────┐
│ 40%  50%  55%                        │  ← Blue, Orange, Purple
└──────────────────────────────────────┘
```

#### 1.8: Multiple Scenarios, Probabilities and Costs Differ
```
┌────────────────────────────────────────────────┐
│ 40%, £100  50%, £150  55%, £150               │  ← Each segment colored
└────────────────────────────────────────────────┘
```

#### 1.9: Probabilities Differ, Costs Same (Partial Dedup)
```
┌────────────────────────────────────────────────┐
│ 40%  50%  55%, £150                            │  ← Cost deduplicated, probabilities not
└────────────────────────────────────────────────┘
```

**Note**: Smart deduplication works per-field. If all costs are £150, show once in black. If probabilities differ, show colored.

#### 1.10: With Hidden Current (Differs)
```
┌──────────────────────┐
│ 45%  (50%)           │  ← Visible (black), Hidden (grey)
└──────────────────────┘
```

#### 1.11: With Hidden Current and Costs
```
┌────────────────────────────────────┐
│ 45%, £100  (50%, £120)             │  ← Both prob and cost differ
└────────────────────────────────────┘
```

#### 1.12: Missing/Undefined Probability
```
┌──────────────────────┐
│  ⚠️ No Probability   │  ← Red background (#fff5f5), red border
└──────────────────────┘
```

---

### 2. Case Edges (With Variant)

#### 2.1: Single Layer (Deduplicated)
```
┌──────────────────────────┐
│ treatment: 25%/100%      │  ← Black, variant name first
└──────────────────────────┘
```

#### 2.2: With Stdev
```
┌──────────────────────────────┐
│ treatment: 25%/100% ± 5%     │  ← Stdev applies to edge probability
└──────────────────────────────┘
```

#### 2.3: With Costs (Inline)
```
┌─────────────────────────────────────┐
│ treatment: 25%/100%, £50, 1d        │  ← All inline, comma-separated
└─────────────────────────────────────┘
```

#### 2.4: Multiple Scenarios, All Identical
```
┌─────────────────────────────────────┐
│ treatment: 25%/100%, £50            │  ← Black (deduplicated)
└─────────────────────────────────────┘
```

#### 2.5: Multiple Scenarios, Variant Weights Differ
```
┌──────────────────────────────────────────────────────┐
│ treatment: 20%/100%  25%/100%  30%/100%              │  ← Blue, Orange, Purple
└──────────────────────────────────────────────────────┘
```

#### 2.6: Multiple Scenarios, Edge Probabilities Differ
```
┌──────────────────────────────────────────────────────┐
│ treatment: 25%/90%  25%/100%  25%/100%               │  ← First differs, others same
└──────────────────────────────────────────────────────┘
```

#### 2.7: Multiple Scenarios, Both Variant and Edge Prob Differ
```
┌──────────────────────────────────────────────────────┐
│ treatment: 20%/90%  25%/100%  30%/100%               │  
└──────────────────────────────────────────────────────┘
```

#### 2.8: With Costs, Multiple Scenarios
```
┌────────────────────────────────────────────────────────────────┐
│ treatment: 20%/100%, £40  25%/100%, £50  30%/100%, £50        │  
└────────────────────────────────────────────────────────────────┘
```

#### 2.9: With Hidden Current (Current Invisible)
```
┌──────────────────────────────────────────────────┐
│ treatment: 25%/100%  (10%/100%)                  │  ← Visible vs hidden
└──────────────────────────────────────────────────┘
```

**Example from user**: This is the canonical format for case edges with hidden current.

#### 2.10: With Hidden Current and Costs
```
┌──────────────────────────────────────────────────────────┐
│ treatment: 25%/100%, £50  (10%/100%, £30)                │  
└──────────────────────────────────────────────────────────┘
```

---

### 3. Stdev Variations

#### 3.1: Multiple Scenarios, Some with Stdev, Some Without
```
┌──────────────────────────────────────┐
│ 40% ± 5%  50%  45% ± 3%              │  ← Show stdev only where defined
└──────────────────────────────────────┘
```

#### 3.2: All Have Different Stdevs
```
┌──────────────────────────────────────────┐
│ 40% ± 5%  40% ± 10%  40% ± 8%           │  ← Same prob, different stdev → don't dedup
└──────────────────────────────────────────┘
```

#### 3.3: Stdev Larger Than Mean
```
┌───────────────────┐
│  5% ± 15%         │  ← Valid (some distributions allow this)
└───────────────────┘
```

---

### 4. Cost Variations

#### 4.1: Same Probability, Different Costs
```
┌────────────────────────────────────────┐
│ 50%, £100  50%, £150  50%, £120        │  ← Don't dedup prob because costs differ
└────────────────────────────────────────┘
```

**Rationale**: Each segment represents a complete state. If ANY field differs, show the segment colored.

#### 4.2: Different Probabilities, Same Costs
```
┌────────────────────────────────────────┐
│ 40%  50%  60%, £100                    │  ← Cost deduplicated, probs colored
└────────────────────────────────────────┘
```

#### 4.3: Only GBP Cost (No Time Cost)
```
┌────────────────────┐
│ 45%, £100          │  ← Time cost omitted if not defined
└────────────────────┘
```

#### 4.4: Only Time Cost (No GBP Cost)
```
┌────────────────────┐
│ 45%, 2.5d          │  ← GBP cost omitted if not defined
└────────────────────┘
```

#### 4.5: Costs with Stdev
```
┌──────────────────────────────────────────┐
│ 45%, £100 ± £10, 2d ± 0.5d               │  ← Stdev shown for costs too
└──────────────────────────────────────────┘
```

---

### 5. Edge Cases and Special States

#### 5.1: Zero Probability (Dashed Line)
```
┌─────────┐
│  0%     │  ← Black, edge renders as dashed line
└─────────┘
```

#### 5.2: Mixed Zero and Non-Zero
```
┌────────────────────┐
│  0%  50%  (25%)    │  ← First scenario is 0, others not
└────────────────────┘
```

#### 5.3: Very Small Probabilities
```
┌────────────────────┐
│  <1%  2%  (1%)     │  ← Show "<1%" for values < 0.5%
└────────────────────┘
```

#### 5.4: Full Stack (4+ Scenarios)
```
┌────────────────────────────────────────────────┐
│  40%  45%  50%  55%  (48%)                     │  ← No artificial limit
└────────────────────────────────────────────────┘
```

#### 5.5: Many Scenarios, All Identical Except Hidden
```
┌──────────────────────┐
│  45%  (50%)          │  ← 5 visible scenarios deduplicated
└──────────────────────┘
```

#### 5.6: Overlay Edge (Non-Current Layer)
```
[No Label Rendered]
```

**Rationale**: Only the base edge OR 'current' overlay renders labels. All other overlays have `suppressLabel: true`.

---

## Layout Specifications

### Label Container
```css
position: absolute;
transform: translate(-50%, -50%);  /* Center on edge midpoint */
background: white;
padding: 4px 8px;
borderRadius: 4px;
fontSize: 11px;
fontWeight: bold;
boxShadow: 0 2px 4px rgba(0,0,0,0.1);
pointerEvents: auto;  /* Allow double-click to edit */
zIndex: 1000;
```

### Multi-Value Layout
```css
display: flex;
alignItems: center;
gap: 4px;  /* Space between values */
justifyContent: center;
flexWrap: wrap;  /* Wrap if too many values */
```

### Color Palette
- Scenario 1: `#3b82f6` (blue)
- Scenario 2: `#f97316` (orange)  
- Scenario 3: `#8b5cf6` (purple)
- Scenario 4: `#ec4899` (pink)
- Scenario 5: `#14b8a6` (teal)
- Hidden Current: `#999999` (grey)
- Identical/Single: `#000000` (black)

### Background Colors (Special States)
- Case Edge: `#F3F0FF` (light purple)
- Conditional Override: `#f0fdf4` (light green)
- Error State: `#fff5f5` (light red)

---

## Rendering Decision Tree

```
START: Need to render edge label
│
├─ Is suppressLabel true?
│  └─ YES → [Render nothing] END
│  └─ NO → Continue
│
├─ Does compositeLabel exist?
│  └─ NO → [Error: should always exist post-consolidation]
│  └─ YES → Continue
│
├─ Build all segments (always includes at least 'current')
│  ├─ For each visible layer: extract probability, variantWeight, edgeProb, stdev, costs
│  └─ If 'current' not visible: add as hidden segment
│
├─ Separate visible vs hidden segments
│
├─ Check for identical values across visible segments
│  │
│  ├─ Are ALL fields identical? (prob, variant, stdev, cost_gbp, cost_time)
│  │  │
│  │  ├─ YES → Do hidden segments also match?
│  │  │  ├─ YES → Render single black segment (fully deduplicated)
│  │  │  └─ NO → Render single black segment + grey bracketed hidden
│  │  │
│  │  └─ NO → Check per-field deduplication
│  │     ├─ For each field (prob, cost_gbp, cost_time):
│  │     │  ├─ All segments have same value? → Show once in black at end
│  │     │  └─ Values differ? → Show for each segment in color
│  │     │
│  │     └─ Render segments with partial dedup
│  │
│  └─ Format each segment:
│     ├─ If case edge: "{variantName}: {variantWeight}%/{edgeProb}%"
│     ├─ If normal edge: "{probability}%"
│     ├─ Add ± stdev if exists and > 0
│     ├─ Add costs inline: ", £{cost_gbp}, {cost_time}d"
│     └─ Prepend 🔌 if parameter_id exists
│
END
```

### Key Algorithm: Per-Field Deduplication

```typescript
function deduplicateSegments(segments: Segment[]): RenderInstruction {
  const visible = segments.filter(s => !s.isHidden);
  const hidden = segments.filter(s => s.isHidden);
  
  // Check if ALL fields identical across visible
  const allFieldsIdentical = visible.every(s => 
    s.probability === visible[0].probability &&
    s.variantWeight === visible[0].variantWeight &&
    s.edgeProbability === visible[0].edgeProbability &&
    s.stdev === visible[0].stdev &&
    s.cost_gbp === visible[0].cost_gbp &&
    s.cost_time === visible[0].cost_time
  );
  
  if (allFieldsIdentical) {
    // Full deduplication possible
    const hiddenMatches = hidden.every(h => /* h matches visible[0] */);
    if (hiddenMatches) {
      return { type: 'single', segment: visible[0], color: 'black' };
    } else {
      return { 
        type: 'simplified', 
        visible: visible[0], 
        hidden: hidden,
        visibleColor: 'black' 
      };
    }
  }
  
  // Partial deduplication: check per field
  const probsIdentical = visible.every(s => s.probability === visible[0].probability);
  const costsGbpIdentical = visible.every(s => s.cost_gbp === visible[0].cost_gbp);
  const costsTimeIdentical = visible.every(s => s.cost_time === visible[0].cost_time);
  
  return {
    type: 'partial',
    segments: visible,
    hidden: hidden,
    dedupFlags: {
      probability: probsIdentical,
      cost_gbp: costsGbpIdentical,
      cost_time: costsTimeIdentical
    }
  };
}
```

---

## Code Structure (Post-Consolidation)

### Data Structures

```typescript
interface LabelSegment {
  layerId: string;
  
  // Probability info
  probability: number;
  stdev?: number;
  
  // Case edge info (if applicable)
  variantName?: string;
  variantWeight?: number;
  edgeProbability?: number;
  
  // Cost info (inline)
  cost_gbp?: {
    mean?: number;
    stdev?: number;
  };
  cost_time?: {
    mean?: number;
    stdev?: number;
  };
  
  // Parameter connections
  parameter_id?: string;
  cost_gbp_parameter_id?: string;
  cost_time_parameter_id?: string;
  
  // Display info
  color: string;
  isHidden: boolean;
}

interface CompositeLabel {
  segments: LabelSegment[];
  deduplication: {
    type: 'full' | 'simplified' | 'partial' | 'none';
    dedupFlags?: {
      probability: boolean;
      cost_gbp: boolean;
      cost_time: boolean;
    };
  };
}
```

### Helper Functions Location
**File**: `graph-editor/src/components/edges/edgeLabelHelpers.ts`

```typescript
// Extract case edge variant information (name + weight + edge prob)
export function getCaseEdgeVariantInfo(
  edge: any,
  graph: any,
  params?: ScenarioParams
): CaseEdgeInfo | null;

interface CaseEdgeInfo {
  variantName: string;
  variantWeight: number;
  edgeProbability: number;
  caseId: string;
}

// Get complete edge info for a specific layer
export function getEdgeInfoForLayer(
  layerId: string,
  edgeId: string,
  graph: any,
  scenariosContext: any,
  whatIfDSL?: string | null
): LabelSegment;

// Build complete composite label structure
export function buildCompositeLabel(
  edge: any,
  graph: any,
  scenariosContext: any,
  activeTabId: string,
  tabs: TabState[],
  whatIfDSL?: string | null
): CompositeLabel;

// Analyze segments and determine deduplication strategy
export function analyzeDeduplication(
  segments: LabelSegment[]
): CompositeLabel['deduplication'];

// Format a single segment as string
export function formatSegmentValue(
  segment: LabelSegment,
  includePlugIcon: boolean
): string;

// Example outputs:
// - "🔌 45%"
// - "treatment: 25%/100% ± 5%"
// - "45%, £100, 2.5d"
// - "🔌 treatment: 20%/90%, 🔌 £150 ± £10"

// Render composite label to React nodes
export function renderCompositeLabel(
  label: CompositeLabel,
  onDoubleClick?: () => void
): React.ReactNode;
```

### Main Component (Simplified)
```typescript
// In ConversionEdge.tsx
const compositeLabel = useMemo(() => {
  return buildCompositeLabel(
    fullEdge,
    graph,
    scenariosContext,
    activeTabId,
    tabs,
    whatIfDSL
  );
}, [fullEdge, graph, scenariosContext, activeTabId, tabs, whatIfDSL]);

return (
  <>
    {/* Edge path rendering */}
    <EdgeLabelRenderer>
      {!data?.suppressLabel && compositeLabel && (
        renderCompositeLabel(compositeLabel, handleDoubleClick)
      )}
    </EdgeLabelRenderer>
  </>
);
```

---

## Testing Matrix

### Test Categories

#### Unit Tests (Helper Functions)
- [ ] `getCaseEdgeVariantInfo()` with various edge types
- [ ] `getEdgeProbabilityForLayer()` for each layer type
- [ ] `formatProbabilityValue()` with edge cases (0, <1%, large stdev)
- [ ] `buildCompositeLabel()` with different scenario configurations

#### Integration Tests (Full Rendering)
- [ ] Single layer visible, normal edge
- [ ] Single layer visible, case edge
- [ ] Multiple identical values → single black label
- [ ] Multiple different values → colored labels
- [ ] Hidden current matching → no brackets
- [ ] Hidden current differing → grey brackets
- [ ] Zero probability → dashed line + 0% label
- [ ] Missing probability → error state
- [ ] Cost rendering below probability
- [ ] Parameter connection icons

#### Visual Regression Tests
- [ ] Screenshot comparison for each rendering scenario
- [ ] Layout doesn't break with long variant names
- [ ] Multi-value labels wrap correctly
- [ ] Colors match design system

---

## Migration Validation

### Before/After Comparison

| Scenario | Before (Current) | After (Consolidated) | Status |
|----------|------------------|---------------------|---------|
| No scenarios, normal edge | `45%` (black) | `45%` (black) | ✅ Same |
| No scenarios, case edge | `25%` + "control" (purple) | `25%/100%` (purple) | ⚠️ **Format Change** |
| Single scenario visible | Colored if differs | Black if same, colored+bracketed if differs | ⚠️ **Behavior Change** |
| Multiple identical | Shows all colored | Single black | ✅ **Improvement** |
| Multiple different | Colored labels | Colored labels | ✅ Same |

### Breaking Changes

1. **Case edge format changes** from `25%` (effective) + variant name below to `treatment: 25%/100%` (variant name first, inline)
   - **Old**: Two lines, effective probability only
   - **New**: One line, shows multiplication components

2. **Parameter connection icon** changes from ⛓️ (chain) to 🔌 (plug)
   - **Rationale**: Plug is more intuitive for connections

3. **Costs move inline** from below probability to comma-separated on same line
   - **Old**: Probability on line 1, costs on lines 2-3
   - **New**: `45%, £100, 2.5d` all on one line

4. **Unified rendering** eliminates "simple" mode - always uses composite label system
   - **Impact**: Single-layer view looks identical, but uses same code path as multi-layer

5. **Smart deduplication** shows single black label when all scenarios identical
   - **Old**: Could show `45%` or colored labels inconsistently  
   - **New**: Always shows `45%` (black) when all identical

**Mitigation**: 
- Update user documentation
- Add rich tooltip on hover explaining format
- Phase 1 roll-out to gather feedback before full deployment

---

## Design Decisions (Answered)

1. **Case Edge Format**: ✅ Always show `variantName: variantWeight/edgeProb`
   - **Decision**: Yes, always use new format for consistency across all views

2. **Parameter Icon**: ✅ Use plug emoji (🔌) not chain (⛓️)
   - **Decision**: Plug is more intuitive for connections

3. **Costs Inline**: ✅ Show costs comma-separated on same line as probability
   - **Decision**: Simplifies layout, enables per-field deduplication

4. **Unified Rendering**: ✅ One code path for all scenarios
   - **Decision**: Eliminates special cases, uses composite label system universally

## Open Questions (Still To Decide)

1. **Maximum Visible Segments**: Should we cap the number of visible scenario labels (e.g., "45% 50% 55% ... +3 more")?
   - **Recommendation**: No cap initially, add if performance degrades or readability suffers

2. **Tooltip on Hover**: Should hovering show full breakdown of which value belongs to which scenario?
   - **Recommendation**: Yes, add rich tooltip in Phase 3 showing:
     - Scenario name → value mapping
     - Explanation of deduplication
     - "Click to edit" hint

3. **Editing Behavior**: Double-clicking when multiple scenarios visible - which layer gets edited?
   - **Recommendation**: Always edits 'current', show toast/modal explaining this on first double-click

4. **Stdev Display**: Should we show stdev for all segments or only when they differ?
   - **Recommendation**: Show for all segments, allows comparison

5. **Per-Field Deduplication UI**: How to visually indicate partial deduplication (e.g., "40% 50% 60%, £100")?
   - **Option A**: Cost in black at end (current recommendation)
   - **Option B**: Show cost for first segment only
   - **Recommendation**: Option A - clearer that cost applies to all

---

## Performance Considerations

### Computational Cost
- Building composite label: **O(n)** where n = number of visible scenarios (typically 1-5)
- Rendering: **O(n)** React elements per edge label
- Expected impact: **Negligible** (< 1ms per edge)

### Memory Cost
- Composite label structure: ~200 bytes per edge
- For 100 edges: ~20KB total
- Expected impact: **Negligible**

### Optimization Opportunities
1. Memoize `buildCompositeLabel` result (already done via useMemo)
2. Memoize helper function results if called repeatedly
3. Consider virtualization if >1000 edges visible simultaneously

---

## Acceptance Criteria

### Functional
- ✅ All edge types render correctly in all scenario configurations
- ✅ Color coding matches scenario colors
- ✅ Simplification logic works (identical → single label)
- ✅ Hidden current shows in brackets when differing
- ✅ Case edges show both variant weight and edge probability
- ✅ Costs and stdev render below/alongside probability
- ✅ Zero probability edges show "0%" and render dashed

### Non-Functional
- ✅ No visual regressions from current behavior
- ✅ Performance: < 5ms to build label for 100 edges
- ✅ Code: < 500 lines for all label logic (down from ~800)
- ✅ Test coverage: > 80% for label helpers
- ✅ No console errors or warnings

### User Experience
- ✅ Labels remain readable at default zoom
- ✅ Labels don't overlap edges or nodes
- ✅ Double-click to edit still works
- ✅ Hover tooltip shows scenario breakdown (Phase 3)

---

## Appendix: Example Screenshots

### Before Consolidation
```
[Scenario: Base + S1 visible, different values]

Current Implementation:
┌──────────────────────┐
│  45%  50%            │  ← Sometimes renders, sometimes buggy
└──────────────────────┘

Issues:
- Color assignment inconsistent
- Hidden current sometimes missing
- Case edges show wrong format
```

### After Consolidation
```
[Same scenario]

New Implementation:
┌──────────────────────┐
│  45%  50%  (48%)     │  ← Always correct, with hidden current
└──────────────────────┘

Benefits:
- Always consistent
- Hidden current always shown
- Case edges always show full format
```

---

## Related Documents
- [Edge Label Consolidation Analysis](./EDGE_LABEL_CONSOLIDATION_ANALYSIS.md)
- [Scenarios Manager Spec](./current/SCENARIOS_MANAGER_SPEC.md)
- [Edge Rendering Architecture](./current/EDGE_RENDERING_ARCHITECTURE.md)

