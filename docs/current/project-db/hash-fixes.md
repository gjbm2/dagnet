# Hash Architecture Fix: Frontend Must Be Sole Producer of All Hashes

**Status**: COMPLETE. All phases done. Backend never derives hashes.  
**Date**: 8-Feb-26  
**Related**: `1-reads.md`, `00-snapshot-db-design.md`, flexi_sigs.md

---

## 1. Design Principle (Violated)

> **Frontend creates ALL signatures and hashes. Backend is dumb — it receives keys and uses them directly for DB operations.**

The backend must NEVER derive, compute, or transform hash values. It must receive fully-formed keys from the frontend and use them as opaque lookup tokens.

---

## 2. Diagnosis: What Went Wrong

### 2.1 The Problem (now resolved — see §5 implementation status)

The backend previously computed the DB column `core_hash` from the frontend's `canonical_signature` via `short_core_hash_from_canonical_signature()` in `snapshot_service.py`. The algorithm is: SHA-256 the UTF-8 bytes of the signature string, take the first 16 bytes, and base64url-encode without padding.

This meant **two different services produced hashes**:
- Frontend produced `canonical_signature` (containing `coreHash` and `contextDefHashes`)
- Backend produced `core_hash` (the DB lookup key) by hashing the frontend's signature string

### 2.2 Where the Backend Hashes

| Call site | File | Line | What happens |
|-----------|------|------|-------------|
| Snapshot write | `snapshot_service.py` `append_snapshots()` | ~186 | Backend derives `core_hash` from `canonical_signature`, uses for INSERT |
| Virtual snapshot query | `api_handlers.py` `handle_snapshots_query_virtual()` | ~865 | Backend derives `core_hash` from `canonical_signature`, uses for SELECT |
| Retrieval query | `api_handlers.py` `handle_snapshots_query_retrievals()` | ~783 | Backend derives `core_hash` from `canonical_signature`, uses for SELECT |
| Batch inventory V2 | `snapshot_service.py` `get_batch_inventory_v2()` | ~944 | Backend derives `core_hash` from signatures for matching |

### 2.3 Why This is Wrong

1. **Two hash implementations that must stay in sync.** If Python's SHA-256 truncation ever diverges from what TypeScript would produce (encoding, truncation boundary, base64 variant), data becomes unqueryable. This is a latent data integrity risk.

2. **Backend is not dumb.** The backend is making a computational decision (how to derive the DB key) that should be the frontend's sole responsibility. If the backend is ever moved to a different server or replaced, this implicit contract must be replicated exactly.

3. **Frontend cannot predict the DB key.** The frontend sends `canonical_signature` and the backend returns `core_hash` as a by-product. The frontend has no way to independently verify or construct the DB key. For the analysis read path, the frontend needs to know the `core_hash` to include in requests — but it can only get it from the backend's response to a prior write.

4. **Circular dependency.** For the new analysis read path (`1-reads.md`), the frontend must construct `snapshot_dependencies` that include DB coordinates. If it cannot compute `core_hash` itself, it must either (a) send `canonical_signature` and let the backend hash it (violating the principle), or (b) have previously cached a `core_hash` from a write response (fragile, not always available).

---

## 3. The Fix

### 3.1 Port `short_core_hash_from_canonical_signature` to TypeScript

Create `computeShortCoreHash()` in `graph-editor/src/services/coreHashService.ts` that produces identical output to the Python function. The algorithm: trim whitespace, UTF-8 encode, SHA-256 digest, take first 16 bytes, base64url-encode without padding. Use `crypto.subtle.digest` in browser / Node 18+, with a `crypto.createHash` fallback for older environments.

**Verification**: Write a cross-language golden test with known inputs and expected outputs. Both the TypeScript and Python implementations must produce identical `core_hash` values. This test exists before any migration begins.

### 3.2 Frontend Computes and Sends `core_hash` on All API Calls

Update all frontend API calls to include `core_hash` alongside `canonical_signature`:

| API endpoint | Current | After fix |
|---|---|---|
| `POST /api/snapshots/append` | Sends `canonical_signature` only | Sends `canonical_signature` + `core_hash` |
| `POST /api/snapshots/query-virtual` | Sends `canonical_signature` only | Sends `canonical_signature` + `core_hash` |
| `POST /api/snapshots/query-retrievals` | Sends `canonical_signature` only | Sends `canonical_signature` + `core_hash` |
| `POST /api/snapshots/query-full` | Sends `core_hash` only (!) | Sends `canonical_signature` + `core_hash` |
| `POST /api/runner/analyze` (snapshot) | Sends `core_hash` only (!) | Sends `canonical_signature` + `core_hash` |

### 3.3 Backend Uses Frontend-Provided `core_hash` Directly

Update all backend handlers:

1. Read `core_hash` from the request body (required field, not derived)
2. Use it directly for all DB operations (INSERT, SELECT, WHERE clauses)
3. Store `canonical_signature` in `signature_registry` for audit/provenance (as today)
4. **Validation only**: optionally verify `core_hash == short_core_hash_from_canonical_signature(canonical_signature)` as an assertion. Log a warning if they disagree, but use the frontend's value. This catches bugs during transition without breaking anything.

### 3.4 Deprecate and Remove Backend Hashing

After all frontend call sites send `core_hash`:

1. Remove `short_core_hash_from_canonical_signature()` from `snapshot_service.py` (or demote to test-only utility)
2. Remove all backend derivation calls
3. Backend becomes purely "receive key, use key"

---

## 4. Migration: No Data Migration Required

The algorithm is deterministic: `SHA-256(string)[:16] → base64url`. If the TypeScript implementation produces identical output for the same input (verified by golden tests), then:

- All existing `core_hash` values in the DB are already correct
- The frontend will compute the same values for the same `canonical_signature` strings
- No rows need updating
- No schema changes needed

The "migration" is purely a **code change** — moving the hash computation from Python to TypeScript.

---

## 5. Implementation Sequence

### Step 1: Golden Test (prerequisite — validates parity before anything else)

Create a test fixture with known `canonical_signature` → `core_hash` pairs, computed by the existing Python function using real production signatures.

Both TypeScript and Python tests consume this fixture and verify identical outputs.

**Files**:
- `tests/fixtures/core-hash-golden.json` — shared fixture
- `graph-editor/src/services/__tests__/coreHashService.test.ts` — TS test
- `graph-editor/lib/tests/test_core_hash_parity.py` — Python test (validates existing function matches fixture)

### Step 2: Frontend Implementation

Create `coreHashService.ts` with `computeShortCoreHash()`.

Verify all golden tests pass.

### Step 3: Update Frontend API Calls (additive — backwards compatible)

Update `snapshotWriteService.ts`:
- `appendSnapshots()`: compute `core_hash` from `canonical_signature`, include in request body
- `querySnapshotsVirtual()`: compute `core_hash`, include in request body
- `querySnapshotRetrievals()`: compute `core_hash`, include in request body
- `querySnapshotsFull()`: already sends `core_hash` — ensure `canonical_signature` is also sent

All calls now send BOTH `canonical_signature` AND `core_hash`.

### Step 4: Update Backend Handlers (transition — accept both)

Update `api_handlers.py` and `snapshot_service.py`:
- If `core_hash` is present in request: use it directly
- If `core_hash` is absent: fall back to computing from `canonical_signature` (temporary backward compat)
- Log a deprecation warning when falling back

### Step 5: Remove Backend Fallback

Once all frontend paths send `core_hash`:
- Remove fallback derivation
- Make `core_hash` a required field on all relevant endpoints
- `canonical_signature` remains required for audit/registry but is NOT used for DB lookups

---

## 6. Call Sites to Update

### Frontend (`snapshotWriteService.ts`)

| Function | Line | Change |
|----------|------|--------|
| `appendSnapshots()` | ~155 | Add `core_hash` to request body |
| `querySnapshotsVirtual()` | ~530 | Add `core_hash` to request body |
| `querySnapshotRetrievals()` | ~580 | Add `core_hash` to request body |
| `querySnapshotsFull()` | ~390 | Already sends `core_hash`; add `canonical_signature` |

### Frontend (`dataOperationsService.ts`)

| Location | Line | Change |
|----------|------|--------|
| asat() fork (getParameterFromFile) | ~1310 | Compute `core_hash` before calling `querySnapshotsVirtual` |
| asat() fork (getFromSourceDirect) | ~4359 | Compute `core_hash` before calling `querySnapshotsVirtual` |

### Backend (`api_handlers.py`)

| Function | Line | Change |
|----------|------|--------|
| `handle_snapshots_append()` | ~500 | Read `core_hash` from request instead of computing |
| `handle_snapshots_query_virtual()` | ~865 | Read `core_hash` from request instead of computing |
| `handle_snapshots_query_retrievals()` | ~783 | Read `core_hash` from request instead of computing |

### Backend (`snapshot_service.py`)

| Function | Line | Change |
|----------|------|--------|
| `append_snapshots()` | ~186 | Accept `core_hash` as parameter instead of deriving |
| `get_batch_inventory_v2()` | ~944 | Accept pre-computed `core_hash` values |

---

## 7. Risk Assessment

| Risk | Mitigation |
|------|------------|
| TypeScript SHA-256 produces different bytes than Python | Golden test with real production signatures; run BEFORE any code changes |
| base64url encoding differs between languages | Golden test covers encoding (padding, URL-safe chars) |
| Frontend `crypto.subtle` not available in test environment | Use Node.js `crypto` module as fallback in test/SSR contexts |
| Transition period: old frontend + new backend | Step 4 includes backward-compatible fallback |
| `core_hash` missing from request during transition | Fallback in Step 4; deprecation warning logged |

---

## 8. Acceptance Criteria

1. Frontend computes `core_hash` for all snapshot API calls
2. Backend NEVER derives `core_hash` from `canonical_signature` in production code paths
3. Golden test proves TypeScript and Python produce identical `core_hash` for identical inputs
4. All existing snapshot data remains queryable (no data migration)
5. `short_core_hash_from_canonical_signature` removed from production backend code (retained only in test utilities if needed)

---

## 9. Detailed Implementation Plan

### Corrections from Code Review

Before implementing, note these discrepancies between the design above and the actual codebase (verified 8-Feb-26):

- **Naming**: Section 2.2 / 6 refers to `handle_snapshots_query_retrievals()`. The actual function is `handle_snapshots_retrievals()` at `api_handlers.py:747`. The URL is `/api/snapshots/retrievals`.
- **query-full already correct**: `handle_snapshots_query_full()` (`api_handlers.py:630`) already receives `core_hash` directly from the frontend and does NOT call `short_core_hash_from_canonical_signature`. No backend change needed for this handler.
- **Inventory endpoint missing from design**: The inventory endpoint (`/api/snapshots/inventory`) calls `get_batch_inventory_v2()` which receives `current_signatures` (a dict of `param_id` → `canonical_signature` string) and converts each to `core_hash` internally at `snapshot_service.py:944`. This needs updating too.
- **Frontend inventory call**: `snapshotWriteService.ts` function `querySnapshotInventoryRich()` (~line 755) sends `current_signatures` to the inventory endpoint. It needs to also send pre-computed `current_core_hashes`.

### Phase 0: Golden Test Fixture (prerequisite)

**Goal**: Establish a shared fixture of known `canonical_signature` → `core_hash` pairs that both languages consume, proving byte-for-byte parity before any production code changes.

**0.1 Generate the fixture**

Write a one-off Python script (not checked in; run manually) that calls the existing `short_core_hash_from_canonical_signature()` on a set of representative inputs and writes the results to a JSON file. Inputs should include:

- A minimal signature: `{"c":"abc","x":{}}`
- A signature with context hashes: `{"c":"abc","x":{"seg":"def"}}`
- A signature with unicode characters in the core hash
- A signature with leading/trailing whitespace (to verify `.strip()` parity)
- An empty `x` object but long core hash
- At least two real production-style signatures extracted from existing DB rows (query `signature_registry` for a couple of representative entries)

Output file: `tests/fixtures/core-hash-golden.json` — array of objects, each with `input` (the canonical signature string) and `expected` (the core_hash string).

**0.2 Python parity test**

Create `graph-editor/lib/tests/test_core_hash_parity.py`. This test loads the golden fixture, iterates over each entry, calls `short_core_hash_from_canonical_signature(entry.input)`, and asserts the result equals `entry.expected`. This validates that the fixture was generated correctly and that the existing Python function is stable.

Run with: `cd graph-editor && . venv/bin/activate && pytest lib/tests/test_core_hash_parity.py -v`

**0.3 TypeScript parity test (written now, will fail until Phase 1)**

Create `graph-editor/src/services/__tests__/coreHashService.test.ts`. This test loads the same golden fixture, calls the (not-yet-created) `computeShortCoreHash()` function on each `input`, and asserts the result equals `expected`. Mark this test as skipped (`it.skip`) until Phase 1 is complete; then unskip and verify it passes.

### Phase 1: Frontend Hash Function

**Goal**: Create `computeShortCoreHash()` in TypeScript that produces identical output to the Python function for all golden test inputs.

**1.1 Create `graph-editor/src/services/coreHashService.ts`**

Export a single async function `computeShortCoreHash(canonicalSignature: string): Promise<string>`.

Algorithm (must match Python exactly):
- Validate input: must be a non-empty string after trimming
- Trim the input string (`.trim()` — equivalent to Python's `.strip()`)
- Encode to UTF-8 bytes via `TextEncoder`
- Compute SHA-256 digest via `crypto.subtle.digest('SHA-256', ...)` (available in both browser and Node 18+)
- Take the first 16 bytes of the digest
- Base64url-encode without padding: standard base64 with `+` → `-`, `/` → `_`, trailing `=` stripped

**1.2 Environment compatibility**

In the Vitest test environment, `crypto.subtle` is available via Node's built-in `globalThis.crypto`. No polyfill should be needed for Node 18+. If it is not available (e.g. older Node, SSR edge case), provide a synchronous fallback using Node's `crypto.createHash('sha256')`. The fallback should be used only when `crypto.subtle` is undefined. Keep the fallback in the same file, not a separate module, to avoid code surface area.

**1.3 Unskip and run the golden test**

Unskip the TypeScript golden test from Phase 0.3. Run it. All entries must pass. If any entry fails, debug the encoding/base64 logic — do NOT adjust the fixture.

### Phase 2: Update Frontend API Calls (additive, backwards-compatible)

**Goal**: All frontend snapshot API calls include `core_hash` in the request body, computed from `canonical_signature` using `computeShortCoreHash()`. The backend has not changed yet, so it will ignore the extra field — no breaking change.

**2.1 Update `AppendSnapshotsParams` type**

In `snapshotWriteService.ts`, add an optional `core_hash?: string` field to the `AppendSnapshotsParams` interface. This allows callers to pre-compute and pass it, but also allows the `appendSnapshots()` function body to compute it if not provided.

**2.2 Update `appendSnapshots()` function body** (`snapshotWriteService.ts:~155`)

Before the `fetch()` call, compute `core_hash` from `params.canonical_signature` using `computeShortCoreHash()`. Add `core_hash` to the `JSON.stringify()` request body object. Since `computeShortCoreHash` is async, the enclosing function is already async — no signature change needed.

**2.3 Update `QuerySnapshotsVirtualParams` type**

Add optional `core_hash?: string` to the params interface.

**2.4 Update `querySnapshotsVirtual()` function body** (`snapshotWriteService.ts:~530`)

Before the `fetch()` call, compute `core_hash` from `params.canonical_signature` (which is already required by this function). Add `core_hash` to the request body.

**2.5 Update `QuerySnapshotRetrievalsParams` type**

Add optional `core_hash?: string` to the params interface.

**2.6 Update `querySnapshotRetrievals()` function body** (`snapshotWriteService.ts:~580`)

Before the `fetch()` call, if `params.canonical_signature` is present, compute `core_hash` from it. Add `core_hash` to the request body. Note: `canonical_signature` is optional for this endpoint (allows querying all signatures for a param), so only compute `core_hash` when `canonical_signature` is truthy.

**2.7 Update `querySnapshotsFull()` function body** (`snapshotWriteService.ts:~390`)

This function already sends `core_hash`. Add `canonical_signature` to the request body for audit completeness. This requires adding `canonical_signature?: string` to `QuerySnapshotsFullParams`. No computation needed — just forward the field.

**2.8 Update inventory call** (`snapshotWriteService.ts:~755`)

The `querySnapshotInventoryRich()` function sends `current_signatures` (a dict of `param_id` → `canonical_signature`). Add a parallel `current_core_hashes` field to the request body: a dict of `param_id` → `core_hash`, computed by iterating over `current_signatures` and calling `computeShortCoreHash()` on each value. Use `Promise.all()` to compute them concurrently.

**2.9 No changes needed in `dataOperationsService.ts` callers**

The two `appendSnapshots` call sites (~7992 and ~8299) and the two `querySnapshotsVirtual` call sites (~1317 and ~4365) in `dataOperationsService.ts` do NOT need changes. They already pass `canonical_signature` to `snapshotWriteService` functions, and the hash computation will happen inside those functions (Phase 2.2 / 2.4). The callers are unaware of the change.

### Phase 3: Update Backend Handlers (transition — accept both)

**Goal**: Backend handlers prefer `core_hash` from the request body. If absent, fall back to deriving it from `canonical_signature` with a deprecation warning. This ensures backward compatibility during rollout.

**3.1 Create a helper function in `snapshot_service.py`**

Add a utility function `resolve_core_hash(data: dict, logger) -> str` that:
- Checks if `data['core_hash']` is present and non-empty → returns it directly
- Otherwise, if `data['canonical_signature']` is present → derives `core_hash` via `short_core_hash_from_canonical_signature()`, logs a deprecation warning ("core_hash not provided by frontend; falling back to backend derivation"), and returns the result
- If neither is present → raises `ValueError`
- If both are present → uses the frontend's `core_hash` value, but also derives the backend's value and compares. If they differ, log a warning with both values (this is the parity safety net). Always use the frontend's value.

**3.2 Update `handle_snapshots_append()`** (`api_handlers.py:~500`)

Extract `core_hash` from `data` using `resolve_core_hash()`. Pass `core_hash` as a new explicit parameter to `append_snapshots()`.

**3.3 Update `append_snapshots()` signature** (`snapshot_service.py:~104`)

Add an optional `core_hash: Optional[str] = None` parameter. If provided, use it directly instead of calling `short_core_hash_from_canonical_signature()`. If not provided, fall back to computing it (for backward compatibility with any direct callers, e.g. tests). The `canonical_sig_hash_full` (full SHA-256 hex) is still computed from `canonical_signature` for the `signature_registry` — that's a separate value and unrelated to the DB lookup key.

**3.4 Update `handle_snapshots_query_virtual()`** (`api_handlers.py:~854`)

Replace the inline `core_hash = short_core_hash_from_canonical_signature(canonical_signature)` with `core_hash = resolve_core_hash(data, logger)`. Pass `core_hash` to `query_virtual_snapshot()` as before.

**3.5 Update `handle_snapshots_retrievals()`** (`api_handlers.py:~747`)

Replace the inline derivation with `resolve_core_hash()`. Note: `canonical_signature` is optional for this endpoint. If `data` has neither `core_hash` nor `canonical_signature`, pass `core_hash=None` (query all hashes for the param). If `data` has `core_hash`, use it. If `data` has only `canonical_signature`, derive and warn.

**3.6 Update `handle_snapshots_inventory()`** (`api_handlers.py:~686`)

Read `current_core_hashes` from the request body (a dict of `param_id` → `core_hash`). Pass it as a new parameter to `get_batch_inventory_v2()`.

**3.7 Update `get_batch_inventory_v2()` signature** (`snapshot_service.py:~791`)

Add an optional `current_core_hashes: Optional[Dict[str, str]] = None` parameter. In the "Add current signature nodes" block (~line 938), if `current_core_hashes` is provided and contains the param_id, use the pre-computed value instead of calling `short_core_hash_from_canonical_signature()`. If a param_id is in `current_signatures` but NOT in `current_core_hashes`, fall back to derivation with a deprecation warning.

### Phase 4: Verify and Test

**Goal**: Confirm end-to-end correctness — frontend-computed hashes match existing DB data, all API paths work with the new field.

**4.1 Run the golden parity test (both languages)**

Both the Python and TypeScript golden tests must pass. This was already done in Phase 0/1 but re-run after all changes to confirm nothing regressed.

**4.2 Integration smoke test**

Start the dev server. Trigger a data fetch that writes to the snapshot DB (the `appendSnapshots` path). Verify:
- The request body now includes both `canonical_signature` and `core_hash`
- The backend log does NOT show a "falling back to backend derivation" warning
- The response is identical to before the change
- The written row in the DB has the same `core_hash` as before

Trigger an asat read (the `querySnapshotsVirtual` path). Verify:
- The request body includes both `canonical_signature` and `core_hash`
- Data is returned correctly (same rows as before)
- No backend derivation warning in logs

**4.3 Parity validation in backend logs**

During the transition period, the `resolve_core_hash()` function compares frontend and backend values when both are available. Monitor logs for any "core_hash mismatch" warnings. If any appear, the TypeScript implementation has a bug and must be fixed before proceeding to Phase 5.

**4.4 Existing test suites**

Run the existing snapshot-related test files to confirm no regressions:
- `graph-editor/src/services/__tests__/snapshotWritePath.fixture.test.ts` (if backend is running)
- `graph-editor/lib/tests/test_core_hash_parity.py`
- Any other snapshot-related tests identified by searching for `snapshot` in the test directories

### Phase 5: Remove Backend Fallback (cleanup)

**Goal**: Remove all backend hash derivation from production code paths. `short_core_hash_from_canonical_signature` is retained only as a test utility.

**5.1 Make `core_hash` required on all endpoints**

In each backend handler updated in Phase 3, remove the fallback logic. If `core_hash` is not present in the request body, return a 400 error. Remove the `resolve_core_hash()` helper (or simplify it to just read and validate the field).

**5.2 Update `append_snapshots()` to require `core_hash`**

Change the `core_hash` parameter from optional to required. Remove the internal derivation fallback.

**5.3 Update `get_batch_inventory_v2()` to require `current_core_hashes`**

Make `current_core_hashes` a required parameter when `current_signatures` is provided. Remove the internal derivation fallback.

**5.4 Move `short_core_hash_from_canonical_signature()` to test utilities**

Move the function from `snapshot_service.py` to a test helper module (e.g. `lib/tests/test_helpers.py`), or mark it clearly as test-only with a comment and prefix (e.g. `_test_only_short_core_hash_from_canonical_signature`). Remove all imports of it from production code files (`api_handlers.py`, `snapshot_service.py`).

**5.5 Remove the parity validation logging**

The "compare frontend vs backend hash" assertion in `resolve_core_hash()` is no longer needed once the fallback is removed. Remove it along with `resolve_core_hash()` itself.

### Phase Summary Table

| Phase | Files Changed | Risk | Status |
|-------|--------------|------|--------|
| 0 — Golden fixture | `lib/tests/fixtures/core-hash-golden.json`, `lib/tests/test_core_hash_parity.py`, `src/services/__tests__/coreHashService.test.ts` | None (test-only) | **DONE** |
| 1 — Frontend hash function | `src/services/coreHashService.ts` | None (new file, not yet called) | **DONE** |
| 2 — Frontend sends `core_hash` | `src/services/snapshotWriteService.ts` (5 call sites + types) | Low (additive) | **DONE** |
| 3 — Backend accepts `core_hash` | `lib/api_handlers.py` (4 handlers), `lib/snapshot_service.py` (`_resolve_core_hash`, `append_snapshots`, `query_snapshots`, `get_batch_inventory_v2`) | Medium (mitigated by fallback + parity check) | **DONE** |
| 4 — Verify | Golden parity tests (both languages) | None | **DONE** |
| 5 — Cleanup | `lib/snapshot_service.py` (remove fallback + parity check), `lib/api_handlers.py` (use `_require_core_hash`) | Low | **DONE** |

### Deployment / Rollout Order

Phases 0–2 can be deployed independently (frontend-only changes; backend ignores the extra field). Phase 3 can be deployed at any time after Phase 2. Phase 5 should only be deployed after Phase 4 confirms zero parity mismatches in logs. There is no requirement to deploy all phases simultaneously — each phase is independently safe.

---

## 10. Implementation Record (Phases 0–3)

Completed 8-Feb-26. All changes are in a single commit on `feature/snapshot-db-phase0`.

### Files Created

| File | Purpose |
|------|---------|
| `src/services/coreHashService.ts` | Frontend `computeShortCoreHash()` — sole producer of `core_hash`. Handles browser (`crypto.subtle`) and Node (`crypto.createHash`) environments. |
| `src/services/__tests__/coreHashService.test.ts` | Golden parity test — loads shared fixture, verifies TS output matches Python. |
| `lib/tests/fixtures/core-hash-golden.json` | 10 golden test vectors (minimal, contexts, unicode, whitespace, production-style). |
| `lib/tests/test_core_hash_parity.py` | Python golden parity test — same fixture, same assertions. |

### Files Modified

| File | Change |
|------|--------|
| `src/services/snapshotWriteService.ts` | All 5 API call sites now compute `core_hash` via `computeShortCoreHash()` and send it alongside `canonical_signature`: `appendSnapshots`, `querySnapshotsVirtual`, `querySnapshotRetrievals`, `querySnapshotsFull`, `getBatchInventoryV2`. |
| `lib/snapshot_service.py` | New `_resolve_core_hash()` transition helper (prefer FE value, fall back with deprecation warning, parity check when both present). `append_snapshots()` accepts `core_hash` parameter. `query_snapshots()` gains `include_equivalents` parameter with closure expansion. `get_batch_inventory_v2()` accepts `current_core_hashes`. |
| `lib/api_handlers.py` | All 4 handlers updated to use `_resolve_core_hash()`: `handle_snapshots_append`, `handle_snapshots_query_virtual`, `handle_snapshots_retrievals`, `handle_snapshots_inventory`. `handle_snapshots_query_full` gains `include_equivalents` passthrough. |
| `lib/tests/test_snapshot_read_integrity.py` | New test tiers: C (backend contract — validation, idempotency), D (equivalence resolution — symmetry, multi-hop, deactivation, cycles, isolation), E (end-to-end no-disappearance scenario). Plus RI-008b (equivalence closure in `query_snapshots`). |

### Phase 5 Cleanup (DONE)

- `_resolve_core_hash()` removed entirely — replaced by `_require_core_hash()` which raises `ValueError` if `core_hash` is absent
- All parity validation / deprecation logging removed
- `short_core_hash_from_canonical_signature()` marked TEST-ONLY in docstring; no production code path calls it
- `get_batch_inventory_v2()` no longer falls back to backend derivation — uses `current_core_hashes` from frontend only
- `api_handlers.py` imports `_require_core_hash` (not `_resolve_core_hash`); no import of `short_core_hash_from_canonical_signature`
