# Analysis Return Schema Design

**Source**: `docs/current/project-analysis/ANALYSIS_RETURN_SCHEMA.md`
**Last reviewed**: 17-Mar-26

---

## Overview

This document defines the standard return schema for all analysis runners. The schema must be **declarative and self-describing** to support:

1. **Tabular display** - Rendering as data tables with appropriate row/column structure
2. **Chart rendering** - Automatic chart generation based on declared semantics
3. **Programmatic access** - APIs and exports that don't require special-case handling

---

## Design Principles

1. **Self-Describing Structure** — Every result declares its own semantics. Display adaptors never need to special-case by analysis type.
2. **Consistent Shape** — The schema shape is identical whether there's 1 scenario or 10.
3. **Dimension-Oriented** — Results are organised around **dimensions** (what varies) and **metrics** (what's measured).
4. **Chart-Ready** — The semantics block provides enough information to automatically select and configure appropriate visualisations.

---

## Schema Definition

### Top-Level Structure

```typescript
interface AnalysisResult {
  // Identity
  analysis_type: string;        // Runner ID: "path", "outcome_comparison", etc.
  analysis_name: string;        // Human-readable: "Path Between Nodes"
  analysis_description: string; // Extended description

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
```

### Semantics Block

```typescript
interface DimensionSpec {
  id: string;              // Field name in data: "scenario_id", "stage", "outcome_id"
  name: string;            // Human label: "Scenario", "Funnel Stage", "Outcome"
  type: DimensionType;     // Semantic type
  role: "primary" | "secondary" | "filter";
}

type DimensionType =
  | "scenario" | "stage" | "outcome" | "node"
  | "time" | "categorical" | "ordinal";

interface MetricSpec {
  id: string;              // Field name: "probability", "expected_cost_gbp"
  name: string;            // Human label: "Probability", "Expected Cost (£)"
  type: MetricType;
  format?: string;         // "percent", "currency_gbp", "number"
  role?: "primary" | "secondary";
}

type MetricType =
  | "probability" | "currency" | "duration"
  | "count" | "ratio" | "delta";

interface ChartSpec {
  recommended: ChartType;
  alternatives?: ChartType[];
  hints?: Record<string, any>;
}

type ChartType =
  | "funnel" | "bar" | "bar_grouped" | "bar_stacked"
  | "line" | "table" | "single_value" | "comparison";

interface DimensionValueMeta {
  name: string;
  colour?: string;
  order?: number;
}
```

### Data Rows

Data is always a flat array. Each row contains dimension values and metric values:

```typescript
interface DataRow {
  [dimensionId: string]: string | number;
  [metricId: string]: number | null;
  _children?: DataRow[];  // Optional: nested data for hierarchical structures
}
```

---

## Dimension Patterns

| Pattern | Dimensions | Use for |
|---------|-----------|---------|
| **Scenario-Primary** | 1 dim (scenario) | Simple comparison cards/bars |
| **Stage-Primary + Scenario-Secondary** | 2 dims (stage + scenario) | Funnel/waterfall with scenario comparison |
| **Outcome-Primary + Scenario-Secondary** | 2 dims (outcome + scenario) | Comparing absorbing nodes across scenarios |
| **Hierarchical** | 1 dim + `_children` | Expandable rows/cards |

---

## Table Rendering Rules

| Semantics | Rows | Columns |
|-----------|------|---------|
| 1 dimension (primary) | Primary dimension values | Metrics |
| 2 dimensions (primary + secondary) | Primary × Secondary | Metrics |
| 2 dimensions (pivot) | Primary | Secondary × Metrics |

## Chart Rendering Rules

| `chart.recommended` | X-Axis | Series/Groups | Y-Axis |
|---------------------|--------|---------------|--------|
| `funnel` | Primary dimension (stages) | Secondary dimension (scenarios) | Primary metric |
| `bar_grouped` | Primary dimension | Secondary dimension | Primary metric |
| `comparison` | N/A (cards) | Primary dimension | All metrics per card |
| `line` | Primary dimension (time) | Secondary dimension | Primary metric |
| `single_value` | N/A | N/A | Primary metric |

---

## Key Implementation Notes

- Single scenario: structure remains identical (display adaptors handle gracefully)
- Metric aggregation: `role: "primary"` metric for main value; others for tooltips
- Colour assignment: scenarios get consistent colours from scenario definition via `scenario_id`
- The primary dimension determines card boundaries in comparison view
- `dimension_values` block avoids redundant labels/colours in data rows

---

## Alignment with Analysis Definitions

This return schema is the **output** side of the declarative analytics system. The Analysis Definition (D) declares:

1. **Scope** — When this analysis applies (predicates, query shapes)
2. **Data requirements** — What data to fetch
3. **Semantics** — How to structure and render output (this schema)

The runner produces results conforming to the D's declared semantics, and the display layer renders based purely on that declaration.
