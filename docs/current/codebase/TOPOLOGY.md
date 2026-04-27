# DagNet Topology

The 60-second orient. Read this first. It exists to give you a mental model before you dive into any single subsystem.

For task-specific routing, see [TASK_TYPE_READING_GUIDE.md](TASK_TYPE_READING_GUIDE.md).
For invariants the system relies on, see [INVARIANTS.md](INVARIANTS.md).
For acronyms, see [GLOSSARY.md](GLOSSARY.md).
For concept-level introduction, see [DOMAIN_PRIMER.md](DOMAIN_PRIMER.md).

---

## What DagNet is

A browser-based graph editor for conversion-funnel modelling, paired with a Python backend for analysis and Bayesian inference.

Users build DAGs of user states (signed up → activated → purchased), connect edges to live data (Amplitude, Sheets), and the app answers "what's the probability of this path?" with proper handling of latency, censoring, and uncertainty.

DagNet is **git-native**: graphs and parameters are YAML/JSON in a GitHub repo. Git is persistence, collaboration, and audit trail.

---

## The five layers

```
┌─────────────────────────────────────────────────────────────────┐
│  Persistence                                                    │
│   Git (GitHub) ── Snapshot DB (Neon) ── IDB (browser)           │
└─────────────────────────────────────────────────────────────────┘
                               │
┌─────────────────────────────────────────────────────────────────┐
│  In-memory state (FE)                                           │
│   FileRegistry → GraphStore → ReactFlow                         │
└─────────────────────────────────────────────────────────────────┘
                               │
┌─────────────────────────────────────────────────────────────────┐
│  Mutation                                                       │
│   UpdateManager + graphMutationService                          │
└─────────────────────────────────────────────────────────────────┘
                               │
┌─────────────────────────────────────────────────────────────────┐
│  Compute                                                        │
│   Stage 1 fetch ── Stage 2 (FE topo ⫝⫝ CF race, 500ms deadline) │
│   Bayes compiler (offline, async webhook)                       │
│   Forecast engine + analysis runners (per query)                │
│   MSMDC (query generation)                                      │
└─────────────────────────────────────────────────────────────────┘
                               │
┌─────────────────────────────────────────────────────────────────┐
│  Render                                                         │
│   Analysis runners → ECharts builders → Canvas                  │
└─────────────────────────────────────────────────────────────────┘
```

Cross-cutting infrastructure:
- **Hash/signature** — content-addresses queries so caches survive edits, branches, and definition changes. Threads through every subsystem.
- **DSL** — what users write to describe what they want. Threads through every subsystem.
- **Session log + scheduler + integrity check** — observability and automation.

---

## The 14 subsystems (one paragraph each)

### 1. Persistence

**Git** is source of truth for files. **Snapshot DB** (Postgres/Neon) is source of truth for time-series evidence — multi-day cohort observations that need SQL aggregation. **IDB** is the browser's session-local copy of file content + dirty state. Always use `db.getDirtyFiles()` for git ops, never `fileRegistry.getDirtyFiles()`.
Docs: [GIT_OPERATIONS_ARCHITECTURE.md](GIT_OPERATIONS_ARCHITECTURE.md), [SNAPSHOT_DB_ARCHITECTURE.md](SNAPSHOT_DB_ARCHITECTURE.md), [INDEXEDDB_PERSISTENCE_LAYER.md](INDEXEDDB_PERSISTENCE_LAYER.md).

### 2. In-memory state

**FileRegistry** is an in-memory cache layered over IDB. **GraphStore** (Zustand) holds parsed graph state per file, shared across tabs viewing the same file. **ReactFlow** is the visual presentation layer. Sync flows bidirectionally with guards to prevent loops; the 4-layer model (param file → graph edge → stashed slices → React) is the most common cause of "the value keeps coming back" bugs.
Docs: [FILE_REGISTRY_LIFECYCLE.md](FILE_REGISTRY_LIFECYCLE.md), [STATE_MANAGEMENT_REFERENCE.md](STATE_MANAGEMENT_REFERENCE.md), [SYNC_SYSTEM_OVERVIEW.md](SYNC_SYSTEM_OVERVIEW.md).

### 3. Mutation

**UpdateManager** is the centralised service for all data transformations between domains (graph↔file↔external) across 5 directions × 4 operations × ~18 mappings. Override flags (`field_overridden`) prevent overwriting user edits. **graphMutationService** detects topology changes and triggers MSMDC query regeneration via the Python API.
Docs: [GRAPH_MUTATION_UPDATE_MANAGER.md](GRAPH_MUTATION_UPDATE_MANAGER.md).

### 4. Sync engine

The 4-layer state propagation model plus bidirectional sync guards that prevent loops. `isSyncingRef`, `suppressFileToStoreUntilRef` (500ms blanket), `writtenStoreContentsRef` (content→revision map for stale-echo rejection) are the load-bearing refs. ReactFlow's controlled mode has its own pitfalls — functions in `node.data` are unreliable; use module-level singletons via `syncGuards.ts`.
Docs: [SYNC_SYSTEM_OVERVIEW.md](SYNC_SYSTEM_OVERVIEW.md), [GRAPH_WRITE_SYNC_ARCHITECTURE.md](GRAPH_WRITE_SYNC_ARCHITECTURE.md), [SYNC_ENGINE_GUARD_STATE_MACHINE.md](SYNC_ENGINE_GUARD_STATE_MACHINE.md), [REACTFLOW_CONTROLLED_MODE.md](REACTFLOW_CONTROLLED_MODE.md).

### 5. DSL

`queryDSL.ts` parses atomic constraint expressions; `dslExplosion.ts` expands compound expressions (semicolon, `or()`, parenthetical distribution) into atomic slices. The DSL serves three distinct purposes: topology filtering, conditional metadata, and data-retrieval query construction. `analytics_dsl` (subject, constant) and `effective_query_dsl` (temporal/context, varies per scenario) live separately on requests — don't conflate them.
Docs: [DSL_PARSING_ARCHITECTURE.md](DSL_PARSING_ARCHITECTURE.md), [DSL_SYNTAX_REFERENCE.md](DSL_SYNTAX_REFERENCE.md), [RESERVED_QUERY_TERMS_GLOSSARY.md](RESERVED_QUERY_TERMS_GLOSSARY.md).

### 6. Hash/signature

Five layers: `core_hash` (content-address), structured signatures (two-dimensional matching), hash mappings (rename resilience), hash-chain tracing (reachability), commit hash guard (detection at commit time). Same query semantics → same `core_hash`. Definition changes break hashes; equivalence links bridge the gap.
Docs: [HASH_SIGNATURE_INFRASTRUCTURE.md](HASH_SIGNATURE_INFRASTRUCTURE.md), [SNAPSHOT_DB_SIGNATURES.md](SNAPSHOT_DB_SIGNATURES.md).

### 7. Fetch pipeline

**Stage 1**: per-item fetch from external sources (Amplitude, Sheets). **Stage 2**: enrichment — FE topo pass synchronously + CF race against 500ms deadline. **Stage 3**: render. The pipeline is browser-orchestrated; the Python API is stateless. Window vs cohort modes have different staleness semantics.
Docs: [FETCH_PLANNING_PRINCIPLES.md](FETCH_PLANNING_PRINCIPLES.md), [FE_BE_STATS_PARALLELISM.md](FE_BE_STATS_PARALLELISM.md), [AUTOMATION_PIPELINE.md](AUTOMATION_PIPELINE.md).

### 8. Statistical enhancement (FE topo pass)

The TypeScript synchronous pass that runs during Stage 2 of every fetch. Two logical steps: (1) aggregate `model_vars[analytic]` on the source-ledger layer; (2) query-scoped current-answer surface (`p.mean`, `p.sd`, `completeness`, `completeness_stdev`). Path-level latency via Fenton-Wilkinson composition. Heuristic dispersion SDs when Bayes hasn't run.
Docs: [STATS_SUBSYSTEMS.md](STATS_SUBSYSTEMS.md) §3.2, [LAG_ANALYSIS_SUBSYSTEM.md](LAG_ANALYSIS_SUBSYSTEM.md), [STATISTICAL_DOMAIN_SUMMARY.md](STATISTICAL_DOMAIN_SUMMARY.md).

### 9. Conditioned forecast (BE CF pass)

The Python topologically-sequenced MC pass that races FE topo. Per-edge IS conditioning on query-DSL-scoped snapshot evidence. Whole-graph mode propagates upstream carriers via topological caching. CF supersedes FE blended `p.mean` and completeness when it lands. The cohort-mode rate-conditioning seam is `PreparedForecastRuntimeBundle.p_conditioning_evidence`.
Docs: [STATS_SUBSYSTEMS.md](STATS_SUBSYSTEMS.md) §3.3, [BE_RUNNER_CLUSTER.md](BE_RUNNER_CLUSTER.md), [FE_BE_STATS_PARALLELISM.md](FE_BE_STATS_PARALLELISM.md), [COHORT_ANALYSIS_NUMERATOR_DENOMINATOR_SEMANTICS.md](COHORT_ANALYSIS_NUMERATOR_DENOMINATOR_SEMANTICS.md).

### 10. Bayes compiler (offline)

MCMC inference fitting per-edge posteriors from a fixed training corpus. Two phases: window mode (independent edge fits) → cohort mode (path latency via Fenton-Wilkinson, posterior-as-prior). Hierarchical Dirichlet for branching nodes with context slices. Async webhook lands posteriors as a graph patch via `bayesPatchService`. Runs on Modal in production; locally via `bayes_local.py`.
Docs: [PYTHON_BACKEND_ARCHITECTURE.md](PYTHON_BACKEND_ARCHITECTURE.md) §Bayesian, [BAYES_REGRESSION_TOOLING.md](BAYES_REGRESSION_TOOLING.md), [STATISTICAL_DOMAIN_SUMMARY.md](STATISTICAL_DOMAIN_SUMMARY.md).

### 11. Analysis runners + chart pipeline

Per-query chart producers (path, funnel, `cohort_maturity`, `daily_conversions`, `surprise_gauge`, etc.). Some read graph state directly; others call the public CF surface; a few use in-band forecast kernels. ECharts builders (5,187 LOC) handle rendering, dispatched on `chart_kind` from a single function. Display planning lives in `chartDisplayPlanningService`.
Docs: [ANALYSIS_TYPES_CATALOGUE.md](ANALYSIS_TYPES_CATALOGUE.md), [BE_RUNNER_CLUSTER.md](BE_RUNNER_CLUSTER.md), [CHART_PIPELINE_ARCHITECTURE.md](CHART_PIPELINE_ARCHITECTURE.md), [ANALYSIS_ECHARTS_BUILDERS.md](ANALYSIS_ECHARTS_BUILDERS.md), [GRAPH_COMPUTE_CLIENT.md](GRAPH_COMPUTE_CLIENT.md).

### 12. Scenarios

Sparse parameter overlays for what-if analysis. **Live scenarios** tie to a query DSL and can regenerate from data. **Static scenarios** are frozen snapshots. Composition is deep-merge, ordered: Base → Scenario1 → Scenario2 → Current. Scenario edits trigger fan-out re-fetches across the visible stack — each visible live scenario gets its own Stage 2 pass.
Docs: [SCENARIO_SYSTEM_ARCHITECTURE.md](SCENARIO_SYSTEM_ARCHITECTURE.md), [WHAT_IF_ANALYSIS.md](WHAT_IF_ANALYSIS.md).

### 13. Snapshot DB

Time-series append-only store of cohort conversion observations. One row per `(param_id, core_hash, slice_key, anchor_day, retrieved_at)`. **Virtual snapshots** reconstruct "what we knew on date X" via latest-wins per `anchor_day`. **Context epochs** handle mixed-regime histories where the pinned DSL changed over time. Connection-pooled reads with 15-min TTL cache (`snapshot_service.py`).
Docs: [SNAPSHOT_DB_ARCHITECTURE.md](SNAPSHOT_DB_ARCHITECTURE.md), [SNAPSHOT_FIELD_SEMANTICS.md](SNAPSHOT_FIELD_SEMANTICS.md), [SNAPSHOT_DB_CONTEXT_EPOCHS.md](SNAPSHOT_DB_CONTEXT_EPOCHS.md), [snapshot-db-data-paths.md](snapshot-db-data-paths.md).

### 14. Workspace + git

Multi-tier credential precedence (URL → env → IDB → public). Atomic multi-file commits via Git Data API. 3-way merge with structural-JSON for graphs and text-line for YAML. Non-blocking pull with countdown UI. Live share fetches only the graph + dependency closure, not the full workspace; uses an isolated IDB scope per share.
Docs: [GIT_OPERATIONS_ARCHITECTURE.md](GIT_OPERATIONS_ARCHITECTURE.md), [MERGE_CONFLICT_RESOLUTION.md](MERGE_CONFLICT_RESOLUTION.md), [SHARE_AND_LIVE_SHARE.md](SHARE_AND_LIVE_SHARE.md), [CREDENTIALS_INIT_FLOW.md](CREDENTIALS_INIT_FLOW.md).

---

## Cross-cutting infrastructure

- **Session log** — hierarchical operation logging with display threshold; debug/trace stripped at `endOperation`. See [SESSION_LOG_ARCHITECTURE.md](SESSION_LOG_ARCHITECTURE.md).
- **Job scheduler** — unified system for automated/recurring work (version check, daily automation, integrity check). See [JOB_SCHEDULER.md](JOB_SCHEDULER.md).
- **Integrity check service** — 10-phase cross-workspace forensic validation. 4,177 LOC, the largest single FE service. See [INTEGRITY_CHECK_SERVICE.md](INTEGRITY_CHECK_SERVICE.md).
- **CLI** — headless Node entry point exercising the same FE functions as the browser. Long-lived daemon mode for test sessions. See [GRAPH_OPS_TOOLING.md](GRAPH_OPS_TOOLING.md).
- **Hooks** — 93 React hooks (20.7k LOC). See [HOOKS_INVENTORY.md](HOOKS_INVENTORY.md).
- **UI / dock** — two-level rc-dock (app-level + per-graph). See [UI_COMPONENT_MAP.md](UI_COMPONENT_MAP.md), [SIDEBAR_AND_PANELS_ARCHITECTURE.md](SIDEBAR_AND_PANELS_ARCHITECTURE.md).

---

## Where complexity actually lives

The dominant complexity is at **subsystem seams**, not within individual subsystems:

| Seam | Where to read |
|---|---|
| forecast ↔ snapshot | [STATS_SUBSYSTEMS.md](STATS_SUBSYSTEMS.md) |
| snapshot ↔ generalisation | [SNAPSHOT_DB_CONTEXT_EPOCHS.md](SNAPSHOT_DB_CONTEXT_EPOCHS.md), `candidateRegimeService` |
| signature ↔ cache | [HASH_SIGNATURE_INFRASTRUCTURE.md](HASH_SIGNATURE_INFRASTRUCTURE.md) |
| scenario round-trip ↔ git | [SCENARIO_SYSTEM_ARCHITECTURE.md](SCENARIO_SYSTEM_ARCHITECTURE.md) |
| store ↔ file ↔ ReactFlow | [SYNC_SYSTEM_OVERVIEW.md](SYNC_SYSTEM_OVERVIEW.md) |
| FE↔BE stats parallelism | [FE_BE_STATS_PARALLELISM.md](FE_BE_STATS_PARALLELISM.md) |

When debugging, trace seams first.

---

## Reading order for a cold agent

1. [DOMAIN_PRIMER.md](DOMAIN_PRIMER.md) — what this software does + 3 load-bearing concepts.
2. [TOPOLOGY.md](TOPOLOGY.md) — this file.
3. [GLOSSARY.md](GLOSSARY.md) — pin while reading.
4. [TOUR_PROBABILITY_EDIT.md](TOUR_PROBABILITY_EDIT.md) — concrete trace through the layers.
5. **Warm-start required reads** — [SYNC_SYSTEM_OVERVIEW.md](SYNC_SYSTEM_OVERVIEW.md), [RESERVED_QUERY_TERMS_GLOSSARY.md](RESERVED_QUERY_TERMS_GLOSSARY.md), [DEV_ENVIRONMENT_AND_HMR.md](DEV_ENVIRONMENT_AND_HMR.md).
6. [TASK_TYPE_READING_GUIDE.md](TASK_TYPE_READING_GUIDE.md) — when you have a specific task in hand.
7. [INVARIANTS.md](INVARIANTS.md) — must-be-true rules; consult while making changes.

---

## Volume of code (rough orientation)

- **`graph-editor/lib/runner/`** (BE) — 18,481 LOC, the biggest subsystem cluster.
- **`graph-editor/lib/api_handlers.py`** — 5,275 LOC; the BE dispatch monolith.
- **`bayes/`** — 36,113 LOC (compiler, worker, regression harness, synth gen, tracker).
- **`graph-editor/src/services/`** — ~108k LOC across 102 services + 250 tests.
- **`graph-editor/src/hooks/`** — 20.7k LOC across 93 hooks.
- **`graph-editor/src/components/`** — 137 components; the heavy hitters: `ConversionEdge` (3k), `GraphCanvas` (2.9k), `GraphEditor` (2.6k), `PropertiesPanel` (4k).

Read by **cluster**, not by file. The fetch cluster, forecasting cluster, Bayes tree, snapshot DB, signature cluster, and sync engine each have their own internal logic; the **seams between them are where the bugs live**.
