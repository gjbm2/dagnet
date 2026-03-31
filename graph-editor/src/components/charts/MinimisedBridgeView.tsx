/**
 * MinimisedBridgeView — compact canvas indicator for the Bridge View chart.
 *
 * Shows a green up-arrow or red down-arrow with the percentage change,
 * like a stock market report. Returns null when no result data is available.
 */

import React from 'react';

interface MinimisedBridgeViewProps {
  result: any;
  settings: Record<string, any>;
  label?: string;
}

export function MinimisedBridgeView({ result, label }: MinimisedBridgeViewProps): React.ReactElement | null {
  if (!result?.data || !Array.isArray(result.data)) return null;

  const rows = result.data as Array<{ kind?: string; total?: number | null; delta?: number | null }>;
  const startRow = rows.find(r => r.kind === 'start');
  const endRow = rows.find(r => r.kind === 'end');
  if (!startRow?.total || !endRow?.total) return null;

  const startTotal = startRow.total;
  const endTotal = endRow.total;
  const netDelta = endTotal - startTotal;

  const isPositive = netDelta >= 0;
  const colour = isPositive ? '#10b981' : '#ef4444';
  const arrow = isPositive ? '↑' : '↓';

  // Format percentage with adaptive decimals
  const absDeltaPct = Math.abs(netDelta * 100);
  const decimals = absDeltaPct >= 1 ? 1 : 2;
  const sign = isPositive ? '+' : '-';
  const pctLabel = `${sign}${absDeltaPct.toFixed(decimals)}%`;

  const displayLabel = label || 'Bridge';

  return (
    <div style={{
      display: 'flex',
      alignItems: 'center',
      gap: 5,
      padding: '4px 8px',
      width: '100%',
      height: '100%',
      boxSizing: 'border-box',
    }}>
      {/* Direction arrow */}
      <div style={{
        fontSize: 20,
        lineHeight: 1,
        color: colour,
        fontWeight: 'bold',
        flexShrink: 0,
      }}>
        {arrow}
      </div>

      {/* Percentage change */}
      <div style={{
        fontSize: 13,
        lineHeight: 1,
        color: colour,
        fontWeight: 600,
        flexShrink: 0,
        fontVariantNumeric: 'tabular-nums',
      }}>
        {pctLabel}
      </div>

      {/* Label — line-wraps within available space */}
      <div style={{
        fontSize: 10,
        lineHeight: 1.25,
        color: 'var(--canvas-analysis-title, #374151)',
        overflow: 'hidden',
        display: '-webkit-box',
        WebkitLineClamp: 2,
        WebkitBoxOrient: 'vertical',
        wordBreak: 'break-word',
        flexShrink: 1,
        minWidth: 0,
      }}>
        {displayLabel}
      </div>
    </div>
  );
}
