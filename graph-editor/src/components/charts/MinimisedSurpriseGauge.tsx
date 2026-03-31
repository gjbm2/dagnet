/**
 * MinimisedSurpriseGauge — compact mini-gauge for the canvas minimised state.
 *
 * White-faced semicircle dial with colour bands inside the arc (matching
 * the full-size gauge zones), dark needle, and dark outline.
 * Optional ⚠ for non-Bayes data.
 *
 * Only renders for single-variable mode. Returns null for multi-variable
 * ('all') or when no result is available.
 */

import React from 'react';
import {
  ZONES,
  DIRECTIONAL_COLOURS,
  type ColourScheme,
  type SurpriseVariable,
} from '../../services/analysisECharts/surpriseGaugeBuilder';

const MAX_SIGMA = 3.5;

interface MinimisedSurpriseGaugeProps {
  result: any;
  settings: Record<string, any>;
  label?: string;
}

/** Build arc band segments: { startAngle, endAngle, colour } in radians.
 *  Semicircle spans π (left, -MAX_SIGMA) to 0 (right, +MAX_SIGMA). */
function buildBands(scheme: ColourScheme): { start: number; end: number; colour: string }[] {
  const toAngle = (sigma: number) => Math.PI * (1 - (sigma + MAX_SIGMA) / (2 * MAX_SIGMA));

  if (scheme === 'symmetric') {
    const bands: { start: number; end: number; colour: string }[] = [];
    const revZones = [...ZONES].reverse(); // alarming → expected
    // Negative side
    let prevSigma = -MAX_SIGMA;
    for (let i = 0; i < revZones.length; i++) {
      const nextSigma = i < revZones.length - 1 ? -revZones[i + 1].maxSigma : 0;
      bands.push({ start: toAngle(prevSigma), end: toAngle(nextSigma), colour: revZones[i].colour });
      prevSigma = nextSigma;
    }
    // Positive side
    for (let i = 0; i < ZONES.length; i++) {
      const endSigma = ZONES[i].maxSigma;
      bands.push({ start: toAngle(prevSigma), end: toAngle(endSigma), colour: ZONES[i].colour });
      prevSigma = endSigma;
    }
    // Final alarming to edge
    if (prevSigma < MAX_SIGMA) {
      bands.push({ start: toAngle(prevSigma), end: toAngle(MAX_SIGMA), colour: ZONES[ZONES.length - 1].colour });
    }
    return bands;
  }

  // Directional: 5 equal bands
  const colours = scheme === 'directional_positive'
    ? DIRECTIONAL_COLOURS
    : [...DIRECTIONAL_COLOURS].reverse();
  const step = (2 * MAX_SIGMA) / colours.length;
  return colours.map((c, i) => ({
    start: toAngle(-MAX_SIGMA + i * step),
    end: toAngle(-MAX_SIGMA + (i + 1) * step),
    colour: c.colour,
  }));
}

/** SVG arc path for an annular band between two angles.
 *  Angles are in radians, measured counter-clockwise from the +x axis.
 *  Our semicircle: π (left) to 0 (right), so a1 > a2 for left-to-right bands. */
function bandPath(cx: number, cy: number, outerR: number, innerR: number, a1: number, a2: number): string {
  // a1 = start angle (larger, toward left), a2 = end angle (smaller, toward right)
  const largeArc = Math.abs(a1 - a2) > Math.PI ? 1 : 0;

  // Outer arc: trace from a1 to a2 (clockwise in screen coords = sweep-flag 1)
  const ox1 = cx + outerR * Math.cos(a1);
  const oy1 = cy - outerR * Math.sin(a1);
  const ox2 = cx + outerR * Math.cos(a2);
  const oy2 = cy - outerR * Math.sin(a2);

  // Inner arc: trace back from a2 to a1 (counter-clockwise = sweep-flag 0)
  const ix1 = cx + innerR * Math.cos(a2);
  const iy1 = cy - innerR * Math.sin(a2);
  const ix2 = cx + innerR * Math.cos(a1);
  const iy2 = cy - innerR * Math.sin(a1);

  return [
    `M ${ox1} ${oy1}`,
    `A ${outerR} ${outerR} 0 ${largeArc} 1 ${ox2} ${oy2}`,
    `L ${ix1} ${iy1}`,
    `A ${innerR} ${innerR} 0 ${largeArc} 0 ${ix2} ${iy2}`,
    'Z',
  ].join(' ');
}

export function MinimisedSurpriseGauge({ result, settings }: MinimisedSurpriseGaugeProps): React.ReactElement | null {
  if (!result?.variables) return null;

  const selectedVar = settings.surprise_var || 'p';
  if (selectedVar === 'all') return null;

  const variables: SurpriseVariable[] = result.variables;
  const variable = variables.find(v => v.available && v.name === selectedVar);
  if (!variable) return null;

  const scheme = (settings.surprise_colour_scheme || 'symmetric') as ColourScheme;
  const isNonBayes = !!result.hint;

  const r = 30;
  const bandWidth = 5;
  const svgW = r * 2 + 2;
  const svgH = r + 4;
  const cx = svgW / 2;
  const cy = r + 1;
  const needleLen = r - bandWidth - 3;

  const clampedSigma = Math.max(-MAX_SIGMA, Math.min(MAX_SIGMA, variable.sigma));
  const needleAngle = Math.PI * (1 - (clampedSigma + MAX_SIGMA) / (2 * MAX_SIGMA));
  const nx = cx + needleLen * Math.cos(needleAngle);
  const ny = cy - needleLen * Math.sin(needleAngle);

  const faceFill = 'var(--canvas-analysis-bg, #ffffff)';
  const needleColour = 'var(--canvas-analysis-title, #374151)';

  const bands = buildBands(scheme);

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
        {/* White face with outline */}
        <path
          d={`M ${cx - r} ${cy} A ${r} ${r} 0 0 1 ${cx + r} ${cy} Z`}
          fill={faceFill}
          stroke={needleColour}
          strokeWidth={2}
        />
        {/* Colour bands inside the arc */}
        {bands.map((band, i) => (
          <path
            key={i}
            d={bandPath(cx, cy, r - 1, r - 1 - bandWidth, band.start, band.end)}
            fill={band.colour}
          />
        ))}
        {/* Needle */}
        <line
          x1={cx} y1={cy} x2={nx} y2={ny}
          stroke={needleColour} strokeWidth={2} strokeLinecap="round"
        />
        {/* Pivot dot */}
        <circle cx={cx} cy={cy} r={3.5} fill={needleColour} />
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
