# Build a Funnel Graph — End-to-End Playbook

This playbook is a step-by-step operating guide for building a conversion funnel graph from an existing conceptual graph or business requirement, wiring it to real analytics data, and validating it end-to-end.

It was developed using the **playbook-first method**: each section was drafted *before* being executed on a real project, then revised based on what we actually encountered.

**Prerequisites**: You are on a feature branch in the data repo (see [branch-workflow.md](branch-workflow.md)). You have access to the production monorepo for event verification.

---

## Phase 0: Audit the Funnel Graph Against Production Code

### Goal

Produce a node-by-node audit that maps every node in the graph to its real-world analytics event (or flags it as unmeasurable). This is the foundation for everything that follows — if the audit is wrong, the entity files, queries, and data will all be wrong.

### When to do this

- You have an existing graph (or sketch) that represents the commercial funnel
- The graph has nodes that are not yet wired to entity files, or you suspect the wiring is incorrect
- You need to understand which parts of the funnel are measurable with current analytics instrumentation

### Step 1: Enumerate the graph nodes

Open the graph JSON and list every node with its:
- UUID (for cross-referencing edges)
- Label (the human-readable name on the canvas)
- Current `id` field (empty string means unbound)
- Whether it's marked `absorbing`
- Whether it's a start node (`entry.is_start`)

**Tip**: Use the helper script from [edit-existing-graph.md](edit-existing-graph.md):
```bash
python3 -c "
import json, sys
g = json.load(open(sys.argv[1]))
for n in g['nodes']:
    flags = []
    if n.get('entry', {}).get('is_start'): flags.append('START')
    if n.get('absorbing'): flags.append('ABSORBING')
    if n.get('type') == 'case': flags.append('CASE')
    print(f\"{n['uuid'][:8]}  id={n['id']!r:30s}  label={n.get('label', '')!r:40s}  {' '.join(flags)}\")
" graphs/<graph-name>.json
```

### Step 2: Identify the analytics event for each node

For each node, determine which analytics event (if any) represents "the user reached this state". Work through these sources in order:

1. **Analytics funnel screenshots** — If you have a funnel chart from your analytics provider, match each bar/step to a graph node. Note the exact event name and any property filters shown.

2. **Existing entity files** — Check if an event file already exists in `events/` that covers this node. Search by concept, not by ID:
   ```bash
   grep -ri "<concept>" events/
   ```

3. **Production codebase** — This is the authoritative source. For each node:
   - Identify which user action/state the node represents
   - Find the flow configuration that contains that step
   - Trace the tracking code to confirm the exact analytics event name and properties

### Step 3: Navigate the production codebase for event verification

Your production codebase will have its own conventions for where tracking events are defined. Common patterns:

- **Flow configs**: Step definitions with step IDs that map to event properties
- **Tracking utilities**: Functions that construct analytics events from step/flow identifiers
- **Custom events**: Bespoke events fired by specific component files
- **Server-side events**: Events fired from API handlers, not the frontend framework

**Verification checklist for each event**:
- [ ] Analytics event name matches exactly (case-sensitive)
- [ ] Property name for filtering is correct
- [ ] Filter value is correct
- [ ] The event fires at the right moment (viewed vs completed vs custom)

### Step 4: Classify each node

Assign each node one of these statuses:

- **Measurable**: A known analytics event fires when the user reaches this state. Record the event name, property, and filter.
- **Unmeasurable — needs investigation**: The node represents a real state, but it's unclear whether an analytics event exists. Flag for deeper investigation.
- **Unmeasurable — needs new instrumentation**: The node represents a real state, but no analytics event currently fires. This is a gap that requires a product/engineering ticket.
- **Conceptual only**: The node represents a logical category that isn't a discrete user state. These may need to be modelled differently (e.g. as case nodes or removed).

### Step 5: Produce the audit document

Create `graph-ops/reference/<graph-name>-audit.md` (in the data repo, not this public repo) with:

1. **Summary**: Graph name, node count, edge count, how many measurable vs unmeasurable
2. **Node audit table**: One row per node with columns:
   - Node label
   - Proposed entity ID
   - Analytics event name (or "UNMEASURABLE")
   - Event property + filter
   - Production source (file path)
   - Existing entity (if any, with correctness assessment)
   - Status (measurable / needs investigation / needs instrumentation / conceptual)
3. **Gaps and decisions**: List of unmeasurable nodes with recommended action
4. **Edge summary**: Total edges, notable query patterns needed

### Common pitfalls

- **Step ID vs flow ID confusion**: Some analytics filters use a step property (individual step within a flow), others use a flow-level identifier. Check which one the analytics funnel uses.
- **Variant differences**: The codebase may have multiple variants of a flow. Step IDs are usually the same across variants, but confirm this.
- **Event name construction**: Check how event names are assembled in the tracking code — they may be composed from multiple strings.
- **Conditional steps**: Some steps are gated by conditions. These steps only fire events for users who meet the condition. This affects funnel denominators.

---

## Phase 1: Create and Verify Entity Files

### Goal

Create event, node, and context entity files for every node in the graph. Each measurable node gets an event file verified against production; every node gets a node file; a context file defines the traffic segment.

### Step 1: Decide on an entity ID prefix

Use a short, unique prefix for all entities in this graph project (e.g. `proj-` for "project name"). This:
- Avoids collisions with entities from other graphs
- Makes it easy to find/list all entities for this project
- Creates a clear namespace for index entries

### Step 2: Create event files for measurable nodes

For each node marked MEASURABLE in the audit, create `events/<prefix><id>.yaml`:

```yaml
id: <prefix><id>
name: <human-readable-name>
description: "<what reaching this state means>"
category: conversion
tags:
  - <graph-name>
provider_event_names:
  amplitude: "<exact analytics event name>"
amplitude_filters:
  - property: <property-name>
    operator: is
    values:
      - "<exact-value>"
metadata:
  created_at: <ISO timestamp>
  updated_at: <ISO timestamp>
  status: active
  author: user
  version: 1.0.0
```

**Verification checklist per event**:
- [ ] Event name matches your analytics provider exactly (case-sensitive)
- [ ] Filter property name matches
- [ ] Filter value matches the production step/flow ID exactly
- [ ] Cross-referenced against production source file (noted in metadata or description)

### Step 3: Create node files

For every node in the graph (measurable or not), create `nodes/<prefix><id>.yaml`:

```yaml
id: <prefix><id>
name: <human-readable-name>
event_id: <prefix><event-id>   # omit for unmeasurable nodes
tags:
  - <graph-name>
metadata:
  created_at: <ISO timestamp>
  updated_at: <ISO timestamp>
  author: user
  version: 1.0.0
  status: active
```

For unmeasurable nodes, omit `event_id` and add a note in metadata:
```yaml
metadata:
  notes: "Unmeasurable — no analytics event currently fires for this state"
```

### Step 4: Create context file

If the funnel requires segment filtering (e.g. by UTM parameters, device type, feature flags), create `contexts/<prefix><context-id>.yaml`. The context defines:
- The segmentation dimension
- The values
- The analytics property and filter logic

### Step 5: Handle special node types

- **Case nodes**: No event file needed. The case node is a graph-level routing construct.
- **Absorbing/abandon nodes**: No event file needed — these are residual states computed from non-continuation.
- **Placeholder nodes**: For out-of-scope paths, create a node file with `status: placeholder` in metadata.
- **Composite nodes**: If one graph node represents multiple steps, choose the *first* step in the group as the event binding. This represents "entry into this phase".

### Common pitfalls

- **Step ID vs step function name confusion**: The production code function name may differ from the step ID passed to tracking. Always check the actual ID.
- **Single-step flows**: For flows with only one step, the filter may need a flow-level identifier rather than a step identifier.
- **Server-side events**: Events that fire from the API layer use different property names and don't have flow/step context.

---

## Phase 2: Construct the Graph JSON

### Goal

Create the graph JSON file with all nodes bound to entity files, all edges using node-ID-based queries, proper absorbing/entry flags, and correct policies.

### Step 1: Map audit rows to graph nodes

For each row in the audit, create a graph node object:

```json
{
  "uuid": "<fresh-v4-uuid>",
  "id": "<entity-node-id>",
  "label": "<display-label>",
  "absorbing": false,
  "entry": { "is_start": true, "entry_weight": 1 },
  "layout": { "x": <x>, "y": <y> },
  "label_overridden": true
}
```

- **Always generate fresh UUIDs** — never copy from an old graph
- **Set `id`** to the node entity file ID
- **Set `event_id`** to the event file ID for measurable nodes — this MUST be on the graph node, not just the node file
- **Set `label_overridden: true`** to prevent auto-sync from overwriting your labels
- **Preserve layout** from the original graph where possible

### Step 2: Set node flags

- **Start node**: `entry: { is_start: true, entry_weight: 1 }` — typically one per graph
- **Absorbing nodes**: `absorbing: true` for all terminal states. **Critical: absorbing nodes MUST NOT have outgoing edges.**
- **Case nodes**: `type: "case"` with `case.variants` array
- **Outcome type**: Set `outcome_type: "success"` or `"failure"` on terminal nodes

### Step 2a: Ensure every non-terminal node has a complement edge

Every non-absorbing node with fetchable outgoing edges **must also have an unfetchable edge to an absorbing-failure (abandon) node**. This is how the complement algorithm computes residual probability (users who reached the node but didn't continue to any measured next step).

Without a complement edge, residual probability mass is lost when fetched probabilities don't sum to 1.0.

### Step 3: Create edges

For each transition, create an edge object:

```json
{
  "uuid": "<fresh-v4-uuid>",
  "from": "<source-node-uuid>",
  "to": "<target-node-uuid>",
  "p": { "mean": 0.5 },
  "query": "from(<source-node-id>).to(<target-node-id>)"
}
```

- **`from`/`to` use node UUIDs** (internal graph references)
- **`query` uses node IDs** (for data fetching — references entity registry)
- For abandon edges, use `.minus()`: `from(source).to(abandon).minus(next-step)`
- For case variant edges, add `case_variant` and `case_id`

### Step 4: Set policies

```json
"policies": {
  "default_outcome": "<abandon-node-id>",
  "overflow_policy": "error",
  "free_edge_policy": "complement"
}
```

### Step 5: Set metadata and DSL

```json
"metadata": {
  "name": "<graph-name>",
  "description": "<what this funnel models>",
  "version": "1.0.0",
  "created_at": "<ISO>",
  "updated_at": "<ISO>"
}
```

### Layout guidelines

- Flow runs left-to-right (increasing x)
- Start node at x ~ -650, terminal nodes at x ~ +2500–3200
- Vertical spacing: ~120–150px between parallel paths
- Main happy path along y ~ 0; branches above (negative y) and below (positive y)

### Step 6: Handle unfetchable edges correctly

Edges where one or both nodes lack `event_id` are **unfetchable** — there is no analytics event to query. These edges must NOT have any fetch-related fields, in **two places**:

**On the graph edge** (in the graph JSON):
- `query` — the planner will try to compute a signature and warn for every one
- `p.connection` — there is no data source to connect to
- `p.id` — there is no parameter file to bind

**On the parameter file** (in `parameters/<id>.yaml`):
- `query` — the planner also reads queries from parameter files, not just graph edges
- `connection` — same reason
- `n_query`, `query_overridden`, `n_query_overridden` — remove these too

**Both must be clean.** Stripping queries from the graph edge but leaving them in the parameter file still causes planner warnings. The pre-flight script checks both.

Common unfetchable edge types:
- **Abandon edges** (source has event, abandon node does not) — these are residuals
- **Case node edges** (case node has no event, it's a routing construct)
- **Edges from/to unmeasurable nodes** (no prod instrumentation yet)
- **Placeholder edges** (out of scope nodes)

### Common pitfalls

- **Queries on unfetchable edges** — this is the #1 source of noisy planner warnings
- **Forgetting to mark abandon nodes as absorbing** — this causes probability mass to "leak"
- **Using node IDs in `from`/`to` fields** — these MUST be UUIDs; only `query` uses node IDs
- **Duplicate UUIDs** — every node and edge must have a unique UUID
- **Policies referencing wrong node** — `default_outcome` should reference a node `id`, not a UUID

---

## Phase 3: Create Parameter Files and Edge Queries

### Goal

Create a parameter file for each edge in the graph, with proper query DSL that references node IDs. Parameters carry the probability (or cost) data for each transition.

### Step 1: Extract edges from the graph

Read the graph JSON and list all edges. For each edge, note:
- Source node ID and target node ID (from the node `id` fields, not UUIDs)
- The query already set on the edge
- Whether the edge needs a `.minus()` clause (for abandon/residual edges)
- Whether an `n_query` override is needed

### Step 2: Create parameter files

For each edge, create `parameters/<from>-to-<to>.yaml`:

```yaml
id: <from-id>-to-<to-id>
name: <from-id>-to-<to-id>
type: probability
query: from(<from-id>).to(<to-id>)
query_overridden: false
n_query_overridden: false
values:
  - mean: 0.5
metadata:
  description: ""
  constraints:
    discrete: false
  tags: []
  created_at: <ISO>
  updated_at: <ISO>
  author: user
  version: 1.0.0
  status: active
  aliases: []
  references: []
```

### Naming convention

- Standard: `<from-node-id>-to-<to-node-id>` (e.g. `landing-page-to-signup`)
- If the name would be excessively long, abbreviate: drop the common prefix once

### Query patterns

- **Simple transition**: `from(source).to(target)`
- **Abandon/residual**: `from(source).to(abandon).minus(next-step)` — counts users who reached source but did NOT reach next-step
- **Denominator override**: `n_query: to(source)` — when the denominator should be "everyone who reached the source node"

### Common pitfalls

- **Forgetting `.minus()` on abandon edges**: Without it, the abandon count will include users who DID continue (double-counting)
- **Parameter ID must match filename**: The `id` field must equal the filename without `.yaml`
- **Long parameter IDs**: Very long IDs (>80 chars) can cause display issues; abbreviate if needed

---

## Pre-Flight Validation (run before EVERY commit)

### Why this matters

Graph files are complex JSON structures with many cross-references. It is extremely easy to create a graph that looks correct but has silent issues. These issues are invisible until you try to load the graph and something doesn't work.

**Rule: Never commit without running pre-flight validation.**

### The validation scripts

Two scripts cover different scopes:

**1. Graph validation** — checks a single graph file for structural integrity:
```bash
# Fast structural checks (< 1s)
bash graph-ops/scripts/validate-graph.sh graphs/<graph-name>.json

# Full check including production IntegrityCheckService (~10s)
bash graph-ops/scripts/validate-graph.sh graphs/<graph-name>.json --deep
```

**2. Index validation** — checks all entity files have index entries:
```bash
bash graph-ops/scripts/validate-indexes.sh
```

### Pre-commit checklist

Before every commit, run both:
```bash
# Fast check (always)
bash graph-ops/scripts/validate-graph.sh graphs/<your-graph>.json
bash graph-ops/scripts/validate-indexes.sh

# Deep check (before final commit / PR)
bash graph-ops/scripts/validate-graph.sh graphs/<your-graph>.json --deep
```

See [Validate a Graph](validate-graph.md) for full details on interpreting output and fixing common failures.

### Known gotcha: event_id must be on the graph node

The data model has two places where `event_id` lives:

1. **Node file** (`nodes/<id>.yaml`) — has `event_id: <event-file-id>`
2. **Graph node** (inside the graph JSON) — also needs `event_id: "<event-file-id>"`

Both are required. The node file is the source of truth for the registry; the graph node is what the app reads at runtime.

---

## Phase 4: Update Index Files

See [Create Entities — Index Entry](create-entities.md) for the index entry format.

Run the validation script:
```bash
bash graph-ops/scripts/validate-indexes.sh
```

---

## Phase 5: Validate and Test End-to-End

### Goal

Confirm the graph loads correctly in DagNet, all entity files resolve, and data fetching returns expected results.

### Manual validation checklist

- [ ] Graph opens in the editor without errors
- [ ] All nodes render on the canvas with correct labels
- [ ] All edges connect between the expected nodes
- [ ] Node properties panel shows the correct entity bindings (id, event_id)
- [ ] Context DSL is applied (check the query bar)
- [ ] Triggering "Fetch Data" initiates requests to the analytics provider
- [ ] At least the first few funnel steps return non-zero conversion data
- [ ] Absorbing nodes are visually marked as terminal states

### Compare against analytics reference

For a manual sanity check, compare the fetched conversion rates against your analytics provider's funnel:
- Earlier steps should have higher conversion, later steps lower
- If rates are wildly different, check event name/filter mismatches

---

## Phase 6: Final Documentation and Review

### Deliverables

1. **Production navigation notes** (in data repo) — where to find flows, steps, tracking in the production codebase
2. **Event taxonomy** (in data repo) — how event names are constructed, common properties, filtering guidance
3. **Common pitfalls** (in data repo) — lessons learned, things that go wrong
4. **This playbook** — final review to ensure it reads as a standalone guide

### Review checklist

- [ ] Playbook can be followed by someone who wasn't part of the project
- [ ] All phase sections have been revised post-execution
- [ ] Reference docs are accurate and complete
- [ ] Cross-references between playbook and reference docs are correct
