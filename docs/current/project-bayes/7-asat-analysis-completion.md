# Project Bayes: `asat()` — Analysis & Charting Completion

**Status**: Draft
**Date**: 17-Mar-26
**Purpose**: Ensure `asat()` is a first-class citizen through all analysis and
charting paths. Phase A is remedial (historic asat, defaults to today). Phase B
extends to future dates and depends on the Bayes compiler being in place.

**Related**: `../project-db/completed/3-asat.md` (original asat design),
`6-compiler-and-worker-pipeline.md` (compiler evidence layers),
`1-cohort-completeness-model-contract.md` (completeness model)

---

## Current state

`asat()` is well implemented at the **plumbing** level:

- **DSL layer**: parsing, normalisation, `at()` sugar, relative & absolute
  dates, three-state inheritance (`inherit`/`set`/`clear`) — all working.
- **Scenario composition**: MECE fetch-part semantics, layer stacking,
  explicit clear via empty `asat()`, delta derivation, smart label generation
  ("As-at: 5-Jan") — all working.
- **Data fetching fork**: `getFromSourceDirect` and `fileToGraphSync` detect
  `asat`, route to snapshot DB, convert virtual snapshot rows to time-series,
  annotate parameter objects with `_asat` / `_asat_retrieved_at` — working.
- **Snapshot dependency plan**: `composeSnapshotDsl()` merges asat into
  analysis DSL, `deriveTimeBounds()` uses asat for sweep bounds,
  `SnapshotSubjectRequest` carries `as_at` to the Python backend — working.
- **Python backend**: virtual snapshot query, cohort maturity fit, per-frame
  `as_at_date` annotation — working.
- **Export**: CSV includes `as_at_date_iso`, `as_at_date_uk` per row —
  working.
- **UI entry**: WindowSelector `@` picker with calendar + coverage
  highlighting, QueryExpressionEditor chip, ScenarioQueryEditModal — working.

The gaps are in the **analysis result surface** and in **forward-looking**
semantics.

---

## Phase A — Remedial: historic `asat()` through analysis & charting

**Goal**: when `asat()` is present in the query DSL (or defaults to today when
absent), the entire analysis and charting pipeline handles it as a first-class
property — visibly, correctly, and with test coverage.

### A.1 Typed `asat` field on `AnalysisResult`

**Problem**: `asat` is buried in `metadata: Record<string, any>`. Downstream
consumers must know the ad-hoc key name and parse it.

**Change**: add an optional typed field to `AnalysisResult` in
`graphComputeClient.ts`:

- `asat_date?: string` — the UK-format date that was requested (or `null` if
  live / defaulting to today)
- `asat_retrieved_at?: string` — ISO datetime of the latest snapshot row used
- Populate from existing metadata during response normalisation

**Files**:
- `graph-editor/src/lib/graphComputeClient.ts` — `AnalysisResult` interface,
  normalisation functions

### A.2 Chart title / subtitle indication

**Problem**: charts rendered from asat data are visually indistinguishable from
live-data charts. Users cannot tell they are looking at a historical view.

**Change**: when `asat_date` is present on the analysis result, inject a
subtitle or badge into the chart. Proposed format: `"As-at 15-Oct-25"` as a
secondary subtitle line, or a small label in the top-right of the chart area.

**Files**:
- `graph-editor/src/components/charts/AnalysisChartContainer.tsx` — extract
  `asat_date` from result, pass to chart options
- `graph-editor/src/services/chartDisplayPlanningService.ts` — include asat
  in display plan if present
- All ECharts builders in `graph-editor/src/services/analysisECharts/` — accept
  optional subtitle/annotation; no builder-specific logic needed if the
  container handles it generically

### A.3 Tooltip provenance

**Problem**: chart tooltips show values without indicating "as known on date X".

**Change**: when asat is active, append a line to the tooltip formatter:
`"Snapshot: 15-Oct-25"` (or similar). This should be handled generically in the
tooltip wrapper, not per-builder.

**Files**:
- `graph-editor/src/services/analysisECharts/` — shared tooltip formatter
  (if one exists), or the container-level tooltip config

### A.4 Scenario layer visual indicator

**Problem**: `ScenarioLayerList` rows don't visually distinguish layers that
introduce or clear `asat`. The smart label includes "As-at: date" in text but
there is no icon or badge.

**Change**: add a small clock icon (or `@` badge) to scenario layer rows when
the layer's `queryDSL` contains an `asat` clause. Re-use the existing Clock
icon from QueryExpressionEditor chip config.

**Files**:
- `graph-editor/src/components/panels/ScenarioLayerList.tsx`

### A.5 `@` dropdown display and operation improvements

**Problem**: the `@` asat picker in WindowSelector is functional but minimal.
Several UX gaps make it hard to use confidently:

1. **No indication of the currently active asat date inside the dropdown.**
   When the dropdown opens and an asat is already active, the selected date is
   highlighted in the calendar but there is no textual summary (e.g.,
   "Currently: asat(5-Nov-25)") at the top. Users must visually scan the
   calendar to find the blue dot.

2. **No way to type/paste a date directly.** The only input method is clicking
   a calendar cell. Users who know the exact date they want (especially
   relative dates like `-7d`) must close the dropdown and manually edit the
   DSL. A small text input inside the dropdown (accepting UK dates and
   relative tokens) would remove this friction.

3. **No "today" shortcut.** Common use case: "show me data as known right
   now" — there should be a one-click "Today" button that jumps the calendar
   to the current month and highlights today (if a snapshot exists).

4. **Calendar doesn't auto-navigate to the active asat month.** If the active
   asat is `5-Jan-25` but the calendar opens on the current month (Mar 26),
   the user must click back 14 months to see the selected date. The calendar
   should open on the month of the active asat date when one is set.

5. **No snapshot freshness summary.** The dropdown shows which days have
   snapshots (via coverage highlighting) but doesn't tell the user how recent
   the latest snapshot is overall. A one-line summary — e.g., "Latest
   snapshot: 15-Mar-26 (2 days ago)" — would help users understand coverage
   without scanning the calendar.

6. **Scope label could be clearer.** The header says "As-at snapshot for
   e.A→B" or "for all 5 params" but doesn't explain what this means to a
   user unfamiliar with the feature. A brief explanatory subtitle — e.g.,
   "View data as it was known on a past date" — would help discoverability.

7. **Remove button doesn't confirm the consequence.** The one-way truncation
   policy means removing asat does NOT restore the prior window end. The
   "Remove @" button should either show a brief tooltip explaining this or
   (if the window was truncated) show a secondary confirmation.

**Changes**:

- Add a "Current: asat(date)" summary line in the dropdown header when active
- Add a small text input field (below the header, above the calendar) that
  accepts UK date tokens and relative offsets; on Enter/blur, apply via
  `applyAsatToDSL()`
- Add a "Today" button in the header actions (next to "Remove @")
- Fix `openAsatDropdown()` to set `asatMonthCursor` to the active asat date's
  month (not the current month) when an asat is already active — partially
  implemented but the condition is inverted (`!activeAsat`)
- Add a one-line "Latest snapshot: date (N days ago)" summary below the
  calendar, derived from the loaded `asatDays` array
- Add a brief explanatory subtitle to the dropdown header
- Add a tooltip on the Remove button explaining the one-way truncation policy

**Files**:
- `graph-editor/src/components/WindowSelector.tsx` — dropdown rendering,
  `openAsatDropdown()` fix, text input, today button, freshness summary
- `graph-editor/src/components/WindowSelector.css` — styling for new elements
- `graph-editor/src/components/CalendarGrid.css` — minor adjustments if needed

### A.6 `ChartRecipe` carries `asat`

**Problem**: `ChartRecipeAnalysis` and `ChartRecipeScenario` don't have an
`asat` field. When chart recipes are serialised (frozen scenarios, saved chart
configs), asat is lost.

**Change**: add `asat?: string | null` to `ChartRecipeAnalysis`. Populate from
the composed DSL during recipe construction.

**Files**:
- `graph-editor/src/types/chartRecipe.ts`
- Recipe construction site (wherever `ChartRecipeAnalysis` objects are built)

### A.7 Future-date warning (defensive, pre-Phase B)

**Problem**: if a user types `asat(30-Sep-26)` today, the system silently
returns latest-available data (equivalent to no asat). No indication that
the date is in the future.

**Change**: in `fireAsatWarnings()`, detect when the resolved asat date is
after today and emit a distinct warning: "asat date is in the future —
results reflect latest available data, not a forecast."

**Files**:
- `graph-editor/src/services/dataOperations/asatQuerySupport.ts`

### A.8 Default-to-today semantics

**Problem**: when `asat()` is absent, the system fetches live data from
Amplitude/DAS. This is correct, but the analysis result carries no `asat_date`,
making it impossible to distinguish "live query" from "asat query that happens
to be today".

**Change**: this is a documentation/convention clarification, not a code
change. When asat is absent, `asat_date` on `AnalysisResult` remains `null`.
The chart subtitle logic treats `null` as "live" and does not show an as-at
label. No need to inject today's date — the absence IS the signal.

### A.9 Test coverage

Tests should be integration-level (real IDB, real services, mocked external
APIs) per the testing standards in CLAUDE.md.

**Scenarios to cover**:

- **DSL round-trip**: `asat(15-Oct-25)` parses, normalises, recomposes
  correctly through scenario stacking (existing tests — verify completeness)
- **Analysis result carries asat**: when snapshot dependency plan includes
  `as_at`, the `AnalysisResult` returned from `graphComputeClient` has
  `asat_date` populated
- **Chart subtitle injection**: when `AnalysisResult.asat_date` is present,
  the chart display plan includes an asat subtitle/annotation
- **Tooltip includes provenance**: when asat is active, tooltip output includes
  snapshot date
- **Scenario layer badge**: layer row renders clock indicator when queryDSL
  contains asat
- **ChartRecipe preservation**: recipe serialised from an asat analysis
  includes the asat field; recipe deserialised back carries it through
- **Future-date warning**: `asat(date-in-future)` triggers the defensive
  warning toast
- **Explicit clear**: scenario with `asat()` (empty) correctly removes
  inherited asat from chart subtitle and tooltip
- **Export preserves asat**: CSV export includes `as_at_date` columns (existing
  test — verify)
- **Dropdown text input**: typing a UK date or relative token in the dropdown
  text input applies asat via `applyAsatToDSL()`
- **Dropdown auto-navigate**: opening the dropdown when asat is active
  navigates the calendar to the active asat date's month
- **Dropdown freshness summary**: after snapshot days load, the dropdown
  displays the latest snapshot date

**Test files** (extend existing where possible):
- `graph-editor/src/services/__tests__/` — service-level integration tests
- `graph-editor/src/lib/__tests__/queryDSL.test.ts` — DSL round-trip (likely
  already covered; verify)
- New test file only if no suitable existing suite exists for chart display
  plan assertions

---

## Phase B — Future `asat()` support

**Prerequisite**: Project Bayes compiler and worker pipeline operational
(doc 6). The completeness model (doc 1) must be able to produce projected
frames.

**Goal**: `asat(30-Sep-26)` or `asat(+7d)` produces forecasted/synthetic
data using the completeness model and (where available) Bayesian posteriors,
and the full display stack renders these distinctly from observed data.

### B.1 DSL extension for positive offsets

- `resolveRelativeDate()` in `dateFormat.ts` must handle `+7d`, `+2w`, `+1m`
  (currently only negative offsets)
- `isRelativeDate()` validation pattern must accept positive prefix
- Normalisation must preserve direction: `asat(+7d)` stays relative (resolved
  at query time, not baked to absolute)

### B.2 Data fetching fork: forecast path

- `getFromSourceDirect.ts` and `fileToGraphSync.ts`: new fork — if resolved
  asat date > today, route to forecast engine instead of snapshot DB
- New function in `asatQuerySupport.ts`: `generateSyntheticTimeSeries()` —
  takes latest real data + completeness model parameters, produces projected
  points with confidence metadata
- `snapshotDependencyPlanService.ts`: new subject type `forecast` alongside
  `virtual_snapshot`; `deriveTimeBounds()` sets `sweep_to` to the future date

### B.3 Python backend: forecast generation

- `snapshot_service.py`: new `generate_forecast_snapshot()` — latest real
  snapshot + completeness curve → synthetic future rows
- `api_handlers.py`: new endpoint or extension of virtual snapshot endpoint
- `bayes_worker.py` / `inference.py`: posterior predictive distribution for
  conversion rate extrapolation. `EdgeFit` needs forecast horizon field.
  Compiler Layer 4 (evidence) must support "projected evidence" where `n, k`
  are extrapolated

### B.4 Analysis result: forecast metadata

- `AnalysisResult` in `graphComputeClient.ts`: `is_forecast?: boolean`,
  `forecast_horizon?: string`, per-point `is_projected` flag
- `SnapshotSubjectPayload`: `forecast_to?: string`
- `analysisComputePreparationService.ts`: flag forecast analyses in compute
  plan (different caching/invalidation — forecast results are volatile)

### B.5 Chart rendering: visual distinction

- **All ECharts builders**: forecast region rendered differently — dashed
  lines, confidence bands, shaded areas, hatched bars
- `snapshotBuilders.ts`: daily conversions — solid line (real) + dashed line
  (forecast) with uncertainty band
- `cohortMaturityBuilders.ts`: real age points + projected maturity tail with
  widening credible interval. (Backend already has `forecast_y`/`projected_y`
  fields but these are not rendered distinctly today)
- `bridgeBuilders.ts`: forecast-period bars need distinct styling
  (transparency or hatching)
- `chartDisplayPlanningService.ts`: extend x-axis range to include future
  dates; possibly dual-mode axis annotation (observed | projected)
- `AnalysisChartContainer.tsx`: forecast badge when chart includes projected
  data

### B.6 Scenario layer interaction

- `scenarioRegenerationService.ts`: decide whether future asat composes the
  same way as historic asat (likely yes — MECE fetch-part semantics still
  apply, but the data source changes)
- Inheritance: can a scenario inherit a forecast asat from base? Probably yes,
  but needs explicit design decision

### B.7 UI: calendar and picker

- `WindowSelector.tsx`: calendar must allow future date selection. Highlight
  colour for future dates = "forecast available" (distinct from cyan
  "snapshot available")
- `CalendarGrid.tsx`: future dates need different visual treatment (e.g.,
  orange or dashed border)
- `QueryExpressionEditor.tsx`: different chip colour for future asat

### B.8 Warnings and validation

- `fireAsatWarnings()` evolves: replace Phase A's "future date = latest data"
  warning with forecast-specific warnings — "Data beyond X is projected",
  confidence level, model assumptions
- New `fireAsatForecastWarnings()` for forecast horizon length, completeness
  model confidence

### B.9 Caching and invalidation

- Forecast results are volatile (change as new real data arrives). Cache
  invalidation rules differ from historic snapshots (which are immutable
  once written)
- `snapshotDependencyPlanService.ts`: plan cache keys must include
  `is_forecast` to avoid serving stale forecasts

### B.10 Bayes compiler integration

- `EdgeFit` in `inference.py` needs `asat_date` and `is_forecast` fields so
  the compiler can weight historical evidence differently from projected
  evidence
- Compiler Layer 4 (evidence extraction): must support projected evidence
  where `n, k` are extrapolated via completeness model
- Compiler Layer 5 (inference): propagate forecast uncertainty — wider
  credible intervals for synthetic data. Posterior predictive vs posterior

### B.11 Graph state metadata

- Parameter objects on edges: `_forecast: boolean` alongside existing `_asat`
- `n_daily`, `k_daily` arrays: per-point confidence metadata (so charts can
  distinguish observed points from projected ones)

---

## Impact summary

| Area | Phase A changes | Phase B changes |
|---|---|---|
| DSL / parsing | None (already complete) | Positive offset support |
| Data fetching | None (already complete) | Forecast fork |
| Snapshot plan | None (already complete) | Forecast subject type |
| Python backend | None (already complete) | Forecast generation |
| Bayes compiler | None | Evidence projection, `EdgeFit` extension |
| `AnalysisResult` type | Add typed `asat_date` field | Add `is_forecast`, per-point flags |
| Chart titles/subtitles | Inject "As-at" label | Add "Forecast" badge |
| Chart tooltips | Add snapshot provenance | Add observed/projected distinction |
| Chart rendering | None | Dashed lines, confidence bands, hatching |
| `@` dropdown (WindowSelector) | Text input, today button, freshness summary, auto-navigate, explanatory copy | Future-date calendar styling |
| Scenario layer UI | Clock badge | Same (forecast inherits mechanism) |
| `ChartRecipe` | Add `asat` field | Add `is_forecast` |
| Warnings | Future-date defensive warning | Forecast-specific warnings |
| Caching | None | Volatile cache for forecasts |
| **Test coverage** | **10–12 integration scenarios** | **Extends Phase A suite** |

---

## Sequencing

Phase A can be done at any time — it is purely remedial work on the existing
analysis/charting stack with no dependency on the Bayes compiler.

Phase B depends on:
1. Completeness model (doc 1) able to produce projected frames
2. Bayes compiler (doc 6) operational for evidence extraction
3. Worker pipeline (doc 6) able to return posterior predictive results

Phase B should be planned as part of the "Posterior consumption" workstream
in `programme.md` once the Bayesian inference workstream reaches the point
where posteriors are being committed back to parameter files.
