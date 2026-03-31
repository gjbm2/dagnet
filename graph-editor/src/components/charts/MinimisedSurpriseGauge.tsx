/**
 * MinimisedSurpriseGauge — compact mini-gauge for the canvas minimised state.
 *
 * White-faced semicircle dial with a thin outline, dark needle, and a
 * coloured indicator light at the pivot centre showing the zone colour.
 * Inverts in dark mode via CSS custom properties.
 * Optional ⚠ for non-Bayes data.
 *
 * Only renders for single-variable mode. Returns null for multi-variable
 * ('all') or when no result is available.
 */

import React from 'react';
import { zoneColour, type ColourScheme, type SurpriseVariable } from '../../services/analysisECharts/surpriseGaugeBuilder';

const MAX_SIGMA = 3.5;

interface MinimisedSurpriseGaugeProps {
  result: any;
  settings: Record<string, any>;
  label?: string;
}

export function MinimisedSurpriseGauge({ result, settings }: MinimisedSurpriseGaugeProps): React.ReactElement | null {
  if (!result?.variables) return null;

  const selectedVar = settings.surprise_var || 'p';
  if (selectedVar === 'all') return null;

  const variables: SurpriseVariable[] = result.variables;
  const variable = variables.find(v => v.available && v.name === selectedVar);
  if (!variable) return null;

  const scheme = (settings.surprise_colour_scheme || 'symmetric') as ColourScheme;
  const colour = zoneColour(variable.sigma, scheme);
  const isNonBayes = !!result.hint;

  const r = 30;
  const svgW = r * 2 + 2;
  const svgH = r + 4;
  const cx = svgW / 2;
  const cy = r + 1;
  const needleLen = r - 6;

  const clampedSigma = Math.max(-MAX_SIGMA, Math.min(MAX_SIGMA, variable.sigma));
  const needleAngle = Math.PI * (1 - (clampedSigma + MAX_SIGMA) / (2 * MAX_SIGMA));
  const nx = cx + needleLen * Math.cos(needleAngle);
  const ny = cy - needleLen * Math.sin(needleAngle);

  const faceFill = 'var(--canvas-analysis-bg, #ffffff)';
  const strokeColour = 'var(--canvas-analysis-border, #d1d5db)';
  const needleColour = 'var(--canvas-analysis-title, #374151)';

  return (
    <div style={{
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      width: '100%',
      height: '100%',
      padding: '4px 6px',
      boxSizing: 'border-box',
      position: 'relative',
    }}>
      <svg
        viewBox={`0 0 ${svgW} ${svgH}`}
        style={{ width: '100%', height: '100%', display: 'block' }}
        preserveAspectRatio="xMidYMid meet"
      >
        {/* White face with heavier outline */}
        <path
          d={`M ${cx - r} ${cy} A ${r} ${r} 0 0 1 ${cx + r} ${cy} Z`}
          fill={faceFill}
          stroke={strokeColour}
          strokeWidth={3}
        />
        {/* Light calibration lines */}
        {[0, 0.25, 0.5, 0.75, 1].map((t, i) => {
          const angle = Math.PI * (1 - t);
          const x1 = cx + (r - 2) * Math.cos(angle);
          const y1 = cy - (r - 2) * Math.sin(angle);
          const x2 = cx + (r - 5) * Math.cos(angle);
          const y2 = cy - (r - 5) * Math.sin(angle);
          return <line key={i} x1={x1} y1={y1} x2={x2} y2={y2}
            stroke={strokeColour} strokeWidth={0.5} opacity={0.5} />;
        })}
        {/* Coloured indicator light — centred inside dial */}
        <circle cx={cx} cy={cy - r * 0.4} r={7} fill={colour} />
        {/* Needle */}
        <line
          x1={cx} y1={cy} x2={nx} y2={ny}
          stroke={needleColour} strokeWidth={2} strokeLinecap="round"
        />
        {/* Pivot dot */}
        <circle cx={cx} cy={cy} r={2} fill={needleColour} />
      </svg>
      {isNonBayes && (
        <div style={{
          position: 'absolute',
          top: 1, right: 2,
          fontSize: 10,
          lineHeight: 1,
          color: '#f59e0b',
        }} title="Using analytic data (run Bayes for better indicators)">⚠</div>
      )}
    </div>
  );
}
