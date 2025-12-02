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
| **Event Window** | Period during which users *enter* the funnel | Defines the cohort population (n) |
| **Cohort Window** | Period during which we observe *conversions* | Defines how long we track (k over time) |

**Example:**
- Event window: 1-Nov-25 to 7-Nov-25 (cohort entry)
- Cohort window: 1-Nov-25 to 21-Nov-25 (14 days to mature)

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
  
  /** Inferred distribution parameters
   *  Phase 0: empirical (just pmf from data)
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

### 3.2 Parameter File Additions

For edges with latency tracking, parameter files gain:

```yaml
# parameter-{edge-id}.yaml
id: edge-signup-to-purchase
name: Signup to Purchase
type: probability  # unchanged

values:
  - mean: 0.45
    stdev: 0.02
    n: 1765
    k: 794
    
    # Daily data (existing)
    n_daily: [270, 186, 539, ...]
    k_daily: [161, 121, 306, ...]
    dates: [3-Nov-25, 4-Nov-25, 5-Nov-25, ...]
    
    # NEW: Cohort maturation data (for latency inference)
    cohort_dailies:
      - cohort_date: 3-Nov-25
        lags: [0, 1, 2, 3, 4, 5, 6, 7]  # Days since cohort entry
        n: 270                          # Cohort size
        k_by_lag: [42, 85, 112, 131, 145, 152, 158, 161]  # Cumulative k
      - cohort_date: 4-Nov-25
        lags: [0, 1, 2, 3, 4, 5, 6]
        n: 186
        k_by_lag: [28, 54, 78, 95, 108, 116, 121]
      # ... more cohorts

    # NEW: Inferred latency parameters
    latency:
      family: lognormal
      mu: 0.8          # log(median) ≈ exp(0.8) ≈ 2.2 days
      sigma: 0.6       # shape parameter
      median_days: 2.2
      p90_days: 5.8    # 90th percentile
      censor_days: 14  # Truncation point
      
    window_from: 3-Nov-25T00:00:00Z
    window_to: 17-Nov-25T00:00:00Z  # Cohort window end
```

### 3.3 Renaming: cost_time → labour_cost

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
        'immature_k_observed': immature_k,         # What we've seen so far
        'immature_k_forecast': immature_forecast_k, # What we expect eventually
        
        # Combined
        'total_n': total_n,
        'total_k_observed': mature_k + immature_k,
        'total_k_forecast': mature_k + immature_forecast_k,
        
        # Coverage: how much of our window is mature?
        'maturity_coverage': mature_n / total_n if total_n > 0 else 0
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

---

### 5.1 Fitting Lag Distributions (Phase 1)

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
        │ ╱ ╱ ╱ ╱ ╱ ╱ ╱ ╱ ╱ ╱ ╱ ╱ ╱ ╱ │
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
  n_mature: number;          // Sample size from mature cohorts
  n_total: number;           // Total sample size (mature + immature)
  maturity_coverage: number; // n_mature / n_total (0-1)
  
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
| Format | **"13d (75%)"** — median lag + maturity coverage |
| Show when | `latency.track === true` AND `median_lag_days > 0` |
| Colour | Standard bead styling (no new colour) |

**Completeness** = `maturity_coverage` = `mature_n / total_n` (as defined in §7.2).

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

#### E. Parameter Storage

| File | Current Role | Change Required |
|------|--------------|-----------------|
| `src/services/paramRegistryService.ts` | Stores/retrieves parameter data | Store cohort-level data including latency |
| `public/param-schemas/parameter-schema.yaml` | Schema for parameter files | Add `median_trans_times`, `cohort_age_days` |

**New fields in parameter values:**
```yaml
values:
  - mean: 0.079
    n: 1782
    k: 140
    
    # Existing daily breakdown
    n_daily: [15, 14, 15, 24, ...]
    k_daily: [0, 1, 0, 1, ...]
    dates: [1-Sep-24, 2-Sep-24, ...]
    
    # NEW: Latency data per cohort
    median_trans_times_ms: [null, 2015856000, null, 533520000, ...]
    
    # NEW: Cohort metadata
    cohort_window:
      start: 1-Sep-24
      end: 31-Oct-24
      maturity_days: 30
      query_date: 1-Dec-24  # When this data was fetched
```

#### F. Update Manager

| File | Current Role | Change Required |
|------|--------------|-----------------|
| `src/services/UpdateManager.ts` | Transforms data between graph/files | Handle latency fields |
| Mapping configs | Define field transformations | Add mappings for latency data |

**New mappings needed:**
- `source → edge.latency.median_days`
- `source → edge.p.maturity_coverage`

#### G. Edge Schema & Types

| File | Current Role | Change Required |
|------|--------------|-----------------|
| `src/types/index.ts` | TypeScript type definitions | Add `LatencyConfig`, rename `cost_time` |
| `lib/graph_types.py` | Pydantic models | Add latency fields to Edge model |

#### H. Edge Rendering

| File | Current Role | Change Required |
|------|--------------|-----------------|
| `src/components/edges/ConversionEdge.tsx` | Renders conversion edges | Two-layer mature/forecast rendering |
| `src/components/edges/EdgeBeads.tsx` | Renders edge beads/labels | Show latency info in beads |
| `src/lib/nodeEdgeConstants.ts` | Edge styling constants | Add stripe patterns for forecast layer |

#### I. Properties Panel

| File | Current Role | Change Required |
|------|--------------|-----------------|
| `src/components/PropertiesPanel.tsx` | Shows selected element properties | Display latency stats, maturity coverage |

#### J. Context & State

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

## Appendix A: Amplitude Response Reference

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

