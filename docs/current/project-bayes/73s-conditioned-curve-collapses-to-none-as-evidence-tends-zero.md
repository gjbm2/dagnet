# 73s — Conditioned model curve collapses to None as evidence → 0

**Date**: 8-May-26
**Status**: Open — problem statement only; principled fix is separate work
**Severity**: High — invariant violation; visible defect on cohort() queries lacking evidence

## Summary

In cohort maturity v3 the row schema's `midpoint` field — the
**conditioned model curve** — collapses to `None` for some τ when
evidence is absent or sparse. The expected behaviour (and stated
invariant) is that the conditioned curve always emits a value and
**degenerates naturally to the model-vars priors as evidence → 0**.

The root cause is upstream of the row builder and upstream of the
projection reducer's `where(X > 1e-12, Y/X, NaN)` policy. The
runtime's per-capita conditioned posteriors (`composed_subject`,
`composed_carrier`) are *correctly* well-formed when evidence is
empty (they fall back to priors via `condition_primitive`'s
`PRIOR_ONLY` status). The defect is that the displayed rate is then
re-derived through cohort *mass* mechanics whose amplitude is gated
by evidence-derived population scalars (`a_pop`, `x_frozen`). When
those scalars are zero, the per-capita posterior is effectively
multiplied by zero before being divided back out — and the
multiply-then-divide produces `0/0` instead of cancelling to the
per-capita rate.

## Symptom

For a `cohort(A, X-Y)` query with `A ≠ X` where the runtime has no
admissible root-window carrier evidence on the carrier path:

  - `midpoint` is `None` across all τ (or across most τ, including
    epoch A);
  - `model_midpoint` (the unconditioned predictive overlay) is
    well-defined at the same τ values;
  - the chart shows the unconditioned overlay but no conditioned
    curve, which contradicts the user-facing intent that the
    conditioned curve should always render and dovetail with the
    unconditioned curve as evidence vanishes.

The same shape appears in two narrower sub-cases:

  - Window mode (or `cohort(A=X)`) with no frames at all —
    the synthesised placeholder cohort has `x_frozen = 0`, the
    identity-carrier branch's denominator carry-forward is also
    zero, and `midpoint` collapses across the whole horizon.
  - Cohort `A ≠ X` with frames present but no carrier-path
    root-window evidence — `a_pop` is force-zeroed at the
    `_root_window_carrier_n_by_anchor_day` step, and the cohort's
    contribution to the projection is multiplied by zero.

## Where in the machinery

There are two amplifying sites. Both operate on the cohort
*population* layer, upstream of the reducer's NaN-emit policy.

### Site 1: cohort population zeroing on missing carrier evidence

[`cohort_forecast_v3.py:4961-4997`](../../graph-editor/lib/runner/cohort_forecast_v3.py#L4961-L4997).

In active mode, `_root_window_carrier_n_by_anchor_day` is consulted
for each cohort anchor:

```
n_root = n_by_anchor.get(ad_str)
if n_root is not None and n_root > 0:
    ec.a_pop = float(n_root)                          # carrier evidence present
elif int(ci.get('tau_observed', 0) or 0) < 0:
    # synthesised default a_pop=1 preserved              empty-frames sentinel
    a_pop_provenance[ad_str] = 'empty_frames_prior'
else:
    ec.a_pop = 0.0                                    # frames present, no carrier ev
    a_pop_provenance[ad_str] = 'no_root_window_evidence'
```

The `else` branch sets the cohort's notional population to zero
when frames exist but no admissible root-window carrier evidence is
found. The justification in the surrounding comment is
"frame-bundle 'a' is not an admissible fallback (Phase 3
implementation plan)" — i.e. the frame's `a` count cannot stand in
for carrier-path evidence under the seam invariant.

This is correct as a **counts** decision (the cohort's absolute
count contribution is unknown) but wrong as a **rate** decision
(the per-capita rate is well-defined). The two are entangled
because the same `a_pop` flows into both.

The `tau_observed = -1` branch above explicitly preserves
`a_pop = 1.0` precisely so that "the projection produces the
natural Bayesian degeneracy (posterior = prior) — i.e. the
unconditioned carrier × subject convolution at unit population."
That's the invariant in question. The `else` branch should produce
the same degeneracy on the rate surface but currently does not.

### Site 2: identity-carrier basis on missing observed mass

[`cohort_forecast_v3.py:3683-3685`](../../graph-editor/lib/runner/cohort_forecast_v3.py#L3683-L3685) (with a related Pop D pool decision at [`3624`](../../graph-editor/lib/runner/cohort_forecast_v3.py#L3624)).

The reducer's identity-carrier branch (window mode, `cohort(A=X)`)
carries the cohort's observed mass forward as the denominator
basis:

```
X_total[:, future_slice] += x_frozen
```

`x_frozen` is the observed count at X. When it is zero
(synthesised cohort with no frames), the denominator stays at
zero across the whole future range. The Pop D pool is computed as
`max(x_frozen − y_frozen, 0.0) = 0`, so Pop D contributes nothing.
With `Y_total` and `X_total` both zero, the reducer's NaN-emit
fires on every τ and `midpoint` is `None` everywhere.

Comments at [`3674-3682`](../../graph-editor/lib/runner/cohort_forecast_v3.py#L3674-L3682) acknowledge this and explicitly defer
the fix upstream: "The no-evidence degeneracy (`x_frozen == 0`,
`a_pop > 0`) must be handled upstream rather than by silently
re-targeting the denominator here." The comment's author chose
`x_frozen` (rather than `a_pop`) for the carry-forward to avoid a
vertical cliff at `tau_solid_max + 1` for multi-hop window cohorts
where `a > x` — a real numerical concern that any fix has to
preserve.

### Why this is upstream of the reducer's NaN policy

The reducer's `where(X_total > 1e-12, Y/X, NaN)` at
[`3749-3754`](../../graph-editor/lib/runner/cohort_forecast_v3.py#L3749-L3754) is a *consequence*, not the cause: by the time
control reaches that line, `X_total` is genuinely zero across the
draw axis at the affected τ values, because the population scalar
that fed it was zero at site 1 or site 2. Switching the NaN-emit
to a 0-emit (the F-mode overlay's policy at
[`1510`](../../graph-editor/lib/runner/cohort_forecast_v3.py#L1510)) would replace `None` with `0` cosmetically, but would
not produce the "degenerates to prior shape" invariant the user
expects.

## The mechanism in algebraic terms

The displayed rate is per-capita by construction (§"Rate semantics"
of [COHORT_ANALYSIS_NUMERATOR_DENOMINATOR_SEMANTICS.md](../codebase/COHORT_ANALYSIS_NUMERATOR_DENOMINATOR_SEMANTICS.md)):

  `r(τ) = Y(τ) / X(τ) = (N · P(reach end by τ)) / (N · P(reach X by τ))`

The cohort population `N` cancels. Substituting per-capita
posteriors gives the closed-form expression:

  - Window: `r(τ) = p_subj · F_subj(τ)`
  - Cohort `A≠X`: `r(τ) = p_subj · cdf_joint(τ) / F_carrier(τ)`

This expression depends only on `composed_subject` and
`composed_carrier`. Both surfaces are well-formed regardless of
whether `a_pop` or `x_frozen` is zero, because their conditioning
already absorbed whatever evidence was available (or fell back to
priors by `PRIOR_ONLY` if none was). The per-capita rate is
therefore well-defined in every case where the primitives are
draw-coherent.

The current implementation reaches the same algebraic ratio via
mass aggregation: `Σ_d N_d · num_d / Σ_d N_d · den_d`. When all
`N_d` are non-zero and posteriors are shared, the `N_d` factors
cancel and the aggregate equals the per-capita rate. When an
`N_d` is zeroed by sites 1 or 2, the aggregate is zero/zero —
even though the per-capita ratio is still well-defined — and
the reducer's NaN-emit fires.

In short: the conditioned model curve **already exists** as a
property of the runtime's per-capita primitive surfaces. The
projection reconstructs it through an ampere-canceling mass
multiply-and-divide that is numerically lossy in exactly the
no-evidence corner where the curve should degenerate to the
prior.

## Invariants violated

User-named invariant:

  - "The conditioned model curve degenerates naturally to model-vars
    priors as evidence → 0." Today: the curve is `None`, not the
    prior shape.

Engineering invariants from
[COHORT_ANALYSIS_NUMERATOR_DENOMINATOR_SEMANTICS.md](../codebase/COHORT_ANALYSIS_NUMERATOR_DENOMINATOR_SEMANTICS.md):

  - §1 ("one general forecast machinery path; degeneracies, not
    branches"). The displayed rate has a closed-form per-capita
    expression that handles window, cohort, identity, and active
    cases as degeneracies of one formula. The current projection
    instead reaches that rate via mass mechanics whose
    no-evidence degeneracy is incorrect, breaking the
    "degeneracies, not branches" pattern.
  - §3 ("one conditioning locus"). Conditioning belongs in
    `_prepare_one` / `condition_primitive`. The current behaviour
    effectively reapplies an evidence gate at the projection layer
    by killing curve amplitude through `a_pop = 0`, which is a
    second conditioning locus the §3 invariant forbids.
  - §6 ("identity carrier is data, not a route"). The
    identity-carrier branch in the reducer treats `x_frozen` as a
    semantic carry-forward basis, but in the no-observed-mass
    case that basis evaluates to zero. The §6 spirit is that
    identity carrier is a degenerate value of the same formula —
    it should not collapse the rate to zero/zero in any
    sub-case.
  - §9 ("projection must not re-decide semantics"). The displayed
    rate is the per-capita ratio of conditioned primitive
    surfaces. The projection reads from the runtime; it does not
    re-derive the rate through a second pipeline whose
    no-evidence behaviour disagrees with the runtime's.
  - §12 ("failures degrade visibly, do not silently fall back").
    Today the curve silently disappears in epoch A when carrier
    evidence is missing for an anchor; the `model_midpoint`
    overlay emits, but the user-facing `midpoint` does not. The
    visible-degradation principle wants either an explicit
    skip with a reason, or a curve at the prior shape — not a
    silent `None`.

## What this is NOT

Several adjacent failure modes have similar surface symptoms but
distinct causes:

  - **Carrier dead-zone NaN at small τ.** When the carrier hasn't
    delivered any mass at small τ (e.g. F_carrier ≈ 0), the
    F-mode overlay emits 0; the v3 reducer emits NaN. This is a
    convention asymmetry between
    [`1510`](../../graph-editor/lib/runner/cohort_forecast_v3.py#L1510) and [`3749-3754`](../../graph-editor/lib/runner/cohort_forecast_v3.py#L3749-L3754) and is a separate (smaller) bug;
    it does not by itself cause the epoch A collapse this note is
    about.
  - **Degraded primitive topology.** When a primitive is
    `is_draw_coherent = False` (degraded topology — `no_path`,
    `horizon_inadequate`, etc., per [`primitive_conditioning.py`](../../graph-editor/lib/runner/primitive_conditioning.py)),
    the runtime correctly returns `None` from the projection.
    That is a structural failure, not a no-evidence degeneracy,
    and is the right behaviour under §12.
  - **Empirical `rate` row field.** The `Σ obs_y / Σ obs_x` field
    is `None` when no cohort has observations at τ. That is
    correct: there is no empirical signal. The defect addressed
    here is the *conditioned model curve*, which should exist
    independently of empirical observation density.

## Open question

The principled fix is a separate piece of work. Several design
considerations are noted but deliberately not resolved here:

  - Whether `midpoint` should be re-rooted on the per-capita
    primitive surfaces directly (treating the mass mechanics as a
    forecast-counts producer) or whether the mass mechanics should
    be made degenerate-safe at sites 1 and 2 while keeping its
    current role.
  - How the empirical-dovetail intent at the epoch A/B frontier is
    carried — today the v3 reducer's `x_frozen` carry-forward is
    chosen specifically to make `midpoint` track `Σ obs_y / Σ obs_x`
    in epoch A. Any architectural shift has to either preserve
    that dovetail by construction or treat dovetail divergence as a
    diagnostic of conditioning fit rather than a row contract.
  - How the outside-in oracle ([`test_cohort_factorised_outside_in.py`](../../graph-editor/lib/tests/test_cohort_factorised_outside_in.py))
    should treat the synth fixtures whose pinned midpoints would
    shift under any architectural correction. The semantics doc's
    modification policy requires explicit user approval for oracle
    adjustments.

## See also

  - [COHORT_ANALYSIS_NUMERATOR_DENOMINATOR_SEMANTICS.md](../codebase/COHORT_ANALYSIS_NUMERATOR_DENOMINATOR_SEMANTICS.md) §"Rate
    semantics", §"Implementation invariants" §1, §3, §6, §9, §12.
  - [73g-general-purpose-f14-problem-and-invariants.md](73g-general-purpose-f14-problem-and-invariants.md) — engineering
    invariants this defect cross-cuts.
  - [73n-carrier-evidence-conditioning-implementation-plan.md](73n-carrier-evidence-conditioning-implementation-plan.md) — the
    plan that introduced the carrier-evidence seam discipline that
    site 1 enforces.
  - [46-v3-cohort-midpoint-inflation.md](46-v3-cohort-midpoint-inflation.md) — earlier midpoint-shape defect
    on the same surface, since landed; included for cross-reference
    only.
