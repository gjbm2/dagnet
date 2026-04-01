# Fan Chart MC Bug: Zero-Width Bands for Real cohort() Data

**Date**: 1-Apr-26
**Status**: Open — root cause identified, fix needed

---

## Symptom

The MC fan chart produces midpoints of ~1e-8 and zero-width bands for
real cohort() data, while evidence rates are ~0.5. The chart shows
evidence lines but no visible fan. Works correctly with test fixture
(window mode).

---

## Root Cause: Sparse `cohort_at_tau` in Cohort Mode

The MC builds `observed_x` and `observed_y` arrays per Cohort by
looking up each τ in `cohort_at_tau[anchor_day][τ]`. In **cohort mode**,
`cohort_at_tau` is sparse — not every (Cohort, τ) pair has an entry,
because frames only contain data points where `τ = as_at_date - anchor_day`
for that specific frame date.

For τ values with no entry, the code uses:
```python
observed_x = 0.0   # cohort mode initialisation
observed_y = 0.0   # default
```

A mature Cohort contributing (x=0, y=0) at a given τ is **invisible** in
the aggregate. If most Cohorts are sparse at most τ values, the MC
aggregate `Y_total / X_total` is built from a tiny fraction of the actual
data, producing near-zero rates.

### Why Window Mode Works

In window mode, `observed_x` is initialised to `N_i` (fixed x) for all τ.
Missing `cohort_at_tau` entries still contribute x to the denominator.
Every Cohort is always present in the aggregate.

### Why the Bucket Evidence Works

The bucket aggregation iterates over ALL frames and sums x/y for each τ.
Multiple frames can contribute to the same τ bucket (different Cohorts
hit the same τ on different dates). The bucket is dense — every τ with
any data gets a sum.

The MC's `cohort_at_tau` only stores the LAST frame's value per
(Cohort, τ). It's a sparse lookup, not a dense aggregation.

---

## The Fix

For cohort mode, when building `observed_x` and `observed_y` arrays,
**carry forward** the last known (x, y) for each Cohort. If a Cohort
has data at τ=5 but not at τ=6, τ=6 should use the τ=5 values (x and y
can only increase in cohort mode — carry-forward is monotonic).

```python
# For each Cohort, build observed arrays with carry-forward
last_x, last_y = 0.0, 0.0
for t_idx in range(T):
    t_val = int(tau_grid[t_idx])
    if t_val <= a_i:
        obs = tau_data.get(t_val)
        if obs:
            last_x, last_y = obs[0], obs[1]
        observed_x[t_idx] = last_x
        observed_y[t_idx] = last_y
```

This mirrors the bucket's carry-forward behaviour and ensures every
mature Cohort contributes at every τ, making the MC aggregate match
the evidence line.

---

## Secondary Issues (Already Fixed)

1. **Edge-level vs path-level params**: cohort mode was using edge-level
   mu/sigma instead of path-level. Fixed — now reads `path_mu` etc.

2. **y_frozen fallback**: mature Cohorts with no `cohort_at_tau` entry
   used `y_frozen` (end-state conversions) instead of 0. Fixed.

3. **x_frozen=0 dilution**: Cohorts with no from-node arrivals were
   included with anchor population `a` as denominator, drowning real
   data. Fixed — now excluded from aggregate.

4. **Evidence denominator mismatch**: evidence used bucket sum_x (subset
   of Cohorts) while MC used total_N (all Cohorts). Fixed — evidence
   now uses full group denominator with carry-forward.

---

## Files

- `graph-editor/lib/runner/cohort_forecast.py` lines ~648-665 — MC
  observed array construction (the fix location)
