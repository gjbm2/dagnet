# 52 — Subset Conditioning Double-Counting: First-Principles Correction

**Status**: **Superseded 21-Apr-26 — redundant sidecar.** This file's
content (§§1–12) was folded into the canonical
[52-subset-conditioning-double-count-correction.md](52-subset-conditioning-double-count-correction.md)
in commit `b6228a02`, replacing the earlier "Generalised Pro-Rata
Correction" design that lived there. The canonical doc adds §§13–14
(implementation recommendations) and is marked "Implemented 20-Apr-26".
All shipped code references `doc 52 §14.x`, which only exists in the
canonical. This file is retained read-only for audit trail; do not edit.
Safe to delete once the history trail is no longer needed.
**Created**: 20-Apr-26
**Supersedes**: the pro-rata shrinkage design in the canonical file's
earlier content (the sample-level `(1 − r):r` blend in this doc was
used instead).
**Related**: doc 49 (epistemic/predictive separation), doc 50 (CF generality
gap), cohort-maturity-full-bayes, RESERVED_QUERY_TERMS_GLOSSARY

---

## TL;DR

The Bayes compiler fits each edge's posterior once, over all Cohorts it
could see on the window-mode and cohort-mode evidence axes. Several
runtime engines then take that aggregate posterior as a prior and apply
an importance-sampling reweight (or, in the lagless case, a closed-form
Beta-Binomial update) against a selected *set* of Cohorts chosen by the
query DSL. When the selected set overlaps the compiler's training set on
the matching axis, the overlap is counted twice — once in the posterior
and once in the runtime update. The correction is a sample-level blend
between the conditioned and unconditioned draw sets inside the engine,
weighted by the selected set's share of the training mass on the
relevant axis. The fix lives in the engine. Consumers do not change.

---

## 1. Terminology (per RESERVED_QUERY_TERMS_GLOSSARY)

Precise use of these terms is load-bearing for the rest of the doc.

- **Cohort** (capitalised) — a dated population of users. Not a query
  clause.
- **`cohort()`** — a QueryDSL clause selecting `a-x-y` semantics
  (anchor-anchored at `a`, growing `x`, path-level latency).
- **`window()`** — a QueryDSL clause selecting edge-local semantics
  (Cohort at the edge's `from_node`, fixed `x`, edge-level latency).
- **Window mode** / **cohort mode** — the two query semantics. Each
  defines its Cohorts differently and its latency differently.
- **`alpha` / `beta`** — the Bayesian posterior on an edge's rate
  fitted from *window-mode* evidence.
- **`cohort_alpha` / `cohort_beta`** — the Bayesian posterior on the
  same edge's rate fitted from *cohort-mode* evidence. Same quantity,
  different evidence set. Not interchangeable with `alpha`/`beta`.
- **Set of Cohorts** — the list of Cohorts selected by the query's
  temporal range. The object the engine receives as
  `List[CohortEvidence]`. Mass quantities are properties of the set,
  not of individual Cohorts.

A query runs in one temporal mode. The resolver
([model_resolver.py:302](graph-editor/lib/runner/model_resolver.py#L302))
picks the posterior pair matching that mode.

---

## 2. What the engine does today

### 2.1 The IS path

Entry: `compute_forecast_trajectory` at
[forecast_state.py:1096](graph-editor/lib/runner/forecast_state.py#L1096).
Receives:

- A `ResolvedModelParams` carrying the mode-appropriate posterior
  pair (α, β for the rate; μ, σ, onset for the latency) — produced
  by `resolve_model_params`, which walks the cascade over the edge's
  `model_vars` array.
- A `List[CohortEvidence]` — the set of Cohorts selected by the query,
  built from DB snapshots by
  `build_cohort_evidence_from_frames`
  ([cohort_forecast_v3.py:189](graph-editor/lib/runner/cohort_forecast_v3.py#L189)).

Internal operation:

1. Draws `S` samples of `p` from Beta(α, β).
2. Draws `S` samples of (μ, σ, onset) from the latency posterior.
3. For each Cohort `i` in the set and each draw `s`, computes effective
   exposure `E_{i,s} = n_i × CDF(τ_i; μ_s, σ_s, onset_s)`.
4. Accumulates an importance-sampling log-weight per draw:
   `log w_s = Σ_i [k_i log p_s + (E_{i,s} − k_i) log(1 − p_s)]`
   ([forecast_state.py:710](graph-editor/lib/runner/forecast_state.py#L710)).
5. Tempered resampling with an ESS ≥ 20 target
   ([forecast_state.py:718](graph-editor/lib/runner/forecast_state.py#L718)).
6. Returns both the conditioned draws (`rate_draws`, and the equivalent
   latency draws) and the unconditioned draws (`model_rate_draws`,
   unreweighted) at
   [forecast_state.py:1485](graph-editor/lib/runner/forecast_state.py#L1485).

The scalar-only sibling `compute_forecast_summary` at
[forecast_state.py:475](graph-editor/lib/runner/forecast_state.py#L475)
performs the same operation on a smaller fixed draw set for scalar
consumers (surprise gauge, CF scalar outputs).

### 2.2 The closed-form path

`_lagless_rows` at
[cohort_forecast_v3.py:27](graph-editor/lib/runner/cohort_forecast_v3.py#L27)
handles edges whose latency is absent. Two branches:

- **B1** (source is bayesian): applies `α' = α + Σy`, `β' = β + Σ(x − y)`.
- **B2** (source is analytic_be / analytic / manual): reads α, β
  directly — no update. The in-code rationale is that the source was
  already query-scoped.

The code already distinguishes "aggregate needs the subset re-applied"
(B1) from "aggregate was already scoped, do not re-apply" (B2).

### 2.3 Consumers

- `handle_conditioned_forecast` at
  [api_handlers.py:2051](graph-editor/lib/api_handlers.py#L2051) —
  the CF endpoint; called by the cohort maturity v3 chart and by any
  analysis runner that opts in.
- `compute_cohort_maturity_rows_v3` at
  [cohort_forecast_v3.py:425](graph-editor/lib/runner/cohort_forecast_v3.py#L425)
  — the inner kernel used by the CF endpoint.
- `compute_forecast_summary` — surprise gauge and scalar paths.
- `compute_epistemic_bands` — direct α, β consumer, no engine roundtrip.
- `run_conversion_funnel` at
  [runners.py:1475](graph-editor/lib/runner/runners.py#L1475) in e+f
  mode — calls CF via `_scoped_conditioned_forecast`.
- Any future analysis reading `resolved.alpha` / `resolved.beta`.

Note: `handle_stats_topo_pass` at
[api_handlers.py:5210](graph-editor/lib/api_handlers.py#L5210) is a
*producer* of `analytic_be` model vars, not a consumer that does subset
conditioning. It is not in the scope of this correction.

---

## 3. Where double-counting enters

The resolved posterior for a (edge, temporal_mode) pair was fitted from
all Cohorts the compiler saw on that axis. The engine's IS reweight
then applies the Binomial likelihood of each Cohort in the query's
selected set. Where the selected set overlaps the compiler's training
set, the overlap's likelihood is applied twice.

Two parallel tracks, one per temporal mode. A single query runs on one
axis — either window-mode (reweighting `alpha`/`beta`) or cohort-mode
(reweighting `cohort_alpha`/`cohort_beta`) — so for any given call, the
double-count is axis-specific.

### 3.1 Severity

Depends on the selected set's share of the training set, measured on
the same axis. If the compiler trained over twelve months and the query
selects one recent Cohort, overlap is a tiny fraction of training and
the re-applied likelihood barely moves the posterior. If the query
selects the entire training range, the IS reweight re-applies the full
fit on top of itself and the posterior appears roughly twice as certain
as the evidence supports.

### 3.2 Dimensions affected

Both the rate parameters (α, β) and the latency parameters (μ, σ,
onset) are involved. The IS reweight in step 4 above shapes draws on
all four, keyed on per-Cohort `(k_i, E_{i,s})` with `E_{i,s}` depending
on the latency draw. The compiler's fit also used Cohort-level latency
evidence on the same axis. Both dimensions double-count symmetrically
in the overlap case.

---

## 4. First-principles framing

The correct Bayesian answer given the compiler's posterior `p(θ | D_T)`
and a selected evidence set `D_S` is:

- If `D_S ⊆ D_T` (selection already absorbed): no update applies — the
  posterior is unchanged.
- If `D_S ⊄ D_T` (selection contains evidence the compiler didn't see):
  update using only the new portion, `D_new = D_S \ D_T`.

The engine today applies the full `L(D_S | θ)` regardless of which case
holds. This is correct only when `D_S ∩ D_T = ∅`, which is unusual in
practice — queries typically range over dates the compiler already saw.

### 4.1 A tractable approximation

The engine has in scope at return time:

- **Conditioned draws** — reweighted by the full `L(D_S | θ)`.
- **Unconditioned draws** — samples from `p(θ | D_T)` untouched.

Let `r ∈ [0, 1]` measure the selected set's share of the training mass
on the relevant axis:

- `r → 0`: selection is a small sliver of training. Double-count is
  proportionally small. Conditioned draws ≈ unconditioned draws plus a
  legitimate refinement; using the conditioned result is close to
  correct.
- `r = 1`: selection equals training. Double-count is total. Conditioned
  result has roughly twice the effective evidence. Using unconditioned
  is correct.
- Between: monotonic blend.

A sample-level mixture — `(1 − r) × S` conditioned draws paired with
`r × S` unconditioned draws — approximates this behaviour at both
boundary conditions exactly and monotonically between.

This is a display-time approximation, not a re-derivation of the
posterior. It does not rebuild the MCMC fit; it mixes two sample sets
the engine already holds. Its merit is correctness at the boundaries
and graceful interpolation through the realistic middle range.

### 4.2 Why not compute `D_new` directly

In principle, the engine could discard from the selected set any
Cohorts that fell inside the compiler's training window and reweight
only on the rest. Two objections:

- The compiler's training window is not currently exported per edge per
  axis. It would have to be.
- Even with training windows exported, the set-minus operation assumes
  "the compiler saw exactly these Cohorts' exact data". In practice the
  compiler saw snapshots at a fit-time frontier, while the runtime sees
  observations at the query-time frontier. "The same Cohort" at two
  frontiers is not the same object.

The set-mass blend sidesteps both by operating on aggregate masses, not
per-Cohort membership. It loses precision in the edge case where
selection is entirely outside training — see §8.

---

## 5. The correction

### 5.1 Inputs

- `m_G` — total training mass for this (edge, temporal_mode). A scalar
  the compiler knows at fit time and must export (see §6).
- `m_S` — total mass of the selected Cohort set, summed inside the
  engine from the `List[CohortEvidence]` it receives.

`r = min(m_S / m_G, 1)`.

### 5.2 Mass units

Raw observation count on the relevant axis:

- Window mode: total `n` at the edge's `from_node` across the Cohorts
  in question.
- Cohort mode: total `n` at the anchor `a` across the Cohorts in
  question.

This is the quantity the compiler used in the per-Cohort Binomial
likelihoods that produced α, β. Using α + β from moment-matching as a
proxy is tempting because it's already exported, but α + β is an
equivalent-concentration estimator that can diverge from raw count
under partial pooling, informative priors, or hierarchical shrinkage.
For a bayesian source — the case where the correction matters — the
divergence is potentially material. Raw count is the honest quantity;
the compiler export (§6) is the way to get it.

### 5.3 Blend mechanics

At the draw-set level, take `(1 − r) × S` from the conditioned draws
and `r × S` from the unconditioned draws. Mix the four arrays (rate,
μ, σ, onset) draw-for-draw so per-draw rate-latency consistency is
preserved. Compute display summaries (quantiles, means, SDs, fan bands)
from the mixed set.

At `r = 0` the mix is all conditioned (today's behaviour). At `r = 1`
the mix is all unconditioned (the compiler's posterior untouched). In
between the mixed distribution may be slightly wider than either input
— this is the correct behaviour: uncertainty about whether the IS
refinement was legitimate or spurious shows up as posterior width.

### 5.4 Closed-form equivalent

In `_lagless_rows` there are no samples — the result is a closed-form
Beta. Apply the blend at the Beta level:

- Compute `(α', β')` — the B1 updated result.
- Compute `(α, β)` — the unupdated aggregate.
- Produce a blended display Beta by mixing the two distributions at
  ratio `(1 − r) : r`, either via moment-matching the mixture or via a
  small sample to match the IS path.

B2's current behaviour (no update for analytic / analytic_be / manual
sources) falls out automatically: those sources are query-scoped by
construction, so `m_G = m_S` → `r = 1` → blend returns the unupdated
`(α, β)`. The B1/B2 branch in `_lagless_rows` becomes a special case of
the continuous blend rather than an independent decision.

---

## 6. Compiler-side changes required

Two new fields on `PosteriorSummary` (and corresponding slice-level
types):

- `window_n_effective` — total raw observation count used to fit the
  window-mode posterior for this edge.
- `cohort_n_effective` — same for cohort-mode.

Plumbed through the worker into patch slices, through
`bayesPatchService` into graph-edge posterior types, and surfaced on
`ResolvedModelParams` alongside α, β.

For D20-fallback sources
([model_resolver.py:339](graph-editor/lib/runner/model_resolver.py#L339)),
`n_effective` is known at fallback construction time — it is the
denominator used to synthesise α, β. Populate it there too. By
construction for such sources, `m_G = m_S` for any selection drawn
from the same query that produced the fallback, which recovers the
B2-style "no correction" behaviour automatically.

Nothing about the fit itself changes. The compiler already has this
quantity; it just isn't surfaced to consumers today.

---

## 7. Where the change lives in code

- **`compute_forecast_trajectory`** — one block at the end of the
  function, before `ForecastTrajectory` construction. Inputs: the
  conditioned draw arrays (already present), the unconditioned draw
  arrays (already present), `m_G` from `resolved`, `m_S` summed from
  `cohorts`. Output: mixed arrays. Provenance: `r`, `m_S`, `m_G`,
  blend-applied flag.
- **`compute_forecast_summary`** — the same blend on its smaller fixed
  draw set. Same provenance fields.
- **`_lagless_rows`** — blend at the Beta level as described in §5.4.
  The B1/B2 branch collapses into the continuous blend.
- **`resolve_model_params`** — surface `n_effective` on
  `ResolvedModelParams`.
- **Compiler / worker / FE types / patch projection** — plumb the new
  fields through.

Nothing in the IS sweep itself changes. Tempering, ESS, SMC mutation,
per-Cohort convergence all still run and still mean what they mean.
The blend is a post-processing step.

---

## 8. Edge cases

### 8.1 Selection extending beyond training (`m_S > m_G`)

Clipping `r` at 1 treats all excess as overlap, which discards the
legitimate new evidence. A richer form partitions `m_S` into `m_overlap`
and `m_new` and applies a partial reweight corresponding to `m_new`
only. That requires knowing not just `m_G` as a scalar but the
compiler's training date range, so the engine can classify each Cohort
in the selected set as inside-training or outside-training.

For v1: clip. Explicitly conservative — never pretends new Cohorts
aren't new, but sacrifices some useful refinement when they exist.
v2 can partition if the data shows it matters.

### 8.2 Context-scoped posteriors

When the compiler emits per-context slices (per `.context(k:v)`
qualifier) and the resolver picks a context-scoped posterior, `m_G` is
the context-scoped training mass by construction, and `m_S` is the
selected set's mass within that context scope. The correction applies
per-slice with no special handling.

### 8.3 Strongly pooled hierarchical fits

The `p_cohort_{eid}` latent used in Case A
([bayes/compiler/model.py:714](bayes/compiler/model.py#L714)) pools
Cohorts with a hyperprior. Exporting "raw observation count" for such a
fit is defensible but understates the effective evidence the pooling
actually produced. For v1, export raw count and document that the
correction under-discounts for heavily pooled edges — such edges'
posteriors are also narrower than raw count would imply, so the
under-discount is in the same direction as the model's own behaviour.

### 8.4 Cohort-mode mass definition

Cohort-mode fits over growing-x Cohorts with path-level latency. The
compiler's per-Cohort Binomial likelihood uses an effective exposure
`E_i = n_i × c_i`, not raw `n_i`. Which to export is a design choice:

- **Raw `n_i` summed across training** — simplest, consistent with
  window-mode; requires the engine to sum raw `n_i` from its selected
  Cohorts too.
- **Effective exposure summed across training** — matches what the
  compiler actually used in its likelihood; requires the engine to
  compute effective exposure on the selected set at query time.

Raw count is the v1 recommendation. Consistent across modes, simpler
to compute, approximates mass well for mature Cohorts. If coverage
studies show this biases the correction, switch to effective exposure
in v2.

### 8.5 Latency-only double-count

If for some reason a consumer conditions only latency (keeps α, β
fixed and reweights only on observed latency shape), the same blend
logic applies to the latency draws alone. No such path exists today
in the engine, but if one is added, the correction is symmetric.

---

## 9. What this does and does not solve

**Solves:**

- Systematic double-counting when a query's selected Cohort set
  overlaps the compiler's training set on the relevant axis.
- Unifies B1/B2 in the closed-form path with the IS path's previously
  absent handling — all of them fall out of a single `r`-driven blend.
- Produces one scalar per call that makes the correction's size
  observable in provenance and therefore testable.

**Does not solve:**

- Selection strictly beyond training (clipped; correct to v2).
- Strongly hierarchical fits (under-discounts; acceptable in v1).
- Downstream visuals that re-plot the same evidence independently
  (e.g. scatter points at Cohort-level observations) — the visual can
  still suggest more information than the corrected posterior; that is
  a chart-design concern, not a statistical one.
- The compiler's own fit — no model-side changes to the fitting
  process. Only the export is extended.

---

## 10. Scope and calibration

### 10.1 What ships

- Compiler: two new export scalars per edge
  (`window_n_effective`, `cohort_n_effective`).
- Worker: pack through into patch slices.
- FE types: extend `SlicePosteriorEntry`, graph-edge posterior types.
- Resolver: surface `n_effective` on `ResolvedModelParams`.
- Engine IS path: blend block in `compute_forecast_trajectory` and
  `compute_forecast_summary`.
- Engine closed-form path: blend in `_lagless_rows`; B1/B2 dissolves
  into the continuous case.
- Provenance: `r`, `m_S`, `m_G`, blend-applied flag carried through
  CF response payloads.
- One regression fixture per path constructed to hit `r = 0.6`,
  asserting the blend output.

No consumer changes. Cohort maturity v3 chart, CF handler, conversion
funnel (e+f), surprise gauge, epistemic bands inherit the corrected
behaviour through the engine.

### 10.2 Calibration

Default blend is linear in `r`. A non-linear curve (`w = r^γ`) would
be a tuned-to-data decision. The calibration target is held-out-Cohort
coverage: on production graphs, for each of a suite of Cohorts,
re-fit the aggregate without that Cohort, run the corrected engine
conditioned on it, and check that the stated 90% HDI covers observed
outcomes at the right frequency.

Default linear ships without calibration. If coverage studies
subsequently show systematic over- or under-correction, `γ` becomes
available as a single tuned parameter of the engine — not a knob per
caller.

### 10.3 Sequencing

1. Compiler export change (additive, back-compatible).
2. Worker + FE types + resolver plumbing.
3. Engine IS-path blend.
4. Engine closed-form-path blend.
5. Regression fixture.
6. Calibration study (post-ship).

Each step independently shippable. The engine-side work (3, 4) becomes
no-ops until step 1–2 have landed (`n_effective` fields absent →
`m_G` unknown → blend skipped, with a provenance flag recording the
skip). This lets the pipeline deploy incrementally without
coordinating releases.

---

## 11. Open design questions

1. **Cohort-mode mass unit.** Raw `n` vs effective exposure. §8.4.
2. **Hierarchical `n_effective`.** Raw count vs pooling-adjusted. §8.3.
3. **Selection-beyond-training handling.** Clip (v1) vs partition
   (v2). §8.1.
4. **Calibration target.** Exact HDI coverage test design, fixture
   Cohort selection, acceptance criteria.
5. **Provenance surfacing.** Where in the CF response payload should
   `r`, `m_S`, `m_G`, blend-applied flag live. Inspector rendering
   decisions.

None of these block v1 scope. Each is a bounded decision.

---

## 12. Out of scope

- The compiler's fitting process itself.
- Adding cohort-specific latents to the model (separate design, if
  ever).
- Any change to `handle_stats_topo_pass` or the `analytic_be`
  producer — those produce aggregates, they do not condition on
  selected subsets.
- Chart-layer visual choices that may reinforce apparent precision
  beyond what the corrected posterior supports.
