#!/usr/bin/env bash
# Print a human-readable summary of a graph JSON file.
# Usage: bash graph-ops/scripts/list-graph.sh <graph-file>
#   e.g. bash graph-ops/scripts/list-graph.sh <private-repo>/graphs/high-intent-flow-feb-26.json

set -euo pipefail

if [ $# -lt 1 ]; then
  echo "Usage: $0 <graph-json-file>"
  exit 1
fi

GRAPH_FILE="$1"

if [ ! -f "$GRAPH_FILE" ]; then
  echo "ERROR: File not found: $GRAPH_FILE"
  exit 1
fi

python3 -c "
import json, sys

g = json.load(open(sys.argv[1]))

nodes = g.get('nodes', [])
edges = g.get('edges', [])
meta = g.get('metadata', {})

print(f\"Graph: {meta.get('name', '(unnamed)')}\")
print(f\"Description: {meta.get('description', '(none)')}\")
print(f\"Nodes: {len(nodes)}, Edges: {len(edges)}\")
print(f\"Daily fetch: {g.get('dailyFetch', False)}\")
print()

# Build UUID -> label map
uuid_map = {}
for n in nodes:
    label = n.get('label', n.get('id', '???'))
    start = ' [START]' if n.get('entry', {}).get('is_start') else ''
    absorb = ' [ABSORBING]' if n.get('absorbing') else ''
    uuid_map[n['uuid']] = label
    nid = n.get('id', '')
    print(f\"  Node: {label}{start}{absorb}\")
    print(f\"        uuid={n['uuid'][:8]}  id={nid!r}\")

print()

for e in edges:
    src = uuid_map.get(e['from'], e['from'][:8])
    tgt = uuid_map.get(e['to'], e['to'][:8])
    p = e.get('p', {}).get('mean', '?')
    print(f\"  Edge: {src} --({p})--> {tgt}\")
" "$GRAPH_FILE"
