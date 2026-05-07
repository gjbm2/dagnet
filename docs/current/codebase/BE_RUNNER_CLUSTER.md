# BE Runner Cluster (`graph-editor/lib/runner/`)

The Python backend's analysis and forecasting layer. **18,481 LOC across 30+ files** — larger than the entire `bayes/compiler/` tree. This doc is the missing umbrella; before this, the cluster was only addressed indirectly through STATS_SUBSYSTEMS, ANALYSIS_TYPES_CATALOGUE, and FE_BE_STATS_PARALLELISM.

**See also**: [stats-pipeline-schematic.md](stats-pipeline-schematic.md) (single-canvas field-flow schematic), [STATS_SUBSYSTEMS.md](STATS_SUBSYSTEMS.md) (the canonical four-subsystem disambiguation map and "which Python entry point do I call" table — read that first if you don't know which function you should be calling), [ANALYSIS_TYPES_CATALOGUE.md](ANALYSIS_TYPES_CATALOGUE.md) (per-runner inventory), [FE_BE_STATS_PARALLELISM.md](FE_BE_STATS_PARALLELISM.md) (FE topo + CF orchestration), [adding-analysis-types.md](adding-analysis-types.md) (developer guide).

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
├── primitives.py                     #   508 — ConditionedTransitionPrimitive, TransitionIdentity, PrimitiveScope, DrawFamilyKey, RNG keying via make_rng (73n Stage 1)
├── prefix_arrival.py                 #   459 — prefix-arrival map (73n Stage 2)
├── primitive_evidence.py             #   577 — admitted window() evidence resolution per primitive (73n Stage 2)
├── primitive_conditioning.py         #   775 — subset / effective-evidence policy + conjugate update applied at primitive construction (73n Stage 3)
├── primitive_residual_guard.py       #   450 — explicit unsupported markers for residual / complement / unparameterised edges (73n Stage 4)
├── subject_span_composer.py          #   664 — compose_subject_span — DAG composition over primitives, returns ComposedSubjectSpan (73n Stage 5b)
├── primitive_readout.py              # 2,609 — four flag-gated readouts: single-hop / multi-hop subject / multi-hop window / active-cohort carrier (73n Stages 5a, 5b, 5c, 6)
│   (../result_cache.py)              #   279 — generic TTL result-cache utility, registry, clear_all (73n Stage 7; lives one level up at lib/result_cache.py)
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

> **Canonical references**: [FORECAST_RUNTIME_ARCHITECTURE.md](FORECAST_RUNTIME_ARCHITECTURE.md) describes the live `cohort_forecast_v3` runtime — `ResolvedCFRuntime`, primitive conditioning and composition, selected-Cohort reduction, selected A-clock evidence, and row projection — and is the maintained engineering reference for this sub-cluster. [COHORT_ANALYSIS_NUMERATOR_DENOMINATOR_SEMANTICS.md](COHORT_ANALYSIS_NUMERATOR_DENOMINATOR_SEMANTICS.md) is its semantic source of truth and carries the "Implementation invariants" section that any change in this sub-cluster must preserve. [FORECAST_STACK_DATA_FLOW.md](FORECAST_STACK_DATA_FLOW.md) owns the labelled I/O and persistence contracts (I1–I17). Reading order: semantics → runtime → data flow. The summary tables here are a file-level orientation; the docs above are authoritative.

`forecast_state.py` + `forecast_runtime.py` + `forecast_application.py` + `forecast_preparation.py` form the forecast engine. The split is load-bearing — they sit at different architectural layers:

| File | Layer | Responsibility |
|---|---|---|
| `forecast_preparation.py` | Request → subjects | `resolve_forecast_subjects`: turns an analysis request into a list of `(edge, anchor_from, anchor_to, slice_keys, candidate_regimes)` tuples. Applies regime selection per doc 30, anchor-node resolution, asat handling. |
| `forecast_runtime.py` | Subjects → runtime bundle | `build_prepared_runtime_bundle`: assembles `PreparedForecastRuntimeBundle` — the immutable plan describing carrier-to-X, subject-span, conditioning evidence, and admission policy for a single subject. **This is the "what to forecast" object.** Read this if you're touching the rate-conditioning seam or planning the direct-`cohort()`-for-`p` path (WP8 / doc 60 — planned, not yet landed; production builders do not enable any WP8 dispatch flag). |
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

## 3a. The conditioned-primitive substrate (73n, default OFF)

73n (Stages 1–8 landed 1-May-26) added a typed primitive substrate
**inside** the CF kernel boundary, between `forecast_runtime` bundle
preparation and the `forecast_state` row builder. The pre-73n
trajectory / summary route remains the live path; primitive readouts
are gated behind environment-variable flags, all defaulting to OFF.

### Module map

| File | Stage | Responsibility |
|---|---|---|
| `primitives.py` | 1 | `ConditionedTransitionPrimitive` — typed posterior over one parameterised edge in a single `(scope, regime, context)` triple. Carries probability + timing posteriors, draw-family identity, raw / weighted / effective evidence views, residual classification. RNG keying via `DrawFamilyKey` + `make_rng`. |
| `prefix_arrival.py` | 2 | Prefix-arrival map: per-edge `tau` distribution induced by the upstream subject prefix. Consumed by primitive evidence resolution and the multi-hop readouts. |
| `primitive_evidence.py` | 2 | Resolves admitted `window()` evidence per primitive; produces the raw and weighted views used by primitive conditioning. |
| `primitive_conditioning.py` | 3 | Applies the subset and effective-evidence policy **once at primitive construction**; emits the conjugate Beta-Binomial update; records doc 52 compatibility-blend metadata. **The single locus** for "what evidence moved this rate". |
| `primitive_residual_guard.py` | 4 | Explicit unsupported classification for residual / complement / unparameterised edges. The substrate never silently invents timing or rate. |
| `subject_span_composer.py` | 5b | `compose_subject_span` runs DAG composition over conditioned primitives; returns `ComposedSubjectSpan`. Reused by the multi-hop and active-cohort readouts. |
| `primitive_readout.py` | 5a, 5b, 5c, 6 | The four readouts at the shared row-builder seam — single-hop, multi-hop subject, multi-hop window, active-cohort carrier. Each is independently flag-gated. |
| `lib/result_cache.py` | 7 | Generic process-memory TTL result-cache utility. Registry; `clear_all()`; `cache_bypass_ctx` for per-request bypass. The existing snapshot-DB cache was migrated onto it; primitive, composed-carrier, and composed-subject caches register alongside. |

### Flag-gated rollout

| Flag | Stage | Surface |
|---|---|---|
| `DAGNET_SINGLE_HOP_PRIMITIVE_READOUT` | 5a | Single-hop window and single-hop subject (`A == X`) cohort readout |
| `DAGNET_MULTI_HOP_SUBJECT_COMPOSITION` | 5b | Multi-hop cohort `A == X` subject-span composition |
| `DAGNET_MULTI_HOP_WINDOW_READOUT` | 5c | Multi-hop `window()` reuses the Stage 5b composer under an independent flag |
| `DAGNET_ACTIVE_COHORT_CARRIER_READOUT` | 6 | Active cohort `A != X` reads through 73m's `compose_carrier_to_x` plus Stage 5b's `compose_subject_span` |

Each flag accepts `OFF` (live path), `SHADOW` (compute primitive
readout in parallel and emit divergence diagnostics, return live
result), and `ON` (return primitive readout). **Production flag-ON
for any of the four is blocked** on a single follow-up: maturity-aware
likelihood migration into the primitive posterior. SHADOW is the
highest mode recommended for production while that follow-up is open.

### Cache invalidation contract

Primitive, composed-carrier, and composed-subject caches use
scope-bearing keys (changes to scope = different key = miss) plus a
TTL. There is no per-key targeted invalidation. Any
`result_cache.clear_all()` call — snapshot writes,
`/api/snapshots/cache-clear`, the per-request `no_cache: true` flag's
`cache_bypass_ctx` bypass — flushes every registered cache. The plan
§739 stop-condition's "an unrelated primitive's cache entry survives"
clause was deliberately softened in Stage 7; per-key invalidation is a
documented follow-up.

### Provenance threading on the response

Stage 8 widened `ConditionedTransitionPrimitive.to_provenance_dict()`
and threaded the per-primitive substrate through every readout's
diagnostic block. Under flag SHADOW or ON, the `[I12]` response carries
per-primitive: identity, evidence role, raw / weighted / effective
evidence totals, evidence-clock provenance, prior source, conditioning
status, draw-family identity, residual / complement diagnostics,
composed subject + carrier topology, and an optional Stage 7
`cache_status` snapshot. The top-level `[I12]` field shape is
unchanged.

`PreparedConditioningEvidence` is now **compatibility metadata only**
— consumers must read per-primitive provenance, not
`p_conditioning_evidence`, to determine which evidence family
conditioned a primitive. The serialised block on the response carries
an explicit `compatibility_metadata_note`. Retirement of
`p_conditioning_evidence` is tracked as Stage 8 Follow-up 8.

For the post-73n CF substrate end-to-end picture see
[FORECAST_STACK_DATA_FLOW.md](FORECAST_STACK_DATA_FLOW.md) §B.6 and
[STATS_SUBSYSTEMS.md](STATS_SUBSYSTEMS.md) §3.3a.

## 4. The cohort-forecast lineage (v1 → v2 → v3)

| File | Status | Notes |
|---|---|---|
| `cohort_forecast.py` (1,638) | dev-only | Original cohort maturity row builder. Retained for back-comparison. |
| `cohort_forecast_v2.py` (1,210) | dev-only | Intermediate. Closer to v3 but predates the closed-form non-latency path. |
| `cohort_forecast_v3.py` (1,708) | **current** | Production row builder. Post-73m Stage 5 (1-May-26) all cohort_maturity v3 rows flow through the trajectory engine via `compute_cohort_maturity_rows_v3` → `compute_forecast_trajectory` per cohort. Structurally non-latency edges are natural degeneracies of the same span-kernel objects (σ=0 → Dirac-at-zero timing object), not a separate row path. |

The `cohort_maturity` analysis type now routes to v3. v1/v2 are gated `devOnly: true` in `analysis_types.yaml`.

**Unified row path inside v3** (post-73m Stage 5):

- The legacy latency/non-latency router fork at `cohort_forecast_v3.py:1071-1110` was retired by 73m Stage 5. The fork keyed on `target_edge.p.latency.latency_parameter` and dispatched non-latency targets to a parallel closed-form Beta-Binomial row builder. Per AP58 the fork was a copy of the resolution chain that drifted: it ignored the prepared subject-span object even when the composed span had upstream latency (the 73h "computed and discarded" surface). Stage 4 narrowed the σ≤0 early return in `forecast_state.py:992` so a prepared subject-span CDF is honoured even when the terminal edge has `sigma=0`; Stage 5 then deleted the router and let the trajectory path absorb the σ=0 limit naturally. The old closed-form helper and its direct unit-test module have now been deleted.
- The trajectory engine reads frame-level evidence via `build_cohort_evidence_from_frames`. **Open AP58 caveat**: that function still contains a fork on the count axis (`is_window`-gated population fallback at `cohort_forecast_v3.py:750-769` running in parallel with the specialised carrier-projection rebuild at `:775-803`), surfaced by 73m Stage 5 unification and pinned by four strict-xfailed tests. Resolution belongs to 73n; see KNOWN_ANTI_PATTERNS AP58 "Outstanding instance" note and `73m-stage-0-baseline.md §§9-12`.

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

**Read order post-unification (30-Apr-26 §4 Step 7)**: the resolver reads `model_vars[promoted_source].probability` first and falls back to `posterior_block` only when the source-ledger lookup fails. The source ledger is the source of truth post-unification; the live `p.posterior` is the promoted projection (single-writer: `applyPromotion`), so the two should always agree on freshly-promoted graphs. The posterior fallback survives as a robustness measure for graphs that arrive un-promoted (older snapshots, share bundles, CLI graphs that bypass `applyPromotion`). The same reorder applies to the `n_effective` read; the canonical field name is `n_effective` (the legacy `window_n_effective` alias is preserved on `posterior_block` for one cycle while consumers migrate). See [`docs/current/posterior-unification-plan-29-Apr-26.md`](../posterior-unification-plan-29-Apr-26.md).

`lag_model_fitter.py` handles `/api/lag/recompute-models` — recomputes per-edge latency fits from snapshot DB evidence on demand. Independent of the live forecast path.

## 9. Maintenance signposts

When working in this cluster:

- **New analysis runner** → start in `analysis_types.yaml`, then `runners.py`, then update FE registry per [adding-analysis-types.md](adding-analysis-types.md). Do not invent a new forecast path — use `handle_conditioned_forecast` for forecast-backed analyses.
- **New forecast-engine field** → add to `ForecastSummary` / `CohortForecastAtEval` / `ForecastTrajectory` in `forecast_state.py`, then through `compute_forecast_summary`/`_trajectory`, then expose via `handle_conditioned_forecast` in `api_handlers.py`. See anti-pattern 14 for how to avoid silent drops in `_build_unified_slices`. Post-73m Stage 6, `ForecastTrajectory` carries diagnostic fields naming the source of each load-bearing object: `subject_span_source`, `subject_probability_source`, `is_completeness_source`, `evidence_denominator` (Stage 4); `carrier_reach`, `carrier_cdf_source`, `path_completeness_source`, `legacy_non_latency_router_bypassed` (Stage 6); plus `runtime_bundle_diag` carrying the full carrier provenance (`cdf_source`, `horizon_ratio`, `transition_source`, …). 73n is expected to expand the existing enums for active cohort(A!=X) — `is_completeness_source` to `'prepared_cdf_arr' | 'path_completeness'`, `path_completeness_source` to `'subject_span_only' | 'composed_path_completeness'`, `evidence_denominator` to `'x_at_x' | 'a_at_anchor'`.
- **Touching the rate-conditioning seam** → read STATS_SUBSYSTEMS §3.3 first. The seam lives in `forecast_runtime.py:build_prepared_runtime_bundle`. WP8 (doc 60 — direct-`cohort()`-for-`p` rate conditioning, intentionally narrow design: would enable `direct_cohort_enabled` for exact single-hop `cohort(A,X-Y)` only) is **planned, not yet landed**; production builders enable no WP8 dispatch flag, and every live request still goes through the pre-WP8 seam. Post-73n Stage 8, `PreparedConditioningEvidence` is **compatibility metadata only** — read per-primitive provenance (§3a) to determine which evidence family conditioned a primitive, not `p_conditioning_evidence`.
- **Touching v3 row construction** → there is no router fork to choose; all cohort_maturity v3 rows flow through `compute_forecast_trajectory` post-73m Stage 5. If a future stage adds a route, surface the bypass on `runtime_bundle_diag.legacy_non_latency_router_bypassed` (currently always `True`) so forensic traces can detect it without code inspection.
- **Touching `build_cohort_evidence_from_frames`** → known AP58 instance on the count axis (the `is_window`-gated fallback at `:750-769` vs the carrier-projection rebuild at `:775-803`). 73n stages 1–8 added the primitive substrate (§3a) that owns the fix; the four strict-xfailed tests in `test_cohort_factorised_outside_in.py` are the regression net. Production flag-ON of the readouts is gated on the maturity-aware likelihood migration follow-up (see §3a). See KNOWN_ANTI_PATTERNS AP58.
- **Touching the primitive substrate (§3a)** → all four readout flags default OFF; SHADOW mode is the highest recommended in production until the maturity-aware likelihood migration follow-up lands. The single conditioning locus is `primitive_conditioning.py` — never apply subset / effective-evidence / conjugate-update logic in carrier, subject, window, or projection consumers; that's the failure mode the substrate exists to prevent. Cache invalidation is coarse-grained — `result_cache.clear_all()` flushes every registered cache; per-key invalidation is a documented follow-up.
- **Adding a derivation** → keep it pure; consume engine output, don't fetch directly. Snapshot DB queries belong in `api_handlers.py` (which then calls the derivation).

## 10. Pitfalls

### Anti-pattern 14: Adding fields to Python types but not to `_build_unified_slices`

**Signature**: you add new fields to `PosteriorSummary` or `LatencyPosteriorSummary` (including `to_webhook_dict()`), wire them through `summarise_posteriors`, and expect them to appear in the FE — but they never arrive. The values are always `undefined`.

**Root cause**: Bayes posterior data flows through a **manually-assembled dict**, not through `to_webhook_dict()`. The path is: `summarise_posteriors()` populates `PosteriorSummary` fields → `_build_unified_slices()` in `worker.py` builds the per-slice dicts → FE reads those dicts. `_build_unified_slices` constructs every field by name — if you add a field to the dataclass but not to `_build_unified_slices`, it never reaches the FE.

**Fix**: when adding a field to `PosteriorSummary` or `LatencyPosteriorSummary`, always also add it to `_build_unified_slices()` in `worker.py` (both the `window` dict and the `cohort` dict), and to `bayesPatchService.ts` projection. Documented in `CHANGE_CHECKLIST.md`.
