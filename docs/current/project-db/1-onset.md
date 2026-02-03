# Onset Delay: Design Decisions (`onset_delta_days`)

Date: 2-Feb-26  
Last updated: 3-Feb-26

**Document type:** Design decisions and semantic definitions

**Related documents:**
- `2-onset-implementation-plan.md` — Precise code paths, file changes, and implementation order
- `0-implementation-plan.md` §0.3 — Extraction, aggregation, and storage

---

## Document Structure

This design document covers:

1. **Problem Statement** — Why onset matters
2. **Solution** — Mathematical foundation (shifted lognormal)
3. **UI Surfacing** — How onset appears to users
4. **Semantic Definitions** — Authoritative field meanings (§4)
5. **Implementation Strategy** — High-level approach (§5)
6. **Resolved Decisions** — Formerly open questions

For precise code paths, file changes, and test requirements, see `2-onset-implementation-plan.md`.

---

## Key Design Constraints

These constraints govern all implementation work:

- Onset is only derived from **window() slices** (cohort() histogram data is unreliable)
- Onset derivation uses a **mass threshold** (defaults to **1%** of histogram mass), not "first non-zero bin"
- Onset is stored as a **single scalar per window() slice family** (no histogram retention)
- Incremental fetches **blend** new onset into existing onset (weighted by `dates.length`), never overwrite
- Edge-level onset is aggregated using a **weighted β-quantile**, not `min()`
- No `anchor_onset_delta_days` — window slices have no anchor component

---

## 1. Problem Statement

We currently model edge latency using a standard lognormal distribution. This implicitly assumes conversions can begin immediately at \(t=0\).

In practice, many edges exhibit a **dead-time** where conversions are effectively zero for the first \(d\) days. This causes:

1. **Overstated early completeness**: Lognormal CDF is non-zero at \(t=0\)
2. **Premature evidence weighting**: Blending gives too much weight to structurally right-censored evidence
3. **Downstream propagation**: Small completeness errors compound on deep paths

---

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

### 2.3 Deriving and Maintaining `onset_delta_days`

DagNet fetches `window()` slices incrementally (often only a few days per run). To keep onset stable:

#### 2.3.1 Per-fetch onset estimation (α-mass threshold, 1 d.p.)

For each `window()` slice returned by Amplitude:
- **α** = onset mass fraction threshold (default: **0.01** = 1%)
- Onset is the earliest time where cumulative histogram mass reaches α of total mass
- Convert to **days**, round to **1 decimal place**

This replaces "first non-zero bin", which is too sensitive to early noise.

#### 2.3.2 Incremental merge (weighted average by window date-count)

When merging an incremental `window()` update into an existing slice family:

\[
onset_{updated}=\frac{w_{old}\,onset_{old}+w_{new}\,onset_{new}}{w_{old}+w_{new}}
\]

Where weights are `dates.length` for each slice family. Round to **1 d.p.**

Small daily updates cannot reset a mature onset estimate.

#### 2.3.3 Edge-level aggregation (weighted β-quantile)

Edges may have multiple `window()` slice families. To aggregate:
- **β** = quantile selector (default: **0.5**)
- Use a **weighted β-quantile** across slice families, weighted by `dates.length`

This replaces `min()`, which was too aggressive.

#### 2.3.4 Manual override

If `onset_delta_days_overridden` is true:
- Estimation may compute for diagnostics, but must not overwrite stored value
- Standard DagNet permission pattern applies

#### 2.3.5 Settings knobs

In `settings/settings.yaml`:
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

### 3.2 Conditional Props (Per-Slice View)

Window slices show onset; cohort slices do not (unreliable histogram data):

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

## 4. Semantic Definitions (Authoritative)

This section resolves "what do these fields *mean*?" questions that affect correctness.

### 4.1 Inclusive Horizons: `t95` and `path_t95` Include Onset

**Decision:** `t95` and `path_t95` are defined as *total-time* horizons **inclusive of onset**.

- `t95`: the edge's 95th percentile time-to-conversion, in **days**, **including** onset dead-time
- `path_t95`: the path horizon (A→Y), in **days**, **including** onset effects

**Rationale:**
- Users reason about "how long until 95% of conversions have happened?" — this should not require mental onset adjustment
- Keeping horizons "user-space" (inclusive) avoids off-by-δ UI confusion

**Non-goal:** No explicit "path onset" scalar (e.g. `path_onset_delta_days`). Onset is **edge-local**. Path-level impact is expressed via `path_t95` and completeness, not a separate accumulator.

### 4.2 Onset is Edge-Local (Not Cumulative)

Onset is derived from **window() histogram slices** and aggregated to an edge-level `onset_delta_days`. It is an **edge attribute** that shifts the edge's distribution.

Important clarification:
- Physically, summing shifted random variables adds the deterministic shifts
- **However**, we do not track "cumulative onset" as a separate field
- Path maturity is expressed via the single inclusive `path_t95` horizon

This keeps the model simple: "each edge can have a dead-time; horizons already include it."

### 4.3 Amplitude Lag Moments are Total-Time (Not Post-Onset)

**Key point:** Amplitude's reported lag statistics (median/mean/t95) are statistics of **total time-to-conversion** \(T\), not post-onset time \(X\).

Under a shifted model: \(T = \delta + X\)

Therefore, if we want \((\mu,\sigma)\) for \(X\), we must convert:
- `median_X_days = max(ε, median_T_days - δ)`
- `mean_X_days   = max(ε, mean_T_days   - δ)`
- `t95_X_days    = max(ε, t95_T_days    - δ)`

Where ε > 0 is a small numerical guard.

**Why this matters:** Without conversion, we would mix two parameterisations — shifted completeness using \(F_X(age-\delta)\) but fitted parameters corresponding to \(T\). This is mathematically inconsistent.

### 4.4 Stored `median_lag_days` / `mean_lag_days` are Total-Time

**Decision:** Stored `median_lag_days` and `mean_lag_days` remain **total-time** moments for \(T\) (inclusive of onset).

- These values represent observed conversion-time among converters
- They are **user-space** values ("typical time to convert")
- They are *not* parameters of the post-onset component \(X\)

**Operationally:**
- Store median/mean as received from Amplitude (plus aggregation)
- Statistical machinery converts to `median_X_days` / `mean_X_days` when needed

**Why total-time semantics:** Keeps UI and debugging intuitive — all displayed values share the same "clock" (days since X-entry).

### 4.5 Stored `t95` / `path_t95` are Inclusive

**Edge `t95` policy:**
1. Fit the post-onset component \(X\) using converted moments
2. Compute implied \(t95_X\) from that fit
3. Store/display: \(t95_T = \delta + t95_X\) (inclusive)

**Tail-constraint policy:**
- Authoritative `t95` is interpreted as \(t95_T\) (inclusive)
- Sigma-min logic operates on: \(t95_X = \max(\epsilon, t95_T - \delta)\)

**`path_t95` policy:**
- Stored as inclusive horizon (same user-space clock)
- Reflects onset effects because component horizons are themselves inclusive

### 4.6 Numerical Guard Rails

Subtracting onset can create unstable ratios. Guard rails:
- `median_X_days = max(ε, median_T_days - δ)`
- `mean_X_days   = max(ε, mean_T_days - δ)`
- `t95_X_days    = max(ε, t95_T_days - δ)`

If post-onset moments become degenerate, fitting falls back to conservative defaults.

### 4.7 User-Facing Interpretation

Graph-visible fields read intuitively:
- **Onset delay δ**: "conversions effectively begin after δ days"
- **Typical lag** (median/mean): "conversions typically happen around this many days"
- **t95 (inclusive)**: "by ~t95 days, conversions are typically complete (95% matured)"

All displayed fields (`median_lag_days`, `mean_lag_days`, `t95`, `path_t95`) are **user-space total-time** values. Internal post-onset quantities are implementation details.

### 4.8 Decision Record: Persist User-Space Only

**Decision:** Persist **only user-space semantics** (total-time, inclusive-of-onset). **Always** convert to model-space before statistical calculations.

**Persisted (authoritative):**
- `onset_delta_days` = δ (edge-local dead-time)
- `median_lag_days` = median(T) (user-space)
- `mean_lag_days` = E[T] (user-space)
- `t95` = t95(T) (user-space)
- `path_t95` = user-space path horizon

**Not persisted:**
- Post-onset derived quantities (`median_X_days`, `mean_X_days`, `t95_X_days`)
- Fitted parameters for \(X\) (μ, σ)

**Rationale:**
- One intuitive "clock" for all stored/displayed numbers
- Avoids dual-truth drift (model-space quantity becoming inconsistent after onset changes)
- Modelling approach evolvable without schema churn

**Critical requirement:** Any lognormal fit or CDF evaluation for \(X\) MUST pass through a single, audited conversion helper (see §5.1).

---

## 5. Implementation Strategy

This section describes the high-level approach. For precise code paths, see `2-onset-implementation-plan.md`.

### 5.1 Single Conversion Codepath ("Stats Mode" Conversion)

To prevent bugs where some call sites shift by onset and others don't, we mandate a single conversion helper.

**Core helper:** `toModelSpace(onset, medianT, meanT?, t95T?, ageT?) → { medianX, meanX?, t95X?, ageX? }`

**Location:** `lagDistributionUtils.ts` (the "pure maths" source of truth)

**Design invariants (must be enforced by tests):**
1. **Completeness dead-time:** If `ageT ≤ δ`, completeness contribution is exactly 0
2. **Shift correctness:** For `ageT > δ`, shifted completeness equals unshifted completeness at `ageX = ageT - δ`
3. **Inclusive horizons:** Persisted/displayed values remain in T-space; constraints operate in X-space
4. **One-way safety:** If tail constraint increases σ, completeness must not increase

**Failure mode prevented:** Having both shifted and unshifted paths co-exist (e.g. blend weights using shifted completeness but horizon logic using unshifted CDF).

### 5.2 Completeness Shift

**Required behaviour:**
- If `age ≤ δ`: completeness = 0
- If `age > δ`: completeness = \(F_X(age - \delta)\)

The "one-way safety" rule for tail constraints must hold under shifting: if sigma is increased (tail constrained), completeness must not increase.

### 5.3 Tail Constraint in X-Space

Authoritative `t95` (stored) is in T-space. Conversion:
- \(t95_X = \max(\epsilon, t95_T - \delta)\)

Sigma-min constraint operates on `t95_X`, not `t95_T`.

### 5.4 Fenton-Wilkinson with Onset

FW approximates \(X_1 + X_2\). With onset:
- \(T_{path} = (\delta_1 + X_1) + (\delta_2 + X_2) = (\delta_1 + \delta_2) + (X_1 + X_2)\)

So FW still applies to the \(X\) components. Percentiles shift by summed onset:
- \(t_p(T_{path}) = (\delta_1 + \delta_2) + t_p(X_1 + X_2)\)

**V1 simplification:** We treat anchor onset as 0 (onset is only derived from window slices, not anchor legs). Only edge onset shifts the path horizon.

### 5.5 Blending Impact

Shifted completeness feeds into blend weights:
```
c_w = completeness^η
n_eff = c_w × p.n
```

With shifted completeness:
- During dead-time: `completeness ≈ 0`, so `n_eff ≈ 0`, blend relies on forecast
- After dead-time: Completeness grows per shifted CDF, evidence gradually dominates

---

## 6. Resolved Decisions

**Path accumulation:** Onset is **edge-local** (does not accumulate as a separate field). Path maturity is expressed via `path_t95`.

**Minimum sample size:** A **single data point suffices** for onset estimation (no minimum beyond "no mass → onset undefined").

**Anchor latency:** `onset_delta_days` does **not** apply to anchor latency. Window slices (the onset source) have no anchor component. `anchor_latency` only exists for cohort() queries, which have unreliable histogram data.

---

## 7. Related Documents

- `docs/current/project-db/2-onset-implementation-plan.md` — Precise code paths and test requirements
- `docs/current/project-db/0-implementation-plan.md` — Core implementation plan (§0.3 covers onset storage)
- `docs/current/project-db/snapshot-db-design.md` — Database column definition (§3.2, §3.3)
- `docs/current/project-lag/histogram-fitting.md` — Original shifted lognormal analysis
- `graph-editor/public/docs/lag-statistics-reference.md` — Canonical completeness/blending formulas
