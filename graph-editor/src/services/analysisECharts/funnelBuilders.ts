/**
 * analysisECharts/funnelBuilders.ts
 *
 * Funnel chart builders: extractFunnelSeriesPoints, buildFunnelEChartsOption,
 * and buildFunnelBarEChartsOption.
 *
 * Extracted from analysisEChartsService.ts — AEC-PR2.
 */

import type { AnalysisResult } from '../../lib/graphComputeClient';
import {
  echartsThemeColours,
  echartsTooltipStyle,
  isConversionFunnelResult,
  getDimLabel,
  getDimOrder,
  getScenarioTitleWithBasis,
} from './echartsCommon';

// ─── Types ──────────────────────────────────────────────────────────────────

type ScenarioId = string;
type StageId = string;

export type FunnelChartOptionArgs = {
  /**
   * Which scenario to chart. For multi-scenario results we keep v1 simple:
   * render a single funnel series for the chosen scenario.
   */
  scenarioId: ScenarioId;
  ui?: {
    /**
     * Show ECharts on-chart toolbox controls (save image, restore, zoom icons, etc).
     * Default: true.
     *
     * NOTE: When false we also suppress brush toolbox UI so panel views stay clean.
     */
    showToolbox?: boolean;
  };
};

export type FunnelBarMetric = 'cumulative_probability' | 'step_probability';

export type FunnelBarChartOptionArgs = {
  scenarioIds: ScenarioId[];
  metric: FunnelBarMetric;
  layout?: {
    widthPx?: number;
  };
  legend?: {
    scenarioDslSubtitleById?: Record<string, string>;
  };
  ui?: {
    /**
     * Show ECharts on-chart toolbox controls (magicType, data view, save image, etc).
     * Default: true.
     *
     * NOTE: When false we also suppress brush toolbox UI so panel views stay clean.
     */
    showToolbox?: boolean;
    /**
     * Font size (px) for the y-axis (left) labels, e.g. "100%".
     * Default: 11.
     */
    yAxisLabelFontSizePx?: number;
  };
  /**
   * Display settings (from analysisDisplaySettingsRegistry) — consumed for
   * toggles that change chart shape, e.g. `funnel_y_mode` ('rate' | 'count').
   */
  settings?: Record<string, any>;
};

export type FunnelSeriesPoint = {
  stageId: StageId;
  stageLabel: string;
  probability: number | null;
  stepProbability: number | null;
  dropoff: number | null;
  n: number | null;
  /**
   * Optional decomposition metrics surfaced by the runner for conversion_funnel/path analyses.
   *
   * - evidenceMean: cumulative evidence probability (arrivals/start-N) when available
   * - forecastMean: edge-local forecast baseline for the direct stage-to-stage edge (when present)
   * - pMean: blended (F+E) cumulative probability when visibility_mode is 'f+e'
   */
  evidenceMean: number | null;
  forecastMean: number | null;
  pMean: number | null;
  completeness: number | null;
  /**
   * doc 52 Level 2 hi/lo bands: 5%/95% MC quantiles (or Wilson CI in e mode).
   * Stage 0 is null by convention.
   */
  probabilityLo: number | null;
  probabilityHi: number | null;
  /**
   * doc 52 Level 2 e+f striation components (stage-by-stage):
   * - barHeightE: solid evidence portion
   * - barHeightFResidual: striated forecast residual = (e+f) − e
   * Null in non-e+f modes.
   */
  barHeightE: number | null;
  barHeightFResidual: number | null;
};

// ─── Helpers ────────────────────────────────────────────────────────────────

export function extractFunnelSeriesPoints(result: AnalysisResult, args: FunnelChartOptionArgs): FunnelSeriesPoint[] | null {
  const dims = result.semantics?.dimensions || [];
  const primary = dims.find(d => d.role === 'primary');
  const secondary = dims.find(d => d.role === 'secondary');

  if (!primary || !secondary) return null;
  if (primary.id !== 'stage' || secondary.id !== 'scenario_id') return null;

  const stageIds = [...new Set(result.data.map(r => String(r.stage)))].sort((a, b) => {
    return getDimOrder(result.dimension_values, 'stage', a) - getDimOrder(result.dimension_values, 'stage', b);
  });

  const points: FunnelSeriesPoint[] = [];
  for (const stageId of stageIds) {
    const row = result.data.find(r => String(r.stage) === stageId && String(r.scenario_id) === args.scenarioId) as any;
    points.push({
      stageId,
      stageLabel: getDimLabel(result.dimension_values, 'stage', stageId),
      probability: typeof row?.probability === 'number' ? row.probability : null,
      stepProbability: typeof row?.step_probability === 'number' ? row.step_probability : null,
      dropoff: typeof row?.dropoff === 'number' ? row.dropoff : null,
      n: typeof row?.n === 'number' ? row.n : null,
      evidenceMean: typeof row?.evidence_mean === 'number' ? row.evidence_mean : null,
      forecastMean: typeof row?.forecast_mean === 'number' ? row.forecast_mean : null,
      pMean: typeof row?.p_mean === 'number' ? row.p_mean : null,
      completeness: typeof row?.completeness === 'number' ? row.completeness : null,
      probabilityLo: typeof row?.probability_lo === 'number' ? row.probability_lo : null,
      probabilityHi: typeof row?.probability_hi === 'number' ? row.probability_hi : null,
      barHeightE: typeof row?.bar_height_e === 'number' ? row.bar_height_e : null,
      barHeightFResidual: typeof row?.bar_height_f_residual === 'number' ? row.bar_height_f_residual : null,
    });
  }

  return points;
}

// ─── Builders ───────────────────────────────────────────────────────────────

/**
 * Build an ECharts option for the existing "stage × scenario" funnel output.
 *
 * Notes:
 * - We keep the series single-scenario for now; multi-scenario funnels can be added later.
 * - `sort: 'none'` preserves stage order from the runner (important for readability).
 */
export function buildFunnelEChartsOption(result: AnalysisResult, args: FunnelChartOptionArgs): any | null {
  const points = extractFunnelSeriesPoints(result, args);
  if (!points) return null;

  const showToolbox = args.ui?.showToolbox ?? true;

  const seriesName = getScenarioTitleWithBasis(result, args.scenarioId);
  const colour = result.dimension_values?.scenario_id?.[args.scenarioId]?.colour;

  const fmtPct = (v: number | null) => (typeof v === 'number' ? `${(v * 100).toFixed(1)}%` : '—');
  const fmtNum = (v: number | null) => (typeof v === 'number' ? v.toLocaleString() : '—');

  return {
    animation: false,
    backgroundColor: 'transparent',
    tooltip: {
      trigger: 'item',
      ...echartsTooltipStyle(),
      formatter: (p: any) => {
        const raw: any = p?.data?.__raw;
        if (!raw) return '';
        const lines = [
          `<div style="font-weight:600;margin-bottom:4px;">${raw.stageLabel}</div>`,
          `<div><span style="opacity:0.75">Cum. probability:</span> ${fmtPct(raw.probability)}</div>`,
        ];
        if (raw.stepProbability !== null) lines.push(`<div><span style="opacity:0.75">Step probability:</span> ${fmtPct(raw.stepProbability)}</div>`);
        if (raw.dropoff !== null) lines.push(`<div><span style="opacity:0.75">Dropoff:</span> ${fmtPct(raw.dropoff)}</div>`);
        if (raw.n !== null) lines.push(`<div><span style="opacity:0.75">n:</span> ${fmtNum(raw.n)}</div>`);
        if (raw.completeness !== null) lines.push(`<div><span style="opacity:0.75">Completeness:</span> ${fmtPct(raw.completeness)}</div>`);
        return lines.join('');
      },
    },
    toolbox: showToolbox
      ? {
      show: true,
      right: 8,
      top: 8,
      feature: {
        saveAsImage: { show: true },
        restore: { show: true },
      },
        }
      : { show: false },
    series: [
      {
        name: seriesName,
        type: 'funnel',
        sort: 'none',
        left: '6%',
        right: '6%',
        top: showToolbox ? 42 : 8,
        bottom: 8,
        min: 0,
        max: 1,
        minSize: '0%',
        maxSize: '100%',
        gap: 2,
        funnelAlign: 'center',
        itemStyle: {
          borderColor: '#ffffff',
          borderWidth: 1,
          ...(colour ? { color: colour } : null),
        },
        label: {
          show: true,
          position: 'inside',
          formatter: (p: any) => {
            const raw: any = p?.data?.__raw;
            if (!raw) return p?.name ?? '';
            return `${raw.stageLabel}\n${fmtPct(raw.probability)}`;
          },
          fontSize: 7,
          overflow: 'none',
        },
        labelLine: { show: false },
        labelLayout: { hideOverlap: false },
        data: points.map(pt => ({
          name: pt.stageLabel,
          value: pt.probability ?? 0,
          __raw: pt,
        })),
      },
    ],
  };
}

/**
 * A more "useful" default visual for the funnel output: a labelled vertical bar chart.
 *
 * Why:
 * - The funnel trapezoids look nice but can be hard to read precisely.
 * - A bar chart makes the stage labels and relative magnitudes obvious.
 *
 * Design:
 * - Vertical grouped bars (stages on x-axis in runner order).
 * - Percent labels above bars.
 * - Tooltip includes step/dropoff/n/completeness when present.
 */
export function buildFunnelBarEChartsOption(result: AnalysisResult, args: FunnelBarChartOptionArgs): any | null {
  const dims = result.semantics?.dimensions || [];
  const primary = dims.find(d => d.role === 'primary');
  const secondary = dims.find(d => d.role === 'secondary');
  if (!primary || !secondary) return null;
  if (primary.id !== 'stage' || secondary.id !== 'scenario_id') return null;

  const stageIds = [...new Set(result.data.map(r => String((r as any).stage)))].sort((a, b) => {
    return getDimOrder(result.dimension_values, 'stage', a) - getDimOrder(result.dimension_values, 'stage', b);
  });

  const stageLabels = stageIds.map(id => getDimLabel(result.dimension_values, 'stage', id));

  const fmtPct = (v: number | null) => (typeof v === 'number' ? `${(v * 100).toFixed(1)}%` : '—');
  const fmtNum = (v: number | null) => (typeof v === 'number' ? v.toLocaleString() : '—');

  // Conversion Funnel special-case:
  // The runner's `step_probability` is a conditional probability (prob_i / prob_{i-1}).
  // For the chart toggle in this analysis we want "change since last step" = dropoff,
  // i.e. a positive decrease in cumulative probability between consecutive stages.
  const useStepChange = args.metric === 'step_probability' && isConversionFunnelResult(result);
  const metricLabel = useStepChange ? 'Change since last step' : args.metric === 'step_probability' ? 'Step probability' : 'Cum. probability';

  const clamp01 = (x: number) => Math.max(0, Math.min(1, x));
  const hexToRgba = (hex: string, alpha: number): string => {
    const h = String(hex || '').replace(/^#/, '').trim();
    const s = h.length === 3 ? h.split('').map(c => c + c).join('') : h;
    if (s.length !== 6) return hex;
    const r = parseInt(s.slice(0, 2), 16);
    const g = parseInt(s.slice(2, 4), 16);
    const b = parseInt(s.slice(4, 6), 16);
    if (![r, g, b].every(n => Number.isFinite(n))) return hex;
    return `rgba(${r}, ${g}, ${b}, ${Math.max(0, Math.min(1, alpha))})`;
  };

  const makeSeriesData = (scenarioId: string) => {
    const points = extractFunnelSeriesPoints(result, { scenarioId }) || [];
    const byStage = new Map(points.map(p => [p.stageId, p]));
    return stageIds.map(stageId => {
      const pt = byStage.get(stageId);
      const metricValue =
        args.metric === 'step_probability'
          ? (pt?.stepProbability ?? null)
          : (pt?.probability ?? null);
      return {
        value: metricValue ?? 0,
        __raw: pt || {
          stageId,
          stageLabel: getDimLabel(result.dimension_values, 'stage', stageId),
          probability: null,
          stepProbability: null,
          dropoff: null,
          n: null,
          evidenceMean: null,
          forecastMean: null,
          pMean: null,
          completeness: null,
          probabilityLo: null,
          probabilityHi: null,
          barHeightE: null,
          barHeightFResidual: null,
        },
      };
    });
  };

  const makeStackedFEData = (scenarioId: string) => {
    const points = extractFunnelSeriesPoints(result, { scenarioId }) || [];
    const byStage = new Map(points.map(p => [p.stageId, p]));
    return stageIds.map(stageId => {
      const pt = byStage.get(stageId) || null;
      // Prefer BE-supplied bar_height_e / bar_height_f_residual (runner/
      // funnel_engine computes these from the CF response). Fall back to
      // reconstructing from pMean/evidenceMean only when the runner didn't
      // populate them.
      const total = typeof pt?.pMean === 'number'
        ? pt.pMean
        : (typeof pt?.probability === 'number' ? pt.probability : null);
      const total01 = total === null ? null : clamp01(total);
      const barE = typeof pt?.barHeightE === 'number' ? clamp01(pt.barHeightE) : null;
      const barFRes = typeof pt?.barHeightFResidual === 'number' ? Math.max(0, pt.barHeightFResidual) : null;

      let ev: number;
      let residual: number;
      let eForDisplay: number | null;
      if (barE !== null && barFRes !== null) {
        ev = barE;
        residual = barFRes;
        eForDisplay = barE;
      } else {
        const e = typeof pt?.evidenceMean === 'number' ? pt.evidenceMean : null;
        const e01 = e === null ? null : clamp01(e);
        ev = typeof e01 === 'number' && typeof total01 === 'number' ? Math.min(total01, e01) : (typeof e01 === 'number' ? e01 : 0);
        residual = typeof total01 === 'number' ? Math.max(0, total01 - ev) : 0;
        eForDisplay = typeof e01 === 'number' ? e01 : null;
      }
      return {
        __raw: pt || {
          stageId,
          stageLabel: getDimLabel(result.dimension_values, 'stage', stageId),
          probability: null,
          stepProbability: null,
          dropoff: null,
          n: null,
          evidenceMean: null,
          forecastMean: null,
          pMean: null,
          completeness: null,
          probabilityLo: null,
          probabilityHi: null,
          barHeightE: null,
          barHeightFResidual: null,
        },
        __fe: {
          total: total01,
          evidence: eForDisplay,
          evidenceClamped: ev,
          forecastMinusEvidence: residual,
        },
      };
    });
  };

  const makeSeriesDataWithStepChange = (scenarioId: string) => {
    const points = extractFunnelSeriesPoints(result, { scenarioId }) || [];
    const byStage = new Map(points.map(p => [p.stageId, p]));
    let prevProb: number | null = null;
    return stageIds.map((stageId, idx) => {
      const pt = byStage.get(stageId) || null;
      const prob = typeof pt?.probability === 'number' ? pt.probability : null;
      const prevBefore = prevProb;
      const computedDropoff = idx === 0 || prevBefore === null || prob === null ? null : (prevBefore - prob);
      const dropoff = typeof pt?.dropoff === 'number' ? pt.dropoff : computedDropoff;
      const change = typeof dropoff === 'number' && Number.isFinite(dropoff) ? dropoff : null;
      if (prob !== null) prevProb = prob;
      return {
        value: change ?? 0,
        __metric: { kind: 'step_change', hasValue: change !== null, value: change, prevProbability: idx === 0 ? null : prevBefore, probability: prob },
        __raw: pt || {
          stageId,
          stageLabel: getDimLabel(result.dimension_values, 'stage', stageId),
          probability: null,
          stepProbability: null,
          dropoff: null,
          n: null,
          evidenceMean: null,
          forecastMean: null,
          pMean: null,
          completeness: null,
          probabilityLo: null,
          probabilityHi: null,
          barHeightE: null,
          barHeightFResidual: null,
        },
      };
    });
  };

  const scenarioIds = args.scenarioIds.filter(Boolean);
  const widthPx = args.layout?.widthPx && Number.isFinite(args.layout.widthPx) ? args.layout.widthPx : 560;
  const stageCount = stageLabels.length;
  const scenarioCount = scenarioIds.length;
  const dslByScenarioId = args.legend?.scenarioDslSubtitleById || {};
  const showToolbox = args.ui?.showToolbox ?? true;
  const yAxisLabelFontSizePx = args.ui?.yAxisLabelFontSizePx ?? 9;

  const shorten = (s: string, max: number) => {
    const t = (s || '').trim();
    if (t.length <= max) return t;
    return `${t.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
  };

  // Responsive heuristics (generic, not per-analysis hand tuning)
  const rotate =
    stageCount >= 14 || widthPx < 420 ? 60 :
    stageCount >= 10 || widthPx < 520 ? 45 :
    stageCount >= 7 ? 30 :
    0;

  const axisLabelWidth = Math.max(70, Math.min(140, Math.floor(widthPx / Math.max(1, stageCount)) - 10));

  // Conversion funnel: always show value labels — hiding them loses critical information.
  const showValueLabels = true;

  const splitStageLabel = (label: string): string => {
    // Try to wrap long labels into two lines at a natural word boundary.
    // Keep it conservative: only when label is long and has spaces.
    if (!label || label.length <= 16) return label;
    const parts = label.split(/\s+/g).filter(Boolean);
    if (parts.length < 2) return label;
    const mid = Math.ceil(parts.length / 2);
    const a = parts.slice(0, mid).join(' ');
    const b = parts.slice(mid).join(' ');
    // If wrapping doesn't actually shorten lines, keep single-line.
    if (Math.max(a.length, b.length) >= label.length) return label;
    return `${a}\n${b}`;
  };

  // Detect grouped stages (visitedAny) in dimension_values
  const stageDimValues = result.dimension_values?.stage || {};
  const groupedStageIds = new Set<string>();
  const allGroupMembers: string[] = [];  // ordered, unique across all groups
  for (const [stageId, meta] of Object.entries(stageDimValues)) {
    if ((meta as any)?.is_group && (meta as any)?.members) {
      groupedStageIds.add(stageId);
      for (const m of (meta as any).members as string[]) {
        if (!allGroupMembers.includes(m)) allGroupMembers.push(m);
      }
    }
  }
  const hasGroupedStages = groupedStageIds.size > 0;

  // Helper: compute alpha for member sub-bar within a group
  const memberAlpha = (memberIdx: number, memberCount: number): number => {
    if (memberCount <= 1) return 0.85;
    return 0.9 - (memberIdx * 0.5 / Math.max(1, memberCount - 1));
  };

  // Helper: get member label from dimension_values
  const getMemberLabel = (stageId: string, memberId: string): string => {
    const meta = stageDimValues[stageId] as any;
    return meta?.member_labels?.[memberId] ?? memberId;
  };

  // Helper: extract member data for a grouped stage from result.data
  const getMemberDataForStage = (scenarioId: string, stageId: string, memberId: string): any => {
    return result.data.find(r =>
      String(r.stage) === stageId &&
      String(r.scenario_id) === scenarioId &&
      String(r.stage_member) === memberId
    ) || null;
  };

  // doc 52 §5.1 — hi/lo whiskers as a custom series. The custom series's
  // renderItem callback receives `api.size([1, 0])[0]`, which is the
  // pixel width of one category band. Combined with the bar geometry
  // (barCategoryGap / barGap / scenarioCount / scenarioIndex) we can
  // place the whisker on the *exact* bar centre and size the caps as a
  // fixed fraction of the actual bar width — no estimation required.
  const _parsePct = (v: string | number | undefined, fallback = 0): number => {
    if (typeof v === 'number') return v;
    if (typeof v !== 'string') return fallback;
    const m = v.match(/^([\d.]+)%?$/);
    return m ? parseFloat(m[1]) / 100 : fallback;
  };
  const _barCategoryGapFrac = _parsePct(scenarioCount > 4 ? '15%' : '25%', 0.25);
  const _barGapFrac = _parsePct(scenarioCount > 4 ? '0%' : scenarioCount > 2 ? '10%' : '20%', 0.2);
  const CAP_BAR_FRACTION = 0.66;

  const buildWhiskerCustomSeries = (
    points: FunnelSeriesPoint[],
    scenarioIndex: number,
    name: string,
  ) => {
    const data: any[] = [];
    points.forEach((pt, idx) => {
      if (typeof pt.probabilityLo !== 'number' || typeof pt.probabilityHi !== 'number') return;
      if (!Number.isFinite(pt.probabilityLo) || !Number.isFinite(pt.probabilityHi)) return;
      data.push([idx, pt.probabilityLo, pt.probabilityHi]);
    });
    if (data.length === 0) return undefined;
    const stroke = echartsThemeColours().text;
    return {
      name: `__whisker_${name}`,
      type: 'custom',
      silent: true,
      z: 100,
      data,
      renderItem: (params: any, api: any) => {
        const idx = api.value(0);
        const lo = api.value(1);
        const hi = api.value(2);
        const loPt = api.coord([idx, lo]);
        const hiPt = api.coord([idx, hi]);
        // Category band width (px) for this category.
        const categoryBand = api.size([1, 0])[0];
        const groupWidth = categoryBand * (1 - _barCategoryGapFrac);
        const denom = scenarioCount + Math.max(0, scenarioCount - 1) * _barGapFrac;
        const barWidth = groupWidth / Math.max(1, denom);
        const capWidth = Math.max(2, barWidth * CAP_BAR_FRACTION);
        // Per-scenario x offset: bars sit side-by-side inside the group.
        // Centre of bar i = group_left + i*(barWidth + gap_px) + barWidth/2.
        const gapPx = barWidth * _barGapFrac;
        const groupLeft = -groupWidth / 2;
        const centerOffset = groupLeft + scenarioIndex * (barWidth + gapPx) + barWidth / 2;
        const cx = loPt[0] + centerOffset;
        const halfCap = capWidth / 2;
        const lineStyle = { stroke, lineWidth: 1, opacity: 0.9 };
        return {
          type: 'group',
          children: [
            // Vertical stem
            { type: 'line', shape: { x1: cx, y1: loPt[1], x2: cx, y2: hiPt[1] }, style: lineStyle },
            // Top cap
            { type: 'line', shape: { x1: cx - halfCap, y1: hiPt[1], x2: cx + halfCap, y2: hiPt[1] }, style: lineStyle },
            // Bottom cap
            { type: 'line', shape: { x1: cx - halfCap, y1: loPt[1], x2: cx + halfCap, y2: loPt[1] }, style: lineStyle },
          ],
        };
      },
    };
  };

  const series: any[] = [];
  for (let _scenarioIdx = 0; _scenarioIdx < scenarioIds.length; _scenarioIdx++) {
    const scenarioId = scenarioIds[_scenarioIdx];
    const scenarioIndex = _scenarioIdx;
    const baseSeriesName = getScenarioTitleWithBasis(result, scenarioId);
    const colour = result.dimension_values?.scenario_id?.[scenarioId]?.colour;
    const visibilityMode = result.dimension_values?.scenario_id?.[scenarioId]?.visibility_mode ?? 'f+e';
    // Disable F+E stacking when grouped stages exist (member stacking takes precedence)
    const shouldShowFEStack = !hasGroupedStages && !useStepChange && args.metric === 'cumulative_probability' && visibilityMode === 'f+e';

    const baseSeriesConfig = {
      type: 'bar',
      barGap: scenarioCount > 4 ? '0%' : scenarioCount > 2 ? '10%' : '20%',
      barCategoryGap: scenarioCount > 4 ? '15%' : '25%',
    };

    if (shouldShowFEStack) {
      const fePoints = makeStackedFEData(scenarioId);
      const stagePoints = extractFunnelSeriesPoints(result, { scenarioId }) || [];

      // Evidence segment (lower stack).
      series.push({
        name: `${baseSeriesName} · Evidence`,
        ...baseSeriesConfig,
        stack: scenarioId,
        itemStyle: colour ? { color: hexToRgba(colour, 0.85) } : undefined,
        label: { show: false },
        data: fePoints.map(p => ({
          value: p.__fe?.evidenceClamped ?? 0,
          __raw: p.__raw,
          __fe: p.__fe,
          __component: 'e',
        })),
      });

      // Forecast minus evidence segment (upper stack). Standard app
      // forecast-striation pattern: same colour, opacity 0.4, diagonal
      // decal. Matches snapshotBuilders.ts and cohortComparisonBuilders.ts.
      const forecastDecal = {
        symbol: 'rect',
        dashArrayX: [1, 0],
        dashArrayY: [3, 3],
        rotation: -Math.PI / 4,
      } as any;
      series.push({
        name: `${baseSeriesName} · Forecast`,
        ...baseSeriesConfig,
        stack: scenarioId,
        itemStyle: colour ? { color: colour, opacity: 0.4, decal: forecastDecal } : undefined,
        label: {
          show: showValueLabels,
          position: 'top',
          formatter: (p: any) => {
            const total = typeof p?.data?.__fe?.total === 'number' ? p.data.__fe.total : null;
            return typeof total === 'number' && Number.isFinite(total) ? fmtPct(total) : '';
          },
          fontSize: 7,
          color: echartsThemeColours().text,
        },
        data: fePoints.map(p => ({
          value: p.__fe?.forecastMinusEvidence ?? 0,
          __raw: p.__raw,
          __fe: p.__fe,
          __component: 'f_minus_e',
        })),
      });

      const whiskerSeries = buildWhiskerCustomSeries(stagePoints, scenarioIndex, scenarioId);
      if (whiskerSeries) series.push(whiskerSeries);
      continue;
    }

    // ── Grouped-stage path: base series + member series, all stacked ──
    if (hasGroupedStages && !useStepChange) {
      const points = extractFunnelSeriesPoints(result, { scenarioId }) || [];
      const byStage = new Map(points.map(p => [p.stageId, p]));

      // Base series: carries non-grouped stage values (grouped stages = 0)
      series.push({
        name: baseSeriesName,
        ...baseSeriesConfig,
        stack: scenarioId,
        itemStyle: colour ? { color: colour } : undefined,
        label: {
          show: showValueLabels,
          position: 'top',
          formatter: (p: any) => {
            const v = typeof p?.value === 'number' ? p.value : null;
            // Only show label for non-grouped stages (grouped stages show label on top member)
            if (p?.data?.__isGroupPlaceholder) return '';
            return typeof v === 'number' && Number.isFinite(v) ? fmtPct(v) : '';
          },
          fontSize: 7,
          color: echartsThemeColours().text,
        },
        data: stageIds.map(stageId => {
          if (groupedStageIds.has(stageId)) {
            // Placeholder: 0 value at grouped stages (member series carry the values)
            return { value: 0, __isGroupPlaceholder: true, __raw: byStage.get(stageId) || null };
          }
          const pt = byStage.get(stageId);
          const metricValue = args.metric === 'step_probability'
            ? (pt?.stepProbability ?? null)
            : (pt?.probability ?? null);
          return { value: metricValue ?? 0, __raw: pt || null };
        }),
      });

      // Member series: one per unique group member across all groups
      for (let mIdx = 0; mIdx < allGroupMembers.length; mIdx++) {
        const memberId = allGroupMembers[mIdx];
        const alpha = memberAlpha(mIdx, allGroupMembers.length);
        const isLastMember = mIdx === allGroupMembers.length - 1;

        // Find which grouped stage(s) this member belongs to
        const memberStageIds = new Set<string>();
        for (const gStageId of groupedStageIds) {
          const meta = stageDimValues[gStageId] as any;
          if (meta?.members?.includes(memberId)) memberStageIds.add(gStageId);
        }

        // Resolve a display label for this member (from any group it belongs to)
        let memberLabel = memberId;
        for (const gStageId of memberStageIds) {
          memberLabel = getMemberLabel(gStageId, memberId);
          break;
        }

        series.push({
          name: `${baseSeriesName} — ${memberLabel}`,
          ...baseSeriesConfig,
          stack: scenarioId,
          itemStyle: colour ? { color: hexToRgba(colour, alpha) } : undefined,
          label: {
            show: isLastMember && showValueLabels,
            position: 'top',
            formatter: (p: any) => {
              // Show total group probability on the topmost member
              const groupTotal = p?.data?.__groupTotal;
              return typeof groupTotal === 'number' && Number.isFinite(groupTotal) ? fmtPct(groupTotal) : '';
            },
            fontSize: 7,
            color: echartsThemeColours().text,
          },
          data: stageIds.map(stageId => {
            if (!memberStageIds.has(stageId)) {
              // Not a grouped stage for this member: contribute 0
              return { value: 0, __memberPlaceholder: true };
            }
            const memberRow = getMemberDataForStage(scenarioId, stageId, memberId);
            const memberProb = typeof memberRow?.probability === 'number' ? memberRow.probability : 0;

            // Compute group total for label (sum of all members for this stage+scenario)
            const meta = stageDimValues[stageId] as any;
            let groupTotal = 0;
            if (meta?.members) {
              for (const m of meta.members) {
                const row = getMemberDataForStage(scenarioId, stageId, m);
                groupTotal += typeof row?.probability === 'number' ? row.probability : 0;
              }
            }

            return {
              value: memberProb,
              __raw: memberRow,
              __memberLabel: memberLabel,
              __memberId: memberId,
              __groupTotal: groupTotal,
              __component: 'member',
            };
          }),
        });
      }
      continue;
    }

    // Default: a single bar series per scenario (no groups, no F+E stacking).
    const stagePointsDefault = extractFunnelSeriesPoints(result, { scenarioId }) || [];
    series.push({
      name: baseSeriesName,
      ...baseSeriesConfig,
      itemStyle: colour ? { color: colour } : undefined,
      label: {
        show: showValueLabels,
        position: 'top',
        formatter: (p: any) => {
          const metricInfo = p?.data?.__metric;
          if (useStepChange && metricInfo?.kind === 'step_change') {
            if (!metricInfo?.hasValue) return '';
            const v = typeof metricInfo?.value === 'number' ? metricInfo.value : null;
            return typeof v === 'number' && Number.isFinite(v) ? fmtPct(v) : '';
          }
          const v = typeof p?.value === 'number' ? p.value : null;
          return typeof v === 'number' && Number.isFinite(v) ? fmtPct(v) : '';
        },
        fontSize: 7,
        color: '#374151',
      },
      data: useStepChange ? makeSeriesDataWithStepChange(scenarioId) : makeSeriesData(scenarioId),
    });

    if (!useStepChange) {
      const whiskerSeries = buildWhiskerCustomSeries(stagePointsDefault, scenarioIndex, scenarioId);
      if (whiskerSeries) series.push(whiskerSeries);
    }
  }

  const paddedMin = 0;
  const paddedMax = 1;

  const legendNameByScenarioId = new Map<string, string>();
  for (const sid of scenarioIds) {
    legendNameByScenarioId.set(sid, getScenarioTitleWithBasis(result, sid));
  }
  const dslByLegendName = new Map<string, string>();
  for (const sid of scenarioIds) {
    const ln = legendNameByScenarioId.get(sid);
    const dsl = dslByScenarioId[sid];
    if (ln && typeof dsl === 'string' && dsl.trim()) {
      dslByLegendName.set(ln, dsl);
      // F+E stacked sub-series (standard concept naming).
      dslByLegendName.set(`${ln} · Evidence`, dsl);
      dslByLegendName.set(`${ln} · Forecast`, dsl);
      // Grouped-stage member sub-series.
      for (const memberId of allGroupMembers) {
        for (const gStageId of groupedStageIds) {
          const meta = stageDimValues[gStageId] as any;
          const memberLabel = meta?.member_labels?.[memberId] ?? memberId;
          dslByLegendName.set(`${ln} — ${memberLabel}`, dsl);
        }
      }
    }
  }

  // Multi-scenario legend: the first scenario's Evidence entry doubles as its
  // colour swatch and is labelled "{scenario name} — Evidence"; the first
  // scenario's other concepts (Forecast, etc.) are labelled by concept only.
  // Additional scenarios get a single Evidence-bar colour swatch labelled with
  // the scenario name. A whisker legend entry with an I-beam icon explains the
  // hi/lo caps. Internal `__whisker_*` series are otherwise excluded.
  // Concept pattern only applies when scenarios use the F+E stack naming;
  // for grouped-stage or single-bar modes we fall back to showing every
  // non-internal series.
  const firstScenarioName = legendNameByScenarioId.get(scenarioIds[0]) ?? '';
  const firstWhiskerName = `__whisker_${scenarioIds[0]}`;
  const conceptPatternActive =
    !hasGroupedStages &&
    !useStepChange &&
    args.metric === 'cumulative_probability' &&
    scenarioIds.every(sid => {
      const vm = result.dimension_values?.scenario_id?.[sid]?.visibility_mode ?? 'f+e';
      return vm === 'f+e';
    });
  const whiskerIconPath = 'path://M0,0 L10,0 L10,2 L6,2 L6,8 L10,8 L10,10 L0,10 L0,8 L4,8 L4,2 L0,2 Z';

  let legendData: any[];
  if (scenarioIds.length === 1 || !conceptPatternActive) {
    legendData = series
      .filter(s => s.name && typeof s.name === 'string' && !s.name.startsWith('__'))
      .map(s => ({ name: s.name, icon: 'roundRect' }));
  } else {
    legendData = [];
    // First scenario's concept series (Evidence first by construction in the series loop above).
    for (const s of series) {
      if (!s.name || typeof s.name !== 'string') continue;
      if (s.name.startsWith(`${firstScenarioName} · `)) {
        legendData.push({ name: s.name, icon: 'roundRect' });
      }
    }
    // Whisker explanation entry (single I-beam icon, theme-neutral).
    if (series.some(s => s.name === firstWhiskerName)) {
      legendData.push({
        name: firstWhiskerName,
        icon: whiskerIconPath,
        itemStyle: { color: echartsThemeColours().text },
      });
    }
    // Other scenarios' Evidence-bar colour swatches.
    for (const s of series) {
      if (!s.name || typeof s.name !== 'string') continue;
      if (s.name.startsWith('__')) continue;
      if (s.name.startsWith(`${firstScenarioName} · `)) continue;
      if (s.name.endsWith(' · Evidence') && s.type === 'bar') {
        legendData.push({ name: s.name, icon: 'roundRect' });
      }
    }
  }

  return {
    animation: false,
    backgroundColor: 'transparent',
    toolbox: showToolbox
      ? {
      show: true,
      right: 8,
      // Keep toolbox out of the legend area (legend lives at the very top).
      // Two-line legend entries make the top band taller, so shift toolbox down.
      top: scenarioIds.length > 1 ? 34 : 0,
      feature: {
        // Switch chart type / stacking, like the official ECharts examples.
        // Ref: https://echarts.apache.org/examples/en/editor.html?c=bar-label-rotation
        magicType: { show: true, type: ['line', 'bar', 'stack'] },
        dataZoom: { show: stageCount > 10 },
        dataView: { show: true, readOnly: true },
        restore: { show: true },
        saveAsImage: { show: true },
      },
        }
      : { show: false },
    brush: showToolbox
      ? {
      toolbox: ['rect', 'polygon', 'clear'],
      xAxisIndex: 0,
        }
      : undefined,
    // Leave ample space for legend/toolbox above the chart so the key doesn't overlap the plot.
    grid: {
      left: 8,
      right: 16,
      // Reserve enough space for:
      // - legend (2 lines per entry)
      // - toolbox row (below legend)
      top: scenarioIds.length > 1 ? (showToolbox ? 96 : 72) : (showToolbox ? 34 : 22),
      bottom: rotate ? 58 : 42,
      containLabel: true,
    },
    legend: scenarioIds.length > 1
      ? {
          top: 0,
          left: 8,
          right: showToolbox ? 150 : 16, // reserve space for toolbox icons when shown
          type: scenarioIds.length > 3 ? 'scroll' : 'plain',
          itemWidth: 14,
          itemHeight: 10,
          itemGap: 12,
          data: legendData,
          // Labels:
          //   - whisker entry → "Hi/Lo band"
          //   - first scenario's Evidence → "{scenario name} — Evidence"
          //   - first scenario's other concepts (Forecast, etc.) → concept only
          //   - other scenarios' Evidence swatches → scenario name only
          // DSL subtitle is appended only to scenario-representative entries
          // (first-scenario Evidence, other-scenario swatches), not to pure
          // concept entries (Forecast, whisker).
          formatter: (seriesName: string) => {
            if (seriesName === firstWhiskerName) return 'Expected result';
            const dotIdx = seriesName.indexOf(' · ');
            if (dotIdx < 0) return seriesName;
            const prefix = seriesName.slice(0, dotIdx);
            const suffix = seriesName.slice(dotIdx + 3);
            let display: string;
            let isScenarioEntry = false;
            if (prefix === firstScenarioName) {
              if (suffix === 'Evidence') {
                display = `${firstScenarioName} — Evidence`;
                isScenarioEntry = true;
              } else {
                display = suffix;
              }
            } else if (suffix === 'Evidence') {
              display = prefix;
              isScenarioEntry = true;
            } else {
              display = seriesName;
            }
            if (!isScenarioEntry) return display;
            const dsl = dslByLegendName.get(seriesName);
            if (!dsl) return display;
            const shortDsl = shorten(dsl, 54).replace(/\n/g, ' ');
            return `${display}\n{dsl|${shortDsl}}`;
          },
          textStyle: {
            rich: {
              dsl: {
                fontSize: 9,
                color: echartsThemeColours().textSecondary,
                fontFamily: "system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif",
                lineHeight: 14,
              },
            },
          },
        }
      : undefined,
    tooltip: {
      trigger: 'axis',
      confine: true,
      axisPointer: { type: 'shadow' },
      ...echartsTooltipStyle(),
      extraCssText: 'max-width: 520px; white-space: normal;',
      formatter: (params: any) => {
        const ps = Array.isArray(params) ? params : [params];
        const stageLabel = ps[0]?.axisValueLabel ?? '';
        const lines: string[] = [
          `<div style="font-size:11px;line-height:1.25;">` +
          `<div style="font-weight:600;margin-bottom:4px;">${stageLabel}</div>`
        ];
        for (const p of ps) {
          const raw: any = p?.data?.__raw;
          const metricInfo = p?.data?.__metric;
          const fe: any = p?.data?.__fe;
          const component: any = p?.data?.__component;
          const seriesName = p?.seriesName ?? '';

          // In F+E stacked mode we get two series per scenario; only render the summary once
          // (on the upper segment) so the tooltip stays readable.
          if (fe && component === 'e') continue;

          // Skip zero-value placeholder entries from grouped-stage member series
          if (p?.data?.__memberPlaceholder || p?.data?.__isGroupPlaceholder) continue;

          // Member component from grouped stage: show member-level detail
          if (component === 'member') {
            const memberLabel = p?.data?.__memberLabel ?? '';
            const memberProb = typeof p?.value === 'number' ? p.value : null;
            const groupTotal = typeof p?.data?.__groupTotal === 'number' ? p.data.__groupTotal : null;
            lines.push(`<div style="margin-top:2px; padding-left:8px;">`);
            lines.push(`<span style="opacity:0.75">${memberLabel}:</span> ${fmtPct(memberProb)}`);
            if (raw?.n !== null && raw?.n !== undefined) lines.push(` <span style="opacity:0.6">(n=${fmtNum(raw.n)})</span>`);
            lines.push(`</div>`);
            // Show group total on last member
            if (groupTotal !== null && p?.data?.__memberId === allGroupMembers[allGroupMembers.length - 1]) {
              lines.push(`<div style="margin-top:2px; padding-left:8px; font-weight:600;">`);
              lines.push(`<span style="opacity:0.75">Total:</span> ${fmtPct(groupTotal)}`);
              lines.push(`</div>`);
            }
            continue;
          }

          const metricVal =
            useStepChange && metricInfo?.kind === 'step_change'
              ? (metricInfo?.hasValue ? metricInfo.value : null)
              : (typeof p?.value === 'number' ? p.value : null);
          lines.push(`<div style="margin-top:6px;"><span style="font-weight:600;">${seriesName}</span></div>`);
          if (fe && component === 'f_minus_e') {
            const total = typeof fe?.total === 'number' ? fe.total : null;
            const e = typeof fe?.evidence === 'number' ? fe.evidence : null;
            const feResidual = typeof fe?.forecastMinusEvidence === 'number' ? fe.forecastMinusEvidence : null;
            lines.push(`<div><span style="opacity:0.75">${metricLabel} (total):</span> ${fmtPct(total)}</div>`);
            lines.push(`<div><span style="opacity:0.75">e:</span> ${fmtPct(e)}</div>`);
            lines.push(`<div><span style="opacity:0.75">f−e:</span> ${fmtPct(feResidual)}</div>`);
          } else {
            lines.push(`<div><span style="opacity:0.75">${metricLabel}:</span> ${fmtPct(metricVal)}</div>`);
          }
          if (raw?.dropoff !== null && raw?.dropoff !== undefined) lines.push(`<div><span style="opacity:0.75">Dropoff:</span> ${fmtPct(raw.dropoff)}</div>`);
          if (raw?.n !== null && raw?.n !== undefined) lines.push(`<div><span style="opacity:0.75">n:</span> ${fmtNum(raw.n)}</div>`);
          if (raw?.completeness !== null && raw?.completeness !== undefined) lines.push(`<div><span style="opacity:0.75">Completeness:</span> ${fmtPct(raw.completeness)}</div>`);
          if (typeof raw?.probabilityLo === 'number' && typeof raw?.probabilityHi === 'number') {
            lines.push(`<div><span style="opacity:0.75">90% band:</span> ${fmtPct(raw.probabilityLo)} – ${fmtPct(raw.probabilityHi)}</div>`);
          }
        }
        lines.push(`</div>`);
        return lines.join('');
      },
    },
    xAxis: {
      type: 'category',
      data: stageLabels.map(splitStageLabel),
      axisLabel: {
        interval: 0,
        rotate,
        width: axisLabelWidth,
        overflow: 'truncate',
        fontSize: 9,
        color: echartsThemeColours().text,
      },
      axisLine: { lineStyle: { color: echartsThemeColours().border } },
    },
    yAxis: {
      type: 'value',
      min: paddedMin,
      max: paddedMax,
      axisLabel: {
        formatter: (v: number) => `${Math.round(v * 100)}%`,
        fontSize: yAxisLabelFontSizePx,
        color: echartsThemeColours().text,
      },
      splitLine: { lineStyle: { color: echartsThemeColours().gridLine } },
      axisLine: { lineStyle: { color: echartsThemeColours().border } },
    },
    dataZoom: stageCount > 10
      ? [
          { type: 'inside', xAxisIndex: 0 },
        ]
      : undefined,
    series,
  };
}
