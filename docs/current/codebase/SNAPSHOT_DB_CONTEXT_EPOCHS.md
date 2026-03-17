# Context Epochs: Regime-Safe Cohort Maturity Under Mixed Slice Histories

**Source**: `docs/current/project-db/context-epochs.md`
**Status**: Implemented (10-Feb-26)
**Last reviewed**: 17-Mar-26

---

## 1. Problem

Cohort maturity charting fails when the snapshot DB contains **multiple cohort regimes** for the same semantic subject:

- **Contexted regime**: MECE partition of context slices (e.g. `context(channel:paid-search).cohort()`)
- **Uncontexted regime**: single uncontexted slice (`cohort()`)

When both exist for the **same retrieved day**, blind summation across slices yields inflated totals — the "drop then rise" artefact in closed cohort charts.

### Root cause

Mixed regimes can be created by:
- Changes in how slices are fetched over time (regime change in pinned interests / context configuration)
- Signature equivalence links that unify subjects with different historical regimes

---

## 2. Critical Invariants

### "Never sum context slices blindly"

Summation across `context(...)` slices is only permissible when the slice set is MECE-valid for the relevant context key(s). This is a **frontend responsibility** because MECE-ness depends on user-declared policy.

### Backend must not infer MECE

The backend must not decide whether a set of slices is safe to aggregate. Regime selection is encoded explicitly in the request.

### Cohort maturity is day-based

Epochs keyed by retrieved **day** (UTC). Multiple `retrieved_at` within a day → "latest wins" rule.

### "Least aggregation" tie-break

When multiple valid representations exist for the same day, choose the one requiring **least aggregation** (fewest extra dimensions to marginalise away).

---

## 3. The Epoch Approach

For each cohort maturity subject:

1. **Observe availability**: per-day map of which slice families exist (from retrieval summaries)
2. **Choose regime per day**: using frontend MECE logic, select exactly one regime (uncontexted OR explicit MECE partition)
3. **Segment into epochs**: group consecutive days with same regime
4. **Execute segmented sweep**: one analysis request per epoch with explicit `slice_keys`
5. **Stitch results**: merge epoch results into single maturity curve

### Selection rule per day

1. Partition retrieval summaries by `retrieved_at` timestamp within each UTC day
2. Select latest retrieval group (deterministic)
3. Enumerate candidate regimes, compute extra dims `E = D \ S` for each
4. Select candidate with minimum `|E|` (then fewest families as tie-break)
5. MECE-validate any candidate requiring aggregation
6. If no valid candidate → day is a gap (missing data)

### Slice selector semantics

Epoch subjects MUST use regime-exact selectors:
- **Uncontexted-only**: `slice_keys = ['cohort()']` — means *only* the uncontexted family
- **Contexted regime**: `slice_keys = ['context(k:v1).cohort()', ...]` — explicit MECE set

MUST NOT use `slice_keys = ['']` (no filter) — that reintroduces mixed-regime summation.

---

## 4. Key Source Locations

**Frontend (TypeScript):**
- `src/services/snapshotDependencyPlanService.ts` — `chooseLatestRetrievalGroupPerDay()`, `selectLeastAggregationSliceKeysForDay()`, `segmentSweepIntoEpochs()`, epoch orchestration in `mapFetchPlanToSnapshotSubjects()`
- `src/lib/graphComputeClient.ts` — `collapseEpochSubjectId()`, `pickEpochPayloadForAsAt()` (stitching)

**Backend (Python):**
- `lib/snapshot_service.py` — `_split_slice_selectors()`, `_append_slice_filter_sql()` (uncontexted-only selector contract)

**Existing services reused (not duplicated):**
- `src/services/sliceIsolation.ts` — `extractSliceDimensions()`
- `src/services/dimensionalReductionService.ts` — `tryDimensionalReduction()`
- `src/services/meceSliceService.ts` — `selectImplicitUncontextedSliceSetSync()`

---

## 5. Test Coverage

| Test file | Tests | Coverage |
|-----------|-------|---------|
| `lib/tests/test_snapshot_read_integrity.py` (CE-001–012) | 12 | Backend slice selector contract |
| `src/services/__tests__/snapshotDependencyPlanService.test.ts` | 3 | Epoch splitting, rolling retrieved_at, non-MECE → gap |
| `src/lib/__tests__/graphComputeClient.test.ts` | 1 | Epoch stitching |
| `lib/tests/test_graceful_degradation.py` (GD-004) | 1 | Empty epoch handling |
