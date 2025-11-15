# Bead-Based Edge Label System - Design Specification

**Version**: 1.0  
**Status**: Design Proposal  
**Last Updated**: 2025-01-XX

---

## Executive Summary

Replace floating text labels on edges with an interactive bead-based system. Each edge parameter (probability, costs, variants, conditional probabilities) is represented as a colored bead that can expand to show detailed information. This eliminates label collision detection overhead and provides a cleaner, more scalable visualization.

### Key Innovations

1. **Beads Instead of Labels**: Each parameter type gets its own bead positioned along the edge spline
2. **Expandable Beads**: Click to toggle between collapsed (circle) and expanded (lozenge with text)
3. **Smart Defaults**: Normal params expanded by default, conditional_p collapsed
4. **Per-Parameter Beads**: Separate beads for p, cost_gbp, cost_time, variants, conditional_p
5. **No Collision Detection**: Beads positioned along spline eliminate need for collision avoidance
6. **Multi-Scenario Support**: Beads can show values from multiple visible scenarios

### Impact

- **Performance**: Eliminates ~200 lines of collision detection code
- **UX**: More intuitive inspection of edge parameters
- **Scalability**: Works with any number of scenarios without visual clutter
- **Consistency**: All parameters use same interaction model

---

## Design Principles

1. **Beads Start at Edge Beginning**: All beads positioned from visible start of edge (after chevron)
2. **Order Matters**: Normal params → Case variants → Conditional probabilities
3. **Expandable by Default**: Normal params and variants expanded, conditional_p collapsed
4. **Click to Toggle**: Any bead can be expanded/collapsed independently
5. **Text Follows Spline**: Expanded beads show text that curves along the edge path
6. **Color Coding**: Normal params = dark grey, variants/conditional_p = scenario colors

---

## Bead Types and Order

### Bead Sequence (Left to Right Along Spline)

1. **Probability Bead** (`p`)
   - **Default**: Expanded
   - **Color**: Dark grey (`#4A5568`) with white text
   - **Expanded Text**: `50% ± 5%` (or just `50%` if no stdev)
   - **Collapsed**: 16px dark grey circle

2. **Cost GBP Bead** (`cost_gbp`) - *if present*
   - **Default**: Expanded
   - **Color**: Dark grey (`#4A5568`) with white text
   - **Expanded Text**: `£125.50 ± £10` (or just `£125.50`)
   - **Collapsed**: 16px dark grey circle

3. **Cost Time Bead** (`cost_time`) - *if present*
   - **Default**: Expanded
   - **Color**: Dark grey (`#4A5568`) with white text
   - **Expanded Text**: `2.5d ± 0.5d` (or just `2.5d`)
   - **Collapsed**: 16px dark grey circle

4. **Case Variant Bead** - *if edge has case_variant*
   - **Default**: Expanded
   - **Color**: Case node color (from `node.layout.color`)
   - **Expanded Text**: `treatment: 25%` (variant name + weight)
   - **Collapsed**: 16px circle in case color

5. **Conditional Probability Beads** - *one per conditional_p entry*
   - **Default**: Collapsed
   - **Color**: Per-condition color (from `cp.color` or generated)
   - **Expanded Text**: `visited(promo): 30%` (condition string + probability)
   - **Collapsed**: 16px circle in condition color

---

## Bead States

### Collapsed State
- **Shape**: Circle, 16px diameter
- **Visual**: Solid color fill, 2px white border, shadow
- **Interaction**: Click to expand
- **Tooltip**: Hover shows full information

### Expanded State
- **Shape**: Lozenge/pill (rounded rectangle)
- **Visual**: 
  - Background: Same color as collapsed state
  - Text: White (for dark grey) or black (for light colors)
  - Padding: 4px horizontal, 2px vertical
  - Border: 2px white
  - Shadow: `0 2px 4px rgba(0,0,0,0.3)`
- **Text Layout**: Text curves along the spline (SVG textPath)
- **Interaction**: Click to collapse
- **Min Width**: Enough for text + padding
- **Max Width**: 120px (wrap text if longer)

---

## Multi-Scenario Handling

### Single Visible Scenario
- Show beads for that scenario's values
- Normal param beads: Dark grey
- Variant/conditional beads: Scenario color

### Multiple Visible Scenarios

**Option A: Perpendicular Stacking** (Recommended)
- Each scenario gets its own set of beads
- Beads offset perpendicular to spline (like current conditional_p beads)
- **Spacing**: 20px perpendicular offset between scenario rows
- **Visual**: 
  ```
  Edge spline →
  
  [p] [£] [t] [variant] [cond1] [cond2]  ← Scenario 1 (blue)
   [p] [£] [t] [variant] [cond1]         ← Scenario 2 (orange)
    [p] [£] [t] [variant]                ← Scenario 3 (purple)
  ```

**Option B: Sequential Along Spline**
- All scenarios' beads in sequence along the spline
- **Problem**: Very long edges, hard to distinguish which bead belongs to which scenario
- **Not Recommended**: Too cluttered

**Option C: Only Current Layer**
- Show beads only for 'current' layer
- User can switch which layer is shown (future enhancement)
- **Not Recommended**: Loses multi-scenario comparison

### Recommendation: Option A (Perpendicular Stacking)

**Implementation**:
- For each visible scenario, render a complete set of beads
- Offset perpendicular to spline: `offsetY = scenarioIndex * 20px`
- Use scenario color for variant/conditional beads
- Normal param beads always dark grey (they represent the same parameter across scenarios)

**Deduplication**:
- If all scenarios have identical values for a parameter, show only one bead (dark grey)
- If values differ, show beads for each scenario (colored)

---

## Positioning and Layout

### Base Position
- **Start**: Visible edge start (after chevron) + `CONST_MARKER_DISTANCE` (12px)
- **Spacing**: `BEAD_SPACING` (18px) between beads along spline
- **Method**: Use `path.getPointAtLength(distance)` to position along actual Bezier curve

### Perpendicular Offset (NOT USED)
- **Note**: Multi-scenario values shown as colored text within single bead position
- **No perpendicular stacking needed** - all scenarios' values shown in same bead

### Expanded Text Positioning
- **Method**: Use SVG `<textPath>` element
- **Path**: Same Bezier path as edge
- **Start**: Bead center position
- **Length**: Text width + padding
- **Curvature**: Text follows spline curvature

---

## Interaction Model

### Click Behavior
- **Collapsed Bead**: Expands to show text
- **Expanded Bead**: Collapses to circle
- **State Persistence**: Per-edge, per-bead type (stored in component state)
- **Default States**: 
  - Normal params: Expanded
  - Variants: Expanded
  - Conditional_p: Collapsed

### Hover Behavior
- **Collapsed**: Show tooltip with full information
- **Expanded**: No tooltip (information already visible)

### Double-Click Behavior
- **Future**: Could open properties panel for that parameter
- **Current**: No-op (preserve existing double-click-to-edit-edge behavior)

---

## Visual Specifications

### Collapsed Bead
```css
width: 16px;
height: 16px;
border-radius: 50%;
background: [bead color];
border: 2px solid white;
box-shadow: 0 2px 4px rgba(0,0,0,0.3);
cursor: pointer;
transition: transform 0.2s ease;
```

### Expanded Bead (Lozenge)
```css
min-width: [text width + 8px];
max-width: 200px; /* Wider to accommodate multi-scenario text */
height: auto; /* Allow height to grow for wrapped text */
min-height: 20px;
border-radius: 10px;
background: [bead color];
border: 2px solid white;
box-shadow: 0 2px 4px rgba(0,0,0,0.3);
padding: 4px 6px;
cursor: pointer;
transition: all 0.2s ease;
```

### Text in Expanded Bead
```css
font-size: 11px;
font-weight: bold;
white-space: nowrap;
overflow: hidden;
text-overflow: ellipsis;
```

### Multi-Scenario Text Segments
```css
/* Single value (all identical) */
color: #000000; /* black */

/* Multiple values (differ) */
/* Each segment wrapped in <span> with scenario color */
.segment-scenario-1 { color: #3b82f6; } /* blue */
.segment-scenario-2 { color: #f97316; } /* orange */
.segment-scenario-3 { color: #8b5cf6; } /* purple */
/* etc. */

/* Hidden current (in brackets) */
.segment-hidden-current {
  color: rgba(153, 153, 153, 0.5); /* grey, 50% opacity */
}
```

### Expanded Bead Text Format

#### Probability Bead
- **Format (single/identical)**: `50% ± 5%` or `50%`
- **Format (multi-scenario, differ)**: `50% 25% 50%` (colored segments)
- **Format (with hidden current)**: `50% 25% (50%)` (grey brackets for hidden)
- **Stdev**: Only shown if present and > 0
- **Precision**: 1 decimal place for percentage, 1 decimal for stdev

#### Cost GBP Bead
- **Format (single/identical)**: `£125.50 ± £10` or `£125.50`
- **Format (multi-scenario, differ)**: `£100 £150 £120` (colored segments)
- **Format (with hidden current)**: `£100 £150 (£120)` (grey brackets)
- **Currency**: Always show £ symbol
- **Precision**: 2 decimal places

#### Cost Time Bead
- **Format (single/identical)**: `2.5d ± 0.5d` or `2.5d`
- **Format (multi-scenario, differ)**: `2d 3d 2.5d` (colored segments)
- **Format (with hidden current)**: `2d 3d (2.5d)` (grey brackets)
- **Units**: Show appropriate unit (d=days, h=hours, etc.)
- **Precision**: 1 decimal place

#### Case Variant Bead
- **Format (single/identical)**: `treatment: 25%`
- **Format (multi-scenario, differ)**: `treatment: 20% 25% 30%` (colored weights)
- **Format (with hidden current)**: `treatment: 20% 25% (30%)` (grey brackets)
- **Components**: Variant name + weight percentages (colored if differ)
- **Rationale**: Matches current label format, extends to multi-scenario

#### Conditional Probability Bead
- **Format (single/identical)**: `visited(promo): 30%`
- **Format (multi-scenario, differ)**: `visited(promo): 30% 25% 35%` (colored probs)
- **Format (with hidden current)**: `visited(promo): 30% 25% (35%)` (grey brackets)
- **Components**: Condition string (simplified) + probabilities (colored if differ)
- **Simplification**: Show readable version of condition DSL
  - `visited(promo)` → `visited(promo)`
  - `context(device:mobile)` → `mobile`
  - `visited(a).exclude(b)` → `a not b`

#### Hidden Current Brackets
- **When**: 'current' layer is not visible but differs from visible values
- **Format**: `visible_values (hidden_current_value)` 
- **Style**: Bracketed text in grey (`#999999`) with 50% opacity (`rgba(153, 153, 153, 0.5)`)
- **Rationale**: Consistent with current label system (Rule 5), useful for comparison

### Color Palette
- **Normal Params**: `#4A5568` (dark grey)
- **Case Variants**: Darkened case node color (see darkening strategy below)
- **Conditional_p**: Dark color palette (see dark palette below)
- **Text on Dark Grey**: White (`#FFFFFF`)
- **Text on Dark Colors**: White (`#FFFFFF`)
- **Scenario Colors**: Pastel/vibrant (used as text color in expanded beads)
- **Hidden Current Text**: `rgba(153, 153, 153, 0.5)` (grey, 50% opacity)

### Color Contrast Strategy

**Problem**: Scenario colors (pastels) used as text color may clash with case/conditional bead backgrounds.

**Solution**: Use darker colors for case variants and conditional_p beads to ensure contrast.

#### Case Variant Colors
- **Source**: `node.layout.color` (user-set or default)
- **Strategy**: Darken by 30-40% lightness reduction
- **Result**: Darker background ensures white text is readable, even when scenario text colors are similar

#### Conditional_p Colors
- **Default Palette**: Use darker Tailwind 600-700 level colors instead of 400 level
- **User-set Colors**: Darken user-set colors (`cp.color`) by 30-40% if too light
- **Result**: Consistent dark backgrounds for all conditional beads

#### Dark Conditional Color Palette
```typescript
const CONDITIONAL_COLOR_PALETTE_DARK = [
  '#16a34a', // green-600 (was green-400)
  '#dc2626', // red-600 (was red-400)
  '#d97706', // amber-600 (was amber-400)
  '#059669', // emerald-600 (was emerald-400)
  '#ea580c', // orange-600 (was orange-400)
  '#0284c7', // sky-600 (was sky-400)
  '#db2777', // pink-600 (was pink-400)
  '#9333ea', // violet-600 (was violet-400)
  '#ca8a04', // yellow-600 (was yellow-400)
  '#0d9488', // teal-600 (was teal-400)
  '#e11d48', // rose-600 (was rose-400)
  '#4f46e5', // indigo-600 (was indigo-400)
];
```

#### Color Darkening Function
```typescript
function darkenColor(color: string, amount: number = 0.35): string {
  // Convert hex to HSL
  // Reduce lightness by amount (0-1)
  // Convert back to hex
  // Ensures readable contrast with pastel scenario text colors
}
```

---

## State Management

### Per-Edge Bead State
```typescript
interface BeadState {
  // Map of bead type -> expanded/collapsed
  probability: boolean;      // default: true
  cost_gbp: boolean;         // default: true
  cost_time: boolean;        // default: true
  variant: boolean;          // default: true
  conditional_p: boolean[];  // default: [false, false, ...] (one per condition)
}
```

### Storage
- **Component State**: `useState<Map<string, BeadState>>()` keyed by edge ID
- **Persistence**: Could persist to tab state (future enhancement)
- **Reset**: All beads reset to defaults on edge selection change

---

## Implementation Plan

### Phase 1: Remove Labels, Add Basic Beads
1. Remove `EdgeLabelRenderer` and all label rendering code
2. Remove collision detection code (~200 lines)
3. Add basic bead rendering (collapsed only)
4. Position beads along spline using existing marker logic

### Phase 2: Expandable Beads
1. Add state management for expanded/collapsed
2. Implement expanded lozenge shape
3. Add text rendering in expanded beads
4. Implement click-to-toggle

### Phase 3: Multi-Scenario Support
1. Extend bead text rendering to show multiple scenario values
2. Implement colored text segments within expanded beads
3. Add deduplication logic (identical values → single black text)
4. Color coding matches scenario colors from visibleColorOrderIds

### Phase 4: Polish
1. Smooth animations for expand/collapse
2. SVG textPath for curved text
3. Tooltips for collapsed beads
4. Performance optimization

---

## Code Structure

### New Component: `EdgeBeads.tsx`
```typescript
interface EdgeBeadProps {
  edgeId: string;
  edge: GraphEdge;
  path: SVGPathElement;
  visibleScenarios: string[];
  visibleColorOrderIds: string[];
  scenariosContext: ScenariosContext;
  whatIfDSL?: string | null;
}

export function EdgeBeads(props: EdgeBeadProps): React.ReactNode {
  // Build bead definitions for 'current' layer only
  // Extract values from all visible scenarios
  // Render single bead position with multi-colored text
  // Handle click to toggle expansion
}
```

### Bead Definition
```typescript
interface BeadDefinition {
  type: 'probability' | 'cost_gbp' | 'cost_time' | 'variant' | 'conditional_p';
  
  // Multi-scenario values
  values: {
    scenarioId: string;
    value: number | string;
    color: string; // scenario color
  }[];
  
  // Hidden current value (if 'current' not visible but differs)
  hiddenCurrent?: {
    value: number | string;
  };
  
  // Display
  displayText: React.ReactNode; // Colored segments + optional grey brackets
  allIdentical: boolean; // true if all visible scenarios have same value
  
  // Position
  distance: number; // along spline from visible start
  expanded: boolean;
  index: number; // for ordering along spline
}
```

---

## Migration from Labels

### What Gets Removed
- `EdgeLabelRenderer` component usage
- `buildCompositeLabel()` function (or repurpose for bead data)
- `renderCompositeLabel()` function
- Collision detection code (`adjustedLabelPosition`, `checkCollisions`)
- Label positioning logic

### What Gets Added
- `EdgeBeads` component
- Bead state management
- Expanded bead rendering with text
- Per-scenario bead generation

### What Gets Repurposed
- `edgeLabelHelpers.tsx` → `edgeBeadHelpers.tsx`
  - Keep data extraction logic
  - Remove rendering logic
  - Add bead definition builders

---

## Testing Strategy

### Unit Tests
- Bead positioning along spline
- Perpendicular offset calculation
- Expanded/collapsed state toggling
- Multi-scenario bead generation
- Deduplication logic

### Visual Tests
- Single scenario: All beads visible
- Multiple scenarios: Perpendicular stacking
- Expanded beads: Text readability
- Edge cases: Very long edges, many scenarios

### Performance Tests
- 100 edges with 5 scenarios each = 500 beads
- Expand/collapse animation smoothness
- No frame drops during interaction

---

## Open Questions

1. **Text Curvature**: Should expanded text follow spline exactly, or stay horizontal?
   - **Recommendation**: Horizontal for readability, slight angle OK

2. **Bead Persistence**: Should expanded state persist across sessions?
   - **Recommendation**: No, reset to defaults on load

3. **Maximum Beads**: Should we limit number of visible beads?
   - **Recommendation**: No limit initially, add if performance issues

4. **Editing**: How to edit parameters when using beads?
   - **Recommendation**: Double-click edge (not bead) opens properties panel

5. **Parameter Connections**: How to show 🔌 icon for connected parameters?
   - **Recommendation**: Small icon overlay on collapsed bead, or prefix in expanded text

---

## Acceptance Criteria

### Functional
- ✅ All parameter types render as beads
- ✅ Beads positioned correctly along spline
- ✅ Expand/collapse works for all bead types
- ✅ Multi-scenario values shown as colored text segments within single bead
- ✅ Default states correct (normal params expanded, conditional_p collapsed)
- ✅ Colors match specification (dark grey for normal params)

### Non-Functional
- ✅ No collision detection code remains
- ✅ Performance: < 5ms to render 100 edges with beads
- ✅ Smooth expand/collapse animations
- ✅ Beads don't overlap nodes or other edges

### User Experience
- ✅ Beads clearly indicate parameter values
- ✅ Expanded beads readable at default zoom
- ✅ Click interaction feels responsive
- ✅ Visual hierarchy clear (normal params vs variants vs conditional)

---

## Related Documents
- [Edge Label Rendering Spec](./EDGE_LABEL_RENDERING_SPEC.md) - *To be updated*
- [Edge Rendering Architecture](./current/EDGE_RENDERING_ARCHITECTURE.md)
- [Scenarios Manager Spec](./current/SCENARIOS_MANAGER_SPEC.md)

