/**
 * analysisEChartsService.ts — Facade
 *
 * Public entrypoint for all ECharts chart building.
 * Builder implementations live in ./analysisECharts/*.ts.
 * This file re-exports them and houses the top-level dispatcher (buildChartOption).
 */

// ─── Local imports (used by buildChartOption below) ─────────────────────────

import { applyCommonSettings, echartsThemeColours } from './analysisECharts/echartsCommon';
import { buildFunnelBarEChartsOption } from './analysisECharts/funnelBuilders';
import { buildBridgeEChartsOption } from './analysisECharts/bridgeBuilders';
import { buildHistogramEChartsOption, buildDailyConversionsEChartsOption, buildConversionRateEChartsOption } from './analysisECharts/snapshotBuilders';
import {
  buildCohortMaturityEChartsOption,
  buildLagFitEChartsOption,
  buildComparisonBarEChartsOption,
  buildComparisonPieEChartsOption,
  buildComparisonTimeSeriesEChartsOption,
} from './analysisECharts/cohortComparisonBuilders';
import { buildSurpriseGaugeEChartsOption } from './analysisECharts/surpriseGaugeBuilder';

// ─── Re-exports (public API) ────────────────────────────────────────────────

export {
  extractFunnelSeriesPoints,
  buildFunnelEChartsOption,
  buildFunnelBarEChartsOption,
} from './analysisECharts/funnelBuilders';
export type {
  FunnelChartOptionArgs,
  FunnelBarMetric,
  FunnelBarChartOptionArgs,
  FunnelSeriesPoint,
} from './analysisECharts/funnelBuilders';

export {
  buildBridgeEChartsOption,
  buildFunnelBridgeEChartsOption,
} from './analysisECharts/bridgeBuilders';
export type {
  BridgeChartOptionArgs,
  FunnelBridgeChartOptionArgs,
} from './analysisECharts/bridgeBuilders';

export {
  buildHistogramEChartsOption,
  buildDailyConversionsEChartsOption,
  buildConversionRateEChartsOption,
} from './analysisECharts/snapshotBuilders';

export {
  buildCohortMaturityEChartsOption,
} from './analysisECharts/cohortComparisonBuilders';

function projectSurpriseGaugeResultForDisplay(
  result: any,
  settings: Record<string, any>,
  visibleScenarioIds?: string[],
): any {
  const scenarioResults: any[] = Array.isArray(result?.scenario_results) && result.scenario_results.length > 0
    ? result.scenario_results
    : (Array.isArray(result?.variables) && result.variables.length > 0
      ? [{
          scenario_id: result?.focused_scenario_id || 'current',
          variables: result.variables,
          hint: result?.hint,
        }]
      : []);
  if (scenarioResults.length === 0) return result;

  const orderedScenarioResults = (() => {
    if (!visibleScenarioIds || visibleScenarioIds.length === 0) return scenarioResults;
    const byId = new Map(
      scenarioResults.map((scenarioResult) => [String(scenarioResult.scenario_id), scenarioResult]),
    );
    const ordered = visibleScenarioIds
      .map((scenarioId) => byId.get(String(scenarioId)))
      .filter(Boolean) as any[];
    const seen = new Set(ordered.map((scenarioResult) => String(scenarioResult.scenario_id)));
    for (const scenarioResult of scenarioResults) {
      const scenarioId = String(scenarioResult.scenario_id);
      if (!seen.has(scenarioId)) ordered.push(scenarioResult);
    }
    return ordered;
  })();

  const selectedVar = settings.surprise_var || 'p';
  const scenarioScope = settings.surprise_scenario_scope || 'focused';
  const selectedScenarioResults = scenarioScope === 'all_visible'
    ? orderedScenarioResults
    : [orderedScenarioResults[orderedScenarioResults.length - 1]];
  const selectedHints = Array.from(new Set(
    selectedScenarioResults
      .map((scenarioResult) => scenarioResult?.hint)
      .filter((hint): hint is string => typeof hint === 'string' && hint.length > 0),
  ));

  const variables = selectedVar === 'all'
    ? selectedScenarioResults.flatMap((scenarioResult) => {
        const scenarioName = result?.dimension_values?.scenario_id?.[String(scenarioResult.scenario_id)]?.name
          || scenarioResult.scenario_id;
        return (scenarioResult.variables || [])
          .filter((variable: any) => variable.available)
          .map((variable: any) => ({
            ...variable,
            label: scenarioScope === 'all_visible'
              ? `${scenarioName} — ${variable.label}`
              : variable.label,
          }));
      })
    : selectedScenarioResults.flatMap((scenarioResult) => {
        const scenarioName = result?.dimension_values?.scenario_id?.[String(scenarioResult.scenario_id)]?.name
          || scenarioResult.scenario_id;
        const variable = (scenarioResult.variables || []).find((candidate: any) => (
          candidate.available && candidate.name === selectedVar
        ));
        if (variable) {
          return [{
            ...variable,
            label: scenarioScope === 'all_visible' ? scenarioName : variable.label,
          }];
        }
        if (scenarioScope !== 'all_visible') {
          return (scenarioResult.variables || []).filter((candidate: any) => candidate.available);
        }
        return [];
      });

  return {
    ...result,
    focused_scenario_id: selectedScenarioResults[selectedScenarioResults.length - 1]?.scenario_id || result?.focused_scenario_id,
    variables,
    hint: selectedHints.length === 1 ? selectedHints[0] : undefined,
  };
}

// ─── Dispatcher ─────────────────────────────────────────────────────────────

export function buildChartOption(
  chartKind: string,
  result: any,
  resolvedSettings: Record<string, any> = {},
  extra?: {
    visibleScenarioIds?: string[];
    scenarioVisibilityModes?: Record<string, 'f+e' | 'f' | 'e'>;
    scenarioDslSubtitleById?: Record<string, string>;
    subjectId?: string;
    layout?: {
      widthPx?: number;
      heightPx?: number;
    };
  },
): any | null {
  let opt: any | null;

  switch (chartKind) {
    case 'time_series':
      opt = buildComparisonTimeSeriesEChartsOption(result, resolvedSettings, {
        scenarioIds: extra?.visibleScenarioIds,
        layout: extra?.layout,
        ui: { showToolbox: false },
      });
      break;

    case 'bar_grouped':
      opt = buildComparisonBarEChartsOption(result, resolvedSettings, {
        scenarioIds: extra?.visibleScenarioIds,
        layout: extra?.layout,
        ui: { showToolbox: false },
      });
      break;

    case 'pie':
      opt = buildComparisonPieEChartsOption(result, resolvedSettings, {
        scenarioIds: extra?.visibleScenarioIds,
        layout: extra?.layout,
        ui: { showToolbox: false },
      });
      break;

    case 'histogram':
      opt = buildHistogramEChartsOption(result, resolvedSettings);
      break;

    case 'funnel':
      opt = buildFunnelBarEChartsOption(result, {
        scenarioIds: extra?.visibleScenarioIds || ['current'],
        metric: resolvedSettings.metric || 'cumulative_probability',
        legend: { scenarioDslSubtitleById: extra?.scenarioDslSubtitleById },
        ui: { showToolbox: false },
        settings: resolvedSettings,
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
      opt = buildBridgeEChartsOption(result, {
        layout: {
          widthPx: extra?.layout?.widthPx,
          heightPx: extra?.layout?.heightPx,
        },
        ui: {
          showToolbox: false,
          orientation: resolvedSettings.orientation || 'vertical',
          showRunningTotalLine: resolvedSettings.show_running_total ?? true,
        },
      });
      break;

    case 'daily_conversions':
      opt = buildDailyConversionsEChartsOption(result, resolvedSettings, {
        visibleScenarioIds: extra?.visibleScenarioIds,
        scenarioVisibilityModes: extra?.scenarioVisibilityModes,
        subjectId: extra?.subjectId,
      });
      break;

    case 'conversion_rate':
      opt = buildConversionRateEChartsOption(result, resolvedSettings, {
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

    case 'lag_fit':
      opt = buildLagFitEChartsOption(result, resolvedSettings);
      break;

    case 'surprise_gauge':
      {
        const projectedResult = projectSurpriseGaugeResultForDisplay(
          result,
          resolvedSettings,
          extra?.visibleScenarioIds,
        );
        const projectedSettings = resolvedSettings.surprise_scenario_scope === 'all_visible'
          && (resolvedSettings.surprise_var || 'p') !== 'all'
          ? { ...resolvedSettings, surprise_var: 'all' }
          : resolvedSettings;
        opt = buildSurpriseGaugeEChartsOption(projectedResult, projectedSettings);
      }
      break;

    default:
      if (import.meta.env.DEV) {
        console.warn(`[buildChartOption] Unsupported chartKind: "${chartKind}"`, {
          analysisType: result?.analysis_type,
          hasData: Array.isArray(result?.data) && result.data.length > 0,
          dataLength: result?.data?.length,
        });
      }
      return null;
  }

  if (!opt) {
    if (import.meta.env.DEV) {
      console.warn(`[buildChartOption] Builder returned null for chartKind="${chartKind}"`, {
        analysisType: result?.analysis_type,
        hasData: Array.isArray(result?.data) && result.data.length > 0,
        dataLength: result?.data?.length,
        scenarioCount: result?.data ? new Set(result.data.map((r: any) => r?.scenario_id)).size : 0,
        source: result?.metadata?.source,
      });
    }
    return null;
  }

  // ── Model source hint (generalised — doc 29f §Phase G) ──────────────
  // When the promoted model source is not Bayesian, show a subtle hint
  // so the user knows the forecast quality could be improved. Applied to
  // all chart types that use model-derived values. The surprise gauge
  // builder has its own hint rendering (from result.hint); this covers
  // all other chart types via promoted_source on the result metadata.
  if (opt && chartKind !== 'surprise_gauge') {
    const promotedSource = result?.promoted_source
      || result?.metadata?.promoted_source
      || result?.reference_source;
    if (promotedSource && promotedSource !== 'bayesian' && promotedSource !== 'best_available') {
      const hint = 'Run Bayes model for better forecasts';
      const c = echartsThemeColours();
      const hintColour = c.text === '#e0e0e0' ? '#6b7280' : '#9ca3af';
      const graphics: any[] = Array.isArray(opt.graphic) ? [...opt.graphic] : [];
      graphics.push(
        {
          type: 'text',
          right: 6,
          top: 4,
          style: { text: '\u26A0', fontSize: 14, fill: '#f59e0b' },
          silent: true,
          z: 100,
        },
        {
          type: 'text',
          right: 8,
          bottom: 4,
          style: { text: hint, fontSize: 9, fill: hintColour, fontStyle: 'italic' },
          silent: true,
        },
      );
      opt.graphic = graphics;
    }
  }

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
  if (stackMode && stackMode !== 'grouped' && !(opt as any).__dagnet_skip_stack_mode) {
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
            label: { show: true, formatter: `−${dropoff}%`, fontSize: 7, color: '#ef4444' },
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
  if (chartKind === 'bridge' && resolvedSettings.show_connectors === false) {
    for (const s of (opt.series || [])) {
      if (s.markLine) s.markLine = undefined;
    }
  }

  // ── Bar width + gap overrides ──
  // IMPORTANT:
  // Some builders (notably funnel) compute their own bar geometry based on the
  // number of scenarios and categories. Do NOT stomp those defaults unless the
  // user explicitly set an override via the registry-backed display settings.
  if (resolvedSettings.bar_width != null) {
    const barWidth = resolvedSettings.bar_width;
    const barWidthMap: Record<string, { pct: string; min: number; max: number }> = {
      thin:   { pct: '30%',  min: 4,  max: 28  },
      medium: { pct: '55%',  min: 8,  max: 72  },
      wide:   { pct: '75%',  min: 12, max: 120 },
      full:   { pct: '92%',  min: 16, max: 200 },
    };
    const barWidthPreset = barWidthMap[barWidth] || barWidthMap.medium;
    for (const s of (opt.series || [])) {
      if (s.type === 'bar') {
        s.barWidth = barWidthPreset.pct;
        s.barMaxWidth = barWidthPreset.max;
        s.barMinWidth = barWidthPreset.min;
      }
    }
  }

  if (resolvedSettings.bar_gap != null) {
    const barGap = resolvedSettings.bar_gap;
    const barGapMap: Record<string, string> = { none: '0%', small: '15%', medium: '30%', large: '50%' };
    const barGapPct = barGapMap[barGap] ?? '15%';
    for (const s of (opt.series || [])) {
      if (s.type === 'bar') s.barCategoryGap = barGapPct;
    }
  }

  // ── Reference lines (ECharts markLine on first relevant series) ──
  const refLines = resolvedSettings.reference_lines;
  if (Array.isArray(refLines) && refLines.length > 0) {
    const target = opt.series?.find((s: any) => s.type === 'bar' || s.type === 'line');
    if (target) {
      const mlData = refLines.map((rl: any) => ({
        yAxis: rl.value,
        label: { formatter: rl.label || '', position: 'end', fontSize: 9 },
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

  if ((opt as any).__dagnet_skip_stack_mode) {
    delete (opt as any).__dagnet_skip_stack_mode;
  }

  return applyCommonSettings(opt, resolvedSettings);
}

