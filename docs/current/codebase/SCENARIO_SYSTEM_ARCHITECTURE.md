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

Scenarios compose additively via deep merge. Later overlays override earlier ones. Null values remove keys.

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
