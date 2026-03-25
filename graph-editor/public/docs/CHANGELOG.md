# DagNet Release Notes
## Version 1.8.10b
**Released:** 25-Mar-26

Gauge charts, dynamically from Bayes

---

## Version 1.8.8b
**Released:** 24-Mar-26

Fixes to live share, Bayes run now working

---

## Version 1.8.3b
**Released:** 24-Mar-26

Fixed lossless compression issue in model by clipping floors

---

## Version 1.8.2b
**Released:** 24-Mar-26

Progress with Bayes toplogies, cohort maturity curves, BE/FE stats modelling

---

## Version 1.7.30b
**Released:** 22-Mar-26

### Bayesian Model Infrastructure
- **Model vars resolution** (`modelVarsResolution.ts`): new `model_vars` array on edges supports multiple candidate model sources (analytic, bayesian, manual). `applyPromotion` resolves the active source based on `model_source_preference` (per-edge or graph-level) and promotes scalars to `p.mean`/`p.stdev`
- **Per-edge `model_source_preference`**: edges can override the graph-level preference (`best_available`, `bayesian`, `analytic`, `manual`) with `model_source_preference_overridden` flag
- **Graph-level `model_source_preference`**: new field on `ConversionGraph` for default model resolution policy
- **Manual override tracking**: when user manually edits edge values, a `manual` model_vars entry is upserted and `model_source_preference` set to `manual`
- **UpdateManager**: builds `analyticModelVarsEntry` from `values[latest]` during file-to-graph sync, upserts into `model_vars`, and runs promotion

### Bayesian Compiler (Phase C/D)
- **Synthetic data generator** (`bayes/synth_gen.py`): generates realistic conversion graph test data with configurable topology, edge weights, latency distributions, and cohort patterns. Comprehensive test suite
- **Compiler improvements**: completeness checking (`completeness.py`), slice-level inference (`slices.py`), enhanced evidence/inference pipeline
- **Diagnostic harness** (`diag_run.py`): interactive debugging tool for compiler pipeline
- **Test infrastructure**: model wiring tests, serialisation tests, hash parity tests
- **Bayesian confidence bands** on cohort maturity charts (`bayes_band_level` setting: off/80%/90%/95%/99%)

### New Data Fields
- `path_onset_delta_days`: path-level cumulative onset delta (DP sum along path)
- `path_onset_sd`, `path_onset_hdi_lower`, `path_onset_hdi_upper`: onset posterior statistics
- `posterior` block on probability params and latency config (Bayesian posteriors from webhook, stripped of `fit_history`/`slices`/`_model_state` on file-to-graph sync)
- Schema, Python, and TypeScript types all in parity

### Content Item Authority Refactor
Canvas analysis containers are now pure placement objects (`id, x, y, width, height, content_items`). All analysis state lives on content items (tabs), eliminating dual-state bugs in multi-tab containers.

- Each tab independently owns analysis type, DSL, view mode, kind, scenario mode, display
- Tab drag with visual removal from source; drop back to cancel
- Per-tab connector persistence and connector colour
- Chrome (title bar, tab bar) inverse-zoomed — always readable
- `+` in tab bar adds new tabs; `+` on type picker tiles adds as new tab
- Type/kind changes update tab title from registry (`humaniseAnalysisType`)

### Shared Toolbar
One toolbar component (`ExpressionToolbarTray`) drives all view types (chart, cards, table) — replaces 320 lines of inline toolbar JSX in `AnalysisChartContainer`.

- Toolbar order: DSL, scenarios, analysis type, view mode, kind, subject, display, connectors, actions
- Analysis type and view mode options scoped by registry (edge_info = cards only)
- Context menu secondary action (`+` icon) for adding analysis types as new tabs

### Bug Fixes
- **`values[latest]` regression** (introduced 21-Mar-26): `applyPromotion` was overwriting `p.mean` with last array element instead of most recent by `window_from` timestamp. Fixed by using `getNestedValue(fileData, 'values[latest]')` in UpdateManager
- **Orphaned connectors**: duplicate React keys on multi-tab shapes caused SVG elements to persist. Fixed with unique `analysisId:tabIdx` keys and DSL deduplication
- **Selected container drag hiding**: CSS `opacity: 1 !important` on `.selected` nodes overrode inline `opacity: 0`. Fixed with `visibility: hidden`
- **Stale closure in type picker**: React.memo prop lag after rapid mutations (+ then type pick). Fixed by reading from graph store at mutation time
- **Satellite click-to-pin**: missing `analytics_dsl` in drag payload after `recipe` field removal
- **Integrity checks**: enhanced for snapshot dependency planning and statistical enhancement

---

## Version 1.7.29b
**Released:** 20-Mar-26

Ready for Bayes Phase D (finally). Added Data Quality view.

---

## Version 1.7.28b
**Released:** 18-Mar-26

Bayes - Phase B done

---

## Version 1.7.26b
**Released:** 18-Mar-26

Fixes to merge logic

---

## Version 1.7.24b
**Released:** 18-Mar-26

Bayesian surfacing

---

## Version 1.7.22b
**Released:** 17-Mar-26

One remaining fetch sync issue

---

## Version 1.7.20b
**Released:** 16-Mar-26

Bayes infra working; next up...compiler

---

## Version 1.7.19b
**Released:** 16-Mar-26

Bayes harness is in...

---

## Version 1.7.18b
**Released:** 16-Mar-26

Bayes II

---

## Version 1.7.16b
**Released:** 16-Mar-26

updated to adapt for the user property filter in amplitude

---

## Version 1.7.14b
**Released:** 16-Mar-26

various refactoring, bassic bayes infra

---

## Version 1.7.13b
**Released:** 15-Mar-26

SNap to working properly. Added tristate handling to chart sceanrios

---

## Version 1.7.12b
**Released:** 13-Mar-26

Fixed nasty pit pull bug, amonth other chart polishing

---

## Version 1.7.10b
**Released:** 12-Mar-26

Squeak, squeak -- a LOT of polishing. Also proper progress reporting in app and a number of canvas stability fixes. Charting v1.0??

---

## Version 1.7.7b
**Released:** 11-Mar-26

Updated sample data charts

---

## Version 1.7.6b
**Released:** 11-Mar-26

Improved graph pre-flight testing

---

## Version 1.7.5b
**Released:** 10-Mar-26

Hellscape of race condition issues on chart init. _Unbelievably_ hard to diagnose and resolve. Finally done so with a completely new readiness architecture at tab level. Horrific.

---

## Version 1.7.4b
**Released:** 10-Mar-26

Chart polishing, context menu refactors, chart toolbars

---

## Version 1.7.3b
**Released:** 9-Mar-26

Various chart improvements and signfiicant refactoring

---

## Version 1.7b
**Released:** 5-Mar-26
**Canvas elements, navigator favourites**

This release introduces three new canvas element types — post-it notes, containers, and canvas analyses — alongside a tools palette for creating them. Together these turn the graph canvas from a pure DAG editor into a freeform workspace where annotations, grouping, and live analytical charts sit alongside conversion nodes.

### Post-It Notes

Coloured sticky notes on the canvas for freeform annotation.

- Double-click to edit text inline; also editable via the properties panel
- Draggable and resizable; rendered below edges (annotation layer)
- Six colours from an authentic 3M Post-it palette, selectable via colour palette or properties panel
- Four font sizes (S/M/L/XL)
- Persisted in the graph JSON alongside nodes and edges; ignored by all analytics pipelines
- Copy, cut, paste, and delete via keyboard shortcuts, context menu, or Edit menu

### Containers

Labelled rectangles for visually grouping conversion nodes.

- Drag a container and all enclosed conversion nodes move with it
- Rendered on the deepest canvas layer (below post-its, below edges)
- Label text at the top; customisable border colour with a light tinted fill
- Resizable via corner/edge handles
- Useful for marking out funnels, loops, or sub-flows ("Acquisition", "Retention", "Payment")

### Canvas Analyses (Charts on Canvas)

Pin any analysis result directly onto the graph canvas as a live, updating chart or result card.

- **Drag from analytics panel**: drag a chart preview from the sidebar and drop it onto the canvas
- **Draw on canvas**: click the pin icon on any analytics result, or click the chart tool in the palette, then click-drag a rectangle on the canvas to define the chart's size and position
- **Blank chart**: create an empty chart via the tools palette (chart icon) or Elements > Add Analysis; configure the analytics DSL and analysis type in the properties panel
- **Live mode**: chart recomputes automatically when the graph's query context, scenarios, or data change (2-second debounce)
- **Frozen mode**: freeze a chart to capture its current scenario state; unfreeze to resume live updates
- **View modes**: toggle between ECharts visualisation and formatted result cards
- **All computed analysis types**: funnels, bridges, path analyses, outcome comparisons — plus DB-snapshot-backed types (lag histograms, daily conversions, cohort maturity) for graphs with snapshot data
- **Multi-scenario**: each chart renders all visible scenarios with their assigned colours
- **Properties panel**: mirrors the analytics panel's workflow — editable QueryExpressionEditor for analytics DSL (with autocomplete), dynamic analysis type card list filtered by availability, result-driven chart kind selector, title, view mode toggle, live/frozen toggle
- **Context menu**: view mode toggle, freeze/unfreeze, z-order controls, copy, cut, delete

### Tools Palette & Elements Menu

A floating palette for element creation, visible at the top of the sidebar (maximised mode) or in the sidebar icon bar (minimised mode).

- **Select** and **Pan** mode buttons
- **New Node**, **New Post-It**, **New Container**, **New Analysis** creation tools — click to enter placement mode (crosshair cursor, click-drag on canvas to place), or drag from the palette onto the canvas
- Active tool highlighted; creation tools auto-revert to Select after placement
- Press **Escape** to revert any active tool (Pan, or any creation tool) back to Select mode
- Elements menu (top menu bar): Add Node, Add Post-It, Add Container, Add Analysis

### Dashboard Mode

- Dashboard fitView now includes all canvas elements (post-its, containers, analyses) when scaling the viewport, not just conversion nodes

### Navigator Favourites

- Star any file (graph, parameter, node, case) to mark it as a favourite
- Click the star icon in the navigator, or right-click and choose "Add to Favourites"
- Filter the navigator to show only favourites via the Filter dropdown
- Implemented as a reserved `_favourite` tag — no new data fields, no schema changes

---


## Version 1.6.17b–1.6.19b (3-Mar-26 to 4-Mar-26)
**Sample data overhaul, cohort maturity curves, fetch fixes**

- **Bundled sample data** — "Use sample data" now loads from a pre-built static bundle (zero GitHub API calls). Previously the flow cloned from GitHub without auth, exceeding the 60 req/hr rate limit and silently dropping files (including graph files).
- **Clone resilience** — if a git clone fails partway through, a toast warning now shows how many files were dropped. Blob fetches are priority-sorted (graphs first, then indexes, then structural files) so the most useful files survive rate-limit truncation.
- **Image fetch optimisation** — clone and pull now reuse the already-fetched repository tree for image discovery instead of making a separate API call.
- **Sample data quality** — fixed events index (7 missing entries), context ID mismatches, truncated event descriptions; added metadata to lag-fixture parameters; populated latency model fields on 3 latency parameters.
- **Cleaned up test shrapnel** — removed scratch test*.json files from repo root; moved test-only graph and context fixtures out of the sample data set into the test fixtures directory.
- Cohort Maturity analysis now shows cumulative lognormal curve overlay; persisting `path_mu` and `path_sigma` for cohort fit modelling.
- Fixed single-day data fetching logic on dual path (window + cohort).

---

## Version 1.6.3b–1.6.9b (24-Feb-26 to 27-Feb-26)
**GitHub OAuth credentials, data historic fixes**

- Per-user GitHub OAuth flow via GitHub App (replaces shared PAT)
- OAuth chip in menu bar shows connection status; expired-token modal with one-click reconnect
- Read-only mode when no token is configured (public repo access)
- Fixes to data historic logic

---

## Version 1.6.0b–1.6.1b (14-Feb-26)
**Amplitude funnel export, dark mode**

**Create as chart in Amplitude.** Select nodes, click "Amplitude" in the Analytics panel, and DagNet dynamically constructs a correctly specified funnel in Amplitude — including event filters, context segments, cohort exclusions, and graph-derived conversion windows. Works with staging and production (auto-detected from graph connection). Requires the Amplitude Bridge browser extension (Chrome-family only). See user guide for details.

Also in this release:
- Cohort conversion window now derived from graph latency (`path_t95`), not hardcoded 30 days
- Connection-based project selection (no more hardcoded Amplitude project IDs)
- Session logging for the full Amplitude export flow
- Mixed-connection and non-Amplitude-node warnings
- Dark mode 🌙

---

## Version 1.5.1b–1.5.14b (9-Feb-26 to 13-Feb-26)
**Forecasting port & signature hardening**

- Forecasting engine ported from backend to frontend (multi-release effort); integrated code and graph directories
- Hash matching moved to frontend; various signature mapping fixes
- Staging environment support (amplitude-staging)
- Cohort fixing and t95 parity checks
- Git commit all fix
- setup.sh added for streamlined onboarding

---

## Version 1.4.15b
**Released:** 9-Feb-26

### Time-series analysis from snapshot data

Snapshot data now powers genuine time-series analysis. Every data retrieval is stored with its retrieval timestamp, cohort anchor dates, slice context, and conversion counts — building a longitudinal record that grows richer with each fetch.

- **Cohort Maturity charting**: new analysis type plotting conversion rate against retrieval date, showing how metrics evolve over time. One line per scenario; subject selector; full multi-scenario support.
- **`asat(...)` historical queries**: add `asat(5-Nov-25)` to any DSL query to read snapshot data as it was known at that date. Read-only; no side-effects.
- **Lag histogram and daily conversions**: distributions and daily volumes drawn directly from the snapshot database.
- **Multi-graph Retrieve All**: fetch and store data across all open graphs in one operation, building the snapshot archive faster.

### Historical file viewing

Open any file — graph, parameter, case, event, node, or context — as it was at a past git commit.

- Hover the `@` icon in the Navigator, or right-click → Open Historical Version, or use File menu
- Calendar picker highlights dates with commits; historical tabs open as read-only with `.asat(d-MMM-yy)` naming
- Combine with `asat()` queries to see old graph structure with old data in a single view

### Snapshot Manager

A diagnostic and management tool for the snapshot archive. Open via **Data > Snapshot Manager** or right-click any parameter/edge → **Manage...**.

- Browse parameters, see which signatures exist and how much data each holds
- Inspect, diff, download, or delete snapshot data at any granularity (by retrieval batch and slice)
- Create equivalence links between old and new signatures to preserve data continuity when query definitions change
- "View graph at DATE" opens the historical graph version and injects `asat()` automatically

### Other improvements

- Flexible signature matching via `core_hash` for resilient archival identity
- Window completeness fix
- Health indicator

---

## Version 1.4.0–1.4.0b (2-Feb-26 to 3-Feb-26)
**Snapshot database integration**

### Snapshot Database Integration (Project DB)

**Added: Snapshot data storage**
- Conversion data is now automatically stored in a database when fetching
- Enables historical analysis and time-series queries
- Each snapshot captures cohort anchor date, conversion counts, and timestamp

**Added: Lag histogram analysis**
- New analysis type showing the distribution of conversion lag times
- Visualise how long it takes users to convert after entering the funnel
- Available in the Analytics panel when snapshot data exists

**Added: Daily conversions analysis**
- New analysis type showing conversion counts by calendar date
- Track daily conversion volumes and identify trends
- Available in the Analytics panel when snapshot data exists

**Added: Snapshot availability in edge tooltips**
- Edge tooltips now show snapshot date range and row count
- Gap warnings (⚠) indicate missing days in snapshot history

**Added: Delete snapshots feature**
- Right-click edges or parameter files to delete stored snapshot data
- Shows count of snapshots that will be deleted

**Added: Gap warnings in charts**
- Lag histogram and daily conversions charts show warnings for sparse data
- Indicates missing days within the date range

Also: onset / lognormal distribution fitting improvements.

---

## Version 1.3.0b–1.3.16b (18-Jan-26 to 30-Jan-26)
**Fetch pipeline hardening & live charts**

- Live charts testing and working
- Subtle and extensive work on the fetch logic to improve and harden (with one serious signature regression outstanding); several important data retrieval fixes
- Fixed MECE context fetch regression (sigs); fixes to slice merge logic; fixed regression with fetching
- Stabilised t95 mechanics for deterministic fetch and calculations
- Re-built nudge machinery properly so it's less brittle and flakey
- Fixes to batch fetching and logging
- Upgraded signature matching and slice selection logic
- Added parens and other visible syntax to DSL display
- Fixed param assignment; fixed Ezra's bug; force update fixes
- Added workshop docs to Help menu

---

## Version 1.2.6b–1.2.9b (14-Jan-26 to 15-Jan-26)
**Share link fixes**

- Further fixes to tab sharing
- Minor fixes

---

## Version 1.2.x Series (13-Jan-26 to 14-Jan-26)
**Share links & live charts**

- Added sharing functionality and sharable link fixes
- Chron fixes and minor fixes

---

## Version 1.1.15b–1.1.31b (05-Jan-26 to 14-Jan-26)
**Stability + sharing rollout**

- Chart sharing and Playwright e2e verification
- Retrieval, sync, and forecasting fixes
- n_query fixes and evidence mode tweaks
- Sankey mode visual fixes and debugging badges
- Creds sharing and settings/auto-retrieval improvements

---

## Version 1.1.4b–1.1.14b (17-Dec-25 to 22-Dec-25)
**Dashboard + data pipeline hardening**

- Dashboard view and automation nudges
- Context and forecasting fixes
- Fetch and conservation fixes, semantic linting
- Bridge charts and settings UI

---

## Version 1.1.1b
**Released:** 17-Dec-25

I've done some tuning of the stats model. It's no longer spouting nonsense, and I think in general the tool is starting to provide some stable insight.

I still worry that while forecasts are probably OK, and older cohorts are OK, the 'tricky middle' remains we have small amounts of evidence in medium-mature cohorts. These are pulling the numbers down a bit too much.

This not a trivial issue to resolve and relates to how we're fitting latency distributions. I've made improvements this evening, and have some further bits planned, but for now, I'd say you'll get not insane but systematically somewhat conservative estimates for Reach Probability, when you query 2-4 weeks of cohort data at a time for partially mature cohorts.

---


## Version 1.1
**Released:** 16-Dec-25

### 📊 LAG Semantics: Stabilisation & Correctness

This release completes the Project LAG work begun in v1.0, hardening the statistical pipeline and fixing several regressions that affected `window()` vs `cohort()` semantics.

#### Completeness & Blending
- **Window vs Cohort completeness separation**: Completeness is now scoped to the query mode (`window(start:end)` or `cohort(start:end)`). This ensures evidence and completeness reflect the same temporal slice.
- **Upstream delay adjustment**: Cohort-mode completeness on downstream edges now accounts for anchor-to-source delay (soft prior→observed blend).
  - **Path-anchored cohort completeness (A→Y)**: maturity is computed for the full path from the cohort anchor (A) to the end of the edge (Y), rather than only the local segment (X→Y).
  - **Moment-matched path latency**: where upstream anchor latency is available, A→Y latency is derived via moment-matched convolution (Fenton–Wilkinson) of A→X and X→Y lognormal approximations, preventing downstream cohorts from appearing "too complete" too early.
  - **Tail pull using authoritative horizons**: completeness CDF fitting applies a one-way tail constraint using authoritative `path_t95` (or `t95` fallback) to avoid thin-tail fits that would overstate maturity for immature cohorts.
- **Evidence–Forecast blending**: Overhauled to use mode-specific completeness consistently, preventing over/underweighting of immature cohorts.
  - **Cohort evidence de-biasing for blending**: in cohort path-anchored mode, the blend uses a censoring-aware evidence estimate \((k/n)/completeness\) (clamped to \([0,1]\)) so right-censored cohorts don't unduly drag `p.mean` down.
  - **Observability**: additional LAG calculation detail is logged for completeness mode, authoritative t95 selection, tail-constraint application, and the evidence term used for blending.

#### Horizon Primitives (`t95` / `path_t95`)
- **`path_t95` moment-matched estimate**: When 3-step Amplitude lag arrays are available, DAGNet estimates `path_t95 ≈ t95(A→X + X→Y)` via Fenton–Wilkinson approximation, reducing over-greediness on deep DAGs.
- **Conservative fallback**: Falls back to topological accumulation of per-edge `t95` when lag arrays are absent.
- **Quality gate for fitting**: `t95` derivation now requires a minimum converter threshold (`MIN_CONVERTERS`) before treating empirical fits as reliable.

#### Amplitude Conversion Window (`cs`)
- **Cohort mode**: `cs` is driven by `path_t95` (or `t95` fallback) to avoid premature retrieval truncation.
- **Window mode**: A fixed 30-day `cs` is now applied to baseline window fetches, preventing accidental censoring by provider defaults.

### 🎨 Edge Rendering & Display
- Redesigned edge probability bar with solid (evidence) vs hatched (forecast) regions.
- Improved tooltip layout: shows probability ± stdev, n/k, window dates, completeness, median lag, and maturity status indicator.
- Non-latency edges now render correctly (no spurious latency beads).
- **E-only / F-only modes now show coherent sibling probabilities**: when a sibling group has any explicit evidence/forecast, missing sibling values are derived at render-time to keep outgoing probabilities sensible. Derived probability bead values are shown in **square brackets** (e.g. `E [0.61]`, `F [0.39]`), and edge widths/offsets use the same basis so geometry stays aligned.

### ⚡ Performance & Fetch Pipeline
- Unified single-fetch refactor: reduced redundant Amplitude calls.
- Cache-cutting improvements: smarter detection of missing date ranges.
- Refetch policy respects `t95` over legacy `maturity_days`.

### 📚 Documentation
- **LAG Statistics Reference** updated for window/cohort separation, completeness scoping, and `path_t95` estimation strategy.
- **Glossary** expanded: added `t95`, `path_t95`, anchor lag, moment matching, cohort horizon, cache cutting, sibling rebalancing.
- **Query DSL Guide** v2.1: added cohort window syntax and examples.
- **User Guide** updated to v1.0 conventions (LAG sections, copy/paste from Navigator, cohort windows).
- **Keyboard Shortcuts** updated with Navigator copy/paste and drag-and-drop actions.

### ⚙️ Migration Notes
- **Breaking:** `maturity_days` is no longer honoured for LAG fetch horizons or maturity/completeness logic. DagNet now derives horizons from `t95` / `path_t95` (with authoritative tail constraints) and will ignore legacy `maturity_days` values.
- If you have older parameter files that still include `maturity_days`, they can remain on disk but should be treated as historical/obsolete; the runtime will compute and use `t95` / `path_t95` instead.

---

## Version 1.0.x Series (10-Dec to 15-Dec-25)
**Post-Alpha Stabilisation**

Rapid iteration following the 1.0-alpha release, primarily bug fixes and LAG display improvements.

| Version | Date | Summary |
|---------|------|---------|
| 1.0.11b | 15-Dec-25 | Many fixes, t95 testing |
| 1.0.6b  | 11-Dec-25 | Fixes to logic & display |
| 1.0.3b  | 10-Dec-25 | Further cohort path_t95 fixes |
| 1.0.2b  | 10-Dec-25 | Added other clipboard staples; general fetch fixes |

---

## Version 1.0.0-alpha
**Released:** 10-Dec-25

### 🚀 Project LAG: The Temporal Shift

This release marks a key architectural evolution in DagNet's history. We are moving from a **static probability model** to a **temporal flow model**.

Previously, edges were instantaneous transitions ($P(B|A)$). With Project LAG, edges become time-consuming processes ($P(B|A, t)$). This enables:

- **Latency-Aware Forecasting**: We can now answer *"When will they convert?"* not just *"Will they convert?"*.
- **Partial Cohort Projection**: Distinguish between "users who haven't converted *yet*" (immature) and "users who churned".
- **Maturity Curves**: Visualise how conversion rates develop over time for each cohort.

#### Key Lag Features
- **Cohort Windows**: Select users by *entry date* using `cohort(start:end)`.
- **Daily Aggregation**: Automatically aggregates daily time-series data into windowed evidence ($n, k$).
- **Latency Beads**: New edge visualisation showing median lag days and cohort completeness.
- **Evidence vs Forecast**: Parameters now track both observed evidence ($p_{evidence}$) and projected mature probability ($p_{\infty}$).
- **Blended Probability**: Intelligent weighting of evidence and forecast based on completeness and sample size.
- **Inbound-N Convolution**: Forecast population (`p.n`) propagates step-wise through the graph.
- **Time-Series Storage**: Parameter files now store full daily histories (`n_daily`, `k_daily`) for historical analysis.

#### Documentation
- **LAG Statistics Reference**: Comprehensive technical reference available at `Help → Documentation → LAG Statistics Reference`.

### ⚡ Workflow Accelerators

To support the rapid iteration required for temporal modelling, we've overhauled the graph construction workflow:

- **Drag & Drop**:
  - Drag **Node files** from Navigator → Canvas to instantiate.
  - Drag **Node/Case files** → Existing nodes to re-bind/update.
  - Drag **Parameter files** → Edges to instantly attach data sources.
- **Copy & Paste**:
  - Full clipboard support for nodes, parameters, and cases.
  - Smart pasting onto edges (auto-attaches parameter).
- **Navigator 2.0**:
  - Fixed structural identity issues (no more stale closures).
  - Sticky headers and smooth animations.
  - Clear visual hierarchy with coloured section indicators.

### 🛠️ Core Improvements

- **Large File Handling**: Smart blocking prevents browser freeze on massive parameter files (>100KB), with "Open as YAML/JSON" fallbacks.
- **Data Sync Integrity**: Fixed race conditions where file-sync could overwrite fresh graph state.
- **Form Editor**: Performance optimisations for large schemas.

### ⚠️ Known Issues (Alpha)
- Scenario interactions with LAG (conditional probabilities, case allocations) have limited test coverage; treat as preview.
- Very large graphs (>50 nodes) may see render lag during drag operations.

---

## Version 0.99.x Series (1-Dec to 9-Dec-25)
**Pre-Alpha Stabilisation**

Final push towards 1.0-alpha, focusing on LAG infrastructure and workflow polish:

### Features
- **Drag & Drop**: Nodes and parameters from Navigator to Canvas
- **Live Scenarios**: Real-time scenario switching with param pack updates
- **Graph Issues Viewer**: Visual display of graph integrity problems
- **"Where Used" Feature**: Track parameter and node references across files
- **Sample Files**: Production-quality example data for onboarding

### Fixes
- Conditional probability handling completely overhauled
- MSMDC query generation fixes
- Python schema parity issues resolved
- Data retrieval pipeline stabilised (multiple rounds of fixes)

---

## Version 0.98.x Series (27-Nov to 30-Nov-25)
**Super Funnels & Data Pipeline**

Major improvements to Amplitude query generation:

### Features
- **Super Funnels**: Automatic dual-query execution for complex parent nodes
- **n_query Logic**: Handles non-discriminable parent node situations
- **Session Logging**: DAS run visibility for debugging

### Fixes
- Extensive data fetching bug fixes
- Menu consolidation and UI cleanup

---

## Version 0.96–0.97 Series (26-Nov to 27-Nov-25)
**Analytics & Conditional Queries**

### Features
- **Analytics v2.0**: Redesigned analytics panel
- **Super Funnel Mode**: Upstream `visited()` conditional_p DSL queries
- Edge conditionality through query DSL (no `excludes()` terms)

---

## Version 0.95b (25-Nov-25)
**Contexts & Time Windows**

### 🎯 Major Features
- **Contexts v1.0**: Full context support for data segmentation
  - Define contexts (channel, device-family, browser-type) in YAML files
  - Use `context()` in DSL to filter by single values
  - Use `contextAny()` to aggregate multiple values
  - MECE partition support with configurable `otherPolicy`
- **Time Windows**: `window()` function for time-bounded queries
  - Relative windows: `window(-30d:)` for last 30 days
  - Absolute windows: `window(1-Jan-25:31-Mar-25)`
- **SHA-Based Commit Detection**: Reliable uncommitted change detection

### 🐛 Bug Fixes
- Commit modal reliability improvements
- Logging and verbose output reduction

---

## Version 0.93–0.94 Series (21-Nov to 24-Nov-25)
**Data Pipeline & Node Features**

### Features
- **Images & URLs on Nodes**: Visual node customisation
- **Multi-Parental Nodes**: Amplitude retrieval for complex graph structures

### Fixes
- Registry and git synchronisation improvements
- Caching signature cleanup
- Numerous data pipeline bugs resolved

---

## Version 0.92.x Series (19-Nov to 20-Nov-25)
**Google Sheets Integration**

### Features
- **Google Sheets v2**: Sophisticated programmatic retrieval with param pack labelling
- **Reindexing**: Node and edge param pack copying
- **Form Editor**: Improved aesthetics

### Fixes
- File registry update bugs
- File interaction and event management issues

---

## Version 0.91b
**Released:** 18-Nov-24

### 🎯 Major Features
- **Initial Credentials Setup**: New installations can bootstrap credentials using a server secret
- **Smart Node ID Renaming**: Automatic cascade updates to edges, queries, and conditions when renaming nodes
- **Comprehensive Testing**: 493 tests passing (375 TypeScript + 118 Python)

### ✨ Enhancements
- **Default "Start" Node**: New graphs automatically include a starter node
- **Enhanced Selector Improvements**: Better debouncing and validation for node ID changes
- **Scenario Layer Visibility**: "Current" layer now defaults to visible
- **Google Sheets Authentication**: Full service account integration with proper mocking

### 🐛 Bug Fixes
- Fixed drag flag getting stuck during node operations
- Fixed snapshot creation affecting all open graphs instead of just active one
- Fixed edge ID deduplication during node renames
- Fixed EnhancedSelector dropdown interaction issues

### 🧪 Testing
- Added comprehensive UpdateManager graph-to-graph tests
- Added Google Service Account authentication tests
- All 375 JavaScript/TypeScript tests passing
- All 118 Python tests passing

### 📚 Documentation
- Completely rewrote user guide with all current features
- Added version management documentation
- Updated all help docs to reflect current functionality

---

## Version 0.90b
**Released:** October 2024

### 🎯 Major Features
- Initial beta release
- Core graph editing functionality
- Parameter registry system
- Scenario management
- Git integration
