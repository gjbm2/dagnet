# Bead System Design - Key Decisions & Reasoning

## Multi-Scenario Display Strategy

### Problem
When multiple scenarios are visible, we need to show parameter values from each scenario. How should beads display multiple values?

### Selected Approach: Single Bead Position with Multi-Colored Text ✅

**How it works**: 
- Beads render only on 'current' layer (same as today)
- Each expanded bead shows values from all visible scenarios as colored text segments
- Format: `([blue] 50% [pink] 25% [yellow] 50%)` when values differ
- Format: `50%` (black) when all scenarios identical

**Visual**:
```
Edge spline →
[p] [£] [t] [variant] [cond1]  ← Single row of beads on 'current' layer

Expanded [p] bead shows:
"50% 25% 50%" (blue, pink, yellow segments)
```

**Pros**:
- Consistent with current label system behavior
- No perpendicular stacking = cleaner visual
- Easy to compare values (all in same position)
- Scales to any number of scenarios (text segments)
- Maintains single bead per parameter type

**Cons**:
- Text can get long with many scenarios
- Requires careful text formatting/wrapping

**Mitigation**:
- Limit text width, use ellipsis if too long
- Consider showing only first 3-4 scenarios, "+N more" if many
- Use spacing between segments for readability

### Decision: Single Bead with Multi-Colored Text Segments

**Implementation Details**:
- **Bead position**: Single position along spline (on 'current' layer only)
- **Text segments**: Each scenario value shown as colored span within expanded bead
- **Color coding**: 
  - Normal param beads: Dark grey background, colored text segments
  - Variant/conditional beads: Colored background, colored text segments
- **Deduplication**: If all scenarios identical, show single black text
- **Text format**: Space-separated segments: `"50% 25% 50%"` with each segment colored
- **Max scenarios**: No hard limit, but consider truncation if >5 scenarios

---

## Bead Order and Grouping

### Order Along Spline (Left to Right)
1. **Probability** (`p`)
2. **Cost GBP** (`cost_gbp`) - if present
3. **Cost Time** (`cost_time`) - if present
4. **Case Variant** - if present
5. **Conditional Probabilities** - one per `conditional_p` entry

### Reasoning
- **Normal params first**: Most common, most important
- **Costs together**: Related information grouped
- **Variants before conditionals**: Variants are structural (always present if case edge), conditionals are conditional (may vary)
- **Consistent ordering**: Same order regardless of scenario count

### Single Bead Position
All scenarios' values shown within the same bead position. This maintains clean visual hierarchy:
```
[p] [£] [t] [variant] [cond1]  ← Single row, each bead shows all scenarios
```

**Benefit**: Compact visualization, easy to see all values at once, consistent with label system.

---

## Default Expansion States

### Expanded by Default
- **Probability**: ✅ (most important parameter)
- **Cost GBP**: ✅ (if present, important for analysis)
- **Cost Time**: ✅ (if present, important for analysis)
- **Case Variant**: ✅ (identifies which variant this edge represents)

### Collapsed by Default
- **Conditional Probabilities**: ✅ (often many per edge, would clutter if all expanded)

### Reasoning
- **Normal params**: User needs to see values immediately
- **Variants**: Critical for identifying case edges
- **Conditional_p**: Often numerous, can expand on demand

### User Control
- Any bead can be toggled independently
- State persists during interaction session
- Resets to defaults when edge selection changes

---

## Color Scheme

### Normal Parameters (p, cost_gbp, cost_time)
- **Color**: Dark grey (`#4A5568`)
- **Text**: White (`#FFFFFF`)
- **Rationale**: 
  - These are "base" parameters, not scenario-specific
  - Dark grey distinguishes from colorful scenario beads
  - High contrast (white on dark) ensures readability

### Case Variants
- **Color**: Darkened case node color (`darkenColor(node.layout.color, 0.35)`)
- **Text**: Always white (`#FFFFFF`)
- **Rationale**: 
  - Darker background ensures contrast with pastel scenario text colors
  - Maintains visual connection to case node (same hue, darker shade)
  - Consistent white text improves readability

### Conditional Probabilities
- **Color**: Dark color palette (600-700 level Tailwind colors)
- **Text**: Always white (`#FFFFFF`)
- **Rationale**: 
  - Dark backgrounds ensure contrast with pastel scenario text colors
  - Consistent white text improves readability
  - Darker colors distinguish from scenario colors (which are lighter/pastel)

### Color Darkening Strategy
**Problem**: When scenario colors (pastels) are used as text color inside expanded beads, they may clash with case/conditional bead backgrounds.

**Solution**: 
1. **Case variants**: Darken `node.layout.color` by 30-40% lightness
2. **Conditional_p**: Use darker default palette (600-700 level instead of 400)
3. **User-set colors**: Darken `cp.color` if lightness > 50%

**Implementation**:
```typescript
function ensureDarkColor(color: string, minLightness: number = 0.3): string {
  const hsl = hexToHsl(color);
  if (hsl.l > minLightness) {
    hsl.l = minLightness; // Darken to minimum lightness
  }
  return hslToHex(hsl);
}
```

**Result**: All case/conditional beads have dark backgrounds with white text, ensuring readability regardless of scenario text color.

### Multi-Scenario Normal Params
**Question**: How to show normal param values when they differ across scenarios?

**Decision**: **Dark grey bead background, colored text segments**
- Bead background stays dark grey (indicates parameter type)
- Text segments use scenario colors (indicates which scenario has which value)
- Format: `"50% 25% 50%"` where each percentage is colored (blue, pink, yellow)
- If all identical: Single black text `"50%"`

**Rationale**: 
- Maintains visual distinction: dark grey = normal param type
- Colored text = scenario values
- Consistent with label system approach

---

## Expanded Bead Text Format

### Probability Bead
- **Format**: `50% ± 5%` or `50%`
- **Stdev**: Only shown if present and > 0
- **Precision**: 1 decimal place for percentage, 1 decimal for stdev

### Cost GBP Bead
- **Format**: `£125.50 ± £10` or `£125.50`
- **Currency**: Always show £ symbol
- **Precision**: 2 decimal places

### Cost Time Bead
- **Format**: `2.5d ± 0.5d` or `2.5d`
- **Units**: Show appropriate unit (d=days, h=hours, etc.)
- **Precision**: 1 decimal place

### Case Variant Bead
- **Format (single scenario)**: `treatment: 25%`
- **Format (multi-scenario, differ)**: `treatment: 20% 25% 30%` (colored weights)
- **Format (multi-scenario, identical)**: `treatment: 25%` (black)
- **Components**: Variant name + weight percentages (colored if differ)
- **Rationale**: Matches current label format, extends to multi-scenario

### Conditional Probability Bead
- **Format (single scenario)**: `visited(promo): 30%`
- **Format (multi-scenario, differ)**: `visited(promo): 30% 25% 35%` (colored probs)
- **Format (multi-scenario, identical)**: `visited(promo): 30%` (black)
- **Components**: Condition string (simplified) + probabilities (colored if differ)
- **Simplification**: Show readable version of condition DSL
  - `visited(promo)` → `visited(promo)`
  - `context(device:mobile)` → `mobile`
  - `visited(a).exclude(b)` → `a not b`

---

## Text Positioning in Expanded Beads

### Challenge
Expanded beads need to show text that follows the edge spline for readability.

### Options

#### Option A: Horizontal Text ✅ **SELECTED**
- Text stays horizontal, bead rotated slightly to align with spline tangent
- **Pros**: Maximum readability, standard text rendering
- **Cons**: Slight misalignment with spline direction

#### Option B: SVG textPath ❌ **REJECTED**
- Text curves exactly along spline
- **Pros**: Perfect alignment
- **Cons**: Harder to read, complex implementation, performance overhead

#### Option C: Perpendicular to Spline ❌ **REJECTED**
- Text perpendicular to spline (like road signs)
- **Pros**: Always readable
- **Cons**: Looks odd, inconsistent with edge direction

### Decision: Option A (Horizontal Text)
- Rotate bead container by spline tangent angle
- Keep text horizontal within rotated container
- **Angle calculation**: `Math.atan2(dy, dx)` from tangent vector

---

## Deduplication Strategy

### When to Deduplicate
If **all visible scenarios** have **identical values** for a parameter type, show **single black text** instead of colored segments.

### Examples

#### All Scenarios Identical (No Hidden Current)
```
[p]  → Expanded: "50%" (black text, single value)
[£]  → Expanded: "£100" (black text, single value)
```

#### All Scenarios Identical, Hidden Current Differs
```
[p]  → Expanded: "50% (60%)" (black visible, grey hidden)
[£]  → Expanded: "£100 (£120)" (black visible, grey hidden)
```

#### Probabilities Differ, Costs Same
```
[p]  → Expanded: "50% 25% 50%" (blue, pink, yellow segments)
[£]  → Expanded: "£100" (black text, all scenarios same)
```

#### Probabilities Differ, Hidden Current Differs
```
[p]  → Expanded: "50% 25% 50% (60%)" (colored visible, grey hidden)
```

#### All Different
```
[p]  → Expanded: "50% 25% 50%" (colored segments)
[£]  → Expanded: "£100 £150 £120" (colored segments)
[t]  → Expanded: "2d 3d 2.5d" (colored segments)
```

#### All Different with Hidden Current
```
[p]  → Expanded: "50% 25% 50% (60%)" (colored visible, grey hidden)
[£]  → Expanded: "£100 £150 (£120)" (colored visible, grey hidden)
```

### Implementation
```typescript
function formatBeadText(
  values: number[], 
  scenarioColors: string[],
  hiddenCurrent?: number
): React.ReactNode {
  const allIdentical = values.every(v => v === values[0]);
  
  if (allIdentical && !hiddenCurrent) {
    return <span style={{ color: '#000' }}>{formatValue(values[0])}</span>;
  }
  
  const segments: React.ReactNode[] = [];
  
  // Visible scenario values
  values.forEach((value, idx) => {
    segments.push(
      <span key={idx} style={{ color: scenarioColors[idx] }}>
        {formatValue(value)}
      </span>
    );
    if (idx < values.length - 1) {
      segments.push(' ');
    }
  });
  
  // Hidden current in brackets (if present and differs)
  if (hiddenCurrent !== undefined) {
    const visibleAllIdentical = allIdentical && values[0] === hiddenCurrent;
    if (!visibleAllIdentical) {
      segments.push(' (');
      segments.push(
        <span key="hidden" style={{ color: 'rgba(153, 153, 153, 0.5)' }}>
          {formatValue(hiddenCurrent)}
        </span>
      );
      segments.push(')');
    }
  }
  
  return <>{segments}</>;
}
```

### Edge Case: Hidden Current
- If 'current' is hidden but differs from visible values, show it in brackets with 50% alpha grey text
- **Format**: `visible_values (hidden_current_value)`
- **Style**: Bracketed text in `rgba(153, 153, 153, 0.5)` (50% opacity grey)
- **Rationale**: 
  - Consistent with current label system (Rule 5 in EDGE_LABEL_RENDERING_SPEC.md)
  - Useful for comparing visible scenarios against hidden current
  - 50% alpha ensures it's visible but clearly secondary

**Example**:
```
[p] bead expanded: "50% 25% (50%)"
                  (blue) (pink) (grey, 50% alpha)
```

---

## Performance Considerations

### Rendering Cost
- **Beads per edge**: ~3-8 (normal params + variant + conditionals)
- **Scenarios**: 1-5 typically
- **Total beads**: ~5-40 per edge
- **For 100 edges**: ~500-4000 beads

### Optimization Strategies
1. **Memoization**: Cache bead definitions per edge/scenario combination
2. **Virtualization**: Only render beads for visible edges (ReactFlow handles this)
3. **Lazy Expansion**: Only render expanded text when bead is expanded
4. **Debouncing**: Debounce expand/collapse animations

### Expected Performance
- **Initial render**: < 10ms for 100 edges
- **Expand/collapse**: < 5ms per bead
- **No frame drops**: Target 60fps during interaction

---

## Migration Path

### Step 1: Add Beads Alongside Labels
- Keep existing labels
- Add beads as additional visualization
- Allow user to toggle between modes (future)

### Step 2: Make Beads Primary
- Remove labels
- Remove collision detection
- Beads become sole visualization

### Step 3: Enhance Beads
- Add expand/collapse
- Add multi-scenario support
- Polish animations

**Current Plan**: Go straight to Step 2 (remove labels immediately)
- **Rationale**: Cleaner implementation, no intermediate state
- **Risk**: Users need to adapt to new system immediately

---

## Open Questions Resolved

### Q1: Should normal param beads be colored by scenario?
**A**: No, keep dark grey. Color reserved for scenario-specific concepts (variants, conditionals).

### Q2: How to handle many scenarios (10+)?
**A**: No hard limit initially. If performance issues, consider:
- Collapse all beads by default
- Limit visible scenarios
- Virtual scrolling for bead rows

### Q3: Should expanded state persist?
**A**: No, reset to defaults on edge selection change. Keeps UI predictable.

### Q4: How to show parameter connections (🔌 icon)?
**A**: Small icon overlay on collapsed bead, or prefix in expanded text: `🔌 50%`

### Q5: What if edge is very short?
**A**: Beads may overlap. Solutions:
- Reduce bead spacing
- Hide less important beads (costs before probability)
- Show only collapsed beads

---

## Next Steps

1. **Update EDGE_LABEL_RENDERING_SPEC.md** to reflect bead system
2. **Create EdgeBeads component** with basic rendering
3. **Remove label rendering code** from ConversionEdge
4. **Remove collision detection** code
5. **Implement expand/collapse** functionality
6. **Add multi-scenario support** with perpendicular stacking
7. **Test and polish**

