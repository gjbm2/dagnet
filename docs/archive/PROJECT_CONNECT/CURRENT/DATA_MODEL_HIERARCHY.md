# Data Model Hierarchy

**Status:** Reference Document  
**Created:** 2025-11-06  
**Purpose:** Define clear boundaries between graph objects and business data objects

---

## Visual Data Model

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                            GRAPH (JSON file)                                │
│                                                                             │
│  ┌──────────────────────────────────────────────────────────────────────┐  │
│  │ NODES (all nodes have the same base structure)                       │  │
│  │                                                                       │  │
│  │  ┌───────────────────────────────────────────────────────────────┐  │  │
│  │  │   Node (base structure - all nodes)                            │  │  │
│  │  │                                                                 │  │  │
│  │  │  uuid: "abc-123"                                                │  │  │
│  │  │  id: "checkout-start"                                           │  │  │
│  │  │  label: "Checkout Start"                                        │  │  │
│  │  │  description: "..."                                             │  │  │
│  │  │                                                                 │  │  │
│  │  │  node_id?: "checkout-start"  ← optional FK to NODE FILE        │  │  │
│  │  │      │                                                          │  │  │
│  │  │      ▼                                                          │  │  │
│  │  │  ┌────────────┐                                                 │  │  │
│  │  │  │ NODE FILE  │  (shared definition, optional)                 │  │  │
│  │  │  └────────────┘                                                 │  │  │
│  │  │                                                                 │  │  │
│  │  │  event?: {                   ← optional event reference        │  │  │
│  │  │    id: "page_view"                                              │  │  │
│  │  │        │                                                        │  │  │
│  │  │        ▼                                                        │  │  │
│  │  │    ┌────────────┐                                               │  │  │
│  │  │    │EVENT FILE  │  (event schema reference)                    │  │  │
│  │  │    └────────────┘                                               │  │  │
│  │  │  }                                                              │  │  │
│  │  │                                                                 │  │  │
│  │  │  case?: {                    ← optional case connection        │  │  │
│  │  │    id: "product-variants"    ← FK to CASE FILE                 │  │  │
│  │  │        │                                                        │  │  │
│  │  │        ▼                                                        │  │  │
│  │  │    ┌─────────────┐                                              │  │  │
│  │  │    │  CASE FILE  │  (A/B test, feature flag, etc.)            │  │  │
│  │  │    └─────────────┘                                              │  │  │
│  │  │                                                                 │  │  │
│  │  │    variants: [               ← current variant weights         │  │  │
│  │  │      {name: "control", weight: 0.5},                           │  │  │
│  │  │      {name: "variant_a", weight: 0.5}                          │  │  │
│  │  │    ]                                                            │  │  │
│  │  │  }                                                              │  │  │
│  │  │                                                                 │  │  │
│  │  │  NOTE: If case is present, this node splits into multiple      │  │  │
│  │  │        child edges (one per variant). Otherwise, it's a        │  │  │
│  │  │        regular node with normal outgoing edges.                │  │  │
│  │  └───────────────────────────────────────────────────────────────┘  │  │
│  └───────────────────────────────────────────────────────────────────────┘  │
│                                                                             │
│  ┌──────────────────────────────────────────────────────────────────────┐  │
│  │ EDGES                                                                 │  │
│  │                                                                       │  │
│  │  ┌────────────────────────────────────────────────────────────────┐  │  │
│  │  │   Edge                                                          │  │  │
│  │  │                                                                 │  │  │
│  │  │  uuid: "ghi-789"                                                │  │  │
│  │  │  id: "checkout-to-payment"                                      │  │  │
│  │  │  label: "Checkout conversion"                                   │  │  │
│  │  │  description: "..."                                             │  │  │
│  │  │                                                                 │  │  │
│  │  │  source: "abc-123" (node UUID)                                  │  │  │
│  │  │  target: "def-456" (node UUID)                                  │  │  │
│  │  │                                                                 │  │  │
│  │  │  p: {                                                           │  │  │
│  │  │    id: "checkout-conversion-rate"                               │  │  │
│  │  │        │                                                        │  │  │
│  │  │        │ (optional FK)                                          │  │  │
│  │  │        ▼                                                        │  │  │
│  │  │    ┌────────────────┐                                           │  │  │
│  │  │    │ PARAMETER FILE │                                           │  │  │
│  │  │    └────────────────┘                                           │  │  │
│  │  │                                                                 │  │  │
│  │  │    mean: 0.73           ← synced from parameter.values[latest] │  │  │
│  │  │    mean_overridden: false                                       │  │  │
│  │  │    stdev: 0.05          ← synced from parameter.values[latest] │  │  │
│  │  │    distribution: "beta"                                         │  │  │
│  │  │                                                                 │  │  │
│  │  │    evidence: {          ← synced from parameter.values[latest] │  │  │
│  │  │      n: 1000,                                                   │  │  │
│  │  │      k: 730,                                                    │  │  │
│  │  │      window_from: "...",                                        │  │  │
│  │  │      window_to: "...",                                          │  │  │
│  │  │      retrieved_at: "...",                                       │  │  │
│  │  │      source: "amplitude"                                        │  │  │
│  │  │    }                                                            │  │  │
│  │  │  }                                                              │  │  │
│  │  │                                                                 │  │  │
│  │  │  cost_gbp?: {                                                   │  │  │
│  │  │    id: "checkout-cost"            ← FK to PARAMETER FILE       │  │  │
│  │  │    mean: 2.50                     ← synced from param file     │  │  │
│  │  │    mean_overridden: false                                       │  │  │
│  │  │    stdev: 0.30                                                  │  │  │
│  │  │    distribution: "gamma"                                        │  │  │
│  │  │    evidence?: { window_from, window_to, ... }                  │  │  │
│  │  │  }                                                              │  │  │
│  │  │                                                                 │  │  │
│  │  │  cost_time?: {                                                  │  │  │
│  │  │    id: "checkout-duration"        ← FK to PARAMETER FILE       │  │  │
│  │  │    mean: 45.5                     ← synced from param file     │  │  │
│  │  │    mean_overridden: false                                       │  │  │
│  │  │    stdev: 12.0                                                  │  │  │
│  │  │    distribution: "lognormal"                                    │  │  │
│  │  │    evidence?: { window_from, window_to, ... }                  │  │  │
│  │  │  }                                                              │  │  │
│  │  │                                                                 │  │  │
│  │  │  conditional_p?: [{                                             │  │  │
│  │  │    id: "checkout-rate-mobile"     ← FK to PARAMETER FILE       │  │  │
│  │  │    condition: "device=mobile"                                   │  │  │
│  │  │    mean: 0.65                     ← synced from param file     │  │  │
│  │  │    mean_overridden: false                                       │  │  │
│  │  │    stdev: 0.06                                                  │  │  │
│  │  │    distribution: "beta"                                         │  │  │
│  │  │    evidence?: { n, k, window_from, ... }                       │  │  │
│  │  │  }, {                                                           │  │  │
│  │  │    id: "checkout-rate-desktop"    ← FK to PARAMETER FILE       │  │  │
│  │  │    condition: "device=desktop"                                  │  │  │
│  │  │    mean: 0.78                                                   │  │  │
│  │  │    ... (same structure)                                         │  │  │
│  │  │  }]                                                             │  │  │
│  │  └────────────────────────────────────────────────────────────────┘  │  │
│  └───────────────────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────────────┐
│                          BUSINESS DATA FILES (YAML)                         │
│                                                                             │
│  ┌───────────────────────┐  ┌───────────────────────┐  ┌────────────────┐  │
│  │   PARAMETER FILE      │  │     CASE FILE         │  │   NODE FILE    │  │
│  │   parameter-{id}.yaml │  │   case-{id}.yaml      │  │  node-{id}.yaml│  │
│  │                       │  │                       │  │                │  │
│  │  id: (string)         │  │  id: (string)         │  │  id: (string)  │  │
│  │  name: (string)       │  │  name: (string)       │  │  name: (string)│  │
│  │  description: (text)  │  │  description: (text)  │  │  description   │  │
│  │  type: probability/   │  │  type: ab_test/...    │  │  node_type     │  │
│  │        cost_gbp/       │  │  variants: [...]      │  │  event_id      │  │
│  │        cost_time       │  │  schedules: [         │  │  tags          │  │
│  │  query: (DSL string)  │  │    {                  │  │  metadata      │  │
│  │  values: [            │  │      variants: [...]   │  │                │  │
│  │    {                  │  │      window_from       │  │                │  │
│  │      mean: 0.73,      │  │    },                 │  │                │  │
│  │      stdev: 0.05,     │  │    { ... }            │  │                │  │
│  │      n: 1000,         │  │  ]                    │  │                │  │
│  │      k: 730,          │  │  data_source: {...}   │  │                │  │
│  │      window_from,     │  │  tags                 │  │                │  │
│  │      window_to,       │  │  metadata             │  │                │  │
│  │      retrieved_at,    │  │                       │  │                │  │
│  │      source           │  │                       │  │                │  │
│  │    },                 │  │                       │  │                │  │
│  │    { ... history ... }│  │                       │  │                │  │
│  │  ]                    │  │                       │  │                │  │
│  │  data_source: {...}   │  │                       │  │                │  │
│  │  tags                 │  │                       │  │                │  │
│  │  metadata             │  │                       │  │                │  │
│  └───────────────────────┘  └───────────────────────┘  └────────────────┘  │
│                                                                             │
│  ┌───────────────────────┐  ┌───────────────────────┐                      │
│  │     EVENT FILE        │  │   CONTEXT FILE        │                      │
│  │   event-{id}.yaml     │  │ context-{id}.yaml     │                      │
│  │                       │                                                  │
│  │  id: (string)         │                                                  │
│  │  name: (string)       │                                                  │
│  │  description: (text)  │                                                  │
│  │  category: conversion │                                                  │
│  │  properties: [...]    │                                                  │
│  │  connectors: {        │                                                  │
│  │    amplitude: {...}   │                                                  │
│  │    statsig: {...}     │                                                  │
│  │  }                    │                                                  │
│  │  tags                 │                                                  │
│  │  metadata             │  │  id: (string)         │                      │
│  └───────────────────────┘  │  name: (string)       │                      │
│                             │  description: (text)  │                      │
│                             │  type: filter/segment │                      │
│                             │  dimensions: [...]     │                      │
│                             │  tags                 │                      │
│                             │  metadata             │                      │
│                             └───────────────────────┘                      │
└─────────────────────────────────────────────────────────────────────────────┘

KEY RELATIONSHIPS:

  node.node_id ────FK────> NODE FILE (optional, shared definition)
  node.event.id ───FK────> EVENT FILE (optional, event schema reference)
    SCHEMA UPDATED: Changed from flat `event_id` to nested `event.id` for consistency
                     with `case.id` pattern. This aligns naming across all foreign keys.
  
  node.case.id ────FK────> CASE FILE (only for case nodes)
  
  edge.p.id ──────────────FK────> PARAMETER FILE (optional, probability param)
  edge.cost_gbp.id ───────FK────> PARAMETER FILE (optional, cost param)
  edge.cost_time.id ──────FK────> PARAMETER FILE (optional, duration param)
  edge.conditional_p[i].id ─FK──> PARAMETER FILE (0-N conditional probability params)
    NOTE: conditional_p is an ARRAY, each with its own parameter file reference
  
  edge.source ────────────FK────> NODE (by UUID, topology)
  edge.target ────────────FK────> NODE (by UUID, topology)

SYNC RULES:

  ✓ PARAMETER FILE → edge.p.*     (GET: sync values[latest], not metadata)
  ✓ edge.p.* → PARAMETER FILE     (PUT: append to values[], not metadata)
  
  ✓ CASE FILE → node.case.variants (GET: sync schedules[latest].weights only)
  ✓ node.case.variants → CASE FILE (PUT: append to schedules[])
  
  ✓ NODE FILE → node.*             (GET: sync metadata - this IS canonical)
  ✓ node.* → NODE FILE             (PUT: update metadata)
  
  ✗ EVENT FILE → node.*            (NO sync - events are schema definitions)
```

---

## Core Principle

**Each entity owns its own metadata.** When syncing, we update *data values* only, not metadata, except during initial CREATE operations.

---

## 1. Graph Objects (stored in graph JSON files)

### 1.1 Node (Graph Entity)

**Location:** `graph.nodes[i]`

**Metadata (owned by node):**
```typescript
{
  uuid: string;           // System-generated, local to this graph
  id: string;             // Human-readable ID (e.g., "checkout-start")
  label: string;          // Display name for this node
  description: string;    // What this node represents
  
  // Node-level override flags
  label_overridden: boolean;
  description_overridden: boolean;
  
  // Optional foreign key to node file
  node_id?: string;       // References node-{id}.yaml
  
  // Optional foreign key to event
  event_id?: string;      // References event-{id}.yaml
  
  // Layout/visual
  position: { x: number; y: number };
  layout?: any;
}
```

**Case-specific data (if case node):**
```typescript
{
  case?: {
    id: string;           // Foreign key to case-{id}.yaml
    variants: Array<{
      name: string;
      weight: number;     // Current weight for this variant
    }>;
  }
}
```

**Key points:**
- `node.label` and `node.description` describe the **node in the graph**
- `node.node_id` is a foreign key to a node file (optional, for shared node definitions)
- `node.case.id` is a foreign key to a case file (only for case nodes)
- `node.case.variants` stores current variant weights (synced from case file schedules)

---

### 1.2 Edge (Graph Entity)

**Location:** `graph.edges[i]`

**Metadata (owned by edge):**
```typescript
{
  uuid: string;           // System-generated, local to this graph
  id: string;             // Human-readable ID (e.g., "start-to-checkout")
  label?: string;         // Display name for this edge
  description?: string;   // What this edge represents
  
  // Edge-level override flags
  label_overridden?: boolean;
  description_overridden?: boolean;
  
  // Topology
  source: string;         // UUID of source node
  target: string;         // UUID of target node
  
  // Visual
  style?: any;
}
```

**Probability parameter data:**
```typescript
{
  p?: {
    // Foreign key to parameter file (optional)
    id?: string;          // References parameter-{id}.yaml
    
    // Statistical values (synced from parameter file OR set directly)
    mean: number;
    stdev?: number;
    distribution?: string;
    
    // Override flags for statistical values
    mean_overridden: boolean;
    stdev_overridden?: boolean;
    distribution_overridden?: boolean;
    
    // Evidence (always synced from parameter file, no override)
    evidence?: {
      n?: number;
      k?: number;
      window_from?: string;
      window_to?: string;
      retrieved_at?: string;
      source?: string;
    };
    
    // Data source settings (for external connectors)
    data_source?: {
      source_type?: 'amplitude' | 'statsig' | 'sheets' | 'sql' | 'manual';
      connection_settings?: string;  // JSON blob
      connection_overridden?: boolean;
    };
  };
  
  // Query string for conditional probabilities
  query?: string;
  query_overridden?: boolean;
}
```

**Cost parameters (similar structure):**
```typescript
{
  cost_gbp?: {
    id?: string;          // Foreign key to cost parameter file
    cost: number;
    cost_overridden: boolean;
    evidence?: { ... };
    data_source?: { ... };
  };
  
  cost_time?: {
    id?: string;          // Foreign key to duration parameter file
    duration: number;
    duration_overridden: boolean;
    evidence?: { ... };
    data_source?: { ... };
  };
}
```

**Conditional probability parameters:**
```typescript
{
  conditional_p?: Array<{
    // Semantic constraint: WHEN this conditional applies (runtime evaluation)
    condition: string;    // "visited(promo)" or "context(device:mobile)"
    
    // Full data retrieval query: HOW to fetch data from external sources
    query?: string;       // "from(checkout).to(purchase).visited(promo)"
    query_overridden?: boolean;  // If true, don't regenerate query via MSMDC
    
    // Probability data (same structure as edge.p)
    p: {
      id?: string;        // Foreign key to parameter file
      mean: number;
      mean_overridden: boolean;
      // ... etc
    };
  }>;
}
```

**Query Architecture (IMPORTANT):**

The `query` field represents data retrieval expressions and follows a **unidirectional flow**:

1. **Query is mastered in the GRAPH**, not in files
   - Derived from graph topology via MSMDC algorithm
   - Can be manually edited by user (sets `query_overridden: true`)
   - Updated automatically when topology changes (unless overridden)

2. **Query flows graph → file (one-way only)**
   - CREATE/PUT operations write `edge.query` → `parameter.query`
   - Stored in parameter file for self-contained data retrieval
   - Used by external data services (Amplitude, Statsig, etc.)

3. **Query does NOT flow file → graph**
   - GET operations do NOT sync `parameter.query` back to `edge.query`
   - Reason: Query is context-dependent (tied to specific graph topology)
   - Different graphs using same parameter would have invalid/conflicting queries

4. **Condition vs Query distinction:**
   - **`condition`**: Semantic constraint for runtime evaluation ("when does this apply?")
   - **`query`**: Full topological path for data retrieval ("how do we fetch data?")
   - `query` is auto-derived from `condition` + edge endpoints + MSMDC discriminators

**Key points:**
- `edge.label` and `edge.description` describe the **edge in the graph** (e.g., "Checkout conversion")
- `edge.p.id` is a foreign key to a parameter file (optional)
- `edge.p.mean`, `edge.p.stdev`, etc. are the **statistical values** (synced from param file OR set directly)
- The parameter file has its own `parameter.name` and `parameter.description` which are **independent**

---

## 2. Business Data Objects (stored in YAML files)

### 2.1 Parameter File

**Location:** `params/parameter-{id}.yaml`

**Metadata (owned by parameter):**
```yaml
id: conversion-rate-checkout       # Human-readable ID
name: Checkout Conversion Rate     # Parameter's display name
description: |                      # What this parameter measures
  Percentage of users who complete checkout
  after initiating the process
type: probability                   # probability | cost_gbp | cost_time
tags: [checkout, conversion, critical]
metadata:
  created_at: 2025-01-15T10:00:00Z
  updated_at: 2025-03-20T14:30:00Z
  author: analytics-team
  status: active
```

**Data values (time-series history):**
```yaml
values:
  - mean: 0.73
    stdev: 0.05
    distribution: beta
    n: 1000
    k: 730
    window_from: 2025-01-01T00:00:00Z
    window_to: 2025-01-31T23:59:59Z
    retrieved_at: 2025-02-01T08:00:00Z
    source: amplitude
  - mean: 0.76
    stdev: 0.04
    distribution: beta
    n: 1200
    k: 912
    window_from: 2025-02-01T00:00:00Z
    window_to: 2025-02-28T23:59:59Z
    retrieved_at: 2025-03-01T08:00:00Z
    source: amplitude
```

**Connection settings (for external sources):**
```yaml
data_source:
  source_type: amplitude
  connection_settings: |
    {
      "event_name": "checkout_initiated",
      "conversion_event": "order_completed",
      "window": "24h"
    }
```

**Query string (can be synced from graph or set here):**
```yaml
query: "from(add_to_cart).to(checkout_complete).exclude(abandoned)"
```

**Key points:**
- `parameter.name` and `parameter.description` describe **what the parameter measures**
- `parameter.values[]` is a time-series array (append-only in normal usage)
- When "Get from parameter file" is used on an edge, only `values[latest].*` and `query` are synced to `edge.p.*`
- `parameter.name` does NOT overwrite `edge.label`

---

### 2.2 Case File

**Location:** `cases/case-{id}.yaml`

**Metadata (owned by case):**
```yaml
id: checkout-flow-test             # Human-readable ID
name: Checkout Flow A/B Test       # Case's display name
description: |                      # What this case/test is about
  Testing new payment UI against control
  to measure conversion impact
type: ab_test                       # ab_test | multivariate | sequential
tags: [checkout, payment, ui-test]
metadata:
  created_at: 2025-01-15T10:00:00Z
  updated_at: 2025-03-20T14:30:00Z
  author: product-team
  status: active
```

**Variant definitions:**
```yaml
variants:
  - name: control
    description: Original checkout flow
  - name: variant_a
    description: New streamlined payment UI
  - name: variant_b
    description: One-click checkout option
```

**Schedules (time-series history of weights):**
```yaml
schedules:
  - variants:
      - name: control
        weight: 0.5
      - name: variant_a
        weight: 0.5
      - name: variant_b
        weight: 0.0
    window_from: 2025-01-15T00:00:00Z
    window_to: 2025-02-15T23:59:59Z
    
  - variants:
      - name: control
        weight: 0.33
      - name: variant_a
        weight: 0.33
      - name: variant_b
        weight: 0.34
    window_from: 2025-02-16T00:00:00Z
    window_to: null  # Current schedule
```

**Connection settings (for external sources like Statsig):**
```yaml
data_source:
  source_type: statsig
  connection_settings: |
    {
      "experiment_id": "checkout_flow_test_2025_q1",
      "layer": "checkout"
    }
```

**Key points:**
- `case.name` and `case.description` describe **what the case/test is about**
- `case.variants[]` defines the variant structure
- `case.schedules[]` is a time-series of weight configurations
- When "Get from case file" is used on a case node, only `schedules[latest].variants` (weights) are synced to `node.case.variants`
- `case.name` does NOT overwrite `node.label`

---

### 2.3 Node File

**Location:** `nodes/node-{id}.yaml`

**Metadata (owned by node file - shared definition):**
```yaml
id: checkout-start                 # Human-readable ID
name: Checkout Start               # Shared node display name
description: |                      # What this node represents
  User initiates the checkout process
  after adding items to cart
node_type: event                   # event | state | decision | outcome
event_id: checkout_initiated       # Foreign key to event file
tags: [checkout, funnel, critical]
metadata:
  created_at: 2025-01-15T10:00:00Z
  updated_at: 2025-03-20T14:30:00Z
  author: analytics-team
  status: active
```

**Visual/layout defaults (optional):**
```yaml
layout:
  default_colour: "#3B82F6"
  default_icon: "shopping-cart"
```

**Key points:**
- Node files are **optional** - nodes can exist in graphs without corresponding node files
- Node files are for **shared node definitions** that can be reused across graphs
- When "Get from node file" is used, `node.name` → `graph_node.label`, `node.description` → `graph_node.description`
- This IS a metadata sync, because node files define the canonical node metadata

---

### 2.4 Event File

**Location:** `events/event-{id}.yaml`

**Metadata (owned by event):**
```yaml
id: checkout_initiated             # Human-readable ID
name: Checkout Initiated           # Event's display name
description: |                      # What this event represents
  Fired when user clicks checkout button
category: conversion               # conversion | engagement | revenue | system
properties:
  - name: cart_value
    type: number
    required: true
    description: Total value of items in cart
  - name: num_items
    type: integer
    required: true
    description: Number of items in cart
  - name: payment_method
    type: string
    required: false
    description: Pre-selected payment method
tags: [checkout, funnel]
metadata:
  created_at: 2025-01-15T10:00:00Z
  updated_at: 2025-03-20T14:30:00Z
  author: analytics-team
  status: active
```

**Connector mappings (for external sources):**
```yaml
connectors:
  amplitude:
    event_name: "[Amplitude] Checkout Initiated"
    property_mappings:
      cart_value: "Cart Value"
      num_items: "Number of Items"
      payment_method: "Payment Method"
  
  statsig:
    event_name: "checkout_initiated"
    property_mappings:
      cart_value: "cartValue"
      num_items: "itemCount"
```

**Key points:**
- Event files define event schemas and connector mappings
- Nodes reference events via `node.event_id`
- Events are NOT directly synced to graph nodes (no "Get from event file" operation)
- Events are metadata/schema definitions, not data values

---

## 3. Sync Operations Summary

### File → Graph (GET operations)

| Source | Target | Fields Synced | Override Flags | Notes |
|--------|--------|---------------|----------------|-------|
| **Parameter file** | `edge.p.*` | `values[latest].mean`<br>`values[latest].stdev`<br>`values[latest].distribution`<br>`values[latest].evidence.*`<br>`query` | `p.mean_overridden`<br>`p.stdev_overridden`<br>`p.distribution_overridden`<br>`query_overridden` | **Does NOT sync** `parameter.name` or `parameter.description` to `edge.label` or `edge.description` |
| **Case file** | `node.case.variants` | `schedules[latest].variants` (weights only) | None (always synced) | **Does NOT sync** `case.name` or `case.description` to `node.label` or `node.description` |
| **Node file** | `node.*` | `name` → `label`<br>`description`<br>`event_id` | `label_overridden`<br>`description_overridden` | **This IS a metadata sync** because node files define canonical node metadata (shared definitions) |

### Graph → File (PUT/APPEND operations)

| Source | Target | Operation | Fields Synced | Notes |
|--------|--------|-----------|---------------|-------|
| `edge.p.*` | **Parameter file** | APPEND | Appends new value to `values[]`:<br>`p.mean`, `p.stdev`, `p.distribution`, `p.evidence.*` | Does not update parameter metadata |
| `node.case.variants` | **Case file** | APPEND | Appends new schedule to `schedules[]`:<br>Variant weights | Does not update case metadata |
| `node.*` | **Node file** | UPDATE | `label` → `name`<br>`description`<br>`event_id` | Updates node file metadata |

### Graph → File (CREATE operations)

| Source | Target | Fields Initialized | Notes |
|--------|--------|--------------------|-------|
| `edge.*` | **New parameter file** | `edge.label` → `parameter.name`<br>`edge.description` → `parameter.description`<br>`edge.query` → `parameter.query`<br>`edge.p.mean` → `values[0].mean` | Pre-populate with helpful defaults. After creation, metadata is independent. |
| `node.*` | **New case file** | `node.label` → `case.name`<br>`node.description` → `case.description`<br>`node.case.variants` → `case.variants` | Pre-populate with helpful defaults. After creation, metadata is independent. |
| `node.*` | **New node file** | `node.label` → `node.name`<br>`node.description`<br>`node.event_id` | Pre-populate with helpful defaults. After creation, this becomes the canonical definition. |

---

## 4. Properties Panel Display Requirements (Phase 1D)

### 4.1 Edge Properties Panel

**Section: Edge Metadata (always visible)**
- `edge.label` (text input)
- `edge.description` (textarea)

**Section: Probability Parameter (if edge has `edge.p`)**
- **Parameter Connection:**
  - `edge.p.id` (EnhancedSelector with Lightning Menu)
  - Shows: "Connected to: parameter-{id}.yaml" if connected, or "Not connected" with "+ Create" button
  
- **Parameter Metadata (read-only, shown if connected):**
  - Display label: "Parameter: {parameter.name}"
  - Display description: "{parameter.description}" (smaller text, italic)
  - This helps user understand what the connected parameter measures
  
- **Statistical Values:**
  - `edge.p.mean` (slider 0-1) with override indicator
  - `edge.p.stdev` (optional, text input) with override indicator
  - `edge.p.distribution` (dropdown) with override indicator
  
- **Evidence (read-only, shown if available):**
  - Display: "Based on n={n}, k={k}" 
  - Display: "Window: {window_from} to {window_to}"
  - Display: "Retrieved: {retrieved_at} from {source}"

**Section: Conditional Probability Parameters (if any)**
- Similar structure for each conditional param

**Section: Cost Parameters (if any)**
- Similar structure for cost_gbp and cost_time

### 4.2 Node Properties Panel (Non-Case)

**Section: Node Metadata**
- `node.label` (text input)
- `node.description` (textarea)

**Section: Node File Connection (if node has `node.node_id`)**
- **Node File Connection:**
  - `node.node_id` (EnhancedSelector with Lightning Menu)
  - Shows: "Connected to: node-{id}.yaml" if connected
  
- **Node File Metadata (read-only, shown if connected):**
  - Display label: "Shared Definition: {node_file.name}"
  - Display description: "{node_file.description}" (smaller text, italic)

**Section: Event Reference (if node has `node.event_id`)**
- `node.event_id` (EnhancedSelector, read-only connection to event file)
- Display: "Event: {event.name}" with link to event definition

### 4.3 Node Properties Panel (Case Node)

**Section: Node Metadata**
- `node.label` (text input)
- `node.description` (textarea)

**Section: Case Connection**
- **Case File Connection:**
  - `node.case.id` (EnhancedSelector with Lightning Menu)
  - Shows: "Connected to: case-{id}.yaml" if connected
  
- **Case File Metadata (read-only, shown if connected):**
  - Display label: "Case: {case.name}"
  - Display description: "{case.description}" (smaller text, italic)
  - Display type: "Type: {case.type}"
  
- **Variant Weights:**
  - For each variant in `node.case.variants`:
    - Display: "{variant.name}: {variant.weight}" (slider)
  - Display timestamp: "Schedule from: {schedules[latest].window_from}"

**Section: Node File Connection (optional, if node also has `node.node_id`)**
- Same as non-case nodes above

---

## 5. Key Design Principles

1. **Clear Ownership Boundaries**
   - Graph objects (nodes, edges) own their own display metadata
   - Business data objects (parameters, cases) own their measurement/test metadata
   - These are independent and should not conflict

2. **CREATE = Helpful Defaults**
   - When creating new files, pre-populate from graph context
   - User edits and saves, establishing independent metadata
   - After creation, no automatic metadata sync

3. **GET/PUT = Data Values Only**
   - GET operations sync current values (statistics, weights) NOT metadata
   - PUT operations append new values to history, NOT metadata updates
   - Exception: Node files ARE metadata (shared definitions)

4. **Properties Panel = Show All Layers**
   - Display graph object's own metadata (editable)
   - Display connected file's metadata (read-only, for context)
   - Display synced data values (editable, with override indicators)
   - Make hierarchy clear with visual grouping and labeling

5. **Override Flags = User Control**
   - Any auto-synced field can be manually overridden
   - Once overridden, automatic updates are blocked for that specific field
   - User can "un-override" by clicking the Zap icon to re-enable auto-sync

---

## 6. Phase 1D Action Items

- [ ] Update `PropertiesPanel.tsx` edge section to show parameter metadata (read-only) when edge has `edge.p.id`
- [ ] Update `PropertiesPanel.tsx` node section to show node file metadata (read-only) when node has `node.node_id`
- [ ] Update `PropertiesPanel.tsx` case node section to show case file metadata (read-only) when node has `node.case.id`
- [ ] Add visual hierarchy/grouping to distinguish:
  - Graph object metadata (editable)
  - Connected file metadata (read-only, contextual)
  - Synced data values (editable, with override flags)
- [ ] Ensure all override indicators (ZapOff icons) are present and functional
- [ ] Add evidence display sections for `edge.p.evidence`, `edge.cost_gbp.evidence`, etc.
- [ ] Test that parameter/case/node file metadata displays correctly and does not conflict with graph object metadata

