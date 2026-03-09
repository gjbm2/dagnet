/**
 * DailyProjectionChart
 *
 * ECharts bar+line chart showing observed k/day vs. model-expected k/day,
 * plus a forward projection tail from in-flight cohorts.
 *
 *   Bar (grey):         observed k_daily (historical only)
 *   Line (orange solid): model-expected k/day from convolution (historical)
 *   Line (orange dashed + area): forward projection (future dates)
 *   markLine:           today
 */

import React, { useMemo } from 'react';
import ReactECharts from 'echarts-for-react';
import { useTheme } from '../../contexts/ThemeContext';
import type { ProjectionPoint } from '../../services/projectionService';

interface Props {
  points: ProjectionPoint[];
  edgeLabel: string;
  pInfinity: number;
  t95: number;
  height?: number;
}

function fmt1(v: number): string {
  return v.toFixed(1);
}

export function DailyProjectionChart({ points, edgeLabel, pInfinity, t95, height = 380 }: Props): JSX.Element {
  const { theme: currentTheme } = useTheme();
  const dark = currentTheme === 'dark';

  const textColour = dark ? '#d1d5db' : '#374151';
  const gridColour = dark ? '#374151' : '#e5e7eb';
  const tooltipBg = dark ? '#1f2937' : '#ffffff';

  const option = useMemo(() => {
    if (points.length === 0) return {};

    const dates = points.map(p => p.date);
    const todayIdx = points.findIndex(p => !p.isFuture && (points[points.indexOf(p) + 1]?.isFuture ?? false));
    // fallback: last non-future index
    const firstFutureIdx = points.findIndex(p => p.isFuture);
    const todayDate = firstFutureIdx > 0 ? points[firstFutureIdx - 1].date : null;

    // Observed k — only non-future points with data
    const observedData = points.map(p =>
      p.isFuture || p.kObserved === undefined ? null : p.kObserved
    );

    // Model expected line (historical portion — solid)
    const expectedHistoricalData = points.map(p =>
      p.isFuture ? null : p.kExpected
    );

    // Model expected line (future portion — dashed + area fill)
    // We overlap one point at the boundary so the line is continuous
    const expectedFutureData = points.map((p, i) => {
      if (p.isFuture) return p.kExpected;
      // include the last historical point as the join
      if (firstFutureIdx > 0 && i === firstFutureIdx - 1) return p.kExpected;
      return null;
    });

    const ORANGE = '#f97316';
    const ORANGE_LIGHT = 'rgba(249, 115, 22, 0.18)';
    const GREY_BAR = dark ? '#6b7280' : '#9ca3af';

    const markLines: any[] = [];
    if (todayDate) {
      markLines.push({
        xAxis: todayDate,
        lineStyle: { color: '#3b82f6', type: 'dashed', width: 1.5 },
        label: { show: true, formatter: 'Today', color: '#3b82f6', fontSize: 11 },
      });
    }

    return {
      backgroundColor: 'transparent',
      grid: { top: 40, right: 20, bottom: 60, left: 52, containLabel: false },
      xAxis: {
        type: 'category',
        data: dates,
        axisLabel: {
          color: textColour,
          fontSize: 11,
          interval: Math.max(0, Math.floor(dates.length / 10) - 1),
          rotate: 30,
        },
        axisLine: { lineStyle: { color: gridColour } },
        splitLine: { show: false },
      },
      yAxis: {
        type: 'value',
        name: 'k / day',
        nameTextStyle: { color: textColour, fontSize: 11 },
        axisLabel: { color: textColour, fontSize: 11, formatter: (v: number) => fmt1(v) },
        axisLine: { show: false },
        splitLine: { lineStyle: { color: gridColour } },
        min: 0,
      },
      tooltip: {
        trigger: 'axis',
        backgroundColor: tooltipBg,
        borderColor: gridColour,
        textStyle: { color: textColour, fontSize: 12 },
        formatter: (params: any[]) => {
          const date = params[0]?.axisValue ?? '';
          let html = `<div style="font-weight:600;margin-bottom:4px">${date}</div>`;
          for (const p of params) {
            if (p.value === null || p.value === undefined) continue;
            const dot = `<span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${p.color};margin-right:5px;vertical-align:middle"></span>`;
            html += `<div>${dot}${p.seriesName}: <b>${fmt1(Number(p.value))}</b></div>`;
          }
          return html;
        },
      },
      legend: {
        bottom: 0,
        textStyle: { color: textColour, fontSize: 11 },
        data: ['Observed', 'Expected (historical)', 'Expected (projection)'],
      },
      series: [
        {
          id: 'observed',
          name: 'Observed',
          type: 'bar',
          data: observedData,
          barMaxWidth: 14,
          itemStyle: { color: GREY_BAR, opacity: 0.75 },
          emphasis: { itemStyle: { opacity: 1 } },
        },
        {
          id: 'expected-hist',
          name: 'Expected (historical)',
          type: 'line',
          data: expectedHistoricalData,
          showSymbol: false,
          smooth: false,
          connectNulls: false,
          lineStyle: { color: ORANGE, width: 2, type: 'solid' },
          itemStyle: { color: ORANGE },
          markLine: markLines.length
            ? { silent: true, symbol: 'none', data: markLines }
            : undefined,
        },
        {
          id: 'expected-future',
          name: 'Expected (projection)',
          type: 'line',
          data: expectedFutureData,
          showSymbol: false,
          smooth: false,
          connectNulls: false,
          lineStyle: { color: ORANGE, width: 2, type: 'dashed', opacity: 0.8 },
          itemStyle: { color: ORANGE, opacity: 0.8 },
          areaStyle: { color: ORANGE_LIGHT },
        },
      ],
    };
  }, [points, dark, textColour, gridColour, tooltipBg]);

  if (points.length === 0) {
    return (
      <div style={{ padding: '24px 16px', color: '#6b7280', fontSize: 13, textAlign: 'center' }}>
        No projection data available for this edge.
      </div>
    );
  }

  return (
    <div>
      <div style={{ marginBottom: 8 }}>
        <span style={{ fontSize: 13, color: textColour, fontWeight: 600 }}>{edgeLabel}</span>
        <span style={{ fontSize: 12, color: dark ? '#9ca3af' : '#6b7280', marginLeft: 12 }}>
          p∞ = {(pInfinity * 100).toFixed(1)}% · t95 = {t95.toFixed(1)} days
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
