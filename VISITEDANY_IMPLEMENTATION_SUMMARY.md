# visitedAny Implementation Summary

**Date**: November 8, 2025  
**Status**: ✅ Complete - All tests passing

## Overview

Extended the Query DSL to support OR semantics via a new `visitedAny` term, enabling more expressive funnel queries and cost-effective data retrieval query generation.

## Motivation

### The Problem
- Original DSL only supported AND semantics: `visited(a,b)` = must visit a AND b
- Some funnels require "at least one of" constraints for proper discrimination
- MSMDC algorithm needed ability to rewrite conditions for cost-effectiveness (e.g., `exclude(b)` → `visitedAny(c,d)` when siblings exist and OR is cheaper)

### The Solution
Added `visitedAny` term with OR semantics while maintaining backward compatibility and consistent DSL design.

## Changes Made

### 1. Schema Updates
**File**: `graph-editor/public/schemas/query-dsl-1.0.0.json`
- Added `visitedAny` to `QueryFunctionName` enum
- Updated pattern validation to accept `visitedAny(...)`

### 2. Python Backend

#### Parser (`lib/query_dsl.py`)
- Added `visited_any: List[List[str]]` field to `ParsedQuery` dataclass
- Extended regex to parse `visitedAny(a,b,...)` groups
- Updated `to_query_string()` to reconstruct `visitedAny` terms

#### MSMDC Algorithm (`lib/msmdc.py`)
- Extended `QueryConstraints` with `visited_any: List[List[str]]` field
- Updated `_parse_condition()` to extract `visitedAny` groups from condition strings
- Modified satisfying path search to ensure at least one node from each `visitedAny` group is visited
- Added violation checking: paths that avoid all members of a `visitedAny` group are violating
- Implemented sibling-based rewrite logic:
  - When `exclude(b)` is expensive, rewrite as `visitedAny(c,d)` (siblings of b)
  - When `visited(b)` is expensive, rewrite as `exclude(c,d)` (siblings of b)
- Literal selection now considers cost weights for `visited` vs `exclude` vs `visitedAny`

#### API Endpoint (`dev-server.py`)
- Updated `/api/parse-query` response to include `visited_any` field
- All MSMDC endpoints now support `visitedAny` in generated queries

### 3. TypeScript Frontend

#### Types (`lib/queryDSL.ts`)
- Added `'visitedAny'` to `QUERY_FUNCTIONS` constant
- Updated `QUERY_PATTERN` regex to accept `visitedAny`
- Updated `parseQueryBasic()` to recognize `visitedAny` terms

#### API Client (`lib/graphComputeClient.ts`)
- Added `visited_any: string[][]` to `QueryParseResponse` interface
- Updated mock response to include `visited_any: []`

#### Monaco Editor (`components/QueryExpressionEditor.tsx`)
- Added `'visitedAny'` to chip type union
- Extended chip config with icon for `visitedAny` (same as `visited`)
- Updated parsing regex to recognize `visitedAny` terms
- Added autocomplete suggestion for `visitedAny`:
  - Documentation: "Must visit at least ONE of these nodes (OR constraint)"
  - Detail: `.visitedAny(node-id, ...)`
- Updated node ID autocomplete to trigger after `visitedAny(`

### 4. Tests

#### Python Tests (`tests/test_query_dsl.py`)
- Added `test_visitedAny_parsing` - validates `visitedAny(a,b)` is parsed correctly
- Added `test_visitedAny_reconstruction` - ensures round-trip fidelity
- Added `test_mixed_visited_and_visitedAny` - validates combined constraints

#### MSMDC Tests (`tests/test_msmdc.py`)
- Added `test_rewrite_exclude_to_visitedAny_on_sibling_routes`:
  - Graph: a→b→e, a→c→e, a→d→e, e→f
  - Condition: `exclude(b)`, weights: `visited=1, exclude=10`
  - Expected: `from(e).to(f).visitedAny(c,d)`
- Added `test_rewrite_visited_to_exclude_siblings_on_routes`:
  - Same graph
  - Condition: `visited(b)`, weights: `visited=10, exclude=1`
  - Expected: `from(e).to(f).exclude(c,d)`

**Test Results**: 116 Python tests passing, 0 failures

### 5. Documentation

#### Updated Files
- `lib/DATA_RETRIEVAL_QUERIES.md`:
  - Added "Query DSL Semantics (AND vs OR)" section
  - Explained commutative/homomorphic property
  - Documented `visitedAny` OR semantics with examples
  - Explained MSMDC cost-weighted rewrite behavior
- `PROJECT_CONNECT/README.md`:
  - Updated status to reflect MSMDC completion (Phase 1E done)
  - Added bullet point for OR semantics and `visitedAny` implementation
  - Updated test count (116 Python tests)

## Query DSL Semantics Summary

### AND Terms (existing)
```typescript
// All must be visited
visited(a,b)           // a AND b
visited(a).visited(b)  // a AND b (equivalent)

// None may be visited
exclude(a,b)           // NOT a AND NOT b
exclude(a).exclude(b)  // NOT a AND NOT b (equivalent)
```

### OR Terms (new)
```typescript
// At least one must be visited
visitedAny(a,b)                    // a OR b
visitedAny(a,b).visitedAny(c,d)   // (a OR b) AND (c OR d)
```

### Combined
```typescript
// Complex constraint: (a OR b) AND c AND NOT d
from(start).to(end)
  .visitedAny(a,b)
  .visited(c)
  .exclude(d)
```

## MSMDC Cost-Weighted Rewrite Examples

### Example 1: Rewrite exclude → visitedAny
**Graph**: `a→b→e, a→c→e, a→d→e, e→f`

**Input**:
```python
generate_query_for_edge(
    graph, edge_e_to_f,
    condition="exclude(b)",
    literal_weights={"visited": 1, "exclude": 10},
    preserve_condition=False
)
```

**Output**: `from(e).to(f).visitedAny(c,d)`

**Reasoning**: 
- Original condition `exclude(b)` is expensive (weight=10)
- Siblings of b at node e are c and d
- Expressing as `visitedAny(c,d)` is semantically equivalent and cheaper (weight=1)

### Example 2: Rewrite visited → exclude
**Same graph**

**Input**:
```python
generate_query_for_edge(
    graph, edge_e_to_f,
    condition="visited(b)",
    literal_weights={"visited": 10, "exclude": 1},
    preserve_condition=False
)
```

**Output**: `from(e).to(f).exclude(c,d)`

**Reasoning**:
- Original condition `visited(b)` is expensive (weight=10)
- Expressing as `exclude(c,d)` (exclude siblings) is semantically equivalent and cheaper (weight=1)

## Performance Characteristics

- **No exponential path enumeration**: Uses witness-guided algorithm with constrained reachability
- **Complexity**: O(V + E) per reachability check, capped at `max_checks` (default 200)
- **Scalability**: Tested on graphs with 50+ nodes, multiple convergence points, and dense connectivity

## Backward Compatibility

- All existing queries continue to work
- `visited` and `exclude` behavior unchanged
- New `visitedAny` term is additive only
- Schema version remains `1.0.0` (additive change)

## Integration Points

### Editor
- Monaco autocomplete offers `visitedAny` after `.`
- Validation accepts `visitedAny` in query strings
- Chips render `visitedAny` with same icon as `visited` (distinctive label)

### API
- `/api/parse-query` returns `visited_any` field
- `/api/generate-query` can produce `visitedAny` in output
- `/api/generate-all-parameters` honors `visitedAny` in conditions

### Backend Logic
- Graph selection (`graph_select.py`) does NOT yet implement `visitedAny` filtering (topology use case)
- MSMDC (`msmdc.py`) fully supports `visitedAny` (data retrieval use case)

## Future Work

### Graph Selection Support
If topology filtering needs OR semantics:
```python
# graph_select.py
def apply_query_to_graph(graph, query):
    # ...
    if parsed.visited_any:
        for group in parsed.visited_any:
            # Filter paths: must pass through at least one node in group
            pass
```

### Query Factorization
Multiple data retrieval queries could be optimized:
```python
# Instead of 10 separate API calls:
#   from(a).to(b).visited(x)
#   from(a).to(b).visited(y)
#   from(a).to(b).visited(z)
# Generate single query:
#   from(a).to(b).visitedAny(x,y,z)
# Then split results client-side
```

## Conclusion

The `visitedAny` term extends the Query DSL with principled OR semantics, enabling:
1. More expressive funnel construction for complex user journeys
2. Cost-effective data retrieval query generation via MSMDC rewrites
3. Consistent design (commutative, homomorphic like other terms)
4. Full end-to-end integration (schema → parser → MSMDC → API → Monaco)

All 116 Python tests passing, 0 linter errors, ready for production use.

