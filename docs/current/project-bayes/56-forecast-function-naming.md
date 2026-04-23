# 56 — Forecast Function Naming: Problem Statement and Rename Proposal

**Status**: Problem statement and rename proposal — implementation not started.
**Date**: 20-Apr-26
**Related**: doc 29 / 29e / 29f (generalised forecast engine), doc 45 (CF pass ownership), doc 47 (whole-graph CF pass), doc 54 (CF readiness protocol), doc 55 (surprise gauge rework).

---

## 1. The problem

Two top-level functions in `graph-editor/lib/runner/forecast_state.py`
drive essentially all per-edge forecast computation across the
application:

- `compute_conditioned_forecast`
- `compute_forecast_sweep`

Their names do not convey what distinguishes them. Reading either
name in isolation, a reviewer cannot tell whether the function
returns scalars or trajectories, whether its IS strategy is aggregate
or sequential, or what the intended caller shape is. In the same
file, their return types — `ConditionedForecast` and
`ForecastSweepResult` — share the same pattern: the names describe a
category of object, not the specific output shape.

The consequence is routine reviewer confusion, including by the
author of this doc, who has repeatedly mis-traced which function a
given caller is exercising, mis-identified which `completeness` field
is conditioned vs unconditioned, and mis-attributed sweep behaviour
to CF and vice versa. Recent design work for the surprise gauge rework
(doc 55) and the CF readiness protocol (doc 54) both ran into this —
doc 55 needed a mid-design correction that boiled down to "which of
these two functions are we actually reading from."

The functions themselves are correct. The problem is that their
identifiers do not help readers tell them apart.

## 2. What each function actually does

Both functions live in the same module and operate on the same
underlying model — an edge's Bayesian posterior on
`(p, μ, σ, onset)`, combined with cohort evidence from the snapshot
DB. Beyond that they diverge in three ways that matter to every
caller.

**Input binding.** One function takes cohort evidence as summary
tuples `[(τ_i, n_i, k_i)]` paired with a separate list of cohort
ages and weights. The other takes a list of `CohortEvidence`
structures with full per-day `obs_x` / `obs_y` trajectories. A
caller cannot accidentally pass one set of inputs to the other — the
signatures are incompatible — but a reader looking at just the name
can't tell which shape is expected.

**Importance-sampling strategy.** `compute_conditioned_forecast` uses
aggregate tempered IS: it sums log-likelihoods across all cohorts in
one pass, applies tempering to maintain a target ESS, and reindexes
the draws exactly once. `compute_forecast_sweep` uses sequential
per-cohort IS inside its cohort loop: each cohort's likelihood
resamples the draws, the next cohort inherits the resampled draws,
and the cascade continues. These are genuinely different IS
procedures with different convergence behaviour and different
sample-concentration characteristics. Neither name hints at this.

**Output shape.** `compute_conditioned_forecast` returns a
`ConditionedForecast` object populated with scalar summary
statistics — mean and SD of conditioned and unconditioned `p`, mean
and SD of conditioned completeness, plus the MC draws themselves for
downstream consumers. `compute_forecast_sweep` returns a
`ForecastSweepResult` populated with two-dimensional matrices: an
`S × T` conditioned rate trajectory, an `S × T` unconditioned rate
trajectory, per-cohort at-eval-age outputs, and deterministic
totals. Scalars for persistence vs. matrices for plotting — the
caller's reason for calling is completely different, and nothing in
the function names indicates this.

## 3. Why the names mislead

**"Sweep"** suggests comprehensiveness — the function that sweeps
across everything. In practice `compute_forecast_sweep` uses the
weaker IS strategy, serves only the cohort-maturity chart and
daily-conversions consumers, and does not produce the scalars most
of the application consumes. It is not "the full version" of the
other function.

**"Conditioned forecast"** is accurate — the function does produce a
conditioned forecast — but it elides the fact that
`compute_forecast_sweep` is also conditioning, just differently. A
reader encountering both names without context would reasonably
infer that `compute_conditioned_forecast` is "the conditioned one"
and `compute_forecast_sweep` is "the unconditioned one". That
inference is wrong on both counts.

**Field collisions.** The two return types both expose a field
called `completeness` (and another called `completeness_sd` /
`completeness_stdev`). On `ConditionedForecast` this field holds a
conditioned value. On `ForecastSweepResult` it holds an
unconditioned value. The field name alone carries no information
about which semantic applies. A caller that reads
`result.completeness` cannot know from inspection whether the value
reflects evidence-conditioned maturity or the raw MCMC posterior's
maturity. They are opposite semantics behind an identical identifier
in the same file.

**"Unconditioned" naming is worse still.** The CF return has a field
`rate_unconditioned` (with a source comment saying it is "used by
surprise gauge as baseline"), but no named field for unconditioned
completeness — the same internal variable that produces
`rate_unconditioned` is computed but discarded before return. On
`ForecastSweepResult`, unconditioned completeness happens to be what
the single `completeness` field holds (because the chart's IS does
not apply to the completeness computation). A reviewer who searches
the codebase for "unconditioned completeness" will find neither a
field nor a consistent convention. Doc 55 spent several messages
navigating this because the field naming gave no clues.

## 4. Why this compounds over time

Each new consumer inherits the ambiguity. Doc 52 (funnel hi/lo bars)
will read CF-written fields. Doc 54 (CF readiness protocol)
proposed additional CF-owned scalars and immediately had to
disambiguate "which completeness". Doc 47 (whole-graph CF pass)
wants to emit even more scalars per edge. Each consumer has to
re-litigate the naming in order to specify what it needs. The
surface area of confusion scales with the number of consumers.

Phase G (doc 29f) is unifying the *underlying primitive*
(`_evaluate_cohort`) so both functions call the same core maths.
That unification is sound and in-flight. It does not solve the
naming problem, because the top-level functions remain distinct by
design — they serve different callers with different input shapes
and different output shapes. Phase G's primitive-level unification
is orthogonal to the top-level naming.

## 5. Scope of the ambiguity

Two function names and their two return types are the clearest
offenders. Beyond those, the problem touches:

- Field names on both return types that use the same identifier
  for opposite semantics (`completeness`).
- Absent field names for quantities that exist internally but are
  not exposed (unconditioned completeness moments, unconditioned
  posterior-predictive rate moments). The gap forces consumers
  either to recompute from raw draws or to add named fields ad
  hoc, which further fragments the naming.
- Module-level comments and docstrings that assume the reader
  already knows which function is which.
- The ~31 files across the repo that reference the two function
  names. Each is a site that has made an assumption about what the
  function does; each would need verification if the names
  changed.

## 6. Concrete incidents this has caused

- Doc 55's first design pass asserted that
  `compute_forecast_sweep` returned a conditioned completeness
  moment. It does not. The correction took one round of direct
  source reading, after which the design changed materially.
- The surprise gauge's current backend handler
  (`_surprise_gauge_engine_p`) calls `compute_forecast_sweep` even
  though the gauge's natural home is `compute_conditioned_forecast`,
  which has a source comment explicitly noting it is "used by
  surprise gauge as baseline". The implementation history suggests
  the handler author picked the function whose name sounded
  closer to "do a sweep of forecasts", not the one designed for
  gauge use.
- Doc 54 §8.1, specifying a CF scalar output contract extension,
  initially treated "CF completeness" as a single quantity. Doc 55
  later needed to distinguish conditioned from unconditioned and
  rewrite the contract extension. The §8.1 text now names four
  distinct scalars where originally one pair was proposed.
- Trace attempts in conversation repeatedly landed on the wrong
  function. This is the most mundane symptom but also the loudest
  — every investigation that has to walk through the forecast
  engine pays a recurring cognitive tax.

## 7. What a solution should achieve

A solution to this problem should, at minimum:

- Make the two top-level functions distinguishable from their
  names alone, without requiring the reader to inspect the
  signature.
- Make the two return types distinguishable from their names
  alone. (Renaming the functions without renaming their return
  types would just recreate the confusion one layer down — the
  reader would see `new_function_name(...) -> OldReturnTypeName`
  and wonder which name is canonical.)
- Keep the identifier style consistent with the surrounding
  `forecast_state.py` / `runner/` conventions; this is a rename,
  not a stylistic overhaul.
- Not pretend the two functions are coordinate-variants of one
  another. They are not. Any name that implies equivalence
  (`..._by_tau` / `..._by_date`, for example) is a worse name
  than the current one, because it encodes a false claim about
  the code.

The solution should not:

- Alter either function's semantics, IS strategy, or return
  shape.
- Rename fields on either return type. Field-level naming
  problems (e.g. the `completeness` clash described in §3) are
  real but are separate workstreams — they belong to whichever
  consumer doc actually needs the fields (docs 52, 54 §8.1, 55).
- Add new fields to either return type. That work also belongs
  to the consumer docs.
- Merge the two functions. Phase G's primitive unification is the
  right place for any merging; that work is separate.
- Touch consumers beyond updating their identifiers.

## 8. Why this is a separate workstream

The rename is a cross-cutting pure-refactor change: ~31 files,
identifier updates, no behaviour change. Bundling it into a
feature commit (doc 55, doc 52, doc 54, doc 47) would contaminate
the review and make each feature's diff harder to read. Pulling
it out as its own commit means feature reviews can focus on the
logic, and the rename can be reviewed as what it is — an
identifier substitution with a clear before/after.

Sequencing it before the feature commits that land new consumers
(funnel v2, whole-graph CF pass) reduces the churn that would
otherwise happen when those consumers acquire references to the
old names and then have to be updated again.

Sequencing it after doc 55 and doc 54 §8.1 is also acceptable —
they can ship with the old names and be caught up in the rename
sweep. Either ordering works; what is not viable is leaving the
naming ambiguous indefinitely as the consumer set grows.

## 9. Naming proposal

The rename touches four identifiers: two top-level functions and
their two return types. Nothing else. No field renames, no added
fields, no consumer-side changes beyond identifier substitution.

Callers of these functions pick between them primarily on output
shape — "do I want scalars to persist / project, or do I want a
trajectory to plot?" That is the axis that should dominate the
names. The IS-strategy difference (aggregate vs sequential) is an
implementation detail of *how each function achieves its output
shape*, not something callers select on.

### 9.1 The renames

- `compute_conditioned_forecast` → **`compute_forecast_summary`**
- `compute_forecast_sweep` → **`compute_forecast_trajectory`**
- `ConditionedForecast` → **`ForecastSummary`**
- `ForecastSweepResult` → **`ForecastTrajectory`**

Rationale:

- **Summary** captures the essence of what the current
  `compute_conditioned_forecast` returns: scalar moments ready to
  persist onto the edge, project into gauge variables, or hand to
  a funnel computation. Consumers want a snapshot, not a curve.
- **Trajectory** captures the essence of what the current
  `compute_forecast_sweep` returns: `(S × T)` matrices that the
  cohort-maturity chart and daily-conversions chart turn into
  curves. Consumers want to plot.
- Both names drop "conditioned" and "sweep" — both misleading
  terms when taken out of context. "Sweep" wrongly implies
  comprehensiveness; "conditioned" wrongly implies the other
  function doesn't condition. Neither term survives the rename.
- Both names keep the `compute_forecast_` prefix so the two
  functions remain visually paired in any import list or file
  navigator.
- The return types rename in lockstep with their functions.
  Leaving `compute_forecast_trajectory(...) -> ForecastSweepResult`
  would recreate the original confusion in the type signature:
  the reader would still not know which name was canonical. The
  rename only works if both layers move together.

The IS strategy does not appear in the names. A reader investigating
internals will see the strategy difference inside the function body
and in the module-level docstring (which the rename also updates).
Encoding it in the identifier would make the name longer without
helping callers — callers don't pick on IS strategy.

### 9.2 What stays unchanged

Everything except the four identifiers. Specifically:

- **All field names on both return types.** The `completeness`
  clash described in §3, the `p_draws` / `mu_draws` / `sigma_draws`
  / `onset_draws` clash (bare-names-mean-conditioned on one type,
  bare-names-mean-unconditioned on the other), and any asymmetries
  in which scalars are exposed vs. computed-and-discarded — all
  remain. They are real problems but they are not the problem this
  workstream addresses. They belong to whichever consumer doc
  needs the field (doc 55 for the unconditioned scalars, doc 54
  §8.1 for the CF readiness scalars, doc 52 for the funnel bars).
- **No new fields.** Any addition to either return type ships with
  the consumer doc that motivates it, not here.
- **Internal helper names.** `_run_cohort_loop`, `_evaluate_cohort`,
  `_weighted_completeness_draws`, `_normalise_log_weights`,
  `_weights_and_ess`, `_cdf_at_age_for_draw`,
  `_edge_cdf_at_age_for_draw`, `_convolve_completeness_at_age`,
  `_compute_completeness_at_age`, and any other private helper in
  `forecast_state.py`.
- **Consumer-side handler names.** `_surprise_gauge_engine_p` in
  `api_handlers.py`. Being rewritten as part of doc 55; any rename
  belongs there.
- **Test identifiers.** Test filenames describe the *behaviour they
  test*, not the function. `test_conditioned_forecast_response_contract.py`
  and `conditionedForecastCompleteness.test.ts` stay.
  Individual test-function names that embed the old identifiers
  are updated in-place (they *are* the identifiers).
- **Service filenames.** `conditionedForecastService.ts` stays.
  The file is a service module; its filename is a module handle,
  not a semantic anchor. The identifiers it exports / imports are
  updated; the filename is not. A follow-up can harmonise the
  filename if ever needed — not part of this commit.
- **`CohortEvidence`, `CohortForecastAtEval`**, and other shared
  input structures.
- **`ResolvedModelParams` and `resolve_model_params`.**
- **The lower-level primitives that doc 29f Phase G is unifying.**

### 9.3 Migration strategy

**Hard cut, single commit.** No aliases, no deprecation period.

- This is an identifier substitution with zero semantic change.
  Aliases would introduce a second way to refer to the same thing,
  defeating the purpose of the rename.
- Python import failures are immediate and total; callers that
  miss an update will not run. Review is simple: if CI passes and
  imports resolve, the rename is complete.
- The rename is confined to `forecast_state.py` at the definition
  site and the call sites elsewhere. The blast radius is small
  enough to handle in one commit.
- A multi-week alias window would itself create review confusion
  (reviewers wonder which name is canonical during that window).

The commit makes no behavioural changes. The diff is purely
identifier substitution. Tests pass before and after with
equivalent semantics.

### 9.4 Sequencing

**Before** doc 52 (funnel v2), doc 55 (surprise gauge rework),
doc 54 §8.1 (CF readiness scalars), and doc 47 (whole-graph CF
pass) implementation work begins. Each of those workstreams will
acquire references to the functions and return types; doing the
rename first means they reference the final identifiers from the
start rather than being retrofitted later.

Practically, this is one commit, landed as soon as possible, with
the consumer docs following on clean ground.

### 9.5 What lands in the rename commit

1. `graph-editor/lib/runner/forecast_state.py`: four identifier
   substitutions (two function names, two class names). No body
   changes, no field changes, no new fields. Update the module
   docstring and any inline comments that name these functions or
   return types.
2. All call sites across the repo, enumerated by
   `grep -l 'compute_conditioned_forecast\|compute_forecast_sweep\|ConditionedForecast\|ForecastSweepResult'`:
   identifier substitution only. No semantic changes.
3. Test-function names that embed the old identifiers: updated
   in-place. Test filenames unchanged.
4. Every doc returned by the same grep against `docs/current/`:
   identifier references updated. No meaning changes. Enumerating
   by grep (not a hand-maintained list) prevents the commit from
   shipping with a stale doc.

### 9.6 What does NOT land in this commit

- No field renames on either return type (including the
  `completeness` and `p_draws` clashes — they remain until their
  owning consumer doc addresses them).
- No new fields on either return type.
- No changes to the gauge handler (doc 55's work).
- No changes to CF's on-edge write set (doc 54 §8.1's work).
- No changes to whole-graph CF (doc 47's work).
- No changes to the funnel runner (doc 52's work).
- No primitive-level unification (doc 29f Phase G's work).
- No aliases, deprecation markers, or shim layers.

A reviewer reading the commit sees: four identifiers rename
everywhere they appear. That is all. The review is about
nomenclature, not logic.
