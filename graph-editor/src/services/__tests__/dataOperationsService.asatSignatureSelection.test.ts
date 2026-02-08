import { describe, expect, it } from 'vitest';
import { selectQuerySignatureForAsat } from '../dataOperationsService';

describe('dataOperationsService selectQuerySignatureForAsat', () => {
  it('prefers a window-mode signature when mode=window, even if cohort value is more recent', () => {
    const values: any[] = [
      {
        query_signature: 'sig-cohort-newer',
        cohort_from: '1-Jan-26',
        cohort_to: '10-Jan-26',
        data_source: { retrieved_at: '2026-02-07T12:00:00.000Z' },
      },
      {
        query_signature: 'sig-window-older',
        window_from: '1-Jan-26',
        window_to: '10-Jan-26',
        data_source: { retrieved_at: '2026-02-01T12:00:00.000Z' },
      },
    ];

    expect(selectQuerySignatureForAsat({ values, mode: 'window' })).toBe('sig-window-older');
  });

  it('prefers a cohort-mode signature when mode=cohort, even if window value is more recent', () => {
    const values: any[] = [
      {
        query_signature: 'sig-window-newer',
        window_from: '1-Jan-26',
        window_to: '10-Jan-26',
        data_source: { retrieved_at: '2026-02-07T12:00:00.000Z' },
      },
      {
        query_signature: 'sig-cohort-older',
        cohort_from: '1-Jan-26',
        cohort_to: '10-Jan-26',
        data_source: { retrieved_at: '2026-02-01T12:00:00.000Z' },
      },
    ];

    expect(selectQuerySignatureForAsat({ values, mode: 'cohort' })).toBe('sig-cohort-older');
  });

  it('returns undefined if no values match the requested mode (no fallback)', () => {
    const values: any[] = [
      { query_signature: 'sig-only-cohort', cohort_from: '1-Jan-26', cohort_to: '2-Jan-26' },
    ];

    expect(selectQuerySignatureForAsat({ values, mode: 'window' })).toBeUndefined();
  });
});

