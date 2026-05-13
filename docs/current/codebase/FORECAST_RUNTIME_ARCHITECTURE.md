# Forecast Runtime Architecture

**Status**: Active reference, 6-May-26
**Scope**: the live `cohort_forecast_v3` runtime: `ResolvedCFRuntime`, primitive conditioning and composition, selected-Cohort reduction, selected A-clock evidence, row projection, and public scalar projection. Handler I/O, persistence, and response application remain owned by [`FORECAST_STACK_DATA_FLOW.md`](FORECAST_STACK_DATA_FLOW.md). Semantic authority remains [`COHORT_ANALYSIS_NUMERATOR_DENOMINATOR_SEMANTICS.md`](COHORT_ANALYSIS_NUMERATOR_DENOMINATOR_SEMANTICS.md).

This doc describes the current runtime after the primitive substrate, carrier/subject composition, selected-Cohort mass reducer, active-carrier projection, and selected A-clock evidence adapter work landed. Reading order for a new contributor: semantics doc first, this doc second, data-flow doc third.

> New to the CF cluster? Read [`CF_MAP.md`](CF_MAP.md) first for orientation and the canonical reading order across all CF docs.

---

## ⚠️ STOP — read this before editing the runtime

**Defensive coding inside the engine is dangerous and must be avoided** ([INVARIANTS.md](INVARIANTS.md) I-47). No `or 0.0`, no `np.clip`, no `try/except: pass`, no `if x is None: return`, no schema case-forks, no `max(0.0, residual)` clamps.

**Branching by case is the recurring failure mode** ([KNOWN_ANTI_PATTERNS.md](KNOWN_ANTI_PATTERNS.md) AP58). Modes differ by which sub-object **degenerates** — identity carrier is data, not a route; `window()` is `cohort()` with carrier-arrival = identity; non-latency is latency with `δ(0)`. If your edit reaches for `if mode == ...` near the centre, the factoring is wrong.

**This is actively policed.** The 21 findings in [CF_DEFENSIVE_FINDINGS.md](CF_DEFENSIVE_FINDINGS.md) are debt being retired — not precedent. New defensive patterns or new case-forks will be reverted. Where existing code looks like it sets a precedent for a fallback, you are looking at exactly the debt being tracked.

---

## 1. The Live Shape

An `[I10]` request enters either the cohort maturity analysis endpoint or the conditioned forecast endpoint. Both surfaces route through `compute_cohort_maturity_rows_v3` in `graph-editor/lib/runner/cohort_forecast_v3.py`; there is no separate row engine for CF scalars.

The live call order through `compute_cohort_maturity_rows_v3` interleaves the **primitive substrate stage** (the 5 layers in [CF_PRIMITIVE_SUBSTRATE.md](CF_PRIMITIVE_SUBSTRATE.md)) with the **row pipeline stage** (the 8 layers in [CF_ROW_PIPELINE.md](CF_ROW_PIPELINE.md)). Frame evidence (row layer 1) runs **before** substrate construction; substrate stage A runs once; the rest of the row pipeline (layers 2–8) runs **after** the substrate, reading the resolved runtime. See [CF_ROW_PIPELINE.md §1a](CF_ROW_PIPELINE.md#1a-data-flow-vs-call-order) for the explicit ordered diagram.

Single-pool evidence invariant: every consumer in the call chain reads evidence from one canonical pool — the flat `runtime.request_evidence_candidates` — derived from the public `evidence_candidates` argument and/or `per_edge_*_candidates` via `_aggregate_request_candidates`. There is no parameter-shape switch between production and test paths; see [CF_ROW_PIPELINE.md §1b](CF_ROW_PIPELINE.md#1b-single-pool-invariant-for-evidence).

The live flow is:

1. `build_cohort_evidence_from_frames` materialises the chart's selected Cohorts, identity-carrier observed prefixes, epoch boundaries, and completeness evaluation ages. For active `cohort(A, X -> end)` it deliberately zeroes the X-clock target-frame prefixes so local/window evidence cannot masquerade as selected A-clock row evidence.
2. `build_superset_candidates_by_edge` and `build_carrier_superset_candidates_by_edge` translate the evidence rows already returned by the preparation/envelope layer into typed candidates. They do not fetch, dedupe, merge, read `_bayes_evidence`, or choose between source families.
3. `build_resolved_cf_runtime` resolves the subject span `X -> end`, resolves the carrier span `A -> X` only when `A != X`, builds independent subject and carrier arrival maps, and calls `primitive_readout.compute_resolved_runtime_readout`.
4. `compute_resolved_runtime_readout` prepares every primitive through the single conditioning locus, composes `composed_subject`, optionally composes `composed_carrier`, builds unconditioned overlays, and returns role-labelled provenance.
5. `_aggregate_request_candidates` builds one request candidate pool from the superset-derived target, subject-span, and carrier candidates. Primitive-local binding later filters this pool by primitive identity and clock.
6. `_root_window_carrier_n_by_anchor_day` builds the per-anchor base mass (`n_by_anchor`) from the flat `runtime.request_evidence_candidates` pool — runs for both identity-carrier and active modes. The active-only step is the subsequent `ec.a_pop` overwrite at `cohort_forecast_v3.py:6155`, where the frame-bundle `a` is replaced by the candidate-derived count; window/identity-carrier mode preserves `a_pop` from the frame `a_frozen`. Frame-bundle `a` is not an admissible substitute for the candidate-derived count on the active path.
7. `_build_selected_source_day_mass` and `_build_carrier_only_denominator_prefix` attach the dual-prefix objects to the runtime (`selected_source_day_mass`, `selected_x_prefix`). Then `_build_selected_a_clock_evidence_from_runtime` builds `SelectedAClockEvidence` from primitive-bound observed rows plus the runtime clock surfaces. Carrier evidence is composed on the selected A-clock; subject evidence is placed using the join-conditioned carrier timing surface before numerator/denominator pairing. Post atom-3 stage 4, **this whole sequence is unified across identity-carrier and active modes** — both consume `SelectedAClockEvidence` for their per-cohort prefixes; there is no rescue branch reading `engine_cohort.obs_x/obs_y`. Residual structural debt: `_synthesize_identity_carrier_observed_surface` is still a parallel pipeline for the carrier observed surface under identity carrier ([CF_DEFENSIVE_FINDINGS.md](CF_DEFENSIVE_FINDINGS.md) H-5).
8. `_project_runtime_rows` emits rows. E+F midpoint and fan fields come from `_selected_cohort_group_rate_draws`, which reduces selected-Cohort numerator and denominator mass before division. Evidence-named fields (`evidence_x`, `evidence_y`, `rate`) read only from `SelectedAClockEvidence`. Model overlays come from `_composed_pair_per_tau_rate_draws`.
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
| `unconditioned_overlays` | Prior-only composed subject/carrier pairs keyed by dispersion basis, currently `predictive` for F mode and optional `epistemic` for model-curve bands. |
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

There are two identity checks in the runtime:

- The composition helpers treat `carrier is None` as identity. `_composed_pair_request_cdf_draws` returns the subject CDF directly, and `_composed_pair_per_tau_rate_draws` returns the subject numerator directly.
- The selected-Cohort reducer also treats `population_root == denominator_node` as identity, even if a stray carrier object exists. The semantic equality is authoritative for row reduction.

Active `cohort(A != X)` requires a real composed carrier for selected-Cohort projection. If carrier composition is unavailable, the runtime should degrade rather than silently fall back to window semantics.

## 5. Evidence Materialisation

`build_cohort_evidence_from_frames` is a display-evidence materialiser, not a carrier builder and not a scalar authority. It builds `engine_cohorts` (with `a_pop`, `frontier_age`, epoch boundaries, and — for window mode — `obs_x`/`obs_y` arrays) and the per-Cohort `cohort_list`.

Post atom-3 stage 4 (May 2026), `_project_runtime_rows` no longer reads `obs_x` / `obs_y` directly off `engine_cohorts` for evidence-named row fields. **Both identity-carrier and active modes read row evidence from `SelectedAClockEvidence`.** The frame-derived `obs_x/obs_y` arrays survive on `engine_cohorts` for non-v3 legacy consumers (notably `compute_forecast_trajectory` callers — daily-conversions annotation, surprise-gauge-style legacy paths) but are not consumed by the v3 row builder.

The unified evidence path:

- `SelectedAClockEvidence` carries the selected A-clock observations. It keeps denominator `x_at_query_x` and numerator `y_at_subject_end` paired on the same A-clock row. It is built by `_build_selected_a_clock_evidence_from_runtime` from `ConditionedTransitionPrimitive.weighted_evidence`, topology composition, and (for active mode) the join-conditioned carrier timing surface. In identity-carrier mode the X-day → A-day mapping is identity, so the join-conditioned backmap is replaced by direct `root_day_shares` reads.
- `_root_window_carrier_n_by_anchor_day` supplies the per-anchor base mass `n_by_anchor` from root-window `n` on the carrier-side first edge (active) or on the X-rooted subject primitive (identity carrier — A == X so the "first carrier edge" is degenerate). It reads `runtime.request_evidence_candidates` directly — the canonical single-pool evidence source. It filters by semantic window-family identity rather than source family, and records per-anchor provenance.
- In **active mode**, `n_by_anchor` overwrites each cohort's `a_pop`; frame-bundle `a` is not an admissible substitute. In **window/identity-carrier mode**, `a_pop` is preserved from the frame's `a_frozen` (the candidate-derived `n_by_anchor` drives the prefix construction but not the per-cohort scalar).

If `SelectedAClockEvidence` cannot be resolved (no admissible candidates), evidence-named row fields are absent rather than reconstructed from a different substrate. The projected E+F fan and midpoint still come from the runtime's composed carrier and subject surfaces, but the per-particle reducer degrades to zero-prefix-from-prior — visible degradation, not silent rescue ([COHORT_ANALYSIS_NUMERATOR_DENOMINATOR_SEMANTICS.md](COHORT_ANALYSIS_NUMERATOR_DENOMINATOR_SEMANTICS.md) invariant 12).

**Structural debt status** (May 2026): the previous `_synthesize_identity_carrier_observed_surface` parallel pipeline has been folded into `_build_observed_span_evidence_surface` as a zero-edge degeneracy via `_build_zero_edge_observed_surface`. The unified function now dispatches internally on `root_node == end_node`. A finer architectural question — whether the n-weighted (zero-edge) and k-weighted (chain max-flow) readings can be unified under one formula — remains open; the two readings diverge under chain-side coverage gaps. See [CF_ROW_PIPELINE.md §1](CF_ROW_PIPELINE.md) "Known structural debt" for the framing. The reducer's ~10 `if identity_carrier:` branches (Pop D / Pop C arithmetic) are the remaining H-5 audit items.

Subject-side selected evidence is not placed by exact calendar age alone and is not placed by reading an upstream model-vars latency map. `_join_conditioned_carrier_backmap` maps subject-rooted observed rows back onto selected A-days using the composed carrier's join-conditioned CDF surface. Rows without primitive root-day shares or a valid join-conditioned carrier placement remain off-clock rather than falling back to a calendar shortcut.

## 6. Selected-Cohort Reduction

`_selected_cohort_group_rate_draws` is the E+F trajectory authority. It is a reduction over selected Cohorts and runtime particles, not a primitive conditioner and not a public scalar source.

For each selected Cohort, each particle, and each row age:

- Observed prefix ages contribute deterministic `X` and `Y` mass, identical for every particle.
- Identity-carrier future ages hold denominator mass fixed at `x_frozen`; Pop C is empty.
- Active-carrier future ages extend denominator mass using the carrier residual after the Cohort frontier. The possible future denominator pool is `a_pop - x_frozen`.
- Pop D is the frontier survivor pool already at X but not at the subject end. In active carrier mode, Pop D is mixed over the per-particle pre-frontier carrier arrival distribution, so early and late arrivals to X get different subject-clock exposure.
- Pop C is future arrivals at X after the frontier. It uses conditional post-frontier carrier increments convolved with the unshifted subject progression surface; a Pop C member's subject clock starts when that member reaches X.

The reducer accumulates total `X_total` and `Y_total` across selected Cohorts and divides once at the end. Rate cells with zero denominator are `NaN`, not zero; row quantiles ignore validly undefined particles and return `None` only when every particle is undefined at that age.

This mass-first reduction is why E+F rows now represent the chart object: selected-Cohort group `ΣY / ΣX`. `_composed_pair_per_tau_rate_draws` remains valid, but only for model-curve and F-mode objects where the user is asking for the primitive/span model surface.

## 7. Row Projection

`_project_runtime_rows` projects four distinct public surfaces from the runtime:

| Row surface | Source |
|---|---|
| `midpoint`, `fan_*`, `fan_bands`, `projected_rate` | The selected-Cohort mass reducer's rate draws. |
| `forecast_x`, `forecast_y` | The selected-Cohort reducer's projected denominator and numerator means, currently emitted only for active carrier rows. |
| `model_midpoint`, `model_fan_*`, `model_bands` | The unconditioned `predictive` overlay through `_composed_pair_per_tau_rate_draws`. |
| `model_curve_midpoint`, `model_curve_*`, `model_curve_bands` | The optional unconditioned `epistemic` overlay through the same helper. |

Observed evidence fields are separate from projection fields:

- Both identity-carrier and active rows read `SelectedAClockEvidence.aggregate_by_tau` when admissible observations are supplied. `_project_runtime_rows` derives the per-τ evidence buckets internally from that object; callers do not pass an alternate evidence map. Post atom-3 stage 4, there is no path that aggregates `engine_cohorts.obs_x/obs_y` for v3 evidence-named row fields.
- When `SelectedAClockEvidence` is absent or has no cells, evidence-named row fields are absent (None) rather than reconstructed from the frame substrate — invariant 12.
- Model projection never fills evidence-named fields.

Epoch gating: rows clear E+F midpoint/fan before `tau_solid_max` when the observed line owns the fully observed epoch. The active-mode path can render midpoint/fan across the full row range because selected A-clock observations may be absent while the carrier/subject projection is still meaningful.

Completeness is projected by `_runtime_completeness` from the same request-rooted composed CDF used by the runtime. Cohort weights come from `cohort_weights` (active: from `a_pop`; identity-carrier: from `evidence_n`/`x_frozen`). Selected A-clock frontier ages drive the eval point when exact selected prefixes exist.

Public scalar row fields `p_infinity_mean`, `p_infinity_sd`, and `p_infinity_sd_epistemic` come from `ResolvedCFRuntime.public_moments`. They are scalar subject-span moments, not a promise that the selected-Cohort group trajectory converges numerically to the final row midpoint.

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

## 10. Handler Boundary

The cohort maturity analysis endpoint and the conditioned forecast endpoint both call the same v3 machinery. Cross-surface parity comes from shared runtime objects, shared primitive preparation, shared selected-Cohort reduction, selected A-clock evidence construction, and shared row projection.

The fetch-envelope plan that feeds subject and carrier observations is built at the preparation layer in `forecast_preparation.prepare_forecast_subject_group` and applied before runtime construction. Prepared per-edge entries expose those rows as `evidence_superset_rows`. The runtime no longer performs in-runtime DB widening, and `forecast_runtime.prepare_forecast_runtime_inputs` no longer constructs target-edge evidence or request-level evidence sets. See [`snapshot-fetch-envelope-design.md`](../snapshot-fetch-envelope-design.md) and [`FORECAST_PREPARATION.md`](FORECAST_PREPARATION.md) §5.

**Legacy inline fallback.** `build_resolved_cf_runtime` ([`cohort_forecast_v3.py:1353-1376`](../../graph-editor/lib/runner/cohort_forecast_v3.py#L1353-L1376)) constructs the envelope plan inline when the caller does not supply one, so legacy and test entry points still work in active mode. Production requests always route through the preparation layer; the inline path is a fallback, not a parallel path, and is tracked as case-fork debt in [`CF_DEFENSIVE_FINDINGS.md`](CF_DEFENSIVE_FINDINGS.md). The two construction sites must remain semantically identical.

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
- [`CF_DEFENSIVE_FINDINGS.md`](CF_DEFENSIVE_FINDINGS.md) — executive summary of the 21-finding defensive-code audit (`docs/current/cf-defensive-coding-audit.md`); cross-link for the engine's known unfinished work (H-1 monotone-repair clamp, H-4 forecast residual clamp, H-5 identity-carrier branching, M-1 try/except swallows in `cohort_forecast_v3.py`).
- [`CF_HOLD_OUT_ENGINES.md`](CF_HOLD_OUT_ENGINES.md) — `funnel_engine` / `daily_conversions_derivation` / `cohort_maturity_derivation` parallel paths; legacy trajectory engine status.
- [`CF_RESIDUAL_GUARD.md`](CF_RESIDUAL_GUARD.md) — edge requirement classification (`primitive_residual_guard.py`).
- [`DRAW_FAMILY_KEYING.md`](DRAW_FAMILY_KEYING.md) — keyed-RNG seam (`DrawFamilyKey`, `make_rng`, the 13 derivations).
- [`CF_REFACTOR_TRACKERS.md`](CF_REFACTOR_TRACKERS.md) — index of the in-flight design-doc trackers under `docs/current/` that CF code cites by `§A.*`-style references.
- [`snapshot-fetch-envelope-design.md`](../snapshot-fetch-envelope-design.md) — evidence acquisition envelope.
- [`../cohort-maturity-selected-cohort-projection-pattern.md`](../cohort-maturity-selected-cohort-projection-pattern.md) — design lineage for the mass-first selected-Cohort reducer and active-carrier projection.
- [`../cohort-maturity-mc-wrong-object-problem-statement.md`](../cohort-maturity-mc-wrong-object-problem-statement.md) — problem statement that motivated replacing request-level rate projection for E+F rows.
