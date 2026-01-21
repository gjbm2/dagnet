# DagNet Release Notes
## Version 1.3.11b
**Released:** 21-Jan-26

Re-built nudge machinery properly so it's less brittle and flakey.

---

## Version 1.3.10b
**Released:** 21-Jan-26

Logging fixes

---

## Version 1.3.8b
**Released:** 20-Jan-26

fix

---

## Version 1.3.7b
**Released:** 20-Jan-26

Added workshop docs to Help menu

---

## Version 1.3.6b
**Released:** 20-Jan-26

Fixed Ezra's bug

---

## Version 1.3.5b
**Released:** 20-Jan-26

force update fixes

---

## Version 1.3.4b
**Released:** 20-Jan-26

Subtle and extensive work on the fetch logic to improve and harden in (with one serious signature regression still outstanding); several important data retrieval fixes.

---

## Version 1.3.3b
**Released:** 19-Jan-26

Fixes to slice merge logic

---

## Version 1.3.2b
**Released:** 19-Jan-26

Fixed MECE context fetch regression (sigs)

---

## Version 1.3.1b
**Released:** 19-Jan-26

Fixed regression with fetching

---

## Version 1.3.0b
**Released:** 18-Jan-26

Live charts testing & working

---

## Version 1.2.9b
**Released:** 15-Jan-26

Further fixes to tab sharing

---

## Version 1.2.6b
**Released:** 14-Jan-26

Minor fixes

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
  - **Moment-matched path latency**: where upstream anchor latency is available, A→Y latency is derived via moment-matched convolution (Fenton–Wilkinson) of A→X and X→Y lognormal approximations, preventing downstream cohorts from appearing “too complete” too early.
  - **Tail pull using authoritative horizons**: completeness CDF fitting applies a one-way tail constraint using authoritative `path_t95` (or `t95` fallback) to avoid thin-tail fits that would overstate maturity for immature cohorts.
- **Evidence–Forecast blending**: Overhauled to use mode-specific completeness consistently, preventing over/underweighting of immature cohorts.
  - **Cohort evidence de-biasing for blending**: in cohort path-anchored mode, the blend uses a censoring-aware evidence estimate \((k/n)/completeness\) (clamped to \([0,1]\)) so right-censored cohorts don’t unduly drag `p.mean` down.
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


