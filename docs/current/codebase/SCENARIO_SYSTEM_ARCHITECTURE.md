# Scenario System Architecture

How DagNet manages parameter overlays (scenarios) for what-if analysis, comparative views, and live data regeneration.

## What Scenarios Are

A scenario is a named parameter overlay that sits on top of the graph's base parameters. Scenarios enable:
- Multiple "what-if" views of the same graph
- Side-by-side parameter comparisons
- Compositing stacks (Base --> Scenario 1 --> Scenario 2 --> Current)
- Lineage and staleness tracking via provenance stamps

## Data Model

### ScenarioParams (sparse overlay)

Stores only modified values, not the full graph:

- `edges`: Map of edge ID --> `EdgeParamDiff` (probability, weights, costs)
- `nodes`: Map of node ID --> `NodeParamDiff` (entry weights, case variants, costs)

Scenario params are sparse by design. They are the compositor's ordered delta
surface, not persisted full scenario graphs and not copies of the deeper
file-backed parameter inventory.

### Scenario

- `id`: unique identifier
- `name`: display name
- `colour`: palette colour
- `params`: ScenarioParams (the sparse overlay)
- `meta`: rich metadata including:
  - `queryDSL`: for live scenarios (can be regenerated from source data)
  - `whatIfDSL`: what-if conditions applied when created
  - `isLive`: boolean (true if DSL-backed)
  - Provenance stamps (`deps_v1`, `deps_signature_v1`) for staleness detection

**Storage**: IndexedDB (`db.scenarios`) indexed by `fileId`, keyed by `scenarioId`.

### Projection boundary between files, graph, and scenarios

The scenario system sits on top of a broader three-layer projection model.

Parameter files retain depth: history, retrieval metadata, commissioned
Bayesian slice inventories, fit history, and other rehydration material.
Scenarios do not persist that full inventory.

The graph JSON combines graph structure with the current projected state for
`current`. That design is intentional: one JSON can describe the entire active
working projection without requiring a second object for Current.

User scenarios store ordered param-pack deltas only. The compositor reapplies
those deltas in sequence, so application order is semantically load-bearing. A
scenario object is therefore not a full graph snapshot; it is the smallest
overlay needed to reconstruct that scenario's projected state on top of the
composed baseline.

## Scenario Types

### Static scenarios (manual snapshots)

- Created by capturing current state via UI
- Stored as explicit parameter sets
- No regeneration capability
- Two capture modes: `'all'` (full params) or `'differences'` (sparse diff from Base)

### Live scenarios (regenerable from data source)

- Tied to a query DSL (`queryDSL` in meta)
- Can be refreshed when underlying data changes
- DSL splits into:
  - **Fetch parts**: `window()`, `context()`, `cohort()`, `asat()` -- query the API
  - **What-if parts**: `case()`, `visited()`, `exclude()` -- applied as overlays after fetch
- Enable comparative analysis: "What if I filtered by context(channel:google)?"

## Composition Model

### Layer stacking

Scenarios compose additively via deep merge. Later overlays override earlier
ones. Null values remove keys. The order of application is semantically
load-bearing because each scenario is a delta relative to the layers below it.

`CompositionService.getComposedParamsForLayer()` is the single source of truth for "what are the params for layer X?":
- Special layers: `'base'` returns baseParams, `'current'` returns currentParams
- User scenarios: compose from base through all visible layers up to and including the target

### DSL inheritance (live scenarios)

Live scenarios inherit DSL from base and lower layers:
- Visual stack: [Top, ..., Bottom] where Bottom is closest to Base
- Scenario at index N inherits DSL from Base + all scenarios at indices > N
- Only live scenarios contribute DSL (static scenarios are skipped)
- MECE axes (context, contextAny, asat) allow only one clause per axis

## Regeneration Service

**Location**: `scenarioRegenerationService.ts`

### DSL splitting

`splitDSLParts()` separates a DSL string into fetch parts (data querying) and what-if parts (overlays).

### Effective DSL computation

`computeEffectiveFetchDSL()` merges inherited DSL (from Base and lower live scenarios) with the scenario's own queryDSL. Result is sent to the API for live data regeneration.

### Effective parameters

`computeEffectiveParams()` applies what-if logic (case overrides, visited conditionals) and bakes in results. Used to generate parameters for live scenario overlays.

### Boot-time regeneration

**Location**: `ScenariosContext.tsx` (post-boot effect, after topology-change handler)

On page refresh (F5), scenarios are loaded from IDB with their persisted parameter overlays, but these overlays may be stale — particularly when the graph's `currentQueryDSL` has changed since the overlay was computed. Without regeneration, live scenarios with different DSLs produce identical edge probabilities in analyses like bridge charts.

A one-shot post-boot effect fires once all prerequisites are met:
- `scenariosLoaded` (IDB load complete)
- `graph` available (hydrated in store)
- `tabContextInitDone` (boot coordinator + FileRegistry hydration complete)
- At least one live scenario with `meta.isLive === true`

The effect calls `regenerateAllLive(undefined, visibleOrder)` followed by `scheduleChartReconcile('boot-scenario-hydration')`. This mirrors the existing workspace-change and topology-change handlers. A ref guard (`bootRegenDoneForFileRef`) prevents re-firing when the graph updates from the regeneration itself.

**Share links are unaffected** — they have their own regeneration path via `useShareBundleFromUrl` / `useShareChartFromUrl` with `allowFetchFromSource: false`.

### Auto-regeneration triggers (complete list)

| Trigger | Location | Mechanism |
|---------|----------|-----------|
| Boot (F5) | `ScenariosContext.tsx` post-boot effect | One-shot, fires after graph + scenarios + tabContextInit all ready |
| Workspace file change (git pull) | `ScenariosContext.tsx` `dagnet:workspaceFilesChanged` handler | Re-generates visible live scenarios, reconciles charts |
| Graph topology change | `ScenariosContext.tsx` topology signature watcher | Debounced 300ms, re-generates visible live scenarios |
| Scenario DSL edited | `updateScenarioQueryDSL` | Single-scenario regeneration |
| `putToBase` (flatten) | `ScenariosContext.tsx` `putToBase` | Re-bases Base DSL, then `regenerateAllLive` |
| Manual "Refresh all" button | `ScenariosPanel.tsx` | Calls `regenerateAllLive` with visible order |
| Share link boot | `useShareBundleFromUrl` / `useShareChartFromUrl` | Per-scenario with `allowFetchFromSource: false` |
| Bulk scenario creation | `useBulkScenarioCreation.ts` | Per-scenario loop wrapped in a `bulk-scenario` progress op |
| Canvas "Apply view" | `GraphCanvas.tsx` — view restoration handler | Per-scenario loop (created + matched live scenarios) |
| URL scenario boot | `useURLScenarios.ts` | Per-scenario for each URL scenario |
| Dev refetch-from-files | `ScenariosContext.tsx` `DEV_REFETCH_FROM_FILES` handler | Refreshes Current, then `regenerateAllLive` |

`regenerateAllLive` is the fan-out used by **events that invalidate the whole visible stack at once** — boot, pull, topology change, `putToBase`, manual "Refresh all". It loops the visible live scenarios **sequentially** (bottom-up in the visual stack) and calls `regenerateScenario` for each with `allowFetchFromSource: false`. The remaining triggers call `regenerateScenario` directly because they operate on a specific subset: share-link boot and canvas apply-view replay a recipe, bulk creation and URL boot work on just-created scenarios, `updateScenarioQueryDSL` targets one scenario by ID.

### What each regeneration actually does

`regenerateScenario` deep-copies the composed baseline graph, computes the scenario's `effectiveFetchDSL` (Base + lower live scenarios + scenario own DSL — see `scenarioRegenerationService.computeEffectiveFetchDSL`), builds a plan, optionally executes it against source, then calls `fetchOrchestratorService.refreshFromFilesWithRetries` with `skipStage2: false`. That drops into `fetchDataService.fetchItems` → Stage 2 → FE topo + BE CF for that scenario's graph and DSL. **CF therefore runs once per scenario per regeneration** — visible live scenarios each receive their own CF pass conditioned on their own query window. Current is fetched independently by `useDSLReaggregation` when its DSL changes; scenarios don't re-fetch on Current-DSL change because their effective DSL inherits from Base, not Current, and their cached `meta.lastEffectiveDSL` remains valid. See `STATS_SUBSYSTEMS.md` §3.3 and `FE_BE_STATS_PARALLELISM.md` for the Stage 2 orchestration detail.

After Stage 2 finishes for that temporary working graph, `ScenariosContext`
extracts a fresh diff param pack against the composed baseline and persists
that pack back onto the scenario. The temporary graph itself is not stored as
scenario state. This means scenario packs must be sufficient to recreate the
scenario's projected state later, while the deeper file-backed inventory
continues to live in parameter files.

### Progress indicator for bulk regeneration

`regenerateAllLive` registers a single wrapping `bulk-scenario` operation in the operation registry — label `"Refreshing scenarios (i/N) — <ScenarioName>…"` updated per iteration — and passes `suppressPipelineToast: true` into each per-scenario regeneration. With that flag set, `fetchItems` skips the five-step `fetch-compute` pipeline indicator (plan → fetch → FE → BE → CF) that it normally shows for single-graph fetches, so N scenarios don't stack N full pipelines on screen. Instead, Stage 2's `finaliseCfToast` emits one compact `scenario-cf` terminal operation per scenario carrying the CF verdict and elapsed ms — `"<ScenarioName> · CF 1,320ms (3/8 conditioned)"`, or `"· CF: priors only, 820ms"`, or `"· CF failed"` / `"· CF superseded"` / `"· CF: no result"`. The parent op completes with an aggregate summary (`"Refreshed 6 scenarios in 8.4s"`). Single-scenario regeneration paths (`updateScenarioQueryDSL`, `ScenariosPanel` manual refresh, Current via `useDSLReaggregation`) leave `suppressPipelineToast` unset and show the full pipeline as before.

## Rehydration Service

**Location**: `scenarioRehydrationService.ts`

When a canvas view is restored from a share bundle:
- `buildRehydrationPlan()` matches stored scenario blueprints against existing scenarios
- Live scenarios matched by `(queryDSL, name, colour)`, static by `(name, colour)`
- Never reuses a scenario ID twice
- `finalisePlan()` replaces placeholder IDs with real IDs after creation

## Provenance Service

**Location**: `scenarioProvenanceService.ts`

Tracks dependencies for automatic staleness detection:

`computeScenarioDepsStampV1()` captures:
- Graph file revision (SHA or lastModified)
- Parameter/context/settings file revisions
- Reference day (for time-dependent DSLs)
- Base DSL and effective DSL strings

Generates a stable signature (`deps_signature_v1`). If signature differs from stored value, scenario is stale.

## Parameter Pack Format

Scenarios can be serialised in flat HRN notation:
```
e.some-edge.p.mean: 0.42
n.some-node.entry.entry_weight: 5
```

Or nested notation:
```yaml
e:
  some-edge:
    p:
      mean: 0.42
```

`ParamPackDSLService` handles `fromYAML()`, `toYAML()`, `toCSV()`, and HRN resolution to UUIDs via graph context.

## DiffService

**Location**: `DiffService.ts`

Computes sparse diffs between parameter states (not file-level merge):
- Mode `'all'`: full current params
- Mode `'differences'`: only changed values
- Epsilon threshold (default 1e-6) for numeric comparison
- Diffs probability means, stdevs, costs, weights, conditional probabilities

## Canvas Integration

Scenario rendering pipeline:

1. **Layer order**: visible scenarios in stack order, then 'current'
2. **Edge rendering**: for each visible layer, compose params, compute edge widths from p.mean or weight_default, calculate Sankey offsets
3. **Colour assignment**: from palette or user override
4. **What-if integration**: overlay what-if case overrides on current layer

## ScenariosContext

**Location**: `src/contexts/ScenariosContext.tsx`

Central React context for all scenario operations:

- **CRUD**: captureScenario, createBlank, createLiveScenario, rename, delete, applyContent
- **Live ops**: regenerateScenario, regenerateAllLive, updateScenarioQueryDSL
- **Composition**: composeVisibleParams
- **Base/current**: setBaseDSL, putToBase (flatten stack into base)
- **Persistence**: auto-saves to IndexedDB on change, auto-loads on file change
- **Chart reconciliation**: debounced reconciliation of dependent analysis charts on graph changes

## Key Design Patterns

1. **Sparse representation**: only modified values stored, not full graph
2. **DSL splitting**: fetch parts for API calls, what-if parts for overlays
3. **Layer inheritance**: live scenarios inherit DSL from base and lower layers
4. **Provenance tracking**: dependency signatures enable automatic staleness detection
5. **HRN resolution**: user-friendly names resolve to UUIDs via graph context
6. **Composition as deep merge**: later overlays override earlier ones; null removes keys
7. **Graph = structure + current projection**: Current lives on the graph JSON rather than in a separate scenario object
8. **Scenarios = ordered deltas**: user scenarios are replayable overlays, not stored graph snapshots
9. **Depth stays in files**: scenario packs carry scenario-specific projection state, while deeper histories and slice inventories remain file-backed

## Key Files

| File | Role |
|------|------|
| `src/types/scenarios.ts` | ScenarioParams, Scenario, EdgeParamDiff, NodeParamDiff |
| `src/contexts/ScenariosContext.tsx` | Central scenario management context |
| `src/services/ScenarioRenderer.ts` | Visual rendering (widths, Sankey offsets, colours) |
| `src/services/ScenarioValidator.ts` | Validation against graph structure |
| `src/services/CompositionService.ts` | Layer composition (single source of truth) |
| `src/services/scenarioRegenerationService.ts` | DSL splitting, inheritance, effective params |
| `src/services/scenarioRehydrationService.ts` | Share bundle scenario matching |
| `src/services/scenarioProvenanceService.ts` | Dependency stamps, staleness detection |
| `src/services/ParamPackDSLService.ts` | Serialisation (YAML, CSV, HRN) |
| `src/services/DiffService.ts` | Sparse parameter diffing |
