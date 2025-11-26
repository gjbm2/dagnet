# Analysis Return Schema Design

## Overview

This document defines the standard return schema for all analysis runners. The schema must be **declarative and self-describing** to support:

1. **Tabular display** - Rendering as data tables with appropriate row/column structure
2. **Chart rendering** - Automatic chart generation based on declared semantics
3. **Programmatic access** - APIs and exports that don't require special-case handling

The schema aligns with the broader declarative analytics architecture described in `HIGH_LEVEL_THINKING.md`.

---

## Design Principles

### 1. Self-Describing Structure

Every result declares its own semantics. Display adaptors never need to special-case by analysis type.

### 2. Consistent Shape

The schema shape is identical whether there's 1 scenario or 10. No structural changes based on data volume.

### 3. Dimension-Oriented

Results are organised around **dimensions** (what varies) and **metrics** (what's measured). This maps naturally to both tables and charts.

### 4. Chart-Ready

The semantics block provides enough information to automatically select and configure appropriate visualisations.

---

## Schema Definition

### Top-Level Structure

```typescript
interface AnalysisResult {
  // Identity
  analysis_type: string;        // Runner ID: "path", "outcome_comparison", etc.
  analysis_name: string;        // Human-readable: "Path Between Nodes"
  analysis_description: string; // Extended description
  
  // Context that doesn't vary by dimension
  metadata: Record<string, any>;
  
  // How to interpret and render the data
  semantics: ResultSemantics;
  
  // The actual results
  data: DataRow[];
}
```

### Semantics Block

The semantics block tells adaptors how to interpret and render the data:

```typescript
interface ResultSemantics {
  // Dimensions: what the data varies across
  dimensions: DimensionSpec[];
  
  // Metrics: what's being measured
  metrics: MetricSpec[];
  
  // Charting guidance
  chart: ChartSpec;
}

interface DimensionSpec {
  id: string;              // Field name in data: "scenario_id", "stage", "outcome_id"
  name: string;            // Human label: "Scenario", "Funnel Stage", "Outcome"
  type: DimensionType;     // Semantic type
  role: "primary" | "secondary" | "filter";  // How it structures the data
}

type DimensionType = 
  | "scenario"    // Scenario comparison
  | "stage"       // Sequential stages (funnel)
  | "outcome"     // Absorbing nodes / end states
  | "node"        // Graph nodes
  | "time"        // Time series
  | "categorical" // Generic category
  | "ordinal";    // Ordered category

interface MetricSpec {
  id: string;              // Field name: "probability", "expected_cost_gbp"
  name: string;            // Human label: "Probability", "Expected Cost (£)"
  type: MetricType;        // Semantic type
  format?: string;         // Display format: "percent", "currency_gbp", "number"
  role?: "primary" | "secondary";  // Visual prominence
}

type MetricType =
  | "probability"   // 0-1 value, display as %
  | "currency"      // Money value
  | "duration"      // Time duration
  | "count"         // Integer count
  | "ratio"         // Generic ratio
  | "delta";        // Change/difference

interface ChartSpec {
  recommended: ChartType;           // Best chart for this data
  alternatives?: ChartType[];       // Other valid options
  hints?: Record<string, any>;      // Chart-specific configuration
}

type ChartType =
  | "funnel"        // Funnel/waterfall with drop-off
  | "bar"           // Grouped or stacked bar
  | "bar_grouped"   // Explicit grouped bars
  | "bar_stacked"   // Explicit stacked bars  
  | "line"          // Time series or trend
  | "table"         // Tabular display
  | "single_value"  // Single KPI display
  | "comparison";   // Side-by-side comparison cards
```

### Data Rows

Data is always a flat array of rows. Each row contains dimension values and metric values:

```typescript
interface DataRow {
  // Dimension values (which slice this row belongs to)
  [dimensionId: string]: string | number;
  
  // Metric values (measurements for this slice)
  [metricId: string]: number | null;
  
  // Optional: nested data for hierarchical structures
  _children?: DataRow[];
}
```

---

## Dimension Patterns

### Pattern 1: Scenario-Primary (Columnar Display)

Use when each scenario should be displayed as a separate block/card.

```json
{
  "semantics": {
    "dimensions": [
      {"id": "scenario_id", "name": "Scenario", "type": "scenario", "role": "primary"}
    ],
    "metrics": [
      {"id": "probability", "name": "Probability", "type": "probability", "format": "percent", "role": "primary"},
      {"id": "expected_cost_gbp", "name": "Expected Cost", "type": "currency", "format": "currency_gbp"}
    ],
    "chart": {
      "recommended": "comparison",
      "alternatives": ["bar", "table"]
    }
  },
  "data": [
    {"scenario_id": "current", "scenario_name": "Current", "probability": 0.64, "expected_cost_gbp": 120},
    {"scenario_id": "optimistic", "scenario_name": "Optimistic", "probability": 0.81, "expected_cost_gbp": 95}
  ]
}
```

**Renders as:**
- Comparison cards: One card per scenario showing all metrics
- Bar chart: One bar per scenario
- Table: One row per scenario

---

### Pattern 2: Stage-Primary with Scenario-Secondary (Funnel)

Use for path/funnel analysis where stages are the primary axis and scenarios are compared within each stage.

```json
{
  "semantics": {
    "dimensions": [
      {"id": "stage", "name": "Stage", "type": "stage", "role": "primary"},
      {"id": "scenario_id", "name": "Scenario", "type": "scenario", "role": "secondary"}
    ],
    "metrics": [
      {"id": "probability", "name": "Probability", "type": "probability", "format": "percent", "role": "primary"}
    ],
    "chart": {
      "recommended": "funnel",
      "alternatives": ["bar_grouped", "table"],
      "hints": {"show_dropoff": true}
    }
  },
  "data": [
    {"stage": 0, "stage_label": "Entry", "scenario_id": "current", "scenario_name": "Current", "probability": 1.0},
    {"stage": 0, "stage_label": "Entry", "scenario_id": "optimistic", "scenario_name": "Optimistic", "probability": 1.0},
    {"stage": 1, "stage_label": "Step 1", "scenario_id": "current", "scenario_name": "Current", "probability": 0.8},
    {"stage": 1, "stage_label": "Step 1", "scenario_id": "optimistic", "scenario_name": "Optimistic", "probability": 0.9},
    {"stage": 2, "stage_label": "Success", "scenario_id": "current", "scenario_name": "Current", "probability": 0.64},
    {"stage": 2, "stage_label": "Success", "scenario_id": "optimistic", "scenario_name": "Optimistic", "probability": 0.81}
  ]
}
```

**Renders as:**
- Funnel chart: Stages on x-axis, grouped bars per scenario
- Grouped bar chart: Same structure
- Table: Rows = stages, columns = scenarios (or pivoted)

---

### Pattern 3: Outcome-Primary with Scenario-Secondary (Comparison)

Use for comparing outcomes (absorbing nodes) across scenarios.

```json
{
  "semantics": {
    "dimensions": [
      {"id": "outcome_id", "name": "Outcome", "type": "outcome", "role": "primary"},
      {"id": "scenario_id", "name": "Scenario", "type": "scenario", "role": "secondary"}
    ],
    "metrics": [
      {"id": "probability", "name": "Probability", "type": "probability", "format": "percent", "role": "primary"},
      {"id": "expected_cost_gbp", "name": "Expected Cost", "type": "currency", "format": "currency_gbp"}
    ],
    "chart": {
      "recommended": "bar_grouped",
      "alternatives": ["table", "comparison"]
    }
  },
  "data": [
    {"outcome_id": "success", "outcome_label": "Success", "scenario_id": "current", "scenario_name": "Current", "probability": 0.6, "expected_cost_gbp": 100},
    {"outcome_id": "success", "outcome_label": "Success", "scenario_id": "optimistic", "scenario_name": "Optimistic", "probability": 0.75, "expected_cost_gbp": 85},
    {"outcome_id": "failure", "outcome_label": "Failure", "scenario_id": "current", "scenario_name": "Current", "probability": 0.3, "expected_cost_gbp": 60},
    {"outcome_id": "failure", "outcome_label": "Failure", "scenario_id": "optimistic", "scenario_name": "Optimistic", "probability": 0.2, "expected_cost_gbp": 45},
    {"outcome_id": "abandon", "outcome_label": "Abandon", "scenario_id": "current", "scenario_name": "Current", "probability": 0.1, "expected_cost_gbp": 20},
    {"outcome_id": "abandon", "outcome_label": "Abandon", "scenario_id": "optimistic", "scenario_name": "Optimistic", "probability": 0.05, "expected_cost_gbp": 15}
  ]
}
```

**Renders as:**
- Grouped bar chart: Outcomes on x-axis, grouped bars per scenario
- Table: Rows = outcomes, column groups = scenarios

---

### Pattern 4: Hierarchical (Nested Children)

Use when data has natural hierarchy (e.g., node with breakdown by outcome).

```json
{
  "semantics": {
    "dimensions": [
      {"id": "scenario_id", "name": "Scenario", "type": "scenario", "role": "primary"}
    ],
    "metrics": [
      {"id": "total_probability", "name": "Total", "type": "probability", "format": "percent"}
    ],
    "chart": {
      "recommended": "comparison",
      "hints": {"expandable": true}
    }
  },
  "data": [
    {
      "scenario_id": "current", 
      "scenario_name": "Current",
      "total_probability": 1.0,
      "_children": [
        {"outcome_id": "success", "outcome_label": "Success", "probability": 0.6},
        {"outcome_id": "failure", "outcome_label": "Failure", "probability": 0.3},
        {"outcome_id": "abandon", "outcome_label": "Abandon", "probability": 0.1}
      ]
    },
    {
      "scenario_id": "optimistic",
      "scenario_name": "Optimistic", 
      "total_probability": 1.0,
      "_children": [
        {"outcome_id": "success", "outcome_label": "Success", "probability": 0.75},
        {"outcome_id": "failure", "outcome_label": "Failure", "probability": 0.2},
        {"outcome_id": "abandon", "outcome_label": "Abandon", "probability": 0.05}
      ]
    }
  ]
}
```

---

## Metadata Block

The metadata block contains context that doesn't vary by dimension:

```json
{
  "metadata": {
    "from_node": "entry",
    "from_label": "Entry Point",
    "to_node": "success",
    "to_label": "Success",
    "intermediate_nodes": ["step1", "step2"],
    "timestamp": "2024-01-15T10:30:00Z",
    "query_dsl": "from(entry).to(success).visited(step1).visited(step2)"
  }
}
```

---

## Table Rendering Rules

Given the semantics, tables can be auto-generated:

| Semantics | Rows | Columns |
|-----------|------|---------|
| 1 dimension (primary) | Primary dimension values | Metrics |
| 2 dimensions (primary + secondary) | Primary × Secondary | Metrics |
| 2 dimensions (pivot) | Primary | Secondary × Metrics |

The adaptor can offer pivot controls to switch between layouts.

---

## Chart Rendering Rules

| `chart.recommended` | X-Axis | Series/Groups | Y-Axis |
|---------------------|--------|---------------|--------|
| `funnel` | Primary dimension (stages) | Secondary dimension (scenarios) | Primary metric |
| `bar_grouped` | Primary dimension | Secondary dimension | Primary metric |
| `bar_stacked` | Primary dimension | Secondary dimension | Primary metric |
| `comparison` | N/A (cards) | Primary dimension | All metrics per card |
| `line` | Primary dimension (time) | Secondary dimension | Primary metric |
| `single_value` | N/A | N/A | Primary metric |

---

## Implementation Notes

### Single Scenario Handling

When only one scenario exists, the structure remains identical:

```json
{
  "dimensions": [
    {"id": "scenario_id", "name": "Scenario", "type": "scenario", "role": "primary"}
  ],
  "data": [
    {"scenario_id": "current", "scenario_name": "Current", "probability": 0.64}
  ]
}
```

Display adaptors handle gracefully:
- Funnel with 1 scenario = simple funnel (no legend needed)
- Grouped bars with 1 scenario = single bar per group
- Comparison with 1 scenario = single card

### Metric Aggregation

For charts that need aggregation (e.g., stacked bars), the adaptor uses:
- `role: "primary"` metric for the main value
- Other metrics for tooltips/details

### Colour Assignment

Scenarios get consistent colours from the scenario definition. Adaptors should use `scenario_id` to look up assigned colours.

---

## Alignment with Analysis Definition (D)

This return schema is the **output** side of the declarative analytics system. The Analysis Definition (D) declares:

1. **Scope** - When this analysis applies (predicates, query shapes)
2. **Data requirements** - What data to fetch
3. **Semantics** - How to structure and render output ← **This schema**

The runner produces results conforming to the D's declared semantics, and the display layer renders based purely on that declaration.

---

## Migration Path

1. Define `ResultSemantics` types in Python (`types.py`) and TypeScript
2. Update each runner to return new schema with `semantics` block
3. Update `AnalyticsPanel` to parse `semantics` for display decisions
4. Build chart adaptor that reads `semantics.chart` to select visualisation
5. Build table adaptor that reads `semantics.dimensions` to structure grid



----

# How complex to adapt for display?

Let me reason through the complexity:

## Tabular Display Adaptor

### Input
```typescript
{
  semantics: {
    dimensions: [{id, name, type, role}],
    metrics: [{id, name, type, format}]
  },
  data: [{...dimension values, ...metric values}]
}
```

### Logic Required

**1. Determine table structure:**
```typescript
const primaryDim = dimensions.find(d => d.role === 'primary');
const secondaryDim = dimensions.find(d => d.role === 'secondary');
```

**2. Three cases:**

| Case | Structure | Complexity |
|------|-----------|------------|
| 1 dim only | Rows = primary values, Cols = metrics | Simple |
| 2 dims (unpivoted) | Rows = primary × secondary, Cols = metrics | Simple |
| 2 dims (pivoted) | Rows = primary, Cols = secondary × metrics | Medium |

**3. Build rows:**
```typescript
// Case 1: Single dimension
const rows = data.map(row => ({
  [primaryDim.name]: row[`${primaryDim.id}_label`] || row[primaryDim.id],
  ...Object.fromEntries(metrics.map(m => [m.name, formatValue(row[m.id], m.format)]))
}));

// Case 2: Two dimensions (pivoted)
const primaryValues = [...new Set(data.map(d => d[primaryDim.id]))];
const secondaryValues = [...new Set(data.map(d => d[secondaryDim.id]))];

const rows = primaryValues.map(pv => {
  const row = { [primaryDim.name]: getLabelFor(pv) };
  for (const sv of secondaryValues) {
    const dataRow = data.find(d => d[primaryDim.id] === pv && d[secondaryDim.id] === sv);
    for (const m of metrics) {
      row[`${sv}_${m.id}`] = formatValue(dataRow?.[m.id], m.format);
    }
  }
  return row;
});
```

**4. Format values:**
```typescript
function formatValue(value: number | null, format: string): string {
  if (value === null) return '—';
  switch (format) {
    case 'percent': return `${(value * 100).toFixed(1)}%`;
    case 'currency_gbp': return `£${value.toFixed(2)}`;
    case 'number': return value.toLocaleString();
    default: return String(value);
  }
}
```

### Complexity Assessment: **Low-Medium**

- ~50-100 lines of code
- Main complexity is pivot logic
- Format handling is straightforward
- No special-casing by analysis type

---

## Text/Card Display Adaptor

### Single Value Display
```typescript
if (chart.recommended === 'single_value') {
  const primaryMetric = metrics.find(m => m.role === 'primary');
  const value = data[0][primaryMetric.id];
  return `${primaryMetric.name}: ${formatValue(value, primaryMetric.format)}`;
}
```

### Comparison Cards
```typescript
if (chart.recommended === 'comparison') {
  const primaryDim = dimensions.find(d => d.role === 'primary');
  
  return data.map(row => ({
    title: row[`${primaryDim.id}_name`] || row[primaryDim.id],
    values: metrics.map(m => ({
      label: m.name,
      value: formatValue(row[m.id], m.format)
    }))
  }));
}
```

### Complexity Assessment: **Low**

- ~30-50 lines of code
- Very straightforward mapping

---

## Potential Complications

1. **Hierarchical data (`_children`)** - Adds complexity for expandable rows
2. **Multiple metrics in pivot** - Column headers become `scenario × metric`
3. **Sorting** - Need to preserve dimension order (stages are ordinal)
4. **Highlighting** - May want to highlight best/worst values

---

## Verdict

**Tabular adaptor: ~100 lines, straightforward**
**Card adaptor: ~50 lines, trivial**

The schema is well-suited for these display types. Main work is:
1. Pivot logic (one-time implementation)
2. Format registry (extensible)
3. Column header generation

---

## Responsive Card Rendering

When rendering cards (e.g., one per scenario), the output must support responsive layout:
- **Narrow view (sidebar)**: Cards stack vertically
- **Wide view (landscape/popped out)**: Cards flow side-by-side

### HTML Output Structure

```html
<div class="analysis-cards-container">  <!-- flex container, wraps -->
  <div class="analysis-card" data-dimension-id="current">
    <div class="card-header" style="border-left-color: #3b82f6">
      <span class="card-colour-dot" style="background: #3b82f6"></span>
      <span class="card-title">Current</span>
    </div>
    <div class="card-content">
      <div class="metric metric-primary">
        <span class="metric-label">Probability</span>
        <span class="metric-value">64.0%</span>
      </div>
      <div class="metric">
        <span class="metric-label">Expected Cost</span>
        <span class="metric-value">£120.00</span>
      </div>
    </div>
  </div>
  
  <div class="analysis-card" data-dimension-id="optimistic">
    <div class="card-header" style="border-left-color: #22c55e">
      <span class="card-colour-dot" style="background: #22c55e"></span>
      <span class="card-title">Optimistic</span>
    </div>
    <div class="card-content">...</div>
  </div>
</div>
```

### CSS for Responsive Flow

```css
.analysis-cards-container {
  display: flex;
  flex-wrap: wrap;
  gap: 16px;
  container-type: inline-size;
}

.analysis-card {
  flex: 1 1 280px;  /* grow, shrink, min-width */
  max-width: 100%;
  border: 1px solid #e5e7eb;
  border-radius: 8px;
  overflow: hidden;
}

/* Narrow: cards stack */
@container (max-width: 500px) {
  .analysis-card {
    flex-basis: 100%;
  }
}

/* Wide: cards side-by-side */
@container (min-width: 700px) {
  .analysis-card {
    flex-basis: calc(50% - 8px);
    max-width: calc(50% - 8px);
  }
}

/* Extra wide: three columns */
@container (min-width: 1000px) {
  .analysis-card {
    flex-basis: calc(33.33% - 11px);
    max-width: calc(33.33% - 11px);
  }
}
```

### Card Adaptor Output Type

```typescript
interface CardDisplayOutput {
  containerClass: string;
  cards: CardData[];
}

interface CardData {
  id: string;              // Dimension value (scenario_id, outcome_id, etc.)
  title: string;           // Human label
  colour?: string;         // Hex colour for scenario/dimension
  metrics: MetricDisplay[];
  children?: CardData[];   // For hierarchical display
}

interface MetricDisplay {
  id: string;
  label: string;
  value: string;           // Pre-formatted
  role: 'primary' | 'secondary';
}
```

**Key insight**: The primary dimension determines card boundaries. Each unique value of the primary dimension becomes one responsive card.

---

# Schema Refinement: Dimension Metadata

## The Problem

The current schema has dimension values in `data` rows, but some per-dimension-value metadata (like scenario colours) would be:
1. Repeated redundantly in every row
2. Or require external lookup

## Proposed Addition: `dimension_values` Block

Add a `dimension_values` block to provide metadata for each dimension value:

```typescript
interface AnalysisResult {
  analysis_type: string;
  analysis_name: string;
  analysis_description: string;
  
  metadata: Record<string, any>;
  semantics: ResultSemantics;
  
  // NEW: Metadata per dimension value
  dimension_values: {
    [dimensionId: string]: {
      [valueId: string]: {
        name: string;        // Human-readable label
        colour?: string;     // Hex colour (for scenarios)
        order?: number;      // Sort order (for stages)
        // extensible...
      }
    }
  };
  
  data: DataRow[];
}
```

### Example

```json
{
  "analysis_type": "path",
  "analysis_name": "Path Between Nodes",
  
  "metadata": {
    "from_node": "entry",
    "to_node": "success"
  },
  
  "semantics": {
    "dimensions": [
      {"id": "stage", "name": "Stage", "type": "stage", "role": "primary"},
      {"id": "scenario_id", "name": "Scenario", "type": "scenario", "role": "secondary"}
    ],
    "metrics": [
      {"id": "probability", "name": "Probability", "type": "probability", "format": "percent"}
    ],
    "chart": {"recommended": "funnel"}
  },
  
  "dimension_values": {
    "stage": {
      "0": {"name": "Entry", "order": 0},
      "1": {"name": "Step 1", "order": 1},
      "2": {"name": "Success", "order": 2}
    },
    "scenario_id": {
      "current": {"name": "Current", "colour": "#3b82f6"},
      "optimistic": {"name": "Optimistic", "colour": "#22c55e"}
    }
  },
  
  "data": [
    {"stage": 0, "scenario_id": "current", "probability": 1.0},
    {"stage": 0, "scenario_id": "optimistic", "probability": 1.0},
    {"stage": 1, "scenario_id": "current", "probability": 0.8},
    {"stage": 1, "scenario_id": "optimistic", "probability": 0.9},
    {"stage": 2, "scenario_id": "current", "probability": 0.64},
    {"stage": 2, "scenario_id": "optimistic", "probability": 0.81}
  ]
}
```

### Benefits

1. **No redundancy** - Colours/names not repeated in every row
2. **Self-contained** - Adaptor has everything it needs
3. **Consistent ordering** - Stage order preserved via `order` field
4. **Extensible** - Can add more per-value metadata as needed

### Adaptor Usage

```typescript
function getLabel(dimensionId: string, valueId: string): string {
  return result.dimension_values[dimensionId]?.[valueId]?.name ?? valueId;
}

function getColour(dimensionId: string, valueId: string): string | undefined {
  return result.dimension_values[dimensionId]?.[valueId]?.colour;
}

function getSortedValues(dimensionId: string): string[] {
  const vals = result.dimension_values[dimensionId];
  return Object.entries(vals)
    .sort(([,a], [,b]) => (a.order ?? 0) - (b.order ?? 0))
    .map(([id]) => id);
}
```

---

# Final Schema Summary

With this refinement, the complete schema is:

```typescript
interface AnalysisResult {
  // Identity
  analysis_type: string;
  analysis_name: string;
  analysis_description: string;
  
  // Static context
  metadata: Record<string, any>;
  
  // How to interpret the data
  semantics: {
    dimensions: DimensionSpec[];
    metrics: MetricSpec[];
    chart: ChartSpec;
  };
  
  // Per-dimension-value metadata (labels, colours, order)
  dimension_values: Record<string, Record<string, DimensionValueMeta>>;
  
  // The actual data rows
  data: DataRow[];
}

interface DimensionValueMeta {
  name: string;
  colour?: string;
  order?: number;
}
```

This schema is now complete and self-contained for all display adaptor needs.