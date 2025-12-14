# Window/Cohort LAG Correction Plan

**Created:** 14-Dec-25  
**Status:** Draft (awaiting approval)  
**Canonical spec:** `graph-editor/public/docs/lag-statistics-reference.md`  

---

## 1. Goal

Restore and enforce behaviour that matches the canonical LAG statistics reference, specifically:

- **Forecast** comes from the **whole baseline `window()` data** (merged/pinned baseline slice), independent of the user’s narrow selection.
- **Evidence** comes from the **user-selected date range**, using:
  - `window()` mode: **X-anchored cohorts** (entry dates at the edge source, X→Y).
  - `cohort()` mode: **A-anchored cohorts** (entry dates at the anchor, A→…→X→Y).
- **Completeness** is meaningful in both modes but is computed differently:
  - `window()` mode: **local to X→Y**, independent of A→X.
  - `cohort()` mode: **A→X journey time must be considered** before judging X→Y maturity.
- **p.mean** is the defensible blend of **narrow evidence** and **baseline forecast**, weighted by completeness and population as per the reference.

This work will be delivered in **two phases** that are conceptually integrated:

- **Phase 1 (Semantics + regressions):** Make `window()` vs `cohort()` behaviour correct and stable against the reference; restore missing scenario-visible fields (`p.stdev`, `p.evidence.*` where evidence exists); ensure the refactored topo pass matches the spec.
- **Phase 2 (Horizon primitives migration):** Implement parameter-level override fields for `t95` and `path_t95`, deprecate `maturity_days`, and update the Phase 1 logic to use `t95/path_t95` as the canonical horizon/fallback sources.

---

## 2. Non-goals

- No new statistical model family or new fitting approach.
- No UI changes in menus/components (services only).
- No changes to the graph schema in this plan (only behaviour/wiring).
- No “historical curiosity” semantics (“completed by end-of-window”) as the default.

---

## 3. Confirmed semantics (authoritative)

### 3.0 Critical distinction: Baseline `window()` vs Query `window()` (window-mode UX)

We must be explicit that **two different “window” concepts** exist and they serve different roles:

1. **Baseline `window()` (for forecast + priors)**  
   - Meaning: the pinned/merged “whole window baseline” for the edge/context (typically ~90 days).  
   - Purpose:
     - Provide `p.forecast.*` (baseline conversion probability, ideally mature/recency-weighted).
     - Provide stable lag-shape priors (`latency.median_lag_days`, `latency.mean_lag_days`) and stable horizon primitives (`t95`, `path_t95`) used for bounding/planning.
   - Importantly: baseline window data is **not** the user’s current selection; it is the reference dataset we lean on when evidence is immature.

2. **Query `window(start:end)` (for evidence + completeness in window mode)**  
   - Meaning: the user-selected **X-anchored cohorts** whose X-entry dates fall within `[start,end]`.  
   - Purpose:
     - Define `p.evidence.*` for the current view.
     - Define completeness “as-of now” for the cohorts in scope, using X→Y lag on the edge’s own terms (no A→X adjustment).
   - Importantly: query window is what varies when the user drags the window selector.

The system must never conflate these:

- The **baseline window** should not drift as a function of the user’s narrow query window.
- The **query window** should not be replaced by the baseline window (except when explicitly requested by a future “use baseline only” mode).

### 3.1 `window(start:end)` semantics (X-anchored, cohort-like)

- The `window()` clause selects **which X-entry cohorts are in-scope** (by entry date).
- Evidence uses the **most complete view available as-of now** for those cohorts:
  - Conversions may occur after `end`; they still count (we are interested in what HAS completed).
- Completeness is computed **as-of now** and **local to X→Y**:
  - Cohort age is `today - cohort_date` (days).
  - Effective age is the same as cohort age (no A→X adjustment).
  - Completeness is a weighted average of CDF values over cohort ages.
- Forecast baseline comes from the **whole baseline window slice** (merged/pinned baseline), not from the narrow selection.
- p.mean is blended from:
  - evidence from the narrow `window(start:end)` selection
  - forecast from the whole baseline window slice
  - weighted by completeness and population.

**Key assumption (for priors):** the baseline `window()` slice is wide (typically ~90 days) and therefore provides stable lag-shape summaries (`latency.median_lag_days`, `latency.mean_lag_days`) that we can treat as the default prior source. Sparse/immature behaviour is primarily a `cohort()` problem, not a baseline-window problem.

### 3.2 `cohort(anchor,start:end)` semantics (A-anchored)

- The `cohort()` clause selects **which A-entry cohorts are in-scope** (by entry date).
- Evidence uses the **most complete view available as-of now** for those cohorts (not censored to “within the cohort window”).
- Completeness is computed **as-of now** but must incorporate A→X journey time:
  - Primary/normal case: effective age for X→Y is adjusted using `anchor_median_lag_days` (central tendency).
  - `path_t95` is **not** used as the primary adjustment (it is too conservative and is defined as a retrieval horizon).
  - However, when anchor lag evidence is missing or too sparse to compute a meaningful `anchor_median_lag_days` adjustment (common for “last week” cohorts on downstream edges), we require an explicit fallback strategy (see §3.4 and Phase 2). This fallback must be median-consistent and distribution-aware, not a percentile-to-median inversion.
- Forecast baseline still comes from the **whole baseline window slice** for that edge/context, independent of the cohort selection.
- p.mean is blended from narrow evidence and baseline forecast using the same weight machinery.

**Key reality (sparsity):** cohort selections (especially “last week”) are often immature and may have sparse lag signal. The system must therefore use baseline-window-derived lag priors for both:
- local X→Y lag shape, and
- upstream A→X delay estimation (for downstream edges),
until cohort-specific anchor lag evidence becomes reliable.

### 3.3 Evidence visibility rule (important)

- Evidence should be present **only where evidence exists**.
- Rebalanced/model-derived edges (no direct observed n/k) must not fabricate evidence; instead:
  - Evidence is absent
  - Rendering should use the “no evidence” styling semantics already described in rendering docs.

### 3.4 Clarification: where `path_t95` matters (and where it does not)

- **Window mode:** `path_t95` should not affect evidence/completeness semantics. Window mode is X-anchored and local by design.
- **Cohort mode:** we must account for “time-to-reach X” before judging X→Y maturity. The canonical source is `anchor_median_lag_days` (from 3-step funnels / anchor lag arrays).  
  `path_t95` remains primarily a **retrieval bounding** quantity and is not a substitute for anchor-median upstream delay.

**Amendment (preferred fallback):** rather than treating `path_t95` as a proxy for median upstream delay (which is not coherent), the preferred fallback for missing anchor lag is to derive an upstream A→X delay prior from the baseline-window lag summaries of the upstream latency edges (distribution-aware, using median+mean where available). `path_t95` remains a retrieval/bounding primitive.

---

## 4. Current divergences to correct (high-level)

### 4.1 Window mode incorrectly mixing cohort slices

In the current refactored pipeline, the graph-level topo pass can include `cohort()` slices while processing a `window()` query and can interpret `window(start:end)` as a filter over cohort entry dates. This produces incorrect results for window queries (e.g. wrong evidence mean and wrong completeness semantics).

### 4.2 Evidence and stdev not consistently propagated

Some flows do not reliably populate:

- `edge.p.evidence.mean`
- `edge.p.evidence.stdev`
- `edge.p.stdev`

which then cascades to missing keys in the param pack (because `GraphParamExtractor` only includes defined fields).

---

## 5. Correction plan (service layer)

### Phase A — Make `window()` mode use window slices for evidence/completeness

**Primary files**
- `graph-editor/src/services/fetchDataService.ts`
- `graph-editor/src/services/statisticalEnhancementService.ts`

**Required behavioural changes**

1. Ensure `window()` queries do not use A-anchored cohort slices to compute window evidence or window completeness.
2. In `window()` mode:
   - Evidence must be computed from window-slice `dates[]`, `n_daily[]`, `k_daily[]` for the narrow selection.
   - Completeness must be computed from window-slice lag arrays for X→Y using “as-of now” ages and no A→X adjustment.
3. Ensure the topo/LAG pass has a clear separation:
   - **Evidence input** for window mode comes from window slices.
   - **Forecast input** comes from the baseline window slice.

**Notes**
- This does not forbid cohort slices from existing in the param file; it only forbids using them to drive `window()` semantics.

### Phase B — Make `cohort()` mode use cohort slices (and A→X adjustment) for evidence/completeness

**Primary files**
- `graph-editor/src/services/fetchDataService.ts`
- `graph-editor/src/services/statisticalEnhancementService.ts`

**Required behavioural changes**

1. In `cohort()` mode:
   - Evidence is computed from cohort slices (A-entry dates in range), as-of now.
   - Completeness uses A→X adjustment via an **effective anchor delay** that transitions smoothly from prior to observed.
2. Soft transition for anchor delay (prior → observed):
   - **Problem:** cohort selections are often immature; `anchor_*` lag arrays may be sparse/noisy, but we still need an A→X delay adjustment to avoid overstating downstream completeness.
   - **Principle:** completeness is analytically derived; the question is how we infer the upstream delay used for the effective-age adjustment.
   - **Prior anchor delay (`m0`)**: derive an A→X prior median delay from upstream baseline `window()` lag summaries (distribution-aware; uses median+mean where available). This is the stable “baseline” source.
   - **Observed anchor delay (`m̂`)**: compute a cohort-window observed median delay from cohort-slice `anchor_median_lag_days[]` when available (population-weighted over cohorts in the user’s selected window).
   - **Weight (`w`)**: compute a simple confidence weight \(w \in [0,1]\) that increases with:
     - cohort coverage (fraction of cohorts in-range with valid `anchor_median_lag_days[]`), and
     - effective population (sum of denominators for cohorts contributing anchor lag).
   - **Effective anchor delay (`m_eff`)**: \(m_\text{eff} = w \cdot \hat m + (1-w)\cdot m_0\).
   - Use `m_eff` for the cohort-mode effective-age adjustment: `effective_age = max(0, anchor_age - m_eff)`.
   - **Note:** this does not introduce new persisted schema fields; it is an internal calculation/diagnostic in the LAG topo pass.
3. Define behaviour for completely missing anchor evidence:
   - If cohort-slice `anchor_*` arrays are absent, \(w = 0\) and we fall back to the baseline-window-derived prior.
   - This fallback must be median-consistent and must not silently switch to `path_t95` (which remains a horizon/bounding primitive only).
3. Forecast remains sourced from the window baseline slice (see Phase C).

### Phase C — Forecast baseline selection rules (whole baseline window)

**Primary files**
- `graph-editor/src/services/dataOperationsService.ts` (forecast attachment for file-to-graph path)
- `graph-editor/src/services/statisticalEnhancementService.ts` (fallback logic)

**Required behavioural changes**

1. For any narrow selection (window or cohort), forecast is sourced from the best available **whole baseline window slice** for matching context/case dimensions.
2. Forecast must not drift as a function of the narrow selection window.
3. When no baseline window slice exists:
   - fall back to LAG’s internal estimate (p∞) only if the quality gates permit it (as currently described in the reference).

### Phase D — Blending rules for `p.mean`

**Primary files**
- `graph-editor/src/services/statisticalEnhancementService.ts`

**Required behavioural changes**

1. Use the canonical blend formula from the reference:
   - completeness-weighted and population-weighted blend of evidence and forecast.
2. Confirm that:
   - window mode uses local completeness and window evidence
   - cohort mode uses A-adjusted completeness and cohort evidence
   - both use the same baseline forecast sample size (`n_baseline`) from the baseline window slice.

### Phase E — Ensure scenario-visible fields are present where appropriate

**Primary files**
- `graph-editor/src/services/UpdateManager.ts`
- `graph-editor/src/services/GraphParamExtractor.ts`
- `graph-editor/src/services/ParamPackDSLService.ts`

**Required behavioural changes**

1. Ensure that when evidence exists, the graph edge ends up with:
   - `p.evidence.mean`
   - `p.evidence.stdev`
2. Ensure `p.stdev` is populated (or explicitly defined as not available, but then tests/docs must match).
3. Confirm param pack output includes:
   - `e.<edge>.p.mean`
   - `e.<edge>.p.stdev`
   - `e.<edge>.p.evidence.mean`
   - `e.<edge>.p.evidence.stdev`
   - `e.<edge>.p.forecast.mean`
   - latency display fields as per reference.

### Phase F — Deferred requirement: “HAS completed” vs “completed by window end”

We are intentionally **deferring** the introduction of a toggle for:

- “HAS completed” semantics (as-of now; allow conversions after `window.end` / `cohort.end`) vs
- “completed by end-of-window” semantics.

Rationale:

- It complicates the semantics work at a point where correctness and regression repair are the priority.
- It may not be trivial to derive “events occurred within the window” faithfully from the Amplitude return shapes without additional query structure.

This should be tracked as a separate requirement in `/TODO.md` and revisited after Phase 1 is stable.

### Phase 2 integration — Replace horizon dependencies with `t95/path_t95` overrides

This plan intentionally avoids deepening reliance on `maturity_days`, since it is slated for deprecation. Phase 2 will:

- Introduce parameter-level `t95` and `path_t95` with `*_overridden` semantics.
- Replace any remaining “horizon fallback” use of `maturity_days` with:
  - baseline window lag summaries when available, else
  - persisted/overridden `t95` (and `path_t95` for retrieval bounding, caching, and cohort-vs-window targeting; not as a median proxy for completeness).

**Note:** given baseline `window()` coverage is expected to be wide (~90 days), Phase 2 should aim to use:
- baseline-window `median+mean` as the default prior for lag shape, and
- persisted/overridable `t95`/`path_t95` as canonical horizons for bounding/planning (without changing their meaning based on whether they are overridden).

---

## 6. Test coverage plan (must cover non-exact windows)

### 6.1 Update/repair existing failing E2E tests

**File**
- `graph-editor/src/services/__tests__/sampleFileQueryFlow.e2e.test.ts`

**Scenarios (prose expectations)**

1. Window mode:
   - Exact baseline window slice: evidence matches baseline window totals; forecast present; p.mean blended.
   - Narrow window inside stored window slice: evidence is narrow; forecast is baseline; p.mean blended.
   - Window wider than stored coverage: evidence reflects available dates only; forecast still baseline; p.mean blended.
2. Cohort mode:
   - Exact cohort slice: evidence uses authoritative totals (fixture header); completeness high; p.mean close to evidence.
   - Narrow cohort sub-range: evidence computed from in-range cohorts; completeness and p.mean behave accordingly; forecast still baseline.
3. Contexted queries:
   - Contexted window and contexted cohort both select matching dims and use correct baselines.
4. Param pack keys:
   - `p.stdev` and `p.evidence.*` keys present when evidence exists.

### 6.2 Add targeted service tests for the new refactored pipeline

**Files (candidates)**
- `graph-editor/src/services/__tests__/fetchDataService.test.ts`
- `graph-editor/src/services/__tests__/addEvidenceAndForecastScalars.test.ts`
- Add a dedicated integration-style test if needed: `graph-editor/src/services/__tests__/windowCohortSemantics.integration.test.ts`

**Required scenarios**

- Window mode must not use cohort slices for evidence/completeness.
- Cohort mode must incorporate A→X adjustment in completeness.
- Evidence absent for rebalanced/model-only edges (no fabricated evidence).
- Forecast invariant to narrow selection (unless baseline window data actually changes).

---

## 7. Verification checklist (post-change)

- Re-run only the impacted tests:
  - `graph-editor/src/services/__tests__/dataOperationsService.test.ts`
  - `graph-editor/src/services/__tests__/sampleFileQueryFlow.e2e.test.ts`
  - Any new tests added by Phase 6.2
- Confirm the following invariants with logs or assertions:
  - Window mode evidence uses window slices only.
  - Cohort mode evidence uses cohort slices only.
  - Forecast selection does not change with narrow selection.
  - p.mean follows the canonical blend behaviour and avoids “underegging” when completeness is low.

---

## 8. Open questions (for explicit sign-off)

1. (Deferred) “HAS completed” vs “completed by window end” toggle (tracked in `/TODO.md`).
2. Exact definition of “baseline window slice” when multiple window slices exist:
   - prefer most recent by retrieved_at, or
   - merged window slice semantics (single canonical baseline), or
   - another documented rule.
3. Cohort-mode fallback policy when anchor lag evidence is missing:
   - preferred: derive upstream A→X delay prior from baseline-window lag summaries of upstream edges (median+mean → distribution proxy),
   - confirm the soft-transition weight inputs (coverage + effective population) and the single tuning constant (if any),
   - how to signal low confidence / “prior-heavy” completeness (diagnostics/logging),
   - how this interacts with `t95/path_t95` overrides in Phase 2 (horizons remain bounding/planning primitives; completeness meaning does not change).


