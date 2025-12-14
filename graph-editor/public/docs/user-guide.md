# DagNet User Guide

**Version 1.0.0-alpha** | [Changelog](CHANGELOG.md)

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

### Integration
- **Google Sheets**: Export data to spreadsheets for analysis
- **Statsig**: Integrate with Statsig for experiment management
- **API Access**: Use the API for programmatic access

### Automation
- **Batch Operations**: Process multiple files at once
- **Scripting**: Use the API to automate common tasks
- **Templates**: Create reusable graph templates
