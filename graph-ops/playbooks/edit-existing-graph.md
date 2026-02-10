# Edit Existing Graph Playbook

How to modify an existing graph in `nous-conversion`.

**Prerequisite**: You are on a feature branch (see [branch-workflow.md](branch-workflow.md)).

---

## Before Editing

1. **Read the graph** — understand its current structure, nodes, and edges
2. **Read the parameters** — understand which edges have data and what their queries are
3. **Identify the change** — what needs to happen and what it affects

---

## Common Operations

### Add a Node to an Existing Graph

1. Create the node file and event file if needed (see [create-entities.md](create-entities.md))
2. Add the node to the graph JSON:
   ```json
   {
     "uuid": "<new-uuid>",
     "id": "<node-id>",
     "label": "Display Label",
     "absorbing": false,
     "layout": { "x": <appropriate-x>, "y": <appropriate-y> }
   }
   ```
3. Add edges connecting to/from the new node
4. Create parameter files for each new edge
5. Update all index files
6. **Check**: Do existing edges need probability adjustments? Adding a new outgoing edge from an existing node means the other edges' probabilities may need to decrease.

### Remove a Node

1. Remove the node from the graph JSON `nodes` array
2. Remove all edges that reference the node's UUID (both `from` and `to`)
3. Optionally remove parameter files for deleted edges
4. Optionally remove the node/event files (only if not used by other graphs)
5. **Check**: Remaining edges from predecessor nodes may need probability adjustments

### Add an Edge

1. Add the edge to the graph JSON:
   ```json
   {
     "uuid": "<new-uuid>",
     "from": "<source-node-uuid>",
     "to": "<target-node-uuid>",
     "p": { "mean": <initial-estimate> }
   }
   ```
2. Create a parameter file for the edge (see [create-entities.md](create-entities.md))
3. Update `parameters-index.yaml`
4. **Check**: Adjust sibling edges' probabilities so they sum to ~1.0

### Change a Node's Event Binding

1. Update the node file's `event_id` field
2. If the new event doesn't exist, create it (see [create-entities.md](create-entities.md))
3. **Check**: All parameters with queries referencing this node may need their data refreshed

### Rename a Node ID

This is a high-impact change — node IDs are referenced in multiple places:

1. Rename the node file (`nodes/<old-id>.yaml` → `nodes/<new-id>.yaml`)
2. Update `id` inside the file
3. Update `nodes-index.yaml` (id, file_path, name)
4. Update the graph JSON — change the `id` field on the matching node
5. Update all parameter `query` fields that reference the old node ID
6. Update all parameter `n_query` fields that reference the old node ID
7. **Check**: Search for the old ID across all files to catch any missed references

### Update Layout

Edit `layout.x` and `layout.y` on nodes in the graph JSON. No other files are affected.

---

## Impact Checklist

Before committing, verify:

- [ ] All graph node UUIDs are unique (no duplicates introduced)
- [ ] All edges reference valid node UUIDs in the same graph
- [ ] Outgoing edge probabilities from each node sum to ≤ 1.0
- [ ] New entity files have corresponding index entries
- [ ] Parameter `query` fields reference valid, current node IDs
- [ ] No orphaned entities (files with no graph reference, unless intentionally shared)

---

## Finding What to Edit

```bash
# Find which graph(s) reference a node
grep -rl "<node-id>" nous-conversion/graphs/

# Find which parameters reference a node
grep -rl "<node-id>" nous-conversion/parameters/

# Find all edges from a specific node (by UUID)
grep "<node-uuid>" nous-conversion/graphs/<graph>.json

# List all node IDs in a graph
python3 -c "
import json, sys
g = json.load(open(sys.argv[1]))
for n in g['nodes']:
    print(f\"{n['uuid'][:8]}  id={n['id']!r:30s}  label={n.get('label', '')!r}\")
" nous-conversion/graphs/<graph>.json

# List all edges in a graph
python3 -c "
import json, sys
g = json.load(open(sys.argv[1]))
uuids = {n['uuid']: n.get('label', n['id']) for n in g['nodes']}
for e in g['edges']:
    src = uuids.get(e['from'], '???')
    tgt = uuids.get(e['to'], '???')
    p = e.get('p', {}).get('mean', '?')
    print(f\"{src} --({p})--> {tgt}\")
" nous-conversion/graphs/<graph>.json
```
