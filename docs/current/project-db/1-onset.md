# Onset Delay: Surfacing and Usage (`onset_delta_days`)

Date: 2-Feb-26  
Last updated: 3-Feb-26

## Implementation status (as of 3-Feb-26)

**Implemented (tracking/storage is now working):**
- **Onset derivation (window slices)**: onset is derived in the app from the returned `lag_histogram` using **\(\alpha\)-mass day** and stored as `onset_delta_days` rounded to **1 d.p.**
- **Incremental merge stability (file persistence)**: incremental `window()` updates **blend** new onset into the existing onset using weights based only on **`dates.length`** (no overwrite).
- **Edge-level aggregation (topo pass)**: edge onset is aggregated using a **weighted \(\beta\)-quantile**, weighted by **`dates.length`** (replaces `min()`).
- **Settings knobs**: `forecasting.ONSET_MASS_FRACTION_ALPHA` and `forecasting.ONSET_AGGREGATION_BETA` are read from `settings/settings.yaml` with safe fallbacks.
- **Test coverage**: targeted TS test suites for merge + topo aggregation + fixture write-path were updated and are passing.

**Not yet implemented (stats machinery integration):**
- **Shifted completeness / fitting**: the statistical model still needs to *use* `onset_delta_days` in the core latency/completeness machinery (shifted lognormal integration and any downstream fitting logic).

**Scope:** This document covers UI surfacing and statistical usage of `onset_delta_days`. Extraction, aggregation, and storage are part of the core implementation plan (`implementation-plan.md` §0.3).

**Key constraints (see implementation-plan.md for details):**
- Onset is only derived from **window() slices** (cohort() histogram data is unreliable)
- Onset derivation uses a **mass threshold** (defaults to **1%** of histogram mass), not “first non-zero bin”
- Onset is stored and maintained as a **single scalar per window() slice family** (no histogram retention)
- Incremental fetches **must not overwrite** onset; they **blend** new onset into existing onset using a simple weight: **number of dates in the window() series**
- Edge-level onset is aggregated in the LAG topo pass using a **weighted \(\beta\)-quantile** across window() slice families, weighted by **number of dates**, not `min()`
- No `anchor_onset_delta_days` — window slices have no anchor component

---

## 1. Problem Statement

We currently model edge latency using a standard lognormal distribution. This implicitly assumes conversions can begin immediately at \(t=0\).

In practice, many edges exhibit a **dead-time** where conversions are effectively zero for the first \(d\) days. This causes:

1. **Overstated early completeness**: Lognormal CDF is non-zero at \(t=0\)
2. **Premature evidence weighting**: Blending gives too much weight to structurally right-censored evidence
3. **Downstream propagation**: Small completeness errors compound on deep paths

## 2. Solution: Shifted Lognormal Model

We introduce an **onset delay** \(\delta\) (`onset_delta_days`) representing minimum time before conversions can occur.

### 2.1 Shifted Distribution

Total time-to-conversion: \(T = \delta + X\)

Where:
- \(\delta \ge 0\) is the onset delay (days)
- \(X \sim \text{LogNormal}(\mu, \sigma)\) is post-onset conversion time

### 2.2 Shifted Completeness Formula

```
F(t) = 0                           if t ≤ δ
F(t) = LogNormalCDF(t - δ; μ, σ)   if t > δ
```

Completeness remains exactly 0 during the dead-time, then follows the shifted CDF.

### 2.3 Deriving and Maintaining `onset_delta_days` (Practical Incremental Policy)

DagNet fetches `window()` slices incrementally (often only a few days per run). This means the *latest* histogram can be a small, recent cross-section and can produce a noisy onset estimate (especially near day 0).

To keep onset stable and meaningful under incremental updates, we separate:

- **Per-fetch onset estimation** (from the latest `window()` histogram), and
- **On-file onset maintenance** (how we merge that estimate into the existing mature `window()` slice series).

#### 2.3.1 Per-fetch onset estimation (mass threshold, 1 d.p.)

For each `window()` slice returned by Amplitude, we compute:

- **\(\alpha\)** = onset mass fraction threshold, read from `settings/settings.yaml` (see below). Default: **0.01** (1%).
- Onset is the earliest time where cumulative histogram mass reaches \(\alpha\) of total mass.
- Convert to **days**, and round to **1 decimal place**.

This intentionally replaces “first non-zero bin”, which is too sensitive to tiny early noise.

#### 2.3.2 On-file onset maintenance during incremental merges (simple weighted average by window date-count)

When merging an incremental `window()` update into an existing `window()` slice family in the parameter file, we do **not** overwrite onset.

Instead, we blend the new onset estimate into the existing stored onset using weights based only on the **number of dates in the window series**:

- **Old weight** \(w_{old}\) = `existing.dates.length` for that slice family
- **New weight** \(w_{new}\) = `incoming.dates.length` being merged for that slice family

Then:

\[
onset_{updated}=\frac{w_{old}\,onset_{old}+w_{new}\,onset_{new}}{w_{old}+w_{new}}
\]

Round to **1 decimal place**.

This is the intended “incremental stabiliser”: small daily updates cannot reset a mature onset estimate to 0.

#### 2.3.3 Edge-level aggregation across slices (weighted \(\beta\)-quantile by window date-count)

Edges may have multiple `window()` slice families (e.g. `context(channel=...)`). To surface a single edge-level onset used in modelling:

- **\(\beta\)** controls which onset is selected from the weighted distribution of slice-family onsets. It is read from `settings/settings.yaml`. Default: **0.5**.
- We aggregate slice-family onset values using a **weighted \(\beta\)-quantile**, weighted by each slice family’s **`dates.length`**.
- This intentionally replaces the previous `min()` behaviour, which was too aggressive and tended to collapse to 0.

#### 2.3.4 Manual override behaviour

If `onset_delta_days_overridden` is true (user-set):

- Per-fetch onset estimation may still be computed for diagnostics, but it must not overwrite file or graph onset.
- Merge and topo aggregation must respect the override flag (standard DagNet permission pattern).

#### 2.3.5 Forecasting settings knobs

These are shared, repo-committed settings in `settings/settings.yaml`:

- `forecasting.ONSET_MASS_FRACTION_ALPHA` (default `0.01`)
- `forecasting.ONSET_AGGREGATION_BETA` (default `0.5`)

---

## 3. UI Surfacing

### 3.1 Properties Panel (Edge Latency Section)

Display `onset_delta_days` alongside existing latency summary fields:

| Field | Value | Overridden |
|-------|-------|------------|
| Median Lag | 4.2 days | ☐ |
| Mean Lag | 6.8 days | ☐ |
| t95 | 18.5 days | ☑ |
| **Onset Delay** | **2.0 days** | ☐ |

The `_overridden` companion field follows the standard pattern:
- Unchecked: Value derived from Amplitude data, may refresh on pull
- Checked: Manually set by user, persists through data refreshes

### 3.2 Conditional Props (Per-Slice View)

When viewing per-context-slice latency summaries (window slices only — cohort slices don't have reliable onset):

| Slice | Median | Mean | t95 | Onset |
|-------|--------|------|-----|-------|
| window:channel:organic | 3.8 | 5.2 | 15.0 | 1 |
| window:channel:paid | 5.1 | 8.4 | 22.0 | 3 |
| cohort:1-Jan-26 | 4.1 | 6.2 | 17.0 | — |

### 3.3 Edit Behaviour

Standard blur-to-save override pattern:
1. Field displays current value (derived or overridden)
2. User edits value in Properties Panel
3. On blur/confirm: `onset_delta_days_overridden` set to `true`
4. Clear override: checkbox clears, next pull refreshes from Amplitude

---

## 4. Completeness Integration

### 4.1 statisticalEnhancementService.ts Changes

The LAG topo pass (`enhanceGraphLatencies`) aggregates onset from window slices using the policy above (weighted \(\beta\)-quantile, weighted by `window().dates.length`). Use this aggregated value in completeness calculation:

```typescript
// edgeOnsetDeltaDays is already aggregated earlier in this topo pass
// (weighted β-quantile across window slice families, weighted by dates.length)
const delta = edgeOnsetDeltaDays ?? 0;

// Shifted age
const shiftedAge = Math.max(0, effectiveAge - delta);

// Completeness is 0 during dead-time, then shifted CDF
const completeness = shiftedAge > 0 
  ? logNormalCDF(shiftedAge, mu, sigma)
  : 0;
```

### 4.2 Horizon Reconciliation with t95

When `onset_delta_days` is present, horizons apply to total time \(T\), not post-onset time \(X\):

1. Convert `t95` to X-percentile: `x95 = max(ε, t95 - delta)`
2. Apply one-way sigma increase to ensure model-implied percentile meets `x95`
3. Report total horizon as `t95` (including \(\delta\)) for graph-visible values

This preserves "one-way pull only" semantics (never shrink tails).

### 4.3 Blending Impact

Shifted completeness feeds into the blend formula:

```
c_w = completeness^η
n_eff = c_w × p.n
```

With accurate completeness:
- During dead-time: `completeness ≈ 0`, so `n_eff ≈ 0`, blend relies on forecast
- After dead-time: Completeness grows per shifted CDF, evidence gradually dominates

This reduces "sag" in evidence-dominated downstream means caused by miscalibrated maturity.

---

## 9. Detailed implementation analysis: integrating onset into lognormal fitting/completeness

This section describes **all** remaining work required to *use* onset in the statistical machinery (shifted lognormal model). As of 3-Feb-26 we are correctly **deriving**, **persisting**, and **aggregating** `onset_delta_days`, but the core lognormal fit and completeness logic still treats lag as unshifted.

### 9.1 Definitions (single-edge)

We model time-to-conversion as:

- \(T = \delta + X\)
- \(\delta = onset\_delta\_days \ge 0\)
- \(X \sim \text{LogNormal}(\mu,\sigma)\) (post-onset lag)

So:

- \(F_T(t)=0\) for \(t \le \delta\)
- \(F_T(t)=F_X(t-\delta)\) for \(t > \delta\)
- Percentiles shift: \(t_p(T) = \delta + t_p(X)\)
u
### 9.2 Current code map (where lognormal machinery is used)

Frontend (primary):

- `graph-editor/src/services/statisticalEnhancementService.ts`
  - Fits: `fitLagDistribution(...)`, `computeEdgeLatencyStats(...)`
  - Completeness: `calculateCompleteness(...)`, `calculateCompletenessWithTailConstraint(...)`
  - Tail constraints for completeness CDF: `getCompletenessCdfParams(...)` and the “one-way sigma increase” rule
  - Path sums: `approximateLogNormalSumFit(...)` / `approximateLogNormalSumPercentileDays(...)` (Fenton–Wilkinson)

Fetch/window bounding (secondary but important for behaviour):

- `graph-editor/src/services/dataOperationsService.ts`
  - Uses FW-based `path_t95` estimation for cohort bounding (`approximateLogNormalSumPercentileDays(...)`)

### 9.3 Required change set (by responsibility)

#### 9.3.1 Completeness must be shifted by onset (core requirement)

**Problem today:** completeness uses `logNormalCDF(age, mu, sigma)` which assumes \(\delta=0\).

**Required behaviour:** use \(F_T(age)\):

- If \(age \le \delta\): completeness contribution is 0
- Else: contribution is \(F_X(age-\delta)\)

**Concrete changes (frontend):**

- Extend completeness helpers to accept `onset_delta_days`:
  - `calculateCompleteness(...)`: accept `onsetDeltaDays?: number`
  - `calculateCompletenessWithTailConstraint(...)`: accept `onsetDeltaDays?: number`
- Ensure both “moments” and “constrained sigma” CDF evaluations apply the same shift.
- Ensure the tail-constraint safety rule still holds under shifting:
  - If sigma is increased (tail constrained), completeness must not increase (one-way safety).

#### 9.3.2 The t95 tail-constraint must be applied in the post-onset domain

We store/communicate `t95` as a total-time horizon of \(T\). The fit is for \(X\). Therefore:

- Convert authoritative `t95` to an implied post-onset percentile:
  - \(t95_X = \max(\epsilon, t95_T - \delta)\)

**Concrete changes (frontend):**

- Any place that uses an “authoritative t95” to infer a minimum sigma (or apply a constraint) must operate on \(t95_X\), not \(t95_T\).
- The displayed/stored `t95` remains the total-time value (including onset); the constraint logic must not silently reinterpret the stored field.

#### 9.3.3 Fenton–Wilkinson (lognormal sum) must incorporate onset shifts explicitly

FW approximates \(X_1 + X_2\) as another lognormal by moment matching. With onset shifts:

- \(T_{path} = (\delta_1 + X_1) + (\delta_2 + X_2) = (\delta_1+\delta_2) + (X_1+X_2)\)

So FW still applies, but percentiles must be shifted by the summed onset:

- \(t_p(T_{path}) = (\delta_1+\delta_2) + t_p(X_1+X_2)\)

**Concrete changes (frontend):**

- When computing `path_t95` from FW:
  - Keep FW moment matching for the \(X\) fits as-is.
  - Add the appropriate onset shift afterward.

**Important: anchor onset**

We do not currently define/derive an “anchor onset” (\(\delta_{AX}\)) because onset is derived from window slices, and anchor legs come from cohort mode anchor_* arrays.

To ship a first version safely:

- Treat \(\delta_{AX}=0\) (no anchor onset) and only shift by edge onset \(\delta_{XY}\).

This makes the change monotonic and preserves existing anchor semantics while still fixing the dominant “edge dead-time” effect.

#### 9.3.4 Cohort path-anchored completeness must also shift correctly

In cohort path-anchored mode we already adjust effective age by subtracting anchor lag (reachability). With onset:

1. Compute reachability-adjusted age at the edge
2. Then apply onset shift: \(age_{eff}=\max(0, age_{reach}-\delta)\)

The key requirement is not to double-count pre-edge time as onset.

#### 9.3.5 Blending (evidence vs forecast) must use the shifted completeness

Once completeness is shifted, the blending weight will correctly stay near 0 during dead-time and rise after onset.

Concrete requirement: ensure **every** blend-weight computation uses the shifted completeness value (no parallel “unshifted completeness” path).

### 9.4 Test impact (what must be updated/added when implementing §9)

When the above is implemented, tests must confirm:

- Completeness is exactly 0 when \(age \le \delta\)
- For \(age > \delta\), shifted completeness equals unshifted completeness evaluated at \(age-\delta\)
- Tail-constraint “one-way safety” still holds under shifting
- FW path percentiles increase by the expected onset shift (at least \(\delta_{XY}\) given \(\delta_{AX}=0\) in V1)

## 5. Files to Modify (Surfacing & Usage Only)

| File | Change |
|------|--------|
| `graph-editor/src/components/PropertiesPanel.tsx` | Display/edit in latency section |
| `graph-editor/src/services/dataOperationsService.ts` | During incremental window() persistence, blend onset using window date-count weights (do not overwrite) |
| `graph-editor/src/services/statisticalEnhancementService.ts` | Aggregate edge onset using weighted \(\beta\)-quantile (weighted by window date-count), and use onset in shifted completeness calculation |
| `graph-editor/src/services/forecastingSettingsService.ts` | Read `ONSET_MASS_FRACTION_ALPHA` and `ONSET_AGGREGATION_BETA` from settings/settings.yaml with safe fallbacks |
| `graph-editor/public/docs/lag-statistics-reference.md` | Document shifted formula |

**Note:** UpdateManager sync and LAG topo pass aggregation are covered in `implementation-plan.md` §0.3.

---

## 6. Test Coverage

| Test | Description |
|------|-------------|
| `onset_delta_overridden.test.ts` | Manual override flow in UI |
| `onset_estimation_alpha_mass.test.ts` | Per-fetch onset estimation uses \(\alpha\) mass threshold (1 d.p.) |
| `onset_merge_weighted_by_window_dates.test.ts` | Incremental window merges blend onset using date-count weights (do not overwrite) |
| `onset_aggregation_beta_quantile.test.ts` | Topo aggregation uses weighted \(\beta\)-quantile (weighted by date-count), not min() |
| `shifted_completeness.test.ts` | Completeness = 0 during dead-time |
| `shifted_completeness_blend.test.ts` | Evidence weight = 0 when completeness = 0 |
| `horizon_reconciliation.test.ts` | t95 with onset shift |

---

## 7. Related Documents

- `docs/current/project-db/implementation-plan.md` — Extraction and storage (§0.3)
- `docs/current/project-db/snapshot-db-design.md` — Database column definition (§3.2, §3.3)
- `docs/current/project-lag/histogram-fitting.md` — Original shifted lognormal analysis
- `graph-editor/public/docs/lag-statistics-reference.md` — Canonical completeness/blending formulas

---

## 8. Open Questions

1. **Path accumulation**: Should onset delays accumulate along paths, or remain edge-local?
2. **Minimum sample size**: Should V1 derivation require minimum converters before setting non-zero onset?

**Resolved:**
- **Path accumulation**: onset is **edge-local** (does not accumulate along paths).
- **Minimum sample size**: a **single data point suffices** (no minimum sample size gate beyond “no mass → onset undefined”).
- ~~**Anchor latency**: Should `onset_delta_days` apply to `anchor_latency` as well?~~
  **Answer: No.** Window slices (the only source of reliable onset data) have no anchor component. `anchor_latency` only exists for cohort() queries, which have unreliable histogram data (~10 day limit).
