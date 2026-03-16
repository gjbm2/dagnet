/**
 * analysisECharts/bridgeBuilders.ts
 *
 * Bridge and funnel-bridge chart builders.
 *
 * Extracted from analysisEChartsService.ts — AEC-PR3.
 */

import type { AnalysisResult } from '../../lib/graphComputeClient';
import {
  echartsThemeColours,
  echartsTooltipStyle,
  wrapAxisLabel,
} from './echartsCommon';
import { extractFunnelSeriesPoints } from './funnelBuilders';

// ─── Types ──────────────────────────────────────────────────────────────────

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
  scenarioId: string;
  layout?: {
    widthPx?: number;
  };
  ui?: {
    showToolbox?: boolean;
  };
};

// ─── Builders ───────────────────────────────────────────────────────────────

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
  const axisLabelFontSizePx = args.ui?.axisLabelFontSizePx ?? 9;
  const axisLabelMaxLines = args.ui?.axisLabelMaxLines ?? 2;
  const axisLabelMaxCharsPerLine = args.ui?.axisLabelMaxCharsPerLine ?? 12;
  const axisLabelRotateDeg = args.ui?.axisLabelRotateDeg;
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
  const valueAxisLabelFontSizePx = Math.max(8, Math.min(10, Math.round(axisLabelFontSizePx * 0.92)));
  const valueLabelFontSizePx = Math.max(7, Math.min(9, Math.round(axisLabelFontSizePx * 0.8)));

  const plotWidth = Math.max(240, widthPx - 40);
  // Horizontal layout uses category axis on y, so bar thickness should be based on available height,
  // not width. Otherwise wide tabs produce absurdly thick bars.
  const plotHeight = Math.max(200, heightPx - (showToolbox ? 56 : 42));
  const n = Math.max(1, labels.length);
  const perCategory = (orientation === 'horizontal' ? plotHeight : plotWidth) / n;
  const defaultBarWidth = '55%';
  // Hide value labels when bars are too dense — they overlap and become illegible.
  // Vertical: labels sit above/below bars, competing horizontally (~50px needed per bar).
  // Horizontal: labels sit to the right, competing vertically (~18px needed per bar).
  const showValueLabels = orientation === 'horizontal' ? perCategory >= 18 : perCategory >= 50;

  const wrapLabel = (raw: string) => wrapAxisLabel(raw, axisLabelMaxCharsPerLine, axisLabelMaxLines);

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
    legend: {
      show: true,
      data: ['Increase', 'Decrease', 'Total'],
      top: 0,
      left: 'center',
      textStyle: { color: echartsThemeColours().text, fontSize: 10 },
      itemWidth: 12,
      itemHeight: 10,
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
    grid: {
      // Do NOT guess label extents (it creates systematic dead space). Instead keep a small
      // margin and let `containLabel` reserve what's actually needed.
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
        barWidth: defaultBarWidth,
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
        barWidth: defaultBarWidth,
        label: {
          show: showValueLabels,
          position: orientation === 'horizontal' ? 'right' : 'top',
          distance: 6,
          formatter: (p: any) => {
            if (!showValueLabels) return '';
            const v = typeof p?.value === 'number' ? p.value : null;
            return typeof v === 'number' && Number.isFinite(v) ? `+${fmtDeltaPct(v)}` : '';
          },
          fontSize: valueLabelFontSizePx,
          color: echartsThemeColours().text,
        },
        labelLayout: showValueLabels ? { hideOverlap: true } : undefined,
        data: inc,
      },
      {
        name: 'Decrease',
        type: 'bar',
        stack: 'waterfall',
        itemStyle: { color: '#ef4444' },
        barWidth: defaultBarWidth,
        label: {
          show: showValueLabels,
          position: orientation === 'horizontal' ? 'right' : 'bottom',
          distance: 6,
          formatter: (p: any) => {
            if (!showValueLabels) return '';
            const v = typeof p?.value === 'number' ? p.value : null;
            return typeof v === 'number' && Number.isFinite(v) ? `-${fmtDeltaPct(v)}` : '';
          },
          fontSize: valueLabelFontSizePx,
          color: echartsThemeColours().text,
        },
        labelLayout: showValueLabels ? { hideOverlap: true } : undefined,
        data: dec,
      },
      {
        name: 'Total',
        type: 'bar',
        itemStyle: { color: '#3b82f6' },
        barWidth: defaultBarWidth,
        barGap: '-100%',
        label: {
          show: showValueLabels,
          position: orientation === 'horizontal' ? 'right' : 'top',
          distance: 6,
          formatter: (p: any) => {
            if (!showValueLabels) return '';
            const v = typeof p?.value === 'number' ? p.value : null;
            return typeof v === 'number' && Number.isFinite(v) ? fmtTotalPct(v) : '';
          },
          fontSize: valueLabelFontSizePx,
          color: echartsThemeColours().text,
        },
        labelLayout: showValueLabels ? { hideOverlap: true } : undefined,
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

  const defaultBarWidth = '55%';

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
    legend: {
      show: true,
      data: ['Increase', 'Decrease', 'Total'],
      top: 0,
      left: 'center',
      textStyle: { color: echartsThemeColours().text, fontSize: 10 },
      itemWidth: 12,
      itemHeight: 10,
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
        fontSize: 9,
        color: echartsThemeColours().text,
      },
      axisLine: { lineStyle: { color: echartsThemeColours().border } },
    },
    yAxis: {
      type: 'value',
      min: minV,
      max: maxV,
      splitNumber: 4,
      axisLabel: { formatter: (v: number) => `${Math.round(v * 100)}%`, fontSize: 9, margin: 10, color: echartsThemeColours().text },
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
        barWidth: defaultBarWidth,
        data: assist,
      },
      {
        name: 'Increase',
        type: 'bar',
        stack: 'waterfall',
        itemStyle: { color: '#10b981' },
        barWidth: defaultBarWidth,
        label: {
          show: true,
          position: 'top',
          distance: 6,
          formatter: (p: any) => {
            const v = typeof p?.value === 'number' ? p.value : null;
            return typeof v === 'number' && Number.isFinite(v) ? `+${fmtDeltaPct(v)}` : '';
          },
          fontSize: 7,
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
        barWidth: defaultBarWidth,
        label: {
          show: true,
          position: 'bottom',
          distance: 6,
          formatter: (p: any) => {
            const v = typeof p?.value === 'number' ? p.value : null;
            return typeof v === 'number' && Number.isFinite(v) ? `-${fmtDeltaPct(v)}` : '';
          },
          fontSize: 7,
          color: echartsThemeColours().text,
        },
        labelLayout: { hideOverlap: true, moveOverlap: 'shiftY' },
        data: dec,
      },
      {
        name: 'Total',
        type: 'bar',
        itemStyle: { color: scenarioColour ? scenarioColour : '#3b82f6' },
        barWidth: defaultBarWidth,
        barGap: '-100%',
        label: {
          show: true,
          position: 'top',
          distance: 6,
          formatter: (p: any) => {
            const v = typeof p?.value === 'number' ? p.value : null;
            return typeof v === 'number' && Number.isFinite(v) ? fmtTotalPct(v) : '';
          },
          fontSize: 7,
          color: echartsThemeColours().text,
        },
        labelLayout: { hideOverlap: true, moveOverlap: 'shiftY' },
        data: totalBars,
      },
    ],
  };
}

