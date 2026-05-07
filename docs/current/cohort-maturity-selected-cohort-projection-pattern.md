# Cohort Maturity Selected-Cohort Projection Pattern

**Status**: design sketch — companion to the wrong-object problem statement  
**Date**: 5-May-26

## Purpose

This note sketches the implementation pattern that follows from `docs/current/cohort-maturity-mc-wrong-object-problem-statement.md`.

The important conclusion is narrow: fixing the cohort maturity E+F surface does not require a new MC pass, a parallel engine, or the 73p hierarchical per-Cohort posterior work. It requires changing what the existing runtime particles are projected into.

The current primitive runtime already owns conditioning, carrier composition, subject-span composition, and draw coherence. The missing object is the selected-Cohort trajectory reducer that turns those existing draw families plus the selected dated Cohorts' observed prefixes into the chart's group trajectory.

## Terminology Guardrails

Use **Cohort** for one selected dated population, defined by `anchor_day`.

Use **`cohort()`** for the QueryDSL mode. `cohort()` is not the population object.

In `window()` mode, the selected Cohort is rooted at the denominator node `X`; the carrier is identity and `x` is fixed for that selected Cohort.

In `cohort()` mode, the selected Cohort is rooted at the anchor node `A`; denominator mass at `X` is owned by `carrier_to_x`. The displayed rate remains `Y / X`, never `Y / A`.

The subject progression object is always the full `X -> end` span. A multi-hop subject must not collapse to the terminal edge.

## Current Live Projection

The live v3 row path is `compute_cohort_maturity_rows_v3` in `graph-editor/lib/runner/cohort_forecast_v3.py`.

For E+F rows, `_project_runtime_rows` currently obtains per-τ draws from `_runtime_per_tau_rate_draws`, which delegates to `_composed_pair_per_tau_rate_draws`.

That current projection reduces the runtime to one request-level rate curve per particle. In words, it projects subject probability draws through the composed subject/carrier timing surfaces and divides into a rate before selected-Cohort observed prefixes are part of the trajectory.

That is a valid model-curve object. It is not the chart's selected-Cohort maturity object.

Once projection has returned request-level rate draws, the row builder has already lost the distinction between:

- selected Cohorts that are still observed at age τ;
- selected Cohorts past their frontier;
- observed numerator and denominator mass;
- forecast numerator and denominator mass;
- identity-carrier and non-identity-carrier denominator continuation.

Those distinctions are exactly what the E+F chart surface needs.

## Required Projection Object

The E+F projection should reduce masses before it reduces to rates.

For each selected Cohort, each particle, and each age on the row grid, the projection must construct:

- denominator mass at `X`;
- numerator mass at the subject end.

It then sums numerator and denominator masses across the selected Cohorts and divides once per particle and age. The row midpoint and fan are quantiles of that final selected-Cohort group trajectory.

This is the central replacement: E+F rows should read selected-Cohort aggregate `ΣY / ΣX` draws, not request-level primitive-span rate draws.

## Inputs Already Available

The selected dated Cohorts and their observed prefixes are already materialised by `build_cohort_evidence_from_frames`.

The reducer can consume the existing `engine_cohorts` fields:

- observed denominator prefix;
- observed numerator prefix;
- frontier age;
- frozen denominator at the frontier;
- frozen numerator at the frontier;
- anchor population for active-carrier denominator continuation.

The runtime draw surfaces are already present on `ResolvedCFRuntime`:

- composed subject span;
- optional composed carrier span;
- subject probability draws;
- subject timing draws;
- carrier timing draws when the carrier is non-identity;
- identity-carrier cases represented by absence of a composed carrier.

No new evidence acquisition path is implied by this projection change. No new stochastic pass is implied.

## Reducer Behaviour

The reducer is a single algebra with carrier identity represented as data.

For ages at or before a selected Cohort's frontier, observation is authoritative. Every particle contributes the same observed denominator and numerator values for that Cohort at that age.

For ages past the frontier, the observed frontier values become the calibration point. Forecast continuation extends the selected Cohort from its own frontier evidence using the existing particle's timing surfaces — the calibrated CDF ratio of `cohort-maturity-fan-chart-spec.md` §5.2.1, evaluated per particle rather than per deterministic estimate.

In identity-carrier cases, denominator continuation is fixed after the frontier because the selected population is already at `X`.

In non-identity-carrier cases, denominator continuation is governed by `carrier_to_x`. The numerator continuation remains governed by the subject span from `X` to the subject end. Carrier and subject are not multiplied into a path rate; they remain denominator and numerator mass surfaces until the final group `ΣY / ΣX` division.

Each Cohort carries a calibration anchor at `(τ_d_frontier − lag_d)`, where `lag_d` is the cohort-to-`X` anchor offset. In window mode (carrier identity), `lag_d = 0` for every Cohort and the calibration anchor reduces to the cohort's `τ_d_frontier`. In active-cohort mode, `lag_d` derives from the carrier path latency. The reducer body itself remains uniform — it always passes `lag_d` to the CDF lookup. Only the value of `lag_d` differs by mode, and that derivation lives upstream of the reducer in the cohort materialisation step.

Sparse Cohorts naturally degenerate. A Cohort with no observed evidence (`x_d_frozen = y_d_frozen = 0`) contributes zero numerator and zero denominator at every τ — its weight in the aggregate falls to zero and the group rate is unaffected. A Cohort with observed `x` but zero `y` contributes the observed `x` to the denominator and zero to the numerator, correctly pulling the aggregate toward zero. No fallback branch is required.

Fan width is the empirical particle quantile of `rate_s(τ)` across particles, not an analytic conditional-variance derivation. Empirical quantiles are honest about non-Gaussianity in the latency posterior and remain consistent across the seam, the early-forecast region, and the asymptote. The §5A.2 closed-form conditional variance is a valid alternative for diagnostic purposes but is not the row-emitted band.

The reducer should stream over selected Cohorts and accumulate two draw-by-age arrays: total numerator mass and total denominator mass. It does not need to materialise a permanent selected-Cohort by particle by age tensor unless a test or diagnostic explicitly needs that shape.

## What Changes In The Row Builder

The E+F source in `_project_runtime_rows` changes from the request-level rate projection to the selected-Cohort trajectory reducer.

Model overlays can continue to use the request-level composed model curves. That keeps F-mode semantics separate: model overlays show the primitive/span model surface; E+F rows show the selected-Cohort evidence-plus-forecast trajectory.

The row schema need not change for this step. The values behind `midpoint`, `fan_*`, `fan_bands`, and `projected_rate` change because their draw family now represents the selected-Cohort aggregate trajectory.

## What This Is Not

This is not 73p. Hierarchical per-Cohort posterior conditioning can later improve the draw source by giving each selected Cohort its own partially pooled posterior draw family. The projection contract here does not require that. It can use the current runtime particles as the shared draw family and still fix the wrong-object defect.

This is not a new MC pass. The existing runtime particles are reused. The projection target changes from a request-level model rate curve to selected-Cohort numerator and denominator masses followed by group aggregation.

This is not a window/cohort branch. `window()`, `cohort(A = X)`, and active `cohort(A != X)` are cases of one carrier/subject algebra. Identity carrier is data; non-identity carrier is data.

This is not an anchoring patch. At fully observed ages the fan collapses and the midpoint equals empirical evidence because every selected Cohort contribution is observed. The seam property follows from the reducer.

## Acceptance Invariants

The first implementation should be accepted against projection-level invariants, not against broad visual impressions.

At `tau_solid_max`, E+F midpoint must equal the observed selected-Cohort group rate and all E+F fan bands must have zero width.

For ages before a selected Cohort's frontier, changing model particles must not change that selected Cohort's contribution.

For ages past a selected Cohort's frontier, the continuation must be calibrated to that selected Cohort's own frontier evidence.

The displayed rate must always be `Y / X`. Active `cohort()` denominator continuation must come from `carrier_to_x`; subject progression must remain `X -> end`.

The model overlay surface must remain distinct from the E+F surface.

## Implementation Shape

The smallest clean code change is one new projection helper in `graph-editor/lib/runner/cohort_forecast_v3.py`, called by `_project_runtime_rows` for E+F draws. A name like `_selected_cohort_group_rate_draws` signals its semantic distinctness from the existing `_composed_pair_*` helpers, which it sits beside. It consumes the same runtime span objects (composed subject, composed carrier, per-particle CDF draws) but projects them into a different semantic object.

The existing `_runtime_per_tau_rate_draws` and the underlying `_composed_pair_per_tau_rate_draws` remain available for model overlays and any consumer that explicitly wants a primitive-span model curve. They are no longer the E+F trajectory authority and the docstrings on both should make that clear, naming the new helper as the canonical chart-trajectory source. They are not deleted; the F-mode model overlays (`model_midpoint`, `model_fan_*`, `model_bands`) and any future consumer wanting the unconditioned model surface still call them.

The helper's output is the same row-consumable draw shape as today: particle-by-age rate draws. Internally it accumulates numerator and denominator masses across the selected Cohorts before dividing once per particle and age.

The helper requires per-particle carrier and subject CDF draws, not just the aggregate `cdf_mean` arrays the row builder currently consumes. The substrate already produces these (`composed_carrier.cdf_draws`, `composed_subject.cdf_draws` when draw-coherent). Plumbing them into the helper is a short change inside the projection layer with no upstream substrate edits.

The helper's quantile step needs to honour the IS-conditioning representation the substrate emits: if the runtime particles arrive carrying weights, the quantiles are weighted; if the substrate has already resampled to uniform weights, plain quantiles are correct. The implementer must check the substrate's contract before writing the quantile call. This is a one-line implementation choice, not a design issue.

## Sequencing

First, pin the projection contract with focused tests in the existing v3 contract surface. A small synthetic with two or three cohorts at staggered frontier ages is enough to pin the seam-meeting and per-Cohort-prefix invariants. Active-cohort tests need a fixture with a non-trivial upstream carrier; that can come second. The tests should be authored against the new contract and should fail on the current request-level projection — they pin what we want, not what we have.

Second, add the selected-Cohort trajectory reducer and switch E+F row projection to it. The previously-emitted E+F midpoint and fan values change; the model overlay surfaces stay put.

Third, scalar surface follow-up. CF currently writes a single `p_mean` per edge by reading the last cohort_maturity row's midpoint. Once the new projection lands, that scalar represents the n-weighted aggregate group rate at the saturation horizon — a real number, but not an obviously interpretable one. The cleaner reformulation is to emit per-Cohort-indexed scalars (each Cohort's eventual rate, with bands), which downstream consumers can either aggregate themselves or display per-Cohort. That work has its own blast radius — `applyConditionedForecastToGraph`, the funnel runner, the bayesian projection all read the per-edge scalars today — and should be written up as its own problem statement once the projection fix is in. It does not block the projection fix; the projection fix can land while CF continues to publish the existing per-edge `p_mean` derived from the new last-row midpoint.

73p remains a later draw-source upgrade, not a prerequisite for this projection correction.

## Phase 2: Active-Carrier Pop D Distributional Clock

Phase 1 has since landed in current code: `_project_runtime_rows` now calls `_selected_cohort_group_rate_draws` for E+F rows, while model overlays still use the request-level `_composed_pair_per_tau_rate_draws` path. The selected-Cohort reducer already does mass-first `ΣY / ΣX` projection, reads draw-coherent subject and carrier CDF surfaces, keeps identity carrier as data, uses carrier residual increments for Pop C, and accumulates observed, Pop D, Pop C, and denominator mass before the final division.

The Phase 2 defect is narrower. In the active-carrier Pop D branch, current code derives a scalar subject-clock shift by taking the truncated mean of the carrier arrival CDF conditional on arrival by the Cohort frontier. That happens inside `_selected_cohort_group_rate_draws` via cumulative carrier PDF moments, then the subject CDF is shifted once for the whole Pop D pool. This collapses the conditioned carrier arrival distribution to one representative age. It loses the fact that people who reached `X` early have had more subject-clock exposure by the frontier than people who reached `X` just before the frontier.

Phase 2 should replace that scalar Pop D shortcut with a distributional readout from the conditioned carrier runtime. The reducer should use the same per-particle carrier arrival increments that already drive active-carrier denominator continuation and Pop C, but restricted to arrivals at `X` no later than the selected Cohort frontier. For each carrier-arrival slice, the subject residual must be evaluated on that slice's own `X -> end` clock age. The weighted sum across pre-frontier carrier-arrival slices becomes the Pop D continuation for that particle and Cohort.

Implementation plan:

- Add focused tests before changing the reducer. One test should construct two active-carrier timing shapes with the same scalar lag summary but different pre-frontier mass distribution; current scalar-lag code should fail because it cannot distinguish them. Another test should pin draw coherence by changing carrier timing in one particle while holding subject timing and probability fixed, proving Pop D follows that particle's carrier arrival increments rather than aggregate `cdf_mean` or snapshot lag metadata.
- Keep the current reducer entry point. This phase edits `_selected_cohort_group_rate_draws`; it does not introduce a new row-builder path, a new MC pass, or a second evidence acquisition path.
- Remove only the active-carrier Pop D cumulative-moment shortcut. The `cum_pdf`, `cum_u_pdf`, `lag_real`, `lag_int`, and subject-CDF `take_along_axis` shift are the target mechanism. Identity-carrier handling should remain a direct subject residual anchored at the Cohort frontier.
- Reuse carrier arrival increments from the draw-coherent carrier CDF. Pop C already builds conditional future-arrival increments after the frontier from the joint carrier reach surface; Phase 2 needs the analogous pre-frontier arrival distribution for Pop D. The implementation should be local and draw-by-draw, not based on `cdf_mean`.
- Preserve Pop D mass calibration. The pool size remains `x_d_frozen - y_d_frozen`; Phase 2 changes the timing mixture used to project that pool, not the observed frontier mass or the final `ΣY / ΣX` aggregation.
- Treat `anchor_median_lag_days` and `anchor_mean_lag_days` as diagnostics or explicitly marked degraded-mode fallbacks only. They must not replace the conditioned carrier distribution in normal active-cohort E+F projection.
- Verify the identity cases after the change: `window()`, `cohort(A = X)`, no-carrier rows, sparse zero-observation Cohorts, and fully observed ages should preserve the Phase 1 invariants.

## Phase 3: Active-Carrier A-Clock Selected Projection

Phase 2 still assumes that the selected-Cohort reducer receives a semantically valid selected-Cohort prefix object. That assumption is false in the current active-carrier path. The frame-preparation path is deliberately window-led so primitives can be conditioned on local/window evidence. Those same frame artefacts are then materialised into `engine_cohorts` as `obs_x`, `obs_y`, `x_frozen`, `y_frozen`, `a_pop`, and `frontier_age`, and the reducer treats them as if they were selected A-clock Cohort prefixes.

That collapses two different objects. Window/local evidence is valid as primitive evidence; it is not automatically valid as the selected `cohort(A, X -> end)` row prefix. In active `A != X`, the selected chart row is an A-clock object. The denominator is carrier arrival at `X` by A-clock age. The numerator is the X-clock subject span projected onto the A-clock by carrier arrival increments. The displayed row rate is the selected-Cohort aggregate `ΣY_A(τ) / ΣX_A(τ)`.

The fix is not to make subject primitives A-clocked. Subject primitives and the composed subject span remain local/X-clocked. The fix is to make the selected-Cohort projection consume the A-clock carrier span and the X-clock subject span directly, then project subject contribution onto the A-clock during row reduction. Active `A != X` must require a composed carrier span; only `window()` and `cohort(A = X)` are identity-carrier degeneracies.

Current evidence materialisation should be split by role:

- Primitive evidence remains window/local and continues to condition carrier and subject primitives through the primitive substrate.
- Selected row base mass is not an optional or missing input under the current window-evidence design. It comes from the most-upstream/root window segment: for the first carrier primitive rooted at `A`, the window row's `n`/`X` count is the selected anchor-day population that reached `A` on that day. Earlier discussion that implied this mass might be unavailable, or that cohort-row `A` was required for the core projection, was wrong. Window evidence plus window model vars are sufficient: root-window `n` supplies the selected A-day mass; the composed carrier supplies A-clock arrival at `X`; the composed subject supplies X-clock progression to `end`.
- Exact same-question `cohort(A, X -> end)` observations, if admitted in a later design, may pin observed prefixes. They are not required for the Phase 3 model-projection fix.
- Window/local target frames must not seed selected active-cohort `obs_x`, `obs_y`, `x_frozen`, or `y_frozen`. They may condition the subject primitive, but they are not selected A-clock row observations.
- Carrier-side window evidence may condition carrier primitives. It should not be used as a partial patch over selected rows unless it is represented as a coherent A-clock selected-prefix object.

Implementation plan:

- Add focused outside-in tests before changing the reducer. One test should use a latent upstream carrier and a multi-hop subject where the current curve rises on the subject/window clock. The expected shape should be derived from carrier-arrival timing convolved with subject-span timing on the A-clock, and it should fail while selected rows are seeded from window/local frames.
- Keep the primitive conditioning path unchanged. The phase must not add cohort-conditioned primitive posteriors, a second evidence acquisition path, or a new MC pass.
- Replace active `A != X` selected-row seeding from `build_cohort_evidence_from_frames` with a selected A-clock projection object. For active carrier rows without exact selected observations, the E+F trajectory is still defined by the resolved runtime's carrier and subject spans; it is not undefined and it must not fall back to X-clock observed frame prefixes.
- Rework the E-mode display for active `A != X`: evidence-only rows should be absent unless exact selected A-clock observations are available. Do not display window/local subject evidence as selected A-clock evidence.
- Keep model overlays separate. F-mode overlays may continue to use the request-level composed model-curve readout, but E+F rows must be the selected A-clock aggregate projection.
- Treat missing active-carrier composition as a hard degradation for active `A != X`, not as a permission to use identity carrier or window-prefix rows. Identity carrier is valid only for `window()` and `cohort(A = X)`.

Acceptance invariants:

- For active `cohort(A, X -> end)`, early selected E+F numerator mass cannot outrun the carrier-arrival timing into `X`; subject progression only starts once mass arrives at `X`.
- The denominator and numerator are both evaluated on the same A-clock row grid before division.
- `window()` and `cohort(A = X)` remain unchanged identity-carrier degeneracies.
- Exact selected A-clock observations, when present, remain authoritative up to their frontier; window/local primitive observations never masquerade as those selected prefixes.

## Phase 3 Implementation Plan

Status: draft for peer review (rev 3 — incorporates two rounds of
review feedback). The Phase 3 body above defines the semantic contract:
replace active `A != X` selected-row seeding from
`build_cohort_evidence_from_frames` with a selected A-clock projection
object, sourced from the resolved runtime's carrier and subject spans
plus the root-window selected base mass — never from window-prepared
X-clocked target frames. This appendix is the concrete plan for that
work.

What this plan IS:

- A model-projection display for active `A != X` rows. The selected
  A-clock denominator and numerator are computed from the composed
  carrier reach / CDF and the carrier ⊗ subject reach / CDF, scaled by
  the selected base mass. The displayed rate is the ratio of those two
  scaled scalars.

What this plan IS NOT:

- Not a projection-only change. Phase 3 must emit actual A-clock
  evidence for active `A != X`, not just the E+F model projection. The
  observed denominator and observed numerator must be A-clock selected
  evidence; model projection must never be written into evidence-named
  fields.
- Not a reuse of the carrier edge's window evidence as a synthesised
  cohort-evidence prefix beyond the narrow base-mass role. The first
  carrier edge's window `n` at A is admissible as the selected A-day
  base mass because that edge is rooted at A; that is the only role
  this plan extracts from raw carrier window rows. The downstream
  `k` from those same rows continues to condition the carrier
  primitive through the existing primitive-conditioning path and is
  not lifted into a prefix.
- Not a fabricated `obs_y` from subject window rows. The earlier draft
  proposed combining carrier arrival increments with subject-window
  empirical rates to synthesise an A-clock numerator. Peer review
  identified that as exactly the "raw rows on the wrong clock" reuse
  the canonical admissibility matrix forbids. It is rejected here and
  recorded as a rejected research direction.

### Computed display object for active `A != X`

The chart's evidence-named fields (`rate`, `evidence_x`, `evidence_y`)
are reserved for actual observed series — they carry semantic weight
in the chart contract and the chart renders them as observed evidence.
For active `A != X`, Phase 3 must populate them from actual selected
A-clock evidence. They must not be populated from model projection, and
they must not be populated from X-clock target-window frames.

The selected A-clock projection is delivered through the
projection-named fields the chart already renders distinctly from the
observed series — `midpoint`, `fan_upper`, `fan_lower`, `fan_bands`.
These come from the per-particle selected-cohort group rate reducer
and are sourced from the same composed carrier and subject runtime
surfaces that drive the moment-level scalars discussed below; the
active-carrier midpoint ungate (described under Boundary conditions)
allows them to render across the full chart range rather than being
gated to epoch B, so the projection covers the chart even where there
is no observed evidence to overlay.

Active correctness depends on the per-particle reducer being scaled
by the right base mass. The active path therefore constructs
`engine_cohort.a_pop` directly from the root-window carrier evidence
rather than reusing whatever value
`build_cohort_evidence_from_frames` happens to have placed on the
cohort from the composed target-frame bundle:

- The anchor population per A-day is the root-window `n` from the
  first carrier primitive rooted at A: the count of the population
  that entered the anchor on that day, read from the root-window
  evidence. This is the only admissible source for the selected
  A-day base mass — it is rooted at A and so carries cohort identity
  at the anchor by construction.
- For each selected A-anchor day, the active builder reads the
  per-cohort `n` off the first carrier primitive's root-window
  evidence and writes it into the engine cohort. The frame-bundle
  `a` value is not consulted for active queries; the active path
  treats the root-window carrier `n` as the only source. Cohorts
  with no admissible root-window evidence get `a_pop = 0` and are
  excluded from active projection. The active builder records the
  source on the request provenance per cohort so the invariant is
  verifiable per request.

The deterministic moment-level projection scalars (selected A-clock
denominator equals base mass times carrier reach times carrier CDF;
selected A-clock numerator equals base mass times carrier reach times
subject reach times the carrier ⊗ subject convolved CDF; rate equals
numerator divided by denominator) remain conceptually well-defined.
They agree in shape and limit with the per-particle reducer's median
and mean output but are not the same statistic — ratio of means is
not in general the mean of per-particle ratios. They are not emitted
into any row field by Phase 3. If a future atom adds a moment-level
projection display the new fields it introduces must be distinct from
the evidence-named fields the chart treats as observed, and the
admission of those fields is itself a chart-contract change requiring
peer review.

Completeness in the active path comes from the same root-window
foundation as `a_pop`. Per-cohort eval ages and weights for the
n-weighted completeness scalar are sourced from the active builder
rather than from the placeholder frame-driven cohort list whose
`evidence_n` collapses to zero under the active prefix-zeroing.

Completeness in the active path comes from the same projection. The
existing completeness path takes per-cohort eval ages from
`fe.cohort_list` and per-cohort weights from `evidence_n`, both of
which collapse to zero for active queries under the placeholder
zero-prefix and would silently degrade completeness to None or zero.
The active builder replaces both inputs: per-cohort eval age is the
A-clock age at which the row builder evaluates that cohort (the row
horizon for cohorts whose carrier has not yet saturated, or the
cohort's last meaningful frontier on the carrier surface), and the
per-cohort weight is the cohort's `a_pop` as defined above. The
n-weighted completeness scalar that downstream consumers (CF endpoint,
public scalars) read continues to come from the same
`_runtime_completeness` helper, but its inputs for active queries are
sourced from the active builder, not from the placeholder
frame-driven cohort list.

### Identity-carrier cases

Window mode and `cohort(A = X)` are identity-carrier degeneracies and
are unchanged by this plan. Their selected population is already
rooted at X, the per-cohort observed prefix from the existing
frame-driven builder is the correct selected-prefix object, and the
existing per-tau loop continues to drive `obs_x` / `obs_y` / rate from
those prefixes. The new active path is invoked only when the
active-carrier predicate (composed carrier present and population root
is not the denominator node) is true.

### Multi-hop carrier

Multi-hop carriers — the carrier topology between the anchor and X is
more than one edge — present no special problem to the displayed
projection. The composed carrier in the resolved runtime already
represents the multi-hop A → X timing and reach; the displayed
denominator scalar reads from that composed surface uniformly across
single-hop and multi-hop carriers. No additional per-edge composition
or "evidence-level" composition is required for the projection
display. The earlier draft's "evidence-level Fenton-Wilkinson"
phrasing was misleading and is withdrawn.

The runtime's composed carrier already exists for the rate fan to
work; this plan adds no new composition machinery.

### Boundary conditions

- Active-carrier predicate true: composed carrier is present and the
  population root differs from the denominator node. Run the new
  projection display path.
- Composed carrier missing for an active query: hard degradation.
  Active `cohort(A, X-end)` requires a carrier; without one no
  selected-cohort projection is meaningful. The chart enters an
  explicitly degraded state — denominator, numerator, rate, midpoint,
  and fan are all absent for active rows — and the request provenance
  records "no active cohort projection available: composed carrier
  missing". The model overlay is not a stand-in for a missing
  projection here and must not be presented as the active-cohort
  display.
- Selected base mass is zero (every selected cohort has zero anchor
  population): denominator is zero, numerator is zero, rate is None.
  Do not render zero rate. The chart treats this row as absent on the
  rate axis; denominator and numerator are reported as zero so the
  forensic surface shows the empty cohort honestly.
- Identity carrier (window, `cohort(A = X)`): bypass this path.

### Acceptance invariants

- Active `cohort(A, X -> end)` with composed carrier present and any
  selected base mass: the chart shows the projected denominator and
  numerator scalars and the rate they imply, across the full row
  range. The displayed rate respects `Y / X`, not `Y / A`.
- The displayed scalars and the per-particle rate fan come from the
  same underlying object: the displayed rate is the moment-level
  projection, the fan is the per-particle aggregation; they agree at
  the limit and remain coherent in shape across the chart.
- The display path and the reducer read the same fields off the same
  composed runtime objects, never parallel-derived equivalents. Any
  change to the composed surfaces moves both paths together.
- Window mode and `cohort(A = X)` are unaffected; their existing
  observed-prefix path produces `obs_x` / `obs_y` / rate as today.
- For active projection, `a_pop` per cohort is root-window `n` from
  the first carrier primitive rooted at A. It is never derived from
  downstream target frames or from any value materialised out of
  composed window-prepared frames.
- For active projection, completeness inputs (`cohort_eval_ages`,
  `cohort_weights`) are sourced from the active builder, not from the
  placeholder frame-driven cohort list whose `evidence_n` collapses
  to zero under the active prefix-zeroing.
- The carrier edge's window evidence is used only as the selected
  A-day base mass and to condition the carrier primitive; it is not
  lifted into a synthesised cohort-evidence prefix.
- Subject window evidence is used only to condition subject primitives
  and to feed the runtime's composed subject span; it is not used to
  synthesise an A-clock observed numerator series.

### Plumbing

The wrapper already receives `per_edge_upstream_evidence` and
`per_edge_subject_evidence` and threads them into the request
candidate pool that feeds primitive conditioning. No additional
plumbing of evidence sets into the row-display path is required for
this plan, because the displayed scalars come from the resolved
runtime's already-composed carrier and subject spans.

The placeholder zero-prefix that `build_cohort_evidence_from_frames`
currently writes for active queries continues to populate `obs_x` /
`obs_y` / `x_frozen` / `y_frozen` / `frontier_age` with zeros so the
reducer's Pop D pool collapses to zero and the projection drives the
fan. The row builder's active-carrier branch in the per-tau loop
replaces the zero-prefix-derived display values with the projection
scalars described above.

### Sequencing

- Active builder atom: introduce the active-cohort builder. For
  active queries it (a) constructs `engine_cohort.a_pop` per selected
  A-anchor day from root-window `n` on the first carrier primitive
  rooted at A, ignoring the composed target-frame `a` value; (b)
  emits per-cohort eval ages and weights for completeness on the
  same root-window foundation rather than from the placeholder
  prefix; (c) records the source of `a_pop` and the completeness
  inputs on the request provenance per cohort. Keeps the prefix
  zero-fill so the reducer's Pop D collapses and the projection
  drives the fan.
- Display projection atom: route the row builder's active-carrier
  display scalars (denominator, numerator, rate) through a single
  helper that returns moment-level reads of exactly the same composed
  carrier and subject fields the reducer's per-particle path uses.
  The row builder does not derive these surfaces locally. Keep the
  active-carrier midpoint ungate so the per-particle fan renders
  across the full chart range coherent with the projection scalars.
- Parity test atom: synthetic-runtime fixture that pins (a) the
  projection algebra (denominator equals base mass times carrier
  reach times CDF, numerator equals base mass times carrier reach
  times subject reach times convolved CDF, rate is the ratio); (b)
  display-vs-reducer agreement at the limit and shape coherence
  across the chart, so any future drift between the two scalar paths
  fails a test rather than appearing as a silent chart inconsistency;
  (c) `a_pop` provenance — the test fixture supplies a known
  root-window `n` and the test asserts the active builder's `a_pop`
  matches it and provenance records the root-window source.
- Identity regression atom: re-run the existing window and
  `cohort(A = X)` regression tests to confirm the active-carrier
  branch does not perturb identity-carrier rendering or completeness.

### Future work after Phase 3

- Exact-prefix extension: richer exact `cohort(A, X -> end)` prefix
  pinning beyond the Phase 3 evidence required for the chart may be
  designed separately.
- Multi-hop evidence composition beyond the immediate Phase 3 evidence
  path remains a separate count-flow problem. It must compose observed
  counts over upstream edge arrivals, not by Fenton-Wilkinson moment
  matching.

### Rejected directions

- Subject-helper `obs_y` construction: combining the carrier's
  per-cohort incremental arrivals at X with the subject window's
  per-X-cohort empirical conversion rate to synthesise an A-clock
  observed numerator. Peer review identified this as raw subject
  rows on the wrong clock entering the displayed observed series.
  The canonical admissibility matrix forbids it; rejected.
- Carrier window rows lifted into a synthesised cohort-evidence
  prefix beyond the base-mass role: claiming that the first carrier
  edge's window evidence is "coincident with cohort-evidence(A, A-X)"
  and using its full per-snapshot history as the displayed `obs_x`
  prefix series. Peer review judged this overreach: only the `n` at
  A is safe to lift as the selected A-day base mass; the `k` flow
  remains primitive-conditioning evidence. Rejected for Phase 3;
  may be revisited under the future-work exact-prefix-pin item with
  explicit admissibility gates.
