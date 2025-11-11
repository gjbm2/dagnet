# Conditional Probability Migration Plan

## Executive Summary

**Problem**: Conditional probability format migrated from `condition: {visited: [...]}` to `condition: "visited(...)"` string format, but multiple files still use old format, causing broken functionality.

**Impact**: 
- ⚠️ **CRITICAL**: What-if calculations broken (`whatIf.ts`)
- ⚠️ **HIGH**: Simulation runner broken (`runner.ts`)
- ⚠️ **HIGH**: Graph operations broken (`conditionalReferences.ts`, `EdgeContextMenu.tsx`)

**Solution**: Systematic migration in 10 phases:
1. Generalize DSL parser utility
2. Fix broken files (5 files, priority-ordered)
3. Remove backward compatibility hacks (5 files)
4. Update type system
5. Create data migration script
6. Testing
7. Handle old UI component
8. UpdateManager integration
9. Edge cases and error handling
10. Documentation

**Estimated Time**: 23-35 hours (conservative: 30-35 hours)

**Risk Level**: Medium-High (affects core functionality, but well-scoped)

## Overview

The conditional probability format has been migrated from `condition: {visited: [...]}` to `condition: "visited(...)"` string format (DSL). However, multiple files still use the old format, causing broken functionality. This plan outlines the systematic fix.

## Current State

### Old Format (Deprecated)
```typescript
conditional_p: [{
  condition: { visited: ['node-a', 'node-b'] },  // Structured object
  p: { mean: 0.8 }
}]
```

### New Format (Target)
```typescript
conditional_p: [{
  condition: "visited(node-a, node-b)",  // Query DSL string
  p: { mean: 0.8 }
}]
```

### New Format Capabilities
- `visited(promo)` - simple visitation
- `visited(promo).exclude(cart)` - visitation with exclusions
- `context(device:mobile)` - context checks
- `case(test:treatment)` - case variant checks
- `visited(promo).context(device:mobile).case(test:treatment)` - combinations

## Phase 1: Generalize DSL Parser Utility

**File**: `graph-editor/src/lib/queryDSL.ts` (EXTEND EXISTING)

**Rationale**: DSL parsing is a general capability used across the codebase (queries, conditions, constraints). We should extend the existing `queryDSL.ts` rather than creating condition-specific parsers.

**Current State**:
- `queryDSL.ts` has `parseQueryBasic()` but only handles full queries (requires `from()`/`to()`)
- `buildDslFromEdge.ts` has duplicate `parseQueryString()` function (private, unstructured)
- Python has both `parse_query()` (full) and `_parse_condition()` (constraints-only)

**Goal**: Create unified DSL parser that handles both:
- **Full queries**: `from(a).to(b).visited(c).exclude(d)`
- **Constraint-only (conditions)**: `visited(c).visitedAny(x,y).exclude(d).context(device:mobile).case(test:treatment)`

**Implementation**:

```typescript
// Extend existing queryDSL.ts

/**
 * Parsed constraint components (shared by queries and conditions)
 */
export interface ParsedConstraints {
  visited: string[];
  exclude: string[];
  context: Array<{key: string; value: string}>;
  cases: Array<{key: string; value: string}>;
  visitedAny: string[][];
}

/**
 * Parsed full query (extends constraints with from/to)
 */
export interface ParsedFullQuery extends ParsedConstraints {
  from?: string;
  to?: string;
  // Query-only extended constructs:
  minus: string[][];
  plus: string[][];
  raw: string;
}

/**
 * Parse any DSL string (full query OR constraint-only)
 * 
 * @param dsl - DSL string (e.g., "from(a).to(b).visited(c)" or "visited(c).exclude(d)")
 * @returns Parsed structure with all components
 */
export function parseDSL(dsl: string | null | undefined): ParsedFullQuery {
  if (!dsl || typeof dsl !== 'string') {
    return {
      visited: [], exclude: [], context: [], cases: [], 
      visitedAny: [],
      // query-only fields default when parsing constraint-only
      minus: [],
      plus: [],
      raw: ''
    };
  }
  
  // Extract from/to (may not exist for constraint-only)
  const fromMatch = dsl.match(/from\(([^)]+)\)/);
  const toMatch = dsl.match(/to\(([^)]+)\)/);
  
  // Extract constraints (works for both full queries and conditions)
  const constraints = parseConstraints(dsl);
  
  return {
    ...constraints,
    from: fromMatch?.[1],
    to: toMatch?.[1],
    // Note: minus/plus only meaningful for full queries; leave empty for constraints
    raw: dsl
  };
}

/**
 * Parse constraint-only DSL (no from/to required)
 * Used for conditional probability conditions
 * 
 * @param constraint - Constraint string (e.g., "visited(a,b).exclude(c)")
 * @returns Parsed constraints
 */
export function parseConstraints(constraint: string | null | undefined): ParsedConstraints {
  if (!constraint || typeof constraint !== 'string') {
    return {
      visited: [], exclude: [], context: [], cases: [],
      visitedAny: []
    };
  }
  
  // Extract all constraint types using regex (similar to Python _parse_condition)
  const visited: string[] = [];
  const exclude: string[] = [];
  const context: Array<{key: string; value: string}> = [];
  const cases: Array<{key: string; value: string}> = [];
  const visitedAny: string[][] = [];
  
  // Match visited(...) - can appear multiple times
  const visitedMatches = constraint.matchAll(/visited\(([^)]+)\)/g);
  for (const match of visitedMatches) {
    const nodes = match[1].split(',').map(s => s.trim()).filter(s => s);
    visited.push(...nodes);
  }
  
  // Match exclude(...)
  const excludeMatches = constraint.matchAll(/exclude\(([^)]+)\)/g);
  for (const match of excludeMatches) {
    const nodes = match[1].split(',').map(s => s.trim()).filter(s => s);
    exclude.push(...nodes);
  }
  
  // Match context(key:value)
  const contextMatches = constraint.matchAll(/context\(([^:]+):([^)]+)\)/g);
  for (const match of contextMatches) {
    context.push({ key: match[1].trim(), value: match[2].trim() });
  }
  
  // Match case(key:value)
  const caseMatches = constraint.matchAll(/case\(([^:]+):([^)]+)\)/g);
  for (const match of caseMatches) {
    cases.push({ key: match[1].trim(), value: match[2].trim() });
  }
  
  // Match visitedAny(...)
  const visitedAnyMatches = constraint.matchAll(/visitedAny\(([^)]+)\)/g);
  for (const match of visitedAnyMatches) {
    const nodes = match[1].split(',').map(s => s.trim()).filter(s => s);
    if (nodes.length > 0) {
      visitedAny.push(nodes);
    }
  }
  
  // Note: minus/plus are query-only constructs and are intentionally not parsed for constraints
  return { visited, exclude, context, cases, visitedAny };
}

/**
 * Convenience function: Extract visited node IDs from DSL string
 * Works for both full queries and constraint-only conditions
 */
export function getVisitedNodeIds(dsl: string | null | undefined): string[] {
  return parseDSL(dsl).visited;
}

/**
 * Evaluate if a constraint DSL is satisfied given runtime state
 * 
 * @param constraint - Constraint string (e.g., "visited(a).exclude(b)")
 * @param visitedNodes - Set of visited node IDs
 * @param context - Optional context key-value pairs
 * @param caseVariants - Optional case variant key-value pairs
 * @returns true if constraint is satisfied
 */
export function evaluateConstraint(
  constraint: string,
  visitedNodes: Set<string>,
  context?: Record<string, string>,
  caseVariants?: Record<string, string>
): boolean {
  const parsed = parseConstraints(constraint);
  
  // Check visited nodes (all must be in visitedNodes)
  if (parsed.visited.length > 0) {
    const allVisited = parsed.visited.every(nodeId => visitedNodes.has(nodeId));
    if (!allVisited) return false;
  }
  
  // Check exclude nodes (none should be in visitedNodes)
  if (parsed.exclude.length > 0) {
    const anyExcluded = parsed.exclude.some(nodeId => visitedNodes.has(nodeId));
    if (anyExcluded) return false;
  }
  
  // Check visitedAny (at least one group must have at least one visited node)
  if (parsed.visitedAny.length > 0) {
    const anyGroupSatisfied = parsed.visitedAny.some(group => 
      group.some(nodeId => visitedNodes.has(nodeId))
    );
    if (!anyGroupSatisfied) return false;
  }
  
  // Check context (all must match)
  if (parsed.context.length > 0 && context) {
    const allContextMatch = parsed.context.every(({key, value}) => 
      context[key] === value
    );
    if (!allContextMatch) return false;
  }
  
  // Check cases (all must match)
  if (parsed.cases.length > 0 && caseVariants) {
    const allCasesMatch = parsed.cases.every(({key, value}) => 
      caseVariants[key] === value
    );
    if (!allCasesMatch) return false;
  }
  
  return true;
}

/**
 * Normalize a constraint string (sort nodes, canonicalize)
 * Useful for comparison and deduplication
 */
export function normalizeConstraintString(constraint: string): string {
  const parsed = parseConstraints(constraint);
  const parts: string[] = [];
  
  if (parsed.visited.length > 0) {
    parts.push(`visited(${parsed.visited.sort().join(', ')})`);
  }
  if (parsed.exclude.length > 0) {
    parts.push(`exclude(${parsed.exclude.sort().join(', ')})`);
  }
  if (parsed.context.length > 0) {
    const contextParts = parsed.context
      .sort((a, b) => a.key.localeCompare(b.key))
      .map(({key, value}) => `context(${key}:${value})`);
    parts.push(...contextParts);
  }
  if (parsed.cases.length > 0) {
    const caseParts = parsed.cases
      .sort((a, b) => a.key.localeCompare(b.key))
      .map(({key, value}) => `case(${key}:${value})`);
    parts.push(...caseParts);
  }
  if (parsed.visitedAny.length > 0) {
    const visitedAnyParts = parsed.visitedAny.map(group =>
      `visitedAny(${group.sort().join(', ')})`
    );
    parts.push(...visitedAnyParts);
  }
  
  return parts.join('.');
}
```

**Migration Actions**:
1. Extend `queryDSL.ts` with above functions
2. Update `buildDslFromEdge.ts` to use `parseDSL()` instead of private `parseQueryString()`
3. Update `parseQueryBasic()` to use new `parseDSL()` internally
4. All condition parsing will use `parseConstraints()` or convenience functions
5. Update Monaco/editor configuration to support constraint-only mode (functions limited to: visited, visitedAny, exclude, context, case)
6. Align schemas accordingly (see Phase 4.2)

**Benefits**:
- Single source of truth for DSL parsing
- Reusable across queries, conditions, and future DSL uses
- Consistent with Python implementation
- Eliminates duplicate parsing logic

## Phase 2: Fix Broken Files

### 2.1 EdgeContextMenu.tsx (12 occurrences, HIGH priority)

**Issues**:
- Lines 394-508: Multiple checks for `condition.visited`
- Uses `JSON.stringify(condition.visited.sort())` for comparison
- Skips conditional_p with new format (line 394)

**Fix Strategy**:
1. Import `getVisitedNodeIds` and `normalizeConstraintString` from `queryDSL.ts`
2. Replace all `condition.visited` checks with parser calls
3. Use `getVisitedNodeIds(condition)` for node extraction
4. Use `normalizeConstraintString(condition)` for comparison
5. Remove defensive checks that skip new format

**Key Changes**:
```typescript
// OLD:
if (!condP.condition?.visited || !Array.isArray(condP.condition.visited)) {
  return null;
}
const conditionKey = JSON.stringify(currentCondition.condition.visited.sort());

// NEW:
if (typeof condP.condition !== 'string') {
  console.warn('Old format detected, should be migrated');
  return null; // Or migrate on-the-fly
}
const visitedNodes = getVisitedNodeIds(condP.condition);
const conditionKey = normalizeConstraintString(condP.condition); // Normalized for comparison
```

### 2.2 runner.ts (3 occurrences, HIGH priority)

**Issues**:
- Lines 38-40, 92-94, 110-112: Returns empty array for string format
- Comment says "would need query parser, skip for now"
- This breaks simulation runner

**Fix Strategy**:
1. Import `getVisitedNodeIds` and `evaluateConstraint` from `queryDSL.ts`
2. Replace all occurrences with proper parsing
3. Update `getEffectiveEdgeProbability` to use `evaluateConstraint` for full DSL support

**Key Changes**:
```typescript
// OLD:
const visitedNodeIds = typeof conditionalProb.condition === 'string'
  ? [] // New format - would need query parser, skip for now
  : (conditionalProb.condition as any).visited || [];

// NEW:
const visitedNodeIds = getVisitedNodeIds(conditionalProb.condition);
```

**Advanced**: Update to use `evaluateConstraint` for full DSL evaluation:
```typescript
// Check if condition is satisfied
if (evaluateConstraint(conditionalProb.condition, visitedSet, context, caseVariants)) {
  return conditionalProb.p.mean ?? 0;
}
```

### 2.3 conditionalReferences.ts (4 occurrences, HIGH priority)

**Issues**:
- Lines 145-147, 269-271: Returns empty array for string format
- Breaks reference generation for conditional probabilities

**Fix Strategy**:
1. Import `parseConstraints` and `normalizeConstraintString` from `queryDSL.ts`
2. Replace all occurrences with proper parsing
3. **Extend `generateConditionalReference()` to support full DSL**:
   - Current format: `e.<edge-id>.visited(<nodes>).p.mean`
   - New format: `e.<edge-id>.<normalized-constraint-string>.p.mean`
   - Use `normalizeConstraintString()` to generate stable, canonical reference
   - Examples:
     - `e.edge-id.visited(promo).p.mean`
     - `e.edge-id.visited(promo).exclude(cart).p.mean`
     - `e.edge-id.context(device:mobile).p.mean`
     - `e.edge-id.visited(promo).context(device:mobile).case(test:treatment).p.mean`
4. Update `parseConditionalReference()` to parse the extended format

**Key Changes**:
```typescript
// OLD:
const visitedNodeIds = typeof conditionalProb.condition === 'string'
  ? [] // New format - would need query parser, skip for now
  : (conditionalProb.condition as any).visited || [];

// NEW:
const parsed = parseConstraints(conditionalProb.condition);
const visitedNodeIds = parsed.visited; // For backward compatibility where needed

// For reference generation:
const conditionPart = normalizeConstraintString(conditionalProb.condition);
const reference = `e.${edgeId}.${conditionPart}.p.${param}`;
```

**Reference Format Extension**:
- **Old**: `e.<edge-id>.visited(<nodes>).p.<param>`
- **New**: `e.<edge-id>.<normalized-constraint-string>.p.<param>`
- The constraint string is normalized (sorted, canonicalized) for stability
- Supports all constraint types: `visited()`, `exclude()`, `context()`, `case()`, `visitedAny()`

### 2.4 whatIf.ts (4 occurrences, CRITICAL priority)

**Issues**:
- Lines 118, 146, 226, 253: Checks `condition.visited` directly
- Breaks what-if analysis calculations

**Fix Strategy**:
1. Import `parseConstraints` and `evaluateConstraint` from `queryDSL.ts`
2. Replace all `condition.visited` checks
3. Use `evaluateConstraint` for proper DSL evaluation
4. Support exclude(), context(), case() in what-if analysis

**Key Changes**:
```typescript
// OLD:
if (!conditionalProb?.condition?.visited) continue;
const conditionNodeIds = conditionalProb.condition.visited.map(...);

// NEW:
if (typeof conditionalProb.condition !== 'string') {
  // Handle old format or skip
  continue;
}
const parsed = parseConstraints(conditionalProb.condition);
const conditionNodeIds = parsed.visited;

// For evaluation:
if (evaluateConstraint(conditionalProb.condition, allVisitedNodes, context, cases)) {
  probability = conditionalProb.p?.mean ?? probability;
}
```

### 2.5 ConditionalProbabilitiesSection.tsx (31 occurrences, MEDIUM priority)

**Status**: May be unused (old UI component)

**Action**:
1. Verify if component is rendered (grep for `<ConditionalProbabilitiesSection`)
2. If unused: Extract useful logic, then remove
3. If used: Fix all occurrences using same pattern as above

## Phase 3: Remove Backward Compatibility Hacks

### 3.1 conditionalValidation.ts (lines 19-42)

**Current**: `getVisitedNodeIds()` hack handles both formats

**Fix**:
1. Replace with import from `queryDSL.ts` (`getVisitedNodeIds`)
2. Remove old format handling
3. Update all 7 call sites in file

### 3.2 conditionalColors.ts (line ~90)

**Current**: Handles both formats in `getConditionSignature()`

**Fix**:
1. Remove old format check
2. Use condition string directly (already normalized)

### 3.3 ConversionEdge.tsx (lines 27-50)

**Current**: Duplicate `getVisitedNodeIds()` hack

**Fix**:
1. Remove duplicate function
2. Import `getVisitedNodeIds` from `queryDSL.ts`

### 3.4 WhatIfAnalysisControl.tsx (lines 123-131, 478-491, 543-545)

**Current**: Multiple format checks

**Fix**:
1. Replace with parser calls
2. Remove old format handling

### 3.5 ConditionalProbabilityEditor.tsx (lines 135-140)

**Current**: Display hack for old format

**Fix**:
1. Remove old format handling
2. Always use string format

## Phase 4: Type System Updates

### 4.1 Update Type Definitions

**File**: `graph-editor/src/types/index.ts`

**Current**:
```typescript
export interface ConditionalProbability {
  condition: Condition | string; // Union type
  ...
}
```

**Target**:
```typescript
export interface ConditionalProbability {
  condition: string; // String only - DSL format
  ...
}
```

**Action**:
1. Remove `Condition` interface if no longer needed
2. Update `ConditionalProbability.condition` to `string` only
3. Update schema validation

### 4.2 Schema Updates

**File**: `graph-editor/public/schemas/conversion-graph-1.0.0.json`

**Verify**: Schema already defines Condition as string type (line 292-304)

**Actions**:
1. Ensure no references to old object format remain
2. Update `Condition` pattern to include `visitedAny` and explicitly exclude query-only functions:
   - Pattern should support: `visited(...)`, `visitedAny(...)`, `exclude(...)`, `context(...)`, `case(...)`
   - Do NOT include: `minus(...)`, `plus(...)` in `Condition` strings
3. Update examples to show constraint-only strings (including `visitedAny`)

## Phase 5: Data Migration Script

**File**: `scripts/migrate-conditional-probabilities.ts` (NEW)

**Purpose**: One-time migration of graph files from old to new format

**Functionality**:
1. Scan all `.json` graph files in project
2. Find all `conditional_p` arrays
3. Convert `condition: {visited: [...]}` → `condition: "visited(...)"`
4. Validate conversion (no data loss)
5. Backup original files
6. Write migrated files

**Implementation**:
```typescript
function migrateCondition(condition: any): string {
  if (typeof condition === 'string') {
    return condition; // Already migrated
  }
  if (condition?.visited && Array.isArray(condition.visited)) {
    // Old format: convert to string
    const nodes = condition.visited.sort().join(', ');
    return `visited(${nodes})`;
  }
  throw new Error(`Invalid condition format: ${JSON.stringify(condition)}`);
}
```

**Usage**:
```bash
npm run migrate:conditional-probabilities
```

## Phase 6: Testing Strategy

### 6.1 Unit Tests

**File**: `graph-editor/src/lib/__tests__/queryDSL.test.ts` (EXTEND EXISTING)

**Test Cases**:
- Parse full query `from(a).to(b).visited(c)`
- Parse constraint-only `visited(a,b)`
- Parse `visited(a).exclude(b)`
- Parse `context(device:mobile)`
- Parse `case(test:treatment)`
- Parse combinations
- Handle empty/null/undefined
- Handle invalid strings
- Test `evaluateConstraint()` with various scenarios
- Test `normalizeConstraintString()` for comparison

### 6.2 Integration Tests

**Test Files**:
- `runner.test.ts` - Verify simulation works with new format
- `whatIf.test.ts` - Verify what-if calculations
- `conditionalReferences.test.ts` - Verify reference generation

### 6.3 Manual Testing Checklist

- [ ] Create edge with conditional probability (new format)
- [ ] Edit conditional probability condition
- [ ] Validate editor constraint-only mode (autocomplete, validation, examples)
- [ ] Run simulation with conditional probabilities
- [ ] What-if analysis with conditional probabilities
- [ ] Export/import graph with conditional probabilities
- [ ] Load old graph file (should auto-migrate or show error)

## Phase 7: Handle ConditionalProbabilitiesSection.tsx

**Status**: Old UI component, may be unused

**Action Plan**:
1. **Verify Usage**:
   ```bash
   grep -r "<ConditionalProbabilitiesSection" graph-editor/src
   ```
   - If no matches found: Component is dead code
   - If matches found: Component is still used

2. **If Unused (Dead Code)**:
   - Extract useful logic before removal:
     - Complementary conditional creation logic
     - Color picker implementation
     - Rebalancing algorithms
   - Document extracted logic for Phase 3 (feature restoration)
   - Remove component file
   - Remove import from PropertiesPanel.tsx

3. **If Used**:
   - Apply same fixes as other components
   - Replace all `condition.visited` access with parser
   - Update to use new DSL format
   - Consider migrating to ConditionalProbabilityEditor.tsx

**Estimated Time**: 2-4 hours (depending on usage status)

## Phase 8: UpdateManager Integration

**Context**: UpdateManager handles file ↔ graph sync. Need to ensure it handles condition format correctly.

**Files to Check**:
- `graph-editor/src/services/UpdateManager.ts`
- `graph-editor/src/services/UpdateManager.test.ts`

**Actions**:
1. Verify UpdateManager doesn't access `condition.visited` directly
2. Ensure UpdateManager can handle string format conditions
3. Add auto-migration when loading old format from files:
   ```typescript
   // In UpdateManager.fileToGraph()
   if (conditionalProb.condition && typeof conditionalProb.condition !== 'string') {
     // Auto-migrate old format
     const oldCond = conditionalProb.condition as {visited?: string[]};
     if (oldCond.visited && Array.isArray(oldCond.visited)) {
       conditionalProb.condition = `visited(${oldCond.visited.sort().join(', ')})`;
       console.warn(`Auto-migrated condition format for edge ${edgeId}`);
     }
   }
   ```
4. Never write old format back to files

**Estimated Time**: 1-2 hours

## Phase 9: Edge Cases and Error Handling

### 9.1 Invalid Condition Strings

**Scenarios**:
- Empty string: `""`
- Malformed: `"visited("` (unclosed)
- Invalid syntax: `"visited(a,b).invalid(c)"`
- Mixed formats: `{visited: [...]}` (old format still in data)

**Handling Strategy**:
```typescript
// In queryDSL.ts - parseConstraints() already handles this:
export function parseConstraints(constraint: string | null | undefined): ParsedConstraints {
  if (!constraint || typeof constraint !== 'string') {
    return { visited: [], exclude: [], context: [], cases: [], visitedAny: [] };
  }
  
  // Parse logic with try-catch if needed
  // Returns empty arrays for invalid input (graceful degradation)
}
```

### 9.2 Old Format in Runtime Data

**Scenario**: Graph file still has old format despite migration

**Options**:
1. **Auto-migrate on load** (Recommended)
   - UpdateManager detects and migrates
   - Log migration for audit
   - Never write old format back

2. **Strict validation**
   - Reject old format with clear error
   - Force user to run migration script

**Recommendation**: Auto-migrate with warning

### 9.3 Condition Comparison Logic

**Current Issue**: Code uses `JSON.stringify(condition.visited.sort())` for comparison

**New Approach**:
- **Option A**: Normalize condition strings (sort visited nodes, canonicalize)
- **Option B**: Parse both and compare parsed structures
- **Option C**: Use condition string directly (if deterministic)

**Recommendation**: Option A - Use `normalizeConstraintString()` from `queryDSL.ts`

This function is already defined in Phase 1 and handles:
- Sorting visited/exclude nodes
- Sorting context/case key-value pairs
- Canonicalizing order
- Useful for comparison and deduplication

### 9.4 Parameter Reference Format Extension

**Current format**: `e.<edge-id>.visited(<node-ids>).p.(mean|stdev)`

**Extended format**: `e.<edge-id>.<normalized-constraint-string>.p.(mean|stdev)`

**Implementation**:
- Use `normalizeConstraintString()` to generate stable, canonical constraint strings
- Supports all constraint types: `visited()`, `exclude()`, `context()`, `case()`, `visitedAny()`
- Examples:
  - `e.edge-id.visited(promo).p.mean`
  - `e.edge-id.visited(promo).exclude(cart).p.mean`
  - `e.edge-id.context(device:mobile).p.mean`
  - `e.edge-id.visited(promo).context(device:mobile).case(test:treatment).p.mean`

**Update required in `conditionalReferences.ts`**:
- `generateConditionalReference()` - use normalized constraint string instead of just visited nodes
- `parseConditionalReference()` - parse extended format with full constraint string

## Phase 10: Documentation Updates

### 10.1 Update Code Comments

- Remove references to old format
- Add examples of new format
- Document parser utility usage
- Add JSDoc comments to parser functions

### 10.2 Update User Documentation

- Update any user-facing docs about conditional probabilities
- Document new DSL capabilities (exclude, context, case)
- Add migration guide for users with old graph files

### 10.3 Update Type Definitions Comments

**File**: `graph-editor/src/types/index.ts`

Update comments to reflect string-only format:
```typescript
export interface ConditionalProbability {
  /**
   * Semantic constraint: determines WHEN this conditional applies (runtime evaluation)
   * Format: Query DSL constraint string (e.g., "visited(promo)", "context(device:mobile)")
   * Examples:
   * - "visited(promo)" - applies when promo node visited
   * - "visited(promo).exclude(cart)" - promo visited but cart not visited
   * - "context(device:mobile)" - applies for mobile users
   * - "case(test:treatment)" - applies for treatment variant
   */
  condition: string;
  
  // ... rest of interface
}
```

## Implementation Order

1. ✅ **Phase 1**: Generalize DSL parser utility
2. ✅ **Phase 2**: Fix broken files (in priority order)
   - 2.1: whatIf.ts (CRITICAL)
   - 2.2: runner.ts (HIGH)
   - 2.3: conditionalReferences.ts (HIGH)
   - 2.4: EdgeContextMenu.tsx (HIGH)
   - 2.5: ConditionalProbabilitiesSection.tsx (MEDIUM - verify usage first)
3. ✅ **Phase 3**: Remove backward compatibility hacks
4. ✅ **Phase 4**: Update type system
5. ✅ **Phase 5**: Create data migration script
6. ✅ **Phase 6**: Testing
7. ✅ **Phase 7**: Handle ConditionalProbabilitiesSection.tsx
8. ✅ **Phase 8**: UpdateManager integration
9. ✅ **Phase 9**: Edge cases and error handling
10. ✅ **Phase 10**: Documentation

## Dependencies and Prerequisites

### Required Before Starting
- [ ] Understand current query DSL parser implementation (`queryDSL.ts`)
- [ ] Review Python `_parse_condition` implementation (`lib/msmdc.py`) for reference
- [ ] Identify all graph files that need migration
- [ ] Backup all graph files before migration

### External Dependencies
- None - this is a self-contained migration

### Blocking Issues
- None identified

## Risk Assessment

### High Risk Areas
1. **whatIf.ts** - Critical for analysis, complex logic
   - **Mitigation**: Comprehensive testing, incremental changes
   
2. **runner.ts** - Core simulation logic
   - **Mitigation**: Test with multiple graph scenarios
   
3. **Data Migration** - Risk of data loss
   - **Mitigation**: Backup all files, validate conversion, test on copies first

### Medium Risk Areas
1. **EdgeContextMenu.tsx** - User-facing UI
   - **Mitigation**: Manual testing of all menu operations
   
2. **Type System Changes** - May break other code
   - **Mitigation**: TypeScript compiler will catch most issues

### Low Risk Areas
1. **Documentation** - No functional impact
2. **Code comments** - No functional impact

## Rollback Plan

If migration fails at any phase:

1. **Immediate Rollback**:
   ```bash
   git revert <commit-hash>
   # Or
   git reset --hard <previous-commit>
   ```

2. **Partial Rollback** (if some phases complete):
   - Keep parser utility (Phase 1) - useful regardless
   - Revert type changes (Phase 4)
   - Restore backward compatibility hacks (Phase 3)

3. **Data Recovery**:
   - Restore from backups created before migration
   - Verify no data corruption

4. **Documentation**:
   - Document what failed and why
   - Update TODO.md with lessons learned
   - Plan retry with modifications

## Estimated Time

- Phase 1: 3-4 hours (generalize DSL parser, extend queryDSL.ts, consolidate duplicate logic)
- Phase 2: 6-8 hours (fix broken files)
  - 2.1 whatIf.ts: 2 hours
  - 2.2 runner.ts: 1.5 hours
  - 2.3 conditionalReferences.ts: 1 hour
  - 2.4 EdgeContextMenu.tsx: 2 hours
  - 2.5 ConditionalProbabilitiesSection.tsx: 1-2 hours
- Phase 3: 2-3 hours (remove hacks)
- Phase 4: 1 hour (type updates)
- Phase 5: 2-3 hours (migration script)
- Phase 6: 4-6 hours (testing)
- Phase 7: 2-4 hours (ConditionalProbabilitiesSection.tsx)
- Phase 8: 1-2 hours (UpdateManager)
- Phase 9: 2-3 hours (edge cases)
- Phase 10: 1-2 hours (documentation)

**Total**: 23-35 hours

**Conservative Estimate**: 30-35 hours (includes buffer for unexpected issues)

## Success Criteria

- [ ] All broken files fixed
- [ ] No backward compatibility hacks remain
- [ ] All tests pass
- [ ] Old graph files can be loaded (auto-migrated or clear error)
- [ ] New DSL features work (exclude, context, case)
- [ ] Performance acceptable (no regression)
- [ ] Type system updated (no union types for condition)
- [ ] Migration script tested and documented
- [ ] All edge cases handled gracefully
- [ ] Documentation updated

## Post-Migration Cleanup (Future)

After successful migration, consider:

1. **Feature Restoration** (from Phase 3 in original doc):
   - Complementary conditional creation
   - Color picker for conditional probabilities
   - Implement via UpdateManager architecture

2. **Performance Optimization**:
   - Cache parsed conditions
   - Optimize condition evaluation

3. **Enhanced DSL Features**:
   - Support for `visitedAny()` in all contexts
   - Support for complex boolean logic
   - Better error messages for invalid conditions

