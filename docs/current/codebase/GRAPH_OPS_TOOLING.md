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

## CLI Tools (Node/TypeScript via tsx)

CLI tools live in `graph-editor/src/cli/` and are invoked via wrapper
scripts in `graph-ops/scripts/`. They run in Node (not a browser) using
`tsx` and `fake-indexeddb` for the Dexie shim. They import the same TS
modules the browser uses — no reimplementation.

### param-pack

**Script**: `graph-ops/scripts/param-pack.sh`

Produces a param pack for a graph given a query DSL expression —
the same output a user gets by choosing options in the WindowSelector
component.

```bash
# YAML output (default)
bash graph-ops/scripts/param-pack.sh <graph-name> "<query-dsl>"

# JSON output
bash graph-ops/scripts/param-pack.sh <graph-name> "<query-dsl>" --format json

# Single scalar value
bash graph-ops/scripts/param-pack.sh <graph-name> "<query-dsl>" \
  --get "e.edge-id.p.mean"

# Pipe JSON (diagnostics to stderr, data to stdout)
bash graph-ops/scripts/param-pack.sh <graph-name> "<query-dsl>" \
  --format json 2>/dev/null | jq .
```

**What it does**:

1. Loads graph JSON + events/contexts/parameters/cases/connections YAML
   from the data repo (path resolved from `.private-repos.conf`)
2. Seeds `fileRegistry` and `contextRegistry` in memory (no IDB needed)
3. Parses the query DSL, resolves relative dates
4. Filters parameter file daily arrays (`n_daily`, `k_daily`, `dates`)
   to the requested window/cohort range
5. Computes evidence scalars (n, k, mean, stdev)
6. Runs the full LAG topological pass (`enhanceGraphLatencies`) for
   latency, completeness, blended p.mean, t95, path_t95
7. Extracts params via `GraphParamExtractor`
8. Serialises via `ParamPackDSLService` (YAML/JSON/CSV)

**Options**:

| Flag | Purpose |
|------|---------|
| `--format yaml\|json\|csv` | Output format (default: yaml) |
| `--get <key>` | Extract single scalar (bare value to stdout) |
| `--show-signatures` | Show computed hash signatures per edge |
| `--verbose` / `-v` | Show all console.log debug output |
| `--session-log` | Show session log output |

**Environment**: `PYTHON_API_URL` overrides the Python BE URL
(default: `http://localhost:9000`). The BE is not called in the
current version — all data comes from parameter files on disk.

**Architecture**: See `docs/current/project-cli/programme.md` for
the full design, feasibility assessment, and phase plan.

### analyse

**Script**: `graph-ops/scripts/analyse.sh`

Runs a graph analysis via the Python BE and returns the result JSON —
the same payload that feeds ECharts in the browser. Requires the
Python BE running.

```bash
# Single scenario — subject in the DSL
bash graph-ops/scripts/analyse.sh <graph-name> \
  "from(x).to(y).window(-30d:)" --type cohort_maturity

# Multi-scenario (e.g. bridge comparison)
bash graph-ops/scripts/analyse.sh <graph-name> \
  --scenario "window(1-Nov-25:30-Nov-25)" \
  --scenario "window(1-Dec-25:31-Dec-25)" \
  --type bridge --subject "from(x).to(y)"

# Extract specific data
bash graph-ops/scripts/analyse.sh <graph-name> \
  "from(x).to(y).window(-30d:)" --type graph_overview \
  --get "result.data.0.probability" --format json
```

**Scenarios**: Each `--scenario` flag produces a separately-aggregated
graph. The last scenario maps to "Current" in FE terms; earlier ones
are stacked scenarios in order:

| CLI args | BE scenarios[0] | scenarios[1] | scenarios[2] |
|----------|----------------|-------------|-------------|
| 1 scenario | Current | | |
| 2 scenarios | Scenario A | Current | |
| 3 scenarios | Scenario B | Scenario A | Current |

Default names are `Scenario 1`, `Scenario 2`, etc. Override with
`name=Before` in the spec string.

**Scenario spec format**: `"<dsl>"` or `"name=<n>,colour=#hex,<dsl>"`.
Key=value pairs are named properties; the remaining bare string is the
query DSL. Commas inside parentheses are preserved
(`context(a,b).window(...)` works).

**Subject**: For single-scenario, the subject (`from(x).to(y)`) can
be part of the DSL string. For multi-scenario, use `--subject` to
specify it once — it's constant across scenarios and gets joined with
the first scenario's DSL for the BE `query_dsl`.

**Options**:

| Flag | Purpose |
|------|---------|
| `--type <type>` | Analysis type (graph_overview, cohort_maturity, daily_conversions, lag_histogram, surprise, bridge) |
| `--scenario <spec>` | Scenario specification (repeatable) |
| `--subject <dsl>` | Analysis subject DSL (e.g. `from(x).to(y)`) — shared across scenarios |
| `--get <key>` | Extract a value via dot-path (e.g. `result.data.0.probability`) |
| `--format json\|yaml` | Output format (default: json) |
| `--no-cache` | Bypass disk bundle cache |
| `--verbose` / `-v` | Show all console.log debug output |

**Environment**: `PYTHON_API_URL` overrides the Python BE URL
(default: `http://localhost:9000`).

### Shared options

All CLI commands support:

| Flag | Purpose |
|------|---------|
| `--no-cache` | Bypass disk bundle cache (re-parse all YAML) |
| `--verbose` / `-v` | Show all internal debug logging |
| `--session-log` | Show session log output |

Diagnostics go to stderr, data goes to stdout. Use `2>/dev/null` to
suppress diagnostics when piping.

### Disk bundle cache

First invocation parses all YAML from the data repo and writes a
JSON cache to `~/.cache/dagnet-cli/`. Subsequent calls check source
file mtimes — if unchanged, load from cache. Pass `--no-cache` to
bypass.

### CLI module layout

```
graph-editor/src/cli/
├── bootstrap.ts          # Shared: arg parsing, graph loading, registry seeding
├── diskLoader.ts         # Shared: reads YAML/JSON from data repo on disk
├── aggregate.ts          # Shared: window/cohort aggregation + LAG pass
├── param-pack.ts         # Entry: console suppression + dynamic import
├── analyse.ts            # Entry: console suppression + dynamic import
└── commands/
    ├── paramPack.ts      # Command: param-pack specific logic
    └── analyse.ts        # Command: analyse with multi-scenario support
```

Adding a new command requires: a `commands/<name>.ts` with
`export async function run()`, a 3-line entry point in `cli/<name>.ts`
(suppress, fake-idb, import), and a wrapper in `graph-ops/scripts/`.

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
