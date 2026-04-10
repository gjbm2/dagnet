# Cohort Maturity Documentation Index

**Last updated**: 10-Apr-26

This directory contains all design docs, specs, and investigation notes
for the cohort maturity fan chart and related forecasting work.

---

## Primary design docs

| Doc | Status | Scope |
|-----|--------|-------|
| [cohort-maturity-project-overview.md](cohort-maturity-project-overview.md) | Historical overview + current-state note | Project map, pipeline context, terminology |
| [cohort-maturity-full-bayes-design.md](cohort-maturity-full-bayes-design.md) | Draft with implementation delta | Bayesian update formulas, denominator policy, f/e paths, implementation plan. **Contains open issues §7.5 and §11** |
| [cohort-maturity-fan-chart-spec.md](cohort-maturity-fan-chart-spec.md) | Draft | Chart spec: user-facing behaviour, phasing, window mode computation, fan bounds |
| [cohort-x-per-date-estimation.md](cohort-x-per-date-estimation.md) | Proposal — Option 1 partially implemented | Per-Cohort-date `x` estimation: Options 1/1b/2, comparison, delivery. **Contains open calibration issues §8** |
| [cohort-backend-propagation-engine-design.md](cohort-backend-propagation-engine-design.md) | Proposal | BE propagation engine: shared libraries, state model, join semantics, MC independence |

## Investigation and reference docs

| Doc | Status | Scope |
|-----|--------|-------|
| [fan-chart-mc-bug.md](fan-chart-mc-bug.md) | Open | Root cause: sparse `cohort_at_tau` in cohort mode producing zero-width bands |
| [cohort-forecast-conditioning-attempts-1-Apr-26.md](cohort-forecast-conditioning-attempts-1-Apr-26.md) | Reverted | Audit trail of failed experimental fixes (posterior ESS, conditional blending) |
| [cohort-fan-harness-context.md](cohort-fan-harness-context.md) | Active | Test harness context, epoch boundaries, visual elements |
| [option15.md](option15.md) | Reference | Cursor conversation export: Option 1.5 (subject-conditioned upstream forecast) — analysis of the partition problem at joins |

---

## Current implementation state (10-Apr-26)

### Multi-hop generalisation (Phase A) — substantially implemented

Phase A (`29c-phase-a-design.md`) is substantially implemented (10-Apr-26):

- `cohort_forecast_v2.py` (1000+ lines): span kernel integration,
  x_provider, fan computation — the full v2 row builder.
- `span_evidence.py`: `compose_path_maturity_frames()` — evidence frame
  composition across multi-edge paths, all topologies.
- `span_kernel.py`: `compose_span_kernel()` — conditional x→y kernel via
  node-level DP convolution through DAG, including branching.
- `span_adapter.py`: adapter layer bridging span kernel to row builder.
- `cohort_maturity_v2` registered as analysis type in both FE and BE.
- Parity tests in `test_doc31_parity.py` (v1 vs v2 on adjacent subjects).

**Remaining**: single-hop parity gate (A.4) and multi-hop acceptance
tests (A.5) need formal pass confirmation. Phase B (x provider for
x ≠ a) not yet implemented — design in `29d-phase-b-design.md`.

**Next after parity**: extract reusable forecast helpers into a general
BE library (doc 29 Steps 1–3). Prerequisite: best-available promoted
model resolution (open issue §6 below).

### What the code now does (single-edge)

`graph-editor/lib/runner/cohort_forecast.py` is now a posterior-predictive
simulator, not the earlier CDF-ratio fan prototype.

- **Direct posterior MVN draws** drive the fan. The old global
  importance-sampling approach is gone.
- **Per-Cohort drift** is applied on transformed parameter scales
  (`p`, `mu`, `sigma`, `onset`) so immature Cohorts can vary around the
  shared posterior rather than reusing one global draw unchanged.
- **Per-Cohort frontier conditioning** is now local to each Cohort. The
  simulator reweights/resamples that Cohort's drifted draws against its
  frontier evidence rather than performing one global evidence
  conditioning step.
- **Dense carry-forward arrays** (`obs_x`, `obs_y`) are precomputed and
  reused by the evidence line, midpoint, and fan. Epoch B carry-forward
  is therefore implemented in current code.
- **`tau_observed` is derived from real evidence depth**, preferring
  `evidence_retrieved_at` over the sweep end so stale carry-forward does
  not overstate maturity.
- **Primary cohort-mode anchoring** now uses `calculate_path_probability()`
  plus an explicit `anchor_node_id` on the main Bayes path.

### Current cohort-mode denominator path

The present `cohort()` path is better than the earlier ratio shortcut but
is still not the final architecture:

- Observed `x` is used where the Cohort is still within its observed
  frontier.
- Beyond the frontier, `x_at_tau` is model-derived as
  `a_pop × reach × weighted_upstream_cdf(τ)`, floored at observed
  `x_frozen`.
- In the MC fan, the upstream CDF mixture now varies per draw using
  upstream posterior uncertainty, but `reach` remains a deterministic
  scalar and the overall solve is still local to the subject edge.

### Tests that now cover the live implementation

- Window zero-maturity degeneration is covered in
  `test_cohort_forecast.py`.
- Cohort-mode zero-evidence degeneration is also covered in
  `test_cohort_forecast.py`.
- Window-mode midpoint and fan invariants remain covered by
  `test_cohort_fan_harness.py` and `test_cohort_fan_controlled.py`.

---

## Open issues (consolidated)

### Known approximations and potential enhancements

The items below are known approximations in the current cohort-mode
implementation. None of them block shipping the current single-edge cohort
maturity or the planned A→Z multi-hop maturity (Phase A in
`29-generalised-forecast-engine-design.md`). Each produces reasonable results
for current use cases. They are listed here so we can reason carefully about
whether and when to invest in each.

---

#### 1. No graph-wide propagation engine for x(s,τ)

**Current approach**: The denominator beyond the evidence frontier uses a
subject-edge local shortcut: `x_model(s,τ) = a_pop × reach × weighted_upstream_cdf(τ)`,
floored at observed `x_frozen`.

**What the enhancement would do**: Replace the local shortcut with a full
topological propagation — walk the DAG from anchor to sinks, accumulating
per-node, per-Cohort arrival state at each step. Each downstream edge's `x`
would depend on forecast `y` from all incident upstream edges.

**Pros of attempting**:
- Correctly models upstream immaturity: if an upstream edge is itself immature,
  its forecast `y` (and therefore the downstream `x`) should carry that
  uncertainty. The current shortcut assumes upstream edges are at steady state.
- Required for accurate multi-hop maturity when intermediate edges have
  materially different maturity levels.
- Eliminates the `reach × CDF_path` composition which mixes probability
  sources (see item 2).

**Cons / reasons to defer**:
- The current shortcut works well for the common case: linear funnels where
  upstream edges are more mature than downstream ones (the typical shape).
- The propagation engine is a substantial piece of work — see
  `cohort-backend-propagation-engine-design.md` (32KB design doc, join
  semantics under incomplete inputs, MC independence across nodes).
- For A→Z multi-hop maturity, Phase A sidesteps this entirely by using
  first-edge `x` directly from frames as the denominator. The propagation
  engine would improve accuracy but is not needed for correctness.
- No user has reported a visible artefact from the current shortcut.

**Verdict**: Desired enhancement. Worth doing eventually for funnels with
materially immature upstream edges, but not blocking any current deliverable.

**Detailed design**: `cohort-backend-propagation-engine-design.md`,
`cohort-x-per-date-estimation.md` (Options 1/1b/2 with trade-offs).

---

#### 2. Probability-basis mismatch in denominator

**Current approach**: `reach` is computed from graph path probability
(`calculate_path_probability()`), while the upstream CDF mixture is weighted
using posterior parameters from `read_edge_cohort_params()` which may prefer a
different posterior basis (path-level vs edge-level).

**What the enhancement would do**: Ensure both `reach` and the upstream CDF
mixture draw from a single consistent posterior basis end-to-end.

**Pros of attempting**:
- Eliminates a theoretical inconsistency: one denominator path, two probability
  sources. The effect is on the forecast band shape rather than the midpoint.
- Straightforward to implement if done alongside the unified basis resolver
  proposed in `29-generalised-forecast-engine-design.md` Step 2.

**Cons / reasons to defer**:
- In practice, the divergence is small unless the posterior has moved
  dramatically from the prior. For most edges, posterior p is close to graph p.
- The effect is on the *forecast beyond the frontier*, which is inherently
  uncertain — the basis mismatch is small relative to the overall forecast
  uncertainty.
- Fixing this in isolation (without the graph-wide propagation engine) may
  create a false sense of precision in the denominator that the rest of the
  model doesn't support.
- No user has reported a visible artefact.

**Verdict**: Desired enhancement. Best addressed as part of the unified basis
resolver (Phase 3 of the generalised forecast engine) rather than as an
isolated fix.

**Current documentation**: Identified in `cohort-maturity-full-bayes-design.md`
§11.3 and `cohort-x-per-date-estimation.md` §2.1/2.3, but no detailed
alternative approaches or resolution strategies are documented yet. **Needs a
short design note with options before implementation.**

---

#### 3. Y_C heuristic (missing arrival-time convolution)

**Current approach**: Post-frontier arrivals `X_C` are multiplied by the
tau-dependent model rate `p × CDF(τ)` to produce `Y_C`. This treats all
post-frontier arrivals as if they arrived at the frontier time, when in reality
each arrival at time `t'` has a different remaining conversion window
`(τ - t')`.

**What the enhancement would do**: Replace the direct multiplication with the
proper convolution: `Y_C(τ) = ∫ dX_C(t') × p × CDF(τ - t')`, where `dX_C(t')`
is the marginal arrival rate at time `t'`.

**Pros of attempting**:
- Mathematically correct: each post-frontier arrival's conversion probability
  depends on *when* it arrived, not when the frontier closed.
- Matters most for long conversion windows (large `mu`) combined with rapid
  post-frontier arrivals — e.g. a fast-growing funnel with a slow conversion
  step.
- Would improve fan band accuracy for immature Cohorts where the post-frontier
  contribution is a large fraction of the total.

**Cons / reasons to defer**:
- Second-order effect for most real funnels: when the frontier is reasonably
  recent, most of `X_C` arrived near the frontier and the difference between
  `CDF(τ)` and `CDF(τ - t')` is small.
- Implementing the convolution requires either discretising the arrival-time
  distribution (tractable but adds complexity) or an analytical solution (which
  may not exist in closed form for the shifted-lognormal).
- The current heuristic already uses the tau-dependent rate (not a flat
  ultimate rate), which was the largest correction. The remaining error from
  the missing convolution is smaller.
- Empirical testing (`cohort-maturity-full-bayes-design.md` §7.5) showed that
  the per-tau formula gave empirically better results even though the maths is
  approximate — suggesting the approximation error is small in practice.

**Verdict**: Desired enhancement. The correct formulation should be worked out
on paper before implementing — the integral needs to be discretised into
something implementable. **Needs a mathematical design note before
implementation.**

**Current documentation**: `cohort-maturity-full-bayes-design.md` §7.5, §8,
§11.6. The problem is well-described but the solution is not yet specified.

---

#### 4. Frontier semantics are consumer-specific

**Current approach**: Cohort maturity defines `tau_observed` per Cohort
(derived from `evidence_retrieved_at` or max sweep age). Surprise gauge uses
aggregate completeness — a scalar `c(τ)` across all query contexts. These are
different questions: "how old is *this Cohort's* evidence?" vs "what fraction
of the final conversion has been observed *in aggregate*?"

**What the enhancement would do**: Define a shared frontier contract in the
forecast-state model that both consumers use, making explicit what "frontier"
means and exposing both per-Cohort and aggregate views.

**Pros of attempting**:
- Required for the generalised forecast engine (Phase 0 contract): if both
  consumers draw from a shared state model, the frontier definition must be
  explicit.
- Would enable new consumers (e.g. edge card overlays showing "maturity %" )
  without each one reinventing frontier semantics.
- Per-Cohort `tau_observed` is arguably the more fundamental concept; aggregate
  completeness can be derived from it but not vice versa.

**Cons / reasons to defer**:
- Only matters when you're actually building the shared forecast engine. If
  cohort maturity and surprise gauge remain separate consumers (which they will
  for a while), each can define its own frontier without conflict.
- The two definitions answer genuinely different questions. Unifying them risks
  forcing one semantic where two are appropriate. The contract may need to
  expose *both* rather than pick one.
- Low user impact: no user sees both frontiers simultaneously or is confused by
  their differences.

**Verdict**: Desired enhancement, but only becomes relevant when the
generalised forecast engine (Phases 0–3) is actively being built. Not worth
addressing in isolation.

**Current documentation**: `DATE_MODEL_COHORT_MATURITY.md` §2.2–2.3
(canonical reference), `29-generalised-forecast-engine-design.md` Step 4.4.
Well-documented; no additional design work needed before implementation.

---

#### 5. Epoch orchestration is multi-subject stitching

**Current approach**: The FE plans snapshot subjects per epoch, commissions
separate analysis requests for each epoch block, and stitches the results
together into one continuous chart.

**What the enhancement would do**: The backend would receive one request for
the full cohort set across all epochs and perform a single authoritative solve,
returning unified forecast state. The FE would become rendering-only.

**Pros of attempting**:
- Fewer round-trips (one request instead of N per epoch).
- Eliminates potential stitching artefacts at epoch boundaries.
- Cleaner architecture: the backend owns the full computation, the FE draws.
- Required foundation for the graph-wide propagation engine (item 1), which
  needs to see all Cohorts at once.

**Cons / reasons to defer**:
- The current multi-subject stitching works correctly — no user-visible bugs
  from it.
- The epoch-splitting logic on the FE is already built and tested. Migrating it
  to the backend is re-work with no immediate user-facing benefit.
- Depends on the propagation engine (item 1) for full value — without it, a
  unified backend solve is just moving the same computation to a different
  location.

**Verdict**: Desired architectural improvement. Natural companion to the
propagation engine (item 1) — do them together when the time comes.

**Current documentation**: `cohort-backend-propagation-engine-design.md` §1,
`DATE_MODEL_COHORT_MATURITY.md` §3.

---

#### 6. Forecasting generalisation requires best-available promoted model, not only Bayes vars

**Current approach**: The cohort maturity forecast pipeline consumes Bayes
posterior variables (draws from the MVN posterior) as its model input. This
couples the forecast to the Bayes compilation and update cycle.

**What the enhancement would do**: Before generalising forecasting for broader
consumption in the app (e.g. edge card overlays, scenario-level maturity,
automated staleness nudges), the pipeline must be able to consume the **best
available promoted model** — not only Bayes vars. This means the forecast
engine should resolve the best available model for an edge (which may be a
promoted Bayes posterior, a promoted MLE fit, or a prior-only default) and
use that uniformly, rather than requiring a full Bayes posterior to exist.

**Why this matters**:
- Many edges will never have a Bayes posterior (insufficient data, no Bayes
  run configured, or Bayes run not yet complete).
- Generalised consumers should not fail or degrade silently when Bayes vars
  are absent — they should use the best model available.
- The promoted-model concept already exists in the snapshot DB; the gap is
  that the forecast pipeline does not yet resolve and consume it generically.

**Verdict**: Prerequisite for generalising forecasting beyond the current
cohort maturity chart. Must be addressed before broader forecast consumption
is rolled out.

---

### Issues now resolved

- Epoch B carry-forward is implemented.
- Window zero-maturity degeneration is verified by test.
- Cohort zero-evidence degeneration is verified by test.
- The old recursive shared-ancestor reach bug is resolved on the primary Bayes
  path.
- The old global importance-sampling fan path is gone.
- **Fallback-path anchoring fixed (7-Apr-26)**: The no-Bayes fallback in
  `api_handlers.py` now resolves and passes `anchor_node_id`, matching the
  primary Bayes path.

### Recommended reading order

1. Read `cohort-maturity-full-bayes-design.md` for the intended algebra and the
   still-live `Y_C` and denominator questions.
2. Read `cohort-x-per-date-estimation.md` for the current `x(s,τ)` gap between
   the local shortcut and a proper graph-wide solve.
3. Read `cohort-backend-propagation-engine-design.md` for the target
   architecture that would eliminate the remaining local shortcuts.
