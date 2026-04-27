# Schema and Type Parity

Where schema files live, which pairs must stay in sync, and how parity is enforced.

## Schema locations

### Graph and app schemas (`public/schemas/`)

JSON Schema (draft-07) files defining core data structures:

| File | Purpose |
|------|---------|
| `conversion-graph-1.1.0.json` | **Primary graph schema** — nodes, edges, probabilities, latency, metadata, policies, canvas objects |
| `conversion-graph-1.0.0.json` | Legacy (archived, superseded by 1.1.0) |
| `query-dsl-1.1.0.json` | Query DSL syntax spec |
| `query-dsl-1.0.0.json` | Legacy |
| `connections-schema.json` | Data source connections (Amplitude, Sheets, Postgres) |
| `settings-schema.json` | Repo-wide forecasting and analytical settings |
| `credentials-schema.json` | Application credentials (Git repos, API tokens) |

### Parameter registry schemas (`public/param-schemas/`)

YAML schemas defining parameter/node/event/context definitions and their index files:

| File | Purpose |
|------|---------|
| `parameter-schema.yaml` | Individual parameter definition (id, type, values, query, metadata, latency, posterior) |
| `node-schema.yaml` | Node definition (id, name, event_id, properties) |
| `event-schema.yaml` | Event definition |
| `context-definition-schema.yaml` | Context variable definition |
| `case-parameter-schema.yaml` | Case/experiment parameter definition |
| `nodes-index-schema.yaml` | Index file for nodes |
| `events-index-schema.yaml` | Index file for events |
| `contexts-index-schema.yaml` | Index file for contexts |
| `cases-index-schema.yaml` | Index file for cases |
| `registry-schema.yaml` | Combined registry structure |

### UI schemas (`public/ui-schemas/`)

NOT data schemas — form rendering hints (widget types, field ordering, help text) for the FormEditor component:

| File | Pairs with |
|------|-----------|
| `settings-ui-schema.json` | `settings-schema.json` |
| `credentials-ui-schema.json` | `credentials-schema.json` |
| `connections-ui-schema.json` | `connections-schema.json` |
| `parameter-ui-schema.json` | `parameter-schema.yaml` |
| `event-ui-schema.json` | `event-schema.yaml` |
| `context-ui-schema.json` | `context-definition-schema.yaml` |

### TypeScript types (`src/types/`)

| File | Scope |
|------|-------|
| `index.ts` | Core types: ObjectType, ViewMode, FileState, WorkspaceState, graph-adjacent types |
| `credentials.ts` | GitRepositoryCredential, CredentialsData, ProviderCredentials |
| `chartRecipe.ts` | ChartRecipeCore, ChartFileDataV1, ChartDepsStampV1 |
| `scenarios.ts` | Scenario, ScenarioLayerConfig |
| `parameterData.ts` | ParameterValue, ParameterDataSlice |

### Python Pydantic models (`lib/graph_types.py`)

Comprehensive BaseModel definitions matching `conversion-graph-1.1.0.json`: Graph, Node, Edge, ProbabilityParam, CostParam, Evidence, LatencyConfig, Metadata, Policies, ConditionalProbability, etc.

## Parity pairs (must stay in sync)

| Source of truth | Must match | Enforcement |
|-----------------|-----------|-------------|
| `conversion-graph-1.1.0.json` | `lib/graph_types.py` (Pydantic) | `test_schema_parity.py` (automated, CI) |
| `conversion-graph-1.1.0.json` | `src/types/index.ts` (partial) | `schemaParityAutomated.test.ts` (automated, CI) |
| `settings-schema.json` | `types/index.ts` (SettingsData) | Manual alignment |
| `credentials-schema.json` | `types/credentials.ts` | `schemaParityAutomated.test.ts` |
| `parameter-schema.yaml` | `types/parameterData.ts` | Manual alignment |
| Each data schema | Its paired UI schema | Manual alignment |

**Rule**: if you change a JSON/YAML schema, check the parity pair and run the parity test. If you change a TypeScript type or Pydantic model that corresponds to a schema, update the schema too.

## Parity tests

| Test | Location | What it checks |
|------|----------|----------------|
| `schemaParityAutomated.test.ts` | `src/services/__tests__/` | TS types vs JSON Schema field parity (uses ts-morph AST parsing) |
| `test_schema_parity.py` | `lib/tests/` | Python Pydantic vs JSON Schema field parity |
| `test_schema_python_consistency.py` | `lib/tests/` | Python round-trip validation |
| `sampleFilesIntegrity.test.ts` | `src/services/__tests__/` | Sample test files pass schema validation |

## Validation points

1. **At app startup**: `src/lib/schema.ts` loads graph schema, creates Ajv validator, caches for reuse
2. **In CI**: parity tests detect drift automatically
3. **On Python import**: Pydantic parsing validates graph JSON structure
4. **Form rendering**: UI schemas provide layout hints; data validated against data schemas

## Versioning

| Version | Status | Key changes from 1.0.0 |
|---------|--------|------------------------|
| 1.0.0 | Archived | Initial graph schema |
| 1.1.0 | **Current** | Added `type` on Node, `currentQueryDSL` at root, `name` in Metadata; relaxed `Id.minLength` to 0 |

All changes are additive/relaxing — 1.0.0 files remain valid under 1.1.0.

## Known drift issues

1. **TypeScript graph types are loose** — JSON Schema and Pydantic are comprehensive, but TS uses `any` in many graph property positions. Parity test catches field-level drift but not deep type safety.
2. **Internal UI flags can leak to persistence** — e.g. `_noHistory` (slider drag flag) was persisting to `conditional_p` entries. Regression check in `schemaParityAutomated.test.ts`.
3. **Parameter schema ↔ TypeScript alignment is manual** — no automated test for `parameter-schema.yaml` vs `parameterData.ts`.

## Adding a new field checklist

When adding a field to the graph or parameter schema:

1. Add to the JSON/YAML schema source of truth
2. Add to `lib/graph_types.py` (Pydantic model)
3. Add to relevant TypeScript interface in `src/types/`
4. If UI-editable: update the paired UI schema
5. If it has an `_overridden` companion: mirror the override pattern (see GRAPH_MUTATION_UPDATE_MANAGER.md)
6. If it contains node references: add to UpdateManager rename logic
7. Run parity tests: `npm test -- --run schemaParityAutomated` and `pytest lib/tests/test_schema_parity.py`

See also: "Adding New Fields or Features" section in CLAUDE.md.

## Key files

| File | Role |
|------|------|
| `public/schemas/conversion-graph-1.1.0.json` | Primary graph schema (source of truth) |
| `public/param-schemas/` | Parameter registry schemas (YAML) |
| `public/ui-schemas/` | Form rendering hints |
| `lib/graph_types.py` | Python Pydantic models (must match graph schema) |
| `src/types/index.ts` | Core TypeScript types |
| `src/types/credentials.ts` | Credential types |
| `src/types/parameterData.ts` | Parameter data types |
| `src/lib/schema.ts` | Ajv validation entry point |
| `src/services/__tests__/schemaParityAutomated.test.ts` | TS ↔ Schema drift detector |
| `lib/tests/test_schema_parity.py` | Python ↔ Schema drift detector |
