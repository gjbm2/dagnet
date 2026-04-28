# BE Runner Cluster (`graph-editor/lib/runner/`)

The Python backend's analysis and forecasting layer. **18,481 LOC across 30+ files** — larger than the entire `bayes/compiler/` tree. This doc is the missing umbrella; before this, the cluster was only addressed indirectly through STATS_SUBSYSTEMS, ANALYSIS_TYPES_CATALOGUE, and FE_BE_STATS_PARALLELISM.

**See also**: [STATS_SUBSYSTEMS.md](STATS_SUBSYSTEMS.md) (the canonical four-subsystem disambiguation map and "which Python entry point do I call" table — read that first if you don't know which function you should be calling), [ANALYSIS_TYPES_CATALOGUE.md](ANALYSIS_TYPES_CATALOGUE.md) (per-runner inventory), [FE_BE_STATS_PARALLELISM.md](FE_BE_STATS_PARALLELISM.md) (FE topo + CF orchestration), [adding-analysis-types.md](adding-analysis-types.md) (developer guide).

---

## 1. Directory shape

```
graph-editor/lib/runner/
├── analyzer.py                       # 529 — top-level orchestrator: parse DSL → graph → predicates → match → dispatch
├── adaptor.py                        # 174 — match_analysis_type, get_adaptor: maps analysis_type → runner
├── runners.py                        # 2,139 — every run_* function (path, funnel, comparison, …)
├── analysis_types.yaml               # declarative when-predicates and runner mappings
├── predicates.py                     # 252 — DSL predicate evaluation
├── graph_builder.py                  # 790 — DagNet graph → NetworkX DiGraph; apply_visibility_mode
│
├── path_runner.py                    # 836 — path enumeration, pruning, conditional state expansion
├── path_runner / state-space         # state = (node, visited_set); exponential in tracked nodes
│
├── forecast_state.py                 # 1,819 — compute_forecast_trajectory, compute_forecast_summary, IS conditioning
├── forecast_runtime.py               # 1,944 — PreparedForecastRuntimeBundle, rate-conditioning seam
├── forecast_application.py           #   228 — annotate_rows, annotate_data_point (legacy blend)
├── forecast_preparation.py           #   573 — resolve_forecast_subjects, regime selection plumbing
├── forecasting_settings.py           #   161 — per-repo forecasting-knob configuration
│
├── cohort_forecast.py                # 1,638 — v1 cohort maturity (legacy, dev-only)
├── cohort_forecast_v2.py             # 1,210 — v2 cohort maturity (legacy, dev-only)
├── cohort_forecast_v3.py             # 1,708 — v3 row builder: closed-form non-latency + MC sweep dispatch
├── cohort_maturity_derivation.py     #   299 — virtual frame derivation per (anchor_day, slice_key)
│
├── span_kernel.py                    #   418 — multi-hop span composition via DP convolution
├── span_evidence.py                  #   197 — span-level evidence composition (doc 29c)
├── span_upstream.py                  #   124 — upstream carrier construction (cohort mode)
├── span_adapter.py                   #   170 — span ↔ runtime bundle adapter
│
├── model_resolver.py                 #   494 — resolve_model_params: bayesian/analytic/manual promotion
├── lag_model_fitter.py               #   549 — /api/lag/recompute-models handler
├── lag_distribution_utils.py         #   350 — log-normal CDF/PDF, quantile, moment matching
├── lag_fit_derivation.py             #   212 — fit observed-vs-model overlay rows
│
├── confidence_bands.py               #   138 — heuristic-σ → MC band reconstruction (FE topo fallback)
├── epistemic_bands.py                #   285 — α/β → epistemic confidence band
├── mece_aggregation.py               #   116 — MECE-aware sum across slices
├── conversion_rate_derivation.py     #   162 — per-bin rate + epistemic block (analysis type)
├── daily_conversions_derivation.py   #   162 — per-cohort y-at-age, carry-forward
├── histogram_derivation.py           #    88 — lag histogram bins
├── constraint_eval.py                #   157 — DSL constraint evaluation against paths
├── funnel_engine.py                  #   320 — Amplitude funnel construction (export feature)
└── types.py                          #   206 — AnalysisRequest, AnalysisResponse, shared dataclasses
```

## 2. Request flow

A user analysis request enters via `POST /api/runner/analyze` → `handle_runner_analyze` in `lib/api_handlers.py`, which routes to the standard runner path or the snapshot-envelope path based on `ANALYSIS_TYPE_SCOPE_RULES` membership (see `analysis_subject_resolution.py` and KNOWN_ANTI_PATTERNS §18). For the standard runner path:

```
api_handlers.handle_runner_analyze(request)
   │
   ▼
analyzer.analyze(request)
   │  ─ parse DSL via query_dsl.parse_query
   │  ─ graph_builder.build_networkx_graph
   │  ─ graph_builder.translate_uuids_to_ids
   │  ─ predicates.compute_predicates_from_dsl
   ▼
adaptor.match_analysis_type(predicates)
   │  ─ matches analysis_types.yaml entry by `when` clause
   ▼
adaptor.get_adaptor(matched.runner)
   │  ─ returns one of the run_* functions in runners.py
   ▼
runners.run_<analysis_type>(graph, params, ...)
   │
   ├─ Graph-consumer path (path, path_to_end, branch_comparison, …)
   │     reads edge.p.mean (already enriched by Stage 2), walks DAG, multiplies scalars
   │
   ├─ Direct CF consumer (run_conversion_funnel today)
   │     calls handle_conditioned_forecast on the whole graph,
   │     extracts subgraph for the selected path, applies the
   │     completeness-weighted variance mixture for hi/lo bands
   │
   └─ In-band forecast consumer (cohort_maturity, surprise_gauge)
         invokes compute_forecast_trajectory or compute_forecast_summary
         for the requested subject; produces per-tau or scalar output
```

## 3. The forecast-engine sub-cluster

`forecast_state.py` + `forecast_runtime.py` + `forecast_application.py` + `forecast_preparation.py` form the forecast engine. The split is load-bearing — they sit at different architectural layers:

| File | Layer | Responsibility |
|---|---|---|
| `forecast_preparation.py` | Request → subjects | `resolve_forecast_subjects`: turns an analysis request into a list of `(edge, anchor_from, anchor_to, slice_keys, candidate_regimes)` tuples. Applies regime selection per doc 30, anchor-node resolution, asat handling. |
| `forecast_runtime.py` | Subjects → runtime bundle | `build_prepared_runtime_bundle`: assembles `PreparedForecastRuntimeBundle` — the immutable plan describing carrier-to-X, subject-span, conditioning evidence, and admission policy for a single subject. **This is the "what to forecast" object.** Read this if you're touching the rate-conditioning seam or the direct-`cohort()`-for-`p` path (WP8). |
| `forecast_state.py` | Runtime bundle → output | `compute_forecast_trajectory` (cohort_maturity rows) and `compute_forecast_summary` (surprise gauge). Applies IS conditioning, evaluates per-cohort, returns trajectory or scalar. **This is the "do the forecast" object.** |
| `forecast_application.py` | Legacy blend | `annotate_rows`, `compute_blended_mean`: the analytic-blend fallback path. Used only when the engine fails or when the caller explicitly opts into the legacy path. |

### Key dataclasses (in `forecast_runtime.py`)

- **`PreparedForecastRuntimeBundle`** — top-level, holds everything `compute_forecast_trajectory` needs for one subject
- **`PreparedCarrierToX`** — denominator-side: how anchor mass arrives at X (collapses to identity for `window()` and for `A = X` cohort cases)
- **`PreparedSubjectSpan`** — numerator-side: the X→end progression kernel
- **`PreparedConditioningEvidence`** — which evidence family is allowed to move the rate (the doc 73b "two logical steps" seam)
- **`PreparedAdmissionPolicy`** — gross-fitted-evidence admissibility per [COHORT_ANALYSIS_NUMERATOR_DENOMINATOR_SEMANTICS.md](COHORT_ANALYSIS_NUMERATOR_DENOMINATOR_SEMANTICS.md)
- **`ClosedFormBetaRateSurface`** — non-latency edges' closed-form Beta surface, used by the v3 row builder's non-latency path

### `compute_forecast_trajectory` vs `compute_forecast_summary`

| Function | Output | Used by |
|---|---|---|
| `compute_forecast_trajectory` | per-tau rows (`p_mean`, `p_sd`, `completeness`, `cohort_evals`, fan draws) | cohort_maturity_v3 row builder, conditioned-forecast handler, daily_conversions chart engine |
| `compute_forecast_summary` | scalar `(p_mean, p_sd, p_sd_epistemic, completeness, completeness_sd, conditioned, n_cohorts_conditioned, …)` | `handle_conditioned_forecast` whole-graph pass, surprise_gauge handler |

Both are inner kernels. **Analysis runners must not import them directly** — use the public `handle_conditioned_forecast` surface instead. See STATS_SUBSYSTEMS §7 entry-point disambiguation table.

## 4. The cohort-forecast lineage (v1 → v2 → v3)

| File | Status | Notes |
|---|---|---|
| `cohort_forecast.py` (1,638) | dev-only | Original cohort maturity row builder. Retained for back-comparison. |
| `cohort_forecast_v2.py` (1,210) | dev-only | Intermediate. Closer to v3 but predates the closed-form non-latency path. |
| `cohort_forecast_v3.py` (1,708) | **current** | Production row builder. Branches on `latency.latency_parameter` to either the closed-form Beta surface (`_non_latency_rows`) or the MC sweep via `compute_cohort_maturity_rows_v3`. |

The `cohort_maturity` analysis type now routes to v3. v1/v2 are gated `devOnly: true` in `analysis_types.yaml`.

**Routing inside v3** (anti-pattern 50 alarm):
- Routing branch keys on `target_edge.p.latency.latency_parameter is True`, **not** on `sigma > 0` or any fitted scalar
- Closed-form path (`_non_latency_rows`) handles non-latency edges with conjugate Beta posteriors. Post 73b Stage 6 (28-Apr-26) the conjugate update fires uniformly across all sources; the previously-discriminated "direct read" shortcut for analytic source has been retired
- MC sweep path handles latency edges; reads frame-level evidence via `build_cohort_evidence_from_frames` and runs `compute_forecast_trajectory` per cohort

## 5. The span-kernel sub-cluster (multi-hop cohort maturity)

`span_kernel.py` + `span_evidence.py` + `span_upstream.py` + `span_adapter.py` implement the DP convolution that allows cohort-maturity charts across arbitrary DAG paths.

Key entries:
- `compose_span_kernel(span_topology, edge_params)` — composes per-edge lag distributions into a single CDF for the whole `X → end` span, by topological DP on the subgraph
- `mc_span_cdfs(...)` — per-draw span CDFs by reconvolving drawn per-edge params through the same kernel
- `build_span_topology(graph, from_node, to_node)` — extracts the relevant subgraph and edge order

This cluster is a documented design (`project-bayes/29*` series); the implementation has *not* been documented in the codebase reference until now.

## 6. The derivation files (per-analysis-type post-processing)

After the engine produces rows, these derivations shape them into chart-ready output:

| File | Analysis type | Notes |
|---|---|---|
| `cohort_maturity_derivation.py` | cohort_maturity | Virtual frame construction per `(anchor_day, slice_key)`, "latest-wins" reconstruction |
| `daily_conversions_derivation.py` | daily_conversions | Per-cohort y-at-age, carry-forward aggregation for monotonicity |
| `lag_fit_derivation.py` | lag_fit | Observed cohort completeness vs model CDF overlay |
| `histogram_derivation.py` | lag_histogram | Per-bin Y deltas across `(anchor_day, slice_key)` |
| `conversion_rate_derivation.py` | conversion_rate | Per-bin rate with epistemic HDI block (doc 49 Part B) |

These are pure transforms — no DB queries, no MCMC. Their inputs come from the engine; their outputs feed `graphComputeClient.ts` normalisers.

## 7. Quality, completeness, and bands

| File | Role |
|---|---|
| `confidence_bands.py` | Heuristic-σ → MC band reconstruction. Used by the FE topo fallback when the engine has not landed yet. Builds a 4×4 covariance matrix from `mu_sd, sigma_sd, onset_sd, onset_mu_corr`. |
| `epistemic_bands.py` | α/β → epistemic-only confidence band. Used by `conversion_rate` per-bin HDI rendering. |
| `mece_aggregation.py` | MECE-aware sum across slices. Refuses to aggregate non-MECE candidates. |

## 8. Model and lag resolution

`model_resolver.py` is the single entry point for "give me the active probability and latency parameters for this edge in this scope and temporal_mode". Returns `ResolvedModelParams` with `alpha`, `beta`, `alpha_pred`, `beta_pred` and the latency block. The `alpha_beta_query_scoped` flag remains on the dataclass as a no-op (always `False`) post 73b Stage 6 retirement — once the discriminator that gated analytic edges through a separate no-update path. All forecast-engine calls flow through this.

`lag_model_fitter.py` handles `/api/lag/recompute-models` — recomputes per-edge latency fits from snapshot DB evidence on demand. Independent of the live forecast path.

## 9. Maintenance signposts

When working in this cluster:

- **New analysis runner** → start in `analysis_types.yaml`, then `runners.py`, then update FE registry per [adding-analysis-types.md](adding-analysis-types.md). Do not invent a new forecast path — use `handle_conditioned_forecast` for forecast-backed analyses.
- **New forecast-engine field** → add to `ForecastSummary` / `CohortForecastAtEval` / `ForecastTrajectory` in `forecast_state.py`, then through `compute_forecast_summary`/`_trajectory`, then expose via `handle_conditioned_forecast` in `api_handlers.py`. See anti-pattern 14 for how to avoid silent drops in `_build_unified_slices`.
- **Touching the rate-conditioning seam** → read STATS_SUBSYSTEMS §3.3 first. The seam lives in `forecast_runtime.py:build_prepared_runtime_bundle`; current behaviour is intentionally narrow (WP8 lands `direct_cohort_enabled` for exact single-hop `cohort(A,X-Y)` only).
- **Touching v3 row routing** → use `latency.latency_parameter`, not `sigma`. Anti-pattern 50.
- **Adding a derivation** → keep it pure; consume engine output, don't fetch directly. Snapshot DB queries belong in `api_handlers.py` (which then calls the derivation).

## 10. Pitfalls

### Anti-pattern 14: Adding fields to Python types but not to `_build_unified_slices`

**Signature**: you add new fields to `PosteriorSummary` or `LatencyPosteriorSummary` (including `to_webhook_dict()`), wire them through `summarise_posteriors`, and expect them to appear in the FE — but they never arrive. The values are always `undefined`.

**Root cause**: Bayes posterior data flows through a **manually-assembled dict**, not through `to_webhook_dict()`. The path is: `summarise_posteriors()` populates `PosteriorSummary` fields → `_build_unified_slices()` in `worker.py` builds the per-slice dicts → FE reads those dicts. `_build_unified_slices` constructs every field by name — if you add a field to the dataclass but not to `_build_unified_slices`, it never reaches the FE.

**Fix**: when adding a field to `PosteriorSummary` or `LatencyPosteriorSummary`, always also add it to `_build_unified_slices()` in `worker.py` (both the `window` dict and the `cohort` dict), and to `bayesPatchService.ts` projection. Documented in `CHANGE_CHECKLIST.md`.
