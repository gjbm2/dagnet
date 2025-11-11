# What-If DSL Refactor Plan

## Overview
Refactor what-if panel to use a single DSL string instead of separate `caseOverrides` and `conditionalOverrides` objects. This provides:
- Unified DSL string representation (e.g., `case(case_id:treatment).visited(nodea)`)
- Use existing `QueryExpressionEditor` component for display/editing
- Manual DSL input support
- More sophisticated matching logic using existing DSL parser

## Current State
- `caseOverrides`: `Record<string, string>` (nodeId → variantName)
- `conditionalOverrides`: `Record<string, string | Set<string>>` (edgeId → condition string or Set of visited nodes)
- Display: Separate chips for each override
- Editing: Dropdowns for case variants and conditional probabilities

## Target State
- `whatIfDSL`: `string | null` (single DSL string like `case(case_id:treatment).visited(nodea)`)
- Display: `QueryExpressionEditor` component showing DSL as chips
- Editing: 
  - Dropdowns generate DSL fragments
  - Manual editing via QueryExpressionEditor
  - DSL is normalized and merged intelligently

## DSL Format
- Case variant: `case(case_id:variant_name)` or `case(node_id:variant_name)`
- Conditional: `visited(node_id)` or `visited(node_id).exclude(other_node)`
- Combined: `case(case_id:treatment).visited(nodea).exclude(nodeb)`

## Implementation Steps

### 1. Update Type Definitions
- Add `whatIfDSL?: string | null` to `EditorState` and `WhatIfState`
- Keep backward compatibility: convert old format to DSL on read

### 2. DSL Generation Functions
- `generateCaseDSL(caseNodeId: string, variantName: string): string` → `case(case_id:variant)`
- `augmentDSLWithCondition(dsl: string, condition: string): string` → merges conditions
- `normalizeWhatIfDSL(dsl: string): string` → normalizes and deduplicates

### 3. Update WhatIfAnalysisControl
- Replace separate override objects with single `whatIfDSL` state
- Use `QueryExpressionEditor` for display/editing
- Dropdowns update DSL string instead of separate objects
- Convert old format to DSL on mount (backward compatibility)

### 4. Update whatIf.ts
- `parseWhatIfDSL(dsl: string): { caseOverrides: Record<string, string>, conditionalOverrides: Record<string, string> }`
- Extract case overrides from `case()` functions
- Extract conditional overrides from `visited()`/`exclude()` functions
- Use existing `parseConstraints` and `evaluateConstraint` logic

### 5. Backward Compatibility
- On read: Convert old `caseOverrides`/`conditionalOverrides` to DSL
- On write: Can still support old format during migration
- Migration helper: `convertOverridesToDSL(caseOverrides, conditionalOverrides): string`

## Benefits
- Single source of truth (DSL string)
- Reuses existing QueryExpressionEditor component
- Supports manual DSL editing
- More flexible condition matching
- Easier to serialize/deserialize

