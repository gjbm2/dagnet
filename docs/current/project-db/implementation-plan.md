# Snapshot DB Implementation Plan

**Status:** Draft  
**Created:** 1-Feb-26  
**Last Updated:** 1-Feb-26  
**Design Reference:** `snapshot-db-design.md`

---

## Implementation Progress Tracker

> **Instructions:** Update this section as implementation proceeds. Mark items `[x]` when complete, `[~]` when in progress, `[ ]` when pending.

| Phase | Status | Completion Date | Notes |
|-------|--------|-----------------|-------|
| Phase 0: Prerequisites | `[ ]` Pending | — | |
| Phase 1: Foundation (Write Path) | `[ ]` Pending | — | |
| Phase 2: Read Path (Analytics) | `[ ]` Pending | — | |
| Phase 3: UI Integration | `[ ]` Pending | — | |
| Phase 4: Historical Queries (asAt) | `[ ]` Pending | — | |
| Phase 5: Advanced Charting | `[ ]` Deferred | — | See `time-series-charting.md` |

**Critical Milestones:**
- [ ] First successful shadow-write to production DB
- [ ] First successful histogram derivation from DB data
- [ ] All data integrity tests passing
- [ ] Production rollout complete

---

## Companion Documents

This implementation plan is part of a documentation suite. Each document has a specific scope:

| Document | Scope | When to Reference |
|----------|-------|-------------------|
| **`snapshot-db-design.md`** | Comprehensive design reference (schema, data flow, signatures, derivation algorithms) | For technical details, algorithms, rationale |
| **`asat.md`** | Historical query (`asAt()`) design and implementation | Phase 4 implementation; DSL parsing, fork logic, UI |
| **`onset.md`** | Onset delay (`onset_delta_days`) for shifted lognormal latency fitting | Latency improvement; schema extension, completeness integration |
| **`time-series-charting.md`** | Advanced charting (fan charts, evidence/forecast, aggregation) | Phase 5+ (deferred); charting enhancements |
| **`initial-thinking.md`** | Original problem statement and commercial requirements | Context and motivation |

**What this document covers:**
- Phases 0-4: Write path, read path, UI integration, asAt queries
- File-by-file change specifications
- Testing requirements for data integrity
- Rollout plan and risk mitigation

**What is delegated to companion documents:**
- **Phase 4 (asAt) detail:** `asat.md` provides the authoritative implementation guide, including 8 file-specific implementation sections, 30+ file impact analysis, and testing matrix
- **Phase 5 (charting):** `time-series-charting.md` covers fan charts, evidence/forecast distinction, configurable aggregation, latency drift analysis

---

## Pre-Implementation Blockers (Resolved)

The following blocking ambiguities were identified and resolved before Phase 1 can proceed. See `snapshot-db-design.md` for full specifications.

| Blocker | Issue | Resolution |
|---------|-------|------------|
| **A: API Surface** | Two competing analysis endpoints proposed | ✅ Extend `/api/runner/analyze` with `snapshot_query`; no new `/api/snapshots/analyze` |
| **B: Inventory Route** | Per-param GET vs batch POST | ✅ Batch POST only (`POST /api/snapshots/inventory` with `{param_ids: [...]}`) |
| **C: Route Ownership** | Health endpoint defined inline; no production routing | ✅ Handlers in `lib/snapshot_handlers.py`; routed from both `dev-server.py` and `api/python-api.py` |
| **D: Timestamp Semantics** | `retrieved_at` timezone ambiguity | ✅ `TIMESTAMPTZ` with explicit UTC; display in `d-MMM-yy` |
| **E: Test DB Strategy** | No executable test infrastructure | ✅ Neon test branch; Python integration tests; TS mocks Python responses |

**Resolved:** Context Definition Stability — Option C selected (store both `core_hash` and `context_def_hashes`; V1 queries use `core_hash` only). See `snapshot-db-design.md` §3.8.6.

---

## Executive Summary

This document provides a phased implementation plan for the Snapshot DB feature, which enables:
1. **Daily snapshot persistence** — Store A/X/Y counts and latency data for historical analysis
2. **Histogram derivation** — Compute conversion lag distributions from snapshot deltas
3. **Daily conversions analysis** — Track conversion counts by calendar date
4. **Historical queries (`asAt`)** — View data as it was known at a specific past date (see `asat.md`)
5. **Advanced charting** — Fan charts, time-series, evidence/forecast (deferred; see `time-series-charting.md`)

**Total estimated effort:** 8-12 days across Phases 0-4 (Phase 5 deferred)

---

## Phase 0: Prerequisites (1-2 days)

### 0.1 Fix Latency Data Preservation

**Problem:** Latency fields are lost during dual-query and composite query combination.

**Files:**
- `graph-editor/src/services/dataOperationsService.ts`
- `graph-editor/src/lib/das/compositeQueryExecutor.ts`

**Changes:**
1. In `dataOperationsService.ts` dual-query combination (~line 6300):
   - Preserve `median_lag_days`, `mean_lag_days` from k_query result
   - Preserve `anchor_median_lag_days`, `anchor_mean_lag_days` from k_query result

2. In `compositeQueryExecutor.ts` combination logic:
   - Pass through latency fields when combining sub-query results

**Verification:**
- Run existing latency tests
- Add test case: dual-query with latency → verify latency preserved in merged result

**Acceptance:** All existing tests pass, latency data flows through to parameter files.

---

### 0.2 Verify Signature Includes Cohort Mode

**Status:** ✅ Already verified in design phase

The `coreCanonical` object in `computeQuerySignature()` includes:
```typescript
cohort_mode: !!queryPayload.cohort
```

**No changes required.**

---

### 0.3 Extract and Derive `onset_delta_days` from Amplitude Histogram

**Problem:** Amplitude provides `stepTransTimeDistribution` histogram data. This is already extracted by the DAS adapter but not fully processed or persisted. We need to derive `onset_delta_days` (onset delay before conversions begin) for improved latency fitting.

**Critical Design Constraints:**

1. **Window slices only**: Onset is only meaningful for window() slices. Cohort() slices have histogram data limited to ~10 days, which is insufficient for long-latency edges — onset derived from cohort() data would be unreliable.

2. **Aggregation in LAG topo pass**: Edge-level onset must be aggregated (via `min()`) across all window() slices in the same place that computes t95/completeness — i.e., inside `enhanceGraphLatencies()`. This ensures:
   - Order-independent aggregation (not "last fetch wins")
   - Mode-consistency (cohort-mode can still use window-derived onset)
   - Single aggregation engine (no duplicate codepaths)

3. **No `anchor_onset_delta_days`**: Window slices are 2-step (X→Y) with no anchor component. The `anchor_latency` block only exists for cohort() queries, which have unreliable onset data anyway.

**Complete Data Flow:**
```
Amplitude API Response
  └── data[0].stepTransTimeDistribution: { segment_index, step_bins: [...] }
      ↓
connections.yaml (DAS Adapter)
  └── extract: step_trans_time_distribution ← jmes: "data[0].stepTransTimeDistribution"
  └── transform: lag_histogram ← jsonata (BUG FIX needed: use step_bins[])
  └── transform: onset_delta_days ← jsonata (NEW: first non-zero bin in days)
      ↓
      NOTE: onset only extracted for window() slices (adapter conditional)
      ↓
DASRunner.ts → result.raw
  └── result.raw.onset_delta_days ← NEW
  └── result.raw.time_series[].median_lag_days ← WORKING
      ↓
dataOperationsService.ts → mergeTimeSeriesIntoParameter()
  └── latencySummary: { median_lag_days, mean_lag_days, onset_delta_days }
      ↓
Parameter File (YAML)
  └── values[].latency.onset_delta_days ← per-slice value (window slices only)
      ↓
fetchDataService.ts → enhanceGraphLatencies() (LAG TOPO PASS)
  └── For each edge:
      1. Read all values[] for edge via paramLookup
      2. Filter to window() slices only (sliceDSL contains 'window(')
      3. Extract onset_delta_days from each window slice
      4. AGGREGATE: edge-level onset = min(window slice onsets)
         Precedence: uncontexted window slice > min(contexted window slices)
      5. Use aggregated onset in shifted lognormal fitting
      6. Emit onset in EdgeLAGValues
      ↓
UpdateManager.applyBatchLAGValues()
  └── Writes onset_delta_days to graph edge (p.latency.onset_delta_days)
      ↓
UpdateManager (Graph → File sync, explicit persistence)
  └── latency.onset_delta_days (edge-level) ← p.latency.onset_delta_days
      ↓
UpdateManager (File → Graph sync, on load)
  └── p.latency.onset_delta_days ← latency.onset_delta_days (edge-level)
```

**Key difference from current `t95` flow**: `t95` is *computed* via lognormal fitting. `onset_delta_days` is *aggregated* (min) from raw slice data. Both happen in the same LAG topo pass.

---

#### 0.3.1 Precise Schema Changes

**File 1: `graph-editor/src/types/index.ts` (Graph Types)**

**Location:** Inside `LatencyConfig` interface (around line 471-510)

**Current** (ends with):
```typescript
  /** Weighted mean lag in days (used with median to compute t95) */
  mean_lag_days?: number;
  
  /** Maturity progress 0-1 (see design §5.5) */
  completeness?: number;
}
```

**Add before closing brace:**
```typescript
  /** Onset delay (days) before conversions begin on this edge.
   *  Derived from Amplitude histogram; used for shifted completeness model.
   */
  onset_delta_days?: number;
  /** True if user manually set onset_delta_days */
  onset_delta_days_overridden?: boolean;
```

---

**File 2: `graph-editor/public/param-schemas/parameter-schema.yaml`**

**Location:** Inside `values[].latency` properties (after line 255, after `t95`)

**Add:**
```yaml
            onset_delta_days:
              type: number
              minimum: 0
              description: "Onset delay (days) before conversions begin on this edge"
            onset_delta_days_overridden:
              type: boolean
              default: false
              description: "If true, user manually set onset_delta_days"
```

**NOTE:** Do NOT add onset_delta_days to `values[].anchor_latency`. Window slices (which provide onset data) have no anchor component. Anchor_latency only exists for cohort() queries, which have unreliable onset data.

---

**File 3: `graph-editor/src/types/parameterData.ts`**

**Location:** Inside `ParameterValue.latency` type (around line 46-51)

**Current:**
```typescript
  latency?: {
    median_lag_days?: number;
    mean_lag_days?: number;
    completeness?: number;
    t95?: number;
  };
```

**Change to:**
```typescript
  latency?: {
    median_lag_days?: number;
    mean_lag_days?: number;
    completeness?: number;
    t95?: number;
    onset_delta_days?: number;
    onset_delta_days_overridden?: boolean;
  };
```

---

**File 3: `graph-editor/src/services/windowAggregationService.ts`**

**Location 1:** `MergeOptions.latencySummary` interface (around line 1428-1431)

**Current:**
```typescript
  latencySummary?: {
    median_lag_days?: number;
    mean_lag_days?: number;
  };
```

**Change to:**
```typescript
  latencySummary?: {
    median_lag_days?: number;
    mean_lag_days?: number;
    onset_delta_days?: number;
  };
```

**Location 2:** `TimeSeriesPointWithLatency` interface (around line 1410-1421)

**Add field:**
```typescript
  onset_delta_days?: number;  // Onset delay before conversions begin
```

---

#### 0.3.2 Precise Adapter Changes

**File: `graph-editor/public/defaults/connections.yaml`**

**Change 1 (BUG FIX):** Line 617-618, fix histogram extraction

**Current:**
```yaml
        - name: lag_histogram
          jsonata: "step_trans_time_distribution[$number($queryPayload.to_step_index)]"
```

**Change to:**
```yaml
        - name: lag_histogram
          jsonata: "step_trans_time_distribution.step_bins[$number($queryPayload.to_step_index)]"
```

**Change 2 (NEW):** After line 618, add onset derivation transform

```yaml
        # Derive onset_delta_days: smallest whole day with conversions > 0
        # NOTE: Only meaningful for window() slices; cohort() histogram is truncated
        - name: onset_delta_days
          jsonata: |
            (
              $bins := lag_histogram.bins;
              $msPerDay := 86400000;
              /* Find first bin with uniques > 0 */
              $firstNonZero := $filter($bins, function($b) { $b.bin_dist.uniques > 0 })[0];
              $firstNonZero ? $floor($firstNonZero.start / $msPerDay) : null
            )
```

**NOTE:** No `anchor_onset_delta_days` transform. Window slices (the only source of reliable onset data) have no anchor component.

---

#### 0.3.3 Precise UpdateManager Mappings

**File: `graph-editor/src/services/UpdateManager.ts`**

UpdateManager provides bidirectional sync for edge-level onset. However, onset aggregation does NOT use `values[latest]` (which would be "last fetch wins"). Instead:

1. Per-slice onset is stored in `values[].latency.onset_delta_days`
2. Edge-level onset is aggregated in the LAG topo pass (`enhanceGraphLatencies`)
3. LAG pass writes to graph via `applyBatchLAGValues`
4. UpdateManager syncs graph ↔ file for the edge-level value

**Location 1:** Graph → File mappings (around line 1669-1695, after path_t95 mappings)

**Add:**
```typescript
      // onset_delta_days: onset delay (aggregated in LAG topo pass, user-overridable)
      { 
        sourceField: 'p.latency.onset_delta_days', 
        targetField: 'latency.onset_delta_days',
        overrideFlag: 'latency.onset_delta_days_overridden',
        condition: (source) => source.p?.latency?.onset_delta_days !== undefined && source.p?.id
      },
      {
        sourceField: 'p.latency.onset_delta_days_overridden',
        targetField: 'latency.onset_delta_days_overridden',
        requiresIgnoreOverrideFlags: true,
        condition: (source) => source.p?.latency?.onset_delta_days_overridden !== undefined && source.p?.id
      },
```

**Location 2:** File → Graph mappings (around line 2098-2112, after path_t95 mappings)

**Add to CONFIG section only:**
```typescript
      // onset_delta_days: onset delay (user-overridable, edge-level)
      { 
        sourceField: 'latency.onset_delta_days', 
        targetField: 'p.latency.onset_delta_days',
        overrideFlag: 'p.latency.onset_delta_days_overridden',
        condition: isProbType
      },
      { sourceField: 'latency.onset_delta_days_overridden', targetField: 'p.latency.onset_delta_days_overridden', requiresIgnoreOverrideFlags: true },
```

**IMPORTANT:** Do NOT add a `values[latest].latency.onset_delta_days` → graph mapping. This would cause "last fetch wins" bugs. Edge-level onset comes from the LAG topo pass aggregation, not from `values[latest]`.

---

#### 0.3.4 Precise Service Changes

**File 1: `graph-editor/src/services/dataOperationsService.ts`**

Pass onset through to values[] storage (per-slice).

**Location 1:** Around line 6642, after `const rawData = result.raw as any;`

**Add extraction:**
```typescript
// Extract onset_delta_days from histogram (if present, window slices only)
const onset_delta_days = rawData?.onset_delta_days ?? null;
```

**Location 2:** Find call to `mergeTimeSeriesIntoParameter()` (~line 7031) and ensure `latencySummary` includes onset:

```typescript
latencySummary: {
  median_lag_days: rawData?.median_lag_days,
  mean_lag_days: rawData?.mean_lag_days,
  onset_delta_days: rawData?.onset_delta_days,  // NEW: per-slice value
},
```

**NOTE:** This stores per-slice onset in `values[].latency.onset_delta_days`. The edge-level aggregation happens in the LAG topo pass (below).

---

**File 2: `graph-editor/src/services/statisticalEnhancementService.ts`**

Add onset aggregation to the LAG topo pass.

**Location:** Inside `enhanceGraphLatencies()`, at the start of the per-edge processing loop (around line 2020-2030, after `cohortsAll` is computed)

**Add onset aggregation:**
```typescript
// Aggregate onset_delta_days from window() slices only
// Precedence: uncontexted window slice > min(contexted window slices)
const windowSlices = paramValues.filter(v => 
  (v as any).sliceDSL?.includes('window(') && 
  typeof (v as any).latency?.onset_delta_days === 'number'
);

let edgeOnsetDeltaDays: number | undefined;
if (windowSlices.length > 0) {
  // Prefer uncontexted slice if available
  const uncontexted = windowSlices.find(v => 
    !(v as any).sliceDSL?.includes('context(')
  );
  if (uncontexted) {
    edgeOnsetDeltaDays = (uncontexted as any).latency.onset_delta_days;
  } else {
    // Fall back to min across contexted slices
    edgeOnsetDeltaDays = Math.min(
      ...windowSlices.map(v => (v as any).latency.onset_delta_days)
    );
  }
}
```

**Location 2:** Where `EdgeLAGValues` is constructed (around line 2395-2420)

**Add onset to the emitted values:**
```typescript
const edgeLAGValues: EdgeLAGValues = {
  edgeUuid,
  latency: {
    median_lag_days: aggregateMedianLag,
    mean_lag_days: aggregateMeanLag,
    t95: latencyStats.t95,
    completeness: completenessUsed,
    path_t95: edgePathT95,
    onset_delta_days: edgeOnsetDeltaDays,  // NEW: aggregated from window slices
  },
  // ... rest of EdgeLAGValues
};
```

---

**File 3: `graph-editor/src/services/UpdateManager.ts`**

Extend `applyBatchLAGValues` to write onset to graph.

**Location:** Inside `applyBatchLAGValues()` (around line 3505-3520)

**Add after completeness write:**
```typescript
// onset_delta_days: only write if not overridden and value provided
if (update.latency.onset_delta_days !== undefined && 
    edge.p.latency.onset_delta_days_overridden !== true) {
  edge.p.latency.onset_delta_days = update.latency.onset_delta_days;
}
```

---

#### 0.3.5 Complete File Impact List

**CRITICAL: Branch the repo before commencing code build.**
```bash
git checkout -b feature/onset-delta-days
```

**A. Adapter Layer (DAS):**

| File | Change Type | Description |
|------|-------------|-------------|
| `graph-editor/public/defaults/connections.yaml` | MODIFY | Fix lag_histogram indexing; add onset_delta_days transform |

**B. Type Definitions:**

| File | Change Type | Description |
|------|-------------|-------------|
| `graph-editor/src/types/index.ts` | MODIFY | Add onset_delta_days + _overridden to LatencyConfig |
| `graph-editor/src/types/parameterData.ts` | MODIFY | Add onset_delta_days to ParameterValue.latency |

**C. Schema:**

| File | Change Type | Description |
|------|-------------|-------------|
| `graph-editor/public/param-schemas/parameter-schema.yaml` | MODIFY | Add onset_delta_days to edge-level latency AND values[].latency |

**D. Services (Core Logic):**

| File | Change Type | Description |
|------|-------------|-------------|
| `graph-editor/src/services/windowAggregationService.ts` | MODIFY | Extend MergeOptions.latencySummary + TimeSeriesPointWithLatency |
| `graph-editor/src/services/dataOperationsService.ts` | MODIFY | Extract onset from DAS result; pass to mergeTimeSeriesIntoParameter |
| `graph-editor/src/services/statisticalEnhancementService.ts` | MODIFY | Aggregate onset in enhanceGraphLatencies; emit in EdgeLAGValues; use in completeness |
| `graph-editor/src/services/UpdateManager.ts` | MODIFY | Graph↔File mappings; applyBatchLAGValues writes onset |
| `graph-editor/src/services/fetchDataService.ts` | VERIFY | May need updates if LAGHelpers interface changes |

**E. UI Components:**

| File | Change Type | Description |
|------|-------------|-------------|
| `graph-editor/src/components/ParameterSection.tsx` | MODIFY | Add onset_delta_days display/edit field in latency section |
| `graph-editor/src/components/edges/ConversionEdge.tsx` | MODIFY | Add onset to tooltip display |
| `graph-editor/src/components/edges/edgeBeadHelpers.tsx` | VERIFY | May need onset in bead data |
| `graph-editor/src/components/canvas/buildScenarioRenderEdges.ts` | VERIFY | May need onset for scenario rendering |

**F. Documentation:**

| File | Change Type | Description |
|------|-------------|-------------|
| `graph-editor/public/docs/lag-statistics-reference.md` | MODIFY | Document shifted completeness formula |

---

#### 0.3.6 Comprehensive Test Coverage Requirements

**A. Existing Tests to EXTEND (DAS/Extraction):**

| Test File | Current Coverage | Required Extension |
|-----------|------------------|-------------------|
| `lib/das/__tests__/amplitudeThreeStepFunnel.integration.test.ts` | Tests median_lag_days, mean_lag_days extraction | Add: onset_delta_days extraction from reference data |

**B. Existing Tests to EXTEND (File Storage/Merge):**

| Test File | Current Coverage | Required Extension |
|-----------|------------------|-------------------|
| `services/__tests__/windowAggregationService.test.ts` | Tests mergeTimeSeriesIntoParameter | Add: onset_delta_days in latencySummary flows to values[] |
| `services/__tests__/mergeTimeSeriesInvariants.test.ts` | Tests merge invariants | Add: onset_delta_days preserved through merge |
| `services/__tests__/abBcSmoothLag.paramPack.amplitude.e2e.test.ts` | E2E with Amplitude data | Add: onset_delta_days persisted to param file |

**C. Existing Tests to EXTEND (LAG Topo Pass):**

| Test File | Current Coverage | Required Extension |
|-----------|------------------|-------------------|
| `services/__tests__/statisticalEnhancementService.test.ts` | Tests computeEdgeLatencyStats, enhanceGraphLatencies | Add: onset aggregation (min), precedence rule, shifted completeness |
| `services/__tests__/lagStatsFlow.integration.test.ts` | Tests LAG flow end-to-end | Add: onset flows through LAG pass to graph |
| `services/__tests__/pathT95CompletenessConstraint.test.ts` | Tests completeness with t95 constraint | Add: completeness with onset shift |
| `services/__tests__/cohortEvidenceDebiasing.e2e.test.ts` | Tests cohort evidence handling | Add: verify cohort slices don't contribute onset |

**D. Existing Tests to EXTEND (UpdateManager/Graph Sync):**

| Test File | Current Coverage | Required Extension |
|-----------|------------------|-------------------|
| `services/__tests__/updateManager.applyBatchLAGValues.pStdevFallback.test.ts` | Tests applyBatchLAGValues | Add: onset written to graph, respects override |
| `services/__tests__/persistGraphMasteredLatencyToParameterFiles.test.ts` | Tests graph→file latency sync | Add: onset_delta_days syncs graph→file |
| `services/__tests__/UpdateManager.*.test.ts` (all) | Tests UpdateManager mappings | Add: onset_delta_days bidirectional sync |

**E. Existing Tests to EXTEND (E2E/Integration):**

| Test File | Current Coverage | Required Extension |
|-----------|------------------|-------------------|
| `services/__tests__/fetchMergeEndToEnd.test.ts` | Tests fetch→merge flow | Add: onset flows through full pipeline |
| `services/__tests__/windowCohortSemantics.paramPack.e2e.test.ts` | Tests window vs cohort semantics | Add: onset only from window slices |
| `services/__tests__/batchFetchE2E.comprehensive.test.ts` | Tests batch fetch | Add: onset aggregation across multiple fetches |

**F. New Tests Required:**

| Test | File | Description |
|------|------|-------------|
| `onset_histogram_extraction.test.ts` | `lib/das/__tests__/` | Unit: JSONata transform extracts onset from step_bins correctly |
| `onset_delta_derivation.test.ts` | `lib/das/__tests__/` | Unit: First-conversion derivation logic for various histogram shapes |
| `onset_aggregation.test.ts` | `services/__tests__/` | Unit: min() aggregation across window slices |
| `onset_precedence.test.ts` | `services/__tests__/` | Unit: uncontexted > min(contexted) precedence |
| `onset_shifted_completeness.test.ts` | `services/__tests__/` | Unit: completeness = 0 during dead-time |
| `onset_roundtrip.integration.test.ts` | `services/__tests__/` | Integration: Amplitude → DAS → file → LAG → graph → file |
| `onset_override_flow.test.ts` | `services/__tests__/` | Integration: User override persists through data fetch |
| `onset_cohort_excluded.test.ts` | `services/__tests__/` | Integration: cohort() slices don't contribute to onset |

**G. UI Tests to ADD:**

| Test | File | Description |
|------|------|-------------|
| `onset_properties_panel.test.tsx` | `components/__tests__/` | Unit: onset field displays, edits, override checkbox |
| `onset_edge_tooltip.test.tsx` | `components/__tests__/` | Unit: onset shown in edge tooltip |

**H. Test Fixtures Required:**

The existing `REFERENCE-axy-funnel-response.json` contains `stepTransTimeDistribution` with histogram bins. Verify:
- `step_bins[1]`: First non-zero bin at 331200000ms = 3.83 days → onset_delta_days = 3
- `step_bins[2]`: Check first non-zero bin for X→Y transition

**I. Test Case Matrix (Onset Derivation):**

| Test ID | Input | Expected onset_delta_days | Notes |
|---------|-------|---------------------------|-------|
| ONSET-001 | First bin has conversions (start=0) | 0 | Immediate conversions |
| ONSET-002 | First conversion at day 3.8 | 3 | floor(3.8) = 3 |
| ONSET-003 | All bins empty except tail (day 7) | 7 | Edge case |
| ONSET-004 | No histogram data | undefined | Graceful handling |
| ONSET-005 | Empty bins array | undefined | Graceful handling |
| ONSET-006 | Only cohort slice (no window) | undefined | cohort excluded |

**J. Test Case Matrix (Onset Aggregation):**

| Test ID | Slices | Expected edge onset | Notes |
|---------|--------|---------------------|-------|
| AGG-001 | window:uncontexted onset=2 | 2 | Single uncontexted |
| AGG-002 | window:ctx:A onset=3, window:ctx:B onset=5 | 3 | min(contexted) |
| AGG-003 | window:uncontexted onset=4, window:ctx:A onset=2 | 4 | uncontexted takes precedence |
| AGG-004 | cohort:date1 onset=1, window:ctx:A onset=5 | 5 | cohort excluded |
| AGG-005 | No window slices | undefined | No onset available |

**K. Test Case Matrix (Shifted Completeness):**

| Test ID | age | onset | μ | σ | Expected completeness | Notes |
|---------|-----|-------|---|---|----------------------|-------|
| COMP-001 | 5 | 0 | 2.0 | 0.5 | LogNormalCDF(5) | No shift |
| COMP-002 | 3 | 5 | 2.0 | 0.5 | 0 | age < onset → dead-time |
| COMP-003 | 5 | 5 | 2.0 | 0.5 | 0 | age = onset → boundary |
| COMP-004 | 7 | 5 | 2.0 | 0.5 | LogNormalCDF(2) | shifted age = 7-5 = 2 |
| COMP-005 | 10 | 3 | 2.0 | 0.5 | LogNormalCDF(7) | shifted age = 10-3 = 7 |

---

#### 0.3.7 Acceptance Criteria

**Pre-requisite:**
- [ ] Feature branch created: `git checkout -b feature/onset-delta-days`

**DAS Extraction:**
- [ ] `lag_histogram` extraction bug fixed (correct indexing into step_bins)
- [ ] `onset_delta_days` JSONata transform added and working (window slices only)
- [ ] Extraction verified against reference Amplitude data

**Type Extensions:**
- [ ] `types/index.ts`: LatencyConfig extended with onset_delta_days + overridden
- [ ] `types/parameterData.ts`: ParameterValue.latency extended
- [ ] `windowAggregationService.ts`: MergeOptions + TimeSeriesPointWithLatency extended
- [ ] `statisticalEnhancementService.ts`: EdgeLAGValues extended with onset_delta_days

**File Storage (per-slice):**
- [ ] Parameter schema extended (`parameter-schema.yaml` - values[].latency only, NOT anchor_latency)
- [ ] `dataOperationsService.ts` extracts and passes onset through to mergeTimeSeriesIntoParameter
- [ ] `windowAggregationService.ts` includes onset in merged values[]

**LAG Topo Pass Aggregation:**
- [ ] `statisticalEnhancementService.ts`: Aggregates onset from window() slices via min()
- [ ] `statisticalEnhancementService.ts`: Precedence rule (uncontexted > min(contexted))
- [ ] `statisticalEnhancementService.ts`: Uses onset in shifted completeness calculation
- [ ] `statisticalEnhancementService.ts`: EdgeLAGValues includes aggregated onset
- [ ] `UpdateManager.ts`: applyBatchLAGValues writes onset to graph (respects override)

**Graph ↔ File Sync (edge-level):**
- [ ] Parameter schema extended (`parameter-schema.yaml` - edge-level latency)
- [ ] UpdateManager: Graph→File mappings for onset_delta_days + _overridden
- [ ] UpdateManager: File→Graph mappings (config section only, NOT values[latest])

**UI Surfacing:**
- [ ] `ParameterSection.tsx`: onset field displays, edits, override checkbox
- [ ] `ConversionEdge.tsx`: onset shown in edge tooltip

**Tests (ALL MUST PASS):**
- [ ] Existing LAG/latency tests still pass (no regressions)
- [ ] DAS extraction tests extended with onset assertion
- [ ] New unit tests for onset derivation (various histogram shapes)
- [ ] LAG topo pass aggregation tests (min, precedence, cohort excluded)
- [ ] Shifted completeness tests (dead-time, boundary, shifted CDF)
- [ ] UpdateManager bidirectional sync tests for onset
- [ ] Override persistence test (user override survives data fetch)
- [ ] Round-trip integration test (Amplitude → DAS → file → LAG → graph → file)
- [ ] E2E test: onset in UI matches file matches graph

---

### 0.4 Phase 0 Completion Checklist

**§0.0 Pre-requisite:**
| Item | Status | Date | Notes |
|------|--------|------|-------|
| Create feature branch: `git checkout -b feature/onset-delta-days` | `[ ]` | | BEFORE any code changes |

**§0.1 Latency Data Preservation:**
| Item | Status | Date | Notes |
|------|--------|------|-------|
| dataOperationsService.ts latency fix | `[ ]` | | |
| compositeQueryExecutor.ts latency fix | `[ ]` | | |
| Existing latency tests pass | `[ ]` | | |
| New dual-query latency test added | `[ ]` | | |

**§0.2 Signature Verification:**
| Item | Status | Date | Notes |
|------|--------|------|-------|
| Signature cohort_mode verified | `[x]` | 1-Feb-26 | Verified in design phase |

**§0.3 onset_delta_days Extraction/Derivation/Storage:**

*Graph Type Changes:*
| Item | Status | Date | Notes |
|------|--------|------|-------|
| types/index.ts: LatencyConfig.onset_delta_days | `[ ]` | | Line ~509 |
| types/index.ts: LatencyConfig.onset_delta_days_overridden | `[ ]` | | Line ~510 |
| statisticalEnhancementService.ts: EdgeLAGValues.latency.onset_delta_days | `[ ]` | | Line ~1625 |

*File Schema Changes:*
| Item | Status | Date | Notes |
|------|--------|------|-------|
| parameter-schema.yaml: onset_delta_days in values[].latency | `[ ]` | | Line ~255 |
| parameter-schema.yaml: onset_delta_days in edge-level latency | `[ ]` | | Line ~95 |
| types/parameterData.ts: ParameterValue.latency extension | `[ ]` | | Line ~46 |
| windowAggregationService.ts: MergeOptions.latencySummary extension | `[ ]` | | Line ~1428 |
| windowAggregationService.ts: TimeSeriesPointWithLatency extension | `[ ]` | | Line ~1410 |

*LAG Topo Pass Aggregation:*
| Item | Status | Date | Notes |
|------|--------|------|-------|
| statisticalEnhancementService.ts: onset aggregation in enhanceGraphLatencies | `[ ]` | | Line ~2020 |
| statisticalEnhancementService.ts: precedence (uncontexted > min contexted) | `[ ]` | | |
| statisticalEnhancementService.ts: shifted completeness calculation | `[ ]` | | |
| statisticalEnhancementService.ts: emit onset in EdgeLAGValues | `[ ]` | | Line ~2395 |
| UpdateManager.ts: applyBatchLAGValues writes onset to graph | `[ ]` | | Line ~3510 |

*UpdateManager Mappings (edge-level):*
| Item | Status | Date | Notes |
|------|--------|------|-------|
| UpdateManager.ts: Graph→File onset_delta_days mapping | `[ ]` | | Line ~1695 |
| UpdateManager.ts: Graph→File onset_delta_days_overridden mapping | `[ ]` | | Line ~1696 |
| UpdateManager.ts: File→Graph onset_delta_days (config only) | `[ ]` | | Line ~2112 |

*Adapter Changes:*
| Item | Status | Date | Notes |
|------|--------|------|-------|
| connections.yaml: FIX lag_histogram indexing bug | `[ ]` | | Line 617-618 |
| connections.yaml: onset_delta_days transform (window slices) | `[ ]` | | After line 618 |

*Service Changes (per-slice storage):*
| Item | Status | Date | Notes |
|------|--------|------|-------|
| dataOperationsService.ts: extract onset from DAS result | `[ ]` | | Line ~6642 |
| dataOperationsService.ts: pass onset to mergeTimeSeriesIntoParameter | `[ ]` | | Line ~7031 |
| windowAggregationService.ts: propagate onset to values[] | `[ ]` | | |

*Tests (DAS Extraction):*
| Item | Status | Date | Notes |
|------|--------|------|-------|
| EXTEND: amplitudeThreeStepFunnel.integration.test.ts | `[ ]` | | Add onset assertions |
| NEW: onset_histogram_extraction.test.ts | `[ ]` | | JSONata unit test |
| NEW: onset_delta_derivation.test.ts | `[ ]` | | Derivation logic |

*Tests (File Storage):*
| Item | Status | Date | Notes |
|------|--------|------|-------|
| EXTEND: abBcSmoothLag.paramPack.amplitude.e2e.test.ts | `[ ]` | | Verify onset in file |
| EXTEND: windowAggregationService.test.ts | `[ ]` | | onset in latencySummary |
| EXTEND: mergeTimeSeriesInvariants.test.ts | `[ ]` | | onset preserved |

*Tests (LAG Topo Pass Aggregation):*
| Item | Status | Date | Notes |
|------|--------|------|-------|
| NEW: onset_aggregation.test.ts | `[ ]` | | min() across window slices |
| NEW: onset_precedence.test.ts | `[ ]` | | uncontexted > min(contexted) |
| EXTEND: statisticalEnhancementService LAG tests | `[ ]` | | EdgeLAGValues includes onset |
| EXTEND: applyBatchLAGValues tests | `[ ]` | | onset written to graph |

*Tests (Graph Sync):*
| Item | Status | Date | Notes |
|------|--------|------|-------|
| EXTEND: persistGraphMasteredLatencyToParameterFiles.test.ts | `[ ]` | | Graph→File onset sync |
| EXTEND: UpdateManager tests | `[ ]` | | Bidirectional mappings |
| NEW: onset_override_flow.test.ts | `[ ]` | | Override survives fetch |

*Tests (Round-trip):*
| Item | Status | Date | Notes |
|------|--------|------|-------|
| NEW: onset_roundtrip.integration.test.ts | `[ ]` | | Amplitude → DAS → file → graph |

*Tests (Shifted Completeness):*
| Item | Status | Date | Notes |
|------|--------|------|-------|
| NEW: onset_shifted_completeness.test.ts | `[ ]` | | Dead-time, boundary, shifted CDF |
| EXTEND: pathT95CompletenessConstraint.test.ts | `[ ]` | | Completeness with onset shift |
| EXTEND: lagStatsFlow.integration.test.ts | `[ ]` | | Onset flows through LAG pass |

*Tests (E2E/Integration):*
| Item | Status | Date | Notes |
|------|--------|------|-------|
| EXTEND: fetchMergeEndToEnd.test.ts | `[ ]` | | Onset flows through full pipeline |
| EXTEND: windowCohortSemantics.paramPack.e2e.test.ts | `[ ]` | | Onset only from window slices |
| NEW: onset_cohort_excluded.test.ts | `[ ]` | | Cohort slices don't contribute onset |

*UI Components:*
| Item | Status | Date | Notes |
|------|--------|------|-------|
| ParameterSection.tsx: onset_delta_days field | `[ ]` | | Display, edit, override checkbox |
| ConversionEdge.tsx: onset in tooltip | `[ ]` | | Add to latency section |
| VERIFY: edgeBeadHelpers.tsx | `[ ]` | | May need onset in bead data |

*UI Tests:*
| Item | Status | Date | Notes |
|------|--------|------|-------|
| NEW: onset_properties_panel.test.tsx | `[ ]` | | Field displays, edits, override |
| NEW: onset_edge_tooltip.test.tsx | `[ ]` | | Onset shown in tooltip |

*Documentation:*
| Item | Status | Date | Notes |
|------|--------|------|-------|
| lag-statistics-reference.md: shifted formula | `[ ]` | | Document completeness with onset |

**Phase 0 Gate:**
| Item | Status | Date | Notes |
|------|--------|------|-------|
| Feature branch created | `[ ]` | | |
| All §0.1 items complete | `[ ]` | | |
| All §0.2 items complete | `[x]` | 1-Feb-26 | |
| All §0.3 schema items complete | `[ ]` | | |
| All §0.3 adapter items complete | `[ ]` | | |
| All §0.3 service items complete | `[ ]` | | |
| All §0.3 LAG topo pass items complete | `[ ]` | | |
| All §0.3 UI items complete | `[ ]` | | |
| All §0.3 test items complete | `[ ]` | | |
| Existing LAG/latency tests still pass | `[ ]` | | No regressions |
| **PHASE 0 COMPLETE** | `[ ]` | | |

---

## Phase 1: Foundation — Write Path (3-4 days)

### 1.1 Database Setup

**Provider:** Neon (Postgres)

**Tasks:**
1. Create production database via Neon console
2. Create `snapshots` table:

```sql
CREATE TABLE snapshots (
    -- Identity (4 columns)
    param_id            TEXT NOT NULL,      -- Workspace-prefixed: 'repo-branch-param-id'
    core_hash           TEXT NOT NULL,      -- Semantic identity (includes cohort/window mode)
    context_def_hashes  TEXT,               -- JSON: {"channel":"hash",...}; for future strict matching
    slice_key           TEXT NOT NULL,      -- Context slice or '' for uncontexted
    
    -- Time dimensions (2 columns)
    anchor_day          DATE NOT NULL,      -- A-entry (cohort) or X-entry (window)
    retrieved_at        TIMESTAMPTZ NOT NULL, -- UTC; see design doc §3.2.1
    
    -- Counts (3 columns)
    A                   INTEGER,            -- Anchor entrants (null for window mode)
    X                   INTEGER,            -- From-step count
    Y                   INTEGER,            -- To-step count (conversions)
    
    -- Latency (5 columns)
    median_lag_days         REAL,
    mean_lag_days           REAL,
    anchor_median_lag_days  REAL,
    anchor_mean_lag_days    REAL,
    onset_delta_days        REAL,           -- Onset delay before conversions begin (derived from histogram)
    
    PRIMARY KEY (param_id, core_hash, slice_key, anchor_day, retrieved_at)
);

CREATE INDEX idx_snapshots_lookup 
    ON snapshots (param_id, core_hash, slice_key, anchor_day);
```

**Note:** `context_def_hashes` stores the context definition portion of the signature for future strict matching and audit purposes. V1 queries use `core_hash` only. See `snapshot-db-design.md` §3.8.6 for decision rationale.

3. Create Neon test branch for testing
4. Verify connection from local Python server
5. Verify connection from Vercel production
6. Implement snapshot handlers (see design doc §12.7):

```python
# lib/snapshot_handlers.py (NEW FILE)

def handle_snapshots_health(data: dict) -> dict:
    """
    Health check for snapshot DB features.
    Frontend uses this to enable/disable DB-dependent UI.
    """
    try:
        conn = get_db_connection()
        cur = conn.cursor()
        cur.execute("SELECT 1")
        conn.close()
        return {"status": "ok", "db": "connected"}
    except Exception as e:
        return {"status": "degraded", "db": "unavailable", "error": str(e)}
```

**Deliverable:** Working database with schema, health endpoint, accessible from both environments.

---

### 1.2 Python Snapshot Write Service

**File:** `graph-editor/lib/snapshot_service.py` (new)

```python
"""
Snapshot DB Service

Handles all database operations for the snapshot feature.
"""

import os
import psycopg2
from psycopg2.extras import execute_values
from typing import List, Dict, Any, Optional
from datetime import date, datetime

def get_db_connection():
    """Get database connection from environment."""
    conn_string = os.environ.get('DB_CONNECTION')
    if not conn_string:
        raise ValueError("DB_CONNECTION environment variable not set")
    return psycopg2.connect(conn_string)


def append_snapshots(
    param_id: str,
    core_hash: str,
    context_def_hashes: Optional[str],  # JSON string or None
    slice_key: str,
    retrieved_at: datetime,
    rows: List[Dict[str, Any]]
) -> int:
    """
    Append snapshot rows to the database.
    
    Args:
        param_id: Workspace-prefixed parameter ID
        core_hash: Query signature hash (for matching)
        context_def_hashes: JSON string of context def hashes (for audit/future strict matching)
        slice_key: Context slice DSL or '' for uncontexted
        retrieved_at: Timestamp of data retrieval
        rows: List of {anchor_day, A, X, Y, median_lag_days, ...}
    
    Returns:
        Number of rows inserted
    """
    if not rows:
        return 0
    
    conn = get_db_connection()
    try:
        cur = conn.cursor()
        
        values = [
            (
                param_id,
                core_hash,
                context_def_hashes,
                slice_key,
                row['anchor_day'],
                retrieved_at,
                row.get('A'),
                row.get('X'),
                row.get('Y'),
                row.get('median_lag_days'),
                row.get('mean_lag_days'),
                row.get('anchor_median_lag_days'),
                row.get('anchor_mean_lag_days'),
            )
            for row in rows
        ]
        
        execute_values(
            cur,
            """
            INSERT INTO snapshots (
                param_id, core_hash, context_def_hashes, slice_key, anchor_day, retrieved_at,
                A, X, Y,
                median_lag_days, mean_lag_days,
                anchor_median_lag_days, anchor_mean_lag_days
            ) VALUES %s
            ON CONFLICT (param_id, core_hash, slice_key, anchor_day, retrieved_at)
            DO NOTHING
            """,
            values
        )
        
        inserted = cur.rowcount
        conn.commit()
        return inserted
        
    finally:
        conn.close()
```

**Deliverable:** Python service with `append_snapshots()` function.

---

### 1.3 Python API Endpoint: Append

**File:** `graph-editor/lib/api_handlers.py`

**Add endpoint:**

```python
from pydantic import BaseModel
from typing import List, Optional
from datetime import datetime

class SnapshotRow(BaseModel):
    anchor_day: str  # ISO date
    A: Optional[int] = None
    X: Optional[int] = None
    Y: Optional[int] = None
    median_lag_days: Optional[float] = None
    mean_lag_days: Optional[float] = None
    anchor_median_lag_days: Optional[float] = None
    anchor_mean_lag_days: Optional[float] = None

class AppendSnapshotsRequest(BaseModel):
    param_id: str
    core_hash: str
    context_def_hashes: Optional[dict] = None  # For future strict matching
    slice_key: str
    retrieved_at: str  # ISO timestamp
    rows: List[SnapshotRow]

@app.post("/api/snapshots/append")
async def append_snapshots(request: AppendSnapshotsRequest):
    """Append snapshot rows to the database."""
    from lib.snapshot_service import append_snapshots as do_append
    import json
    
    rows = [row.dict() for row in request.rows]
    inserted = do_append(
        param_id=request.param_id,
        core_hash=request.core_hash,
        context_def_hashes=json.dumps(request.context_def_hashes) if request.context_def_hashes else None,
        slice_key=request.slice_key,
        retrieved_at=datetime.fromisoformat(request.retrieved_at.replace('Z', '+00:00')),
        rows=rows
    )
    
    return {"success": True, "inserted": inserted}
```

**Deliverable:** Working `/api/snapshots/append` endpoint.

---

### 1.4 Frontend Snapshot Write Service

**File:** `graph-editor/src/services/snapshotWriteService.ts` (new)

```typescript
/**
 * Snapshot Write Service
 * 
 * Handles shadow-writing snapshot data to the database after successful fetches.
 */

interface SnapshotRow {
  anchor_day: string;  // ISO date
  A?: number;
  X?: number;
  Y?: number;
  median_lag_days?: number;
  mean_lag_days?: number;
  anchor_median_lag_days?: number;
  anchor_mean_lag_days?: number;
}

interface AppendSnapshotsParams {
  param_id: string;
  core_hash: string;
  context_def_hashes?: Record<string, string>;  // For future strict matching
  slice_key: string;
  retrieved_at: Date;
  rows: SnapshotRow[];
}

const PYTHON_API_BASE = import.meta.env.VITE_PYTHON_API_URL || 'http://localhost:8000';

export async function appendSnapshots(params: AppendSnapshotsParams): Promise<{ success: boolean; inserted: number }> {
  const response = await fetch(`${PYTHON_API_BASE}/api/snapshots/append`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      param_id: params.param_id,
      core_hash: params.core_hash,
      context_def_hashes: params.context_def_hashes || null,  // Stored for future strict matching
      slice_key: params.slice_key,
      retrieved_at: params.retrieved_at.toISOString(),
      rows: params.rows,
    }),
  });
  
  if (!response.ok) {
    console.error('[SnapshotWrite] Failed to append snapshots:', response.status);
    return { success: false, inserted: 0 };
  }
  
  return response.json();
}
```

**Deliverable:** Frontend service to call append endpoint.

---

### 1.5 Integrate Shadow-Write into Data Operations

**File:** `graph-editor/src/services/dataOperationsService.ts`

**Location:** After `mergeTimeSeriesIntoParameter()` call (~line 7060)

**Changes:**

```typescript
// After successful merge, shadow-write to snapshot DB
// CRITICAL: Only write if we have actual fetched data (not cache hit)
if (allTimeSeriesData.length > 0 && querySignature && !dontExecuteHttp) {
  try {
    const workspace = (() => {
      const pf = fileRegistry.getFile(`parameter-${objectId}`);
      return {
        repository: pf?.source?.repository || 'unknown',
        branch: pf?.source?.branch || 'unknown',
      };
    })();
    
    const dbParamId = `${workspace.repository}-${workspace.branch}-${objectId}`;
    
    const snapshotRows = allTimeSeriesData.map(day => ({
      anchor_day: normalizeDate(day.date),
      A: day.anchor_n,
      X: day.n,
      Y: day.k,
      median_lag_days: day.median_lag_days,
      mean_lag_days: day.mean_lag_days,
      anchor_median_lag_days: day.anchor_median_lag_days,
      anchor_mean_lag_days: day.anchor_mean_lag_days,
    }));
    
    const { appendSnapshots } = await import('./snapshotWriteService');
    
    // Per §3.8.6: Store both coreHash and contextDefHashes
    // querySignature is a StructuredSignature: { coreHash, contextDefHashes }
    const result = await appendSnapshots({
      param_id: dbParamId,
      core_hash: querySignature.coreHash,          // For matching (V1)
      context_def_hashes: querySignature.contextDefHashes,  // For audit/future strict matching
      slice_key: sliceDSL || '',
      retrieved_at: new Date(),
      rows: snapshotRows,
    });
    
    if (result.success) {
      sessionLogService.addChild(logOpId, 'info', 'SNAPSHOT_WRITE',
        `Wrote ${result.inserted} snapshot rows to DB`
      );
    }
  } catch (error) {
    // Non-fatal: log but don't fail the fetch
    console.error('[DataOps] Snapshot write failed:', error);
    sessionLogService.addChild(logOpId, 'warning', 'SNAPSHOT_WRITE_FAILED',
      `Failed to write snapshots: ${error}`
    );
  }
}
```

**Graceful degradation pattern:**

```typescript
// Shadow-write MUST be non-fatal
try {
  const result = await appendSnapshots({ ... });
  if (result.success) {
    sessionLogService.addChild(logOpId, 'info', 'SNAPSHOT_WRITE', ...);
  } else {
    // DB error — log but don't fail
    sessionLogService.addChild(logOpId, 'warning', 'SNAPSHOT_WRITE_SKIPPED',
      `Snapshot write skipped: ${result.error}`
    );
  }
} catch (error) {
  // Network/server error — log but don't fail
  console.warn('[DataOps] Snapshot write unavailable:', error);
  sessionLogService.addChild(logOpId, 'warning', 'SNAPSHOT_WRITE_UNAVAILABLE',
    'Snapshot DB unavailable — data saved to file only'
  );
}
// CRITICAL: Fetch continues regardless of snapshot write outcome
```

**Deliverable:** Shadow-write integrated into fetch flow with graceful degradation.

---

### 1.6 Phase 1 Testing & Completion

**Required Tests (from §DI):**
- [ ] WI-001 through WI-008 (Write Integrity)
- [ ] SI-001 through SI-005 (Signature Integrity)
- [ ] CD-001 through CD-005 (Composite/Dual-Query)
- [ ] MS-001 through MS-003 (Multi-Slice)
- [ ] GD-001, GD-002 (Graceful Degradation — write path)

**Manual Verification:**
- [ ] Fetch data → verify rows appear in Neon console
- [ ] Fetch with context slice → verify slice_key populated
- [ ] Fetch cohort mode → verify A column populated
- [ ] Trigger DB error → verify fetch still succeeds

**Phase 1 Completion Checklist:**

| Item | Status | Date | Notes |
|------|--------|------|-------|
| Database created and accessible | `[ ]` | | |
| Schema deployed | `[ ]` | | |
| Python snapshot_service.py complete | `[ ]` | | |
| /api/snapshots/append endpoint working | `[ ]` | | |
| /api/snapshots/health endpoint working | `[ ]` | | |
| Frontend snapshotWriteService.ts complete | `[ ]` | | |
| Shadow-write integrated into dataOperationsService | `[ ]` | | |
| WI-* tests passing (8/8) | `[ ]` | | |
| SI-* tests passing (5/5) | `[ ]` | | |
| CD-* tests passing (5/5) | `[ ]` | | |
| MS-* tests passing (3/3) | `[ ]` | | |
| GD-001, GD-002 passing (2/2) | `[ ]` | | |
| User documentation updated | `[ ]` | | |
| **PHASE 1 COMPLETE** | `[ ]` | | |

---

## Phase 2: Read Path — Analytics (2-3 days)

### 2.1 Python Snapshot Query Service

**File:** `graph-editor/lib/snapshot_service.py`

**Add functions:**

```python
def query_snapshots(
    param_id: str,
    core_hash: str,
    slice_keys: List[str],
    anchor_from: date,
    anchor_to: date,
    as_at: Optional[datetime] = None
) -> List[Dict[str, Any]]:
    """
    Query snapshot rows from the database.
    
    Args:
        param_id: Workspace-prefixed parameter ID
        core_hash: Query signature hash
        slice_keys: List of slice keys to include
        anchor_from: Start of anchor date range
        anchor_to: End of anchor date range
        as_at: If provided, only return snapshots taken before this timestamp
    
    Returns:
        List of snapshot rows
    """
    conn = get_db_connection()
    try:
        cur = conn.cursor()
        
        query = """
            SELECT 
                slice_key, anchor_day, retrieved_at,
                A, X, Y,
                median_lag_days, mean_lag_days,
                anchor_median_lag_days, anchor_mean_lag_days
            FROM snapshots
            WHERE param_id = %s
              AND core_hash = %s
              AND slice_key = ANY(%s)
              AND anchor_day BETWEEN %s AND %s
        """
        params = [param_id, core_hash, slice_keys, anchor_from, anchor_to]
        
        if as_at:
            query += " AND retrieved_at <= %s"
            params.append(as_at)
        
        query += " ORDER BY anchor_day, retrieved_at"
        
        cur.execute(query, params)
        
        columns = [desc[0] for desc in cur.description]
        return [dict(zip(columns, row)) for row in cur.fetchall()]
        
    finally:
        conn.close()


def get_snapshot_inventory(
    param_id: str,
    core_hash: Optional[str] = None
) -> Dict[str, Any]:
    """
    Get inventory of available snapshots for a parameter.
    
    Returns earliest/latest dates, row counts, etc.
    """
    conn = get_db_connection()
    try:
        cur = conn.cursor()
        
        query = """
            SELECT 
                MIN(anchor_day) as earliest,
                MAX(anchor_day) as latest,
                COUNT(*) as row_count,
                COUNT(DISTINCT anchor_day) as unique_days,
                COUNT(DISTINCT slice_key) as unique_slices
            FROM snapshots
            WHERE param_id = %s
        """
        params = [param_id]
        
        if core_hash:
            query += " AND core_hash = %s"
            params.append(core_hash)
        
        cur.execute(query, params)
        row = cur.fetchone()
        
        if not row or row[0] is None:
            return {
                'has_data': False,
                'earliest': None,
                'latest': None,
                'row_count': 0,
                'unique_days': 0,
                'unique_slices': 0,
            }
        
        return {
            'has_data': True,
            'earliest': row[0].isoformat(),
            'latest': row[1].isoformat(),
            'row_count': row[2],
            'unique_days': row[3],
            'unique_slices': row[4],
        }
        
    finally:
        conn.close()
```

**Deliverable:** Query and inventory functions.

---

### 2.2 Histogram Derivation

**File:** `graph-editor/lib/runner/histogram_derivation.py` (new)

```python
"""
Histogram Derivation from Snapshot Data

Computes conversion lag distribution from daily snapshot deltas.
"""

from collections import defaultdict
from typing import List, Dict, Any
from datetime import date

def derive_lag_histogram(rows: List[Dict[str, Any]]) -> Dict[str, Any]:
    """
    Derive lag histogram from snapshot rows.
    
    For each anchor_day, successive snapshots show Y accumulating.
    ΔY between snapshots = conversions at that lag.
    
    Returns:
        {
            'analysis_type': 'lag_histogram',
            'data': [{'lag_days': int, 'conversions': int, 'pct': float}, ...],
            'total_conversions': int
        }
    """
    # Group by anchor_day
    by_anchor: Dict[date, List[Dict]] = defaultdict(list)
    for row in rows:
        anchor = row['anchor_day']
        if isinstance(anchor, str):
            anchor = date.fromisoformat(anchor)
        by_anchor[anchor].append(row)
    
    lag_bins: Dict[int, int] = defaultdict(int)
    
    for anchor_day, snapshots in by_anchor.items():
        # Sort by retrieved_at
        snapshots_sorted = sorted(snapshots, key=lambda r: r['retrieved_at'])
        prev_Y = 0
        
        for snap in snapshots_sorted:
            retrieved = snap['retrieved_at']
            if isinstance(retrieved, str):
                from datetime import datetime
                retrieved = datetime.fromisoformat(retrieved.replace('Z', '+00:00'))
            
            lag = (retrieved.date() - anchor_day).days
            current_Y = snap.get('Y') or 0
            delta_Y = current_Y - prev_Y
            
            if delta_Y > 0:
                lag_bins[lag] += delta_Y
            
            prev_Y = current_Y
    
    total = sum(lag_bins.values())
    data = [
        {
            'lag_days': lag,
            'conversions': count,
            'pct': count / total if total > 0 else 0,
        }
        for lag, count in sorted(lag_bins.items())
    ]
    
    return {
        'analysis_type': 'lag_histogram',
        'data': data,
        'total_conversions': total,
    }
```

**Deliverable:** Working histogram derivation.

---

### 2.3 Daily Conversions Derivation

**File:** `graph-editor/lib/runner/daily_conversions_derivation.py` (new)

```python
"""
Daily Conversions Derivation from Snapshot Data

Computes conversions attributed to each calendar date.
"""

from collections import defaultdict
from typing import List, Dict, Any
from datetime import date, datetime

def derive_daily_conversions(rows: List[Dict[str, Any]]) -> Dict[str, Any]:
    """
    Derive daily conversion counts from snapshot rows.
    
    For each cohort, ΔY between snapshots = conversions attributed to that snapshot date.
    
    Returns:
        {
            'analysis_type': 'daily_conversions',
            'data': [{'date': str, 'conversions': int}, ...],
            'total_conversions': int
        }
    """
    daily_totals: Dict[date, int] = defaultdict(int)
    
    # Group by anchor_day
    by_anchor: Dict[date, List[Dict]] = defaultdict(list)
    for row in rows:
        anchor = row['anchor_day']
        if isinstance(anchor, str):
            anchor = date.fromisoformat(anchor)
        by_anchor[anchor].append(row)
    
    for anchor_day, snapshots in by_anchor.items():
        snapshots_sorted = sorted(snapshots, key=lambda r: r['retrieved_at'])
        prev_Y = 0
        
        for snap in snapshots_sorted:
            retrieved = snap['retrieved_at']
            if isinstance(retrieved, str):
                retrieved = datetime.fromisoformat(retrieved.replace('Z', '+00:00'))
            
            current_Y = snap.get('Y') or 0
            delta_Y = current_Y - prev_Y
            
            if delta_Y > 0:
                daily_totals[retrieved.date()] += delta_Y
            
            prev_Y = current_Y
    
    total = sum(daily_totals.values())
    data = [
        {'date': d.isoformat(), 'conversions': count}
        for d, count in sorted(daily_totals.items())
    ]
    
    return {
        'analysis_type': 'daily_conversions',
        'data': data,
        'total_conversions': total,
    }
```

**Deliverable:** Working daily conversions derivation.

---

### 2.4 API Endpoints for Analytics

**Per Blocker A resolution:** Extend existing `/api/runner/analyze`, do NOT create new `/api/snapshots/analyze`.

**File:** `graph-editor/lib/api_handlers.py`

**Extend `handle_runner_analyze()`:**

```python
# In handle_runner_analyze() - add snapshot_query handling

def handle_runner_analyze(data: Dict[str, Any]) -> Dict[str, Any]:
    """Handle runner/analyze endpoint - extended for snapshot queries."""
    
    # NEW: Check for snapshot_query
    snapshot_query = data.get('snapshot_query')
    
    if snapshot_query:
        # Route to snapshot-based analysis
        from lib.snapshot_service import query_snapshots
        from lib.runner.histogram_derivation import derive_lag_histogram
        from lib.runner.daily_conversions_derivation import derive_daily_conversions
        from datetime import date
        
        analysis_type = data.get('analysis_type', 'lag_histogram')
        
        rows = query_snapshots(
            param_id=snapshot_query['param_id'],
            core_hash=snapshot_query['core_hash'],
            slice_keys=snapshot_query.get('slice_keys', ['']),
            anchor_from=date.fromisoformat(snapshot_query['anchor_from']),
            anchor_to=date.fromisoformat(snapshot_query['anchor_to']),
        )
        
        if not rows:
            return {"success": False, "error": "No snapshot data found"}
        
        if analysis_type == 'lag_histogram':
            result = derive_lag_histogram(rows)
        elif analysis_type == 'daily_conversions':
            result = derive_daily_conversions(rows)
        else:
            return {"success": False, "error": f"Unknown analysis type: {analysis_type}"}
        
        return {"success": True, **result}
    
    # ... existing non-snapshot analysis code ...
```

**File:** `graph-editor/lib/snapshot_handlers.py`

**Add batch inventory handler (per Blocker B):**

```python
def handle_snapshots_inventory(data: Dict[str, Any]) -> Dict[str, Any]:
    """
    Get snapshot inventory for batch of param_ids.
    
    Input: {"param_ids": ["repo-branch-param-a", "repo-branch-param-b"]}
    """
    from lib.snapshot_service import get_batch_inventory
    
    param_ids = data.get('param_ids', [])
    if not param_ids:
        return {"success": False, "error": "param_ids required"}
    
    inventory = get_batch_inventory(param_ids)
    return {"success": True, "inventory": inventory}
```

**Deliverable:** Snapshot analysis via extended `/api/runner/analyze`; batch inventory via `POST /api/snapshots/inventory`.

---

### 2.5 Phase 2 Testing & Completion

**Required Tests (from §DI):**
- [ ] RI-001 through RI-004 (Read Integrity)
- [ ] DR-001 through DR-006 (Derivation)
- [ ] RT-001 through RT-005 (Round-Trip)
- [ ] GD-003 (Analytics graceful degradation)

**Manual Verification:**
- [ ] Query snapshots with date range → verify correct rows returned
- [ ] Histogram derivation → verify lag bins calculated correctly
- [ ] Daily conversions → verify date attribution correct
- [ ] Inventory endpoint → verify correct counts

**Phase 2 Completion Checklist:**

| Item | Status | Date | Notes |
|------|--------|------|-------|
| Python query_snapshots() working | `[ ]` | | |
| histogram_derivation.py complete | `[ ]` | | |
| daily_conversions_derivation.py complete | `[ ]` | | |
| /api/runner/analyze handles snapshot_query | `[ ]` | | |
| /api/snapshots/inventory endpoint working | `[ ]` | | |
| RI-* tests passing (4/4) | `[ ]` | | |
| DR-* tests passing (6/6) | `[ ]` | | |
| RT-* tests passing (5/5) | `[ ]` | | |
| GD-003 passing (1/1) | `[ ]` | | |
| Performance test: 1000+ rows <500ms | `[ ]` | | |
| User documentation updated | `[ ]` | | |
| **PHASE 2 COMPLETE** | `[ ]` | | |

---

## Phase 3: UI Integration (2-3 days)

### 3.1 Analysis Type in AnalyticsPanel

**File:** `graph-editor/src/components/panels/AnalyticsPanel.tsx`

**Changes:**
1. Add dropdown for analysis type: "Standard" | "Lag Histogram" | "Daily Conversions"
2. When snapshot analysis selected, call new endpoint
3. Render results using existing chart infrastructure

### 3.2 Snapshot Availability in Edge Tooltips

**File:** `graph-editor/src/components/edges/ConversionEdge.tsx`

**Changes:**
1. Query inventory on hover (with debounce/cache)
2. Display "Snapshots: {earliest} - {latest}" in tooltip
3. Handle missing/partial data gracefully

### 3.3 Frontend Inventory Cache

**File:** `graph-editor/src/services/snapshotInventoryCache.ts` (new)

**Note:** Uses batch POST per Blocker B resolution. Single-param lookup is a batch of one.

```typescript
/**
 * Snapshot Inventory Cache
 * 
 * Caches snapshot availability information to avoid repeated API calls.
 * Uses batch API to minimise requests when loading graphs with many edges.
 */

interface InventoryEntry {
  paramId: string;
  hasData: boolean;
  earliest: string | null;
  latest: string | null;
  totalDays: number;
  expectedDays: number;
  rowCount: number;
  fetchedAt: number;
}

const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const cache = new Map<string, InventoryEntry>();

/**
 * Get inventory for multiple param IDs (batch).
 * Checks cache first, fetches missing entries in single batch request.
 */
export async function getBatchInventory(paramIds: string[]): Promise<Map<string, InventoryEntry>> {
  const results = new Map<string, InventoryEntry>();
  const missing: string[] = [];
  
  // Check cache
  for (const id of paramIds) {
    const cached = cache.get(id);
    if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
      results.set(id, cached);
    } else {
      missing.push(id);
    }
  }
  
  // Batch fetch missing
  if (missing.length > 0) {
    const response = await fetch('/api/snapshots/inventory', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ param_ids: missing }),
    });
    const data = await response.json();
    
    for (const item of data.inventory) {
      const entry: InventoryEntry = {
        paramId: item.param_id,
        hasData: item.row_count > 0,
        earliest: item.earliest_anchor,
        latest: item.latest_anchor,
        totalDays: item.total_days,
        expectedDays: item.expected_days,
        rowCount: item.row_count,
        fetchedAt: Date.now(),
      };
      cache.set(item.param_id, entry);
      results.set(item.param_id, entry);
    }
  }
  
  return results;
}

/**
 * Get inventory for single param ID.
 * Convenience wrapper around batch API.
 */
export async function getSnapshotInventory(paramId: string): Promise<InventoryEntry | null> {
  const results = await getBatchInventory([paramId]);
  return results.get(paramId) || null;
}
```

### 3.4 Phase 3 Testing & Completion

**UI Tests:**
- [ ] Analysis type dropdown works
- [ ] Histogram chart renders correctly
- [ ] Daily conversions chart renders correctly
- [ ] Tooltip shows snapshot availability
- [ ] Cache prevents excessive API calls
- [ ] Gap warning displays for sparse data

**Phase 3 Completion Checklist:**

| Item | Status | Date | Notes |
|------|--------|------|-------|
| AnalyticsPanel analysis type selector | `[ ]` | | |
| Histogram chart rendering | `[ ]` | | |
| Daily conversions chart rendering | `[ ]` | | |
| Edge tooltip snapshot availability | `[ ]` | | |
| Inventory cache working | `[ ]` | | |
| Gap handling in UI | `[ ]` | | |
| User documentation updated | `[ ]` | | |
| **PHASE 3 COMPLETE** | `[ ]` | | |

---

## Phase 4: Historical Queries — asAt (2-3 days)

**Detailed design and implementation:** [`docs/current/project-db/asat.md`](./asat.md)

Phase 4 implements the `asAt()` DSL extension, enabling historical queries that retrieve data "as it was known at a specific date" from the snapshot DB.

### 4.1 DSL Parsing Extension

**Files:**
- `graph-editor/src/lib/queryDSL.ts` — TypeScript parsing
- `graph-editor/lib/query_dsl.py` — Python parsing

**Summary:** Add `asAt` to QUERY_FUNCTIONS, ParsedConstraints, parse logic, and DSL reconstruction.

See: [asat.md §8.1-8.2](./asat.md#81-dsl-parsing--typescript)

### 4.2 Data Operations Fork

**File:** `graph-editor/src/services/dataOperationsService.ts`

**Summary:** In `getFromSourceDirect()`, detect `asAt` in DSL and fork to DB query instead of Amplitude.

See: [asat.md §8.6](./asat.md#86-data-operations-service--fork-point)

### 4.3 WindowSelector asAt Mode

**File:** `graph-editor/src/components/WindowSelector.tsx`

**Summary:** Add asAt checkbox, date picker, and visual indicator.

See: [asat.md §8.4](./asat.md#84-windowselector-ui)

### 4.4 Scenario Integration

**Files:**
- `graph-editor/src/services/scenarioRegenerationService.ts` — Composition
- `graph-editor/src/components/panels/ScenariosPanel.tsx` — UI

**Summary:** Handle asAt in FetchParts; show badge; disable regeneration for asAt scenarios.

See: [asat.md §8.3, §8.5](./asat.md#83-scenario-composition)

### 4.5 Graceful Degradation for asAt

**asAt queries REQUIRE DB access** — they cannot fall back to Amplitude.

```typescript
// In getFromSourceDirect(), asAt path:
if (asAtDate) {
  try {
    const snapshotResult = await graphComputeClient.querySnapshots({ ... });
    
    if (!snapshotResult.success) {
      // DB returned error (signature mismatch, no data, etc.)
      throw new Error(snapshotResult.errorMessage);
    }
    
    // Success — use DB data
    allTimeSeriesData.push(...snapshotResult.timeSeries);
    
  } catch (error) {
    // Network/server unavailable — clear message to user
    if (error.message.includes('fetch') || error.message.includes('network')) {
      throw new Error('Historical data requires database connection. Please check your network.');
    }
    throw error;  // Propagate other errors (signature mismatch, no data)
  }
}
```

**UI handling:**
- Toast error: "Historical data unavailable — database connection required"
- Scenario panel: asAt scenarios show "⚠️ DB unavailable" badge
- WindowSelector: asAt mode disabled if Python health check fails

### 4.6 Phase 4 Testing & Completion

**Required Tests (see `asat.md` §13 for full list):**
- [ ] DSL parsing with asAt (TypeScript and Python)
- [ ] asAt excluded from signature computation
- [ ] Data fork to DB query
- [ ] Signature validation and mismatch handling
- [ ] Scenario composition with asAt
- [ ] GD-004: Graceful degradation when DB unavailable

**Phase 4 Completion Checklist:**

| Item | Status | Date | Notes |
|------|--------|------|-------|
| queryDSL.ts: asAt parsing | `[ ]` | | |
| query_dsl.py: asAt parsing | `[ ]` | | |
| graphComputeClient: querySnapshots() | `[ ]` | | |
| /api/snapshots/query endpoint | `[ ]` | | |
| dataOperationsService: asAt fork | `[ ]` | | |
| WindowSelector: asAt mode UI | `[ ]` | | |
| ScenariosPanel: asAt badge | `[ ]` | | |
| scenarioRegenerationService: asAt composition | `[ ]` | | |
| DSL parsing tests passing | `[ ]` | | |
| Signature exclusion test passing | `[ ]` | | |
| Round-trip asAt test passing | `[ ]` | | |
| GD-004 passing | `[ ]` | | |
| User documentation updated | `[ ]` | | |
| Query expressions docs updated | `[ ]` | | |
| **PHASE 4 COMPLETE** | `[ ]` | | |

---

## Documentation Updates (All Phases)

**Documentation is a deliverable in EVERY phase, not an afterthought.**

### D.1 User Documentation

**File:** `graph-editor/public/docs/user-guide.md`

| Phase | Updates |
|-------|---------|
| **Phase 1** | New section: "Snapshot Data Storage" — explain what data is persisted and why |
| **Phase 2** | New section: "Lag Histogram Analysis" and "Daily Conversions Analysis" |
| **Phase 3** | Update edge tooltip documentation; add snapshot availability explanation |
| **Phase 4** | New section: "Viewing Historical Data (`asAt`)" with examples |

### D.2 Query Reference

**File:** `graph-editor/public/docs/query-expressions.md`

| Phase | Updates |
|-------|---------|
| **Phase 4** | Add `asAt(date)` function documentation with syntax and examples |
| **Phase 4** | Add "Historical Queries" section explaining signature validation |

### D.3 API Reference

**File:** `graph-editor/public/docs/api-reference.md`

| Phase | Updates |
|-------|---------|
| **Phase 1** | Add `/api/snapshots/append` endpoint documentation |
| **Phase 2** | Add `/api/snapshots/inventory` endpoint documentation |
| **Phase 4** | Add `/api/snapshots/query` endpoint documentation |

### D.4 CHANGELOG

**File:** `graph-editor/public/docs/CHANGELOG.md`

Each phase completion adds an entry:
- Phase 1: "Added: Snapshot database storage for conversion data"
- Phase 2: "Added: Lag histogram and daily conversions analysis"
- Phase 3: "Added: Snapshot availability indicators in edge tooltips"
- Phase 4: "Added: Historical queries via `asAt()` DSL function"

### D.5 Technical Documentation

**Files:** `docs/current/project-db/*.md`

| Phase | Updates |
|-------|---------|
| **All** | Keep `snapshot-db-design.md` updated with any design changes |
| **Phase 4** | `asat.md` becomes the authoritative implementation reference |
| **Phase 5** | `time-series-charting.md` updated as charting is implemented |

### D.6 README

**File:** `README.md` (root)

| Phase | Updates |
|-------|---------|
| **Phase 1** | Add "Environment Variables" section with `DB_CONNECTION` |
| **Phase 1** | Update "Local Development" with DB setup instructions |

---

## Data Integrity Testing Requirements

> **Critical:** The snapshot DB stores time-series data that feeds into business-critical analytics. Testing must be **ROBUST, BROAD, COMPLETE, and SOPHISTICATED** to ensure data integrity.

### DI.1 Write Path Integrity Tests

**All tests MUST pass before Phase 1 is marked complete.**

| Test ID | Test Name | Description | Assertions |
|---------|-----------|-------------|------------|
| `WI-001` | `write_simple_uncontexted` | Single edge, uncontexted, 10 days | 10 rows; all A/X/Y populated; slice_key = '' |
| `WI-002` | `write_with_all_latency` | All 4 latency columns present | All latency columns non-null |
| `WI-003` | `write_contexted_slice` | `context(channel:google)` | `slice_key = 'context(channel:google)'` |
| `WI-004` | `write_cohort_mode` | Cohort query | A column populated; anchor_day = cohort entry |
| `WI-005` | `write_window_mode` | Window query | A column NULL; anchor_day = X entry |
| `WI-006` | `write_idempotent` | Same data written twice | No duplicates (ON CONFLICT DO NOTHING) |
| `WI-007` | `write_workspace_prefix` | Different workspaces | param_id correctly prefixed per workspace |
| `WI-008` | `write_preserves_nulls` | Missing latency data | NULL columns preserved, not 0 |

**Signature Integrity Tests:**

| Test ID | Test Name | Description | Assertions |
|---------|-----------|-------------|------------|
| `SI-001` | `signature_matches_file` | Write → verify core_hash matches file signature | **TBD** — depends on context hash decision |
| `SI-002` | `signature_cohort_vs_window` | Same edge, cohort vs window | Different core_hash values |
| `SI-003` | `signature_stable_across_writes` | Multiple fetches same query | Same core_hash each time |
| `SI-004` | `signature_includes_event_defs` | Different event definitions | Different core_hash values |
| `SI-005` | `signature_context_behaviour` | Same edge, different context definitions | **TBD** — depends on context hash decision |

**Composite/Dual-Query Tests:**

| Test ID | Test Name | Description | Assertions |
|---------|-----------|-------------|------------|
| `CD-001` | `dual_query_latency_preserved` | n_query + k_query | Latency from k_query in DB |
| `CD-002` | `dual_query_x_from_n` | n_query provides X | X column from n_query result |
| `CD-003` | `composite_minus_query` | `from().to().minus()` | Synthesised Y written correctly |
| `CD-004` | `composite_plus_query` | `from().to().plus()` | Combined Y written correctly |
| `CD-005` | `composite_latency_source` | Composite with latency | Latency from base query preserved |

**Multi-Slice Tests:**

| Test ID | Test Name | Description | Assertions |
|---------|-----------|-------------|------------|
| `MS-001` | `write_multiple_slices` | 3 context slices | 3 × N rows (one set per slice) |
| `MS-002` | `mece_slices_complete` | MECE partition | All slices present, sum = uncontexted |
| `MS-003` | `slice_key_encoding` | Complex slice DSL | slice_key exactly matches DSL |

### DI.2 Read Path Integrity Tests

**All tests MUST pass before Phase 2 is marked complete.**

| Test ID | Test Name | Description | Assertions |
|---------|-----------|-------------|------------|
| `RI-001` | `read_single_param` | Query by param_id + core_hash | Returns expected rows |
| `RI-002` | `read_date_range_filter` | Filter by anchor_day range | Only dates in range returned |
| `RI-003` | `read_empty_graceful` | Non-existent param | Empty array, no error |
| `RI-004` | `read_slice_filter` | Multiple slices in DB, query one | Only requested slice returned |

**Derivation Integrity Tests:**

| Test ID | Test Name | Description | Assertions |
|---------|-----------|-------------|------------|
| `DR-001` | `histogram_simple` | 5 snapshots, increasing Y | Lag bins sum to total ΔY |
| `DR-002` | `histogram_negative_delta` | Y decreases between snapshots | Clamped to 0, warning logged |
| `DR-003` | `daily_conversions_simple` | 5 snapshots | ΔY attributed to correct dates |
| `DR-004` | `daily_conversions_multi_cohort` | 10 cohorts × 5 snapshots | Daily totals aggregated correctly |
| `DR-005` | `mece_aggregation_sum` | 3 MECE slices | X, Y summed correctly |
| `DR-006` | `mece_aggregation_latency` | Aggregate latency | Weighted average by X, not simple mean |

### DI.3 Round-Trip Integrity Tests

**Critical:** These tests verify the complete data flow.

| Test ID | Test Name | Description | Assertions |
|---------|-----------|-------------|------------|
| `RT-001` | `roundtrip_simple` | Fetch → write → read → derive | Derived result matches expected |
| `RT-002` | `roundtrip_dual_query` | Dual-query → write → read | All columns intact, latency preserved |
| `RT-003` | `roundtrip_composite` | Composite → write → read | Synthesised data retrievable |
| `RT-004` | `roundtrip_contexted_mece` | MECE → write → read → aggregate | Aggregated sum matches uncontexted |
| `RT-005` | `roundtrip_signature_stable` | Fetch → write → later read with signature | Signature match succeeds |

### DI.4 Graceful Degradation Tests

| Test ID | Test Name | Description | Assertions |
|---------|-----------|-------------|------------|
| `GD-001` | `write_db_unavailable` | DB connection fails | Fetch succeeds, file written, warning logged |
| `GD-002` | `write_timeout` | DB write times out | Fetch succeeds, warning logged |
| `GD-003` | `read_db_unavailable` | Analytics with no DB | Clear error message returned |
| `GD-004` | `asAt_db_unavailable` | Historical query, no DB | Clear error: "requires database" |

### DI.5 Test Infrastructure

**Test Database:**
- Separate Neon branch or local Postgres for testing
- Schema identical to production
- Truncated before each test suite run
- Isolated from production data

**Test Fixtures:**

```typescript
// Fixture: simple time-series
const FIXTURE_SIMPLE = {
  param_id: 'test-repo-test-branch-param-a-to-b',
  core_hash: 'test-hash-abc123',
  slice_key: '',
  rows: [
    { anchor_day: '2025-10-01', A: 100, X: 80, Y: 10, ... },
    { anchor_day: '2025-10-02', A: 95, X: 75, Y: 12, ... },
    // ... more days
  ],
};

// Fixture: dual-query with latency
const FIXTURE_DUAL_QUERY = {
  n_query_result: { /* X values */ },
  k_query_result: { /* Y values, latency */ },
  expected_merged: { /* X from n, Y and latency from k */ },
};

// Fixture: MECE slices
const FIXTURE_MECE = {
  slices: [
    { slice_key: 'context(channel:google)', rows: [...] },
    { slice_key: 'context(channel:facebook)', rows: [...] },
    { slice_key: 'context(channel:organic)', rows: [...] },
  ],
  expected_uncontexted: { /* sum of all slices */ },
};
```

**Test File Locations:**

| File | Scope |
|------|-------|
| `graph-editor/src/services/__tests__/snapshotWriteService.test.ts` | WI-*, SI-*, CD-*, MS-* |
| `graph-editor/src/services/__tests__/snapshotRoundtrip.e2e.test.ts` | RT-* |
| `graph-editor/lib/tests/test_snapshot_handlers.py` | Python handler tests |
| `graph-editor/lib/tests/test_snapshot_integration.py` | RI-*, RT-* (Python) |
| `graph-editor/lib/tests/test_snapshot_derivations.py` | DR-* |
| `graph-editor/lib/tests/test_histogram_derivation.py` | DR-001, DR-002 |
| `graph-editor/lib/tests/test_daily_conversions.py` | DR-003, DR-004 |
| `graph-editor/lib/tests/test_mece_aggregation.py` | DR-005, DR-006 |
| `graph-editor/src/services/__tests__/gracefulDegradation.test.ts` | GD-* |

### DI.6 Test Completion Tracking

> **Update this section as tests are implemented and passing.**

| Category | Total | Implemented | Passing | Completion |
|----------|-------|-------------|---------|------------|
| Write Integrity (WI-*) | 8 | 0 | 0 | `[ ]` 0% |
| Signature Integrity (SI-*) | 5 | 0 | 0 | `[ ]` 0% |
| Composite/Dual (CD-*) | 5 | 0 | 0 | `[ ]` 0% |
| Multi-Slice (MS-*) | 3 | 0 | 0 | `[ ]` 0% |
| Read Integrity (RI-*) | 4 | 0 | 0 | `[ ]` 0% |
| Derivation (DR-*) | 6 | 0 | 0 | `[ ]` 0% |
| Round-Trip (RT-*) | 5 | 0 | 0 | `[ ]` 0% |
| Graceful Degradation (GD-*) | 4 | 0 | 0 | `[ ]` 0% |
| **TOTAL** | **40** | **0** | **0** | **0%** |

**Phase completion requires:**
- Phase 1: WI-*, SI-*, CD-*, MS-*, GD-001, GD-002 (25 tests)
- Phase 2: RI-*, DR-*, RT-*, GD-003 (20 tests)
- Phase 4: asAt tests per `asat.md` §13 + GD-004

---

## Rollout Plan

### Stage 1: Internal Testing (Week 1)
- Deploy to staging environment
- Team testing with real data
- Monitor DB performance
- Verify data integrity (all DI-* tests passing)

### Stage 2: Limited Beta (Week 2)
- Enable for select users
- Gather feedback on UI/UX
- Monitor error rates
- Tune performance if needed

### Stage 3: General Availability (Week 3)
- Enable for all users
- Documentation and training
- Support readiness

---

## Risk Mitigation

| Risk | Mitigation |
|------|------------|
| DB connection failures | Non-fatal shadow-write, clear error messages |
| Performance at scale | Indexed queries, pagination for large result sets |
| Data integrity | Idempotent writes (ON CONFLICT DO NOTHING) |
| Signature drift | Clear error messages, V2 signature history table |
| Credential management | Environment variables, Vercel secrets |

---

## Success Metrics

1. **Write success rate:** >99.9% of fetches shadow-write successfully
2. **Query latency:** <500ms for typical analytics queries
3. **Data coverage:** >90% of active parameters have snapshot history within 30 days
4. **User adoption:** >50% of users view histogram/daily conversions within first month

---

## Appendix: Design Decisions and Deferred Items

### Covered by This Plan

| Topic | Decision |
|-------|----------|
| **DB product** | Neon Postgres (managed, serverless-friendly) |
| **Schema** | Single `snapshots` table, append-only |
| **Write strategy** | Shadow-write (non-fatal, preserves offline) |
| **Idempotency** | `ON CONFLICT DO NOTHING` |
| **Access pattern** | Python backend only (frontend never touches DB) |
| **Partitioning** | None for V1 (expect <10M rows/year) |

### Explicit Design Principles

1. **DB stores raw evidence only:**
   - A/X/Y counts, latency observations, timestamps
   - NO derived values (forecast, p.mean, fitted params)

2. **Parameter files remain authoritative for:**
   - Derived/scalar values (forecast, p.stdev)
   - Metadata (query definition, connection, semantic context)
   - Acting as "index" to opaque DB identifiers

3. **Offline-first preserved — Graceful Degradation:**

   | Scenario | Behaviour |
   |----------|-----------|
   | **Python server unavailable** | App functions normally; fetch uses Amplitude directly; snapshot features show "unavailable" |
   | **DB unavailable (Python up)** | Fetches succeed (Amplitude); shadow-write silently fails; analytics show "DB unavailable" |
   | **Both unavailable** | App functions in offline mode; uses cached IndexedDB data; no external features |
   | **Network offline** | Full offline mode; graph editing, local data, everything except fetch/analytics |

   **Implementation requirements:**
   - Shadow-write wrapped in try/catch — never throws
   - Snapshot analytics endpoints return `{ success: false, error: "DB unavailable" }` — UI shows message
   - `asAt` queries return clear error: "Historical data requires database connection"
   - Fetch button always works (Amplitude is separate from DB)
   - All graph operations independent of DB state

4. **Security boundary:**
   - All DB access via Python backend endpoints
   - Frontend NEVER directly connects to DB
   - `DB_CONNECTION` managed via Vercel secrets

### Context Definition Stability (Resolved)

**Decision:** Option C — Store both `core_hash` and `context_def_hashes` as separate columns.

- **V1 behaviour:** Query matching uses `core_hash` only (flexible, resilient to context evolution)
- **Future:** Can add stricter matching using `context_def_hashes` when needed
- **Audit:** Can detect when context definitions changed over time
- **Data cost:** Negligible (~75 KB/day extra)

See `snapshot-db-design.md` §3.8.6 for full rationale.

---

### Negative Delta Policy (Histogram Derivation)

When computing histograms from snapshot deltas, negative ΔY can occur due to:
- Attribution drift (Amplitude reprocessing)
- Sampling variance
- Data corrections

**V1 Policy:**
- **Storage:** Preserve raw data as-is (don't modify on write)
- **Histogram derivation:** Clamp ΔY < 0 to 0, log warning
- **Monitoring:** Track drift metric = Σ|negative deltas| / Σ|all deltas|

### Deferred to Future Phases

| Item | Rationale |
|------|-----------|
| **Run ID per retrieval** | Wall-clock `retrieved_at` sufficient for V1; add if debugging needs arise |
| **Partitioning** | Not needed until >50M rows |
| **Forecasting/backtesting** | Depends on sufficient snapshot history (Phase 5) |
| **Richer latency modelling** | Analytics/ML on top of data (Phase 5) |
| **Advanced charting** | See `time-series-charting.md` — Phase 5 |

---

## Phase 5: Advanced Time-Series Charting (Deferred)

**Scope:** Richer visualisations of snapshot-derived data. Depends on Phases 1-3 being complete.

**Documented separately in:** [`docs/current/project-db/time-series-charting.md`](./time-series-charting.md)

**Summary of deferred capabilities:**

| Capability | Description |
|------------|-------------|
| **Fan charts** | Probability bands showing forecast uncertainty |
| **Funnel time series** | Line chart of conversion % by funnel stage over time |
| **Evidence vs Forecast** | Visual distinction between observed data and t95 extrapolation |
| **Configurable aggregation** | Daily/weekly/monthly rollups |
| **Latency drift analysis** | Compare Amplitude-reported latency vs ΔY-derived latency |
| **Completeness overlays** | Show cohort maturity alongside conversion data |

**Rationale for deferral:** Charting complexity should NOT block the core write/read path. Get data flowing first; iterate on presentation later. Phase 5 can begin once Phase 3 is stable.

---

## Appendix A: Complete File Inventory

### A.1 New Files to Create

#### Python (Backend)
| File | Purpose | Phase |
|------|---------|-------|
| `graph-editor/lib/snapshot_service.py` | DB connection, append, query, inventory functions | 1 |
| `graph-editor/lib/runner/histogram_derivation.py` | Compute lag histogram from snapshot deltas | 2 |
| `graph-editor/lib/runner/daily_conversions_derivation.py` | Compute daily conversion counts | 2 |

#### TypeScript (Frontend)
| File | Purpose | Phase |
|------|---------|-------|
| `graph-editor/src/services/snapshotWriteService.ts` | Call Python append endpoint | 1 |
| `graph-editor/src/services/snapshotInventoryCache.ts` | Cache snapshot availability with TTL | 3 |
| `graph-editor/src/services/snapshotQueryService.ts` | Construct snapshot query params for Python | 4 |
| `graph-editor/src/hooks/useSnapshotAvailability.ts` | React hook for edge tooltip availability | 3 |

#### Test Files
| File | Purpose | Phase |
|------|---------|-------|
| `graph-editor/lib/tests/test_snapshot_handlers.py` | Python handler tests | 1 |
| `graph-editor/lib/tests/test_snapshot_integration.py` | Python integration tests | 1 |
| `graph-editor/lib/tests/test_histogram_derivation.py` | Histogram derivation tests | 2 |
| `graph-editor/lib/tests/test_daily_conversions_derivation.py` | Daily conversions tests | 2 |
| `graph-editor/src/services/__tests__/snapshotWriteService.test.ts` | Frontend write service tests | 1 |
| `graph-editor/src/lib/__tests__/queryDSL.asAt.test.ts` | asAt parsing tests | 4 |

---

### A.2 Files to Modify

#### Phase 0: Prerequisites (Latency Preservation)

| File | Current Behaviour | Required Change |
|------|-------------------|-----------------|
| `graph-editor/src/services/dataOperationsService.ts` | Latency fields lost in dual-query combination (~line 6300) | Preserve `median_lag_days`, `mean_lag_days`, `anchor_*` from k_query |
| `graph-editor/src/lib/das/compositeQueryExecutor.ts` | Latency fields not passed through combination | Pass through latency fields when combining sub-query results |

#### Phase 1: Write Path

| File | Current Behaviour | Required Change |
|------|-------------------|-----------------|
| `graph-editor/lib/snapshot_handlers.py` | New file | Add `handle_snapshots_append()`, `handle_snapshots_health()` |
| `graph-editor/src/services/dataOperationsService.ts` | Writes to file only | Shadow-write to DB after `mergeTimeSeriesIntoParameter()` (~line 7060) |
| `graph-editor/dev-server.py` | No snapshot routes | Import and register snapshot endpoints |
| `graph-editor/requirements.txt` | No psycopg2 | Add `psycopg2-binary>=2.9.11` (already done) |
| `graph-editor/.env.local.template` | No DB_CONNECTION | Add `DB_CONNECTION` variable (already done) |
| `dev-start.sh` | Doesn't export DB_CONNECTION | Export to Python env (already done) |

#### Phase 2: Read Path (Analytics)

| File | Current Behaviour | Required Change |
|------|-------------------|-----------------|
| `graph-editor/lib/api_handlers.py` | Existing `/api/runner/analyze` | Extend with `snapshot_query` handling |
| `graph-editor/lib/snapshot_handlers.py` | New file | Add `handle_snapshots_*()` functions |
| `graph-editor/lib/runner/types.py` | No snapshot analysis types | Add `SnapshotAnalysisRequest`, `SnapshotAnalysisResponse` Pydantic models |
| `graph-editor/src/lib/graphComputeClient.ts` | No snapshot query method | Add `analyzeSnapshots()`, `getSnapshotInventory()` methods |

#### Phase 3: UI Integration

| File | Current Behaviour | Required Change |
|------|-------------------|-----------------|
| `graph-editor/src/components/panels/AnalyticsPanel.tsx` | Fixed analysis types | Add dropdown for "Lag Histogram", "Daily Conversions" |
| `graph-editor/src/components/edges/ConversionEdge.tsx` | No snapshot info in tooltip | Query inventory on hover, display "Snapshots: {dates}" |
| `graph-editor/src/services/analysisEChartsService.ts` | No snapshot chart types | Add `renderLagHistogram()`, `renderDailyConversions()` |

#### Phase 4: asAt Queries

**DSL Parsing (CRITICAL - affects many downstream files)**

| File | Current Behaviour | Required Change |
|------|-------------------|-----------------|
| `graph-editor/src/lib/queryDSL.ts` | No asAt function | Add to `QUERY_FUNCTIONS`, `ParsedConstraints`, `parseConstraints()`, `normalizeConstraintString()`, `augmentDSLWithConstraint()` |
| `graph-editor/lib/query_dsl.py` | No asAt function | Add to `ParsedQuery`, `parse_query()`, `_extract_as_at()` |

**Scenario Composition**

| File | Current Behaviour | Required Change |
|------|-------------------|-----------------|
| `graph-editor/src/services/scenarioRegenerationService.ts` | `FetchParts` has window/cohort | Add `asAt` field, update `splitDSLParts()`, `buildFetchDSL()` |
| `graph-editor/src/contexts/ScenariosContext.tsx` | Regenerates from Amplitude | Detect asAt in scenario DSL, skip regeneration for asAt scenarios |
| `graph-editor/src/components/panels/ScenariosPanel.tsx` | All scenarios regenerable | Show asAt badge, disable regeneration button for asAt scenarios |

**WindowSelector UI**

| File | Current Behaviour | Required Change |
|------|-------------------|-----------------|
| `graph-editor/src/components/WindowSelector.tsx` | `queryMode: 'cohort' \| 'window'` | Add `'asAt'` mode, date picker, DSL construction with asAt |
| `graph-editor/src/contexts/GraphStoreContext.tsx` | No asAt state | May need to track asAt state if persisted to graph |

**Data Operations Fork**

| File | Current Behaviour | Required Change |
|------|-------------------|-----------------|
| `graph-editor/src/services/dataOperationsService.ts` | Always calls DAS | Detect asAt in DSL, fork to DB query before DAS execution (~line 5910) |
| `graph-editor/src/lib/graphComputeClient.ts` | No querySnapshots | Add `querySnapshots()` method for asAt DB retrieval |
| `graph-editor/lib/snapshot_handlers.py` | Phase 1 handlers | Add `handle_snapshots_query()` with signature validation |

---

### A.3 Files That Import queryDSL (May Need Review)

These files import from `queryDSL.ts` and use `ParsedConstraints`. **Review each to ensure asAt field is handled or ignored as appropriate.**

#### Services (High Priority - Core Logic)
| File | Uses | Impact |
|------|------|--------|
| `src/services/dataOperationsService.ts` | `parseConstraints` | **MODIFY**: Detect asAt for DB fork |
| `src/services/scenarioRegenerationService.ts` | `parseConstraints`, `augmentDSLWithConstraint` | **MODIFY**: Handle asAt in composition |
| `src/services/windowAggregationService.ts` | `parseConstraints` | Review: May ignore asAt (aggregation doesn't change) |
| `src/services/fetchDataService.ts` | `parseConstraints` | Review: Orchestrates fetch, may need asAt awareness |
| `src/services/fetchOrchestratorService.ts` | `parseConstraints` | Review: May ignore asAt |
| `src/services/windowFetchPlannerService.ts` | `parseConstraints` | Review: Planner may need asAt awareness |
| `src/services/fetchPlanBuilderService.ts` | `parseConstraints` | Review: Plan building may ignore asAt |
| `src/services/meceSliceService.ts` | `parseConstraints` | Review: MECE resolution may ignore asAt |
| `src/services/sliceIsolation.ts` | `parseConstraints` | Review: Slice isolation may ignore asAt |
| `src/services/querySignatureService.ts` | `parseConstraints` | **CRITICAL**: Signature computation - asAt should NOT affect signature |
| `src/services/contextAggregationService.ts` | `parseConstraints` | Review: May ignore asAt |
| `src/services/slicePlanValidationService.ts` | `parseConstraints` | Review: Validation may ignore asAt |
| `src/services/contextRegistry.ts` | `parseConstraints` | Review: Context extraction may ignore asAt |
| `src/services/dimensionalReductionService.ts` | `parseConstraints` | Review: May ignore asAt |
| `src/services/retrieveAllSlicesService.ts` | `parseConstraints` | Review: Bulk retrieval may ignore asAt |
| `src/services/lagHorizonsService.ts` | `parseConstraints` | Review: May ignore asAt |
| `src/services/plannerQuerySignatureService.ts` | `parseConstraints` | Review: May ignore asAt |
| `src/services/variableAggregationCache.ts` | `parseConstraints` | Review: Cache key may ignore asAt |

#### Libraries
| File | Uses | Impact |
|------|------|--------|
| `src/lib/dslDynamics.ts` | `parseConstraints` | Review: Dynamic DSL may ignore asAt |
| `src/lib/dslExplosion.ts` | `parseConstraints` | Review: Explosion may ignore asAt |
| `src/lib/whatIf.ts` | `parseConstraints` | Review: What-if may ignore asAt |
| `src/lib/graphPruning.ts` | `parseConstraints` | Review: Pruning may ignore asAt |
| `src/lib/conditionalReferences.ts` | `parseConstraints` | Review: May ignore asAt |
| `src/lib/das/buildDslFromEdge.ts` | `parseConstraints` | Review: DSL building may ignore asAt |
| `src/lib/das/compositeQueryParser.ts` | `parseConstraints` | Review: Composite parsing may ignore asAt |
| `src/lib/das/buildDataQuerySpec.ts` | `parseConstraints` | Review: Query spec may ignore asAt |

#### Components
| File | Uses | Impact |
|------|------|--------|
| `src/components/WindowSelector.tsx` | `parseConstraints` | **MODIFY**: Add asAt mode UI |
| `src/components/QueryExpressionEditor.tsx` | `parseConstraints` | Review: May need asAt autocomplete |
| `src/components/WhatIfAnalysisControl.tsx` | `parseConstraints` | Review: May ignore asAt |
| `src/components/PropertiesPanel.tsx` | `parseConstraints` | Review: May display asAt info |
| `src/components/panels/ScenariosPanel.tsx` | `parseConstraints` | **MODIFY**: Show asAt badge |
| `src/components/edges/ConversionEdge.tsx` | `parseConstraints` | **MODIFY**: Show snapshot availability |
| `src/components/modals/PinnedQueryModal.tsx` | `parseConstraints` | Review: May ignore asAt |

#### Contexts
| File | Uses | Impact |
|------|------|--------|
| `src/contexts/GraphStoreContext.tsx` | `parseConstraints` | Review: State management |
| `src/contexts/ScenariosContext.tsx` | `parseConstraints` | **MODIFY**: Handle asAt scenarios |

---

### A.4 Python Files Using query_dsl

| File | Uses | Impact |
|------|------|--------|
| `lib/query_dsl.py` | Defines `ParsedQuery` | **MODIFY**: Add `as_at` field |
| `lib/api_handlers.py` | `handle_runner_analyze` | **MODIFY**: Extend with `snapshot_query` handling |
| `lib/snapshot_handlers.py` | New file | **CREATE**: Add all `handle_snapshots_*()` functions |
| `lib/graph_select.py` | `parse_query` | Review: Selection may ignore asAt |
| `lib/graph_types.py` | Types | Review: May need asAt type |
| `lib/runner/analyzer.py` | `parse_query` | Review: Analysis may ignore asAt |

---

### A.5 Existing Test Files to Update

| Test File | Scope | Updates Needed |
|-----------|-------|----------------|
| `src/lib/__tests__/queryDSL.test.ts` | DSL parsing | Add asAt parsing tests |
| `src/services/__tests__/dataOperationsService.integration.test.ts` | Data ops | Add shadow-write tests, asAt fork tests |
| `src/services/__tests__/scenarioRegenerationService.test.ts` | Scenarios | Add asAt scenario tests |
| `src/contexts/__tests__/ScenariosContext.liveScenarios.test.tsx` | Scenarios | Add asAt composition tests |
| `src/components/__tests__/WindowSelector.coverage.test.ts` | WindowSelector | Add asAt mode tests |
| `lib/tests/test_api_route_parity.py` | API parity | Add snapshot endpoint tests |

---

### A.6 Configuration and Infrastructure Files

| File | Purpose | Change |
|------|---------|--------|
| `graph-editor/requirements.txt` | Python deps | `psycopg2-binary` (done) |
| `graph-editor/.env.local.template` | Local env | `DB_CONNECTION` (done) |
| `dev-start.sh` | Local dev | Export `DB_CONNECTION` (done) |
| `vercel.json` or equivalent | Production | Ensure Python can access env vars |
| `.gitignore` | Ignore patterns | Ensure `.env.local` ignored |

---

## Appendix B: Affected Code Paths — Detailed Trace

### B.1 Write Path: Fetch → Shadow-Write

```
User clicks "Fetch" in WindowSelector
    ↓
WindowSelector.tsx
    └── useFetchData hook
        └── fetchItems() / fetchItem()
            └── fetchDataService.ts → fetchSingleItemInternal()
                └── dataOperationsService.ts → getFromSource()
                    └── getFromSourceDirect() [LINE 3654]
                        │
                        ├── [LINE 4909-4947] computeQuerySignature()
                        │   └── querySignatureService.ts → computeQuerySignature()
                        │
                        ├── [LINE 5567] createDASRunner()
                        │
                        ├── [LINE 5914] executeDAS() → runner.execute()
                        │   └── DASRunner.ts → execute()
                        │       └── HTTP to Amplitude
                        │
                        ├── [LINE 6280+] Composite query handling
                        │   └── compositeQueryExecutor.ts → executeCompositeQuery()
                        │       └── ⚠️ LATENCY FIELDS LOST HERE (Phase 0 fix)
                        │
                        ├── [LINE 7031] mergeTimeSeriesIntoParameter()
                        │   └── windowAggregationService.ts
                        │
                        └── [NEW: ~LINE 7070] SHADOW-WRITE TO DB
                            └── snapshotWriteService.ts → appendSnapshots()
                                └── HTTP POST /api/snapshots/append
                                    └── snapshot_handlers.py → handle_snapshots_append()
                                        └── snapshot_service.py → append_snapshots()
                                            └── psycopg2 INSERT
```

### B.2 Read Path: Analytics Query

```
User selects "Lag Histogram" in AnalyticsPanel
    ↓
AnalyticsPanel.tsx
    └── handleAnalyze()
        └── graphComputeClient.ts → analyzeSelection()
            └── HTTP POST /api/runner/analyze (with snapshot_query)
                └── api_handlers.py → handle_runner_analyze()
                    ├── snapshot_service.py → query_snapshots()
                    │   └── psycopg2 SELECT
                    └── histogram_derivation.py → derive_lag_histogram()
                        └── Return {data: [...], total_conversions: N}
    ↓
AnalyticsPanel.tsx
    └── analysisEChartsService.ts → renderLagHistogram()
        └── ECharts bar chart
```

### B.3 asAt Path: Historical Query Fork

```
User sets asAt date in WindowSelector
    ↓
WindowSelector.tsx
    └── setQueryMode('asAt')
    └── setAsAtDate('2025-12-01')
    └── buildDSL() → "cohort(...).asAt(1-Dec-25)"
    └── setCurrentDSL()
    ↓
User triggers fetch (or scenario regeneration)
    ↓
dataOperationsService.ts → getFromSourceDirect()
    │
    ├── [LINE ~4850] Parse DSL
    │   └── queryDSL.ts → parseConstraints()
    │       └── Extract asAt: "1-Dec-25"
    │
    ├── [NEW: ~LINE 5900] asAt DETECTION
    │   │
    │   └── IF asAt is set:
    │       │
    │       ├── Build DB query params
    │       │   └── snapshotQueryService.ts → buildSnapshotQuery()
    │       │
    │       ├── Call Python endpoint
    │       │   └── graphComputeClient.ts → querySnapshots()
    │       │       └── HTTP POST /api/snapshots/query
    │       │           └── snapshot_handlers.py → handle_snapshots_query()
    │       │               └── snapshot_service.py → query_snapshots()
    │       │                   └── psycopg2 SELECT with retrieved_at <= asAt
    │       │
    │       ├── Validate signature match
    │       │   └── IF no match → throw Error("Query configuration changed")
    │       │
    │       ├── Convert to time-series format
    │       │   └── Same shape as DAS response
    │       │
    │       └── SKIP DAS execution, SKIP file write
    │
    └── ELSE: Normal DAS execution path
```

### B.4 Scenario Composition with asAt

```
User creates scenario with queryDSL: "asAt(1-Dec-25)"
    ↓
ScenariosContext.tsx → createLiveScenario()
    └── scenario.meta.queryDSL = "asAt(1-Dec-25)"
    ↓
User makes scenario visible
    ↓
ScenariosContext.tsx → regenerateScenario()
    │
    ├── scenarioRegenerationService.ts → splitDSLParts()
    │   └── Extract: fetchParts.asAt = "1-Dec-25"
    │
    ├── computeInheritedDSL()
    │   └── baseDSL + lower scenarios → "cohort(-30d:)"
    │
    ├── computeEffectiveFetchDSL()
    │   └── inherited + scenario → "cohort(-30d:).asAt(1-Dec-25)"
    │
    └── dataOperationsService.ts → getFromSourceDirect()
        └── asAt detected → DB query path (not Amplitude)
```

---

## Appendix C: Signature Computation — asAt Exclusion

**CRITICAL:** `asAt` MUST NOT affect query signature.

The signature identifies the **query semantics** (from/to/visited/context/etc.), not the retrieval mode.

```typescript
// In querySignatureService.ts → computeQuerySignature()

// asAt is NOT included in coreCanonical:
const coreCanonical = JSON.stringify({
  connection: connectionName || '',
  from_event_id: from_event_id || '',
  to_event_id: to_event_id || '',
  visited_event_ids: visited_event_ids.sort(),
  exclude_event_ids: exclude_event_ids.sort(),
  event_def_hashes: eventDefHashes,
  event_filters: queryPayload.event_filters || {},
  case: (queryPayload.case || []).sort(),
  cohort_mode: !!queryPayload.cohort,
  cohort_anchor_event_id: queryPayload?.cohort?.anchor_event_id || '',
  latency_parameter: edgeLatency?.latency_parameter === true,
  latency_anchor_event_id: latencyAnchorEventId,
  original_query: normalizedOriginalQuery,
  // NO asAt here — asAt changes retrieval source, not query semantics
});
```

This ensures:
- Historical data with same query definition has matching signature
- asAt queries can retrieve data stored by live queries
- Signature mismatch indicates actual query change, not just asAt toggle
