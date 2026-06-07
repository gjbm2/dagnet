# Forecast Runtime Architecture

**Status**: Active reference, 6-May-26
**Scope**: the live `cohort_forecast_v3` runtime: `ResolvedCFRuntime`, primitive conditioning and composition, selected-Cohort reduction, the empirical-evidence operator (strict observed evidence), row projection, and public scalar projection. Handler I/O, persistence, and response application remain owned by [`FORECAST_STACK_DATA_FLOW.md`](FORECAST_STACK_DATA_FLOW.md). Semantic authority remains [`COHORT_ANALYSIS_NUMERATOR_DENOMINATOR_SEMANTICS.md`](COHORT_ANALYSIS_NUMERATOR_DENOMINATOR_SEMANTICS.md).

This doc describes the current runtime after the primitive substrate, carrier/subject composition, selected-Cohort mass reducer, active-carrier projection, and selected A-clock evidence adapter work landed. Reading order for a new contributor: semantics doc first, this doc second, data-flow doc third.

> New to the CF cluster? Read [`CF_MAP.md`](CF_MAP.md) first for orientation and the canonical reading order across all CF docs.

---

## ⚠️ STOP — read this before editing the runtime

**Defensive coding inside the engine is dangerous and must be avoided** ([INVARIANTS.md](INVARIANTS.md) I-47). No `or 0.0`, no `np.clip`, no `try/except: pass`, no `if x is None: return`, no schema case-forks, no `max(0.0, residual)` clamps.

**Branching by case is the recurring failure mode** ([KNOWN_ANTI_PATTERNS.md](KNOWN_ANTI_PATTERNS.md) AP58). Modes differ by which sub-object **degenerates** — identity carrier is data, not a route; `window()` is `cohort()` with carrier-arrival = identity; non-latency is latency with `δ(0)`. If your edit reaches for `if mode == ...` near the centre, the factoring is wrong.

**This is actively policed.** Rules: [CF_ENGINE_DISCIPLINE.md](CF_ENGINE_DISCIPLINE.md). The 21 findings in [`cf-defensive-findings.md`](../project-generalise/cf-defensive-findings.md) are debt being retired — not precedent. New defensive patterns or new case-forks will be reverted. Where existing code looks like it sets a precedent for a fallback, you are looking at exactly the debt being tracked.

---

## 1. The Live Shape

An `[I10]` request enters either the cohort maturity analysis endpoint or the conditioned forecast endpoint. Both surfaces share the same `ResolvedCFRuntime` and `CFProjectionBundle` (`prepare_cf_projection_bundle` in `graph-editor/lib/runner/cf_analysis.py`), then diverge at the reducer chosen by `reducer_for(analysis_type)`: the cohort maturity chart uses the tau reducer `reduce_cohort_maturity_rows`, while CF scalars use `prepare_cf_scalar_bundle` + `reduce_cf_scalars`. The three reducers (`reduce_cohort_maturity_rows`, `reduce_daily_conversions_rows`, `reduce_cf_scalars`) and the runtime still live in `cohort_forecast_v3.py`; `compute_cohort_maturity_rows_v3` survives only as a thin bundle→tau-reducer wrapper for legacy/test callers and is no longer on the production handler path.

The live call order through `compute_cohort_maturity_rows_v3` interleaves the **primitive substrate stage** (the 5 layers in [CF_PRIMITIVE_SUBSTRATE.md](CF_PRIMITIVE_SUBSTRATE.md)) with the **row pipeline stage** (the 8 layers in [CF_ROW_PIPELINE.md](CF_ROW_PIPELINE.md)). Frame evidence (row layer 1) runs **before** substrate construction; substrate stage A runs once; the rest of the row pipeline (layers 2–8) runs **after** the substrate, reading the resolved runtime. See [CF_ROW_PIPELINE.md §1a](CF_ROW_PIPELINE.md#1a-data-flow-vs-call-order) for the explicit ordered diagram.

Single-pool evidence invariant: every consumer in the call chain reads evidence from one canonical pool — the flat `runtime.request_evidence_candidates` — derived from the public `evidence_candidates` argument and/or `per_edge_*_candidates` via `_aggregate_request_candidates`. There is no parameter-shape switch between production and test paths; see [CF_ROW_PIPELINE.md §1b](CF_ROW_PIPELINE.md#1b-single-pool-invariant-for-evidence).

The live flow is:

1. `build_cohort_evidence_from_frames` materialises the chart's selected Cohorts, identity-carrier observed prefixes, epoch boundaries, and completeness evaluation ages. For active `cohort(A, X -> end)` it deliberately zeroes the X-clock target-frame prefixes so local/window evidence cannot masquerade as selected A-clock row evidence.
2. `build_superset_candidates_by_edge` and `build_carrier_superset_candidates_by_edge` translate the evidence rows already returned by the preparation/envelope layer into typed candidates. They do not fetch, dedupe, merge, read `_bayes_evidence`, or choose between source families.
3. `build_resolved_cf_runtime` resolves the subject span `X -> end`, resolves the carrier span `A -> X` only when `A != X`, builds independent subject and carrier arrival maps, and calls `primitive_readout.compute_resolved_runtime_readout`.
4. `compute_resolved_runtime_readout` prepares every primitive through the single conditioning locus, composes `composed_subject`, optionally composes `composed_carrier`, builds unconditioned overlays, and returns role-labelled provenance.
5. `_aggregate_request_candidates` builds one request candidate pool from the superset-derived target, subject-span, and carrier candidates. Primitive-local binding later filters this pool by primitive identity and clock.
6. `_root_window_carrier_n_by_anchor_day` builds the per-anchor base mass (`n_by_anchor`) from the flat `runtime.request_evidence_candidates` pool — runs for both identity-carrier and active modes. The active-only step is the subsequent `ec.a_pop` overwrite at `cohort_forecast_v3.py:6155`, where the frame-bundle `a` is replaced by the candidate-derived count; window/identity-carrier mode preserves `a_pop` from the frame `a_frozen`. Frame-bundle `a` is not an admissible substitute for the candidate-derived count on the active path.
7. `_build_selected_retrieval_frontier` derives the selected retrieval frontier — the one query-wide analysis-observation date (`_analysis_observation_frontier_date`, computed from admitted `evidence_superset_rows`, capped by asat/today) mapped to each Cohort's age. It sets the row epoch bounds and each Cohort's per-anchor frontier `f_c`. The carrier and subject spans are already composed on the runtime in **two operator families**: the conditioned/model operator (`composed_subject` / `composed_carrier`, plus predictive variants) and the empirical-evidence operator (`composed_empirical_subject` / `composed_empirical_carrier`). There is no separate `SelectedAClockEvidence` object and no per-prefix dual-object family — strict observed evidence is owned by the empirical-evidence operator (Phase 6 §4.9), and identity carrier is the degeneracy of the carrier operators, not a parallel pipeline.
8. `_project_runtime_rows` calls `model_span_spine.project_selected_cohort_rows`, which reduces the conditioned and empirical operators through **one DP core** into a `selected_projection`. E+F midpoint and fan fields come from `selected_projection.ef_rate_draws` (the FC continuation, predictive operator basis); the F-mode model surface from `f_rate_draws` (epistemic operator basis); evidence-named fields (`rate`, `evidence_x`, `evidence_y`) from the strict empirical surfaces (`rate_strict`, `evidence_*_strict`). The optional model overlay comes from `runtime.unconditioned_overlays['epistemic']`.
9. `_attach_cf_row_metadata` adds public conditioning/provenance metadata to the first row sentinel.

The key change from the older mental model is that row projection is no longer a direct readout of request-level `p × CDF` curves. E+F rows are now selected-Cohort group trajectories: per-particle `ΣY(τ) / ΣX(τ)` after observed prefixes, Pop D, Pop C, carrier continuation, and subject progression have all been projected into numerator and denominator mass.

## 2. `ResolvedCFRuntime`

`ResolvedCFRuntime` in `cohort_forecast_v3.py` is the request-scoped object that owns conditioning, composition, and projection-facing provenance.

| Field | What it carries |
|---|---|
| `population_root` | The selected population root. For active `cohort(A, ...)` it is A; for `window()` and `cohort(A = X)` it is X. |
| `denominator_node` | X, the node whose arrival mass is the displayed denominator. |
| `subject_end` | The subject end, Y or Z. |
| `composed_subject` | The composed `X -> end` primitive span. It carries subject reach, subject timing CDF, and draw surfaces when draw-coherent. |
| `composed_carrier` | The composed `A -> X` primitive span when active. `None` represents the identity carrier data case. |
| `arrival_map` | The subject arrival map retained for registry/provenance compatibility. Carrier primitives are registered against their carrier-map identity. |
| `carrier_arrival_map` | The carrier-rooted arrival map used to bind carrier primitives. The selected evidence display uses the join-conditioned composed carrier timing surface for subject-row A-clock placement, not this map as an upstream latency shortcut. |
| `request_evidence_candidates` | The one raw candidate pool translated from evidence-superset rows. Runtime code does not read graph-side evidence fields or source-family stores. |
| `evidence_resolution_registry` | Per-request primitive registry and identity-cache backbone. |
| `conditioned_primitive_map` | All conditioned primitives keyed by registry key. |
| `carrier_span` / `subject_span` | Public, role-labelled span summaries for provenance. |
| `projection_provenance` | Projection-facing summary extracted from runtime diagnostics. |
| `public_moments` | Primitive-backed scalar moments: `p_mean`, predictive `p_sd`, and epistemic `p_sd_epistemic`. |
| `unconditioned_overlays` | Prior-only composed subject/carrier pairs keyed by dispersion basis. Post-FC-Atom-1, F mode no longer reads these — F mode renders the unspliced query-conditioned model surface (`f_*`) from the spine. The `epistemic` overlay survives as the **optional model overlay** (frontier-conditioned chart-surface proposal Appendix B; row fields `model_curve_*`), opt-in via `show_model_curve`. The `predictive` overlay is retained for diagnostics but has no default chart consumer. |
| `eligible` / `skip_reason` | Whether the primitive runtime produced a substitutable draw-coherent result and why it degraded if not. |

`ComposedPrimitiveSpan` in `subject_span_composer.py` is deliberately role-neutral. A carrier and a subject are the same type; their meaning comes from the role in `ResolvedCFRuntime`. Both expose span reach (`span_p_mean` / `span_p_draws`) separately from timing (`cdf_mean` / `cdf_draws`). Projection code must keep those separate until it has decided which public object it is emitting.

## 3. Roles and Clocks

Each primitive in a request is prepared once by `primitive_readout._prepare_one` and then conditioned by `primitive_conditioning.condition_primitive`. The caller supplies the role-appropriate arrival map.

| Role | When | Clock root | Evidence binding |
|---|---|---|---|
| Carrier primitive | Active `cohort(A, X -> end)` where A differs from X | A | Reads the carrier arrival map, which propagates arrivals from A through the `A -> X` carrier topology. |
| Cohort subject primitive | `cohort(...)` subject span `X -> end` | X | Reads the subject arrival map, rooted at X, so subject evidence binds to the subject clock rather than the upstream carrier clock. |
| Window subject primitive | `window(...)` subject span `X -> end` | The primitive source node | Uses local identity arrival weights for each primitive. Multi-hop window subjects are composed from independently conditioned local-clock primitives. |

`build_resolved_cf_runtime` constructs the subject and carrier maps separately before calling `compute_resolved_runtime_readout`. `primitive_readout` can rebuild them for legacy callers, but the v3 row path passes both maps explicitly. This two-clock split is load-bearing: denominator mass answers "who reached X by A-clock age τ?", while subject progression answers "given mass at X, when does it reach the subject end?"

Evidence ingress is deliberately outside this clock split. The preparation layer returns evidence-superset rows under `evidence_superset_rows`; the runtime translates those rows into candidates and lets primitive binding admit or reject them by role, identity, and clock support. Downstream runtime code must not branch on whether evidence originally came from snapshot storage or parameter files.

## 4. Identity Carrier

Identity carrier is data, not a route. `window()` and `cohort(A = X)` have selected population already rooted at X, so `composed_carrier` is normally `None`.

Post selected-cohort cutover, identity is handled as pure operator degeneracy with no mode check inside the reducer:

- The composition layer treats `carrier is None` as the identity data case — the conditioned and empirical carrier operators degenerate to reach = 1, Dirac(0) arrival, so the carrier convolution is a pass-through.
- The selected-Cohort reducer (`model_span_spine.project_selected_cohort_rows`) reads **no** mode or identity flag. It consumes the carrier and subject operators and produces window / cohort / identity results purely by which operator degenerates. The legacy `population_root == denominator_node` identity equality check inside the reducer is gone (guarded by `test_reducer_is_mode_blind_against_a_mode_field`).

Active `cohort(A != X)` supplies a real composed carrier for selected-Cohort projection. If carrier composition is unavailable, the runtime degrades rather than silently falling back to window semantics.

## 5. Evidence Materialisation

`build_cohort_evidence_from_frames` is a display-evidence materialiser, not a carrier builder and not a scalar authority. It builds `engine_cohorts` (with `a_pop`, `frontier_age`, epoch boundaries) and the per-Cohort `cohort_list`. Its frame-derived `obs_x`/`obs_y` arrays survive on `engine_cohorts` only for non-v3 legacy consumers (daily-conversions annotation and the legacy hold-out paths); the v3 row builder does not read them for evidence-named row fields.

Post selected-cohort cutover, strict observed evidence is owned by the **empirical-evidence operator** — not a bespoke `SelectedAClockEvidence` object (that object and its builder `_build_selected_a_clock_evidence_from_runtime` are deleted):

- The empirical operator is composed on the runtime as `composed_empirical_subject` / `composed_empirical_carrier` (by `model_span_spine.resolve_request_spans`). It carries the strict per-(source-day, age) observed value/support read from `ConditionedTransitionPrimitive` evidence (Phase 6 §4.9). `project_selected_cohort_rows` reads it through the same DP core as the conditioned operator and emits `rate_strict` / `evidence_*_strict`. There is no separate selected-A-clock cell surface and no `aggregate_by_tau`.
- `_root_window_carrier_n_by_anchor_day` supplies the per-anchor base mass `n_by_anchor` from root-window `n` on the carrier-side first edge (active) or the X-rooted subject primitive (identity carrier — A == X, so the "first carrier edge" is degenerate). It reads `runtime.request_evidence_candidates` directly — the canonical single-pool source — filters by semantic window-family identity, and records per-anchor provenance on `rows[0]['_a_pop_provenance']` (`root_window_carrier_n` / `empty_frames_prior` / `no_root_window_evidence`).
- In **active mode**, `n_by_anchor` overwrites each cohort's `a_pop`; frame-bundle `a` is not an admissible substitute. In **window / identity-carrier mode**, `a_pop` is preserved from the frame's `a_frozen`.

The selected retrieval frontier (`_build_selected_retrieval_frontier`) maps the one query-wide analysis-observation date to each Cohort's age, setting the per-anchor frontier `f_c` and the row epoch bounds. If no admissible evidence resolves, the strict surfaces are zero/NaN and the per-particle reducer degrades to zero-prefix-from-prior — visible degradation, not silent rescue ([COHORT_ANALYSIS_NUMERATOR_DENOMINATOR_SEMANTICS.md](COHORT_ANALYSIS_NUMERATOR_DENOMINATOR_SEMANTICS.md) invariant 12).

Identity carrier is the **degeneracy of the carrier operators** (reach = 1, Dirac(0) arrival), not a parallel observed-surface synthesis. The former `_synthesize_identity_carrier_observed_surface` / `_build_observed_span_evidence_surface` / `_build_zero_edge_observed_surface` / `_join_conditioned_carrier_backmap` machinery and the reducer's `if identity_carrier:` branches (old audit H-5) are deleted; the spine reducer is mode-blind.

## 6. Selected-Cohort Reduction

`model_span_spine.project_selected_cohort_rows` is the E+F trajectory authority. It is a mode-blind reduction over selected Cohorts and runtime particles, not a primitive conditioner and not a public scalar source.

For each selected Cohort, each particle, and each row age:

- Observed prefix ages contribute deterministic `X` and `Y` mass, identical for every particle.
- Identity-carrier future ages hold denominator mass fixed at `x_frozen`; Pop C is empty.
- Active-carrier future ages extend denominator mass using the carrier residual after the Cohort frontier. The possible future denominator pool is `a_pop - x_frozen`.
- Pop D is the frontier survivor pool already at X but not at the subject end. In active carrier mode, Pop D is mixed over the per-particle pre-frontier carrier arrival distribution, so early and late arrivals to X get different subject-clock exposure.
- Pop C is future arrivals at X after the frontier. It uses conditional post-frontier carrier increments convolved with the unshifted subject progression surface; a Pop C member's subject clock starts when that member reaches X.

The reducer accumulates total `X_total` and `Y_total` across selected Cohorts and divides once at the end. Rate cells with zero denominator are `NaN`, not zero; row quantiles ignore validly undefined particles and return `None` only when every particle is undefined at that age.

This mass-first reduction is what feeds E+F mode's evidence layer and the FC continuation that feeds its forecast layer. `project_selected_cohort_rows` is the single canonical entry point: the strict evidence surfaces and the F-mode conditioned surface (`f_rate_draws`) come from the same reducer. Only the optional model overlay is sourced separately, from `runtime.unconditioned_overlays['epistemic']`.

## 7. Row Projection

`_project_runtime_rows` projects four distinct public surfaces from the runtime. Terminology follows the frontier-conditioned chart-surface proposal, [Appendix B](../project-generalise/frontier-conditioned-chart-surface-proposal-21-May-26.md#appendix-b-standard-terminology-and-display-mapping) — display modes and internal surfaces are named separately. See also [CF_ROW_PIPELINE.md §5](CF_ROW_PIPELINE.md#5-row-schema--three-projection-surfaces) for the row-schema table and [§6.1](CF_ROW_PIPELINE.md#61-display-mode-epoch-mapping) for the epoch mapping.

| Row surface | Source |
|---|---|
| `midpoint`, `fan_*`, `fan_bands`, `projected_rate` | The FC (frontier-conditioned) continuation surface `selected_projection.ef_rate_draws` from the spine. Forecast layer in E+F mode. |
| `forecast_x`, `forecast_y` | `selected_projection.ef_forecast_x` / `ef_forecast_y` — future residual emitted directly by the FC continuation DP. Active-carrier only. |
| `model_midpoint`, `model_fan_*`, `model_bands` | The unspliced query-conditioned model surface `selected_projection.f_rate_draws` from the spine, epistemic operator basis. F mode renders this surface. |
| `model_curve_midpoint`, `model_curve_*`, `model_curve_bands` | The optional model overlay — unconditioned model curve with epistemic bands. Sourced from `runtime.unconditioned_overlays['epistemic']`. Not a display mode; opt-in via `show_model_curve`. |

Observed evidence fields are separate from projection fields:

- Both identity-carrier and active rows read the strict empirical surfaces (`rate_strict`, `evidence_*_strict`) emitted by `project_selected_cohort_rows`; there is no separate evidence object and no `aggregate_by_tau`. Callers do not pass an alternate evidence map, and no path aggregates `engine_cohorts.obs_x/obs_y` for v3 evidence-named row fields.
- When the strict empirical surfaces have no admissible cells, evidence-named row fields are absent (None) rather than reconstructed from the frame substrate — invariant 12.
- Model projection never fills evidence-named fields.

Epoch gating is output-layer policy, not data scarcity: the spine generates `ef_*` across the full tau sweep with strict-evidence prefix-pinning. The FE chart layer suppresses the E+F forecast layer in epoch A (where it would coincide with the solid E line and double-draw) and the E mode evidence layer in epoch C (where there are no observations). See [CF_ROW_PIPELINE.md §6.1](CF_ROW_PIPELINE.md#61-display-mode-epoch-mapping) for the full table.

Scalar completeness is not a row field. The scalar reducer computes completeness from the same request-rooted runtime surfaces with its own frontier/saturation calculation scope. Cohort-maturity rows remain chart projections; scalar saturation/frontier outputs such as `p@∞` and `completeness@frontier` are emitted by scalar consumers (`conditioned_forecast`, `param-pack`, direct scalar reducer tests), not by `_project_runtime_rows`.

## 8. Public Scalars and Provenance

`ResolvedCFRuntime.project_public_moments` lets primitive-backed moments win and only falls back to caller-supplied legacy values when a primitive moment is absent. The current v3 row path passes no legacy moments, so absent primitive moments remain absent.

`ResolvedCFRuntime.project_runtime_provenance` builds the public provenance block from stable runtime fields:

- `carrier_span`
- `subject_span`
- `numerator_representation`
- `admission_policy`
- primitive registry summary and conditioned primitive count
- projection substitution summary
- diagnostic details for forensics

Consumers should not infer carrier, subject, or projection roles by scraping lower-level diagnostic labels. Role-labelled runtime fields are the public contract.

## 9. Caching and Identity

Four cache families sit underneath the runtime:

| Cache | Wraps | Identity |
|---|---|---|
| Primitive posterior | `condition_primitive` | `DrawFamilyKey` over transition, role, prior identity, evidence identity, scope, and algorithm parameters. |
| Composed carrier | Carrier-side `compose_primitive_span` | Carrier primitive identities and carrier arrival-map identity. |
| Composed subject | Subject-side `compose_primitive_span` | Subject primitive identities and subject arrival-map identity. |
| Prefix arrival map | `build_prefix_arrival_map` | `PrefixArrivalIdentity` for the request root and scope-bearing parameter fingerprint. |

Caller-context labels such as `scenario_id` and `scenario_seed` are not mathematical identity by themselves. They must not enter cache keys unless they change priors or evidence through a real scoped field. Side-channel leakage through fields such as `edge_id` still changes identity because those fields are forwarded into canonical strings.

Invalidation remains coarse-grained through `result_cache.clear_all()`. Scope-bearing keys plus TTL are the live invariant; per-key invalidation is still a follow-up.

**Memory lifetime (per-request flush).** The composed-carrier, composed-subject, and primitive-posterior caches are registered `request_scoped=True` (`result_cache.make_cache`). Both request entry points — `handle_runner_analyze` (cohort maturity, daily conversions, snapshot subjects, surprise gauge) and `handle_conditioned_forecast` — call `result_cache.clear_request_scoped()` in a `finally`, so these draw-scaled caches are flushed at the end of every request. This is load-bearing for memory: their keys embed per-request identity (the composed-span key uses primitive `id()`; the primitive key carries per-request evidence identity), so they never hit across requests, while their values are GB-scale `(C·S·T)` arrays. Without the flush a warm worker accumulated ~one request's working set per request (count-only eviction does not fire until 512/1024 entries — gigabytes), OOMing a 2 GB Vercel instance within a couple of requests. The flush bounds resident memory to a single request's working set; within-request reuse and draw-family coherence (the keyed-RNG contract, I-48 / CF_PRIMITIVE_SUBSTRATE §3.3) are unaffected because clearing happens only after the request completes, and a recomputed primitive is bit-identical via `make_rng`. The snapshot DB cache is **not** request-scoped — it is genuinely cross-request and is invalidated on writes via `clear_all()`.

## 10. Handler Boundary

The cohort maturity analysis endpoint and the conditioned forecast endpoint both call the same v3 machinery. Cross-surface parity comes from shared runtime objects, shared primitive preparation, the shared `prepare_cf_projection_bundle` boundary, and shared selected-Cohort reduction (the empirical-evidence operator owns strict observed evidence; there is no separate selected-A-clock construction step).

The fetch-envelope plan that feeds subject and carrier observations is built at the preparation layer in `forecast_preparation.prepare_forecast_subject_group` and applied before runtime construction. Prepared per-edge entries expose those rows as `evidence_superset_rows`. The runtime no longer performs in-runtime DB widening, and `forecast_runtime.prepare_forecast_runtime_inputs` no longer constructs target-edge evidence or request-level evidence sets. See [`snapshot-fetch-envelope-design.md`](../snapshot-fetch-envelope-design.md) and [`FORECAST_PREPARATION.md`](FORECAST_PREPARATION.md) §5.

**Legacy inline fallback.** `build_resolved_cf_runtime` ([`cohort_forecast_v3.py`](../../graph-editor/lib/runner/cohort_forecast_v3.py#L542)) constructs the envelope plan inline (the `if envelope_plan is None:` fallback that calls `build_request_envelope_plan`) when the caller does not supply one, so legacy and test entry points still work in active mode. Production requests always route through the preparation layer; the inline path is a fallback, not a parallel path, and is tracked as case-fork debt in [`cf-defensive-findings.md`](../project-generalise/cf-defensive-findings.md). The two construction sites must remain semantically identical.

## 11. What Lives Where

The file → role lookup across the full CF cluster lives in [`CF_MAP.md`](CF_MAP.md) §3 — preparation modules, substrate modules, the row pipeline functions inside `cohort_forecast_v3.py`, and the hold-out engines, all in one table. This section used to duplicate the substrate + row-pipeline slice of that table; it now defers.

## 12. Things That Are Not Here

- The L1/L1.5/L2/L3 persistence boundary is owned by [`FORECAST_STACK_DATA_FLOW.md`](FORECAST_STACK_DATA_FLOW.md).
- Snapshot retrieval and request-envelope construction are owned by [`snapshot-fetch-envelope-design.md`](../snapshot-fetch-envelope-design.md).
- Semantic proofs are owned by [`COHORT_ANALYSIS_NUMERATOR_DENOMINATOR_SEMANTICS.md`](COHORT_ANALYSIS_NUMERATOR_DENOMINATOR_SEMANTICS.md).
- The old closed-form non-latency row route is gone. Non-latency terminal edges degenerate through the same runtime and row projection.
- The old flag-gated primitive-readout rollout is historical. The live v3 row path uses the primitive-backed runtime by default.
- Per-Cohort hierarchical posterior conditioning is future work. The current selected-Cohort reducer changes the projection object; it reuses the runtime's current shared draw family.

## Appendix A. Semantic Pseudo-Code Companion

The stage-by-stage semantic pseudo-code for this runtime lives in [`FORECAST_RUNTIME_SEMANTIC_PSEUDOCODE.md`](FORECAST_RUNTIME_SEMANTIC_PSEUDOCODE.md). It is kept separate from this architecture reference so the runtime overview stays compact while the pseudo-code can be reviewed independently.

## See Also

- [`COHORT_ANALYSIS_NUMERATOR_DENOMINATOR_SEMANTICS.md`](COHORT_ANALYSIS_NUMERATOR_DENOMINATOR_SEMANTICS.md) — semantic source of truth for carrier, subject, Pop C, Pop D, and identity degeneracies.
- [`FORECAST_STACK_DATA_FLOW.md`](FORECAST_STACK_DATA_FLOW.md) — I/O contracts and persistence boundaries.
- [`CF_PRIMITIVE_SUBSTRATE.md`](CF_PRIMITIVE_SUBSTRATE.md) — the five-layer substrate that produces `ResolvedCFRuntime`; load-bearing invariants (I-47, I-48); the right read before opening `primitives.py` / `primitive_evidence.py` / `primitive_conditioning.py` / `subject_span_composer.py` / `primitive_readout.py`.
- [`CF_ROW_PIPELINE.md`](CF_ROW_PIPELINE.md) — the chart engine that consumes the runtime: dual-prefix objects, the seam invariant, the selected-cohort reducer, the row schema, the epoch model.
- [`cf-defensive-findings.md`](../project-generalise/cf-defensive-findings.md) — executive summary of the 21-finding defensive-code audit ([`cf-defensive-coding-audit.md`](../project-generalise/cf-defensive-coding-audit.md)); cross-link for the engine's known unfinished work (H-1 monotone-repair clamp, H-4 forecast residual clamp, H-5 identity-carrier branching, M-1 try/except swallows in `cohort_forecast_v3.py`).
- [`CF_HOLD_OUT_ENGINES.md`](CF_HOLD_OUT_ENGINES.md) — `funnel_engine` / `daily_conversions_derivation` / `cohort_maturity_derivation` parallel paths; legacy trajectory engine status.
- [`CF_RESIDUAL_GUARD.md`](CF_RESIDUAL_GUARD.md) — edge requirement classification (`primitive_residual_guard.py`).
- [`DRAW_FAMILY_KEYING.md`](DRAW_FAMILY_KEYING.md) — keyed-RNG seam (`DrawFamilyKey`, `make_rng`, the 13 derivations).
- [`CF_REFACTOR_TRACKERS.md`](CF_REFACTOR_TRACKERS.md) — index of the in-flight design-doc trackers under `docs/current/` that CF code cites by `§A.*`-style references.
- [`snapshot-fetch-envelope-design.md`](../snapshot-fetch-envelope-design.md) — evidence acquisition envelope.
- [`../cohort-maturity-selected-cohort-projection-pattern.md`](../cohort-maturity-selected-cohort-projection-pattern.md) — design lineage for the mass-first selected-Cohort reducer and active-carrier projection.
- [`../cohort-maturity-mc-wrong-object-problem-statement.md`](../cohort-maturity-mc-wrong-object-problem-statement.md) — problem statement that motivated replacing request-level rate projection for E+F rows.
