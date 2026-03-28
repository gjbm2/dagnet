# Graph-Ops Tooling Reference

Tools for managing conversion graphs in the data repo. Scripts live in
`graph-ops/scripts/` in the dagnet repo. They operate on graph files
in the data repo (path resolved from `.private-repos.conf`).

## Graph Validation

**Script**: `graph-ops/scripts/validate-graph.sh`

```bash
# Structural checks only (< 1s)
bash graph-ops/scripts/validate-graph.sh graphs/<name>.json

# Structural + production IntegrityCheckService via Vitest (~10s)
bash graph-ops/scripts/validate-graph.sh graphs/<name>.json --deep
```

Runs 23 structural checks:

1. Valid JSON
2. Every node has non-empty `id` (bound to node registry)
3. Measurable nodes have `event_id` on graph node
4. `event_id` on graph matches `event_id` in node YAML
5. Every `event_id` references an existing event YAML
6. Every node `id` references an existing node YAML
7. Absorbing/terminal nodes marked `absorbing: true`
8. Edge `from`/`to` reference valid node UUIDs
9. Edge queries use node IDs (not UUIDs)
10. Node + edge UUIDs are unique (no duplicates)
11. Outgoing probabilities from each node sum to <= 1.0
12. Graph has `defaultConnection` (or per-edge `p.connection`)
13. Parameter file connection provenance
14. Parameter bindings (`p.id` on fetchable, absent on unfetchable)
15. Queries on fetchable edges, absent on unfetchable
16. Handle format (`fromHandle: *-out`, `toHandle: no -out`)
17. `cohort_anchor_event_id` on all fetchable edges
18. Mass conservation (complement edges to absorbing nodes)
19. Edge UUIDs are valid v4 format
20. `latency_parameter` set on fetchable edges
21. `pinnedDSL` / `dataInterestsDSL` present (simulation graphs)
22. Parameter files have required fields (values[], query_signature)
23. Simulation guard consistency (simulation + dailyFetch flags)

**MANDATORY before**: generating synthetic data, committing graph
changes, or running Bayes fits on new graphs.

## Index Validation

```bash
bash graph-ops/scripts/validate-indexes.sh
```

Checks `nodes-index.yaml`, `parameters-index.yaml`, and
`events-index.yaml` for consistency with on-disk files.

## Other Scripts

| Script | Purpose |
|---|---|
| `commit-and-push.sh` | Commit data repo changes and push |
| `new-branch.sh` | Create a new branch in the data repo |
| `pull-latest.sh` | Pull latest from remote |
| `status.sh` | Show data repo git status |
| `list-graph.sh` | List available graphs |
| `_load-conf.sh` | Shared helper: loads `.private-repos.conf` |

## Key Invariants

- All graph node/edge UUIDs must be unique **across graphs** — shared
  UUIDs cause snapshot DB data collisions.
- Event names (`provider_event_names.amplitude`) drive FE hash
  computation. Unique events per graph are essential for hash
  isolation.
- Dropout edges need `p.mean` set to `1 - main_edge_p` for mass
  conservation.
- The validator does NOT check cross-graph UUID uniqueness — that
  must be verified manually when creating new synth graphs from
  templates.
