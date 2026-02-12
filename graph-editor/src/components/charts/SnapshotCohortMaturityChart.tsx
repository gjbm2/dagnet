/**
 * SnapshotCohortMaturityChart
 *
 * Renders an age-aligned cohort maturity curve:
 * - x-axis: age (τ days since cohort anchor_day)
 * - y-axis: conversion rate (evidenced base line + forecast “crown” + future tail)
 *
 * Input: a normalised AnalysisResult where `data` contains rows:
 * { scenario_id, subject_id, tau_days, rate, projected_rate, tau_solid_max, tau_future_max, boundary_date, ... }
 */
import React, { useMemo, useState } from 'react';
import ReactECharts from 'echarts-for-react';
import { ExternalLink, Download } from 'lucide-react';
import type { AnalysisResult } from '../../lib/graphComputeClient';
import { chartOperationsService } from '../../services/chartOperationsService';
import { analysisResultToCsv } from '../../services/analysisExportService';
import { downloadTextFile } from '../../services/downloadService';

interface Props {
  result: AnalysisResult;
  visibleScenarioIds: string[];
  /** Per-scenario F/E/F+E mode (Scenario Panel). */
  scenarioVisibilityModes?: Record<string, 'f+e' | 'f' | 'e'>;
  height?: number;
  fillHeight?: boolean;
  queryDsl?: string;
  source?: {
    parent_file_id?: string;
    parent_tab_id?: string;
    query_dsl?: string;
    analysis_type?: string;
  };
  hideOpenAsTab?: boolean;
}

function formatDate_d_MMM_yy(dateStr: string): string {
  const d = new Date(dateStr);
  if (Number.isNaN(d.getTime())) return dateStr;
  const day = d.getDate();
  const month = d.toLocaleDateString('en-GB', { month: 'short' });
  const yy = d.toLocaleDateString('en-GB', { year: '2-digit' });
  return `${day}-${month}-${yy}`;
}

function formatPercent(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—';
  return `${(v * 100).toFixed(1)}%`;
}

export function SnapshotCohortMaturityChart({ result, visibleScenarioIds, scenarioVisibilityModes, height = 320, fillHeight = false, queryDsl, source, hideOpenAsTab = false }: Props): JSX.Element {
  const rows = Array.isArray(result?.data) ? result.data : [];

  if (rows.length === 0) {
    const isEmpty = result?.metadata?.empty === true;
    return (
      <div style={{ padding: '24px 16px', color: '#6b7280', fontSize: 13, textAlign: 'center' }}>
        <p style={{ marginBottom: 8, fontWeight: 600, color: '#374151' }}>No cohort maturity data</p>
        <p style={{ margin: 0 }}>
          {isEmpty
            ? 'No snapshot data was found in the database for this parameter and date range. Ensure snapshots have been written for the selected edge/parameter.'
            : 'The analysis returned no data rows. Check that the selected query has associated snapshot data.'}
        </p>
      </div>
    );
  }

  const subjectIds = useMemo(() => {
    const s = new Set<string>();
    for (const r of rows) {
      if (r?.subject_id) s.add(String(r.subject_id));
    }
    return Array.from(s);
  }, [rows]);

  const [selectedSubjectId, setSelectedSubjectId] = useState<string>(() => subjectIds[0] || 'subject');

  // Keep selection stable if subject list changes.
  const effectiveSubjectId = subjectIds.includes(selectedSubjectId) ? selectedSubjectId : (subjectIds[0] || 'subject');

  const scenarioMeta = (result?.dimension_values as any)?.scenario_id || {};
  const subjectMeta = (result?.dimension_values as any)?.subject_id || {};

  const filteredRows = useMemo(() => {
    return rows
      .filter(r => String(r?.subject_id) === effectiveSubjectId)
      .filter(r => visibleScenarioIds.includes(String(r?.scenario_id)));
  }, [rows, effectiveSubjectId, visibleScenarioIds]);

  const axisMeta = useMemo(() => {
    let maxTau: number | null = null;
    let tauSolidMax: number | null = null;
    let tauFutureMax: number | null = null;
    let boundaryDate: string | null = null;

    for (const r of filteredRows) {
      const tau = Number((r as any)?.tau_days);
      if (Number.isFinite(tau)) maxTau = Math.max(maxTau ?? 0, tau);
      const ts = Number((r as any)?.tau_solid_max);
      const tf = Number((r as any)?.tau_future_max);
      if (Number.isFinite(ts)) tauSolidMax = Math.max(tauSolidMax ?? 0, ts);
      if (Number.isFinite(tf)) tauFutureMax = Math.max(tauFutureMax ?? 0, tf);
      const b = (r as any)?.boundary_date;
      if (typeof b === 'string' && b) boundaryDate = String(b);
    }

    return {
      axisMin: 0,
      axisMax: maxTau,
      tauSolidMax: tauSolidMax ?? 0,
      tauFutureMax: tauFutureMax ?? 0,
      boundaryDate,
    };
  }, [filteredRows]);

  // ──────────────────────────────────────────────────────────────
  // SERIES BUILDER
  //
  // Age-aligned maturity curve:
  //   x = tau_days (days since cohort anchor)
  //   y = rate (base evidence) and projected_rate (forecast crown)
  //
  // Segments:
  //   solid:  τ ≤ tau_solid_max  (all cohorts have reached this age)
  //   dashed: tau_solid_max < τ ≤ tau_future_max (some cohorts still maturing)
  //   future: τ > tau_future_max (forecast-only, from synthetic frames)
  // ──────────────────────────────────────────────────────────────
  const hasAnySignal = useMemo(() => {
    for (const r of filteredRows) {
      const base = (r as any)?.rate;
      const proj = (r as any)?.projected_rate;
      if ((typeof base === 'number' && Number.isFinite(base)) || (typeof proj === 'number' && Number.isFinite(proj))) return true;
    }
    return false;
  }, [filteredRows]);

  if (!hasAnySignal) {
    const isEmpty = result?.metadata?.empty === true;
    return (
      <div style={{ padding: '24px 16px', color: '#6b7280', fontSize: 13, textAlign: 'center' }}>
        <p style={{ marginBottom: 8, fontWeight: 600, color: '#374151' }}>No cohort maturity data</p>
        <p style={{ margin: 0 }}>
          {isEmpty
            ? 'No snapshot data was found in the database for this parameter and date range. Ensure snapshots have been written for the selected edge/parameter.'
            : 'The analysis returned no non-null maturity values for the selected scenarios/subject.'}
        </p>
      </div>
    );
  }

  const series = useMemo(() => {
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
      const scenarioId = String(r?.scenario_id);
      const tauDays = Number((r as any)?.tau_days);
      if (!scenarioId || !Number.isFinite(tauDays)) continue;
      if (axisMeta.axisMax !== null && Number.isFinite(axisMeta.axisMax) && tauDays > axisMeta.axisMax) continue;

      const baseRate = (r as any)?.rate === null || (r as any)?.rate === undefined ? null : Number((r as any).rate);
      const projectedRate = (r as any)?.projected_rate === null || (r as any)?.projected_rate === undefined ? null : Number((r as any).projected_rate);
      const cohortsExpected = (r as any)?.cohorts_expected === null || (r as any)?.cohorts_expected === undefined ? null : Number((r as any).cohorts_expected);
      const cohortsInDenom = (r as any)?.cohorts_in_denominator === null || (r as any)?.cohorts_in_denominator === undefined ? null : Number((r as any).cohorts_in_denominator);
      const cohortsCoveredBase = (r as any)?.cohorts_covered_base === null || (r as any)?.cohorts_covered_base === undefined ? null : Number((r as any).cohorts_covered_base);
      const cohortsCoveredProjected = (r as any)?.cohorts_covered_projected === null || (r as any)?.cohorts_covered_projected === undefined ? null : Number((r as any).cohorts_covered_projected);

      if (!byScenario.has(scenarioId)) byScenario.set(scenarioId, []);
      byScenario.get(scenarioId)!.push({
        tauDays,
        baseRate: Number.isFinite(baseRate as any) ? (baseRate as number) : null,
        projectedRate: Number.isFinite(projectedRate as any) ? (projectedRate as number) : null,
        cohortsExpected: Number.isFinite(cohortsExpected as any) ? (cohortsExpected as number) : null,
        cohortsInDenom: Number.isFinite(cohortsInDenom as any) ? (cohortsInDenom as number) : null,
        cohortsCoveredBase: Number.isFinite(cohortsCoveredBase as any) ? (cohortsCoveredBase as number) : null,
        cohortsCoveredProjected: Number.isFinite(cohortsCoveredProjected as any) ? (cohortsCoveredProjected as number) : null,
      });
    }

    const out: any[] = [];
    for (const scenarioId of Array.from(byScenario.keys()).sort()) {
      const name = scenarioMeta?.[scenarioId]?.name || scenarioId;
      const colour = scenarioMeta?.[scenarioId]?.colour;
      const points = (byScenario.get(scenarioId) || []).slice().sort((a, b) => a.tauDays - b.tauDays);

      const mode =
        scenarioVisibilityModes?.[scenarioId]
        ?? (scenarioMeta?.[scenarioId]?.visibility_mode as any)
        ?? 'f+e';

      const tauSolidMax = axisMeta.tauSolidMax ?? 0;
      const tauFutureMax = axisMeta.tauFutureMax ?? 0;

      const mkLine = (args: {
        id: string;
        lineType: 'solid' | 'dashed';
        opacity?: number;
        data: Array<{ tauDays: number; v: number | null; meta: any }>;
        showSymbol?: boolean;
        areaStyle?: any;
      }): any | null => {
        const { id, lineType, opacity = 1, data, showSymbol = false, areaStyle } = args;
        const seriesData = data.map((p) => ({
          value: [p.tauDays, p.v],
          ...p.meta,
        }));
        if (seriesData.length === 0) return null;
        return {
          id,
          name,
          type: 'line',
          showSymbol,
          symbolSize: 6,
          smooth: false,
          connectNulls: false,
          lineStyle: { width: 2, color: colour, type: lineType, opacity },
          itemStyle: { color: colour, opacity },
          emphasis: { focus: 'series' },
          ...(areaStyle ? { areaStyle } : {}),
          data: seriesData,
        };
      };

      const baseSolidPts = points
        .filter((p) => p.tauDays <= tauSolidMax)
        .map((p) => ({
          tauDays: p.tauDays,
          v: p.baseRate,
          meta: { tauDays: p.tauDays, baseRate: p.baseRate, projectedRate: p.projectedRate, boundaryDate: axisMeta.boundaryDate, cohortsExpected: p.cohortsExpected, cohortsInDenom: p.cohortsInDenom, cohortsCoveredBase: p.cohortsCoveredBase, cohortsCoveredProjected: p.cohortsCoveredProjected },
        }));

      const baseDashedPts = points
        .filter((p) => p.tauDays >= tauSolidMax && p.tauDays <= tauFutureMax)
        .map((p) => ({
          tauDays: p.tauDays,
          v: p.baseRate,
          meta: { tauDays: p.tauDays, baseRate: p.baseRate, projectedRate: p.projectedRate, boundaryDate: axisMeta.boundaryDate, cohortsExpected: p.cohortsExpected, cohortsInDenom: p.cohortsInDenom, cohortsCoveredBase: p.cohortsCoveredBase, cohortsCoveredProjected: p.cohortsCoveredProjected },
        }));

      const futureForecastPts = points
        .filter((p) => p.tauDays >= tauFutureMax)
        .map((p) => ({
          tauDays: p.tauDays,
          v: p.projectedRate,
          meta: { tauDays: p.tauDays, baseRate: p.baseRate, projectedRate: p.projectedRate, boundaryDate: axisMeta.boundaryDate, cohortsExpected: p.cohortsExpected, cohortsInDenom: p.cohortsInDenom, cohortsCoveredBase: p.cohortsCoveredBase, cohortsCoveredProjected: p.cohortsCoveredProjected },
        }));

      // Projected rate in the dashed region — used for the forecast "crown" fill.
      const crownProjPts = points
        .filter((p) => p.tauDays >= tauSolidMax && p.tauDays <= tauFutureMax)
        .map((p) => ({
          tauDays: p.tauDays,
          v: p.projectedRate,
          meta: { tauDays: p.tauDays, baseRate: p.baseRate, projectedRate: p.projectedRate, boundaryDate: axisMeta.boundaryDate, cohortsExpected: p.cohortsExpected, cohortsInDenom: p.cohortsInDenom, cohortsCoveredBase: p.cohortsCoveredBase, cohortsCoveredProjected: p.cohortsCoveredProjected },
        }));

      if (mode === 'f') {
        const forecastAll = points.map((p) => ({
          tauDays: p.tauDays,
          v: p.projectedRate,
          meta: { tauDays: p.tauDays, baseRate: p.baseRate, projectedRate: p.projectedRate, boundaryDate: axisMeta.boundaryDate, cohortsExpected: p.cohortsExpected, cohortsInDenom: p.cohortsInDenom, cohortsCoveredBase: p.cohortsCoveredBase, cohortsCoveredProjected: p.cohortsCoveredProjected },
        }));
        const sForecast = mkLine({
          id: `${scenarioId}::forecast`,
          lineType: 'dashed',
          opacity: 0.85,
          data: forecastAll,
          showSymbol: forecastAll.length <= 12,
          areaStyle: { color: colour || '#111827', opacity: 0.08 },
        });
        if (sForecast) out.push(sForecast);
        continue;
      }

      // Evidence base line: solid (τ ≤ solid), then dashed (solid < τ ≤ future).
      const sBaseSolid = mkLine({ id: `${scenarioId}::baseSolid`, lineType: 'solid', data: baseSolidPts, showSymbol: baseSolidPts.length <= 12 });
      const sBaseDashed = mkLine({ id: `${scenarioId}::baseDashed`, lineType: 'dashed', data: baseDashedPts, showSymbol: false });

      if (mode === 'f+e') {
        // Forecast "crown" in the dashed region (white-mask technique):
        // 1. Light filled area from 0 to projectedRate
        // 2. White filled area from 0 to baseRate (masks the lower portion)
        // Net visible shading = gap between evidence and forecast.
        const sCrownUpper = mkLine({
          id: `${scenarioId}::crownUpper`,
          lineType: 'dashed',
          opacity: 0,        // invisible line
          data: crownProjPts,
          areaStyle: { color: colour || '#111827', opacity: 0.15 },
        });
        const sCrownMask = mkLine({
          id: `${scenarioId}::crownMask`,
          lineType: 'dashed',
          opacity: 0,        // invisible line
          data: baseDashedPts, // same base points
          areaStyle: { color: '#ffffff', opacity: 1 },  // white mask
        });
        if (sCrownUpper) out.push(sCrownUpper);
        if (sCrownMask) out.push(sCrownMask);
      }

      // Base lines on top of everything.
      if (sBaseSolid) out.push(sBaseSolid);
      if (sBaseDashed) out.push(sBaseDashed);

      if (mode === 'f+e') {
        // Future region: forecast-only tail beyond the observation boundary.
        const sFuture = mkLine({ id: `${scenarioId}::futureForecast`, lineType: 'dashed', opacity: 0.75, data: futureForecastPts, showSymbol: false });
        if (sFuture) out.push(sFuture);
      }
    }

    return out;
  }, [filteredRows, axisMeta, scenarioMeta, scenarioVisibilityModes]);

  const option = useMemo(() => {
    // Compute Y-axis max from data with headroom, rounded to a clean percentage
    let maxRate = 0;
    for (const s of series) {
      for (const d of s.data) {
        const v = d?.value?.[1];
        if (typeof v === 'number' && Number.isFinite(v) && v > maxRate) maxRate = v;
      }
    }
    // Add 20% headroom, round up to nearest 5%, clamp to 1.0
    const yMax = Math.min(1.0, Math.max(0.05, Math.ceil((maxRate * 1.2) * 20) / 20));

    return {
      tooltip: {
        trigger: 'axis',
        axisPointer: { type: 'line' },
        formatter: (params: any) => {
          const items = Array.isArray(params) ? params : [params];
          const first = items[0];
          const tauRaw = first?.value?.[0];
          const tauDays = typeof tauRaw === 'number' ? tauRaw : Number(tauRaw);

          const best = items.find((it: any) => it?.data && (it.data.baseRate !== undefined || it.data.projectedRate !== undefined))?.data
            ?? first?.data
            ?? {};
          const baseRate = (best?.baseRate === null || best?.baseRate === undefined) ? null : Number(best.baseRate);
          const projectedRate = (best?.projectedRate === null || best?.projectedRate === undefined) ? null : Number(best.projectedRate);
          const boundaryDate = typeof best?.boundaryDate === 'string' ? String(best.boundaryDate) : (axisMeta.boundaryDate || '');

          const title = Number.isFinite(tauDays)
            ? `Age: ${tauDays} day(s) · As at ${formatDate_d_MMM_yy(boundaryDate)}`
            : `As at ${formatDate_d_MMM_yy(boundaryDate)}`;

          const lines = items
            // de-dupe repeated series that share a scenario name
            .filter((it: any, idx: number, arr: any[]) => arr.findIndex((x: any) => String(x?.seriesName || '') === String(it?.seriesName || '')) === idx)
            .map((it: any) => {
              const seriesName = it?.seriesName || 'Scenario';
              const v = it?.value?.[1];
              return `${seriesName}: <strong>${formatPercent(v)}</strong>`;
            });

          const extra: string[] = [];
          if (baseRate !== null) extra.push(`Evidenced: <strong>${formatPercent(baseRate)}</strong>`);
          if (projectedRate !== null) extra.push(`Projected: <strong>${formatPercent(projectedRate)}</strong>`);

          const ce = best?.cohortsExpected;
          const cd = best?.cohortsInDenom;
          const cb = best?.cohortsCoveredBase;
          const cp = best?.cohortsCoveredProjected;
          if (typeof ce === 'number' && typeof cd === 'number') {
            extra.push(`Cohorts: <strong>${cd}/${ce}</strong> in denominator`);
          }
          if (typeof cb === 'number' && typeof cp === 'number') {
            extra.push(`Coverage: base <strong>${cb}</strong> · proj <strong>${cp}</strong> (at this τ)`);
          }

          return `<strong>${title}</strong><br/>${[...lines, ...extra].join('<br/>')}`;
        },
      },
      grid: {
        left: '3%',
        right: '4%',
        bottom: 60,
        top: series.length > 2 ? 80 : 50,
        containLabel: true,
      },
      xAxis: {
        type: 'value',
        name: 'Age (days since cohort date)',
        nameLocation: 'middle' as const,
        nameGap: 30,
        min: axisMeta.axisMin,
        ...(axisMeta.axisMax !== null && Number.isFinite(axisMeta.axisMax) ? { max: axisMeta.axisMax } : {}),
        axisLabel: {
          fontSize: 10,
          formatter: (value: number) => `${Math.round(value)}`,
        },
      },
      yAxis: {
        type: 'value',
        min: 0,
        max: yMax,
        name: 'Conversion rate',
        nameLocation: 'middle' as const,
        nameGap: 45,
        axisLabel: {
          fontSize: 11,
          formatter: (v: number) => `${(v * 100).toFixed(0)}%`,
        },
        splitLine: { lineStyle: { color: '#f3f4f6' } },
      },
      legend: {
        top: 22,
        left: 12,
        textStyle: { fontSize: 11 },
        icon: 'roundRect',
      },
      series,
      dagnet_meta: {
        subject_id: effectiveSubjectId,
        anchor: { from: result?.metadata?.anchor_from, to: result?.metadata?.anchor_to },
        sweep: { from: result?.metadata?.sweep_from, to: result?.metadata?.sweep_to },
      },
    };
  }, [result, series, effectiveSubjectId, axisMeta]);

  const headerRight = useMemo(() => {
    const aFrom = result?.metadata?.anchor_from;
    const aTo = result?.metadata?.anchor_to;
    const sFrom = result?.metadata?.sweep_from;
    const sTo = result?.metadata?.sweep_to;

    const anchor = (aFrom && aTo) ? `Anchor: ${formatDate_d_MMM_yy(aFrom)} – ${formatDate_d_MMM_yy(aTo)}` : null;
    const sweep = (sFrom && sTo) ? `Sweep: ${formatDate_d_MMM_yy(sFrom)} – ${formatDate_d_MMM_yy(sTo)}` : null;
    return [anchor, sweep].filter(Boolean).join(' · ');
  }, [result]);

  return (
    <div style={{
      width: '100%',
      height: fillHeight ? '100%' : undefined,
      display: fillHeight ? 'flex' : undefined,
      flexDirection: fillHeight ? 'column' : undefined,
      minHeight: 0,
    }}>
      <div
        style={{
          padding: '8px 12px',
          borderBottom: '1px solid #e5e7eb',
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          fontSize: 12,
          color: '#6b7280',
          gap: 12,
          flexShrink: 0,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0, flexWrap: 'wrap' }}>
          {queryDsl && (
            <span style={{ fontFamily: 'monospace', fontSize: 11, color: '#374151', fontWeight: 500 }}>
              {queryDsl}
            </span>
          )}
          <span style={{ whiteSpace: 'nowrap' }}>
            <strong>{subjectMeta?.[effectiveSubjectId]?.name || effectiveSubjectId}</strong>
          </span>
          {subjectIds.length > 1 ? (
            <select
              value={effectiveSubjectId}
              onChange={e => setSelectedSubjectId(e.target.value)}
              style={{
                border: '1px solid #e5e7eb',
                background: '#ffffff',
                color: '#374151',
                borderRadius: 6,
                padding: '4px 8px',
                fontSize: 11,
                cursor: 'pointer',
                maxWidth: 260,
              }}
              aria-label="Subject"
              title="Choose which subject (edge/parameter) to plot"
            >
              {subjectIds.map(id => (
                <option key={id} value={id}>
                  {subjectMeta?.[id]?.name || id}
                </option>
              ))}
            </select>
          ) : null}
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexShrink: 0 }}>
          <span style={{ fontSize: 11, color: '#6b7280', whiteSpace: 'nowrap' }}>
            {headerRight}
          </span>
          {!hideOpenAsTab && (
            <button
              type="button"
              onClick={() => {
                void chartOperationsService.openAnalysisChartTabFromAnalysis({
                  chartKind: 'analysis_cohort_maturity',
                  analysisResult: result,
                  scenarioIds: visibleScenarioIds,
                  title: result.analysis_name
                    ? `Chart — ${result.analysis_name}`
                    : queryDsl
                      ? `Chart — ${queryDsl}`
                      : 'Chart — Cohort Maturity',
                  source,
                });
              }}
              style={{
                border: '1px solid #e5e7eb',
                background: '#ffffff',
                color: '#374151',
                borderRadius: 6,
                padding: '4px 8px',
                fontSize: 11,
                cursor: 'pointer',
                whiteSpace: 'nowrap',
              }}
              title="Open as tab"
              aria-label="Open as tab"
            >
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                <ExternalLink size={14} />
              </span>
            </button>
          )}
          <button
            type="button"
            onClick={() => {
              const { filename, csv } = analysisResultToCsv(result);
              downloadTextFile({ filename, content: csv, mimeType: 'text/csv' });
            }}
            style={{
              border: '1px solid #e5e7eb',
              background: '#ffffff',
              color: '#374151',
              borderRadius: 6,
              padding: '4px 8px',
              fontSize: 11,
              cursor: 'pointer',
              whiteSpace: 'nowrap',
            }}
            title="Download CSV"
            aria-label="Download CSV"
          >
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              <Download size={14} />
            </span>
          </button>
        </div>
      </div>

      <ReactECharts
        option={option}
        notMerge={true}
        lazyUpdate={true}
        style={{
          height: fillHeight ? '100%' : height,
          width: '100%',
          flex: fillHeight ? 1 : undefined,
          minHeight: 0,
        }}
        opts={{ renderer: 'svg' }}
      />
    </div>
  );
}
