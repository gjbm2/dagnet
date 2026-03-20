/**
 * analysisECharts/cohortComparisonBuilders.ts
 *
 * Cohort maturity and comparison chart builders.
 *
 * Extracted from analysisEChartsService.ts — AEC-PR5.
 */

import type { AnalysisResult } from '../../lib/graphComputeClient';
import {
  echartsThemeColours,
  echartsTooltipStyle,
  getDimLabel,
  getDimOrder,
  wrapAxisLabel,
  getScenarioTitleWithBasis,
} from './echartsCommon';

// ─── Builders ───────────────────────────────────────────────────────────────

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
    // Bayesian confidence band (filled polygon between upper and lower curves).
    // Uses a custom series that draws a closed polygon via renderItem.
    // api.coord() requires coordinateSystem + encode to map data → pixels.
    const bandUpper = entry?.bayesBandUpper;
    const bandLower = entry?.bayesBandLower;
    if (Array.isArray(bandUpper) && bandUpper.length > 0 && Array.isArray(bandLower) && bandLower.length > 0) {
      const bandColour = c.text === '#e0e0e0' ? 'rgba(96,165,250,0.18)' : 'rgba(37,99,235,0.15)';
      const upperPts = bandUpper
        .filter((p: any) => typeof p?.tau_days === 'number' && typeof p?.model_rate === 'number');
      const lowerPts = bandLower
        .filter((p: any) => typeof p?.tau_days === 'number' && typeof p?.model_rate === 'number');
      if (upperPts.length > 0 && lowerPts.length > 0) {
        // Each data item: [tau, upper_rate, lower_rate]
        const polyData = upperPts.map((p: any, i: number) => {
          const lower = i < lowerPts.length ? lowerPts[i].model_rate : p.model_rate;
          return [p.tau_days, p.model_rate, lower];
        });
        const fill = bandColour;
        seriesOut.push({
          id: 'bayes_band',
          name: `Bayes ${settings.bayes_band_level || '90'}% band`,
          type: 'custom' as any,
          coordinateSystem: 'cartesian2d',
          encode: { x: 0, y: 1 },
          renderItem: (params: any, api: any) => {
            // Draw the full polygon on the first data point only.
            // api.value() only reads the CURRENT dataIndex, so we use the
            // closure-captured polyData directly and convert via api.coord().
            if (params.dataIndex !== 0) return;
            const points: number[][] = [];
            // Upper curve left → right
            for (let i = 0; i < polyData.length; i++) {
              points.push(api.coord([polyData[i][0], polyData[i][1]]));
            }
            // Lower curve right → left
            for (let i = polyData.length - 1; i >= 0; i--) {
              points.push(api.coord([polyData[i][0], polyData[i][2]]));
            }
            return {
              type: 'polygon',
              shape: { points, smooth: 0.3 },
              style: { fill, stroke: 'none' },
              silent: true,
            };
          },
          data: polyData,
          z: 9,
          silent: true,
        });
      }
    }
    // Bayesian posterior overlay (dashed, distinct colour)
    if (entry?.bayesCurve && Array.isArray(entry.bayesCurve) && entry.bayesCurve.length > 0) {
      const bayesData = entry.bayesCurve
        .filter((p: any) => typeof p?.tau_days === 'number' && typeof p?.model_rate === 'number')
        .map((p: any) => ({ value: [p.tau_days, p.model_rate] }));
      if (bayesData.length > 0) {
        const bayesColour = c.text === '#e0e0e0' ? '#60a5fa' : '#2563eb';
        seriesOut.push({
          id: 'model_cdf_bayes',
          name: 'Bayesian Model',
          type: 'line',
          showSymbol: false,
          smooth: true,
          connectNulls: false,
          lineStyle: { width: 2, color: bayesColour, type: 'dashed', opacity: 0.85 },
          itemStyle: { color: bayesColour },
          emphasis: { disabled: true },
          z: 11,
          data: bayesData,
        });
        if (maxTau !== null) {
          const curveMax = bayesData[bayesData.length - 1]?.value?.[0];
          if (typeof curveMax === 'number' && Number.isFinite(curveMax) && curveMax > maxTau) {
            maxTau = curveMax;
          }
        }
      }
    }
  }

  // Y-axis max from data with headroom.
  // For stacked band series, the visual max is lower + delta — account for
  // that by checking the raw upper band data (pre-delta) if present.
  let maxRate = 0;
  for (const s of seriesOut) {
    if (s.id === 'bayes_band') continue; // handled below via raw upper data
    for (const d of (s.data || [])) {
      const v = d?.value?.[1];
      if (typeof v === 'number' && Number.isFinite(v) && v > maxRate) maxRate = v;
    }
  }
  // Include the actual Bayes band upper envelope (not the delta) in yMax.
  if (modelCurves && typeof modelCurves === 'object') {
    const bandEntry = modelCurves[effectiveSubjectId];
    const rawUpper = bandEntry?.bayesBandUpper;
    if (Array.isArray(rawUpper)) {
      for (const p of rawUpper) {
        const v = p?.model_rate;
        if (typeof v === 'number' && Number.isFinite(v) && v > maxRate) maxRate = v;
      }
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

        const excludeIds = new Set(['model_cdf', 'bayes_band']);
        const scenarioItems = items.filter((it: any) => !excludeIds.has(it?.seriesId));
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
    grid: { left: 52, right: 16, bottom: 60, top: seriesOut.length > 2 ? 80 : 50, containLabel: false },
    xAxis: {
      type: 'value',
      name: settings.x_axis_title ?? 'Age (days since cohort date)',
      nameLocation: 'middle',
      nameGap: 30,
      nameTextStyle: { fontSize: 8, color: c.text },
      min: settings.x_axis_min ?? 0,
      ...(maxTau !== null && Number.isFinite(maxTau) ? { max: settings.x_axis_max ?? maxTau } : {}),
      axisLabel: { fontSize: 9, color: c.text, formatter: (v: number) => `${Math.round(v)}` },
    },
    yAxis: {
      type: (settings.y_axis_scale === 'log') ? 'log' : 'value',
      min: settings.y_axis_min ?? 0,
      max: yMax,
      name: settings.y_axis_title ?? 'Conversion rate',
      nameLocation: 'middle',
      nameGap: 45,
      nameTextStyle: { fontSize: 8, color: c.text },
      axisLabel: { fontSize: 9, color: c.text, formatter: (v: number) => `${(v * 100).toFixed(0)}%` },
      splitLine: { lineStyle: { color: c.gridLine } },
    },
    legend: showLegend ? { top: 22, left: 12, textStyle: { fontSize: 9, color: c.text }, icon: 'roundRect' } : { show: false },
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

type ChartKindId = 'funnel' | 'bridge' | 'histogram' | 'daily_conversions' | 'cohort_maturity';

/**
 * Build ECharts options for any chart kind from a unified interface.
 *
 * This is the single codepath: AnalysisChartContainer calls this with
 * (chartKind, result, resolvedSettings) and gets back an ECharts option object.
 *
 * Settings come from the display settings registry (resolveDisplaySetting).
 * The dispatch translates resolvedSettings to per-builder args internally.
 */
/**
 * Build ECharts option for lag_fit analysis.
 *
 * Dual-axis chart:
 *   Left y-axis  — cumulative fraction (fitted CDF + observed cohort scatter)
 *   Right y-axis — daily probability mass (PMF bars)
 *   x-axis       — lag in days
 *   markLines    — median and t95
 */
export function buildLagFitEChartsOption(
  result: AnalysisResult,
  _settings: Record<string, any>,
): any {
  const c = echartsThemeColours();
  const rows: any[] = result.data ?? [];
  const meta = rows.find(r => r.row_type === 'meta');
  const curveRows = rows.filter(r => r.row_type === 'curve');
  const cohortRows = rows.filter(r => r.row_type === 'cohort');

  if (!meta || curveRows.length === 0) return null;

  const { t95, median, edge_label } = meta;
  const CDF_COLOUR = c.text;
  const SCATTER_COLOUR = '#3b82f6';
  const BAR_COLOUR = c.textMuted;

  const tValues = curveRows.map((r: any) => r.t as number);
  const pdfValues = curveRows.map((r: any) => r.pdf as number);
  const cdfValues = curveRows.map((r: any) => r.cdf as number);

  const scatterData = cohortRows.map((r: any) => ({
    value: [r.age as number, r.observed_cdf as number],
    n: r.n, k: r.k, date: r.date,
  }));

  const markLines: any[] = [];
  if (Number.isFinite(median) && median > 0) {
    markLines.push({
      xAxis: Math.round(median),
      lineStyle: { color: c.textSecondary, type: 'dashed', width: 1, opacity: 0.7 },
      label: { show: true, formatter: `med ${Number(median).toFixed(1)}d`, color: c.textSecondary, fontSize: 9, position: 'start' },
    });
  }
  if (Number.isFinite(t95) && t95 > 0) {
    markLines.push({
      xAxis: Math.round(t95),
      lineStyle: { color: c.textMuted, type: 'dashed', width: 1, opacity: 0.6 },
      label: { show: true, formatter: `t95 ${Number(t95).toFixed(1)}d`, color: c.textMuted, fontSize: 9, position: 'end' },
    });
  }

  const fmtPct = (v: number) => (v * 100).toFixed(1) + '%';

  return {
    backgroundColor: 'transparent',
    grid: { top: 32, right: 60, bottom: 60, left: 52, containLabel: false },
    xAxis: {
      type: 'value', name: 'Lag (days)',
      nameTextStyle: { color: c.text, fontSize: 8 },
      min: 0, max: tValues[tValues.length - 1] ?? 100,
      axisLabel: { color: c.text, fontSize: 9 },
      axisLine: { lineStyle: { color: c.gridLine } },
      splitLine: { lineStyle: { color: c.gridLine } },
    },
    yAxis: [
      {
        type: 'value', name: 'Cumulative fraction',
        nameTextStyle: { color: c.text, fontSize: 8 },
        min: 0, max: 1,
        axisLabel: { color: c.text, fontSize: 9, formatter: fmtPct },
        axisLine: { show: false },
        splitLine: { lineStyle: { color: c.gridLine } },
      },
      {
        type: 'value', name: 'Daily PDF',
        nameTextStyle: { color: BAR_COLOUR, fontSize: 8 },
        position: 'right',
        axisLabel: { color: BAR_COLOUR, fontSize: 9, formatter: (v: number) => v.toFixed(3) },
        axisLine: { show: false },
        splitLine: { show: false },
      },
    ],
    tooltip: {
      trigger: 'axis', axisPointer: { type: 'line' },
      ...echartsTooltipStyle(),
      formatter: (params: any[]) => {
        if (!params?.length) return '';
        const t = params[0]?.axisValue ?? '';
        let html = `<div style="font-weight:600;margin-bottom:4px">Day ${t}</div>`;
        for (const p of params) {
          if (p.value === null || p.value === undefined) continue;
          const val = Array.isArray(p.value) ? p.value[1] : p.value;
          const dot = `<span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${p.color};margin-right:5px;vertical-align:middle"></span>`;
          const formatted = p.seriesName === 'PDF (daily)' ? Number(val).toFixed(2) : fmtPct(Number(val));
          html += `<div>${dot}${p.seriesName}: <b>${formatted}</b></div>`;
        }
        return html;
      },
    },
    legend: {
      bottom: 0,
      textStyle: { color: c.text, fontSize: 9 },
      data: ['PDF (daily)', 'Fitted CDF', 'Observed completeness'],
    },
    series: [
      {
        name: 'PDF (daily)', type: 'bar', yAxisIndex: 1,
        data: tValues.map((t, i) => [t, pdfValues[i]]),
        barWidth: '80%',
        itemStyle: { color: BAR_COLOUR, opacity: 0.6 },
        emphasis: { itemStyle: { opacity: 1 } },
        markLine: markLines.length ? { silent: true, symbol: 'none', data: markLines } : undefined,
      },
      {
        name: 'Fitted CDF', type: 'line', yAxisIndex: 0,
        data: tValues.map((t, i) => [t, cdfValues[i]]),
        showSymbol: false, smooth: false,
        lineStyle: { color: CDF_COLOUR, width: 2.5 },
        itemStyle: { color: CDF_COLOUR },
      },
      {
        name: 'Observed completeness', type: 'scatter', yAxisIndex: 0,
        data: scatterData,
        symbolSize: 7,
        itemStyle: { color: SCATTER_COLOUR, opacity: 0.85 },
        emphasis: { itemStyle: { opacity: 1 } },
        tooltip: {
          formatter: (p: any) => {
            const [age, obs] = p.value;
            return [`<b>Age ${age} days</b>`, `Observed: ${fmtPct(obs)}`, `n=${p.data.n}, k=${p.data.k}`, p.data.date].join('<br/>');
          },
        },
      },
    ],
  };
}

type ComparisonChartOptionArgs = {
  scenarioIds?: string[];
  layout?: {
    widthPx?: number;
    heightPx?: number;
  };
  ui?: {
    showToolbox?: boolean;
  };
};

function buildComparisonChartState(
  result: AnalysisResult,
  settings: Record<string, any> = {},
  args: ComparisonChartOptionArgs = {},
) {
  const dims = result.semantics?.dimensions || [];
  const metrics = result.semantics?.metrics || [];
  const primaryDim = dims.find(d => d.id !== 'scenario_id' && d.role === 'primary') || dims.find(d => d.id !== 'scenario_id');
  const scenarioDim = dims.find(d => d.id === 'scenario_id' || d.type === 'scenario');
  if (!primaryDim) return null;

  const primaryMetricId = metrics.find(m => m.role === 'primary')?.id || metrics[0]?.id;
  if (!primaryMetricId) return null;

  const rows = Array.isArray(result.data) ? result.data : [];
  const scenarioIdField = scenarioDim?.id || 'scenario_id';
  const allScenarioIds = Array.from(new Set(rows
    .map(r => (r?.[scenarioIdField] != null ? String(r[scenarioIdField]) : ''))
    .filter(Boolean)));
  const scenarioIds = (args.scenarioIds && args.scenarioIds.length ? args.scenarioIds : allScenarioIds).filter(Boolean);

  const primaryIdField = primaryDim.id;
  const primaryIds = Array.from(new Set(rows
    .map(r => (r?.[primaryIdField] != null ? String(r[primaryIdField]) : ''))
    .filter(Boolean)))
    .sort((a, b) => getDimOrder(result.dimension_values, primaryIdField, a) - getDimOrder(result.dimension_values, primaryIdField, b));

  const byPrimaryAndScenario = new Map<string, any>();
  for (const row of rows) {
    const pid = row?.[primaryIdField];
    const sid = row?.[scenarioIdField];
    if (pid == null) continue;
    const key = `${String(pid)}::${sid == null ? '' : String(sid)}`;
    byPrimaryAndScenario.set(key, row);
  }

  const hasEvidenceMean = metrics.some(m => m.id === 'evidence_mean');
  const hasForecastMean = metrics.some(m => m.id === 'forecast_mean');
  const hasEvidenceK = metrics.some(m => m.id === 'evidence_k');
  const hasForecastK = metrics.some(m => m.id === 'forecast_k');
  const metricModeAbsolute = settings.metric_mode === 'absolute';
  const allFERendered = scenarioIds.length > 0
    && scenarioIds.every(sid => ((result.dimension_values?.scenario_id?.[sid] as any)?.visibility_mode || 'f+e') === 'f+e');
  const shouldShowFESplit = allFERendered && (
    (metricModeAbsolute && hasEvidenceK && hasForecastK)
    || (!metricModeAbsolute && hasEvidenceMean && hasForecastMean)
  );

  const comparisonColours = ['#3b82f6', '#10b981', '#f59e0b', '#ec4899', '#8b5cf6', '#14b8a6', '#ef4444', '#6366f1'];
  const colourForPrimary = (primaryId: string, idx: number) =>
    result.dimension_values?.[primaryIdField]?.[primaryId]?.colour || comparisonColours[idx % comparisonColours.length];
  const hexToRgba = (hex: string, alpha: number): string => {
    const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
    if (!m) return hex;
    const r = parseInt(m[1], 16);
    const g = parseInt(m[2], 16);
    const b = parseInt(m[3], 16);
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
  };
  const forecastDecal = { symbol: 'rect', dashArrayX: [1, 0], dashArrayY: [3, 3], rotation: -Math.PI / 4 } as any;
  const num = (v: any): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  const fmtValue = (v: number | null) => {
    if (typeof v !== 'number' || !Number.isFinite(v)) return '—';
    if (metricModeAbsolute) return Math.round(v).toLocaleString();
    return `${(v * 100).toFixed(1)}%`;
  };
  const getRow = (primaryId: string, scenarioId?: string) =>
    byPrimaryAndScenario.get(`${primaryId}::${scenarioId || ''}`) || null;
  const getTotalValue = (row: any): number | null => {
    if (!row) return null;
    if (metricModeAbsolute) {
      const visibilityMode = row?.visibility_mode || 'f+e';
      if (visibilityMode === 'f') return num(row?.forecast_k);
      if (visibilityMode === 'e') return num(row?.evidence_k);
      return num(row?.forecast_k) ?? num(row?.evidence_k);
    }
    return num(row?.[primaryMetricId]);
  };
  const getEvidenceValue = (row: any): number | null => metricModeAbsolute ? num(row?.evidence_k) : num(row?.evidence_mean);

  return {
    primaryDim,
    scenarioIds,
    primaryIds,
    shouldShowFESplit,
    metricModeAbsolute,
    colourForPrimary,
    hexToRgba,
    forecastDecal,
    fmtValue,
    getRow,
    getTotalValue,
    getEvidenceValue,
  };
}

export function buildComparisonBarEChartsOption(
  result: AnalysisResult,
  settings: Record<string, any> = {},
  args: ComparisonChartOptionArgs = {},
): any | null {
  const state = buildComparisonChartState(result, settings, args);
  if (!state) return null;

  const {
    primaryDim,
    scenarioIds,
    primaryIds,
    shouldShowFESplit,
    metricModeAbsolute,
    colourForPrimary,
    hexToRgba,
    forecastDecal,
    fmtValue,
    getRow,
    getTotalValue,
    getEvidenceValue,
  } = state;

  const showToolbox = args.ui?.showToolbox ?? false;
  const widthPx = args.layout?.widthPx && Number.isFinite(args.layout.widthPx) ? args.layout.widthPx : 400;
  const categoryIsScenario = scenarioIds.length > 1;
  const requestedStackMode = typeof settings.stack_mode === 'string' ? settings.stack_mode : undefined;
  const effectiveStackMode = requestedStackMode || (categoryIsScenario ? 'stacked' : 'grouped');
  const useScenarioStack = categoryIsScenario && effectiveStackMode !== 'grouped';
  const categories = categoryIsScenario
    ? scenarioIds.map(sid => getScenarioTitleWithBasis(result, sid))
    : primaryIds.map(pid => getDimLabel(result.dimension_values, primaryDim.id, pid));
  const categoryCount = Math.max(1, categories.length);
  const perCategoryPx = widthPx / Math.max(1, categoryCount);
  const barLabelRotate =
    categoryCount >= 14 || widthPx < 300 ? 60 :
    categoryCount >= 8 || perCategoryPx < 52 ? 45 :
    categoryCount >= 5 && perCategoryPx < 80 ? 30 :
    0;
  const seriesCountForDensity = categoryIsScenario ? primaryIds.length : (shouldShowFESplit ? 2 : 1);
  const showValueLabels = (categoryCount * Math.max(1, seriesCountForDensity)) <= 18;

  const series: any[] = [];
  if (categoryIsScenario) {
    primaryIds.forEach((pid, idx) => {
      const branchLabel = getDimLabel(result.dimension_values, primaryDim.id, pid);
      const colour = colourForPrimary(pid, idx);
      if (shouldShowFESplit) {
        series.push({
          name: `${branchLabel} — e`,
          type: 'bar',
          stack: useScenarioStack ? 'comparison' : pid,
          ...(effectiveStackMode === 'stacked_100' ? { stackStrategy: 'percentage' as const } : null),
          itemStyle: { color: hexToRgba(colour, 0.9) },
          label: { show: false },
          data: scenarioIds.map(sid => {
            const row = getRow(pid, sid);
            const total = getTotalValue(row);
            const evidence = getEvidenceValue(row);
            const ev = typeof evidence === 'number' && typeof total === 'number'
              ? Math.min(total, evidence)
              : (typeof evidence === 'number' ? evidence : 0);
            return { value: ev, __raw: row, __total: total };
          }),
        });
        series.push({
          name: `${branchLabel} — f−e`,
          type: 'bar',
          stack: useScenarioStack ? 'comparison' : pid,
          ...(effectiveStackMode === 'stacked_100' ? { stackStrategy: 'percentage' as const } : null),
          itemStyle: { color: hexToRgba(colour, 0.4), decal: forecastDecal },
          label: {
            show: showValueLabels && !useScenarioStack,
            position: 'top',
            formatter: (p: any) => fmtValue(typeof p?.data?.__total === 'number' ? p.data.__total : null),
            fontSize: 7,
            color: echartsThemeColours().text,
          },
          data: scenarioIds.map(sid => {
            const row = getRow(pid, sid);
            const total = getTotalValue(row);
            const evidence = getEvidenceValue(row);
            const ev = typeof evidence === 'number' && typeof total === 'number'
              ? Math.min(total, evidence)
              : (typeof evidence === 'number' ? evidence : 0);
            const residual = typeof total === 'number' ? Math.max(0, total - ev) : 0;
            return { value: residual, __raw: row, __total: total };
          }),
        });
      } else {
        series.push({
          name: branchLabel,
          type: 'bar',
          ...(useScenarioStack ? { stack: 'comparison' } : null),
          ...(effectiveStackMode === 'stacked_100' ? { stackStrategy: 'percentage' as const } : null),
          itemStyle: { color: colour },
          label: {
            show: showValueLabels && !useScenarioStack,
            position: 'top',
            formatter: (p: any) => fmtValue(typeof p?.value === 'number' ? p.value : null),
            fontSize: 7,
            color: echartsThemeColours().text,
          },
          labelLayout: showValueLabels ? { hideOverlap: true } : undefined,
          data: scenarioIds.map(sid => {
            const row = getRow(pid, sid);
            return { value: getTotalValue(row) ?? 0, __raw: row };
          }),
        });
      }
    });
  } else {
    const scenarioId = scenarioIds[0];
    if (shouldShowFESplit) {
      series.push({
        name: 'Evidence',
        type: 'bar',
        stack: 'comparison',
        ...(effectiveStackMode === 'stacked_100' ? { stackStrategy: 'percentage' as const } : null),
        label: { show: false },
        data: primaryIds.map((pid, idx) => {
          const row = getRow(pid, scenarioId);
          const total = getTotalValue(row);
          const evidence = getEvidenceValue(row);
          const ev = typeof evidence === 'number' && typeof total === 'number'
            ? Math.min(total, evidence)
            : (typeof evidence === 'number' ? evidence : 0);
          return {
            value: ev,
            itemStyle: { color: hexToRgba(colourForPrimary(pid, idx), 0.9) },
            __raw: row,
            __total: total,
          };
        }),
      });
      series.push({
        name: 'Forecast − Evidence',
        type: 'bar',
        stack: 'comparison',
        ...(effectiveStackMode === 'stacked_100' ? { stackStrategy: 'percentage' as const } : null),
        label: {
          show: showValueLabels,
          position: 'top',
          formatter: (p: any) => fmtValue(typeof p?.data?.__total === 'number' ? p.data.__total : null),
          fontSize: 7,
          color: echartsThemeColours().text,
        },
        data: primaryIds.map((pid, idx) => {
          const row = getRow(pid, scenarioId);
          const total = getTotalValue(row);
          const evidence = getEvidenceValue(row);
          const ev = typeof evidence === 'number' && typeof total === 'number'
            ? Math.min(total, evidence)
            : (typeof evidence === 'number' ? evidence : 0);
          const residual = typeof total === 'number' ? Math.max(0, total - ev) : 0;
          return {
            value: residual,
            itemStyle: { color: hexToRgba(colourForPrimary(pid, idx), 0.4), decal: forecastDecal },
            __raw: row,
            __total: total,
          };
        }),
      });
    } else {
      series.push({
        name: scenarioId ? getScenarioTitleWithBasis(result, scenarioId) : 'Comparison',
        type: 'bar',
        label: {
          show: showValueLabels,
          position: 'top',
          formatter: (p: any) => fmtValue(typeof p?.value === 'number' ? p.value : null),
          fontSize: 7,
          color: echartsThemeColours().text,
        },
        labelLayout: showValueLabels ? { hideOverlap: true } : undefined,
        data: primaryIds.map((pid, idx) => {
          const row = getRow(pid, scenarioId);
          return {
            value: getTotalValue(row) ?? 0,
            itemStyle: { color: colourForPrimary(pid, idx) },
            __raw: row,
          };
        }),
      });
    }
  }

  return {
    __dagnet_skip_stack_mode: true,
    animation: false,
    backgroundColor: 'transparent',
    toolbox: showToolbox
      ? {
          show: true,
          right: 8,
          top: 8,
          feature: { saveAsImage: { show: true }, restore: { show: true } },
        }
      : { show: false },
    legend: { show: true, top: 0, left: 0, textStyle: { color: echartsThemeColours().text, fontSize: 9 } },
    grid: { left: 8, right: 16, top: showToolbox ? 34 : 22, bottom: barLabelRotate ? 58 : 42, containLabel: true },
    tooltip: {
      trigger: 'axis',
      axisPointer: { type: 'shadow' },
      confine: true,
      ...echartsTooltipStyle(),
      formatter: (params: any) => {
        const ps = Array.isArray(params) ? params : [params];
        const title = ps[0]?.axisValueLabel ?? '';
        const lines = [`<div style="font-size:11px;line-height:1.25;">`, `<div style="font-weight:600;margin-bottom:4px;">${title}</div>`];
        for (const p of ps) {
          if (typeof p?.value !== 'number' || !Number.isFinite(p.value) || p.value === 0) continue;
          lines.push(`<div>${p.marker || ''}${p.seriesName}: ${fmtValue(p.value)}</div>`);
        }
        lines.push(`</div>`);
        return lines.join('');
      },
    },
    xAxis: {
      type: 'category',
      data: categories.map(c => wrapAxisLabel(c)),
      axisLabel: {
        interval: 0,
        rotate: barLabelRotate,
        fontSize: 9,
        lineHeight: 12,
        hideOverlap: true,
        align: barLabelRotate ? ('right' as const) : ('center' as const),
        verticalAlign: barLabelRotate ? ('middle' as const) : ('top' as const),
        color: echartsThemeColours().text,
      },
      axisLine: { lineStyle: { color: echartsThemeColours().border } },
    },
    yAxis: {
      type: 'value',
      axisLabel: {
        formatter: (v: number) => metricModeAbsolute ? Math.round(v).toString() : `${Math.round(v * 100)}%`,
        fontSize: 9,
        color: echartsThemeColours().text,
      },
      splitLine: { lineStyle: { color: echartsThemeColours().gridLine } },
      axisLine: { lineStyle: { color: echartsThemeColours().border } },
    },
    series,
  };
}

export function buildComparisonPieEChartsOption(
  result: AnalysisResult,
  settings: Record<string, any> = {},
  args: ComparisonChartOptionArgs = {},
): any | null {
  const state = buildComparisonChartState(result, settings, args);
  if (!state) return null;

  const {
    primaryDim,
    scenarioIds,
    primaryIds,
    metricModeAbsolute,
    colourForPrimary,
    fmtValue,
    getRow,
    getTotalValue,
  } = state;

  if (scenarioIds.length !== 1) return null;
  const scenarioId = scenarioIds[0];
  const data = primaryIds.map((pid, idx) => {
    const row = getRow(pid, scenarioId);
    return {
      name: getDimLabel(result.dimension_values, primaryDim.id, pid),
      value: getTotalValue(row) ?? 0,
      itemStyle: { color: colourForPrimary(pid, idx) },
      __raw: row,
    };
  });

  return {
    animation: false,
    backgroundColor: 'transparent',
    tooltip: {
      trigger: 'item',
      confine: true,
      ...echartsTooltipStyle(),
      formatter: (p: any) => {
        const v = typeof p?.value === 'number' ? p.value : null;
        return [`<div style="font-size:11px;line-height:1.25;">`, `<div style="font-weight:600;margin-bottom:4px;">${p?.name || ''}</div>`, `<div>${metricModeAbsolute ? 'Value' : 'Share'}: ${fmtValue(v)}</div>`, `</div>`].join('');
      },
    },
    legend: { show: true, top: 0, left: 0, textStyle: { color: echartsThemeColours().text, fontSize: 9 } },
    series: [
      {
        name: scenarioId ? getScenarioTitleWithBasis(result, scenarioId) : 'Comparison',
        type: 'pie',
        radius: '65%',
        center: ['50%', '58%'],
        label: {
          show: true,
          formatter: (p: any) => `${p.name}\n${metricModeAbsolute ? fmtValue(typeof p?.value === 'number' ? p.value : null) : `${Math.round(p.percent)}%`}`,
          fontSize: 7,
          color: echartsThemeColours().text,
        },
        labelLayout: { hideOverlap: true },
        data,
      },
    ],
  };
}

export function buildComparisonTimeSeriesEChartsOption(
  result: AnalysisResult,
  settings: Record<string, any> = {},
  args: ComparisonChartOptionArgs = {},
): any | null {
  const rows: any[] = Array.isArray(result?.data) ? result.data : [];
  if (rows.length === 0) return null;
  const c = echartsThemeColours();
  const visibleScenarioIds = args.scenarioIds && args.scenarioIds.length ? args.scenarioIds : ['current'];
  const filteredRows = rows.filter((r: any) => visibleScenarioIds.includes(String(r?.scenario_id)));
  if (filteredRows.length === 0) return null;

  const branchMeta: any = result?.dimension_values?.branch || {};
  const scenarioMeta: any = result?.dimension_values?.scenario_id || {};
  const branchIds = Array.from(new Set(filteredRows.map((r: any) => String(r?.branch)).filter(Boolean)))
    .sort((a, b) => getDimOrder(result.dimension_values, 'branch', a) - getDimOrder(result.dimension_values, 'branch', b));
  const dates = Array.from(new Set(filteredRows.map((r: any) => String(r?.date)).filter(Boolean))).sort();
  if (dates.length === 0) return null;

  const scenarioId = visibleScenarioIds[0];
  const visibilityMode = scenarioMeta?.[scenarioId]?.visibility_mode ?? 'f+e';
  const metricModeAbsolute = settings.metric_mode === 'absolute';
  const seriesType = settings.series_type ?? 'bar';
  const showSmooth = settings.smooth ?? false;
  const showMarkers = settings.show_markers;
  const showValueLabels = dates.length * branchIds.length <= 24;

  const comparisonColours = ['#3b82f6', '#10b981', '#f59e0b', '#ec4899', '#8b5cf6', '#14b8a6', '#ef4444', '#6366f1'];
  const colourForBranch = (branchId: string, idx: number) => branchMeta?.[branchId]?.colour || comparisonColours[idx % comparisonColours.length];
  const hexToRgba = (hex: string, alpha: number): string => {
    const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
    if (!m) return hex;
    const r = parseInt(m[1], 16);
    const g = parseInt(m[2], 16);
    const b = parseInt(m[3], 16);
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
  };
  const forecastDecal = { symbol: 'rect', dashArrayX: [1, 0], dashArrayY: [3, 3], rotation: -Math.PI / 4 } as any;
  const pointsByBranchAndDate = new Map<string, any>();
  for (const row of filteredRows) {
    pointsByBranchAndDate.set(`${String(row.branch)}::${String(row.date)}`, row);
  }
  const fmtValue = (v: number | null) => {
    if (typeof v !== 'number' || !Number.isFinite(v)) return '—';
    if (metricModeAbsolute) return Math.round(v).toLocaleString();
    return `${(v * 100).toFixed(1)}%`;
  };
  const getPoint = (branchId: string, date: string) => pointsByBranchAndDate.get(`${branchId}::${date}`) || null;
  const getValue = (row: any) => {
    if (!row) return null;
    if (metricModeAbsolute) {
      if (visibilityMode === 'e') return typeof row.evidence_y === 'number' ? row.evidence_y : row.y;
      if (visibilityMode === 'f') return typeof row.projected_y === 'number' ? row.projected_y : (typeof row.forecast_y === 'number' ? row.forecast_y : row.y);
      return typeof row.projected_y === 'number' ? row.projected_y : row.y;
    }
    const x = Number(row.x ?? 0);
    if (visibilityMode === 'e') {
      return x > 0 && typeof row.evidence_y === 'number' ? row.evidence_y / x : row.rate;
    }
    if (visibilityMode === 'f') {
      return x > 0 && typeof row.projected_y === 'number' ? row.projected_y / x : row.rate;
    }
    return x > 0 && typeof row.projected_y === 'number' ? row.projected_y / x : row.rate;
  };

  const shouldShowFESplit = visibilityMode === 'f+e'
    && filteredRows.some((r: any) => typeof r.evidence_y === 'number')
    && filteredRows.some((r: any) => typeof r.forecast_y === 'number');

  const series: any[] = [];
  for (let i = 0; i < branchIds.length; i++) {
    const branchId = branchIds[i];
    const branchName = branchMeta?.[branchId]?.name || branchId;
    const colour = colourForBranch(branchId, i);
    if (shouldShowFESplit) {
      series.push({
        name: `${branchName} — e`,
        type: seriesType === 'line' ? 'line' : 'bar',
        stack: 'comparison',
        showSymbol: seriesType === 'line' ? (showMarkers ?? (dates.length <= 20)) : undefined,
        smooth: seriesType === 'line' ? showSmooth : undefined,
        lineStyle: seriesType === 'line' ? { width: 2, color: hexToRgba(colour, 0.9) } : undefined,
        itemStyle: { color: hexToRgba(colour, 0.9) },
        areaStyle: seriesType === 'line' && settings.area_fill ? { opacity: 0.18 } : undefined,
        label: { show: false },
        data: dates.map(d => {
          const row = getPoint(branchId, d);
          const x = Number(row?.x ?? 0);
          const evidenceValue = metricModeAbsolute
            ? (typeof row?.evidence_y === 'number' ? row.evidence_y : 0)
            : (x > 0 && typeof row?.evidence_y === 'number' ? row.evidence_y / x : 0);
          const total = getValue(row);
          return [d, evidenceValue, { __total: total }];
        }),
      });
      series.push({
        name: `${branchName} — f−e`,
        type: seriesType === 'line' ? 'line' : 'bar',
        stack: 'comparison',
        showSymbol: seriesType === 'line' ? false : undefined,
        smooth: seriesType === 'line' ? showSmooth : undefined,
        lineStyle: seriesType === 'line' ? { width: 2, color: hexToRgba(colour, 0.45), type: 'dashed' } : undefined,
        itemStyle: { color: hexToRgba(colour, 0.45), decal: forecastDecal },
        areaStyle: seriesType === 'line' && settings.area_fill ? { opacity: 0.12 } : undefined,
        label: {
          show: showValueLabels && seriesType !== 'line',
          position: 'top',
          formatter: (p: any) => fmtValue(typeof p?.value?.[2]?.__total === 'number' ? p.value[2].__total : null),
          fontSize: 7,
          color: c.text,
        },
        data: dates.map(d => {
          const row = getPoint(branchId, d);
          const x = Number(row?.x ?? 0);
          const evidenceValue = metricModeAbsolute
            ? (typeof row?.evidence_y === 'number' ? row.evidence_y : 0)
            : (x > 0 && typeof row?.evidence_y === 'number' ? row.evidence_y / x : 0);
          const total = getValue(row);
          const residual = typeof total === 'number' ? Math.max(0, total - evidenceValue) : 0;
          return [d, residual, { __total: total }];
        }),
      });
    } else {
      series.push({
        name: branchName,
        type: seriesType === 'line' ? 'line' : 'bar',
        stack: 'comparison',
        showSymbol: seriesType === 'line' ? (showMarkers ?? (dates.length <= 20)) : undefined,
        smooth: seriesType === 'line' ? showSmooth : undefined,
        lineStyle: seriesType === 'line' ? { width: 2, color: colour } : undefined,
        itemStyle: { color: colour },
        areaStyle: seriesType === 'line' && settings.area_fill ? { opacity: 0.16 } : undefined,
        label: {
          show: showValueLabels && seriesType !== 'line',
          position: 'top',
          formatter: (p: any) => fmtValue(Array.isArray(p?.value) ? p.value[1] : null),
          fontSize: 9,
          color: c.text,
        },
        labelLayout: showValueLabels ? { hideOverlap: true } : undefined,
        data: dates.map(d => {
          const row = getPoint(branchId, d);
          return [d, getValue(row) ?? 0];
        }),
      });
    }
  }

  return {
    __dagnet_skip_stack_mode: true,
    animation: false,
    backgroundColor: 'transparent',
    tooltip: {
      trigger: 'axis',
      axisPointer: { type: 'shadow' },
      ...echartsTooltipStyle(),
      formatter: (params: any) => {
        const items = Array.isArray(params) ? params : [params];
        const first = items[0];
        const dateRaw = Array.isArray(first?.value) ? first.value[0] : first?.axisValue;
        const dateStr = String(dateRaw || '');
        const lines = items.map((it: any) => {
          const val = Array.isArray(it?.value) ? it.value[1] : it?.value;
          return `${it?.marker || ''} ${it?.seriesName || ''}: <strong>${fmtValue(typeof val === 'number' ? val : null)}</strong>`;
        });
        return `<strong>${dateStr}</strong><br/>${lines.join('<br/>')}`;
      },
    },
    grid: { left: 52, right: 16, bottom: 60, top: series.length > 3 ? 72 : 46, containLabel: false },
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
    yAxis: [{
      type: 'value',
      name: metricModeAbsolute ? 'Conversions' : 'Rate',
      nameLocation: 'middle',
      nameGap: 45,
      nameTextStyle: { fontSize: 8, color: c.text },
      min: settings.y_axis_min ?? 0,
      max: settings.y_axis_max ?? undefined,
      axisLabel: {
        fontSize: 9,
        color: c.text,
        formatter: (value: number) => metricModeAbsolute
          ? (value >= 1000 ? `${(value / 1000).toFixed(1)}k` : value.toString())
          : `${Math.round(value * 100)}%`,
      },
    }],
    legend: {
      show: settings.show_legend ?? true,
      top: 0,
      textStyle: { color: c.text, fontSize: 9 },
    },
    series,
  };
}
