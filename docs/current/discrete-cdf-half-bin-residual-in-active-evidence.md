# Discrete CDF Half-Bin Lead in Active-Cohort Evidence

**Status**: Open (parked). Documents a known systematic bias in
chart `evidence_x` / `evidence_y` for active cohort queries.
**Date opened**: 7-May-26
**Related**: [`project-bayes/51-model-curve-overlay-divergence.md`](project-bayes/51-model-curve-overlay-divergence.md)
§3.2 (originating problem statement and earlier P0.1 attempt).

## Headline

The model-projected mass surfaces feeding the active-cohort
`SelectedAClockEvidence` cells (`runtime.selected_x_prefix` and the
`_RateAttributedSubjectPrefix` Y) inherit a half-bin lead from the
rectangle-rule cumsum scheme in
[`_edge_sub_probability_density`](../../graph-editor/lib/runner/span_kernel.py#L83).
For lognormal carriers in their density-peak region the lead is a
small absolute shift on the τ-axis but a large percentage of CDF, so
chart `evidence_x` reads ~10-20% above raw observed counts at low τ.
The bias is **deterministic**, present even when sampling variance
is removed (verified against the `synth-simple-flat-abc` fixture
with `kappa_sim_default = 10⁹`).

This is **not** a bug in the cohort maturity pipeline. It's a
property of the discrete CDF convention adopted across the
forecasting stack and documented in doc 51 §3.2. The active-cohort
display path is a new consumer of that convention; the bias was not
measured against per-cohort observed counts before.

## Empirical signature

Test fixture: `synth-simple-flat-abc` (truth file
`bayes/truth/synth-simple-flat-abc.truth.yaml`). All variance sources
zeroed (`kappa_sim_default = 10⁹`, `drift_sigma = 0`,
`failure_rate = 0`, `traffic_cv = 0`). Per-cohort realised reach
matches truth to within floating-point.

Query: `from(synth-simple-flat-abc-b).to(synth-simple-flat-abc-c)
.cohort(1-Mar-26:3-Mar-26).asat(20-Mar-26)`. Carrier
`p=0.7, mu=2.3, sigma=0.5, onset=1`. Carrier mode at τ ≈ 7-8 days.

| τ | chart_x | oracle_x | Δx | comment |
|---|--------:|---------:|----:|---------|
| 8  | 11920 | 10022 | **+19%** | near carrier mode (steep CDF slope) |
| 10 | 19396 | 17660 | **+10%** | post-mode shoulder |
| 12 | 25765 | 24303 | **+6%**  | declining slope |
| 14 | 30636 | 29530 | **+4%**  | tail |
| 17 | 35497 | 34682 | **+2%**  | far into tail |

The bias monotonically shrinks as τ moves away from the carrier's
density peak. Same shape, smaller magnitude, persists in `evidence_y`
(<5% at the bulk τ range; <2% near saturation).

## Cause

Per [`span_kernel.py:97-104`](../../graph-editor/lib/runner/span_kernel.py#L97):

> "cumsum(result) at integer τ approximates CDF_continuous(τ + 0.5)
> — a constant half-bin lead regardless of convolution depth"

Where `density_cdf` plateaus at the edge probability `p`, the bias
is constant in absolute terms (half a bin) and shrinks as a percentage
of the cumulative. Where the underlying lognormal PDF is large
(near its mode), half a bin contains a non-trivial mass — for a
lognormal peaking at τ ≈ 8 with peak density ≈ 0.18, the rectangle-
rule CDF at τ leads the continuous CDF at τ by roughly
`0.5 × peak_density ≈ 0.09` units of probability, i.e. 9 percentage
points of CDF in absolute terms.

Doc 51 §3.2 derives this in detail and records why the obvious
"fix" (CDF-differences) was tried, measured worse under convolution,
and reverted — `⌈X_A⌉ + ⌈X_B⌉` is on average 1 greater than
`X_A + X_B`, so a CDF-difference scheme produces a depth-linear shift
rather than a depth-constant one. The rectangle rule's bias is at
least **bounded and constant under convolution**.

## Where the lead propagates in active-cohort evidence

[`span_kernel.py`](../../graph-editor/lib/runner/span_kernel.py)
returns `density_cdf` from
`compose_timing_span_from_transition_primitives`. The active-cohort
display surface consumes this via two paths, both in
[`cohort_forecast_v3.py`](../../graph-editor/lib/runner/cohort_forecast_v3.py):

1. **`_build_selected_source_day_mass`** (`cohort_forecast_v3.py:1577`)
   — differences `density_cdf` into a per-day arrival pmf, multiplies
   by `n_cohort_by_anchor`, stores per `(U, anchor, source_day)`.
   This is `M_select`, the model-projected count of selected-cohort
   members at primitive source node `U` per day. Both
   `_CarrierOnlyDenominatorPrefix` and `_RateAttributedSubjectPrefix`
   read from this surface.

2. **`_CarrierOnlyDenominatorPrefix.value_at`**
   (`cohort_forecast_v3.py:557`) — chart `evidence_x` for the
   active-cohort row; cumulates `M_select` from `anchor` to
   `anchor + τ`. Inherits the half-bin lead directly.

`evidence_y` reads `_RateAttributedSubjectPrefix.value_at`
(`cohort_forecast_v3.py:591`), which is
`Σ_u M_select(X, C, u) × k(u, τ)/n(u, τ)`. The lead enters via
`M_select` and is partially attenuated by the empirical rate
(itself a CDF measured at the same integer τ on the data side, so
broadly absorbing some of the offset on the rate side). Magnitudes
on flat fixture: ≤5% at bulk τ, ≤2% near saturation.

## Why the active-cohort surface exposes it

The cohort-family snapshot row's `x` field is a count: cohort
members observed at X by `retrieved_at`. It's an empirical CDF
measured at integer days. The active-cohort chart line's `evidence_x`
is built from `M_select`, the model's prediction of the same
quantity, but read at integer τ from the rectangle-rule cumsum.

For static analyses where only post-saturation values matter, the
2% residual at τ = 17 is invisible. The active-cohort suite added
oracle equality at every τ including the rising flank where the
half-bin lead lands hardest on the percentage scale (τ = 8: 19%).
The convention now visibly fails the test it was never asked to
satisfy before.

## Proposed solutions

In rough order of cost vs invasiveness.

### A. Re-author the active-cohort oracle to match the chart's discretisation

Cheapest. Make the oracle read its cohort-family `x` and `y` values,
then apply the same half-bin offset on its side: compare against
`x[τ-0.5]` (linear-interpolated between integer days) instead of
`x[τ]`. Doc 51 §3.2 already accepts the rectangle-rule convention
as the definition of "the discrete CDF"; the active-cohort oracle
should compare on the same convention.

- **Pro**: zero system changes. Oracle is test-only code. Closes the
  test failure cleanly.
- **Con**: oracle is now bound to a discretisation choice. If the
  underlying scheme ever changes, the oracle has to track it.
- **Risk**: low.

### B. Loosen oracle tolerance to a known half-bin envelope

Even cheaper, less precise. The half-bin lead is bounded by
`0.5 × max(pdf)` in absolute CDF terms. For lognormal peaks ≈ 0.18,
the bound is ≈ 9 percentage points of carrier reach. Tolerance
becomes `max(absolute_floor, 0.5 × max(pdf) × n_cohort)` per τ.

- **Pro**: very small change.
- **Con**: hides genuine regressions inside the envelope. Provides
  no defence against drift in the discretisation itself.
- **Risk**: low for catching breakage; medium for masking it.

### C. Switch to a finer convolution grid

Replace integer-day grid with sub-day (e.g. 0.1-day) bins inside
`compose_timing_span_from_transition_primitives`. Half-bin lead
shrinks by the refinement factor.

- **Pro**: improves the underlying quantity for every consumer
  (cohort maturity, model curve overlay, forecast trajectory, etc.),
  not just the failing test.
- **Con**: increases memory and CPU by the refinement factor across
  the entire forecasting hot path. Multi-hop convolution dominates
  this cost. The original P0.1 spike (doc 51 §3.2 sidebar) is the
  closest precedent — reverted because it shifted bias rather than
  shrinking it; a finer grid is a different change but in the same
  surface.
- **Risk**: medium. Performance regression risk is real on long
  multi-hop spans; any existing tolerance built around the half-bin
  convention may flip in either direction.

### D. Convolution-preserving discretisation

A scheme that's exact for both single-edge and multi-edge cases.
Candidate: trapezoidal rule on the PDF (each integer τ takes
`0.5 × (pdf(τ) + pdf(τ-1))` instead of `pdf(τ)`), or the
half-shifted grid (`pdf` evaluated at τ + 0.5 sample points). Both
are unbiased to first order under convolution and approach the
continuous CDF more cleanly.

- **Pro**: structurally correct rather than bias-shifted. Matches
  doc 51 §3.2's "genuinely unbiased fix" criterion.
- **Con**: requires careful design and full re-validation of every
  consumer. Tolerances tuned to the rectangle-rule convention will
  need to move. Trapezoidal cumsum is one extra add per bin (~free)
  but shifts the discrete CDF semantic.
- **Risk**: medium-to-high. Touches a surface that all timing
  consumers share.

### E. Do nothing; accept the residual

The active-cohort oracle can be marked xfail with a documented
tolerance for the half-bin lead, the way the trajectory engine's
P0.3 parity test absorbed the same convention (`docs/current/
project-bayes/51-model-curve-overlay-divergence.md` §P0.3).

- **Pro**: zero cost. Honest about the convention.
- **Con**: leaves the test useless as a regression guard for the
  active-cohort surface specifically.
- **Risk**: low, but adds another deferred item on the
  half-bin-convention dead-line.

## Recommendation

**Land A** as the immediate test fix. The oracle is test-only;
binding it to the same convention the production surface uses is the
right way to test that convention's outputs without lying about
what the production surface computes. This unblocks the
active-cohort regression suite.

**Defer B–D** as a single cross-cutting decision tracked on doc 51's
"longer-term" line. The half-bin convention is now load-bearing
across the trajectory engine, the active-cohort display, the model
curve overlay, and any future consumer of `density_cdf`. Changing
it is not a one-test fix; it's a discretisation upgrade that affects
every consumer of timing-span composition. If/when grid refinement
or trapezoidal discretisation lands, the active-cohort oracle
authored under (A) will follow the same convention by construction
and continue to track.

## Verification protocol for any future fix

The half-bin lead is measurable as a deterministic offset, not a
sampling fluctuation. Any solution should be validated against:

1. `synth-simple-flat-abc` (`kappa_sim_default = 10⁹`) chart_x vs
   raw cohort-family x at τ = 8, 10, 12, 14, 17 — bias should be
   sub-percent at every τ.
2. Doc 51's existing P0.3 parity test
   (`cohort-maturity-model-parity-test.sh`, 0.1% tolerance) — must
   continue to pass.
3. Multi-hop convolution depth check: bias must not grow with
   convolution depth (the failure mode that reverted P0.1).
4. Hot-path latency on a representative LAT4-class multi-hop query
   — must not regress beyond an explicit budget.
