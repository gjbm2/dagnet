/**
 * analysisECharts/snapshotBuilders.ts
 *
 * Snapshot chart builders: buildHistogramEChartsOption, buildDailyConversionsEChartsOption.
 *
 * Extracted from analysisEChartsService.ts — AEC-PR4.
 */

import {
  echartsThemeColours,
  echartsTooltipStyle,
} from './echartsCommon';

// ─── Builders ───────────────────────────────────────────────────────────────

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
    grid: { left: 52, right: 16, bottom: '3%', top: 40, containLabel: false },
    xAxis: {
      type: 'category',
      data: lagDays,
      name: 'Lag (days)',
      nameLocation: 'middle',
      nameGap: 30,
      nameTextStyle: { fontSize: 8, color: c.text },
      axisLabel: { fontSize: 9, color: c.text },
    },
    yAxis: [{
      type: yScale === 'log' ? 'log' : 'value',
      name: settings.y_axis_title ?? 'Conversions',
      nameLocation: 'middle',
      nameGap: 45,
      nameTextStyle: { fontSize: 8, color: c.text },
      min: settings.y_axis_min ?? undefined,
      max: settings.y_axis_max ?? undefined,
      axisLabel: {
        fontSize: 9,
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
        fontSize: settings.label_font_size ?? 7,
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
  extra?: { visibleScenarioIds?: string[]; scenarioVisibilityModes?: Record<string, string>; subjectId?: string },
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
    if (!key || !date) continue;

    // Respect visibility_mode: use evidence_y, forecast_y, or blended y
    const mode = multiScenario
      ? (scenarioMeta?.[key]?.visibility_mode ?? extra?.scenarioVisibilityModes?.[key] ?? 'f+e')
      : 'f+e';
    const rawX = Number(r?.x ?? 0);
    const rawY = Number(r?.y ?? 0);
    const evidenceY = r?.evidence_y != null ? Number(r.evidence_y) : null;
    const forecastY = r?.forecast_y != null ? Number(r.forecast_y) : null;

    let effectiveY: number;
    let effectiveX: number = rawX;
    if (mode === 'e' && evidenceY != null) {
      effectiveY = evidenceY;
    } else if (mode === 'f' && forecastY != null) {
      effectiveY = forecastY;
    } else {
      effectiveY = rawY;
    }

    // Skip rows with zero cohort size (no data for this date in this scenario's scope)
    if (effectiveX === 0 && effectiveY === 0) continue;

    const effectiveRate = effectiveX > 0 ? effectiveY / effectiveX : null;

    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key)!.push({
      date,
      rate: effectiveRate != null && Number.isFinite(effectiveRate) ? effectiveRate : null,
      x: Number.isFinite(effectiveX) ? effectiveX : 0,
      y: Number.isFinite(effectiveY) ? effectiveY : 0,
    });
  }

  const allSeries: any[] = [];
  const keys = Array.from(byKey.keys()).sort();
  const showSmooth = settings.smooth ?? false;
  const showMarkers = settings.show_markers;
  const seriesType = settings.series_type ?? 'bar';

  // Collect all dates across all scenarios so stacking aligns correctly
  const allDates = new Set<string>();
  for (const points of byKey.values()) {
    for (const p of points) allDates.add(p.date);
  }
  const sortedDates = Array.from(allDates).sort();

  for (let i = 0; i < keys.length; i++) {
    const key = keys[i];
    const points = (byKey.get(key) || []).slice().sort((a, b) => a.date.localeCompare(b.date));
    const pointsByDate = new Map(points.map(p => [p.date, p]));
    const name = meta?.[key]?.name || key;
    const strongColour = meta?.[key]?.colour || PALETTE[i % PALETTE.length];
    const lightColour = toBarFill(strongColour);

    // Align to common date set -- fill missing dates with 0 for correct stacking
    const alignedN = sortedDates.map(d => [d, pointsByDate.get(d)?.x ?? 0]);
    const alignedRate = sortedDates.map(d => [d, pointsByDate.get(d)?.rate ?? null]);

    allSeries.push({
      name: keys.length > 1 ? `${name} · N` : 'N',
      type: seriesType,
      yAxisIndex: 0,
      barMaxWidth: 24,
      itemStyle: { color: lightColour, borderRadius: [2, 2, 0, 0] },
      emphasis: { focus: 'series' },
      data: alignedN,
    });

    allSeries.push({
      name: keys.length > 1 ? `${name} · Rate` : 'Conversion %',
      type: 'line',
      yAxisIndex: 1,
      showSymbol: showMarkers ?? (sortedDates.length <= 20),
      symbolSize: settings.marker_size ?? 5,
      smooth: showSmooth,
      connectNulls: settings.missing_data === 'connect',
      lineStyle: { width: 2.5, color: strongColour },
      itemStyle: { color: strongColour },
      emphasis: { focus: 'series' },
      data: alignedRate,
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
    grid: { left: 52, right: 16, bottom: 60, top: allSeries.length > 2 ? 80 : 50, containLabel: false },
    xAxis: {
      type: 'time',
      name: settings.y_axis_title ?? 'Cohort date',
      nameLocation: 'middle',
      nameGap: 30,
      nameTextStyle: { fontSize: 8, color: c.text },
      axisLabel: {
        fontSize: 9,
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
        nameTextStyle: { fontSize: 8, color: c.text },
        min: settings.y_axis_min ?? 0,
        axisLabel: {
          fontSize: 9,
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
        nameTextStyle: { fontSize: 8, color: c.text },
        min: 0,
        max: settings.y_axis_max ?? rateMax,
        axisLabel: {
          fontSize: 9,
          color: c.text,
          formatter: (v: number) => `${(v * 100).toFixed(0)}%`,
        },
        splitLine: { show: false },
      },
    ],
    legend: showLegend ? { top: 22, left: 12, textStyle: { fontSize: 9, color: c.text }, icon: 'roundRect' } : { show: false },
    series: allSeries,
    ...(settings.animate === false ? { animation: false } : {}),
  };
}

