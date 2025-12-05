# Project LAG: Latency-Aware Graph Analytics

**Status:** Design Draft  
**Created:** 1-Dec-25  
**Last Updated:** 4-Dec-25  

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
  
  /** Censor time in days - ignore conversions after this lag */
  censor_days?: number;  // Default: 14 or 28 depending on edge type
  
  /** Anchor node for cohort queries - furthest upstream START node from edge.from
   *  Computed by MSMDC at graph-edit time (not retrieval time)
   */
  anchor_node_id?: string;
  /** True if user manually set anchor_node_id (vs MSMDC-computed) */
  anchor_node_id_overridden?: boolean;

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
  median_lag_days?: number;
  median_lag_days_overridden?: boolean;
}
```

### 3.2 Parameter File Additions (Phase 0: A‑anchored cohort evidence)

For edges with `latency.maturity_days > 0` (latency tracking enabled), parameter files store **A‑anchored per‑cohort evidence** plus edge‑level latency summaries. The structure **extends the existing parameter schema pattern** (flat parallel arrays, `window_from`/`window_to`, `data_source` object) with new latency fields.

```yaml
# parameter-{edge-id}.yaml  (example: A=HouseholdCreated, X=SwitchRegistered, Y=SwitchSuccess)
id: switch-registered-to-success
name: Switch Registered → Success
type: probability

# Edge-level latency configuration (see §3.1)
latency:
  maturity_days: 30  # >0 enables latency tracking (no separate 'track' field)

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
- The **forecast baseline** for X→Y is derived from `latency.median_lag_days`, `latency.mean_lag_days` and the `histogram`, refined by Phase 1 inference logic (§5).
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
   - Store using flat arrays (`dates`, `n_daily`, `k_daily`, `median_lag_days`, `anchor_*`) plus `latency` and `anchor_latency` blocks (as per §3.2).
   - Used for `cohort(...)` queries and for building the edge-level model (`p.forecast`, lag CDF).

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
    latency: { median_lag_days: 6.0, mean_lag_days: 7.0, completeness: 1.0, ... }
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
            edge_mat = edge.latency.maturity_days if (edge.latency?.maturity_days or 0) > 0 else 0
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

### 4.8 Query-Time vs Retrieval-Time Computation

**Critical distinction:** Some values are pre-computed at retrieval time; others must be computed fresh at query time.

| Value | When Computed | Why |
|-------|---------------|-----|
| `p.forecast` | **Retrieval time** | Stable baseline from mature data; doesn't depend on query window |
| `p.evidence` | **Query time** | Depends on which dates/cohorts fall in query window |
| `p.mean` (blended) | **Query time** | Depends on cohort ages at query time; Formula A runs per-cohort |

**Retrieval-time computation (fetch from source):**

Any fetch from source (manual or overnight batch "fetch all slices") triggers stats computation:

| Stat | Source | Stored On |
|------|--------|-----------|
| `p.forecast` | Mature cohorts in **window() slice only** | Slice in param file |
| `median_lag_days` | `dayMedianTransTimes` from Amplitude response | Slice in param file |
| `completeness` | Computed from cohort ages vs maturity_days | Slice in param file |
| `evidence.n`, `evidence.k` | Raw funnel counts | Slice in param file |

**Critical: `p.forecast` requires window() data.** The forecast baseline is computed from mature cohorts in window() slices (X-anchored, recent events). Cohort() slices (A-anchored) provide per-cohort tracking but NOT `p.forecast`.

**Extension (not Phase 0):** If only cohort() data exists, `p.forecast` could theoretically be derived by convolving cohort data with the lag distribution. This is deferred — Phase 0 simply shows `p.forecast` as unavailable when no window() slice exists.

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
  - Apply Formula A if immature
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
3. **Formula A needs current ages**: The tail forecast depends on `F(a_i)` which changes as cohorts mature

**Data flow by query type:**

| Query | Slice Used | p.evidence | p.forecast | p.mean |
|-------|-----------|------------|------------|--------|
| `window()` mature | window_data | QT: Σk/Σn | RT: p.forecast | = evidence |
| `window()` immature | window_data | QT: Σk/Σn | RT: p.forecast | QT: Formula A per day |
| `cohort()` mature | cohort_data | QT: Σk/Σn | RT: p.forecast | = evidence |
| `cohort()` immature | cohort_data | QT: Σk/Σn | RT: p.forecast | QT: Formula A per cohort |
| No window_data | — | Available | **Not available** | — |
| Non-latency edge | either | QT: Σk/Σn | = evidence | = evidence |

**QT** = Query Time, **RT** = Retrieval Time

**Phase 1 constraint:** If no `window()` query is pinned, `p.forecast` is unavailable. F-only and F+E visibility modes are disabled for affected edges. User must pin a `window()` query to enable forecast display.

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
        median_lag_days = weighted_median_ms / (1000 * 60 * 60 * 24)
    else:
        median_lag_days = None
    
    return {
        'median_ms': weighted_median_ms if total_k > 0 else None,
        'median_lag_days': median_lag_days,
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

1. **Typical lag (`latency.median_lag_days`)**
   - Definition: weighted median time-to-convert (days) across all cohorts in the parameter window.
   - Computation: as in `estimate_latency_from_amplitude()` above:
     - Use `dayMedianTransTimes.series[i][1]` as per-cohort medians (ms).
     - Weight by `k_i` from `dayFunnels.series[i] = [n_i, k_i]`.
     - Ignore cohorts with `k_i = 0` or `median_ms <= 0`.

2. **Completeness / maturity progress (`latency.completeness`)** — DEFINITIVE FORMULA
   - Intuition: \"How far along are the current cohorts, relative to the typical lag?\"  
   - For each cohort \(i\):
     - Age in days: \(a_i = (\text{query\_date} - \text{cohort\_date}_i)\).
     - Typical lag: \(T_{\text{med}} = \text{latency.median\_lag\_days}\).
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
     - Smooth 0–1 measure derived from actual data (median lag), not an arbitrary threshold.
   
   **Why this formula (not `mature_n / total_n`):** Uses the actual observed median lag rather than a user-set `maturity_days` threshold. More informative and requires no manual configuration.

3. **Sample context**
   - We re-use existing `n`/`k` from parameter values for context:
     - `n = \sum_i n_i`
     - `k = \sum_i k_i`
   - UI can grey-out latency displays when `n` and/or `k` are very small.

#### 5.0.2 Phase 0 Forecasting Formula

**Current scope (Phase 0):** Use a simple step-function approximation for the lag CDF:

```
F(a_i) = 0  if a_i < maturity_days
F(a_i) = 1  if a_i >= maturity_days
```

This simplifies forecasting to:
```
k̂_i = k_i                                    if a_i >= maturity_days (mature)
k̂_i = k_i + (n_i - k_i) × p.forecast         if a_i < maturity_days (immature)
```

Then: `p.mean = Σk̂_i / Σn_i`

**Intuition:** Mature cohorts use observed conversions. Immature cohorts forecast additional conversions at the mature baseline rate (`p.forecast`).

**Where `p.forecast` comes from:** Computed at retrieval time as `Σk / Σn` from mature cohorts in the **window() slice** (X-anchored data). If no window() slice exists, `p.forecast` is unavailable. See Appendix C for Phase 1+ refinements (recency weighting, effective sample size guards).

> **Note:** Detailed formulas for recency-weighted fitting, convolution fallback, and Bayesian enhancements are deferred to **Appendix C: Phase 1+ Forecasting Formulas**. These are speculative and not required for the current implementation scope.

#### 5.0.3 Aggregation over Multiple Slices / Contexts

User queries frequently span **multiple stored slices** (e.g. `contextAny(channel)` or multi-value context filters). Aggregation over these slices must be **mathematically consistent** with the per-cohort Formula A above.

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

For each cohort \\(c = (r,j) \\in \\mathcal{C}\\), reuse the Phase 0 step-function approximation:

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

This is exactly equivalent to **flattening all cohorts from all contexts into a single list and applying Formula A once**. It is invariant to how cohorts are grouped into slices and therefore mathematically well-defined for:

- Multiple context values (e.g. `contextAny(channel)`)
- Multiple explicit context filters (e.g. `or(context(channel:google), context(channel:fb))`)
- Any combination of matching `sliceDSL` rows.

**Window-based queries:** For `window()` slices on latency edges, apply the same rules, treating each `(row, date)` pair as a "cohort" with `n_{r,t}`, `k_{r,t}`, and age defined relative to event date instead of cohort-entry date. The aggregation formulas above still hold; only the definition of \\(a_{r,\\cdot}\\) changes.

#### 5.0.4 Sibling Edge Probability Constraints

**Problem:** For sibling edges (multiple outgoing edges from the same node), probabilities must sum to ≤ 1. Formula A applies independently to each edge, which can cause `Σ p.mean > 1` as a forecasting artefact.

**Why this happens:** Formula A treats the "remaining pool" `(n_i - k_i)` as potential converters for THIS edge, without accounting for conversions on sibling edges. When siblings compete for the same pool, forecasts can double-count.

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

#### 5.0.5 Put to File Behaviour in Aggregate Views

**Principle:** "Put to file" is **never disabled**. A param file existing means the operation is always available; it is not conditional on slice count or aggregation status.

**Behaviour when current view is an aggregate over multiple slices** (e.g. `contextAny(...)`, multiple `context(...)` combinations):

1. **CONFIG/metadata: always written.**
   - Latency config (`maturity_days`, `anchor_node_id`, `censor_days`)
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

### 5.1–5.3 Advanced Inference (Phase 1+)

> **Deferred:** Full Bayesian lag distribution fitting, hierarchical models, and posterior summaries are out of scope for Phase 0. See **Appendix C: Phase 1+ Forecasting Formulas** for the speculative design.

---

## 6. DAG Runner Integration (Phase 1+)

> **Deferred:** Time-indexed forward passes with latency convolution and Monte Carlo uncertainty are out of scope for Phase 0. The current runner uses the blended `p.mean` without temporal simulation. See **Appendix C** for speculative time-aware runner design.

**Phase 0 behaviour:** The runner uses `p.mean` (the blended evidence+forecast probability) as a scalar, treating conversions as instantaneous. Latency information is displayed but not used in forward-pass calculations.

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
    mean: number;            // Blended: evidence + forecasted tail (Formula A)
  };
  
  // For completeness badge
  completeness: number;      // 0-1 maturity progress (see §5.0.1)
  
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
| `p.mean` | Evidence + forecasted tail (Formula A) | Query time | No |

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
| Format | **"13d (75%)"** — median lag + completeness (see §5.0.1) | *** WE MIGHT WANT TO SURRFACE ST DEV OR WHATEVER ON THE LAG DAYS TOO E.G. 13d+/-3 (75%) ***
| Show when | `latency.maturity_days > 0` AND `median_lag_days > 0` |
| Colour | Standard bead styling (no new colour) |

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

Full tooltip redesign is **deferred** (see TODO.md #5). For latency edges, append:

```
Evidence:  8.0%  (k=80, n=1000)
  Source:  cohort(1-Nov-25:21-Nov-25)

Forecast:  45.0%  (p.forecast)
  Source:  window(1-Nov-25:24-Nov-25)

Blended:   42.0%
Completeness: 18%
Lag: 6.0d median
```

**Key requirement:** Show which `sliceDSL` contributed to each value. This gives users transparency into data provenance.

If p.forecast unavailable:
```
Evidence:  8.0%  (k=80, n=1000)
  Source:  cohort(1-Nov-25:21-Nov-25)

Forecast:  —  (no window data)
Completeness: 18%
Lag: 6.0d median
```

### 7.7 Properties Panel: Latency Settings

Latency configuration fields are added to `ParameterSection` component — the shared component used for **both** regular probability (`p`) and conditional probability (`conditional_p`) params.

**Location:** New fields below Distribution dropdown, before Query Expression Editor.

**Implementation:** Modify `graph-editor/src/components/ParameterSection.tsx` — adding latency fields here automatically applies them to all probability param UIs (regular and conditional).

| Field | Type | Maps to | Override flag |
|-------|------|---------|---------------|
| Track Latency | Checkbox | `edge.latency.maturity_days` (0 vs >0) | `maturity_days_overridden` |
| Maturity Days | Number input (shown when enabled) | `edge.latency.maturity_days` | `maturity_days_overridden` |
| Recency | Slider (shown when enabled) | `edge.latency.recency_half_life_days` | `recency_half_life_days_overridden` |

**Semantics:**
- Checkbox **unchecked**: `maturity_days = 0` (latency tracking disabled)
- Checkbox **checked**: `maturity_days > 0` (latency tracking enabled), shows Maturity + Recency fields

**New fields to add** (insert after Distribution dropdown, before Query Expression Editor):
```
[✓] Track Latency
    Maturity: [30] days
    Recency:  [==●====] 30d [↺]
```

When checkbox unchecked, Maturity and Recency rows are hidden.

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
Graph Edge                    ↔    Param File
─────────────────────────────────────────────────────────────────
edge.latency.maturity_days    ↔    latency.maturity_days (top-level CONFIG; >0 enables tracking)
edge.latency.maturity_days    ↔    latency.maturity_days
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

| Graph Edge | Param File | Override Flag | Notes |
|------------|-----------|---------------|-------|
| `edge.latency.maturity_days` | `latency.maturity_days` | `maturity_days_overridden` | >0 enables latency tracking |
| `edge.latency.maturity_days` | `latency.maturity_days` | `maturity_days_overridden` | Maturity threshold |
| `edge.latency.censor_days` | `latency.censor_days` | `censor_days_overridden` | Censor threshold |
| `edge.latency.anchor_node_id` | `latency.anchor_node_id` | `anchor_node_id_overridden` | Cohort anchor (MSMDC-computed) |

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

**Change required:**

```typescript
// CLEANED UP
interface ProbabilityParam {
  mean?: number;
  stdev?: number;
  // NEW (LAG):
  forecast_mean?: number;
  forecast_stdev?: number;
  evidence_mean?: number;
  evidence_stdev?: number;
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

#### E. Forecasting Logic Tests (`forecastService.test.ts` — new)

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

**Note:** Convolution fallback (deriving window data from cohort data) is deferred to Phase 1+. Phase 0 returns an error.

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

## 12. Open Questions

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

### 9.4 Conditional Edges (`conditional_p`) ✅ RESOLVED

**Decision:** `conditional_p` is a first-class citizen and receives **identical latency treatment** to `p`.

- Latency config (`track`, `maturity_days`) applies to the edge, not per-condition
- Evidence/forecast split applies to the overall edge conversion
- Each condition branch uses the same latency model
- `p.evidence`, `p.forecast`, `p.mean` computed for the edge as a whole
- Condition weights are separate from latency (they determine branch probabilities, not timing)

**Implementation:** All references to "probability params" or `p` throughout this design apply equally to `conditional_p`. The latency machinery operates at edge level, regardless of whether the edge uses `p` or `conditional_p`.

### 9.5 Cost Parameters — No Latency Treatment

**Decision:** Cost parameters (`labour_cost`, `cost_money`) do **NOT** get latency treatment.

- They are direct inputs to calculations, not modelled from data
- Typically entered manually or imported from external sources (e.g., Google Sheets)
- No Amplitude fetch, no forecasting, no evidence/forecast split
- Just standard param handling with `_overridden` for persistence

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

## Appendix C: Phase 1+ Forecasting Formulas (Speculative)

> **Status:** This appendix contains speculative formulas for future phases. They are not required for Phase 0 implementation.

### C.1 Evidence vs Forecast Policy

**Recency-weighted model fitting:**

Within the "mature but not ancient" cohort set, favour more recent cohorts when estimating the long-run `p.forecast`:

1. For each mature cohort, define a recency weight `w_i = exp(-(T_ingest - t_i) / H)` where `t_i` is the cohort date and `H` is `latency.recency_half_life_days` (default ~30).

2. Estimate the mature baseline probability: `p.forecast = Σ(w_i × k_i) / Σ(w_i × n_i)`

3. Guard against sparsity with effective sample size: `N_eff = (Σ w_i × n_i)² / Σ(w_i² × n_i)`. If `N_eff` is too small (< 500–1000), widen the window or blend with a weaker prior.

#### C.1.1 Moving Forecasts & Recency Weighting – Implementation Sketch (Phase 1 / Fast-Follow)

**Goal:** Make `p.forecast` a **moving, recency-weighted quantity** that updates smoothly as new data arrives, without changing the Phase 0 query/rendering contract.

**Core idea:**

- Keep the Phase 0 contract:
  - Retrieval time computes and stores **slice-level** `forecast_mean`, `forecast_stdev`.
  - Query time uses those as the baseline in Formula A.
- Change **how** `forecast_mean` is computed at retrieval time:
  - From simple mature average (Phase 0) → to **recency-weighted** average using weights \\(w_i\\).
  - Use the effective sample size \\(N_{eff}\\) to decide if the recency-weighted estimate is trustworthy.

**Insertion points (code):**

- **`dataOperationsService.getFromSource()` transform path** (retrieval time):
  - Today: after extracting per-cohort \\(n_i, k_i\\), we compute:
    - `p.forecast = Σk_mature / Σn_mature` (unweighted) and write to `values[].forecast_mean`.
  - Phase 1 change:
    - Call a small helper (e.g. `forecastService.computeRecencyWeightedForecast(dailyCohorts, recencyHalfLife)`).
    - That helper:
      - Applies weights \\(w_i\\) as per C.1.
      - Computes `forecast_mean`, `forecast_stdev`, and `N_eff`.
      - If `N_eff` below threshold, either:
        - Fall back to unweighted mature average, or
        - Mark `forecast_mean` as low-confidence (flag stored in `values[].latency` or `values[].data_source.analytics`).
    - Write the result back to:
      - `values[].forecast_mean`, `values[].forecast_stdev`.
      - Optional: `values[].latency.effective_sample_size`.

- **`forecastService.ts` (NEW, TS-side service):**
  - Encapsulate:
    - Recency weighting logic (C.1).
    - Effective sample size calculation.
  - Used by:
    - `dataOperationsService` at retrieval time.
    - Future analytics code (e.g., to recompute forecasts on different windows without re-fetching).

**Data model impact:**

- **No schema changes are required** for Phase 1:
  - We already have:
    - `values[].forecast_mean`, `values[].forecast_stdev`.
    - `latency.recency_half_life_days` on the edge (optional; defaulted if missing).
  - Optionally, we may add:
    - `values[].latency.effective_sample_size` (for debugging / semantic linting).
- Existing Phase 0 files remain valid:
  - When Phase 1 ships, older `forecast_mean` values simply become “legacy” until next fetch.
  - Any re-fetch will recompute them with recency weighting.

**Query-time behaviour (unchanged):**

- Formula A and the rendering logic **do not change**:
  - `p.evidence` still derived from raw k/n in the current query window.
  - `p.forecast` is taken from `values[].forecast_mean` (now recency-weighted).
  - `p.mean` still computed at query time from evidence + forecast tail.
- Moving forecasts emerge naturally because:
  - Each new fetch recomputes `forecast_mean` with recency weights and newer cohorts.
  - The graph viewer sees a smooth evolution of `p.forecast` over time, without needing new query-time formulas.

**Interaction with semantic linting (see TODO.md):**

- The same `forecastService` helper can expose:
  - `N_eff` (effective sample size).
  - Flags like `isForecastReliable` (based on thresholds).
- Graph Issues can:
  - Warn when `N_eff` is too low for a latency edge.

#### C.1.2 Recency Bias UI & Config Spec (Phase 1)

**Concept:** Recency bias controls how much the forecast baseline favours recent mature cohorts over older ones. Parameterised as **half‑life in days**: a cohort `H` days older than the newest gets half the weight.

**Metrication:**

- `recency_half_life_days: number` (default: 30)
- Interpretation: "How many days until a cohort's influence is halved?"
  - `H = 7`: aggressive decay, recent week dominates.
  - `H = 30`: gentle decay (default).
  - `H = 90`: very stable, historical data weighted heavily.
  - `H = 0`: disabled (unweighted average, Phase 0 behaviour).

**Config hierarchy (standard override pattern):**

```
Effective H = 
  edge.latency.recency_half_life_days  if  recency_half_life_days_overridden
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
   - Right = flat ("Off" = unweighted, Phase 0 behaviour).
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
3. Pass to `forecastService.computeRecencyWeightedForecast(cohorts, effective_H)`.
4. Helper returns `forecast_mean`, `forecast_stdev`, `N_eff`.
5. Write to `values[].forecast_mean`, `values[].forecast_stdev`.

**Query-time flow:**

- Unchanged: read `forecast_mean` from param file, apply Formula A.

**Implementation checklist (Phase 1):**

- [ ] Add `recency_half_life_days`, `recency_half_life_days_overridden` to types/schemas.
- [ ] Add workspace setting `defaultRecencyHalfLifeDays`.
- [ ] Add slider to View menu (reuse existing slider component).
- [ ] Add slider to Properties Panel latency section (with override pattern).
- [ ] Create `forecastService.ts` with `computeRecencyWeightedForecast()`.
- [ ] Update `dataOperationsService.getFromSource()` to call `forecastService`.
- [ ] Update UpdateManager for `recency_half_life_days` (edge ↔ param file).
  - Label edges as “data shallow” or “no mature cohorts” when forecasts are unstable.

### C.2 Full Per-Cohort Tail Forecasting (Formula A)

The complete formula with continuous lag CDF:

```
k̂_i = k_i + (n_i - k_i) × p.forecast × (1 - F(a_i)) / (1 - p.forecast × F(a_i))
```

**Derivation:** Uses Bayes' rule—not having converted by age `a_i` could be because (a) the user is a non-converter, or (b) the user is a converter but slow.

**Simplified approximation** (when `p.forecast × F(a_i) << 1`):

```
k̂_i ≈ k_i + (n_i - k_i) × p.forecast × (1 - F(a_i))
```

### C.3 Convolution Fallback for Window Queries

When `window(t1:t2)` is requested for a latency edge but only A-anchored `cohort_data` is available, convolve to find which A-cohorts contribute X-events in the window.

Let `g(s)` = A→X lag PDF and `h(t)` = X→Y lag PDF.

Users starting X in window `[t_1, t_2]` from A-cohort date `d`:

```
n_X_d = n_d × p_A→X × ∫[t_1-d to t_2-d] g(s) ds
```

This is approximate because it uses expected A→X lag rather than the full distribution.

### C.4 Bayesian Lag Distribution Fitting

For production Phase 1+, fit a survival model to cohort maturation curves. Each cohort provides censored survival data: n users entered, k_by_lag[t] converted by lag t, right-censored at last observed lag.

**Hierarchical model:** Pool across context slices with shared hyperpriors for lag distribution parameters (mu_pop, sigma_pop) and per-context parameters (mu_ctx, sigma_ctx).

**Output:** Posterior summaries including median_days with credible intervals, pmf_days for convolution, and uncertainty estimates.

### C.5 Time-Indexed Forward Pass

With fitted lag distributions, the DAG runner computes arrivals by day via convolution:

1. Seed entry nodes on day 0
2. For each time step t, for each edge:
   - Source mass at time t
   - Multiply by edge probability p
   - Spread arrivals across future days according to lag PMF
3. Output: `{node_id: [mass_day_0, mass_day_1, ...]}` arrivals by day

**Monte Carlo uncertainty:** Sample from posterior distributions and aggregate runs to produce mean and credible intervals (fan charts).

### C.6 Formula Summary Table

| Formula | Purpose | Phase |
|---------|---------|-------|
| Step function F(a_i) | Simplified maturity check | 0 |
| `p.forecast = Σk_mature / Σn_mature` | Baseline from mature cohorts | 0 |
| Recency-weighted `p.forecast` | Better baseline with recency decay | 1 |
| Full Formula A with continuous F(t) | Per-cohort tail forecasting | 1 |
| Convolution fallback | Window queries from cohort data | 1 |
| Bayesian hierarchical model | Full uncertainty quantification | 2 |
| Time-indexed convolution | Temporal runner simulation | 2 |

---

## Appendix D: Related Documents

- `notes.md` — Previous discussion summary (6 conceptual areas)
- `data-fetch-refactoring-proposal.md` — Data retrieval architecture
- `data-retrieval-detailed-flow.md` — Current fetch implementation

---

*End of Design Document*

