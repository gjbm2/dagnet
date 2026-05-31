# FC Kappa Predictive Dispersion Proposal

**Date:** 26-May-26  
**Status:** proposal  
**Scope:** Frontier-conditioned predictive dispersion on the FC `ef_*` surface, including chart forecast bands and scalar consumers such as the CF scalar reducer / `surprise_gauge`. This proposal replaces the FC use of collapsed `alpha_pred` / `beta_pred` with direct use of Bayes-fitted `kappa`.

## 1. Purpose

The frontier-conditioned forecast surface should use the realised-outcome dispersion fitted by Bayes. Today that dispersion reaches the runtime only after being collapsed into `alpha_pred` / `beta_pred`. That collapsed Beta is adequate as a compatibility surface, but it is not the right object for FC band construction because it removes the unit at which predictive variation should be realised.

The target contract is:

- `alpha` / `beta` represent epistemic uncertainty about the underlying primitive transition rate;
- `kappa` represents Bayes-fitted realised-rate overdispersion around that transition rate;
- FC generates realised predictive transition rates from `alpha` / `beta` plus `kappa` once per selected Cohort per primitive edge, then reuses that realised rate wherever that Cohort's mass crosses the edge;
- every downstream consumer that asks for FC predictive dispersion reads this same kappa-realised FC surface, whether it renders a chart fan, emits scalar reducer output, or computes a surprise-gauge z-score;
- `alpha_pred` / `beta_pred` remain serialised for compatibility but stop being the authoritative FC predictive mechanism.

## 2. Code Facts

Bayes already fits unified per-edge kappa in `bayes/compiler/model.py`. The variable is named `kappa_<safe_edge_id>`, and is a deterministic transform of `log_kappa_<safe_edge_id>`. It is passed into edge likelihood emission alongside the transition probability variable.

Bayes summarisation in `bayes/compiler/inference.py` currently uses kappa to manufacture collapsed predictive Beta compatibility fields. There are two flavours today:

- window predictive fields use MCMC samples from `kappa_<safe_edge_id>`;
- cohort predictive fields currently use an empirical cohort kappa estimate from `_estimate_cohort_kappa`, not the MCMC edge kappa.

This proposal makes the MCMC edge kappa the runtime FC contract. It does not claim that every existing `*_alpha_pred` / `*_beta_pred` compatibility field is reconstructible from the new adjacent `kappa` field.

The same file also records the posterior mean of `kappa_<safe_edge_id>` in `InferenceResult.model_state`. That state is explicitly described as warm-start internals and not consumed by the FE. It is therefore not the correct runtime contract for FC.

`bayes/worker.py` serialises `alpha_pred` / `beta_pred` into `window()` and `cohort()` slices. It does not serialise the edge-level kappa into those slices. It does serialise per-context slice `kappa_mean` / `kappa_sd` for some context slice entries, but that shape is not projected into the normal promoted probability block.

`graph-editor/src/services/bayesPatchService.ts` copies `alpha_pred` / `beta_pred` into `model_vars[*].probability`, but does not copy edge-level kappa.

`graph-editor/lib/runner/model_resolver.py` exposes `alpha_pred` / `beta_pred` on `ResolvedModelParams`, but exposes no kappa field.

`graph-editor/lib/runner/primitive_conditioning.py` currently interprets `dispersion_basis='predictive'` by replacing the epistemic prior pair `alpha` / `beta` with the collapsed predictive pair `alpha_pred` / `beta_pred`. That is the exact collapse this proposal removes from the FC path.

`graph-editor/lib/runner/model_span_spine.py` currently builds a second predictive-basis conditioned primitive family and feeds `composed_carrier_predictive` / `composed_subject_predictive` into the FC continuation. The predictive kernels are cohort-invariant over the selected-Cohort axis, so a single draw index supplies the same predictive transition realisation to every selected Cohort.

The production FC continuation path uses `frontier_continuation_dp.run_dp_from_node_source_ledgers` with `DPExecutionPolicy.TOEPLITZ_APPLY`. Its kernel providers must therefore support both the scalar provider contract and the `.batched_op(ce, source_basis, source_mass_3d) -> (out_3d, out_basis)` contract consumed by the Toeplitz applier.

## 3. Problem Statement

Kappa describes realised-rate variation. FC is a realised future continuation. Therefore FC needs kappa at the point where unresolved selected-Cohort mass crosses each primitive transition.

The current collapsed path does this instead:

1. Bayes samples realised rates using kappa.
2. Bayes moment-matches those samples to `alpha_pred` / `beta_pred`.
3. Runtime samples a predictive primitive draw family from that collapsed Beta.
4. FC applies that draw family across the selected-Cohort axis.

That path loses the independence structure. A query containing one selected Cohort and a query containing many independent selected Cohorts can receive predictive variation from the same primitive draw family. The forecast band therefore cannot correctly narrow as selected Cohort count or selected mass increases.

This is not a denominator/numerator semantic change. The displayed rate remains `Y / X` per `COHORT_ANALYSIS_NUMERATOR_DENOMINATOR_SEMANTICS.md`. This proposal changes only how FC supplies predictive realised transition rates for unresolved future mass.

This is also not chart-only. Chart bands are one consumer of FC predictive dispersion, but the same surface is the predictive-distribution authority for scalar reducers. A scalar consumer must not keep using collapsed `alpha_pred` / `beta_pred` after FC has switched to kappa-realised prediction merely because it does not render a fan.

## 4. Target Field Contract

Add one runtime probability field:

`model_vars[*].probability.kappa`

Meaning:

Bayes-fitted Beta concentration for realised-rate variation around the underlying primitive transition rate.

Field rules:

- `kappa` is a positive number.
- `kappa` belongs to the same model-var probability block as `alpha` / `beta`.
- `kappa` is selected by the same source, context, and slice resolution as `alpha` / `beta`.
- `kappa` is not a replacement for `alpha` / `beta`.
- `kappa` is not `alpha_pred + beta_pred`.
- `alpha_pred` / `beta_pred` remain serialised compatibility fields.
- FC reads `kappa`; non-FC consumers may continue reading `alpha_pred` / `beta_pred`.

Do not add `kappa_sd` in this work. The first implementation carries the fitted posterior mean of kappa, matching how `_model_state` already stores it for warm-start. Posterior uncertainty over kappa is a later extension and must not be smuggled into this field.

Persistence and projection surfaces:

- parameter-file posterior slices add `posterior.slices[*].kappa`;
- `model_vars[*].probability.kappa` is the graph source-ledger runtime field;
- `ResolvedModelParams.kappa` is the BE runtime access field;
- primitive provenance reports whether kappa was present, absent, or supplied by a documented fallback;
- promoted `edge.p.posterior` may carry `kappa` only as a source-agnostic projection convenience. FC must still read through the resolver, not directly from the promoted graph surface.

Compatibility note:

`alpha_pred` / `beta_pred` remain useful compatibility fields for legacy consumers and reports that already understand collapsed predictive Betas. They are no longer the FC forecast-band authority after this proposal lands. In cohort slices, the existing compatibility `cohort_alpha_pred` / `cohort_beta_pred` may continue to reflect the historical empirical-cohort-kappa derivation until a separate cleanup changes that contract.

## 5. Bayes And Serialisation Changes

Extend `PosteriorSummary` in `bayes/compiler/types.py` with `kappa: float | None`.

In `summarise_posteriors` in `bayes/compiler/inference.py`, set `PosteriorSummary.kappa` from the posterior mean of `kappa_<safe_edge_id>` when present. Use the MCMC kappa. Do not use the diagnostic MLE kappa and do not use the empirical cohort kappa that currently feeds `cohort_alpha_pred` / `cohort_beta_pred`.

In `_build_unified_slices` in `bayes/worker.py`, write `kappa` into the `window()` slice when `PosteriorSummary.kappa` is present.

For the `cohort()` slice in the first implementation, also write the same `kappa` value. The current live factorised runtime uses edge-local primitives for both window and cohort queries. The primitive's realised-rate overdispersion is a property of that physical transition, not of the query mode. If a future direct cohort primitive is introduced with a distinct fitted kappa, that work must add an explicitly named cohort primitive kappa then.

For context slice entries, normalise the current per-slice `kappa_mean` output into the same runtime field name `kappa` when projecting into `model_vars[*].probability`. Diagnostics may still report `kappa_sd`, but the runtime contract consumes `kappa`.

In `bayesPatchService.ts`, copy `windowSlice.kappa` into `probabilityBlock.kappa`. If the active source is contexted, the contexting path must copy the selected slice's `kappa` with its selected slice `alpha` / `beta`. Do not derive kappa from `alpha_pred` / `beta_pred`.

Schema and type work is part of this stage, not a follow-up. Add `kappa` to:

- `SlicePosteriorEntry` and `FitHistorySlice` shape via `SlicePosteriorEntry`;
- `BayesPatchEdge.slices[*]`;
- `ModelVarsEntry.probability`;
- `ProbabilityPosterior` only if the promoted projection intentionally carries it;
- `GraphParamExtractor` whitelists wherever probability posterior / source-ledger fields are exported;
- the parameter schema for posterior slice entries;
- graph schema and Pydantic parity surfaces if `edge.p.posterior.kappa` is projected.

In `model_resolver.py`, add `kappa` to `ResolvedModelParams` and read it from the promoted source-ledger probability block. The resolver must not infer kappa from predictive Beta concentration.

Run the relevant schema/type parity tests for any schema or Pydantic surface touched.

## 6. Runtime Primitive Contract

Extend `ConditionedTransitionPrimitive` with `kappa`.

The primitive continues to carry one probability posterior draw family: the conditioned epistemic transition-rate draws from `alpha` / `beta` and admitted evidence.

Kappa is additional predictive metadata on that same primitive. It is not a second posterior. It is not a separate conditioning path. It is consumed only when a caller asks for realised predictive transition kernels.

`primitive_conditioning.condition_primitive` remains the single evidence-conditioning locus. Evidence updates the epistemic rate posterior. FC predictive variation is generated after conditioning, by drawing realised transition rates around the conditioned epistemic rate draws using `kappa`.

`dispersion_basis='predictive'` must stop being the FC mechanism. It can remain for legacy compatibility surfaces that deliberately consume `alpha_pred` / `beta_pred`, but the FC path should not build its forecast fan from collapsed predictive Beta primitives.

Missing kappa policy:

- If the resolved primitive has no kappa, the kappa-realised FC provider must not silently infer it from `alpha_pred + beta_pred`.
- Stage 2 shadow mode may emit a diagnostic and omit the shadow surface for that primitive.
- Stage 3 cutover must define a perimeter policy before enabling production use: either refuse FC predictive bands for missing-kappa primitives with clear provenance, or use an explicit compatibility mode that is named as collapsed-predictive fallback. The fallback, if chosen, is a compatibility perimeter decision, not an engine default.

## 7. Multi-Hop And Window-Primitive Composition

Current production queries commonly compose window-trained primitives. A multi-hop query is therefore a chain or DAG of edge-local primitive transitions, each with its own `alpha` / `beta` and `kappa`.

For a primitive edge `e: U -> V`, define:

- `theta_e[s]`: the conditioned epistemic transition-rate draw for draw index `s`;
- `kappa_e`: the Bayes-fitted realised-rate concentration for edge `e`;
- `M_e[c, u, s]`: selected mass at primitive source node `U` for selected Cohort `c`, source bucket `u`, and draw `s`;
- `T_e[s, u, lag]`: the timing transition kernel for edge `e`, using the existing bucket basis rules.

FC must generate a realised transition rate for each selected-Cohort/primitive-edge unit:

`rho_e[c, s]` is drawn from a Beta distribution with mean `theta_e[s]` and concentration `kappa_e`.

Then every source bucket for Cohort `c` crossing primitive edge `e` uses:

`rho_e[c, s]` multiplied by the timing transition kernel for `e`.

Source buckets determine exposure placement and timing. They do not create independent kappa realisations. A selected Cohort may reach a downstream primitive over many source buckets; all of that Cohort's mass uses the same realised rate for that primitive edge.

This is the multi-hop rule. The DP composes these Cohort-level primitive realisations through the existing source-bucket ledgers. There is no path-level kappa and no post-hoc path-level widening.

The independence key for realised kappa draws is:

`(primitive identity, selected Cohort identity, draw index)`

All source buckets for the same selected Cohort crossing the same primitive edge share the same realised rate. Different selected Cohorts receive independent realised-rate draws conditional on the same epistemic draw and kappa.

This preserves both sources of uncertainty:

- the same epistemic draw index `s` is shared through the composed graph, representing uncertainty about the underlying rates;
- realised kappa noise is independent across selected Cohorts, so aggregating more independent Cohorts narrows the predictive band.

## 8. Window Queries

For `window(X -> end)`, the selected population is rooted at `X`, but multi-hop subject primitives downstream of `X` still run as local primitive transitions.

The FC kappa rule is unchanged:

- for the first primitive out of `X`, source bucket is the selected window source bucket;
- for downstream primitives, source buckets are produced by upstream primitive arrivals;
- each selected window Cohort receives one realised rate draw per primitive edge from that primitive's `theta` and `kappa`;
- all source buckets generated by that selected window Cohort reuse the same realised rate for a given primitive edge;
- the DP aggregates mass to the query end before row projection.

The result is not a single window-level predictive Beta. It is the composed predictive distribution of the primitive chain under mass-first aggregation.

## 9. Cohort Queries

For `cohort(A, X -> end)`, there are carrier primitives from `A` to `X` and subject primitives from `X` to `end`.

The same primitive kappa rule applies to both roles:

- carrier primitives use their own kappa when unresolved carrier mass crosses them;
- subject primitives use their own kappa when unresolved subject mass crosses them;
- future `X` arrivals from carrier continuation become source-bucket mass for the subject span and then receive subject-primitive realised-rate draws at the subject primitive boundary.
- a selected A-Cohort spread across many X-arrival buckets still receives one realised rate per subject primitive edge, not one realised rate per X-arrival bucket.

The query remains factorised. Kappa is applied at the primitive transition boundary, not at the whole path.

## 10. Contexts

Context selection must be resolved before FC primitive construction.

The active primitive probability block already carries the selected source and slice identity. `kappa` must live in that same block. Therefore a contexted primitive's `kappa` is selected by the same mechanism that selects its `alpha` / `beta`.

There is no separate context-kappa lookup in FC. If the primitive's resolved model parameters say `alpha` / `beta` came from a context slice, `kappa` must also have come from that slice. If no context-specific kappa is available, the resolver may fall back to the aggregate kappa only if it also records that fallback in provenance. It must not silently pair context-specific `alpha` / `beta` with unrelated aggregate kappa without provenance.

## 11. Runtime Implementation Shape

Replace the FC use of `composed_carrier_predictive` and `composed_subject_predictive` with kappa-realised FC kernel providers.

Those providers consume:

- the epistemic conditioned primitive objects;
- each primitive's `kappa`;
- selected Cohort count;
- draw count;
- bucket basis.

The provider returns cohort-aware kernels. Unlike the current predictive provider, the returned kernel has selected-Cohort dependence because realised kappa noise is generated per selected Cohort and primitive edge.

The existing FC DP already accepts cohort-aware kernels. `frontier_continuation_dp.py` documents that providers may return either cohort-invariant `(draw, tau)` kernels or cohort-dependent `(cohort, draw, tau)` kernels. The kappa-realised provider should use the cohort-dependent shape.

The provider must also implement the production batched contract:

`batched_op(ce, source_basis, source_mass_3d) -> (out_3d, out_basis)`

where `source_mass_3d` has shape `(selected_cohort, draw, tau)` and `out_3d` has the same leading axes. The Toeplitz path is the production path; a scalar-only provider is not complete.

The scalar callback remains useful for contract tests and for any future non-Toeplitz execution policy, but it is not sufficient acceptance for the implementation.

The provider must be deterministic under draw-family keying. The random key must include:

- primitive identity;
- selected Cohort identity;
- draw family identity;
- the literal derivation name for kappa-realised FC probability.

This keeps reruns stable and ensures source buckets for the same selected Cohort and primitive edge reuse the same kappa realisation, while different selected Cohorts receive independent realisations.

Add a new named RNG derivation in `primitives._DERIVATIONS` for the kappa-realised FC probability draw. Do not call `np.random.default_rng` directly and do not reuse `primitive_p_draws`; the realised-rate layer is a distinct random object derived from, but not identical to, the conditioned epistemic primitive draw.

## 12. Scalar Reducer And Surprise Gauge Consumption

The kappa-realised FC surface is the predictive-distribution authority for scalar consumers as well as chart fans.

For the surprise gauge, the intended comparison is between two distributions over the same selected-Cohort scalar:

- the unconditioned model surface on the epistemic basis;
- the FC surface on the kappa-realised predictive basis.

For `p`, the scalar is the selected-Cohort rate at saturation. For `completeness`, the scalar is the selected-Cohort frontier/saturation rate ratio on the corresponding surface. The surprise-gauge reducer should compute the FC-side dispersion from the kappa-realised FC draw surface; it must not use collapsed `alpha_pred` / `beta_pred` as the FC predictive dispersion except under an explicitly named compatibility fallback.

If the z-score combines uncertainty from both sides, the FC contribution to that denominator is the kappa-realised predictive dispersion of the derived scalar. The unconditioned contribution remains the model-overlay epistemic dispersion. When per-draw difference surfaces are not coherently paired, the conservative scalar approximation is the root-sum-square of the two side-specific SDs.

## 13. Transition Plan

Stage 1: surface `kappa`

- Add `PosteriorSummary.kappa`.
- Serialise `kappa` in Bayes slices.
- Copy `kappa` into `model_vars[*].probability`.
- Add `ResolvedModelParams.kappa`.
- Add primitive provenance showing kappa availability.
- Update schemas, Pydantic/TypeScript surfaces, whitelists, and schema/type parity tests for every persisted or projected kappa field.
- Add resolver and patch-application tests proving kappa flows from Bayes patch slice to `model_vars` to `ResolvedModelParams`.
- Keep FC behaviour unchanged.

Stage 2: add kappa-realised provider in shadow

- Build FC kappa-realised kernels from epistemic conditioned primitives plus kappa.
- Implement both scalar and `.batched_op` provider contracts.
- Add a new draw-family derivation for kappa-realised FC probability.
- Run the provider in parallel with the current collapsed predictive FC path.
- Emit diagnostics comparing FC band widths and central lines.
- Emit missing-kappa provenance rather than silently falling back.
- Do not change chart fields yet.

Stage 3: switch FC bands

- Route FC forecast fan fields to the kappa-realised provider.
- Keep central line on the same mass-first median calculation produced by the provider.
- Preserve prefix pinning through the frontier.
- Define and test the missing-kappa perimeter policy before enabling production cutover.
- Keep `alpha_pred` / `beta_pred` serialised for compatibility, but remove them from the FC forecast-band authority.

Stage 4: clean docs and compatibility

- Update the maintained codebase docs so FC predictive dispersion is documented as kappa-realised primitive variation, not collapsed predictive Beta.
- Mark `alpha_pred` / `beta_pred` as compatibility / non-FC surfaces.
- Document the cohort compatibility wrinkle: existing `cohort_alpha_pred` / `cohort_beta_pred` may have been derived from empirical cohort kappa, while `kappa` is the edge-level MCMC runtime field for factorised primitives.

## 14. Acceptance Tests

Add a unit-level FC test for aggregation narrowing:

- construct one primitive with fixed `alpha` / `beta`, fixed latency, and finite `kappa`;
- run FC with one selected Cohort;
- run FC with multiple selected Cohorts of equal mass;
- assert the multi-Cohort forecast band is narrower than the one-Cohort band.
- assert the midpoint remains within a tight tolerance of the expected mass-first predictive median in the high-kappa limit.
- assert increasing selected Cohort count narrows only the realised-rate component, not the epistemic component shared by draw index.

Add a multi-hop test:

- construct a two-edge chain with different kappa values on each primitive;
- assert changing the downstream primitive kappa changes the subject-side forecast band while leaving carrier-only denominator behaviour unchanged;
- assert changing the upstream primitive kappa changes carrier continuation and therefore both denominator and future subject arrivals.
- assert there is no path-level post-hoc widening after the primitive chain has been composed.

Add a source-bucket reuse test:

- construct one selected Cohort whose mass reaches a downstream primitive over multiple source buckets;
- assert the downstream primitive uses one kappa-realised rate for that Cohort across those buckets;
- assert splitting the same mass into multiple selected Cohorts narrows the band, while splitting one Cohort across more source buckets does not narrow as if buckets were independent.

Add a provider-contract test:

- construct a kappa-realised provider for a tiny span;
- call both the scalar path and `.batched_op`;
- assert they produce the same per-cohort, per-draw output under the same source mass;
- assert the provider works under `DPExecutionPolicy.TOEPLITZ_APPLY`, because that is the production FC path.

Add a context test:

- construct a primitive with two context slices whose `alpha` / `beta` and `kappa` differ;
- resolve each context;
- assert FC provenance reports the matching kappa for the selected context;
- assert no contexted primitive uses aggregate kappa silently.

Add serialisation and resolver tests:

- Bayes `PosteriorSummary.kappa` is written into `window()` and `cohort()` slices as `kappa`;
- `bayesPatchService.ts` copies slice `kappa` into `model_vars[bayesian].probability.kappa`;
- `posteriorSliceContexting.ts` carries selected context `kappa` with selected context `alpha` / `beta`;
- `model_resolver.py` exposes `ResolvedModelParams.kappa` and does not infer it from `alpha_pred + beta_pred`.

Add central-line and limiting tests:

- high-kappa limit converges to the existing epistemic FC central line;
- zero-evidence mode degenerates to the model curve with kappa-realised predictive width, not to strict evidence;
- missing-kappa policy is visible in provenance and never silently derives from collapsed predictive Beta concentration.

Keep existing deterministic truth-curve tests deterministic by setting kappa-equivalent dispersion out of the test, as already done for exact curve assertions.

## 15. Non-Goals

Do not remove `alpha_pred` / `beta_pred`.

Do not add `kappa_sd` in this work.

Do not create a path-level kappa.

Do not widen bands after row projection.

Do not recondition primitives inside FC.

Do not change F mode. F mode remains the query-conditioned model surface on the epistemic operator basis.

Do not collapse multi-hop predictive dispersion into a single path Beta. Multi-hop FC predictive dispersion is primitive-local kappa realised per selected Cohort through the existing DP and aggregated mass-first.

