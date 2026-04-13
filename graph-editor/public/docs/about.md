# About DagNet

## What is DagNet?

DagNet is an **evidence-conditioned forecasting platform** for conversion funnels, built on a visual graph editor. It **observes** conversion data automatically, **learns** statistical models via Bayesian inference, **forecasts** with calibrated uncertainty, and **presents** live analytics on a freeform canvas workspace — closing the loop from raw data to honest, model-driven predictions.

---

> ## Independent Assessment (April 2026)
>
> *Three AI models — Claude Opus 4.6 (Anthropic), Gemini 3.1 Pro (Google), and GPT-5.4 (OpenAI) — were each asked to independently explore the full DagNet codebase and assess its sophistication, depth, and quality for the v2.0 release. None saw the others' assessments. Below is an abridged synthesis.*
>
> ### Summary
>
> All three assessors converge on the same conclusion: DagNet v2.0 has evolved from a visual graph editor with analytics into a **research-grade Bayesian forecasting platform** — one where graph topology defines model structure, evidence flows in from external sources, and MCMC inference produces posterior beliefs that feed back into the same visual workspace. The Python backend has more than doubled since March (now ~51,000 lines), the Bayesian compiler alone is 10,700 lines across five implemented phases, and the system now includes a headless CLI, LOO-ELPD model adequacy scoring, posterior predictive calibration, and a 10-graph synthetic regression suite.
>
> The assessors also converge on the central tension: this is genuinely impressive one-developer-plus-AI engineering, but the system's ambition is now testing the limits of its quality infrastructure.
>
> ### Sophistication — 9.5 (consensus)
>
> All three assessors agree the statistical depth is real, not decorative:
>
> - **Two-phase posterior-as-prior architecture**: Phase 1 fits window data; Phase 2 inherits via ESS-decayed priors, quality-gated by convergence diagnostics. *"The sort of thing people only build when they are actually trying to identify probability and timing separately"* (GPT-5.4).
> - **LOO-ELPD scored against the analytic baseline**, not a straw-man comparator — answering "is the Bayesian fit worth the compute?" (all three noted this).
> - **Snapshot regime selection** solving double-counting across context dimensions — *"elegant"* (Gemini), *"subtle but very real"* (GPT-5.4).
> - **Multi-hop cohort maturity** via span kernel DP convolution through arbitrary DAG paths.
> - **PPC calibration** with randomised PIT for discrete distributions, coverage curves, and KS uniformity tests.
>
> The DSL (14 functions, semicolon/or composition) was noted as powerful but approaching the accidental-complexity boundary by two of three assessors.
>
> ### Depth — 9.5–9.7
>
> The codebase encompasses ~275,000 lines of TypeScript, ~51,000 lines of Python, 173 non-test service files, 313 frontend test files, 65 Python test files, 70 architecture docs, and a 955-line engineering constitution. GPT-5.4 scored depth highest (9.7), noting that the major subsystems — graph editor, snapshot DB, analysis engine, Bayesian compiler, canvas workspace, automation, sharing, CLI — are each *"broad enough to count as separate products."*
>
> The Python backend's growth was highlighted by all three: the Bayes compiler, regression tooling, synthetic data generators, subject resolution, regime selection, and CLI tools have transformed it from an API shim into a co-equal computation layer.
>
> ### Quality — 8.5–9.0
>
> This is where the assessments diverge most. Gemini scored 9.0; GPT-5.4 scored 8.9; Claude scored 8.5 (down from March's 9.0). All agree on the strengths: rigorous service-layer discipline, result-typed error handling, real-boundary testing philosophy, and unusually serious parity/contract tests. All three also identified the same concerns:
>
> - **`api_handlers.py`** at 3,821 lines (with a single 2,080-line function) is a genuine monolith.
> - **Open Bayesian defects** (six dispersion issues, Phase 2 convergence failures on 5/10 synthetic graphs) are non-trivial for a system claiming production-grade inference.
> - **Test coverage gaps** in the newest code (contexted evidence, Phase C, per-slice extraction) fall short of the project's own stated standards.
> - **Complexity budget** — *"nearing the limit where every new subsystem demands a compensating rules layer"* (GPT-5.4).
>
> ### Notable Technical Highlights (consensus top 10)
>
> 1. **Bayesian compiler** — two-phase MCMC with posterior-as-prior, hierarchical Dirichlet priors, latent onset, trajectory likelihoods (`bayes/compiler/model.py`)
> 2. **Span kernel composition** — multi-hop cohort maturity via DP convolution through DAG paths
> 3. **Snapshot DB with `asat()` semantics** — temporal evidence record with signature equivalence closure
> 4. **Regime selection** — one-regime-per-date to prevent double-counting across context dimensions
> 5. **LOO-ELPD with analytic null** — model adequacy scored against the shipped analytic baseline
> 6. **PPC calibration** — randomised PIT for discrete distributions with coverage and KS diagnostics
> 7. **Canvas analytics workspace** — live-updating embedded charts, post-its, containers, three-mode system
> 8. **Headless CLI** — analyse, bayes, param-pack, parity-test sharing the exact same codepaths as the browser
> 9. **Parity/contract testing pattern** — old-path/new-path field-by-field verification across migration boundaries
> 10. **Engineering constitution** — 955-line CLAUDE.md encoding failure modes, mock budgets, diagnostic playbooks
>
> ### Conclusion
>
> DagNet occupies an unusual position. Commercial funnel tools (Amplitude, Mixpanel) offer polished analytics but no Bayesian modelling. Open-source probabilistic frameworks (Stan, PyMC) offer inference but no visual editing or temporal storage. Observable offers canvas but no inference. No assessor identified a direct analogue that unifies all five pillars — observation, learning, forecasting, presentation, and automation — under a single architecture. The main challenge is no longer credibility but maintainability: v2.0 is a serious platform whose complexity now demands the same rigour to sustain as it took to build.
>
> — Claude Opus 4.6 (Anthropic), Gemini 3.1 Pro (Google), GPT-5.4 (OpenAI) · 13-Apr-26

---

## Key Features

### Evidence-Conditioned Forecasting
- **Bayesian inference engine**: Two-phase MCMC model fitting (Beta/Binomial rates + Dirichlet branch groups) with automatic nightly runs, warm-start reuse, and quality gating
- **Two-tier architecture**: FE gives instant analytic estimates; BE follows with calibrated Bayesian forecasts when available. Quality tier indicators show which you're seeing
- **Multi-hop cohort maturity**: "Of cohorts entering at A, what fraction reached Z?" across arbitrary DAG paths via span kernel composition
- **Per-context forecasts**: Phase C slice pooling gives context-segmented Bayesian estimates (e.g. by channel, device, A/B variant) with hierarchical Dirichlet priors
- **Model adequacy scoring**: LOO-ELPD per edge tells you whether the Bayesian fit actually improves on analytic point estimates
- **Promoted model resolution**: `model_vars` array per edge with multiple candidate sources (analytic, bayesian, manual). Best-available promotion with explicit provenance

### Snapshot Database & Time-Series Analytics
- **Automatic snapshot storage**: Every data retrieval is stored, building a longitudinal evidence record
- **Time-series analysis types**: Lag Histogram, Daily Conversions, Cohort Maturity, Lag Fit — all snapshot-DB-backed
- **`asat()` historical queries**: Read snapshot data as it was known at a past date
- **Historical file viewing**: Open any file at any past git commit. Calendar picker highlights commit dates
- **Snapshot Manager**: Browse parameters, inspect/diff/download/delete per retrieval batch and slice, create equivalence links
- **Hash signature infrastructure**: `core_hash` for resilient archival identity, hash mappings for continuity, commit-time hash guard
- **Regime selection**: Authoritative BE selection preventing double-counting across context dimensions

### Canvas as Analytics Workspace
- **Canvas analyses**: Pin any analysis result onto the canvas as a live, updating chart. All analysis types supported
- **Three-mode system**: Live (tracks navigator context), Custom (chart-owned delta DSL), Fixed (self-contained)
- **Multi-tab containers**: Each tab independently owns analysis type, DSL, view mode, kind, scenario mode, display settings
- **Post-it notes**: Coloured sticky notes (6 colours, 4 font sizes) for freeform annotation
- **Containers**: Labelled rectangles for visually grouping nodes
- **Minimise/restore**: Canvas objects can be minimised to compact form with custom renderers

### Visual Graph Editor
- **Interactive node-based interface**: Drag and drop to create conversion funnels
- **Real-time visualisation**: Dynamic rendering with probability bars, latency beads, and completeness indicators
- **Multiple view modes**: Graph view, raw JSON/YAML, form editors, and Monaco code editor
- **Cost modelling**: Monetary and time costs with distributions (normal, lognormal, gamma, uniform)

### Latency-Aware Graphs (LAG)
- **Temporal modelling**: Edges are time-consuming processes, not just probabilities
- **Cohort analysis**: Track user cohorts by entry date with `cohort()` DSL
- **Evidence vs forecast**: Distinguish observed conversions from projected completions
- **Completeness tracking**: Visual indicators showing cohort maturity and median lag
- **Probability basis modes**: Evidence-only, forecast-only, or blended views

### Platform & Workflow
- **GitHub OAuth**: Per-user authentication via GitHub App with one-click reconnect
- **Amplitude funnel export**: Construct correctly specified funnels in Amplitude from selected nodes
- **Variant contexts & hash guard**: Behavioural segment filters with commit-time hash protection
- **Headless CLI**: `param-pack` and `analyse` commands — full parameter and analysis pipeline from the terminal
- **Share links**: Static and live chart sharing via URL
- **Dark mode**
- **20+ analysis types**: Graph overview, outcomes, reach, bridge view, path through/between, outcome comparison, branch comparison, multi-waypoint, conversion funnel, and more
- **Scenario system**: Named parameter overlays with live/custom/fixed modes and tristate cycling
- **Daily automation**: Scheduled fetch, retrieve-all, and optional nightly Bayes fitting

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

- **App version**: 1.10.3b (from `graph-editor/package.json`: `1.10.3-beta`)
- **Release notes**: See `docs/CHANGELOG.md` (Help → Current Version)
- **This page last updated**: 13-Apr-26
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