# Query Regeneration Design

**Status**: ✅ Implementation Ready  
**Date**: November 8, 2025

## Overview

Automatic regeneration of MSMDC queries when graph topology changes, with intelligent synthetic ID handling for parameters without files yet.

## Problem

When graph topology changes (add/remove nodes/edges, change connectivity), data retrieval queries become stale and need regeneration. However, not all parameters have files yet, so we need a way to:
1. Regenerate queries for ALL parameters (file or no file)
2. Update graph in-memory immediately
3. Cascade to parameter files only if they exist and aren't overridden

## Solution: Synthetic IDs

### Python generates stable IDs:
- **Real ID** (if exists): `edge.p.id`, `edge.conditional_p[i].p.id`, etc.
- **Synthetic ID** (if no file): `"synthetic:{uuid}:{field}"`

Format: `synthetic:{uuid}:{field}`
- `uuid`: `edge.uuid` or `node.uuid` (stable, survives node ID changes)
- `field`: `"p"`, `"conditional_p[0]"`, `"cost_gbp"`, `"cost_time"`, `"case"`

### Examples:
```python
# Edge with parameter file
param_id = "param-conversion-probability-2024"  # Real file ID

# Edge without parameter file yet
param_id = "synthetic:edge-abc123:p"  # Synthetic ID

# Conditional probability without file
param_id = "synthetic:edge-abc123:conditional_p[0]"

# Case without file
param_id = "synthetic:node-def456:case"
```

## Implementation

### Python (lib/msmdc.py)

```python
# generate_all_parameter_queries()

# Base probability
if edge.p:
    param_id = getattr(edge.p, 'id', None) or f"synthetic:{edge.uuid}:p"
    # ... generate query

# Conditional probability
for idx, cond_p in enumerate(edge.conditional_p):
    param_id = getattr(cond_p.p, 'id', None) or f"synthetic:{edge.uuid}:conditional_p[{idx}]"
    # ... generate query

# Costs
if edge.cost_gbp:
    param_id = getattr(edge.cost_gbp, 'id', None) or f"synthetic:{edge.uuid}:cost_gbp"

# Case
case_id = node.case.id or f"synthetic:{node.uuid}:case"
```

### TypeScript (queryRegenerationService.ts)

```typescript
function parseSyntheticId(paramId: string): { uuid: string; field: string } | null {
  if (!paramId.startsWith('synthetic:')) return null;
  const [_, uuid, field] = paramId.split(':');
  return { uuid, field };
}

function applyQueryToGraph(graph: Graph, paramId: string, newQuery: string) {
  const synthetic = parseSyntheticId(paramId);
  
  if (synthetic) {
    // Synthetic: find by UUID and field
    const edge = graph.edges.find(e => e.uuid === synthetic.uuid);
    if (synthetic.field === 'p' && edge) {
      edge.query = newQuery;  // Update in-memory
    }
    // ... other fields
  } else {
    // Real: find by matching param_id
    for (const edge of graph.edges) {
      if (edge.p?.id === paramId) {
        edge.query = newQuery;
        updateParameterFile(paramId, newQuery);  // Cascade to file
      }
    }
  }
}
```

## Workflow

### 1. User makes topology change
- Add/remove node
- Add/remove edge
- Change edge connectivity
- Change conditional_p condition

### 2. Topology change detector (UpdateManager)
```typescript
// Detect topology change
const hasTopologyChange = changes.some(c => 
  ['node-added', 'node-removed', 'edge-added', 'edge-removed',
   'edge-connectivity-changed', 'conditional-condition-changed'].includes(c.type)
);

if (hasTopologyChange) {
  // Trigger async regeneration (non-blocking)
  regenerateQueriesAsync(graph, changes);
}
```

### 3. Call Python MSMDC
```typescript
const response = await graphComputeClient.generateAllParameters(
  graph,
  downstreamOf: undefined,  // or specific node for optimization
  literalWeights: { visited: 10, exclude: 1 },
  preserveCondition: true
);
```

### 4. Python returns mixed IDs
```json
{
  "parameters": [
    {
      "paramId": "param-abc",  // Real: has file
      "query": "from(a).to(b).visited(c)",
      "edgeKey": "a->b",
      "paramType": "edge_base_p"
    },
    {
      "paramId": "synthetic:edge-123:conditional_p[0]",  // Synthetic: no file yet
      "query": "from(a).to(b).exclude(d)",
      "edgeKey": "a->b",
      "paramType": "edge_conditional_p"
    }
  ]
}
```

### 5. TypeScript applies updates
```typescript
for (const param of response.parameters) {
  // Apply to graph (both real and synthetic)
  applyQueryToGraph(graph, param.paramId, param.query);
  
  // Cascade to file (only real IDs, only if not overridden)
  if (!param.paramId.startsWith('synthetic:')) {
    const isOverridden = isQueryOverridden(graph, param.paramId);
    if (!isOverridden) {
      await updateParameterFile(param.paramId, param.query);
    }
  }
}
```

### 6. Update graph state
```typescript
setGraph(updatedGraph);
toast.info(`Regenerated ${changedCount} query strings`);
```

## Query Storage Locations

Based on schema analysis:

| Parameter | Graph Location | File Type | File Location |
|-----------|----------------|-----------|---------------|
| Base p | `edge.query` | parameter | `parameter-{id}.yaml` → `query` |
| Conditional p | `edge.conditional_p[i].query` | parameter | `parameter-{id}.yaml` → `query` |
| Cost GBP | `edge.cost_gbp.query` | parameter | `parameter-{id}.yaml` → `query` |
| Cost Time | `edge.cost_time.query` | parameter | `parameter-{id}.yaml` → `query` |
| Case | TBD | case | `case-{id}.yaml` → TBD |

## Benefits

### ✅ Better UX
- Queries auto-update immediately on topology changes
- Works even before files are created
- Visible feedback in UI (query fields update)

### ✅ Clear Workflow
1. User edits graph → queries regenerate
2. User creates param file later → existing query preserved
3. User connects file to edge → queries update to file on next change

### ✅ Safe
- Synthetic IDs can't accidentally write to wrong file
- Real IDs checked for `query_overridden` flag
- File updates are optional (skip if file doesn't exist)

### ✅ No Translation Needed
- Python returns stable, parseable IDs
- TypeScript parses and applies directly
- No complex edge_key → edge resolution

## Performance

- **Async execution**: Non-blocking (2000ms Python cold start OK)
- **Downstream filtering**: Optional optimization (regenerate only affected edges)
- **Start simple**: Regenerate all queries, optimize later if slow

## Future: File Creation
When user creates a parameter file and connects it:

```typescript
// User creates param file and sets edge.p.id = "new-param-id"
// On next topology change:
const param_id = edge.p.id;  // Now returns "new-param-id" (real)

// Python generates query with real ID
// TypeScript cascades to file:
updateParameterFile("new-param-id", generatedQuery);
```

The synthetic ID is automatically replaced with real ID once file is connected.

## TODO

- [ ] Implement UpdateManager integration (detect topology changes)
- [ ] Wire queryRegenerationService into graph update flow
- [ ] Determine case query storage location in schema
- [ ] Add history entry for query regeneration events
- [ ] Add user preference for auto-regeneration on/off
- [ ] Performance testing on large graphs (50+ nodes)
- [ ] Implement downstream_of optimization if needed

## Related Files

- `lib/msmdc.py` - Python MSMDC algorithm (generates queries + synthetic IDs)
- `dev-server.py` - `/api/generate-all-parameters` endpoint
- `graph-editor/src/services/queryRegenerationService.ts` - TypeScript service layer
- `graph-editor/src/lib/graphComputeClient.ts` - API client
- `graph-editor/src/services/UpdateManager.ts` - Graph update orchestration (hook point)
- `graph-editor/src/services/dataOperationsService.ts` - File sync operations (reference)

