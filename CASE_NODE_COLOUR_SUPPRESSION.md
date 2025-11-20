# Case Node Colour Suppression

**Date**: 2024-11-18  
**Status**: Complete ✅

---

## Problem

Case nodes were displaying bright colours from their `layout.colour` property, making them visually prominent and distracting from the flow of the graph.

---

## Solution

Suppressed case node colours by using neutral gray styling instead of the stored `layout.colour` value.

### Colours Applied

- **Background**: `#F3F4F6` (Tailwind gray-100) - Light neutral gray
- **Border (normal)**: `#D1D5DB` (Tailwind gray-300) - Medium gray
- **Border (selected)**: `#9CA3AF` (Tailwind gray-400) - Darker gray
- **Text**: `#374151` (Tailwind gray-700) - Dark gray for readability
- **Case indicator dot**: `#9CA3AF` (Tailwind gray-400)

### Before

```typescript
// Used bright colours from layout
background: isCaseNode ? (caseNodeColour || '#e5e7eb') : '#fff'
border: isCaseNode ? `2px solid ${caseNodeColour || '#7C3AED'}` : '2px solid #ddd'
colour: isCaseNode && caseNodeColour ? '#fff' : '#333'
```

### After

```typescript
// Neutral gray styling
background: isCaseNode ? '#F3F4F6' : '#fff'
border: isCaseNode ? (selected ? '2px solid #9CA3AF' : '2px solid #D1D5DB') : '2px solid #ddd'
colour: isCaseNode ? '#374151' : '#333'
```

---

## Implementation Details

### File Modified

`graph-editor/src/components/nodes/ConversionNode.tsx`

### Key Changes

1. **Renamed variable** from `caseNodeColour` to `caseNodeColourForBeads`
   - Colour is still stored for potential future use (e.g., in beads)
   - But not applied to the node itself

2. **Replaced all colour references** with neutral grays:
   - Node background (line 359)
   - Node border (line 356)
   - Node text (line 360)
   - SVG path fill (line 471)
   - SVG stroke (line 511)
   - Case indicator dot (line 709)

---

## Preserved Functionality

- ✅ Users can still set case node colours in PropertiesPanel
- ✅ Colours are still stored in `node.layout.colour`
- ✅ Colours can still be used for edge beads/variant visualization (via `caseNodeColourForBeads`)
- ✅ All other node styling intact (selection, errors, shadows, etc.)

---

## Visual Result

### Before
```
┌────────────────────┐
│   Case Node A      │  ← Bright purple (#7C3AED)
│   (treatment)      │
└────────────────────┘

┌────────────────────┐
│   Case Node B      │  ← Bright green (#10B981)
│   (control)        │
└────────────────────┘
```

### After
```
┌────────────────────┐
│   Case Node A      │  ← Neutral gray (#F3F4F6)
│   (treatment)      │
└────────────────────┘

┌────────────────────┐
│   Case Node B      │  ← Neutral gray (#F3F4F6)
│   (control)        │
└────────────────────┘
```

---

## Testing Checklist

- [x] No linter errors
- [ ] Case nodes display in neutral gray
- [ ] Case nodes still show darker border when selected
- [ ] Case node text is readable (gray-700 on gray-100)
- [ ] Case indicator dot is visible (gray-400)
- [ ] Error states still show red border
- [ ] Colour picker in PropertiesPanel still works (even if colour not displayed)
- [ ] Case variant beads can still use the stored colour if needed

---

## Related Changes

This change is part of a broader effort to:
1. Make the graph cleaner and less visually cluttered
2. Focus attention on the flow structure rather than node colours
3. Reserve bright colours for data visualization (scenarios, beads, etc.)

---

## Future Considerations

If we want to bring back subtle colour coding for case nodes:
- Consider very desaturated pastel tints (e.g., 5% opacity of the original colour)
- Or use colour only for the indicator dot
- Or show colour only on hover

Current approach: Maximum visual simplicity for case nodes.

