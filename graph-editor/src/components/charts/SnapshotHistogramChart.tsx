/**
 * SnapshotHistogramChart
 * 
 * Renders a bar chart showing conversion lag distribution from snapshot data.
 */

import React, { useMemo } from 'react';
import ReactECharts from 'echarts-for-react';
import type { LagHistogramResult } from '../../lib/graphComputeClient';

interface Props {
  data: LagHistogramResult;
  height?: number;
}

export function SnapshotHistogramChart({ data, height = 300 }: Props): JSX.Element {
  // Detect gaps in lag days (missing days between min and max)
  const gapInfo = useMemo(() => {
    if (data.data.length < 2) return null;
    const lagDays = data.data.map(d => d.lag_days).sort((a, b) => a - b);
    const minLag = lagDays[0];
    const maxLag = lagDays[lagDays.length - 1];
    const expectedDays = maxLag - minLag + 1;
    const actualDays = lagDays.length;
    const missingDays = expectedDays - actualDays;
    if (missingDays > 0) {
      return { missingDays, expectedDays, actualDays };
    }
    return null;
  }, [data.data]);

  const option = useMemo(() => {
    const lagDays = data.data.map(d => d.lag_days);
    const conversions = data.data.map(d => d.conversions);
    const percentages = data.data.map(d => d.pct * 100);
    
    return {
      tooltip: {
        trigger: 'axis',
        axisPointer: { type: 'shadow' },
        formatter: (params: any) => {
          const item = params[0];
          const dataItem = data.data[item.dataIndex];
          return `
            <strong>Lag: ${dataItem.lag_days} day${dataItem.lag_days !== 1 ? 's' : ''}</strong><br/>
            Conversions: ${dataItem.conversions.toLocaleString()}<br/>
            Percentage: ${(dataItem.pct * 100).toFixed(1)}%
          `;
        },
      },
      grid: {
        left: '3%',
        right: '4%',
        bottom: '3%',
        top: 40,
        containLabel: true,
      },
      xAxis: {
        type: 'category',
        data: lagDays,
        name: 'Lag (days)',
        nameLocation: 'middle',
        nameGap: 30,
        axisLabel: {
          fontSize: 11,
        },
      },
      yAxis: [
        {
          type: 'value',
          name: 'Conversions',
          nameLocation: 'middle',
          nameGap: 45,
          axisLabel: {
            fontSize: 11,
            formatter: (value: number) => {
              if (value >= 1000) return `${(value / 1000).toFixed(1)}k`;
              return value.toString();
            },
          },
        },
      ],
      series: [
        {
          name: 'Conversions',
          type: 'bar',
          data: conversions,
          itemStyle: {
            color: '#3b82f6',
            borderRadius: [2, 2, 0, 0],
          },
          label: {
            show: data.data.length <= 20,
            position: 'top',
            fontSize: 9,
            formatter: (params: any) => {
              const pct = percentages[params.dataIndex];
              return pct >= 1 ? `${pct.toFixed(0)}%` : '';
            },
          },
        },
      ],
    };
  }, [data]);

  return (
    <div style={{ width: '100%' }}>
      <div style={{ 
        padding: '8px 12px', 
        borderBottom: '1px solid #e5e7eb',
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        fontSize: 12,
        color: '#6b7280',
      }}>
        <span>
          <strong>{data.total_conversions.toLocaleString()}</strong> total conversions
        </span>
        <span>
          {data.cohorts_analysed} cohort{data.cohorts_analysed !== 1 ? 's' : ''} analysed
        </span>
      </div>
      {gapInfo && (
        <div style={{
          padding: '6px 12px',
          background: '#fef3c7',
          borderBottom: '1px solid #fbbf24',
          fontSize: 11,
          color: '#92400e',
          display: 'flex',
          alignItems: 'center',
          gap: 6,
        }}>
          <span>⚠</span>
          <span>
            Sparse data: {gapInfo.missingDays} day{gapInfo.missingDays !== 1 ? 's' : ''} with no conversions 
            ({gapInfo.actualDays} of {gapInfo.expectedDays} lag days have data)
          </span>
        </div>
      )}
      <ReactECharts
        option={option}
        style={{ height, width: '100%' }}
        opts={{ renderer: 'svg' }}
      />
    </div>
  );
}
