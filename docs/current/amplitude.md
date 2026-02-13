## Amplitude multi-environment support (connection inheritance + graph-level default connection)

---
name: Amplitude multi-environment
overview: |
  Add connection inheritance (`extends`) to connections.yaml so amplitude-staging can reuse amplitude-prod's
  entire adapter with different credentials. Add graph-level `defaultConnection` so the connection choice lives
  at the graph level (not parameter file level). Remove `connection` as a top-level field on parameter files.
  Expose missing graph-level properties in Graph Properties panel.
status: proposal
---

## Problem

1. **No staging/dev Amplitude support.** Today there is a single `amplitude-prod` connection with a ~600-line adapter (pre_request script, response extraction, transforms). Adding `amplitude-staging` would require duplicating the entire block — unacceptable.

2. **Connection lives on the wrong object.** Today `connection` is a top-level field on both the parameter file and the graph edge (`edge.p.connection`). But:
   - Fetching is commissioned at graph level (click fetch on a graph edge).
   - The same parameter can appear across multiple graphs (shared param files).
   - A graph pointing at staging and a graph pointing at prod should be able to share the same parameter file — they differ only in which Amplitude project they query.
   - Therefore `connection` is a graph-level concern, not a parameter-file concern.

3. **No graph-level default.** Every edge must individually specify its connection. For a graph with 40 edges all pointing at `amplitude-prod`, this is tedious and error-prone. A graph-level default would eliminate this repetition and make environment-switching a single-field change.

4. **Graph Properties panel is sparse.** Several user-configurable graph-level fields (`baseDSL`, `dataInterestsDSL`, `dailyFetch`, `metadata.name`) are not exposed in the Graph Properties panel. The new `defaultConnection` should be added alongside these.

## Design

### Part A: Connection inheritance (`extends`)

#### connections.yaml schema change

A connection may specify `extends: <parent-name>`. When present, the connection inherits all fields from the parent. Any field specified on the child overrides the parent.

```yaml
- name: amplitude-staging
  extends: amplitude-prod
  description: "Staging Amplitude analytics"
  credsRef: amplitude-staging
  defaults:
    base_url: "https://amplitude.com/api/2"
    # No excluded_cohorts — staging project doesn't have the test-users cohort
```

Everything not specified (capabilities, adapter, pre_request, response, transforms) comes from `amplitude-prod`.

#### Merge semantics

- **Deep merge for `defaults`**: child `defaults` keys merge into parent `defaults` (child wins on conflict). This lets you override `excluded_cohorts` without losing `base_url`.
- **Atomic replace for `adapter`**: if the child specifies `adapter`, it replaces the parent's entire adapter. You would never want half a parent adapter merged with half a child adapter.
- **Atomic replace for `capabilities`**: same reasoning — capabilities are a coherent set.
- **One level only**: no `extends` chains (A extends B extends C). A connection may extend a concrete connection, not another extending connection. This avoids circular-reference complexity.
- **Validation**: if `extends` names a connection that doesn't exist, or names itself, or names a connection that itself has `extends`, raise a clear error at resolution time.

#### Implementation: `resolveConnection` helper

A single shared function used by both `IndexedDBConnectionProvider` and `FileSystemConnectionProvider`:

```
resolveConnection(name, allConnections) → ConnectionDefinition
```

1. Find connection by `name`.
2. If no `extends`, return as-is.
3. If `extends` is present, find parent by that name.
4. Error if parent not found, parent also has `extends`, or self-reference.
5. Deep-merge `defaults` (parent first, child overrides).
6. For all other fields: child value wins if present, otherwise parent value.
7. Strip `extends` from result — downstream code sees a normal `ConnectionDefinition`.

Both `getConnection()` and `getAllConnections()` call `resolveConnection` so the rest of the system never sees the `extends` field.

#### ConnectionDefinition type change

```typescript
// graph-editor/src/lib/das/types.ts
export interface ConnectionDefinition {
  name: string;
  extends?: string;  // NEW
  provider: string;
  // ... rest unchanged
}
```

When `extends` is present, all fields except `name` become optional (the parent supplies defaults). TypeScript modelling: either use a union type or make the fields optional with a runtime guarantee that resolution fills them in.

### Part B: Graph-level `defaultConnection`

#### Graph type change

Add `defaultConnection` to `ConversionGraph`:

```typescript
// graph-editor/src/types/index.ts
export interface ConversionGraph {
  // ... existing fields ...
  defaultConnection?: string;  // NEW: e.g. "amplitude-prod" or "amplitude-staging"
}
```

This persists to the graph YAML file. Changing it is a single edit.

#### Connection resolution order (for fetch operations)

When resolving which connection to use for a fetch:

1. **Edge-level**: `edge.p.connection` (per-edge override, with `connection_overridden` flag)
2. **Graph-level**: `graph.defaultConnection`
3. **Error**: no connection configured — toast error, skip fetch

Parameter file `connection` is **no longer an input** to fetch operations. It becomes provenance only.

#### Call sites requiring update

Traced exhaustively — these are all the places that resolve `connectionName`:

| Call site | File | Lines | Current resolution | Change needed |
|---|---|---|---|---|
| `getFromSourceDirect()` main resolution | `dataOperationsService.ts` | ~4670–4830 | `persisted.connection` → edge → file fallback | Add `graph.defaultConnection` as step 2; remove file as input |
| `getParameterFromFile()` signature computation | `dataOperationsService.ts` | ~1950–1953 | edge slots → `paramFile.data.connection` | Add `graph.defaultConnection` fallback |
| `selectPersistedProbabilityConfig()` | `persistedParameterConfigService.ts` | 37–68 | `writeToFile` → file; else → graph | Stop returning `fileParamData.connection`; always resolve from graph |
| `itemNeedsFetch()` | `fetchDataService.ts` | 331–337, 373 | `paramFile?.data?.connection \|\| param?.connection` | Add `graph.defaultConnection` check |
| `createProductionConnectionChecker()` | `fetchPlanBuilderService.ts` | 672–698 | `edge.p.connection`, `edge.cost_gbp.connection`, etc. | Add `graph.defaultConnection` fallback |
| `computePlannerQuerySignaturesForGraph()` | `plannerQuerySignatureService.ts` | 179–186 | `persistedCfg.connection ?? paramObj?.connection` | Will inherit fix from `selectPersistedProbabilityConfig` + add graph fallback |
| Fetch plan connection extraction | `windowFetchPlannerService.ts` | ~1477 | `param?.connection` | Add `graph.defaultConnection` fallback |

#### `connection_overridden` semantics

Today: `connection_overridden` on the edge means "don't sync connection from file → graph". With graph-level default, the semantics become:
- `connection_overridden: true` + `edge.p.connection` set → use edge value (takes precedence over graph default). **No change needed.**
- `connection_overridden: false` or absent → fall through to `graph.defaultConnection`.
- Clearing the override on an edge effectively says "use the graph default" — which is the desired behaviour.

#### Parameter file: remove `connection` as config input

Today, the parameter file has a top-level `connection` field that syncs bidirectionally with `edge.p.connection` via the UpdateManager (12 mapping entries across CREATE, UPDATE graph→file, and UPDATE file→graph). This creates the problem: a shared parameter file "remembers" which connection it was last fetched with, polluting graphs that share it.

**Change**: parameter files no longer carry `connection` as a configuration input. The field may remain in the schema for backward compatibility / provenance display ("this file was last fetched via amplitude-prod"), but it is **not used as an input to fetch operations**. Fetch operations resolve connection from edge → graph → error.

Concretely:
- `persistedParameterConfigService.selectPersistedProbabilityConfig()`: stop returning `fileParamData.connection` for the `writeToFile` path. Always resolve connection from graph.
- `UpdateManager` flow B (graph → file, CREATE + UPDATE): still write `connection` to the file as provenance (what was used for the last fetch), but this is informational, not authoritative. **No change needed** — these mappings stay.
- `UpdateManager` flow D (file → graph, UPDATE): stop syncing `connection` from file to graph edge. Remove or disable the 6 file→graph connection mappings (mappings 7–12). The graph edge gets its connection from its own `edge.p.connection` or `graph.defaultConnection`.

**Values still carry provenance.** Each value in `values[]` has `data_source.type` and the `query_signature` embeds the connection name in the `core_hash`. This is provenance (where the data came from), not configuration (where to fetch from). This doesn't change.

#### Backward compatibility / migration

Existing graphs have `edge.p.connection` set on most edges (because it synced from file). These will continue to work — edge-level connection is step 1 in the resolution chain.

For graphs where edges have no `connection` set (relied on file connection): they will need `graph.defaultConnection` set, or they'll get an error on fetch. This is an acceptable breaking change — the fix is a single edit to the graph file.

No migration script needed. When a user opens a graph without `defaultConnection`, the graph works exactly as before (edge-level connection still resolves). The only scenario that breaks is an edge with no `edge.p.connection` that previously relied on `fileParamData.connection` — rare, since UpdateManager synced file→graph.

### Part C: Implicit nodes — skip edges that can't be fetched

When a graph has a `defaultConnection` and the user does a bulk fetch (Retrieve All Slices, daily automation), every edge is a candidate for fetching. But some edges connect to **implicit/structural nodes** that have no `event_id` — these can't be fetched from Amplitude (or any analytics provider).

#### Current behaviour

- `buildDslFromEdge` (line 203 of `buildDslFromEdge.ts`) throws an `Error` with a detailed message when `from_event_id` or `to_event_id` is missing.
- **Single fetch**: error is caught, toast shown, fetch fails for that edge.
- **Bulk fetch** (`retrieveAllSlicesService`): error is caught per item, item marked as `'failed'`, operation continues with other items.
- **Pre-filtering**: `fetchPlanBuilderService` checks for `hasConnection` but does **not** check for `event_id`. Items with a connection but missing `event_id` are classified as `'fetch'` and fail at execution time.

#### Required change

Add `event_id` validation to `fetchPlanBuilderService.buildParameterPlanItem()` before classification. For connections where `requires_event_ids !== false` (i.e. analytics connections):

- **Both nodes lack `event_id`**: classify as `'unfetchable'` with reason `'no_event_ids'`. Silent skip — this is normal and expected for structural edges.
- **One node has `event_id`, the other doesn't**: classify as `'unfetchable'` with reason `'partial_event_ids'`. Also a silent skip — not a warning, since mixed implicit/explicit edges are a normal graph structure. Information-level session log entry only in diagnostic mode.
- **Both nodes have `event_id`**: proceed as normal.

This requires the `ConnectionChecker` interface to gain a method or the plan builder to access the graph's nodes to check `event_id`. The cleanest approach is to check `event_id` on the edge's `from`/`to` nodes directly in the plan builder, since it already has access to the graph.

### Part D: Credentials setup

When the staging Amplitude project exists:

```yaml
# credentials.yaml
amplitude-staging:
  api_key: "STAGING_API_KEY"
  secret_key: "STAGING_SECRET_KEY"
```

The `amplitude-staging` connection has `credsRef: amplitude-staging`, pointing to this block.

### Hash isolation

The connection name is baked into the `core_hash` (line 857 of `dataOperationsService.ts`):

```
coreCanonical = JSON.stringify({ connection: connectionName, from_event_id, to_event_id, ... })
```

So `amplitude-prod` and `amplitude-staging` produce different hashes for the same query. This means:
- Snapshot DB data is isolated by connection (staging rows invisible to prod reads and vice versa).
- Parameter file values carry their connection in the `query_signature` — switching connection makes old values stale (detected by signature checking).
- No cross-contamination when merging branches that used different connections.

### Workflow

1. **Dev branch**: set `graph.defaultConnection: amplitude-staging` → all fetches hit staging.
2. **Test**: validate data, build graph, iterate.
3. **Merge to main**: change `graph.defaultConnection: amplitude-prod` → all fetches hit prod. Staging data is stale (different hash). First prod fetch populates fresh data.
4. **Per-edge override**: any edge can still set `edge.p.connection` to override the graph default (e.g. one edge fetches from Google Sheets while the rest use Amplitude).

## Graph Properties panel — expose missing graph-level fields

The Graph Properties panel (lines 1132–1172 of `PropertiesPanel.tsx`) currently shows only 4 metadata fields (description, version, author, tags). Several user-configurable graph-level settings are not exposed.

### Fields to add

| Field | Control | Section | Notes |
|---|---|---|---|
| `metadata.name` | Text input | Top of panel | Human-readable graph name — the most obviously missing field |
| `defaultConnection` | `ConnectionSelector` dropdown (populated from connections.yaml) | "Data Source" section | **NEW** — see Part B. Use `ConnectionSelector` directly (no override flags needed at graph level) |
| `baseDSL` | `QueryExpressionEditor` (Monaco) | "Query" section | Pinned base query for live scenario composition. Same Monaco-based DSL editor component used for edge queries (syntax highlighting, autocompletion). Store in local state, commit on blur via `updateGraph(['baseDSL'], value)` |
| `dataInterestsDSL` | `QueryExpressionEditor` (Monaco) | "Query" section | Nightly runner template. Same Monaco/DSL component. Use `allowedFunctions` prop for slice-plan DSL syntax (supports `or`, semicolons, etc.) |
| `dailyFetch` | Toggle / checkbox | "Automation" section | Include in unattended daily automation runs |
| `metadata.created_at` | Read-only display | Footer / info section | Not editable, just informational |
| `metadata.updated_at` | Read-only display | Footer / info section | Not editable, just informational |

### Fields that should remain hidden

- `currentQueryDSL` — managed by the query bar UI, not a properties-panel concern
- `postits` — managed on canvas
- `debugging` — dev-only flag
- `policies` — structural, has its own UI
- `last_retrieve_all_slices_success_at_ms` — internal system timestamp

### Implementation detail

- `updateGraph(['metadata', 'name'], value)` for metadata fields, `updateGraph(['defaultConnection'], value)` for top-level fields.
- Graph store update → FileRegistry → IndexedDB sync is already handled by the existing `setGraph` flow.
- `ConnectionSelector` already self-loads connections via `IndexedDBConnectionProvider.getAllConnections()`. After Phase 1, this will include resolved inherited connections (e.g. `amplitude-staging` appears as a normal entry).

## Open issues and edge cases

### 1. `connection_string` stays per-edge

`connection_string` (the JSON blob of provider-specific settings, e.g. segment filters) is genuinely per-parameter — different edges query different event pairs with different segment filters. Only the connection *name* should be graph-level. `connection_string` remains on `edge.p.connection_string` and in parameter files as today. No change needed.

### 2. Multiple param slots on one edge

An edge can have `p`, `cost_gbp`, and `labour_cost`, each with potentially different connections. The graph default applies to all slots unless individually overridden. The existing slot-level resolution (`edge.p.connection`, `edge.cost_gbp.connection`, `edge.labour_cost.connection`) already handles this — each slot resolves independently.

### 3. Case nodes

Cases also have `connection` (on `node.case.connection`). The graph default should apply to cases too. The `createProductionConnectionChecker().hasCaseConnection()` and the case resolution path in `getFromSourceDirect()` (lines 4701–4724) both need updating to include `graph.defaultConnection` fallback.

### 4. `fetchPlanBuilderService.ConnectionChecker` needs graph access

Today, `createProductionConnectionChecker()` only checks edge/node fields. To add `graph.defaultConnection` fallback, either:
- Pass the graph into `ConnectionChecker` so it can check `graph.defaultConnection`, or
- Change the `hasEdgeConnection` / `hasCaseConnection` signatures to accept the graph, or
- Have the caller pre-resolve the effective connection (but this defeats the purpose of the abstraction).

Simplest: change `ConnectionChecker` factory to `createProductionConnectionChecker(graph: Graph)` and check `graph.defaultConnection` as fallback inside `hasEdgeConnection`/`hasCaseConnection`.

### 5. Planner signature consistency

`plannerQuerySignatureService` computes signatures for cache coverage analysis. It must resolve `connectionName` the same way the actual fetch path does — otherwise cache analysis will disagree with execution. Since planner uses `selectPersistedProbabilityConfig()`, fixing that function (Phase 2) propagates to planner automatically. But the `graph.defaultConnection` fallback must also be threaded through — the planner already receives the graph, so this is straightforward.

### 6. `getAllConnections()` and UI display

After Phase 1, `getAllConnections()` returns resolved connections (inheritance applied). The `ConnectionSelector` dropdown will show `amplitude-staging` as a normal entry — users don't need to know it extends `amplitude-prod`. The description field ("Staging Amplitude analytics") distinguishes it. No special UI needed.

### 7. Nightly runner / daily automation

The `?retrieveall` automation path uses `retrieveAllSlicesService` → `dataOperationsService.getFromSource()`. Since we're fixing `getFromSourceDirect()`, the nightly runner inherits the fix. No separate code path to update.

## Implementation plan

### Phase 1: Connection inheritance

**Files to change:**
- `graph-editor/src/lib/das/types.ts` — add `extends?: string` to `ConnectionDefinition`
- `graph-editor/src/lib/das/resolveConnection.ts` (new) — shared `resolveConnection()` helper
- `graph-editor/src/lib/das/IndexedDBConnectionProvider.ts` — call `resolveConnection` in `getConnection()` and `getAllConnections()`
- `graph-editor/src/lib/das/FileSystemConnectionProvider.ts` — call `resolveConnection` in `getConnection()` and `getAllConnections()`
- `graph-editor/public/defaults/connections.yaml` — add `amplitude-staging` connection

**Tests (new file: `graph-editor/src/lib/das/__tests__/resolveConnection.test.ts`):**
- Resolves a connection without `extends` (no-op)
- Resolves a connection with `extends` — inherits all parent fields
- Child `name` is preserved (not inherited from parent)
- Child `credsRef` overrides parent `credsRef`
- Child `description` overrides parent `description`
- Deep merge of `defaults` — child adds new keys, overrides existing keys, parent keys preserved
- Atomic replace of `adapter` — child adapter replaces parent entirely
- Atomic replace of `capabilities` — child capabilities replace parent entirely
- Error: `extends` references non-existent connection
- Error: `extends` references self
- Error: `extends` references another connection that also has `extends` (no chains)
- `getAllConnections()` returns resolved connections (inheritance applied)
- `getConnection()` returns resolved connection
- `enabled: false` on child disables the connection (even if parent is enabled)
- Child with only `name` + `extends` inherits everything from parent

### Phase 2: Graph-level default connection + Graph Properties panel

**Files to change:**
- `graph-editor/src/types/index.ts` — add `defaultConnection?: string` to `ConversionGraph`
- `graph-editor/src/services/dataOperationsService.ts` — add `graph.defaultConnection` fallback in `getFromSourceDirect()` and `getParameterFromFile()`
- `graph-editor/src/services/persistedParameterConfigService.ts` — stop returning `fileParamData.connection`; resolve from graph only
- `graph-editor/src/services/fetchDataService.ts` — update `itemNeedsFetch()` to check `graph.defaultConnection`
- `graph-editor/src/services/fetchPlanBuilderService.ts` — update `createProductionConnectionChecker()` to accept graph and check `defaultConnection`
- `graph-editor/src/services/plannerQuerySignatureService.ts` — thread `graph.defaultConnection` fallback
- `graph-editor/src/services/windowFetchPlannerService.ts` — add `graph.defaultConnection` fallback
- `graph-editor/src/components/PropertiesPanel.tsx` — add Graph Properties panel fields (see table above)

**Tests (extend `graph-editor/src/services/__tests__/dataOperationsService.integration.test.ts` or similar):**
- Connection resolution order: edge.p.connection takes precedence over graph.defaultConnection
- Connection resolution: edge has no connection → falls back to graph.defaultConnection
- Connection resolution: neither edge nor graph has connection → error
- Graph.defaultConnection used for signature computation (planner agrees with executor)
- `itemNeedsFetch` returns true when edge has no connection but graph has defaultConnection
- `fetchPlanBuilder` classifies item as `'fetch'` when graph has defaultConnection
- `fetchPlanBuilder` classifies item as `'unfetchable'` when neither edge nor graph has connection
- Conditional probability: `conditional_p[i].p.connection` → base `edge.p.connection` → `graph.defaultConnection`
- Case node: `node.case.connection` → `graph.defaultConnection`
- Multiple param slots: each slot resolves independently, all fall back to graph default
- `selectPersistedProbabilityConfig` no longer returns file connection (file connection ignored)

### Phase 3: Implicit node skip logic

**Files to change:**
- `graph-editor/src/services/fetchPlanBuilderService.ts` — add `event_id` validation in `buildParameterPlanItem()` before classification. Check edge `from`/`to` nodes in graph for `event_id` when connection `requires_event_ids !== false`.

**Tests (extend `graph-editor/src/services/__tests__/fetchPlanBuilderService.test.ts` or similar):**
- Both nodes have `event_id` + connection → classified as `'fetch'`
- Both nodes lack `event_id` + connection → classified as `'unfetchable'` with reason `'no_event_ids'`
- One node has `event_id`, other doesn't + connection → classified as `'unfetchable'` with reason `'partial_event_ids'`
- Connection has `requires_event_ids: false` (e.g. Google Sheets) → skip event_id check, classified as `'fetch'`
- Bulk fetch: both structural and half-implicit edges silently skipped (expected behaviour, not a warning)
- Diagnostic logging only: information-level session log entry when diagnostic mode is on

### Phase 4: Parameter file connection cleanup

**Files to change:**
- `graph-editor/src/services/UpdateManager.ts` — remove or disable 6 file→graph connection mappings (mappings 7–12 in flow D). Keep 6 graph→file mappings (flows B CREATE + UPDATE) for provenance.
- `graph-editor/public/param-schemas/parameter-schema.yaml` — mark `connection` as provenance-only in description (keep field for backward compat)
- `graph-editor/src/services/integrityCheckService.ts` — update any checks that validate file-level connection

**Tests:**
- UpdateManager file→graph: `connection` from file no longer syncs to graph edge (even when `connection_overridden` is false)
- UpdateManager graph→file: `connection` still written to file as provenance
- Existing parameter files with `connection` field: no errors on load
- New parameter files: `connection` field written on fetch (provenance), not read for fetch config

## Risk assessment

- **Phase 1 (inheritance)**: Very low risk. `resolveConnection` runs before anything touches the connection. Downstream code sees a normal `ConnectionDefinition`. No change to hashing, caching, or UI.
- **Phase 2 (graph default)**: Low-medium risk. Changes the connection resolution order, which affects fetch behaviour. Needs careful testing of the resolution chain. Backward-compatible: existing edges have `edge.p.connection` set (synced from file), so they continue to work. Only breaks edges that relied solely on `fileParamData.connection` with no edge-level connection — rare.
- **Phase 3 (implicit skip)**: Low risk. Tightens existing error handling. The throw in `buildDslFromEdge` already catches this — we're just moving the check earlier (to plan builder) for graceful skip in bulk operations.
- **Phase 4 (file cleanup)**: Low risk but wide surface area. Touches UpdateManager sync flows. Can defer until Phase 2 is stable. Recommend keeping this as a separate PR.
