# DSL Construction: Selection → Query String

## Overview

When user selects nodes, we need to construct a DSL query string that Python can parse and execute. This document enumerates all selection patterns and their corresponding DSL.

---

## Selection Pattern Catalog

### Pattern 1: Single Node

**Selection:** `[B]`

**Graph context matters:**
- Is B the graph start? → Special case
- Is B an end/absorbing node? → Special case
- Otherwise → Path from graph start to B

**DSL options:**

| Scenario | DSL | Notes |
|----------|-----|-------|
| B is middle node | `from(START).to(B)` | START = graph's entry node |
| B is graph start | `node(B)` | Just show node stats |
| B is absorbing | `from(START).to(B)` | Path to this end |

**Question:** Should we always include graph start explicitly, or let Python infer it?

**Recommendation:** Always include: `from(START).to(B)`

---

### Pattern 2: Two Sequential Nodes

**Selection:** `[A, B]` where A→B edge exists (or A comes before B topologically)

**DSL:** `from(A).to(B)`

**Example:**
```
Graph: START → A → B → C → END
Selection: [A, B]
DSL: from(A).to(B)
```

---

### Pattern 3: Two Non-Sequential Nodes

**Selection:** `[A, C]` where A comes before C but no direct edge

**DSL:** `from(A).to(C)`

```
Graph: START → A → B → C → END
Selection: [A, C]
DSL: from(A).to(C)
```

Python calculates path A→...→C through whatever intermediates exist.

---

### Pattern 4: Two End Nodes (Comparison)

**Selection:** `[END1, END2]` where both are absorbing

**DSL:** `compare(END1, END2)` OR `ends(END1, END2)`

```
Graph: START → A → END1
              ↘ B → END2
Selection: [END1, END2]
DSL: compare(END1, END2)
```

**Alternative:** Could use `from(START).to(END1, END2)` but semantics are different (comparison vs path).

**Question:** Do we need a new DSL function for comparison, or reuse existing?

---

### Pattern 5: Three+ Nodes - Sequential Path

**Selection:** `[A, B, C]` where A→B→C (direct edges)

**DSL:** `from(A).to(C).visited(B)`

```
Graph: START → A → B → C → END
                   ↘ X
Selection: [A, B, C]
DSL: from(A).to(C).visited(B)
```

The `visited(B)` forces the path through B, pruning alternatives.

---

### Pattern 6: Three+ Nodes - Non-Sequential but Valid Path

**Selection:** `[A, B, D]` where A→...→B→...→D but not direct edges

**DSL:** `from(A).to(D).visited(B)`

```
Graph: A → X → B → Y → D
           ↘ Z ↗
Selection: [A, B, D]
DSL: from(A).to(D).visited(B)
```

---

### Pattern 7: Three+ Nodes - Parallel/OR Pattern

**Selection:** `[A, B, C, D]` where A→{B,C}→D (parallel branches)

**DSL:** `from(A).to(D).visitedAny(B, C)`

```
Graph: A → B → D
       ↘ C ↗
Selection: [A, B, C, D]
DSL: from(A).to(D).visitedAny(B, C)
```

**Question:** Is `visitedAny` the right semantics? Or should multiple intermediates imply OR?

**Alternative:** `from(A).to(D).visited(B, C)` could mean "visited any of B, C"

---

### Pattern 8: Three+ Nodes - All End Nodes

**Selection:** `[END1, END2, END3]` where all are absorbing

**DSL:** `compare(END1, END2, END3)` OR `ends(END1, END2, END3)`

```
Graph: START → A → END1
              ↘ B → END2
              ↘ C → END3
Selection: [END1, END2, END3]
DSL: compare(END1, END2, END3)
```

---

### Pattern 9: General Multi-Selection (No Clear Path)

**Selection:** `[A, C, E]` where no unique start/end structure

**DSL:** `nodes(A, C, E)`

```
Graph: Complex graph, selection doesn't form a path
Selection: [A, C, E]
DSL: nodes(A, C, E)
```

Returns aggregate statistics, not path analysis.

---

### Pattern 10: Selection Includes Graph Start

**Selection:** `[START, A, B]`

**DSL:** `from(START).to(B).visited(A)`

Same as normal path, but START is explicit.

---

### Pattern 11: Selection Includes Graph End

**Selection:** `[A, B, END]`

**DSL:** `from(A).to(END).visited(B)`

Same as normal path, END is explicit target.

---

### Pattern 12: Disconnected Selection

**Selection:** `[A, X]` where A and X are in disconnected subgraphs

**DSL:** `nodes(A, X)` with warning/error

Python should detect this and return appropriate error or stats.

---

### Pattern 13: Selection with Excluded Nodes

**User manually edits to exclude:**

**DSL:** `from(A).to(D).visited(B).exclude(C)`

```
Graph: A → B → D
       ↘ C ↗
User wants path through B, explicitly excluding C
DSL: from(A).to(D).visited(B).exclude(C)
```

This is manual editing - TS won't auto-generate excludes.

---

## DSL Function Summary

| Function | Purpose | Example |
|----------|---------|---------|
| `from(X)` | Path start | `from(A)` |
| `to(X)` | Path end | `to(B)` |
| `visited(X,Y,...)` | Must pass through (AND) | `visited(B,C)` |
| `visitedAny(X,Y,...)` | Must pass through one (OR) | `visitedAny(B,C)` |
| `exclude(X,Y,...)` | Must not pass through | `exclude(D)` |
| `compare(X,Y,...)` | Compare endpoints | `compare(END1,END2)` |
| `nodes(X,Y,...)` | General selection | `nodes(A,B,C)` |
| `node(X)` | Single node stats | `node(A)` |

---

## Decision Matrix: Selection → DSL

```
Selection received: [N1, N2, ..., Nk]

1. k = 0?
   → No analysis
   
2. k = 1?
   → from(GRAPH_START).to(N1)
   → Unless N1 IS graph start: node(N1)

3. k = 2?
   → Both absorbing? → compare(N1, N2)
   → Otherwise: Sort topo → from(first).to(last)

4. k >= 3?
   → All absorbing? → compare(N1, N2, ..., Nk)
   → Has unique start AND unique end?
      → Sort topo: [S, I1, I2, ..., E]
      → from(S).to(E).visited(I1, I2, ...)
   → Otherwise: nodes(N1, N2, ..., Nk)
```

---

## Algorithm: constructQueryDSL()

```typescript
function constructQueryDSL(
  selectedNodeIds: string[],
  graph: Graph
): string {
  const n = selectedNodeIds.length;
  
  if (n === 0) {
    return '';  // No query
  }
  
  // Get predicates
  const predicates = computeSelectionPredicates(selectedNodeIds, graph);
  
  // Case 1: Single node
  if (n === 1) {
    const nodeId = selectedNodeIds[0];
    const graphStart = findGraphStart(graph);
    
    if (nodeId === graphStart) {
      return `node(${nodeId})`;
    }
    return `from(${graphStart}).to(${nodeId})`;
  }
  
  // Case 2: All absorbing (comparison mode)
  if (predicates.all_absorbing) {
    return `compare(${selectedNodeIds.join(',')})`;
  }
  
  // Case 3: Has unique start and end (path mode)
  if (predicates.has_unique_start && predicates.has_unique_end) {
    const start = predicates.start_node;
    const end = predicates.end_node;
    const intermediates = predicates.intermediate_nodes;
    
    let dsl = `from(${start}).to(${end})`;
    
    if (intermediates.length > 0) {
      dsl += `.visited(${intermediates.join(',')})`;
    }
    
    return dsl;
  }
  
  // Case 4: General selection (no clear structure)
  return `nodes(${selectedNodeIds.join(',')})`;
}
```

---

## Edge Cases to Handle

### EC1: Node IDs with special characters

If node IDs contain commas, parentheses, or dots, need escaping:
```
Node ID: "my.node-1"
DSL: from(my.node-1) - is this valid?
```

**Recommendation:** Assume node IDs are alphanumeric + hyphens + underscores. Document this constraint.

### EC2: Very large selections

If user selects 50 nodes, DSL becomes unwieldy:
```
from(A).to(Z).visited(B,C,D,E,F,G,H,I,J,K,L,M,N,O,P,Q,R,S,T,U,V,W,X,Y)
```

**Recommendation:** For selections > N nodes (e.g., 10), fall back to `nodes(...)` or warn user.

### EC3: Cyclic selections

If selection includes nodes in a cycle:
```
Graph: A → B → C → A (cycle)
Selection: [A, B, C]
```

**Recommendation:** Topo sort will fail. Fall back to `nodes(...)` with metadata indicating cycle detected.

### EC4: Multiple starts/ends

If selection has multiple valid starts or ends:
```
Selection: [A, B, C, D] where both A and B have no selected predecessors
```

**Recommendation:** Currently design assumes unique start/end. Fall back to `nodes(...)` if ambiguous.

---

## Testing Matrix

| Pattern | Selection | Expected DSL |
|---------|-----------|--------------|
| Empty | `[]` | `` |
| Single middle | `[B]` | `from(START).to(B)` |
| Single start | `[START]` | `node(START)` |
| Two sequential | `[A, B]` | `from(A).to(B)` |
| Two non-seq | `[A, C]` | `from(A).to(C)` |
| Two ends | `[END1, END2]` | `compare(END1,END2)` |
| Three seq | `[A, B, C]` | `from(A).to(C).visited(B)` |
| Three non-seq | `[A, B, D]` | `from(A).to(D).visited(B)` |
| All ends | `[E1, E2, E3]` | `compare(E1,E2,E3)` |
| No structure | `[A, X, Z]` | `nodes(A,X,Z)` |

---

## Open Questions

### Q1: Do we need `compare()` function or reuse `from/to`?

**Options:**
- A) New `compare(X,Y,Z)` function - clear semantics
- B) `to(X,Y,Z)` with multiple targets - implicit comparison
- C) `ends(X,Y,Z)` - explicit naming

**Recommendation:** A - `compare()` makes intent explicit.

### Q2: `visited(A,B)` semantics - AND or OR?

**Options:**
- A) AND - must visit all (current `visited`)
- B) OR - must visit any (need `visitedAny`)
- C) Infer from graph structure

**Recommendation:** 
- `visited(A,B)` = AND (sequential intermediate)
- `visitedAny(A,B)` = OR (parallel branches)

TS constructor can choose based on `is_sequential` predicate.

### Q3: Should graph start be implicit or explicit?

**Options:**
- A) Always explicit: `from(START).to(B)`
- B) Implicit if not specified: `to(B)` means from graph start
- C) Configurable

**Recommendation:** B - implicit is cleaner, Python infers graph start if `from()` is missing.

---

*DSL Construction Cases*
*Created: 2025-11-25*

