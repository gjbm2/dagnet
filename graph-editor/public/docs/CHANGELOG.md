# DagNet Release Notes
## Version 1.0.3b
**Released:** December 10, 2025

Further cohort path_t95 fixes

---

## Version 1.0.2b
**Released:** December 10, 2025

Added the other clipboard staples; general fetch fixes

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
  - Absolute windows: `window(2025-01-01:2025-03-31)`
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


