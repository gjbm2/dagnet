# Parameter System

How parameters are defined, extracted from graphs, serialised as param packs, resolved via model variables, and validated via schemas.

## What Parameters Are

Parameters are timestamped, sourced numerical estimates (mean/stdev, counts, daily breakdowns, latency histograms) that drive conversion graph analysis. They are the data foundation for probability and cost calculations.

### Core data model (`types/parameterData.ts`)

**Parameter**: an identified, versioned data entity:
- `id` (kebab-case), `name` (human-readable)
- `type`: `'probability'`, `'cost_gbp'`, or `'labour_cost'`
- `values[]`: array of ParameterValue (timestamped data points)
- `query` / `n_query`: DSL strings defining data retrieval
- `metadata`: version, authorship, tags, status
- Latency configuration (for time-delayed conversions)
- Bayesian posterior (per-slice probability + latency posteriors)

**ParameterValue**: a single data point:
- `mean`, `stdev` (core statistics)
- `n`, `k` (sample counts / successes)
- `n_daily`, `k_daily`, `dates` (per-day breakdowns)
- Latency data: `median_lag_days`, `mean_lag_days`, `anchor_*_daily`
- `forecast.mean` (mature baseline probability)
- `evidence` block (retrieval metadata)
- `data_source` (Amplitude, Sheets, manual, etc.)
- `context_id`, `sliceDSL` (for context-dependent variants)

## Projection surfaces

The parameter system spans three different storage depths.

Parameter files are the deep, authoritative store. They retain parameter history, retrieval metadata, commissioned Bayesian slice inventories, fit history, and any other material needed to rehydrate a later projection. They are the only surface meant to retain the full commissioned depth of a parameter.

The graph carries structure plus the currently projected state for the active working view. On an edge: currently active posterior, forecast/evidence fields, promoted model state, any current query-scoped display state the fetch pipeline has written. The graph is therefore a projection surface, not the full file-depth inventory.

Scenario param packs are thinner again. They are not mini parameter files and not full graphs. They express the scenario-specific projection delta that the compositor reapplies in order. A pack should contain only fields specifically true for that scenario's active projection and later consumed by rendering or analysis. Deep file-backed inventory stays in the files.

## Extraction from Graphs

**Location**: `GraphParamExtractor.ts`

### Three extraction modes

| Mode | Purpose |
|------|---------|
| `extractParamsFromGraph(graph)` | Whole-graph extraction, edges sorted topologically |
| `extractDiffParams(modified, base)` | Differential -- only changed probabilities (for live scenarios) |
| `extractParamsFromSelection(graph, nodeUuids, edgeUuids)` | Selected subset only |

### What's extracted (scenario-visible + Bayes-enrichment fields)

From edges:

- `p.mean`, `p.stdev`
- `p.posterior.*` — Bayesian probability posterior (`alpha`, `beta`, HDI bounds, `ess`, `rhat`, `fitted_at`, `fingerprint`, `provenance`, cohort-slice variants). Populated by `bayesPatchService.applyPatch` when a `.bayes-vars.json` sidecar lands.
- `p.evidence.*` (`mean`, `stdev`, `n`, `k`)
- `p.forecast.*` (`mean`, `stdev`)
- `p.latency.*` — LAG display fields (`completeness`, `completeness_stdev`, `t95`, `path_t95`, `median_lag_days`) plus Bayesian promoted scalars (`mu`, `sigma`, `onset_delta_days`, `promoted_t95`, `promoted_*_sd`, `path_mu`, `path_sigma`, `promoted_path_t95`, etc.) written by the promotion cascade.
- `p.latency.posterior.*` — full latency posterior block (`mu_mean`, `mu_sd`, `sigma_mean`, `sigma_sd`, `onset_*`, `hdi_t95_*`, path-level equivalents).
- `conditional_p` — same shape mirrored per condition.
- `cost_gbp.*`, `labour_cost.*` (`mean`, `stdev`, `distribution`), `weight_default`.

From nodes: `entry.entry_weight`, `costs.monetary`, `costs.time`, `case.variants[].{name, weight}`.

These are projection fields. The extractor copies the active graph view, not the full parameter-file inventory for an edge.

### What's NOT extracted (internal config)

Raw distribution knobs on the base probability (`distribution`, `min`, `max`, `alpha`, `beta` on `p` itself — distinct from `p.posterior.alpha/beta`), evidence retrieval metadata (`window_from/to`, `retrieved_at`, `source`), latency config (`latency_parameter`, `anchor_node_id`, `mean_lag_days`), the full Bayesian slice inventory (`posterior.slices` on the file object), the graph-side re-projection cache `p._posteriorSlices`, the full model-source ledger `p.model_vars`, model-source preference flags, `*_overridden` flags, and the graph-root `_bayes` metadata block.

### Whitelist discipline

The extractor maintains explicit field whitelists — `LATENCY_FIELD_WHITELIST`, `PROBABILITY_POSTERIOR_FIELD_WHITELIST`, `LATENCY_POSTERIOR_FIELD_WHITELIST` at the top of `GraphParamExtractor.ts`. Fields are picked by name; nested objects are never copied wholesale. New fields require an explicit whitelist entry (or they are silently dropped). Known anti-pattern — see `docs/current/project-assure/PROPOSAL.md` for the schema-driven `x-param-pack` replacement design.

## Param Packs and DSL

**Location**: `ParamPackDSLService.ts`

Param packs are scenario-parameterised data snapshots using HRN (Human-Readable Notation):

```
e.<edgeId>.p.mean: 0.42
e.<edgeId>.p.evidence.n: 100
e.<edgeId>.<condition>.p.mean: 0.5        # conditional
n.<nodeId>.entry.entry_weight: 5
n.<nodeId>.case(<nodeId>:<variant>).weight: 1.0
```

### Serialisation formats

| Format | Method | Notes |
|--------|--------|-------|
| YAML (flat) | `toYAML(params, 'flat')` | Complete HRN paths, one per line |
| YAML (nested) | `toYAML(params, 'nested')` | Grouped by edge ID to reduce repetition |
| JSON | `toJSON(params)` | Flat HRN paths (the `structure` argument is accepted but both branches emit the same JSON) |
| CSV | `toCSV(params)` | Two-column (key, value) |

Round-trip parsing via `fromYAML()`, `fromJSON()`, `fromCSV()`. If a graph is provided, HRNs are resolved to canonical IDs/UUIDs.

**Default divergence across call sites.** CLI commands serialise with `structure: 'flat'`; the browser `ScenariosContext` import/export uses `'nested'`. Known inconsistency — see `docs/current/project-assure/PROPOSAL.md` → "Pack shape standardisation" for the plan to make flat the canonical shape for every surface that crosses a process boundary and keep nested only as an in-memory display view in the Scenarios editor.

### Thin-by-design scenario pack contract

Scenario packs should stay as thin as possible. When a consumer needs richer scenario reconstruction, the intended fix is to add the specific active projection field that consumer reads, not to duplicate the full parameter-file depth, full slice inventories, or whole graphs inside the pack.

The file-backed Bayesian slice inventory remains authoritative in parameter files even when the active scenario projection includes a projected `p.posterior` / `p.latency.posterior` view. The graph may currently carry `p._posteriorSlices` as a FE re-projection cache, but that cache is a graph convenience, not part of the scenario-pack contract.

## Model Variable Resolution

**Location**: `modelVarsResolution.ts`

Model variables represent alternative probability estimates for a single edge. Resolution selects one to promote.

### Preference hierarchy

1. `'manual'` -- user override (if present, wins)
2. `'bayesian'` -- Bayesian posterior (if present AND gate_passed)
3. `'analytic'` -- deterministic fitting (trusted default)
4. `'best_available'` -- Bayesian if gated, else analytic (the default)

### Key functions

- `resolveActiveModelVars(modelVars, preference)`: select winning entry
- `promoteModelVars(entry)`: flatten to scalar mean/stdev/latency
- `effectivePreference(edgePref, graphPref)`: edge-level overrides graph-level
- `applyPromotion(probabilityParam, graphPref)`: write promoted scalars onto edge

## Schema System

**Location**: `public/param-schemas/`

JSON Schema (draft-07) definitions enforce structure at registry boundaries:

| Schema | Enforces |
|--------|----------|
| `parameter-schema.yaml` | id, name, type, values[], metadata, optional query/n_query/latency/posterior |
| `node-schema.yaml` | id, name, event_id, optional description/tags/resources/images |
| `cases-index-schema.yaml` | Index file structure |
| `contexts-index-schema.yaml` | Index file structure |

### Key constraints

- `id` pattern: `^[a-zA-Z0-9_-]+$`
- `type` enum: probability, cost_gbp, labour_cost
- `query` pattern: DSL format `from(...).to(...)`
- Metadata version: semantic versioning `^\d+\.\d+\.\d+$`
- Status enum: active, deprecated, draft, archived

## Key Files

| File | Role |
|------|------|
| `src/types/parameterData.ts` | Parameter, ParameterValue interfaces |
| `src/services/GraphParamExtractor.ts` | Extraction from graphs |
| `src/services/ParamPackDSLService.ts` | HRN serialisation/deserialisation |
| `src/services/modelVarsResolution.ts` | Model variable resolution and promotion |
| `public/param-schemas/*.yaml` | JSON Schema definitions |
