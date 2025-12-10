# Project LAG: Latency-Aware Graph Analytics

**Status:** Implementation Complete (Alpha v1.0 Ready)  
**Created:** 1-Dec-25  
**Last Updated:** 10-Dec-25  

---

## Executive Summary

This document specifies the design for adding **latency modelling** to DAGNet. The core insight is that many edges in conversion funnels take *days* to complete—and we already retrieve daily n/k data from Amplitude. By treating this data as survival curve evidence, we can:

1. **Infer lag distributions** for each edge from daily cohort maturation curves
2. **Convolve latencies onto the DAG** for time-indexed flow projections
3. **Forecast partial cohorts** by distinguishing observed vs projected completions
4. **Compare scenarios** on both probability *and* latency assumptions

This represents a significant evolution: from a purely structural probability model to a **temporal flow model**.

---

## 1. Motivation

### 1.1 Current State

Today, DAGNet treats edges as instantaneous probability transitions:
- User arrives at node A
- With probability p, they transition to node B
- *When* they transition is not modelled

The runner computes **aggregate flow** through the DAG, but cannot answer:
- "How many users will complete step X by day 7?"
- "Is this cohort behind schedule?"
- "What will our conversion look like in 2 weeks?"

### 1.2 Data We Already Have

Amplitude's funnel API returns **daily breakdown** via the `dayFunnels` structure:

```json
{
  "dayFunnels": {
    "xValues": ["2025-11-03", "2025-11-04", "2025-11-05", ...],
    "series": [[270, 161], [186, 121], [539, 306], ...]
  }
}
```

Where each `[n_i, k_i]` pair represents:
- `n_i` = users exposed on day i
- `k_i` = users who converted on day i

Additionally, `stepTransTimeDistribution` provides **within-day granularity** (10k ms bins), and `avgTransTimes`/`medianTransTimes` give summary statistics.

### 1.3 What Latency Modelling Enables

With lag distributions on edges, we can:

| Capability | Description |
|------------|-------------|
| **Cohort maturity curves** | Track % completion over time for any cohort |
| **Time-indexed forecasting** | Project arrivals at nodes by day |
| **Partial cohort projection** | Split observed (solid) vs forecast (dashed) |
| **Scenario comparison** | Compare not just p but also "time to convert" |
| **Operations planning** | Combine latency with labour_cost for capacity planning |

---

## 2. Conceptual Model

### 2.1 Two Types of Windows

**Critical Distinction:** We must separate:

| Window Type | Definition | Purpose |
|-------------|------------|---------|
| **Cohort Window** | Period during which users *enter* the funnel | Defines the cohort population (n) |
| **Observation Window** | Period during which we observe *conversions* | Defines how long we track (k over time) |

**Example:**
- Cohort window: 1-Nov-25 to 7-Nov-25 (cohort entry)
- Observation window: 1-Nov-25 to 21-Nov-25 (14 days to mature)

Users who entered on 7-Nov have only 14 days to convert; users from 1-Nov have 20 days. This asymmetry is what creates the survival curve data.

### 2.2 Which Edges Need Latency?

Not all edges require latency modelling. We care about edges where:
- Transition takes **days, not minutes**
- We want to **forecast partial cohort completion**
- There's meaningful **variability in completion times**

Edges that complete within a session (e.g., button clicks) have effectively zero lag and should be treated as instantaneous.

### 2.3 Statistical Model

For each latency-tracked edge, we infer a **survival/lag distribution**:

```
F(t) = P(transition complete by lag t)
```

From daily n/k data sliced by cohort entry date, we build:

```
k_{d,t} ~ Binomial(n_d, F(t))
```

Where:
- `d` = cohort entry date
- `t` = days since entry (lag)
- `n_d` = users entering on date d
- `k_{d,t}` = users from date d who converted by lag t

The parametric family (Log-Normal, Weibull, Gamma) is fitted via MLE or Bayesian posterior.

---

## 3. Data Model Changes

### 3.1 Probability Schema Additions

```typescript
// Attached to ProbabilityParam (edge.p.latency and edge.conditional_p[i].p.latency)
interface LatencyConfig {
  /** Maturity threshold in days - cohorts younger than this are "immature"
   *  
   *  SEMANTICS:
   *  - maturity_days > 0: Latency tracking ENABLED (cohort queries, forecasting, latency UI)
   *  - maturity_days = 0 or undefined: Latency tracking DISABLED (standard window() behaviour)
   *  
   *  NOTE: No separate `track` boolean - tracking is derived from maturity_days.
   */
  maturity_days?: number;  // Default: undefined (no tracking). Set >0 to enable.
  /** True if user manually set maturity_days (vs derived from file) */
  maturity_days_overridden?: boolean;
  
  /** Anchor node for cohort queries - furthest upstream START node from edge.from
   *  Computed by MSMDC at graph-edit time (not retrieval time)
   */
  anchor_node_id?: string;
  /** True if user manually set anchor_node_id (vs MSMDC-computed) */
  anchor_node_id_overridden?: boolean;

// Persisted scalar for caching / display (per ProbabilityParam, scenario-independent):
//  - t95?: number;  // 95th percentile lag for this edge under the pinned DSL
//
// All other fit/DP internals (mu, sigma, path_t95, empirical_quality_ok)
// are service-level computation artefacts, not separate schema fields on LatencyConfig.
}
```

### 3.2 Parameter File Additions (A‑anchored cohort evidence)

For edges with `latency.maturity_days > 0` (latency tracking enabled), parameter files store **A‑anchored per‑cohort evidence** plus edge‑level latency summaries. The structure **extends the existing parameter schema pattern** (flat parallel arrays, `window_from`/`window_to`, `data_source` object) with new latency fields.

```yaml
# parameter-{edge-id}.yaml  (example: A=HouseholdCreated, X=SwitchRegistered, Y=SwitchSuccess)
id: switch-registered-to-success
name: Switch Registered → Success
type: probability

# Edge-level latency configuration (see §3.1)
latency:
  maturity_days: 30             # >0 enables latency tracking (no separate 'track' field)
  anchor_node_id: household-created  # Cohort anchor node (A in A→X→Y)

values:
  - # === Slice identification (see §3.3 and §4.7.1) ===
    # sliceDSL is CANONICAL: includes anchor node_id + absolute dates
    sliceDSL: 'cohort(household-created,1-Sep-25:30-Nov-25).context(channel:all)'
    
    # === Core fields (existing schema) ===
    mean: 0.7041                     # k/n
    n: 1450                          # Total X→Y cohort n
    k: 1021                          # Total X→Y converters
    cohort_from: '1-Sep-25'          # NEW: Cohort entry window start (A-entry dates)
    cohort_to: '30-Nov-25'           # NEW: Cohort entry window end
    
    # === Daily breakdown (existing schema - flat parallel arrays) ===
    dates: [1-Sep-25, 2-Sep-25, 3-Sep-25, ...]       # d-MMM-yy format (A-entry dates)
    n_daily: [21, 7, 12, ...]                        # Per-cohort n
    k_daily: [19, 4, 10, ...]                        # Per-cohort k
    
    # === NEW: Per-cohort latency (flat arrays, parallel to dates) ===
    median_lag_days: [6.0, 6.0, 6.0, ...]            # X→Y median lag per cohort
    mean_lag_days: [6.2, 6.0, 5.9, ...]              # X→Y mean lag per cohort
    
    # === NEW: Anchor data for multi-step funnels (flat arrays, parallel to dates) ===
    anchor_n_daily: [575, 217, 318, ...]             # Users entering A per cohort
    anchor_median_lag_days: [14.8, 16.2, 17.5, ...]  # A→X median lag per cohort
    anchor_mean_lag_days: [15.9, 16.2, 18.3, ...]    # A→X mean lag per cohort
    
    # === NEW: Edge-level latency summary for X→Y ===
    latency:
      median_lag_days: 6.0           # Weighted median X→Y lag
      mean_lag_days: 7.0             # Weighted mean X→Y lag
      completeness: 1.0              # Maturity progress 0-1 (see §5.5)
      histogram:
        total_converters: 1021
        bins:
          - { day: 3, count: 2 }
          - { day: 6, count: 716 }
          - { day: 7, count: 206 }
          - { day: 8, count: 42 }
          - { day: 9, count: 55 }
    
    # === NEW: Upstream (A→X) latency for convolution ===
    anchor_latency:
      median_lag_days: 11.4
      mean_lag_days: 12.3
      histogram:
        total_converters: 1450
        bins:
          - { day: 3, count: 1 }
          - { day: 4, count: 6 }
          - { day: 5, count: 37 }
          # ... days 6-9 ...
          - { day_range: [10, 45], count: 1029 }
    
    # === Provenance (existing schema) ===
    data_source:
      type: amplitude
      retrieved_at: '2025-12-02T00:00:00Z'

#
# NOTE: No separate top-level `anchor:` block – the canonical anchor lives at
# `latency.anchor_node_id` and is mirrored on the graph edge as
# `p.latency.anchor_node_id`.
  description: Graph node used as cohort anchor (resolved to event at query time)

metadata:
  description: X→Y edge from 3-step A→X→Y funnel
  created_at: '2025-12-02T00:00:00Z'
  author: amplitude-import
  version: '1.0.0'
```

**Notes (cohort slices):**

- **Flat parallel arrays**: `dates`, `n_daily`, `k_daily`, `median_lag_days`, `mean_lag_days`, `anchor_n_daily`, `anchor_median_lag_days`, `anchor_mean_lag_days` are all parallel arrays indexed by cohort date. This aligns with the existing schema pattern.
- **Anchor data** (`anchor_*` arrays) is only present for multi-step funnels (A→X→Y) where we need upstream lag for convolution. For 2-step funnels, these fields are absent.
- The **forecast baseline** for X→Y is derived from `latency.median_lag_days`, `latency.mean_lag_days` and the fitted lag CDF (§5.4).
- The script `amplitude_to_param.py` generates this format from Amplitude funnel responses.

#### 3.2.1 Window Slice Additions (X‑anchored)

For **window() slices** (X‑anchored, no cohort/anchor semantics), the additions are lighter:

```yaml
values:
  # X-anchored window slice (recent events only)
  - sliceDSL: 'window(25-Nov-25:1-Dec-25).context(channel:google)'
    mean: 0.067
    n: 120
    k: 8

    # === Window bounds (existing, see §3.3) ===
    window_from: '25-Nov-25'         # Event occurrence bounds (X-event dates)
    window_to: '1-Dec-25'

    # === Daily breakdown (existing schema) ===
    dates: [25-Nov-25, 26-Nov-25, ...]
    n_daily: [18, 22, ...]
    k_daily: [1, 2, ...]

    # === NEW: Forecast + latency per window slice ===
    forecast: 0.071                  # Mature baseline p_∞ for this window slice
    latency:
      median_lag_days: 5.8           # Window-level median lag (days) for this edge
      mean_lag_days: 6.3             # Window-level mean lag (days) for this edge
      t95: 45                        # 95th percentile lag (days) for this edge under the pinned window

    data_source:
      type: amplitude
      retrieved_at: '2025-12-02T00:00:00Z'
```

**Notes (window slices):**

- `window_from` / `window_to` are described in §3.3; they are **not new** but are required to make `sliceDSL` canonical.
- `values[].forecast` is the **new field** added for window slices: it stores the mature baseline probability \(p_\infty\) computed at retrieval time (recency‑weighted if configured).
- `values[].latency.median_lag_days` / `mean_lag_days` are **window-level summaries**: they mirror the cohort summaries but are fitted from window() lag stats, so the UI can still show a median/mean lag even if only window() data was fetched.
- `values[].latency.t95` is the **new latency scalar** for window slices: it stores the fitted 95th percentile lag for this edge under the pinned window, so a graph can be fully reconstructed (baseline + latency) even if only window() data was fetched.
- Window slices **reuse the existing `dates`, `n_daily`, `k_daily` arrays**; they do **not** add per‑cohort latency arrays (`median_lag_days[]`, `mean_lag_days[]`) because those are cohort‑specific.

### 3.3 Slice Labelling: `sliceDSL` and Date Bounds

**CHANGE FROM CURRENT BEHAVIOUR:** The current codebase strips `window()` from `sliceDSL`, storing only context dimensions. This loses information about the query type and makes it impossible to distinguish cohort vs window slices.

**New design:** `sliceDSL` should be a **canonical label** for the slice. See §4.7.1 for full specification.

**Key requirements:**
- **Absolute dates** (not relative) — enables merging across fetches
- **Explicit anchor node_id** for cohort slices — prevents cross-graph confusion
- **All context clauses** — fully identifies the slice

```yaml
# Cohort slice (canonical format)
sliceDSL: 'cohort(household-created,1-Sep-25:30-Nov-25).context(channel:google)'
cohort_from: '1-Sep-25'
cohort_to: '30-Nov-25'

# Window slice (canonical format)
sliceDSL: 'window(25-Nov-25:1-Dec-25).context(channel:google)'
window_from: '25-Nov-25'
window_to: '1-Dec-25'
```

**Rationale:**
- `sliceDSL` is a **canonical identifier**, not a copy of the pinned query
- Enables intelligent cache/merge policy (see §4.7.3)
- Prevents incorrect cache hits from different anchor nodes
- Absolute dates allow merging slices fetched at different times

**Date bound fields:**
- `cohort_from`/`cohort_to` — resolved absolute bounds for cohort slices (A-entry dates)
- `window_from`/`window_to` — resolved absolute bounds for window slices (X-event dates)

These serve as **indexed fields for efficient filtering** without DSL parsing.

**Implementation:** Update `extractSliceDimensions()` and `mergeTimeSeriesIntoParameter()` to generate canonical sliceDSL (anchor + absolute dates) rather than preserving the original query.

### 3.4 Date Format Standardisation

**CHANGE FROM CURRENT SCHEMA:** The current `parameter-schema.yaml` uses ISO `date-time` format for `window_from`/`window_to` (e.g., `2025-01-01T00:00:00Z`). We standardise on **`d-MMM-yy`** format throughout:

| Field | Current Schema | New Standard |
|-------|---------------|--------------|
| `window_from`, `window_to` | `2025-01-01T00:00:00Z` | `1-Jan-25` |
| `cohort_from`, `cohort_to` | *(new fields)* | `1-Sep-25` |
| `dates[]` array | *(unspecified)* | `1-Sep-25` |

**Exceptions:**
- `data_source.retrieved_at` — remains ISO `date-time` (machine timestamp)
- `metadata.created_at`, `metadata.updated_at` — remain ISO `date-time`

**Schema update required:** Change `window_from`/`window_to` from `format: date-time` to `format: date` with pattern `^\d{1,2}-[A-Z][a-z]{2}-\d{2}$` and add `cohort_from`/`cohort_to` with same pattern.

### 3.5 Renaming: cost_time → labour_cost

The operations team uses "time cost" to track **human effort** (hours spent processing), distinct from latency (calendar time to conversion). We rename:

| Old Field | New Field | Meaning |
|-----------|-----------|---------|
| `cost_time` | `labour_cost` | Human hours/days of effort |
| *(none)* | `latency` | Calendar days to completion |

**Migration:** Global search/replace `cost_time` → `labour_cost` across codebase. No deprecation period needed.

---

## 4. Query Architecture Changes

### 4.0 DSL Field Glossary

The system uses several DSL-related fields. Their roles are distinct:

| Field | Location | Purpose | Authoritative Source |
|-------|----------|---------|---------------------|
| `dataInterestsDSL` | `graph.dataInterestsDSL` | **Pinned DSL** — shapes overnight/batch fetches, determines which slices are pre-materialised in param files | Graph file (persisted) |
| `currentQueryDSL` | `graph.currentQueryDSL` | **Historic record** — last interactive query, persisted so graph reopens in same state | Graph file (persisted) |
| `currentDSL` | `graphStore.currentDSL` | **Live authoritative DSL** — drives current interactive queries, NOT to be confused with `currentQueryDSL` | In-memory store |
| `baseDSL` | `graph.baseDSL` | **Scenario base** — live scenarios inherit from this unless they override | Graph file (persisted) |
| `meta.queryDSL` | `Scenario.meta.queryDSL` | **Scenario-specific DSL** — defines what data slice a live scenario represents | Scenario object |
| `sliceDSL` | `values[].sliceDSL` | **Canonical slice label** — identifies a param file slice with absolute dates + anchor | Param file |

**Key distinction:** `currentDSL` (store) is authoritative for live operations; `currentQueryDSL` (graph) is only for persistence. Code comments explicitly warn: "NEVER fall back to `graph.currentQueryDSL`".

### 4.1 Event Window vs Cohort Window in DSL

**Current `window()` syntax:**
```
window(-30d:)                      // Relative: last 30 days to now
window(1-Jan-25:31-Mar-25)         // Absolute: start:end
```

This refers to events occurring in date range. We retain this for event-based queries.

**New `cohort()` syntax** (parallel to `window()`):
```
cohort(-30d:)                      // Relative: cohorts from last 30 days
cohort(1-Nov-25:7-Nov-25)          // Absolute: cohort entry dates
```

Same syntax as `window()`, different semantics: users *entering* in date range, tracked for conversions.

### 4.2 Cohort Anchor Node

By default, cohort entry is anchored to the **START node** of the funnel. But we may want to anchor to a different node.

**Syntax options:**
```
// Default: anchor to START node
cohort(-14d:-7d)
cohort(1-Nov-25:7-Nov-25)

// Explicit anchor node (optional first argument)
cohort(delegated-household,-14d:)
cohort(delegated-household,1-Nov-25:7-Nov-25)
```

**How it works in Amplitude:**
```
Funnel: [ANCHOR] → A → B
        ^-- e.g., "Household Created" or "Delegation Completed"
```

With cohort anchoring:
- `dayFunnels.series[i] = [n_i, k_i]` gives users who did ANCHOR on date i
- Dates in `xValues` are **cohort entry dates** (when they hit the anchor)
- This automatically segments users by their entry cohort

### 4.3 Maturity is Edge-Level, Not DSL

**We do NOT need `mature_until()` in the DSL.**

Maturity is a client-side concept:
- "How old must a cohort be before we trust its conversion rate?"
- This is a property of the **edge**, not the query

Set on edge:
```yaml
latency:
  maturity_days: 30  # >0 enables tracking; cohorts <30 days old are "immature"
```

The DSL just specifies the date range. Mature/immature split is computed after data returns.

### 4.4 What Amplitude Gives Us (Everything We Need)

| Field | What It Contains | Use |
|-------|------------------|-----|
| `dayFunnels.series[i]` | `[n_i, k_i]` per cohort entry date | **Day-by-day cohort tracking** |
| `dayMedianTransTimes.series[i]` | Median time-to-convert (ms) per cohort | **Latency estimation** |
| `cumulativeRaw` | `[total_n, total_k]` | Aggregate conversion rate |
| `medianTransTimes` | Aggregate median (ms) | Overall latency |

### 4.5 Example: Mature vs Immature Cohorts

Tested funnel: **Household Created → Switch Registered** (Nov 2025)

```
Date             n     k       p   MedianDays   Status
--------------------------------------------------------
1-Nov-25       250    22    8.8%     11.0       Mature (30 days old)
10-Nov-25      421    34    8.1%      9.9       Mature (21 days old)
22-Nov-25       85     1    1.2%      5.4       Maturing (9 days old)
23-Nov-25       87     0    0.0%      n/a       Immature (8 days old)
28-Nov-25      624     0    0.0%      n/a       Immature (3 days old)
```

**What this shows:**
- Cohorts >10 days old have conversions (mature)
- Cohorts <10 days old have k=0 (haven't had time to convert yet)
- Median trans time ~10 days tells us maturity threshold
- Re-query later → immature cohorts will have conversions

**We have everything:** Day-by-day tracking, per-cohort latency, mature/immature split. No additional data needed.

### 4.6 Dual-Slice Retrieval for Latency Edges

**Problem:** For latency-tracked edges, `window()` and `cohort()` have fundamentally different semantics:

| Query | Semantics | Data Source |
|-------|-----------|-------------|
| `cohort(-90d:-60d)` | Users who entered **A** (anchor) in that range; what happened to them on X→Y? | A-anchored 3-step funnel |
| `window(-7d:)` | Events where **X** occurred in the last 7 days; what's the X→Y rate? | X-anchored 2-step funnel |

If we only have A-anchored data, answering `window(-7d:)` requires convolving A-cohorts with the A→X lag distribution — which is model-heavy and loses the "raw recent events" intuition users expect.

**Solution: Dual-slice ingestion for latency edges.**

When the pinned DSL (e.g., `or(window(-7d:), cohort(-90d:)).context(channel)`) contains **both** `window()` and `cohort()` clauses, and the edge has `latency.maturity_days > 0` (latency tracking enabled):

1. **Cohort slice** (A-anchored):
   - Fetch 3-step funnel `[A → X → Y]` for the cohort range.
   - Store using flat arrays (`dates`, `n_daily`, `k_daily`, `median_lag_days`, `mean_lag_days`, `anchor_*`) plus `latency` and `anchor_latency` blocks (as per §3.2):
     - Per-cohort arrays: `median_lag_days[]`, `mean_lag_days[]`, `anchor_n_daily[]`, `anchor_median_lag_days[]`, `anchor_mean_lag_days[]`.
     - Slice summaries: `latency.{median_lag_days, mean_lag_days, completeness, histogram}`, `anchor_latency.{median_lag_days, mean_lag_days, histogram}`.
   - Used for `cohort(...)` queries and as the A-anchored evidence for Formula A and completeness.

2. **Window slice** (X-anchored):
   - Fetch 2-step funnel `[X → Y]` for the window range.
   - Store using same flat-array pattern (`dates`, `n_daily`, `k_daily`) plus **window-level** latency + forecast (as per §3.2.1):
     - Slice summaries: `forecast` (baseline \(p_\infty\)), `latency.{median_lag_days, mean_lag_days, t95, histogram}`.
   - Used for `window(...)` queries — gives "raw recent events" at this edge and a self-contained baseline/latency view.

Both slices are stored in the **same param file**, distinguished by `sliceDSL` (see §3.3 and §4.7.1):

```yaml
values:
  # A-anchored cohort slice (full latency data)
  # Note: sliceDSL is CANONICAL — includes anchor node_id + absolute dates
  - sliceDSL: 'cohort(household-created,1-Sep-25:30-Nov-25).context(channel:google)'
    mean: 0.704
    n: 1450
    k: 1021
    cohort_from: '1-Sep-25'          # Cohort entry bounds (A-entry dates)
    cohort_to: '30-Nov-25'
    dates: [1-Sep-25, 2-Sep-25, ...]
    n_daily: [21, 7, ...]
    k_daily: [19, 4, ...]

    # Per-cohort latency (A-anchored)
    median_lag_days: [6.0, 6.0, ...]
    mean_lag_days: [6.2, 6.0, ...]
    anchor_n_daily: [575, 217, ...]
    anchor_median_lag_days: [14.8, 16.2, ...]
    anchor_mean_lag_days: [15.9, 16.2, ...]

    # Slice-level summaries + histograms
    latency:
      median_lag_days: 6.0
      mean_lag_days: 7.0
      completeness: 1.0
      histogram:
        total_converters: 1021
        bins:
          - { day: 3, count: 2 }
          - { day: 6, count: 716 }
          - { day: 7, count: 206 }
          - { day: 8, count: 42 }
          - { day: 9, count: 55 }

    anchor_latency:
      median_lag_days: 11.4
      mean_lag_days: 12.3
      histogram:
        total_converters: 1450
        bins:
          - { day: 3, count: 1 }
          - { day: 4, count: 6 }
          - { day: 5, count: 37 }
          - { day_range: [10, 45], count: 1029 }

    data_source:
      type: amplitude
      retrieved_at: '2025-12-02T00:00:00Z'

  # X-anchored window slice (recent events only)
  # Note: sliceDSL uses absolute dates (no anchor needed for window slices)
  - sliceDSL: 'window(25-Nov-25:1-Dec-25).context(channel:google)'
    mean: 0.067
    n: 120
    k: 8
    window_from: '25-Nov-25'         # Event occurrence bounds (X-event dates)
    window_to: '1-Dec-25'
    dates: [25-Nov-25, 26-Nov-25, ...]
    n_daily: [18, 22, ...]
    k_daily: [1, 2, ...]

    # Forecast + window-level latency
    forecast: 0.071
    latency:
      median_lag_days: 5.8
      mean_lag_days: 6.3
      t95: 45
      histogram:
        total_converters: 120
        bins:
          - { day: 3, count: 2 }
          - { day: 5, count: 50 }
          - { day: 7, count: 40 }
          - { day_range: [8, 30], count: 28 }

    data_source:
      type: amplitude
      retrieved_at: '2025-12-02T00:00:00Z'
```

**Query resolution:**

| Query | Condition | Resolution |
|-------|-----------|------------|
| `cohort(...)` | `maturity_days > 0` | Use cohort slice (A-anchored); slice by date, aggregate n/k |
| `cohort(...)` | `maturity_days = 0` BUT `upstream_maturity > 0` | **Use cohort slice** (A-anchored); population semantics must flow through |
| `cohort(...)` | `maturity_days = 0` AND `upstream_maturity = 0` | Treat as `window()` (optimisation: no lag anywhere upstream) |
| `window(...)` | `maturity_days > 0`, window slice exists | Use window slice (X-anchored); slice by date |
| `window(...)` | `maturity_days > 0`, no window slice | Fall back to model-based convolution from cohort slice + lag CDF |
| `window(...)` | `maturity_days = 0` | Existing `window()` logic (n_daily/k_daily by event date) |

Where `upstream_maturity = compute_a_x_maturity(graph, anchor_id, edge.from)` — see §4.7.2.

**Rationale for upstream maturity check:**

If ANY upstream edge from the anchor has lag, the cohort population is constrained by that lag. An "instant" edge (maturity_days=0) downstream of a latency edge still needs cohort semantics to:
1. Show the correct A-anchored population (not random window events)
2. Inherit upstream completeness (cohort may not have reached this edge yet)
3. Avoid misleading "complete" appearance when upstream is immature

**Example:** Graph `a→b→c→d` with a→b at 10d maturity, b→c at 0d (instant), c→d at 10d.

Query `cohort(a, -5d:)`:
- a→b: upstream_maturity=0 (A=X), own=10 → cohort mode, shows ~25% complete
- b→c: upstream_maturity=10, own=0 → **cohort mode** (not window!), inherits ~25% complete
- c→d: upstream_maturity=10, own=10 → cohort mode, shows ~25% complete

Without this rule, b→c would show window data from different (older) cohorts and appear "complete".

**Implications:**

- **Pinned DSL design matters:** To get both cohort and window views for a latency edge, the pinned DSL must include both `cohort(...)` and `window(...)` clauses (e.g., `or(window(-30d:), cohort(-90d:))`).
- **Amplitude query count:** For latency edges with dual slices, we make two Amplitude calls per context slice (one 3-step, one 2-step). This is acceptable given the distinct use cases.
- **Upstream maturity propagates cohort semantics:** Even instant edges use cohort mode when downstream of latency edges.

### 4.7 Canonical sliceDSL, Maturity Calculation, and Cache Policy

#### 4.7.1 Canonical sliceDSL Format

**IMPORTANT:** The `sliceDSL` stored in param files is a **canonical label**, not a copy of the pinned query. It must fully identify the slice independent of graph context.

This has two key implications:

- **DSL semantics are order-insensitive.** At the level of user-facing DSL, the order of `context(...)` clauses (and other constraints) is not meaningful. The canonical `sliceDSL` is a *normalised serialisation* produced by the system (e.g. sorted context keys, fixed function order) for cache keys only.
- **Anchors are required only in `sliceDSL` for cohort slices.** The interactive DSL does **not** require an explicit anchor argument; when it is omitted, MSMDC infers the anchor node (e.g. START or `p.latency.anchor_node_id`) and writes it into `sliceDSL` when persisting param files.

**Problem:** User pins `cohort(-90d:)` for a graph where START = `household-created`. The Amplitude query is constructed using that anchor. But the *param file* is shared — another graph with different START might incorrectly use this cohort data.

**Solution:** `sliceDSL` must include:
1. **Absolute dates** (not relative)
2. **Explicit anchor node_id** for cohort slices **in the stored `sliceDSL`** (inferred when omitted in the interactive DSL)
3. **All context clauses**

**Canonical format:**
```
cohort(<anchor_node_id>,<start>:<end>)[.context(...)]
window(<start>:<end>)[.context(...)]
```

Where:
- `<anchor_node_id>` is **always present in `sliceDSL` for cohort slices**, even if the original user query was just `cohort(start:end)` (anchor inferred from graph).
- `.context(...)` clauses may appear in any order in the user DSL; the canonicaliser sorts/normalises them when writing `sliceDSL`.

**Examples:**
```yaml
# Pinned DSL: cohort(-90d:).context(channel:google)
# Graph START: household-created
# Query date: 2-Dec-25

# Stored sliceDSL (CANONICAL):
sliceDSL: 'cohort(household-created,1-Sep-25:30-Nov-25).context(channel:google)'

# NOT this (ambiguous):
sliceDSL: 'cohort(-90d:).context(channel:google)'
```

**For window slices** (no anchor needed):
```yaml
# Pinned DSL: window(-7d:)
# Query date: 2-Dec-25

sliceDSL: 'window(25-Nov-25:1-Dec-25).context(channel:google)'
```

**Why this matters:**
- Unambiguous slice identification across graphs
- Enables intelligent merging (see §4.7.3)
- Prevents incorrect cache hits from different anchors

#### 4.7.2 Total Maturity Calculation

For cohort slices, we need **total maturity** to determine cache/refresh policy. A cohort from Day D is mature when `today - D >= total_maturity`.

**Total maturity = A→X maturity + X→Y maturity**

**Prefer empirical data (T_95), fallback to configured `maturity_days`:**

For each edge, compute **T_95** (95th percentile of lag distribution) from stored `median_lag_days` and `mean_lag_days`:

```python
def edge_t95(edge) -> float:
    """
    Compute T_95 for an edge. Prefer empirical data, fallback to maturity_days.
    """
    latency = edge.p.latency or {}
    
    # Check if empirical data is available and sufficient quality
    median = latency.get('median_lag_days')
    mean = latency.get('mean_lag_days')
    k = latency.get('k', 0)  # Number of converters
    
    if median and mean and k >= 30 and 1.0 <= mean/median <= 3.0:
        # Quality check passed: use empirical T_95
        sigma = math.sqrt(2 * math.log(mean / median))
        t95 = median * math.exp(1.645 * sigma)
        return t95
    
    # Fallback to configured maturity_days (or default 30)
    return latency.get('maturity_days') or 30
g```

**Quality thresholds for empirical data:**
- `k >= 30` — sufficient converters for reliable median estimate
- `mean/median` in [1.0, 3.0] — reasonable log-normal shape (ratio < 1 is impossible; > 3 indicates suspect data)

**Scenario-aware algorithm: Longest path in DAG (uses computed `t95`)**

```python
def compute_path_t95_for_all_edges(graph, anchor_id, active_edges):
    """
    Compute path_t95 for all edges from anchor.
    Run ONCE per query, after batch fetch completes (all relevant edges have t95 computed).
    Result is transient (scenario-specific), NOT persisted to graph file.

    CRITICAL: active_edges is the set of edges that are ACTIVE under the
    current scenario (cases + conditional_ps). Inactive edges are ignored.
    """
    topo_order = topological_sort(graph)
    
    # DP: max T_95 to reach each node from anchor
    max_t95_to_node = {node: -inf for node in graph.nodes}
    max_t95_to_node[anchor_id] = 0
    
    for node_id in topo_order:
        if max_t95_to_node[node_id] == -inf:
            continue  # Unreachable from anchor under this scenario
        
        for edge in outgoing_edges(node_id):
            if edge not in active_edges:
                continue  # Edge is disabled in this scenario

            # Use t95 computed at retrieval time (edge.p.latency, service-level)
            edge_t = edge.p.latency.t95 if edge.p.latency?.t95 else 0
            
            new_path = max_t95_to_node[node_id] + edge_t
            max_t95_to_node[edge.to] = max(max_t95_to_node[edge.to], new_path)
            
            # Store path total on the probability latency block (transient, for this query)
            edge.p.latency.path_t95 = new_path
```

**Complexity:** O(E_active) — runs once per batch fetch, not per edge or per query.

**Determining `activeEdges`:**

An edge is **active** under a scenario iff its effective probability is non-zero:

```python
def get_active_edges(graph, whatIfDSL):
    """Return edges that are active under this scenario."""
    active = set()
    for edge in graph.edges:
        eff_prob = computeEffectiveEdgeProbability(graph, edge.id, { whatIfDSL })
        if eff_prob > 1e-9:  # Epsilon threshold for floating-point
            active.add(edge)
    return active
```

This uses the existing `computeEffectiveEdgeProbability` from `lib/whatIf.ts` which already handles case variants and `conditional_p` activation.

**Scenario effect:** Cases and `conditional_ps` determine which edges are active for a given scenario. The maturity DP **must run on this scenario‑effective graph**, not the raw topology: only edges that are actually used in the scenario contribute to A→X maturity.

**When `path_t95` is computed:**

- **Once per batch fetch:** After batch fetch completes, all active edges have fresh `t95` from their window() slices. Run the DP once.
- **Per-query (scenario-aware):** The set of `activeEdges` depends on the query's `whatIfDSL` (cases, conditional_ps). A query for scenario X computes path_t95 using X's active edges. This is NOT a separate "trigger" — it's part of query evaluation.
- **NOT stored globally:** `path_t95` is per-query/scenario, derived during query execution. It's only cached for the lifetime of that query context.

**Example (with empirical data):**
```
Graph: A --[med=10d, mean=15d]--> B --[med=5d, mean=6d]--> X --[med=20d, mean=30d]--> Y

Edge A→B: σ=0.90, T_95 = 10 × e^(1.645×0.90) = 44d
Edge B→X: σ=0.58, T_95 = 5 × e^(1.645×0.58) = 13d  
Edge X→Y: σ=0.90, T_95 = 20 × e^(1.645×0.90) = 88d

Total maturity = max(44) + 13 + 88 = 145 days
```

**Edge cases:**
- A = X (direct edge): A→X maturity = 0
- Non-latency edges (`maturity_days = 0`): contribute 0 to path
- No empirical data yet: falls back to `maturity_days`
- X unreachable from A: error (invalid anchor)

**Fetch ordering requirement:** To ensure upstream empirical data is available when computing downstream cache policy, batch fetches should be **topologically sorted** (edges near START nodes fetched first). See implementation plan.

#### 4.7.3 Cache and Merge Policy

**CHANGE FROM CURRENT BEHAVIOUR:** This section describes changes to both `window()` AND `cohort()` retrieval mechanics.

**Current behaviour (all edges):**
- Fetch only missing date gaps
- Append new slices to param file
- `sliceDSL` stores the context only (window stripped)
- Works for non-latency edges where each day's data is final when fetched

**Problems this creates:**
- **Latency edges:** Data matures over time — k accrues after initial fetch
- **Recent data:** Incomplete; needs refresh, but current logic skips "cached" dates
- **Appending:** Creates bloated, repetitive param files
- **Relative DSL:** Cannot merge slices fetched at different times

**New policy (applies to ALL slice types):**

| Slice Type | Cache Policy | Merge Policy | sliceDSL Format |
|------------|--------------|--------------|-----------------|
| `window()` with maturity=0 | Incremental gaps | Merge by date | `window(<abs_start>:<abs_end>)[.context()]` |
| `window()` with maturity>0 | Re-fetch immature portion | Replace immature, merge mature | `window(<abs_start>:<abs_end>)[.context()]` |
| `cohort()` | Re-fetch if immature cohorts OR stale | Replace entire slice | `cohort(<anchor>,<abs_start>:<abs_end>)[.context()]` |

**Window slice (CHANGED from current behaviour):**

For `window()` with `maturity_days=0` (non-latency or instant conversion):
```
Current incremental logic continues to work.
Merge by date, update sliceDSL bounds to reflect coverage.
sliceDSL: 'window(1-Sep-25:30-Nov-25).context(...)' ← absolute dates
```

For `window()` with `maturity_days>0` (latency edge):
```
Query: window(-30d:-1d), maturity_days=7, today=T

Mature portion:   [-30d:-8d]  → use cache if exists
Immature portion: [-7d:-1d]   → ALWAYS re-fetch (data still accruing)

On merge:
  - Replace data for dates in immature window
  - Keep cached data for mature dates
  - Update sliceDSL bounds: 'window(<earliest>:<latest>).context(...)'
```

**Cohort slice:**
```
Query: cohort(household-created,-90d:), total_maturity=50d, today=T

Cohorts [-90d:-51d]: mature → could use cache
Cohorts [-50d:]:     immature → data still accruing

Re-fetch triggers:
  1. Any immature cohorts need updating (based on total_maturity)
  2. Explicit user refresh

On merge:
  - Replace entire slice (cohort data is holistic)
  - Update sliceDSL bounds to reflect actual coverage

# NOTE: "staleness" heuristics based on wall-clock age of data
# (e.g. "last fetch > N hours ago") are part of the existing system
# but are NOT changed or specified in this project-lag design.
# This section only introduces new maturity-based rules (1) and
# assumes any separate isStale checks remain as-is in the fetch layer.
```

**Key changes for window() slices:**
- `sliceDSL` now uses **absolute dates** (not stripped)
- Merge updates `sliceDSL` bounds to reflect actual coverage
- For latency edges: immature portion always re-fetched

**Key changes for cohort() slices:**
- `sliceDSL` includes **anchor node_id** + absolute dates
- Replace entire slice on refresh (not incremental append)
- Merge updates `sliceDSL` bounds to reflect actual coverage

**Merge and sliceDSL update:**

When merging fetches over time:
```
Day 1: Fetch cohort(a,-90d:) → covers 1-Sep-25:30-Nov-25
       sliceDSL: 'cohort(household-created,1-Sep-25:30-Nov-25)'

Day 2: Fetch cohort(a,-90d:) → covers 2-Sep-25:1-Dec-25
       
After merge:
       dates[] spans 1-Sep-25:1-Dec-25
       sliceDSL: 'cohort(household-created,1-Sep-25:1-Dec-25)'  ← UPDATED
```

The `sliceDSL` reflects **effective coverage**, not the original query. Original queries go in `data_source.full_query` for provenance.

**Implementation sketch (applies to any fetch-from-source, not only "fetch all"):**
```typescript
function shouldRefetch(slice: ParamSlice, edge: Edge, graph: Graph): RefetchDecision {
  if (!edge.p?.latency?.maturity_days) {
    return { type: 'gaps_only' };  // Current incremental logic
  }
  
  const isCohort = slice.sliceDSL.includes('cohort(');
  
  if (isCohort) {
    const totalMaturity = computeTotalMaturity(graph, edge);
    const hasImmatureCohorts = slice.dates.some(d => 
      daysSince(d) < totalMaturity
    );
    
    if (hasImmatureCohorts) {
      return { type: 'replace_slice' };
    }
    return { type: 'use_cache' };
  }
  
  // Window with latency
  const maturityDays = edge.p.latency.maturity_days;
  return { 
    type: 'partial',
    matureCutoff: daysAgo(maturityDays + 1),  // Re-fetch after this date
  };
}
```

### 4.8 Query-Time vs Retrieval-Time Computation

**Critical distinction:** Some values are pre-computed at retrieval time; others must be computed fresh at query time.

| Value | When Computed | Why |
|-------|---------------|-----|
| `p.forecast` | **Retrieval time** | Stable baseline from mature data; doesn't depend on query window |
| `p.evidence` | **Query time** | Depends on which dates/cohorts fall in query window |
| `p.mean` (blended) | **Query time** | Depends on cohort ages at query time; Formula A (§5.3) runs per-cohort |

**Retrieval-time computation (fetch from source):**

Any fetch from source (manual or overnight batch "fetch all slices") triggers stats computation:

| Stat | Source | Stored On |
|------|--------|-----------|
| `p.forecast` | Mature cohorts in **window() slice only** | Slice in param file |
| `median_lag_days` | `dayMedianTransTimes` from Amplitude response | Slice in param file |
| `completeness` | Computed from cohort ages vs maturity_days | Slice in param file |
| `evidence.n`, `evidence.k` | Raw funnel counts | Slice in param file |

**Critical: `p.forecast` requires window() data.** The forecast baseline is computed from mature cohorts in window() slices (X-anchored, recent events). Cohort() slices (A-anchored) provide per-cohort tracking but NOT `p.forecast`.

**Extension:** If only cohort() data exists, `p.forecast` can be derived by convolving cohort data with the lag distribution (see Appendix C.2). If this fallback is not implemented, show `p.forecast` as unavailable when no window() slice exists.

**Implementation:** `dataOperationsService.getFromSource()` flow — extend transform to compute latency stats from Amplitude response.

**Query-time computation flow:**

```
User selects query window (e.g., cohort(-21d:))
         ↓
Slice stored cohort_data to matching dates
         ↓
For each cohort i in slice:
  - k_i, n_i from stored data
  - a_i = query_date - cohort_date (age TODAY)
  - Apply Formula A (§5.3)
         ↓
Aggregate:
  - p.evidence = Σk_i / Σn_i
  - p.mean = Σk̂_i / Σn_i (where k̂_i includes forecasted tail)
         ↓
Render using scenario visibility mode (E/F/F+E)
```

**Why p.mean must be query-time:**
1. **Query window varies**: User might query last 21 days, last 7 days, specific range
2. **Cohort ages change daily**: A cohort from 1-Dec has age=3 on 4-Dec, age=4 on 5-Dec
3. **Formula A (§5.3) needs current ages**: The tail forecast depends on `F(a_i)` which changes as cohorts mature

**Data flow by query type:**

| Query | Slice Used | p.evidence | p.forecast | p.mean |
|-------|-----------|------------|------------|--------|
| `window()` mature | window_data | QT: Σk/Σn | RT: p.forecast | = evidence |
| `window()` immature | window_data | QT: Σk/Σn | RT: p.forecast | QT: Formula A (§5.3) per day |
| `cohort()` mature | cohort_data | QT: Σk/Σn | RT: p.forecast | = evidence |
| `cohort()` immature | cohort_data | QT: Σk/Σn | RT: p.forecast | QT: Formula A (§5.3) per cohort |
| No usable window baseline (API returns no data even for implicit baseline window) | — | Available | **Not available** | — |
| Non-latency edge | either | QT: Σk/Σn | = evidence | = evidence |

**QT** = Query Time, **RT** = Retrieval Time

#### 5.2.1 Default baseline window when no window() is specified

Graphs must be able to operate **without parameter files**, and users may issue **cohort‑only** queries (no explicit `window()` clause). In those cases, we still need a sensible, recent **window() baseline** for `p.forecast` and `t_{95}`.

**Policy (Phase 1, both with‑file and direct‑from‑source):**

- Whenever we need `p.forecast` for a latency edge under a given interactive DSL, and **no usable window() baseline exists** for that edge + context (no suitable window slice in the registry, or the query is cohort‑only), we construct an implicit **baseline window**:

  - Let `maturity_days` be the edge’s configured maturity (default 30).
  - Define:
    \[
    W_{\text{base}} = \min\big(\max(\text{maturity\_days}, 30\text{d}), 60\text{d}\big)
    \]
    i.e. at least 30 days, at most 60 days.
  - For a query ending at \(T_{\text{query}}\), the implicit baseline slice is:
    \[
    \text{window}(T_{\text{query}} - W_{\text{base}} : T_{\text{query}})
    \]
    with the same context clauses as the current DSL.

- **Flow A (versioned, with files):**
  - If no suitable window slice exists in param files for that edge + context, the **coverage / incremental‑fetch layer**:
    - Uses `calculateIncrementalFetch(paramData, baselineWindow, signature, bustCache, sliceDSL)` to detect missing dates.
    - Uses `getItemsNeedingFetch(window, graph, currentDSL)` and `batchGetFromSource` so Amplitude is hit only for missing dates in this implicit baseline, writing daily data (or `no_data` markers) into the parameter file.

- **Flow B (direct‑from‑source, no files):**
  - The same baseline window is used, but slices may live purely in memory; the statistical steps are identical.

- From the implicit window response (cached or direct), `statisticalEnhancementService`:
  - Aggregates `median_lag_days[]`, `mean_lag_days[]` over the baseline window.
  - Fits the log‑normal lag CDF and derives `t_{95}` for the edge.
  - Computes `p_\infty = p.forecast` from “mature enough” days, with the existing quality gate.
  - If the quality gate fails (too few converters / implausible mean/median), it falls back to `maturity_days` for `t_{95}` as per §4.7.2; `p.forecast` may then be hidden or marked as low‑confidence.

**Phase 1 constraint:** Only when we **cannot** obtain a usable baseline even after applying this implicit window policy (e.g. Amplitude returns no data for the baseline window) do we treat `p.forecast` as unavailable for that edge. In that case F‑only and F+E visibility modes are disabled for the affected edge; evidence‑only rendering remains available.

---

## 5. Inference Engine

### 5.1 Problem Statement

**Core problem:** If typical conversion takes 30 days and we query "last 7 days", we have almost no observed conversions. But \(p \neq 0\)—users simply haven't had time to convert yet. We need to forecast the eventual conversion rate from partial data.

**What we observe:** For each cohort \(i\) (users entering on date \(d_i\)):
- \(n_i\) = cohort size (users who entered)
- \(k_i\) = conversions observed so far
- \(a_i\) = cohort age in days \(= T_{\text{query}} - d_i\)

**What we want:** The expected eventual conversions \(\hat{k}_i\) accounting for users who will convert later.

### 5.2 Survival Analysis Framework

We model conversion as a **survival process** where each user who will eventually convert does so after some lag \(L\). The lag follows a distribution with CDF \(F(t) = P(L \leq t)\).

**Key quantities:**

| Symbol | Meaning |
|--------|---------|
| \(p_\infty\) | Asymptotic conversion probability (long-run rate from mature data) |
| \(F(t)\) | Lag CDF — probability of converting within \(t\) days, given eventual conversion |
| \(S(t) = 1 - F(t)\) | Survival function — probability of NOT YET converting by time \(t\) |

**Observation model:** A user in cohort \(i\) (age \(a_i\)) has not converted if either:
1. They will **never** convert (probability \(1 - p_\infty\)), or
2. They **will** convert but haven't yet (probability \(p_\infty \cdot S(a_i)\))

Therefore:
\[
P(\text{not converted by } a_i) = (1 - p_\infty) + p_\infty \cdot S(a_i) = 1 - p_\infty \cdot F(a_i)
\]

### 5.3 The Forecasting Formula (Formula A)

Using Bayes' rule, the probability that a user who hasn't converted by age \(a_i\) will eventually convert is:

\[
P(\text{eventual} \mid \text{not by } a_i) = \frac{p_\infty \cdot S(a_i)}{1 - p_\infty \cdot F(a_i)}
\]

For cohort \(i\) with \(n_i\) users and \(k_i\) observed conversions, the **expected eventual conversions** are:

\[
\boxed{
\hat{k}_i = k_i + (n_i - k_i) \cdot \frac{p_\infty \cdot S(a_i)}{1 - p_\infty \cdot F(a_i)}
}
\]

**Interpretation:**
- \(k_i\) = already converted (known)
- \(n_i - k_i\) = not yet converted (uncertain)
- The fraction = probability each unconverted user will eventually convert

**Aggregate forecast:**
\[
p_{\text{mean}} = \frac{\sum_i \hat{k}_i}{\sum_i n_i}
\]

#### 5.3.1 Derivation

For completeness, the full derivation using Bayes' rule:

\[
P(\text{eventual} \mid \neg\text{by}_t) = \frac{P(\neg\text{by}_t \mid \text{eventual}) \cdot P(\text{eventual})}{P(\neg\text{by}_t)}
\]

Where:
- \(P(\text{eventual}) = p_\infty\)
- \(P(\neg\text{by}_t \mid \text{eventual}) = S(t) = 1 - F(t)\)
- \(P(\neg\text{by}_t) = (1 - p_\infty) + p_\infty \cdot S(t) = 1 - p_\infty \cdot F(t)\)

Substituting:
\[
P(\text{eventual} \mid \neg\text{by}_t) = \frac{p_\infty \cdot (1 - F(t))}{1 - p_\infty \cdot F(t)}
\]

### 5.4 Lag Distribution Fitting

We fit the lag CDF \(F(t)\) from Amplitude's `dayMedianTransTimes` data. The **log-normal distribution** is a natural choice for conversion lags (multiplicative factors, always positive, right-skewed).

#### 5.4.1 Log-Normal CDF

\[
F(t) = \Phi\left(\frac{\ln t - \mu}{\sigma}\right)
\]

Where \(\Phi\) is the standard normal CDF, and parameters \(\mu, \sigma\) control location and spread.

**Properties:**
- Median: \(e^\mu\)
- Mean: \(e^{\mu + \sigma^2/2}\)
- Mode: \(e^{\mu - \sigma^2}\)

#### 5.4.2 Fitting from Amplitude Data

We have two data points from Amplitude:
1. **Median lag** \(T_{\text{med}}\) from `medianTransTimes`
2. **Mean lag** \(T_{\text{mean}}\) from `avgTransTimes`

From median: \(\mu = \ln(T_{\text{med}})\)

From mean/median ratio:
\[
\frac{T_{\text{mean}}}{T_{\text{med}}} = e^{\sigma^2/2} \implies \sigma = \sqrt{2 \ln\left(\frac{T_{\text{mean}}}{T_{\text{med}}}\right)}
\]

**Fallback:** If only median is available, use \(\sigma = 0.5\) (moderate spread) as a default.

### 5.5 Completeness Measure

**Definition:** The expected fraction of eventual conversions already observed.

For each cohort \(i\):
\[
\text{completeness}_i = F(a_i)
\]

Aggregate (weighted by cohort size):
\[
\text{completeness} = \frac{\sum_i n_i \cdot F(a_i)}{\sum_i n_i}
\]

**Interpretation:**
- 0 = all cohorts brand new, no conversions expected yet
- 1 = all cohorts fully mature, all conversions observed
- 0.7 = expect to have seen 70% of eventual conversions

**Note:** This replaces the naive \(\min(1, a_i / T_{\text{med}})\) approximation with the actual fitted CDF, giving a more accurate estimate.

### 5.6 Asymptotic Probability \(p_\infty\)

The asymptotic conversion rate comes from **mature cohorts** where \(F(a_i) \approx 1\):

\[
p_\infty = \frac{\sum_{i: a_i > T_{95}} k_i}{\sum_{i: a_i > T_{95}} n_i}
\]

Where \(T_{95} = F^{-1}(0.95)\) is the 95th percentile of the lag distribution (time by which 95% of eventual converters have converted).

**Recency weighting (optional):** To favour recent data while maintaining stability:

\[
p_\infty = \frac{\sum_i w_i \cdot k_i}{\sum_i w_i \cdot n_i}
\]

Where \(w_i = e^{-(T - d_i)/H}\) and \(H\) is the recency half-life (default 30 days).

**Effective sample size guard:**
\[
N_{\text{eff}} = \frac{(\sum_i w_i \cdot n_i)^2}{\sum_i w_i^2 \cdot n_i}
\]

If \(N_{\text{eff}} < 100\), widen the window or fall back to unweighted estimate.

### 5.7 Summary: Data Flow

This section summarises **how data moves between Amplitude → param files → graph → UI** for both flows:

- **Flow A (Versioned)** — driven by *pinned DSL*, slices stored in param files, queries answered from cache.
- **Flow B (Direct)** — driven by *current interactive DSL*, slices fetched on demand, no param files required.

In practice, a single user action (e.g. clicking "Get from source" on an edge) may perform **both phases back-to-back**:
- **Retrieval:** call Amplitude, write or refresh slices (Flow A) or work purely in memory (Flow B).
- **Query:** immediately recompute `p.forecast`, `p.mean`, completeness, and `p.latency.t95` for the current interactive DSL, then render.

#### 5.7.1 Flow A – Versioned (Pinned DSL → Param Files → Graph)

```
┌─────────────────────────────────────────────────────────────────────────┐
│                           RETRIEVAL TIME (Flow A)                       │
│  (batch fetch, topologically sorted — upstream edges first)             │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                         │
│  1. Amplitude responses (window(), cohort())                            │
│         ↓                                                               │
│  2. Python adapter (amplitude_to_param.py)                              │
│     - Extract per-slice arrays:                                         │
│         • window(): dates, n_daily, k_daily, latency.{median,mean,t95,  │
│                    histogram}, forecast                                  │
│         • cohort(): dates, n_daily, k_daily, median_lag_days[],         │
│                    mean_lag_days[], anchor_*, latency, anchor_latency   │
│         ↓                                                               │
│  3. Store to PARAM FILE (values[]) — query-independent raw + summary    │
│         ↓                                                               │
│  4. (Optional) After batch completes: TS computes path_t95 in memory    │
│     - Uses persisted p.latency.t95 per edge                             │
│     - Result is transient (per query/scenario), not written to file     │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────────┐
│                            QUERY TIME (Flow A)                          │
│  (user changes window, context, etc.; answers from param cache)        │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                         │
│  1. dataOperationsService:                                              │
│     - Resolve which slices (window/cohort) match current DSL           │
│     - Load slices from Param Registry via sliceDSL                     │
│         ↓                                                               │
│  2. statisticalEnhancementService (TS):                                 │
│     - From slices: aggregate median/mean lag, fit CDF, compute t95     │
│     - Update p.latency.t95 on ProbabilityParams as needed              │
│     - Apply Formula A per cohort → p.mean, completeness                │
│         ↓                                                               │
│  3. UI render: bead, tooltip, edge layers                               │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘
```

#### 5.7.2 Flow B – Direct (Interactive DSL → Amplitude → Graph Only)

```
┌─────────────────────────────────────────────────────────────────────────┐
│                        DIRECT GET-FROM-SOURCE (Flow B)                 │
│      (any interactive fetch that hits Amplitude, single edge or many)  │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                         │
│  1. Current interactive DSL (cohort()/window(), contexts, cases)       │
│         ↓                                                               │
│  2. Amplitude adapter (TS/Python):                                      │
│     - Issue window()/cohort() calls needed for THIS query only         │
│         ↓                                                               │
│  3. statisticalEnhancementService (TS, ephemeral):                      │
│     - From window(): fit log-normal, compute t95, p_∞                  │
│     - From cohort(): apply Formula A → p.mean, completeness            │
│     - Populate p.latency.t95 and scalar probabilities on the graph     │
│         ↓                                                               │
│  4. UI render: bead, tooltip, edge layers                               │
│                                                                         │
│  (Optional, outside core Flow B):                                       │
│     - The caller MAY choose to write the fetched slices into param     │
│       files for reuse, but this is a separate, explicit step.          │
└─────────────────────────────────────────────────────────────────────────┘
```

### 5.8 Storage Architecture

**Source of truth — Param files (query-independent):**

| Data | Location | Notes |
|------|----------|-------|
| `n_daily[]`, `k_daily[]` | `values[]` | Per-cohort raw counts |
| `median_lag_days[]`, `mean_lag_days[]` | `values[]` | Per-cohort lag stats |

These are the raw Amplitude data. NOT aggregated — contains all dates, all contexts per slice. Param files are shared across queries.

**Query-context latency values — ProbabilityParam `p.latency`:**

Produced by the latency/forecast service from per-cohort arrays for the **current query**:

| Field | Persistence | Notes |
|-------|-------------|-------|
| `t95` | **Persisted** (per ProbabilityParam) | 95th percentile lag for this edge under the pinned DSL. Used for caching and optional UI. |
| `mu`, `sigma` | Transient | CDF params for current query window (internal to forecast service). |
| `empirical_quality_ok` | Transient | Quality gate (k≥30, ratio in range). |
| `path_t95` | Transient, per scenario | Scenario-aware cumulative A→X maturity (depends on active edges). Not written to graph JSON. |

**Computed at query time (edge probabilities, persisted for pinned DSL):**

These values are computed from the current query window but then written back to the graph (and, for versioned flows, to the corresponding `values[]` entries) so that the pinned DSL view is reconstructible:

| Field on Graph | Param File | Notes |
|----------------|-----------|-------|
| `edge.p.mean` | `values[].mean` | Blended probability (Formula A) for pinned DSL |
| `edge.p.evidence.completeness` | `values[].completeness` | Completeness for pinned DSL (display only) |

At runtime they are still recomputed when the interactive DSL changes; the persisted values are cache/convenience, not a separate source of truth.

**Query-time aggregation of lag stats:**

When computing `mu`, `sigma`, `t95` for a specific query window, aggregate from per-cohort arrays:

```python
def aggregate_lag_stats(cohorts_in_window):
    """
    Compute weighted mean and approximate median for query window.
    Weights by k (converters) since lag is only observed for converters.
    """
    total_k = sum(c.k for c in cohorts_in_window)
    if total_k == 0:
        return None, None  # No converters → no lag data
    
    # Weighted mean of means (mathematically correct)
    agg_mean = sum(c.k * c.mean_lag_days for c in cohorts_in_window) / total_k
    
    # Weighted "median" (approximation: median of medians weighted by k)
    # Note: true median would require individual event times
    agg_median = sum(c.k * c.median_lag_days for c in cohorts_in_window) / total_k
    
    return agg_median, agg_mean

# Then derive CDF params:
# mu = ln(agg_median)
# sigma = sqrt(2 * ln(agg_mean / agg_median))
```

**Why this separation:**

- **Param file** = raw data, query-independent, shared across graphs
- **Graph file** = query context + computed results for that context
- Computed fields on graph naturally invalidate when query changes
- No "transient in-memory only" complexity — just standard save/load

> **Optional UI enhancement (deferred):** The UI *may* grey-out latency displays when cohort/sample size is below a configured threshold (e.g. \(n < 100\) or \(k < 10\)). This is a nice-to-have visual cue and **not** part of the core MVP scope.

### 5.9 Get-from-Source Flows: Versioned vs Direct

This section describes **when** we call Amplitude, **what** is computed at each step, and **where** data is stored, for two key flows:

- **(A) Versioned get-from-source** – uses *pinned DSL* to pre-fetch and store slices in param files (overnight or on demand), then answers interactive queries from the cache.
- **(B) Direct get-from-source** – bypasses param files and computes everything from Amplitude responses for the **current interactive query DSL**.

#### 5.9.1 Flow A – Versioned Get-from-Source (via Param Files)

This flow is driven by the **pinned DSL** on the graph. It has two phases: **fetch & version** (into param files) and **interactive query** (using current query DSL).

**Phase A1 – Fetch & version slices (pinned DSL → param files):**

```
┌─────────────────────────────────────────────────────────────────────────┐
│  Graph (Pinned DSL)                                                    │
│    - latency edges mark which edges need dual slices                   │
│    - pinned DSL includes cohort(...) and/or window(...) clauses        │
│         │                                                              │
│         ▼                                                              │
│  Slice Planner (TS / UpdateManager + dataOperationsService)           │
│    - Expand pinned DSL → canonical sliceDSLs (§4.7.1)                  │
│      • For each latency edge & context combo (ordered):                │
│          - window slice: window(abs_start:abs_end)                     │
│              (fetch window() FIRST to establish baselines)             │
│          - cohort slice: cohort(anchor_id, abs_start:abs_end)         │
│    - For batch jobs, edges/slices are processed in **topological**     │
│      order (upstream edges first) so A→X window baselines exist        │
│      before downstream edges need them (§3.8).                         │
│         │                                                              │
│         ▼                                                              │
│  Amplitude Adapter (Python: amplitude_to_param.py)                     │
│    - For each canonical sliceDSL:                                      │
│      • window(): edge-local dayFunnels + lag stats                     │
│      • cohort(): A-anchored dayFunnels (where required)                │
│    - Writes param JSON:                                                │
│      • dates[], n_daily[], k_daily[]                                   │
│      • median_lag_days[], mean_lag_days[] (from Amplitude ms fields)   │
│      • data_source metadata (retrieved_at, API params)                 │
│         │                                                              │
│         ▼                                                              │
│  Param Registry (IndexedDB / files)                                    │
│    - Stores slices keyed by sliceDSL                                   │
│    - Versioned by retrieved_at                                        │
└─────────────────────────────────────────────────────────────────────────┘
```

**Phase A2 – Interactive query (current query DSL → param slices → forecast):**

```
┌─────────────────────────────────────────────────────────────────────────┐
│  Graph Editor (UI)                                                     │
│    - Maintains current interactive query DSL (not the pinned DSL)      │
│    - User adjusts window(), contexts, etc.                             │
│         │                                                              │
│         ▼                                                              │
│  dataOperationsService / fetchDataService (TS)                         │
│    - For each edge in current view:                                    │
│      • Resolve whether edge uses cohort() or window() semantics        │
│        (per §4.6, §4.7).                                               │
│      • Look up matching slices in Param Registry via sliceDSL.         │
│      • If a latency edge requires `p.forecast` and **no usable         │
│        window() baseline** exists for its edge/context:                │
│        - Construct an implicit baseline window                         │
│          `window(T_query - W_base : T_query)` using                     │
│          `W_base` from §5.2.1 (clamped between 30d and 60d).           │
│      • Use the existing incremental‑fetch utility                       │
│        `calculateIncrementalFetch(paramData, window, signature,        │
│        bustCache, sliceDSL)` (from `windowAggregationService`) to      │
│        detect **date‑level gaps** for both explicit and implicit       │
│        window() slices.                                                │
│      • Use `getItemsNeedingFetch(window, graph, currentDSL)` to        │
│        build a `FetchItem[]` of parameters/cases (including latency    │
│        edges) that have `needsFetch === true`.                         │
│      • Call `batchGetFromSource` / `getFromSource` so that Amplitude   │
│        is only hit for **missing dates**, writing new data (or         │
│        explicit `no_data` markers) back into parameter files.          │
│      • After batch fetch completes, recompute per‑edge `p.latency.t95` │
│        from the updated window() slices, then run                      │
│        `compute_path_t95_for_all_edges` (§4.7.2) over the              │
│        scenario‑effective graph to obtain `path_t95` for caching and   │
│        completeness decisions.                                         │
│         │                                                              │
│         ▼                                                              │
│  statisticalEnhancementService (TS)                                    │
│    - For latency edges with both slices available:                     │
│      1) From window() slice (edge-local view):                         │
│         • Aggregate median_lag_days[], mean_lag_days[] over chosen     │
│           history window                                               │
│         • Fit log-normal: mu, sigma → F(t), S(t), T_95                 │
│         • Compute p_∞ from \"mature enough\" windows                   │
│      2) From cohort() slice (A-anchored view):                         │
│         • Extract n_i, k_i, a_i for cohorts in the current query       │
│         • Apply Formula A with p_∞ and F(a_i)                          │
│         • Aggregate p.mean and completeness (§5.3–§5.6)                │
│      3) Write summary stats into p.latency for this edge:              │
│         • t95 (from window())                                          │
│         • baseline p_infinity (from window())                          │
│         • p_mean, completeness (window+cohort)                         │
│      4) Keep mu, sigma, empirical_quality_ok, path_t95 transient       │
│         │                                                              │
│         ▼                                                              │
│  Graph JSON / IndexedDB                                                │
│    - Stores p.latency.{maturity_days, anchor_node_id, t95}             │
│    - Tagged against the current query DSL                              │
└─────────────────────────────────────────────────────────────────────────┘
```

**Key properties of Flow A:**

- **Pinned DSL** shapes what slices exist in param files; it does *not* define the interactive query.
- **Current query DSL** drives which slices are read and how they are aggregated.
- **window() slices** provide early, edge-local evidence for \(p_\infty\) and lag shape.
- **cohort() slices** provide the A-anchored exposures for the current query.
- All heavy per-cohort calculations (Formula A) are ephemeral; only scalars are written back to the graph.

#### 5.9.2 Flow B – Direct Get-from-Source (Bypass Param Files)

This flow answers an interactive query **even when no param files exist** (or when the user explicitly bypasses the cache). It may use **window()**, **cohort()**, or **both**, depending on the current interactive DSL; it does **not** require slices to be persisted or written back to param files.

**Single-edge direct query (no param files required):**

```
┌─────────────────────────────────────────────────────────────────────────┐
│  1. Current interactive query DSL                                      │
│     - Cohort DSL: cohort(A, rel_start:rel_end)[.context(...)]          │
│     - Window DSL: window(rel_hist_start:rel_hist_end)[.context(...)]   │
│       (derived from the same graph + query, not from pinned DSL)       │
├─────────────────────────────────────────────────────────────────────────┤
│  2. Amplitude calls (as required)                                      │
│     - If interactive DSL includes window(...):                         │
│         • window() call → edge-local dayFunnels + lag stats over hist.│
│     - If interactive DSL includes cohort(...):                         │
│         • cohort() call → A-anchored cohorts n_i, k_i, ages a_i       │
├─────────────────────────────────────────────────────────────────────────┤
│  3. Ephemeral computation in statisticalEnhancementService             │
│     From window() (edge-local behaviour, if present):                  │
│       • Aggregate median_lag_days, mean_lag_days over chosen history   │
│       • Fit log-normal: mu, sigma, derive T_95                         │
│       • Compute p_∞ from \"mature\" windows (age > T_95, or rule)     │
│     From cohort() (A-anchored exposures, if present):                  │
│       • For each cohort i: n_i, k_i, a_i                               │
│       • Compute F(a_i), S(a_i) from mu, sigma                          │
│       • Apply Formula A → k̂_i                                         │
│     Aggregate:                                                         │
│       • p_mean = Σk̂_i / Σn_i                                          │
│       • completeness = Σ(n_i × F(a_i)) / Σn_i                          │
├─────────────────────────────────────────────────────────────────────────┤
│  4. Graph-only update                                                  │
│     - Populate p.latency on the ProbabilityParam for this DSL          │
│       (t95, p_mean, completeness); no param files are written in this  │
│       core direct-from-source flow                                      │
└─────────────────────────────────────────────────────────────────────────┘
```

**Direct-from-source limitations (vs fully versioned Flow A):**

| Capability | Behaviour |
|-----------|-----------|
| `path_t95` | Can only be computed reliably when multiple edges have up-to-date window() baselines; in purely ad hoc direct queries we may skip or approximate it. |
| Cross-edge consistency | Full path-level maturity and cache decisions work best when the same pinned DSL has been used to pre-populate param files for all edges. |
| Historical comparison | Direct queries can compare windows within the Amplitude response, but cannot use long-lived, versioned slices without param files. |

In both flows, **Formula A’s correctness does not depend on param files**: param files and graph fields are caches of raw slices and small summary stats, not extra sources of truth.

### 5.10 Aggregation over Multiple Slices / Contexts

User queries frequently span **multiple stored slices** (e.g. `contextAny(channel)` or multi-value context filters). Aggregation over these slices must be **mathematically consistent** with Formula A (§5.3).

**Notation:**

- Let \\(T\\) be the query date.
- Let \\(\\mathcal{R}\\) be the set of all **matching rows** in the parameter file after DSL explosion and slice filtering (each row corresponds to one `sliceDSL` – e.g. a specific context combination).
- Within each row \\(r \\in \\mathcal{R}\\), let cohorts be indexed by \\(j\\) with:
  - Cohort date \\(d_{r,j}\\)
  - Size \\(n_{r,j}\\)
  - Observed conversions \\(k_{r,j}\\)
  - Age \\(a_{r,j} = (T - d_{r,j})\\) in days
- Let \\(\\mathcal{C} = \\{(r, j) : r \\in \\mathcal{R}\\}\\) be the **flattened set of all cohorts** across all matching slices.

**Aggregated evidence (all slices):**

- Total volume:
  \\[
  N_{\\text{total}} = \\sum_{(r,j) \\in \\mathcal{C}} n_{r,j}
  \\]
- Total observed conversions:
  \\[
  K_{\\text{obs}} = \\sum_{(r,j) \\in \\mathcal{C}} k_{r,j}
  \\]
- Aggregated evidence probability:
  \\[
  p_{\\text{evidence, agg}} = \\frac{K_{\\text{obs}}}{N_{\\text{total}}}
  \\]

This is exactly the MLE for a **shared Bernoulli rate** across all included contexts, and matches current behaviour for summing evidence variables.

**Aggregated forecast baseline `p.forecast`:**

Using the same maturity threshold \\(m = \\text{maturity\\_days}\\), define:

- Mature cohorts:
  \\[
  \\mathcal{C}_{\\text{mature}} = \\{(r,j) \\in \\mathcal{C} : a_{r,j} \\ge m\\}
  \\]
- Aggregated mature counts:
  \\[
  N_{\\text{mature}} = \\sum_{(r,j) \\in \\mathcal{C}_{\\text{mature}}} n_{r,j}, \\qquad
  K_{\\text{mature}} = \\sum_{(r,j) \\in \\mathcal{C}_{\\text{mature}}} k_{r,j}
  \\]
- Aggregated forecast baseline:
  \\[
  p_{\\text{forecast, agg}} =
    \\begin{cases}
      \\dfrac{K_{\\text{mature}}}{N_{\\text{mature}}}, & N_{\\text{mature}} > 0 \\\\
      p_{\\text{prior}}, & N_{\\text{mature}} = 0
    \\end{cases}
  \\]

In implementation terms: **do not** average per-slice `p.forecast` values. Instead, pool all mature cohorts across slices and recompute `p.forecast` from the underlying \\(n,k\\). A per-slice weighted average is acceptable only if weights are the mature \\(n\\) used to compute each slice-level `p.forecast`, which is algebraically identical to the pooled estimator above.

**Aggregated blended probability `p.mean`:**

For each cohort \\(c = (r,j) \\in \\mathcal{C}\\), apply Formula A (§5.3):

- If \\(a_c \\ge m\\) (mature): \\(\\hat{k}_c = k_c\\)
- If \\(a_c < m\\) (immature):
  \\[
  \\hat{k}_c = k_c + (n_c - k_c) \\times p_{\\text{forecast, agg}}
  \\]

Then:

- Total forecasted conversions:
  \\[
  K_{\\text{hat, total}} = \\sum_{c \\in \\mathcal{C}} \\hat{k}_c
  \\]
- Aggregated blended probability:
  \\[
  p_{\\text{mean, agg}} = \\frac{K_{\\text{hat, total}}}{N_{\\text{total}}}
  \\]

This is exactly equivalent to **flattening all cohorts from all contexts into a single list and applying Formula A (§5.3) once**. It is invariant to how cohorts are grouped into slices and therefore mathematically well-defined for:

- Multiple context values (e.g. `contextAny(channel)`)
- Multiple explicit context filters (e.g. `or(context(channel:google), context(channel:fb))`)
- Any combination of matching `sliceDSL` rows.

**Window-based queries:** For `window()` slices on latency edges, apply the same rules, treating each `(row, date)` pair as a "cohort" with `n_{r,t}`, `k_{r,t}`, and age defined relative to event date instead of cohort-entry date. The aggregation formulas above still hold; only the definition of \\(a_{r,\\cdot}\\) changes.

### 5.11 Scenarios and External Data Conditioning

Scenarios (cases and `conditional_ps`) define **which edges and parameters are active**, but they do **not** automatically create new external data segments. Conditioning of external data is only introduced where the user has explicitly modelled it.

**Scenario‑effective graph:**

- A scenario overlay (case variants, conditional branches) produces an **effective graph**:
  - Same nodes and potential edges as the base graph.
  - Some edges are **active** (used in this scenario) with specific parameter bindings.
  - Some edges are **inactive** (probability zero / not taken in this scenario).
- All latency calculations that depend on graph structure (e.g. A→X total maturity in §4.7.2) operate on this **scenario‑effective edge set**:
  - Only active edges contribute to `path_t95`.
  - Conditional branches with their own latency configs only affect maturity when they are active.

**External data (Amplitude) conditioning:**

- External data (window()/cohort() slices from Amplitude) is segmented **only** where we have explicit model structure for it:
  - Separate parameters / edges / contexts for different segments (e.g. `visited(d)` vs not).
  - Corresponding `sliceDSL` values that encode those conditions.
- Scenarios do **not** implicitly create new Amplitude segments; they only **select between existing parameters and slices**:
  - If the user cares about “visited(d) vs not” having different behaviour, they must introduce separate params/edges/sliceDSLs for those segments.
  - When a scenario activates a particular branch, latency and `p.forecast` for that branch are read from the slices attached to that branch’s param.
  - Downstream edges use whatever slices exist for their own params; they are **parameter‑aware**, not automatically scenario‑conditioned.

**Implications:**

- **A→X maturity and cache policy** are **scenario‑aware**:
  - They use only scenario‑active edges and their latency stats.
  - Conditional branches with different lags influence maturity only when chosen.
- **Downstream external behaviour** (e.g. X→Y lag and baseline) is:
  - Based on the slices defined for that edge’s parameters.
  - Scenario‑aware only to the extent that scenarios choose between parameters/slices the user has explicitly modelled.
- This avoids an uncontrolled combinatorial explosion of external data requirements, while still letting users model segments they actively care about as **first‑class parameters**.

### 5.12 Sibling Edge Probability Constraints

**Problem:** For sibling edges (multiple outgoing edges from the same node), probabilities must sum to ≤ 1. Formula A (§5.3) applies independently to each edge, which can cause `Σ p.mean > 1` as a forecasting artefact.

**Why this happens:** Formula A (§5.3) treats the "remaining pool" `(n_i - k_i)` as potential converters for THIS edge, without accounting for conversions on sibling edges. When siblings compete for the same pool, forecasts can double-count.

**Analysis by configuration:**

| Case | Description | Constraint Preserved? |
|------|-------------|----------------------|
| **(a) Both parameterised** | Both siblings have data-driven p.mean | **May exceed 1** — forecasting artefact |
| **(b) One parameterised, one rebalanced** | Derived edge = 1 - p.mean of parameterised | **Always valid** — rebalancing absorbs artefact |
| **(c) Neither parameterised** | Both manually specified | **Always valid** — no forecasting involved |

**Case (a) handling:**

For siblings where both have `maturity_days > 0` and data-driven probabilities:

1. **p.evidence is always valid:** `Σ p.evidence ≤ 1` by construction (observed k cannot exceed n across siblings)

2. **p.mean may exceed 1:** This is a forecasting artefact, not an error. The excess correlates with cohort immaturity.

3. **Warning policy:**
   - `Σ p.mean > 1.0` AND `Σ p.evidence ≤ 1.0`: **Info-level** — forecasting artefact, expected for immature data
   - `Σ p.evidence > 1.0`: **Error** — data inconsistency (should not happen)

4. **DAG runner behaviour:**
   - For flow calculations, use `p.evidence` (always valid) or apply sibling normalisation to `p.mean`
   - Visual rendering uses `p.mean` (shows forecast)

**Case (b) handling:**

When one sibling is derived by rebalancing (e.g., "Other" or "Exit" edge):
- Derived edge uses: `p.mean_derived = 1 - Σ p.mean_parameterised`
- This automatically absorbs any forecasting artefact
- Constraint is always satisfied by construction

**Case (c) handling:**

For manually-specified edges with no data fetch:
- `p.mean = p.evidence = manual_value`
- No forecasting, no artefact
- User is responsible for ensuring valid probabilities

**Mathematically sound warning threshold:**

The maximum artefact is bounded by the immature portion of the data. A reasonable threshold for informing (not warning) the user:

```
expected_artefact ≈ (1 - completeness) × max(0, Σ p.forecast - 1)
```

If `Σ p.mean - 1 > expected_artefact × 1.5`, show info message indicating forecasting artefact is larger than expected.

### 5.11 Put to File Behaviour in Aggregate Views

**Principle:** "Put to file" is **never disabled**. A param file existing means the operation is always available; it is not conditional on slice count or aggregation status.

**Behaviour when current view is an aggregate over multiple slices** (e.g. `contextAny(...)`, multiple `context(...)` combinations):

1. **CONFIG/metadata: always written.**
   - Latency config (`maturity_days`, `anchor_node_id`)
   - Edge-level metadata (`query`, `n_query`, etc.)
   - These are top-level fields, not per-slice, so aggregation status is irrelevant.

2. **VALUES (`values[]` rows): gracefully skipped with warning.**
   - The aggregated `p.mean`, `p.evidence`, `p.forecast` are **query-time derived views** over multiple underlying `sliceDSL` rows.
   - Writing them back would require choosing which `values[]` row(s) to mutate, which is ambiguous and risks data corruption.
   - Instead:
     - Skip the value write.
     - Show a **warning toast**: "Aggregated view — values not written. Narrow to a single context/slice to persist probability values."
   - The operation completes successfully (for CONFIG); it is not an error.

3. **Single-slice view: normal behaviour.**
   - When exactly one `sliceDSL` row contributes to the current view, "Put to file" writes both CONFIG and VALUES to that row as usual.

**Detection:** Use the same `isMultiSliceAggregation` / `hasContextAny(currentQueryDSL)` flags already computed in `dataOperationsService` and `sliceIsolation`.

**UI implication:** The "Put to file" button remains **always enabled**; the conditional behaviour is purely in the write path and communicated via toast, not by greying out controls.

---

### 5.12 Advanced Inference (Optional)

> **Optional:** Full Bayesian hierarchical models and posterior summaries extend the core framework. See **Appendix C** for details.

---

## 6. DAG Runner Integration

**Current behaviour:** The runner uses `p.mean` (the blended evidence+forecast probability from Formula A) as a scalar, treating conversions as instantaneous. Latency information is displayed but not used in forward-pass calculations.

**Future extension:** Time-indexed forward passes with latency convolution and Monte Carlo uncertainty. See **Appendix C.4** for the time-aware runner design.

---

## 7. UI Rendering

### 7.1 Mature vs Forecast Edge Layers

Render edges with **two concentric layers** (similar to confidence bands):

```
Cross-section of edge:

        ┌───────────────────────────────┐
        │ ╱ ╱ ╱ OUTER (forecast) ╱ ╱ ╱ │  ← Striped (offset pattern)
        ───────────────────────────────
        │///////// INNER ///////////// │  ← Striped (same width, offset)
        │/////////(mature)///////////// │
        ───────────────────────────────
        │ ╱ ╱ ╱ ╱ ╱ ╱ ╱ ╱ ╱ ╱ ╱ ╱ ╱ ╱ │
        └───────────────────────────────┘

When both layers overlap, offset stripes combine to appear SOLID.
```

**Layer structure:**
- **Inner layer**: Width = mature evidence weight, striped pattern A
- **Outer layer**: Width = total (mature + forecast) weight, striped pattern B (same stripe width, offset by half)
- **Combined effect**: Where both layers overlap → stripes interleave → appears solid

**Visual result:**
- Solid core = mature (evidence-based)
- Striped margin = forecast (projected from mature p)
- Ratio immediately visible: wide solid core = high maturity coverage

**Implementation in `ConversionEdge.tsx`:** 
- Stripe angle: **45°** (opposite direction from existing "partial display" stripes)
- Stripe width: Match existing stripe width in partial display logic
- Stripe colour: **Unchanged** from current edge colour
- Inner layer: stripe offset = 0
- Outer layer: stripe offset = half stripe width
- Where both present: visual interference creates solid appearance
- Where only outer present: stripes visible = forecast region

**Reference:** Existing partial display stripe logic in `ConversionEdge.tsx` — use same width/styling but opposite angle.

### 7.2 Edge Data Model for Rendering

Edge needs to expose three probability values for rendering:

```typescript
interface EdgeLatencyDisplay {
  // Core probability values (computed at query time)
  p: {
    evidence: number;        // Observed k/n from query window
    forecast: number;        // Mature baseline (from window slice, retrieval time)
    mean: number;            // Blended: evidence + forecasted tail (Formula A, §5.3)
  };
  
  // For completeness badge
  completeness: number;      // 0-1 maturity progress (see §5.5)
  
  // For tooltips
  median_lag_days?: number;  // From dayMedianTransTimes
  
  // Data provenance (for tooltip)
  evidence_source?: string;  // sliceDSL that provided evidence
  forecast_source?: string;  // sliceDSL that provided p.forecast
}
```

**Value semantics:**

| Field | Meaning | When Computed | Stored? |
|-------|---------|---------------|---------|
| `p.evidence` | Observed k/n from query window | Query time | No |
| `p.forecast` | Forecast absent evidence (mature baseline) | Retrieval time | Yes, on slice |
| `p.mean` | Evidence + forecasted tail (Formula A, §5.3) | Query time | No |

**Rendering by visibility mode:**

| Mode | Render | Width Source |
|------|--------|--------------|
| E only | Solid edge | `p.evidence` |
| F only | Striped edge | `p.forecast` |
| F+E | Solid inner + striped outer | Inner: `p.evidence`, Outer: `p.mean` |

**Key insight:** In F+E mode, the striped outer uses `p.mean` (evidence-informed forecast), NOT `p.forecast` (which ignores evidence). The visual width of the striped-only portion is `p.mean - p.evidence`.

### 7.3 Per-Scenario Visibility (E/F/F+E)

Evidence/Forecast visibility is **per-scenario**, not graph-wide. This allows comparing a "forecast only" scenario vs "evidence only" scenario side-by-side.

**4-State Cycle on Scenario Chips:**

| State | Icon | Chip Visual | Meaning |
|-------|------|-------------|---------|
| F+E | `<Eye>` (Lucide) | Gradient: solid→striped L→R | Show both layers |
| F only | `<View>` (Lucide) | Striped background | Forecast only |
| E only | `<EyeClosed>` (Lucide) | Solid background | Evidence only |
| Hidden | `<EyeOff>` (Lucide) | Semi-transparent (existing) | Not displayed |

**Behaviour:**
- Click eye icon to cycle through all 4 states:
  ```
  F+E → F → E → hidden → F+E → ...  (repeats)
  ```
- "Hidden" hides the scenario entirely; next click brings it back as F+E
- Per-tab state (stored on `tab.editorState.scenarioState`, consistent with existing visibility)
- Default: **F+E** (show both)
- Tooltip on icon shows current state with visual key
- Toast feedback on state change ("Showing forecast only")
- Same treatment on scenario palette swatches

**If p.forecast unavailable** (no window data pinned):
- F and F+E states disabled/greyed on that scenario
- Cycle only: E → hidden → E

**Confidence bands by mode:**

| Mode | CI Shown On |
|------|-------------|
| E only | Evidence (solid portion) |
| F only | Forecast (striped portion) |
| F+E | Striped portion only (forecast uncertainty) |

Extend existing CI rendering logic; ensure stripes render within CI band.

### 7.4 Edge Bead: Latency Display

A new bead displays latency information on edges with `latency.maturity_days > 0`:

| Property | Value |
|----------|-------|
| Position | **Right-aligned** on edge (new bead position) |
| Format | **"13d ±3 (75%)"** — median lag ± σ + completeness (see §5.5) |
| Show when | `latency.maturity_days > 0` AND `median_lag_days > 0` |
| Colour | Standard bead styling (no new colour) |

**Geometry / positioning considerations:**

- Existing **left-aligned** beads already use face curvature metadata (`node.data.faceDirections`) and edge offsets to place beads cleanly on **convex node faces** (see `ConversionEdge.tsx`):
  - They compute a `visibleStartOffset` based on:
    - the perpendicular inset from the node face,
    - whether the face is marked `convex` or `concave`,
    - the edge’s offset along that face (centre vs near corners),
  - and then place beads along a hidden path that follows the rendered edge/ribbon.
- The **new right-aligned latency bead** must mirror this care on the **inbound node face**:
  - Use the same `faceDirections` metadata for the **target** node (concave/convex) and its `targetFace`.
  - Adjust the bead’s along-path offset so that it:
    - clears concave insets at the target face,
    - remains visually separated from the node border, even when the edge curves sharply into a concave face,
    - remains consistent with left-aligned bead spacing when multiple beads are present.
- Implementation detail: `EdgeBeadsRenderer` should be driven by a single, well-defined `visibleStartOffset` API that already accounts for node face convexity/concavity on the relevant end (source for left beads, target for right beads), rather than hard-coded magic numbers at call sites.

### 7.5 Window Selector: Cohort/Window Mode

Users must be able to switch between `cohort()` and `window()` query modes.

**Design:**

Toggle at the left of the WindowSelector component (before presets):

```
<ToggleLeft> Cohort  [Today] [7d] [30d] [90d]  1-Nov-25 → 30-Nov-25  [+Context]

<ToggleRight> Window [Today] [7d] [30d] [90d]  1-Nov-25 → 30-Nov-25  [+Context]
```

| Element | Design |
|---------|--------|
| Position | Leftmost element in WindowSelector, before preset buttons |
| Control type | Toggle switch (not dropdown) |
| Left state | Cohort mode |
| Right state | Window mode |
| Icons | `<ToggleLeft>` / `<ToggleRight>` (Lucide) |
| Label | "Cohort" or "Window" text right of toggle icon |
| Default | Cohort (toggle left) |

**Behaviour:**

- Switching modes changes DSL: `cohort(start:end)` ↔ `window(start:end)`
- Date range preserved on switch
- Triggers re-fetch if data for new mode not cached

**Context chip:** Also displays current mode as secondary indicator.

**Rationale:** The cohort/window distinction is conceptually important (entry dates vs event dates) but not self-explanatory. An explicit, labelled toggle makes the active mode obvious and avoids confusion about why the same date range produces different numbers.

### 7.6 Tooltips: Data Provenance

Current tooltips (see `ConversionEdge.tsx`) already present **per-param** details in a structured way:

- Base probability: `e.<edgeId>.p`
- Each conditional: `e.<edgeId>.<condition>.p`

Example (simplified structure):

```
e.signup->activate.p
  37.5% ±5.0
  n=1000 k=375
  1-Jan-25 to 31-Jan-25
  source: cohort(1-Jan-25:31-Jan-25)
  query: from(signup).to(activate)

e.signup->activate.context(channel:fb).p
  42.0% ±6.2
  n=400 k=168
  1-Jan-25 to 31-Jan-25
  source: cohort(1-Jan-25:31-Jan-25).context(channel:fb)
  query: from(signup).to(activate).context(channel:fb)
```

For **latency edges**, we extend each `p` block with latency-specific lines:

- `lag: <median_lag_days>d (slice: <sliceDSL>)`
- `completeness: <X>% (slice: <sliceDSL>)`
- Optionally, when helpful: `baseline: <p.forecast>% (window slice: <sliceDSL>)`

**Key requirement:** For every number shown (evidence, forecast, blended, completeness, lag), make it clear:

- Which **probability param** it belongs to (`e.edgeId.p` vs `e.edgeId.condition.p`).
- Which **sliceDSL** (cohort/window) supplied it (via `evidence.source` / window bounds).

### 7.7 Properties Panel: Latency Settings

Latency configuration fields are added to `ParameterSection` component — the shared component used for **both** regular probability (`p`) and conditional probability (`conditional_p`) params.

**Location:** New fields below Distribution dropdown, before Query Expression Editor.

**Implementation:** Modify `graph-editor/src/components/ParameterSection.tsx` — adding latency fields here automatically applies them to all probability param UIs (regular and conditional).

| Field | Type | Maps to | Override flag |
|-------|------|---------|---------------|
| Track Latency | Checkbox | `p.latency.maturity_days` (0 vs >0) | `maturity_days_overridden` |
| Maturity Days | Number input (shown when enabled) | `p.latency.maturity_days` | `maturity_days_overridden` |

**Semantics:**
- Checkbox **unchecked**: `maturity_days = 0` (latency tracking disabled)
- Checkbox **checked**: `maturity_days > 0` (latency tracking enabled), shows Maturity + Recency fields

**New fields to add** (insert after Distribution dropdown, before Query Expression Editor):
```
[✓] Track Latency
    Maturity: [30] days
```

When checkbox unchecked, Maturity row is hidden.

**Default inference when enabling:**
When user checks "Track Latency" on an edge that has data:
1. Look for `median_lag_days` in edge data (if previously fetched)
2. If found, suggest `maturity_days = ceil(median_lag_days × 2)` (capped at 90)
3. If not found, default to 30 days

This is a **frontend-only** convenience — the backend doesn't infer defaults.

**Scope:** Applies to ALL probability params via `ParameterSection`:
- Regular `p` (edge probability)
- `conditional_p[*]` entries (via `ConditionalProbabilityEditor` which uses `ParameterSection`)
- **NOT** cost params (`cost_gbp`, `cost_time`) — these don't have latency

**Note:** These are configuration settings, not read-only displays. Derived values (completeness, median_lag_days) are shown via edge bead and tooltip.

---

## 8. Analytics Extensions (Separate Delivery)

> **Note:** These features extend the Analytics panel and are **not required for core latency functionality**. They should be implemented as a separate phase after core delivery.

### 8.1 Data Requirements for Analytics

Analytics outputs must distinguish mature vs forecast data **explicitly in the data model**, not via styling:

```yaml
# In analysis.yaml output or tabular export
edge_latency_analysis:
  edge_id: "household-to-switch"
  
  # Aggregate stats
  p_estimate: 0.079
  p_source: "mature"  # or "prior" if no mature data
  median_lag_days: 7.1
  
  # Breakdown by maturity
  mature:
    n: 1200
    k: 95
    p: 0.079
  immature:
    n: 582
    k_observed: 12
    k_forecast: 46  # = 582 * 0.079
  
  # Per-cohort detail (for tabular export)
  cohorts:
    - date: "1-Sep-24"
      n: 15
      k: 0
      is_mature: true
      median_lag_days: null
    - date: "25-Oct-24"
      n: 80
      k: 3
      is_mature: false
      k_forecast: 6.3
```

### 8.2 Potential Analytics Panel Features

**Cohort Maturity Table:**
- Per-cohort n, k, p, maturity status
- Tabular export with explicit `is_mature` and `k_forecast` columns
- No reliance on styling to distinguish observed vs forecast

**Completion Curve Chart:**
- X-axis: lag (days), Y-axis: cumulative %
- Separate data series for observed vs forecast (not just different line styles)
- Requires Phase 1+ maturation curve data

**Scenario Comparison:**
- Compare p AND latency across scenarios
- Tabular output with explicit columns for each metric

### 8.3 Implementation Notes

- Extend `analysis.yaml` schema for latency fields
- Add tabular export option for cohort-level data
- Analytics panel components consume explicit data fields, not infer from styling
- Consider whether completion curves require full maturation data (Appendix C.3) or can work with aggregate latency (§5.5)

---

## 9. Query & Data Retrieval: Impact Analysis

The shift from event-based to cohort-based querying touches **many parts** of the codebase. This section maps all touchpoints.

### 9.1 Conceptual Change

| Current | New |
|---------|-----|
| `window(start, end)` = events occurring in date range | `cohort(start, end)` = users entering in date range |
| Dates refer to when events happened | Dates refer to when users entered funnel |
| n/k aggregated by event date | n/k tracked by cohort entry date |
| No concept of maturity | Cohorts mature over time |

**Key insight:** `window()` remains for event-based queries. `cohort()` becomes the default for conversion edges where we care about maturity.

### 9.2 Codebase Touchpoints

#### A. DSL Construction & Parsing

| File | Current Role | Change Required |
|------|--------------|-----------------|
| `src/lib/dslConstruction.ts` | Builds query DSL from graph selection | Add `cohort()` construction, distinguish from `window()` |
| `src/lib/das/buildDslFromEdge.ts` | Constructs DSL for specific edge | Default to `cohort()` for latency-tracked edges |
| DSL parser (Python/JS) | Parses DSL into query components | Parse `cohort(start:end)` and `cohort(anchor,start:end)` (optional anchor) |

**New DSL syntax (window & cohort):**

```
// Event window (X-anchored, current semantics retained)
window(<start>:<end>)
  - start/end: absolute dates (e.g. 1-Nov-25:14-Nov-25) or relative (e.g. -30d:)

// Cohort window (A-anchored, new for latency edges)
cohort(<start>:<end>)
  - No explicit anchor in DSL: anchor inferred from graph / p.latency.anchor_node_id

// Cohort with explicit anchor
cohort(<anchor_node_id>,<start>:<end>)
  - Anchor node id is provided explicitly (e.g. cohort(household-created,1-Nov-25:7-Nov-25))

// NOTE: maturity_days comes from p.latency.maturity_days, not the DSL
```

#### B. Amplitude Adapter

| File | Current Role | Change Required |
|------|--------------|-----------------|
| `public/defaults/connections.yaml` | Pre-request script builds Amplitude API call | Handle `cohort` vs `window` mode |
| Adapter `pre_request` | Constructs funnel query params | Set `start`/`end` for cohort entry, not event occurrence |

**Key change in adapter:**
```javascript
// Current: start/end = event window
const startDate = queryPayload.window?.start;
const endDate = queryPayload.window?.end;

// New: for cohort mode, these are cohort entry dates
// The observation window extends beyond endDate by maturity_days
if (queryPayload.cohort) {
  const cohortStart = queryPayload.cohort.start;
  const cohortEnd = queryPayload.cohort.end;
  const maturityDays = queryPayload.cohort.maturity || 30;
  // Amplitude query: cohort entered in [cohortStart, cohortEnd]
  // but we observe conversions through cohortEnd + maturityDays
}
```

#### C. Data Operations Service

| File | Current Role | Change Required |
|------|--------------|-----------------|
| `src/services/dataOperationsService.ts` | Orchestrates data fetching | Handle cohort mode, extract latency data |
| `getFromSourceDirect()` | Fetches and transforms data | Pass cohort params, extract `dayMedianTransTimes` |

**Changes needed:**
- Pass `cohort` params to DAS runner
- Extract `dayFunnels` + `dayMedianTransTimes` from response
- Compute mature/immature split based on cohort age
- Store latency estimates

#### D. Window Aggregation Service

| File | Current Role | Change Required |
|------|--------------|-----------------|
| `src/services/windowAggregationService.ts` | Aggregates time series by window | Add cohort-aware aggregation |
| `parameterToTimeSeries()` | Converts param file to time series | Handle cohort dates vs event dates |

**Changes needed:**
- New function: `computeMatureImmatureSplit(cohorts, currentDate, maturityDays)`
- Modify aggregation to separate mature vs immature cohorts
- Return both aggregate p AND maturity breakdown

#### E. Amplitude Adapter (connections.yaml)

| Change | Description |
|--------|-------------|
| Add `cs` default | Conversion window in seconds (default: 3,888,000 = 45 days) |
| Extract latency fields | `dayMedianTransTimes`, `dayAvgTransTimes`, `medianTransTimes`, `avgTransTimes`, `stepTransTimeDistribution` |
| Support `cohort()` | Pre-request script must handle cohort vs window semantics |

**New defaults:**
```yaml
defaults:
  base_url: "https://amplitude.com/api/2"
  cs: 3888000  # Conversion window: 45 days in seconds
```

**New response extracts:**
```yaml
response:
  extract:
    # ... existing extracts ...
    - name: day_median_trans_times
      jmes: "data[0].dayMedianTransTimes"
    - name: day_avg_trans_times
      jmes: "data[0].dayAvgTransTimes"
    - name: median_trans_times
      jmes: "data[0].medianTransTimes"
    - name: avg_trans_times
      jmes: "data[0].avgTransTimes"
    - name: step_trans_time_dist
      jmes: "data[0].stepTransTimeDistribution"
```

**Pre-request changes:**
- Detect `cohort()` vs `window()` from DSL
- For `cohort()`: build 3-step A→X→Y funnel, set `from_step_index` and `to_step_index` for X→Y extraction
- For `window()`: build 2-step X→Y funnel (current behaviour)
- Pass `cs` parameter to API: `cs={connection.cs}`

##### E.1 Amplitude Helper Module (`amplitudeHelpers.ts`)

To avoid complex logic in YAML, the Amplitude adapter is refactored so that:

- YAML stays declarative (pre_request, request, response, upsert).
- **All DAGNet-specific funnel construction logic** lives in a TypeScript helper.

**Helper responsibilities (conceptual):**
- Accept **edge-level context**: anchor node id, from/to events, mode (`cohort` or `window`), maturity days.
- Build **Amplitude-ready funnel spec**: ordered events array with correct `from_step_index`/`to_step_index`.
- Compute **cohort vs window date ranges** from canonical DSL (absolute dates).

**Design (no strict signatures):**
- A pure helper (no React, no network calls) that:
  - Takes a parsed DSL object and `LatencyConfig` (from edge or defaults).
  - Returns:
    - `funnel_events`: ordered list of Amplitude event_ids.
    - `from_step_index` / `to_step_index`.
    - `start_date` / `end_date` strings in Amplitude’s expected format.
    - `mode`: `'cohort' | 'window'`.
- The YAML `pre_request` script delegates to this helper, rather than re-implementing mapping logic inline.

**Rationale:** Centralises Amplitude-specific funnel construction in one place, keeps YAML manageable, and mirrors the service-layer pattern used elsewhere in DAGNet.

#### F. Parameter Storage

| File | Current Role | Change Required |
|------|--------------|-----------------|
| `src/services/paramRegistryService.ts` | Stores/retrieves parameter data | Store latency arrays and summary blocks |
| `public/param-schemas/parameter-schema.yaml` | Schema for parameter files | Add latency fields (see §3.2) |

**New fields in parameter values** (extends existing schema pattern):
```yaml
values:
  - mean: 0.704
    n: 1450
    k: 1021
    window_from: '2025-09-01'
    window_to: '2025-11-30'
    
    # Existing daily breakdown (unchanged)
    dates: [1-Sep-25, 2-Sep-25, ...]
    n_daily: [21, 7, ...]
    k_daily: [19, 4, ...]
    
    # NEW: Per-cohort latency (flat arrays, parallel to dates)
    median_lag_days: [6.0, 6.0, ...]
    mean_lag_days: [6.2, 6.0, ...]
    
    # NEW: Anchor data for multi-step funnels (flat arrays)
    anchor_n_daily: [575, 217, ...]
    anchor_median_lag_days: [14.8, 16.2, ...]
    anchor_mean_lag_days: [15.9, 16.2, ...]
    
    # NEW: Edge-level latency summary
    latency:
      median_lag_days: 6.0
      mean_lag_days: 7.0
      completeness: 1.0
      histogram: { ... }
    
    # NEW: Upstream latency (for convolution)
    anchor_latency: { ... }
    
    data_source:
      type: amplitude
      retrieved_at: '2025-12-02T00:00:00Z'
      full_query: 'cohort(-90d:)'
```

See §3.2 for full structure and field descriptions.

#### G. Update Manager

| File | Current Role | Change Required |
|------|--------------|-----------------|
| `src/services/UpdateManager.ts` | Transforms data between graph/files | Handle latency fields |
| Mapping configs | Define field transformations | Add mappings for latency data |

**New mappings needed:**
- `source → edge.latency.median_days`
- `source → edge.p.maturity_coverage`

#### H. Edge Schema & Types

| File | Current Role | Change Required |
|------|--------------|-----------------|
| `src/types/index.ts` | TypeScript type definitions | Add `LatencyConfig`, rename `cost_time` |
| `lib/graph_types.py` | Pydantic models | Add latency fields to Edge model |

#### I. Edge Rendering

| File | Current Role | Change Required |
|------|--------------|-----------------|
| `src/components/edges/ConversionEdge.tsx` | Renders conversion edges | Two-layer mature/forecast rendering |
| `src/components/edges/EdgeBeads.tsx` | Renders edge beads/labels | Show latency info in beads |
| `src/lib/nodeEdgeConstants.ts` | Edge styling constants | Add stripe patterns for forecast layer |

#### J. Properties Panel

| File | Current Role | Change Required |
|------|--------------|-----------------|
| `src/components/PropertiesPanel.tsx` | Shows selected element properties | Display latency stats, maturity coverage |

#### K. Context & State

| File | Current Role | Change Required |
|------|--------------|-----------------|
| `src/contexts/ScenariosContext.tsx` | Manages scenario state | No change needed for latency |
| `src/types/scenarios.ts` | Scenario type definitions | Add latency render fields to `EdgeParamDiff` |

**Data architecture — graph edge ↔ param file mirroring:**

```
Graph Edge / Probability      ↔    Param File
─────────────────────────────────────────────────────────────────
edge.p.latency.maturity_days  ↔    latency.maturity_days (top-level CONFIG; >0 enables tracking)
edge.query                    ↔    query
─────────────────────────────────────────────────────────────────
edge.p.mean                   ↔    values[].mean        (per-slice DATA)
edge.p.forecast               ↔    values[].forecast    (NEW)
edge.p.evidence.completeness  ↔    values[].completeness (NEW)
edge.p.evidence.n/k           ↔    values[].n, values[].k
─────────────────────────────────────────────────────────────────
(not on graph)                ↔    values[].n_daily[]   (BULK DATA)
                              ↔    values[].median_lag_days[]
                              ↔    values[].latency     (summary)
```

##### CONFIG fields (Edge ↔ Param top-level, NOT scenario)

| Graph / Prob | Param File | Override Flag | Notes |
|--------------|-----------|---------------|-------|
| `edge.p.latency.maturity_days` | `latency.maturity_days` | `maturity_days_overridden` | >0 enables latency tracking |
| `edge.p.latency.anchor_node_id` | `latency.anchor_node_id` | `anchor_node_id_overridden` | Cohort anchor (MSMDC-computed) |

**`anchor_node_id` generation:**
- Computed by MSMDC at graph-edit time (alongside `query` generation)
- **Computed for ALL edges**, not just latency-tracked (simpler, output is cheap)
- Furthest topologically upstream START node reachable from edge.from
- Stored on edge and param file with `_overridden` pattern
- At retrieval time, just read the pre-computed value — no graph traversal

**A=X case (edge.from IS a start node):**
- `anchor_node_id` = `edge.from` (A=X)
- Cohort funnel is 2-step `[X, Y]` not 3-step `[A, X, Y]`
- Query becomes `cohort(x, dates)` where x is both anchor and from
- Semantically correct: "of people who did X on date D, how many did Y?"
- No special handling — adapter builds 2-step funnel when anchor = from

##### DATA fields (Edge `p.*` ↔ Param `values[]`, scenario-overridable)

**Existing:**

| Graph Edge | Param `values[]` | Override Flag | Scenario |
|------------|-----------------|---------------|----------|
| `edge.p.mean` | `mean` | `p.mean_overridden` | ✅ |
| `edge.p.stdev` | `stdev` | `p.stdev_overridden` | ✅ |
| `edge.p.distribution` | `distribution` | `p.distribution_overridden` | ❌ modelling choice |
| `edge.p.evidence.n/k` | `n`, `k` | — | ❌ display-only (converged into evidence) |

**NEW Forecast (mature baseline):**

| Graph Edge | Param `values[]` | Override Flag | Scenario |
|------------|-----------------|---------------|----------|
| `edge.p.forecast.mean` | `forecast_mean` | `p.forecast.mean_overridden` | ✅ |
| `edge.p.forecast.stdev` | `forecast_stdev` | `p.forecast.stdev_overridden` | ✅ |
| `edge.p.forecast.distribution` | `forecast_distribution` | `p.forecast.distribution_overridden` | ❌ modelling choice |

**NEW Evidence (observed):**

| Graph Edge | Param `values[]` | Override Flag | Scenario |
|------------|-----------------|---------------|----------|
| `edge.p.evidence.mean` | `evidence_mean` | — | ✅ |
| `edge.p.evidence.stdev` | `evidence_stdev` | — | ✅ |
| `edge.p.evidence.distribution` | `evidence_distribution` | — | ❌ modelling choice |
##### DISPLAY-ONLY fields (derived, no override, no scenario)

| Graph Edge | Param `values[]` | Notes |
|------------|-----------------|-------|
| `edge.p.evidence.completeness` | `completeness` | Shown on bead; not an input to calculations |
| `edge.p.evidence.median_lag_days` | `latency.median_lag_days` | Shown on bead |
| `edge.p.evidence.mean_lag_days` | `latency.mean_days` | Shown in tooltip |

**EdgeParamDiff additions (src/types/scenarios.ts):**

```typescript
interface EdgeParamDiff {
  // ... existing mean, stdev, n, k ...
  // NOTE: distribution is NOT scenario-overridable (modelling choice, not value)
  
  // NEW: Forecast fields (mature baseline)
  forecast_mean?: number;
  forecast_mean_overridden?: boolean;
  forecast_stdev?: number;
  forecast_stdev_overridden?: boolean;
  // NOTE: forecast_distribution NOT included (modelling choice)
  
  // NEW: Evidence fields (observed)
  evidence_mean?: number;
  evidence_stdev?: number;
  // NOTE: evidence_distribution NOT included (modelling choice)
  // NOTE: completeness NOT included (display-only diagnostic, not an input)
}
```

**UI exposure:**
- **Scenarios Modal**: `forecast` editable per-scenario
- **Properties Panel**: CONFIG fields + current DATA values
- **Edge Bead**: Shows `median_lag_days` + `completeness` (display only)
- **Tooltip**: Shows all values with data source

#### 9.K.1 Param Pack Cleanup (Housekeeping)

**Problem:** The current `ProbabilityParam` and `CostParam` types in `scenarios.ts` include fields that are **modelling choices**, not values to vary in what-if scenarios:

```typescript
// CURRENT (incorrect)
interface ProbabilityParam {
  mean?: number;           // ✅ Value - keep
  stdev?: number;          // ✅ Value - keep
  distribution?: string;   // ❌ Modelling choice - remove
  min?: number;            // ❌ Distribution param - remove
  max?: number;            // ❌ Distribution param - remove
  alpha?: number;          // ❌ Distribution param - remove
  beta?: number;           // ❌ Distribution param - remove
}
```

**Principle:** Scenario param packs contain **values you might vary in a what-if analysis**, not structural/modelling specifications. Changing `distribution` from "beta" to "normal" is a modelling decision, not a scenario.

**Change required (updated to match nested DSL conventions):**

In scenario param packs, LAG fields are represented as **nested objects** under `p.forecast` and `p.evidence`, to align with the human‑readable notation used elsewhere in the system (e.g. `e.edge-id.p.forecast.mean`, `e.edge-id.p.evidence.mean`):

```typescript
// CLEANED UP (conceptual shape – see src/types/scenarios.ts)
interface ProbabilityParam {
  mean?: number;
  stdev?: number;

  // NEW (LAG) – scenario-specific baseline from window() slices:
  forecast?: {
    mean?: number;   // HRN: e.<edge>.p.forecast.mean
    stdev?: number;  // HRN: e.<edge>.p.forecast.stdev
  };

  // NEW (LAG) – scenario-specific observed rate from evidence:
  evidence?: {
    mean?: number;   // HRN: e.<edge>.p.evidence.mean
    stdev?: number;  // HRN: e.<edge>.p.evidence.stdev
  };

  // NEW (LAG) – latency display scalars (bead / lag visuals):
  latency?: {
    median_lag_days?: number; // HRN: e.<edge>.p.latency.median_lag_days
    completeness?: number;    // HRN: e.<edge>.p.latency.completeness
    // (t95 is stored on p.latency at graph level and may be included in packs where needed)
  };
}

interface CostParam {
  mean?: number;
  stdev?: number;
  currency?: string;  // Keep for display
  units?: string;     // Keep for display
}
```

**Files to update:**
- `src/types/scenarios.ts` — remove `distribution`, `min`, `max`, `alpha`, `beta` from types
- `src/services/GraphParamExtractor.ts` — stop extracting those fields

**Backward compatibility:** Existing scenario files with these fields will simply have them ignored (sparse representation). No migration needed.

#### 9.K.2 Scenario Rendering with Latency (Impact Summary)

Scenarios can each have their own **query DSL** (e.g., `window(-90d:-60d)`, `cohort(-30d:).context(channel:google)`, `window(-90d:-60d).visited(d)`, `window(-90d:-60d).case(exp:treatment)`). For each such scenario, the renderer must be able to draw the **correct F/E/F+E latency view** without recomputing from the "current" layer.

**Per-scenario param packs must contain, per edge:**

- `p.mean`, `p.stdev` — scenario-specific blended probability and uncertainty (already present).
- `p.forecast.mean`, `p.forecast.stdev` — scenario-specific mature baseline (from window() slices for that scenario's fetch DSL).
- `p.evidence.mean`, `p.evidence.stdev` — scenario-specific observed rate (from cohort/window evidence for that scenario's fetch DSL).
- `p.latency.median_lag_days`, `p.latency.completeness` (and, where included, `p.latency.t95`) — scenario-specific latency display scalars.

These nested lag fields are sufficient to reconstruct, per scenario and per edge:

- `p.evidence` = object with `mean`/`stdev` taken from `p.evidence.*` (inner solid width).
- `p.forecast` = object with `mean`/`stdev` taken from `p.forecast.*` (outer forecast-only width in F mode).
- `p.mean` = scenario's blended value (outer width in F+E mode; can be taken directly from `p.mean` or, if needed, recomputed from forecast/evidence).

**Scenario regeneration flow with latency:**

1. **Split scenario DSL** (`meta.queryDSL`) into:
   - **Fetch parts** (window, context, contextAny) → used to build the scenario's effective fetch DSL.
   - **What-if parts** (case, visited, exclude) → used by the What-If engine after fetch.
2. **Fetch & compute for this scenario:**
   - Use the effective fetch DSL to drive param-file / Amplitude fetch for this scenario.
   - Run the same latency pipeline as the base layer:
     - window() slices → `forecast_mean`, `forecast_stdev` (scenario baseline).
     - cohort()/window evidence → `evidence_mean`, `evidence_stdev`.
     - Formula A → scenario `p.mean` and completeness (for display/runner).
3. **Extract into ScenarioParams:**
   - `GraphParamExtractor` + `extractDiffParams` include:
     - `p.mean`, `p.stdev` (as today).
     - `p.forecast.mean`, `p.forecast.stdev`, `p.evidence.mean`, `p.evidence.stdev`, and the latency scalars where they differ from Base or are newly available.
4. **Render-time composition:**
   - ScenariosContext composes `Scenario.params` over the Base graph.
   - For each visible scenario layer and edge, the renderer reads from the composed params:
     - Scenario `p.mean` / `p.stdev` for edge width & CI.
     - Scenario `p.forecast.mean` / `p.evidence.mean` to derive `p.forecast` and `p.evidence` for that layer's latency display.
   - The base latency machinery (Formula A, completeness, lag fit) is **not** rerun at render time for scenarios; it has already been baked into scenario param packs at regeneration.

**Important constraints:**

- Scenario param packs **do not** contain heavy bulk data (`n_daily`, `k_daily`, `median_lag_days[]`, histograms). Those live in param files and are shared across scenarios.
- Param packs only contain the **scalar outputs needed for rendering and what-if analysis** for each scenario DSL.
- Live scenarios regenerate their param packs when the user requests refresh; static scenarios store a snapshot of these fields.

### 9.3 Data Flow: Cohort Mode (End-to-End)

This section ties the general flows in §5.7–§5.9 back to a **single user action** in the UI for a latency-tracked edge in **cohort mode**.

High-level sequence when user clicks "Get from source" on a latency edge:

1. **UI → DSL construction**
   - User selects edge in **Properties Panel**.
   - `buildDslFromEdge()` constructs a DSL string with a `cohort(...)` clause, using:
     - implicit anchor (from graph / `p.latency.anchor_node_id`), or
     - explicit anchor from user-edited DSL.

2. **DataOperations → choose flow**
   - `dataOperationsService.getFromSource()` decides, per edge:
     - If matching slices already exist and are usable → **Flow A (versioned)**: load from Param Registry and skip direct Amplitude call.
     - If slices are missing/immature or user forces refresh → **Flow B (direct)**: call Amplitude for this edge.

3. **Amplitude / DAS runner**
   - For direct fetches, `DASRunner` + adapter execute the Amplitude call(s):
     - `cohort(...)` → A-anchored dayFunnels + `dayMedianTransTimes` for this edge.
     - (Optionally) `window(...)` if the interactive DSL also includes a window clause.

4. **Transform & inference**
   - Response is transformed into:
     - per-cohort `n`, `k`, ages, `median_lag_days[]`, `mean_lag_days[]`, histograms.
   - `statisticalEnhancementService`:
     - Fits lag CDF (log-normal), derives `t95`.
     - Applies Formula A for the current query window → `p.mean`, completeness.
     - Updates `p.latency.t95` and `edge.p.evidence.completeness` / `edge.p.mean` on the graph.

5. **Optional versioning (Flow A only)**
   - When running under pinned DSL / batch runner, the same transform step also writes:
     - `values[].*` entries into the parameter file (cohort + optional window slices).
   - For pure direct (Flow B), this write-back is **optional** and only occurs if the caller explicitly asks to version the result.

6. **Render**
   - `ConversionEdge` re-renders using updated `p.mean`, completeness, `p.latency.t95`:
     - Edge stroke(s) for probability,
     - Latency bead for median/σ/completeness,
     - Tooltip including evidence/forecast/blended and slice provenance.

### 9.4 Migration Considerations

**Backward compatibility:**
- `window()` DSL remains valid for event-based queries
- Existing parameter files without cohort metadata continue to work
- Edges without `latency.maturity_days > 0` behave as before

**Default behavior change:**
- New fetches for conversion edges use `cohort()` by default
- User can override to `window()` for specific use cases

---

## 10. Implementation Plan

### CORE DELIVERY

#### Phase C1: Schema Changes

- [ ] Rename `cost_time` → `labour_cost` (global search/replace)
- [ ] Add `LatencyConfig` to edge schema (TS, Python, YAML):
  - `maturity_days?: number` (>0 enables tracking), `maturity_days_overridden?: boolean`
  - `anchor_node_id?: string`, `anchor_node_id_overridden?: boolean`
- [ ] Extend MSMDC to compute `anchor_node_id` for latency-tracked edges
- [ ] Add UpdateManager mappings for `anchor_node_id` (edge ↔ param file)
- [ ] Extend parameter schema for cohort metadata + latency block
- [ ] **Param pack cleanup** (see §9.K.1):
  - [ ] Remove `distribution`, `min`, `max`, `alpha`, `beta` from `ProbabilityParam` in `scenarios.ts`
  - [ ] Remove `distribution`, `min`, `max` from `CostParam` in `scenarios.ts`
  - [ ] Update `GraphParamExtractor.ts` to stop extracting those fields
- [ ] Add LAG fields to `EdgeParamDiff` in scenarios:
  - `forecast_mean`, `forecast_stdev` — mature baseline (scenario-overridable)
  - `evidence_mean`, `evidence_stdev` — observed rate (scenario-overridable)
  - NOTE: `distribution`, `completeness`, `median_lag_days`, `n`, `k` are NOT in param packs

#### Phase C2: DSL & Query Architecture

- [ ] Implement `cohort()` DSL clause parsing
- [ ] Update `buildDslFromEdge.ts` to use `cohort()` for latency-tracked edges
- [ ] Modify Amplitude adapter `pre_request` for cohort mode
- [ ] Extract `dayMedianTransTimes` in response transform

#### Phase C3: Data Storage & Aggregation

- [ ] Store per-cohort latency in parameter files
- [ ] Implement mature/immature split computation
- [ ] Update `windowAggregationService` for cohort-aware aggregation
- [ ] UpdateManager mappings for latency fields (with `_overridden` logic)
- [ ] **Put to file**: Write `latency.maturity_days` from edge (>0 enables tracking)
- [ ] **Get from file**: Apply latency config only if `*_overridden` is false on edge
- [ ] Tests for latency override behaviour:
  - Put latency config to file
  - Get from file (no override) — applies to edge
  - Get from file (with override) — does not clobber edge value

#### Phase C4: Edge Rendering

- [ ] Per-scenario visibility state (4-state cycle: F+E → F → E → hidden)
- [ ] Two-layer edge rendering (inner=evidence, outer=mean)
- [ ] Edge data model: `p.evidence`, `p.forecast`, `p.mean`, `completeness`
- [ ] Properties panel: latency settings (track toggle, maturity_days input)
- [ ] Tooltip: data provenance (which sliceDSL contributed)
- [ ] CI bands on striped portion (extend existing CI logic)

---

### ANALYTICS EXTENSIONS (Separate Delivery)

#### Phase A1: Analysis Schema

- [ ] Extend `analysis.yaml` for latency fields
- [ ] Tabular export with cohort breakdown

#### Phase A2: Analytics Panel

- [ ] Cohort maturity table
- [ ] Latency distribution charts

---

### BAYESIAN ENHANCEMENTS (Future)

#### Phase B1: Distribution Fitting

- [ ] MLE fitting (lognormal/weibull) for latency
- [ ] Store fitted params in parameter files

#### Phase B2: Hierarchical Model

- [ ] Bayesian hierarchical model for uncertainty
- [ ] Credible intervals on latency estimates

#### Phase B3: Forecasting

- [ ] Forecast immature cohort completion
- [ ] Fan charts for time-indexed projections

---

## 11. Testing Strategy

### 11.1 Test Coverage Requirements

The dual-slice retrieval architecture introduces significant complexity that requires comprehensive test coverage across multiple dimensions.

#### A. DSL Parsing Tests (`queryDSL.test.ts`)

| Test Case | Input | Expected Output |
|-----------|-------|-----------------|
| Parse `cohort()` with relative dates | `cohort(-90d:-30d)` | `{ cohort: { start: '-90d', end: '-30d' } }` |
| Parse `cohort()` with absolute dates | `cohort(1-Sep-25:30-Nov-25)` | `{ cohort: { start: '1-Sep-25', end: '30-Nov-25' } }` |
| Parse `cohort()` with anchor | `cohort(household-created,-90d:)` | `{ cohort: { anchor: 'household-created', start: '-90d', end: '' } }` |
| Parse mixed `window()` and `cohort()` | `window(-7d:).cohort(-90d:)` | Both parsed; last wins or error? |
| Normalise `cohort()` to canonical form | `cohort( -90d : -30d )` | `cohort(-90d:-30d)` |

#### B. DSL Explosion Tests (`dslExplosion.test.ts`)

| Test Case | Input | Expected Atomic Slices |
|-----------|-------|------------------------|
| Compound with `cohort()` | `or(cohort(-90d:), window(-7d:)).context(channel)` | Cartesian product of cohort/window × context values |
| Nested OR with `cohort()` | `or(cohort(-90d:-60d), cohort(-60d:-30d))` | Two separate cohort slices |
| `cohort()` with context expansion | `cohort(-90d:).context(channel)` | One slice per channel value |

#### C. Ingestion Logic Tests (`dataOperationsService.test.ts`)

| Test Case | Edge Config | Pinned DSL | Expected Behaviour |
|-----------|-------------|------------|-------------------|
| Latency edge, cohort only | `maturity_days: 30` | `cohort(-90d:)` | 3-step A-anchored fetch; store `cohort_data` |
| Latency edge, window only | `maturity_days: 30` | `window(-7d:)` | 2-step X-anchored fetch; store `window_data` |
| Latency edge, dual slice | `maturity_days: 30` | `or(cohort(-90d:), window(-7d:))` | Both fetches; both data blocks stored |
| Non-latency edge, cohort | `maturity_days: 0` or undefined | `cohort(-90d:)` | Treat as `window()`; standard fetch |
| Latency edge, no anchor defined | `maturity_days: 30`, no `anchor.node_id` | `cohort(-90d:)` | Error or fallback to graph START node |

#### D. Window Aggregation Tests (`windowAggregationService.test.ts`)

| Test Case | Query | Data Available | Expected Resolution |
|-----------|-------|----------------|---------------------|
| `cohort()` on latency edge | `cohort(-60d:-30d)` | `cohort_data` present | Slice rows by A-date; return `Σk/Σn` |
| `window()` on latency edge, window_data exists | `window(-7d:)` | `window_data` present | Use X-anchored data directly |
| `window()` on latency edge, no window_data | `window(-7d:)` | Only `cohort_data` | Convolution fallback (or error?) |
| `cohort()` on non-latency edge | `cohort(-60d:-30d)` | Standard `n_daily/k_daily` | Treat as `window()` |
| Mixed query types | `cohort(-90d:)` then `window(-7d:)` | Both data blocks | Correct routing per query type |

#### E. Forecasting Logic Tests (`statisticalEnhancementService.test.ts` — new)

| Test Case | Inputs | Expected Output |
|-----------|--------|-----------------|
| Fully mature cohort | Age > median_days, observed k | `forecast_k = k` (no tail) |
| Fully immature cohort | Age = 0, k = 0 | `forecast_k = n * p.forecast` |
| Partially mature cohort | Age = median_days/2, some k | `forecast_k = k + tail` per formula A |
| Zero observed conversions | k = 0, age > 0 | Still forecasts tail based on p.forecast |
| Edge case: p.forecast = 0 | No mature conversions | Fallback to prior or error |
| Edge case: p.forecast = 1 | All mature users convert | `forecast_k = n` |

#### F. Completeness Calculation Tests

| Test Case | Cohort Ages | Median Days | Expected Completeness |
|-----------|-------------|-------------|----------------------|
| All mature | [60, 45, 30] | 30 | 1.0 |
| All immature | [5, 3, 1] | 30 | ~0.1 |
| Mixed | [60, 30, 7, 2] | 30 | Weighted average |
| Zero median (edge case) | [10, 5] | 0 | 1.0 (or error?) |
| Single cohort | [15] | 30 | 0.5 |

#### G. Recency Weighting Tests (Recency Extension)

| Test Case | Cohort Dates | Half-life | Expected Weights |
|-----------|--------------|-----------|------------------|
| All same age | [T-30, T-30, T-30] | 30 | Equal weights |
| Exponential decay | [T-60, T-30, T-0] | 30 | [0.135, 0.368, 1.0] (approx) |
| Very old cohort | [T-180] | 30 | Near-zero weight |
| Half-life = infinity | Any | ∞ | Equal weights |

#### H. Effective Sample Size Tests (Recency Extension)

| Test Case | Weights | n_i | Expected N_eff |
|-----------|---------|-----|----------------|
| Equal weights | [1, 1, 1] | [100, 100, 100] | 300 |
| One dominant | [1, 0.01, 0.01] | [100, 100, 100] | ~102 |
| All zero except one | [1, 0, 0] | [100, 100, 100] | 100 |

#### I. T₉₅ and Path Maturity Tests

| Test Case | Setup | Expected Behaviour |
|-----------|-------|--------------------|
| Single edge, good empirical lag | `median_lag_days` and `mean_lag_days` with k ≥ LATENCY_MIN_FIT_CONVERTERS | `p.latency.t95` matches log-normal formula from §5.4.2 |
| Single edge, poor empirical lag | k < LATENCY_MIN_FIT_CONVERTERS or mean/median outside [LATENCY_MIN_MEAN_MEDIAN_RATIO, LATENCY_MAX_MEAN_MEDIAN_RATIO] | `p.latency.t95` falls back to `maturity_days` |
| Simple path A→X→Y | Edges A→X and X→Y both have persisted `p.latency.t95` | `compute_path_t95_for_all_edges` sums per-edge t95 and stores transient `path_t95` matching §4.7.2 |
| Scenario with disabled edge | One edge on A→X path inactive under `whatIfDSL` | `path_t95` ignores inactive edge and uses only active edges’ t95 |

#### J. Cross-Language Parity & Golden Fixtures

Latency maths must be consistent across TypeScript and Python, and robust against subtle numerical errors.

| Test Case | Files | Expected Behaviour |
|-----------|-------|--------------------|
| TS ↔ Python parity (lag fitting) | `statisticalEnhancementService.test.ts`, `test_lag_math.py` (or extend `test_msmdc.py`) | For a shared set of synthetic edges with known `median_lag_days` / `mean_lag_days`, TS and Python implementations of log-normal fitting produce matching `μ`, `σ`, and `t_{95}` within a tight tolerance. |
| TS ↔ Python parity (Formula A) | Same as above | For identical cohort arrays `(n_i, k_i, a_i)` and `p_\infty`, TS and Python implementations of Formula A produce the same `p.evidence`, `p.mean`, and completeness (within tolerance). |
| Golden funnel fixtures | Shared JSON / YAML fixtures | For a small number of canonical funnels (short-lag, long-lag, mixed maturity), the end-to-end pipeline (Amplitude adapter → param files → `statisticalEnhancementService`) reproduces pre-computed “golden” values of `p.evidence`, `p.forecast`, `p.mean`, and completeness. |

#### K. Implicit Baseline Window Tests

These tests ensure the **implicit baseline window** policy (§5.2.1) behaves correctly both with and without parameter files.

| Test Case | Setup | Expected Behaviour |
|-----------|-------|--------------------|
| Cohort-only DSL, no files (Flow B) | No param files; interactive DSL contains `cohort(...)` only | System constructs baseline `window(T_query - W_base : T_query)` with `W_base` clamped to [30d, 60d], fetches window() data, and computes `p.forecast` / `t_{95}`. Evidence and forecast render correctly. |
| Cohort-only DSL, partial window slices (Flow A) | Param file has some window() days but not full `W_base` range | `calculateIncrementalFetch` detects missing dates; `getItemsNeedingFetch`+`batchGetFromSource` fetch only missing days; final `p.forecast` / `t_{95}` is based on the full baseline window. |
| Baseline window, API returns no data | Valid implicit baseline window, but Amplitude returns no data for that range | Edge’s `p.forecast` treated as unavailable; F and F+E visibility modes disabled; evidence-only rendering remains available; no repeated re-fetch for the same empty window once `no_data` markers are written. |

#### L. Logging & Observability Tests

Given the complexity of dual-slice retrieval, implicit baselines, and path maturity, tests must verify that **session logging** provides a clear, inspectable narrative for latency operations.

| Test Case | Files | Expected Behaviour |
|-----------|-------|--------------------|
| DATA_GET_FROM_SOURCE with latency | `dataOperationsService.test.ts`, `fetchDataService.test.ts` | Starting a latency fetch emits a `data-fetch` operation via `sessionLogService` with children describing slice planning, cache hits, API calls, and UpdateManager application. |
| Implicit baseline window logging | Same as above | When an implicit baseline window is constructed, a child log entry records edge id, `W_base`, baseline start/end dates, and the effective DSL used for that fetch. |
| Path maturity + cache log | `statisticalEnhancementService.test.ts`, `integrityCheckService.test.ts` (or dedicated log tests) | After batch fetch, computation of `p.latency.t95` and `path_t95` is logged once per operation (not per render), making cache decisions traceable in the session log. |

### 11.2 Integration Test Scenarios

These tests verify end-to-end behaviour across the full pipeline.

#### Scenario 1: Fresh Latency Edge Setup
1. Create edge with `latency.maturity_days: 30` (enables latency tracking)
2. Set pinned DSL to `or(cohort(-90d:), window(-7d:)).context(channel:google)`
3. Trigger data fetch
4. **Verify:** Both `cohort_data` and `window_data` blocks present in param file
5. **Verify:** `latency.completeness` calculated correctly

#### Scenario 2: Cohort Query on Mature Data
1. Load param file with 90 days of `cohort_data`, all cohorts >30 days old
2. Execute `cohort(-60d:-30d)` query
3. **Verify:** Returns `p = Σk/Σn` for sliced rows
4. **Verify:** `completeness = 1.0`

#### Scenario 3: Cohort Query on Mixed Maturity
1. Load param file with 90 days of `cohort_data`, some cohorts <30 days old
2. Execute `cohort(-21d:)` query
3. **Verify:** Returns forecasted `p` using formula A
4. **Verify:** `completeness < 1.0`

#### Scenario 4: Window Query with X-Anchored Data
1. Load param file with `window_data` for last 7 days
2. Execute `window(-7d:)` query
3. **Verify:** Uses `window_data.n_daily/k_daily` directly
4. **Verify:** Does NOT use convolution

#### Scenario 5: Window Query Without Window Data (Error Case)
1. Load param file with only `cohort_data` (no `window_data`)
2. Execute `window(-7d:)` query
3. **Verify:** Error returned: "Window data not available"
4. **Verify:** UI prompts user to fetch window() data or switch to cohort mode

**Note:** If convolution fallback (Appendix C.2) is not implemented, return an error prompting user to fetch window() data.

#### Scenario 6: Non-Latency Edge with cohort() Query
1. Load param file for edge with `latency.maturity_days: 0` (tracking disabled)
2. Execute `cohort(-30d:)` query
3. **Verify:** Treated as `window(-30d:)`
4. **Verify:** Standard aggregation logic used

### 10.3 Edge Cases and Error Handling

| Edge Case | Expected Behaviour |
|-----------|-------------------|
| `cohort()` query but no `cohort_data` in param | Error: "Cohort data not available for this edge" |
| `window()` query on latency edge, no data at all | Error: "No data available for window query" |
| Negative `maturity_days` | Validation error at edge config time |
| `completeness` > 1.0 calculated | Clamp to 1.0 |
| Empty cohort window (no rows match) | Return `p = null`, `n = 0`, `k = 0` |
| Anchor node doesn't exist in graph | Error at fetch time |
| Histogram with zero total converters | Skip histogram-based calculations |

### 10.4 Performance Tests

| Test | Threshold | Notes |
|------|-----------|-------|
| Parse 1000 DSL strings | < 100ms | Ensure parsing is fast |
| Aggregate 90 days of cohort_data | < 50ms | Typical query size |
| Convolution fallback (90 cohorts × 45-day lag) | < 200ms | Acceptable for fallback |
| Effective sample size calculation | < 10ms | Simple sum operations |

### 10.5 Mock Data Requirements

Tests will require mock Amplitude responses and param files covering:

1. **Short-lag edge** (median ~5 days): Histogram is reliable
2. **Long-lag edge** (median ~15 days): Histogram catch-all dominates
3. **Mixed maturity** param file: Some cohorts mature, some immature
4. **Sparse data** param file: Low n/k, tests sparsity guards
5. **Time-varying p**: Different p.forecast across time periods (for drift detection tests)

---

## 12. Open Questions (Moved)

> **Note:** The open questions and decisions previously listed here have been moved into `implementation-open-issues.md` (for unresolved topics) and folded into the main design where resolved. This section is intentionally left minimal to avoid drift between documents.

## Appendix A: Amplitude Data Quality Notes

### A.1 Histogram vs Median Reliability

**Important limitation:** Amplitude's `stepTransTimeDistribution` histogram provides hourly-granularity bins only up to ~10 days, after which all conversions are lumped into a single catch-all bucket (e.g., `10d–45d`).

**Empirical verification (2-Dec-25):**

| Edge | Amplitude `medianTransTimes` | Histogram-derived median | Notes |
|------|------------------------------|--------------------------|-------|
| X→Y (6-day edge) | 6.02 days | 6.04 days | ✅ Match — histogram is reliable |
| A→X (11-day edge) | 11.4 days | 20.3 days | ❌ Mismatch — histogram catch-all distorts |

The A→X discrepancy occurs because 71% of converters (1029/1450) fall into the `10–45d` catch-all bucket. If Amplitude computed the median from this coarse histogram, it would land around ~20 days. The fact that `medianTransTimes` reports ~11.4 days indicates **Amplitude computes medians from fine-grained per-user event times**, not from the exposed histogram.

**Implications for DAGNet:**

1. **For edges with median lag ≤10 days:** The histogram provides useful shape information; medians and histogram are consistent.
2. **For edges with median lag >10 days:** Rely primarily on `medianTransTimes` and `dayMedianTransTimes`; the histogram tail is too coarse for shape inference.
3. **For distribution fitting (future Bayesian work):** Use medians as the primary constraint; histogram provides only rough body shape.

### A.2 Conversion Window (`cs`) Parameter

The `cs` parameter (conversion seconds) controls how long users have to convert. We use 45 days (3,888,000 seconds) to capture long-lag edges. This is the right-censoring boundary — any conversion after 45 days is excluded from both histogram and median calculations.

---

## Appendix B: Amplitude Response Reference

Key fields from `amplitude_response.json`:

```json
{
  "data": [{
    // Aggregate n/k
    "cumulativeRaw": [1765, 1076],  // [n, k]
    "cumulative": [1.0, 0.6096],    // [1, p]
    
    // Daily breakdown
    "dayFunnels": {
      "xValues": ["2025-11-03", ...],  // Dates
      "series": [[270, 161], ...]      // [n_i, k_i] per day
    },
    
    // Time distribution (within-day)
    "medianTransTimes": [155000, 155000],  // ms
    "avgTransTimes": [2879786, 2879786],   // ms
    "stepTransTimeDistribution": {
      "step_bins": [{
        "bins": [
          {"start": 60000, "end": 70000, "bin_dist": {"uniques": 49}},
          {"start": 70000, "end": 80000, "bin_dist": {"uniques": 75}},
          // ... 10k ms bins up to 900k (15 mins)
          {"start": 900000, "end": 601200000, "bin_dist": {"uniques": 39}}  // 15m+
        ]
      }]
    }
  }]
}
```

---

## Appendix C: Advanced Forecasting Topics

> **Status:** This appendix covers advanced topics that extend the core survival analysis framework (§5). The core formula (§5.3) and distribution fitting (§5.4) are required for implementation; these extensions are optional enhancements.

### C.1 Recency-Weighted \(p_\infty\) Estimation

> **Status:** Deferred feature. Initial implementation uses simple unweighted average of mature cohorts (§5.6). This section specifies the recency-weighted enhancement.

**New config field (add to `LatencyConfig` when implementing):**
```typescript
recency_half_life_days?: number;  // Default: 30
recency_half_life_days_overridden?: boolean;
```

**Weight function:**

For each mature cohort with entry date \(d_i\), define:
\[
w_i = \exp\left(-\frac{T_{\text{query}} - d_i}{H}\right)
\]

Where \(H\) is `recency_half_life_days` (default 30). A cohort \(H\) days old has half the weight of a brand-new cohort.

**Weighted estimator:**
\[
p_\infty = \frac{\sum_i w_i \cdot k_i}{\sum_i w_i \cdot n_i}
\]

**Effective sample size guard:**
\[
N_{\text{eff}} = \frac{(\sum_i w_i \cdot n_i)^2}{\sum_i w_i^2 \cdot n_i}
\]

If \(N_{\text{eff}} < 100\), fall back to unweighted estimation or widen the window.

#### C.1.1 Implementation Notes

**Goal:** Make \(p_\infty\) a **moving, recency-weighted quantity** that updates smoothly as new data arrives.

**Architecture:**

- **Retrieval time:** Compute and store `forecast_mean`, `forecast_stdev` per slice.
- **Query time:** Use stored `forecast_mean` as \(p_\infty\) in Formula A (§5.3).

**Recency weighting is applied at retrieval time**, not query time. Each fetch recomputes `forecast_mean` with current weights, so the graph viewer sees smooth evolution without needing new query-time formulas.

**Code insertion points:**

- **`statisticalEnhancementService.ts`:** Extended to encapsulate:
  - Recency weighting logic
  - Effective sample size calculation
  - Low-confidence flagging
  
- **`dataOperationsService.getFromSource()`:** Call `statisticalEnhancementService.computeRecencyWeightedForecast()` at retrieval time.

**Data model (additions when implementing):**

| Field | Location | Purpose |
|-------|----------|---------|
| `recency_half_life_days` | `p.latency` | Config (default 30) |
| `recency_half_life_days_overridden` | `p.latency` | Override flag |
| `effective_sample_size` | `values[].latency` | Optional, for diagnostics |

**Note:** `forecast_mean` and `forecast_stdev` already exist in `values[]` from the core spec.

**Semantic linting integration:**

- Warn when \(N_{\text{eff}} < 100\) ("shallow data")
- Warn when no mature cohorts exist ("no baseline")

#### C.1.2 Recency Bias UI & Config

**Concept:** Recency bias controls how much the forecast baseline favours recent mature cohorts over older ones. Parameterised as **half‑life in days**: a cohort \(H\) days older than the newest gets half the weight.

**Values:**

| Half-life | Behaviour |
|-----------|-----------|
| 7 days | Aggressive: recent week dominates |
| 30 days | Gentle: default |
| 90 days | Stable: historical data weighted heavily |

### C.2 Alternative Parametric Families (Weibull, Gamma)

> **Status:** Deferred feature. Initial implementation uses a log-normal fit (§5.4.2). This section sketches alternative parametric families that may better capture certain lag shapes (e.g. deadline effects) and how they would be fitted.

#### C.2.1 Weibull Distribution

For edges where log-normal fits poorly (e.g., operational processes with deadlines), a Weibull CDF is a natural alternative:

\[
F(t) = 1 - e^{-(t/\lambda)^k}
\]

Where \(\lambda\) is scale (characteristic time) and \(k\) is shape:
- \(k < 1\): decreasing hazard (early converters more likely)
- \(k = 1\): constant hazard (exponential)
- \(k > 1\): increasing hazard (deadline effects)

Fitting would proceed from median and mean using numerical methods (e.g. scipy), with the same interfaces as the log-normal fit (exposing \(F(t)\), \(S(t)\), and \(T_{95}\)).
| ∞ (Off) | Unweighted average |

**Config hierarchy (standard override pattern):**

```
Effective H = 
  p.latency.recency_half_life_days  if  recency_half_life_days_overridden
  else param_file.latency.recency_half_life_days  if  present
  else workspace_default (View menu slider)
  else 30 (hardcoded fallback)
```

**Data model (param file, top-level `latency` block):**

```yaml
latency:
  maturity_days: 30
  recency_half_life_days: 30              # NEW (optional)
  recency_half_life_days_overridden: false # NEW (optional)
```

Follows standard `_overridden` pattern.

**UI locations:**

1. **View menu → Slider (global default)**

   Use existing slider component pattern (like Global/Local mass toggle):
   ```
   View
   ├─ ...existing items...
   ├─ ─────────────────
   ├─ Recency Bias     [=========●====] 30d
   │                   7  14  30  60  90  180  Off
   │                   ← more bias    less bias →
   └─ ...
   ```
   
   - Inline slider directly in View menu (no modal).
   - **Discrete notches** (not continuous): 7d, 14d, 30d, 60d, 90d, 180d, Off.
   - Left = aggressive (7d, recent data dominates).
   - Right = flat ("Off" = unweighted average).
   - Default notch: 30d.
   - Writes to workspace settings.
   - Takes effect on **next fetch**.

2. **Properties Panel → Edge → Latency section (per-edge override)**

   Single-line slider alongside other latency fields:
   ```
   Maturity:  [30] days
   Recency:   [==●====] 30d [↺]
   ```
   
   - Same discrete notches as View menu slider.
   - Slider follows existing override patterns used elsewhere in edge props.
   - `[↺]` reset button clears override (reverts to global).
   - Moving slider sets `recency_half_life_days_overridden = true`.

**Retrieval-time flow:**

1. `dataOperationsService.getFromSource()` is called for a latency edge.
2. Read `effective_H` from edge config (with override) or workspace default.
3. Pass to `statisticalEnhancementService.computeRecencyWeightedForecast(cohorts, effective_H)`.
4. Helper returns `forecast_mean`, `forecast_stdev`, `N_eff`.
5. Write to `values[].forecast_mean`, `values[].forecast_stdev`.

**Query-time flow:**

- Read `forecast_mean` from param file, apply Formula A (§5.3).

**Implementation checklist:**

- [ ] Add `recency_half_life_days`, `recency_half_life_days_overridden` to types/schemas
- [ ] Add workspace setting `defaultRecencyHalfLifeDays`
- [ ] Add slider to View menu (reuse existing slider component)
- [ ] Add slider to Properties Panel latency section (with override pattern)
- [ ] Extend `statisticalEnhancementService.ts` with `computeRecencyWeightedForecast()`
- [ ] Update `dataOperationsService.getFromSource()` to call `statisticalEnhancementService`
- [ ] Update UpdateManager for `recency_half_life_days` (edge ↔ param file)

### C.2 Convolution Fallback for Window Queries

When `window(t1:t2)` is requested for a latency edge but only A-anchored `cohort_data` is available, convolve to find which A-cohorts contribute X-events in the window.

Let \(g(s)\) = A→X lag PDF and \(h(t)\) = X→Y lag PDF.

Users starting X in window \([t_1, t_2]\) from A-cohort date \(d\):

\[
n_{X,d} = n_d \cdot p_{A \to X} \cdot \int_{t_1-d}^{t_2-d} g(s) \, ds
\]

This is approximate because it uses expected A→X lag rather than the full distribution.

### C.3 Short-Horizon Histogram Use (Amplitude 0–10d Bins)

Amplitude provides **lag histograms up to 10 days** (binned counts by lag day plus a tail bucket). The current core design deliberately **does not** use these histograms in the main survival analysis pipeline:

- Core lag fitting (§5.4) uses `median_lag_days[]` and `mean_lag_days[]` per cohort to fit a log-normal CDF.
- Histograms are **stored in param files** (`values[].latency.histogram`, `anchor_latency.histogram`) but not used in Formula A or completeness calculations.

**Potential enhancement (future work):**

- For edges where the **median lag is short** (e.g. < 5–6 days, certainly < 10 days), the 0–10d histogram contains most of the mass and could support a more nuanced lag model:
  - Build a **discrete CDF / PMF** directly from histogram bins for 0–10d.
  - Use that discrete CDF instead of a parametric log-normal when computing \(F(t)\), \(S(t)\), completeness, and \(T_{95}\) in the short-lag regime.
  - For longer lags, fall back to the log-normal fit based on `median_lag_days` / `mean_lag_days`.
- This would require:
  - A retrieval-time choice of lag model based on observed median/mean lag and histogram support.
  - A small extension to `statisticalEnhancementService` to construct a discrete CDF from bins and expose it via the same `F(t)` / `S(t)` interface.

For now, histograms are **“stored but unused”** by the MVP; this section records the intended future use so the data is not accidentally dropped or repurposed.

### C.4 Bayesian Hierarchical Model

For full uncertainty quantification, fit a survival model to cohort maturation curves. Each cohort provides censored survival data: \(n\) users entered, \(k_{\text{by lag } t}\) converted by lag \(t\), right-censored at last observed lag.

**Hierarchical structure:** Pool across context slices with shared hyperpriors:
- Population level: \(\mu_{\text{pop}}, \sigma_{\text{pop}}\) (mean/variance of log-normal parameters)
- Context level: \(\mu_c, \sigma_c\) drawn from population distribution

**Output:** Posterior summaries including:
- \(T_{\text{med}}\) with credible intervals
- PMF by day for convolution
- Full uncertainty propagation to \(\hat{k}_i\)

### C.5 Time-Indexed Forward Pass

With fitted lag distributions, the DAG runner computes arrivals by day via convolution:

1. Seed entry nodes on day 0
2. For each time step \(t\), for each edge:
   - Source mass at time \(t\)
   - Multiply by edge probability \(p\)
   - Spread arrivals across future days according to lag PMF
3. Output: `{node_id: [mass_day_0, mass_day_1, ...]}` arrivals by day

**Monte Carlo uncertainty:** Sample from posterior distributions and aggregate runs to produce mean and credible intervals (fan charts).

### C.6 Competing Risks for Sibling Edges

When multiple edges leave the same node (siblings), they compete for the unconverted pool. The independent application of Formula A (§5.3) can overcount.

**Proper treatment:** Model as a competing risks survival problem where:
- Each user either converts on edge A, edge B, or neither
- The "winning" edge is the one with shortest lag (if any)

**Simplification (usually sufficient):** If sibling edge lags are independent and don't overlap significantly in time, the overcount is small. Monitor `Σ p.mean` and warn if > 1.05.

### C.7 Formula Summary Table

| Formula | Section | Purpose |
|---------|---------|---------|
| Formula A (Bayes) | §5.3 | Per-cohort tail forecasting |
| Log-normal CDF | §5.4 | Lag distribution model |
| Completeness | §5.5 | Expected fraction observed |
| Recency-weighted \(p_\infty\) | §5.6, C.1 | Stable baseline with decay |
| Convolution fallback | C.2 | Window queries from cohort data |
| Hierarchical Bayes | C.3 | Full uncertainty quantification |
| Time-indexed convolution | C.4 | Temporal runner simulation |

---

## Appendix D: Related Documents

- `notes.md` — Previous discussion summary (6 conceptual areas)
- `data-fetch-refactoring-proposal.md` — Data retrieval architecture
- `data-retrieval-detailed-flow.md` — Current fetch implementation

---

## Appendix E: Incremental Design Documents (7-Dec-25 to 10-Dec-25)

During implementation, several incremental design documents were created to address specific issues that emerged during testing and refinement. These documents supplement the core design and should be consulted for detailed rationale on specific subsystems.

All paths below are relative to `docs/current/project-lag/` unless otherwise noted.

### E.1 LAG Statistics Reference (Canonical)

**Location:** `graph-editor/public/docs/lag-statistics-reference.md`

The canonical reference for LAG statistics and convolution logic. Includes:
- Visual schematics of data flow from Amplitude to blended probabilities
- Mathematical foundations for completeness, forecasting, and blending
- Scenario and what-if interaction semantics
- Detailed section-by-section breakdown of all LAG concepts

**Key sections:**
- §3: Lag fitting (μ, σ, t95)
- §4: Completeness calculation
- §5: p.forecast.mean and p∞ estimation
- §6: Inbound-N convolution (p.n flow)
- §7: Blend formula (p.mean)
- §8: path_t95 calculation
- §11: Scenario/what-if interactions

### E.2 Inbound-N Ontology

**Location:** `docs/current/project-lag/inbound-n-fix.md`

Specifies the semantics for `p.n` (forecast population) and `p.forecast.k` (expected converters) on downstream latency edges:
- Why raw anchor counts or partial arrivals are inadequate as edge population
- The step-wise convolution model for propagating expected arrivals
- Relationship between `p.n`, `p.mean`, and `p.forecast.k`

**Implementation plan:** `docs/current/project-lag/inbound-n-implementation.md`

### E.3 Forecast Blending Fix

**Location:** `docs/current/project-lag/forecast-fix.md`

Specifies the blend formula for `p.mean` from evidence and forecast:
- The weighted average `p.mean = w × p.evidence + (1-w) × p.forecast`
- Derivation of evidence weight from completeness, n, and baseline sample size
- The `FORECAST_BLEND_LAMBDA` calibration constant
- Fallback behaviour when no forecast baseline exists

### E.4 LAG Fixes Implementation Plan

**Location:** `docs/current/project-lag/lag-fixes-implementation-plan.md`

Detailed implementation plan created 10-Dec-25 to address bugs discovered during testing:
- Phase 0: Design-driven tests (T1–T6) encoding correct behaviour
- Phase 1: Critical calculation fixes (effective age, analysis date)
- Phase 2: Design alignment (p∞ fallback, anchor lag wiring)
- Phase 3: Scenario correctness (active edges, path_t95)
- Phase 4–5: Recency weighting verification and documentation

**Status:** All phases complete as of 10-Dec-25.

### E.5 Incremental Test Plan

**Location:** `docs/current/project-lag/incremental-test-plan.md`

Systematic review of test coverage against the LAG statistics reference, with a phased proposal for additional tests:
- Phase A: Scenario / `conditional_p` testing (highest priority)
- Phase B: Recency weighting E2E
- Phase C: End-to-end golden path
- Phase D: Logging / observability
- Phase E: Complex topologies

### E.6 Latency Topological Pass Refactor

**Location:** `implemented/latency-topo-pass-implementation.md`

Implementation plan for computing t95, path_t95, and completeness in a single topological pass:
- Problem: completeness calculated before path_t95 exists
- Solution: unified topo pass in `statisticalEnhancementService`
- File responsibilities and change details

### E.7 Window Fetch Planner

**Location:** `implemented/window-fetch-planner-service.md` (high-level)  
**Detailed design:** `implemented/window-fetch-planner-detailed-design.md`  
**Implementation:** `implemented/window-fetch-planner-implementation-plan.md`

Design for intelligent fetch planning based on cached slice coverage:
- Slice family concepts and coverage analysis
- Auto-read vs explicit fetch decisions
- Maturity-aware refetch policy

### E.8 Cohort & Window Query Fixes

**Location:** `implemented/cohort-window-fixes.md`

Specifies the concrete test and code changes for window/cohort evidence semantics:
- `window()` evidence from dates inside requested window only
- `cohort()` evidence from cohorts inside requested cohort window only
- `p.forecast.*` may use best available baseline window

### E.9 Auto-Fetch Behaviour

**Location:** `implemented/auto-fetch-behaviour.md`  
**Redux:** `implemented/auto-fetch-redux.md`

Behavioural contract for when to auto-read from cache vs require explicit fetch:
- Slice family definitions
- Coverage determination rules
- MECE and context handling

### E.10 Retrieval Date Logic

**Location:** `implemented/retrieval-date-logic-implementation-plan.md`  
**Redux:** `implemented/retrieval-date-logic-redux.md`

Analysis and implementation of retrieval windows, maturity, and staleness decisions:
- t95 vs maturity_days usage
- path_t95 for downstream edges
- Horizon and caching decisions

### E.11 Design Delta & Gap Analysis

**Location:** `implemented/design-delta.md`

Documents where implementation diverges from design, specifically:
- Write-side caching and merge policy
- Canonicalisation of `sliceDSL` and date bounds
- What is implemented vs what remains

### E.12 Scope Review Summary

**Location:** `implemented/scope-review-summary.md`

Documents which portions of design.md have been deeply reviewed:
- ~40% of Phase C3 (Data Storage & Aggregation) reviewed
- ~20% of Phase C4 (Edge Rendering) reviewed
- Core DSL parsing, Amplitude adapter, UI rendering not yet reviewed

### E.13 Residual Open Issues

**Location:** `implemented/residual-open-issues.md`

Synthesised from earlier issue trackers, verified against design:
- Amplitude rate limits (monitor)
- Mock Amplitude data generator (future)
- Other resolved and deferred items

### E.14 Lag Fixes Proposal (Superseded)

**Location:** `lag-fixes.md`

Earlier proposal for wiring fixes between param files, graph edges, and param packs. Largely superseded by `lag-fixes-implementation-plan.md` but contains useful context on the distinction between query-time and retrieval-time values.

---

*End of Design Document*

