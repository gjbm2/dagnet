# DSL Construction: Inferring Analytic Intent from Selection

## Overview

When a user selects nodes, we must infer their **analytic intent** and construct an appropriate DSL query. This document exhaustively reasons through all selection patterns.

**DSL Schema Authority:** `/graph-editor/public/schemas/query-dsl-1.0.0.json`

---

## Critical Semantic: Pruning & Renormalization

**Current system behavior:** When user selects intermediate nodes, they're saying:

> "I'm interested in paths uniquely defined by these interstices."

This carries **pruning semantics**, not just filtering:

1. **Implicit sibling exclusion:** Selecting node B (when B has siblings B2, B3) implicitly EXCLUDES paths through B2 and B3

2. **Renormalization:** We renormalize probabilities because the user has "made that decision for us"

### Example: Sibling Pruning

```
Graph:    A ──0.3──► B1 ──► C
          │
          ├──0.5──► B2 ──► C    
          │
          └──0.2──► B3 ──► C

Selection: [A, B1, C]  (B2, B3 NOT selected)

Effect:
  - Paths through B2, B3 are EXCLUDED
  - B1's effective probability renormalizes from 0.3 to 1.0
    (because it's the only remaining path)
  - Analysis computes P(A→C via B1) with renormalized probabilities
```

### Example: Partial Sibling Selection

```
Graph:    A ──0.3──► B1 ──► C
          ├──0.5──► B2 ──► C    
          └──0.2──► B3 ──► C

Selection: [A, B1, B2, C]  (selecting 2 of 3 siblings)

Effect:
  - Paths through B3 are EXCLUDED
  - B1 renormalizes: 0.3 / (0.3 + 0.5) = 0.375
  - B2 renormalizes: 0.5 / (0.3 + 0.5) = 0.625
  - Analysis computes with renormalized probabilities
```

### Implication for DSL

`visited(B1)` doesn't just mean "filter to paths containing B1"

It means:
- **Prune** sibling edges (exclude B2, B3)
- **Renormalize** remaining edge probabilities
- **Compute** path metrics with adjusted probabilities

Similarly, `visitedAny(B1,B2)` means:
- **Keep** paths through B1 OR B2
- **Prune** unselected siblings (B3)
- **Renormalize** B1 and B2 proportionally

---

## Core Insight: User Intent Categories

| Intent | User is asking... | Typical selection |
|--------|-------------------|-------------------|
| **Path analysis** | "What's the probability/cost of this journey?" | Sequential nodes with clear start→end |
| **Outcome comparison** | "Compare probabilities of these endpoints" | Multiple absorbing nodes |
| **Branch comparison** | "Compare these alternative routes" | Sibling nodes (parallel branches) |
| **Waypoint constraint** | "Paths that pass through these points" | Middle nodes, no clear start/end |
| **Single node focus** | "Stats for this specific point" | One node |

---

## Step 1: Compute Predicates

For selection `[N1, N2, ..., Nk]`, compute:

### Basic Predicates
```
node_count           = k
is_entry[i]          = node has no predecessors in graph
is_absorbing[i]      = node has no successors in graph
is_middle[i]         = has both predecessors and successors
```

### Structural Predicates
```
selected_predecessors[i] = predecessors of Ni that are in selection
selected_successors[i]   = successors of Ni that are in selection

starts = { Ni : selected_predecessors[i] is empty }  
         # Nodes with no selected predecessors
ends   = { Ni : selected_successors[i] is empty }    
         # Nodes with no selected successors

has_unique_start = |starts| == 1
has_unique_end   = |ends| == 1
start_node       = the single start (if unique)
end_node         = the single end (if unique)
```

### Sibling Predicates
```
parents[i]        = immediate predecessors of Ni in graph
are_siblings(i,j) = parents[i] ∩ parents[j] ≠ ∅  # Share a parent

sibling_groups    = cluster nodes by shared parents
all_are_siblings  = all selected nodes share at least one common parent
```

### Aggregate Predicates
```
all_absorbing  = all selected nodes are absorbing
all_entry      = all selected nodes are entry
all_middle     = all selected nodes are middle
```

---

## Step 2: Decision Tree for Intent Inference

```
┌─────────────────────────────────────────────────────────────────┐
│                    Selection: [N1, ..., Nk]                      │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
                    ┌─────────────────┐
                    │  node_count = 0  │──► No query
                    └─────────────────┘
                              │ no
                              ▼
                    ┌─────────────────┐
                    │  node_count = 1  │──► SINGLE NODE ANALYSIS
                    └─────────────────┘
                              │ no
                              ▼
                    ┌─────────────────┐
                    │  all_absorbing?  │──► OUTCOME COMPARISON
                    └─────────────────┘
                              │ no
                              ▼
                    ┌─────────────────┐
                    │ all_are_siblings │──► BRANCH COMPARISON  
                    │ AND no unique    │    (no start/end in selection)
                    │ start or end?    │
                    └─────────────────┘
                              │ no
                              ▼
                    ┌─────────────────┐
                    │ has_unique_start │──► PATH ANALYSIS
                    │ AND              │    (full path)
                    │ has_unique_end?  │
                    └─────────────────┘
                              │ no
                              ▼
                    ┌─────────────────┐
                    │ has_unique_start │──► PARTIAL PATH (from start)
                    │ only?            │
                    └─────────────────┘
                              │ no
                              ▼
                    ┌─────────────────┐
                    │ has_unique_end   │──► PARTIAL PATH (to end)
                    │ only?            │
                    └─────────────────┘
                              │ no
                              ▼
                    ┌─────────────────┐
                    │   Otherwise      │──► GENERAL CONSTRAINT
                    └─────────────────┘
```

---

## Step 3: DSL Construction by Intent

### Case 1: Single Node Analysis

**Selection:** `[N]`

**Sub-cases:**

| Node type | Intent | DSL |
|-----------|--------|-----|
| Entry node | "Paths starting here" | `from(N)` |
| Absorbing node | "Paths ending here" | `to(N)` |
| Middle node | "Paths through here" | `visited(N)` |

---

### Case 2: Outcome Comparison

**Selection:** `[E1, E2, ..., Ek]` where all are absorbing

**Intent:** Compare probabilities of reaching each endpoint

**DSL options:**

1. **Single query (OR semantics):** `visitedAny(E1,E2,...,Ek)`
   - Returns paths to ANY of these ends
   
2. **Multiple queries (comparison):** Run separately:
   - `to(E1)`, `to(E2)`, `to(E3)`
   - Compare results

**Recommendation:** For comparison analysis, use multiple queries or pass `selected_nodes` for special handling.

---

### Case 3: Branch Comparison

**Selection:** `[B1, B2, ..., Bk]` where all are siblings (share common parent) and none is a unique start/end within selection

**Example:**
```
Graph:    A → B1 → C
          ↘ B2 ↗
          ↘ B3 ↗

Selection: [B1, B2]  (not A, not C)
```

**Intent:** Compare these parallel branches

**DSL:** `visitedAny(B1,B2)`

---

### Case 4: Path Analysis (Full Path)

**Selection:** Has unique start S and unique end E, with intermediates I = selection - {S, E}

**Sub-cases based on intermediates:**

#### 4a: No intermediates
**Selection:** `[S, E]`
**DSL:** `from(S).to(E)`

#### 4b: Sequential intermediates
**Selection:** `[S, I1, I2, E]` where S→I1→I2→E
**DSL:** `from(S).to(E).visited(I1).visited(I2)`

#### 4c: Sibling intermediates (all siblings)
**Selection:** `[S, B1, B2, E]` where B1,B2 are siblings
```
Graph:    S → B1 → E
          ↘ B2 ↗
```
**DSL:** `from(S).to(E).visitedAny(B1,B2)`

#### 4d: Mixed intermediates (multiple sibling groups)
**Selection:** `[S, B1, B2, C1, C2, E]` where B1,B2 siblings, then C1,C2 siblings
```
Graph:    S → B1 → C1 → E
          ↘ B2   ↘ C2 ↗
```
**DSL:** `from(S).to(E).visitedAny(B1,B2).visitedAny(C1,C2)`

#### 4e: Mixed siblings and non-siblings
**Selection:** `[S, B1, B2, D, E]` where B1,B2 siblings, D is not
```
Graph:    S → B1 → D → E
          ↘ B2 ↗
```
**DSL:** `from(S).to(E).visitedAny(B1,B2).visited(D)`

---

### Case 5: Partial Path (From Start Only)

**Selection:** Has unique start S, but no unique end

**Example:**
```
Selection: [S, B1, B2] 
where S is start, B1,B2 have multiple successors (no unique end)
```

**Sub-cases:**

#### 5a: Remaining nodes are all siblings
**Selection:** `[S, B1, B2]` where B1,B2 share parent S
**DSL:** `from(S).visitedAny(B1,B2)`

#### 5b: Remaining nodes are NOT siblings
**Selection:** `[S, X, Y]` where X,Y don't share parent
**DSL:** `from(S).visited(X).visited(Y)`

#### 5c: Mixed sibling groups
**Selection:** `[S, B1, B2, C1, C2]` with two sibling groups
**DSL:** `from(S).visitedAny(B1,B2).visitedAny(C1,C2)`

(Order sibling groups topologically)

---

### Case 6: Partial Path (To End Only)

**Selection:** Has unique end E, but no unique start

**Example:**
```
Selection: [X, Y, E] 
where multiple nodes could precede X or Y
```

**Sub-cases:** Mirror of Case 5

#### 6a: Preceding nodes are all siblings
**DSL:** `visitedAny(X,Y).to(E)`

#### 6b: Preceding nodes NOT siblings
**DSL:** `visited(X).visited(Y).to(E)`

---

### Case 7: General Constraint (No Unique Start or End)

**Selection:** Multiple starts possible, multiple ends possible

**Sub-cases:**

#### 7a: All nodes are siblings
**Selection:** `[B1, B2, B3]` all share parent
**DSL:** `visitedAny(B1,B2,B3)`

#### 7b: Nodes NOT siblings
**Selection:** `[X, Y, Z]` no common parent
**DSL:** `visited(X).visited(Y).visited(Z)`

#### 7c: Multiple sibling groups, no clear order
**Selection:** `[A1, A2, B1, B2]` where A's are siblings, B's are siblings
**DSL:** `visitedAny(A1,A2).visitedAny(B1,B2)` (if topologically orderable)
**Or:** May need user disambiguation

---

## Step 4: Intermediate Constraint Chain Algorithm

When we have intermediates between start and end:

```
function buildConstraintChain(intermediates, graph):
    # 1. Sort topologically
    sorted = topologicalSort(intermediates, graph)
    
    # 2. Group consecutive siblings
    groups = []
    currentGroup = [sorted[0]]
    
    for i in 1..len(sorted):
        if areSiblings(sorted[i], currentGroup[0], graph):
            currentGroup.append(sorted[i])
        else:
            groups.append(currentGroup)
            currentGroup = [sorted[i]]
    groups.append(currentGroup)
    
    # 3. Build constraint string
    constraints = []
    for group in groups:
        if len(group) == 1:
            constraints.append(f"visited({group[0]})")
        else:
            constraints.append(f"visitedAny({','.join(group)})")
    
    return '.'.join(constraints)
```

**Example:**
```
intermediates = [B1, B2, C, D1, D2]
Graph structure:
  S → B1 → C → D1 → E
    ↘ B2 ↗   ↘ D2 ↗

After topo sort: [B1, B2, C, D1, D2]
Groups: [[B1, B2], [C], [D1, D2]]
Constraints: visitedAny(B1,B2).visited(C).visitedAny(D1,D2)
```

---

## Step 5: Complete Algorithm

```typescript
function constructQueryDSL(
  selectedNodeIds: string[],
  graph: Graph
): string {
  const k = selectedNodeIds.length;
  
  // === Case 0: Empty selection ===
  if (k === 0) return '';
  
  // === Compute all predicates ===
  const nodeTypes = computeNodeTypes(selectedNodeIds, graph);
  const { starts, ends, startNode, endNode } = computeStartsEnds(selectedNodeIds, graph);
  const siblingGroups = computeSiblingGroups(selectedNodeIds, graph);
  
  const hasUniqueStart = starts.length === 1;
  const hasUniqueEnd = ends.length === 1;
  const allAbsorbing = selectedNodeIds.every(id => nodeTypes[id] === 'absorbing');
  const allAreSiblings = siblingGroups.length === 1 && siblingGroups[0].length === k;
  
  // === Case 1: Single node ===
  if (k === 1) {
    const node = selectedNodeIds[0];
    if (nodeTypes[node] === 'entry') return `from(${node})`;
    if (nodeTypes[node] === 'absorbing') return `to(${node})`;
    return `visited(${node})`;
  }
  
  // === Case 2: All absorbing (outcome comparison) ===
  if (allAbsorbing) {
    return `visitedAny(${selectedNodeIds.join(',')})`;
  }
  
  // === Case 3: All siblings, no unique start/end (branch comparison) ===
  if (allAreSiblings && !hasUniqueStart && !hasUniqueEnd) {
    return `visitedAny(${selectedNodeIds.join(',')})`;
  }
  
  // === Build DSL parts ===
  const parts: string[] = [];
  
  // Add from() if unique start
  if (hasUniqueStart) {
    parts.push(`from(${startNode})`);
  }
  
  // Add to() if unique end  
  if (hasUniqueEnd) {
    parts.push(`to(${endNode})`);
  }
  
  // Compute intermediates
  const intermediates = selectedNodeIds.filter(id => 
    id !== startNode && id !== endNode
  );
  
  // === Case 4/5/6: Has start and/or end, process intermediates ===
  if (intermediates.length > 0) {
    const constraintChain = buildConstraintChain(intermediates, graph, siblingGroups);
    parts.push(constraintChain);
  }
  
  // === Case 7: No start, no end, just constraints ===
  if (parts.length === 0) {
    if (allAreSiblings) {
      return `visitedAny(${selectedNodeIds.join(',')})`;
    } else {
      return selectedNodeIds.map(id => `visited(${id})`).join('.');
    }
  }
  
  return parts.join('.');
}

function buildConstraintChain(
  intermediates: string[],
  graph: Graph,
  siblingGroups: string[][]
): string {
  // Sort intermediates topologically
  const sorted = topologicalSort(intermediates, graph);
  
  // Group consecutive siblings
  const groups: string[][] = [];
  let currentGroup = [sorted[0]];
  
  for (let i = 1; i < sorted.length; i++) {
    if (areInSameSiblingGroup(sorted[i], currentGroup[0], siblingGroups)) {
      currentGroup.push(sorted[i]);
    } else {
      groups.push(currentGroup);
      currentGroup = [sorted[i]];
    }
  }
  groups.push(currentGroup);
  
  // Build constraint string
  return groups.map(group => {
    if (group.length === 1) {
      return `visited(${group[0]})`;
    } else {
      return `visitedAny(${group.join(',')})`;
    }
  }).join('.');
}
```

---

## Summary: Selection → DSL Mapping

| Selection Pattern | Predicates | DSL | Pruning Effect |
|-------------------|------------|-----|----------------|
| `[N]` entry | single, is_entry | `from(N)` | None |
| `[N]` absorbing | single, is_absorbing | `to(N)` | None |
| `[N]` middle | single, is_middle | `visited(N)` | Prune N's siblings |
| `[E1,E2,E3]` all ends | all_absorbing | `visitedAny(E1,E2,E3)` | Prune other ends |
| `[B1,B2]` siblings only | all_siblings, no start/end | `visitedAny(B1,B2)` | Prune unselected siblings |
| `[S,E]` path | unique start+end | `from(S).to(E)` | None at intermediate level |
| `[S,I,E]` path | unique start+end, 1 intermediate | `from(S).to(E).visited(I)` | Prune I's siblings, renorm |
| `[S,B1,B2,E]` parallel | start+end, sibling intermediates | `from(S).to(E).visitedAny(B1,B2)` | Prune unselected siblings of B1,B2 |
| `[S,B1,B2]` start + siblings | unique start, sibling rest | `from(S).visitedAny(B1,B2)` | Prune unselected siblings |
| `[S,X,Y]` start + non-siblings | unique start, non-sibling rest | `from(S).visited(X).visited(Y)` | Prune X's siblings, Y's siblings |

### Pruning Semantics

- **`visited(X)`**: "I chose X" → prune X's siblings → renormalize
- **`visitedAny(X,Y)`**: "I chose X or Y" → prune unselected siblings → renormalize X,Y proportionally
- **No constraint on layer**: No pruning at that layer (all branches remain)

---

## Edge Cases & Ambiguities

### Ambiguity 1: Impossible Constraints

**Selection:** `[S, X, Y, E]` where X and Y are on mutually exclusive paths

```
Graph:    S → X → E1
          ↘ Y → E2   (E ≠ E1 or E2)
```

**DSL:** `from(S).to(E).visited(X).visited(Y)` — may be impossible

**Handling:** Analytics should detect and report "no valid paths match this constraint"

### Ambiguity 2: Siblings Selection (Resolved by Pruning Semantics)

**Selection:** `[A, B]` where A and B are siblings (parallel)

**With pruning semantics, this is unambiguous:**
- User selected A and B (2 of possibly more siblings)
- Intent: "Paths through A OR B, excluding unselected siblings"
- DSL: `visitedAny(A,B)`
- Effect: Prune unselected siblings, renormalize A and B

**NOT:** `visited(A).visited(B)` — this would mean "must pass through both" (impossible for siblings)

### Ambiguity 3: Multiple Possible Orderings

**Selection:** `[X, Y, Z]` where topological order is ambiguous

**Resolution:** Use graph structure to determine order, or if truly ambiguous, treat as unordered constraints

---

## Implication for Python Runner

The pruning/renormalization logic is **central to the analytics computation**:

```python
def compute_path_with_pruning(graph, parsed_query):
    # 1. Identify constraint nodes from DSL
    visited_nodes = parsed_query.visited
    visited_any_groups = parsed_query.visited_any
    
    # 2. For each constraint node, find its siblings
    for node in visited_nodes:
        siblings = find_siblings(node, graph)
        # Prune edges to unselected siblings
        for sibling in siblings:
            if sibling not in visited_nodes:
                prune_edge(graph, parent_of(node), sibling)
        # Renormalize remaining sibling probabilities
        renormalize_sibling_group(graph, node)
    
    # 3. For visitedAny groups
    for group in visited_any_groups:
        all_siblings = find_all_siblings_of_group(group, graph)
        unselected = all_siblings - set(group)
        for sibling in unselected:
            prune_edge(graph, parent_of(group[0]), sibling)
        renormalize_sibling_group(graph, group)
    
    # 4. Compute probabilities on pruned/renormalized graph
    return compute_path_probability(graph, parsed_query.from_node, parsed_query.to_node)
```

This matches the existing TS behavior in `graphPruning.ts`.

---

## Python Parser Update Required

Current parser requires `from()` and `to()`. Need to update:

```python
@dataclass
class ParsedQuery:
    from_node: str | None    # Optional
    to_node: str | None      # Optional
    visited: list[str]       # AND constraints
    visited_any: list[list[str]]  # OR groups
    exclude: list[str]
    # ... other fields
```

Parser should accept:
- `from(A).to(B)` ✓
- `visited(X).visited(Y)` ✓ (no from/to)
- `from(A).visitedAny(B,C)` ✓ (no to)
- `visitedAny(X,Y,Z)` ✓ (no from/to)

---

*DSL Construction: Exhaustive Intent Inference*
*Created: 2025-11-25*
