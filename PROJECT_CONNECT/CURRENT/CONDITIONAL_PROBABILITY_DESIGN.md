# Conditional Probability Design Decision

**Date:** 2025-11-05  
**Status:** ✅ FINALIZED  
**Context:** Phase 0.1 Schema Design

---

## Key Architectural Decision

**Use Query DSL strings for all constraint specifications, not structured objects.**

---

## The Problem

We had three different ways of expressing constraints:

1. **Parameter query field:** `"from(A).to(B).visited(C,D)"`
2. **Graph conditional_p:** `{"condition": {"visited": ["C", "D"]}, "p": {...}}`
3. **Parameter condition field:** `{"visited": ["C", "D"]}`

This created:
- Three parsers to maintain
- Duplication between parameter query and condition
- Inconsistent syntax across the system

---

## The Solution

**Use query DSL strings everywhere for expressing constraints:**

### In Parameter Files
```yaml
id: conversion-after-promo
query: "from(checkout).to(purchase).visited(promo-viewed)"
# NO separate 'condition' field - it's encoded in the query
```

### In Graph Edges
```json
{
  "p": {"mean": 0.3, "stdev": 0.05},  // Base/default probability
  
  "conditional_p": [  // Special cases with constraints
    {
      "condition": "visited(promo-viewed,feature-demo)",  // Query DSL string!
      "p": {"mean": 0.5, "stdev": 0.06, "parameter_id": "conversion-after-promo"}
    },
    {
      "condition": "context(device:mobile)",
      "p": {"mean": 0.4, "stdev": 0.05}
    }
  ]
}
```

---

## Query DSL Constraint Grammar

**Full query (on parameters):**
```
from(node-id).to(node-id)[.visited(nodes)][.exclude(nodes)][.context(key:value,...)][.case(id:variant)]
```

**Constraint-only (on graph conditional_p):**
```
[visited(nodes)][.exclude(nodes)][.context(key:value,...)][.case(id:variant)]
```

We already know `from`/`to` from the edge endpoints, so conditions only need the constraint clauses.

**Examples:**
- `"visited(A,B)"` - Must have visited both A and B
- `"visited(A).exclude(C)"` - Visited A but not C
- `"context(device:mobile,segment:premium)"` - Mobile premium users
- `"case(test-2025:treatment)"` - In treatment variant of test
- `"visited(A).context(device:mobile)"` - Combined constraints

---

## Structure Decision: Keep Dual Format

**CONSIDERED:** Making `p` an array like `conditional_p` for uniformity:
```json
"p": [
  {"constraint": "visited(A)", "mean": 0.5},
  {"mean": 0.3}  // no constraint
]
```

**DECIDED:** Keep separate `p` and `conditional_p`:
```json
"p": {"mean": 0.3},           // Simple, common case
"conditional_p": [...]        // Array for special cases
```

**Rationale:**
1. ✅ **Less UI complexity** - base probability is simple, special cases are separate
2. ✅ **Existing logic works** - complement calculation, sibling weighting already implemented
3. ✅ **Colors work** - conditional edges have color coding (already built)
4. ✅ **Pragmatic** - complexity only where needed (most edges are simple)
5. ✅ **Clear semantics** - "this is the default, these are the special cases"

**Trade-off accepted:** Slight asymmetry for significant implementation simplicity.

---

## Evaluation Semantics: Most Specific Wins

At runtime, when evaluating which probability to use:

1. **Evaluate all constraints** against current state
2. **Filter to matching conditions**
3. **Select most specific** (count constraint clauses)
4. **Apply that probability**

**Specificity ranking:**
```
visited(A,B).context(device:mobile).case(test:treatment)  // 4 constraints
visited(A,B).context(device:mobile)                       // 3 constraints
visited(A).context(device:mobile)                         // 2 constraints
visited(A)                                                // 1 constraint
context(device:mobile)                                    // 1 constraint
(no condition / base p)                                   // 0 constraints
```

**Example:**
```javascript
// Current state: visited=[A,B], context={device:'mobile'}
const allPs = [edge.p, ...edge.conditional_p];
const matches = allPs.filter(p => evaluateConstraint(p.condition, state));
const mostSpecific = maxBy(matches, p => countConstraintClauses(p.condition));
// Use mostSpecific.mean for probability
```

**Why not first-match?** Order independence - system automatically finds the right specificity level.

---

## Cost and Time Parameters

**DECIDED:** Keep costs simple for now (no conditional variants):
```json
"cost_gbp": {"mean": 5, "stdev": 1},
"cost_time": {"mean": 2, "stdev": 0.5}
```

**Rationale:**
- Conditional costs are rare
- Can be modeled with graph branching when needed
- Adds complexity without clear current use case
- Can extend later if needed (same pattern as conditional_p)

---

## Benefits of This Design

1. ✅ **One parser** - Single query DSL for all constraints
2. ✅ **One language** - Consistent syntax throughout system
3. ✅ **Extensible** - New constraint types just extend grammar
4. ✅ **No duplication** - Query string encodes everything
5. ✅ **Clean parameter schema** - No redundant condition field
6. ✅ **Minimal refactoring** - Existing UI/logic mostly unchanged
7. ✅ **Most specific wins** - Clear, intuitive evaluation semantics

---

## Implementation Impact

### Parser Changes
- Update query parser to handle constraint-only strings
- Add `countConstraintClauses()` utility
- Add `evaluateConstraint()` for runtime matching

### Schema Changes
- ✅ Remove `condition` field from parameter schema
- ✅ Change graph `Condition` from object to string
- Keep `p` and `conditional_p` separate (no structural change)

### UI Changes
- QueryExpressionEditor supports full queries AND constraint-only mode
- Conditional probabilities panel parses string conditions
- Color assignment still based on `conditional_p` array

### Runtime Changes
- Runner evaluates constraints from strings
- Most-specific-wins logic (not first-match)
- No changes to complement calculation or sibling weighting

---

## Migration Notes

**Old format (graph schema):**
```json
{"condition": {"visited": ["A", "B"]}, "p": {...}}
```

**New format:**
```json
{"condition": "visited(A,B)", "p": {...}}
```

**Migration:** Parse old format, generate new format. Simple string transformation.

---

## References

- **Query DSL Spec:** `QUERY_EXPRESSION_SYSTEM.md`
- **Override Pattern:** `OVERRIDE_PATTERN_DESIGN.md`
- **Schema Mappings:** `SCHEMA_FIELD_MAPPINGS.md`

---

**Status:** Ready for implementation in Phase 0.1 schema updates

