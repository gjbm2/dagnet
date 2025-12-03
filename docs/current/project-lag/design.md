# Project LAG: Latency-Aware Graph Analytics

**Status:** Design Draft  
**Created:** 1-Dec-25  
**Last Updated:** 2-Dec-25  

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

### 3.1 Edge Schema Additions

```typescript
interface GraphEdge {
  // ... existing fields ...
  
  // Latency configuration (NEW)
  latency?: LatencyConfig;
  
  // Rename: cost_time → labour_cost
  labour_cost?: CostParam;  // Human effort in hours/days
  
  // NOTE: Rename cost_time → labour_cost via global search/replace
}

interface LatencyConfig {
  /** Whether to track latency for this edge */
  track: boolean;
  
  /** Maturity threshold in days - cohorts younger than this are "immature"
   *  Default: 30 days (per-edge setting)
   */
  maturity_days?: number;  // Default: 30
  
  /** Censor time in days - ignore conversions after this lag */
  censor_days?: number;  // Default: 14 or 28 depending on edge type

  /** Recency half-life (days) for weighting cohorts when fitting forecast model.
   *  Phase 1 heuristic: favour more recent mature cohorts when updating p_mean,
   *  but retain enough history for stability. Optional; not user-exposed initially.
   */
  recency_half_life_days?: number;  // Default: 30 (if omitted)
  
  /** Inferred distribution parameters
   *  Phase 0: empirical summaries only
   *  Phase 1+: parametric fit (lognormal/weibull) for forecasting
   */
  distribution?: {
    family: 'lognormal' | 'weibull' | 'gamma' | 'discrete';
    params: {
      mu?: number;      // Location (lognormal)
      sigma?: number;   // Scale (lognormal)
      alpha?: number;   // Shape (weibull/gamma)
      beta?: number;    // Scale (weibull) / Rate (gamma)
      hazards?: number[]; // Discrete hazard rates by day
                          // Use for operations-driven spikes (e.g., "nudge email on day 14")
    };
    credible_interval?: [number, number];  // 90% CI for median lag
  };
  
  /** Override: manually specified median lag (days) */
  median_days?: number;
  median_days_overridden?: boolean;
}
```

### 3.2 Parameter File Additions (Phase 0: A‑anchored cohort evidence)

For edges with `latency.track: true`, parameter files store **A‑anchored per‑cohort evidence** plus edge‑level latency summaries. The structure **extends the existing parameter schema pattern** (flat parallel arrays, `window_from`/`window_to`, `data_source` object) with new latency fields.

```yaml
# parameter-{edge-id}.yaml  (example: A=HouseholdCreated, X=SwitchRegistered, Y=SwitchSuccess)
id: switch-registered-to-success
name: Switch Registered → Success
type: probability

# Edge-level latency configuration (see §3.1)
latency:
  track: true
  maturity_days: 30

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
      median_days: 6.0               # Weighted median X→Y lag
      mean_days: 7.0                 # Weighted mean X→Y lag
      completeness: 1.0              # Maturity progress 0-1 (see §5.0.1)
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
      median_days: 11.4
      mean_days: 12.3
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

# Anchor node reference (for multi-step funnel queries)
anchor:
  node_id: household-created
  description: Graph node used as cohort anchor (resolved to event at query time)

metadata:
  description: X→Y edge from 3-step A→X→Y funnel
  created_at: '2025-12-02T00:00:00Z'
  author: amplitude-import
  version: '1.0.0'
```

**Notes:**

- **Flat parallel arrays**: `dates`, `n_daily`, `k_daily`, `median_lag_days`, `mean_lag_days`, `anchor_n_daily`, `anchor_median_lag_days`, `anchor_mean_lag_days` are all parallel arrays indexed by cohort date. This aligns with the existing schema pattern.
- **Anchor data** (`anchor_*` arrays) is only present for multi-step funnels (A→X→Y) where we need upstream lag for convolution. For 2-step funnels, these fields are absent.
- The **forecast baseline** for X→Y is derived from `latency.median_days`, `latency.mean_days` and the `histogram`, refined by Phase 1 inference logic (§5).
- The script `amplitude_to_param.py` generates this format from Amplitude funnel responses.

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
  track: true
  maturity_days: 30  # Cohorts <30 days old are "immature"
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

When the pinned DSL (e.g., `or(window(-7d:), cohort(-90d:)).context(channel)`) contains **both** `window()` and `cohort()` clauses, and the edge has `latency.track=true`:

1. **Cohort slice** (A-anchored):
   - Fetch 3-step funnel `[A → X → Y]` for the cohort range.
   - Store using flat arrays (`dates`, `n_daily`, `k_daily`, `median_lag_days`, `anchor_*`) plus `latency` and `anchor_latency` blocks (as per §3.2).
   - Used for `cohort(...)` queries and for building the edge-level model (p*, lag CDF).

2. **Window slice** (X-anchored):
   - Fetch 2-step funnel `[X → Y]` for the window range.
   - Store using same flat-array pattern (`dates`, `n_daily`, `k_daily`), no anchor data needed.
   - Used for `window(...)` queries — gives "raw recent events" at this edge.

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
    median_lag_days: [6.0, 6.0, ...]
    anchor_n_daily: [575, 217, ...]
    anchor_median_lag_days: [14.8, 16.2, ...]
    latency: { median_days: 6.0, mean_days: 7.0, completeness: 1.0, ... }
    anchor_latency: { ... }
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
    data_source:
      type: amplitude
      retrieved_at: '2025-12-02T00:00:00Z'
```

**Query resolution:**

| Query | Edge has `latency.track=true`? | Resolution |
|-------|-------------------------------|------------|
| `cohort(...)` | Yes | Use cohort slice (A-anchored); slice by date, aggregate n/k |
| `cohort(...)` | No | Treat as `window()` (existing logic) |
| `window(...)` | Yes, and window slice exists | Use window slice (X-anchored); slice by date |
| `window(...)` | Yes, but no window slice | Fall back to model-based convolution from cohort slice + lag CDF |
| `window(...)` | No | Existing `window()` logic (n_daily/k_daily by event date) |

**Implications:**

- **Pinned DSL design matters:** To get both cohort and window views for a latency edge, the pinned DSL must include both `cohort(...)` and `window(...)` clauses (e.g., `or(window(-30d:), cohort(-90d:))`).
- **Amplitude query count:** For latency edges with dual slices, we make two Amplitude calls per context slice (one 3-step, one 2-step). This is acceptable given the distinct use cases.
- **Non-latency edges are unchanged:** `cohort()` on a non-latency edge is just an alias for `window()`.

### 4.7 Canonical sliceDSL, Maturity Calculation, and Cache Policy

#### 4.7.1 Canonical sliceDSL Format

**IMPORTANT:** The `sliceDSL` stored in param files is a **canonical label**, not a copy of the pinned query. It must fully identify the slice independent of graph context.

**Problem:** User pins `cohort(-90d:)` for a graph where START = `household-created`. The Amplitude query is constructed using that anchor. But the *param file* is shared — another graph with different START might incorrectly use this cohort data.

**Solution:** `sliceDSL` must include:
1. **Absolute dates** (not relative)
2. **Explicit anchor node_id** for cohort slices
3. **All context clauses**

**Canonical format:**
```
cohort(<anchor_node_id>,<start>:<end>)[.context(...)]
window(<start>:<end>)[.context(...)]
```

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

Where:
- **X→Y maturity** = `edge.latency.maturity_days` (configured on the edge)
- **A→X maturity** = max sum of `maturity_days` across all paths from anchor A to X

**Algorithm: Longest path in DAG**

```python
def compute_a_x_maturity(graph, anchor_id, x_id):
    """
    Find max maturity path from anchor to x.
    Conservative: uses longest path to ensure all conversions have matured.
    """
    # Topological sort (graph is a DAG)
    topo_order = topological_sort(graph)
    
    # DP: max maturity to reach each node from anchor
    max_maturity = {node: -inf for node in graph.nodes}
    max_maturity[anchor_id] = 0
    
    for node_id in topo_order:
        if max_maturity[node_id] == -inf:
            continue  # Unreachable from anchor
        
        for edge in outgoing_edges(node_id):
            edge_mat = edge.latency.maturity_days if edge.latency?.track else 0
            max_maturity[edge.to] = max(
                max_maturity[edge.to],
                max_maturity[node_id] + edge_mat
            )
    
    return max_maturity[x_id]

# Total maturity for edge X→Y with anchor A
total_maturity = compute_a_x_maturity(graph, anchor_id, x_id) + xy_edge.latency.maturity_days
```

**Example:**
```
Graph: A --[10d]--> B --[7d]--> X --[30d]--> Y
       A --[5d]---> C --[15d]-----> X

Path A→B→X: 10 + 7 = 17 days
Path A→C→X: 5 + 15 = 20 days

A→X maturity = max(17, 20) = 20 days
Total maturity = 20 + 30 = 50 days
```

**Edge cases:**
- A = X (direct edge): A→X maturity = 0
- Non-latency edges: maturity_days = 0
- X unreachable from A: error (invalid anchor)

**Future optimisation:** Instead of sum of maturity_days, convolve the actual latency distributions for a tighter estimate. Deferred to Phase 1+ as the conservative approach is simpler and the calculation only affects caching, not the actual cohort data which is A-anchored anyway.

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
  1. Any immature cohorts need updating
  2. Stale data (last fetch > N hours ago)
  3. Explicit user refresh

On merge:
  - Replace entire slice (cohort data is holistic)
  - Update sliceDSL bounds to reflect actual coverage
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

**Implementation sketch:**
```typescript
function shouldRefetch(slice: ParamSlice, edge: Edge, graph: Graph): RefetchDecision {
  if (!edge.latency?.track) {
    return { type: 'gaps_only' };  // Current incremental logic
  }
  
  const isCohort = slice.sliceDSL.includes('cohort(');
  
  if (isCohort) {
    const totalMaturity = computeTotalMaturity(graph, edge);
    const hasImmatureCohorts = slice.dates.some(d => 
      daysSince(d) < totalMaturity
    );
    const isStale = hoursSince(slice.data_source.retrieved_at) > REFRESH_HOURS;
    
    if (hasImmatureCohorts || isStale) {
      return { type: 'replace_slice' };
    }
    return { type: 'use_cache' };
  }
  
  // Window with latency
  const maturityDays = edge.latency.maturity_days;
  return { 
    type: 'partial',
    matureCutoff: daysAgo(maturityDays + 1),  // Re-fetch after this date
  };
}
```

---

## 5. Inference Engine

### 5.0 Quick & Dirty: Mature/Immature Split (Phase 0)

**Core problem:** If typical conversion takes 30-45 days and we query "last 7 days", we have almost no observed conversions. But p ≠ 0—we need to forecast using historical data.

**Solution:** Separate cohorts by maturity and treat them differently:

```python
def compute_edge_probability_with_forecast(
    daily_cohorts: List[Tuple[date, int, int]],  # (cohort_date, n, k)
    current_date: date,
    maturity_days: int = 45,
    prior_p: float = 0.5  # Fallback if no mature data
) -> dict:
    """
    Compute p from mature cohorts, forecast immature cohorts.
    
    For 30-45 day conversions, "last 7 days" has almost no signal.
    We use mature cohorts (>45 days old) for the probability estimate,
    and apply that rate to forecast what immature cohorts will do.
    """
    mature_n, mature_k = 0, 0
    immature_n, immature_k = 0, 0
    
    for cohort_date, n, k in daily_cohorts:
        age = (current_date - cohort_date).days
        if age >= maturity_days:
            mature_n += n
            mature_k += k
        else:
            immature_n += n
            immature_k += k  # Partial conversions so far
    
    # p comes from MATURE cohorts only (they've had time to convert)
    if mature_n > 0:
        p = mature_k / mature_n
    else:
        p = prior_p  # No mature data: fall back to prior
    
    # Forecast: project immature cohorts at mature rate
    immature_forecast_k = immature_n * p
    
    total_n = mature_n + immature_n
    
    return {
        'p': p,                                    # Rate from mature cohorts
        'p_source': 'mature' if mature_n > 0 else 'prior',
        
        # Mature cohorts: actual data
        'mature_n': mature_n,
        'mature_k': mature_k,
        
        # Immature cohorts: observed + forecast
        'immature_n': immature_n,
        'immature_k_observed': immature_k,          # What we've seen so far
        'immature_k_forecast': immature_forecast_k, # What we expect eventually
        
        # Combined
        'total_n': total_n,
        'total_k_observed': mature_k + immature_k,
        'total_k_forecast': mature_k + immature_forecast_k,
        
        # Coverage: how much of our window is mature?
        # (Phase 0 approximation; see §5.0.1 for the refined latency.completeness definition.)
        'completeness': mature_n / total_n if total_n > 0 else 0
    }
```

**Example:**

| Window | Cohort Age | n | k (observed) | Treatment |
|--------|------------|---|--------------|-----------|
| 60 days ago | 60 | 100 | 45 | Mature: use actual k |
| 45 days ago | 45 | 120 | 52 | Mature: use actual k |
| 7 days ago | 7 | 80 | 3 | Immature: forecast using mature p |
| 2 days ago | 2 | 90 | 0 | Immature: forecast using mature p |

Mature p = (45+52)/(100+120) = 44.1%

Immature forecast: (80+90) × 44.1% = 75 expected conversions

**Display:**
- Solid bar: observed conversions (97 + 3 = 100)
- Hatched bar: forecast (75 more expected)
- Total forecast: 175 of 390 users

**What this gives us:**
- Usable p estimates even for fresh windows
- Clear separation of "known" vs "projected"
- No complex fitting required
- Works as soon as we have some mature cohorts

**Bonus: Latency from dayMedianTransTimes**

Amplitude also returns per-cohort median/avg conversion times:

```python
def estimate_latency_from_amplitude(response: dict) -> dict:
    """
    Extract latency estimate from Amplitude's time stats.
    
    Uses median conversion times across cohorts (weighted by k).
    """
    series = response['dayMedianTransTimes']['series']
    day_funnels = response['dayFunnels']['series']
    
    weighted_sum = 0
    total_k = 0
    
    for i, (n, k) in enumerate(day_funnels):
        median_ms = series[i][1]  # Second value is the transition time
        if median_ms > 0 and k > 0:
            weighted_sum += median_ms * k
            total_k += k
    
    if total_k > 0:
        weighted_median_ms = weighted_sum / total_k
        median_days = weighted_median_ms / (1000 * 60 * 60 * 24)
    else:
        median_days = None
    
    return {
        'median_ms': weighted_median_ms if total_k > 0 else None,
        'median_days': median_days,
        'sample_size': total_k
    }
```

This gives us a quick latency estimate without needing maturation curves.

**Limitations (addressed by full model later):**
- Assumes stable p across cohorts (no trend)
- No confidence intervals
- No per-cohort maturation curve (just final p)
- Latency estimate is aggregate, not per-cohort

#### 5.0.1 Edge-Level Summary Stats (MVP, pre-Bayes)

Before full survival modelling, we expose a small set of **edge-level latency stats** derived from Amplitude:

1. **Typical lag (`latency.median_days`)**
   - Definition: weighted median time-to-convert (days) across all cohorts in the parameter window.
   - Computation: as in `estimate_latency_from_amplitude()` above:
     - Use `dayMedianTransTimes.series[i][1]` as per-cohort medians (ms).
     - Weight by `k_i` from `dayFunnels.series[i] = [n_i, k_i]`.
     - Ignore cohorts with `k_i = 0` or `median_ms <= 0`.

2. **Completeness / maturity progress (`latency.completeness`)**
   - Intuition: \"How far along are the current cohorts, relative to the typical lag?\"  
   - For each cohort \(i\):
     - Age in days: \(a_i = (\text{query\_date} - \text{cohort\_date}_i)\).
     - Typical lag: \(T_{\text{med}} = \text{latency.median\_days}\).
     - Define per-cohort progress:
       \[
       \text{progress}_i = \min\left(1,\ \frac{a_i}{T_{\text{med}}}\right)
       \]
   - Let \(n_i\) be the cohort size from `dayFunnels.series[i][0]`. Define:
     \[
     \text{latency.completeness} = \frac{\sum_i n_i \cdot \text{progress}_i}{\sum_i n_i}
     \]
   - Properties:
     - 0 if all cohorts are brand new.
     - 1 if all cohorts are at least one median-lag old.
     - Smooth 0–1 measure that does not depend on an arbitrary age threshold.

3. **Sample context**
   - We re-use existing `n`/`k` from parameter values for context:
     - `n = \sum_i n_i`
     - `k = \sum_i k_i`
   - UI can grey-out latency displays when `n` and/or `k` are very small.

#### 5.0.2 Evidence vs Forecast Policy (Phase 1)

Phase 1 introduces a clearer separation between **evidence** and **forecasting** for each latency‑tracked edge:

1. **Ingestion-time triage**
   - For each cohort row \(i\) in `cohort_data` at ingestion date \(T_{\text{ingest}}\):
     - Compute age: \(a_i = T_{\text{ingest}} - \text{cohort\_date}_i\).
     - Mark cohort as **mature enough for model fitting** if:
       - \(a_i \ge \text{latency.median\_days} + \delta\) (e.g. \(\delta = 0\)–7 days), and
       - \(a_i \le W_{\max}\) (e.g. 90–120 days) to avoid using very old data where behaviour may have drifted.
   - Only these mature cohorts contribute to the **forecast baseline** parameters for the edge.

2. **Recency-weighted model fitting**
   - Within the “mature but not ancient” set, we favour more recent cohorts when estimating the long‑run \(p_\star\) for X→Y:
     - For each mature cohort \(i\), define a recency weight \(w_i\), e.g. exponential:
       \[
       w_i = \exp\left(-\frac{T_{\text{ingest}} - t_i}{H}\right)
       \]
       where \(t_i\) is the cohort date and \(H\) is `latency.recency_half_life_days` (default ~30).
     - Estimate the **mature baseline probability**:
       \[
       p_\star = \frac{\sum_i w_i k_i}{\sum_i w_i n_i}
       \]
   - Guard against sparsity by requiring an effective sample size to exceed a minimum (e.g. 500–1000 users):
     \[
     N_{\text{eff}} = \frac{(\sum_i w_i n_i)^2}{\sum_i w_i^2 n_i}
     \]
     If \(N_{\text{eff}}\) is too small, widen \(W_{\max}\) or blend with a weaker long‑history prior.

3. **Query-time mixing of evidence and forecast**
   - For a query like `e.x-y.p.mean` under `cohort(-21d:)` at date \(T\):
     - Slice `cohort_data` rows whose A‑entry dates are in the requested window.
     - For each cohort \(i\) in the slice:
       - Keep observed conversions \(k_i\) as **hard evidence**.
       - Compute current age \(a_i = T - \text{cohort\_date}_i\).
       - Use the edge‑level lag CDF \(F(t)\) (from `latency.median_days` / histogram) to estimate what fraction of the eventual conversions should already have appeared at age \(a_i\).
       - Use \(p_\star\) and \(F(t)\) to **forecast the unobserved tail** for that cohort (without discarding early conversions that have already happened).
   - Aggregate across cohorts in the window:
     - Forecasted \(p_{\text{window}}\) is a cohort‑size‑weighted average of each cohort’s evidence+forecast estimate.
     - Window‑specific **completeness** is:
       \[
       \text{completeness}_{\text{window}} = \frac{\sum_i n_i \cdot \text{progress}_i}{\sum_i n_i}
       \]
       with \(\text{progress}_i\) defined as in §5.0.1.

4. **Bayesian upgrade (future)**
   - Phase 1 treats \(p_\star\) and \(F(t)\) as re‑estimated at ingestion time from mature cohorts only.
   - A future Bayesian enhancement would allow **immature cohorts to slowly update the model parameters** as well, by giving them a smaller maturity‑weighted contribution to the posterior for \(p_\star\) and the lag parameters.

#### 5.0.3 Draft Formulas for Forecasting (Phase 1)

The following are **draft formulas** for the Phase 1 forecasting logic. These require validation and refinement before implementation.

##### A. Per-Cohort Tail Forecasting

For an immature cohort \(i\) with:
- \(n_i\) users entered on cohort date
- \(k_i\) observed conversions so far
- Age \(a_i\) days since entry
- Edge lag CDF \(F(t)\) (probability of conversion by lag \(t\), given eventual conversion)
- Mature baseline probability \(p_\star\)

**The forecasted total conversions for cohort \(i\):**

\[
\hat{k}_i = k_i + (n_i - k_i) \cdot p_\star \cdot \frac{1 - F(a_i)}{1 - p_\star \cdot F(a_i)}
\]

**Derivation:**
- Of the \(n_i - k_i\) users who haven't converted yet:
  - Some will eventually convert (the "tail")
  - Some will never convert
- The probability that a user who hasn't converted by age \(a_i\) will eventually convert is:
  \[
  P(\text{convert} \mid \text{not yet converted by } a_i) = \frac{p_\star \cdot (1 - F(a_i))}{1 - p_\star \cdot F(a_i)}
  \]
- This uses Bayes' rule: not having converted by \(a_i\) could be because (a) you're a non-converter, or (b) you're a converter but slow.

**Simplified approximation (when \(p_\star \cdot F(a_i) \ll 1\)):**

\[
\hat{k}_i \approx k_i + (n_i - k_i) \cdot p_\star \cdot (1 - F(a_i))
\]

##### B. Window Probability from Cohort Data (Convolution Fallback)

When `window(t1:t2)` is requested for a latency edge but only A-anchored `cohort_data` is available, we need to **convolve** to find which A-cohorts contribute X-events in the window.

Let:
- \(g(s)\) = A→X lag PDF (from `anchor_latency.histogram`)
- \(h(t)\) = X→Y lag PDF (from `latency.histogram`)
- \(n_d\) = users entering A on date \(d\) (from `cohort_data[d].anchor_n`)

**Users starting X in window \([t_1, t_2]\):**

For each A-cohort date \(d\):
\[
n_{X,d}^{[t_1,t_2]} = n_d \cdot p_{A \to X} \cdot \int_{t_1 - d}^{t_2 - d} g(s) \, ds
\]

where the integral is the probability that A→X lag falls in the range that places the X-event within the window.

**Total X-starters in window:**
\[
N_X^{[t_1,t_2]} = \sum_d n_{X,d}^{[t_1,t_2]}
\]

**Conversions (X→Y) from these:**
\[
K_Y^{[t_1,t_2]} = \sum_d n_{X,d}^{[t_1,t_2]} \cdot p_{X \to Y} \cdot F_{X \to Y}(\text{age}_d)
\]

where \(\text{age}_d = T_{\text{query}} - (d + \mathbb{E}[g])\) is the approximate age of the X-event.

**Note:** This is approximate because:
- We're using expected A→X lag rather than the full distribution
- Histogram data is coarse (especially beyond 10 days)
- For better accuracy, use the X-anchored `window_data` slice when available (§4.6)

##### C. Aggregated Window Probability

For a `window(t1:t2)` query with X-anchored `window_data` available:

\[
p_{\text{window}} = \frac{\sum_{d \in [t_1, t_2]} k_d}{\sum_{d \in [t_1, t_2]} n_d}
\]

where \(n_d\) and \(k_d\) are from `window_data.n_daily` and `window_data.k_daily`.

**With forecast for immature days:**

\[
p_{\text{window}}^{\text{forecast}} = \frac{\sum_d (k_d + \hat{k}_d^{\text{tail}})}{\sum_d n_d}
\]

where \(\hat{k}_d^{\text{tail}}\) is the forecasted tail from formula A above.

##### D. Completeness for a Query Window

For any query (cohort or window), the **completeness** indicates how much is evidence vs forecast:

\[
\text{completeness}_{\text{query}} = \frac{\sum_d n_d \cdot \min(1, a_d / T_{\text{med}})}{\sum_d n_d}
\]

where:
- \(a_d\) = age of cohort/event on date \(d\)
- \(T_{\text{med}}\) = `latency.median_days` for the edge
- Sum is over all dates in the query window

##### E. Summary of Key Formulas

| Formula | Purpose | Inputs | Output |
|---------|---------|--------|--------|
| \(p_\star = \frac{\sum_i w_i k_i}{\sum_i w_i n_i}\) | Mature baseline probability | Mature cohorts, recency weights | Long-run conversion rate |
| \(w_i = \exp(-\frac{T - t_i}{H})\) | Recency weight | Cohort date \(t_i\), half-life \(H\) | Weight for cohort \(i\) |
| \(N_{\text{eff}} = \frac{(\sum w_i n_i)^2}{\sum w_i^2 n_i}\) | Effective sample size | Weighted cohorts | Sample size guard |
| \(\hat{k}_i = k_i + (n_i - k_i) \cdot p_\star \cdot \frac{1 - F(a_i)}{1 - p_\star F(a_i)}\) | Per-cohort forecast | Observed k, age, lag CDF | Forecasted conversions |
| \(\text{completeness} = \frac{\sum n_i \cdot \min(1, a_i/T_{\text{med}})}{\sum n_i}\) | Maturity progress | Cohort ages, median lag | 0–1 progress measure |

**Status:** These formulas are **draft** and require validation. In particular:
- The tail forecasting formula (A) assumes the lag CDF \(F(t)\) is well-estimated from histogram/median data.
- The convolution fallback (B) is approximate; prefer X-anchored `window_data` when available.
- The effective sample size formula uses the standard weighted variance adjustment.

---

### 5.1 Fitting Lag Distributions (Phase 1+)

For each latency-tracked edge, we fit a survival model:

```python
# Using scipy or PyMC for Bayesian inference
from scipy.stats import lognorm, weibull_min, gamma

def fit_lag_distribution(cohort_records: List[CohortRecord], family: str = 'lognormal'):
    """
    Fit lag distribution from cohort maturation curves.
    
    Each cohort provides censored survival data:
    - n users entered on cohort_date
    - k_by_lag[t] converted by lag t
    - Right-censored at last_observed_lag
    """
    # Pool all cohort observations
    observations = []
    for cohort in cohort_records:
        for lag, k in enumerate(cohort.k_by_lag):
            if lag == 0:
                continue  # Skip day 0 (no time to convert)
            delta_k = k - (cohort.k_by_lag[lag-1] if lag > 0 else 0)
            # delta_k users converted at exactly lag t
            observations.extend([lag] * delta_k)
        
        # Right-censored: n - k_final users haven't converted
        if not cohort.is_mature:
            # These are still at risk
            pass  # Handle in likelihood
    
    # MLE fit
    if family == 'lognormal':
        shape, loc, scale = lognorm.fit(observations, floc=0)
        return {'family': 'lognormal', 'mu': np.log(scale), 'sigma': shape}
    # ... other families
```

### 5.2 Bayesian Hierarchical Model (Full Version)

For production, we use a hierarchical model pooling across context slices:

```python
import pymc as pm

with pm.Model() as latency_model:
    # Hyperpriors (shared across contexts)
    mu_pop = pm.Normal('mu_pop', mu=1.0, sigma=1.0)
    sigma_pop = pm.HalfNormal('sigma_pop', sigma=0.5)
    
    # Per-context parameters
    mu_ctx = pm.Normal('mu_ctx', mu=mu_pop, sigma=0.3, shape=n_contexts)
    sigma_ctx = pm.HalfNormal('sigma_ctx', sigma=sigma_pop, shape=n_contexts)
    
    # Likelihood: k_{c,t} ~ Binomial(n_c, F_lognorm(t | mu_ctx[c], sigma_ctx[c]))
    for c, cohort in enumerate(cohorts):
        F_t = pm.math.switch(
            t > 0,
            0.5 * (1 + pm.math.erf((pm.math.log(t) - mu_ctx[c]) / (sigma_ctx[c] * pm.math.sqrt(2)))),
            0
        )
        pm.Binomial(f'k_{c}', n=cohort.n, p=F_t, observed=cohort.k_by_lag)
    
    trace = pm.sample(2000, tune=1000)
```

### 5.3 Output: Posterior Summaries

The inference engine outputs:

```yaml
latency:
  family: lognormal
  mu: 0.82
  mu_ci: [0.65, 0.98]
  sigma: 0.58
  sigma_ci: [0.48, 0.71]
  
  # Derived quantities
  median_days: 2.27
  median_days_ci: [1.92, 2.66]
  mean_days: 2.64
  p90_days: 5.83
  
  # Discrete PMF (for convolution)
  pmf_days: [0, 0.18, 0.31, 0.22, 0.13, 0.07, 0.04, 0.02, 0.01, ...]  # P(convert on day t)
  cdf_days: [0, 0.18, 0.49, 0.71, 0.84, 0.91, 0.95, 0.97, 0.98, ...]
```

---

## 6. DAG Runner Integration

### 6.1 Time-Indexed Forward Pass

With latency distributions, the runner computes **arrivals by day**:

```python
def time_indexed_run(graph: Graph, entry_cohort: Dict[str, float], horizon: int = 30) -> Dict[str, List[float]]:
    """
    Run DAG with latency convolution.
    
    Args:
        graph: DAG with edges containing latency distributions
        entry_cohort: {node_id: mass} entering on day 0
        horizon: Days to simulate
    
    Returns:
        {node_id: [mass_day_0, mass_day_1, ...]} arrivals by day
    """
    arrivals = {node: [0.0] * horizon for node in graph.nodes}
    
    # Seed entry nodes on day 0
    for node, mass in entry_cohort.items():
        arrivals[node][0] = mass
    
    # Forward pass with convolution
    for t in range(horizon):
        for edge in topological_order(graph.edges):
            source_mass = arrivals[edge.from_node][t]
            if source_mass == 0:
                continue
            
            p = edge.p.mean
            lag_pmf = edge.latency.pmf_days if edge.latency else [1.0]  # Instantaneous if no latency
            
            for lag, lag_prob in enumerate(lag_pmf):
                arrival_day = t + lag
                if arrival_day < horizon:
                    arrivals[edge.to_node][arrival_day] += source_mass * p * lag_prob
    
    return arrivals
```

### 6.2 Monte Carlo Uncertainty

For uncertainty bands (fan charts):

```python
def mc_time_indexed_run(graph: Graph, entry_cohort: Dict, horizon: int, samples: int = 1000):
    """Sample from posterior and aggregate."""
    runs = []
    for _ in range(samples):
        # Sample p from posterior
        sampled_graph = sample_parameters(graph)
        
        # Sample lag PMF from posterior (regenerate from mu, sigma samples)
        for edge in sampled_graph.edges:
            if edge.latency:
                mu_sample = np.random.normal(edge.latency.mu, edge.latency.mu_se)
                sigma_sample = np.abs(np.random.normal(edge.latency.sigma, edge.latency.sigma_se))
                edge.latency.pmf_days = lognorm_pmf(mu_sample, sigma_sample, horizon)
        
        runs.append(time_indexed_run(sampled_graph, entry_cohort, horizon))
    
    # Aggregate: mean, p5, p25, p75, p95
    return aggregate_runs(runs)
```

---

## 7. Core UI: Edge Rendering

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

Edge needs to expose:

```typescript
interface EdgeLatencyDisplay {
  // For edge width calculation
  p_total: number;           // mature_p applied to all cohorts
  p_mature: number;          // mature_p (same value, but based on mature evidence)
  
  // For layer widths
  completeness: number;      // 0-1 maturity progress (see §5.0.1)
  
  // For tooltips / properties panel
  median_lag_days?: number;  // From dayMedianTransTimes
  k_observed: number;        // Actual conversions
  k_forecast: number;        // Projected total conversions
}
```

### 7.3 View Preferences: Maturity Split Toggle

A view preference controls whether the mature/forecast split is visualised:

| Setting | Value |
|---------|-------|
| Name | `showMaturitySplit` |
| Default | **On** |
| Scope | **Per-tab** (not per-graph, not global) |
| Location | ViewMenu + Tools side panel (shared hook) |

When **off**, edges render with standard solid appearance (no stripe layers).

### 7.4 Edge Bead: Latency Display

A new bead displays latency information on edges with `latency.track: true`:

| Property | Value |
|----------|-------|
| Position | **Right-aligned** on edge (new bead position) |
| Format | **"13d (75%)"** — median lag + completeness (see §5.0.1) | *** WE MIGHT WANT TO SURRFACE ST DEV OR WHATEVER ON THE LAG DAYS TOO E.G. 13d+/-3 (75%) ***
| Show when | `latency.track === true` AND `median_lag_days > 0` |
| Colour | Standard bead styling (no new colour) |

### 7.5 Window Selector: Cohort Mode UI

The WindowSelector supports both `window()` and `cohort()` modes:

| Property | Value |
|----------|-------|
| Default mode | **Cohort** (in all cases) |
| Mode selector | Dropdown in WindowSelector component |
| Icons | `<Timer>` (Lucide) = cohort, `<TimerOff>` (Lucide) = window |
| Icon location | Left of date selector AND on context chip |
| Chip behaviour | Shows dropdown allowing mode switch |

**Visual indicators:**
- Cohort mode: Timer icon + "cohort(start:end)" in DSL
- Window mode: TimerOff icon + "window(start:end)" in DSL

### 7.6 Tooltips: Interim Approach

Full tooltip redesign is **deferred**. For now:
- Append latency text to existing tooltip content
- Format: "Lag: 13d | Maturity: 75%"

Future tooltip cleanup tracked in `/TODO.md`.

### 7.7 Properties Panel: Latency Settings

Latency configuration appears **within the Probability param section** of edge properties (not a separate section):

| Field | Type | Maps to |
|-------|------|---------|
| Calculate Latency | Boolean toggle | `edge.latency.track` |
| Cut-off Time | String input (e.g., "30d") | `edge.latency.maturity_days` |

**Note:** These are configuration settings, not read-only displays. Derived values (maturity_coverage, median_lag_days) are shown via edge bead and tooltip.

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
      median_lag_ms: null
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
- Consider whether completion curves require full maturation data (Phase 1+) or can work with aggregate latency (Phase 0)

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
| DSL parser (Python/JS) | Parses DSL into query components | Parse `cohort(start, end, maturity_days?)` |

**New DSL syntax:**
```
// Current (retained for event queries)
window(1-Nov-25:14-Nov-25)

// New (default for conversion edges)
cohort(1-Nov-25:7-Nov-25)

// maturity_days comes from edge.latency.maturity_days, not the DSL
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
      median_days: 6.0
      mean_days: 7.0
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
| `src/types/scenarios.ts` | Scenario type definitions | No change needed for latency |

**Clarification:** Latency configuration (`latency.track`, `latency.maturity_days`) is a **graph topology setting**, not a scenario parameter. It is NOT overridable per-scenario.

What IS scenario-visible (read-only):
- `p.evidence.maturity_coverage` — affects edge width split rendering
- `p.evidence.median_lag_days` — affects bead display

These are derived values computed from data, not configurable scenario overrides.

### 9.3 Data Flow: Cohort Mode

```
User selects edge → Properties Panel
         ↓
buildDslFromEdge() → DSL with cohort() clause
         ↓
dataOperationsService.getFromSourceDirect()
         ↓
DASRunner.execute() → connections.yaml adapter
         ↓
Amplitude API → dayFunnels + dayMedianTransTimes
         ↓
Transform: extract per-cohort n, k, latency
         ↓
Compute mature/immature split (based on cohort age)
         ↓
Store to parameter file (with cohort metadata)
         ↓
UpdateManager → push to graph edge
         ↓
ConversionEdge renders with two layers
```

### 9.4 Migration Considerations

**Backward compatibility:**
- `window()` DSL remains valid for event-based queries
- Existing parameter files without cohort metadata continue to work
- Edges without `latency.track: true` behave as before

**Default behavior change:**
- New fetches for conversion edges use `cohort()` by default
- User can override to `window()` for specific use cases

---

## 10. Implementation Plan

### CORE DELIVERY

#### Phase C1: Schema Changes

- [ ] Rename `cost_time` → `labour_cost` (global search/replace)
- [ ] Add `LatencyConfig` to edge schema (TS, Python, YAML)
- [ ] Extend parameter schema for cohort metadata + latency
- [ ] Add `latency` to `EdgeParamDiff` in scenarios

#### Phase C2: DSL & Query Architecture

- [ ] Implement `cohort()` DSL clause parsing
- [ ] Update `buildDslFromEdge.ts` to use `cohort()` for latency-tracked edges
- [ ] Modify Amplitude adapter `pre_request` for cohort mode
- [ ] Extract `dayMedianTransTimes` in response transform

#### Phase C3: Data Storage & Aggregation

- [ ] Store per-cohort latency in parameter files
- [ ] Implement mature/immature split computation
- [ ] Update `windowAggregationService` for cohort-aware aggregation
- [ ] UpdateManager mappings for latency fields

#### Phase C4: Edge Rendering

- [ ] Two-layer edge rendering (inner/outer with offset stripes)
- [ ] Edge data model: `maturity_coverage`, latency stats
- [ ] Properties panel: latency display section

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

## 10. Testing Strategy

### 10.1 Test Coverage Requirements

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
| Latency edge, cohort only | `latency.track: true` | `cohort(-90d:)` | 3-step A-anchored fetch; store `cohort_data` |
| Latency edge, window only | `latency.track: true` | `window(-7d:)` | 2-step X-anchored fetch; store `window_data` |
| Latency edge, dual slice | `latency.track: true` | `or(cohort(-90d:), window(-7d:))` | Both fetches; both data blocks stored |
| Non-latency edge, cohort | `latency.track: false` | `cohort(-90d:)` | Treat as `window()`; standard fetch |
| Latency edge, no anchor defined | `latency.track: true`, no `anchor.node_id` | `cohort(-90d:)` | Error or fallback to graph START node |

#### D. Window Aggregation Tests (`windowAggregationService.test.ts`)

| Test Case | Query | Data Available | Expected Resolution |
|-----------|-------|----------------|---------------------|
| `cohort()` on latency edge | `cohort(-60d:-30d)` | `cohort_data` present | Slice rows by A-date; return `Σk/Σn` |
| `window()` on latency edge, window_data exists | `window(-7d:)` | `window_data` present | Use X-anchored data directly |
| `window()` on latency edge, no window_data | `window(-7d:)` | Only `cohort_data` | Convolution fallback (or error?) |
| `cohort()` on non-latency edge | `cohort(-60d:-30d)` | Standard `n_daily/k_daily` | Treat as `window()` |
| Mixed query types | `cohort(-90d:)` then `window(-7d:)` | Both data blocks | Correct routing per query type |

#### E. Forecasting Logic Tests (`forecastService.test.ts` — new)

| Test Case | Inputs | Expected Output |
|-----------|--------|-----------------|
| Fully mature cohort | Age > median_days, observed k | `forecast_k = k` (no tail) |
| Fully immature cohort | Age = 0, k = 0 | `forecast_k = n * p_star` |
| Partially mature cohort | Age = median_days/2, some k | `forecast_k = k + tail` per formula A |
| Zero observed conversions | k = 0, age > 0 | Still forecasts tail based on p_star |
| Edge case: p_star = 0 | No mature conversions | Fallback to prior or error |
| Edge case: p_star = 1 | All mature users convert | `forecast_k = n` |

#### F. Completeness Calculation Tests

| Test Case | Cohort Ages | Median Days | Expected Completeness |
|-----------|-------------|-------------|----------------------|
| All mature | [60, 45, 30] | 30 | 1.0 |
| All immature | [5, 3, 1] | 30 | ~0.1 |
| Mixed | [60, 30, 7, 2] | 30 | Weighted average |
| Zero median (edge case) | [10, 5] | 0 | 1.0 (or error?) |
| Single cohort | [15] | 30 | 0.5 |

#### G. Recency Weighting Tests

| Test Case | Cohort Dates | Half-life | Expected Weights |
|-----------|--------------|-----------|------------------|
| All same age | [T-30, T-30, T-30] | 30 | Equal weights |
| Exponential decay | [T-60, T-30, T-0] | 30 | [0.135, 0.368, 1.0] (approx) |
| Very old cohort | [T-180] | 30 | Near-zero weight |
| Half-life = infinity | Any | ∞ | Equal weights |

#### H. Effective Sample Size Tests

| Test Case | Weights | n_i | Expected N_eff |
|-----------|---------|-----|----------------|
| Equal weights | [1, 1, 1] | [100, 100, 100] | 300 |
| One dominant | [1, 0.01, 0.01] | [100, 100, 100] | ~102 |
| All zero except one | [1, 0, 0] | [100, 100, 100] | 100 |

### 10.2 Integration Test Scenarios

These tests verify end-to-end behaviour across the full pipeline.

#### Scenario 1: Fresh Latency Edge Setup
1. Create edge with `latency.track: true`, `maturity_days: 30`
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

#### Scenario 5: Window Query Fallback to Convolution
1. Load param file with only `cohort_data` (no `window_data`)
2. Execute `window(-7d:)` query
3. **Verify:** Convolution fallback triggered
4. **Verify:** Warning/flag indicates approximate result

#### Scenario 6: Non-Latency Edge with cohort() Query
1. Load param file for edge with `latency.track: false`
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
5. **Time-varying p**: Different p_star across time periods (for drift detection tests)

---

## 11. Open Questions

### 9.1 Amplitude API Considerations

- **Rate limits:** Per-cohort queries may hit limits for long event windows
- **Retention endpoint:** May be more efficient than multiple funnel queries
- **Caching:** Should we cache raw Amplitude responses or derived data?

### 9.2 Stationarity Assumption

- Do lag distributions change over time?
- Should we support time-varying latency (e.g., weekday vs weekend)?
- How to detect non-stationarity and alert users?

### 9.3 Edge Cases

- **Zero-lag edges:** Click events with instant conversion
- **Multi-modal distributions:** Some edges may have two populations (fast/slow)
- **Heavy tails:** Users who convert after 30+ days—how to handle?

### 9.4 Interaction with Conditional Edges

- Should conditional edges (`conditional_p`) have per-condition latency?
- Or shared latency with condition-dependent p?

---

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

## Appendix B: Related Documents

- `notes.md` — Previous discussion summary (6 conceptual areas)
- `data-fetch-refactoring-proposal.md` — Data retrieval architecture
- `data-retrieval-detailed-flow.md` — Current fetch implementation

---

*End of Design Document*

