# Create Entities Playbook

How to create individual entity files (node, event, parameter, context) in `nous-conversion`.

Use this when adding entities to an existing graph or when [create-graph.md](create-graph.md) tells you to create specific entities.

---

## Before Creating Anything

**Always check for existing entities first.**

```bash
# Check if a similar event already exists
grep -i "<event-name>" nous-conversion/events-index.yaml

# Check existing nodes
grep -i "<node-name>" nous-conversion/nodes-index.yaml

# Check existing parameters
grep -i "<param-name>" nous-conversion/parameters-index.yaml
```

Reuse existing entities where the semantics match. Don't create duplicates.

---

## Event

**When**: You need to map a graph concept to an analytics provider event.

**File**: `nous-conversion/events/<id>.yaml`

```yaml
id: <kebab-case-id>
name: <human-readable-name>
description: "<what this event represents>"
category: conversion
tags: []
provider_event_names:
  amplitude: "<exact Amplitude event name>"
amplitude_filters: []
metadata:
  created_at: <ISO timestamp>
  updated_at: <ISO timestamp>
  status: active
  author: user
  version: 1.0.0
```

### With Amplitude Filters

Use filters when the Amplitude event is shared across multiple graph concepts and needs scoping:

```yaml
amplitude_filters:
  - property: path
    operator: is
    values:
      - /save-on-energy
```

**Operators**: `is`, `is not`, `is any of`, `is not any of`, `contains`, `does not contain`

### Index Entry

Add to `nous-conversion/events-index.yaml` under `events:`:

```yaml
  - id: <event-id>
    file_path: events/<event-id>.yaml
    status: active
    created_at: <ISO timestamp>
    updated_at: <ISO timestamp>
    author: user
    version: 1.0.0
    name: <event-name>
```

---

## Node

**When**: You need a named step in a conversion funnel.

**File**: `nous-conversion/nodes/<id>.yaml`

```yaml
id: <kebab-case-id>
name: <human-readable-name>
event_id: <event-id>
metadata:
  created_at: <ISO timestamp>
  updated_at: <ISO timestamp>
  version: 1.0.0
  author: user
```

- `event_id` is optional — omit it if the node doesn't correspond to a trackable event
- `id` must match the filename

### Index Entry

Add to `nous-conversion/nodes-index.yaml` under `nodes:`:

```yaml
  - id: <node-id>
    file_path: nodes/<node-id>.yaml
    status: active
    created_at: <ISO timestamp>
    updated_at: <ISO timestamp>
    author: user
    version: 1.0.0
    name: <node-name>
```

---

## Parameter

**When**: You need to store probability/cost data for a graph edge.

**File**: `nous-conversion/parameters/<id>.yaml`

### Probability Parameter (most common)

```yaml
id: <from-node>-to-<to-node>
name: <from-node>-to-<to-node>
type: probability
query: from(<from-node-id>).to(<to-node-id>)
query_overridden: false
n_query_overridden: false
values:
  - mean: 0.5
metadata:
  description: "<what this transition represents>"
  description_overridden: false
  constraints:
    discrete: false
  tags: []
  created_at: <ISO timestamp>
  updated_at: <ISO timestamp>
  author: user
  version: 1.0.0
  status: active
  aliases: []
  references: []
```

### Cost Parameter

```yaml
type: cost_gbp
# or
type: labour_cost
```

Same structure, different `type` field.

### Naming

- Standard: `<from-node>-to-<to-node>` (e.g. `landing-to-signup`)
- If ambiguous (multiple edges between same nodes): add a qualifier (e.g. `landing-to-signup-mobile`)

### Index Entry

Add to `nous-conversion/parameters-index.yaml` under `parameters:`:

```yaml
  - id: <param-id>
    file_path: parameters/<param-id>.yaml
    status: active
    type: probability
    created_at: <ISO timestamp>
    updated_at: <ISO timestamp>
    author: user
    version: 1.0.0
```

---

## Context

**When**: You need a new segmentation dimension (rare — usually reuse existing contexts).

**File**: `nous-conversion/contexts/<id>.yaml`

```yaml
id: <kebab-case-id>
name: <human-readable-name>
description: "<what this dimension segments by>"
metadata:
  created_at: <ISO timestamp>
  updated_at: <ISO timestamp>
  author: user
  version: 1.0.0
```

### Existing Contexts

Check `nous-conversion/contexts-index.yaml` — current contexts are:
- `browser-type` — Browser Type
- `channel` — Marketing Channel
- `device-family` — Device Family
- `nousmates` — Nousmates (internal)

### Index Entry

Add to `nous-conversion/contexts-index.yaml` under `contexts:`.

---

## Common Mistakes

1. **Forgetting the index entry** — every entity file must have a matching index entry
2. **ID/filename mismatch** — `id` in the YAML must match the filename (without `.yaml`)
3. **Wrong Amplitude event name** — must be the exact event name as it appears in Amplitude (case-sensitive)
4. **Duplicate entities** — always search before creating; reuse where semantics match
5. **Missing `provider_event_names`** — events won't map to data without this
6. **Wrong date format** — data dates use `d-MMM-yy` (e.g. `10-Feb-26`), timestamps use ISO
