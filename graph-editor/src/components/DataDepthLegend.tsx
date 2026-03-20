/**
 * DataDepthLegend — floating colour-scale legend shown when the
 * Data Depth overlay is active.  Displays a continuous gradient
 * bar from 0 % (red) to 100 % (blue), plus a "No data" swatch.
 */

import React from 'react';
import { depthToColour, noDataColour } from '../services/dataDepthService';

interface Props {
  theme: 'light' | 'dark';
  loading?: boolean;
}

/** Number of discrete gradient stops rendered in the bar. */
const GRADIENT_STEPS = 20;

export function DataDepthLegend({ theme, loading }: Props) {
  // Build gradient stops
  const stops: string[] = [];
  for (let i = 0; i <= GRADIENT_STEPS; i++) {
    const t = i / GRADIENT_STEPS;
    stops.push(depthToColour(t, theme));
  }

  return (
    <div style={containerStyle}>
      <div style={titleStyle}>
        Data Depth
        {loading && <span style={loadingStyle}> loading…</span>}
      </div>

      {/* Continuous gradient bar */}
      <div style={gradientRowStyle}>
        <span style={endLabelStyle}>0%</span>
        <div style={gradientBarStyle}>
          {stops.map((colour, i) => (
            <div
              key={i}
              style={{
                flex: 1,
                height: '100%',
                background: colour,
              }}
            />
          ))}
        </div>
        <span style={endLabelStyle}>100%</span>
      </div>

      {/* No data swatch */}
      <div style={itemStyle}>
        <span style={{ ...swatchStyle, background: noDataColour(theme) }} />
        <span style={labelStyle}>No data</span>
      </div>
    </div>
  );
}

// ── Inline styles ──────────────────────────────────────────

const containerStyle: React.CSSProperties = {
  position: 'absolute',
  bottom: 12,
  left: 12,
  background: 'var(--bg-primary, #1e1e1e)',
  border: '1px solid var(--border-primary, #333)',
  borderRadius: 6,
  padding: '8px 12px',
  fontSize: 11,
  lineHeight: '18px',
  color: 'var(--text-primary, #ccc)',
  zIndex: 10,
  pointerEvents: 'auto',
  minWidth: 140,
  boxShadow: '0 2px 8px rgba(0,0,0,0.3)',
};

const titleStyle: React.CSSProperties = {
  fontWeight: 600,
  marginBottom: 6,
  fontSize: 11,
  textTransform: 'uppercase',
  letterSpacing: '0.5px',
  opacity: 0.7,
};

const loadingStyle: React.CSSProperties = {
  fontWeight: 400,
  textTransform: 'none',
  letterSpacing: 'normal',
  opacity: 0.5,
  fontStyle: 'italic',
};

const gradientRowStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 4,
  marginBottom: 4,
};

const gradientBarStyle: React.CSSProperties = {
  display: 'flex',
  flex: 1,
  height: 10,
  borderRadius: 2,
  overflow: 'hidden',
};

const endLabelStyle: React.CSSProperties = {
  fontSize: 10,
  opacity: 0.6,
  whiteSpace: 'nowrap',
};

const itemStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 6,
  padding: '1px 0',
};

const swatchStyle: React.CSSProperties = {
  display: 'inline-block',
  width: 14,
  height: 10,
  borderRadius: 2,
  flexShrink: 0,
};

const labelStyle: React.CSSProperties = {
  whiteSpace: 'nowrap',
};
