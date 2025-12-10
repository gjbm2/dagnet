# Quick Runner: Path Analysis Modes

## Overview

The **Quick Runner** (also called **Path Analysis**) is an interactive analysis tool that calculates probabilities and costs when users select nodes in the graph. It operates in different modes depending on the **number** and **topological relationship** of selected nodes.

**Key Principle**: What-If overrides apply FIRST (as base scenario), then quick selection adds additional pruning/analysis.

---

## Selection Modes

The system detects 6 different selection patterns and operates differently for each:

| Mode | Selection Pattern | Display Type | Pruning Applied? |
|------|------------------|--------------|------------------|
| 1 | Single node | Path from Start | ❌ No |
| 2 | Two nodes (topo sequence) | A→B path | ❌ No (no intermediates) |
| 3 | Two+ nodes (all end nodes) | Multi-end comparison | ❌ No |
| 4 | Three+ nodes (sequential) | Sequential path | ✅ Yes |
| 5 | Three+ nodes (parallel/OR) | Parallel paths | ✅ Yes |
| 6 | Other multi-selection | General stats | ❌ No |

---

## Mode 1: Single Node Selection

**Condition**: `selectedNodes.length === 1`

**Purpose**: Show probability of reaching this node from graph start

### Algorithm

```typescript
1. Find start node (node with entry.is_start = true or entry_weight > 0)
2. If selected node IS start node:
   - Probability = 1.0
   - Cost = 0
3. If selected node is NOT start node:
   - Calculate path: Start → Selected
   - Use findPathThroughIntermediates(start, selected, [start, selected])
   - NO pruning (no intermediate nodes to force)
```

### Example

```
Graph: Start → A → B → C (End)
              ↓
              D

Selection: [B]

Result:
  Type: 'single'
  Start: Start
  Target: B
  Probability: P(Start→A) * P(A→B)  [no pruning, includes mass through D]
  Cost: Expected cost from Start to B
```

### Display

```
┌─────────────────────────────────┐
│ Path Analysis: Node B           │
├─────────────────────────────────┤
│ From: Start                     │
│ Probability: 45.2%              │
│ Expected Cost: £12.50           │
│ Expected Time: 2.3 days         │
└─────────────────────────────────┘
```

---

## Mode 2: Two Node Selection (Topological Sequence)

**Condition**: `selectedNodes.length === 2` AND not both end nodes

**Purpose**: Show path from first to second node (topologically ordered)

### Algorithm

```typescript
1. Sort nodes topologically: [A, B] (A before B in DAG)
2. Check for direct edge A→B:
   - Calculate directProb = computeEffectiveEdgeProbability(A→B, whatIfOverrides, pathContext={A,B})
   - Direct cost = edge.costs
3. Calculate indirect path:
   - Use findPathThroughIntermediates(A, B, [A, B])
   - NO pruning (no intermediates between A and B to force)
4. Use whichever path has higher probability
```

### Example 1: Direct Edge

```
Graph: Start → A → B → End
              ↓
              C

Selection: [A, B]

Check: Direct edge A→B? YES
  directProb = 0.6
  indirectProb = 0.0 (no path through C to B)
  USE DIRECT

Result:
  Type: 'path'
  NodeA: A
  NodeB: B
  Probability: 0.6 (direct edge)
  Cost: Edge A→B cost
  isDirect: true
```

### Example 2: Indirect Path

```
Graph: Start → A → C → B → End
                    ↓
                    D

Selection: [A, B]

Check: Direct edge A→B? NO
  directProb = 0 (no edge)
  indirectProb = P(A→C) * P(C→B) = 0.5 * 0.8 = 0.4
  USE INDIRECT

Result:
  Type: 'path'
  NodeA: A
  NodeB: B
  Probability: 0.4
  Cost: Expected cost A→C→B
  isDirect: false
  intermediateNodes: [C]
```

### Display

```
┌─────────────────────────────────┐
│ Path Analysis: A → B            │
├─────────────────────────────────┤
│ Direct Path: YES / NO           │
│ Probability: 60.0%              │
│ Expected Cost: £8.20            │
│ Expected Time: 1.5 days         │
│ Via: [C, D] (if indirect)       │
└─────────────────────────────────┘
```

---

## Mode 3: Multiple End Nodes (Comparison Mode)

**Condition**: `selectedNodes.length >= 2` AND **all selected nodes are end nodes**

**Purpose**: Compare probabilities of reaching different end nodes

**End Node Detection**:
- `node.absorbing === true` OR
- No outgoing edges from node

### Algorithm

```typescript
1. Verify all selected nodes are end nodes
2. Find start node
3. For each selected end node:
   - Calculate: Start → EndNode (no pruning)
   - Compute probability and costs
4. Sort by probability (descending)
5. Sum total probability
```

### Example

```
Graph: Start → A → Success (absorbing)
              ↓
              B → Failure (absorbing)
              ↓
              C → Error (absorbing)

Selection: [Success, Failure, Error]

Result:
  Type: 'multi_end'
  Comparisons: [
    { node: Success, probability: 0.60, cost: £10 },
    { node: Failure, probability: 0.25, cost: £5 },
    { node: Error, probability: 0.15, cost: £3 }
  ]
  Total Probability: 1.0 (should sum to ~1.0 for well-formed graphs)
```

### Display

```
┌─────────────────────────────────┐
│ Multi-End Comparison            │
├─────────────────────────────────┤
│ Success:  60.0% (£10.00)  ✓     │
│ Failure:  25.0% (£5.00)         │
│ Error:    15.0% (£3.00)         │
├─────────────────────────────────┤
│ Total:   100.0%                 │
└─────────────────────────────────┘
```

---

## Mode 4: Sequential Path (3+ Nodes)

**Condition**: `selectedNodes.length >= 3` AND **nodes are topologically sequential**

**Sequential Definition**: Each node directly connects to the next in topological order

### Algorithm

```typescript
1. Sort nodes topologically: [A, B, C, D]
2. Check if sequential:
   - Is there edge A→B? YES
   - Is there edge B→C? YES
   - Is there edge C→D? YES
   → Sequential = true

OR

Check if has unique start/end:
   - First node in topo order
   - Last node is absorbing
   → hasUniqueStartEnd = true

3. If sequential OR hasUniqueStartEnd:
   - Identify intermediates: [B, C] (exclude first A and last D)
   - COMPUTE PRUNING: Force path through intermediates
   - Calculate: A→B→C→D with pruning/renormalization
```

### Example: Pure Sequential

```
Graph: Start → A → B → C → End
                   ↓   ↓
                   X   Y

Selection: [A, B, C]

Detection:
  - Topo sort: [A, B, C]
  - A→B exists? YES
  - B→C exists? YES
  - isSequential = true

Pruning:
  - Intermediates: [B]
  - At A: Prune path A→X (force A→B)
  - At B: Prune path B→Y (force B→C)
  - Renormalize A→B and B→C

Result:
  Type: 'path_sequential'
  NodeA: A
  NodeB: C
  Intermediates: [B]
  Probability: P(A→B) * renorm * P(B→C) * renorm
  Cost: Expected cost through forced path
```

---

## Mode 5: Parallel Path (3+ Nodes, OR Logic)

**Condition**: `selectedNodes.length >= 3` AND **nodes are NOT topologically sequential** AND **has unique start and end**

**Simplified Detection**: 
- First node in topo order = start (in selection)
- Last node in topo order = end (in selection)  
- Has intermediates between them
- NO requirement that intermediates "fan back in" - user is just forcing path through selected nodes

**Purpose**: Calculate probability of reaching end through ANY of the selected intermediate nodes (logical OR)

### Algorithm

```typescript
1. Sort topologically: [A, B, C, D, E]
2. Check if sequential:
   - A→B exists? YES
   - B→C exists? NO (gap!)
   - isSequential = false

3. Check if unique start/end:
   - First node: A
   - Last node: E (absorbing? YES)
   - hasUniqueStartEnd = true

4. Treat intermediates as PARALLEL paths:
   - Intermediates: [B, C, D]
   - Force path through AT LEAST ONE of {B, C, D}
   - Prune paths that bypass ALL intermediates
```

### Example: Parallel/OR

```
Graph: Start → A → B → E (End)
                   ↓ ↗
                   C
                   ↓ ↗
                   D

Selection: [A, B, C, D, E]

Detection:
  - Topo sort: [A, B, C, D, E]
  - B→C exists? YES
  - C→D exists? YES  
  - D→E exists? YES
  - But also: B→E exists, C→E exists
  - NOT purely sequential (multiple paths)
  - Last node E is absorbing
  - hasUniqueStartEnd = true

Interpretation:
  - Start: A
  - End: E
  - Intermediates: {B, C, D} (user wants path through ANY of these)

Pruning Logic:
  - At A: No pruning (only one child B selected, need to check siblings)
  - If A had other children not in {B,C,D}: prune those
  - At each intermediate: similar logic

Result:
  Type: 'path_sequential' (name is misleading, should be 'path_constrained')
  Probability: P(reach E through at least one of {B,C,D})
  Cost: Expected cost through constrained paths
```

### Key Insight: Sibling Set Pruning (OR Logic)

The pruning logic must check against **ALL selected nodes** (including start and end), not just intermediates.

**Why?** In OR mode, we want to allow paths to the end node even if it's not an interstitial.

```
Graph: A → B → End
       ↓   ↓
       C   D
       ↓   ↓
       End End

Selection: [A, B, C, End]

Interstitials: {B, C} (exclude A=start, End=end)

At A:
  - Siblings: {B, C}
  - Selected (in full selection): {B, C}
  - NO PRUNING (all siblings selected)

At B:
  - Siblings: {D, End}
  - Selected (in full selection): {End}  ✅ End IS selected!
  - PRUNE B→D
  - Renormalize B→End

At C:
  - Siblings: {D, End}
  - Selected (in full selection): {End}  ✅ End IS selected!
  - PRUNE C→D
  - Renormalize C→End

Result: Path goes A→{B OR C}→End (both paths to End allowed)
```

**Critical Bug Fix**: Must check `allSelectedIds.has(sibling)`, NOT `interstitialNodes.has(sibling)`, otherwise paths to the end node get incorrectly pruned!

---

## Mode 6: General Multi-Selection (Fallback)

**Condition**: None of the above patterns match

**Purpose**: Show aggregate statistics about the selection

### Algorithm

```typescript
1. Identify internal edges (both ends selected)
2. Identify incoming edges (source not selected, target selected)
3. Identify outgoing edges (source selected, target not selected)
4. Sum probabilities and costs
5. Check conservation: incoming ≈ outgoing (within tolerance)
```

### Example

```
Graph: Start → A → B → C → End
              ↓   ↓   ↓
              D   E   F

Selection: [A, B, E, F]  (non-sequential, non-path pattern)

Analysis:
  Internal edges: A→B, B→E (both ends in selection)
  Incoming: Start→A, D→E (source outside, target inside)
  Outgoing: B→C, E→F, F→End (source inside, target outside)
  
  Total incoming prob: 0.6
  Total outgoing prob: 0.58
  Conservation: OK (within 0.001 tolerance)
```

### Display

```
┌─────────────────────────────────┐
│ Selection Statistics            │
├─────────────────────────────────┤
│ Nodes: 4                        │
│ Internal Edges: 2               │
│ Incoming Edges: 2               │
│ Outgoing Edges: 3               │
│ Incoming Prob: 60.0%            │
│ Outgoing Prob: 58.0%            │
│ Conservation: ✓ OK              │
│ Total Costs: £15.40, 3.2 days   │
└─────────────────────────────────┘
```

---

## Decision Tree

```
User selects N nodes
    ↓
N = 0?
  → No analysis
    ↓
N = 1?
  → MODE 1: Single Node
    Calculate: Start → Selected
    Pruning: None
    ↓
N = 2?
  → Are both end nodes?
    YES → MODE 3: Multi-End Comparison
    NO  → MODE 2: Two-Node Path
          Pruning: None (no intermediates)
    ↓
N >= 3?
  → Are ALL end nodes?
    YES → MODE 3: Multi-End Comparison
          Pruning: None
    NO  → Continue...
    ↓
  → Sort topologically → [First, ..., Last]
    ↓
  → Is Last absorbing OR has no outgoing?
    NO → MODE 6: General Multi-Selection
    YES → Continue...
    ↓
  → Are nodes topologically sequential?
    (Each has edge to next in topo order)
    ↓
    YES → MODE 4: Sequential Path
          First → [Intermediates] → Last
          Pruning: Force through ALL intermediates
    ↓
    NO → MODE 5: Parallel Path (OR logic)
         First → {any of Intermediates} → Last
         Pruning: Force through AT LEAST ONE intermediate
```

---

## Pruning Logic Details

### When Does Pruning Happen?

Pruning ONLY happens when there are **interstitial/intermediate nodes** (nodes between start and end).

```
Mode 1 (Single):     [A]           → NO intermediates → NO pruning
Mode 2 (Two):        [A, B]        → NO intermediates → NO pruning  
Mode 3 (Multi-end):  [End1, End2]  → NO path forced → NO pruning
Mode 4 (Sequential): [A, B, C, D]  → Intermediates: {B, C} → PRUNE
Mode 5 (Parallel):   [A, B, C, D]  → Intermediates: {B, C} → PRUNE
Mode 6 (General):    [A, B, E, F]  → No path structure → NO pruning
```

### How Pruning Works

See `computeGlobalPruning` function (GraphCanvas.tsx:2816-2905):

1. **Identify interstitials**: All selected nodes EXCEPT first and last
2. **Build sibling groups**: Nodes that share a parent
3. **For each sibling group**:
   - If some (but not all) siblings are interstitial
   - Prune non-interstitial siblings
   - Calculate renormalization factor
4. **Apply during calculation**:
   - Skip pruned edges
   - Multiply remaining edges by renorm factor

### Example: Sequential with Pruning

```
Graph:
  Start → A → B → End
          ↓   ↓
          C   D

Selection: [A, B, End]

Interstitials: [B] (exclude Start=A and End)

Sibling Groups:
  Group 1 (parent=A): siblings={B, C}
    Selected: {B}
    Prune: A→C
    Renormalize: A→B gets full mass
    
  Group 2 (parent=B): siblings={D, End}
    Selected: {End}
    Prune: B→D
    Renormalize: B→End gets full mass

Final Calculation:
  P(A→End) = P(A→B) * renorm(A→B) * P(B→End) * renorm(B→End)
           = 0.6 * 1.67 * 0.5 * 2.0
           = 1.0 * 1.0
           = 1.0  (100% of A's mass reaches End via B)
```

---

## Integration with What-If Analysis

### Layering: What-If FIRST, Then Quick Selection

```
Layer 1: Base graph data
    ↓
Layer 2: What-If overrides (tab-specific)
    • caseOverrides: { caseNode: "variantA" }
    • conditionalOverrides: { edgeId: Set(["nodeX"]) }
    ↓
Layer 3: Quick Selection (ephemeral)
    • User Cmd+Clicks [A, C, E]
    • Additional pruning on top of what-if
    ↓
Layer 4: Path Analysis Display
    • Shows results with both layers applied
```

### Example: Combined What-If + Quick Selection

```
Base Graph:
  Start → CaseNode → VarA → B → End
                   → VarB → C → End

What-If (Tab 1):
  caseOverrides[CaseNode] = "VarA"
  Effect: VarA gets 100%, VarB gets 0%
  
Quick Selection (in Tab 1):
  User clicks: [CaseNode, B, End]
  Interstitials: [B]
  
Combined Effect:
  1. What-If forces VarA (VarB already 0%)
  2. Quick selection forces path through B
  3. At VarA: siblings={B, C}, selected={B}
     → Prune VarA→C
     → Renormalize VarA→B to 100%
  
Final Result in Path Panel:
  Probability: 100% (CaseNode→VarA→B→End)
  Cost: Cost through that path
  
But in Graph Rendering (Tab 1):
  Edge VarA→B width: Shows what-if probability (without quick selection)
  Edge VarA→C width: Shows what-if probability (without quick selection)
  
Path Panel shows stricter constraint than visual rendering!
```

---

## Special Cases and Edge Cases

### Case 1: Cycles in Selection

```
Graph: A → B → C → A (cycle)

Selection: [A, B, C]

Result:
  The DFS uses cycle detection (visited set)
  First path found: A→B→C
  When reaching A again: visited.has(A) = true → return cached
  Probability calculated correctly without infinite recursion
```

### Case 2: Multiple Start Nodes

```
Graph: StartA → B → End
       StartB → C → End

Selection: [B, End]

Result:
  Uses first start node only (StartA)
  Calculates: StartA → B → End
  
  TODO: Should we aggregate across all start nodes?
  Currently: No, uses first only
```

### Case 3: Disconnected Subgraphs

```
Graph: A → B  (disconnected from)  C → D

Selection: [A, C]

Result:
  Mode 2 (two nodes)
  Topological sort: [A, C] (arbitrary order if disconnected)
  Direct edge A→C? NO
  Indirect path? NO
  Probability: 0
  Display: "No path found"
```

### Case 4: Selection Includes Start Node

```
Graph: Start → A → B → End

Selection: [Start, B]

Result:
  Mode 2 (two nodes)
  Topologically: [Start, B]
  Calculate: Start → B
  No pruning (no intermediates)
  Works correctly
```

---

## Implementation Functions

### Helper Functions

**`findStartNodes(nodes, edges)`**
- Returns nodes with `entry.is_start = true` or `entry_weight > 0`

**`topologicalSort(nodeIds, edges)`**
- Sorts selected nodes in topological order
- Uses Kahn's algorithm
- Returns ordered array

**`areNodesTopologicallySequential(sortedIds, edges)`**
- Checks if each node has direct edge to next
- Returns boolean

**`computeGlobalPruning(start, end, selectedIds)`**
- Identifies interstitials (exclude start and end)
- Builds sibling groups
- Calculates excludedEdges and renormFactors
- See detailed algorithm in graphPruning.ts

**`findPathThroughIntermediates(start, end, givenNodes, excludedEdges, renormFactors)`**
- DFS from start to end
- Skips pruned edges
- Applies renormalization factors
- Tracks path context for conditional activation
- Returns { probability, expectedCosts }

---

## Return Types

### Mode 1: Single Node
```typescript
{
  type: 'single',
  node: Node,
  startNode: Node,
  isStartNode: boolean,
  pathProbability: number,
  pathCosts: { monetary, time, units }
}
```

### Mode 2: Two Nodes
```typescript
{
  type: 'path',
  nodeA: Node,
  nodeB: Node,
  directEdge: Edge | null,
  reverseEdge: Edge | null,
  pathProbability: number,
  pathCosts: { monetary, time, units },
  hasDirectPath: boolean,
  hasReversePath: boolean,
  isDirectPath: boolean,
  intermediateNodes: Node[]
}
```

### Mode 3: Multi-End
```typescript
{
  type: 'multi_end',
  endNodeProbabilities: Array<{
    node: Node,
    probability: number,
    expectedCosts: { monetary, time, units }
  }>,
  totalProbability: number,
  startNode: Node
}
```

### Mode 4/5: Sequential/Parallel Path
```typescript
{
  type: 'path_sequential',
  nodeA: Node,
  nodeB: Node,
  intermediateNodes: Node[],
  pathProbability: number,
  pathCosts: { monetary, time, units },
  sortedNodeIds: string[]
}
```

### Mode 6: General Multi
```typescript
{
  type: 'multi',
  selectedNodes: number,
  internalEdges: number,
  incomingEdges: number,
  outgoingEdges: number,
  totalIncomingProbability: number,
  totalOutgoingProbability: number,
  totalCosts: { monetary, time, units },
  probabilityConservation: boolean
}
```

---

## Testing Scenarios

### Test 1: Single Node (Start)
```
Selection: [Start]
Expected: probability=1.0, cost=0
```

### Test 2: Single Node (Middle)
```
Graph: Start → A (0.8) → B (0.6) → End
Selection: [B]
Expected: probability=0.8*0.6=0.48
```

### Test 3: Two Sequential
```
Graph: Start → A (0.7) → B (0.5) → End
Selection: [A, B]
Expected: probability=0.5, isDirect=true
```

### Test 4: Two with Intermediate
```
Graph: Start → A → X (0.4) → B
                 ↓
                 Y (0.6) → B
Selection: [A, B]
Expected: probability=0.4+0.6=1.0, isDirect=false, via=[X,Y]
```

### Test 5: Three Sequential with Pruning
```
Graph: Start → A → B (0.6) → End
                   ↓
                   C (0.4) → End
Selection: [A, B, End]
Expected: 
  - Prune A→C
  - Renorm A→B to 1.0
  - probability=1.0
```

### Test 6: Multi-End Comparison
```
Graph: Start → A → Success (0.7)
                   Failure (0.2)
                   Error (0.1)
Selection: [Success, Failure, Error]
Expected:
  type='multi_end'
  comparisons=[
    {Success, 0.7},
    {Failure, 0.2},
    {Error, 0.1}
  ]
  total=1.0
```

### Test 7: Parallel Paths (OR)
```
Graph: Start → A → B → End
                   ↓ ↗
                   C
Selection: [A, B, C, End]
Expected:
  Probability = P(A→B→End) + P(A→C→End)
  Both paths contribute
```

### Test 8: With What-If
```
Base: Start → CaseNode → VarA (weight=0.6) → End
                       → VarB (weight=0.4) → End

What-If: caseOverrides[CaseNode] = "VarA"

Quick Selection: [CaseNode, VarA, End]
Expected:
  What-if forces VarA=1.0, VarB=0.0
  Quick selection has no additional effect (VarA already selected)
  Probability = 1.0
```

---

## Common Pitfalls

### Pitfall 1: Confusing Display with Calculation

❌ **Wrong**: Quick selection changes edge widths  
✅ **Right**: Quick selection only affects Path Analysis panel

### Pitfall 2: Forgetting What-If Applies First

❌ **Wrong**: Quick selection overrides what-if  
✅ **Right**: What-if sets base, quick selection adds constraints

### Pitfall 3: Assuming Sequential = Linear

❌ **Wrong**: Sequential means no branching  
✅ **Right**: Sequential means direct edges exist, but siblings may exist and get pruned

### Pitfall 4: Thinking Pruning Affects All Modes

❌ **Wrong**: Pruning happens for all selections  
✅ **Right**: Pruning ONLY when intermediates exist (Modes 4 & 5)

---

## Code Architecture

### Core Libraries (NEW - Refactored)

**`lib/pathAnalysis.ts`** - Main entry point for all path calculations
- ✅ **`analyzeSelection()`** - Detects mode and routes to appropriate handler
- ✅ **`detectSelectionMode()`** - Determines which of 6 modes to use
- ✅ **`calculatePath()`** - Main path calculation with what-if + pruning
- ✅ **`calculatePathProbability()`** - DFS algorithm for probability/costs
- ✅ **`calculateMultiEndComparison()`** - Multi-end mode logic
- ✅ **`calculateGeneralStats()`** - General multi-selection stats
- ✅ **Topology helpers**: `topologicalSort()`, `areNodesTopologicallySequential()`
- ✅ **Node helpers**: `findStartNodes()`, `findEndNodes()`, `isEndNode()`

**`lib/graphPruning.ts`** - Shared pruning/renormalization
- ✅ **`computeGraphPruning()`** - Single code path for all pruning
- ✅ Handles what-if overrides + path selection
- ✅ Builds sibling groups, calculates renorm factors
- ✅ Used by both edge rendering AND path analysis

**`lib/whatIf.ts`** - What-if override logic
- ✅ **`computeEffectiveEdgeProbability()`** - Apply hyperpriors
- ✅ **`WhatIfOverrides`** type definition
- ✅ Handles conditional activation

### UI Components

**`GraphCanvas.tsx`**
- Uses `lib/pathAnalysis.ts` for all calculations
- Maintains legacy `calculateSelectionAnalysis` (should be migrated)
- Renders Path Analysis panel with results

**`WhatIfAnalysisControl.tsx`**
- UI for setting what-if overrides
- Updates `TabState.editorState`

---

## Migration Status

### ✅ Completed
- Extracted core algorithms to `lib/pathAnalysis.ts`
- Unified pruning logic in `lib/graphPruning.ts`
- Fixed what-if types (`Record<string, Set<string>>`)
- Documented all 6 modes

### 🚧 In Progress
- `GraphCanvas.tsx` still has inline `calculateSelectionAnalysis`
- Should be refactored to use `analyzeSelection()` from library

### 📋 Future Improvements

1. **Migrate GraphCanvas**: Replace inline logic with `analyzeSelection()`
2. **Aggregate multi-start**: Calculate probability from ALL start nodes, not just first
3. **Better naming**: Rename 'path_sequential' to 'path_constrained' for clarity
4. **Cycle handling**: Better UX for cyclic selections
5. **Performance**: Cache pruning results per what-if state
6. **Visualization**: Highlight pruned edges in graph (with strikethrough?)
7. **Testing**: Unit tests for each mode with edge cases

---

**End of Document**

