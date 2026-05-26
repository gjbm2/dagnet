# Frontier-Conditioned Chart Surface Proposal

**Date:** 21-May-26  
**Status:** proposal  
**Last revised:** 22-May-26  
**Scope:** Cohort-maturity chart semantics after the selected-cohort spine cutover. This note describes the algebraic/logical change needed so **E+F mode** means "strict evidence layer before epoch C plus FC forecast layer after epoch A" rather than "strict evidence displayed beside a full conditioned model surface".

## 1. Summary

The current post-cutover output path produces useful components, but assigns them to confusing chart surfaces.

We now have:

- strict empirical evidence outputs from the empirical span operators;
- a full query-conditioned model surface from conditioned primitives and composed spans;
- a separate unconditioned model overlay currently exposed as the chart's F curve.

The proposed chart semantics are:

- **E mode**: strict empirical evidence only.
- **F mode**: the query-conditioned model surface. This is the surface currently close to `midpoint` / `fan_*`, but it should use epistemic dispersion and should not be frontier anchored.
- **E+F mode**: strict evidence layer before epoch C plus FC forecast layer after epoch A.
- **FC surface**: the internal frontier-conditioned forecast surface (`ef_*`). It uses the actual selected-Cohort evidence up to the observation frontier as the boundary condition, then projects only the unresolved future with predictive dispersion.
- **Optional model overlay**: the existing unconditioned model curve with epistemic bands. This is not a default chart mode and is not renamed `F`; tests that currently protect old F behaviour should migrate to this overlay contract where that behaviour remains useful.

In chart display terms, **E+F mode** remains a two-layer mode:

1. strict evidence is shown only while there is observed or partially
   observed support (epochs A and B);
2. the FC forecast curve and bands are shown at all points after epoch A
   (epochs B and C), and remain the only visible layer in epoch C.

The FC surface replaces layer 2. It does not replace or hide
strict evidence.

This lets us stop using the current chart-facing F curve output (`model_midpoint` / `model_fan_*` / `model_bands`) as F mode. The surface can remain as an optional model overlay, but it is neither strict evidence nor the model conditioned on the query's selected evidence in the sense the user expects from the forecast-only view.

The terminology used by this note is standardised in [Appendix B](#appendix-b-standard-terminology-and-display-mapping). In short: E, F, and E+F name display modes only; internal outputs are named surfaces and layers.

## Implementation progress

<!-- managed by /implement-carefully — edit checkboxes manually only when the skill is not running -->

- [x] Atom 0 — Baseline And Test Ledger — completed 22-May-26
- [x] Atom 1 — Split The Current Hybrid And Make F Mode Mean Conditioned Model — completed 22-May-26
- [x] Atom 2 — Make Dispersion Basis Explicit — completed 22-May-26
- [x] Atom 3 — Source-Bucket Ledger Substrate — completed 23-May-26
- [x] Atom 4a — Evidence-First Frontier State And Shadow FC — completed 24-May-26
- [x] Atom 4b — FC Shadow Performance Pass — completed 24-May-26
- [x] Atom 4c — Consolidate Root-Seed And Frontier-Ledger DP Substrate — completed 24-May-26
- [x] Atom 4d — Source-Indexed Empirical Evidence Fast Path — completed 25-May-26
- [x] Atom 5 — Split The Spine Projection Surface Contract — completed 25-May-26
- [x] Atom 6 — Switch E+F Forecast-Layer Mapping — completed 26-May-26
- [x] Atom 7 — Name The Optional Model Overlay — completed 26-May-26
- [x] Atom 8 — Promote Terminology To Codebase Docs — completed 26-May-26

### Atom 0 baseline result (recorded 22-May-26)

Baseline captured before any Atom 1+ code work. Working tree stash:
`stash@{0}: On feature/snapshot-db-phase0: frontier-conditioned-surface-start`.

**Outside-in oracle** — `graph-editor/lib/tests/test_cohort_factorised_outside_in.py`:
**50 passed, 1 xfailed in 397.98s (~6m38s)**. JUnit XML at
`/home/reg/.cache/dagnet-cli/atom0-outside-in.xml`. The single xfail is
`test_cli_single_hop_downstream_cohort_parity_and_admitted_provenance` —
declared strict and intentional pre-WP8 cohort admission diagnostic (doc 60
Appendix A.1). Not a regression; **unrelated to frontier-conditioned chart
semantics**.

The previously-documented bucket-transition outside-in regressions (per
[21-May-26 followup handover](../handover/21-May-26-bucket-transition-regression-followup.md))
have all flipped to green in the current working tree:
- `test_first_latency_edge_with_nonlatent_chain_observed_collapses_to_window` — passing
- `test_multihop_latent_upstream_divergence` — passing
- `test_active_multihop_evidence_uses_query_x_denominator_not_terminal_edge_x` — passing (tolerance floor 40.0 per handover edit)

**FC-relevant focused tests** — curated bundle of 10 files
(`test_model_span_spine_selected_cohort.py`, `test_bucket_transition_algebra.py`,
`test_empirical_evidence_operator.py`, `test_subject_span_composer.py`,
`test_span_readout.py`, `test_evidence_clocking_spine_toy.py`,
`test_v3_degeneracy_invariants.py`, `test_selected_evidence_natural_degeneracy.py`,
`test_chart_graph_agreement.py`, `test_conditioned_forecast_parity.py`):
**8 failed, 94 passed, 5 skipped, 1 xfailed in 131.72s**. JUnit XML at
`/home/reg/.cache/dagnet-cli/atom0-fc-focused.xml`.

Failure classification:

| Failing test | Classification |
|---|---|
| `test_model_span_spine_selected_cohort.py::test_model_and_empirical_y_surfaces_can_disagree` | Adjacent workstream — bucket-transition algebra (in-flight) |
| `test_model_span_spine_selected_cohort.py::test_phase6_inv1_saturation_conservation_single_hop_with_latency` | Adjacent workstream — bucket-transition algebra (in-flight) |
| `test_model_span_spine_selected_cohort.py::test_phase6_inv1_saturation_conservation_multihop` | Adjacent workstream — bucket-transition algebra (in-flight) |
| `test_model_span_spine_selected_cohort.py::test_phase6_inv6_dirac_edge_collapses_to_one_edge_reach` | Adjacent workstream — bucket-transition algebra (in-flight) |
| `test_model_span_spine_selected_cohort.py::test_phase6_w3_window_vs_cohort_divergence_at_finite_tau_convergence_at_saturation` | Adjacent workstream — bucket-transition algebra (in-flight) |
| `test_bucket_transition_algebra.py::test_rate_attributed_prefix_uses_bucket_k_without_overshoot` | Adjacent workstream — bucket-transition algebra (in-flight) |
| `test_evidence_clocking_spine_toy.py::test_handler_boundary_step_clock_reads_only_supplied_evidence_dates` | Adjacent workstream — toy tests, handover says "do not update until target semantics are settled" |
| `test_evidence_clocking_spine_toy.py::test_uniform_latency_cohort_multihop_preserves_mass_conservation` | Adjacent workstream — toy tests, handover says "do not update until target semantics are settled" |

**Classification rationale**: all 8 failures sit in test files the
bucket-transition algebra workstream is actively reshaping (see
[bucket-transition algebra plan](bucket-transition-algebra-implementation-plan-21-May-26.md)
and the two 21-May-26 handovers). None are FC-proposal protection tests
under §9.9. They are owned by the adjacent workstream, not by this
proposal. The outside-in oracle — the canonical protection per §10 of
this proposal — is green, so they do not constitute a high-signal
regression that blocks Atom 0 from completing.

**Stop-condition summary**:

- Outside-in green at baseline ✓
- No high-signal regression left unowned ✓ (the 8 focused failures are owned by the bucket-transition workstream)
- No future atom plans to weaken outside-in tolerances ✓

Atom 0 stop conditions are not triggered.

**Caveat carried into Atom 1**: Atoms 1+ touch
`graph-editor/lib/runner/model_span_spine.py`,
`subject_span_composer.py`, and `span_operator_supply.py` — the same
files the bucket-transition workstream is actively reshaping. The
bucket-transition handover explicitly notes: "Adjacent chart-surface
proposal; useful for future `e+f` semantics but do not conflate with
current bucket-K fix." Before launching Atom 1, decide whether to:

1. Stabilise the bucket-transition workstream first (close its 8 focused
   failures), then start FC Atom 1 on a fully green floor; or
2. Land bucket-transition and FC concurrently with explicit coordination
   on the overlapping surfaces.

### 1.1 Risk-Control Premise

This proposal must not become another high-risk all-at-once cutover. The
implementation sequence must keep the outside-in oracle green after each
step. Where tests change, the change must be local to the surface contract
being renamed or remapped in that step.

The starting empirical assumption is that the current conditioned model
surface and strict evidence readout are broadly coincident in shape. The
FC surface should therefore improve semantic legibility of the forecast fan
without producing a large visible shape change. The acceptance strategy
should verify that assumption explicitly by shadow-emitting the FC surface
before routing chart fields to it.

## 2. Current Output Path

The current `cohort_forecast_v3._project_runtime_rows` path delegates to `model_span_spine.project_selected_cohort_rows`.

Inside the spine, the conditioned model path starts from selected Cohort root mass and runs composed conditioned operators forward from the beginning of the time axis. This produces `x_draws_model`, `y_draws_model`, and `rate_draws_model`.

Separately, the empirical path runs composed empirical operators and produces `evidence_x_strict`, `evidence_y_strict`, and `rate_strict`.

Important current-state warning: `rate_draws_model` is not yet a clean
conditioned model surface. `project_selected_cohort_rows` currently overwrites
each Cohort's model arrays through its observed prefix with strict empirical
values:

```text
x_model_by_anchor[cohort_idx, :, :last_tau_obs + 1] = strict_x_a[:last_tau_obs + 1]
y_model_by_anchor[cohort_idx, :, :last_tau_obs + 1] = strict_y_a[:last_tau_obs + 1]
```

So today's `x_draws_model` / `y_draws_model` / `rate_draws_model` are a
de facto evidence-prefix splice. They are neither a pure conditioned model
surface for F mode nor the target FC surface, because the target FC surface
must build a frontier occupancy ledger and continue only unresolved mass.
Any rollout step that says "use the conditioned model surface" must first
create or expose an unspliced surface.

The row projector then emits:

- evidence fields from the empirical strict surface;
- `midpoint` / `fan_*` from the full conditioned model surface;
- `model_midpoint` / `model_fan_*` from the unconditioned overlay;
- `forecast_x` / `forecast_y` by subtracting observed evidence from the full model means after the fact.

That final subtraction is a sign that the algebra is happening in the wrong order. The future residual should be produced directly from a frontier-conditioned projection, not obtained by subtracting evidence from a full-root model projection at row projection time.

## 3. Desired Chart Surfaces

### 3.1 Strict Evidence

Strict evidence remains the empirical selected-Cohort surface.

It answers: "What has actually been observed for these selected Cohorts on the selected clock?"

It owns:

- `rate`;
- `evidence_x`;
- `evidence_y`;
- evidence-only display.

It should continue to use the empirical span operator and the strict endpoint-cumulative row semantics being investigated in `evidence-discretisation-investigation-21-May-26.md`.

### 3.2 Query-Conditioned Model Surface

The query-conditioned model surface answers: "What does the model predict for this selected Cohort set after conditioning primitives on the query evidence?"

It does not splice in a realised per-Cohort prefix. It is a model belief surface for the selected query, not a realised-Cohort forecast bridge.

F mode should render this surface.

Dispersion: **epistemic**. Forecast-only model view should show uncertainty in model belief after query conditioning, not predictive row noise for unresolved individual outcomes.

Implementation implication:

- reuse the current full conditioned operator projection concept;
- do not use the unconditioned overlay as F mode;
- ensure the operator supply for this surface uses epistemic timing/probability dispersion.

### 3.3 FC Surface

The FC surface answers: "Given what this selected Cohort has actually done up to its observation frontier, where can it still land when mature?"

This supplies the forecast layer in E+F mode.

It must be deterministic through each Cohort's observed prefix. At the frontier, every draw should agree with the evidence surface for that Cohort. After the frontier, draws spread as unresolved future mass is projected forward.

Dispersion: **predictive**. The FC surface is about unresolved future outcomes conditional on the realised prefix, so it should carry predictive uncertainty for the future continuation.

## 4. The Missing Runtime Object

The cutover currently has strict empirical row totals, but row totals are not enough to initialise the future forecast.

The missing object is a per-Cohort frontier state. It should be derived from empirical outputs before the model continuation runs.

A frontier state needs to carry:

- the selected Cohort identifier and observation frontier age;
- strict empirical denominator and numerator prefix arrays up to the frontier;
- strict denominator and numerator values at the frontier;
- the per-node and per-source-bucket mass ledger at the frontier;
- enough provenance to know which empirical operator/binding produced the state.

The important part is the ledger. For multi-hop subjects, a scalar "observed denominator minus observed numerator" is not enough. The model continuation must know where unresolved mass sits on the composed subject span at the frontier. Mass at different intermediate nodes or source buckets has different future timing.

## 5. Algebraic Change

The current conditioned model projection is a full-root projection. It starts with selected root mass at the beginning of the horizon and asks the composed conditioned operators to produce a complete model trajectory.

The FC surface is a continuation projection. It fixes the empirical prefix, builds the unresolved state at the observation frontier, and asks the predictive operator family to continue only that unresolved state.

This section is the implementation contract for that new stage. It is grounded in `COHORT_ANALYSIS_NUMERATOR_DENOMINATOR_SEMANTICS.md`:

- the denominator side is the carrier `A -> X`;
- the numerator side is the subject span `X -> end`;
- row output remains `Y / X`, never `Y / A`;
- identity carrier and window-shaped cases degenerate through supplied state and operators, not through central branches.

### 5.1 Inputs to the New Stage

The frontier-conditioned stage has five explicit inputs.

First, selected-Cohort metadata from the perimeter: `anchor_day`, selected root mass, `tau_observed`, and `tau_max`. `tau_observed` is the Cohort-specific frontier age. `tau_max` remains the display/data extent.

Second, empirical carrier traces from the strict evidence pass. These describe observed selected-Cohort mass moving through the carrier side towards the query denominator `X`. They produce the strict denominator prefix `X_obs(τ)` and the carrier frontier occupancy ledger.

Third, empirical subject traces from the strict evidence pass. These describe observed selected-Cohort mass moving through the subject span from `X` towards the subject end. They produce the strict numerator prefix `Y_obs(τ)` and the subject frontier occupancy ledger.

Fourth, conditioned primitive operator families. The conditioned model surface uses the epistemic operator basis. The FC continuation uses the predictive operator basis. Both bases come from the same already-conditioned primitives; primitive conditioning does not move and does not run again.

Fifth, role-labelled topology metadata from the composed carrier and subject spans. The continuation stage must know whether a ledger entry belongs to the carrier side or the subject side, which node it sits at, which source bucket it came from, and which concrete edge or edges consume it next. It must not infer those facts from row names or chart fields.

The model-var data needed for the two bases already exists. The source layer carries:

- probability epistemic shape: `alpha`, `beta`;
- probability predictive shape: `alpha_pred`, `beta_pred`;
- cohort-mode probability counterparts: `cohort_alpha`, `cohort_beta`, `cohort_alpha_pred`, `cohort_beta_pred`;
- latency epistemic dispersion: `mu_sd` and path-level `path_mu_sd`;
- latency predictive dispersion: `mu_sd_pred` and path-level `path_mu_sd_pred` when fitted.

`model_resolver.ResolvedModelParams` already exposes `alpha`, `beta`, `alpha_pred`, `beta_pred`, and `ResolvedLatency.mu_sd` / `mu_sd_pred`. The existing `make_unconditioned_primitive(..., dispersion_basis='epistemic'|'predictive')` path proves the operator-supply pattern: choose `alpha/beta` plus `mu_sd` for epistemic, or `alpha_pred/beta_pred` plus `mu_sd_pred or mu_sd` for predictive. The frontier-conditioned implementation should reuse that basis-selection pattern for conditioned operator supply; it should not require new model-var fields.

### 5.2 Frontier State: What Must Be Built

For each selected Cohort, take its frontier age `f = tau_observed`.

The frontier state has two parts.

The first part is the fixed terminal prefix:

- `X_obs(τ)` for `τ <= f`;
- `Y_obs(τ)` for `τ <= f`;
- `X_obs(f)` and `Y_obs(f)`, the fixed terminal values at the frontier.

The second part is the unresolved occupancy ledger:

- `L_carrier_f(node, arrival_bucket)`: selected-Cohort mass physically sitting on the carrier side at frontier `f`, not yet at the query denominator `X`;
- `L_subject_f(node, arrival_bucket)`: selected-Cohort mass physically sitting on the subject side at frontier `f`, not yet at the subject end.

This ledger is not an edge-local remainder. It is a frontier occupancy state over the role-labelled topology. It excludes the terminal node for the role:

- carrier occupancy excludes the query denominator terminal `X`;
- subject occupancy excludes the subject-end terminal.

Terminal mass is already part of the fixed prefix (`X_obs(f)` / `Y_obs(f)`) and must not also appear in unresolved occupancy. Including terminal mass in the frontier ledger would double-count already-resolved denominator or numerator mass during continuation.

For a non-terminal node/source bucket, occupancy means:

`occupancy at node U, arrival bucket u = empirical mass that arrived at U in bucket u by f - cumulative empirical departures from U's on-path outgoing transitions from that same bucket by f`.

If the current empirical trace does not expose arrivals and departures by source bucket, it must be widened at the spine boundary. The row projector must not try to reconstruct occupancy from `evidence_x`, `evidence_y`, or rates.

For active cohort cases, `L_carrier_f` represents selected root/carrier mass not yet observed at `X` by `f`. For identity-carrier and window-shaped cases, the carrier occupancy naturally vanishes because the only carrier terminal is `X`, and terminal nodes are excluded from the unresolved carrier ledger.

For the subject side, `L_subject_f` may contain mass at `X` or at intermediate subject nodes. This is why a scalar remainder such as `X_obs(f) - Y_obs(f)` is not enough for multi-hop subjects.

The frontier state is valid only if all occupancies are non-negative within numerical tolerance and if terminal prefixes match the terminal empirical traces. Negative occupancy is not repaired by clipping; it is a ledger inconsistency.

Conservation checks are mandatory:

- carrier side: `X_obs(f) + Σ L_carrier_f(nonterminal nodes, buckets)` must equal selected carrier mass accounted for by the carrier trace at frontier, within numerical tolerance;
- subject side: `Y_obs(f) + Σ L_subject_f(nonterminal nodes, buckets)` must equal selected subject-side mass accounted for by the subject trace at frontier, within numerical tolerance.

These checks are the algebraic guard against terminal double-counting.

### 5.3 Residual Predictive Operator

For each predictive draw `s`, each role-labelled node `U`, each outgoing transition `e` from `U`, each node-arrival bucket `u`, and each Cohort frontier `f`, define a cumulative predictive crossing surface:

`Q_s,e(u, τ) = fraction of mass in source bucket u that has crossed transition e by row age τ`.

For subject-side transitions, `Q_s,e(u, τ)` must respect local subject exposure: a source bucket `u` reaches later row ages with exposure determined by `τ - u` under the same bucket convention used by the existing span machinery. For carrier-side transitions, `Q_s,e(u, τ)` remains on the carrier's selected-Cohort clock. The operator is role-labelled; clocks are not interchangeable.

The residual denominator is node-level, not edge-local. First define the cumulative fraction of bucket `u` that has left node `U` through any on-path outgoing transition by row age `τ`:

`H_s,U(u, τ) = Σ_{e outgoing from U} Q_s,e(u, τ)`.

For mass that is known to still occupy node `U` at frontier `f`, the residual predictive crossing fraction through a particular outgoing transition `e` by age `τ > f` is:

`B_s,e(u, f, τ) = [Q_s,e(u, τ) - Q_s,e(u, f)] / [1 - H_s,U(u, f)]`.

For an unresolved occupancy amount `L_f(e.source, u)`, the future mass crossing that transition by `τ` is:

`Future_s,e(u, f, τ) = L_f(e.source, u) * B_s,e(u, f, τ)`.

This is the residual operator. It must be supplied to a DP as an operator, not applied as a row-level subtraction after a full model projection has already been produced. In a single-outgoing-edge chain, `H_s,U == Q_s,e` and this reduces to the simpler one-edge survival fraction. At branch/sibling nodes, the denominator remains the node survivor mass after all outgoing completions, which prevents double-counting or over-normalising individual edge continuations.

Boundary rules:

- at `τ = f`, `B_s,e` is zero, so the continuation contributes no extra mass at the frontier;
- if `H_s,U(u, f)` is one, there is no unresolved node occupancy that can validly cross later through any outgoing edge from that state; the matching occupancy should be zero;
- if denominator terms in the residual fraction are invalid, the operator should emit an invalid state visibly rather than silently substituting zero.

### 5.4 Frontier-Continuation DP

The continuation DP consumes `L_carrier_f`, `L_subject_f`, and the residual predictive operators.

For each selected Cohort and predictive draw:

First, initialise the frontier-conditioned row with the fixed empirical prefix. For every `τ <= f`, set denominator and numerator draws to the strict empirical prefix. The fan is therefore zero-width or absent through the observed prefix by construction.

Second, continue the carrier side. Propagate `L_carrier_f` through the carrier residual predictive operators. The output is future denominator arrival at `X` after frontier. Add that future denominator mass to `X_obs(f)` for `τ > f`.

Third, continue the subject side from two sources:

- the subject frontier occupancy ledger `L_subject_f`, propagated through subject residual predictive operators;
- future arrivals at `X` produced by the carrier continuation, propagated through ordinary predictive subject operators from their future source buckets.

The first source handles selected-Cohort mass already somewhere on the subject span at the frontier. The second source handles selected-Cohort mass that reaches `X` only after the frontier and then begins subject progression.

For future `X` arrivals, "ordinary predictive subject operators" means predictive subject kernels seeded at the future `X` arrival bucket. These arrivals were not present at the observation frontier, so they must not use the residual operator conditioned on not having crossed the subject span by `f`. Their subject clock starts when they arrive at `X`, exactly as the existing carrier-to-subject handoff pattern already does.

This handoff is expected to be low risk because the current spine already evaluates the subject span by using carrier output at `X` as the subject root seed. The frontier-conditioned path changes the carrier output's origin (future continuation from the frontier) but not the algebraic handoff: future denominator arrivals become source-bucket mass for the subject span.

All three continuation inputs should exist for every request as data:

- carrier frontier ledger;
- subject frontier ledger;
- future-`X` arrival ledger.

Some of these ledgers may be empty, and some operators may be identity/Dirac. That is the degeneration. The continuation code should not branch on query mode, carrier identity, or hop count. It should pass the available ledgers through the same ledger-plus-operator machinery and let empty sums, identity ledgers, zero-edge spans, and Dirac kernels produce the degenerate result.

Per-Cohort frontiers are independent. Build each Cohort's frontier ledgers using that Cohort's own `tau_observed`; never use group-level `tau_solid_max` to construct `L_carrier_f` or `L_subject_f`. Aggregate across Cohorts only after each Cohort's continuation has been projected.

Fourth, aggregate mass-first. For each draw and row age:

- `X_draw(τ) = X_obs(τ)` for `τ <= f`;
- `X_draw(τ) = X_obs(f) + future_X_draw(τ)` for `τ > f`;
- `Y_draw(τ) = Y_obs(τ)` for `τ <= f`;
- `Y_draw(τ) = Y_obs(f) + future_Y_draw(τ)` for `τ > f`;
- `rate_draw(τ) = Y_draw(τ) / X_draw(τ)`.

For multi-Cohort chart rows, sum denominators and numerators across selected Cohorts first, then divide once. Do not average per-Cohort rates.

This DP is the only owner of the FC draw surface.

Important consequences:

- At `τ = f`, every draw equals the strict observed prefix.
- As `τ` grows, predictive residual operators move unresolved frontier occupancy into future terminal mass, so the fan opens only after the frontier.
- At saturation, the continuation tends towards the predictive completion of the unresolved frontier ledger, not towards a replay of the full root projection.

### 5.5 Draws and Simulation

This change requires a new draw-indexed FC surface. It does not require new posterior conditioning, new MCMC, or individual-level user simulation.

The draw families already exist at the primitive layer. The new work is to run a deterministic continuation DP over the predictive draw-indexed operators, starting from empirical frontier occupancy ledgers instead of starting from selected root mass at age zero.

Each row draw is a coherent predictive continuation draw. The same draw index must be used consistently across carrier and subject operators. No row should independently sample a fresh random path and no primitive should be re-conditioned during continuation.

The conditioned model surface is a separate draw surface over the epistemic operator basis. It asks how uncertain the model curve is. The FC surface asks where this actual partially observed Cohort can still land, so it uses the predictive operator basis.

### 5.6 Risk Dimensioning After Code Review

The main risk is frontier occupancy construction. Current DP traces retain per-node densities and per-edge contributions, but the public trace arrays collapse source-bucket contributions into absolute row-age columns. A correct `L_f(role, node, source_bucket)` may therefore require widening the empirical trace or adding a frontier-ledger-producing DP variant. It must not be reconstructed from terminal row totals.

Residual operator clocking is lower risk. The existing span machinery already supplies kernels through provider functions that receive `source_index`; `EvidenceReadoutBinding` and the conditioned/empirical span evaluators already distinguish cohort and window lookup conventions. The new residual operator should plug into the same provider seam, with role-labelled carrier versus subject clock interpretation.

The future-`X` to subject handoff is also lower risk. Existing selected-Cohort projection already runs carrier output into subject root seed. The new continuation path should preserve source-bucket identity at that handoff, but the conceptual and code pattern is already present.

Epistemic versus predictive data availability is not a model-var risk. The fields exist and are already carried through TS types, Bayes patch projection, `modelVarsResolution`, and `model_resolver`. The remaining risk is API/plumbing: conditioned operator construction currently materialises one draw family for the primitive's posterior surface, while the proposed chart surfaces need basis-labelled conditioned operator supplies (`epistemic` for the conditioned model surface, `predictive` for the FC surface). That should be solved by making the operator supply basis-aware, not by adding new model-var fields or moving primitive conditioning.

## 6. Proposed Spine Sequence

`model_span_spine.project_selected_cohort_rows` should become a three-surface projection.

The logical order inside the spine is evidence first, then model surfaces.
This ordering is load-bearing: the FC surface is defined
by actual observed prefix state, so the empirical pass must produce strict
evidence rows and per-Cohort frontier states before any model continuation
surface is assembled.

The spine sequence is:

1. Run the empirical path. It produces strict evidence rows and the
   per-Cohort frontier states.
2. Run the full query-conditioned model path. It produces the chart-facing
   conditioned model surface with epistemic dispersion.
3. Run the frontier-conditioned continuation path. It consumes the frontier
   states plus predictive conditioned operators and produces the FC surface.

The returned projection object should distinguish these surfaces explicitly. It should no longer force `rate_draws_model` to mean both "model-only selected query surface" and "evidence-plus-forecast curve".

## 7. Proposed Row Mapping

The row projector should become mostly a mapper, not a semantic reducer.

Suggested ownership:

- `rate`, `evidence_x`, `evidence_y`: strict empirical evidence surface.
- Conditioned model surface fields (`f_*`): epistemic bands; F mode renders these fields.
- Forecast-layer row fields (`midpoint`, `fan_*`, `fan_bands`, `projected_rate`): FC surface, predictive bands; in E+F mode these replace the current post-frontier conditioned model curve/bands.
- `forecast_x`, `forecast_y`: residual future mass produced directly by the frontier-conditioned continuation, not by subtracting evidence from full model means.
- optional model overlay fields: unconditioned model curve with epistemic bands. Existing old F tests can be retained against this explicit overlay surface.

The current unconditioned overlay fields should not be the default F mode curve. They can remain as an optional model overlay if the UI and tests name them that way.

At output/rendering time, E+F mode shows strict evidence at all points before epoch C (epochs A/B), and shows the FC forecast layer at all points after epoch A (epochs B/C). Epoch B is therefore the overlap region where evidence coverage dwindles while the FC forecast layer is already visible. Epoch C has no evidence layer because those outcomes have not happened yet; only the forecast layer remains. This output gating is separate from generation: the spine still generates `ef_*` across the full tau sweep so prefix-pinning, continuity, and fan-opening can be tested directly.

## 8. Containment

This should be a fairly contained output-path change, but it is not only resequencing.

Likely touched areas:

- `model_span_spine.py`: primary owner. It should derive frontier states, keep full query-conditioned model projection, and add frontier-conditioned continuation projection.
- `subject_span_composer.py` / operator supply helpers: add a continuation/residual operator adapter over the existing conditioned kernels.
- `cohort_forecast_v3.py`: row mapping only. It should map explicit surfaces returned by the spine and remove the late evidence-subtraction logic.
- chart builder: map F mode to the conditioned model surface and E+F mode's forecast layer to the FC surface.

Not expected:

- no request-envelope rewrite;
- no primitive-conditioning rewrite unless the continuation path needs additional per-primitive draw surfaces not currently exposed;
- no central branch on `window` versus `cohort`, identity carrier, or hop count.

The design should stay algebraic in the surfaces that create meaning:
empirical frontier states and model continuation operators are data flowing
through the same span machinery. This is essential in the schematic/runtime
phases (`SpanDPTrace`, frontier occupancy, basis-labelled operator supply,
residual kernels, and frontier-continuation DP).

The output layer is different. Row projection and chart rendering may apply
explicit display policy: E mode versus F mode versus E+F mode, epoch A/B/C
visibility, optional overlay toggles, and tooltip/copy choices. It is still
preferable to keep this clean and table-driven, but algebraic degeneracy is
least important here because the output layer should only select already
computed surfaces. It must not reconstruct carrier, subject, frontier,
denominator, numerator, or residual semantics.

## 9. Concrete Implementation Plan

This section describes the mechanical capabilities the implementation needs.
It is not the rollout order. The rollout order is §10 and is deliberately
staged around the outside-in oracle staying green after every atom.

### 9.1 Extend `SpanDPTrace`

Extend `runner.timing_span.SpanDPTrace` so the source-bucket-aware ledger is canonical. Do **not** store both full and collapsed arrays as independent fields.

Canonical stored fields:

- `node_density_by_node_bucket[node][arrival_bucket] -> ndarray(S_flat, T)`;
- `edge_contribution_by_edge_source[edge_key][source_bucket] -> ndarray(S_flat, T)`.

Add central sum helpers for the old collapsed shape:

- `node_density(node) -> ndarray(S_flat, T)`;
- `edge_contribution(edge_key) -> ndarray(S_flat, T)`.

These helpers are just the sum over the source-bucket dimension:

- `node_density_by_node[node] = Σ_arrival_bucket node_density_by_node_bucket[node][arrival_bucket]`;
- `edge_contribution_by_edge[edge_key] = Σ_source_bucket edge_contribution_by_edge_source[edge_key][source_bucket]`.

If represented as sparse dictionaries, the helper sums the populated bucket arrays. If represented densely in a future optimisation, the helper is `sum(axis=source_bucket_axis)`. Do not let consumers hand-roll this sum.

### 9.2 Populate Source-Bucket Ledgers in the Existing DP

Modify `_run_dp_density_trace_from_seed` where it already loops over `source_index`.

For each concrete edge and each source bucket:

1. build `source_contribution` for that `(edge, source_index)`;
2. add it into the existing collapsed `contribution`;
3. store it in `edge_contribution_by_edge_source[edge_key][source_index]`;
4. split the contribution by destination row-age column and store destination node arrivals by **destination arrival bucket**, not by the edge's source bucket.

Step 4 is load-bearing. In the current DP, `source_index` is the arrival column at the current source node. If an edge with delay moves mass from source bucket `0` to destination bucket `5`, that mass must be stored on the destination node under bucket `5`, not bucket `0`. Otherwise the next subject continuation will use the wrong local exposure clock.

Mechanical rule:

- `edge_contribution_by_edge_source[edge_key][source_index]` is keyed by the edge's source-node bucket;
- `node_density_by_node_bucket[to_node][dest_bucket]` is keyed by the destination node's arrival bucket, i.e. the output column receiving the contribution.

Seed the root as source bucket `0`:

- `node_density_by_node_bucket[topology_root][0] = root_density`.

This is mostly extra storage, not a new traversal. The DP already computes each source bucket's contribution inside the existing loop.

Use sparse dictionaries keyed by populated source bucket rather than dense four-dimensional arrays. Dense storage risks unnecessary memory growth.

Update every `SpanDPTrace(...)` constructor to provide only source-aware ledgers. Empty/no-topology cases use the same convention: root/end source bucket `0` carries the supplied root density, and edge source maps are empty.

### 9.2a Trace Consumer Migration

Migrate every direct consumer of collapsed trace fields. This table is an
implementation checklist, not a sketch: every row must be addressed before
Atom 3 closes.

| Checklist item | Current read / write | Required migration |
|---|---|---|
| `timing_span.py` `_run_dp_density_grid` | `trace.node_density_by_node[topo.y_node_id][0]` | Use `trace.node_density(topo.y_node_id)[0]`. |
| `timing_span.py` `compose_terminal_node_density_per_draw` | returns `trace.node_density_by_node[topo.y_node_id]` | Return `trace.node_density(topo.y_node_id)`. |
| `subject_span_composer.py` `_compose_draws` node ledger copy | copies `trace_value.node_density_by_node` into `ComposedPrimitiveSpan.node_density_draws` | Store source-aware trace ledgers on `ComposedPrimitiveSpan`; expose collapsed helper only. |
| `subject_span_composer.py` `_compose_draws` edge ledger copy | copies `trace_value.edge_contribution_by_edge` into `ComposedPrimitiveSpan.edge_contribution_draws` | Store source-aware edge ledgers; expose collapsed helper only. |
| `subject_span_composer.py` `_compose_draws` terminal density | reads `trace_value.node_density_by_node[topo.y_node_id]` | Use `trace_value.node_density(topo.y_node_id)`. |
| `empirical_evidence_operator.py` `compose_empirical_span` node ledger | updates `node_density_draws` from `trace_value.node_density_by_node` | Store source-aware ledgers on empirical `ComposedPrimitiveSpan`. |
| `empirical_evidence_operator.py` `compose_empirical_span` edge ledger | updates `edge_contribution_draws` from `trace_value.edge_contribution_by_edge` | Store source-aware edge ledgers on empirical `ComposedPrimitiveSpan`. |
| `empirical_evidence_operator.py` `compose_empirical_span` terminal density | reads `trace_value.node_density_by_node[topo.y_node_id]` | Use `trace_value.node_density(topo.y_node_id)`. |
| `empirical_evidence_operator.py` `_run_empirical_lookup_bound_trace` | constructs `SpanDPTrace(node_density_by_node=..., edge_contribution_by_edge=...)` | Construct source-aware ledgers only, with populated source buckets from the loop. |
| `model_span_spine.py` `_summarise_density_trace` node diagnostics | iterates `trace.node_density_by_node.items()` | Iterate source-aware ledgers for diagnostics or call collapsed helper per node. |
| `model_span_spine.py` `_summarise_density_trace` edge diagnostics | iterates `trace.edge_contribution_by_edge.items()` | Iterate source-aware ledgers for diagnostics or call collapsed helper per edge. |
| `model_span_spine.py` `project_selected_cohort_rows` carrier terminal | reads `x_value_trace.node_density_by_node[composed_carrier.end_node_id]` | Use `x_value_trace.node_density(composed_carrier.end_node_id)`. |
| `model_span_spine.py` `project_selected_cohort_rows` subject terminal | reads `y_value_trace.node_density_by_node[composed_subject.end_node_id]` | Use `y_value_trace.node_density(composed_subject.end_node_id)`. |
| `model_span_spine.py` empirical terminal reads | reads `emp_x_trace.node_density_by_node[...]` / `emp_y_trace.node_density_by_node[...]` | Use `emp_x_trace.node_density(...)` / `emp_y_trace.node_density(...)`; frontier helper reads source-aware ledgers. |

Focused test checklist:

| Test surface | Current assertion | Required migration |
|---|---|---|
| `test_span_kernel.py` node density assertions | direct `trace.node_density_by_node[...]` | Use `trace.node_density(...)`; add source-sum identity assertion. |
| `test_span_kernel.py` edge contribution assertions | direct `trace.edge_contribution_by_edge[...]` | Use `trace.edge_contribution(...)`; add source-sum identity assertion. |
| `test_subject_span_composer.py` flat-origin tests | direct `trace.node_density_by_node[...]` | Use `trace.node_density(...)`. |
| `test_empirical_evidence_operator.py` flat-origin tests | direct `trace.node_density_by_node[...]` | Use `trace.node_density(...)`. |

### 9.3 Derive Frontier Occupancy in the Spine

Add a helper in `model_span_spine.py`, conceptually:

`build_frontier_occupancy(trace, topology, frontier_by_cohort, cohort_count, draw_count)`.

For each role, node, source bucket, Cohort, and draw:

`occupancy_f(node, source_bucket) = cumulative arrivals at node/source_bucket by f - cumulative departures from node/source_bucket by f`.

Arrivals come from `trace.node_density_by_node_bucket[node][arrival_bucket]`.

Departures are the sum of `trace.edge_contribution_by_edge_source[out_edge][arrival_bucket]` over on-path outgoing concrete edges from that node. Here `arrival_bucket` is the bucket at which the mass is sitting at the source node of those outgoing edges; for the outgoing edge it is therefore the edge source bucket.

The helper returns:

- `L_carrier_f(node, source_bucket) -> ndarray(cohort, draw)` for carrier continuation;
- `L_subject_f(node, source_bucket) -> ndarray(cohort, draw)` for subject continuation;
- strict terminal prefixes `X_obs(τ)` / `Y_obs(τ)` are kept separately for row output.

Never derive frontier occupancy from `evidence_x`, `evidence_y`, `rate`, or terminal cumulative rows. Those are projections, not state.

### 9.3a `ComposedPrimitiveSpan` Ledger Migration

Make source-aware ledgers canonical on `ComposedPrimitiveSpan` too, with
collapsed helper accessors mirroring `SpanDPTrace`. Existing consumers keep
their old semantics by reading the collapsed helper, not by owning duplicate
collapsed arrays.

This table is an implementation checklist; every row must be addressed.

| Checklist item | Current read / write | Required migration |
|---|---|---|
| Canonical node ledger | `node_density_draws[node] -> ndarray(S, T)` | `node_density_by_source(node) -> Mapping[source_bucket, ndarray(S, T)]`. |
| Canonical edge ledger | `edge_contribution_draws[edge] -> ndarray(S, T)` | `edge_contribution_by_source(edge) -> Mapping[source_bucket, ndarray(S, T)]`. |
| Collapsed reads | direct `node_density_draws[...]` / `edge_contribution_draws[...]` | `node_density(node)` / `edge_contribution(edge)` helper reads. |
| Identity span | collapsed root density on the node | source bucket `0` root ledger; edge source map empty. |
| `model_span_spine.py` `read_node_mass_draws` | returns `span.node_density_draws[node_id]` | Return `span.node_density(node_id)`. |
| `model_span_spine.py` `read_edge_contribution_draws` | returns `span.edge_contribution_draws[edge_key]` | Return `span.edge_contribution(edge_key)`. |
| `model_span_spine.py` `_span_terminal_is_instant` comment | references `span.node_density_draws[...]` | Update if restored; otherwise keep comment non-authoritative. |
| `subject_span_composer.py` `ComposedPrimitiveSpan.identity` | stores `node_density_draws={x_node_id: root_density}` and `edge_contribution_draws={}` | Store source-aware root ledger `{x_node_id: {0: root_density}}`; edge source map empty. |
| `subject_span_composer.py` `_compose_draws` | passes collapsed ledgers into `ComposedPrimitiveSpan` | Pass source-aware ledgers; collapsed helpers compute legacy view. |
| `empirical_evidence_operator.py` `compose_empirical_span` | passes collapsed ledgers into `ComposedPrimitiveSpan` | Pass source-aware ledgers; collapsed helpers compute legacy view. |

Focused test checklist:

| Test surface | Current assertion | Required migration |
|---|---|---|
| `test_subject_span_composer.py` | reads `composed.node_density_draws[...]` / `composed.edge_contribution_draws[...]` | Use `composed.node_density(...)` / `composed.edge_contribution(...)`; add source-ledger assertions for identity and siblings. |
| `test_empirical_evidence_operator.py` | reads `span.node_density_draws[...]` | Use `span.node_density(...)`; add source-sum identity tests. |
| `test_model_span_spine_selected_cohort.py` | reads `composed_* .node_density_draws[...]` for arrival-map and carrier/subject invariants | Use `node_density(...)` for existing invariants; add frontier-occupancy tests using source-aware ledgers. |

### 9.4 Build Basis-Aware Conditioned Operator Supplies

Do not add model-var fields. The required data already exists and is resolved:

- epistemic probability: `alpha`, `beta`;
- predictive probability: `alpha_pred`, `beta_pred`;
- epistemic timing: `mu_sd` / `path_mu_sd`;
- predictive timing: `mu_sd_pred` / `path_mu_sd_pred` when present, falling back to epistemic when absent.

Add a basis parameter at the conditioned operator supply/composer boundary:

- `basis='epistemic'` for the conditioned model surface;
- `basis='predictive'` for the FC surface.

Use the same selection pattern already present in `make_unconditioned_primitive(..., dispersion_basis='epistemic'|'predictive')`, but apply it to conditioned runtime primitives.

The current `ConditionedTransitionPrimitive` contract exposes one probability draw family and one timing draw family. Do not make callers infer a second basis from that single surface. The mechanical implementation should create **basis-labelled conditioned primitive objects** at runtime:

- one conditioned primitive map for `basis='epistemic'`;
- one conditioned primitive map for `basis='predictive'`.

Both maps consume the same bound evidence resolution and the same conditioning function. The basis selects the prior/proposal moment family used by conditioning and timing-particle construction:

- epistemic: `alpha/beta` and `mu_sd` / `path_mu_sd`;
- predictive: `alpha_pred/beta_pred` and `mu_sd_pred or mu_sd` / `path_mu_sd_pred or path_mu_sd`.

Cache identity, primitive provenance, and draw-family identity must include `basis` or an equivalent scope discriminator. Current `DrawFamilyKey` semantics say matching keys imply matching draw indices. Basis-labelled conditioned primitives with the same transition and evidence scope but different posterior surfaces must therefore not share an identical draw-family key unless the key also encodes the basis. This prevents epistemic and predictive conditioned surfaces from colliding in the primitive cache or falsely claiming draw-index coherence across different distributions, while preserving the single conditioning locus: all evidence-to-posterior updates still occur inside `primitive_conditioning.condition_primitive`.

Do not grow a second hidden draw family on `ConditionedTransitionPrimitive` without changing the contract. If a future implementation chooses multi-basis primitives instead of two basis-labelled primitive objects, the dataclass and cache identity must make those basis surfaces explicit. The first implementation should prefer basis-labelled primitive objects because it keeps the existing single-surface primitive contract intact.

### 9.5 Add Residual Predictive Kernel Provider

Add a residual provider at the same seam where existing span evaluators already receive `(edge, source_index, cohort_index)`.

For a transition `e`, source bucket `u`, Cohort frontier `f`, and predictive draw `s`:

`H_s,U(u, τ) = Σ_{e outgoing from U} Q_s,e(u, τ)`.

`B_s,e(u, f, τ) = [Q_s,e(u, τ) - Q_s,e(u, f)] / [1 - H_s,U(u, f)]`.

The provider returns the increment kernel derived from `B`, not the cumulative array itself.

This must match §5.3 exactly. The denominator is the node survivor mass after all on-path outgoing transitions from `U`, not the survivor mass for edge `e` alone. At single-outgoing nodes `H_s,U == Q_s,e`, so the formula naturally degenerates to the one-edge residual. At branch/sibling nodes the node-level denominator is load-bearing; using `1 - Q_s,e(u, f)` would over-normalise each outgoing residual and can allocate more future mass than the frontier occupancy owns.

Carrier-side `Q` is evaluated on the carrier selected-Cohort clock.

Subject-side `Q` is evaluated with source-bucket/local subject exposure under the same bucket convention used by the existing span machinery.

If future `X` arrivals are produced by carrier continuation, they are not frontier survivors on the subject side. Feed them into ordinary predictive subject kernels from their future source bucket, not the residual subject kernels conditioned on the original frontier.

### 9.6 Add DP From Frontier Ledgers

Add a DP helper that accepts initial node/source ledgers instead of only a root seed, conceptually:

`run_dp_from_node_source_ledgers(topology, initial_ledgers, kernel_provider, cohort_count, draw_count, horizon)`.

It should:

1. initialise node/source-bucket density from `L_carrier_f` or `L_subject_f`;
2. propagate through the same topological edge loop;
3. emit terminal future density and source-aware trace using the same `SpanDPTrace` shape.

Use it twice:

- carrier continuation: `L_carrier_f` through residual predictive carrier operators -> future denominator arrivals at `X`;
- subject continuation: `L_subject_f` through residual predictive subject operators -> future numerator arrivals at the subject end.

Then feed future `X` arrivals from carrier continuation into the subject span with ordinary predictive subject operators from those future source buckets.

This is a fixed sequence, not a mode switch:

1. run carrier-continuation DP over the carrier frontier ledger;
2. run subject-continuation DP over the subject frontier ledger;
3. run ordinary subject DP over the future-`X` arrival ledger emitted by step 1;
4. add the two subject outputs and the carrier output into the frontier-conditioned row surface.

In identity/window-shaped cases the carrier frontier ledger or future-`X` ledger is empty/identity, so steps naturally contribute zero or the identity result. In single-hop cases the subject topology has one edge. In multi-hop cases it has more edges. In non-latent cases the predictive kernel is Dirac. No central branch should select among these cases.

### 9.7 Split Projection Surfaces

Change `SelectedCohortRowProjection` so it no longer overloads `rate_draws_model`.

It should expose at least:

- strict evidence: `evidence_x_strict`, `evidence_y_strict`, `rate_strict`;
- Conditioned model surface: `f_x_draws`, `f_y_draws`, `f_rate_draws`;
- FC surface: `ef_x_draws`, `ef_y_draws`, `ef_rate_draws`;
- FC future residuals: `ef_forecast_x`, `ef_forecast_y`.

`f_*` uses epistemic basis and full-root projection.

`ef_*` uses predictive basis and frontier-continuation projection.

### 9.8 Update Row and Chart Mapping

In `cohort_forecast_v3._project_runtime_rows`:

- `rate`, `evidence_x`, `evidence_y` read strict empirical evidence;
- F mode reads the conditioned model surface (`f_*`);
- `midpoint`, `fan_*`, `fan_bands`, `projected_rate` read `ef_*`;
- `forecast_x`, `forecast_y` read `ef_forecast_x` / `ef_forecast_y`.

Delete the post-hoc subtraction of evidence from full model means. The frontier-conditioned DP should directly emit future residual mass.

In the chart builder:

- F mode reads the conditioned model surface;
- E+F mode keeps strict evidence visible in epochs A/B, reads the FC forecast layer in epochs B/C, and shows only the forecast layer in epoch C;
- the current unconditioned overlay is retained only as an optional model overlay if still useful; it is not the default F mode curve.
- the rendered FC forecast layer is suppressed in epoch A only. The spine still emits `ef_*` for every tau. The observed prefix belongs to strict evidence; `ef_*` remains pinned internally for algebraic continuity.

### 9.9 Test Order

Test the change in this order:

1. `SpanDPTrace` source-bucket identity tests: collapsed fields equal source-bucket sums.
2. Frontier occupancy unit tests: simple chain, branch/merge, identity carrier, and multi-hop subject occupancy at a known frontier.
   Include terminal-exclusion and conservation tests: `X` is not in `L_carrier_f`, subject end is not in `L_subject_f`, and fixed terminal prefix plus unresolved nonterminal occupancy equals the role's frontier trace mass.
3. Residual kernel tests: `B(f)=0`, monotone future, saturation, role-clock correctness. Include an explicit branch/sibling test where one node has multiple on-path outgoing transitions. The test must assert that the sum of all future outgoing residual flows from that node is no greater than that node's unresolved frontier occupancy for every draw and row age. This catches the forbidden edge-local denominator `1 - Q_s,e(u, f)`; the correct denominator is node-level `1 - H_s,U(u, f)`.
4. Frontier-continuation DP tests: observed prefix fixed, fan opens after frontier, future `X` arrivals feed ordinary subject kernels.
5. Spine projection tests: the conditioned model surface and the FC surface are distinct surfaces with epistemic versus predictive bases.
6. Outside-in chart tests: single Cohort frontier pinning, multi-Cohort mass-first aggregation, active cohort denominator/numerator semantics, and display-mode mapping.

Do not start by changing outside-in tolerances. The first proof must be the source-aware trace and frontier-ledger algebra.

### 9.10 No-Branching Contract

This contract applies to the meaning-producing stages: source-aware traces,
frontier occupancy, basis-labelled operator supply, residual kernels,
frontier-continuation DP, and mass-first projection. These stages must not
introduce central branches on:

- `window` versus `cohort`;
- identity carrier versus active carrier;
- single-hop versus multi-hop;
- latent versus non-latent;
- one selected Cohort versus many selected Cohorts.

Those cases must enter as data:

- empty or populated carrier ledgers;
- identity or non-identity topology;
- one-edge or multi-edge subject topology;
- Dirac or spread timing kernels;
- one-row or many-row Cohort axes.

The same source-ledger DP, residual-kernel provider, and mass-first row aggregation must run for every case. A branch that only validates perimeter shape or chooses a documented operator basis (`epistemic` for the conditioned model surface, `predictive` for the FC surface) is acceptable. A branch that changes the mathematical row path by query mode or hop count is not.

The output layer is exempt from this no-branching rule only to the extent
that it implements display policy over already-computed surfaces. It may
branch or table-dispatch on display mode and epoch visibility, for example
E mode versus F mode versus E+F mode, evidence layer absent in epoch C, and
FC forecast layer hidden in epoch A. It must not perform mathematical
fallbacks, recompute evidence, rebuild residuals, or infer semantics from
row totals.

## 10. Outside-In-Preserving Build Atoms

The implementation should proceed in small semantic atoms. Each atom must
leave the outside-in oracle green. Do not combine atoms just because the
underlying capability work is adjacent; the whole point is to avoid another
single high-risk cutover.

Do not over-split either. Each atom has execution cost: context gets lost,
agents drift, and invariants get reinterpreted. Split only at proof
boundaries where an atom can preserve outside-in while proving a distinct
capability.

### Atom 0: Baseline And Test Ledger

Before code work: `/photocopy frontier-conditioned-surface-start`. Do not
commit the current state; keep commits for coherent green checkpoints.

Capture the current outside-in result and list every failing non-outside-in
test that is relevant to this proposal. Classify each as one of:

- contract-stale and expected to change with a named atom below;
- high-signal regression that must be green before continuing;
- unrelated to frontier-conditioned chart semantics.

Stop conditions:

- outside-in is not green at baseline;
- a high-signal regression is left unowned;
- a future atom plans to weaken outside-in tolerances.

### Atom 1: Split The Current Hybrid And Make F Mode Mean Conditioned Model

Expose a clean, unspliced conditioned model surface, then make F mode read
it instead of the unconditioned overlay. E+F mode remains unchanged.

Expected code scope:

- `SelectedCohortRowProjection` grows `f_x_draws`, `f_y_draws`,
  `f_rate_draws`;
- current spliced arrays remain available for E+F mode;
- row-field or chart-builder mapping for F mode;
- tests that explicitly asserted the old unconditioned F meaning migrate to the named optional model-overlay surface where that behaviour remains useful;
- provenance/copy naming so the new F mode contract is visible.

Acceptance:

- outside-in remains green after any necessary test edits;
- the edited tests assert the new F mode meaning directly;
- focused backend tests prove `f_*` is unspliced and current E+F output still
  reads the spliced arrays;
- old F tests that still protect the unconditioned model curve assert optional model-overlay semantics rather than F mode semantics;
- E mode, E+F mode, `midpoint`, `fan_*`, `forecast_x`, and `forecast_y` remain mapped exactly as before.

### Atom 2: Make Dispersion Basis Explicit

Introduce the basis distinction without changing E+F mode:

- `basis='epistemic'` for the conditioned model surface that F mode renders;
- `basis='predictive'` reserved for the FC surface.

Implement §9.4 or a narrower equivalent that prevents cache/draw-family
collisions between bases.

Acceptance:

- outside-in remains green;
- focused tests prove epistemic and predictive basis identities differ when surfaces differ;
- no row field switches to the FC continuation yet.

### Atom 3: Source-Bucket Ledger Substrate

Migrate trace/span ledgers without changing chart outputs. FC needs
source-bucket ledgers so frontier occupancy can be derived from state rather
than terminal row totals.

Scope:

- §9.1 / §9.2: source-aware `SpanDPTrace`;
- §9.2a / §9.2b: migrate direct trace consumers and tests to collapsed
  helper accessors;
- §9.3a: source-aware `ComposedPrimitiveSpan` storage and helper accessors.

Do not implement:

- frontier occupancy;
- residual kernels;
- DP from frontier ledgers;
- shadow `ef_*` surfaces;
- row/chart mapping changes.

Acceptance:

- outside-in remains green;
- existing span/composer/empirical tests pass with only accessor migration changes;
- new tests prove collapsed helper output equals the sum over source buckets;
- identity spans use source bucket `0`;
- branch/sibling tests prove each edge source ledger sums to the same
  collapsed contribution as before.

### Atom 4a: Evidence-First Frontier State And Shadow FC

Status: in progress. Atom 4a owns the semantic FC shadow surface only.
Performance/vectorisation is a separate stage, Atom 4b. Atom 4a is not
complete until the frontier/continuation ledger carries the minimal
correct state `unresolved_mass[role][node][bucket][basis]` with no
provenance dimension and no proportional allocation.

Build the first FC surface in shadow, using Atom 3's source-bucket ledgers.
Keep frontier occupancy, residual kernels, DP from frontier ledgers, and
shadow `ef_*` together: they are one semantic proof unit.

The spine order becomes evidence first:

1. strict empirical path produces evidence rows and per-Cohort frontier
   states;
2. query-conditioned model path produces the conditioned model surface;
3. predictive continuation consumes the frontier states and emits shadow
   `ef_*` surfaces.

The shadow `ef_*` surfaces are diagnostic/output-adjacent only. They do not
populate `midpoint`, `fan_*`, `projected_rate`, `forecast_x`, or
`forecast_y` yet.

Scope:

- §9.3: frontier occupancy derived from empirical traces, never terminal row
  totals;
- §9.5: residual predictive kernel provider with node-level survivor
  denominator;
- §9.6: DP from frontier ledgers;
- shadow `ef_x_draws`, `ef_y_draws`, `ef_rate_draws`, `ef_forecast_x`,
  `ef_forecast_y`.

Acceptance:

- outside-in remains green because production chart fields are unchanged;
- conservation tests prove fixed terminal prefix plus unresolved occupancy equals role frontier mass;
- terminal nodes are excluded from unresolved occupancy;
- branch/sibling residual tests prove future outgoing residual flow cannot exceed unresolved frontier occupancy;
- shadow deltas versus the current E+F forecast layer are reported; large unexplained shape deltas block.

Close-out checks (mandatory; carried forward from Atom 3 lessons):

- **Branching principle (load-bearing).** Avoid branching whenever
  practically possible. **Guarding is costly and risky** — every branch
  is a code path that must be reasoned about, tested, and maintained;
  every guard is an admission that the design has two algebraic shapes
  for one operation. The default position is: no branching. The onus
  is on the coder to justify EVERY explicit or implicit branch of ANY
  kind — `if/else` on data shape, defensive `if x is None`, kernel/
  path selection by mode, back-compat fallbacks, "preserve the
  common-case key shape", try/except as control flow — and the
  justification bar is **compelling**, not plausible. A compelling
  justification names a specific real risk (with a concrete failure
  scenario — corrupt input from a named external source, a documented
  invariant the branch protects, an irreversible side effect the guard
  prevents) AND demonstrates that the risk cannot be eliminated by
  redesigning the data so the branch becomes degenerate. "Preserves
  existing behaviour", "avoids test churn", "common case", "defensive",
  "just in case", "for safety", "to be robust" are NOT compelling and
  are explicitly rejected. **Every retained branch must be explicitly
  surfaced in the stage's claimed acceptance** as a bullet:
  *"Retained branch at <file:line>: <one-sentence statement of branch>;
  risk: <named scenario>; cannot be made uniform because <reason>."*
  The acceptance is rejected if a branch exists in the stage's diff
  and is not surfaced this way, OR if a surfaced justification fails
  the compelling-bar test on review. Specifically call-out patterns
  that are PRESUMED non-compelling and require extraordinary
  justification to keep: `if N == 1`, `if single_X`, `if mode ==
  legacy`, "preserve the common case key shape", "fall back when the
  new path fails", `if x is None: x = default()` at internal seams.
- **Symmetry audit.** Every seam exists in pairs and the seam shape must
  match across the pair: carrier/subject, empirical/conditioned,
  latent/non-latent, root/non-root, single-edge/diamond. Closing the
  stage requires walking each pair explicitly and showing seam shape
  parity. Shape parity is NOT the same as parameter parity — each side's
  parameter values must be justified by that side's semantics
  (e.g. empirical carrier root_basis is `BUCKET_DISTRIBUTED` because
  observed mass is bucket-distributed; conditioned carrier root_basis is
  `POINT_AT_ENDPOINT` because a cohort anchor day is a calendar point).
  Don't copy parameters across a seam without re-justifying them.
- **Continuation tests.** Every per-X dimension Atom 4a introduces
  (frontier occupancy, residual kernel basis, FC source-bucket) needs at
  least one test that exercises ANOTHER hop downstream of the seam —
  not just at the seam itself. The bar: the test fails on an
  implementation that preserves X at storage but collapses it at the
  next read. Testing "the immediate provider sees both X" is necessary
  but insufficient.
- **Downstream-consumer grep on shape changes.** When a data shape
  changes (key format, value tuple shape, surface schema), grep for
  every caller of the old shape, list them in the close-out, and prove
  each is either migrated or safe by construction. No "I think nothing
  else reads this" without the grep.
- **Clean re-run gate.** "It passes" only counts after a final clean run
  with all debug/instrumentation removed from the working tree. No "it
  passed once the debug was cleaned out, ship it." If it flaps, dig
  until the root cause is named or admit the flap and don't claim
  resolution.
- **Refactor-equivalence rule.** Refactors that claim numerical
  equivalence to a prior implementation must prove it by EXECUTION —
  running both implementations on the same inputs and diffing the
  outputs. Self-comparison (new vs new) is worthless. If the old
  implementation isn't available to run, that fact must be stated
  openly; "I reasoned about the algebra and it should be equivalent" is
  not a substitute for measurement.

### Atom 4b: FC Shadow Performance Pass

Atom 4b is separate from Atom 4a. It does not change FC semantics or row
mapping. It makes the already-landed shadow surface cheap enough to keep on
the request path.

Scope:

- vectorise the residual provider across the Cohort axis;
- vectorise `run_dp_from_node_source_ledgers` across the Cohort axis where
  the current implementation loops per Cohort and calls `kernel_provider`
  repeatedly;
- eliminate per-Cohort `kernel_provider` calls in the three shadow
  continuation DPs;
- remove the provisional 60s CF timeout once the performance target is met
  and restore the 20s budget.

Acceptance:

- shadow surface assembly is under 1s on the synth-lat4 fixture
  (49 Cohorts × 1000 draws × horizon 115);
- outside-in passes with the CF timeout restored to 20s;
- Atom 4a semantic tests remain green unchanged;
- no production row fields remap to `ef_*` in this atom.

### Atom 4c: Consolidate Root-Seed And Frontier-Ledger DP Substrate

Atom 4c is a runtime substrate consolidation step. Atom 4b made the FC
shadow continuation cheap, but it did so by optimising the new
frontier-ledger DP separately from the existing root-seeded span DP. This
atom removes that structural split before the shadow surface is promoted
into the public projection contract.

The consolidation must preserve the proposal's algebraic-degeneracy
principle. The shared DP core owns one ledger algebra: topological
traversal, source-mass collection, basis/provenance handling,
destination-ledger landing, and trace construction. Toeplitz, empirical
cohort batching, and scalar per-source application are execution
strategies for applying the same supplied operator, not semantic branches
for FC versus non-FC, empirical versus model, window versus cohort, or
single-hop versus multi-hop. A provider that cannot expose a safe
accelerator degenerates to scalar application inside the same DP core; it
must not route to a separate DP.

Scope:

- introduce one canonical ledger-DP core whose input state is
  `node -> bucket -> basis -> mass`;
- express the existing root-seeded CF span evaluation as an adapter that
  builds a root ledger and requests the existing provenance-rich trace
  surfaces;
- express the FC continuation as an adapter that feeds frontier occupancy
  ledgers into the same core without carrying unused lineage beyond basis;
- preserve the existing public trace surfaces for normal CF consumers:
  `node_density_by_node_bucket`, `edge_contribution_by_edge_source`,
  `node_basis_by_node_bucket`, and `node_mass_by_provenance`;
- keep the kernel-provider optimisation seam centralised in the shared
  core as provider capabilities over the same ledger algebra: scalar
  fallback, current empirical cohort-batched provider, and
  all-source-bucket Toeplitz batching for shift-invariant conditioned /
  predictive kernels;
- prove each accelerator against the scalar ledger application on the
  same inputs before enabling it on a production path. Algebraic
  reasoning alone is not an acceptance signal;
- retire the separate `frontier_continuation_dp` loop once parity is
  proven, leaving only compatibility wrappers if needed by tests during
  the atom.

Non-goals:

- no row-field remapping to `ef_*`;
- no change to FC algebra, residual survivor semantics, or predictive
  versus epistemic basis selection;
- no attempt to force source-day-specific empirical kernels through the
  simple Toeplitz path. Those remain on the empirical batched-provider
  path unless a separate general banded-kernel optimisation is justified;
- no mode/type dispatch in the DP core (`if FC`, `if empirical`,
  `if cohort`, `if single-hop`, etc.). Any variation must arrive as
  input ledger shape, basis/provenance data, or provider capability.

Acceptance:

- conditioned carrier/subject trace parity: terminal density and all four
  trace ledger surfaces match the pre-consolidation root-seeded DP on a
  single-hop and a branch/merge graph;
- empirical selected-Cohort trace parity: source-day lookup, basis
  propagation, and edge-source contributions match the pre-consolidation
  DP;
- mixed-basis carrier-to-subject handoff parity: provenance/basis
  ledgers remain identical at the handoff boundary;
- FC continuation parity: carrier residual, subject residual, and Pop-C
  ordinary-subject continuation outputs match the pre-consolidation
  `run_dp_from_node_source_ledgers` path on the Atom 4a semantic fixtures;
- Toeplitz and scalar fallback produce equivalent outputs for a small
  shift-invariant conditioned-kernel fixture, with only floating-point
  reduction-order tolerance allowed;
- empirical cohort-batched provider and scalar fallback produce
  equivalent outputs on a source-day-specific fixture, proving the
  non-Toeplitz path still lives inside the same algebra;
- Atom 4a and Atom 4b acceptance tests remain green unchanged.

### Atom 4d: Source-Indexed Empirical Evidence Fast Path

Atom 4d is a dedicated performance atom for the strict empirical evidence
operators. It follows Atom 4c because the optimisation should plug into
the shared ledger-DP substrate, not create a third DP loop or a
mode-specific evidence engine.

The target is serious runtime reduction on evidence-heavy selected-Cohort
requests while preserving the empirical contract: evidence kernels remain
source-day, Cohort, draw, and basis specific. This is not a Toeplitz
optimisation. It is a source-indexed banded-operator fast path for the
general empirical equation:

`out[c, d, v] = Σ_u mass[c, d, u] * K[c, d, u, v - u]`.

Scope:

- add a provider capability for applying all active source buckets for
  one `(edge, node, basis)` in bounded chunks;
- build empirical kernels as `K[c, d, u, k]`, preserving source-day
  lookup, Cohort-specific origin days, draw-indexed latency/arrival
  dispersion, and source-basis dispatch;
- apply the chunk as a source-indexed banded tensor, not as a shared
  Toeplitz matrix;
- preserve or equivalently materialise `edge_contribution_by_edge_source[e][u]`
  because frontier occupancy consumes the per-edge per-source smear;
- keep the same destination ledger landing and basis/provenance surfaces
  owned by the shared DP core from Atom 4c;
- record memory sizing explicitly. Chunk size must be chosen from
  `(C, D, active_u, T)` working-set estimates, not guessed.

Non-goals:

- no collapse of the draw axis as a primary strategy. Draw-indexed
  latency/arrival dispersion is a typical production feature, not an
  exceptional case;
- no replacement of empirical evidence with model kernels or aggregate
  stationary fallbacks;
- no source-day widening, forward-fill policy change, or lookup-binding
  semantic change;
- no simple Toeplitz path for source-day-specific empirical kernels.

Acceptance:

- scalar empirical source-bucket application and the source-indexed fast
  path produce equivalent `node_density_by_node_bucket`,
  `edge_contribution_by_edge_source`, `node_basis_by_node_bucket`, and
  `node_mass_by_provenance` on:
  - single-hop source-day-varying evidence;
  - multi-hop evidence with draw-varying arrival weights;
  - mixed-basis carrier-to-subject handoff;
  - a branch/merge topology with coincident sibling edges;
- frontier occupancy built from fast-path empirical traces matches
  frontier occupancy built from scalar traces exactly within numerical
  tolerance;
- working memory remains bounded by configured source-bucket chunking on
  the synth-lat4 scale case (49 Cohorts × 1000 draws × horizon 115);
- measured runtime improvement is reported for empirical carrier/subject
  trace construction on the synth-lat4 scale case. If the improvement is
  not material, the atom records the profile and does not keep extra
  machinery just for architectural symmetry;
- Atom 4a, Atom 4b, and Atom 4c parity tests remain green unchanged.

#### Atom 4d acceptance result (recorded 25-May-26)

Parity matrix (executable oracle — plan §1127-1134):

| Scenario | Test | Result |
|---|---|---|
| Single-hop source-day-varying | `test_single_hop_source_day_varying_scalar_vs_source_banded` | ✅ identical traces |
| Multi-hop draw-varying weights | `test_multi_hop_draw_varying_weights_scalar_vs_source_banded` | ✅ identical traces |
| Mixed-basis carrier→subject handoff | `test_mixed_basis_handoff_scalar_vs_source_banded` | ✅ identical traces |
| Branch/merge coincident siblings | `test_branch_merge_coincident_siblings_scalar_vs_source_banded` | ✅ identical traces |
| Frontier occupancy parity | `test_frontier_occupancy_scalar_vs_source_banded` | ✅ identical `FrontierOccupancyLedger` |

Plus 27 Atom 4a/4b/4c parity tests remain green (file path bundle:
`test_frontier_residual_kernel.py`, `test_frontier_continuation_dp.py`,
`test_dp_execution_policy_parity.py`,
`test_empirical_source_banded_parity.py`).

Production dispatch assertions (plan §1195-1208 — pre-Atom-5 gate):

| Assertion | Test | Result |
|---|---|---|
| Provider declares `expected_production_policy = SOURCE_BANDED` | `test_empirical_provider_declares_expected_source_banded_policy` | ✅ |
| Both production entry points hardcode SOURCE_BANDED dispatch | `test_production_entry_points_hardcode_source_banded_dispatch` | ✅ |
| Production-scale run invokes the SOURCE_BANDED applier (dispatch log non-empty + structured) | `test_production_scale_empirical_run_invokes_source_banded_applier` | ✅ |

Performance + memory (plan §1138-1143 + §1213; benchmark script
`graph-editor/lib/perf_atom4d_synth_lat4.py`; runs directly under
`python perf_atom4d_synth_lat4.py` — NOT a pytest target, so the
benchmark doesn't get conflated with parity verification).

Fixture: C=49, D=1000, T=115, 60 active source days, 3 retrievals
per day, root seed spread across all 60 source buckets (post-carrier-
handoff multi-bucket profile — `δ(0)` seed would degenerate
`active_u=1` and short-circuit the SOURCE_BANDED amortisation, which
is the identity-carrier case the carrier-DP already handles
efficiently). Span construction reports `s_eff = 1000` (per-draw
cumulative non-degenerate — the cubic-spline path is fully
exercised) and `SOURCE_BANDED chunk_size_u = 11` (the 1 GiB chunk
budget engages chunking actively, not as a no-op).

| Binding | Policy | Runtime | Peak alloc | Speedup |
|---|---|---|---|---|
| window | SCALAR | 12.17 s | 2667.8 MiB | — |
| window | SOURCE_BANDED | 16.99 s | 2668.0 MiB | **0.72×** (slower) |
| cohort | SCALAR | 12.88 s | 2690.3 MiB | — |
| cohort | SOURCE_BANDED | **5.26 s** | 2690.4 MiB | **2.45×** (faster) |

Dispatch-log diagnostic at the SOURCE_BANDED runs:

- **window binding**: `reuse_ratio = 1.0` — every (source_day, age_start)
  group has exactly one consumer because window binding maps
  (origin_day, source_index) → (source_day, age_start) bijectively.
  The group-cubic-spline path's threshold (`>=2.0`) is not met, so the
  applier falls through to `per_consumer_scalar` — algebraically
  equivalent to SCALAR but paying the group-machinery dispatch
  overhead. Hence the 30% slowdown.
- **cohort binding**: `reuse_ratio = 27.2`, `build_sub_path =
  group_cubic_spline`, `cache_hits = 60/108`, `n_built = 48`,
  `n_chunks = 48`. Many cohorts share the same (source_day, age_start)
  group so the cubic-spline kernel build is amortised 27×; the
  chunked-streaming path is actively chunking. This is the workload
  SOURCE_BANDED was designed for.

Memory parity is identical to within MB across both bindings — the
chunk budget keeps SOURCE_BANDED bounded; SCALAR doesn't materially
exceed SOURCE_BANDED's peak. Plan §1138 ("working memory remains
bounded by configured source-bucket chunking") is satisfied.

Disposition (plan §1142-1143 / §1213-1216): SOURCE_BANDED is kept.
Material speedup is binding-dependent — 2.45× on cohort binding (the
intended high-reuse regime), modestly slower on window binding (low
reuse) but memory-equivalent and architecturally required by the
§1175 permissible-dispatch surface (empirical evidence providers
"use the source-indexed banded path"). Outside-in (production stack
exercising the SOURCE_BANDED dispatch via
`evaluate_empirical_span_from_seed_flat_origins`) remains green at
5m32s, confirming the production runtime is in the acceptable band.

Frontier_continuation_dp status (pre-Atom-5 gate §1161-1162): file is
already a thin adapter over `timing_span._run_dp_density_trace_from_ledger`
per Atom 4c.C — module owns only basis-keyed ↔ per-provenance shape
translation; no DP-core algebra. Pre-Atom-5 gate satisfied unchanged.

### Pre-Atom-5 Gate: DP Substrate And Performance Dispatch

Atoms 4c and 4d must leave the runtime in a state where projection-surface
work can proceed without carrying hidden DP split-brain risk. Before Atom 5
starts, the following gate must be satisfied.

Mandatory consolidation:

- there is one shared ledger-DP core for topological traversal,
  source-mass collection, basis/provenance handling, destination-ledger
  landing, and trace construction;
- root-seeded conditioned/model spans, root-seeded empirical spans, FC
  frontier continuation, and Pop-C handoff all enter that shared core via
  adapters or provider capabilities, not via separate hand-written DP
  loops;
- `frontier_continuation_dp` is either removed or reduced to a thin
  compatibility wrapper over the shared core;
- public trace surfaces consumed downstream remain single-contract:
  `node_density_by_node_bucket`, `edge_contribution_by_edge_source`,
  `node_basis_by_node_bucket`, and `node_mass_by_provenance`.

Permissible performance dispatch:

- dispatch may vary only by provider-declared operator capability, never
  by semantic mode. Allowed examples:
  - scalar source-bucket fallback;
  - cohort-batched empirical source-bucket provider;
  - all-source-bucket Toeplitz provider for shift-invariant model /
    predictive kernels;
  - source-indexed banded empirical provider for lookup-bound evidence
    kernels;
- provider capability dispatch must live at the operator-application seam
  inside the shared DP core. It must not fork traversal, ledger landing,
  trace construction, or frontier occupancy logic;
- source-day-specific empirical kernels must not be forced into the
  simple Toeplitz path. If they are accelerated, they use the
  source-indexed banded path and prove equivalence to scalar empirical
  application.

Forbidden branching:

- no DP-core branch on `FC`, `empirical`, `model`, `window`, `cohort`,
  identity carrier, single-hop, multi-hop, latent, or non-latent;
- no separate DP implementation retained because a case is "special";
- no performance path may omit or approximate per-source trace surfaces
  unless the consumer contract is changed and proven equivalent first.

Proof required before Atom 5:

- scalar fallback remains available for every provider as the executable
  oracle for accelerator parity, but it is a noisy fallback outside
  explicit parity/debug/small-fixture contexts. Unexpected scalar use on a
  production-scale request must emit a diagnostic and fail the relevant
  performance-dispatch test;
- production provider families assert their expected fast-path dispatch:
  conditioned/model and predictive/FC providers use the Toeplitz
  all-source-bucket path; empirical evidence providers use the
  source-indexed banded path once Atom 4d lands;
- Toeplitz, empirical cohort-batched, and source-indexed empirical fast
  paths each have parity tests against scalar fallback on representative
  fixtures;
- representative production-scale tests assert not only numerical output
  but also that the intended fast path was selected. "It passed by falling
  back to scalar" is not an acceptance signal;
- parity checks cover terminal density, all four public trace surfaces,
  carrier-to-subject handoff, FC continuation output, and frontier
  occupancy derived from empirical traces;
- performance measurements report both runtime and peak/estimated working
  memory for the synth-lat4 scale case. A fast path that is not materially
  faster or has unsafe memory growth is removed or left disabled with the
  profile recorded.

### Atom 5: Split The Spine Projection Surface Contract

Pre-step: before promoting the shadow fields into the public projection
contract, add a blind FC shadow-delta matrix. These tests are authored
from the semantic contract in §§3.3, 5.2, 5.3, and 5.4, not from current
runtime output. Their purpose is to prove the risk-control premise from
§1.1: the FC surface is nearly identical to the conditioned model surface
when the realised frontier is model-consistent, and diverges only when the
frontier state carries information the full-root model surface cannot
represent.

Required pre-step tests:

- **Model-consistent single-hop window witness.** Build a one-edge
  selected-Cohort fixture where the empirical prefix is generated from
  the same transition kernel as the conditioned model. The FC surface and
  conditioned model surface must agree within a tight numerical envelope
  after the frontier; the FC prefix remains exactly pinned to strict
  evidence through the frontier.
- **Model-consistent multi-hop window witness.** Build a two-edge
  subject span where empirical mass follows the same composed timing and
  rate surface as the conditioned model. The FC and conditioned model
  surfaces must agree within tolerance after the frontier. This test
  proves the continuation state does not introduce a spurious
  multi-hop-specific shape change.
- **Model-consistent `cohort(A = X)` witness.** Use the same identity-
  carrier semantics as window mode but with Cohort-mode binding. The FC
  and conditioned model surfaces must agree within tolerance after the
  frontier, and the result must be indistinguishable from the equivalent
  identity-carrier window construction except for explicitly labelled
  mode provenance.
- **Model-consistent active `cohort(A != X)` witness.** Build a carrier
  plus subject fixture whose empirical carrier and subject traces match
  the conditioned predictive operators. The FC surface must remain close
  to the conditioned model surface after the frontier. This pins the
  active-carrier claim that FC is a semantic refinement, not a new default
  shape.
- **Off-model prefix witness.** Build a fixture where strict empirical
  prefix mass is deliberately far from the conditioned model surface
  before the frontier. The FC surface must equal the strict prefix through
  the frontier and diverge from the conditioned model after the frontier
  in the direction implied by the realised prefix. This is the positive
  control proving the matrix can detect a real FC/model difference.
- **Multi-hop frontier-state witness.** Build two fixtures with the same
  scalar unresolved mass at the frontier but with that mass located at
  different subject nodes or source buckets. The FC surfaces must diverge
  after the frontier, while a scalar-remainder implementation would make
  them equal. This proves the frontier state is the minimal state needed
  for multi-hop continuation.

Acceptance for the pre-step:

- every model-consistent witness reports a small bounded FC-vs-model
  delta, with the bound stated in the test from fixture scale and draw
  count rather than copied from a run;
- the two divergence witnesses fail if FC is wired to the conditioned
  model surface, if the frontier prefix is ignored, or if multi-hop
  frontier state is collapsed to a scalar remainder;
- all tests use hand-constructed fixtures whose expected relationships
  are derivable from the contract text alone;
- no outside-in tolerance is weakened to make this matrix pass.

Promote shadow fields into explicit projection fields; chart mapping unchanged:

- strict empirical: `evidence_x_strict`, `evidence_y_strict`, `rate_strict`;
- query-conditioned model-only: `f_x_draws`, `f_y_draws`, `f_rate_draws`;
- frontier-conditioned: `ef_x_draws`, `ef_y_draws`, `ef_rate_draws`;
- frontier future residuals: `ef_forecast_x`, `ef_forecast_y`.

This removes the overloaded `rate_draws_model` API meaning. Public E+F fields
do not switch yet.

Acceptance:

- outside-in remains green;
- backend tests prove conditioned model is unspliced and FC is prefix-pinned;
- multi-Cohort rows sum `Y` and `X` before division.

#### Atom 5 acceptance result (recorded 25-May-26)

Focused Atom 5 matrix:

`PYTHONPATH=lib pytest lib/tests/test_model_span_spine_selected_cohort.py -k atom5`

Result: **7 passed**.

The previously weak multi-Cohort acceptance test now uses one real
multi-Cohort projection with two selected Cohorts bound to different
source-day curves:

- Cohort A: `X=200`, `Y=160`, rate `0.8`;
- Cohort B: `X=20`, `Y=4`, rate `0.2`;
- required row result: `ΣY/ΣX = 164/220 ≈ 0.745`;
- rejected implementation shape: `(0.8 + 0.2) / 2 = 0.5`.

The test asserts `rate_strict`, `rate_draws_spliced`, and `ef_rate_draws`
at the observed frontier all use the pooled mass-first result. This closes
the Atom 5 multi-Cohort acceptance gap.

### Atom 6: Switch E+F Forecast-Layer Mapping

Map E+F mode's public forecast-layer row fields to the FC surface:

- `midpoint`, `fan_*`, `fan_bands`, `projected_rate` read `ef_*`;
- `forecast_x`, `forecast_y` read `ef_forecast_*`;
- post-hoc subtraction of evidence from full model means is deleted.
- output/chart mapping suppresses the FC forecast layer in epoch A only. Evidence remains visible in epochs A/B and is absent in epoch C. The underlying `ef_*` arrays are still generated across the full tau sweep.

This is the semantic switch; by now it should be a row-mapping change because
Atoms 4-5 proved the algebra and shape.

Acceptance:

- outside-in remains green;
- any test edits are limited to old "full-root model minus evidence" assertions;
- single-Cohort rows pin exactly to strict evidence through the frontier;
- fan width is zero or absent at the frontier and opens after the frontier;
- in E+F mode, strict evidence is present in epochs A/B, absent in epoch C, and rendered forecast/fan fields are present in epochs B/C but absent in epoch A;
- active cohort denominator/numerator semantics remain `Y / X`.

### Atom 7: Name The Optional Model Overlay

Keep the old unconditioned model curve only as an explicitly named optional
model overlay. This is terminology/consumer ownership, not deletion.

Acceptance:

- outside-in remains green;
- no default chart mode reads the old unconditioned overlay as F mode;
- any tests for the old surface name it as the optional model overlay and
  assert unconditioned model-curve semantics;
- documentation and tooltip copy match Appendix B's ownership.

### Atom 8: Promote Terminology To Codebase Docs

Create or update a maintained codebase doc with Appendix B's terminology and
mapping. This proposal is not the long-term home for those terms.

Candidate homes:

- `docs/current/codebase/CF_ROW_PIPELINE.md` for row-surface ownership and
  output mapping;
- `docs/current/codebase/GLOSSARY.md` for short definitions;
- `docs/current/codebase/FORECAST_RUNTIME_ARCHITECTURE.md` if runtime fields
  or projection ownership change.

Acceptance:

- outside-in remains green;
- at least one maintained codebase doc defines E mode, F mode, E+F mode,
  strict evidence surface, evidence layer, forecast layer, conditioned model
  surface, FC surface, and optional model overlay;
- the doc includes the epoch mapping: evidence layer in epochs A/B, no
  evidence layer in epoch C, FC generated for the full tau sweep but rendered
  as the forecast layer in epochs B/C;
- this project note links to the maintained codebase doc after it exists, or
  records the intended doc path if the atom is still pending.

## 11. Acceptance Tests

The important tests should be about chart semantics, not internal implementation names.

Required behaviours:

- The FC surface equals strict evidence at every age up to and including each selected Cohort's frontier.
- At the frontier, FC fan width is zero or absent.
- After the frontier, FC fan width grows from the unresolved continuation.
- In E+F mode, strict evidence is visible in epochs A/B and absent in epoch C; the FC forecast layer is visible in epochs B/C and suppressed in epoch A in output only, while `ef_*` remains generated and internally prefix-pinned across the full tau sweep.
- The conditioned model surface remains smooth model-only and does not splice the observed prefix.
- F mode renders the conditioned model surface with epistemic bands; the FC surface uses predictive bands.
- The optional model overlay, when enabled, remains the unconditioned model curve with epistemic bands and is not treated as F mode.
- `forecast_x` and `forecast_y` are future residuals emitted by the continuation path, not clamped post-hoc differences between full model means and evidence.
- Multi-hop subjects preserve source-bucket/node-state differences at the frontier; they must not collapse frontier state into one scalar remainder.

Existing outside-in tests that compare strict evidence against selected A-clock oracles remain valuable. New tests should add the missing chart-surface contract: evidence fixes the prefix, model continues only the unresolved future.

## 12. Open Questions

- Exact field names for the conditioned model surface after retiring `model_midpoint` / `model_fan_*` as the fields rendered by F mode.
- Exact field names and UI affordance for the optional model overlay that keeps today's unconditioned model curve available without overloading F mode.
- Whether the current composed span traces already expose enough per-node/source-bucket empirical state to derive frontier states without widening the trace object.
- Whether epistemic versus predictive selection should be a property of the operator supply or a parameter on the projection request. The conceptual rule is fixed: query-conditioned model surface uses epistemic; frontier-conditioned continuation uses predictive.

## Appendix A. New Flow Schematic

Legend:

- `*` changed existing stage or surface.
- `+` new stage or surface.

```text
REQUEST
  graph + query + selected Cohorts + evidence candidates
        |
        v
PREPARATION / RUNTIME RESOLUTION
  resolve carrier span A -> X
  resolve subject span X -> end
  bind primitive evidence
  condition primitives
        |
        +-----------------------------+
        |                             |
        v                             v
* basis = epistemic             * basis = predictive
  conditioned primitive map       conditioned primitive map
  for conditioned model surface   for FC surface
        |                             |
        v                             v
* FULL-ROOT MODEL DP            * STRICT EMPIRICAL DP
  seed selected root mass          seed selected root mass
  run conditioned carrier          empirical carrier trace
  run conditioned subject          empirical subject trace
  no observed-prefix splice      + source-aware ledgers
        |                             |
        v                             v
* QUERY-CONDITIONED             + FRONTIER STATE BUILDER
  MODEL SURFACE                   for each Cohort c:
  f_x_draws                         f_c = tau_observed(c)
  f_y_draws                         fixed prefix:
  f_rate_draws                        X_obs_c(τ <= f_c)
  epistemic bands                     Y_obs_c(τ <= f_c)
                                     occupancy ledgers:
                                       L_carrier_f_c(node, arrival_bucket)
                                       L_subject_f_c(node, arrival_bucket)
                                      |
                                      v
                              + FRONTIER-CONTINUATION DP
                                predictive basis
                                fixed prefix through f_c
                                continue carrier ledger:
                                  future X arrivals
                                continue subject ledger:
                                  future end arrivals
                                feed future X arrivals into
                                  ordinary predictive subject kernels
                                      |
                                      v
                              + FRONTIER-CONDITIONED SURFACE
                                ef_x_draws
                                ef_y_draws
                                ef_rate_draws = ΣY / ΣX
                                ef_forecast_x
                                ef_forecast_y
                                predictive fan
        |                             |
        +-------------+---------------+
                      |
                      v
* ROW PROJECTOR
  e fields:
    rate, evidence_x, evidence_y
      <- strict empirical surface

  Conditioned model fields rendered by F mode:
    model-only/query-conditioned curve
      <- f_* epistemic surface

  E+F forecast-layer fields:
    midpoint, fan_*, fan_bands, projected_rate
      <- ef_* predictive FC surface
      (ef_* generated for full tau sweep; forecast layer rendered
       in epochs B/C only)

  residual count fields:
    forecast_x, forecast_y
      <- ef_forecast_* directly
      (no subtracting evidence from full model means)

  optional model overlay:
    unconditioned model curve
      <- existing model overlay surface, epistemic bands
      (not F mode)
                      |
                      v
* CHART
  e mode:
    strict evidence where evidence support exists

  F mode:
    query-conditioned model surface
    epistemic bands

  E+F mode:
    strict evidence visible in epochs A/B
    predictive fan opens after frontier
    evidence absent in epoch C
    FC forecast layer visible in epochs B/C

  optional model overlay:
    unconditioned model curve
    epistemic bands
```

## Appendix B. Standard Terminology And Display Mapping

> **Maintained homes (post-Atom-8)**: the canonical definitions of these
> terms now live in the codebase reference, where they are kept up to
> date alongside the row pipeline and runtime architecture they describe:
>
> - [`docs/current/codebase/GLOSSARY.md`](../codebase/GLOSSARY.md#cohort-maturity-chart-display-modes-and-surfaces) — the nine named terms (E/F/E+F mode; strict evidence surface; evidence layer; forecast layer; conditioned model surface; FC surface; optional model overlay) plus the display-mode epoch mapping.
> - [`docs/current/codebase/CF_ROW_PIPELINE.md` §5](../codebase/CF_ROW_PIPELINE.md#5-row-schema--three-projection-surfaces) — the row-surface ownership table (which row fields read which internal surface) and [§6.1](../codebase/CF_ROW_PIPELINE.md#61-display-mode-epoch-mapping) — the display-mode × epoch grid.
> - [`docs/current/codebase/FORECAST_RUNTIME_ARCHITECTURE.md` §7](../codebase/FORECAST_RUNTIME_ARCHITECTURE.md#7-row-projection) — runtime surface sources for the row schema, and the `unconditioned_overlays` row in §2 for the optional model overlay backing object.
>
> This Appendix remains the design-time statement of the contract; the
> codebase docs are the source of truth for current behaviour.

Use these names consistently. E, F, and E+F name display modes only; they
must not be used as names for internal surfaces.

| Term | Meaning |
|---|---|
| **E mode** | Chart display mode that renders only the strict evidence layer where evidence support exists. |
| **F mode** | Chart display mode that renders the conditioned model surface (`f_*`) with epistemic bands. |
| **E+F mode** | Chart display mode that renders the strict evidence layer in epochs A/B plus the forecast layer in epochs B/C. Epoch B is the overlap region; in epoch C, only the forecast layer remains visible. |
| **Strict evidence surface** | Strict empirical row fields (`rate`, `evidence_x`, `evidence_y`). This surface supplies E mode and the evidence layer in E+F mode. |
| **Evidence layer** | The visual layer in E+F mode that renders the strict evidence surface. This layer is visible only where observed or partially observed evidence support exists (epochs A/B), and is absent in epoch C. |
| **Forecast layer** | The second visual layer in E+F mode: curve and bands rendered in epochs B/C. Today this is the post-frontier conditioned model curve/bands; target state reads the FC surface. |
| **FC surface** | Internal frontier-conditioned surface (`ef_*`) generated for the full tau sweep. It is prefix-pinned to evidence before the frontier and continues unresolved mass after the frontier. |
| **Conditioned model surface** | Full-root query-conditioned model surface (`f_*`) generated from conditioned primitives with epistemic basis. F mode renders this surface. |
| **Optional model overlay** | Existing unconditioned model curve with epistemic bands. It may remain as an explicit overlay, but is not a mode. |

### Appendix B.1 Display Mode Mapping

| Display mode | Epoch A/B: evidence support exists | Epoch C: no evidence support |
|---|---|---|
| **E mode** | Strict evidence surface. | No evidence layer. |
| **F mode** | Conditioned model surface. | Conditioned model surface. |
| **E+F mode** | Evidence layer plus forecast layer. The evidence layer is present across epochs A/B; the forecast layer is present across epoch B. Epoch B is the overlap region where evidence coverage dwindles while forecast continuation is visible. | Forecast layer only. Today the forecast layer reads the conditioned model surface; target state reads the FC surface. |
| **Optional model overlay** | If enabled, unconditioned model curve as an overlay. | If enabled, unconditioned model curve as an overlay. |

The FC surface is still generated across the full tau sweep. The table
describes public display, not internal surface generation.
