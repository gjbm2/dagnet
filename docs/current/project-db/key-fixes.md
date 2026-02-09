# Key Fixes: Atomic Retrieval Events + Logical Keys
**Status**: Complete (all read + write paths updated; batch-at threading across orchestrators; migration executed; 35 tests passing)  
**Date**: 9-Feb-26  
**Scope**: Snapshot DB read/write semantics; `@` (as-at) calendar correctness; signature equivalence behaviour

---

## 1. Problem statement

We currently have a mismatch between:

- **Semantic identity** (what a snapshot *means*): `core_hash` (plus equivalence links), `slice_key` (logical slice family), `anchor_day`, and a retrieval discriminator.
- **Physical storage identity** (how rows are stored): the snapshots table is keyed by `(param_id, core_hash, slice_key, anchor_day, retrieved_at)` and most read paths filter by `param_id`.

This causes a user-visible failure:

- After creating an equivalence link between two `core_hash` values, the `@` (as-at) dropdown does not show older retrievals that exist in the DB under a different `param_id`.

Root causes:

- **`retrieved_at` is not treated as an atomic retrieval-event discriminator**. It is currently closer to "the time this particular sub-write happened", which makes "latest wins" unreliable as a semantic selector.
- **Read paths treat `param_id` as the lookup bucket**, so equivalence closure over hashes cannot reach rows written under other params.

---

## 2. Target invariants (what "correct" means)

### 2.1 Retrieval events are atomic

For any given semantic series (hash family × logical slice family), we require:

- All rows produced by a single retrieval event share the **same** `retrieved_at`.
- Different retrieval events have **different** `retrieved_at`.

This makes `retrieved_at` a true retrieval-event identifier suitable for:

- Calendar availability (days with snapshots)
- `asat()` virtual snapshots ("latest as-of" selection)
- Any derivations that need to aggregate/sum safely over a coherent event

### 2.2 Logical lookup does not depend on `param_id`

Once retrieval events are atomic, the logical key for selecting a coherent "snapshot" is:

- `core_hash` family (after equivalence)
- logical slice family (normalised `slice_key`)
- `retrieved_at` (as the event discriminator)

`param_id` remains useful as metadata/audit and for writing, but should not be required to *find* equivalent data once hashes are linked.

### 2.3 No new DB field for retrieval id (for now)

We will use `retrieved_at` as the retrieval-event discriminator and update write logic so it is stable across a batch, rather than adding an extra `retrieval_id` column/table at this stage.

---

## 3. Non-goals / explicitly accepted constraints

- **We are not making signatures brittle by hashing latency/horizon parameters.** Latency/horizon drift is acknowledged and managed by policy (e.g. explicit recompute), not by signature invalidation in this phase.
- **We are not adding a new DB column** for retrieval-id in this phase.
- **We are not introducing "graph id" into the DB**. Params are already used across graphs; graph membership is not a storage discriminator.

---

## 4. Impacted code surfaces (current reality)

### 4.1 Write path

- Frontend snapshot append client: `graph-editor/src/services/snapshotWriteService.ts` (sends `retrieved_at`).
- Write orchestration: snapshot writes are triggered from `graph-editor/src/services/dataOperationsService.ts` (calls append with `retrieved_at: new Date()` at the point of writing).
- Backend append: `graph-editor/lib/snapshot_service.py` (`append_snapshots`) inserts rows keyed by `(param_id, core_hash, slice_key, anchor_day, retrieved_at)`.

### 4.2 Read path

Backend read functions used by UI + analysis:

- `query_snapshot_retrievals` (backs the `@` calendar).
- `query_virtual_snapshot` (backs `asat()`).
- `query_snapshots` and `query_snapshots_for_sweep` (analysis + derivations).

These currently rely on `param_id` bucketing and do not have a reliable, atomic retrieval-event discriminator.

---

## 5. Stepwise implementation plan (prose-only)

### Step 1 — Define "retrieval batch" precisely

Establish and document the retrieval batch boundaries used for snapshot writing:

- A retrieval batch is created at the start of an external fetch for a single semantic subject execution.
- The batch's `retrieved_at` is fixed once, then reused for all snapshot writes resulting from that execution (all anchors, all slice writes that belong to that subject execution).

Clarify which workflow starts a batch:

- Single "Get from source" (per item) starts one batch for that item.
- "Retrieve all" starts many batches at scope **S = param × slice × hash** (not a single shared batch timestamp for the entire run).
- After a **rate-limit cooloff** (61 min pause), we restart the failed **S** with a new `retrieved_at` and re-fetch from the start of S (cache-bust), so S is not split across a long real-world interval.

### Step 2 — Frontend: mint `retrieved_at` once per subject execution

Update `graph-editor/src/services/dataOperationsService.ts` (and any service it delegates to) so that:

- A single `Date` (or ISO string) is created at the **start** of the external fetch execution for an item.
- That value is passed through the full fetch pipeline and reused when calling `appendSnapshots` in `snapshotWriteService.ts`.
- Snapshot writes no longer call `new Date()` at write time.

Important discipline:

- The `retrieved_at` used for DB snapshots must be the batch timestamp, not a per-slice or per-subwrite timestamp.

**Implemented (9-Feb-26)**:

- `graph-editor/src/services/dataOperationsService.ts`
  - Mint `retrievalBatchAt` once at entry to `getFromSourceDirect()`.
  - Use that value for all `appendSnapshots({ retrieved_at: ... })` calls within the execution.
  - Align `inputs_json.generated_at` to the same batch timestamp for audit coherence.
  - Also aligned metadata timestamps (`updateData.retrieved_at`, `data_source.retrieved_at`, case schedule `retrieved_at`) to `retrievalBatchAtISO` for consistency.
  - `getFromSourceDirect` accepts an optional `retrievalBatchAt` parameter: when provided (by an outer orchestrator), it is used instead of minting a new Date.
  - `getFromSource` accepts and forwards `retrievalBatchAt` to `getFromSourceDirect`.
  - `batchGetFromSource` mints one `retrievalBatchAt` and threads it to every item.

- **Orchestrator threading** (fixes the "seconds apart within a single retrieve-all" issue):
  - `retrieveAllSlicesService.ts` — maintains a `Map<S, Date>` at scope **S = param × slice × hash**:
    - param = `objectId`
    - slice = `window()` or `cohort()` (args discarded) + any number of `context(...)` clauses
    - hash = `querySignature` (canonical signature; backend derives `core_hash`)

    This ensures all writes for the same semantic retrieval target share one `retrieved_at`, even though retrieve-all iterates a topo-aware pass over exploded slices.

    **Cooldown semantics (automated runs)**:
    - On a rate-limit cooloff (61 min), we *restart S* by:
      - invalidating S’s cached `retrieved_at` so the retry mints a new one, and
      - forcing a cache-bust for S so the retry re-fetches from the start of S (avoids splitting S over a long real-world interval).
  - `fetchOrchestratorService.ts` — mints one `retrievalBatchAt` per plan execution.
  - `windowFetchPlannerService.ts` — mints one `retrievalBatchAt` per plan execution.

### Step 3 — Backend: treat `retrieved_at` as retrieval-event id, not as incidental wall clock

Update snapshot read semantics in `graph-editor/lib/snapshot_service.py` so that:

- "Latest wins" selection is defined in terms of the retrieval-event discriminator (`retrieved_at`) over the semantic series, not by `param_id` buckets.
- Any place that selects "latest as-of" uses `retrieved_at` as the sole ordering discriminator for retrieval events.

This step must include the `@` calendar path:

- `query_snapshot_retrievals` must surface retrieval days for the semantic hash family, regardless of which `param_id` bucket currently contains the rows.

**Implemented (9-Feb-26)**:

- `graph-editor/lib/snapshot_service.py`
  - Updated **all four** read functions to support cross-param equivalence when `include_equivalents=True`:
    - `query_snapshot_retrievals()` — backs the `@` calendar
    - `query_virtual_snapshot()` — backs `asat()`
    - `query_snapshots()` — raw row queries for analysis
    - `query_snapshots_for_sweep()` — cohort maturity sweep
  - In each case, snapshot reads are scoped to `param_id IN resolved_pids` where `resolved_pids` is derived from the equivalence closure's `source_param_id` (plus the seed param), so we can reach cross-param stored rows without scanning unrelated params.
  - `resolve_equivalent_hashes()` now returns both `core_hashes` and `param_ids` from the equivalence closure.

### Step 4 — Migration: coalesce historic `retrieved_at` into atomic batches

We need a DB migration because existing data has "micro-timestamp per sub-write".

Migration policy:

- For each group defined by `(param_id, core_hash, logical slice family)`, cluster `retrieved_at` values into windows of \(Δ\) (default: 2 minutes).
- For each cluster, set all rows' `retrieved_at` to the **minimum** timestamp in the cluster (effectively "batch start time").

Key details:

- "Logical slice family" must use the same normalisation as the read path (e.g. `window(...)` → `window()`, `cohort(...)` → `cohort()`), so we do not accidentally merge distinct slice families.
- The migration must be idempotent and safe to re-run.
- The migration should be implemented as a dedicated Python script (or an explicit maintenance endpoint) that can be run against the production DB with appropriate safeguards.

#### Step 4A — Migration script (high-safety operational detail)

This migration is high risk because it updates part of the snapshots table's uniqueness key. The script must therefore:

- Default to **dry-run** (no writes) and require an explicit `--commit` flag to mutate the DB.
- Require a **bounded scope** (at least a `param_id` prefix / workspace prefix), to avoid accidental whole-DB updates.
- Use the exact same **logical slice family** normalisation as the read path (mirror `normalise_slice_key_for_matching` / `_slice_key_match_sql_expr` in `graph-editor/lib/snapshot_service.py`).

**Script location**:

- `graph-editor/lib/tools/migrate_snapshot_retrieved_at_batches.py`

**Scope model**:

- Migration must be performed in bounded segments.
- The preferred segmentation is **by param id** (run one transaction per `param_id`), because time-window segmentation can split a single \(Δ\)-cluster across boundaries and break idempotence.
- The script must support:
  - explicit param id (single-param run)
  - param id prefix (enumerate param ids, then process each param id independently)
  - optional retrieved-at "from/to" bounds only as a *selector for which param ids to include* (not as a partial-history update filter)

**Correctness model** (what the script must do):

- It must compute "batch clusters" per `(param_id, core_hash, logical slice family)` using the \(Δ\) window (2 minutes default).
- For each computed cluster, it must compute a canonical batch timestamp (the cluster minimum retrieved-at).
- It must avoid unique-key collisions when updating `retrieved_at` by:
  - identifying rows that would collide after coalescing (same param, same core hash, same *exact* slice_key, same anchor_day, and same target batch timestamp), and
  - deleting all but one row per such collision set, keeping the row with the greatest original `retrieved_at` (interpreting it as the final sub-write within the batch).
- After duplicates are removed, it must update remaining rows' `retrieved_at` to the computed batch timestamp.

**Safety checks** (must run before any writes):

- Show a summary of:
  - number of groups touched
  - number of distinct `retrieved_at` values before vs after coalescing (per group summary + overall)
  - number of rows that would be updated
  - number of rows that would be deleted as post-coalesce duplicates
- Refuse to run with `--commit` unless the scope is bounded (prefix or explicit param id).

**Transactional behaviour**:

- Each `param_id` segment must run in a single transaction:
  - compute mapping
  - delete duplicates
  - update timestamps
  - re-check that no rows remain with "non-canonical" retrieved-at values for the segment
  - commit
- If any step fails, the transaction must roll back and leave the DB unchanged for that segment.

**Operational runbook**:

- Run the script first in dry-run mode for a narrow scope (single param id) and inspect the summary counts.
- Then run with `--commit` for that same narrow scope.
- Repeat, expanding scope gradually (multiple params via prefix) only after verifying invariants.

**Post-migration verification**:

- For a small set of known `(param_id, core_hash, slice family)` groups:
  - verify that all rows within a batch share the same `retrieved_at`
  - verify that "virtual snapshot as-of" selection picks the correct latest batch
  - verify that the `@` calendar shows the expected retrieval days for equivalence-linked hashes

#### Step 4B — Migration execution record (9-Feb-26)

We executed the migration for the `<private-repo>-main-` prefix using a hardened script that:

- refuses to delete unless colliding rows are payload-identical (semantic fields match)
- refuses to commit if any collision set has payload variance
- refuses to commit deletions unless explicitly opted-in

**Dry run (prefix)**:

- Scope: `param_id_prefix = <private-repo>-main-`
- Window: \(Δ = 120s\)
- Result: a small number of "within-batch" duplicate writes were detected, concentrated in a handful of params (notably `registration-to-success`).

**Commit (prefix)**:

- Command: run `migrate_snapshot_retrieved_at_batches.py` with `--commit --allow-delete-identical`
- Outcome: committed successfully
- Rows deleted: 457 (payload-identical post-coalesce duplicates)
- Rows updated: 0

**Post-commit verification**:

- Re-ran dry-run for the same prefix and window.
- Confirmed `rows_to_delete = 0` and `rows_to_update = 0` for all `param_id`s in scope.

#### Step 4C — Double-writes root cause analysis (9-Feb-26)

Investigation confirmed:

- The 457 deleted rows were **payload-identical duplicates** caused by per-slice `new Date()` calls during "retrieve all" operations. Each slice within a single "retrieve all" run minted its own `retrieved_at`, and when multiple runs occurred for the same param within a short window, the `ON CONFLICT DO NOTHING` constraint allowed the writes through (different `retrieved_at` = different row).
- The two snapshot write blocks inside `getFromSourceDirect` are **mutually exclusive** (if/else on `shouldPersistPerGap && didPersistAnyGap`), so double-writes within a single invocation are not possible.
- The fix in Step 2 (`retrievalBatchAt`) prevents future within-invocation timestamp drift. Cross-invocation duplicates (separate "retrieve all" runs for the same data) remain possible but are handled correctly by "latest wins" logic.

### Step 5 — Signature equivalence: validate that linking hashes now surfaces old retrievals in the `@` UI

After Steps 2–4:

- Creating an equivalence link between hashes must cause the `@` calendar to show retrieval days that exist under either hash, regardless of which param bucket they were written under.
- The snapshot manager / inventory surfaces should reflect the same resolved availability.

### Step 6 — Tests: lock the new invariants

Add/extend integration tests to enforce:

- **Atomicity**: all snapshot writes resulting from one subject execution share one `retrieved_at`.
- **Calendar correctness**: the retrieval-days endpoint returns days for both sides of an equivalence link.
- **As-at selection correctness**: `query_virtual_snapshot` selects the correct "latest" batch by `retrieved_at` and returns a coherent set.
- **Migration correctness**: for a constructed set of near-timestamps, coalescing yields the expected batch timestamps.

Suggested homes for tests:

- Python: `graph-editor/lib/tests/test_snapshot_read_integrity.py` and/or `graph-editor/lib/tests/test_snapshot_integration.py`
- TypeScript: `graph-editor/src/services/__tests__/snapshotWritePath.fixture.test.ts` and `graph-editor/src/services/__tests__/dataOperationsService.asatSignatureSelection.test.ts`

**Implemented (9-Feb-26)**:

- Python: `graph-editor/lib/tests/test_snapshot_read_integrity.py`
  - Added `TestCrossParamDataContract` class with 5 focused tests:
    - **D-007**: `resolve_equivalent_hashes` returns correct `param_ids` (including `source_param_id`)
    - **RI-011**: `query_snapshots` with cross-param equivalence (data under different `param_id`)
    - **RI-012**: `query_snapshots_for_sweep` with cross-param equivalence
    - **RI-013**: multi-day "latest wins" across params (3 anchor days, newer param wins on overlapping day)
    - **RI-014**: `@` calendar shows retrieval days from linked param
  - Earlier: RI-008c covers core cross-param virtual snapshot + retrievals.
  - All **35 tests** passing (RI-001→RI-014, Tier C, D, E suites).

### Step 7 — Verification procedure (manual)

Provide a short manual verification checklist:

- Create two `core_hash` values with snapshots under different `param_id` buckets.
- Create an equivalence link between them.
- Confirm the `@` calendar highlights retrieval days from both.
- Select an older day and confirm `asat()` queries return data for that day.

---

## 6. Risks and mitigations

- **Risk: accidental batch timestamp sharing across different subject executions**  
  Mitigation: mint `retrieved_at` at scope **S = param × slice × hash** (not per entire run). Different params/slices/hashes get independent timestamps. After rate-limit cooloff (61 min pause), restart the failed S with a new `retrieved_at` and re-fetch from the start of S (cache-bust). Cross-invocation duplicates (separate runs for the same data) remain possible but are handled by "latest wins" logic.

- **Risk: historic data coalescing merges unrelated subwrites**  
  Mitigation: group by `(param_id, core_hash, logical slice family)` before clustering; keep \(Δ\) conservative (2 minutes) and validate on a sample.

- **Risk: relying on millisecond timestamps as unique identifiers**  
  Mitigation: if collisions are observed in practice, introduce a deterministic tie-break (e.g. monotonic increment within the client) while still storing a timestamp.

---

## 7. Deliverables

- `retrieved_at` becomes an atomic retrieval-event discriminator for snapshot writes.
- Historic snapshot data is migrated to the new semantics (coalesced retrieval batches).
- The `@` (as-at) dropdown shows old snapshots after signature equivalence links are created.
- Integration tests exist to prevent regression.
