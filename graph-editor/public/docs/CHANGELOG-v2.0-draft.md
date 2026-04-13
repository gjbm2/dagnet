# Version 2.0
**Released:** [TBD]

**DagNet v2.0 answers the question: "What's actually happening in my funnel, and what should I expect?" — with calibrated confidence, automatically, every day.**

Five months of development (Dec 2025 → Apr 2026) across dozens of beta releases, presented here as a coherent milestone. v2.0 is additive — existing graphs, parameter files, and workflows continue to work unchanged. The version number reflects the magnitude of what has been built, not a compatibility boundary.

---

### Evidence-Conditioned Forecasting

Fitted models now drive forecasting with calibrated uncertainty.

- **Two-tier architecture** — the frontend analytics pass gives instant completeness and forecast estimates; where a Bayesian posterior is available, the backend follows with a higher-quality MC-based forecast conditioned on snapshot evidence. Quality tier indicators show which you're seeing
- **Multi-hop cohort maturity** — "of cohorts entering at A, what fraction reached Z?" across arbitrary DAG paths, not just adjacent edges. The span kernel composes per-edge lag distributions into path-level forecasts via dynamic-programming convolution
- **Model adequacy scoring** — LOO-ELPD (Leave-One-Out Expected Log Predictive Density) per edge tells you whether the Bayesian fit actually improves on analytic point estimates. Surfaces in the Forecast Quality overlay, Edge Info Model tab, and PosteriorIndicator popover
- **Per-context forecasts** — Phase C slice pooling provides context-segmented Bayesian estimates (e.g. by channel, device, A/B variant) using hierarchical Dirichlet priors that share statistical strength across slices
- **Promoted model resolution** — `model_vars` array per edge with multiple candidate sources (analytic, bayesian, manual). Best-available promotion with explicit provenance. Configurable per-edge or graph-level
- **Expectation Gauge** — "how surprising is current evidence given the model?" Live on canvas with custom minimised renderer

### Snapshot Database & Time-Series Analytics

Every data retrieval is now stored, building a longitudinal evidence record that grows richer with each fetch.

- **Snapshot database** — automatic storage of conversion data on every fetch. Cohort anchor dates, conversion counts, timestamps, slice context. Powers all time-series analysis
- **Time-series analysis types** — Lag Histogram, Daily Conversions, Cohort Maturity (single-edge and multi-hop), Lag Fit. All snapshot-DB-backed
- **`asat()` historical queries** — read snapshot data as it was known at a past date. Read-only; no side-effects
- **Historical file viewing** — open any file at any past git commit. Calendar picker highlights commit dates. `.asat()` naming convention on historical tabs
- **Snapshot Manager** — parameter-first diagnostic tool: browse parameters, inspect/diff/download/delete per retrieval batch and slice, create equivalence links between old and new signatures
- **Multi-graph Retrieve All** — fetch and store across all open graphs in one operation
- **Hash signature infrastructure** — `core_hash` for resilient archival identity. Hash mappings for continuity when definitions change. Commit-time hash guard detects hash-breaking edits and offers mapping creation
- **Regime selection** — authoritative backend selection of one coherent hash family per (edge, date, retrieval) triple. Eliminates double-counting across context dimensions

### Bayesian Inference Engine

The infrastructure that makes evidence-conditioned forecasting possible. A full Bayesian inference engine that automatically fits statistical models to conversion data.

- **Bayesian compiler** — two-phase model: Phase 1 (window, step-day) fits per-edge rates with Beta/Binomial likelihoods; Phase 2 (cohort, entry-day) reuses Phase 1 posteriors as priors with Dirichlet/Binomial at branch groups. Latent onset estimation, t95 soft constraints, unified MCMC dispersion. Context slice pooling via hierarchical Dirichlet (Phase C)
- **Automatic model fitting** — `runBayes` flag enables nightly automation. Three-phase daily pipeline: patch apply → fetch + commission → drain. Reconnect on browser reopen. Warm-start reuses previous posteriors with quality gating (Rhat < 1.10, ESS ≥ 100)
- **Async compute** — Modal-hosted MCMC, submit/status/cancel lifecycle, webhook delivery with AES-GCM encrypted credential tokens, git-committed patch files
- **Quality surfaces** — Bayesian Posterior Card, PosteriorIndicator, quality tiers (good/fair/poor/very poor), confidence bands on cohort maturity charts (off/80%/90%/95%/99%), model CDF overlay on lag fit, LOO-ELPD in Forecast Quality overlay and Edge Info Model tab
- **Promoted model vars** — `model_vars` array per edge with multiple candidate sources. `model_source_preference` (per-edge or graph-level) selects the active source: `best_available`, `bayesian`, `analytic`, `manual`

### Canvas as Analytics Workspace

The graph canvas is now a freeform analytics workspace where live charts, annotations, and grouping sit alongside conversion nodes.

- **Canvas analyses** — pin any analysis result onto the canvas as a live, updating chart. All analysis types supported. Drag from analytics panel, or click-drag to draw. Multi-scenario rendering
- **Three-mode system** — Live (tracks navigator context), Custom (chart-owned delta DSL composed onto live base), Fixed (fully self-contained)
- **Multi-tab containers** — each tab independently owns analysis type, DSL, view mode, kind, scenario mode, display settings. Tab drag between containers
- **Post-it notes** — coloured sticky notes (6 colours, 4 font sizes) for freeform annotation
- **Containers** — labelled rectangles for visually grouping nodes. Enclosed nodes move with the container
- **Shared toolbar** — single toolbar driving all view types: DSL → scenarios → analysis type → view mode → kind → subject → display → connectors → actions
- **Chart display planning** — centralised decision layer for time-series vs scenario-axis, metric basis, multi-scenario collapse
- **Minimise/restore** — canvas objects can be minimised to compact form. Custom minimised renderers for bridge view and expectation gauge
- **Dashboard mode** — fitView includes all canvas elements

### Platform & Workflow

- **GitHub OAuth** — per-user authentication via GitHub App. One-click reconnect on token expiry. Read-only mode without credentials
- **Amplitude funnel export** — select nodes → construct a correctly specified funnel in Amplitude with event filters, context segments, cohort exclusions, and graph-derived conversion windows
- **Variant contexts & hash guard** — behavioural segment filters on context definitions. Commit-time detection of hash-breaking edits with mapping creation. CLI tools for hash management
- **Headless CLI** — `param-pack` and `analyse` commands. Full parameter and analysis pipeline from the terminal. Same codepath as the browser. Multi-scenario, scalar extraction, disk bundle caching
- **Share links** — static and live chart sharing via URL. Multi-tab bundles. Scenario integrity on share
- **Dark mode**
- **Bundled sample data** — zero GitHub API calls for sample data. Priority-sorted clone resilience
- **20+ analysis types** — graph overview, outcomes, reach, bridge view, path through/between, outcome comparison, branch comparison, multi-waypoint, conversion funnel, constrained path, branches from start, multi-outcome/branch comparison, node/edge info (with data depth), selection statistics, plus all snapshot-DB-backed types
- **DSL enhancements** — semicolon/or composition syntax for multi-slice queries, `context()` as uncontexted slice, bare key expansion for Cartesian context enumeration

---

*This entry sweeps all beta releases from v1.0 (10-Dec-25) through v1.10.3b (13-Apr-26).*
