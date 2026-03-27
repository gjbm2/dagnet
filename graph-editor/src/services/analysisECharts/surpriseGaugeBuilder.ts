/**
 * surpriseGaugeBuilder.ts — ECharts option builder for the Model Surprise gauge.
 *
 * Three layouts:
 *  1. Single var, single scenario → semicircular gauge dial
 *  2. One var, multiple scenarios → horizontal bands (shared axis)
 *  3. One scenario, multiple vars → horizontal bands (normalised axis)
 *
 * Axis: linear in σ, labelled in percentiles.
 * Colour zones: green (expected) → yellow → amber → red → dark red (alarming).
 */

import { echartsThemeColours, echartsTooltipStyle } from './echartsCommon';

// Zone boundaries in σ units and their colours
const ZONES = [
  { maxSigma: 1.28,  colour: '#22c55e', label: 'Expected' },     // green
  { maxSigma: 1.645, colour: '#eab308', label: 'Noteworthy' },   // yellow
  { maxSigma: 1.96,  colour: '#f59e0b', label: 'Unusual' },      // amber
  { maxSigma: 2.576, colour: '#ef4444', label: 'Surprising' },   // red
  { maxSigma: 3.5,   colour: '#991b1b', label: 'Alarming' },     // dark red
];

// Confidence band labels — symmetric ±, showing the CI boundary
// e.g. at ±1.96σ the label is "95%" meaning "outside the 95% CI"
const PERCENTILE_TICKS = [
  { sigma: -2.576, label: '99%' },
  { sigma: -1.96,  label: '95%' },
  { sigma: -1.645, label: '90%' },
  { sigma: -1.28,  label: '80%' },
  { sigma: 0,      label: '•' },
  { sigma: 1.28,   label: '80%' },
  { sigma: 1.645,  label: '90%' },
  { sigma: 1.96,   label: '95%' },
  { sigma: 2.576,  label: '99%' },
];

interface SurpriseVariable {
  name: string;
  label: string;
  quantile: number;
  sigma: number;
  observed: number;
  expected: number;
  posterior_sd: number;
  zone: string;
  available: boolean;
  reason?: string;
  evidence_n?: number;
  evidence_k?: number;
  observed_days?: number;
  expected_days?: number;
}

function zoneColour(sigma: number): string {
  const absSigma = Math.abs(sigma);
  for (const z of ZONES) {
    if (absSigma <= z.maxSigma) return z.colour;
  }
  return ZONES[ZONES.length - 1].colour;
}

/**
 * Build the semicircular gauge dial for a single variable.
 */
function buildGaugeDial(
  variable: SurpriseVariable,
  settings: Record<string, any>,
): any {
  const c = echartsThemeColours();
  const maxSigma = 3.5;

  // Build colour bands as axisLine segments (symmetric: -maxSigma to +maxSigma)
  const colourStops: [number, string][] = [];
  const allBoundaries = [0, ...ZONES.map(z => z.maxSigma)];
  for (let i = 0; i < ZONES.length; i++) {
    const from = i === 0 ? 0 : allBoundaries[i];
    const to = allBoundaries[i + 1];
    const normFrom = (maxSigma - from) / (2 * maxSigma);
    const normTo = (maxSigma - to) / (2 * maxSigma);
    // Left side (below expected)
    colourStops.push([1 - normFrom, ZONES[i].colour]);
    // Right side (above expected) — mirror
    const rightFrom = (maxSigma + from) / (2 * maxSigma);
    const rightTo = (maxSigma + to) / (2 * maxSigma);
  }

  // Simpler approach: build symmetric colour array
  const segments: [number, string][] = [];
  // Negative side (reversed zones)
  for (let i = ZONES.length - 1; i >= 0; i--) {
    const boundary = (maxSigma - ZONES[i].maxSigma) / (2 * maxSigma);
    segments.push([boundary, ZONES[i].colour]);
  }
  // Centre
  segments.push([0.5, ZONES[0].colour]);
  // Positive side
  for (let i = 0; i < ZONES.length; i++) {
    const boundary = (maxSigma + ZONES[i].maxSigma) / (2 * maxSigma);
    segments.push([boundary, ZONES[i].colour]);
  }
  segments.push([1, ZONES[ZONES.length - 1].colour]);

  // Clamp needle to visible range
  const needleSigma = Math.max(-maxSigma, Math.min(maxSigma, variable.sigma));

  // Format values for display
  const fmtObs = variable.name === 'p'
    ? `${(variable.observed * 100).toFixed(1)}%`
    : variable.observed_days != null
      ? `${variable.observed_days}d`
      : variable.observed.toFixed(3);
  const fmtExp = variable.name === 'p'
    ? `${(variable.expected * 100).toFixed(1)}%`
    : variable.expected_days != null
      ? `${variable.expected_days}d`
      : variable.expected.toFixed(3);
  const fmtSd = variable.name === 'p'
    ? `${(variable.posterior_sd * 100).toFixed(2)}%`
    : variable.posterior_sd.toFixed(4);

  // Detail label: "Observed: 77.7%\nModel: 80.7% ± 0.80%"
  const detailLabel = `Observed: ${fmtObs}\nModel: ${fmtExp} ± ${fmtSd}`;

  // ── Responsive percentage-based layout ──
  //
  // Semicircular gauge (startAngle=180, endAngle=0).
  // Uses ECharts' media query system so the gauge adapts to any container
  // aspect ratio via native resize — no pixel dimensions in the option,
  // which avoids the double-draw caused by useElementSize dimension changes.
  //
  // Constraints (top-to-bottom):
  //   ~14px axis-label overshoot above the arc top
  //   Arc — semicircle of height R above the centre
  //   Centre — needle pivot
  //   ~60px below centre (needle gap + 2-line detail text + bottom pad)
  //
  // Labels only appear at ±1.28σ–±2.576σ (angles 24°–57° from horizontal),
  // so horizontal overshoot is just tick marks (~4px), not label text.
  //
  // Breakpoints (by container width/height ratio):
  //   portrait  (< 1)    — centre 55%, radius  85%  (width-constrained)
  //   near-square (1–1.25) — centre 65%, radius  95%
  //   landscape (≥ 1.25)  — centre 70%, radius 110%  (height-constrained)

  const gaugeSeriesBase: any = {
    type: 'gauge',
    startAngle: 180,
    endAngle: 0,
    min: -maxSigma,
    max: maxSigma,
    center: ['50%', '70%'],
    radius: '110%',
    axisLine: {
      lineStyle: {
        width: 18,
        color: segments,
      },
    },
    splitNumber: 14,
    axisTick: {
      show: true,
      length: 2,
      lineStyle: { color: c.text, opacity: 0.2 },
    },
    splitLine: {
      show: true,
      length: 4,
      lineStyle: { color: c.text, opacity: 0.3, width: 1 },
    },
    axisLabel: {
      distance: 10,
      fontSize: 8,
      color: c.text === '#e0e0e0' ? '#ffffff' : '#1f2937',
      formatter: (value: number) => {
        const tick = PERCENTILE_TICKS.find(t => Math.abs(t.sigma - value) < 0.15);
        return tick ? tick.label : '';
      },
    },
    pointer: {
      width: 4,
      length: '70%',
      itemStyle: { color: c.text },
    },
    detail: {
      valueAnimation: true,
      formatter: detailLabel,
      fontSize: 10,
      lineHeight: 14,
      color: c.text,
      offsetCenter: [0, '22%'],
    },
    title: {
      show: true,
      offsetCenter: [0, '-20%'],
      fontSize: 11,
      color: c.text,
    },
    data: [{
      value: needleSigma,
      name: variable.label,
    }],
  };

  return {
    tooltip: {
      ...echartsTooltipStyle(),
      formatter: () => {
        const pctLabel = `${(variable.quantile * 100).toFixed(1)}th percentile`;
        return `<strong>${variable.label}</strong><br/>` +
          `Observed: ${fmtObs}<br/>` +
          `Model: ${fmtExp} ± ${fmtSd}<br/>` +
          `Position: ${pctLabel} (${variable.sigma > 0 ? '+' : ''}${variable.sigma.toFixed(2)}σ)<br/>` +
          `Verdict: ${variable.zone}`;
      },
    },
    animationDuration: 600,
    animationEasing: 'cubicOut',
    series: [gaugeSeriesBase],
  };
}

/**
 * Build horizontal band chart for multiple variables (normalised axis)
 * or multiple scenarios (shared axis).
 */
function buildBandChart(
  variables: SurpriseVariable[],
  settings: Record<string, any>,
): any {
  const c = echartsThemeColours();
  const maxSigma = 3.5;

  const available = variables.filter(v => v.available);
  if (available.length === 0) return null;

  const categories = available.map(v => v.label);

  // Background colour bands (symmetric zones)
  const markAreas: any[] = [];
  const prevBoundaries = [0, ...ZONES.map(z => z.maxSigma)];
  for (let i = 0; i < ZONES.length; i++) {
    const from = prevBoundaries[i];
    const to = prevBoundaries[i + 1];
    // Positive side
    markAreas.push({
      itemStyle: { color: ZONES[i].colour, opacity: 0.15 },
      xAxis: from, x2Axis: to,
    });
    // Negative side
    markAreas.push({
      itemStyle: { color: ZONES[i].colour, opacity: 0.15 },
      xAxis: -to, x2Axis: -from,
    });
  }

  // Scatter points — one per variable at its σ position
  const scatterData = available.map((v, i) => ({
    value: [Math.max(-maxSigma, Math.min(maxSigma, v.sigma)), i],
    itemStyle: { color: zoneColour(v.sigma), borderColor: c.text, borderWidth: 1 },
    label: {
      show: true,
      position: 'right',
      formatter: v.name === 'p'
        ? `${(v.observed * 100).toFixed(1)}%`
        : v.observed_days != null
          ? `${v.observed_days}d`
          : v.observed.toFixed(3),
      fontSize: 9,
      color: c.text,
    },
  }));

  return {
    tooltip: {
      ...echartsTooltipStyle(),
      trigger: 'item',
      formatter: (params: any) => {
        const idx = params.value?.[1];
        if (idx == null || !available[idx]) return '';
        const v = available[idx];
        const fmtObs = v.name === 'p' ? `${(v.observed * 100).toFixed(1)}%`
          : v.observed_days != null ? `${v.observed_days}d` : v.observed.toFixed(3);
        const fmtExp = v.name === 'p' ? `${(v.expected * 100).toFixed(1)}%`
          : v.expected_days != null ? `${v.expected_days}d` : v.expected.toFixed(3);
        const pct = `${(v.quantile * 100).toFixed(1)}th percentile`;
        return `<strong>${v.label}</strong><br/>` +
          `Observed: ${fmtObs}<br/>` +
          `Expected: ${fmtExp}<br/>` +
          `Position: ${pct} (${v.sigma > 0 ? '+' : ''}${v.sigma.toFixed(2)}σ)<br/>` +
          `Verdict: ${v.zone}`;
      },
    },
    grid: { left: 100, right: 60, top: 20, bottom: 30, containLabel: false },
    xAxis: {
      type: 'value',
      min: -maxSigma,
      max: maxSigma,
      axisLabel: {
        fontSize: 8,
        color: c.text,
        formatter: (value: number) => {
          const tick = PERCENTILE_TICKS.find(t => Math.abs(t.sigma - value) < 0.05);
          return tick ? tick.label : '';
        },
      },
      splitLine: { show: false },
      axisLine: { lineStyle: { color: c.gridLine } },
    },
    yAxis: {
      type: 'category',
      data: categories,
      axisLabel: { fontSize: 9, color: c.text },
      axisLine: { lineStyle: { color: c.gridLine } },
      axisTick: { show: false },
    },
    series: [
      {
        type: 'scatter',
        symbolSize: 14,
        data: scatterData,
        markArea: {
          silent: true,
          data: markAreas.map(ma => [
            { xAxis: ma.xAxis, itemStyle: ma.itemStyle },
            { xAxis: ma.x2Axis },
          ]),
        },
      },
      // Centre line at 0 (expected)
      {
        type: 'line',
        markLine: {
          silent: true,
          symbol: 'none',
          lineStyle: { color: c.text, type: 'dashed', opacity: 0.4 },
          data: [{ xAxis: 0 }],
          label: { show: false },
        },
        data: [],
      },
    ],
  };
}

/**
 * Main entry point: build the surprise gauge ECharts option.
 */
export function buildSurpriseGaugeEChartsOption(
  result: any,
  settings: Record<string, any>,
): any | null {
  const variables: SurpriseVariable[] = result?.variables || [];
  if (variables.length === 0) return null;

  const available = variables.filter(v => v.available);
  if (available.length === 0) return null;

  // Which variable(s) to show — respect the display setting
  const selectedVar = settings.surprise_var || 'all';

  let opt: any;
  if (selectedVar === 'all') {
    // Show all available variables as horizontal bands
    opt = buildBandChart(available, settings);
  } else {
    // Single variable selected — show semicircular dial
    const v = available.find(a => a.name === selectedVar);
    if (!v) {
      // Requested var not available — fall back to bands with whatever is available
      opt = buildBandChart(available, settings);
    } else {
      opt = buildGaugeDial(v, settings);
    }
  }

  // Add hint label when not using Bayesian posteriors
  const hint = result?.hint;
  if (opt && hint) {
    const c = echartsThemeColours();
    opt.graphic = [{
      type: 'text',
      right: 8,
      bottom: 4,
      style: {
        text: hint,
        fontSize: 9,
        fill: c.text === '#e0e0e0' ? '#6b7280' : '#9ca3af',
        fontStyle: 'italic',
      },
      silent: true,
    }];
  }

  return opt;
}
