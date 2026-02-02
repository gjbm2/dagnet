# Time-Series Charting: Phase 5 Design

**Status**: Future (Deferred)  
**Prerequisite**: Phases 1-3 complete (snapshot write/read path working)  
**Date**: 1-Feb-26

---

## 1. Overview

This document captures requirements for advanced time-series charting capabilities built on top of the snapshot database. These are **deferred to Phase 5** to avoid blocking the core data persistence work.

**Core principle:** Get data flowing first; iterate on presentation later.

---

## 2. Chart Types

### 2.1 Daily Conversions Bar Chart (Phase 3 — Simple)

**Implemented in Phase 3.** Basic bar chart showing conversions per calendar date.

```
Y-axis: Conversions
X-axis: Date
Style: Simple bar chart
```

This is the **foundation** — Phase 5 builds on it.

---

### 2.2 Funnel Time Series (Phase 5)

**Purpose:** Line chart showing conversion % by funnel stage over time.

```
┌────────────────────────────────────────────────────────────┐
│  Conversion % Over Time                                     │
│  100% ─────────────────────────────────────────────────────│
│   80% ─────────────────────────────────────────────────────│
│   60% ─────────────·········································│
│   40% ─────────────····················▲ A→B              │
│   20% ─────────────····················▼ B→C              │
│    0% ─────────────────────────────────────────────────────│
│        Oct 1   Oct 8   Oct 15   Oct 22   Oct 29            │
└────────────────────────────────────────────────────────────┘
```

**Data requirements:**
- Multiple edges (A→B, B→C, etc.) from same DSL path
- Each edge contributes one line
- X-axis: date (anchor_day or derived date)
- Y-axis: conversion % (Y/X × 100)

**Python derivation:**

```python
def derive_funnel_time_series(
    rows: list[dict],
    edge_segments: list[EdgeSegment]
) -> AnalysisResult:
    """
    Derive conversion % time series for multiple edges.
    
    Returns one line per edge with date/conversion_pct pairs.
    """
    series = []
    
    for segment in edge_segments:
        edge_rows = [r for r in rows if r['param_id'].endswith(segment.param_suffix)]
        
        # Group by anchor_day, take latest retrieved_at
        by_anchor = latest_per_anchor(edge_rows)
        
        points = [
            {
                'date': anchor.isoformat(),
                'conversion_pct': (r['Y'] / r['X'] * 100) if r['X'] > 0 else 0,
            }
            for anchor, r in sorted(by_anchor.items())
        ]
        
        series.append({
            'edge_id': segment.edge_id,
            'label': f"{segment.from_node} → {segment.to_node}",
            'points': points,
        })
    
    return AnalysisResult(
        analysis_type='funnel_time_series',
        semantics=ResultSemantics(
            dimensions=[DimensionSpec(id='date', type='time', role='x_axis')],
            metrics=[MetricSpec(id='conversion_pct', type='ratio', format='percent')],
            series_key='edge_id',
            chart=ChartSpec(recommended='line', alternatives=['area']),
        ),
        data=series,
    )
```

**Frontend component:** `TimeSeriesLineChart.tsx`

---

### 2.3 Evidence vs Forecast Distinction (Phase 5)

**Purpose:** For immature cohorts, distinguish between observed data and projected completion.

**The problem:**
- Recent cohorts have incomplete data (not enough time for all conversions)
- Raw % understates true conversion (denominator is final, numerator is partial)
- Need to show both "what we know" and "what we expect"

**Solution:** Two-layer visualisation:

```
┌────────────────────────────────────────────────────────────┐
│  Conversion % with Forecast                                 │
│   50% ───────────────────────────────────────┐              │
│   40% ─────────────────────────────────┐····│· (forecast)  │
│   30% ───────────────────────────┐·····│····│              │
│   20% ─────────────────────┐·····│·····│····│              │
│   10% ───────────────┐·····│·····│·····│····│              │
│    0% ───────────────┴─────┴─────┴─────┴────┴──────────────│
│        Oct 1   Oct 8   Oct 15   Oct 22   Oct 29   Nov 5    │
│                                                             │
│        ─── Evidence (solid)    ··· Forecast (dashed)       │
└────────────────────────────────────────────────────────────┘
```

**Derivation logic:**

```python
def compute_completeness(
    anchor_day: date,
    retrieved_at: datetime,
    t95_days: float  # from parameter's latency model
) -> float:
    """
    Estimate what % of conversions have been observed.
    
    Uses t95 (days by which 95% of conversions typically occur).
    """
    elapsed_days = (retrieved_at.date() - anchor_day).days
    
    if elapsed_days >= t95_days:
        return 1.0  # Fully mature
    
    # Simplified logistic model (can be refined)
    # Assumes most conversions happen early, tail extends
    return min(1.0, elapsed_days / t95_days * 0.95)


def derive_with_forecast(rows: list[dict], t95_days: float) -> list[dict]:
    """
    Split each data point into evidence vs forecast layers.
    """
    result = []
    
    for r in rows:
        completeness = compute_completeness(r['anchor_day'], r['retrieved_at'], t95_days)
        observed_pct = r['Y'] / r['X'] * 100 if r['X'] > 0 else 0
        
        if completeness >= 0.99:
            # Mature cohort - evidence only
            result.append({
                'date': r['anchor_day'].isoformat(),
                'conversion_pct': observed_pct,
                'layer': 'evidence',
                'completeness': 1.0,
            })
        else:
            # Immature cohort - split into evidence + forecast
            forecast_pct = observed_pct / completeness  # Extrapolate
            
            result.append({
                'date': r['anchor_day'].isoformat(),
                'conversion_pct': observed_pct,
                'layer': 'evidence',
                'completeness': completeness,
            })
            result.append({
                'date': r['anchor_day'].isoformat(),
                'conversion_pct': forecast_pct,
                'layer': 'forecast',
                'completeness': completeness,
            })
    
    return result
```

**Frontend rendering:**
- `layer: 'evidence'` → solid line
- `layer: 'forecast'` → dashed line or lighter colour
- Tooltip shows completeness %

---

### 2.4 Fan Charts (Phase 5)

**Purpose:** Show uncertainty bands, not just point estimates.

```
┌────────────────────────────────────────────────────────────┐
│  Conversion % with Confidence Bands                         │
│   60% ───────────────────────────░░░░░░░░░░░░░░░░░░░░░░░░░│
│   50% ─────────────────────░░░░░░▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓░░░░░░░│
│   40% ───────────────░░░░░░▓▓▓▓▓▓████████████▓▓▓▓▓░░░░░░░│
│   30% ─────────░░░░░░▓▓▓▓▓▓████████████████████▓▓░░░░░░░│
│   20% ───░░░░░░▓▓▓▓▓▓████████████████████████████▓░░░░░│
│   10% ░░░▓▓▓▓▓▓██████████████████████████████████░░░░│
│    0% ─────────────────────────────────────────────────────│
│        Oct 1   Oct 8   Oct 15   Oct 22   Oct 29            │
│                                                             │
│        ░░░ 90% CI    ▓▓▓ 50% CI    ███ Median             │
└────────────────────────────────────────────────────────────┘
```

**Data requirements:**
- Multiple snapshots per cohort (to observe variance)
- Or: Bootstrap resampling from available data

**Derivation approach:**

```python
def derive_fan_chart(
    rows: list[dict],
    confidence_levels: list[float] = [0.5, 0.9]
) -> list[dict]:
    """
    Derive confidence bands from snapshot variance.
    
    For each anchor_day, compute percentiles across retrieved_at snapshots.
    """
    by_anchor = group_by(rows, key=lambda r: r['anchor_day'])
    
    result = []
    for anchor, snapshots in by_anchor.items():
        conversion_pcts = [(s['Y'] / s['X'] * 100) for s in snapshots if s['X'] > 0]
        
        if len(conversion_pcts) < 3:
            # Not enough data for bands
            result.append({
                'date': anchor.isoformat(),
                'median': np.median(conversion_pcts) if conversion_pcts else 0,
                'ci_50_low': None,
                'ci_50_high': None,
                'ci_90_low': None,
                'ci_90_high': None,
            })
        else:
            result.append({
                'date': anchor.isoformat(),
                'median': np.median(conversion_pcts),
                'ci_50_low': np.percentile(conversion_pcts, 25),
                'ci_50_high': np.percentile(conversion_pcts, 75),
                'ci_90_low': np.percentile(conversion_pcts, 5),
                'ci_90_high': np.percentile(conversion_pcts, 95),
            })
    
    return result
```

**Note:** Fan charts require sufficient snapshot history. Will be sparse initially.

---

### 2.5 Lag Histogram (Phase 3 + Phase 5 Enhancements)

**Phase 3:** Basic histogram from ΔY derivation (already specified in main design).

**Phase 5 enhancements:**
- Overlay Amplitude-reported latency (median_lag_days) for comparison
- Cumulative distribution view option
- Animated "fill up" showing how histogram grows over time

---

## 3. Configurable Aggregation

**Purpose:** Allow users to view data at different granularities.

| Granularity | Use Case |
|-------------|----------|
| **Daily** | Default; highest resolution |
| **Weekly** | Reduce noise; see trends |
| **Monthly** | Long-term patterns |

**Implementation:**

```python
def aggregate_to_period(
    rows: list[dict],
    period: Literal['daily', 'weekly', 'monthly']
) -> list[dict]:
    """
    Aggregate daily snapshots to coarser time periods.
    """
    
    def period_key(d: date) -> str:
        if period == 'daily':
            return d.isoformat()
        elif period == 'weekly':
            # ISO week
            return f"{d.isocalendar().year}-W{d.isocalendar().week:02d}"
        elif period == 'monthly':
            return f"{d.year}-{d.month:02d}"
    
    by_period = defaultdict(list)
    for r in rows:
        key = period_key(r['anchor_day'])
        by_period[key].append(r)
    
    result = []
    for period_label, period_rows in sorted(by_period.items()):
        # Sum counts, compute weighted average for ratios
        total_X = sum(r['X'] for r in period_rows)
        total_Y = sum(r['Y'] for r in period_rows)
        
        result.append({
            'period': period_label,
            'X': total_X,
            'Y': total_Y,
            'conversion_pct': (total_Y / total_X * 100) if total_X > 0 else 0,
        })
    
    return result
```

**Frontend:** Dropdown selector in AnalyticsPanel: "View: Daily | Weekly | Monthly"

---

## 4. Latency Drift Analysis

**Purpose:** Compare Amplitude-reported latency vs our ΔY-derived latency.

**Why this matters:**
- Amplitude's `dayMedianTransTimes` is authoritative but opaque
- Our ΔY derivation gives day-granularity histogram
- Comparing them validates our methodology
- Drift over time might indicate Amplitude reprocessing or sampling changes

**Implementation:**

```python
def compute_latency_drift(rows: list[dict]) -> dict:
    """
    Compare stored Amplitude latency vs derived latency.
    """
    # Derive histogram from ΔY
    derived_histogram = derive_histogram(rows)
    derived_median = compute_histogram_median(derived_histogram)
    
    # Get Amplitude-reported medians
    amplitude_medians = [r['median_lag_days'] for r in rows if r['median_lag_days']]
    amplitude_median = np.median(amplitude_medians) if amplitude_medians else None
    
    return {
        'derived_median_days': derived_median,
        'amplitude_median_days': amplitude_median,
        'drift_days': (derived_median - amplitude_median) if amplitude_median else None,
        'drift_pct': abs(derived_median - amplitude_median) / amplitude_median * 100
                     if amplitude_median else None,
    }
```

**Display:** Small info card showing "Latency: 6.2 days (derived) vs 6.0 days (Amplitude)"

---

## 5. Completeness Overlays

**Purpose:** Show cohort maturity alongside conversion data.

```
┌────────────────────────────────────────────────────────────┐
│  Daily Conversions with Completeness                        │
│  1000 ──────────────────────────────────────────────────────│
│   800 ─────────████──────────────────────────────────────│
│   600 ─████─────────████──────────────────────────────────│
│   400 ───────────────────████──────────────────────────│
│   200 ─────────────────────────████───░░░░───░░░░────────│
│     0 ──────────────────────────────────────────────────────│
│        Oct 1   Oct 8   Oct 15   Oct 22   Oct 29            │
│                                                             │
│        ████ Complete (≥95%)    ░░░░ Immature (<95%)        │
└────────────────────────────────────────────────────────────┘
```

**Implementation:**
- Add `completeness` field to each data point (Phase 5 derivation)
- Frontend colours bars/points based on completeness threshold
- Tooltip shows: "Completeness: 87% — expect ~15% more conversions"

---

## 6. Files to Create/Modify

### 6.1 New Files (Phase 5)

| File | Purpose |
|------|---------|
| `graph-editor/src/components/charts/TimeSeriesLineChart.tsx` | Multi-series line chart |
| `graph-editor/src/components/charts/FanChart.tsx` | Confidence band visualisation |
| `graph-editor/lib/runner/snapshot_derivations.py` | All Python derivation functions |
| `graph-editor/lib/runner/latency_analysis.py` | Drift computation |

### 6.2 Modifications (Phase 5)

| File | Changes |
|------|---------|
| `graph-editor/src/components/charts/AnalysisChartContainer.tsx` | Route to new chart types |
| `graph-editor/src/components/panels/analysisTypes.ts` | Register Phase 5 analysis types |
| `graph-editor/lib/runner/analyzer.py` | Dispatch to new derivations |

---

## 7. Dependencies

| Dependency | Phase | Notes |
|------------|-------|-------|
| Snapshot write path | Phase 1 | Must be working |
| Snapshot read path | Phase 2 | Must be working |
| Basic bar chart | Phase 3 | Foundation |
| Sufficient snapshot history | N/A | Fan charts need weeks of data |
| t95 latency parameters | Existing | Used for completeness calculation |

---

## 8. Success Metrics

| Metric | Target |
|--------|--------|
| Fan chart renders with ≥7 days history | Yes |
| Evidence/forecast correctly distinguished | Visual QA |
| Latency drift < 10% for stable funnels | Monitoring |
| Aggregation produces correct sums | Unit tests |

---

## 9. Open Questions

1. **Colour palette:** What colours for evidence vs forecast? Current theme-aware?
2. **Mobile responsiveness:** Do these charts need mobile variants?
3. **Export:** Should users be able to export chart data as CSV?
4. **Annotations:** Should users be able to annotate dates (e.g., "product launch")?

---

## 10. References

- [Snapshot DB Design](./snapshot-db-design.md) — §20, §21.2
- [Implementation Plan](./implementation-plan.md) — Phase 5 summary
