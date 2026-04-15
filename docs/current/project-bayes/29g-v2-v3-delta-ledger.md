# v2 vs v3 Delta Ledger

**Created**: 15-Apr-26
**Context**: Phase 5 parity exercise. This ledger records implementation choices in v2 that were discovered during v3 generalisation and that merit subsequent review. These are NOT v3 bugs — they are places where v2 makes a specific choice that may or may not be optimal.

---

## D1: IS conditioning has no ESS guard

**v2 behaviour**: Resamples unconditionally after computing IS weights (`cohort_forecast_v2.py:852-861`). No ESS check. With 66 cohorts of sequential IS, ESS collapses to ~1 (effectively a point mass). The conditioned draws are degenerate.

**v3 engine originally had**: `if _ess >= 5.0:` guard that skipped IS for cohorts where the evidence would collapse the draws. Removed for parity.

**Review question**: Should sequential IS across many cohorts use an ESS floor? Low ESS means the posterior is dominated by a single draw — the "conditioned" result is a noisy point estimate, not a proper posterior. Alternatives: block IS (resample all cohorts jointly), or use an ESS floor and skip conditioning for low-information cohorts.

**Side ledger**: ESS guard is a candidate v3 improvement after parity is achieved.

---

## D2: Span adapter does not read model_vars for latency SDs

**v2 behaviour**: `span_adapter.py:141-144` reads `promoted_mu_sd` from the latency block, or falls back to `posterior.mu_sd`. It does NOT read from `model_vars[].latency.mu_sd`.

**Consequence**: On any graph where the FE promotion step hasn't run (synth graphs, CLI-only workflows, API-only), `mu_sd` is zero → `has_uncertainty=False` → v2 skips IS conditioning entirely and uses a deterministic midpoint. This means v2's MC fan bands are absent for all BE-only execution paths.

**Root cause**: The FE's `applyPromotion` (in `modelVarsResolution.ts:183`) copies `mu_sd` → `promoted_mu_sd` at runtime. The synth pipeline and any BE-only path never calls this. The span adapter's fallback chain is `promoted_* → posterior.*` but the posterior object doesn't carry latency SDs.

**Fix applied**: Added promotion step to `synth_gen.py:update_graph_edge_metadata` so synth graphs have promoted fields. But the broader issue remains: any graph that hasn't been through the FE will lack promoted SDs, and v2 will silently produce deterministic (non-IS-conditioned) output.

**Review question**: Should the span adapter add `model_vars` as a third fallback? Or should the BE topo pass / param-pack pipeline always promote? The model resolver (used by v3) already reads `model_vars` directly — so v3 always finds the SDs. This is a correctness gap in v2's parameter sourcing for BE-only execution.

---

## D3: v2 uses span kernel CDF draws; v3 uses Beta posterior draws

**v2 behaviour**: MC draws come from `mc_span_cdfs()` which reconvolves latency draws through the span topology. `p_s` is the per-draw span probability. `cdf_arr` is the per-draw CDF array. Both encode span-level parameter uncertainty.

**v3 behaviour**: Draws come directly from `Beta(alpha, beta)` for p, and per-draw CDF from `Normal(mu, mu_sd)` etc. for latency. No span kernel reconvolution.

**For single-edge spans**: These should be equivalent — the span kernel degenerates to the single edge. But the specific draw generation (seed, clipping, numerical paths) may differ, producing different IS conditioning results when both collapse to near-point-mass after many sequential IS steps.

**For multi-edge spans**: The span kernel composes edge latencies via Fenton-Wilkinson convolution, producing a path-level CDF. The engine uses `build_node_arrival_cache` which also composes, but via a different code path.

**Review question**: Is the ~3% midpoint divergence at high τ (after 66 sequential IS steps) acceptable MC variance, or does it indicate a systematic bias in one implementation? Both collapse to ESS≈1, so neither is producing a reliable posterior — the divergence may be noise on a degenerate result.

---

## D4: v2 deterministic midpoint vs v3 MC median

**v2 behaviour**: When `has_uncertainty=False` (mu_sd=0), v2 computes midpoint via a fully deterministic per-cohort population model (`cohort_forecast_v2.py:1024-1085`). This uses `span_p` directly in `q_late_det = p × remaining_cdf / (1 - p × cdf_at_a)`. No MC draws involved.

**v3 behaviour**: Always uses MC sweep. With `has_dispersions=False`, all CDF draws are identical but `p_draws = Beta(alpha, beta)` still varies. The median of the MC sweep approximates but doesn't exactly equal v2's deterministic calculation.

**Consequence**: When the span adapter failed to find `mu_sd` (D2), v2 used the deterministic path while v3 used MC, producing systematic ~3-6% divergence. Fixed by fixing the promotion pipeline (D2).

**Review question**: Should v3 have a deterministic fallback for the zero-dispersion case? Or is the MC path always preferred (it naturally handles the transition from zero to nonzero dispersions)?

---

## D5: v2 evidence `has_real_obs` only checks mature cohorts

**v2 behaviour**: `cohort_forecast_v2.py:987-990`: `has_real_obs = any(tau in cohort_at_tau[...] for c in cohort_list if tau <= c['tau_observed'])`. Only cohorts where `tau ≤ tau_observed` (mature at this τ) can provide "real" evidence.

**v3 originally checked**: All cohorts regardless of maturity. This included immature cohorts' observations in the `has_real_obs` gate, inflating evidence counts.

**Review question**: v2's choice is defensible (immature cohorts haven't had time to observe at high τ, so their zero values are censored, not evidence of absence). But it means evidence disappears abruptly at the youngest cohort's frontier. Is there a smoother treatment?

---

## D6: `compute_anchor_node_id` uses `Graph(**graph_data)` which requires `policies`

**v2 behaviour**: `api_handlers.py:750-756` wraps graph data in `Graph(**graph_data)`. If validation fails (missing `policies`, `metadata`, etc.), anchor resolution silently returns None.

**Consequence**: Synth graphs (and any graph with incomplete schema) get `anchor_node=None`, which changes how `compose_path_maturity_frames` sources its denominator (uses `x` field instead of `a` field when `x_from_a=False`).

**Fix applied**: Added `policies` to all 26 synth graphs. But the silent failure pattern is fragile — any schema drift will silently break anchor resolution.

**Review question**: Should `compute_anchor_node_id` work with raw dicts instead of requiring full Pydantic validation? Or should schema validation failures be loud?

---

## D7: v2's fan bands require both `mc_cdf_arr` AND `mc_p_s` from span kernel

**v2 behaviour**: `has_uncertainty and mc_cdf_arr is not None and mc_p_s is not None` gates the entire MC per-cohort loop. If the span kernel doesn't produce MC draws (e.g. `_build_span_topology` returns None), v2 emits no fan bands at all — only deterministic midpoint.

**v3 behaviour**: The engine always produces conditioned draws (fan bands always present when there are cohorts).

**Consequence**: v3 can emit fan bands where v2 emits None. The parity test accepts this as a v3 improvement (v3 emits strictly more information). But it means the FE chart looks different — v3 shows uncertainty where v2 shows a bare line.

**Review question**: Is the v3 behaviour strictly better? Or does the FE chart design assume that absent fan bands mean "no uncertainty information available" vs "uncertainty is zero"?

---

## D8: Carrier build passes `cohort_list=[]` at graph level vs populated list at sweep level

**v2 behaviour**: Defers carrier build until after `cohort_list` is populated (`cohort_forecast_v2.py:656-669`). Tier 2 (empirical) uses cohort info for donor classification.

**v3 engine originally**: `build_node_arrival_cache` (graph-level topo pass) passed `cohort_list=[]` to `build_upstream_carrier`. This caused different tier selection (Tier 1 parametric vs Tier 2 empirical) and different Pop C results.

**Fix applied**: v3 now defers carrier build matching v2. But the engine's `build_node_arrival_cache` still passes `[]` — the fix is in v3's handler, not the engine. If other engine consumers rely on `build_node_arrival_cache`, they'll get the wrong carrier.

**Review question**: Should `build_node_arrival_cache` accept an optional `cohort_list`? Or should the carrier always be built at sweep time, not cache time?

---

## D9: Promotion is FE-only — BE consumers never see promoted latency SDs

**Systemic issue**: `promoted_mu_sd`, `promoted_sigma_sd`, `promoted_onset_sd` etc. are written by the FE's `modelVarsResolution.ts` and `bayesPatchService.ts` at runtime. They live in the in-memory graph store, not on disk. Every BE-only consumer (`span_kernel.py:_extract_edge_params`, `span_kernel.py:mc_span_cdfs`, `span_adapter.py`) reads from the graph JSON and finds no promoted fields.

**Consequence**: Without the model_vars fallback, v2's `has_uncertainty=False` for every graph → no IS conditioning, no MC fan bands, deterministic midpoint only. v3 (via model resolver) correctly finds `mu_sd` from model_vars → IS conditioning runs → completely different fan shape.

**Band-aid applied**: Added model_vars fallback to `span_adapter.py`, `mc_span_cdfs` in `span_kernel.py`, and `_extract_edge_params` in `span_kernel.py`.

**Proper fix**: The BE topo pass (`topoPass.ts:126`) already promotes `t95`. It should promote all SDs (`mu_sd`, `sigma_sd`, `onset_sd`, `onset_mu_corr`, path variants). This would make promotion happen on every `param-pack` CLI call and every FE topo pass, persisting the promoted values to disk.

**Affected files for proper fix**: `graph-editor/src/cli/topoPass.ts` — extend the promotion block at line 126 to include all SD fields.
