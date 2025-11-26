# Analysis Return Schema Design

## Overview

This document defines the standard return schema for all analysis runners. The goal is a **consistent, self-describing structure** that display adaptors can render without special-casing each analysis type.

## Problem Statement

Analysis results need to support multiple display patterns:

1. **Columnar blocks** - One card/column per scenario, each showing full results
2. **Comparative charts** - Bar charts with grouped bars (e.g., one group per funnel stage, one bar per scenario within each group)
3. **Tables** - Rows and columns that could be pivoted either way

The return schema must:
- Be consistent regardless of scenario count (1 or many)
- Self-describe its structure so adaptors know how to render
- Support flexible grouping (by scenario, by stage, by outcome, etc.)

## Schema Definition

### Top-Level Structure

```typescript
interface AnalysisResult {
  analysis_type: string;        // Runner ID: "path", "outcome_comparison", etc.
  analysis_name: string;        // Human-readable: "Path Between Nodes"
  analysis_description: string; // Extended description
  
  metadata: Record<string, any>; // Analysis-specific context (nodes, labels, etc.)
  
  structure: {
    primary: GroupingDimension;      // What the top-level array iterates over
    secondary?: GroupingDimension;   // What's nested within each primary item
    display_hint: DisplayHint;       // Suggested rendering approach
  };
  
  data: DataItem[];  // Array of items, shape depends on structure
}

type GroupingDimension = 
  | "scenario"   // Iterate over scenarios
  | "stage"      // Iterate over funnel stages (path waypoints)
  | "outcome"    // Iterate over absorbing nodes
  | "node"       // Iterate over selected nodes
  | "branch";    // Iterate over parallel branches

type DisplayHint =
  | "funnel"      // Funnel/waterfall chart (stages with drop-off)
  | "comparison"  // Side-by-side bar chart comparison
  | "columnar"    // One block/card per primary item
  | "table"       // Tabular display
  | "single";     // Single value display
```

### DataItem Structure

The shape of items in `data` depends on `structure.primary`:

```typescript
// When primary = "scenario"
interface ScenarioPrimaryItem {
  scenario_id: string;
  scenario_name: string;
  // ... analysis-specific fields (probability, outcomes, etc.)
}

// When primary = "stage" (with secondary = "scenario")
interface StagePrimaryItem {
  stage: number;
  node_id: string;
  label: string;
  values: ScenarioValue[];  // One per scenario
}

interface ScenarioValue {
  scenario_id: string;
  scenario_name: string;
  probability: number;
  expected_cost_gbp?: number;
  expected_cost_time?: number;
  // ... other metrics
}

// When primary = "outcome" (with secondary = "scenario")
interface OutcomePrimaryItem {
  outcome_id: string;
  label: string;
  values: ScenarioValue[];
}
```

## Example Returns by Analysis Type

### 1. Path Analysis (Funnel)

Best for: Showing probability drop-off through a path, comparing scenarios at each stage.

```json
{
  "analysis_type": "path",
  "analysis_name": "Path Between Nodes",
  "analysis_description": "Probability of reaching end from start via waypoints",
  
  "metadata": {
    "from_node": "entry",
    "from_label": "Entry Point",
    "to_node": "success",
    "to_label": "Success",
    "intermediate_nodes": ["step1", "step2"]
  },
  
  "structure": {
    "primary": "stage",
    "secondary": "scenario",
    "display_hint": "funnel"
  },
  
  "data": [
    {
      "stage": 0,
      "node_id": "entry",
      "label": "Entry Point",
      "values": [
        {"scenario_id": "current", "scenario_name": "Current", "probability": 1.0},
        {"scenario_id": "optimistic", "scenario_name": "Optimistic", "probability": 1.0}
      ]
    },
    {
      "stage": 1,
      "node_id": "step1",
      "label": "Step 1",
      "values": [
        {"scenario_id": "current", "scenario_name": "Current", "probability": 0.8},
        {"scenario_id": "optimistic", "scenario_name": "Optimistic", "probability": 0.9}
      ]
    },
    {
      "stage": 2,
      "node_id": "step2",
      "label": "Step 2",
      "values": [
        {"scenario_id": "current", "scenario_name": "Current", "probability": 0.64},
        {"scenario_id": "optimistic", "scenario_name": "Optimistic", "probability": 0.81}
      ]
    },
    {
      "stage": 3,
      "node_id": "success",
      "label": "Success",
      "values": [
        {"scenario_id": "current", "scenario_name": "Current", "probability": 0.51},
        {"scenario_id": "optimistic", "scenario_name": "Optimistic", "probability": 0.73}
      ]
    }
  ]
}
```

### 2. Outcome Comparison

Best for: Comparing probability of reaching different end states.

```json
{
  "analysis_type": "end_comparison",
  "analysis_name": "Outcome Comparison",
  "analysis_description": "Compare probabilities of reaching these outcomes",
  
  "metadata": {
    "node_ids": ["success", "failure", "abandon"]
  },
  
  "structure": {
    "primary": "outcome",
    "secondary": "scenario",
    "display_hint": "comparison"
  },
  
  "data": [
    {
      "outcome_id": "success",
      "label": "Success",
      "values": [
        {"scenario_id": "current", "scenario_name": "Current", "probability": 0.6, "expected_cost_gbp": 120},
        {"scenario_id": "optimistic", "scenario_name": "Optimistic", "probability": 0.75, "expected_cost_gbp": 100}
      ]
    },
    {
      "outcome_id": "failure",
      "label": "Failure",
      "values": [
        {"scenario_id": "current", "scenario_name": "Current", "probability": 0.3, "expected_cost_gbp": 80},
        {"scenario_id": "optimistic", "scenario_name": "Optimistic", "probability": 0.2, "expected_cost_gbp": 60}
      ]
    },
    {
      "outcome_id": "abandon",
      "label": "Abandon",
      "values": [
        {"scenario_id": "current", "scenario_name": "Current", "probability": 0.1, "expected_cost_gbp": 20},
        {"scenario_id": "optimistic", "scenario_name": "Optimistic", "probability": 0.05, "expected_cost_gbp": 15}
      ]
    }
  ]
}
```

### 3. Entry Node Outcomes (Columnar)

Best for: Showing full breakdown per scenario in separate blocks.

```json
{
  "analysis_type": "entry_node",
  "analysis_name": "Outcomes from Node",
  "analysis_description": "Probability of reaching each outcome from this start",
  
  "metadata": {
    "node_id": "entry",
    "node_label": "Entry Point"
  },
  
  "structure": {
    "primary": "scenario",
    "display_hint": "columnar"
  },
  
  "data": [
    {
      "scenario_id": "current",
      "scenario_name": "Current",
      "total_probability": 1.0,
      "outcomes": [
        {"node_id": "success", "label": "Success", "probability": 0.6},
        {"node_id": "failure", "label": "Failure", "probability": 0.3},
        {"node_id": "abandon", "label": "Abandon", "probability": 0.1}
      ]
    },
    {
      "scenario_id": "optimistic",
      "scenario_name": "Optimistic",
      "total_probability": 1.0,
      "outcomes": [
        {"node_id": "success", "label": "Success", "probability": 0.75},
        {"node_id": "failure", "label": "Failure", "probability": 0.2},
        {"node_id": "abandon", "label": "Abandon", "probability": 0.05}
      ]
    }
  ]
}
```

### 4. Graph Overview (Columnar)

```json
{
  "analysis_type": "graph_overview",
  "analysis_name": "Graph Overview",
  "analysis_description": "Overall outcomes from all entry points",
  
  "metadata": {},
  
  "structure": {
    "primary": "scenario",
    "display_hint": "columnar"
  },
  
  "data": [
    {
      "scenario_id": "current",
      "scenario_name": "Current",
      "graph_stats": {
        "total_nodes": 12,
        "total_edges": 15,
        "entry_nodes": 2,
        "absorbing_nodes": 3
      },
      "entry_nodes": [
        {"id": "entry1", "label": "Entry 1"},
        {"id": "entry2", "label": "Entry 2"}
      ],
      "outcomes": [
        {"node_id": "success", "label": "Success", "probability": 0.55},
        {"node_id": "failure", "label": "Failure", "probability": 0.35},
        {"node_id": "abandon", "label": "Abandon", "probability": 0.1}
      ]
    }
  ]
}
```

## Display Adaptor Guidelines

### Funnel Display (`display_hint: "funnel"`)

- Render as horizontal or vertical funnel/waterfall
- X-axis (or rows): stages from `data` array
- Bars/segments: one per scenario in `values`
- Show drop-off percentages between stages
- Color-code by scenario

### Comparison Display (`display_hint: "comparison"`)

- Render as grouped bar chart
- X-axis: primary items (outcomes, nodes, etc.)
- Grouped bars: one per scenario in `values`
- Y-axis: probability or selected metric
- Legend: scenario names

### Columnar Display (`display_hint: "columnar"`)

- Render as responsive columns/cards
- One column per `data` item (scenario)
- Each column shows full analysis results
- Can collapse to single column on narrow screens

### Table Display (`display_hint: "table"`)

- Render as data table
- Rows: primary items
- Columns: scenarios (or vice versa, allow pivot)
- Cells: probability and/or costs

## Implementation Notes

### Consistency Rules

1. **Always use `data` array** - Even with single scenario, `data` contains one item
2. **Always include `structure`** - Self-describing, no special-casing
3. **Scenario values always have `scenario_id` and `scenario_name`** - Even for "default" single scenario
4. **Metadata is analysis-specific** - Node IDs, labels, etc. that don't change per scenario

### Single Scenario Handling

When only one scenario exists, the return still uses the same structure:

```json
{
  "structure": {
    "primary": "scenario",
    "display_hint": "columnar"
  },
  "data": [
    {
      "scenario_id": "current",
      "scenario_name": "Current",
      "probability": 0.64
    }
  ]
}
```

Display adaptors should handle gracefully:
- Funnel with 1 scenario = simple funnel (no comparison)
- Comparison with 1 scenario = single bar per group
- Columnar with 1 scenario = single column (full width)

## Migration Path

1. Update `AnalysisResult` type in `types.py` to include `metadata` and `structure`
2. Update each runner to return new schema
3. Update frontend `AnalyticsPanel` to use `structure` for rendering decisions
4. Build display adaptors (future work)

