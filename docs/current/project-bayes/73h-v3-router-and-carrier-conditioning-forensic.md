# 73h — v3 router and carrier-conditioning forensic note

**Status**: forensic note, problem statement only — no fix plan
**Date opened**: 30-Apr-26
**Parent contracts**: [`73g-general-purpose-f14-problem-and-invariants.md`](73g-general-purpose-f14-problem-and-invariants.md), [`docs/current/codebase/COHORT_ANALYSIS_NUMERATOR_DENOMINATOR_SEMANTICS.md`](../codebase/COHORT_ANALYSIS_NUMERATOR_DENOMINATOR_SEMANTICS.md)

## Purpose

This note records two architectural issues surfaced while diagnosing the cohort_maturity v3 chart on `gm-rebuild-jan-26`. Each is a candidate violation of the 73g contract — specifically invariant 1 ("there is one general forecast machinery path") and invariant 6 ("evidence binding must match the object it conditions"). The note traces each through the live code with concrete call sites.

This is not an implementation plan. It is a problem statement intended to make the violations precise so any later fix addresses the right surface.

Two related defects from the same investigation (a source-routing defect in `read_edge_cohort_params`, and a persistence skip-on-undefined pattern in `UpdateManager.applyBatchLAGValues`) are being addressed in separate workstreams and are out of scope for this note. They affect persistence and routing of derived scalars rather than the runtime-object architecture at issue here.

## Required context

- [`73g-general-purpose-f14-problem-and-invariants.md`](73g-general-purpose-f14-problem-and-invariants.md) — invariant statement.
- [`docs/current/codebase/COHORT_ANALYSIS_NUMERATOR_DENOMINATOR_SEMANTICS.md`](../codebase/COHORT_ANALYSIS_NUMERATOR_DENOMINATOR_SEMANTICS.md) — `carrier_to_x` / `subject_span` semantic split.
- [`docs/current/codebase/BE_RUNNER_CLUSTER.md`](../codebase/BE_RUNNER_CLUSTER.md) — surface map.
- [`docs/current/codebase/STATS_SUBSYSTEMS.md`](../codebase/STATS_SUBSYSTEMS.md) — subsystem boundary, dispatcher contract.

## Single-hop vs multi-hop: composition is unified, evidence-role routing forks

Forensic check shows the composition machinery is unified across single-hop and multi-hop. The rate-conditioning evidence-role assignment forks intentionally per the WP8 design (semantics doc § "Runtime-bundle conditioning seam").

**Unified surfaces:**

- `cohort_forecast_v3.py:922, 982` — `is_multi_hop` is forwarded to `build_prepared_runtime_bundle` as a parameter. No code-path branch in `compute_cohort_maturity_rows_v3` itself.
- `forecast_runtime.py:191, 266` — accepted as a parameter and stored on `PreparedSubjectSpan` as a metadata flag.
- `forecast_runtime.py:1812-1824` — `build_prepared_span_execution(query_from_node, query_to_node)` and `compose_span_kernel(topo, edge_params, max_tau=400)` are invoked uniformly for both. Single-hop is the single-edge degenerate case of the same kernel.
- `forecast_state.py` — `compute_forecast_trajectory` (line 866) has no `is_multi_hop` parameter; grep confirms no `is_multi_hop` reads anywhere in the file.
- `forecast_runtime.py:430` — a syntactic conditional on `is_multi_hop`, but inside a return dict picking between two diagnostic-string values for the `decision_reason` key. Diagnostic-only.

**The intentional fork:**

- `forecast_runtime.py:1633-1641` — inside `_resolve_evidence_role`, a real code-path branch:
  ```
  if (
      direct_cohort_enabled
      and not is_window
      and not is_multi_hop
      and anchor_node_id
      and query_from_node
      and anchor_node_id != query_from_node
  ):
      return EvidenceRole.DIRECT_COHORT_EXACT_SUBJECT
  return EvidenceRole.WINDOW_SUBJECT_HELPER
  ```
  Single-hop cohort with `direct_cohort_enabled` gets `DIRECT_COHORT_EXACT_SUBJECT`; multi-hop cohort (or window, or A=X) gets `WINDOW_SUBJECT_HELPER`. The two roles drive different evidence-merge contracts downstream.

The semantics doc § "Runtime-bundle conditioning seam" documents this as intentional: WP8's `direct_cohort_enabled` is "intentionally narrow" — exact single-hop `cohort()` only. Multi-hop cohort is excluded by design from the direct-cohort rate-conditioning seam.

So the contract is: **composition machinery is unified; rate-conditioning evidence role is a documented narrow fork on `is_multi_hop`**. Both behaviours are intended.

## Issue 1 — Top-level latency / non-latency router in v3

### What it is

`compute_cohort_maturity_rows_v3` branches on `target_edge.p.latency.latency_parameter` at `cohort_forecast_v3.py:1071-1110`, producing two architecturally distinct code paths that converge only at metadata-attachment.

### Trace

`cohort_forecast_v3.py:1071-1072`:

```
_lat_meta = (target_edge.get('p') or {}).get('latency') or {}
_is_latency_edge = _lat_meta.get('latency_parameter') is True
```

`cohort_forecast_v3.py:1073-1110` (paraphrased):

```
if not _is_latency_edge:
    fe = build_cohort_evidence_from_frames(...)
    result = _non_latency_rows(fe, resolved, ...)   # closed-form Beta-Binomial
    return _attach_cf_row_metadata(result.rows, ...)

# else: latency path
... (eventually calls compute_forecast_trajectory)
```

The False branch dispatches to `_non_latency_rows` (`cohort_forecast_v3.py:69` onwards):

- Aggregates evidence as `Σk, Σn` across cohorts (lines 109-135).
- Conjugate Beta-Binomial update: `α' = α + Σy`, `β' = β + (Σx − Σy)` (lines 147-148).
- Doc-52 `(1−r):r` blend between updated and unblended posterior (lines 150-184).
- Builds rows directly from `scipy.stats.beta.ppf(quantiles, α', β')` (line 230 onwards). No MC, no IS, no `compute_forecast_trajectory` call.

The True branch dispatches to `compute_forecast_trajectory` (`forecast_state.py:866`):

- Per-sample `(p, μ, σ, onset)` draws.
- Per-draw completeness CDFs via `_compute_completeness_at_age`.
- Aggregate tempered IS reweight against observed cohort `(n, k, τ)` evidence (lines 1095-1199; binomial likelihood at line 1166: `k_i × log(p) + E_fail × log(1−p)`).
- Returns `rate_draws` shape `(S, T)`.

The output shapes differ. False branch returns Beta-quantile rows directly; True branch returns MC draw arrays. The convergence point at `_attach_cf_row_metadata` (line 1098) only attaches provenance — it does not reconcile the underlying objects.

### Why this is a 73g invariant 1 candidate violation

73g invariant 1: "There is one general forecast machinery path. ... Cases may differ only by natural degeneration of the same objects."

The router produces two parallel logics — latency-bearing vs structurally non-latency edge — that 73g says should differ only by natural degeneration. The natural degeneration would be: feed a non-latency edge through the same MC machinery; its composed kernel σ_eff = 0 yields a step CDF (completeness = 1.0 from τ = 0+); the IS reweight reduces analytically to the conjugate Beta-Binomial answer in that limit. One path with different inputs, not two paths.

The math substrate already supports this:

- `_edge_sub_probability_density` (`span_kernel.py:83-128`) explicitly handles `σ ≤ 0` → delta at τ=0 (lines 108-113), routing into convolution as identity.
- `_run_dp` (`span_kernel.py:280`) propagates deltas correctly via `np.convolve`.
- `mc_span_cdfs` (`span_kernel.py:312`) preserves σ=0 structurally per draw at lines 386-393: `_latency_mask = means_arr[None, :, 2] > 0` clips non-latency edges to σ=0.
- `compose_span_kernel` (`span_kernel.py:291`) is transparent — no σ-touching branches.

Composition through a non-latency edge already does the right thing. The router pre-empts that machinery before it has a chance to produce the degenerate answer.

**However, the orchestration layer above the math substrate has a second σ ≤ 0 gate that any fix to the v3 router must also address.** `compute_forecast_trajectory` (`forecast_state.py:866`) hard-returns all-zeros at lines 979-981:

```
if lat.sigma <= 0:
    empty = np.zeros((S, T))
    return ForecastTrajectory(rate_draws=empty, model_rate_draws=empty)
```

`lat = resolved.latency` (line 954) is the target-edge latency. For a non-latency terminal edge, `resolved.latency.sigma = 0` and the early return fires before the composed kernel from `mc_cdf_arr` (consumed at line 1003) is ever used. Retiring the v3 router without also addressing this second gate would still fail the canaries: dispatch would reach `compute_forecast_trajectory`, the early return would fire, and the trajectory would be all-zeros rather than the σ_eff = 0 limit of the composed kernel. The correct end state is for this gate to either be removed or to depend on the composed kernel rather than the target-edge latency only.

### Practical consequence

Two functions own "the cohort_maturity row for this query": `_non_latency_rows` and `compute_forecast_trajectory`. They diverge in:

- Evidence binding mechanism (closed-form Beta-Binomial conjugate update at `_non_latency_rows:147-148` vs aggregate tempered IS reweight at `compute_forecast_trajectory:1095-1199`).
- Doc-52 blend implementation: moment-level Beta blend in `_non_latency_rows:150-184` vs row-level draw-permutation blend in `compute_forecast_trajectory:1389+` (verified via `_compute_blend_params` and `_make_blend_permutation`). Same conceptual operation, two implementations that can drift.
- Output shape (Beta-quantile rows directly vs MC draw arrays).
- Future enhancements (e.g., epistemic vs predictive band reconstruction) need implementation twice or risk drift.

This is the cost of parallel logic that 73g invariant 1 is intended to prevent.

### Multi-hop boundary

The router checks `target_edge.p.latency.latency_parameter` (line 1071-1072). The `target_edge` resolves from `target_edge_id`, which the live cohort_maturity v3 caller supplies as `last_edge_id` (the terminal edge of the path — verified at `api_handlers.py:1691`, the cohort_maturity v3 dispatch site). For a multi-hop subject `X → M → Z` where `M → Z` is non-latency and `X → M` is latency, the terminal edge is non-latency and the router dispatches to `_non_latency_rows`. The upstream span machinery (`prepare_forecast_runtime_inputs` called at `api_handlers.py:1625`) still composes the kernel over the full subject span, but the non-latency branch consumes only the closed-form Beta result on the terminal edge — the kernel composition is computed and discarded. Adjacent multi-hop queries route through different machinery depending on which edge is terminal.

## Issue 2 — Carrier and subject sit on different evidence-conditioning machineries

### What it is

The forecast pipeline applies importance-sampling reweighting against observed evidence to the SUBJECT side (`compute_forecast_trajectory`), but not to the CARRIER side. The carrier is conditioned on observed evidence by an entirely different mechanism — the dispatcher's Tier 1/2/3 selection — which is not the same machinery as the subject's IS reweight.

### Trace

Subject-side IS reweight, `forecast_state.py:1095-1199`:

- Per-draw log-likelihood is the binomial likelihood over each cohort: `Σ_i [ k_i × log(p) + (E_eff_i − k_i) × log(1−p) ]`, where `E_i,s = n_i × CDF_s(τ_i; μ_s, σ_s, onset_s)` per draw `s` (likelihood evaluated at line 1166, `E_eff` constructed at line 1158).
- Tempered ESS-targeted bisection at lines 1172-1185.
- Resampling against tempered weights at lines 1187-1199.
- The subject's `(p, μ, σ, onset)` per draw are reweighted; the resulting weighted draws are the conditioned posterior.

Carrier construction, `forecast_runtime.build_upstream_carrier:1495-1533`:

```
Tier 1 (parametric):  _build_tier1_parametric  (forecast_runtime.py:1237)
Tier 2 (empirical):   _build_tier2_empirical   (forecast_runtime.py:1334)
Tier 3 (weak prior):  _build_tier3_weak_prior  (forecast_runtime.py:1452)
```

The dispatcher tries Tier 1 first; on `None`, falls through. There is no IS-style reweighting of carrier draws against observed A→X evidence. The closest mechanism is Tier 2, which is a *shape construction* from observations rather than a reweighting of model-derived draws.

The explicit comment at `forecast_runtime.py:1268` confirms this:

```
# over-dispersion leaks into trajectory bands without any IS-side
# correction (no IS reweighting against carrier draws exists).
```

### Why this is a 73g invariant 1 candidate violation

`carrier_to_x` and `subject_span` are formally the same kind of object per `COHORT_ANALYSIS_NUMERATOR_DENOMINATOR_SEMANTICS.md` § "General abstraction points": both are CDFs over τ composed from per-edge resolved params, both should be conditioned on observed evidence in the same way.

In practice the carrier is conditioned via Tier 2 empirical-shape construction (when it fires), the subject via IS reweight. These are different mechanisms with different statistical contracts:

- Tier 2 builds a CDF directly from raw observed arrivals at X. It does not reweight a prior — it replaces the prior.
- IS reweighting modifies a prior posterior by an evidence likelihood. The prior is preserved as the proposal.

The two cannot be unified without either: (a) extending the IS machinery to also reweight carrier draws against observed A→X arrivals, or (b) replacing the subject IS with a Tier-2-style empirical construction. The system today does (a) for the subject and a non-(a) thing for the carrier.

### Why this is also a 73g invariant 6 candidate violation

73g invariant 6: "Evidence binding must match the object it conditions."

Subject-side IS reweight binds observed `(n, k, τ)` cohort evidence to the subject CDF. Carrier-side Tier 2 binds observed A→X arrivals to the carrier CDF. The bindings happen at different layers and produce different statistical objects. Whether they are jointly coherent — i.e., the evidence story for the subject is consistent with the carrier-conditioning story — is not guaranteed by construction.

### Practical consequence

The forecast object's posterior is the subject's IS-reweighted posterior conditional on whatever the carrier dispatcher happened to pick. Tier 1 wins → carrier is a parametric model with no observation conditioning. Tier 2 wins → carrier is empirical. The joint posterior shape changes discontinuously as the dispatcher tier flips.

## Cross-cutting note: math foundation supports unification, orchestration layer does not yet

The BE composition machinery (`span_kernel.py`) is already σ=0-robust and would compose non-latency edges as identity (δ at τ=0) without modification — the mathematical substrate for unifying the v3 router (Issue 1) and the carrier-side composition (Issue 2, composition half) is in place.

The orchestration layer above it is not yet aligned with that substrate. Specifically, `compute_forecast_trajectory` early-returns all-zeros when `lat.sigma <= 0` (`forecast_state.py:979-981`, detailed under Issue 1), so even with the composition substrate in place, the trajectory entry point pre-empts σ_eff = 0 degeneration before the composed kernel can flow through. What is missing is therefore:

- A unified IS reweight that operates over the carrier as well as the subject, OR a unified empirical-shape construction that operates on both.
- A retired top-level latency/non-latency router AND a relaxed (or removed) σ ≤ 0 gate in `compute_forecast_trajectory` that lets the σ_eff = 0 limit case emerge naturally from the composed kernel.

These are design decisions, not implementation details. They are why this note is a problem statement and not a fix plan.

## Canaries

Two red tests pin Issue 1 directly to a fixture and an assertion. Both live in [`graph-editor/lib/tests/test_cohort_factorised_outside_in.py`](../../graph-editor/lib/tests/test_cohort_factorised_outside_in.py):

- `test_multihop_with_terminal_non_latency_window_must_honour_upstream_subject_latency`
- `test_multihop_with_terminal_non_latency_cohort_must_honour_upstream_subject_latency`

Both run the cohort_maturity v3 row builder against `cf-fix-deep-mixed` (T7 in doc 50 §5.1: 6-hop chain alternating non-latent / latent — `A→B` off, `B→C` on, `C→D` off, `D→E` on, `E→F` off, `F→G` on). Subject `from(cf-fix-deep-d).to(cf-fix-deep-f)` has `D→E` latent and `E→F` non-latent terminal. The composed subject-span kernel `K_DE ⊗ δ(0) = K_DE` reflects the `D→E` lognormal CDF, so `model_midpoint` over τ must rise from low at small τ to saturate at high τ. The `_assert_not_flat` helper requires `rel_var ≥ 0.01` and the first row to be `≤ 0.30 × peak`.

Verified failure mode (30-Apr-26): both tests fail with `rel_var=0.00%`. The `model_midpoint` is exactly constant across τ, confirming the v3 router (`cohort_forecast_v3.py:1071-1110`) is dispatching to `_non_latency_rows` (which writes a τ-flat closed-form Beta) on the basis of the terminal edge `E→F`'s `latency_parameter=false` flag. The upstream subject-span composition (the `D→E` lognormal kernel) is computed by `prepare_forecast_runtime_inputs` but discarded.

These canaries should turn green when the router is retired and the σ_eff = 0 limit case is allowed to emerge naturally from `compute_forecast_trajectory` (the unification path described in the cross-cutting note above).

## Existing failures in the same test file

A full run of `tests/test_cohort_factorised_outside_in.py` on 30-Apr-26 (35 collected, before the canaries above were added) returned 6 failures and 1 xfail. The mapping below is grounded in code-trace, not speculation.

| Failing test | Verified mechanism | Resolved by 73h fixes? |
|---|---|---|
| `test_single_hop_non_latent_upstream_collapses_to_window[fast]` | Cohort obs_x at `cohort_forecast_v3.py:752` primes at 0 (window primes at `raw_n_i`); carries forward only when an observation lands at τ. Sparse observations make cohort obs_x strictly less than window. The factorised-carrier branch that would inject `obs_x = a_pop × reach` for a δ(0) carrier is gated off at `forecast_runtime.py:965` (`enabled = reach > 0 and has_semantic_upstream_latency(...)`). With non-latent upstream, `has_semantic_upstream_latency=False` → branch dead → divergence. Observed ratio ≈ 0.40 between cohort and window. | **Yes — by Issue 2.** Widening the `enabled` gate so the δ(0) carrier branch fires for non-latent A→X (cohort, A≠X, reach>0) is part of the carrier-subject unification this note describes. Note that the carrier construction surface is multi-site: `forecast_runtime.py:965` is one writer of the enabled flag, but `forecast_state.build_node_arrival_cache` (`forecast_state.py:363`) and the inline `XProvider(…enabled=_upstream_enabled…)` construction at `api_handlers.py:1380` build carriers on parallel paths. A correct fix has to widen all of them, or refactor onto a shared semantic. |
| `test_single_hop_non_latent_upstream_collapses_to_window[slow]` | Same mechanism. | **Yes — by Issue 2.** Same multi-site fix. |
| `test_cli_identity_collapse_matches_window_across_public_surfaces` | Cross-surface parity (param-pack vs cohort_maturity vs CF) on identity collapse. Two-site computation of completeness: FE `statisticalEnhancementService.ts:1301-1308` vs BE `forecast_state.py:1454-1470`. The two sites diverge on identity-collapse because their adjustments differ (FE may apply `applyAnchorAgeAdjustment`, BE does not). | **No — orthogonal.** This is 73g invariant 7 ("projection must not re-decide semantics"): two writers of the same conceptual quantity, distinct from Issues 1 and 2. Architectural fix: project completeness once. |
| `test_cli_projection_parity_uses_last_row_saturation_not_arbitrary_tau_curve_point` | Projection layer reading the wrong row at saturation; tolerance violated by ≈ 0.062 vs 1e-4 tolerance. Same two-site completeness divergence as above. | **No — orthogonal.** 73g invariant 7. Same architectural fix as above. |
| `test_cohort_frame_evidence_is_admitted_only_for_single_hop_anchor_override_case` | Single-hop anchor-override (b→c with anchor a, synth-lat4) should produce material carrier-driven completeness movement (≥ 0.02). Observed Δ = 0.011, half the threshold. The BE cdf_arr at `forecast_state.py:1047-1052` is built from edge-level `(μ, σ, onset)` only, with the explicit comment "Edge-level CDF only — no carrier convolution here." Path-level (μ, σ, onset) — which would carry the b→c upstream latency — is never read. | **Yes — by Issue 2.** Reading path-level `(path_mu, path_sigma, path_onset)` for cdf_arr when carrier is active is part of the carrier-subject unification. Localised fix at `forecast_state.py:1047-1052`. |
| `test_v3_midline_at_saturation_converges_to_p` (synth-mirror-4step) | Defect 1 (int(remaining) Pop D truncation) is **already fixed** at `forecast_state.py:745` (`Y_D = remaining * q_late`); the apparent `binomial(int(remaining), q_late)` at line 752 is a deliberate RNG-stream no-op (`_ = loop_rng.binomial(...)`, result discarded). Residual gap (midpoint 0.585 vs p_infinity 0.698, Δ = 0.113 vs tolerance 0.05) is Defect 2 — hierarchical level confusion at the rate-conditioning seam, named in `cohort-maturity-v3-midline-collapse-investigation.md`. | **Maybe — partially by Issue 2.** "Rate-conditioning seam" is the same surface 73h Issue 2 calls the carrier-vs-subject evidence-conditioning machinery split. Whether Issue 2's unification fixes Defect 2 in particular requires the instrumentation the investigation doc calls for. Not actionable from 73h alone. |

**Summary of expected-resolutions:**

- **Three of six failures (#1, #2, #5)** are direct surfaces of Issue 2's carrier-subject conditioning split. The fix surface for #1 / #2 is the carrier-construction enabled gate, which lives at multiple writers (`forecast_runtime.py:965`, `forecast_state.build_node_arrival_cache` at `forecast_state.py:363`, and the inline `XProvider(…)` at `api_handlers.py:1380`); widening must reach all of them, or refactor onto a shared semantic. The fix for #5 is more localised: the `cdf_arr` build at `forecast_state.py:1047-1052` (reading path-level params when carrier is active).
- **Two failures (#3, #4)** are 73g invariant 7 surface (projection re-deciding via two-site completeness computation). Orthogonal to 73h's Issues 1 and 2. Needs its own architectural decision.
- **One failure (#6)** is partially Issue 2 (Defect 2 = rate-conditioning seam) plus needs separate instrumentation per the investigation doc.
- The two new canaries added to this test file pin Issue 1 directly (terminal-edge router fork). They will turn green when Issue 1 is resolved by retiring the closed-form / MC-sweep top-level fork in favour of natural σ_eff = 0 degeneration.

## Open questions for the F14 forensic trace

If this note is folded into the 73g forensic trace requirement, the following should be recorded for each of the queries 73g names (`window(simple-a→simple-b, -90d)` and `cohort(simple-b→simple-c, 1-Mar-26:3-Mar-26).asat(3-Mar-26)`):

- Which v3 router branch is taken (latency / non-latency)?
- If non-latency, is the closed-form `_non_latency_rows` answer consistent with what the MC sweep would produce in the σ_eff=0 limit, or does the doc-52 blend produce a different number?
- Which carrier tier is selected, and does its CDF shape agree with the subject's IS-conditioned posterior?
- Does the projection layer (`p_infinity_mean`, chart rows, graph `p.mean`) read from the resolved object, or re-decide semantics?
