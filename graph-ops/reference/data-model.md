# DagNet Data Model Reference

This document is a complete reference for AI agents working with DagNet conversion graphs. It covers the graph JSON format, registry file schemas, and the relationships between entities.

## Overview

A DagNet workspace consists of:

| Entity        | Format | Location                     | Purpose                                                   |
|---------------|--------|------------------------------|-----------------------------------------------------------|
| **Graph**     | JSON   | `graphs/*.json` or `*.yaml`  | Visual DAG: nodes, edges, layout, policies                |
| **Node**      | YAML   | `nodes/*.yaml`               | Node definitions (event bindings, metadata)               |
| **Event**     | YAML   | `events/*.yaml`              | Event definitions (Amplitude mappings, property filters)  |
| **Parameter** | YAML   | `parameters/*.yaml`          | Edge data: probabilities, costs, time-series values       |
| **Context**   | YAML   | `contexts/*.yaml`            | Segmentation dimensions (channel, device, etc.)           |
| **Case**      | YAML   | `cases/*.yaml`               | A/B test / experiment definitions                         |
| **Index**     | YAML   | `*-index.yaml` (at root)     | Index files listing all entities of each type              |

Each entity type has an index file at the workspace root (e.g. `nodes-index.yaml`).

---

## 1. Graph JSON

The graph is the core artefact — a directed acyclic graph (DAG) modelling a conversion funnel.

### Top-Level Structure

```json
{
  "nodes": [ /* GraphNode[] */ ],
  "edges": [ /* GraphEdge[] */ ],
  "policies": {
    "default_outcome": "drop"
  },
  "metadata": {
    "name": "my-graph",
    "description": "...",
    "version": "1.0.0",
    "created_at": "2026-02-10T12:00:00Z",
    "updated_at": "2026-02-10T12:00:00Z"
  },
  "postits": [],
  "dailyFetch": false,
  "baseDSL": "window(-30d:)",
  "currentQueryDSL": "window(-30d:)",
  "dataInterestsDSL": "context(channel);context(browser-type).window(-90d:)"
}
```

### GraphNode

Each node in the graph:

| Field                  | Type    | Required | Description                                              |
|------------------------|---------|----------|----------------------------------------------------------|
| `uuid`                 | string  | Yes      | System-generated UUID (v4)                               |
| `id`                   | string  | Yes      | Human-readable ID (kebab-case). Empty string if unbound  |
| `label`                | string  | No       | Display label in the UI                                  |
| `label_overridden`     | boolean | No       | If true, label was manually set (won't auto-sync)        |
| `absorbing`            | boolean | No       | If true, this is a terminal/absorbing state              |
| `entry`                | object  | No       | Start node configuration                                 |
| `entry.is_start`       | boolean | No       | True if this is a funnel entry point                     |
| `entry.entry_weight`   | number  | No       | Weight for multi-start graphs (default 1)                |
| `layout`               | object  | No       | `{ x: number, y: number }` — canvas position            |
| `event_id`             | string  | No       | FK to event registry file                                |
| `event_id_overridden`  | boolean | No       | Override flag for auto-sync                              |
| `type`                 | string  | No       | Node type (default "normal")                             |
| `outcome_type`         | string  | No       | "success" or "failure" for terminal nodes                |
| `costs`                | object  | No       | Cost definitions on the node                             |
| `residual_behavior`    | object  | No       | What happens to un-transitioned probability mass         |
| `case`                 | object  | No       | A/B test configuration                                   |
| `url`                  | string  | No       | External URL reference                                   |
| `images`               | array   | No       | Node image attachments                                   |

### GraphEdge

Each edge represents a transition between nodes:

| Field                  | Type    | Required | Description                                              |
|------------------------|---------|----------|----------------------------------------------------------|
| `uuid`                 | string  | Yes      | System-generated UUID (v4)                               |
| `id`                   | string  | No       | Human-readable ID                                        |
| `from`                 | string  | Yes      | Source node UUID                                         |
| `to`                   | string  | Yes      | Target node UUID                                         |
| `fromHandle`           | string  | No       | Source handle position                                   |
| `toHandle`             | string  | No       | Target handle position                                   |
| `p`                    | object  | No       | Base probability `{ mean, stdev? }`                      |
| `conditional_p`        | array   | No       | Context-conditional probabilities                        |
| `weight_default`       | number  | No       | Default weight (>= 0)                                    |
| `cost_gbp`             | object  | No       | Cost in GBP                                              |
| `labour_cost`          | object  | No       | Labour cost (time)                                       |
| `query`                | string  | No       | Query DSL for data retrieval                             |
| `query_overridden`     | boolean | No       | True if manually edited                                  |
| `n_query`              | string  | No       | Explicit denominator query (when different from k query) |
| `n_query_overridden`   | boolean | No       | True if manually edited                                  |
| `case_variant`         | string  | No       | A/B test variant name                                    |
| `case_id`              | string  | No       | A/B test case reference                                  |
| `display`              | object  | No       | Visual display options                                   |

### Probability Object (`p`)

```json
{
  "mean": 0.35,
  "stdev": 0.05,
  "ci_lower": 0.28,
  "ci_upper": 0.42
}
```

### Query DSL

The query DSL is used on edges and parameters to define data retrieval expressions:

```
from(source-node).to(target-node)
from(source-node).to(target-node).exclude(abandoned)
from(source-node).to(target-node).visited(feature-view)
from(source-node).to(target-node).case(test-2025:treatment)
```

The query references node IDs (not UUIDs). When a node ID is renamed, all queries referencing it must be updated.

---

## 2. Node Registry (YAML)

Individual node definition files in `nodes/*.yaml`:

```yaml
id: landing-page
name: Landing page
event_id: landing-page-high-intent
metadata:
  created_at: 2026-02-10T16:57:21.784Z
  updated_at: 2026-02-10T16:57:21.784Z
  version: 1.0.0
  author: user
```

Key fields:
- `id` — must match the filename (without `.yaml`)
- `name` — human-readable display name
- `event_id` — optional FK linking to an event definition
- `metadata` — standard metadata block

---

## 3. Event Registry (YAML)

Event definitions in `events/*.yaml`. Events map graph concepts to analytics provider events (primarily Amplitude).

```yaml
id: landing-page-high-intent
name: landing-page-high-intent
tags: []
provider_event_names:
  amplitude: Viewed Marketing Site Landing Page
amplitude_filters:
  - property: path
    operator: is
    values:
      - /save-on-energy
metadata:
  created_at: 2026-02-09T10:11:39.306Z
  updated_at: 2026-02-09T10:11:39.306Z
  status: active
  author: user
  version: 1.0.0
```

Key fields:

| Field                   | Type   | Description                                                  |
|-------------------------|--------|--------------------------------------------------------------|
| `id`                    | string | Canonical event ID (kebab-case, max 128 chars)               |
| `name`                  | string | Human-readable name                                          |
| `description`           | string | What this event represents                                   |
| `category`              | string | One of: user_action, system_event, milestone, conversion, page_view, error |
| `tags`                  | array  | Categorisation tags                                          |
| `provider_event_names`  | object | Provider-specific event name mappings (e.g. `amplitude: "..."`) |
| `amplitude_filters`     | array  | Property filters for Amplitude queries                       |

### Amplitude Filters

```yaml
amplitude_filters:
  - property: newDelegationStatus
    operator: is any of
    values:
      - 'ON'
```

Operators: `is`, `is not`, `is any of`, `is not any of`, `contains`, `does not contain`

---

## 4. Parameter Registry (YAML)

Parameters store the quantitative data for edges — probabilities, costs, and their time-series history. They are the richest entity type.

### Minimal Example

```yaml
id: landing-to-signup
name: landing-to-signup
type: probability
query: from(landing-page).to(signup)
query_overridden: false
n_query_overridden: false
values:
  - mean: 0.35
metadata:
  description: "Conversion rate from landing page to signup"
  created_at: 2026-02-10T17:00:00Z
  updated_at: 2026-02-10T17:00:00Z
  author: user
  version: 1.0.0
  status: active
```

### Full Example (with fetched data)

```yaml
id: landing-hi-intent-to-household-created-anon
name: landing-hi-intent-to-household-created-anon
type: probability
query: from(landing-page).to(household-created-anonymously)
query_overridden: false
n_query_overridden: false
values:
  - mean: 0.5          # Default/initial value (no data yet)
    n_daily: []
    k_daily: []
    dates: []
  - mean: 0.561         # Computed from fetched data (k/n)
    n: 529              # Total sample size
    k: 297              # Total conversions
    n_daily: [29, 92, 107, 77, 60, 62, 43, 59]
    k_daily: [8, 59, 55, 41, 37, 40, 23, 34]
    dates: [3-Feb-26, 4-Feb-26, 5-Feb-26, ...]
    query_signature: '{"c":"49feca...","x":{}}'
    cohort_from: 3-Feb-26
    cohort_to: 10-Feb-26
    sliceDSL: "cohort(landing-page,3-Feb-26:10-Feb-26)"
    data_source:
      type: amplitude
      retrieved_at: 2026-02-10T17:06:54.155Z
      full_query: from(landing-page).to(household-created-anonymously)
metadata:
  description: ""
  constraints:
    discrete: false
  tags: []
  created_at: 2026-02-10T17:04:11.873Z
  updated_at: 2026-02-10T17:04:11.873Z
  author: user
  version: 1.0.0
  status: active
```

### Parameter Types

| Type          | Description                         |
|---------------|-------------------------------------|
| `probability` | Conversion probability (0-1)        |
| `cost_gbp`    | Monetary cost in GBP                |
| `labour_cost` | Labour/time cost                    |

### Values Array

The `values` array holds one or more data snapshots (slices). Each slice can contain:

| Field                 | Description                                              |
|-----------------------|----------------------------------------------------------|
| `mean`                | Mean/expected value (required)                           |
| `stdev`               | Standard deviation                                       |
| `n`                   | Total sample size                                        |
| `k`                   | Number of conversions/successes                          |
| `n_daily` / `k_daily` | Daily breakdown arrays (parallel to `dates`)            |
| `dates`               | Date labels in `d-MMM-yy` format                        |
| `window_from/to`      | Time window for this value                               |
| `cohort_from/to`      | Cohort entry window bounds                               |
| `sliceDSL`            | Canonical slice label                                    |
| `context_id`          | Context dimension for this slice                         |
| `distribution`        | Statistical distribution (beta, normal, etc.)            |
| `query_signature`     | SHA-256 hash for consistency checking                    |
| `data_source`         | Provenance: type, retrieved_at, full_query, debug_trace  |
| `median_lag_days`     | Per-cohort-day median lag (latency feature)              |
| `mean_lag_days`       | Per-cohort-day mean lag                                  |
| `latency`             | Summary latency object (histogram, t95, completeness)    |
| `forecast`            | Mature baseline probability (p_∞) for forecasting        |

### Latency Configuration (Edge-Level)

Parameters can carry latency configuration for edges with time-delayed conversions:

```yaml
latency:
  latency_parameter: true
  anchor_node_id: start-node
  t95: 14.5
  onset_delta_days: 0.5
  mu: 1.2
  sigma: 0.8
  model_trained_at: 10-Feb-26
```

---

## 5. Context Registry (YAML)

Contexts define segmentation dimensions:

```yaml
id: channel
name: Marketing Channel
description: Primary acquisition channel based on utm_medium
metadata:
  created_at: 2025-11-24T12:40:40.451Z
  updated_at: 2025-11-24T12:40:40.457Z
  author: user
  version: 1.0.0
```

Context values are categorical (e.g. channel: `google`, `facebook`, `direct`).

---

## 6. Index Files

Each entity type has a root-level index file. These list all entities and their metadata:

```yaml
version: 1.0.0
created_at: 2025-11-24T10:43:39.915Z
nodes:                    # or events: / parameters: / contexts:
  - id: landing-page
    file_path: nodes/landing-page.yaml
    status: active
    created_at: 2026-02-10T16:57:21.784Z
    updated_at: 2026-02-10T16:57:21.787Z
    author: user
    version: 1.0.0
    name: landing-page
updated_at: 2026-02-10T16:59:09.350Z
metadata:
  created_at: 2025-11-24T13:02:17.553Z
  version: 1.0.0
```

**Critical**: Index files must be at root with plural names: `nodes-index.yaml`, `events-index.yaml`, `parameters-index.yaml`, `contexts-index.yaml`.

---

## 7. Entity Relationships

```
Graph JSON
  └── nodes[] ──(id)──→ Node YAML ──(event_id)──→ Event YAML
  └── edges[] ──(query)──→ Parameter YAML
                    └── from/to reference node UUIDs in the same graph
```

- **Graph → Node**: A graph node's `id` field maps to a node YAML file. A node can appear in multiple graphs.
- **Node → Event**: A node's `event_id` maps to an event YAML file. Events define the Amplitude event mapping.
- **Edge → Parameter**: An edge's probability data comes from a parameter file. The parameter's `query` field (`from(X).to(Y)`) links it to the edge by referencing node IDs.
- **Parameter → Context**: Parameter value slices can reference context IDs for segmented data.

---

## 8. Creating a New Graph — Checklist

1. **Define the funnel steps** — identify the key events/states in the conversion flow
2. **Create event files** — for each unique analytics event, create `events/{id}.yaml` with Amplitude mapping
3. **Create node files** — for each graph node, create `nodes/{id}.yaml` linking to its event
4. **Create the graph JSON** — define nodes (with UUIDs), edges, layout, and policies
5. **Create parameter files** — for each edge, create `parameters/{id}.yaml` with initial values
6. **Update index files** — add entries to `nodes-index.yaml`, `events-index.yaml`, `parameters-index.yaml`
7. **Validate** — check all FK references resolve, all queries reference valid node IDs

### UUID Generation

Graph node/edge UUIDs must be valid v4 UUIDs. Generate them using standard UUID v4 format:
`xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx` where x is hex and y is 8, 9, a, or b.

### Layout Guidelines

- Canvas coordinates are in pixels; typical range is -1000 to +2000 for both x and y
- Flow typically runs left-to-right (increasing x)
- Vertical spacing of ~100-150px between parallel paths
- Start nodes on the far left, terminal/absorbing nodes on the far right

---

## 9. Canonical Schema Locations

| Schema                    | Path                                                      |
|---------------------------|-----------------------------------------------------------|
| Parameter YAML schema     | `graph-editor/public/param-schemas/parameter-schema.yaml` |
| Event YAML schema         | `graph-editor/public/param-schemas/event-schema.yaml`     |
| TypeScript type defs      | `graph-editor/src/types/index.ts`                         |
| Python Pydantic models    | `graph-editor/lib/graph_types.py`                         |
