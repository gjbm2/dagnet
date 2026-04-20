# 45 — Forecast Parity: Separating Model Vars from BE Forecasting

**Date**: 17-Apr-26
**Status**: Design — not yet implemented
**Depends on**: Doc 29 (generalised forecast engine), doc 29f (Phase G)

## Problem Statement

Two distinct jobs have been conflated into one endpoint:

- **Job A — Model var generation** (the topo pass): compute mu, sigma,
  t95, path stats, onset, mu_sd, sigma_sd from cohort data. These are
  latency distribution parameters. The topo pass does this correctly
  and has done so since inception. It reads from parameter files, runs
  the stats engine, writes promoted fields onto graph edges.

- **Job B — Conditioned forecasting**: compute p.mean (the
  IS-conditioned rate at the evaluation date) from the full available
  evidence including snapshot DB trajectories, span kernels, upstream
  carriers, and MC population model draws. This is the forecast engine
  generalised in doc 29.

These jobs have different data sources, different compute paths, and
different timing requirements. Attempting to make the topo pass also
do forecasting (by bolting snapshot DB access onto its endpoint) is
architecturally wrong — it creates a parallel implementation of what
the v3 cohort maturity handler already does properly.

### Design invariant

> p.mean displayed on the graph == p@infinity from cohort maturity v3
> for the same edge, same temporal mode, same date range.

Both are reads from the same MC population model draws (doc 29f §Phase
G). They must use the same evidence, same span kernel, same carrier,
same IS conditioning. The only difference is the coordinate system
(B vs A) and aggregation mode.

### Why they diverged

The topo pass Phase 2 (forecast sweep, added later) was built as a
shortcut: read cohort arrays from parameter files, build single-point
CohortEvidence, call `compute_forecast_trajectory` with minimal arguments
(no span kernel, no MC CDF, no carrier). This produced a degraded
forecast that differed from v3 by 10-50% depending on the edge.

The attempt to fix this by adding snapshot DB access and span kernel
construction to the topo pass recreated the v3 handler's preparation
logic — exactly the parallel codepath anti-pattern the design docs
warn against.

## Design

### Job A: Topo pass — model var generation only

**Revert to ex ante state.** The topo pass endpoint (`/api/lag/topo-pass`)
does ONE thing: run the stats engine to compute and promote latency
distribution parameters.

- Input: graph + cohort_data (from parameter files) + edge_contexts
- Compute: `enhance_graph_latencies()` → mu, sigma, t95, path stats,
  mu_sd, sigma_sd, onset, completeness (CDF-based), p_infinity
  (mature cohort filter), p_evidence (raw k/n)
- Output: per-edge promoted fields written to the graph
- **No snapshot DB access.** No `compute_forecast_trajectory`. No span kernel.
  No MC draws. These belong to Job B.

The topo pass produces the model vars that the forecast engine
*consumes*. It does not itself forecast.

### Job B: BE forecasting — via the analysis contract

**BE forecasting is a BE analysis call**, using the existing analysis
compute preparation → dispatch → result pipeline. It is conceptually
an analysis of type `forecast` (or a generalisation of
`cohort_maturity`) that:

1. Receives the standard `PreparedAnalysisComputeReady` payload
   (graph with promoted model vars, snapshot subjects with candidate
   regimes, temporal DSL, display settings)
2. Queries the snapshot DB for full maturity trajectories (same as v3)
3. Applies regime selection (same as v3)
4. Derives frames (same as v3)
5. Builds CohortEvidence from frames (same as v3)
6. Constructs span kernel + carrier (same as v3)
7. Runs `compute_forecast_trajectory` with full arguments (same as v3)
8. Reads the result under coordinate B (per-cohort at tau_i) for
   scalar p.mean, or coordinate A (all tau) for the chart

The key insight from doc 29f §Phase G: **one computation, two reads**.
The chart reads coordinate A (full tau curve). The graph display reads
coordinate B (scalar at evaluation date). Both reads come from the
same MC draw arrays, the same IS conditioning pass, the same carrier.

### Delivery model

For graph display (p.mean on the edge card / bead):

1. **FE instant** (existing): the FE topo pass computes quick model
   vars and a CDF-blend p.mean from parameter file cohorts. Shown
   immediately on graph open.

2. **BE model vars** (existing, retimed): the BE topo pass runs the
   stats engine to compute mu, sigma, t95, mu_sd, sigma_sd. These
   are only consumed if `analytic_be` is the selected model source —
   but they should be **commissioned alongside the FE model vars**
   (same triggering event, not a separate delayed call). The FE and
   BE topo passes are both model var generators; which one gets
   promoted depends on the graph's `model_source_preference`.

3. **BE conditioned forecast** (new): uses the same triggering
   mechanism that the BE topo pass currently uses (~500ms after graph
   open). This is a BE analysis call that runs the full MC population
   model with snapshot DB evidence. It calls `resolve_model_params`
   which is a pure read — it picks the promoted source from the
   edge's `model_vars` based on `model_source_preference` at read
   time. No sequencing dependency on which model var sources have
   arrived: it uses the best available at the moment it runs. When
   the response arrives, its p.mean overwrites the FE/topo value.
   The current BE topo pass trigger timing, cancellation, and
   update-on-arrival patterns are exactly right for this — they just
   need to drive a different endpoint.

Steps 1-2 exist today (step 2 needs retiming). Step 3 is the new
work. It uses the BE analysis dispatch pattern — same as how cohort
maturity v3 already works. The FE preparation service already knows
how to build snapshot subjects with candidate regimes and send them
to the BE.

### Model var selection

The conditioned forecast consumes model vars through
`resolve_model_params` (in `runner/model_resolver.py`). This is
simple declarative resolution — no imperative logic in the forecast
path:

1. Read `model_source_preference` from the graph (or edge override)
2. If an explicit source is set and exists → use it
3. Otherwise `best_available` cascade:
   bayesian (if quality gate passed) → analytic_be → analytic → manual

The forecast does not know or care which source produced the model
vars. It reads the promoted values (mu, sigma, onset, mu_sd,
sigma_sd, alpha, beta, p) and uses them for CDF construction, IS
conditioning dispersions, and rate asymptote. The sources (FE
analytic, BE analytic, Bayes compiler) compete on quality; the
preference setting picks the winner; the forecast consumes the result.

### What the conditioned forecast IS

It is a **graph enrichment endpoint** — not an analysis type.

- **Like the topo pass** in purpose: it produces per-edge scalars
  (p.mean, p_sd, completeness) that get written back to the graph.
  Triggered automatically on graph open. Result improves graph
  display state.

- **Like analysis** in plumbing: it needs snapshot subjects with
  candidate regimes, per-scenario processing (each scenario has
  its own DSL, date range, evidence), and regime selection. It
  reuses the analysis preparation pipeline to build these inputs.

- **Not an analysis type**: it does not produce chart rows,
  dimension metadata, or semantic descriptors. It does not render
  in a chart builder. It does not appear in any analysis type
  registry or dropdown. The result goes back to the graph, not to
  an analysis panel.

The endpoint contract:

    POST /api/forecast/conditioned

    Request: {
      scenarios: [{
        scenario_id, graph, effective_query_dsl,
        candidate_regimes_by_edge, analytics_dsl
      }],
      analytics_dsl,   // shared subject DSL (from/to)
    }

    Response: {
      success: true,
      scenarios: [{
        scenario_id,
        edges: [{
          edge_uuid, p_mean, p_sd,
          completeness, completeness_sd
        }]
      }]
    }

### What this means for the codebase

**Topo pass handler** (`handle_stats_topo_pass`): revert all
snapshot DB / forecast sweep additions. It calls
`enhance_graph_latencies` and returns promoted stats. That's it.

**BE handler** (`handle_conditioned_forecast` in `api_handlers.py`):
new function at a new endpoint. Per scenario, the handler:
1. Resolves subjects from DSL + candidate regimes (same as v3)
2. Queries snapshot DB, applies regime selection (same as v3)
3. Derives frames, builds CohortEvidence (shared function)
4. Builds span kernel + carrier (same as v3)
5. Runs `compute_forecast_trajectory` (same as v3)
6. Reads per-edge scalars from the sweep result

Steps 1-5 are the v3 handler code. Step 6 reads coordinate A at
the horizon (rate_draws[:, -1]) for p.mean — the asymptotic
conditioned rate. This is the same read as what the topo pass
attempted, but using the full evidence and span kernel.

The handler does NOT need to be routed through
`handle_runner_analyze`. It is a standalone endpoint registered
alongside `/api/lag/topo-pass` in the Flask/FastAPI router.

**FE caller**: reuses `analysisComputePreparationService` to build
the scenario payloads (it already computes candidate regimes and
snapshot subjects). A new service or function prepares the request,
sends to `/api/forecast/conditioned`, and writes per-edge scalars
back to the graph on response. The trigger mechanism is the current
BE topo pass trigger (~500ms after graph open).

**CLI**: `param-pack` calls the topo pass (Job A) for model vars.
A new CLI command or flag (e.g. `analyse --type conditioned_forecast`
or a dedicated `forecast` command) runs Job B. The existing
`analyse` command can dispatch to the new endpoint when the type
is `conditioned_forecast`.

## Relationship to doc 29f Phase G

This design IS Phase G, reframed as a clean architectural separation
rather than incremental bolting. The phases map as follows:

- **G.0** (extract `_evaluate_cohort`): DONE per doc 29f.
- **G.1** (topo pass calls `compute_forecast_general`): REPLACED by
  this design. Instead of making the topo pass call the engine, we
  make the topo pass NOT forecast and route forecasting through a
  proper BE analysis call.
- **G.2** (carrier fidelity): addressed naturally — the BE forecast
  analysis has full access to snapshot subjects and upstream
  observations, so it builds Tier 2 carriers by default.

The doc 29f §Phase G text about "one computation, one set of MC draws"
remains the guiding principle. This design achieves it by routing all
forecasting through the analysis pipeline rather than trying to make
the stats pipeline also forecast.

## Implementation from current state

The current branch has changes that attempted to bolt forecasting onto
the topo pass. These should be:

1. **Reverted** in the topo pass handler: remove `snapshot_evidence`
   parsing, remove `build_cohort_evidence_from_frames` calls, remove
   `_build_sweep_params_for_edge`, remove the entire Phase 2 snapshot
   DB path. Restore the topo pass to its pre-session state.

2. **Preserved** where reusable:
   - `build_cohort_evidence_from_frames` in `cohort_forecast_v3.py` —
     useful shared function, already used by v3
   - `FrameEvidence` dataclass — clean intermediate type
   - Candidate regime computation in CLI `topoPass.ts` — not needed
     for the topo pass, but the pattern is correct for the future BE
     forecast caller

3. **New work**: implement the BE forecast as a proper analysis type,
   following the analysis dispatch pattern. This is a separate piece
   of work with its own design and testing.

## Open questions

1. **Scope**: the conditioned forecast endpoint processes per
   scenario, and within each scenario per subject (edge span). The
   topo pass is graph-wide (all edges at once). The conditioned
   forecast needs a subject DSL (from/to) to know which edges to
   forecast. For graph-wide forecasting (all edges), the FE would
   need to make one call per edge, or the endpoint would need to
   accept an "all edges" mode. Which is right?

2. **Trigger reuse**: the current BE topo pass trigger mechanism
   (~500ms delay, cancellation on navigation, update-on-arrival) is
   the right pattern for the BE conditioned forecast. What changes
   are needed to retarget it? Can the topo pass move to immediate
   fire without breaking anything?

3. **Which p.mean?**: should the endpoint return the asymptotic rate
   (coordinate A at horizon = p@infinity) or the rate at the current
   evaluation date (coordinate B, maturity-dependent)? The topo pass
   currently returns the latter. Cohort maturity v3 shows the former
   at high tau. For graph display, p.mean is typically understood as
   the edge's true conversion probability (asymptotic).
