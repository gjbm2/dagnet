import { describe, it, expect, vi } from 'vitest';
import { resolveMECEPartitionForImplicitUncontextedSync } from '../meceSliceService';
import { contextRegistry } from '../contextRegistry';

describe('meceSliceService - prefer MECE over explicit uncontexted baseline', () => {
  it('prefers a complete MECE partition when preferMECEWhenAvailable=true even if an explicit uncontexted slice exists', () => {
    // Make MECE detection deterministic in this unit test.
    vi.spyOn(contextRegistry, 'detectMECEPartitionSync').mockReturnValue({
      isMECE: true,
      isComplete: true,
      canAggregate: true,
      missingValues: [],
      policy: 'computed',
    });

    const candidateValues: any[] = [
      // Explicit uncontexted slice exists (dims === '')
      { sliceDSL: 'window(1-Dec-25:2-Dec-25)', n: 100, k: 50 },
      // MECE context slices for one key (channel)
      { sliceDSL: 'window(1-Dec-25:2-Dec-25).context(channel:paid-search)', n: 40, k: 20 },
      { sliceDSL: 'window(1-Dec-25:2-Dec-25).context(channel:influencer)', n: 60, k: 30 },
    ];

    const res = resolveMECEPartitionForImplicitUncontextedSync(candidateValues as any, {
      preferMECEWhenAvailable: true,
      requireComplete: true,
    });

    expect(res.kind).toBe('mece_partition');
    if (res.kind === 'mece_partition') {
      expect(res.key).toBe('channel');
      expect(res.isComplete).toBe(true);
      expect(res.canAggregate).toBe(true);
      expect(res.values).toHaveLength(2);
      expect(res.values.map((v: any) => v.sliceDSL)).toEqual([
        'window(1-Dec-25:2-Dec-25).context(channel:paid-search)',
        'window(1-Dec-25:2-Dec-25).context(channel:influencer)',
      ]);
    }
  });

  it('defaults to explicit uncontexted slice when preferMECEWhenAvailable=false', () => {
    vi.spyOn(contextRegistry, 'detectMECEPartitionSync').mockReturnValue({
      isMECE: true,
      isComplete: true,
      canAggregate: true,
      missingValues: [],
      policy: 'computed',
    });

    const candidateValues: any[] = [
      { sliceDSL: 'window(1-Dec-25:2-Dec-25)', n: 100, k: 50 },
      { sliceDSL: 'window(1-Dec-25:2-Dec-25).context(channel:paid-search)', n: 40, k: 20 },
      { sliceDSL: 'window(1-Dec-25:2-Dec-25).context(channel:influencer)', n: 60, k: 30 },
    ];

    const res = resolveMECEPartitionForImplicitUncontextedSync(candidateValues as any);
    expect(res.kind).toBe('explicit_uncontexted_present');
  });
});


