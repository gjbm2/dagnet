# 55 — Surprise Gauge Rework: Thin Projection of the Conditioned-Forecast Sweep

**Status**: Design — awaiting approval
**Date**: 20-Apr-26
**Supersedes** (on approval + implementation): the Phase-1 analytic formulas in `docs/current/codebase/surprise-gauge-design.md` §5.1 and §5.2. The design-principles in §8 of that doc are preserved.

**Related**: doc 29 / 29e / 29f (generalised forecast engine), doc 47 (whole-graph CF pass), doc 49 (epistemic/predictive separation), doc 50 (CF generality gap), doc 51 (subset-conditioning correction), doc 31 (analysis subject resolution), `FE_BE_STATS_PARALLELISM.md` (FE/BE topo pass + CF orchestration).

---

## TL;DR

The surprise gauge is currently two parallel implementations: a full
MC-based engine path on the backend and an analytic fallback duplicated
on the frontend. They disagree, the frontend wins the user's eyes, the
frontend is wrong in cohort mode, and the backend's correct result is
silently discarded by the augmentation merge.

The rework replaces all of that with a thin backend projection of the
existing Conditioned-Forecast (CF) sweep output. Scope contracts to two
variables: `p` (conversion rate) and `completeness` (maturity). Both are
single-number summaries of sweep draws. The frontend local-compute path
is deleted. The analytic fallback is deleted. If the sweep cannot run
for the current subject, the gauge reports itself unavailable with a
reason, rather than substituting a second-class formula.

The driving principle is "reduce surface area is its own reward": the
gauge should own no bespoke maths. Everything it needs already exists
inside the sweep machinery that cohort-maturity v3, the topo pass, and
the whole-graph CF pass all rely on.

---

## 1. Why rework

A full trace of the current implementation lives in the conversation
that led to this doc; the salient points are:

- The frontend computes the gauge locally via
  `buildSurpriseGaugeResult` and shows that result to the user. It
  ignores window-vs-cohort mode (parses only `from/to` from the DSL),
  reads a static topo-pass completeness scalar that is not re-projected
  when the DSL changes, and reads edge-aggregate evidence counts that
  are not window-sliced. None of these three inputs change when the
  user switches temporal mode, so the gauge does not change either.
- The backend's engine path (`_surprise_gauge_engine_p`) computes the
  correct MC posterior-predictive z-score for the current subject, in
  either window or cohort mode, using the same sweep primitives as
  cohort-maturity v3. It runs on every refresh. Its result is then
  overwritten on the frontend by the local result when
  `mergeBackendAugmentation` retains `...local` and only merges `data`
  (not `variables`).
- The backend also carries a Phase-1 analytic fallback
  (alpha/beta method-of-moments reconstruction plus
  `var_post + var_samp + var_c`) that duplicates the frontend analytic
  formula in Python. It is dead code in practice but expands the
  surface area.
- The gauge reads the `analytic_be` model_vars entry directly to
  source "observed" latency parameters. `analytic_be` is the output of
  the backend topo pass; it is only privileged when promotion picked
  it. Reading it as a special entry violates the source-agnostic
  promotion contract.
- Generation-counter and 500ms race coordination exist between the
  topo pass, the BE topo pass, and CF, but there is no subscription
  mechanism by which a downstream analysis can be told "CF output for
  this subject is now available". Every consumer races independently.

The underlying engine is right. The problem is that the gauge did not
ride on it.

---

## 2. First principles

### 2.1 What the gauge is

A per-edge, per-query-context diagnostic that asks: "given the Bayes
model on this edge and the observed evidence in the current window or
cohort scope, is anything surprising?" It is rendered as one or more
gauge-shaped visualisations; semantically it is a small list of
`{observed, expected, uncertainty, z}` tuples.

### 2.2 What a "variable" in the gauge must have

For the surprise framing to be honest, a variable needs three things:

1. A **model distribution** — either the posterior over the quantity,
   or a derived posterior-predictive for what we should observe.
2. An **observed summary** — a single number drawn from the current
   window's data, comparable to (1) on its own terms.
3. A **combined uncertainty** accounting for both posterior
   uncertainty and any residual sampling noise on (2).

When any of the three is absent or unreliable, the variable should
report itself unavailable rather than fabricate something.

### 2.3 What the CF function already gives us

The CF engine function of record is `compute_forecast_summary`
(`graph-editor/lib/runner/forecast_state.py`). A sibling function
`compute_forecast_trajectory` exists in the same module — it produces a
full per-τ trajectory (S × T matrix) for the cohort-maturity chart,
using a different (sequential per-cohort) IS strategy. The gauge is
interested in scalar summaries, not trajectories, and therefore uses
`compute_forecast_summary` — which also uses the correct aggregate
IS strategy for a window-level "how surprising is the whole window"
question.

`compute_forecast_summary` is invoked with resolved model params,
the subject's cohort ages and weights, a separate list of cohort
evidence `[(τ_i, n_i, k_i), ...]` for IS conditioning, and optionally
a carrier arrival cache. It draws S samples of `(p, μ, σ, onset)` from
the posterior, runs aggregate tempered-IS against the cohort evidence,
and returns:

- Conditioned and unconditioned draws of `(p, μ, σ, onset)`.
- `completeness, completeness_sd` — n-weighted mean and SD of the
  CDF across **conditioned** draws. This is what CF writes to
  `edge.p.latency.completeness`.
- `rate_conditioned, rate_conditioned_sd` — conditioned mean(p).
- `rate_unconditioned, rate_unconditioned_sd` — unconditioned mean(p),
  with a comment in the source explicitly noting "used by surprise
  gauge as baseline".
- `is_ess`, `is_tempering_lambda` — IS diagnostics.

The `p` draws used are drawn from the **predictive** alpha/beta
(kappa-inflated per doc 49), not the epistemic alpha/beta. This is
correct for the surprise gauge: the gauge asks "is what we observed
a plausible realisation of what the model would generate?", which
requires the observation-noise-inflated distribution. If predictive
alpha/beta are unavailable the function falls back to epistemic.

### 2.4 What falls out for free, what needs exposing

What the CF function **already returns** and the gauge needs:

- **Conditioned completeness**: `completeness, completeness_sd`
  (directly read).
- Unconditioned and conditioned `(p, μ, σ, onset)` draws.

What the CF function **computes internally but does not return**:

- **Unconditioned completeness** moments — the local variable
  `mc_completeness_unconditioned` in `compute_forecast_summary`
  (the same `_weighted_completeness_draws` helper is called on the
  unconditioned draws). Not currently in the return struct.
- **Posterior-predictive expected rate (unconditioned)** — the mean
  and SD of `p_s × c̄_s` across unconditioned draws. `p_draws_unconditioned`
  and `mc_completeness_unconditioned` are both present internally; the
  element-wise product and its moments are not computed or returned.

Two small scalar-field additions to `ForecastSummary` close the
gap:

- `completeness_unconditioned, completeness_unconditioned_sd` — mean
  and SD of `mc_completeness_unconditioned`.
- `pp_rate_unconditioned, pp_rate_unconditioned_sd` — mean and SD of
  `p_draws_unconditioned * mc_completeness_unconditioned` (element-wise).

Both additions reuse existing locals; the implementation is on the
order of half a dozen lines, adjacent to the existing unconditioned
computation block inside `compute_forecast_summary`.

Aggregate observed `(Σk, Σn)` for the gauge's `p` comparison comes
from the same cohort evidence list the gauge passes into
`compute_forecast_summary`; the handler sums it alongside the call.

After those additions, the gauge is a pure projection: zero maths in
the gauge handler, no IS, no cohort loops, no CDF evaluations. It
reads the scalars, computes the observed aggregate, produces two
z-scores.

### 2.5 What is out of scope

Latency parameters μ and σ, and the onset dead-time, are descoped. They
are obscure relative to `p` and `completeness`, they require an
observed lag summary (median or mean lag days) that is not currently an
output of the sweep, and incorporating them pragmatically would force
the gauge to read `analytic_be` as a special source again. If a future
iteration of the sweep exposes observed lag statistics as a
first-class output, these variables can be re-introduced under the
same projection pattern. Until then, the gauge is silent on them.

---

## 3. The two variables

### 3.1 Variable `p` — conversion rate

The posterior-predictive expected rate at the current window's maturity
is, per draw, the cohort-n-weighted product of the draw's long-run
conversion probability and its per-cohort completeness. Across all
draws this produces a distribution of expected rates with a mean and
an SD that already absorb maturity uncertainty, onset-μ correlation,
and carrier convolution where applicable. The draws are taken from the
**predictive** alpha/beta per doc 49 (kappa-inflated): the gauge asks
whether the observed aggregate is a plausible realisation of the
model, so the observation-noise-inflated distribution is the correct
comparator.

The observed counterpart is the aggregate conversion rate over the
same cohorts the CF call was passed: total observed conversions
divided by total cohort population in scope (`Σk / Σn`). The gauge
handler sums these from the same evidence list it hands to
`compute_forecast_summary`; it does not read `edge.p.evidence.k/n`.

The z-score is the signed distance of the observed aggregate from
`pp_rate_unconditioned`, measured in `pp_rate_unconditioned_sd`. The
quantile is the normal CDF of z. The zone is classified from the
quantile using the existing symmetric or directional colour schemes
(unchanged).

This matches the intent of the current backend engine path; the
changes are (a) it calls `compute_forecast_summary` rather than
`compute_forecast_trajectory` (which is the chart function), (b) it reads
the two `pp_rate_unconditioned*` scalars instead of recomputing
`p_s × c̄_s` inline, and (c) its result is delivered to the frontend
without being overwritten by a parallel computation.

### 3.2 Variable `completeness` — maturity

Completeness is a model-derived quantity: the fraction of eventual
conversions expected to have occurred by now in the current window. It
has no direct empirical counterpart — the true ultimate rate is the
very thing we are estimating. A useful surprise framing nonetheless
exists: **unconditioned vs conditioned**.

- **Unconditioned completeness** is the n-weighted mean completeness
  across raw posterior draws. It answers: "before looking at this
  window's observed conversions, what does the model think maturity
  is here?" Supplied by the proposed `completeness_unconditioned` /
  `completeness_unconditioned_sd` fields added to `ForecastSummary`.
- **Conditioned completeness** is the same n-weighted mean, taken
  across the tempered-IS-reindexed draws that
  `compute_forecast_summary` already produces internally.
  Supplied by the existing `completeness` / `completeness_sd` fields
  (the same values CF writes to `edge.p.latency.completeness`).

When the conditioned mean sits far from the unconditioned mean
relative to the unconditioned SD, the evidence is telling us the lag
distribution in this window is materially faster or slower than the
aggregate posterior suggested. That is a meaningful form of surprise
and it parallels the structure of the `p` variable: an observed
thing is compared to a model-predicted thing in standardised units.

Rendering convention: the **dial** shows the expectation — the
unconditioned mean and SD with the existing coloured zones centred
on it. The **needle** points to the conditioned mean — the
evidence-informed reality. Same colour scheme as `p`; zone is
classified from the z-score (distance from unconditioned mean in
unconditioned SDs), not from any separate scheme.

The detail text shows both values explicitly — something to the
effect of "model: 67% → evidence: 72% (± 3%)" — so the shift is
legible on the face, not just implied by the needle offset.

When the IS effective sample size is low (the tempered-IS fell back
to a small effective draw count because likelihoods concentrated on
few draws), the conditioned moments are still rendered but flagged
with a warning icon and tooltip ("limited evidence — conditioned
view based on a small effective sample"). This uses the same warning
mechanism the gauge already has for non-Bayesian model sources. The
gauge degrades gracefully; it does not suppress display.

### 3.3 Failure modes

A variable is unavailable, with a stated reason, if any of the
following hold:

- `resolve_model_params` returns nothing usable for the current scope
  and temporal mode.
- The snapshot query returns no rows for the subject's anchor range.
- The cohort evidence derived from the snapshot rows contains no valid
  cohorts (no positive population after filtering).
- `compute_forecast_summary` raises or returns empty draws.
- The unconditioned posterior-predictive SD is effectively zero (the
  model has degenerated to a point mass; nothing is surprising by
  construction).

Low IS ESS is **not** a failure mode and **not** surfaced to the
user as a warning either. With `_IS_TARGET_ESS = 20` enforced inside
`compute_forecast_summary`, the post-tempering ESS is bounded in
`[20, S]` whenever conditioning fires; a value near the floor signals
strong prior–evidence divergence, which is the gauge's whole point —
not a weak-evidence diagnostic. An earlier `'limited_evidence'`
warning was removed (20-Apr-26) because the metric was a
sampling-quality diagnostic, not an evidence-quantity one, and so
fired precisely when the surprise signal was strongest.

There is no analytic fallback, no method-of-moments reconstruction, no
"best effort" number for the failure modes above. Unavailable means
unavailable, and the gauge face renders an explanatory placeholder
rather than a dial.

---

## 4. Architectural changes

### 4.1 Single path on the backend

The gauge becomes a backend-authored analysis in the same sense as
cohort-maturity v3. It reuses the same subject resolution (doc 31), the
same snapshot query, the same cohort-evidence derivation, the same
sweep call, and the same carrier arrival cache. The only gauge-specific
code is the projection step that turns a sweep result into two
`{name, observed, expected, sigma, quantile, zone, available}` entries.

Writing that projection as a small helper alongside the chart handler
is a natural way to share setup. Whether it is physically a separate
function or an additional post-processing step on the chart handler's
sweep is an implementation detail.

### 4.2 No frontend local compute

The frontend stops computing the gauge. `surprise_gauge` is removed
from `LOCAL_COMPUTE_TYPES`, `buildSurpriseGaugeResult` and its helpers
(`_computeCompletenessAtRetrievedAt`, the dedicated alpha/beta and
combined-SD paths, the mu/sigma/onset blocks) are deleted, and the
local-path tests that exercise the gauge are deleted with them. The
frontend's job is limited to building the request, rendering the
backend response, and surfacing "unavailable" states in the gauge UI.

### 4.3 No analytic fallback on the backend

The Phase-1 analytic formula branches inside `_compute_surprise_gauge`
— alpha/beta reconstruction, `var_post + var_samp + var_c`,
scalar-completeness adjustment — are deleted. The engine path becomes
the only path. Variables are either computed from sweep draws or are
unavailable.

### 4.4 No special reads from `analytic_be` or scalar completeness

The gauge stops consulting the `analytic_be` model_vars entry as a
source of observed latency parameters, and stops reading
`edge.p.latency.completeness` as a scalar input. The former is only
meaningful when promotion selected it; the latter is a topo-pass
output that is not re-projected when the query DSL changes. Both were
symptoms of the gauge pretending to a source of truth it never owned.

The gauge also stops reading `edge.p.evidence.k/n`. The observed
aggregate is computed inside the gauge handler from the same cohort
evidence list it hands to `compute_forecast_summary`. Observed
and expected therefore come from a single shared source, not two
decoupled ones.

### 4.5 Subject-resolution and DSL context

The gauge's subject continues to flow through the existing subject
resolver (doc 31) with `scopeRule: single_edge` and
`timeBoundsSource: query_dsl_window`. Window-vs-cohort intent is
captured in the `temporal_mode` passed to `resolve_model_params`, which
already selects between edge-level and path-level posteriors and
between edge-level CDF and carrier-convolved CDF. The gauge itself
contains no cohort-vs-window branch.

### 4.6 Interaction with the CF readiness protocol

The gauge does not attempt to read from a hypothetical
"CF-output-on-edge" cache in this rework. It runs its own sweep
inline for its own subject. This keeps the gauge self-contained and
correct irrespective of whether the whole-graph CF pass has landed,
whether the 500ms race resolved in time, or whether the on-edge
scalars are current for the active DSL. In terms of
[doc 54](54-cf-readiness-protocol.md) — the CF readiness protocol —
this rework ships with the gauge marked `cf_dependency: none` and
operating under the interim pattern described in doc 54 §8.

A performance cut-over is planned as a subsequent workstream, not
part of this rework. Doc 54 §8.1 specifies the CF scalar output
contract extension required to support it. Note the alignment: the
two scalar-field additions this rework makes to the *return struct*
of `compute_forecast_summary` (`completeness_unconditioned` /
`_sd` and `pp_rate_unconditioned` / `_sd`) are exactly the quantities
doc 54 §8.1 plans to persist onto the edge under the Tier-2 cut-over.
The in-memory extension in this rework is a strict subset of the
on-edge persistence later. No duplicated compute, no design drift.

Once that contract extension lands on-edge — alongside the
whole-graph CF pass (doc 47) and the readiness protocol's M1-M5
milestones — the gauge retrofits to `cf_dependency: required`, drops
its own inline `compute_forecast_summary` call, and reads the
four scalars from the edge directly. This is a strict performance
optimisation. It does not change the projection or the failure
semantics defined in §3, and it is out of scope for this rework.

---

## 5. Code surface reduction

Approximate, pending the actual edit:

- Frontend: ~250 lines of `localAnalysisComputeService.ts` gauge code
  and helpers, plus the corresponding tests. Gone.
- Backend: the Phase-1 analytic branch inside `_compute_surprise_gauge`
  (roughly the alpha/beta reconstruction block, the combined-SD mu/sigma
  branches, and the onset placeholder). Gone. The engine helper
  collapses into the main handler.
- Codebase design doc (`surprise-gauge-design.md`): §5.1 Phase-1
  formula and §5.2 mu/sigma combined-SD formulas removed; §6 Phase 1
  implementation block removed; §4 variable list reduced to `p` and
  `completeness`. The §8 design principles are kept (they still hold
  for the two remaining variables). `onset` and `path_onset` as
  Phase-3 targets remain as future work notes but lose their detailed
  formulas.

The net change is firmly negative line count, and the remaining code
has one code path with one failure mode per variable.

---

## 6. Out of scope

- **μ, σ, onset variables.** Descoped for this rework. See §2.5.
- **Caching and the CF-ready signal.** The 500ms race and the lack of
  a "CF output now available" subscription are real but independent
  concerns. This rework makes the gauge correct without solving them,
  by having the gauge call `compute_forecast_summary` itself. A
  later iteration (doc 54 Tier-2 cut-over) moves to on-edge reads.
- **The subset-conditioning correction (doc 51).** Once the shared
  pro-rata shrinkage helper lands, the gauge's posteriors will
  inherit it for free via `compute_forecast_summary`. No
  gauge-specific work is required.
- **Doc 50 edge classification (Class A/B/C/D).** Lagless edges and
  the `sigma ≤ 0` short-circuit are doc 50's territory. The gauge
  respects whatever `compute_forecast_summary` does; if it
  returns empty for lagless edges, the gauge is unavailable for them
  until doc 50 is implemented.
- **Epistemic/predictive separation (doc 49).** The gauge consumes
  the predictive alpha/beta that `compute_forecast_summary`
  already uses internally for its draws; this is correct per the
  surprise framing (§2.3). Any future change to CF's alpha/beta
  selection is inherited without a code edit.

---

## 7. Implementation phasing

1. **Delete the frontend local path and its tests.** One commit. Drops
   `surprise_gauge` from `LOCAL_COMPUTE_TYPES`, removes
   `buildSurpriseGaugeResult` and helpers, removes the corresponding
   tests. The backend engine path becomes the only source of gauge
   results. Existing dial / band rendering is unchanged. Users
   immediately see the backend-authored numbers the backend has been
   logging all along.

2. **Delete the backend analytic fallback.** One commit. Removes the
   Phase-1 formula inside `_compute_surprise_gauge`. If the engine
   cannot run, the gauge is unavailable. Verify regressions on
   existing synth / production graphs: specifically edges where the
   Phase-1 branch was quietly standing in for the engine.

3. **Switch the gauge handler onto `compute_forecast_summary`.**
   One commit. The current `_surprise_gauge_engine_p` calls
   `compute_forecast_trajectory` (the chart function) and does its own
   per-draw `p_s × c̄_s` loop. Replace with a direct call to
   `compute_forecast_summary`, passing the same cohort ages,
   weights, and evidence. Read `pp_rate_unconditioned*` from its
   return (after the field addition in step 4) for the `p` variable.
   Aggregate observed `(Σk, Σn)` from the same evidence list.

4. **Extend `ForecastSummary` with four gauge-relevant scalars.**
   One commit. Adds to `ForecastState.ForecastSummary`:
   `completeness_unconditioned, completeness_unconditioned_sd,
   pp_rate_unconditioned, pp_rate_unconditioned_sd`. Populates them
   from the already-computed `mc_completeness_unconditioned` and
   `p_draws_unconditioned` locals inside
   `compute_forecast_summary`. Tests: synthetic graphs exercising
   conditioned/unconditioned drift (high-evidence vs low-evidence
   windows), plus a parity check that the new scalars match a simple
   recomputation from the returned draws.

5. **Add the `completeness` variable to the gauge.** One commit.
   Extends the gauge handler to return both `p` and `completeness`
   variables from the CF return. Extend the frontend gauge builder
   to accept the two variables, render whichever are available,
   apply the warning-icon mechanism when `is_ess` falls below the
   chosen threshold. Update `surprise-gauge-design.md` to match the
   new variable list.

6. **Descope μ, σ, onset explicitly.** Part of the same commit as
   (5), or a follow-up doc-only commit. Remove their entries from
   the gauge variable selector. Leave a note in the design doc
   pointing to this doc for the rationale.

7. **Later (not in scope)**: once the whole-graph CF pass and a
   shared "CF output available for subject" signal exist, persist
   the four additional scalars on-edge (doc 54 §8.1) and replace the
   gauge's inline `compute_forecast_summary` call with an
   on-edge read. A separate doc when that work is ready.

---

## 9. Invariants after the rework

- The gauge renders only what the backend returned for the current
  subject. There is no second computation anywhere in the stack.
- Changing `window()` to `cohort()` in the query DSL produces a
  different subject, a different `compute_forecast_summary`
  call, different draws, a different projection, and therefore a
  different gauge. There is no code path that can short-circuit
  this.
- When the gauge cannot be computed, the UI says so. It does not
  substitute an approximation. Low IS ESS is not a failure — it
  renders the conditioned view with a warning icon.
- The gauge owns no maths. The four scalars it uses are returned
  by `compute_forecast_summary`; the handler reads them,
  computes `Σk/Σn` from the same evidence list, emits two
  `{observed, expected, sigma, quantile}` tuples.
- `analytic_be` is no longer privileged. `edge.p.latency.completeness`
  is no longer read by the gauge. `edge.p.evidence.k/n` is no
  longer read by the gauge.
- The variable list is closed: `p` and `completeness`. Re-opening
  it is a design question, not a code change.
