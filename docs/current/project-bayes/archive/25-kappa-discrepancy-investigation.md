# Doc 25: Window vs Cohort Kappa Discrepancy — Investigation Brief

**Created**: 29-Mar-26
**Status**: Open — not resolved
**Priority**: High — affects surprise gauge accuracy for all edges
**Context**: discovered during Phase 2 redesign (doc 24, journal 29-Mar-26)

---

## 1. The Problem

For edge registered-to-success (97b11265) on the production graph
(bayes-test-gm-rebuild), the Williams between-cohort kappa estimated
from window data vs cohort data differs by 12x:

| Data source | kappa | SD | CDF used |
|---|---|---|---|
| Window Williams | 11.2 | ±12% | Edge posterior (onset=4.3, mu=1.27, sigma=0.65) |
| Cohort Williams | 134 | ±3.7% | Path (delta=8.7, mu=2.28, sigma=0.46) |
| Mature-only window (age>80d) | 113 | ±3.8% | None needed (F≈1) |
| Mature-only cohort (age>80d) | 101 | ±4.2% | None needed (F≈1) |
| Phase 1 MCMC kappa_p (endpoint BB) | 8.3 | ±13% | Latent (MCMC) |
| Phase 1 MCMC kappa_p (old hierarchy) | 5.4 | ±16% | Latent (MCMC) |

**Key observation**: when restricted to mature observations only
(age > 80d, where both CDFs ≈ 1.0 and no adjustment is needed),
window and cohort AGREE: kappa ≈ 100-113. The discrepancy exists
only when immature observations are included with CDF adjustment.

This means the maturity adjustment is creating the discrepancy,
not genuine differences in between-cohort variation.

## 2. Data Structure

### Window observations (core_hash VTgXES1p...)

- `anchor_day` = day people arrived at **registered** (from-node X)
- `x` = count arriving at registered on that day (median 34, range 11-100)
- `y` = count who converted to success by retrieved_at
- `a` = NULL (not used in window mode)
- Age = retrieved_at - anchor_day = days since arriving at registered
- CDF: edge-level (onset=4.3d, mu=1.27, sigma=0.65)
- Rate: y/x → edge rate
- Reference: SNAPSHOT_FIELD_SEMANTICS.md §1 "Window rows"

### Cohort observations (core_hash XiDhZpbn...)

- `anchor_day` = day people entered at **landing** (anchor node A)
- `x` = count from this cohort who reached registered by retrieved_at
  (median 14, range 3-59). GROWS over time as upstream latency
  delivers people.
- `y` = count who converted to success by retrieved_at
- `a` = total anchor entrants (500-1600)
- Age = retrieved_at - anchor_day = days since entering at landing
- CDF: path-level (delta=8.7d, mu=2.28, sigma=0.46)
- Rate: y/x → edge rate (same quantity as window at maturity)
- Reference: SNAPSHOT_FIELD_SEMANTICS.md §1 "Cohort rows"

### Evidence binder structure

From evidence detail: window_traj=54, cohort_traj=85,
window_daily=43, cohort_daily=118.

DB row counts: window=1146 rows across 169 anchor days (166 multi-
retrieval, 3 single). Cohort=2274 rows across 169 anchor days
(93 multi-retrieval, 76 single).

Window has 37 anchor days with x=0 (nobody arrived at registered
that day). Cohort has 1 anchor day with x=0.

Evidence binder drops window trajectories aggressively: 166 multi-
retrieval days → 54 trajectories (zero-count dedup and
monotonisation remove 112). This data loss needs investigation.

### Williams estimator data flow

The Williams estimator in `_estimate_cohort_kappa` (inference.py)
collects per-cohort implied p from:
1. Trajectory endpoints: y_final / (x_final × F(age_final))
2. Daily obs: k / (n × F(age)) — only for first edges or where
   daily obs use x as denominator

Evidence binder denominator: recently changed from `a` to `x` for
cohort daily obs (was `a` previously — see journal 29-Mar-26).

## 3. The Discrepancy Analysis

### F²-weighted Williams (current implementation)

Window (81 obs after x≥3, F≥0.5 filter):
```
obs_var=0.0195, binom_var=0.0075, bc_var=0.012
kappa=11.2
```

Cohort (176 obs):
```
obs_var=0.0131, binom_var=0.0118, bc_var=0.0013
kappa=134
```

### F distribution in window data

| F range | n | mean p_imp | std p_imp | mean x |
|---|---|---|---|---|
| [0.5, 0.7) | 2 | 0.477 | 0.001 | 27 |
| [0.7, 0.8) | 2 | 0.573 | 0.111 | 60 |
| [0.8, 0.9) | 2 | 0.576 | 0.018 | 92 |
| [0.9, 1.0] | 117 | 0.793 | 0.127 | 40 |

The 6 immature observations (F < 0.9) have p_implied ≈ 0.47-0.58,
well below the mature mean of 0.79. Despite F²-weighting, they
inflate obs_var enough to drive kappa from ~110 (mature-only) to
~11 (all observations).

### Why the CDF adjustment fails on immature window observations

The edge CDF at age 7-12d gives F=0.5-0.88. The maturity adjustment
divides by F: p_implied = y / (x × F). If the actual maturity is
LOWER than F predicts (the CDF overestimates progress), p_implied
is biased LOW. This creates artificial scatter between immature
(biased low) and mature (unbiased) observations.

Using the Phase 1 posterior CDF (onset=4.3 instead of prior 3.2)
barely changed the result (kappa 11.5 → 11.2) because the CDFs
converge by age 15d and most observations are mature.

## 4. Hypotheses to Investigate

### H1: The edge CDF is wrong for window observations on this edge

The edge CDF (onset=4.3, mu=1.27, sigma=0.65) may not accurately
describe the maturation of registered→success. If the real
maturation is slower than the model thinks, the CDF overestimates
F at early ages → immature observations get insufficient adjustment
→ p_implied is biased low → inflated variance.

Test: compare the observed y/x trajectory shape against the CDF
prediction. At age 10d, the CDF says F=0.77. Do the actual y/x
values at age 10d match p × 0.77?

### H2: The evidence binder is losing too much data

54 window trajectories from 166 multi-retrieval days = 68% data
loss. The dedup and monotonisation filters may be removing
informative observations. If the lost trajectories are
disproportionately from certain anchor days, the remaining data
is biased.

Test: examine what the dedup/monotonisation filters remove and
whether the lost trajectories are systematically different.

### H3: The F²-weighting is insufficient for this edge

With only 6 immature observations out of 123 total, the F²-weighting
should suppress them effectively. But 6 observations with
p_implied ≈ 0.50 vs 117 with p_implied ≈ 0.79 create a bimodal
distribution. The weighted variance is still inflated because the
DISTANCE between modes is large (0.30 units), and F² weights of
0.25-0.77 don't suppress this enough.

Test: try F⁴-weighting, or exclude F < 0.9, or use only the robust
subset (mature observations). Compare kappa values.

### H4: The bimodal latency on this edge confounds the adjustment

Registered→success has known bimodal latency (some cohorts convert
fast, some slow). The single lognormal CDF can't capture both
modes. For the "slow mode" cohorts, the CDF overestimates maturity
at intermediate ages → p_implied is biased.

Test: look at the distribution of per-trajectory maturation curves.
Are there visibly different groups (fast vs slow converters)?

### H5: Window compositional mixing creates genuine extra variation

Window observations aggregate users from many funnel-entry cohorts
(anyone arriving at registered on that day). The mix of old vs new
arrivals varies by day. This compositional variation is REAL (not
noise) but is NOT the same as between-cohort variation in the edge
conversion rate. The Williams estimator measures total variation
including compositional effects.

Test: compare window kappa on weekdays vs weekends, or high-x vs
low-x days. If kappa varies systematically, compositional effects
are present.

## 5. Files and Code

| File | Relevant section |
|---|---|
| `bayes/compiler/inference.py` | `_estimate_cohort_kappa()` — Williams estimator |
| `bayes/compiler/evidence.py` | `_build_trajectories()` — trajectory construction, dedup, denominator |
| `bayes/compiler/model.py` | Endpoint BetaBinomial (Phase 1), kappa_p estimation |
| `bayes/compiler/completeness.py` | `shifted_lognormal_cdf()` — CDF computation |
| `bayes/compiler/types.py` | `EdgeEvidence`, `CohortDailyObs`, `CohortDailyTrajectory` |
| `docs/current/codebase/SNAPSHOT_FIELD_SEMANTICS.md` | Window vs cohort field definitions |
| `docs/current/project-bayes/11-snapshot-evidence-assembly.md` | Evidence pipeline design |
| `docs/current/project-bayes/24-phase2-redesign.md` | Phase 2 redesign (context for this issue) |
| `docs/current/project-bayes/18-compiler-journal.md` | Session journal with experimental results |

## 6. Production Data Access

```sql
-- Window rows for registered-to-success
SELECT * FROM snapshots
WHERE core_hash = 'VTgXES1p_XdQoHMZ7VsEoA'
ORDER BY anchor_day, retrieved_at;

-- Cohort rows for registered-to-success
SELECT * FROM snapshots
WHERE core_hash = 'XiDhZpbnp535eBHiPu614w'
ORDER BY anchor_day, retrieved_at;
```

DB connection: `graph-editor/.env.local` → DB_CONNECTION.

## 7. What Would "Correct" Look Like

The mature-only analysis (age > 80d, no CDF needed) gives kappa ≈
100-113 from both window and cohort. This is likely the correct
answer: ±4% SD between-cohort variation.

Any kappa estimate that includes immature observations should
converge toward this value, not diverge from it. The current window
Williams (kappa=11) diverges by 10x — the maturity adjustment is
doing more harm than good.

The endpoint BetaBinomial in Phase 1 MCMC gives kappa=8.3 — even
further from the mature-only estimate. This suggests the MCMC is
also confounding something.

## 8. Relationship to Other Issues

- **Phase 1 kappa_p too low**: the old hierarchical Beta gave
  kappa_p=5.4. The endpoint BB improved to 8.3. Williams on
  mature-only gives 110. All three are different. The correct
  answer is ~110.

- **Phase 2 cohort uncertainty**: uses Williams kappa for cohort
  predictive alpha/beta. Currently gives kappa=134 (±3.7% SD).
  Close to the mature-only answer (101). Phase 2 cohort Williams
  is approximately correct.

- **Phase 1 window uncertainty**: uses MCMC kappa_p (8.3) or
  Williams (11.2) for window predictive alpha/beta. Both are far
  too low. Window SD shows ±12-13% when reality is ±4%.

- **Surprise gauge**: consumes alpha/beta from both phases. Phase 1
  window bands are too wide. Phase 2 cohort bands are approximately
  right.
