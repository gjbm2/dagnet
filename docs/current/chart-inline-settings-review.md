# Chart Inline Settings — Canvas vs Tab Review

**Date**: 9-Mar-26  
**Purpose**: Systematic review of which chart settings are accessible in canvas chart view vs tab view, and a proposal for a standardised inline UI pattern that surfaces more settings without consuming vertical space or overlapping the chart.

---

## 1. Current State: Canvas vs Tab Accessibility

### 1.1 Surface Filtering Logic

The registry uses `inline: 'full' | 'brief' | false`:

| Tier | Tab | Canvas |
|------|-----|--------|
| `brief` | ✓ | ✓ |
| `full` | ✓ | ✗ |
| `false` | ✗ | ✗ |

`getDisplaySettingsForSurface(kind, 'chart', 'inline', context)`:
- `context === 'canvas'` → only `inline === 'brief'`
- `context === 'tab'` → `inline !== false` (full + brief)

### 1.2 Settings with `inline: 'brief'` (Canvas-Accessible Today)

| Key | Label | Chart kinds |
|-----|-------|-------------|
| `show_legend` | Show legend | All chart kinds |
| `legend_position` | Legend position | All chart kinds |
| `orientation` | Orientation | bridge only |

**Canvas charts today**: Only these 2–3 settings appear inline. For bridge charts: orientation + legend. For all others: legend only.

### 1.3 Settings with `inline: 'full'` (Tab Only — Not Canvas)

| Key | Label | Chart kinds |
|-----|-------|-------------|
| `time_grouping` | Group by (Day/Week/Month) | daily_conversions, time_series, cohort_maturity |
| `series_type` | Bar vs Line | daily_conversions, time_series, bar_grouped |
| `stack_mode` | Grouped / Stacked / 100% | bar_grouped, time_series, daily_conversions |
| `metric_mode` | Proportional / Absolute | bar_grouped, time_series, daily_conversions |
| `show_trend_line` | Show trend line | daily_conversions |
| `moving_average` | Moving average (None/3d/7d/14d/30d) | daily_conversions, cohort_maturity |
| `cumulative` | Cumulative values | daily_conversions |
| `metric` | Cumulative vs Step | funnel |

### 1.4 Settings with `inline: false` (Props Panel / Modal Only)

Axis overrides, label position, bar width, reference lines, tooltip, animation, etc. — ~35 settings. Not relevant for inline expansion.

---

## 2. Gap Analysis: Highly Relevant Settings Missing from Canvas

For certain chart/analysis types, the `full`-only settings are highly relevant for quick exploration but require opening the properties panel or a tab.

| Chart kind | Missing from canvas | Why relevant |
|------------|---------------------|--------------|
| **daily_conversions** | time_grouping, series_type, stack_mode, metric_mode, show_trend_line, moving_average, cumulative | Time-series exploration: day/week/month, bar/line, stacked vs grouped, trend, smoothing — all common tweaks |
| **cohort_maturity** | time_grouping, moving_average | Same time-series exploration needs |
| **time_series** | time_grouping, series_type, stack_mode, metric_mode, moving_average | Same |
| **bar_grouped** | series_type, stack_mode, metric_mode | Comparison chart: bar vs line, stacked vs grouped |
| **funnel** | metric | Cumulative vs step probability — changes interpretation significantly |

---

## 3. Current Inline UI Pattern (Toolbar)

**Location**: `AnalysisChartContainer.tsx` lines 266–340.

**Layout**:
- Horizontal bar above the chart (`padding: 4px 4px 0`, `flexWrap: 'wrap'`)
- Row 1: Analysis type dropdown (canvas) / Chart kind chooser / Subject selector (daily_conversions, cohort_maturity)
- Row 2: Inline display settings (checkbox toggles, radio button groups) + action chrome (tab only: CSV, Open as Tab)

**Problems**:
- Each inline setting adds a button or button group → grows vertically when wrapped
- Canvas has only 2–3 brief settings today, so it’s compact; adding more would bloat the bar
- Overlap risk: if chart is small, the bar can consume a large fraction of the node height

---

## 4. Proposed Pattern: Floating Icon + Hover Expansion

**User preference**: Semi-transparent floating icon with hover affordance that expands on hover to show a larger range of inline options.

### 4.1 Behaviour

1. **Collapsed state**: Small semi-transparent icon (e.g. Settings/Sliders) in a corner of the chart area (e.g. top-right), low z-index, does not block chart interaction when not hovered. Animated: shrinks and fades to semi-transparent on mouse away.
2. **Hover state**: Icon becomes opaque and expands into a compact panel (popover/tooltip-like) showing:
   - All inline settings for the current chart kind (brief + full for canvas, i.e. expand canvas to match tab)
   - Same control types: checkbox toggles, radio pills, compact dropdowns
   - Panel positioned so it does not overlap the chart centre (e.g. anchored to the icon, opens downward/left)
3. **Click-outside / blur**: Panel collapses back to icon.
4. **Optional**: Click (not just hover) to “pin” the panel open until click-outside. *** ideally yes, we could have a pin affordance which persisted it as a toolbar until unpinned ** 

### 4.2 Placement

- **Canvas**: Float over the chart, e.g. `position: absolute; top: 4px; right: 4px` within the chart viewport. Icon uses `opacity: 0.7` or similar; hover `opacity: 1`.
- **Tab**: Same pattern, or keep the current toolbar for tab (more space) and add the floating icon as an alternative. Decision: start with canvas-only; tab can retain toolbar.

### 4.3 Visual Design

- Icon: Lucide `SlidersHorizontal` or `Settings` (size ~14–16px)
- Panel: Rounded corners, subtle shadow, theme-aware background (`var(--bg-secondary)`), border (`var(--border-primary)`)
- Compact layout: 2–3 columns of controls, small font (10–11px), minimal padding
- No overlap with chart: panel extends away from chart centre (e.g. top-right icon → panel opens down-left)

### 4.4 Visibility Animation

Transitions between collapsed and expanded states must be animated:

- **On hover (expand)**: Icon becomes fully opaque and expands into the panel. Use CSS transitions for `opacity` (e.g. 0.5 → 1) and `transform`/`width`/`height` (scale or grow) so the expansion feels smooth.
- **On mouse away (collapse)**: Panel shrinks back to icon size and fades to semi-transparent (e.g. opacity 0.5–0.6). Same transition properties, reversed.

Suggested: `transition: opacity 150ms ease, transform 200ms ease` (or equivalent for size). Keep durations short enough to feel responsive but long enough to read the motion.

### 4.5 Interaction Details

- Hover delay: ~150–200ms before expand (avoid accidental pop on mouse pass-through)
- Collapse delay: ~300ms after mouse leaves (allows moving into panel)
- Touch: Tap to toggle open/closed (no hover on touch devices)

---

## 5. Implementation Scope

### Phase A: Registry + Data (No UI Change)

- Add a third inline tier or a `canvasExpand: true` flag for settings that should appear in the floating panel on canvas but not in the current toolbar.
- Simpler: Change selected `inline: 'full'` settings to `inline: 'brief'` for chart kinds where they are highly relevant. That would make them appear in the *existing* toolbar for canvas — but the toolbar would grow.
- **Preferred**: Introduce `inline: 'canvas_expanded'` (or similar) meaning “shown in canvas floating panel only, not in the top toolbar”. The floating panel would request `getDisplaySettingsForSurface(..., 'inline', 'canvas')` but with a new mode that returns brief + canvas_expanded.

**Recommendation**: Add optional `inlineCanvas: 'always' | 'expanded_only' | false` to `DisplaySettingDef`. When `expanded_only`, the setting appears in the floating panel but not in the toolbar. When `always`, it appears in both (current brief behaviour). This keeps the toolbar minimal while the floating panel can show more.

### Phase B: Floating Panel Component

- New component: `ChartInlineSettingsFloating.tsx` (or similar)
- Props: `settings: DisplaySettingDef[]`, `display`, `onDisplayChange`, `chartContext`
- Renders: collapsed icon + expanded panel with same control rendering as `AnalysisChartContainer` (checkbox → toggle button, radio → pill group)
- Used by: `AnalysisChartContainer` when `chartContext === 'canvas'`, rendered as a sibling to the chart viewport, positioned absolutely

### Phase C: Registry Updates

- For daily_conversions, cohort_maturity, time_series: set `inlineCanvas: 'expanded_only'` on time_grouping, series_type, stack_mode, metric_mode, show_trend_line, moving_average, cumulative.
- For bar_grouped: same for series_type, stack_mode, metric_mode.
- For funnel: same for metric.
- Ensure `getDisplaySettingsForSurface` (or a new helper) returns these when requesting “canvas expanded” settings.

---

## 6. Alternative: Keep Toolbar, Add “More” Chevron

If the floating icon is deferred, a simpler option: keep the current toolbar, add a “More ▼” chevron that expands a second row of settings on click. Same settings, different layout. Less elegant but lower implementation cost.

---

## 7. Summary

| Aspect | Current | Proposed |
|--------|---------|----------|
| Canvas inline settings | 2–3 (brief only) | 2–3 in toolbar + 8–10 in floating panel |
| Tab inline settings | All full + brief in toolbar | Unchanged |
| Vertical space | Toolbar always visible | Toolbar minimal; expansion on demand |
| Overlap | Toolbar above chart | Floating icon + panel in corner, away from chart centre |

**Next step**: Confirm the floating icon + hover pattern, then implement Phase A (registry/helper) and Phase B (component) with a small set of `expanded_only` settings for daily_conversions as a pilot.
