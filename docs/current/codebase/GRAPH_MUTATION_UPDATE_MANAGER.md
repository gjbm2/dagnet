# Graph Mutation and UpdateManager

How graph edits propagate from UI through mutation services to persistence, and how UpdateManager manages all automated entity updates.

**See also**: `GRAPH_WRITE_SYNC_ARCHITECTURE.md` (the broader sync pipeline this feeds into), `SYNC_SYSTEM_OVERVIEW.md` (integrative map of all data flows)

## Edit Propagation Pipeline

```
UI (menu / properties panel / editor)
  |
  v  calls UpdateManager method
UpdateManager.ts (returns nextGraph)
  |
  v  calls setGraph or setGraphDirect
GraphCanvas.tsx (setGraph wrapper)
  |
  v  if topology changed
graphMutationService.updateGraph()
  |  - detects topology changes (edge count, node connections)
  |  - calls queryRegenerationService (Python MSMDC)
  |  - applies regenerated queries/anchors
  |
  v  store updated
Zustand Store (graphRevision increments)
  |
  v  React effects
FileRegistry + IndexedDB (isDirty: true)
```

### setGraph vs setGraphDirect

- **`setGraphDirect`**: synchronous store update. Bypasses graphMutationService. Used when no topology change occurred (e.g. probability edit, label change).
- **`setGraph`**: async wrapper that calls `graphMutationService.updateGraph()` if topology changed. Triggers MSMDC query regeneration.

### MSMDC regeneration flow

When topology changes (node/edge added/removed/reconnected):

1. `graphMutationService.detectTopologyChange()` identifies the change
2. `queryRegenerationService.regenerateQueries(graph)` calls the Python backend
3. Regenerated `query`, `n_query`, and `anchor_node_id` are applied to the graph
4. `dagnet:suppressFileToStoreSync` event is dispatched to prevent race conditions
5. `setGraphDirect(updatedGraph)` re-applies to the store

## UpdateManager Architecture

**Location**: `src/services/UpdateManager.ts` (~3,700 lines) + `src/services/updateManager/` subdirectory.

UpdateManager manages **all automated entity updates** across the system, operating on a 5-direction x 4-operation model.

### Five flow directions

| Direction | From --> To | Purpose |
|-----------|-----------|---------|
| `graph_internal` | Graph --> Graph | Query regeneration, cascades, copy/paste |
| `graph_to_file` | Graph --> File | Save parameter/case files from graph edits |
| `file_to_graph` | File --> Graph | Pull parameter/case file changes to graph |
| `external_to_graph` | External --> Graph | Direct Amplitude/Statsig data to edges/nodes |
| `external_to_file` | External --> File | Append DAS history, audit trails |

### Four operation types

- **CREATE**: create new file from graph entity
- **UPDATE**: update metadata/values in existing file
- **APPEND**: add new value/history entry to file
- **DELETE**: remove entity (handled separately)

### Mapping configurations

18 mapping configurations in `updateManager/mappingConfigurations.ts` define field-level mappings for each direction/operation/entity combination. These control which fields flow where, respecting override flags.

## Graph-to-Graph Mutation Methods

### Edge probability

| Method | Behaviour |
|--------|-----------|
| `updateEdgeProbability(graph, edgeId, newMean, options?)` | Updates mean, triggers sibling rebalancing if forced |
| `updateConditionalProbability(graph, edgeId, condIdx, updates)` | Updates specific conditional, syncs evidence and metadata |
| `addConditionalProbability(graph, edgeId, condition)` | Adds condition, propagates to sibling edges |
| `updateConditionalProbabilities(graph, edgeId, conditions)` | Replaces all conditionals |
| `removeConditionalProbability(graph, edgeId, condIdx)` | Removes specific conditional |

### Edge and node CRUD

| Method | Behaviour |
|--------|-----------|
| `createEdge(graph, from, to, options?)` | UUID generation, p/cost_gbp slots created |
| `updateEdge(graph, edgeId, updates)` | Deep merge, metadata timestamp update |
| `deleteEdge(graph, edgeUuid)` | Removes from edges array |
| `deleteNode(graph, nodeUuid)` | Removes node and all edges to/from it |

### Rebalancing

| Method | Behaviour |
|--------|-----------|
| `rebalanceEdgeProbabilities(graph, edgeId, options?)` | Distributes weight to sibling edges |
| `rebalanceConditionalProbabilities(graph, edgeId, options?)` | Distributes per-condition weight |
| `rebalanceVariantWeights(graph, nodeId, idx, options?)` | Updates case node variant weights |

### Other

| Method | Behaviour |
|--------|-----------|
| `renameNodeId(graph, nodeKey, newId)` | Updates all references (see below) |
| `applyBatchLAGValues(graph, updates, options?)` | Latency parameter bulk apply |
| `pasteSubgraph(graph, sourceGraph, nodeMapping, options?)` | UUID remapping, condition propagation |

## Node ID Renaming

`renameNodeId(graph, nodeKey, newId)` is one of the most complex mutations. It updates all references to a node across the entire graph.

### What gets updated

| Target | Updated? | Notes |
|--------|----------|-------|
| `node.id` | Yes | Renamed to new ID |
| `node.label` | Yes | Humanised from new ID (unless `label_overridden`) |
| `edge.from` / `edge.to` | **No** | Must remain UUIDs -- other systems depend on this |
| `edge.id` | Yes | Word-boundary replacement of old token |
| `edge.query` | Yes | Node token replaced in DSL string |
| `edge.n_query` | Yes | Node token replaced |
| `edge.conditional_p[].condition` | Yes | Node token replaced in condition DSL |
| `edge.cost_gbp.query` | Yes | Node token replaced |
| `edge.labour_cost.query` | Yes | Node token replaced |
| Node-level `p.query`, `cost_gbp.query`, etc. | Yes | Node token replaced |

### Token replacement

Uses `replaceNodeToken(queryStr, oldToken, newId)` with word-boundary regex (`/\b{oldId}\b/g`) to prevent partial matches in compound identifiers.

### First-time ID assignment

When a node has no human-readable ID yet (only a UUID), the UUID is used as the search token. This handles the case where edges reference a node by its UUID in query strings before the node has been named.

### Edge ID deduplication

Edge IDs are updated with substring replacement, guarding against repeated tokens (e.g. preventing `node-node-node`).

## Override Flags

`_overridden` is a field lock — it prevents UpdateManager from overwriting the field. That is all. Do not wire semantic logic to it; read the field's output value instead.

Many fields have an `_overridden` companion flag (e.g. `query` + `query_overridden`). When a field is overridden:

- **Graph-mastered cascades skip it**: MSMDC query regeneration won't overwrite a manually-set query
- **Graph-to-file updates skip it**: the file retains its own value
- **`ignoreOverrideFlags` option**: forces overwrite (for explicit user actions)

## Cross-Domain Mutations

UpdateManager handles data flow between graph, files, and external sources via its mapping engine:

| Direction | Operation | Example |
|-----------|-----------|---------|
| graph --> file | CREATE | New parameter file generated from graph entity |
| graph --> file | UPDATE | Metadata (description, query) pushed to file |
| graph --> file | APPEND | New value entry appended to file.values[] |
| file --> graph | UPDATE | File data pulled back to graph entity |
| external --> graph | UPDATE | Amplitude/Statsig data merged to edge.p |
| external --> file | APPEND | DAS values appended to parameter file history |

## Persistence Trigger

After any mutation:

1. UI handler calls `setGraph(nextGraph)` or `setGraphDirect(nextGraph)`
2. Zustand store `graphRevision` increments
3. React effect syncs to FileRegistry and IDB with `isDirty: true`
4. Background commit process can later push dirty files to GitHub

## Architectural Constraints

1. **No logic in UI/menu files**: all business logic lives in UpdateManager or services
2. **Override flag respect**: never update `field_overridden=true` without explicit permission
3. **UUID immutability**: `edge.from`/`edge.to` must never change
4. **Word-boundary safety**: token replacement uses `\b` to prevent partial matches
5. **Race condition prevention**: `dagnet:suppressFileToStoreSync` event during MSMDC apply

## Key Files

| File | Role |
|------|------|
| `src/services/UpdateManager.ts` | Main service (~3,700 lines) |
| `src/services/updateManager/types.ts` | UpdateResult, UpdateOptions, FieldChange types |
| `src/services/updateManager/mappingConfigurations.ts` | 18 field mapping configs |
| `src/services/updateManager/mappingEngine.ts` | Generic mapping application engine |
| `src/services/updateManager/auditLog.ts` | Audit trail |
| `src/services/updateManager/nestedValueAccess.ts` | Deep property access |
| `src/services/graphMutationService.ts` | Topology change detection, MSMDC triggers |
| `src/contexts/GraphStoreContext.tsx` | Zustand store, setGraph/setGraphDirect |
