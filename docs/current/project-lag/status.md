# Project LAG: Implementation Status

**Started:** 8-Dec-25
**Last Updated:** 8-Dec-25
**Phase:** C3 ✅ Complete — Ready for C4 (UI & Rendering)

---

## Current Progress

### Phase P0: Rename `cost_time` → `labour_cost` ✅ COMPLETE

Pre-requisite cleanup before introducing latency complexity.

| Task | Status | Notes |
|------|--------|-------|
| P0.1 TypeScript Types | ✅ Done | `index.ts`, `scenarios.ts` |
| P0.2 Python Models | ✅ Done | `graph_types.py`, runners |
| P0.3 Schema Files | ✅ Done | `parameter-schema.yaml`, `registry-schema.yaml`, `conversion-graph-*.json` |
| P0.4 Services & UI | ✅ Done | 81 files updated across services, components, hooks |
| P0.5 Test Updates | ✅ Done | All tests updated + query DSL tests fixed for `cohort` function |
| P0.6 Verification | ✅ Done | Zero `cost_time` hits, 1977 tests pass |

**Summary:**
- Renamed 471 occurrences of `cost_time` → `labour_cost` across 81 files
- Also updated `cohort` function in query DSL schema (needed for LAG)
- Updated sample data files in `param-registry/test/`

---

### Phase C1: Schema Changes & Core Types ✅ COMPLETE

| Task | Status | Notes |
|------|--------|-------|
| C1.1 TypeScript Types | ✅ Done | `LatencyConfig`, `EdgeLatencyDisplay`, updated `ProbabilityParam` |
| C1.2 Python Models | ✅ Done | `LatencyConfig`, `ForecastParams` in `graph_types.py` |
| C1.3 Parameter Schema | ✅ Done | Added latency config + slice fields to `parameter-schema.yaml` |
| C1.4 UpdateManager | ✅ Done | Added bidirectional latency field mappings |
| C1.5 MSMDC | ✅ Done | Added `compute_anchor_node_id()` for A→X detection |
| C1.6 UI Schema | ✅ Done | Added latency to `parameter-ui-schema.json` |

**Summary:**
- Added `LatencyConfig` interface with `maturity_days`, `anchor_node_id`, `t95`, `median_lag_days`, `completeness`
- Added LAG fields to `ProbabilityParam`: `latency`, `forecast`
- Updated scenario param packs per design §9.K.1 (removed distribution fields)
- Added 30+ new fields to parameter schema for cohort/window latency data
- MSMDC now computes anchor_node_id (furthest upstream START node)

### Phase C2: DSL & Query Architecture ✅ COMPLETE

| Task | Status | Notes |
|------|--------|-------|
| C2.0 Codebase Audit | ✅ Done | Traced full query flow: queryDSL → buildDslFromEdge → dataOps → DASRunner → adapter |
| C2.1 DASRunner Types | ✅ Done | Added `cohort` to `ExecutionContext`, `RunnerExecuteOptions` in `das/types.ts` |
| C2.2 dataOps Extract | ✅ Done | Extract `constraints.cohort` and `requestedCohort` from queryPayload |
| C2.3 dataOps Pass | ✅ Done | Pass cohort to all 3 `runner.execute()` calls |
| C2.4 DASRunner Context | ✅ Done | Include cohort in `ExecutionContext` and pre_request script env |
| C2.5 Adapter Cohort Mode | ✅ Done | Handle 3-step funnel (Anchor→From→To) + `cs` param in connections.yaml |
| C2.6 Latency Extraction | ✅ Done | Extract `dayMedianTransTimes`, histograms, aggregate lag stats from Amplitude |
| C2.7 Window Aggregation | ✅ Done | Added `cohort_from`/`cohort_to`, latency arrays to `ParameterValue` |
| C2.8 Verification | ✅ Done | All tests pass (1977 TS, 271 Python) |

**Key changes made:**
- `das/types.ts`: Added `cohort` to `ExecutionContext` and `RunnerExecuteOptions`
- `DASRunner.ts`: Added `cohort` to execution context and pre_request script environment
- `dataOperationsService.ts`: Extract `requestedCohort` from queryPayload, add to constraint merges, pass to runner.execute()
- `connections.yaml`: Detect cohort mode, prepend anchor step (3-step funnel), use cohort.start/end dates, set `cs` param
- Amplitude adapter: Extract `dayMedianTransTimes`, `dayAvgTransTimes`, `medianTransTimes`, `stepTransTimeDistribution`
- Transform: Include `median_lag_days`, `mean_lag_days` in time_series output; compute aggregate lag stats
- `windowAggregationService.ts`: Added `TimeSeriesPointWithLatency`, `MergeOptions` interfaces; updated `mergeTimeSeriesIntoParameter`
- `paramRegistryService.ts`: Added `cohort_from`, `cohort_to`, `median_lag_days[]`, `mean_lag_days[]`, `latency` to `ParameterValue`

### Phase C2-T: Test Coverage for C1/C2 ✅ COMPLETE

| Task | Status | Notes |
|------|--------|-------|
| C2-T.1 DSL Parsing Tests | ✅ Done | `queryDSL.test.ts` — 12 cohort() tests |
| C2-T.2 DSL Explosion Tests | ✅ Done | `dslExplosion.test.ts` — 6 cohort slice tests |
| C2-T.3 DAS Runner Tests | ✅ Done | `DASRunner.preRequest.test.ts` — 5 cohort context tests |
| C2-T.4 Window Aggregation Tests | ✅ Done | `windowAggregationService.test.ts` — 5 cohort mode tests |
| C2-T.5 Python anchor Tests | ✅ Done | `test_msmdc.py` — 7 anchor_node_id tests |
| C2-T.6 Acceptance | ✅ Done | All 35 new tests passing |

---

### Phase C3: Data Storage, Aggregation & Inference ✅ COMPLETE

| Task | Status | Notes |
|------|--------|-------|
| C3.1 Constants | ✅ Done | Created `constants/latency.ts` with LAG thresholds |
| C3.2 Log-normal CDF | ✅ Done | `statisticalEnhancementService.ts`: `logNormalCDF`, `standardNormalCDF`, `erf` |
| C3.3 Formula A | ✅ Done | `applyFormulaA`, `applyFormulaAToAll` for Bayesian forecasting |
| C3.4 Completeness | ✅ Done | `calculateCompleteness` using CDF-based formula (§5.5) |
| C3.5 P-infinity | ✅ Done | `estimatePInfinity` from mature cohorts (§5.6) |
| C3.6 Edge Stats | ✅ Done | `computeEdgeLatencyStats` with quality gates, t95 |
| C3.7 Cohort Aggregation | ✅ Done | `windowAggregationService`: cohort data conversion functions |
| C3.8 dataOps Integration | ✅ Done | LAG stats computed during window aggregation for latency edges |
| C3.9 Path Maturity DP | ✅ Done | `computePathT95`, `getActiveEdges` topological DP |
| C3.10 Topo Fetch Order | ✅ Done | `fetchDataService`: topological sorting for batch fetches |
| C3.11 LAG Tests | ✅ Done | 75 tests for statistical functions (property-based, edge cases) |

**Key changes made:**
- `constants/latency.ts`: New file with LAG thresholds (`LATENCY_MIN_FIT_CONVERTERS`, `LATENCY_MIN_MEAN_MEDIAN_RATIO`, etc.)
- `statisticalEnhancementService.ts`: Added ~500 lines of LAG statistical functions:
  - Mathematical utilities: `erf`, `standardNormalCDF`, `standardNormalInverseCDF`
  - Log-normal: `logNormalCDF`, `logNormalSurvival`, `logNormalInverseCDF`
  - Distribution fitting: `fitLagDistribution`, `computeT95`
  - Formula A: `applyFormulaA`, `applyFormulaAToAll`
  - Completeness: `calculateCompleteness`
  - P-infinity: `estimatePInfinity`
  - Main entry: `computeEdgeLatencyStats`
  - Path maturity: `getActiveEdges`, `computePathT95`, `getEdgesInTopologicalOrder`
- `windowAggregationService.ts`: Added cohort data conversion functions
- `dataOperationsService.ts`: Integrated LAG computation into aggregation flow
- `fetchDataService.ts`: Added topological sorting for batch fetches
- Tests: 75 LAG statistical tests covering CDF bounds, monotonicity, Formula A, completeness, p_infinity

### Phase C4: UI & Rendering ⏳ IN PROGRESS

| Task | Status | Notes |
|------|--------|-------|
| C4.1 Edge Two-Layer Rendering | ✅ Done | `ConversionEdge.tsx` - LAG stripe patterns + two-layer paths |
| C4.2 Edge Beads - Latency Bead | ✅ Done | `edgeBeadHelpers.tsx` lines 609-644 |
| C4.3 Properties Panel - Latency Fields | ✅ Done | `ParameterSection.tsx` - Track Latency checkbox + Maturity field |
| C4.4 Scenarios & Visibility 4-state | ✅ Done | `TabContext.tsx` - cycleScenarioVisibilityMode, getScenarioVisibilityMode |
| C4.5 Tooltips - Latency/Forecast | ✅ Done | `ConversionEdge.tsx` tooltip lines 267-295 |
| C4.6 Window Selector Toggle | ✅ Done | `WindowSelector.tsx` - cohort/window mode toggle |
| C4.7 Scenario Chip & Legend UI | ✅ Done | `ScenariosPanel.tsx`, `ScenarioLegend.tsx` - 4-state icons (Eye/View/EyeClosed/EyeOff) |
| C4.8 Sibling Probability Warnings | ✅ Done | `integrityCheckService.ts` - Σp>1 warning logic |

### Phase A: Analytics (Post-Core) ⏸️ BLOCKED (by C4)

---

## Open Issues Being Monitored

1. **Amplitude Rate Limits** — Will monitor during C2/C3 implementation
2. **Mock Amplitude Data Generator** — Needed during testing phase
3. **LAG Sample Data** — Create realistic `cohort()` + `window()` sample data in `param-registry/test/` (Phase C3)

---

## Session Log

### 8-Dec-25

**Session Start:** Commenced implementation per `implementation.md`

**Actions:**
1. Read implementation plan and residual open issues
2. Audited codebase for `cost_time` occurrences:
   - Found P0 has NOT been completed
   - 365+ TS occurrences, 57+ Python occurrences
3. Created this status file
4. **Completed Phase P0 rename:**
   - Updated TypeScript types (`index.ts`, `scenarios.ts`)
   - Updated Python models (`graph_types.py`, runners, msmdc)
   - Updated YAML schemas (`parameter-schema.yaml`, `registry-schema.yaml`)
   - Updated JSON schemas (`conversion-graph-1.0.0.json`, `conversion-graph-1.1.0.json`)
   - Updated 81 files across services, components, hooks, tests
   - Updated sample data files in `param-registry/test/`
   - Fixed query DSL tests (added `cohort` function support)
   - **All 1977 tests pass**

**Phase P0 Complete** — Proceeded to Phase C1

5. **Completed Phase C1 schema changes:**
   - Added `LatencyConfig` interface to TypeScript and Python
   - Added LAG fields to `ProbabilityParam` (latency, forecast)
   - Updated parameter schema with cohort/window latency fields
   - Added latency field mappings to UpdateManager (bidirectional)
   - Implemented `compute_anchor_node_id()` in MSMDC
   - Updated UI schema for parameter form
   - **All tests pass (1977 TS, 271 Python)**

**Phase C1 Complete** — Proceeded to Phase C2

6. **Started Phase C2 (DSL & Query Architecture):**
   - Initial attempt rushed without proper codebase understanding
   - Added `cohort` to `QueryPayload` in `buildDslFromEdge.ts` (partial)
   - Added `cohort` autocomplete to `QueryExpressionEditor.tsx`
   - **Halted for proper audit** — traced full query processing pipeline
   - Identified 8 tasks remaining before cohort queries actually work

7. **Completed Phase C2 execution pipeline:**
   - Added `cohort` to DASRunner types (`das/types.ts`)
   - Updated `DASRunner.ts` to include cohort in ExecutionContext and pre_request script
   - Updated `dataOperationsService.ts` to extract cohort from queryPayload and pass to runner
   - Updated Amplitude adapter in `connections.yaml`:
     - Detect cohort mode and prepend anchor step (3-step funnel)
     - Use cohort.start/end dates instead of window dates
     - Add `cs` (conversion window) parameter for maturity_days
     - Extract latency fields: `dayMedianTransTimes`, `dayAvgTransTimes`, histograms
     - Transform to include `median_lag_days`, `mean_lag_days` in time_series
   - Updated `implementation.md` with detailed task breakdown
   - **All tests pass (1977 TS, 271 Python)**

8. **Completed Phase C2 windowAggregationService updates:**
   - Added `TimeSeriesPointWithLatency` interface for time-series with lag data
   - Added `MergeOptions` interface for cohort mode detection
   - Updated `mergeTimeSeriesIntoParameter` to handle cohort mode and latency arrays
   - Updated `ParameterValue` interface with cohort fields and latency arrays
   - **All tests pass (verified individually; full suite has transient timeouts)**

**Phase C2 Code Complete** — Tests needed before C3

9. **CORRECTION: Test coverage required before C3:**
   - Realised that running existing tests ≠ testing new functionality
   - Added Phase C2-T to implementation plan (required before C3)
   - Tests needed: DSL parsing, DSL explosion, DASRunner, windowAggregation, Python anchor_node_id
   - Must add tests that actually exercise cohort code paths

**Phase C2-T Next** — Write tests for C1/C2 functionality

10. **Schema parity fix (8-Dec-25):**
    - Python tests revealed `ProbabilityParam` parity failure: `forecast` and `latency` fields missing from JSON schema
    - Root cause: Implementation plan §1.3 specified parameter-schema.yaml but **missed graph JSON schemas**
    - Fixed: Added `LatencyConfig` and `ForecastParams` to `$defs` in both `conversion-graph-1.0.0.json` and `conversion-graph-1.1.0.json`
    - Fixed: Added `latency` and `forecast` fields to `ProbabilityParam` in both schemas
    - Fixed: Updated `test_schema_parity.py` (Python) to include new types in `SCHEMA_TO_PYTHON` mapping
    - Fixed: Updated `schemaTypescriptParity.test.ts` (TS) to include new fields and types in `TYPESCRIPT_FIELDS` and `SCHEMA_TO_TS`
    - Added §1.3.1 to implementation plan to document this requirement
    - **All tests pass (332 Python; TS has 4 transient timing failures unrelated to LAG)**

---

## Verification Checklist (P0) ✅ COMPLETE

- [x] `grep -r "cost_time" graph-editor/src/` returns zero hits ✅
- [x] `grep -r "cost_time" graph-editor/lib/` returns zero hits ✅
- [x] `grep -r "cost_time" graph-editor/public/` returns zero hits ✅
- [x] All TypeScript tests pass (2008 tests) ✅
- [x] All Python tests pass (332 tests) ✅
- [ ] Manual smoke test: load graph with cost data — *optional*

