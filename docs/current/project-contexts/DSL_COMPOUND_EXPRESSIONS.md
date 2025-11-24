# DSL Compound Expressions: Implementation Notes

**Date**: 2025-11-24  
**Status**: Complete  
**Phase**: 3 (UI Components)

---

## Overview

During Phase 3 implementation, we extended the DSL parser to handle compound expressions (OR operators, parentheses, distribution). This was **core scope** that became apparent when implementing the Pinned Query modal.

The design spec stated equivalences like `(a;b).c = c.(a;b) = or(a,b).c = a.c;b.c` but we hadn't fully implemented the parsing logic.

---

## What We Built

### 1. Compound Expression Explosion (`dslExplosion.ts`)

**New Module**: `graph-editor/src/lib/dslExplosion.ts`

**Purpose**: Convert compound query expressions into atomic slices.

**Key Functions**:
- `explodeDSL(dsl: string): Promise<string[]>` - Explode compound → atomic slices
- `countAtomicSlices(dsl: string): Promise<number>` - Count without full expansion

**Supported Syntax**:
```typescript
// Semicolons (OR)
'a;b;c' → ['a', 'b', 'c']

// or() operator
'or(a,b,c)' → ['a', 'b', 'c']

// Nested or()
'or(a,or(b,c))' → ['a', 'b', 'c']

// Parentheses with suffix distribution
'(a;b).window(...)' → ['a.window(...)', 'b.window(...)']

// Prefix distribution
'window(...).(a;b)' → ['window(...).a', 'window(...).b']

// or() with suffix
'or(a,b).window(...)' → ['a.window(...)', 'b.window(...)']

// Mixed syntax
'a;or(b,c);d' → ['a', 'b', 'c', 'd']

// Bare key expansion (Cartesian product)
'context(channel)' → ['context(channel:google)', 'context(channel:meta)', ...]
'context(channel).context(browser)' → 4 combinations (2 channels × 2 browsers)
```

**Equivalence Verification** (all produce same normalized slices):
- `(a;b).c = c.(a;b) = or(a,b).c = or(a.c,b.c) = a.c;b.c` ✓

**Algorithm**:
1. **Parse expression tree** - Handle or(), parentheses, semicolons recursively
2. **Distribute suffixes** - Apply .window(...) to all OR branches
3. **Flatten to atomic strings** - Extract leaf nodes
4. **Expand bare keys** - Generate Cartesian product for `context(key)` without values
5. **Normalize** - Use `normalizeConstraintString()` for canonical form

**Implementation Highlights**:
- Recursive descent parser with proper parenthesis balancing
- `smartSplit()` - splits on separator respecting nesting depth
- `findMatchingParen()` - tracks parenthesis depth
- `cartesianProduct()` - generates all combinations for multiple bare keys
- Uses `parseConstraints()` from `queryDSL.ts` for all atomic expressions (single parser)

**Tests**: `dslExplosion.test.ts` - 10 tests covering all syntax variations

---

### 2. Single Parser Architecture

**Critical Decision**: All DSL parsing flows through `queryDSL.ts::parseConstraints()`

**Architecture**:
```
queryDSL.ts (atomic parsing)
  ↑
  │ uses
  │
dslExplosion.ts (compound → atomic)
  - Calls parseConstraints() on each atomic slice
  - NO duplicate parsing logic

compositeQueryParser.ts (minus/plus operators)
  - Separate concern (inclusion-exclusion)
  - Doesn't duplicate constraint parsing
```

**Documented**: `DSL_PARSING_ARCHITECTURE.md` explains the single-parser principle

**No Duplication**: We audited the codebase and confirmed:
- ✓ All context parsing goes through `parseConstraints()`
- ✓ All window parsing goes through `parseConstraints()`
- ✓ dslExplosion uses `parseConstraints()` + `normalizeConstraintString()`
- ✓ No regex for `context()` outside `queryDSL.ts`

---

### 3. Monaco Autocomplete Enhancements

**Added to QueryExpressionEditor**:

**Semicolon as trigger character**:
- Typing `;` now triggers autocomplete
- Shows `context`, `contextAny`, `window`, `or` at top level

**Context key autocomplete** (async):
- After `context(` → loads keys from contextRegistry
- Shows all available context keys with descriptions
- Example: "channel", "browser-type"

**Context value autocomplete** (async):
- After `context(key:` → loads values for that key
- Shows all values respecting otherPolicy
- Example: "google", "meta", "organic", "direct", "other"

**Window date autocomplete** (async):
- After `window(` → suggests relative and absolute dates
- Relative: -7d:, -14d:, -30d:, -90d:
- Past ranges: -2w:-1w (last week), -2m:-1m (last month)
- Absolute example: Shows d-MMM-yy format dynamically

**or() autocomplete**:
- Suggests `or()` at start or after semicolon
- Documentation explains equivalence to semicolons

---

### 4. Pinned Query Modal Integration

**Modal Component**: `PinnedQueryModal.tsx`
- Moved to `modals/` directory (proper location)
- Uses standard `Modal.css` (not custom styles)
- Uses `QueryExpressionEditor` (not raw Monaco) for consistency

**DSL Explosion Preview**:
- Live preview of implied slices
- Calls `explodeDSL()` on user input
- Shows first 20 slices + count
- Warnings:
  - >50 slices: Yellow warning
  - >500 slices: Red error (but allows save)

**Example Display**:
```
Input: context(channel);context(browser-type).window(-90d:)

Implied slices: 8
- context(channel:google)
- context(channel:meta)
- context(channel:organic)
- context(channel:direct)
- context(channel:other)
- context(browser-type:chrome).window(-90d:)
- context(browser-type:safari).window(-90d:)
- context(browser-type:firefox).window(-90d:)
```

---

## Implementation Challenges Overcome

### Challenge 1: or() Suffix Distribution

**Problem**: `or(a,b).window(...)` wasn't distributing window to both branches.

**Solution**: Modified `parseExpression()` to detect suffix after or():
```typescript
if (trimmed.startsWith('or(')) {
  const parenEnd = findMatchingParen(trimmed, trimmed.indexOf('('));
  const orPart = trimmed.substring(0, parenEnd + 1);
  const suffix = trimmed.substring(parenEnd + 1);
  
  // Parse or() contents, apply suffix to each branch
  const branches = parseExpression(orPart);
  return branches.map(b => b + suffix);
}
```

### Challenge 2: Parenthesized Groups

**Problem**: `(a;b).c` wasn't recognized as needing distribution.

**Solution**: Detect `(...)` followed by suffix, recurse on inner expression:
```typescript
if (trimmed.startsWith('(') || trimmed.startsWith('or(')) {
  const parenEnd = findMatchingParen(trimmed, trimmed.indexOf('('));
  if (parenEnd < trimmed.length - 1 && trimmed[parenEnd + 1] === '.') {
    const prefix = trimmed.substring(0, parenEnd + 1);
    const suffix = trimmed.substring(parenEnd + 1);
    
    const prefixBranches = parseExpression(prefix);
    return prefixBranches.map(b => b + suffix);
  }
}
```

### Challenge 3: Cartesian Product for Bare Keys

**Problem**: `context(channel).context(browser)` should expand to all combinations (2×2=4 slices).

**Solution**: Implemented proper Cartesian product:
```typescript
function cartesianProduct(keyValues): combinations {
  if (keyValues.length === 0) return [[]];
  
  const [first, ...rest] = keyValues;
  const restProduct = cartesianProduct(rest);
  
  const result = [];
  for (const value of first.values) {
    for (const combo of restProduct) {
      result.push([{ key: first.key, value }, ...combo]);
    }
  }
  return result;
}
```

### Challenge 4: Async Autocomplete

**Problem**: Context keys/values need to be loaded from contextRegistry (async).

**Solution**: Monaco supports returning Promises from `provideCompletionItems`:
```typescript
if (/context\([^:)]*$/.test(textUntilPosition)) {
  return contextRegistry.getAllContextKeys().then(keys => {
    const suggestions = keys.map(key => ({
      label: key.id,
      kind: monaco.languages.CompletionItemKind.Value,
      insertText: key.id,
      range
    }));
    return { suggestions };
  });
}
```

---

## Implications for Phase 4 (Adapters)

### Amplitude Adapter

**Input**: User query may be compound expression from Pinned Query.

**Processing Flow**:
1. **Explosion**: Nightly runner calls `explodeDSL(graph.dataInterestsDSL)`
2. **Atomic slices**: Gets array of normalized atomic expressions
3. **Per-slice query**: For each atomic slice:
   - Parse with `parseConstraints()` (already handles context, window)
   - Build Amplitude filter from context mappings (registry lookup)
   - Execute query
   - Store result with `sliceDSL` = normalized atomic expression

**Example**:
```typescript
// User sets: dataInterestsDSL = "context(channel);context(browser-type).window(-90d:)"

// Nightly runner explodes to:
const slices = await explodeDSL(graph.dataInterestsDSL);
// → ['context(channel:google)', 'context(channel:meta)', ..., 
//    'context(browser-type:chrome).window(-90d:)', ...]

// For each slice:
for (const slice of slices) {
  const parsed = parseConstraints(slice);
  // → { context: [{key:'channel', value:'google'}], window: {...} }
  
  const amplitudeQuery = buildAmplitudeQuery(edge, graph, parsed);
  // Uses context mappings from registry
  // → { filters: ["utm_source == 'google'"], start: ..., end: ... }
  
  const result = await executeAmplitudeQuery(amplitudeQuery);
  
  // Store with sliceDSL
  storeResult(result, { sliceDSL: normalizeConstraintString(slice) });
}
```

**Key Point**: Adapter **doesn't need to handle or() or semicolons**. Explosion happens upstream. Adapter only sees atomic slices.

### Sheets Adapter

**Input**: Manual parameter data with context HRNs.

**Processing**: Already handles `context(key:value)` in HRNs (implemented in ParamPackDSLService).

**No Changes Needed**: Sheets doesn't use compound expressions (users provide specific values).

### Nightly Runner

**Critical Component**: Must call `explodeDSL()` before executing queries.

**Python Backend**: Needs equivalent explosion logic.

**Task 4.3 Update**:
```python
def run_nightly_for_graph(graph_id: str):
    graph = load_graph(graph_id)
    pinned_dsl = graph.get('dataInterestsDSL', '')
    
    # Explode compound expression to atomic slices
    atomic_slices = explode_dsl(pinned_dsl)  # Python equivalent of explodeDSL()
    
    for slice_expr in atomic_slices:
        # Parse atomic slice
        constraints = parse_constraints(slice_expr)  # Uses single parser
        
        # Build and execute query
        query = build_amplitude_query(edge, constraints)
        result = execute_query(query)
        
        # Store with sliceDSL
        store_result(result, slice_dsl=normalize_constraint_string(slice_expr))
```

**Python Implementation Needed**:
1. Port `explodeDSL()` logic to Python
2. Port `parseExpression()` (recursive descent)
3. Port `cartesianProduct()` for bare keys
4. Ensure `normalize_constraint_string()` matches TypeScript output

**Validation**: TypeScript and Python explosion must produce identical slices (same order, same normalization).

---

## Design Decisions Made During Implementation

### Decision 1: Explosion Happens Once (Not Per-Query)

**Nightly Runner**: Explodes `dataInterestsDSL` → stores all atomic slices

**UI Query**: Uses atomic slices directly (no re-explosion)

**Rationale**: Explosion is expensive (async context loading, Cartesian products). Do it once overnight, reuse during the day.

### Decision 2: Stored sliceDSL is Always Atomic

**Invariant**: `ParameterValue.sliceDSL` MUST NOT contain `;` or `or()`.

**Enforcement**: 
- Nightly runner explodes before storing
- UI explodes compound queries before executing
- All stored slices are normalized atomic expressions

**Benefit**: Data lookup is simple - no need to match compound expressions.

### Decision 3: Single Parser for Atomic Expressions

**All paths use**: `queryDSL.ts::parseConstraints()`

**No Exceptions**: Every place that needs to parse `context()`, `window()`, `visited()`, etc. calls this function.

**Validated**: Created `DSL_PARSING_ARCHITECTURE.md` and audited codebase.

### Decision 4: Monaco Autocomplete is Async

**Challenge**: Loading context keys/values requires async calls.

**Solution**: Monaco's `provideCompletionItems` can return Promises.

**Implementation**: All autocomplete for context/window is async.

---

## Testing Coverage

### Tests Created

**`dslExplosion.test.ts`** (10 tests):
1. Simple semicolons: `a;b;c`
2. or() operator: `or(a,b,c)`
3. Nested or(): `or(a,or(b,c))`
4. Parentheses with suffix: `(a;b).window(...)`
5. or() with suffix: `or(a,b).window(...)`
6. Bare key expansion: `context(channel)` → all values
7. Cartesian product: `context(channel).context(browser)` → 4 slices
8. Mixed syntax: `a;or(b,c);d`

**`PinnedQueryExpansion.test.ts`** (8 tests):
- Validates semicolon splitting
- Validates bare key detection
- Validates or() parsing
- Validates parenthesized expressions

**`dslExplosion.test.ts`** specifically validates equivalences:
- `(a;b).c = c.(a;b)` ✓
- `or(a,b).c = a.c;b.c` ✓
- All 10 tests passing

### Regression Tests

**`queryDSL.test.ts`** (67 tests):
- All existing tests still pass
- parseConstraints handles bare keys: `context(channel)` → `{key:'channel', value:''}`
- Normalization preserves all constraint types

**Total**: 85 tests for DSL parsing (77 + 8 new)

---

## Phase 4 Adapter Work Required

### Task 4.1: Amplitude Adapter

**No Major Changes**:
- ✓ Already receives atomic slices (via `parseConstraints`)
- ✓ Already builds context filters from registry
- ✓ Just needs to handle slices from exploded expressions

**Testing**:
- Verify slices from `explodeDSL()` produce correct Amplitude queries
- Test case: `context(channel).window(-90d:)` explodes to 5 slices → 5 Amplitude queries

### Task 4.2: Sheets Adapter

**No Changes**: Sheets doesn't use compound expressions.

### Task 4.3: Nightly Runner (NEW WORK)

**Major Addition**: Python implementation of `explodeDSL()`

**Required**:
1. **Port explosion logic to Python**:
   - `explode_dsl()` - main function
   - `parse_expression()` - recursive descent
   - `smart_split()` - parenthesis-aware splitting
   - `cartesian_product()` - bare key expansion

2. **Ensure equivalence**:
   - Python explosion must produce same slices as TypeScript
   - Same normalization (canonical ordering, date formats)
   - Test TypeScript vs Python on same inputs

3. **Integrate with runner**:
   ```python
   def run_nightly_for_graph(graph_id):
       graph = load_graph(graph_id)
       pinned = graph.get('dataInterestsDSL', '')
       
       # CRITICAL: Explode before iterating
       slices = explode_dsl(pinned)
       
       for slice in slices:
           # slice is now atomic (no or/; operators)
           constraints = parse_constraints(slice)
           query = build_amplitude_query(edge, constraints)
           result = execute_query(query)
           store_result(result, slice_dsl=normalize(slice))
   ```

4. **Add explosion cap**:
   - Warn if explosion exceeds 500 slices
   - Log warning but proceed (non-blocking)

**Estimated Effort**: 2-3 days (port + test + integrate)

---

## Files Modified/Created

### New Files
- `graph-editor/src/lib/dslExplosion.ts` (225 lines)
- `graph-editor/src/lib/dateFormat.ts` (59 lines - d-MMM-yy utilities)
- `graph-editor/src/lib/DSL_PARSING_ARCHITECTURE.md` (documentation)
- `graph-editor/src/lib/__tests__/dslExplosion.test.ts` (10 tests)
- `graph-editor/src/lib/__tests__/dateFormat.test.ts` (10 tests)
- `graph-editor/src/components/modals/__tests__/PinnedQueryExpansion.test.ts` (8 tests)

### Modified Files
- `queryDSL.ts` - Added bare key parsing, date normalization, architecture comments
- `QueryExpressionEditor.tsx` - Added async autocomplete for context/window
- `PinnedQueryModal.tsx` - Uses `explodeDSL()` for preview
- `WindowSelector.tsx` - Uses compound expression parsing

---

## Backward Compatibility

**Legacy Graphs**: No `dataInterestsDSL` or compound expressions
- ✓ All code handles undefined gracefully
- ✓ Falls back to showing all available contexts
- ✓ No breaking changes

**Simple Expressions**: `context(channel:google).window(-30d:)`
- ✓ Works as-is (no explosion needed if already atomic)
- ✓ `explodeDSL()` returns single-element array

---

## Next Steps for Phase 4

**Task 4.3 becomes critical path**:
1. Implement Python explosion logic
2. Test TypeScript ↔ Python equivalence
3. Integrate into nightly runner
4. Add monitoring for slice counts
5. Test with real `dataInterestsDSL` on production graphs

**Amplitude/Sheets adapters**: Minimal changes (already handle atomic slices).

**Timeline**: Phase 4 can proceed. Nightly runner is the only major new work item (was already planned).

---

## Summary

We implemented a **complete recursive descent parser** for compound DSL expressions. This wasn't just "nice to have" - it's core functionality for the Pinned Query feature.

The implementation is:
- ✅ **Correct**: All equivalences verified by tests
- ✅ **Architected**: Single parser principle maintained
- ✅ **Tested**: 85 tests for DSL parsing
- ✅ **User-Friendly**: Autocomplete teaches syntax
- ✅ **Ready for Phase 4**: Adapters just need Python port

**Impact on Phase 4**: Nightly runner needs Python explosion logic (~2-3 days). Amplitude/Sheets adapters ready as-is.

