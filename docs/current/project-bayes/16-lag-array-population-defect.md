# Doc 16 — Lag array population defect on window slices

**Status**: Open
**Date**: 20-Mar-26
**Priority**: High — blocks sensible Bayes latency priors on first run

---

## 1. Problem

The `median_lag_days` and `mean_lag_days` arrays on parameter file
`values[]` entries are **all zeros for window-type slices**, but
correctly populated for cohort-type slices.

This means the FE's `aggregateLatencyStats` (which computes the
scalar `median_lag_days` / `mean_lag_days` on the graph edge's latency
block) either picks a window slice (zeros) or averages across all
slices including zero-valued window ones, producing a near-zero or
zero aggregate. The Bayes compiler reads these scalars as latency
priors and gets pathological values.

## 2. Evidence

Examined `conversion-flow-v2-recs-collapsed` parameter files
(20-Mar-26). Example from `delegated-to-non-energy-rec.yaml`:

| Values entry | sliceDSL | median_lag entries | Non-zero |
|---|---|---|---|
| [0] | `window(...).context(channel:paid-search)` | 105 | **0** |
| [1] | `window(...).context(channel:influencer)` | 105 | **0** |
| [2] | `window(...).context(channel:paid-social)` | 105 | **1** (2.0) |
| [3] | `window(...).context(channel:other)` | 105 | **0** |
| [4] | `cohort(...).context(channel:paid-search)` | 105 | **82** (1.6–39.2, mean 8.4) |
| [5] | `cohort(...).context(channel:influencer)` | 105 | **74** (2.0–23.3, mean 5.8) |
| [6] | `cohort(...).context(channel:paid-social)` | 105 | **64** (2.0–22.0, mean 7.7) |
| [7] | `cohort(...).context(channel:other)` | 104 | **86** (1.0–25.0, mean 7.7) |

Same pattern across all 10 parameter files in this graph. Cohort
slices have rich lag data; window slices have none.

## 3. Impact

The Bayes compiler derives latency priors from the graph edge's
`median_lag_days` / `mean_lag_days` scalars (set by the FE analytics
stats pass). When these are zero or near-zero:

- **Default fallback** (`mu=0.0, sigma=0.5`): median lag = 1 day.
  Wrong for edges with real lag of 5–30 days. The broad sigma (0.5)
  partially compensates but the prior is directionally wrong.
- **Epsilon floor** (`mu=-4.605, sigma=2.685`): median lag = 0.01
  days. Incoherent prior that confuses the sampler.
- **Misleadingly tight** (`mu=0.693, sigma=0.035`): median = 2 days
  with near-zero uncertainty. The model fights this violently,
  causing divergences.

On the `conversion-flow-v2-recs-collapsed` graph, this caused 17
MCMC divergences on first run. With sensible priors (derived from
t95 as a test), divergences dropped to 0.

## 4. Root cause hypothesis

The daily fetch pipeline computes `median_lag_days` per cohort day
from the Amplitude event timestamps (time between from-event and
to-event for each converter). This is measurable for both window
and cohort observations — lag is a property of the conversion, not
the observation mode.

The likely cause is one of:

1. **The Amplitude query for window slices doesn't request lag
   data** — the query payload may not include the fields needed to
   compute per-converter lag for window-mode fetches.

2. **The lag computation is gated on cohort mode** — the code that
   populates `median_lag_days` / `mean_lag_days` on the `values[]`
   entry may skip window entries by design or by accident.

3. **The lag is computed but not stored** — the computation runs but
   the result isn't written to the `values[]` entry for window slices.

## 5. Where to investigate

The lag arrays are populated during the daily fetch → file write
pipeline. Key code paths:

- **FE fetch pipeline**: `retrieveAllSlicesService.ts` →
  `dataOperations/getFromSourceDirect.ts` — how values[] entries
  are built from Amplitude responses
- **Lag computation**: `statisticalEnhancementService.ts` →
  `aggregateLatencyStats()` — how the scalar `median_lag_days` on
  the graph edge is derived from per-entry arrays
- **Lag fit analysis**: `lagFitAnalysisService.ts` →
  `bestCohortValue()` — selects which values[] entry to use for
  lag aggregation (note: the name suggests it deliberately picks
  cohort entries)
- **Snapshot write**: `snapshotWriteService.ts` — the snapshot DB
  rows DO have `median_lag_days` and `mean_lag_days` columns; check
  whether window-mode snapshot rows have non-zero values (if so,
  the defect is in the param file write path, not the computation)

## 6. Fix approach

Two orthogonal fixes:

**A. Fix the lag array population** so window `values[]` entries get
non-zero `median_lag_days` / `mean_lag_days` when converters exist.
This fixes the root cause for all consumers (analytic pipeline,
Bayes priors, FE display).

**B. Fix `aggregateLatencyStats`** to prefer cohort entries (which
have lag data) over window entries (which may not). This is a
defensive fix that helps even if (A) is partially addressed.

## 7. Verification

After fix, re-run the Bayes test harness on the
`conversion-flow-v2-recs-collapsed` graph:

```
python bayes/test_harness.py --graph branch --no-webhook
```

Check that:
- Latency priors are sensible (mu > 0 for all latency edges)
- No divergences
- ESS > 400
- All edges converge (rhat < 1.05)

Also verify that the simple test graph still works:

```
python bayes/test_harness.py --graph simple --no-webhook
```
