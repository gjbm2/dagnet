# What-If Analysis with Conditional Probabilities

## Overview

What-If analysis allows users to explore "what if" scenarios by forcing the graph to behave as if certain nodes were visited. This affects both:
1. **Conditional probability activation** (hyperpriors)
2. **Graph pruning and renormalization** (sibling elimination)

## The Algorithm

### 1. Conditional Probability Activation (Hyperpriors)

**Definition**: Conditional probabilities are "hyperpriors" - context-dependent probability distributions that activate based on which nodes have been visited in the path.

**Example**:
```json
{
  "edges": [{
    "from": "pricing",
    "to": "signup",
    "p": {"mean": 0.3},
    "conditional_p": [{
      "condition": {"visited": ["landing"]},
      "p": {"mean": 0.7}
    }]
  }]
}
```

**Base behavior**: 
- If user reaches `pricing` without visiting `landing`: 30% conversion
- If user reaches `pricing` after visiting `landing`: 70% conversion

**What-If override**:
```typescript
conditionalOverrides["pricing->signup"] = Set(["landing"])
```

**Effect**: Force the edge to behave as if `landing` was visited, using the 70% probability regardless of actual path.

### 2. Graph Pruning and Renormalization

When a user selects "What if: visited(nodeA)", the system must:

1. **Identify sibling nodes** - nodes that are alternatives to nodeA
2. **Prune unselected siblings** - exclude edges leading to non-selected siblings
3. **Renormalize probabilities** - redistribute the pruned probability mass

#### Algorithm Steps

**Step 1: Build Sibling Groups**

Siblings are nodes that share a common parent (for regular edges) or case node (for case variants).

```typescript
// Example: Node C has edges to D, E, F
siblingGroups = {
  "parent_C": {
    parent: "C",
    siblings: ["D", "E", "F"]
  }
}
```

**Step 2: Identify Selected Siblings**

For a path A → D → F (selected nodes: [A, D, F]):
- Interstitial nodes: [D] (nodes between start and end)
- In sibling group `parent_C`: D is selected, E and F are not

**Step 3: Calculate Effective Probabilities**

```typescript
// For each edge in the sibling group:
edges: [
  {id: "C->D", effectiveProb: 0.4},  // Selected
  {id: "C->E", effectiveProb: 0.3},  // Prune
  {id: "C->F", effectiveProb: 0.3}   // Prune
]

totalEffectiveProb = 0.4 + 0.3 + 0.3 = 1.0
prunedEffectiveProb = 0.3 + 0.3 = 0.6
remainingEffectiveProb = 0.4
```

**Step 4: Calculate Renormalization Factor**

```typescript
renormFactor = totalEffectiveProb / remainingEffectiveProb
             = 1.0 / 0.4
             = 2.5
```

**Step 5: Apply Renormalization**

```typescript
// Edge C->D gets renormalized:
finalProb = effectiveProb * renormFactor
          = 0.4 * 2.5
          = 1.0
```

**Result**: All probability mass that would have gone to E or F now flows through D.

### 3. Combining Both Effects

When a conditional what-if is applied, both mechanisms work together:

1. **First**: Compute effective probability (includes hyperprior activation)
2. **Then**: Apply pruning (based on forced visited nodes)
3. **Finally**: Apply renormalization

**Example Flow**:

```
User selects: "What if: visited(landing)"

Step 1: Hyperprior Activation
  - Edge "pricing->signup" checks conditional_p
  - Finds condition: visited(["landing"])
  - Uses probability: 0.7 (instead of base 0.3)

Step 2: Pruning
  - If "landing" is one of several entry points
  - Other entry points get pruned
  - "landing" and its descendants get renormalized

Step 3: Calculation
  - Path probability calculated with:
    * Hyperprior-adjusted probabilities
    * Pruned graph (excluding non-landing paths)
    * Renormalized mass distribution
```

## Implementation

### Current State

The pruning/renormalization algorithm is implemented in:
- **Path Analysis**: `computeGlobalPruning()` in `GraphCanvas.tsx` (lines 2816-2905)
- **Runner**: Similar logic in `runner.ts`

### What-If System

The What-If system should use the same pruning logic:

1. **User sets override**: `conditionalOverrides[edgeId] = Set(["nodeA"])`
2. **System treats as interstitial nodes**: Force path through specified nodes
3. **Apply pruning**: Use `computeGlobalPruning` with forced nodes
4. **Calculate probabilities**: Use pruned graph + renormalization factors

### Key Functions

**`computeEffectiveEdgeProbability(graph, edgeId, whatIfOverrides, ...)`**
- Input: `whatIfOverrides.conditionalOverrides[edgeId] = Set(["nodeA"])`
- Process:
  1. Check if edge has conditional_p
  2. If override exists, find matching conditional_p entry
  3. Use that conditional probability
  4. Apply renormalization if provided

**`computeGlobalPruning(pathStart, pathEnd, forcedNodes)`**
- Input: List of forced visited nodes
- Output: 
  - `excludedEdges`: Set of edge IDs to prune
  - `renormFactors`: Map of edge ID → renormalization multiplier

## Code Unification Plan

Currently, there are **two separate implementations**:
1. Path Analysis: `computeGlobalPruning` in GraphCanvas
2. Runner: Similar logic in runner.ts

**Goal**: Extract pruning/renormalization into a shared utility:

```typescript
// lib/graphPruning.ts
export function computePruning(
  graph: Graph,
  forcedNodes: Set<string>,
  whatIfOverrides: WhatIfOverrides
): {
  excludedEdges: Set<string>;
  renormFactors: Map<string, number>;
}
```

**Usage**:
```typescript
// Path Analysis
const pruning = computePruning(graph, interstitialNodes, whatIfOverrides);

// What-If Analysis
const forcedNodes = new Set([...caseImpliedNodes, ...conditionalOverrideNodes]);
const pruning = computePruning(graph, forcedNodes, whatIfOverrides);

// Runner
const pruning = computePruning(graph, pathNodes, whatIfOverrides);
```

## Testing Scenarios

### Scenario 1: Simple Conditional

```
Graph: landing → pricing → signup
Conditional: If visited(landing), pricing->signup = 0.7 (else 0.3)

What-If: visited(landing)
Expected: signup probability uses 0.7
```

### Scenario 2: Pruning with Conditionals

```
Graph: 
  - entry1 → nodeA (p=0.5)
  - entry2 → nodeB (p=0.5)
  - nodeA → signup (p=0.3, if visited(entry1): 0.7)
  - nodeB → signup (p=0.3, if visited(entry2): 0.6)

What-If: visited(entry1)
Expected:
  - entry2 → nodeB pruned
  - entry1 → nodeA renormalized to 1.0
  - nodeA → signup uses 0.7 (hyperprior active)
  - Final signup probability: 1.0 * 0.7 = 0.7
```

### Scenario 3: Multiple Conditionals

```
Graph:
  - A → B (p=0.5)
  - A → C (p=0.5)
  - B → D (p=0.4, if visited(A): 0.8)
  - C → D (p=0.3, if visited(A): 0.6)

What-If: visited(A) + path through B
Expected:
  - C branch pruned
  - B branch renormalized to 1.0
  - B → D uses 0.8 (hyperprior)
  - Final D probability: 1.0 * 0.8 = 0.8
```

## Sequencing and Order of Operations

### **Key Question: Does Processing Order Matter?**

**Answer: NO** - The current implementation is order-independent.

### **Why Order Doesn't Matter**

The algorithm has two phases:

**Phase 1: Compute Pruning (Atomic)**
```typescript
computeGlobalPruning(pathStart, pathEnd, allSelectedIds)
// Returns:
// - excludedEdges: Set of edges to skip
// - renormFactors: Map of edge → multiplier
```

This phase:
- Iterates all sibling groups in arbitrary order (line 2856)
- For each group, calculates `effectiveProb` with ALL what-if overrides already applied (line 2879)
- Stores renorm factors in a map (no order dependency)

**Phase 2: DFS Traversal (Forward Propagation)**
```typescript
calculateProbability(nodeId, pathContext)
// For each outgoing edge:
// 1. Skip if in excludedEdges
// 2. Get effectiveProb (with what-ifs)
// 3. Multiply by renormFactor
// 4. Recurse to target
```

This phase:
- Naturally processes in topological (forward) order via recursion
- Renormalization propagates correctly through multiplication
- Path context accumulates forward

### **Example: Multiple What-Ifs**

```
Graph:
  Start → CaseA (variants: X=0.6, Y=0.4) → B (conditional on X: 0.8, base: 0.5)
                                         → C (conditional on Y: 0.3, base: 0.5)

What-Ifs Applied:
  caseOverrides[CaseA] = "X"
  Force path through B (prune C)
```

**Phase 1: Compute Pruning (any order)**
```
Process CaseA siblings:
  - Edge CaseA→B (variant X): effectiveProb = 1.0 (case override)
  - Edge CaseA→C (variant Y): effectiveProb = 0.0 (case override)
  - B selected, C not selected
  - totalEffective = 1.0
  - prunedEffective = 0.0
  - remainingEffective = 1.0
  - renormFactor = 1.0 / 1.0 = 1.0 (no renorm needed - already 100%)
```

**Phase 2: DFS (forward)**
```
At Start:
  mass = 1.0

At CaseA:
  Edge Start→CaseA→B:
    effectiveProb = 1.0 (with case override)
    renormFactor = 1.0
    final = 1.0 * 1.0 = 1.0
  
  mass reaching B = 1.0

At B:
  Edge B→End:
    effectiveProb = 0.8 (conditional active because variant X selected)
    renormFactor = 1.0 (no siblings pruned)
    final = 0.8
    
  mass reaching End = 1.0 * 0.8 = 0.8
```

### **Critical Insight: Renorm Factors Don't Cascade**

Each renorm factor is **local to its parent node** and doesn't affect upstream or downstream renormalization. They're applied as independent multipliers during the forward traversal.

**This means:**
- Sibling groups can be processed in any order ✅
- Forward DFS ensures correct propagation ✅
- No topological sort needed for pruning ✅

## Application to What-If System

### **Critical Distinction: What-If vs Quick Selection**

There are TWO different systems with DIFFERENT scopes:

#### **1. What-If Analysis (Tab-Specific Display Effect)**
```typescript
User sets: What-If visited(nodeA) in Tab 1
Effect: Changes RENDERED edge widths in THAT TAB ONLY
Reason: User wants to SEE the graph "as if" nodeA was visited
Scope: TAB-SPECIFIC - affects only the tab where what-if is set
```

**Should affect (in that tab only):**
- ✅ Edge width calculations
- ✅ Edge tooltips  
- ✅ Node probability mass displays
- ✅ Path Analysis calculations (as base scenario)

**Should NOT affect:**
- ❌ Other tabs viewing the same file
- ❌ The underlying file data (non-destructive)

#### **2. Quick Selection / Path Analysis (Local Computation)**
```typescript
User clicks: nodes A, C, E  
Effect: Shows probability in Path Analysis panel ONLY
Reason: Temporary calculation, doesn't change visual graph
Scope: LOCAL - only affects Path Analysis panel display
```

**Should affect:**
- ✅ Path Analysis panel calculations
- ❌ Edge width rendering (graph looks unchanged)
- ❌ Tooltips (show base or what-if values, not selection values)

### **The Unified Code Path**

```typescript
// lib/graphPruning.ts - SINGLE SOURCE OF TRUTH
export function computeGraphPruning(
  graph,
  edges,
  whatIfOverrides,          // ALWAYS applied
  pathSelectedNodes?,       // ONLY for Path Analysis panel
  pathStart?, 
  pathEnd?
): { excludedEdges, renormFactors }
```

**Usage Pattern:**

```typescript
// 1. Edge Width Rendering (global display)
const pruning = computeGraphPruning(
  graph, 
  edges, 
  whatIfOverrides,
  undefined,  // NO quick selection
  undefined, 
  undefined
);
// Edge widths reflect what-if scenario

// 2. Path Analysis Panel (local computation)
const pruning = computeGraphPruning(
  graph,
  edges,
  whatIfOverrides,  // Applied FIRST (base scenario)
  pathSelectedNodes,  // Applied SECOND (on top of what-if)
  pathStart,
  pathEnd
);
// Panel shows: what-if scenario + path selection
```

### **State Hierarchy**

```
┌─────────────────────────────────────────────────────────────┐
│ LAYER 1: File Data (Per-File, Shared Across All Tabs)     │
│ ─────────────────────────────────────────────────────────── │
│ FileState.data & GraphStore.graph                           │
│ • Base probabilities: edge.p.mean = 0.3                     │
│ • Conditional probabilities: conditional_p[{...}]           │
│ • Case variants: node.case.variants[]                       │
│                                                              │
│ Scope: SHARED - Tab 1 and Tab 2 see identical data          │
│ Persistence: db.files (IndexedDB), saved to git on commit   │
│ Dirty Flag: Changes mark file as dirty                      │
└─────────────────────────────────────────────────────────────┘
                           ↓
┌─────────────────────────────────────────────────────────────┐
│ LAYER 2: Display Transform (Per-Tab, Non-Destructive)      │
│ ─────────────────────────────────────────────────────────── │
│ TabState.editorState.whatIfOverrides                        │
│ • caseOverrides: { nodeId: "variant-A" }                    │
│ • conditionalOverrides: { edgeId: Set(["nodeX"]) }          │
│                                                              │
│ Effect: Transform probabilities for DISPLAY in this tab     │
│ Scope: TAB-SPECIFIC - Tab 1 can show different scenario     │
│ Persistence: db.tabs (IndexedDB), survives refresh          │
│ Dirty Flag: Does NOT mark file dirty (non-destructive)      │
│                                                              │
│ Applied to:                                                  │
│ • Edge widths (visual rendering)                            │
│ • Edge tooltips (displayed probabilities)                   │
│ • Node mass displays (outgoing probability sums)            │
│ • Path Analysis calculations (base scenario)                │
└─────────────────────────────────────────────────────────────┘
                           ↓
┌─────────────────────────────────────────────────────────────┐
│ LAYER 3: Visual Rendering (Per-Tab, ReactFlow)             │
│ ─────────────────────────────────────────────────────────── │
│ ReactFlow nodes & edges (transformed presentation)          │
│ • Built via: toFlow(fileData) + applyWhatIfTransforms()     │
│ • Edge widths reflect what-if probabilities                 │
│ • Node positions, colours, labels                            │
│ • Selection, drag, zoom, hover states                       │
│                                                              │
│ Scope: TAB-SPECIFIC - each tab renders independently        │
│ Persistence: None (rebuilt on mount)                        │
└─────────────────────────────────────────────────────────────┘
                           ↓
┌─────────────────────────────────────────────────────────────┐
│ LAYER 4: Transient Analysis (Per-Tab, Ephemeral)           │
│ ─────────────────────────────────────────────────────────── │
│ Quick Selection (Cmd+Click nodes A, C, E)                   │
│ • selectedNodesForAnalysis (component state)                │
│ • Additional pruning ONLY for Path Analysis panel           │
│ • Applies ON TOP of what-if scenario                        │
│                                                              │
│ Effect: Path Analysis panel display ONLY                    │
│ Scope: TAB-SPECIFIC, EPHEMERAL (not persisted)              │
│ Persistence: None (lost on tab close or selection clear)    │
│                                                              │
│ Does NOT affect:                                             │
│ • Edge width rendering (graph looks same)                   │
│ • Edge tooltips (show what-if values)                       │
│ • Node mass displays (show what-if values)                  │
└─────────────────────────────────────────────────────────────┘
```

### **Data Flow Through Layers**

```
User Action: Set What-If in Tab 1

Tab 1:
  Layer 1: graph.edge.p.mean = 0.3 (unchanged)
         ↓
  Layer 2: conditionalOverrides["edge-1"] = Set(["nodeA"])
         ↓
  Layer 3: Edge renders with width for p=0.7 (transformed)
         ↓
  Layer 4: [no quick selection] → Path panel shows what-if values

Tab 2 (same file):
  Layer 1: graph.edge.p.mean = 0.3 (same as Tab 1)
         ↓
  Layer 2: {} (no what-if overrides)
         ↓
  Layer 3: Edge renders with width for p=0.3 (base)
         ↓
  Layer 4: [no quick selection] → Path panel shows base values
```

**Example:**
```
Base: Edge A→B has p=0.3, conditional: if visited(X) then p=0.7

Tab 1 - What-If: Set visited(X) = true
  → Edge renders with width for p=0.7 IN TAB 1 ONLY
  → Tab 1 graph visuals show p=0.7 scenario
  
Tab 2 - No What-If
  → Same edge renders with width for p=0.3
  → Tab 2 shows base scenario
  
In Tab 1, Quick Select: User clicks nodes A, C (forcing path, pruning B)
  → Path Analysis panel shows probability through A→C (with p=0.7 from what-if)
  → Edge A→B rendering in Tab 1 UNCHANGED (still shows p=0.7)
  → Only the Path Analysis panel display changes
```

### **Implementation Status**

1. ✅ **What-If hyperprior activation**: `computeEffectiveEdgeProbability` handles conditional overrides
2. ✅ **Path Analysis pruning**: `computeGlobalPruning` in GraphCanvas handles quick selection
3. ❌ **What-If pruning for edge widths**: Need to integrate `computeGraphPruning` into edge width calculations
4. ✅ **Unified code path**: Extracted to `lib/graphPruning.ts`

### **Next Steps**

1. Update `calculateEdgeWidth` in GraphCanvas to use `computeGraphPruning` with what-if overrides only
2. Update Path Analysis to use `computeGraphPruning` with what-if + path selection
3. Ensure runner uses the unified code path

## References

- Implementation: `GraphCanvas.tsx:2816-2905` (`computeGlobalPruning`)
- Application: `GraphCanvas.tsx:2607-2613` (renorm factor application)
- Type definitions: `lib/whatIf.ts` (`WhatIfOverrides`)
- Runner logic: `lib/runner.ts:241-447`

