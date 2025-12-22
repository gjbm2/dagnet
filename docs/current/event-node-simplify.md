## Event → Node Simplification (remove Events as a first-class object type)

**Date:** 22-Dec-25  
**Owner:** DagNet  
**Status:** Hard refactor spec (no compatibility shims; prose-only)

### Goal

Remove **Events** as a first-class file/object type in DagNet, based on the emerging reality that **event definitions do not materially vary from node definitions** in practice. Move the useful event fields onto **node files**, perform a **one-off migration** for existing workspaces/repos, and then simplify the app’s data model accordingly.

This is intended to reduce:

- duplication (two registries describing the same conceptual thing),
- cognitive load (node ⇄ event linking),
- indexing/dirty tracking surface area (another index file type),
- and edge-case failures in query compilation and adapter payload formation.

### Non-goals

- Preserving backwards compatibility with unmigrated repos indefinitely.
- Introducing a second “compatibility” code path. Migration is explicit, one-off, and mandatory.

### Hard refactor stance (explicit)

This work is a **hard refactor**:

- We will **remove Events completely** from the system (schemas, file types, indexes, UI, services).
- We will perform a **single migration** on the (single) active repo and commit the resulting diff.
- After migration, the app should **fail fast** if it detects:
  - any event artefacts (for example `events-index.yaml` or `events/*.yaml`), or
  - a graph/node configuration that violates the new invariants (see “Post-migration invariants”).

No silent fallback behaviour is desired after the cutover.

### Current state (what exists today)

#### Registry / file types

- **Node files** live under `nodes/` and are indexed by `nodes-index.yaml`.
  - Schema: `graph-editor/public/param-schemas/node-schema.yaml`
  - Node files already include `event_id` (string), plus `id`, `name`, `description`, `tags`, `metadata`.
- **Event files** live under `events/` and are indexed by `events-index.yaml`.
  - Schemas:
    - `graph-editor/public/param-schemas/event-schema.yaml`
    - `graph-editor/public/param-schemas/events-index-schema.yaml`
  - Event files store the “richer” analytics-facing metadata:
    - provider-specific event names (`provider_event_names`)
    - Amplitude property filters (`amplitude_filters`)
    - category/tags/metadata
- The app’s file-type registry includes an explicit `event` type:
  - `graph-editor/src/config/fileTypeRegistry.ts`
- The unified `registryService` supports `event` items alongside `parameter/context/case/node`:
  - `graph-editor/src/services/registryService.ts`

#### Graph schema / runtime usage

- Graph nodes (TypeScript) include `event_id` and `event_id_overridden`:
  - `graph-editor/src/types/index.ts` (`GraphNode.event_id`)
- The data retrieval flow uses `event_id` and event definitions:
  - `graph-editor/src/lib/das/buildDslFromEdge.ts`
    - Parses `edge.query` (node-id references)
    - Resolves node references to graph nodes
    - Extracts `node.event_id` values
    - Loads event file data and returns:
      - a `queryPayload` with `from/to/visited/...` as event IDs
      - `eventDefinitions` keyed by event ID (for adapters)
  - `graph-editor/src/services/dataOperationsService.ts`
    - Builds `eventDefinitions` by loading `event-${eventId}` files from the in-memory registry
    - Passes `eventDefinitions` to adapter execution paths
    - Contains logic to merge `eventDefinitions` from `n_query` into the primary set
      - Test that documents this: `graph-editor/src/services/__tests__/nQueryEventDefinitions.test.ts`

#### Persistence and indexing surface area

- Workspaces include events in clone/pull bookkeeping:
  - `graph-editor/src/services/workspaceService.ts` (directories + index file list include events)
- Index rebuild/repair includes events:
  - `graph-editor/src/services/indexRebuildService.ts` (types with indexes include `event`)
  - Corresponding tests mention `event` as an indexed type:
    - `graph-editor/src/services/__tests__/indexRebuild.critical.test.ts`
    - `graph-editor/src/services/__tests__/indexOperations.integration.test.ts`

#### Python schema/types parity

- Python graph types include both a direct `event_id` and an `event` reference model:
  - `graph-editor/lib/graph_types.py` (`Node.event_id`, `Node.event`)

### The simplifying hypothesis (what we believe is true)

In real repos/workflows:

- Each node that participates in analytics retrieval effectively corresponds to exactly one “event definition”.
- That “event definition” is not reused across multiple nodes in a meaningful way.
- The event metadata that matters (provider name mapping, provider filters) is conceptually a property of the node’s analytics identity, and therefore belongs on the node file.

If this holds, then the event registry is an unnecessary indirection: it adds maintenance overhead (extra files + index), and produces failure modes (missing event file, stale index, definitions not merged, etc.) without providing true reuse.

### Pre-migration validation (must be done before deleting Events)

We need to prove (or explicitly bound) the hypothesis with repo-wide checks. The plan assumes we will categorise any findings into “supported” vs “must be handled”.

Validation questions:

- **Uniqueness:** Does any `event_id` appear in more than one node file (or more than one graph node)? If yes, is that intentional reuse or accidental duplication?
- **Completeness:** Does every node’s `event_id` have a corresponding event definition today?
  - If not, does the system rely on fallback behaviour (raw `event_id` only)?
- **Orphans:** Are there event files that are not referenced by any node?
  - If yes, are they genuinely unused, or are they referenced indirectly somewhere else?
- **Identity mismatch:** Where node `id` differs from `event_id` (common), confirm there is still a 1:1 mapping at the conceptual level.
- **Provider-specific fields usage:**
  - Which adapters actually consult `provider_event_names` and `amplitude_filters`?
  - Are there provider-specific fields beyond Amplitude that would be lost?

Deliverable from this validation step:

- A written list of exceptions (if any) and how each will be handled in migration.

### Target state (post-simplification)

#### Data model

- **No `event` object type** in the app:
  - No event tabs, no event creation/editing, no event entries in the navigator.
- **No event index file** (`events-index.yaml`) and no event file schema.
- **Node files become the single source of truth** for analytics event metadata.

Recommended mapping (minimal change, low-risk):

- Keep `event_id` on nodes as the canonical “analytics event identifier” used in query payloads.
- Add the following fields to the node file schema (and store them in node YAML):
  - provider-specific event naming (`provider_event_names`)
  - provider filters (`amplitude_filters`, and any other provider-specific filter blocks currently in event schema)
  - optional event categorisation fields currently only in events (if they are used by UI or workflows)

Key behaviour change:

- `eventDefinitions` passed to adapters will be derived from **node files**, not event files.
  - `eventDefinitions` remains keyed by `event_id` to avoid adapter churn.

#### Code surface area to remove

- `event` from `ObjectType` (TypeScript) and any UI rendering paths.
- `event` from `FILE_TYPE_REGISTRY` and workspace clone/index logic.
- `events-index.yaml` handling across workspace/index rebuild services.
- Event-specific schema artefacts in `graph-editor/public/param-schemas/`.

### One-off migration strategy (repo/workspace)

We want one migration path, executed deliberately, producing a clean git diff that can be committed.

#### Migration input

- Existing node files containing `event_id`.
- Existing event files keyed by event ID, containing provider mappings/filters and metadata.

#### Migration output

For each node file with an `event_id`:

- Copy the relevant fields from the corresponding event definition onto the node file.
- Preserve node identity (`node.id`) and keep `node.event_id` unchanged unless a deliberate renaming decision is made.
- Mark the node file dirty so it is included in commit.

After nodes are enriched:

- Remove event files from the workspace (and from git if running migration directly against repo contents).
- Remove `events-index.yaml`.
- Ensure `nodes-index.yaml` remains correct (and rebuild if required).

#### Handling exceptions

The plan must explicitly handle these cases:

- **Node has `event_id` but no event definition exists:** keep `event_id`, leave provider mappings empty, optionally record a migration warning.
- **Event definition exists but is referenced by multiple nodes:** either:
  - duplicate the event fields into both nodes (if acceptable), or
  - stop migration with a clear error requiring manual resolution.
- **Event definitions with no referencing node:** either:
  - stop migration (if these are expected to remain), or
  - discard as unused (preferred if they are truly unreferenced).

### Implementation plan (phased, traceable)

#### Phase A — Confirm invariants and lock the target node schema

Files to inspect and document findings:

- `graph-editor/public/param-schemas/node-schema.yaml`
- `graph-editor/public/param-schemas/event-schema.yaml`
- Representative repos/workspaces (real, not just fixtures)

Decisions to lock:

- Whether we keep `event_id` field name, or rename it (renaming is higher-risk).
- Which event fields become node fields (minimum: `provider_event_names`, `amplitude_filters`).
- Whether any fields from `events-index.yaml` matter post-migration (category, tags).

#### Phase B — Schema updates (move event fields onto node schema)

Planned edits:

- Update `graph-editor/public/param-schemas/node-schema.yaml` to include the migrated event fields.
- Remove or deprecate (by deletion) `graph-editor/public/param-schemas/event-schema.yaml` and `events-index-schema.yaml` once all call sites are removed.
- Update any schema consistency checks that assert parity between UI schemas and param schemas:
  - `graph-editor/src/services/__tests__/schemaTypesConsistency.test.ts`
  - `graph-editor/src/services/__tests__/schemaUiSchemaConsistency.test.ts`

Note on tests:

- These are existing tests; changing them requires explicit authorisation before edits are applied.

#### Phase C — Refactor data retrieval to source definitions from nodes (no Events)

Primary goal: preserve adapter contracts while deleting event-file dependency.

Definition of “adapter contract” in this context:

- Downstream execution currently expects an `eventDefinitions` map keyed by **event ID** (the value of `node.event_id`).
- Adapters and composite query execution may consult:
  - provider name mapping (for example `provider_event_names`)
  - provider filters (for example `amplitude_filters`)

We keep the shape of that map stable, but we populate it from **node YAML**.

Planned edits (high level):

- Update `graph-editor/src/lib/das/buildDslFromEdge.ts`:
  - stop loading event files by `event-${eventId}`
  - instead, load node files for the nodes referenced by the query (resolved via the graph)
  - build `eventDefinitions` from node-file fields, keyed by `node.event_id`
- Update `graph-editor/src/services/dataOperationsService.ts`:
  - remove the “event loader” that reads `event-*` files
  - replace with a “node definition loader” that reads `node-*` files and projects to the adapter’s expected definition shape
  - keep the `n_query` merge behaviour, but now merging node-derived definitions
- Confirm all downstream execution paths still receive a complete definitions map:
  - `graph-editor/src/lib/das/compositeQueryExecutor.ts` (consumes `eventDefinitions` when compiling/expanding queries)
- Ensure session logging remains correct for migration-adjacent operations (no silent failures):
  - `graph-editor/src/services/sessionLogService.ts` call sites should record migration warnings/errors

#### Phase D — Remove Events as a first-class file type

Planned edits:

- Remove `event` from `ObjectType` and any UI assumptions:
  - `graph-editor/src/types/index.ts`
  - Navigator sections and selectors if they still display events
- Remove `event` from `graph-editor/src/config/fileTypeRegistry.ts` and any index-type entries for events.
- Remove event handling from workspace sync/clone and remote-ahead checks:
  - `graph-editor/src/services/workspaceService.ts` (directories and index file lists)
- Remove event handling from index rebuild/repair services:
  - `graph-editor/src/services/indexRebuildService.ts` (types processed, index file creation, plural naming logic)
- Remove event handling from index maintenance in file CRUD paths:
  - `graph-editor/src/services/fileOperationsService.ts` (index updates for create/rename/delete and event-specific index entry fields)
- Remove event handling from registry aggregation:
  - `graph-editor/src/services/registryService.ts` (do not expose `getEvents`, and do not treat `event-index` as a thing)
- Remove event validation and orphan detection logic (and replace with node-based checks where appropriate):
  - `graph-editor/src/services/integrityCheckService.ts`

#### Phase E — One-off migration (repo-level, then delete Events)

We have a single active repo; the simplest hard-refactor workflow is:

- Pull the repo locally.
- Run a one-off migration tool over the working tree.
- Commit and push the result.
- Upgrade the app to the post-Events version (which will hard error if event artefacts exist).

Migration requirements:

- For each node file:
  - if it has `event_id`, copy event-definition fields from the matching event file into the node file
  - if the matching event file does not exist, the migration must decide explicitly:
    - either stop with an error, or
    - allow missing definitions (but then node schema must treat migrated fields as optional)
- After copying:
  - delete `events-index.yaml`
  - delete `events/*.yaml`
  - ensure `nodes-index.yaml` remains correct (rebuild if required)

Migration output must be a clean git diff that can be reviewed and reverted.

#### Phase F — Python model parity updates

Planned edits:

- Update `graph-editor/lib/graph_types.py`:
  - remove or simplify `EventReference` and `Node.event` if it no longer exists in the graph schema
  - ensure `Node.event_id` remains supported (or renamed if that decision is taken)
- Update Python schema parity tests if they currently require event types.
  - Any edits to existing tests require explicit authorisation.

### Testing plan (scenarios, not code)

#### Migration correctness

- Migrating a workspace with nodes and events produces node files that now contain:
  - provider mappings previously only present in event files
  - provider filters previously only present in event files
- After migration:
  - event files are removed
  - `events-index.yaml` is removed
  - the workspace shows dirty node files and (if applicable) dirty `nodes-index.yaml`
  - committing includes the modified node files and index changes

#### Query execution correctness

- Building query payloads from `edge.query` still resolves:
  - `from/to` event IDs correctly via `node.event_id`
  - `visited` and `visited_upstream` categorisation unchanged
- Adapter receives a complete definitions map that includes definitions for:
  - base query events
  - `n_query` events
  - any visited/excluded events

#### Index integrity and dirty tracking

- Index rebuild does not mention or attempt to maintain an events index.
- Dirty tracking still relies on IndexedDB, not in-memory registry, for commit.

#### UI regression checks

- Navigator does not show Events.
- No “open event” actions remain (selector buttons, context menus, tabs).

### Rollout and safety

Recommended rollout order:

- Implement migration + node schema support first.
- Run migration on target repos/workspaces and commit the results.
- Only then remove event support from the app.

Guardrails:

- If the app detects an unmigrated repo/workspace (presence of `events-index.yaml` or `events/*.yaml`), it should **fail fast** with a clear message instructing the user to migrate.
- If query execution requires node-derived event metadata (provider mappings/filters) and it is missing for a referenced `event_id`, it should **fail fast** with actionable guidance (and should not silently fall back to the raw ID unless we explicitly choose to keep that as a supported invariant).

Rollback:

- Rollback is by git revert on the migrated repo commit (restoring event files and index) plus using the last app version that still supports events.

### Open questions / decision points for approval

- Should `event_id` be renamed to something less “registry-like” (for example, “analytics event id”)? This is cleaner but higher-risk.
- Do we need to preserve any event-only categorisation fields (category/tags) beyond what nodes already carry?
- How should we handle any event definitions that exist without a node reference (stop migration vs discard)?

### Post-migration invariants (hard errors)

After the cutover, the system must enforce:

- **No event files**: `events/` directory does not exist (or is empty) in the repo basePath.
- **No events index**: `events-index.yaml` does not exist.
- **Graph nodes remain keyed by `event_id`** for query formation:
  - Any graph node referenced by an `edge.query` must have `event_id` set.
- **Node files are the sole source of event metadata**:
  - If adapters require provider mappings or filters, that data must be present on node files (or the system errors, depending on the chosen strictness).

### Exhaustive change inventory (files surfaced by search)

This is the **current exhaustive inventory** of files that reference event concepts or event-metadata fields (as of 22-Dec-25), based on repository search for:

- `event_id`, `provider_event_names`, `amplitude_filters`
- `event-schema.yaml`, `events-index-schema.yaml`, `events-index.yaml`
- the `event` file/object type

This inventory is meant to prevent “hidden” call sites from surviving the refactor. It is split into:

- **Must change**: these files will change in the hard refactor.
- **Must verify**: these files may be removed/adjusted depending on exact cutover decisions (but they were surfaced by search and must be checked).

#### Must change (core runtime + schemas)

- `graph-editor/public/param-schemas/node-schema.yaml`
- `graph-editor/public/param-schemas/event-schema.yaml` (deleted)
- `graph-editor/public/ui-schemas/event-ui-schema.json` (deleted)
- `graph-editor/src/types/index.ts`
- `graph-editor/src/config/fileTypeRegistry.ts`
- `graph-editor/src/lib/das/buildDslFromEdge.ts`
- `graph-editor/src/lib/das/compositeQueryExecutor.ts`
- `graph-editor/src/services/dataOperationsService.ts`
- `graph-editor/src/services/fileOperationsService.ts`
- `graph-editor/src/services/registryService.ts`
- `graph-editor/src/services/workspaceService.ts`
- `graph-editor/src/services/indexRebuildService.ts`
- `graph-editor/src/services/integrityCheckService.ts`
- `graph-editor/lib/graph_types.py`

#### Must verify / then remove or update (UI + theming)

- `graph-editor/src/theme/objectTypeTheme.ts`
- `graph-editor/src/components/PropertiesPanel.tsx`
- `graph-editor/src/components/NodeContextMenu.tsx`
- `graph-editor/src/components/nodes/ConversionNode.tsx`

#### Must verify / then delete or update (tests)

These were surfaced by search; whether they are deleted or rewritten depends on what they’re asserting. **Edits to existing tests require explicit authorisation**.

- `graph-editor/src/services/__tests__/schemaTypesConsistency.test.ts`
- `graph-editor/src/services/__tests__/schemaUiSchemaConsistency.test.ts`
- `graph-editor/src/services/__tests__/nQueryEventDefinitions.test.ts`
- `graph-editor/src/services/__tests__/commitModal.critical.test.ts`
- `graph-editor/src/services/__tests__/indexRebuild.critical.test.ts`
- `graph-editor/src/services/__tests__/indexOperations.integration.test.ts`
- `graph-editor/src/services/__tests__/UpdateManager.graphToGraph.test.ts`
- `graph-editor/src/services/__tests__/dataOperationsService.integration.test.ts`
- `graph-editor/src/services/__tests__/dataOperationsService.openEndedWindowResolution.test.ts`
- `graph-editor/src/services/__tests__/dataOperationsService.incrementalGapPersistence.test.ts`
- `graph-editor/src/services/__tests__/dataOperationsService.persistedConfigByMode.test.ts`
- `graph-editor/src/services/__tests__/batchFetchE2E.comprehensive.test.ts`
- `graph-editor/src/services/__tests__/multiSliceCache.e2e.test.ts`
- `graph-editor/src/services/__tests__/conditionalProbability.integration.test.ts`
- `graph-editor/src/services/__tests__/versionedFetchFlow.e2e.test.ts`
- `graph-editor/src/services/__tests__/fileOperations.integration.test.ts`
- `graph-editor/src/services/__tests__/sampleFilesIntegrity.test.ts`
- `graph-editor/src/services/__tests__/sampleDataIntegrity.test.ts`
- `graph-editor/src/services/__tests__/fullE2EMultiSlice.integration.test.tsx`
- `graph-editor/src/services/__tests__/parameterCache.e2e.test.ts`
- `graph-editor/src/services/__tests__/anchorNodeComputation.test.ts`
- `graph-editor/src/services/__tests__/pathT95GraphIsAuthoritative.cohortBounding.test.ts`
- `graph-editor/src/services/__tests__/cohortConversionWindowPropagation.test.ts`
- `graph-editor/src/services/__tests__/copyPasteOperations.test.ts`
- `graph-editor/src/services/__tests__/helpers/testFixtures.ts`
- `graph-editor/src/services/UpdateManager.test.ts`

#### Must verify / then update or delete (docs + schemas outside param-schemas)

- `graph-editor/public/docs/data-connections.md`
- `graph-editor/public/schemas/conversion-graph-1.1.0.json`
- `graph-editor/public/schemas/conversion-graph-1.0.0.json`
- `graph-editor/public/defaults/connections.yaml`


