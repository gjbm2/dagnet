# DagNet User Guide

**Version 1.1** | [Changelog](CHANGELOG.md)

## Getting Started

### What is DagNet?

DagNet is a **temporal probability engine** disguised as a graph editor.

While most analytics tools show you a static conversion rate ("45% of users convert"), DagNet answers the question that actually matters: **"When will they convert?"**

With version 1.0 (Project LAG), every edge in your graph can model not just *probability* but *latency* — the time it takes for users to complete each step. This transforms your funnel from a snapshot into a **flow simulation**.

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

## Latency-Aware Graphs (LAG) — New in 1.0

### Understanding Latency

Traditional conversion funnels treat edges as instantaneous: users either convert or they don't. But in reality, **conversion takes time**. A user who signed up today might not purchase for another 3 weeks.

**LAG** (Latency-Aware Graphs) models this timing. Each edge can have:
- **Median lag**: The typical time to convert (e.g., 5 days)
- **Maturity days**: How long to wait before considering a cohort "complete" (e.g., 30 days)

### Evidence vs Forecast

With LAG enabled, edge probabilities split into two components:

| Metric | Meaning |
|--------|---------|
| **Evidence** | What we've *observed* — users who have already converted |
| **Forecast** | What we *expect* — projected conversions based on the lag model |

When a cohort is immature (recent entry date, not enough time has passed), the evidence is incomplete. LAG uses the historical lag distribution to forecast how many more will convert.

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
| **F+E** | Evidence + Forecast blended | Best overall estimate |
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
