/**
 * MinimisedSurpriseGauge — coloured indicator light for the canvas minimised state.
 *
 * A solid circle filled with the zone colour. That's it.
 * Optional ⚠ overlay for non-Bayes data.
 *
 * Only renders for single-variable mode. Returns null for multi-variable
 * ('all') or when no result is available.
 */

import React from 'react';
import { zoneColour, type ColourScheme, type SurpriseVariable } from '../../services/analysisECharts/surpriseGaugeBuilder';

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

  // Build detail tooltip matching the gauge face text
  const asPct = variable.name === 'p' || variable.name === 'completeness';
  const fmtObs = asPct
    ? `${(variable.observed * 100).toFixed(1)}%`
    : variable.observed_days != null
      ? `${variable.observed_days}d`
      : variable.observed.toFixed(3);
  const fmtExp = asPct
    ? `${(variable.expected * 100).toFixed(1)}%`
    : variable.expected_days != null
      ? `${variable.expected_days}d`
      : variable.expected.toFixed(3);
  const pctLabel = `${(variable.quantile * 100).toFixed(1)}th percentile`;
  const sigmaStr = `${variable.sigma > 0 ? '+' : ''}${variable.sigma.toFixed(2)}σ`;
  const detailTooltip = [
    variable.label,
    `Evidence: ${fmtObs}`,
    `Expected: ${fmtExp}`,
    `Position: ${pctLabel} (${sigmaStr})`,
    `Verdict: ${variable.zone}`,
  ].join('\n');

  return (
    <div style={{
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      width: '100%',
      height: '100%',
      position: 'relative',
    }}>
      <div
        title={detailTooltip}
        style={{
          width: 20,
          height: 20,
          borderRadius: '50%',
          backgroundColor: colour,
          border: '2px solid rgba(0,0,0,0.12)',
          boxShadow: `0 0 6px ${colour}66`,
        }}
      />
      {isNonBayes && (
        <div style={{
          position: 'absolute',
          top: 1, right: 1,
          fontSize: 9,
          lineHeight: 1,
          color: '#f59e0b',
        }} title="Using analytic data (run Bayes for better indicators)">⚠</div>
      )}
    </div>
  );
}
