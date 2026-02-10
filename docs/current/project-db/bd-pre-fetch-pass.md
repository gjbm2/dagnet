# Backend DB pre-fetch pass for Retrieve All
**Status**: Proposal  
**Date**: 10-Feb-26  
**Related**: `1-reads.md` (single-trip principle), `context-epochs.md` (preflight as observation), `flexi_sigs.md` (§8 inventory v2 families), `key-fixes.md` (scope S + retrieved_at atomicity)

---

## 1. Problem statement

`Retrieve All` currently plans incremental fetch windows using **frontend file cache coverage** (parameter file slice headers) plus **staleness** semantics. It does **not** consider whether the **snapshot DB** already has (or is missing) historic anchor-day coverage for the same semantic subject.

This creates two user-hostile failure modes:

- **Hash drift / signature remaps / equivalence closure changes**: the parameter files can look “complete”, but the DB for the *current* semantic family (current core hash plus equivalence closure) can contain historic gaps that will never be refilled unless the user manually “Clear Data”.
- **Snapshotting started late**: the files may contain long history from pre-DB days; incremental planning fetches very little, leaving the DB permanently sparse for historic windows.

We need `Retrieve All` to be able to “notice” DB gaps cheaply and refetch them automatically in the runs where that matters most (especially automated overnight runs), without creating a second planner code path and without moving planning semantics into the backend.

---

## 2. Current behaviour (ground truth)

### 2.1 Fetch-plan windows are already a union of multiple “reasons”

Per item, the planner computes:

- missing days from incremental cache analysis, and
- stale days from maturity/refetch policy,

then **unions** them to produce one or more plan windows.

Important properties of the existing machinery:

- The plan supports **multiple disjoint windows (“gaps”)** per item.
- `Retrieve All` executes **exactly the plan windows** by passing them as `overrideFetchWindows` into `dataOperationsService.getFromSource`.

This means adding “DB-missing windows” is conceptually a third input into an existing union, not a new execution mechanism.

### 2.2 There is no existing endpoint that returns anchor-day missing ranges

We currently have backend endpoints that are *adjacent* but insufficient for Tier B “tell me the missing anchor-day ranges”:

- `/api/snapshots/inventory` (Inventory v2 families): good for “does anything exist”, min/max anchor day, and counts per slice/family; **does not** report internal missing windows.
- `/api/snapshots/retrievals` (optionally `include_summary`): good for “what retrieval timestamps exist” and per-retrieval summary; it is retrieval-centric, and still **does not** provide anchor-day gap ranges for a requested window.
- `/api/snapshots/batch-retrieval-days`: day-level retrieval calendar by param_id only; **not** core-hash/slice-key scoped and **not** anchor coverage.

Therefore Tier B requires a **new DB coverage endpoint** (or a substantial extension of an existing one) that returns missing anchor-day ranges for a subject+window under equivalence closure.

---

## 3. Proposal overview

Add an optional **backend DB coverage preflight** step to the `Retrieve All` execution pipeline, controlled by a boolean option, which produces “DB-missing” windows and unions them into the plan alongside existing “file-missing” and “stale” windows.

Key constraints:

- **No feature flags**: this is a first-class behaviour change controlled only by an explicit run option and (for manual runs) the modal toggle.
- **No duplicate planner paths**: continue to use the existing `buildFetchPlanProduction` output, and only augment its windows.
- **Backend remains MECE-blind**: frontend provides explicit `slice_keys` (already true elsewhere in snapshot DB reads).
- **Equivalence closure correctness is non-negotiable**: the preflight must check coverage across the same transitive hashing / `signature_equivalence` semantics used by snapshot reads.
- **Mode correctness is non-negotiable**: `window()` and `cohort()` are distinct slice families in both planning and DB storage/reads; the coverage check must never “fall back” across modes.

---

## 4. User-facing controls

Introduce a `Retrieve All` option:

- **`checkDbCoverageFirst`**: boolean.

Default policy:

- **Automated overnight Retrieve All**: `checkDbCoverageFirst = true`.
- **User-initiated Retrieve All modal**: exposed as an “Advanced” checkbox. Default can be conservative (off) initially, but the intent of this proposal is to make it easy to “do the right thing” without requiring Clear Data.

Degradation policy:

- If DB preflight fails (offline, API error), continue with the existing plan (file-missing + stale) and log a warning (see §7).

---

## 5. Backend contract: batch anchor coverage (Tier B)

### 5.1 New endpoint

Add a new endpoint that answers:

> “For each subject, which anchor-day ranges within \([anchor_from, anchor_to]\) are missing from the snapshot DB, when considering equivalence closure?”

Suggested route:

- `POST /api/snapshots/batch-anchor-coverage`

### 5.2 Request shape (per subject)

Batch request contains `subjects[]`, each with:

- **Identity**
  - `param_id` (workspace-prefixed)
  - `core_hash` (frontend-computed short core hash)
- **Slice semantics**
  - `slice_keys[]` (explicit logical slice families, including temporal mode: `window()` or `cohort()`. Slice args are incidental; matching uses existing slice-key normalisation.)
- **Window**
  - `anchor_from` (ISO date)
  - `anchor_to` (ISO date)
- **Equivalence**
  - `include_equivalents` (boolean; default true)

### 5.3 Response shape (per subject)

For each subject:

- `coverage_ok`: boolean
- `missing_anchor_ranges[]`: list of contiguous missing ranges (ISO date start/end, inclusive)
- `present_anchor_day_count`: integer (diagnostic)
- `expected_anchor_day_count`: integer (diagnostic)
- `equivalence_resolution` diagnostics sufficient to debug transitive hashing:
  - which core hashes and which param_ids were in-scope after closure expansion

### 5.4 Performance target

The endpoint must be “preflight cheap”:

- One batch call per `Retrieve All` slice (or per run, if we later batch across slices).
- DB work should be set-based and avoid per-day row materialisation in Python.

Implementation strategy (non-normative, but sets intent):

- Resolve equivalence closure using the same semantics as existing snapshot reads (the closure must include `source_param_id` scoping).
- For each subject, compute the set of distinct `anchor_day` present for the `(param_id closure, core_hash closure, slice_keys)` selection within \([anchor_from, anchor_to]\).
- Compute missing days, then compress into contiguous ranges before returning.

---

## 6. Frontend integration: extend the existing union (no new execution machinery)

### 6.1 Confirming the “union extension” (this answers question A)

Yes: the proposed “DB-missing windows” are just a third input into the existing union.

Today the planner already produces:

- `missingWindows` (from incremental cache gaps)
- `staleWindows` (from maturity/refetch policy)

and unions them into `planItem.windows`, which `Retrieve All` executes exactly.

The proposed change adds:

- `dbMissingWindows`

and then unions:

- `allWindows = normalise_union(missingWindows ∪ staleWindows ∪ dbMissingWindows)`

where normalisation preserves the existing behaviour:

- windows are sorted and merged if they touch/overlap,
- multiple disjoint windows are preserved as multiple fetch windows,
- the executor is unchanged because it already supports multiple windows via `overrideFetchWindows`.

### 6.2 Where this runs in the pipeline

Per slice in `Retrieve All`:

1. Build the current `FetchPlan` once via `buildFetchPlanProduction` (unchanged).
2. If `checkDbCoverageFirst`:
   - Build coverage subjects from `FetchPlanItem`s (mode-correct; epoch/MECE aware when needed):
     - `param_id` from workspace + plan item objectId
     - `core_hash` from plan item `querySignature`
     - `slice_keys` derived from the slice’s logical slice families (explicit and mode-specific, i.e. `...window()` vs `...cohort()`)
     - `anchor_from/to` from the slice window already computed
     - `include_equivalents = true`
   - Call `/api/snapshots/batch-anchor-coverage`.
3. For each plan item:
   - Convert the returned `missing_anchor_ranges` into additional windows with reason `db_missing`.
   - Union into the plan item windows.
4. Execute as today (plan interpreter mode using `overrideFetchWindows`).

### 6.3 Explicit support for `cohort()` and `window()` query types

This proposal supports both `cohort()` and `window()` query types because the entire existing stack is already mode-aware end-to-end:

- **Planner**: each `FetchPlanItem` has `mode: 'window' | 'cohort'`, and the planner’s coverage/staleness semantics are computed in that mode.
- **Executor**: `Retrieve All` executes the planned windows exactly, and for parameters it passes `skipCohortBounding: true` explicitly because the plan is already correct for the requested mode.
- **Snapshot DB identity**: slice-key normalisation strips args but preserves the mode clause (`window()` vs `cohort()`), and the context-epochs selector explicitly restricts to the requested mode (no cross-mode fallback).

Therefore the DB coverage preflight must be per-mode and must never treat `cohort()` coverage as satisfying a `window()` pass (or vice versa).

### 6.4 Reasoning through MECE + context epochs for DB coverage

We already have complex regime selection logic for snapshot analysis (context epochs) to avoid double counting when the DB history contains:

- an uncontexted regime (`window()` / `cohort()`), and
- one or more context-partition regimes (`context(k:v).window()` / `context(k:v).cohort()`),

including cases introduced by equivalence closure where both regimes exist on the same retrieved day.

The DB coverage preflight for `Retrieve All` must accommodate this, because “DB has coverage” is not the same as “DB has an explicit uncontexted slice”.

#### 6.4.1 What “DB can support this slice” means for uncontexted queries

For an uncontexted slice (no specified context dims), the DB should be treated as able to support the semantic series for the requested mode if **either**:

- **Explicit uncontexted**: the uncontexted logical family exists with full anchor-day coverage, or
- **MECE fulfilment**: a context-partition slice-set exists that is MECE-complete (and combination-complete for multi-dim), and that slice-set has full anchor-day coverage when treated as a union across its member slice keys.

This is exactly the same “implicit uncontexted fulfilment” principle already used in frontend planning against file caches; the only change is that the candidate set is observed from the DB rather than parameter files.

#### 6.4.2 Do not invent new semantics: reuse the existing selection rule

To avoid divergence, DB-side slice-set selection must reuse the same rule family already implemented for context epochs:

- observe available slice families in the equivalence closure via `querySnapshotRetrievals(... include_summary=true, slice_keys=[''] ...)`
- normalise slice keys to logical families with mode preserved (`...window()` vs `...cohort()`)
- apply “least aggregation” selection, MECE-gated per extra dim, plus multi-dim combination completeness
- **never mix regimes** (choose exactly one representation, not “uncontexted + partition”)

Note: the existing selector already contains the crucial uncontexted guardrail:

- when the query is uncontexted, MECE fulfilment may be allowed over observed dims even if nothing is pinned, because linked historic data often exists only as a complete partition.

#### 6.4.3 How epoch-awareness enters a coverage check (no sweep, but still regime-safe)

Unlike `cohort_maturity` analysis, `Retrieve All` is not sweeping over retrieved days. However, equivalence closure can still create a single-day mixed regime where both:

- an explicit uncontexted family, and
- a partition family set

exist on the same retrieved day.

The coverage preflight must therefore apply the same safety property as epochs:

- choose a single regime using the least-aggregation, MECE-gated selector, and
- compute coverage/missingness against the chosen slice-set only.

Operationally, the preflight can stay simple and deterministic by selecting the regime based on the latest observed retrieval group (same “latest wins” determinism principle used elsewhere), then using the chosen slice keys as the selector for the Tier B anchor coverage query.

If we later discover a real history where “latest regime only” is insufficient (pathological churn), we can upgrade this to a per-day (epoch-style) selection with a union-of-regimes coverage check — but we should not add that complexity until data proves it is needed.

### 6.5 “Reason” accounting

To support debugging and confidence, plan windows should remain reasoned, not just raw date ranges. Introduce a third reason:

- `missing` (existing)
- `stale` (existing)
- `db_missing` (new)

At execution time we still pass date ranges only; reasons live in plan artefacts and logs.

---

## 7. Session logging requirements (especially diagnostic-level)

Logging must allow us to debug:

- why a DB-missing window was detected,
- whether equivalence closure expanded as expected,
- which items had their plan widened and by how much,
- whether widening actually produced additional snapshot writes.

### 7.1 Required log artefacts

Add new session log entries under the existing `BATCH_ALL_SLICES` operation:

- **`DB_COVERAGE_PREFLIGHT_START`**: number of subjects, slice DSL, anchor window, include_equivalents.
- **`DB_COVERAGE_PREFLIGHT_RESULT`** (success):
  - counts: subjects ok vs incomplete,
  - total missing days, total missing ranges,
  - sample of widened items (bounded, deterministic).
- **`DB_COVERAGE_PREFLIGHT_FAIL_FALLBACK`** (warning):
  - error message,
  - explicit statement that we proceeded with file-missing + stale only.

Per item (only when it matters):

- **`DB_COVERAGE_ITEM_WIDENED`**:
  - itemKey, param_id, core_hash (current), slice_keys used,
  - original planned days vs new total planned days,
  - missing ranges (compressed),
  - equivalence diagnostics (hashes/params included), at least in diagnostic mode.

### 7.2 Diagnostic mode expectations

In diagnostic mode (or when `simulate=true`), logs should include the raw-but-bounded detail needed to reproduce:

- the exact selector used for coverage,
- the exact missing ranges returned by backend,
- the exact union result written back into the plan.

This is explicitly aligned with the existing “plan artefact” logging approach (`FETCH_PLAN_BUILT`, “what we did” tables, and dry-run HTTP logging).

---

## 8. Testing strategy (must be extensive and must hit the real DB)

This feature is correctness- and safety-critical because it changes what the system fetches automatically and because it relies on transitive hashing / equivalence closure semantics.

Testing must include:

- **Unit tests** for pure “union and window normalisation” behaviour.
- **Integration tests against the real snapshot DB** proving equivalence closure and missing-range derivation are correct.
- **End-to-end retrieve-all tests** that demonstrate the widened plan results in additional snapshot writes (not just planning artefacts).

### 8.1 Backend integration tests (real DB)

Add a new test module in `graph-editor/lib/tests/` that:

- inserts snapshot rows with deliberate anchor-day gaps,
- creates equivalence links (`signature_equivalence`) to test closure,
- calls the new batch anchor coverage function/handler,
- asserts exact missing ranges (not just “incomplete”).

Minimum scenario matrix (illustrative IDs):

- **BC-001 complete contiguous window**: no missing ranges.
- **BC-002 missing prefix**: missing range at start only.
- **BC-003 missing suffix**: missing range at end only.
- **BC-004 internal gaps**: two or more internal missing ranges; verify compression into contiguous windows.
- **BC-005 slice-key scoping**: gaps exist in one slice key but not another; ensure selector respects `slice_keys`.
- **BC-006 transitive equivalence closure covers gaps**:
  - current hash is missing, but an equivalent hash (or equivalent source param) supplies the missing anchor days.
  - expected: coverage_ok true, no missing ranges.
- **BC-007 transitive equivalence closure still has gaps**:
  - partial coverage across closure; expected missing ranges reflect the union-present set.
- **BC-008 multi-hop closure** (A↔B, B↔C): ensure closure is transitive, not one-edge only.

### 8.2 Frontend service tests (planning + orchestration)

Extend service-level tests to prove:

- `Retrieve All` with `checkDbCoverageFirst=false` is unchanged.
- When backend reports missing ranges, the resulting plan windows include `db_missing` windows and execution passes the widened `overrideFetchWindows` set.
- Degradation path: backend error produces a warning log and falls back to existing plan.

These tests do not replace real-DB testing; they are to pin orchestration and logging determinism.

### 8.3 End-to-end “writes happened” tests (real DB)

Add at least one test that:

- seeds a param in the DB with sparse historic coverage,
- runs a retrieve-all-like execution that includes the DB preflight widening,
- asserts that the missing anchor days are now present in the DB after the run.

This is the only class of test that definitively proves “the widened plan actually backfilled the DB”.

---

## 9. Non-goals (for this phase)

- No attempt to redesign the planner or alter cache semantics beyond adding a third “DB missingness” input.
- No attempt to make the backend infer MECE partitions; the frontend remains responsible for slice planning.
- No feature flags or compatibility shims; this is controlled by an explicit run option and shipped as a real behaviour.

---

## 10. Detailed implementation plan

### Phase 1: Backend — new `batch_anchor_coverage` function + endpoint

#### Step 1.1: Core DB function in `snapshot_service.py`

**File**: `graph-editor/lib/snapshot_service.py`

Add a new function `batch_anchor_coverage(subjects)` that, for each subject:

- Resolves the equivalence closure using the same recursive CTE pattern already used by `query_snapshot_retrievals` and `query_virtual_snapshot` (the `WITH RECURSIVE eq(core_hash, source_param_id) AS (...)` + `eq_params` pattern).
- Applies slice-key matching using the existing `_append_slice_filter_sql()` and `_split_slice_selectors()` helpers (these already handle `window()` / `cohort()` uncontexted-only semantics from the context-epochs contract fix).
- Computes `SELECT DISTINCT anchor_day FROM snapshots WHERE ...` within `[anchor_from, anchor_to]` for the resolved closure + slice keys.
- Generates the full expected day set from `anchor_from` to `anchor_to` (inclusive).
- Computes the set difference (expected minus present), then compresses into contiguous `missing_anchor_ranges[]`.
- Returns per-subject results including `coverage_ok`, `missing_anchor_ranges`, `present_anchor_day_count`, `expected_anchor_day_count`, and `equivalence_resolution` diagnostics (list of core hashes and param_ids included after closure expansion).

This function must be batch-friendly: one DB connection, one or few SQL queries covering all subjects (not one query per subject). The equivalence closure CTE is per-subject (it depends on the starting core_hash), so loop over subjects within a single connection but issue one CTE query per subject.

#### Step 1.2: Handler in `api_handlers.py`

**File**: `graph-editor/lib/api_handlers.py`

Add `handle_snapshots_batch_anchor_coverage(data)` following the existing handler pattern:

- Extract and validate `subjects` (list of dicts, each with `param_id`, `core_hash`, `slice_keys`, `anchor_from`, `anchor_to`, `include_equivalents`).
- Parse ISO date strings to `date` objects for `anchor_from/to`.
- Call `batch_anchor_coverage(...)` from `snapshot_service`.
- Return `{"success": True, "results": [...]}`.

#### Step 1.3: Route registration in `dev-server.py`

**File**: `graph-editor/dev-server.py`

Add a new `@app.post("/api/snapshots/batch-anchor-coverage")` route, following the exact same pattern as all other snapshot routes:

- `async def snapshots_batch_anchor_coverage(request: Request)`
- try/except with `ValueError` → 400, `Exception` → 500
- Import `handle_snapshots_batch_anchor_coverage` from `api_handlers` inside the function

#### Step 1.4: Vercel route in `vercel.json`

**File**: `graph-editor/vercel.json`

Add a new rewrite entry:

- `"source": "/api/snapshots/batch-anchor-coverage"` → `"destination": "/api/python-api?endpoint=snapshots-batch-anchor-coverage"`

#### Step 1.5: Vercel serverless dispatch in `python-api.py`

**File**: `graph-editor/api/python-api.py`

Add the new route in both dispatch locations:

- Endpoint mapping: `elif endpoint == 'snapshots-batch-anchor-coverage': path = '/api/snapshots/batch-anchor-coverage'`
- Path handler: `elif path == '/api/snapshots/batch-anchor-coverage': self.handle_snapshots_batch_anchor_coverage(data)`
- Handler method: `def handle_snapshots_batch_anchor_coverage(self, data)` following the exact same try/except + import-from-api_handlers pattern

#### Step 1.6: Route parity test updates

**Files**:
- `graph-editor/lib/tests/test_api_route_parity.py`
- `graph-editor/tests/test_api_route_parity.py`

Add `snapshots-batch-anchor-coverage` to the `extract_python_api_routes` endpoint mapping in **both** files so the parity assertion passes.

---

### Phase 2: Backend tests — real DB integration (batch anchor coverage)

#### Step 2.1: New test module

**File**: `graph-editor/lib/tests/test_batch_anchor_coverage.py` (new)

Follow the existing test patterns from `test_snapshot_read_integrity.py`:

- `TEST_PREFIX = 'pytest-bac-'`
- `SIG_ALGO = "sig_v1_sha256_trunc128_b64url"`
- `append_snapshots_for_test(...)` helper wrapping `append_snapshots(...)` with flexi-sigs contract
- `cleanup_test_data()` deleting from `snapshots`, `signature_registry`, `signature_equivalence` by prefix
- `@pytest.fixture(scope='module', autouse=True)` for setup/cleanup
- `pytestmark = pytest.mark.skipif(not os.environ.get('DB_CONNECTION'), ...)`
- Import `batch_anchor_coverage`, `get_db_connection`, `append_snapshots`, `short_core_hash_from_canonical_signature`, `create_equivalence_link` from `snapshot_service`

Tests (each is a separate method in `class TestBatchAnchorCoverage`):

- **BC-001** `test_complete_contiguous_window`: insert 5 days of data, request coverage for those 5 days → `coverage_ok=True`, empty `missing_anchor_ranges`.
- **BC-002** `test_missing_prefix`: insert days 3–5 only, request 1–5 → missing range `[day1, day2]`.
- **BC-003** `test_missing_suffix`: insert days 1–3 only, request 1–5 → missing range `[day4, day5]`.
- **BC-004** `test_internal_gaps`: insert days 1, 2, 5, 8, 9, 10, request 1–10 → two missing ranges `[day3, day4]` and `[day6, day7]`.
- **BC-005** `test_slice_key_scoping`: insert `context(channel:google).window()` for all 5 days, insert `context(channel:facebook).window()` for days 1–3 only. Request with `slice_keys=['context(channel:facebook).window()']` → missing range `[day4, day5]`. Request with `slice_keys=['context(channel:google).window()']` → `coverage_ok=True`.
- **BC-006** `test_equivalence_closure_covers_gaps`: insert under `hash-A` for days 1–3, insert under `hash-B` for days 4–5. Create equivalence link `hash-A ≡ hash-B`. Request with `core_hash=hash-A, include_equivalents=True` → `coverage_ok=True`.
- **BC-007** `test_equivalence_closure_partial_gaps`: insert under `hash-A` for days 1–3, insert under `hash-B` for day 5 only. Create link A≡B. Request 1–5 → missing range `[day4, day4]`.
- **BC-008** `test_multi_hop_closure`: three hashes A, B, C. Insert A for days 1–2, B for day 3, C for days 4–5. Create links A≡B and B≡C. Request 1–5 with `core_hash=hash-A` → `coverage_ok=True` (transitive closure).
- **BC-009** `test_window_vs_cohort_mode_separation`: insert `window()` slice for all 5 days, insert `cohort()` slice for days 1–3 only. Request with `slice_keys=['cohort()']` → missing `[day4, day5]`. Request with `slice_keys=['window()']` → `coverage_ok=True`.
- **BC-010** `test_equivalence_diagnostics`: verify the `equivalence_resolution` field in the response contains the correct expanded core hashes and param_ids.
- **BC-011** `test_empty_db_all_missing`: no data inserted, request 1–5 → missing range `[day1, day5]`.
- **BC-012** `test_batch_multiple_subjects`: submit two subjects in one call, each with different coverage; verify independent results.

---

### Phase 3: Frontend types — extend `FetchWindowReason`

#### Step 3.1: Add `db_missing` reason

**File**: `graph-editor/src/services/fetchPlanTypes.ts`

Change:
- `export type FetchWindowReason = 'missing' | 'stale';` → `export type FetchWindowReason = 'missing' | 'stale' | 'db_missing';`

Update `summarisePlan()` to track `dbMissingDays` alongside `missingDays` and `staleDays`. Add `dbMissingDays: number` to `FetchPlanSummary`.

---

### Phase 4: Frontend — new client function for batch anchor coverage

#### Step 4.1: Add `batchAnchorCoverage()` to `snapshotWriteService.ts`

**File**: `graph-editor/src/services/snapshotWriteService.ts`

Add a new exported async function following the exact pattern of `getBatchInventoryV2` and `querySnapshotRetrievals`:

- Function signature: `export async function batchAnchorCoverage(subjects: BatchAnchorCoverageSubject[]): Promise<BatchAnchorCoverageResult[]>`
- Define types `BatchAnchorCoverageSubject` (matching §5.2 request shape) and `BatchAnchorCoverageResult` (matching §5.3 response shape).
- Early-return empty results if `!SNAPSHOTS_ENABLED`.
- POST to `${PYTHON_API_BASE}/api/snapshots/batch-anchor-coverage`.
- On error: log and return empty/error results (graceful degradation).

---

### Phase 5: Frontend — DB coverage preflight logic in `retrieveAllSlicesService.ts`

#### Step 5.1: Thread `checkDbCoverageFirst` option through the service

**File**: `graph-editor/src/services/retrieveAllSlicesService.ts`

Add `checkDbCoverageFirst?: boolean` to `RetrieveAllSlicesOptions` interface.

#### Step 5.2: Implement the preflight + plan augmentation

**File**: `graph-editor/src/services/retrieveAllSlicesService.ts`

After `buildFetchPlanProduction` returns the plan for a slice (existing code at approx line 358), add a new block gated by `checkDbCoverageFirst`:

- Extract `FetchPlanItem`s that are parameters (skip cases, which have no DB identity).
- For each item, derive the coverage subject:
  - `param_id`: `${repository}-${branch}-${item.objectId}` (same pattern as `snapshotDependencyPlanService`).
  - `core_hash`: compute via `computeShortCoreHash(item.querySignature)`.
  - `slice_keys`: derive from `item.sliceFamily` and `item.mode` (same logic as `snapshotDependencyPlanService.mapFetchPlanToSnapshotSubjects` for default slice keys: `sliceFamily ? [sliceFamily + '.' + modeClause] : [modeClause]`).
  - `anchor_from/to`: from the slice's extracted window (already computed).
  - `include_equivalents: true`.
- Call `batchAnchorCoverage(subjects)`.
- For each result with `coverage_ok === false`: convert `missing_anchor_ranges` into `FetchWindow[]` with `reason: 'db_missing'`, then merge into the corresponding plan item's `windows` array.
- Use the existing `mergeDatesToWindows` / `sortWindows` utilities (already imported in `fetchPlanBuilderService.ts`) for normalisation, or implement a simple `mergeWindowsIntoItem()` that unions the new windows with existing ones.
- If any items change from `covered` to `fetch` due to DB gaps, update their `classification`.
- Wrap the entire preflight block in try/catch: on any error, log `DB_COVERAGE_PREFLIGHT_FAIL_FALLBACK` and continue with the unaugmented plan.

#### Step 5.3: Add session logging for the preflight

**File**: `graph-editor/src/services/retrieveAllSlicesService.ts`

Within the preflight block, add calls to `sessionLogService.addChild(logOpId, ...)` for:

- `DB_COVERAGE_PREFLIGHT_START` — before the call
- `DB_COVERAGE_PREFLIGHT_RESULT` — after the call (success)
- `DB_COVERAGE_PREFLIGHT_FAIL_FALLBACK` — in the catch block
- `DB_COVERAGE_ITEM_WIDENED` — per item, when windows are augmented

Include full diagnostic metadata: item keys, param_ids, core_hashes, slice_keys used, original vs augmented window counts/days, equivalence resolution details.

---

### Phase 6: Frontend — wire option through modal and automation

#### Step 6.1: Expose option in `AllSlicesModal.tsx`

**File**: `graph-editor/src/components/modals/AllSlicesModal.tsx`

Add a checkbox in the "Advanced" section of the modal (or create one if it does not exist):

- Label: "Check snapshot DB coverage first (fills historic gaps)"
- State: `const [checkDbCoverage, setCheckDbCoverage] = useState(false);`
- Pass through to `retrieveAllSlicesService.execute({ ..., checkDbCoverageFirst: checkDbCoverage })` in both the simulate and execute paths.

#### Step 6.2: Default to ON for automated runs

**File**: `graph-editor/src/services/dailyRetrieveAllAutomationService.ts`

Where `executeRetrieveAllSlicesWithProgressToast` is called (line ~110), pass `checkDbCoverageFirst: true` into the options. This ensures overnight automated runs always check DB coverage.

Note: `executeRetrieveAllSlicesWithProgressToast` in `retrieveAllSlicesService.ts` (line ~1054) already spreads `...rest` into `retrieveAllSlicesService.execute(...)`, so adding `checkDbCoverageFirst` to `RetrieveAllSlicesOptions` is sufficient; it will propagate through the wrapper automatically.

#### Step 6.3: No changes needed to `useURLDailyRetrieveAllQueue.ts`

**File**: `graph-editor/src/hooks/useURLDailyRetrieveAllQueue.ts`

This hook calls `dailyRetrieveAllAutomationService.run(...)`, which internally calls `executeRetrieveAllSlicesWithProgressToast`. Since the automation service in step 6.2 sets `checkDbCoverageFirst: true`, no changes are needed in the hook.

---

### Phase 7: Frontend tests — orchestration + preflight behaviour

#### Step 7.1: Extend existing `retrieveAllSlicesService.test.ts`

**File**: `graph-editor/src/services/__tests__/retrieveAllSlicesService.test.ts`

Add new test cases (within the existing `describe` block) following the established mock patterns:

**New mocks needed**: mock `batchAnchorCoverage` from `snapshotWriteService` and `computeShortCoreHash` from `coreHashService`.

Tests:

- **RADB-001** `checkDbCoverageFirst=false does not call batchAnchorCoverage`: mock `buildFetchPlanProduction` with a plan that has items classified as `covered`, run without `checkDbCoverageFirst`, assert `batchAnchorCoverage` was not called, assert plan is unchanged.

- **RADB-002** `checkDbCoverageFirst=true calls batchAnchorCoverage and widens plan`: mock `buildFetchPlanProduction` with a `covered` item (no existing windows). Mock `batchAnchorCoverage` to return `coverage_ok=false` with `missing_anchor_ranges: [{start: '2025-12-01', end: '2025-12-03'}]`. Assert that the item is now classified as `fetch` and that `overrideFetchWindows` in the `getFromSource` call includes the DB-missing window.

- **RADB-003** `checkDbCoverageFirst=true, backend error falls back gracefully`: mock `batchAnchorCoverage` to throw. Assert that the run completes without error, that no items are widened, and that `DB_COVERAGE_PREFLIGHT_FAIL_FALLBACK` would have been logged (verify by checking `sessionLogService.addChild` mock calls).

- **RADB-004** `checkDbCoverageFirst=true unions DB-missing with existing stale/missing windows`: mock plan with item that has `windows: [{start: '1-Dec-25', end: '3-Dec-25', reason: 'stale', dayCount: 3}]`. Mock `batchAnchorCoverage` to return `missing_anchor_ranges: [{start: '2025-12-05', end: '2025-12-07'}]`. Assert the resulting `overrideFetchWindows` contains both the stale window and the db_missing window.

- **RADB-005** `mode-correctness: window vs cohort slice keys are correct`: mock plan with a `cohort` mode item. Assert that the `batchAnchorCoverage` subject has `slice_keys` ending in `.cohort()`, not `.window()`.

#### Step 7.2: Extend existing `snapshotDependencyPlanService.test.ts`

**File**: `graph-editor/src/services/__tests__/snapshotDependencyPlanService.test.ts`

No new tests needed here; the context-epoch logic and MECE selection are already tested. The DB coverage preflight reuses those primitives and is tested via the `retrieveAllSlicesService.test.ts` orchestration tests above.

---

### Phase 8: Backend tests — route parity

#### Step 8.1: Verify route parity passes

**Files**:
- `graph-editor/lib/tests/test_api_route_parity.py`
- `graph-editor/tests/test_api_route_parity.py`

After adding the new route in steps 1.3–1.6, run both parity test files to confirm the new route is registered consistently across `dev-server.py`, `python-api.py`, and `vercel.json`.

---

### Summary: every file touched

| File | Change | Phase |
|---|---|---|
| `graph-editor/lib/snapshot_service.py` | New `batch_anchor_coverage()` function | 1.1 |
| `graph-editor/lib/api_handlers.py` | New `handle_snapshots_batch_anchor_coverage()` handler | 1.2 |
| `graph-editor/dev-server.py` | New `@app.post("/api/snapshots/batch-anchor-coverage")` route | 1.3 |
| `graph-editor/vercel.json` | New rewrite entry for `batch-anchor-coverage` | 1.4 |
| `graph-editor/api/python-api.py` | New endpoint mapping + handler method | 1.5 |
| `graph-editor/lib/tests/test_api_route_parity.py` | Add `snapshots-batch-anchor-coverage` to endpoint map | 1.6 |
| `graph-editor/tests/test_api_route_parity.py` | Add `snapshots-batch-anchor-coverage` to endpoint map | 1.6 |
| `graph-editor/lib/tests/test_batch_anchor_coverage.py` | **NEW** — 12 real-DB integration tests (BC-001 through BC-012) | 2.1 |
| `graph-editor/src/services/fetchPlanTypes.ts` | Extend `FetchWindowReason` with `'db_missing'`; extend `FetchPlanSummary` with `dbMissingDays` | 3.1 |
| `graph-editor/src/services/snapshotWriteService.ts` | New `batchAnchorCoverage()` client function + types | 4.1 |
| `graph-editor/src/services/retrieveAllSlicesService.ts` | Add `checkDbCoverageFirst` option; implement preflight + plan augmentation + session logging | 5.1–5.3 |
| `graph-editor/src/components/modals/AllSlicesModal.tsx` | Add "Check snapshot DB coverage" checkbox; pass option through | 6.1 |
| `graph-editor/src/services/dailyRetrieveAllAutomationService.ts` | Pass `checkDbCoverageFirst: true` for automated runs | 6.2 |
| `graph-editor/src/services/__tests__/retrieveAllSlicesService.test.ts` | 5 new orchestration tests (RADB-001 through RADB-005) | 7.1 |

---

## 11. Expected impact

When enabled, `Retrieve All` becomes robust to:

- starting snapshotting mid-history, and
- hash/equivalence drift that would otherwise strand historic holes in the DB.

It does so with:

- one extra batch call per slice (preflight),
- deterministic plan widening,
- comprehensive session logs for post-mortem debugging, and
- test coverage that explicitly exercises transitive equivalence closure and anchor-day gap detection against the real DB.

