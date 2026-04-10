# DagNet v2.0 — Milestone Release Plan

**Date**: 10-Apr-26
**Status**: Draft — for review
**Branch**: `feature/snapshot-db-phase0`

---

## What v2.0 represents

**DagNet v2.0 answers the question: "What's actually happening in my
funnel, and what should I expect?" — with calibrated confidence,
automatically, every day.**

Before v2.0, DagNet was a graph editor that could fetch data and show
static probabilities. v2.0 closes the loop into a system that
**observes**, **learns**, **forecasts**, and **presents**:

- **Observes** — every data retrieval is stored, building a
  longitudinal evidence record that grows richer with each fetch.
- **Learns** — a Bayesian inference engine fits statistical models to
  that evidence nightly, producing posterior distributions with
  calibrated uncertainty. It knows what it knows and what it doesn't.
- **Forecasts** — conditioned on what it's learned, the system
  provides honest forecasts with uncertainty bands. Where posteriors
  aren't available, it falls back gracefully to analytic estimates.
  Multi-hop, per-context, across arbitrary DAG paths.
- **Presents** — the canvas is now an analytics workspace where live
  charts, annotations, and analytical objects sit alongside conversion
  nodes. Every analysis updates automatically as data and models
  evolve.

This is ~5 months of development (Dec 2025 → Apr 2026) across dozens
of beta releases, presented here as a coherent milestone. The release
is structured around five pillars that together support this
observe → learn → forecast → present loop.

---

## Pillar 1: Evidence-Conditioned Forecasting

*Foundation: v1.0–v1.1 temporal statistics (Dec 2025 – Jan 2026).
Built on: v1.4–v1.10 snapshot DB + Bayesian engine (Feb – Apr 2026).*

DagNet now forecasts competently based on fitted models conditioned on
real evidence. The temporal statistics engine (Project LAG) established
the foundations — cohort windows, latency distributions, completeness
tracking, t95 horizons — but v2.0's story is what's built on those
foundations:

**What to include in v2.0 communiqué:**

- **Fitted models drive forecasting** — the FE analytics pass provides
  instant completeness and forecast estimates; where a Bayesian
  posterior or promoted MLE fit is available, the BE follows with a
  higher-quality MC-based forecast conditioned on snapshot evidence.
- **Two-tier architecture** — FE gives a quick answer immediately.
  BE provides a proper forecast with calibrated uncertainty when the
  server is reachable. Users see which quality tier they're getting.
- **Multi-hop cohort maturity** — "of cohorts entering at A, what
  fraction reached Z?" across arbitrary DAG paths, not just adjacent
  edges. Span kernel composes per-edge models into path-level
  forecasts.
- **Model adequacy scoring** — LOO-ELPD tells users whether the
  Bayesian fit actually improves on analytic point estimates, per edge.
- **Per-context forecasts** — Phase C slice posteriors provide
  context-segmented Bayesian estimates (e.g. by channel, device,
  A/B variant).
- **Expectation Gauge** — "how surprising is current evidence given
  the model?" Live on canvas with custom minimised renderer.

---

## Pillar 2: Snapshot Database & Time-Series Analytics (Project DB)

*Shipped: v1.4 (Feb 2026), hardened through v1.9*

Every data retrieval is stored, building a longitudinal record that
powers genuine time-series analysis.

**What to include in v2.0 communiqué:**

- **Snapshot database** — automatic storage of conversion data on
  every fetch. Cohort anchor dates, conversion counts, timestamps,
  slice context.
- **Time-series analysis types** — Lag Histogram, Daily Conversions,
  Cohort Maturity (single-edge), Lag Fit. All snapshot-DB-backed.
- **`asat()` historical queries** — read snapshot data as it was
  known at a past date.
- **Historical file viewing** — open any file at any past git commit.
  Calendar picker highlights commit dates.
- **Snapshot Manager** — diagnostic UI: browse parameters, inspect/
  diff/download/delete per retrieval batch and slice, create
  equivalence links.
- **Multi-graph Retrieve All** — fetch and store across all open
  graphs in one operation.
- **Hash signature infrastructure** — `core_hash` for resilient
  archival identity. Hash mappings for continuity when definitions
  change. Commit-time hash guard (v1.8.17b).
- **Regime selection** — authoritative BE selection of one coherent
  hash family per (edge, date, retrieval) triple. Eliminates
  double-counting across context dimensions.

---

## Pillar 3: Bayesian Inference Engine (Project Bayes)

*Shipped: v1.7.14b – v1.10 (Mar – Apr 2026)*

The infrastructure that makes Pillar 1's evidence-conditioned
forecasting possible. A full Bayesian inference engine that
automatically fits statistical models to conversion data, producing
posterior distributions with calibrated uncertainty.

**What to include in v2.0 communiqué:**

- **Bayesian compiler** — two-phase model: Phase 1 (window, step-day),
  Phase 2 (cohort, entry-day). Beta/Binomial rates, Dirichlet branch
  groups, latent onset, t95 soft constraints, unified MCMC dispersion.
  Context slice pooling via hierarchical Dirichlet (Phase C).
- **Automatic model fitting** — `runBayes` flag enables nightly
  automation. 3-phase daily pipeline: patch apply → fetch + commission
  → drain. Reconnect on browser reopen. Warm-start reuses previous
  posteriors with quality gating (Rhat < 1.10, ESS ≥ 100).
- **Async compute** — Modal-hosted MCMC, submit/status/cancel
  lifecycle, webhook delivery, git-committed patch files.
- **Quality surfaces** — Bayesian Posterior Card, PosteriorIndicator,
  quality tiers (failed/warning/good-0..3), confidence bands, model
  CDF overlay on lag fit, LOO-ELPD in Forecast Quality overlay and
  Edge Info Model tab.
- **Promoted model vars** — `model_vars` array per edge with multiple
  candidate sources (analytic, bayesian, manual). Promotion resolver
  selects the active source based on per-edge or graph-level
  preference.

---

## Pillar 4: Canvas as Analytics Workspace (Project Canvas)

*Shipped: v1.7 (Mar 2026), matured through v1.8*

The graph canvas is no longer just a DAG editor. It is a freeform
analytics workspace where live charts, annotations, and grouping sit
alongside conversion nodes.

**What to include in v2.0 communiqué:**

- **Canvas analyses** — pin any analysis result onto the canvas as a
  live, updating chart. Drag from analytics panel, or click-drag to
  draw. All analysis types supported. Multi-scenario rendering.
- **Three-mode system** — Live (tracks navigator context), Custom
  (chart-owned delta DSL composed onto live base), Fixed (fully
  self-contained).
- **Multi-tab containers** — each tab independently owns analysis
  type, DSL, view mode, kind, scenario mode, display settings. Tab
  drag between containers.
- **Post-it notes** — coloured sticky notes (6 colours, 4 font sizes)
  for freeform annotation.
- **Containers** — labelled rectangles for visually grouping nodes.
  Enclosed nodes move with the container.
- **Shared toolbar** — single toolbar driving all view types. DSL →
  scenarios → analysis type → view mode → kind → subject → display →
  connectors → actions.
- **Chart display planning** — centralised decision layer for
  time-series vs scenario-axis, metric basis, multi-scenario collapse.
- **Minimise/restore** — canvas objects can be minimised to compact
  form. Custom minimised renderers for bridge view and expectation
  gauge.
- **Dashboard mode** — fitView includes all canvas elements.

---

## Pillar 5: Platform & Workflow

*Shipped across multiple releases*

**What to include in v2.0 communiqué:**

- **GitHub OAuth** — per-user authentication via GitHub App. Replaces
  shared PAT. One-click reconnect on token expiry. Read-only mode
  without credentials.
- **Amplitude funnel export** — select nodes → construct a correctly
  specified funnel in Amplitude with event filters, context segments,
  cohort exclusions, and graph-derived conversion windows.
- **Variant contexts & hash guard** — behavioural segment filters on
  context definitions. Commit-time detection of hash-breaking edits
  with mapping creation.
- **Headless CLI** (v1.10) — `param-pack` and `analyse` commands.
  Full parameter and analysis pipeline from the terminal. Same
  codepath as the browser. Multi-scenario, scalar extraction, disk
  bundle caching.
- **Share links** — static and live chart sharing via URL.
- **Dark mode**.
- **Bundled sample data** — zero GitHub API calls for sample data.
  Priority-sorted clone resilience.
- **20+ analysis types** — graph overview, outcomes, reach, bridge
  view, path through/between, outcome comparison, branch comparison,
  multi-waypoint, conversion funnel, constrained path, branches from
  start, multi-outcome/branch comparison, node/edge info (with data
  depth), selection statistics, plus all snapshot-DB-backed types.

---

## Remaining work to ship v2.0

### Block 0: Phase A parity gate (critical path entry)

| # | Work | Est | Risk |
|---|------|-----|------|
| 0.1 | Single-hop parity gate: `cohort_maturity` v1 vs v2 on adjacent subjects, field-by-field, real graph data | S (0.5–1d) | Low — code exists |
| 0.2 | Multi-hop acceptance tests: evidence parity across topologies, forecast convergence (τ→∞ → span_p), frontier conditioning | M (2–3d) | Med — first real multi-hop exercise |
| 0.3 | Fix issues surfaced, promote `cohort_maturity_v2` as default | ? (0–3d) | Buffer — debugging MC simulator if parity fails |

**Block total: 3–7d.** Risk concentrated in 0.3.

### Block 1: Generalised forecast engine (core new work)

Extract reusable forecast maths from `cohort_forecast_v2.py` into
shared modules. `cohort_forecast_v2.py` becomes a thin consumer of
those modules in the same step — the extraction *is* the refactor.
The 1,154-line file gets smaller, not duplicated.

| # | Work | Est | Notes |
|---|------|-----|-------|
| 1.1 | **Best-available promoted model resolver** — given edge, return best model params (Bayes posterior → promoted MLE → prior default). Unifies `read_edge_cohort_params` (108 lines) and `_resolve_completeness_params` into one resolver consuming the existing `model_vars` array. Single resolver, explicit provenance | M (2–3d) | Prerequisite for everything. See cohort-maturity/INDEX.md §6 |
| 1.2 | **`ForecastState` contract** (Pydantic) — observed trajectory, model trajectory, epoch boundaries, completeness profile, posterior identity, provenance | S (1d) | The IR between raw data and consumer output. Fields well-understood from doc 29 |
| 1.3 | **`evaluate_forecast_at_tau` scalar helper** — model params + tau → rate, completeness, uncertainty. Wraps existing `compute_completeness` (35 lines) + `forecast_rate` with uncertainty from resolver SDs | S (1d) | Extracted from existing v2 maths |
| 1.4 | **Unified basis resolver** — scope × temporal_mode → resolved params with provenance. Replaces three scattered cascades (`read_edge_cohort_params`, `_resolve_completeness_params`, `posteriorSliceResolution.ts`). All consumers must produce identical results after change | M–L (3–5d) | **Scope-cut candidate → v2.1.** If cut, 1.1 handles best-available cascade and existing per-consumer cascades continue to work. Saves 3–5d. Divergence risk already present |
| 1.5 | **`conditional_p` emission** — per-context conditional probability from Phase C posteriors. Derive from per-slice Dirichlet weights, emit through worker → patch → model_vars | M (2–3d) | Consumption side of existing Phase C emission |

**Block total: 9–13d (6–8d if 1.4 deferred).**

### Block 2: Wire into BE analysis pathway

| # | Work | Est | Notes |
|---|------|-----|-------|
| 2.1 | **BE forecast endpoint** — edge/path + temporal mode → `ForecastState`. Uses promoted model resolver. Pattern established by `/api/lag/topo-pass` | M (2–3d) | New endpoint, well-understood shape |
| 2.2 | **Surprise gauge migration** — replace `_compute_surprise_gauge` (~110 lines in api_handlers.py) with forecast engine scalar layer call. Parity test against current output | S–M (1–2d) | First consumer migration, validates contract |
| 2.3 | **Edge cards / completeness overlay** — replace ~500 lines of scattered completeness annotation in api_handlers.py with `evaluate_forecast_at_tau` calls. FE-only → BE-sourced when available | M (2–3d) | Surgery on 3,795-line monolith is the risk |

**Block total: 5–8d.**

### Block 3: Two-tier FE/BE architecture

| # | Work | Est | Notes |
|---|------|-----|-------|
| 3.1 | FE quick pass preserved — existing analytics gives instant results | 0 | Already works. Verify only |
| 3.2 | BE follow-up pattern — new TS service (~300 lines, modelled on `beTopoPassService.ts`). FE packages evidence, calls BE forecast endpoint, maps result to model_vars/display. Must replicate "awaited before inbound-n" sequencing. UI indicates FE-only vs BE-conditioned quality tier | M (2–3d) | Load-bearing sequencing from topo pass pattern |
| 3.3 | Graceful degradation — if BE unavailable, FE estimates stand | S (0.5d) | Verify + add quality tier indicator |

**Block total: 3–4d.**

### Block 4: Nightly Bayes + Phase C (parallel with Blocks 1–3)

| # | Work | Est | Notes |
|---|------|-----|-------|
| 4.1 | Nightly Bayes production test — enable `runBayes` on real graph, verify end-to-end | S (1d) | Operational, not coding. May surface env issues |
| 4.2 | Phase C test suite + RB-001–005 regime tests — ~6 test classes, compiler type fixtures | M (3–4d) | No existing test infrastructure for this |
| 4.3 | Per-slice visualisation in FE (minimum viable: Edge Info Model tab shows per-context breakdown) | S–M (1–2d) | Data already flows via patch service |
| 4.4 | Dispersion defects (doc 33): synth rerun to measure impact → fix endpoint double-counting and non-exhaustive prior if material | S–M (1–3d) | Fix only if production impact confirmed |

**Block total: 6–10d (parallel with critical path).**

### Block 5: FE improvements

Small user-facing improvements included in the v2.0 scope.

| # | Work | Est | Notes |
|---|------|-----|-------|
| 5.1 | **Persisted path probability / survival probability view** — persist the path prob and survival prob display mode so it survives reload and is available as a graph-level setting | S (1d) | |
| 5.2 | **Hidden nodes in view** — allow nodes to be marked hidden in a view/scenario so they don't render on canvas but remain in the graph structure | S–M (1–2d) | |
| 5.3 | **Mu dispersion** — surface mu (latency location) dispersion/uncertainty on edges, analogous to existing p dispersion | S (1d) | Bayes already computes mu_sd; this is the display side |

**Block total: 3–4d (parallel with Blocks 1–3).**

### Block 6: Release polish

| # | Work | Est | Notes |
|---|------|-----|-------|
| 6.1 | FE preflight removal (doc 30 Phase 5) | S (1d) | Removes unnecessary round-trip |
| 6.2 | **v2.0 public docs** — work up the observe → learn → forecast → present narrative from this plan into user-facing form. Includes: v2.0 CHANGELOG entry (structured around five pillars, sweeps beta releases since v1.0), README rewrite (positioning as evidence-conditioned forecasting platform), user guide updates (multi-hop DSL, per-context Bayes, model adequacy, two-tier forecast, CLI), query expressions reference updates | L (4–5d) | This plan is the basis; public docs are the deliverable |

**Block total: 5–6d.**

### Critical path

```
Block 0 (parity) → Block 1 (extract engine) → Block 2 (consumers) → Block 3 (two-tier) → Block 6 (ship)
                                                      ↑
                          Block 4 (nightly + Phase C) ─┘  [parallel]
                          Block 5 (FE improvements)   ─┘  [parallel]
```

### Effort summary

| Block | Scope | Days (full) | Days (1.4 deferred) | Critical path? |
|-------|-------|-------------|---------------------|----------------|
| **0** Phase A parity | 3 items | 3–7 | 3–7 | Yes — gate |
| **1** Forecast engine | 5 items | 9–13 | 6–8 | Yes |
| **2** Wire consumers | 3 items | 5–8 | 5–8 | Yes |
| **3** Two-tier FE/BE | 3 items | 3–4 | 3–4 | Yes |
| **4** Nightly + Phase C | 4 items | 6–10 | 6–10 | Parallel |
| **5** FE improvements | 3 items | 3–4 | 3–4 | Parallel |
| **6** Release polish | 2 items | 5–6 | 5–6 | Yes (tail) |
| | | **34–52** | **31–47** | |

**Critical path (sequential): 0→1→2→3→6 = 25–38d full, 22–33d with 1.4 deferred.**
**Parallel work (Blocks 4+5) absorbed into critical path duration.**

---

## Fast-follow (v2.1+)

These are important but do not block the v2.0 milestone.

| Area | Why it can follow |
|------|-------------------|
| **Topology signatures** (doc 10) | Nightly fits work without them. Safety guards, not blocking. First production runs will surface whether stale posteriors are practical |
| **Phase B — x provider** (doc 29d) | Only matters when x ≠ a and upstream is immature. Rare in current graphs |
| **FE stats deletion** (~4000 lines) | Technical debt. BE is authoritative; FE fallback still works. Three design decisions needed (D11, Pattern A, cohortsForFit) |
| **Fit history / asat reconstruction** (doc 27) | Auditing feature. No user request |
| **Mixture latency models** (doc 23 §12) | Per-edge enhancement for bimodal edges |
| **Sampling performance** (doc 22) | QoL. 155s compile time liveable with nightly automation |
| **LOO-ELPD Phase 2** (doc 32) | Trajectory scoring refines Phase 1. Phase 1 already answers the key question |
| **Snapshot query batching** (doc 33B) | Performance optimisation, not correctness |
| **Accept/reject preview** (doc 13 §2–3) | Users see quality tiers but can't reject a posterior. Can follow |
| **asat() UI polish** (doc 7) | Typed `asat_date`, chart subtitle/badge. Presentation, not function |
| **Live scenarios enhancements** (project-live-scenarios) | Bulk creation from context dimensions, URL presets. Core live scenarios shipped in v0.99.9 and are part of the v2.0 baseline |

---

## What v2.0 is NOT

- Not a rewrite. The v1.x codebase is the v2.0 codebase.
- Not a breaking release. v2.0 is additive. Existing graphs,
  parameter files, and workflows continue to work unchanged.
- Not feature-complete for Bayes. Phase B (x provider), topology
  signatures, and the full FE stats deletion follow in v2.1+.

The version number reflects the magnitude of what has been built —
five major capability pillars that collectively transform what DagNet
can do — not a compatibility boundary.

---

## Cross-references

- **Programme**: `docs/current/project-bayes/programme.md`
- **Project Bayes INDEX**: `docs/current/project-bayes/INDEX.md`
- **Cohort maturity INDEX**: `docs/current/project-bayes/cohort-maturity/INDEX.md`
- **Generalised forecast engine**: `docs/current/project-bayes/29-generalised-forecast-engine-design.md`
- **Phase A design**: `docs/current/project-bayes/29c-phase-a-design.md`
- **Canvas docs**: `docs/current/project-canvas/`
- **Snapshot DB docs**: `docs/current/project-db/`
- **Codebase docs**: `docs/current/codebase/`
