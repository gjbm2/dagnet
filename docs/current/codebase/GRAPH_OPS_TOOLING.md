# Graph-Ops Tooling Reference

Tools for managing conversion graphs in the data repo. Scripts live in
`graph-ops/scripts/` in the dagnet repo. They operate on graph files
in the data repo (path resolved from `.private-repos.conf`).

## Quick Reference

**Setup (run once per session)**:
```bash
# Node (required for all CLI tools)
export NVM_DIR="$HOME/.nvm" && . "$NVM_DIR/nvm.sh" && cd graph-editor && nvm use "$(cat .nvmrc)" && cd ..

# Python BE (required for analyse, hydrate, bayes — NOT needed for param-pack or validate)
cd graph-editor && . venv/bin/activate && python dev-server.py &
cd ..
```

**Most common commands**:
```bash
# Validate a graph (no BE needed)
bash graph-ops/scripts/validate-graph.sh graphs/<name>.json

# Get param pack for a graph
bash graph-ops/scripts/param-pack.sh <graph> "window(-30d:)"

# Run graph overview analysis (BE required)
bash graph-ops/scripts/analyse.sh <graph> "window(-30d:)" --type graph_overview

# Run edge-level analysis
bash graph-ops/scripts/analyse.sh <graph> \
  "from(x).to(y).window(-30d:)" --type cohort_maturity

# Run conditioned forecast scalars for an edge/path
bash graph-ops/scripts/analyse.sh <graph> \
  "from(x).to(y).window(-30d:)" --type conditioned_forecast

# Run analysis on synth graph (after synth_gen.py)
bash graph-ops/scripts/analyse.sh <graph> "<dsl>" \
  --type cohort_maturity_v2 --no-snapshot-cache

# List available graphs
bash graph-ops/scripts/list-graph.sh
```

**Key flags**: `--verbose` (debug output), `--format json` (pipe to jq),
`--no-cache` (bypass disk bundle cache), `--no-snapshot-cache` (bypass
BE cache after DB changes), `--bayes-vars <path>` (inject a Bayesian
posterior sidecar into the graph before the command runs; every
command honours it), `--force-vars` (with `--bayes-vars`, bypass
rhat/ess quality gates).

**Diagnostics go to stderr, data to stdout.** Use `2>/dev/null` when piping.

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
2. Seeds `fileRegistry` and `contextRegistry` in memory
   (`fake-indexeddb` provides the Dexie shim)
3. Runs the SAME `fetchDataService.fetchItems({ mode: 'from-file' })`
   pipeline the browser uses — one codepath, not a reimplementation
4. This populates graph edges with evidence, forecast, latency,
   `scope_from/to`, and runs the Stage 2 LAG topological pass
5. Extracts params via `GraphParamExtractor`
6. Serialises via `ParamPackDSLService` (YAML/JSON/CSV)

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
the same payload that feeds ECharts in the browser. Uses the same
preparation path as the FE: `prepareAnalysisComputeInputs` →
`runPreparedAnalysis`, including snapshot subject resolution, display
settings, and posterior re-projection. Requires the Python BE running.

```bash
# Single scenario — subject in the DSL
bash graph-ops/scripts/analyse.sh <graph-name> \
  "from(x).to(y).window(-30d:)" --type cohort_maturity

# Multi-scenario (e.g. bridge comparison)
bash graph-ops/scripts/analyse.sh <graph-name> \
  --scenario "window(1-Nov-25:30-Nov-25)" \
  --scenario "window(1-Dec-25:31-Dec-25)" \
  --type bridge --subject "from(x).to(y)"

# Conditioned forecast (graph enrichment endpoint, not chart rows)
bash graph-ops/scripts/analyse.sh <graph-name> \
  "from(x).to(y).window(-30d:)" --type conditioned_forecast

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
| `--type <type>` | Analysis type (graph_overview, cohort_maturity, cohort_maturity_v2, daily_conversions, lag_histogram, surprise, bridge, conditioned_forecast) |
| `--scenario <spec>` | Scenario specification (repeatable) |
| `--subject <dsl>` | Analysis subject DSL (e.g. `from(x).to(y)`) — shared across scenarios |
| `--no-snapshot-cache` | Bypass BE snapshot service cache (essential after `synth_gen.py` or DB repopulation) |
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
| `--bayes-vars <path>` | Inject a Bayesian posterior sidecar into the graph in-memory before the command runs (see below) |
| `--force-vars` | With `--bayes-vars`, bypass the rhat/ess quality gates |

Diagnostics go to stderr, data goes to stdout. Use `2>/dev/null` to
suppress diagnostics when piping.

### Bayesian sidebar vars injection (`--bayes-vars`)

Every CLI command accepts `--bayes-vars <path-to-bayes-vars.json>`.
When supplied, `bootstrap.ts` loads the sidecar, applies it in memory
via the production `bayesPatchService.applyPatch` codepath (the same
one the browser uses when a webhook patch lands), and re-binds
`bundle.graph` + every `bundle.parameters` entry from `fileRegistry`
so downstream aggregation, analysis, param-pack extraction, and
hydrate all see the enriched graph. No disk writes.

Accepts both sidecar shapes:

- Full `BayesPatchFile` (as committed by the webhook).
- Raw worker result containing `webhook_payload_edges` (as cached in
  `bayes/fixtures/*.bayes-vars.json`).

`wrapPatchIfRaw()` in `bayesPatchService.ts` normalises both into the
canonical `BayesPatchFile` shape.

`--force-vars` flips the module-level `qualityGateOverride` flag in
`bayesPatchService.ts` so `meetsQualityGate()` returns `true`
unconditionally — use when you deliberately want to inject a
low-convergence posterior for experimentation. Bootstrap always
resets the flag after injection so the bypass does not leak across
runs in long-lived processes (tests, REPL).

Typical use: analyse or param-pack a graph "as if" particular
posteriors were committed, without actually touching parameter files.

```bash
# Param pack with injected posteriors
bash graph-ops/scripts/param-pack.sh my-graph "window(-30d:)" \
  --bayes-vars bayes/fixtures/my-graph.bayes-vars.json

# Analyse with injected posteriors, quality gate bypassed
bash graph-ops/scripts/analyse.sh my-graph "window(-30d:)" \
  --type graph_overview \
  --bayes-vars bayes/fixtures/experimental.bayes-vars.json \
  --force-vars
```

Design rationale: the feature was added so one codepath — inside
`bootstrap()` — makes every CLI command bayes-vars-aware, rather
than wiring the flag into five command bodies separately.

### Disk bundle cache

First invocation parses all YAML from the data repo and writes a
JSON cache to `~/.cache/dagnet-cli/`. Subsequent calls check source
file mtimes — if unchanged, load from cache. Pass `--no-cache` to
bypass.

### CLI module layout

```
graph-editor/src/cli/
├── cliEntry.ts           # Shared: console suppression + import.meta.env polyfill
├── bootstrap.ts          # Shared: arg parsing, graph loading, registry seeding
├── diskLoader.ts         # Shared: reads YAML/JSON from data repo on disk
├── aggregate.ts          # Shared: calls fetchDataService.fetchItems (same as FE)
├── logger.ts             # Shared: CLI logger (stderr diagnostics)
├── constants.ts          # Shared: colour palette, cache config
├── scenarioParser.ts     # Shared: --scenario flag parsing
├── analysisTypeRegistry.ts # Shared: analysis type → snapshotContract lookup
├── param-pack.ts         # Entry point: param-pack command
├── analyse.ts            # Entry point: analyse command
├── parity-test.ts        # Entry point: parity test command
└── commands/
    ├── paramPack.ts      # Command: param-pack specific logic
    ├── analyse.ts        # Command: analyse with multi-scenario support
    └── parity-test.ts    # Command: parity test runner
```

Adding a new command requires: a `commands/<name>.ts` with
`export async function run()`, an entry point in `cli/<name>.ts`
that calls `initCLI()` then dynamically imports the command, and
a wrapper in `graph-ops/scripts/`.

### One-codepath principle

The CLI calls the **same functions** the browser calls. There are no
parallel reimplementations:

- **Aggregation**: `aggregate.ts` calls `fetchDataService.fetchItems`
  with `mode: 'from-file'` — the same function the browser's
  `useDSLReaggregation` hook calls.
- **Analysis**: `commands/analyse.ts` calls
  `prepareAnalysisComputeInputs` → `runPreparedAnalysis` — the same
  functions the browser's `useCanvasAnalysisCompute` hook calls.
- **Parity verified**: an E2E Playwright test
  (`e2e/cliParityGraphOverview.spec.ts`) loads a real graph in the
  browser, triggers from-file reaggregation, calls the BE with the
  FE's graph state, then runs the CLI separately and compares
  field-by-field. All probability values must match within 1e-6.

### Node compatibility guards

Several modules have `import.meta.env.DEV` or `import.meta.env.VITE_*`
at module scope or in function bodies. These throw in Node because
`import.meta.env` is `undefined` outside Vite. The pattern:

- Module-scope constants: use `import.meta.env?.VITE_X` (optional
  chaining)
- Function-body guards: use `import.meta.env?.DEV`
- `window.location.search`: use `getUrlSearchParams()` helper in
  `graphComputeClient.ts`
- Entry points: `cliEntry.ts` polyfills `import.meta.env = { DEV: false }`
  before any imports

If a helper is shared by browser + CLI, keep it in an isomorphic module
(`src/lib/` or another runtime-neutral surface) and pass runtime-specific
state in explicitly. `src/lib/conditionedForecastGraphSnapshot.ts` is the
reference example: it accepts a parameter-file resolver so the browser can
use `fileRegistry` while the CLI uses the disk-loaded bundle directly.

### hydrate

**Script**: `graph-ops/scripts/hydrate.sh`

Runs the shared Stage 2 enrichment pipeline (FE aggregation, FE topo
pass, promotion, and conditioned forecast) on a graph, then writes the
hydrated graph back to disk. Produces a graph JSON equivalent to what
the FE would have after opening the graph and running the full Stage 2
pipeline.

```bash
bash graph-ops/scripts/hydrate.sh <graph-name> "<query-dsl>"
```

**When to use**: after `synth_gen.py` creates a new graph, the graph
JSON has raw posteriors but no `model_vars`, promoted fields, or
path-level latency params. The FE populates these during aggregation
and the topo pass. Hydration runs this offline so the graph on disk
matches what the FE would produce.

**Note**: `analyse.sh` now runs the shared Stage 2 enrichment pipeline
directly, so Hydrate is mainly for persisting the enriched graph JSON
back to disk rather than for unlocking a separate topo-only codepath.

### v2-v3-parity-test

**Script**: `graph-ops/scripts/v2-v3-parity-test.sh`

End-to-end v2-vs-v3 cohort maturity parity test using the CLI
`analyse` tool. Runs the full FE pipeline (aggregation, subject
resolution, hash lookup, snapshot query, BE handler, FE normalisation)
for both `cohort_maturity_v2` and `cohort_maturity` analysis types,
then compares the output field by field.

```bash
# Run on synth graph (requires Python BE running)
bash graph-ops/scripts/v2-v3-parity-test.sh synth-mirror-4step

# With verbose diagnostic tables
bash graph-ops/scripts/v2-v3-parity-test.sh synth-mirror-4step --verbose

# Regenerate synth data first
bash graph-ops/scripts/v2-v3-parity-test.sh synth-mirror-4step --generate
```

**Phase 1 — data health checks** (non-vacuousness):
- Graph JSON exists with expected edges
- Snapshot DB has rows for each edge (cohort + window slice_keys)
- CLI analyse returns rows with `evidence_x > 0` (observed cohorts
  present — without this the test is vacuous)

**Phase 2 — parity comparison**:
- midpoint: Δ < 0.03
- fan width (90% band) ratio: within [0.65, 1.35]
- forecast_x ratio: within [0.80, 1.20]
- forecast_y ratio: within [0.80, 1.20]

**Critical design principle**: the test uses `analyse.sh` (the CLI
tooling) to run analyses, NOT reimplemented Python handler calls. The
CLI exercises the exact same pipeline as the browser — including FE
hash computation, subject resolution, and snapshot queries. Reimplementing
any part of this pipeline in test code creates a parallel path that
diverges from production and misses real bugs.

**Query window**: uses absolute dates matching the synth data range
(the synth `base_date` determines when snapshot data exists). Relative
dates like `-14d:` don't work because they're relative to today, which
may be months after the synth data was generated.

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
