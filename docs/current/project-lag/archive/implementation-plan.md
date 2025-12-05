# Project LAG: Implementation Plan

**Status:** Active  
**Created:** 2-Dec-25  
**Last Updated:** 2-Dec-25  

---

## Overview

This document provides a **sequenced, phased implementation plan** for Project LAG (Latency-Aware Graph Analytics).

**Canonical Design Documents:**
- `design.md` — Full technical design, data models, algorithms
- `open-issues.md` — Design gaps requiring resolution before implementation

The goal is to get a minimal working implementation live as quickly as possible, then iterate.

---

## Phase 0: Foundation (Pre-requisites)

Before we can show mature vs forecast visually, we need basic schema and computation infrastructure.

### 0.1 Schema Changes

| Task | Files | Design Ref | Status |
|------|-------|------------|--------|
| Add `LatencyConfig` interface to TypeScript | `src/types/index.ts` | `design.md §3.1` | ✅ |
| Add `latency` field to `GraphEdge` interface | `src/types/index.ts` | `design.md §3.1` | ✅ |
| Add `LatencyConfig` to Python Pydantic model | `graph-editor/lib/graph_types.py` | `design.md §9.G` | ✅ |
| Add `latency` field to JSON schema | `public/schemas/conversion-graph-1.1.0.json` | `design.md §9.G` | ⚠️ NEEDS DESIGN |
| Add latency fields to parameter schema | `public/param-schemas/parameter-schema.yaml` | `design.md §3.2`, `§9.E` | ✅ |
| Update parameter UI schema for new fields | `public/ui-schemas/parameter-ui-schema.json` | — | ❌ NO DESIGN |
| Add `latency` to `EdgeParamDiff` in scenarios | `src/types/scenarios.ts` | `design.md §9.J` | ⚠️ NEEDS DESIGN |

**Open Issues:** `open-issues.md GAP-1` (default maturity_days value)

**Design Gaps:**
- **JSON Schema for conversion-graph**: `design.md §9.G` mentions the file but doesn't specify the JSON schema structure
- **UI Schema for parameters**: No design coverage for how latency fields appear in generic form editors
- **EdgeParamDiff structure**: `design.md §9.J` mentions adding latency but doesn't specify override semantics

### 0.2 Rename cost_time → labour_cost (Optional)

| Task | Files | Design Ref | Status |
|------|-------|------------|--------|
| Global search/replace `cost_time` → `labour_cost` | ~149 files | `design.md §3.3` | ✅ |

This is a hygiene item that can be done anytime. Recommend deferring to Phase 2 unless blocking.

### 0.3 Scenario System Integration & Validation

| Task | Files | Design Ref | Status |
|------|-------|------------|--------|
| Update composition logic to copy `latency` object | `src/services/CompositionService.ts` | `design.md §9.J` | ⚠️ NEEDS DESIGN |
| Add `latency` scope to parameter pack DSL | `src/services/ParamPackDSLService.ts` | — | ❌ NO DESIGN |
| Ensure `EdgeParamDiff` includes `latency` | `src/types/scenarios.ts` | `design.md §9.J` | ⚠️ NEEDS DESIGN |
| Add `latency` extraction logic | `src/services/GraphParamExtractor.ts` | — | ❌ NO DESIGN |
| Add `latency` validation to Scenario Validator | `src/services/ScenarioValidator.ts` | — | ❌ NO DESIGN |
| Add `latency` checks to Integrity Service | `src/services/integrityCheckService.ts` | — | ❌ NO DESIGN |
| Verify schema consistency | `src/services/__tests__/schemaTypesConsistency.test.ts` | — | ❌ NO DESIGN |

**Open Issues:** `open-issues.md GAP-7` (scenario override semantics)

**Design Gaps:**
- **CompositionService**: No design for how `latency` is merged during scenario composition
- **ParamPackDSL**: No design for `latency` scope in parameter pack expressions
- **GraphParamExtractor**: No design for extracting latency from graph for scenario creation
- **Validation rules**: No design for what constitutes valid/invalid latency configuration
- **Integrity checks**: No design for latency-related integrity checks

---

## Phase 1: Core Data Flow

**Goal:** Store and compute mature/immature split from existing daily data.

### 1.1 Extract dayMedianTransTimes from Amplitude

| Task | Files | Design Ref | Status |
|------|-------|------------|--------|
| Add `dayMedianTransTimes` extraction to Amplitude adapter | `public/defaults/connections.yaml` | `design.md §4.4`, `Appendix A` | ✅ |
| Add `median_trans_times_ms` to response transform | `public/defaults/connections.yaml` | `design.md §9.E` | ✅ |
| Store in parameter file on fetch | `src/services/windowAggregationService.ts` | `design.md §9.D` | ⚠️ NEEDS DESIGN |

**Design Gaps:**
- **Storage location**: `design.md §9.D` describes conceptual change but doesn't specify exact storage format in windowAggregationService

### 1.2 Compute Mature/Immature Split

| Task | Files | Design Ref | Status |
|------|-------|------------|--------|
| Add `computeMatureImmatureSplit()` function | `src/services/windowAggregationService.ts` | `design.md §5.0` | ✅ |
| Define `MatureImmatureSplit` interface | `src/services/windowAggregationService.ts` | `design.md §5.0` | ✅ |
| Store split result in parameter value entry | `src/services/paramRegistryService.ts` | `design.md §9.E` | ⚠️ NEEDS DESIGN |
| Update `ParameterValue` interface | `src/services/paramRegistryService.ts` | `design.md §3.2` | ⚠️ NEEDS DESIGN |

**Open Issues:** `open-issues.md GAP-1` (default maturity_days value)

**Design Gaps:**
- **ParameterValue interface**: `design.md §3.2` shows YAML structure but not TypeScript interface update
- **Storage in paramRegistryService**: No explicit design for how split result is stored

### 1.3 Push Maturity Data to Graph Edge

| Task | Files | Design Ref | Status |
|------|-------|------------|--------|
| Add `maturity_coverage` to edge p.evidence | `src/services/UpdateManager.ts` | `design.md §9.F` | ⚠️ NEEDS DESIGN |
| Add `median_lag_days` to edge | `src/services/UpdateManager.ts` | `design.md §9.F` | ⚠️ NEEDS DESIGN |
| Define UpdateManager mappings for latency fields | `src/services/UpdateManager.ts` | `design.md §9.F` | ⚠️ NEEDS DESIGN |

**Design Gaps:**
- **UpdateManager mappings**: `design.md §9.F` lists conceptual mappings but doesn't specify exact config format
- **Evidence structure**: No design for how `maturity_coverage` fits into existing `p.evidence` structure

---

## Phase 2: Edge Rendering & UI

**Goal:** Visually distinguish mature (solid) from forecast (hatched) edge width, and expose data via beads/tooltips.

### 2.1 Edge Data Model for Rendering

| Task | Files | Design Ref | Status |
|------|-------|------------|--------|
| Define `EdgeLatencyDisplay` interface | `src/components/edges/ConversionEdge.tsx` | `design.md §7.2` | ✅ |
| Add `maturity_coverage` to `ConversionEdgeData` | `src/components/edges/ConversionEdge.tsx` | `design.md §7.2` | ✅ |
| Pass `maturity_coverage` through `buildScenarioRenderEdges` | `src/components/canvas/buildScenarioRenderEdges.ts` | — | ❌ NO DESIGN |
| Add `latency` data to edge `data` prop | `src/components/GraphCanvas.tsx` | — | ❌ NO DESIGN |

**Design Gaps:**
- **buildScenarioRenderEdges**: No design for how latency data flows through scenario edge builder
- **GraphCanvas prop threading**: No design for how latency data is passed to edge components

### 2.2 Two-Layer Edge Rendering

| Task | Files | Design Ref | Status |
|------|-------|------------|--------|
| Add SVG stripe pattern definitions | `src/components/edges/ConversionEdge.tsx` | `design.md §7.1` | ⚠️ NEEDS DESIGN |
| Implement two-layer rendering (inner=mature, outer=total) | `src/components/edges/ConversionEdge.tsx` | `design.md §7.1` | ✅ |
| Offset stripe pattern for solid-appearance overlap | `src/components/edges/ConversionEdge.tsx` | `design.md §7.1` | ✅ |
| Add stripe pattern to `nodeEdgeConstants.ts` | `src/lib/nodeEdgeConstants.ts` | `design.md §9.H` | ⚠️ NEEDS DESIGN |

**Open Issues:** `open-issues.md GAP-8` (stripe pattern visual constants)

**Design Gaps:**
- **SVG pattern definition**: `design.md §7.1` describes concept but not SVG implementation
- **nodeEdgeConstants**: `design.md §9.H` mentions file but doesn't specify constant values

### 2.3 Add View Preference Toggle

| Task | Files | Design Ref | Status |
|------|-------|------------|--------|
| Add `showMaturitySplit` to ViewPreferences | `src/contexts/ViewPreferencesContext.tsx` | — | ❌ NO DESIGN |
| Wire toggle in ViewMenu | `src/components/ViewMenu.tsx` | — | ❌ NO DESIGN |

**Open Issues:** `open-issues.md GAP-2` (view preference toggle design)

**Design Gaps:**
- **ViewPreferences**: No design for toggle name, default state, or persistence
- **ViewMenu**: No design for UI placement or label

### 2.4 Edge Bead & Tooltip Updates

| Task | Files | Design Ref | Status |
|------|-------|------------|--------|
| Add `latency` bead type definition | `src/components/edges/edgeBeadHelpers.tsx` | `design.md §9.H` | ⚠️ NEEDS DESIGN |
| Extract latency data from scenarios | `src/components/edges/edgeBeadHelpers.tsx` | — | ❌ NO DESIGN |
| Render latency bead (icon + median days) | `src/components/edges/EdgeBeads.tsx` | `design.md §9.H` | ⚠️ NEEDS DESIGN |
| Add Latency section to edge tooltip | `src/components/edges/ConversionEdge.tsx` | `design.md §7.2` | ⚠️ NEEDS DESIGN |

**Open Issues:**
- `open-issues.md GAP-3` (bead content format)
- `open-issues.md GAP-5` (tooltip content structure)

**Design Gaps:**
- **Bead definition**: `design.md §9.H` mentions beads but doesn't specify bead type structure
- **Scenario extraction**: No design for how latency data is extracted for bead display
- **Tooltip layout**: `design.md §7.2` lists fields but not layout/format

---

## Phase 3: DSL Changes (cohort())

**Goal:** Add `cohort()` DSL clause for explicit cohort-mode queries.

### 3.1 DSL Parsing

| Task | Files | Design Ref | Status |
|------|-------|------------|--------|
| Add `cohort()` to `QUERY_FUNCTIONS` | `src/lib/queryDSL.ts` | `design.md §4.1` | ✅ |
| Parse `cohort(start:end)` similar to `window()` | `src/lib/queryDSL.ts` | `design.md §4.1` | ✅ |
| Parse `cohort(anchor,start:end)` with optional anchor | `src/lib/queryDSL.ts` | `design.md §4.2` | ✅ |
| Add `cohort` to `ParsedConstraints` interface | `src/lib/queryDSL.ts` | `open-issues.md GAP-10` | ✅ |
| Update `normalizeConstraintString()` | `src/lib/queryDSL.ts` | `open-issues.md GAP-10` | ✅ |
| Update DSL JSON Schema | `public/schemas/query-dsl-1.1.0.json` (new version) | `open-issues.md GAP-11` | ✅ |

**Design Gaps:** ✅ All resolved (see `open-issues.md GAP-10, GAP-11`)

### 3.2 DSL Construction

| Task | Files | Design Ref | Status |
|------|-------|------------|--------|
| Add `cohort()` generation in `buildDslFromEdge.ts` | `src/lib/das/buildDslFromEdge.ts` | `design.md §9.A` | ✅ |
| Default to `cohort()` for edges with `latency.track: true` | `src/lib/das/buildDslFromEdge.ts` | `design.md §9.A` | ✅ |
| Update `dslConstruction.ts` for cohort() | `src/lib/dslConstruction.ts` | `design.md §9.A` | ⚠️ NEEDS DESIGN |

**Design Gaps:**
- **dslConstruction.ts**: `design.md §9.A` mentions file but doesn't specify implementation

### 3.3 Adapter Integration

| Task | Files | Design Ref | Status |
|------|-------|------------|--------|
| Handle `cohort` vs `window` mode in adapter | `public/defaults/connections.yaml` | `design.md §9.B` | ✅ |
| Extend observation window by maturity_days | `public/defaults/connections.yaml` | `design.md §9.B` | ⚠️ NEEDS DESIGN |
| Pass cohort dates to Amplitude API | `public/defaults/connections.yaml` | `design.md §9.B` | ✅ |

**Open Issues:** `open-issues.md GAP-6` (observation window extension semantics)

**Design Gaps:**
- **Observation window extension**: `design.md §9.B` mentions concept but exact semantics unclear

### 3.4 Window Selector UI

| Task | Files | Design Ref | Status |
|------|-------|------------|--------|
| Add "Mode" toggle (Events/Cohort) | `src/components/WindowSelector.tsx` | — | ❌ NO DESIGN |
| Update `buildDSLFromState` for cohort() | `src/components/WindowSelector.tsx` | — | ❌ NO DESIGN |
| Support parsing existing `cohort()` DSL | `src/components/WindowSelector.tsx` | — | ❌ NO DESIGN |

**Open Issues:** `open-issues.md GAP-4` (Window Selector cohort mode UI)

**Design Gaps:**
- **WindowSelector**: No design for cohort mode UI at all

---

## Phase 4: Properties Panel

**Goal:** Display latency information when edge is selected.

### 4.1 Latency Display Section

| Task | Files | Design Ref | Status |
|------|-------|------------|--------|
| Add new `CollapsibleSection` for "Latency" | `src/components/PropertiesPanel.tsx` | `design.md §9.I` | ⚠️ NEEDS DESIGN |
| Conditional rendering (Conversion edges only) | `src/components/PropertiesPanel.tsx` | — | ❌ NO DESIGN |
| Display: median lag, maturity coverage | `src/components/PropertiesPanel.tsx` | `design.md §7.2` | ⚠️ NEEDS DESIGN |
| Display: mature vs forecast k | `src/components/PropertiesPanel.tsx` | `design.md §7.2` | ⚠️ NEEDS DESIGN |
| Add `latency.track` toggle | `src/components/PropertiesPanel.tsx` | — | ❌ NO DESIGN |

**Open Issues:** `open-issues.md GAP-9` (Properties Panel layout)

**Design Gaps:**
- **Section structure**: `design.md §9.I` mentions panel but doesn't specify section layout
- **Conditional rendering**: No design for when latency section appears
- **Track toggle**: No design for toggle placement or behavior

---

## Design Coverage Summary

### Legend
- ✅ = Design exists and is sufficient
- ⚠️ = Design exists but needs more detail
- ❌ = No design coverage

### By Phase

| Phase | Tasks | ✅ Covered | ⚠️ Partial | ❌ Missing |
|-------|-------|-----------|-----------|-----------|
| 0.1 Schema | 7 | 3 | 3 | 1 |
| 0.2 Rename | 1 | 1 | 0 | 0 |
| 0.3 Scenarios | 7 | 0 | 2 | 5 |
| 1.1 Extract | 3 | 2 | 1 | 0 |
| 1.2 Compute | 4 | 2 | 2 | 0 |
| 1.3 Push | 3 | 0 | 3 | 0 |
| 2.1 Edge Data | 4 | 2 | 0 | 2 |
| 2.2 Two-Layer | 4 | 2 | 2 | 0 |
| 2.3 View Toggle | 2 | 0 | 0 | 2 |
| 2.4 Beads/Tooltips | 4 | 0 | 3 | 1 |
| 3.1 DSL Parsing | 6 | 3 | 0 | 3 |
| 3.2 DSL Construction | 3 | 2 | 1 | 0 |
| 3.3 Adapter | 3 | 2 | 1 | 0 |
| 3.4 Window Selector | 3 | 0 | 0 | 3 |
| 4.1 Properties | 5 | 0 | 3 | 2 |
| **TOTAL** | **59** | **19 (32%)** | **21 (36%)** | **19 (32%)** |

### Design Extensions Needed

The following sections need to be added or extended in `design.md`:

1. **§3.4 JSON Schema for Conversion Graph** — Specify `latency` field in JSON schema format
2. **§3.5 Parameter UI Schema** — Specify how latency fields appear in generic form editors
3. **§9.J.1 Scenario Composition Rules** — Specify how `latency` is merged/overridden
4. **§9.J.2 Scenario Validation Rules** — Specify what constitutes valid latency config
5. **§9.J.3 Integrity Check Rules** — Specify latency-related integrity checks
6. **§9.E.1 ParameterValue Interface** — TypeScript interface for latency storage
7. **§9.F.1 UpdateManager Mapping Config** — Exact mapping configuration format
8. **§7.1.1 SVG Pattern Implementation** — SVG code for stripe patterns
9. **§7.3 View Preferences** — Toggle design for maturity split display
10. **§7.4 Edge Bead Design** — Bead type, icon, format for latency
11. **§7.5 Tooltip Layout** — Exact layout and formatting for latency tooltip
12. **§4.1.1 DSL Schema Changes** — JSON schema updates for `cohort()` clause
13. **§4.1.2 ParsedConstraints Interface** — TypeScript interface changes
14. **§7.6 Window Selector Cohort Mode** — UI design for mode switching
15. **§7.7 Properties Panel Latency Section** — Layout and controls

---

## Minimal Viable Iteration

### MVP-1: Compute & Display (No DSL Changes)

1. **Schema:** Add `LatencyConfig` to edge types & scenarios (Phase 0.1, 0.3)
2. **Extract:** Add `dayMedianTransTimes` extraction (Phase 1.1)
3. **Compute:** Implement `computeMatureImmatureSplit()` using existing daily data (Phase 1.2)
4. **Store:** Add `maturity_coverage` to edge evidence (Phase 1.3)
5. **Render:** Two-layer edge rendering + Latency Beads (Phase 2.2, 2.4)

This skips DSL changes entirely. The existing `window()` queries already return daily data.

### MVP-2: Add DSL + Full Flow

Add Phases 3 and 4 for complete semantics and UI polish.

---

## Dependency Graph

```
Phase 0.1 (Schema) ──────┬──────────────────────────────────────────────┐
                         │                                              │
Phase 0.3 (Scenarios/Valid) ─┘                                          │
                                                                        │
Phase 1.1 (Extract dayMedianTransTimes) ──────┐                         │
                                               │                         │
Phase 1.2 (Compute mature/immature) ──────────┼── Phase 1.3 (Push to edge)
                                               │              │
                                               │              │
Phase 2.1 (Edge data model) ──────────────────┴──────────────┤
                                                              │
Phase 2.2 (Two-layer rendering) ─────────────────────────────┼── Phase 2.4 (Labels)
                                                              │
Phase 2.3 (View toggle) ─────────────────────────────────────┘

Phase 3.x (DSL) ────────┬── Phase 3.4 (WindowSelector)
                        │
                        └── Phase 3.3 (Adapter)

Phase 4.x (Properties Panel) ─── Requires Phase 1.3
```

---

## Effort Estimates

| Phase | Effort | Notes |
|-------|--------|-------|
| 0.1 Schema | 2-3h | Straightforward additions |
| 0.3 Scenarios | 2-3h | Integration points & validation |
| 1.1 Extract | 1-2h | Adapter config only |
| 1.2 Compute | 3-4h | Core algorithm |
| 1.3 Push to edge | 2-3h | UpdateManager mappings |
| 2.1 Edge data | 1h | Pass-through changes |
| 2.2 Two-layer render | 4-6h | SVG complexity |
| 2.3 View toggle | 1h | Boilerplate |
| 2.4 Edge Labels | 3-4h | New bead type + tooltip logic |
| 3.x DSL | 3-4h | Parsing + construction |
| 3.4 Window Selector | 2-3h | UI update for cohort mode |
| 4.x Properties | 3-4h | UI additions |

**Total MVP-1:** ~22-26h  
**Total Complete:** ~30-37h

---

## Testing Strategy

### Unit Tests
- `computeMatureImmatureSplit()` with various cohort scenarios
- DSL parsing for `cohort()` clause
- Edge width calculation with maturity_coverage
- Scenario composition logic handles `latency` correctly
- Validation logic catches invalid latency data

### Integration Tests
- End-to-end: Fetch → Store → Compute → Render
- Parameter file with latency data loads correctly
- Edge renders with correct layer widths
- Scenarios correctly preserve/override latency data
- Schema consistency tests pass with new fields

### Visual Testing
- Compare edge appearance: 100% mature, 50% mature, 0% mature
- Stripe pattern renders correctly at different zoom levels
- Latency bead appears and displays correct value
- Tooltip shows detailed maturity breakdown

---

## Open Questions

See `design.md §11` for acknowledged open questions not yet resolved:

1. Amplitude API rate limits
2. Stationarity assumption
3. Zero-lag edges
4. Multi-modal distributions
5. Heavy tails
6. Conditional edge interaction

---

*End of Implementation Plan*
