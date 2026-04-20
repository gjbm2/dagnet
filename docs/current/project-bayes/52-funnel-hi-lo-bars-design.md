# Funnel Hi/Lo Bars — Level 2 Design

**Status**: Design only — reasoning captured; implementation pending discussion / approval
**Date**: 20-Apr-26
**Relates to**: [doc 49 — Epistemic Uncertainty Bars](49-epistemic-uncertainty-bars-design.md) §Deferred (the origin thread), [doc 51 — Model-Curve Overlay Divergence](51-model-curve-overlay-divergence.md), [STATS_SUBSYSTEMS.md](../codebase/STATS_SUBSYSTEMS.md) (canonical map of the five statistical processing subsystems this design consumes), [FE_BE_STATS_PARALLELISM.md](../codebase/FE_BE_STATS_PARALLELISM.md) (CF pass orchestration), [cohort-maturity-forecast-design.md](../codebase/cohort-maturity-forecast-design.md)

---

## 1. Context

Doc 49 §Deferred (line 695) explicitly parked hi/lo bars for funnel and bridge charts pending "fresh reasoning" — the semantics of uncertainty on aggregate stages differ from per-bin HDIs. This note resolves that reasoning, scoped to linear conversion funnels first; bridges follow by decomposition.

The decision (in the preceding conversation) is **Level 2**: produce funnel bars from the graph state that the standard query pipeline has already enriched, rather than keep the current scalar-only output. The key insight — captured once the subsystem boundaries became clear — is that the sophisticated conditioning work has already been done upstream by the **BE CF pass** ([STATS_SUBSYSTEMS.md](../codebase/STATS_SUBSYSTEMS.md) §"BE CF pass"). The funnel engine reads per-edge conditioned scalars off the graph, multiplies along paths, summarises. No new MC at funnel render time. No new maths.

Level 1 would be attaching bands retroactively to today's scalar path product without acknowledging the underlying statistical framework. Level 2 treats each stage's probability as a proper posterior random variable with bands as MC quantiles — but sources those draws from what the CF pass has already computed, rather than re-running the machinery.

## 2. What funnels do today (for contrast)

Current pipeline, documented by trace in the preceding conversation:

- `run_conversion_funnel` → `run_path` → `calculate_path_probability` at [graph-editor/lib/runner/runners.py:1475](../../../graph-editor/lib/runner/runners.py#L1475)
- Per-edge `p` is a pre-baked scalar, set by `apply_visibility_mode` in [graph_builder.py:580](../../../graph-editor/lib/runner/graph_builder.py#L580)
- `calculate_path_probability` walks the DAG with DFS+memoisation, multiplying per-edge `p` along paths

Three visibility modes yield different per-edge scalars:
- **e**: `p = edge.evidence.mean` (raw k/n), complement-fill for failure edges
- **f**: `p = edge.forecast.mean` (asymptote)
- **f+e**: `p = edge.p.mean` — kept as-is, typically the FE's completeness-weighted blend `w_e × evidence.mean + (1-w_e) × forecast.mean` computed in `statisticalEnhancementService.ts` at fetch time

Key properties of the current funnel:
- **Scalar, not posterior**: no MC, no draws, no uncertainty anywhere in the chain
- **Multiplicative per-edge blending**: in f+e mode, each edge is blended independently before the path product. The cumulative product of independent per-edge blends is not a coherent joint estimator of anything — it's a useful summary but carries no valid uncertainty interpretation
- **Disconnected from the forecast engine**: `compute_forecast_trajectory`, `mc_span_cdfs`, IS conditioning — none of these are invoked

The funnel thus gives a fast point-estimate visualisation, but the numbers do not live in the same coherent statistical framework as the cohort-maturity chart or the conditioned-forecast endpoint. This is the gap Level 2 closes.

## 3. Semantic framework

### 3.1 Denominator convention

Every stage i's probability on a funnel is expressed as a fraction of the **funnel entrants at S₀**:
```
stage_prob_i = (users who reach S_i) / (users who entered S_0)
```
Not y/x (edge rate) at each stage. Not y/a (anchor rate). Specifically **y_i / n_0**.

This matches user expectation for a funnel chart ("what fraction made it through to stage i?") and gives the conventional monotonically-non-increasing bar sequence (100% → X% → Y% → Z%).

For `cohort()` mode the anchor is implicitly S₀ (the funnel's start). For `window()` mode the Cohort for stage-0 arrivals is window-anchored at S₀.

### 3.2 Temporal horizon

The default horizon is **asymptotic (τ → ∞)** — "what fraction of funnel entrants will *eventually* reach stage i?" This is the funnel semantic most useful for capacity planning, attribution, and scenario comparison. It also sidesteps the conversion-window ambiguity (Amplitude's "7-day funnel" vs truly asymptotic conversion).

A finite-horizon extension ("funnel at τ = 7 days") remains possible and is discussed in §8, but the primary design targets τ = ∞.

At τ = ∞, each edge's lognormal CDF saturates to its asymptotic rate `p_edge` (the probability an arriving user eventually converts). The latency/completeness machinery that matters for Cohort maturity (the concept, and the `cohort_maturity` analysis type) collapses here: only the per-edge rate posterior drives the stage probability.

### 3.3 Three regimes

The user-facing visibility mode selects the semantic. Each regime has a precise mathematical definition.

**All three regimes source their inputs from the BE CF pass's machinery**, but at different integration points in interim vs target state (see §4.5):
- **e mode**: reads `edge.p.evidence.{n, k}` on the graph (populated by the standard topo-pass evidence pipeline — not CF-specific).
- **f mode**: reads α/β from the **promoted** `model_vars` source per `resolve_model_params` / `resolveActiveModelVars` — bayesian when its quality gates pass, else analytic_be, else analytic. The funnel does not hardcode a source; it uses whatever the standard promotion hierarchy has selected for the edge.
- **e+f mode**: needs per-edge query-scoped CF-conditioned `(p_mean, p_sd)`. In the **interim**, the funnel runner makes its own scoped call to `/api/forecast/conditioned`. In the **target** (post doc 54 M1-M6), it reads `edge.p.mean / edge.p.sd` off the graph written by the fetch-pipeline's whole-graph CF pass. Outputs are numerically identical within MC tolerance.

Either way, the funnel engine itself performs no MC beyond numpy Beta sampling + cumprod + quantiles. `compute_forecast_trajectory`, `mc_span_cdfs`, and other forecast-engine internals are NOT invoked by the funnel runner — they live inside `handle_conditioned_forecast` (see [STATS_SUBSYSTEMS.md](../codebase/STATS_SUBSYSTEMS.md) §7 for the entry-point disambiguation).

#### e (evidence only)

**Definition**: for each stage i, aggregate raw observed counts across all Cohorts in the query's selected `anchor_day` range:
```
stage_prob_i^e = Σ_c k_{i,c} / Σ_c n_{0,c}
```
where `c` indexes Cohorts (one per `anchor_day`), `k_{i,c}` = number of users observed at stage i from Cohort c, `n_{0,c}` = number of entrants at S₀ from Cohort c, summed over selected Cohorts.

**Properties**:
- Purely observational. No model. No completeness correction. No lognormal.
- **Immature Cohorts understate `k_i`** (users are still on their journey) — exactly what Amplitude shows. A user in evidence-only mode chose this view deliberately.
- Accord with Amplitude: a user running the same funnel in Amplitude over the same date range sees the same number, modulo Cohort-definition differences.

**Source of values**: `edge.p.evidence.n` and `edge.p.evidence.k` per edge on the graph, aggregated over the query's selected Cohorts. These are populated by the same FE/BE topo pass pipelines that feed the cohort_maturity chart; the query DSL's `cohort()` or `window()` clause defines which Cohorts are in scope.

**Uncertainty**: binomial confidence interval around the observed ratio. Wilson (or Agresti-Coull) is preferable to Normal-approximation (safe for small counts and rates near 0/1). Numpy-only: the closed-form Wilson formula is pure arithmetic. No MC required.

#### f (unconditioned model)

**Definition**: for each stage i, MC-estimate `stage_prob_i` from per-edge posterior draws, path-multiplied:
```
For draw s ∈ 1..S:
    For edge j on path S_0 → S_i:
        p_j^(s) ~ Beta(α_j, β_j)  -- edge j's posterior on its asymptotic rate
    reach_i^(s) = Π_{j ∈ edges(S_0, S_i)} p_j^(s)
```

**Properties**:
- Per-edge α/β is resolved via the standard promotion hierarchy: bayesian when its quality gates pass (ESS, rhat, converged_pct), else analytic_be, else analytic. The funnel reads whichever source is promoted for the edge; it does not hardcode `bayesian`.
- "Unconditioned" means not conditioned on the current query's specific selected Cohorts via query-time IS. The promoted source itself may or may not be query-scoped: bayesian is aggregate (training corpus), analytic_be / analytic are query-scoped Jeffreys-style posteriors. Either way, no query-time IS is applied in f mode — that's what e+f adds.
- The path product is the natural asymptotic cumulative reach probability. At τ = ∞ the path CDF is 1 for every edge; only the edge rate matters.
- Per-edge posteriors are fitted independently (Phase 1 for bayesian; evidence-aggregation-per-edge for analytic), so drawing Beta independently per edge reproduces the correct joint distribution over the path.
- MC median across draws → bar height. MC quantiles (5%, 95%) → bands.

**Source of values**: call `resolve_model_params(edge, temporal_mode)` per edge (existing model_resolver API); use `.alpha_pred / .beta_pred` when present (doc 49 predictive variants) else `.alpha / .beta`.

**Why unconditioned**: the user picked "f" to see what the promoted model predicts on its own, independent of query-time IS conditioning on selected Cohorts. Useful for what-if reasoning, scenario comparison, and checking whether the current query's Cohort behaviour matches the model.

#### e+f (model conditioned on e)

**Definition**: per-edge query-DSL-scoped-evidence-conditioned rate **already computed by the BE CF pass**, path-multiplied. No IS re-weighting is performed at funnel render time — the IS conditioning has already happened during the BE CF pass's topologically-sequenced enrichment of the graph. See [STATS_SUBSYSTEMS.md](../codebase/STATS_SUBSYSTEMS.md) §"BE CF pass" for the full pipeline.

For bar heights:
```
For edge j on path S_0 → S_i:
    p_j^(cond) = edge_j.p.mean     -- CF-written scoped-evidence-conditioned mean
stage_prob_i^(e+f) = Π_{j ≤ i} p_j^(cond)
```

For bands (numpy-only, no forecast-engine calls):
```
Moment-match each edge's (p.mean, p.sd) to a Beta posterior:
    κ_j = p_j·(1 − p_j)/σ_j² − 1
    α_j = p_j · κ_j
    β_j = (1 − p_j) · κ_j
Draw p_j^(s) ~ Beta(α_j, β_j),  s = 1..S
reach_i^(s) = Π_{j ≤ i} p_j^(s)
hi/lo_i = quantile(reach_i^(s), 5% / 95%)
```

`p.sd` is written by the BE CF pass alongside `p.mean` ([FE_BE_STATS_PARALLELISM.md](../codebase/FE_BE_STATS_PARALLELISM.md) §"Conditioned forecast pass"). Delta-method propagation of per-edge `p.sd` through the path product is an analytically equivalent alternative for the 90% interval.

**Properties**:
- Conditioning is baked into `edge.p.mean` by the BE CF pass; the funnel reads the scalar and multiplies
- Per-edge conditioned posteriors remain independent across edges (Phase 1 fit independence carries through the BE CF pass's per-edge IS step)
- ESS diagnostics from the CF pass (per-edge effective sample size after IS) are returned in the scoped CF response the runner receives; surface in tooltip for low-ESS warnings

**Why this works without runtime MC**: the BE CF pass is precisely the mechanism that takes the aggregate bayesian prior × query-DSL-scoped evidence and produces per-edge conditioned scalars (via IS on MC draws per edge, topologically sequenced). The funnel is a downstream consumer of those enriched fields. Running MC again inside the funnel engine would duplicate work the BE CF pass has already done.

**Why conditioned**: when a user wants "what does the model think, combined with what these specific Cohorts did", this is the right quantity. It honours both the graph's Bayesian structure and the Cohort-specific observed counts.

### 3.4 Decomposition and the "f as residual" pattern

For e+f mode, the bar is visually **stacked** with two components:
- **e component** (solid): the raw evidence-only fraction
- **f component** (striated): the residual (e+f) − e — what the model adds beyond what's observed

This matches the cohort-maturity chart's "evidence line + forecast crown" pattern. The user sees solid = "observed fraction" and striated = "forecast addition". Striation signals "this height represents model-predicted users who haven't been observed to reach stage i yet".

Invariants:
- `e ≤ e+f` ALWAYS. If Cohorts are mature enough that `e ≈ e+f`, the striation is invisible — correct (nothing to forecast). If Cohorts are immature, striation is visible — correct (model predicts more users will arrive).
- The decomposition is **residual**, not additive: `e+f` is the path product of CF-conditioned per-edge means, `e` is the observed `k/n`; `f = (e+f) − e` is the display residual, not a separately-computed quantity.
- This means `f` displayed in `e+f` view ≠ `f` displayed in `f` view:
  - `f` view (striated-only bar): the raw unconditioned model's stage probability
  - `f` component of `e+f` view (striated top of stacked bar): the model's forecast contribution *given* what evidence we have

Two different "f"s. Needs clear labelling in UI so users don't confuse them.

### 3.5 Uncertainty bars by regime

| Regime | Bar height | Hi/Lo bar |
|---|---|---|
| e | `Σ k_i / Σ n_0` | Wilson / Agresti-Coull binomial CI on observed ratio |
| f | `median(Π p_j^(s))` | MC quantiles (5%, 95%) of the unweighted path product |
| e+f | `Π p_j^(cond)` where `p_j^(cond) = edge_j.p.mean` (CF-written conditioned mean) | MC quantiles (5%, 95%) of Beta draws moment-matched from `(p.mean, p.sd)` on each edge |

Bands cover the **top of the bar** (the total stage probability). In e+f they cover the total e+f height; the striated portion itself doesn't get separate bands (it's a visual decomposition of a single uncertain quantity).

## 4. Engine design

### 4.1 What the graph already gives us (post BE CF pass)

The BE CF pass (`/api/forecast/conditioned` → `handle_conditioned_forecast`; see [STATS_SUBSYSTEMS.md](../codebase/STATS_SUBSYSTEMS.md) §"BE CF pass") is a topologically-sequenced MC enrichment of the whole graph. It performs IS conditioning of the aggregate bayesian prior on query-DSL-scoped snapshot evidence, per edge, in topological order. The outputs land on each edge as scalars:

| Graph field | Meaning | Written by |
|---|---|---|
| `edge.p.mean` | Scoped-evidence-conditioned asymptotic rate | BE CF pass (doc 45) |
| `edge.p.sd` | Posterior SD of the conditioned rate | BE CF pass |
| `edge.p.latency.completeness` | CF-authoritative completeness | BE CF pass |
| `edge.p.latency.completeness_stdev` | CF-authoritative completeness SD | BE CF pass |
| `edge.p.evidence.mean`, `edge.p.evidence.{n, k}` | Raw query-scoped counts | FE/BE topo pass (evidence aggregation) |
| `edge.p.model_vars[source='bayesian'].probability.{alpha, beta, alpha_pred, beta_pred}` | Aggregate Bayes posterior (offline) | Bayes compiler |
| `edge.p.model_vars[source='analytic_be'].*` | Query-scoped analytic scalars | BE topo pass |

The funnel engine is a consumer. It does not call `compute_forecast_trajectory`, `mc_span_cdfs`, or any span-kernel machinery. At τ = ∞, latency CDFs saturate to 1 — only per-edge rate matters.

In the **interim** implementation (§4.5), the funnel receives these CF-produced values via its own scoped CF response rather than reading them off the graph, but the values themselves are identical to what the fetch-pipeline CF pass writes to the graph. Post doc 54 cut-over the funnel reads the same values directly from the enriched graph.

### 4.2 Procedure

The upgraded funnel runner makes **one scoped call to the existing BE CF pass** (`handle_conditioned_forecast` / `/api/forecast/conditioned`), asking it to process the funnel path's edges. The BE CF pass is already topologically-sequenced, already handles upstream-carrier caching, already runs `compute_forecast_trajectory` per edge with proper span-kernel coordination. The funnel does not reinvent any of that — it requests the scoped enrichment, then assembles bars from the response.

```
INPUT:
  graph, funnel path S_0 → S_1 → ... → S_N,
  selected_anchor_day_range (from query DSL's cohort() or window() clause),
  visibility_mode ∈ {e, f, e+f}

STEP 1 — Scoped BE CF call (only if mode = 'e+f'):

  cf_response = POST /api/forecast/conditioned {
      scenarios: [{
          scenario_id, graph,
          analytics_dsl: "from(S_0).to(S_N)",         # funnel path, single-path mode
          effective_query_dsl: "<temporal clause from query DSL>",
      }],
  }

  # cf_response.scenarios[0].edges is an ordered list of per-edge dicts,
  # one per edge on the funnel path, with:
  #   { edge_uuid, p_mean, p_sd, completeness, completeness_sd, ... }
  # Produced by the full topo-sequenced pipeline (upstream carrier feeds
  # downstream edges via Tier 2 empirical frames — same as whole-graph
  # CF except scope-limited to our path).

STEP 2 — Assemble bar heights per regime (numpy only):

  e mode:
    # Reads edge.p.evidence counts already on the graph
    # Σ_c denotes sum over selected Cohorts c (one per anchor_day in range)
    n_0 = Σ_c edges[0].evidence.n_c
    for i in 1..N:
        k_i  = Σ_c edges[i-1].evidence.k_c
        bar_e[i] = k_i / n_0
        lo_e[i], hi_e[i] = wilson_ci(k_i, n_0, alpha=0.10)
    bar_e[0] = 1.0  # convention

  f mode (unconditioned promoted-model posterior):
    # Reads per-edge α/β via resolve_model_params — promoted source
    # (bayesian / analytic_be / analytic depending on promotion)
    p_draws = (N, S) matrix
    for j in 0..N-1:
        resolved_j = resolve_model_params(edges[j], temporal_mode)
        α_j = resolved_j.alpha_pred or resolved_j.alpha
        β_j = resolved_j.beta_pred  or resolved_j.beta
        p_draws[j, :] = rng.beta(α_j, β_j, size=S)
    reach = np.cumprod(p_draws, axis=0)
    reach = prepend stage 0 = 1.0
    bar_f[i]         = np.median(reach[i])
    lo_f[i], hi_f[i] = np.quantile(reach[i], [0.05, 0.95])

  e+f mode (CF-conditioned — uses cf_response from STEP 1):
    # Bar heights are the deterministic path product of CF means
    for j in 0..N-1:
        p_j  = cf_response.edges[j].p_mean
        σ_j  = cf_response.edges[j].p_sd
    bar_ef[i] = Π_{j ≤ i} p_j

    # Bands via moment-matched Beta sampling
    for j in 0..N-1:
        κ_j   = p_j · (1 − p_j) / σ_j² − 1
        α_j'  = p_j · κ_j ;  β_j' = (1 − p_j) · κ_j
        p_draws_cf[j, :] = rng.beta(α_j', β_j', size=S)
    reach_cf = np.cumprod(p_draws_cf, axis=0)
    reach_cf = prepend stage 0 = 1.0
    lo_ef[i], hi_ef[i] = np.quantile(reach_cf[i], [0.05, 0.95])

    # Striation decomposition (display only)
    for i in 0..N:
        e_component[i] = bar_e[i]                          # solid
        f_component[i] = max(0, bar_ef[i] − bar_e[i])      # striated residual

STEP 3 — Assemble rows per scenario × stage for FE rendering.
```

The e+f bands can alternatively be computed by delta-method propagation of `p.sd` through the path product (`Var(Π p_j) ≈ (Π p_j)² · Σ (σ_j / p_j)²`); gives equivalent first-order intervals without sampling. The draw-based approach is preferred for visual consistency with f mode.

### 4.3 Implementation surface

The funnel engine is ~60-80 lines of numpy plus one HTTP call to `/api/forecast/conditioned`. Explicitly:

**What the funnel DOES call**:
- `/api/forecast/conditioned` → `handle_conditioned_forecast` ([api_handlers.py:2506](../../graph-editor/lib/api_handlers.py#L2506)) — scoped to the funnel path via `analytics_dsl`. This is the CORRECT entry point for analysis runners needing query-scoped, evidence-conditioned per-edge scalars.

**What the funnel MUST NOT call directly**:
- `compute_forecast_trajectory` ([forecast_state.py:1040](../../graph-editor/lib/runner/forecast_state.py#L1040)) — inner population-model kernel. Called by `handle_conditioned_forecast`. Calling it directly from an analysis runner bypasses the topo sequencing, upstream carrier caching, and span kernel composition that the BE CF pass coordinates.
- `compute_forecast_summary` ([forecast_state.py:458](../../graph-editor/lib/runner/forecast_state.py#L458)) — narrow per-edge IS helper, used by surprise gauge only. Not the right entry point for new analyses.
- `mc_span_cdfs` / `mc_span_cdfs_for_source` ([span_kernel.py](../../graph-editor/lib/runner/span_kernel.py)) — span-kernel primitives consumed by `compute_forecast_trajectory`. Not analysis-facing.

**Numpy primitives used**:
- Beta sampling: `rng.beta(alpha, beta, size=S)`
- Cumulative product: `np.cumprod(draws, axis=0)`
- Wilson CI: closed-form arithmetic (no scipy)
- Quantile: `np.quantile(reach, [0.05, 0.95], axis=1)`

### 4.4 Evidence aggregation

Raw counts for the e regime are already on the graph per edge (`edge.p.evidence.{n, k}`), aggregated over the query's selected Cohorts by the same pipeline that feeds cohort_maturity. The funnel sums over edges in the path. No new aggregation.

### 4.5 Dependency on the BE CF pass — interim vs target

The e+f mode requires per-edge CF-conditioned scalars. Two ways to source them:

**Interim pattern (this design's M1 implementation)**: the funnel runner makes a scoped CF call to `/api/forecast/conditioned` with `analytics_dsl: "from(S_0).to(S_N)"`. Self-contained — correct regardless of the fetch-pipeline CF race (which runs its own CF pass over the whole graph). The scoped call may run in parallel with the whole-graph pass, but the funnel does not wait for or consume the whole-graph pass's output.

Pays a compute cost — the scoped CF call duplicates work the fetch-pipeline CF pass does on the same edges. Not wasteful in absolute terms: the funnel's scoped call is cheaper than the whole-graph pass it duplicates (N edges vs all edges). Wasteful only *relative to* reading the whole-graph pass's cached results.

**Target state (doc 54 M1-M6 complete)**: the funnel runner reads CF-written fields directly from the enriched graph (`edge.p.mean, edge.p.sd`) and subscribes to the `enrichmentStatusStore` for readiness signalling. The scoped CF call is retired. Output numerically identical within MC tolerance; contract test at cut-over gate verifies this.

**Why this phasing**: doc 54 (CF readiness protocol) is the right long-term architecture but requires FE-wide plumbing. Shipping the funnel upgrade's correctness first, then retrofitting to the shared protocol, is cleaner than holding the funnel back. Doc 52 and doc 54 together spell out the two-step path.

## 5. Visual design

### 5.1 Bar structure

**e view** (evidence only):
```
  ┌─────┐
  │     │  ← solid fill, evidence colour (e.g. scenario primary)
  │ bar │
  └─────┘
     │    ← error bar / whisker: binomial CI
```

**f view** (model only):
```
  ┌╱╱╱╱╱┐
  │╱╱╱╱╱│  ← striated fill, model colour
  │╱╱╱╱╱│
  └╱╱╱╱╱┘
     │    ← error bar: MC quantiles
```

**e+f view** (conditioned model, stacked):
```
  ┌╱╱╱╱╱┐ ←─┐  striated band — f residual = (e+f) − e
  │╱╱╱╱╱│   │  model's additional reach beyond observed
  ├─────┤ ←─┘
  │     │    ← solid band — e = raw observed ratio
  │ bar │
  └─────┘
     │       ← error bar at top — MC quantiles of e+f
```

Single error bar per stage covering the total stage probability. The striation represents visual decomposition, not separate uncertainty.

### 5.2 Colour and striation

- **Solid fill**: evidence colour, fully saturated. Signals "this is observed".
- **Striated fill**: same hue as evidence, lower saturation or hatched pattern. Signals "this is model-predicted".
- **Error bar**: neutral colour (grey or black), thin, covering 5/95 quantile range. Signals "uncertainty".
- Per scenario: each scenario has its own solid/striated colour pair. Bars grouped by stage, coloured by scenario.

### 5.3 Labelling

Hover tooltips per bar should show:
- Stage name
- Bar height with appropriate label:
  - e: "Observed: N%"
  - f: "Forecast: N%"
  - e+f: "Total: N%, of which observed N_e%, forecast N_f%"
- Hi/Lo range with CI/quantile level: "90% CI: [lo, hi]" for e; "90% posterior: [lo, hi]" for f/e+f
- Counts (k_i, n_0) for e and e+f
- ESS warning if low (e+f only)

### 5.4 Interaction with existing chart types

- Existing `conversion_funnel` analysis type is upgraded in place. `run_conversion_funnel` is replaced with the Level 2 implementation — the output schema gains hi/lo, striation-component, and per-regime fields
- Other path-family runners (`run_path`, `run_path_to_end`, `run_path_through`, `run_end_comparison`, `run_branch_comparison`) are unchanged; they continue to emit scalar path products and remain outside this design's scope
- FE chart renderer for the funnel is extended to consume the new fields; renderers for the other path-family charts are untouched

## 6. Cohort aggregation across query range

### 6.1 Scope of evidence

The funnel query defines the Cohort selection via either `cohort(-90d:)` anchored at S_0 or `window(-30d:)` edge-local. Evidence aggregation follows the same pattern as cohort_maturity:

- **Cohort mode** (query uses `cohort()`): the Cohort at each edge is the set of users who entered S_0 on the given `anchor_day`. Aggregate `k_{j,c}` at each edge j across Cohorts c (indexed by `anchor_day`) in the selected range.
- **Window mode** (query uses `window()`): the Cohort at each edge is the set of users who arrived at that edge's `from_node` on the given `anchor_day`. Each edge aggregates its own window-anchored Cohorts.

For funnels specifically, Cohort mode is the natural default (funnel = anchor-anchored by definition). Window mode remains supported for consistency.

### 6.2 Maturity handling

Per-edge per-Cohort observations are collected at the latest `retrieved_at` in the selected `anchor_day` range, giving each Cohort its most up-to-date known counts. **Maturity is not corrected for in e mode** — this is the point (e mode shows raw, possibly immature counts).

In e+f mode, maturity is handled inside the BE CF pass, not by the funnel. The CF pass's per-edge IS conditioning weights draws by each Cohort's Binomial likelihood given its observed counts at its observed age; immature Cohorts contribute less information because their likelihoods are dominated by high-uncertainty tails. The funnel consumes the resulting conditioned `(p_mean, p_sd)` scalars; it does no maturity logic of its own.

No explicit "mature vs immature" Cohort flagging needed in the funnel — the upstream CF pass's IS does it implicitly via the likelihood structure.

## 7. Multi-scenario

Scenarios compose independently. Each scenario has:
- Its own overridden graph (what-if applied) — passed into the analysis per-scenario
- Its own per-edge posterior (same underlying Bayes fit; what-if overrides modify means/SDs)
- Its own MC draws (same RNG seed across scenarios for consistent comparison, or different seeds for independence — design choice)

Produce one bar set per scenario per stage. Side-by-side grouped bars in the chart (scenarios grouped within each stage cluster).

**Interim pattern compute cost**: one scoped CF call per scenario (or a single `/api/forecast/conditioned` request carrying all scenarios — the endpoint already supports `scenarios[]` in its request payload, see [api_handlers.py:2529](../../graph-editor/lib/api_handlers.py#L2529)). For K scenarios × N-edge paths the inner engine runs K·N edge sweeps. Mitigated fully at doc 54 cut-over: each scenario's enriched graph is already passed into the analysis, and post-cut-over the fetch pipeline's whole-graph CF pass per scenario has already populated `edge.p.mean` on each scenario graph — the funnel reads the right scalar off each scenario's graph, no CF calls.

Bridge decomposition between scenarios (for bridge charts) uses the delta between scenario bars plus the joint MC decomposition of contributing factors. Deferred — we're doing funnels first; the engine output carries enough information for a bridge chart to consume when we design it.

## 8. Open questions

### 8.1 Finite-horizon funnel

**Question**: what does a "7-day funnel" look like in Level 2?

**Natural answer**: can't stay in the simple per-edge-read-from-graph pipeline. At finite τ each stage's cumulative reach becomes `Π_{j ≤ i} p_j × CDF_j(τ_j)`, which requires the full latency composition. That's exactly what `compute_forecast_trajectory` / `mc_span_cdfs` do. A finite-horizon funnel would need the BE CF pass (or a specialised variant) to produce per-edge `p × CDF(τ)` scalars at the target τ, rather than just the saturated `p`.

Defer this until the asymptotic funnel is built; it's a different computation path, not a simple extension.

### 8.2 Non-linear funnels

**Question**: what about funnels with branching or joins (e.g. `visited(B, C)` where B and C are at the same level)?

**Current funnel behaviour**: `run_path` handles stage_slots as lists of "member nodes" for grouped stages, computes per-member probability, and allows stage-level grouping in the response.

**Level 2 extension**: for each stage, `stage_prob_i = Σ_paths_to_i Π p_edges_on_path` rather than the simple product. For e+f mode the per-edge conditioned `p.mean` values are already on the graph; the funnel engine just sums over paths. For f mode the per-draw DP sum is one numpy operation over the (S, N) draw matrix. Branching adds no forecast-engine dependency.

### 8.3 Conversion-window semantic (Amplitude parity)

**Question**: Amplitude's funnel semantic uses a session-based conversion window ("within the same session" or "within N days"). Should we add a session/window-based variant?

**Answer for now**: No. Amplitude parity in e mode suffices (same raw counts over the same date range). If a user specifically wants "only count conversions within 7 days", they query `cohort(-90d:).asat(window+7d)` or similar — the query DSL already supports time-window constraints.

### 8.4 What happens while the scoped CF call is in flight or fails

**Question**: the funnel's scoped CF call for e+f mode can itself take 500ms–2s. What does the user see during that time? What if it fails?

**Answer (interim pattern)**: the analysis follows the existing standard loading contract — the `useCanvasAnalysisCompute` hook's `{loading, waitingForDeps, result, error}` state, same as every other analysis type. Chart renders its spinner/pending state while the runner's scoped CF call is in flight. On success, the analysis result populates normally. On CF failure, the analysis reports error state like any other failed analysis — no silent fallback to approximate values.

e and f mode are unaffected: they read graph fields that are already populated by the standard fetch pipeline's topo passes, so they resolve without the scoped CF round-trip.

**Answer (target, post doc 54 cut-over)**: the funnel reads CF-written fields directly from the enriched graph and subscribes to `enrichmentStatusStore`. If CF is pending (fetch-pipeline slow path), the analysis declares `cf_dependency: preferred` and renders approximate-then-upgrades per doc 54's protocol — promotion fallback to analytic_be is the approximation, with a badge, and re-renders definitively when CF lands. This is doc 54's job, not the funnel's; the funnel just declares its dependency and reads whatever `edge.p.mean` promotion returns.

### 8.5 Correlation between stages

**Question**: at per-stage level, we compute `reach_i^(s)` from the same draws. Stages are highly correlated across draws (a big-p_1 draw makes all stage-2+ reaches large). Hi/lo bars per stage reflect marginal uncertainty, not the joint. Is this a problem?

**Answer**: for bar chart visualisation, marginal bars are what users read. They care about per-stage uncertainty, not joint bars. But the correlation matters for any "sum of stage contributions" analysis (e.g. attribution). The joint (S, N+1) array is retained so downstream consumers can do joint analysis if needed.

## 9. Contract invariants and tests

### 9.1 Invariants

1. **Monotonicity**: `bar_i+1 ≤ bar_i` for every stage and every regime (stages can only lose users). For e mode this is observational; for f/e+f it requires `p_edge ≤ 1` (true by construction for Beta draws clipped to (0, 1)).

2. **e ≤ e+f at every stage**: the observed fraction can't exceed the conditioned model's prediction. If Cohorts are fully mature, `e = e+f` to within MC noise. If immature, `e < e+f`.

3. **e+f band width ≤ f band width (at same percentile) in most cases**: the BE CF pass's IS conditioning narrows the per-edge posterior by reweighting toward draws consistent with scoped evidence, so per-edge `p.sd` is typically smaller than the aggregate bayesian posterior SD. This propagates through to tighter bands at each stage. Edge cases exist when evidence is very informative in one direction (e.g. a "surprising" Cohort); worth checking empirically.

4. **f bar at stage 0 = 1.0**: path from S_0 to S_0 is trivially 100%.

5. **e bar at stage 0 = 1.0**: by convention (n_0 / n_0 = 1).

6. **Asymptote consistency with cohort-maturity**: for single-edge queries, the funnel's stage-1 bar (in any regime) should match the cohort-maturity chart's τ → ∞ value for the same edge, to MC noise.

### 9.2 Contract tests

Add a funnel-equivalent of `cohort-maturity-model-parity-test.sh`:

**Test F1**: monotonicity
- Run funnel on synth-mirror-4step (4-stage linear chain)
- For each regime and each scenario, assert bar heights are monotonically non-increasing along stages

**Test F2**: e ≤ e+f
- Run e and e+f on same query
- Assert per-stage `e.bar_height ≤ e+f.bar_height` within 0.1% tolerance

**Test F3**: funnel-cohort_maturity parity at stage 1
- Run cohort_maturity on edge S_0 → S_1, get `p_infinity_mean`
- Run funnel on S_0 → S_1, get stage_1 bar height
- Assert match within 0.5% (MC noise acceptable)

**Test F4**: unconditioned f matches path product of promoted-source posterior means
- Run f regime, get each stage's median
- Compute `Π (α_j / (α_j + β_j))` from `resolve_model_params(edges[j])` per edge
- Assert median ≈ path product within 1% (MC noise from Beta draws)
- Test should cover both bayesian-promoted and analytic_be-promoted graphs (e.g. synth-mirror-4step with Bayes gates passing and failing)

**Test F5**: e+f bar matches path product of CF-written conditioned means
- Run e+f regime, get each stage's bar height
- Compute `Π edge_j.p.mean` directly from graph
- Assert match to float precision (no sampling — bar is deterministic path product)

**Test F6**: e bar uses raw counts
- Create a synth Cohort with known k_i, n_0
- Assert e regime's stage_i bar = k_i / n_0 to float precision
- Assert Wilson CI matches a hand-computed reference (known closed-form values for small k, n)

## 10. Implementation plan

Proposed milestones, each independently testable:

**M1 — Engine core (interim pattern)**
- For e+f mode: runner invokes `/api/forecast/conditioned` scoped to the funnel path, gets per-edge `{p_mean, p_sd}`, moment-matches Beta, draws S samples, cumprod, quantiles
- For f mode: runner calls `resolve_model_params(edge, temporal_mode)` per edge to get the promoted source's α/β (prefers `alpha_pred, beta_pred`), draws Beta, cumprod, quantiles
- For e mode: runner reads `edge.p.evidence.{n, k}` per edge, sums across selected Cohorts, Wilson CI
- Existing `conversion_funnel` analysis type upgraded — `run_conversion_funnel` in `runners.py` replaced with the new implementation. No new analysis type; no side-by-side legacy runner. Project rule (CLAUDE.md §"Code Surface Area"): no backward-compat shims.
- Unit tests: verify `reach_i = Π_{j≤i} p_j` per draw; verify stage 0 = 1.0; verify Wilson CI closed form; verify bar_ef = deterministic path product of p_mean

**M2 — Contract tests**
- F1 (monotonicity), F2 (e ≤ e+f), F5 (e+f bar = path product of CF p_mean), F6 (e = raw counts, Wilson CI correct)
- F3 (funnel-cohort_maturity parity at stage 1), F4 (f = path product of bayesian means within MC tolerance)

**M3 — FE rendering**
- Extend funnel chart component to read hi/lo fields
- Render stacked bar with striation for e+f mode
- Render error bars/whiskers per stage
- Tooltip updates per §5.3
- Visual regression test for all three regimes

**M4 — Multi-scenario**
- Wire multi-scenario: scoped CF call carries multiple scenarios (`handle_conditioned_forecast` already supports this via `scenarios[]` in request)
- Grouped bars in chart
- Contract test on 2-scenario synth setup

**M5 — Documentation and handover**
- User-facing doc update (`graph-editor/public/docs/` funnel explanation)
- Codebase doc update (`ANALYSIS_TYPES_CATALOGUE.md` entry for upgraded `conversion_funnel`)
- CHANGELOG entry noting the behavioural change (scalar output → bars with hi/lo)

**M6 (deferred to doc 54 cut-over) — Retrofit to shared enrichment store**
- Replace scoped CF call with read-from-graph + `enrichmentStatusStore` subscription
- Contract test at cut-over: e+f outputs numerically identical within MC tolerance before and after

Dependencies outside this plan: none that block M1-M5. Interacts lightly with B3 spike (doc 51) — if B3 lands, per-edge posteriors become refined, and the funnel engine benefits automatically since it reads those posteriors. No coupling in either direction.

## 11. Residual tensions for discussion

Flagged for discussion before implementation starts:

- **"Amplitude parity" vs "always correct for maturity"**: the e regime deliberately does NOT correct for Cohort maturity (to match Amplitude), but this means a user reading the e bar may mistake an under-mature Cohort's low value for genuinely low conversion. Options: add a subtle "Cohort maturity indicator" to the e view; or leave it purely raw and trust the user to switch to e+f for mature predictions.

- **Overlap with cohort_maturity analysis type**: for a single-edge funnel (one stage), funnel and cohort_maturity are essentially the same analysis at different visualisations. Keep distinct (cohort_maturity = temporal view of one edge; funnel = stage view of a path), sharing the CF pass as the underlying data source.

- **Visual smoothness of striation when Cohorts are uneven**: where some funnel edges have much tighter CF posteriors than others (more mature Cohorts, more evidence), the striation residual per stage may visibly jitter. Worth empirical testing on real graphs.

Bridge charts are deferred — funnels first. The engine output carries enough information for a bridge chart to consume when we get to it.
