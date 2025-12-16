import { describe, it, expect } from 'vitest';

import { selectLatencyToApplyForTopoPass } from '../fetchDataService';

describe('selectLatencyToApplyForTopoPass', () => {
  it('preserves existing median/mean lag but always takes computed completeness in from-file mode', () => {
    const computed = {
      median_lag_days: 2.5,
      mean_lag_days: 2.7,
      t95: 6.1,
      completeness: 0.91,
      path_t95: 8.43,
    };

    const existing = {
      median_lag_days: 6.4,
      mean_lag_days: 6.8,
      t95: 13.12,
      completeness: 0.6032414791916322,
    };

    const selected = selectLatencyToApplyForTopoPass(computed, existing, true);

    expect(selected.median_lag_days).toBe(existing.median_lag_days);
    expect(selected.mean_lag_days).toBe(existing.mean_lag_days);
    expect(selected.t95).toBe(existing.t95);
    expect(selected.path_t95).toBe(computed.path_t95);
    expect(selected.completeness).toBe(computed.completeness);
  });

  it('returns computed latency unchanged when not preserving from-file summary', () => {
    const computed = {
      median_lag_days: 2.5,
      mean_lag_days: 2.7,
      t95: 6.1,
      completeness: 0.91,
      path_t95: 8.43,
    };

    const selected = selectLatencyToApplyForTopoPass(computed, { completeness: 0.1 }, false);
    expect(selected).toEqual(computed);
  });

  it('returns computed latency when there is no existing median/mean summary', () => {
    const computed = {
      median_lag_days: 2.5,
      mean_lag_days: 2.7,
      t95: 6.1,
      completeness: 0.91,
      path_t95: 8.43,
    };

    const selected = selectLatencyToApplyForTopoPass(computed, { completeness: 0.2 }, true);
    expect(selected).toEqual(computed);
  });
});



