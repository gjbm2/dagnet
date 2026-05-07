# Cohort Maturity MC Computes the Wrong Object — Problem Statement

**Status**: open — design discussion before implementation
**Date**: 4-May-26

## See also

- `docs/current/cohort-maturity-selected-cohort-projection-pattern.md` — companion implementation-pattern sketch: no new MC pass, no 73p prerequisite, one selected-Cohort mass-first reducer for E+F rows.
- `docs/current/project-bayes/cohort-maturity/cohort-maturity-fan-chart-spec.md` — the chart contract this problem statement works against (§1.1, §5, §5A, §5B, §10).
- `docs/current/codebase/cohort-maturity-forecast-design.md` — earlier design notes on the chart's epoch model, the carry-forward denominator invariant, and the e+f crown intent.
- `docs/current/cohort-maturity-v3-midline-collapse-investigation.md` — the prior investigation that surfaced the same root cause as Defect 2 (level confusion at the rate-conditioning seam) plus an unrelated arithmetic defect (Defect 1, `int(remaining)` truncation in Pop D). This problem statement reframes the level-confusion issue around the chart contract rather than around the symptom captured in that earlier trace, and proposes a structural fix.
- `graph-editor/lib/runner/cohort_forecast_v3.py` — `compute_cohort_maturity_rows_v3`, `_project_runtime_rows`, the row-builder that consumes the trajectory.
- `graph-editor/lib/runner/forecast_state.py` — `compute_forecast_trajectory`, the MC engine producing `rate_draws` and `model_rate_draws`.
- `graph-editor/src/services/analysisECharts/cohortComparisonBuilders.ts` — the chart-builder that consumes the row schema.

## TL;DR

The cohort maturity chart is meant to display the posterior over the **cohort-group conversion-rate trajectory** as a function of age — `p_group(τ) = Σ_d Y_d(τ) / Σ_d X_d(τ)` aggregated over the cohorts in the user's query window. The chart-builder, the row schema and the spec all assume that's what the MC produces.

The v3 MC produces a different object. It samples a single global per-user `p` per particle, importance-samples it against per-cohort evidence, and projects the per-particle trajectory as `p_s × F_Y_s(τ) / F_X_s(τ)` — a model curve indexed by particle, not a per-cohort calibrated aggregate. The two objects do not coincide and the substitution is not a benign approximation.

Two structural symptoms follow directly from the substitution and cannot be patched in the row builder:

- The forecast midline does not meet the observed evidence at the A→B seam. There is no construction in the per-particle trajectory that anchors to each cohort's own `y_frozen` at its frontier, so no aggregation over particles can recover the empirical group rate at that τ except by accident.
- The fan width does not widen as τ moves past the evidence frontier. Particle dispersion of `p_s × CDF_s(τ)` is bounded by `Var(p_s)` after IS conditioning, scaled only by `CDF²(τ)` — there is no per-cohort, per-τ dispersion source that grows as the group's evidence thins.

These are properties of *what the MC computes*, not of how the row builder packages it. Fixing them requires replacing the per-particle trajectory mechanism, not adjusting the row schema.

## What the chart is supposed to be

The cohort maturity chart is named for what it shows: how a *group* of cohorts mature as the group ages. A "group" is the set of cohorts admitted by the query DSL (`cohort(start:end)` or `window(start:end)`). Each cohort `d` in the group has its own anchor day, its own observed (x, y) trajectory up to its own frontier age, and its own forecast horizon past the frontier. The chart's y-axis is a single number per τ — the *group's* conversion rate at that age — not any one cohort's rate.

The spec (`cohort-maturity-fan-chart-spec.md` §1.1) states this in the visual-element table: solid line is observed Σy/Σx across all cohorts in epoch A, dashed line is observed Σy/Σx across mature cohorts in epoch B, dotted line is the augmented best-estimate of the group rate (observed contributions plus forecast contributions for immature cohorts), fan polygon is the uncertainty band around the dotted line.

The dotted midline and the fan are the only surfaces that need posterior reasoning. They are surfaces over the *group* trajectory `p_group(τ)`, not surfaces over the per-user rate parameter `p` or the latency CDF. Whatever the MC produces has to be a posterior over `p_group(τ)`.

The structural properties of any correctly-defined posterior over the group trajectory follow from how the group trajectory is constructed:

- At τ = `tau_solid_max`, every cohort in the group has been observed at this age (definition of `tau_solid_max`). The group rate at this τ is fully determined by observation. The posterior collapses to a point. The midline equals the empirical Σy/Σx at this τ, the fan width is zero. This is not a chart trick, not an anchoring rule — it is what "the group's conversion rate at τ_solid_max" means.
- For τ slightly past `tau_solid_max`, the youngest cohort enters forecast mode. Particles disagree about that cohort's eventual y; the disagreement enters the group aggregate weighted by that cohort's x relative to the total. The fan opens. The midline moves continuously off the observed value because the new contribution is a forecast, not a fresh observation.
- For τ further past `tau_solid_max`, more cohorts age out and contribute forecast trajectories. Each new immature cohort adds another particle-spread contribution to the aggregate. The fan widens monotonically until all cohorts are immature; past that, additional widening is bounded by how far the model is being extrapolated.
- For τ → ∞, the fan width is bounded by the asymptotic uncertainty in each cohort's eventual rate, weighted by its share of the total denominator. In window mode the asymptotic group rate is `Σ y_d_frozen / Σ x_d_frozen` divided by some asymptotic completeness factor — a function of the cohort latency posterior, not of the rate parameter.

These properties fall out of the construction; nothing in the row builder enforces them. If the MC is computing the group trajectory correctly, the chart looks right by default.

## What v3's MC actually computes

Tracing `compute_forecast_trajectory` and the per-tau rate draws used by the row builder:

The MC samples a single global parameter set per particle: `p_s ~ Beta(α_pred, β_pred)`, `(μ_s, σ_s, onset_s) ~ latency posterior`. It then importance-samples the particles against per-cohort evidence using a Level-1 likelihood — `Π_d Binomial.pmf(k_d | n_d, p_s × CDF_s(τ_d))` — that treats every cohort as a draw from the same shared `p_s`. The per-tau rate draw used to populate `midpoint` and `fan_*` is `p_s × F_Y_s(τ) / F_X_s(τ)`, where `F_Y` and `F_X` are aggregate carrier and subject CDFs derived from the composed runtime substrate.

Each part of that pipeline is internally coherent. Together they describe a posterior over a different object from `p_group(τ)`. The differences:

- The per-particle trajectory `p_s × F_Y_s(τ) / F_X_s(τ)` is a model curve. It is not anchored to any cohort's observed `(k_d, n_d)` — those values feed only the IS likelihood, not the trajectory itself.
- A single shared `p_s` per particle precludes per-cohort variation. The Level-2 between-cohort-date dispersion ("kappa") that the predictive Beta `α_pred, β_pred` exists to summarise is collapsed at sampling time. Particles vary in the global rate; they do not vary in the rate-by-cohort-date.
- The IS likelihood the trajectory is conditioned by is at Level 1 (per-user rate). The displayed object is at Level 3 (group trajectory). Even when IS conditioning is statistically valid for what it is conditioning, it does not enforce structural agreement with the displayed object.

The midline-collapse investigation (`cohort-maturity-v3-midline-collapse-investigation.md`) calls this Defect 2 and frames it around three levels of `p` (per-user, per-cohort-date, per-cohort-group). This problem statement adopts the same framing and pushes it forward to the structural consequences for the chart.

## Why each chart symptom follows structurally

**The midline does not meet the evidence at the A→B seam.** The chart's solid line in epoch A is the empirical group rate Σy_observed / Σx_observed aggregated over the actually-observed (x, y) values at each τ. The dotted midline at the seam is `median_s ( p_s × F_Y_s(tau_solid_max) / F_X_s(tau_solid_max) )`. The empirical aggregate and the model-curve median have no construction binding them together. IS conditioning shifts the latter toward observation in expectation but does not constrain it to coincide. On a real fixture they will differ by the amount the model misfits the group's mature evidence at that τ, which is unbounded.

**The fan does not widen with τ.** The fan width at τ is the spread across particles of `p_s × F_Y_s(τ) / F_X_s(τ)`. With a single `p_s` per particle and an aggregate `F_Y / F_X` shared across cohorts, the spread is upper-bounded by `Var(p_s)` (since `F_Y / F_X ≤ 1` in the regime that matters). After IS conditioning, `Var(p_s)` is small. The same `Var(p_s)` modulates the trajectory at every τ, scaled only by `(F_Y(τ)/F_X(τ))²`, which is a smooth function bounded above. There is no τ-dependent dispersion mechanism. In particular, there is no representation of "between-cohort variation that has been pinned by observation at τ ≤ frontier_d but has nothing pinning it for τ > frontier_d" — that is the per-cohort dispersion that should grow the fan in epoch B and beyond.

Both symptoms are structural consequences of the per-particle trajectory being a global model curve rather than a per-cohort calibrated aggregate.

## What a correctly-shaped MC looks like

The structurally clean form is the per-cohort calibrated trajectory under the latency posterior, aggregated per particle. The construction:

For each particle `s`:

- Sample latency parameters from the posterior: edge-level `(μ, σ, onset)` for window mode, plus carrier-side latency for cohort mode where the upstream path matters. No `p` sampling required for the chart's purposes.
- For each cohort `d` and each τ in the chart range, build the cohort's contribution to the group aggregate at that τ:
  - If τ ≤ frontier_age(d): the cohort is observed at this age. Its contribution to the numerator is the observed `y_d(τ)`; to the denominator, `x_d(τ)`. No randomness; every particle agrees.
  - If τ > frontier_age(d): the cohort is in forecast mode. Its `y_d_frozen` and `x_d_frozen` are locked. The forecast extends `y_d_frozen` forward via the calibrated CDF ratio: `y_d_s(τ) = y_d_frozen × CDF_s(τ − lag_d) / CDF_s(τ_d_frontier − lag_d)`. The denominator stays at `x_d_frozen` in window mode; in cohort mode it scales by the upstream carrier CDF ratio.
- Aggregate per particle: `rate_s(τ) = Σ_d y_d_s(τ) / Σ_d x_d_s(τ)`.

Median across particles is the midline; quantiles are the fan.

What this gives, by construction:

- At τ ≤ tau_solid_max every cohort is observed; every particle returns the same value; the median equals the empirical group rate; the fan is zero. The chart's evidence line and forecast midline meet at the seam without any anchoring.
- For τ slightly past tau_solid_max, only the cohort that just aged out contributes particle-spread; the fan opens narrowly. As more cohorts age out the fan widens monotonically. At τ where all cohorts are immature, the fan width reflects the full per-cohort latency posterior aggregated over the group.
- Per-cohort calibration preserves each cohort's observed performance, so cohorts that outperformed the model continue to outperform in the forecast, and cohorts that underperformed continue to underperform. The aggregate midline reflects the group's actual trajectory, not a globally-fitted model curve.

This is the v1 spec's calibrated CDF-ratio approach (`cohort-maturity-fan-chart-spec.md` §5.2.1, §10.4) lifted from "compute one number per τ deterministically" to "compute one number per τ per particle and take quantiles".

The construction does not address Level-2 between-date dispersion ("kappa"). If two cohorts have similar latency but genuinely different conversion rates, the calibrated approach captures that — each is anchored to its own `y_frozen`. What it does not capture is the *prior expectation* that future cohorts in the group might differ from the observed ones in rate. That is a separate uncertainty source that would inflate the fan further; it can be added later as a hierarchical prior on per-cohort rates without changing the trajectory mechanism.

## Scope considerations

The trajectory engine `compute_forecast_trajectory` is shared between the cohort maturity chart row builder and the conditioned forecast (CF) pass. Replacing the trajectory mechanism here changes the CF surface for cohort_maturity-typed responses too. CF additionally extracts public scalars (`p_mean`, `p_sd`, `completeness`, `completeness_sd`) from the same MC. The calibrated-trajectory approach does not produce a per-user `p` posterior, so the public scalars need a different source — either the existing primitive substrate's `public_moments` (if those are populated independently) or a separate IS pass kept alive solely for scalars.

CLAUDE.md's no-duplicate-code-paths principle argues against introducing a parallel trajectory engine for the chart that diverges from CF. The cleaner answer is to replace the shared engine and ensure the CF scalar surface is fed from the right place.

The 73n primitive substrate (gated behind `DAGNET_*_PRIMITIVE_READOUT` flags, all defaulting OFF — see `STATS_SUBSYSTEMS.md` §3.3a) was introduced precisely to separate "what evidence moved this rate" from "what trajectory does the chart show". The substrate's per-primitive provenance and conditioning live in `primitive_conditioning.py` and feed the readouts in `primitive_readout.py`. A correctly-shaped chart MC could read per-cohort posterior values from the substrate and aggregate them, rather than running its own MC. Whether the substrate as currently scoped exposes everything the calibrated trajectory needs (per-cohort latency posterior draws, per-cohort observed values at every τ, per-cohort frontier_age) needs confirmation.

## Open questions

The questions that need answering before implementation begins:

- **Calibrated trajectory only, or calibrated trajectory plus Level-2 hierarchical dispersion?** The calibrated trajectory alone gives the seam connection and a fan that widens with how-many-cohorts-are-immature. Adding Level-2 dispersion gives an additional fan widening reflecting between-cohort variation. They compose; the calibrated trajectory can land first.
- **Where do the public scalars come from after the trajectory engine is replaced?** Confirm whether the primitive substrate's `public_moments` is populated in the relevant code paths, or whether an IS pass needs to remain for scalar extraction even after the trajectory engine changes.
- **Window vs cohort symmetry at the trajectory level.** The calibrated trajectory in window mode is straightforward (x is fixed). In cohort mode the carrier projection of `x_d_s(τ)` requires sampling the upstream latency posterior per particle. Confirm whether the existing composed_carrier surface in the primitive substrate exposes per-cohort upstream CDF samples or only aggregate means.
- **Should this work be done inside the existing `forecast_state.py` MC engine or alongside it?** Inside-the-engine means a structural rewrite of `compute_forecast_trajectory` with a flag-gated rollout (per the 73n pattern); alongside means a new entry point used only by the chart builder. The first is more invasive but avoids duplicate code; the second is less invasive but creates the parallel-path drift CLAUDE.md explicitly warns against.
- **How is correctness verified end-to-end?** The existing v3 contract suite (`test_cohort_maturity_v3_contract.py`) pins row-schema invariants but does not pin the seam-meeting or fan-widening invariants this problem statement is about. New contract tests are needed: at τ = tau_solid_max the midline equals the empirical group rate within tolerance; the fan width grows monotonically through epoch B; at τ → ∞ the fan width is bounded by the per-cohort calibration variance aggregated over the group.
- **Migration of the 73n strict-xfail tests.** The tests in `test_cohort_factorised_outside_in.py` that pin the active-cohort A≠X behaviour and the 73n primitive readouts have specific invariants that interact with the trajectory mechanism. Confirm which of these need to be re-pointed at the new trajectory and which become obsolete.

## What this problem statement does not answer

This document defines what the MC should be computing and identifies why the current implementation cannot produce the chart's contracted output. It does not specify the implementation, the migration sequencing, the test plan, or the scalar-surface refactor. Those are the next deliverables — the implementation plan and the test design — and should follow from the design choices made on the open questions above.

## Appendix A: Problem statement for a semantic oracle test

### Why a new test construction is required

The recent attempts to test the active-cohort chart have not been rigorous enough. They have tended to assert properties of row fields after the implementation has already chosen how to populate them. That is the wrong direction. A test that asks whether `rate`, `evidence_x`, `evidence_y`, or `midpoint` have plausible relationships can still pass while the implementation has built those fields from the wrong underlying object.

The test we need is an executable semantic oracle. It must compute the chart's intended objects from independently assembled inputs and only then compare production rows to that oracle. It must not mirror the current row-builder structure, reuse helper functions that own the bug, or treat field presence as evidence of correctness.

The purpose is to prove the chart's algebra, not to prove that the current implementation is internally consistent.

### Semantic object under test

For a selected active query `cohort(A, X -> end)`, the chart is about one selected Cohort group on the A-clock. At every age `τ`, the semantic object is:

- denominator mass at query node `X`: `X_A(τ)`;
- numerator mass at the subject end: `Y_A(τ)`;
- selected group rate: `ΣY_A(τ) / ΣX_A(τ)`.

This applies uniformly to single-hop and multi-hop subjects. Single-hop is only the degenerate case where the subject span `X -> end` has one edge. The test must not contain a branch that says "if single-hop, use the target edge row; if multi-hop, do something else" as its conceptual model. It may use different fixture data to expose the degeneracy, but the oracle should be phrased in terms of `carrier_to_x`, `subject_span`, `X_A(τ)`, and `Y_A(τ)`.

The key dataset invariants come from `COHORT_ANALYSIS_NUMERATOR_DENOMINATOR_SEMANTICS.md`:

- The denominator question is "who has reached `X` by A-clock age `τ`?" It is a carrier-side `A -> X` object.
- The numerator question is "who has reached the subject end by A-clock age `τ`?" It is an `X -> end` subject-span object projected onto the A-clock.
- The displayed rate is always `Y / X`, never `Y / A`.
- For multi-hop `cohort(A, X -> Z)`, the denominator is still at `X`; the numerator is at `Z`. A terminal-edge source node must not become the chart denominator by accident (lest it be, e.g. a non-latency edge.
- In factorised form, denominator-side Pop C is future carrier mass reaching `X`; numerator-side Pop C is that future carrier mass progressing through the subject span. Pop C and Pop D are not interchangeable with a gross fitted numerator.
- `window()` and `cohort(A = X)` are identity-carrier degeneracies. They are not separate semantic implementations.

### Chart semantics to prove

The oracle must produce expected values for the chart surfaces, not just raw data:

- E mode (`rate_pure` in the current row schema): evidence-only line. In epoch B, this uses the frozen denominator at the epoch A/B boundary for the selected group. It is intentionally an evidence-only view, not the E+F full-group estimate.
- E+F evidence line (`rate` in the current row schema): observed numerator over the selected-group denominator appropriate to the E+F evidence display. In epoch B this denominator must be reduced by the selected A-clock carrier denominator dynamics, not by a terminal-edge denominator and not by a model-only clamp.
- E+F midpoint (`midpoint`): selected-Cohort group estimate formed by observed contributions where they exist and forecast contributions where selected Cohorts are immature. It is not a request-level primitive model curve.
- At the epoch A/B boundary, the E+F midpoint and the observed evidence line meet because every selected Cohort contributing at that age is observed.
- In epoch B, the E+F midpoint should sit above the E+F evidence line as a natural consequence of adding forecast numerator mass to the same selected-group mass algebra. This relationship should not be achieved by comparing or clamping row fields against each other.

The test should treat relationship checks as secondary. The primary assertions must be exact or tightly-toleranced mass assertions against an independently computed oracle.

### Required independent oracle

The oracle should be built outside `cohort_forecast_v3.py`. It should read raw snapshot evidence or hand-authored fixture rows and construct semantic masses in a small, explicit pipeline:

1. Resolve the selected anchor-day set.
2. Build `X_A(τ)` for each selected anchor day from carrier-to-`X` observations.
3. Build `Y_A(τ)` for each selected anchor day from subject-end observations.
4. Align those masses on A-clock age `τ = observed_at - anchor_day`.
5. Aggregate by age: `ΣX_A(τ)`, `ΣY_A(τ)`.
6. Derive expected E mode, E+F evidence, and E+F midpoint values from those masses and the forecast continuation rules.

For single-hop `cohort(A, X -> Y)`, the same physical row may contain both the query denominator and the subject-end numerator. The oracle may consume it as a paired `X_A(τ), Y_A(τ)` object, but it should still name those two roles separately.

For multi-hop `cohort(A, X -> Z)`, the oracle must not use the terminal edge's `x` as the chart denominator. It must use the selected A-clock count of arrivals at `X`, and the selected A-clock count of arrivals at `Z`. A test that only uses `C -> Z` rows for `from(X).to(Z)` is testing the wrong object.

### Fixture requirements

The first test should use a deterministic hand-authored fixture, not a stochastic synth graph. The fixture should be small enough that the expected table can be reviewed by eye. It should include:

- at least two selected anchor days;
- an active carrier `A -> X` with denominator growth after the A/B seam;
- a subject span `X -> end` with delayed numerator growth;
- at least one multi-hop subject where the terminal-edge denominator differs materially from the query denominator `X`;
- epoch A and epoch B rows with non-zero numerator so the seam and E/E+F ordering are meaningful.

The expected table should include, for selected ages:

- `X_A_observed(τ)`;
- `Y_A_observed(τ)`;
- boundary denominator at `tau_solid_max`;
- E-mode denominator;
- E+F evidence denominator;
- E-mode rate;
- E+F evidence rate;
- E+F midpoint.

After that hand-authored oracle exists, synth-backed CLI tests should be added as integration coverage. Synth tests are useful for proving that production data loading, hash resolution, FE preparation, BE row generation, and chart normalisation preserve the oracle semantics. They should not be the only proof of algebraic correctness.

### What the test must forbid

The test must fail if any of these occur:

- `rate` or `rate_pure` is derived from `midpoint`, `projected_rate`, fan draws, or any other E+F row field.
- The E line is made plausible by `max()`, `min()`, clamping, or post-hoc comparison against E+F.
- Carrier-only `X_A(τ)` is divided by separately sourced subject-window numerator and rendered as observed evidence.
- A terminal-edge source count is used as the denominator for a multi-hop `X -> end` chart.
- Window/local subject evidence is displayed as selected active-cohort evidence.
- Epoch A/B seam equality is enforced by assignment rather than emerging because the same selected A-clock observed prefixes are part of the E+F trajectory.
- Single-hop is implemented as a separate code path rather than as the one-edge degeneration of the same subject-span algebra.

### Acceptance criteria for the oracle test suite

The test suite is adequate only when it proves all of the following:

- The production chart rows match the hand-authored oracle's masses and rates at named ages.
- For single-hop active cohorts, the same oracle structure reduces to the paired row case.
- For multi-hop active cohorts, the denominator remains the query `X` denominator and never silently becomes the terminal-edge denominator.
- The E-mode line and E+F evidence line differ in epoch B according to their stated denominator semantics.
- The E+F midpoint meets evidence at the seam and sits above E+F evidence in epoch B without any production code comparing those two fields.
- The test can be read without consulting the implementation being tested. Its expected values are derived from the semantics and fixture table, not from the current row-builder logic.

If a future implementer cannot explain a production row as a direct consequence of this oracle, the implementation is not semantically complete, even if the rendered chart looks plausible.


## PROJECTION AUDIT 


Here is the reducer/projection audit from the current cohort_forecast_v3.py.

Active Evidence Extractor
_active_a_clock_evidence_by_tau(...) currently transforms data:

Builds by_anchor_tau from selected_evidence_frames.
Uses snapshot_date - anchor_day as τ for selected evidence.
If x_provider.upstream_obs exists, it replaces/overrides denominator x with carrier-observed X_A(τ).
If no x_provider.upstream_obs, it falls back to selected frame x.
Aggregates to sum_x, sum_y, n_cohorts.
Previously also derived denominator_pure / denominator_fe from boundary logic. That is exactly the kind of hidden semantic transformation we should not trust.
Risk:

This function is not just “extracting” evidence. It is constructing a semantic evidence object by combining selected frame numerator with carrier denominator. That may be correct eventually, but it needs to be explicit, reviewable, and oracle-tested, not hidden under row assembly.
Active Prefix Splicing
_apply_active_selected_evidence_prefixes(...) mutates engine_cohorts.

Transformations:

Builds y_by_anchor_tau from selected evidence frames.
Builds x_by_anchor_tau from x_provider.upstream_obs if available.
Falls back to selected frame x otherwise.
Forward-fills obs_x / obs_y from last seen values across all τ.
Sets frontier_age = max(observed τs).
Mutates x_frozen, y_frozen, evidence_n, evidence_k, eval_age, and the corresponding cohort_list dict.
Risk:

This is a major semantic transformation. It changes the reducer input rather than exposing a separate SelectedAClockEvidence object.
Forward-fill may hide whether a value was actually observed or carried.
frontier_age = max(tau_x ∪ tau_y) may be wrong if denominator and numerator have different availability.
This mutation makes later code look like it is consuming normal CohortEvidence, but the object has been rewritten.
E+F Reducer
_selected_cohort_group_rate_draws(...)

Transformations:

Uses observed prefix where τ <= frontier_age.
Uses model projection for τ > frontier_age.
For active carrier:
denominator future: x_frozen + (a_pop - x_frozen) * R_carrier;
Pop D numerator: residual subject progression for users already at X;
Pop C numerator: future X arrivals convolved through subject span.
Aggregates masses across selected cohorts and divides once.
This is the proper place for projection algebra, but its correctness depends entirely on engine_cohorts containing the right selected A-clock prefixes and frontier.

Risk:

If engine_cohorts were mutated incorrectly upstream, the reducer faithfully computes the wrong object.
The reducer does not know whether obs_x/obs_y are real selected evidence, carried values, or patched values.
Row Projection
_project_runtime_rows(...)

Transformations:

Builds rate_draws from _selected_cohort_group_rate_draws.
Computes midpoint, fan_*, projected_rate from quantiles/mean of rate_draws.
Separately aggregates evidence from engine_cohorts.
Active branch overrides evidence fields from active_evidence_by_tau.
Computes rate / rate_pure.
Suppresses midpoint before seam only for non-active carrier: if tau < tau_solid_max and not is_active_carrier: midpoint = None.
Risks:

Active and non-active rows have different midpoint gating.
Evidence fields are not a passive readout of one object; they are overridden.
E, E mode, E+F evidence, and midpoint are all assembled in one function, making cross-contamination easy.
Major Red Flags
The biggest red flags are:

_apply_active_selected_evidence_prefixes mutates CohortEvidence instead of introducing a first-class semantic object.
_active_a_clock_evidence_by_tau mixes extraction and semantic construction.
frontier_age and tau_solid_max are still derived from mutable/coerced structures, not from an explicit evidence-availability map.
The row builder still knows too much about E/E+F display semantics.
What Review Should Demand
Before more fixes:

Define a typed internal object, even if just a dataclass: SelectedAClockEvidence(anchor_day, tau, x_at_query_x, y_at_subject_end, observed_real_or_carry, source_provenance).
Make rate, rate_pure, and midpoint read from this object and projection object explicitly.
Remove hidden mutation of engine_cohorts or isolate it behind a named conversion with invariants.
Add debug output that dumps per-τ masses: X_obs, Y_obs, X_projection, Y_projection, frontier_by_anchor.
Only then compare to chart rows.
That is the engine we need to see. Right now the engine is partly hidden by object mutation and field overrides.
