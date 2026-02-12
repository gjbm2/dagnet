# Time-Series Charting: Phase 5 Design

**Status**: §2.3 (forecast-aware rendering) — active design (11-Feb-26). Remainder deferred.  
**Prerequisite**: Phases 1-3 complete (snapshot write/read path working); BE-forecasting Phases 1–8 (`analysis-forecasting.md`).  
**Date**: 1-Feb-26 (original) · 11-Feb-26 (§2.3 detailed design)

---

## 1. Overview

This document captures requirements for advanced time-series charting capabilities built on top of the snapshot database.

**Phase 5a** (§2.3 — forecast-aware chart rendering) is now **active**: all backend dependencies are met, the data fields flow through to chart components, and the work is purely frontend. Remaining Phase 5 features (funnel time-series, fan charts, aggregation, latency drift) remain deferred.

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

### 2.3 Forecast-Aware Chart Rendering (Phase 5a — Active)

**Purpose:** Render evidence, forecast, and blended views of conversion data in time-series charts, driven by the per-scenario F/E/F+E visibility mode.

**Date:** 11-Feb-26  
**Prerequisite:** Backend forecasting Phases 1–8 complete (`analysis-forecasting.md`). Backend already emits `completeness`, `layer`, `evidence_y`, `forecast_y`, `projected_y` on every snapshot data row. `graphComputeClient` normalisers already pass these fields through. Charts currently ignore them.

---

#### 2.3.1 The Problem and Approach

Recent cohorts have incomplete data — not enough time has elapsed for all conversions to occur. The raw conversion rate (`y / x`) understates reality for immature cohorts. Today, both charts render this raw rate with no distinction between "confirmed" and "projected" data. The user has no way to see:

- How much of the observed rate is confirmed vs estimated
- Whether the recent dip in a time-series is real or just a maturity artefact
- What the model projects the final conversion rate to be

The user already toggles F/E/F+E per scenario in the Scenarios Panel to control which probability basis is used for funnel/reach analysis. The same mode should control what they see in time-series charts.

**Approach (cohort maturity focus):**

- Each frame (one `as_at_date`) already contains per-cohort data points annotated with completeness + projection fields (`completeness`, `evidence_y`, `forecast_y`, `projected_y`).
- We derive a **frame-level evidence value** (what has actually happened up to that `as_at_date`) and a **frame-level forecast-at-as-at value** (what the model believes the fully-matured value will be, given evidence available at that `as_at_date`).
- We render evidence vs forecast using the **existing graph F/E/F+E visual language** and **the same per-scenario visibility mode semantics** as the canvas (see §2.3.6–§2.3.8).

Important: in the cohort chart, “forecast” has two distinct meanings that we implement in phases:

- **Forecast-at-as-at (final)**: at `as_at = t`, estimate the final matured outcome \(Y_\infty\) implied by evidence observed up to \(t\). This is what `projected_y` provides when aggregated.
- **Forecast into the future (tail)**: beyond the latest observed `as_at_date`, generate **synthetic frames** using the lognormal latency model (`mu`, `sigma`, onset delta) to predict how the evidence curve will continue to mature over time.

---

#### 2.3.2 Visibility Mode Semantics for Charts

The visibility mode is **per-scenario** — the user may want to compare "Scenario A evidence vs Scenario B forecast" in the same chart. Each scenario's data series is rendered according to its own mode.

| Mode | Semantics | What the user sees |
|------|-----------|-------------------|
| **E** (evidence) | "Show me only confirmed observations." | Conservative view. Recent bars/lines are lower because immature cohorts are shown as-is. The recency dip is real in this view — it reflects incomplete observation, not a true decline. |
| **F** (forecast) | "Show me the model's projection." | Forward-looking view. Bars show `projected_y`, rate shows `projected_y / x`. If the model is well-calibrated, the line should be relatively stable even for recent cohorts. |
| **F+E** (default) | "Show me both layers." | Richest view. Evidence as solid visual, forecast as a lighter/dashed overlay. The gap between evidence and projected visually communicates the completeness gap. |

**Per-scenario mode**: In a multi-scenario chart, each scenario renders in its own mode. Scenario A in E mode renders only evidence bars/lines; Scenario B in F+E mode renders stacked bars and dual lines — side by side. This is the correct behaviour: the user sets mode per scenario and expects the chart to reflect that.

**How mode reaches the chart**: `AnalyticsPanel` already reads `operations.getScenarioVisibilityMode(tabId, scenarioId)` per scenario and sends it to the backend. The same per-scenario mode map is threaded through `AnalysisChartContainer` → chart components as `scenarioVisibilityModes: Record<string, 'f+e' | 'f' | 'e'>`. Chart tabs persist this map in `chart.payload` alongside `analysis_result`.

---

#### 2.3.3 Available Data Fields

Backend annotation (`forecast_application.py`, `analysis-forecasting.md` §6.2) produces these fields on every data row. `graphComputeClient` normalisers pass them through as nullable numbers/strings:

| Field | Type | Meaning |
|-------|------|---------|
| `completeness` | `number \| null` | Fraction of final conversions observed (0–1). 1.0 = fully mature. |
| `layer` | `'evidence' \| 'forecast' \| 'mature' \| null` | Backend classification of the data point's maturity band. |
| `evidence_y` | `number \| null` | Observed Y (= raw `y`). |
| `forecast_y` | `number \| null` | Gap between projected and observed: `projected_y - evidence_y`. |
| `projected_y` | `number \| null` | Extrapolated Y assuming full maturity: `y / max(completeness, ε)`. |

Derived rates (computed in the chart component, not stored):

| Derived | Formula | Used by mode |
|---------|---------|-------------|
| Evidence rate | `evidence_y / x` | E, F+E |
| Projected rate | `projected_y / x` | F, F+E |

---

#### 2.3.4 Daily Conversions Chart — Per-Mode Rendering

The Daily Conversions chart has two series per group: bars (N / cohort size, left Y-axis) and a rate line (right Y-axis). Forecast-awareness affects both.

**Mode E — evidence only:**

- Bars: height = `evidence_y` (i.e. raw `y`). Identical to current rendering.
- Rate line: `evidence_y / x`. Identical to current rendering.
- Visual: no change from today. Recent bars are naturally shorter.

**Mode F — forecast only:**

- Bars: height = `projected_y`. Bars for immature cohorts are taller (extrapolated).
- Rate line: `projected_y / x`. Line should be more stable at the right edge.
- Visual: single bar, single line — same series structure as today, different values.

**Mode F+E — stacked bars, dual rate lines:**

```
  N ↑
    │  ████  ████  ████  ████  ░░░░  ░░░░
    │  ████  ████  ████  ████  ████  ████
    │  ████  ████  ████  ████  ████  ████  ░░░░
    │  ████  ████  ████  ████  ████  ████  ████
    └──────────────────────────────────────── date →

    ████ evidence_y (scenario colour, solid)
    ░░░░ forecast_y (same hue, ~30% opacity, stacked on top)
```

- Bars: **stacked**. Bottom portion = `evidence_y` in the scenario's strong colour. Top portion = `forecast_y` in a very light tint of the same colour. Total height = `projected_y`. For mature cohorts (`completeness ≈ 1`), `forecast_y ≈ 0` so only the solid bar is visible — no visual clutter for historic data.
- Rate lines: **two per scenario**. Solid line = evidence rate (`evidence_y / x`). Dashed line (same colour, thinner) = projected rate (`projected_y / x`). They coincide for mature points and diverge as completeness drops.
- Legend: per-scenario pairs, e.g. "Scenario A · Evidence" / "Scenario A · Projected". For single-scenario charts, just "Evidence" / "Projected".

**Tooltip (all modes):**

```
  15-Jan-26
  ── Scenario A
     N: 1,200
     Evidence:  450 conversions (37.5%)
     Forecast: +120 conversions
     Projected: 570 conversions (47.5%)
     Completeness: 79%
```

In E mode, show only evidence fields. In F mode, show only projected fields. In F+E mode, show all.

---

#### 2.3.5 Cohort Maturity Chart — Per-Mode Rendering

The Cohort Maturity chart is **not** a calendar-date time-series. It is an **age-aligned** maturity curve that represents a *set* of cohort dates by shifting each cohort back to day 0.

This chart answers: “for cohorts in the selected window, what fraction has converted by age \(\tau\) days since cohort day?” — i.e. the **average cumulative latency distribution** (in rate units).

> **Clarification (projection):** Daily Conversions (§2.3.4) plots values by **cohort date** (anchor_day). Cohort Maturity plots values by **age** \(\tau\) (days since anchor_day). They are intentionally different projections of the same snapshot surface; do not expect their x-axes to align.

##### Canonical semantics (per scenario)

Let:

- Window (cohort-set): \(W = [W_{start}, W_{end}]\) from the DSL (`cohort(...)` or `window(...)`).
- Boundary day: \(B =\) `.asat(B)` if provided, else “today” (UTC day).
- Anchor day: \(a \in W\).
- As-at day: \(D\) (virtual snapshot day).
- Age: \(\tau = D - a\) (whole UTC days).

The snapshot DB defines a **2D surface** via virtual snapshots:

- For each \((a, slice\_key)\), the virtual snapshot at as-at day \(D\) uses the latest write with `retrieved_at <= end_of_day(D)` (carry-forward).
- Epoch/slice-regime selection determines which slice families are admissible for a given \(D\) (integrity gaps described below).

The chart is a **diagonal projection** of that surface: for each \(\tau\), each cohort contributes its value at \(D = a + \tau\).

##### Aggregation: single line per scenario (base + crown)

We render a single cohort-set line per scenario using a fixed denominator, then decompose into:

- **Base (evidence already arrived by \(B\))**
- **Crown (forecasted remainder)**

Define the full cohort-set denominator:

- \(X_{full}(s) = \sum_{a \in W} X(s, a, B)\) (best-known denominators at the boundary day).

Evidence base at age \(\tau\):

- For each \(a \in W\), evaluate the diagonal day \(D = a + \tau\).
- If \(D \le B\) and the diagonal cell is integrity-valid, use the evidenced cumulative conversions \(Y(s, a, D)\).
- Else contribute 0 to the base (this is “not yet evidenced”, not “negative evidence”).

Then:

- \(Y_{base}(s,\tau) = \sum_{a \in W} Y_{evidenced}(s,a,\tau)\)
- \(R_{base}(s,\tau) = Y_{base}(s,\tau) / X_{full}(s)\) (null only if \(X_{full} = 0\))

Forecast crown at age \(\tau\):

- For cohorts where evidence is not yet available at the diagonal (typically \(D > B\)), fill the “remaining” contribution using forecast (derived from `projected_y` / `completeness`, and/or synthetic frames — see §2.3.7).

Then:

- \(R_{proj}(s,\tau)\) is the projected total rate over the same fixed denominator \(X_{full}(s)\).
- The **crown thickness** is \(\Delta R(s,\tau) = R_{proj}(s,\tau) - R_{base}(s,\tau)\).

##### Styling epochs (solid / dashed / future) — based on cohort-set completeness

The evidence base line style encodes whether the cohort-set is fully represented at that age:

- **Solid (“cannot now vary”)**: all cohort dates in the window have reached age \(\tau\) by the boundary day.
  - Condition: \(\tau \le (B - W_{end})\)
- **Dashed (“can still move”)**: some cohort dates in the window have not yet reached age \(\tau\) by \(B\).
  - Condition: \((B - W_{end}) < \tau \le \tau_{max}\)
- **Future (“no evidence possible”)**: no cohort date in the window can have evidence at that age by \(B\).
  - Condition: \(\tau > (B - W_{start})\)

Axis extent:

- Default \(\tau_{max} = t95\) for `window()`, and \(\tau_{max} = path\_t95\) for `cohort()`.

##### Gaps / integrity aggregation policy

Integrity gaps (e.g. `__epoch_gap__` or non-MECE slice coverage) can remove some diagonal cells.

Policy:

- Exclude missing diagonal cells from both base and projected calculations (do not fabricate evidence).
- **Thin** (and optionally slightly fade) the evidence line segment when coverage is partial.
- Only render the point as missing if there is literally no data (e.g. \(X_{full} = 0\) or coverage is 0 for all cohorts).

##### Per-mode rendering (E / F / F+E)

- **Mode E (evidence only)**:
  - Render **rich base line** \(R_{base}\) only (solid/dashed as above).
  - No crown band. No future rendering.
- **Mode F (forecast only)**:
  - Render forecast depiction only: \(R_{proj}\) (and future tail) using the forecast visual language.
- **Mode F+E**:
  - Render **rich base line** \(R_{base}\) (solid/dashed).
  - Render a **light filled crown band** between \(R_{base}\) and \(R_{proj}\) to show “what we expect” as an augmentation atop the evidenced base.
  - In the future region, render forecast-only (no base line).

##### Tooltip (all modes; per scenario)

```
  τ = 8 days · as-at 19-Jun-26
  ── Scenario A
     N_full: 12,345
     Base (evidenced):   37.5%
     Crown (forecast):  +10.0%
     Projected total:    47.5%
     Coverage: 92% (integrity gaps)
```

---

#### 2.3.6 Display Conditionality — Mirroring Graph Logic

The graph canvas (`buildScenarioRenderEdges.ts`) has battle-tested conditionality logic for each mode. Charts must mirror the same semantics. The table below maps graph-level conditionals to chart-level equivalents:

**Graph → chart conditionality mapping:**

| Graph condition | Graph behaviour | Chart equivalent |
|----------------|-----------------|------------------|
| `mode === 'e' && evidenceIsZero` (explicit k=0) | `isDashed = true`, thin hairline | E mode + `evidence_y === 0`: show bar with zero height, dashed rate line segment, "0%" in tooltip |
| `mode === 'e' && !hasEvidence && p_mean > 0` | `useNoEvidenceOpacity = true` (0.2 opacity) | E mode + `evidence_y === null` but `y > 0`: show bar at 0.2 opacity, tooltip notes "no evidence data" |
| `mode === 'e' && evidenceIsDerived` | `useNoEvidenceOpacity = true`, bead shows `[E 71%]` | Not applicable to charts — chart rows are direct observations, not sibling residuals |
| `mode === 'f' && !groupHasAnyExplicit` (no forecast in group) | Falls back to `p.mean` | F mode + `projected_y === null`: fall back to `y` and `rate` (current rendering) |
| `mode === 'f+e'`, mature point (`completeness ≈ 1`) | Evidence lane ≈ full width, forecast stripe negligible | `forecast_y ≈ 0`: only evidence bar visible, single rate line (dual lines coincide) |
| `mode === 'f+e'`, immature point | Forecast stripe outer, evidence stripe inner | `forecast_y > 0`: stacked bars (evidence solid + forecast striped), dual rate lines diverge |
| `edgeProb === 0` | `isDashed = true` for all modes | `y === 0` and `projected_y === 0`: dashed line segment, no bar |

**Graceful degradation (no forecast data):**

If the forecast fields are absent (older snapshot data, or a backend that doesn't emit them), the chart must fall back to current behaviour seamlessly:

- If `evidence_y`, `projected_y`, `forecast_y` are all null for every row → render using `y` and `rate` exactly as today. No forecast layers, no dual lines, no stacked bars.
- If `completeness` is null → treat the point as mature (no forecast layer).
- In E mode with no forecast fields → identical to current rendering (E mode uses `y` which equals `evidence_y`).
- In F or F+E mode with no forecast fields → fall back to E-mode rendering with a subtle indicator (e.g. "(no forecast data)" in the chart header).

This ensures the feature is invisible and harmless for graphs/parameters that haven't been through the BE-forecasting pipeline.

---

#### 2.3.7 Cohort Maturity: Forecast “Tail” via Synthetic Frames (Backend-emitted)

For the cohort maturity chart, forecast matters most as: “what will the **crown** look like as cohorts age beyond what is currently evidenced, and how does the curve continue into the future?”

We will implement this by having the backend emit **synthetic frames** (additional `as_at_date`s beyond the latest real snapshot) for each scenario+subject. This is explicitly required so the frontend does not duplicate forecasting maths and so the synthetic points have a clear provenance (“backend model output”).

**Inputs available:** we now have `mu` and `sigma` persisted on the edge latency model (plus onset delta where applicable), so evaluating the lognormal CDF forward in time is straightforward in Python.

**Backend output shape:** the synthetic frames use the same structure as real frames. Each synthetic frame contains data points per `anchor_day` that include `projected_y` and the expected cumulative “observed so far” `y` at that future as-at (plus `completeness`). This gives the frontend enough information to evaluate the diagonal \(D = a + \tau\) for ages \(\tau\) that extend beyond the evidence boundary \(B\).

**Chart rendering rule:** synthetic frames are always rendered using the **forecast depiction** (never as evidence).

- In **F+E mode**: show **F only** for the tail (no evidence line because no evidence exists yet).
- In **F mode**: show F for the tail (consistent).
- In **E mode**: hide the tail entirely (consistent with “evidence only”).

This tail is the first step toward fan-chart style uncertainty overlays (Phase 3 below): the future region uses a light forecast band/fan that extends beyond the evidenced base.

---

#### 2.3.7 Visual Design Decisions — Reuse Graph Conventions

The main graph canvas already has a mature, tested visual language for F/E/F+E. Charts must reuse these conventions exactly, not invent new ones. The source of truth is the edge rendering pipeline in `buildScenarioRenderEdges.ts` → `ConversionEdge.tsx` and the swatch overlay in `ScenariosPanel.tsx`.

**Existing graph conventions (reference — do not reinvent):**

| Aspect | F+E | F | E |
|--------|-----|---|---|
| **Edge outer lane** | Striped (forecast): 45° diagonal stripes, 3px wide, 1px gap (`LAG_FORECAST_STRIPE_*` constants) | Same stripes, full width | Solid (scenario colour, no stripe) |
| **Edge inner lane** | Striped (evidence): 45° diagonal stripes, 1px wide, 3px gap (`LAG_EVIDENCE_STRIPE_*` constants) | None (hidden) | Full width |
| **Edge dashing** | Only when `edgeProb === 0` | Only when `edgeProb === 0` | When `edgeProb === 0` OR `evidenceIsZero` (explicit k=0) |
| **Edge opacity** | Full (`EDGE_OPACITY = 0.7`) | Full | Reduced to `NO_EVIDENCE_E_MODE_OPACITY = 0.2` when no evidence block exists |
| **Bead label prefix** | None (shows `79%`) | `F` prefix (shows `F 80%`) | `E` prefix (shows `E 71%`); brackets `[E 71%]` if derived |
| **Swatch overlay** | Left solid → right striped (gradient mask) | Full 45° stripes (`repeating-linear-gradient(45deg, transparent 0px, transparent 2px, rgba(255,255,255,0.5) 2px, rgba(255,255,255,0.5) 4px)`) | Solid (no overlay) |

**Key constants** (from `nodeEdgeConstants.ts`):

- `EDGE_OPACITY = 0.7`
- `NO_EVIDENCE_E_MODE_OPACITY = 0.2`
- `LAG_FORECAST_STRIPE_WIDTH = 3`, `LAG_FORECAST_STRIPE_GAP = 1`, `LAG_FORECAST_STRIPE_ANGLE = 45`
- `LAG_EVIDENCE_STRIPE_WIDTH = 1`, `LAG_EVIDENCE_STRIPE_GAP = 3`, `LAG_EVIDENCE_STRIPE_ANGLE = 45`

**Chart translations of these conventions:**

| Graph convention | Chart translation |
|------------------|-------------------|
| **Solid edge lane** (evidence) | **Solid bar** / **solid line** — scenario colour at full opacity |
| **Striped edge lane** (forecast) | **Striped bar** (CSS `repeating-linear-gradient(45deg, ...)` overlay matching the swatch pattern) / **dashed line** (`strokeDasharray: '5,5'` or ECharts `lineStyle.type: 'dashed'`) |
| **No evidence → 0.2 opacity** (E mode) | No direct equivalent needed — E mode simply doesn't show forecast, so there's no "missing evidence" state in chart bars. If all rows have null `evidence_y`, the chart falls back to current rendering (§2.3.6). |
| **`F` / `E` prefix on bead labels** | **Tooltip prefix**: in F mode, prefix values with `F`; in E mode, prefix with `E`. In F+E mode, label both layers explicitly ("Evidence: …" / "Projected: …"). |
| **Derived brackets `[E 71%]`** | Not directly applicable to chart data (chart rows don't have a derived/explicit distinction — they are observations, not sibling residuals). |

**Bar rendering in F+E mode:**

The forecast portion of stacked bars should use the **same stripe pattern** as the forecast edge lane and swatch overlay — 45° diagonal stripes over a lighter tint of the scenario colour. This is achieved with a CSS-style `repeating-linear-gradient` in the ECharts `itemStyle.decal` or SVG pattern. The exact pattern: `repeating-linear-gradient(45deg, transparent 0px, transparent 2px, rgba(255,255,255,0.5) 2px, rgba(255,255,255,0.5) 4px)`.

**Daily Conversions rate line rendering in F+E mode:**

- Evidence rate line: **solid**, scenario colour, 2.5px width.
- Projected rate line: **dashed** (`lineStyle.type: 'dashed'`), same colour, 1.5px width. This mirrors the dashed convention used for zero-evidence edges and is visually distinct from the solid evidence line without requiring a different colour.

**Cohort Maturity rendering in F+E mode:**

- Evidence: **rich base line** \(R_{base}\), solid in the “cannot now vary” region and dashed in the “can still move” region (see §2.3.5).
- Forecast: **light filled crown band** between \(R_{base}\) and \(R_{proj}\), using the same scenario hue at low opacity.
- Future: forecast-only depiction (band/fan), no evidence stroke.

**Legend entries:**

- **F+E mode (Daily Conversions)**: "Scenario A" (solid swatch) + "Scenario A · Projected" (striped swatch). Single-scenario: "Evidence" + "Projected".
- **F+E mode (Cohort Maturity)**: "Scenario A" (solid line swatch) + "Scenario A · Crown" (light fill swatch). Single-scenario: "Base" + "Crown".
- **F mode**: "Scenario A" with striped swatch (matching the `getSwatchOverlayStyle('f')` pattern).
- **E mode**: "Scenario A" with solid swatch (matching `getSwatchOverlayStyle('e')` — no overlay).

**No new colour palette required.** All visual distinction comes from stripe pattern, opacity, and line dash — exactly as in the graph canvas.

---

#### 2.3.8 Implementation — Files to Modify

**Files to modify:**

| File | Changes |
|------|---------|
| `AnalysisChartContainer.tsx` | Accept and thread `scenarioVisibilityModes` prop to chart children. |
| `SnapshotDailyConversionsChart.tsx` | Mode-sensitive bar series builder (stacked vs single), dual rate lines, enriched tooltip. |
| `SnapshotCohortMaturityChart.tsx` | Age-aligned cohort-set curve (base line + crown band + future tail), enriched tooltip. |
| `AnalyticsPanel.tsx` | Construct `scenarioVisibilityModes` map from `operations.getScenarioVisibilityMode()` and pass to `AnalysisChartContainer`. |
| `chartOperationsService.ts` | Persist `scenarioVisibilityModes` in chart tab payload so saved/pinned charts remember their mode. |
| `ChartViewer.tsx` | Read `scenarioVisibilityModes` from chart payload and pass to `AnalysisChartContainer`. |

No backend changes. No new files. No new dependencies.

**Graph source files to trace and mirror (reference — read carefully before implementing):**

| Graph file | What to extract | Chart usage |
|------------|----------------|-------------|
| `buildScenarioRenderEdges.ts` :520–664 | Mode → width/dash/opacity conditionality; `isDashed`, `useNoEvidenceOpacity`, `evidenceRatio` logic | Mirror in chart series builder for each mode |
| `edgeBeadHelpers.tsx` :321–454 | `getProbabilityBeadValueForLayer` — `prefix` (`E`/`F`/none), `isDerived` brackets | Mirror in tooltip formatting |
| `BeadLabelBuilder.tsx` :95–104 | `formatWithOptionalPrefix` — `F 80%`, `E 71%`, `[E 71%]` patterns | Mirror in tooltip text |
| `ScenariosPanel.tsx` :348–380 | `getSwatchOverlayStyle` — stripe CSS patterns per mode | Reuse exact CSS for chart legend swatches and bar decals |
| `nodeEdgeConstants.ts` :249–316 | Stripe dimensions, opacity constants | Import directly; do not duplicate magic numbers |
| `ConversionEdge.tsx` :2518–2722 | Dash array, opacity multiplication, hairline rendering | Reference for ECharts styling equivalents |

---

#### 2.3.9 Testing

- Extend existing chart snapshot/integration tests to cover F+E stacked rendering, E-only, F-only.
- Verify graceful degradation: pass data rows with null forecast fields, confirm chart renders identically to current behaviour.
- Verify per-scenario modes: multi-scenario chart where Scenario A is E and Scenario B is F+E, confirm each scenario renders independently according to its mode.
- Tooltip content assertions per mode.

---

#### 2.3.10 Delivery Phases (Agreed Scope)

We will deliver cohort-chart forecasting in three phases:

1. **Forecast-at-as-at (final) for cohort maturity**: compute and plot F alongside E for immature/incomplete points; hide F for mature points (E only once mature). This uses existing backend fields (`projected_y`, `completeness`) and requires frontend + normalisation work only.
2. **Synthetic future frames (backend)**: extend Python to emit synthetic future `as_at_date` frames using the persisted latency model (`mu`, `sigma`, onset delta). Frontend plots a forecast-only tail (consistent with per-scenario visibility mode).
3. **Confidence spreads (fan-chart style)**: add uncertainty bands around the tail first; then (fast follow) consider adding spreads for immature observed points too. This is explicitly a second phase beyond “just show F”.

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

> **Scope note (11-Feb-26):** Aggregation periods are a **separate feature scope** from forecast-aware rendering (§2.3). They are orthogonal — aggregation controls *time granularity* while F/E/F+E controls *data interpretation*. The two compose naturally (e.g. weekly bars in F+E mode would stack weekly `evidence_y` + `forecast_y`). Design and implement independently; aggregation is deferred and not blocking §2.3 work.

**Purpose:** Allow users to view data at different granularities.

| Granularity | Use Case |
|-------------|----------|
| **Daily** | Default; highest resolution |
| **Weekly** | Reduce noise; see trends |
| **Monthly** | Long-term patterns |

**Implementation:**

When aggregating to coarser periods, sum counts within each period bucket. Forecast fields aggregate naturally: `evidence_y` and `forecast_y` are additive (they sum to `projected_y`), so sums preserve the stacking relationship. `completeness` within a period should be the weighted mean (by `x`), not a simple average.

**Frontend:** Dropdown selector in chart header: "Daily | Weekly | Monthly"

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

> **Subsumed by §2.3 (11-Feb-26).** The original proposal here (colour bars by completeness threshold) is superseded by the F+E stacked bar design in §2.3.4, which communicates the same information more precisely: the evidence/forecast stack shows *exactly how much* is observed vs projected, not just whether the cohort is above/below a threshold. Completeness is shown numerically in the tooltip (§2.3.4, §2.3.5).
>
> A future enhancement could add a completeness colour gradient to bar borders or a secondary axis — but the F+E stacked visual is the primary mechanism and should be implemented first.

---

## 6. Files to Create/Modify

### 6.1 Phase 5a — Forecast-Aware Chart Rendering (§2.3)

No new files. No backend changes. Modifications only:

| File | Changes |
|------|---------|
| `AnalysisChartContainer.tsx` | Accept + thread `scenarioVisibilityModes` prop |
| `SnapshotDailyConversionsChart.tsx` | Mode-sensitive stacked bars, dual rate lines, enriched tooltip |
| `SnapshotCohortMaturityChart.tsx` | Age-aligned cohort-set curve (base line + crown band + future tail), enriched tooltip |
| `AnalyticsPanel.tsx` | Construct `scenarioVisibilityModes` map, pass to chart container |
| `chartOperationsService.ts` | Persist `scenarioVisibilityModes` in chart tab payload |
| `ChartViewer.tsx` | Read modes from chart payload, pass to chart container |

### 6.2 New Files (Phase 5 — deferred features)

| File | Purpose |
|------|---------|
| `graph-editor/src/components/charts/TimeSeriesLineChart.tsx` | Multi-series funnel time-series (§2.2) |
| `graph-editor/src/components/charts/FanChart.tsx` | Confidence band visualisation (§2.4) |
| `graph-editor/lib/runner/snapshot_derivations.py` | All Python derivation functions |
| `graph-editor/lib/runner/latency_analysis.py` | Drift computation (§4) |

### 6.3 Modifications (Phase 5 — deferred features)

| File | Changes |
|------|---------|
| `AnalysisChartContainer.tsx` | Route to new chart types (§2.2, §2.4) |
| `graph-editor/src/components/panels/analysisTypes.ts` | Register Phase 5 analysis types |
| `graph-editor/lib/runner/analyzer.py` | Dispatch to new derivations |

---

## 7. Dependencies

### 7.1 Phase 5a (§2.3 — forecast-aware rendering)

| Dependency | Status | Notes |
|------------|--------|-------|
| Snapshot write/read path | Done (Phases 1–3) | Foundation |
| Basic bar + cohort maturity charts | Done (Phase 3) | Foundation |
| BE-forecasting: completeness + evidence/forecast fields emitted | Done (Phases 1–8, `analysis-forecasting.md`) | Backend annotates rows |
| `graphComputeClient` normaliser pass-through | Done | Fields available in `result.data` |
| Per-scenario visibility mode in TabContext | Done | `operations.getScenarioVisibilityMode()` |

**All §2.3 dependencies are met.** The work is purely frontend chart rendering + mode plumbing.

### 7.2 Phase 5 (deferred features)

| Dependency | Status | Notes |
|------------|--------|-------|
| Sufficient snapshot history | N/A | Fan charts need weeks of data |
| Aggregation logic | Not started | Backend or frontend derivation |
| t95 latency parameters | Existing | Used for completeness calculation |

---

## 8. Success Metrics

### 8.1 Phase 5a (§2.3)

| Metric | Target |
|--------|--------|
| F+E mode: stacked bars render with evidence + forecast portions | Visual QA |
| F+E mode: dual rate lines diverge for immature cohorts, coincide for mature | Visual QA |
| E mode: chart renders identically to current behaviour | Visual QA + regression |
| F mode: bars use `projected_y`, line uses projected rate | Visual QA |
| Per-scenario mode: two scenarios with different modes render correctly in same chart | Visual QA |
| Graceful degradation: null forecast fields → current behaviour | Integration test |
| Tooltip shows completeness + evidence/forecast breakdown | Visual QA |
| Saved chart tabs remember visibility modes | Integration test |

### 8.2 Phase 5 (deferred)

| Metric | Target |
|--------|--------|
| Fan chart renders with ≥7 days history | Yes |
| Latency drift < 10% for stable funnels | Monitoring |
| Aggregation produces correct sums | Unit tests |

---

## 9. Open Questions

### 9.1 Resolved (11-Feb-26)

1. ~~**Colour palette:** What colours for evidence vs forecast?~~ → Resolved in §2.3.7. Same hue, opacity/dash distinction. No new palette needed.
2. ~~**Per-scenario vs chart-level mode:**~~ → Resolved: per-scenario (§2.3.2). User may compare "Scenario A evidence vs Scenario B forecast".

### 9.2 Open

1. **Export:** CSV export already works. Should the export include the evidence/forecast split columns? (Likely yes — they're already in `result.data`, just need to ensure `analysisResultToCsv` includes them.)
2. **Annotations:** Should users be able to annotate dates (e.g., "product launch")? Orthogonal to §2.3.
3. **Mobile responsiveness:** Do these charts need mobile variants? Low priority.

---

## 10. References

- [Snapshot DB Design](./snapshot-db-design.md) — §20, §21.2
- [Implementation Plan](./implementation-plan.md) — Phase 5 summary
