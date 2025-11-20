# Confidence Intervals Display Feature Specification

## Overview

Add visual confidence interval bands to edges that have standard deviation (`stdev`) data. When enabled, edges with statistical uncertainty will display three overlapping bands (upper bound, mean, lower bound) instead of a single edge, providing visual feedback about the uncertainty in probability estimates.

## Requirements

### 1. View Option Management

**Storage Location:**
- Add `confidenceIntervalLevel: 'none' | '80' | '90' | '95' | '99'` to `ViewPreferencesState` interface
- Persist in `TabState.editorState.confidenceIntervalLevel` (per-tab setting)
- Default: `'none'`

**Access Points (All use same code path):**
1. **View Menu** (`ViewMenu.tsx`)
   - Add submenu "Confidence Intervals" with options: 99%, 95%, 90%, 80%, None
   - Only visible for graph tabs (`isGraphTab === true`)
   - Use radio button pattern (single selection)

2. **Tools Panel** (`ToolsPanel.tsx`)
   - Add new collapsible section "Confidence Intervals"
   - Radio button group with same options
   - Only visible when graph tab is active

**Implementation Pattern:**
```typescript
// In ViewPreferencesContext.tsx
interface ViewPreferencesState {
  // ... existing fields
  confidenceIntervalLevel: 'none' | '80' | '90' | '95' | '99';
}

// Shared handler function
const handleConfidenceIntervalChange = (level: 'none' | '80' | '90' | '95' | '99') => {
  if (viewPrefsCtx) {
    viewPrefsCtx.setConfidenceIntervalLevel(level);
  } else if (activeTabId) {
    operations.updateTabState(activeTabId, { confidenceIntervalLevel: level });
  }
};
```

### 2. Confidence Interval Calculation

**When to Apply:**
- Only for edges where `edge.p.stdev` is defined and > 0
- Also applies to conditional probabilities: `edge.conditional_p[i].p.stdev` (if present)
- If `stdev === 0` or undefined, render normally (single edge)

**Calculation:**
For each edge with `stdev`:
1. Get `mean = edge.p.mean` (or `conditional_p[i].p.mean` for conditional)
2. Get `stdev = edge.p.stdev` (or `conditional_p[i].p.stdev` for conditional)
3. Get confidence level multiplier from selected level:
   - 99%: z = 2.576
   - 95%: z = 1.960
   - 90%: z = 1.645
   - 80%: z = 1.282
4. Calculate bounds:
   - `upper = Math.min(1, mean + (z * stdev))`  // Clamp to [0, 1]
   - `lower = Math.max(0, mean - (z * stdev))`  // Clamp to [0, 1]
   - `middle = mean`

**Edge Cases:**
- If `mean + (z * stdev) > 1`: clamp upper to 1.0
- If `mean - (z * stdev) < 0`: clamp lower to 0.0
- If `stdev === 0`: skip confidence intervals, render normally
- If `mean` is undefined: skip confidence intervals, render normally
- If uniform edges scaling = true: skip confidence intervals, render normally

### 3. Edge Rendering Changes

**Current Pipeline:**
- `GraphCanvas.tsx` calculates edge widths via `calculateEdgeWidth()`
- `ConversionEdge.tsx` renders single `<path>` element with `strokeWidth` and `stroke` colour
- Path is calculated using bezier curve from source/target positions

**New Pipeline:**
When `confidenceIntervalLevel !== 'none'` and edge has `stdev`:

1. **Calculate three stroke widths:**
   - Use existing `calculateEdgeWidth()` function with different probability values:
     - `widthUpper = calculateEdgeWidth(edge, edges, nodes)` where `edge.p.mean = upper`
     - `widthMiddle = calculateEdgeWidth(edge, edges, nodes)` where `edge.p.mean = mean` (existing)
     - `widthLower = calculateEdgeWidth(edge, edges, nodes)` where `edge.p.mean = lower`

2. **Render three overlapping paths:**
   - All three paths use **identical** bezier curve (same `edgePath` string)
   - Same source/target positions, same control points
   - Render order (back to front): upper → middle → lower
   - Z-index: lower < middle < upper (so middle appears on top)

3. **Colour Blending - Symmetric Intensity Schema:**
   
   **Design Goals:**
   - **Inner band (a)**: Effective colour = normal edge colour exactly (100% match)
   - **Middle band (b)**: Slightly lighter than inner band
   - **Outer band (c)**: Significantly lighter than middle band
   - **Symmetric deltas**: Intensity differences are symmetric around middle band
   - **Confidence-dependent spread**: Higher confidence = more pronounced spread
   
   **Current Edge Rendering:**
   - Edges use `strokeOpacity: 0.8` (EDGE_OPACITY constant)
   - Edges use `mixBlendMode: 'multiply'` (EDGE_BLEND_MODE constant)
   - Normal edge effective colour: `C × 0.8` (where C is base RGB colour per channel)
   
   **Multiply Blend Math:**
   - Multiply blend: `Result = (source × destination) / 255` per RGB channel
   - With 3 paths using colours `C_a`, `C_b`, `C_c` and opacity `O`:
     - Outer band (only path c): `E_c = C_c × O`
     - Middle band (paths b + c): `E_b = (C_b × O) × (C_c × O) / 255 = C_b × C_c × O² / 255`
     - Inner band (all 3 paths): `E_a = (C_a × O) × (C_b × O) × (C_c × O) / (255²) = C_a × C_b × C_c × O³ / (255²)`
   
   **Solving for Exact Match:**
   - Goal: `E_a = C × 0.8` (match normal edge)
   - Equation: `C_a × C_b × C_c × O³ / (255²) = C × 0.8`
   - Solving: `C_a × C_b × C_c = C × 0.8 × (255²) / O³`
   - With `O = 0.8` (match normal edge opacity): `C_a × C_b × C_c = C × (255²) / (0.8²)`
   - Let `K = (255²) / (C × 0.8²)` = `(255 / (C × 0.8))²`
   - So: `C_a × C_b × C_c = K`
   
   **Symmetric Lightening Factors:**
   - Define base factor: `f = K^(1/3)` (geometric mean)
   - Define spread factor `r` (confidence-dependent, > 1):
     - `C_a = f / r` (inner - darker to compensate for 3 multiplies)
     - `C_b = f` (middle - base)
     - `C_c = f × r` (outer - lighter)
   - Verify: `C_a × C_b × C_c = (f/r) × f × (f×r) = f³ = K` ✓
   
   **Confidence-Dependent Spread (r values):**
   - **99% confidence**: `r = 1.60` (very pronounced - "very slightly" and "very significantly")
   - **95% confidence**: `r = 1.40` (pronounced)
   - **90% confidence**: `r = 1.25` (moderate)
   - **80% confidence**: `r = 1.10` (subtle - closer to linear steps)
   
   **Example Calculation (Gray RGB(153, 153, 153), 95% confidence):**
   - Base colour: `C = 153`
   - Normal edge: `C × 0.8 = 122.4`
   - `K = (255 / (153 × 0.8))² = (255 / 122.4)² ≈ 4.34`
   - `f = K^(1/3) ≈ 1.63`
   - `r = 1.40` (95% confidence)
   - Lightening factors:
     - `C_a = 1.63 / 1.40 ≈ 1.164` → Lighten by 16.4%
     - `C_b = 1.63` → Lighten by 63%
     - `C_c = 1.63 × 1.40 ≈ 2.282` → Lighten by 128.2%
   - Stroke colours (clamped to valid RGB):
     - `C_a = min(255, 153 × 1.164) = 178`
     - `C_b = min(255, 153 × 1.63) = 249`
     - `C_c = min(255, 153 × 2.282) = 255` (clamped)
   - Effective colours after multiply:
     - Inner: `(178 × 0.8) × (249 × 0.8) × (255 × 0.8) / (255²) ≈ 122.4` ✓ (matches normal edge)
     - Middle: `(249 × 0.8) × (255 × 0.8) / 255 ≈ 199.2` (lighter than inner)
     - Outer: `255 × 0.8 = 204` (lighter than middle)
   
   **Implementation:**
   - Calculate `K` and `f` per RGB channel (or use luminance for grayscale)
   - Apply spread factor `r` based on confidence level
   - Lighten base colour: `C_a = C × (f/r)`, `C_b = C × f`, `C_c = C × f × r`
   - Clamp all values to [0, 255]
   - Use `strokeOpacity: 0.8` (same as normal edges)
   - Use `mixBlendMode: 'multiply'` on all three paths
   
   **Note:** The symmetric lightening factors ensure:
   - Inner band matches normal edge exactly (by design)
   - Middle and outer bands are symmetric around the middle
   - Higher confidence levels create more pronounced visual spread

**Implementation Location:**
- Modify `ConversionEdge.tsx` component
- Add conditional rendering logic:
  ```typescript
  const confidenceLevel = viewPrefs?.confidenceIntervalLevel ?? 'none';
  const hasStdev = fullEdge?.p?.stdev !== undefined && fullEdge.p.stdev > 0;
  
  if (confidenceLevel !== 'none' && hasStdev) {
    // Render three paths
  } else {
    // Render single path (existing logic)
  }
  ```

### 4. Conditional Probabilities

**Handling:**
- Each `conditional_p[i]` entry is rendered as a separate edge (existing behavior)
- If `conditional_p[i].p.stdev` exists, apply confidence intervals to that conditional edge
- Each conditional edge gets its own three-band rendering if it has stdev

**Edge Selection:**
- Only edges with `stdev > 0` get confidence bands
- Edges without stdev render normally (single edge)
- Mixed scenario: Some edges show bands, others don't

### 5. Performance Considerations

**Optimization:**
- Only calculate confidence intervals when `confidenceIntervalLevel !== 'none'`
- Cache confidence interval calculations (useMemo)
- Reuse existing `calculateEdgeWidth()` function (don't duplicate logic)
- Render three paths efficiently (minimal DOM overhead)

**ReactFlow Integration:**
- Three paths should be separate `<path>` elements in the same edge group
- Use ReactFlow's edge rendering pipeline (don't bypass)
- Ensure proper z-ordering for visual layering

### 6. Visual Design

**Stroke Widths:**
- Upper band: widest (represents upper bound)
- Middle band: normal width (represents mean)
- Lower band: narrowest (represents lower bound)

**Colour Scheme:**
- Three paths use **different lightened colours** (C_a, C_b, C_c) calculated from base colour
- Lightening factors are symmetric around middle band (f/r, f, f×r)
- Spread factor `r` depends on confidence level (1.10 to 1.60)

**Blend Mode & Opacity:**
- Use `mix-blend-mode="multiply"` on all three paths
- Use `strokeOpacity="0.8"` (same as normal edges)
- Multiply creates natural banding with exact inner match:
  - Outer (single path): Lightest (C_c)
  - Middle (two paths overlap): Medium (C_b blends with C_c)
  - Inner (three paths overlap): Matches normal edge exactly (C_a blends with C_b and C_c)

### 7. Edge Cases & Error Handling

**Missing Data:**
- If `stdev` is undefined: render normally
- If `stdev === 0`: render normally
- If `mean` is undefined: render normally
- If confidence calculation results in invalid values: clamp to [0, 1]

**Edge Selection:**
- Selected edges: Apply confidence intervals to selected state
- Highlighted edges: Apply confidence intervals to highlight colour
- Conditional edges: Apply confidence intervals to conditional colour

**Sankey View:**
- Confidence intervals should work in Sankey view mode
- May need adjustment for ribbon-style rendering
- Test with Sankey layout

### 8. Testing Checklist

- [ ] View option persists across tab switches
- [ ] View option persists across app restarts
- [ ] All three access points (View menu, Tools panel, Edge context menu) work identically
- [ ] Confidence intervals only show for edges with `stdev > 0`
- [ ] Three bands render with correct widths (upper > middle > lower)
- [ ] Three bands use same bezier path
- [ ] Colour blending works correctly (lighter outer, darker inner)
- [ ] Blend mode creates visual band effect
- [ ] Conditional probabilities show confidence intervals
- [ ] Selected edges maintain selection styling
- [ ] Highlighted edges maintain highlight styling
- [ ] Works in Sankey view mode
- [ ] Performance is acceptable with many edges
- [ ] Edge labels/text still render correctly
- [ ] Edge interactions (click, hover) still work

## Implementation Plan

### Phase 1: View Option Infrastructure (1-2 hrs)
1. Add `confidenceIntervalLevel` to `ViewPreferencesState`
2. Add setter to `ViewPreferencesContext`
3. Update `TabState` type definition
4. Add to default tab state

### Phase 2: UI Access Points (2-3 hrs)
1. Add submenu to `ViewMenu.tsx`
2. Add section to `ToolsPanel.tsx`
3. Add submenu to `EdgeContextMenu.tsx`
4. Create shared handler function
5. Test all three access points

### Phase 3: Calculation Logic (1-2 hrs)
1. Create `calculateConfidenceBounds()` utility function
2. Add z-score constants for confidence levels
3. Handle edge cases (clamping, missing data)
4. Unit tests for calculation logic

### Phase 4: Rendering Implementation (4-6 hrs)
1. Modify `ConversionEdge.tsx` to detect confidence interval mode
2. Calculate three stroke widths using existing `calculateEdgeWidth()`
3. Calculate three colours (lighter, normal, darker)
4. Render three overlapping `<path>` elements
5. Apply blend mode
6. Handle conditional probabilities
7. Test rendering in various scenarios

### Phase 5: Polish & Testing (2-3 hrs)
1. Visual refinement (colour blending, opacity)
2. Performance optimization
3. Edge case testing
4. Integration testing
5. Documentation

**Total Estimate: 10-16 hours**

## Technical Notes

### Current Edge Rendering Flow
1. `GraphCanvas.tsx` transforms graph → ReactFlow edges
2. `calculateEdgeWidth()` computes stroke width from probability
3. `ConversionEdge.tsx` renders single `<path>` element
4. Path uses bezier curve from source/target positions
5. Colour computed from conditional/case/selection state

### Proposed Changes
1. Add confidence interval level to view preferences
2. In `ConversionEdge.tsx`, check if edge has `stdev` and level is not 'none'
3. If yes, calculate three probability values (upper, mean, lower)
4. Call `calculateEdgeWidth()` three times with different probabilities
5. Render three `<path>` elements with same `d` attribute but different:
   - `strokeWidth` (upper > middle > lower)
   - `stroke` colour (lighter, normal, darker)
   - `mix-blend-mode="multiply"`
6. Ensure proper z-ordering (lower → middle → upper)

### Colour Blending Implementation

**Symmetric Lightening Schema:**

```typescript
// Constants
const EDGE_OPACITY = 0.8; // Match existing edge opacity
const CONFIDENCE_SPREAD = {
  '99': 1.60,  // Very pronounced
  '95': 1.40,  // Pronounced
  '90': 1.25,  // Moderate
  '80': 1.10   // Subtle
};

// Calculate lightening factors for confidence interval paths
function calculateConfidenceIntervalColours(
  baseColour: string, // e.g., '#999999' or RGB(153, 153, 153)
  confidenceLevel: '80' | '90' | '95' | '99'
): { inner: string; middle: string; outer: string } {
  // Convert hex to RGB
  const rgb = hexToRgb(baseColour);
  const C = rgb.r; // Use same for all channels (or calculate per-channel)
  
  // Calculate K and base factor f
  const K = Math.pow(255 / (C * EDGE_OPACITY), 2);
  const f = Math.pow(K, 1/3);
  
  // Get spread factor for confidence level
  const r = CONFIDENCE_SPREAD[confidenceLevel];
  
  // Calculate lightening factors
  const factor_a = f / r;  // Inner (darkest)
  const factor_b = f;      // Middle (base)
  const factor_c = f * r;  // Outer (lightest)
  
  // Calculate lightened colours (per RGB channel)
  const lightenChannel = (channel: number, factor: number): number => {
    return Math.min(255, Math.round(channel * factor));
  };
  
  const rgb_a = {
    r: lightenChannel(rgb.r, factor_a),
    g: lightenChannel(rgb.g, factor_a),
    b: lightenChannel(rgb.b, factor_a)
  };
  
  const rgb_b = {
    r: lightenChannel(rgb.r, factor_b),
    g: lightenChannel(rgb.g, factor_b),
    b: lightenChannel(rgb.b, factor_b)
  };
  
  const rgb_c = {
    r: lightenChannel(rgb.r, factor_c),
    g: lightenChannel(rgb.g, factor_c),
    b: lightenChannel(rgb.b, factor_c)
  };
  
  return {
    inner: `rgb(${rgb_a.r}, ${rgb_a.g}, ${rgb_a.b})`,
    middle: `rgb(${rgb_b.r}, ${rgb_b.g}, ${rgb_b.b})`,
    outer: `rgb(${rgb_c.r}, ${rgb_c.g}, ${rgb_c.b})`
  };
}

// In JSX:
const colours = calculateConfidenceIntervalColours(edgeColour, confidenceLevel);

<path 
  d={edgePath} 
  stroke={colours.outer}  // Lightest colour
  strokeWidth={widthUpper}
  strokeOpacity={EDGE_OPACITY}
  mixBlendMode="multiply"
/>
<path 
  d={edgePath} 
  stroke={colours.middle}  // Base colour
  strokeWidth={widthMiddle}
  strokeOpacity={EDGE_OPACITY}
  mixBlendMode="multiply"
/>
<path 
  d={edgePath} 
  stroke={colours.inner}  // Darkest colour (compensates for 3 multiplies)
  strokeWidth={widthLower}
  strokeOpacity={EDGE_OPACITY}
  mixBlendMode="multiply"
/>
```

**Result:**
- Inner band effective colour = normal edge colour exactly (100% match)
- Middle band = slightly lighter than inner (symmetric delta)
- Outer band = significantly lighter than middle (symmetric delta)
- Spread controlled by confidence level (r factor)

## Future Enhancements (Out of Scope)

- Per-edge confidence interval settings
- Custom confidence levels (user-defined percentages)
- Animation when toggling confidence intervals
- Tooltip showing exact confidence bounds
- Export confidence intervals to reports
- Confidence intervals for cost parameters (not just probabilities)

