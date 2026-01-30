import { describe, it, expect } from 'vitest';
import type { ParameterValue } from '../../types/parameterData';
import { calculateIncrementalFetch } from '../windowAggregationService';
import { isSignatureCheckingEnabled } from '../signaturePolicyService';
import { serialiseSignature } from '../signatureMatchingService';

describe('calculateIncrementalFetch - query_signature gating', () => {
  // Use structured signatures for tests (the new format)
  const sigOld = serialiseSignature({ coreHash: 'old-core-hash', contextDefHashes: { channel: 'ch1' } });
  const sigNew = serialiseSignature({ coreHash: 'new-core-hash', contextDefHashes: { channel: 'ch1' } });  // Different core

  // Test for subset-aware matching with SAME sliceDSL
  // (uncontexted-query-over-contexted-cache is handled by meceSliceService, not here)
  const sigWithChannel = serialiseSignature({ coreHash: 'core-hash', contextDefHashes: { channel: 'ch-def-hash' } });
  const sigWithChannelAndDevice = serialiseSignature({ coreHash: 'core-hash', contextDefHashes: { channel: 'ch-def-hash', device: 'dv-def-hash' } });

  (isSignatureCheckingEnabled() ? it : it.skip)(
    'CRITICAL: single-dimension query matches multi-dimensional cache (subset-aware matching)',
    () => {
      // Cache has multi-dimensional data (channel + device)
      const values: ParameterValue[] = [
        {
          sliceDSL: 'context(channel:paid-search)',  // Same channel slice
          query_signature: sigWithChannelAndDevice,  // Has channel AND device
          dates: ['10-Dec-25', '11-Dec-25', '12-Dec-25'],
          n_daily: [100, 100, 100],
          k_daily: [50, 50, 50],
          mean: 0.5,
          n: 300,
          k: 150,
        },
      ];

      // Query asks for single-dimension (channel only, no device)
      const result = calculateIncrementalFetch(
        { values },
        { start: '10-Dec-25', end: '12-Dec-25' },
        sigWithChannel,  // Query has only channel - cache superset should match!
        false,
        'context(channel:paid-search).window(10-Dec-25:12-Dec-25)'  // Same channel slice
      );

      // BUG FIX: Cache with superset of context keys (channel+device) should satisfy
      // query that only needs channel
      expect(result.needsFetch).toBe(false);
      expect(result.daysAvailable).toBe(3);
      expect(result.daysToFetch).toBe(0);
    }
  );

  (isSignatureCheckingEnabled() ? it : it.skip)(
    'treats data as NOT cached when sliceDSL matches but query_signature differs',
    () => {
    const values: ParameterValue[] = [
      {
        sliceDSL: 'context(channel:paid-search)',
        query_signature: sigOld,
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
      sigNew,  // Different core hash - should NOT match
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
      sigNew,
      false,
      'context(channel:paid-search).window(10-Dec-25:12-Dec-25)'
    );

    expect(result.needsFetch).toBe(false);
    expect(result.daysAvailable).toBe(3);
    expect(result.daysToFetch).toBe(0);
    }
  );
});


