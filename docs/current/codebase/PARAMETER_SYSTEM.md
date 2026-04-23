# Parameter System

How parameters are defined, extracted from graphs, serialised as param packs, resolved via model variables, and validated via schemas.

## What Parameters Are

Parameters are timestamped, sourced numerical estimates (mean/stdev, counts, daily breakdowns, latency histograms) that drive conversion graph analysis. They serve as the data foundation for probability and cost calculations.

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

### What's NOT extracted (internal config)

Raw distribution knobs on the base probability (`distribution`, `min`, `max`, `alpha`, `beta` on `p` itself — distinct from `p.posterior.alpha/beta`), evidence retrieval metadata (`window_from/to`, `retrieved_at`, `source`), latency config (`latency_parameter`, `anchor_node_id`, `mean_lag_days`), `*_overridden` flags, and the graph-root `_bayes` metadata block.

### Whitelist discipline

The extractor maintains explicit field whitelists — `LATENCY_FIELD_WHITELIST`, `PROBABILITY_POSTERIOR_FIELD_WHITELIST`, `LATENCY_POSTERIOR_FIELD_WHITELIST` at the top of `GraphParamExtractor.ts`. Fields are picked by name; nested objects are never copied wholesale. New fields require an explicit whitelist entry (or they are silently dropped). This is a known anti-pattern — see `docs/current/project-assure/PROPOSAL.md` for the schema-driven `x-param-pack` replacement design.

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

**Default divergence across call sites.** CLI commands serialise with `structure: 'flat'`; the browser `ScenariosContext` import/export uses `'nested'`. This is a known inconsistency — see `docs/current/project-assure/PROPOSAL.md` → "Pack shape standardisation" for the plan to make flat the canonical shape for every surface that crosses a process boundary and keep nested only as an in-memory display view in the Scenarios editor.

## Model Variable Resolution

**Location**: `modelVarsResolution.ts`

Model variables represent alternative probability estimates for a single edge. Resolution selects one to promote.

### Preference hierarchy

1. `'manual'` -- user override (if present, wins)
2. `'bayesian'` -- Bayesian posterior (if present AND gate_passed)
3. `'analytic'` -- deterministic fitting (trusted default)
4. `'analytic_be'` -- backend analytic variant (opt-in)
5. `'best_available'` -- Bayesian if gated, else analytic (the default)

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
