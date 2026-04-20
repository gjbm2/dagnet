# 46 — V3 Cohort Midpoint Inflation

**Date**: 17-Apr-26
**Status**: Open — root cause not confirmed
**Severity**: High — v3 cohort mode chart is visually wrong

## Symptom

V3 cohort maturity midpoints are systematically higher than V2 for
the same evidence. Window mode is unaffected — V2 and V3 produce
identical midpoints. The defect is cohort mode only.

The chart shows the cohort scenario as a vertical translation of the
window scenario rather than showing slower onset from upstream
latency. V2 shows the expected shape (cohort onset rises more
slowly than window).

## Quantitative evidence

Edge: switch-registered → switch-success
Graph: bayes-test-gm-rebuild
Query: cohort(17-Mar-26:12-Apr-26)

### Midpoints at key taus

| tau | V2 midpoint | V3 midpoint | Evidence rate (both) |
|-----|------------|------------|---------------------|
| 5   | 0.0052     | 0.0052     | 0.0052              |
| 6   | 0.1054     | 0.1140     | 0.1057              |
| 7   | 0.1348     | 0.1599     | 0.1358              |
| 8   | 0.1317     | 0.1702     | 0.1315              |
| 10  | 0.1342     | 0.2064     | 0.1274              |
| 14  | 0.1820     | 0.2882     | 0.1496              |
| 20  | 0.2923     | 0.3950     | 0.2054              |
| 30  | 0.4504     | 0.4987     | 0.2562              |

V2 tracks the evidence at early taus (correct — immature cohorts
have little basis for projection). V3 inflates above evidence
starting at tau=6, reaching 54% above V2 at tau=10.

### Aggregate Y_total / X_total (median across MC draws)

| tau | V2 Y | V3 Y | V2 X | V3 X |
|-----|------|------|------|------|
| 5   | 2.0  | 2.0  | 383  | 383  |
| 6   | 52.0 | 56.3 | 493.5 | 493.5 |
| 7   | 72.0 | 85.4 | 534.3 | 534.3 |
| 8   | 84.2 | 108.8 | 639.1 | 639.1 |
| 10  | 99.5 | 153.1 | 741.6 | 741.6 |
| 20  | 274.9 | 371.9 | 941.1 | 941.1 |
| 30  | 467.7 | 517.7 | 1038.8 | 1038.8 |

**X_total is identical.** Y_total diverges starting at tau=6.
The extra Y in V3 is therefore entirely from the per-cohort
population model's conversion projection (Pop D / IS conditioning),
not from upstream arrival modelling (Pop C, which affects X).

## Data binding comparison

Per-cohort inputs (N, k, a_i, a_pop) were compared for all 27
cohorts. **All identical between V2 and V3.** The frame evidence,
regime selection, and cohort construction produce the same per-cohort
data.

## Sweep input comparison

The following sweep inputs are **identical** between V2 and V3:

- Number of cohorts: 27
- MC draws (S): 2000
- mc_cdf at taus 5/10/15/20/30 (path CDF, normalised): same values
- det_cdf at taus 5/10/15/20/30 (edge CDF for E_i): same values
- p_draws median: 0.863327, std: 0.072301
- span_alpha / span_beta: 71.2316 / 11.1492
- mu / sigma / onset: 1.238 / 1.091 / 4.81
- mu_sd: 0.02, sigma_sd: 0.1
- Carrier: reach=0.009698, upstream_cdf_mc present
- RNG seed: both use default_rng(42)

The following sweep inputs **differ**:

| Input | V2 | V3 |
|-------|----|----|
| max_tau | 39 | 100 |
| T (array length) | 40 | 101 |
| obs_x_len per cohort | 40 | 101 |
| cdf_arr shape | (2000, 40) | (2000, 101) |

The max_tau difference arises because V2 computes max_tau from the
chart date extent (sweep_to − anchor_from = 26 days, extended by
t95 to 39). V3 computes max_tau via `build_cohort_evidence_from_frames`
which applies a 2×t95 floor and a hard minimum of 100.

The `mc_span_cdfs` call also uses different max_tau: V2 passes the
chart-derived max_tau (39). V3 passes hardcoded 400 (in the handler
at lines 2035, 2043, 2080, 2093). Inside `mc_span_cdfs`, the DP
kernel is normalised by `K[max_tau]`, so the per-draw CDF arrays
have different normalisation denominators despite producing the same
values at matching taus after slicing.

## Window mode control

The same comparison for window(17-Mar-26:12-Apr-26) shows V2 and V3
midpoints **identical** at all taus. Window mode does not use span
widening (the CDF is edge-level in both cases) and max_tau has less
impact because the edge CDF converges quickly.

## How to reproduce

All commands from the dagnet repo root.

### V2 cohort midpoints
```
bash graph-ops/scripts/analyse.sh bayes-test-gm-rebuild \
  "from(switch-registered).to(switch-success).cohort(17-Mar-26:12-Apr-26)" \
  --type cohort_maturity_v2 --topo-pass --no-cache --no-snapshot-cache
```

### V3 cohort midpoints
```
bash graph-ops/scripts/analyse.sh bayes-test-gm-rebuild \
  "from(switch-registered).to(switch-success).cohort(17-Mar-26:12-Apr-26)" \
  --type cohort_maturity --topo-pass --no-cache --no-snapshot-cache
```

### V3 conditioned forecast (scalar p.mean)
```
bash graph-ops/scripts/analyse.sh bayes-test-gm-rebuild \
  "from(switch-registered).to(switch-success).cohort(17-Mar-26:12-Apr-26)" \
  --type conditioned_forecast --topo-pass --no-cache --no-snapshot-cache
```

### Window control (both V2 and V3 should match)
```
bash graph-ops/scripts/analyse.sh bayes-test-gm-rebuild \
  "from(switch-registered).to(switch-success).window(17-Mar-26:12-Apr-26)" \
  --type cohort_maturity_v2 --topo-pass --no-cache --no-snapshot-cache
```
```
bash graph-ops/scripts/analyse.sh bayes-test-gm-rebuild \
  "from(switch-registered).to(switch-success).window(17-Mar-26:12-Apr-26)" \
  --type cohort_maturity --topo-pass --no-cache --no-snapshot-cache
```

### Forensic data

Temporary forensic instrumentation writes to `/tmp/v2_forensic.json`
and `/tmp/v3_forensic.json` after each run. These contain per-tau
Y/X/rate medians and per-cohort input summaries. Run V2 then V3 and
compare with:

```
python3 -c "
import json
with open('/tmp/v2_forensic.json') as f: v2 = json.load(f)
with open('/tmp/v3_forensic.json') as f: v3 = json.load(f)
for t in [5, 6, 7, 8, 10, 15, 20, 30]:
    a = v2.get(str(t), {})
    b = v3.get(str(t), {})
    print(f'tau={t}: V2 Y={a.get(\"Y_med\")} X={a.get(\"X_med\")}  V3 Y={b.get(\"Y_med\")} X={b.get(\"X_med\")}')
"
```

## Known differences to investigate

1. **max_tau / T**: V2=40, V3=101. Changes array shapes, RNG
   consumption pattern, and CDF normalisation boundary.

2. **mc_span_cdfs max_tau**: V2 passes chart-derived (39), V3 passes
   hardcoded (400). Changes per-draw CDF normalisation (`K[max_tau]`
   denominator in span_kernel.py line 601-606).

3. **SMC mutation**: V3's `_evaluate_cohort` (forecast_state.py line
   960-966) adds a logit-space perturbation after IS resampling. V2
   does not. Disabling the mutation alone did not resolve the
   inflation (tested 17-Apr-26) but interaction with other
   differences has not been ruled out.

4. **Upstream IS conditioning**: V2 (cohort_forecast_v2.py lines
   771-795) conditions the upstream CDF draws on observed upstream
   data before the per-cohort loop. V3 does not. This affects the
   carrier, but X_total is identical — so this is not the primary
   cause of Y inflation.

## Files

- `api_handlers.py`: v3 handler (line 1789+), v2 handler (line 1220+),
  conditioned forecast handler (line 2596+)
- `runner/cohort_forecast_v2.py`: V2 per-cohort loop (line 800+),
  mc_span_cdfs call (line 1704)
- `runner/cohort_forecast_v3.py`: `build_cohort_evidence_from_frames`
  (shared function), `compute_cohort_maturity_rows_v3`
- `runner/forecast_state.py`: `compute_forecast_trajectory` (line 1031+),
  `_evaluate_cohort` (line 860+)
- `runner/span_kernel.py`: `mc_span_cdfs` (line 483+),
  normalisation at line 601-606
