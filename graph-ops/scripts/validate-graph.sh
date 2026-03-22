#!/usr/bin/env bash
# Pre-flight validation for a graph file before committing.
# Usage: bash graph-ops/scripts/validate-graph.sh graphs/<name>.json [--deep]
#
# Without --deep: runs fast Python-based structural checks (< 1s)
# With --deep:    also runs the production IntegrityCheckService via Vitest (~10s)
#
# Structural checks (always run):
#   1. Valid JSON
#   2. Every node has a non-empty 'id' field (bound to registry)
#   3. Every measurable node has 'event_id' set on the graph node
#   4. event_id on graph node matches event_id in node file
#   5. Every event_id references an existing event file
#   6. Every node id references an existing node file
#   7. All absorbing/terminal nodes are marked absorbing: true
#   8. Edge from/to reference valid node UUIDs within the graph
#   9. Edge queries use node IDs (not UUIDs)
#  10. Node + edge UUIDs are unique (no duplicates)
#  11. Outgoing edge probabilities from each node sum to <= 1.0
#  12. Graph has defaultConnection (or per-edge p.connection)
#  13. Parameter file connection provenance
#  14. Parameter bindings (p.id on fetchable, absent on unfetchable)
#  15. Queries on fetchable edges, absent on unfetchable
#  16. Handle format (fromHandle: *-out, toHandle: no -out)
#  17. cohort_anchor_event_id on all fetchable edges
#  18. Mass conservation (complement edges to absorbing nodes)
#  19. Edge UUIDs are valid v4 format
#  20. latency_parameter set on fetchable edges
#  21. pinnedDSL / dataInterestsDSL present (for simulation graphs)
#  22. Parameter files have required fields (values[], query_signature, lag stats)
#  23. Simulation guard consistency (simulation + dailyFetch flags)

set -euo pipefail
. "$(dirname "$0")/_load-conf.sh"

if [ $# -lt 1 ]; then
  echo "Usage: bash graph-ops/scripts/validate-graph.sh graphs/<name>.json [--deep]"
  echo ""
  echo "  --deep  Also run production IntegrityCheckService via Vitest"
  exit 1
fi

GRAPH_ARG="$1"
DEEP=false
if [ "${2:-}" = "--deep" ]; then
  DEEP=true
fi

GRAPH_FILE="$DATA_REPO_PATH/$GRAPH_ARG"

if [ ! -f "$GRAPH_FILE" ]; then
  echo "ERROR: Graph file not found: $GRAPH_FILE"
  exit 1
fi

echo "==> Validating graph: $GRAPH_ARG"
echo ""

python3 << PYEOF
import json, sys, os, re, yaml

REPO = "$DATA_REPO_PATH"
graph_path = "$GRAPH_FILE"
errors = 0
warnings = 0

def err(msg):
    global errors
    print(f"  ERROR: {msg}")
    errors += 1

def warn(msg):
    global warnings
    print(f"  WARN:  {msg}")
    warnings += 1

def info(msg):
    print(f"  OK:    {msg}")

# --- 1. Valid JSON ---
try:
    with open(graph_path) as f:
        g = json.load(f)
    info("Valid JSON")
except json.JSONDecodeError as e:
    err(f"Invalid JSON: {e}")
    sys.exit(1)

nodes = g.get("nodes", [])
edges = g.get("edges", [])

print(f"  Nodes: {len(nodes)}, Edges: {len(edges)}")
print()

# --- 2. Every node has non-empty id ---
print("--- Node bindings ---")
unbound = [n for n in nodes if not n.get("id")]
if unbound:
    for n in unbound:
        err(f"Node '{n.get('label', n['uuid'][:8])}' has empty id (not bound to registry)")
else:
    info(f"All {len(nodes)} nodes have non-empty id")

# --- 3. Measurable nodes have event_id on graph node ---
uuid_to_node = {n["uuid"]: n for n in nodes}
nodes_missing_event = []
for n in nodes:
    nid = n.get("id", "")
    if not nid:
        continue
    # Skip case nodes, absorbing nodes, placeholders
    if n.get("type") == "case":
        continue
    if n.get("absorbing"):
        continue
    # Check if node file has event_id
    node_file = os.path.join(REPO, "nodes", f"{nid}.yaml")
    if os.path.exists(node_file):
        with open(node_file) as f:
            ndata = yaml.safe_load(f)
        if ndata and ndata.get("event_id"):
            # Node file has event_id — graph node should too
            if not n.get("event_id"):
                err(f"Node '{n.get('label', nid)}' (id={nid}): node file has event_id='{ndata['event_id']}' but graph node is missing event_id")
                nodes_missing_event.append(nid)
            elif n.get("event_id") != ndata.get("event_id"):
                err(f"Node '{nid}': graph event_id='{n['event_id']}' != node file event_id='{ndata['event_id']}'")
            else:
                pass  # Match
        else:
            # No event in node file — OK (unmeasurable)
            if n.get("event_id"):
                warn(f"Node '{nid}': graph has event_id='{n['event_id']}' but node file has no event_id")

if not nodes_missing_event:
    info("All measurable nodes have event_id on graph node")

# --- 4. event_id references existing event file ---
print()
print("--- Event file references ---")
missing_events = []
for n in nodes:
    eid = n.get("event_id")
    if eid:
        event_file = os.path.join(REPO, "events", f"{eid}.yaml")
        if not os.path.exists(event_file):
            err(f"Node '{n.get('id', n['uuid'][:8])}' references event '{eid}' but file events/{eid}.yaml not found")
            missing_events.append(eid)
if not missing_events:
    info("All event_id references resolve to existing event files")

# --- 5. node id references existing node file ---
print()
print("--- Node file references ---")
missing_nodes = []
for n in nodes:
    nid = n.get("id", "")
    if nid:
        node_file = os.path.join(REPO, "nodes", f"{nid}.yaml")
        if not os.path.exists(node_file):
            err(f"Node id='{nid}' has no file at nodes/{nid}.yaml")
            missing_nodes.append(nid)
if not missing_nodes:
    info("All node id references resolve to existing node files")

# --- 6. Absorbing nodes check ---
print()
print("--- Absorbing nodes ---")
# Nodes with no outgoing edges should be absorbing
nodes_with_outgoing = set()
for e in edges:
    nodes_with_outgoing.add(e["from"])
for n in nodes:
    has_outgoing = n["uuid"] in nodes_with_outgoing
    is_absorbing = n.get("absorbing", False)
    if not has_outgoing and not is_absorbing:
        warn(f"Node '{n.get('label', n.get('id', n['uuid'][:8]))}' has no outgoing edges but is not marked absorbing")

# --- 7. Edge from/to reference valid UUIDs ---
print()
print("--- Edge references ---")
valid_uuids = {n["uuid"] for n in nodes}
bad_edges = 0
for e in edges:
    if e["from"] not in valid_uuids:
        err(f"Edge '{e.get('id', e['uuid'][:8])}' from='{e['from'][:8]}...' references non-existent node")
        bad_edges += 1
    if e["to"] not in valid_uuids:
        err(f"Edge '{e.get('id', e['uuid'][:8])}' to='{e['to'][:8]}...' references non-existent node")
        bad_edges += 1
if bad_edges == 0:
    info("All edge from/to references are valid")

# --- 8. Edge queries use node IDs (not UUIDs) ---
print()
print("--- Edge query format ---")
uuid_pattern = re.compile(r'[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}')
uuid_queries = 0
for e in edges:
    q = e.get("query", "")
    if uuid_pattern.search(q):
        err(f"Edge '{e.get('id', e['uuid'][:8])}' query contains UUID: {q[:60]}...")
        uuid_queries += 1
if uuid_queries == 0:
    info("No edge queries contain UUIDs (all use node IDs)")

# --- 9. Unique UUIDs ---
print()
print("--- UUID uniqueness ---")
node_uuids = [n["uuid"] for n in nodes]
edge_uuids = [e["uuid"] for e in edges]
dup_nodes = len(node_uuids) - len(set(node_uuids))
dup_edges = len(edge_uuids) - len(set(edge_uuids))
if dup_nodes:
    err(f"{dup_nodes} duplicate node UUID(s)")
if dup_edges:
    err(f"{dup_edges} duplicate edge UUID(s)")
if not dup_nodes and not dup_edges:
    info("All UUIDs are unique")

# --- 10. Outgoing probabilities ---
print()
print("--- Probability sums ---")
from collections import defaultdict
outgoing = defaultdict(list)
for e in edges:
    outgoing[e["from"]].append(e.get("p", {}).get("mean", 0))
prob_issues = 0
for uuid, probs in outgoing.items():
    total = sum(probs)
    node = uuid_to_node.get(uuid, {})
    if total > 1.05:
        warn(f"Node '{node.get('label', node.get('id', uuid[:8]))}' outgoing probabilities sum to {total:.2f} (>1.0)")
        prob_issues += 1
if prob_issues == 0:
    info("No outgoing probability sums exceed 1.0")

# --- 11. Data connection ---
# Connection is resolved at graph level (defaultConnection) with optional per-edge overrides.
# If graph has fetchable edges (both nodes have event_id), there must be EITHER
# a graph-level defaultConnection OR per-edge p.connection on those edges.
# Edges touching nodes without events are unfetchable and should NOT have p.connection.
print()
print("--- Data connection ---")
graph_default_conn = g.get("defaultConnection", "")
conn_issues = 0
for e in edges:
    p = e.get("p", {})
    from_n = uuid_to_node.get(e["from"], {})
    to_n = uuid_to_node.get(e["to"], {})
    from_has_event = bool(from_n.get("event_id"))
    to_has_event = bool(to_n.get("event_id"))
    both_have_events = from_has_event and to_has_event
    from_id = from_n.get("id", e["from"][:8])
    to_id = to_n.get("id", e["to"][:8])

    edge_conn = p.get("connection", "")
    effective_conn = edge_conn or graph_default_conn

    if both_have_events and not effective_conn:
        err(f"Edge '{from_id}' -> '{to_id}': fetchable but no connection (set graph defaultConnection or edge p.connection)")
        conn_issues += 1
    elif not both_have_events and edge_conn:
        err(f"Edge '{from_id}' -> '{to_id}': has p.connection but node(s) lack event_id — remove edge-level connection")
        conn_issues += 1

if not graph_default_conn:
    warn("Graph has no defaultConnection — each fetchable edge needs p.connection individually")
else:
    info(f"Graph defaultConnection: {graph_default_conn}")

if conn_issues == 0:
    info("Data connections are correct")

# --- 12. Parameter file connection (provenance only) ---
# Connection on parameter files is provenance only (not used as config input).
# We do NOT require it. We warn if it differs from graph default (stale provenance).
print()
print("--- Parameter connection provenance ---")
param_conn_notes = 0
for e in edges:
    param_id = e.get("p", {}).get("id", "")
    if not param_id:
        from_n = uuid_to_node.get(e["from"], {})
        to_n = uuid_to_node.get(e["to"], {})
        from_id = from_n.get("id", "")
        to_id = to_n.get("id", "")
        param_id = f"{from_id}-to-{to_id}"
    param_path = os.path.join(REPO, "parameters", f"{param_id}.yaml")
    if not os.path.exists(param_path):
        continue
    with open(param_path) as pf:
        pcontent = pf.read()
    import re as _re
    m = _re.search(r'^connection:\s*(.+)$', pcontent, _re.MULTILINE)
    if m and graph_default_conn and m.group(1).strip() != graph_default_conn:
        warn(f"Parameter '{param_id}': file has connection '{m.group(1).strip()}' but graph default is '{graph_default_conn}' (stale provenance?)")
        param_conn_notes += 1
if param_conn_notes == 0:
    info("Parameter connection provenance OK")

# --- 12b. No queries in unfetchable parameter files ---
param_query_issues = 0
for e in edges:
    from_n = uuid_to_node.get(e["from"], {})
    to_n = uuid_to_node.get(e["to"], {})
    both_ev = bool(from_n.get("event_id")) and bool(to_n.get("event_id"))
    if both_ev:
        continue
    from_id = from_n.get("id", "")
    to_id = to_n.get("id", "")
    param_id = f"{from_id}-to-{to_id}"
    param_path = os.path.join(REPO, "parameters", f"{param_id}.yaml")
    if not os.path.exists(param_path):
        continue
    with open(param_path) as pf:
        pcontent = pf.read()
    if "\nquery:" in pcontent or pcontent.startswith("query:"):
        err(f"Parameter '{param_id}': unfetchable but param file still has 'query' — planner will warn")
        param_query_issues += 1
if param_query_issues == 0:
    info("Unfetchable parameter files have no queries (clean)")

# --- 13. Spurious _overridden flags ---
print()
print("--- Override flags ---")
override_count = 0
for n in nodes:
    for k in n:
        if k.endswith("_overridden"):
            warn(f"Node '{n.get('label', n.get('id', n['uuid'][:8]))}' has '{k}={n[k]}' — should this be overridden?")
            override_count += 1
for e in edges:
    p = e.get("p", {})
    for k in p:
        if k.endswith("_overridden"):
            from_id = uuid_to_node.get(e["from"], {}).get("id", e["from"][:8])
            to_id = uuid_to_node.get(e["to"], {}).get("id", e["to"][:8])
            warn(f"Edge '{from_id}' -> '{to_id}' has p.'{k}={p[k]}' — mean_overridden prevents data fetch from updating this edge")
            override_count += 1
if override_count == 0:
    info("No _overridden flags found (clean graph)")
else:
    warn(f"{override_count} _overridden flag(s) found — review whether these are intentional")

# --- 14. Parameter file binding (p.id) on fetchable edges ---
print()
print("--- Parameter bindings (p.id) ---")
pid_issues = 0
for e in edges:
    p = e.get("p", {})
    from_n = uuid_to_node.get(e["from"], {})
    to_n = uuid_to_node.get(e["to"], {})
    both_have_events = bool(from_n.get("event_id")) and bool(to_n.get("event_id"))
    from_id = from_n.get("id", e["from"][:8])
    to_id = to_n.get("id", e["to"][:8])

    if both_have_events and not p.get("id"):
        err(f"Fetchable edge '{from_id}' -> '{to_id}' is missing p.id (not linked to a parameter file)")
        pid_issues += 1
    elif not both_have_events and p.get("id"):
        err(f"Unfetchable edge '{from_id}' -> '{to_id}' has p.id='{p['id']}' — unfetchable edges should not bind to parameter files")
        pid_issues += 1
    elif p.get("id"):
        param_path = os.path.join(REPO, "parameters", f"{p['id']}.yaml")
        if not os.path.exists(param_path):
            err(f"Edge p.id='{p['id']}' references non-existent parameter file")
            pid_issues += 1
if pid_issues == 0:
    info("Parameter bindings correct (present on fetchable edges, absent on unfetchable)")

# --- 15. No queries on unfetchable edges ---
print()
print("--- Query presence ---")
bad_queries = 0
for e in edges:
    from_n = uuid_to_node.get(e["from"], {})
    to_n = uuid_to_node.get(e["to"], {})
    both_ev = bool(from_n.get("event_id")) and bool(to_n.get("event_id"))
    from_id = from_n.get("id", e["from"][:8])
    to_id = to_n.get("id", e["to"][:8])
    if not both_ev and e.get("query"):
        err(f"Unfetchable edge '{from_id}' -> '{to_id}' has a query but node(s) lack event_id — remove the query to avoid planner warnings")
        bad_queries += 1
    elif both_ev and not e.get("query"):
        warn(f"Fetchable edge '{from_id}' -> '{to_id}' has no query — it won't fetch data")
        bad_queries += 1
if bad_queries == 0:
    info("Queries correct (present on fetchable edges, absent on unfetchable)")

# --- 16. Handle format (ReactFlow convention) ---
print()
print("--- Handle format ---")
handle_issues = 0
for e in edges:
    from_n = uuid_to_node.get(e["from"], {})
    to_n = uuid_to_node.get(e["to"], {})
    from_id = from_n.get("id", e["from"][:8])
    to_id = to_n.get("id", e["to"][:8])
    fh = e.get("fromHandle", "")
    th = e.get("toHandle", "")
    if fh and not fh.endswith("-out"):
        err(f"Edge '{from_id}' -> '{to_id}': fromHandle='{fh}' missing '-out' suffix (ReactFlow requires e.g. 'right-out', 'bottom-out')")
        handle_issues += 1
    if th and th.endswith("-out"):
        warn(f"Edge '{from_id}' -> '{to_id}': toHandle='{th}' has '-out' suffix (target handles should be e.g. 'left', 'top')")
        handle_issues += 1
if handle_issues == 0:
    info("All handle IDs follow ReactFlow convention (source: *-out, target: no -out)")

# --- 17. cohort_anchor_event_id on fetchable edges ---
print()
print("--- Cohort anchor event ---")
# Find start node event_id
start_nodes = [n for n in nodes if n.get("entry", {}).get("is_start")]
start_event = start_nodes[0].get("event_id") if start_nodes else None
anchor_issues = 0
for e in edges:
    p = e.get("p", {})
    from_n = uuid_to_node.get(e["from"], {})
    to_n = uuid_to_node.get(e["to"], {})
    both_ev = bool(from_n.get("event_id")) and bool(to_n.get("event_id"))
    if both_ev and not p.get("cohort_anchor_event_id"):
        from_id = from_n.get("id", e["from"][:8])
        to_id = to_n.get("id", e["to"][:8])
        fix = f" (set to '{start_event}')" if start_event else ""
        err(f"Edge '{from_id}' -> '{to_id}': missing p.cohort_anchor_event_id — cohort analysis will fail{fix}")
        anchor_issues += 1
if anchor_issues == 0:
    info("All fetchable edges have cohort_anchor_event_id")

# --- 18. Mass conservation (complement edges) ---
print()
print("--- Mass conservation ---")
mass_issues = 0
for n in nodes:
    if n.get("absorbing") or n["uuid"] not in nodes_with_outgoing:
        continue
    nid = n.get("id", n["uuid"][:8])
    out_edges = [e for e in edges if e["from"] == n["uuid"]]
    has_absorbing_target = any(
        uuid_to_node.get(e["to"], {}).get("absorbing", False)
        for e in out_edges
    )
    if not has_absorbing_target:
        # Check if all targets have event_id (all fetchable, no complement)
        all_fetchable = all(
            bool(uuid_to_node.get(e["to"], {}).get("event_id"))
            for e in out_edges
        )
        if all_fetchable and n.get("event_id"):
            warn(f"Node '{nid}': no complement edge to absorbing node — residual probability (1-Σp) is lost")
            mass_issues += 1
if mass_issues == 0:
    info("All non-absorbing nodes with outgoing edges have complement paths")

# --- 19. Edge UUID v4 format ---
print()
print("--- Edge UUID format ---")
uuid_v4_re = re.compile(r'^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$')
uuid_fmt_issues = 0
for e in edges:
    euuid = e.get("uuid", "")
    if euuid and not uuid_v4_re.match(euuid):
        from_n = uuid_to_node.get(e["from"], {})
        to_n = uuid_to_node.get(e["to"], {})
        from_id = from_n.get("id", e["from"][:8])
        to_id = to_n.get("id", e["to"][:8])
        warn(f"Edge '{from_id}' -> '{to_id}': UUID '{euuid}' is not valid v4 format")
        uuid_fmt_issues += 1
if uuid_fmt_issues == 0:
    info("All edge UUIDs are valid v4 format")

# --- 20. latency_parameter on fetchable edges ---
print()
print("--- Latency parameter ---")
lat_issues = 0
for e in edges:
    p = e.get("p", {})
    from_n = uuid_to_node.get(e["from"], {})
    to_n = uuid_to_node.get(e["to"], {})
    both_ev = bool(from_n.get("event_id")) and bool(to_n.get("event_id"))
    if both_ev and not p.get("latency", {}).get("latency_parameter"):
        from_id = from_n.get("id", e["from"][:8])
        to_id = to_n.get("id", e["to"][:8])
        warn(f"Edge '{from_id}' -> '{to_id}': p.latency.latency_parameter not set — completeness/model curves won't compute")
        lat_issues += 1
if lat_issues == 0:
    info("All fetchable edges have latency_parameter set")

# --- 21. pinnedDSL / dataInterestsDSL (simulation graphs) ---
print()
print("--- DSL presence ---")
is_sim = g.get("simulation", False)
has_pinned = bool(g.get("pinnedDSL"))
has_interests = bool(g.get("dataInterestsDSL"))
if is_sim:
    if not has_pinned:
        err("Simulation graph missing pinnedDSL — FE will default to 'last 30 days' which may not overlap synthetic data dates")
    else:
        info(f"pinnedDSL: {g['pinnedDSL']}")
    if not has_interests:
        warn("Simulation graph missing dataInterestsDSL")
    else:
        info(f"dataInterestsDSL: {g['dataInterestsDSL']}")
else:
    if has_pinned:
        info(f"pinnedDSL: {g['pinnedDSL']}")
    if has_interests:
        info(f"dataInterestsDSL: {g['dataInterestsDSL']}")

# --- 22. Parameter file completeness ---
print()
print("--- Parameter file completeness ---")
param_completeness_issues = 0
for e in edges:
    p = e.get("p", {})
    param_id = p.get("id", "")
    if not param_id:
        continue
    param_path = os.path.join(REPO, "parameters", f"{param_id}.yaml")
    if not os.path.exists(param_path):
        continue
    with open(param_path) as pf:
        pdata = yaml.safe_load(pf)
    if not pdata:
        continue
    values = pdata.get("values", [])
    if not values:
        warn(f"Parameter '{param_id}': no values[] entries (empty file)")
        param_completeness_issues += 1
        continue

    for vi, v in enumerate(values):
        dsl = v.get("sliceDSL", "")
        prefix = f"Parameter '{param_id}' values[{vi}] ({dsl[:25]})"

        # query_signature required for snapshot matching
        if not v.get("query_signature"):
            warn(f"{prefix}: missing query_signature — snapshot queries won't match")
            param_completeness_issues += 1

        # Per-day arrays should be lists, not scalars
        for field in ["median_lag_days", "mean_lag_days"]:
            val = v.get(field)
            if val is not None and not isinstance(val, list):
                err(f"{prefix}: {field} is {type(val).__name__}, expected list (per-day array)")
                param_completeness_issues += 1

        # Cohort entries need anchor stats
        if "cohort(" in dsl:
            if not v.get("anchor_median_lag_days"):
                warn(f"{prefix}: cohort entry missing anchor_median_lag_days — stats pass can't derive path params")
                param_completeness_issues += 1
            if not v.get("anchor_n_daily"):
                warn(f"{prefix}: cohort entry missing anchor_n_daily")
                param_completeness_issues += 1

        # onset should be nested in latency, not flat
        if "onset_delta_days" in v and "latency" not in v:
            warn(f"{prefix}: onset_delta_days is flat (should be nested in latency: {{onset_delta_days: ...}})")
            param_completeness_issues += 1

if param_completeness_issues == 0:
    info("Parameter files have required fields")

# --- 23. Simulation guard consistency ---
print()
print("--- Simulation guard ---")
sim_guard = g.get("simulation", False)
daily_fetch = g.get("dailyFetch", True)
if sim_guard and daily_fetch:
    err("simulation=true but dailyFetch=true — FE will attempt Amplitude fetches and overwrite synthetic data")
elif sim_guard and not daily_fetch:
    info("Simulation guard OK (simulation=true, dailyFetch=false)")
elif not sim_guard:
    info("Not a simulation graph (simulation flag absent or false)")

# --- Summary ---
print()
if errors == 0 and warnings == 0:
    print("ALL CHECKS PASSED.")
elif errors == 0:
    print(f"PASSED with {warnings} warning(s).")
else:
    print(f"FAILED: {errors} error(s), {warnings} warning(s).")
    sys.exit(1)
PYEOF

STRUCTURAL_EXIT=$?

# ───────────────────────────────────────────────────────────────────────────
# Deep check: run production IntegrityCheckService via Vitest
# ───────────────────────────────────────────────────────────────────────────

if [ "$DEEP" = true ]; then
  echo ""
  echo "==> Running deep check (production IntegrityCheckService)..."
  echo ""

  # Find the graph-editor directory (sibling of data repo)
  GRAPH_EDITOR_DIR="$(dirname "$DATA_REPO_PATH")/graph-editor"

  if [ ! -d "$GRAPH_EDITOR_DIR" ]; then
    echo "  WARN: graph-editor directory not found at $GRAPH_EDITOR_DIR — skipping deep check"
  else
    # Source nvm if available for node/npm
    export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
    if [ -s "$NVM_DIR/nvm.sh" ]; then
      . "$NVM_DIR/nvm.sh"
    fi

    GRAPH_FILE_REL="$GRAPH_ARG"
    cd "$GRAPH_EDITOR_DIR"
    
    if command -v npx &> /dev/null; then
      # Deep check uses DagNet's production IntegrityCheckService (runs inside graph-editor).
      GRAPH_PREFLIGHT=1 GRAPH_FILE="$GRAPH_FILE_REL" npx vitest run --reporter=verbose src/services/__tests__/graphPreflightCheck.test.ts 2>&1
      DEEP_EXIT=$?
      
      if [ $DEEP_EXIT -ne 0 ]; then
        echo ""
        echo "DEEP CHECK FAILED (exit code $DEEP_EXIT)"
        exit 1
      else
        echo ""
        echo "DEEP CHECK PASSED"
      fi
    else
      echo "  WARN: npx not found — skipping deep check (install Node.js or run: nvm use)"
    fi
  fi
fi

exit ${STRUCTURAL_EXIT:-0}
