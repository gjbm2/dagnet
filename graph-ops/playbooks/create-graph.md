# Create Graph Playbook

Step-by-step for creating a new conversion funnel graph from scratch.

**Prerequisite**: You are on a feature branch in `<private-repo>` (see [branch-workflow.md](branch-workflow.md)).

---

## Step 1: Design the Funnel

Before touching files, define the funnel structure:

1. **Entry point(s)** — where users enter (e.g. landing page, app open)
2. **Key steps** — the conversion milestones (e.g. signup, delegation, registration)
3. **Terminal states** — success outcomes and abandonment/failure states
4. **Edges** — which transitions are possible between steps
5. **Branching logic** — where the funnel splits (e.g. by customer type, A/B variant)

Write this down as a simple list before proceeding.

---

## Step 2: Create Event Files

For each unique analytics event in the funnel, create `<private-repo>/events/<id>.yaml`.

```yaml
id: <event-id>
name: <human-readable-name>
description: "<what this event represents>"
category: conversion
tags: []
provider_event_names:
  amplitude: "<exact Amplitude event name>"
amplitude_filters: []
metadata:
  created_at: <now ISO>
  updated_at: <now ISO>
  status: active
  author: user
  version: 1.0.0
```

If the event requires property filtering in Amplitude:
```yaml
amplitude_filters:
  - property: <property-name>
    operator: is any of
    values:
      - "<value1>"
      - "<value2>"
```

**Reuse existing events** where possible — check `<private-repo>/events-index.yaml` first.

---

## Step 3: Create Node Files

For each graph node, create `<private-repo>/nodes/<id>.yaml`.

```yaml
id: <node-id>
name: <human-readable-name>
event_id: <event-id>
metadata:
  created_at: <now ISO>
  updated_at: <now ISO>
  version: 1.0.0
  author: user
```

- `id` must match the filename (without `.yaml`)
- `event_id` is optional — only needed if the node maps to an analytics event
- Multiple nodes can share the same `event_id` (with different filter conditions)

---

## Step 4: Create the Graph JSON

Create `<private-repo>/graphs/<graph-name>.json`.

### Structure

```json
{
  "nodes": [],
  "edges": [],
  "policies": {
    "default_outcome": "drop"
  },
  "metadata": {
    "name": "<graph-name>",
    "description": "<what this funnel models>",
    "version": "1.0.0",
    "created_at": "<now ISO>",
    "updated_at": "<now ISO>"
  },
  "postits": [],
  "dailyFetch": false
}
```

### Adding Nodes

Each node needs a unique UUID. Generate v4 UUIDs.

```json
{
  "uuid": "<generated-uuid>",
  "id": "<node-id>",
  "label": "Human-Readable Label",
  "absorbing": false,
  "entry": { "is_start": true, "entry_weight": 1 },
  "layout": { "x": -600, "y": 0 }
}
```

- **Start node**: Set `entry.is_start: true`. Typically one per graph.
- **Terminal nodes**: Set `absorbing: true` for endpoints (success, abandonment).
- **`id`**: References the node registry file. Leave empty (`""`) if no registry binding yet.
- **`label`**: Display name on canvas. Set `label_overridden: true` if you want it fixed.

### Adding Edges

```json
{
  "uuid": "<generated-uuid>",
  "from": "<source-node-uuid>",
  "to": "<target-node-uuid>",
  "p": { "mean": 0.5 }
}
```

- `from`/`to` are **node UUIDs** (not human IDs)
- `p.mean` is the initial probability estimate (will be replaced by real data later)
- For a node's outgoing edges, probabilities should ideally sum to ~1.0 (residual goes to default outcome)

### Layout Guidelines

- Flow runs **left to right** (increasing x)
- Start node at x ≈ -600, terminal nodes at x ≈ +800 to +1200
- Vertical spacing: ~120-150px between parallel paths
- Main happy path along y ≈ 0; branches above (y negative) and below (y positive)

---

## Step 5: Create Parameter Files

For each edge that will carry data, create `<private-repo>/parameters/<id>.yaml`.

```yaml
id: <param-id>
name: <param-id>
type: probability
query: from(<source-node-id>).to(<target-node-id>)
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
  created_at: <now ISO>
  updated_at: <now ISO>
  author: user
  version: 1.0.0
  status: active
  aliases: []
  references: []
```

**Naming convention**: `<from-node>-to-<to-node>` (e.g. `landing-to-signup`).

The `query` field references **node IDs** (not UUIDs). The app uses this to auto-fetch data from Amplitude.

---

## Step 6: Update Index Files

Add entries to each relevant index file.

### nodes-index.yaml

Add under the `nodes:` array:
```yaml
  - id: <node-id>
    file_path: nodes/<node-id>.yaml
    status: active
    created_at: <now ISO>
    updated_at: <now ISO>
    author: user
    version: 1.0.0
    name: <human-readable-name>
```

### events-index.yaml

Add under the `events:` array:
```yaml
  - id: <event-id>
    file_path: events/<event-id>.yaml
    status: active
    created_at: <now ISO>
    updated_at: <now ISO>
    author: user
    version: 1.0.0
    name: <event-name>
```

### parameters-index.yaml

Add under the `parameters:` array:
```yaml
  - id: <param-id>
    file_path: parameters/<param-id>.yaml
    status: active
    type: probability
    created_at: <now ISO>
    updated_at: <now ISO>
    author: user
    version: 1.0.0
```

**Also update** the top-level `updated_at` field on each index file.

---

## Step 7: Validate and Commit

```bash
bash ../graph-ops/scripts/validate-indexes.sh
bash ../graph-ops/scripts/commit-and-push.sh "Add <graph-name> funnel"
```

Then follow the test and merge steps in [branch-workflow.md](branch-workflow.md).

---

## Checklist

- [ ] All events have Amplitude mappings (`provider_event_names.amplitude`)
- [ ] All graph nodes have valid UUIDs (no duplicates)
- [ ] All edges reference valid node UUIDs within the same graph
- [ ] Edge probabilities from each node sum to ~1.0 (or less, with residual)
- [ ] Parameter `query` fields reference valid node IDs
- [ ] All entity files have corresponding index entries
- [ ] Index `file_path` values match actual file locations
- [ ] Graph `id` fields on nodes match node registry file IDs
