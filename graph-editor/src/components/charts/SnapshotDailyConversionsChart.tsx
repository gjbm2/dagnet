/**
 * SnapshotDailyConversionsChart
 *
 * Dual-axis time-series chart:
 *   - Left Y-axis: bar chart showing N (cohort size / from-step count)
 *   - Right Y-axis: line chart showing conversion rate (Y/X %)
 *
 * Supports two display modes:
 *   - Multiple scenarios → one bar+line pair per scenario for a given edge/subject
 *   - Single scenario, multiple edges → one bar+line pair per edge
 *
 * Input: a normalised AnalysisResult where `data` contains rows:
 * { scenario_id, subject_id, date, x, y, rate }
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
  /** When true, the chart stretches to fill its parent container via CSS. */
  fillHeight?: boolean;
  queryDsl?: string;
  source?: {
    parent_file_id?: string;
    parent_tab_id?: string;
    query_dsl?: string;
    analysis_type?: string;
  };
  /** Hide the "Open as tab" button (e.g. when already in a chart tab) */
  hideOpenAsTab?: boolean;
}

function formatDate_d_MMM(dateStr: string): string {
  const d = new Date(dateStr);
  if (Number.isNaN(d.getTime())) return dateStr;
  const day = d.getDate();
  const month = d.toLocaleDateString('en-GB', { month: 'short' });
  return `${day}-${month}`;
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

function formatCount(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—';
  return v.toLocaleString();
}

// Default palette — only used when no scenario/subject colour is provided.
const PALETTE = ['#3b82f6', '#ef4444', '#10b981', '#f59e0b', '#8b5cf6', '#ec4899', '#06b6d4', '#84cc16'];

/** Return a washed-out version of a hex colour for background bars. */
function toBarFill(hex: string): string {
  const num = parseInt(hex.replace('#', ''), 16);
  // Mix 70% toward white to get a very light tint.
  const mix = 0.70;
  const r = Math.min(255, Math.round(((num >> 16) & 0xff) + (255 - ((num >> 16) & 0xff)) * mix));
  const g = Math.min(255, Math.round(((num >> 8) & 0xff) + (255 - ((num >> 8) & 0xff)) * mix));
  const b = Math.min(255, Math.round((num & 0xff) + (255 - (num & 0xff)) * mix));
  return `#${((1 << 24) + (r << 16) + (g << 8) + b).toString(16).slice(1)}`;
}

export function SnapshotDailyConversionsChart({ result, visibleScenarioIds, height = 340, fillHeight = false, queryDsl, source, hideOpenAsTab = false }: Props): JSX.Element {
  const rows = Array.isArray(result?.data) ? result.data : [];

  if (rows.length === 0) {
    const isEmpty = result?.metadata?.empty === true;
    return (
      <div style={{ padding: '24px 16px', color: '#6b7280', fontSize: 13, textAlign: 'center' }}>
        <p style={{ marginBottom: 8, fontWeight: 600, color: '#374151' }}>No daily conversion data</p>
        <p style={{ margin: 0 }}>
          {isEmpty
            ? 'No snapshot data was found in the database for this parameter and date range. Ensure snapshots have been written for the selected edge/parameter.'
            : 'The analysis returned no data rows. Check that the selected query has associated snapshot data.'}
        </p>
      </div>
    );
  }

  // ── Dimension discovery ──────────────────────────────────────────────
  const scenarioIds = useMemo(() => {
    const s = new Set<string>();
    for (const r of rows) if (r?.scenario_id) s.add(String(r.scenario_id));
    return Array.from(s);
  }, [rows]);

  const subjectIds = useMemo(() => {
    const s = new Set<string>();
    for (const r of rows) if (r?.subject_id) s.add(String(r.subject_id));
    return Array.from(s);
  }, [rows]);

  const multiScenario = scenarioIds.length > 1;
  const multiSubject = subjectIds.length > 1;

  const [selectedSubjectId, setSelectedSubjectId] = useState<string>(() => subjectIds[0] || 'subject');
  const effectiveSubjectId = subjectIds.includes(selectedSubjectId) ? selectedSubjectId : (subjectIds[0] || 'subject');

  const scenarioMeta = (result?.dimension_values as any)?.scenario_id || {};
  const subjectMeta = (result?.dimension_values as any)?.subject_id || {};

  // ── Row filtering ────────────────────────────────────────────────────
  const filteredRows = useMemo(() => {
    let filtered = rows;
    filtered = filtered.filter(r => visibleScenarioIds.includes(String(r?.scenario_id)));
    if (multiScenario) {
      filtered = filtered.filter(r => String(r?.subject_id) === effectiveSubjectId);
    }
    return filtered;
  }, [rows, visibleScenarioIds, multiScenario, effectiveSubjectId]);

  // ── Build dual series (bar N + line rate) per group ──────────────────
  const { allSeries, maxN } = useMemo(() => {
    const seriesKey = multiScenario ? 'scenario_id' : 'subject_id';
    const meta = multiScenario ? scenarioMeta : subjectMeta;

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

    const out: any[] = [];
    const keys = Array.from(byKey.keys()).sort();
    let maxNVal = 0;

    for (let i = 0; i < keys.length; i++) {
      const key = keys[i];
      const points = (byKey.get(key) || []).slice().sort((a, b) => a.date.localeCompare(b.date));
      const name = meta?.[key]?.name || key;
      // Strong colour from scenario/subject metadata; fallback to palette.
      const strongColour = meta?.[key]?.colour || PALETTE[i % PALETTE.length];
      const lightColour = toBarFill(strongColour);

      // Track max N for left axis scaling
      for (const p of points) {
        if (p.x > maxNVal) maxNVal = p.x;
      }

      // Bar series: N (cohort size) → left Y-axis (index 0) — light colour
      out.push({
        name: keys.length > 1 ? `${name} · N` : 'N',
        type: 'bar',
        yAxisIndex: 0,
        barMaxWidth: 24,
        itemStyle: {
          color: lightColour,
          borderRadius: [2, 2, 0, 0],
        },
        emphasis: { focus: 'series' },
        data: points.map(p => [p.date, p.x]),
      });

      // Line series: conversion rate → right Y-axis (index 1) — strong colour
      out.push({
        name: keys.length > 1 ? `${name} · Rate` : 'Conversion %',
        type: 'line',
        yAxisIndex: 1,
        showSymbol: points.length <= 20,
        symbolSize: 5,
        smooth: false,
        connectNulls: false,
        lineStyle: { width: 2.5, color: strongColour },
        itemStyle: { color: strongColour },
        emphasis: { focus: 'series' },
        data: points.map(p => [p.date, p.rate]),
      });
    }
    return { allSeries: out, maxN: maxNVal };
  }, [filteredRows, multiScenario, scenarioMeta, subjectMeta]);

  // ── ECharts option ───────────────────────────────────────────────────
  const option = useMemo(() => {
    // Rate axis max: 20% headroom, rounded to nearest 5%, clamped to 1.0
    let maxRate = 0;
    for (const s of allSeries) {
      if (s.type !== 'line') continue;
      for (const d of s.data) {
        const v = d?.[1];
        if (typeof v === 'number' && Number.isFinite(v) && v > maxRate) maxRate = v;
      }
    }
    const rateMax = Math.min(1.0, Math.max(0.05, Math.ceil((maxRate * 1.2) * 20) / 20));

    return {
      tooltip: {
        trigger: 'axis',
        axisPointer: { type: 'shadow' },
        formatter: (params: any) => {
          const items = Array.isArray(params) ? params : [params];
          const first = items[0];
          const dateRaw = first?.value?.[0];
          // ECharts time axis passes a numeric timestamp — convert to ISO string for formatting.
          const dateStr = typeof dateRaw === 'number'
            ? new Date(dateRaw).toISOString().slice(0, 10)
            : String(dateRaw || '');
          const title = formatDate_d_MMM_yy(dateStr);
          const lines = items.map((it: any) => {
            const seriesName = it?.seriesName || '';
            const val = it?.value?.[1];
            // Determine if this is a rate or count series from the yAxisIndex
            const isRate = it?.seriesIndex !== undefined && allSeries[it.seriesIndex]?.type === 'line';
            const formatted = isRate ? formatPercent(val) : formatCount(val);
            return `${it?.marker || ''} ${seriesName}: <strong>${formatted}</strong>`;
          });
          return `<strong>${title}</strong><br/>${lines.join('<br/>')}`;
        },
      },
      grid: {
        left: '3%',
        right: '4%',
        bottom: 60,
        top: allSeries.length > 2 ? 80 : 50,
        containLabel: true,
      },
      xAxis: {
        type: 'time',
        name: 'Cohort date',
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
      yAxis: [
        // Left axis: N (cohort size)
        {
          type: 'value',
          name: 'N',
          nameLocation: 'middle' as const,
          nameGap: 45,
          min: 0,
          axisLabel: {
            fontSize: 11,
            formatter: (value: number) => {
              if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
              if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
              return value.toString();
            },
          },
          splitLine: { lineStyle: { color: '#f3f4f6' } },
        },
        // Right axis: conversion rate %
        {
          type: 'value',
          name: 'Conversion %',
          nameLocation: 'middle' as const,
          nameGap: 50,
          min: 0,
          max: rateMax,
          axisLabel: {
            fontSize: 11,
            formatter: (v: number) => `${(v * 100).toFixed(0)}%`,
          },
          splitLine: { show: false },
        },
      ],
      legend: {
        top: 22,
        left: 12,
        textStyle: { fontSize: 11 },
        icon: 'roundRect',
      },
      series: allSeries,
    };
  }, [allSeries]);

  // ── Header ───────────────────────────────────────────────────────────
  const dateRange = result?.metadata?.date_range;
  const totalConversions = result?.metadata?.total_conversions;

  const headerRight = useMemo(() => {
    if (!dateRange?.from || !dateRange?.to) return '';
    return `${formatDate_d_MMM_yy(dateRange.from)} – ${formatDate_d_MMM_yy(dateRange.to)}`;
  }, [dateRange]);

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
          {totalConversions != null && (
            <span>
              <strong>{Number(totalConversions).toLocaleString()}</strong> conversions
            </span>
          )}
          {multiScenario && multiSubject && (
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
              title="Choose which edge/parameter to plot"
            >
              {subjectIds.map(id => (
                <option key={id} value={id}>
                  {subjectMeta?.[id]?.name || id}
                </option>
              ))}
            </select>
          )}
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
                  chartKind: 'analysis_daily_conversions',
                  analysisResult: result,
                  scenarioIds: visibleScenarioIds,
                  title: result.analysis_name
                    ? `Chart — ${result.analysis_name}`
                    : queryDsl
                      ? `Chart — ${queryDsl}`
                      : 'Chart — Daily Conversions',
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
