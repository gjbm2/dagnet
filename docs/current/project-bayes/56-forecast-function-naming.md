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
  alone.
- Remove the field-name collision on `completeness`, so that no
  identifier in the module can refer to two different semantic
  quantities.
- Expose the currently-internal unconditioned-completeness and
  unconditioned-posterior-predictive-rate quantities as named
  fields, with names that make their "unconditioned" character
  unambiguous. (This is also prerequisite for doc 55 and doc 54
  §8.1, so the naming work and those consumers are mutually
  supportive.)
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

The rename should make each identifier answer, on its own, the
question a reader most needs answered when they encounter it.
Callers of these functions pick between them primarily on output
shape — "do I want scalars to persist / project, or do I want a
trajectory to plot?" That is the axis that should dominate the
names. The IS-strategy difference (aggregate vs sequential) is an
implementation detail of *how each function achieves its output
shape*, not something callers select on.

### 9.1 Top-level functions and return types

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

The IS strategy does not appear in the names. A reader investigating
internals will see the strategy difference inside the function body
and in the module-level docstring (which the rename also updates).
Encoding it in the identifier would make the name longer without
helping callers — callers don't pick on IS strategy.

### 9.2 Field renames to eliminate collisions

On the new `ForecastSummary` (formerly `ConditionedForecast`):

- `completeness` → **`completeness_conditioned`**
- `completeness_sd` → **`completeness_conditioned_sd`**

On the new `ForecastTrajectory` (formerly `ForecastSweepResult`):

- `completeness_mean` → **`completeness_unconditioned`**
- `completeness_sd` → **`completeness_unconditioned_sd`**

After the rename, no identifier in the module refers to two
different semantic quantities. A reader seeing
`result.completeness_conditioned` or `result.completeness_unconditioned`
knows unambiguously what they have.

### 9.3 Fields to add (aligned with doc 55)

On `ForecastSummary`, add four fields populated from locals already
computed inside the function:

- **`completeness_unconditioned`**, **`completeness_unconditioned_sd`**
  — the moments of `mc_completeness_unconditioned` (currently a
  local that is discarded before return).
- **`pp_rate_unconditioned`**, **`pp_rate_unconditioned_sd`** — the
  moments of `p_draws_unconditioned * mc_completeness_unconditioned`
  (element-wise). Both arrays are already in scope; the product
  and its moments are not computed today.

These are the four scalars doc 55 needs. After the rename, both
`ForecastSummary` and `ForecastTrajectory` expose an
`unconditioned` completeness field with the same semantics — one
function exposes it as a scalar summary, the other has always
exposed the same quantity with a less helpful name. Consumers can
read either shape and get a consistent identifier.

### 9.4 What stays unchanged

The following are deliberately out of scope for this rename:

- **Internal helper names.** `_run_cohort_loop`, `_evaluate_cohort`,
  `_weighted_completeness_draws`, `_normalise_log_weights`,
  `_weights_and_ess`, `_cdf_at_age_for_draw`,
  `_edge_cdf_at_age_for_draw`, `_convolve_completeness_at_age`,
  `_compute_completeness_at_age`, and any other private helper in
  `forecast_state.py`. These are module-internal, not referenced
  from outside, and their names are already specific enough.
- **Consumer-side handler names.** `_surprise_gauge_engine_p` in
  `api_handlers.py` uses "engine" in its identifier. The whole
  function is being rewritten as part of doc 55; its rename (if
  any) belongs to that work, not here.
- **Test identifiers.** `test_conditioned_forecast_response_contract.py`
  and any similarly named tests describe the *behaviour they test*.
  When their test subject is renamed, the test file does not need
  to be renamed — its subject is the contract, not the function
  name. Individual test-function names that embed the old names
  are updated in-place, but file names stay.
- **`CohortEvidence`, `CohortForecastAtEval`**, and other shared
  input structures. They aren't ambiguous today; leave them.
- **`ResolvedModelParams` and `resolve_model_params`.** Not
  affected.
- **The lower-level primitives that doc 29f Phase G is unifying.**
  That work has its own naming considerations and should land
  separately.

### 9.5 Fields left alone for now

The CF return's `rate_conditioned` / `rate_conditioned_sd` and
`rate_unconditioned` / `rate_unconditioned_sd` are already
disambiguated and stay. The CF return's `p_draws`, `mu_draws`,
`sigma_draws`, `onset_draws` are technically the conditioned draws
(the `*_unconditioned` siblings hold the pre-IS versions). Renaming
these to `p_draws_conditioned` etc. would be more consistent, but it
expands the rename scope significantly (every downstream caller that
reads draws). The minimum-viable rename leaves these alone and
documents the `*_draws` convention — "bare means conditioned;
`_unconditioned` suffix means pre-IS" — in the module docstring.
A follow-up commit can harmonise these if desired.

### 9.6 Migration strategy

**Hard cut, single commit.** No aliases, no deprecation period.

Reasons:

- This is an identifier substitution with zero semantic change.
  Aliases would introduce a second way to refer to the same thing,
  defeating the purpose of the rename.
- Python import failures are immediate and total; callers that
  miss an update will not run. Review is simple: if CI passes and
  imports resolve, the rename is complete.
- The rename is confined to `graph-editor/lib/runner/forecast_state.py`
  at the definition site and ~30 call sites elsewhere. The blast
  radius is small enough to handle in one commit without
  coordination overhead.
- A multi-week alias window would itself create review confusion
  (reviewers wonder which name is canonical during that window).

The rename commit makes no behavioural changes. The diff is purely
identifier substitution plus the two new fields added to
`ForecastSummary`. Tests pass before and after with equivalent
semantics.

### 9.7 Sequencing

**Before** doc 52 (funnel v2) implementation starts. Funnel v2 will
acquire references to the CF function and its return fields; doing
the rename first means funnel v2 ships with the new names and the
new fields from the start, rather than being retrofitted later.

**Before** doc 55 (surprise gauge rework) implementation starts,
for the same reason. Doc 55 will add four new fields to
`ForecastSummary`; bundling those additions into the rename commit
means the gauge handler can be written once against the final
identifiers.

**Before** doc 47 (whole-graph CF pass) extends what CF writes per
edge. That work will reference field names on the return type; it
should reference the renamed fields from the start.

Practically, this is one commit, landed as soon as possible, with
doc 52 / 55 / 47 implementation following on clean ground.

### 9.8 What lands in the rename commit

1. `graph-editor/lib/runner/forecast_state.py`:
   - Rename `compute_conditioned_forecast` →
     `compute_forecast_summary`. Function body unchanged.
   - Rename `compute_forecast_sweep` →
     `compute_forecast_trajectory`. Function body unchanged.
   - Rename `ConditionedForecast` → `ForecastSummary`. Fields
     renamed per §9.2. Four new fields added per §9.3. Populate
     them from already-computed locals.
   - Rename `ForecastSweepResult` → `ForecastTrajectory`. Fields
     renamed per §9.2.
   - Update the module-level docstring and any inline comments
     that name these functions or their return types. Clarify
     the "bare-draws = conditioned, `_unconditioned` = pre-IS"
     convention (§9.5).
2. All call sites across the repo (~31 files; scope verified by
   grep in the problem statement above): identifier substitution
   only. No semantic changes. Touch the minimum number of lines
   necessary to compile and pass tests.
3. Test files: rename `test_conditioned_forecast_response_contract`
   test-function identifiers that embed the old names; leave
   filenames alone.
4. Docs that reference these identifiers (docs 29, 29e, 29f, 45,
   47, 50, 52, 54, 55, and others catalogued by grep in §5):
   update the identifier references. No meaning changes.

### 9.9 What does NOT land in this commit

- No changes to the gauge handler itself (doc 55's work).
- No changes to CF's on-edge write set (doc 54 §8.1's work).
- No changes to whole-graph CF (doc 47's work).
- No changes to the funnel runner (doc 52's work).
- No primitive-level unification (doc 29f Phase G's work).
- No aliases, deprecation markers, or shim layers.

A reviewer reading the commit sees: identifiers rename, four new
fields added to one struct with their populating lines. That is
all. The review is about nomenclature, not logic.
