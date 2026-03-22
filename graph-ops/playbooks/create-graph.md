# Create Graph Playbook

Step-by-step for creating a new conversion funnel graph from scratch.

**Prerequisite**: You are on a feature branch in the data repo (see [branch-workflow.md](branch-workflow.md)). `<data-dir>` below refers to the directory name configured in `graph-ops/repos.conf`.

---

## ⛔ STOP — Read Before Writing Any File

These are the most common mistakes. Check them before starting and again before committing.

### Node IDs must be backed by catalog files
Every graph node `id` must match an existing `nodes/<id>.yaml` file. **Never invent an ID** — check `nodes-index.yaml` first, reuse if a match exists, create a new node file if not.

### Every edge must have a parameter file
For every edge in the graph, there must be a corresponding `parameters/<id>.yaml` file (named `<from-node>-to-<to-node>`). Without it, the edge cannot pull data from Amplitude. Create stubs at minimum — the app will populate them on first fetch.

### Do NOT set these fields on graph nodes
The editor manages these — setting them manually causes merge conflicts and data corruption:
- `event: { id: "..." }` — **never set**; use `event_id: "<id>"` string only
- `images: []` — **omit entirely** when empty

### Edge IDs follow a strict convention
Edge `id` must be `<from-node-id>-to-<to-node-id>` — e.g. `hif-landing-page-to-hif-address-setup`. Do not use shorthand or invented names.

### Parameter file query is the base query only
The parameter file `query` field must be `from(<node>).to(<node>)` with **no context and no window**. Context is added at the edge level. The app uses the base query to look up and populate the file.

### Enable daily fetch
Set `"dailyFetch": true` on any graph that uses Amplitude data, so probabilities refresh automatically.

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

For each unique analytics event in the funnel, create `<data-dir>/events/<id>.yaml`.

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

**Reuse existing events** where possible — check `<data-dir>/events-index.yaml` first.

---

## Step 3: Create Node Files

For each graph node, create `<data-dir>/nodes/<id>.yaml`.

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

Create `<data-dir>/graphs/<graph-name>.json`.

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

For each edge that will carry data, create `<data-dir>/parameters/<id>.yaml`.

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

## Step 7: Auto-Arrange Layout

Before publishing, do a layout pass to make the graph easy to read.

### Auto-arrange rules

1. **Flow direction**: The graph should read left-to-right. The entry node sits at the leftmost x position; terminal (absorbing) nodes sit at the rightmost.
2. **One input face, one output face per node**: Incoming edges should arrive on the **left** side of a node and outgoing edges should leave from the **right** side. This means nodes along a path must be laid out so upstream is always to the left and downstream is always to the right — no backtracking or crossing.
3. **Layered x-positions**: Group nodes into layers by their topological depth from the entry node. Space layers evenly (e.g. 500-600px apart in x).
4. **Vertical separation by path**: Within a layer, space nodes vertically (100-300px in y) so parallel branches don't overlap. Keep the main/happy path near y=0, branches above and below.
5. **Minimise edge crossings**: If two branches cross visually, swap their vertical positions to reduce crossings.
6. **Abandon/failure nodes below**: Place absorbing failure nodes below the main flow (higher y values) to keep the happy path visually prominent.
7. **Post-it notes**: Position any post-it annotations near the relevant branching point, offset slightly so they don't overlap nodes.

### Quick check

After arranging, scan the graph from left to right:
- Every edge should point rightward (increasing x). If any edge points left, the layout has a problem.
- No two nodes should share the same (x, y) position.
- The graph should be legible at default zoom without nodes overlapping.

---

## Step 8: Validate and Commit

```bash
bash ../graph-ops/scripts/validate-indexes.sh
bash ../graph-ops/scripts/validate-graph.sh graphs/<graph-name>.json --deep
bash ../graph-ops/scripts/commit-and-push.sh "Add <graph-name> funnel"
```

The `--deep` flag runs the production IntegrityCheckService against the graph and all its referenced entities — the same engine that powers the app's Graph Issues panel. See [Validate a Graph](validate-graph.md) for details on interpreting results and fixing failures.

Then follow the test and merge steps in [branch-workflow.md](branch-workflow.md).

---

## Pre-Commit Checklist

Work through this in order before every commit. Each item maps to a known failure mode.

**Entities**
- [ ] Every event file has `provider_event_names.amplitude` set to the exact Amplitude event name
- [ ] Every node `id` matches a `nodes/<id>.yaml` file — no invented IDs
- [ ] No node in the graph JSON has an `event: { id }` object — only `event_id: "<id>"` string
- [ ] No node in the graph JSON has `images: []` — omit the field entirely when empty

**Graph structure**
- [ ] All graph nodes have unique v4 UUIDs
- [ ] All edges reference valid node UUIDs within the same graph
- [ ] Edge `id` follows `<from-node-id>-to-<to-node-id>` convention for every edge
- [ ] Edge probabilities from each node sum to ~1.0 (or less, with residual going to default outcome)
- [ ] `"dailyFetch": true` is set if the graph uses Amplitude data

**Layout**
- [ ] All edges flow left-to-right (increasing x) — no backward-pointing edges
- [ ] Each node has one input face (left) and one output face (right) — no edges arriving from the right or leaving to the left
- [ ] No two nodes share the same (x, y) position
- [ ] Absorbing failure nodes are placed below the main flow
- [ ] Graph is legible at default zoom without overlapping nodes

**Parameter files**
- [ ] Every edge has a corresponding `parameters/<from-node>-to-<to-node>.yaml` file
- [ ] Each parameter file `query` is the base query only — `from(<node>).to(<node>)` with no context or window
- [ ] Each parameter file has a meaningful `metadata.description` explaining what the transition measures

**Index files**
- [ ] Every new node file has an entry in `nodes-index.yaml`
- [ ] Every new event file has an entry in `events-index.yaml`
- [ ] Every new parameter file has an entry in `parameters-index.yaml`
- [ ] Index `file_path` values match actual file locations
- [ ] Top-level `updated_at` on each modified index file is updated
