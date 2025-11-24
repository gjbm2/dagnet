# Conditional Probability Feature Design

## Overview

This document outlines the design for implementing conditional probabilities on edges, where the probability of taking an edge can vary based on whether certain upstream nodes were visited in the user's journey.

**Example Use Case**: 
- Default: p(checkout | cart) = 0.5
- Conditional: p(checkout | cart AND visited_promo_page) = 0.7

## Key Design Decisions ✅

Based on review and discussion, the following decisions have been made:

1. **Colour Strategy**: Dynamic colour palette approach
   - Each conditional structure gets unique colour from algorithmic palette
   - User can optionally override colours
   - Colours persisted in JSON as display parameters
   - When conditional edge selected, highlights upstream dependency nodes in same colour
   - **Selection colour**: Bright blue (#007bff) reserved for selections
   - **Highlight colour**: Dark grey (#333333) for edge highlighting with fading
   
2. **Node Visual Strategy**: Consider shape-based differentiation
   - Use shapes (rectangle/diamond/octagon) for node types
   - Reserve colours for functional purposes (case variants, conditional groups)
   - Start/terminal indicated by icon/badge rather than colour

3. **Export Format**: JSON only
   - No CSV export planned
   - May add JPG/PNG visualization export (future, not priority)

4. **Quick View UI**: Add conditional scenario selector
   - Similar to case variants dropdown
   - UI-level only (not persisted)
   - Shows all unique conditions in graph
   - Allows "what-if" exploration of conditional scenarios

5. **Bayesian Compatibility**: ✅ Fully compatible
   - Current design supports future Bayesian analysis
   - Can add hyperprior fields incrementally
   - Structure naturally maps to hierarchical models
   - No conflicts with planned statistical inference features

6. **What-If Scenario Control**: ✅ Per-element granular control with multi-selection
   - Unified dropdown listing all case nodes and conditional edges
   - Per-element override capability (e.g., Promo=Treatment + Pricing=Control)
   - Multi-selection support for complex mixed scenarios
   - Always visible in top toolbar with active override chips
   - Not persisted - for analysis/validation only
   - Flexible mental model: "viewing graph with specific overrides active"

7. **Conditional Costs**: ❌ NOT implementing
   - Costs should NOT be conditional (only probabilities)
   - Cost variation better modeled as distinct outcome nodes
   - Keeps schema simpler and more focused
   - Can revisit if strong use cases emerge

---

## 1. Core Concept

### Problem Statement
Currently, edge probabilities are fixed values. In real-world scenarios, the probability of taking a particular path often depends on the user's prior journey. For example:
- Users who saw a promo page may be more likely to complete checkout
- Users who visited help documentation may have different abandonment rates
- Users who came from a specific source may have different conversion patterns

### Proposed Solution
Allow edges to specify conditional probabilities based on whether specific upstream nodes were visited during the journey.

---

## 2. Schema Design

### 2.1 Current Edge Schema
```json
{
  "id": "edge-1",
  "from": "cart",
  "to": "checkout",
  "p": {
    "mean": 0.5,
    "stdev": 0.05
  }
}
```

### 2.2 Proposed Edge Schema (Option A: Simple Conditions)

```json
{
  "id": "edge-1",
  "from": "cart",
  "to": "checkout",
  "p": {
    "mean": 0.5,
    "stdev": 0.05
  },
  "conditional_p": [
    {
      "condition": {
        "visited": ["promo-page"]
      },
      "p": {
        "mean": 0.7,
        "stdev": 0.05
      }
    },
    {
      "condition": {
        "visited": ["help-docs"]
      },
      "p": {
        "mean": 0.3,
        "stdev": 0.05
      }
    }
  ]
}
```

**Key Design Decisions**:
- `p` remains the **base/default** probability (used when no conditions match)
- `conditional_p` is an **optional** array of condition-probability pairs
- Conditions are evaluated in order; first match wins
- If no conditions match, fall back to base `p`

### 2.3 Proposed Edge Schema (Option B: Complex Conditions)

```json
{
  "id": "edge-1",
  "from": "cart",
  "to": "checkout",
  "p": {
    "mean": 0.5,
    "stdev": 0.05
  },
  "conditional_p": [
    {
      "condition": {
        "all_of": ["promo-page", "product-view"],
        "none_of": ["help-docs"]
      },
      "p": {
        "mean": 0.8,
        "stdev": 0.05
      }
    },
    {
      "condition": {
        "any_of": ["promo-page", "discount-page"]
      },
      "p": {
        "mean": 0.7,
        "stdev": 0.05
      }
    }
  ]
}
```

**Enhanced Features**:
- `all_of`: All specified nodes must have been visited
- `any_of`: At least one specified node must have been visited
- `none_of`: None of the specified nodes must have been visited
- Can combine multiple clauses for complex logic

### 2.4 Recommendation: Start with Option A

**Rationale**:
1. **Simpler to implement**: Less complex condition evaluation logic
2. **Easier to understand**: Users can reason about single-node conditions
3. **Covers 80% of use cases**: Most conditional logic is "if visited X, then Y"
4. **Extensible**: Can add Option B features later without breaking changes

**Proposed Initial Schema**:
```json
{
  "conditional_p": [
    {
      "condition": {
        "visited": ["node-id"],     // Array to support future multi-node conditions
        "description": "Optional human-readable explanation"
      },
      "p": {
        "mean": 0.7,
        "stdev": 0.05
      }
    }
  ],
  "display": {
    "conditional_colour": "#4ade80"  // Optional user override for edge colour
  }
}
```

**Note**: The `display` field is optional and only used if user wants to override the automatically assigned colour.

---

## 3. Validation Requirements

### 3.1 Current Validation
- Check that probabilities from each node sum to 1.0 (within tolerance)
- Warn if probabilities don't sum correctly

### 3.2 New Validation Requirements

#### 3.2.1 Per-Condition Probability Mass
For each node with outgoing edges, validate that probabilities sum to 1.0 **for each possible condition state**:

```
Given node N with outgoing edges [e1, e2, e3]:
  
For base case (no conditions matched):
  sum(e1.p.mean, e2.p.mean, e3.p.mean) ≈ 1.0

For condition "visited promo-page":
  sum(
    e1.conditional_p[visited:promo-page].mean OR e1.p.mean,
    e2.conditional_p[visited:promo-page].mean OR e2.p.mean,
    e3.conditional_p[visited:promo-page].mean OR e3.p.mean
  ) ≈ 1.0
```

#### 3.2.2 Condition Reference Validation
- Referenced nodes in conditions must exist in the graph
- Referenced nodes must be upstream of the conditional edge (no forward references)
- No circular condition dependencies

#### 3.2.3 Completeness Validation
**Challenge**: How to validate all possible condition combinations?

**Approach**: Validate "common conditions" rather than all combinations:
1. Validate base case (no conditions)
2. For each unique condition node referenced, validate that case
3. Warn (don't error) if coverage is incomplete

**Example Warning**:
```
⚠️ Node 'checkout' has conditional probabilities on edges:
   - edge-1: conditional on 'promo-page'
   - edge-2: no conditions
   
   Not all sibling edges have matching conditions. 
   Consider adding conditional_p to edge-2 for consistency.
```

### 3.3 Validation Algorithm

```typescript
function validateConditionalProbabilities(graph: Graph) {
  const errors: ValidationError[] = [];
  const warnings: ValidationWarning[] = [];
  
  // For each node
  for (const node of graph.nodes) {
    const outgoingEdges = graph.edges.filter(e => e.from === node.id);
    
    // Collect all unique conditions referenced by these edges
    const conditions = new Set<string>();
    for (const edge of outgoingEdges) {
      if (edge.conditional_p) {
        for (const cp of edge.conditional_p) {
          for (const nodeId of cp.condition.visited) {
            conditions.add(nodeId);
          }
        }
      }
    }
    
    // Validate base case
    const baseProbSum = outgoingEdges.reduce((sum, e) => sum + e.p.mean, 0);
    if (Math.abs(baseProbSum - 1.0) > 0.001) {
      errors.push({
        type: 'probability_sum',
        node: node.id,
        condition: 'base',
        sum: baseProbSum
      });
    }
    
    // Validate each condition
    for (const conditionNode of conditions) {
      const condProbSum = outgoingEdges.reduce((sum, edge) => {
        const condProb = edge.conditional_p?.find(
          cp => cp.condition.visited.includes(conditionNode)
        );
        return sum + (condProb?.p.mean ?? edge.p.mean);
      }, 0);
      
      if (Math.abs(condProbSum - 1.0) > 0.001) {
        errors.push({
          type: 'probability_sum',
          node: node.id,
          condition: conditionNode,
          sum: condProbSum
        });
      }
    }
    
    // Check for consistency warnings
    const edgesWithConditions = outgoingEdges.filter(e => e.conditional_p);
    if (edgesWithConditions.length > 0 && 
        edgesWithConditions.length < outgoingEdges.length) {
      warnings.push({
        type: 'incomplete_conditions',
        node: node.id,
        message: 'Some sibling edges have conditions, others do not'
      });
    }
  }
  
  return { errors, warnings };
}
```

---

## 4. Runner Logic Changes

### 4.1 State Tracking

Runners must track visited nodes during journey simulation:

```typescript
interface JourneyState {
  currentNode: string;
  visitedNodes: Set<string>;
  path: string[];
  costs: CostAccumulator;
}
```

### 4.2 Edge Probability Evaluation

```typescript
function getEdgeProbability(edge: Edge, visitedNodes: Set<string>): number {
  // Check conditional probabilities in order
  if (edge.conditional_p) {
    for (const conditionalProb of edge.conditional_p) {
      // Check if condition is satisfied
      const conditionMet = conditionalProb.condition.visited.every(
        nodeId => visitedNodes.has(nodeId)
      );
      
      if (conditionMet) {
        return conditionalProb.p.mean;
      }
    }
  }
  
  // Fall back to base probability
  return edge.p.mean;
}
```

### 4.3 Simulation Loop Changes

```typescript
function simulateJourney(graph: Graph, startNode: string): JourneyResult {
  const visitedNodes = new Set<string>();
  let currentNode = startNode;
  const path = [startNode];
  
  visitedNodes.add(startNode);
  
  while (!isTerminal(currentNode)) {
    const outgoingEdges = getOutgoingEdges(graph, currentNode);
    
    // Evaluate probabilities with current visited set
    const edgesWithProbs = outgoingEdges.map(edge => ({
      edge,
      probability: getEdgeProbability(edge, visitedNodes)
    }));
    
    // Select next edge based on probabilities
    const selectedEdge = selectEdgeByProbability(edgesWithProbs);
    
    if (!selectedEdge) break;
    
    currentNode = selectedEdge.edge.to;
    visitedNodes.add(currentNode);
    path.push(currentNode);
  }
  
  return { path, visitedNodes };
}
```

---

## 5. UI/Editor Changes

### 5.1 Edge Properties Panel Enhancements

**Current State**: Shows basic probability input field

**Proposed Enhancement**: Add collapsible "Conditions" section to edge properties panel

#### 5.1.1 Visual Layout

```
┌─────────────────────────────────────────────────┐
│ Edge Properties: checkout-edge                   │
├─────────────────────────────────────────────────┤
│ From: cart                                       │
│ To: checkout                                     │
│                                                  │
│ ▸ Basic Info                                    │
│   Slug: [checkout-flow          ]              │
│   Description: [User proceeds to checkout]      │
│                                                  │
│ ▾ Probability                                   │
│   ┌─────────────────────────────────────────┐  │
│   │ Base (Default)                          │  │
│   │ Used when no conditions match           │  │
│   │                                         │  │
│   │ Mean:    [0.50] (50.0%)                │  │
│   │ Std Dev: [0.05] (5.0%)                 │  │
│   └─────────────────────────────────────────┘  │
│                                                  │
│   ┌─────────────────────────────────────────┐  │
│   │ Conditional Probabilities (Optional)    │  │
│   │                                         │  │
│   │ [+ Add Condition]                       │  │
│   │                                         │  │
│   │ ─────────────────────────────────────  │  │
│   │ Priority 1 🔝                          │  │
│   │ If visited: [Promo Page ▾]            │  │
│   │                                         │  │
│   │ Mean:    [0.70] (70.0%)                │  │
│   │ Std Dev: [0.05] (5.0%)                 │  │
│   │                                         │  │
│   │ [✕ Remove] [⋮ Reorder]                 │  │
│   │ ─────────────────────────────────────  │  │
│   │                                         │  │
│   │ Priority 2                             │  │
│   │ If visited: [Help Docs ▾]             │  │
│   │                                         │  │
│   │ Mean:    [0.30] (30.0%)                │  │
│   │ Std Dev: [0.05] (5.0%)                 │  │
│   │                                         │  │
│   │ [✕ Remove] [⋮ Reorder]                 │  │
│   │ ─────────────────────────────────────  │  │
│   └─────────────────────────────────────────┘  │
│                                                  │
│   ⓘ Conditions are evaluated in priority order. │
│      First match wins.                          │
│                                                  │
│   ✓ Probability sums valid (base: 1.0)         │
│   ✓ Probability sums valid (if promo: 1.0)     │
│   ⚠ Probability sums invalid (if help: 0.8)    │
│                                                  │
│ ▸ Costs                                         │
│ ▸ Advanced                                      │
└─────────────────────────────────────────────────┘
```

#### 5.1.2 Interaction Flow: Adding a Condition

**Step 1: Click "+ Add Condition"**
```
┌─────────────────────────────────────────┐
│ Add Conditional Probability             │
├─────────────────────────────────────────┤
│                                         │
│ When should this probability apply?     │
│                                         │
│ ◉ If visited specific node(s)          │
│   [Select nodes... ▾]                   │
│   Upstream: Promo Page, Help Docs,      │
│             Product View, Landing       │
│                                         │
│ ○ If visited ALL of:                    │
│   (Multiple nodes must be visited)      │
│   [Available in v2]                     │
│                                         │
│ ○ If visited ANY of:                    │
│   (At least one node visited)           │
│   [Available in v2]                     │
│                                         │
│ [Cancel]              [Next: Probability]│
└─────────────────────────────────────────┘
```

**Step 2: Select Node(s)**
```
┌─────────────────────────────────────────┐
│ Select Nodes                             │
├─────────────────────────────────────────┤
│ Search: [promo___________] 🔍           │
│                                         │
│ Upstream nodes only:                    │
│                                         │
│ ☐ Landing Page (landing)               │
│ ☑ Promo Page (promo-page)              │
│ ☐ Product View (product-view)          │
│ ☐ Help Docs (help-docs)                │
│ ☐ Cart (cart)                           │
│                                         │
│ Selected: Promo Page                    │
│                                         │
│ [Back]                [Next: Probability]│
└─────────────────────────────────────────┘
```

**Step 3: Set Conditional Probability**
```
┌─────────────────────────────────────────┐
│ Set Conditional Probability              │
├─────────────────────────────────────────┤
│ If visited: Promo Page                   │
│                                         │
│ What is the probability when this        │
│ condition is met?                        │
│                                         │
│ Mean Probability:                        │
│ [0.70] → 70.0%                          │
│ ┌─────────────────┐                     │
│ │░░░░░░░█░░░░░░░░│ 70%                  │
│ └─────────────────┘                     │
│                                         │
│ Standard Deviation (Optional):           │
│ [0.05] → 5.0%                           │
│                                         │
│ ⓘ This probability will be used when    │
│   Promo Page was visited earlier in     │
│   the journey.                          │
│                                         │
│ [Back]                      [Add Condition]│
└─────────────────────────────────────────┘
```

#### 5.1.3 Visual Indicators

**Priority/Order Badges**:
- **Priority 1** 🔝: First condition checked (highest priority)
- **Priority 2, 3...**: Subsequent conditions
- Visual indicator: Numbered badge or "🔝" for first

**Validation Indicators**:
- ✓ **Green checkmark**: Probabilities sum correctly for this scenario
- ⚠ **Yellow warning**: Probabilities don't sum to 1.0 (with sum shown)
- ⓘ **Info icon**: Hover for explanation

**Interactive Elements**:
- **[⋮ Reorder]**: Drag handle or dropdown menu
  - Move Up
  - Move Down
  - Move to Top
- **[✕ Remove]**: Delete condition (with confirmation if not empty)
- **[Collapse/Expand]**: Each condition can be collapsed to save space

#### 5.1.4 Reordering Conditions

**Approach A: Drag-and-Drop** (Recommended for v1)
```
│ Priority 1 🔝 [⋮ Drag here]            │
│ If visited: Promo Page                 │
│ Mean: 0.70  Std Dev: 0.05             │
│                                        │
│ ↕ [Dragging...]                       │
│                                        │
│ Priority 2 [⋮]                         │
│ If visited: Help Docs                  │
│ Mean: 0.30  Std Dev: 0.05             │
```

**Approach B: Context Menu** (Fallback for accessibility)
```
Right-click on condition → Menu:
  Move to Top
  Move Up
  Move Down
  Move to Bottom
  ───────────
  Duplicate
  Remove
```

#### 5.1.5 Validation Feedback (Real-time)

**Scenario 1: Valid Probability Sums**
```
┌─────────────────────────────────────────┐
│ Validation Status                        │
├─────────────────────────────────────────┤
│ ✓ Base case: sum = 1.00 ✓              │
│ ✓ If visited promo: sum = 1.00 ✓       │
│ ✓ If visited help: sum = 1.00 ✓        │
└─────────────────────────────────────────┘
```

**Scenario 2: Invalid Probability Sum**
```
┌─────────────────────────────────────────┐
│ Validation Status                        │
├─────────────────────────────────────────┤
│ ✓ Base case: sum = 1.00 ✓              │
│ ⚠ If visited promo: sum = 0.85         │
│                                         │
│   From node "cart", edges sum to 0.85:  │
│   • checkout (this edge): 0.60          │
│   • abandon: 0.25                       │
│                                         │
│   Expected sum: 1.00 ± 0.001            │
│   [Show affected edges]                 │
└─────────────────────────────────────────┘
```

#### 5.1.6 Collapsed State (Space-Saving)

When user has multiple conditions, allow collapsing:

```
│ ▾ Probability                                 │
│   Base: p=0.50 ± 0.05                        │
│                                               │
│   ▸ 2 Conditional Probabilities ✓            │
│     • If promo: p=0.70                       │
│     • If help: p=0.30                        │
│                                               │
│   [+ Add Condition]                          │
```

Click to expand:
```
│ ▾ Probability                                 │
│   Base: p=0.50 ± 0.05                        │
│                                               │
│   ▾ 2 Conditional Probabilities ✓            │
│     │                                         │
│     ├─ Priority 1: If promo → p=0.70 ± 0.05 │
│     │  [Edit] [Remove]                       │
│     │                                         │
│     └─ Priority 2: If help → p=0.30 ± 0.05  │
│        [Edit] [Remove]                       │
│                                               │
│   [+ Add Condition]                          │
```

#### 5.1.7 Quick Actions & Shortcuts

**Keyboard Shortcuts**:
- `Ctrl/Cmd + K`: Add condition
- `Ctrl/Cmd + ↑/↓`: Reorder selected condition
- `Delete`: Remove selected condition
- `Escape`: Cancel adding condition

**Quick Actions Menu** (on condition):
- Duplicate condition (useful for similar conditions)
- Copy to clipboard (JSON)
- Paste from clipboard
- Clear all conditions

#### 5.1.8 Empty State

When no conditions exist:

```
┌─────────────────────────────────────────┐
│ Conditional Probabilities (Optional)     │
│                                         │
│   🔀 No conditions defined               │
│                                         │
│   Conditional probabilities allow this   │
│   edge's probability to change based on  │
│   which nodes were visited earlier.      │
│                                         │
│   Example: Users who saw a promo may be  │
│   more likely to complete checkout.      │
│                                         │
│   [+ Add Your First Condition]          │
│   [Learn More]                          │
└─────────────────────────────────────────┘
```

#### 5.1.9 Implementation Notes

**Component Structure**:
```typescript
<EdgePropertiesPanel edge={selectedEdge}>
  <Section title="Probability" defaultExpanded>
    <BaseProbability 
      value={edge.p} 
      onChange={handleBaseProbChange}
    />
    
    <ConditionalProbabilitiesSection
      conditions={edge.conditional_p || []}
      onAdd={handleAddCondition}
      onUpdate={handleUpdateCondition}
      onRemove={handleRemoveCondition}
      onReorder={handleReorderConditions}
      upstreamNodes={getUpstreamNodes(edge.from)}
      validationStatus={validateProbabilities(edge)}
    />
  </Section>
</EdgePropertiesPanel>
```

**State Management**:
- Changes are saved immediately (optimistic updates)
- Validation runs on every change (debounced 300ms)
- Undo/redo supported for all condition operations

**Accessibility**:
- Full keyboard navigation
- ARIA labels for all interactive elements
- Screen reader announcements for validation changes
- Focus management for modal dialogs

### 5.2 Condition Node Selector

When adding a condition, show a dropdown/autocomplete of valid upstream nodes:

```typescript
function getValidConditionNodes(edge: Edge, graph: Graph): Node[] {
  // Get all nodes that are upstream of the edge's source node
  const upstreamNodes = findUpstreamNodes(graph, edge.from);
  
  // Exclude the immediate source node (always visited)
  return upstreamNodes.filter(node => node.id !== edge.from);
}
```

### 5.3 Visual Indicators

**Edge Rendering**:
- Add small "C" badge on edges with conditional probabilities
- Show tooltip with conditions on hover
- Consider different edge style (dashed? dotted?) to indicate conditionality

**Validation Warnings**:
- Show warning icon on nodes where probability sums are incorrect
- Highlight specific condition that causes validation error
- Show tooltip with validation message

### 5.4 Global "What-If" Scenario Control 🎯

**Design Decision**: Per-element granular control with multi-selection

**Proposed Approach**: Unified dropdown listing all cases and conditionals, with per-element override capability

#### 5.4.1 Per-Element Scenario Selector

**Location**: Top toolbar/header (always visible)

**UI Design**:
```
┌─────────────────────────────────────────────────────────┐
│ Graph Editor                                             │
│ ┌───────────────────────────────────────────────────────┐│
│ │ 🎭 What-If Analysis: [Select Element ▾]  [Clear All]  ││
│ │ Active: [Promo Flow: Treatment ×] [checkout: promo ×] ││
│ └───────────────────────────────────────────────────────┘│
└─────────────────────────────────────────────────────────┘
```

**Element Selector Dropdown**:
```
[Select Element ▾]
├─ Case Nodes
│  ├─ 🎭 "Promo Flow" (case node name)
│  ├─ 🎭 "Pricing Test" (case node name)
│  └─ ...
├─ ─────────────────
├─ Conditional Edges
│  ├─ 🔀 "checkout-flow" (edge slug)
│  ├─ 🔀 "purchase-path" (edge slug)
│  └─ ...
```

**After selecting an element, sub-menu appears:**

**For Case Node**:
```
"Promo Flow" - Select Variant:
├─ Default (use actual weights)
├─ ─────────────────
├─ ✓ Control (0.5)
├─   Treatment (0.5)
└─ ─────────────────
```

**For Conditional Edge**:
```
"checkout-flow" - Select Condition:
├─ Base Case (default probability)
├─ ─────────────────
├─ ✓ If visited: promo-page
├─   If visited: help-docs
├─   If visited: both
└─ ─────────────────
```

#### 5.4.2 Behavior & Semantics

**Selection Behavior**:
- **Multi-Selection**: Can override multiple cases and conditionals simultaneously
- **Independent**: Each override is independent (e.g., "Promo=Treatment + Pricing=Control + checkout=if-promo")
- **Composable**: Supports complex what-if scenarios mixing different treatments
- **Clear Individual**: Click × on any active override chip to remove it
- **Clear All**: Button to reset all overrides at once

**State Updates**:
- Changes take effect immediately
- Visual feedback shows affected elements
- Edge probabilities update in real-time
- Validation runs with scenario-specific probabilities

#### 5.4.3 Visual Feedback

**Active Scenario Banner**:
```
⚠️ What-If Mode Active
Active: [Promo Flow: Treatment ×] [checkout-flow: if-promo ×]
```

**Element Highlighting**:
- Case edges with overrides: Purple glow + variant label badge
- Conditional edges with overrides: Conditional colour + scenario badge
- Affected probability labels: Update to show conditional values
- Dependency nodes: Highlight when conditional edge is affected

**Edge Label Updates**:
- Normal: `p=0.50`
- With case override: `p=0.50 (Treatment)`
- With conditional override: `p=0.70 (if promo)`

#### 5.4.4 Implementation Notes

**State Management**:
```typescript
interface WhatIfState {
  // Case node overrides: nodeId -> selected variant name
  caseOverrides: Map<string, string>;
  
  // Conditional edge overrides: edgeId -> set of visited nodes
  conditionalOverrides: Map<string, Set<string>>;
}

// Example state:
{
  caseOverrides: new Map([
    ['promo-flow-node-id', 'treatment'],
    ['pricing-test-node-id', 'control']
  ]),
  conditionalOverrides: new Map([
    ['checkout-edge-id', new Set(['promo-page-node-id'])],
    ['purchase-edge-id', new Set(['promo-page-node-id', 'help-docs-node-id'])]
  ])
}
```

**API Functions**:
```typescript
// Set/remove case variant override
function setCaseOverride(nodeId: string, variant: string | null) {
  if (variant === null) {
    whatIfState.caseOverrides.delete(nodeId);
  } else {
    whatIfState.caseOverrides.set(nodeId, variant);
  }
  updateVisualization();
}

// Set/remove conditional edge override
function setConditionalOverride(edgeId: string, visitedNodes: Set<string> | null) {
  if (visitedNodes === null) {
    whatIfState.conditionalOverrides.delete(edgeId);
  } else {
    whatIfState.conditionalOverrides.set(edgeId, visitedNodes);
  }
  updateVisualization();
}

// Clear all overrides
function clearAllOverrides() {
  whatIfState.caseOverrides.clear();
  whatIfState.conditionalOverrides.clear();
  updateVisualization();
}
```

**Not Persisted**:
- Scenario selection is UI-level only
- Reset when graph is closed/reopened
- Used for exploration and validation

**Use Cases**:
1. **"What if promo variant changes?"**: Override Promo Flow → Treatment
2. **"Compare checkout flow if user saw promo"**: Override checkout-flow → if visited: promo-page
3. **"Debug probability sums for specific scenario"**: Set multiple overrides and check validation
4. **"Present to stakeholders"**: Show impact of specific design decisions
5. **"Mixed scenarios"**: Treatment A + Control B + conditional C all at once

#### 5.4.5 Rationale: Why Per-Element Granular Control?

**Advantages of Per-Element Control**:
1. **Flexibility**: Mix different treatments (e.g., Treatment A + Control B)
2. **Precision**: Target specific elements rather than "all control"
3. **Discoverability**: See exactly what cases/conditionals exist in graph
4. **Composability**: Build complex scenarios from simple overrides
5. **Clear Intent**: Explicit about which entity is being modified
6. **Extends Existing Pattern**: Follows Quick View UI pattern users already understand

**Limitations of Bulk "All Control/Treatment" Approach**:
1. Too coarse: Assumes all case nodes have same variant names
2. Not composable: Can't mix Control A + Treatment B
3. Unclear state: What if some nodes don't have "treatment" variant?
4. Limited scenarios: Can't express "most control, but treatment for promo"

**Why This Is Better**:
- More flexible than bulk operations
- More discoverable than per-element properties panel
- Supports complex mixed scenarios
- Clear visual feedback on what's active
- Easy to reset (clear individual or all)

**Decision**: ✅ Implement per-element granular control with multi-selection

### 5.5 Bulk Operations

**Use Case**: User adds condition to one edge and wants to add matching condition to siblings

**Proposed Feature**: "Copy conditions to siblings" button
- Copies conditional structure to all sibling edges
- User adjusts probabilities to sum to 1.0
- Validates after bulk operation

---

## 6. Apps Script Runner Changes

### 6.1 State Tracking Enhancement

```javascript
function dagRun(graphId, numIterations, params, options) {
  var graph = getGraph(graphId);
  var results = [];
  
  for (var i = 0; i < numIterations; i++) {
    var journey = simulateJourney(graph, params);
    results.push(journey);
  }
  
  return aggregateResults(results);
}

function simulateJourney(graph, params) {
  var visitedNodes = {};  // Track visited nodes
  var currentNode = findStartNode(graph);
  var path = [currentNode.id];
  var costs = { monetary: 0, time: 0 };
  
  visitedNodes[currentNode.id] = true;
  
  while (!currentNode.absorbing && path.length < 1000) {
    var outgoingEdges = getOutgoingEdges(graph, currentNode.id);
    
    // Evaluate conditional probabilities
    var edgesWithProbs = outgoingEdges.map(function(edge) {
      return {
        edge: edge,
        probability: getEdgeProbability(edge, visitedNodes, params)
      };
    });
    
    var selectedEdge = selectEdgeByProbability(edgesWithProbs);
    if (!selectedEdge) break;
    
    currentNode = findNodeById(graph, selectedEdge.edge.to);
    visitedNodes[currentNode.id] = true;
    path.push(currentNode.id);
    
    // Accumulate costs...
  }
  
  return {
    path: path,
    costs: costs,
    visitedNodes: visitedNodes
  };
}

function getEdgeProbability(edge, visitedNodes, params) {
  // Check conditional probabilities
  if (edge.conditional_p) {
    for (var i = 0; i < edge.conditional_p.length; i++) {
      var conditionalProb = edge.conditional_p[i];
      var conditionMet = true;
      
      // Check if all visited nodes in condition are satisfied
      for (var j = 0; j < conditionalProb.condition.visited.length; j++) {
        if (!visitedNodes[conditionalProb.condition.visited[j]]) {
          conditionMet = false;
          break;
        }
      }
      
      if (conditionMet) {
        // Use conditional probability
        return sampleFromDistribution(conditionalProb.p, params);
      }
    }
  }
  
  // Fall back to base probability
  return sampleFromDistribution(edge.p, params);
}
```

---

## 7. Implementation Plan

### Phase 1: Schema & Validation (Week 1)
1. ✅ Update TypeScript types to include `conditional_p`
2. ✅ Update JSON schema validation
3. ✅ Implement validation logic for conditional probabilities
4. ✅ Add validation error messages and warnings
5. ✅ Write unit tests for validation logic

**Deliverables**:
- Updated `types.ts` with conditional probability types
- Validation function that checks probability sums for each condition
- Test graphs with various conditional scenarios

### Phase 2: Runner Logic (Week 2)
1. ✅ Update TypeScript runner to track visited nodes
2. ✅ Implement conditional probability evaluation
3. ✅ Update simulation loop to use conditional probabilities
4. ✅ Add logging/debugging for condition evaluation
5. ✅ Write unit tests for runner with conditional probabilities

**Deliverables**:
- Updated runner that handles conditional probabilities
- Test suite with various conditional scenarios
- Performance benchmarks (ensure no significant slowdown)

### Phase 3: UI/Editor (Week 3)
1. ✅ Update edge properties panel to show conditional section
2. ✅ Implement condition node selector
3. ✅ Add "Add Condition" / "Remove Condition" buttons
4. ✅ Show validation errors in real-time
5. ✅ Add visual indicators for conditional edges (colour palette system)
6. ✅ Update tooltips to show conditions
7. ✅ Implement "Quick View" conditional scenario selector
8. ✅ Add upstream dependency highlighting when conditional edge selected
9. ✅ Implement colour override UI for conditional groups

**Deliverables**:
- Updated properties panel with conditional UI
- Dynamic colour palette for conditional edges
- Conditional scenario quick view dropdown
- Visual indicators and dependency highlighting
- Real-time validation feedback

### Phase 4: Apps Script (Week 4)
1. ✅ Update Apps Script runner logic
2. ✅ Implement conditional probability evaluation
3. ✅ Test with real Google Sheets integration
4. ✅ Update documentation for Apps Script usage
5. ✅ Add examples with conditional probabilities

**Deliverables**:
- Updated Apps Script with conditional support
- Example graphs demonstrating conditional probabilities
- Updated Apps Script documentation

### Phase 5: Testing & Documentation (Week 5)
1. ✅ End-to-end testing with complex graphs
2. ✅ Performance testing with large graphs
3. ✅ Update user documentation
4. ✅ Create tutorial/examples
5. ✅ Migration guide for existing graphs

**Deliverables**:
- Comprehensive test suite
- User documentation
- Example graphs and tutorials

---

## 8. Edge Cases & Considerations

### 8.1 Circular Dependencies
**Problem**: What if condition references create cycles?

**Solution**: 
- Validate that condition nodes are strictly upstream
- Use topological sort to detect cycles
- Error on circular condition references

### 8.2 Multiple Matching Conditions
**Problem**: What if multiple conditions match?

**Solution**: First match wins (order matters in array)
- Document this behavior clearly
- Consider adding "priority" field in future version

### 8.3 Condition Node Doesn't Exist
**Problem**: Referenced node is deleted or doesn't exist

**Solution**:
- Validation catches this at save time
- Runtime: log warning and fall back to base probability
- Consider "dangling condition cleanup" tool

### 8.4 Performance Impact
**Problem**: Condition evaluation adds overhead

**Mitigation**:
- Cache visited node set (already doing this)
- Early exit on condition evaluation
- Consider pre-compiling conditions into decision tree

**Benchmark Target**: < 5% slowdown on simulation performance

### 8.5 Backward Compatibility
**Problem**: Existing graphs don't have `conditional_p`

**Solution**:
- Field is optional
- Absence of field means no conditional behavior
- All existing graphs work unchanged

### 8.6 What-If Analysis
**Problem**: How does what-if analysis interact with conditional probabilities?

**Options**:
1. **Ignore conditions in what-if**: Only vary case variant probabilities
2. **Apply conditions normally**: Conditions evaluated as usual
3. **Allow conditional variation**: Let user vary conditional probabilities too

**Recommendation**: Start with Option 2 (apply normally), add Option 3 later

---

## 9. Alternative Designs Considered

### 9.1 Global Condition Table
Instead of per-edge conditions, maintain global condition-to-probability mapping:

```json
{
  "conditions": {
    "promo-page-visited": {
      "test": { "visited": ["promo-page"] },
      "edges": {
        "edge-1": { "p": { "mean": 0.7 } },
        "edge-2": { "p": { "mean": 0.3 } }
      }
    }
  }
}
```

**Pros**: Easier to see all edges affected by a condition
**Cons**: More complex to edit, harder to validate, separation of concerns

**Decision**: Rejected in favor of per-edge conditions

### 9.2 Conditional Nodes Instead of Conditional Edges
Create special "condition" node types that split based on history:

```json
{
  "type": "condition",
  "test": { "visited": ["promo-page"] },
  "true_edge": "edge-1",
  "false_edge": "edge-2"
}
```

**Pros**: Explicit in graph structure, easier to visualize
**Cons**: Graph becomes more complex, harder to maintain, not how users think about it

**Decision**: Rejected - adds complexity without clear benefit

### 9.3 JavaScript Expression Language
Allow arbitrary JavaScript expressions as conditions:

```json
{
  "condition": "visitedNodes.has('promo') && !visitedNodes.has('help')"
}
```

**Pros**: Maximum flexibility
**Cons**: Security risk, hard to validate, hard to visualize, error-prone

**Decision**: Rejected - too dangerous and complex

---

## 10. Open Questions

### 10.1 Should Costs Be Conditional?

**Question**: Should we support conditional costs in addition to conditional probabilities?

**Example Scenarios**:
- "If user visited help docs, support costs are lower"
- "If user came from promo page, they get a discount (lower monetary cost)"
- "If user is returning customer, transaction time is faster"

**Analysis**:

**Arguments FOR Conditional Costs**:
1. Some costs genuinely vary based on path taken
2. Promotions/discounts are path-dependent
3. Symmetry with conditional probabilities (both are edge properties)
4. Could be useful for optimization ("which paths minimize cost given promo?")

**Arguments AGAINST Conditional Costs**:
1. **Most variation is in probabilities, not costs**
   - Business logic: "Will they take this path?" (probability)
   - Less common: "How much does path cost given their journey?" (cost)

2. **Costs usually depend on destination, not journey**
   - Checkout cost is checkout cost, regardless of how you got there
   - Support call cost is support call cost
   - Time to complete task is usually outcome-specific

3. **Complexity doubles**
   - Would need `conditional_costs` field
   - Validation becomes more complex
   - UI becomes more cluttered
   - Apps Script logic more complex

4. **Workaround exists**: Model cost variations as separate nodes
   - Instead of: "checkout with promo discount"
   - Create: "checkout-with-promo" node (lower cost) and "checkout-no-promo" node
   - Use conditional probability to route between them

5. **Edge cases are rare**
   - 95% of cost variation can be modeled with node-level costs
   - Path-dependent costs are exceptional cases
   - Better to handle exceptions explicitly (separate nodes) than complicate all costs

**Real-World Example**:
```
Current approach (WITHOUT conditional costs):
- Node "cart" → Edge (p=0.3) → Node "checkout-full-price" (cost=$0)
- Node "cart" → Edge (p=0.7) → Node "checkout-discounted" (cost=$-10)

Alternative (WITH conditional costs):
- Node "cart" → Edge (p=1.0, conditional_costs) → Node "checkout"
  - Base cost: $0
  - If visited promo: $-10
```

The current approach is clearer: separate outcomes are separate nodes.

**Decision**: ✅ **Do NOT implement conditional costs**

**Rationale**:
1. Cost variation is better modeled with distinct outcome nodes
2. Keeps schema simpler and more focused
3. Probability conditioning covers 95% of use cases
4. Can always add conditional costs later if truly needed
5. Forces users to think clearly about outcomes vs. journeys

**Future Consideration**: 
- If strong use cases emerge, revisit in v2
- Would need same validation/UI/runner changes as conditional probabilities
- Not a technical blocker, just a complexity/clarity trade-off

### 10.2 Naming
- `conditional_p` vs `conditional_probability` vs `conditions` vs `conditional_probs`?
- **Recommendation**: `conditional_p` (matches existing `p` field naming)

### 10.3 UI Placement
- Show conditions inline in properties panel or in separate tab?
- **Recommendation**: Inline, but collapsible section

### 10.4 Visualization ✅ DECIDED

**Edge Colouring Strategy**:

**Option A: Fixed Colour (Simpler)**
- Conditional edges: Green (to distinguish from purple case edges)
- Pro: Simple, consistent, easy to implement
- Con: Can't distinguish between different conditional groups

**Option B: Dynamic Colour Palette (Recommended)**
- Each unique conditional structure gets a distinct colour from an algorithmic palette
- Colours assigned deterministically based on condition signature
- User can optionally override colour choice
- Colour choice persisted in edge JSON as display parameter (like node position)
- Pro: Can visually group related conditions, user can highlight areas of interest
- Con: More complex, need to manage colour assignments

**Recommendation**: Start with Option B for maximum flexibility

**Colour Management**:
```json
{
  "conditional_p": [...],
  "display": {
    "conditional_colour": "#4ade80"  // Optional user override
  }
}
```

**Node Type Visual Strategy**:
- Consider using **shape** rather than colour for node types (normal vs case vs terminal)
- Reserve **colour** for functional/analytical purposes (case variants, conditional groups)
- Example: Terminal nodes = octagon, Case nodes = diamond, Normal = rectangle
- Start node: Use icon/badge rather than colour

**Selection Highlighting**:
- When a conditional edge is selected, highlight (in same colour) the upstream nodes it depends on
- Creates visual trace of conditional dependency chain
- Fading intensity based on distance (like current recursive highlighting)

**Colour Palette Algorithm**:
```typescript
function getConditionalColour(edge: Edge): string {
  // Check for user override first
  if (edge.display?.conditional_colour) {
    return edge.display.conditional_colour;
  }
  
  // Generate deterministic colour based on condition signature
  const conditionSignature = edge.conditional_p
    ?.map(cp => cp.condition.visited.sort().join('+'))
    .sort()
    .join('||');
  
  // Use hash of signature to pick from colour palette
  const hash = simpleHash(conditionSignature);
  const paletteIndex = hash % CONDITIONAL_COLOUR_PALETTE.length;
  
  return CONDITIONAL_COLOUR_PALETTE[paletteIndex];
}

// Sensible colour palette (avoiding blue for selections, purple reserved for cases)
const CONDITIONAL_COLOUR_PALETTE = [
  '#4ade80', // green-400
  '#f87171', // red-400
  '#fbbf24', // amber-400
  '#34d399', // emerald-400
  '#fb923c', // orange-400
  '#2dd4bf', // teal-400
  '#f472b6', // pink-400
  '#facc15', // yellow-400
  '#a78bfa', // violet-400 (slightly different from case purple)
  '#8b5cf6', // purple-500 (for cases if needed)
];
```

**Colour Philosophy**:
- **Blue (#007bff)**: Reserved for selections (nodes, edges, control points)
- **Purple (#C4B5FD, #8b5cf6)**: Reserved for case edges and variants
- **Dark Grey (#333333)**: Used for edge highlighting with fading intensity
- **Palette colours**: Available for conditional groupings
- **Light Gray (#b3b3b3)**: Default edge colour

**Benefits**:
- Same condition structure always gets same colour (consistency)
- Different conditions get different colours (differentiation)
- User can override if they want specific colour (flexibility)
- Clear visual hierarchy: blue=selection, purple=cases, palette=conditionals, black=highlights

### 10.5 Limits
- Maximum number of conditions per edge?
- Maximum depth of upstream reference?
- **Recommendation**: Soft limit of 10 conditions per edge, 10-level upstream depth

### 10.6 Export/Import ✅ DECIDED
- No CSV export planned
- JSON format only (current approach)
- Conditional probabilities stored inline in edge definitions
- Future: May add JPG/PNG export for visualization (not priority)
- JSON schema naturally handles nested conditional structures

---

## 11. Success Metrics

### 11.1 Functional Requirements
- ✅ Users can add conditional probabilities to edges
- ✅ Validation catches probability sum errors under all conditions
- ✅ Runner correctly evaluates conditional probabilities
- ✅ Apps Script runner produces same results as TypeScript runner

### 11.2 Performance Requirements
- ✅ < 5% slowdown on simulation performance
- ✅ < 10% increase in graph file size (for graphs with conditions)
- ✅ Validation completes in < 1 second for graphs with < 1000 nodes

### 11.3 Usability Requirements
- ✅ Users can add a condition in < 30 seconds
- ✅ Validation errors are clear and actionable
- ✅ No learning curve for users who don't need conditions

---

## 12. Risks & Mitigation

| Risk | Impact | Probability | Mitigation |
|------|--------|-------------|------------|
| Complex validation logic has bugs | High | Medium | Extensive unit tests, gradual rollout |
| Performance degradation | Medium | Low | Benchmark testing, optimize if needed |
| User confusion about conditions | Medium | Medium | Clear documentation, examples, tooltips |
| Backward compatibility issues | Low | Low | Make feature optional, test with existing graphs |
| Apps Script implementation difficulty | Medium | Medium | Prototype early, consider limitations |

---

## 13. Future Enhancements

### 13.1 Complex Conditions (v2)
- Add `all_of`, `any_of`, `none_of` logic
- Allow combining multiple conditions

### 13.2 Condition Templates (v2)
- Save common conditions as templates
- Apply template to multiple edges

### 13.3 Condition Visualization (v2)
- Show dependency graph of conditions
- Highlight affected edges when condition node is selected

### 13.4 Parametric Conditions (v3)
- Allow conditions based on cost thresholds
- Allow conditions based on path length

### 13.5 A/B Test Conditions (v3)
- Special conditions for case node variants
- Conditional probabilities that vary by variant

### 13.6 Bayesian Analysis & Hyperpriors (v4) 🔬

**Goal**: Use conditional probabilities to identify and model hyperpriors in Bayesian analysis

**Concept**:
- Conditional probabilities naturally represent structured uncertainty
- `p(checkout | visited_promo)` vs `p(checkout | not_visited_promo)` suggests a hyperprior on "promo effect"
- Can use observed data to fit both base and conditional distributions

**Compatibility Check with Current Design**:

✅ **Compatible Aspects**:
1. **Explicit Structure**: Conditions create named, identifiable parameters
   - Can directly map to hyperprior variables in Bayesian model
   - Clear separation between base and conditional cases
   
2. **Validation Framework**: Probability sum constraints are Bayesian-compatible
   - Conditional probability sums = normalization constraints
   - Can extend to joint distribution constraints
   
3. **Upstream-only References**: Prevents cyclic dependencies
   - Maintains causal structure needed for Bayesian inference
   - Topological ordering = inference ordering
   
4. **Optional Field**: Backward compatible
   - Can gradually add hyperpriors to existing models
   - Not all edges need conditional structure

✅ **Design Extensions Needed**:
1. **Prior Distributions**: Add ability to specify uncertainty over conditions
   ```json
   {
     "conditional_p": [{
       "condition": { "visited": ["promo"] },
       "p": { 
         "mean": 0.7, 
         "stdev": 0.05,
         "prior": {
           "type": "beta",
           "alpha": 7,
           "beta": 3
         }
       }
     }]
   }
   ```

2. **Correlation Structure**: Allow specifying correlation between conditional effects
   ```json
   {
     "hyperpriors": {
       "promo_effect": {
         "applies_to": ["edge-1", "edge-2", "edge-3"],
         "correlation": 0.8
       }
     }
   }
   ```

3. **Data Attachment**: Link observed data to conditions
   ```json
   {
     "conditional_p": [{
       "condition": { "visited": ["promo"] },
       "observed_data": {
         "successes": 70,
         "trials": 100,
         "confidence": 0.95
       }
     }]
   }
   ```

**Implementation Considerations**:

**Phase 1 (Current)**: Store structure, ignore hyperpriors
- Current design: `conditional_p` with mean/stdev
- Runner: Use mean values as-is
- No fitting yet

**Phase 2 (Hyperpriors)**: Add Bayesian fitting
- Extend schema to include prior specifications
- Runner: Sample from posterior distributions
- Fit model to observed data

**Phase 3 (Correlation)**: Model correlated effects
- Add hyperprior groups
- Joint inference across related conditions
- Hierarchical models

**Recommendation**: 
- ✅ Current design is **fully compatible** with Bayesian analysis goals
- Structure naturally maps to hyperprior framework
- Can add Bayesian features incrementally without breaking changes
- Consider adding `prior` field to schema now (optional, future-proofing)

---

## 14. Review Checklist

Before implementation:
- [ ] Schema design reviewed and approved
- [ ] Validation approach agreed upon
- [ ] UI mockups reviewed
- [ ] Performance benchmarks defined
- [ ] Test cases documented
- [ ] Documentation plan approved
- [ ] Migration strategy defined

---

## 15. Appendix: Example Scenarios

### Example 1: Simple Promo Effect
```json
{
  "nodes": [
    { "id": "promo", "label": "Promo Page" },
    { "id": "cart", "label": "Cart" },
    { "id": "checkout", "label": "Checkout" }
  ],
  "edges": [
    {
      "from": "cart",
      "to": "checkout",
      "p": { "mean": 0.5 },
      "conditional_p": [
        {
          "condition": { "visited": ["promo"] },
          "p": { "mean": 0.7 }
        }
      ]
    }
  ]
}
```

### Example 2: Help Documentation Effect
```json
{
  "edges": [
    {
      "from": "form",
      "to": "submit",
      "p": { "mean": 0.6 },
      "conditional_p": [
        {
          "condition": { "visited": ["help"] },
          "p": { "mean": 0.8 }
        }
      ]
    },
    {
      "from": "form",
      "to": "abandon",
      "p": { "mean": 0.4 },
      "conditional_p": [
        {
          "condition": { "visited": ["help"] },
          "p": { "mean": 0.2 }
        }
      ]
    }
  ]
}
```

Note: probabilities sum to 1.0 both with and without help visit.

---

**Document Status**: APPROVED - Ready for implementation
**Author**: AI Assistant
**Reviewed By**: User
**Date**: 2025-10-20
**Version**: 2.1

**Recent Changes (v2.1)**:
- Updated Section 5.4 with per-element granular control approach
- Revised What-If UI design for multi-selection and composable scenarios
- Updated Key Design Decisions section
- **Added comprehensive UX design for Section 5.1** (Edge Properties Panel)
  - Complete visual layouts and interaction flows
  - 3-step wizard for adding conditions
  - Drag-and-drop reordering with context menu fallback
  - Real-time validation feedback
  - Keyboard shortcuts and accessibility features
  - Component structure and implementation notes

**Key Decisions Finalized**:
- ✅ Schema design (per-edge conditional_p with visited array)
- ✅ Colour strategy (dynamic palette with user overrides)
- ✅ What-If control (per-element with multi-selection, not bulk)
- ✅ Edge Properties Panel UX (comprehensive design in Section 5.1)
- ✅ Condition ordering (drag-and-drop with context menu)
- ✅ Bayesian compatibility confirmed
- ✅ Export format (JSON only)
- ✅ Node shape vs colour strategy

**Ready to Proceed**: All phases ready - full implementation can begin immediately

