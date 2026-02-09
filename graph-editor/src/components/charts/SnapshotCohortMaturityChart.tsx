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

  const series = useMemo(() => {
    const byScenario = new Map<string, Array<{ asAt: string; rate: number | null; x: number; y: number }>>();
    for (const r of filteredRows) {
      const scenarioId = String(r?.scenario_id);
      const asAt = String(r?.as_at_date);
      const rate = (r?.rate === null || r?.rate === undefined) ? null : Number(r.rate);
      const x = Number(r?.x ?? 0);
      const y = Number(r?.y ?? 0);
      if (!scenarioId || !asAt) continue;
      if (!byScenario.has(scenarioId)) byScenario.set(scenarioId, []);
      byScenario.get(scenarioId)!.push({
        asAt,
        rate: Number.isFinite(rate as any) ? (rate as number) : null,
        x: Number.isFinite(x) ? x : 0,
        y: Number.isFinite(y) ? y : 0,
      });
    }

    const out: any[] = [];
    const scenarios = Array.from(byScenario.keys()).sort();
    for (const scenarioId of scenarios) {
      const points = (byScenario.get(scenarioId) || []).slice().sort((a, b) => a.asAt.localeCompare(b.asAt));
      const name = scenarioMeta?.[scenarioId]?.name || scenarioId;
      const colour = scenarioMeta?.[scenarioId]?.colour;

      out.push({
        name,
        type: 'line',
        showSymbol: points.length <= 12,
        symbolSize: 6,
        smooth: false,
        connectNulls: false,
        lineStyle: { width: 2, color: colour },
        itemStyle: { color: colour },
        emphasis: { focus: 'series' },
        data: points.map(p => [p.asAt, p.rate]),
      });
    }
    return out;
  }, [filteredRows, scenarioMeta]);

  const option = useMemo(() => {
    // Compute Y-axis max from data with headroom, rounded to a clean percentage
    let maxRate = 0;
    for (const s of series) {
      for (const d of s.data) {
        const v = d?.[1];
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
          const asAtRaw = first?.value?.[0];
          const asAt = typeof asAtRaw === 'number'
            ? new Date(asAtRaw).toISOString().slice(0, 10)
            : String(asAtRaw || '');
          const title = formatDate_d_MMM_yy(asAt);
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
        type: 'time',
        name: 'As-at',
        nameLocation: 'middle' as const,
        nameGap: 30,
        axisLabel: {
          fontSize: 10,
          rotate: 30,
          formatter: (value: number) => {
            const d = new Date(value);
            if (Number.isNaN(d.getTime())) return '';
            const day = d.getUTCDate();
            const month = d.toLocaleDateString('en-GB', { month: 'short', timeZone: 'UTC' });
            return `${day}-${month}`;
          },
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
  }, [result, series, effectiveSubjectId]);

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
