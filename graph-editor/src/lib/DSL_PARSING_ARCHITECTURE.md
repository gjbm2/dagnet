# DSL Parsing Architecture

**Single Source of Truth**: All DSL parsing flows through `queryDSL.ts`

## Core Modules

### 1. `queryDSL.ts` - Atomic Expression Parser
**Purpose**: Parse individual constraint expressions (no compound operators)

**Functions**:
- `parseConstraints(dsl)` - Parse atomic expression → `{ visited, exclude, context, window, ... }`
- `normalizeConstraintString(dsl)` - Canonical form for comparison
- `parseDSL(dsl)` - Full query with from/to

**Used By**: Everything in the codebase

**Handles**:
- `visited(a,b)`, `exclude(c)`, `visitedAny(d,e)`
- `context(key:value)`, `contextAny(key:v1,v2)` (including bare keys)
- `window(start:end)`, `case(key:value)`

**Does NOT Handle**: Compound operators (;, or(), minus, plus)

---

### 2. `dslExplosion.ts` - Compound Expression Explosion
**Purpose**: Expand compound expressions into atomic slices

**Functions**:
- `explodeDSL(dsl)` - Explode compound → array of atomic strings
- `countAtomicSlices(dsl)` - Count without full expansion

**Uses**: `parseConstraints()` and `normalizeConstraintString()` from queryDSL.ts

**Handles**:
- Semicolons: `a;b;c` → 3 slices
- or(): `or(a,b,c)` → 3 slices (including nested: `or(a,or(b,c))`)
- Parentheses with suffixes: `(a;b).window(...)` → distributes window
- Prefix distribution: `c.(a;b)` → `c.a;c.b`
- Bare key expansion: `context(channel)` → all values (Cartesian product)
- All equivalences: `(a;b).c = c.(a;b) = or(a,b).c = a.c;b.c`

**Used By**: 
- PinnedQueryModal (slice explosion preview)
- Nightly runner (when implemented)

---

### 3. `compositeQueryParser.ts` - Minus/Plus Operators
**Purpose**: Parse inclusion-exclusion queries for MSMDC

**Functions**:
- `parseCompositeQuery(dsl)` - Extract base, minus terms, plus terms
- `getExecutionTerms(parsed)` - Convert to execution terms with coefficients

**Does NOT Use**: parseConstraints (separate concern - handles from/to/minus/plus only)

**Handles**:
- `from(a).to(b).minus(c,d)` → base + subtract paths visiting c or d
- `from(a).to(b).plus(e,f)` → add back paths visiting e or f

**Used By**: compositeQueryExecutor.ts (DAS queries)

---

## Architecture Principles

1. **Single Parser for Constraints**: `parseConstraints()` is the ONLY place that parses context, window, visited, etc.

2. **Composable**: 
   - dslExplosion calls parseConstraints on each atomic slice
   - compositeQueryParser focuses on minus/plus (doesn't duplicate constraint parsing)

3. **Normalized Output**: All paths use `normalizeConstraintString()` for canonical form

4. **No Duplication**: 
   - ❌ Don't write regex for context() parsing outside queryDSL.ts
   - ❌ Don't parse window() outside queryDSL.ts
   - ✅ Call parseConstraints() if you need to extract constraints

## Usage Examples

```typescript
// Parse atomic expression
const parsed = parseConstraints('context(channel:google).window(1-Jan-25:31-Dec-25)');
// → { context: [{key:'channel', value:'google'}], window: {start:'1-Jan-25', end:'31-Dec-25'}, ... }

// Explode compound expression
const slices = await explodeDSL('context(channel);context(browser).window(-90d:)');
// → ['context(channel:google)', 'context(channel:meta)', 'context(browser:chrome).window(-90d:)', ...]

// Parse composite query (minus/plus)
const composite = parseCompositeQuery('from(a).to(b).minus(c,d)');
// → { base: {from:'a', to:'b'}, minusTerms: [['c','d']], plusTerms: [] }
```

## Adding New DSL Features

When adding new constraint types:

1. ✅ Add to QUERY_FUNCTIONS constant in queryDSL.ts
2. ✅ Add regex matcher in parseConstraints()
3. ✅ Add to normalizeConstraintString() canonical order
4. ✅ Update ParsedConstraints interface
5. ✅ Add to Monaco autocomplete in QueryExpressionEditor.tsx
6. ❌ Don't create separate parsing logic

## Tests

- `queryDSL.test.ts`: 67 tests for parseConstraints, normalization
- `dslExplosion.test.ts`: 10 tests for compound explosion
- Total: All parsing logic is tested

