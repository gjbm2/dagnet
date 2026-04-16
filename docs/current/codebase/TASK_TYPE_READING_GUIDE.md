# Task-Type Reading Guide

Identify your task type below, then read the listed docs **before writing any code**. Docs marked **(full)** must be read completely; **(skim)** means read the overview sections and consult detail sections as needed; **(ref)** means look up specific entries only when you hit a relevant term or mechanism.

All docs are in `docs/current/codebase/` unless a full path is given.

## Fixing a state/sync/dirty-tracking bug
- DIAGNOSTIC_PLAYBOOKS.md **(full — find matching symptom)** — structured checklists by symptom type
- KNOWN_ANTI_PATTERNS.md **(skim)** — check if your bug matches a previously-seen pattern
- SYNC_SYSTEM_OVERVIEW.md **(full)** — the 4-layer propagation model, all sync flows, known races
- GRAPH_WRITE_SYNC_ARCHITECTURE.md **(full)** — store↔file sync detail, suppression windows
- INDEXEDDB_PERSISTENCE_LAYER.md **(skim)** — prefix contract, dual-storage invariant
- FILE_REGISTRY_LIFECYCLE.md **(skim)** — dirty detection, initialisation phase
- SYNC_ENGINE_GUARD_STATE_MACHINE.md **(ref)** — look up specific guard refs when you encounter them

## Modifying git operations (pull/push/commit/clone)
- GIT_OPERATIONS_ARCHITECTURE.md **(full)** — service layering, atomic commit, credentials
- INDEXEDDB_PERSISTENCE_LAYER.md **(skim)** — workspace prefix contract
- MERGE_CONFLICT_RESOLUTION.md **(full if touching merge)** — 3-way merge, conflict UI

## Modifying graph structure, node IDs, or queries
- GRAPH_MUTATION_UPDATE_MANAGER.md **(full)** — edit propagation, node ID renaming, override flags
- DSL_PARSING_ARCHITECTURE.md **(skim)** — queryDSL.ts as single source of truth
- DATA_RETRIEVAL_QUERIES.md **(skim)** — three purposes of query DSL strings
- FETCH_PLANNING_PRINCIPLES.md **(ref)** — fill missing + refresh stale contract

## Adding or modifying analysis types / charts / canvas analyses
- adding-analysis-types.md **(full)** — checklist
- CHART_PIPELINE_ARCHITECTURE.md **(full)** — recipes, hydration, compute, display planning
- CANVAS_ANALYSIS_FEATURE.md **(full if touching canvas)** — container+content, three-mode scenarios
- ANALYSIS_RETURN_SCHEMA.md **(ref)** — result schema contract

## Modifying scenarios, what-if, or parameter overlays
- SCENARIO_SYSTEM_ARCHITECTURE.md **(full)** — composition, regeneration, provenance
- WHAT_IF_ANALYSIS.md **(full if touching what-if)** — override types, DSL, effective probability

## Modifying parameters, param packs, or model variables
- PARAMETER_SYSTEM.md **(full)** — data model, extraction, model variable resolution
- FE_BE_STATS_PARALLELISM.md **(skim)** — analytic vs analytic_be entries, transition plan

## Modifying statistical/Bayesian/forecasting logic
- FE_BE_STATS_PARALLELISM.md **(full)** — why both FE and BE run the topo pass, parity comparison
- STATISTICAL_DOMAIN_SUMMARY.md **(full)** — statistical architecture, data pipeline
- PROBABILITY_BLENDING.md **(skim)** — blending cohort-mode latency edge probabilities
- `docs/current/project-bayes/32-posterior-predictive-scoring-design.md` **(ref if touching LOO/ELPD)** — per-edge model adequacy scoring, analytic null comparison
- `docs/current/project-bayes/34-latency-dispersion-background.md` **(ref if touching latency dispersion / kappa_lat)** — per-interval BetaBinomial timing overdispersion
- BAYES_REGRESSION_TOOLING.md **(ref if running regression / modifying devtools)** — multi-layered audit, `--clean`, `--feature`, parallel safety

## Modifying snapshot DB, signatures, or hash infrastructure
- SNAPSHOT_DB_ARCHITECTURE.md **(full)** — data model and objectives
- SNAPSHOT_FIELD_SEMANTICS.md **(full)** — field meanings by slice_key type
- HASH_SIGNATURE_INFRASTRUCTURE.md **(full)** — core hash, matching, mappings, chain tracing
- SNAPSHOT_DB_SIGNATURES.md **(skim)** — flexible signature matching
- SNAPSHOT_DB_CONTEXT_EPOCHS.md **(ref)** — context epochs
- snapshot-db-data-paths.md **(ref)** — data flow through snapshots table

## Modifying lag analysis, horizons, or projections
- LAG_ANALYSIS_SUBSYSTEM.md **(full)** — lag fit, horizons, mixture aggregation
- PROJECTION_MODE.md **(full if touching projection)** — convolution computation
- DATE_MODEL_COHORT_MATURITY.md **(skim)** — canonical date concepts

## Modifying data fetching, retrieve-all, or slice planning
- SLICE_PLANNING_RETRIEVAL.md **(full)** — retrieve-all planning and execution
- CONTEXT_SYSTEM.md **(skim)** — context registration, MECE aggregation
- DATA_DEPTH_SCORING.md **(ref)** — coverage scoring
- HASH_SIGNATURE_INFRASTRUCTURE.md **(skim — regime selection section)** — when multiple context dimensions produce multiple hashes, the BE must select one per date
- `docs/current/project-bayes/30-snapshot-regime-selection-contract.md` **(ref if touching snapshot aggregation)** — regime selection contract and `mece_dimensions`

## Modifying automation, scheduling, or staleness
- AUTOMATION_PIPELINE.md **(full)** — daily fetch, retrieve-all automation, run logging
- JOB_SCHEDULER.md **(skim)** — unified system for recurring work
- STALENESS_AND_AUTO_UPDATE.md **(skim)** — nudges, auto-update policy
- `docs/current/project-bayes/archive/28-bayes-run-reconnect-design.md` **(skim if touching Bayes automation)** — 3-phase pipeline (Phase 0 patch apply, Phase 1 fetch+commission, Phase 2 drain), `runBayes` flag, reconnect mechanism. Essential knowledge also in `PYTHON_BACKEND_ARCHITECTURE.md` §Automation.

## Modifying share links, live share, or bundles
- SHARE_AND_LIVE_SHARE.md **(full)** — static/live shares, boot/hydration/sync
- URL_PARAMS.md **(ref)** — supported URL parameters

## Modifying UI components, panels, context menus, modals, or display states
- UI_COMPONENT_MAP.md **(full)** — visual hierarchy, all 11 context menus, 21 modals, display state decision tree
- CANVAS_OBJECT_DISPLAY_STATES.md **(full if touching minimise/collapse)** — canvas analysis/post-it minimise, position offsets, canvas view integration
- SIDEBAR_AND_PANELS_ARCHITECTURE.md **(full if touching sidebar)** — rc-dock, panel persistence, sidebar state

## Modifying ReactFlow canvas, edge rendering, or layout
- REACTFLOW_CONTROLLED_MODE.md **(full)** — controlled mode pitfalls and reliable patterns
- CANVAS_RENDERING_ARCHITECTURE.md **(skim)** — z-index model, transform pipeline
- CANVAS_OBJECT_DISPLAY_STATES.md **(skim)** — minimise/restore mechanics if touching canvas objects
- EDGE_RENDERING_PERF_ROOT_CAUSE.md **(ref)** — beads/chevrons performance
- BEAD_DISPLAY_MODE.md **(full if touching bead values/formatting)** — BeadDisplayMode enum, data values, path view, inbound-n topo walk, anchor resolution, latency bead gate

## Running CLI tools (analyse, param-pack, hydrate, parity, validation)
- `GRAPH_OPS_TOOLING.md` **(full — start with Quick Reference)** — all CLI scripts, options, architecture, invariants
- `graph-ops/playbooks/cli-analyse.md` **(full if running analyse)** — scenarios, subject, topo-pass, troubleshooting
- `graph-ops/playbooks/cli-param-pack.md` **(full if running param-pack)** — query DSL, output formats, --get
- `graph-ops/reference/common-pitfalls.md` **(skim)** — known pitfalls that affect CLI output
- `DSL_SYNTAX_REFERENCE.md` **(ref)** — query DSL grammar for constructing CLI arguments

**Prerequisites (check before running anything)**:
- Node 22 via nvm: `export NVM_DIR="$HOME/.nvm" && . "$NVM_DIR/nvm.sh" && cd graph-editor && nvm use "$(cat .nvmrc)"`
- Python BE running for `analyse.sh`, `hydrate.sh`, `bayes.sh`: `cd graph-editor && . venv/bin/activate && python dev-server.py`
- Data repo present (path in `.private-repos.conf`)

## Creating, editing, or validating conversion graphs (in data repo)
- `graph-ops/playbooks/` **(full — pick the relevant playbook)** — tested procedures for graph work
- `graph-ops/reference/data-model.md` **(skim)** — complete data model reference
- `graph-ops/reference/common-pitfalls.md` **(full)** — known pitfalls
- HASH_SIGNATURE_INFRASTRUCTURE.md **(skim if renaming events/contexts)** — hash mapping workflow

## Modifying FormEditor, Monaco, RJSF widgets, or UI schemas
- FORM_EDITOR_AND_MONACO.md **(full)** — dynamic form system, custom widgets, UI schema patterns, Monaco integration points

## Modifying schemas, types, or adding new fields
- SCHEMA_AND_TYPE_PARITY.md **(full)** — all schema locations, parity pairs, drift tests, new-field checklist
- FORM_EDITOR_AND_MONACO.md **(skim — UI schema section)** — UI schema must stay in sync with data schema
- GRAPH_MUTATION_UPDATE_MANAGER.md **(skim)** — override patterns, node reference fields
- PARAMETER_SYSTEM.md **(skim if touching param schemas)** — param schema role

## Modifying devtools, monitors, regression scripts, or diagnostic infrastructure
- DEVTOOL_ENGINEERING_PRINCIPLES.md **(full)** — data vs display separation, no silent deletion, output visibility, audit checklist
- BAYES_REGRESSION_TOOLING.md **(full)** — regression pipeline, stall detection, truth file timeouts, winning formula defaults
- KNOWN_ANTI_PATTERNS.md **(ref — anti-patterns 37-38)** — devtool data deletion incidents

## Modifying Python backend, MSMDC, or compute server
- PYTHON_BACKEND_ARCHITECTURE.md **(full)** — FastAPI endpoints, MSMDC, Bayes, FE-BE communication

## Other subsystem docs (consult when relevant)
- `DIAGNOSTIC_PLAYBOOKS.md` — symptom → checklist for common bugs
- `KNOWN_ANTI_PATTERNS.md` — failure patterns with known fixes
- `DSL_SYNTAX_REFERENCE.md` — full DSL grammar, all 14 functions, composition rules, examples
- `ANALYSIS_TYPES_CATALOGUE.md` — what each analysis type computes, inputs, outputs, chart kinds
- `DATA_SOURCES_REFERENCE.md` — external data sources, credential types, schema file catalogue
- `SCHEMA_AND_TYPE_PARITY.md` — schema locations, parity pairs, drift tests
- `UI_COMPONENT_MAP.md` — visual hierarchy, context menus, modals, display state patterns
- `CANVAS_OBJECT_DISPLAY_STATES.md` — canvas analysis/post-it minimise, container states
- `SIDEBAR_AND_PANELS_ARCHITECTURE.md` — nested rc-dock, panel persistence
- `CREDENTIALS_INIT_FLOW.md` — three-tier credentials, initialisation
- `IMAGE_HANDLING.md` — upload, compression, blob URL serving
- `APP_ARCHITECTURE.md` — browser-based graph editor overview
- `COMPLEXITY_ANALYSIS.md` — most complex aspects of DagNet
- `COMPETITIVE_ANALYSIS.md` — competitive landscape
- `cohort-maturity-forecast-design.md` — cohort maturity forecast chart
- `surprise-gauge-design.md` — surprise analysis type
- `BAYESIAN_ENGINE_RESEARCH.md` — Bayesian tool research
- `SESSION_LOG_ARCHITECTURE.md` — session log levels, thresholds, viewer, endOperation cleanup
- `DEV_LOG_STREAMING.md` — three JSONL log streams
- `GRAPH_OPS_TOOLING.md` — **full CLI reference**: all graph-ops scripts (analyse, param-pack, hydrate, validate, parity), options, architecture, key invariants
- `INTEGRITY_CHECK_ADDITIONS.md` — structural integrity checks
- `TEST_COVERAGE_SURVEY.md` — test coverage analysis
- `STATE_MANAGEMENT_REFERENCE.md` — state layers reference
- `DEVTOOL_ENGINEERING_PRINCIPLES.md` — devtool engineering standards, data safety, audit checklist
- `AGENT_VERIFICATION_GAP.md` — problem statement: agent launches untested code
