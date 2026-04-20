/**
 * surpriseGaugeBuilder.ts — ECharts option builder for the Model Surprise gauge.
 *
 * Three layouts:
 *  1. Single var, single scenario → semicircular gauge dial
 *  2. One var, multiple scenarios → horizontal bands (shared axis)
 *  3. One scenario, multiple vars → horizontal bands (normalised axis)
 *
 * Axis: linear in σ, labelled in percentiles.
 * Colour schemes:
 *  - symmetric (R-A-G-A-R): green centre, red both tails — "any surprise is concerning"
 *  - directional_positive (R-A-G): red left, green right — "higher is better"
 *  - directional_negative (G-A-R): green left, red right — "lower is better"
 */

import { echartsThemeColours, echartsTooltipStyle } from './echartsCommon';

export type ColourScheme = 'symmetric' | 'directional_positive' | 'directional_negative';

// Zone boundaries in σ units and their colours (used for symmetric mode)
export const ZONES = [
  { maxSigma: 1.28,  colour: '#22c55e', label: 'Expected' },     // green
  { maxSigma: 1.645, colour: '#eab308', label: 'Noteworthy' },   // yellow
  { maxSigma: 1.96,  colour: '#f59e0b', label: 'Unusual' },      // amber
  { maxSigma: 2.576, colour: '#ef4444', label: 'Surprising' },   // red
  { maxSigma: 3.5,   colour: '#991b1b', label: 'Alarming' },     // dark red
];

// Directional gradient: 5 stops from "bad" to "good"
export const DIRECTIONAL_COLOURS = [
  { colour: '#991b1b', label: 'Alarming' },    // dark red
  { colour: '#ef4444', label: 'Concerning' },   // red
  { colour: '#f59e0b', label: 'Cautionary' },   // amber
  { colour: '#eab308', label: 'Noteworthy' },   // yellow
  { colour: '#22c55e', label: 'Favourable' },   // green
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

export interface SurpriseVariable {
  name: string;
  label: string;
  quantile: number;
  sigma: number;
  observed: number;
  expected: number;
  posterior_sd: number;
  combined_sd?: number;
  zone: string;
  available: boolean;
  reason?: string;
  evidence_n?: number;
  evidence_k?: number;
  evidence_retrieved_at?: string;
  observed_days?: number;
  expected_days?: number;
  // p-variable only
  completeness?: number;
  // completeness-variable only (raw pair for detail rendering)
  unconditioned?: number;
  unconditioned_sd?: number;
  conditioned?: number;
  conditioned_sd?: number;
}

// Variables whose domain is [0, 1] and render as percentages
function isPercentageVariable(name: string): boolean {
  return name === 'p' || name === 'completeness';
}

/**
 * Resolve the zone colour for a given sigma value under a colour scheme.
 *
 * - symmetric: colour depends on |σ| (distance from centre in either direction)
 * - directional_positive: linear gradient from red (left / negative σ) to green (right / positive σ)
 * - directional_negative: linear gradient from green (left / negative σ) to red (right / positive σ)
 */
export function zoneColour(sigma: number, scheme: ColourScheme = 'symmetric'): string {
  if (scheme === 'symmetric') {
    const absSigma = Math.abs(sigma);
    for (const z of ZONES) {
      if (absSigma <= z.maxSigma) return z.colour;
    }
    return ZONES[ZONES.length - 1].colour;
  }

  // Directional: map sigma linearly from [-3.5, +3.5] to a 5-stop gradient
  const maxSigma = 3.5;
  // Normalise to [0, 1] where 0 = far negative, 1 = far positive
  let t = (sigma + maxSigma) / (2 * maxSigma);
  t = Math.max(0, Math.min(1, t));
  // For directional_negative, reverse so that positive sigma = bad
  if (scheme === 'directional_negative') t = 1 - t;

  const idx = Math.min(Math.floor(t * DIRECTIONAL_COLOURS.length), DIRECTIONAL_COLOURS.length - 1);
  return DIRECTIONAL_COLOURS[idx].colour;
}

/**
 * Build the semicircular gauge dial for a single variable.
 */
function buildGaugeSegments(scheme: ColourScheme): [number, string][] {
  const maxSigma = 3.5;

  if (scheme === 'symmetric') {
    // ECharts axisLine.color: [offset, colour] means "this colour fills from
    // the previous offset TO this offset".
    //
    // Gauge range: sigma -3.5 (offset 0) to +3.5 (offset 1), centre at 0.5.
    // Zone layout (negative side, positive side mirrors):
    //   alarming:   sigma ±3.5   to ±2.576  (offsets 0.000↔0.132, 0.868↔1.000)
    //   surprising: sigma ±2.576 to ±1.96   (offsets 0.132↔0.220, 0.780↔0.868)
    //   unusual:    sigma ±1.96  to ±1.645  (offsets 0.220↔0.265, 0.735↔0.780)
    //   noteworthy: sigma ±1.645 to ±1.28   (offsets 0.265↔0.317, 0.683↔0.735)
    //   expected:   sigma ±1.28  to 0       (offsets 0.317↔0.500, 0.500↔0.683)
    const segments: [number, string][] = [];
    const negZones = [...ZONES].reverse(); // alarming → expected

    // Negative side: each entry [endOffset, colour] fills prev→endOffset.
    for (let i = 0; i < negZones.length; i++) {
      const innerSigma = i < negZones.length - 1 ? negZones[i + 1].maxSigma : 0;
      const endOffset = 0.5 - (innerSigma / maxSigma) * 0.5;
      segments.push([endOffset, negZones[i].colour]);
    }

    // Positive side: expected → alarming
    for (let i = 0; i < ZONES.length; i++) {
      const endOffset = 0.5 + (ZONES[i].maxSigma / maxSigma) * 0.5;
      segments.push([endOffset, ZONES[i].colour]);
    }
    segments.push([1, ZONES[ZONES.length - 1].colour]);
    return segments;
  }

  // Directional: linear gradient across the full range
  const colours = scheme === 'directional_positive'
    ? DIRECTIONAL_COLOURS         // red → green (left to right)
    : [...DIRECTIONAL_COLOURS].reverse();  // green → red (left to right)
  const segments: [number, string][] = [];
  const n = colours.length;
  for (let i = 0; i < n; i++) {
    segments.push([(i + 1) / n, colours[i].colour]);
  }
  return segments;
}

function buildGaugeDial(
  variable: SurpriseVariable,
  settings: Record<string, any>,
): any {
  const c = echartsThemeColours();
  const maxSigma = 3.5;
  const scheme = (settings.surprise_colour_scheme || 'symmetric') as ColourScheme;

  const segments = buildGaugeSegments(scheme);

  // Clamp needle to visible range
  const needleSigma = Math.max(-maxSigma, Math.min(maxSigma, variable.sigma));

  // Format values for display
  const asPct = isPercentageVariable(variable.name);
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
  const sdValue = variable.combined_sd ?? variable.posterior_sd;
  const fmtSd = asPct
    ? `${(sdValue * 100).toFixed(2)}%`
    : sdValue.toFixed(4);

  // Detail label differs by variable type:
  //   p           — "Evidence (k/n): x%" then "Expected (c% complete): y% ± sd%"
  //   completeness — "Evidence: x%" then "Expected: y% ± sd%"
  //                  (Here "Evidence" = conditioned [evidence-informed],
  //                   "Expected" = unconditioned [model baseline].)
  let detailLabel: string;
  if (variable.name === 'p') {
    const nkSuffix = variable.evidence_k != null && variable.evidence_n != null
      ? ` (${variable.evidence_k}/${variable.evidence_n})`
      : '';
    const completenessNote = variable.completeness != null
      ? ` (${Math.round(variable.completeness * 100)}% complete)`
      : '';
    detailLabel = `{lbl|Evidence${nkSuffix}:} {val|${fmtObs}}\n{lbl|Expected${completenessNote}:} {val|${fmtExp}} {lbl|\u00b1 ${fmtSd}}`;
  } else {
    detailLabel = `{lbl|Evidence:} {val|${fmtObs}}\n{lbl|Expected:} {val|${fmtExp}} {lbl|\u00b1 ${fmtSd}}`;
  }

  // Gauge title: "Conversion rate\n@ 10-Mar-26" (data date as smaller subtitle)
  const retrievedAtStr = variable.evidence_retrieved_at;
  const gaugeTitle = retrievedAtStr
    ? `${variable.label}\n{sub|@ ${retrievedAtStr}}`
    : variable.label;

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
    animation: true,
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
      rich: {
        lbl: { fontSize: 10, fontWeight: 'normal', color: c.text === '#e0e0e0' ? '#9ca3af' : '#6b7280' },
        val: { fontSize: 10, fontWeight: 'bold', color: c.text },
      },
    },
    title: {
      show: true,
      offsetCenter: [0, '-20%'],
      fontSize: 11,
      color: c.text,
      rich: {
        sub: { fontSize: 9, color: c.text === '#e0e0e0' ? '#9ca3af' : '#6b7280' },
      },
    },
    data: [{
      value: needleSigma,
      name: gaugeTitle,
    }],
  };

  // Pre-compute a completeness-annotation string for the tooltip
  // (p-variable only — shows the maturity fraction next to "Model:").
  const tooltipCompletenessNote = variable.name === 'p' && variable.completeness != null
    ? ` (${Math.round(variable.completeness * 100)}% complete)`
    : '';

  const opt: any = {
    tooltip: {
      ...echartsTooltipStyle(),
      formatter: () => {
        const pctLabel = `${(variable.quantile * 100).toFixed(1)}th percentile`;
        const dateLine = retrievedAtStr ? `<br/><span style="color:#9ca3af">Data as-at ${retrievedAtStr}</span>` : '';
        return `<strong>${variable.label}</strong>${dateLine}<br/>` +
          `Observed: ${fmtObs}<br/>` +
          `Model: ${fmtExp} ± ${fmtSd}${tooltipCompletenessNote}<br/>` +
          `Position: ${pctLabel} (${variable.sigma > 0 ? '+' : ''}${variable.sigma.toFixed(2)}σ)<br/>` +
          `Verdict: ${variable.zone}`;
      },
    },
    animationDuration: 600,
    animationEasing: 'cubicOut',
    series: [gaugeSeriesBase],
  };

  return opt;
}

/**
 * Build horizontal band chart for multiple variables (normalised axis)
 * or multiple scenarios (shared axis).
 */
function buildBandMarkAreas(scheme: ColourScheme): any[] {
  const maxSigma = 3.5;
  const markAreas: any[] = [];

  if (scheme === 'symmetric') {
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
  } else {
    // Directional: evenly spaced bands across the full range
    const colours = scheme === 'directional_positive'
      ? DIRECTIONAL_COLOURS
      : [...DIRECTIONAL_COLOURS].reverse();
    const n = colours.length;
    const step = (2 * maxSigma) / n;
    for (let i = 0; i < n; i++) {
      markAreas.push({
        itemStyle: { color: colours[i].colour, opacity: 0.15 },
        xAxis: -maxSigma + i * step,
        x2Axis: -maxSigma + (i + 1) * step,
      });
    }
  }
  return markAreas;
}

function buildBandChart(
  variables: SurpriseVariable[],
  settings: Record<string, any>,
): any {
  const c = echartsThemeColours();
  const maxSigma = 3.5;
  const scheme = (settings.surprise_colour_scheme || 'symmetric') as ColourScheme;

  const available = variables.filter(v => v.available);
  if (available.length === 0) return null;

  const categories = available.map(v => v.label);

  const markAreas = buildBandMarkAreas(scheme);

  // Scatter points — one per variable at its σ position
  const scatterData = available.map((v, i) => ({
    value: [Math.max(-maxSigma, Math.min(maxSigma, v.sigma)), i],
    itemStyle: { color: zoneColour(v.sigma, scheme), borderColor: c.text, borderWidth: 1 },
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
  const selectedVar = settings.surprise_var || 'p';

  let opt: any;
  if (selectedVar === 'all') {
    // Multi-variable mode — bands if 2+ available, otherwise dial of the one.
    opt = available.length === 1
      ? buildGaugeDial(available[0], settings)
      : buildBandChart(available, settings);
  } else {
    // Single variable selected — show semicircular dial.
    // If the requested var is unavailable, fall back to the dial of whatever
    // is available (single var) or to bands (multiple).
    const v = available.find(a => a.name === selectedVar);
    if (v) {
      opt = buildGaugeDial(v, settings);
    } else if (available.length === 1) {
      opt = buildGaugeDial(available[0], settings);
    } else {
      opt = buildBandChart(available, settings);
    }
  }

  // Add warning indicator + hint label when not using Bayesian posteriors.
  // Append to any existing graphic entries (e.g. the dial's
  // limited-evidence warning icon) so both can coexist.
  const hint = result?.hint;
  if (opt && hint) {
    const c = echartsThemeColours();
    const hintColour = c.text === '#e0e0e0' ? '#6b7280' : '#9ca3af';
    const hintGraphics = [
      // ⚠ warning icon (top-right)
      {
        type: 'text',
        right: 6,
        top: 4,
        style: {
          text: '⚠',
          fontSize: 14,
          fill: '#f59e0b',
        },
        silent: true,
        z: 100,
      },
      // Hint text (bottom-right)
      {
        type: 'text',
        right: 8,
        bottom: 4,
        style: {
          text: hint,
          fontSize: 9,
          fill: hintColour,
          fontStyle: 'italic',
        },
        silent: true,
      },
    ];
    opt.graphic = Array.isArray(opt.graphic)
      ? [...opt.graphic, ...hintGraphics]
      : hintGraphics;
  }

  return opt;
}
