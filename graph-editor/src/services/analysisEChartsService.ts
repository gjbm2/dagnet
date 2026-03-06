import type { AnalysisResult, DimensionValueMeta } from '../lib/graphComputeClient';
import { isDarkMode } from '../theme/objectTypeTheme';

/** ECharts colour palette that respects current theme. Call at render time. */
function echartsThemeColours() {
  const dark = isDarkMode();
  return {
    text: dark ? '#e0e0e0' : '#374151',
    textSecondary: dark ? '#aaa' : '#6b7280',
    textMuted: dark ? '#888' : '#9ca3af',
    border: dark ? '#404040' : '#e5e7eb',
    gridLine: dark ? '#333' : '#e5e7eb',
    bg: dark ? '#1e1e1e' : '#ffffff',
    tooltipBg: dark ? '#2d2d2d' : '#fff',
    tooltipBorder: dark ? '#555' : '#ccc',
    tooltipText: dark ? '#e0e0e0' : '#333',
  };
}

/** Shared tooltip styling for all ECharts instances */
function echartsTooltipStyle() {
  const c = echartsThemeColours();
  return {
    backgroundColor: c.tooltipBg,
    borderColor: c.tooltipBorder,
    textStyle: { color: c.tooltipText },
  };
}

/**
 * Apply common display settings to a built ECharts option object.
 * Called at the end of every builder so common settings are handled uniformly.
 * Mutates `opt` in place and returns it.
 */
function applyCommonSettings(opt: any, settings: Record<string, any>): any {
  if (!opt) return opt;
  const c = echartsThemeColours();

  // ── Legend ──
  if (settings.show_legend === false) {
    opt.legend = { show: false };
  } else if (opt.legend && opt.legend.show !== false) {
    const pos = settings.legend_position;
    if (pos === 'bottom') {
      opt.legend.top = undefined;
      opt.legend.bottom = 0;
    } else if (pos === 'right') {
      opt.legend.top = undefined;
      opt.legend.left = undefined;
      opt.legend.right = 0;
      opt.legend.orient = 'vertical';
    } else if (pos === 'none') {
      opt.legend = { show: false };
    }
    // 'top' is already the default layout in all builders
  }

  // ── Grid lines ──
  const gridLines = settings.show_grid_lines;
  const gridStyle = settings.grid_line_style ?? 'dashed';
  const gridLineStyleObj = { type: gridStyle, color: c.gridLine };
  if (gridLines !== undefined) {
    const yAxes = Array.isArray(opt.yAxis) ? opt.yAxis : (opt.yAxis ? [opt.yAxis] : []);
    const xAxes = Array.isArray(opt.xAxis) ? opt.xAxis : (opt.xAxis ? [opt.xAxis] : []);
    const showH = gridLines === 'horizontal' || gridLines === 'both';
    const showV = gridLines === 'vertical' || gridLines === 'both';
    for (const y of yAxes) { y.splitLine = { show: showH, lineStyle: gridLineStyleObj }; }
    for (const x of xAxes) {
      if (!x.splitLine) x.splitLine = {};
      x.splitLine.show = showV;
      if (showV) x.splitLine.lineStyle = gridLineStyleObj;
    }
    if (gridLines === 'none') {
      for (const y of yAxes) y.splitLine = { show: false };
      for (const x of xAxes) x.splitLine = { show: false };
    }
  }

  // ── Axis label rotation ──
  const rotation = settings.axis_label_rotation;
  if (rotation !== undefined && rotation !== 'auto') {
    const angle = Number(rotation);
    if (Number.isFinite(angle)) {
      const xAxes = Array.isArray(opt.xAxis) ? opt.xAxis : (opt.xAxis ? [opt.xAxis] : []);
      for (const x of xAxes) {
        if (!x.axisLabel) x.axisLabel = {};
        x.axisLabel.rotate = angle;
      }
    }
  }

  // ── Axis label format ──
  const fmt = settings.axis_label_format;
  if (fmt && fmt !== 'auto') {
    const fmtFn = (v: number) => {
      if (fmt === 'percent') return `${(v * 100).toFixed(0)}%`;
      if (fmt === 'decimal_2') return v.toFixed(2);
      if (fmt === 'decimal_0') return Math.round(v).toString();
      if (fmt === 'compact') {
        if (Math.abs(v) >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`;
        if (Math.abs(v) >= 1_000) return `${(v / 1_000).toFixed(1)}K`;
        return v.toString();
      }
      return v.toString();
    };
    const yAxes = Array.isArray(opt.yAxis) ? opt.yAxis : (opt.yAxis ? [opt.yAxis] : []);
    for (const y of yAxes) {
      if (!y.axisLabel) y.axisLabel = {};
      y.axisLabel.formatter = fmtFn;
    }
  }

  // ── Tooltip ──
  if (settings.show_tooltip === false) {
    opt.tooltip = { show: false };
  } else if (opt.tooltip) {
    const mode = settings.tooltip_mode;
    if (mode === 'item') opt.tooltip.trigger = 'item';
    else if (mode === 'axis') opt.tooltip.trigger = 'axis';
  }

  // ── Animation ──
  if (settings.animate === false) {
    opt.animation = false;
  }

  // ── Data labels (series-level) ──
  const showLabels = settings.show_labels;
  const labelFontSize = settings.label_font_size;
  const labelPosition = settings.label_position;
  if (showLabels !== undefined || labelFontSize !== undefined || labelPosition !== undefined) {
    for (const s of (opt.series || [])) {
      if (!s.label) s.label = {};
      if (showLabels !== undefined && showLabels !== null) s.label.show = !!showLabels;
      if (labelFontSize !== undefined && labelFontSize !== null) s.label.fontSize = labelFontSize;
      if (labelPosition !== undefined) s.label.position = labelPosition;
    }
  }

  return opt;
}

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

export type BridgeChartOptionArgs = {
  layout?: {
    widthPx?: number;
    heightPx?: number;
  };
  ui?: {
    showToolbox?: boolean;
    axisLabelFontSizePx?: number;
    axisLabelMaxLines?: number;
    axisLabelMaxCharsPerLine?: number;
    /**
     * Optional override for x-axis label rotation (degrees).
     * Use 0 in tight panel views to avoid tall reserved label band.
     */
    axisLabelRotateDeg?: number;
    barWidthMinPx?: number;
    barWidthMaxPx?: number;
    /**
     * Fraction of category width to use as the target bar width before clamping.
     * This is the primary control for "chunkiness" once you have enough width;
     * barWidthMaxPx only matters if the raw width exceeds it.
     */
    barWidthFraction?: number;
    showRunningTotalLine?: boolean;
    /**
     * Render orientation for bridge charts.
     * - 'vertical': categories on x-axis (legacy)
     * - 'horizontal': categories on y-axis (recommended for readability)
     */
    orientation?: 'vertical' | 'horizontal';
  };
};

export type FunnelBridgeChartOptionArgs = {
  scenarioId: ScenarioId;
  layout?: {
    widthPx?: number;
  };
  ui?: {
    showToolbox?: boolean;
  };
};

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
};

function isConversionFunnelResult(result: AnalysisResult): boolean {
  return result.analysis_type === 'conversion_funnel' || result.analysis_name === 'Conversion Funnel';
}

function getDimLabel(dimensionValues: Record<string, Record<string, DimensionValueMeta>> | undefined, dimId: string, valueId: string): string {
  return dimensionValues?.[dimId]?.[valueId]?.name ?? valueId;
}

function getDimOrder(dimensionValues: Record<string, Record<string, DimensionValueMeta>> | undefined, dimId: string, valueId: string): number {
  const order = (dimensionValues?.[dimId]?.[valueId] as any)?.order;
  return typeof order === 'number' && Number.isFinite(order) ? order : 0;
}

function getScenarioTitleWithBasis(result: AnalysisResult, scenarioId: string): string {
  const name = getDimLabel(result.dimension_values, 'scenario_id', scenarioId);
  const basis = (result.dimension_values?.scenario_id?.[scenarioId] as any)?.probability_label;
  if (typeof basis === 'string' && basis.trim() && basis !== 'Probability') {
    return `${name} (${basis})`;
  }
  return name;
}

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
    });
  }

  return points;
}

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
          fontSize: 11,
          overflow: 'truncate',
        },
        labelLine: { show: false },
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
        },
      };
    });
  };

  const makeStackedFEData = (scenarioId: string) => {
    const points = extractFunnelSeriesPoints(result, { scenarioId }) || [];
    const byStage = new Map(points.map(p => [p.stageId, p]));
    return stageIds.map(stageId => {
      const pt = byStage.get(stageId) || null;
      const total = typeof pt?.pMean === 'number'
        ? pt.pMean
        : (typeof pt?.probability === 'number' ? pt.probability : null);
      const e = typeof pt?.evidenceMean === 'number' ? pt.evidenceMean : null;
      const total01 = total === null ? null : clamp01(total);
      const e01 = e === null ? null : clamp01(e);
      const ev = typeof e01 === 'number' && typeof total01 === 'number' ? Math.min(total01, e01) : (typeof e01 === 'number' ? e01 : 0);
      const residual = typeof total01 === 'number' ? Math.max(0, total01 - ev) : 0;
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
        },
        __fe: {
          total: total01,
          evidence: typeof e01 === 'number' ? e01 : null,
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
  const yAxisLabelFontSizePx = args.ui?.yAxisLabelFontSizePx ?? 11;

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

  // Show percent labels more often (requested), but avoid unreadable clutter.
  // Hide overlaps via labelLayout so we don't need per-analysis tuning.
  const showValueLabels = (stageCount * scenarioCount) <= 48 || (scenarioCount === 1 && stageCount <= 14);

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

  // Bar width heuristic:
  // - Separate mode (scenarioCount=1) should be chunky.
  // - Combined mode shares a category width across scenarios.
  const plotWidth = Math.max(240, widthPx - 40);
  const perCategory = plotWidth / Math.max(1, stageCount);
  const groupTarget = perCategory * (stageCount <= 6 ? 0.72 : 0.62);
  const gapPx = scenarioCount > 1 ? 4 : 0;
  const raw = (groupTarget / Math.max(1, scenarioCount)) - gapPx;
  const maxBar = scenarioCount === 1 ? 84 : 44;
  const minBar = scenarioCount === 1 ? 18 : 12;
  const barWidthPx = Math.round(Math.max(minBar, Math.min(maxBar, raw)));

  const series: any[] = [];
  for (const scenarioId of scenarioIds) {
    const baseSeriesName = getScenarioTitleWithBasis(result, scenarioId);
    const colour = result.dimension_values?.scenario_id?.[scenarioId]?.colour;
    const visibilityMode = result.dimension_values?.scenario_id?.[scenarioId]?.visibility_mode ?? 'f+e';
    const shouldShowFEStack = !useStepChange && args.metric === 'cumulative_probability' && visibilityMode === 'f+e';

    const baseSeriesConfig = {
      type: 'bar',
      barWidth: barWidthPx,
      // Spacing tuning: reduce category gap for sparse charts so bars don't look lost.
      barCategoryGap: stageCount <= 6 ? '18%' : stageCount <= 10 ? '26%' : '34%',
      barGap: scenarioCount > 1 ? '25%' : '18%',
      labelLayout: showValueLabels ? { hideOverlap: true } : undefined,
    };

    if (shouldShowFEStack) {
      const fePoints = makeStackedFEData(scenarioId);

      // Evidence segment (lower stack).
      series.push({
        name: `${baseSeriesName} — e`,
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

      // Forecast minus evidence segment (upper stack). We render the total label here.
      series.push({
        name: `${baseSeriesName} — f−e`,
        ...baseSeriesConfig,
        stack: scenarioId,
        itemStyle: colour ? { color: hexToRgba(colour, 0.35) } : undefined,
        label: {
          show: showValueLabels,
          position: 'top',
          formatter: (p: any) => {
            const total = typeof p?.data?.__fe?.total === 'number' ? p.data.__fe.total : null;
            return typeof total === 'number' && Number.isFinite(total) ? fmtPct(total) : '';
          },
          fontSize: 10,
          color: echartsThemeColours().text,
        },
        data: fePoints.map(p => ({
          value: p.__fe?.forecastMinusEvidence ?? 0,
          __raw: p.__raw,
          __fe: p.__fe,
          __component: 'f_minus_e',
        })),
      });
      continue;
    }

    // Default: a single bar series per scenario.
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
        fontSize: 10,
        color: '#374151',
      },
      data: useStepChange ? makeSeriesDataWithStepChange(scenarioId) : makeSeriesData(scenarioId),
    });
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
      // If we render FE stacked sub-series, also attach the same DSL to those legend entries.
      dslByLegendName.set(`${ln} — e`, dsl);
      dslByLegendName.set(`${ln} — f−e`, dsl);
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
          // Two-line legend entries: scenario name + (truncated) DSL beneath.
          formatter: (name: string) => {
            const dsl = dslByLegendName.get(name);
            if (!dsl) return name;
            const shortDsl = shorten(dsl, 54).replace(/\n/g, ' ');
            // Use rich text style "dsl" for second line.
            return `${name}\n{dsl|${shortDsl}}`;
          },
          textStyle: {
            rich: {
              dsl: {
                fontSize: 10,
                color: echartsThemeColours().textSecondary,
                // DSL is often long; monospace is too wide here, so use a compact UI sans font.
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
        }
        lines.push(`</div>`);
        return lines.join('');
      },
    },
    xAxis: {
      type: 'category',
      data: stageLabels.map(splitStageLabel),
      axisLabel: {
        interval: 'auto',
        rotate,
        width: axisLabelWidth,
        overflow: 'truncate',
        hideOverlap: true,
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

/**
 * Build an ECharts "bridge"/waterfall option for Bridge View analysis.
 *
 * Expects runner output:
 * - primary dimension: bridge_step (ordered)
 * - metrics: total (for start/end), delta (for intermediate steps)
 */
export function buildBridgeEChartsOption(result: AnalysisResult, args: BridgeChartOptionArgs = {}): any | null {
  const dims = result.semantics?.dimensions || [];
  const metrics = result.semantics?.metrics || [];
  // Be defensive: some runner outputs may omit `role` (or set it to null).
  // For bridge charts we key off the dimension ID, not the role.
  const primary = dims.find(d => d.id === 'bridge_step') || dims.find(d => d.role === 'primary');
  if (!primary || primary.id !== 'bridge_step') return null;

  const deltaMetric = metrics.find(m => m.id === 'delta');
  const totalMetric = metrics.find(m => m.id === 'total');
  if (!deltaMetric || !totalMetric) return null;

  const showToolbox = args.ui?.showToolbox ?? false;
  const widthPx = args.layout?.widthPx && Number.isFinite(args.layout.widthPx) ? args.layout.widthPx : 640;
  const heightPx = args.layout?.heightPx && Number.isFinite(args.layout.heightPx) ? args.layout.heightPx : 360;
  const axisLabelFontSizePx = args.ui?.axisLabelFontSizePx ?? 11;
  const axisLabelMaxLines = args.ui?.axisLabelMaxLines ?? 2;
  const axisLabelMaxCharsPerLine = args.ui?.axisLabelMaxCharsPerLine ?? 12;
  const axisLabelRotateDeg = args.ui?.axisLabelRotateDeg;
  const barWidthMinPx = args.ui?.barWidthMinPx ?? 12;
  const barWidthMaxPx = args.ui?.barWidthMaxPx ?? 48;
  const barWidthFraction = args.ui?.barWidthFraction;
  const showRunningTotalLine = args.ui?.showRunningTotalLine ?? false;
  const orientation = args.ui?.orientation ?? 'vertical';

  const stepMeta = result.dimension_values?.bridge_step || {};
  const rows = [...(result.data || [])];
  rows.sort((a: any, b: any) => {
    const oa = (stepMeta[String(a.bridge_step)] as any)?.order ?? 0;
    const ob = (stepMeta[String(b.bridge_step)] as any)?.order ?? 0;
    return oa - ob;
  });

  const labelsRaw = rows.map((r: any) => (stepMeta[String(r.bridge_step)] as any)?.name ?? String(r.bridge_step));
  const totalsRaw = rows.map((r: any) => (typeof r.total === 'number' ? r.total : null));
  const deltasRaw = rows.map((r: any) => (typeof r.delta === 'number' ? r.delta : null));

  // Find start/end totals (if present) and build cumulative offsets for waterfall bars.
  const labels = labelsRaw;
  const totals = totalsRaw;
  const deltas = deltasRaw;

  const startIdx = rows.findIndex((r: any) => r.kind === 'start');
  const endIdx = rows.findIndex((r: any) => r.kind === 'end');
  const startTotal = startIdx >= 0 ? (totals[startIdx] ?? 0) : 0;
  const endTotal = endIdx >= 0 && typeof totals[endIdx] === 'number' ? (totals[endIdx] as number) : null;

  let cum = startTotal;
  const assist: Array<number | string> = [];
  const inc: Array<number | { value: number; __signed: number }> = [];
  const dec: Array<number | { value: number; __signed: number }> = [];
  const totalBars: Array<number | string | { value: number; itemStyle?: any }> = [];

  for (let i = 0; i < rows.length; i++) {
    const kind = rows[i]?.kind;
    const d = deltas[i];
    const t = totals[i];
    const colour = (stepMeta[String(rows[i]?.bridge_step)] as any)?.colour;

    if (kind === 'start' || kind === 'end' || (t !== null && (d === null || d === 0))) {
      // Important: use '-' for assist here so we don't create an (invisible) stacked bar
      // that forces the total bar into a separate "grouped" position.
      assist.push('-');
      inc.push('-' as any);
      dec.push('-' as any);
      totalBars.push(typeof t === 'number' ? ({ value: t, itemStyle: colour ? { color: colour } : undefined } as any) : '-');
      if (kind === 'start') cum = typeof t === 'number' ? t : cum;
      if (kind === 'end') cum = typeof t === 'number' ? t : cum;
      continue;
    }

    // For decreases, the bar should span from (cum + d) up to cum, so we shift the assist baseline down.
    const baseline = typeof d === 'number' && d < 0 ? (cum + d) : cum;
    assist.push(baseline);
    totalBars.push('-');

    if (typeof d === 'number') {
      if (d >= 0) {
        inc.push({ value: d, __signed: d });
        dec.push('-' as any);
      } else {
        inc.push('-' as any);
        dec.push({ value: Math.abs(d), __signed: d });
      }
      cum += d;
    } else {
      inc.push('-' as any);
      dec.push('-' as any);
    }
  }

  // Axis range: include totals and cumulative trajectory.
  const cumulativeValues: number[] = [];
  cum = startTotal;
  cumulativeValues.push(startTotal);
  for (const d of deltas) {
    if (typeof d === 'number') {
      cum += d;
      cumulativeValues.push(cum);
    }
  }
  const minV = Math.min(...cumulativeValues, 0);
  const maxV = Math.max(...cumulativeValues, ...(endIdx >= 0 && typeof totals[endIdx] === 'number' ? [totals[endIdx] as number] : []), 1e-9);

  const netDelta = (endTotal ?? cumulativeValues[cumulativeValues.length - 1] ?? startTotal) - startTotal;
  const netDeltaPctAbs = Math.abs(netDelta * 100);
  const deltaDecimals = netDeltaPctAbs < 2 ? 2 : 1;

  const fmtTotalPct = (v: number | null) => (typeof v === 'number' ? `${(v * 100).toFixed(1)}%` : '—');
  const fmtDeltaPct = (v: number | null) => (typeof v === 'number' ? `${(v * 100).toFixed(deltaDecimals)}%` : '—');

  // Typography: in tab view we pass a larger axisLabelFontSizePx; keep value labels aligned with that.
  const valueAxisLabelFontSizePx = Math.max(10, Math.min(12, Math.round(axisLabelFontSizePx * 0.92)));
  const valueLabelFontSizePx = Math.max(10, Math.min(13, Math.round(axisLabelFontSizePx * 0.95)));

  const plotWidth = Math.max(240, widthPx - 40);
  // Horizontal layout uses category axis on y, so bar thickness should be based on available height,
  // not width. Otherwise wide tabs produce absurdly thick bars.
  const plotHeight = Math.max(200, heightPx - (showToolbox ? 56 : 42));
  const n = Math.max(1, labels.length);
  const perCategory = (orientation === 'horizontal' ? plotHeight : plotWidth) / n;
  const defaultFraction = n <= 8 ? 0.56 : 0.44;
  const fraction = typeof barWidthFraction === 'number' && Number.isFinite(barWidthFraction) ? barWidthFraction : defaultFraction;
  const barWidthPx = Math.round(Math.max(barWidthMinPx, Math.min(barWidthMaxPx, perCategory * fraction)));

  const clampLabelIntoView = (p: any) => {
    const lr = p?.labelRect;
    const vr = p?.chartViewRect;
    if (!lr || !vr) return;
    let dx = 0;
    let dy = 0;
    const rightOverflow = (lr.x + lr.width) - (vr.x + vr.width);
    if (rightOverflow > 0) dx -= (rightOverflow + 4);
    const leftOverflow = vr.x - lr.x;
    if (leftOverflow > 0) dx += (leftOverflow + 4);
    const bottomOverflow = (lr.y + lr.height) - (vr.y + vr.height);
    if (bottomOverflow > 0) dy -= (bottomOverflow + 4);
    const topOverflow = vr.y - lr.y;
    if (topOverflow > 0) dy += (topOverflow + 4);
    return dx || dy ? ({ dx, dy } as any) : undefined;
  };

  const wrapLabel = (raw: string): string => {
    const s = String(raw ?? '').trim();
    if (!s) return '';
    // Split aggressively so IDs like "household-delegated" wrap instead of being truncated.
    const parts = s.split(/[\s/|._:\-–—]+/g).filter(Boolean);
    const lines: string[] = [];
    let current = '';
    const push = () => {
      if (current.trim()) lines.push(current.trim());
      current = '';
    };
    for (const p of parts) {
      // Hard-break very long tokens so we never clip with ellipsis.
      const chunks: string[] = [];
      if (p.length > axisLabelMaxCharsPerLine) {
        for (let i = 0; i < p.length; i += axisLabelMaxCharsPerLine) {
          chunks.push(p.slice(i, i + axisLabelMaxCharsPerLine));
        }
      } else {
        chunks.push(p);
      }

      for (const token of chunks) {
        const next = current ? `${current} ${token}` : token;
        if (next.length > axisLabelMaxCharsPerLine) {
          push();
          current = token;
        } else {
          current = next;
        }
        if (lines.length >= axisLabelMaxLines) break;
      }
      if (lines.length >= axisLabelMaxLines) break;
    }
    push();
    const out = lines.slice(0, axisLabelMaxLines).join('\n');
    return out || s;
  };

  const lineHeight = axisLabelFontSizePx + 2;
  const perCategoryPx = widthPx / Math.max(1, labels.length);
  const computedRotate =
    typeof axisLabelRotateDeg === 'number'
      ? axisLabelRotateDeg
      : (orientation === 'vertical' && perCategoryPx < 52 ? 45 : 0);

  const axisLabelAlign = orientation === 'vertical'
    ? (computedRotate ? 'right' : 'center')
    : 'right';
  const axisLabelVerticalAlign = orientation === 'vertical'
    ? (computedRotate ? 'middle' : 'top')
    : 'middle';

  const connectorSegments = (() => {
    if (!showRunningTotalLine) return undefined;
    let running = startTotal;
    const afterByIndex: number[] = [];
    for (let i = 0; i < rows.length; i++) {
      const kind = rows[i]?.kind;
      const t = totals[i];
      const d = deltas[i];
      if (kind === 'start' && typeof t === 'number') running = t;
      else if (typeof d === 'number') running += d;
      else if (kind === 'end' && typeof t === 'number') running = t;
      afterByIndex.push(running);
    }

    const segs: any[] = [];
    for (let i = 0; i < rows.length - 1; i++) {
      const level = afterByIndex[i];
      if (!Number.isFinite(level)) continue;
      if (orientation === 'horizontal') {
        segs.push([
          { coord: [level, labels[i]] },
          { coord: [level, labels[i + 1]] },
        ]);
      } else {
        segs.push([
          { coord: [labels[i], level] },
          { coord: [labels[i + 1], level] },
        ]);
      }
    }
    return segs;
  })();

  return {
    animation: false,
    backgroundColor: 'transparent',
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
    grid: {
      // Do NOT guess label extents (it creates systematic dead space). Instead keep a small
      // margin and let `containLabel` reserve what’s actually needed.
      left: 10,
      // Horizontal mode needs extra right padding for % labels placed to the right of bars.
      right: orientation === 'horizontal' ? 44 : 16,
      top: showToolbox ? 34 : 16,
      bottom: 10,
      containLabel: true,
    },
    tooltip: {
      trigger: 'axis',
      confine: true,
      axisPointer: { type: 'shadow' },
      ...echartsTooltipStyle(),
      position: (point: number[], _params: any, _dom: any, _rect: any, size: any) => {
        const [x, y] = point;
        const viewW = size.viewSize[0];
        const viewH = size.viewSize[1];
        const boxW = size.contentSize[0];
        const boxH = size.contentSize[1];
        const nx = Math.max(0, Math.min(x, viewW - boxW));
        const ny = Math.max(0, Math.min(y, viewH - boxH));
        return [nx, ny];
      },
      formatter: (params: any) => {
        const ps = Array.isArray(params) ? params : [params];
        const label = ps[0]?.axisValueLabel ?? '';
        const idx = ps[0]?.dataIndex ?? 0;
        const t = totals[idx];
        const d = deltas[idx];
        const before = (rows[idx] as any)?.reach_before;
        const after = (rows[idx] as any)?.reach_after;
        const lines: string[] = [`<div style="font-size:11px;line-height:1.25;">`];
        lines.push(`<div style="font-weight:600;margin-bottom:4px;">${label}</div>`);
        if (typeof t === 'number') {
          lines.push(`<div><span style="opacity:0.75">Reach:</span> ${fmtTotalPct(t)}</div>`);
        }
        if (typeof before === 'number' && typeof after === 'number') {
          lines.push(`<div><span style="opacity:0.75">Before:</span> ${fmtTotalPct(before)}</div>`);
          lines.push(`<div><span style="opacity:0.75">After:</span> ${fmtTotalPct(after)}</div>`);
        }
        if (typeof d === 'number') {
          const sign = d > 0 ? '+' : '';
          lines.push(`<div><span style="opacity:0.75">Change:</span> ${sign}${fmtDeltaPct(d)}</div>`);
        }
        lines.push(`</div>`);
        return lines.join('');
      },
    },
    xAxis: orientation === 'horizontal'
      ? {
          type: 'value',
          min: minV,
          max: maxV,
          splitNumber: 4,
          axisLabel: { formatter: (v: number) => `${Math.round(v * 100)}%`, fontSize: valueAxisLabelFontSizePx, margin: 10, color: echartsThemeColours().text },
          splitLine: { lineStyle: { color: echartsThemeColours().gridLine } },
          axisLine: { lineStyle: { color: echartsThemeColours().border } },
        }
      : {
          type: 'category',
          data: labels,
          axisTick: { alignWithLabel: true },
          axisLabel: {
            interval: 0,
            rotate: computedRotate,
            formatter: (v: string) => wrapLabel(v),
            margin: computedRotate ? 14 : 8,
            fontSize: axisLabelFontSizePx,
            lineHeight,
            hideOverlap: false,
            align: axisLabelAlign as any,
            verticalAlign: axisLabelVerticalAlign as any,
            color: echartsThemeColours().text,
          },
          axisLine: { lineStyle: { color: echartsThemeColours().border } },
        },
    yAxis: orientation === 'horizontal'
      ? {
          type: 'category',
          data: labels,
          inverse: true,
          axisLabel: {
            interval: 0,
            formatter: (v: string) => wrapLabel(v),
            fontSize: axisLabelFontSizePx,
            lineHeight,
            margin: 10,
            hideOverlap: false,
            color: echartsThemeColours().text,
          },
          axisLine: { lineStyle: { color: echartsThemeColours().border } },
        }
      : {
          type: 'value',
          min: minV,
          max: maxV,
          splitNumber: 4,
          axisLabel: { formatter: (v: number) => `${Math.round(v * 100)}%`, fontSize: valueAxisLabelFontSizePx, margin: 10, color: echartsThemeColours().text },
          splitLine: { lineStyle: { color: echartsThemeColours().gridLine } },
          axisLine: { lineStyle: { color: echartsThemeColours().border } },
        },
    series: [
      {
        name: 'Assist',
        type: 'bar',
        stack: 'waterfall',
        silent: true,
        itemStyle: { color: 'transparent' },
        emphasis: { disabled: true },
        barWidth: barWidthPx,
        barCategoryGap: n <= 8 ? '18%' : n <= 14 ? '26%' : '34%',
        // For horizontal waterfall, ECharts expects category axis on y and bars extend on x.
        // No extra config needed; series is shared.
        markLine: connectorSegments
          ? {
              silent: true,
              symbol: ['none', 'none'],
              label: { show: false },
              lineStyle: { color: echartsThemeColours().textMuted, width: 1 },
              data: connectorSegments,
            }
          : undefined,
        data: assist,
      },
      {
        name: 'Increase',
        type: 'bar',
        stack: 'waterfall',
        itemStyle: { color: '#10b981' },
        barWidth: barWidthPx,
        label: {
          show: true,
          position: orientation === 'horizontal' ? 'right' : 'top',
          distance: 6,
          formatter: (p: any) => {
            const v = typeof p?.value === 'number' ? p.value : null;
            return typeof v === 'number' && Number.isFinite(v) ? `+${fmtDeltaPct(v)}` : '';
          },
          fontSize: valueLabelFontSizePx,
          color: echartsThemeColours().text,
        },
        labelLayout: (p: any) => clampLabelIntoView(p),
        data: inc,
      },
      {
        name: 'Decrease',
        type: 'bar',
        stack: 'waterfall',
        itemStyle: { color: '#ef4444' },
        barWidth: barWidthPx,
        label: {
          show: true,
          position: orientation === 'horizontal' ? 'right' : 'bottom',
          distance: 6,
          formatter: (p: any) => {
            const v = typeof p?.value === 'number' ? p.value : null;
            return typeof v === 'number' && Number.isFinite(v) ? `-${fmtDeltaPct(v)}` : '';
          },
          fontSize: valueLabelFontSizePx,
          color: echartsThemeColours().text,
        },
        labelLayout: (p: any) => clampLabelIntoView(p),
        data: dec,
      },
      {
        name: 'Total',
        type: 'bar',
        itemStyle: { color: '#3b82f6' },
        barWidth: barWidthPx,
        barGap: '-100%',
        label: {
          show: true,
          position: orientation === 'horizontal' ? 'right' : 'top',
          distance: 6,
          formatter: (p: any) => {
            const v = typeof p?.value === 'number' ? p.value : null;
            return typeof v === 'number' && Number.isFinite(v) ? fmtTotalPct(v) : '';
          },
          fontSize: valueLabelFontSizePx,
          color: echartsThemeColours().text,
        },
        labelLayout: (p: any) => clampLabelIntoView(p),
        data: totalBars,
      },
    ],
  };
}

/**
 * Build a waterfall/bridge option for Conversion Funnel results (within a scenario).
 *
 * Interpretation:
 * - Start total = probability at first stage (typically 1.0)
 * - Steps = signed change in cumulative probability between stages (p_i - p_{i-1})
 * - End total = probability at final stage
 */
export function buildFunnelBridgeEChartsOption(result: AnalysisResult, args: FunnelBridgeChartOptionArgs): any | null {
  const points = extractFunnelSeriesPoints(result, { scenarioId: args.scenarioId });
  if (!points || points.length < 2) return null;

  const showToolbox = args.ui?.showToolbox ?? false;
  const widthPx = args.layout?.widthPx && Number.isFinite(args.layout.widthPx) ? args.layout.widthPx : 640;

  const labels = points.map(p => p.stageLabel);
  const probs = points.map(p => p.probability ?? null);
  const startTotal = typeof probs[0] === 'number' ? (probs[0] as number) : 0;
  const endTotal = typeof probs[probs.length - 1] === 'number' ? (probs[probs.length - 1] as number) : startTotal;

  const deltas: Array<number | null> = [];
  for (let i = 0; i < probs.length; i++) {
    if (i === 0) {
      deltas.push(null);
      continue;
    }
    const prev = probs[i - 1];
    const curr = probs[i];
    deltas.push(typeof prev === 'number' && typeof curr === 'number' ? (curr - prev) : null);
  }

  let cum = startTotal;
  const assist: Array<number | string> = [];
  const inc: Array<number | { value: number; __signed: number }> = [];
  const dec: Array<number | { value: number; __signed: number }> = [];
  const totalBars: Array<number | string | { value: number; itemStyle?: any }> = [];

  const scenarioColour = result.dimension_values?.scenario_id?.[args.scenarioId]?.colour;

  for (let i = 0; i < labels.length; i++) {
    if (i === 0 || i === labels.length - 1) {
      assist.push('-');
      inc.push('-' as any);
      dec.push('-' as any);
      const t = i === 0 ? startTotal : endTotal;
      totalBars.push({ value: t, itemStyle: scenarioColour ? { color: scenarioColour } : undefined } as any);
      cum = t;
      continue;
    }

    const d = deltas[i];
    const baseline = typeof d === 'number' && d < 0 ? (cum + d) : cum;
    assist.push(baseline);
    totalBars.push('-');

    if (typeof d === 'number') {
      if (d >= 0) {
        inc.push({ value: d, __signed: d });
        dec.push('-' as any);
      } else {
        inc.push('-' as any);
        dec.push({ value: Math.abs(d), __signed: d });
      }
      cum += d;
    } else {
      inc.push('-' as any);
      dec.push('-' as any);
    }
  }

  const plotWidth = Math.max(240, widthPx - 40);
  const n = Math.max(1, labels.length);
  const perCategory = plotWidth / n;
  const barWidthPx = Math.round(Math.max(18, Math.min(72, perCategory * (n <= 8 ? 0.62 : 0.48))));

  const fmtTotalPct = (v: number | null) => (typeof v === 'number' ? `${(v * 100).toFixed(1)}%` : '—');
  const fmtDeltaPct = (v: number | null) => (typeof v === 'number' ? `${(v * 100).toFixed(2)}%` : '—');

  const wrapLabel = (raw: string): string => {
    const s = String(raw ?? '').trim();
    if (!s) return '';
    const parts = s.split(/[\s/|]+/g).filter(Boolean);
    const lines: string[] = [];
    let current = '';
    const maxLines = 2;
    const maxChars = 12;
    const push = () => {
      if (current.trim()) lines.push(current.trim());
      current = '';
    };
    for (const p of parts) {
      const token = p.length > maxChars ? `${p.slice(0, maxChars - 1)}…` : p;
      const next = current ? `${current} ${token}` : token;
      if (next.length > maxChars) {
        push();
        current = token;
      } else {
        current = next;
      }
      if (lines.length >= maxLines) break;
    }
    push();
    return lines.slice(0, maxLines).join('\n') || s;
  };

  const minV = Math.min(0, startTotal, endTotal);
  const maxV = Math.max(1e-9, startTotal, endTotal);

  return {
    animation: false,
    backgroundColor: 'transparent',
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
    grid: { left: 8, right: 16, top: showToolbox ? 34 : 16, bottom: 92, containLabel: true },
    tooltip: {
      trigger: 'axis',
      axisPointer: { type: 'shadow' },
      ...echartsTooltipStyle(),
      formatter: (params: any) => {
        const ps = Array.isArray(params) ? params : [params];
        const label = ps[0]?.axisValueLabel ?? '';
        const idx = ps[0]?.dataIndex ?? 0;
        const t = idx === 0 ? startTotal : idx === labels.length - 1 ? endTotal : null;
        const d = deltas[idx];
        const lines: string[] = [`<div style="font-size:11px;line-height:1.25;">`];
        lines.push(`<div style="font-weight:600;margin-bottom:4px;">${label}</div>`);
        if (typeof t === 'number') lines.push(`<div><span style="opacity:0.75">Reach:</span> ${fmtTotalPct(t)}</div>`);
        if (typeof d === 'number') {
          const sign = d > 0 ? '+' : '';
          lines.push(`<div><span style="opacity:0.75">Change:</span> ${sign}${fmtDeltaPct(d)}</div>`);
        }
        lines.push(`</div>`);
        return lines.join('');
      },
    },
    xAxis: {
      type: 'category',
      data: labels,
      axisLabel: {
        interval: 0,
        rotate: (widthPx / Math.max(1, labels.length)) < 70 ? 45 : 0,
        formatter: (v: string) => wrapLabel(v),
        margin: 14,
        fontSize: 10,
        color: echartsThemeColours().text,
      },
      axisLine: { lineStyle: { color: echartsThemeColours().border } },
    },
    yAxis: {
      type: 'value',
      min: minV,
      max: maxV,
      splitNumber: 4,
      axisLabel: { formatter: (v: number) => `${Math.round(v * 100)}%`, fontSize: 10, margin: 10, color: echartsThemeColours().text },
      splitLine: { lineStyle: { color: echartsThemeColours().gridLine } },
      axisLine: { lineStyle: { color: echartsThemeColours().border } },
    },
    series: [
      {
        name: 'Assist',
        type: 'bar',
        stack: 'waterfall',
        silent: true,
        itemStyle: { color: 'transparent' },
        emphasis: { disabled: true },
        barWidth: barWidthPx,
        data: assist,
      },
      {
        name: 'Increase',
        type: 'bar',
        stack: 'waterfall',
        itemStyle: { color: '#10b981' },
        barWidth: barWidthPx,
        label: {
          show: true,
          position: 'top',
          distance: 6,
          formatter: (p: any) => {
            const v = typeof p?.value === 'number' ? p.value : null;
            return typeof v === 'number' && Number.isFinite(v) ? `+${fmtDeltaPct(v)}` : '';
          },
          fontSize: 10,
          color: echartsThemeColours().text,
        },
        labelLayout: { hideOverlap: true, moveOverlap: 'shiftY' },
        data: inc,
      },
      {
        name: 'Decrease',
        type: 'bar',
        stack: 'waterfall',
        itemStyle: { color: '#ef4444' },
        barWidth: barWidthPx,
        label: {
          show: true,
          position: 'bottom',
          distance: 6,
          formatter: (p: any) => {
            const v = typeof p?.value === 'number' ? p.value : null;
            return typeof v === 'number' && Number.isFinite(v) ? `-${fmtDeltaPct(v)}` : '';
          },
          fontSize: 10,
          color: echartsThemeColours().text,
        },
        labelLayout: { hideOverlap: true, moveOverlap: 'shiftY' },
        data: dec,
      },
      {
        name: 'Total',
        type: 'bar',
        itemStyle: { color: scenarioColour ? scenarioColour : '#3b82f6' },
        barWidth: barWidthPx,
        barGap: '-100%',
        label: {
          show: true,
          position: 'top',
          distance: 6,
          formatter: (p: any) => {
            const v = typeof p?.value === 'number' ? p.value : null;
            return typeof v === 'number' && Number.isFinite(v) ? fmtTotalPct(v) : '';
          },
          fontSize: 10,
          color: echartsThemeColours().text,
        },
        labelLayout: { hideOverlap: true, moveOverlap: 'shiftY' },
        data: totalBars,
      },
    ],
  };
}

// ============================================================
// Snapshot chart builders (migrated from inline component logic)
// ============================================================

/**
 * Build ECharts option for lag histogram (snapshot-based).
 * Input: LagHistogramResult { data: [{lag_days, conversions, pct}], total_conversions, cohorts_analysed }
 */
export function buildHistogramEChartsOption(data: any, settings: Record<string, any> = {}): any | null {
  if (!data?.data || data.data.length === 0) return null;

  const c = echartsThemeColours();
  const lagDays = data.data.map((d: any) => d.lag_days);
  const conversions = data.data.map((d: any) => d.conversions);
  const percentages = data.data.map((d: any) => d.pct * 100);

  const showLabels = settings.show_labels ?? (data.data.length <= 20);
  const yScale = settings.y_axis_scale ?? 'linear';

  return {
    tooltip: {
      trigger: 'axis',
      axisPointer: { type: 'shadow' },
      ...echartsTooltipStyle(),
      formatter: (params: any) => {
        const item = params[0];
        const dataItem = data.data[item.dataIndex];
        return `<strong>Lag: ${dataItem.lag_days} day${dataItem.lag_days !== 1 ? 's' : ''}</strong><br/>Conversions: ${dataItem.conversions.toLocaleString()}<br/>Percentage: ${(dataItem.pct * 100).toFixed(1)}%`;
      },
    },
    grid: { left: '3%', right: '4%', bottom: '3%', top: 40, containLabel: true },
    xAxis: {
      type: 'category',
      data: lagDays,
      name: 'Lag (days)',
      nameLocation: 'middle',
      nameGap: 30,
      axisLabel: { fontSize: 11, color: c.text },
    },
    yAxis: [{
      type: yScale === 'log' ? 'log' : 'value',
      name: settings.y_axis_title ?? 'Conversions',
      nameLocation: 'middle',
      nameGap: 45,
      min: settings.y_axis_min ?? undefined,
      max: settings.y_axis_max ?? undefined,
      axisLabel: {
        fontSize: 11,
        color: c.text,
        formatter: (value: number) => value >= 1000 ? `${(value / 1000).toFixed(1)}k` : value.toString(),
      },
    }],
    series: [{
      name: 'Conversions',
      type: 'bar',
      data: conversions,
      itemStyle: { color: '#3b82f6', borderRadius: [2, 2, 0, 0] },
      label: {
        show: showLabels,
        position: 'top',
        fontSize: settings.label_font_size ?? 9,
        formatter: (params: any) => {
          const pct = percentages[params.dataIndex];
          return pct >= 1 ? `${pct.toFixed(0)}%` : '';
        },
      },
    }],
  };
}

/**
 * Build ECharts option for daily conversions (snapshot-based dual-axis time-series).
 *
 * Left Y-axis: bar chart showing N (cohort size).
 * Right Y-axis: line chart showing conversion rate (%).
 */
export function buildDailyConversionsEChartsOption(
  result: any,
  settings: Record<string, any> = {},
  extra?: { visibleScenarioIds?: string[]; subjectId?: string },
): any | null {
  const rows: any[] = Array.isArray(result?.data) ? result.data : [];
  if (rows.length === 0) return null;

  const c = echartsThemeColours();
  const visibleScenarioIds = extra?.visibleScenarioIds || ['current'];
  const scenarioMeta: any = result?.dimension_values?.scenario_id || {};
  const subjectMeta: any = result?.dimension_values?.subject_id || {};

  const scenarioIds = [...new Set(rows.map((r: any) => String(r?.scenario_id)).filter(Boolean))];
  const subjectIds = [...new Set(rows.map((r: any) => String(r?.subject_id)).filter(Boolean))];
  const multiScenario = scenarioIds.length > 1;
  const effectiveSubjectId = extra?.subjectId || subjectIds[0] || 'subject';

  let filteredRows = rows.filter((r: any) => visibleScenarioIds.includes(String(r?.scenario_id)));
  if (multiScenario) {
    filteredRows = filteredRows.filter((r: any) => String(r?.subject_id) === effectiveSubjectId);
  }

  const seriesKey = multiScenario ? 'scenario_id' : 'subject_id';
  const meta = multiScenario ? scenarioMeta : subjectMeta;

  const PALETTE = ['#3b82f6', '#ef4444', '#10b981', '#f59e0b', '#8b5cf6', '#ec4899', '#06b6d4', '#84cc16'];

  const toBarFill = (hex: string): string => {
    const num = parseInt(hex.replace('#', ''), 16);
    const mix = 0.70;
    const r = Math.min(255, Math.round(((num >> 16) & 0xff) + (255 - ((num >> 16) & 0xff)) * mix));
    const g = Math.min(255, Math.round(((num >> 8) & 0xff) + (255 - ((num >> 8) & 0xff)) * mix));
    const b = Math.min(255, Math.round((num & 0xff) + (255 - (num & 0xff)) * mix));
    return `#${((1 << 24) + (r << 16) + (g << 8) + b).toString(16).slice(1)}`;
  };

  type Point = { date: string; rate: number | null; x: number; y: number };
  const byKey = new Map<string, Point[]>();
  for (const r of filteredRows) {
    const key = String(r?.[seriesKey]);
    const date = String(r?.date);
    const rate = (r?.rate === null || r?.rate === undefined) ? null : Number(r.rate);
    const x = Number(r?.x ?? 0);
    const y = Number(r?.y ?? 0);
    if (!key || !date) continue;
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key)!.push({
      date,
      rate: Number.isFinite(rate as any) ? (rate as number) : null,
      x: Number.isFinite(x) ? x : 0,
      y: Number.isFinite(y) ? y : 0,
    });
  }

  const allSeries: any[] = [];
  const keys = Array.from(byKey.keys()).sort();
  const showSmooth = settings.smooth ?? false;
  const showMarkers = settings.show_markers;
  const seriesType = settings.series_type ?? 'bar';

  for (let i = 0; i < keys.length; i++) {
    const key = keys[i];
    const points = (byKey.get(key) || []).slice().sort((a, b) => a.date.localeCompare(b.date));
    const name = meta?.[key]?.name || key;
    const strongColour = meta?.[key]?.colour || PALETTE[i % PALETTE.length];
    const lightColour = toBarFill(strongColour);

    allSeries.push({
      name: keys.length > 1 ? `${name} · N` : 'N',
      type: seriesType,
      yAxisIndex: 0,
      barMaxWidth: 24,
      itemStyle: { color: lightColour, borderRadius: [2, 2, 0, 0] },
      emphasis: { focus: 'series' },
      data: points.map(p => [p.date, p.x]),
    });

    allSeries.push({
      name: keys.length > 1 ? `${name} · Rate` : 'Conversion %',
      type: 'line',
      yAxisIndex: 1,
      showSymbol: showMarkers ?? (points.length <= 20),
      symbolSize: settings.marker_size ?? 5,
      smooth: showSmooth,
      connectNulls: settings.missing_data === 'connect',
      lineStyle: { width: 2.5, color: strongColour },
      itemStyle: { color: strongColour },
      emphasis: { focus: 'series' },
      data: points.map(p => [p.date, p.rate]),
      ...(settings.area_fill ? { areaStyle: { opacity: 0.15 } } : {}),
    });
  }

  if (allSeries.length === 0) return null;

  let maxRate = 0;
  for (const s of allSeries) {
    if (s.type !== 'line') continue;
    for (const d of s.data) {
      const v = d?.[1];
      if (typeof v === 'number' && Number.isFinite(v) && v > maxRate) maxRate = v;
    }
  }
  const rateMax = Math.min(1.0, Math.max(0.05, Math.ceil((maxRate * 1.2) * 20) / 20));

  const yScale = settings.y_axis_scale ?? 'linear';
  const showLegend = settings.show_legend ?? true;

  return {
    tooltip: {
      trigger: 'axis',
      axisPointer: { type: 'shadow' },
      ...echartsTooltipStyle(),
      formatter: (params: any) => {
        const items = Array.isArray(params) ? params : [params];
        const first = items[0];
        const dateRaw = first?.value?.[0];
        const dateStr = typeof dateRaw === 'number'
          ? new Date(dateRaw).toISOString().slice(0, 10)
          : String(dateRaw || '');
        const d = new Date(dateStr);
        const title = Number.isNaN(d.getTime()) ? dateStr : `${d.getDate()}-${d.toLocaleDateString('en-GB', { month: 'short' })}-${d.toLocaleDateString('en-GB', { year: '2-digit' })}`;
        const lines = items.map((it: any) => {
          const val = it?.value?.[1];
          const isRate = it?.seriesIndex !== undefined && allSeries[it.seriesIndex]?.type === 'line';
          const formatted = isRate
            ? (val === null || val === undefined || !Number.isFinite(val) ? '—' : `${(val * 100).toFixed(1)}%`)
            : (val === null || val === undefined || !Number.isFinite(val) ? '—' : val.toLocaleString());
          return `${it?.marker || ''} ${it?.seriesName || ''}: <strong>${formatted}</strong>`;
        });
        return `<strong>${title}</strong><br/>${lines.join('<br/>')}`;
      },
    },
    grid: { left: '3%', right: '4%', bottom: 60, top: allSeries.length > 2 ? 80 : 50, containLabel: true },
    xAxis: {
      type: 'time',
      name: settings.y_axis_title ?? 'Cohort date',
      nameLocation: 'middle',
      nameGap: 30,
      axisLabel: {
        fontSize: 10,
        rotate: 30,
        color: c.text,
        formatter: (value: number) => {
          const d = new Date(value);
          if (Number.isNaN(d.getTime())) return '';
          return `${d.getUTCDate()}-${d.toLocaleDateString('en-GB', { month: 'short', timeZone: 'UTC' })}`;
        },
      },
    },
    yAxis: [
      {
        type: yScale === 'log' ? 'log' : 'value',
        name: 'N',
        nameLocation: 'middle',
        nameGap: 45,
        min: settings.y_axis_min ?? 0,
        axisLabel: {
          fontSize: 11,
          color: c.text,
          formatter: (value: number) => {
            if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
            if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
            return value.toString();
          },
        },
        splitLine: { lineStyle: { color: c.gridLine } },
      },
      {
        type: 'value',
        name: 'Conversion %',
        nameLocation: 'middle',
        nameGap: 50,
        min: 0,
        max: settings.y_axis_max ?? rateMax,
        axisLabel: {
          fontSize: 11,
          color: c.text,
          formatter: (v: number) => `${(v * 100).toFixed(0)}%`,
        },
        splitLine: { show: false },
      },
    ],
    legend: showLegend ? { top: 22, left: 12, textStyle: { fontSize: 11, color: c.text }, icon: 'roundRect' } : { show: false },
    series: allSeries,
    ...(settings.animate === false ? { animation: false } : {}),
  };
}

/**
 * Build ECharts option for cohort maturity (age-aligned τ-curve).
 *
 * Segments per scenario:
 *  - solid: τ ≤ tauSolidMax (all cohorts have reached this age)
 *  - dashed: tauSolidMax < τ ≤ tauFutureMax (some cohorts still maturing)
 *  - future: τ > tauFutureMax (forecast-only synthetic frames)
 *
 * Visibility modes (per-scenario):
 *  - 'f+e': evidence base line + forecast crown fill + future tail
 *  - 'e': evidence only (no forecast)
 *  - 'f': forecast only (projected_rate as a single dashed line)
 *
 * Optionally overlays a model CDF curve from result.metadata.model_curves.
 */
export function buildCohortMaturityEChartsOption(
  result: any,
  settings: Record<string, any> = {},
  extra?: {
    visibleScenarioIds?: string[];
    scenarioVisibilityModes?: Record<string, 'f+e' | 'f' | 'e'>;
    subjectId?: string;
  },
): any | null {
  const rows: any[] = Array.isArray(result?.data) ? result.data : [];
  if (rows.length === 0) return null;

  const c = echartsThemeColours();
  const visibleScenarioIds = extra?.visibleScenarioIds || ['current'];
  const scenarioMeta: any = result?.dimension_values?.scenario_id || {};

  const subjectIds = [...new Set(rows.map((r: any) => String(r?.subject_id)).filter(Boolean))];
  const effectiveSubjectId = extra?.subjectId || subjectIds[0] || 'subject';

  const filteredRows = rows
    .filter((r: any) => String(r?.subject_id) === effectiveSubjectId)
    .filter((r: any) => visibleScenarioIds.includes(String(r?.scenario_id)));

  // Axis metadata
  let maxTau: number | null = null;
  let tauSolidMax: number | null = null;
  let tauFutureMax: number | null = null;
  let boundaryDate: string | null = null;
  for (const r of filteredRows) {
    const tau = Number(r?.tau_days);
    if (Number.isFinite(tau)) maxTau = Math.max(maxTau ?? 0, tau);
    const ts = Number(r?.tau_solid_max);
    const tf = Number(r?.tau_future_max);
    if (Number.isFinite(ts)) tauSolidMax = Math.max(tauSolidMax ?? 0, ts);
    if (Number.isFinite(tf)) tauFutureMax = Math.max(tauFutureMax ?? 0, tf);
    const b = r?.boundary_date;
    if (typeof b === 'string' && b) boundaryDate = b;
  }
  const solidMax = tauSolidMax ?? 0;
  const futureMax = tauFutureMax ?? 0;

  // Check for any signal at all
  let hasAnySignal = false;
  for (const r of filteredRows) {
    const base = r?.rate;
    const proj = r?.projected_rate;
    if ((typeof base === 'number' && Number.isFinite(base)) || (typeof proj === 'number' && Number.isFinite(proj))) {
      hasAnySignal = true;
      break;
    }
  }
  if (!hasAnySignal) return null;

  // Parse rows into per-scenario point arrays
  type RowPoint = {
    tauDays: number;
    baseRate: number | null;
    projectedRate: number | null;
    cohortsExpected: number | null;
    cohortsInDenom: number | null;
    cohortsCoveredBase: number | null;
    cohortsCoveredProjected: number | null;
  };
  const byScenario = new Map<string, RowPoint[]>();
  for (const r of filteredRows) {
    const sid = String(r?.scenario_id);
    const tau = Number(r?.tau_days);
    if (!sid || !Number.isFinite(tau)) continue;
    if (maxTau !== null && Number.isFinite(maxTau) && tau > maxTau) continue;

    const parse = (v: any) => (v === null || v === undefined) ? null : (Number.isFinite(Number(v)) ? Number(v) : null);

    if (!byScenario.has(sid)) byScenario.set(sid, []);
    byScenario.get(sid)!.push({
      tauDays: tau,
      baseRate: parse(r?.rate),
      projectedRate: parse(r?.projected_rate),
      cohortsExpected: parse(r?.cohorts_expected),
      cohortsInDenom: parse(r?.cohorts_in_denominator),
      cohortsCoveredBase: parse(r?.cohorts_covered_base),
      cohortsCoveredProjected: parse(r?.cohorts_covered_projected),
    });
  }

  const mkLine = (args: {
    id: string;
    name?: string;
    colour?: string;
    lineType: 'solid' | 'dashed' | 'dotted';
    opacity?: number;
    data: Array<{ value: [number, number | null]; [k: string]: any }>;
    showSymbol?: boolean;
    areaStyle?: any;
    z?: number;
    smooth?: boolean;
    emphasis?: any;
    showInLegend?: boolean;
  }): any | null => {
    if (args.data.length === 0) return null;
    const inLegend = args.showInLegend !== false && !!args.name;
    return {
      id: args.id,
      ...(args.name ? { name: args.name } : {}),
      type: 'line',
      showSymbol: args.showSymbol ?? false,
      symbolSize: 6,
      smooth: args.smooth ?? (settings.smooth || false),
      connectNulls: false,
      lineStyle: { width: 2, color: args.colour, type: args.lineType, opacity: args.opacity ?? 1 },
      itemStyle: { color: args.colour, opacity: args.opacity ?? 1 },
      emphasis: args.emphasis ?? { focus: 'series' },
      ...(args.areaStyle ? { areaStyle: args.areaStyle } : {}),
      ...(args.z !== undefined ? { z: args.z } : {}),
      ...(!inLegend ? { legendHoverLink: false } : {}),
      data: args.data,
    };
  };

  const seriesOut: any[] = [];
  for (const scenarioId of Array.from(byScenario.keys()).sort()) {
    const name = scenarioMeta?.[scenarioId]?.name || scenarioId;
    const colour = scenarioMeta?.[scenarioId]?.colour;
    const points = (byScenario.get(scenarioId) || []).slice().sort((a, b) => a.tauDays - b.tauDays);

    const mode = extra?.scenarioVisibilityModes?.[scenarioId]
      ?? (scenarioMeta?.[scenarioId]?.visibility_mode as any)
      ?? 'f+e';

    const toMeta = (p: RowPoint) => ({
      tauDays: p.tauDays,
      baseRate: p.baseRate,
      projectedRate: p.projectedRate,
      boundaryDate,
      cohortsExpected: p.cohortsExpected,
      cohortsInDenom: p.cohortsInDenom,
      cohortsCoveredBase: p.cohortsCoveredBase,
      cohortsCoveredProjected: p.cohortsCoveredProjected,
    });

    if (mode === 'f') {
      const forecastAll = points.map(p => ({ value: [p.tauDays, p.projectedRate] as [number, number | null], ...toMeta(p) }));
      const s = mkLine({
        id: `${scenarioId}::forecast`, name, colour, lineType: 'dashed', opacity: 0.85,
        data: forecastAll, showSymbol: forecastAll.length <= 12,
        areaStyle: { color: colour || '#111827', opacity: 0.08 },
      });
      if (s) seriesOut.push(s);
      continue;
    }

    const baseSolidPts = points.filter(p => p.tauDays <= solidMax).map(p => ({ value: [p.tauDays, p.baseRate] as [number, number | null], ...toMeta(p) }));
    const baseDashedPts = points.filter(p => p.tauDays >= solidMax && p.tauDays <= futureMax).map(p => ({ value: [p.tauDays, p.baseRate] as [number, number | null], ...toMeta(p) }));
    const futureForecastPts = points.filter(p => p.tauDays >= futureMax).map(p => ({ value: [p.tauDays, p.projectedRate] as [number, number | null], ...toMeta(p) }));
    const crownProjPts = points.filter(p => p.tauDays >= solidMax && p.tauDays <= futureMax).map(p => ({ value: [p.tauDays, p.projectedRate] as [number, number | null], ...toMeta(p) }));

    if (mode === 'f+e') {
      const sCrownUpper = mkLine({
        id: `${scenarioId}::crownUpper`, colour, lineType: 'dashed', opacity: 0,
        data: crownProjPts, areaStyle: { color: colour || '#111827', opacity: 0.15 },
      });
      const sCrownMask = mkLine({
        id: `${scenarioId}::crownMask`, colour, lineType: 'dashed', opacity: 0,
        data: baseDashedPts, areaStyle: { color: c.bg === '#1e1e1e' ? '#1e1e1e' : '#ffffff', opacity: 1 },
      });
      if (sCrownUpper) seriesOut.push(sCrownUpper);
      if (sCrownMask) seriesOut.push(sCrownMask);
    }

    const sBaseSolid = mkLine({
      id: `${scenarioId}::baseSolid`, name, colour, lineType: 'solid',
      data: baseSolidPts, showSymbol: baseSolidPts.length <= 12,
    });
    const sBaseDashed = mkLine({
      id: `${scenarioId}::baseDashed`, colour, lineType: 'dashed',
      data: baseDashedPts,
    });
    if (sBaseSolid) seriesOut.push(sBaseSolid);
    if (sBaseDashed) seriesOut.push(sBaseDashed);

    if (mode === 'f+e') {
      const sFuture = mkLine({
        id: `${scenarioId}::futureForecast`, colour, lineType: 'dashed', opacity: 0.75,
        data: futureForecastPts,
      });
      if (sFuture) seriesOut.push(sFuture);
    }
  }

  // Model CDF overlay
  const modelCurves = result?.metadata?.model_curves;
  if (modelCurves && typeof modelCurves === 'object') {
    const entry = modelCurves[effectiveSubjectId];
    if (entry?.curve && Array.isArray(entry.curve) && entry.curve.length > 0) {
      const data = entry.curve
        .filter((p: any) => typeof p?.tau_days === 'number' && typeof p?.model_rate === 'number')
        .map((p: any) => ({ value: [p.tau_days, p.model_rate] }));
      if (data.length > 0) {
        const modelColour = c.text === '#e0e0e0' ? '#9ca3af' : '#4b5563';
        seriesOut.push({
          id: 'model_cdf',
          name: 'Model CDF',
          type: 'line',
          showSymbol: false,
          smooth: true,
          connectNulls: false,
          lineStyle: { width: 2, color: modelColour, type: 'dotted', opacity: 0.7 },
          itemStyle: { color: modelColour },
          emphasis: { disabled: true },
          z: 10,
          data,
        });
        if (maxTau !== null) {
          const curveMax = data[data.length - 1]?.value?.[0];
          if (typeof curveMax === 'number' && Number.isFinite(curveMax) && curveMax > maxTau) {
            maxTau = curveMax;
          }
        }
      }
    }
  }

  // Y-axis max from data with headroom
  let maxRate = 0;
  for (const s of seriesOut) {
    for (const d of (s.data || [])) {
      const v = d?.value?.[1];
      if (typeof v === 'number' && Number.isFinite(v) && v > maxRate) maxRate = v;
    }
  }
  const yMax = settings.y_axis_max ?? Math.min(1.0, Math.max(0.05, Math.ceil((maxRate * 1.2) * 20) / 20));
  const showLegend = settings.show_legend ?? true;

  const fmtPercent = (v: number | null | undefined): string =>
    (v === null || v === undefined || !Number.isFinite(v)) ? '—' : `${(v * 100).toFixed(1)}%`;

  return {
    tooltip: {
      trigger: 'axis',
      axisPointer: { type: 'line' },
      ...echartsTooltipStyle(),
      formatter: (params: any) => {
        const items = Array.isArray(params) ? params : [params];
        const first = items[0];
        const tauDays = typeof first?.value?.[0] === 'number' ? first.value[0] : Number(first?.value?.[0]);

        const best = items.find((it: any) => it?.data?.baseRate !== undefined || it?.data?.projectedRate !== undefined)?.data ?? first?.data ?? {};
        const bd = typeof best?.boundaryDate === 'string' ? best.boundaryDate : (boundaryDate || '');
        const title = Number.isFinite(tauDays)
          ? `Age: ${tauDays} day(s) · As at ${bd}`
          : `As at ${bd}`;

        const scenarioItems = items.filter((it: any) => it?.seriesId !== 'model_cdf');
        const lines = scenarioItems
          .filter((it: any, idx: number, arr: any[]) => arr.findIndex((x: any) => String(x?.seriesName) === String(it?.seriesName)) === idx)
          .map((it: any) => `${it?.seriesName || 'Scenario'}: <strong>${fmtPercent(it?.value?.[1])}</strong>`);

        const extra_: string[] = [];
        if (best?.baseRate !== null && best?.baseRate !== undefined) extra_.push(`Evidenced: <strong>${fmtPercent(best.baseRate)}</strong>`);
        if (best?.projectedRate !== null && best?.projectedRate !== undefined) extra_.push(`Projected: <strong>${fmtPercent(best.projectedRate)}</strong>`);
        const modelItem = items.find((it: any) => it?.seriesId === 'model_cdf');
        if (modelItem) {
          const mv = modelItem?.value?.[1];
          if (typeof mv === 'number' && Number.isFinite(mv)) extra_.push(`Model CDF: <strong>${fmtPercent(mv)}</strong>`);
        }
        const ce = best?.cohortsExpected;
        const cd = best?.cohortsInDenom;
        if (typeof ce === 'number' && typeof cd === 'number') extra_.push(`Cohorts: <strong>${cd}/${ce}</strong> in denominator`);
        const cb = best?.cohortsCoveredBase;
        const cp = best?.cohortsCoveredProjected;
        if (typeof cb === 'number' && typeof cp === 'number') extra_.push(`Coverage: base <strong>${cb}</strong> · proj <strong>${cp}</strong> (at this τ)`);

        return `<strong>${title}</strong><br/>${[...lines, ...extra_].join('<br/>')}`;
      },
    },
    grid: { left: '3%', right: '4%', bottom: 60, top: seriesOut.length > 2 ? 80 : 50, containLabel: true },
    xAxis: {
      type: 'value',
      name: settings.x_axis_title ?? 'Age (days since cohort date)',
      nameLocation: 'middle',
      nameGap: 30,
      min: settings.x_axis_min ?? 0,
      ...(maxTau !== null && Number.isFinite(maxTau) ? { max: settings.x_axis_max ?? maxTau } : {}),
      axisLabel: { fontSize: 10, color: c.text, formatter: (v: number) => `${Math.round(v)}` },
    },
    yAxis: {
      type: (settings.y_axis_scale === 'log') ? 'log' : 'value',
      min: settings.y_axis_min ?? 0,
      max: yMax,
      name: settings.y_axis_title ?? 'Conversion rate',
      nameLocation: 'middle',
      nameGap: 45,
      axisLabel: { fontSize: 11, color: c.text, formatter: (v: number) => `${(v * 100).toFixed(0)}%` },
      splitLine: { lineStyle: { color: c.gridLine } },
    },
    legend: showLegend ? { top: 22, left: 12, textStyle: { fontSize: 11, color: c.text }, icon: 'roundRect' } : { show: false },
    series: seriesOut,
    dagnet_meta: {
      subject_id: effectiveSubjectId,
      anchor: { from: result?.metadata?.anchor_from, to: result?.metadata?.anchor_to },
      sweep: { from: result?.metadata?.sweep_from, to: result?.metadata?.sweep_to },
    },
    ...(settings.animate === false ? { animation: false } : {}),
  };
}

// ============================================================
// Unified dispatch — single entry point for all chart kinds
// ============================================================

type ChartKindId = 'funnel' | 'bridge' | 'bridge_horizontal' | 'histogram' | 'daily_conversions' | 'cohort_maturity';

/**
 * Build ECharts options for any chart kind from a unified interface.
 *
 * This is the single codepath: AnalysisChartContainer calls this with
 * (chartKind, result, resolvedSettings) and gets back an ECharts option object.
 *
 * Settings come from the display settings registry (resolveDisplaySetting).
 * The dispatch translates resolvedSettings to per-builder args internally.
 */
export function buildChartOption(
  chartKind: string,
  result: any,
  resolvedSettings: Record<string, any> = {},
  extra?: {
    visibleScenarioIds?: string[];
    scenarioVisibilityModes?: Record<string, 'f+e' | 'f' | 'e'>;
    scenarioDslSubtitleById?: Record<string, string>;
    subjectId?: string;
  },
): any | null {
  let opt: any | null;

  switch (chartKind) {
    case 'histogram':
      opt = buildHistogramEChartsOption(result, resolvedSettings);
      break;

    case 'funnel':
      opt = buildFunnelBarEChartsOption(result, {
        scenarioIds: extra?.visibleScenarioIds || ['current'],
        metric: resolvedSettings.metric || 'cumulative_probability',
        legend: { scenarioDslSubtitleById: extra?.scenarioDslSubtitleById },
        ui: { showToolbox: false },
      });
      // funnel_direction: left_to_right swaps axes
      if (opt && resolvedSettings.funnel_direction === 'left_to_right') {
        const tmpX = opt.xAxis;
        opt.xAxis = opt.yAxis;
        opt.yAxis = tmpX;
        for (const s of (opt.series || [])) {
          if (s.label?.position === 'top') s.label.position = 'right';
        }
      }
      break;

    case 'bridge':
    case 'bridge_horizontal':
      opt = buildBridgeEChartsOption(result, {
        ui: {
          showToolbox: false,
          orientation: resolvedSettings.orientation || (chartKind === 'bridge_horizontal' ? 'horizontal' : 'vertical'),
          showRunningTotalLine: resolvedSettings.show_running_total ?? true,
          barWidthMinPx: 8,
          barWidthMaxPx: 18,
        },
      });
      break;

    case 'daily_conversions':
      opt = buildDailyConversionsEChartsOption(result, resolvedSettings, {
        visibleScenarioIds: extra?.visibleScenarioIds,
        subjectId: extra?.subjectId,
      });
      break;

    case 'cohort_maturity':
      opt = buildCohortMaturityEChartsOption(result, resolvedSettings, {
        visibleScenarioIds: extra?.visibleScenarioIds,
        scenarioVisibilityModes: extra?.scenarioVisibilityModes,
        subjectId: extra?.subjectId,
      });
      break;

    default:
      return null;
  }

  if (!opt) return null;

  // ── Time grouping (re-bucket time-series data into week/month bins) ──
  const grouping = resolvedSettings.time_grouping;
  if (grouping && grouping !== 'day' && (chartKind === 'daily_conversions' || chartKind === 'cohort_maturity')) {
    for (const s of (opt.series || [])) {
      if (!Array.isArray(s.data) || s.data.length === 0) continue;
      if (!Array.isArray(s.data[0])) continue;

      const buckets = new Map<string, { sum: number; count: number; xKey: string }>();
      for (const pt of s.data) {
        const dateStr = String(pt[0]);
        const d = new Date(dateStr);
        if (Number.isNaN(d.getTime())) continue;

        let bucketKey: string;
        if (grouping === 'week') {
          const day = d.getDay();
          const weekStart = new Date(d);
          weekStart.setDate(d.getDate() - day);
          bucketKey = weekStart.toISOString().slice(0, 10);
        } else {
          bucketKey = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`;
        }

        const v = pt[1];
        if (typeof v !== 'number' || !Number.isFinite(v)) continue;
        const bucket = buckets.get(bucketKey) || { sum: 0, count: 0, xKey: bucketKey };
        bucket.sum += v;
        bucket.count += 1;
        buckets.set(bucketKey, bucket);
      }

      s.data = Array.from(buckets.values())
        .sort((a, b) => a.xKey.localeCompare(b.xKey))
        .map(b => [b.xKey, s.type === 'bar' ? b.sum : b.sum / b.count]);
    }
  }

  // ── Sort (category-axis charts: bridge, histogram) ──
  const sortBy = resolvedSettings.sort_by;
  if (sortBy && sortBy !== 'graph_order' && opt.xAxis?.data) {
    const dir = resolvedSettings.sort_direction === 'asc' ? 1 : -1;
    const catData = opt.xAxis.data as any[];
    const indices = catData.map((_: any, i: number) => i);

    if (sortBy === 'name') {
      indices.sort((a: number, b: number) => dir * String(catData[a]).localeCompare(String(catData[b])));
    } else if (sortBy === 'value') {
      const mainSeries = opt.series?.find((s: any) => s.type === 'bar' && s.name !== 'Assist');
      if (mainSeries?.data) {
        indices.sort((a: number, b: number) => {
          const va = typeof mainSeries.data[a] === 'number' ? mainSeries.data[a] : (mainSeries.data[a]?.value ?? 0);
          const vb = typeof mainSeries.data[b] === 'number' ? mainSeries.data[b] : (mainSeries.data[b]?.value ?? 0);
          return dir * (va - vb);
        });
      }
    }

    opt.xAxis.data = indices.map((i: number) => catData[i]);
    for (const s of (opt.series || [])) {
      if (Array.isArray(s.data) && s.data.length === catData.length) {
        s.data = indices.map((i: number) => s.data[i]);
      }
    }
  }

  // ── Stack mode (multi-series bar charts) ──
  const stackMode = resolvedSettings.stack_mode;
  if (stackMode && stackMode !== 'grouped') {
    for (const s of (opt.series || [])) {
      if (s.type === 'bar' && s.name !== 'Assist') {
        s.stack = 'stack';
        if (stackMode === 'stacked_100') s.stackStrategy = 'percentage';
      }
    }
  }

  // ── Cumulative toggle (time-series charts) ──
  if (resolvedSettings.cumulative) {
    for (const s of (opt.series || [])) {
      if (Array.isArray(s.data) && s.data.length > 0) {
        let running = 0;
        s.data = s.data.map((d: any) => {
          if (Array.isArray(d)) {
            running += (typeof d[1] === 'number' ? d[1] : 0);
            return [d[0], running];
          }
          if (typeof d === 'number') {
            running += d;
            return running;
          }
          return d;
        });
      }
    }
  }

  // ── Moving average (time-series charts) ──
  const maWindow = resolvedSettings.moving_average;
  if (maWindow && maWindow !== 'none') {
    const windowSize = parseInt(maWindow, 10) || 7;
    const showRaw = resolvedSettings.show_raw_with_average !== false;

    for (let si = opt.series.length - 1; si >= 0; si--) {
      const s = opt.series[si];
      if (s.type !== 'line' || !Array.isArray(s.data) || s.data.length < windowSize) continue;

      const maData = s.data.map((d: any, i: number) => {
        if (i < windowSize - 1) return Array.isArray(d) ? [d[0], null] : null;
        let sum = 0;
        let count = 0;
        for (let j = i - windowSize + 1; j <= i; j++) {
          const v = Array.isArray(s.data[j]) ? s.data[j][1] : s.data[j];
          if (typeof v === 'number' && Number.isFinite(v)) { sum += v; count++; }
        }
        const avg = count > 0 ? sum / count : null;
        return Array.isArray(d) ? [d[0], avg] : avg;
      });

      if (showRaw) {
        s.lineStyle = { ...s.lineStyle, opacity: 0.3 };
        s.showSymbol = false;
        const maSeries = {
          ...s,
          id: `${s.id || s.name}::ma`,
          name: `${s.name || ''} (${windowSize}d avg)`,
          data: maData,
          lineStyle: { ...s.lineStyle, opacity: 1, width: 2.5 },
        };
        opt.series.splice(si + 1, 0, maSeries);
      } else {
        s.data = maData;
        s.name = `${s.name || ''} (${windowSize}d avg)`;
      }
    }
  }

  // ── Funnel: show_dropoff adds step-to-step dropoff labels ──
  if (chartKind === 'funnel' && resolvedSettings.show_dropoff) {
    const barSeries = opt.series?.find((s: any) => s.type === 'bar' && s.data?.length > 1);
    if (barSeries?.data) {
      const dropoffLabels: any[] = [];
      for (let i = 1; i < barSeries.data.length; i++) {
        const prev = typeof barSeries.data[i - 1] === 'number' ? barSeries.data[i - 1] : barSeries.data[i - 1]?.value;
        const curr = typeof barSeries.data[i] === 'number' ? barSeries.data[i] : barSeries.data[i]?.value;
        if (typeof prev === 'number' && typeof curr === 'number' && prev > 0) {
          const dropoff = ((prev - curr) / prev * 100).toFixed(0);
          dropoffLabels.push({
            coord: [i - 0.5, (prev + curr) / 2],
            value: `−${dropoff}%`,
            label: { show: true, formatter: `−${dropoff}%`, fontSize: 9, color: '#ef4444' },
            symbol: 'none',
          });
        }
      }
      if (dropoffLabels.length > 0 && !barSeries.markPoint) {
        barSeries.markPoint = { data: dropoffLabels, silent: true };
      }
    }
  }

  // Bridge-specific: show_connectors controls the markLine connector segments
  if ((chartKind === 'bridge' || chartKind === 'bridge_horizontal') && resolvedSettings.show_connectors === false) {
    for (const s of (opt.series || [])) {
      if (s.markLine) s.markLine = undefined;
    }
  }

  // Bridge/histogram: bar_gap maps to barCategoryGap on all bar series
  const barGap = resolvedSettings.bar_gap;
  if (barGap !== undefined) {
    const gapMap: Record<string, string> = { none: '0%', small: '15%', medium: '30%', large: '50%' };
    const gapPct = gapMap[barGap] ?? barGap;
    for (const s of (opt.series || [])) {
      if (s.type === 'bar') s.barCategoryGap = gapPct;
    }
  }

  // ── Reference lines (ECharts markLine on first relevant series) ──
  const refLines = resolvedSettings.reference_lines;
  if (Array.isArray(refLines) && refLines.length > 0) {
    const target = opt.series?.find((s: any) => s.type === 'bar' || s.type === 'line');
    if (target) {
      const mlData = refLines.map((rl: any) => ({
        yAxis: rl.value,
        label: { formatter: rl.label || '', position: 'end', fontSize: 10 },
        lineStyle: { color: rl.colour || '#9CA3AF', type: rl.line_style || 'dashed', width: 1.5 },
      }));
      if (!target.markLine) target.markLine = { silent: true, symbol: ['none', 'none'], data: [] };
      target.markLine.data = [...(target.markLine.data || []), ...mlData];
    }
  }

  // ── Trend line (linear regression overlay for time-series) ──
  if (resolvedSettings.show_trend_line) {
    for (const s of (opt.series || [])) {
      if (s.type !== 'line' || !Array.isArray(s.data) || s.data.length < 3) continue;
      if (String(s.id || '').includes('::ma') || String(s.id || '').includes('::trend')) continue;

      const pts: Array<{ x: number; y: number }> = [];
      for (let i = 0; i < s.data.length; i++) {
        const d = s.data[i];
        const y = Array.isArray(d) ? d[1] : d;
        if (typeof y === 'number' && Number.isFinite(y)) pts.push({ x: i, y });
      }
      if (pts.length < 3) continue;

      const n = pts.length;
      const sumX = pts.reduce((a, p) => a + p.x, 0);
      const sumY = pts.reduce((a, p) => a + p.y, 0);
      const sumXY = pts.reduce((a, p) => a + p.x * p.y, 0);
      const sumX2 = pts.reduce((a, p) => a + p.x * p.x, 0);
      const denom = n * sumX2 - sumX * sumX;
      if (Math.abs(denom) < 1e-12) continue;

      const slope = (n * sumXY - sumX * sumY) / denom;
      const intercept = (sumY - slope * sumX) / n;

      const trendData = s.data.map((d: any, i: number) => {
        const trendY = intercept + slope * i;
        return Array.isArray(d) ? [d[0], trendY] : trendY;
      });
      opt.series.push({
        id: `${s.id || s.name}::trend`,
        name: `${s.name || ''} trend`,
        type: 'line',
        showSymbol: false,
        lineStyle: { width: 1.5, type: 'dotted', color: s.lineStyle?.color || s.itemStyle?.color || '#9CA3AF', opacity: 0.6 },
        itemStyle: { opacity: 0 },
        legendHoverLink: false,
        data: trendData,
        z: 1,
      });
      break;
    }
  }

  // ── Confidence intervals — requires ci_lower/ci_upper in data ──
  if (resolvedSettings.show_confidence) {
    for (const s of (opt.series || [])) {
      if (s.type !== 'line' || !Array.isArray(s.data)) continue;
      const hasCi = s.data.some((d: any) => d?.ci_lower !== undefined || d?.ci_upper !== undefined);
      if (!hasCi) continue;

      const colour = s.lineStyle?.color || s.itemStyle?.color || '#3b82f6';
      opt.series.push({
        id: `${s.id}::ci_upper`, type: 'line', showSymbol: false,
        lineStyle: { opacity: 0 }, itemStyle: { opacity: 0 },
        areaStyle: { color: colour, opacity: 0.1 },
        legendHoverLink: false,
        data: s.data.map((d: any) => Array.isArray(d) ? [d[0], (d as any).ci_upper ?? d[1]] : d),
        z: 0,
      });
      opt.series.push({
        id: `${s.id}::ci_lower`, type: 'line', showSymbol: false,
        lineStyle: { opacity: 0 }, itemStyle: { opacity: 0 },
        areaStyle: { color: '#ffffff', opacity: 1 },
        legendHoverLink: false,
        data: s.data.map((d: any) => Array.isArray(d) ? [d[0], (d as any).ci_lower ?? d[1]] : d),
        z: 0,
      });
      break;
    }
  }

  return applyCommonSettings(opt, resolvedSettings);
}

