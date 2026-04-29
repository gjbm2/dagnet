/**
 * Negative-assertion test: window-merge does not write a forecast scalar.
 *
 * Pre-cleanup, this file pinned the precision of `mergeTimeSeriesIntoParameter`'s
 * `forecast = Σk_mature / Σn_mature` computation (with recency weighting and an
 * immature-tail exclusion). That computation has been removed: derived FE
 * metrics no longer round-trip through param-file values. The same logic now
 * lives in `addEvidenceAndForecastScalars` at fetch time and lands on the
 * graph edge as `model_vars[analytic]`, never on the parameter file.
 *
 * We retain a single test here as a regression guard against the W1 path
 * being reintroduced.
 *
 * @vitest-environment node
 */

import { describe, it, expect } from 'vitest';

import { mergeTimeSeriesIntoParameter } from '../windowAggregationService';

function ukDate(d: Date): string {
  const dd = String(d.getUTCDate());
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const mmm = months[d.getUTCMonth()];
  const yy = String(d.getUTCFullYear()).slice(-2);
  return `${dd}-${mmm}-${yy}`;
}

describe('window-merge does not write forecast on merged values', () => {
  it('regression guard: `forecast` field is absent from merged value even with recomputeForecast=true', () => {
    const end = new Date(Date.UTC(2025, 10, 30));
    const days = 60;
    const points: Array<{ date: string; n: number; k: number; p: number }> = [];
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date(end);
      d.setUTCDate(d.getUTCDate() - i);
      points.push({ date: ukDate(d), n: 100, k: 20, p: 0.2 });
    }

    const out = mergeTimeSeriesIntoParameter(
      [],
      points as any,
      { start: points[0].date, end: points[points.length - 1].date } as any,
      'sig',
      undefined,
      undefined,
      'amplitude',
      '',
      {
        isCohortMode: false,
        recomputeForecast: true,
        latencyConfig: { latency_parameter: true, t95: 30 },
      }
    );

    expect(out).toHaveLength(1);
    const v: any = out[0];
    expect(v.forecast).toBeUndefined();
    expect(v.forecast_stdev).toBeUndefined();
  });
});
