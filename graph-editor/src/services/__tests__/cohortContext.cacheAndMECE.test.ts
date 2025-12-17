import { describe, it, expect } from 'vitest';
import type { ParameterValue } from '../paramRegistryService';
import { calculateIncrementalFetch } from '../windowAggregationService';

describe('Cohort + context cache cutting (contextAny + MECE)', () => {
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
});


