# t95 Fix Implementation Plan

**Design Document:** `t95-fix.md`  
**Status:** 🔲 Not Started  
**Created:** 14-Dec-25

---

## Phase Ordering and Preconditions

This document is **Phase 2** of the integrated plan:

- **Phase 1 (required first):** `docs/current/project-lag/window-cohort-lag-correction-plan.md`  
  Correct `window()`/`cohort()` semantics and repair regressions introduced by the refactor to a single topo/LAG pass.
- **Phase 2 (this document):** introduce parameter-level, overridable `t95/path_t95` and remove `maturity_days` from all logic.

Do not start Phase 2 implementation until Phase 1 is complete and the relevant semantics tests pass.

---

## Known Regressions (History, Context for Phase 1)

The following tests were observed failing on 14-Dec-25. We confirmed (by stashing, checking out a known-good commit from 11-Dec-25 afternoon, and re-running) that these **did pass** and therefore represent **real regressions introduced by later refactors** (not merely outdated expectations).

These failures are also directly related to the emerging **Window/Cohort semantics correction** work (see `docs/current/project-lag/window-cohort-lag-correction-plan.md`). They should be addressed as part of Phase 1 of that plan, before implementing the Phase 2 `t95/path_t95` override migration.

### 1. dataOperationsService.test.ts

| Test | Issue |
|------|-------|
| `should set non-latency p.mean = evidence for window() queries` | `edge.p.evidence.mean` is `undefined`, expected ~0.1 |

### 2. sampleFileQueryFlow.e2e.test.ts (7 failures)

| Test | Issue |
|------|-------|
| `Cohort Query > should produce param pack with correct fields from cohort slice` | `p.mean` = 0.6893, expected 0.7421 |
| `Cohort Query > should slice cohort evidence correctly for a narrower cohort() window` | `p.evidence.mean` is `undefined` |
| `Window Query > should produce param pack with correct fields from window slice` | `p.mean` = 0.4615, expected 0.689 |
| `Window Query > should aggregate correctly for a narrower window inside the stored slice` | `p.evidence.mean` is `undefined` |
| `Window Query > should aggregate correctly when window extends beyond stored slice dates` | `p.evidence.mean` is `undefined` |
| `Context Query > should produce param pack with correct fields from context-filtered slice` | `p.mean` = 0.7586, expected 0.7681 |
| `Param Pack Key Format > should use correct HRN key format...` | Missing `e.checkout-to-payment.p.stdev` property |

### Patterns Observed (regression symptoms)

1. **`p.evidence.mean` undefined** — Evidence stats not being populated in param pack (4 tests)
2. **`p.mean` value mismatch** — Blended probability calculation differs from expected (3 tests)
3. **`p.stdev` missing** — Standard deviation not included in param pack output (1 test)

### Root Cause Summary (as of 14-Dec-25)

These failures are most consistent with:

1. **Window vs cohort semantics being conflated** in the refactored topo/LAG pass (window queries accidentally consulting cohort-shaped data).
2. **Evidence and stdev propagation gaps** (scenario-visible `p.evidence.*` and `p.stdev` missing from the edge/pack when evidence exists).

The refactor that introduced a single graph-level topo pass is valuable, but the semantics must be made explicit:

- Baseline `window()` (whole/pinned ~90d) is the source of forecast and lag priors.
- Query `window(start:end)` (user-selected) is the source of evidence and window-mode completeness.
- Query `cohort(anchor,start:end)` is the source of cohort-mode evidence and cohort-mode completeness (with upstream delay adjustment).

### Recommended Action (Phase 1)

Treat these as Phase 1 blockers. The fixes should follow the semantics contract:

- Baseline `window()` vs query `window(start:end)` separation.
- Window-mode evidence/completeness must not be driven by A-anchored cohort slices.
- Evidence should be absent only where evidence truly does not exist (rebalanced/model-only edges), and present otherwise.
- `p.stdev` and `p.evidence.*` must reliably propagate into scenario param packs when present on the edge.

---

## Overview

Replace implicit latency enablement (via `maturity_days` presence) with explicit fields supporting user overrides. Introduce `latency_edge` boolean, add `*_overridden` companions to `t95` and `path_t95`, and eliminate all `maturity_days` usage.

## Relationship to Window/Cohort LAG Semantics (Conceptual Integration)

This work is a **Phase 2** dependency of the window/cohort semantics correction:

- The semantics correction requires robust horizon primitives for bounding/planning when cohort windows are immature (a common real-world use case).
- We explicitly do **not** want to deepen reliance on `maturity_days` for priors, because it is slated for deprecation.
- Phase 2 provides persisted/overridable `t95` and `path_t95` so:
  - `t95` can serve as the canonical, user-auditable horizon when empirical lag data is sparse or heterogeneous.
  - `path_t95` remains primarily a retrieval/bounding primitive and a cohort-vs-window targeting signal (it is not a proxy for upstream medians in completeness).

---

## Phase 0: Schema & Types

Add new fields to all type definitions before any runtime changes.

### 0.1 TypeScript Types

**File:** `graph-editor/src/types/index.ts`

- Add `latency_edge?: boolean` to edge latency config interface
- Add `t95_overridden?: boolean` to latency config
- Add `path_t95_overridden?: boolean` to latency config

### 0.2 Parameter Schema

**File:** `graph-editor/public/param-schemas/parameter-schema.yaml`

- Add `latency_edge` boolean field to latency block
- Add `t95_overridden` boolean field
- Add `path_t95_overridden` boolean field

### 0.3 Python Pydantic Models

**File:** `graph-editor/lib/graph_types.py`

- Add `latency_edge: Optional[bool]` to LatencyConfig model
- Add `t95_overridden: Optional[bool]`
- Add `path_t95_overridden: Optional[bool]`

### 0.4 Graph Builder (Python)

**File:** `graph-editor/lib/runner/graph_builder.py`

- Extract and emit `latency_edge` in latency payloads
- Extract and emit override flags

---

## Phase 1: Constants & Default Injection

Establish single source of truth for the default t95 value.

### 1.0 Consolidate statistical constants (single source of truth)

**Requirement (approved):** all statistics-related constants must live in exactly one place. Maintaining two files that both contain statistical constants is not acceptable.

**Files:**
- `graph-editor/src/constants/statisticalConstants.ts` (canonical home for all statistical constants)
- `graph-editor/src/constants/latency.ts` (must not contain statistical constants after consolidation)

**Work:**
- Move any statistical constants currently defined outside `statisticalConstants.ts` into `statisticalConstants.ts`.
- Update all imports to reference the single canonical file.
- Leave `latency.ts` only for non-statistics latency-related constants (if any remain).

### 1.1 Define Default Constant

**File:** `graph-editor/src/constants/statisticalConstants.ts` (single source of truth for stats constants)

- Add `DEFAULT_T95_DAYS = 30` constant
- Document its purpose (conservative default for first enablement)

### 1.2 Default Injection Logic

**File:** `graph-editor/src/services/UpdateManager.ts`

- When `latency_edge` transitions to `true`:
  - If `t95_overridden` is false and `t95` is missing/invalid, set `t95 = DEFAULT_T95_DAYS`
  - Mark parameter dirty so the default persists

---

## Phase 2: Override Semantics in UpdateManager

Implement write-back gating based on override flags.

### 2.1 Override Flag Wiring

**File:** `graph-editor/src/services/UpdateManager.ts`

- Read `t95_overridden` from stored parameter data into edge parameter view
- Read `path_t95_overridden` from stored parameter data into edge parameter view
- When writing derived `t95` back to parameter data: skip if `t95_overridden` is true
- When writing derived `path_t95` back to parameter data: skip if `path_t95_overridden` is true

### 2.2 LAG Pipeline Respect for Overrides

**File:** `graph-editor/src/services/statisticalEnhancementService.ts`

- Before writing computed `t95`: check `t95_overridden` flag, skip write if true
- Before writing computed `path_t95`: check `path_t95_overridden` flag, skip write if true

**File:** `graph-editor/src/services/fetchDataService.ts`

- When applying topo `path_t95`: respect `path_t95_overridden` flag

---

## Phase 3: Migrate Enablement Checks (maturity_days → latency_edge)

Replace all "is latency enabled?" checks.

### 3.1 Fetch/Refetch Policy

**File:** `graph-editor/src/services/fetchRefetchPolicy.ts`

- Replace `latencyConfig.maturity_days` presence check with `latencyConfig.latency_edge === true`

### 3.2 Data Operations Service

**File:** `graph-editor/src/services/dataOperationsService.ts`

- Replace `maturity_days` enablement checks with `latency_edge`

### 3.3 Graph Param Extractor

**File:** `graph-editor/src/services/GraphParamExtractor.ts`

- Extract `latency_edge` field alongside other latency fields

### 3.4 Integrity Check Service

**File:** `graph-editor/src/services/integrityCheckService.ts`

- Update latency integrity checks to use `latency_edge`

---

## Phase 4: Migrate Horizon Usages (maturity_days → t95/path_t95)

Replace all horizon value reads.

### 4.1 Statistical Enhancement Service

**File:** `graph-editor/src/services/statisticalEnhancementService.ts`

- Remove `maturity_days` fallback in `computePathT95()` — use only `t95`
- Remove any `maturity_days` references in LAG calculations

#### 4.1.a Implement “t95 tail constraint” for completeness CDF (fat-tail safety)

**Design reference:** `docs/current/project-lag/t95-fix.md` (section “t95 tail constraint”)

**Goal:** prevent thin-tail completeness on fat-tailed edges, which can cause systematic mis-blending of `p.mean`.

**Implementation scope (explicit):**

- This affects the distribution used for **completeness CDF evaluation** (`p.latency.completeness`) and therefore indirectly affects blending weights.
- It must not change the meaning of `t95/path_t95` as horizon primitives; it only ensures completeness does not contradict the authoritative `t95`.

**Concrete work:**

- Add a helper in `statisticalEnhancementService.ts` that produces the lognormal CDF parameters used for completeness:
  - inputs: `median_lag_days`, `mean_lag_days`, authoritative `t95`, and `LATENCY_T95_PERCENTILE`
  - output: `{ mu, sigma }` where `sigma` is `max(sigma_moments, sigma_min_from_t95)` with guard rails
- Ensure the completeness calculation path uses this constrained `{ mu, sigma }` whenever:
  - `median_lag_days` is valid, and
  - `t95` is present and valid (including user-overridden values)
- Add session logging (via `sessionLogService`) for cases where the constraint is applied, including:
  - `median_lag_days`, `mean_lag_days`, `t95`, `sigma_moments`, `sigma_min_from_t95`, `sigma_final`
  - so we can diagnose fat-tail protection behaviour in the field.

### 4.2 Cohort Retrieval Horizon

**File:** `graph-editor/src/services/cohortRetrievalHorizon.ts`

- Remove `maturity_days` fallback — use `path_t95` then `t95` then `DEFAULT_T95_DAYS`

### 4.3 Window Fetch Planner

**File:** `graph-editor/src/services/windowFetchPlannerService.ts`

- Remove `maturity_days` from `GraphForPath` representation
- Use only `t95` for path computation inputs

### 4.4 Fetch Data Service

**File:** `graph-editor/src/services/fetchDataService.ts`

- Remove `maturity_days` from `GraphForPath` representation
- Use only `t95` for path computation and application

### 4.5 DSL Query Builder (Amplitude cs)

**File:** `graph-editor/src/lib/das/buildDslFromEdge.ts`

- Remove `maturity_days` from `queryPayload.cohort`
- Use `path_t95` → `t95` → `DEFAULT_T95_DAYS` fallback chain for cohort conversion window
- Stop writing `cohort.maturity_days` in the query payload

### 4.x Window() conversion window policy (Amplitude cs)

**Design requirement:** all `window()` queries to Amplitude must set a fixed conversion window `cs = 30 days` to avoid accidental censoring when building baseline window slices used for lag summaries and `t95` derivation.

- Use `DEFAULT_T95_DAYS = 30` as the single source of truth for this value.

### 4.6 Window Aggregation Service

**File:** `graph-editor/src/services/windowAggregationService.ts`

- Replace any `maturity_days` references with `t95` or `path_t95`

---

## Phase 5: UI Controls

Add user-facing controls for override management.

### 5.1 Properties Panel / Latency Section

**File:** `graph-editor/src/components/ParameterSection.tsx` (or latency-specific component)

- Display `t95` with editable input
- Display `path_t95` with editable input
- Add toggle/checkbox for "Override" per field
- Setting a value should set the corresponding `*_overridden` flag to true
- Add "Revert to derived" action that clears the override flag

### 5.2 Conversion Edge Display

**File:** `graph-editor/src/components/edges/ConversionEdge.tsx`

- Remove `maturity_days` UI fallback
- Use `t95` or derived lag display values only

---

## Phase 6: Adapter & Connections Config

Update the Amplitude adapter config.

### 6.1 Connections YAML

**File:** `graph-editor/public/defaults/connections.yaml`

- Remove `cohort.maturity_days` references
- Update to use appropriate horizon field if needed by adapter

---

## Phase 7: Tests

Update and add tests for new behaviour.

### 7.1 Override Precedence Tests

**File:** `graph-editor/src/services/__tests__/statisticalEnhancementService.test.ts`

- Test: derived computation does not overwrite `t95` when `t95_overridden` is true
- Test: derived computation does not overwrite `path_t95` when `path_t95_overridden` is true

#### 7.1.a Tail constraint tests (completeness CDF respects authoritative t95)

**File:** `graph-editor/src/services/__tests__/statisticalEnhancementService.test.ts`

Required scenarios (prose expectations):

- When `t95` is larger than what the moment-fit would imply, sigma is inflated and completeness decreases for young cohorts.
- When `t95` is smaller than implied, we do not deflate sigma (tail constraint is one-way).
- Guard rails: missing/invalid `t95` or `median_lag_days` means no constraint application.
- Overridden `t95` must be treated as authoritative for the constraint (no mixing).

### 7.2 Default Injection Tests

**File:** `graph-editor/src/services/__tests__/UpdateManager.test.ts` (or new file)

- Test: enabling `latency_edge` injects `DEFAULT_T95_DAYS` when `t95` is missing
- Test: enabling `latency_edge` does not inject default when `t95_overridden` is true

### 7.3 Path T95 Computation Tests

**File:** `graph-editor/src/services/__tests__/pathT95Computation.test.ts`

- Remove/update tests that rely on `maturity_days` fallback
- Add tests for `t95`-only accumulation

### 7.4 Fetch Policy Tests

**Files:**
- `graph-editor/src/services/__tests__/fetchRefetchPolicy.test.ts`
- `graph-editor/src/services/__tests__/fetchRefetchPolicy.branches.test.ts`
- `graph-editor/src/services/__tests__/fetchPolicyIntegration.test.ts`

- Update enablement checks to use `latency_edge`
- Remove `maturity_days` from test fixtures

### 7.5 DSL Builder Tests

**File:** `graph-editor/src/lib/das/__tests__/buildDslFromEdge.cohortAnchor.test.ts`

- Update tests to verify `path_t95` → `t95` → `DEFAULT_T95_DAYS` fallback
- Remove `maturity_days` from test scenarios

### 7.6 Cohort Horizon Tests

**File:** `graph-editor/src/services/__tests__/cohortRetrievalHorizon.test.ts`

- Update horizon fallback tests to not include `maturity_days`

### 7.7 Python Tests

**File:** `graph-editor/lib/tests/test_lag_fields.py`

- Add tests for `latency_edge` field extraction
- Add tests for override flag extraction

---

## Phase 8: Documentation & Cleanup

### 8.1 Glossary

**File:** `graph-editor/public/docs/glossary.md`

- Add `latency_edge` definition
- Update `t95` and `path_t95` definitions to mention overrides
- Mark `maturity_days` as deprecated or remove

### 8.2 LAG Statistics Reference

**File:** `graph-editor/public/docs/lag-statistics-reference.md`

- Document override behaviour
- Update horizon descriptions
- Add the canonical description of the “t95 tail constraint” and how it affects completeness and blending (post-implementation statement of system operation).

### 8.3 Constants Documentation

**Files:**
- `graph-editor/src/constants/statisticalConstants.ts` (single source of truth)

- Update comments to reflect new field usage
- Remove `maturity_days` references

### 8.5 (Removed) Consolidate statistical constants

This work is executed in **Phase 1.0** to ensure the rest of the migration only has one constants source of truth.

### 8.4 Schema Cleanup (Optional)

**File:** `graph-editor/public/param-schemas/parameter-schema.yaml`

- Consider marking `maturity_days` as deprecated
- Or remove entirely if no backward compatibility needed

---

## Implementation Checklist

### Phase 0: Schema & Types
- [ ] 0.1 TypeScript types — add `latency_edge`, `t95_overridden`, `path_t95_overridden`
- [ ] 0.2 Parameter schema YAML — add new fields
- [ ] 0.3 Python Pydantic models — add new fields
- [ ] 0.4 Graph builder — extract new fields

### Phase 1: Constants & Defaults
- [ ] 1.0 Consolidate statistical constants into `graph-editor/src/constants/statisticalConstants.ts`
- [ ] 1.1 Define `DEFAULT_T95_DAYS = 30` constant
- [ ] 1.2 Default injection logic in UpdateManager

### Phase 2: Override Semantics
- [ ] 2.1 Override flag wiring in UpdateManager
- [ ] 2.2 LAG pipeline respects overrides (statisticalEnhancementService, fetchDataService)

### Phase 3: Migrate Enablement Checks
- [ ] 3.1 fetchRefetchPolicy.ts
- [ ] 3.2 dataOperationsService.ts
- [ ] 3.3 GraphParamExtractor.ts
- [ ] 3.4 integrityCheckService.ts

### Phase 4: Migrate Horizon Usages
- [ ] 4.1 statisticalEnhancementService.ts — remove maturity_days fallback
- [ ] 4.2 cohortRetrievalHorizon.ts — remove maturity_days fallback
- [ ] 4.3 windowFetchPlannerService.ts — remove maturity_days from GraphForPath
- [ ] 4.4 fetchDataService.ts — remove maturity_days from GraphForPath
- [ ] 4.5 buildDslFromEdge.ts — use t95/path_t95 for cohort cs
- [ ] 4.6 windowAggregationService.ts — update maturity_days references

### Phase 5: UI Controls
- [ ] 5.1 Properties panel — add override inputs
- [ ] 5.2 ConversionEdge — remove maturity_days fallback

### Phase 6: Adapter Config
- [ ] 6.1 connections.yaml — remove maturity_days references

### Phase 7: Tests
- [ ] 7.1 Override precedence tests
- [ ] 7.2 Default injection tests
- [ ] 7.3 pathT95Computation tests
- [ ] 7.4 Fetch policy tests
- [ ] 7.5 DSL builder tests
- [ ] 7.6 Cohort horizon tests
- [ ] 7.7 Python tests

### Phase 8: Documentation
- [ ] 8.1 Glossary updates
- [ ] 8.2 LAG statistics reference updates
- [ ] 8.3 Constants documentation
- [ ] 8.4 Schema cleanup (optional)

---

## Notes

- Execute phases in order — schema changes must land before runtime changes
- Run relevant tests after each phase, not the full suite
- Phases 3 and 4 can be done file-by-file to reduce blast radius
- Phase 5 (UI) can be deferred if time-constrained — the backend will work without UI override controls

