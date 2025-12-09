# DagNet Release Notes

## Version 1.0.0-alpha
**Released:** 9-Dec-25

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
- **Time-Series Storage**: Parameter files now store full daily histories (`n_daily`, `k_daily`) for historical analysis.

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
- Latency convolution (projecting delays downstream) is in preview.
- Very large graphs (>50 nodes) may see render lag during drag operations.

---

## Version 0.99.19b
**Released:** 9-Dec-25

1.0 pre-release (drag & drop, exclude test users features)

---

## Version 0.99.15b
**Released:** December 04, 2025

Proper sample files

---

## Version 0.99.13b
**Released:** December 03, 2025

Rebalancing regression fix

---

## Version 0.99.12b
**Released:** December 03, 2025

Finally: fixes to conditional ps (among other things)

---

## Version 0.99.11b
**Released:** December 03, 2025

GRaph issues viewer

---

## Version 0.99.10b
**Released:** December 03, 2025

Fixes to MSMDC

---

## Version 0.99.9b
**Released:** December 03, 2025

Live scenarios

---

## Version 0.99.8b
**Released:** December 02, 2025

Fixed py Schema issues which was preventing query generation

---

## Version 0.99.6b
**Released:** December 02, 2025

Where used feature

---

## Version 0.99.5b
**Released:** December 02, 2025

Lots of further data retrieval fixes; sketch of lag convolution

---

## Version 0.99.3b
**Released:** December 01, 2025

Fetch logic bug fixes

---

## Version 0.99.1b
**Released:** December 01, 2025

Significantly cleared up messes in data retrieval

---

## Version 0.99.0b
**Released:** November 30, 2025

Menu clear up, various fetch fixes (some still outtanding), chevron-a-go-go

---

## Version 0.98.6b
**Released:** November 29, 2025

Many fixes of fetching behaviour which was buggy af

---

## Version 0.98.2b
**Released:** November 28, 2025

Fixed algo

---

## Version 0.98.1b
**Released:** November 28, 2025

Added n_query logic to accommodate complex non-discriminaable parent node situations

---

## Version 0.98.0b
**Released:** November 27, 2025

Super funnels now run dual queries automatically to aggregate for incipient N.

---

## Version 0.97.1b
**Released:** November 27, 2025

Add Session logging for DAS runs

---

## Version 0.97.0b
**Released:** November 27, 2025

Super-funnels now recompile without excludes() terms, allowing direct edge conditionality through the query dsl

---

## Version 0.96.3-beta
**Released:** November 27, 2025

Ezra bugs: added new 'super funnel' mode for upstream visited() conditional_p dsl queries

---

## Version 0.96b
**Released:** November 26, 2025

Analytics v2.0 up and running

---

## Version 0.95.5-beta
**Released:** November 25, 2025

Repo and dirty fixes. Reduced verbose logs

---

## Version 0.95.4-beta
**Released:** November 25, 2025

Commit bug fix

---

## Version 0.95.3-beta
**Released:** November 25, 2025

Commit bug fix

---

## Version 0.95.2-beta
**Released:** November 25, 2025

Logging & full data retrieval feature.

---

## Version 0.95b
**Released:** November 25, 2025

### 🎯 Major Features
- **Contexts v1.0**: Full context support for data segmentation
  - Define contexts (channel, device-family, browser-type) in YAML files
  - Use `context()` in DSL to filter by single values
  - Use `contextAny()` to aggregate multiple values
  - MECE partition support with configurable `otherPolicy`
  - Weighted aggregation across context segments
- **Time Windows**: `window()` function for time-bounded queries
  - Relative windows: `window(-30d:)` for last 30 days
  - Absolute windows: `window(2025-01-01:2025-03-31)`
- **SHA-Based Commit Detection**: More reliable detection of uncommitted changes
  - Compares local content SHA to stored remote SHA
  - Works reliably across page refreshes

### 🐛 Bug Fixes
- Fixed commit modal not showing all changed files after page refresh
- Fixed duplicate files appearing in commit modal

We are nearing RC1!

---

## Version 0.94.2-beta
**Released:** November 24, 2025

Cleaned up project significantly. Fixes. 

---

## Version 0.94.1-beta
**Released:** November 24, 2025

Many registry and git fixes

---

## Version 0.94b
**Released:** November 23, 2025

Images and URLs on nodes

---

## Version 0.93b
**Released:** November 21, 2025

Fairly significant debugging. Amplitude retrieve now works for complex multi-parental nodes. Also resolved a number of dsync defects, cleaned up caching signatures and fixed a ton of smaller data pipeline bugs. 

---

## Version 0.92.4-beta
**Released:** November 20, 2025

Fixed Google sheets, Added reindexing and copying of node and edge param packs.

---

## Version 0.92.1-beta
**Released:** November 20, 2025

Prettier forms. Just for you, Ezra.

---

## Version 0.92b
**Released:** November 20, 2025

Fairly significant update to allow much more sophisticated programmatic retrieval from Google Sheets -- makes it possible to pull in data ranges with param packs properly labelled.

Also fixed a whole spate of bugs related to file interactions and event management. Still nea better UI schema for events and params, but... progress.

---

## Version 0.91.10-beta
**Released:** November 19, 2025

Bug: file registries weren't updating properly. Now resolved.

---

## Version 0.91.9-beta
**Released:** November 19, 2025

Added _this_ changelog. Meta.

---

## Version 0.91.7-beta
**Released:** November 19, 2025

Fixing init stuff to make it all nice & easy to get started. So never say I don't do nice stuff for you.

---

## Version 0.91b
**Released:** November 18, 2024

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


