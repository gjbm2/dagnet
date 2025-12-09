# About DagNet

**Version 1.0.0-alpha** | [Changelog](CHANGELOG.md)

## The Temporal Graph Engine

DagNet is a visual graph editor for designing and analysing conversion funnels, decision trees, and probabilistic workflows.

**But it is not just a graph editor; it is a temporal probability engine.**

Most funnel analysis tools treat conversion as a simple coin flip: users convert or they don't ($p$). DagNet recognizes that conversion is a **process over time** ($p(t)$). By modelling the *latency* of every edge, we transform static funnels into dynamic flow simulations.

## Project LAG: The 1.0 Architecture

With version 1.0, we introduce the **Latency-Aware Graph (LAG)** architecture:

### 1. Cohort-Based Time Series
Instead of snapshotting a single "conversion rate", DagNet retrieves and stores full **daily time-series data** for every edge. This allows you to:
- "Rewind" time to see how the graph looked last month.
- Select specific **Cohort Windows** (e.g., "Users who entered in November") to isolate seasonal effects.
- Aggregate daily $n/k$ evidence on the fly for any custom period.

### 2. Latency Modelling
Every edge can now model the **time-to-convert** distribution.
- **Survival Curves**: We infer maturity curves from partial cohort data.
- **Maturity Projection**: Distinguish between *observed* conversion (evidence) and *projected* conversion (forecast).
- **Visualisation**: "Beads" on edges visualize median lag time and cohort completeness at a glance.

### 3. Context & Dimensionality
Data isn't flat. DagNet's **MSMDC** (Multi-Source Multi-Dimensional Context) engine allows you to:
- Slice the entire graph by **Context** (Mobile vs Desktop, Paid vs Organic).
- Handle non-MECE (Mutually Exclusive Collectively Exhaustive) data overlaps.
- Manage **Case Variants** for A/B testing with specific weighting.

## Key Features

### 🎨 Visual Graph Editor
- **Interactive Node-Based Interface**: Drag and drop to create conversion funnels
- **Copy & Paste Workflow**: Copy nodes/parameters from Navigator, paste onto canvas or existing elements
- **Drag & Drop**: Drag files from Navigator directly onto the graph canvas
- **Real-Time Visualisation**: See your graphs come to life with dynamic rendering
- **Multiple View Modes**: Switch between graph view, raw JSON/YAML, and form editors
- **Smart Large File Handling**: Automatic detection with YAML/JSON fallback for performance
- **Enhanced Cost Modelling**: Model monetary and time costs with distributions (normal, lognormal, gamma, uniform)
- **Multi-Currency Support**: Work with GBP, USD, EUR, and custom currencies

### 📊 Advanced Analytics
- **What-If Analysis**: Test different scenarios and see their impact instantly
- **Path Analysis**: Analyse conversion paths and identify bottlenecks
- **Conditional Probabilities**: Model complex decision trees with conditional logic
- **Probabilistic Calculations**: Built-in probability mass calculations and normalisation
- **Bayesian Analysis**: Support for Bayesian parameter estimation with n, k, and window parameters
- **Data-Driven Parameters**: Connect parameters to Google Sheets and Amplitude for live data

### 📅 Cohort-Based Analysis (New in 1.0)
- **Cohort Windows**: Select date ranges for cohort entry periods using `cohort(start:end)` DSL
- **Daily Aggregation**: Automatic aggregation of daily breakdown data within windows
- **Evidence Tracking**: Full audit trail with n, k, window_from, window_to fields on every edge
- **Real-Time Updates**: Tooltips and properties panel update immediately when data changes
- **Latency Modelling** (Preview): Track time-to-convert metrics with maturity curves

### 🔧 Developer-Friendly
- **Monaco Editor Integration**: Full-featured code editor with syntax highlighting
- **Schema Validation**: Automatic validation using JSON schemas
- **Git Integration**: Direct integration with Git repositories for version control
- **Export Capabilities**: Export graphs in multiple formats (JSON, YAML, PNG)
- **Parameter Registry**: Centralized parameter management system with versioning
- **Multiple Object Types**: Work with graphs, parameters, contexts, cases, nodes, and credentials
- **Data Connections**: Bidirectional sync between graphs and external data sources

### 🌐 Modern Web Architecture
- **React + TypeScript**: Built with modern web technologies
- **IndexedDB Storage**: Client-side persistence with offline capabilities
- **Responsive Design**: Works on desktop and tablet devices
- **Multiple Repositories**: Connect to and manage multiple Git repositories simultaneously
- **Credential Management**: Secure credential storage with encryption support
- **URL Configuration**: Pre-configure app settings and credentials via URL parameters

## Use Cases

### Marketing & Growth
- **Conversion Funnel Design**: Model and optimize user journeys
- **A/B Testing**: Design experiments and analyze results
- **Attribution Modeling**: Understand customer touchpoints

### Product Management
- **User Flow Analysis**: Map user interactions and decision points
- **Feature Impact Analysis**: Predict the impact of new features
- **Process Optimization**: Identify bottlenecks and improvement opportunities

### Data Science
- **Decision Tree Modeling**: Create and analyze decision trees
- **Probabilistic Workflows**: Model uncertain processes with cost and time distributions
- **Scenario Planning**: Test different business scenarios with parameterized cases
- **Bayesian Inference**: Use real-world data to update probability estimates
- **Data Integration**: Connect to Google Sheets and Amplitude for data-driven modeling

## Technical Architecture

### Frontend
- **React 18**: Modern React with hooks and concurrent features
- **TypeScript**: Type-safe development
- **ReactFlow**: Professional graph visualization
- **Monaco Editor**: VS Code's editor in the browser
- **Zustand**: Lightweight state management
- **Radix UI**: Accessible component primitives

### Backend Integration
- **GitHub API**: Direct integration with multiple Git repositories
- **Google Sheets API**: Read and write parameters from spreadsheets
- **Amplitude Analytics**: Query conversion and event data
- **RESTful APIs**: Clean API design for external integrations
- **Webhook Support**: Real-time updates and notifications
- **System Credentials**: Environment-based credentials for serverless deployments

### Data Formats
- **JSON**: Primary data format for graphs and configurations
- **YAML**: Human-readable configuration files for parameters, contexts, and cases
- **Schema Validation**: JSON Schema for data integrity
- **Conversion Graph Schema**: Version 1.0.0 schema for graph definitions
- **Parameter Schema**: Extended schema with data source connections and Bayesian parameters

## Version Information

- **Version**: 1.0.0-alpha (Project LAG)
- **Release Date**: 9-Dec-25
- **License**: MIT
- **Repository**: [github.com/gjbm2/dagnet](https://github.com/gjbm2/dagnet)

### What's New in 1.0: Project LAG

The 1.0 release represents a fundamental shift from **static probability graphs** to **temporal flow models**:

| Before (0.x) | After (1.0 LAG) |
|--------------|-----------------|
| Instantaneous transitions: $P(B\|A)$ | Time-indexed processes: $P(B\|A, t)$ |
| Single snapshot of conversion rate | Full daily time-series per edge |
| "Did they convert?" | "When will they convert?" |
| No maturity awareness | Partial cohort projection |

**Key capabilities:**
- **Cohort Windows**: Analyse users by *when they entered*, not just aggregate totals
- **Daily Time-Series Storage**: Every parameter file stores `n_daily`, `k_daily` arrays
- **On-the-fly Aggregation**: Select any date range; evidence recomputes instantly
- **Latency Tracking**: Enable `maturity_days` to model time-to-convert distributions
- **Evidence vs Forecast**: Distinguish observed data from projected completion

See the [Changelog](CHANGELOG.md) for full release notes.

## Getting Started

1. **Configure Credentials**: Open Settings to connect your Git repositories and data sources
2. **Open a Graph**: Use the navigator to browse and open existing graphs
3. **Create New Objects**: Create graphs, parameters, contexts, cases, or nodes
4. **Edit Visually**: Drag nodes, connect edges, set probabilities and costs
5. **Link Parameters**: Connect graph elements to parameter files for data-driven modeling
6. **Connect Data Sources**: Link parameters to Google Sheets or Amplitude for live data
7. **Analyze**: Use What-If analysis and Path Analysis tools
8. **Export**: Save your work or export for external use

## Support

- **Documentation**: [GitHub Docs](https://github.com/gjbm2/dagnet/tree/main/docs)
- **Issues**: [GitHub Issues](https://github.com/gjbm2/dagnet/issues)
- **Discussions**: [GitHub Discussions](https://github.com/gjbm2/dagnet/discussions)

## Contributing

DagNet is open source and welcomes contributions! See our [Contributing Guide](https://github.com/gjbm2/dagnet/blob/main/CONTRIBUTING.md) for details.

## Credits

You can't do stuff like this without some serious open source goodness. *I* couldn't have done it without Anthropic & OpenAI; credit where it's due. 

Support / bugs / love &c. @gregmarsh / [greg@nous.co](mailto:greg@nous.co)