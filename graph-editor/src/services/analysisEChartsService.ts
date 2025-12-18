import type { AnalysisResult, DimensionValueMeta } from '../lib/graphComputeClient';

type ScenarioId = string;
type StageId = string;

export type FunnelChartOptionArgs = {
  /**
   * Which scenario to chart. For multi-scenario results we keep v1 simple:
   * render a single funnel series for the chosen scenario.
   */
  scenarioId: ScenarioId;
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
    toolbox: {
      show: true,
      right: 8,
      top: 8,
      feature: {
        saveAsImage: { show: true },
        restore: { show: true },
      },
    },
    series: [
      {
        name: seriesName,
        type: 'funnel',
        sort: 'none',
        left: '6%',
        right: '6%',
        top: 42,
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

  const metricLabel = args.metric === 'step_probability' ? 'Step probability' : 'Cum. probability';

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

  const scenarioIds = args.scenarioIds.filter(Boolean);
  const widthPx = args.layout?.widthPx && Number.isFinite(args.layout.widthPx) ? args.layout.widthPx : 560;
  const stageCount = stageLabels.length;
  const scenarioCount = scenarioIds.length;
  const dslByScenarioId = args.legend?.scenarioDslSubtitleById || {};

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
    const suggested = perCategory / Math.max(1, scenarioCount + 0.75);
    const barWidthPx = Math.round(Math.max(12, Math.min(scenarioCount === 1 ? 44 : 28, suggested)));

    return {
      name: seriesName,
      type: 'bar',
      barWidth: barWidthPx,
      itemStyle: colour ? { color: colour } : undefined,
      label: {
        show: showValueLabels,
        position: 'top',
        formatter: (p: any) => {
          const v = typeof p?.value === 'number' ? p.value : null;
          return typeof v === 'number' && Number.isFinite(v) ? fmtPct(v) : '';
        },
        fontSize: 10,
        color: '#374151',
      },
      labelLayout: showValueLabels ? { hideOverlap: true } : undefined,
      data: makeSeriesData(scenarioId),
    };
  });

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
    toolbox: {
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
    },
    brush: {
      toolbox: ['rect', 'polygon', 'clear'],
      xAxisIndex: 0,
    },
    // Leave ample space for legend/toolbox above the chart so the key doesn't overlap the plot.
    grid: {
      left: 8,
      right: 16,
      // Reserve enough space for:
      // - legend (2 lines per entry)
      // - toolbox row (below legend)
      top: scenarioIds.length > 1 ? 96 : 34,
      bottom: rotate ? 58 : 42,
      containLabel: true,
    },
    legend: scenarioIds.length > 1
      ? {
          top: 0,
          left: 8,
          right: 150, // reserve space for toolbox icons
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
          const seriesName = p?.seriesName ?? '';
          const metricVal = typeof p?.value === 'number' ? p.value : null;
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
      min: 0,
      max: 1,
      axisLabel: { formatter: (v: number) => `${Math.round(v * 100)}%` },
    },
    dataZoom: stageCount > 10
      ? [
          { type: 'inside', xAxisIndex: 0 },
        ]
      : undefined,
    series,
  };
}


