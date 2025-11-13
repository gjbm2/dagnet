# Scenarios Manager - UX Fixes

## Issues Fixed

### 1. ✅ Color Swatches on Hidden Layers
**Issue**: Color swatches showing assigned colors even when scenarios are hidden.

**Fix**: Only show assigned color when visible, show grey (#cccccc) when hidden.
```typescript
const displayColor = isVisible ? assignedColor : '#cccccc';
```

Applied to:
- Current layer
- Base layer  
- All user scenarios

---

### 2. ✅ Current Layer Color (Single Visible Scenario)
**Issue**: Current showing blue color swatch (#4A90E2) even when it's the only visible layer.

**Fix**: Use color from `colorMap` which applies grey for single visible scenario.
```typescript
backgroundColor: currentVisible 
  ? (colorMap.get('current') || '#808080')  // Use assigned color (grey if alone)
  : '#cccccc'  // Grey when hidden
```

The `ColorAssigner` already handles this:
- 1 visible → grey (#808080)
- 2 visible → complementary colors
- N visible → distributed hues

---

### 3. ✅ Edit vs Open Icons
**Issue**: 
- Edit2 (pencil) was opening the modal
- No separate rename action
- Confusing UX (double-click to rename was hidden)

**Fix**:
- **Pencil icon** (`<Pencil>`) → Rename (click to edit name inline)
- **FileText icon** (`<FileText>`) → Open in editor modal
- Removed double-click to rename
- Clear tooltips for each action

**Icon order** (left to right):
1. Eye/EyeOff - Toggle visibility
2. Pencil - Rename
3. FileText - Open in editor
4. Trash - Delete

---

### 4. ✅ Monaco Dark Mode
**Issue**: Monaco editor showing in dark theme (theme="vs-dark")

**Fix**: Changed to light theme
```typescript
theme="vs"  // Light theme, matches app
```

This reuses the standard VS Code light theme and needs no custom CSS.

---

## CSS Review & Minimization

### What CSS Was Kept (Necessary)

**ScenariosPanel.css** (~300 lines):
- Layout-specific: `.scenarios-panel`, `.scenarios-list`, `.scenario-row`
- Component-specific: `.scenario-drag-handle`, `.scenario-color-swatch`
- Interaction states: drag-over, dragging, disabled
- Dropdown menu positioning

All of this is **specific to the scenarios feature** and cannot reuse existing classes.

**ScenarioEditorModal.css** (~165 lines):
- Extends Modal.css (existing)
- Metadata panel layout
- Editor controls (format toggles)
- Validation message styling

Most of this **extends existing modal patterns** and adds scenario-specific layouts.

### What CSS Reuses Existing Patterns

✅ **Modal structure**: Uses existing `modal-overlay`, `modal-container`, `modal-header`, `modal-body`, `modal-footer`

✅ **Colors & spacing**: Uses app-standard colors:
- Greys: #F9FAFB, #F3F4F6, #E5E7EB, #D1D5DB, #9CA3AF, #6B7280, #374151
- Blues: #3B82F6, #2563EB, #DBEAFE, #60A5FA
- Reds: #FEE2E2, #EF4444, #DC2626
- Standard border-radius: 4px, 6px, 8px

✅ **Scrollbar styling**: Reuses WhatIfPanel pattern

✅ **Button states**: Standard hover/active/disabled patterns

### Verdict: CSS is Minimal ✅

The custom CSS is **necessary and appropriate** for this feature. It:
- Follows existing app patterns and color system
- Reuses Modal.css base classes
- Doesn't duplicate existing utilities
- Provides feature-specific layouts that don't exist elsewhere

No CSS needs to be removed.

---

## Summary of All Changes

### Files Modified:
1. **ScenariosPanel.tsx**
   - Fixed color swatches to show grey when hidden
   - Changed icons: Pencil for rename, FileText for open
   - Fixed Current/Base color swatches to use colorMap

2. **ScenarioEditorModal.tsx**
   - Changed Monaco theme from "vs-dark" to "vs" (light)

3. **CSS Files**
   - Reviewed: Minimal and necessary, no changes needed

### Testing Checklist:
- [ ] Color swatches grey when scenario hidden
- [ ] Color swatches show assigned color only when visible
- [ ] Current shows grey when it's the only visible layer
- [ ] Pencil icon edits name inline
- [ ] FileText icon opens modal
- [ ] Monaco editor shows in light theme
- [ ] All icons have clear tooltips

