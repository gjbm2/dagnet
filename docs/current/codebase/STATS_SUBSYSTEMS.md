# Statistical Processing Subsystems

**Purpose**: disambiguation map for the four distinct processing subsystems that produce, enrich, or consume the graph's statistical fields. These look similar — they all touch `edge.p.*` fields, they all feed chart rendering, they all involve some form of "topological" or "pass-over-the-graph" concept — but they are architecturally distinct. Conflating them has repeatedly caused design mistakes and agent confusion.

**See also**: [FE_BE_STATS_PARALLELISM.md](FE_BE_STATS_PARALLELISM.md) (FE topo + CF orchestration and the CF race), [STATISTICAL_DOMAIN_SUMMARY.md](STATISTICAL_DOMAIN_SUMMARY.md) (underlying statistical models — shifted lognormal, Beta/Binomial, completeness, partial pooling), [LAG_ANALYSIS_SUBSYSTEM.md](LAG_ANALYSIS_SUBSYSTEM.md) (what latency fitting computes in detail), [PARAMETER_SYSTEM.md](PARAMETER_SYSTEM.md) (model_vars data model), [ANALYSIS_TYPES_CATALOGUE.md](ANALYSIS_TYPES_CATALOGUE.md) (analysis runner inventory), [project-bayes/INDEX.md](../project-bayes/INDEX.md) (Bayes compiler programme), [project-bayes/73b-be-topo-removal-and-forecast-state-separation-plan.md](../project-bayes/73b-be-topo-removal-and-forecast-state-separation-plan.md) (why the quick BE topo pass was removed on `24-Apr-26`).

---

## 1. Why this doc exists

A recurring failure mode when reasoning about DagNet statistics is to treat "the BE stats pipeline" as a single monolithic thing. It is not. There are **four separate subsystems**, each with its own trigger, inputs, outputs, persistence semantics, and relationship to the query DSL. They run in a specific sequence during query execution (and some run offline, outside query execution entirely).

The subsystems are:

| # | Subsystem | Nature | Trigger | Scope |
|---|---|---|---|---|
| 1 | **Bayes compiler** | Offline MCMC inference | Manual / CLI | Whole graph, batch |
| 2 | **FE topo pass** | In-browser analytic enrichment | Per fetch (synchronous) | Whole graph |
| 3 | **BE CF pass** | Python topologically-sequenced MC + IS | Per fetch (race, 500ms) | Whole graph |
| 4 | **BE analysis runners** | Per-query chart/result production | Per analysis request | Subjects in DSL |

Subsystems 2 and 3 run during the standard Stage 2 fetch pipeline; subsystem 1 runs separately and writes durable fit results into edge files; subsystem 4 consumes the enriched graph to produce analyses. A fifth subsystem, the **quick BE topo pass** (Python analytic mirror of FE topo), existed until `24-Apr-26` but was removed per [project-bayes/73b](../project-bayes/73b-be-topo-removal-and-forecast-state-separation-plan.md); older handover notes and design docs refer to it but the live runtime no longer runs it.

The rest of this doc details each subsystem, the pipeline sequence, the fields each writes/reads, and the common confusions.

---

## 2. Quick reference: what writes what

| Field | Written by | Nature |
|---|---|---|
| `edge.p.model_vars[source='bayesian']` | Bayes compiler (offline) | Aggregate posterior from training corpus. Includes `probability.{alpha, beta, alpha_pred, beta_pred}` + latency block |
| `edge.p.model_vars[source='analytic']` | FE topo pass | Query-scoped analytic fit (moments-based) |
| `edge.p.latency.{mu, sigma, t95, path_t95, path_mu, path_sigma, ...}` | Promoted from whichever model_vars source won `applyPromotion` | Latency fit scalars |
| `edge.p.mean`, `edge.p.sd` | BE CF pass (when landed) / else FE topo-pass blend fallback | Conditioned asymptotic rate + SD |
| `edge.p.latency.completeness` | BE CF pass (authoritative per doc 45) / else FE topo-pass CDF eval fallback | Cohort maturity at query ages |
| `edge.p.latency.completeness_stdev` | BE CF pass | Conditioned uncertainty on completeness |
| `edge.p.evidence.{mean, n, k}` | FE topo-pass evidence aggregation (from query-scoped snapshot counts) | Raw observed conversion data |
| `edge.p.forecast.mean` | BE CF pass (same value as `p.mean` when CF landed) | Forecast asymptote (legacy field retained) |

Key invariants:
- A single field can be written by multiple subsystems — the authoritative writer depends on which pass has landed most recently and what promotion selects.
- Promotion hierarchy (`modelVarsResolution.ts`): `bayesian` (if gated), else `analytic`; `manual` always wins when present.
- The CF pass owns `p.mean`, `p.sd`, `completeness`, `completeness_stdev` — these overwrite whatever the FE topo pass produced once CF arrives.

---

## 3. Subsystem details

### 3.1 Bayes compiler (offline fit)

**What it is**: the MCMC inference system that fits per-edge Bayesian posteriors from a fixed training corpus. Lives in `/bayes/` (compiler/, worker.py, run_regression.py, synth_gen.py). Produces rich posteriors serialised into edge parameter files.

**Trigger**: manual invocation — FE "Fit Posteriors" button, CLI `bayes.sh`, or the run-regression harness. Not triggered by queries.

**Scope**: whole graph, one fit per compiler run. Training corpus is whatever evidence (snapshot subjects + parameter files) the compiler was invoked with.

**Two phases** (see `bayes/compiler/model.py` top comment):
- **Phase 1 (window mode)**: fits per-edge posteriors independently on `window()` slices. Outputs α, β (epistemic), α_pred, β_pred (κ-inflated predictive per doc 49), mu_mean, sigma_mean, onset_delta_days + SDs per edge.
- **Phase 2 (cohort mode)**: uses Phase 1 posteriors as priors (posterior-as-prior), fits path-level lognormal (path_mu, path_sigma, path_onset_delta_days) via Fenton-Wilkinson composition. Per-slice cohort α/β for contexted slices.

**What it writes**: serialised results land (via webhook → API handler) as a `model_vars[source='bayesian']` entry on each edge. One write per compiler run; not refreshed per query.

**Query-scoping**: **none**. Bayes fits are aggregate — they reflect whatever training data the compiler saw, not the user's current query window. "Aggregate bayesian prior" is the correct framing.

**Consumption**: readers go through `model_resolver.resolve_model_params()` which applies quality gates (ESS ≥ 400, rhat < 1.05, converged_pct thresholds) before promoting the bayesian source. If gates fail, falls back to `analytic`.

**Key files**: `bayes/compiler/model.py`, `bayes/compiler/inference.py`, `bayes/compiler/evidence.py`, `bayes/worker.py`, `bayes/results_schema.py`. Downstream consumption: `graph-editor/lib/runner/model_resolver.py:117-277`.

**Design docs**: `docs/current/project-bayes/INDEX.md` is the canonical index (80+ docs). Key references: doc 8 (phases), doc 21 (unified posterior schema), doc 24 (Phase 2 posterior-as-prior), doc 32 (LOO-ELPD), doc 34 (latency dispersion κ), doc 38 (PPC calibration), doc 49 (epistemic vs predictive SDs), doc 45 (forecast parity).

### 3.2 FE topo pass (in-browser analytic enrichment)

**What it is**: the TypeScript analytic statistics pass that runs synchronously during Stage 2 of every graph fetch. Fits per-edge latency (mu, sigma, t95) from cohort evidence, composes path-level parameters via Fenton-Wilkinson, computes completeness scalars.

**Trigger**: `fetchDataService.ts` Stage 2, after per-item fetches complete. Blocks the UI pipeline.

**Entry point**: `statisticalEnhancementService.ts` → `enhanceGraphLatencies()`.

**Scope**: whole graph, every edge with `latency_parameter: true`.

**Inputs**: parameter lookups (window/cohort slices per edge), cohort aggregates from `windowAggregationService.ts`, graph topology, forecasting settings.

**Outputs**: `edge.p.model_vars[source='analytic']` entries plus direct writes to `edge.p.latency.*` scalars (mu, sigma, t95, path_t95, path_mu, path_sigma, completeness, heuristic dispersion SDs). Produces `blendedMean = w_evidence · evidence.mean + (1-w_evidence) · forecast.mean` — the scalar pre-CF consumers (including today's scalar funnel) read as `p.mean`.

**Query-scoping**: yes — consumes the query DSL's cohort window via `cohortWindow` parameter; per-edge fits respect the scoped evidence.

**Key files**: `src/services/statisticalEnhancementService.ts`, `src/services/windowAggregationService.ts`, `src/services/lagHorizonsService.ts`.

### 3.3 BE CF pass (conditioned forecast — sophisticated MC enrichment)

> **See also**: [FORECAST_STACK_DATA_FLOW.md](FORECAST_STACK_DATA_FLOW.md) — the canonical post-73b data-flow and interface-contract reference (interfaces I1–I17). For the per-scenario request graph, the CF response → graph apply mapping, and the full BE analyse dispatch surface, that doc is the maintained artefact; this section here is a narrative overview.

**What it is**: the sophisticated topologically-sequenced MC enrichment that runs the full cohort_maturity v3 pipeline per edge, across the whole graph, using snapshot DB evidence and per-edge IS conditioning on query-DSL-scoped evidence. Writes per-edge conditioned scalars back to the graph. **This is a graph enrichment endpoint, not an analysis type** — the docstring at [api_handlers.py:2513](../../graph-editor/lib/api_handlers.py#L2513) is explicit.

**Trigger**: `fetchDataService.ts` Stage 2, fires alongside the FE topo pass. Raced against a 500ms fast-path deadline (`CF_FAST_DEADLINE_MS`). Fast path merges into the FE topo pass's single render; slow path renders FE fallback and overwrites on arrival.

**Scenario fan-out**: the BE endpoint accepts a `scenarios` array (see below) but the FE client `runConditionedForecast` always sends a single-element array built from the one graph and one DSL it was called with ([conditionedForecastService.ts](../../graph-editor/src/services/conditionedForecastService.ts)). Fan-out over visible scenarios therefore happens one layer up, at the `fetchItems` level: Current is fetched via `useDSLReaggregation` on DSL change, and visible live scenarios are each fetched via `regenerateScenario` — typically orchestrated by `regenerateAllLive`'s sequential loop. Each invocation fires its own Stage 2 and therefore its own CF pass. See `SCENARIO_SYSTEM_ARCHITECTURE.md` §"Auto-regeneration triggers" for the full list of fan-out paths and `FE_BE_STATS_PARALLELISM.md` for the race mechanics.

**Endpoint**: `POST /api/forecast/conditioned` → `handle_conditioned_forecast` ([api_handlers.py:2506](../../graph-editor/lib/api_handlers.py#L2506)).

**Scope**: two modes:
- **Single-edge/path** (`analytics_dsl` provided): scoped to one edge or path span via query DSL.
- **Whole-graph** (`all_graph_parameters`, doc 47): resolves all parameterised edges, processes in **topological order** (START nodes first, then downstream) with cached upstream frames feeding downstream Tier 2 empirical carriers.

**Inner pipeline per edge** ([api_handlers.py:2625-2911](../../graph-editor/lib/api_handlers.py#L2625-L2911)):
1. Snapshot DB query → raw rows within sweep range
2. Regime selection per doc 30
3. `derive_cohort_maturity` → virtual per-day frames
4. `compose_path_maturity_frames` → span-level evidence composition (x-incident vs y-incident edges per doc 29c)
5. `compose_span_kernel` → encodes graph topology as convolution kernel
6. Upstream carrier (cohort mode): `_fetch_upstream_observations` pulls from whole-graph topo cache, builds `XProvider` for IS conditioning
7. `compute_cohort_maturity_rows_v3` → `compute_forecast_trajectory` → full v3 MC with IS
8. Extract scalar `p@∞` and `completeness` from last row

**Per-draw mechanics**: `compute_forecast_trajectory` uses `resolved.alpha_pred, beta_pred` from the promoted source (typically bayesian) as the proposal distribution; draws `p_draws ~ Beta(α_pred, β_pred)`; applies IS weights `w_s = Π_c Binomial.pmf(k_c | n_c, p_s · CDF_s(τ_c))` using query-scoped cohort evidence. The conditioned posterior is the IS-reweighted draw set. `p_mean` is the median of the conditioned draw set at saturation τ.

**Runtime-bundle conditioning seam (current live behaviour)**: before the
row-builder or summary solve runs, the live callers assemble
`PreparedForecastRuntimeBundle.p_conditioning_evidence` in
`graph-editor/lib/runner/forecast_runtime.py`. This object is an internal
statement of which evidence family is allowed to move the rate side; it is
not a second carrier selector and it does not rewrite the subject span. The
current WP8 landing is intentionally narrow:

- exact single-hop `cohort()` subjects enable
  `direct_cohort_enabled = true` and tag the seam as
  `direct_cohort_exact_subject`
- `window()` and multi-hop `cohort()` queries keep the pre-existing
  `snapshot_frames` / `frame_evidence` / `aggregate_evidence` seam depending
  on the caller
- the same helper is used by `handle_conditioned_forecast`,
  `_handle_cohort_maturity_v3`, `compute_cohort_maturity_rows_v3` when it
  synthesises its own bundle, and `_compute_surprise_gauge`, so the live
  callers stay aligned

This is only rate-conditioning metadata. Carrier semantics, latency
semantics, and numerator representation stay on the factorised rules
established by the earlier work packages.

**Dispersion contract (doc 49)**: `p_sd` and `p_sd_epistemic` are both closed-form Beta σ, derived from the resolved α/β pair — **not MC stds of the conditioned draws**. Historically `p_sd` was `np.std(rate_draws[:, -1])` on the IS-conditioned set, which collapses to the epistemic posterior width regardless of how diffuse the sampling prior was (IS-conditioning on O(n) observed evidence dominates the prior). Closed form is the only way to expose predictive dispersion (Beta(α_pred, β_pred)) distinctly from epistemic (Beta(α, β)). The non-latency fallback (`_non_latency_rows` in cohort_forecast_v3.py) derives `p_sd_epistemic` from the conjugate-updated posterior and `p_sd` from the unupdated predictive α_pred/β_pred so that kappa-inflated width is not collapsed by query-window evidence. See docs 45b §Phase C, 47 §5g.

**Naming note (doc 61)**: the `p_sd` / `p_sd_epistemic` pair on the CF response retains the doc 49 convention, which is **inverted** from the doc 61 convention used for latency dispersions (where bare name = epistemic, `_pred` suffix = predictive). On the CF response `p_sd` is predictive and `p_sd_epistemic` is epistemic; on the Bayes latency posterior and `model_vars.latency.mu_sd`, bare name is epistemic and `_pred` is predictive. The two conventions live at different architectural layers (CF inner kernel output vs Bayes-webhook posterior block) and have not been unified. Consumers reading `p_sd` from a CF response should treat it as predictive; consumers reading `mu_sd` from a posterior block should treat it as epistemic. A future extension of doc 61 to the CF-response layer would eliminate this asymmetry. See doc 61 §11 "Acceptance criteria" for the residual.

**Outputs**: per-edge per-scenario `{p_mean, p_sd, p_sd_epistemic, completeness, completeness_sd, tau_max, n_rows, n_cohorts, conditioned}` returned via API response. Applied to graph via `conditionedForecastService.applyConditionedForecastToGraph` — writes `edge.p.blendedMean`, `edge.p.latency.completeness`, `edge.p.latency.completeness_stdev`, `edge.p.forecast.mean`. `p_sd` and `p_sd_epistemic` are returned on the response but **not persisted to graph edges** by the current projector. Consumers that need them (today: the funnel runner's whole-graph CF call) read directly from the CF response. Whole-graph persistence of the dispersion scalars is deferred; see doc 54 §8.2.

**`conditioned` field**: boolean on every per-edge CF result. True when observed evidence was applied to the prior (the usual case when snapshot rows exist for the edge's regime in the query window); false when the result is the unconditioned prior unchanged (no rows found, or the resolver could not bind a regime). Set in both the closed-form path (`NonLatencyResult.conditioned` in `cohort_forecast_v3.py`, written as `(fe is not None and sum_x > 0)`) and the MC sweep path (`bool(sweep.n_cohorts_conditioned)`). Consumers use it diagnostically — it surfaces "no evidence applied" cases that would otherwise be invisible because the prior-mean and unconditioned-mean coincide when the prior is well-calibrated. The funnel runner consumes `conditioned` for logging but does not branch on it: the completeness-weighted variance mixture already widens bands correctly when completeness=0.

**Per-edge vs path-cumulative completeness (gotcha)**: when a caller invokes CF with a single-edge `analytics_dsl: from(X).to(Y)` plus a path-level cohort window, the returned `completeness` is **edge-local** (has this edge's source cohort had time to traverse this single edge?), not path-cumulative (has the original cohort at S₀ had time to reach this stage along the full path?). Edge-local completeness is 1.0 for non-latency edges and ≈1.0 for short-lag edges on historic data. Multi-hop consumers that need path-cumulative completeness should read `latency.completeness` from the scenario graph edge (populated by the fetch pipeline's whole-graph CF pass with the full path DSL in scope), not from per-edge CF responses. The conversion_funnel runner applies this overlay before calling `compute_bars_ef`.

**Query-scoping**: this is the *most thorough* query-scoping of any
subsystem. IS conditioning updates the aggregate bayesian posterior
specifically to the user's query-DSL-scoped snapshot evidence, per edge.
**Doc 73b Stage 2 + Stage 6 status (28-Apr-26)**: Stage 2 promoted
analytic α/β into `model_vars[analytic].probability` so the analytic
source carries an aggregate window-family Beta on the same footing as
bayesian. Stage 6 retired the `alpha_beta_query_scoped` discriminator:
the property is now a no-op (always `False`), `is_cf_sweep_eligible` /
`get_cf_mode_and_reason` are constants returning `True` /
`('sweep', None)`, and the `analytic_degraded` consumer branches have
been removed from `cohort_forecast_v3.py`, `forecast_state.py`,
`api_handlers.py`, `conditionedForecastService.ts`, and
`fetchDataService.ts`. CF runs uniformly across all sources. Doc 73f F16
(28-Apr-26) removed the κ=200 fixed-prior fallback (§3.8 register entry
2, withdrawn): when no source provides α, β, the resolver returns
α=β=0 and consumers render midline without dispersion bands.

**Distinction from FE topo pass**: FE topo is analytic and query-scoped but non-conditioned — a moment-match Jeffreys posterior plus Fenton-Wilkinson latency composition. BE CF is full MC with proper IS on per-edge snapshot evidence, topologically sequenced with upstream carrier propagation. CF supersedes the FE blended `p.mean` and `completeness` when it lands.

**Distinction from cohort_maturity analysis runner**: they share the v3 pipeline (derive → compose → row builder). The cohort_maturity runner returns chart-ready rows for one target edge/span; the CF pass runs the same pipeline across the whole graph and extracts scalar per-edge outputs. Shared code → guaranteed parity.

**Key files**: `lib/api_handlers.py:2506-2925` (handler), `lib/runner/cohort_forecast_v3.py` (v3 row builder), `lib/runner/forecast_state.py:1040+` (`compute_forecast_trajectory`), `lib/runner/cohort_maturity_derivation.py`, `lib/runner/span_evidence.py`, `lib/runner/span_kernel.py`, `src/services/conditionedForecastService.ts` (client).

**Design docs**: doc 45 (forecast parity), doc 47 (whole-graph pass), doc 29 (generalised forecast engine), doc 29c (evidence composition), doc 29g (IS conditioning + sweep), doc 30 (regime selection), doc 31 (subject resolution), doc 50 (CF generality gap — known limitation around non-latency edges).

### 3.4 BE analysis runners (per-query chart/result production)

**What they are**: the runners that respond to user query requests for
specific analysis types (path, funnel, cohort_maturity, path_to_end,
branch_comparison, etc.). They do not all consume forecast state in the
same way: some read the enriched graph, some call the public CF surface
directly, and some run dedicated in-band forecast kernels.

**Trigger**: `POST /api/runner/analyze` → `handle_runner_analyze` ([api_handlers.py:949](../../graph-editor/lib/api_handlers.py#L949)). Dispatched via `analysis_types.yaml` rules.

**Scope**: subjects resolved from the query DSL — typically a single edge, path, or span, not the whole graph.

**Three categories**:
- **Graph-consumer runners** (path, path_to_end, path_through,
  branch_comparison, end_comparison): read `edge.p.mean` (as set by prior
  passes, selected by `apply_visibility_mode` for e/f/e+f), walk the DAG
  via DFS+memoisation, and multiply scalars. Assume the graph has already
  been enriched by FE/BE topo + CF passes. Scalar output, no MC, no
  uncertainty.
- **Direct CF consumers** (`run_conversion_funnel` today): call
  `handle_conditioned_forecast` and consume its per-edge conditioned
  response directly, then project the needed subgraph or path view. They
  use the public CF surface, not the inner kernels.
- **In-band forecast-engine consumers**: `cohort_maturity` fetches its own
  snapshot evidence and invokes `compute_forecast_trajectory` to produce
  per-`tau` rows; `surprise_gauge` uses `compute_forecast_summary` for a
  scalar-only summary path.

**Do analysis runners trigger the CF pass?**: they do **not** trigger the
fetch pipeline's Stage 2 graph-enrichment CF pass. That pass is
independent and runs for every fetch. Analysis runners then do one of
three things:

- read whatever graph state Stage 2 has already produced
- make an explicit direct call to the public CF endpoint
- use an in-band summary or trajectory kernel for their own subject

If Stage 2 CF has not landed yet, graph-consumer runners read the FE/BE
topo fallback scalars (via promotion). Direct CF consumers and in-band
forecast-engine consumers are separate from that graph-state path.

**apply_visibility_mode** ([graph_builder.py:564](../../graph-editor/lib/runner/graph_builder.py#L564)): mutates `edge['p']` in place per visibility mode:
- `'e'`: `p = edge.evidence.mean` (raw k/n), complement-fill for failure edges
- `'f'`: `p = edge.forecast.mean` (asymptote — same value as CF's `p.mean` when CF landed)
- `'f+e'`: `p = edge.p.mean` as-is (the CF-conditioned or topo-pass-blended value)

**Key files**: `lib/runner/runners.py` (all run_* functions), `lib/runner/graph_builder.py` (apply_visibility_mode), `lib/runner/analysis_types.yaml` (dispatch rules), `lib/runner/cohort_forecast_v3.py` (cohort_maturity pipeline — shared with CF pass).

**Design docs**: `ANALYSIS_TYPES_CATALOGUE.md` (what each analysis computes), `adding-analysis-types.md` (developer guide), `CHART_PIPELINE_ARCHITECTURE.md` (chart rendering), doc 29 (forecast engine architecture).

---

## 4. Pipeline sequence — what happens per query

Query execution flow through the subsystems. "Q" denotes a user-initiated query; numbered steps run in sequence (within each step, parallel fans indicated).

```
Bayes compiler (offline, separate) → writes model_vars[source='bayesian']
                                                  |
                                                  ↓
                                     (durable, survives across queries)
                                                  |
Q. User issues query ─────────────────────────────┘
│
├─ Stage 1: Fetch snapshot DB / parameter files (cohortWindow respected)
│
├─ Stage 2: Enrichment (two subsystems)
│   │
│   ├─ FE topo pass (sync, blocks UI)
│   │    Writes: model_vars[analytic], promoted p.latency.*, blendedMean
│   │
│   └─ BE CF pass (async, races 500ms deadline)
│        Writes: p.mean, p.sd, latency.completeness, completeness_stdev
│        Overwrites FE blendedMean and topo-pass completeness on arrival
│
├─ Stage 3: Render
│    (Charts/analyses consume the enriched graph's promoted fields)
│
└─ Stage 4: BE analysis runner (per user-requested chart/analysis)
     Reads one of:
       - persisted graph fields such as edge.p.mean / edge.p.latency.*
       - direct CF response from handle_conditioned_forecast
       - in-band summary or trajectory solve for the requested subject
     Examples:
       - graph-state runners → apply_visibility_mode
       - conversion_funnel → direct CF response
       - cohort_maturity → compute_forecast_trajectory
       - surprise_gauge → compute_forecast_summary
```

**Timing reality**: Stage 2's two passes have different completion windows:
- FE topo: immediate (milliseconds, synchronous)
- CF pass fast path: under 500ms, merges into FE's single render
- CF pass slow path: exceeds 500ms, renders FE fallback then overwrites

The render at Stage 3 uses whatever state has landed. Late arrivals from Stage 2 trigger a second render if they changed promoted fields.

---

## 5. Common confusions and their corrections

**Confusion 1: "the BE stats pass"**
There is no single BE stats pass. On the live fetch path the BE runs one enrichment pass — the BE CF pass (sophisticated MC) — alongside the offline Bayes compiler, which is separate. When someone says "the BE stats pass", ask which one. (Historical: a second "quick BE topo pass" ran alongside CF until `24-Apr-26`.)

**Confusion 2: "the FE topo pass does IS conditioning"**
No — the **BE CF pass** does IS conditioning. The FE topo pass does analytic Fenton-Wilkinson composition plus a blended-mean fallback per edge. The sophisticated topological IS work lives in the CF pass.

**Confusion 3: "p.posterior.alpha is query-scoped"**
The field lives under `model_vars[source='bayesian'].probability.alpha`. When that source is promoted, it's accessible via `p.posterior.alpha`. It is **not query-scoped** — it's from the offline Bayes compiler fit. Query-scoped α/β per edge is `analytic`'s output, which is a Jeffreys-style posterior from scoped `total_k, total_n` (separate from Bayes).

**Confusion 4: "analysis runners trigger the BE CF pass"**
They do not trigger the Stage 2 graph-enrichment CF pass. That pass is
independent and runs for every fetch. Some specialised runners do make
their own direct call to `handle_conditioned_forecast`, but that is
consumption of the public CF surface, not the fetch-pipeline enrichment
pass being triggered again.

**Confusion 5: "the funnel reads pre-baked CF scalars off the graph"**
Not any more. `run_conversion_funnel` calls the CF machinery directly — **one whole-graph CF pass per scenario**, then subgraph extraction for the selected path. The whole-graph shape is necessary because CF needs the full topological context to propagate upstream carriers; a per-edge scoped CF call would be semantically wrong. The funnel consumes CF output per edge (p_mean, p_sd, p_sd_epistemic, completeness, conditioned) to build stage bars with hi/lo bands via the completeness-weighted variance mixture. It does not call `compute_forecast_trajectory` directly — that's an inner kernel; it calls CF via `handle_conditioned_forecast` and extracts the subgraph result.

**Confusion 6: "Bayes compiler's α/β gets re-conditioned at query time"**
No. Bayes produces an **aggregate** posterior from the training corpus; that's durable. The BE CF pass does query-time IS conditioning of **draws** from that posterior, producing a conditioned posterior-representation (mean, SD) written to `p.mean, p.sd`. The bayesian α/β themselves don't change. The engine additionally applies a mass-weighted blend (doc 52) before return, mixing the IS-conditioned draws with the unconditioned draws at ratio `(1 − r) : r` where `r = m_S / m_G` (selected Cohort mass over compiler training mass on the matching temporal axis). This corrects the systematic over-concentration that arises when the query's selected Cohorts overlap the compiler's training set. See [project-bayes/52-subset-conditioning-double-count-correction.md](../project-bayes/52-subset-conditioning-double-count-correction.md).

**Confusion 7 (historical): "`model_vars[analytic].alpha, beta` can be used as a prior"**

> **Resolved 28-Apr-26 (doc 73b Stage 2 + Stage 6)**: this confusion
> no longer exists. Stage 2 promoted analytic α/β into
> `model_vars[analytic].probability` as an aggregate window-family
> Beta — moment-matched from `(mean, stdev)` via
> `buildAnalyticProbabilityBlock` in `modelVarsResolution.ts` — on the
> same footing as the bayesian fit. Stage 6 then retired the
> `alpha_beta_query_scoped` discriminator (always returns False) and
> removed all consumer branches that routed analytic edges through a
> "no conjugate update" shortcut. CF runs the conjugate Beta-Binomial
> update uniformly across all sources, with the engine-level blend
> (doc 52) applying when `n_effective` is set.

The pre-resolution rule was: analytic `α, β` was a query-scoped
Jeffreys posterior (`α = k+1, β = n-k+1` from DSL-windowed
`total_k, total_n`); using it as a prior for a conjugate update with
the same query-scoped evidence double-counted. The discriminator
existed to short-circuit the conjugate-update path for analytic
edges. Stage 2's promotion of analytic α/β into an aggregate window
Beta removed the query-scoping; Stage 6 then removed the now-redundant
discriminator and all its consumer code.

For the bayesian-source case (and now uniformly for all sources), the
engine's blend prevents the subtler overlap-induced over-concentration
(doc 52 §3): even when the aggregate is a legitimate prior,
re-applying a Cohort set that was already in the training set
double-counts its evidence. The correction mixes conditioned and
unconditioned outputs pro-rata to `m_S / m_G`, with `n_effective`
(training mass) exported per temporal mode alongside the posterior.

---

## 6. Field authority cheat sheet

When you read a field, know who wrote it:

- `edge.p.model_vars[source='bayesian'].*` → always and only the Bayes compiler (offline)
- `edge.p.model_vars[source='analytic'].*` → FE topo pass (browser)
- `edge.p.latency.mu, sigma, t95, ...` → promoted from whichever model_vars source is active (per `resolveActiveModelVars`)
- `edge.p.evidence.{mean, n, k}` → FE topo-pass evidence aggregation (from scoped snapshot data)
- `edge.p.mean, edge.p.sd` → BE CF pass when landed; else FE topo pass's blended fallback
- `edge.p.latency.completeness` → BE CF pass when landed; else FE topo pass's CDF eval
- `edge.p.latency.completeness_stdev` → BE CF pass
- `edge.p.forecast.mean` → BE CF pass (same value as `p.mean` when CF landed); legacy field name retained

### Dispersion-field naming (doc 61)

Dispersion fields on the Bayes posterior block and on `model_vars[bayesian].latency` follow the doc 61 convention: **bare field name is always epistemic; `_pred` suffix is always predictive**. The same rule applies on the patch-file slice entries emitted by the worker (`posterior.slices[<key>].mu_sd` / `mu_sd_pred`).

| Field | Flavour | Populated when |
|---|---|---|
| `mu_sd` | Epistemic (posterior SD of μ from MCMC trace) | Always (Bayes or heuristic) |
| `mu_sd_pred` | Predictive (kappa_lat-inflated via `_predictive_mu_sd`) | Only when `kappa_lat` is fitted; absent otherwise |
| `sigma_sd`, `onset_sd` | Epistemic | Always — no predictive mechanism in the current model |
| `path_mu_sd` | Epistemic (posterior SD of path μ) | When cohort-level latency is fitted |
| `path_mu_sd_pred` | Predictive | Not populated in the current model (no path-level kappa_lat) |
| `path_sigma_sd`, `path_onset_sd` | Epistemic | When cohort-level latency is fitted |

**Consumer intent split**:
- **Reporting surfaces** (BayesPosteriorCard text ±, ModelRateChart mini-chart, cohort_maturity_v3 "model belief" overlay curves) read the bare (epistemic) slot.
- **Forecasting surfaces** (cohort_forecast_v3 fan chart, conditioned-forecast MC sweep via `build_span_params`, `compute_forecast_trajectory`) read the `_pred` slot.
- Where `_pred` is absent (no kappa_lat fitted, or pre-migration data), forecast consumers fall back to the bare slot via `ResolvedLatency.mu_sd_predictive` — correct when predictive and epistemic coincide.

**Residual asymmetry**: the CF response carries `p_sd` (predictive, closed-form Beta σ from α_pred/β_pred) and `p_sd_epistemic` (epistemic, from α/β). This retains the doc 49 convention — inverted relative to doc 61 — and has not been unified. See §3.3 dispersion-contract note.

**Probability fields**: `alpha`, `beta`, `hdi_lower`, `hdi_upper` are epistemic; `alpha_pred`, `beta_pred`, `hdi_lower_pred`, `hdi_upper_pred` are predictive. This convention predates doc 61 (set by doc 49 §A.6) and is consistent with doc 61's rule.

If you need to know *which specific pass* wrote the current value of a flat field, trace through the promotion layer (`modelVarsResolution.ts`) and the session log entries for that fetch generation (`CONDITIONED_FORECAST`, and the FE topo log entries in `fetchDataService.ts`).

---

## 7. Entry-point disambiguation — which function should I call?

Analysis authors and new consumers repeatedly pick the wrong Python entry point because the names all involve "forecast" or "conditioned" or "sweep" or "span". This table is the canonical rule. Corresponding "SUBSYSTEM GUIDE" banners live on the functions themselves.

| I want to… | Correct entry point | Do NOT use |
|---|---|---|
| Get query-scoped, evidence-conditioned per-edge `p_mean, p_sd, completeness, completeness_sd` for a specific path/span or the whole graph, for use inside an analysis runner or chart builder | `handle_conditioned_forecast` ([api_handlers.py:2506](../../graph-editor/lib/api_handlers.py#L2506)) — a.k.a. `/api/forecast/conditioned`. Pass `analytics_dsl` to scope to a path; omit to run whole-graph. | `compute_forecast_trajectory`, `compute_forecast_summary`, `mc_span_cdfs` — these are inner kernels and bypass the topo-sequencing, upstream-carrier caching, and span-kernel composition that the handler performs |
| Run the full cohort-population MC sweep for ONE target edge/span internally (e.g. inside the CF handler or cohort_maturity v3 row builder) | `compute_forecast_trajectory` ([forecast_state.py:1096](../../graph-editor/lib/runner/forecast_state.py#L1096)) | Anything inside an analysis runner — go via `handle_conditioned_forecast` instead |
| Compute a per-edge ESS-regularised IS-conditioned summary (legacy surprise-gauge path) | `compute_forecast_summary` ([forecast_state.py:475](../../graph-editor/lib/runner/forecast_state.py#L475)) — surprise gauge only, superseded on implementation by doc 55 | New analyses — use `handle_conditioned_forecast` instead |
| Produce per-draw span CDFs by reconvolving drawn per-edge params | `mc_span_cdfs` / `mc_span_cdfs_for_source` ([span_kernel.py:491, :699](../../graph-editor/lib/runner/span_kernel.py#L491)) — called by `compute_forecast_trajectory` and the model-overlay builder | Anything outside the forecast engine — these are span-kernel primitives |
| Compute per-edge analytic latency scalars (mu, sigma, t95, path_t95, completeness, p_infinity) from cohort evidence | `enhanceGraphLatencies` in [statisticalEnhancementService.ts](../../graph-editor/src/services/statisticalEnhancementService.ts). Produces `analytic` model_vars; run synchronously during Stage 2 of every fetch | `handle_conditioned_forecast` — that's the sophisticated CF pass, a DIFFERENT subsystem |
| Read a per-edge scalar inside an analysis runner (e.g. funnel, path) | `edge.p.mean, edge.p.latency.*` directly, via `apply_visibility_mode` ([graph_builder.py:564](../../graph-editor/lib/runner/graph_builder.py#L564)) — values are already populated by Stage 2 enrichment | Any forecast-engine function — the enrichment has already happened upstream |
| Get per-edge Bayesian aggregate posterior α/β (unconditioned — doesn't reflect current query) | `edge.p.model_vars[source='bayesian'].probability.{alpha, beta, alpha_pred, beta_pred}`. Access via `resolve_model_params` ([model_resolver.py](../../graph-editor/lib/runner/model_resolver.py)) if you need promotion semantics | The inner CF kernels — they use these α/β internally but as the proposal, not the output |

**Rule of thumb**: if you're writing an **analysis runner** or a **chart builder**, the public entry point you need is `handle_conditioned_forecast` (for CF-conditioned scalars). Analytic scalars are already present on the graph from the FE Stage-2 enrichment — read them directly. Everything else is an inner kernel. If you find yourself importing from `forecast_state.py` or `span_kernel.py` inside a runner, stop and re-read this table.

---

## 8. When to read what — task-type guidance

- **Touching Bayes compiler internals**: start with `docs/current/project-bayes/INDEX.md`; key docs are phase-specific.
- **Modifying FE topo pass**: start with `FE_BE_STATS_PARALLELISM.md` (FE topo + CF orchestration), then `LAG_ANALYSIS_SUBSYSTEM.md`.
- **Modifying BE CF pass**: start with `FE_BE_STATS_PARALLELISM.md` §"Conditioned forecast pass", then `project-bayes/45-forecast-parity-design.md`, `project-bayes/47-*.md` (whole-graph), `project-bayes/29g-*.md` (IS + sweep), `project-bayes/50-cf-generality-gap.md` (open issues).
- **Modifying analysis runners**: start with `ANALYSIS_TYPES_CATALOGUE.md`, then the specific runner in `runners.py` and its design doc.
- **Design work that consumes graph state**: read this doc + `STATISTICAL_DOMAIN_SUMMARY.md` before writing designs that assume any particular pass has run.

Do not write designs that invent new "passes" without first locating the existing five subsystems and confirming your addition is genuinely new rather than a rename of existing work.
