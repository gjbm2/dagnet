/**
 * SnapshotDailyConversionsChart
 * 
 * Renders a time-series bar chart showing conversions by calendar date.
 */

import React, { useMemo } from 'react';
import ReactECharts from 'echarts-for-react';
import type { DailyConversionsResult } from '../../lib/graphComputeClient';

interface Props {
  data: DailyConversionsResult;
  height?: number;
}

export function SnapshotDailyConversionsChart({ data, height = 300 }: Props): JSX.Element {
  // Detect gaps in calendar dates
  const gapInfo = useMemo(() => {
    if (data.data.length < 2 || !data.date_range.from || !data.date_range.to) return null;
    const startDate = new Date(data.date_range.from);
    const endDate = new Date(data.date_range.to);
    const expectedDays = Math.floor((endDate.getTime() - startDate.getTime()) / (1000 * 60 * 60 * 24)) + 1;
    const actualDays = data.data.length;
    const missingDays = expectedDays - actualDays;
    if (missingDays > 0) {
      return { missingDays, expectedDays, actualDays };
    }
    return null;
  }, [data.data, data.date_range]);

  const option = useMemo(() => {
    const dates = data.data.map(d => d.date);
    const conversions = data.data.map(d => d.conversions);
    
    // Format dates for display (d-MMM)
    const formatDate = (dateStr: string) => {
      const date = new Date(dateStr);
      const day = date.getDate();
      const month = date.toLocaleDateString('en-GB', { month: 'short' });
      return `${day}-${month}`;
    };
    
    return {
      tooltip: {
        trigger: 'axis',
        axisPointer: { type: 'shadow' },
        formatter: (params: any) => {
          const item = params[0];
          const dataItem = data.data[item.dataIndex];
          const formattedDate = new Date(dataItem.date).toLocaleDateString('en-GB', {
            day: 'numeric',
            month: 'short',
            year: 'numeric',
          });
          return `
            <strong>${formattedDate}</strong><br/>
            Conversions: ${dataItem.conversions.toLocaleString()}
          `;
        },
      },
      grid: {
        left: '3%',
        right: '4%',
        bottom: '15%',
        top: 40,
        containLabel: true,
      },
      xAxis: {
        type: 'category',
        data: dates.map(formatDate),
        name: 'Date',
        nameLocation: 'middle',
        nameGap: 45,
        axisLabel: {
          fontSize: 10,
          rotate: dates.length > 14 ? 45 : 0,
          interval: dates.length > 30 ? Math.floor(dates.length / 15) : 0,
        },
      },
      yAxis: {
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
      series: [
        {
          name: 'Conversions',
          type: 'bar',
          data: conversions,
          itemStyle: {
            color: '#10b981',
            borderRadius: [2, 2, 0, 0],
          },
        },
      ],
    };
  }, [data]);

  // Format date range for display
  const formatDateRange = () => {
    if (!data.date_range.from || !data.date_range.to) return '';
    const from = new Date(data.date_range.from).toLocaleDateString('en-GB', {
      day: 'numeric', month: 'short', year: 'numeric',
    });
    const to = new Date(data.date_range.to).toLocaleDateString('en-GB', {
      day: 'numeric', month: 'short', year: 'numeric',
    });
    return `${from} – ${to}`;
  };

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
        <span>{formatDateRange()}</span>
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
            ({gapInfo.actualDays} of {gapInfo.expectedDays} days in range have data)
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
