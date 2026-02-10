/**
 * SnapshotCohortMaturityChart
 *
 * Renders a time-series line chart showing cohort conversion rate as-at successive snapshot dates.
 *
 * Input: a normalised AnalysisResult where `data` contains rows:
 * { scenario_id, subject_id, as_at_date, x, y, rate }
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

function dayDiffUTC(asAtISO: string, originISO: string): number | null {
  const t1 = Date.parse(`${String(asAtISO)}T00:00:00Z`);
  const t0 = Date.parse(`${String(originISO)}T00:00:00Z`);
  if (Number.isNaN(t1) || Number.isNaN(t0)) return null;
  return Math.floor((t1 - t0) / (24 * 60 * 60 * 1000));
}

export function SnapshotCohortMaturityChart({ result, visibleScenarioIds, height = 320, fillHeight = false, queryDsl, source, hideOpenAsTab = false }: Props): JSX.Element {
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

  const axisMode = useMemo((): 'cohort' | 'window' => {
    const q = String(queryDsl || source?.query_dsl || '');
    if (q.includes('window(') || q.includes('.window(')) return 'window';
    return 'cohort';
  }, [queryDsl, source]);

  const fromNodeLabel = useMemo((): string | null => {
    const q = String(queryDsl || source?.query_dsl || '');
    const m = q.match(/\bfrom\(([^)]+)\)/);
    const raw = m?.[1] ? String(m[1]).trim() : '';
    return raw ? raw : null;
  }, [queryDsl, source]);

  // ──────────────────────────────────────────────────────────────
  // X-AXIS COMPUTATION
  //
  // Both modes rebase as_at_date to "days since window/cohort start":
  //   origin  = anchor_from  (= min of the date range the user selected)
  //   x       = as_at_date - origin           (always >= 0)
  //   axisMin = 0
  //   axisMax = t95 (window) or path_t95 (cohort)
  //
  // This means:
  //   window(-30d:)  → x runs 0..30   (shape of maturity from day 0)
  //   window(-45d:)  → x runs 0..45   (same shape, more history)
  //   cohort(A:B)    → x runs 0..path_t95
  // ──────────────────────────────────────────────────────────────
  const xAxisMeta = useMemo(() => {
    // Origin: always anchor_from (= start of the date range).
    const origin: string | null =
      (typeof result?.metadata?.anchor_from === 'string' ? String(result.metadata.anchor_from) : null)
      || (() => {
        for (const r of filteredRows) {
          const v = typeof r?.anchor_from === 'string' ? String(r.anchor_from) : null;
          if (v) return v;
        }
        return null;
      })();

    // Collect t95 / path_t95 for axis max, and first-non-zero for cohort axis min.
    let t95Max: number | null = null;
    let pathT95Max: number | null = null;
    let maxAge: number | null = null;
    let minNonZeroAge: number | null = null;

    for (const r of filteredRows) {
      const t95 = Number(r?.t95_days);
      const pathT95 = Number(r?.path_t95_days);
      if (Number.isFinite(t95)) t95Max = Math.max(t95Max ?? 0, t95);
      if (Number.isFinite(pathT95)) pathT95Max = Math.max(pathT95Max ?? 0, pathT95);

      if (origin) {
        const asAt = typeof r?.as_at_date === 'string' ? String(r.as_at_date) : '';
        if (asAt) {
          const age = dayDiffUTC(asAt, origin);
          if (age !== null && Number.isFinite(age)) {
            maxAge = (maxAge === null) ? age : Math.max(maxAge, age);
            const yProgress = Number(r?.y_progress ?? r?.y ?? 0);
            if (Number.isFinite(yProgress) && yProgress > 0) {
              minNonZeroAge = (minNonZeroAge === null) ? age : Math.min(minNonZeroAge, age);
            }
          }
        }
      }
    }

    // cohort(): start axis at first non-zero data point (skip the empty flat region).
    // window(): always start at 0 (user wants to see "days since start of window").
    const axisMin = (axisMode === 'cohort' && minNonZeroAge !== null && Number.isFinite(minNonZeroAge))
      ? Math.max(0, minNonZeroAge)
      : 0;

    // Axis max: use t95 (window) or path_t95 (cohort). Fall back to observed max.
    // IMPORTANT: if latencyMax would clip ALL non-zero data, extend to observed max instead.
    const latencyMax = axisMode === 'window'
      ? (t95Max !== null && Number.isFinite(t95Max) && t95Max > 0 ? t95Max : null)
      : (pathT95Max !== null && Number.isFinite(pathT95Max) && pathT95Max > 0 ? pathT95Max : null);

    const axisMax = (() => {
      if (latencyMax !== null) {
        // If latency max would hide all non-zero points, extend to observed max.
        if (minNonZeroAge !== null && latencyMax < minNonZeroAge) {
          return maxAge !== null ? Math.max(minNonZeroAge, maxAge) : minNonZeroAge;
        }
        return latencyMax;
      }
      if (maxAge !== null && Number.isFinite(maxAge)) return Math.max(0, maxAge);
      return null;
    })();

    return { origin, axisMin, axisMax };
  }, [filteredRows, axisMode, result]);

  // ──────────────────────────────────────────────────────────────
  // SERIES BUILDER
  //
  // n = 0
  // for date D in DATE_RANGE:
  //   plot maturity(D) at x = n
  //   n++
  //
  // That's it. x = as_at_date - origin.  Clip at axisMax.
  // ──────────────────────────────────────────────────────────────
  const series = useMemo(() => {
    const origin = xAxisMeta.origin;
    const byScenario = new Map<string, Array<{ asAt: string; ageDays: number; rate: number | null; phase: string }>>();

    for (const r of filteredRows) {
      const scenarioId = String(r?.scenario_id);
      const asAt = String(r?.as_at_date);
      const rate = (r?.rate === null || r?.rate === undefined) ? null : Number(r.rate);
      const phase = String(r?.cohort_phase || 'incomplete');

      if (!scenarioId || !asAt || !origin) continue;
      const ageDays = dayDiffUTC(asAt, origin);
      if (ageDays === null || !Number.isFinite(ageDays)) continue;
      if (ageDays < 0) continue; // before origin — skip
      // Clip at axis max (t95 / path_t95).
      if (xAxisMeta.axisMax !== null && Number.isFinite(xAxisMeta.axisMax) && ageDays > xAxisMeta.axisMax) continue;

      if (!byScenario.has(scenarioId)) byScenario.set(scenarioId, []);
      byScenario.get(scenarioId)!.push({
        asAt,
        ageDays,
        rate: Number.isFinite(rate as any) ? (rate as number) : null,
        phase,
      });
    }

    const out: any[] = [];
    for (const scenarioId of Array.from(byScenario.keys()).sort()) {
      const name = scenarioMeta?.[scenarioId]?.name || scenarioId;
      const colour = scenarioMeta?.[scenarioId]?.colour;
      const points = (byScenario.get(scenarioId) || []).slice().sort((a, b) => a.ageDays - b.ageDays);

      type P = { asAt: string; ageDays: number; rate: number | null; phase: string };

      const phasePoints = (phase: string): P[] => points.filter((p) => p.phase === phase);
      const withContiguousBoundary = (prev: P[], next: P[]): P[] => {
        if (prev.length === 0 || next.length === 0) return next;
        const prevLast = prev[prev.length - 1];
        const nextFirst = next[0];
        if (prevLast.ageDays < nextFirst.ageDays) return [prevLast, ...next];
        return next;
      };

      const incomplete = phasePoints('incomplete');
      const maturingRaw = phasePoints('maturing');
      const closedRaw = phasePoints('closed');
      const maturing = withContiguousBoundary(incomplete, maturingRaw);
      const closed = withContiguousBoundary(maturingRaw.length > 0 ? maturingRaw : incomplete, closedRaw);

      const mkSeries = (lineType: 'solid' | 'dashed' | 'dotted', dataPoints: P[]) => {
        const data = dataPoints.map((p) => ({
          value: [p.ageDays, p.rate],
          asAt: p.asAt,
          ageDays: p.ageDays,
        }));
        if (data.length === 0) return null;
        return {
          name,
          type: 'line',
          showSymbol: data.length <= 12,
          symbolSize: 6,
          smooth: false,
          connectNulls: false,
          lineStyle: { width: 2, color: colour, type: lineType },
          itemStyle: { color: colour },
          emphasis: { focus: 'series' },
          data,
        };
      };

      const sIncomplete = mkSeries('dotted', incomplete);
      const sMaturing = mkSeries('dashed', maturing);
      const sClosed = mkSeries('solid', closed);
      if (sIncomplete) out.push(sIncomplete);
      if (sMaturing) out.push(sMaturing);
      if (sClosed) out.push(sClosed);
    }
    return out;
  }, [filteredRows, scenarioMeta, xAxisMeta.origin, xAxisMeta.axisMax]);

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
          const ageRaw = first?.value?.[0];
          const ageDays = typeof ageRaw === 'number' ? ageRaw : Number(ageRaw);
          const anyAsAt = first?.data?.asAt ? String(first.data.asAt) : '';
          const title = Number.isFinite(ageDays)
            ? `Δ ${ageDays} day(s) · ${formatDate_d_MMM_yy(anyAsAt)}`
            : formatDate_d_MMM_yy(anyAsAt);
          const lines = items.map((it: any) => {
            const scenarioName = it?.seriesName || 'Scenario';
            const rate = it?.value?.[1];
            return `${scenarioName}: <strong>${formatPercent(rate)}</strong>`;
          });
          return `<strong>${title}</strong><br/>${lines.join('<br/>')}`;
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
        name: `Days since ${fromNodeLabel || 'start'}`,
        nameLocation: 'middle' as const,
        nameGap: 30,
        min: xAxisMeta.axisMin,
        ...(xAxisMeta.axisMax !== null && Number.isFinite(xAxisMeta.axisMax) ? { max: xAxisMeta.axisMax } : {}),
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
  }, [result, series, effectiveSubjectId, fromNodeLabel, xAxisMeta.axisMin, xAxisMeta.axisMax]);

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
