# What-If DSL Refactor - Implementation Summary

**Date:** 2025-01-11  
**Status:** ✅ Completed

## Overview

Refactored the what-if analysis system to use a unified DSL (Domain Specific Language) string approach instead of separate `caseOverrides` and `conditionalOverrides` objects. This provides a more flexible, user-friendly interface that supports both dropdown-based selection and manual DSL editing.

## What Was Completed

### 1. DSL Helper Functions (`graph-editor/src/lib/queryDSL.ts`)

Added three new utility functions for manipulating what-if DSL strings:

- **`generateCaseDSL(caseNodeId, variantName, useCaseId)`**
  - Generates DSL string for case variant overrides
  - Format: `case(case_id:variant)` or `case(node_id:variant)`
  - Supports both `case.id` and node UUID/ID formats

- **`augmentDSLWithConstraint(existingDSL, newConstraint)`**
  - Intelligently merges new constraints into existing DSL
  - Handles deduplication of visited/exclude nodes
  - Merges case, context, and visitedAny functions
  - Returns normalized DSL string

- **`removeConstraintFromDSL(dsl, constraintToRemove)`**
  - Removes specific constraints from DSL string
  - Handles visited, exclude, case, and context functions
  - Returns cleaned DSL string

### 2. What-If DSL Parsing (`graph-editor/src/lib/whatIf.ts`)

Added parsing and conversion functions:

- **`parseWhatIfDSL(dsl, graph)`**
  - Converts DSL string to `WhatIfOverrides` object
  - Extracts `case()` functions → `caseOverrides`
  - Extracts `visited()`/`exclude()` functions → `conditionalOverrides`
  - Resolves node references using graph lookup
  - **Purpose:** Backward compatibility - allows DSL to be converted to old format for existing code

- **`convertOverridesToDSL(caseOverrides, conditionalOverrides, graph)`**
  - Converts old override format to DSL string
  - Handles both string and `Set<string>` formats for conditional overrides
  - Resolves case node references
  - **Purpose:** Migration - converts existing data to new DSL format

- **Updated `WhatIfOverrides` type**
  - Added `whatIfDSL?: string | null` field
  - DSL takes precedence if provided (parsed to populate other fields)

- **Updated `computeEffectiveEdgeProbability()`**
  - Now checks for `whatIfDSL` in `whatIfOverrides`
  - If present, parses DSL first to get `effectiveOverrides`
  - All subsequent logic uses `effectiveOverrides` instead of `whatIfOverrides`
  - Maintains backward compatibility with old format

- **Updated `getEdgeWhatIfDisplay()`**
  - Same DSL parsing logic as `computeEffectiveEdgeProbability()`
  - Ensures display labels reflect DSL-based overrides

### 3. WhatIfAnalysisControl Component (`graph-editor/src/components/WhatIfAnalysisControl.tsx`)

Complete refactor of the what-if panel:

- **State Management**
  - Primary source of truth: `whatIfDSL` string from `editorState`
  - Auto-migration: Converts old `caseOverrides`/`conditionalOverrides` to DSL on mount
  - Parses DSL to `parsedOverrides` for backward compatibility with existing code
  - Still exposes `caseOverrides` and `conditionalOverrides` (derived from DSL) for legacy support

- **UI Changes**
  - **Replaced chip display with `QueryExpressionEditor`**
    - Shows DSL string as editable chips
    - Supports manual DSL editing
    - Monaco editor for advanced editing
    - Placeholder: `"case(case_id:treatment).visited(nodea)"`
  
  - **Case Variant Dropdowns**
    - Updated to read from DSL (parses `case()` functions)
    - `onChange` calls `addCaseOverride()` or `removeCaseOverride()`
    - These functions use `generateCaseDSL()` and `augmentDSLWithConstraint()`
    - Updates DSL string directly
  
  - **Conditional Probability Dropdowns**
    - Updated to read from DSL (parses `visited()`/`exclude()` functions)
    - `onChange` calls `addConditionalOverride()` or `removeConditionalOverride()`
    - Uses `augmentDSLWithConstraint()` and `removeConstraintFromDSL()`
    - Updates DSL string directly
  
  - **Clear All Button**
    - Sets `whatIfDSL` to `null`
    - Replaces old chip-based clear logic

- **Helper Functions**
  - `setWhatIfDSL(dsl)` - Updates tab state and syncs with context
  - `addCaseOverride(nodeId, variantName)` - Adds case constraint to DSL
  - `removeCaseOverride(nodeId, variantName)` - Removes case constraint from DSL
  - `addConditionalOverride(condition)` - Adds conditional constraint to DSL
  - `removeConditionalOverride(condition)` - Removes conditional constraint from DSL
  - `clearAllOverrides()` - Clears DSL

### 4. Type Updates (`graph-editor/src/types/index.ts`)

- Added `whatIfDSL?: string | null` to `EditorState` interface
- Marked `caseOverrides` and `conditionalOverrides` as legacy (will be converted to DSL)

## What Was NOT Done

### 1. Context Menu Integration
- **Not Implemented:** Context menus (node/edge) still use old override format
- **Reason:** Context menus were not part of this refactor scope
- **Future Work:** Update context menus to use DSL-based approach

### 2. WhatIfContext Updates
- **Not Fully Updated:** `WhatIfContext` still uses `Set<string>` for conditional overrides
- **Current State:** `WhatIfAnalysisControl` converts DSL to old format for context compatibility
- **Future Work:** Update `WhatIfContext` to support DSL strings directly

### 3. Edge-Specific Conditional Override Mapping
- **Not Implemented:** DSL currently matches conditions globally, not per-edge
- **Current Behavior:** `parseWhatIfDSL()` matches DSL against all edges' conditional_p conditions
- **Limitation:** Cannot have different conditional overrides for different edges with same condition
- **Future Work:** Consider edge-specific DSL mapping if needed

### 4. Context and Case Variant Extraction from DSL
- **Partially Implemented:** DSL parser extracts `context()` and `case()` functions
- **Not Used:** `computeEffectiveEdgeProbability()` doesn't use context/case from DSL yet
- **Future Work:** Extract context and case variants from DSL for evaluation

### 5. Validation and Error Handling
- **Not Implemented:** No validation of DSL syntax in what-if panel
- **Current State:** Relies on `QueryExpressionEditor` validation
- **Future Work:** Add explicit validation and error messages for invalid DSL

### 6. Migration Script
- **Not Implemented:** No batch migration script for existing saved states
- **Current State:** Migration happens on-demand when tab loads
- **Future Work:** Consider batch migration for better performance

### 7. Documentation
- **Not Updated:** User-facing documentation not updated
- **Future Work:** Update user guide with DSL syntax examples

## Technical Details

### DSL Format Examples

```
# Case variant only
"case(case_id:treatment)"

# Conditional probability only
"visited(nodea)"

# Combined
"case(case_id:treatment).visited(nodea).exclude(nodeb)"

# Multiple cases
"case(case_id:treatment).case(case_id:control).visited(nodea)"
```

### Backward Compatibility Strategy

1. **On Mount:** Component checks for `whatIfDSL` first
2. **If Missing:** Converts old `caseOverrides`/`conditionalOverrides` to DSL
3. **Auto-Save:** Saves DSL and clears old format
4. **Runtime:** `whatIf.ts` functions parse DSL if present, fall back to old format

### Performance Considerations

- DSL parsing happens on every render (via `useMemo`)
- Consider memoization if performance issues arise
- Conversion from old format happens once per tab load

## Testing Recommendations

1. **Basic Functionality**
   - [ ] Select case variant from dropdown → DSL updates
   - [ ] Select conditional probability → DSL updates
   - [ ] Clear all → DSL cleared
   - [ ] Manual DSL editing → Graph updates

2. **Backward Compatibility**
   - [ ] Load graph with old override format → Auto-converts to DSL
   - [ ] Old format cleared after conversion
   - [ ] Legacy `whatIfAnalysis` still works

3. **Edge Cases**
   - [ ] Empty DSL string
   - [ ] Invalid DSL syntax
   - [ ] Multiple case variants
   - [ ] Complex conditional constraints

4. **Integration**
   - [ ] What-if probabilities computed correctly
   - [ ] Edge labels show correct overrides
   - [ ] Graph visualization updates

## Files Modified

1. `graph-editor/src/lib/queryDSL.ts` - Added DSL helper functions
2. `graph-editor/src/lib/whatIf.ts` - Added parsing/conversion, updated types
3. `graph-editor/src/components/WhatIfAnalysisControl.tsx` - Complete refactor
4. `graph-editor/src/types/index.ts` - Added `whatIfDSL` field

## Files Created

1. `WHAT_IF_DSL_REFACTOR_PLAN.md` - Initial plan document
2. `WHAT_IF_DSL_REFACTOR_SUMMARY.md` - This document

## Next Steps

1. Test the implementation thoroughly
2. Update `WhatIfContext` to support DSL directly
3. Consider edge-specific DSL mapping if needed
4. Add validation and error handling
5. Update user documentation

