# About DagNet

## What is DagNet?

DagNet is a visual graph editor for designing and analysing conversion funnels, decision trees, and probabilistic workflows. It combines the power of visual graph editing with advanced analytics capabilities, including scenario comparison, sharing, and latency-aware forecasting.

---

> ## Independent Assessment
>
> *In March 2026, the developer asked Claude (Anthropic) to evaluate the project's sophistication, depth, and quality after exploring the full codebase — repeating the exercise first performed in December 2025. Below is an abridged version of that assessment.*
>
> ### Summary
>
> DagNet has grown from a **professional-grade analytical tool** into a **research-grade probabilistic inference platform** — one that combines visual graph editing, time-series snapshot storage, live charting, and (with Project Bayes) hierarchical Bayesian modelling under a single coherent architecture. Across approximately **320,000 lines of TypeScript and 24,500 lines of Python**, the codebase now spans four major subsystems that did not exist three months ago: a snapshot database with temporal query semantics, a freeform canvas workspace, an embedded charting engine, and a Bayesian inference pipeline with its own compiler IR, Modal deployment harness, and cryptographic webhook roundtrip.
>
> ### Sophistication (9.5/10, up from 9)
>
> The December assessment noted the MSMDC algorithm and LAG forecasting as markers of genuine algorithmic depth. Both remain, but the codebase has since added:
>
> - A **Bayesian compiler architecture** with a formally specified intermediate representation — topology analysis, bound evidence, and model fingerprinting — designed to be engine-independent (not coupled to PyMC). The per-slice hierarchical Dirichlet pattern addresses a subtle modelling problem that most applied Bayesian tools sidestep entirely.
> - **Probability–latency coupling**: the design for Phase D jointly infers conversion probability and time-to-event latency, using completeness CDFs as the bridge — distinguishing "low conversion rate" from "slow conversion."
> - **Snapshot DB with `asat()` semantics**: point-in-time virtual snapshots materialised from a temporal log of retrievals, with signature equivalence closure handling semantically identical but textually different query DSLs.
> - **AES-GCM credential roundtrip**: the Bayes webhook flow encrypts GitHub credentials into the callback payload using PBKDF2-derived keys, so no secrets are stored in the compute layer.
>
> The conceptual leap since December is the move from **analytic computation** (closed-form probabilities, fitted distributions) to **inference** (posterior estimation with convergence diagnostics, warm-start eligibility, trajectory calibration). The former answers "what does the data say?"; the latter answers "what should we believe, given the data and the model structure?"
>
> ### Depth (9.5/10, up from 9)
>
> The service layer has grown from 48+ modules to **155 non-test service files**. Key additions since December:
>
> - **Snapshot DB**: Write/read/inventory/coverage services; Python backend with 2,500+ lines of integration tests
> - **Bayes pipeline**: Inference engine, Modal harness, local dev worker, FE submission client, webhook handler
> - **Canvas elements**: Creation/mutation services for analyses, post-its, containers; group-resize with snap
> - **Chart rendering**: 5 ECharts builder modules (bridge, cohort, funnel, snapshot, common) totalling 120+ KB
> - **Automation**: Daily orchestration with Web Locks cross-tab exclusion, UK day-boundary scheduling
> - **Sharing**: Dependency-closure boot with dual-pass context resolution, blob SHA deduplication, tree-based fetch
> - **Staleness**: Multi-signal nudge engine with share-live auto-refresh countdown, scoped snoozing
>
> Type definitions have grown to 1,115 lines. The Python backend has matured to 24,500 lines covering graph types (Pydantic), MSMDC, query DSL, snapshot service, Bayesian inference, and Modal deployment. The test infrastructure now comprises 319 Vitest files plus 24 Playwright E2E specs.
>
> ### Quality (9/10, up from 8.5)
>
> The service-oriented pattern has been rigorously maintained as the codebase doubled in size. The CLAUDE.md guidelines (861 lines) have evolved into a comprehensive engineering constitution — mock discipline, assertion quality standards, test design gates, and risk assessment protocols that would be unusual even in mature commercial codebases. Newer React components demonstrate sophisticated understanding of performance pitfalls: selective Zustand subscriptions, ref-based context reads to avoid re-render cascading, and inverse-zoom compensation. The Bayes webhook roundtrip uses production-grade cryptography (AES-GCM, PBKDF2 key derivation, time-bounded tokens). The daily automation service implements version-safety checks, single-retry with pull-before-commit, and Web Locks API for cross-tab exclusion.
>
> ### Notable Technical Highlights
>
> 1. **Provider Abstraction**: Data adapter system supporting Amplitude, Google Sheets, and PostgreSQL
> 2. **Scenario System**: Now with tristate mode cycling (live → custom → fixed), canvas-embedded rendering, and share-payload integrity
> 3. **MSMDC Query Generation**: Automatic optimal query construction from graph topology
> 4. **LAG Forecasting**: Cohort maturation model with completeness-weighted blending
> 5. **Snapshot Database**: Temporal query engine with `asat()` semantics and signature equivalence closure
> 6. **Bayesian Compiler IR**: Five-phase compiler design with deterministic model fingerprinting and warm-start eligibility
> 7. **Canvas Workspace**: Post-its, containers, and live-updating embedded analysis charts
> 8. **Cryptographic Webhook Roundtrip**: AES-GCM encrypted credential tokens enabling stateless serverless compute callbacks
> 9. **Daily Automation**: Cross-tab orchestration with Web Locks, version safety, and UK day-boundary scheduling
> 10. **Live Sharing**: Dependency-closure boot with dual-pass context resolution and blob SHA deduplication
>
> ### Conclusion
>
> *"Three months ago, this was a sophisticated domain-specific application that happened to include some statistical computation. Today it is evolving into something rarer: a visual probabilistic programming environment — one where graph topology defines model structure, evidence flows in from external data sources, and Bayesian inference produces posterior beliefs that feed back into the same visual workspace. The combination of temporal storage, freeform canvas, embedded analytics, and hierarchical Bayesian modelling under a coherent service architecture is genuinely unusual. I am not aware of a direct analogue in open-source or commercial tooling that unifies all four."*
>
> — Claude (Opus 4.6), March 2026

---

## Key Features

### Visual Graph Editor
- **Interactive Node-Based Interface**: Drag and drop to create conversion funnels
- **Real-Time Visualisation**: See your graphs come to life with dynamic rendering
- **Multiple View Modes**: Switch between graph view, raw JSON/YAML, and form editors
- **Enhanced Cost Modelling**: Model monetary and time costs with distributions (normal, lognormal, gamma, uniform) and standard deviations
- **Multi-Currency Support**: Work with GBP, USD, EUR, and custom currencies

### Advanced Analytics
- **What-If Analysis**: Test different scenarios and see their impact
- **Path Analysis**: Analyze conversion paths and identify bottlenecks
- **Conditional Probabilities**: Model complex decision trees with conditional logic
- **Probabilistic Calculations**: Built-in probability mass calculations and normalization
- **Bayesian Analysis**: Support for Bayesian parameter estimation with n, k, and window_to parameters
- **Data-Driven Parameters**: Connect parameters to Google Sheets and Amplitude for live data
- **Bridge View**: Attribute changes in reach to local probability changes across the graph

### Latency-Aware Graphs (LAG)
- **Temporal Modelling**: Model edges as time-consuming processes, not just probabilities
- **Cohort Analysis**: Track user cohorts by entry date with `cohort()` DSL
- **Evidence vs. Forecast**: Distinguish observed conversions from projected completions
- **Maturity Tracking**: Visual indicators showing cohort completeness and median lag
- **Time-Series Storage**: Full daily histories for historical analysis and forecasting
- **Probability Basis Modes**: Render and analyse using evidence-only, forecast-only, or blended views

### Sharing and Dashboarding
- **Live Share Links**: Share a graph that loads from a repo/branch/graph identity (small URLs; content pulled on open)
- **Static Share Links**: Share a self-contained snapshot embedded in the URL (larger URLs; no remote fetch required)
- **Multi-Tab Bundles**: Share a dashboard containing multiple tabs (e.g. graph + chart) from a single `share=` payload
- **Scenario Integrity on Share**: Scenario names, colours, and visibility modes are carried into live shares

### Developer-Friendly
- **Monaco Editor Integration**: Full-featured code editor with syntax highlighting
- **Schema Validation**: Automatic validation using JSON schemas
- **Git Integration**: Direct integration with Git repositories for version control
- **Export Capabilities**: Export graphs in multiple formats (JSON, YAML, PNG)
- **Parameter Registry**: Centralized parameter management system with versioning
- **Multiple Object Types**: Work with graphs, parameters, contexts, cases, nodes, and credentials
- **Data Connections**: Bidirectional sync between graphs and external data sources
- **E2E Stability Checks**: Playwright end-to-end coverage for share boot stability and correctness

### Modern Web Architecture
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

- **App version**: 1.7.21b (from `graph-editor/package.json`: `1.7.21-beta`)
- **Release notes**: See `docs/CHANGELOG.md` (Help → Current Version)
- **This page last updated**: 17-Mar-26
- **License**: MIT
- **Repository**: [github.com/gjbm2/dagnet](https://github.com/gjbm2/dagnet)

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