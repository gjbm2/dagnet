## Hash mapping table location + BE contract (migration plan)

---
name: Hash mappings to file
overview: Move signature equivalence/hash mappings out of the backend snapshot DB (remove the mappings table + routes) into a repo-versioned `hash-mappings.json` file. Frontend computes per-request closure sets and sends them to the backend; backend treats them as opaque inputs (no derivation, no storage).
todos:
  - id: hashfile-service
    content: Add FE hashMappingsService (file-backed) + seed hash-mappings.json in IndexedDB with committable repo-root path
    status: pending
  - id: pull-root-file
    content: Update workspaceService pull/clone filters to include repo-root hash-mappings.json
    status: pending
  - id: snapshot-manager-ui
    content: Refactor Snapshot Manager (SignatureLinksViewer/useParamSigBrowser) to read/write links from hash-mappings.json (unlink deletes rows)
    status: pending
  - id: thread-mappings-to-be
    content: Extend snapshotWriteService read/preflight requests to include FE-computed closure sets (no from/to pairs, no param_id) in request bodies
    status: pending
  - id: be-consume-closure
    content: Update BE snapshot read/preflight handlers to consume FE-provided closure sets (no DB mapping lookups) and then remove all mapping table code/routes by the end
    status: pending
  - id: tests
    content: Add/extend tests for FE closure derivation, FE request shapes, BE consumption of closure sets, and the final removal of mapping tables/routes
    status: pending
---

## Goal

- Make hash/equivalence mappings **versioned and code-controlled** by moving them from Postgres (`signature_equivalence`) into a repo-root file `hash-mappings.json`.
- Ensure the FE (planner + snapshot reads + preflight) **supplies per-request derived closure sets** to the BE by extending existing request bodies.
- Ensure Snapshot Manager UI **creates/edits/unlinks mappings by writing the file**, not by writing DB rows.
- By the end of this work: **remove the backend mappings table and all related code and routes** (no server-owned mapping storage).

## Current state (what exists today)

- **DB mapping storage** lives in Postgres tables created lazily in `graph-editor/lib/snapshot_service.py`:
  - `signature_registry` — catalogue of known `(param_id, core_hash)` pairs with canonical signature text, inputs_json, algo, creation timestamp. Written during `append_snapshots()`. Read for inventory and Snapshot Manager signature browsing. **Not related to equivalence; stays as-is.**
  - `signature_equivalence` — pairwise equivalence links between core hashes. **This is the table being moved to the file.**
- **Backend read paths** expand equivalence via SQL recursive CTEs against `signature_equivalence`:
  - `resolve_equivalent_hashes(...)` — standalone resolver; returns expanded `core_hashes` list + `param_ids` list (including `source_param_id` values).
  - Inline CTEs in `batch_anchor_coverage(...)`, `query_virtual_snapshot(...)`, `query_snapshot_retrievals(...)`.
  - `query_snapshots(...)` and `query_snapshots_for_sweep(...)` call `resolve_equivalent_hashes()` then use the expanded `core_hashes` list.
- **Backend lag recompute path** (`/api/lag/recompute-models`) queries snapshots with `include_equivalents=True` hardcoded in the handler (not read from request). Depends on DB equivalence today.
- **Snapshot Manager UI** currently creates/deactivates links via BE routes (`/api/sigs/links/*`) through `graph-editor/src/services/signatureLinksApi.ts` and `graph-editor/src/components/editors/SignatureLinksViewer.tsx`.
- **Repo pull/clone does not include root files**: `graph-editor/src/services/workspaceService.ts` filters "relevant files" to typed directories + index files + `settings/*.yaml`. Root `hash-mappings.json` would currently be ignored.
- **Dead code**: `get_snapshot_inventory` (V1) in `snapshot_service.py` is unused — the `/api/snapshots/inventory` route uses `get_batch_inventory_v2` exclusively. V1 should be removed during clean-up.

### `param_id` role in the snapshot read contract

**The snapshot read contract is `core_hash`-scoped, not `param_id`-scoped.** This is an explicit, documented design decision (see `key-fixes.md §2.2` referenced in the code):

- When `core_hash` is provided, **none** of the core read functions filter by `param_id`:
  - `query_snapshots`: `WHERE core_hash = ANY(...)` — no `param_id` clause.
  - `query_virtual_snapshot`: matches by `core_hash` (or equivalence) + slice family + retrieved_at — no `param_id` clause.
  - `query_snapshot_retrievals`: same pattern, explicit comment: *"When core_hash is provided, snapshot read identity must NOT depend on param_id bucketing (repo/branch)."*
  - `query_snapshots_for_sweep`: explicit comment: *"Snapshot reads must NOT depend on param_id bucketing."*
- When `core_hash` is **omitted**, functions fall back to `param_id` scoping (broad inventory-by-param queries). This is a different usage pattern, not the normal read path.

**`param_id` is a write-time routing/audit identifier**, not a read-time key. Data written under `param_id` "repo-main-param-x" is findable by any reader who knows the `core_hash`, regardless of which `param_id` they were working with.

**Implication for equivalence**: since reads already span all `param_id` values for a given `core_hash`, there is no need for the equivalence model to know about `param_id` at all. A user can link hash X to hash Y regardless of what `param_id`s they were historically written under — the data retrieval will find rows for both hashes across all `param_id` boundaries automatically.

### Cross-param equivalence (`source_param_id`) — analysis and decision

Today, `signature_equivalence` supports cross-param links via `source_param_id`. The original intent was to let equivalence expansion find data stored under a different `param_id`. But since the read contract already ignores `param_id` when `core_hash` is present, **`source_param_id` is solving a problem that doesn't exist for normal reads**.

Where `source_param_id` is actually used today:
- **`resolve_equivalent_hashes`**: the recursive CTE tracks `source_param_id` and returns an expanded `param_ids` list — but `query_snapshots` and `query_snapshots_for_sweep` **ignore the returned `param_ids`** and only use the expanded `core_hashes`.
- **`batch_anchor_coverage`**: the **only** function that uses expanded `param_ids` in its WHERE clause (`param_id = ANY(resolved_pids)`). This is inconsistent with the read contract — it re-introduces `param_id` scoping into what should be a `core_hash`-scoped query.
- **Snapshot Manager UI**: `source_param_id` is set when creating cross-param links in `SignatureLinksViewer`.

**Two `param_id` inconsistencies in `batch_anchor_coverage`**:
1. The snapshot WHERE clause uses `param_id = ANY(resolved_pids)`, re-introducing `param_id` scoping inconsistent with all other read paths.
2. The equivalence CTE itself scopes traversal with `WHERE e.param_id = %s`, meaning it only follows equivalence links stored under the seed `param_id`. The other CTEs (`query_virtual_snapshot`, `query_snapshot_retrievals`, `resolve_equivalent_hashes`) traverse ALL equivalence links regardless of `param_id`. This means `batch_anchor_coverage` could miss equivalence links that other functions would find.

Both inconsistencies become moot once the CTE is replaced with `core_hash = ANY(seed + equivalent_hashes)` from the FE-supplied closure set.

**Decision for this refactor**:
- **Equivalence/closure is `core_hash`-only**, consistent with the snapshot read contract. `param_id` is not part of equivalence semantics in any context.
- **Fix `batch_anchor_coverage`** to use `core_hash`-only expansion (matching the read contract used by all other query functions). This is a bug fix, not a semantic change.
- **Drop `source_param_id` from the equivalence model.** It is unnecessary given the read contract.
- **Admin/Snapshot Manager** may still *display* historic provenance (e.g. "this hash was first seen under param X"), but this is UI-only and does not affect closure derivation or any fetch behaviour.

### `include_equivalents` flag — current state and end-state

Today, most BE snapshot endpoints accept `include_equivalents` (default `true`). The FE threading:

- **Hardcoded `true`**: `querySnapshotsVirtual` (line 567), `handle_lag_recompute_models` (BE handler)
- **Default `true`**: `querySnapshotRetrievals`, `batchAnchorCoverage`, `getBatchInventoryV2`
- **Explicit `false`**: `SignatureLinksViewer` data tab (to show exact rows without expansion)
- **Not passed (implicit `true`)**: `querySnapshotsFull` (CSV downloads) — **likely a bug**; CSV downloads silently include equivalent rows

**End-state**: `include_equivalents` is **replaced by the closure set**. When a closure set is present in the request, the BE uses it to expand `core_hash`. When absent, the BE queries only for the seed `core_hash` (no expansion). The boolean `include_equivalents` flag is removed from the API contract.

The FE is responsible for deciding whether to attach a closure set or not:
- Standard fetch flows: attach closure set (replaces `include_equivalents: true`)
- Snapshot Manager data tab: do not attach closure set (replaces `include_equivalents: false`)
- CSV downloads: offer user the option of including equivalents or not (fixes the current bug where equivalents are silently included with no choice)

## Refactor shape (target contract)

- **Source of truth**: repo-root `hash-mappings.json` tracked in git.
- **File format (repo)**: stores pairwise mapping rows (edges) that the FE uses to compute closure sets. No backend-owned storage.
- **Backend contract**: snapshot read/preflight endpoints accept an optional per-request **closure set** payload (derived by FE). The backend treats this as an input list and does not compute transitive closure itself.
- **End-state**: backend has **no** `signature_equivalence` table usage, creation, reads, writes, or API routes. All mapping mutation happens by editing `hash-mappings.json`. The `include_equivalents` boolean is removed from the API contract.

### `hash-mappings.json` file schema

```json
{
  "version": 1,
  "mappings": [
    {
      "core_hash": "abc123",
      "equivalent_to": "def456",
      "operation": "equivalent",
      "weight": 1.0,
      "reason": "context change",
      "created_by": "user"
    }
  ]
}
```

Fields per mapping row:
- `core_hash` (required) — one side of the undirected equivalence edge
- `equivalent_to` (required) — other side
- `operation` (required) — `"equivalent"` for standard equivalence; other values reserved for future use (do not participate in closure)
- `weight` (required, default `1.0`) — weighting factor (currently only used for `weighted_average` operation)
- `reason` (optional) — human-readable reason for the link
- `created_by` (optional) — who created it

Not included: `param_id` (not part of equivalence semantics — see read contract above), `source_param_id` (dropped), `active` (unlink = delete row), timestamps (git history).

### Closure set payload shape (FE → BE)

Request field name: **`equivalent_hashes`**

For single-subject endpoints (`query-virtual`, `query-full`, `retrievals`):
```json
{
  "param_id": "repo-branch-param-x",
  "core_hash": "abc123",
  "equivalent_hashes": [
    { "core_hash": "def456", "operation": "equivalent", "weight": 1.0 },
    { "core_hash": "ghi789", "operation": "equivalent", "weight": 1.0 }
  ]
}
```

For `batch-anchor-coverage` (per-subject):
```json
{
  "subjects": [
    {
      "param_id": "repo-branch-param-x",
      "core_hash": "abc123",
      "equivalent_hashes": [
        { "core_hash": "def456", "operation": "equivalent", "weight": 1.0 }
      ],
      "slice_keys": ["window()"],
      "anchor_from": "2025-12-01",
      "anchor_to": "2025-12-05"
    }
  ]
}
```

For `inventory` (per-param):
```json
{
  "param_ids": ["repo-branch-param-x"],
  "current_core_hashes": { "repo-branch-param-x": "abc123" },
  "equivalent_hashes_by_param": {
    "repo-branch-param-x": [
      { "core_hash": "def456", "operation": "equivalent", "weight": 1.0 }
    ]
  }
}
```

For `lag/recompute-models` (per-subject):
```json
{
  "subjects": [
    {
      "param_id": "repo-branch-param-x",
      "core_hash": "abc123",
      "equivalent_hashes": [...]
    }
  ]
}
```

When `equivalent_hashes` is absent or empty: BE queries only for the seed `core_hash` (no expansion). This replaces `include_equivalents: false`.

### BE consumption patterns (how each query function changes)

| Current pattern | Functions | Migration to `equivalent_hashes` |
|---|---|---|
| Call `resolve_equivalent_hashes()` → use `core_hashes` list | `query_snapshots`, `query_snapshots_for_sweep` | Replace resolver call with `[seed] + [e.core_hash for e in equivalent_hashes]` |
| Inline recursive CTE → `core_hash IN (SELECT ...)` | `query_virtual_snapshot`, `query_snapshot_retrievals` | Replace CTE with `core_hash = ANY(...)` using request list |
| Load edges from DB → union-find → family grouping | `get_batch_inventory_v2` | Change union-find to consume FE-supplied edges from `equivalent_hashes_by_param` instead of DB |
| Inline CTE with `param_id` scoping + `param_id = ANY(resolved_pids)` | `batch_anchor_coverage` | Remove CTE and `param_id` expansion; use `core_hash = ANY(...)` (bug fix — aligns with read contract) |

## Implementation plan

### Stage 0) Lock invariants + add migration diagnostics (no functional change)

- **Invariants to write down and test against**:
  - When mappings exist in `hash-mappings.json`, FE-derived closure sets drive snapshot reads/preflight and produce the same outcomes as today's DB-driven equivalence.
  - When mappings do not exist (empty file), behaviour is equivalent to "no equivalence links".
  - Snapshot Manager link/unlink operations are git-versioned file edits, not backend mutations.
  - By end of refactor, backend mapping tables and routes are removed.
- **Diagnostics** (temporary, removed at the end): add session-log diagnostics around snapshot-read/preflight calls indicating whether a closure set was attached and its size. This is migration instrumentation, not product behaviour.

### Stage 1) Introduce `hash-mappings.json` as a first-class repo file (plumbing only)

- **FE file identity**:
  - `path`: `hash-mappings.json` (repo root)
  - `fileId`: stable ID (e.g. `hash-mappings`)
  - `type`: reuse an existing type that is already committable and supported by repo sync (prefer `settings`-like handling unless there is a stronger existing pattern).
- **Seed**:
  - Seed an empty `hash-mappings.json` locally if missing (clean, not dirty) so Snapshot Manager can still operate without requiring a repo edit.
- **Repo sync**:
  - Update `graph-editor/src/services/workspaceService.ts` to pull/clone repo-root `hash-mappings.json` (root files are currently not included).
  - Ensure source metadata + sha are correct so it participates in commit/pull logic like other repo files.

### Stage 2a) Create FE closure derivation service

- **New FE logic (must be tested)**: derive a deterministic, cycle-safe, transitive closure set for a seed `core_hash` using the mapping graph stored in `hash-mappings.json`.
  - Closure derivation is FE-owned; BE does not compute transitive closure.
  - Closure is `core_hash`-only (no `param_id` expansion).
  - Only rows with `operation == "equivalent"` participate in closure.
- **FE service**:
  - Create `hashMappingsService` responsible for reading the file from IndexedDB/FileRegistry and producing per-request closure sets.
  - This service is the single place in FE where closure semantics live.

### Stage 2b) Thread closure sets through FE call sites

- **Thread payloads into existing routes** — update the following FE call sites to attach `equivalent_hashes`:
  - `graph-editor/src/services/snapshotWriteService.ts`:
    - `querySnapshotsVirtual` — attach closure set (currently hardcodes `include_equivalents: true`)
    - `querySnapshotsFull` — **do not** attach closure set (fixes silent equivalence expansion bug in CSV downloads)
    - `querySnapshotRetrievals` — attach closure set when caller requests it
    - `batchAnchorCoverage` — attach closure set per subject
    - `getBatchInventoryV2` — attach `equivalent_hashes_by_param`
  - Upstream callers that currently pass `include_equivalents: true` and must switch to supplying closure sets:
    - `graph-editor/src/services/snapshotDependencyPlanService.ts` — preflight queries
    - `graph-editor/src/services/retrieveAllSlicesService.ts` — coverage preflight
    - `graph-editor/src/services/snapshotRetrievalsService.ts` — retrieval queries
    - `graph-editor/src/hooks/useEdgeSnapshotInventory.ts` — inventory lookup
  - Callers that should **not** attach closure sets (explicit no-expansion):
    - `graph-editor/src/components/editors/SignatureLinksViewer.tsx` — data tab (currently `include_equivalents: false`)
    - `graph-editor/src/hooks/useSnapshotsMenu.ts` — offer user option; attach closure set only if user opts in (fixing implicit-expansion bug)
- **Payload field name**: `equivalent_hashes` (list of `{core_hash, operation, weight}` objects).
- **Include lag recompute**:
  - `graph-editor/src/services/lagRecomputeService.ts` — attach closure set per subject when calling `/api/lag/recompute-models`.

### Stage 2c) Update BE handlers to consume closure sets

- **Update all BE snapshot handlers** in `api_handlers.py` to read `equivalent_hashes` from request body and forward to query functions.
- **Update all BE query functions** in `snapshot_service.py` to accept `equivalent_hashes` parameter and use the consumption patterns described in the table above:
  - `query_snapshots`, `query_snapshots_for_sweep`: replace `resolve_equivalent_hashes()` call with flat list from request.
  - `query_virtual_snapshot`, `query_snapshot_retrievals`: replace inline recursive CTE with `core_hash = ANY(...)`.
  - `get_batch_inventory_v2`: change union-find to consume FE-supplied edges from `equivalent_hashes_by_param` instead of loading from DB.
  - `batch_anchor_coverage`: **bug fix** — remove `param_id`-scoped CTE and `param_id = ANY(resolved_pids)` WHERE clause; use `core_hash = ANY(...)` consistent with read contract.
- **Lag recompute handler** (`handle_lag_recompute_models`): currently hardcodes `include_equivalents=True`; update to read `equivalent_hashes` from request per subject.
- **Temporary fallback**: when `equivalent_hashes` is absent, fall back to existing DB logic. Removed in Stage 4.

### Stage 3) Switch Snapshot Manager to file-backed mappings (remove BE mutations)

- Update Snapshot Manager UI and supporting hooks so:
  - Existing links are read from `hash-mappings.json` (not `/api/sigs/links/list`).
  - Create link writes a new mapping row into the file and marks it dirty in IndexedDB (so it appears in commit logic).
  - **Unlink deletes the row** from the file (repo stays clean; history is git history).
  - Any "closure" views in the UI are computed locally from the same FE closure service used for requests.
- **Migrate `useParamSigBrowser`**: this hook currently calls `resolveEquivalentHashes` (BE route `/api/sigs/resolve`). Must be migrated to use the FE closure service from `hashMappingsService`. (That BE route is deleted in Stage 4.)
- **Session logging**: all link/unlink operations must log via `sessionLogService` under an appropriate operation type (e.g. `data-update`).
- Keep signature registry browsing DB-backed (`signature_registry` table — not affected by this refactor), but remove usage of BE mapping mutation routes from the UI path.
- Optional migration-only capability (removed by end): "import current DB links into file" to ease transition in existing environments before BE routes are deleted.

### Stage 4) Make BE mapping tables and routes fully obsolete, then delete them

- **Remove temporary DB fallback** added in Stage 2c. Backend read/preflight endpoints must no longer consult any DB mapping table.
  - When `equivalent_hashes` is present, expand `core_hash` using the provided list.
  - When `equivalent_hashes` is absent/empty, query only for the seed `core_hash`.
  - Remove the `include_equivalents` parameter from all handler signatures and snapshot service functions.
- **Remove backend mapping functionality completely**:
  - Remove `signature_equivalence` table creation from `_ensure_flexi_sig_tables()` (keep `signature_registry` creation).
  - Remove all SQL that references `signature_equivalence` (recursive CTEs, joins, inserts, updates).
  - Remove mapping-related backend functions (`resolve_equivalent_hashes`, `create_equivalence_link`, `deactivate_equivalence_link`, `list_equivalence_links`).
  - Remove dead code: `get_snapshot_inventory` (V1) — unused, the route uses V2 exclusively.
  - Remove mapping-related API routes and handlers:
    - `/api/sigs/links/list`
    - `/api/sigs/links/create`
    - `/api/sigs/links/deactivate`
    - `/api/sigs/resolve`
  - Remove FE client methods/tests that call these routes:
    - `signatureLinksApi.ts`: remove `listEquivalenceLinks`, `createEquivalenceLink`, `deactivateEquivalenceLink`, `resolveEquivalentHashes` (keep `listSignatures`, `getSignature` — these use `/api/sigs/list` and `/api/sigs/get` which read from `signature_registry`, not equivalence).
    - `signatureLinksApi.test.ts`: remove tests for deleted functions.
- **Compatibility cliff**:
  - Before deleting routes/tables, ensure the file is reliably present and the FE is reliably sending closure sets in all relevant flows (retrieve-all, asat reads, inventory, retrievals UI).

### Stage 5) Clean-up and docs

- Remove temporary migration diagnostics and any temporary import tooling.
- Remove `include_equivalents` from all FE service interfaces and BE handler signatures.
- Update technical docs to reflect the new contract (FE owns mappings, git file store is source of truth, BE consumes closure sets).

## Test plan (describe, don't weaken)

### FE tests: closure derivation (new logic)
- Add a dedicated test suite for the FE closure logic (best home: tests for `hashMappingsService`):
  - Transitive closure (multi-hop) correctness.
  - Cycle handling (termination, determinism).
  - Deterministic ordering of derived closure sets (to avoid request churn).
  - Operation filtering rules used for equivalence closure (only `operation == "equivalent"` participates).
  - Unlink semantics: deleting a mapping row removes the equivalence immediately.

### FE tests: service integration with file store
- Write `hash-mappings.json` to IDB via FileRegistry → call `hashMappingsService.getClosureSet(seed)` → verify correct closure result. This tests the service reads from the file store correctly, not just the algorithm in isolation.

### FE tests: seed/init
- On fresh workspace init (no file in repo), verify the seed creates the file in IDB with correct structure (`{ version: 1, mappings: [] }`), and it is clean (not dirty).

### FE integration tests: request shapes
- Extend existing snapshot request tests (and/or add a focused service integration test) to verify:
  - Each relevant snapshot read/preflight request includes `equivalent_hashes` when mappings exist.
  - When mappings do not exist (empty file), `equivalent_hashes` is omitted (and behaviour matches "no equivalents").
  - `querySnapshotsFull` (CSV downloads) includes `equivalent_hashes` only when user explicitly opts in (verifies fix for implicit-expansion bug).
  - `getBatchInventoryV2` correctly sends `equivalent_hashes_by_param` with the right structure (different from per-subject payloads).

### BE tests: consuming closure sets
- **Positive expansion test**: given `equivalent_hashes = [{core_hash: Y, ...}]` in the request, verify the query returns rows for BOTH the seed hash AND hash Y.
- **No-expansion test**: when `equivalent_hashes` is absent/empty, verify that equivalent data is NOT returned (even if equivalence links exist in the DB during migration or file). This is the replacement for `include_equivalents: false`.
- **Inventory union-find test**: verify that FE-supplied `equivalent_hashes_by_param` produces the same family groupings as the old DB-driven approach for an equivalent set of edges.
- Update Python tests in `graph-editor/lib/tests/` that currently create DB equivalence links (e.g. `test_batch_anchor_coverage.py`, `test_snapshot_read_integrity.py`) to instead supply FE-style closure sets via `equivalent_hashes` parameter.
- Add a strict regression test that fails if the backend code path still references the `signature_equivalence` table or mapping routes exist after Stage 4.
- Add a regression test that fails if `batch_anchor_coverage` can return `coverage_ok=true` in a scenario where `query_snapshots` would return zero rows for the same subject (guards against reintroducing `param_id`-based scoping in what should be a `core_hash`-scoped query).

### Repo sync tests
- Extend workspace sync tests so `workspaceService.pullLatest` includes repo-root `hash-mappings.json` and hydrates it correctly into IndexedDB/FileRegistry.

### End-to-end verification checklist (manual)
After all stages are complete, verify the full flow works end-to-end:
1. Create a mapping in Snapshot Manager → file marked dirty in IndexedDB.
2. Commit the file → pushed to repo.
3. Pull on a different workspace → `hash-mappings.json` hydrated from repo.
4. Run a fetch (Retrieve All or single-edge) with equivalence → correct data returned using expanded hashes.
5. Unlink a mapping → row deleted from file → equivalence no longer applies.

## Key files to touch

- FE (closure derivation + request threading)
  - `graph-editor/src/services/snapshotWriteService.ts` — add `equivalent_hashes` to request bodies
  - `graph-editor/src/services/snapshotDependencyPlanService.ts` — supply closure sets
  - `graph-editor/src/services/retrieveAllSlicesService.ts` — supply closure sets for coverage preflight
  - `graph-editor/src/services/snapshotRetrievalsService.ts` — supply closure sets
  - `graph-editor/src/services/lagRecomputeService.ts` — supply closure sets for recompute subjects
  - `graph-editor/src/hooks/useEdgeSnapshotInventory.ts` — supply closure sets for inventory
  - `graph-editor/src/hooks/useSnapshotsMenu.ts` — offer user option to include equivalents; attach closure set only if user opts in (fix implicit-expansion bug)
  - New: `graph-editor/src/services/hashMappingsService.ts` — closure derivation service
  - New: `graph-editor/src/init/seedHashMappings.ts` — seed empty file on init
- FE (repo sync)
  - `graph-editor/src/services/workspaceService.ts` — include root `hash-mappings.json` in pull/clone
- FE (Snapshot Manager migration)
  - `graph-editor/src/components/editors/SignatureLinksViewer.tsx` — file-backed link/unlink, dirty marking, session logging
  - `graph-editor/src/hooks/useParamSigBrowser.ts` — migrate from BE resolve to FE closure
  - `graph-editor/src/services/signatureLinksApi.ts` — remove equivalence functions by end; keep `listSignatures`, `getSignature`
- BE
  - `graph-editor/lib/api_handlers.py` — consume `equivalent_hashes`; remove `include_equivalents`; remove mapping routes
  - `graph-editor/lib/snapshot_service.py` — consume `equivalent_hashes` in query functions; remove `signature_equivalence` table + all related SQL/functions; fix `batch_anchor_coverage` to use `core_hash`-only expansion; remove dead `get_snapshot_inventory` V1
