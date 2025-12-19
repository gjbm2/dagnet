import type { AnalysisResult, DimensionValueMeta } from '../lib/graphComputeClient';

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
  };
  ui?: {
    showToolbox?: boolean;
    axisLabelFontSizePx?: number;
    axisLabelMaxLines?: number;
    axisLabelMaxCharsPerLine?: number;
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
          completeness: null,
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

  const series = scenarioIds.map(scenarioId => {
    const seriesName = getScenarioTitleWithBasis(result, scenarioId);
    const colour = result.dimension_values?.scenario_id?.[scenarioId]?.colour;

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

    return {
      name: seriesName,
      type: 'bar',
      barWidth: barWidthPx,
      // Spacing tuning: reduce category gap for sparse charts so bars don't look lost.
      barCategoryGap: stageCount <= 6 ? '18%' : stageCount <= 10 ? '26%' : '34%',
      barGap: scenarioCount > 1 ? '25%' : '18%',
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
      labelLayout: showValueLabels ? { hideOverlap: true } : undefined,
      data: useStepChange ? makeSeriesDataWithStepChange(scenarioId) : makeSeriesData(scenarioId),
    };
  });

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
                color: '#6b7280',
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
          const seriesName = p?.seriesName ?? '';
          const metricVal =
            useStepChange && metricInfo?.kind === 'step_change'
              ? (metricInfo?.hasValue ? metricInfo.value : null)
              : (typeof p?.value === 'number' ? p.value : null);
          lines.push(`<div style="margin-top:6px;"><span style="font-weight:600;">${seriesName}</span></div>`);
          lines.push(`<div><span style="opacity:0.75">${metricLabel}:</span> ${fmtPct(metricVal)}</div>`);
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
      },
    },
    yAxis: {
      type: 'value',
      min: paddedMin,
      max: paddedMax,
      axisLabel: {
        formatter: (v: number) => `${Math.round(v * 100)}%`,
        fontSize: yAxisLabelFontSizePx,
      },
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
  const primary = dims.find(d => d.role === 'primary');
  if (!primary || primary.id !== 'bridge_step') return null;

  const deltaMetric = metrics.find(m => m.id === 'delta');
  const totalMetric = metrics.find(m => m.id === 'total');
  if (!deltaMetric || !totalMetric) return null;

  const showToolbox = args.ui?.showToolbox ?? false;
  const widthPx = args.layout?.widthPx && Number.isFinite(args.layout.widthPx) ? args.layout.widthPx : 640;
  const axisLabelFontSizePx = args.ui?.axisLabelFontSizePx ?? 11;
  const axisLabelMaxLines = args.ui?.axisLabelMaxLines ?? 2;
  const axisLabelMaxCharsPerLine = args.ui?.axisLabelMaxCharsPerLine ?? 12;

  const stepMeta = result.dimension_values?.bridge_step || {};
  const rows = [...(result.data || [])];
  rows.sort((a: any, b: any) => {
    const oa = (stepMeta[String(a.bridge_step)] as any)?.order ?? 0;
    const ob = (stepMeta[String(b.bridge_step)] as any)?.order ?? 0;
    return oa - ob;
  });

  const labels = rows.map((r: any) => (stepMeta[String(r.bridge_step)] as any)?.name ?? String(r.bridge_step));
  const totals = rows.map((r: any) => (typeof r.total === 'number' ? r.total : null));
  const deltas = rows.map((r: any) => (typeof r.delta === 'number' ? r.delta : null));

  // Find start/end totals (if present) and build cumulative offsets for waterfall bars.
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

  const plotWidth = Math.max(240, widthPx - 40);
  const n = Math.max(1, labels.length);
  const perCategory = plotWidth / n;
  const barWidthPx = Math.round(Math.max(18, Math.min(72, perCategory * (n <= 8 ? 0.62 : 0.48))));

  const shorten = (s: string, max: number) => {
    const t = (s || '').trim();
    if (t.length <= max) return t;
    return `${t.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
  };

  const wrapLabel = (raw: string): string => {
    const s = String(raw ?? '').trim();
    if (!s) return '';
    const parts = s.split(/[\s/|]+/g).filter(Boolean);
    const lines: string[] = [];
    let current = '';
    const push = () => {
      if (current.trim()) lines.push(current.trim());
      current = '';
    };
    for (const p of parts) {
      // Hard-break very long tokens (e.g. IDs) so we still wrap.
      const token = p.length > axisLabelMaxCharsPerLine ? shorten(p, axisLabelMaxCharsPerLine) : p;
      const next = current ? `${current} ${token}` : token;
      if (next.length > axisLabelMaxCharsPerLine) {
        push();
        current = token;
      } else {
        current = next;
      }
      if (lines.length >= axisLabelMaxLines) break;
    }
    push();
    const out = lines.slice(0, axisLabelMaxLines).join('\n');
    return out || shorten(s, axisLabelMaxCharsPerLine);
  };

  // Bottom padding driven by line count/font size rather than raw label length.
  // Keep this tight to avoid wasting space under the chart (especially in tab view).
  const lineHeight = axisLabelFontSizePx + 2;
  const bottomPx = Math.min(92, Math.max(56, 16 + axisLabelMaxLines * lineHeight + 14));

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
      left: 8,
      right: 16,
      top: showToolbox ? 34 : 16,
      bottom: bottomPx,
      containLabel: true,
    },
    tooltip: {
      trigger: 'axis',
      axisPointer: { type: 'shadow' },
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
    xAxis: {
      type: 'category',
      data: labels,
      axisLabel: {
        // Bridge charts must not skip labels: each step matters.
        interval: 0,
        // Prefer wrap over rotation; rotate more as density increases.
        rotate:
          (widthPx / Math.max(1, labels.length)) < 56 ? 60
          : (widthPx / Math.max(1, labels.length)) < 76 ? 45
          : 0,
        formatter: (v: string) => wrapLabel(v),
        margin: 10,
        fontSize: axisLabelFontSizePx,
        lineHeight,
        // Do NOT hide overlapping labels for bridge charts; it makes the chart useless.
        hideOverlap: false,
        align: 'right',
      },
    },
    yAxis: {
      type: 'value',
      min: minV,
      max: maxV,
      splitNumber: 4,
      axisLabel: { formatter: (v: number) => `${Math.round(v * 100)}%`, fontSize: 10, margin: 10 },
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
          color: '#374151',
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
          color: '#374151',
        },
        labelLayout: { hideOverlap: true, moveOverlap: 'shiftY' },
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
          position: 'top',
          distance: 6,
          formatter: (p: any) => {
            const v = typeof p?.value === 'number' ? p.value : null;
            return typeof v === 'number' && Number.isFinite(v) ? fmtTotalPct(v) : '';
          },
          fontSize: 10,
          color: '#374151',
        },
        labelLayout: { hideOverlap: true, moveOverlap: 'shiftY' },
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
      },
    },
    yAxis: {
      type: 'value',
      min: minV,
      max: maxV,
      splitNumber: 4,
      axisLabel: { formatter: (v: number) => `${Math.round(v * 100)}%`, fontSize: 10, margin: 10 },
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
          color: '#374151',
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
          color: '#374151',
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
          color: '#374151',
        },
        labelLayout: { hideOverlap: true, moveOverlap: 'shiftY' },
        data: totalBars,
      },
    ],
  };
}


