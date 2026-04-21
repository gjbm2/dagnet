# 52 — Subset Conditioning Double-Counting: Engine-Level Correction

**Status**: Implemented 20-Apr-26 on branch `feature/snapshot-db-phase0`.
Design in §§1–13; implementation recommendations in §14.
**Created**: 20-Apr-26
**Supersedes**: the earlier "Generalised Pro-Rata Correction" version of
this file. That earlier design shrank the aggregate prior's equivalent
strength by `N_subset / N_total` before conjugate update. It was
abandoned after terminology and consumer-inventory corrections. The
current doc's sample-level `(1 − r):r` blend between conditioned and
unconditioned draw sets is a different correction mechanism, not a
refinement of the pro-rata shrinkage. The rewritten content was first
drafted as sidecar `52-subset-conditioning-claude-rewrite-20Apr26.md`
(commit `44e1f5c9`) and then replaced this file's content in commit
`b6228a02`. Anyone reading a cached copy from before that commit is
reading the abandoned design.
**Related**: doc 49 (epistemic/predictive separation), doc 50 (CF
generality gap), cohort-maturity-full-bayes, RESERVED_QUERY_TERMS_GLOSSARY

---

## TL;DR

The Bayes compiler fits each edge's posterior once, over all Cohorts it
could see on the window-mode and cohort-mode evidence axes. Several
runtime engines then take that aggregate posterior as a prior and apply
an importance-sampling reweight (or, in the lagless case, a closed-form
Beta-Binomial update) against a selected *set* of Cohorts chosen by the
query DSL. When the selected set overlaps the compiler's training set
on the matching axis, the overlap is counted twice — once in the
posterior and once in the runtime update. The correction is a
sample-level blend between the conditioned and unconditioned draw sets
inside the engine, weighted by the selected set's share of the training
mass on the relevant axis. The fix lives in the engine at three
well-defined callsites. Eight downstream consumers inherit the
correction without changing.

---

## 1. Terminology (per RESERVED_QUERY_TERMS_GLOSSARY)

Precise use is load-bearing.

- **Cohort** (capitalised) — a dated population of users. Not a query
  clause.
- **`cohort()`** — a QueryDSL clause selecting `a-x-y` semantics
  (anchor-anchored at `a`, growing `x`, path-level latency).
- **`window()`** — a QueryDSL clause selecting edge-local semantics
  (Cohort at the edge's `from_node`, fixed `x`, edge-level latency).
- **Window mode** / **cohort mode** — the two query semantics.
- **`alpha` / `beta`** — Bayesian posterior on an edge's rate fitted
  from *window-mode* evidence.
- **`cohort_alpha` / `cohort_beta`** — Bayesian posterior on the same
  edge's rate fitted from *cohort-mode* evidence. Same quantity,
  different evidence set. Not interchangeable.
- **Set of Cohorts** — the list of Cohorts selected by the query. The
  object the engine receives as `List[CohortEvidence]`. Mass is a
  property of the set, not per Cohort.

A query runs in one temporal mode. The resolver
([model_resolver.py:302](graph-editor/lib/runner/model_resolver.py#L302))
picks the posterior pair matching that mode.

---

## 2. Where subset conditioning happens

### 2.1 Direct engine callsites (three)

The correction is applied at each of these.

**`compute_forecast_trajectory`** at
[forecast_state.py:1096](graph-editor/lib/runner/forecast_state.py#L1096).
Receives a `ResolvedModelParams` (α, β, μ, σ, onset) and a
`List[CohortEvidence]`. Draws S=2000 samples, applies a tempered IS
reweight keyed on
`log w_s = Σ_i [k_i log p_s + (E_{i,s} − k_i) log(1 − p_s)]` at
[forecast_state.py:710](graph-editor/lib/runner/forecast_state.py#L710),
returns both conditioned (`rate_draws`) and unconditioned
(`model_rate_draws`) draw sets at
[forecast_state.py:1485](graph-editor/lib/runner/forecast_state.py#L1485).

**`compute_forecast_summary`** at
[forecast_state.py:475](graph-editor/lib/runner/forecast_state.py#L475).
Same machinery at scalar fidelity for consumers that need a single
(mean, sd) rather than a trajectory.

**`_lagless_rows`** at
[cohort_forecast_v3.py:27](graph-editor/lib/runner/cohort_forecast_v3.py#L27).
Closed-form for edges without latency. B1 branch (bayesian source)
applies `α' = α + Σy`, `β' = β + Σ(x − y)`. B2 branch (analytic_be /
analytic / manual) skips the update because the source was already
query-scoped.

### 2.2 Indirect consumers (eight)

Each calls one of the three engine functions above, directly or via a
handler, and therefore inherits the correction when it lands in the
engine. No consumer-side change is required.

1. **`compute_cohort_maturity_rows_v3`** at
   [cohort_forecast_v3.py:425](graph-editor/lib/runner/cohort_forecast_v3.py#L425)
   — inner kernel of the CF endpoint. Routes through
   `compute_forecast_trajectory` for lag-equipped edges and through
   `_lagless_rows` for lagless edges.
2. **`handle_conditioned_forecast`** (the CF endpoint) at
   [api_handlers.py:2051](graph-editor/lib/api_handlers.py#L2051) —
   called by the cohort maturity v3 chart and by analysis runners that
   opt in. Inherits via v3.
3. **`compute_surprise_zscore`** at
   [api_handlers.py:132](graph-editor/lib/api_handlers.py#L132) —
   surprise gauge. Projects `compute_forecast_summary` outputs.
4. **`handle_stats_topo_pass`** rate path at
   [api_handlers.py:5210](graph-editor/lib/api_handlers.py#L5210) —
   calls `compute_forecast_trajectory` directly to produce the
   `blended_mean` scalar written into the `analytic_be` model vars
   entry. The handler's Fenton-Wilkinson latency composition in the
   same function is deterministic and not in scope; only the rate
   path is.
5. **Daily conversions coordinate-B annotation** at
   [api_handlers.py:3463](graph-editor/lib/api_handlers.py#L3463) —
   when `analysis_type='daily_conversions'` and the edge has latency,
   `rate_by_cohort` is annotated via a direct
   `compute_forecast_trajectory` call.
6. **Latency band sweep** at
   [api_handlers.py:3636](graph-editor/lib/api_handlers.py#L3636) —
   runs `compute_forecast_trajectory` per-τ to annotate latency band
   rates on chart rows.
7. **`run_conversion_funnel`** (e+f mode) at
   [runners.py:1475](graph-editor/lib/runner/runners.py#L1475) —
   calls the CF endpoint via `_scoped_conditioned_forecast`.
8. **`compute_bars_ef`** at
   [funnel_engine.py:187](graph-editor/lib/runner/funnel_engine.py#L187)
   — consumes the CF endpoint's per-edge output. Inherits transitively
   via CF.

### 2.3 Out of scope

These do not perform subset conditioning and do not need correcting.

- **`compute_epistemic_bands`** at
  [epistemic_bands.py:141](graph-editor/lib/runner/epistemic_bands.py#L141)
  — displays aggregate-only HDIs per doc 49. No Cohort evidence in
  input. Explicitly by design.
- **`compute_bars_f`** at
  [funnel_engine.py:138](graph-editor/lib/runner/funnel_engine.py#L138)
  — draws from Beta(α, β) directly per edge. No conditioning.
- **`compute_completeness_with_sd`** at
  [forecast_state.py:114](graph-editor/lib/runner/forecast_state.py#L114)
  — latency dispersion only. No rate conditioning.
- **Fenton-Wilkinson latency composition** inside
  `handle_stats_topo_pass` — deterministic lognormal composition, not
  a conditioning operation. Distinct from the same handler's rate path
  (#4 above), which is in scope.

---

## 3. Where double-counting enters

The resolved posterior for a (edge, temporal_mode) pair was fitted from
all Cohorts the compiler saw on that axis. The engine's IS reweight
then applies the Binomial likelihood of each Cohort in the query's
selected set. Where the selected set overlaps the compiler's training
set, the overlap's likelihood is applied twice.

Two parallel tracks, one per temporal mode. A single query runs on one
axis — either window-mode (reweighting `alpha`/`beta`) or cohort-mode
(reweighting `cohort_alpha`/`cohort_beta`). For any given call, the
double-count is axis-specific.

### 3.1 Severity

Scales with the selected set's share of the training set on the
relevant axis. Compiler trained over twelve months and query selects
one recent Cohort → overlap is a tiny fraction and the extra reweight
barely moves the posterior. Query selects the entire training range →
the IS reweight re-applies the full fit on top of itself and the
posterior appears roughly twice as certain as the evidence supports.

### 3.2 Dimensions affected

Both the rate parameters (α, β) and the latency parameters (μ, σ,
onset). The IS reweight shapes draws on all four, keyed on per-Cohort
`(k_i, E_{i,s})` where `E_{i,s}` depends on the latency draw. The
compiler's fit also used Cohort-level latency evidence on the same
axis. Both dimensions double-count symmetrically in the overlap case.

---

## 4. First-principles framing

The correct Bayesian answer given the compiler's posterior `p(θ | D_T)`
and a selected evidence set `D_S` is:

- If `D_S ⊆ D_T` (selection already absorbed): no update applies — the
  posterior is unchanged.
- If `D_S ⊄ D_T` (selection contains evidence the compiler didn't
  see): update using only the new portion, `D_new = D_S \ D_T`.

The engine today applies the full `L(D_S | θ)` regardless. That is
correct only when `D_S ∩ D_T = ∅`, which is unusual in practice —
queries typically range over dates the compiler already saw.

### 4.1 A tractable approximation

The engine has two draw sets in scope at return time:

- **Conditioned** — reweighted by the full `L(D_S | θ)`.
- **Unconditioned** — samples from `p(θ | D_T)` untouched.

Let `r ∈ [0, 1]` measure the selected set's share of the training mass
on the relevant axis.

- `r → 0`: selection is a small sliver of training. Double-count is
  proportionally small. Using the conditioned result is close to
  correct.
- `r = 1`: selection equals training. Double-count is total. Using
  unconditioned is correct.
- Between: monotonic blend.

A sample-level mixture — `(1 − r) × S` conditioned draws paired with
`r × S` unconditioned — is exact at both boundary conditions and
interpolates monotonically between. It does not rebuild the MCMC fit;
it mixes two sample sets the engine already holds.

### 4.2 Why not compute `D_new` directly

The engine could in principle drop any Cohort in the selection that
fell inside the compiler's training window, and reweight only on the
rest. Two objections:

- The compiler's training window is not exported per edge per axis. It
  would have to be.
- Even with windows exported, set-minus assumes "the compiler saw
  exactly these Cohorts' exact data". In practice the compiler saw
  snapshots at a fit-time frontier, while the runtime sees
  observations at the query-time frontier. The same Cohort at two
  frontiers is not the same object.

The set-mass blend sidesteps both by operating on aggregate masses,
not per-Cohort membership. It loses precision when selection is
entirely outside training — see §9.

---

## 5. The correction

### 5.1 Inputs

- `m_G` — total training mass for this (edge, temporal_mode). Scalar.
  Compiler export (§6).
- `m_S` — total mass of the selected Cohort set, summed inside the
  engine from the `List[CohortEvidence]` it receives.
- `r = min(m_S / m_G, 1)`.

### 5.2 Mass units

Raw observation count on the relevant axis: total `n` at the edge's
`from_node` for window mode, total `n` at the anchor `a` for cohort
mode. The same quantity the compiler used in per-Cohort Binomial
likelihoods when producing α, β. Using α + β as a proxy is tempting
because it is already exported, but moment-matched equivalent
concentration can diverge from raw count under partial pooling,
informative priors, or hierarchical shrinkage — divergence is
potentially material in the exact case (bayesian source) where the
correction matters. Raw count is the honest quantity; the compiler
export is the way to get it.

### 5.3 Blend mechanics (IS path)

At the draw-set level, take `(1 − r) × S` from the conditioned draws
and `r × S` from the unconditioned draws. Mix the four arrays (rate,
μ, σ, onset) draw-for-draw so per-draw rate-latency consistency is
preserved. Display summaries (quantiles, means, SDs, fan bands) come
from the mixed set.

At `r = 0` the mix is all conditioned (today's behaviour). At `r = 1`
the mix is all unconditioned (the compiler's posterior untouched). In
between, the mixed distribution may be slightly wider than either
input — correct behaviour, since uncertainty about whether the IS
refinement was legitimate or spurious shows up as posterior width.

### 5.4 Closed-form equivalent (lagless path)

In `_lagless_rows` there are no draws. Apply the blend at the Beta
level:

- Compute `(α', β')` — the B1 updated result.
- Compute `(α, β)` — the unupdated aggregate.
- Produce a blended display Beta by mixing the two distributions at
  ratio `(1 − r) : r`, either via moment-matching the mixture or a
  small sample to match the IS path.

B2's current behaviour (no update for analytic / analytic_be / manual
sources) falls out automatically: those sources are query-scoped by
construction, so `m_G = m_S` → `r = 1` → blend returns the unupdated
`(α, β)`. The B1/B2 branch dissolves into a single continuous rule.

---

## 6. Compiler-side changes

Two new fields on `PosteriorSummary` (and slice-level types):

- `window_n_effective` — total raw observation count used to fit the
  window-mode posterior for this edge.
- `cohort_n_effective` — same for cohort-mode.

Plumbed through the worker into patch slices, through
`bayesPatchService` into graph-edge posterior types, and surfaced on
`ResolvedModelParams` alongside α, β.

For D20-fallback sources
([model_resolver.py:339](graph-editor/lib/runner/model_resolver.py#L339)),
`n_effective` is known at fallback construction — it is the denominator
used to synthesise α, β. Populate it there too. By construction, `m_G
= m_S` for any selection drawn from the same query that produced the
fallback → recovers the B2 "no correction" behaviour automatically.

Nothing about the fit itself changes.

---

## 7. Where the change lives in code

- **`compute_forecast_trajectory`** — one block at the end of the
  function, before `ForecastTrajectory` construction. Mix the
  conditioned and unconditioned arrays at ratio `(1 − r) : r`.
  Provenance: `r`, `m_S`, `m_G`, blend-applied flag.
- **`compute_forecast_summary`** — the same mix on its fixed-size
  draw set.
- **`_lagless_rows`** — blend at the Beta level as §5.4. B1/B2 branch
  collapses into the continuous case.
- **`resolve_model_params`** — surface `n_effective` on
  `ResolvedModelParams` for each temporal_mode.
- **Compiler / worker / FE types / patch projection** — plumb the new
  fields through.

Nothing else changes. The IS sweep (tempering, ESS, SMC mutation,
per-Cohort convergence) runs as today. The blend is a post-processing
step.

---

## 8. How each consumer inherits

By construction, no consumer change is required. The correction lives
inside the three engine callsites every subset-conditioning consumer
uses. Concretely:

- Cohort maturity v3 chart → v3 kernel → engine → corrected.
- CF endpoint → v3 kernel → engine → corrected.
- Conversion funnel e+f → CF endpoint → corrected transitively.
- Surprise gauge → `compute_forecast_summary` → corrected.
- BE topo pass rate path → `compute_forecast_trajectory` → corrected.
  The topo pass reads `sweep.cohort_evals[i].y_draws` / `x_draws`
  per Cohort and sums them to derive its rate — see
  [api_handlers.py:5436](graph-editor/lib/api_handlers.py#L5436).
  Blending `rate_draws` alone would miss this path; the engine must
  therefore also blend `cohort_evals` using the same permutation
  (§14.4.1). The `analytic_be` entry's `blended_mean` then reflects
  the corrected posterior; downstream consumers reading that source
  see `alpha_beta_query_scoped = True`, the blend skips (§14.5), and
  the correction is applied exactly once along any chain.
- Daily conversions annotation → `compute_forecast_trajectory` →
  corrected via the blended `cohort_evals` (same `y_draws` /
  `x_draws` read pattern as the BE topo pass;
  [api_handlers.py:3559](graph-editor/lib/api_handlers.py#L3559)).
- Latency band sweep → `compute_forecast_trajectory` → corrected via
  the blended `cohort_evals` (same pattern;
  [api_handlers.py:3650](graph-editor/lib/api_handlers.py#L3650)).
- Funnel `compute_bars_ef` → consumes CF per-edge output → corrected
  transitively.

Out-of-scope callers (`compute_epistemic_bands`, `compute_bars_f`,
`compute_completeness_with_sd`, Fenton-Wilkinson latency composition)
are unchanged — they do not do subset conditioning and therefore have
nothing to correct.

---

## 9. Edge cases

### 9.1 Selection extending beyond training (`m_S > m_G`)

Clipping `r` at 1 treats all excess as overlap, discarding legitimate
new evidence. A richer form would partition `m_S` into `m_overlap` and
`m_new` and apply a partial reweight corresponding to `m_new` only.
That needs the compiler's training date range exported alongside
`n_effective` so the engine can classify Cohorts as inside- vs
outside-training.

v1: clip. Conservative — never pretends new Cohorts aren't new, but
loses some useful refinement when they exist. v2 can partition if data
shows it matters.

### 9.2 Context-scoped posteriors

When the compiler emits per-context slices (per `.context(k:v)`
qualifier) and the resolver picks a context-scoped posterior, `m_G` is
the context-scoped training mass by construction, and `m_S` is the
selected set's mass within that context scope. Correction applies
per-slice with no special handling.

### 9.3 Strongly pooled hierarchical fits

The `p_cohort_{eid}` latent used in Case A
([bayes/compiler/model.py:714](bayes/compiler/model.py#L714)) pools
Cohorts with a hyperprior. Exporting raw observation count understates
the effective evidence pooling produces. For v1, export raw count and
document that the correction under-discounts for heavily pooled
edges — such edges' posteriors are also narrower than raw count would
imply, so the under-discount is in the same direction as the model's
own behaviour.

### 9.4 Cohort-mode mass definition

Cohort-mode fits use an effective exposure `E_i = n_i × c_i` in per-
Cohort Binomial likelihoods, not raw `n_i`. Which to export is a
design choice:

- Raw `n_i` summed across training — simplest, consistent with
  window-mode.
- Effective exposure summed across training — matches the compiler's
  actual likelihood.

Raw count is the v1 recommendation. If coverage studies show it biases
the correction, switch to effective exposure in v2.

### 9.5 Latency-only double-count

If a future consumer conditions only latency (keeping α, β fixed and
reweighting only on observed latency shape), the same blend logic
applies to latency draws alone. No such path exists today.

---

## 10. What this does and does not solve

**Solves:**

- Systematic double-counting when a query's selected Cohort set
  overlaps the compiler's training set on the relevant axis.
- Unifies B1/B2 in the closed-form path with the IS path's currently
  absent handling — all fall out of a single `r`-driven blend.
- Produces one scalar per call (`r`) that makes the correction's
  size observable in provenance and therefore testable.
- Covers all eight subset-conditioning consumers without consumer
  changes.

**Does not solve:**

- Selection strictly beyond training (clipped; correct to v2).
- Strongly hierarchical fits (under-discounts; acceptable in v1).
- Chart-layer visuals that re-plot the same evidence independently
  (e.g. scatter points at Cohort level) — the visual can still
  suggest more information than the corrected posterior; a chart-
  design concern, not a statistical one.
- The compiler's own fit — no model-side changes; only the export
  is extended.

---

## 11. Scope and calibration

### 11.1 What ships

- Compiler: `window_n_effective`, `cohort_n_effective` on
  `PosteriorSummary`. Additive, back-compatible.
- Worker: plumb through to patch slices.
- FE types: extend slice and graph-edge posterior types.
- Resolver: surface `n_effective` on `ResolvedModelParams`.
- Engine IS path: blend block in `compute_forecast_trajectory` and
  `compute_forecast_summary`.
- Engine closed-form path: blend in `_lagless_rows`; B1/B2 dissolves
  into the continuous case.
- Provenance: `r`, `m_S`, `m_G`, blend-applied flag carried through
  CF response payloads and surfaced in the inspector.
- One regression fixture per engine path, constructed to hit
  `r = 0.6`, asserting the blend output.

No consumer changes. All eight indirect consumers inherit the
corrected behaviour.

### 11.2 Calibration

Default blend is linear in `r`. A non-linear curve (`w = r^γ`) is a
tuned-to-data decision.

Calibration target: held-out-Cohort coverage. On production graphs,
for each of a suite of Cohorts, re-fit the aggregate without that
Cohort, run the corrected engine conditioned on it, check that the
stated 90 % HDI covers observed outcomes at the right frequency.

Default linear ships without calibration. If coverage studies show
systematic over- or under-correction, `γ` becomes available as a
single engine-wide parameter, not a per-caller knob.

### 11.3 Sequencing

Single commit on the current branch. See §14.1 for scope and
workflow. Calibration study (held-out-Cohort coverage) follows
post-ship as a separate workstream.

---

## 12. Open design questions

1. **Cohort-mode mass unit.** Raw `n` vs effective exposure. §9.4.
2. **Hierarchical `n_effective`.** Raw count vs pooling-adjusted.
   §9.3.
3. **Selection-beyond-training handling.** Clip (v1) vs partition
   (v2). §9.1.
4. **Calibration target design.** Exact HDI coverage test, fixture
   Cohort selection, acceptance criteria.
5. **Provenance surfacing.** Where in the CF response payload `r`,
   `m_S`, `m_G`, blend-applied flag live; inspector rendering.

None blocks v1. Each is a bounded decision. See §14 for concrete
recommendations that close each.

---

## 13. Out of scope

- The compiler's fitting process itself.
- Adding cohort-specific latents to the model (separate design if
  ever).
- The Fenton-Wilkinson latency composition inside
  `handle_stats_topo_pass` (deterministic, not conditioning).
- `compute_epistemic_bands`, `compute_bars_f`,
  `compute_completeness_with_sd` (do not condition on subsets).
- Chart-layer visual choices that may reinforce apparent precision
  beyond what the corrected posterior supports.

---

## 14. Implementation recommendations (v1)

The decisions below close the open questions in §12 and the
unaddressed items identified in review. Each is flagged as a
**Recommendation** for approval or override.

### 14.1 Scope and workflow

**Recommendation: single commit on the current branch
(`feature/snapshot-db-phase0`).**

The change is well-scoped — compiler export, worker plumbing, FE type
extensions, resolver surfacing, engine blend block in three functions,
test expected-value updates, two new regression fixtures. It belongs
alongside the forecasting/analysis interop work already committed on
this branch, not on a separate branch. No feature flag; rollback is
`git revert`. No multi-PR sequencing — the change is small enough to
land as one coherent unit.

### 14.2 Mass unit (closes §12.1 / §9.4 open item)

**Recommendation: raw `n` at frontier, both sides.**

- **Compiler side**:
  - `window_n_effective` = sum across window-mode training Cohorts of
    the last-retrieval `n` in `cohort_obs[].trajectories`
    ([model.py:2327](bayes/compiler/model.py#L2327)).
  - `cohort_n_effective` = same for cohort-mode trajectories.
- **Engine side**: `m_S = sum(c.x_frozen for c in cohorts if c.x_frozen > 0)`.
  `x_frozen` is N_i at frontier
  ([forecast_state.py:842](graph-editor/lib/runner/forecast_state.py#L842)).

Effective exposure `E_i = n_i × CDF(τ_i)` shifts with the latency draw
and is not a stable scalar to export. Raw frontier `n` is stable,
well-defined, and a direct measure of "total arrivals observed at the
from-node". Residual approximation noted under §9.4.

### 14.3 Compiler export field names (new decision)

**Recommendation: `window_n_effective` and `cohort_n_effective`, both
`float | None = None`, on `PosteriorSummary`
([types.py:584](bayes/compiler/types.py#L584)).**

Follows the existing `<mode>_<stat>` convention used for `window_alpha`
/ `cohort_alpha`. For per-context slice posteriors
(`slice_posteriors[ctx]`), add an `n_effective` key to each slice
dict. Worker plumbs via the same pattern as `window_alpha`. FE slice
types extend with `n_effective: number | null` as optional.

### 14.4 Engine mix mechanics (new decision)

**Recommendation: row-wise random selection with a dedicated seeded
RNG, applied to every conditioned output channel of each engine
function — not only `rate_draws`.**

The engine exposes multiple conditioned outputs that different
consumers read. Blending `rate_draws` alone misses consumers that
read `cohort_evals` or the scalar `ForecastSummary` fields. The
correction must cover every conditioned channel.

#### 14.4.1 `compute_forecast_trajectory`

Today the function calls `_run_cohort_loop(apply_is=True)` once and
derives `rate_model = p_draws × cdf_arr` as a pure-prior predictive.
The pure-prior path does not produce per-Cohort `y_draws`/`x_draws`
— which the BE topo pass at
[api_handlers.py:5436](graph-editor/lib/api_handlers.py#L5436) reads
via `sweep.cohort_evals` to recompute rate from `sum_y_draws /
sum_x_draws`.

**Engine change**: run `_run_cohort_loop` twice — once with
`apply_is=True` (producing conditioned `rate_conditioned`,
`Y_cond`, `X_cond`, `cohort_evals_cond`) and once with
`apply_is=False` (producing unconditioned `rate_unconditioned`,
`Y_unc`, `X_unc`, `cohort_evals_unc`). Cost: roughly doubles the
per-Cohort loop work. The IS path itself is the expensive part;
the second pass is cheaper because it skips the reweight. Acceptable.

**Blend**: pick a single permutation `perm` via
`blend_rng = np.random.default_rng(seed=43)` and apply it
identically to every `(S, …)` array:

- `rate_draws[s, :] = rate_conditioned[perm[s], :]` for `s < n_cond`;
  `rate_draws[s, :] = rate_unconditioned[perm[s], :]` for
  `s ≥ n_cond`.
- `Y_blend`, `X_blend` — same index pattern row-wise against
  `(Y_cond, Y_unc)` and `(X_cond, X_unc)`.
- For each entry in `cohort_evals`, build a blended
  `CohortForecastAtEval` using the same permutation on
  `y_draws`/`x_draws` between the conditioned and unconditioned
  per-Cohort arrays.
- `det_y_total` / `det_x_total` recomputed as median over blended
  `Y_blend` / `X_blend`.

Using the same permutation across channels preserves per-draw
coupling: if draw `s` in the blended output uses the conditioned
row, it is consistent across rate, Y/X totals, and per-Cohort
cohort_evals.

`rate_model` (the pure-prior predictive `p × cdf`) remains exposed
unchanged for consumers that want the generic-Cohort fan.

#### 14.4.2 `compute_forecast_summary`

`ForecastSummary` at
[forecast_state.py:422](graph-editor/lib/runner/forecast_state.py#L422)
has parallel conditioned/unconditioned field pairs already:
`completeness` vs `completeness_unconditioned`, `p_draws` vs
`p_draws_unconditioned`, and so on. Apply the same row-wise blend
to produce new "corrected" scalar fields, computed from blended
draw sets:

- Blend `p_draws` with `p_draws_unconditioned` (same permutation
  applied to `mu_draws`, `sigma_draws`, `onset_draws` and their
  unconditioned siblings).
- Replace `completeness`, `completeness_sd`, `rate_conditioned`,
  `rate_conditioned_sd`, `p_conditioned`, `p_conditioned_sd` with
  values computed from the blended draws.
- Leave `completeness_unconditioned`, `pp_rate_unconditioned`, and
  the `*_unconditioned` draw arrays untouched — surprise-gauge
  framing (doc 55) genuinely wants both the corrected and the
  unconditioned values for its shift computation; blending
  destroys that comparison.

At r=1 the blended value equals the unconditioned value, so the
surprise z-score collapses to ≈ 0. Correct: at r=1 the "shift" was
a double-count artefact, not a real signal.

#### 14.4.3 `_lagless_rows` (closed form)

No draws. Closed-form Beta blend at the moment level:

- Blended mean `μ_b = (1 − r)·μ' + r·μ` where `μ'` is the B1
  updated mean and `μ` the aggregate mean.
- Blended variance via law-of-total-variance:
  `v_b = (1 − r)·v' + r·v + (1 − r)·r·(μ' − μ)²`.
- Moment-match back to a display Beta `(α_b, β_b)`.

#### 14.4.4 What is not blended

`completeness_mean` / `_sd` on `ForecastTrajectory` at
[forecast_state.py:1395](graph-editor/lib/runner/forecast_state.py#L1395)
is already unreweighted by construction — it uses the aggregate-only
`cdf_arr`. No double-counting arises; no correction applies. Distinct
from `ForecastSummary.completeness`, which IS IS-conditioned and
does get blended per §14.4.2.

### 14.5 No-op semantics when blend not applicable (new decision)

**Recommendation: skip the blend and record the reason in provenance.**

Skip when any of:

- `resolved.n_effective` is None (compiler export not yet landed, or
  slice missing).
- `resolved.n_effective <= 0` (malformed).
- `m_S == 0` (empty Cohort list — shouldn't happen but safe).
- `resolved.alpha_beta_query_scoped == True`
  ([model_resolver.py:82](graph-editor/lib/runner/model_resolver.py#L82))
  — the existing semantic property on `ResolvedModelParams`, True
  only for `analytic` and `analytic_be` sources. These are already
  query-scoped by construction. Bayesian and manual sources are
  aggregate priors; both need the correction.

Using `alpha_beta_query_scoped` rather than a source-name check
keeps the engine aligned with the switch already used in
`_lagless_rows`
([cohort_forecast_v3.py:80](graph-editor/lib/runner/cohort_forecast_v3.py#L80))
and prevents a drift if new source types are introduced.

When skipped: `rate_draws = rate_conditioned` (today's behaviour
preserved); provenance records `blend_applied = False` with
`blend_skip_reason ∈ {"n_effective_missing", "n_effective_zero",
"no_cohorts", "source_query_scoped"}`.

### 14.6 Provenance payload shape (closes §12.5)

**Recommendation: add the same provenance fields to every engine
output type, and carry one `conditioning` block per edge in the CF
response.**

The same five fields on each of the three engine output carriers so
every path has an identical audit trail:

- `r: float | None = None`
- `m_S: float | None = None`
- `m_G: float | None = None`
- `blend_applied: bool = False`
- `blend_skip_reason: str | None = None`

Carriers:

- `ForecastTrajectory` at
  [forecast_state.py:882](graph-editor/lib/runner/forecast_state.py#L882).
- `ForecastSummary` at
  [forecast_state.py:422](graph-editor/lib/runner/forecast_state.py#L422).
- `_lagless_rows` return — today it returns `List[Dict[str, Any]]`
  with no structured carrier. **Change the return type to a new
  `LaglessResult` dataclass** with `rows: List[Dict[str, Any]]` and
  the five provenance fields above. Callers in v3 unwrap `rows` and
  forward the conditioning block into the same assembly point as the
  trajectory's conditioning block. Small, localised signature change.

CF per-edge response block (sibling to `completeness`):

- `conditioning.r`
- `conditioning.m_S`
- `conditioning.m_G`
- `conditioning.applied`
- `conditioning.skip_reason`

One block per edge per scenario. No per-row replication on cohort
maturity rows — `r` is per-call, not per-τ. Surprise gauge response
payload carries the same block at whatever edge granularity its
current payload uses.

### 14.7 `m_S` summation on `CohortEvidence` (new decision)

**Recommendation: `m_S = sum(c.x_frozen for c in cohorts if c.x_frozen > 0)`.**

`x_frozen` at
[forecast_state.py:842](graph-editor/lib/runner/forecast_state.py#L842)
is N_i at frontier — exactly the quantity needed to match the
compiler's raw-n export. No effective-exposure weighting at the
engine side — consistent with §14.2.

### 14.8 Existing test handling (new decision)

**Recommendation: update expected values inline in the same commit. No
feature flag.**

Files affected:

- [test_lagless_rows.py](graph-editor/lib/tests/test_lagless_rows.py)
  — update expected Beta parameters for B1 path.
- [test_forecast_state_cohort.py](graph-editor/lib/tests/test_forecast_state_cohort.py)
  — subset-coverage test cases shift.
- [test_conditioned_forecast_response_contract.py](graph-editor/lib/tests/test_conditioned_forecast_response_contract.py)
  — add assertions on new `conditioning` block.
- [test_daily_conversions.py](graph-editor/lib/tests/test_daily_conversions.py)
  — coordinate-B values shift where subset is material.
- [test_funnel_contract.py](graph-editor/lib/tests/test_funnel_contract.py)
  — e+f bars shift via CF.
- [test_model_resolver.py](graph-editor/lib/tests/test_model_resolver.py)
  — add resolver test for `n_effective` surfacing.

### 14.9 Regression fixtures (new decision)

**Recommendation: seven test cases across the three engine paths.**

Primary fixtures, deterministic by construction:

- `test_blend_lagless_r06`: resolved α=40, β=60, n_effective=100;
  six Cohorts each x_frozen=10, y_frozen=4 (m_S=60, r=0.6). Run
  `_lagless_rows`. Assert the returned `LaglessResult.conditioning`
  reports `r = 0.6` and `blend_applied = True`. Assert the display
  Beta mean on the returned rows matches the analytic blend target
  within 1e-4.
- `test_blend_trajectory_r06`: same resolved and Cohorts, lag-equipped
  (μ=2.0, σ=0.5, onset=0). Run `compute_forecast_trajectory`. Assert
  `ForecastTrajectory.r = 0.6`, `blend_applied = True`, and the
  median of `rate_draws[:, saturation_tau]` within 0.01 (sampling
  tolerance) of the blend target.
- `test_blend_cohort_evals_r06`: same inputs. Assert the blended
  `cohort_evals[i].y_draws` and `x_draws` match the per-Cohort
  analytic blend target (required for the BE topo pass path; the
  `rate_draws` assertion alone does not cover it).
- `test_blend_summary_r06`: run `compute_forecast_summary` with the
  same inputs. Assert `ForecastSummary.r = 0.6`, `blend_applied =
  True`, and that `completeness`, `rate_conditioned`, `p_conditioned`
  are computed from the blended draw set; assert
  `completeness_unconditioned` is unchanged.

Boundary cases (applied across the three engine paths):

- `test_blend_small_r` (r ≈ 0.05): output ≈ fully-conditioned
  (today's behaviour).
- `test_blend_full_r` (r = 1): output ≈ aggregate. For the summary
  path, assert the surprise-gauge-relevant z-score collapses to ≈ 0
  because the blended `completeness` equals `completeness_unconditioned`.
- `test_blend_skip_query_scoped`: set up an analytic_be resolved; run
  any engine path; assert `blend_applied = False` and
  `blend_skip_reason = "source_query_scoped"`.

Fixtures defined inline in the test files — small enough that they
don't need a shared fixture graph.

### 14.10 Other open items (from §12)

- **§12.2 Hierarchical `n_effective`** (raw count vs pooling-adjusted):
  **Recommendation: raw count for v1.** Under-discounts for heavily
  pooled edges, but the under-discount direction matches the pooled
  posterior's own narrower behaviour.
- **§12.3 Selection-beyond-training** (clip vs partition):
  **Recommendation: clip at r = 1 for v1.** Conservative — never
  pretends new Cohorts aren't new, but does lose some useful
  refinement when they exist. v2 can partition if data shows it
  matters.
- **§12.4 Calibration target design**: deferred to post-ship. Held-
  out-Cohort HDI coverage study on production graphs. `γ` defaults to
  linear (1); single engine-wide parameter if tuning is needed.
