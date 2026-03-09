/**
 * LagFitChart
 *
 * Visualises the fitted log-normal lag distribution alongside observed
 * cohort completeness, so you can assess how well the model fits reality.
 *
 *   Bar (grey):            discretized PMF (daily probability mass) — right y-axis
 *   Line (orange solid):   fitted CDF — left y-axis (0–1 fraction)
 *   Scatter (blue dots):   observed cohort completeness k/(n·p∞) — left y-axis
 *   markLine (dashed):     median lag and t95
 */

import React, { useMemo } from 'react';
import ReactECharts from 'echarts-for-react';
import { useTheme } from '../../contexts/ThemeContext';
import type { AnalysisResult } from '../../lib/graphComputeClient';

interface Props {
  result: AnalysisResult;
  height?: number;
}

function fmt2(v: number): string {
  return v.toFixed(2);
}

function fmtPct(v: number): string {
  return (v * 100).toFixed(1) + '%';
}

export function LagFitChart({ result, height = 380 }: Props): JSX.Element {
  const { theme: currentTheme } = useTheme();
  const dark = currentTheme === 'dark';

  const textColour = dark ? '#d1d5db' : '#374151';
  const gridColour = dark ? '#374151' : '#e5e7eb';
  const tooltipBg = dark ? '#1f2937' : '#ffffff';

  // Unpack rows from result.data
  const { meta, curveRows, cohortRows } = useMemo(() => {
    const rows = result.data ?? [];
    const metaRow = rows.find(r => r.row_type === 'meta');
    return {
      meta: metaRow ?? null,
      curveRows: rows.filter(r => r.row_type === 'curve'),
      cohortRows: rows.filter(r => r.row_type === 'cohort'),
    };
  }, [result.data]);

  const option = useMemo(() => {
    if (!meta || curveRows.length === 0) return {};

    const { t95, median, p_infinity, edge_label } = meta;

    const tValues = curveRows.map(r => r.t as number);
    const pdfValues = curveRows.map(r => r.pdf as number);
    const cdfValues = curveRows.map(r => r.cdf as number);

    const ORANGE = '#f97316';
    const BLUE_SCATTER = '#3b82f6';
    const GREY_BAR = dark ? '#6b7280' : '#9ca3af';

    // Scatter: [age, observed_cdf]
    const scatterData = cohortRows.map(r => ({
      value: [r.age as number, r.observed_cdf as number],
      n: r.n as number,
      k: r.k as number,
      date: r.date as string,
    }));

    const markLines: any[] = [];
    if (Number.isFinite(median) && median > 0) {
      markLines.push({
        xAxis: Math.round(median),
        lineStyle: { color: ORANGE, type: 'dashed', width: 1, opacity: 0.7 },
        label: { show: true, formatter: `med ${median.toFixed(1)}d`, color: ORANGE, fontSize: 10, position: 'start' },
      });
    }
    if (Number.isFinite(t95) && t95 > 0) {
      markLines.push({
        xAxis: Math.round(t95),
        lineStyle: { color: '#6b7280', type: 'dashed', width: 1, opacity: 0.6 },
        label: { show: true, formatter: `t95 ${t95.toFixed(1)}d`, color: '#6b7280', fontSize: 10, position: 'end' },
      });
    }

    return {
      backgroundColor: 'transparent',
      grid: { top: 32, right: 60, bottom: 60, left: 52, containLabel: false },
      xAxis: {
        type: 'value',
        name: 'Lag (days)',
        nameTextStyle: { color: textColour, fontSize: 11 },
        min: 0,
        max: tValues[tValues.length - 1] ?? 100,
        axisLabel: { color: textColour, fontSize: 11 },
        axisLine: { lineStyle: { color: gridColour } },
        splitLine: { lineStyle: { color: gridColour } },
      },
      yAxis: [
        {
          // Left: CDF / observed (0–1)
          type: 'value',
          name: 'Cumulative fraction',
          nameTextStyle: { color: textColour, fontSize: 11 },
          min: 0,
          max: 1,
          axisLabel: {
            color: textColour,
            fontSize: 11,
            formatter: (v: number) => fmtPct(v),
          },
          axisLine: { show: false },
          splitLine: { lineStyle: { color: gridColour } },
        },
        {
          // Right: PDF (daily probability mass)
          type: 'value',
          name: 'Daily PDF',
          nameTextStyle: { color: GREY_BAR, fontSize: 11 },
          position: 'right',
          axisLabel: {
            color: GREY_BAR,
            fontSize: 11,
            formatter: (v: number) => v.toFixed(3),
          },
          axisLine: { show: false },
          splitLine: { show: false },
        },
      ],
      tooltip: {
        trigger: 'axis',
        axisPointer: { type: 'line' },
        backgroundColor: tooltipBg,
        borderColor: gridColour,
        textStyle: { color: textColour, fontSize: 12 },
        formatter: (params: any[]) => {
          if (!params?.length) return '';
          const t = params[0]?.axisValue ?? '';
          let html = `<div style="font-weight:600;margin-bottom:4px">Day ${t}</div>`;
          for (const p of params) {
            if (p.value === null || p.value === undefined) continue;
            const val = Array.isArray(p.value) ? p.value[1] : p.value;
            const dot = `<span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${p.color};margin-right:5px;vertical-align:middle"></span>`;
            let formatted = '';
            if (p.seriesName === 'PDF (daily)') formatted = fmt2(Number(val));
            else formatted = fmtPct(Number(val));
            html += `<div>${dot}${p.seriesName}: <b>${formatted}</b></div>`;
          }
          return html;
        },
      },
      legend: {
        bottom: 0,
        textStyle: { color: textColour, fontSize: 11 },
        data: ['PDF (daily)', 'Fitted CDF', 'Observed completeness'],
      },
      series: [
        {
          id: 'pdf',
          name: 'PDF (daily)',
          type: 'bar',
          yAxisIndex: 1,
          data: tValues.map((t, i) => [t, pdfValues[i]]),
          barWidth: '80%',
          itemStyle: { color: GREY_BAR, opacity: 0.6 },
          emphasis: { itemStyle: { opacity: 1 } },
          markLine: markLines.length
            ? { silent: true, symbol: 'none', data: markLines }
            : undefined,
        },
        {
          id: 'cdf',
          name: 'Fitted CDF',
          type: 'line',
          yAxisIndex: 0,
          data: tValues.map((t, i) => [t, cdfValues[i]]),
          showSymbol: false,
          smooth: false,
          lineStyle: { color: ORANGE, width: 2.5 },
          itemStyle: { color: ORANGE },
        },
        {
          id: 'observed',
          name: 'Observed completeness',
          type: 'scatter',
          yAxisIndex: 0,
          data: scatterData,
          symbolSize: 7,
          itemStyle: { color: BLUE_SCATTER, opacity: 0.85 },
          emphasis: { itemStyle: { opacity: 1 } },
          tooltip: {
            formatter: (p: any) => {
              const [age, obs] = p.value;
              return [
                `<b>Age ${age} days</b>`,
                `Observed: ${fmtPct(obs)}`,
                `n=${p.data.n}, k=${p.data.k}`,
                p.data.date,
              ].join('<br/>');
            },
          },
        },
      ],
    };
  }, [meta, curveRows, cohortRows, dark, textColour, gridColour, tooltipBg]);

  if (!meta) {
    return (
      <div style={{ padding: '24px 16px', color: '#6b7280', fontSize: 13, textAlign: 'center' }}>
        No lag fit data available for this edge.
      </div>
    );
  }

  const { edge_label, mu, sigma, t95, median, p_infinity } = meta;

  return (
    <div>
      <div style={{ marginBottom: 6, lineHeight: 1.5 }}>
        <span style={{ fontSize: 13, color: textColour, fontWeight: 600 }}>{edge_label}</span>
        <span style={{ fontSize: 11, color: dark ? '#9ca3af' : '#6b7280', marginLeft: 12 }}>
          p∞ = {(p_infinity * 100).toFixed(1)}%
          {' · '}median = {Number(median).toFixed(1)} d
          {' · '}t95 = {Number(t95).toFixed(1)} d
          {' · '}μ = {Number(mu).toFixed(3)}
          {' · '}σ = {Number(sigma).toFixed(3)}
        </span>
      </div>
      <ReactECharts
        option={option}
        style={{ height, width: '100%' }}
        opts={{ renderer: 'canvas' }}
        notMerge
      />
    </div>
  );
}
