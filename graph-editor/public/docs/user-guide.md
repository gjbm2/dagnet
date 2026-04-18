# DagNet User Guide

**Version 2.0 Beta** | [Changelog](CHANGELOG.md)

## Getting Started

### What is DagNet?

DagNet is an **evidence-conditioned forecasting platform** built on a visual graph editor.

It answers the question that actually matters about your conversion funnel: **"What's actually happening, and what should I expect?"** — with calibrated confidence, automatically, every day.

DagNet **observes** (every data retrieval is stored, building a longitudinal evidence record), **learns** (a Bayesian inference engine fits statistical models nightly), **forecasts** (conditioned on fitted models, with honest uncertainty bands), and **presents** (live charts and analytics on a freeform canvas workspace).

Every edge in your graph models not just *probability* but *latency* — the time it takes for users to complete each step. Where Bayesian posteriors are available, forecasts are conditioned on real evidence with calibrated uncertainty. Where they're not, analytic estimates provide instant results.

### First Steps

1. **Open the Navigator** - Click the Navigator button or use `Ctrl/Cmd + B`
2. **Load Credentials** - Go to `File > Credentials` to configure your Git repositories
3. **Browse Files** - Use the Navigator to explore graphs, parameters, contexts, and cases
4. **Open a Graph** - Double-click any graph file to start editing
5. **Set a Cohort Window** - Use the date picker to select which users to analyse by entry date

## Core Concepts

### Graphs
- **Nodes**: Conversion steps, decision points, or events in the user journey
- **Edges**: Probabilistic transitions between nodes (with optional latency)
- **Layout**: Visual arrangement optimised for flow visualisation

### Parameters & Evidence
- **Mean & Stdev**: Core probability parameters for each edge
- **Evidence (n, k)**: Sample size and successes from real data
- **Cohort Windows**: Date ranges for when users *entered* the funnel
- **Latency**: Time-to-convert distribution (median lag, maturity days)

### What-If Analysis
- **Override Values**: Change any parameter to see downstream impact
- **Path Analysis**: Trace probability mass through multi-path flows
- **Conditional Probabilities**: Model `visited()` and `exclude()` dependencies

## Working with Graphs

### Creating Graphs
1. **New Graph**: `File > New Graph` or `Ctrl/Cmd + Shift + N`
2. **Add Nodes**: Drag from the node palette or double-click empty space
3. **Connect Nodes**: Drag from one node to another to create edges
4. **Set Probabilities**: Use the Properties panel to adjust edge weights

### Rapid Graph Building (New in 1.0)

**Copy & Paste from Navigator:**
1. Right-click a node file in the Navigator and select **Copy**
2. Right-click on the canvas and select **Paste node** to create a new node
3. Or right-click an existing node and select **Paste node** to replace its definition
4. For edges: copy a parameter file, then right-click an edge and select **Paste parameter**

**Drag & Drop:**
1. Drag any node file from the Navigator onto the canvas to create a new node
2. Drag a node file onto an existing node to replace its definition
3. Drag a parameter file onto an edge to attach and fetch data
4. Drag case or event files onto nodes to assign IDs

### Editing Nodes
- **Select**: Click on a node to select it
- **Move**: Drag nodes to reposition them
- **Resize**: Use the resize handles on selected nodes
- **Delete**: Press `Delete` key or right-click menu

### Editing Edges
- **Select**: Click on an edge to select it
- **Adjust Weight**: Use the Properties panel or drag the probability slider
- **Attach Parameter**: Drag a parameter file from Navigator onto the edge
- **Delete**: Press `Delete` key or right-click menu

### Viewing Edge Evidence
Hover over any edge to see a tooltip with:
- Current probability (mean ± stdev)
- Evidence statistics (n, k)
- Window dates (when data was collected)
- Last retrieval timestamp

For LAG-enabled edges, tooltips also show:
- **Median lag**: Typical time to convert (e.g., "~5.2 days")
- **Completeness**: Percentage of expected conversions observed
- **Evidence vs Forecast**: Breakdown of observed vs projected conversions
- **Maturity status**: Green/amber/red indicator of cohort maturity

If snapshot history is available for the edge parameter, the tooltip also shows:
- **Snapshot date range**: Earliest to latest cohort dates with stored data
- **Row count**: Total number of snapshot records stored
- **Gap warning**: ⚠ indicator if there are missing days in the snapshot history

## What-If Analysis

### Setting Overrides
1. **Open What-If Panel**: `Ctrl/Cmd + Shift + W` or click the What-If button
2. **Select Parameters**: Choose which parameters to override
3. **Set Values**: Enter new values for selected parameters
4. **View Impact**: See how changes affect the overall conversion funnel

### Path Analysis
1. **Select Nodes**: Click on start and end nodes
2. **Open Path Analysis**: `Ctrl/Cmd + Shift + P` or click the Path Analysis button
3. **View Results**: See conversion rates, bottlenecks, and optimisation opportunities

### Conditional Probabilities
- **Enable Conditionals**: Turn on conditional probability features
- **Set Conditions**: Define when different probabilities apply
- **Test Scenarios**: Use What-If to test different conditional states

## How Forecasting Works

DagNet uses a **two-tier forecasting architecture**:

1. **Bayesian (primary)**: A nightly MCMC engine fits statistical models to your conversion data, producing posterior probability, latency parameters, and calibrated uncertainty bands. When a good-quality posterior exists and the Python backend is reachable, the **conditioned forecast** — a Monte Carlo population model conditioned on snapshot evidence — drives `p.mean` directly for each edge.

2. **Analytic (fallback)**: An instant browser-side statistics pass computes estimates from the same underlying data. Always available, even offline. This is what you see when a graph is first opened, when no Bayesian fit has run yet, or when the backend is unreachable.

The transition is seamless: the FE analytic estimate appears immediately, and the BE conditioned forecast replaces it within seconds when available. Each edge shows a **model source indicator** (analytic / bayesian / manual) so you always know which source is driving the numbers.

The [forecasting settings](forecasting-settings.md) knobs (recency half-life, blend lambda, completeness power, etc.) govern the **analytic pipeline only**. When the Bayesian conditioned forecast is active for an edge, those knobs do not apply — the posterior drives `p.mean` directly.

The sections below describe [Bayesian Model Fitting](#bayesian-model-fitting) (the primary pipeline) and [Latency-Aware Graphs](#latency-aware-graphs-lag) (the analytic pipeline and the underlying latency concepts that both pipelines share).

---

## Bayesian Model Fitting

DagNet includes a Bayesian inference engine that automatically fits statistical models to your conversion data. When enabled, this produces posterior distributions with calibrated uncertainty — replacing point estimates with honest forecasts.

### How It Works

The Bayesian compiler fits models in **two phases**:

1. **Phase 1 (window mode)**: Fits per-edge conversion rates and latency using Beta/Binomial likelihoods at step-day granularity
2. **Phase 2 (cohort mode)**: Reuses Phase 1 posteriors as priors and fits cohort-level rates with Dirichlet/Binomial likelihoods at branch groups

When context-segmented data is available, **Phase C** (slice pooling) fits hierarchical Dirichlet priors that produce per-context posterior distributions while sharing strength across slices.

### Triggering a Bayes Run

- **Manual**: Right-click a graph → **Run Bayes** to submit a fit for the current graph
- **Automatic**: Enable the `runBayes` flag on a graph to include it in nightly automation. After the daily data fetch completes, Bayes fits are submitted automatically

### Quality Tiers

After a Bayes run completes, each edge receives a **quality tier** based on MCMC diagnostics:

| Tier | Meaning |
|------|---------|
| **Good** | Converged, adequate effective sample size |
| **Fair** | Minor convergence warnings |
| **Poor** | Convergence issues — use with caution |
| **Very poor** | Failed convergence — results unreliable |

Quality tiers are shown in the Bayesian Posterior Card (click the Bayes indicator on an edge), in the operations toast when a fit completes, and in the session log. Poor/very poor results show an amber warning that persists until dismissed.

### Model Source Preference

Each edge can have multiple candidate model sources in its `model_vars` array:

- **Analytic**: From the FE statistics pass (instant, always available)
- **Bayesian**: From MCMC posterior fitting (higher quality, requires a completed run)
- **Manual**: From user override

The `model_source_preference` setting (per-edge or graph-level) controls which source is promoted to the active `p.mean`/`p.stdev`. Options: `best_available` (default — prefers Bayesian if available), `bayesian`, `analytic`, `manual`.

### When Does Bayes Replace the Analytic Estimate?

When `model_source_preference` is `best_available` (the default) and a Good or Fair Bayesian posterior exists for an edge, the backend **conditioned forecast** takes over:

- The MC population model reads full maturity trajectories from the snapshot database
- It produces `p.mean` directly — the analytic blend formula is not used
- Latency parameters (mu, sigma, t95) come from the posterior's fit, not from moment-matching
- The [forecasting settings](forecasting-settings.md) knobs (RECENCY_HALF_LIFE, BLEND_LAMBDA, COMPLETENESS_POWER) do not participate for that edge

If the backend is unreachable, or during the brief interval before the BE responds, the FE uses the promoted Bayesian model_vars entry in the analytic blend — the posterior's parameters feed the blend formula, giving a close approximation until the conditioned forecast arrives.

### Two-Tier Forecasting

DagNet uses a **two-tier architecture** for forecasting:

1. **FE quick pass** (instant): The frontend analytics pass runs in the browser the moment you open a graph or change a query. It uses the promoted model source's parameters (Bayesian if available, analytic otherwise) and the blend formula to produce immediate results. Always available, even offline.

2. **BE conditioned forecast** (seconds): When the Python backend is reachable and Bayesian posteriors exist, the backend runs a full MC population model conditioned on snapshot evidence. This produces higher-quality `p.mean` values that replace the FE estimates. The replacement happens automatically and seamlessly.

The UI indicates which tier you're seeing via a quality indicator on each edge and analysis result. When the BE result arrives, the graph updates in place — no manual refresh needed.

### Model Adequacy (LOO-ELPD)

After fitting, DagNet computes **LOO-ELPD** (Leave-One-Out Expected Log Predictive Density) per edge. This measures whether the Bayesian model actually improves on analytic point estimates:

- **Positive ΔELPD**: The Bayesian model adds value
- **Negative ΔELPD**: The analytic estimate is better — the model may be overfitting or misspecified

LOO-ELPD results appear in the **Forecast Quality overlay**, the **Edge Info Model tab**, and the **PosteriorIndicator** popover.

### Confidence Bands

On cohort maturity charts, Bayesian posteriors produce **confidence bands** — shaded regions showing the credible interval around the model curve. Configurable via the `bayes_band_level` display setting: off, 80%, 90%, 95%, or 99%.

---

## Latency-Aware Graphs (LAG)

> The following describes the **analytic pipeline** — the instant browser-side statistics pass. The concepts of latency, completeness, and maturity apply to both the analytic and Bayesian pipelines, but the blend formula described here is specific to the analytic source. When Bayesian posteriors are active, the conditioned forecast replaces the analytic blend — see [Bayesian Model Fitting](#bayesian-model-fitting) above.

### Understanding Latency

Traditional conversion funnels treat edges as instantaneous: users either convert or they don't. But in reality, **conversion takes time**. A user who signed up today might not purchase for another 3 weeks.

**LAG** (Latency-Aware Graphs) models this timing. Each edge can have:
- **Median lag**: The typical time to convert (e.g., 5 days)
- **Maturity days**: How long to wait before considering a cohort "complete" (e.g., 30 days)

### Evidence vs Forecast

In the analytic pipeline, edge probabilities split into two components:

| Metric | Meaning |
|--------|---------|
| **Evidence** | What we've *observed* — users who have already converted |
| **Forecast** | What we *expect* — projected conversions based on the lag model |

When a cohort is immature (recent entry date, not enough time has passed), the evidence is incomplete. The analytic pipeline uses the historical lag distribution to forecast how many more will convert, then blends evidence and forecast based on completeness and sample size.

When a Bayesian posterior is active for an edge, `p.mean` comes from the conditioned forecast model rather than this blend. The evidence/forecast split is still visible in the UI for transparency.

### Reading Edge Display

On the canvas, LAG-enabled edges show:
- **Probability bar**: A horizontal bar showing conversion rate
  - **Solid portion**: Evidence (observed conversions)
  - **Faded/striped portion**: Forecast (projected additional conversions)
- **Completeness indicator**: Shows what percentage of eventual conversions have occurred
- **Median lag**: Displayed as "~5d" meaning typical conversion time is 5 days

### Maturity Indicators

Edge tooltips show maturity status:
- **Green**: Cohort is mature (completeness > 95%)
- **Amber**: Cohort is maturing (completeness 50-95%)
- **Red**: Cohort is immature (completeness < 50%)

Immature cohorts have higher uncertainty in their final conversion rates.

## Cohort Windows (New in 1.0)

### Understanding Cohorts
A **cohort** is a group of users who entered the funnel during a specific date range. Cohort-based analysis allows you to:
- Track conversion rates for specific time periods
- Compare cohort performance over time
- See how recent changes affect new users

### Setting a Cohort Window
1. **Open the Date Picker**: Click the date range selector in the toolbar
2. **Select Start Date**: Choose when the cohort period begins
3. **Select End Date**: Choose when the cohort period ends
4. **Apply**: Click Apply to fetch data for the selected window

### Cohort DSL Syntax
You can also set cohort windows in the Query DSL:
```
cohort(1-Dec-25:7-Dec-25)
```
This selects users who entered the funnel between 1st and 7th December 2025.

### Viewing Cohort Evidence
When a cohort window is active:
- **Edge Tooltips**: Show aggregated n, k, and mean for the window
- **Properties Panel**: Displays detailed evidence with window dates
- **Evidence Fields**: `window_from` and `window_to` show the date range

### Daily Aggregation
Data is automatically aggregated from daily breakdowns:
- Daily n/k values are summed within the window
- Mean probability is recalculated: k ÷ n
- Standard deviation is computed from the aggregated data

### Tips for Cohort Analysis
- **Exclude Recent Days**: Very recent cohorts may have incomplete conversions
- **Consistent Windows**: Use the same window size when comparing periods
- **Check Evidence**: Larger n values give more reliable probability estimates

## Snapshot Data Storage

### What is Snapshot Storage?

When you fetch data for an edge parameter, DagNet can store a **snapshot** of the raw conversion data in a database. This enables:
- **Historical analysis**: Query how data looked at any point in time
- **Lag histogram analysis**: See the distribution of conversion lag times
- **Daily conversions tracking**: Track conversion volumes by calendar date
- **Gap detection**: Identify missing data in your time series

### When Snapshots are Stored

Snapshots are written automatically when:
1. **Fetching data**: When you refresh edge data from Amplitude or other sources
2. **Window expansion**: When your cohort window includes days without existing snapshots

Each snapshot stores:
- **Cohort anchor date**: The entry date for that cohort
- **Conversion counts**: Number of users who converted (Y) and total users (N)
- **Timestamp**: When the snapshot was recorded

### Viewing Snapshot Availability

You can see snapshot availability in several places:
- **Edge tooltips**: Shows date range and row count when you hover over an edge
- **Context menus**: Shows "Delete snapshots (X)" with the count
- **Gap warnings**: ⚠ indicators show when there are missing days

### Managing Snapshots

**Snapshot Manager**: Open via **Data > Snapshot Manager**, or right-click an edge/parameter and select **Manage...** from the snapshots submenu. The Snapshot Manager is a parameter-first diagnostic tool with three columns:

1. **Parameter list** (left): Browse all parameters with snapshot data. Optionally filter by graph using the dropdown at the top.
2. **Signature timeline** (centre): After selecting a parameter, see all its signatures listed chronologically. Each card shows the signature hash, creation date, query mode (cohort/window), snapshot count, date range, and total rows. Click to select; shift-click a second signature to compare.
3. **Detail / Links / Data** (right): Three tabs for working with the selected signature:
   - **Detail**: View `inputs_json` in a Monaco editor (or diff two signatures side-by-side). Action buttons let you view the historical graph at the signature's date, download or delete snapshot data, or create a new link.
   - **Links**: View existing signature equivalence links and create new ones. Use the "Same parameter" shortcut or search for a different parameter to link across.
   - **Data**: Table of retrieval batches grouped by `(retrieved_at, slice_key)`, showing anchor date range, row count, Σ n, Σ k, and slice ID. Select rows to download or delete specific batches.

**Quick actions from context menus**:
- **Delete snapshots**: Right-click an edge or parameter → Delete snapshots to remove all stored data
- **Download snapshots**: Right-click an edge or parameter → Download snapshots to export as CSV
- **Manage...**: Right-click an edge or parameter → Manage... to open the Snapshot Manager pointing at that parameter

### Gap Warnings

When snapshot data has gaps (missing days), you'll see warnings:
- **In edge tooltips**: "⚠ X days missing"
- **In analysis charts**: Yellow warning banner showing sparse data details

Gaps may indicate:
- Data fetching was interrupted
- Source data wasn't available for those dates
- Cohort windows didn't cover certain periods

## Analytics Panel

### Opening Analytics
Click the **Analytics** button in the sidebar (bar chart icon) or use the keyboard shortcut to open the Analytics panel.

### Query DSL
The Analytics panel shows the current query as a DSL expression. You can:
- **View the auto-generated query**: Based on your node selection
- **Edit the query**: Click to modify the DSL directly
- **Override mode**: Toggle to manually control the query

### Available Analyses

| Analysis | Description |
|----------|-------------|
| **Reach Probability** | Probability of reaching selected node(s) from the anchor |
| **Conversion Funnel** | Step-by-step breakdown of conversion through a path |
| **Path Comparison** | Compare conversion rates across different paths |
| **Lag Histogram** | Distribution of conversion lag days from snapshot history |
| **Daily Conversions** | Conversion counts by calendar date from snapshot history |
| **Cohort Maturity** | How conversion rates evolve over time for a cohort range |

### Snapshot-Based Analyses

The **Lag Histogram**, **Daily Conversions**, and **Cohort Maturity** analyses work differently from other analysis types — they query historical snapshot data rather than computing from the current graph state.

#### Lag Histogram

Shows the distribution of how long it takes users to convert after entering the funnel:
- **X-axis**: Lag in days (0 = same day, 1 = next day, etc.)
- **Y-axis**: Number of conversions
- **Percentages**: Each bar shows what portion of total conversions occurred at that lag

Use this to understand:
- Whether conversions happen quickly or are spread over time
- The median and typical lag times
- Long-tail conversion patterns

#### Daily Conversions

Shows conversion counts by calendar date:
- **X-axis**: Calendar dates
- **Y-axis**: Number of conversions attributed to that date
- **Date range**: From earliest to latest snapshot data

Use this to understand:
- Daily conversion volumes over time
- Seasonality and trends
- Impact of campaigns or changes

#### Cohort Maturity

Shows how conversion rates evolve over successive snapshot retrieval dates:
- **X-axis**: Snapshot retrieval dates (when data was fetched)
- **Y-axis**: Conversion rate for the selected cohort range
- **Lines**: One line per visible scenario
- **Subject selector**: Choose which parameter/edge to chart

Use this to understand:
- Whether conversion rates are improving or declining over time
- How stable your funnel metrics are
- Differences between scenarios at each point in time

#### Gap Warnings

Both snapshot analyses display a warning banner when data is sparse:
- Shows how many days are missing within the date range
- Indicates the data may not be representative
- Suggests fetching more data to fill gaps

### Multi-Scenario Analysis
The Analytics panel respects scenario visibility:
- Only **visible scenarios** are included in analysis
- Each scenario can have a different **visibility mode** (F+E, F only, E only)
- Results show per-scenario values with appropriate labels

### Visibility Modes

| Mode | Description | Use Case |
|------|-------------|----------|
| **F+E** | Blended probability from the active model source (Bayesian posterior when available, analytic blend otherwise) | Best overall estimate |
| **F only** | Forecast probabilities | Long-term baseline |
| **E only** | Evidence probabilities | What's actually happened |
| **Hidden** | Excluded from analysis | Temporarily hide a scenario |

Toggle visibility modes using the eye icons in the Scenarios panel.

**Note on sibling edges in E-only / F-only:** if a sibling group has any explicit evidence/forecast, DagNet will derive the missing sibling probabilities at render-time so outgoing probabilities remain coherent. Derived probability bead values are shown in **square brackets** (e.g. `E [0.61]`, `F [0.39]`), and the canvas geometry (edge widths/offsets/labels) uses the same basis.

### Interpreting Results

Analysis results include:
- **Probability**: Conversion rate for each scenario
- **Probability label**: Shows which basis was used (Evidence/Forecast/Probability)
- **Confidence**: Based on sample size (n) and completeness

When scenarios have different visibility modes, the probability label will differ per scenario.

### Create as Chart in Amplitude

DagNet can construct a correctly specified Amplitude funnel from your selected nodes and open it directly in Amplitude for exploration, slicing, saving, and sharing.

**How to use:**

1. **Select nodes** — Cmd+click (Ctrl+click on Windows) the nodes you want as funnel steps.
2. **Open the Analytics panel** — click the bar-chart icon in the right sidebar.
3. **Click "Amplitude"** — the button appears at the top right of the panel.
4. A new browser tab opens with the funnel pre-built in Amplitude. You can explore it, change date ranges, add breakdowns, save it to a space, or share it with colleagues.

**What's included in the export:**

The chart carries over your graph's full query context: event filters, date range (window or cohort), context segments (e.g. channel), What-If constraints (`visited`, `exclude`, `case`), cohort exclusions, and a conversion window derived from graph latency data. Staging vs production is auto-detected from the graph's connection.

**Browser extension (one-time setup):**

This feature requires the **Amplitude Bridge** extension for Chrome-family browsers (Chrome, Edge, Brave, Arc). The first time you click the Amplitude button, DagNet walks you through installation:

1. Download the extension folder (DagNet provides a link).
2. Open `chrome://extensions` in your browser, enable "Developer mode".
3. Click "Load unpacked" and select the downloaded folder.
4. That's it — the extension runs silently in the background. It simply allows DagNet to create chart drafts using your existing Amplitude login session. It does not access any other data, and you can inspect its source code (it's a small open file in the DagNet repo under `extensions/amplitude-bridge/`).

The extension only activates when DagNet explicitly requests a chart creation. It has no background activity, no tracking, and no permissions beyond the Amplitude domain.

**Staging and production:**

DagNet reads which Amplitude connection your graph edges use and creates the chart in the matching project. Switch between environments by changing the connection in the graph properties panel.

## File Management

### Opening Files
- **From Navigator**: Double-click any file in the Navigator
- **From Menu**: `File > Open` or `Ctrl/Cmd + O`
- **Recent Files**: `File > Open Recent` or `Ctrl/Cmd + Shift + O`

### Saving Changes
- **Auto-Save**: Changes are automatically saved to IndexedDB
- **Commit Changes**: Use the commit system to save to Git repositories
- **Export**: Save graphs as JSON or YAML files

### Working with Git
- **Configure Credentials**: Set up repository access in `File > Credentials`
- **Pull Latest**: Get the latest changes from remote repositories
- **Commit Changes**: Save your changes to the repository
- **Branch Management**: Create and switch between branches

### Viewing Historical Versions

You can open any file (graph, parameter, case, event, node, or context) as it was at a past git commit. This is useful for understanding how a graph or parameter has changed over time, or for comparing current state against a historical baseline.

**Three ways to access historical versions:**

1. **Navigator @ icon**: Hover over any file in the Navigator to reveal an `@` icon. Click it to open a calendar picker with commit dates highlighted. Click a date to open that version.

2. **Context menus**: Right-click a file in the Navigator or a tab → select "Open Historical Version". A submenu shows dates with commits — select one to open.

3. **File menu**: File → Open Historical Version provides the same date-based submenu for the active file.

**How it works:**
- Historical versions open in a temporary read-only tab
- Tab titles use the `.asat()` convention: e.g. `conversion-flow.asat(4-Feb-26)`
- The tab is cleaned up automatically when you close it
- Only files that have been committed to git can be viewed historically (local-only files cannot)

**From the Snapshot Manager:**
- The "View graph at DATE" button opens the historical version of the graph closest to a signature's creation date
- It also injects an `asat(DATE)` clause into the graph's DSL query, so you see historical data with the historical graph structure

## Canvas Workspace

The graph canvas is a freeform analytics workspace where live charts, annotations, and grouping sit alongside conversion nodes.

### Canvas Analyses (Charts on Canvas)

Pin any analysis result directly onto the canvas as a live, updating chart:

- **Drag from analytics panel**: Drag a chart preview from the sidebar and drop onto the canvas
- **Draw on canvas**: Click the chart tool in the tools palette, then click-drag a rectangle
- **Blank chart**: Create via the tools palette or Elements > Add Analysis; configure in Properties

Canvas analyses support three modes:

| Mode | Behaviour |
|------|-----------|
| **Live** | Tracks the navigator's query context. Updates automatically when the graph changes |
| **Custom** | Chart-owned DSL composed onto the live base. Keeps your custom query while inheriting scenario changes |
| **Fixed** | Fully self-contained. Frozen in time — does not update |

### Multi-Tab Containers

Each canvas analysis can have multiple tabs. Each tab independently owns its analysis type, DSL, view mode, kind, scenario mode, and display settings. Drag tabs between containers.

### Post-It Notes

Coloured sticky notes on the canvas for freeform annotation. Six colours, four font sizes. Double-click to edit text inline.

### Containers

Labelled rectangles for visually grouping nodes. Drag a container and all enclosed nodes move with it.

### Minimise / Restore

Canvas objects can be minimised to a compact form. Custom minimised renderers are available for bridge view and expectation gauge analyses.

---

## Headless CLI

DagNet includes a command-line interface for running parameter extraction and analysis without a browser.

### `param-pack`

Extract parameter packs from disk-based graph and parameter files:

```bash
bash graph-ops/scripts/param-pack.sh <graph-name> <query-dsl> [options]
```

### `analyse`

Run any analysis type from the terminal:

```bash
bash graph-ops/scripts/analyse.sh <graph-name> <query-dsl> --type <analysis-type> [options]
```

Both commands use the same codepath as the browser. They support multi-scenario, scalar extraction, and disk bundle caching. See `graph-ops/playbooks/cli-param-pack.md` and `graph-ops/playbooks/cli-analyse.md` for full reference.

---

## Multi-Hop Cohort Maturity

DagNet can answer "of cohorts entering at A, what fraction reached Z?" across arbitrary DAG paths — not just adjacent edges. The **span kernel** composes per-edge lag distributions into a path-level arrival model via dynamic-programming convolution through the DAG.

To use multi-hop cohort maturity:

1. Select the start and end nodes of your path
2. Open the Analytics panel
3. Choose **Cohort Maturity** as the analysis type
4. The chart shows the full path maturity trajectory with model curve and confidence bands

This works for chains, branching paths, and fan-in topologies.

---

## Tips and Best Practices

### Graph Design
- **Keep It Simple**: Start with basic flows and add complexity gradually
- **Use Descriptive Names**: Give nodes and edges meaningful names
- **Organize Layout**: Arrange nodes logically from left to right
- **Test Scenarios**: Use What-If analysis to validate your assumptions

### Performance
- **Large Graphs**: Break complex funnels into smaller, focused graphs
- **Regular Saves**: Commit changes frequently to avoid data loss
- **Clean Up**: Remove unused nodes and edges to keep graphs readable

### Collaboration
- **Version Control**: Use Git branches for different experiments
- **Documentation**: Add comments and descriptions to explain complex logic
- **Share Results**: Export graphs and analysis results for team review

## Troubleshooting

### Common Issues
- **Graph Not Loading**: Check your credentials and repository access
- **Changes Not Saving**: Verify you have write permissions to the repository
- **Performance Issues**: Try breaking large graphs into smaller pieces
- **Sync Problems**: Use the pull/commit system to resolve conflicts

### Getting Help
- **Keyboard Shortcuts**: `Help > Keyboard Shortcuts`
- **About**: `Help > About DagNet`
- **Support**: Contact greg@nous.co for technical support
- **Issues**: Report bugs on the GitHub repository

## Advanced Features

### Custom Schemas
- **Parameter Schemas**: Define custom parameter structures
- **Context Schemas**: Create reusable context definitions
- **Case Schemas**: Design experiment case structures

### Data Connections

DagNet can fetch live data from external sources:

**Amplitude** — Funnel analytics
- Connect edges to Amplitude funnels
- Automatic n/k/p retrieval with daily breakdowns
- LAG-aware: fetches median lag times for latency modelling
- Native support for `visited()` and `exclude()` filters

**Google Sheets** — Parameter data
- Read scalar values or parameter packs from spreadsheets
- Right-click cell range → Copy link → Paste into connection settings
- Supports both single-cell and multi-row parameter tables

**Statsig** — Experiment configuration
- Fetch gate/experiment variant allocations
- Auto-updates case node weights from production rules
- Treatment/control weights sync from Statsig Console API

### Setting Up Data Connections

1. **Configure Credentials**: `File > Credentials` to add API keys
2. **Attach Connection**: Right-click edge/node → Attach parameter → Select connection
3. **Fetch Data**: Right-click → Get from Source, or use the refresh button

### Integration
- **Google Sheets**: Read parameters from spreadsheets
- **Statsig**: Fetch experiment variant allocations
- **Amplitude**: Retrieve funnel metrics with latency data
- **API Access**: Use the API for programmatic access

### Automation

DagNet supports **scheduled “headless automation”** for overnight refreshes (pull latest → retrieve all slices → commit).

See: [Automation and Scheduled Updates](automation-and-scheduling.md)
