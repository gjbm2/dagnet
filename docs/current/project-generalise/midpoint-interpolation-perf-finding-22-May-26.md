# Midpoint Interpolation Perf Finding — 22-May-26

**Status**: Investigation note. Action needed but no commitment in this doc.

## Summary

The midpoint cubic Hermite interpolation introduced by the bucket-transition
generalisation (`graph-editor/lib/runner/bucket_transition.py`,
`_monotone_cubic_read_shifted` via `read_offset=0.5`) accounts for
**~35% of cohort-mode wall-clock** after the other reductions in this
session (unification of `_build_rate_attributed_subject_prefix` paths,
S-degeneracy collapse, kernel-width truncation, per-τ loop
vectorisation). The midpoint cost is load-bearing for **three** tests
and replaceable-without-regression for everything else in
`lib/tests/`. Lowering the cost of midpoint interpolation — or
replacing the stencil with a cheaper algebra that still preserves the
half-bucket exposure correction — is the largest remaining single
lever before attacking the DP source-index Python loop or `S`
reduction.

## How the finding was reached

1. `py-spy record` on a live cohort request after the unification
   reduced `_monotone_cubic_read_shifted` to ~35% of CPU
   (`_monotone_slope` ~13% on top; `cdf_to_bucket_transition` framing
   ~4%; combined ~52% in the cubic Hermite call stack).
2. A sensitivity flag was added to
   `bucket_transition.py:empirical_read_offset_for_basis` —
   `_FORCE_ENDPOINT_READS_FOR_SENSITIVITY` — that bypasses the
   midpoint shift by returning `read_offset=0.0` regardless of
   `BucketSourceBasis`. The `h=0` fast-path I added to
   `_monotone_cubic_read_shifted` then short-circuits the cubic
   compute entirely (`shifted = cdf[:, :W]` direct copy).
3. With the flag set to `True`, the full `lib/tests/` suite produces
   exactly three failures:
     - `test_active_single_hop_evidence_matches_selected_a_clock_snapshot_oracle`
     - `test_active_multihop_evidence_uses_query_x_denominator_not_terminal_edge_x`
     - `test_analyse_cli_does_not_pre_run_graph_mutating_cf_for_needs_snapshots`
4. With the flag flipped back to `False` (midpoint restored), those
   three tests pass cleanly in ~36s.

The flag is currently committed off (default `False`). It is
documented in `bucket_transition.py` as a temporary sensitivity knob
and is the simplest mechanism to A/B the midpoint cost without
rebuilding the call sites.

## What the midpoint correction actually does

Source-day mass is bucketed by `int(arrival_time)`, so arrivals
assigned to one source day are spread through that day. The midpoint
read (`read_offset=0.5`) shifts the cumulative-rate lookup to the
bucket centre, capturing the **average exposure within the source
bucket** before the empirical kernel hands mass forward. The endpoint
read (`read_offset=0.0`) treats the source mass as point-located at
the bucket's right edge, giving the whole bucket a full extra day of
subject exposure.

The shift is small in magnitude (half a bucket on the τ axis) but
load-bearing for tests that compare against an oracle constructed
**outside** the runtime — e.g. the single-hop and multi-hop A-clock
evidence oracles that bake the same midpoint convention into the
expected counts. For these, switching to endpoint reads produces a
half-bucket misalignment that the oracle does not absorb, and the
test fails. Tests that compare cohort vs. window (divergence tests)
or runtime-internal consistency tests are insensitive to the shift
because both modes share the convention.

## Where the cost concentrates

After the optimisations landed in this session, the cubic Hermite
stencil per `_empirical_kernels_for_source_bucket_batched` call is
the dominant cost. The call structure:

  DP iterates ~200 `source_index` values per edge × ~6 edges
  × ~3 DP runs ≈ 3,600 batched-kernel invocations per request.
  Each invocation runs `cdf_to_bucket_transition` once per chunk
  (~8 chunks of cohort×s_eff rows), each chunk running
  `_monotone_cubic_read_shifted` on `(chunk_rows, T_or_W)` arrays.

At `h=0` the closed-form Hermite collapses to `y0`; the rest of the
formula is wasted FLOPs. At `h=0.5` the full stencil runs:
`_monotone_slope` is called twice (once for `m0`, once for `m1`),
the four basis coefficients `b00/b10/b01/b11` are applied, and the
result is clamped to `[min(y0, y1), max(y0, y1)]`. The vectorised
form I introduced is bit-identical to the scalar per-τ loop but the
work itself is the same magnitude — it is the inherent cost of the
stencil, not call overhead.

## Suggestions for follow-up

### 1. Look for a cheaper algebra that preserves the half-bucket exposure

The midpoint correction is shape-preserving cubic Hermite clamped to
the monotone interval. The clamping makes the cubic mostly
indistinguishable from a clipped linear interpolation in regimes
where the cumulative is approximately monotone-linear between
samples — which empirical evidence rates frequently are over short
τ windows. A two-pass measurement of where the cubic-vs-linear
difference is non-negligible (i.e. `|cubic(τ+0.5) − linear(τ+0.5)|
≥ ε` for some small ε on the actual cumulative-rate inputs) would
quantify how much of the stencil is providing meaningful correction
versus how much is rounding noise from the slope harmonic mean.

If the meaningful-correction fraction is small, a hybrid stencil
that uses linear interpolation as the cheap default and only invokes
the cubic harmonic-mean slope where the local second-difference
exceeds threshold would recover most of the 35% saving while keeping
oracle alignment intact.

### 2. Cache the slope arrays per cumulative matrix

`_monotone_slope(d_prev, d0)` and `_monotone_slope(d0, d_next)` are
computed inside `_monotone_cubic_read_shifted` for every call. For
the empirical batched path, the cumulative for a given `(edge,
source_day)` is recomputed per source_index (because `source_day`
shifts with `source_index` in cohort mode), but the slope structure
on that cumulative is stable. Pre-computing `(d_prev, d0, d_next,
m0, m1)` at the same time as the cumulative — and reusing them
across all τ in one numpy pass — turns the cubic into a single
broadcast multiply per call. This is partially what the vectorised
reader already does; pushing the slope cache one level up (out of
`_monotone_cubic_read_shifted`, into the bucket-transition build) is
the next refactor step.

### 3. Compose the Hermite into a sparse matrix

A monotone Hermite read at fixed offset `h` is a linear functional
on the cumulative row: `shifted[τ] = a(τ) · cdf[τ-1] + b(τ) · cdf[τ]
+ c(τ) · cdf[τ+1] + d(τ) · cdf[τ+2]` (with the monotone-slope clamp
applied post-hoc). For a fixed `h` the coefficients `a, b, c, d` are
constant across τ — they are determined by the bucket basis (which
chooses `h`) and the boundary. The matrix that maps `cdf → shifted`
is therefore a four-band sparse matrix that can be applied once per
cumulative as a single `np.einsum`/`matmul`. The clamping step
remains pointwise but cheap. This converts the cubic from a
`for τ in [0, W)` (already vectorised) into a tiny matmul on a
fixed-band-width matrix — close to free.

The clamp `np.minimum(np.maximum(value, min(y0, y1)), max(y0, y1))`
is non-linear and breaks the strict sparse-matrix view; investigating
whether the clamp can be expressed as a final monotone-isotonic
projection on the result is the open question.

### 4. Push midpoint up to source-mass placement, away from the kernel

A more radical alternative: instead of correcting the empirical
kernel for midpoint exposure at read time, correct the **source
mass** placement upstream so the kernel always sees endpoint-aligned
mass. This is the inverse of the current convention but would let
the inner DP run on endpoint reads (no cubic work) while keeping the
mathematical content of the midpoint shift somewhere in the
pipeline. The cost: changes propagate through the DP basis tracking
in `timing_span.py` and the `BucketSourceBasis` invariants. Larger
refactor, but matches the engine-discipline preference of pushing
defence to the perimeter and keeping the engine's inner kernels
algebraically clean.

## Measurements

Sensitivity test results (timings include daemon startup ~3s per
invocation; subtract that for the steady-state cost):

| Configuration | Tests | Wall-clock |
|---|---|---|
| Midpoint (read_offset=0.5, current default) | 2 tests (window+cohort terminal non-latency) | not measured this session but pre-flip was 12.87s for these 2 |
| Endpoint sensitivity (read_offset=0.0 forced) | same 2 tests | **12.87s** for 2 tests |
| Midpoint restored | 3 tests (the 3 that failed under endpoint) | **36.19s** for 3 tests |

The cohort divergence test (`test_multihop_latent_upstream_divergence`)
was not run in this measurement set; pre-session wall-clock was 6+
minutes (BE compute) hitting Node's default 300s fetch timeout. The
relevant signal here is not a single number but the **shape** of the
cost: midpoint is the dominant cost in the post-truncation profile.

## Status of the sensitivity knob

`_FORCE_ENDPOINT_READS_FOR_SENSITIVITY` lives in
`graph-editor/lib/runner/bucket_transition.py` at the top of the
module. Default `False`. Flipping it to `True` is a one-line edit
that triggers uvicorn auto-reload, so A/B comparisons against any
new candidate stencil only require flipping the constant and
running. **Production must keep this `False`** — the three sensitive
tests will fail otherwise. The knob is documented inline.

## Cross-references

- Vectorised reader implementation:
  [bucket_transition.py:`_monotone_cubic_read_shifted`](../../graph-editor/lib/runner/bucket_transition.py)
- h=0 fast-path:
  same function, top of body (added this session)
- Kernel-width truncation that surfaced the cubic cost:
  [empirical_evidence_operator.py:`_empirical_kernels_for_source_bucket_batched`](../../graph-editor/lib/runner/empirical_evidence_operator.py)
- The AP58 unification that preceded this finding:
  [cohort_forecast_v3.py:4592](../../graph-editor/lib/runner/cohort_forecast_v3.py)
- Sensitive tests (failures under endpoint):
  `lib/tests/test_cohort_factorised_outside_in.py::test_active_single_hop_evidence_matches_selected_a_clock_snapshot_oracle`
  `lib/tests/test_cohort_factorised_outside_in.py::test_active_multihop_evidence_uses_query_x_denominator_not_terminal_edge_x`
  `lib/tests/test_cohort_factorised_outside_in.py::test_analyse_cli_does_not_pre_run_graph_mutating_cf_for_needs_snapshots`
