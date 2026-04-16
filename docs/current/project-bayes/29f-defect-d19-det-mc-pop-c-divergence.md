# D19: Deterministic forecast_y diverges from MC midpoint (Pop C)

**Date**: 16-Apr-26
**Status**: Open — investigation complete, fix not yet implemented.
**Severity**: Medium — affects tooltip `forecast_y`/`forecast_x` in
cohort maturity chart. Does not affect `midpoint`, `fan_bands`, or
`rate` (the primary chart outputs). Present in both v2 and v3.
**Blocks**: G.4 (retiring `_compute_det_totals`).

---

## Problem

The cohort maturity chart computes two forecasts per τ:

1. **MC population model** → `midpoint`, `fan_bands` (primary chart
   lines). Uses `cdf_arr` from `mc_span_cdfs` (path-level CDF) and
   `upstream_cdf_mc` from `from_node_arrival` for Pop C.

2. **Deterministic `_compute_det_totals`** → `forecast_y`,
   `forecast_x` (tooltip annotation). Uses `det_norm_cdf` (edge-
   level CDF, normalised) and `upstream_path_cdf_arr` for Pop C.

For multi-hop-narrow (e.g. `from(m4-delegated).to(m4-success)
.cohort(15-Mar-26:21-Mar-26)`), these diverge:

| τ | midpoint (MC) | forecast_y (det) | forecast_x (det) |
|---|--------------|-----------------|-----------------|
| 26 | 0.0157 | 14 | 891 |
| 30 | 0.0157 | 20.7 | 937 |
| 34 | 0.0157 | 29.2 | 1007 |

`midpoint` is flat at 0.016 while `forecast_y` grows from 14 to 29.

## Root cause

The two computations use different CDF and p values:

**MC sweep Pop D** uses:
- `cdf_arr` from `mc_span_cdfs` — **path-level** CDF (delegated→
  success, 2 edges). Still growing at τ=26 (norm_CDF=0.91).
- `p_i` — IS-conditioned draws. Evidence y=14/x=891 (rate 1.6%)
  pulls p from prior ~0.72 down to ~0.016. With p≈0.016 and
  remaining_CDF=0.07, `q_late ≈ 0.001`. Pop D ≈ 1.

**Deterministic Pop D** uses:
- `det_norm_cdf` — **edge-level** CDF (registered→success, 1 edge).
  Already converged at τ=26 (norm_CDF=1.0).
- `_span_p` — unconditioned edge p (0.72, no IS).
  `remaining_CDF = 0`, `q_late = 0`, `Pop D = 0`.

**MC sweep Pop C** uses:
- `upstream_cdf_mc` from `from_node_arrival.mc_cdf` — carrier CDF.
- `model_rate = p_i × cdf_i`. With IS-conditioned p≈0.016, Y_C is
  small.

**Deterministic Pop C** uses:
- `upstream_path_cdf_arr` — same carrier (from same
  `build_upstream_carrier` call).
- `model_rate = _span_p × cdf_det(tau) = 0.72 × 1.0 = 0.72`.
  Unconditioned. Y_C = X_C × 0.72 — much larger than MC's
  X_C × 0.016.

**Summary**: the deterministic computation uses unconditioned p (0.72)
while the MC uses IS-conditioned p (0.016). This is the dominant
divergence. The CDF difference (edge vs path) is secondary — it
would matter if both used the same p, but the 45× difference in p
overwhelms everything else.

## Why this is not a v3 bug

v2 produces identical output — same `midpoint` (0.016), same
`forecast_y` (29.2). The parity test passes. The inconsistency is
inherited from v2's design: `_compute_det_totals` was always
unconditioned, while the MC sweep was always IS-conditioned.

## Fix path

`_compute_det_totals` should be replaced by reading from the MC
sweep's `det_y_total` / `det_x_total` (median Y/X across draws).
This is G.4. The MC already accounts for IS conditioning and uses
the path-level CDF. The median is the honest answer.

**Prerequisite**: the MC sweep's `det_y_total` must be correct. For
the multi-hop-narrow case, `det_y_total` shows small growth
(Y: 9→9.8 with 3 test cohorts). This may be correct (IS pulls rate
down to 1.6%, so very few additional conversions are expected) or
may reflect a Pop C gap. Needs verification against expected values.

## Verification plan

1. Run v3 multi-hop-narrow, capture `sweep.det_y_total` at key τ
2. Compute expected Y at each τ manually: observed Y + Pop D (from
   IS-conditioned q_late × remaining) + Pop C (from carrier × IS-
   conditioned model_rate)
3. If they match, G.4 can land — the MC median is correct and the
   deterministic computation is the one that's wrong (unconditioned)
4. If they don't match, investigate the MC Pop C carrier construction
