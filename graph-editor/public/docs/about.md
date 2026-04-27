# About DagNet

## What is DagNet?

DagNet is an **evidence-conditioned forecasting platform** for conversion funnels, built on a visual graph editor. It **observes** conversion data automatically, **learns** statistical models via Bayesian inference, **forecasts** with calibrated uncertainty, and **presents** live analytics on a freeform canvas workspace — closing the loop from raw data to honest, model-driven predictions.

> *"DagNet has evolved from a visual graph editor with analytics into a research-grade Bayesian forecasting platform — graph topology defines model structure, evidence flows in from external sources, and MCMC inference produces posterior beliefs that feed back into the same visual workspace."*
>
> — Independent assessment, April 2026 ([full assessment in Appendix](#appendix-independent-assessment-april-2026))

## How DagNet compares

DagNet sits between three categories of tool:

- **Product analytics** (Amplitude, Mixpanel) give polished funnel reports but no probabilistic modelling, no calibrated forecasts, no version-controlled models.
- **Probabilistic frameworks** (Stan, PyMC, NumPyro) give Bayesian inference but no visual editor, no longitudinal evidence store, no scheduled re-fitting.
- **BI tools** (Looker, Tableau) give visualisation but no temporal probability modelling.

DagNet unifies all three: a visual DAG editor where graph topology *is* the model structure, with a snapshot database that grows richer with every fetch, MCMC inference that runs nightly, and a canvas workspace where charts, annotations, and scenarios live alongside the graph itself.

---

## Key Features

### Modelling

- **Visual node-based editor** — drag-and-drop conversion funnels with real-time rendering, probability bars, latency beads, and completeness indicators
- **Latency-aware graphs (LAG)** — every edge models both *probability* and *time-to-convert*. Cohort analysis (`cohort()` DSL), evidence vs forecast separation, completeness tracking, and probability-basis modes (E-only / F-only / blended) are first-class
- **Conditional probabilities** — edges can carry context-dependent probabilities (`visited()`, `exclude()`) that activate based on the path taken
- **Cost modelling** — monetary and time costs with distributions (normal, lognormal, gamma, uniform)
- **Multiple view modes** — graph view, raw JSON/YAML, form editors, Monaco code editor

### Inference & Forecasting

- **Bayesian inference engine** — two-phase MCMC fitting (Beta/Binomial rates + Dirichlet branch groups), automatic nightly runs, warm-start reuse, quality gating
- **Two-tier architecture** — instant analytic estimates the moment you open a graph; calibrated Bayesian forecasts arrive seconds later from the backend, replacing the analytic blend in place. Quality tier indicators show which you're seeing
- **Multi-hop cohort maturity** — *"of cohorts entering at A, what fraction reached Z?"* across arbitrary DAG paths, via span-kernel composition (DP convolution through chains, branches, and fan-in topologies)
- **Per-context forecasts** — Phase C slice pooling gives context-segmented Bayesian estimates (channel, device, A/B variant) using hierarchical Dirichlet priors that share statistical strength across slices
- **Model adequacy scoring** — LOO-ELPD per edge tells you whether the Bayesian fit actually improves on point estimates; PPC calibration tests whether the credible intervals are honest
- **Promoted model resolution** — `model_vars` array per edge with multiple candidate sources (analytic, bayesian, manual). Best-available promotion with explicit provenance
- **Expectation Gauge** — *"how surprising is current evidence given the model?"* Live on canvas with custom minimised renderer

### Time-Series Evidence

- **Snapshot database** — every data retrieval is stored, building a longitudinal evidence record that grows richer with each fetch. Cohort anchor dates, conversion counts, timestamps, slice context
- **`asat()` historical queries** — read snapshot data as it was known at any past date. Reproducible analyses without side-effects
- **Historical file viewing** — open any file (graph, parameter, etc.) at any past git commit. Calendar picker highlights commit dates; tabs use the `.asat()` naming convention
- **Snapshot Manager** — parameter-first diagnostic tool: browse, inspect, diff, download, delete per retrieval batch and slice; create signature equivalence links
- **Hash signature infrastructure** — `core_hash` for resilient archival identity; hash mappings for continuity when event/context definitions change; commit-time hash guard catches breaking edits before they fragment your data
- **Regime selection** — authoritative backend selection of one coherent hash family per `(edge, date, retrieval)` triple. Prevents double-counting across context dimensions
- **Time-series analysis types** — Lag Histogram, Daily Conversions, Cohort Maturity (single-edge and multi-hop), Lag Fit, Conversion Rate — all snapshot-DB-backed with confidence bands

### Workspace

- **Canvas as analytics workspace** — pin any analysis result onto the canvas as a live, updating chart. All analysis types supported
- **Three-mode canvas analyses** — Live (tracks navigator context), Custom (chart-owned delta DSL composed onto the live base), Fixed (self-contained, frozen)
- **Multi-tab containers** — each tab independently owns analysis type, DSL, view mode, kind, scenario mode, display settings; drag tabs between containers
- **Post-it notes & containers** — coloured stickies (6 colours, 4 font sizes) and labelled rectangles for freeform annotation and visual grouping
- **Scenario system** — named parameter overlays with live/custom/fixed modes, tristate visibility cycling, per-scenario visibility (F+E / F / E / Hidden)
- **What-if analysis** — override values, trace probability mass through multi-path flows, model conditional dependencies — all without modifying the underlying graph

### Platform

- **Git-native** — graphs, parameters, contexts, cases live as YAML/JSON in GitHub. Per-user authentication via GitHub OAuth with one-click reconnect. Variant contexts and commit-time hash guard protect data continuity through definition changes
- **Headless CLI** — `param-pack`, `analyse`, `hydrate`, `bayes`, `parity-test` commands sharing the exact same code paths as the browser. Bayesian sidecar injection (`--bayes-vars`) for "what-if" analysis with speculative posteriors
- **Share links** — static (self-contained) and live (auto-refreshing) chart and bundle sharing via URL; dashboard mode for tiled multi-chart views
- **Daily automation** — scheduled fetch, retrieve-all, optional nightly Bayes fitting via three-phase pipeline (patch apply → fetch + commission → drain)
- **Data connections** — Amplitude, Google Sheets, Statsig, PostgreSQL via the Data Adapter Service (DAS); native support for `visited()`/`exclude()` filters
- **Amplitude funnel export** — construct correctly specified Amplitude funnels from selected nodes, opens directly for slicing/sharing

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

### Backend Integration
- **GitHub API** — direct integration with multiple Git repositories
- **Google Sheets API** — read parameters from spreadsheets
- **Amplitude Analytics** — query conversion and event data with daily breakdowns
- **Statsig & PostgreSQL** — experiment allocations and SQL-backed conversion data
- **Modal** — hosted MCMC inference for Bayesian fits, results delivered via webhook + atomic git commit
- **System credentials** — environment-based credentials for serverless deployments

### Data Formats
- **JSON & YAML** — graphs in JSON, parameters/contexts/cases in YAML
- **Schema validation** — JSON Schema (Ajv on the FE, Pydantic on the BE) with parity tests preventing FE/BE drift
- **Conversion Graph Schema 1.1.0** — current; v1.0.0 graphs remain valid

### Implementation
React 18, TypeScript, ReactFlow, Monaco, Zustand on the frontend; FastAPI / Vercel serverless functions in Python on the backend; nutpie + JAX for MCMC. ~1M lines across source, tests, and documentation.

## Version Information

- **App version**: 2.0.0 beta (from `graph-editor/package.json`: `2.0.0-beta`)
- **Release notes**: See `docs/CHANGELOG.md` (Help → Current Version)
- **This page last updated**: 17-Apr-26
- **License**: MIT
- **Repository**: [github.com/gjbm2/dagnet](https://github.com/gjbm2/dagnet)

## Getting Started

**First time? Try this**: open the Navigator (`Ctrl/Cmd + B`), pick a graph, and hover an edge. You'll see evidence-vs-forecast bars, a completeness indicator, and a quality-tier badge — that's the platform working. Open the Analytics panel and pin a Cohort Maturity chart onto the canvas to watch a forecast tighten as data accumulates.

For full setup:

1. **Configure credentials** — open Settings to connect your Git repositories and data sources
2. **Open or create a graph** — use the navigator to browse existing graphs, or create a new one
3. **Edit visually** — drag nodes, connect edges, set probabilities and costs
4. **Link parameters** — connect graph elements to parameter files for data-driven modelling
5. **Connect data sources** — link parameters to Amplitude, Google Sheets, or Statsig for live data
6. **Analyse** — pin charts to the canvas, compare scenarios, run what-if

## Support

- **Documentation**: [GitHub Docs](https://github.com/gjbm2/dagnet/tree/main/docs)
- **Issues**: [GitHub Issues](https://github.com/gjbm2/dagnet/issues)
- **Discussions**: [GitHub Discussions](https://github.com/gjbm2/dagnet/discussions)

## Contributing

DagNet is open source and welcomes contributions! See our [Contributing Guide](https://github.com/gjbm2/dagnet/blob/main/CONTRIBUTING.md) for details.

## Credits

You can't do stuff like this without some serious open source goodness. *I* couldn't have done it without Anthropic & OpenAI; credit where it's due. 

Support / bugs / love &c. @gregmarsh / [greg@nous.co](mailto:greg@nous.co)

---

## Appendix: Independent Assessment (April 2026)

*Three AI models — Claude Opus 4.6 (Anthropic), Gemini 3.1 Pro (Google), and GPT-5.4 (OpenAI) — were each asked to independently explore the full DagNet codebase and assess its sophistication, depth, and quality for the v2.0 beta release. None saw the others' assessments. Below is an abridged synthesis.*

### Summary

All three assessors converge on the same conclusion: DagNet v2.0 beta has evolved from a visual graph editor with analytics into a **research-grade Bayesian forecasting platform** — one where graph topology defines model structure, evidence flows in from external sources, and MCMC inference produces posterior beliefs that feed back into the same visual workspace. The Python backend has more than doubled since March (now ~51,000 lines), the Bayesian compiler alone is 10,700 lines across five implemented phases, and the system now includes a headless CLI, LOO-ELPD model adequacy scoring, posterior predictive calibration, and a 30+ graph synthetic regression suite.

The assessors also converge on the central tension: this is genuinely impressive one-developer-plus-AI engineering, but the system's ambition is now testing the limits of its quality infrastructure.

### Sophistication — 9.5 (consensus)

All three assessors agree the statistical depth is real, not decorative:

- **Two-phase posterior-as-prior architecture**: Phase 1 fits window data; Phase 2 inherits via ESS-decayed priors, quality-gated by convergence diagnostics. *"The sort of thing people only build when they are actually trying to identify probability and timing separately"* (GPT-5.4).
- **LOO-ELPD scored against the analytic baseline**, not a straw-man comparator — answering "is the Bayesian fit worth the compute?" (all three noted this).
- **Snapshot regime selection** solving double-counting across context dimensions — *"elegant"* (Gemini), *"subtle but very real"* (GPT-5.4).
- **Multi-hop cohort maturity** via span kernel DP convolution through arbitrary DAG paths.
- **PPC calibration** with randomised PIT for discrete distributions, coverage curves, and KS uniformity tests.

The DSL (14 functions, semicolon/or composition) was noted as powerful but approaching the accidental-complexity boundary by two of three assessors.

### Depth — 9.5–9.7

At the time of assessment the codebase encompassed ~275,000 lines of TypeScript and ~51,000 lines of Python. As of the v2.0 beta release it has grown to over 1 million lines across 2,741 files: 545k lines of source (302k TypeScript, 100k Python, 98k YAML, across 1,486 files), 150k lines of tests (483 files), and 362k lines of documentation (772 files). GPT-5.4 scored depth highest (9.7), noting that the major subsystems — graph editor, snapshot DB, analysis engine, Bayesian compiler, canvas workspace, automation, sharing, CLI — are each *"broad enough to count as separate products."*

The Python backend's growth was highlighted by all three: the Bayes compiler, regression tooling, synthetic data generators, subject resolution, regime selection, and CLI tools have transformed it from an API shim into a co-equal computation layer.

### Quality — 8.5–9.0

This is where the assessments diverge most. Gemini scored 9.0; GPT-5.4 scored 8.9; Claude scored 8.5 (down from March's 9.0). All agree on the strengths: rigorous service-layer discipline, result-typed error handling, real-boundary testing philosophy, and unusually serious parity/contract tests. All three also identified the same concerns:

- **`api_handlers.py`** at 3,821 lines (with a single 2,080-line function) is a genuine monolith.
- **Bayesian compiler maturity** — at the time of assessment, several dispersion issues and Phase 2 convergence failures remained open. These have since been substantially resolved: the generalised dispersion model, improved warm-start gating, and an expanded synthetic regression suite (now 30+ graphs covering bare, contexted, sparse, mixed-epoch, and multi-dimensional topologies) demonstrate reliable convergence across the full range of graph structures.
- **Complexity budget** — *"nearing the limit where every new subsystem demands a compensating rules layer"* (GPT-5.4).

### Notable Technical Highlights (consensus top 10)

1. **Bayesian compiler** — two-phase MCMC with posterior-as-prior, hierarchical Dirichlet priors, latent onset, trajectory likelihoods (`bayes/compiler/model.py`)
2. **Span kernel composition** — multi-hop cohort maturity via DP convolution through DAG paths
3. **Snapshot DB with `asat()` semantics** — temporal evidence record with signature equivalence closure
4. **Regime selection** — one-regime-per-date to prevent double-counting across context dimensions
5. **LOO-ELPD with analytic null** — model adequacy scored against the shipped analytic baseline
6. **PPC calibration** — randomised PIT for discrete distributions with coverage and KS diagnostics
7. **Canvas analytics workspace** — live-updating embedded charts, post-its, containers, three-mode system
8. **Headless CLI** — analyse, bayes, param-pack, parity-test sharing the exact same codepaths as the browser
9. **Parity/contract testing pattern** — old-path/new-path field-by-field verification across migration boundaries
10. **Engineering constitution** — 955-line CLAUDE.md encoding failure modes, mock budgets, diagnostic playbooks

### Conclusion

DagNet occupies an unusual position. Commercial funnel tools (Amplitude, Mixpanel) offer polished analytics but no Bayesian modelling. Open-source probabilistic frameworks (Stan, PyMC) offer inference but no visual editing or temporal storage. Observable offers canvas but no inference. No assessor identified a direct analogue that unifies all five pillars — observation, learning, forecasting, presentation, and automation — under a single architecture. The main challenge is no longer credibility but maintainability: v2.0 beta is a serious platform whose complexity now demands the same rigour to sustain as it took to build.

— Claude Opus 4.6 (Anthropic), Gemini 3.1 Pro (Google), GPT-5.4 (OpenAI) · 13-Apr-26
