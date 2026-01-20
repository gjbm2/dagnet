import { describe, it, expect } from 'vitest';
import type { ParameterValue } from '../../types/parameterData';
import { calculateIncrementalFetch } from '../windowAggregationService';
import { isSignatureCheckingEnabled } from '../signaturePolicyService';

describe('calculateIncrementalFetch - query_signature gating', () => {
  (isSignatureCheckingEnabled() ? it : it.skip)(
    'treats data as NOT cached when sliceDSL matches but query_signature differs',
    () => {
    const values: ParameterValue[] = [
      {
        sliceDSL: 'context(channel:paid-search)',
        query_signature: 'sig-old',
        dates: ['10-Dec-25', '11-Dec-25', '12-Dec-25'],
        n_daily: [100, 100, 100],
        k_daily: [50, 50, 50],
        mean: 0.5,
        n: 300,
        k: 150,
      },
    ];

    const result = calculateIncrementalFetch(
      { values },
      { start: '10-Dec-25', end: '12-Dec-25' },
      'sig-new',
      false,
      'context(channel:paid-search).window(10-Dec-25:12-Dec-25)'
    );

    expect(result.needsFetch).toBe(true);
    expect(result.daysAvailable).toBe(0);
    expect(result.daysToFetch).toBe(3);
    }
  );

  (isSignatureCheckingEnabled() ? it : it.skip)(
    'does not force refetch for legacy values with no query_signature',
    () => {
    const values: ParameterValue[] = [
      {
        sliceDSL: 'context(channel:paid-search)',
        // Legacy: no query_signature field
        dates: ['10-Dec-25', '11-Dec-25', '12-Dec-25'],
        n_daily: [100, 100, 100],
        k_daily: [50, 50, 50],
        mean: 0.5,
        n: 300,
        k: 150,
      } as any,
    ];

    const result = calculateIncrementalFetch(
      { values },
      { start: '10-Dec-25', end: '12-Dec-25' },
      'sig-new',
      false,
      'context(channel:paid-search).window(10-Dec-25:12-Dec-25)'
    );

    expect(result.needsFetch).toBe(false);
    expect(result.daysAvailable).toBe(3);
    expect(result.daysToFetch).toBe(0);
    }
  );
});


