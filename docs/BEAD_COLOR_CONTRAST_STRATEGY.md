# Bead Color Contrast Strategy

## Problem Statement

When multiple scenarios are visible, their colors (pastels/vibrant) are used as **text colors** inside expanded beads. If case variant or conditional_p bead **backgrounds** use similar colors, text becomes illegible.

**Example Problem**:
- Scenario 1 text color: `#EC4899` (Hot Pink - pastel)
- Case variant bead background: `#F472B6` (Pink-400 - similar pastel)
- **Result**: Pink text on pink background = unreadable

## Solution: Darker Defaults for Cases and Conditionals

### Strategy Overview

1. **Case Variants**: Darken case node colors by 30-40% lightness
2. **Conditional_p**: Use darker color palette (600-700 level instead of 400)
3. **User-set Colors**: Auto-darken if too light
4. **Text**: Always white on dark backgrounds

### Implementation Details

#### 1. Case Variant Color Darkening

**Current**: Uses `node.layout.color` directly
**New**: Darken by reducing lightness

```typescript
function darkenCaseColor(color: string): string {
  const hsl = hexToHsl(color);
  // Reduce lightness by 35% (e.g., 70% → 35%)
  hsl.l = Math.max(0.2, hsl.l * 0.65); // Minimum 20% lightness
  return hslToHex(hsl);
}
```

**Benefits**:
- Maintains hue connection to case node
- Ensures dark background for white text
- Works with any user-set case color

#### 2. Conditional_p Dark Color Palette

**Current Palette** (400-level Tailwind):
```typescript
const CONDITIONAL_COLOR_PALETTE = [
  '#4ade80', // green-400 (light)
  '#f87171', // red-400 (light)
  '#fbbf24', // amber-400 (light)
  // ... etc
];
```

**New Dark Palette** (600-700 level):
```typescript
const CONDITIONAL_COLOR_PALETTE_DARK = [
  '#16a34a', // green-600 (dark)
  '#dc2626', // red-600 (dark)
  '#d97706', // amber-600 (dark)
  '#059669', // emerald-600
  '#ea580c', // orange-600
  '#0284c7', // sky-600
  '#db2777', // pink-600
  '#9333ea', // violet-600
  '#ca8a04', // yellow-600
  '#0d9488', // teal-600
  '#e11d48', // rose-600
  '#4f46e5', // indigo-600
];
```

**Benefits**:
- Consistent dark backgrounds
- High contrast with pastel scenario text colors
- Still colorful enough to distinguish conditions

#### 3. User-Set Color Handling

**For Case Variants**:
- Always darken `node.layout.color` before using as bead background
- User sees darker version in bead, but original color still used for node

**For Conditional_p**:
- If user sets `cp.color`, check lightness
- If lightness > 50%, darken to ~30% lightness
- Preserves user intent while ensuring readability

```typescript
function ensureReadableBeadColor(color: string, type: 'case' | 'conditional'): string {
  const hsl = hexToHsl(color);
  
  if (type === 'case') {
    // Case: darken by 35%
    hsl.l = Math.max(0.2, hsl.l * 0.65);
  } else {
    // Conditional: ensure max 30% lightness
    if (hsl.l > 0.3) {
      hsl.l = 0.3;
    }
  }
  
  return hslToHex(hsl);
}
```

### Color Contrast Examples

#### Before (Light Colors)
```
Case Variant Bead:
Background: #F472B6 (Pink-400, light)
Scenario Text: #EC4899 (Hot Pink, similar)
Result: Poor contrast, hard to read
```

#### After (Dark Colors)
```
Case Variant Bead:
Background: #DB2777 (Pink-600, dark) 
Scenario Text: #EC4899 (Hot Pink, light)
Result: High contrast, readable
```

### Text Color Rules

**On Dark Backgrounds** (cases, conditionals):
- Always use white (`#FFFFFF`)
- High contrast guaranteed

**On Normal Param Beads** (dark grey):
- Always use white (`#FFFFFF`)
- Consistent with other dark beads

**Scenario Text Segments** (inside expanded beads):
- Use scenario colors (pastels/vibrant)
- These are text colors, not backgrounds
- Contrast ensured by dark bead backgrounds

### Migration Path

1. **Phase 1**: Update `getConditionalProbabilityColor()` to use dark palette
2. **Phase 2**: Add `darkenCaseColor()` function
3. **Phase 3**: Apply darkening in bead rendering
4. **Phase 4**: Update color picker to show darkened preview for beads

### Testing

**Test Cases**:
1. Case variant with light pink node color + pink scenario text → readable?
2. Conditional_p with light green + green scenario text → readable?
3. User sets very light custom color → auto-darkened?
4. All scenario colors (pastels) → readable on dark backgrounds?

**Success Criteria**:
- WCAG AA contrast ratio ≥ 4.5:1 for all combinations
- White text readable on all case/conditional backgrounds
- Scenario text colors readable on dark backgrounds

---

## Related Files

- `graph-editor/src/lib/conditionalColors.ts` - Update palette
- `graph-editor/src/components/edges/ConversionEdge.tsx` - Apply darkening
- `graph-editor/src/utils/colorUtils.ts` - Add darkening functions

