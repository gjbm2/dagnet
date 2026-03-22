# Common Pitfalls When Building Funnel Graphs

**Last updated**: 22-Mar-26

Lessons learned from building funnel graphs. These apply to any DagNet funnel graph project.

---

## Entity Creation

### 1. Step ID vs flow ID in analytics filters

**Problem**: You filter an event by `step = "my-step"` but the analytics funnel uses `flowId = "my-flow"`.

**Why it happens**: Single-step flows have both a `flowId` and a `step`. The analytics funnel builder may use either. The step ID and flow ID are often different.

**Fix**: Always check which property the analytics funnel is filtering by. For single-step flows, prefer filtering by `flowId`.

### 2. Event name case sensitivity

**Problem**: You write `FlowStep viewed` instead of `FlowStep Viewed`.

**Fix**: Analytics event names are case-sensitive. Copy the exact name from the production codebase or analytics UI.

### 3. Reusing entities from other graphs without verification

**Problem**: You reuse an event entity from another graph, but it has different filters than what your funnel needs.

**Fix**: Always create fresh entities with a project prefix (e.g. `proj-`) and verify against the production codebase. Only reuse after explicit verification.

## Graph Construction

### 4. Missing event_id on graph nodes (the #1 gotcha)

**Problem**: You set `event_id` on the node file (`nodes/<id>.yaml`) but forgot to add `event_id` to the graph node in the JSON. The graph loads, nodes render, but no data is fetched because the app doesn't know which events to query.

**Why it happens**: The data model has event_id in two places — the node file (registry) and the graph node (runtime). It's natural to assume setting it in one place is enough.

**Fix**: Always run `bash graph-ops/scripts/validate-graph.sh graphs/<name>.json` before committing. It cross-references graph nodes against node files and catches this mismatch. When constructing graph nodes programmatically, include both fields:
```json
{
  "id": "my-node",
  "event_id": "my-event",
  "event": { "id": "my-event" },
  ...
}
```

### 5. Queries on unfetchable edges (wall of planner warnings)

**Problem**: You set `query` on all edges, but many connect to nodes without `event_id` (abandon, case, unmeasurable). The planner tries to compute a signature for each one, fails, and logs a warning. You get a wall of warnings that obscures real issues.

**Why it happens**: When generating the graph programmatically, it's natural to set `query` on every edge. But `query` means "fetch data for this transition" — which only makes sense when both endpoints have trackable events.

**Fix**: Only set `query`, `p.connection`, and `p.id` on edges where **both** source and target nodes have `event_id`. The pre-flight script catches this.

### 6. Forgetting to mark absorbing nodes

**Problem**: Abandon nodes, success nodes, and failure nodes are not marked `absorbing: true`. This causes probability mass to "leak" — the graph expects outgoing edges from these nodes.

**Fix**: Every terminal state must have `absorbing: true`. Check all abandon nodes, success nodes, and failure nodes.

### 7. Using node IDs in edge `from`/`to` fields

**Problem**: Edge `from` and `to` fields should be node **UUIDs**, but you put node **IDs** instead.

**Fix**: `from`/`to` use UUIDs (internal graph references). Only the `query` field uses node IDs (for data fetching).

### 8. Colons in YAML values

**Problem**: A node name like `Other Categories: Yes` breaks YAML parsing because of the unquoted colon.

**Fix**: Quote any YAML value that contains colons: `name: "Other Categories: Yes"`.

## Data Fetching

### 9. Unmeasurable nodes returning zero data

**Problem**: You wire a node to an event that doesn't exist, and all edges from that node show zero data.

**Fix**: This is expected for unmeasurable nodes. The audit should have flagged them. Don't spend time debugging — focus on measurable nodes first.

### 10. Context filtering too aggressive

**Problem**: Applying a context filter reduces the data to near-zero.

**Fix**: Check the cohort date range — narrow windows may have very few matching users. Start with a wider window (e.g. 30 days) to verify the filter works, then narrow.

### 11. Duplicate node events giving inflated probabilities

**Problem**: Two graph nodes are wired to the same analytics event. Data fetch returns the same count for both, inflating probabilities.

**Fix**: This is a known limitation when the graph models distinctions that aren't trackable in the analytics provider. Document the limitation; consider merging the nodes until instrumentation exists.

## Index Management

### 12. Pre-existing validation errors

**Problem**: Running `validate-indexes.sh` shows errors, but they're all for entities from other graphs, not yours.

**Fix**: Focus on YOUR entities (grep for your prefix). Pre-existing errors are not your responsibility unless you're doing a cleanup pass.

## General

### 13. Trying to model everything at once

**Problem**: The initial graph has dozens of nodes covering every conceivable state, including server-side states that aren't trackable.

**Fix**: Start with what's measurable. Mark unmeasurable nodes clearly. You can always add nodes later when instrumentation exists. A working graph with 20 measurable nodes is more valuable than a conceptually complete graph that can't fetch data.

### 14. Absorbing nodes with outgoing edges (dead edges)

**Problem**: You mark a node as `absorbing: true` but give it outgoing edges to other nodes. The runner stops at absorbing nodes — outgoing edges are never evaluated. The downstream section is dead.

**Fix**: If a node has outgoing edges, it is NOT absorbing. If a node is genuinely terminal (no further transitions to track), mark it absorbing and ensure it has zero outgoing edges.

### 15. All outgoing edges unfetchable (no evidence for complement)

**Problem**: A non-absorbing node has outgoing edges, but ALL targets lack events. Complement fill requires at least one evidence-backed sibling edge. Zero evidence siblings means complement is skipped entirely — the entire downstream section produces no data.

**Fix**: Either wire at least one target node to an analytics event (so complement can compute the residual), or make the parent node absorbing if there's genuinely no instrumentation downstream.

### 16. Missing complement/abandon edge

**Problem**: A non-absorbing node has only fetchable outgoing edges and no complement edge to an absorbing-failure node. If the fetched probabilities don't sum to 1.0, the residual probability mass is lost.

**Fix**: Every non-absorbing node with fetchable outgoing edges should also have an unfetchable edge to an absorbing-failure (abandon) node. The complement algorithm then assigns `1 - sum(fetched)` to that edge automatically.

### 17. Case nodes break the fetch chain

**Problem**: You add a case node (for A/B test split) between two measurable nodes. The case node has no analytics event, so edges to/from it can't build queries. The happy path becomes unfetchable.

**Why it happens**: DagNet's query model assumes every node on the path has an event. Case nodes are routing constructs with no corresponding user action.

**Workaround (current)**: Remove the case node and use a gate-based context filter to segment the data instead. This works when the entire graph applies to one side of the gate.

### 18. Gate-based context filter: use string 'true', not boolean

**Problem**: You write `filter: activeGates.my_gate == true` (boolean). The analytics adapter sends gate values as strings `"true"/"false"`, so the filter doesn't match.

**Fix**: Always use string comparison: `filter: "activeGates.my_gate == 'true'"`.

### 19. Missing `name` in parameter index entry — red plug icon in editor

**Problem**: A parameter shows as red/broken with a plug icon in the editor, even though the `.yaml` file exists and the YAML is valid.

**Why it happens**: The `parameters-index.yaml` entry is missing the `name` field. The editor treats any index entry without `name` as "Not in registry".

**Fix**: Every `parameters-index.yaml` entry must include `name: <param-id>`. The value is just the ID repeated:

```yaml
  - id: my-param-id
    file_path: parameters/my-param-id.yaml
    status: active
    type: probability
    name: my-param-id        # ← required — without this the editor shows red
    created_at: ...
```

### 20. Filtering on user properties without `property_type: user`

**Problem**: An event definition has an `amplitude_filters` entry for a user property (set via `identify()`). Data fetch returns zero even though users with that trait exist.

**Why it happens**: The adapter defaults to `subprop_type: "event"` for all filter entries. An event-property filter for a user trait silently matches nothing.

**Fix**: Add `property_type: user` to any filter on a user property:

```yaml
amplitude_filters:
  - property: myUserTrait
    property_type: user          # ← required for user traits
    operator: is
    values:
      - expected_value
```

Event properties (sent directly on the event payload) do not need this field.
