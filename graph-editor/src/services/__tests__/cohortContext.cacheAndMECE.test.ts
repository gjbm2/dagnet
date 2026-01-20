import { describe, it, expect, beforeEach } from 'vitest';
import type { ParameterValue } from '../../types/parameterData';
import { calculateIncrementalFetch } from '../windowAggregationService';
import { contextRegistry } from '../contextRegistry';

function seedChannel(values: string[]) {
  contextRegistry.clearCache();
  (contextRegistry as any).cache.set('channel', {
    id: 'channel',
    name: 'channel',
    description: 'test',
    type: 'categorical',
    otherPolicy: 'null',
    values: values.map((id) => ({ id, label: id })),
    metadata: { status: 'active', created_at: '1-Dec-25', version: '1.0.0' },
  });
}

describe('Cohort + context cache cutting (contextAny + MECE)', () => {
  beforeEach(() => {
    seedChannel(['google', 'meta']);
  });

  it('contextAny in cohort mode requires ALL component slices have each cohort date', () => {
    const values: ParameterValue[] = [
      {
        sliceDSL: 'context(channel:google)',
        cohort_from: '1-Nov-25',
        cohort_to: '3-Nov-25',
        dates: ['1-Nov-25', '2-Nov-25', '3-Nov-25'],
        n_daily: [10, 10, 10],
        k_daily: [5, 5, 5],
        mean: 0.5,
        n: 30,
        k: 15,
      },
      {
        sliceDSL: 'context(channel:meta)',
        cohort_from: '1-Nov-25',
        cohort_to: '3-Nov-25',
        // Missing 2-Nov-25 on purpose
        dates: ['1-Nov-25', '3-Nov-25'],
        n_daily: [10, 10],
        k_daily: [5, 5],
        mean: 0.5,
        n: 20,
        k: 10,
      },
    ];

    const result = calculateIncrementalFetch(
      { values },
      { start: '1-Nov-25', end: '3-Nov-25' },
      undefined,
      false,
      'contextAny(channel:google,channel:meta).cohort(anchor,1-Nov-25:3-Nov-25)'
    );

    expect(result.needsFetch).toBe(true);
    // Only 1-Nov-25 and 3-Nov-25 have full coverage
    expect(result.daysAvailable).toBe(2);
    expect(result.daysToFetch).toBe(1);
  });

  it('uncontexted cohort query uses MECE when file has only cohort+context slices (no uncontexted cohort slice)', () => {
    const values: ParameterValue[] = [
      {
        sliceDSL: 'context(channel:google)',
        cohort_from: '1-Nov-25',
        cohort_to: '3-Nov-25',
        dates: ['1-Nov-25', '2-Nov-25', '3-Nov-25'],
        n_daily: [10, 10, 10],
        k_daily: [5, 5, 5],
        mean: 0.5,
        n: 30,
        k: 15,
      },
      {
        sliceDSL: 'context(channel:meta)',
        cohort_from: '1-Nov-25',
        cohort_to: '3-Nov-25',
        dates: ['1-Nov-25', '2-Nov-25', '3-Nov-25'],
        n_daily: [10, 10, 10],
        k_daily: [5, 5, 5],
        mean: 0.5,
        n: 30,
        k: 15,
      },
    ];

    const result = calculateIncrementalFetch(
      { values },
      { start: '1-Nov-25', end: '3-Nov-25' },
      undefined,
      false,
      'cohort(anchor,1-Nov-25:3-Nov-25)' // no context -> MECE across contexted cohort slices
    );

    expect(result.needsFetch).toBe(false);
    expect(result.daysAvailable).toBe(3);
    expect(result.daysToFetch).toBe(0);
  });

  it('uncontexted cohort query treats aggregate-only cohort slices as covered via MECE bounds (no per-day arrays)', () => {
    const values: ParameterValue[] = [
      {
        sliceDSL: 'context(channel:google)',
        cohort_from: '1-Nov-25',
        cohort_to: '3-Nov-25',
        // NOTE: no `dates`, no `n_daily`, no `k_daily` — aggregate-only cache
        mean: 0.5,
        n: 30,
        k: 15,
      },
      {
        sliceDSL: 'context(channel:meta)',
        cohort_from: '1-Nov-25',
        cohort_to: '3-Nov-25',
        mean: 0.5,
        n: 30,
        k: 15,
      },
    ];

    const result = calculateIncrementalFetch(
      { values },
      { start: '1-Nov-25', end: '3-Nov-25' },
      undefined,
      false,
      'cohort(anchor,1-Nov-25:3-Nov-25)'
    );

    expect(result.needsFetch).toBe(false);
    expect(result.daysAvailable).toBe(3);
    expect(result.daysToFetch).toBe(0);
  });

  it('cohort query must not use window slices as cache coverage', () => {
    const values: ParameterValue[] = [
      {
        sliceDSL: 'context(channel:google)',
        window_from: '1-Nov-25',
        window_to: '3-Nov-25',
        dates: ['1-Nov-25', '2-Nov-25', '3-Nov-25'],
        n_daily: [10, 10, 10],
        k_daily: [5, 5, 5],
        mean: 0.5,
        n: 30,
        k: 15,
      },
    ];

    const result = calculateIncrementalFetch(
      { values },
      { start: '1-Nov-25', end: '3-Nov-25' },
      undefined,
      false,
      'context(channel:google).cohort(anchor,1-Nov-25:3-Nov-25)'
    );

    expect(result.needsFetch).toBe(true);
    expect(result.daysToFetch).toBe(3);
  });
});


