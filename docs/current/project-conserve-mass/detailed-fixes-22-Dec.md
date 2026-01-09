## Detailed Fixes Report — 22-Dec-25

This document summarises the fixes made during this session, why they were required, and what remains open.

### What was broken (high level)
- **Graph evidence semantics were unintelligible** in places because some “splits” were not actually MECE under Amplitude’s user-level funnel semantics, causing overlap and flow non-conservation symptoms.
- **E-mode reach computations could silently use blended probabilities** when evidence was missing, making results hard to reason about.
- **Fetch/session logging could report misleading success** even when individual items failed.
- **Evidence metadata and provenance (window bounds, retrieved time) were not persisted consistently**, especially for conditional probabilities (`conditional_p`).
- **Issues Viewer lacked a way to surface and filter semantic data problems** (non-conservation / non-MECE) for manual investigation.

### Fixes implemented

#### 1) Runner E-mode correctness (evidence-only transition layer)
- **Change**: In E mode, the Python runner no longer falls back to `p.mean` when `p.evidence.mean` is missing; missing evidence is treated as 0 for path maths, and complement mass is assigned to a single unambiguous absorbing failure/other edge when present.
- **Files**:
  - `graph-editor/lib/runner/graph_builder.py`
- **Result**: Evidence mode path calculations are now aligned with the “evidence should mean evidence” expectation.

#### 2) Blending logic (mature cohorts become evidence-driven)
- **Change**: Updated blend weighting so forecast influence decays smoothly to zero as completeness → 1 (no feature flags; old behaviour removed).
- **Files**:
  - `graph-editor/src/services/statisticalEnhancementService.ts`
- **Result**: For nearly-mature cohorts, `p.mean` is pulled strongly toward evidence instead of being dominated by forecast.

#### 3) Fetch failure reporting (degrade gracefully, but do not lie)
- **Change**: Direct fetch pipeline now propagates per-item failures correctly so batch summaries reflect true succeeded/failed counts, while continuing the overall batch (no whole-batch abort).
- **Files**:
  - `graph-editor/src/services/dataOperationsService.ts`
  - Test: `graph-editor/src/services/__tests__/dataOperationsService.directFetchFailurePropagation.test.ts`
- **Result**: Session logs and batch outcomes reflect real failures instead of “success with hidden errors”.

#### 4) Cohort conversion window coherence (`cs`)
- **Change**: Cohort conversion window selection is standardised at a graph-level maximum (clamped) to avoid denominator drift from inconsistent per-edge `cs`.
- **Files**:
  - `graph-editor/src/lib/das/buildDslFromEdge.ts`
  - `graph-editor/src/constants/latency.ts`
  - Test: `graph-editor/src/lib/das/__tests__/buildDslFromEdge.cohortGraphCs.test.ts`
- **Result**: Requests for the same cohort use consistent conversion windows across edges.

#### 5) `n_query` generation for MECE-split mechanics (exclude/minus/plus)
- **Change**: MSMDC now generates `n_query` for edges whose generated query contains `.exclude(` / `.minus(` / `.plus(` (unless the relevant override flags are set), using cohort semantics `from(anchor).to(fromNode)` so denominators remain coherent.
- **Files**:
  - `graph-editor/lib/msmdc.py`
  - `graph-editor/lib/api_handlers.py`
  - `graph-editor/src/lib/graphComputeClient.ts`
  - `graph-editor/src/services/queryRegenerationService.ts`
  - Test: `graph-editor/src/services/__tests__/queryRegenerationService.nQuery.test.ts`
- **Result**: When a split is intended to be MECE, the system has a consistent base-denominator query available (and respects overrides).

#### 6) Issues Viewer: semantic data issues + filtering
- **Change**: Added a new Issues category **`semantic`** to surface evidence non-conservation symptoms (denominator incoherence, inflow/outflow mismatch, impossible `k > n`).
- **Change**: Added a **category checklist dropdown** in the Issues Viewer so users can untick categories (e.g. hide `semantic`).
- **Change**: Fixed semantics where selecting **no categories** should show **no issues** (previously acted like “no filter”).
- **Files**:
  - `graph-editor/src/services/integrityCheckService.ts`
  - `graph-editor/src/services/graphIssuesService.ts`
  - `graph-editor/src/components/editors/GraphIssuesViewer.tsx`
  - `graph-editor/src/components/editors/GraphIssuesViewer.css`
  - Tests:
    - `graph-editor/src/services/__tests__/integrityCheckService.semanticEvidenceIssues.test.ts`
    - `graph-editor/src/services/__tests__/graphIssuesService.categoryFilter.test.ts`
- **Notes**: Semantic severities are thresholded (always at least `info`, promote to `warning`/`error` based on proportional thresholds). Threshold tuning is intentionally localised to `IntegrityCheckService`.

#### 7) Evidence window metadata persistence (including conditional probabilities)
This was the “#2” investigation: evidence window metadata was inconsistent (ISO vs UK) and conditional probabilities were not receiving window provenance updates at all.

- **Fix A (normalisation)**: Evidence `window_from/window_to` are normalised to UK `d-MMM-yy` in UpdateManager mappings.
  - Applies to **file → graph** and **external → graph** paths.
- **Fix B (conditional_p propagation)**:
  - `DataOperationsService` now passes `window_from/window_to/retrieved_at/source` when applying direct fetch results to `conditional_p`.
  - `DataOperationsService` also passes these fields when applying **file-derived** updates to `conditional_p`.
  - `UpdateManager.updateConditionalProbability` now accepts these evidence fields and normalises window bounds to UK.
- **Files**:
  - `graph-editor/src/services/UpdateManager.ts`
  - `graph-editor/src/services/dataOperationsService.ts`
  - Tests:
    - `graph-editor/src/services/__tests__/updateManager.externalToGraphEvidenceFields.test.ts`
    - `graph-editor/src/services/__tests__/updateManager.updateConditionalProbabilityEvidenceWindow.test.ts`
- **Result**: Evidence provenance is consistently stored and conditional probabilities no longer lag behind base edges.

### What remains open (as of end of session)
- **Graph semantics / MECE truth**:
  - Even with perfect retrieval and persistence, some splits are not MECE under Amplitude’s “user did event matching filter” semantics (users can satisfy both sides of a split).
  - Fixing this requires an explicit semantic choice (e.g. “first category only”, stable user property assignment, or a different modelling approach), not just query syntax.
- **Precision / representation**:
  - Evidence means are sometimes stored at limited precision (rounded). This is not a correctness issue for n/k, but can be confusing when comparing `mean` vs `k/n` exactly.
  - If desired, evidence `mean` can be treated as derived-only (render-time) rather than persisted.

### Tests added/updated (this session)
- Added:
  - `graph-editor/src/services/__tests__/dataOperationsService.directFetchFailurePropagation.test.ts`
  - `graph-editor/src/services/__tests__/integrityCheckService.semanticEvidenceIssues.test.ts`
  - `graph-editor/src/services/__tests__/graphIssuesService.categoryFilter.test.ts`
  - `graph-editor/src/services/__tests__/updateManager.updateConditionalProbabilityEvidenceWindow.test.ts`
  - `graph-editor/src/services/__tests__/updateManager.externalToGraphEvidenceFields.test.ts` (updated expectation to UK normalisation)
  - `graph-editor/src/services/__tests__/queryRegenerationService.nQuery.test.ts`
  - `graph-editor/src/lib/das/__tests__/buildDslFromEdge.cohortGraphCs.test.ts`

### Reference: key artefacts used for diagnosis
- `tmp5.log`: full resolved query payloads and built Amplitude URLs (used to confirm fetch windows and semantics).
- `test3.json`: persisted graph snapshot used to identify persistence inconsistencies and semantic overlaps.


