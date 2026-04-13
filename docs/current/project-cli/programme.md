# Project CLI: Programme

**Status**: In progress — Phase 2 complete (full pipeline working)
**Created**: 8-Apr-26
**Updated**: 8-Apr-26
**Purpose**: Enable headless (Node.js) execution of DagNet query DSL
evaluation and stats computation — no browser required.

## Motivation

The browser UI orchestrates a multi-step pipeline: load graph → parse
DSL → plan fetches → compute signatures → call Python BE → assemble
results. Today this pipeline only runs inside the browser (even
retrieveAll, which is "headless" in the sense of no open tab, still
runs in a browser runtime — it doesn't need a visible tab, but the
browser is still there).

A CLI would allow scripted, scheduled, and programmatic access to the
same pipeline: "for graph X, evaluate query Y, return the result."

## Cardinal rule: identical codepaths

The CLI must produce the same output the app would, through the same
code. Not "equivalent" code, not a purified fork — the *same
functions*. If we maintain two codepaths, debugging becomes
impossible: every bug must be investigated twice, every semantic
change must be applied twice, and divergence is inevitable.

This means:
- The CLI calls the same TS modules the browser calls:
  `computePlausibleSignaturesForEdge()`, `buildFetchPlanProduction()`,
  `extractParamsFromGraph()`, `flattenParams()`, etc.
- The only new code is I/O adapters at the boundaries: reading files
  from disk instead of IDB, resolving the BE URL from env instead of
  `window.location`.
- No clean-room reimplementations. No "simplified" versions. If a
  module can't run in Node, we fix *that module* with a guard, and
  both browser and CLI benefit.

## First use case: param pack from cache

The initial target is producing a param pack for a graph given a query
DSL — the same output a user gets by choosing options in the
WindowSelector component. Equivalent to:

```
dagnet-cli param-pack \
  --graph /path/to/graph-dir \
  --query "context(channel:google).window(1-Dec-25:20-Dec-25)" \
  [--allow-external-fetch]
```

Default behaviour: cache-only. The CLI reads from the snapshot DB and
parameter files already populated by prior browser fetches or
retrieveAll runs. External source fetching (Amplitude etc.) is off
unless explicitly opted in.

Output: a param pack in HRN flat YAML/JSON/CSV — the same format
`ParamPackDSLService` already produces.

## Feasibility assessment (8-Apr-26)

An audit of the orchestration chain found ~80% of modules are already
browser-independent or have shallow browser coupling.

### Already pure / Node-ready

| Module | Notes |
|--------|-------|
| `dslExplosion.ts` | Zero browser deps. Pure recursive descent + Cartesian product. |
| `queryDSL.ts` | Pure constraint parsing. |
| `coreHashService.ts` | Uses `crypto.subtle` with existing Node fallback (`await import('crypto')`) and pure-JS last resort. |
| `signatureMatchingService.ts` | Pure matching logic, JSON only. |
| `candidateRegimeService.ts` | Pure computation, takes data in, returns data out. |
| `GraphParamExtractor.ts` | Extracts scenario-visible fields from graph. Pure data transform. |
| `ParamPackDSLService.ts` | Flattens params to HRN dot-notation, serialises to YAML/JSON/CSV. Pure. |
| `graphComputeClient.ts` | Standard `fetch()` (Node 18+). `window` references are optional debug flags only. |
| DAS HTTP layer | `DASRunnerFactory` already selects `ServerHttpExecutor` in non-browser environments. Direct HTTP, no proxy. |

### Not in the data path

`localStorage`, `sessionStorage`, `navigator.onLine`, service workers,
DOM APIs — none of these touch the orchestration chain.

## Architecture

### Pipeline for cache-first param pack

```
YAML/JSON files on disk (data repo)
        │
        ▼
  ┌──────────────────┐
  │  1. Disk I/O      │  Load graph JSON, events, contexts,
  │     adapter        │  parameters, connections from data repo
  └──────┬───────────┘
         │
         ▼
  ┌──────────────────┐
  │  2. DSL parse     │  queryDSL.parseConstraints()
  │                   │  dslExplosion.explodeDSL()
  └──────┬───────────┘
         │
         ▼
  ┌──────────────────────────────┐
  │  3. Signature computation     │  computePlausibleSignaturesForEdge()
  │     (NEEDS parameter files)   │  reads paramValues[].sliceDSL to
  │                               │  enumerate context key-sets, then
  │                               │  computes core_hash per key-set
  └──────┬───────────────────────┘
         │
         ▼
  ┌──────────────────┐
  │  4. Fetch plan    │  buildFetchPlanProduction() — classifies
  │     + coverage    │  each edge as covered / needs_fetch / gap
  │     check         │  using fileState accessor + snapshot inventory
  └──────┬───────────┘
         │
         ▼
  ┌──────────────────┐
  │  5. Snapshot      │  getBatchInventoryV2, querySnapshotsVirtual
  │     retrieval     │  — HTTP to Python BE's PostgreSQL cache
  │     from cache    │  (no Amplitude, no external sources)
  └──────┬───────────┘
         │
         ▼
  ┌──────────────────┐
  │  6. Window        │  aggregateWindowData() — pure given
  │     aggregation   │  parameter values from step 5
  └──────┬───────────┘
         │
         ▼
  ┌──────────────────┐
  │  7. Statistical   │  Calls Python BE /api/stats-enhance
  │     enhancement   │  with already-cached data as input
  └──────┬───────────┘
         │
         ▼
  ┌──────────────────┐
  │  8. Param extract │  GraphParamExtractor
  │  9. Serialise     │  ParamPackDSLService
  └──────┬───────────┘
         │
         ▼
  stdout (YAML / JSON / CSV)
```

Steps 2, 6, 8, 9 are already pure. Steps 1, 3, 4, 5, 7 need I/O
adapters or guards. Detailed plans for each follow.

---

## Step 1: Disk I/O adapter (replacing IDB/FileRegistry)

### What it replaces

In the browser, the graph and its associated files are loaded from git
into IDB, then cached in FileRegistry (an in-memory `Map<string,
FileState>`). The orchestration chain reads from FileRegistry via
accessors like `fileRegistry.getFile(fileId)` and the `fileState`
callback passed to the fetch planner.

The CLI replaces this with disk reads, but must populate the *same
in-memory structures* so downstream code sees no difference.

### Files to load from the data repo

```
{graph-dir}/
├── graphs/{name}.json         # The graph (ConversionGraph)
├── events/*.yaml              # Event definitions (node.event_id → provider mapping)
├── contexts/*.yaml            # Context definitions (for DSL context() clauses)
├── parameters/*.yaml          # Parameter files — REQUIRED (see below)
├── connections.yaml           # Connection definitions (provider endpoints, adapters)
├── cases/*.yaml               # Case definitions (if graph uses case() DSL)
└── hash-mappings.json         # Hash equivalence links for rename resilience
```

Index files (`nodes-index.yaml` etc.) are UI-only — not needed.

### Why parameter files are required

Parameter files are load-bearing in the signature computation path.
`computePlausibleSignaturesForEdge()` (in `snapshotRetrievalsService`)
loads the parameter file via `edge.p.id` and reads
`paramValues[].sliceDSL` to discover which context key-sets have been
used historically. Each distinct key-set produces a different
`core_hash`. Without the parameter file, the system would only compute
a signature for the explicitly-requested context keys from the
`--query` argument, missing historical data stored under other
key-sets.

The parameter file content (mean, stdev, evidence, etc.) does NOT
feed into the hash itself. But the file must be loadable for the
system to know *which hashes to compute*.

### What the adapter provides

The adapter must satisfy the interfaces the orchestration already uses:

1. **`fileState` accessor**: `(paramId: string) => ParameterFileData | undefined`
   — used by `buildFetchPlan()` and `calculateIncrementalFetch()`.
   The adapter loads `parameters/*.yaml` from disk and returns them
   via this accessor.

2. **`contextRegistry` population**: the existing `contextRegistry`
   has an in-memory cache. The adapter loads `contexts/*.yaml` from
   disk and pre-populates this cache so the IDB fallback is never
   reached. (Requires a `preloadContexts()` method — see Phase 0.)

3. **Event loader**: `loadEventDefinition(eventId)` — used during
   signature computation by `buildDslFromEdge()`. The adapter loads
   `events/*.yaml` from disk and provides them via the same interface.

4. **Connection provider**: already exists as
   `FileSystemConnectionProvider` in `ConnectionProvider.ts` — reads
   `connections.yaml` from disk via `fs/promises` + `js-yaml`.
   Node-ready.

5. **Hash mappings loader**: `hash-mappings.json` — used by
   `hashMappingsService.getClosureSet()` for equivalence resolution.
   Loads from disk.

### Implementation approach

The adapter is a thin initialisation layer that reads files from disk
and wires them into the existing interfaces. It does NOT create new
abstractions or service layers. Concretely:

- Read all YAML/JSON files in one pass at startup
- Build in-memory maps keyed by ID (same shape as FileRegistry's
  internal `Map<string, FileState>`)
- Provide accessor functions that the existing orchestration modules
  already accept as parameters

---

## Step 3: Signature computation (parameter files are load-bearing)

### What it does

For each fetchable edge, `computePlausibleSignaturesForEdge()`
computes all plausible `core_hash` values the edge might match in the
snapshot DB. This is not a single hash — it's an enumeration.

### The chain (same code browser and CLI will call)

1. **Load parameter file** via `edge.p.id`
   - Reads `paramValues[].sliceDSL` from stored values
   - Extracts distinct context dimension sets:
     `[]` (uncontexted), `["channel"]`, `["channel", "device"]`, etc.
   - Each set will produce a different signature

2. **Build query payload** via `buildDslFromEdge()`
   - Parses `edge.query` string: `"from(nodeA).to(nodeB)"`
   - Looks up nodes in graph → gets `node.event_id`
   - Loads event definition YAML for each referenced event
   - Returns: `{ queryPayload, eventDefinitions }`

3. **For each context key-set, compute signature** via
   `computeQuerySignature()`
   - Builds canonical JSON with: connection name, from/to event IDs,
     event definition hashes, case constraints, cohort_mode flag,
     normalised query string
   - Adds context definition hashes (hash of each context YAML file)
   - SHA-256 → truncate to 16 bytes → base64url → `core_hash`

4. **Compute hash closure** via `hashMappingsService.getClosureSet()`
   - Reads `hash-mappings.json`
   - BFS traversal of equivalence links from seed hash
   - Returns all reachable hashes (handles event/context renames)

### What the CLI adapter must provide

- Parameter files loaded from disk (Step 1)
- Event definitions loaded from disk (Step 1)
- Context definitions loaded from disk (Step 1)
- Connection definitions (FileSystemConnectionProvider)
- Hash mappings loaded from disk

All fed into the *same* `computePlausibleSignaturesForEdge()` function
the browser calls.

---

## Step 4: Fetch planning + coverage check

### What it does

`windowFetchPlannerService` / `fetchPlanBuilderService` determines
per-edge whether data for the requested DSL window is already
available or needs fetching from an external source.

The coverage check calls `calculateIncrementalFetch(paramValues,
window)` which examines parameter file values (time-series data
points) and compares against the requested date range. If dates are
missing, the item is classified as `needs_fetch`.

### Browser dependencies

**`fileState` accessor**: `buildFetchPlan()` takes a `fileState`
parameter — a function that looks up parameter file content. In the
browser this reads from FileRegistry/IDB. The CLI's disk adapter
(Step 1) provides the same accessor backed by files on disk.

**Snapshot inventory check**: `getBatchInventoryV2()` calls the Python
BE endpoint `/api/snapshots/inventory` via HTTP. Already Node-ready
(standard `fetch`). Queries the PostgreSQL snapshot DB for signature
family metadata.

**Connection checker**: `buildFetchPlan()` takes a `connectionChecker`
that validates whether a named connection has credentials. For
cache-only mode, the CLI can return true unconditionally. For external
fetch mode, it checks env-var credentials.

### Cache-only semantics

No `cacheOnly` flag exists today. The simplest approach: let the
planner run normally and produce its full plan including `needs_fetch`
items. The CLI orchestrator then skips execution of any item requiring
an external source call, unless `--allow-external-fetch` is set.
Edges with no cached data appear in the output as gaps with diagnostic
information (which signatures were looked up, what was missing).

This avoids forking the planner logic.

---

## Step 5: Snapshot retrieval from Python BE cache

### What it does

When the planner determines data exists in cache, the retrieval path
reads from the Python BE's PostgreSQL snapshot DB. Three endpoints:

| Endpoint | Purpose | External calls? |
|----------|---------|-----------------|
| `/api/snapshots/inventory` | What hashes/slices exist | None — pure DB read |
| `/api/snapshots/query-virtual` | Snapshot rows as-of a timestamp | None — pure DB read |
| `/api/snapshots/retrievals` | When were snapshots last fetched | None — pure DB read |

### Browser dependencies: none

These are HTTP calls via standard `fetch()` in
`snapshotWriteService.ts`. Work in Node 18+. The only browser coupling
is `pythonApiBase.ts` for URL resolution (addressed in Phase 0).

### Data shape coming back

Snapshot rows contain per-anchor-day: `A` (entrants), `X` (from-step
count / n), `Y` (to-step count / k), `median_lag_days`,
`mean_lag_days`, `onset_delta_days`. These map to the evidence fields
in `ProbabilityParam`.

---

## Step 7: Statistical enhancement (Python BE compute)

### What it does

`statisticalEnhancementService` takes raw aggregated data (n, k, mean,
stdev, raw time-series) and calls the Python BE endpoint
`/api/stats-enhance` for Bayesian posterior computation, confidence
intervals, completeness-weighted blending, and lag t95 estimation.

### Browser dependencies: none

Pure data-in/data-out client. Takes `RawAggregation` (assembled from
cached data in Step 6) and sends to the Python BE via
`graphComputeClient.enhanceStats()`. Standard `fetch`, no browser
APIs.

### Cache-only consideration

Statistical enhancement does NOT fetch from external sources. It
computes over data that's already been fetched. Even in cache-only
mode this step runs normally — it's a compute call, not a data
retrieval call.

---

## Phase 0: Guard existing modules (prerequisite)

No-behaviour-change refactors. Browser behaviour stays identical;
modules stop throwing in Node. These guards benefit both browser and
CLI — they make the modules environment-agnostic.

### `pythonApiBase.ts`

Currently: `window.location.hostname` for dev API discovery.
Guard: `typeof window === 'undefined'` → fall back to
`process.env.PYTHON_API_URL || 'http://localhost:9000'`.
The env var `VITE_PYTHON_API_URL` already exists as an override.

### `contextRegistry.ts`

Currently: falls back to IDB query when context not in memory.
Addition: `preloadContexts(contexts: Map<string, ContextDefinition>)`
method that populates the in-memory cache. CLI calls this after
loading context YAML from disk. The IDB fallback is never reached
because everything is pre-loaded. Browser path unchanged.

### `graphComputeClient.ts`

Currently: reads `window.location.search` for optional debug flags
(`?test_fixture=`, cache-busting). Also `window.__dagnetComputeNoCache`.
Guard: `typeof window !== 'undefined'` around these reads. Dev-only
convenience features; in Node they're simply absent.

---

## Phase 1: Disk I/O adapter

As described in Step 1. Reads the data repo directory structure,
parses YAML/JSON, provides the same accessor interfaces the
orchestration modules already accept. Uses existing
`FileSystemConnectionProvider` for connections.

Key deliverable: the adapter must satisfy the `fileState`,
`eventLoader`, and `contextRegistry` interfaces such that the
downstream modules (signature computation, fetch planning, etc.)
can't tell they're not running in a browser.

---

## Phase 2: CLI entry point (param-pack command)

Wires Phase 0 guards + Phase 1 adapter + existing orchestration:

1. Parse CLI args: `--graph <dir>`, `--query <dsl>`,
   `--format yaml|json|csv`, `--allow-external-fetch`
2. Call disk adapter (Phase 1) to load
   `{ graph, events, contexts, parameters, connections, hashMappings }`
3. Populate `contextRegistry` via `preloadContexts()`
4. Set `pythonApiBase` URL from env
5. Parse the query DSL — `queryDSL.parseConstraints()`
6. Compute signatures — `computePlausibleSignaturesForEdge()` per edge
   (uses parameter files for key-set enumeration)
7. Build fetch plan — `buildFetchPlanProduction()` with `fileState`
   accessor backed by disk-loaded parameter files
8. For covered items: retrieve snapshot data from Python BE cache
   (skip `needs_fetch` items unless `--allow-external-fetch`)
9. Aggregate — `windowAggregationService`
10. Enhance — `statisticalEnhancementService` (Python BE compute)
11. Populate graph edges with results
12. Extract — `GraphParamExtractor.extractParamsFromGraph()`
13. Flatten — `ParamPackDSLService.flattenParams()`
14. Serialise — `toYAML()` / `toJSON()` / `toCSV()`
15. Write to stdout

### Error reporting for cache gaps

When running cache-only and some edges have no cached data, report:
- Which edges are missing
- What signatures were computed and looked up
- What context key-sets were enumerated from parameter files
- Enough for the user to know they need to run a fetch first

---

## Later phases

### Phase 3: Named parameter queries

Support "for edge A→B, what is the forecasted number of conversions"
by resolving named parameters to their underlying DSL expressions.

### Phase 4: Batch and scripting

Multiple queries, multiple graphs, structured output, CI/CD
integration.

### Phase 5: CLI-driven fetch

`dagnet-cli fetch --graph <dir> --query <dsl>` — actually calls
external sources (Amplitude etc.) to populate the snapshot DB. This is
retrieveAll-equivalent but from the CLI rather than the browser.

---

## Open questions

1. ~~**Package boundary**~~: **Resolved.** Implementation in
   `graph-editor/src/cli/` (shares tsconfig/deps), entry-point
   wrapper in `graph-ops/scripts/`, docs in `graph-ops/playbooks/`.

2. **Graph loading format**: Do we load from the data repo's YAML
   structure directly, or from an exported bundle? Direct YAML is
   simpler and is the obvious first target.

3. **Auth for production BE**: Local dev uses `localhost:9000`. If
   the CLI targets a deployed BE instance, credentials and auth need
   handling. Env vars are probably sufficient.

4. **Parameter file freshness**: Parameter files on disk may be stale
   (last written by a browser fetch days ago). The CLI should probably
   warn if parameter file timestamps are old relative to the requested
   window, but still proceed — stale data is better than no data in
   cache-only mode.

5. **Completeness of cache**: If the user has never fetched data for
   a given context/window combination, the snapshot DB will be empty.
   How aggressively should the CLI warn vs just returning partial
   results?

## Build, runtime, and directory layout

**Decision (8-Apr-26)**: Use `tsx` as the CLI runner. No separate
build step. `tsx` handles TypeScript + ESM + path aliases with zero
config.

If Vite-specific constructs (`import.meta.env`, path aliases in
`tsconfig`) cause issues under `tsx`, we fix them as they surface
rather than pre-emptively building infrastructure.

### Directory split

The CLI has two homes:

| Location | Contents | Why |
|----------|----------|-----|
| `graph-editor/src/cli/` | Adapter code + orchestration wiring (disk loader, param-pack command logic) | Lives alongside the modules it imports. Shares tsconfig, node_modules, path aliases. No cross-directory import gymnastics. |
| `graph-ops/scripts/` | Thin entry-point wrapper script(s) | Operational interface — consistent with existing graph-ops tooling (validate-graph.sh, status.sh, etc.). Invokes `tsx` against `graph-editor/src/cli/`. |

The entry script in `graph-ops/scripts/` does:
```
cd graph-editor && npx tsx src/cli/param-pack.ts "$@"
```

Documentation lives in:
- `graph-ops/playbooks/` — a playbook for CLI usage (how to run,
  examples, prerequisites)
- `docs/current/project-cli/programme.md` — this file (architecture,
  decisions, phases)

## Progress log

### 8-Apr-26: Phase 0–2 initial implementation

**Done**:
- Phase 0 guards: `pythonApiBase.ts` (Node URL fallback),
  `contextRegistry.ts` (`preloadContexts()`), `graphComputeClient.ts`
  (`getUrlSearchParams()` helper), plus `import.meta.env?.` guards on
  5 module-scope references (`snapshotWriteService`, `graphComputeClient`,
  `signatureLinksApi`, `sheetsClient`, `version.ts`).
- Phase 1 disk adapter: `graph-editor/src/cli/diskLoader.ts` — loads
  graph JSON + events/contexts/parameters/cases YAML + connections +
  hash-mappings from data repo, seeds `fileRegistry` and
  `contextRegistry`.
- `FileRegistry.seedFileInMemory()` added to `TabContext.tsx` — populates
  the in-memory Map without touching IDB or listeners.
- Phase 2 entry point: `graph-editor/src/cli/param-pack.ts` — loads
  graph, extracts params from graph-as-saved, serialises to
  YAML/JSON/CSV on stdout.
- `graph-ops/scripts/param-pack.sh` wrapper script.
- `fake-indexeddb/auto` used to satisfy Dexie import chain in Node.

**Smoke-tested** against real data repo graph (`gm-rebuild-jan-26`):
- Loads 232 events, 12 contexts, 455 parameters, 9 nodes, 8 edges.
- Extracts and serialises param pack (8 edges with probabilities,
  evidence, forecast, latency).
- Signature computation (`computePlausibleSignaturesForEdge`) works in
  Node for edges with parameter files.

**What's extracted currently**: graph-as-saved data (whatever the last
browser session wrote to the graph JSON). This gives values reflecting
the last fetch, not re-evaluated against the `--query` DSL.

### 8-Apr-26: Full pipeline wired (aggregation + LAG topo pass)

**Done**:
- `graph-editor/src/cli/aggregate.ts` — CLI-specific aggregation that
  calls the same pure functions the browser uses without pulling in
  `react-hot-toast` or other browser-only deps.
- Reads `n_daily`, `k_daily`, `dates` arrays from parameter files,
  filters to the requested window, computes evidence scalars (n, k,
  mean, stdev).
- Runs `enhanceGraphLatencies()` — the full LAG topological pass —
  with `aggregateWindowData`, `aggregateCohortData`, and
  `aggregateLatencyStats` from `windowAggregationService` as helpers.
- LAG pass computes: t95, path_t95 (cumulative), completeness
  (CDF-based), blended p.mean (completeness-weighted evidence +
  forecast), median_lag_days, mean_lag_days.
- Additional `import.meta.env?.` guards on 5 module-scope references.

**Smoke-tested** against `gm-rebuild-jan-26` with
`window(1-Dec-25:20-Dec-25)`:
- Evidence re-aggregated for the 20-day window (n=43683 for first
  edge, vs 351482 for full historical range).
- LAG pass: 2 latency-enabled edges processed, completeness ~1.0,
  path_t95 correctly cumulative (16.62 → 28.57).
- Blended p.mean computed via canonical blend formula.
- Output as YAML/JSON/CSV to stdout with diagnostics to stderr.

### 8-Apr-26: Generalisation, console suppression, --get

**Done**:
- Refactored into shared infrastructure (`bootstrap.ts`) and a
  `commands/` directory. Adding a new command (e.g. `analyze`) requires
  only a command module, a 3-line entry point, and a wrapper script.
- Console suppression: `console.log`/`console.warn` muted by default
  (silences LAG debug, ShareBootResolver, AppDatabase init, etc.).
  `--verbose` restores all output. `--session-log` surfaces session
  log entries.
- `--get <key>` flag: extracts a single scalar value as a bare number
  to stdout. On bad key, lists available keys for the referenced
  edge/node and exits 1.
- Deleted superseded `paramPackMain.ts`.

**Documentation**:
- `docs/current/codebase/GRAPH_OPS_TOOLING.md` updated with CLI tools
  section.
- `graph-ops/playbooks/cli-param-pack.md` created — usage guide with
  examples, options, key reference, troubleshooting.

### 8-Apr-26: Tests, caching, analyse command, multi-scenario

**Done**:
- 23 integration tests (`cliParamPack.test.ts`) with stable fixtures:
  hand-computed expected values, zero mocks. Covers disk loading,
  full/sub-window aggregation, out-of-range window, serialisation
  formats, scalar extraction.
- Disk bundle cache at `~/.cache/dagnet-cli/`, fingerprinted by
  source file mtimes. `--no-cache` to bypass.
- `analyse` command: calls Python BE `/api/runner/analyze`, returns
  analysis result JSON/YAML. Supports `--type`, `--get` dot-path
  extraction.
- Multi-scenario support: `--scenario` flag (repeatable). Each
  scenario gets independent aggregation. Last scenario = Current
  in FE terms, earlier ones are stacked scenarios in order.
- `--subject` flag for analysis subject DSL (`from(x).to(y)`),
  shared across scenarios. Single-scenario can embed subject in
  the DSL string instead (`"from(x).to(y).window(-30d:)"`).
- Scenario spec parsing: `"name=Before,colour=#ff0000,<dsl>"` with
  comma-splitting that respects parentheses.
- UK spelling: `analyse.ts`, `analyse.sh`.

**FE equivalence contract**: Each CLI scenario is equivalent to a
fresh live scenario in the FE with its own query DSL and no what-if
overlays. No composition or stacking — each aggregates independently
from the clean graph. Fully reproducible in the FE.

### 8-Apr-26: One-codepath refactor + E2E parity test

**Critical refactor**: `aggregate.ts` was rewritten from a 280-line
parallel reimplementation to a thin wrapper calling
`fetchDataService.fetchItems({ mode: 'from-file' })` — the same
function the browser uses. The old version missed fields like
`scope_from/to` and computed evidence differently from the FE.

**`analyse` command** now calls `prepareAnalysisComputeInputs` →
`runPreparedAnalysis` — the real FE preparation + dispatch path
including snapshot subject resolution, display settings, and
posterior re-projection. CLI scenarios are injected into live mode
by building a `scenariosContext` with extracted params.

**`import.meta.env` guards**: `?.` optional chaining added to
`graphComputeClient.ts` (5 occurrences), `snapshotBootTrace.ts`
(4 occurrences), `fetchDataService.ts` (2 occurrences), plus
`getUrlSearchParams()` helper replacing bare `window.location.search`.
Entry points polyfill `import.meta.env = { DEV: false }` via
`cliEntry.ts`.

**E2E parity test** (`e2e/cliParityGraphOverview.spec.ts`):
Playwright loads real graph + 455 parameter files from data repo
into IDB, boots the app, sets target DSL via graphStore, triggers
`dagnetDebug.refetchFromFiles()` to run the from-file pipeline,
then calls the BE directly with the FE's graph state. CLI runs
separately against the same data repo + DSL. Field-by-field
comparison of all probability values — all must match within 1e-6.

**Discovery**: `db.files.put()` in e2e seeds does not populate
FileRegistry — only IDB. The from-file pipeline needs FileRegistry
populated, which happens lazily via `restoreFile()`. Using
`dagnetDebug.refetchFromFiles()` triggers the full from-file pipeline
correctly.

**Remaining for full parity with browser**:
- Context-based slice filtering (`context(channel:google)` in DSL —
  currently uses all values in the correct mode, not filtered by
  context).
- Snapshot DB retrieval path (for when param files on disk are stale
  and fresh data is needed from the PostgreSQL cache).

## Dependencies

- Python BE must be running (locally or remote) — the CLI is a
  client, not a standalone compute engine
- Node 18+ for native `fetch()` support
- `tsx` for running TypeScript directly in Node
- `fake-indexeddb` (devDependency) for Dexie/IDB shim in Node
- Graph data available on disk (data repo clone) including parameter
  files — these are required for signature computation
- Snapshot DB populated by prior browser fetches or retrieveAll runs
  (for cache-only mode)
