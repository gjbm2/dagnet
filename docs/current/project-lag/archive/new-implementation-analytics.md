## Project LAG: Analytics Extensions Implementation Plan (New)

**Status:** Draft planning document  
**Based on:** `design.md §8`, `open-issues.md (Analytics sections)`, `ANALYTICS_IMPLEMENTATION_STATUS.md`  
**Scope:** Post-core analytics features that consume latency-aware data (tables, charts, exports) without changing the core latency model or retrieval pipeline.

This document is prose-only and assumes the core latency implementation in `new-implementation-core.md` is in place.

---

## 1. Analytics Data Model and Schema Surfaces

**Design reference:** `design.md §8.1`, `ANALYSIS_RETURN_SCHEMA.md`, `ANALYTICS_IMPLEMENTATION_STATUS.md`.

### 1.1 TypeScript analytics types

**Code files to touch or extend:**

- `graph-editor/src/types/index.ts`  
  (extend existing analysis-related interfaces, or introduce shared latency-analysis structures)
- `graph-editor/src/types/analysis.ts` (if present) or a new analysis types file under `src/types`  
  (capture latency-specific structures such as mature vs immature breakdowns and per-cohort details, as described in the design)

### 1.2 Analysis output schema

**Code files to touch or extend:**

- `docs/current/project-contexts/ANALYSIS_RETURN_SCHEMA.md`  
  (document new latency-related fields in analysis outputs)
- `graph-editor/public/schemas/conversion-graph-*.json`  
  (only if analysis output references are captured in graph schemas; otherwise, refer to analysis-specific schemas)

Any schema changes here should be consistent with the latency concepts already defined for parameters and edges in the core implementation.

---

## 2. Analysis Generation and Export Path

**Design reference:** `design.md §8.1–8.2`, `DATA_RETRIEVAL_QUERIES.md`, `data-fetch-architecture.md`.

### 2.1 TS services that assemble analysis

**Code files to touch or extend:**

- `graph-editor/src/services/statisticalEnhancementService.ts`  
  (add functions that summarise latency-aware edge statistics for analytics views, building on the core probabilities and completeness values)
- `graph-editor/src/services/contextAggregationService.ts`  
  (extend any context-based aggregation to include latency metrics where relevant)
- `graph-editor/src/services/timeSeriesUtils.ts`  
  (reuse or extend helpers for generating time-indexed series used in charts)

### 2.2 Python analysis helpers and APIs

**Code files to touch or extend:**

- `graph-editor/lib/stats_enhancement.py`  
  (mirror any latency-aware aggregation used for analytics in Python, ensuring consistency with TS-side analytics)
- `graph-editor/lib/api_handlers.py`  
  (wire new analysis endpoints or extend existing ones to include latency analysis blocks, as per the design)

### 2.3 Tests and validation for analysis data

**Code files to touch or extend:**

- TS tests
  - `graph-editor/src/services/__tests__/statisticalEnhancementService.test.ts`
  - Any analysis-specific tests under `graph-editor/src/services/__tests__/` that validate analysis structures and exports
- Python tests
  - Relevant files under `graph-editor/lib/tests/` that check analysis payloads and latency-aware fields

---

## 3. Analytics Panel UI and Interaction

**Design reference:** `design.md §8.2`, `ANALYTICS_IMPLEMENTATION_STATUS.md`.

### 3.1 Analytics panel components

**Code files to touch or extend:**

- `graph-editor/src/components/AnalyticsPanel/` (directory as a whole)  
  (add or extend components to display cohort maturity tables, latency distribution charts, and scenario comparisons, respecting the evidence vs forecast split)
- `graph-editor/src/components/ScenarioOverlayRenderer.tsx`  
  (ensure any analytics overlays that depend on scenario state account for latency metrics)

### 3.2 Data wiring into the panel

**Code files to touch or extend:**

- `graph-editor/src/contexts/GraphStoreContext.tsx`  
  (ensure analysis results including latency metrics are stored and exposed to the panel)
- `graph-editor/src/hooks/useFetchData.ts`  
  (extend any analysis fetch flows to request latency-aware analysis where configured)

### 3.3 Exports and tabular views

**Code files to touch or extend:**

- `graph-editor/src/components/AnalyticsPanel/...` (specific table components)  
  (support explicit mature vs forecast columns and per-cohort detail as described in the design)
- Any CSV or JSON export utilities under `graph-editor/src/utils/` that deal with analysis exports

---

## 4. Documentation and User-Facing Behaviour

**Design reference:** `design.md §8`, `graph-editor/public/docs/user-guide.md`, `graph-editor/public/docs/query-expressions.md`.

**Code and docs to touch or extend:**

- `graph-editor/public/docs/user-guide.md`  
  (add brief explanations of latency-related analytics views, without restating the mathematical derivations)
- `graph-editor/public/docs/api-reference.md`  
  (document any new analysis endpoints or payload shapes that include latency fields)
- `graph-editor/public/docs/analysis-return-schema.md` (if present) or the corresponding analysis schema doc  
  (align user-facing documentation with the analysis schema and types updated earlier)

All analytics documentation should point back to `design.md §8` for conceptual grounding, rather than duplicating design details.


