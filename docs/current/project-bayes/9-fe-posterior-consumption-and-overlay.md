# Doc 9 — FE Posterior Consumption and Overlay

**Status**: Draft — enumerating required FE changes.
**Date**: 17-Mar-26

---

## Purpose

This document specifies the FE changes needed to consume Bayesian
posteriors from parameter files and surface them in the graph editor.
It covers: what existing code changes, what new UI surfaces are needed,
and what existing stats code can be deleted vs must be retained.

---

## 1. Current FE stats architecture (what exists today)

The FE currently does **both fitting and application**:

### Fitting (to be replaced by Bayes compiler)

| Service | What it does | Fate |
|---|---|---|
| `lagFitAnalysisService.ts` | Reads param data from fileRegistry, fits log-normal (mu, sigma) to lag observations | **Delete** after Phase D — Bayes compiler produces latency posteriors |
| `lagDistributionUtils.ts:fitLagDistribution()` | MLE log-normal fit from histogram data | **Delete** fitting entry point; retain distribution math (CDF, quantile, etc.) |
| `statisticalEnhancementService.ts` | Blends evidence + forecast using completeness fraction | **Retain and adapt** — blending logic still needed, inputs change from MLE to posterior means |

### Application (retained, inputs change)

| Service / utility | What it does | Change needed |
|---|---|---|
| `lagDistributionUtils.ts` (CDF, quantile, survival functions) | Pure log-normal math | **Retain as-is** — these are distribution application functions, not fitting |
| `confidenceIntervals.ts` | Computes confidence bounds from mean/stdev for normal/beta/uniform | **Adapt** — switch from standard-error CI to HDI bands from posterior |
| `statisticalEnhancementService.ts` (blend logic) | Evidence × forecast blend weighted by completeness | **Adapt** — completeness now from posterior rather than MLE fit |
| `cohortRetrievalHorizon.ts` | Derives retrieval horizon from anchor node | **Retain as-is** |
| `windowAggregationService.ts` | Window-mode aggregation | **Retain as-is** |

### Rendering (retained, data source changes)

| Component / builder | What it does | Change needed |
|---|---|---|
| `LagFitChart.tsx` | Fitted log-normal vs observed completeness | **Adapt** — use posterior mu/sigma instead of MLE fit |
| `DailyProjectionChart.tsx` | Observed k/day vs model-expected | **Adapt** — model-expected from posterior |
| `cohortComparisonBuilders.ts:buildLagFitEChartsOption()` | ECharts option for lag fit chart | **Adapt** — posterior-sourced curve params |
| `cohortComparisonBuilders.ts:buildCohortMaturityEChartsOption()` | Cohort maturity curves | **Add** posterior CDF overlay (Phase D) |
| Edge rendering (`buildScenarioRenderEdges`) | Computes `EdgeLatencyDisplay` for edge beads | **Adapt** — derive from posterior means instead of MLE |

---

## 2. Posterior consumption pipeline

When the Bayes compiler writes results back to parameter files (via
webhook → Git Data API commit), the FE picks them up on next file load
through the existing file-to-graph cascade.

### What already works (zero FE changes)

The cascade in doc 4 §23 is designed so that:
- `p.mean = α / (α + β)` — written to param file by webhook
- `p.stdev` — derived from α, β — written to param file by webhook
- `latency.mu`, `latency.sigma` — copied from posterior means
- `latency.t95` — derived from posterior means

These scalar fields are what the existing FE consumption code reads.
**All existing code that reads `p.mean`, `p.stdev`, `latency.mu`,
`latency.sigma`, `latency.t95` continues to work unchanged.**

### What the FE needs to newly consume

The posterior blocks (`p.posterior`, `p.latency.posterior`) contain
richer information that the FE does not currently read:

| Field | Where it appears | What FE does with it |
|---|---|---|
| `posterior.hdi_lower/upper` | `p.posterior` | Replace current CI bands with HDI bands |
| `posterior.hdi_level` | `p.posterior` | Display the HDI level (e.g. "90% HDI") |
| `posterior.evidence_grade` | `p.posterior` | Edge colour-coding, quality overlay |
| `posterior.rhat` | `p.posterior` | Convergence warning indicator |
| `posterior.ess` | `p.posterior` | Sample size indicator |
| `posterior.provenance` | `p.posterior` | Badge: "bayesian" vs "pooled-fallback" vs "point-estimate" |
| `posterior.prior_tier` | `p.posterior` | Badge: evidence source (direct history, inherited, uninformative) |
| `posterior.surprise_z` | `p.posterior` | Trajectory anomaly indicator |
| `posterior.divergences` | `p.posterior` | MCMC health indicator |
| `posterior.slices` | `p.posterior.slices` | Per-slice posterior bands (window vs cohort divergence) |
| `posterior.fit_history` | `p.posterior.fit_history` | Trajectory sparkline / history chart |
| `latency.posterior.hdi_t95_lower/upper` | `p.latency.posterior` | Latency confidence band on t95 |
| `latency.posterior.mu_sd/sigma_sd` | `p.latency.posterior` | Parameter uncertainty display |
| `_bayes` (graph-level) | Graph document root | Run summary, quality dashboard |

---

## 3. Required FE changes by area

### 3.1 TypeScript types

**`src/types/index.ts`** — posterior types already partially defined
(`ProbabilityPosterior`, `LatencyPosterior`). Need to verify completeness
against doc 4 schema and add any missing fields:

- `prior_tier` on `ProbabilityPosterior`
- `surprise_z` on `ProbabilityPosterior`
- `divergences` on `ProbabilityPosterior`
- `slices` map on `ProbabilityPosterior`
- `_model_state` on `ProbabilityPosterior`
- `BayesRunMetadata` type for graph-level `_bayes`
- `FitHistoryEntry` types (probability and latency variants)

### 3.2 PropertiesPanel changes

Currently shows: mean, stdev, evidence block, manual overrides.

**Add for edges with posteriors:**

- **Posterior summary card** — HDI band `[hdi_lower, hdi_upper]` at
  stated `hdi_level`, provenance badge, evidence grade badge, prior
  tier indicator
- **Convergence diagnostics** — rhat (with warning threshold), ESS,
  divergence count. Collapsed by default, expandable.
- **Trajectory sparkline** — mini chart from `fit_history` showing
  posterior mean over time. Clickable to expand to full history view.
- **Surprise indicator** — if `|surprise_z| > 2`, show alert badge
  with z-score
- **Slice comparison** — if `posterior.slices` has both window and
  cohort entries, show divergence indicator (large gap = temporal
  volatility signal)

**Latency section additions:**
- HDI band for t95: `[hdi_t95_lower, hdi_t95_upper]`
- Parameter uncertainty: mu ± mu_sd, sigma ± sigma_sd
- Same provenance/convergence indicators as probability

### 3.3 Edge rendering changes

**`buildScenarioRenderEdges`** (constructs `EdgeLatencyDisplay`):

- Currently: derives display values from `p.mean`, `p.stdev`,
  `latency.mu`, `latency.sigma` — **no change needed** for basic
  rendering, since the cascade writes these scalars.
- **Add**: edge colour/style coding by `evidence_grade` or `rhat`
  when quality overlay mode is active
- **Add**: visual indicator for provenance (bayesian vs fallback)
- **Add**: HDI band width as edge thickness or opacity signal

### 3.4 Analysis view / AnalyticsPanel changes

**New analysis types or chart kinds:**

- **Posterior trajectory** — time series of posterior mean + HDI band
  from `fit_history`. Per-edge or multi-edge comparison. New chart
  kind in `analysisEChartsService.ts`.
- **Convergence dashboard** — graph-level summary from `_bayes.quality`.
  Shows: edges fitted/skipped, worst rhat, min ESS, convergence %,
  total divergences, surprise count. Table + colour-coded summary.
- **Slice comparison** — for edges with `posterior.slices`, bar chart
  comparing window vs cohort posterior means with HDI error bars.
  Surfaces temporal volatility.

**Existing chart adaptations:**

- **`buildLagFitEChartsOption()`** — add posterior CDF curve alongside
  MLE fit curve (both visible during transition period; MLE curve
  removed after Phase D when FE fitting deleted)
- **`buildCohortMaturityEChartsOption()`** — add posterior-predicted
  maturation overlay (Phase D): given cohort age, show model's
  predicted maturation vs actual observed

### 3.5 Quality overlay mode

A new graph-wide visualisation mode (toggle in toolbar or view menu):

- Colour-code every edge by a quality dimension:
  - `evidence_grade` (0–3 → red/amber/yellow/green)
  - `rhat` convergence (> 1.1 = red, > 1.05 = amber, ≤ 1.05 = green)
  - `provenance` (bayesian = solid, pooled-fallback = dashed,
    point-estimate = dotted, skipped = grey)
  - `prior_tier` (direct history = full colour, inherited = lighter,
    uninformative = outline only)
- Graph-level summary badge showing `_bayes.quality.converged_pct`

### 3.6 Confidence interval migration

**Current**: `confidenceIntervals.ts` computes bounds from mean ± z×stdev
(normal approximation) or Beta quantile approximation.

**After Bayes**: HDI bounds come pre-computed in `posterior.hdi_lower/upper`.
The FE should prefer these when present and fall back to the current
approximation when no posterior exists (pre-Bayes edges, skipped edges).

This is a **gradual migration**, not a rip-and-replace:
1. If `posterior.hdi_lower/upper` exist → use them directly
2. Else → fall back to current `calculateConfidenceBounds()`

### 3.7 Stats code deletion schedule

| Code | Delete when | Reason |
|---|---|---|
| `lagFitAnalysisService.ts` (fitting logic) | Phase D complete | Bayes compiler handles latency fitting |
| `lagDistributionUtils.ts:fitLagDistribution()` | Phase D complete | MLE fitting replaced by MCMC |
| `lagDistributionUtils.ts` (CDF, quantile, erf) | **Never** (if posture 2/3) | FE application math retained |
| `statisticalEnhancementService.ts` (blend logic) | Adapt, don't delete | Inputs change from MLE to posterior |
| `confidenceIntervals.ts:calculateConfidenceBounds()` | After full posterior coverage | Fallback until all edges have posteriors |

---

## 4. Phased delivery (maps to programme.md phases)

### Phase A overlay (Beta posteriors exist)

**Minimum viable validation surface (built 17-Mar-26):**

- **Data > Run Bayesian Fit** menu item in `DataMenu.tsx` — promotes
  the dev-only `DevBayesTrigger` to a proper Data menu entry. Uses
  `useBayesTrigger` hook with stored compute mode preference. Disabled
  when a fit is already in flight or no graph tab is active.
- **Bayesian model curve on cohort maturity chart** — when
  `p.latency.posterior` exists on an edge, `api_handlers.py` generates
  a second `model_curve_bayes` alongside the existing analytic
  `model_curve`. `cohortComparisonBuilders.ts` renders it as a blue
  dashed line (z=11, above the analytic dotted grey line). Both curves
  use the same `forecast_mean` so they're directly comparable.
  Propagated through `graphComputeClient.ts` via `bayesCurve` /
  `bayesParams` on the `model_curves` metadata map.

This enables the core Phase A validation workflow: run a Bayes fit,
pull the updated parameter files, open cohort maturity analysis, and
visually compare the Bayesian model curve against the analytic model
curve and observed data points.

**Test graph**: `bayes-gm-rebuild-jan-26` feature branch in the data
repo — a rebuild of the nouse-conversion graph specifically for Bayes
validation. Simple topology for initial model plausibility checks.

**Phase A overlay — posterior consumption and quality display (built 18-Mar-26):**

- **PosteriorIndicator component** (`shared/PosteriorIndicator.tsx`) —
  reusable badge + popover showing quality tier, HDI bounds, evidence
  grade, convergence metrics (rhat, ESS), prior tier, provenance, and
  fitted_at with freshness colour-coding. Supports both
  `ProbabilityPosterior` and `LatencyPosterior`. Theme-aware
  (light/dark).
- **Quality tier utility** (`utils/bayesQualityTier.ts`) — computes
  composite quality tier from posterior diagnostics. Two-axis signal:
  diagnostic health (failed/warning from rhat > 1.1, divergences, low
  ESS) and evidential depth (good-0 through good-3, cold start, no
  data). Colour palette: red/amber/pale–saturated green/grey.
- **Edge-level quality overlay** — `ConversionEdge.tsx` and
  `EdgeBeads.tsx` colour-code edges by quality tier when
  `viewOverlayMode === 'forecast-quality'`. Quality tier bead replaces
  normal probability/latency beads in overlay mode.
- **AnalysisInfoCard** (`analytics/AnalysisInfoCard.tsx`) — tabbed info
  panel with Forecast tab showing posterior diagnostics, quality tier,
  HDI, convergence metrics; Diagnostics tab with freshness indicators.
  Multi-scenario column support.
- **localAnalysisComputeService edge info** — `buildEdgeInfoAnalysis()`
  builds Forecast tab rows from edge posterior (probability and
  latency), computes quality tier, shows HDI bounds, evidence grade,
  prior tier, convergence diagnostics, and freshness colour-coding.
- **Freshness display** (`utils/freshnessDisplay.ts`) — age-based
  colour-coding for posterior timestamps (current/stale/very-stale).
- Scalar cascade writes `p.mean`/`p.stdev` — existing edge display
  works without changes.

**Remaining Phase A overlay work** (not yet built):
- Window/cohort divergence indicator — surfaces divergence between
  observation types where both have posteriors in `posterior.slices`.
  Deferred: Phase A does not populate `posterior.slices` (activates
  Phase C).

### Phase B overlay (Dirichlet branch groups)

- Branch group display: show sibling posteriors summing to ≤ 1
- Simplex diagnostic in PropertiesPanel for branch group nodes
- Flag branch groups where any sibling has poor rhat

### Phase C overlay (slice pooling)

- Per-slice posterior bands in PropertiesPanel
- Slice comparison chart (window vs cohort divergence)
- Shrinkage visualisation: low-data slices pulled toward base rate

### Phase D overlay (probability–latency coupling)

- Latency posterior display in PropertiesPanel (HDI for t95, mu/sigma
  uncertainty)
- Posterior CDF overlay on cohort maturity chart
- Posterior-predicted maturation curve vs observed
- **Delete FE fitting code** (`lagFitAnalysisService` fitting path,
  `fitLagDistribution()`)

### Phase E overlay (path composition)

- Path-level uncertainty bands
- Composed latency CDF for multi-hop paths
- Quality dashboard showing graph-wide convergence

---

## 5. Related FE workstreams (not posterior-specific)

The Bayes programme touches several FE workstreams beyond posterior
consumption. They are specced elsewhere but listed here for completeness
— doc 9 is the single inventory of "FE work the Bayes programme needs".

### 5.1 asat UI completion (doc 7 Phase A)

The as-at snapshot feature exists but has UX gaps that affect Bayes
validation workflows (comparing posteriors across time). Doc 7 §A.1–A.9
specifies remedial work:

- Typed `asat_date` field on `AnalysisResult` (carries through to
  charts, tooltips, exports)
- Chart subtitle/badge: "As-at 15-Oct-25" when asat is active
- Tooltip provenance: "Snapshot: 15-Oct-25" appended to data points
- Scenario layer badge: clock icon on layers containing asat clause
- Dropdown UX: current-asat indicator, text input for dates, "Today"
  shortcut, calendar auto-navigation to active month, snapshot
  freshness summary, explanatory subtitle
- `ChartRecipe` carries `asat` for frozen scenario persistence
- Future-date warning (defensive, pre-Phase B): "asat date is in the
  future — results reflect latest available data, not a forecast"

**Dependency**: independent of Bayes posteriors but needed for Bayes
validation workflows. Can be done in parallel.

### 5.2 asat forecasting UI (doc 7 Phase B)

Future-date `asat` turns the snapshot viewer into a forecasting tool.
Requires Bayes posteriors to generate posterior predictive data.

- DSL extension: `asat(+7d)`, `asat(+2w)`, `asat(+1m)` positive offsets
- Data fetching fork: `generateSyntheticTimeSeries()` from latest data +
  completeness model → projected points with confidence
- `AnalysisResult` extensions: `is_forecast`, `forecast_horizon`,
  per-point `is_projected` flag
- Chart rendering: dashed lines for forecast, confidence bands, hatched
  bars, dual-mode axis annotation (observed | projected)
- Cohort maturity forecast overlay: projected maturation tail with
  widening credible interval
- Calendar styling: future dates with different colour/border
- Forecast-specific warnings replacing Phase A's defensive warning
- Cache invalidation: forecast results are volatile, cache keys must
  include `is_forecast`

**Dependency**: blocked on Bayes compiler producing posterior predictive
outputs. Phase D or later.

### 5.3 Topology-break edge linking (doc 6 §evidence inheritance)

When the graph topology changes (nodes removed, edges restructured),
edges lose their fit history. Doc 6 line ~1383 describes a future UI:

- Detect which edges lost their history after a topology-breaking change
- Prompt: "these edges have no prior fit data — link to previous
  version?" with a pre-populated `asat` pointing at the last commit
  before the restructure
- Enables evidence inheritance from predecessor edges

This is a UX surface for the compiler's inheritance machinery. The
computational architecture exists (evidence inheritance in doc 6); the
UI to expose it does not.

**Dependency**: requires evidence inheritance in the compiler (Phase A+)
and asat UI completion (§5.1).

### 5.4 Semantic foundation FE stats deletion (programme.md)

The Semantic Foundation workstream moves model fitting from FE to
Python. Once complete, ~4000+ lines of FE fitting code can be deleted:

- Disable FE topo/LAG fitting pass
- Delete fitting codepaths: `statisticalEnhancementService.ts` (fitting
  orchestration), `lagFitAnalysisService.ts` (distribution fitting),
  `lagDistributionUtils.ts:fitLagDistribution()` (MLE entry point)
- Delete FE path-model derivation (`lagMixtureAggregationService.ts`
  fitting paths, `lagHorizonsService.ts` fitting paths)
- Retain application math (CDF, quantile, blend logic)

**Exit criterion**: no FE code path calls `fitLagDistribution`,
`buildScenarioEnhancement` (fitting branch), or any MLE fitting
function. Build and lint confirm zero references.

**Dependency**: Semantic Foundation Phase 2 complete (Python model
ownership). Overlaps with Bayes Phase D (latency posterior replaces
MLE fit). See §3.7 deletion schedule for the Bayes-specific subset.

### 5.5 Posterior-powered queries and fan charts (programme.md)

Once posteriors exist across a graph:

- Query expressions that reference posterior intervals: "is this
  conversion rate within the 90% HDI?"
- Fan charts in cohort analysis consuming posterior interval data
  (uncertainty bands that widen with forecast horizon)
- Nightly scheduling: cron trigger for automated Bayes fits, with
  results available on next FE load

**Dependency**: Bayes Phase A complete, FE overlay (§4) operational.
Design detail to be written when posteriors are live.

### 5.6 Bayes settings and fit guidance UI

The Bayes programme introduces configuration at three levels, each with
different storage, different FE surfaces, and different schema impact.

#### Level 1: Bayes run triggering and per-graph flags

Two trigger pathways: manual (primary) and automated (optional).

**Manual trigger — Data menu item**

The primary way to commission a Bayes run. Today a dev-only button
exists (`DevBayesTrigger.tsx`); this needs to become a first-class
Data menu item available in production.

- **Menu location**: Data menu → "Run Bayesian fit" (or similar).
  Same pattern as "Retrieve All Slices" — a graph-level operation
  initiated by the user.
- **Preconditions checked before submission**:
  - Graph has at least one parameter file with evidence (no point
    fitting an empty graph)
  - Credentials available (git token for webhook commit-back)
  - No Bayes job already in flight for this graph (check `_bayes`
    metadata or a local in-flight flag)
- **User feedback**: toast with job status (submitted → in progress →
  complete/failed). On completion, auto-pull the updated parameter
  files so posteriors appear immediately. Session log entries for
  the full lifecycle.
- **Confirmation dialog**: show estimated cost/time if available,
  number of edges to fit, last fit date from `_bayes.fitted_at`.
  User confirms before submission.

**Service extraction needed**: `useBayesTrigger.ts` is currently a
React hook (uses `useCredentials`, `useDialog`, `useGraphContext`).
The submission logic (gather graph + param files, encrypt callback
token, POST to `/api/bayes/fit`) must be extracted into a headless
service (`bayesSubmissionService.ts`) that three callers can use:
1. Data menu item (via a thin `useBayesTrigger` hook wrapper)
2. Daily automation service (headless, no dialogs)
3. Future: keyboard shortcut or command palette

The hook becomes a thin UI wrapper that calls the service with
dialog/credential callbacks.

**Automated trigger — `bayesAutoRun` flag** (graph YAML)

`dailyFetch` is already a per-graph boolean in `ConversionGraph` YAML,
toggled in graph properties, consumed by the daily automation service
(`dailyRetrieveAllAutomationService.ts`). Bayes needs an analogous
flag:

**`bayesAutoRun`** (boolean, default `false`)

- **What it controls**: whether a Bayes fit is submitted automatically
  after the daily fetch automation commits new data for this graph.
- **Why it's separate from `dailyFetch`**: daily fetch is cheap (API
  calls to Amplitude/sources, ~2 min per graph). A Bayes run is
  expensive (MCMC on Modal, ~minutes, costs compute). Not every fetch
  warrants a refit — graphs with stable posteriors might run weekly or
  on-demand only.
- **Where it lives**: `ConversionGraph` type, persisted to graph YAML
  alongside `dailyFetch`. Same storage pattern, same dirty-tracking.

**Schema changes needed**:
- `src/types/index.ts` → `ConversionGraph`: add `bayesAutoRun?: boolean`
- `lib/graph_types.py` → `ConversionGraph` Pydantic model: add
  `bayes_auto_run: bool = False`
- Graph YAML schema: add optional boolean field

**Automation flow change** (`dailyRetrieveAllAutomationService.ts`):

Current flow: pull → retrieve all → recompute horizons → commit → close.

With `bayesAutoRun`:
1. After commit, check `graph.bayesAutoRun`
2. If true: call `bayesSubmissionService.submit()` headlessly (no
   confirmation dialog — the user opted in via the flag)
3. The Bayes job is async — the automation service does NOT wait for
   the webhook callback. It submits and closes. Results arrive via
   webhook → git commit → next pull.
4. If false: close as today.

**UI changes — mirror every surface where `dailyFetch` appears today**:

`dailyFetch` is exposed in 7 places. `bayesAutoRun` must appear in
each alongside it:

| Surface | File | What to add |
|---|---|---|
| Graph properties checkbox | `PropertiesPanel.tsx:1745` | `bayesAutoRun` checkbox below `dailyFetch`. Grey out if `dailyFetch` off. |
| Pinned Query modal | `PinnedQueryModal.tsx:20` | `bayesAutoRun` checkbox in the modal props/state, next to `dailyFetch` checkbox |
| WindowSelector (passes to modal) | `WindowSelector.tsx:1542` | Pass `bayesAutoRun` from graph to PinnedQueryModal |
| Daily Fetch Manager modal | `DailyFetchManagerModal.tsx` | Add `bayesAutoRun` column to the transfer-list. Possibly rename modal to "Automation Manager" since it now governs two flags. |
| Data menu | `DataMenu.tsx:1006` | (a) "Run Bayesian fit" manual trigger item; (b) manager modal already launched from here |
| dailyFetchService | `dailyFetchService.ts:16,22,84` | Extend `GraphListItem` and `DailyFetchChange` types to include `bayesAutoRun`. `getGraphsForWorkspace()` returns it; `applyChanges()` writes it. |
| Integrity check | `integrityCheckService.ts:1092` | Add warning: `bayesAutoRun` without `dailyFetch` is a configuration error |
| URL enumeration | `useURLDailyRetrieveAllQueue.ts:295` | After daily fetch commit, check `bayesAutoRun` to decide whether to submit Bayes job |
| Automation runner | `dailyRetrieveAllAutomationService.ts` | Add post-commit Bayes submission step |

The `useRetrieveAllSlices.ts` hook (line 36) exposes `dailyFetch`
from the graph — extend to expose `bayesAutoRun` too.

#### Level 2: Model tuning settings (`settings/settings.yaml`)

`ForecastingSettings` in `latency.ts` defines model tuning constants
(blend lambda, completeness power, recency halflife, etc.). Today these
are code defaults with an existing but unwired override path:
`forecastingSettingsService.ts` reads from IDB key `settings-settings`
(backed by `settings/settings.yaml` in the repo) and falls back to code
constants for any missing field.

Bayes adds fields to this bundle:
- `bayes_fit_history_interval_days` (default 7) — minimum days between
  retained `fit_history` entries
- `bayes_fit_history_max_entries` (default 12) — max entries per
  posterior's `fit_history` array
- Convergence display thresholds (rhat warning at 1.05 vs 1.1, min
  ESS for quality badges) — these are display-only; the compiler's own
  convergence criteria are separate
- Eventually: prior strength presets, pooling aggressiveness

**Schema changes needed**:
- `src/constants/latency.ts` → `ForecastingSettings` interface: add
  Bayes fields (the two fit_history fields already exist)
- `lib/runner/forecasting_settings.py` → `ForecastingSettings`
  dataclass: matching Python-side fields
- `settings/settings.yaml` in data repos: add `forecasting.bayes_*`
  fields (optional, defaults apply)

**UI needed** (not yet built for any ForecastingSettings):
- A settings panel accessible from graph properties or a top-level
  menu. Shows current effective values (code default vs YAML override).
  Edits write to `settings/settings.yaml` via the normal file dirty →
  commit flow.
- This is not Bayes-specific — it's a general gap. Bayes just makes it
  more pressing because users will want to tune fit_history retention
  and display thresholds.

**Flow**: FE reads settings → bundles into `ForecastingSettings` →
sends in API request body to BE endpoints (`/api/lag/recompute-models`,
`/api/bayes/fit`). BE deserialises via `settings_from_dict()` and
hashes via `compute_settings_signature()` for provenance.

#### Level 3: Per-parameter fit guidance (parameter YAML)

Each parameter file can carry a `fit_guidance` block that the Bayes
compiler reads when fitting that parameter's posterior. Specced in
doc 4 §fit_guidance but not yet in schema or types.

**`fit_guidance` fields**:

- **`exclusion_windows`** — date ranges to exclude from fitting.
  Observations falling within an exclusion window are dropped before
  the compiler sees them. Common use: Christmas/holiday weeks,
  production incidents, anomalous traffic.
  ```yaml
  fit_guidance:
    exclusion_windows:
      - label: "Christmas 2025"
        from: 20-Dec-25
        to: 3-Jan-26
        reason: "Seasonal anomaly — non-representative traffic"
      - label: "Checkout outage"
        from: 7-Mar-26
        to: 9-Mar-26
        reason: "Production incident — conversion near zero"
  ```
- **`regime_changes`** — dates where the underlying distribution is
  known to have shifted. The compiler can down-weight or discard
  pre-change observations (strategy TBD — hard cutoff vs soft
  exponential decay from change point).
  ```yaml
    regime_changes:
      - at: 1-Feb-26
        description: "New checkout flow launched"
  ```
- **`halflife_days`** — override the global `recency_half_life_days`
  for this parameter. A high-variance metric might want a shorter
  halflife; a stable one might want longer.
- **`notes`** — free-form text for analysts ("high-variance parameter;
  consider wider priors").

**Graph-level cascade**: a `fit_guidance` block on the graph document
itself cascades to all parameters, so "ignore Christmas" doesn't need
to be duplicated across dozens of param files. Per-parameter guidance
merges with (and overrides) graph-level guidance. Merge semantics:
exclusion windows union, regime changes union, halflife per-param wins,
notes concatenate.

**Schema changes needed**:
- `public/param-schemas/parameter-schema.yaml`: add `fit_guidance`
  object with `exclusion_windows` array, `regime_changes` array,
  `halflife_days` number, `notes` string
- `src/types/index.ts` or `src/types/parameterData.ts`: add
  `FitGuidance`, `ExclusionWindow`, `RegimeChange` interfaces
- `lib/graph_types.py`: matching Pydantic models
- `ConversionGraph` type: add optional `fit_guidance?: FitGuidance`
  for graph-level cascade

**UI needed**:
- PropertiesPanel section when a parameter file is selected: show
  current `fit_guidance` entries (exclusion windows as date-range
  chips, regime changes as date badges, halflife as number input,
  notes as text area)
- Inline add/remove for exclusion windows (date pickers, label +
  reason fields) and regime changes (date picker + description)
- Visual indicator on the edge when exclusion windows or regime changes
  are active (small badge or icon on the edge bead)
- Graph properties panel: graph-level `fit_guidance` section with same
  editing surface, labelled as "applies to all parameters unless
  overridden"
- Validation: dates in d-MMM-yy format, exclusion windows must not
  overlap within the same level (graph or param), halflife must be
  positive

**Compiler consumption**: the Bayes compiler receives `fit_guidance` as
part of the parameter file payload (already sent inline by
`useBayesTrigger.ts`). It filters observations against exclusion
windows before fitting, uses regime_changes to adjust the prior or
evidence weighting, and uses halflife_days to override the global
recency decay.

---

## 6. Application locus (RESOLVED 17-Mar-26)

Three-tier computation model — each tier does qualitatively different
work:

| Tier | What | Nature |
|---|---|---|
| **Modal** | MCMC sampling → posteriors (α, β, μ, σ) to YAML | Heavy batch inference, minutes |
| **BE** (analysis runners) | Analytic lognormal fitting, path composition, cohort maturity curves | Request-response derivation, seconds |
| **FE** | Beta mean + HDI, confidence bands, per-edge display from published params | Trivial closed-form, instant |

**Decision**: posture 2 (FE applies from published params) for
Phases A–C. Posture 3 (hybrid, adding BE computation for path-level
quantities) becomes relevant at Phase D if Fenton-Wilkinson
composition proves too complex or fragile to port to TS.

**What the FE computes** (tens of lines of application code):
- `p.mean = α / (α + β)` — trivially derivable, no round-trip needed
- `p.stdev` from α, β — trivially derivable
- `t95 = exp(mu + 1.645 × sigma)` — one line
- HDI display — pre-computed in posterior, just read it
- Completeness CDF from log-normal (needs `erf` — FE already has this
  in `lagDistributionUtils.ts`)
- Forecast blending with completeness weighting (FE already does this)

**What the FE does NOT do** (deleted by Semantic Foundation + Bayes):
- MLE fitting (~4000 lines) — replaced by MCMC on Modal
- Path-model derivation — moves to Python (BE)
- `fitLagDistribution`, `approximateLogNormalSumFit`, etc.

**What the BE continues to do**:
- Analytic lognormal fitting in analysis runners (existing, unchanged)
- Path composition for analysis views (existing, unchanged)
- At Phase D: may additionally consume Bayesian posteriors for
  path-level completeness CDF — extending analysis runners, not
  rewriting them

**FE is source-agnostic**: derives display quantities from whatever
params are in the files, regardless of whether they came from analytic
fitting or MCMC. `posterior.provenance` distinguishes source. The BE
analytic pipeline remains as instant fallback for edges without
posteriors.

The implementation plan in sections 3–5 assumes this resolution.

---

## 7. Dependency on other docs

| Doc | Dependency | Nature |
|---|---|---|
| Doc 1 §14, §21–22 | File-level change spec for model contract | Defines which TS files change |
| Doc 4 | Posterior schema | Defines what FE reads from param files |
| Doc 6 | Compiler output | Defines what posteriors exist per phase |
| Doc 8 | Implementation phasing | Determines when each posterior type appears |
| Programme.md | Application locus decision | Blocks final scope of sections 3–5 |
