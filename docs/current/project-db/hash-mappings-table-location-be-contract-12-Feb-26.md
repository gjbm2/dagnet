## Hash mapping table location + BE contract (migration plan)

---
name: Hash mappings to file
overview: Move signature equivalence/hash mappings out of the backend snapshot DB (remove the mappings table + routes) into a repo-versioned `hash-mappings.json` file. Frontend computes per-request closure sets and sends them to the backend; backend treats them as opaque inputs (no derivation, no storage).
todos:
  - id: hashfile-service
    content: Add FE hashMappingsService (file-backed) + seed hash-mappings.json in IndexedDB with committable repo-root path
    status: done
  - id: pull-root-file
    content: Update workspaceService pull/clone filters to include repo-root hash-mappings.json
    status: done
  - id: snapshot-manager-ui
    content: Refactor Snapshot Manager (SignatureLinksViewer/useParamSigBrowser) to read/write links from hash-mappings.json (unlink deletes rows)
    status: done
  - id: thread-mappings-to-be
    content: Extend snapshotWriteService read/preflight requests to include FE-computed closure sets (no from/to pairs, no param_id) in request bodies
    status: done
  - id: be-consume-closure
    content: Update BE snapshot read/preflight handlers to consume FE-provided closure sets (no DB mapping lookups when present) — DB fallback retained until post-release
    status: done
  - id: tests
    content: Add/extend tests for FE closure derivation, FE request shapes, BE consumption of closure sets, repo sync, and the final removal of mapping tables/routes
    status: done
  - id: remaining-cleanup
    content: All code removal, route removal, include_equivalents removal, CSV opt-in, regression tests — DONE. Only remaining item is dropping the DB table post-release.
    status: done
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

## Implementation progress

### Stage 1) Introduce `hash-mappings.json` as a first-class repo file — DONE

- **FE file identity**: `path: hash-mappings.json` (repo root), `fileId: hash-mappings`, `type: hash-mappings` (ObjectType in `types/index.ts`, entry in `fileTypeRegistry.ts` with `supportsRawEdit: true`).
- **Seed**: `seedHashMappings.ts` creates empty `{version:1, mappings:[]}` in IDB if missing (clean, not dirty).
- **Repo sync**: `workspaceService.ts` updated to pull/clone repo-root `hash-mappings.json` in `checkRemoteAhead`, `cloneWorkspace`, `pullLatest`, `pullAtCommit`. JSON parsing handled.
- **Pull bug fix**: new files from pull were not added to FileRegistry (only IDB). Fixed: pull now always adds to the in-memory FileRegistry map, not just when the file already exists. Test added in `workspaceService.integration.test.ts`.
- **DB export/migration**: active equivalence rows exported from `signature_equivalence` (scoped to the data repo's `main` branch) and committed to the data repo as `hash-mappings.json` with 2 real mapping rows.
- **Snapshot Manager tab refactored**: tab now backed by the `hash-mappings` file (same pattern as Settings/Credentials). `signatureLinksTabService` opens `hash-mappings` instead of temporary `signature-links`. Right-click → "View JSON/YAML" on the tab shows the actual mappings file content. `EditorRegistry` maps `hash-mappings` → `SignatureLinksViewer` for interactive mode.

### Stage 2a) Create FE closure derivation service — DONE

- Implemented in `hashMappingsService.ts`: BFS closure, deterministic sort, cycle-safe, `operation === 'equivalent'` filter, mutation helpers.
- 16 tests in `hashMappingsService.test.ts`: multi-hop, cycles, diamonds, ordering, operation filtering, self-links, empty file, add/remove/unlink, IDB integration.

### Stage 2b) Thread closure sets through FE call sites — DONE

- `snapshotWriteService.ts`: all 5 read functions accept `equivalent_hashes` / `equivalent_hashes_by_param`. `include_equivalents` removed from all interfaces.
- Upstream callers: `snapshotDependencyPlanService`, `retrieveAllSlicesService`, `snapshotRetrievalsService`, `lagRecomputeService` all supply `getClosureSet(coreHash)`.
- `useEdgeSnapshotInventory`: calls `getBatchInventoryV2` without equivalence params (tooltip shows total stats — correct behaviour).
- CSV download (`useSnapshotsMenu`): offers user opt-in dialog when hash has equivalents; passes `equivalent_hashes` only when user opts in.
- 10 EH-* request-shape tests in `snapshotWriteService.test.ts` verify correct request bodies for all 5 endpoints (with and without closure).

### Stage 2c) Update BE handlers to consume closure sets — DONE

- All 6 BE handlers in `api_handlers.py` extract `equivalent_hashes` (or `_by_param`) and forward.
- All BE query functions in `snapshot_service.py` accept `equivalent_hashes`, expand using FE-supplied list.
- `batch_anchor_coverage` bug fix: removed `param_id`-scoped CTE and `param_id = ANY(resolved_pids)` clause.
- 12 FC-*/RG-* tests in `test_fe_closure_consumption.py`: positive expansion, no-expansion, empty closure, retrievals, batch anchor coverage (with/without closure, cross-param), inventory union-find from FE edges, DB bypass verification, cross-param expansion, BAC parity regression, structural regression (no `signature_equivalence` in production code).

### Stage 3) Switch Snapshot Manager to file-backed mappings — DONE

- `useParamSigBrowser.ts`: reads mappings from `getMappings()`, resolves closure via `getClosureSet()`. Broad workspace registry lookup (`listSignatures({ param_id_prefix })`) builds `hashToParamId` map so cross-param link navigation works.
- `SignatureLinksViewer.tsx`: link/unlink uses `addMapping()`/`removeMapping()` (file writes, not BE routes). Cross-param navigation checks `registryRows` before deciding same-param vs cross-param vs orphan. Data tab async race condition fixed (abort flag prevents phantom records from stale fetches).
- Session logging: `HASH_MAPPING_CREATE` / `HASH_MAPPING_REMOVE`.
- Signature registry browsing remains DB-backed (`/api/sigs/list`).

### Stage 4) Remove DB fallback, stale code, and routes — DONE

All completed:
- Removed 4 equivalence functions from `snapshot_service.py` (DB helpers retained as test-only in test files for legacy regression coverage until table is dropped).
- Removed `signature_equivalence` table creation from `_ensure_flexi_sig_tables()`.
- Removed dead `get_snapshot_inventory` V1.
- Removed 4 handler functions and 4 routes from `api_handlers.py`, `dev-server.py`, `python-api.py`.
- Removed dead FE functions from `signatureLinksApi.ts` (kept `listSignatures`, `getSignature`).
- Removed `include_equivalents` from all FE service interfaces and all BE query/handler signatures.
- CSV download equivalence opt-in added (`useSnapshotsMenu.ts` shows dialog when hash has equivalents).
- Converted all legacy BE tests to use `equivalent_hashes` parameter instead of DB-driven expansion.
- Added regression tests: BAC parity (RG-001), structural guard against `signature_equivalence` in production code (RG-002).

### Stage 5) Clean-up and docs — DONE

- Design doc updated to reflect completed state.
- No temporary migration diagnostics were added (no cleanup needed).

## Test coverage summary

| Suite | File | Tests | What it covers |
|---|---|---|---|
| FE closure algorithm | `hashMappingsService.test.ts` | 16 | Transitive closure, cycles, diamonds, ordering, operation filtering, CRUD, IDB integration |
| FE request shapes | `snapshotWriteService.test.ts` | 31 | Write path (21 existing) + 10 EH-* tests for equivalent_hashes in all 5 read endpoints |
| FE repo sync | `workspaceService.integration.test.ts` | 8 | Pull → IDB → FileRegistry → getMappings() chain for hash-mappings.json |
| FE signature API | `signatureLinksApi.test.ts` | 2 | listSignatures payload + list_params mode |
| BE closure consumption | `test_fe_closure_consumption.py` | 12 | FC-001–010 + RG-001–002: positive/negative expansion, cross-param, inventory union-find, DB bypass, BAC parity, structural guard |
| BE read integrity | `test_snapshot_read_integrity.py` | 48 | Read paths + converted equivalence tests (now use equivalent_hashes) + legacy DB helpers for table-level regression |
| BE batch anchor coverage | `test_batch_anchor_coverage.py` | 16 | Coverage queries + converted equivalence tests (now use equivalent_hashes) |
| BE structural | `test_api_route_parity.py` + `test_backend_decoupling.py` | 4 | Route parity, no frontend deps |

**Total: 195 tests (115 FE + 80 BE), all passing.**

## Remaining work (sole remaining item)

1. **Drop `signature_equivalence` DB table** — do this in a separate migration after production release and verification. When dropped, also delete the test-only DB helpers (`create_equivalence_link`, `deactivate_equivalence_link`, `resolve_equivalent_hashes`) from `test_snapshot_read_integrity.py` and `test_batch_anchor_coverage.py`, and remove any tests that exercise them (TestTierC c006/c007/c008, TestTierD d001–d006, TestCrossParamDataContract d007).

## Key files to touch

- FE (closure derivation + request threading)
  - `graph-editor/src/services/snapshotWriteService.ts` — add `equivalent_hashes` to request bodies
  - `graph-editor/src/services/snapshotDependencyPlanService.ts` — supply closure sets
  - `graph-editor/src/services/retrieveAllSlicesService.ts` — supply closure sets for coverage preflight
  - `graph-editor/src/services/snapshotRetrievalsService.ts` — supply closure sets
  - `graph-editor/src/services/lagRecomputeService.ts` — supply closure sets for recompute subjects
  - `graph-editor/src/hooks/useEdgeSnapshotInventory.ts` — supply closure sets for inventory
  - `graph-editor/src/hooks/useSnapshotsMenu.ts` — offer user option to include equivalents; attach closure set only if user opts in (fix implicit-expansion bug)
  - `graph-editor/src/services/hashMappingsService.ts` — closure derivation service
  - `graph-editor/src/init/seedHashMappings.ts` — seed empty file on init
- FE (repo sync)
  - `graph-editor/src/services/workspaceService.ts` — include root `hash-mappings.json` in pull/clone
- FE (Snapshot Manager migration)
  - `graph-editor/src/components/editors/SignatureLinksViewer.tsx` — file-backed link/unlink, dirty marking, session logging
  - `graph-editor/src/hooks/useParamSigBrowser.ts` — migrate from BE resolve to FE closure
  - `graph-editor/src/services/signatureLinksApi.ts` — remove equivalence functions by end; keep `listSignatures`, `getSignature`
  - `graph-editor/src/services/signatureLinksTabService.ts` — open `hash-mappings` file (Settings pattern)
  - `graph-editor/src/config/fileTypeRegistry.ts` — `hash-mappings` entry
  - `graph-editor/src/components/editors/EditorRegistry.ts` — map `hash-mappings` → `SignatureLinksViewer`
- BE
  - `graph-editor/lib/api_handlers.py` — consume `equivalent_hashes`; remove `include_equivalents`; remove mapping routes
  - `graph-editor/lib/snapshot_service.py` — consume `equivalent_hashes` in query functions; remove `signature_equivalence` table + all related SQL/functions; fix `batch_anchor_coverage` to use `core_hash`-only expansion; remove dead `get_snapshot_inventory` V1
