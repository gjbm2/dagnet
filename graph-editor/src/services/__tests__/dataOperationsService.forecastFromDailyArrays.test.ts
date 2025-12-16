import { describe, it, expect } from 'vitest';
import { __test_only__ } from '../dataOperationsService';

describe('dataOperationsService.addEvidenceAndForecastScalars', () => {
  it('computes forecast scalar from window daily arrays when forecast is missing', () => {
    const targetSlice = 'cohort(2-Nov-25:15-Nov-25)';

    // Aggregated data for the requested slice (no forecast scalar yet).
    const aggregatedData = {
      type: 'probability',
      values: [
        {
          sliceDSL: targetSlice,
          n: 100,
          k: 20,
          mean: 0.2,
        }
      ],
    };

    // Original file data includes a window slice with daily arrays but no `forecast` scalar.
    // Dates are far enough in the past to be considered "mature" under the default maturity cutoff.
    const originalParamData = {
      type: 'probability',
      values: [
        {
          sliceDSL: 'window(11-Oct-25:15-Dec-25)',
          mean: 0.2,
          dates: ['1-Nov-25', '2-Nov-25', '3-Nov-25'],
          n_daily: [100, 100, 100],
          k_daily: [20, 20, 20],
          n: 300,
          k: 60,
        }
      ],
    };

    const next = __test_only__.addEvidenceAndForecastScalars(
      aggregatedData,
      originalParamData,
      targetSlice
    );

    expect(next.values[0].forecast).toBeDefined();
    expect(next.values[0].forecast).toBeCloseTo(0.2, 6);
  });
});


